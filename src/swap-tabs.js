import './any-token.css';

const $ = selector => document.querySelector(selector);
const tabs = [...document.querySelectorAll('.swap-tabs [role="tab"]')];
let selected = 0;
let open = false;
let loading;
let exchange;

async function load() {
  $('#exchange-load-retry').classList.add('hidden');
  $('#exchange-load-status').textContent = 'Loading exchange…';
  try {
    const { mountAnyToken } = await import('./any-token-widget.js');
    exchange = await mountAnyToken({
      root: $('#exchange-widget'),
      active: () => open && selected === 1,
      status: $('#exchange-load-status'),
    });
    exchange.show(open && selected === 1);
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
  window.termulSwapViewChanged?.(open && selected === 0);
  if (open && selected === 1 && !loading) loading = load();
  exchange?.show(open && selected === 1);
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
window.termulSwapTabsChanged = visible => { open = visible; render(); };
window.termulExchangeWalletChanged = () => exchange?.walletChanged();
window.termulSwapTabsChanged(!$('#swap-view').classList.contains('hidden'));
