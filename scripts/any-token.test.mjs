import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, keccak256 } from 'viem';
import { exchangeChain, exchangeChains, exchangeWidgetConfig, loadExchangeNetworks, scanLink, transactionLink } from '../src/any-token-networks.js';
import { switchWalletToChain } from '../src/wallet-provider.js';
import {
  createExchangeSender, exchangeLedger, preparedExchangeStep, reconcileExchange, reviewExchangeRoute, validateExchangeRequest,
} from '../src/any-token-transfers.js';

const ids = [5042, 1, 8453, 42161, 10, 137, 43114, 59144, 130, 480, 146, 1329, 50, 57073, 98866, 143, 2818, 81224];
assert.deepEqual(exchangeChains.map(chain => chain.id), ids);
for (const chain of exchangeChains) {
  assert.equal(Boolean(chain.testnet), false);
  assert.equal(new URL(chain.rpcUrls.default.http[0]).protocol, 'https:');
  assert.equal(new URL(chain.blockExplorers.default.url).protocol, 'https:');
}
const account = '0x' + '12'.repeat(20);
const outsider = '0x' + '56'.repeat(20);
const router = '0x' + '34'.repeat(20);
const hash = '0x' + 'aa'.repeat(32);
const destinationHash = '0x' + 'bb'.repeat(32);
const approvalHash = '0x' + 'cc'.repeat(32);
const tokenAddress = '0x3600000000000000000000000000000000000000';
const baseToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const token = (address, chainId) => ({ address, chainId, symbol: 'USDC', decimals: 6 });
const catalog = ids.slice(0, -1).map(id => ({
  id, diamondAddress: router, chainType: 'EVM', mainnet: true,
  ...(id === 5042 && { name: 'Arc', logoURI: 'https://example.com/arc.svg' }),
  ...(id === 8453 && { name: 'Base', logoURI: 'http://example.com/base.svg' }),
}));
const networks = await loadExchangeNetworks(async input => {
  assert.equal(input, 'https://li.quest/v1/chains?chainTypes=EVM');
  return Response.json({ chains: [...catalog, { id: 11155111, diamondAddress: router, chainType: 'EVM' }] });
});
assert.equal(networks.size, 17);
assert.equal(networks.has(81224), false);
assert.equal(networks.has(11155111), false);
assert.equal(networks.get(5042).name, 'Arc');
assert.equal(networks.get(5042).iconUrl, 'https://example.com/arc.svg');
assert.equal(networks.get(8453).iconUrl, null);
await assert.rejects(loadExchangeNetworks(async () => Response.json({ chains: [] })), /no supported/i);
await assert.rejects(loadExchangeNetworks(async () => new Response(null, { status: 503 })), /Could not load/i);
const config = exchangeWidgetConfig(networks, [], () => {}, value => value);
assert.equal(config.fromChain, 5042);
assert.equal(config.feeConfig.fee, 0);
assert.equal(config.integrator, 'termul');
assert.equal(config.chains.allow.length, 17);
assert.ok(!config.chains.allow.includes(81224));
assert.equal(config.theme.colorSchemes.dark.palette.primary.main, '#65e4d0');
assert.equal(config.theme.colorSchemes.dark.palette.background.default, '#101520');
assert.equal(config.useGaslessRoutes, false);
assert.equal(transactionLink(5042, hash), 'https://explorer.arc.io/tx/' + hash);
assert.equal(transactionLink(8453, hash), 'https://basescan.org/tx/' + hash);
assert.equal(transactionLink(1, hash), 'https://etherscan.io/tx/' + hash);
assert.equal(transactionLink(11155111, hash), null);
assert.equal(scanLink(hash), 'https://scan.li.fi/tx/' + hash);
assert.equal(scanLink('https://example.invalid'), null);
const switches = [];
await switchWalletToChain({ request: async call => {
  switches.push(call);
  if (switches.length === 1) throw Object.assign(new Error('Unknown network'), { code: 4902 });
} }, exchangeChain(8453));
assert.deepEqual(switches.map(call => call.method), ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
assert.equal(switches[1].params[0].chainId, '0x2105');
assert.deepEqual(switches[1].params[0].rpcUrls, exchangeChain(8453).rpcUrls.default.http);

const selection = { address: account, chainId: 5042, connectorId: 'injected', revision: 1 };
const prepared = { from: account, to: router, chainId: 5042, value: '0x0', data: '0x77777777' };
function routeFixture(toChain = 8453) {
  const action = { fromAddress: account, toAddress: account, fromChainId: 5042, toChainId: toChain,
    fromToken: token(tokenAddress, 5042), toToken: token(toChain === 5042 ? outsider : baseToken, toChain), fromAmount: '10000000' };
  return { id: 'route', steps: [{
    id: 'step', type: 'lifi', tool: 'across', action,
    estimate: { toAmountMin: '9800000', approvalAddress: router, feeCosts: [] },
    transactionRequest: prepared,
  }] };
}
const route = routeFixture();
const plan = reviewExchangeRoute(route, selection, networks);
assert.equal(preparedExchangeStep(plan, route, selection, networks), prepared);
assert.equal(validateExchangeRequest(plan, prepared, prepared, selection).kind, 'source');
assert.throws(() => validateExchangeRequest(plan, undefined, prepared, selection), /matching prepared/);
assert.throws(() => validateExchangeRequest(plan, prepared, { ...prepared, data: '0x88888888' }, selection), /matching prepared/);
assert.throws(() => validateExchangeRequest(plan, prepared, { ...prepared, value: '0x1' }, selection), /matching prepared/);
const excessiveNativeValue = { ...prepared, value: '0x1' };
assert.throws(() => validateExchangeRequest(plan, excessiveNativeValue, excessiveNativeValue, selection), /matching prepared/);
assert.throws(() => validateExchangeRequest(plan, prepared, prepared, { ...selection, chainId: 8453 }), /wallet changed/);
assert.throws(() => validateExchangeRequest(plan, prepared, prepared, selection, plan.expires + 1), /fresh route/);
assert.throws(() => reviewExchangeRoute(routeFixture(81224), selection, networks), /supported LI.FI/);
for (const change of [
  step => { step.action.toAddress = outsider; },
  step => { step.estimate.approvalAddress = outsider; },
  step => { step.estimate.feeCosts.push({ feeSplit: { integratorFee: '1' } }); },
  step => { step.includedSteps = [{ type: 'custom', action: step.action }]; },
]) {
  const updated = structuredClone(route);
  change(updated.steps[0]);
  assert.throws(() => reviewExchangeRoute(updated, selection, networks));
}
const wrongMinimum = structuredClone(route);
wrongMinimum.steps[0].estimate.toAmountMin = '9700000';
assert.throws(() => preparedExchangeStep(plan, wrongMinimum, selection, networks), /changed this route/);
const nativeFeeRoute = structuredClone(route);
nativeFeeRoute.steps[0].estimate.feeCosts.push({ included: false, amount: '1', token: token('0x' + '0'.repeat(40), 5042) });
const nativeFeePlan = reviewExchangeRoute(nativeFeeRoute, selection, networks);
assert.equal(validateExchangeRequest(nativeFeePlan, excessiveNativeValue, excessiveNativeValue, selection).value, 1n);
assert.throws(() => preparedExchangeStep(plan, nativeFeeRoute, selection, networks), /changed this route/);

const allowanceCall = (spender, amount) => ({ from: account, to: tokenAddress, chainId: 5042,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });
const approve = allowanceCall(router, 10_000_000n);
assert.equal(validateExchangeRequest(plan, prepared, approve, selection).kind, 'approval');
assert.throws(() => validateExchangeRequest(plan, prepared, allowanceCall(outsider, 10_000_000n), selection));
assert.throws(() => validateExchangeRequest(plan, prepared, allowanceCall(router, 2n ** 256n - 1n), selection));

function receipt(txHash, status = 'success', logs = []) { return { transactionHash: txHash, status, logs }; }
function transferLog(token, to = account, amount = 9_900_000n, from = router) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  };
}
function recordFor(plan, tx = prepared, txHash = hash) {
  return { ...plan, target: tx.to, dataHash: keccak256(tx.data), value: '0', kind: tx === approve ? 'approval' : 'source',
    hash: txHash, stage: 'submitted', approvals: [] };
}
function statusFixture(plan, txHash = destinationHash) {
  return { status: 'DONE', substatus: 'COMPLETED', fromAddress: account, toAddress: account,
    sending: { txHash: hash, chainId: plan.fromChain, token: plan.fromToken, amount: plan.amount },
    receiving: { txHash, chainId: plan.toChain, token: plan.toToken, amount: '9900000' },
  };
}
const sourceDebit = transferLog(tokenAddress, router, 10_000_000n, account);
function chainMock({ sourceStatus = 'success', destStatus = 'success', sourceLogs = [sourceDebit], destLogs = [transferLog(baseToken)] } = {}) {
  return id => ({
    getChainId: async () => id,
    getTransactionReceipt: async ({ hash: h }) => h === approvalHash ? receipt(h) :
      id === 5042 ? receipt(h, sourceStatus, sourceLogs) : receipt(h, destStatus, destLogs),
    getTransaction: async ({ hash: h }) => ({ hash: h, from: account, to: h === approvalHash ? approve.to : router,
      input: h === approvalHash ? approve.data : prepared.data, value: 0n }),
  });
}
const fetchStatus = (plan, payload = statusFixture(plan)) => async input => {
  const url = new URL(input);
  assert.equal(url.pathname, '/v1/status');
  assert.equal(url.searchParams.get('fromChain'), '5042');
  assert.equal(url.searchParams.get('toChain'), String(plan.toChain));
  assert.equal(url.searchParams.get('txHash'), hash);
  return Response.json(payload);
};
const record = recordFor(plan);
assert.equal((await reconcileExchange(record, chainMock(), async () => new Response(null, { status: 404 }))).stage, 'source-confirmed');
assert.equal((await reconcileExchange(record, chainMock({ destStatus: 'reverted' }), fetchStatus(plan))).stage, 'processing');
assert.equal((await reconcileExchange(record, chainMock({ destLogs: [transferLog(baseToken, outsider)] }), fetchStatus(plan))).stage, 'processing');
assert.deepEqual(await reconcileExchange(record, chainMock(), fetchStatus(plan)),
  { stage: 'completed', received: '9900000', sent: '10000000', destinationHash });
