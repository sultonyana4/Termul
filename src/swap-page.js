import { createPublicClient, formatUnits, http } from 'viem';
import { arcChain, arcNetwork } from './arc-network.js';
import { sameWallet } from './wallet-provider.js';
import { setTokenIcon } from './display-assets.js';
import { transactionDialogFor, transactionExplorerUrl } from './transaction-dialog.js';
import {
  SWAP_TOKENS, assertFreshQuote, createQuoteRequest, fetchSwapQuote, isHash, parseSwapAmount, swapRate, tokenAmount, unsigned,
} from './swap-quote.js';
import { createSwapExecution, maxSwapAmount, readSwapBalances, reviewSwap, spendableAmount, swapLedger, verifySwapRecord } from './swap-execution.js';
import './swap.css';

const client = createPublicClient({ chain: arcChain, transport: http(arcNetwork.rpcUrl) });
const network = { name: arcNetwork.name, explorerUrl: arcNetwork.explorerUrl, explorerName: 'Arc Explorer' };
const ledger = swapLedger({
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
});
const wallet = window.termulWallet;
const execute = createSwapExecution({ client, wallet, ledger });
const transactions = transactionDialogFor(document.getElementById('transaction-dialog'));
const $ = selector => document.querySelector(selector);
const node = name => $('[data-swap="' + name + '"]');
const field = name => $('[data-review="' + name + '"]');
const input = $('#swap-input');
const submit = node('submit');
const review = $('#swap-review-dialog');
const check = $('#swap-check');
let from = SWAP_TOKENS.USDC;
let to = SWAP_TOKENS.EURC;
let quoteState = { status: 'idle' };
let balances = null;
let balanceError = false;
let reviewCheck;
let visible = false;
let busy = false;
let checking = false;
let pendingReview;
let refreshTimer;
let quoteExpiry;
let history = null;
let historyError = false;
let balanceRequest = 0;
let recoveryState;

const setText = (name, value) => { node(name).textContent = value; };
const formatGas = amount => formatUnits(amount, 18) + ' USDC';
const shortGas = amount => {
  const rounded = (amount + 500_000_000_000n) / 1_000_000_000_000n;
  if (amount && !rounded) return '< 0.000001 USDC';
  return (rounded * 1_000_000_000_000n === amount ? '' : '≈ ') + formatUnits(rounded, 6) + ' USDC';
};
const rateLabel = (from, to, amount, received) => `1 ${from.symbol} ≈ ${swapRate(amount, received)} ${to.symbol}`;
const approvalMessage = record => record.phase === 'approval' ? 'token approval' : 'swap';
const gasMessage = 'Keep some USDC in your wallet for network fees.';

