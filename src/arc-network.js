import { defineChain, keccak256 } from 'viem';
import { TERMUL_MAINNET } from '../supabase/functions/_shared/termul-mainnet.js';
import { checkArcDeployment } from './arc-read.js';

export const arcChain = defineChain({
  id: TERMUL_MAINNET.id,
  name: TERMUL_MAINNET.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [TERMUL_MAINNET.rpcUrl] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: TERMUL_MAINNET.explorerUrl } },
});

export function resolveArcNetwork(env = {}) {
  const expected = {
    VITE_TERMUL_NETWORK: 'mainnet',
    VITE_TERMUL_MAINNET_CONTRACT_ADDRESS: TERMUL_MAINNET.contractAddress,
    VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK: String(TERMUL_MAINNET.deploymentBlock),
    VITE_TERMUL_MAINNET_RUNTIME_HASH: TERMUL_MAINNET.runtimeHash,
    VITE_TERMUL_MAINNET_RPC_URL: TERMUL_MAINNET.rpcUrl,
  };
  const mismatch = Object.entries(expected).find(([name, value]) => {
    if (env[name] === undefined) return false;
    const supplied = String(env[name]).toLowerCase();
    return supplied !== value && !(name === 'VITE_TERMUL_MAINNET_RPC_URL' && supplied === value + '/');
  });
  return Object.freeze({
    ...TERMUL_MAINNET,
    chain: arcChain,
    error: mismatch ? `Invalid ${mismatch[0]} for the verified Arc Mainnet deployment.` : null,
  });
}

export async function verifyInvoiceDeployment(client, network) {
  if (network.error) throw new Error(network.error);
  const status = await checkArcDeployment(client, network, code => /^0x(?:[0-9a-f]{2})+$/i.test(code ?? '') ? keccak256(code) : null);
  if (status === 'wrong-chain') throw new Error('The RPC returned the wrong Arc Mainnet chain ID.');
  if (status === 'current-mismatch') throw new Error('The latest TermulInvoices runtime bytecode does not match the verified deployment.');
  if (status !== 'verified') throw new Error('TermulInvoices bytecode does not match the verified deployment block.');
}

export function validatePaymentLinkNetwork(params, network) {
  if (network.error) throw new Error(network.error);
  const chainIds = params.getAll('chainId');
  const contracts = params.getAll('contract');
  if (chainIds.length !== 1 || contracts.length !== 1 || chainIds[0] !== String(network.chain.id)
    || contracts[0].toLowerCase() !== network.contractAddress) {
    throw new Error('This payment link does not identify the verified Arc Mainnet contract.');
  }
}

export const arcNetwork = resolveArcNetwork(typeof import.meta.env === 'undefined' ? undefined : {
  VITE_TERMUL_NETWORK: import.meta.env.VITE_TERMUL_NETWORK,
  VITE_TERMUL_MAINNET_CONTRACT_ADDRESS: import.meta.env.VITE_TERMUL_MAINNET_CONTRACT_ADDRESS,
  VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK: import.meta.env.VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK,
  VITE_TERMUL_MAINNET_RUNTIME_HASH: import.meta.env.VITE_TERMUL_MAINNET_RUNTIME_HASH,
  VITE_TERMUL_MAINNET_RPC_URL: import.meta.env.VITE_TERMUL_MAINNET_RPC_URL,
});
