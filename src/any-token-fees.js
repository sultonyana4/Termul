import { keccak256, padHex, parseAbi, zeroAddress } from 'viem';
import { SWAP_FACET, SWAP_ROUTER, SWAP_STEP, SWAP_TOKENS } from './swap-quote.js';
import {
  ARC_FEE_FORWARDER, TERMUL_INTEGRATOR, decodeExact, equalAddress, feeUnits, matchesFeeRate,
  noExtraDistributions, readFeeSplit, requireFee, validateFeeForwarding,
} from './swap-fee.js';

// LI.FI's published mainnet deployments. Keep the chain catalog for discovery,
// but pin the contracts trusted by fee-enabled transactions.
const standard = ['0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', '0xDe2b920506EE931a6A2ABDF566526220214FBbAE'];
const sharedForwarder = '0x735cCB84BCdeABF820c69adA959f7C7C41F54f86';
const sharedDeployment = ['0x864b314D4C5a0399368609581d3E8933a63b9232', sharedForwarder];
const deployments = {
  5042: [SWAP_ROUTER, ARC_FEE_FORWARDER],
  1: standard, 8453: standard, 42161: standard, 10: standard, 137: standard,
  43114: standard, 480: standard, 146: standard, 1329: standard,
  130: sharedDeployment, 57073: sharedDeployment,
  59144: ['0xDE1E598b81620773454588B85D6b5D4eEC32573e', '0xd7C2Aa1BfD2Aa089D1a9e2b3ecd7cc0A6b268FcF'],
  50: ['0x055d4612Ec74aD799C6cB4dF72C0Ab8dbDBCBAfa', '0x4a6Fb49C2eB4FBc4C70Fb2088EE37A1205cBd2f0'],
  98866: ['0x6f5C8Bb0C5Fe4ECeAC40EE1C238EaB6bbb29761c', '0x15583505386A1a952b8d515b6bF052134c3f14e0'],
  143: ['0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37', sharedForwarder],
  2818: ['0xF7aB42D00D2399f8A4Fba2F15466Be40709fe307', '0xa912b4E9e964E4E4AbA11e4463d84a65B384E7df'],
};

// These deployments were checked with eth_getCode and an eth_call refund probe.
const nativeRefundFacet = {
  5042: [SWAP_FACET, '0xdb3f706ca7f78237a197ccab9300628db168f0bc6c509835771200f9c163daa5'],
  8453: ['0x02db8a1c2170aee6cd17715ecd1c567c9b296e2c', '0xe014807aa0af9c5f735ccb002e1a54ae9152986b5f17143ba7c0c52899545040'],
};
const polymer = {
  5042: { domain: 26, token: SWAP_TOKENS.USDC.address, facet: '0xbbdfff46ed41b4b56bc73ab6466d523c284adc8a',
    hash: '0x9ca7f990c9ce93092148166491ce478b9fb8d6a998355c4d91f709a9fd38aace' },
  8453: { domain: 6, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', facet: '0x5e79e8c67cc7fed03b283e84a5e16500f094b6b5',
    hash: '0x9edfe421526ca1388d1a99a35f375c3f617fae8d77873e67b559e9ba869b0b3f' },
};
export const polymerDomain = chain => polymer[chain]?.domain;
const feeForwarderCodeHash = '0x99a76627aece8903612e0246c10f13a46e511a0a074d9a4e68987a28c78ebd52';
const deploymentAbi = parseAbi([
  'function facetAddress(bytes4 selector) view returns (address)',
  'function getChainIdToDomainId(uint256 chainId) view returns (uint32)',
]);

export async function verifyFeeRouteDeployment(client, plan, selector) {
  const isPolymer = plan.tool === 'polymerStandard';
  const [facet, facetHash] = isPolymer ? [polymer[plan.fromChain].facet, polymer[plan.fromChain].hash]
    : nativeRefundFacet[plan.fromChain];
  const read = (functionName, args) => client.readContract({ address: plan.router, abi: deploymentAbi, functionName, args });
  const [currentFacet, facetCode, forwarderCode, destinationDomain] = await Promise.all([
    read('facetAddress', [selector]),
    client.getCode({ address: facet }),
    client.getCode({ address: plan.fee.forwarder }),
    isPolymer ? read('getChainIdToDomainId', [BigInt(plan.toChain)]) : undefined,
  ]);
  requireFee(equalAddress(currentFacet, facet) && facetCode && keccak256(facetCode) === facetHash
    && forwarderCode && keccak256(forwarderCode) === feeForwarderCodeHash
    && (!isPolymer || destinationDomain === polymerDomain(plan.toChain)));
}

