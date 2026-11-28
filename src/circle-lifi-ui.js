import { formatUnits, parseUnits } from 'viem';
import { circleLifiNetworks, circleLifiPairs } from './circle-lifi-routes.js';
import { transactionLink } from './any-token-networks.js';

const element = id => document.getElementById('circle-lifi' + (id ? '-' + id : ''));
const panel = element();
const form = element('form');
const from = element('from'), to = element('to'), amount = element('amount');
const message = element('status'), entries = element('history'), close = element('close');
const submit = form.querySelector('button');
const pending = ['submitting','source-pending','destination-pending'];
let wallet, progress, timer, active, history = [];

const option = id => new Option(circleLifiNetworks[id], id);
from.replaceChildren(...[...new Set(Object.keys(circleLifiPairs).map(pair => pair.split(':')[0]))].map(option));
function destinations() {
  to.replaceChildren(...Object.keys(circleLifiPairs).filter(pair => pair.startsWith(from.value + ':'))
    .map(pair => option(pair.split(':')[1])));
}
from.addEventListener('change', destinations);
destinations();

function render() {
  const status = progress?.status;
  const locked = status === 'ready' || pending.includes(status);
  if (locked) {
    from.value = progress.fromChain;
    destinations();
    to.value = progress.toChain;
    amount.value = formatUnits(BigInt(progress.amount), 6);
  }
  const labels = {
    ready: 'No transfer was submitted for the remaining steps. You can close this route.',
    submitting: 'Checking whether Circle received the reserved step.',
    'source-pending': 'Waiting for a finalized source transaction.',
    'destination-pending': 'Source confirmed. Waiting for independent destination proof.',
    settled: progress?.received ? `Received ${formatUnits(BigInt(progress.received), 6)} USDC.` : 'LI.FI settlement verified.',
    closed: 'Unsubmitted route closed. Previously confirmed allowances remain on-chain.',
    reverted: 'The source receipt shows a revert.',
    rejected: 'Circle approval was rejected or expired.',
  };
  const recovery = {
    'refund-reported': 'LI.FI reports a refund. A matching refund receipt has not been verified.',
    'fill-window-ended': 'The quoted fill window ended. The existing transfer remains reserved.',
    'delivery-issue': 'LI.FI reports a delivery issue. Independent settlement has not been verified.',
  };
  message.textContent = recovery[progress?.recovery] ?? labels[status] ?? '';
  from.disabled = to.disabled = amount.disabled = locked;
  submit.disabled = pending.includes(status);
  close.hidden = status !== 'ready';
  const rows = progress ? [progress, ...history.filter(item => item.id !== progress.id)] : history;
  entries.replaceChildren(...rows.flatMap(row => {
    const records = [...row.history, ...(row.destinationHash ? [{ phase: 'Destination', chainId: row.toChain, hash: row.destinationHash }] : [])];
    return records.flatMap(step => {
      const href = transactionLink(step.chainId, step.hash);
      if (!href) return [];
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = circleLifiNetworks[step.chainId] + ' · ' + step.phase;
      li.append(link);
      return [li];
    });
  }));
}

async function run(action, input) {
  if (active || !wallet) return;
  const current = wallet;
  const operation = Symbol();
  active = operation;
  try {
    if (action !== 'poll') message.textContent = 'Checking Circle LI.FI…';
    const result = await window.termulWallet.circleLifi(action, input);
    if (!result || current !== wallet) return;
    const data = ['poll','status'].includes(action) ? result : await window.termulWallet.circleLifi('poll');
    if (action === 'status') {
      const previous = await window.termulWallet.circleLifi('history');
      if (current !== wallet) return;
      history = previous.routes;
    }
    if (current !== wallet) return;
    if (data) progress = data.route;
    render();
    if (result.pending && !progress) message.textContent = 'Waiting for evidence of the reserved step.';
  } catch (error) {
    if (current === wallet && action !== 'poll') message.textContent = error.message;
  } finally {
    if (active === operation) active = undefined;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!/^\d{1,6}(?:\.\d{1,6})?$/.test(amount.value.trim())) {
    message.textContent = 'Enter a USDC amount with up to six decimal places.';
    return;
  }
  void run('review', { fromChain: Number(from.value), toChain: Number(to.value), amount: String(parseUnits(amount.value.trim(), 6)) });
});
close.addEventListener('click', () => void run('close'));
element('refresh').addEventListener('click', () => void run('status'));

export function showCircleLifi(visible) {
  const selected = visible ? window.termulWallet.getSelection() : undefined;
  panel.hidden = !visible;
  if (selected === wallet) return;
  clearInterval(timer);
  wallet = selected;
  progress = active = undefined;
  history = [];
  amount.value = '';
  render();
  if (wallet) {
    void run('poll');
    timer = setInterval(() => { if (!document.hidden) void run('poll'); }, 12000);
  }
}
