import './any-token.css';
import { showCircleLifi } from './circle-lifi-ui.js';
import { showCircleBridge } from './circle-bridge-ui.js';

const $ = selector => document.querySelector(selector);
const tabs = [...document.querySelectorAll('.swap-tabs [role="tab"]')];
let selected = 0;
let open = false;
let loading;
let exchange;
const unavailable = 'Any Token is unavailable for Circle Email Wallet in this phase.';
const transferRecovery = $('#circle-transfer-recovery');

async function load() {
  $('#exchange-load-retry').classList.add('hidden');
  $('#exchange-load-status').textContent = 'Loading exchange…';
  try {
    const { mountAnyToken } = await import('./any-token-widget.js');
    exchange = await mountAnyToken({
      root: $('#exchange-widget'),
      active: () => open && selected === 1 && window.termulWallet?.getSelection()?.type !== 'circle',
      status: $('#exchange-load-status'),
    });
    exchange.show(open && selected === 1 && window.termulWallet?.getSelection()?.type !== 'circle');
  } catch {
    $('#exchange-load-status').textContent = 'The LI.FI exchange could not load.';
    $('#exchange-load-retry').classList.remove('hidden');
    loading = null;
  }
}

function render() {
  for (const [index, tab] of tabs.entries()) {
    tab.setAttribute('aria-selected', String(index === selected));
    tab.tabIndex = index === selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = index !== selected;
  }
  const wallet = window.termulWallet?.getSelection();
  const circle = wallet?.type === 'circle';
  const circleAny = circle && wallet.capabilities.arcAnyToken;
  const anyVisible = Boolean(open && selected === 1 && circleAny);
  window.termulSwapViewChanged?.(open && (selected === 0 || anyVisible), anyVisible);
  $('#exchange-widget').hidden = circle;
  $('#circle-arc-exchange').hidden = !circleAny;
  $('#any-token-panel .any-token-content').classList.toggle('circle-arc-active', Boolean(circleAny));
  $('#exchange-description').textContent = circle ? 'Swap supported tokens on Arc Mainnet.' : 'Swap tokens and move funds between supported networks.';
  const canRecover = circle && wallet.capabilities.transferRecovery;
  transferRecovery.hidden = !canRecover;
  if (!canRecover) transferRecovery.open = false;
  const recoveryVisible = Boolean(canRecover && transferRecovery.open && open && selected === 1);
  showCircleLifi(recoveryVisible);
  showCircleBridge(recoveryVisible);
  $('#exchange-wallet-alternative').hidden = !circle || circleAny;
  if (circle) {
    $('#exchange-load-status').textContent = circleAny ? '' : unavailable;
    $('#exchange-load-retry').classList.add('hidden');
  } else if ($('#exchange-load-status').textContent === unavailable) {
    $('#exchange-load-status').textContent = exchange ? '' : 'Loading exchange…';
  }
  if (open && selected === 1 && !loading && !circle) loading = load();
  exchange?.show(open && selected === 1 && !circle);
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => { selected = index; render(); });
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    selected = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (selected + 1) % tabs.length;
    render();
    tabs[selected].focus();
  });
}

$('#exchange-load-retry').addEventListener('click', () => { if (!loading) loading = load(); });
transferRecovery.addEventListener('toggle', render);
window.termulSwapTabsChanged = visible => { open = visible; render(); };
$('#exchange-wallet-alternative button').addEventListener('click', () => window.termulWallet?.connect({ choosing: true }));
window.termulExchangeWalletChanged = () => { render(); exchange?.walletChanged(); };
window.termulSwapTabsChanged(!$('#swap-view').classList.contains('hidden'));