const bridge = '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)';
const across = '(bytes32 receiverAddress, bytes32 refundAddress, bytes32 sendingAssetId, bytes32 receivingAssetId, uint256 outputAmount, uint128 outputAmountMultiplier, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)';
const polymerData = '(uint256 polymerTokenFee, uint256 maxCCTPFee, bytes32 nonEVMReceiver, bytes32 solanaReceiverATA, uint32 minFinalityThreshold, address refundRecipient, bytes hookData)';
export const EXCHANGE_FEE_ABI = parseAbi([
  ...['ERC20ToERC20', 'ERC20ToNative', 'NativeToERC20'].map(direction =>
    `function swapTokensMultipleV3${direction}(bytes32 id, string integrator, string referrer, address receiver, uint256 minAmount, ${SWAP_STEP}[] swapData)`),
  `function swapAndStartBridgeTokensViaPolymerCCTP(${bridge} bridgeData, ${SWAP_STEP}[] swapData, ${polymerData} polymerData) payable`,
  `function swapAndStartBridgeTokensViaAcrossV4(${bridge} bridgeData, ${SWAP_STEP}[] swapData, ${across} acrossData) payable`,
]);

export function reviewExchangeFee(step, router, policy) {
  const costs = step.estimate.feeCosts ?? [];
  const parts = step.includedSteps ?? [];
  requireFee(noExtraDistributions(step) && Array.isArray(costs)
    && (step.fee == null || matchesFeeRate(step.fee, policy)));
  const isSplit = fee => fee?.feeSplit != null;
  const isExtra = fee => fee?.name === 'Distributions' || fee?.feeSplit?.intermediaryFee != null
    || fee?.feeSplit?.recipients?.some(recipient => ['DISTRIBUTION', 'INTERMEDIARY'].includes(recipient.type));
  requireFee(costs.every(fee => fee && !isExtra(fee))
    && parts.every(part => noExtraDistributions(part) && (part.estimate?.feeCosts ?? []).every(fee => fee && !isExtra(fee))));
  const splits = costs.filter(isSplit);
  if (!policy.bps) {
    const hasNoIntegrator = fee => !isSplit(fee) || feeUnits(fee.feeSplit.integratorFee) === 0n;
    requireFee(costs.every(hasNoIntegrator) && parts.every(part => (part.estimate?.feeCosts ?? []).every(hasNoIntegrator)));
    return null;
  }

  const { action } = step;
  const deployment = deployments[action.fromChainId];
  const isPolymer = step.tool === 'polymerStandard';
  const directPolymer = isPolymer && action.fromChainId !== action.toChainId
    && equalAddress(action.fromToken.address, polymer[action.fromChainId]?.token)
    && equalAddress(action.toToken.address, polymer[action.toChainId]?.token)
    && action.fromToken.decimals === 6 && action.toToken.decimals === 6;
  const supportedBridge = directPolymer || (step.tool === 'across'
    && !equalAddress(action.fromToken.address, zeroAddress) && !equalAddress(action.toToken.address, zeroAddress));
  requireFee(step.integrator === TERMUL_INTEGRATOR && deployment && equalAddress(router, deployment[0])
    && (isPolymer ? directPolymer : action.fromChainId === action.toChainId || supportedBridge)
    && !step.destinationAction && !step.amountFlexible && !step.typedData?.length
    && (action.fromAmountForGas == null || feeUnits(action.fromAmountForGas) === 0n)
    && splits.length === 1 && costs.every(fee => fee.included === true));
  const amount = feeUnits(action.fromAmount);
  requireFee(amount > 0n && feeUnits(step.estimate.toAmountMin) > 0n && feeUnits(step.estimate.toAmount) >= feeUnits(step.estimate.toAmountMin)
    && feeUnits(step.estimate.fromAmount) === amount);
  const fee = readFeeSplit(splits[0], action.fromToken, amount, policy);
  const collection = parts.filter(part => part.tool === 'feeCollection');
  const feeAction = collection[0]?.action;
  const matchesSource = token => token?.chainId === action.fromChainId && token.decimals === action.fromToken.decimals
    && equalAddress(token.address, action.fromToken.address);
  requireFee(collection.length === 1 && collection[0].type === 'protocol'
    && feeAction?.fromChainId === action.fromChainId && feeAction.toChainId === action.fromChainId
    && matchesSource(feeAction.fromToken) && matchesSource(feeAction.toToken) && feeUnits(feeAction.fromAmount) === amount
    && parts.every(part => part === collection[0] || (part.estimate?.feeCosts ?? []).every(cost => !isSplit(cost))));
  const collectionCosts = collection[0].estimate?.feeCosts;
  requireFee(Array.isArray(collectionCosts) && collectionCosts.length === 1
    && feeUnits(collection[0].estimate.fromAmount) === amount
    && feeUnits(collection[0].estimate.toAmount) === amount - fee.total);
  const collectionFee = readFeeSplit(collectionCosts[0], action.fromToken, amount, policy);
  requireFee(collectionFee.total === fee.total);
  let polymerFee;
  if (directPolymer) {
    const providerCosts = costs.filter(cost => !isSplit(cost));
    requireFee(providerCosts.length <= 1);
    const [providerCost] = providerCosts;
    polymerFee = providerCost ? feeUnits(providerCost.amount) : 0n;
    requireFee(polymerFee !== null && fee.total + polymerFee <= amount / 100n
      && (!providerCost || (providerCost.name === 'Polymer fee' && matchesSource(providerCost.token))));
  }
  return { ...fee, polymerFee, forwarder: deployment[1] };
}

