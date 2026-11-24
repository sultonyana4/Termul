import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  assertCurrentFeePolicy, defaultFeePolicy, FEE_POLICY_CHECK, FEE_POLICY_FILE, FEE_POLICY_ORIGIN, loadFeePolicy, parseFeePolicy,
  serializeFeePolicy, TERMUL_FEE_RECIPIENT,
} from '../src/fee-policy.js';
import { feePolicyChallenge } from '../src/fee-policy-server.js';
import { FIXTURE_MARKER, releaseFeePolicy, verifyRelease } from './release-policy.mjs';

const on = releaseFeePolicy('10', '1');
const rollback = releaseFeePolicy('0', '2');
const asset = serializeFeePolicy(on);
assert.equal(releaseFeePolicy().bps, 0);
assert.equal(on.rate, 0.001);
assert.equal(on.recipient, TERMUL_FEE_RECIPIENT);
for (const inputs of [['10'], [undefined, '1'], ['5', '1'], ['0.001', '1'], ['10', '0'], ['0', 'x']]) {
  assert.throws(() => releaseFeePolicy(...inputs));
}
for (const changed of [{ bps: '10' }, { version: '0' }, { rate: 10 }, { recipient: '0x' + '99'.repeat(20) }]) {
  assert.throws(() => parseFeePolicy({ ...asset, ...changed }));
}

const checks = new Set();
const noStore = { 'Cache-Control': 'no-store' };
const preview = 'https://termul-preview.vercel.app';
const reply = (value, options = {}) => Response.json(value, { ...options, headers: { ...noStore, ...options.headers } });
function mock({ staticPolicy = on, livePolicy = staticPolicy, staleCheck, staticReply, liveReply, liveHeaders } = {}) {
  return async (path, options) => {
    const url = new URL(path, FEE_POLICY_ORIGIN);
    const check = url.searchParams.get('check');
    assert.ok(check);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (url.pathname === '/' + FEE_POLICY_FILE) {
      assert.equal(checks.has(check), false);
      checks.add(check);
      return staticReply ?? reply(serializeFeePolicy(staticPolicy));
    }
    assert.equal(url.pathname, FEE_POLICY_CHECK);
    assert.ok(checks.has(check));
    return liveReply ?? reply({ check: staleCheck ?? check, policy: serializeFeePolicy(livePolicy) }, { headers: liveHeaders });
  };
}
// Vercel can serve the static manifest with HIT/Age even when no-store is set.
// Only the matching nonce-bound dynamic API must be uncached.
await assertCurrentFeePolicy(on, () => loadFeePolicy(mock({ staticReply: reply(asset, {
  headers: { Age: '105', 'x-vercel-cache': 'HIT' },
}) }), FEE_POLICY_ORIGIN));
await assertCurrentFeePolicy(on, () => loadFeePolicy(mock(), FEE_POLICY_ORIGIN));
await assertCurrentFeePolicy(on, () => loadFeePolicy(mock(), FEE_POLICY_ORIGIN));
await assert.rejects(assertCurrentFeePolicy(on, () => loadFeePolicy(mock({ staticPolicy: rollback }), FEE_POLICY_ORIGIN)), /fee policy changed/);
await assert.rejects(assertCurrentFeePolicy(on, async () => ({ ...on, version: '2' })), /fee policy changed/);
await assert.rejects(assertCurrentFeePolicy(on, async () => ({ ...rollback, version: on.version })), /fee policy changed/);
await assert.rejects(loadFeePolicy(mock(), preview), /Could not verify/);
await assert.rejects(loadFeePolicy(mock(), 'http://localhost:5173'), /Could not verify/);
assert.equal((await loadFeePolicy(mock({ staticPolicy: rollback }), preview)).bps, 0);
for (const options of [
  { livePolicy: rollback }, { staticPolicy: rollback, livePolicy: on }, { staleCheck: [...checks][0] },
  { staticReply: Response.redirect(FEE_POLICY_ORIGIN + '/') }, { staticReply: new Response(null, { status: 404 }) }, { liveReply: new Response(null, { status: 503 }) },
  { staticReply: reply({ ...asset, bps: 25 }) }, { staticReply: new Response('<html>', { headers: noStore }) },
  { staticReply: Response.json(asset) }, { staticReply: reply(asset, { status: 206 }) },
  { liveHeaders: { Age: '105', 'x-vercel-cache': 'HIT' } },
  { liveReply: reply({ policy: asset }, { headers: { 'x-vercel-cache': 'STALE' } }) },
]) {
  await assert.rejects(loadFeePolicy(mock(options), FEE_POLICY_ORIGIN), /Could not verify/);
}
await assert.rejects(loadFeePolicy(async () => { throw new TypeError('Network unavailable'); }, FEE_POLICY_ORIGIN), /Could not verify/);

