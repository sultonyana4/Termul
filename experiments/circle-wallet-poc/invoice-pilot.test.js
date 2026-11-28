import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TERMUL_MAINNET as termul } from '../../supabase/functions/_shared/termul-mainnet.js';
import { createInvoicePilot } from './invoice-pilot.js';
import { invoiceAbi } from './managed-preflight.js';
import { createOperations } from './operations.js';
import { openPilotJournal } from './pilot-journal.js';

const code = '0x6000';
const network = { ...termul, runtimeHash: keccak256(code) };
const account = privateKeyToAccount(generatePrivateKey());
const wallet = { address: account.address, id: '00000000-0000-4000-8000-000000000001' };
const other = '0x5042000000000000000000000000000000000002';
const challengeId = '00000000-0000-4000-8000-000000000002';
const txId = '00000000-0000-4000-8000-000000000003';
const hash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const userToken = 'synthetic-token-secret-sentinel';
const owner = 'synthetic-owner-secret-sentinel';
const medium = { gasLimit: '124915', maxFee: '48.575', priorityFee: '2', networkFee: '0.00606785' };

function fixture(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'termul-pilot-test-'));
  const path = join(dir, 'attempts.sqlite');
  let journal = openPilotJournal(path);
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  let clock = 1_800_000_000_000;
  const sent = [];
  const queries = [];
  const state = {
    balance: 100_000_000_000_000_000n, chainId: 5042, runtime: code, exists: false,
    challenge: { id: challengeId, type: 'CONTRACT_EXECUTION', status: 'PENDING' },
    medium: { ...medium }, page: null, transaction: null, receipt: null, invoice: null, issued: true,
  };
  const arc = {
    getChainId: async () => state.chainId,
    getCode: async ({ address, blockNumber }) => address.toLowerCase() === wallet.address.toLowerCase() || blockNumber === network.deploymentBlock - 1n
      ? undefined : state.runtime,
    getBlock: async () => ({ timestamp: 1_800_000_000n, number: state.receipt?.blockNumber, hash: state.receipt?.blockHash }),
    getBalance: async () => state.balance,
    request: async ({ method, params }) => {
      if (method === 'eth_gasPrice') return '0x5d21dba00';
      assert.equal(params[0].from, wallet.address);
      assert.equal(params[0].to, termul.contractAddress);
      const payment = params[0].data.startsWith('0xc52f4a67');
      assert.equal(BigInt(params[0].value), payment ? 10_000_000_000_000_000n : 0n);
      assert.ok(payment || params[0].data.startsWith('0x57a70840'));
      assert.deepEqual(params.slice(1), ['latest']);
      if (method === 'eth_call') return '0x';
      assert.equal(method, 'eth_estimateGas');
      return '0x16972';
    },
    readContract: async ({ functionName, blockNumber }) => {
      assert.equal(functionName, 'getInvoice');
      if (blockNumber !== undefined) return state.invoice;
      return state.paymentInvoice ?? { status: state.exists ? 1 : 0 };
    },
    getTransaction: async () => state.transaction,
    getTransactionReceipt: async () => state.receipt,
  };
  const circle = {
    estimateContractExecutionFee: async request => {
      assert.equal(request.userToken, userToken);
      assert.equal(request.contractAddress, termul.contractAddress);
      assert.deepEqual(request.source, { walletId: wallet.id });
      assert.equal(request.amount, request.callData.startsWith('0xc52f4a67') ? '0.01' : undefined);
      return { data: { medium: state.medium } };
    },
    createUserTransactionContractExecutionChallenge: async request => {
      assert.equal(journal.latest(wallet.address).idempotencyKey, request.idempotencyKey);
      assert.equal(journal.latest(wallet.address).status, 'requesting');
      sent.push(request);
      if (!state.issued) throw new Error('synthetic transport failure');
      return { data: { challengeId } };
    },
    getUserChallenge: async () => ({ data: { challenge: state.challenge } }),
    listTransactions: async params => {
      queries.push(params);
      return state.page ? state.page(params) : { data: { transactions: [] } };
    },
    getTransaction: async ({ id }) => {
      assert.equal(id, txId);
      return { data: { transaction: state.providerTx } };
    },
  };
  const create = () => createInvoicePilot({
    circle, arc, network, journal, enabled: true, now: () => clock, ...opts,
  });
  const auth = { wallet, userToken, owner, authorize() {}, async revalidate() {} };
  return { path, state, sent, queries, arc, circle, auth, create, journal: () => journal,
    advance: ms => { clock += ms; },
    restart: () => { journal.close(); journal = openPilotJournal(path); return create(); } };
}
const prepare = async (pilot, auth) => (await pilot.prepare(auth)).review;
const execute = (pilot, auth, review) => pilot.execute({ ...auth, reviewId: review.reviewId, confirmed: true });

