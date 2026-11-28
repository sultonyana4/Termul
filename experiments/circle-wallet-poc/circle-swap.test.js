import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, keccak256 } from 'viem';
import { ARC_ANY_SWAP_TOKENS, fetchSwapQuote, parseSwapAmount, parseSwapQuote, SWAP_ABI, SWAP_ROUTER, SWAP_TOKENS, swapRate } from '../../src/swap-quote.js';
import { defaultFeePolicy, resolveReleaseFeePolicy } from '../../src/fee-policy.js';
import { account, approvalHash, quoteFixture, settlementFixture, swapHash } from '../../scripts/swap-fixtures.mjs';
import { createCircleSwap } from './circle-swap.js';
import { createCircleAnyTokenQuoteFetcher } from './circle-any-token-quotes.js';
import { openPilotJournal } from './pilot-journal.js';
import { createArcTokenCatalog } from '../../src/circle-arc-tokens.js';

const wallet = { id: '11111111-1111-4111-8111-111111111111', address: account };
const challengeId = '22222222-2222-4222-8222-222222222222';
const blockHash = '0x' + '42'.repeat(32);

function fixture({ initialAllowance = 0n, enabled = true, policy = defaultFeePolicy, journalPath = ':memory:', assetContracts = {} } = {}) {
  let allowance = initialAllowance, fee = '30', balance = 100n * 10n ** 18n, block = 100n, challengeStatus = 'COMPLETE';
  let ambiguous = false, challengeCalls = 0, saved, tx, receipt, chainId = 5042, wrongSender = false, finalized, canonical = blockHash;
  let time = Date.now();
  let tokenBalance = 100n * 10n ** 6n;
  let swapEstimate;
  let simulationReverts = false;
  const journal = openPilotJournal(journalPath);
  const arc = {
    getChainId: async () => chainId,
    getCode: async ({ address }) => assetContracts[address]?.code ?? '0x',
    readContract: async ({ functionName, address }) => functionName === 'allowance' ? allowance : assetContracts[address]?.[functionName] ?? tokenBalance,
    getBalance: async () => balance, getGasPrice: async () => swapEstimate?.rpcPrice ?? 30_000_000_000n,
    estimateGas: async ({ to }) => {
      if (simulationReverts) throw new Error('Synthetic Arc simulation revert');
      return to === SWAP_ROUTER ? swapEstimate?.arcGas ?? 450_000n : 60_000n;
    },
    getBlockNumber: async () => block,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? finalized ?? block, hash: canonical }),
    getLogs: async ({ fromBlock, toBlock }) => receipt?.blockNumber >= fromBlock && receipt.blockNumber <= toBlock ? receipt.logs : [],
    getTransaction: async () => tx, getTransactionReceipt: async () => receipt,
  };
  const circle = {
    estimateContractExecutionFee: async ({ contractAddress }) => ({ data: { medium:
      (contractAddress === SWAP_ROUTER && swapEstimate?.medium) || {
      gasLimit: '75000', maxFee: fee, priorityFee: '2', baseFee: '20',
    } } }),
    createUserTransactionContractExecutionChallenge: async record => {
      challengeCalls++;
      saved = record;
      if (ambiguous) throw new Error('synthetic timeout');
      return { data: { challengeId } };
    },
    listTransactions: async () => ({ data: { transactions: [] } }),
    getUserChallenge: async () => ({ data: { challenge: { id: challengeId, type: 'CONTRACT_EXECUTION', status: challengeStatus,
      ...(challengeStatus === 'FAILED' ? { errorCode: 155701 } : {}) } } }),
  };
  const checkedQuote = async args => {
    const raw = quoteFixture({ ...args, policy });
    if (swapEstimate) raw.transactionRequest.gasLimit = swapEstimate.routeGas;
    return parseSwapQuote(raw, args, time, policy);
  };
  const build = options => createCircleSwap({ arc, circle, journal, enabled, loadPolicy: async () => policy,
    quote: checkedQuote, checkDeployment: async () => {}, now: () => time, ...options });
  const session = { wallet, userToken: 'synthetic', owner: 'one', authorize() {}, revalidate() {} };
  const input = { ...session, from: 'USDC', to: 'EURC', amount: '10000000' };
  const land = ({ phase, at = block + 1n, output }) => {
    const hash = phase === 'approval' ? approvalHash : swapHash;
    const reviewed = journal.latest(wallet.address);
    const code = saved.callData;
    tx = { from: wrongSender ? '0x' + '23'.repeat(20) : account, to: saved.contractAddress, value: 0n, chainId: 5042,
      type: 'eip1559', hash, input: code, blockHash, blockNumber: at, gas: BigInt(reviewed.gasLimit),
      maxFeePerGas: BigInt(reviewed.maxFeePerGas), maxPriorityFeePerGas: BigInt(reviewed.priorityFeePerGas) };
    const logs = phase === 'swap' ? settlementFixture({ from: reviewed.assets?.[0] ?? ARC_ANY_SWAP_TOKENS[reviewed.from],
      to: reviewed.assets?.[1] ?? ARC_ANY_SWAP_TOKENS[reviewed.to],
      amount: BigInt(reviewed.amount), account }, output) : [{
      address: saved.contractAddress, transactionHash: hash,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Approval', args: { owner: account, spender: SWAP_ROUTER } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(reviewed.allowanceValue)]),
    }];
    receipt = { status: 'success', logs, transactionHash: hash, blockNumber: at, blockHash, gasUsed: 50000n, effectiveGasPrice: 25_000_000_000n };
    block = at > block ? at : block;
  };
  return { build, session, input, land, journal, chain: () => { chainId = 1; }, empty: () => { balance = 0n; },
    emptyToken: () => { tokenBalance = 0n; }, setSwapEstimate: estimate => { swapEstimate = estimate; },
    setSimulationRevert: value => { simulationReverts = value; },
    changeFee: value => { fee = value; }, expire: () => { challengeStatus = 'EXPIRED'; }, unset: () => { receipt = tx = undefined; },
    timeout: () => { ambiguous = true; }, calls: () => challengeCalls, saved: () => saved, allow: value => { allowance = value; },
    wrongSender: () => { wrongSender = true; }, finalize: height => { finalized = height; },
    canonical: hash => { canonical = hash; }, advanceTime: ms => { time += ms; }, advanceBlock: height => { block = height; } };
}

