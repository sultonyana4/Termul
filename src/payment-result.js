import { decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress } from 'viem';

const TX_HASH_PATTERN = /\b0x[0-9a-fA-F]{64}\b/;

function errorText(error) {
  const values = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      values.push(value);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of ['shortMessage', 'message', 'details', 'reason', 'code', 'cause', 'data', 'metaMessages']) {
      visit(value[key], depth + 1);
    }
    if (Array.isArray(value)) value.forEach((item) => visit(item, depth + 1));
  };
  visit(error);
  return values.join(' ');
}

export function extractTransactionHash(error) {
  const direct = [error?.transactionHash, error?.hash, error?.data?.transactionHash, error?.data?.hash]
    .find((value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value));
  return direct || errorText(error).match(TX_HASH_PATTERN)?.[0] || null;
}

export function isAmbiguousPaymentError(error) {
  return /(already known|known transaction|nonce too low|replacement transaction underpriced|timed?\s*out|timeout|deadline exceeded|connection reset|socket|network error|fetch failed|request failed|gateway|temporarily unavailable|disconnected|unknown transaction|ambiguous)/i
    .test(errorText(error));
}

export function isDefinitelyNoSubmissionError(error) {
  return error?.code === 4001 || isInvoiceReadError(error) || isCircleInvoiceFeeReviewError(error) || /(user rejected|user denied|rejected the request|cancelled by user|canceled by user|insufficient funds|execution reverted|invalid params|unsupported method)/i
    .test(errorText(error));
}

export function isInvoiceReadError(error) {
  return ['ARC_DEPLOYMENT_RPC', 'ARC_PREFLIGHT_RPC', 'CIRCLE_FEE_QUOTE_UNAVAILABLE'].includes(error?.code);
}

export function isCircleInvoiceFeeReviewError(error) {
  return ['CIRCLE_FEE_REVIEW_STALE', 'CIRCLE_FEE_REVIEW_EXPIRED', 'CIRCLE_FEE_CAP_EXCEEDED'].includes(error?.code);
}

export function createPaymentSubmissionGate() {
  let inFlight = false;
  return async function runIfIdle(operation) {
    if (inFlight) return { started: false };
    inFlight = true;
    try {
      return { started: true, value: await operation() };
    } finally {
      inFlight = false;
    }
  };
}

export function getPaymentDisplayState({
  invoiceStatus,
  paymentStatus = null,
  knownPaid = false,
  expiresAt = 0n,
  nowSeconds = Math.floor(Date.now() / 1000),
  hasPaymentAttempt = false,
  statusCodes = { open: 1, paid: 2, cancelled: 3 },
}) {
  const paid = Number(invoiceStatus) === Number(statusCodes.paid) || paymentStatus === 'paid' || knownPaid;
  const expired = BigInt(expiresAt) !== 0n && BigInt(expiresAt) <= BigInt(nowSeconds);
  const label = paid
    ? 'Paid'
    : Number(invoiceStatus) === Number(statusCodes.cancelled)
      ? 'Cancelled'
      : expired ? 'Expired' : 'Open';
  return {
    label,
    paid,
    canPay: label === 'Open'
      && Number(invoiceStatus) === Number(statusCodes.open)
      && !hasPaymentAttempt,
  };
}

export function matchesPaymentTransaction(transaction, expected, payer = expected.payer) {
  if (!transaction || !expected?.abi) return false;
  try {
    if (getAddress(transaction.from) !== getAddress(payer)) return false;
    if (getAddress(transaction.to) !== getAddress(expected.contract)) return false;
    if (transaction.chainId !== null && transaction.chainId !== undefined
      && Number(BigInt(transaction.chainId)) !== Number(expected.chainId)) return false;
    if (BigInt(transaction.value ?? 0n) !== BigInt(expected.amount)) return false;
    const input = transaction.input || transaction.data;
    if (typeof input !== 'string' || !input.startsWith('0x')) return false;
    const decoded = decodeFunctionData({ abi: expected.abi, data: input });
    return decoded.functionName === 'payInvoice'
      && getAddress(decoded.args[0]) === getAddress(expected.merchant)
      && decoded.args[1].toLowerCase() === expected.invoiceId.toLowerCase()
      && input.toLowerCase() === encodeFunctionData({ abi: expected.abi, functionName: 'payInvoice', args: [expected.merchant, expected.invoiceId] }).toLowerCase();
  } catch {
    return false;
  }
}

