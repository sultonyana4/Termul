import { createHash, randomUUID } from 'node:crypto';

export function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export function createCircleStore({ url, serviceKey, fetcher = fetch, now = Date.now }) {
  const base = new URL('/rest/v1/', url);
  if (base.protocol !== 'https:') throw new Error('Supabase HTTPS is required.');

  async function request(path, { query, method = 'GET', body, returning = false } = {}) {
    const target = new URL(path, base);
    target.search = new URLSearchParams(query);
    const response = await fetcher(target, {
      method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', ...(returning && { Prefer: 'return=representation' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw Object.assign(new Error('Circle persistence is unavailable.'), { httpStatus: response.status });
    const raw = await response.text();
    return raw ? JSON.parse(raw) : null;
  }

  const rpc = (name, body) => request('rpc/' + name, { method: 'POST', body });
  function routeStore(workflow) {
    return {
      async latest(wallet) {
        const scope = { workflow: 'eq.' + workflow, wallet: 'eq.' + wallet.toLowerCase(), order: 'updated_at.desc,id.desc', limit: 1 };
        const [active] = await request('termul_circle_bridges', { query: {
          ...scope, state: 'in.(ready,submitting,source-pending,destination-pending)',
        } });
        if (active) return active;
        const [last] = await request('termul_circle_bridges', { query: scope });
        return last;
      },
      history(wallet) {
        return request('termul_circle_bridges', { query: {
          workflow: 'eq.' + workflow, wallet: 'eq.' + wallet.toLowerCase(), order: 'updated_at.desc,id.desc', limit: 25,
        } });
      },
      due() {
        return request('termul_circle_bridges', { query: {
          workflow: 'eq.' + workflow, state: 'in.(submitting,source-pending,destination-pending)',
          updated_at: 'lt.' + new Date(now() - 30_000).toISOString(), order: 'updated_at.asc,id.asc', limit: 3,
        } });
      },
      async insert(details) {
        try {
          const [row] = await request('termul_circle_bridges', { method: 'POST', returning: true, body: {
            workflow, id: randomUUID(), wallet: details.walletAddress.toLowerCase(), state: details.status, details,
          } });
          return row;
        } catch (error) {
          if (error.httpStatus === 409) return null;
          throw error;
        }
      },
      update(row, details, session) {
        return rpc('termul_circle_bridge_update_v1', {
          p_id: row.id, p_wallet: row.wallet, p_revision: row.revision, p_details: details, p_session: session ?? null,
        });
      },
    };
  }

  return {
    async session(token) {
      const [session] = await request('termul_wallet_sessions', { query: {
        token_hash: 'eq.' + hash(token), expires_at: 'gt.' + new Date(now()).toISOString(),
        revoked_at: 'is.null', select: 'wallet_address,verified_at', limit: 1,
      } });
      return session;
    },
    async siweChallenge(token) {
      const [record] = await request('termul_wallet_challenges', { query: {
        token_hash: 'eq.' + hash(token), expires_at: 'gt.' + new Date(now()).toISOString(),
        consumed_at: 'is.null', select: 'wallet_address,message_hash', limit: 1,
      } });
      return record;
    },
    rate(bucket, maximum) {
      return rpc('termul_wallet_rate_v1', { p_bucket: bucket, p_limit: maximum });
    },
    sessions: {
      async get(id) {
        const [row] = await request('termul_circle_browser_sessions', { query: {
          handle_hash: 'eq.' + id, expires_at: 'gt.' + new Date(now()).toISOString(), select: 'sealed,expires_at', limit: 1,
        } });
        return row;
      },
      replace(previous, handle, sealed, expires) {
        return rpc('termul_circle_browser_session_v1', { p_previous: previous ?? null, p_handle: handle, p_sealed: sealed, p_expiry: expires });
      },
      remove(id) {
        return request('termul_circle_browser_sessions', { method: 'DELETE', query: { handle_hash: 'eq.' + id } });
      },
    },
    initialization: {
      async get(identity) {
        const [row] = await request('termul_circle_initialization', { query: {
          owner_hash: 'eq.' + hash(identity), select: 'details', limit: 1,
        } });
        return row?.details;
      },
      async claim(identity, previous, next) {
        return rpc('termul_circle_initialization_v1', { p_owner: hash(identity), p_before: previous ?? null, p_after: next });
      },
      async save(identity, previous, next) {
        const result = await rpc('termul_circle_initialization_v1', { p_owner: hash(identity), p_before: previous, p_after: next });
        return result?.idempotencyKey === next.idempotencyKey && result?.challengeId === next.challengeId && result?.confirmed === next.confirmed;
      },
    },
    reviews: {
      set(owner_hash, review) {
        return request('termul_circle_reviews', { method: 'POST', body: {
          review_id: review.reviewId, owner_hash, expires_at: new Date(review.reviewExpiresAt).toISOString(), review,
        } });
      },
      async get(owner, id, { includeExpired = false } = {}) {
        const [row] = await request('termul_circle_reviews', { query: { review_id: 'eq.' + id,
          owner_hash: 'eq.' + owner, consumed_at: 'is.null', ...(!includeExpired && { expires_at: 'gt.' + new Date(now()).toISOString() }),
          select: 'review', limit: 1,
        } });
        return row?.review;
      },
      forget(owner, reviewId) {
        return request('termul_circle_reviews', { method: 'DELETE', query: { owner_hash: 'eq.' + owner,
          consumed_at: 'is.null', ...(reviewId && { review_id: 'eq.' + reviewId }) } });
      },
    },
    bridges: routeStore('cctp'),
    lifi: routeStore('lifi'),
    journal: {
      async due() {
        const rows = await request('termul_circle_attempts', { query: {
          resolved: 'eq.false', updated_at: 'lt.' + new Date(now() - 30_000).toISOString(),
          order: 'updated_at.asc,attempt_id.asc', select: 'details', limit: 4,
        } });
        return rows.map(row => row.details);
      },
      purgeExpired() {
        return Promise.all([
          request('termul_circle_reviews', {
            method: 'DELETE', query: { expires_at: 'lt.' + new Date(now() - 60 * 60_000).toISOString() },
          }),
          request('termul_circle_browser_sessions', {
            method: 'DELETE', query: { expires_at: 'lt.' + new Date(now()).toISOString() },
          }),
        ]);
      },
      async latest(wallet, scope) {
        const [row] = await request('termul_circle_attempts', { query: {
          wallet: 'eq.' + wallet.toLowerCase(), order: 'resolved.asc,created_at.desc', select: 'details', limit: 1,
          ...(scope ? { 'details->>kind': scope === 'swap' ? 'eq.arc-swap' : 'neq.arc-swap' } : {}),
        } });
        return row?.details ?? null;
      },
      async history(wallet) {
        const rows = await request('termul_circle_attempts', { query: {
          wallet: 'eq.' + wallet.toLowerCase(), order: 'created_at.desc,attempt_id.desc', select: 'details', limit: 30,
        } });
        return rows.map(row => row.details);
      },
      reserve(record, { owner, reviewId, sessionHash }) {
        return rpc('termul_circle_reserve_v1', { p_owner: owner, p_review: reviewId, p_attempt: record, p_session: sessionHash });
      },
      update(record, fields) {
        return rpc('termul_circle_update_v1', { p_before: record, p_after: { ...record, ...fields } });
      },
    },
  };
}
