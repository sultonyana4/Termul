import { releaseFeePolicy, verifyRelease } from './release-policy.mjs';

try {
  const expected = releaseFeePolicy(process.env.TERMUL_RELEASE_FEE_BPS, process.env.TERMUL_RELEASE_FEE_VERSION);
  const actual = await verifyRelease(process.argv[2] ?? 'dist', expected, { walletEndpoint: process.env.VITE_TERMUL_WALLET_API_URL });
  console.log(`Verified Termul release artifact · policy ${actual.version} · ${actual.bps} BPS`);
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid fee policy JSON in the release artifact.' : error.message);
  process.exitCode = 1;
}
