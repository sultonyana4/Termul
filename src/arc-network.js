import { defineChain, isAddress, keccak256 } from 'viem';
import { ARC_MAINNET, ARC_TESTNET, validateMainnetAddress } from '../supabase/functions/_shared/arc-networks.js';

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error('Use a public HTTPS endpoint without credentials, query parameters, or fragments.');
  }
  return url.href;
}

export function resolveArcNetwork(env = {}) {
  const mode = env.VITE_TERMUL_NETWORK ?? 'testnet';
  const base = mode === 'mainnet' ? ARC_MAINNET : mode === 'testnet' ? ARC_TESTNET : null;
  let rpcUrl = base?.rpcUrl || null;
  let contractAddress = null;
  let deploymentBlock = null;
  let runtimeHash = null;
  let metadataUrl = null;
  let error = null;
  try {
    if (!base) throw new Error('Set VITE_TERMUL_NETWORK to testnet or mainnet.');
    const mainnet = !base.testnet;
    rpcUrl = httpsUrl((mainnet ? env.VITE_TERMUL_MAINNET_RPC_URL : env.VITE_ARUSPAY_BROWSER_RPC_URL) || base.rpcUrl);
    if (mainnet) {
      const configuredAddress = env.VITE_TERMUL_MAINNET_CONTRACT_ADDRESS;
      contractAddress = validateMainnetAddress(configuredAddress);
      if (!isAddress(configuredAddress)) throw new Error('The configured TermulInvoices address has an invalid checksum.');
    } else {
      contractAddress = base.contractAddress;
    }
    const block = mainnet ? env.VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK : env.VITE_ARUSPAY_DEPLOYMENT_BLOCK || base.deploymentBlock;
    if (typeof block !== 'string' || !/^[1-9]\d{0,19}$/.test(block) || BigInt(block) > (1n << 64n) - 1n) {
      throw new Error(`Configure a valid ${base.name} deployment block.`);
    }
    deploymentBlock = BigInt(block);
    if (mainnet) {
      runtimeHash = env.VITE_TERMUL_MAINNET_RUNTIME_HASH;
      if (typeof runtimeHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(runtimeHash) || /^0x0{64}$/i.test(runtimeHash)) {
        throw new Error('Configure the reviewed TermulInvoices runtime bytecode hash.');
      }
      if (!env.VITE_TERMUL_MAINNET_API_URL) throw new Error('Configure the reviewed Arc Mainnet metadata endpoint.');
      metadataUrl = httpsUrl(env.VITE_TERMUL_MAINNET_API_URL);
    }
  } catch (cause) {
    error = cause.message;
    contractAddress = null;
    deploymentBlock = null;
    runtimeHash = null;
    metadataUrl = null;
  }
  const name = base?.name || 'Arc network unavailable';
  const chain = base && defineChain({
    id: base.id,
    name,
    nativeCurrency: base.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: `${name} Explorer`, url: base.explorerUrl } },
    testnet: base.testnet,
  });
  return Object.freeze({ chain, name, rpcUrl, explorerUrl: base?.explorerUrl, contractAddress,
    deploymentBlock, runtimeHash, metadataUrl, error });
}

export async function verifyInvoiceDeployment(client, network) {
  if (network.error || !network.chain || !network.contractAddress || network.deploymentBlock === null) {
    throw new Error(network.error || 'Invoice deployment is not configured.');
  }
  if (await client.getChainId() !== network.chain.id) {
    throw new Error(`The RPC endpoint did not return the ${network.name} chain ID.`);
  }
  const address = network.contractAddress;
  const bytecode = await client.getCode({ address });
  if (!bytecode || !/^0x(?:[0-9a-f]{2})+$/i.test(bytecode)) {
    throw new Error(`No invoice contract bytecode was found on ${network.name}.`);
  }
  if (!network.chain.testnet) {
    const expected = network.runtimeHash.toLowerCase();
    if (keccak256(bytecode) !== expected) throw new Error('TermulInvoices runtime bytecode does not match the reviewed build.');
    const [atDeployment, beforeDeployment] = await Promise.all([
      client.getCode({ address, blockNumber: network.deploymentBlock }),
      client.getCode({ address, blockNumber: network.deploymentBlock - 1n }),
    ]);
    if (!atDeployment || !/^0x(?:[0-9a-f]{2})+$/i.test(atDeployment) || keccak256(atDeployment) !== expected || (beforeDeployment !== undefined && beforeDeployment !== '0x')) {
      throw new Error('TermulInvoices bytecode does not match the configured deployment block.');
    }
  }
}

export function validatePaymentLinkNetwork(params, network) {
  if (network.error || !network.contractAddress) throw new Error(network.error || 'Invoice deployment is unavailable.');
  const chainIds = params.getAll('chainId');
  const contracts = params.getAll('contract');
  if (chainIds.length === 0 && contracts.length === 0 && network.chain.testnet) return;
  if (chainIds.length !== 1 || contracts.length !== 1 || chainIds[0] !== String(network.chain.id)
    || contracts[0].toLowerCase() !== network.contractAddress.toLowerCase()) {
    throw new Error(`This payment link does not belong to the invoice deployment configured on this site (${network.name}).`);
  }
}

export const arcNetwork = resolveArcNetwork(import.meta.env);
