const nativeCurrency = Object.freeze({ name: 'USDC', symbol: 'USDC', decimals: 18 });

export const ARC_TESTNET = Object.freeze({
  id: 5042002,
  name: 'Arc Testnet',
  rpcUrl: 'https://rpc.blockdaemon.testnet.arc.io',
  explorerUrl: 'https://explorer.testnet.arc.io',
  nativeCurrency,
  contractAddress: '0x0cc3b91fc603ef15d80b3c0e8db222e5988b8926',
  deploymentBlock: '71546111',
  testnet: true,
});

export const ARC_MAINNET = Object.freeze({
  id: 5042,
  name: 'Arc Mainnet',
  rpcUrl: 'https://rpc.mainnet.arc.io',
  explorerUrl: 'https://explorer.arc.io',
  nativeCurrency,
  contractAddress: null,
  deploymentBlock: null,
  testnet: false,
});

export function validateMainnetAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)
    || /^0x0{40}$/i.test(value) || value.toLowerCase() === ARC_TESTNET.contractAddress) {
    throw new Error('Configure a distinct, nonzero TermulInvoices address for Arc Mainnet.');
  }
  return value.toLowerCase();
}