function matchingPaymentEvent(logs, expected, payer, transactionHash) {
  if (!Array.isArray(logs)) return null;
  let match;
  for (const log of logs) {
    try {
      if (log.removed || (log.transactionHash && log.transactionHash.toLowerCase() !== transactionHash.toLowerCase())
        || getAddress(log.address) !== getAddress(expected.contract)) continue;
      const decoded = decodeEventLog({ abi: expected.abi, eventName: 'InvoicePaid', data: log.data, topics: log.topics });
      const args = decoded.args;
      if (args.invoiceId.toLowerCase() !== expected.invoiceId.toLowerCase()
        || getAddress(args.merchant) !== getAddress(expected.merchant)
        || getAddress(args.payer) !== getAddress(payer)
        || BigInt(args.amount) !== BigInt(expected.amount)) continue;
      if (match) return null;
      match = args;
    } catch {
      // Ignore unrelated logs, but never accept a partially decoded event.
    }
  }
  return match ?? null;
}

export function averagePaymentTime(invoices) {
  const paid = new Map();
  for (const invoice of invoices) {
    if (invoice.status !== 'paid' || !invoice.onchainVerified || !invoice.merchant || !invoice.invoiceId
      || !/^0x[a-f0-9]{64}$/i.test(invoice.createTxHash ?? '') || !/^0x[a-f0-9]{64}$/i.test(invoice.paymentTxHash ?? '')) continue;
    const key = `${invoice.merchant.toLowerCase()}:${invoice.invoiceId.toLowerCase()}`;
    const start = Date.parse(invoice.createdBlockTime);
    const end = Date.parse(invoice.paidBlockTime);
    if (!paid.has(key)) paid.set(key, null);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) paid.set(key, (end - start) / 1000);
  }
  const durations = [...paid.values()].filter(value => value !== null);
  return { seconds: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    samples: durations.length, eligible: paid.size };
}

function invoiceHasExpectedIdentity(invoice, expected) {
  return invoice && getAddress(invoice.merchant) === getAddress(expected.merchant)
    && BigInt(invoice.amount) === BigInt(expected.amount);
}

async function canonicalPaymentBlock(receipt, transaction, deps) {
  if (typeof receipt.blockNumber !== 'bigint' || !receipt.blockHash || receipt.blockHash !== transaction.blockHash
    || receipt.blockNumber !== transaction.blockNumber) return null;
  const [finalized, block] = await Promise.all([deps.readFinalizedBlock(), deps.readBlock(receipt.blockNumber)]);
  return finalized?.number >= receipt.blockNumber && block?.number === receipt.blockNumber && block.hash === receipt.blockHash ? block : null;
}

export async function verifyRevertedPayment(expected, deps, hash, receiptHint = null) {
  try {
    const receipt = receiptHint ?? await deps.readReceipt(hash);
    if (receipt?.status !== 'reverted' || receipt.transactionHash !== hash) return false;
    const transaction = await deps.readTransaction(hash);
    return transaction?.hash === hash && matchesPaymentTransaction(transaction, expected) && Boolean(await canonicalPaymentBlock(receipt, transaction, deps));
  } catch { return false; }
}