test('execution is disabled by default and requires a literal explicit confirmation', async t => {
  const f = fixture(t, { enabled: false });
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  await assert.rejects(execute(pilot, f.auth, review), { status: 403 });
  assert.equal(f.sent.length, 0);
  const direct = createInvoicePilot({ circle: f.circle, arc: f.arc, journal: f.journal(), network });
  await assert.rejects(execute(direct, f.auth, review), { status: 403 });
  const enabled = createInvoicePilot({ circle: f.circle, arc: f.arc, journal: f.journal(), enabled: true, network });
  await assert.rejects(enabled.execute({ ...f.auth, confirmed: 'true' }), { status: 400 });
});

test('review rejects insufficient balance, high estimates, wrong chain, wrong runtime and duplicate invoice', async t => {
  const f = fixture(t);
  for (const [key, value, message] of [
    ['balance', 0n, /Insufficient native USDC/],
    ['medium', { ...medium, maxFee: '100' }, /0.01 USDC/],
    ['medium', { ...medium, networkFee: '0.010000000000000001' }, /0.01 USDC/],
    ['chainId', 1, /Wrong Arc chain/],
    ['runtime', '0x6001', /Termul runtime/],
    ['exists', true, /already exists/],
  ]) {
    const previous = f.state[key];
    f.state[key] = value;
    await assert.rejects(prepare(f.create(), f.auth), message);
    f.state[key] = previous;
  }
  assert.equal(f.sent.length, 0);
});

test('execution rechecks wallet, expiry, simulation context, fresh fees and funding before reservation', async t => {
  const f = fixture(t);
  let pilot = f.create();
  let review = await prepare(pilot, f.auth);
  await assert.rejects(execute(pilot, { ...f.auth, owner: 'different' }, review), /wallet or invoice changed/);
  await assert.rejects(execute(pilot, { ...f.auth, wallet: { ...wallet, address: other } }, review), /wallet or invoice changed/);
  f.advance(90_000);
  await assert.rejects(execute(pilot, f.auth, review), /review expired/);
  pilot = f.create();
  review = await prepare(pilot, f.auth);
  f.state.medium = { ...medium, maxFee: '65' };
  await assert.rejects(execute(pilot, f.auth, review), { code: 'CIRCLE_FEE_REVIEW_STALE' });
  f.state.medium = { ...medium };
  review = await prepare(pilot, f.auth);
  f.state.balance = 0n;
  await assert.rejects(execute(pilot, f.auth, review), /Insufficient native USDC/);
  assert.equal(f.sent.length, 0);
});

test('small gas and fee changes fit the approved bounds and submit the current tip', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  f.state.medium = { ...medium, gasLimit: '136000', maxFee: '55', priorityFee: '2.8' };
  assert.equal((await execute(pilot, f.auth, review)).challengeId, challengeId);
  assert.deepEqual(f.sent[0].fee.config, { gasLimit: review.gasLimit, maxFee: '60.71875', priorityFee: '2.8' });
  assert.equal(f.journal().latest(wallet.address).priorityFeePerGas, '2800000000');
});

test('an unavailable Arc preflight or Circle fee read never reserves or creates a challenge', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  const request = f.arc.request;
  f.arc.request = async input => {
    if (input.method === 'eth_call') throw Object.assign(new Error('synthetic limit'), { status: 429, headers: new Headers({ 'Retry-After': '120' }) });
    return request(input);
  };
  await assert.rejects(execute(pilot, f.auth, review), { code: 'ARC_PREFLIGHT_RPC', status: 503 });
  f.arc.request = request;
  f.circle.estimateContractExecutionFee = async () => { throw Object.assign(new Error('synthetic Circle limit'), { status: 429 }); };
  await assert.rejects(execute(pilot, f.auth, review), { code: 'CIRCLE_FEE_QUOTE_UNAVAILABLE', status: 503 });
  assert.equal(f.journal().latest(wallet.address), null);
  assert.equal(f.sent.length, 0);
});

