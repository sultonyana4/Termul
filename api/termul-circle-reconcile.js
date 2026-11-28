import { timingSafeEqual } from 'node:crypto';
import { createCircleLifi } from '../server/circle/lifi.js';
import { createCircleBridge } from '../server/circle/bridge.js';
import { baseRpc } from '../server/circle/cctp.js';
import { arcRpc } from '../experiments/circle-wallet-poc/arc.js';
import { createCircleStore } from '../server/circle/postgrest.js';
import { reconcilePendingCircleAttempts } from '../server/circle/reconcile.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request) {
    const { TERMUL_CIRCLE_RECONCILE_SECRET: secret, TERMUL_CIRCLE_SUPABASE_URL: url,
      TERMUL_CIRCLE_SUPABASE_SERVICE_ROLE_KEY: serviceKey } = process.env;
    if (process.env.TERMUL_CIRCLE_MANAGED_API !== 'enabled' || !url || !serviceKey || !secret || secret.length < 32) {
      return json({ error: 'Unavailable.' }, 404);
    }
    const actual = Buffer.from(request.headers.get('authorization') ?? '');
    const expected = Buffer.from('Bearer ' + secret);
    if (request.method !== 'POST' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return json({ error: 'Unavailable.' }, 404);
    }
    try {
      const store = createCircleStore({ url, serviceKey });
      const attempts = await reconcilePendingCircleAttempts({ arc: arcRpc, journal: store.journal });
      if (process.env.TERMUL_CIRCLE_LIFI_RECONCILE === 'enabled') {
        const results = await createCircleLifi({ store: store.lifi }).run();
        attempts.lifiChecked = results.length;
        attempts.lifiErrors = results.filter(r => r.status === 'rejected').length;
      }
      if (process.env.TERMUL_CIRCLE_BRIDGE_RECONCILE === 'enabled') {
        const results = await createCircleBridge({ arc: arcRpc, base: baseRpc, store: store.bridges }).run();
        return json({ ...attempts, bridgeChecked: results.length, bridgeErrors: results.filter(r => r.status === 'rejected').length });
      }
      return json(attempts);
    } catch {
      return json({ error: 'Reconciliation is temporarily unavailable.' }, 502);
    }
  },
};
