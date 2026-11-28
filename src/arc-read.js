export function arcReadFailure(error) {
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
    if (cause.code === -32012 || /requested range too large|max(?:imum)? block range/i.test(cause.details ?? '')) return 'range';
    if (cause.status === 429 || cause.code === -32005 || cause.name === 'LimitExceededRpcError') return 'rate-limit';
    if (cause.status >= 500 || ['TimeoutError', 'HttpRequestError', 'AbortError'].includes(cause.name)) return 'transport';
  }
  return null;
}

export async function readArc(request, { active = () => true, delay = 800 } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (!active()) throw new Error('The wallet or sync request changed.');
    try { return await request(); }
    catch (error) {
      if (attempt >= 3 || !['rate-limit', 'transport'].includes(arcReadFailure(error))) throw error;
      let retryAfter;
      for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
        const value = cause.headers?.get?.('retry-after');
        if (value) { retryAfter = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now(); break; }
      }
      if (retryAfter > 8000) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.max(delay * 2 ** attempt, retryAfter || 0)));
    }
  }
}

const deploymentReads = new WeakMap();
const deploymentStores = new WeakMap();
export const deploymentKey = network => [network.rpcUrl, network.id, network.contractAddress, network.deploymentBlock, network.runtimeHash].join(':');

export function setArcDeploymentStore(client, store) { deploymentStores.set(client, store); }

export function checkArcDeployment(client, network, hashCode) {
  const key = deploymentKey(network);
  if (!deploymentReads.has(client)) deploymentReads.set(client, new Map());
  const states = deploymentReads.get(client);
  const state = states.get(key) ?? {};
  states.set(key, state);
  if (state.pending) return state.pending;
  const address = network.contractAddress;
  const pending = (async () => {
    if (await readArcStage('chain ID', () => client.getChainId()) !== network.id) return 'wrong-chain';
    const latest = await readArcStage('current contract bytecode', () => client.getCode({ address }));
    if (hashCode(latest) !== network.runtimeHash) return 'current-mismatch';
    const store = deploymentStores.get(client);
    if (state.verified || store?.hasDeployment(key)) return 'verified';
    const historical = await readArcStage('deployment-block bytecode', () => client.getCode({ address, blockNumber: network.deploymentBlock }));
    const previous = await readArcStage('pre-deployment bytecode', () => client.getCode({ address, blockNumber: network.deploymentBlock - 1n }));
    if (hashCode(historical) !== network.runtimeHash || (previous !== '0x' && previous !== undefined)) return 'historical-mismatch';
    store?.saveDeployment(key);
    state.verified = true;
    return 'verified';
  })();
  state.pending = pending;
  const clear = () => { if (state.pending === pending) state.pending = null; };
  void pending.then(clear, clear);
  return pending;
}

export function describeArcReadFailure(error) {
  return arcReadFailure(error) === 'rate-limit' ? 'Arc RPC is rate-limiting requests.' : 'Arc RPC could not complete the read.';
}

export async function readArcStage(stage, request) {
  try { return await readArc(request); }
  catch (cause) {
    throw Object.assign(new Error(`${describeArcReadFailure(cause)} Could not check ${stage}. Try again.`, { cause }), { code: 'ARC_DEPLOYMENT_RPC' });
  }
}
