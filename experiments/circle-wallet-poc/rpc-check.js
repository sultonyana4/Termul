import { isAddress, zeroAddress } from 'viem';
import { arcRpc, readArcBalance } from './arc.js';

const address = process.argv[2] ?? zeroAddress;
if (!isAddress(address)) throw new Error('Supply a valid public EVM address.');
try {
  const result = await readArcBalance(arcRpc, address);
  console.log(`Arc chain ID ${result.chainId}, native USDC balance ${result.balance}`);
} catch {
  console.error('Arc Mainnet read-only RPC check failed.');
  process.exitCode = 1;
}
