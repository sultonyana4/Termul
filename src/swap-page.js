import { assertCurrentFeePolicy, loadFeePolicy } from './fee-policy.js';
import { TERMUL_FEE_LABEL } from './swap-fee.js';
import { createPublicClient, formatUnits, http } from 'viem';
import { arcChain, arcNetwork } from './arc-network.js';
import { sameWallet } from './wallet-provider.js';
import { createTokenIcon, setTokenIcon } from './display-assets.js';
import { arcTokenCatalog } from './circle-arc-tokens.js';
import { createCircleArcTokenPicker } from './circle-arc-token-picker.js';
import { circleCompactAmount } from './circle-amount.js';
import { circleSwapStep } from './circle-swap-review.js';
import { transactionDialogFor, transactionExplorerUrl } from './transaction-dialog.js';
import {
  SWAP_TOKENS, ARC_ANY_SWAP_TOKENS, assertFreshQuote, createQuoteRequest, fetchSwapQuote, isHash, parseSwapAmount, swapRate, tokenAmount, unsigned,
} from './swap-quote.js';
import { createSwapExecution, maxSwapAmount, readSwapBalances, reviewSwap, spendableAmount, swapLedger, swapTokenBalance, verifySwapRecord } from './swap-execution.js';
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
const swapLayout = $('#stablecoin-panel .swap-layout');
const arcFrom = $('#circle-arc-from');
const arcTo = $('#circle-arc-to');
const drafts = [{}, { from: ARC_ANY_SWAP_TOKENS.USDC, to: ARC_ANY_SWAP_TOKENS.cirBTC, amount: '' }];
let anyToken = false;
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
let circleAttempt;
let circleStatus = '';
let circleReview;
let circleFeedback;
const circleSteps = new Map();
const progress = $('#circle-swap-progress');
let circlePoll;
let circleTimer;
let circleStatusLoaded = false;
const circleTerminal = attempt => ['verified', 'reverted', 'rejected', 'expired'].includes(attempt?.status);
const recordAssets = record => record.assets ?? [ARC_ANY_SWAP_TOKENS[record.from], ARC_ANY_SWAP_TOKENS[record.to]];
const samePair = record => {
  const [source, destination] = recordAssets(record);
  return source?.address.toLowerCase() === from.address.toLowerCase() &&
    destination?.address.toLowerCase() === to.address.toLowerCase();
};
const picker = createCircleArcTokenPicker({ dialog: $('#circle-arc-token-picker'), client, selection: () => wallet.getSelection(),
  onSelect(side, token) {
    if (!anyToken || busy) return;
    if (side === 'send') {
      from = token;
      input.maxLength = 73 + from.decimals;
      input.value = '';
    } else to = token;
    balances = null;
    balanceError = false;
    updateQuote();
    void refreshBalances();
  } });

function drawTokenChoice(button, token, side) {
  const identity = [token.address, token.symbol, token.name, token.logoURI].join('|');
  if (button.dataset.token !== identity) {
    button.dataset.token = identity;
    button.replaceChildren(createTokenIcon(document, token), token.symbol);
    button.title = `${token.name ?? token.symbol} · ${token.address}`;
    button.setAttribute('aria-label', `Choose ${side} token, ${token.symbol}`);
  }
}

async function hydrateArcTokens() {
  try {
    const tokens = await arcTokenCatalog.load();
    if (!anyToken) return;
    const hydrate = selected => tokens.find(token => token.address.toLowerCase() === selected.address.toLowerCase()) ?? selected;
    const nextFrom = hydrate(from), nextTo = hydrate(to);
    if (nextFrom !== from || nextTo !== to) {
      from = nextFrom;
      to = nextTo;
      input.maxLength = 73 + from.decimals;
      balances = null;
      render();
      void refreshBalances();
    }
  } catch { /* The picker also supports independent address lookup. */ }
}

