import test from 'node:test';
import assert from 'node:assert/strict';
import { concat, parseAbi, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, keccak256, padHex, toHex, zeroAddress } from 'viem';
import { EXCHANGE_FEE_ABI } from '../../src/any-token-fees.js';
import { defaultFeePolicy, resolveReleaseFeePolicy } from '../../src/fee-policy.js';
import { FEE_ABI, LIFI_FEE_WALLET } from '../../src/swap-fee.js';
import { createCircleLifi } from './lifi.js';
import { lifiNetworks } from './lifi-networks.js';
import { depositEvent, fillEvent, transferEvent, proveLifiDestination, proveLifiSource, quoteLifi, validateLifiQuote } from './lifi-protocols.js';

const account = '0x1234567890123456789012345678901234567890';
const other = '0x2345678901234567890123456789012345678901';
const wallet = { id: '0f66ded2-af64-4cb9-9765-d202a2fd9600', address: account };
const ids = { 8453: '4d61922e-6006-4dd3-a875-bf29be4ac6d4', 10: '3ab6837a-db47-4115-9e79-15a68fee80b8' };
const challengeId = '337781db-ac68-4a97-a57d-ba29b7c4edd0';
const sessionHash = 'test-session';
const hash = (n) => toHex(n, { size: 32 });
const ts = 1_800_000_000;
const gross = 10_000_000n;
const word = value => padHex(value, { size: 32 });
const zero = word(zeroAddress);
const root = { fromChain: 5042, toChain: 8453, account, amount: String(gross) };

function fixtureQuote(intent, policy = defaultFeePolicy, mutate = () => {}) {
  const { fromChain, toChain } = intent;
  const network = lifiNetworks[fromChain];
  const source = { address: network.token[0], chainId: fromChain, decimals: 6 };
  const destination = { address: lifiNetworks[toChain].token[0], chainId: toChain, decimals: 6 };
  const fee = 25_000n;
  const termul = BigInt(policy.bps) * gross / 10000n;
  const total = fee + termul;
  const remainder = gross - total;
  const multiplier = 997000000000000000n;
  const polymer = toChain === 5042;
  const output = polymer ? remainder : remainder * multiplier / 10n ** 18n;
  const tool = polymer ? 'polymerStandard' : 'across';
  const action = { fromChainId: fromChain, toChainId: toChain, fromToken: source, toToken: destination,
    fromAddress: account, toAddress: account, fromAmount: String(gross), slippage: 0.005 };
  const cost = { name: 'LIFI Fixed Fee', amount: String(total), token: source, included: true,
    feeSplit: { lifiFee: String(fee), integratorFee: String(termul) } };
  const distributions = [{ recipient: LIFI_FEE_WALLET, amount: fee }, ...(termul ? [{ recipient: policy.recipient, amount: termul }] : [])];
  const transfer = { transactionId: hash(1000n), bridge: tool, integrator: 'termul', referrer: zeroAddress,
    sendingAssetId: source.address, receiver: account, minAmount: remainder, destinationChainId: BigInt(toChain),
    hasSourceSwaps: true, hasDestinationCall: false };
  const feeStep = { callTo: network.forwarder, approveTo: network.forwarder, sendingAssetId: source.address,
    receivingAssetId: source.address, fromAmount: gross, requiresDeposit: true,
    callData: encodeFunctionData({ abi: FEE_ABI, functionName: 'forwardERC20Fees', args: [source.address, distributions] }) };
  const protocol = polymer ? { polymerTokenFee: 0n, maxCCTPFee: 0n, nonEVMReceiver: zero, solanaReceiverATA: zero,
    minFinalityThreshold: 2000, refundRecipient: account, hookData: '0x' } : {
    receiverAddress: word(account), refundAddress: word(account), sendingAssetId: word(source.address),
    receivingAssetId: word(destination.address), outputAmount: output, outputAmountMultiplier: multiplier,
    exclusiveRelayer: zero, quoteTimestamp: ts, fillDeadline: ts + 7200, exclusivityParameter: 0, message: '0x',
  };
  mutate({ transfer, protocol, feeStep, action, cost });
  return { quote: { id: 'synthetic-quote', type: 'lifi', tool, integrator: 'termul', fee: policy.rate, action,
    estimate: { fromAmount: String(gross), toAmount: String(output), toAmountMin: String(output),
      approvalAddress: network.router, feeCosts: [cost] },
    includedSteps: [{ type: 'protocol', tool: 'feeCollection', action: { ...action, toChainId: fromChain, toToken: source },
      estimate: { fromAmount: String(gross), toAmount: String(remainder), feeCosts: [cost] } },
    { type: 'cross', tool, action: { ...action, fromAmount: String(remainder) }, estimate: { feeCosts: [] } }],
    transactionRequest: { chainId: fromChain, from: account, to: network.router, value: '0x0',
      data: encodeFunctionData({ abi: EXCHANGE_FEE_ABI, functionName: polymer ?
        'swapAndStartBridgeTokensViaPolymerCCTP' : 'swapAndStartBridgeTokensViaAcrossV4', args: [transfer,[feeStep],protocol] }) },
  }, transfer, protocol };
}

