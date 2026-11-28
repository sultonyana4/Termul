import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  numberToHex,
} from 'viem';
import { assertWalletProvider, sameWallet } from './wallet-provider.js';
import {
  createPaymentSubmissionGate,
  getPaymentDisplayState,
  isAmbiguousPaymentError,
  isCircleInvoiceFeeReviewError,
  isInvoiceReadError,
  matchesPaymentTransaction,
  pollPaymentReconciliation,
  reconcilePaymentAttempt,
  averagePaymentTime,
  submitPaymentOnce,
} from './payment-result.js';
import {
  matchesInvoiceCreationTransaction,
  pollInvoiceCreationReconciliation,
  reconcileInvoiceCreationAttempt,
  submitInvoiceCreationOnce,
} from './invoice-creation.js';
import { metadataApi } from './metadata-api.js';
import { arcNetwork, validatePaymentLinkNetwork, verifyInvoiceDeployment } from './arc-network.js';
import { transactionDialogFor } from './transaction-dialog.js';
import { arcReadFailure, describeArcReadFailure, readArc } from './arc-read.js';

const { chain, name: networkName, rpcUrl: ARC_RPC, contractAddress: CONTRACT_ADDRESS,
  deploymentBlock: CONTRACT_START_BLOCK, explorerUrl: EXPLORER } = arcNetwork;
const CHAIN_ID = chain?.id;
const LOG_BLOCK_RANGE = 9999n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_FORMATTED_TIMESTAMP = 253402300799n;
const STATUS = { none: 0, open: 1, paid: 2, cancelled: 3 };
const uncertainPaymentAttempts = new Map();
const paymentReconciliationWatchers = new Map();
const paymentReconciliationWatchComplete = new Set();
const runPaymentSubmissionIfIdle = createPaymentSubmissionGate();
const runInvoiceCreationIfIdle = createPaymentSubmissionGate();
const transactionDialog = transactionDialogFor(document.getElementById('transaction-dialog'));
const transactionNetwork = { name: networkName, explorerName: 'Arc Explorer', explorerUrl: EXPLORER };
let dashboardSync;
let merchantScan;
let historyTimer;
let sharedLinkError = null;
let creationRequiresReview = false;

const invoiceAbi = [
  {
    type: 'function',
    name: 'createInvoice',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'invoiceId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'payInvoice',
    stateMutability: 'payable',
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'invoiceId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getInvoice',
    stateMutability: 'view',
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'invoiceId', type: 'bytes32' },
    ],
    outputs: [
      {
        name: 'invoice',
        type: 'tuple',
        components: [
          { name: 'merchant', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'status', type: 'uint8' },
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'InvoiceCreated',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'invoiceId', type: 'bytes32' },
      { indexed: true, name: 'merchant', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'expiresAt', type: 'uint64' },
    ],
  },
  {
    type: 'event',
    name: 'InvoicePaid',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'invoiceId', type: 'bytes32' },
      { indexed: true, name: 'merchant', type: 'address' },
      { indexed: true, name: 'payer', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
];

const publicClient = chain && createPublicClient({ chain, transport: http(ARC_RPC, { retryCount: 0, timeout: 10_000 }) });
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const shortId = (id) => `${id.slice(0, 10)}…${id.slice(-8)}`;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function invoiceReadIssue(error) {
  return isInvoiceReadError(error) ? (error.code === 'CIRCLE_FEE_QUOTE_UNAVAILABLE' ? 'Circle fee estimate unavailable' : 'Arc connection unavailable')
    : /runtime bytecode|deployment block|wrong Arc Mainnet chain ID|Wrong Arc chain or Termul runtime/.test(error?.message ?? '')
      ? 'Contract verification failed' : undefined;
}

function formatUsdc(baseUnits) {
  const raw = formatUnits(BigInt(baseUnits), 18);
  const [whole = '0', fraction = ''] = raw.split('.');
  const groupedWhole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(BigInt(whole));
  const significantFraction = fraction.replace(/0+$/, '');
  const shownFraction = significantFraction.padEnd(2, '0');
  return `${groupedWhole}.${shownFraction}`;
}

function parseUsdc(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) {
    throw new Error('Enter a positive USDC amount with no more than six decimal places.');
  }
  const amount = parseUnits(normalized, 18);
  if (amount <= 0n || amount > MAX_UINT256) throw new Error('Invoice amount is outside the contract range.');
  return amount;
}

function randomInvoiceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function makeInvoiceLink(merchant, invoiceId) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('merchant', merchant);
  url.searchParams.set('invoiceId', invoiceId);
  url.searchParams.set('chainId', String(CHAIN_ID));
  url.searchParams.set('contract', CONTRACT_ADDRESS);
  return url.toString();
}

function showToast(message) {
  const toast = $('#toast');
  if (!toast) return;
  $('#toast-text').textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3600);
}

function transactionFeedback(type, amount, invoiceId, origin, scope) {
  return transactionDialog.begin({
    network: transactionNetwork, type, amount: `${formatUnits(BigInt(amount), 18)} USDC`,
    detail: `Invoice ${shortId(invoiceId)}`, origin, scope, assets: ['USDC'],
    successTitle: type === 'Invoice payment' ? 'Payment successful' : undefined,
  });
}

function updateDashboardPayment(merchant, invoiceId, proof) {
  if (proof.receiptStatus !== 'success' || !proof.paymentTxHash) return;
  window.arusPayApi?.updateInvoice(merchant, invoiceId, {
    status: 'paid', payer: proof.payer, paidAt: proof.paidAt ?? null, paidBlockTime: proof.paidAt ?? null,
    paymentTxHash: proof.paymentTxHash, paymentExplorerUrl: `${EXPLORER}/tx/${proof.paymentTxHash}`, onchainVerified: true,
  });
}

function paymentFeedbackState(outcome, feedback, { requirePayer = true } = {}) {
  if (outcome?.status === 'paid' && outcome.receiptStatus === 'success' && outcome.paymentTxHash) {
    if (!requirePayer || (outcome.payerMatchesExpected === true && outcome.attemptMatchesExpected !== false)) {
      feedback.update('confirmed', { verifiedHash: outcome.paymentTxHash,
        message: 'This invoice was paid and confirmed on Arc.' });
    } else {
      feedback.update('failed', { message: outcome.payerMatchesExpected
        ? 'This invoice was paid in a different transaction.' : 'This invoice has already been paid by another wallet.' });
    }
  } else if (outcome?.status === 'reverted') {
    feedback.update('failed', { message: 'The transaction reverted. Check the current invoice status before trying again.' });
  } else if (outcome?.status === 'not-open') {
    feedback.update('failed', { message: 'The contract reports that this invoice is closed.' });
  } else {
    feedback.update('pending', { message: 'Termul could not yet verify this payment and will not send a duplicate.' });
  }
}

async function getWallet() {
  const bridge = window.termulWallet;
  const selection = bridge?.getSelection();
  if (!selection?.address || selection.chainId !== CHAIN_ID) throw new Error('Connect your wallet on Arc Mainnet.');
  const provider = selection.type === 'circle' ? null : await bridge.getProvider(selection);
  const account = getAddress(selection.address);
  const assertReadyToSign = async () => {
    if (provider) await assertWalletProvider(provider, account);
    else bridge.assertSelection(selection);
    if (!sameWallet(selection, bridge.getSelection())) throw new Error('The connected wallet changed.');
    if (!bridge.session.isAuthenticated()) throw new Error('Verify wallet ownership before continuing.');
  };
  if (provider) await assertWalletProvider(provider, account);
  if (!sameWallet(selection, bridge.getSelection())) throw new Error('The connected wallet changed.');
  return { account, provider, selection, assertReadyToSign };
}

async function sendInvoiceTransaction(wallet, functionName, args, value, fee, { reserve, approve, submitted = () => {} } = {}) {
  const { account, provider, assertReadyToSign, selection } = wallet;
  await verifyInvoiceDeployment(publicClient, arcNetwork);
  if (selection.type === 'circle') {
    await assertReadyToSign();
    const operation = functionName === 'createInvoice'
      ? { kind: 'app-creation', invoiceId: args[0], amountBase: String(args[1]), expiresAt: String(args[2]) }
      : functionName === 'payInvoice' ? { kind: 'payment', merchant: args[0], invoiceId: args[1] } : null;
    if (!operation) throw new Error('Use an external wallet for this contract operation.');
    return window.termulWallet.sendManagedInvoice(selection, operation, { submitted });
  }
  const nonce = await publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
  const { gas, maxFeePerGas, maxPriorityFeePerGas } = fee.parameters;
  if (!Number.isSafeInteger(nonce) || nonce < 0 || gas <= 0n || maxFeePerGas < 20_000_000_000n
    || maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas || value < 0n || value > MAX_UINT256) {
    throw new Error('The reviewed transaction nonce, amount or fees are invalid.');
  }
  const tx = {
    from: account, to: CONTRACT_ADDRESS, chainId: numberToHex(CHAIN_ID), nonce: numberToHex(nonce),
    data: encodeFunctionData({ abi: invoiceAbi, functionName, args }), value: numberToHex(value),
    gas: numberToHex(gas), maxFeePerGas: numberToHex(maxFeePerGas), maxPriorityFeePerGas: numberToHex(maxPriorityFeePerGas),
  };
  if (await publicClient.getBalance({ address: account }) < value + gas * maxFeePerGas) {
    throw new Error('Insufficient native USDC for the invoice amount and network fee.');
  }
  await assertReadyToSign();
  if (reserve) await reserve();
  await assertReadyToSign();
  submitted(null);
  approve?.();
  let hash;
  try {
    hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
  } catch (error) {
    if (error?.code === 4001) throw error;
    throw new Error('The wallet submission outcome is ambiguous.', { cause: error });
  }
  if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) {
    throw new Error('The wallet did not return a valid transaction hash.');
  }
  submitted(hash);
  return hash;
}

function readInvoiceResult(result) {
  const fields = Array.isArray(result)
    ? { merchant: result[0], amount: result[1], expiresAt: result[2], status: result[3] }
    : result;
  return {
    merchant: getAddress(fields.merchant),
    amount: BigInt(fields.amount),
    expiresAt: BigInt(fields.expiresAt),
    status: Number(fields.status),
  };
}