test('fee changes invalidate the exact review even if estimates recover, and replacements require explicit confirmation', async t => {
  const f = fixture(t);
  const pilot = f.create();
  for (const [field, changed] of [['gasLimit', { gasLimit: '150000' }], ['maxFeePerGas', { maxFee: '65' }], ['priorityFeePerGas', { priorityFee: '4' }]]) {
    const review = await prepare(pilot, f.auth);
    f.state.medium = { ...medium, ...changed };
    await assert.rejects(execute(pilot, f.auth, review), error => error.code === 'CIRCLE_FEE_REVIEW_STALE' &&
      error.feeChanges.length === 1 && error.feeChanges[0].field === field);
    f.state.medium = { ...medium };
    await assert.rejects(execute(pilot, f.auth, review), /Build a new review/);
  }
  const review = await prepare(pilot, f.auth);
  f.state.medium = { ...medium, maxFee: '100' };
  await assert.rejects(execute(pilot, f.auth, review), { code: 'CIRCLE_FEE_CAP_EXCEEDED' });
  assert.equal(f.journal().latest(wallet.address), null);
  f.state.medium = { ...medium };
  await assert.rejects(execute(pilot, f.auth, review), /Build a new review/);
  const replacement = await prepare(pilot, f.auth);
  assert.notEqual(replacement.reviewId, review.reviewId);
  await assert.rejects(pilot.execute({ ...f.auth, reviewId: replacement.reviewId, confirmed: false }), /Explicit operator confirmation/);
  assert.equal(f.sent.length, 0);
});

test('fee headroom scales within both the native balance and the absolute fee ceiling', async t => {
  const f = fixture(t);
  const pilot = f.create();
  f.state.medium = { ...medium, gasLimit: '150000', maxFee: '60' };
  f.state.balance = parseUnits('0.0099', 18);
  const review = await prepare(pilot, f.auth);
  assert.ok(BigInt(review.gasLimit) > 150_000n);
  assert.ok(BigInt(review.maxFeePerGas) > 60_000_000_000n);
  assert.ok(parseUnits(review.maxCostUsdc, 18) <= f.state.balance);
  assert.equal((await execute(pilot, f.auth, review)).challengeId, challengeId);
});

test('the API rejects injected calldata and requires fresh session proof', async t => {
  const f = fixture(t);
  f.circle.listWallets = async () => ({ data: { wallets: [{ ...wallet, accountType: 'EOA', blockchain: 'ARC', state: 'LIVE' }] } });
  const operations = createOperations({ circle: f.circle, arc: f.arc, pilotOptions: { enabled: true, journal: f.journal(), network } });
  const input = { action: 'pilot-execute', userToken, walletId: wallet.id, walletAddress: wallet.address };
  await assert.rejects(operations({ ...input, calldata: '0x01' }), { status: 400 });
  await assert.rejects(operations({ ...input, amount: '1' }), { status: 400 });
  await assert.rejects(operations({ ...input, confirmed: true }), /fresh local SIWE/);
  await assert.rejects(operations({ ...input, walletAddress: other }), /wallet changed/);
  assert.equal(f.sent.length, 0);
});

test('reviewed absolute fee caps and stable reference are persisted before exactly one request', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  assert.equal(review.invoiceAmountUsdc, '0.01');
  assert.equal(review.valueUsdc, '0');
  assert.equal(review.maxCostUsdc, '0.00872243059375');
  assert.equal((await execute(pilot, f.auth, review)).challengeId, challengeId);
  await assert.rejects(execute(pilot, f.auth, review), /wallet or invoice changed/);
  await assert.rejects(prepare(f.create(), f.auth), /unresolved pilot attempt/);
  const record = f.journal().latest(wallet.address);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], {
    userToken, walletId: wallet.id, contractAddress: termul.contractAddress, callData: review.calldata,
    idempotencyKey: record.idempotencyKey, refId: record.idempotencyKey,
    fee: { type: 'absolute', config: { gasLimit: '143653', maxFee: '60.71875', priorityFee: '2' } },
  });
  assert.match(record.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(record.calldataHash, keccak256(review.calldata));
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(f.path).toString(), /secret-sentinel|userToken|privateKey|signedTransaction/);
  assert.ok(!('calldata' in record));
});

