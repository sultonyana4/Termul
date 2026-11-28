import {
  decodeErrorResult, decodeFunctionData, encodeFunctionData, formatUnits,
  keccak256, numberToHex, parseAbi, parseUnits, stringToHex,
} from 'viem';
import { TERMUL_MAINNET } from '../../supabase/functions/_shared/termul-mainnet.js';
import { checkArcDeployment } from '../../src/arc-read.js';

export const invoiceAbi = parseAbi([
  'function createInvoice(bytes32 invoiceId, uint256 amount, uint64 expiresAt)',
  'function payInvoice(address merchant, bytes32 invoiceId) payable',
  'function getInvoice(address merchant, bytes32 invoiceId) view returns ((address merchant, uint256 amount, uint64 expiresAt, uint8 status))',
  'event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint64 expiresAt)',
  'event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount)',
  'error InvalidInvoiceId()',
  'error InvalidAmount()',
  'error InvalidExpiry()',
  'error InvoiceAlreadyExists()',
  'error InvoiceNotOpen()',
  'error InvoiceExpired()',
  'error WrongAmount()',
  'error MerchantTransferFailed()',
  'error ReentrantCall()',
]);

const nativeDecimals = 18;
const gweiDecimals = 9;
const arcFeeFloor = 20_000_000_000n;
const invoiceId = keccak256(stringToHex('termul-circle-poc:managed-preflight:2b.1'));
const invoiceAmount = parseUnits('0.01', nativeDecimals);

export function reviewedInvoiceCalls(sender) {
  return [
    { functionName: 'createInvoice', args: [invoiceId, invoiceAmount, 0n], value: 0n },
    { functionName: 'payInvoice', args: [sender, invoiceId], value: invoiceAmount },
  ].map(({ functionName, args, value }) => {
    const data = encodeFunctionData({ abi: invoiceAbi, functionName, args });
    const decoded = decodeFunctionData({ abi: invoiceAbi, data });
    if (decoded.functionName !== functionName || decoded.args.some((arg, i) =>
      String(arg).toLowerCase() !== String(args[i]).toLowerCase())) {
      throw new Error('The fixed Termul calldata failed its round-trip check.');
    }
    return { functionName, args: decoded.args.map(String), value, data };
  });
}

export async function verifyManagedDeployment(arc, network = TERMUL_MAINNET) {
  const { id: chainId, contractAddress: address } = network;
  const status = await checkArcDeployment(arc, network, code => /^0x(?:[0-9a-f]{2})+$/i.test(code ?? '') ? keccak256(code) : null);
  if (status === 'wrong-chain') return { status };
  if (status !== 'verified') return { status: 'runtime-mismatch', chainId, address };
  return { status: 'verified', chainId, address, runtimeHash: network.runtimeHash,
    deploymentBlock: String(network.deploymentBlock) };
}

function positiveQuantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value) || BigInt(value) <= 0n) {
    throw new Error('Invalid RPC quantity.');
  }
  return BigInt(value);
}

function decimalUnits(value, decimals) {
  if (typeof value !== 'string' || value.length > 79
    || !new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(value)) {
    throw new Error('Invalid Circle decimal amount.');
  }
  return parseUnits(value, decimals);
}

export function normalizeMediumQuote(data) {
  const quote = data?.medium;
  if (typeof quote?.gasLimit !== 'string' || !/^[1-9]\d{0,19}$/.test(quote.gasLimit)) {
    throw new Error('Invalid gas limit.');
  }
  const gas = BigInt(quote.gasLimit);
  const maxFee = decimalUnits(quote.maxFee, gweiDecimals);
  const tip = decimalUnits(quote.priorityFee, gweiDecimals);
  if (maxFee <= 0n || tip > maxFee) throw new Error('Invalid fee caps.');
  return {
    status: 'estimated', level: 'MEDIUM', gasUnits: String(gas),
    maxFeeWeiPerGas: String(maxFee), priorityFeeWeiPerGas: String(tip),
    meetsArcFeeFloor: maxFee >= arcFeeFloor,
    capCostUsdc: formatUnits(gas * maxFee, nativeDecimals),
    ...(quote.networkFee !== undefined ? {
      estimatedNetworkFeeUsdc: formatUnits(decimalUnits(quote.networkFee, nativeDecimals), nativeDecimals),
    } : {}),
  };
}

function circleFailure(error) {
  const code = Number.isInteger(error?.code) && error.code >= 100000 && error.code <= 999999 ? error.code : undefined;
  if ([155103, 155104, 155105, 155718].includes(code)) throw error;
  let status = [401, 403].includes(error?.status) ? 'circle-authentication-error' : 'circle-error';
  if ([155204, 155205, 155258, 177003, 177004].includes(code)) status = 'insufficient-funds';
  if ([155510, 156027, 175402].includes(code)) status = 'unsupported-blockchain';
  return code === undefined ? { status } : { status, code };
}

