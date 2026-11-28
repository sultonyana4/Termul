import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, hexToString, numberToHex, parseAbi } from 'viem';
import { arcNetwork } from '../src/arc-network.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

import { createServer } from 'vite';
import { createHostedSessionVault } from '../server/circle/session-vault.js';
import { createLocalSessionVault } from '../experiments/circle-wallet-poc/session-vault.js';
import { createLocalWeb3 } from '../experiments/circle-wallet-poc/local-web3.js';
import { ARC_ANY_SWAP_TOKENS } from '../src/swap-quote.js';

const port = Number(process.env.TERMUL_CIRCLE_BROWSER_PORT ?? 5173);
const origin = `http://localhost:${port}`;
const account = privateKeyToAccount(generatePrivateKey());
const externalAccount = privateKeyToAccount(generatePrivateKey());
const external = externalAccount.address;
const wallet = { id: '11111111-1111-4111-8111-111111111111', address: account.address, blockchain: 'ARC', accountType: 'EOA' };
const id = '0x' + '33'.repeat(32);
const hash = '0x' + '44'.repeat(32);
const sidecar = '/__termul_circle';
const auth = { userToken: 'mock-circle-user-token', encryptionKey: 'mock-circle-encryption-key' };
const hostedBuild = process.env.TERMUL_CIRCLE_HOSTED_DIST;
const terminal = new Set(['payment', 'app-creation', 'swap']);
const tokenArtwork = 'https://token-images.example.invalid/arc.svg';
const catalogSource = { ...ARC_ANY_SWAP_TOKENS.cirBTC, name: 'Circle Wrapped Bitcoin', chainId: 5042, logoURI: tokenArtwork };
const lookupToken = { address: '0x' + '82'.repeat(20), name: 'Address lookup token', symbol: 'LOOKUP', decimals: 18,
  chainId: 5042, logoURI: tokenArtwork };
process.env.TERMUL_LOCAL_CIRCLE = 'enabled';
const vite = await createServer({ mode: 'circle-local', server: { port, strictPort: true },
  define: { 'import.meta.env.TERMUL_LOCAL_ORIGIN': JSON.stringify(origin) } });
let browser;
const operations = [];

const mockSdk = `
export class W3SSdk {
 updateConfigs(config, callback) { this.callback = callback; }
 setAuthentication(auth) { this.auth = auth; }
 setThemeColor(theme) { window.mockCircleTheme = theme; }
 setOnResendOtpEmail() {}
 getDeviceId() { return Promise.resolve('11111111-2222-4333-8333-444444444444'); }
 confirmation(title, done, decline) {
   const frame = document.createElement('iframe');
   frame.id = 'sdkIframe';
   frame.title = title;
   frame.srcdoc = '<button id="approve">Approve</button><button id="decline">Decline</button><button id="dismiss">Dismiss</button>';
   Object.assign(frame.style, { position:'fixed', inset:'10px', zIndex:'9999999', background:'white' });
   frame.onload = () => {
     const finish = outcome => { outcome(); frame.remove(); };
     frame.contentDocument.querySelector('#approve').onclick = () => finish(done);
     frame.contentDocument.querySelector('#decline').onclick = () => finish(decline);
     frame.contentDocument.querySelector('#dismiss').onclick = () => frame.remove();
   };
   document.body.append(frame);
 }
 verifyOtp() { this.confirmation('Mock Circle OTP', () => this.callback(null, ${JSON.stringify(auth)}), () => this.callback({ code:155701 })); }
 execute(id, callback) {
   this.confirmation(id === 'mock-siwe' ? 'Mock Circle ownership' : 'Mock Circle transaction',
    () => { if (id !== 'mock-siwe') window.mockCircleApproved = true;
      callback(null, { status:'COMPLETE', data:{ signature: window.mockCircleSignature } }); },
    () => { window.mockCircleRejected = true; callback({ code: 155701 }); });
 }
}
`;

