import { decodeEventLog, hexToBigInt, padHex, parseAbi, sliceHex, zeroAddress } from 'viem';
import { polymerDomain } from './any-token-fees.js';
import { matches } from './any-token-networks.js';

// Circle's published CCTP V2 deployments for Arc and Base.
const transmitter = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const messenger = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const events = parseAbi([
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
]);
const bytes32 = address => padHex(address, { size: 32 });
const zeroWord = bytes32(zeroAddress);
const messagePattern = /^0x[0-9a-f]{752}$/i; // 148-byte header, 228-byte burn body, no hook.

function messages(receipt, eventName) {
  return (receipt.logs ?? []).flatMap(log => {
    if (log.removed || !matches(log.address, transmitter)) return [];
    try { return [decodeEventLog({ abi: events, eventName, data: log.data, topics: log.topics }).args]; }
    catch { return []; }
  });
}

export async function verifyPolymerSettlement(record, source, destination, fetcher) {
  const origin = polymerDomain(record.fromChain);
  const target = polymerDomain(record.toChain);
  if (origin === undefined || target === undefined || origin === target) return false;
  const sent = messages(source, 'MessageSent');
  const original = sent[0]?.message;
  if (sent.length !== 1 || !messagePattern.test(original ?? '')) return false;

  const word = (start, end) => sliceHex(original, start, end);
  if (hexToBigInt(word(0, 4)) !== 1n || hexToBigInt(word(4, 8)) !== BigInt(origin) || hexToBigInt(word(8, 12)) !== BigInt(target)
    || !matches(word(44, 76), bytes32(messenger)) || !matches(word(76, 108), bytes32(messenger))
    || !matches(word(108, 140), zeroWord) || hexToBigInt(word(140, 144)) !== 2000n
    || hexToBigInt(word(148, 152)) !== 1n || !matches(word(152, 184), bytes32(record.fromToken.address))
    || !matches(word(184, 216), bytes32(record.account)) || hexToBigInt(word(216, 248)) !== BigInt(record.polymerBurnAmount)
    || !matches(word(248, 280), bytes32(record.router)) || !matches(word(280, 312), zeroWord)) return false;

  // Circle assigns the nonce after the source event. Match the immutable bytes
  // to that event, then require that exact nonce and body in the mint receipt.
  const response = await fetcher('https://iris-api.circle.com/v2/messages/' + origin + '?transactionHash=' + record.hash, {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return false;
  const { messages: attestations } = await response.json();
  if (!Array.isArray(attestations)) return false;
  const matching = attestations.filter(entry => entry?.status === 'complete' && messagePattern.test(entry.message ?? '')
    && [[0, 12], [44, 144], [148, 312]].every(([start, end]) => matches(sliceHex(entry.message, start, end), word(start, end))));
  if (matching.length !== 1) return false;
  const [{ message }] = matching;
  const nonce = sliceHex(message, 12, 44);
  if (matches(nonce, zeroWord) || !matches(sliceHex(message, 312, 344), zeroWord)) return false;
  const finality = hexToBigInt(sliceHex(message, 144, 148));
  return finality >= 2000n && messages(destination, 'MessageReceived').some(event =>
    event.sourceDomain === origin && matches(event.nonce, nonce) && matches(event.sender, bytes32(messenger))
    && BigInt(event.finalityThresholdExecuted) === finality && matches(event.messageBody, sliceHex(message, 148)));
}