async function getOnchainInvoice(merchant, invoiceId, verify = true, blockNumber) {
  if (verify) await verifyInvoiceDeployment(publicClient, arcNetwork);
  const expectedMerchant = getAddress(merchant);
  const result = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: invoiceAbi,
    functionName: 'getInvoice',
    args: [expectedMerchant, invoiceId],
    ...(blockNumber !== undefined && { blockNumber }),
  });
  const invoice = readInvoiceResult(result);
  if (invoice.status !== STATUS.none && (invoice.merchant !== expectedMerchant || invoice.amount <= 0n
    || ![STATUS.open, STATUS.paid, STATUS.cancelled].includes(invoice.status))) {
    throw new Error('The contract returned an invalid invoice record.');
  }
  return invoice;
}

function paymentAttemptKey(merchant, invoiceId) {
  return `${CHAIN_ID}:${CONTRACT_ADDRESS}:${merchant.toLowerCase()}:${String(invoiceId).toLowerCase()}`;
}
function localPaymentAttemptKey(key, userId) {
  return 'termul.payment-attempt:' + userId + ':' + key;
}

function getUncertainPaymentAttempt(merchant, invoiceId) {
  const key = paymentAttemptKey(merchant, invoiceId);
  const userId = window.termulCurrentWalletAddress || null;
  let persisted = null;
  if (userId) {
    try {
      const raw = window.localStorage.getItem(localPaymentAttemptKey(key, userId));
      persisted = raw && JSON.parse(raw);
    } catch {
      // The cloud hint or in-memory record can still be used for read-only reconciliation.
    }
  }
  const inMemory = uncertainPaymentAttempts.get(key);
  const attempt = inMemory?.ownerAddress === userId && (!persisted || inMemory.updatedAt >= persisted.updatedAt)
    ? inMemory : persisted;
  return attempt && attempt.merchant?.toLowerCase() === merchant.toLowerCase()
    && attempt.invoiceId?.toLowerCase() === invoiceId.toLowerCase()
    && attempt.ownerAddress === userId ? attempt : null;
}

function setUncertainPaymentAttempt(merchant, invoiceId, payer, transactionHash = null, amount = null, submission = null) {
  const key = paymentAttemptKey(merchant, invoiceId);
  const previous = getUncertainPaymentAttempt(merchant, invoiceId);
  const attempt = {
    merchant: getAddress(merchant),
    invoiceId,
    payer: payer ? getAddress(payer) : null,
    transactionHash: transactionHash || previous?.transactionHash || null,
    amount: amount === null || amount === undefined ? null : BigInt(amount).toString(),
    updatedAt: Date.now(),
    ownerAddress: submission?.ownerAddress || window.termulCurrentWalletAddress || null,
    attemptId: submission?.attemptId || previous?.attemptId || null,
    legacy: previous?.legacy || false,
  };
  if (attempt.ownerAddress && attempt.payer) {
    try {
      window.localStorage.setItem(localPaymentAttemptKey(key, attempt.ownerAddress), JSON.stringify(attempt));
    } catch {
      if (submission && !submission.started) throw new Error('Browser storage must be available to recover a payment.');
    }
  }
  if (attempt.ownerAddress === (window.termulCurrentWalletAddress || null)) {
    uncertainPaymentAttempts.set(key, attempt);
    paymentReconciliationWatchComplete.delete(key);
    if (attempt.attemptId && attempt.transactionHash) {
      void metadataApi.savePaymentAttempt(merchant, invoiceId, attempt.attemptId, attempt.transactionHash)
        .catch(() => showToast('The payment recovery details could not sync. Termul continues checking the contract.'));
    }
  }
  return attempt;
}

function clearUncertainPaymentAttempt(merchant, invoiceId, outcome) {
  const key = paymentAttemptKey(merchant, invoiceId);
  const attempt = getUncertainPaymentAttempt(merchant, invoiceId);
  uncertainPaymentAttempts.delete(key);
  paymentReconciliationWatchComplete.delete(key);
  const owner = window.termulCurrentWalletAddress;
  if (owner && attempt) {
    try { window.localStorage.removeItem(localPaymentAttemptKey(key, owner)); } catch { /* Keep cloud recovery available. */ }
    if (attempt.attemptId || attempt.legacy) {
      const verifiedHash = outcome?.payerMatchesExpected && outcome.attemptMatchesExpected !== false && outcome.receiptStatus === 'success'
        ? outcome.paymentTxHash : undefined;
      const revertedHash = outcome?.status === 'reverted' ? outcome.paymentTxHash : outcome?.submittedRevertedHash;
      const proof = verifiedHash ? { verifiedHash } : revertedHash ? { revertedHash } : undefined;
      void metadataApi.clearPaymentAttempt(merchant, invoiceId, attempt.attemptId, proof).catch(() => {});
    }
  }
}

function hydrateUncertainPaymentAttempt(merchant, invoiceId, row) {
  const owner = window.termulCurrentWalletAddress;
  if (!row || !owner) return null;
  try {
    if (getAddress(row.payer_address).toLowerCase() !== owner) return null;
    const attempt = {
      merchant: getAddress(merchant),
      invoiceId,
      payer: getAddress(row.payer_address),
      transactionHash: row.tx_hash || null,
      amount: null,
      updatedAt: Date.parse(row.updated_at) || Date.now(),
      ownerAddress: owner,
      attemptId: row.attempt_id || null,
      legacy: row.legacy === true,
    };
    uncertainPaymentAttempts.set(paymentAttemptKey(merchant, invoiceId), attempt);
    return attempt;
  } catch {
    return null;
  }
}

function clearLocalPaymentAttemptCache() {
  uncertainPaymentAttempts.clear();
  paymentReconciliationWatchComplete.clear();
}

async function getInvoicePaymentLogs(merchant, invoiceId) {
  if (import.meta.env.TERMUL_LOCAL_CIRCLE) {
    const { invoice } = await localHistory({ merchant, invoiceId }).catch(() => ({}));
    if (/^0x[\da-f]{64}$/i.test(invoice?.paymentTxHash ?? '')) return [{ transactionHash: invoice.paymentTxHash }];
    const event = invoiceAbi.find(item => item.name === 'InvoicePaid');
    const head = await readArc(() => publicClient.getBlock({ blockTag: 'finalized' }));
    if (head.number < CONTRACT_START_BLOCK) return [];
    const start = head.number - LOG_BLOCK_RANGE + 1n;
    return readArc(() => publicClient.getLogs({ address: CONTRACT_ADDRESS, event, strict: true,
      args: { merchant: getAddress(merchant), invoiceId }, fromBlock: start > CONTRACT_START_BLOCK ? start : CONTRACT_START_BLOCK, toBlock: head.number }));
  }
  const event = invoiceAbi.find((item) => item.type === 'event' && item.name === 'InvoicePaid');
  const latestBlock = await readArc(() => publicClient.getBlockNumber());
  let range = LOG_BLOCK_RANGE;
  for (let toBlock = latestBlock; toBlock >= CONTRACT_START_BLOCK;) {
    const fromBlock = toBlock - range + 1n > CONTRACT_START_BLOCK
      ? toBlock - range + 1n
      : CONTRACT_START_BLOCK;
    const page = await readArc(() => publicClient.getLogs({
      address: CONTRACT_ADDRESS,
      event,
      strict: true,
      args: { merchant: getAddress(merchant), invoiceId },
      fromBlock,
      toBlock,
    })).catch(error => {
      if (arcReadFailure(error) !== 'range' || range <= 1n) throw error;
      range /= 2n;
      return null;
    });
    if (!page) continue;
    if (page.length) return page;
    if (fromBlock === CONTRACT_START_BLOCK) break;
    toBlock = fromBlock - 1n;
  }
  return [];
}

async function localHistory(input) {
  const response = await fetch('/__termul_circle/history', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    cache: 'no-store', signal: AbortSignal.timeout(5000), body: JSON.stringify(input) });
  if (!response.ok) throw new Error('The local Arc invoice index is unavailable. Use Refresh to reconnect.');
  return response.json();
}

async function syncLocalHistory(merchant, active) {
  const metadata = metadataApi.listInvoices(merchant).catch(() => null);
  const state = await localHistory({ merchant });
  const result = await metadata;
  if (!active()) return;
  const details = new Map((result?.invoices ?? []).filter(row => row.merchant_address?.toLowerCase() === merchant.toLowerCase())
    .map(row => [row.invoice_id, row]));
  const rows = state.invoices.map(invoice => {
    const row = details.get(invoice.invoiceId);
    return row ? { ...invoice, name: row.client_name || invoice.name, email: row.client_email,
      description: row.description || invoice.description } : invoice;
  });
  if (state.status === 'current' || state.coverageStarted || rows.length) {
    window.arusPayApi?.replaceInvoices(rows, state.status === 'current' ? 'success' : 'partial');
  } else window.arusPayApi?.setInvoiceSyncState(state.status === 'unavailable' ? 'error' : 'loading');
  const rate = state.issue === 'rate-limited' ? 'Arc RPC is rate-limiting history reads. ' : '';
  const text = state.status === 'current' ? `${rows.length} verified Arc invoice${rows.length === 1 ? '' : 's'}.`
    : state.status === 'unavailable' ? `${rate}Invoice history is unavailable. Sync will resume automatically.`
      : state.recentFromBlock ? `${rate}Showing recent verified Arc activity and saved history. Totals are incomplete while earlier blocks sync.`
        : state.coverageStarted ? `${rate}Showing verified history through block ${state.throughBlock}. Totals are incomplete while sync resumes.`
        : 'Indexing finalized Arc invoice history. Totals will appear after sync completes.';
  setInvoiceSyncStatus(text + (state.status === 'current' && !result ? ' Showing verified Arc records without offchain details.' : ''));
  scheduleLocalHistory(merchant, active, state.status === 'current' ? 25_000 : 5000);
}

