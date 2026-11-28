import { concat, createPublicClient, decodeEventLog, encodeFunctionData, erc20Abi, http, isAddressEqual,
  keccak256, padHex, parseAbi, parseAbiItem, slice, stringToHex, toHex, zeroAddress } from 'viem';

export const ARC_USDC = '0x3600000000000000000000000000000000000000';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const messenger = '0x71f54F818671cD0D7ea140Da213e5C8b5C92a408';
export const transmitter = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
export const hook = concat([stringToHex('cctp-forward', { size: 24 }), toHex(0, { size: 8 })]);
const zero = toHex(0, { size: 32 });
const hex32 = value => padHex(value, { size: 32 }).toLowerCase();
const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const cctpAbi = parseAbi([
  'function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData)',
  'event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)',
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)',
  'event MintAndWithdraw(address indexed mintRecipient,uint256 amount,address indexed mintToken,uint256 feeCollected)',
]);
export const burnEvent = cctpAbi[1];
export const approvalEvent = parseAbiItem('event Approval(address indexed owner,address indexed spender,uint256 value)');
const pins = {
  5042: [
    [ARC_USDC, '0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d'],
    [messenger, '0x20386d36f0d7dae78e38a41102bc18e0c15f9ecb9c5eccee9d1f5a1a899fd56d', '0x461d087964c8ac5be2cdbf4a61c7551044e26413715cb7950df0832b1f4c0573'],
    [transmitter, '0xd2c8d48075d832fb7d07f6db5545a1bee37fdf886325c441a8dd1cef4c9dae99', '0x3b5d3d6b6036d5b0c88d727440fa7391d5ab0fb2c32ae68bea880589c5dbf578'],
  ],
  8453: [
    [BASE_USDC, '0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab',
      '0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873',
      '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3'],
    [messenger, '0x20386d36f0d7dae78e38a41102bc18e0c15f9ecb9c5eccee9d1f5a1a899fd56d', '0x77ec35fa502cb7100978061af60a74bb5db0450ae5e3552dc97fa338417a6c4a'],
    [transmitter, '0xd2c8d48075d832fb7d07f6db5545a1bee37fdf886325c441a8dd1cef4c9dae99', '0x1c103738027742a17d3758356fc53deff294f9ac593189e104542e781c6f04a5'],
  ],
};

export const baseRpc = createPublicClient({ transport: http('https://mainnet.base.org', {
  timeout: 5000, retryCount: 0, methods: { include: ['eth_chainId', 'eth_getCode', 'eth_getStorageAt', 'eth_call',
    'eth_getBlockByNumber', 'eth_getLogs', 'eth_getTransactionReceipt'] },
}) });

export async function verifyDeployment(rpc, chain, blockNumber) {
  if (await rpc.getChainId() !== chain) throw new Error('Wrong bridge RPC chain.');
  const at = blockNumber === undefined ? {} : { blockNumber };
  await Promise.all(pins[chain].map(async ([address, runtime, impl, implementationSlot = slot]) => {
    const code = await rpc.getCode({ address, ...at });
    if (!code || keccak256(code) !== runtime) throw new Error('Bridge deployment changed.');
    if (impl) {
      const pointer = await rpc.getStorageAt({ address, slot: implementationSlot, ...at });
      if (!pointer || !/^0x0{24}[a-f0-9]{40}$/i.test(pointer)) throw new Error('Bridge proxy changed.');
      const bytecode = await rpc.getCode({ address: '0x' + pointer.slice(-40), ...at });
      if (!bytecode || keccak256(bytecode) !== impl) throw new Error('Bridge implementation changed.');
    }
  }));
}

export async function iris(path, fetcher = fetch) {
  const reply = await fetcher('https://iris-api.circle.com' + path, {
    signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store',
  });
  if (!reply.ok) throw new Error('Circle bridge data is temporarily unavailable.');
  return reply.json();
}