function log(receipt, abi, name, emitter, args, types, values) {
  return { address: emitter, transactionHash: receipt.transactionHash, blockHash: receipt.blockHash,
    topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(types, values) };
}
function tokenLog(receipt, token, from, to, amount) {
  return log(receipt, erc20Abi, 'Transfer', token, { from, to }, [{ type: 'uint256' }], [amount]);
}
function receipt(n = 2n) {
  return { transactionHash: hash(n + 20n), blockHash: hash(n), blockNumber: n, status: 'success',
    gasUsed: 45_000n, effectiveGasPrice: 1n * 10n ** 9n, logs: [] };
}
function originReceipt(plan, transfer, out = receipt()) {
  const b = { ...transfer };
  out.logs = [tokenLog(out, plan.fromToken.address, account, plan.router, gross),
    log(out, [transferEvent], 'LiFiTransferStarted', plan.router, {}, transferEvent.inputs, [b]),
    log(out, [depositEvent], 'FundsDeposited', lifiNetworks[plan.fromChain].pool[0],
      { destinationChainId: BigInt(plan.toChain), depositId: 77n, depositor: word(account) },
      depositEvent.inputs.filter(x => !x.indexed),
      [word(plan.fromToken.address), word(plan.toToken.address), BigInt(plan.deposit.input), BigInt(plan.deposit.output),
        ts, plan.deposit.fillDeadline, 0, word(account), zero, '0x'])];
  return out;
}
function fillReceipt(plan, depositId = 77n, recipient = account) {
  const out = receipt(40n);
  const output = BigInt(plan.deposit.output);
  const empty = keccak256('0x');
  out.logs = [tokenLog(out, plan.toToken.address, other, recipient, output),
    log(out, [fillEvent], 'FilledRelay', lifiNetworks[plan.toChain].pool[0],
      { originChainId: BigInt(plan.fromChain), depositId, relayer: word(other) }, fillEvent.inputs.filter(x => !x.indexed),
      [word(plan.fromToken.address), word(plan.toToken.address), BigInt(plan.deposit.input), output,
        BigInt(plan.fromChain), plan.deposit.fillDeadline, 0, zero, word(account), word(recipient), empty,
        { updatedRecipient: word(recipient), updatedMessageHash: empty, updatedOutputAmount: output, fillType: 0 }])];
  return out;
}

test('LI.FI decoder verifies both fee modes and several native-network pairs and rejects modified route terms', () => {
  for (const [fromChain, toChain] of [[5042,8453],[8453,5042],[8453,10],[42161,8453]]) {
    for (const policy of [defaultFeePolicy, resolveReleaseFeePolicy('10','6')]) {
      const intent = { ...root, fromChain, toChain };
      const { quote } = fixtureQuote(intent, policy);
      const plan = validateLifiQuote(quote, intent, policy, ts * 1000);
      assert.equal(plan.integratorFee, policy.bps ? '10000' : '0');
      assert.equal(plan.lifiFee, '25000');
      for (const alter of [
        q => { q.action.toAddress = other; },
        q => { q.estimate.feeCosts[0].feeSplit.integratorFee = '0x1'; },
        q => { q.transactionRequest.data += '00'; },
        q => { q.transactionRequest.value = '0x1'; },
        q => { q.includedSteps.push(q.includedSteps[0]); },
        q => { q.estimate.toAmountMin = '1'; },
      ]) {
        const invalid = structuredClone(quote);
        alter(invalid);
        assert.throws(() => validateLifiQuote(invalid, intent, policy, ts * 1000));
      }
    }
  }
  for (const mutate of [
    x => { x.protocol.receiverAddress = word(other); },
    x => { x.protocol.outputAmountMultiplier = 10n ** 18n; },
    x => { x.protocol.fillDeadline = ts - 1; },
    x => { x.transfer.integrator = 'fake'; },
    x => { x.feeStep.callTo = other; },
  ]) assert.throws(() => validateLifiQuote(fixtureQuote(root, defaultFeePolicy, mutate).quote, root, defaultFeePolicy, ts * 1000));
});

