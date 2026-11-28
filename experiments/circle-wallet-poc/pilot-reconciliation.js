import { randomUUID } from 'node:crypto';
import { decodeEventLog, formatUnits, isAddressEqual, keccak256 } from 'viem';
import { invoiceAbi, verifyManagedDeployment } from './managed-preflight.js';
import { TERMUL_MAINNET } from '../../supabase/functions/_shared/termul-mainnet.js';

export const invoiceAmount = 10_000_000_000_000_000n;
export const feeCap = 10_000_000_000_000_000n;
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const diagnosticDetails = new Set(['unexpected-pagination-cursor', 'unexpected-list-shape', 'reference-identity-conflict',
  'repeated-pagination-cursor', 'duplicate-reference', 'pagination-budget']);
const providerStates = new Set(['INITIATED', 'CLEARED', 'QUEUED', 'SENT', 'STUCK', 'CONFIRMED', 'COMPLETE', 'FAILED', 'DENIED', 'CANCELLED']);
export const isHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const sameAddress = (value, expected) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();

function nextCursor(response) {
  const link = response.headers?.link;
  if (!link) return undefined;
  const next = link.match(/<([^>]+)>\s*;\s*rel="?next"?(?:\s*[,;]|\s*$)/i);
  if (!next) return undefined;
  const url = new URL(next[1], 'https://api.circle.com');
  const cursor = url.searchParams.get('pageAfter');
  if (!isUuid(cursor)) throw Object.assign(new Error('Invalid Circle pagination cursor.'), { diagnostic: 'unexpected-pagination-cursor' });
  return cursor;
}

export function pilotDiagnostic(stage, error, { invoiceId, challengeId, transactionId, idempotencyKey } = {}) {
  const ids = { referenceId: isUuid(idempotencyKey) ? idempotencyKey : undefined, invoiceId: isHash(invoiceId) ? invoiceId : undefined,
    challengeId: isUuid(challengeId) ? challengeId : undefined,
    transactionId: isUuid(transactionId) ? transactionId : undefined };
  const status = error?.status ?? error?.response?.status;
  return { stage, ...ids, details: diagnosticDetails.has(error?.diagnostic) ? error.diagnostic : undefined,
    httpStatus: Number.isInteger(status) && status >= 100 && status < 600 ? status : undefined,
    circleCode: Number.isInteger(error?.code) && error.code >= 100000 && error.code <= 999999 ? error.code : undefined };
}

const responseStatus = error => error?.status ?? error?.response?.status;

async function listPilotTransactions(circle, record, userToken, filtered, onDiagnostic) {
  const matches = new Map();
  const cursors = new Set();
  let pageAfter;
  let pages = 0;
  do {
    const requestId = randomUUID();
    let response;
    try {
      response = await circle.listTransactions({
        userToken, walletIds: [record.walletId],
        ...(filtered ? { blockchain: record.blockchain ?? 'ARC', operation: 'CONTRACT_EXECUTION' } : {}),
        pageSize: 50, xRequestId: requestId,
        ...(pageAfter ? { pageAfter } : {}),
      });
    } catch (error) {
      onDiagnostic?.({ ...pilotDiagnostic(filtered ? 'transaction-list-filtered' : 'transaction-list-wallet', error, record), requestId });
      throw error;
    }
    if (!Array.isArray(response.data?.transactions)) throw Object.assign(new Error('Invalid Circle transaction list.'), { diagnostic: 'unexpected-list-shape' });
    for (const tx of response.data.transactions) {
      if (tx?.refId !== record.idempotencyKey) continue;
      if (!isUuid(tx.id) || tx.walletId !== record.walletId || tx.blockchain !== (record.blockchain ?? 'ARC')
        || tx.operation !== 'CONTRACT_EXECUTION'
        || (tx.sourceAddress && !sameAddress(tx.sourceAddress, record.walletAddress))
        || (tx.destinationAddress && !sameAddress(tx.destinationAddress, (record.target ?? TERMUL_MAINNET.contractAddress)))) {
        throw Object.assign(new Error('Circle transaction identity conflict.'), { diagnostic: 'reference-identity-conflict' });
      }
      matches.set(tx.id, tx);
    }
    pageAfter = nextCursor(response);
    if (pageAfter && cursors.has(pageAfter)) throw Object.assign(new Error('Repeated Circle pagination cursor.'), { diagnostic: 'repeated-pagination-cursor' });
    if (pageAfter) {
      cursors.add(pageAfter);
      if (++pages >= 4) throw Object.assign(new Error('Circle pagination budget reached.'), { diagnostic: 'pagination-budget' });
    }
  } while (pageAfter);
  if (matches.size > 1) throw Object.assign(new Error('Circle transaction reference is ambiguous.'), { diagnostic: 'duplicate-reference' });
  return matches.values().next().value;
}

