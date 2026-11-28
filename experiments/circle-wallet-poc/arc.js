import { createPublicClient, formatUnits, http } from 'viem';

import { TERMUL_MAINNET } from '../../supabase/functions/_shared/termul-mainnet.js';

export const arcChainId = TERMUL_MAINNET.id;
export function createArcReadClient(fetchFn) {
  return createPublicClient({
    transport: http(TERMUL_MAINNET.rpcUrl, {
      timeout: 10_000, retryCount: 0, fetchFn,
      methods: { include: ['eth_chainId', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_estimateGas', 'eth_gasPrice',
        'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'] },
    }),
  });
}

const queues = [[], []];
let running = 0;
let backgroundRunning = false;
let nextBackground = 0;
let timer;
function drain() {
  if (running >= 2) return;
  const background = !queues[0].length;
  if (background && (backgroundRunning || !queues[1].length)) return;
  if (background && Date.now() < nextBackground) {
    timer ??= setTimeout(() => { timer = undefined; drain(); }, nextBackground - Date.now());
    return;
  }
  const job = queues[Number(background)].shift();
  running++;
  if (background) { backgroundRunning = true; nextBackground = Date.now() + 400; }
  void job.run().then(job.resolve, job.reject).finally(() => {
    running--;
    if (background) backgroundRunning = false;
    drain();
  });
  drain();
}
function scheduledFetch(lane) {
  return (url, options) => new Promise((resolve, reject) => {
    queues[lane].push({ resolve, reject, run: () => fetch(url, options) });
    drain();
  });
}
export const arcRpc = createArcReadClient(scheduledFetch(0));
export const arcHistoryRpc = createArcReadClient(scheduledFetch(1));

export async function readArcBalance(client, address) {
  const chainId = await client.getChainId();
  if (chainId !== arcChainId) throw new Error('Arc RPC returned an unexpected chain ID.');
  const balance = await client.getBalance({ address });
  return { chainId, balance: formatUnits(balance, 18) };
}
