import { connect, createConfig, disconnect, getConnection, reconnect, watchConnection } from '@wagmi/core';
import { getAddress, http } from 'viem';
import { arcChain, arcNetwork } from './arc-network.js';
import { discoverInjectedWallets, injectedConnector } from './injected-wallets.js';
import { exchangeChains } from './any-token-networks.js';
import { assertProviderChain, sameWallet, switchWalletToChain } from './wallet-provider.js';
import { createWalletSession, endpointFor } from './wallet-session.js';
import './wallet-ui.css';

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

function selection(account = getConnection(walletConfig)) {
  return account.isConnected && account.address && account.connector
    ? { address: account.address, chainId: account.chainId, connectorId: account.connector.uid, revision }
    : null;
}

function savePreference(wallet, address) {
  try {
    if (wallet?.rdns && address) localStorage.setItem(preferenceKey, JSON.stringify({ rdns: wallet.rdns, address }));
    else localStorage.removeItem(preferenceKey);
  } catch { /* Wallet selection still works with browser storage disabled. */ }
}

async function getProvider(expected) {
  const account = getConnection(walletConfig);
  if (!sameWallet(expected, selection(account))) throw new Error('The connected wallet changed.');
  const provider = await account.connector.getProvider();
  if (!sameWallet(expected, selection())) throw new Error('The connected wallet changed.');
  return provider;
}

const session = createWalletSession({
  getWallet: selection,
  getProvider,
  url: endpointFor(import.meta.env.VITE_TERMUL_WALLET_API_URL),
  origin: () => window.location.origin,
  onChange: () => window.termulSessionChanged?.(),
});

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
  document.getElementById('wallet-none').hidden = choices.length > 0;
}

async function selectWallet(wallet) {
  if (busy || selection()) return;
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
  connect() {
    if (dialog.open || selection()) return;
    status.textContent = '';
    dialog.showModal();
    discovery.request();
    renderChoices();
  },
  disconnect: disconnectWallet,
  getSelection: selection,
  getProvider,
  switchNetwork: () => switchNetwork(arcChain),
  switchExchangeNetwork(chain) {
    if (!exchangeChains.includes(chain)) throw new Error('Unsupported network.');
    return switchNetwork(chain);
  },
  session,
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
    const current = selection(account);
    if ((!current && !lastSelection) || sameWallet(current, lastSelection)) return;
    if (lastSelection && (!current || current.address !== lastSelection.address)) savePreference();
    revision++;
    lastSelection = selection(account);
    session.invalidate();
    window.termulConnectionChanged?.(lastSelection);
  },
});

discovery.request();
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
