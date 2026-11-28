import assert from 'node:assert/strict';
import test from 'node:test';
import { concat, decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, padHex, toHex, zeroAddress } from 'viem';
import { ARC_USDC, BASE_USDC, bridgeCall, cctpAbi, destinationProof, feeForBridge, hook, messenger, transmitter } from './cctp.js';
import { createCircleBridge } from './bridge.js';

const address = '0x1234567890123456789012345678901234567890';
const other = '0x2345678901234567890123456789012345678901';
const wallet = { address, id: '0f66ded2-af64-4cb9-9765-d202a2fd9600' };
const recipient = padHex(address, { size: 32 });
const empty = toHex(0, { size: 32 });
const memo = padHex(messenger, { size: 32 });
const amount = 10_000_000n;
const maxFee = 55_000n;
const fee = 53_000n;
const hash = value => toHex(value, { size: 32 });
const abi = [...cctpAbi, ...erc20Abi];
const challengeId = '337781db-ac68-4a97-a57d-ba29b7c4edd0';

function event(name, emitter, args, types, values, receipt) {
  return {
    address: emitter, transactionHash: receipt.transactionHash, blockHash: receipt.blockHash,
    topics: encodeEventTopics({ abi, eventName: name, args }),
    data: encodeAbiParameters(types.map(type => ({ type })), values),
  };
}

function message({ nonce = empty, finality = 0, fee = 0n, mintRecipient = recipient } = {}) {
  const u32 = value => toHex(value, { size: 4 });
  return concat([u32(1), u32(26), u32(6), nonce, memo, memo, empty, u32(2000), u32(finality),
    u32(1), padHex(ARC_USDC, { size: 32 }), mintRecipient, hash(amount), recipient, hash(maxFee),
    hash(fee), hash(finality ? 10000 : 0), hook]);
}