function render() {
  const selection = wallet.getSelection();
  const amount = parseSwapAmount(input.value);
  const { quote, status, message } = quoteState;
  const underfunded = amount && balances && balances[from.symbol] < amount;
  const gasBudget = reviewCheck?.terms?.gasBudget;
  const gasShort = amount && balances && gasBudget
    && (balances.native < gasBudget || spendableAmount(balances, from, gasBudget) < amount);
  const pending = history?.state === 'pending';
  const wrongChain = selection && selection.chainId !== arcNetwork.id;
  setText('from', from.symbol);
  setText('to', to.symbol);
  setTokenIcon(node('from-icon'), from.symbol);
  setTokenIcon(node('to-icon'), to.symbol);
  setText('input-balance', balances ? formatUnits(balances[from.symbol], 6) : '—');
  setText('output-balance', balances ? formatUnits(balances[to.symbol], 6) : '—');
  setText('output', quote ? formatUnits(quote.received, 6) : '—');
  setText('minimum', quote ? tokenAmount(quote.minimum, to) : '—');
  setText('rate', quote ? rateLabel(from, to, quote.amount, quote.received) : '—');
  setText('impact', quote?.priceImpact == null ? '—' : quote.priceImpact + '%');
  setText('route', quote?.route || '—');
  setText('network-fee', quote?.networkFee == null ? '—' : shortGas(quote.networkFee));
  setText('network-fee-exact', quote?.networkFee == null ? '' : formatGas(quote.networkFee));
  node('fee-details').classList.toggle('hidden', quote?.networkFee == null);
  setText('provider-fee', quote ? tokenAmount(quote.providerFee, from) : '—');
  setText('status', arcNetwork.error || (historyError ? 'Browser storage is unavailable or the saved swap reference could not be read.'
    : busy ? 'Swap in progress.' : underfunded ? `Not enough ${from.symbol} in your wallet.` : gasShort ? gasMessage
    : wrongChain ? 'Switch your wallet to Arc Mainnet to swap.' : balanceError ? 'Could not load balances. Try again in a moment.'
    : reviewCheck?.error || message || (status === 'loading' ? 'Getting a quote…'
    : quote && selection && (!balances || !reviewCheck?.terms) ? 'Checking your balance and fees…' : quote ? 'Quote ready.'
    : input.value ? 'Enter a positive amount with up to six decimal places.' : 'Enter an amount to see a quote.')));
  node('status').dataset.tone = underfunded || gasShort || balanceError || reviewCheck?.error || historyError || status === 'error' ? 'warning' : 'normal';
  submit.textContent = busy ? 'Processing…' : pending ? 'Previous request unresolved' : !selection ? 'Connect wallet'
    : wrongChain ? 'Switch to Arc Mainnet' : 'Review swap';
  submit.disabled = Boolean(arcNetwork.error || historyError || busy || pending
    || (selection && !wrongChain && (!quote || !balances || underfunded || gasShort || !reviewCheck?.terms)));
  input.disabled = $('#swap-direction').disabled = busy;
  $('#swap-max').disabled = busy || !balances;
  setHistory();
}

function updateQuote() {
  clearTimeout(quoteExpiry);
  const amount = parseSwapAmount(input.value);
  const selection = wallet.getSelection();
  requestQuote(!arcNetwork.error && visible && !busy && amount ? {
    from, to, amount, account: selection?.chainId === arcNetwork.id ? selection.address : null,
  } : null);
}

const requestQuote = createQuoteRequest(fetchSwapQuote, state => {
  quoteState = state;
  reviewCheck = null;
  const selection = wallet.getSelection();
  if (state.quote && selection?.chainId === arcNetwork.id && state.quote.account.toLowerCase() === selection.address.toLowerCase()) {
    void checkReview(state.quote, selection);
  }
  if (state.quote) quoteExpiry = setTimeout(() => {
    if (review.open) {
      pendingReview = null;
      review.close();
    }
    updateQuote();
  }, Math.max(0, state.quote.expiresAt - Date.now()));
  render();
});

async function checkReview(quote, selection) {
  const check = reviewCheck = {};
  try {
    check.terms = await reviewSwap(client, quote);
  } catch (error) {
    check.error = error.message === 'Keep enough native USDC to pay the network fee.' ? gasMessage
      : error.shortMessage ? 'Could not check balance and fees. Wait for a fresh quote.' : error.message;
  }
  if (quoteState.quote === quote && sameWallet(selection, wallet.getSelection()) && reviewCheck === check) render();
}

function setHistory() {
  $('#swap-history').classList.toggle('hidden', !history);
  if (!history) return;
  const isPending = history.state === 'pending';
  const hash = history.phase === 'swap' ? history.hash : null;
  for (const [name, reference] of [['approval-link', history.approvalHash], ['swap-link', hash]]) {
    const href = transactionExplorerUrl(network, reference);
    const link = node(name);
    if (href) link.href = href;
    else link.removeAttribute('href');
    link.hidden = !href;
  }
  node('recovery').hidden = !isPending || Boolean(history.hash);
  setText('history-status', isPending ? `Previous ${approvalMessage(history)} is pending verification.`
    : recoveryState === 'approved' ? 'Token approval confirmed. Review a fresh quote to continue.'
    : recoveryState === 'reverted' ? `Last ${approvalMessage(history)} reverted.`
    : history.phase === 'approval' ? 'Last request was a token approval.' : 'Last swap transaction.');
  check.hidden = !isPending && !history.hash;
  check.disabled = busy || checking;
}

