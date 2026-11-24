import { feePolicyChallenge } from '../src/fee-policy-server.js';

export default {
  fetch(request) {
    return feePolicyChallenge(request, {
      bps: process.env.TERMUL_RELEASE_FEE_BPS,
      version: process.env.TERMUL_RELEASE_FEE_VERSION,
      environment: process.env.VERCEL_ENV,
    });
  },
};
