import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, parseAbi } from 'viem';
import { resolveArcNetwork, validatePaymentLinkNetwork, verifyInvoiceDeployment } from '../src/arc-network.js';
import { isExpectedHexChainId } from '../src/privy-wallets.js';

const testnet = resolveArcNetwork();
assert.equal(testnet.chain.id, 5042002);
assert.equal(testnet.chain.nativeCurrency.decimals, 18);
assert.equal(testnet.rpcUrl, 'https://rpc.blockdaemon.testnet.arc.io/');
assert.equal(testnet.deploymentBlock, 71546111n);
assert.equal(testnet.explorerUrl, 'https://explorer.testnet.arc.io');

const mainnetOnly = { VITE_TERMUL_NETWORK: 'mainnet' };
const disabled = resolveArcNetwork(mainnetOnly);
assert.equal(disabled.chain.id, 5042);
assert.equal(disabled.contractAddress, null);
assert.match(disabled.error, /TermulInvoices address/);
assert.equal(disabled.explorerUrl, 'https://explorer.arc.io');
assert.equal(resolveArcNetwork({ VITE_TERMUL_NETWORK: 'typo' }).chain, null);
const address = '0x' + '12'.repeat(20);
const merchant = '0x' + '34'.repeat(20);
const payer = '0x' + '56'.repeat(20);
const invoiceId = '0x' + '78'.repeat(32);
const fixtureCode = '0x60006000';
const env = {
  ...mainnetOnly,
  VITE_TERMUL_MAINNET_CONTRACT_ADDRESS: address,
  VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK: '100',
  VITE_TERMUL_MAINNET_RUNTIME_HASH: keccak256(fixtureCode),
  VITE_TERMUL_MAINNET_API_URL: 'https://metadata.example.test',
  VITE_ARUSPAY_BROWSER_RPC_URL: 'https://testnet.example.test',
  VITE_ARUSPAY_DEPLOYMENT_BLOCK: '99',
};
const mainnet = resolveArcNetwork(env);
assert.equal(mainnet.error, null);
assert.equal(mainnet.rpcUrl, 'https://rpc.mainnet.arc.io/');
assert.equal(mainnet.deploymentBlock, 100n);
assert.equal(mainnet.contractAddress, address);
assert.equal(resolveArcNetwork({ ...env, VITE_TERMUL_NETWORK: 'testnet' }).contractAddress, testnet.contractAddress);
for (const [variable, value] of [
  ['VITE_TERMUL_MAINNET_CONTRACT_ADDRESS', testnet.contractAddress],
  ['VITE_TERMUL_MAINNET_CONTRACT_ADDRESS', '0x' + '00'.repeat(20)],
  ['VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK', ''],
  ['VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK', '100.1'],
  ['VITE_TERMUL_MAINNET_RUNTIME_HASH', '0x1234'],
  ['VITE_TERMUL_MAINNET_RPC_URL', 'https://user:password@rpc.example.test'],
  ['VITE_TERMUL_MAINNET_API_URL', ''],
]) {
  assert.equal(resolveArcNetwork({ ...env, [variable]: value }).contractAddress, null, variable);
}
assert.equal(isExpectedHexChainId('0x13b2', 5042), true);
assert.equal(isExpectedHexChainId('0x4cef52', 5042), false);
assert.equal(isExpectedHexChainId('0x13b2x', 5042), false);

const fixtureClient = {
  getChainId: async () => 5042,
  getCode: async ({ address: requestedAddress, blockNumber }) => {
    assert.equal(requestedAddress, address);
    return blockNumber === 99n ? undefined : fixtureCode;
  },
};
await verifyInvoiceDeployment(fixtureClient, mainnet);
await assert.rejects(verifyInvoiceDeployment({ getChainId: () => { throw Error('must not call RPC'); } }, disabled), /TermulInvoices address/);
await assert.rejects(verifyInvoiceDeployment({ ...fixtureClient, getChainId: async () => 5042002 }, mainnet), /chain ID/);
await assert.rejects(verifyInvoiceDeployment({ ...fixtureClient, getCode: async () => '0x' }, mainnet), /No invoice contract bytecode/);
await assert.rejects(verifyInvoiceDeployment({ ...fixtureClient, getCode: async () => '0x6001' }, mainnet), /reviewed build/);
await assert.rejects(verifyInvoiceDeployment({ ...fixtureClient, getCode: async () => fixtureCode }, mainnet), /deployment block/);
await assert.rejects(verifyInvoiceDeployment({
  ...fixtureClient,
  getCode: async (request) => request.blockNumber === 99n ? null : fixtureClient.getCode(request),
}, mainnet), /deployment block/);
await verifyInvoiceDeployment({ getChainId: async () => 5042002, getCode: async () => fixtureCode }, testnet);

