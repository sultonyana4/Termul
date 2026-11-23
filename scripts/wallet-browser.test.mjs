import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, numberToHex, parseAbi } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { arcNetwork } from '../src/arc-network.js';
import { exchangeChain } from '../src/any-token-networks.js';
import { SWAP_ROUTER, SWAP_TOKENS } from '../src/swap-quote.js';
import { quoteFixture, quotedInput, recordFixture, settlementFixture, swapHash } from './swap-fixtures.mjs';

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
let invoiceState = 2;
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
const widths = [320, 375, 400, 768, 1024, 1440];
let nativeBalance = 5n * 10n ** 18n;
const swapContext = { from: SWAP_TOKENS.USDC, to: SWAP_TOKENS.EURC, amount: quotedInput, account: merchant };
const swapQuote = quoteFixture(swapContext);
const swapInput = swapQuote.transactionRequest.data;
const swapLog = settlementFixture(swapContext).map((log, index) => ({ ...log,
  blockNumber: block, blockHash: paid.blockHash, transactionIndex: '0x0', logIndex: numberToHex(index), removed: false,
}));
const exchangeHash = '0x' + '71'.repeat(32);
const exchangeDestinationHash = '0x' + '72'.repeat(32);
const exchangeRouter = '0xA4072583658Fae592A3506A42431cb6316a8d40b';
const baseRouter = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const baseUSDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const exchangeInput = '0xdeadbeef';
const fixtureToken = (address, chainId, symbol, decimals) => ({
  address, chainId, symbol, decimals, name: symbol, coinKey: symbol,
  logoURI: origin + '/brand/usdc.svg', priceUSD: '1',
});
const fromCoin = fixtureToken(SWAP_TOKENS.USDC.address, 5042, 'USDC', 6);
const toCoin = fixtureToken(baseUSDC, 8453, 'USDC', 6);
const arcEURC = { ...fixtureToken(SWAP_TOKENS.EURC.address, 5042, 'EURC', 6), logoURI: origin + '/brand/eurc.svg' };
const fixtureChains = [[5042, 'arc', 'Arc', exchangeRouter, fromCoin], [8453, 'bas', 'Base', baseRouter,
  fixtureToken('0x' + '0'.repeat(40), 8453, 'ETH', 18)]].map(([id, key, name, diamondAddress, nativeToken]) => {
  const config = exchangeChain(id);
  return { id, key, name, diamondAddress, nativeToken, coin: nativeToken.symbol, chainType: 'EVM', mainnet: true,
    logoURI: origin + '/brand/usdc.svg', metamask: {
      chainId: numberToHex(id), chainName: name, nativeCurrency: config.nativeCurrency,
      rpcUrls: config.rpcUrls.default.http, blockExplorerUrls: [config.blockExplorers.default.url],
    },
  };
});
const exchangeFixture = {
  account: merchant, fromChain: 5042, toChain: 8453, router: exchangeRouter, target: exchangeRouter,
  routeId: 'browser-bridge', fromToken: fromCoin, toToken: toCoin, dataHash: keccak256(exchangeInput), value: '0',
  kind: 'source', hash: exchangeHash, tool: 'across', amount: '1000000', minimum: '900000', stage: 'submitted',
};
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
    if (url.origin === 'https://li.quest' && url.pathname === '/v1/chains') return reply({ chains: fixtureChains });
    if (url.origin === 'https://li.quest' && url.pathname === '/v1/tokens') return reply({ tokens: { 5042: [fromCoin, arcEURC], 8453: [toCoin] } });
    if (url.origin === 'https://li.quest' && url.pathname === '/v1/token') return reply(
      [fromCoin, toCoin, arcEURC].find(token => token.address.toLowerCase() === url.searchParams.get('token')?.toLowerCase()) ?? fromCoin);
    if (url.origin === 'https://li.quest' && url.pathname === '/v1/tools') return reply({ bridges: [], exchanges: [] });
    if (url.origin === 'https://li.quest' && url.pathname === '/v1/connections') return reply({ connections: [] });
    if (url.origin === 'https://li.quest' && /^\/v1\/gas\/suggestion\/(5042|8453)$/.test(url.pathname)) return reply({ suggestions: [] });
    if (url.origin === 'https://li.quest' && url.pathname === '/v1/advanced/routes') return reply({ routes: [] });
    if (url.origin === 'https://li.quest' && url.pathname === '/v1/status') {
      assert.equal(url.searchParams.get('txHash'), exchangeHash);
      return reply({ status: 'DONE', substatus: 'COMPLETED', fromAddress: merchant, toAddress: merchant,
        sending: { txHash: exchangeHash, chainId: 5042, token: fromCoin, amount: '1000000' },
        receiving: { txHash: exchangeDestinationHash, chainId: 8453, token: toCoin, amount: '950000' } });
    }
    if (url.origin === new URL(exchangeChain(8453).rpcUrls.default.http[0]).origin && request.method() === 'POST') {
      const body = request.postDataJSON();
      const baseReceipt = { status: '0x1', blockNumber: block, transactionHash: exchangeDestinationHash, logs: [{
        ...paid, address: baseUSDC, transactionHash: exchangeDestinationHash,
        topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: baseRouter, to: merchant } }),
        data: encodeAbiParameters([{ type: 'uint256' }], [950_000n]),
      }] };
      const results = { eth_chainId: '0x2105', eth_getTransactionReceipt: baseReceipt, eth_getBalance: '0x0', eth_getCode: '0x',
        eth_getTransactionCount: '0x7', eth_call: '0x' + '0'.repeat(64), eth_blockNumber: block };
      const rpcResult = item => {
        if (!Object.hasOwn(results, item.method)) unexpectedRequests.push('Base ' + item.method);
        return { jsonrpc: '2.0', id: item.id, result: results[item.method] ?? '0x' };
      };
      return reply(Array.isArray(body) ? body.map(rpcResult) : rpcResult(body));
    }
    if (url.origin === 'https://li.quest' && url.pathname === '/v1/quote' && request.method() === 'GET') {
      assert.equal(url.searchParams.get('fromChain'), '5042');
      assert.equal(url.searchParams.get('toChain'), '5042');
      assert.equal(url.searchParams.get('fee'), '0');
      assert.equal(url.searchParams.get('integrator'), null);
      const from = Object.values(SWAP_TOKENS).find(token => token.address === url.searchParams.get('fromToken'));
      const to = Object.values(SWAP_TOKENS).find(token => token.address === url.searchParams.get('toToken'));
      return reply(quoteFixture({ from, to, amount: BigInt(url.searchParams.get('fromAmount')), account: url.searchParams.get('fromAddress') }));
    }
    if (request.method() === 'OPTIONS' && (url.href === api || url.origin === arcNetwork.rpcUrl)) {
      return route.fulfill({ status: 204, headers: cors });
    }
    if (url.origin === arcNetwork.rpcUrl && request.method() === 'POST') {
      const body = request.postDataJSON();
      const methods = {
        eth_chainId: () => '0x13b2',
        eth_getCode: ([, at]) => at === numberToHex(arcNetwork.deploymentBlock - 1n) ? '0x' : code,
        eth_getBalance: () => numberToHex(nativeBalance),
        eth_gasPrice: () => numberToHex(20_000_000_000n),
        eth_blockNumber: () => block,
        eth_getTransactionCount: () => '0x7',
        eth_getBlockByNumber: () => ({ number: block, timestamp: '0x69000000', transactions: [] }),
        eth_call: ([{ to, data }]) => {
          if (Object.values(SWAP_TOKENS).some(token => token.address.toLowerCase() === to.toLowerCase())) {
            const functionName = data.startsWith('0xdd62ed3e') ? 'allowance' : 'balanceOf';
            return encodeFunctionResult({ abi: erc20Abi, functionName, result: 5_000_000n });
          }
          return encodeFunctionResult({ abi, functionName: 'getInvoice', result: { merchant, amount, expiresAt: 0n, status: invoiceState } });
        },
        eth_getLogs: ([{ topics }]) => [created, paid].filter(log => log.topics[0] === topics[0]
          && topics.slice(1).every((topic, index) => !topic || topic === log.topics[index + 1])),
        eth_getTransactionByHash: ([hash]) => hash === exchangeHash ? { ...payment, from: merchant, to: exchangeRouter,
          input: exchangeInput, value: '0x0', hash } : hash === swapHash
          ? { ...payment, from: merchant, to: SWAP_ROUTER, input: swapInput, value: '0x0', hash: swapHash } : payment,
        eth_getTransactionReceipt: ([hash]) => hash === exchangeHash ? { status: '0x1', blockNumber: block, transactionHash: hash, logs: [{
          ...paid, address: fromCoin.address, transactionHash: exchangeHash,
          topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: merchant, to: exchangeRouter } }),
          data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]),
        }] } : hash === swapHash
          ? { status: '0x1', blockNumber: block, transactionHash: swapHash, logs: swapLog }
          : { status: '0x1', blockNumber: block, transactionHash: paymentHash, logs: [paid] },
      };
      const rpcResult = item => {
        if (!Object.hasOwn(methods, item.method)) {
          unexpectedRequests.push('Arc ' + item.method);
          return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: 'Unsupported fixture method' } };
        }
        return { jsonrpc: '2.0', id: item.id, result: methods[item.method](item.params || []) };
      };
      return reply(Array.isArray(body) ? body.map(rpcResult) : rpcResult(body));
    }
    if (url.href === api && request.method() === 'POST') {
      const body = request.postDataJSON();
      if (body.action === 'public_invoice') {
        assert.equal(request.headers().authorization, undefined);
        assert.equal(body.chainId, 5042);
        return reply({ invoice: { clientName: 'Public receipt fixture', description: 'Arc invoice fixture' } });
      }
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
    if (url.href === 'https://lifinance.github.io/types/src/assets/icons/chains/ethereum.svg') {
      return route.fulfill({ body: await readFile(resolve(TERMUL_FIXTURE_DIST, 'brand/usdc.svg')), contentType: 'image/svg+xml' });
    }
    if (url.origin === origin && (url.pathname === '/' || /^\/(?:assets\/[a-zA-Z0-9._-]+|brand\/(?:usdc|eurc)\.svg|termul-logo\.gif)$/.test(url.pathname))) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.gif': 'image/gif', '.svg': 'image/svg+xml' }[extname(name)];
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
  const verify = () => page.locator('#account-verify-wallet').click();
  const openAccount = () => page.locator('#workspace [data-wallet-menu]').click();
  const fits = locator => locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const content = element.querySelector('.dialog-content');
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      && element.scrollWidth <= element.clientWidth && (!content || content.scrollWidth <= content.clientWidth)
      && document.documentElement.scrollWidth <= innerWidth;
  });
  const tokenFiles = locator => locator.evaluateAll(images => images.map(image =>
    image.complete && image.naturalWidth > 0 ? new URL(image.src).pathname : null));

  const switchNetwork = () => page.locator('#switch-wallet-network').click();

  await page.goto(origin);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 720 });
    await page.getByRole('heading', { name: /Get paid in USDC/ }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  for (const nav of ['.mobile-bottom', '.side-nav']) {
    assert.deepEqual(await page.locator(nav + ' [data-nav]').allTextContents(), ['Home', 'Create', 'Swap']);
  }
  await page.locator('.payment-explainer summary').click();
  await page.getByText(/The merchant shares a link/).waitFor();
  assert.equal(await page.locator('#payment').isVisible(), false);
  await page.locator('.public-feature button[data-nav="create"]').click();
  await page.locator('#workspace-access').waitFor();
  assert.equal(await page.locator('.side-nav [aria-current=page]').getAttribute('data-nav'), 'create');
  assert.equal(await page.locator('#create-view').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls), []);
  await page.locator('.side-nav [data-nav="swap"]').click();
  await page.getByRole('tab', { name: 'Any Token' }).click();
  await page.locator('#exchange-widget input').first().waitFor();
  const networkSummary = page.getByRole('group', { name: 'Selected networks' });
  const sourceNetwork = networkSummary.locator('[data-exchange-network="from"]');
  const destinationNetwork = networkSummary.locator('[data-exchange-network="to"]');
  assert.equal(await sourceNetwork.textContent(), 'Arc');
  assert.equal(await destinationNetwork.textContent(), 'Base');
  for (const network of [sourceNetwork, destinationNetwork]) {
    await network.locator('img').evaluate(image => image.decode());
  }
  const widget = page.locator('#exchange-widget');
  const connectAnyToken = widget.getByRole('button', { name: /connect wallet/i });
  assert.deepEqual(await connectAnyToken.evaluate(button => {
    const styles = getComputedStyle(button);
    return [styles.backgroundColor, styles.color, styles.getPropertyValue('--lifi-palette-background-default').trim(),
      styles.getPropertyValue('--lifi-palette-background-paper').trim()];
  }), ['rgb(101, 228, 208)', 'rgb(8, 11, 19)', '#101520', '#141a27']);
  await widget.getByTestId('widget-swap-tokens-button').click();
  assert.equal(await sourceNetwork.textContent(), 'Base');
  assert.equal(await destinationNetwork.textContent(), 'Arc');
  await widget.getByTestId('widget-swap-tokens-button').click();
  assert.equal(await sourceNetwork.textContent(), 'Arc');
  assert.equal(await destinationNetwork.textContent(), 'Base');
  await widget.getByTestId('widget-from-token-button').click();
  await widget.getByText('USDC', { exact: true }).last().click();
  await widget.getByTestId('widget-to-token-button').click();
  await widget.getByText('EURC', { exact: true }).last().click();
  assert.equal(await sourceNetwork.textContent(), 'Arc');
  assert.equal(await destinationNetwork.textContent(), 'Arc');
  assert.match(await widget.getByTestId('widget-to-token-button').textContent(), /EURC/);
  assert.equal(await page.getByText(/Codex is unavailable/i).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls), []);
  await connectAnyToken.click();
  assert.equal(await page.locator('#wallet-dialog[open] .wallet-choice').count(), 2);
  await page.getByRole('button', { name: 'Rabby io.rabby' }).click();
  await connected(merchant);
  assert.equal(await page.evaluate(() => window.termulWallet.getSelection().chainId), 1);
  assert.equal(await page.evaluate(() => window.fixtureCalls.some(call => call.method === 'wallet_switchEthereumChain')), false);
  await page.locator('.side-nav [data-nav="create"]').click();
  await page.setViewportSize({ width: 320, height: 720 });
  await openAccount();
  for (const width of widths.slice(0, 3)) {
    await page.setViewportSize({ width, height: 650 });
    assert.equal(await fits(page.locator('#account-dialog')), true);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#workspace [data-wallet-menu]').evaluate(button => document.activeElement === button), true);
  await openAccount();
  await page.getByText(merchant, { exact: true }).first().waitFor();
  await switchNetwork();
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.waitForFunction(() => window.termulWallet.getSelection().chainId === 5042);
  assert.equal(await page.evaluate(() => window.arusPayApi.getInvoices().length), 0);
  assert.equal(await page.locator('#wallet-balance').textContent(), '—');
  assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.name === 'MetaMask').length), 0);

  assert.equal(await page.locator('#display-name-form').isVisible(), false);
  await page.evaluate(() => { window.fixtureRejectSignature = true; });
  await verify();
  await page.getByText('Wallet signature declined. Try again when you’re ready.').waitFor();
  await page.evaluate(() => { window.fixtureRejectSignature = false; });
  await verify();
  await authenticated(true);
  await page.getByText(merchant, { exact: true }).first().waitFor();
  await page.waitForFunction(() => window.arusPayApi.getInvoices()[0]?.status === 'paid');
  assert.equal(await page.locator('#wallet-balance').textContent(), '5.00');
  assert.equal(await page.evaluate(() => window.arusPayApi.getInvoices()[0].paymentTxHash), paymentHash);
  await page.locator('#display-name-input').waitFor();
  await page.waitForFunction(() => document.querySelector('#display-name-input').value === 'Fixture merchant');
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('cd'.repeat(32)))), false);

  await page.reload();
  await connected(merchant);
  await authenticated(false);
  assert.equal(await page.evaluate(() => window.fixtureCalls.some(call => call.method === 'eth_requestAccounts')), false);
  await openAccount();
  await switchNetwork();
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
  await page.getByText('Public receipt fixture', { exact: true }).first().waitFor();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 650 });
    const openStatus = page.getByRole('button', { name: 'View transaction status' });
    await openStatus.click();
    const dialog = page.getByRole('dialog', { name: 'Payment successful' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('link', { name: 'View on Arc Explorer' }).getAttribute('href'), 'https://explorer.arc.io/tx/' + paymentHash);
    assert.equal(await dialog.locator('[data-transaction-amount]').textContent(), '0.01 USDC');
    assert.deepEqual(await tokenFiles(dialog.locator('.token-icon')), ['/brand/usdc.svg']);
    assert.equal(await page.evaluate(() => {
      const dialog = document.querySelector('#transaction-dialog');
      const box = dialog.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
        && dialog.scrollWidth <= dialog.clientWidth && document.documentElement.scrollWidth <= innerWidth;
    }), true);
    assert.ok(await dialog.getByRole('button', { name: 'Done' }).evaluate(button => button === document.activeElement));
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(await openStatus.evaluate(button => button === document.activeElement));
  }
  await page.reload();
  await page.getByRole('heading', { name: 'Paid', exact: true }).waitFor();
  await page.getByRole('button', { name: 'View transaction status' }).click();
  await page.getByRole('dialog', { name: 'Payment successful' }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();
  invoiceState = 1;
  await page.reload();
  await page.getByRole('heading', { name: 'Open', exact: true }).waitFor();
  assert.equal(await page.locator('#pay-onchain').textContent(), 'Connect wallet to pay');
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls), []);
  const actionsBeforeSwap = actions.length;
  await page.goto(origin);
  await page.getByRole('button', { name: 'Explore swaps' }).click();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 650 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const visibleNav = width <= 650 ? '.mobile-bottom' : '.side-nav';
    assert.equal(await page.locator(visibleNav + ' [aria-current=page]').getAttribute('data-nav'), 'swap');
    assert.deepEqual(await tokenFiles(page.locator('#swap-form .token-icon')), ['/brand/usdc.svg', '/brand/eurc.svg']);
  }
  await page.locator('#swap-input').fill('1');
  await page.getByText('LI.FI · Fly', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-swap="provider-fee"]').textContent(), '0.0025 USDC');
  assert.equal(await page.locator('[data-swap="impact"]').textContent(), '0.12%');
  await page.getByRole('button', { name: 'Switch swap direction' }).click();
  await page.getByText('0.0025 EURC', { exact: true }).waitFor();
  assert.deepEqual(await tokenFiles(page.locator('#swap-form .token-icon')), ['/brand/eurc.svg', '/brand/usdc.svg']);
  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls), []);
  await page.locator('[data-swap="submit"]').click();
  await page.getByRole('button', { name: 'Rabby io.rabby' }).click();
  await connected(merchant);
  await page.locator('[data-swap="submit"]').click();
  await page.waitForFunction(() => window.termulWallet.getSelection().chainId === 5042);
  await page.waitForFunction(() => document.querySelector('[data-swap="input-balance"]').textContent === '5');
  await page.locator('#swap-input').fill('6');
  await page.getByText('Not enough EURC in your wallet.').waitFor();
  assert.equal(await page.locator('[data-swap="submit"]').isDisabled(), true);
  nativeBalance = 0n;
  await page.locator('#swap-input').fill('2');
  await page.getByText('Keep some USDC in your wallet for network fees.').waitFor();
  assert.equal(await page.locator('[data-swap="submit"]').isDisabled(), true);
  nativeBalance = 5n * 10n ** 18n;
  await page.getByRole('button', { name: 'Max', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#swap-input').value === '5');
  for (const width of widths) {
    await page.setViewportSize({ width, height: 650 });
    await page.locator('[data-swap="submit"]').click();
    const swapReview = page.getByRole('dialog', { name: 'Review swap' });
    await swapReview.waitFor();
    assert.equal(await swapReview.locator('[data-review="send"]').textContent(), '5 EURC');
    assert.equal(await swapReview.locator('[data-review="account"]').textContent(), merchant);
    assert.equal(await fits(swapReview), true);
    assert.equal(await fits(swapReview.getByRole('button', { name: 'Cancel' })), true);
    assert.deepEqual(await tokenFiles(swapReview.locator('.token-icon')), ['/brand/eurc.svg', '/brand/usdc.svg']);
    if (width === 320) {
      await swapReview.getByText('Exact network fee limit').click();
      await swapReview.locator('[data-review="gas-exact"]').waitFor();
    }
    await swapReview.getByRole('button', { name: 'Cancel' }).click();
  }
  await authenticated(false);
  assert.equal(actions.length, actionsBeforeSwap);
  await page.evaluate(({ merchant, record }) => {
    localStorage.setItem('termul.arc-swap.v1:' + merchant, JSON.stringify(record));
  }, { merchant, record: recordFixture(swapContext, swapInput) });
  await page.reload();
  await connected(merchant);
  await page.getByRole('button', { name: 'Explore swaps' }).click();
  await page.getByText('Previous swap is pending verification.').waitFor();
  assert.equal(await page.locator('[data-swap="submit"]').isDisabled(), true);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 650 });
    await page.getByRole('button', { name: 'Check status' }).click();
    const swapSuccess = page.getByRole('dialog', { name: 'Swap Successful!' });
    await swapSuccess.waitFor();
    assert.equal(await swapSuccess.locator('[data-transaction-amount]').textContent(), '10 USDC');
    assert.equal(await swapSuccess.locator('[data-transaction-received]').textContent(), '9.095 EURC');
    assert.deepEqual(await tokenFiles(swapSuccess.locator('.token-icon')), ['/brand/usdc.svg', '/brand/eurc.svg']);
    assert.equal(await swapSuccess.getByRole('link', { name: 'View on Arc Explorer' }).getAttribute('href'), 'https://explorer.arc.io/tx/' + swapHash);
    assert.equal(await fits(swapSuccess), true);
    assert.equal(await fits(swapSuccess.getByRole('button', { name: 'Done' })), true);
    await swapSuccess.getByRole('button', { name: 'Done' }).click();
  }
  assert.equal(await page.locator('#exchange-widget').isVisible(), false);
  const exchangeTab = page.getByRole('tab', { name: 'Any Token' });
  await exchangeTab.click();
  assert.equal(await page.getByText(/Codex is unavailable/i).count(), 0);
  await page.locator('#exchange-widget input').first().waitFor();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 650 });
    assert.equal(await fits(networkSummary), true);
    const overflow = await page.locator('#exchange-widget').evaluate(panel => ({
      documentWidth: document.documentElement.scrollWidth,
      widgetWidth: panel.clientWidth, widgetScrollWidth: panel.scrollWidth,
      elements: [...panel.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth)
        .slice(0, 7).map(el => String(el.className)),
    }));
    assert.ok(overflow.documentWidth <= width && overflow.widgetScrollWidth <= overflow.widgetWidth,
      `Any Token overflow at ${width}px: ${JSON.stringify(overflow)}`);
  }
  assert.equal(await page.locator('.side-nav [aria-current=page]').getAttribute('data-nav'), 'swap');
  assert.equal(await exchangeTab.getAttribute('aria-selected'), 'true');
  await page.evaluate(record => {
    localStorage.setItem('termul.any-token.v1:' + record.account, JSON.stringify(record));
  }, exchangeFixture);
  await page.reload();
  await connected(merchant);
  await page.getByRole('button', { name: 'Explore swaps' }).click();
  await exchangeTab.click();
  await page.getByText('Settlement confirmed.', { exact: true }).waitFor();
  const bridge = page.getByRole('dialog', { name: 'Bridge Completed!' });
  await bridge.waitFor();
  assert.equal(await bridge.locator('[data-transaction-received]').textContent(), '0.95 USDC');
  assert.equal(await bridge.locator('[data-transaction-destination]').textContent(), exchangeDestinationHash);
  assert.ok(await bridge.getByRole('link', { name: 'Destination · Base' }).getAttribute('href') === 'https://basescan.org/tx/' + exchangeDestinationHash);
  assert.ok(await bridge.getByRole('link', { name: 'View on Arc Mainnet Explorer' }).getAttribute('href') === 'https://explorer.arc.io/tx/' + exchangeHash);
  assert.ok(await bridge.getByRole('link', { name: 'LI.FI Scan' }).getAttribute('href') === 'https://scan.li.fi/tx/' + exchangeHash);
  await bridge.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'View receipt' }).click();
  await bridge.waitFor();
  await bridge.getByRole('button', { name: 'Done' }).click();
  assert.equal(await page.evaluate(() => window.fixtureUnexpectedWalletMethod), undefined);
  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(browserErrors, []);
  console.log('Chromium passed: guest access, wallet, SIWE, invoices, stablecoin swap, Any Token across six viewports, and cross-chain receipt recovery.');
} finally {
  await browser.close();
}