test('ambiguous execution remains locked across restart and persists no fresh request', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  f.state.issued = false;
  const result = await execute(pilot, f.auth, review);
  assert.equal(result.attempt.status, 'ambiguous');
  assert.equal(result.challengeId, undefined);
  const original = f.journal().latest(wallet.address);
  const restarted = f.restart();
  assert.equal((await restarted.status(f.auth)).attempt.status, 'ambiguous');
  await assert.rejects(prepare(restarted, f.auth), /unresolved/);
  assert.equal(f.journal().latest(wallet.address).idempotencyKey, original.idempotencyKey);
  assert.equal(f.sent.length, 1);
});

test('only authoritative Circle rejection and expiry release an attempt with no matching record or invoice', async t => {
  const f = fixture(t);
  const pilot = f.create();
  for (const [challenge, expected] of [
    [{ status: 'FAILED', errorCode: 155701 }, 'rejected'],
    [{ status: 'EXPIRED' }, 'expired'],
  ]) {
    await execute(pilot, f.auth, await prepare(pilot, f.auth));
    f.state.challenge = { id: challengeId, type: 'CONTRACT_EXECUTION', ...challenge };
    const status = await pilot.status(f.auth);
    assert.equal(status.attempt.status, expected);
  }
  assert.equal(f.sent.length, 2);
});

function evidence(review, f) {
  f.state.transaction = {
    from: wallet.address, to: termul.contractAddress, hash, blockHash, blockNumber: 100n,
    chainId: 5042, input: review.calldata, value: 0n, type: 'eip1559',
    gas: BigInt(review.gasLimit), maxFeePerGas: BigInt(review.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(f.journal().latest(wallet.address).priorityFeePerGas),
  };
  f.state.receipt = {
    status: 'success', transactionHash: hash, blockHash, blockNumber: 100n, gasUsed: 92_530n,
    effectiveGasPrice: 30_000_000_000n,
    logs: [{
      address: termul.contractAddress, transactionHash: hash,
      topics: encodeEventTopics({ abi: invoiceAbi, eventName: 'InvoiceCreated', args: { invoiceId: review.invoiceId, merchant: wallet.address } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [10_000_000_000_000_000n, BigInt(review.expiresAt)]),
    }],
  };
  f.state.invoice = { merchant: wallet.address, amount: 10_000_000_000_000_000n, expiresAt: BigInt(review.expiresAt), status: 1 };
}

function providerRecord(f, withHash = true) {
  const attempt = f.journal().latest(wallet.address);
  return {
    id: txId, refId: attempt.idempotencyKey, walletId: wallet.id, blockchain: 'ARC', operation: 'CONTRACT_EXECUTION',
    state: 'COMPLETE', ...(withHash ? { txHash: hash } : {}),
  };
}

test('restart finds an exact paginated reference, waits for hash, then proves receipt and invoice state', async t => {
  const f = fixture(t);
  let pilot = f.create();
  const review = await prepare(pilot, f.auth);
  await execute(pilot, f.auth, review);
  f.state.challenge.status = 'COMPLETE';
  assert.equal((await pilot.status(f.auth)).attempt.status, 'transaction-pending');
  pilot = f.restart();
  f.state.providerTx = providerRecord(f, false);
  f.state.page = ({ pageAfter }) => pageAfter
    ? { data: { transactions: [f.state.providerTx] } }
    : { headers: { link: `<https://api.circle.com/v1/w3s/transactions?pageAfter=${txId}>; rel="next"` },
        data: { transactions: [{ ...f.state.providerTx, refId: 'unrelated' }] } };
  let { attempt } = await pilot.status(f.auth);
  assert.equal(attempt.status, 'hash-pending');
  assert.equal(attempt.transactionId, txId);
  assert.equal(attempt.transactionStatus, 'COMPLETE');
  assert.equal(f.queries.at(-1).pageAfter, txId);
  f.state.providerTx.txHash = hash;
  evidence(review, f);
  ({ attempt } = await pilot.status(f.auth));
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.transactionHash, hash);
  assert.equal(attempt.gasUsed, '92530');
  assert.equal(attempt.costUsdc, '0.0027759');
  assert.equal(f.sent.length, 1);
});

test('Arc verification rejects wrong sender, recipient, calldata, fee caps, receipt events and invoice state', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  await execute(pilot, f.auth, review);
  f.state.providerTx = providerRecord(f);
  f.state.page = () => ({ data: { transactions: [f.state.providerTx] } });
  for (const tamper of [
    () => { f.state.transaction.from = other; },
    () => { f.state.transaction.to = other; },
    () => { f.state.transaction.input = '0x1234'; },
    () => { f.state.transaction.chainId = 1; },
    () => { f.state.transaction.gas++; },
    () => { f.state.transaction.maxFeePerGas++; },
    () => { f.state.receipt.logs = []; },
    () => { f.state.receipt.logs[0].data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [1n, BigInt(review.expiresAt)]); },
    () => { f.state.invoice.status = 2; },
  ]) {
    evidence(review, f);
    tamper();
    assert.equal((await pilot.status(f.auth)).attempt.status, 'verification-failed');
  }
  evidence(review, f);
  f.state.receipt.status = 'reverted';
  assert.equal((await pilot.status(f.auth)).attempt.status, 'reverted');
  assert.equal(f.sent.length, 1);
});

