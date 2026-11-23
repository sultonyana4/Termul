import { createConnector } from '@wagmi/core';
import { getAddress, withTimeout } from 'viem';

function compatible(provider) {
  return typeof provider?.request === 'function' && typeof provider.on === 'function'
    && typeof provider.removeListener === 'function';
}

function legacyName(provider) {
  if (provider.isRabby) return 'Rabby';
  if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
  if (provider.isMetaMask) return 'MetaMask-compatible wallet';
  return 'Browser wallet';
}

export function discoverInjectedWallets(browser, onChange) {
  const announced = new Map();
  const announce = ({ detail }) => {
    const { info, provider } = detail || {};
    if (!compatible(provider) || announced.has(provider)
      || typeof info?.name !== 'string' || !info.name.trim() || info.name.length > 80
      || typeof info.uuid !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(info.uuid)
      || typeof info.rdns !== 'string' || info.rdns.length > 120
      || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(info.rdns)) return;
    const icon = typeof info.icon === 'string' && info.icon.length <= 32768
      && /^data:image\/(?:png|webp|gif|jpeg|svg\+xml)(?:;base64)?,/i.test(info.icon) ? info.icon : null;
    announced.set(provider, { name: info.name.trim(), rdns: info.rdns.toLowerCase(), icon, provider });
    onChange();
  };
  browser.addEventListener('eip6963:announceProvider', announce);
  browser.addEventListener('ethereum#initialized', onChange);
  return {
    request: () => browser.dispatchEvent(new browser.Event('eip6963:requestProvider')),
    list() {
      const injected = browser.ethereum;
      const legacy = Array.isArray(injected?.providers) ? injected.providers : announced.size ? [] : [injected];
      return [...announced.values(), ...[...new Set(legacy)]
        .filter(provider => compatible(provider) && !announced.has(provider))
        .map(provider => ({ name: legacyName(provider), provider }))];
    },
  };
}

function chainNumber(chainId) {
  if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId)) return undefined;
  const number = Number(chainId);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function addresses(accounts) {
  try { return Array.isArray(accounts) ? accounts.map(address => getAddress(address)) : []; }
  catch { return []; }
}

export function injectedConnector({ provider, name, rdns }, reconnectAddress) {
  return createConnector(({ emitter }) => {
    let active = false;
    const readAccounts = async () => addresses(await provider.request({ method: 'eth_accounts' }));
    const readChain = async () => chainNumber(await provider.request({ method: 'eth_chainId' }));

    function stop() {
      if (!active) return;
      active = false;
      provider.removeListener('accountsChanged', onAccountsChanged);
      provider.removeListener('chainChanged', onChainChanged);
      provider.removeListener('disconnect', onDisconnect);
    }

    function onDisconnect() {
      stop();
      emitter.emit('disconnect');
    }

    function onAccountsChanged(accounts) {
      const current = addresses(accounts);
      if (!current.length) onDisconnect();
      else emitter.emit('change', { accounts: current });
    }

    function onChainChanged(value) {
      const chainId = chainNumber(value);
      if (!chainId) onDisconnect();
      else emitter.emit('change', { chainId });
    }

    return {
      id: rdns || 'termul-injected',
      name,
      type: 'injected',
      async connect({ isReconnecting } = {}) {
        const expected = isReconnecting ? reconnectAddress
          : addresses(await provider.request({ method: 'eth_requestAccounts' }))[0];
        const readSelection = () => Promise.all([readAccounts(), readChain()]);
        const [accounts, chainId] = await (isReconnecting
          ? withTimeout(readSelection, { timeout: 1200 }) : readSelection());
        if (!expected || accounts[0] !== expected || !chainId) {
          throw new Error('The selected wallet account or network is unavailable.');
        }
        active = true;
        provider.on('accountsChanged', onAccountsChanged);
        provider.on('chainChanged', onChainChanged);
        provider.on('disconnect', onDisconnect);
        return { accounts, chainId };
      },
      async disconnect() { stop(); },
      getAccounts: readAccounts,
      getChainId: readChain,
      async getProvider() { return provider; },
      async isAuthorized() {
        try {
          return Boolean(reconnectAddress
            && (await withTimeout(readAccounts, { timeout: 1200 }))[0] === reconnectAddress);
        }
        catch { return false; }
      },
      onAccountsChanged, onChainChanged, onDisconnect,
    };
  });
}