function scheduleLocalHistory(merchant, active, delay = 5000) {
  historyTimer = setTimeout(() => {
    if (!active()) return;
    if (document.hidden || $('#dashboard-view').classList.contains('hidden')) {
      scheduleLocalHistory(merchant, active, delay);
      return;
    }
    void syncLocalHistory(merchant, active).catch(error => {
      if (!active()) return;
      setInvoiceSyncStatus(error.message);
      scheduleLocalHistory(merchant, active);
    });
  }, delay);
}
async function reconcileOnchainPayment({ merchant, invoiceId, amount, payer, transactionHash = null, receiptHint = null, error = null }) {
  const expectedAmount = BigInt(amount);
  return reconcilePaymentAttempt({
    expected: {
      chainId: CHAIN_ID,
      contract: CONTRACT_ADDRESS,
      merchant: getAddress(merchant),
      invoiceId,
      payer: payer ? getAddress(payer) : null,
      amount: expectedAmount,
      abi: invoiceAbi,
      status: STATUS,
    },
    transactionHash,
    receiptHint,
    error,
    readChainId: () => publicClient.getChainId(),
    readInvoice: () => getOnchainInvoice(merchant, invoiceId),
    readReceipt: (hash) => publicClient.getTransactionReceipt({ hash }),
    readTransaction: (hash) => publicClient.getTransaction({ hash }),
    readFinalizedBlock: () => publicClient.getBlock({ blockTag: 'finalized' }),
    readBlock: (blockNumber) => publicClient.getBlock({ blockNumber }),
    readInvoiceAt: (blockNumber) => getOnchainInvoice(merchant, invoiceId, false, blockNumber),
    findPaymentLogs: () => getInvoicePaymentLogs(merchant, invoiceId),
    findPendingTransactions: async () => {
      const pendingBlock = await publicClient.getBlock({ blockTag: 'pending', includeTransactions: true });
      return pendingBlock.transactions.filter((transaction) => typeof transaction === 'object');
    },
  });
}

function startPaymentReconciliationWatch({ merchant, invoiceId, amount = null, payer = null, initialResult }) {
  const key = paymentAttemptKey(merchant, invoiceId);
  const watchUserId = window.termulCurrentWalletAddress;
  if (paymentReconciliationWatchers.has(key) || paymentReconciliationWatchComplete.has(key)) return;
  let expectedAmount = amount === null || amount === undefined ? null : BigInt(amount);
  let paidWithoutHashToastShown = false;
  if (initialResult?.status === 'paid' && initialResult.proofUnavailable && !initialResult.paymentTxHash
    && !getUncertainPaymentAttempt(merchant, invoiceId)) {
    setUncertainPaymentAttempt(merchant, invoiceId, payer, null, expectedAmount);
  }
  const watch = pollPaymentReconciliation({
    initialResult,
    intervalMs: (attempt) => attempt < 5 ? 2000 : Math.min(30000, 2000 * (2 ** Math.floor((attempt - 5) / 4))),
    maxAttempts: 20,
    shouldContinue: () => window.termulCurrentWalletAddress === watchUserId
      && Boolean(getUncertainPaymentAttempt(merchant, invoiceId)),
    reconcile: async () => {
      const attempt = getUncertainPaymentAttempt(merchant, invoiceId);
      if (!attempt) return { status: 'settled', ambiguous: false };
      if (expectedAmount === null) {
        const invoice = await getOnchainInvoice(merchant, invoiceId);
        expectedAmount = invoice.amount;
      }
      return reconcileOnchainPayment({
        merchant,
        invoiceId,
        amount: expectedAmount,
        payer: attempt.payer || payer,
        transactionHash: attempt.transactionHash || null,
        error: new Error('A previous wallet submission has an ambiguous result.'),
      });
    },
    onUpdate: async (outcome) => {
      if (window.termulCurrentWalletAddress !== watchUserId) return;
      const attempt = getUncertainPaymentAttempt(merchant, invoiceId);
      if (!attempt) return;
      paymentFeedbackState(outcome, { update: (phase, details) => transactionDialog.update(key, phase, details) });
      if (outcome.paymentTxHash && outcome.paymentTxHash !== attempt.transactionHash && outcome.payerMatchesExpected !== false && outcome.attemptMatchesExpected !== false) {
        setUncertainPaymentAttempt(merchant, invoiceId, attempt.payer || payer, outcome.paymentTxHash, expectedAmount);
      }
      if (outcome.status === 'paid') {
        const hashUnavailable = outcome.proofUnavailable && !outcome.paymentTxHash;
        if (hashUnavailable || outcome.contractStatePending) {
          setUncertainPaymentAttempt(
            merchant,
            invoiceId,
            attempt.payer || payer,
            outcome.paymentTxHash || attempt.transactionHash,
            expectedAmount,
          );
        } else {
          clearUncertainPaymentAttempt(merchant, invoiceId, outcome);
        }
        updateDashboardPayment(merchant, invoiceId, outcome);
        await renderPayment();
        if (outcome.contractStatePending) {
          showToast('A matching InvoicePaid event and successful receipt confirm payment. The RPC contract-state read is catching up; no second payment is available.');
        } else if (outcome.paymentTxHash) {
          showToast(`Paid on the invoice contract. Verified transaction: ${outcome.paymentTxHash}`);
        } else if (!paidWithoutHashToastShown) {
          paidWithoutHashToastShown = true;
          showToast('The invoice contract confirms Paid. Checking for its transaction receipt and explorer link.');
        }
      } else if (outcome.status === 'reverted') {
        clearUncertainPaymentAttempt(merchant, invoiceId, outcome);
        await renderPayment();
        showToast('The Arc receipt confirms that the payment reverted. No replacement was sent.');
      } else if (outcome.status === 'not-open') {
        clearUncertainPaymentAttempt(merchant, invoiceId);
        await renderPayment();
        showToast(`The contract reports ${statusText(outcome.invoice.status, outcome.invoice.expiresAt)}. No second payment was submitted.`);
      }
    },
  }).finally(async () => {
    paymentReconciliationWatchers.delete(key);
    if (getUncertainPaymentAttempt(merchant, invoiceId)) {
      if (window.termulCurrentWalletAddress === watchUserId) paymentReconciliationWatchComplete.add(key);
      await renderPayment();
    }
  });
  paymentReconciliationWatchers.set(key, watch);
}

async function getMerchantEventLogs(eventName, merchant, latestBlock, scan, active) {
  const event = invoiceAbi.find((item) => item.type === 'event' && item.name === eventName);
  if (!event) throw new Error(`The ${eventName} event is not configured.`);
  let range = LOG_BLOCK_RANGE;
  while (scan.next <= latestBlock) {
    const fromBlock = scan.next;
    const toBlock = fromBlock + range - 1n < latestBlock
      ? fromBlock + range - 1n
      : latestBlock;
    try {
      const page = await readArc(() => publicClient.getLogs({ address: CONTRACT_ADDRESS,
        event, strict: true, args: { merchant }, fromBlock, toBlock }), { active });
      if (!active()) throw new Error('The wallet or sync request changed.');
      scan.logs.push(...page);
      scan.next = toBlock + 1n;
    } catch (error) {
      if (arcReadFailure(error) !== 'range' || range <= 1n) throw error;
      range /= 2n;
    }
  }
  return scan.logs.filter(log => log.blockNumber <= latestBlock);
}

async function verifyDashboardEvent(log, expected, payment, active) {
  const hash = log.transactionHash;
  const [tx, receipt, block] = await Promise.all([
    readArc(() => publicClient.getTransaction({ hash }), { active }),
    readArc(() => publicClient.getTransactionReceipt({ hash }), { active }),
    readArc(() => publicClient.getBlock({ blockNumber: log.blockNumber }), { active }),
  ]);
  const match = payment ? matchesPaymentTransaction(tx, expected) : matchesInvoiceCreationTransaction(tx, expected);
  if (!match || tx.hash !== hash || tx.blockNumber !== log.blockNumber || tx.blockHash !== log.blockHash
    || receipt.status !== 'success' || receipt.transactionHash !== hash || receipt.blockNumber !== log.blockNumber
    || receipt.blockHash !== log.blockHash || block.number !== log.blockNumber || block.hash !== log.blockHash
    || !receipt.logs.some(item => !item.removed && item.transactionHash === hash && item.logIndex === log.logIndex
      && item.address.toLowerCase() === CONTRACT_ADDRESS && item.data === log.data && item.topics.join() === log.topics.join())) {
    throw new Error('Arc invoice receipt did not match the canonical transaction. Invoice totals were not updated.');
  }
  return new Date(Number(block.timestamp) * 1000).toISOString();
}

