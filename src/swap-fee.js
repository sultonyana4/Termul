import { defaultFeePolicy } from './fee-policy.js';
import { decodeFunctionData, encodeFunctionData, parseAbi, zeroAddress } from 'viem';

export const TERMUL_INTEGRATOR = 'termul';
export const TERMUL_FEE_LABEL = 'Termul fee (0.1%)';
export const LIFI_FEE_WALLET = '0xc06ebbefd94032b85424d51906e2a335efae264b';
export const ARC_FEE_FORWARDER = '0x906A51f3d8dF12B7030D5299D1098dd89fFe830b';
export const FEE_ABI = parseAbi([
  'function forwardERC20Fees(address token, (address recipient, uint256 amount)[] distributions)',
  'function forwardNativeFees((address recipient, uint256 amount)[] distributions) payable',
]);

export const equalAddress = (a, b) => /^0x[0-9a-f]{40}$/i.test(a ?? '') && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const swapFee = defaultFeePolicy;

export function requireFee(condition) {
  if (!condition) throw new Error('LI.FI returned an unsupported or inconsistent fee.');
}

export const feeUnits = value => typeof value === 'string' && /^\d{1,78}$/.test(value) && BigInt(value) < 2n ** 256n ? BigInt(value) : null;
export const matchesFeeRate = (value, policy) => typeof value === 'number' ? value === policy.rate
  : typeof value === 'string' && (policy.bps ? /^0\.0010*$/ : /^0(?:\.0+)?$/).test(value);
export const noExtraDistributions = step => (step.distributionFees == null
  || (Array.isArray(step.distributionFees) && step.distributionFees.length === 0)) && step.intermediary == null;

export function decodeExact(abi, data) {
  requireFee(typeof data === 'string' && /^0x(?:[\da-f]{2}){4,12000}$/i.test(data));
  const decoded = decodeFunctionData({ abi, data });
  requireFee(encodeFunctionData({ abi, ...decoded }).toLowerCase() === data.toLowerCase());
  return decoded;
}

export function readFeeSplit(fee, token, amount, policy) {
  const total = feeUnits(fee?.amount);
  const integratorFee = feeUnits(fee?.feeSplit?.integratorFee);
  const providerFee = feeUnits(fee?.feeSplit?.lifiFee);
  const expected = amount * BigInt(policy.bps) / 10_000n;
  requireFee(total > 0n && total <= amount / 100n && fee.included === true && fee.name !== 'Distributions'
    && fee.feeSplit?.intermediaryFee == null
    && fee.token?.chainId === token.chainId && fee.token.decimals === token.decimals
    && equalAddress(fee.token.address, token.address) && integratorFee !== null && providerFee !== null
    && integratorFee === expected && total === integratorFee + providerFee
    && (!policy.bps || (expected > 0n && policy.recipient)));
  const distributions = [
    { name: 'lifi', recipient: LIFI_FEE_WALLET, amount: providerFee },
    { name: TERMUL_INTEGRATOR, recipient: policy.recipient, amount: integratorFee },
  ].filter(entry => entry.amount > 0n);
  const recipients = fee.feeSplit.recipients;
  if (recipients != null) {
    requireFee(Array.isArray(recipients) && recipients.length === distributions.length && distributions.every(expected =>
      recipients.some(entry => entry?.name === expected.name && feeUnits(entry.fee) === expected.amount
        && (entry.walletAddress == null || equalAddress(entry.walletAddress, expected.recipient))
        && [undefined, 'FIXED', 'SHARED', 'DYNAMIC'].includes(entry.type))));
  }
  return { total, integratorFee, providerFee, distributions };
}

export function validateFeeForwarding(step, forwarder, token, amount, fee, { refundsNativeInput = false } = {}) {
  const native = equalAddress(token, zeroAddress);
  const stepAmount = step?.fromAmount;
  const validAmount = native ? stepAmount === fee.total || (refundsNativeInput && stepAmount === amount) : stepAmount === amount;
  requireFee(forwarder && step?.requiresDeposit === true && equalAddress(step.callTo, forwarder)
    && equalAddress(step.approveTo, forwarder) && equalAddress(step.sendingAssetId, token)
    && equalAddress(step.receivingAssetId, token) && validAmount);
  const { functionName, args } = decodeExact(FEE_ABI, step.callData);
  requireFee(native ? functionName === 'forwardNativeFees'
    : functionName === 'forwardERC20Fees' && equalAddress(args[0], token));
  const distributions = native ? args[0] : args[1];
  requireFee(distributions.length === fee.distributions.length && fee.distributions.every(expected =>
    distributions.some(entry => equalAddress(entry.recipient, expected.recipient) && entry.amount === expected.amount)));
}