export async function feeForBridge(amount, read = iris) {
  const data = await read('/v2/burn/USDC/fees/26/6?forward=true');
  const item = Array.isArray(data) && data.find(entry => entry.finalityThreshold === 2000);
  const feeBps = String(item?.minimumFee);
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(feeBps) || !Number.isSafeInteger(item?.forwardFee?.high) || item.forwardFee.high <= 0) {
    throw new Error('Circle did not return a valid Standard Transfer fee.');
  }
  const hundredths = BigInt(Math.round(Number(feeBps) * 100));
  return BigInt(item.forwardFee.high) + (amount * hundredths + 999999n) / 1000000n;
}

export function bridgeCall(wallet, amount, fee, allowance) {
  if (allowance !== amount) {
    const value = allowance === 0n ? amount : 0n;
    return { phase: value ? 'approve' : 'reset', target: ARC_USDC, value: String(value),
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [messenger, value] }) };
  }
  return { phase: 'burn', target: messenger, data: encodeFunctionData({ abi: cctpAbi,
    functionName: 'depositForBurnWithHook', args: [amount, 6, hex32(wallet), ARC_USDC, zero, fee, 2000, hook] }) };
}

function events(receipt, address, name) {
  return receipt.logs.filter(log => log.removed !== true && log.transactionHash === receipt.transactionHash
    && log.blockHash === receipt.blockHash && isAddressEqual(log.address, address)).flatMap(log => {
    try { return [decodeEventLog({ abi: [...cctpAbi, ...erc20Abi], eventName: name, topics: log.topics, data: log.data }).args]; }
    catch { return []; }
  });
}

function messageFields(message, route, maxFee) {
  if (typeof message !== 'string' || !/^0x[a-f0-9]{816}$/i.test(message)) return false;
  const at = (start, end) => slice(message, start, end).toLowerCase();
  const n = (start, end) => BigInt(at(start, end));
  return n(0, 4) === 1n && n(4, 8) === 26n && n(8, 12) === 6n &&
    at(44, 76) === hex32(messenger) && at(76, 108) === hex32(messenger) && at(108, 140) === zero &&
    n(140, 144) === 2000n && n(148, 152) === 1n && at(152, 184) === hex32(ARC_USDC) &&
    at(184, 216) === hex32(route.walletAddress) && n(216, 248) === BigInt(route.amount) &&
    at(248, 280) === hex32(route.walletAddress) && n(280, 312) === BigInt(maxFee) && at(376, 408) === hook;
}

async function canonicalReceipt(rpc, hash) {
  const receipt = await rpc.getTransactionReceipt({ hash });
  if (receipt.transactionHash !== hash || !receipt.blockHash || typeof receipt.blockNumber !== 'bigint') return null;
  const [block, finalized] = await Promise.all([rpc.getBlock({ blockNumber: receipt.blockNumber }), rpc.getBlock({ blockTag: 'finalized' })]);
  return block.hash === receipt.blockHash && finalized.number >= receipt.blockNumber ? receipt : null;
}

export async function sourceProof(arc, route, hash, check = verifyDeployment) {
  const { step } = route;
  const [tx, receipt] = await Promise.all([arc.getTransaction({ hash }), canonicalReceipt(arc, hash)]);
  if (!receipt || tx.hash !== hash || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber ||
    tx.blockNumber < BigInt(step.fromBlock) || Number(tx.chainId) !== 5042 || tx.type !== 'eip1559' ||
    !tx.to || !isAddressEqual(tx.to, step.target) || !isAddressEqual(tx.from, route.walletAddress) ||
    tx.input.toLowerCase() !== step.data.toLowerCase() || tx.value !== 0n || tx.gas !== BigInt(step.gasLimit) ||
    tx.maxFeePerGas !== BigInt(step.maxFeePerGas) || tx.maxPriorityFeePerGas !== BigInt(step.tip) ||
    !(receipt.gasUsed > 0n && receipt.gasUsed <= tx.gas && receipt.effectiveGasPrice > 0n && receipt.effectiveGasPrice <= tx.maxFeePerGas)) return null;
  await check(arc, 5042, receipt.blockNumber);
  if (receipt.status === 'reverted') return { status: 'reverted', hash };
  if (receipt.status !== 'success') return null;
  if (step.phase !== 'burn') {
    const match = events(receipt, ARC_USDC, 'Approval').filter(args => isAddressEqual(args.owner, route.walletAddress) &&
      isAddressEqual(args.spender, messenger) && args.value === BigInt(step.value));
    return match.length === 1 ? { status: 'ready', hash } : null;
  }
  const match = events(receipt, messenger, 'DepositForBurn').filter(args => isAddressEqual(args.depositor, route.walletAddress) &&
    isAddressEqual(args.burnToken, ARC_USDC) && args.amount === BigInt(route.amount) && args.destinationDomain === 6 &&
    args.mintRecipient.toLowerCase() === hex32(route.walletAddress) && args.destinationTokenMessenger.toLowerCase() === hex32(messenger) &&
    args.destinationCaller === zero && args.maxFee === BigInt(step.maxFee) && args.minFinalityThreshold === 2000 && args.hookData === hook);
  const sent = events(receipt, transmitter, 'MessageSent').filter(args => messageFields(args.message, route, step.maxFee));
  return match.length === 1 && sent.length === 1 ? { status: 'destination-pending', hash, message: sent[0].message } : null;
}

