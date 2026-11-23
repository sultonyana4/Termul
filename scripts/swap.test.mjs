import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem';
import { arcNetwork } from '../src/arc-network.js';
import {
  FEE_ABI, FLY_ABI, SWAP_ABI, SWAP_ROUTER, SWAP_TOKENS, assertFreshQuote, createQuoteRequest, fetchSwapQuote, parseSwapAmount, parseSwapQuote,
} from '../src/swap-quote.js';
import { createSwapExecution, reviewSwap, spendableAmount, swapLedger, verifySwapRecord } from '../src/swap-execution.js';
import { account, actualOutput, approvalHash, quoteFixture, quotedInput, quotedOutput, recordFixture, settlementFixture, swapHash } from './swap-fixtures.mjs';

const { USDC, EURC } = SWAP_TOKENS;
const context = { from: USDC, to: EURC, amount: quotedInput, account };
const reverse = { ...context, from: EURC, to: USDC };
assert.equal(arcNetwork.id, 5042);
assert.equal(USDC.address, '0x3600000000000000000000000000000000000000');
assert.equal(EURC.address.toLowerCase(), '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1');
assert.equal(USDC.decimals, 6);
assert.equal(EURC.decimals, 6);
assert.equal(arcNetwork.chain.nativeCurrency.decimals, 18);
assert.equal(parseSwapAmount('0.000001'), 1n);
for (const invalid of ['', '0', '-1', '0.0000001', '1e3']) assert.equal(parseSwapAmount(invalid), null);

const raw = quoteFixture(context);
const asQuote = (data = raw, input = context) => parseSwapQuote(data, input, Date.now());
assert.equal(asQuote().providerFee, 25_000n);
assert.equal(asQuote().networkFee, 10_000_000_000_000_000n);
assert.equal(asQuote().priceImpact, '0.12');
assert.equal(asQuote(quoteFixture(reverse), reverse).to, USDC);
assert.throws(() => assertFreshQuote(asQuote(), Date.now() + 31_000), /expired/i);
const address = '0x' + '78'.repeat(20);
for (const corrupt of [
  q => { q.action.slippage = 0.05; }, q => { q.action.toChainId = 1; }, q => { q.action.toToken.address = address; },
  q => { q.action.fromToken.decimals = 18; }, q => { q.action.fromAmount = '1'; },
  q => { q.action.toAddress = address; }, q => { q.transactionRequest.from = address; },
  q => { q.transactionRequest.chainId = 1; }, q => { q.transactionRequest.to = address; },
  q => { q.transactionRequest.value = '0x1'; }, q => { q.estimate.approvalAddress = address; },
  q => { q.estimate.toAmountMin = '1'; }, q => { q.fee = 0.01; },
  q => { q.estimate.feeCosts[0].feeSplit.integratorFee = '1'; },
  q => { q.transactionRequest.data += '00'; },
]) {
  const invalid = structuredClone(raw);
  corrupt(invalid);
  assert.throws(() => asQuote(invalid));
}
for (const change of [
  args => { args[3] = address; }, args => { args[2] = address; }, args => { args[4] -= 1n; },
  args => { args[5][1].approveTo = address; }, args => { args[5][1].fromAmount += 1n; },
  args => {
    const decoded = decodeFunctionData({ abi: FLY_ABI, data: args[5][1].callData });
    decoded.args[0] = '0x01bd0080' + address.slice(2) + decoded.args[0].slice(50);
    args[5][1].callData = encodeFunctionData({ abi: FLY_ABI, ...decoded });
  },
  args => {
    const decoded = decodeFunctionData({ abi: FEE_ABI, data: args[5][0].callData });
    decoded.args[1][0].recipient = address;
    args[5][0].callData = encodeFunctionData({ abi: FEE_ABI, ...decoded });
  },
]) {
  const invalid = structuredClone(raw);
  const decoded = decodeFunctionData({ abi: SWAP_ABI, data: invalid.transactionRequest.data });
  change(decoded.args);
  invalid.transactionRequest.data = encodeFunctionData({ abi: SWAP_ABI, ...decoded });
  assert.throws(() => asQuote(invalid));
}

