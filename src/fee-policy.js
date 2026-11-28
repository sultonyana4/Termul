import { TERMUL_MAINNET } from '../supabase/functions/_shared/termul-mainnet.js';

export const TERMUL_FEE_RECIPIENT = '0xeE640148243089B7C0674ABF4DFA116aAF919BF9';
export const FEE_POLICY_FILE = 'termul-fee-policy.json';
export const FEE_POLICY_CHECK = '/api/termul-fee-policy';
export const FEE_POLICY_ORIGIN = TERMUL_MAINNET.origin;
export const LOCAL_FEE_POLICY_ORIGIN = 'http://localhost:5173';

export function parseFeePolicy(value) {
  if (!value || Object.keys(value).length !== 3 || !['version', 'bps', 'recipient'].every(key => Object.hasOwn(value, key))
    || typeof value.version !== 'string' || !/^(?:0|[1-9][0-9]{0,11})$/.test(value.version)
    || (value.bps !== 0 && value.bps !== 10) || (value.version === '0' && value.bps !== 0)
    || value.recipient !== TERMUL_FEE_RECIPIENT) {
    throw new Error('Invalid Termul fee policy.');
  }
  return Object.freeze({ version: value.version, bps: value.bps, recipient: value.recipient, rate: value.bps / 10_000 });
}

export const defaultFeePolicy = parseFeePolicy({ version: '0', bps: 0, recipient: TERMUL_FEE_RECIPIENT });
export const sameFeePolicy = (left, right) => left?.version === right?.version && left?.bps === right?.bps;
export const feePolicyChanged = 'Termul’s fee policy changed. Review a fresh quote before signing.';
const policyUnavailable = 'Could not verify the Termul fee policy. Try again before starting a swap.';

export function resolveReleaseFeePolicy(bps, version) {
  if (bps === undefined && version === undefined) return defaultFeePolicy;
  if ((bps !== '0' && bps !== '10') || !/^[1-9][0-9]{0,11}$/.test(version ?? '')) {
    throw new Error('Set TERMUL_RELEASE_FEE_BPS to 0 or 10 and TERMUL_RELEASE_FEE_VERSION to a new positive integer.');
  }
  return parseFeePolicy({ version, bps: Number(bps), recipient: TERMUL_FEE_RECIPIENT });
}

export function serializeFeePolicy({ version, bps, recipient }) {
  return { version, bps, recipient };
}

export async function loadFeePolicy(fetcher = fetch, origin = globalThis.location?.origin) {
  try {
    const check = globalThis.crypto.randomUUID();
    const options = {
      cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000),
    };
    async function read(path, requireFresh = true) {
      const response = await fetcher(path + '?check=' + check, options);
      const cache = response.headers.get('x-vercel-cache')?.trim();
      const age = response.headers.get('age')?.trim();
      if (response.status !== 200 || response.redirected
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
        || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')
        || (requireFresh && ((age && age !== '0') || (cache && !/^(?:MISS|BYPASS|REVALIDATED)$/i.test(cache))))) {
        throw new Error('Unexpected fee policy response.');
      }
      return response.json();
    }
    const [manifest, live] = await Promise.all([read('/' + FEE_POLICY_FILE, false), read(FEE_POLICY_CHECK)]);
    const policy = parseFeePolicy(manifest);
    if (live?.check !== check || Object.keys(live).length !== 2 || !sameFeePolicy(policy, parseFeePolicy(live.policy))) throw new Error('Stale fee policy.');
    const local = import.meta.env && import.meta.env.TERMUL_LOCAL_CIRCLE === true && origin === LOCAL_FEE_POLICY_ORIGIN;
    if (policy.bps && origin !== FEE_POLICY_ORIGIN && !local) throw new Error('Invalid fee origin.');
    return policy;
  } catch {
    throw new Error(policyUnavailable);
  }
}

export async function assertCurrentFeePolicy(expected, load = loadFeePolicy) {
  if (!sameFeePolicy(expected, await load())) throw new Error(feePolicyChanged);
}