export async function lookupPilotTransaction(circle, record, userToken, onDiagnostic) {
  try { return await listPilotTransactions(circle, record, userToken, true, onDiagnostic); }
  catch (error) {
    if (responseStatus(error) !== 400) throw error;
    // Retain the wallet filter and exact reference validation if Circle rejects optional filters.
    return listPilotTransactions(circle, record, userToken, false, onDiagnostic);
  }
}

export async function verifyPilotReceipt(arc, record, readInvoice) {
  const transactionHash = record.transactionHash;
  if (!isHash(transactionHash)) return { status: 'verification-failed' };
  const isPayment = record.kind === 'payment';
  const value = isPayment ? BigInt(record.amountBase) : 0n;
  const merchant = isPayment ? record.merchant : record.walletAddress;
  const amount = isPayment ? value : BigInt(record.amountBase ?? invoiceAmount);
  const [tx, receipt] = await Promise.all([
    arc.getTransaction({ hash: transactionHash }), arc.getTransactionReceipt({ hash: transactionHash }),
  ]);
  const fail = { status: 'verification-failed' };
  if (tx.hash !== transactionHash || receipt.transactionHash !== transactionHash
    || !tx.blockHash || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber
    || Number(tx.chainId) !== record.chainId || !sameAddress(tx.from, record.walletAddress)
    || !sameAddress(tx.to, TERMUL_MAINNET.contractAddress)
    || tx.value !== value || keccak256(tx.input) !== record.calldataHash || tx.type !== 'eip1559'
    || tx.gas !== BigInt(record.gasLimit) || tx.maxFeePerGas !== BigInt(record.maxFeePerGas)
    || tx.maxPriorityFeePerGas !== BigInt(record.priorityFeePerGas)
    || typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed <= 0n || receipt.gasUsed > tx.gas
    || typeof receipt.effectiveGasPrice !== 'bigint' || receipt.effectiveGasPrice <= 0n
    || receipt.effectiveGasPrice > tx.maxFeePerGas || receipt.gasUsed * receipt.effectiveGasPrice > feeCap) return fail;

  const finalized = await arc.getBlock({ blockTag: 'finalized' });
  if (typeof finalized?.number !== 'bigint' || typeof receipt.blockNumber !== 'bigint'
    || receipt.blockNumber > finalized.number) return { status: 'receipt-pending' };
  const canonical = finalized.number === receipt.blockNumber ? finalized : await arc.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical?.number !== receipt.blockNumber || canonical.hash !== receipt.blockHash) return { status: 'verification-pending' };

  const gasUsed = String(receipt.gasUsed);
  const costUsdc = formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18);
  if (receipt.status === 'reverted') return { status: 'reverted', gasUsed, costUsdc };
  if (receipt.status !== 'success') return fail;
  const matches = receipt.logs.filter(log => {
    if (log.removed || log.transactionHash !== transactionHash || !sameAddress(log.address, TERMUL_MAINNET.contractAddress)) return false;
    try {
      const { args } = decodeEventLog({ abi: invoiceAbi, eventName: isPayment ? 'InvoicePaid' : 'InvoiceCreated', data: log.data, topics: log.topics });
      return args.invoiceId === record.invoiceId && isAddressEqual(args.merchant, merchant)
        && args.amount === amount && (isPayment ? isAddressEqual(args.payer, record.walletAddress)
          : args.expiresAt === BigInt(record.expiresAt));
    } catch { return false; }
  });
  if (matches.length !== 1) return fail;
  const invoice = await readInvoice(merchant, record.invoiceId, receipt.blockNumber);
  if (invoice.status !== (isPayment ? 2 : 1) || !sameAddress(invoice.merchant, merchant)
    || invoice.amount !== amount || invoice.expiresAt !== BigInt(record.expiresAt)) return fail;
  let latestInvoice;
  try {
    const [latest, block] = await Promise.all([readInvoice(merchant, record.invoiceId), arc.getBlock({ blockTag: 'latest' })]);
    if (sameAddress(latest.merchant, merchant) && latest.amount === amount && latest.expiresAt === invoice.expiresAt) {
      latestInvoice = { status: latest.status, expired: latest.expiresAt !== 0n && latest.expiresAt <= block.timestamp };
    }
  } catch { /* Historical verification does not depend on latest-state availability. */ }
  return { status: 'verified', gasUsed, costUsdc, blockNumber: String(receipt.blockNumber),
    invoiceStatusAtReceipt: invoice.status, latestInvoice };
}