async function prepare(context, { managed = true, externalPayment = false, delayedSwap = false, allowanceReset = false, arcAnyToken = false, newCircleUser = false } = {}) {
  let otpRequests = 0, current, review, signature, catalogReads = 0, tokenLookups = 0;
  let swapAttempt, swapReady = !delayedSwap, swapSubmissions = 0, requoted = false;
  let initializationRequests = 0, walletAvailable = !newCircleUser;
  let paymentSubmissions = 0, finality = false;
  let verifiedUntil;
  let web3Signatures = 0;
  let historyReads = 0;
  let reservation, settledHash;
  const web3 = createLocalWeb3({ arc: { getChainId: async () => 5042, getCode: async () => undefined }, origin,
    metadata: { request: (session, input) => {
      if (input.action === 'reserve_payment_attempt') {
        assert.equal(reservation, undefined);
        reservation = { attempt_id: 'fixture-attempt', payer_address: session.address, tx_hash: null };
        return { attemptId: reservation.attempt_id };
      }
      if (input.action === 'save_payment_attempt') { reservation.tx_hash = input.transactionHash; return { ok: true }; }
      if (input.action === 'clear_payment_attempt') {
        assert.equal(input.verifiedHash, hash);
        settledHash = input.verifiedHash;
        reservation = undefined;
        return { ok: true };
      }
      if (input.action === 'get_payment_attempt') return { attempt: reservation ?? null, ...(settledHash && { settled: { tx_hash: settledHash } }) };
      return { profile: null, invoices: [] };
    } } });
  const formReviews = [];
  let staleForm = false;
  const runtime = JSON.parse(await readFile(new URL('../contracts/out/TermulInvoices.sol/TermulInvoices.json', import.meta.url))).deployedBytecode.object;
  const abi = parseAbi([
    'function getInvoice(address merchant, bytes32 id) view returns ((address merchant, uint256 amount, uint64 expiresAt, uint8 status))',
    'function createInvoice(bytes32 id, uint256 amount, uint64 expiresAt)',
    'function payInvoice(address merchant, bytes32 id) payable',
    'event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint64 expiresAt)',
    'event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount)',
  ]);
  const block = numberToHex(arcNetwork.deploymentBlock);
  const blockHash = '0x' + 'a4'.repeat(32);
  const mark = { invoiceId: id, merchant: account.address };
  const amount = 10n ** 17n;
  const creation = '0x' + 'a5'.repeat(32);
  const event = (name, tx, args, fields, values) => ({ address: arcNetwork.contractAddress, transactionHash: tx,
    blockHash, blockNumber: block, transactionIndex: '0x0', logIndex: '0x0', removed: false,
    topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(fields.map(type => ({ type })), values) });
  const logs = [event('InvoiceCreated', creation, mark, ['uint256', 'uint64'], [amount, 0n]),
    event('InvoicePaid', hash, { ...mark, payer: external }, ['uint256'], [amount])];
  const transaction = payment => ({ hash: payment ? hash : creation, blockHash, blockNumber: block,
    from: payment ? external : account.address, to: arcNetwork.contractAddress, chainId: '0x13b2', type: '0x2',
    input: payment ? encodeFunctionData({ abi, functionName: 'payInvoice', args: [account.address, id] })
      : encodeFunctionData({ abi, functionName: 'createInvoice', args: [id, amount, 0n] }), value: payment ? numberToHex(amount) : '0x0' });
  let rpcFailures = 0;
  const attempts = [];
  const vault = createLocalSessionVault();
  await context.addInitScript(({ external }) => {
    const detail = {
      info: { name: 'Mock Browser Wallet', rdns: 'test.termul.wallet', uuid: '11111111-2222-4333-8333-444444444444' },
      provider: {
        on() {}, removeListener() {},
        async request({ method, params }) {
          if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [external];
          if (method === 'eth_chainId') return '0x13b2';
          if (method === 'personal_sign') return window.fixtureExternalSignature(params[0]);
          if (method === 'eth_sendTransaction') return window.fixtureExternalPayment(params[0]);
          throw new Error('Unexpected injected request ' + method);
        },
      },
    };
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    });
  }, { external });
  const page = await context.newPage();
  await page.exposeFunction('fixtureExternalPayment', request => {
    assert.equal(externalPayment, true);
    assert.equal(request.to, arcNetwork.contractAddress);
    assert.equal(BigInt(request.value), amount);
    paymentSubmissions++;
    return hash;
  });
  await page.exposeFunction('fixtureExternalSignature', async message => {
    web3Signatures++;
    return externalAccount.signMessage({ message: hexToString(message) });
  });
  await context.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) {
      const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (arcAnyToken && url.href === tokenArtwork) return route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16"/></svg>' });
      if (arcAnyToken && url.hostname === 'li.quest' && url.pathname === '/v1/tokens') {
        catalogReads++;
        assert.equal(url.searchParams.get('chains'), '5042');
        return route.fulfill({ headers: cors, json: { tokens: { 5042: [catalogSource] } } });
      }
      if (arcAnyToken && url.hostname === 'li.quest' && url.pathname === '/v1/token') {
        tokenLookups++;
        assert.equal(url.searchParams.get('chain'), '5042');
        assert.equal(url.searchParams.get('token'), lookupToken.address);
        return route.fulfill({ headers: cors, json: lookupToken });
      }
      if (req.method() === 'POST' && url.hostname === 'rpc.mainnet.arc.io') {
        const { method, id, params } = req.postDataJSON();
        assert.ok(!method.toLowerCase().includes('send'), 'No broadcast methods are allowed in the fixture.');
        if (managed && method === 'eth_getLogs' && rpcFailures++ < 4) return route.fulfill({ status: 429, headers: cors, json: {
          jsonrpc: '2.0', id, error: { code: -32005, message: 'rate limit exceeded' },
        } });
        const eventLog = params?.[0] === creation ? logs[0] : logs[1];
        return route.fulfill({ headers: cors, json: { jsonrpc: '2.0', id, result:
          ({ eth_chainId: '0x13b2', eth_getBalance: numberToHex(192443614790130545n),
            eth_getBlockByNumber: { number: externalPayment && params?.[0] === 'finalized' && !finality ? numberToHex(BigInt(block) - 1n) : block,
              hash: blockHash, timestamp: '0x69000000', baseFeePerGas: numberToHex(20_000_000_000n), transactions: [] },
            eth_maxPriorityFeePerGas: '0x1', eth_estimateGas: '0x16972', eth_getTransactionCount: '0x7',
            eth_getTransactionByHash: transaction(params?.[0] !== creation),
            eth_getTransactionReceipt: { status: '0x1', blockNumber: block, blockHash, transactionHash: eventLog.transactionHash, logs: [eventLog] },
            eth_call: params?.[0]?.data?.startsWith('0x70a08231') ? numberToHex(10_000_000n, { size: 32 })
              : encodeFunctionResult({ abi, functionName: 'getInvoice', result: { merchant: account.address, amount, expiresAt: 0n,
              status: externalPayment && !paymentSubmissions ? 1 : 2 } }),
            eth_getLogs: logs.filter(log => params?.[0]?.topics?.[0] === log.topics[0]),
            eth_getCode: params?.[1] === numberToHex(arcNetwork.deploymentBlock - 1n) ? '0x' : runtime })[method] ?? '0x0' } });
      }
      return route.abort();
    }
    if (!url.pathname.startsWith(sidecar + '/')) return route.continue();
    if (url.pathname.endsWith('/config')) return route.fulfill({ json: { appId: 'fixture', managed, arcSwap: managed, arcAnyToken } });
    if (url.pathname.endsWith('/sdk.js')) return route.fulfill({ contentType: 'text/javascript', body: mockSdk });
    const input = req.postDataJSON();
    const reply = (value, status = 200) => route.fulfill({ json: value, status });
    if (url.pathname.endsWith('/web3')) {
      try { return reply(await web3(input, req.headers().authorization)); }
      catch (error) { return reply({ error: error.message }, error.status ?? 500); }
    }
    if (url.pathname.endsWith('/history')) {
      const belongs = input.merchant.toLowerCase() === account.address.toLowerCase();
      if (input.invoiceId) return reply({ invoice: belongs ? { paymentTxHash: hash } : null });
      return reply({ status: historyReads++ ? 'current' : 'stale', issue: 'rate-limited', coverageStarted: true, throughBlock: Number(block),
        invoices: belongs ? [{ id: 'INV-FIXTURE', invoiceId: id, merchant: account.address, amount: '0.1', amountBase: String(amount),
          status: 'paid', name: 'On-chain invoice', initials: 'AP', description: 'On-chain invoice', createdAt: '2026-11-27T00:00:00Z',
          paidAt: '2026-11-27T00:00:00Z', createdBlockTime: '2026-11-27T00:00:00Z', paidBlockTime: '2026-11-27T00:00:00Z',
          createTxHash: creation, paymentTxHash: hash, onchainVerified: true }] : [] });
    }
    if (url.pathname.endsWith('/session')) {
      const result = await vault.handle(input, await req.headerValue('cookie'), async userToken => {
        assert.equal(userToken, auth.userToken);
        return { wallet, verifiedUntil };
      });
      return route.fulfill({ status: result.status ?? 200, json: result.body,
        ...(result.cookie ? { headers: { 'Set-Cookie': result.cookie } } : {}) });
    }
    if (input.action === 'local-public-invoice') return reply({ invoice: null });
    if (input.action === 'otp') {
      otpRequests++;
      return reply({ otpToken: 'mock-otp', deviceToken: 'mock-device', deviceEncryptionKey: 'mock-device-key' });
    }
    assert.equal(input.userToken, auth.userToken);
    if (input.action === 'logout') { verifiedUntil = undefined; return reply({}); }
    if (input.action === 'initialization-status') {
      if (newCircleUser && initializationRequests && await page.evaluate(() => window.mockCircleApproved === true)) walletAvailable = true;
      if (walletAvailable) return reply({ wallet, state: 'ready' });
      return reply(initializationRequests ? { wallet: null, state: 'pending', resumable: true } : { wallet: null, state: 'retry' });
    }
    if (newCircleUser && input.action === 'initialize') {
      initializationRequests++;
      return reply({ challengeId: 'mock-initialize' });
    }
    if (input.action === 'local-metadata') {
      if (input.metadataAction === 'get_invoices') return reply({ error: 'Optional metadata unavailable.' }, 502);
      return reply({ profile: { display_name: 'Circle fixture' }, invoices: [] });
    }
    if (input.action === 'sign') {
      const message = createSiweMessage({ address: account.address, domain: new URL(origin).host, uri: origin, version: '1', chainId: 5042,
        nonce: 'mocknonce2026', expirationTime: new Date(Date.now() + 300_000) });
      signature = await account.signMessage({ message });
      await page.evaluate(signature => { window.mockCircleSignature = signature; }, signature);
      return reply({ message, challengeId: 'mock-siwe' });
    }
    if (input.action === 'verify-signature') {
      assert.equal(input.signature, signature);
      verifiedUntil = Date.now() + 299_000;
      return reply({ verified: true, verifiedUntil });
    }
    if (input.action === 'attempt-history') return reply({ attempts });
    const action = input.action.replace(/^pilot-/, 'invoice-');
    if (action.endsWith('-review')) {
      if (!managed) return reply({ error: 'Disabled' }, 403);
      current = action === 'swap-review' ? 'swap' : input.kind;
      assert.ok(terminal.has(current));
      if (input.anyToken && input.amount === '12345') return reply({ error: 'No supported Arc route for this pair and amount.' }, 422);
      if (input.anyToken && input.amount === '12346') return reply({ error: 'LI.FI is rate-limiting Circle quotes. Try again later.' }, 429);
      review = { reviewId: 'mock-reviewed-id', invoiceId: id, walletAddress: account.address, merchant: external,
        reviewExpiresAt: Date.now() + 90_000, maxCostUsdc: '0.004', valueUsdc: current === 'payment' ? '0.01' : '0',
        invoiceAmountUsdc: '0.01', contract: '0x62209ab89631492e7943ef21baee792d430f5d0e',
        gasLimit: '100000', maxFeePerGas: '40000000000', priorityFeePerGas: '2000000000', calldataHash: hash };
      if (current === 'app-creation' && input.invoiceId !== id) {
        const { invoiceId, amountBase, expiresAt } = input;
        formReviews.push({ invoiceId, amountBase, expiresAt });
        review = { ...review, invoiceId, reviewId: 'form-review-' + formReviews.length, maxCostUsdc: staleForm ? '0.005' : '0.004' };
      }
      if (current === 'swap') Object.assign(review, { phase: 'swap', from: input.from, to: input.to, amount: input.amount,
        minimum: '900000', received: '910000', priceImpact: '0.1', route: 'LI.FI · Fly', feeBps: 10,
        integratorFee: '1000', providerFee: '2000', recipient: account.address, networkFee: '0.004', target: review.contract });
      if (input.anyToken) {
        assert.equal(arcAnyToken, true);
        assert.equal(input.from, catalogSource.address);
        assert.equal(input.to, lookupToken.address);
        assert.equal(input.amount, '1000000');
        assert.equal(input.toChain, undefined);
        Object.assign(review, { anyToken: true, from: catalogSource.symbol, to: lookupToken.symbol,
          assets: [catalogSource, lookupToken], received: '200000000000000000', minimum: '199000000000000000' });
      }
      if (current === 'swap' && allowanceReset && swapSubmissions < 2) Object.assign(review, { phase: 'approval', spender: review.contract,
        allowanceValue: swapSubmissions === 0 ? '0' : input.amount });
      if (current === 'swap' && requoted) review.networkFee = '0.005123456789';
      return reply({ enabled: true, review });
    }
    if (action.endsWith('-execute')) {
      assert.equal(input.reviewId, review?.reviewId);
      assert.equal(input.confirmed, true);
      if (review.reviewId === 'form-review-1') {
        staleForm = true;
        review = undefined;
        return reply({ code: 'CIRCLE_FEE_REVIEW_STALE', error: 'Network fees changed. No transaction was submitted.' }, 409);
      }
      if (current === 'swap' && allowanceReset && swapSubmissions === 2 && !requoted) {
        requoted = true;
        return reply({ code: 'CIRCLE_SWAP_FEE_CHANGED', error: 'Network fees changed.' }, 409);
      }
      operations.push(current);
      if (current === 'swap') {
        swapReady = !delayedSwap;
        swapAttempt = { ...review, attemptId: 'mock-swap-' + ++swapSubmissions, kind: 'arc-swap', status: 'challenge-pending' };
      }
      review = undefined;
      return reply({ challengeId: 'mock-tx', attempt: current === 'swap' ? swapAttempt : { status: 'challenge-pending' } });
    }
    if (action === 'swap-status') {
      if (!swapAttempt) return reply({ attempt: null });
      if (!swapReady) return reply({ attempt: { ...swapAttempt, status: 'transaction-pending' } });
      const attempt = { ...swapAttempt, status: 'verified', transactionHash: hash, spent: swapAttempt.amount,
        received: swapAttempt.anyToken ? '199800000000000000' : '909500' };
      if (!attempts.some(a => a.attemptId === attempt.attemptId)) attempts.push(attempt);
      return reply({ attempt });
    }
    if (action.endsWith('-status')) {
      if (!current || review) return reply({ attempt: null });
      const rejected = await page.evaluate(() => window.mockCircleRejected === true);
      const attempt = { invoiceId: id, phase: current === 'swap' ? 'swap' : undefined, kind: current === 'swap' ? 'arc-swap' : current,
        transactionHash: rejected ? null : hash, status: rejected ? 'rejected' : 'verified', received: '909500' };
      if (!attempts.some(a => a.kind === attempt.kind && a.status === attempt.status)) attempts.push(attempt);
      return reply({ attempt });
    }
    throw new Error('Unexpected local Circle route ' + input.action);
  });
  return { page, counts: () => ({ otpRequests, web3Signatures, paymentSubmissions, swapSubmissions, catalogReads, tokenLookups, initializationRequests }), formReviews,
    finalize: () => { finality = true; }, finalizeSwap: () => { swapReady = true; } };
}
const select = async page => page.evaluate(() => window.termulWallet.getSelection()?.type);
async function waitSelection(page, type) {
  await page.waitForFunction(type => (window.termulWallet?.getSelection()?.type ?? null) === type, type);
}
async function approveOtp(page, email = 'browser-fixture@example.invalid') {
  await page.locator('#connect-wallet').click();
  await page.getByRole('button', { name: 'Continue with Email' }).click();
  await page.locator('#circle-email').fill(email);
  await page.locator('#circle-email-form button[type=submit]').click();
  await page.locator('#circle-otp-continue').click();
  await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
}
async function login(page) {
  await approveOtp(page);
  await waitSelection(page, 'circle');
}
async function checkCircleOnboarding() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const { page, counts } = await prepare(context, { managed: false, newCircleUser: true });
    const email = 'new-fixture@example.invalid';
    await page.goto(origin);
    await approveOtp(page, email);
    const initialize = page.getByRole('button', { name: 'Approve wallet creation' });
    await initialize.waitFor();
    assert.equal(counts().initializationRequests, 0);
    await initialize.click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Dismiss' }).click();
    const resume = page.getByRole('button', { name: 'Continue wallet setup' });
    await resume.waitFor();
    assert.equal(counts().initializationRequests, 1);
    await resume.click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    await waitSelection(page, 'circle');
    const address = () => page.evaluate(() => window.termulWallet.getSelection()?.address);
    assert.equal((await address()).toLowerCase(), account.address.toLowerCase());
    await page.evaluate(() => window.termulWallet.disconnect());
    await waitSelection(page, null);
    await approveOtp(page, email);
    await waitSelection(page, 'circle');
    assert.equal((await address()).toLowerCase(), account.address.toLowerCase());
    assert.equal(counts().initializationRequests, 2);
  } finally {
    await context.close();
  }
}
async function chooseFromAccount(page) {
  await page.locator('button[data-wallet-menu]:visible').first().click();
  await page.locator('#wallet-switch-choice').click();
}
async function hostedCheck(browser, dist) {
  const production = 'https://termul.xyz';
  const walletApi = 'https://example-termul.supabase.co/functions/v1/termul-wallet-v1';
  const bearer = 'ab'.repeat(32);
  const challengeToken = 'cd'.repeat(32);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  let signature, signed, verified = false, executed = false, settled = false, finalized = false;
  let paidReports = 0;
  const artifact = JSON.parse(await readFile(new URL('../contracts/out/TermulInvoices.sol/TermulInvoices.json', import.meta.url)));
  const runtime = artifact.deployedBytecode.object;
  const block = numberToHex(arcNetwork.deploymentBlock);
  const terms = { merchant: external, amount: 10n ** 16n, expiresAt: 0n };
  const contract = arcNetwork.contractAddress;
  const blockHash = '0x' + '76'.repeat(32);
  const invoiceAbi = parseAbi([
    'function getInvoice(address merchant, bytes32 id) view returns ((address merchant, uint256 amount, uint64 expiresAt, uint8 status))',
    'function payInvoice(address merchant, bytes32 invoiceId) payable',
    'event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint64 expiresAt)',
    'event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount)',
  ]);
  const makeLog = (name, topicArgs, types, values, txHash) => ({
    address: contract, transactionHash: txHash, blockHash, blockNumber: block, transactionIndex: '0x0', logIndex: '0x0',
    removed: false, topics: encodeEventTopics({ abi: invoiceAbi, eventName: name, args: topicArgs }),
    data: encodeAbiParameters(types.map(type => ({ type })), values),
  });
  const created = makeLog('InvoiceCreated', { invoiceId: id, merchant: external }, ['uint256', 'uint64'],
    [terms.amount, terms.expiresAt], '0x' + '35'.repeat(32));
  const paid = makeLog('InvoicePaid', { invoiceId: id, merchant: external, payer: account.address }, ['uint256'], [terms.amount], hash);
  const paymentTx = { from: account.address, to: contract, chainId: '0x13b2', type: '0x2', hash, blockNumber: block, blockHash,
    value: numberToHex(terms.amount), input: encodeFunctionData({ abi: invoiceAbi, functionName: 'payInvoice', args: [external, id] }) };
  const receipt = { status: '0x1', transactionHash: hash, blockHash, blockNumber: block, logs: [paid],
    gasUsed: '0x16972', effectiveGasPrice: numberToHex(25_000_000_000n) };
  const methods = {
    eth_chainId: () => '0x13b2',
    eth_getCode: ([, at]) => at === numberToHex(arcNetwork.deploymentBlock - 1n) ? '0x' : runtime,
    eth_getBalance: () => '0x8ac7230489e80000',
    eth_estimateGas: () => '0x16972',
    eth_maxPriorityFeePerGas: () => numberToHex(2_000_000_000n),
    eth_gasPrice: () => numberToHex(25_000_000_000n),
    eth_blockNumber: () => block,
    eth_getBlockByNumber: ([tag]) => ({ number: tag === 'finalized' && settled && !finalized ? numberToHex(BigInt(block) - 1n) : block, hash: blockHash, timestamp: '0x69000000', transactions: [],
      baseFeePerGas: numberToHex(20_000_000_000n) }),
    eth_call: () => encodeFunctionResult({ abi: invoiceAbi, functionName: 'getInvoice',
      result: { ...terms, status: settled ? 2 : 1 } }),
    eth_getLogs: ([{ topics }]) => (settled ? [created, paid] : [created]).filter(log => log.topics[0] === topics[0]
      && topics.slice(1).every((topic, index) => !topic || topic === log.topics[index + 1])),
    eth_getTransactionByHash: ([txHash]) => settled && txHash === hash ? paymentTx : null,
    eth_getTransactionReceipt: ([txHash]) => settled && txHash === hash ? receipt : null,
  };
  const challenge = createSiweMessage({ domain: 'termul.xyz', uri: production, address: account.address, chainId: 5042,
    version: '1', nonce: 'hostedfixture', expirationTime: new Date(Date.now() + 5 * 60_000) });
  let appliedReview, activeLogin, bridgeMined = false, lifiMined = false, paymentReviews = 0;
  const transferRequests = [];
  const lifiHash = '0x' + 'be'.repeat(32);
  const bridgeBaseHash = '0x' + 'aa'.repeat(32);
  const bridgeResult = () => ({ id: 'bridge-mock', amount: '10000000',
    status: bridgeMined ? 'settled' : 'destination-pending',
    history: [{ hash, phase: 'burn', status: 'destination-pending' }],
    ...(bridgeMined && { received: '9945000', destinationHash: bridgeBaseHash }) });
  const sessions = new Map();
  const vault = createHostedSessionVault({
    key: 'ab'.repeat(32),
    store: {
      get: async key => sessions.get(key),
      remove: async key => sessions.delete(key),
      replace: async (previous, key, sealed, expires_at) => {
        if (previous && !sessions.delete(previous)) return false;
        sessions.set(key, { sealed, expires_at });
        return true;
      },
    },
  });
  await context.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { 'access-control-allow-origin': production, 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization' };
    const send = value => route.fulfill({ json: value, headers: cors });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (req.url() === walletApi) {
      const input = req.postDataJSON();
      if (input.action === 'challenge') return send({ challengeToken, message: challenge });
      if (input.action === 'verify') {
        assert.equal(input.signature, signature);
        assert.equal(input.challengeToken, challengeToken);
        assert.equal(input.message, challenge);
        assert.equal(signed, true);
        verified = true;
        return send({ sessionToken: bearer, walletAddress: account.address.toLowerCase(),
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
      }
      if (input.action === 'public_invoice') return send({ invoice: null });
      assert.equal(req.headers().authorization, 'Bearer ' + bearer);
      return send({ profile: { display_name: 'Hosted Circle fixture' }, invoices: [] });
    }
    if (url.origin !== production) {
      if (req.method() === 'POST' && url.hostname === 'rpc.mainnet.arc.io') {
        const body = req.postDataJSON();
        const rpc = ({ method, id, params }) => {
          assert.ok(!method.toLowerCase().includes('send'));
          return Object.hasOwn(methods, method) ? { jsonrpc: '2.0', id, result: methods[method](params ?? []) }
            : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported fixture method' } };
        };
        return send(Array.isArray(body) ? body.map(rpc) : rpc(body));
      }
      return route.abort();
    }
    if (url.pathname === '/assets/termul-circle-sdk.js') return route.fulfill({ contentType: 'text/javascript', body: mockSdk });
    if (url.pathname === '/api/termul-circle-login') {
      if (req.method() === 'GET') return send({ appId: 'fixture', managed: true, arcSwap: false, transferRecovery: true, cctpArcBase: true, circleLifi: true });
      const input = req.postDataJSON();
      if (['remember', 'restore', 'forget'].includes(input.action)) {
        const result = await vault(input, await req.headerValue('cookie'), async token => {
          assert.equal(token, auth.userToken);
          return wallet;
        });
        if (input.action === 'remember') activeLogin = true;
        return route.fulfill({ status: result.status ?? 200, json: result.body,
          ...(result.cookie ? { headers: { 'Set-Cookie': result.cookie } } : {}) });
      }
      if (input.action === 'otp') return send({ otpToken: 'mock-otp', deviceToken: 'mock-device', deviceEncryptionKey: 'mock-key' });
      assert.equal(input.userToken, auth.userToken);
      if (input.action === 'initialization-status') return send({ wallet });
      assert.equal(input.action, 'sign');
      assert.equal(input.message, challenge);
      assert.equal(input.challengeToken, challengeToken);
      signature = await account.signMessage({ message: challenge });
      await page.evaluate(value => { window.mockCircleSignature = value; }, signature);
      signed = true;
      return send({ challengeId: 'mock-siwe' });
    }
    if (url.pathname === '/api/termul-circle-managed') {
      const input = req.postDataJSON();
      assert.equal(req.headers().authorization, 'Bearer ' + bearer);
      assert.equal(input.userToken, auth.userToken);
      assert.equal(input.walletAddress, undefined);
      assert.equal(verified, true);
      if (/^(lifi|bridge)-/.test(input.action)) {
        transferRequests.push(input.action);
        assert.match(input.action, /^(lifi|bridge)-(status|history)$/);
        if (input.action === 'bridge-status') return send({ bridge: bridgeResult() });
        if (input.action === 'bridge-history') return send({ bridges: [bridgeResult()] });
        const route = { id: 'lifi-fixture', fromChain: 8453, toChain: 10, amount: '10000000',
          status: lifiMined ? 'settled' : 'destination-pending',
          history: [{ chainId: 8453, phase: 'transfer', hash }],
          ...(lifiMined && { destinationHash: lifiHash, received: '9950000' }),
        };
        return send(input.action === 'lifi-status' ? { route } : { routes: [route] });
      }
      if (input.action === 'review') {
        assert.equal(input.kind, 'payment');
        assert.equal(input.invoiceId, id);
        appliedReview = 'hosted-mock-review-' + ++paymentReviews;
        return send({ enabled: true, review: { reviewId: appliedReview, reviewExpiresAt: Date.now() + 90_000, invoiceId: id,
          merchant: external, walletAddress: account.address, contract: external, invoiceAmountUsdc: '0.01', valueUsdc: '0.01',
          maxCostUsdc: '0.004', calldataHash: hash, gasLimit: '100000', maxFeePerGas: '40000000000', priorityFeePerGas: '2000000000' } });
      }
      if (input.action === 'execute') {
        assert.equal(input.reviewId, appliedReview);
        assert.equal(input.confirmed, true);
        if (paymentReviews === 1) return route.fulfill({ status: 409, json: { code: 'CIRCLE_FEE_REVIEW_STALE', error: 'Network fees changed. No transaction was submitted.' } });
        executed = true;
        return send({ challengeId: 'mock-tx', attempt: { status: 'challenge-pending' } });
      }
      assert.equal(input.action, 'status');
      if (executed) settled = await page.evaluate(() => window.mockCircleApproved === true);
      if (settled && paidReports++ < 2) return send({ attempt: { kind: 'payment', merchant: external, invoiceId: id, walletAddress: account.address,
        status: 'receipt-pending' } });
      return send({ attempt: settled ? { kind: 'payment', merchant: external, invoiceId: id, walletAddress: account.address,
        status: 'verified', transactionHash: hash } : null });
    }

    const base = resolve(dist);
    const path = resolve(base, url.pathname === '/' ? 'index.html' : '.' + url.pathname);
    assert.ok(path.startsWith(base + sep));
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
      '.json': 'application/json' }[extname(path)];
    try { return await route.fulfill({ body: await readFile(path), contentType }); }
    catch { return route.abort(); }
  });
  try {
    await page.goto(production);
    const remembered = page.waitForResponse(response => response.url().endsWith('/api/termul-circle-login') &&
      response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'remember');
    await login(page);
    await remembered;
    assert.ok(activeLogin);
    await page.goto(`${production}/?chainId=5042&contract=${contract}&merchant=${external}&invoiceId=${id}`);
    await waitSelection(page, 'circle');
    assert.equal(await page.evaluate(() => window.termulWallet.session.isAuthenticated()), false);
    await page.locator('#pay-onchain').click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    await page.locator('#circle-review-dialog button[value=continue]').click();
    await page.getByRole('heading', { name: 'Review updated Circle fees' }).waitFor();
    assert.equal(executed, false);
    assert.equal(await page.locator('#sdkIframe').count(), 0);
    await page.locator('#circle-review-dialog button[value=continue]').click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    await page.getByText('Still waiting for confirmation', { exact: true }).waitFor();
    finalized = true;
    await page.getByRole('dialog', { name: 'Payment successful' }).waitFor();
    assert.equal(await page.locator('[data-transaction-explorer]').getAttribute('href'), 'https://explorer.arc.io/tx/' + hash);
    await page.locator(`#payment-view a[href$="/tx/${hash}"]`).first().waitFor();
    assert.equal(await page.evaluate(() => window.termulWallet.session.isAuthenticated()), true);
    assert.ok(executed);
    await page.keyboard.press('Escape');
    await page.locator('#transaction-dialog').waitFor({ state: 'hidden' });
    await page.locator('#payment-invoices').click();
    await page.locator('[data-nav="swap"]:visible').first().click();
    await page.getByRole('tab', { name: 'Any Token' }).click();
    const recovery = page.getByText('Previous Circle transfers', { exact: true });
    await recovery.waitFor();
    assert.equal(await page.locator('#exchange-widget').isVisible(), false);
    assert.equal(await page.locator('#circle-lifi-form').isVisible(), false);
    assert.equal(await page.locator('#circle-bridge-form').isVisible(), false);
    assert.equal(transferRequests.length, 0);
    assert.deepEqual(await page.evaluate(async () => {
      const outcomes = await Promise.allSettled([
        window.termulWallet.circleBridge('review', '10000000'),
        window.termulWallet.circleLifi('execute', {}),
      ]);
      return outcomes.map(outcome => outcome.reason?.message);
    }), Array(2).fill('New Circle transactions are available on Arc Mainnet only.'));
    assert.equal(transferRequests.length, 0);
    await recovery.click();
    await page.getByText('Arc burn confirmed. Waiting for a finalized Base mint.').waitFor();
    await page.getByText('Source confirmed. Waiting for independent destination proof.').waitFor();
    assert.equal(await page.locator('#circle-lifi-form').isVisible(), false);
    assert.equal(await page.locator('#circle-bridge-form').isVisible(), false);
    assert.equal(await page.getByRole('link', { name: 'Base mint' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'OP Mainnet · Destination' }).count(), 0);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(production);
    await waitSelection(page, 'circle');
    await page.waitForFunction(() => window.termulWallet.session.isAuthenticated());
    await page.locator('[data-nav="swap"]:visible').first().click();
    await page.getByRole('tab', { name: 'Any Token' }).click();
    await recovery.click();
    await page.getByRole('button', { name: 'Check LI.FI history' }).click();
    await page.getByText('Source confirmed. Waiting for independent destination proof.').waitFor();
    bridgeMined = lifiMined = true;
    await page.getByRole('button', { name: 'Check status and history' }).click();
    await page.getByRole('button', { name: 'Check LI.FI history' }).click();
    await page.getByText('Received 9.945 USDC on Base.').waitFor();
    await page.getByText('Received 9.95 USDC.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Base mint' }).getAttribute('href'), 'https://basescan.org/tx/' + bridgeBaseHash);
    assert.equal(await page.getByRole('link', { name: 'OP Mainnet · Destination' }).getAttribute('href'),
      'https://optimistic.etherscan.io/tx/' + lifiHash);
    assert.ok(transferRequests.every(action => /^(lifi|bridge)-(status|history)$/.test(action)));
    console.log('Hosted Circle Chromium PASS: new cross-chain actions blocked, desktop and mobile recovery preserved after refresh.');

    console.log('Hosted Circle Chromium PASS: opt-in artifact, original SIWE API, native approval and authenticated managed payment with mocks.');
  } finally { await context.close(); }
}