async function syncMerchantInvoices(merchantAddress, active) {
  const merchant = getAddress(merchantAddress);
  await verifyInvoiceDeployment(publicClient, arcNetwork);
  const metadata = metadataApi.listInvoices(merchant).catch(() => null);
  const { number: latestBlock, timestamp } = await readArc(() => publicClient.getBlock({ blockTag: 'finalized' }), { active });
  if (!active()) throw new Error('The wallet or sync request changed.');
  if (typeof latestBlock !== 'bigint' || latestBlock < CONTRACT_START_BLOCK) throw new Error('Arc finalized invoice history is unavailable.');
  merchantScan ??= { created: { next: CONTRACT_START_BLOCK, logs: [] }, paid: { next: CONTRACT_START_BLOCK, logs: [] } };
  const scan = merchantScan;
  const createdLogs = await getMerchantEventLogs('InvoiceCreated', merchant, latestBlock, scan.created, active);
  const paidLogs = await getMerchantEventLogs('InvoicePaid', merchant, latestBlock, scan.paid, active);
  const result = await metadata;
  const storedRows = Array.isArray(result?.invoices) ? result.invoices : [];
  const paidByInvoice = new Map();
  for (const log of paidLogs) {
    const args = log.args;
    if (!args?.invoiceId || log.removed || log.address?.toLowerCase() !== CONTRACT_ADDRESS
      || !log.transactionHash || args.merchant?.toLowerCase() !== merchant.toLowerCase()) continue;
    const key = args.invoiceId.toLowerCase();
    if (paidByInvoice.has(key)) throw new Error('Arc returned duplicate payment events; invoice data was not updated.');
    paidByInvoice.set(key, log);
  }

  const metadataById = new Map(storedRows
    .filter((row) => row?.invoice_id && row.merchant_address?.toLowerCase() === merchant.toLowerCase()
      && row.chain_id === CHAIN_ID && row.contract_address?.toLowerCase() === CONTRACT_ADDRESS)
    .map((row) => {
      const name = row.client_name || 'On-chain invoice';
      return [row.invoice_id.toLowerCase(), {
        id: `INV-${row.invoice_id.slice(2, 10).toUpperCase()}`,
        invoiceId: row.invoice_id,
        merchant,
        name,
        email: row.client_email || '',
        description: row.description || 'On-chain invoice',
        initials: name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'AP',
      }];
    }));
  const previousById = new Map(metadataById);
  for (const item of window.arusPayApi?.getInvoices() || []) {
    if (!item.invoiceId || item.merchant?.toLowerCase() !== merchant.toLowerCase()) continue;
    const key = item.invoiceId.toLowerCase();
    previousById.set(key, { ...previousById.get(key), ...item });
  }
  const synced = [];
  for (const createdLog of createdLogs) {
    const created = createdLog.args;
    if (!created?.invoiceId || createdLog.removed || createdLog.address?.toLowerCase() !== CONTRACT_ADDRESS
      || !createdLog.transactionHash || created.merchant?.toLowerCase() !== merchant.toLowerCase()) continue;
    const invoiceId = created.invoiceId;
    const key = invoiceId.toLowerCase();
    const known = previousById.get(key);
    const invoice = await readArc(() => getOnchainInvoice(merchant, invoiceId, false, latestBlock), { active });
    if (invoice.status === STATUS.none
      || invoice.amount !== BigInt(created.amount)
      || invoice.expiresAt !== BigInt(created.expiresAt)) {
      throw new Error('Arc invoice event and current contract state do not match. Invoice data was not updated.');
    }

    const paymentLog = paidByInvoice.get(key);
    if (invoice.status === STATUS.paid) {
      if (!paymentLog || BigInt(paymentLog.args.amount) !== invoice.amount
        || paymentLog.args.merchant?.toLowerCase() !== merchant.toLowerCase()) {
        throw new Error('A paid invoice is missing its matching Arc payment event. Payment totals were not updated.');
      }
    } else if (paymentLog) {
      throw new Error('Arc returned a payment event for an invoice that is not paid. Payment totals were not updated.');
    }

    const expected = { chainId: CHAIN_ID, contract: CONTRACT_ADDRESS, merchant, invoiceId, amount: invoice.amount, expiresAt: invoice.expiresAt, abi: invoiceAbi };
    const createdAt = await verifyDashboardEvent(createdLog, expected, false, active);
    const paidAt = paymentLog ? await verifyDashboardEvent(paymentLog, { ...expected, payer: paymentLog.args.payer }, true, active) : null;
    const humanStatus = statusText(invoice.status, invoice.expiresAt, timestamp).toLowerCase();
    synced.push({
      ...known,
      id: known?.id || `INV-${invoiceId.slice(2, 10).toUpperCase()}`,
      invoiceId,
      merchant,
      amount: formatUnits(invoice.amount, 18),
      amountBase: invoice.amount.toString(),
      due: invoice.expiresAt === 0n || invoice.expiresAt > MAX_FORMATTED_TIMESTAMP
        ? '' : new Date(Number(invoice.expiresAt) * 1000).toISOString().slice(0, 10),
      name: known?.name || 'On-chain invoice',
      description: known?.description || 'On-chain invoice',
      initials: known?.initials || 'AP',
      status: humanStatus,
      createdAt: createdAt || known?.createdAt || null, createdBlockTime: createdAt,
      createTxHash: createdLog.transactionHash,
      explorerUrl: `${EXPLORER}/tx/${createdLog.transactionHash}`,
      ...(paymentLog ? {
        payer: paymentLog.args.payer,
        paidAt: paidAt || known?.paidAt || null, paidBlockTime: paidAt,
        paymentTxHash: paymentLog.transactionHash,
        paymentExplorerUrl: `${EXPLORER}/tx/${paymentLog.transactionHash}`,
      } : {}),
      onchainVerified: true,
    });
  }
  return { invoices: synced.reverse(), missingMetadata: !result };
}

async function estimateFee(functionName, args, account, value = 0n) {
  const request = { account, address: CONTRACT_ADDRESS, abi: invoiceAbi, functionName, args, value };
  const gas = await publicClient.estimateContractGas(request);
  const parameters = { gas };
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  parameters.maxPriorityFeePerGas = maxPriorityFeePerGas;
  parameters.maxFeePerGas = maxFeePerGas < 20_000_000_000n ? 20_000_000_000n : maxFeePerGas;
  const fee = gas * parameters.maxFeePerGas;
  if (await publicClient.getBalance({ address: account }) < value + fee) {
    throw new Error('Insufficient native USDC for the invoice amount and estimated network fee.');
  }
  return { parameters, fee };
}

function amountFromForm() {
  let total = 0n;
  const descriptions = [];
  for (const row of $$('.line-item')) {
    const quantityText = row.querySelector('.item-qty').value;
    if (!/^\d+$/.test(quantityText) || BigInt(quantityText) < 1n) throw new Error('Quantity must be a positive whole number.');
    const quantity = BigInt(quantityText);
    const price = parseUsdc(row.querySelector('.item-price').value);
    total += price * quantity;
    const description = row.querySelector('.item-description').value.trim();
    if (description) descriptions.push(description);
  }
  if (total > MAX_UINT256) throw new Error('Invoice total exceeds the contract range.');
  return { total, description: descriptions.join(', ') };
}

function expirationFromForm() {
  const dueValue = $('#due-date').value;
  if (!dueValue) throw new Error('Choose an invoice due date.');
  const due = new Date(`${dueValue}T23:59:59`);
  const seconds = Math.floor(due.getTime() / 1000);
  if (!Number.isFinite(seconds) || seconds <= Math.floor(Date.now() / 1000)) {
    throw new Error('Due date must be in the future.');
  }
  return BigInt(seconds);
}

function formInvoiceMetadata() {
  const name = $('#client-name').value.trim();
  const email = $('#client-email').value.trim();
  const { total, description } = amountFromForm();
  return {
    name,
    email,
    description,
    amount: formatUnits(total, 18),
    amountBase: total.toString(),
    due: $('#due-date').value,
    initials: name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'CL',
    status: 'open',
    createdAt: new Date().toISOString(),
  };
}

async function createOnchainInvoice() {
  if (arcNetwork.error) {
    showToast(arcNetwork.error);
    return;
  }
  if (creationRequiresReview) {
    showToast('Check the previous creation transaction and refresh the invoice dashboard before creating another invoice.');
    return;
  }
  if (!window.termulWallet?.session.isAuthenticated() || window.termulWallet.getSelection()?.chainId !== CHAIN_ID) {
    window.arusPayApi?.navigate('create');
    return;
  }
  const form = $('#invoice-form');
  const submit = form.querySelector('[type="submit"]');
  const started = await runInvoiceCreationIfIdle(async () => {
    if (!form.reportValidity()) return;
    submit.disabled = true;
    const originalSubmit = submit.innerHTML;
    const setStatus = (message) => {
      let status = $('#invoice-create-status');
      if (!status) {
        status = document.createElement('p');
        status.id = 'invoice-create-status';
        status.className = 'hint hidden';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.style.textAlign = 'center';
        submit.after(status);
      }
      status.textContent = message;
      status.classList.toggle('hidden', !message);
    };
    const updateStatus = (message) => {
      submit.textContent = message ? `Checking ${networkName}…` : originalSubmit;
      setStatus(message);
    };
    let feedback;
    try {
      const metadata = formInvoiceMetadata();
      const expiresAt = expirationFromForm();
      const invoiceId = randomInvoiceId();
      feedback = transactionFeedback('Invoice creation', metadata.amountBase, invoiceId, submit);
      const wallet = await getWallet();
      const { account } = wallet;
      await window.termulWallet.session.authenticate({ fresh: true });
      await wallet.assertReadyToSign();
      const expected = {
        chainId: CHAIN_ID,
        contract: CONTRACT_ADDRESS,
        merchant: account,
        invoiceId,
        amount: BigInt(metadata.amountBase),
        expiresAt,
        abi: invoiceAbi,
      };
      const fee = wallet.selection.type === 'circle' ? null : await estimateFee('createInvoice', [invoiceId, expected.amount, expiresAt], account);
      updateStatus('Waiting for wallet approval. Termul will submit this invoice only once.');

      const reconcile = async (attempt = {}) => {
        if (isCircleInvoiceFeeReviewError(attempt.error) || isInvoiceReadError(attempt.error)) return { status: 'failed', transactionHash: null };
        // Continue reading the same Circle attempt even after the initial SDK polling ends.
        // Never ask for a new signature or submission during reconciliation.
        if (wallet.selection.type === 'circle' && !attempt.transactionHash
          && attempt.error && attempt.error.code !== 4001
          && sameWallet(wallet.selection, window.termulWallet?.getSelection())) {
          try {
            const saved = await window.termulWallet.getManagedInvoiceStatus(wallet.selection);
            if (saved?.kind === 'app-creation' && saved.invoiceId === invoiceId
              && saved.walletAddress.toLowerCase() === account.toLowerCase()
              && saved.status === 'verified' && /^0x[0-9a-f]{64}$/i.test(saved.transactionHash)) {
              attempt = { ...attempt, transactionHash: saved.transactionHash };
            }
          } catch { /* Leave the original outcome pending; do not retry execution. */ }
        }
        return reconcileInvoiceCreationAttempt({
          expected,
          ...attempt,
          readChainId: () => publicClient.getChainId(),
          readReceipt: (hash) => publicClient.getTransactionReceipt({ hash }),
          readTransaction: (hash) => publicClient.getTransaction({ hash }),
        });
      };
      const attempt = await submitInvoiceCreationOnce({
        submit: () => sendInvoiceTransaction(wallet, 'createInvoice', [invoiceId, expected.amount, expiresAt], 0n, fee, {
          approve: () => feedback.update('approval', { message: `Review invoice creation in your wallet. Estimated fee: ${formatUsdc(fee.fee)} USDC.` }),
        }),
        waitForReceipt: (hash) => {
          feedback.update('submitted');
          return publicClient.waitForTransactionReceipt({ hash, timeout: 45000, pollingInterval: 1500 });
        },
        reconcile,
      });

      let outcome = attempt.result;
      if (!['created', 'reverted', 'failed', 'unmatched'].includes(outcome.status)) {
        feedback.update('pending');
        updateStatus('The wallet returned an ambiguous result. Checking the exact signed transaction and invoice event; do not retry or approve again.');
        showToast('The wallet response does not prove failure. Termul is checking this exact invoice transaction; no second transaction will be sent.');
        outcome = await pollInvoiceCreationReconciliation({
          initialResult: outcome,
          maxAttempts: 30,
          shouldContinue: () => sameWallet(wallet.selection, window.termulWallet?.getSelection()),
          reconcile: () => reconcile({
            transactionHash: attempt.transactionHash,
            receiptHint: attempt.receipt,
            error: attempt.error,
          }),
          onUpdate: (result) => {
            if (!['created', 'reverted', 'failed', 'unmatched'].includes(result.status)) {
              updateStatus(`Still checking the same transaction on ${networkName}. Do not retry or approve again.`);
            }
          },
        });
      }

      if (!sameWallet(wallet.selection, window.termulWallet?.getSelection())) return;
      if (outcome.status === 'created') {
        const hash = outcome.transactionHash;
        feedback.update('confirmed', { verifiedHash: hash, message: 'The invoice was created on Arc Mainnet. Its payment link is ready to copy.' });
        const record = {
          ...metadata,
          id: `INV-${new Date().getFullYear()}-${invoiceId.slice(2, 10).toUpperCase()}`,
          invoiceId,
          merchant: account,
          createTxHash: hash,
          explorerUrl: `${EXPLORER}/tx/${hash}`,
          onchainVerified: true,
        };
        form.reset();
        $$('.line-item').slice(1).forEach((line) => line.remove());
        const first = $$('.line-item')[0];
        first.querySelector('.item-qty').value = '1';
        first.querySelector('.item-description').value = '';
        first.querySelector('.item-price').value = '';
        window.updatePreview?.();
        setStatus('');
        window.arusPayApi?.addInvoice(record);
        let metadataSaved = true;
        let metadataSaveError = '';
        try {
          await metadataApi.saveInvoice({
            chainId: CHAIN_ID,
            contractAddress: CONTRACT_ADDRESS,
            merchantAddress: account,
            invoiceId,
            amountNative: metadata.amountBase,
            clientName: metadata.name,
            clientEmail: metadata.email,
            description: metadata.description,
            expiresAt: expiresAt.toString(),
            createTxHash: hash,
          });
        } catch (error) {
          metadataSaved = false;
          metadataSaveError = error?.message || '';
        }
        showToast(metadataSaved
          ? `Invoice confirmed on ${networkName}. Its payment link is ready to copy.`
          : metadataSaveError || `Invoice confirmed on ${networkName}; its payment link is ready, but details could not sync to Supabase.`);
      } else if (outcome.status === 'reverted') {
        feedback.update('failed', { message: 'The transaction reverted. No invoice was created.' });
        setStatus(`${networkName} confirmed that this transaction reverted. No invoice was created.`);
        showToast('The transaction reverted. No invoice is recorded, and Termul did not resend it.');
      } else if (outcome.status === 'failed') {
        if (isCircleInvoiceFeeReviewError(attempt.error)) {
          feedback.update('failed', { title: 'Review a new network fee', message: attempt.error.message });
          setStatus('The fee review ended before submission. Your invoice details are still here.');
          return;
        }
        feedback.update(attempt.error?.code === 4001 ? 'rejected' : 'failed', { title: invoiceReadIssue(attempt.error), message: attempt.error?.shortMessage || attempt.error?.message });
        setStatus('No invoice transaction was confirmed. You may review the form and decide what to do next.');
        showToast(attempt.error?.shortMessage || attempt.error?.message || 'Invoice creation was not submitted.');
      } else if (outcome.status === 'unmatched') {
        feedback.update('pending', { message: 'The receipt could not be matched to this invoice. Check your wallet and invoice dashboard before trying again.' });
        creationRequiresReview = true;
        setStatus('The transaction could not be matched to this exact invoice. No payment link was created.');
        showToast('The receipt did not match this invoice ID, merchant, amount, and expiry. No invoice link was created.');
      } else {
        feedback.update('pending');
        creationRequiresReview = true;
        const review = outcome.transactionHash || attempt.transactionHash;
        setStatus(`The exact transaction is still unverified. Check the invoice dashboard and wallet history before trying again.${review ? ' Transaction hash to review: ' + review : ''}`);
        showToast('The outcome is still uncertain. No second transaction was sent and no invoice was marked successful.');
      }
    } catch (error) {
      feedback?.update(error?.code === 4001 ? 'rejected' : 'failed', { title: invoiceReadIssue(error), message: error?.shortMessage || error?.message });
      setStatus('Invoice creation did not complete. No success is recorded without an exact successful receipt and InvoiceCreated event.');
      showToast(error?.shortMessage || error?.message || 'Invoice creation failed. No success is recorded without a confirmed receipt.');
    } finally {
      if (submit?.isConnected) {
        submit.disabled = creationRequiresReview;
        submit.innerHTML = originalSubmit;
      }
    }
  });
  if (!started.started) showToast('Invoice creation is already in progress. No second transaction was sent.');
}