export async function destinationProof(base, route, read = iris, check = verifyDeployment) {
  const data = await read('/v2/messages/26?transactionHash=' + route.sourceHash);
  if (!Array.isArray(data?.messages) || data.messages.length !== 1) return null;
  const { status, message, forwardTxHash } = data.messages[0];
  if (status !== 'complete' || !messageFields(message, route, route.step.maxFee)) return null;
  // The attester fills the nonce, executed finality and fee/expiry fields.
  const unchanged = [[0, 12], [44, 144], [148, 312], [376, 408]]
    .every(([a, b]) => slice(message, a, b).toLowerCase() === slice(route.sourceMessage, a, b).toLowerCase());
  const finality = Number(BigInt(slice(message, 144, 148)));
  const fee = BigInt(slice(message, 312, 344));
  const net = BigInt(route.amount) - fee;
  const nonce = slice(message, 12, 44).toLowerCase();
  if (!unchanged || finality < 2000 || fee > BigInt(route.step.maxFee) || net < BigInt(route.step.minimum) || nonce === zero) return null;
  async function issuerReceipt(hash) {
    const receipt = await canonicalReceipt(base, hash);
    if (receipt?.status !== 'success') return null;
    await check(base, 8453, receipt.blockNumber);
    const received = events(receipt, transmitter, 'MessageReceived').filter(args => args.sourceDomain === 26 &&
      args.nonce.toLowerCase() === nonce && args.sender.toLowerCase() === hex32(messenger) &&
      args.finalityThresholdExecuted === finality && args.messageBody.toLowerCase() === slice(message, 148).toLowerCase());
    const minted = events(receipt, messenger, 'MintAndWithdraw').filter(args => isAddressEqual(args.mintToken, BASE_USDC) &&
      isAddressEqual(args.mintRecipient, route.walletAddress) && args.amount === net && args.feeCollected === fee);
    const transferred = events(receipt, BASE_USDC, 'Transfer').filter(args => isAddressEqual(args.from, zeroAddress) &&
      isAddressEqual(args.to, route.walletAddress) && args.value === net);
    if (received.length !== 1 || minted.length !== 1 || transferred.length !== 1) return null;
    return { destinationHash: hash, received: String(net), fee: String(fee) };
  }
  const hint = /^0x[a-f0-9]{64}$/i.test(forwardTxHash ?? '') ? forwardTxHash.toLowerCase() : undefined;
  if (hint) {
    try {
      const proof = await issuerReceipt(hint);
      if (proof) return proof;
    } catch { /* Transaction indexing and finality may lag. */ }
  }
  try {
    const { number: toBlock } = await base.getBlock({ blockTag: 'finalized' });
    const matches = await base.getLogs({ address: transmitter, event: cctpAbi[3], args: { nonce },
      fromBlock: toBlock > 1999n ? toBlock - 1999n : 0n, toBlock, strict: true });
    const hashes = [...new Set(matches.map(log => log.transactionHash).filter(hash =>
      /^0x[a-f0-9]{64}$/i.test(hash ?? '') && hash !== hint))];
    if (hashes.length === 1) return await issuerReceipt(hashes[0]);
  } catch { /* No proof yet. Preserve the existing burn. */ }
  return null;
}
