import { createHash, randomUUID } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { readArcBalance } from './arc.js';
import { createInvoicePilot } from './invoice-pilot.js';
import { createCircleSwap, swapDisplayAssets } from './circle-swap.js';
import { readManagedPreflight } from './managed-preflight.js';
import { makeLocalChallenge, verifyLocalChallenge } from './siwe.js';

const blockchain = 'ARC';
const completed = 'COMPLETE';
const retryableStatuses = new Set(['FAILED', 'EXPIRED']);
const otpCooldown = 30_000;
export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class LocalError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function challengeIdFrom(result) {
  const id = result.data?.challengeId;
  if (typeof id !== 'string' || !uuidPattern.test(id)) throw new Error('Invalid Circle challenge shape.');
  return id;
}

function memoryInitializationStore() {
  const entries = new Map();
  return {
    get: identity => entries.get(identity),
    claim(identity, previous, next) {
      if (entries.get(identity) === previous) entries.set(identity, next);
      return entries.get(identity);
    },
    save(identity, previous, next) {
      if (entries.get(identity) !== previous) return false;
      entries.set(identity, next);
      return true;
    },
  };
}

export function createOperations({ circle, arc, origin, testEmail, now = Date.now, pilotOptions, swapOptions, metadata, allowInitialization = false, initialization = memoryInitializationStore(), otpState = { next: 0, requests: [], pending: false } }) {
  const inFlight = new Set();
  let localSign;
  const verifiedUntil = (owner, wallet) => wallet && localSign?.owner === owner && localSign.used
    && localSign.walletId === wallet.id && localSign.challenge.address === wallet.address
    && localSign.verifiedAt + 5 * 60_000 > now() ? localSign.verifiedAt + 5 * 60_000 : null;
  const pilot = createInvoicePilot({ circle, arc, now, ...pilotOptions });

  const swap = createCircleSwap({ circle, arc, now, journal: pilotOptions?.journal, ...swapOptions });

  async function exclusive(key, work) {
    if (inFlight.has(key)) throw new LocalError(409, 'This request is already in progress.');
    inFlight.add(key);
    try { return await work(); } finally { inFlight.delete(key); }
  }

  async function requestOtp(input) {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (email !== testEmail) throw new LocalError(403, 'Use the operator-approved test email.');
    if (typeof input.deviceId !== 'string' || !uuidPattern.test(input.deviceId)) {
      throw new LocalError(400, 'Circle did not provide a valid device ID.');
    }
    if (otpState.pending) throw new LocalError(409, 'This request is already in progress.');
    const timestamp = now();
    if (timestamp < otpState.next) throw new LocalError(429, 'Wait 30 seconds between OTP emails.');
    otpState.requests = otpState.requests.filter(time => timestamp - time < 15 * 60_000);
    if (otpState.requests.length >= 5) throw new LocalError(429, 'OTP request limit reached. Try again later.');
    otpState.pending = true;
    otpState.next = timestamp + otpCooldown;
    otpState.requests.push(timestamp);
    try {
      const { data } = await circle.createDeviceTokenForEmailLogin({
        email, deviceId: input.deviceId, idempotencyKey: randomUUID(),
      });
      if (!data?.otpToken || !data?.deviceToken || !data?.deviceEncryptionKey) throw new Error('Incomplete Circle OTP handoff.');
      return { otpToken: data.otpToken, deviceToken: data.deviceToken, deviceEncryptionKey: data.deviceEncryptionKey };
    } finally { otpState.pending = false; }
  }

  async function findWallet(userToken) {
    // Limit and filter by the chain. A full page is ambiguous for this single-wallet experiment.
    const response = await circle.listWallets({ userToken, blockchain, pageSize: 50 });
    const wallets = response.data?.wallets;
    if (!Array.isArray(wallets)) throw new Error('Invalid Circle wallet response.');
    const candidates = wallets.filter(wallet => wallet?.blockchain === blockchain && wallet.accountType === 'EOA');
    if (wallets.length >= 50 || candidates.length > 1) throw new LocalError(409, 'The account has an ambiguous set of Arc wallets.');
    const wallet = candidates[0];
    if (!wallet) return null;
    if (wallet.state !== 'LIVE' || !uuidPattern.test(wallet.id) || !isAddress(wallet.address, { strict: false })) {
      throw new LocalError(409, 'The Arc EOA is currently unavailable.');
    }
    return { id: wallet.id, address: getAddress(wallet.address), blockchain: wallet.blockchain, accountType: wallet.accountType };
  }

  async function inspectInitialization(userToken) {
    const wallet = await findWallet(userToken);
    if (wallet) return { wallet, state: 'ready' };
    if (!allowInitialization) return { state: 'disabled' };
    const identity = (await circle.getUserStatus({ userToken })).data?.id;
    if (typeof identity !== 'string' || !identity || identity.length > 128) throw new Error('Circle did not identify the user.');
    const request = await initialization.get(identity);
    if (request?.confirmed) return { state: 'complete' };

    const { data } = await circle.listUserChallenges({ userToken });
    const challenges = data?.challenges ?? [];
    if (!data || !Array.isArray(challenges)) throw new Error('Invalid Circle challenges response.');
    const previous = challenges.filter(challenge => challenge.type === 'INITIALIZE');
    if (request?.challengeId && !previous.some(challenge => challenge.id === request.challengeId)) {
      const { data: detail } = await circle.getUserChallenge({ userToken, challengeId: request.challengeId });
      if (detail?.challenge?.id !== request.challengeId || detail.challenge.type !== 'INITIALIZE') {
        return { state: 'pending' };
      }
      previous.push(detail.challenge);
    }
    if (previous.some(challenge => challenge.status === completed)) {
      await initialization.claim(identity, request, { confirmed: true });
      return { state: 'complete' };
    }
    const active = previous.find(challenge => !retryableStatuses.has(challenge.status));
    if (active) {
      // Only resume locally issued challenges that Circle explicitly reports as pending.
      const challengeId = active.status === 'PENDING' && request?.challengeId === active.id ? active.id : undefined;
      return { state: 'pending', challengeId };
    }
    return {
      state: 'retry', identity, request,
      priorAttempt: Boolean(previous.length || request),
      retrySameRequest: Boolean(request && !request.challengeId),
    };
  }

  async function initialize(userToken) {
    return exclusive('initialize', async () => {
      const current = await inspectInitialization(userToken);
      if (current.wallet) return { wallet: current.wallet };
      if (current.state === 'complete') return { alreadyInitialized: true };
      if (current.state === 'pending') {
        return current.challengeId ? { challengeId: current.challengeId } : { pendingInitialization: true };
      }
      const candidate = current.retrySameRequest
        ? current.request
        : { idempotencyKey: randomUUID() };
      const request = await initialization.claim(current.identity, current.request, candidate);
      if (!request || request.idempotencyKey !== candidate.idempotencyKey || request.challengeId) {
        return { pendingInitialization: true };
      }
      try {
        const challengeId = challengeIdFrom(await circle.createUserPinWithWallets({
          userToken, blockchains: [blockchain], accountType: 'EOA', idempotencyKey: request.idempotencyKey,
        }));
        if (!await initialization.save(current.identity, request, { ...request, challengeId })) return { pendingInitialization: true };
        return { challengeId };
      } catch (error) {
        if (error.code !== 155106) throw error;
        await initialization.save(current.identity, request, { ...request, confirmed: true });
        return { wallet: await findWallet(userToken), alreadyInitialized: true };
      }
    });
  }

  async function makeSignatureRequest(userToken, owner) {
    return exclusive('sign', async () => {
      const wallet = await findWallet(userToken);
      if (!wallet) throw new LocalError(409, 'An Arc EOA is required.');
      if (localSign?.challenge.expiresAt > now() && !localSign.used) {
        const entry = localSign;
        if (entry.owner !== owner || entry.walletId !== wallet.id || entry.challenge.address !== wallet.address) {
          throw new LocalError(409, 'A SIWE challenge is already active. Try again after it expires.');
        }
        if (entry.challengeId) {
          const status = (await circle.getUserChallenge({ userToken, challengeId: entry.challengeId })).data?.challenge?.status;
          if (localSign !== entry) throw new LocalError(401, 'The wallet session changed.');
          if (!['COMPLETE', 'EXPIRED', 'FAILED'].includes(status)) {
            return { message: entry.challenge.message, challengeId: entry.challengeId };
          }
          localSign = null;
        }
      } else {
        localSign = null;
      }
      localSign ??= {
        owner, walletId: wallet.id, challenge: makeLocalChallenge(origin, wallet.address, now()), idempotencyKey: randomUUID(), used: false,
      };
      const entry = localSign;
      const { challenge, idempotencyKey } = entry;
      const challengeId = challengeIdFrom(await circle.signMessage({
        userToken, walletId: wallet.id, message: challenge.message, encodedByHex: false, idempotencyKey,
      }));
      if (localSign !== entry) throw new LocalError(401, 'The wallet session changed.');
      entry.challengeId = challengeId;
      return { message: challenge.message, challengeId };
    });
  }

  async function verifySignature(input, owner) {
    return exclusive('sign', async () => {
      const entry = localSign;
      if (!entry || entry.owner !== owner || entry.used || entry.challengeId !== input.challengeId
        || !await verifyLocalChallenge({
          client: arc, origin, challenge: entry.challenge, message: input.message, signature: input.signature, now: now(),
        }) || localSign !== entry || entry.challenge.expiresAt <= now()) {
        throw new LocalError(401, 'Local SIWE verification failed or the challenge expired.');
      }
      entry.used = true;
      entry.verifiedAt = now();
      return { verified: true, verifiedUntil: entry.verifiedAt + 5 * 60_000 };
    });
  }

  return async input => {
    if (input.action === 'local-public-invoice' && metadata) return metadata.publicInvoice(input);
    if (input.action === 'otp') return requestOtp(input);
    const { userToken } = input;
    if (typeof userToken !== 'string' || !userToken || userToken.length > 4096) {
      throw new LocalError(401, 'Verify your email in Circle first.');
    }
    const owner = createHash('sha256').update(userToken).digest('hex');
    switch (input.action) {
      case 'local-metadata': {
        if (!metadata) throw new LocalError(404, 'Local metadata is unavailable.');
        const wallet = await findWallet(userToken);
        if (!verifiedUntil(owner, wallet)) throw new LocalError(401, 'Verify the selected wallet again.');
        return metadata.request(wallet, input);
      }
      case 'wallet':
        {
          const wallet = await findWallet(userToken);
          const until = verifiedUntil(owner, wallet);
          return { wallet, ...(until && { verifiedUntil: until }) };
        }
      case 'initialization-status': {
        const { wallet, state, priorAttempt, retrySameRequest, challengeId } = await inspectInitialization(userToken);
        return { wallet: wallet ?? null, state, priorAttempt, retrySameRequest, ...(challengeId && { resumable: true }) };
      }
      case 'initialize':
        if (!allowInitialization) throw new LocalError(403, 'New Circle wallet initialization is disabled.');
        return initialize(userToken);
      case 'balance':
        return exclusive('balance', async () => {
          const wallet = await findWallet(userToken);
          if (!wallet) throw new LocalError(409, 'An Arc EOA is required.');
          return readArcBalance(arc, wallet.address);
        });
      case 'attempt-history':
      case 'swap-review':
      case 'swap-execute':
      case 'swap-status':
      case 'pilot-review':
      case 'pilot-execute':
      case 'pilot-status':
      case 'pilot-provider-status':
      case 'pilot-recover': {
        const allowed = ['action', 'userToken', 'walletId', 'walletAddress'];
        if (input.action === 'swap-review') allowed.push('from', 'to', 'amount', 'anyToken');
        if (input.action === 'swap-execute') allowed.push('reviewId', 'confirmed');
        if (input.action === 'pilot-review') allowed.push('kind', 'invoiceId', 'merchant', 'amountBase', 'expiresAt');
        if (input.action === 'pilot-recover') allowed.push('hash');
        if (input.action === 'pilot-execute') allowed.push('reviewId', 'confirmed');
        if (Object.keys(input).some(key => !allowed.includes(key))
          || typeof input.walletId !== 'string' || !uuidPattern.test(input.walletId)
          || typeof input.walletAddress !== 'string' || !isAddress(input.walletAddress, { strict: false })) {
          throw new LocalError(400, 'Invalid wallet selection or unexpected pilot parameters.');
        }
        if (input.action === 'pilot-execute' && ![pilotOptions?.enabled, pilotOptions?.paymentEnabled, pilotOptions?.appEnabled].includes(true)) {
          throw new LocalError(403, 'Managed invoice execution is disabled.');
        }
        return exclusive('invoice-pilot', async () => {
          const readSelectedWallet = async () => {
            const wallet = await findWallet(userToken);
            if (!wallet || wallet.id !== input.walletId || wallet.address !== getAddress(input.walletAddress)) {
              throw new LocalError(409, 'The selected Circle wallet changed.');
            }
            return wallet;
          };
          const wallet = await readSelectedWallet();
          const authorize = () => {
            if (!verifiedUntil(owner, wallet)) {
              throw new LocalError(401, 'Verify a fresh local SIWE message with the selected Circle wallet.');
            }
          };
          const options = { wallet, userToken, owner, authorize, revalidate: readSelectedWallet };
          if (input.action === 'attempt-history') {
            const records = await pilotOptions?.journal?.history(wallet.address) ?? [];
            return { attempts: records.filter(record => record.walletId === wallet.id).map(({ kind, phase, status, createdAt, transactionHash, allowanceValue, anyToken, assets, from, to }) =>
              ({ kind, phase, status, createdAt, transactionHash, allowanceValue, anyToken, from, to, assets: swapDisplayAssets(assets) })) };
          }
          if (input.action === 'swap-review') return swap.prepare({ ...options, from: input.from, to: input.to, amount: input.amount, anyToken: input.anyToken });
          if (input.action === 'swap-execute') return swap.execute({ ...options, reviewId: input.reviewId, confirmed: input.confirmed });
          if (input.action === 'swap-status') return swap.status(options);
          if (input.action === 'pilot-recover') return pilot.recover({ ...options, hash: input.hash });
          if (input.action === 'pilot-provider-status') return pilot.providerStatus(options);
          if (input.action === 'pilot-status') return pilot.status(options);
          if (input.action === 'pilot-review') return pilot.prepare({ ...options, kind: input.kind, invoiceId: input.invoiceId, merchant: input.merchant, amountBase: input.amountBase, expiresAt: input.expiresAt });
          return pilot.execute({ ...options, reviewId: input.reviewId, confirmed: input.confirmed });
        });
      }
      case 'managed-preflight':
        if (Object.keys(input).some(key => !['action', 'userToken', 'walletId', 'walletAddress'].includes(key))
          || typeof input.walletId !== 'string' || !uuidPattern.test(input.walletId)
          || typeof input.walletAddress !== 'string' || !isAddress(input.walletAddress, { strict: false })) {
          throw new LocalError(400, 'Select the current Circle wallet. Transaction fields are fixed.');
        }
        return exclusive('managed-preflight', async () => {
          const wallet = await findWallet(userToken);
          if (!wallet || wallet.id !== input.walletId || wallet.address !== getAddress(input.walletAddress)) {
            throw new LocalError(409, 'The selected Circle wallet changed. Refresh and try again.');
          }
          const report = await readManagedPreflight({
            arc, wallet, estimate: request => circle.estimateContractExecutionFee({ ...request, userToken }),
          });
          const current = await findWallet(userToken);
          if (!current || current.id !== wallet.id || current.address !== wallet.address) {
            throw new LocalError(409, 'The selected Circle wallet changed during preflight.');
          }
          return report;
        });
      case 'sign':
        return makeSignatureRequest(userToken, owner);
      case 'verify-signature':
        return verifySignature(input, owner);
      case 'logout':
        if (localSign?.owner === owner) localSign = null;
        await pilot.forget(owner);
        swap.forget(owner);
        return {};
      default:
        throw new LocalError(404, 'Unknown PoC action.');
    }
  };
}