function makeFixture() {
  let row, allowance = 0n, next = 100n, now = Date.now(), forwarded, mismatch, transportFailed, challenge, due = [];
  const sent = [];
  const sourceTx = new Map();
  const sourceReceipt = new Map();
  const latest = async () => row && structuredClone(row);
  const store = {
    latest, history: async () => row ? [row] : [], due: async () => due,
    insert: async details => {
      if (row && !['closed', 'reverted', 'settled', 'rejected'].includes(row.details.status)) return null;
      row = { id: 'bbd70559-42d9-4367-b6be-02e0b4c9b0bd', wallet: address, revision: 0, details: structuredClone(details) };
      return latest();
    },
    update: async (before, details, session) => {
      if (row.revision !== before.revision || (before.details.status === 'ready' && details.status === 'submitting' &&
          session !== 'valid-session')) return null;
      row = { ...row, details: structuredClone(details), revision: row.revision + 1 };
      return latest();
    },
  };
  const arc = {
    getBalance: async () => 50n * 10n ** 18n, getGasPrice: async () => 25n * 10n ** 9n,
    estimateGas: async () => 60_000n, getBlockNumber: async () => next,
    readContract: async ({ functionName }) => ({ allowance, balanceOf: 50_000_000n, decimals: 6 })[functionName],
    getTransaction: async ({ hash }) => sourceTx.get(hash),
    getTransactionReceipt: async ({ hash }) => sourceReceipt.get(hash),
    getLogs: async ({ fromBlock, toBlock }) => [...sourceReceipt.values()]
      .filter(item => item.blockNumber >= fromBlock && item.blockNumber <= toBlock).flatMap(item => item.logs),
    getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? next, hash: hash(blockNumber ?? next) }),
  };
  const base = {
    getLogs: async () => forwarded?.logs ?? [],
    readContract: async () => 6,
    getTransactionReceipt: async () => forwarded,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? 300n, hash: hash(blockNumber ?? 300n) }),
  };
  const circle = {
    listWallets: async () => ({ data: { wallets: [{ blockchain: 'BASE', state: 'LIVE', accountType: 'EOA', ...wallet,
      address: mismatch ? other : address }] } }),
    estimateContractExecutionFee: async () => ({ data: { medium: { gasLimit: '55000', maxFee: '24', priorityFee: '1' } } }),
    createUserTransactionContractExecutionChallenge: async value => {
      assert.equal(row.details.status, 'submitting');
      sent.push(value);
      if (transportFailed) throw new Error('fixture network outage');
      return { data: { challengeId } };
    },
    listTransactions: async () => ({ data: { transactions: [] } }),
    getUserChallenge: async () => ({ data: { challenge } }),
  };
  const context = { wallet, userToken: 'synthetic-session-only', sessionHash: 'valid-session',
    authorize() {}, async revalidate() { return wallet; } };
  const read = async path => path.startsWith('/v2/burn/')
    ? [{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { high: Number(maxFee) } }]
    : { messages: forwarded ? [{ status: 'complete', message: message({ nonce: hash(5), finality: 2000, fee }),
      forwardTxHash: forwarded.transactionHash }] : [] };
  const build = (enabled = true, loadPolicy) => createCircleBridge({ circle, arc, base, store, enabled, loadPolicy,
    read, now: () => now, check: async () => {} });

  function source(status = 'success') {
    const step = row.details.step;
    const blockNumber = ++next;
    const transactionHash = hash(blockNumber + 1000n);
    const blockHash = hash(blockNumber);
    const receipt = { transactionHash, blockNumber, blockHash, status, logs: [], gasUsed: 60_000n, effectiveGasPrice: 20n * 10n ** 9n };
    sourceTx.set(transactionHash, { hash: transactionHash, chainId: 5042, type: 'eip1559', from: address, to: step.target,
      blockHash, blockNumber, input: step.data, value: 0n, gas: BigInt(step.gasLimit),
      maxFeePerGas: BigInt(step.maxFeePerGas), maxPriorityFeePerGas: BigInt(step.tip) });
    if (step.phase === 'burn') {
      receipt.logs = [
        event('DepositForBurn', messenger, { burnToken: ARC_USDC, depositor: address, minFinalityThreshold: 2000 },
          ['uint256','bytes32','uint32','bytes32','bytes32','uint256','bytes'],
          [amount, recipient, 6, memo, empty, maxFee, hook], receipt),
        event('MessageSent', transmitter, {}, ['bytes'], [message()], receipt),
      ];
    } else {
      allowance = BigInt(step.value);
      receipt.logs = [event('Approval', ARC_USDC, { owner: address, spender: messenger }, ['uint256'], [allowance], receipt)];
    }
    sourceReceipt.set(transactionHash, receipt);
    return transactionHash;
  }

  function destination(recipientAddress = address) {
    const nonce = hash(5);
    const attested = message({ nonce, finality: 2000, fee });
    const net = amount - fee;
    const receipt = { status: 'success', transactionHash: hash(909), blockNumber: 200n, blockHash: hash(200), logs: [] };
    receipt.logs = [
      event('MessageReceived', transmitter, { caller: other, nonce, finalityThresholdExecuted: 2000 },
        ['uint32','bytes32','bytes'], [26, memo, '0x' + attested.slice(298)], receipt),
      event('MintAndWithdraw', messenger, { mintRecipient: recipientAddress, mintToken: BASE_USDC }, ['uint256','uint256'], [net, fee], receipt),
      event('Transfer', BASE_USDC, { from: zeroAddress, to: recipientAddress }, ['uint256'], [net], receipt),
    ];
    forwarded = receipt;
  }
  return { build, context, latest, sent, source, destination, store, base, read, mismatch() { mismatch = true; },
    noResponse() { transportFailed = true; }, tick() { now += 46_000; },
    reject() { challenge = { id: challengeId, type: 'CONTRACT_EXECUTION', status: 'FAILED', errorCode: 155701 }; },
    allowance(value) { allowance = value; }, schedule() { due = [structuredClone(row)]; } };
}

const prepare = (adapter, f) => adapter.prepare(f.context, String(amount));
const execute = (adapter, f, result) => adapter.execute(f.context, result.review.id);