const setText = (name, value) => { node(name).textContent = value; };
const formatGas = amount => formatUnits(amount, 18) + ' USDC';
const shortGas = amount => {
  const rounded = (amount + 500_000_000_000n) / 1_000_000_000_000n;
  if (amount && !rounded) return '< 0.000001 USDC';
  return (rounded * 1_000_000_000_000n === amount ? '' : '≈ ') + formatUnits(rounded, 6) + ' USDC';
};
const rateLabel = (from, to, amount, received) => `1 ${from.symbol} ≈ ${swapRate(amount, received, from.decimals, to.decimals)} ${to.symbol}`;
const approvalMessage = record => record.phase === 'approval' ? 'token approval' : 'swap';
const gasMessage = 'Keep some USDC in your wallet for network fees.';

function describeCircleSwap(attempt) {
  if (!attempt) return '';
  if (attempt.status === 'verified') {
    if (attempt.phase === 'swap') return 'Swap settlement verified on Arc.';
    if (attempt.allowanceValue === '0') return `${attempt.from} allowance reset to zero on Arc.`;
    return 'Token approval verified on Arc.';
  }
  if (attempt.status === 'rejected') return 'You declined the Circle confirmation.';
  if (attempt.status === 'expired') return 'The Circle confirmation expired.';
  if (attempt.status === 'reverted') return 'The transaction reverted on Arc.';
  return 'Waiting for verified Arc settlement. Check this request before starting another.';
}

function render() {
  const selection = wallet.getSelection();
  const amount = parseSwapAmount(input.value, from.decimals);
  const { quote, status, message } = quoteState;
  const inputBalance = swapTokenBalance(balances, from);
  const outputBalance = swapTokenBalance(balances, to);
  const underfunded = amount && inputBalance !== undefined && inputBalance < amount;
  const gasBudget = reviewCheck?.terms?.gasBudget;
  const gasShort = amount && balances && gasBudget
    && (balances.native < gasBudget || spendableAmount(balances, from, gasBudget) < amount);
  const pending = history?.state === 'pending';
  const wrongChain = selection && selection.chainId !== arcNetwork.id;
  setText('from', from.symbol);
  setText('to', to.symbol);
  setTokenIcon(node('from-icon'), from.symbol);
  setTokenIcon(node('to-icon'), to.symbol);
  for (const [field, value, token] of [['input-balance', inputBalance, from], ['output-balance', outputBalance, to]]) {
    const exact = value === undefined ? '' : formatUnits(value, token.decimals);
    if (selection?.type === 'circle' && exact) node(field).title = exact;
    else node(field).removeAttribute('title');
    setText(field, exact ? selection?.type === 'circle' ? circleCompactAmount(exact) : exact : '—');
  }
  setText('output', quote ? formatUnits(quote.received, 6) : '—');
  setText('minimum', quote ? tokenAmount(quote.minimum, to) : '—');
  setText('rate', quote ? rateLabel(from, to, quote.amount, quote.received) : '—');
  setText('impact', quote?.priceImpact == null ? '—' : quote.priceImpact + '%');
  setText('route', quote?.route || '—');
  setText('network-fee', quote?.networkFee == null ? '—' : shortGas(quote.networkFee));
  setText('network-fee-exact', quote?.networkFee == null ? '' : formatGas(quote.networkFee));
  node('fee-details').classList.toggle('hidden', quote?.networkFee == null);
  setText('termul-fee-label', quote?.feePolicy.bps ? TERMUL_FEE_LABEL : 'Termul fee');
  setText('termul-fee', quote ? (quote.feePolicy.bps ? tokenAmount(quote.integratorFee, from) + ' (included)' : '0%') : '—');
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
  arcFrom.disabled = arcTo.disabled = busy;
  if (anyToken) {
    drawTokenChoice(arcFrom, from, 'send');
    drawTokenChoice(arcTo, to, 'receive');
    const gasBalance = $('#circle-arc-gas-balance');
    gasBalance.title = balances ? formatUnits(balances.native, 18) : '';
    gasBalance.textContent = balances ? `Network fee balance ${circleCompactAmount(gasBalance.title)} USDC` : 'Network fee balance unavailable';
  }
  progress.hidden = selection?.type !== 'circle' || !circleSteps.size;
  if (!progress.hidden) progress.replaceChildren(...Array.from(circleSteps, ([step, state]) => {
    const item = document.createElement('li');
    item.textContent = step + ' · ' + state;
    if (state === 'Review' || state === 'Confirm and verify') item.setAttribute('aria-current', 'step');
    return item;
  }));
  $('#swap-max').disabled = busy || !balances;
  if (selection?.type === 'circle') {
    const enabled = anyToken ? selection.capabilities.arcAnyToken : selection.capabilities.arcSwap;
    const pending = circleAttempt && !circleTerminal(circleAttempt);
    if (pending) {
      input.disabled = arcFrom.disabled = arcTo.disabled = true;
      $('#swap-direction').disabled = $('#swap-max').disabled = true;
    }
    const current = circleReview?.reviewExpiresAt > Date.now() && Boolean(circleReview.anyToken) === anyToken &&
      samePair(circleReview) && amount === BigInt(circleReview.amount)
      ? circleReview : null;
    if (current) {
      setText('output', circleCompactAmount(formatUnits(BigInt(current.received), to.decimals)));
      setText('minimum', circleCompactAmount(formatUnits(BigInt(current.minimum), to.decimals), 'down') + ' ' + to.symbol);
      setText('rate', rateLabel(from, to, BigInt(current.amount), BigInt(current.received)));
      setText('impact', current.priceImpact == null ? 'Unavailable' : (current.referenceImpact ? '≈ ' : '') + current.priceImpact + '%');
      setText('route', current.route);
      setText('network-fee', circleCompactAmount(current.networkFee, 'up') + ' USDC' +
        (current.phase === 'approval' ? ' for this allowance step' : ' for the swap'));
      setText('termul-fee-label', current.feeBps ? TERMUL_FEE_LABEL : 'Termul fee');
      setText('termul-fee', tokenAmount(BigInt(current.integratorFee), from) + (current.integratorFeeRounded ? ' (rounded down)' : ''));
      setText('provider-fee', tokenAmount(BigInt(current.providerFee), from));
    }
    setText('status', busy ? 'Checking this Circle request…' : circleStatus || (pending ? describeCircleSwap(circleAttempt)
      : !enabled ? 'Circle Arc stablecoin swaps are disabled.' : underfunded ? `Not enough ${from.symbol} in your wallet.`
      : balanceError ? 'Could not load balances. Try again in a moment.'
      : 'Enter an amount and review the Arc swap quote.'));
    submit.textContent = busy ? 'Processing…' : pending ? 'Check Circle swap status' : 'Review Circle swap';
    submit.disabled = Boolean(arcNetwork.error || busy || (!pending && (!enabled || !amount || underfunded)));
  }
  setHistory();
}