let url;
const signal = new AbortController().signal;
await fetchSwapQuote(context, signal, async request => { url = new URL(request); return Response.json(raw); });
assert.equal(url.origin + url.pathname, 'https://li.quest/v1/quote');
assert.equal(url.searchParams.get('fee'), '0');
assert.equal(url.searchParams.get('integrator'), null);
assert.equal(url.searchParams.get('allowExchanges'), 'fly');
assert.equal(url.searchParams.get('fromChain'), '5042');
await assert.rejects(fetchSwapQuote(context, signal, async () => new Response(null, { status: 404 })), /No supported route/);

const publishes = [];
const resolvers = new Map();
const load = createQuoteRequest((value, signal) => new Promise(resolve => resolvers.set(value, { resolve, signal })), state => publishes.push(state), 0);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
load('old');
await tick();
load('current');
await tick();
assert.equal(resolvers.get('old').signal.aborted, true);
resolvers.get('current').resolve('fresh');
resolvers.get('old').resolve('stale');
await tick();
assert.deepEqual(publishes.filter(entry => entry.status === 'ready'), [{ status: 'ready', quote: 'fresh' }]);

function harness(options = {}) {
  const context = options.context || { from: USDC, to: EURC, amount: quotedInput, account };
  const quote = asQuote(quoteFixture(context), context);
  let current = { address: account, chainId: 5042, connectorId: 'fixture', revision: 0 };
  const initial = current;
  let allowance = options.allowance ?? quote.amount;
  const sent = [];
  const transactions = new Map();
  const records = new Map();
  const ledger = swapLedger({ getItem: key => records.get(key), setItem: (key, value) => records.set(key, value) });
  const provider = { async request({ method, params }) {
    if (method === 'eth_chainId') return options.walletChain || '0x13b2';
    if (method === 'eth_accounts') return current ? [current.address] : [];
    assert.equal(method, 'eth_sendTransaction');
    const tx = params[0];
    assert.equal(tx.from, account);
    assert.equal(tx.chainId, '0x13b2');
    assert.equal(tx.value, '0x0');
    const approval = tx.to !== SWAP_ROUTER;
    const hash = approval ? approvalHash : swapHash;
    sent.push(tx);
    await options.beforeWalletReturn?.();
    if (options.walletError) throw options.walletError;
    transactions.set(hash, { hash, from: tx.from, to: tx.to, input: tx.data, value: 0n, chainId: 5042 });
    return hash;
  } };
  const wallet = { getSelection: () => current, getProvider: async () => provider };
  const receipt = async ({ hash }) => {
    const status = options.revert ? 'reverted' : 'success';
    if (hash === approvalHash && !options.revert) allowance = quote.amount;
    return { transactionHash: hash, status, logs: hash === swapHash ? options.logs || settlementFixture(context) : [] };
  };
  const client = {
    getChainId: async () => options.rpcChain ?? 5042,
    getGasPrice: async () => 20_000_000_000n,
    getBalance: async () => options.nativeBalance ?? 100n * 10n ** 18n,
    readContract: async ({ functionName }) => {
      if (functionName === 'balanceOf') return options.balance ?? 100_000_000n;
      if (functionName === 'allowance') return allowance;
      if (functionName === 'decimals') return 6;
      if (functionName === 'facetAddress') return address;
      assert.fail(functionName);
    },
    getCode: async () => '0x01',
    estimateGas: async ({ to }) => to === SWAP_ROUTER ? 350_000n : 45_000n,
    waitForTransactionReceipt: options.rpcDown ? async () => { throw new Error('RPC timeout'); } : receipt,
    getTransactionReceipt: receipt,
    getTransaction: async ({ hash }) => transactions.get(hash),
  };
  const execute = createSwapExecution({ client, wallet, ledger, deploymentCheck: options.defaultDeployment ? undefined : async () => {} });
  return { quote, initial, client, execute, ledger, sent, swapAccount: newSelection => { current = newSelection; } };
}