const linked = new URLSearchParams({ merchant, invoiceId });
const tagged = new URLSearchParams({ ...Object.fromEntries(linked), chainId: '5042', contract: address });
assert.doesNotThrow(() => validatePaymentLinkNetwork(linked, testnet));
assert.doesNotThrow(() => validatePaymentLinkNetwork(tagged, mainnet));
assert.throws(() => validatePaymentLinkNetwork(linked, mainnet), /does not belong/);
assert.throws(() => validatePaymentLinkNetwork(tagged, testnet), /does not belong/);
const repeated = new URLSearchParams(tagged);
repeated.append('chainId', '5042');
assert.throws(() => validatePaymentLinkNetwork(repeated, mainnet), /does not belong/);

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const abi = parseAbi([
  'function getInvoice(address merchant, bytes32 id) view returns ((address merchant, uint256 amount, uint64 expiresAt, uint8 status))',
  'function payInvoice(address merchant, bytes32 id) payable',
  'event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount)',
]);
const amount = 1000000000000000001n;
const invoiceResult = (status) => encodeFunctionResult({ abi, functionName: 'getInvoice', result: { merchant, amount, expiresAt: 0n, status } });
const hash = '0x' + '9a'.repeat(32);
const paidLog = {
  address, blockNumber: '0x64', transactionHash: hash, logIndex: '0x0', transactionIndex: '0x0', removed: false,
  topics: encodeEventTopics({ abi, eventName: 'InvoicePaid', args: { invoiceId, merchant, payer } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
};
const partialValue = 1000000000000000000n;
const originalFetch = globalThis.fetch;

async function runFrontend({ env, params, rpcChain, code = fixtureCode, balance = partialValue,
  walletAccount = payer, walletChain = '0x13b2', metadataAvailable = true, onWalletSend }, exercise) {
  const { outputFiles } = await build({
    entryPoints: ['src/arc-invoices.js'],
    absWorkingDir: new URL('..', import.meta.url).pathname,
    bundle: true,
    write: false,
    platform: 'node',
    packages: 'external',
    format: 'cjs',
    loader: { '.css': 'empty' },
    define: { 'import.meta.env': JSON.stringify(env) },
  });
  const dom = new JSDOM(html, { url: 'https://termul.example.test/?' + params, runScripts: 'outside-only' });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  window.eval(window.document.querySelector('script:not([src])').textContent);
  const rpcMethods = [];
  const walletMethods = [];
  const metadataActions = [];
  let submittedTransaction;
  const provider = {
    request: async ({ method, params }) => {
      walletMethods.push(method);
      if (method === 'eth_chainId') return walletChain;
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [walletAccount];
      if (method === 'eth_sendTransaction' && onWalletSend) {
        await onWalletSend(params[0], window);
        submittedTransaction = { ...params[0], input: params[0].data, hash, blockNumber: '0x64', type: '0x2' };
        return hash;
      }
      assert.fail('Fixture must never request a signature or submission: ' + method);
    },
  };
  window.arusPayPrivy = {
    getEthereumProvider: async () => provider,
    getAccessToken: async () => 'fixture-access-token',
    getIdentityToken: async () => 'fixture-identity-token',
  };
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = JSON.parse(await request.text());
    if (request.url.startsWith('https://metadata.example.test/')) {
      metadataActions.push(body.action);
      if (!metadataAvailable) return Response.json({}, { status: 503 });
      const result = body.action === 'get_deployment' ? { deployment: { chainId: 5042, contractAddress: address } } : {};
      return Response.json(result);
    }
    assert.ok(request.url.startsWith('https://rpc.mainnet.arc.io/')
      || request.url.startsWith('https://rpc.blockdaemon.testnet.arc.io/'), request.url);
    rpcMethods.push(body.method);
    const result = {
      eth_chainId: '0x' + rpcChain.toString(16),
      eth_getCode: body.params?.[1] === '0x63' ? '0x' : code,
      eth_call: invoiceResult(submittedTransaction ? 2 : 1),
      eth_blockNumber: rpcChain === 5042 ? '0x64' : '0x443b73f',
      eth_getLogs: submittedTransaction && body.params?.[0]?.topics?.[0] === paidLog.topics[0] ? [paidLog] : [],
      eth_getTransactionByHash: submittedTransaction || null,
      eth_getTransactionReceipt: submittedTransaction
        ? { blockNumber: '0x64', transactionHash: hash, status: '0x1', logs: [paidLog] } : null,
      eth_estimateGas: '0x10000',
      eth_getBlockByNumber: { baseFeePerGas: '0x4a817c800', transactions: [] },
      eth_maxPriorityFeePerGas: '0x0',
      eth_getBalance: '0x' + balance.toString(16),
    }[body.method];
    assert.notEqual(result, undefined, 'Unexpected RPC request: ' + body.method);
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  const module = { exports: {} };
  try {
    new Function('require', 'module', 'exports', outputFiles[0].text)(require, module, module.exports);
    await exercise({ window, document: window.document, rpcMethods, walletMethods, metadataActions });
  } finally {
    // Let any dashboard or reconciliation reads already in flight finish against the fixture.
    await new Promise((resolve) => setTimeout(resolve, 25));
    dom.window.close();
    globalThis.fetch = originalFetch;
    delete globalThis.window;
    delete globalThis.document;
  }
}

async function waitFor(check) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for the frontend fixture.');
}

await runFrontend({ env: mainnetOnly, params: tagged, rpcChain: 5042 }, async ({ window, document, rpcMethods, walletMethods }) => {
  assert.match(document.querySelector('#payment-view').textContent, /TermulInvoices address/);
  assert.equal(document.querySelector('#invoice-form [type=submit]').disabled, true);
  await window.arusPayCreateInvoice();
  assert.deepEqual(rpcMethods, []);
  assert.deepEqual(walletMethods, []);
});
for (const [rpcChain, code, message] of [
  [5042002, fixtureCode, /did not return the Arc Mainnet chain ID/],
  [5042, '0x', /No invoice contract bytecode/],
]) {
  await runFrontend({ env, params: tagged, rpcChain, code }, async ({ document, rpcMethods, walletMethods }) => {
    await waitFor(() => message.test(document.querySelector('#payment-view').textContent));
    assert.equal(document.querySelector('#pay-onchain'), null);
    assert.ok(!rpcMethods.includes('eth_call'));
    assert.deepEqual(walletMethods, []);
  });
}
await runFrontend({ env: {}, params: linked, rpcChain: 5042002 }, async ({ document }) => {
  await waitFor(() => !!document.querySelector('#pay-onchain'));
  assert.match(document.querySelector('#payment-view').textContent, /Arc Testnet/);
  assert.equal(document.querySelector('a[href^="https://explorer.testnet.arc.io/address/"]').href,
    'https://explorer.testnet.arc.io/address/' + testnet.contractAddress);
});
await runFrontend({ env, params: tagged, rpcChain: 5042 }, async ({ window, document, walletMethods, metadataActions }) => {
  window.arusPayCurrentPrivyUserId = 'did:privy:fixture';
  window.arusPayWalletChanged([{ chainType: 'ethereum', address: payer, walletClientType: 'metamask' }]);
  await waitFor(() => document.querySelector('#pay-onchain')?.textContent === 'Pay invoice on Arc Mainnet'
    && !document.querySelector('#pay-onchain').disabled);
  assert.match(document.querySelector('#payment-view').textContent, /1\.000000000000000001 USDC/);
  document.querySelector('#pay-onchain').click();
  await waitFor(() => /Insufficient native USDC/.test(document.querySelector('#toast-text').textContent));
  assert.ok(walletMethods.includes('eth_requestAccounts'));
  assert.ok(metadataActions.includes('get_deployment'));
  assert.ok(metadataActions.includes('get_payment_attempt'));
  assert.ok(!walletMethods.includes('eth_sendTransaction'));
  assert.equal(window.localStorage.length, 0);
});

await runFrontend({ env, params: tagged, rpcChain: 5042, walletAccount: merchant }, async ({ window, document, walletMethods }) => {
  window.arusPayCurrentPrivyUserId = 'did:privy:fixture';
  window.arusPayWalletChanged([{ chainType: 'ethereum', address: payer, walletClientType: 'metamask' }]);
  await waitFor(() => document.querySelector('#pay-onchain')?.textContent === 'Pay invoice on Arc Mainnet'
    && !document.querySelector('#pay-onchain').disabled);
  document.querySelector('#pay-onchain').click();
  await waitFor(() => /provider returned a different account/.test(document.querySelector('#toast-text').textContent));
  assert.ok(!walletMethods.includes('eth_sendTransaction'));
});

await runFrontend({ env, params: tagged, rpcChain: 5042, walletChain: '0x4cef52' }, async ({ window, document, walletMethods }) => {
  window.arusPayCurrentPrivyUserId = 'did:privy:fixture';
  window.arusPayWalletChanged([{ chainType: 'ethereum', address: payer, walletClientType: 'metamask' }]);
  await waitFor(() => document.querySelector('#pay-onchain')?.textContent === 'Wallet network not verified');
  assert.equal(document.querySelector('#pay-onchain').disabled, true);
  document.querySelector('#pay-onchain').click();
  assert.deepEqual(walletMethods, ['eth_chainId']);
});

await runFrontend({ env, params: tagged, rpcChain: 5042, balance: 2n * amount, metadataAvailable: false },
  async ({ window, document, walletMethods }) => {
    window.arusPayCurrentPrivyUserId = 'did:privy:fixture';
    window.arusPayWalletChanged([{ chainType: 'ethereum', address: payer, walletClientType: 'metamask' }]);
    await waitFor(() => document.querySelector('#pay-onchain')?.textContent === 'Pay invoice on Arc Mainnet'
      && !document.querySelector('#pay-onchain').disabled);
    document.querySelector('#pay-onchain').click();
    await waitFor(() => /could not check for a previous Mainnet payment/.test(document.querySelector('#toast-text').textContent));
    assert.ok(!walletMethods.includes('eth_requestAccounts'));
    assert.ok(!walletMethods.includes('eth_sendTransaction'));
  });

let releaseApproval;
const approval = new Promise((resolve) => { releaseApproval = resolve; });
await runFrontend({
  env, params: tagged, rpcChain: 5042, balance: 2n * amount,
  onWalletSend: async (tx, window) => {
    assert.equal(tx.chainId, '0x13b2');
    assert.equal(tx.from, payer);
    assert.equal(tx.to, address);
    assert.equal(BigInt(tx.value), amount);
    assert.ok(BigInt(tx.maxFeePerGas) >= 20_000_000_000n);
    assert.deepEqual(decodeFunctionData({ abi, data: tx.data }), { functionName: 'payInvoice', args: [merchant, invoiceId] });
    assert.equal(window.localStorage.length, 1, 'The unconfirmed attempt is recorded before submitting to the wallet.');
    await approval;
  },
}, async ({ window, document, walletMethods }) => {
  window.arusPayCurrentPrivyUserId = 'did:privy:fixture';
  window.arusPayWalletChanged([{ chainType: 'ethereum', address: payer, walletClientType: 'metamask' }]);
  await waitFor(() => document.querySelector('#pay-onchain')?.textContent === 'Pay invoice on Arc Mainnet'
    && !document.querySelector('#pay-onchain').disabled);
  const button = document.querySelector('#pay-onchain');
  button.click();
  await waitFor(() => walletMethods.includes('eth_sendTransaction'));
  assert.equal(document.querySelector('#payment-view h1').textContent, 'Open');
  assert.equal(button.disabled, true);
  button.click();
  releaseApproval();
  await waitFor(() => document.querySelector('#payment-view h1')?.textContent === 'Paid');
  assert.equal(walletMethods.filter((method) => method === 'eth_sendTransaction').length, 1);
  assert.ok(document.querySelector('a[href="https://explorer.arc.io/tx/' + hash + '"]'));
  assert.equal(window.localStorage.length, 0, 'The verified receipt clears the recovery hint.');
});

console.log('Arc network configuration, deployment checks, link isolation, and frontend payment guards passed with offline fixtures.');
