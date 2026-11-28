import { randomUUID } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { TERMUL_MAINNET as network } from '../../supabase/functions/_shared/termul-mainnet.js';
import { createOperations, LocalError } from '../../experiments/circle-wallet-poc/operations.js';
import { PilotError } from '../../experiments/circle-wallet-poc/invoice-pilot.js';
import { isUuid } from '../../experiments/circle-wallet-poc/pilot-reconciliation.js';
import { deny, json, readJson, requireTermulOrigin } from './http.js';
import { createHostedSessionVault } from './session-vault.js';
import { hash } from './postgrest.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const actions = {
  otp: ['email', 'deviceId'], wallet: ['userToken'], sign: ['userToken', 'challengeToken', 'message'],
  'initialization-status': ['userToken'], initialize: ['userToken'],
  remember: ['userToken', 'encryptionKey'], restore: [], forget: [],
};

function signRequestKey(token) {
  const value = hash('termul-circle-siwe-v1:' + token);
  // A deterministic UUIDv4-shaped idempotency key, derived from the opaque nonce.
  return value.slice(0, 8) + '-' + value.slice(8, 12) + '-4' + value.slice(13, 16) + '-8' +
    value.slice(17, 20) + '-' + value.slice(20, 32);
}

export function createCircleLoginApi({ circle, store, appId, enabled = false, allowedEmails = [], allowInitialization = false, allowManaged = false, allowArcSwap = false, allowArcAnyToken = false, allowTransferRecovery = false, sessionKey, now = Date.now }) {
  const restricted = allowedEmails.length > 0;
  const approved = new Set(allowedEmails.map(email => email.trim().toLowerCase()).filter(email => email && emailPattern.test(email)));
  const initialization = allowInitialization && store?.initialization ? createOperations({
    circle, origin: network.origin, initialization: store.initialization, allowInitialization: true,
  }) : null;
  const vault = sessionKey && store?.sessions ? createHostedSessionVault({ key: sessionKey, store: store.sessions, now }) : undefined;

  async function findWallet(userToken) {
    const { data } = await circle.listWallets({ userToken, blockchain: 'ARC', pageSize: 50 });
    const wallets = data?.wallets;
    const candidates = Array.isArray(wallets) && wallets.length < 50 ? wallets.filter(w => w?.blockchain === 'ARC' && w.accountType === 'EOA') : [];
    const current = candidates[0];
    if (candidates.length !== 1 || current.state !== 'LIVE' || !isUuid(current.id) || !isAddress(current.address, { strict: false })) return null;
    return { id: current.id, address: getAddress(current.address), blockchain: 'ARC', accountType: 'EOA' };
  }
  return async request => {
    if (!enabled || !isUuid(appId) || (restricted && !approved.size)) return json({ error: 'Circle email access is disabled.' }, 404);
    if (request.method === 'GET' && request.headers.get('sec-fetch-site') !== 'cross-site') return json({ appId, managed: allowManaged === true,
      arcSwap: allowManaged && allowArcSwap, ...(allowManaged && allowArcSwap && allowArcAnyToken && { arcAnyToken: true }),
      transferRecovery: allowTransferRecovery === true, initialization: Boolean(initialization) });
    try {
      requireTermulOrigin(request);
      const input = await readJson(request);
      if (!input || !Object.hasOwn(actions, input.action) ||
        Object.keys(input).some(key => key !== 'action' && !actions[input.action].includes(key))) deny(400, 'Invalid Circle request.');
      if (['remember', 'restore', 'forget'].includes(input.action)) {
        if (!vault) return json({});
        const result = await vault(input, request.headers.get('cookie'), async userToken => {
          if (!await store.rate('circle-session:global', 120)) deny(429, 'Try signing in again shortly.');
          return findWallet(userToken);
        });
        return json(result.body, result.status, result.cookie && { 'Set-Cookie': result.cookie });
      }
      if (input.action === 'otp') {
        if (typeof input.email !== 'string' || input.email.length > 254 || !isUuid(input.deviceId)) deny(400, 'Provide a valid email and device ID.');
        const email = input.email.trim().toLowerCase();
        if (!emailPattern.test(email)) deny(400, 'Provide a valid email and device ID.');
        if (restricted && !approved.has(email)) deny(403, 'Circle email access is unavailable.');
        if (!await store.rate('circle-otp:global', 40) || !await store.rate('circle-otp:' + hash(email), 2)) {
          deny(429, 'OTP request limit reached. Try again later.');
        }
        const { data } = await circle.createDeviceTokenForEmailLogin({ email, deviceId: input.deviceId, idempotencyKey: randomUUID() });
        if (!['otpToken', 'deviceToken', 'deviceEncryptionKey'].every(field => typeof data?.[field] === 'string' && data[field])) {
          throw new Error('Incomplete Circle OTP handoff.');
        }
        return json({ otpToken: data.otpToken, deviceToken: data.deviceToken, deviceEncryptionKey: data.deviceEncryptionKey });
      }

      if (typeof input.userToken !== 'string' || !input.userToken || input.userToken.length > 4096) deny(401, 'Circle sign-in is required.');
      if (!await store.rate('circle-login:global', 120)) deny(429, 'Circle is busy. Try again shortly.');
      if (input.action === 'initialize' || input.action === 'initialization-status') {
        if (initialization) {
          if (!await store.rate('circle-initialize:' + hash(input.userToken), 10)) deny(429, 'Try again shortly.');
          return json(await initialization(input));
        }
        if (input.action === 'initialize') deny(403, 'New Circle wallet initialization is disabled.');
      }
      const wallet = await findWallet(input.userToken);
      if (!wallet && input.action === 'initialization-status') return json({ wallet: null, state: 'disabled' });
      if (!wallet) deny(409, 'An existing Arc wallet is required for this release gate.');
      if (input.action === 'wallet' || input.action === 'initialization-status') return json({ wallet });
      if (!/^[a-f0-9]{64}$/.test(input.challengeToken ?? '') || typeof input.message !== 'string' || input.message.length > 1400) {
        deny(400, 'Provide a signed-in Termul wallet challenge.');
      }
      const candidate = await store.siweChallenge(input.challengeToken);
      if (!candidate || candidate.wallet_address !== wallet.address.toLowerCase() || candidate.message_hash !== hash(input.message)) {
        deny(401, 'The challenge does not match this Circle wallet.');
      }
      const siwe = parseSiweMessage(input.message);
      if (siwe.domain !== network.domain || siwe.uri !== network.origin || siwe.chainId !== network.id || siwe.version !== '1' ||
        !siwe.nonce || siwe.address?.toLowerCase() !== candidate.wallet_address || !(siwe.expirationTime?.getTime() > now())) {
        deny(401, 'The Termul wallet challenge is invalid or expired.');
      }
      if (!await store.rate('circle-sign:' + wallet.address.toLowerCase(), 6)) deny(429, 'Too many wallet verifications.');
      const result = await circle.signMessage({ userToken: input.userToken, walletId: wallet.id, message: input.message,
        encodedByHex: false, idempotencyKey: signRequestKey(input.challengeToken) });
      if (!isUuid(result.data?.challengeId)) throw new Error('Unexpected Circle signing response.');
      return json({ challengeId: result.data.challengeId });
    } catch (error) {
      if (error instanceof PilotError || error instanceof LocalError) return json({ error: error.message }, error.status);
      if ([155103, 155104, 155105, 155718].includes(error?.code)) return json({ error: 'Circle session is invalid or expired.' }, 401);
      return json({ error: 'Circle email access is temporarily unavailable.' }, 502);
    }
  };
}