test('installed SDK serializes managed fee caps and documented transaction polling to loopback', async t => {
  const f = fixture(t);
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    received.push({ method: req.method, path: url.pathname, query: url.searchParams, body });
    const listing = url.pathname === '/v1/w3s/transactions';
    const data = req.method === 'POST' ? { challengeId }
      : listing ? { transactions: [providerRecord(f, false)] } : { transaction: providerRecord(f, false) };
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const official = initiateUserControlledWalletsClient({ apiKey: 'TEST:fixture:synthetic', baseUrl: `http://127.0.0.1:${server.address().port}` });
  for (const name of ['createUserTransactionContractExecutionChallenge', 'listTransactions', 'getTransaction']) {
    f.circle[name] = args => official[name](args);
  }
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  assert.equal((await execute(pilot, f.auth, review)).challengeId, challengeId);
  const key = f.journal().latest(wallet.address).idempotencyKey;
  const result = await pilot.status(f.auth);
  assert.equal(result.attempt.transactionId, txId);
  assert.equal(result.attempt.status, 'hash-pending');
  assert.deepEqual(received.map(x => [x.method, x.path]), [
    ['POST', '/v1/w3s/user/transactions/contractExecution'],
    ['GET', '/v1/w3s/transactions'],
    ['GET', '/v1/w3s/transactions/' + txId],
  ]);
  assert.deepEqual(received[0].body, {
    contractAddress: termul.contractAddress, walletId: wallet.id, callData: review.calldata,
    gasLimit: '143653', maxFee: '60.71875', priorityFee: '2', idempotencyKey: key, refId: key,
  });
  assert.equal(received[1].query.get('blockchain'), 'ARC');
  assert.equal(received[1].query.get('operation'), 'CONTRACT_EXECUTION');
  assert.equal(received[1].query.get('walletIds'), wallet.id);
});

test('journal uniqueness is enforced across handles and a lost session receives no challenge handoff', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  let authorized = true;
  const original = f.circle.createUserTransactionContractExecutionChallenge;
  f.circle.createUserTransactionContractExecutionChallenge = async request => {
    const result = await original(request);
    authorized = false;
    return result;
  };
  const auth = { ...f.auth, authorize() { if (!authorized) throw new Error('synthetic session expiry'); } };
  const result = await execute(pilot, auth, review);
  assert.equal(result.challengeId, undefined);
  assert.equal(result.attempt.status, 'challenge-pending');
  const second = openPilotJournal(f.path);
  try {
    const record = second.latest(wallet.address);
    assert.equal(record.challengeId, challengeId);
    assert.equal(second.reserve({ ...record, invoiceId: `0x${'ff'.repeat(32)}` }), false);
  } finally { second.close(); }
  assert.equal(f.sent.length, 1);
});

