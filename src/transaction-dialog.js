import { renderReceiptAssets } from './display-assets.js';

const phases = {
  preparing: ['Preparing transaction', 'Checking the network and transaction details.'],
  approval: ['Wallet confirmation required', 'Review the amount and network fee in your wallet.'],
  submitted: ['Transaction submitted', 'Waiting for the network to confirm.'],
  confirmed: ['Transaction confirmed', 'The network confirmed this transaction.'],
  pending: ['Still waiting for confirmation', 'Check your wallet activity before trying again.'],
  rejected: ['Wallet request declined', 'The wallet declined this request.'],
  failed: ['Transaction failed', 'Check the details before trying again.'],
};
const validHash = hash => typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash);
const terminal = new Set(['confirmed', 'rejected', 'failed']);
const managers = new WeakMap();

export function transactionDialogFor(dialog) {
  if (!managers.has(dialog)) managers.set(dialog, createTransactionDialog(dialog));
  return managers.get(dialog);
}

export function transactionExplorerUrl(network, hash) {
  if (!validHash(hash)) return null;
  try {
    const url = new URL(network.explorerUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return new URL(url.pathname.replace(/\/$/, '') + '/tx/' + hash, url.origin).href;
  } catch {
    return null;
  }
}

export function createTransactionDialog(dialog) {
  const field = name => dialog.querySelector('[data-transaction-' + name + ']');
  const done = field('done');
  const copy = field('copy');
  let active;
  let trigger;

  function restoreFocus() {
    if (trigger?.isConnected && !trigger.disabled && !trigger.closest('.hidden,[hidden]')) trigger.focus();
    else dialog.ownerDocument.querySelector(dialog.ownerDocument.querySelector('#payment:not(.hidden)') ? '#payment .brand' : '#workspace .topbar .brand')?.focus();
  }

  dialog.addEventListener('close', restoreFocus);
  copy.addEventListener('click', async () => {
    const operation = active;
    const hash = operation?.hash;
    if (!hash) return;
    let message;
    try {
      await dialog.ownerDocument.defaultView.navigator.clipboard.writeText(hash);
      message = 'Transaction hash copied.';
    } catch {
      message = 'Copy unavailable. Select the transaction hash above.';
    }
    if (active === operation) field('copy-status').textContent = message;
  });

  return {
    begin({ network, type, amount, detail, scope, origin, successTitle, assets = [], networks, destinationHash, links = [] }) {
      const operation = { scope };
      active = operation;
      trigger = origin || dialog.ownerDocument.activeElement;
      field('type').textContent = type;
      field('amount').textContent = amount;
      field('detail').textContent = detail;
      field('network').textContent = network.name;
      renderReceiptAssets(field('assets'), assets);
      const networkRow = field('networks');
      networkRow.textContent = networks || '';
      networkRow.hidden = networkRow.previousElementSibling.hidden = !networks;
      const destination = field('destination');
      destination.textContent = validHash(destinationHash) ? destinationHash : '';
      destination.hidden = destination.previousElementSibling.hidden = !destination.textContent;
      const extra = field('links');
      extra.replaceChildren();
      for (const { href, label } of links) {
        if (!href || new URL(href).protocol !== 'https:') continue;
        const link = dialog.ownerDocument.createElement('a');
        link.className = 'btn btn-quiet';
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = label;
        extra.append(link);
      }
      extra.hidden = !extra.childNodes.length;
      field('copy-status').textContent = '';
      function update(phase, { message, verifiedHash, referenceHash, settledAmount, received, rate, title } = {}) {
        if (active !== operation || terminal.has(operation.phase) || !Object.hasOwn(phases, phase)) return;
        const verifiedUrl = phase === 'confirmed' ? transactionExplorerUrl(network, verifiedHash) : null;
        if (phase === 'confirmed' && !verifiedUrl) phase = 'pending';
        const referenceUrl = ['pending', 'submitted'].includes(phase) ? transactionExplorerUrl(network, referenceHash) : null;
        const url = verifiedUrl || referenceUrl;
        operation.phase = phase;
        operation.hash = verifiedUrl ? verifiedHash : null;
        dialog.dataset.phase = phase;
        field('title').textContent = phase === 'confirmed' && successTitle ? successTitle : title || phases[phase][0];
        field('message').textContent = message || phases[phase][1];
        field('proof').hidden = !url;
        field('proof-label').textContent = verifiedUrl ? 'Verified transaction hash' : 'Submitted transaction reference';
        field('hash').textContent = operation.hash || (referenceUrl ? referenceHash : '');
        copy.hidden = !verifiedUrl;
        field('amount').textContent = verifiedUrl && settledAmount ? settledAmount : amount;
        for (const [name, value] of [['received', received], ['rate', rate]]) {
          const output = field(name);
          output.hidden = output.previousElementSibling.hidden = !verifiedUrl || !value;
          output.textContent = verifiedUrl && value ? value : '';
        }
        const explorer = field('explorer');
        if (url) explorer.href = url;
        else explorer.removeAttribute('href');
        explorer.textContent = 'View on ' + network.explorerName;
        done.textContent = phase === 'confirmed' ? 'Done' : 'Close';
      }
      update('preparing');
      operation.update = update;
      dialog.querySelector('.dialog-content').scrollTop = 0;
      if (!dialog.open) {
        dialog.showModal();
        done.focus();
      }
      return { update };
    },
    update(scope, phase, details) {
      if (active?.scope === scope) active.update(phase, details);
    },
    clear() {
      active = null;
      if (dialog.open) dialog.close();
    },
  };
}
