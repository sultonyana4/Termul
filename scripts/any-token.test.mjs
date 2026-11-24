import { assertCurrentFeePolicy, defaultFeePolicy } from '../src/fee-policy.js';
import assert from 'node:assert/strict';
import { concatHex, decodeFunctionData, numberToHex, parseAbi, padHex, zeroAddress, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, keccak256 } from 'viem';
import { exchangeChain, exchangeChains, exchangeWidgetConfig, loadExchangeNetworks, scanLink, transactionLink } from '../src/any-token-networks.js';
import { EXCHANGE_FEE_ABI } from '../src/any-token-fees.js';
import { FEE_FORWARDER, FEE_ABI, SWAP_ROUTER } from '../src/swap-quote.js';
import { LIFI_FEE_WALLET } from '../src/swap-fee.js';
import { enabledFee, feeRecipient } from './swap-fixtures.mjs';
import { switchWalletToChain } from '../src/wallet-provider.js';
import {
  createExchangeSender, exchangeLedger, preparedExchangeStep, reconcileExchange, reviewExchangeRoute, validateExchangeRequest,
} from '../src/any-token-transfers.js';

const ids = [5042, 1, 8453, 42161, 10, 137, 43114, 59144, 130, 480, 146, 1329, 50, 57073, 98866, 143, 2818, 81224];
assert.deepEqual(exchangeChains.map(chain => chain.id), ids);
for (const chain of exchangeChains) {
  assert.equal(Boolean(chain.testnet), false);
  assert.equal(new URL(chain.rpcUrls.default.http[0]).protocol, 'https:');
  assert.equal(new URL(chain.blockExplorers.default.url).protocol, 'https:');
}
const account = '0x' + '12'.repeat(20);
const outsider = '0x' + '56'.repeat(20);
const router = '0x' + '34'.repeat(20);
const hash = '0x' + 'aa'.repeat(32);
const destinationHash = '0x' + 'bb'.repeat(32);
const approvalHash = '0x' + 'cc'.repeat(32);
const tokenAddress = '0x3600000000000000000000000000000000000000';
const baseToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const token = (address, chainId) => ({ address, chainId, symbol: 'USDC', decimals: 6 });
const catalog = ids.slice(0, -1).map(id => ({
  id, diamondAddress: router, chainType: 'EVM', mainnet: true,
  ...(id === 5042 && { name: 'Arc', logoURI: 'https://example.com/arc.svg' }),
  ...(id === 8453 && { name: 'Base', logoURI: 'http://example.com/base.svg' }),
}));
const networks = await loadExchangeNetworks(async input => {
  assert.equal(input, 'https://li.quest/v1/chains?chainTypes=EVM');
  return Response.json({ chains: [...catalog, { id: 11155111, diamondAddress: router, chainType: 'EVM' }] });
});
assert.equal(networks.size, 17);
assert.equal(networks.has(81224), false);
assert.equal(networks.has(11155111), false);
assert.equal(networks.get(5042).name, 'Arc');
assert.equal(networks.get(5042).iconUrl, 'https://example.com/arc.svg');
assert.equal(networks.get(8453).iconUrl, null);
await assert.rejects(loadExchangeNetworks(async () => Response.json({ chains: [] })), /no supported/i);
await assert.rejects(loadExchangeNetworks(async () => new Response(null, { status: 503 })), /Could not load/i);
const config = exchangeWidgetConfig(networks, [], () => {}, value => value);
assert.equal(config.fromChain, 5042);
assert.equal(config.feeConfig.fee, 0);
assert.equal(config.integrator, 'termul');
assert.equal(config.chains.allow.length, 17);
assert.ok(!config.chains.allow.includes(81224));
assert.equal(config.theme.colorSchemes.dark.palette.primary.main, '#65e4d0');
assert.equal(config.theme.colorSchemes.dark.palette.background.default, '#101520');
assert.equal(config.useGaslessRoutes, false);
assert.equal(transactionLink(5042, hash), 'https://explorer.arc.io/tx/' + hash);
assert.equal(transactionLink(8453, hash), 'https://basescan.org/tx/' + hash);
assert.equal(transactionLink(1, hash), 'https://etherscan.io/tx/' + hash);
assert.equal(transactionLink(11155111, hash), null);
assert.equal(scanLink(hash), 'https://scan.li.fi/tx/' + hash);
assert.equal(scanLink('https://example.invalid'), null);
const switches = [];
await switchWalletToChain({ request: async call => {
  switches.push(call);
  if (switches.length === 1) throw Object.assign(new Error('Unknown network'), { code: 4902 });
} }, exchangeChain(8453));
assert.deepEqual(switches.map(call => call.method), ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
assert.equal(switches[1].params[0].chainId, '0x2105');
assert.deepEqual(switches[1].params[0].rpcUrls, exchangeChain(8453).rpcUrls.default.http);

const selection = { address: account, chainId: 5042, connectorId: 'injected', revision: 1 };
const prepared = { from: account, to: router, chainId: 5042, value: '0x0', data: '0x77777777' };
function routeFixture(toChain = 8453) {
  const action = { fromAddress: account, toAddress: account, fromChainId: 5042, toChainId: toChain,
    fromToken: token(tokenAddress, 5042), toToken: token(toChain === 5042 ? outsider : baseToken, toChain), fromAmount: '10000000' };
  return { id: 'route', steps: [{
    id: 'step', type: 'lifi', tool: 'across', action,
    estimate: { toAmountMin: '9800000', approvalAddress: router, feeCosts: [] },
    transactionRequest: prepared,
  }] };
}
const route = routeFixture();
const plan = reviewExchangeRoute(route, selection, networks);
assert.equal(preparedExchangeStep(plan, route, selection, networks), prepared);
assert.equal(validateExchangeRequest(plan, prepared, prepared, selection).kind, 'source');
assert.throws(() => validateExchangeRequest(plan, undefined, prepared, selection), /matching prepared/);
assert.throws(() => validateExchangeRequest(plan, prepared, { ...prepared, data: '0x88888888' }, selection), /matching prepared/);
assert.throws(() => validateExchangeRequest(plan, prepared, { ...prepared, value: '0x1' }, selection), /matching prepared/);
const excessiveNativeValue = { ...prepared, value: '0x1' };
assert.throws(() => validateExchangeRequest(plan, excessiveNativeValue, excessiveNativeValue, selection), /matching prepared/);
assert.throws(() => validateExchangeRequest(plan, prepared, prepared, { ...selection, chainId: 8453 }), /wallet changed/);
assert.throws(() => validateExchangeRequest(plan, prepared, prepared, selection, plan.expires + 1), /fresh route/);
assert.throws(() => reviewExchangeRoute(routeFixture(81224), selection, networks), /supported LI.FI/);
for (const change of [
  step => { step.action.toAddress = outsider; },
  step => { step.estimate.approvalAddress = outsider; },
  step => { step.estimate.feeCosts.push({ feeSplit: { integratorFee: '1' } }); },
  step => { step.includedSteps = [{ type: 'custom', action: step.action }]; },
]) {
  const updated = structuredClone(route);
  change(updated.steps[0]);
  assert.throws(() => reviewExchangeRoute(updated, selection, networks));
}
const wrongMinimum = structuredClone(route);
wrongMinimum.steps[0].estimate.toAmountMin = '9700000';
assert.throws(() => preparedExchangeStep(plan, wrongMinimum, selection, networks), /changed this route/);
const nativeFeeRoute = structuredClone(route);
nativeFeeRoute.steps[0].estimate.feeCosts.push({ included: false, amount: '1', token: token('0x' + '0'.repeat(40), 5042) });
const nativeFeePlan = reviewExchangeRoute(nativeFeeRoute, selection, networks);
assert.equal(validateExchangeRequest(nativeFeePlan, excessiveNativeValue, excessiveNativeValue, selection).value, 1n);
assert.throws(() => preparedExchangeStep(plan, nativeFeeRoute, selection, networks), /changed this route/);

const baseRouter = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const baseForwarder = '0xDe2b920506EE931a6A2ABDF566526220214FBbAE';
const feeNetworks = new Map(networks);
feeNetworks.set(8453, { ...networks.get(8453), router: baseRouter });
feeNetworks.set(5042, { ...networks.get(5042), router: SWAP_ROUTER });
assert.equal(exchangeWidgetConfig(feeNetworks, [], () => {}, value => value, enabledFee).feeConfig.fee, 0.001);
const sourceFee = {
  name: 'LIFI Fixed Fee', included: true, amount: '35000', token: token(tokenAddress, 5042),
  feeSplit: { integratorFee: '10000', lifiFee: '25000', recipients: [
    { name: 'termul', fee: '10000', type: 'FIXED', walletAddress: feeRecipient },
    { name: 'lifi', fee: '25000', type: 'FIXED' },
  ] },
};
function enabledRoute(toChain, native = false) {
  const quote = routeFixture(toChain);
  const [step] = quote.steps;
  const source = native ? zeroAddress : tokenAddress;
  const amount = native ? 10n ** 18n : 10_000_000n;
  const scale = native ? 10n ** 11n : 1n;
  const fee = structuredClone(sourceFee);
  step.action.fromToken = { ...step.action.fromToken, address: source, decimals: native ? 18 : 6 };
  step.action.fromAmount = String(amount);
  fee.token = step.action.fromToken;
  fee.amount = String(35_000n * scale);
  fee.feeSplit.integratorFee = String(10_000n * scale);
  fee.feeSplit.lifiFee = String(25_000n * scale);
  fee.feeSplit.recipients[0].fee = fee.feeSplit.integratorFee;
  fee.feeSplit.recipients[1].fee = fee.feeSplit.lifiFee;
  const remainder = amount - BigInt(fee.amount);
  Object.assign(step, { integrator: 'termul', fee: 0.001, includedSteps: [{
    type: 'protocol', tool: 'feeCollection', action: {
      ...step.action, toChainId: 5042, toToken: fee.token,
    },
    estimate: { fromAmount: String(amount), toAmount: String(remainder), feeCosts: [structuredClone(fee)] },
  }] });
  Object.assign(step.estimate, { fromAmount: String(amount), toAmount: '9900000', approvalAddress: SWAP_ROUTER, feeCosts: [fee] });
  const payouts = [{ recipient: LIFI_FEE_WALLET, amount: BigInt(fee.feeSplit.lifiFee) },
    { recipient: feeRecipient, amount: BigInt(fee.feeSplit.integratorFee) }];
  const feeStep = {
    callTo: FEE_FORWARDER, approveTo: FEE_FORWARDER, sendingAssetId: source, receivingAssetId: source,
    fromAmount: native ? BigInt(fee.amount) : amount, requiresDeposit: true,
    callData: encodeFunctionData({ abi: FEE_ABI, functionName: native ? 'forwardNativeFees' : 'forwardERC20Fees',
      args: native ? [payouts] : [source, payouts] }),
  };
  const id = '0x' + 'ff'.repeat(32);
  const bytes32 = address => padHex(address, { size: 32 });
  const acrossArgs = [{
    transactionId: id, bridge: 'across', integrator: 'termul', referrer: zeroAddress, sendingAssetId: source,
    receiver: account, minAmount: remainder, destinationChainId: BigInt(toChain), hasSourceSwaps: true, hasDestinationCall: false,
  }, [feeStep], {
    receiverAddress: bytes32(account), refundAddress: bytes32(account), sendingAssetId: bytes32(source), receivingAssetId: bytes32(baseToken),
    outputAmount: 9_900_000n, outputAmountMultiplier: 10n ** 18n, exclusiveRelayer: bytes32(zeroAddress),
    quoteTimestamp: 1000, fillDeadline: 1500, exclusivityParameter: 0, message: '0x',
  }];
  const swapArgs = [id, 'termul', zeroAddress, account, 9_800_000n, [feeStep, {
    callTo: router, approveTo: router, sendingAssetId: source, receivingAssetId: step.action.toToken.address,
    fromAmount: remainder, requiresDeposit: false, callData: '0x12345678',
  }]];
  const sameChain = toChain === 5042;
  step.transactionRequest = { ...prepared, to: SWAP_ROUTER, value: native ? amount.toString() : '0',
    data: encodeFunctionData({ abi: EXCHANGE_FEE_ABI,
      functionName: sameChain ? (native ? 'swapTokensMultipleV3NativeToERC20' : 'swapTokensMultipleV3ERC20ToERC20')
        : 'swapAndStartBridgeTokensViaAcrossV4', args: sameChain ? swapArgs : acrossArgs }) };
  Object.assign(quote, {
    fromChainId: 5042, toChainId: toChain, fromAmount: String(amount), toAmountMin: '9800000',
    fromToken: step.action.fromToken, toToken: step.action.toToken,
  });
  return quote;
}
for (const [destination, native] of [[5042, false], [5042, true], [8453, false]]) {
  const quote = enabledRoute(destination, native);
  const feePlan = reviewExchangeRoute(quote, selection, feeNetworks, Date.now(), enabledFee);
  assert.equal(feePlan.fee.integratorFee, native ? 10n ** 15n : 10_000n);
  const tx = preparedExchangeStep(feePlan, quote, selection, feeNetworks, enabledFee);
  assert.equal(validateExchangeRequest(feePlan, tx, tx, selection).kind, 'source');
  assert.throws(() => validateExchangeRequest(feePlan, tx, tx, selection, feePlan.expires));
  assert.throws(() => validateExchangeRequest(feePlan, tx, tx, { ...selection, address: outsider }));
  assert.throws(() => reviewExchangeRoute(quote, selection, networks, Date.now(), enabledFee));
  assert.throws(() => reviewExchangeRoute({ ...quote, toAmountMin: '9850000' }, selection, feeNetworks, Date.now(), enabledFee));
  assert.throws(() => reviewExchangeRoute(quote, selection, feeNetworks));
  for (const mutate of [
    step => { step.fee = 0.002; },
    step => { step.integrator = 'other'; },
    step => { step.estimate.feeCosts = []; },
    step => { step.estimate.feeCosts.push({ ...sourceFee, included: false }); },
    step => { step.estimate.feeCosts[0].feeSplit.recipients[0].walletAddress = outsider; },
    step => { step.estimate.feeCosts[0].feeSplit.integratorFee = '1'; },
    step => { step.estimate.feeCosts[0].feeSplit.intermediaryFee = '1'; },
    step => { step.estimate.feeCosts[0].token = step.action.toToken; },
    step => { step.includedSteps[0].estimate.toAmount = '1'; },
  ]) {
    const invalid = structuredClone(quote);
    mutate(invalid.steps[0]);
    assert.throws(() => reviewExchangeRoute(invalid, selection, feeNetworks, Date.now(), enabledFee));
  }
  for (const mutate of [
    args => { (destination === 5042 ? args[5] : args[1])[0].approveTo = outsider; },
    args => {
      const [feeStep] = destination === 5042 ? args[5] : args[1];
      const decoded = decodeFunctionData({ abi: FEE_ABI, data: feeStep.callData });
      decoded.args[native ? 0 : 1][1].recipient = outsider;
      feeStep.callData = encodeFunctionData({ abi: FEE_ABI, ...decoded });
    },
    args => {
      if (destination === 5042) args[4] = 1n;
      else args[2].outputAmountMultiplier = 1n;
    },
  ]) {
    const invalid = structuredClone(quote);
    const request = invalid.steps[0].transactionRequest;
    const decoded = decodeFunctionData({ abi: EXCHANGE_FEE_ABI, data: request.data });
    mutate(decoded.args);
    request.data = encodeFunctionData({ abi: EXCHANGE_FEE_ABI, ...decoded });
    assert.throws(() => preparedExchangeStep(feePlan, invalid, selection, feeNetworks, enabledFee));
  }
  const unknown = { ...tx, data: '0x77777777' };
  assert.throws(() => validateExchangeRequest(feePlan, unknown, unknown, selection));
}

function updateCalldata(quote, change) {
  const [{ transactionRequest: tx }] = quote.steps;
  const decoded = decodeFunctionData({ abi: EXCHANGE_FEE_ABI, data: tx.data });
  change(decoded);
  tx.data = encodeFunctionData({ abi: EXCHANGE_FEE_ABI, ...decoded });
}

function baseNativeRoute() {
  const quote = enabledRoute(5042, true);
  const [step] = quote.steps;
  step.tool = 'paraswap';
  for (const action of [step.action, step.includedSteps[0].action]) {
    action.fromChainId = action.toChainId = 8453;
    action.fromToken = { ...action.fromToken, chainId: 8453, symbol: 'ETH' };
    action.toToken = { ...action.toToken, chainId: 8453 };
  }
  step.action.toToken.address = baseToken;
  step.estimate.approvalAddress = baseRouter;
  step.estimate.feeCosts[0].token = step.action.fromToken;
  step.includedSteps[0].estimate.feeCosts[0].token = step.action.fromToken;
  Object.assign(quote, { fromChainId: 8453, toChainId: 8453, fromToken: step.action.fromToken, toToken: step.action.toToken });
  Object.assign(step.transactionRequest, { chainId: 8453, to: baseRouter });
  updateCalldata(quote, ({ args }) => {
    const [fee, swap] = args[5];
    fee.fromAmount = BigInt(quote.fromAmount);
    fee.callTo = fee.approveTo = baseForwarder;
    swap.receivingAssetId = baseToken;
  });
  return quote;
}

function polymerRoute() {
  const quote = enabledRoute(8453);
  const [step] = quote.steps;
  step.tool = 'polymerStandard';
  step.estimate.feeCosts.push({ name: 'Polymer fee', token: step.action.fromToken, included: true, amount: '1993' });
  updateCalldata(quote, decoded => {
    decoded.functionName = 'swapAndStartBridgeTokensViaPolymerCCTP';
    decoded.args[0].bridge = step.tool;
    decoded.args[2] = {
      polymerTokenFee: 1993n, maxCCTPFee: 0n, minFinalityThreshold: 2000, refundRecipient: account,
      nonEVMReceiver: padHex(zeroAddress, { size: 32 }), solanaReceiverATA: padHex(zeroAddress, { size: 32 }), hookData: '0x',
    };
  });
  return quote;
}

const baseSelection = { ...selection, chainId: 8453 };
for (const [make, wallet, proof, tampering] of [
  [baseNativeRoute, baseSelection, { refundsNativeInput: true }, [
    args => { args[5][0].fromAmount -= 1n; },
    args => { args[5][1].fromAmount += 1n; },
    args => { args[5][1].requiresDeposit = true; },
    args => { args[5][0].callTo = outsider; },
    args => {
      const decoded = decodeFunctionData({ abi: FEE_ABI, data: args[5][0].callData });
      decoded.args[0][1].amount += 1n;
      args[5][0].callData = encodeFunctionData({ abi: FEE_ABI, ...decoded });
    },
  ]],
  [polymerRoute, selection, { polymerBurnAmount: '9963007' }, [
    args => { args[0].receiver = outsider; },
    args => { args[0].destinationChainId = 1n; },
    args => { args[2].refundRecipient = outsider; },
    args => { args[2].maxCCTPFee = 1n; },
    args => { args[2].polymerTokenFee += 1n; },
    args => { args[2].minFinalityThreshold = 1000; },
    args => { args[2].hookData = '0xab'; },
    args => { args[1].push(args[1][0]); },
  ]],
]) {
  const quote = make();
  const plan = reviewExchangeRoute(quote, wallet, feeNetworks, Date.now(), enabledFee);
  const tx = preparedExchangeStep(plan, quote, wallet, feeNetworks, enabledFee);
  const result = validateExchangeRequest(plan, tx, tx, wallet);
  assert.equal(result.kind, 'source');
  for (const [key, value] of Object.entries(proof)) assert.equal(result[key], value);
  const wrongFeeRecipient = make();
  updateCalldata(wrongFeeRecipient, ({ args }) => {
    const native = wallet.chainId === 8453;
    const [fee] = native ? args[5] : args[1];
    const decoded = decodeFunctionData({ abi: FEE_ABI, data: fee.callData });
    decoded.args[native ? 0 : 1][1].recipient = outsider;
    fee.callData = encodeFunctionData({ abi: FEE_ABI, ...decoded });
  });
  assert.throws(() => preparedExchangeStep(plan, wrongFeeRecipient, wallet, feeNetworks, enabledFee));
  for (const mutate of tampering) {
    const invalid = make();
    updateCalldata(invalid, ({ args }) => mutate(args));
    assert.throws(() => preparedExchangeStep(plan, invalid, wallet, feeNetworks, enabledFee));
  }
  for (const mutate of [
    request => { request.value = (BigInt(request.value) + 1n).toString(); },
    request => { request.to = outsider; },
    request => { request.data += '00'; },
  ]) {
    const invalid = make();
    mutate(invalid.steps[0].transactionRequest);
    assert.throws(() => preparedExchangeStep(plan, invalid, wallet, feeNetworks, enabledFee));
  }
}

const unknownRefundDeployment = enabledRoute(5042, true);
const polygonNetwork = networks.get(137);
const otherNetworks = new Map([[137, { ...polygonNetwork, router: baseRouter }]]);
const [unknownStep] = unknownRefundDeployment.steps;
for (const action of [unknownStep.action, unknownStep.includedSteps[0].action]) {
  action.fromChainId = action.toChainId = 137;
  action.fromToken.chainId = action.toToken.chainId = 137;
}
Object.assign(unknownRefundDeployment, { fromChainId: 137, toChainId: 137 });
unknownStep.estimate.approvalAddress = baseRouter;
unknownStep.includedSteps[0].estimate.feeCosts[0].token = unknownStep.action.fromToken;
Object.assign(unknownStep.transactionRequest, { chainId: 137, to: baseRouter });
updateCalldata(unknownRefundDeployment, ({ args }) => {
  args[5][0].fromAmount = BigInt(unknownRefundDeployment.fromAmount);
  args[5][0].callTo = args[5][0].approveTo = baseForwarder;
});
const otherSelection = { ...selection, chainId: 137 };
const otherPlan = reviewExchangeRoute(unknownRefundDeployment, otherSelection, otherNetworks, Date.now(), enabledFee);
assert.throws(() => preparedExchangeStep(otherPlan, unknownRefundDeployment, otherSelection, otherNetworks, enabledFee), /inconsistent fee/);
const changedProviderFee = polymerRoute();
const polymerPlan = reviewExchangeRoute(changedProviderFee, selection, feeNetworks, Date.now(), enabledFee);
changedProviderFee.steps[0].estimate.feeCosts.at(-1).amount = '2000';
assert.throws(() => preparedExchangeStep(polymerPlan, changedProviderFee, selection, feeNetworks, enabledFee), /changed this route/);
changedProviderFee.steps[0].estimate.feeCosts.at(-1).amount = '1000000';
assert.throws(() => reviewExchangeRoute(changedProviderFee, selection, feeNetworks, Date.now(), enabledFee));

const unsupportedBridge = enabledRoute(8453);
unsupportedBridge.steps[0].tool = 'other-bridge';
assert.throws(() => reviewExchangeRoute(unsupportedBridge, selection, feeNetworks, Date.now(), enabledFee));

const allowanceCall = (spender, amount) => ({ from: account, to: tokenAddress, chainId: 5042,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });
const approve = allowanceCall(router, 10_000_000n);
assert.equal(validateExchangeRequest(plan, prepared, approve, selection).kind, 'approval');
assert.throws(() => validateExchangeRequest(plan, prepared, allowanceCall(outsider, 10_000_000n), selection));
assert.throws(() => validateExchangeRequest(plan, prepared, allowanceCall(router, 2n ** 256n - 1n), selection));

function receipt(txHash, status = 'success', logs = []) { return { transactionHash: txHash, status, logs }; }
function transferLog(token, to = account, amount = 9_900_000n, from = router) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  };
}
function recordFor(plan, tx = prepared, txHash = hash) {
  return { ...plan, target: tx.to, dataHash: keccak256(tx.data), value: '0', kind: tx === approve ? 'approval' : 'source',
    hash: txHash, stage: 'submitted', approvals: [] };
}
function statusFixture(plan, txHash = destinationHash) {
  return { status: 'DONE', substatus: 'COMPLETED', fromAddress: account, toAddress: account,
    sending: { txHash: hash, chainId: plan.fromChain, token: plan.fromToken, amount: plan.amount },
    receiving: { txHash, chainId: plan.toChain, token: plan.toToken, amount: '9900000' },
  };
}
const sourceDebit = transferLog(tokenAddress, router, 10_000_000n, account);
function chainMock({ sourceStatus = 'success', destStatus = 'success', sourceLogs = [sourceDebit], destLogs = [transferLog(baseToken)] } = {}) {
  return id => ({
    getChainId: async () => id,
    getTransactionReceipt: async ({ hash: h }) => h === approvalHash ? receipt(h) :
      id === 5042 ? receipt(h, sourceStatus, sourceLogs) : receipt(h, destStatus, destLogs),
    getTransaction: async ({ hash: h }) => ({ hash: h, from: account, to: h === approvalHash ? approve.to : router,
      input: h === approvalHash ? approve.data : prepared.data, value: 0n }),
  });
}
const fetchStatus = (plan, payload = statusFixture(plan)) => async input => {
  const url = new URL(input);
  assert.equal(url.pathname, '/v1/status');
  assert.equal(url.searchParams.get('fromChain'), '5042');
  assert.equal(url.searchParams.get('toChain'), String(plan.toChain));
  assert.equal(url.searchParams.get('txHash'), hash);
  return Response.json(payload);
};
const record = recordFor(plan);
assert.equal((await reconcileExchange(record, chainMock(), async () => new Response(null, { status: 404 }))).stage, 'source-confirmed');
assert.equal((await reconcileExchange(record, chainMock({ destStatus: 'reverted' }), fetchStatus(plan))).stage, 'processing');
assert.equal((await reconcileExchange(record, chainMock({ destLogs: [transferLog(baseToken, outsider)] }), fetchStatus(plan))).stage, 'processing');
assert.deepEqual(await reconcileExchange(record, chainMock(), fetchStatus(plan)),
  { stage: 'completed', received: '9900000', sent: '10000000', destinationHash });
