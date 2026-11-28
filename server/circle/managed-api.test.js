import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, keccak256 } from 'viem';
import { TERMUL_MAINNET } from '../../supabase/functions/_shared/termul-mainnet.js';
import { invoiceAbi } from '../../experiments/circle-wallet-poc/managed-preflight.js';
import { createManagedCircleApi } from './managed-api.js';
import { createCircleStore, hash } from './postgrest.js';
import { reconcilePendingCircleAttempts } from './reconcile.js';

const walletAddress = '0x' + '12'.repeat(20);
const merchant = '0x' + '13'.repeat(20);
const walletId = '11111111-1111-4111-8111-111111111111';
const challengeId = '22222222-2222-4222-8222-222222222222';
const token = 'ab'.repeat(32);
const invoiceId = '0x' + '22'.repeat(32);
const hashValue = '0x' + '33'.repeat(32);
const blockHash = '0x' + '44'.repeat(32);
const creation = { action: 'review', kind: 'app-creation', invoiceId, expiresAt: '1800000900', amountBase: '10000000000000000' };
const payment = { action: 'review', kind: 'payment', invoiceId, merchant };
const clock = 1_800_000_000_000;
const runtime = '0x6000';
const network = { ...TERMUL_MAINNET, runtimeHash: keccak256(runtime) };

function request(input, { origin = 'https://termul.xyz', bearer = token } = {}) {
  const headers = { 'content-type': 'application/json', origin, ...(bearer && { authorization: 'Bearer ' + bearer }) };
  return new Request('https://termul.xyz/api/termul-circle-managed', {
    method: 'POST', headers, body: JSON.stringify({ userToken: 'mock-circle-user-token', ...input }),
  });
}

function fixture() {
  let record, sent, tx, receipt, readAt = [], executed = 0, authorized = true, address = walletAddress;
  let tip = '2';
  const reviews = new Map();
  const invoice = { status: 1, merchant, amount: 10_000_000_000_000_000n, expiresAt: 1_800_000_900n };
  let block = 33_000_000n, finalized = true, canonicalHash = blockHash;
  const arc = {
    getChainId: async () => 5042,
    getCode: async ({ address: at, blockNumber }) => at !== network.contractAddress || blockNumber === network.deploymentBlock - 1n ? undefined : runtime,
    getBlock: async ({ blockTag, blockNumber } = {}) => ({ timestamp: BigInt(clock / 1000),
      number: blockNumber ?? (blockTag === 'finalized' && !finalized ? block - 1n : block), hash: canonicalHash }),
    readContract: async ({ args, blockNumber }) => {
      readAt.push(blockNumber);
      if (args[1] !== invoiceId || args[0] === walletAddress) return { status: 0 };
      return { ...invoice };
    },
    getBalance: async () => 10n ** 18n,
    request: async ({ method }) => ({ eth_call: '0x', eth_estimateGas: '0x16972', eth_gasPrice: '0x5d21dba00' })[method],
    getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt,
  };
  const circle = {
    listWallets: async ({ userToken }) => {
      if (userToken === 'expired') throw Object.assign(new Error('secret'), { code: 155104 });
      return { data: { wallets: [{ id: walletId, address, blockchain: 'ARC', accountType: 'EOA', state: 'LIVE' }] } };
    },
    estimateContractExecutionFee: async () => ({ data: { medium: { gasLimit: '124915', maxFee: '40', priorityFee: tip } } }),
    createUserTransactionContractExecutionChallenge: async input => {
      assert.equal(record.status, 'requesting');
      assert.ok(!JSON.stringify(record).includes('mock-circle'));
      executed++;
      sent = input;
      return { data: { challengeId } };
    },
    getUserChallenge: async () => ({ data: { challenge: { id: challengeId, type: 'CONTRACT_EXECUTION', status: 'COMPLETE' } } }),
    listTransactions: async () => ({ data: { transactions: [{
      id: '33333333-3333-4333-8333-333333333333', walletId, blockchain: 'ARC', operation: 'CONTRACT_EXECUTION',
      refId: record.idempotencyKey, sourceAddress: walletAddress,
    }] } }),
    getTransaction: async ({ id }) => ({ data: { transaction: {
      id, walletId, blockchain: 'ARC', operation: 'CONTRACT_EXECUTION', refId: record.idempotencyKey, txHash: hashValue, state: 'COMPLETE',
    } } }),
  };
  const store = {
    session: async value => value === token && authorized ? { wallet_address: walletAddress, verified_at: new Date(clock).toISOString() } : null,
    rate: async () => true,
    reviews: {
      set(owner, review) { reviews.set(review.reviewId, { owner, review }); },
      get(owner, key) { const found = reviews.get(key); if (found?.owner === owner) return found.review; },
      forget(owner, key) { if (reviews.get(key)?.owner === owner) reviews.delete(key); },
    },
    journal: {
      latest: async () => record,
      history: async () => record ? [record] : [],
      reserve(attempt, { owner, reviewId, sessionHash }) {
        assert.equal(sessionHash, hash(token));
        if (!authorized || record || reviews.get(reviewId)?.owner !== owner) return false;
        reviews.delete(reviewId);
        record = attempt;
        return true;
      },
      update(before, change) {
        if (record === before) record = { ...record, ...change };
        return record;
      },
      due: async () => record && record.status !== 'verified' ? [record] : [],
      purgeExpired: async () => {},
    },
  };
  return { circle, arc, store, setWallet: next => { address = next; }, revoke: () => { authorized = false; },
    count: () => executed, getRecord: () => record, readAt, requestBody: () => sent,
    setFinality: (isFinal, hash = blockHash) => { finalized = isFinal; canonicalHash = hash; },
    setTip: value => { tip = value; },
    build: options => createManagedCircleApi({ circle, arc, store, network, now: () => clock, enabled: true, ...options }),
    settle() {
      block++;
      invoice.status = 2;
      tx = { hash: hashValue, blockHash, blockNumber: block, chainId: network.id, type: 'eip1559', from: walletAddress,
        to: network.contractAddress, value: invoice.amount, input: sent.callData, gas: BigInt(record.gasLimit),
        maxFeePerGas: BigInt(record.maxFeePerGas), maxPriorityFeePerGas: BigInt(record.priorityFeePerGas) };
      const args = { invoiceId, merchant, payer: walletAddress };
      receipt = { status: 'success', transactionHash: hashValue, blockHash, blockNumber: block, gasUsed: 91000n,
        effectiveGasPrice: 32_000_000_000n, logs: [{ address: network.contractAddress, transactionHash: hashValue,
          topics: encodeEventTopics({ abi: invoiceAbi, eventName: 'InvoicePaid', args }),
          data: encodeAbiParameters([{ type: 'uint256' }], [invoice.amount]),
        }] };
    },
  };
}

