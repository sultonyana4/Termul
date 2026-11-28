import { connect, createConfig, disconnect, getConnection, reconnect, watchConnection } from '@wagmi/core';
import { getAddress, http } from 'viem';
import { arcChain, arcNetwork } from './arc-network.js';
import { discoverInjectedWallets, injectedConnector } from './injected-wallets.js';
import { exchangeChains } from './any-token-networks.js';
import { assertProviderChain, sameWallet, switchWalletToChain } from './wallet-provider.js';
import { createWalletSession, endpointFor } from './wallet-session.js';
import './wallet-ui.css';
import { createCircleWallet } from './circle-wallet.js';
import { renderReceiptAssets } from './display-assets.js';
import { arcTokenCatalog } from './circle-arc-tokens.js';
import { ARC_ANY_SWAP_TOKENS } from './swap-quote.js';

export const walletConfig = createConfig({
  chains: exchangeChains,
  transports: Object.fromEntries(exchangeChains.map(chain => [chain.id, http(chain.rpcUrls.default.http[0])])),
  multiInjectedProviderDiscovery: false,
  storage: null,
});
const preferenceKey = 'termul.wallet-selection.v1';
const dialog = document.getElementById('wallet-dialog');
const list = document.getElementById('wallet-choices');
const status = document.getElementById('wallet-connect-status');
let busy = false;
let restoredWallet;
let revision = 0;

function externalSelection(account = getConnection(walletConfig)) {
  return account.isConnected && account.address && account.connector
    ? { address: account.address, chainId: account.chainId, connectorId: account.connector.uid, connectorScope: account.connector.id, revision, type: 'external', capabilities: { invoice: true, exchange: true, injectedProvider: true } }
    : null;
}

function selection() { return circle?.selection() ?? externalSelection(); }

function savePreference(wallet, address) {
  try {
    if (wallet?.rdns && address) localStorage.setItem(preferenceKey, JSON.stringify({ rdns: wallet.rdns, address }));
    else localStorage.removeItem(preferenceKey);
  } catch { /* Wallet selection still works with browser storage disabled. */ }
}

async function getProvider(expected) {
  const account = getConnection(walletConfig);
  if (circle?.selection() || !sameWallet(expected, externalSelection(account))) throw new Error('The connected wallet changed.');
  const provider = await account.connector.getProvider();
  if (!sameWallet(expected, selection())) throw new Error('The connected wallet changed.');
  return provider;
}

const session = createWalletSession({
  getWallet: externalSelection,
  getProvider,
  localOrigin: import.meta.env.TERMUL_LOCAL_CIRCLE ? import.meta.env.TERMUL_LOCAL_ORIGIN : undefined,
  url: import.meta.env.TERMUL_LOCAL_CIRCLE ? '/__termul_circle/web3' : endpointFor(import.meta.env.VITE_TERMUL_WALLET_API_URL),
  origin: () => window.location.origin,
  onChange: () => window.termulSessionChanged?.(),
});

let circleStatusTimer;
let lastCircleResult;
let circleStatusCheck;
const circle = (import.meta.env.TERMUL_LOCAL_CIRCLE || import.meta.env.TERMUL_CIRCLE_RELEASE_UI) ? createCircleWallet({
  production: import.meta.env.TERMUL_CIRCLE_RELEASE_UI,
  walletApiUrl: endpointFor(import.meta.env.VITE_TERMUL_WALLET_API_URL),
  changed() {
    session.invalidate();
    window.termulConnectionChanged?.(selection());
    document.getElementById('circle-check-attempt').hidden = !circle.selection();
    const history = document.getElementById('circle-history');
    history.hidden = !circle.selection();
    history.open = false;
    document.getElementById('circle-history-list').replaceChildren();
    document.getElementById('circle-attempt-status').hidden = true;
    lastCircleResult = null;
    clearTimeout(circleStatusTimer);
    if (circle.selection()) circleStatusTimer = setTimeout(watchCircleAttempt, 2000);
  },
  sessionChanged: () => window.termulSessionChanged?.(),
}) : null;