assert.equal(spendableAmount({ native: 1_000_000n * 10n ** 12n, USDC: 1_000_000n }, USDC, 10n ** 17n), 900_000n);
for (const settings of [{}, { context: reverse, allowance: 0n }]) {
  const h = harness(settings);
  const review = await reviewSwap(h.client, h.quote);
  const result = await h.execute(h.quote, review, h.initial);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.received, actualOutput);
  assert.notEqual(result.received, quotedOutput);
  assert.equal(result.spent, quotedInput);
  assert.equal(result.record.hash, swapHash);
  assert.equal(h.ledger.get(account).state, 'done');
  if (review.needsApproval) {
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0].to, EURC.address);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: h.sent[0].data }).args, [SWAP_ROUTER, quotedInput]);
    assert.equal(result.record.approvalHash, approvalHash);
  } else assert.equal(h.sent.length, 1);
}

for (const options of [{ balance: 0n }, { nativeBalance: 0n }, { rpcChain: 1 }]) {
  const h = harness(options);
  await assert.rejects(reviewSwap(h.client, h.quote), /Insufficient|network fee|Arc Mainnet/);
  assert.equal(h.sent.length, 0);
}
for (const options of [{ walletChain: '0x1' }, { defaultDeployment: true }]) {
  const h = harness(options);
  await assert.rejects(h.execute(h.quote, await reviewSwap(h.client, h.quote), h.initial), /Arc/);
  assert.equal(h.sent.length, 0);
}
const expired = harness();
await assert.rejects(expired.execute({ ...expired.quote, expiresAt: 0 }, {}, expired.initial), /expired/i);
const disconnected = harness();
disconnected.swapAccount(null);
await assert.rejects(disconnected.execute(disconnected.quote, {}, disconnected.initial), /changed/);

for (const [options, expected] of [
  [{ walletError: Object.assign(new Error('Declined'), { code: 4001 }) }, 'rejected'],
  [{ walletError: new Error('Unknown result') }, 'pending'],
  [{ revert: true }, 'reverted'],
  [{ allowance: 0n, revert: true }, 'reverted'],
  [{ rpcDown: true }, 'pending'],
  [{ logs: [] }, 'pending'],
  [{ logs: settlementFixture(context, 1n) }, 'pending'],
]) {
  const h = harness(options);
  const prepared = await reviewSwap(h.client, h.quote);
  const result = await h.execute(h.quote, prepared, h.initial);
  assert.equal(result.status, expected);
  assert.equal(h.sent.length, 1);
  if (expected === 'pending') await assert.rejects(h.execute(h.quote, prepared, h.initial), /previous swap/);
  if (options.rpcDown) assert.equal((await verifySwapRecord(h.client, h.ledger.get(account))).status, 'confirmed');
}

const changed = harness({ allowance: 0n });
await assert.rejects(changed.execute(changed.quote, await reviewSwap(changed.client, changed.quote), changed.initial, ({ stage }) => {
  if (stage === 'approved') changed.swapAccount({ ...changed.initial, address });
}), /changed/);
assert.equal(changed.sent.length, 1);

let complete;
const called = new Promise(resolve => { complete = resolve; });
let unlock;
const blocked = new Promise(resolve => { unlock = resolve; });
const duplicate = harness({ beforeWalletReturn: () => { complete(); return blocked; } });
const terms = await reviewSwap(duplicate.client, duplicate.quote);
const first = duplicate.execute(duplicate.quote, terms, duplicate.initial);
await called;
await assert.rejects(duplicate.execute(duplicate.quote, terms, duplicate.initial), /already/);
unlock();
assert.equal((await first).status, 'confirmed');
assert.equal(duplicate.sent.length, 1);
const wrongData = recordFixture(context, '0x55');
assert.equal((await verifySwapRecord(duplicate.client, wrongData)).status, 'pending');

console.log('Arc pair, quote race, route validation, fees, wallet changes, allowance, rejection, revert, recovery and exact settlement passed.');
