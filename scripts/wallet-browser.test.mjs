import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, numberToHex, parseAbi } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { arcNetwork } from '../src/arc-network.js';

const { TERMUL_PLAYWRIGHT, TERMUL_CHROMIUM, TERMUL_FIXTURE_DIST } = process.env;
assert.ok(TERMUL_PLAYWRIGHT && TERMUL_FIXTURE_DIST, 'Set TERMUL_PLAYWRIGHT to the installed Playwright entry and TERMUL_FIXTURE_DIST to the browser fixture build.');
const { chromium } = await import(pathToFileURL(resolve(TERMUL_PLAYWRIGHT)));
const origin = arcNetwork.origin;
const api = 'https://fixture.supabase.co/functions/v1/termul-wallet-v1';
const contract = arcNetwork.contractAddress;
const block = numberToHex(arcNetwork.deploymentBlock);
const merchant = '0x' + '12'.repeat(20);
const secondary = '0x' + '34'.repeat(20);
const payer = '0x' + '56'.repeat(20);
const invoiceId = '0x' + '78'.repeat(32);
const creationHash = '0x' + '99'.repeat(32);
const paymentHash = '0x' + 'aa'.repeat(32);
const signature = '0x' + '11'.repeat(65);
const amount = 10n ** 16n;
const abi = parseAbi([
  'event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint64 expiresAt)',
  'event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount)',
  'function getInvoice(address merchant, bytes32 id) view returns ((address merchant, uint256 amount, uint64 expiresAt, uint8 status))',
  'function payInvoice(address merchant, bytes32 id) payable',
]);
const artifact = JSON.parse(await readFile(new URL('../contracts/out/TermulInvoices.sol/TermulInvoices.json', import.meta.url), 'utf8'));
const code = artifact.deployedBytecode.object;
assert.equal(keccak256(code), arcNetwork.runtimeHash);
const invoiceResult = encodeFunctionResult({ abi, functionName: 'getInvoice', result: { merchant, amount, expiresAt: 0n, status: 2 } });
const makeLog = (eventName, transactionHash, args, encoded) => ({
  address: contract, transactionHash, blockNumber: block, blockHash: '0x' + 'bb'.repeat(32),
  transactionIndex: '0x0', logIndex: '0x0', removed: false,
  topics: encodeEventTopics({ abi, eventName, args }),
  data: encodeAbiParameters(encoded.map(([type]) => ({ type })), encoded.map(([, value]) => value)),
});
const created = makeLog('InvoiceCreated', creationHash, { invoiceId, merchant }, [['uint256', amount], ['uint64', 0n]]);
const paid = makeLog('InvoicePaid', paymentHash, { invoiceId, merchant, payer }, [['uint256', amount]]);
const payment = {
  from: payer, to: contract, input: encodeFunctionData({ abi, functionName: 'payInvoice', args: [merchant, invoiceId] }),
  value: numberToHex(amount), chainId: '0x13b2', type: '0x2', hash: paymentHash, blockNumber: block,
};
const actions = [];
const browserErrors = [];
const unexpectedRequests = [];
const browser = await chromium.launch({ executablePath: TERMUL_CHROMIUM, headless: true, args: [
  '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND',
] });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS' };
    const reply = json => route.fulfill({ json, headers: cors });
    if (request.method() === 'OPTIONS' && (url.href === api || url.origin === arcNetwork.rpcUrl)) {
      return route.fulfill({ status: 204, headers: cors });
    }
    if (url.origin === arcNetwork.rpcUrl && request.method() === 'POST') {
      const body = request.postDataJSON();
      const methods = {
        eth_chainId: () => '0x13b2',
        eth_getCode: ([, at]) => at === numberToHex(arcNetwork.deploymentBlock - 1n) ? '0x' : code,
        eth_getBalance: () => numberToHex(5n * 10n ** 18n),
        eth_blockNumber: () => block,
        eth_getBlockByNumber: () => ({ number: block, timestamp: '0x69000000', transactions: [] }),
        eth_call: () => invoiceResult,
        eth_getLogs: ([{ topics }]) => [created, paid].filter(log => log.topics[0] === topics[0]
          && topics.slice(1).every((topic, index) => !topic || topic === log.topics[index + 1])),
        eth_getTransactionByHash: () => payment,
        eth_getTransactionReceipt: () => ({ status: '0x1', blockNumber: block, transactionHash: paymentHash, logs: [paid] }),
      };
      if (Object.hasOwn(methods, body.method)) {
        return reply({ jsonrpc: '2.0', id: body.id, result: methods[body.method](body.params || []) });
      }
      unexpectedRequests.push(body.method);
      return route.abort();
    }
    if (url.href === api && request.method() === 'POST') {
      const body = request.postDataJSON();
      const address = (body.walletAddress || parseSiweMessage(body.message).address).toLowerCase();
      actions.push({ action: body.action, address });
      if (body.action === 'challenge') return reply({
        challengeToken: 'ab'.repeat(32),
        message: createSiweMessage({ address: body.walletAddress, chainId: 5042, domain: 'termul.xyz', uri: origin,
          nonce: 'a'.repeat(32), version: '1', issuedAt: new Date(), expirationTime: new Date(Date.now() + 120_000) }),
      });
      if (body.action === 'verify') {
        assert.equal(body.signature, signature);
        return reply({ sessionToken: 'cd'.repeat(32), walletAddress: address, expiresAt: new Date(Date.now() + 120_000).toISOString() });
      }
      assert.equal(request.headers().authorization, 'Bearer ' + 'cd'.repeat(32));
      if (body.action === 'get_profile') return reply({ profile: { display_name: 'Fixture merchant' } });
      if (body.action === 'get_invoices') return reply({ invoices: [] });
      if (body.action === 'get_payment_attempt') return reply({ attempt: null });
      if (body.action === 'logout') return reply({ ok: true });
    }
    if (url.origin === 'https://fonts.googleapis.com') return route.fulfill({ body: '', contentType: 'text/css' });
    if (url.origin === origin && (url.pathname === '/' || /^\/(?:assets\/[a-zA-Z0-9._-]+|termul-logo\.gif)$/.test(url.pathname))) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.gif': 'image/gif' }[extname(name)];
      return route.fulfill({ body: await readFile(resolve(TERMUL_FIXTURE_DIST, name)), contentType });
    }
    if (url.origin === origin && url.pathname === '/favicon.ico') return route.fulfill({ status: 404 });
    unexpectedRequests.push(url.href);
    return route.abort();
  });
  await context.addInitScript(({ merchant, secondary, signature }) => {
    window.fixtureCalls = [];
    const makeProvider = (name, address, chain) => {
      let enabled = localStorage.getItem('fixture-permission-' + name) === 'yes';
      const listeners = new Map();
      const emit = (event, data) => listeners.get(event)?.forEach(listener => listener(data));
      return {
        on(event, listener) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(listener);
        },
        removeListener: (event, listener) => listeners.get(event)?.delete(listener),
        changeAccount(next) { address = next; emit('accountsChanged', [address]); },
        async request({ method, params }) {
          window.fixtureCalls.push({ name, method });
          if (method === 'eth_requestAccounts') {
            enabled = true;
            localStorage.setItem('fixture-permission-' + name, 'yes');
            return [address];
          }
          if (method === 'eth_accounts') return enabled ? [address] : [];
          if (method === 'eth_chainId') return chain;
          if (method === 'wallet_switchEthereumChain') {
            if (params[0].chainId !== '0x13b2') throw new Error('Unexpected chain');
            chain = params[0].chainId;
            emit('chainChanged', chain);
            return null;
          }
          if (method === 'personal_sign') {
            if (params[1].toLowerCase() !== address || chain !== '0x13b2') throw new Error('Wrong signer');
            if (window.fixtureRejectSignature) throw Object.assign(new Error('Declined'), { code: 4001 });
            return signature;
          }
          window.fixtureUnexpectedWalletMethod = method;
          throw new Error('Unexpected wallet method ' + method);
        },
      };
    };
    const rabby = makeProvider('Rabby', merchant, '0x1');
    const metamask = makeProvider('MetaMask', secondary, '0x13b2');
    window.fixtureRabby = rabby;
    window.ethereum = metamask;
    window.ethereum.providers = [metamask, rabby];
    window.addEventListener('eip6963:requestProvider', () => {
      for (const [provider, name, rdns, uuid] of [
        [rabby, 'Rabby', 'io.rabby', '350670db-19fa-4704-a166-e52e178b59d2'],
        [metamask, 'MetaMask', 'io.metamask', '9602783d-22e2-410a-a374-495866c3aa28'],
      ]) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { provider, info: { name, rdns, uuid } } }));
    });
  }, { merchant, secondary, signature });

  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => browserErrors.push(error.message));
  const connected = address => page.waitForFunction(address => window.termulWallet?.getSelection()?.address.toLowerCase() === address, address);
  const authenticated = expected => page.waitForFunction(expected => window.termulWallet?.session.isAuthenticated() === expected, expected);
  const verify = () => page.locator('#verify-wallet').click();
  const profile = () => page.locator('.side-nav [data-nav="profile"]').click();
  const switchNetwork = () => page.locator('#switch-wallet-network').click();

  await page.goto(origin);
  await page.locator('#connect-wallet').click();
  assert.equal(await page.locator('#wallet-dialog[open] .wallet-choice').count(), 2);
  await page.getByRole('button', { name: 'Rabby io.rabby' }).click();
  await connected(merchant);
  assert.equal(await page.evaluate(() => window.termulWallet.getSelection().chainId), 1);
  await switchNetwork();
  await page.waitForFunction(() => window.termulWallet.getSelection().chainId === 5042);
  await page.waitForFunction(() => window.arusPayApi.getInvoices()[0]?.status === 'paid');
  assert.equal(await page.locator('#wallet-balance').textContent(), '5.00');
  assert.equal(await page.evaluate(() => window.arusPayApi.getInvoices()[0].paymentTxHash), paymentHash);
  assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.name === 'MetaMask').length), 0);

  await profile();
  await page.getByText(merchant, { exact: true }).first().waitFor();
  await page.evaluate(() => { window.fixtureRejectSignature = true; });
  await verify();
  await page.getByText('Wallet signature declined. Verify ownership when you are ready.').waitFor();
  await page.evaluate(() => { window.fixtureRejectSignature = false; });
  await verify();
  await authenticated(true);
  await page.locator('#display-name-input').waitFor();
  await page.waitForFunction(() => document.querySelector('#display-name-input').value === 'Fixture merchant');
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('cd'.repeat(32)))), false);

  await page.reload();
  await connected(merchant);
  await authenticated(false);
  assert.equal(await page.evaluate(() => window.fixtureCalls.some(call => call.method === 'eth_requestAccounts')), false);
  await switchNetwork();
  await profile();
  await verify();
  await authenticated(true);
  await page.evaluate(address => window.fixtureRabby.changeAccount(address), secondary);
  await connected(secondary);
  await authenticated(false);
  assert.equal(actions.filter(row => row.action === 'logout' && row.address === merchant).length, 1);
  await verify();
  await authenticated(true);
  await page.locator('#sign-out').click();
  await page.waitForFunction(() => window.termulWallet.getSelection() === null);
  await authenticated(false);
  assert.ok(actions.some(row => row.action === 'logout' && row.address === secondary));

  const link = new URL(origin);
  link.search = new URLSearchParams({ chainId: '5042', contract, merchant, invoiceId }).toString();
  await page.goto(link.href);
  await page.getByRole('heading', { name: 'Paid', exact: true }).waitFor();
  assert.equal(await page.locator('#pay-onchain').count(), 0);
  assert.ok(await page.locator(`a[href="https://explorer.arc.io/tx/${paymentHash}"]`).count());
  assert.equal(await page.evaluate(() => window.fixtureUnexpectedWalletMethod), undefined);
  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(browserErrors, []);
  console.log('Chromium passed: multi-wallet selection, Arc switching, balance, indexed Paid invoice, SIWE, reconnect, account change, disconnect, and Paid link.');
} finally {
  await browser.close();
}