const withNonce = origin => new Request(origin + FEE_POLICY_CHECK + '?check=' + crypto.randomUUID());
const release = { bps: '10', version: '1', environment: 'production' };
for (const [request, settings, status] of [
  [withNonce(FEE_POLICY_ORIGIN), release, 200],
  [withNonce(preview), release, 403],
  [withNonce(FEE_POLICY_ORIGIN), { ...release, environment: 'preview' }, 403],
  [withNonce(preview), {}, 200],
  [withNonce(FEE_POLICY_ORIGIN), { bps: '10' }, 503],
  [new Request(FEE_POLICY_ORIGIN + FEE_POLICY_CHECK), release, 400],
  [new Request(withNonce(FEE_POLICY_ORIGIN), { method: 'POST' }), release, 405],
]) {
  const response = feePolicyChallenge(request, settings);
  assert.equal(response.status, status);
  for (const name of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control']) {
    assert.equal(response.headers.get(name), 'no-store');
  }
  if (status === 200) assert.equal((await response.json()).check, new URL(request.url).searchParams.get('check'));
}

const folder = await mkdtemp(join(tmpdir(), 'termul-policy-test-'));
const walletEndpoint = 'https://termul-check-public.supabase.co/functions/v1/termul-wallet-v1';
const artifact = { walletEndpoint };
const js = join(folder, 'index.js');
try {
  const manifest = join(folder, FEE_POLICY_FILE);
  const save = policy => writeFile(manifest, JSON.stringify(serializeFeePolicy(policy)));
  await save(defaultFeePolicy);
  await assert.rejects(verifyRelease(folder), /approved public Termul wallet API/);
  for (const url of ['https://fixture.supabase.co/functions/v1/termul-wallet-v1', walletEndpoint + '?q=unexpected', 'http://example.com']) {
    await assert.rejects(verifyRelease(folder, defaultFeePolicy, { walletEndpoint: url }), /approved public Termul wallet API/);
  }
  await assert.rejects(verifyRelease(folder, defaultFeePolicy, artifact), /missing from release JavaScript/);
  await writeFile(js, walletEndpoint);
  await verifyRelease(folder, defaultFeePolicy, artifact);
  await save(on);
  await verifyRelease(folder, on, artifact);
  await assert.rejects(verifyRelease(folder, defaultFeePolicy, artifact), /expected release settings/);
  await writeFile(manifest, '{');
  await assert.rejects(verifyRelease(folder, on, artifact), SyntaxError);
  await save(on);
  for (const content of ['0x' + '99'.repeat(20), 'VITE_TERMUL_SWAP_FEE_RECIPIENT', 'https://fixture.supabase.co',
    'https://other.supabase.co/functions/v1/termul-wallet-v1']) {
    await writeFile(js, walletEndpoint + '\n' + content);
    await assert.rejects(verifyRelease(folder, on, artifact), /Forbidden|Unexpected public wallet/);
  }
  await writeFile(js, walletEndpoint);
  await writeFile(join(folder, FIXTURE_MARKER), '');
  await assert.rejects(verifyRelease(folder, on, artifact), /Offline browser artifacts/);
  await verifyRelease(folder, on, { ...artifact, browserFixture: true });

  // Simulate the checked-in Vercel route order over real HTTP. The actual
  // Vercel edge and alias behavior still require a protected staging deploy.
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const [policyHeaders] = config.headers;
  const fallback = new RegExp('^/' + config.rewrites[0].source.slice('/:path('.length, -1) + '$');
  assert.equal(policyHeaders.source, '/' + FEE_POLICY_FILE);
  assert.equal(config.rewrites[0].destination, '/index.html');
  assert.equal(fallback.test('/' + FEE_POLICY_FILE), false);
  assert.equal(fallback.test(FEE_POLICY_CHECK), false);
  assert.equal(fallback.test('/assets/missing.js'), false);
  assert.equal(fallback.test('/deep/link'), true);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, FEE_POLICY_ORIGIN);
    if (url.pathname === policyHeaders.source) {
      const body = await readFile(manifest).catch(() => null);
      res.writeHead(body ? 200 : 404, Object.fromEntries(policyHeaders.headers.map(({ key, value }) => [key, value])));
      return res.end(body);
    }
    if (url.pathname === FEE_POLICY_CHECK) {
      const response = feePolicyChallenge(new Request(url), release);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(await response.text());
    }
    res.writeHead(fallback.test(url.pathname) ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end('<html>Termul shell</html>');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const host = 'http://127.0.0.1:' + server.address().port;
    const fetchStatic = (path, options) => fetch(host + path, options);
    assert.equal((await loadFeePolicy(fetchStatic, FEE_POLICY_ORIGIN)).bps, 10);
    assert.equal(await (await fetchStatic('/deep/link')).text(), '<html>Termul shell</html>');
    await save(rollback);
    await assert.rejects(loadFeePolicy(fetchStatic, FEE_POLICY_ORIGIN), /Could not verify/);
    await rm(manifest);
    assert.equal((await fetchStatic('/' + FEE_POLICY_FILE)).status, 404);
    await assert.rejects(loadFeePolicy(fetchStatic, FEE_POLICY_ORIGIN), /Could not verify/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
} finally {
  await rm(folder, { recursive: true, force: true });
}
console.log('Static routing, policy freshness, preview isolation, rollback, and release artifact checks passed.');
