import { concatHex, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, keccak256, numberToHex, parseAbi, zeroAddress } from 'viem';
import { FEE_ABI, FEE_FORWARDER, FLY_ABI, FLY_ROUTER, SWAP_ABI, SWAP_ROUTER, SWAP_TOKENS } from '../src/swap-quote.js';

import { LIFI_FEE_WALLET, TERMUL_INTEGRATOR } from '../src/swap-fee.js';

import { parseFeePolicy, TERMUL_FEE_RECIPIENT } from '../src/fee-policy.js';

export const feeRecipient = TERMUL_FEE_RECIPIENT;
export const enabledFee = parseFeePolicy({ version: '1', bps: 10, recipient: feeRecipient });

export const account = '0x' + '12'.repeat(20);
export const swapHash = '0x' + '45'.repeat(32);
export const approvalHash = '0x' + '56'.repeat(32);
export const transactionId = '0x' + 'ab'.repeat(32);
export const quotedInput = 10_000_000n;
export const quotedOutput = 9_100_000n;
export const actualOutput = 9_095_000n;
export const minimum = 9_054_500n;
export const completionAbi = parseAbi([
  'event LiFiGenericSwapCompleted(bytes32 indexed transactionId,string integrator,string referrer,address receiver,address fromAssetId,address toAssetId,uint256 fromAmount,uint256 toAmount)',
]);

export function quoteFixture({ from = SWAP_TOKENS.USDC, to = SWAP_TOKENS.EURC, amount = quotedInput, account: sender = account, policy } = {}) {
  const token = asset => ({ ...asset, chainId: 5042 });
  const providerFee = amount / 400n;
  const integratorFee = policy?.bps ? amount / 1000n : 0n;
  const fee = providerFee + integratorFee;
  const step = (destination, output, inputAmount, callData, requiresDeposit) => ({
    callTo: destination, approveTo: destination, sendingAssetId: from.address, receivingAssetId: output.address,
    fromAmount: inputAmount, callData, requiresDeposit,
  });
  const feeData = encodeFunctionData({ abi: FEE_ABI, functionName: 'forwardERC20Fees', args: [
    from.address, [
      { recipient: LIFI_FEE_WALLET, amount: providerFee },
      ...(integratorFee ? [{ recipient: feeRecipient, amount: integratorFee }] : []),
    ],
  ] });
  const packed = concatHex(['0x01bd0080', SWAP_ROUTER, from.address, to.address, numberToHex(amount - fee, { size: 32 }), '0x01']);
  const flyData = encodeFunctionData({ abi: FLY_ABI, functionName: 'swapWithBackendSignature', args: [packed] });
  const data = encodeFunctionData({ abi: SWAP_ABI, functionName: 'swapTokensMultipleV3ERC20ToERC20', args: [
    transactionId, TERMUL_INTEGRATOR, zeroAddress, sender, minimum, [
      step(FEE_FORWARDER, from, amount, feeData, true), step(FLY_ROUTER, to, amount - fee, flyData, false),
    ],
  ] });
  return {
    type: 'lifi', tool: 'fly', integrator: TERMUL_INTEGRATOR, fee: policy?.rate ?? 0, transactionId,
    action: { fromChainId: 5042, toChainId: 5042, fromAddress: sender, toAddress: sender,
      fromToken: token(from), toToken: token(to), fromAmount: String(amount), slippage: 0.005 },
    estimate: { approvalAddress: SWAP_ROUTER, fromAmount: String(amount), toAmount: String(quotedOutput), toAmountMin: String(minimum),
      priceImpact: '0.12', gasCosts: [{ token: { address: zeroAddress, chainId: 5042, decimals: 18 }, amount: '10000000000000000' }],
      feeCosts: [{ name: 'LIFI Fixed Fee', amount: String(fee), included: true, token: token(from),
        feeSplit: { integratorFee: String(integratorFee), lifiFee: String(providerFee) } }],
    },
    transactionRequest: { from: sender, to: SWAP_ROUTER, data, value: '0x0', chainId: 5042, gasLimit: '600000' },
  };
}

export function settlementFixture({ from, to, amount, account, integrator = TERMUL_INTEGRATOR }, received = actualOutput) {
  const transfer = (token, sender, recipient, amount) => ({
    address: token.address, transactionHash: swapHash,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: sender, to: recipient } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  });
  return [
    transfer(from, account, SWAP_ROUTER, amount),
    transfer(to, SWAP_ROUTER, account, received),
    {
      address: SWAP_ROUTER, transactionHash: swapHash,
      topics: encodeEventTopics({ abi: completionAbi, eventName: 'LiFiGenericSwapCompleted', args: { transactionId } }),
      data: encodeAbiParameters(
        ['string', 'string', 'address', 'address', 'address', 'uint256', 'uint256'].map(type => ({ type })),
        [integrator, zeroAddress, account, from.address, to.address, amount, received],
      ),
    },
  ];
}

export function recordFixture(context, data) {
  return { account: context.account, from: context.from.symbol, to: context.to.symbol, amount: context.amount.toString(),
    minimum: minimum.toString(), integrator: TERMUL_INTEGRATOR, phase: 'swap', state: 'pending', dataHash: keccak256(data), id: transactionId, hash: swapHash };
}
