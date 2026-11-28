import { resolveReleaseFeePolicy } from '../src/fee-policy.js';
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets';
import { createCircleStore } from '../server/circle/postgrest.js';
import { createManagedCircleApi } from '../server/circle/managed-api.js';
import { baseRpc } from '../server/circle/cctp.js';
import { arcRpc } from '../experiments/circle-wallet-poc/arc.js';
import { createCircleAnyTokenQuoteFetcher } from '../experiments/circle-wallet-poc/circle-any-token-quotes.js';

const anyTokenFetcher = createCircleAnyTokenQuoteFetcher({ apiKey: process.env.TERMUL_CIRCLE_LIFI_API_KEY });

export default {
  async fetch(request) {
    if (process.env.TERMUL_CIRCLE_MANAGED_API !== 'enabled') {
      return createManagedCircleApi({})(request);
    }
    const { TERMUL_CIRCLE_API_KEY: apiKey, TERMUL_CIRCLE_SUPABASE_URL: url,
      TERMUL_CIRCLE_SUPABASE_SERVICE_ROLE_KEY: serviceKey } = process.env;
    if (!apiKey || !url || !serviceKey) {
      return Response.json({ error: 'Circle managed invoices are unavailable.' }, {
        status: 503, headers: { 'Cache-Control': 'no-store' },
      });
    }
    try {
      return await createManagedCircleApi({
        enabled: true,
        allowExecution: process.env.TERMUL_CIRCLE_MANAGED_EXECUTION === 'enabled',
        base: baseRpc,
        allowArcSwap: process.env.TERMUL_CIRCLE_ARC_SWAP === 'enabled',
        allowArcAnyToken: process.env.TERMUL_CIRCLE_ARC_ANY_TOKEN === 'enabled',
        anyTokenFetcher,
        maxArcSwapNetworkFeeUsdc: process.env.TERMUL_CIRCLE_ARC_SWAP_MAX_NETWORK_FEE_USDC,
        loadPolicy: () => resolveReleaseFeePolicy(process.env.TERMUL_RELEASE_FEE_BPS, process.env.TERMUL_RELEASE_FEE_VERSION),
        circle: initiateUserControlledWalletsClient({ apiKey }),
        arc: arcRpc,
        store: createCircleStore({ url, serviceKey }),
      })(request);
    } catch {
      return Response.json({ error: 'Circle managed invoices are unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
