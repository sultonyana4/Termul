import { getAddress, isAddress, zeroAddress } from 'viem';

export const circleArcChainId = 5042;
const catalogTtl = 10 * 60_000;
const lookupTtl = 60_000;
const catalogUrl = 'https://li.quest/v1';

export function arcTokenAddress(value) {
  return typeof value === 'string' && isAddress(value) && value.toLowerCase() !== zeroAddress ? getAddress(value) : null;
}

export function tokenArtwork(value) {
  if (typeof value !== 'string' || value.length > 2048 || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
}

const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max
  && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);

export function normalizeArcToken(raw) {
  const address = arcTokenAddress(raw?.address);
  if (raw?.chainId !== circleArcChainId || !address || !text(raw.name, 160) || !text(raw.symbol, 40)
    || !Number.isInteger(raw.decimals) || raw.decimals < 0 || raw.decimals > 255) return null;
  return Object.freeze({ address, chainId: circleArcChainId, name: raw.name, symbol: raw.symbol,
    decimals: raw.decimals, logoURI: tokenArtwork(raw.logoURI) });
}

export function createArcTokenCatalog({ fetcher = fetch, now = Date.now } = {}) {
  let list, loading;
  const lookups = new Map();
  const inFlight = new Map();
  const request = path => fetcher(catalogUrl + path, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000) });

  async function load() {
    if (list?.expiresAt > now()) return list.tokens;
    if (!loading) loading = (async () => {
      const response = await request(`/tokens?chains=${circleArcChainId}`);
      if (!response.ok) throw new Error('The LI.FI Arc token catalog is unavailable.');
      const { tokens } = await response.json();
      if (!Array.isArray(tokens?.[circleArcChainId])) throw new Error('Invalid LI.FI Arc token catalog.');
      const byAddress = new Map();
      for (const row of tokens[circleArcChainId]) {
        const token = normalizeArcToken(row);
        if (token) byAddress.set(token.address, token);
      }
      list = { tokens: [...byAddress.values()], expiresAt: now() + catalogTtl };
      return list.tokens;
    })().finally(() => { loading = undefined; });
    return loading;
  }

  async function find(value) {
    const address = arcTokenAddress(value);
    if (!address) return null;
    if (list?.expiresAt > now()) {
      const match = list.tokens.find(token => token.address === address);
      if (match) return match;
    }
    const known = lookups.get(address);
    if (known?.expiresAt > now()) return known.token;
    if (!inFlight.has(address)) inFlight.set(address, (async () => {
      const response = await request(`/token?chain=${circleArcChainId}&token=${address}`);
      if (!response.ok && response.status !== 404) throw new Error('The LI.FI token lookup is unavailable.');
      const result = response.ok ? normalizeArcToken(await response.json()) : null;
      const token = result?.address === address ? result : null;
      if (lookups.size >= 128) lookups.delete(lookups.keys().next().value);
      lookups.set(address, { token, expiresAt: now() + (token ? catalogTtl : lookupTtl) });
      return token;
    })().finally(() => inFlight.delete(address)));
    return inFlight.get(address);
  }

  return { load, find };
}

export const arcTokenCatalog = createArcTokenCatalog();
