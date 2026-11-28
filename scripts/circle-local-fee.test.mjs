import assert from 'node:assert/strict';
import { get } from 'node:http';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { exchangeChain } from '../src/any-token-networks.js';
import { FEE_POLICY_CHECK, FEE_POLICY_ORIGIN, LOCAL_FEE_POLICY_ORIGIN } from '../src/fee-policy.js';
import { feePolicyChallenge } from '../src/fee-policy-server.js';

process.env.TERMUL_LOCAL_CIRCLE = 'enabled';
process.env.TERMUL_RELEASE_FEE_BPS = '10';
process.env.TERMUL_RELEASE_FEE_VERSION = '1';
const origin = LOCAL_FEE_POLICY_ORIGIN;
const address = '0x' + '12'.repeat(20);
const vite = await createServer({ mode: 'circle-local', server: { port: 5186, strictPort: true, hmr: false } });
let browser;
try {
  await vite.listen();
  const upstream = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const readUpstream = (path, host) => new Promise((resolve, reject) => {
    const request = get(upstream + path, { headers: { host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject);
  });
  const challenge = FEE_POLICY_CHECK + '?check=' + crypto.randomUUID();
  const release = { bps: '10', version: '1', environment: 'production' };
  assert.equal(feePolicyChallenge(new Request(FEE_POLICY_ORIGIN + challenge), release).status, 200);
  assert.equal(feePolicyChallenge(new Request(origin + challenge), release).status, 403);
  assert.equal(feePolicyChallenge(new Request(origin + challenge), { ...release, environment: 'development' }).status, 403);
  assert.equal((await fetch(upstream + challenge)).status, 403);
  const response = await readUpstream(challenge, new URL(origin).host);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).policy.bps, 10);

  browser = await chromium.launch({ executablePath: process.env.TERMUL_CHROMIUM, headless: true, args: ['--disable-background-networking'] });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.addInitScript(address => {
    const detail = { info: { name: 'Fee policy browser wallet', rdns: 'test.termul.fee', uuid: '11111111-2222-4333-8333-444444444444' },
      provider: { on() {}, removeListener() {}, async request({ method }) {
        if (method === 'eth_chainId') return '0x13b2';
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
        throw new Error('Unexpected wallet request ' + method);
      } } };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
  }, address);
  const chains = [5042, 8453].map(id => {
    const chain = exchangeChain(id);
    return { id, key: id === 5042 ? 'arc' : 'bas', name: chain.name, mainnet: true, chainType: 'EVM', diamondAddress: address,
      nativeToken: { chainId: id, address: '0x' + '0'.repeat(40), ...chain.nativeCurrency },
      metamask: { chainId: '0x' + id.toString(16), chainName: chain.name, nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [chain.blockExplorers.default.url] } };
  });
  let staleChallenge = false;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      if (url.pathname === '/__termul_circle/session') return route.fulfill({ json: {} });
      const res = await readUpstream(url.pathname + url.search, url.host);
      const headers = { 'content-type': res.headers.get('content-type') ?? 'text/plain',
        'cache-control': res.headers.get('cache-control') ?? 'no-store' };
      if (staleChallenge && url.pathname === FEE_POLICY_CHECK) {
        const body = await res.json();
        return route.fulfill({ headers, json: { ...body, check: crypto.randomUUID() } });
      }
      return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    }
    if (url.origin === 'https://li.quest') {
      assert.equal(route.request().headers()['x-lifi-api-key'], undefined);
      const json = ({ '/v1/chains': { chains }, '/v1/tokens': { tokens: {} }, '/v1/tools': { bridges: [], exchanges: [] } })[url.pathname];
      if (json) return route.fulfill({ json, headers: { 'access-control-allow-origin': origin } });
    }
    return route.abort();
  });
  await page.goto(origin);
  await page.locator('#connect-wallet').click();
  await page.getByRole('button', { name: /Fee policy browser wallet/ }).click();
  await page.waitForFunction(() => window.termulWallet.getSelection()?.type === 'external');
  await page.locator('[data-nav="swap"]:visible').first().click();
  await page.getByRole('tab', { name: 'Any Token' }).click();
  await page.locator('#exchange-termul-fee').filter({ hasText: 'Termul fee (0.1%)' }).waitFor();
  await page.locator('#exchange-widget > *').first().waitFor();
  assert.match(await page.locator('[data-exchange-network="from"]').textContent(), /Arc/);
  assert.match(await page.locator('[data-exchange-network="to"]').textContent(), /Base/);

  const verify = alternate => page.evaluate(async alternate => {
    const { loadFeePolicy } = await import('/src/fee-policy.js');
    try { return (await loadFeePolicy(fetch, alternate ?? location.origin)).bps; }
    catch { return 'rejected'; }
  }, alternate);
  assert.equal(await verify(null), 10);
  assert.equal(await verify('http://127.0.0.1:5173'), 'rejected');
  staleChallenge = true;
  assert.equal(await verify(null), 'rejected');
  console.log('Local Arc/Base Web3 widget loads at 0.1%, and alternate origins and stale nonces are rejected.');
} finally {
  await browser?.close();
  await vite.close();
}
