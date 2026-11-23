import { TERMUL_MAINNET as network } from '../_shared/termul-mainnet.js';

export function createEOAVerifier({ client, recoverMessageAddress }) {
  return async (wallet, message, signature) => {
    if (await client.getChainId() !== network.id) return false;
    const code = await client.getCode({ address: wallet });
    if (code !== undefined && code !== '0x') return false;
    try {
      return (await recoverMessageAddress({ message, signature })).toLowerCase() === wallet;
    } catch {
      return false;
    }
  };
}