/** Verify successful payment independently of provider status and log-index freshness. */
export async function verifyPaymentReceipt(expected, deps, transactionHash, receiptHint = null) {
  if (!/^0x[a-f0-9]{64}$/i.test(transactionHash ?? '')) return null;
  try {
    const hintMatches = receiptHint?.transactionHash?.toLowerCase() === transactionHash.toLowerCase();
    const [receipt, transaction] = await Promise.all([
      hintMatches ? receiptHint : deps.readReceipt(transactionHash), deps.readTransaction(transactionHash),
    ]);
    if (receipt?.status !== 'success' || receipt.transactionHash?.toLowerCase() !== transactionHash.toLowerCase()
      || transaction?.hash?.toLowerCase() !== transactionHash.toLowerCase()
      || !matchesPaymentTransaction(transaction, expected, transaction.from)
      || !matchingPaymentEvent(receipt.logs, expected, transaction.from, transactionHash)) return null;
    const block = await canonicalPaymentBlock(receipt, transaction, deps);
    if (!block) return null;
    const state = await deps.readInvoiceAt(receipt.blockNumber);
    if (!invoiceHasExpectedIdentity(state, expected) || Number(state.status) !== Number(expected.status?.paid ?? 2)) return null;
    const payer = getAddress(transaction.from);
    return {
      status: 'paid', paymentTxHash: transactionHash, payer,
      payerMatchesExpected: expected.payer ? payer === getAddress(expected.payer) : null,
      receiptStatus: 'success', proofUnavailable: false,
      ...(typeof block.timestamp === 'bigint' && { paidAt: new Date(Number(block.timestamp) * 1000).toISOString() }),
    };
  } catch { return null; }
}

async function findConfirmedPayment(expected, deps, transactionHash, receiptHint) {
  const known = transactionHash || receiptHint?.transactionHash;
  const direct = known && await verifyPaymentReceipt(expected, deps, known, receiptHint);
  if (direct) return { ...direct, attemptMatchesExpected: true };
  let logs;
  try { logs = await deps.findPaymentLogs(); } catch { return null; }
  for (const hash of new Set((logs || []).filter(log => !log.removed).map(log => log.transactionHash))) {
    if (hash === known) continue;
    const proof = await verifyPaymentReceipt(expected, deps, hash);
    if (proof) return { ...proof, attemptMatchesExpected: !known };
  }
  return null;
}

export async function reconcilePaymentAttempt({
  expected,
  transactionHash = null,
  receiptHint = null,
  error = null,
  readChainId,
  readInvoice,
  readReceipt,
  readTransaction,
  findPaymentLogs,
  readFinalizedBlock,
  readBlock,
  readInvoiceAt,
  findPendingTransactions,
}) {
  const deps = { readReceipt, readTransaction, findPaymentLogs, readFinalizedBlock, readBlock, readInvoiceAt };
  let invoice;
  try {
    const chainId = await readChainId();
    if (Number(chainId) !== Number(expected.chainId)) {
      return { status: 'unavailable', invoice: null, paymentTxHash: null, reason: 'wrong-chain', ambiguous: isAmbiguousPaymentError(error) };
    }
    invoice = await readInvoice();
    if (!invoiceHasExpectedIdentity(invoice, expected)) {
      return { status: 'unavailable', invoice: null, paymentTxHash: null, reason: 'invoice-mismatch', ambiguous: isAmbiguousPaymentError(error) };
    }
  } catch {
    return { status: 'unavailable', invoice: null, paymentTxHash: null, reason: 'contract-read-failed', ambiguous: isAmbiguousPaymentError(error) };
  }

  const paidStatus = Number(expected.status?.paid ?? 2);
  const openStatus = Number(expected.status?.open ?? 1);
  const ambiguous = isAmbiguousPaymentError(error);

  if (Number(invoice.status) === paidStatus) {
    const proof = await findConfirmedPayment(expected, deps, transactionHash, receiptHint);
    const submittedRevertedHash = proof && transactionHash && expected.payer && proof.attemptMatchesExpected === false
      && await verifyRevertedPayment(expected, deps, transactionHash, receiptHint) ? transactionHash : undefined;
    return proof
      ? { ...proof, invoice, ambiguous, ...(submittedRevertedHash && { submittedRevertedHash }) }
      : { status: 'paid', invoice, paymentTxHash: null, payer: null, payerMatchesExpected: false, proofUnavailable: true, ambiguous };
  }

  if (Number(invoice.status) !== openStatus) {
    return { status: 'not-open', invoice, paymentTxHash: null, payer: null, proofUnavailable: false, ambiguous };
  }

  if (transactionHash || receiptHint || ambiguous) {
    const proof = await findConfirmedPayment(expected, deps, transactionHash, receiptHint);
    if (proof) return { ...proof, invoice, ambiguous, contractStatePending: true };
  }

  let receipt = receiptHint;
  if (transactionHash && (!receipt || receipt.transactionHash?.toLowerCase() !== transactionHash.toLowerCase())) {
    try { receipt = await readReceipt(transactionHash); } catch { receipt = null; }
  }

  if (transactionHash && receipt?.transactionHash?.toLowerCase() === transactionHash.toLowerCase()) {
    let transaction;
    try { transaction = await readTransaction(transactionHash); } catch { transaction = null; }
    const validTransaction = transaction?.hash?.toLowerCase() === transactionHash.toLowerCase()
      && matchesPaymentTransaction(transaction, expected);
    if (validTransaction && receipt.status === 'reverted') {
      if (await canonicalPaymentBlock(receipt, transaction, deps).catch(() => null)) {
        return { status: 'reverted', invoice, paymentTxHash: transactionHash, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: false };
      }
    }
    if (validTransaction && receipt.status === 'success') {
      const status = matchingPaymentEvent(receipt.logs, expected, expected.payer, transactionHash) ? 'pending' : 'unmatched';
      return { status, invoice, paymentTxHash: transactionHash, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: true };
    }
  }

  if (transactionHash) {
    let transaction;
    try { transaction = await readTransaction(transactionHash); } catch { transaction = null; }
    if (matchesPaymentTransaction(transaction, expected)) {
      return { status: 'pending', invoice, paymentTxHash: transactionHash, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: true };
    }
  }

  if (typeof findPendingTransactions === 'function') {
    try {
      const pending = await findPendingTransactions();
      const matches = (pending || []).filter((transaction) => matchesPaymentTransaction(transaction, expected));
      if (matches.length === 1) {
        return { status: 'pending', invoice, paymentTxHash: matches[0].hash || null, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: true };
      }
      if (matches.length > 1) {
        return { status: 'inconsistent', invoice, paymentTxHash: null, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: true };
      }
    } catch {
      // Pending-block reads are best effort. An ambiguous wallet result remains guarded by the app.
    }
  }

  return { status: 'open', invoice, paymentTxHash: transactionHash, payer: null, proofUnavailable: false, ambiguous };
}