export function validateExchangeFeeTransaction(plan, data, value) {
  const { fee, account, router, fromToken, toToken, fromChain, toChain, tool } = plan;
  const source = fromToken.address;
  const destination = toToken.address;
  const amount = BigInt(plan.amount);
  const remainder = amount - fee.total;
  const minimum = BigInt(plan.minimum);
  const nativeIn = equalAddress(source, zeroAddress);
  const nativeOut = equalAddress(destination, zeroAddress);
  requireFee(value === (nativeIn ? amount : 0n));
  const { functionName, args } = decodeExact(EXCHANGE_FEE_ABI, data);
  if (fromChain === toChain) {
    const direction = nativeIn ? 'NativeToERC20' : nativeOut ? 'ERC20ToNative' : 'ERC20ToERC20';
    const [, integrator, referrer, receiver, min, swaps] = args;
    requireFee(functionName === 'swapTokensMultipleV3' + direction && integrator === TERMUL_INTEGRATOR
      && equalAddress(referrer, zeroAddress) && equalAddress(receiver, account) && min >= minimum && swaps.length === 2);
    const refundsNativeInput = nativeIn && swaps[0].fromAmount === amount;
    if (refundsNativeInput) requireFee(nativeRefundFacet[fromChain]);
    validateFeeForwarding(swaps[0], fee.forwarder, source, amount, fee, { refundsNativeInput });
    const swap = swaps[1];
    requireFee(!swap.requiresDeposit && equalAddress(swap.sendingAssetId, source) && equalAddress(swap.receivingAssetId, destination)
      && swap.fromAmount === remainder && equalAddress(swap.callTo, swap.approveTo)
      && ![router, fee.forwarder, source, destination, zeroAddress].some(address => equalAddress(swap.callTo, address)));
    return { refundsNativeInput };
  }

  const isPolymer = tool === 'polymerStandard';
  requireFee(!nativeIn && !nativeOut && (isPolymer
    ? functionName === 'swapAndStartBridgeTokensViaPolymerCCTP'
    : tool === 'across' && functionName === 'swapAndStartBridgeTokensViaAcrossV4'));
  const [transfer, swaps, params] = args;
  const recipient = padHex(account, { size: 32 }).toLowerCase();
  const sameBytes = (encoded, address) => encoded.toLowerCase() === padHex(address, { size: 32 }).toLowerCase();
  requireFee(swaps.length === 1 && transfer.bridge === tool && transfer.integrator === TERMUL_INTEGRATOR
    && equalAddress(transfer.referrer, zeroAddress) && equalAddress(transfer.receiver, account)
    && equalAddress(transfer.sendingAssetId, source) && transfer.destinationChainId === BigInt(toChain)
    && transfer.hasSourceSwaps && !transfer.hasDestinationCall && transfer.minAmount === remainder);
  validateFeeForwarding(swaps[0], fee.forwarder, source, amount, fee);
  if (isPolymer) {
    const burn = remainder - fee.polymerFee;
    requireFee(params.polymerTokenFee === fee.polymerFee && params.maxCCTPFee === 0n && params.minFinalityThreshold === 2000
      && equalAddress(params.refundRecipient, account) && params.hookData === '0x'
      && sameBytes(params.nonEVMReceiver, zeroAddress) && sameBytes(params.solanaReceiverATA, zeroAddress)
      && burn >= minimum);
    return { polymerBurnAmount: burn.toString() };
  }
  requireFee(sameBytes(params.sendingAssetId, source) && sameBytes(params.receivingAssetId, destination)
    && params.receiverAddress.toLowerCase() === recipient && params.refundAddress.toLowerCase() === recipient
    && params.message === '0x' && remainder * params.outputAmountMultiplier / 10n ** 18n >= minimum);
}
