import { formatUnits, getAddress, parseAbi, parseUnits, slice, zeroAddress } from 'viem';
import { arcNetwork } from './arc-network.js';
import {
  ARC_FEE_FORWARDER, TERMUL_INTEGRATOR, decodeExact, equalAddress, matchesFeeRate, noExtraDistributions,
  readFeeSplit, swapFee, validateFeeForwarding,
} from './swap-fee.js';

export { ARC_FEE_FORWARDER as FEE_FORWARDER, FEE_ABI, equalAddress } from './swap-fee.js';

export const SWAP_TOKENS = Object.freeze({
  USDC: Object.freeze({ symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 }),
  EURC: Object.freeze({ symbol: 'EURC', address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 }),
});
export const ARC_ANY_SWAP_TOKENS = Object.freeze({
  ...SWAP_TOKENS,
  cirBTC: Object.freeze({ symbol: 'cirBTC', address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8,
    runtimeHash: '0xd220f3a1c8035c30fe605588779e611d52d107011ce6a401a98d4025de2ef33e' }),
  WETH: Object.freeze({ symbol: 'WETH', address: '0x128cC466B61f542da60c70e3aA11c10e19B84EDB', decimals: 18,
    runtimeHash: '0x0d8d75955ab8fc42763623b4c903e9134bd22563eff209a9ccb1f2607f26aabc' }),
  VIRTUAL: Object.freeze({ symbol: 'VIRTUAL', address: '0x8C4252c87081c88c6Ad57d6dD97E1cAFebF842B7', decimals: 18,
    runtimeHash: '0xbfd91bb06292887f4a2645e297247489766704aac3634d65ecafcd9cfa78499e' }),
  wARS: Object.freeze({ symbol: 'wARS', address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', decimals: 18,
    runtimeHash: '0xf8d9ff5ea93bc29b43da9f8727fdeb3c9adac7ec55da259371f7af7182faf6a2' }),
  CRCL: Object.freeze({ symbol: 'CRCL', address: '0x2ba0f44BDfC17FbA30edA9cdBeCB908cA45B043B', decimals: 18,
    runtimeHash: '0x33c2d3ade0e0f171791108b83bddb78d0b54710b2e0b1f730074bdc362d57296' }),
});
export const SWAP_ROUTER = '0xA4072583658Fae592A3506A42431cb6316a8d40b';
export const SWAP_FACET = '0x0E60f12E2CE6b4EA51bde7A2aD61A22B12605c9C';
export const FLY_ROUTER = '0x20F6ee51340aDEed01A59B0e65cB3703f3dc860c';
export const QUOTE_TTL = 30_000;
export const SLIPPAGE = 0.005;
export const APPROVAL_GAS_LIMIT = 100_000n;
export const MAX_SWAP_GAS_LIMIT = 3_000_000n;
const MAX_UINT = (1n << 256n) - 1n;

export const SWAP_STEP = '(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
export const SWAP_ABI = parseAbi([
  `function swapTokensSingleV3ERC20ToERC20(bytes32 id, string integrator, string referrer, address receiver, uint256 minAmount, ${SWAP_STEP} swapData)`,
  `function swapTokensMultipleV3ERC20ToERC20(bytes32 id, string integrator, string referrer, address receiver, uint256 minAmount, ${SWAP_STEP}[] swapData)`,
]);
export const FLY_ABI = parseAbi(['function swapWithBackendSignature(bytes data)']);
export const isHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
export const tokenAmount = (amount, token) => `${formatUnits(amount, token.decimals)} ${token.symbol}`;

export function unsigned(value) {
  if (typeof value !== 'string' || !/^(?:\d{1,78}|0x[\da-fA-F]{1,64})$/.test(value) || BigInt(value) > MAX_UINT) {
    throw new Error('Invalid quote amount.');
  }
  return BigInt(value);
}

export function parseSwapAmount(text, decimals = 6) {
  const value = text.trim();
  const fraction = decimals ? `(?:\\.\\d{1,${decimals}})?` : '';
  if (!new RegExp(`^\\d{1,72}${fraction}$`).test(value)) return null;
  const amount = parseUnits(value, decimals);
  return amount > 0n && amount <= MAX_UINT ? amount : null;
}

export function swapRate(input, output, fromDecimals = 6, toDecimals = 6) {
  return formatUnits(output * 10n ** BigInt(fromDecimals + 8) / (input * 10n ** BigInt(toDecimals)), 8);
}