function statusText(status, expiresAt, timestamp = BigInt(Math.floor(Date.now() / 1000))) {
  if (status === STATUS.paid) return 'Paid';
  if (status === STATUS.cancelled) return 'Cancelled';
  if (status === STATUS.none) return 'Not found';
  if (expiresAt !== 0n && expiresAt <= timestamp) return 'Expired';
  return 'Open';
}

function renderPaymentUnavailable(message, merchant = '', invoiceId = '') {
  const view = $('#payment-view');
  view.innerHTML = `<div class="panel payment-empty"><div class="payment-unavailable" role="status"><div class="availability-icon" aria-hidden="true">!</div><span class="eyebrow">${networkName} invoice</span><h1>Invoice unavailable</h1><p>${escapeHtml(message)}</p><p>The app will not submit a payment while contract status is unavailable. Check status again when the Arc RPC responds.</p>${merchant && invoiceId ? `<div class="availability-details"><span><b>Merchant</b> ${escapeHtml(merchant)}</span><span><b>Invoice ID</b> <span class="mono">${escapeHtml(shortId(invoiceId))}</span></span></div>` : ''}<button class="btn btn-quiet" id="retry-payment-status" type="button">Check payment status</button> <button class="btn btn-quiet" id="payment-back">Back to invoices</button></div></div>`;
  $('#retry-payment-status')?.addEventListener('click', () => {
    if (merchant && invoiceId) paymentReconciliationWatchComplete.delete(paymentAttemptKey(merchant, invoiceId));
    void renderPayment();
  });
  $('#payment-back')?.addEventListener('click', () => window.arusPayApi?.navigate('dashboard'));
}