for (const [status, substatus, stage] of [['DONE', 'REFUNDED', 'refunded'], ['FAILED', 'UNKNOWN_ERROR', 'failed'], ['DONE', 'PARTIAL', 'partial']]) {
  assert.equal((await reconcileExchange(record, chainMock(), fetchStatus(plan, { ...statusFixture(plan), status, substatus }))).stage, stage);
}
assert.equal((await reconcileExchange(record, chainMock({ sourceStatus: 'reverted' }), fetchStatus(plan))).stage, 'reverted');
assert.equal((await reconcileExchange(recordFor(plan, approve, approvalHash), chainMock(), () => assert.fail())).stage, 'approval-only');
const samePlan = reviewExchangeRoute(routeFixture(5042), selection, networks);
let sameStatusCalls = 0;
const sameSettlement = await reconcileExchange(recordFor(samePlan), chainMock({ sourceLogs: [sourceDebit, transferLog(outsider)] }),
  () => { sameStatusCalls++; return new Response(null, { status: 404 }); });
assert.equal(sameSettlement.stage, 'completed');
assert.equal(sameStatusCalls, 0);

function harness(options = {}) {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const ledger = exchangeLedger(storage);
  const methods = [];
  let selected = options.selection ?? selection;
  const wallet = {
    getSelection: () => selected,
    getProvider: async () => ({ request: async ({ method }) => {
      assert.ok(['eth_chainId', 'eth_accounts'].includes(method));
      return method === 'eth_chainId' ? numberToHex(selected.chainId) : [account];
    } }),
  };
  const chainClient = id => ({
    ...chainMock()(id),
    getBalance: async () => options.hasGas === false ? 0n : 2n * 10n ** 18n,
    estimateGas: async () => 50_000n,
    getGasPrice: async () => 20_000_000_000n,
    getCode: async () => '0x01',
    readContract: async () => options.hasTokens === false ? 0n : 10_000_000n,
  });
  const send = createExchangeSender({ wallet, chainClient, ledger, active: () => options.inactive !== true, verifyFeeDeployment: options.verifyFeeDeployment,
    verifyPolicy: expected => assertCurrentFeePolicy(expected, async () => options.currentPolicy?.() ?? (options.plan ?? plan).feePolicy) });
  const signer = async tx => {
    methods.push(tx);
    await options.pause;
    if (options.reject) throw Object.assign(new Error('Declined'), { code: 4001 });
    if (options.unknown) throw new Error('Wallet state unavailable.');
    return tx.to === tokenAddress ? approvalHash : hash;
  };
  return { ledger, methods, send: tx => send(options.plan ?? plan, options.prepared ?? prepared, tx, signer), restored: exchangeLedger(storage),
    changeAccount: () => { selected = { ...selection, address: outsider }; } };
}
const h = harness();
assert.equal(await h.send(approve), approvalHash);
assert.equal(h.restored.get(account).stage, 'submitted');
assert.equal(h.restored.get(outsider), null);
assert.equal(await h.send(prepared), hash);
assert.equal(h.restored.get(account).approvals[0].hash, approvalHash);
await assert.rejects(h.send(prepared), /earlier exchange/);
assert.equal(h.methods.length, 2);
for (const options of [{ hasGas: false }, { hasTokens: false }, { inactive: true }]) {
  const trial = harness(options);
  await assert.rejects(trial.send(prepared));
  assert.equal(trial.methods.length, 0);
}
for (const destination of [5042, 8453]) {
  const quote = enabledRoute(destination);
  const plan = reviewExchangeRoute(quote, selection, feeNetworks, Date.now(), enabledFee);
  const prepared = preparedExchangeStep(plan, quote, selection, feeNetworks, enabledFee);
  const feeHarness = harness({ plan, prepared });
  assert.equal(await feeHarness.send(prepared), hash);
  assert.equal(feeHarness.methods[0].value, '0');
  assert.equal(feeHarness.restored.get(account).amount, '10000000');
  for (const options of [{ hasGas: false }, { hasTokens: false }]) {
    const trial = harness({ plan, prepared, ...options });
    await assert.rejects(trial.send(prepared));
    assert.equal(trial.methods.length, 0);
  }
}
for (const [make, selection] of [[baseNativeRoute, baseSelection], [polymerRoute, undefined]]) {
  const wallet = selection ?? { address: account, chainId: 5042, connectorId: 'injected', revision: 1 };
  const quote = make();
  const plan = reviewExchangeRoute(quote, wallet, feeNetworks, Date.now(), enabledFee);
  const prepared = preparedExchangeStep(plan, quote, wallet, feeNetworks, enabledFee);
  const options = { plan, prepared, selection: wallet };
  const wrongDeployment = harness(options);
  await assert.rejects(wrongDeployment.send(prepared), /inconsistent fee/);
  assert.equal(wrongDeployment.methods.length, 0);
  let verified = false;
  const trial = harness({ ...options, verifyFeeDeployment: async (_client, actualPlan, selector) => {
    assert.equal(actualPlan, plan);
    assert.equal(selector, prepared.data.slice(0, 10));
    verified = true;
  } });
  assert.equal(await trial.send(prepared), hash);
  assert.equal(verified, true);
  const recovered = trial.restored.get(account);
  assert.equal(recovered.value, plan.maximumValue);
  if (plan.tool === 'polymerStandard') assert.equal(recovered.polymerBurnAmount, '9963007');
  const recoveryClient = id => ({
    getChainId: async () => id,
    getTransaction: async () => ({ hash, from: account, to: plan.router, input: prepared.data, value: BigInt(recovered.value) }),
    getTransactionReceipt: async ({ hash: txHash }) => ({
      transactionHash: txHash, status: 'success',
      logs: plan.tool === 'polymerStandard' ? [transferLog(tokenAddress, plan.router, BigInt(plan.amount), account)] : [transferLog(baseToken)],
    }),
  });
  if (plan.tool === 'polymerStandard') {
    const transmitter = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
    const messenger = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
    const word32 = value => padHex(value, { size: 32 });
    const uint = (value, size = 32) => numberToHex(value, { size });
    const zero = word32(zeroAddress);
    const nonce = '0x' + '23'.repeat(32);
    const body = concatHex([uint(1, 4), word32(tokenAddress), word32(account), uint(BigInt(recovered.polymerBurnAmount)),
      word32(plan.router), zero, zero, zero]);
    const header = (id, finality) => concatHex([uint(1, 4), uint(26, 4), uint(6, 4), id,
      word32(messenger), word32(messenger), zero, uint(2000, 4), uint(finality, 4)]);
    const original = concatHex([header(zero, 0), body]);
    const attested = concatHex([header(nonce, 2000), body]);
    const events = parseAbi([
      'event MessageSent(bytes message)',
      'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
    ]);
    const sent = { address: transmitter, topics: encodeEventTopics({ abi: events, eventName: 'MessageSent' }),
      data: encodeAbiParameters([{ type: 'bytes' }], [original]) };
    const received = id => ({
      address: transmitter,
      topics: encodeEventTopics({ abi: events, eventName: 'MessageReceived',
        args: { caller: outsider, nonce: id, finalityThresholdExecuted: 2000 } }),
      data: encodeAbiParameters([{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }], [26, word32(messenger), body]),
    });
    const client = (id, receivedLog, sentLog) => ({
      ...recoveryClient(id),
      getTransactionReceipt: async ({ hash: txHash }) => receipt(txHash, 'success',
        id === 5042 ? [transferLog(tokenAddress, plan.router, BigInt(plan.amount), account), sentLog] :
          [transferLog(baseToken, account, BigInt(recovered.polymerBurnAmount)), receivedLog]),
    });
    const status = statusFixture(plan);
    status.sending.amount = recovered.polymerBurnAmount;
    status.receiving.amount = recovered.polymerBurnAmount;
    const fetch = message => async input => {
      const url = new URL(input);
      if (url.hostname === 'li.quest') return Response.json(status);
      assert.equal(url.origin + url.pathname, 'https://iris-api.circle.com/v2/messages/26');
      assert.equal(url.searchParams.get('transactionHash'), recovered.hash);
      return Response.json({ messages: [{ status: 'complete', message }] });
    };
    assert.deepEqual(await reconcileExchange(recovered, id => client(id, received(nonce), sent), fetch(attested)),
      { stage: 'completed', sent: plan.amount, received: recovered.polymerBurnAmount, destinationHash });
    assert.equal((await reconcileExchange(recovered, id => client(id, received(zero), sent), fetch(attested))).stage, 'processing');
    assert.equal((await reconcileExchange(recovered, id => client(id, received(nonce), { ...sent, address: outsider }), fetch(attested))).stage, 'processing');
    assert.equal((await reconcileExchange(recovered, id => client(id, received(nonce), sent), fetch(attested + '99'))).stage, 'processing');
  } else {
    assert.equal(recovered.refundsNativeInput, true);
    const status = statusFixture(plan, hash);
    assert.equal((await reconcileExchange(recovered, recoveryClient, async () => Response.json(status))).stage, 'completed');
    status.receiving.txHash = destinationHash;
    assert.equal((await reconcileExchange(recovered, recoveryClient, async () => Response.json(status))).stage, 'processing');
    status.receiving.txHash = hash;
    status.receiving.amount = '1';
    assert.equal((await reconcileExchange(recovered, recoveryClient, async () => Response.json(status))).stage, 'processing');
  }
}