test('Circle Arc swap reserves a single challenge, verifies the exact approval, then independently verifies settlement', async t => {
  const f = fixture();
  t.after(() => f.journal.close());
  let adapter = f.build();
  const { review } = await adapter.prepare(f.input);
  assert.equal(review.phase, 'approval');
  assert.equal(review.allowanceValue, f.input.amount);
  await assert.rejects(adapter.execute({ ...f.session, owner: 'other', reviewId: review.reviewId, confirmed: true }), /changed/);
  await assert.rejects(adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: false }), /Explicit/);
  const results = await Promise.allSettled([1, 2].map(() => adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true })));
  assert.equal(results.filter(result => result.value?.challengeId === challengeId).length, 1);
  assert.equal(f.calls(), 1);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: f.saved().callData }).args.map(value => String(value).toLowerCase()),
    [SWAP_ROUTER.toLowerCase(), f.input.amount]);
  assert.equal(f.saved().idempotencyKey, f.saved().refId);
  assert.equal(keccak256(f.saved().callData), review.calldataHash);
  assert.equal(f.saved().fee.type, 'absolute');
  assert.equal((await adapter.status(f.session)).attempt.status, 'transaction-pending');
  f.land({ phase: 'approval', at: 100n });
  assert.equal((await adapter.status(f.session)).attempt.status, 'transaction-pending');
  f.land({ phase: 'approval' });
  adapter = f.build();
  assert.equal((await adapter.status(f.session)).attempt.status, 'verified');

  f.allow(10_000_000n);
  const { review: next } = await adapter.prepare(f.input);
  assert.equal(next.phase, 'swap');
  await adapter.execute({ ...f.session, reviewId: next.reviewId, confirmed: true });
  f.wrongSender();
  f.land({ phase: 'swap' });
  assert.equal((await adapter.status(f.session)).attempt.status, 'receipt-pending');
  assert.equal(f.calls(), 2);
});