async function renderPayment(managedHint) {
  const requestId = ++paymentRenderRequest;
  const view = $('#payment-view');
  const selected = window.arusPayApi?.getSelectedInvoice();
  const renderUserId = window.termulCurrentWalletAddress;
  const isCurrentRender = () => requestId === paymentRenderRequest && renderUserId === window.termulCurrentWalletAddress;
  if (!selected?.merchant || !selected?.invoiceId) {
    renderPaymentUnavailable(sharedLinkError || arcNetwork.error || `Select an invoice or open a valid ${networkName} payment link.`);
    return;
  }
  view.innerHTML = `<div class="panel payment-empty"><div class="empty-state"><strong>Reading ${networkName}</strong><span>Checking invoice state directly from the contract…</span></div></div>`;
  try {
    // Fetch public invoice details in parallel with the authoritative contract read.
    const publicMetadata = metadataApi.publicInvoice(selected.merchant, selected.invoiceId);
    let invoice = await getOnchainInvoice(selected.merchant, selected.invoiceId);
    if (!isCurrentRender()) return;
    let paymentAttempt = getUncertainPaymentAttempt(selected.merchant, selected.invoiceId);
    let settledHash;
    if (!paymentAttempt?.transactionHash) {
      try {
        const stored = await metadataApi.getPaymentAttempt(selected.merchant, selected.invoiceId);
        if (!isCurrentRender()) return;
        if (!paymentAttempt || stored?.attempt?.tx_hash) paymentAttempt = hydrateUncertainPaymentAttempt(selected.merchant, selected.invoiceId, stored?.attempt) ?? paymentAttempt;
        settledHash = stored?.settled?.tx_hash;
      } catch {
        // A cloud hint never substitutes for the contract read above.
      }
    }
    let paymentReconciliation = null;
    if (managedHint?.status === 'verified' && managedHint.invoiceId === selected.invoiceId &&
      managedHint.merchant?.toLowerCase() === selected.merchant.toLowerCase()) settledHash = managedHint.transactionHash;
    if (invoice.status === STATUS.paid || paymentAttempt || settledHash) {
      paymentReconciliation = await reconcileOnchainPayment({
        merchant: selected.merchant,
        invoiceId: selected.invoiceId,
        amount: invoice.amount,
        payer: paymentAttempt?.payer || activeWalletAddress,
        transactionHash: paymentAttempt?.transactionHash || settledHash || null,
        error: paymentAttempt ? new Error('A previous wallet submission has an ambiguous result.') : null,
      });
      if (!isCurrentRender()) return;
      if (paymentReconciliation.invoice) invoice = paymentReconciliation.invoice;
      if (paymentAttempt || settledHash) paymentFeedbackState(paymentReconciliation, {
        update: (phase, details) => transactionDialog.update(paymentAttemptKey(selected.merchant, selected.invoiceId), phase, details),
      });
      if ((paymentReconciliation.status === 'paid'
          && !paymentReconciliation.contractStatePending
          && !(paymentReconciliation.proofUnavailable && !paymentReconciliation.paymentTxHash))
        || paymentReconciliation.status === 'reverted' || paymentReconciliation.status === 'not-open') {
        clearUncertainPaymentAttempt(selected.merchant, selected.invoiceId, paymentReconciliation);
        paymentAttempt = null;
      }
      if (paymentReconciliation.status === 'paid') {
        if ((paymentReconciliation.contractStatePending
            || (paymentReconciliation.proofUnavailable && !paymentReconciliation.paymentTxHash))
          && !paymentAttempt && activeWalletAddress) {
          paymentAttempt = setUncertainPaymentAttempt(
            selected.merchant,
            selected.invoiceId,
            activeWalletAddress,
            null,
            invoice.amount,
          );
        }
        updateDashboardPayment(selected.merchant, selected.invoiceId, paymentReconciliation);
      }
    }
    const known = window.arusPayApi?.getInvoices().find((item) => item.invoiceId?.toLowerCase() === selected.invoiceId.toLowerCase()
      && item.merchant?.toLowerCase() === selected.merchant.toLowerCase());
    const publicDetails = await publicMetadata;
    if (!isCurrentRender()) return;
    const clientName = publicDetails?.clientName || known?.name || 'Invoice recipient';
    const description = publicDetails?.description || known?.description || 'On-chain invoice';
    const invoiceNumber = known?.id || (publicDetails
      ? `INV-${selected.invoiceId.slice(2, 10).toUpperCase()}` : shortId(selected.invoiceId));
    const paymentDisplay = getPaymentDisplayState({
      invoiceStatus: invoice.status,
      paymentStatus: paymentReconciliation?.status,
      knownPaid: known?.status === 'paid' && known?.onchainVerified,
      expiresAt: invoice.expiresAt,
      hasPaymentAttempt: Boolean(paymentAttempt),
      statusCodes: STATUS,
    });
    const status = paymentDisplay.label;
    if (invoice.status === STATUS.none) throw new Error('This invoice ID does not exist for the specified merchant.');
    const amount = formatUsdc(invoice.amount);
    const due = invoice.expiresAt === 0n ? 'No expiry' : invoice.expiresAt > MAX_FORMATTED_TIMESTAMP
      ? `Unix timestamp ${invoice.expiresAt}` : new Date(Number(invoice.expiresAt) * 1000).toLocaleString('en-US');
    const link = makeInvoiceLink(invoice.merchant, selected.invoiceId);
    const canPay = paymentDisplay.canPay;
    const stateClass = paymentDisplay.paid ? 'paid' : invoice.status === STATUS.cancelled || status === 'Expired' ? 'overdue' : 'pending';
    view.innerHTML = `<div class="pay-crumb"><button class="table-link" id="payment-invoices">Invoices</button> <span style="color:#596578">/</span> <span class="mono">${escapeHtml(shortId(selected.invoiceId))}</span></div><div class="pay-layout"><section class="pay-main-card"><div class="pay-business"><div class="business-logo">AP</div><div><strong>Termul invoice</strong><span class="mono">${escapeHtml(shortId(selected.invoiceId))}</span></div></div><div class="pay-content"><span class="eyebrow">${networkName} · On-chain status</span><h1>${escapeHtml(status)}</h1><p>${publicDetails?.clientName || known?.name ? `Invoice for ${escapeHtml(clientName)}` : `Invoice details read from ${networkName}.`}</p><div class="pay-due"><div class="pay-due-label">${invoice.status === STATUS.paid ? 'Amount paid' : 'Amount due'}</div><div class="pay-due-amount">${escapeHtml(amount)} <span>USDC</span></div></div><div class="pay-network"><span class="chain-name"><i class="chain-icon">A</i> ${networkName}</span><span class="status ${stateClass}">${escapeHtml(status)}</span></div><div class="availability-details"><span><b>Merchant</b> <span class="mono">${escapeHtml(invoice.merchant)}</span></span><span><b>Due / expiry</b> ${escapeHtml(due)}</span><span><b>Invoice ID</b> <span class="mono">${escapeHtml(selected.invoiceId)}</span></span></div><div class="fee-note"><span>ⓘ</span><span>Estimated fees are paid by your wallet in USDC. No gas sponsorship is used.</span></div>${canPay ? `<button class="btn btn-primary btn-full" id="pay-onchain" type="button">Pay invoice on ${networkName}</button>` : ''}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn btn-quiet btn-sm" id="copy-invoice-link" type="button">Copy payment link</button><a class="btn btn-quiet btn-sm" href="${EXPLORER}/address/${CONTRACT_ADDRESS}" target="_blank" rel="noreferrer">View contract</a></div>${known?.createTxHash ? `<p class="hint">Creation receipt: <a class="table-link" href="${EXPLORER}/tx/${known.createTxHash}" target="_blank" rel="noreferrer">${escapeHtml(shortAddress(known.createTxHash))}</a></p>` : ''}${known?.paymentTxHash ? `<p class="hint">Payment receipt: <a class="table-link" href="${EXPLORER}/tx/${known.paymentTxHash}" target="_blank" rel="noreferrer">${escapeHtml(shortAddress(known.paymentTxHash))}</a></p>` : ''}<p class="hint">Client name, email, descriptions, and notes are not written to the contract.</p></div></section><aside class="pay-summary"><h2>Invoice summary</h2><div class="summary-row"><span>Invoice number</span><strong>${escapeHtml(invoiceNumber)}</strong></div><div class="summary-row"><span>Client</span><strong>${escapeHtml(clientName)}</strong></div><div class="summary-row"><span>Description</span><strong>${escapeHtml(description)}</strong></div><div class="summary-row"><span>Due date</span><strong>${escapeHtml(due)}</strong></div><div class="summary-row summary-total"><span>Total</span><strong>${escapeHtml(amount)} USDC</strong></div><div class="payment-foot">State is read from the ${networkName} contract.</div></aside></div>`;
    if (known?.paymentTxHash && !paymentReconciliation?.paymentTxHash) {
      const staleReceipt = [...view.querySelectorAll('a')]
        .find((anchor) => anchor.href === `${EXPLORER}/tx/${known.paymentTxHash}`);
      staleReceipt?.closest('p')?.remove();
    }
    if (paymentDisplay.paid) {
      const amountLabel = view.querySelector('.pay-due-label');
      if (amountLabel) amountLabel.textContent = 'Amount paid';
    }
    const paymentButton = $('#pay-onchain');
    const resultPanel = document.createElement('div');
    resultPanel.className = 'payment-result-status';
    resultPanel.setAttribute('role', 'status');
    resultPanel.style.marginTop = '12px';
    if (paymentReconciliation?.status === 'paid') {
      const paidMessage = document.createElement('p');
      paidMessage.className = 'hint';
      paidMessage.textContent = paymentReconciliation.contractStatePending
        ? 'A matching InvoicePaid event and successful receipt confirm Paid. The RPC contract-state read is catching up; Termul keeps payment locked and will verify again automatically.'
        : paymentReconciliation.paymentTxHash
        ? `Paid on the invoice contract. Verified payer: ${paymentReconciliation.payer}. Transaction hash: `
        : 'Paid on the invoice contract. The payment receipt and exact transaction hash are not available from the RPC yet; check status again.';
      resultPanel.append(paidMessage);
      if (paymentReconciliation.paymentTxHash) {
        const receiptLink = document.createElement('a');
        receiptLink.href = `${EXPLORER}/tx/${paymentReconciliation.paymentTxHash}`;
        receiptLink.target = '_blank';
        receiptLink.rel = 'noreferrer';
        receiptLink.className = 'mono';
        receiptLink.style.overflowWrap = 'anywhere';
        receiptLink.textContent = paymentReconciliation.paymentTxHash;
        resultPanel.append(receiptLink);
      } else {
        const checkButton = document.createElement('button');
        checkButton.type = 'button';
        checkButton.className = 'btn btn-quiet btn-sm';
        checkButton.textContent = 'Check payment status';
        checkButton.addEventListener('click', () => {
          paymentReconciliationWatchComplete.delete(paymentAttemptKey(selected.merchant, selected.invoiceId));
          void renderPayment();
        });
        resultPanel.append(checkButton);
      }
    } else if (paymentAttempt) {
      const stateMessage = document.createElement('p');
      stateMessage.className = 'hint';
      stateMessage.textContent = paymentReconciliation?.status === 'pending'
        ? 'The contract still reports Open, but a matching payment transaction is pending. If Your wallet popup still shows an error, close it with X—do not tap “Retry transaction” or approve again. Leave this page open while Termul checks the receipt; no second payment is being submitted.'
        : paymentReconciliation?.status === 'unavailable'
          ? paymentReconciliationWatchers.has(paymentAttemptKey(selected.merchant, selected.invoiceId))
            ? 'The last payment request has an uncertain result. If Your wallet popup still shows an error, close it with X—do not tap “Retry transaction” or approve again. Leave this page open; Termul is checking the contract and payment events without submitting another payment.'
            : 'The last payment request has an uncertain result, and the contract could not be re-read. Dismiss the wallet message and check the current payment status. No second payment is available; leave this page open and check status again when the RPC responds.'
          : paymentReconciliationWatchers.has(paymentAttemptKey(selected.merchant, selected.invoiceId))
            ? 'Your wallet error or nonce message does not prove payment failed. Dismiss the wallet message and check the current payment status. Leave this page open; Termul is checking the contract and matching payment events automatically, with payment locked.'
            : 'Your wallet error or nonce message does not prove payment failed. Dismiss the wallet message and check the current payment status. The invoice still reads Open, so payment remains locked while Termul checks again.';
      resultPanel.append(stateMessage);
      if (paymentReconciliation?.status === 'pending' && paymentReconciliation.paymentTxHash) {
        const pendingLink = document.createElement('a');
        pendingLink.href = `${EXPLORER}/tx/${paymentReconciliation.paymentTxHash}`;
        pendingLink.target = '_blank';
        pendingLink.rel = 'noreferrer';
        pendingLink.className = 'mono';
        pendingLink.style.overflowWrap = 'anywhere';
        pendingLink.textContent = paymentReconciliation.paymentTxHash;
        resultPanel.append(pendingLink);
      } else if (paymentAttempt.transactionHash) {
        const unverifiedHash = document.createElement('p');
        unverifiedHash.className = 'hint mono';
        unverifiedHash.style.overflowWrap = 'anywhere';
        unverifiedHash.textContent = `Wallet-reported transaction hash (not yet verified): ${paymentAttempt.transactionHash}`;
        resultPanel.append(unverifiedHash);
      }
      const checkButton = document.createElement('button');
      checkButton.type = 'button';
      checkButton.className = 'btn btn-quiet btn-sm';
      checkButton.textContent = 'Check payment status';
      checkButton.style.marginLeft = '8px';
      checkButton.addEventListener('click', () => {
        paymentReconciliationWatchComplete.delete(paymentAttemptKey(selected.merchant, selected.invoiceId));
        void renderPayment();
      });
      resultPanel.append(checkButton);
    }
    if (paymentAttempt || (paymentReconciliation?.receiptStatus === 'success' && paymentReconciliation.paymentTxHash)) {
      const details = document.createElement('button');
      details.type = 'button';
      details.className = 'btn btn-quiet btn-sm transaction-details-button';
      details.textContent = 'View transaction status';
      details.addEventListener('click', () => {
        const feedback = transactionFeedback('Invoice payment', invoice.amount, selected.invoiceId, details,
          paymentAttemptKey(selected.merchant, selected.invoiceId));
        paymentFeedbackState(paymentReconciliation, feedback, { requirePayer: false });
      });
      resultPanel.append(details);
    }
    const resultAnchor = paymentButton || $('.fee-note');
    if (resultPanel.childNodes.length) resultAnchor?.after(resultPanel);
    if (paymentAttempt && !paymentReconciliationWatchComplete.has(paymentAttemptKey(selected.merchant, selected.invoiceId))) {
      startPaymentReconciliationWatch({
        merchant: selected.merchant,
        invoiceId: selected.invoiceId,
        amount: paymentAttempt.amount || invoice.amount,
        payer: paymentAttempt.payer || activeWalletAddress,
        initialResult: paymentReconciliation,
      });
    }
    if (paymentButton) {
      if (!activeWalletAddress) paymentButton.textContent = 'Connect wallet to pay';
      if (activeWalletAddress && !activeWalletProviderReady) {
        paymentButton.disabled = true;
        paymentButton.textContent = activeWalletProviderState === 'checking' ? 'Checking wallet…' : 'Wallet unavailable';
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = activeWalletProviderError || 'Checking your wallet account and Arc Mainnet network.';
        paymentButton.before(hint);
        if (activeWalletProviderState === 'unavailable') {
          const recovery = document.createElement('button');
          recovery.type = 'button';
          recovery.className = 'btn btn-quiet btn-sm';
          recovery.textContent = activeWalletSelection?.chainId !== CHAIN_ID ? 'Switch to Arc Mainnet' : 'Check wallet connection';
          recovery.addEventListener('click', () => void recoverWalletNetwork());
          paymentButton.after(recovery);
        }
      }
    }
    $('#payment-invoices')?.addEventListener('click', () => window.arusPayApi?.navigate('dashboard'));
    $('#copy-invoice-link')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        showToast('Payment link copied. It contains no client personal information.');
      } catch {
        showToast(`Copy this link: ${link}`);
      }
    });
    paymentButton?.addEventListener('click', () => {
      if (activeWalletAddress && (activeWalletProviderState !== 'connected' || !activeWalletProviderReady)) return;
      if (!activeWalletAddress) {
        window.termulWallet?.connect();
        return;
      }
      if (isCurrentRender()) void payInvoice(invoice.merchant, selected.invoiceId, invoice.amount);
    });
  } catch (error) {
    if (!isCurrentRender()) return;
    const paymentAttempt = getUncertainPaymentAttempt(selected.merchant, selected.invoiceId);
    if (paymentAttempt && !paymentReconciliationWatchComplete.has(paymentAttemptKey(selected.merchant, selected.invoiceId))) {
      startPaymentReconciliationWatch({
        merchant: selected.merchant,
        invoiceId: selected.invoiceId,
        amount: paymentAttempt.amount,
        payer: paymentAttempt.payer || activeWalletAddress,
        initialResult: { status: 'unavailable', ambiguous: true },
      });
    }
    renderPaymentUnavailable(error?.shortMessage || error?.message || `The invoice could not be read from ${networkName}.`, selected.merchant, selected.invoiceId);
  }
}