test('CCTP validates fee conversion, rejects malformed standard quotes, and pins exact allowance or burn arguments', async () => {
  assert.equal(await feeForBridge(amount, async () => [{ finalityThreshold: 2000, minimumFee: 0.5, forwardFee: { high: 50000 } }]), 50500n);
  await assert.rejects(feeForBridge(amount, async () => [{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { high: 1 } }]));
  assert.deepEqual(decodeFunctionData({ abi, data: bridgeCall(address, amount, maxFee, amount + 1n).data }).args, [messenger, 0n]);
  assert.equal(bridgeCall(address, amount, maxFee, 0n).phase, 'approve');
  assert.deepEqual(decodeFunctionData({ abi, data: bridgeCall(address, amount, maxFee, amount).data }).args,
    [amount, 6, recipient, ARC_USDC, empty, maxFee, 2000, hook]);
});

test('CCTP executes separately reviewed reset, exact approval and burn, then finalizes only a matching Base mint after restart', async () => {
  const f = makeFixture();
  f.allowance(amount + 1n);
  for (const phase of ['reset', 'approve', 'burn']) {
    const adapter = f.build();
    const result = await prepare(adapter, f);
    assert.equal(result.review.phase, phase);
    assert.equal((await execute(adapter, f, result)).challengeId, challengeId);
    assert.equal((await adapter.status(f.context)).bridge.status, 'source-pending');
    f.source();
    f.schedule();
    await f.build(false).run();
    assert.equal((await f.latest()).details.status, phase === 'burn' ? 'destination-pending' : 'ready');
  }
  f.destination(other);
  assert.equal((await f.build().status(f.context)).bridge.status, 'destination-pending');
  f.destination();
  const { bridge } = await f.build().status(f.context);
  assert.equal(bridge.status, 'settled');
  assert.equal(bridge.received, String(amount - fee));
  assert.equal(bridge.history.length, 3);
  assert.equal(f.sent.length, 3);
  assert.ok(!JSON.stringify(await f.latest()).includes('synthetic-session-only'));
  const row = await f.latest();
  assert.equal(await destinationProof(f.base, row.details, async () => ({ messages: [] }), async () => {}), null);
  const withoutHash = async () => {
    const { messages } = await f.read('/v2/messages/26');
    return { messages: messages.map(({ forwardTxHash, ...rest }) => rest) };
  };
  assert.equal((await destinationProof(f.base, row.details, withoutHash, async () => {})).destinationHash, hash(909));
});

test('CCTP handles stale quotes, duplicate execution, uncertain responses, rejection, and proven source reverts', async () => {
  const f = makeFixture();
  const adapter = f.build();
  await assert.rejects(prepare(f.build(false), f), /disabled/);
  await assert.rejects(prepare(f.build(true, async () => ({ bps: 10 })), f), /zero-fee/);
  const expired = await prepare(adapter, f);
  f.tick();
  await assert.rejects(execute(adapter, f, expired), /expired/);
  const result = await prepare(adapter, f);
  const races = await Promise.allSettled([execute(adapter, f, result), execute(adapter, f, result)]);
  assert.equal(races.filter(x => x.status === 'fulfilled').length, 1);
  f.reject();
  assert.equal((await adapter.status(f.context)).bridge.status, 'rejected');
  const another = await prepare(adapter, f);
  f.noResponse();
  assert.deepEqual(await execute(adapter, f, another), { pending: true });
  await assert.rejects(prepare(adapter, f), /existing bridge/);
  f.source('reverted');
  assert.equal((await f.build().status(f.context)).bridge.status, 'reverted');
  assert.equal(f.sent.length, 2);
});

test('CCTP requires the same existing Circle Base EOA and rejects a different SIWE review scope', async () => {
  const f = makeFixture();
  const adapter = f.build();
  const result = await prepare(adapter, f);
  await assert.rejects(adapter.execute({ ...f.context, sessionHash: 'another' }, result.review.id), /expired or changed/);
  f.mismatch();
  await assert.rejects(prepare(adapter, f), /matching live Base EOA/);
  assert.equal(f.sent.length, 0);
});