export async function recoverPilotHash({ arc, record, hash, readInvoice, network = TERMUL_MAINNET }) {
  const transactionHash = typeof hash === 'string' ? hash.toLowerCase() : '';
  if (!isHash(transactionHash) || (record.transactionHash && record.transactionHash !== transactionHash)
    || (await verifyManagedDeployment(arc, network)).status !== 'verified') return { status: 'verification-failed' };
  const proof = await verifyPilotReceipt(arc, { ...record, transactionHash }, readInvoice);
  return proof.status === 'verified' ? { ...proof, transactionHash, verificationSource: 'arc-hash' }
    : { status: 'verification-failed' };
}

export async function reconcilePilot({ circle, arc, record, userToken, readInvoice, network = TERMUL_MAINNET }) {
  if ((await verifyManagedDeployment(arc, network)).status !== 'verified') return { status: 'verification-failed' };
  const fields = {};
  if (record.challengeId && !record.transactionHash) {
    const { data } = await circle.getUserChallenge({ userToken, challengeId: record.challengeId }).catch(error => {
      if ([155103, 155104, 155105, 155718].includes(error?.code)) throw error;
      fields.diagnostic = pilotDiagnostic('challenge-read', error, record);
      return {};
    });
    const challenge = data?.challenge;
    if (challenge?.id === record.challengeId && challenge.type === 'CONTRACT_EXECUTION'
      && ['PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED', 'EXPIRED'].includes(challenge.status)) {
      fields.challengeStatus = challenge.status === 'FAILED' && challenge.errorCode === 155701
        ? 'REJECTED' : challenge.status;
    }
  }
  if (!record.transactionHash && !record.providerHash) {
    let listed;
    try { listed = record.transactionId ? null : await lookupPilotTransaction(circle, record, userToken,
      diagnostic => { fields.diagnostic = diagnostic; }); }
    catch (error) {
      if ([155103, 155104, 155105, 155718].includes(error?.code)) throw error;
      return { ...fields, status: fields.challengeStatus === 'COMPLETE' ? 'transaction-pending' : record.status,
        diagnostic: fields.diagnostic ?? pilotDiagnostic('transaction-list', error, record) };
    }
    const id = record.transactionId ?? listed?.id;
    if (id) {
      fields.transactionId = id;
      const { data } = await circle.getTransaction({ userToken, id }).catch(error => {
        if ([155103, 155104, 155105, 155718].includes(error?.code)) throw error;
        fields.diagnostic = pilotDiagnostic('transaction-read', error, { ...record, transactionId: id });
        return {};
      });
      if (!data) return { ...fields, status: 'hash-pending' };
      const tx = data?.transaction;
      if (tx?.id !== id || tx.refId !== record.idempotencyKey || tx.walletId !== record.walletId
        || tx.blockchain !== 'ARC' || tx.operation !== 'CONTRACT_EXECUTION') return { ...fields, status: 'verification-failed' };
      if (providerStates.has(tx.state)) fields.transactionStatus = tx.state;
      if (isHash(tx.txHash)) fields.providerHash = tx.txHash.toLowerCase();
      else return { ...fields, status: 'hash-pending' };
    } else {
      const terminal = fields.challengeStatus === 'EXPIRED' ? 'expired' : fields.challengeStatus === 'REJECTED' ? 'rejected' : null;
      const payment = record.kind === 'payment';
      if (terminal && (await readInvoice(payment ? record.merchant : record.walletAddress, record.invoiceId)).status === (payment ? 1 : 0)) {
        return { ...fields, status: terminal };
      }
      return { ...fields, status: fields.challengeStatus === 'COMPLETE' ? 'transaction-pending'
        : fields.challengeStatus === 'PENDING' || fields.challengeStatus === 'IN_PROGRESS' ? 'challenge-pending' : 'ambiguous' };
    }
  }
  try {
    const hash = record.transactionHash ?? fields.providerHash ?? record.providerHash;
    const proof = await verifyPilotReceipt(arc, { ...record, ...fields, transactionHash: hash }, readInvoice);
    return { ...fields, ...proof, ...(['verified', 'reverted'].includes(proof.status) ? { transactionHash: hash } : {}),
      ...(proof.status === 'verified' ? { verificationSource: 'circle-reference-and-arc' } : {}) };
  } catch (error) {
    const notFound = ['TransactionNotFoundError', 'TransactionReceiptNotFoundError'].includes(error?.name);
    return { ...fields, status: notFound ? 'receipt-pending' : 'verification-pending' };
  }
}
