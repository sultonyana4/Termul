import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets';
import { encodeErrorResult, keccak256 } from 'viem';
import { TERMUL_MAINNET } from '../../supabase/functions/_shared/termul-mainnet.js';
import { invoiceAbi, readManagedPreflight, reviewedInvoiceCalls } from './managed-preflight.js';
import { createOperations } from './operations.js';

const wallet = {
  id: '00000000-0000-4000-8000-000000000001',
  address: '0x5042000000000000000000000000000000000001',
  blockchain: 'ARC',
  accountType: 'EOA',
};
const token = 'synthetic-test-token';
const runtime = '0x60006000';
const network = { ...TERMUL_MAINNET, runtimeHash: keccak256(runtime) };
const medium = { gasLimit: '97000', maxFee: '22.123456789', priorityFee: '2', networkFee: '0.0022' };

function mockArc({ chainId = 5042, bytecode = runtime } = {}) {
  return {
    getChainId: async () => chainId,
    getCode: async ({ address, blockNumber }) => {
      if (address === wallet.address || blockNumber === network.deploymentBlock - 1n) return undefined;
      return bytecode;
    },
    getBalance: async () => 0n,
    request: async ({ method, params }) => {
      if (method === 'eth_gasPrice') return '0x4a817c800';
      assert.ok(['eth_call', 'eth_estimateGas'].includes(method));
      assert.equal(params.length, 2);
      assert.equal(params[1], 'latest');
      assert.equal(params[0].from, wallet.address);
      assert.equal(params[0].to, network.contractAddress);
      const review = reviewedInvoiceCalls(wallet.address).find(call => call.data === params[0].data);
      assert.ok(review);
      assert.equal(BigInt(params[0].value), review.value);
      return method === 'eth_call' ? '0x' : '0x17700';
    },
  };
}

test('fixed invoice calldata and fee quotes round-trip with exact Arc native and gwei units', async () => {
  const requests = [];
  const result = await readManagedPreflight({
    arc: mockArc(), wallet, network,
    estimate: async request => {
      requests.push(request);
      return { data: { medium, unexpected: 'sanitized-response-fixture' } };
    },
  });
  assert.equal(result.deployment.status, 'verified');
  assert.equal(result.nativeDecimals, 18);
  assert.equal(result.balanceUsdc, '0');
  assert.equal(result.rpcGasPriceWei, '20000000000');
  const [create, pay] = result.calls;
  assert.equal(create.functionName, 'createInvoice');
  assert.equal(create.args[1], '10000000000000000');
  assert.equal(create.args[2], '0');
  assert.equal(create.valueBaseUnits, '0');
  assert.deepEqual(pay.args, [wallet.address, create.args[0]]);
  assert.equal(pay.valueBaseUnits, '10000000000000000');
  assert.equal(pay.valueUsdc, '0.01');
  assert.equal(pay.balanceCoversValue, false);
  for (const [i, call] of result.calls.entries()) {
    assert.equal(call.rpcCall.status, 'simulated');
    assert.equal(call.rpcGas.gasUnits, '96000');
    assert.equal(call.circle.maxFeeWeiPerGas, '22123456789');
    assert.equal(call.circle.priorityFeeWeiPerGas, '2000000000');
    assert.equal(call.circle.capCostUsdc, '0.002145975308533');
    assert.equal(call.rpcIndicativeCostUsdc, '0.00192');
    assert.equal(call.balanceCoversRpcTotal, false);
    assert.equal(call.gasUnitsDelta, '1000');
    assert.deepEqual(requests[i], {
      contractAddress: network.contractAddress, callData: call.calldata, source: { walletId: wallet.id },
      ...(i === 1 ? { amount: '0.01' } : {}),
    });
  }
  assert.doesNotMatch(JSON.stringify(result), /sanitized-response-fixture/);
});

test('wrong chain, wrong runtime and wallet code block both simulations and Circle estimation', async () => {
  const estimate = () => assert.fail('fee endpoint must not run');
  for (const [arc, expected] of [
    [mockArc({ chainId: 1 }), 'wrong-chain'],
    [mockArc({ bytecode: '0x12' }), 'runtime-mismatch'],
    [{ ...mockArc(), getCode: async ({ address, blockNumber }) =>
      address === wallet.address || blockNumber !== network.deploymentBlock - 1n ? runtime : undefined }, 'wallet-has-code'],
  ]) {
    const result = await readManagedPreflight({
      arc: { ...arc, request: () => assert.fail('simulation must not run') }, wallet, estimate, network,
    });
    assert.equal(result.status, expected);
  }
});

