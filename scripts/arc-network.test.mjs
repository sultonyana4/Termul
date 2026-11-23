import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, numberToHex, parseAbi } from 'viem';
import { arcNetwork, resolveArcNetwork, validatePaymentLinkNetwork, verifyInvoiceDeployment } from '../src/arc-network.js';

const { contractAddress: address, deploymentBlock: block } = arcNetwork;
const merchant = '0x' + '34'.repeat(20);
const payer = '0x' + '56'.repeat(20);
const id = '0x' + '78'.repeat(32);
const hash = '0x' + '9a'.repeat(32);
const attemptId = 'abcdef01-2345-6789-0123-456789abcdef';
const amount = 1000000000000000001n;
const fixtureCode = '0x60006000';
const wallet = { address: payer, chainId: 5042, connectorId: 'fixture' };
const linked = new URLSearchParams({ merchant, invoiceId: id });
const tagged = new URLSearchParams({ ...Object.fromEntries(linked), chainId: '5042', contract: address });
assert.equal(arcNetwork.id, 5042);
assert.equal(block, 32700130n);
assert.equal(arcNetwork.rpcUrl, 'https://rpc.mainnet.arc.io');
assert.equal(arcNetwork.contractAddress, '0x62209ab89631492e7943ef21baee792d430f5d0e');
assert.equal(arcNetwork.chain.nativeCurrency.decimals, 18);
for (const env of [
  { VITE_TERMUL_NETWORK: 'unsupported' },
  { VITE_TERMUL_MAINNET_CONTRACT_ADDRESS: payer },
  { VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK: '1' },
  { VITE_TERMUL_MAINNET_RPC_URL: 'https://other.test' },
  { VITE_TERMUL_MAINNET_RUNTIME_HASH: '0x1234' },
]) assert.match(resolveArcNetwork(env).error, /Invalid/);
assert.doesNotThrow(() => validatePaymentLinkNetwork(tagged, arcNetwork));
assert.throws(() => validatePaymentLinkNetwork(linked, arcNetwork), /verified Arc Mainnet/);
assert.throws(() => validatePaymentLinkNetwork(new URLSearchParams({ ...Object.fromEntries(tagged), contract: payer }), arcNetwork), /verified Arc Mainnet/);
const fixtureNetwork = { ...arcNetwork, runtimeHash: keccak256(fixtureCode) };
const fixtureClient = { getChainId: async () => 5042,
  getCode: async ({ address: account, blockNumber }) => {
    assert.equal(account, address);
    return blockNumber === block - 1n ? undefined : fixtureCode;
  },
};
await verifyInvoiceDeployment(fixtureClient, fixtureNetwork);
await assert.rejects(verifyInvoiceDeployment({ ...fixtureClient, getCode: async () => fixtureCode }, fixtureNetwork), /deployment block/);
await assert.rejects(verifyInvoiceDeployment(fixtureClient, arcNetwork), /runtime bytecode/);

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../supabase/functions/_shared/termul-mainnet.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const abi = parseAbi([
  'function getInvoice(address merchant, bytes32 id) view returns ((address merchant, uint256 amount, uint64 expiresAt, uint8 status))',
  'function payInvoice(address merchant, bytes32 id) payable',
  'event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount)',
]);
const data = encodeFunctionData({ abi, functionName: 'payInvoice', args: [merchant, id] });
const invoiceResult = status => encodeFunctionResult({ abi, functionName: 'getInvoice', result: { merchant, amount, expiresAt: 0n, status } });
const paidLog = {
  address, blockNumber: numberToHex(block), transactionHash: hash, logIndex: '0x0', transactionIndex: '0x0', removed: false,
  topics: encodeEventTopics({ abi, eventName: 'InvoicePaid', args: { invoiceId: id, merchant, payer } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
};
const transaction = { from: payer, to: address, input: data, value: numberToHex(amount),
  chainId: '0x13b2', type: '0x2', hash, blockNumber: numberToHex(block) };

async function runFrontend(options, exercise) {
  const { env = {}, params = tagged, rpcChain = 5042, walletAccount = payer, walletChain = 5042,
    balance = 2n * amount, code = fixtureCode, offlineMetadata = false, onWalletSend } = options;
  const { outputFiles } = await build({
    entryPoints: ['src/arc-invoices.js'], absWorkingDir: new URL('..', import.meta.url).pathname,
    bundle: true, write: false, platform: 'node', packages: 'external', format: 'cjs',
    define: { 'import.meta.env': JSON.stringify(env) },
    plugins: [{ name: 'fixture-runtime', setup(build) {
      build.onLoad({ filter: /termul-mainnet\.js$/ }, () => ({ contents: source.replace(arcNetwork.runtimeHash, fixtureNetwork.runtimeHash) }));
    } }],
  });
  const { window } = new JSDOM(html, { url: 'https://termul.xyz/?' + params, runScripts: 'outside-only' });
  globalThis.window = window;
  globalThis.document = window.document;
  window.eval(window.document.querySelector('script:not([src])').textContent);
  const rpcMethods = [];
  const walletMethods = [];
  const actions = [];
  let selected = null;
  let paid = options.paid || false;
  let recovery = options.recovery || null;
  const provider = { request: async ({ method, params }) => {
    walletMethods.push(method);
    if (method === 'eth_chainId') return numberToHex(walletChain);
    if (method === 'eth_accounts') return [walletAccount];
    if (method === 'eth_sendTransaction' && onWalletSend) {
      await onWalletSend(params[0], window);
      paid = true;
      return hash;
    }
    assert.fail('Unexpected wallet operation: ' + method);
  } };
  window.termulWallet = {
    connect: () => walletMethods.push('connect'),
    getSelection: () => selected,
    getProvider: async () => provider,
    session: {
      isAuthenticated: () => Boolean(selected),
      authenticate: async () => {},
      request: async (action, body) => {
        if (!selected) throw new Error('No session');
        assert.equal(body.chainId, 5042);
        assert.equal(body.contractAddress, address);
        actions.push(action);
        if (offlineMetadata) throw new Error('Recovery service offline');
        if (action === 'get_payment_attempt') return { attempt: recovery };
        if (action === 'reserve_payment_attempt') {
          assert.equal(recovery, null);
          recovery = { attempt_id: attemptId, payer_address: payer, tx_hash: null };
          if (options.changeProviderAtReservation) selected = { ...wallet, connectorId: 'replacement' };
          return { attemptId };
        }
        if (action === 'save_payment_attempt') recovery.tx_hash = body.transactionHash;
        if (action === 'clear_payment_attempt') recovery = null;
        return {};
      },
    },
  };
  function changeSelection(selection = wallet) {
    selected = selection;
    window.termulConnectionChanged(selection);
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(request.url, 'https://rpc.mainnet.arc.io/');
    const body = await request.json();
    rpcMethods.push(body.method);
    const result = {
      eth_chainId: numberToHex(rpcChain),
      eth_getCode: body.params?.[1] === numberToHex(block - 1n) ? '0x' : code,
      eth_call: invoiceResult(paid ? 2 : 1),
      eth_blockNumber: numberToHex(block),
      eth_getLogs: paid && body.params?.[0]?.topics?.[0] === paidLog.topics[0] ? [paidLog] : [],
      eth_getTransactionByHash: paid ? transaction : null,
      eth_getTransactionReceipt: paid ? { blockNumber: numberToHex(block), transactionHash: hash, status: '0x1', logs: [paidLog] } : null,
      eth_estimateGas: '0x10000',
      eth_getBlockByNumber: { baseFeePerGas: '0x4a817c800', transactions: [] },
      eth_maxPriorityFeePerGas: '0x0',
      eth_getBalance: numberToHex(balance),
      eth_getTransactionCount: '0x7',
    }[body.method];
    assert.notEqual(result, undefined, 'Unexpected RPC operation: ' + body.method);
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  try {
    const module = { exports: {} };
    new Function('require', 'module', 'exports', outputFiles[0].text)(require, module, module.exports);
    await exercise({
      window, $: selector => window.document.querySelector(selector), rpcMethods, walletMethods, actions,
      connect: changeSelection,
    });
  } finally {
    await new Promise(resolve => setTimeout(resolve, 25));
    window.close();
    globalThis.fetch = originalFetch;
    delete globalThis.window;
    delete globalThis.document;
  }
}

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Frontend fixture timed out.');
}
const ready = ($) => waitFor(() => $('#pay-onchain')?.textContent === 'Pay invoice on Arc Mainnet' && !$('#pay-onchain').disabled);

await runFrontend({ env: { VITE_TERMUL_NETWORK: 'unsupported' } }, async ({ window, $, rpcMethods, walletMethods }) => {
  assert.match($('#payment-view').textContent, /Invalid VITE_TERMUL_NETWORK/);
  assert.equal($('#invoice-form [type=submit]').disabled, true);
  await window.arusPayCreateInvoice();
  assert.deepEqual(rpcMethods, []);
  assert.deepEqual(walletMethods, []);
});
for (const [rpcChain, code, message] of [
  [1, fixtureCode, /wrong Arc Mainnet chain/],
  [5042, '0x', /runtime bytecode/],
]) {
  await runFrontend({ rpcChain, code }, async ({ $, rpcMethods, walletMethods }) => {
    await waitFor(() => message.test($('#payment-view').textContent));
    assert.equal($('#pay-onchain'), null);
    assert.ok(!rpcMethods.includes('eth_call'));
    assert.deepEqual(walletMethods, []);
  });
}
await runFrontend({ walletChain: 1 }, async ({ $, connect, walletMethods }) => {
  connect({ ...wallet, chainId: 1 });
  await waitFor(() => $('#pay-onchain')?.textContent === 'Wallet unavailable');
  $('#pay-onchain').click();
  assert.deepEqual(walletMethods, []);
});
await runFrontend({ walletAccount: merchant }, async ({ $, connect, walletMethods }) => {
  connect();
  await waitFor(() => /wallet account changed/i.test($('#payment-view').textContent));
  assert.ok(!walletMethods.includes('eth_sendTransaction'));
});
await runFrontend({ balance: amount }, async ({ $, connect, walletMethods, actions }) => {
  connect();
  await ready($);
  $('#pay-onchain').click();
  await waitFor(() => /Insufficient native USDC/.test($('#toast-text').textContent));
  assert.ok(!actions.includes('reserve_payment_attempt'));
  assert.ok(!walletMethods.includes('eth_sendTransaction'));
});
await runFrontend({ offlineMetadata: true }, async ({ $, connect, walletMethods }) => {
  connect();
  await ready($);
  $('#pay-onchain').click();
  await waitFor(() => /Recovery service offline/.test($('#toast-text').textContent));
  assert.ok(!walletMethods.includes('eth_sendTransaction'));
});
await runFrontend({ paid: true }, async ({ $, walletMethods }) => {
  await waitFor(() => $('#payment-view h1')?.textContent === 'Paid');
  assert.equal($('#pay-onchain'), null);
  assert.ok($('a[href="https://explorer.arc.io/tx/' + hash + '"]'));
  assert.deepEqual(walletMethods, []);
});

let release;
const approval = new Promise(resolve => { release = resolve; });
await runFrontend({ onWalletSend: async (tx, window) => {
  assert.equal(tx.chainId, '0x13b2');
  assert.equal(tx.nonce, '0x7');
  assert.equal(tx.to, address);
  assert.equal(tx.from, payer);
  assert.equal(BigInt(tx.value), amount);
  assert.ok(BigInt(tx.maxFeePerGas) >= 20_000_000_000n);
  assert.deepEqual(decodeFunctionData({ abi, data: tx.data }), { functionName: 'payInvoice', args: [merchant, id] });
  assert.equal(window.localStorage.length, 1);
  await approval;
} }, async ({ $, connect, walletMethods, actions, window }) => {
  connect();
  await ready($);
  const button = $('#pay-onchain');
  button.click();
  await waitFor(() => walletMethods.includes('eth_sendTransaction'));
  assert.ok(actions.includes('reserve_payment_attempt'));
  assert.equal($('#payment-view h1').textContent, 'Open');
  button.click();
  release();
  await waitFor(() => $('#payment-view h1')?.textContent === 'Paid' && Boolean($('a[href="https://explorer.arc.io/tx/' + hash + '"]')));
  assert.equal(walletMethods.filter(method => method === 'eth_sendTransaction').length, 1);
  assert.equal(window.localStorage.length, 0);
});

await runFrontend({ changeProviderAtReservation: true }, async ({ $, connect, walletMethods, actions }) => {
  connect();
  await ready($);
  $('#pay-onchain').click();
  await waitFor(() => actions.includes('reserve_payment_attempt'));
  await ready($);
  assert.ok(!walletMethods.includes('eth_sendTransaction'));
});

let finishWalletCall;
const delayedHash = new Promise(resolve => { finishWalletCall = resolve; });
await runFrontend({ onWalletSend: () => delayedHash }, async ({ $, connect, walletMethods, window }) => {
  connect();
  await ready($);
  $('#pay-onchain').click();
  await waitFor(() => walletMethods.includes('eth_sendTransaction'));
  connect({ ...wallet, address: merchant, connectorId: 'replacement' });
  finishWalletCall();
  const stored = () => JSON.parse(window.localStorage.getItem(window.localStorage.key(0)));
  await waitFor(() => stored()?.transactionHash === hash);
  assert.equal(stored().ownerAddress, payer);
  assert.equal(walletMethods.filter(method => method === 'eth_sendTransaction').length, 1);
});

console.log('Mainnet, link, wallet changes, transaction preflight, paid-invoice and duplicate-submission fixtures passed.');