test('quote handoff is prepared server-side and a second response cannot lower output or change the quoted step', async () => {
  const { quote } = fixtureQuote(root);
  let stale = false, count = 0;
  const fetcher = async (url, options) => {
    const prepared = url.includes('stepTransaction');
    count++;
    if (prepared) assert.equal(Object.hasOwn(JSON.parse(options.body), 'transactionRequest'), false);
    else assert.equal(new URL(url).searchParams.get('integrator'), 'termul');
    return Response.json(prepared && stale ? { ...quote, id: 'changed' } : quote);
  };
  assert.equal((await quoteLifi(root, defaultFeePolicy, { fetcher, now: () => ts * 1000 })).tool, 'across');
  stale = true;
  await assert.rejects(quoteLifi(root, defaultFeePolicy, { fetcher, now: () => ts * 1000 }));
  assert.equal(count, 4);
});

test('Across settlement requires the exact origin deposit, recipient, token credit and matching destination fill', async () => {
  const { quote, transfer } = fixtureQuote(root);
  const plan = validateLifiQuote(quote, root, defaultFeePolicy, ts * 1000);
  const source = originReceipt(plan, transfer);
  const proof = proveLifiSource(plan, source);
  assert.deepEqual(proof, { tool: 'across', depositId: '77' });
  assert.equal(await proveLifiDestination(plan, proof, source, fillReceipt(plan, 78n)), null);
  assert.equal(await proveLifiDestination(plan, proof, source, fillReceipt(plan, 77n, other)), null);
  assert.equal(await proveLifiDestination(plan, proof, source, fillReceipt(plan)), plan.deposit.output);
});

test('managed bridge separately confirms allowance and source, survives restart, and preserves refund reports as unverified', async () => {
  const intent = { ...root, fromChain: 8453, toChain: 10 };
  const { quote, transfer } = fixtureQuote(intent);
  const plan = validateLifiQuote(quote, intent, defaultFeePolicy, ts * 1000);
  const clone = x => structuredClone(x);
  let row, head = 100n, approved = 0n, srcReceipt, srcTx, destReceipt, destinationProof, refund = false, moved = false;
  let missedResponse = false;
  const calls = [];
  const store = { latest: async () => clone(row), history: async () => row ? [clone(row)] : [], due: async () => row ? [clone(row)] : [],
    insert: async details => { row = { id: challengeId, details: clone(details), revision: 0 }; return clone(row); },
    update: async (before, details, session) => {
      if (before.revision !== row.revision || (details.status === 'submitting' && before.details.status === 'ready' && session !== sessionHash)) return null;
      row = { ...before, details: clone(details), revision: row.revision + 1 };
      return clone(row);
    } };
  const source = { readContract: async ({ functionName }) => ({ allowance: approved, decimals: 6, balanceOf: gross })[functionName],
    getGasPrice: async () => 1n * 10n ** 9n, getBalance: async () => 10n ** 17n, estimateGas: async () => 50_000n,
    getBlockNumber: async () => head, getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? head, hash: hash(blockNumber ?? head) }),
    getTransaction: async () => srcTx, getTransactionReceipt: async () => srcReceipt,
    getLogs: async ({ fromBlock }) => srcReceipt?.blockNumber >= fromBlock ? [{ transactionHash: srcReceipt.transactionHash }] : [],
  };
  const dest = { readContract: async () => 6,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? 100n, hash: hash(blockNumber ?? 100n) }),
    getLogs: async () => destinationProof ? [{ transactionHash: destReceipt.transactionHash }] : [],
    getTransactionReceipt: async () => destReceipt };
  const circle = {
    listWallets: async ({ blockchain }) => ({ data: { wallets: [{ blockchain, id: blockchain === 'BASE' ? ids[8453] : ids[10],
      address: moved ? other : account, accountType: 'EOA', state: 'LIVE' }] } }),
    estimateContractExecutionFee: async () => ({ data: { medium: { gasLimit: '55000', maxFee: '1.5', priorityFee: '0.2' } } }),
    createUserTransactionContractExecutionChallenge: async body => {
      assert.equal(row.details.status, 'submitting');
      assert.equal(body.walletId, ids[8453]);
      calls.push(body);
      if (missedResponse) throw new Error('synthetic transport interruption');
      return { data: { challengeId } };
    },
    listTransactions: async () => ({ data: { transactions: [] } }),
  };
  const context = { wallet, sessionHash, userToken: 'synthetic-user-token', authorize() {}, async revalidate() { return wallet; } };
  const create = () => createCircleLifi({ circle, store, enabled: true, loadPolicy: async () => defaultFeePolicy,
    clients: { 8453: source, 10: dest }, now: () => ts * 1000, quote: async () => plan, check: async () => {},
    fetcher: async () => Response.json(refund ? { sending: { txHash: srcReceipt.transactionHash, chainId: 8453 }, substatus: 'REFUNDED' } : {}),
  });
  const settleSource = phase => {
    const step = row.details.step;
    const mined = receipt(++head);
    srcReceipt = phase === 'transfer' ? originReceipt(plan, transfer, mined) : mined;
    if (phase !== 'transfer') srcReceipt.logs = [log(mined, erc20Abi, 'Approval', step.target,
      { owner: account, spender: plan.router }, [{ type: 'uint256' }], [gross])];
    srcTx = { chainId: 8453, type: 'eip1559', hash: mined.transactionHash, from: account, to: step.target,
      input: step.data, value: 0n, gas: BigInt(step.gasLimit), maxFeePerGas: BigInt(step.maxFee), maxPriorityFeePerGas: BigInt(step.tip),
      blockNumber: mined.blockNumber, blockHash: mined.blockHash };
  };
  const adapter = create();
  moved = true;
  await assert.rejects(adapter.prepare(context, intent), /matching live Circle EOA/);
  moved = false;
  const first = await adapter.prepare(context, intent);
  assert.equal(first.review.phase, 'approve');
  const settled = await Promise.allSettled([adapter.execute(context, first.review.id), adapter.execute(context, first.review.id)]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  settleSource('approve');
  await create().run();
  assert.equal(row.details.status, 'ready');
  approved = gross;
  const second = await create().prepare(context, intent);
  assert.equal(second.review.phase, 'transfer');
  missedResponse = true;
  assert.deepEqual(await create().execute(context, second.review.id), { pending: true });
  await assert.rejects(create().execute(context, second.review.id), /expired or changed/);
  settleSource('transfer');
  await create().run();
  assert.equal(row.details.status, 'destination-pending');
  refund = true;
  assert.equal((await create().status(context)).route.recovery, 'refund-reported');
  assert.equal(row.details.status, 'destination-pending');
  destReceipt = fillReceipt(plan, 79n);
  destinationProof = true;
  assert.equal((await create().status(context)).route.status, 'destination-pending');
  destReceipt = fillReceipt(plan);
  assert.equal((await create().status(context)).route.status, 'settled');
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(row).includes('synthetic-user-token'));
});

