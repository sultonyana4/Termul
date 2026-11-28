import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets';
import { createCircleLoginApi } from '../server/circle/login-api.js';
import { createCircleStore } from '../server/circle/postgrest.js';

export default {
  async fetch(request) {
    const { TERMUL_CIRCLE_LOGIN_API: enabled, TERMUL_CIRCLE_APP_ID: appId,
      TERMUL_CIRCLE_API_KEY: apiKey, TERMUL_CIRCLE_SUPABASE_URL: url, TERMUL_CIRCLE_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      TERMUL_CIRCLE_LOGIN_EMAIL_ALLOWLIST: allowlist } = process.env;
    if (enabled !== 'enabled' || !appId || !apiKey || !url || !serviceKey) {
      return createCircleLoginApi({})(request);
    }
    try {
      return await createCircleLoginApi({ appId, enabled: true, allowedEmails: allowlist?.trim() ? allowlist.split(',') : [],
        allowInitialization: process.env.TERMUL_CIRCLE_INITIALIZATION === 'enabled',
        allowTransferRecovery: process.env.TERMUL_CIRCLE_MANAGED_API === 'enabled',
        allowArcSwap: process.env.TERMUL_CIRCLE_ARC_SWAP === 'enabled',
        allowArcAnyToken: process.env.TERMUL_CIRCLE_ARC_ANY_TOKEN === 'enabled',
        sessionKey: process.env.TERMUL_CIRCLE_SESSION_KEY,
        allowManaged: process.env.TERMUL_CIRCLE_MANAGED_API === 'enabled' && process.env.TERMUL_CIRCLE_MANAGED_EXECUTION === 'enabled',
        circle: initiateUserControlledWalletsClient({ apiKey }), store: createCircleStore({ url, serviceKey }),
      })(request);
    } catch {
      return Response.json({ error: 'Circle email access is unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
