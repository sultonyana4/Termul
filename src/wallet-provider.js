import { getAddress, numberToHex } from 'viem';
import { arcChain } from './arc-network.js';

export async function assertWalletProvider(provider, account) {
  return assertProviderChain(provider, account, arcChain.id);
}

export async function assertProviderChain(provider, account, expectedChain) {
  if (!provider?.request) throw new Error('The connected wallet provider is unavailable.');
  const [chainId, accounts] = await Promise.all([
    provider.request({ method: 'eth_chainId' }),
    provider.request({ method: 'eth_accounts' }),
  ]);
  if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId) || BigInt(chainId) !== BigInt(expectedChain)) {
    throw new Error(expectedChain === arcChain.id ? 'Switch the connected wallet to Arc Mainnet.' : 'Switch the wallet to the reviewed source network.');
  }
  if (!Array.isArray(accounts) || !accounts[0] || getAddress(accounts[0]) !== getAddress(account)) {
    throw new Error('The connected wallet account changed.');
  }
}

export async function switchWalletToArc(provider, assertCurrent = () => {}) {
  return switchWalletToChain(provider, arcChain, assertCurrent);
}

export async function switchWalletToChain(provider, chain, assertCurrent = () => {}) {
  const chainId = numberToHex(chain.id);
  const params = [{ chainId }];
  try {
    assertCurrent();
    await provider.request({ method: 'wallet_switchEthereumChain', params });
  } catch (error) {
    if (error?.code !== 4902 && error?.data?.originalError?.code !== 4902) throw error;
    assertCurrent();
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId, chainName: chain.name, nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [chain.blockExplorers.default.url] }],
    });
    assertCurrent();
    await provider.request({ method: 'wallet_switchEthereumChain', params });
  }
}

export function sameWallet(left, right) {
  return Boolean(left?.address && right?.address && left.address.toLowerCase() === right.address.toLowerCase()
    && left.chainId === right.chainId && left.connectorId === right.connectorId && left.revision === right.revision);
}