test('Circle Arc swap independently proves exact sender, calldata and minimum-out settlement', async t => {
  const f = fixture({ initialAllowance: 10_000_000n });
  t.after(() => f.journal.close());
  const adapter = f.build();
  const { review } = await adapter.prepare(f.input);
  await adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  f.land({ phase: 'swap' });
  const { attempt } = await f.build().status(f.session);
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.received, '9095000');
  assert.equal(attempt.transactionHash, swapHash);
  assert.equal(f.journal.history(account).length, 1);
});

test('Circle Any Token uses exact mixed-decimal approvals and recovers a finalized Arc swap after restart', async t => {
  const policy = resolveReleaseFeePolicy('10', '1');
  const f = fixture({ policy });
  t.after(() => f.journal.close());
  const options = { allowAnyToken: true, maxNetworkFeeUsdc: '0.08' };
  const adapter = f.build(options);
  const selection = { ...f.input, anyToken: true, from: 'cirBTC', to: 'WETH', amount: '1000000' };
  assert.equal(parseSwapAmount('0.01', 8), 1000000n);
  assert.equal(parseSwapAmount('0.000000001', 8), null);
  assert.equal(parseSwapAmount('0.000000000000000001', 18), 1n);
  assert.equal(swapRate(1000000n, 200000000000000000n, 8, 18), '20');
  const submit = review => adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  const { review: approval } = await adapter.prepare(selection);
  assert.equal(approval.allowanceValue, selection.amount);
  assert.equal(approval.integratorFee, '1000');
  await submit(approval);
  assert.equal(f.saved().contractAddress, ARC_ANY_SWAP_TOKENS.cirBTC.address);
  assert.equal(decodeFunctionData({ abi: erc20Abi, data: f.saved().callData }).args[1], 1000000n);
  f.land({ phase: 'approval' });
  assert.equal((await f.build().status(f.session)).attempt.status, 'verified');
  f.allow(1_000_000n);
  const { review: swap } = await adapter.prepare(selection);
  assert.equal(swap.phase, 'swap');
  await submit(swap);
  f.land({ phase: 'swap' });
  const { attempt } = await f.build().status(f.session);
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.anyToken, true);
  assert.equal(attempt.to, 'WETH');
  assert.equal(attempt.received, '9095000');
  assert.equal(attempt.transactionHash, swapHash);
  assert.equal(f.calls(), 2);
});

test('Circle Any Token rejects disabled admission, cross-chain quotes, unknown assets and unavailable routes before reservation', async t => {
  const policy = resolveReleaseFeePolicy('10', '1');
  const f = fixture({ policy });
  t.after(() => f.journal.close());
  const options = { allowAnyToken: true, maxNetworkFeeUsdc: '0.08' };
  const selection = { ...f.input, anyToken: true, to: 'cirBTC' };
  await assert.rejects(f.build().prepare(selection), /Any Token swaps are disabled/);
  await assert.rejects(f.build(options).prepare({ ...selection, to: '0x' + '11'.repeat(20) }), /Invalid Arc token pair/);
  for (const mutate of [
    raw => { raw.action.toChainId = 8453; },
    raw => { raw.action.toToken.decimals = 6; },
    raw => { raw.transactionRequest.value = '0x1'; },
  ]) {
    const adapter = f.build({ ...options, quote: async args => {
      const raw = quoteFixture({ ...args, policy });
      mutate(raw);
      return parseSwapQuote(raw, args, Date.now(), policy);
    } });
    await assert.rejects(adapter.prepare(selection), { status: 422 });
  }
  const unavailable = f.build({ ...options, quote: async () => { throw new Error('No supported route for this amount.'); } });
  await assert.rejects(unavailable.prepare(selection), { status: 422 });
  assert.equal(f.journal.history(account).length, 0);
  assert.equal(f.calls(), 0);
});