test('managed API is disabled by default and refuses execution without opt-in, correct origin and active SIWE session', async () => {
  const f = fixture();
  assert.equal((await createManagedCircleApi({})(request(creation))).status, 404);
  const api = f.build();
  assert.equal((await api(request(creation, { origin: 'https://example.invalid' }))).status, 403);
  assert.equal((await api(request(creation, { bearer: '' }))).status, 401);
  assert.equal((await api(request({ ...creation, rawCalldata: '0xinvalid' }))).status, 400);
  assert.equal((await api(request({ ...creation, kind: 'call' }))).status, 400);
  assert.equal((await api(request({ action: 'execute', reviewId: challengeId, confirmed: true }))).status, 403);
  assert.equal((await api(request({ ...payment, userToken: 'expired' }))).status, 401);
  f.setWallet(merchant);
  assert.equal((await api(request(payment))).status, 403);
  f.revoke();
  assert.equal((await api(request(payment))).status, 401);
  assert.equal(f.count(), 0);
});

test('hosted Circle swap requires an explicit server fee ceiling while status remains available', async () => {
  const f = fixture();
  const handler = f.build({ allowExecution: true, allowArcSwap: true });
  const review = await handler(request({ action: 'swap-review', from: 'USDC', to: 'EURC', amount: '100000' }));
  assert.equal(review.status, 503);
  assert.equal((await review.json()).code, 'CIRCLE_SWAP_FEE_NOT_CONFIGURED');
  const status = await handler(request({ action: 'swap-status' }));
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { attempt: null });
  assert.equal(f.count(), 0);
});

test('hosted Any Token denies non-Arc request parameters and requires its own admission flag', async () => {
  const f = fixture();
  const handler = f.build({ allowExecution: true, allowArcSwap: true, maxArcSwapNetworkFeeUsdc: '0.08' });
  const review = { action: 'swap-review', anyToken: true, from: 'USDC', to: 'WETH', amount: '100000' };
  assert.equal((await handler(request({ ...review, toChain: 8453 }))).status, 400);
  assert.equal((await handler(request(review))).status, 403);
  assert.equal(f.count(), 0);
});