function requireRoute(condition) {
  if (!condition) throw new Error('LI.FI returned an unsupported or inconsistent Arc route.');
}

function tokenMatches(value, token) {
  return value?.chainId === arcNetwork.id && value.decimals === token.decimals && equalAddress(value.address, token.address);
}

function validateFly(step, from, to, amount, requiresDeposit) {
  requireRoute(step?.requiresDeposit === requiresDeposit && equalAddress(step.callTo, FLY_ROUTER) && equalAddress(step.approveTo, FLY_ROUTER)
    && equalAddress(step.sendingAssetId, from.address) && equalAddress(step.receivingAssetId, to.address) && step.fromAmount === amount);
  // The reviewed Fly signed payload begins with four bytes of routing metadata,
  // followed by receiver, input token, output token and a 32-byte input amount.
  // Fly validates the signature and routing payload on-chain.
  const { args: [packed] } = decodeExact(FLY_ABI, step.callData);
  requireRoute(packed.length > 194 && equalAddress(slice(packed, 4, 24), SWAP_ROUTER)
    && equalAddress(slice(packed, 24, 44), from.address) && equalAddress(slice(packed, 44, 64), to.address)
    && unsigned(slice(packed, 64, 96)) === amount);
}

// Use input after the separately disclosed fees when comparing equal USD units.
function estimateReferenceImpact(action, netAmount, received) {
  const readPrice = value => typeof value === 'string' && /^\d{1,8}(?:\.\d{1,18})?$/.test(value)
    ? parseUnits(value, 18) : 0n;
  const inputValue = netAmount * readPrice(action.fromToken.priceUSD) * 10n ** BigInt(action.toToken.decimals);
  const outputValue = received * readPrice(action.toToken.priceUSD) * 10n ** BigInt(action.fromToken.decimals);
  if (inputValue <= 0n || outputValue <= 0n) return null;
  const percentage = (inputValue - outputValue) * 1_000_000n / inputValue;
  return percentage >= -100_000_000n ? formatUnits(percentage, 4) : null;
}

export function parseSwapQuote(raw, { from, to, amount, account, anyToken = false, verifiedAssets }, requestedAt, policy = swapFee) {
  const { action, estimate, transactionRequest: request } = raw;
  const tokens = anyToken ? ARC_ANY_SWAP_TOKENS : SWAP_TOKENS;
  const recognized = anyToken && verifiedAssets ? verifiedAssets[0] === from && verifiedAssets[1] === to
    : tokens[from?.symbol] === from && tokens[to?.symbol] === to;
  requireRoute(from && to && recognized && !equalAddress(from.address, to.address) &&
    raw.type === 'lifi' && raw.tool === 'fly' && raw.integrator === TERMUL_INTEGRATOR && matchesFeeRate(raw.fee, policy) && noExtraDistributions(raw)
    && action?.fromChainId === arcNetwork.id && action.toChainId === arcNetwork.id && action.slippage === SLIPPAGE
    && tokenMatches(action.fromToken, from) && tokenMatches(action.toToken, to)
    && equalAddress(action.fromAddress, account) && equalAddress(action.toAddress, account)
    && unsigned(action.fromAmount) === amount && unsigned(estimate?.fromAmount) === amount
    && equalAddress(estimate.approvalAddress, SWAP_ROUTER) && request?.chainId === arcNetwork.id
    && equalAddress(request.from, account) && equalAddress(request.to, SWAP_ROUTER) && unsigned(request.value) === 0n);
  const received = unsigned(estimate.toAmount);
  const minimum = unsigned(estimate.toAmountMin);
  const gasLimit = unsigned(request.gasLimit);
  requireRoute(received > 0n && minimum > 0n && minimum <= received && minimum >= received * 995n / 1000n
    && gasLimit > 0n && gasLimit <= MAX_SWAP_GAS_LIMIT);

  const fees = estimate.feeCosts ?? [];
  // LI.FI omits the fee step when neither fee can be represented in a base unit.
  const feeCanRoundToZero = anyToken && Array.isArray(estimate.feeCosts) && amount > 0n && amount * BigInt(policy.bps) < 10_000n;
  requireRoute(Array.isArray(fees) && fees.length <= 1 && (!policy.bps || fees.length === 1 || feeCanRoundToZero));
  const fee = fees.length ? readFeeSplit(fees[0], action.fromToken, amount, policy) : null;

  const { functionName, args: [id, integrator, referrer, receiver, min, data] } = decodeExact(SWAP_ABI, request.data);
  requireRoute(isHash(id) && id.toLowerCase() === raw.transactionId?.toLowerCase()
    && integrator === TERMUL_INTEGRATOR && equalAddress(referrer, zeroAddress) && equalAddress(receiver, account) && min === minimum);
  if (!fee) {
    requireRoute(functionName === 'swapTokensSingleV3ERC20ToERC20');
    validateFly(data, from, to, amount, true);
  } else {
    requireRoute(functionName === 'swapTokensMultipleV3ERC20ToERC20' && data.length === 2);
    validateFeeForwarding(data[0], ARC_FEE_FORWARDER, from.address, amount, fee);
    validateFly(data[1], from, to, amount - fee.total, false);
  }

  const gasCosts = estimate.gasCosts ?? [];
  requireRoute(Array.isArray(gasCosts) && gasCosts.length <= 8);
  const networkFee = gasCosts.reduce((sum, cost) => {
    requireRoute(cost.token?.chainId === arcNetwork.id && cost.token.decimals === 18 && equalAddress(cost.token.address, zeroAddress));
    return sum + unsigned(cost.amount);
  }, 0n);
  const impact = estimate.priceImpact;
  const priceImpact = ['string', 'number'].includes(typeof impact) && /^-?\d{1,4}(?:\.\d{1,8})?$/.test(String(impact)) ? String(impact) : null;
  return Object.freeze({
    account: getAddress(account), from, to, amount, received, minimum, feePolicy: policy, providerFee: fee?.providerFee ?? 0n, integratorFee: fee?.integratorFee ?? 0n, integrator, id,
    networkFee: gasCosts.length ? networkFee : null, priceImpact,
    referencePriceImpact: priceImpact === null ? estimateReferenceImpact(action, amount - (fee?.total ?? 0n), received) : null,
    route: 'LI.FI · Fly', gasLimit, expiresAt: requestedAt + QUOTE_TTL, data: request.data,
  });
}