function renderChoices() {
  const choices = discovery.list();
  list.replaceChildren(...choices.map((wallet, index) => {
    const button = document.createElement('button');
    button.className = 'wallet-choice';
    button.type = 'button';
    button.disabled = busy;
    if (wallet.icon) {
      const icon = document.createElement('img');
      icon.alt = '';
      icon.src = wallet.icon;
      button.append(icon);
    }
    const label = document.createElement('span');
    label.textContent = wallet.name;
    if (choices.some(other => other !== wallet && other.name === wallet.name)) {
      label.append(document.createTextNode(` (${index + 1})`));
    }
    button.append(label);
    if (wallet.rdns) {
      const identifier = document.createElement('small');
      identifier.textContent = wallet.rdns;
      label.append(identifier);
    }
    button.addEventListener('click', () => void selectWallet(wallet));
    return button;
  }));
  if (circle) {
    const choose = (title, run) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wallet-choice';
      button.textContent = title;
      button.disabled = busy;
      button.addEventListener('click', run);
      list.append(button);
    };
    if (!circle.selection()) choose('Continue with Email', () => { dialog.close(); void circle.open(); });
    if (circle.selection() && externalSelection()) choose('Use connected browser wallet', () => { circle.signOut(); dialog.close(); });
  }
  document.getElementById('wallet-none').hidden = choices.length > 0;
}

async function selectWallet(wallet) {
  if (busy || (!circle?.selection() && selection())) return;
  if (circle?.selection()) {
    circle.signOut();
    if (externalSelection()) await disconnectWallet();
  }
  if (arcNetwork.error) {
    status.textContent = arcNetwork.error;
    return;
  }
  busy = true;
  status.textContent = 'Approve the connection in your wallet.';
  renderChoices();
  try {
    const { accounts } = await connect(walletConfig, { connector: injectedConnector(wallet) });
    const unique = wallet.rdns && discovery.list().filter(other => other.rdns === wallet.rdns).length === 1;
    savePreference(unique ? wallet : null, accounts[0]);
    dialog.close();
  } catch (error) {
    status.textContent = error?.code === 4001 ? 'Connection declined. Select a wallet to try again.'
      : error?.code === -32002 ? 'A connection request is already open in your wallet.'
      : 'Could not connect to this wallet. Unlock it and try again.';
  } finally {
    busy = false;
    renderChoices();
  }
}

async function disconnectWallet() {
  session.invalidate();
  restoredWallet = null;
  savePreference();
  await disconnect(walletConfig);
}

const discovery = discoverInjectedWallets(window, () => {
  if (restoredWallet && discovery.list().filter(wallet => wallet.rdns === restoredWallet.rdns).length > 1) {
    void disconnectWallet();
  }
  if (dialog.open) renderChoices();
});

window.termulWallet = {
  connect({ choosing = false } = {}) {
    if (dialog.open || (selection() && !choosing)) return;
    status.textContent = '';
    dialog.showModal();
    discovery.request();
    renderChoices();
  },
  disconnect: () => circle?.selection() ? circle.signOut() : disconnectWallet(),
  assertSelection(expected) {
    if (!sameWallet(expected, selection())) throw new Error('The selected wallet changed.');
  },
  circleLifi: (action, terms) => circle?.lifi(action, terms),
  circleBridge: (action, amount) => circle?.bridge(action, amount),
  async getCircleSwapStatus() { return circle?.swapStatus() ?? null; },
  sendCircleArcSwap(expected, input, hooks) {
    if (!circle || !sameWallet(expected, circle.selection())) throw new Error('Circle wallet is unavailable.');
    return circle.sendArcSwap(circle.selection(), input, hooks);
  },
  sendManagedInvoice(expected, operation, hooks) {
    if (!circle || !sameWallet(expected, circle.selection())) throw new Error('Circle wallet is unavailable.');
    return circle.sendInvoice(circle.selection(), operation, hooks);
  },
  async getManagedInvoiceStatus(expected) {
    if (!circle || !sameWallet(expected, circle.selection())) throw new Error('Circle wallet is unavailable.');
    const attempt = await circle.status();
    if (!sameWallet(expected, circle.selection())) throw new Error('The selected wallet changed.');
    return attempt;
  },
  getSelection: selection,
  getProvider,
  switchNetwork: () => switchNetwork(arcChain),
  switchExchangeNetwork(chain) {
    if (!exchangeChains.includes(chain)) throw new Error('Unsupported network.');
    return switchNetwork(chain);
  },
  get session() { return circle?.selection() ? circle.session : session; },
};