async function payInvoice(merchant, invoiceId, amount) {
  const button = $('#pay-onchain');
  const run = () => runPaymentSubmissionIfIdle(async () => {
    if (getUncertainPaymentAttempt(merchant, invoiceId)) {
      showToast('A previous payment result is still uncertain. Dismiss the wallet message and check the current payment status. Check status; no second transaction was submitted.');
      await renderPayment();
      return;
    }
    if (button) button.disabled = true;
    let submission;
    let feedback;
    try {
      const wallet = await getWallet();
      const { account } = wallet;
      submission = { ownerAddress: account.toLowerCase(), started: false, attemptId: null };
      const current = await getOnchainInvoice(merchant, invoiceId);
      if (current.status !== STATUS.open) throw new Error(`This invoice is ${statusText(current.status, current.expiresAt).toLowerCase()} and cannot be paid.`);
      if (current.expiresAt !== 0n && current.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('This invoice has expired.');
      if (current.amount !== BigInt(amount)) throw new Error('The displayed amount no longer matches the on-chain invoice. Review the updated invoice before paying.');
      feedback = transactionFeedback('Invoice payment', current.amount, invoiceId, button, paymentAttemptKey(merchant, invoiceId));
      await window.termulWallet.session.authenticate();
      await wallet.assertReadyToSign();
      const prior = await metadataApi.getPaymentAttempt(merchant, invoiceId);
      if (hydrateUncertainPaymentAttempt(merchant, invoiceId, prior?.attempt)) {
        feedback.update('pending', { message: 'Termul found a previous payment attempt and is checking its result.' });
        await renderPayment();
        return;
      }
      const fee = wallet.selection.type === 'circle' ? null : await estimateFee('payInvoice', [getAddress(merchant), invoiceId], account, current.amount);
      const attempt = await submitPaymentOnce({
        submit: () => sendInvoiceTransaction(wallet, 'payInvoice', [getAddress(merchant), invoiceId], current.amount, fee, {
          reserve: async () => {
            const { attemptId } = await metadataApi.reservePaymentAttempt(merchant, invoiceId);
            submission.attemptId = attemptId;
          },
          approve: () => feedback.update('approval', { message: `Review the invoice payment in your wallet. Estimated fee: ${formatUsdc(fee.fee)} USDC.` }),
          submitted: (hash) => {
            setUncertainPaymentAttempt(merchant, invoiceId, account, hash, current.amount, submission);
            submission.started = true;
            if (hash) feedback.update('submitted');
          },
        }),
        waitForReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash, timeout: 45000, pollingInterval: 1500 }),
        reconcile: ({ transactionHash, receiptHint, error }) => reconcileOnchainPayment({
          merchant,
          invoiceId,
          amount: current.amount,
          payer: account,
          transactionHash,
          receiptHint,
          error,
        }),
      });
      if (!sameWallet(wallet.selection, window.termulWallet?.getSelection())) return;
      if (!submission.started) {
        if (submission.attemptId) await metadataApi.clearPaymentAttempt(merchant, invoiceId, submission.attemptId).catch(() => {});
        throw attempt.error || new Error('No payment was sent.');
      }
      const outcome = attempt.result;
      if (outcome.status === 'open' && !outcome.ambiguous && !attempt.ambiguous && !isAmbiguousPaymentError(attempt.error)) {
        feedback.update(attempt.error?.code === 4001 ? 'rejected' : 'failed', { message: 'The contract still reports Open. No payment was confirmed.' });
      } else {
        paymentFeedbackState(outcome, feedback);
      }
      if (outcome.status === 'paid') {
        if (outcome.contractStatePending || (outcome.proofUnavailable && !outcome.paymentTxHash)) {
          setUncertainPaymentAttempt(merchant, invoiceId, account, outcome.paymentTxHash || attempt.transactionHash, amount);
        } else {
          clearUncertainPaymentAttempt(merchant, invoiceId, outcome);
        }
        updateDashboardPayment(merchant, invoiceId, outcome);
        await renderPayment();
        showToast(outcome.contractStatePending
          ? 'A matching InvoicePaid event and successful receipt confirm payment. The RPC contract-state read is catching up; no second payment is available.'
          : outcome.paymentTxHash
          ? `Paid on the invoice contract. Verified transaction: ${outcome.paymentTxHash}`
          : 'The invoice contract confirms Paid, but the RPC has not returned a verifiable transaction hash. Check status again.');
      } else if (outcome.status === 'reverted') {
        clearUncertainPaymentAttempt(merchant, invoiceId, outcome);
        await renderPayment();
        showToast('The transaction reverted and the contract still reports Open. No replacement was sent; you can decide whether to start a new payment.');
      } else if (outcome.status === 'pending') {
        setUncertainPaymentAttempt(merchant, invoiceId, account, outcome.paymentTxHash || attempt.transactionHash, amount);
        await renderPayment();
        showToast('A matching payment transaction is pending. No second transaction was sent; wait for its receipt or check status again.');
      } else if (outcome.status === 'open' && !outcome.ambiguous && !attempt.ambiguous
        && !isAmbiguousPaymentError(attempt.error)) {
        clearUncertainPaymentAttempt(merchant, invoiceId);
        await renderPayment();
        const reason = attempt.error?.shortMessage || attempt.error?.message;
        showToast(reason
          ? `The contract still reports Open. This attempt did not confirm a payment: ${reason}`
          : 'The contract still reports Open. No payment was confirmed.');
      } else if (outcome.status === 'not-open') {
        clearUncertainPaymentAttempt(merchant, invoiceId);
        await renderPayment();
        showToast(`The contract reports ${statusText(outcome.invoice.status, outcome.invoice.expiresAt)}. No second payment was submitted.`);
      } else {
        const uncertain = Boolean(attempt.transactionHash || attempt.ambiguous || isAmbiguousPaymentError(attempt.error)
          || ['unavailable', 'inconsistent', 'unmatched'].includes(outcome.status));
        if (uncertain) setUncertainPaymentAttempt(merchant, invoiceId, account, outcome.paymentTxHash || attempt.transactionHash, amount);
        await renderPayment();
        const ambiguousWalletResult = attempt.ambiguous || isAmbiguousPaymentError(attempt.error);
        showToast(outcome.status === 'unavailable'
          ? ambiguousWalletResult
            ? 'The wallet returned an ambiguous wallet or nonce message; it does not prove payment failed. Termul is checking the contract and payment events. No second payment was submitted.'
            : 'The contract status could not be verified. No second payment was submitted; check status again when the RPC responds.'
          : ambiguousWalletResult
            ? 'The wallet returned an ambiguous wallet or nonce message; it does not prove payment failed. Termul is checking the contract and payment events. No second payment was submitted.'
            : 'The result is not yet conclusive. No second payment was submitted; check wallet activity and contract status before deciding what to do.');
      }
    } catch (error) {
      feedback?.update(submission?.started ? 'pending' : error?.code === 4001 ? 'rejected' : 'failed', {
        title: isCircleInvoiceFeeReviewError(error) ? 'Review a new network fee' : invoiceReadIssue(error),
        message: error?.shortMessage || error?.message,
      });
      showToast(error?.shortMessage || error?.message || 'Could not confirm this payment. Check the current invoice status.');
      await renderPayment();
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  });
  const locks = window.navigator.locks;
  if (locks) {
    return locks.request('termul.pay:' + paymentAttemptKey(merchant, invoiceId), { ifAvailable: true }, (lock) => {
      if (lock) return run();
      showToast('A payment for this invoice is already open in another tab.');
    });
  }
  return run();
}