test('an authenticated synthetic SIWE session can prepare the pilot, and logout clears the review', async t => {
  const f = fixture(t);
  f.circle.listWallets = async () => ({ data: { wallets: [{ ...wallet, accountType: 'EOA', blockchain: 'ARC', state: 'LIVE' }] } });
  f.circle.signMessage = async () => ({ data: { challengeId } });
  const operation = createOperations({
    circle: f.circle, arc: f.arc, origin: 'http://localhost:4173',
    pilotOptions: { enabled: true, journal: f.journal(), network },
  });
  const input = { userToken, walletId: wallet.id, walletAddress: wallet.address };
  async function authenticate() {
    const { message } = await operation({ action: 'sign', userToken });
    const signature = await account.signMessage({ message });
    assert.equal((await operation({ action: 'verify-signature', userToken, message, signature, challengeId })).verified, true);
  }
  await authenticate();
  const first = await operation({ ...input, action: 'pilot-review' });
  await operation({ action: 'logout', userToken });
  await assert.rejects(operation({ ...input, action: 'pilot-execute', reviewId: first.review.reviewId, confirmed: true }), { status: 401 });
  await authenticate();
  const next = await operation({ ...input, action: 'pilot-review' });
  const result = await operation({ ...input, action: 'pilot-execute', reviewId: next.review.reviewId, confirmed: true });
  assert.equal(result.challengeId, challengeId);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token-secret|idempotencyKey|userToken/);
});

test('managed payment uses the onchain amount and independently verifies payer and settlement', async t => {
  const f = fixture(t, { paymentEnabled: true });
  const pilot = f.create();
  const id = '0x' + '99'.repeat(32);
  const payment = { ...f.auth, kind: 'payment', merchant: other, invoiceId: id };
  f.state.paymentInvoice = { merchant: other, amount: 10_000_000_000_000_000n, expiresAt: 1_800_001_000n, status: 1 };
  const review = await prepare(pilot, payment);
  assert.equal(review.valueUsdc, '0.01');
  assert.equal(review.merchant, other);
  await execute(pilot, f.auth, review);
  assert.equal(f.sent[0].amount, '0.01');
  assert.equal(f.sent[0].callData, review.calldata);
  evidence(review, f);
  f.state.invoice = { ...f.state.paymentInvoice, status: 2 };
  f.state.receipt.logs[0] = {
    address: termul.contractAddress, transactionHash: hash,
    topics: encodeEventTopics({ abi: invoiceAbi, eventName: 'InvoicePaid', args: {
      invoiceId: id, merchant: other, payer: wallet.address,
    } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [f.state.invoice.amount]),
  };
  f.state.transaction.value = f.state.invoice.amount;
  const candidate = await pilot.recover({ ...f.auth, hash });
  assert.equal(candidate.attempt.status, 'verified');
  assert.equal(candidate.attempt.verificationSource, 'arc-hash');
  assert.equal(candidate.attempt.invoiceStatusAtReceipt, 2);
  assert.equal(candidate.attempt.transactionId, null);
});

test('managed payment blocks closed and expired invoices, absent funds, and execution by default', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const payment = { ...f.auth, kind: 'payment', merchant: other, invoiceId: '0x' + '99'.repeat(32) };
  const open = { merchant: other, amount: 10_000_000_000_000_000n, expiresAt: 1_800_001_000n, status: 1 };
  for (const status of [0, 2, 3]) {
    f.state.paymentInvoice = { ...open, status };
    await assert.rejects(prepare(pilot, payment), /not open/);
  }
  f.state.paymentInvoice = { ...open, expiresAt: 1_799_999_999n };
  await assert.rejects(prepare(pilot, payment), /expired/);
  f.state.paymentInvoice = open;
  f.state.balance = 10_000_000_000_000_000n;
  await assert.rejects(prepare(pilot, payment), /Insufficient native USDC/);
  f.state.balance = 100_000_000_000_000_000n;
  await assert.rejects(execute(pilot, f.auth, await prepare(pilot, payment)), /disabled/);
  assert.equal(f.sent.length, 0);
});

