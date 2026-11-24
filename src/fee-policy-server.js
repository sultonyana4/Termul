import { FEE_POLICY_ORIGIN, resolveReleaseFeePolicy, serializeFeePolicy } from './fee-policy.js';

const nonce = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const headers = {
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function feePolicyChallenge(request, { bps, version, environment } = {}) {
  const reply = (body, status) => Response.json(body, { headers, status });
  if (request.method !== 'GET') return reply({ error: 'Method not allowed.' }, 405);
  const url = new URL(request.url);
  const checks = url.searchParams.getAll('check');
  if (checks.length !== 1 || !nonce.test(checks[0])) return reply({ error: 'Invalid policy check.' }, 400);

  let policy;
  try {
    policy = resolveReleaseFeePolicy(bps, version);
  } catch {
    return reply({ error: 'Fee policy unavailable.' }, 503);
  }
  if (policy.bps && (environment !== 'production' || url.origin !== FEE_POLICY_ORIGIN)) {
    return reply({ error: 'Fee-enabled transactions require the Termul production origin.' }, 403);
  }
  return reply({ check: checks[0], policy: serializeFeePolicy(policy) }, 200);
}