test('Circle dynamic catalog caches Arc metadata and verifies exact-address lookup outside the list', async () => {
  const item = { address: '0x' + '31'.repeat(20), chainId: 5042, decimals: 0, symbol: 'DEMO', name: 'Demo token',
    logoURI: 'https://assets.example/token.png' };
  const second = { ...item, address: '0x' + '32'.repeat(20), logoURI: 'javascript:unsafe()' };
  let requests = 0;
  const catalog = createArcTokenCatalog({ fetcher: async url => {
    requests++;
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith('/tokens')) return Response.json({ tokens: { 5042: [item, { ...second, chainId: 8453 }] } });
    if (searchParams.get('token') === second.address) return Response.json(second);
    return Response.json(item);
  } });
  const [a, b] = await Promise.all([catalog.load(), catalog.load()]);
  assert.equal(a, b);
  assert.equal(a.length, 1);
  assert.equal((await catalog.find(item.address)).logoURI, item.logoURI);
  assert.equal((await catalog.find(second.address)).logoURI, undefined);
  assert.equal((await catalog.find(second.address)).symbol, item.symbol);
  assert.equal(await catalog.find('0x' + '33'.repeat(20)), null);
  assert.equal(await catalog.find('0x' + '00'.repeat(20)), null);
  assert.equal(requests, 3);
  assert.equal(parseSwapAmount('1.2', 0), null);
});

test('Circle dynamic catalog checks contract metadata and recovers settled swaps by exact address with duplicate symbols', async t => {
  const address = '0x' + '41'.repeat(20), destination = '0x' + '42'.repeat(20);
  const contract = { symbol: 'DEMO', decimals: 8, name: 'Demo contract', code: '0x6000' };
  const assets = { [address]: { ...contract }, [destination]: { ...contract, decimals: 18 } };
  const policy = resolveReleaseFeePolicy('10', '1');
  const f = fixture({ policy, initialAllowance: 10_000_000n, assetContracts: assets });
  t.after(() => f.journal.close());
  const catalog = { async find(address) {
    return { address, chainId: 5042, decimals: address.endsWith('41') ? 8 : 18, name: 'LI.FI display name',
      symbol: 'DEMO', logoURI: 'https://assets.example/token.png' };
  } };
  const options = { allowAnyToken: true, maxNetworkFeeUsdc: '0.08', catalog };
  const input = { ...f.input, from: address, to: destination, anyToken: true };
  assets[destination].decimals = 6;
  await assert.rejects(f.build(options).prepare(input), /does not match the catalog/);
  assert.equal(f.calls(), 0);
  assets[destination].decimals = 18;
  const adapter = f.build(options);
  const { review } = await adapter.prepare(input);
  assert.deepEqual(review.assets.map(asset => asset.address), [address, destination]);
  await adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  f.land({ phase: 'swap' });
  const { attempt } = await f.build().status(f.session);
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.assets[1].address, destination);
  assert.equal(attempt.assets[1].logoURI, 'https://assets.example/token.png');
  assert.equal(attempt.assets[1].runtimeHash, undefined);
});

