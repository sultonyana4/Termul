import { getAddress, numberToHex } from 'viem';
import { arcChain } from './arc-network.js';

export async function assertWalletProvider(provider, account) {
  if (!provider?.request) throw new Error('The connected wallet provider is unavailable.');
  const [chainId, accounts] = await Promise.all([
    provider.request({ method: 'eth_chainId' }),
    provider.request({ method: 'eth_accounts' }),
  ]);
  if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId) || BigInt(chainId) !== BigInt(arcChain.id)) {
    throw new Error('Switch the connected wallet to Arc Mainnet.');
  }
  if (!Array.isArray(accounts) || !accounts[0] || getAddress(accounts[0]) !== getAddress(account)) {
    throw new Error('The connected wallet account changed.');
  }
}

export async function switchWalletToArc(provider, assertCurrent = () => {}) {
  const chainId = numberToHex(arcChain.id);
  const params = [{ chainId }];
  try {
    assertCurrent();
    await provider.request({ method: 'wallet_switchEthereumChain', params });
  } catch (error) {
    if (error?.code !== 4902 && error?.data?.originalError?.code !== 4902) throw error;
    assertCurrent();
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId, chainName: arcChain.name, nativeCurrency: arcChain.nativeCurrency,
        rpcUrls: arcChain.rpcUrls.default.http, blockExplorerUrls: [arcChain.blockExplorers.default.url] }],
    });
    assertCurrent();
    await provider.request({ method: 'wallet_switchEthereumChain', params });
  }
}

export function sameWallet(left, right) {
  return Boolean(left?.address && right?.address && left.address.toLowerCase() === right.address.toLowerCase()
    && left.chainId === right.chainId && left.connectorId === right.connectorId && left.revision === right.revision);
}
