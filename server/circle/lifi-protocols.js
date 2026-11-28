import { decodeEventLog, erc20Abi, keccak256, padHex, parseAbi, zeroAddress } from 'viem';
import { EXCHANGE_FEE_ABI } from '../../src/any-token-fees.js';
import { decodeExact, equalAddress, feeUnits, matchesFeeRate, noExtraDistributions, readFeeSplit,
  TERMUL_INTEGRATOR, validateFeeForwarding } from '../../src/swap-fee.js';
import { verifyPolymerSettlement } from '../../src/polymer-settlement.js';
import { circleLifiPairs } from '../../src/circle-lifi-routes.js';
import { lifiNetworks } from './lifi-networks.js';

const word = address => padHex(address, { size: 32 }).toLowerCase();
const zero = word(zeroAddress);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const isHash = value => /^0x[a-f0-9]{64}$/i.test(value ?? '');
const requireTerms = ok => { if (!ok) throw new Error('LI.FI route is outside the reviewed execution policy.'); };

const events = parseAbi([
  'event LiFiTransferStarted((bytes32 transactionId,string bridge,string integrator,address referrer,address sendingAssetId,address receiver,uint256 minAmount,uint256 destinationChainId,bool hasSourceSwaps,bool hasDestinationCall) bridgeData)',
  'event FundsDeposited(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint256 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 indexed depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes message)',
  'event FilledRelay(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 repaymentChainId,uint256 indexed originChainId,uint256 indexed depositId,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 exclusiveRelayer,bytes32 indexed relayer,bytes32 depositor,bytes32 recipient,bytes32 messageHash,(bytes32 updatedRecipient,bytes32 updatedMessageHash,uint256 updatedOutputAmount,uint8 fillType) relayExecutionInfo)',
]);
export const transferEvent = events[0];
export const depositEvent = events[1];
export const fillEvent = events[2];

function eventLogs(receipt, address, eventName) {
  return (receipt.logs ?? []).flatMap(log => {
    if (log.removed || !same(log.address, address) || log.transactionHash !== receipt.transactionHash ||
        log.blockHash !== receipt.blockHash) return [];
    try { return [decodeEventLog({ abi: [...events, ...erc20Abi], eventName, topics: log.topics, data: log.data }).args]; }
    catch { return []; }
  });
}
function netIncome(receipt, token, address) {
  return eventLogs(receipt, token, 'Transfer').reduce((sum, received) =>
    sum + (equalAddress(received.to, address) ? received.value : 0n) - (equalAddress(received.from, address) ? received.value : 0n), 0n);
}

