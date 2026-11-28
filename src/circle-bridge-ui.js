import { formatUnits, parseUnits } from 'viem';

const panel = document.getElementById('circle-bridge');
const form = document.getElementById('circle-bridge-form');
const amount = document.getElementById('circle-bridge-amount');
const message = document.getElementById('circle-bridge-status');
const entries = document.getElementById('circle-bridge-history');
const close = document.getElementById('circle-bridge-close');
const refresh = document.getElementById('circle-bridge-refresh');
const submit = form.querySelector('button');
const pending = new Set(['submitting', 'source-pending', 'destination-pending']);
let wallet, progress, timer, inFlight;

function render(operations = []) {
  if (progress && (pending.has(progress.status) || progress.status === 'ready')) {
    amount.value = formatUnits(BigInt(progress.amount), 6);
  }
  const status = progress?.status;
  const labels = {
    ready: 'No transfer was submitted for the remaining steps. You can close this route.',
    submitting: 'Checking whether Circle received the last step. Keep this route open.',
    'source-pending': 'Waiting for a finalized Arc transaction.',
    'destination-pending': 'Arc burn confirmed. Waiting for a finalized Base mint.',
    settled: progress?.received ? `Received ${formatUnits(BigInt(progress.received), 6)} USDC on Base.` : 'Base mint confirmed.',
    closed: 'Unsubmitted route closed. A previously confirmed allowance remains on Arc.',
    reverted: 'Arc confirmed that the last step reverted.',
    rejected: 'Circle rejected or expired the approval.',
  };
  message.textContent = labels[status] ?? '';
  amount.disabled = Boolean(status === 'ready' || pending.has(status));
  submit.disabled = pending.has(status);
  close.hidden = status !== 'ready';
  if (!operations.length && progress) operations = [progress];
  entries.replaceChildren(...operations.flatMap(operation => {
    const links = [...(operation.history ?? []).map(step => ({ hash: step.hash, phase: 'Arc ' + step.phase })),
      ...(operation.destinationHash ? [{ hash: operation.destinationHash, phase: 'Base mint', base: true }] : [])];
    return links.filter(({ hash }) => /^0x[a-f0-9]{64}$/i.test(hash)).map(({ hash, phase, base }) => {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = (base ? 'https://basescan.org/tx/' : 'https://explorer.arc.io/tx/') + hash;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = phase;
      li.append(link);
      return li;
    });
  }));
}

async function run(action, value) {
  if (inFlight || !wallet) return;
  const current = wallet;
  const controller = Symbol();
  inFlight = controller;
  try {
    if (action !== 'poll') message.textContent = 'Checking Circle bridge…';
    const result = await window.termulWallet.circleBridge(action, value);
    if (!result || current !== wallet) return;
    const status = action === 'status' || action === 'poll' ? result :
      await window.termulWallet.circleBridge('poll');
    if (current !== wallet) return;
    if (status) progress = status.bridge;
    if (action === 'status') {
      const history = await window.termulWallet.circleBridge('history');
      if (current === wallet) render(history.bridges ?? []);
    } else render();
    if (result.pending && !progress) message.textContent = 'Waiting for the reserved bridge step. Check status before starting again.';
  } catch (error) {
    if (current === wallet && action !== 'poll') message.textContent = error.message;
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!/^\d{1,6}(?:\.\d{1,6})?$/.test(amount.value.trim())) {
    message.textContent = 'Enter a USDC amount with up to six decimal places.';
    return;
  }
  void run('review', String(parseUnits(amount.value.trim(), 6)));
});
close.addEventListener('click', () => void run('close'));
refresh.addEventListener('click', () => void run('status'));

export function showCircleBridge(visible) {
  const selected = visible ? window.termulWallet.getSelection() : undefined;
  panel.hidden = !visible;
  if (selected === wallet) return;
  clearInterval(timer);
  wallet = selected;
  progress = undefined;
  inFlight = null;
  amount.value = '';
  render();
  if (wallet) {
    void run('poll');
    timer = setInterval(() => { if (!document.hidden) void run('poll'); }, 12000);
  }
}