test('Circle reverse cirBTC swap accepts LI.FI’s exact rounding while preserving fee and calldata validation', async t => {
  const policy = resolveReleaseFeePolicy('10', '1');
  const f = fixture({ policy });
  t.after(() => f.journal.close());
  const { cirBTC: from, USDC: to } = ARC_ANY_SWAP_TOKENS;
  const amount = parseSwapAmount('0.00000168', from.decimals);
  assert.equal(amount, 168n);
  const input = { from, to, amount, account, anyToken: true };
  const quoteWithoutFeeTransfer = (args, changes = {}) => {
    const raw = quoteFixture({ ...args, policy });
    const { args: [id, integrator, referrer, receiver, , [, fly]] } =
      decodeFunctionData({ abi: SWAP_ABI, data: raw.transactionRequest.data });
    raw.estimate.feeCosts = [];
    raw.estimate.toAmount = '106694';
    raw.estimate.toAmountMin = '106161';
    raw.transactionRequest.data = encodeFunctionData({ abi: SWAP_ABI, functionName: 'swapTokensSingleV3ERC20ToERC20',
      args: [id, integrator, referrer, receiver, 106161n, { ...fly, requiresDeposit: true, ...changes }] });
    return raw;
  };
  const adapter = f.build({ allowAnyToken: true, maxNetworkFeeUsdc: '0.08',
    quote: async args => parseSwapQuote(quoteWithoutFeeTransfer(args), args, Date.now(), policy) });
  const { review } = await adapter.prepare({ ...f.input, anyToken: true, from: from.symbol, to: to.symbol, amount: String(amount) });
  assert.equal(review.feeBps, 10);
  assert.equal(review.integratorFee, '0');
  assert.equal(review.integratorFeeRounded, true);
  assert.equal(review.minimum, '106161');
  assert.equal(review.allowanceValue, '168');
  assert.equal(f.calls(), 0);

  const parse = (raw, args = input) => parseSwapQuote(raw, args, Date.now(), policy);
  assert.throws(() => parse({ ...quoteWithoutFeeTransfer(input), fee: 0 }));
  assert.throws(() => parse(quoteWithoutFeeTransfer(input, { fromAmount: 167n })));
  assert.throws(() => parse(quoteWithoutFeeTransfer(input, { callTo: to.address })));
  const noFeeMetadata = quoteWithoutFeeTransfer(input);
  delete noFeeMetadata.estimate.feeCosts;
  assert.throws(() => parse(noFeeMetadata));
  const chargeable = { ...input, amount: 1000n };
  assert.throws(() => parse(quoteWithoutFeeTransfer(chargeable), chargeable));
  assert.equal(parse(quoteFixture({ ...chargeable, policy }), chargeable).integratorFee, 1n);
});

test('Circle Any Token honors LI.FI Retry-After across token pairs without leaking the optional server credential', async t => {
  const f = fixture({ policy: resolveReleaseFeePolicy('10', '1') });
  t.after(() => f.journal.close());
  let time = Date.now(), requests = 0;
  const anyTokenFetcher = createCircleAnyTokenQuoteFetcher({ apiKey: 'fixture-key', now: () => time,
    fetcher: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://li.quest');
      assert.equal(new URL(url).searchParams.get('fee'), '0.001');
      assert.equal(options.headers.get('x-lifi-api-key'), 'fixture-key');
      assert.equal(options.redirect, 'error');
      return ++requests === 1
        ? Response.json({ message: 'fixture-key' }, { status: 429, headers: { 'Retry-After': '3579' } })
        : Response.json({ message: 'fixture-key' }, { status: 401 });
    } });
  const adapter = f.build({ allowAnyToken: true, maxNetworkFeeUsdc: '0.08', quote: fetchSwapQuote, anyTokenFetcher });
  const review = to => adapter.prepare({ ...f.input, anyToken: true, to });
  await assert.rejects(review('cirBTC'), { status: 429, code: 'CIRCLE_ANY_TOKEN_QUOTE_RATE_LIMIT', message: /about 60 min/ });
  time += 3_578_000;
  await assert.rejects(review('WETH'), { status: 429, message: /about 1 min/ });
  assert.equal(requests, 1);
  time += 1000;
  await assert.rejects(review('WETH'), { status: 503, code: 'CIRCLE_ANY_TOKEN_QUOTE_AUTH', message: /Check the server configuration/ });
  await assert.rejects(anyTokenFetcher('https://other.example/v1/quote?fromChain=5042&toChain=5042'), /Unexpected/);
  assert.equal(requests, 2);
  assert.equal(f.journal.history(account).length, 0);
  assert.equal(f.calls(), 0);
});