async function checkStablecoinSwap(direction, viewport, { reload = false } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', isMobile: reload, hasTouch: reload });
  try {
    const { page, counts, finalizeSwap } = await prepare(context, { delayedSwap: true });
    const openSwap = () => page.locator('[data-nav="swap"]:visible').first().click();
    await page.goto(origin);
    await login(page);
    await openSwap();
    if (direction === 'EURC') await page.locator('#swap-direction').click();
    await page.waitForFunction(() => document.querySelector('[data-swap="input-balance"]').textContent === '10');
    await page.locator('#swap-input').fill('1');
    await page.getByRole('button', { name: 'Review Circle swap' }).click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    const terms = page.locator('#circle-swap-review-terms');
    await terms.waitFor();
    const destination = direction === 'EURC' ? 'USDC' : 'EURC';
    assert.match(await terms.textContent(), new RegExp(`Send1 ${direction}.*Minimum received0.9 ${destination}`, 's'));
    assert.match(await terms.textContent(), /Exchange rate1 .+0\.91/);
    assert.match(await terms.textContent(), /Price impact0\.1%/);
    assert.match(await terms.textContent(), /Maximum swap network fee0\.004 USDC/);
    assert.equal(await page.locator('[data-swap="impact"]').textContent(), '0.1%');
    await page.locator('#circle-review-dialog button[value=cancel]').click();
    assert.equal(counts().swapSubmissions, 0);
    await page.getByRole('button', { name: 'Review Circle swap' }).click();
    await page.locator('#circle-review-dialog button[value=continue]').click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    await page.locator('[data-swap="status"]').filter({ hasText: /Waiting for verified Arc settlement/ }).waitFor();
    assert.equal(counts().swapSubmissions, 1);
    if (reload) {
      await page.reload();
      await waitSelection(page, 'circle');
      await openSwap();
      await page.getByRole('button', { name: 'Check Circle swap status' }).waitFor();
    }
    finalizeSwap();
    if (reload) await page.getByRole('button', { name: 'Check Circle swap status' }).click();
    await page.getByText('Swap Successful!', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('[data-transaction-explorer]').getAttribute('href'), 'https://explorer.arc.io/tx/' + hash);
    assert.equal(await page.locator('[data-transaction-received]').textContent(), '0.9095 ' + destination);
    await page.locator('[data-transaction-done]').click();
    const link = page.getByRole('link', { name: 'Swap on Arc Explorer' });
    await link.waitFor();
    assert.equal(await link.getAttribute('href'), 'https://explorer.arc.io/tx/' + hash);
    assert.equal(counts().swapSubmissions, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await context.close();
  }
}

async function checkCircleAllowanceReset() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const { page, counts, finalizeSwap } = await prepare(context, { allowanceReset: true, delayedSwap: true });
    const openSwap = () => page.locator('[data-nav="swap"]:visible').first().click();
    const reviewTitle = page.locator('#circle-review-title');
    const terms = page.locator('#circle-swap-review-terms');
    const progress = page.locator('#circle-swap-progress');
    const authorize = async () => {
      await page.locator('#circle-review-dialog button[value=continue]').click();
      await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    };
    const waitPending = () => page.locator('[data-swap="status"]').filter({ hasText: /Waiting for verified Arc settlement/ }).waitFor();
    await page.goto(origin);
    await login(page);
    assert.equal(await page.evaluate(() => window.mockCircleTheme.bg), '#101520');
    assert.equal(await page.evaluate(() => window.mockCircleTheme.mainBtnBg), '#65e4d0');
    await openSwap();
    await page.locator('#swap-input').fill('1');
    await page.getByRole('button', { name: 'Review Circle swap' }).click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    await reviewTitle.filter({ hasText: /^Review allowance reset$/ }).waitFor();
    assert.equal(await page.locator('#circle-review-dialog').evaluate(dialog => getComputedStyle(dialog).backgroundColor), 'rgb(16, 21, 32)');
    assert.match(await terms.textContent(), /Router allowance0 USDC/);
    assert.match(await terms.textContent(), /Swap network feeAvailable after the allowance is verified/);
    await authorize();
    await waitPending();
    assert.equal(await page.locator('#transaction-dialog').evaluate(dialog => dialog.open), false);
    finalizeSwap();
    await reviewTitle.filter({ hasText: /^Review token approval$/ }).waitFor({ timeout: 16000 });
    assert.match(await progress.textContent(), /Allowance reset · Verified on Arc/);
    assert.match(await terms.textContent(), /Router allowance1 USDC/);
    assert.equal(counts().swapSubmissions, 1);
    await authorize();
    await waitPending();
    await page.reload();
    await waitSelection(page, 'circle');
    await openSwap();
    await page.getByRole('button', { name: 'Check Circle swap status' }).waitFor();
    finalizeSwap();
    await reviewTitle.filter({ hasText: /^Review updated swap$/ }).waitFor({ timeout: 16000 });
    assert.equal(counts().swapSubmissions, 2);
    await page.locator('#circle-review-dialog button[value=continue]').click();
    await page.locator('#circle-review-notice').filter({ hasText: /previous terms expired or changed/ }).waitFor();
    assert.equal(await page.locator('#sdkIframe').count(), 0);
    assert.equal(counts().swapSubmissions, 2);
    await terms.getByText('Technical details').click();
    await terms.getByText('0.005123456789 USDC', { exact: true }).waitFor();
    await authorize();
    await waitPending();
    assert.equal(await page.locator('#transaction-dialog').evaluate(dialog => dialog.open), false);
    finalizeSwap();
    await page.getByText('Swap Successful!', { exact: true }).waitFor({ timeout: 16000 });
    assert.equal(counts().swapSubmissions, 3);
  } finally {
    await context.close();
  }
}