function openSharedInvoice(merchant, invoiceId) {
  try {
    validatePaymentLinkNetwork(new URL(window.location.href).searchParams, arcNetwork);
    const params = new URL(window.location.href).searchParams;
    if (params.getAll('merchant').length !== 1 || params.getAll('invoiceId').length !== 1) {
      throw new Error('This payment link contains duplicate invoice parameters.');
    }
    const safeMerchant = getAddress(merchant);
    if (!/^0x[0-9a-fA-F]{64}$/.test(invoiceId)) throw new Error('The payment link has an invalid invoice ID.');
    const id = `INV-${invoiceId.slice(2, 10).toUpperCase()}`;
    window.arusPayApi?.openInvoice({
      id,
      invoiceId,
      merchant: safeMerchant,
    });
  } catch (error) {
    sharedLinkError = error?.message || `This payment link could not be read from ${networkName}.`;
    window.arusPayApi?.navigate('payment');
    renderPaymentUnavailable(sharedLinkError, merchant, invoiceId);
  }
}

window.arusPayUpdatePayment = renderPayment;
window.arusPayCreateInvoice = createOnchainInvoice;
let activeWalletAddress = null;
let activeWalletSelection = null;
let activeWalletProviderReady = false;
let activeWalletProviderState = 'disconnected';
let activeWalletProviderError = '';
let walletProviderProbeRequest = 0;
let paymentRenderRequest = 0;
let dashboardSyncRequest = 0;

function setWalletBalance(value, message, error = '', exact = '') {
  const balance = $('#wallet-balance');
  const status = $('#wallet-balance-state');
  if (balance) { balance.textContent = value; balance.title = exact; }
  if (status) {
    status.textContent = message;
    status.title = error;
  }
}

function setInvoiceSyncStatus(message, error = '') {
  const status = $('#invoice-sync-status');
  if (!status) return;
  status.textContent = message;
  status.title = error;
}

async function checkActiveWalletProvider(selection = activeWalletSelection) {
  const request = ++walletProviderProbeRequest;
  activeWalletProviderReady = false;
  activeWalletProviderState = selection ? 'checking' : 'disconnected';
  activeWalletProviderError = '';
  try {
    if (selection) {
      if (selection.chainId !== CHAIN_ID) throw new Error('Switch your wallet to Arc Mainnet.');
      if (selection.type === 'circle') window.termulWallet.assertSelection(selection);
      else await assertWalletProvider(await window.termulWallet.getProvider(selection), selection.address);
      if (request !== walletProviderProbeRequest) return;
      activeWalletProviderReady = true;
      activeWalletProviderState = 'connected';
    }
  } catch (error) {
    if (request !== walletProviderProbeRequest) return;
    activeWalletProviderState = 'unavailable';
    activeWalletProviderError = error?.message || 'The connected wallet is unavailable.';
  }
  if (!$('#payment').classList.contains('hidden')) void renderPayment();
}

async function recoverWalletNetwork() {
  try {
    if (activeWalletSelection?.chainId !== CHAIN_ID) await window.termulWallet?.switchNetwork();
    await checkActiveWalletProvider();
  } catch (error) {
    showToast(error?.message || 'The wallet could not switch networks.');
  }
}

function refreshArcDashboard(address = activeWalletAddress) {
  if (!address || !window.termulWallet?.session.isAuthenticated() || activeWalletSelection?.chainId !== CHAIN_ID) {
    dashboardSync = null;
    return readArcDashboard(address);
  }
  if (dashboardSync?.wallet === activeWalletSelection) return dashboardSync.promise;
  const request = { wallet: activeWalletSelection, promise: readArcDashboard(address) };
  dashboardSync = request;
  const clear = () => { if (dashboardSync === request) dashboardSync = null; };
  void request.promise.then(clear, clear);
  return request.promise;
}

async function readArcDashboard(address) {
  clearTimeout(historyTimer);
  if (!address || !window.termulWallet?.session.isAuthenticated() || activeWalletSelection?.chainId !== CHAIN_ID) {
    dashboardSyncRequest++;
    setWalletBalance('—', 'Verify your wallet to read its balance.');
    setInvoiceSyncStatus('Verify your wallet to sync Arc invoices.');
    const button = $('#refresh-chain-sync');
    if (button) button.disabled = false;
    return;
  }
  const safeAddress = getAddress(address);
  activeWalletAddress = safeAddress;
  const request = ++dashboardSyncRequest;
  const active = () => request === dashboardSyncRequest && window.termulWallet?.session.isAuthenticated();
  const localIndex = import.meta.env.TERMUL_LOCAL_CIRCLE;
  const readHistory = !localIndex || !$('#dashboard-view').classList.contains('hidden');
  const refreshButton = $('#refresh-chain-sync');
  if (refreshButton) refreshButton.disabled = true;
  setWalletBalance('—', `Reading ${networkName}…`);
  if (readHistory && (!localIndex || !window.arusPayApi?.getInvoices().length)) {
    setInvoiceSyncStatus(`Syncing invoice events from ${networkName}…`);
    window.arusPayApi?.setInvoiceSyncState('loading');
  }

  const verifiedChain = Promise.resolve().then(async () => {
    if (arcNetwork.error) throw new Error(arcNetwork.error);
    if (await readArc(() => publicClient.getChainId(), { active }) !== CHAIN_ID) throw new Error('The RPC endpoint returned an unexpected chain ID.');
  });
  const [balanceResult, invoicesResult] = await Promise.allSettled([
    verifiedChain.then(() => readArc(() => publicClient.getBalance({ address: safeAddress }), { active })),
    localIndex ? (readHistory ? syncLocalHistory(safeAddress, active) : null) : verifiedChain.then(() => syncMerchantInvoices(safeAddress, active)),
  ]);
  if (!active()) return;

  if (balanceResult.status === 'fulfilled') {
    const exact = formatUsdc(balanceResult.value);
    const [whole, fraction] = exact.split('.');
    const compact = fraction.slice(0, 6).replace(/0+$/, '').padEnd(2, '0');
    setWalletBalance(balanceResult.value > 0n && balanceResult.value < 1_000_000_000_000n ? '<0.000001' : whole + '.' + compact,
      `Native USDC balance · ${networkName}`, '', exact + ' USDC');
  } else {
    const message = balanceResult.reason?.shortMessage || balanceResult.reason?.message || `${networkName} balance could not be read.`;
    setWalletBalance('—', 'Balance unavailable · refresh to retry', message);
  }

  if (invoicesResult.status === 'fulfilled' && !import.meta.env.TERMUL_LOCAL_CIRCLE) {
    const { invoices: syncedInvoices, missingMetadata } = invoicesResult.value;
    window.arusPayApi?.replaceInvoices(syncedInvoices);
    const syncMessage = syncedInvoices.length
      ? `${syncedInvoices.length} invoice${syncedInvoices.length === 1 ? '' : 's'} synced from ${networkName}.`
      : `No invoice events found for this wallet on ${networkName}.`;
    setInvoiceSyncStatus(missingMetadata
      ? `${syncMessage} Offchain details are unavailable. Showing verified Arc records.`
      : syncMessage);
  } else if (invoicesResult.status === 'rejected') {
    const error = invoicesResult.reason;
    const message = error?.code === 'ARC_DEPLOYMENT_RPC' ? error.message : arcReadFailure(error)
      ? describeArcReadFailure(error) : error?.shortMessage || error?.message || 'Arc invoice data could not be read.';
    setInvoiceSyncStatus(`${message} Use Refresh to resume invoice sync.`, message);
    window.arusPayApi?.setInvoiceSyncState(import.meta.env.TERMUL_LOCAL_CIRCLE && window.arusPayApi.getInvoices().length ? 'partial' : 'error');
    if (import.meta.env.TERMUL_LOCAL_CIRCLE) scheduleLocalHistory(safeAddress, active);
  }

  if (refreshButton) refreshButton.disabled = false;
}

window.arusPayRefreshSync = () => refreshArcDashboard();
window.arusPayAveragePaymentTime = averagePaymentTime;
if (window.arusPayApi) window.arusPayApi.clearPaymentAttemptCache = clearLocalPaymentAttemptCache;
$('#refresh-chain-sync')?.addEventListener('click', () => {
  if (activeWalletAddress) void refreshArcDashboard(activeWalletAddress);
});

window.termulInvoiceWalletChanged = (selection) => {
  if (!sameWallet(activeWalletSelection, selection)) { transactionDialog.clear(); merchantScan = null; dashboardSync = null; }
  activeWalletSelection = selection;
  activeWalletAddress = selection ? getAddress(selection.address) : null;
  dashboardSyncRequest++;
  void checkActiveWalletProvider(selection);
  if (activeWalletAddress) {
    void refreshArcDashboard();
  } else {
    window.arusPayApi?.setInvoiceSyncState('disconnected');
    setWalletBalance('—', 'Connect a wallet to read its balance.');
    setInvoiceSyncStatus('Connect a wallet to sync Arc invoices.');
  }
};
window.termulRefreshPayment = () => {
  if (!$('#payment').classList.contains('hidden')) void renderPayment();
};

window.arusPayConfig = Object.freeze({
  chainId: CHAIN_ID,
  networkName,
  rpcUrl: ARC_RPC,
  contractAddress: CONTRACT_ADDRESS,
  explorerUrl: EXPLORER,
});
$$('[data-arc-name]').forEach((label) => { label.textContent = networkName; });
const environment = $('[data-arc-environment]');
if (environment) environment.textContent = arcNetwork.error || networkName;
if (arcNetwork.error) {
  const submit = $('#invoice-form [type="submit"]');
  if (submit) {
    submit.disabled = true;
    const message = document.createElement('p');
    message.className = 'hint';
    message.setAttribute('role', 'status');
    message.textContent = arcNetwork.error;
    submit.after(message);
  }
}

const url = new URL(window.location.href);
const linkedMerchant = url.searchParams.get('merchant');
const linkedInvoice = url.searchParams.get('invoiceId');
if (linkedMerchant && linkedInvoice) openSharedInvoice(linkedMerchant, linkedInvoice);

window.arusPayCircleAttemptChanged = async attempt => {
  const wallet = window.termulWallet?.getSelection();
  if (wallet?.type !== 'circle' || wallet.address.toLowerCase() !== attempt.walletAddress?.toLowerCase()) return;
  if (attempt.kind === 'payment') {
    if (['rejected', 'expired'].includes(attempt.status) && attempt.merchant && attempt.invoiceId) {
      transactionDialog.update(paymentAttemptKey(attempt.merchant, attempt.invoiceId), 'rejected', {
        message: attempt.status === 'expired' ? 'The Circle approval expired.' : 'The Circle approval was declined.',
      });
      clearUncertainPaymentAttempt(attempt.merchant, attempt.invoiceId);
    }
    await renderPayment(attempt);
  } else {
    creationRequiresReview = false;
    window.arusPayRefreshSync?.();
  }
};