test('operator provider diagnostics expose only allowed fields and do not rewrite Arc recovery', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  await execute(pilot, f.auth, review);
  evidence(review, f);
  await pilot.recover({ ...f.auth, hash });
  const before = f.journal().latest(wallet.address);
  f.circle.listTransactions = async () => {
    throw { status: 429, code: 155104, message: 'synthetic secret', diagnostic: 'synthetic secret' };
  };
  const result = await pilot.providerStatus(f.auth);
  assert.equal(result.provider[1].stage, 'transaction-list');
  assert.equal(result.provider[1].httpStatus, 429);
  assert.equal(result.provider[1].circleCode, 155104);
  assert.doesNotMatch(JSON.stringify(result), /synthetic secret/);
  assert.deepEqual(f.journal().latest(wallet.address), before);
});

test('automatic Arc recovery resolves a missing Circle reference without resubmitting', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  await execute(pilot, f.auth, review);
  evidence(review, f);
  f.state.paymentInvoice = f.state.invoice;
  const height = network.deploymentBlock + 100n;
  f.state.transaction.blockNumber = height;
  f.state.receipt.blockNumber = height;
  f.arc.getBlock = async () => ({ number: height, timestamp: 1_800_000_000n, hash: f.state.receipt.blockHash });
  f.arc.getLogs = async ({ args, event }) => {
    assert.equal(event.name, 'InvoiceCreated');
    assert.equal(args.invoiceId, review.invoiceId);
    assert.equal(args.merchant, wallet.address);
    return [{ transactionHash: hash }];
  };
  f.circle.listTransactions = async () => { throw new Error('Synthetic Circle history outage'); };
  f.state.transaction.from = other;
  let { attempt } = await pilot.status(f.auth);
  assert.notEqual(attempt.status, 'verified');
  assert.equal(f.sent.length, 1);
  f.state.transaction.from = wallet.address;
  ({ attempt } = await pilot.status(f.auth));
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.transactionHash, hash);
  assert.equal(attempt.verificationSource, 'arc-hash');
  assert.equal(attempt.transactionId, null);
  assert.equal(f.journal().latest(wallet.address).status, 'verified');
  assert.equal(f.sent.length, 1);
});

test('Circle list HTTP 400 falls back to an exact wallet scoped read without submitting', async t => {
  const f = fixture(t);
  const pilot = f.create();
  await execute(pilot, f.auth, await prepare(pilot, f.auth));
  const original = f.circle.listTransactions;
  f.circle.listTransactions = async params => {
    if (params.blockchain) throw Object.assign(new Error('synthetic rejection'), { status: 400 });
    assert.deepEqual(params.walletIds, [wallet.id]);
    assert.equal(params.operation, undefined);
    assert.match(params.xRequestId, /^[a-f0-9-]{36}$/);
    return original(params);
  };
  const result = await pilot.status(f.auth);
  assert.equal(result.attempt.status, 'challenge-pending');
  assert.equal(result.attempt.diagnostic.stage, 'transaction-list-filtered');
  assert.equal(result.attempt.diagnostic.httpStatus, 400);
  assert.doesNotMatch(JSON.stringify(result), /synthetic rejection/);
  assert.equal(f.sent.length, 1);
});

test('an unverified Circle hash remains a hint and does not block exact Arc recovery', async t => {
  const f = fixture(t);
  const pilot = f.create();
  const review = await prepare(pilot, f.auth);
  await execute(pilot, f.auth, review);
  evidence(review, f);
  const wrong = '0x' + '76'.repeat(32);
  f.state.providerTx = { ...providerRecord(f, true), txHash: wrong };
  f.state.page = () => ({ data: { transactions: [f.state.providerTx] } });
  const reported = await pilot.status(f.auth);
  assert.equal(reported.attempt.status, 'verification-failed');
  assert.equal(reported.attempt.transactionHash, null);
  assert.equal(f.journal().latest(wallet.address).providerHash, wrong);
  const { attempt } = await f.restart().recover({ ...f.auth, hash });
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.transactionHash, hash);
  assert.equal(attempt.verificationSource, 'arc-hash');
  assert.equal(f.sent.length, 1);
});