async function checkCircleAnyToken() {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  try {
    const { page, counts, finalizeSwap } = await prepare(context, { arcAnyToken: true, delayedSwap: true });
    const openAnyToken = async () => {
      await page.locator('[data-nav="swap"]:visible').first().click();
      await page.getByRole('tab', { name: 'Any Token' }).click();
    };
    await page.goto(origin);
    await login(page);
    await openAnyToken();
    assert.equal(await page.locator('#exchange-widget').isHidden(), true);
    const query = page.getByRole('searchbox', { name: 'Search by name, symbol, or contract address' });
    await page.getByRole('button', { name: /^Choose receive token/ }).click();
    assert.equal(await page.locator('#circle-arc-token-picker').evaluate(dialog => getComputedStyle(dialog).backgroundColor), 'rgb(16, 21, 32)');
    assert.equal(await page.locator('.circle-token-picker-header').evaluate(header => getComputedStyle(header).position), 'sticky');
    await query.fill(lookupToken.address);
    const found = page.getByRole('button', { name: /Address lookup token/ });
    await found.locator('.circle-token-balance').filter({ hasText: '0.00000000001' }).waitFor();
    assert.equal(await found.locator('img').getAttribute('src'), tokenArtwork);
    await found.click();
    await page.getByRole('button', { name: /^Choose send token/ }).click();
    await query.fill('Wrapped Bitcoin');
    await page.getByRole('button', { name: /Circle Wrapped Bitcoin/ }).click();
    assert.equal(counts().catalogReads, 1);
    assert.equal(counts().tokenLookups, 1);
    await page.locator('[data-swap="input-balance"]').filter({ hasText: /^0\.1$/ }).waitFor();
    await page.locator('#swap-input').fill('0.00012345');
    await page.getByRole('button', { name: 'Review Circle swap' }).click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    await page.getByText('No supported Arc route for this pair and amount.').waitFor();
    assert.equal(counts().swapSubmissions, 0);
    await page.locator('#swap-input').fill('0.00012346');
    await page.getByRole('button', { name: 'Review Circle swap' }).click();
    await page.getByText('LI.FI is rate-limiting Circle quotes. Try again later.').waitFor();
    assert.equal(counts().swapSubmissions, 0);
    await page.locator('#swap-input').fill('0.01');
    await page.getByRole('button', { name: 'Review Circle swap' }).click();
    const terms = page.locator('#circle-swap-review-terms');
    await terms.filter({ hasText: /Minimum received0\.199 LOOKUP/ }).waitFor();
    assert.match(await terms.textContent(), /Exchange rate1 cirBTC ≈ 20 LOOKUP/);
    assert.equal(await page.locator('#circle-review-assets img').count(), 2);
    assert.match(await terms.textContent(), /Slippage0\.5%/);
    await page.locator('#circle-review-dialog button[value=cancel]').click();
    assert.equal(counts().swapSubmissions, 0);
    await page.getByRole('button', { name: 'Review Circle swap' }).click();
    await page.locator('#circle-review-dialog button[value=continue]').click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    await page.locator('[data-swap="status"]').filter({ hasText: /Waiting for verified Arc settlement/ }).waitFor();
    await page.reload();
    await waitSelection(page, 'circle');
    await openAnyToken();
    await page.getByRole('button', { name: 'Check Circle swap status' }).waitFor();
    finalizeSwap();
    await page.getByRole('button', { name: 'Check Circle swap status' }).click();
    await page.getByText('Swap Successful!', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-transaction-received]').textContent(), '0.1998 LOOKUP');
    assert.equal(await page.locator('[data-transaction-assets] img').last().getAttribute('src'), tokenArtwork);
    assert.equal(await page.locator('[data-transaction-explorer]').getAttribute('href'), 'https://explorer.arc.io/tx/' + hash);
    assert.equal(counts().swapSubmissions, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('[data-transaction-done]').click();
    await page.getByRole('link', { name: 'Swap on Arc Explorer' }).waitFor();
    await page.locator('button[data-wallet-menu]:visible').first().click();
    await page.locator('#circle-history summary').click();
    const history = page.locator('#circle-history-list li').filter({ hasText: /Any Token swap/ });
    await history.getByText('LOOKUP').waitFor();
    assert.equal(await history.locator('img').last().getAttribute('src'), tokenArtwork);
    await page.locator('#wallet-switch-choice').click();
    await page.getByRole('button', { name: /Mock Browser Wallet/ }).click();
    await waitSelection(page, 'external');
    assert.equal(await page.locator('#circle-arc-exchange').isHidden(), true);
    assert.equal(await page.locator('#exchange-widget').evaluate(element => element.hidden), false);
  } finally {
    await context.close();
  }
}

async function runExistingBrowserChecks() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const { page, counts, formReviews } = await prepare(context);
  await page.goto(origin);
  const remembered = page.waitForResponse(response => response.url().endsWith('/session') &&
    response.request().postDataJSON()?.action === 'remember');
  await login(page);
  await remembered;
  const cookies = await context.cookies();
  assert.equal(cookies.find(cookie => cookie.name === 'termul_circle_local')?.httpOnly, true);
  assert.ok(!JSON.stringify(cookies).includes(auth.userToken));
  await page.reload();
  await waitSelection(page, 'circle');
  assert.equal(counts().otpRequests, 1);
  assert.equal(await page.evaluate(() => window.termulWallet.session.isAuthenticated()), false);
  for (const [kind, decline] of [['app-creation', false], ['payment', true], ['payment', false], ['swap', false]]) {
    await page.evaluate(({ kind, id, external }) => {
      const wallet = window.termulWallet;
      const current = wallet.getSelection();
      window.mockResult = undefined;
      window.mockCircleRejected = false;
      const request = kind === 'swap' ? wallet.sendCircleArcSwap(current, { from: 'USDC', to: 'EURC', amount: '1000000' })
        : wallet.sendManagedInvoice(current, { kind, merchant: external, invoiceId: id, amountBase: '10000000000000000', expiresAt: '1795527572' });
      request.then(result => { window.mockResult = { result }; }, error => { window.mockResult = { message: error.message }; });
    }, { kind, id, external });
    if (kind === 'app-creation') await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
    const summary = page.locator(kind === 'swap' ? '#circle-swap-review-terms' : '#circle-review-details');
    await summary.waitFor();
    const detail = await summary.textContent();
    assert.ok(detail.includes(kind === 'swap' ? 'Maximum swap network fee' : 'Maximum network fee'));
    if (kind === 'payment') assert.ok(detail.includes('Attached value 0.01'));
    await page.locator('#circle-review-dialog button[value=continue]').click();
    await page.frameLocator('#sdkIframe').getByRole('button', { name: decline ? 'Decline' : 'Approve' }).click();
    await page.waitForFunction(() => window.mockResult !== undefined);
    const result = await page.evaluate(() => window.mockResult);
    if (decline) assert.match(result.message, /declined/);
    else assert.equal(typeof result.result === 'string' ? result.result : result.result.transactionHash, hash);
  }
  await page.reload();
  await waitSelection(page, 'circle');
  await page.waitForFunction(() => window.termulWallet.session.isAuthenticated());
  assert.equal(await page.locator('#sdkIframe').count(), 0);
  await page.waitForFunction(hash => window.arusPayApi.getInvoices().some(invoice => invoice.paymentTxHash === hash && invoice.status === 'paid'), hash);
  assert.equal(await page.locator('#wallet-balance').textContent(), '0.192443');
  assert.equal(await page.locator('#wallet-balance').getAttribute('title'), '0.192443614790130545 USDC');
  assert.match(await page.locator('#invoice-sync-status').textContent(), /Showing verified Arc records/);
  assert.equal(await page.locator('#paid-count').textContent(), '1');
  assert.match(await page.locator('#received-total').textContent(), /0\.10/);
  assert.match(await page.locator('#payment-activity-empty').textContent(), /Payment confirmed/);
  assert.equal(await page.locator('#avg-payment-time').textContent(), '0 s');
  await page.locator('[data-nav="create"]:visible').first().click();
  const draft = { '#client-name': 'Fee review fixture', '#client-email': 'payer@example.invalid', '#due-date': '2030-01-01',
    '.item-description': 'Test invoice item', '.item-qty': '1', '.item-price': '0.01' };
  for (const [selector, value] of Object.entries(draft)) await page.locator(selector).first().fill(value);
  await page.locator('#invoice-form button[type="submit"]').click();
  await page.locator('#circle-review-dialog button[value=continue]').click();
  await page.getByRole('heading', { name: 'Review updated Circle fees' }).waitFor();
  assert.equal(await page.locator('#sdkIframe').count(), 0);
  assert.equal(formReviews.length, 2);
  assert.deepEqual(formReviews[0], formReviews[1]);
  await page.locator('#circle-review-dialog button[value=cancel]').click();
  await page.locator('[data-transaction-done]').click();
  for (const [selector, value] of Object.entries(draft)) assert.equal(await page.locator(selector).first().inputValue(), value);
  await page.locator('[data-nav="swap"]:visible').first().click();
  await page.getByRole('tab', { name: 'Any Token' }).click();
  await page.getByText('Any Token is unavailable for Circle Email Wallet in this phase.').waitFor();
  await page.locator('button[data-wallet-menu]:visible').first().click();
  await page.locator('#circle-history summary').click();
  await page.getByText('Invoice payment · Declined').waitFor();
  assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }).includes('mock-circle-user-token')), false);
  await page.locator('#wallet-switch-choice').click();
  await page.getByRole('button', { name: /Mock Browser Wallet/ }).click();
  await waitSelection(page, 'external');
  assert.equal(await page.evaluate(() => window.termulWallet.session.isAuthenticated()), false);
  await page.evaluate(() => window.termulWallet.session.authenticate());
  assert.equal(counts().web3Signatures, 1);
  await page.reload();
  await waitSelection(page, 'external');
  await page.waitForFunction(() => window.termulWallet.session.isAuthenticated());
  assert.equal(counts().web3Signatures, 1);
  await chooseFromAccount(page);
  await page.getByRole('button', { name: 'Continue with Email' }).click();
  await page.locator('#circle-email').fill('browser-fixture@example.invalid');
  await page.locator('#circle-email-form button[type=submit]').click();
  await page.locator('#circle-otp-continue').click();
  await page.frameLocator('#sdkIframe').getByRole('button', { name: 'Approve' }).click();
  await waitSelection(page, 'circle');
  await chooseFromAccount(page);
  await page.getByRole('button', { name: 'Use connected browser wallet' }).click();
  await waitSelection(page, 'external');
  await page.reload();
  await waitSelection(page, 'external');
  assert.deepEqual(operations, ['app-creation', 'payment', 'payment', 'swap']);

  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  const fixture = await prepare(mobile, { managed: false });
  await fixture.page.goto(origin);
  await login(fixture.page);
  assert.equal(await select(fixture.page), 'circle');
  await fixture.page.evaluate(() => {
    const wallet = window.termulWallet;
    if (wallet.getSelection().capabilities.invoice || wallet.getSelection().capabilities.arcSwap) throw new Error('Unexpected live capability');
  });
  assert.equal(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (hostedBuild) await hostedCheck(browser, hostedBuild);
  const externalContext = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
  try {
    const fixture = await prepare(externalContext, { externalPayment: true });
    const checkout = new URL(origin);
    checkout.search = new URLSearchParams({ chainId: '5042', contract: arcNetwork.contractAddress, merchant: account.address, invoiceId: id });
    await fixture.page.goto(checkout.href);
    await fixture.page.locator('#pay-onchain').click();
    await fixture.page.getByRole('button', { name: /Mock Browser Wallet/ }).click();
    await waitSelection(fixture.page, 'external');
    await fixture.page.locator('#pay-onchain').click();
    await fixture.page.getByText('Still waiting for confirmation', { exact: true }).waitFor();
    fixture.finalize();
    await fixture.page.getByRole('dialog', { name: 'Payment successful' }).waitFor();
    assert.equal(await fixture.page.locator('[data-transaction-explorer]').getAttribute('href'), 'https://explorer.arc.io/tx/' + hash);
    assert.equal(fixture.counts().paymentSubmissions, 1);
    await fixture.page.reload();
    await fixture.page.getByRole('heading', { name: 'Paid', exact: true }).waitFor();
    await fixture.page.getByRole('button', { name: 'View transaction status' }).click();
    await fixture.page.getByRole('dialog', { name: 'Payment successful' }).waitFor();
    assert.equal(fixture.counts().paymentSubmissions, 1);
  } finally { await externalContext.close(); }
  console.log('Circle mocked Chromium PASS: desktop and mobile, OTP and restore, independent wallet sessions, invoice review and rejection, Arc swap review and history, financial flags off by default.');
}