for (const [status, substatus, stage] of [['DONE', 'REFUNDED', 'refunded'], ['FAILED', 'UNKNOWN_ERROR', 'failed'], ['DONE', 'PARTIAL', 'partial']]) {
  assert.equal((await reconcileExchange(record, chainMock(), fetchStatus(plan, { ...statusFixture(plan), status, substatus }))).stage, stage);
}
assert.equal((await reconcileExchange(record, chainMock({ sourceStatus: 'reverted' }), fetchStatus(plan))).stage, 'reverted');
assert.equal((await reconcileExchange(recordFor(plan, approve, approvalHash), chainMock(), () => assert.fail())).stage, 'approval-only');
const samePlan = reviewExchangeRoute(routeFixture(5042), selection, networks);
let sameStatusCalls = 0;
const sameSettlement = await reconcileExchange(recordFor(samePlan), chainMock({ sourceLogs: [sourceDebit, transferLog(outsider)] }),
  () => { sameStatusCalls++; return new Response(null, { status: 404 }); });
assert.equal(sameSettlement.stage, 'completed');
assert.equal(sameStatusCalls, 0);

function harness(options = {}) {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const ledger = exchangeLedger(storage);
  const methods = [];
  let selected = selection;
  const wallet = {
    getSelection: () => selected,
    getProvider: async () => ({ request: async ({ method }) => {
      assert.ok(['eth_chainId', 'eth_accounts'].includes(method));
      return method === 'eth_chainId' ? '0x13b2' : [account];
    } }),
  };
  const chainClient = id => ({
    ...chainMock()(id),
    getBalance: async () => options.hasGas === false ? 0n : 10n ** 18n,
    estimateGas: async () => 50_000n,
    getGasPrice: async () => 20_000_000_000n,
    readContract: async () => options.hasTokens === false ? 0n : 10_000_000n,
  });
  const send = createExchangeSender({ wallet, chainClient, ledger, active: () => options.inactive !== true });
  const signer = async tx => {
    methods.push(tx);
    await options.pause;
    if (options.reject) throw Object.assign(new Error('Declined'), { code: 4001 });
    if (options.unknown) throw new Error('Wallet state unavailable.');
    return tx.to === tokenAddress ? approvalHash : hash;
  };
  return { ledger, methods, send: tx => send(plan, prepared, tx, signer), restored: exchangeLedger(storage),
    changeAccount: () => { selected = { ...selection, address: outsider }; } };
}
const h = harness();
assert.equal(await h.send(approve), approvalHash);
assert.equal(h.restored.get(account).stage, 'submitted');
assert.equal(h.restored.get(outsider), null);
assert.equal(await h.send(prepared), hash);
assert.equal(h.restored.get(account).approvals[0].hash, approvalHash);
await assert.rejects(h.send(prepared), /earlier exchange/);
assert.equal(h.methods.length, 2);
for (const options of [{ hasGas: false }, { hasTokens: false }, { inactive: true }]) {
  const trial = harness(options);
  await assert.rejects(trial.send(prepared));
  assert.equal(trial.methods.length, 0);
}
const rejection = harness({ reject: true });
await assert.rejects(rejection.send(prepared), /declined/i);
assert.equal(rejection.restored.get(account).stage, 'rejected');
const uncertain = harness({ unknown: true });
await assert.rejects(uncertain.send(prepared), /unavailable/i);
assert.equal(uncertain.restored.get(account).stage, 'unknown');
assert.equal(uncertain.restored.get(account).hash, null);
await assert.rejects(uncertain.send(prepared), /earlier exchange/);
const changed = harness();
changed.changeAccount();
await assert.rejects(changed.send(prepared), /wallet changed/);
assert.equal(changed.methods.length, 0);
let release;
const duplicate = harness({ pause: new Promise(resolve => { release = resolve; }) });
const first = duplicate.send(prepared);
await assert.rejects(duplicate.send(prepared), /already open/);
release();
await first;
assert.equal(duplicate.methods.length, 1);
console.log('Any Token mainnets, wallet guards, exact approvals, quote expiry, fees, source and destination receipts, refund handling and refresh recovery passed.');