function rpcFailure(error) {
  let reverted = false;
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
    const message = cause.details ?? cause.shortMessage ?? cause.message ?? '';
    if (/insufficient funds|insufficient balance|funds for gas|\boutoffunds\b/i.test(message)) {
      return { status: 'insufficient-funds' };
    }
    const data = typeof cause.data === 'string' ? cause.data : cause.data?.data;
    if (typeof data === 'string') {
      try {
        const { errorName } = decodeErrorResult({ abi: invoiceAbi, data });
        return { status: 'contract-revert', reason: errorName };
      } catch { /* Ignore unrecognized revert data. */ }
    }
    reverted ||= cause.code === 3 || /execution reverted/i.test(message);
  }
  return { status: reverted ? 'contract-revert' : 'rpc-error' };
}

async function probeRpc(arc, type, payload) {
  try {
    if (type === 'call') {
      const result = await arc.request({ method: 'eth_call', params: [payload, 'latest'] });
      return { status: result === '0x' ? 'simulated' : 'unexpected-result' };
    }
    const quantity = await arc.request({ method: 'eth_estimateGas', params: [payload, 'latest'] });
    return { status: 'estimated', gasUnits: String(positiveQuantity(quantity)) };
  } catch (error) {
    return rpcFailure(error);
  }
}

async function estimateCircle(estimate, call, deployment, walletId) {
  const amount = formatUnits(call.value, nativeDecimals);
  if (decimalUnits(amount, nativeDecimals) !== call.value) throw new Error('Native amount lost precision.');
  let result;
  try {
    result = await estimate({
      contractAddress: deployment.address, callData: call.data, source: { walletId },
      ...(call.value === 0n ? {} : { amount }),
    });
  } catch (error) {
    return circleFailure(error);
  }
  try {
    return normalizeMediumQuote(result?.data);
  } catch {
    return { status: 'invalid-fee-response' };
  }
}

export async function readManagedPreflight({ arc, wallet, estimate, network = TERMUL_MAINNET }) {
  let deployment;
  try {
    deployment = await verifyManagedDeployment(arc, network);
  } catch {
    return { status: 'deployment-rpc-error' };
  }
  if (deployment.status !== 'verified') return { status: deployment.status, deployment };

  let balance;
  try {
    const [code, nativeBalance] = await Promise.all([
      arc.getCode({ address: wallet.address }), arc.getBalance({ address: wallet.address }),
    ]);
    if (code !== undefined && code !== '0x') return { status: 'wallet-has-code', deployment };
    if (typeof nativeBalance !== 'bigint' || nativeBalance < 0n) return { status: 'wallet-rpc-error', deployment };
    balance = nativeBalance;
  } catch {
    return { status: 'wallet-rpc-error', deployment };
  }

  const price = await arc.request({ method: 'eth_gasPrice' }).then(positiveQuantity).catch(() => null);
  const calls = [];
  for (const call of reviewedInvoiceCalls(wallet.address)) {
    const payload = { from: wallet.address, to: deployment.address, data: call.data, value: numberToHex(call.value) };
    const [rpcCall, rpcGas, circle] = await Promise.all([
      probeRpc(arc, 'call', payload), probeRpc(arc, 'estimate', payload),
      estimate ? estimateCircle(estimate, call, deployment, wallet.id) : { status: 'not-run' },
    ]);
    const rpcIndicativeCost = price !== null && rpcGas.status === 'estimated'
      ? price * BigInt(rpcGas.gasUnits) : null;
    const gasUnitsDelta = rpcGas.status === 'estimated' && circle.status === 'estimated'
      ? String(BigInt(circle.gasUnits) - BigInt(rpcGas.gasUnits)) : null;
    calls.push({
      functionName: call.functionName, args: call.args, calldata: call.data,
      valueBaseUnits: String(call.value), valueUsdc: formatUnits(call.value, nativeDecimals),
      balanceCoversValue: balance >= call.value, rpcCall, rpcGas, circle, gasUnitsDelta,
      rpcIndicativeCostUsdc: rpcIndicativeCost === null ? null : formatUnits(rpcIndicativeCost, nativeDecimals),
      balanceCoversRpcTotal: rpcIndicativeCost === null ? null : balance >= call.value + rpcIndicativeCost,
    });
  }
  return {
    status: 'checked', deployment, wallet,
    nativeDecimals, balanceUsdc: formatUnits(balance, nativeDecimals),
    rpcGasPriceWei: price === null ? null : String(price), calls,
  };
}