async function refreshBalances() {
  const generation = ++balanceRequest;
  const selection = wallet.getSelection();
  if (!visible || selection?.chainId !== arcNetwork.id) return;
  try {
    const next = await readSwapBalances(client, selection.address);
    if (generation === balanceRequest && sameWallet(selection, wallet.getSelection())) {
      balances = next;
      balanceError = false;
      render();
    }
  } catch {
    if (generation === balanceRequest) {
      balances = null;
      balanceError = true;
      render();
    }
  }
}

function refreshHistory() {
  const selection = wallet.getSelection();
  recoveryState = null;
  history = null;
  historyError = false;
  try { if (selection) history = ledger.get(selection.address); }
  catch { historyError = true; }
  node('recovery-hash').value = '';
  render();
}

function swapDialog(record) {
  const source = SWAP_TOKENS[record.from];
  return transactions.begin({
    network, type: 'USDC ↔ EURC swap', amount: tokenAmount(unsigned(record.amount), source),
    detail: 'LI.FI · Fly', origin: submit, successTitle: 'Swap Successful!', assets: [record.from, record.to],
  });
}

function showOutcome(dialog, outcome, record) {
  if (outcome.status === 'confirmed') {
    const source = SWAP_TOKENS[record.from];
    const destination = SWAP_TOKENS[record.to];
    dialog.update('confirmed', { verifiedHash: record.hash, settledAmount: tokenAmount(outcome.spent, source),
      received: tokenAmount(outcome.received, destination), rate: rateLabel(source, destination, outcome.spent, outcome.received),
      message: 'Your swap was confirmed on Arc.' });
  } else if (outcome.status === 'pending') {
    dialog.update('pending', { referenceHash: record.hash, message: record.hash
      ? `Your ${approvalMessage(record)} is still being checked. Check its status before trying again.`
      : `The wallet did not return a ${approvalMessage(record)} hash. Check wallet activity and enter the hash if available.` });
  } else if (outcome.status === 'rejected') {
    dialog.update('rejected', { message: `You declined the ${approvalMessage(record)} request in your wallet.` });
  } else {
    dialog.update('failed', { message: `The ${approvalMessage(record)} did not complete on Arc.` });
  }
}

check.addEventListener('click', async () => {
  if (!history || checking || busy) return;
  const selection = wallet.getSelection();
  const record = { ...history };
  const candidate = record.hash || node('recovery-hash').value.trim();
  if (!isHash(candidate)) return setText('history-status', 'Enter the transaction hash from your wallet activity.');
  if (!selection || selection.address.toLowerCase() !== record.account.toLowerCase()) return;
  checking = true;
  render();
  try {
    record.hash = candidate;
    const outcome = await verifySwapRecord(client, record);
    if (!sameWallet(selection, wallet.getSelection())) return;
    if (outcome.status !== 'pending') {
      record.state = 'done';
      if (record.phase === 'approval') record.approvalHash = record.hash;
      ledger.put(record);
      history = record;
      recoveryState = outcome.status;
    }
    if (outcome.status === 'approved') return;
    // A manually pasted hash is never presented as a submitted reference until verified.
    showOutcome(swapDialog(record), outcome, outcome.status === 'pending' ? history : record);
  } catch {
    setText('status', 'Could not recover the swap request.');
  } finally {
    checking = false;
    render();
  }
});