async function switchNetwork(chain) {
  const selected = selection();
  const provider = await getProvider(selected);
  const assertSameAccount = () => {
    const current = selection();
    if (current?.connectorId !== selected.connectorId || current.address !== selected.address) {
      throw new Error('The connected wallet changed.');
    }
  };
  await switchWalletToChain(provider, chain, assertSameAccount);
  await assertProviderChain(provider, selected.address, chain.id);
  assertSameAccount();
  // Some extensions switch successfully without emitting chainChanged.
  getConnection(walletConfig).connector.onChainChanged('0x' + chain.id.toString(16));
}

let lastSelection = null;
watchConnection(walletConfig, {
  onChange(account) {
    const current = externalSelection(account);
    if ((!current && !lastSelection) || sameWallet(current, lastSelection)) return;
    const firstConnection = !lastSelection;
    if (lastSelection && (!current || current.address !== lastSelection.address)) savePreference();
    revision++;
    lastSelection = externalSelection(account);
    if (!firstConnection) session.invalidate();
    if (!circle?.selection()) {
      window.termulConnectionChanged?.(lastSelection);
      if (firstConnection) void session.restore();
    }
  },
});

if (circle) {
  const choose = document.getElementById('wallet-switch-choice');
  choose.hidden = false;
  choose.addEventListener('click', () => {
    document.getElementById('account-dialog').close();
    window.termulWallet.connect({ choosing: true });
  });
  const circleHistory = document.getElementById('circle-history');
  circleHistory.addEventListener('toggle', async () => {
    if (!circleHistory.open) return;
    const current = circle.selection();
    const list = document.getElementById('circle-history-list');
    const el = (value) => {
      const li = document.createElement('li');
      li.textContent = value;
      return li;
    };
    list.replaceChildren(el('Loading Circle transactions…'));
    try {
      const attempts = await circle.history();
      if (current !== circle.selection() || !circleHistory.open) return;
      list.replaceChildren(...attempts.map(attempt => {
        const name = attempt.kind === 'arc-swap' ? (attempt.phase === 'approval'
          ? (attempt.allowanceValue === '0' ? 'Token allowance reset' : 'Token approval') : attempt.anyToken ? 'Any Token swap' : 'Stablecoin swap')
          : attempt.kind === 'payment' ? 'Invoice payment' : 'Invoice creation';
        const status = { verified: 'Confirmed on Arc', reverted: 'Reverted on Arc', rejected: 'Declined', expired: 'Approval expired' }[attempt.status]
          ?? 'Awaiting verification';
        const li = el(name + ' · ' + status);
        if (attempt.anyToken) {
          const assets = attempt.assets ?? [ARC_ANY_SWAP_TOKENS[attempt.from], ARC_ANY_SWAP_TOKENS[attempt.to]].filter(Boolean);
          const displayed = attempt.phase === 'approval' ? assets.slice(0, 1) : assets;
          const artwork = document.createElement('div');
          artwork.className = 'receipt-assets';
          renderReceiptAssets(artwork, displayed);
          li.append(artwork);
          if (!attempt.assets && displayed.length) void arcTokenCatalog.load().then(tokens => {
            if (artwork.isConnected) renderReceiptAssets(artwork, displayed.map(asset =>
              tokens.find(token => token.address.toLowerCase() === asset.address.toLowerCase()) ?? asset));
          }).catch(() => {});
        }
        if (['verified', 'reverted'].includes(attempt.status) && /^0x[0-9a-f]{64}$/i.test(attempt.transactionHash)) {
          const link = document.createElement('a');
          link.href = arcNetwork.explorerUrl + '/tx/' + attempt.transactionHash;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Arc receipt';
          li.append(' ', link);
        }
        return li;
      }));
      if (!attempts.length) list.append(el('No Circle transactions found.'));
    } catch {
      if (current === circle.selection() && circleHistory.open) list.replaceChildren(el('Circle transactions could not be loaded.'));
    }
  });
  document.getElementById('circle-check-attempt').addEventListener('click', () => void checkCircleAttempt(true));
}