const staleQuote = enabledRoute(5042);
const stalePlan = reviewExchangeRoute(staleQuote, selection, feeNetworks, Date.now(), enabledFee);
const stalePrepared = preparedExchangeStep(stalePlan, staleQuote, selection, feeNetworks, enabledFee);
assert.throws(() => preparedExchangeStep(stalePlan, staleQuote, selection, feeNetworks, { ...enabledFee, version: '2' }), /changed this route/);
const rolledBack = harness({ plan: stalePlan, prepared: stalePrepared, currentPolicy: () => ({ ...defaultFeePolicy, version: '2' }) });
await assert.rejects(rolledBack.send(stalePrepared), /fee policy changed/);
await assert.rejects(rolledBack.send(allowanceCall(SWAP_ROUTER, BigInt(stalePlan.amount))), /fee policy changed/);
assert.equal(rolledBack.methods.length, 0);
assert.equal(rolledBack.restored.get(account), null);

const rejection = harness({ reject: true });
await assert.rejects(rejection.send(prepared), /declined/i);
assert.equal(rejection.restored.get(account).stage, 'rejected');
const uncertain = harness({ unknown: true });
await assert.rejects(uncertain.send(prepared), /unavailable/i);
assert.equal(uncertain.restored.get(account).stage, 'unknown');
assert.equal(uncertain.restored.get(account).hash, null);
await assert.rejects(uncertain.send(prepared), /earlier exchange/);
const changed = harness();
changed.changeAccount();
await assert.rejects(changed.send(prepared), /wallet changed/);
assert.equal(changed.methods.length, 0);
let release;
const duplicate = harness({ pause: new Promise(resolve => { release = resolve; }) });
const first = duplicate.send(prepared);
await assert.rejects(duplicate.send(prepared), /already open/);
release();
await first;
assert.equal(duplicate.methods.length, 1);
console.log('Any Token mainnets, wallet guards, exact approvals, quote expiry, fees, source and destination receipts, refund handling and refresh recovery passed.');