const previewAddress = '0x000000000000000000000000000000000000dEaD';
export async function fetchSwapQuote(input, signal, fetcher = fetch, now = Date.now, policy = swapFee) {
  if (policy.bps && !policy.recipient) throw new Error('Configure the public Termul fee recipient before requesting a quote.');
  const requestedAt = now();
  const params = new URLSearchParams({
    fromChain: String(arcNetwork.id), toChain: String(arcNetwork.id),
    fromToken: input.from.address, toToken: input.to.address, fromAmount: input.amount.toString(),
    fromAddress: input.account || previewAddress, toAddress: input.account || previewAddress,
    slippage: String(SLIPPAGE), integrator: TERMUL_INTEGRATOR, fee: String(policy.rate), allowExchanges: 'fly',
  });
  const result = await fetcher('https://li.quest/v1/quote?' + params, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), cache: 'no-store', redirect: 'error',
  });
  if (!result.ok) {
    if ([400, 404, 422].includes(result.status)) throw new Error('No supported route for this amount. Try a different amount.');
    throw new Error('The quote service is unavailable. Try again shortly.');
  }
  let quote;
  try {
    quote = parseSwapQuote(await result.json(), { ...input, account: params.get('fromAddress') }, requestedAt, policy);
  } catch {
    throw new Error('LI.FI returned a route this app does not support. Try another amount.');
  }
  assertFreshQuote(quote, now());
  return quote;
}

export function assertFreshQuote(quote, now = Date.now()) {
  if (!quote || now >= quote.expiresAt) throw new Error('The quote expired. Review a fresh quote before signing.');
}

export function createQuoteRequest(load, publish, delay = 350) {
  let timer;
  let active;
  return input => {
    clearTimeout(timer);
    active?.abort();
    active = null;
    if (!input) return publish({ status: 'idle' });
    const request = active = new AbortController();
    publish({ status: 'loading' });
    timer = setTimeout(async () => {
      try {
        const quote = await load(input, request.signal);
        if (active === request) publish({ status: 'ready', quote });
      } catch (error) {
        if (active === request) publish({ status: 'error', message: error.message || 'Quote unavailable.' });
      }
    }, delay);
  };
}
