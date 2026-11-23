import {
  arbitrum, avalanche, base, codex, ink, linea, mainnet, monad, morph, optimism, plumeMainnet, polygon, sei, sonic, unichain, worldchain, xdc,
} from 'viem/chains';
import { arcChain } from './arc-network.js';

export const exchangeChains = Object.freeze([
  arcChain, mainnet, base, arbitrum, optimism, polygon, avalanche, linea, unichain,
  worldchain, sonic, sei, xdc, ink, plumeMainnet, monad, morph, codex,
]);
export const exchangeChain = id => exchangeChains.find(chain => chain.id === id);
export const lifiOrigin = 'https://li.quest';
export const hashPattern = /^0x[0-9a-f]{64}$/i;
export const addressPattern = /^0x[0-9a-f]{40}$/i;
export const matches = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();

export async function loadExchangeNetworks(fetcher = fetch) {
  const response = await fetcher(lifiOrigin + '/v1/chains?chainTypes=EVM', {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Could not load LI.FI networks. Try again.');
  const result = await response.json();
  if (!Array.isArray(result.chains)) throw new Error('LI.FI returned an invalid chain list.');
  const chains = new Map();
  for (const chain of exchangeChains) {
    const found = result.chains.find(entry => entry.id === chain.id && entry.chainType === 'EVM' && entry.mainnet === true
      && addressPattern.test(entry.diamondAddress) && !matches(entry.diamondAddress, '0x' + '0'.repeat(40)));
    if (found) {
      const logo = URL.canParse(found.logoURI) ? new URL(found.logoURI) : null;
      chains.set(chain.id, {
        chain,
        router: found.diamondAddress,
        name: typeof found.name === 'string' && found.name.trim() ? found.name.trim() : chain.name,
        iconUrl: logo?.protocol === 'https:' && !logo.username && !logo.password ? logo.href : null,
      });
    }
  }
  if (!chains.size) throw new Error('LI.FI returned no supported Termul mainnets.');
  return chains;
}

export function transactionLink(chainId, hash) {
  const chain = exchangeChain(chainId);
  if (!chain || !hashPattern.test(hash ?? '')) return null;
  return new URL('/tx/' + hash, chain.blockExplorers.default.url).href;
}

export const scanLink = hash => hashPattern.test(hash ?? '') ? 'https://scan.li.fi/tx/' + hash : null;

export function exchangeWidgetConfig(networks, providers, connect, onPrepared) {
  const ids = [...networks.keys()];
  const defaultChain = networks.has(arcChain.id) ? arcChain.id : ids[0];
  return {
    integrator: 'termul',
    appearance: 'dark',
    variant: 'compact',
    fromChain: defaultChain,
    toChain: networks.has(8453) ? 8453 : defaultChain,
    chains: { allow: ids },
    hiddenUI: { appearance: true, language: true, walletMenu: true, toAddress: true, history: true },
    defaultUI: { layout: 'cards', transactionDetailsExpanded: false },
    useGaslessRoutes: false,
    feeConfig: { name: 'Termul', fee: 0, showFeePercentage: true },
    walletConfig: { onConnect: connect },
    providers,
    storageScopeKey: 'termul-exchange',
    sdkConfig: {
      apiUrl: lifiOrigin + '/v1',
      rpcUrls: Object.fromEntries([...networks].map(([id, { chain }]) => [id, chain.rpcUrls.default.http])),
      routeOptions: { allowSwitchChain: false, allowDestinationCall: false },
      executionOptions: { updateTransactionRequestHook: onPrepared },
    },
    explorerUrls: Object.fromEntries([...networks].map(([id, { chain }]) =>
      [id, [{ url: chain.blockExplorers.default.url, txPath: 'tx', addressPath: 'address' }]])),
    theme: {
      container: { border: '1px solid var(--line)', borderRadius: '19px', minWidth: 0, maxWidth: '100%', width: '100%' },
      colorSchemes: {
        dark: {
          palette: {
            primary: { main: '#65e4d0' },
            secondary: { main: '#41c9b5' },
            background: { default: '#101520', paper: '#141a27' },
            text: { primary: '#f4f7fb', secondary: '#a8b5c8' },
            grey: { 200: '#dde5f0', 300: '#b7c4d7', 700: '#45546b', 800: '#293548' },
            error: { main: '#ff7a88' },
          },
        },
      },
      typography: { fontFamily: 'var(--font)' },
      shape: { borderRadius: 12, borderRadiusSecondary: 10 },
      components: {
        MuiButton: {
          styleOverrides: {
            root: { '&.Mui-focusVisible': { outline: '2px solid #65e4d0', outlineOffset: '2px' } },
            contained: {
              '&.MuiButton-colorPrimary:not(.Mui-disabled)': {
                color: '#080b13',
                '&:hover': { backgroundColor: '#41c9b5' },
              },
            },
          },
        },
      },
    },
  };
}