test('hosted payment invalidates a stale review across handler instances and requires a new confirmation', async () => {
  const f = fixture();
  const build = () => f.build({ allowExecution: true });
  const first = (await (await build()(request(payment))).json()).review;
  const execute = { action: 'execute', reviewId: first.reviewId, confirmed: true };
  f.setTip('4');
  const response = await build()(request(execute));
  assert.equal(response.status, 409);
  const stale = await response.json();
  assert.equal(stale.code, 'CIRCLE_FEE_REVIEW_STALE');
  assert.deepEqual(stale.feeChanges, [{ field: 'priorityFeePerGas', reviewed: '3000000000', current: '4000000000' }]);
  assert.equal(f.getRecord(), undefined);
  assert.equal(f.count(), 0);
  const replacement = (await (await build()(request(payment))).json()).review;
  assert.notEqual(replacement.reviewId, first.reviewId);
  assert.equal(replacement.calldataHash, first.calldataHash);
  assert.equal(replacement.valueUsdc, first.valueUsdc);
  assert.equal((await build()(request({ ...execute, reviewId: replacement.reviewId, confirmed: false }))).status, 403);
  assert.equal((await build()(request(execute))).status, 409);
  assert.equal((await build()(request({ ...execute, reviewId: replacement.reviewId }))).status, 200);
  assert.equal(f.count(), 1);
});

test('durable invoice reviews survive handler restart and simultaneous payment execution reserves once', async () => {
  const f = fixture();
  const prepared = await f.build({ allowExecution: true })(request(payment));
  assert.equal(prepared.status, 200);
  const { review } = await prepared.json();
  assert.equal(review.valueUsdc, '0.01');
  assert.ok(Number(review.maxCostUsdc) <= 0.01);
  const execute = { action: 'execute', reviewId: review.reviewId, confirmed: true };
  const races = await Promise.all([1, 2].map(() => f.build({ allowExecution: true })(request(execute))));
  assert.deepEqual(races.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.requestBody().amount, '0.01');
  assert.equal(f.count(), 1);
  assert.ok(!JSON.stringify(f.getRecord()).includes('mock-circle-user-token'));
  const poll = await f.build()(request({ action: 'status' }));
  assert.notEqual((await poll.json()).attempt.status, 'verified');
  f.settle();
  f.setFinality(false);
  assert.equal((await (await f.build()(request({ action: 'status' }))).json()).attempt.status, 'receipt-pending');
  f.setFinality(true, '0x' + 'aa'.repeat(32));
  assert.equal((await (await f.build()(request({ action: 'status' }))).json()).attempt.status, 'verification-pending');
  f.setFinality(true);
  const verified = await f.build()(request({ action: 'status' }));
  const { attempt } = await verified.json();
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.verificationSource, 'circle-reference-and-arc');
  assert.ok(f.readAt.includes(BigInt(attempt.blockNumber)));
  const history = await f.build()(request({ action: 'history' }));
  assert.deepEqual((await history.json()).attempts.map(item => item.transactionHash), [hashValue]);
});

test('background reconciliation preserves unresolved results when RPC evidence is absent', async () => {
  const record = { status: 'ambiguous', kind: 'payment', chainId: 5042, invoiceId, merchant, walletAddress };
  const mutations = [];
  assert.deepEqual(await reconcilePendingCircleAttempts({
    arc: { getChainId: async () => 5042, getCode: async ({ blockNumber }) => blockNumber === network.deploymentBlock - 1n ? undefined : '0x1234' },
    journal: { due: async () => [], update: async (...args) => mutations.push(args), purgeExpired: async () => {} },
  }), { checked: 0, resolved: 0, unavailable: 0 });
  await assert.rejects(reconcilePendingCircleAttempts({
    arc: { getChainId: async () => 1 },
    journal: { due: async () => [record], update: async (...args) => mutations.push(args), purgeExpired: async () => {} },
  }), /cannot be verified/);
  assert.deepEqual(mutations, []);
});

