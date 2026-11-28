import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { FEE_POLICY_CHECK, FEE_POLICY_FILE, LOCAL_FEE_POLICY_ORIGIN, parseFeePolicy, serializeFeePolicy } from './src/fee-policy.js';
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

function addLocalPolicyRoutes(server, readPolicy, circleLocal = false) {
  server.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url, circleLocal ? LOCAL_FEE_POLICY_ORIGIN : 'http://localhost');
    if (url.pathname !== '/' + FEE_POLICY_FILE && url.pathname !== FEE_POLICY_CHECK) return next();
    const headers = { 'Cache-Control': 'no-store' };
    if (circleLocal && (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)
      || req.headers.host !== 'localhost:5173' || url.origin !== LOCAL_FEE_POLICY_ORIGIN)) {
      res.writeHead(403, headers);
      return res.end();
    }
    let response;
    try {
      const policy = await readPolicy();
      response = url.pathname === FEE_POLICY_CHECK
        ? feePolicyChallenge(new Request(url, { method: req.method }), policy.version === '0' ? {} : {
          bps: String(policy.bps), version: policy.version, environment: 'development',
        }, { local: circleLocal })
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
  const circleReleaseUi = command === 'build' && mode === 'production' && process.env.TERMUL_CIRCLE_RELEASE_UI === 'enabled';
  const circleLocal = command === 'serve' && mode === 'circle-local' && process.env.TERMUL_LOCAL_CIRCLE === 'enabled';
  const circleRoutes = { '/__termul_circle/api': '/termul-api', '/__termul_circle/config': '/termul-config',
    '/__termul_circle/session': '/termul-session', '/__termul_circle/sdk.js': '/circle-sdk.js',
    '/__termul_circle/web3': '/termul-web3', '/__termul_circle/history': '/termul-history' };
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
    define: { ...Object.fromEntries(publicNames.map(name => ['import.meta.env.' + name, JSON.stringify(publicEnv[name]) ?? 'undefined'])),
      'import.meta.env.TERMUL_LOCAL_CIRCLE': JSON.stringify(circleLocal),
      'import.meta.env.TERMUL_LOCAL_ORIGIN': JSON.stringify(circleLocal ? 'http://localhost:5173' : null),
      'import.meta.env.TERMUL_CIRCLE_RELEASE_UI': JSON.stringify(circleReleaseUi) },
    server: { allowedHosts, ...(circleLocal ? {
      host: '127.0.0.1', port: 5173, strictPort: true,
      proxy: Object.fromEntries(Object.entries(circleRoutes).map(([path, route]) => [path, {
        target: 'http://127.0.0.1:4173', headers: { host: 'localhost:4173' }, rewrite: () => route,
      }])),
    } : {}) },
    preview: { allowedHosts },
    plugins: [{
      name: 'termul-release-policy',
      configureServer(server) {
        if (circleLocal) server.middlewares.use((req, res, next) => {
          if (!req.url.startsWith('/__termul_circle/')) return next();
          if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)
            || req.headers.host !== 'localhost:5173'
            || (req.method === 'POST' && req.headers.origin !== 'http://localhost:5173')) {
            res.writeHead(403, { 'Cache-Control': 'no-store' });
            return res.end();
          }
          next();
        });
        addLocalPolicyRoutes(server, () => policy, circleLocal);
      },
      configurePreviewServer(server) {
        const manifest = resolve(server.config.root, server.config.build.outDir, FEE_POLICY_FILE);
        addLocalPolicyRoutes(server, async () => parseFeePolicy(JSON.parse(await readFile(manifest, 'utf8'))));
      },
      async generateBundle() {
        if (circleReleaseUi) {
          const { bundleCircleSdk } = await import('./scripts/build-circle-sdk.mjs');
          this.emitFile({ type: 'asset', fileName: 'assets/termul-circle-sdk.js', source: await bundleCircleSdk() });
        }
        this.emitFile({ type: 'asset', fileName: FEE_POLICY_FILE, source: body });
        if (browserFixture) this.emitFile({ type: 'asset', fileName: FIXTURE_MARKER, source: 'Offline browser fixture only.\n' });
      },
      async writeBundle(output) {
        await verifyRelease(resolve(output.dir), policy, { browserFixture, walletEndpoint: endpoint });
      },
    }],
  };
});