try {
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.TERMUL_CHROMIUM, headless: true,
    args: ['--disable-background-networking'] });
  const onboardingOnly = process.env.TERMUL_CIRCLE_BROWSER_ONBOARDING_ONLY === '1';
  if (onboardingOnly) {
    await checkCircleOnboarding();
    console.log('Circle onboarding Chromium PASS: explicit initialization, dismissed setup recovery and returning wallet reuse.');
  } else if (process.env.TERMUL_CIRCLE_BROWSER_ANY_TOKEN_ONLY === '1') {
    await checkCircleAnyToken();
    console.log('Circle Arc Any Token Chromium PASS: dark picker and review, unavailable and rate-limited routes, cancellation, settlement and recovery.');
  } else if (process.env.TERMUL_CIRCLE_BROWSER_ALLOWANCE_ONLY !== '1') {
    if (process.env.TERMUL_CIRCLE_BROWSER_SWAP_ONLY !== '1') {
      await checkCircleOnboarding();
      await runExistingBrowserChecks();
      await checkCircleAnyToken();
    }
    await checkStablecoinSwap('USDC', { width: 1440, height: 900 });
    await checkStablecoinSwap('EURC', { width: 375, height: 812 }, { reload: true });
    console.log('Circle stablecoin Chromium PASS: both directions, desktop and mobile, review cancellation, delayed confirmation and refresh recovery.');
  }
  if (!onboardingOnly && process.env.TERMUL_CIRCLE_BROWSER_ANY_TOKEN_ONLY !== '1') {
    await checkCircleAllowanceReset();
    console.log('Continuous Circle swap Chromium PASS: reset, verified allowance, refresh recovery, renewed fee review and final settlement.');
  }
} finally {
  await browser?.close();
  await vite.close();
}