test('funds, custom reverts, unsupported blockchain and malformed estimates are distinct and sanitized', async () => {
  const arc = mockArc();
  const request = arc.request;
  arc.request = async input => {
    if (input.method === 'eth_call') {
      throw { cause: { data: encodeErrorResult({ abi: invoiceAbi, errorName: 'InvoiceNotOpen' }) } };
    }
    if (input.method === 'eth_estimateGas') throw new Error('revert: OutOfFunds sensitive-sentinel');
    return request(input);
  };
  const estimateError = code => async () => { throw { code, message: 'sensitive-sentinel' }; };
  for (const [estimate, expected] of [
    [estimateError(155205), 'insufficient-funds'],
    [estimateError(155510), 'unsupported-blockchain'],
    [estimateError(499), 'circle-error'],
    [async () => { throw { status: 403 }; }, 'circle-authentication-error'],
    [async () => ({ data: { medium: { ...medium, maxFee: '22.0000000001' } } }), 'invalid-fee-response'],
    [async () => ({ data: { medium: { ...medium, priorityFee: '99' } } }), 'invalid-fee-response'],
  ]) {
    const result = await readManagedPreflight({ arc, wallet, estimate, network });
    for (const call of result.calls) {
      assert.deepEqual(call.rpcCall, { status: 'contract-revert', reason: 'InvoiceNotOpen' });
      assert.equal(call.rpcGas.status, 'insufficient-funds');
      assert.equal(call.circle.status, expected);
      assert.equal(call.gasUnitsDelta, null);
    }
    assert.doesNotMatch(JSON.stringify(result), /sensitive-sentinel/);
  }
  await assert.rejects(readManagedPreflight({ arc, wallet, estimate: estimateError(155104), network }), { code: 155104 });
});

test('preflight forbids injected fields, stale wallet selection and parallel requests', async () => {
  let pendingWallet;
  let calls = 0;
  const circle = {
    listWallets: async () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { pendingWallet = resolve; });
      return { data: { wallets: [{ ...wallet, state: 'LIVE' }] } };
    },
    estimateContractExecutionFee: () => assert.fail('wrong chain must block Circle'),
  };
  const call = createOperations({ circle, arc: mockArc({ chainId: 1 }) });
  const input = { action: 'managed-preflight', userToken: token, walletId: wallet.id, walletAddress: wallet.address };
  for (const field of ['amount', 'callData', 'contractAddress', 'value']) {
    await assert.rejects(call({ ...input, [field]: 'injected' }), { status: 400 });
  }
  await assert.rejects(call({ ...input, userToken: '' }), { status: 401 });
  const pending = call(input);
  await assert.rejects(call(input), { status: 409 });
  pendingWallet({ data: { wallets: [{ ...wallet, state: 'LIVE' }] } });
  assert.equal((await pending).status, 'wrong-chain');
  await assert.rejects(call({ ...input, walletId: '00000000-0000-4000-8000-000000000002' }), { status: 409 });
  await assert.rejects(call({ ...input, action: 'create-managed-challenge' }), { status: 404 });
  await assert.rejects(call({ ...input, action: 'approve-managed-challenge' }), { status: 404 });
});

test('in-flight wallet identity is checked again before reporting a result', async () => {
  let reads = 0;
  const circle = { listWallets: async () => ({ data: { wallets: ++reads === 1
    ? [{ ...wallet, state: 'LIVE' }]
    : [{ ...wallet, state: 'LIVE', address: '0x5042000000000000000000000000000000000002' }] } }) };
  const call = createOperations({ circle, arc: mockArc({ chainId: 1 }) });
  await assert.rejects(call({
    action: 'managed-preflight', userToken: token, walletId: wallet.id, walletAddress: wallet.address,
  }), { status: 409 });
});

test('installed Circle SDK emits only the documented estimation route in preflight', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method, path: request.url,
      authorization: request.headers.authorization, token: request.headers['x-user-token'],
      body: JSON.parse(Buffer.concat(chunks)),
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: { medium } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const circle = initiateUserControlledWalletsClient({
    apiKey: 'TEST:local:synthetic', baseUrl: `http://127.0.0.1:${server.address().port}`,
  });
  const result = await readManagedPreflight({
    arc: mockArc(), wallet, network,
    estimate: params => circle.estimateContractExecutionFee({ ...params, userToken: token }),
  });
  assert.equal(requests.length, 2);
  for (const [i, request] of requests.entries()) {
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/w3s/transactions/contractExecution/estimateFee');
    assert.equal(request.authorization, 'Bearer TEST:local:synthetic');
    assert.equal(request.token, token);
    assert.deepEqual(request.body, {
      contractAddress: network.contractAddress, callData: result.calls[i].calldata, walletId: wallet.id,
      ...(i === 1 ? { amount: '0.01' } : {}),
    });
    assert.equal(result.calls[i].circle.status, 'estimated');
  }
});