test('post-approval review reports exact conflicting Arc and Circle budgets without another challenge', async t => {
  const f = fixture({ policy: resolveReleaseFeePolicy('10', '1') });
  t.after(() => f.journal.close());
  const adapter = f.build();
  const { review } = await adapter.prepare(f.input);
  assert.equal(review.phase, 'approval');
  await adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  f.land({ phase: 'approval' });
  assert.equal((await adapter.status(f.session)).attempt.status, 'verified');
  f.allow(BigInt(f.input.amount));
  f.setSwapEstimate({ arcGas: 449900n, rpcPrice: 25_000_000_000n, routeGas: '580295',
    medium: { gasLimit: '607365', maxFee: '48.850428308', priorityFee: '8.850428308' } });

  await assert.rejects(adapter.prepare(f.input), error => {
    assert.equal(error.code, 'CIRCLE_SWAP_FEE_BUDGET_EXCEEDED');
    assert.match(error.message, /0\.02967004038928842 USDC \(607365 gas × 48\.850428308 gwei\)/);
    assert.match(error.message, /0\.01740885 USDC budget/);
    return true;
  });
  assert.equal(f.calls(), 1);
  assert.equal(f.journal.latest(account).transactionHash, approvalHash);
  assert.equal(f.journal.history(account).length, 1);
});

test('configured Circle ceiling admits an otherwise blocked dynamic fee and sends only the reviewed caps', async t => {
  const f = fixture({ initialAllowance: 10_000_000n, policy: resolveReleaseFeePolicy('10', '1') });
  t.after(() => f.journal.close());
  f.setSwapEstimate({ arcGas: 449900n, rpcPrice: 25_000_000_000n, routeGas: '580295',
    medium: { gasLimit: '607365', maxFee: '48.850428308', priorityFee: '8.850428308' } });
  await assert.rejects(f.build({ maxNetworkFeeUsdc: '0.029' }).prepare(f.input),
    { code: 'CIRCLE_SWAP_FEE_BUDGET_EXCEEDED' });
  assert.equal(f.calls(), 0);
  const adapter = f.build({ maxNetworkFeeUsdc: '0.03' });
  const { review } = await adapter.prepare(f.input);
  assert.equal(review.networkFee, '0.02967004038928842');
  assert.equal(review.integratorFee, '10000');
  await adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  assert.deepEqual(f.saved().fee, { type: 'absolute',
    config: { gasLimit: '607365', maxFee: '48.850428308', priorityFee: '8.850428308' } });
  assert.equal(f.calls(), 1);
});

test('hosted swaps require a valid ceiling and reject stale fees, balances, allowances or a lowered ceiling', async t => {
  const f = fixture({ initialAllowance: 10_000_000n });
  t.after(() => f.journal.close());
  let stored;
  const reviews = {
    set(owner, review) { stored = { owner, review: JSON.parse(JSON.stringify(review)) }; },
    get(owner, id) { return stored?.owner === owner && stored.review.reviewId === id ? stored.review : undefined; },
    forget(owner, id) { if (stored?.owner === owner && stored.review.reviewId === id) stored = undefined; },
  };
  const adapter = cap => f.build({ requireFeeCeiling: true, maxNetworkFeeUsdc: cap, reviews });
  for (const value of [undefined, '0', 'e30', '0.00000000000000000001']) {
    await assert.rejects(adapter(value).prepare(f.input), { code: 'CIRCLE_SWAP_FEE_NOT_CONFIGURED' });
  }
  const { review } = await adapter('0.03').prepare(f.input);
  const execution = { ...f.session, reviewId: review.reviewId, confirmed: true };
  await assert.rejects(adapter('0.01').execute(execution), /exceeds the current/);
  await assert.rejects(adapter('0.03').execute(execution), /review changed/);
  const { review: next } = await adapter('0.03').prepare(f.input);
  f.changeFee('32');
  await assert.rejects(adapter('0.03').execute({ ...execution, reviewId: next.reviewId }), /confirm the new maximum/);
  f.changeFee('30');
  await assert.rejects(adapter('0.03').execute({ ...execution, reviewId: next.reviewId }), /review changed/);
  f.changeFee('32');
  const { review: fresh } = await adapter('0.03').prepare(f.input);
  assert.notEqual(fresh.reviewId, review.reviewId);
  assert.notEqual(fresh.networkFee, review.networkFee);
  await assert.rejects(adapter('0.03').execute({ ...execution, reviewId: fresh.reviewId, confirmed: false }), /Explicit approval/);
  f.allow(0n);
  await assert.rejects(adapter('0.03').execute({ ...execution, reviewId: fresh.reviewId }), /allowance changed/);
  f.allow(10_000_000n);
  f.setSimulationRevert(true);
  await assert.rejects(adapter('0.03').execute({ ...execution, reviewId: fresh.reviewId }), /simulation revert/);
  f.setSimulationRevert(false);
  f.empty();
  await assert.rejects(adapter('0.03').execute({ ...execution, reviewId: fresh.reviewId }), /balance/);
  assert.equal(f.calls(), 0);
});