function updateQuote() {
  clearTimeout(quoteExpiry);
  circleReview = null;
  if (!circleAttempt || circleTerminal(circleAttempt)) circleStatus = '';
  const amount = parseSwapAmount(input.value, from.decimals);
  const selection = wallet.getSelection();
  requestQuote(!arcNetwork.error && visible && !busy && amount && selection?.type !== 'circle' ? {
    from, to, amount, account: selection?.chainId === arcNetwork.id ? selection.address : null,
  } : null);
}

const requestQuote = createQuoteRequest(async (input, signal) => {
  const policy = await loadFeePolicy();
  return fetchSwapQuote(input, signal, fetch, Date.now, policy);
}, state => {
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
  if (wallet.getSelection()?.type === 'circle') {
    const attempt = circleAttempt;
    $('#swap-history').classList.toggle('hidden', !attempt);
    setText('history-status', describeCircleSwap(attempt));
    for (const [name, phase] of [['approval-link', 'approval'], ['swap-link', 'swap']]) {
      const link = node(name);
      const href = circleTerminal(attempt) && attempt.phase === phase && transactionExplorerUrl(network, attempt.transactionHash);
      if (href) link.href = href;
      else link.removeAttribute('href');
      link.hidden = !href;
    }
    node('recovery').hidden = check.hidden = true;
    return;
  }
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
    const next = await readSwapBalances(client, selection.address, anyToken ? [from, to] : undefined);
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

function swapDialog(record, scope) {
  const [source, destination] = recordAssets(record);
  return transactions.begin({
    network, scope, type: record.anyToken ? `${record.from} → ${record.to} swap` : 'USDC ↔ EURC swap', amount: tokenAmount(unsigned(record.amount), source),
    detail: 'LI.FI · Fly', origin: submit, successTitle: 'Swap Successful!', assets: record.anyToken ? [source, destination] : [record.from, record.to],
  });
}

function showOutcome(dialog, outcome, record) {
  if (outcome.status === 'confirmed') {
    const [source, destination] = recordAssets(record);
    const amount = (value, token) => record.kind === 'arc-swap'
      ? circleCompactAmount(formatUnits(value, token.decimals)) + ' ' + token.symbol : tokenAmount(value, token);
    dialog.update('confirmed', { verifiedHash: record.hash, settledAmount: amount(outcome.spent, source),
      received: amount(outcome.received, destination), rate: rateLabel(source, destination, outcome.spent, outcome.received),
      message: 'Your swap was confirmed on Arc.' + (outcome.costUsdc ? ' Network fee ' + circleCompactAmount(outcome.costUsdc) + ' USDC.' : '') });
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

function applyCircleAttempt(attempt) {
  if (!attempt) return;
  const changed = circleAttempt?.attemptId !== attempt.attemptId || circleAttempt?.status !== attempt.status;
  circleAttempt = attempt;
  circleStatus = describeCircleSwap(attempt);
  const tracked = attempt.attemptId && attempt.attemptId === trackedCircleAttempt(wallet.getSelection());
  const applicable = Boolean(attempt.anyToken) === anyToken;
  if (tracked && applicable && (changed || !circleSteps.has(circleSwapStep(attempt)))) {
    circleSteps.set(circleSwapStep(attempt), attempt.status === 'verified' ? 'Verified on Arc'
      : circleTerminal(attempt) ? attempt.status : 'Confirm and verify');
  }
  if (!changed && !(tracked && applicable && circleTerminal(attempt))) return;
  if (circleTerminal(attempt)) picker.clearBalances();
  if (attempt.status === 'verified' && attempt.phase === 'swap') {
    if (tracked && visible && applicable) {
      const scope = {};
      const dialog = swapDialog(attempt, scope);
      circleFeedback = scope;
      showOutcome(dialog, { status: 'confirmed', spent: unsigned(attempt.spent), received: unsigned(attempt.received),
        costUsdc: attempt.costUsdc },
        { ...attempt, hash: attempt.transactionHash });
      trackCircleAttempt(wallet.getSelection());
      if (samePair(attempt) &&
        parseSwapAmount(input.value, from.decimals) === BigInt(attempt.amount)) {
        input.value = '';
      }
    }
    circleReview = null;
    void refreshBalances();
  } else if (attempt.status === 'verified') {
    circleReview = null;
    void refreshBalances();
  } else if (circleTerminal(attempt)) {
    if (tracked) trackCircleAttempt(wallet.getSelection());
    circleReview = null;
  }
}

let tracked = null;
const circleAttemptKey = selection => 'termul.circle.swap-continuation:' + selection.address.toLowerCase();
function trackedCircleAttempt(selection) {
  if (selection?.type !== 'circle') return null;
  const key = circleAttemptKey(selection);
  if (tracked?.key === key) return tracked.id;
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function trackCircleAttempt(selection, id = null) {
  if (selection?.type !== 'circle') return;
  const key = circleAttemptKey(selection);
  tracked = { key, id };
  try {
    if (id) sessionStorage.setItem(key, id);
    else sessionStorage.removeItem(key);
  } catch { /* Pending status still recovers from the server journal. */ }
}

function continueCircleApproval(selection, attempt) {
  return attempt?.phase === 'approval' && attempt.status === 'verified' && visible &&
    Boolean(attempt.anyToken) === anyToken && attempt.attemptId === trackedCircleAttempt(selection);
}

function circleIntent(source, destination, amount, dynamic) {
  return { from: dynamic ? source.address : source.symbol, to: dynamic ? destination.address : destination.symbol,
    amount: String(amount), ...(dynamic && { anyToken: true }) };
}

async function runCircleSwap(selection, { pending = false, resume } = {}) {
  const mode = anyToken;
  const active = () => sameWallet(selection, wallet.getSelection()) && visible && anyToken === mode;
  if (busy || !active()) return;
  circlePoll = null;
  busy = true;
  if (!pending && !resume) {
    circleSteps.clear();
    trackCircleAttempt(selection);
  }
  circleStatus = '';
  render();
  try {
    let attempt = resume;
    let intent = circleIntent(from, to, parseSwapAmount(input.value, from.decimals), mode);
    if (pending) {
      trackCircleAttempt(selection, circleAttempt.attemptId);
      attempt = await wallet.getCircleSwapStatus();
      if (!sameWallet(selection, wallet.getSelection())) return;
      applyCircleAttempt(attempt);
      if (!continueCircleApproval(selection, attempt)) return;
    }
    // A reset and a grant can each advance once. Every new action gets its own
    // server review and can only start after the preceding receipt is verified.
    for (let step = 0; step < 3 && active(); step++) {
      const previous = attempt;
      if (previous) {
        if (!continueCircleApproval(selection, previous)) return;
        const [source, destination] = recordAssets(previous);
        intent = circleIntent(source, destination, previous.amount, mode);
        from = source;
        to = destination;
        input.maxLength = mode ? 73 + from.decimals : 79;
        input.value = formatUnits(unsigned(previous.amount), source.decimals);
        circleSteps.set(circleSwapStep(previous), 'Verified on Arc');
      }
      attempt = await wallet.sendCircleArcSwap(selection, intent, {
        active,
        notice: previous ? describeCircleSwap(previous) + ' Review the fresh terms.' : '',
        reviewed(terms) {
          if (previous && terms.phase === 'approval' && (previous.allowanceValue !== '0' || terms.allowanceValue === '0')) {
            throw new Error('The allowance changed again. Start a new review to continue.');
          }
          circleSteps.set(circleSwapStep(terms), 'Review');
          circleReview = terms;
          render();
        },
        submitted(record) {
          if (!record) return;
          trackCircleAttempt(selection, record.attemptId);
          applyCircleAttempt(record);
          render();
        },
      });
      if (!sameWallet(selection, wallet.getSelection())) return;
      applyCircleAttempt(attempt);
      if (!continueCircleApproval(selection, attempt)) return;
    }
  } catch (error) {
    if (!sameWallet(selection, wallet.getSelection())) return;
    circleReview = null;
    if (error.code === 'CIRCLE_PENDING' && (!circleAttempt || circleTerminal(circleAttempt))) {
      circleAttempt = { status: 'ambiguous' };
    } else if (!circleAttempt || circleTerminal(circleAttempt)) trackCircleAttempt(selection);
    for (const [step, state] of circleSteps) if (state === 'Review') circleSteps.set(step, 'Stopped');
    if (error.code === 'CIRCLE_PENDING' || error.status === 409) await refreshCircleSwap();
    circleStatus = error.message;
  } finally {
    busy = false;
    render();
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
  if (busy || pendingReview || arcNetwork.error) return;
  const selection = wallet.getSelection();
  if (!selection) return wallet.connect();
  if (selection.type === 'circle') {
    const pending = circleAttempt && !circleTerminal(circleAttempt);
    const amount = parseSwapAmount(input.value, from.decimals);
    if (!pending && (!amount || !(anyToken ? selection.capabilities.arcAnyToken : selection.capabilities.arcSwap))) return;
    await runCircleSwap(selection, { pending });
    return;
  }
  if (historyError || history?.state === 'pending') return;
  try {
    if (selection.chainId !== arcNetwork.id) return await wallet.switchNetwork();
    if (submit.disabled) return;
    const quote = quoteState.quote;
    if (!quote || quote.account.toLowerCase() !== selection.address.toLowerCase()) throw new Error('Wait for a quote for this wallet.');
    try { await assertCurrentFeePolicy(quote.feePolicy); }
    catch (error) {
      updateQuote();
      throw error;
    }
    const prepared = await reviewSwap(client, quote);
    if (!visible || pendingReview || !sameWallet(selection, wallet.getSelection()) || quote !== quoteState.quote) return;
    pendingReview = { quote, terms: prepared, selection };
    field('send').textContent = tokenAmount(quote.amount, from);
    field('receive').textContent = tokenAmount(quote.received, to);
    field('minimum').textContent = tokenAmount(quote.minimum, to);
    field('route').textContent = quote.route;
    field('termul-fee-label').hidden = field('termul-fee').hidden = !quote.feePolicy.bps;
    field('termul-fee').textContent = tokenAmount(quote.integratorFee, from) + ' (included)';
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
  if (wallet.getSelection()?.type === 'circle' || !request || busy || request.quote !== quoteState.quote) return;
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
  if (anyToken) input.maxLength = 73 + from.decimals;
  updateQuote();
});
arcFrom.addEventListener('click', () => { if (anyToken && !busy) picker.open('send', to.address); });
arcTo.addEventListener('click', () => { if (anyToken && !busy) picker.open('receive', from.address); });
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

async function refreshCircleSwap() {
  const selection = wallet.getSelection();
  if (circlePoll || selection?.type !== 'circle') return;
  const poll = circlePoll = {};
  try {
    const attempt = await wallet.getCircleSwapStatus();
    if (circlePoll !== poll || !sameWallet(selection, wallet.getSelection())) return;
    circleStatusLoaded = true;
    applyCircleAttempt(attempt);
    render();
    if (!busy && continueCircleApproval(selection, attempt)) void runCircleSwap(selection, { resume: attempt });
  } catch { /* Preserve pending state through a transient provider or RPC error. */ }
  finally { if (circlePoll === poll) circlePoll = null; }
}

window.termulSwapWalletChanged = () => {
  picker.close();
  picker.clearBalances();
  circlePoll = null;
  circleStatusLoaded = false;
  circleAttempt = null;
  circleStatus = '';
  if (circleFeedback) transactions.clear(circleFeedback);
  circleFeedback = null;
  circleSteps.clear();
  if (visible) void refreshCircleSwap();
  pendingReview = null;
  if (review.open) review.close();
  balances = null;
  balanceError = false;
  refreshHistory();
  updateQuote();
  void refreshBalances();
};

window.termulSwapViewChanged = (next, enableAnyToken = false) => {
  const modeChanged = anyToken !== enableAnyToken;
  if (modeChanged) {
    drafts[Number(anyToken)] = { from, to, amount: input.value };
    anyToken = enableAnyToken;
    const draft = drafts[Number(anyToken)];
    ({ from, to } = draft);
    input.value = draft.amount;
    input.maxLength = anyToken ? 73 + from.decimals : 79;
    $('#circle-arc-gas-balance').hidden = arcFrom.hidden = arcTo.hidden = !anyToken;
    node('from-fixed').hidden = node('to-fixed').hidden = anyToken;
    if (anyToken) void hydrateArcTokens();
    else picker.close();
    (anyToken ? $('#circle-arc-exchange') : $('#stablecoin-panel')).append(swapLayout);
    balances = null;
    balanceError = false;
    balanceRequest++;
  }
  if (visible === next && !modeChanged) return;
  visible = next;
  clearInterval(refreshTimer);
  clearInterval(circleTimer);
  if (visible) {
    refreshHistory();
    refreshTimer = setInterval(() => {
      void refreshBalances();
      if (!busy && !circleStatusLoaded) void refreshCircleSwap();
    }, 20_000);
    circleTimer = setInterval(() => {
      if (!busy && circleAttempt && !circleTerminal(circleAttempt)) void refreshCircleSwap();
    }, 6000);
    void refreshCircleSwap();
    void refreshBalances();
  }
  updateQuote();
};
window.termulSwapViewChanged(!$('#swap-view').classList.contains('hidden'));
