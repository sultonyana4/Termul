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

export function createWalletSession({ getWallet, getProvider, url, origin, fetchRequest = fetch, onChange = () => {}, circleSign, localOrigin }) {
  const storageKey = 'termul.siwe.v1.' + (circleSign ? 'circle' : 'external');
  const expectedOrigin = localOrigin ?? arcNetwork.origin;
  const expectedDomain = new URL(expectedOrigin).host;
  let current = null;
  let inFlight = null;
  let restoring = null;
  let generation = 0;
  let expiryTimer;
  const send = async (action, body, auth) => {
    if (arcNetwork.error || !url || origin() !== expectedOrigin || (localOrigin && url !== '/__termul_circle/web3')) {
      throw new Error('Secure wallet verification requires the configured Termul origin.');
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
  const saved = () => {
    try {
      const record = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) ?? 'null');
      if (record?.url === url && /^[a-f0-9]{64}$/.test(record.token) && /^0x[a-f0-9]{40}$/.test(record.address)
        && Number.isFinite(record.expires) && Number.isFinite(record.verifiedAt)
        && record.expires > Date.now() && record.verifiedAt <= Date.now() && record.verifiedAt >= Date.now() - 12 * 60_000) return record;
    } catch { /* Tab storage may be disabled. */ }
    return null;
  };
  const save = (session) => {
    try {
      if (session) globalThis.sessionStorage?.setItem(storageKey, JSON.stringify({ url, token: session.token,
        address: session.wallet.address.toLowerCase(), connector: session.wallet.connectorScope ?? session.wallet.connectorId,
        expires: session.expires, verifiedAt: session.verifiedAt }));
      else globalThis.sessionStorage?.removeItem(storageKey);
    } catch { /* The live session still works without tab storage. */ }
  };
  const invalidate = () => {
    generation++;
    const stored = saved();
    const previous = current;
    current = null;
    inFlight = null;
    restoring = null;
    clearTimeout(expiryTimer);
    save(null);
    if (!previous && stored) revoke({ token: stored.token, wallet: { address: stored.address } });
    if (previous) {
      revoke(previous);
      onChange();
    }
  };
  const snapshot = () => current && sameWallet(current.wallet, getWallet()) && current.expires > Date.now() ? current : null;
  const activate = (next) => {
    clearTimeout(expiryTimer);
    current = next;
    save(next);
    expiryTimer = setTimeout(invalidate, Math.min(12 * 60_000, next.expires - Date.now()));
    onChange();
  };
  const restore = async () => {
    if (snapshot() || inFlight) return;
    if (restoring) return restoring;
    const wallet = getWallet();
    if (!wallet || wallet.chainId !== arcNetwork.id) return;
    const stored = saved();
    if (!stored) return;
    if (stored.address !== wallet.address.toLowerCase() || stored.connector !== (wallet.connectorScope ?? wallet.connectorId)) {
      invalidate(); return;
    }
    const version = generation;
    const next = { ...stored, wallet };
    const pending = (async () => {
      try {
        const provider = circleSign ? null : await getProvider(wallet);
        if (provider) await assertWalletProvider(provider, wallet.address);
        await send('get_profile', { walletAddress: wallet.address }, next);
        if (provider) await assertWalletProvider(provider, wallet.address);
        if (version === generation && next.expires > Date.now() && sameWallet(wallet, getWallet())) activate(next);
      } catch (error) {
        if (version === generation && [401, 403].includes(error.status)) invalidate();
      }
    })();
    restoring = pending;
    try { await pending; } finally { if (restoring === pending) restoring = null; }
  };
  const authenticate = async ({ fresh = false } = {}) => {
    if (restoring) await restoring;
    const existing = snapshot();
    if (existing && (!fresh || Date.now() - existing.verifiedAt < 5 * 60_000)) return;
    if (inFlight) return inFlight;
    const wallet = getWallet();
    if (!wallet?.address || wallet.chainId !== arcNetwork.id) throw new Error('Connect a wallet on Arc Mainnet to verify ownership.');
    const version = generation;
    const stillSelected = () => version === generation && sameWallet(wallet, getWallet());
    const operation = async () => {
      const provider = circleSign ? null : await getProvider(wallet);
      if (!circleSign) await assertWalletProvider(provider, wallet.address);
      const { challengeToken, message } = await send('challenge', { walletAddress: wallet.address });
      if (typeof challengeToken !== 'string' || !/^[a-f0-9]{64}$/.test(challengeToken) || typeof message !== 'string') {
        throw new Error('Invalid wallet challenge.');
      }
      const parsed = parseSiweMessage(message);
      if (!stillSelected() || parsed.domain !== expectedDomain || parsed.uri !== expectedOrigin
        || parsed.version !== '1' || parsed.chainId !== arcNetwork.id
        || parsed.address?.toLowerCase() !== wallet.address.toLowerCase()
        || !parsed.nonce || !parsed.expirationTime || parsed.expirationTime.getTime() <= Date.now()) {
        throw new Error('The wallet or authentication challenge changed.');
      }
      if (!circleSign) await assertWalletProvider(provider, wallet.address);
      if (!stillSelected()) throw new Error('The connected wallet changed.');
      const signature = circleSign ? await circleSign({ wallet, message, challengeToken })
        : await provider.request({ method: 'personal_sign', params: [stringToHex(message), wallet.address] });
      if (!circleSign) await assertWalletProvider(provider, wallet.address);
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
      activate(next);
    };
    const pending = operation();
    inFlight = pending;
    try { return await pending; } finally { if (inFlight === pending) inFlight = null; }
  };

  return {
    authenticate, restore, invalidate, isAuthenticated: () => Boolean(snapshot()),
    ...(circleSign && {
      async requestManagedInvoice(action, body) {
        const auth = snapshot();
        if (!auth || origin() !== arcNetwork.origin) throw new Error('Verify ownership of the selected Circle wallet.');
        try {
          const result = await fetchRequest('/api/termul-circle-managed', {
            method: 'POST', cache: 'no-store', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(40_000),
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token },
            body: JSON.stringify({ ...body, action }),
          });
          const data = await result.json();
          if (!result.ok) throw Object.assign(new Error(data.error || 'Managed invoices are unavailable.'), { status: result.status, code: data.code });
          if (snapshot() !== auth) throw new Error('The wallet session changed.');
          return data;
        } catch (error) {
          if (error.status === 401 && snapshot() === auth) invalidate();
          throw error;
        }
      },
    }),
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