test('increasing an insufficient nonzero allowance exposes the verified zero reset before a separate exact approval', async t => {
  const f = fixture({ initialAllowance: 5_000_000n });
  t.after(() => f.journal.close());
  const adapter = f.build();
  const { review } = await adapter.prepare(f.input);
  assert.equal(review.allowanceValue, '0');
  const result = await adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  assert.equal(result.attempt.allowanceValue, '0');
  assert.equal(decodeFunctionData({ abi: erc20Abi, data: f.saved().callData }).args[1], 0n);
  f.land({ phase: 'approval' });
  const { attempt } = await f.build().status(f.session);
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.allowanceValue, '0');

  f.allow(0n);
  const { review: next } = await adapter.prepare(f.input);
  assert.equal(next.phase, 'approval');
  assert.equal(next.allowanceValue, f.input.amount);
  assert.equal(f.calls(), 1);
});

test('EURC to USDC tolerates a small fee move and waits for the canonical finalized receipt after restart', async t => {
  const f = fixture({ initialAllowance: 10_000_000n, policy: resolveReleaseFeePolicy('10', '1') });
  t.after(() => f.journal.close());
  const adapter = f.build();
  const { review } = await adapter.prepare({ ...f.input, from: 'EURC', to: 'USDC' });
  assert.equal(review.from, 'EURC');
  assert.equal(review.to, 'USDC');
  assert.equal(review.integratorFee, '10000');
  assert.ok(BigInt(review.received) >= BigInt(review.minimum));
  f.changeFee('31');
  await adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  assert.equal(f.saved().fee.config.maxFee, '31.5');
  f.land({ phase: 'swap' });
  f.finalize(100n);
  assert.notEqual((await f.build().status(f.session)).attempt.status, 'verified');
  f.finalize(101n);
  f.canonical('0x' + '99'.repeat(32));
  assert.equal((await f.build().status(f.session)).attempt.status, 'receipt-pending');
  f.canonical(blockHash);
  const { attempt } = await f.build().status(f.session);
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.transactionHash, swapHash);
  assert.equal(attempt.to, 'USDC');
  assert.equal(f.calls(), 1);
});

test('an expired review creates no challenge and a new review requires explicit reconfirmation', async t => {
  const f = fixture({ initialAllowance: 10_000_000n });
  t.after(() => f.journal.close());
  const adapter = f.build();
  const { review } = await adapter.prepare(f.input);
  f.advanceTime(30_000);
  await assert.rejects(adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true }),
    { code: 'CIRCLE_SWAP_REVIEW_EXPIRED' });
  const { review: fresh } = await adapter.prepare(f.input);
  assert.notEqual(fresh.reviewId, review.reviewId);
  await assert.rejects(adapter.execute({ ...f.session, reviewId: fresh.reviewId, confirmed: false }), /Explicit/);
  assert.equal(f.calls(), 0);
});

test('Circle review labels price impact from reference prices when the quote omits it and never settles below minimum', async t => {
  const f = fixture({ initialAllowance: 10_000_000n });
  t.after(() => f.journal.close());
  const adapter = f.build({ quote: async args => {
    const raw = quoteFixture(args);
    delete raw.estimate.priceImpact;
    raw.action.fromToken.priceUSD = '1.00';
    raw.action.toToken.priceUSD = '1.10';
    return parseSwapQuote(raw, args, Date.now(), defaultFeePolicy);
  } });
  const { review } = await adapter.prepare(f.input);
  assert.equal(review.referenceImpact, true);
  assert.notEqual(review.priceImpact, null);
  await adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  f.land({ phase: 'swap', output: BigInt(review.minimum) - 1n });
  assert.equal((await adapter.status(f.session)).attempt.status, 'receipt-pending');
});