$('#swap-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || pendingReview || historyError || history?.state === 'pending' || arcNetwork.error) return;
  const selection = wallet.getSelection();
  if (!selection) return wallet.connect();
  try {
    if (selection.chainId !== arcNetwork.id) return await wallet.switchNetwork();
    if (submit.disabled) return;
    const quote = quoteState.quote;
    if (!quote || quote.account.toLowerCase() !== selection.address.toLowerCase()) throw new Error('Wait for a quote for this wallet.');
    const prepared = await reviewSwap(client, quote);
    if (!visible || pendingReview || !sameWallet(selection, wallet.getSelection()) || quote !== quoteState.quote) return;
    pendingReview = { quote, terms: prepared, selection };
    field('send').textContent = tokenAmount(quote.amount, from);
    field('receive').textContent = tokenAmount(quote.received, to);
    field('minimum').textContent = tokenAmount(quote.minimum, to);
    field('route').textContent = quote.route;
    field('provider-fee').textContent = tokenAmount(quote.providerFee, from) + ' (included)';
    field('gas').textContent = shortGas(prepared.gasBudget);
    field('gas-exact').textContent = formatGas(prepared.gasBudget);
    setTokenIcon(field('send-icon'), from.symbol);
    setTokenIcon(field('receive-icon'), to.symbol);
    field('account').textContent = selection.address;
    field('approval').textContent = prepared.needsApproval
      ? 'Your wallet will ask you to approve this amount, then confirm the swap.' : 'Confirm the swap in your wallet.';
    review.querySelector('.dialog-content').scrollTop = 0;
    review.showModal();
  } catch (error) {
    setText('status', error?.shortMessage || error.message || 'Could not review this swap.');
  }
});
review.addEventListener('close', () => { if (!review.open) pendingReview = null; });

$('#swap-confirm').addEventListener('click', async () => {
  const request = pendingReview;
  if (!request || busy || request.quote !== quoteState.quote) return;
  pendingReview = null;
  review.close();
  busy = true;
  const { quote, terms, selection } = request;
  const feedback = swapDialog({ from: quote.from.symbol, to: quote.to.symbol, amount: quote.amount.toString() });
  updateQuote();
  try {
    assertFreshQuote(quote);
    const start = () => execute(quote, terms, selection, ({ stage, record }) => {
      if (!sameWallet(selection, wallet.getSelection())) return;
      if (stage === 'wallet') feedback.update('approval', {
        message: record.phase === 'approval' ? `Approve exactly ${tokenAmount(quote.amount, quote.from)} for the LI.FI router.`
          : 'Review the swap amount, recipient, and network fee in your wallet.',
      });
      if (stage === 'submitted') feedback.update('submitted', {
        referenceHash: record.hash, message: `Checking the ${approvalMessage(record)} receipt on Arc Mainnet.`,
      });
      if (stage === 'approved') feedback.update('preparing', { message: 'Token approval confirmed. Checking the swap before asking you to sign.' });
    });
    const outcome = navigator.locks
      ? await navigator.locks.request(`termul.swap:${quote.account.toLowerCase()}`, { ifAvailable: true }, lock => {
        if (!lock) throw new Error('A swap for this wallet is already open in another tab.');
        return start();
      })
      : await start();
    if (!sameWallet(selection, wallet.getSelection())) return;
    showOutcome(feedback, outcome, outcome.record);
    if (outcome.status === 'confirmed') input.value = '';
  } catch (error) {
    feedback.update(error?.code === 4001 ? 'rejected' : 'failed', { message: error?.shortMessage || error.message || 'The swap could not be started.' });
  } finally {
    busy = false;
    refreshHistory();
    updateQuote();
    void refreshBalances();
  }
});

input.addEventListener('input', updateQuote);
$('#swap-direction').addEventListener('click', () => {
  [from, to] = [to, from];
  updateQuote();
});
$('#swap-max').addEventListener('click', async () => {
  const selection = wallet.getSelection();
  const token = from;
  const originalInput = input.value;
  if (!selection || busy) return;
  try {
    const amount = await maxSwapAmount(client, selection.address, token);
    if (!busy && token === from && originalInput === input.value && sameWallet(selection, wallet.getSelection())) {
      input.value = formatUnits(amount, token.decimals);
      updateQuote();
    }
  } catch {
    setText('status', 'Could not calculate Max. Check your Arc balance.');
  }
});

window.termulSwapWalletChanged = () => {
  pendingReview = null;
  if (review.open) review.close();
  balances = null;
  balanceError = false;
  refreshHistory();
  updateQuote();
  void refreshBalances();
};

window.termulSwapViewChanged = next => {
  if (visible === next) return;
  visible = next;
  clearInterval(refreshTimer);
  if (visible) {
    refreshHistory();
    refreshTimer = setInterval(refreshBalances, 20_000);
    void refreshBalances();
  }
  updateQuote();
};
window.termulSwapViewChanged(!$('#swap-view').classList.contains('hidden'));