export async function submitPaymentOnce({ submit, waitForReceipt, reconcile }) {
  let transactionHash = null;
  let receipt = null;
  let error = null;
  let stage = 'submit';
  try {
    transactionHash = await submit();
  } catch (caught) {
    error = caught;
  }
  if (transactionHash) {
    stage = 'receipt';
    try {
      receipt = await waitForReceipt(transactionHash);
    } catch (caught) {
      error = caught;
    }
  }
  const extractedHash = transactionHash || extractTransactionHash(error);
  const ambiguous = Boolean(error && (isAmbiguousPaymentError(error)
    || (stage === 'submit' && !isDefinitelyNoSubmissionError(error))));
  const reconciliationError = ambiguous && !isAmbiguousPaymentError(error)
    ? Object.assign(new Error('Payment submission outcome is ambiguous.'), { cause: error })
    : error;
  const result = await reconcile({ transactionHash: extractedHash, receiptHint: receipt, error: reconciliationError });
  return { transactionHash: extractedHash, receipt, error, stage, ambiguous, result };
}

export async function pollPaymentReconciliation({
  initialResult,
  reconcile,
  intervalMs = 2000,
  maxAttempts = 30,
  shouldContinue = () => true,
  onUpdate = () => {},
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  let result = initialResult;
  const isSettled = (value) => (value?.status === 'paid'
    && !value.contractStatePending
    && (!value.proofUnavailable || Boolean(value.paymentTxHash)))
    || value?.status === 'reverted'
    || value?.status === 'not-open'
    || (value?.status === 'open' && !value.ambiguous);

  for (let attempt = 0; attempt < maxAttempts && !isSettled(result); attempt += 1) {
    if (!shouldContinue()) break;
    const delay = typeof intervalMs === 'function' ? intervalMs(attempt, result) : intervalMs;
    await sleep(delay);
    if (!shouldContinue()) break;
    try {
      result = await reconcile();
    } catch (error) {
      result = { status: 'unavailable', reason: 'reconciliation-failed', ambiguous: true, error };
    }
    await onUpdate(result);
  }
  return result;
}