test('delayed recovery searches from the durable reservation even when the receipt is outside the recent tail', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'termul-swap-'));
  const journalPath = join(dir, 'attempts.sqlite');
  let journal;
  const f = fixture({ initialAllowance: 10_000_000n, journalPath });
  t.after(() => {
    (journal ?? f.journal).close();
    rmSync(dir, { recursive: true });
  });
  const adapter = f.build();
  const { review } = await adapter.prepare(f.input);
  await adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  f.land({ phase: 'swap', at: 4200n });
  f.advanceBlock(9000n);
  assert.notEqual((await f.build().status(f.session)).attempt.status, 'verified');
  assert.equal(f.journal.latest(wallet.address).scanFromBlock, '4101');
  f.journal.close();
  journal = openPilotJournal(journalPath);
  assert.equal((await f.build({ journal }).status(f.session)).attempt.transactionHash, swapHash);
  assert.equal(f.calls(), 1);
});

test('Circle Arc swap remains disabled by default and fails closed on wrong network, low balance or changed fees', async t => {
  for (const [setup, validate] of [
    [{ enabled: false }, async f => assert.rejects(f.build().prepare(f.input), /disabled/)],
    [{}, async f => { f.chain(); await assert.rejects(f.build().prepare(f.input), /Wrong Arc/); }],
    [{}, async f => { f.empty(); await assert.rejects(f.build().prepare(f.input), /fee/); }],
    [{}, async f => { f.emptyToken(); await assert.rejects(f.build().prepare(f.input), /Insufficient USDC/); }],
    [{ initialAllowance: 10_000_000n }, async f => {
      const adapter = f.build();
      const { review } = await adapter.prepare(f.input);
      f.changeFee('32');
      await assert.rejects(adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true }), /fees changed/);
    }],
  ]) {
    const f = fixture(setup);
    t.after(() => f.journal.close());
    await validate(f);
    assert.equal(f.calls(), 0);
  }
});

test('Circle Arc swap preserves ambiguous submission across restart and reconciles documented challenge expiry', async t => {
  const f = fixture();
  t.after(() => f.journal.close());
  const adapter = f.build();
  const { review } = await adapter.prepare(f.input);
  f.timeout();
  await adapter.execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  assert.equal((await f.build().status(f.session)).attempt.status, 'ambiguous');
  await assert.rejects(f.build().prepare(f.input), /previous Circle attempt/);
  assert.equal(f.calls(), 1);
  const expired = fixture();
  t.after(() => expired.journal.close());
  const another = expired.build();
  const { review: r } = await another.prepare(expired.input);
  await another.execute({ ...expired.session, reviewId: r.reviewId, confirmed: true });
  expired.expire();
  assert.equal((await another.status(expired.session)).attempt.status, 'expired');
});

test('persisted Arc swap review rehydrates exact calldata and reconciles without retaining the Circle session token', async t => {
  const f = fixture({ initialAllowance: 10_000_000n });
  t.after(() => f.journal.close());
  let stored;
  const reviews = {
    set(owner, review) { stored = { owner, review: JSON.parse(JSON.stringify(review)) }; },
    get(owner, id) { if (stored?.owner === owner && stored.review.reviewId === id) return stored.review; },
  };
  const { review } = await f.build({ reviews }).prepare(f.input);
  assert.equal(review.phase, 'swap');
  assert.doesNotMatch(JSON.stringify(stored), /synthetic/);
  await f.build({ reviews }).execute({ ...f.session, reviewId: review.reviewId, confirmed: true });
  assert.equal(keccak256(f.saved().callData), review.calldataHash);
  f.land({ phase: 'swap' });
  const { attempt } = await f.build({ reviews }).status({ wallet: f.session.wallet });
  assert.equal(attempt.status, 'verified');
  assert.equal(attempt.transactionHash, swapHash);
});
