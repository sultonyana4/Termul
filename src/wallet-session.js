import { stringToHex } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { arcNetwork } from './arc-network.js';
import { assertWalletProvider, sameWallet } from './wallet-provider.js';

export const WALLET_API_PATH = '/functions/v1/termul-wallet-v1';

export function endpointFor(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.pathname === WALLET_API_PATH ? url.href : null;
  } catch {
    return null;
  }
}

export function createWalletSession({ getWallet, getProvider, url, origin, fetchRequest = fetch, onChange = () => {} }) {
  let current = null;
  let inFlight = null;
  let generation = 0;
  let expiryTimer;
  const send = async (action, body, auth) => {
    if (arcNetwork.error || !url || origin() !== arcNetwork.origin) {
      throw new Error('Secure wallet verification requires the configured Termul production origin.');
    }
    const result = await fetchRequest(url, {
      method: 'POST', credentials: 'omit', mode: 'cors', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth.token } : {}) },
      body: JSON.stringify({ ...body, action }),
    });
    const payload = await result.json();
    if (!result.ok) throw Object.assign(new Error(payload?.error || 'Wallet metadata service is unavailable.'), { status: result.status });
    return payload;
  };

  const revoke = (session) => void send('logout', { walletAddress: session.wallet.address }, session).catch(() => {});
  const invalidate = () => {
    generation++;
    const previous = current;
    current = null;
    inFlight = null;
    clearTimeout(expiryTimer);
    if (previous) {
      revoke(previous);
      onChange();
    }
  };
  const snapshot = () => current && sameWallet(current.wallet, getWallet()) && current.expires > Date.now() ? current : null;
  const authenticate = async ({ fresh = false } = {}) => {
    const existing = snapshot();
    if (existing && (!fresh || Date.now() - existing.verifiedAt < 5 * 60_000)) return;
    if (inFlight) return inFlight;
    const wallet = getWallet();
    if (!wallet?.address || wallet.chainId !== arcNetwork.id) throw new Error('Connect a wallet on Arc Mainnet to verify ownership.');
    const version = generation;
    const stillSelected = () => version === generation && sameWallet(wallet, getWallet());
    const operation = async () => {
      const provider = await getProvider(wallet);
      await assertWalletProvider(provider, wallet.address);
      const { challengeToken, message } = await send('challenge', { walletAddress: wallet.address });
      if (typeof challengeToken !== 'string' || !/^[a-f0-9]{64}$/.test(challengeToken) || typeof message !== 'string') {
        throw new Error('Invalid wallet challenge.');
      }
      const parsed = parseSiweMessage(message);
      if (!stillSelected() || parsed.domain !== arcNetwork.domain || parsed.uri !== arcNetwork.origin
        || parsed.version !== '1' || parsed.chainId !== arcNetwork.id
        || parsed.address?.toLowerCase() !== wallet.address.toLowerCase()
        || !parsed.nonce || !parsed.expirationTime || parsed.expirationTime.getTime() <= Date.now()) {
        throw new Error('The wallet or authentication challenge changed.');
      }
      await assertWalletProvider(provider, wallet.address);
      if (!stillSelected()) throw new Error('The connected wallet changed.');
      const signature = await provider.request({ method: 'personal_sign', params: [stringToHex(message), wallet.address] });
      await assertWalletProvider(provider, wallet.address);
      if (!stillSelected()) throw new Error('The connected wallet changed.');
      const result = await send('verify', { challengeToken, message, signature });
      if (typeof result.sessionToken !== 'string' || !/^[a-f0-9]{64}$/.test(result.sessionToken)
        || result.walletAddress !== wallet.address.toLowerCase() || !(Date.parse(result.expiresAt) > Date.now())) {
        throw new Error('The wallet session response is invalid.');
      }
      const next = { token: result.sessionToken, wallet, expires: Date.parse(result.expiresAt), verifiedAt: Date.now() };
      if (!stillSelected()) {
        revoke(next);
        throw new Error('The connected wallet changed.');
      }
      if (current) revoke(current);
      clearTimeout(expiryTimer);
      current = next;
      expiryTimer = setTimeout(invalidate, Math.min(12 * 60_000, next.expires - Date.now()));
      onChange();
    };
    const pending = operation();
    inFlight = pending;
    try { return await pending; } finally { if (inFlight === pending) inFlight = null; }
  };

  return {
    authenticate, invalidate, isAuthenticated: () => Boolean(snapshot()),
    async request(action, body, expectedAddress) {
      const auth = snapshot();
      if (!auth || (expectedAddress && auth.wallet.address.toLowerCase() !== expectedAddress.toLowerCase())) {
        throw new Error('Verify ownership of the selected wallet to access Termul metadata.');
      }
      try {
        const result = await send(action, { ...body, walletAddress: auth.wallet.address }, auth);
        if (snapshot() !== auth) throw new Error('The wallet session changed.');
        return result;
      } catch (error) {
        if (error.status === 401 && snapshot() === auth) invalidate();
        throw error;
      }
    },
  };
}