export function validateLifiQuote(quote, intent, policy, now = Date.now()) {
  const { fromChain, toChain, account, amount: input } = intent;
  const source = lifiNetworks[fromChain], destination = lifiNetworks[toChain];
  const tool = circleLifiPairs[fromChain + ':' + toChain];
  const { action, estimate, transactionRequest: tx, includedSteps: parts } = quote ?? {};
  const amount = feeUnits(input);
  const min = feeUnits(estimate?.toAmountMin), output = feeUnits(estimate?.toAmount);
  const token = (raw, chainId, expected) => raw?.chainId === chainId && raw.decimals === 6 && equalAddress(raw.address, expected);
  requireTerms(tool && amount > 0n && quote.type === 'lifi' && quote.tool === tool &&
    typeof quote.id === 'string' && quote.id.length > 0 && quote.id.length <= 180 &&
    quote.integrator === TERMUL_INTEGRATOR && (quote.fee == null || matchesFeeRate(quote.fee, policy)) &&
    noExtraDistributions(quote) && !quote.destinationAction && !quote.amountFlexible &&
    !quote.typedData?.length && !quote.permit && !quote.permit2 &&
    action?.fromChainId === fromChain && action.toChainId === toChain &&
    action.slippage === 0.005 && equalAddress(action.fromAddress, account) && equalAddress(action.toAddress, account) &&
    (action.fromAmountForGas == null || feeUnits(action.fromAmountForGas) === 0n) &&
    token(action.fromToken, fromChain, source.token[0]) && token(action.toToken, toChain, destination.token[0]) &&
    feeUnits(action.fromAmount) === amount && feeUnits(estimate?.fromAmount) === amount &&
    min > 0n && output >= min && min * 1000n >= output * 995n && min * 100n >= amount * 98n && output <= amount &&
    equalAddress(estimate.approvalAddress, source.router) && tx?.chainId === fromChain &&
    equalAddress(tx.from, account) && equalAddress(tx.to, source.router) && /^(0x0+|0)$/.test(tx.value ?? '0'));
  const costs = estimate.feeCosts;
  requireTerms(Array.isArray(costs) && costs.length > 0 && costs.length <= 5 && costs.every(c =>
    c.included === true && c.name !== 'Distributions' && c.feeSplit?.intermediaryFee == null &&
    token(c.token, fromChain, source.token[0]) && feeUnits(c.amount) !== null));
  requireTerms(Array.isArray(parts) && parts.length === 2 &&
    parts.every(part => noExtraDistributions(part) && !part.typedData?.length && !part.permit && !part.permit2));
  const [collect, transfer] = parts;
  const split = costs.filter(c => c.feeSplit != null);
  requireTerms(collect.tool === 'feeCollection' && collect.type === 'protocol' && transfer.tool === tool && transfer.type === 'cross' &&
    split.length === 1 && collect.estimate?.feeCosts?.length === 1 &&
    collect.action?.fromChainId === fromChain && collect.action?.toChainId === fromChain &&
    token(collect.action?.fromToken, fromChain, source.token[0]) && token(collect.action?.toToken, fromChain, source.token[0]) &&
    transfer.action?.fromChainId === fromChain && transfer.action?.toChainId === toChain &&
    token(transfer.action?.fromToken, fromChain, source.token[0]) && token(transfer.action?.toToken, toChain, destination.token[0]));
  const fee = readFeeSplit(split[0], action.fromToken, amount, policy);
  const collected = readFeeSplit(collect.estimate.feeCosts[0], action.fromToken, amount, policy);
  const other = costs.filter(c => !c.feeSplit);
  const remainder = amount - fee.total;
  requireTerms(collected.total === fee.total && feeUnits(collect.action.fromAmount) === amount &&
    feeUnits(collect.estimate.fromAmount) === amount && feeUnits(collect.estimate.toAmount) === remainder &&
    feeUnits(transfer.action.fromAmount) === remainder &&
    !(transfer.estimate?.feeCosts ?? []).some(c => c.feeSplit || c.name === 'Distributions'));

  const { functionName, args } = decodeExact(EXCHANGE_FEE_ABI, tx.data);
  requireTerms(functionName === (tool === 'across' ? 'swapAndStartBridgeTokensViaAcrossV4' : 'swapAndStartBridgeTokensViaPolymerCCTP'));
  const [bridge, swaps, protocol] = args;
  requireTerms(isHash(bridge.transactionId) && bridge.bridge === tool && bridge.integrator === TERMUL_INTEGRATOR &&
    equalAddress(bridge.referrer, zeroAddress) && equalAddress(bridge.receiver, account) &&
    equalAddress(bridge.sendingAssetId, source.token[0]) && bridge.minAmount === remainder &&
    bridge.destinationChainId === BigInt(toChain) && bridge.hasSourceSwaps === true && bridge.hasDestinationCall === false && swaps.length === 1);
  validateFeeForwarding(swaps[0], source.forwarder, source.token[0], amount, fee);
  const recipient = word(account);
  const plan = { fromChain, toChain, account, amount: input, minimum: String(min), quoteId: quote.id, tool,
    router: source.router, fromToken: { address: source.token[0], decimals: 6 }, toToken: { address: destination.token[0], decimals: 6 },
    data: tx.data, routeKey: bridge.transactionId, integratorFee: String(fee.integratorFee), lifiFee: String(fee.providerFee) };

  if (tool === 'polymerStandard') {
    requireTerms(other.length <= 1 && (!other.length || other[0].name === 'Polymer fee'));
    const charge = other.length ? feeUnits(other[0].amount) : 0n;
    const burn = remainder - charge;
    requireTerms(protocol.polymerTokenFee === charge && protocol.maxCCTPFee === 0n &&
      protocol.minFinalityThreshold === 2000 && equalAddress(protocol.refundRecipient, account) && protocol.hookData === '0x' &&
      same(protocol.nonEVMReceiver, zero) && same(protocol.solanaReceiverATA, zero) && burn >= min && burn === output);
    return { ...plan, polymerBurnAmount: String(burn), bridgeFee: String(amount - burn - fee.total) };
  }
  const received = remainder * protocol.outputAmountMultiplier / 10n ** 18n;
  const time = Math.floor(now / 1000);
  requireTerms(same(protocol.receiverAddress, recipient) && same(protocol.refundAddress, recipient) &&
    same(protocol.sendingAssetId, word(source.token[0])) && same(protocol.receivingAssetId, word(destination.token[0])) &&
    same(protocol.exclusiveRelayer, zero) && protocol.exclusivityParameter === 0 && protocol.message === '0x' &&
    protocol.quoteTimestamp >= time - 300 && protocol.quoteTimestamp <= time + 15 && protocol.fillDeadline > time + 60 &&
    protocol.fillDeadline <= time + 12 * 60 * 60 && protocol.outputAmount === output && received >= min && received <= output);
  return { ...plan, bridgeFee: String(remainder - received), deposit: {
    input: String(remainder), output: String(received), quoteTimestamp: protocol.quoteTimestamp, fillDeadline: protocol.fillDeadline,
  } };
}