function watchCircleAttempt() {
  const current = circle.selection();
  if (!current) return;
  if (!document.hidden) void checkCircleAttempt(false);
  circleStatusTimer = setTimeout(watchCircleAttempt, 20_000);
}

async function checkCircleAttempt(manual) {
  const current = circle.selection();
  if (!current || circleStatusCheck === current) return;
  circleStatusCheck = current;
  const output = document.getElementById('circle-attempt-status');
  if (manual) {
    output.hidden = false;
    output.textContent = 'Checking Circle and Arc…';
  }
  try {
    const attempt = await circle.status();
    if (current !== circle.selection()) return;
    if (manual || !output.hidden) {
      output.textContent = !attempt ? 'No Circle invoice attempt found.'
        : attempt.status === 'verified' ? `Arc confirmed ${attempt.kind === 'payment' ? 'payment' : 'invoice creation'}.`
        : attempt.status === 'reverted' ? 'The Arc transaction reverted.'
        : attempt.status === 'rejected' ? 'Circle approval was declined.'
        : attempt.status === 'expired' ? 'Circle approval expired.'
        : 'The attempt is still pending. Termul will keep checking.';
      if (attempt?.status === 'verified' && /^0x[0-9a-f]{64}$/i.test(attempt.transactionHash)) {
        const link = document.createElement('a');
        link.href = arcNetwork.explorerUrl + '/tx/' + attempt.transactionHash;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'View Arc transaction';
        output.append(' ', link);
      }
    }
    if (attempt && ['verified', 'reverted', 'rejected', 'expired'].includes(attempt.status)) {
      const key = [attempt.kind, attempt.invoiceId, attempt.status, attempt.transactionHash].join(':');
      if (key !== lastCircleResult) {
        lastCircleResult = key;
        await window.arusPayCircleAttemptChanged?.(attempt);
      }
    }
  } catch {
    if (manual && current === circle.selection()) output.textContent = 'Could not check the attempt. Try checking again.';
  } finally {
    if (circleStatusCheck === current) circleStatusCheck = null;
  }
}

discovery.request();
if (circle) void circle.restore(() => !busy && !dialog.open && !selection());
// Restore a single previously chosen EIP-6963 provider only if its primary
// authorized account still matches. A legacy provider has no stable identifier.
setTimeout(async () => {
  if (busy || dialog.open || selection() || arcNetwork.error) return;
  let preference;
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey));
    if (typeof saved?.rdns !== 'string') return;
    preference = { rdns: saved.rdns, address: getAddress(saved.address) };
  } catch { return; }
  const matches = () => discovery.list().filter(wallet => wallet.rdns === preference.rdns);
  const [wallet, duplicate] = matches();
  if (!wallet || duplicate) return;
  busy = true;
  try {
    const connections = await reconnect(walletConfig, { connectors: [injectedConnector(wallet, preference.address)] });
    if (connections.length) {
      restoredWallet = wallet;
      if (matches().length !== 1 || !sameWallet(selection(), {
        address: preference.address, chainId: connections[0].chainId, connectorId: connections[0].connector.uid, revision,
      })) await disconnectWallet();
      else if (dialog.open) dialog.close();
    }
  } finally {
    busy = false;
    if (dialog.open) renderChoices();
  }
}, 250);
