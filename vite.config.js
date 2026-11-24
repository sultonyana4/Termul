import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { FEE_POLICY_CHECK, FEE_POLICY_FILE, parseFeePolicy, serializeFeePolicy } from './src/fee-policy.js';
import { resolveArcNetwork } from './src/arc-network.js';
import { feePolicyChallenge } from './src/fee-policy-server.js';
import { FIXTURE_MARKER, releaseFeePolicy, requireWalletEndpoint, verifyRelease } from './scripts/release-policy.mjs';

const publicNames = [
  'VITE_TERMUL_WALLET_API_URL',
  'VITE_TERMUL_NETWORK',
  'VITE_TERMUL_MAINNET_CONTRACT_ADDRESS',
  'VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK',
  'VITE_TERMUL_MAINNET_RUNTIME_HASH',
  'VITE_TERMUL_MAINNET_RPC_URL',
];

function addLocalPolicyRoutes(server, readPolicy) {
  server.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/' + FEE_POLICY_FILE && url.pathname !== FEE_POLICY_CHECK) return next();
    const headers = { 'Cache-Control': 'no-store' };
    let response;
    try {
      const policy = await readPolicy();
      response = url.pathname === FEE_POLICY_CHECK
        ? feePolicyChallenge(new Request(url, { method: req.method }), policy.version === '0' ? {} : {
          bps: String(policy.bps), version: policy.version, environment: 'development',
        })
        : Response.json(serializeFeePolicy(policy), { headers });
    } catch {
      response = Response.json({ error: 'Fee policy unavailable.' }, { headers, status: 503 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
}

export default defineConfig(({ mode, command }) => {
  const previewHost = process.env.ARUSPAY_PREVIEW_HOST;
  const allowedHosts = previewHost ? [previewHost] : [];
  const policy = releaseFeePolicy(process.env.TERMUL_RELEASE_FEE_BPS, process.env.TERMUL_RELEASE_FEE_VERSION);
  const body = JSON.stringify(serializeFeePolicy(policy)) + '\n';
  const browserFixture = mode === 'browser-fixture';
  if (command === 'build' && !['production', 'browser-fixture'].includes(mode)) {
    throw new Error('Use production mode for releases or browser-fixture mode for offline Chromium.');
  }
  if (command === 'build' && process.env.NODE_ENV !== 'production') {
    throw new Error('Termul artifacts require NODE_ENV=production.');
  }
  const publicEnv = loadEnv(mode, process.cwd(), publicNames);
  const endpoint = command === 'build'
    ? requireWalletEndpoint(publicEnv.VITE_TERMUL_WALLET_API_URL, browserFixture) : publicEnv.VITE_TERMUL_WALLET_API_URL;
  if (command === 'build' && !browserFixture && policy.bps && process.env.VERCEL_ENV
    && process.env.VERCEL_ENV !== 'production') throw new Error('Fee-enabled artifacts require a production-target build.');
  if (endpoint !== undefined) publicEnv.VITE_TERMUL_WALLET_API_URL = endpoint;
  const { error } = resolveArcNetwork(publicEnv);
  if (error) throw new Error(error);

  return {
    envPrefix: [],
    define: Object.fromEntries(publicNames.map(name => ['import.meta.env.' + name, JSON.stringify(publicEnv[name]) ?? 'undefined'])),
    server: { allowedHosts },
    preview: { allowedHosts },
    plugins: [{
      name: 'termul-release-policy',
      configureServer(server) { addLocalPolicyRoutes(server, () => policy); },
      configurePreviewServer(server) {
        const manifest = resolve(server.config.root, server.config.build.outDir, FEE_POLICY_FILE);
        addLocalPolicyRoutes(server, async () => parseFeePolicy(JSON.parse(await readFile(manifest, 'utf8'))));
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: FEE_POLICY_FILE, source: body });
        if (browserFixture) this.emitFile({ type: 'asset', fileName: FIXTURE_MARKER, source: 'Offline browser fixture only.\n' });
      },
      async writeBundle(output) {
        await verifyRelease(resolve(output.dir), policy, { browserFixture, walletEndpoint: endpoint });
      },
    }],
  };
});