test('Polymer settlement binds the Base burn to the exact Arc CCTP nonce and token credit', async () => {
  const intent = { ...root, fromChain: 8453, toChain: 5042 };
  const { quote, transfer } = fixtureQuote(intent);
  const plan = validateLifiQuote(quote, intent, defaultFeePolicy, ts * 1000);
  const transmitter = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
  const messenger = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
  const aba = parseAbi([
    'event MessageSent(bytes message)',
    'event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)',
  ]);
  const u32 = number => toHex(number, { size: 4 });
  const burn = BigInt(plan.polymerBurnAmount);
  const body = concat([u32(1),word(plan.fromToken.address),word(account),hash(burn),word(plan.router),zero,zero,zero]);
  const header = (nonce, finality) => concat([u32(1),u32(6),u32(26),nonce,word(messenger),word(messenger),zero,u32(2000),u32(finality)]);
  const src = receipt(2n);
  src.logs = [tokenLog(src, plan.fromToken.address, account, plan.router, gross),
    log(src, [transferEvent], 'LiFiTransferStarted', plan.router, {}, transferEvent.inputs, [transfer]),
    log(src, aba, 'MessageSent', transmitter, {}, [{ type: 'bytes' }], [concat([header(zero,0),body])])];
  const source = proveLifiSource(plan, src);
  const nonce = hash(404n);
  function destination(eventNonce, transferAmount) {
    const out = receipt(40n);
    out.logs = [tokenLog(out, plan.toToken.address, zeroAddress, account, transferAmount),
      log(out, aba, 'MessageReceived', transmitter, { caller: other, nonce: eventNonce, finalityThresholdExecuted: 2000 },
        aba[1].inputs.filter(x => !x.indexed), [6, word(messenger), body])];
    return out;
  }
  const iris = async url => {
    assert.equal(new URL(url).pathname, '/v2/messages/6');
    return Response.json({ messages: [{ status: 'complete', message: concat([header(nonce,2000), body]) }] });
  };
  assert.equal(await proveLifiDestination(plan, source, src, destination(hash(405n), burn), iris), null);
  assert.equal(await proveLifiDestination(plan, source, src, destination(nonce, burn + 1n), iris), null);
  assert.equal(await proveLifiDestination(plan, source, src, destination(nonce, burn), iris), String(burn));
});