export async function quoteLifi(intent, policy, { fetcher = fetch, now = Date.now } = {}) {
  const { fromChain, toChain, account, amount } = intent;
  const tool = circleLifiPairs[fromChain + ':' + toChain];
  requireTerms(tool);
  const q = new URLSearchParams({
    fromChain, toChain, fromToken: lifiNetworks[fromChain].token[0], toToken: lifiNetworks[toChain].token[0],
    fromAmount: amount, fromAddress: account, toAddress: account, integrator: TERMUL_INTEGRATOR,
    fee: String(policy.rate), slippage: '0.005', allowBridges: tool,
  });
  async function read(path, options) {
    const response = await fetcher('https://li.quest/v1/' + path, {
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(6500), ...options,
    });
    if (!response.ok) throw new Error('LI.FI did not provide a supported quote.');
    return response.json();
  }
  const raw = await read('quote?' + q);
  const original = validateLifiQuote(raw, intent, policy, now());
  const { transactionRequest, ...step } = raw;
  const prepared = await read('advanced/stepTransaction', {
    method: 'POST', body: JSON.stringify(step), headers: { 'Content-Type': 'application/json' },
  });
  const plan = validateLifiQuote(prepared, intent, policy, now());
  requireTerms(plan.quoteId === original.quoteId && BigInt(plan.minimum) >= BigInt(original.minimum) &&
    plan.integratorFee === original.integratorFee && plan.lifiFee === original.lifiFee);
  return plan;
}

export function proveLifiSource(plan, receipt) {
  if (netIncome(receipt, plan.fromToken.address, plan.account) !== -BigInt(plan.amount)) return null;
  const started = eventLogs(receipt, plan.router, 'LiFiTransferStarted').filter(({ bridgeData: b }) =>
    same(b.transactionId, plan.routeKey) && b.bridge === plan.tool && b.integrator === TERMUL_INTEGRATOR &&
    equalAddress(b.receiver, plan.account) && b.destinationChainId === BigInt(plan.toChain) &&
    equalAddress(b.sendingAssetId, plan.fromToken.address) && b.hasSourceSwaps && !b.hasDestinationCall);
  if (started.length !== 1) return null;
  if (plan.tool === 'polymerStandard') return { tool: plan.tool };
  const { input, output, quoteTimestamp, fillDeadline } = plan.deposit;
  const match = eventLogs(receipt, lifiNetworks[plan.fromChain].pool[0], 'FundsDeposited').filter(e =>
    same(e.inputToken, word(plan.fromToken.address)) && same(e.outputToken, word(plan.toToken.address)) &&
    e.inputAmount === BigInt(input) && e.outputAmount === BigInt(output) && e.quoteTimestamp === quoteTimestamp &&
    e.fillDeadline === fillDeadline && e.exclusivityDeadline === 0 && same(e.exclusiveRelayer, zero) &&
    e.destinationChainId === BigInt(plan.toChain) && same(e.recipient, word(plan.account)) &&
    same(e.depositor, word(plan.account)) && e.message === '0x');
  return match.length === 1 ? { tool: plan.tool, depositId: String(match[0].depositId) } : null;
}

export async function proveLifiDestination(plan, proof, source, destination, fetcher) {
  const amount = netIncome(destination, plan.toToken.address, plan.account);
  if (amount < BigInt(plan.minimum)) return null;
  if (plan.tool === 'polymerStandard') {
    const inReceipt = receipt => ({ ...receipt, logs: receipt.logs.filter(log => !log.removed &&
      log.transactionHash === receipt.transactionHash && log.blockHash === receipt.blockHash) });
    return amount === BigInt(plan.polymerBurnAmount) &&
      await verifyPolymerSettlement({ ...plan, hash: source.transactionHash }, inReceipt(source), inReceipt(destination), fetcher)
      ? String(amount) : null;
  }
  const empty = keccak256('0x');
  const { fillDeadline, input, output } = plan.deposit;
  const matches = eventLogs(destination, lifiNetworks[plan.toChain].pool[0], 'FilledRelay').filter(e =>
    e.originChainId === BigInt(plan.fromChain) && e.depositId === BigInt(proof.depositId) &&
    same(e.inputToken, word(plan.fromToken.address)) && same(e.outputToken, word(plan.toToken.address)) &&
    e.inputAmount === BigInt(input) && e.outputAmount === BigInt(output) && amount === e.outputAmount &&
    e.fillDeadline === fillDeadline && e.exclusivityDeadline === 0 && same(e.exclusiveRelayer, zero) &&
    same(e.depositor, word(plan.account)) && same(e.recipient, word(plan.account)) && [zero, empty].some(h => same(e.messageHash, h)) &&
    same(e.relayExecutionInfo.updatedRecipient, word(plan.account)) &&
    [zero, empty].some(h => same(e.relayExecutionInfo.updatedMessageHash, h)) && e.relayExecutionInfo.updatedOutputAmount === amount);
  return matches.length === 1 ? String(amount) : null;
}