test('PostgREST scopes ownership using a hashed token and uses atomic reserve and compare-and-set RPCs', async () => {
  const calls = [];
  const store = createCircleStore({ url: 'https://placeholder.supabase.co', serviceKey: 'mock-persistence-key',
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return Response.json(calls.length === 1 ? [{ wallet_address: walletAddress }] : true);
    }, now: () => clock });
  assert.equal((await store.session(token)).wallet_address, walletAddress);
  assert.equal(calls[0].url.searchParams.get('token_hash'), 'eq.' + hash(token));
  assert.equal(calls[0].url.searchParams.get('revoked_at'), 'is.null');
  assert.ok(!calls[0].url.href.includes(token));
  const record = { status: 'requesting', idempotencyKey: challengeId };
  await store.journal.reserve(record, { owner: hash('synthetic'), reviewId: challengeId, sessionHash: hash(token) });
  await store.journal.update(record, { status: 'ambiguous' });
  assert.match(calls[1].url.pathname, /\/rpc\/termul_circle_reserve_v1$/);
  assert.equal(JSON.parse(calls[1].options.body).p_session, hash(token));
  assert.deepEqual(JSON.parse(calls[2].options.body), { p_before: record, p_after: { ...record, status: 'ambiguous' } });
  assert.equal(calls[2].options.redirect, 'error');
  assert.throws(() => createCircleStore({ url: 'http://placeholder.supabase.co', serviceKey: 'mock' }), /HTTPS/);
});

test('reviewable SQL defaults to deny and locks review consumption and duplicate payments', async () => {
  const sql = await readFile(new URL('../../supabase/migrations/20261124142000_termul_circle_managed_v1.sql', import.meta.url), 'utf8');
  assert.match(sql, /termul_circle_reviews enable row level security/);
  assert.match(sql, /termul_circle_attempts enable row level security/);
  assert.match(sql, /revoke all .* from public, anon, authenticated, service_role/);
  assert.match(sql, /termul_circle_payment_pending[\s\S]+where payment_key is not null/);
  assert.match(sql, /for share;/);
  assert.match(sql, /for update;/);
  assert.match(sql, /on conflict do nothing/);
});

test('hosted CCTP recovery remains scoped to the Arc owner when admission is disabled', async () => {
  const f = fixture();
  f.store.bridges = {
    async latest(address) {
      assert.equal(address.toLowerCase(), walletAddress);
      return { id: challengeId, details: { walletId, amount: '10000000', status: 'ready', history: [],
        review: { sessionHash: 'internal', data: 'internal' } } };
    },
  };
  const readOnly = f.build({ allowExecution: true });
  const enabled = f.build({ allowExecution: true, allowBridge: true }); // A stale admission option cannot reopen the route.
  assert.equal((await readOnly(request({ action: 'bridge-review', amount: '10000000' }))).status, 403);
  assert.equal((await enabled(request({ action: 'bridge-execute', reviewId: challengeId, confirmed: true }))).status, 403);
  assert.equal((await enabled(request({ action: 'bridge-review', amount: '10000000', data: '0x' }))).status, 400);
  assert.equal((await enabled(request({ action: 'bridge-status' }, { origin: 'https://example.invalid' }))).status, 403);
  const response = await f.build()(request({ action: 'bridge-status' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).bridge.review, undefined);
  f.setWallet(merchant);
  assert.equal((await enabled(request({ action: 'bridge-status' }))).status, 403);
  assert.equal(f.count(), 0);
});

test('hosted LI.FI rejects new admission and projects only the verified wallet’s route history', async () => {
  const f = fixture();
  f.store.lifi = {
    async latest(owner) {
      assert.equal(owner.toLowerCase(), walletAddress);
      return { id: challengeId, details: { status: 'ready', amount: '10000000', walletId, review: { data: 'raw-plan' } } };
    },
    async history(owner) { return [await this.latest(owner), { id: 'other', details: { walletId: 'other' } }]; },
  };
  const disabled = f.build({ allowExecution: true });
  const enabled = f.build({ allowExecution: true, allowLifi: true });
  assert.equal((await disabled(request({ action: 'lifi-review', fromChain: 8453, toChain: 10, amount: '10000000' }))).status, 403);
  assert.equal((await enabled(request({ action: 'lifi-review', fromChain: 8453, toChain: 10, amount: '10000000', data: '0x' }))).status, 400);
  assert.equal((await enabled(request({ action: 'lifi-review', fromChain: 8453, toChain: 10, amount: '10000000' }))).status, 403);
  assert.equal((await enabled(request({ action: 'lifi-execute', reviewId: challengeId, confirmed: true }))).status, 403);
  assert.equal((await enabled(request({ ...payment, chainId: 8453 }))).status, 400);
  assert.equal((await enabled(request({ action: 'lifi-history' }, { origin: 'https://example.invalid' }))).status, 403);
  const result = await (await f.build()(request({ action: 'lifi-history' }))).json();
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].review, undefined);
  f.revoke();
  assert.equal((await enabled(request({ action: 'lifi-status' }))).status, 401);
  assert.equal(f.count(), 0);
});
