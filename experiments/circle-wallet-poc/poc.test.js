import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isAddressEqual, parseTransaction, recoverTransactionAddress, serializeTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arcChainId, createArcReadClient, readArcBalance } from './arc.js';
import { createOperations } from './operations.js';
import { makeLocalChallenge, verifyLocalChallenge } from './siwe.js';

const origin = 'http://localhost:4173';
const testEmail = 'approved@example.test';
const firstToken = 'test-token-1';
const secondToken = 'test-token-2';
const walletId = randomUUID();
const challengeId = randomUUID();
const fixture = () => privateKeyToAccount(generatePrivateKey());
const client = () => ({ getChainId: async () => arcChainId, getCode: async () => undefined });

test('wallet discovery stays available while initialization is disabled by default', async () => {
  const wallet = { id: walletId, address: fixture().address, blockchain: 'ARC', accountType: 'EOA', state: 'LIVE' };
  const circle = { listWallets: async ({ userToken }) => ({ data: { wallets: userToken === firstToken ? [wallet] : [] } }) };
  const call = createOperations({ circle, origin, testEmail });
  assert.equal((await call({ action: 'initialization-status', userToken: firstToken })).wallet.id, walletId);
  assert.equal((await call({ action: 'initialization-status', userToken: secondToken })).state, 'disabled');
  await assert.rejects(call({ action: 'initialize', userToken: secondToken }), { status: 403 });
});

test('OTP allowlist, concurrent request lock, cooldown, and restricted response', async () => {
  let finish;
  let time = 0;
  let count = 0;
  const circle = {
    createDeviceTokenForEmailLogin: ({ email, deviceId, idempotencyKey }) => {
      assert.equal(email, testEmail);
      assert.ok(deviceId && idempotencyKey);
      count++;
      return new Promise(resolve => { finish = resolve; });
    },
  };
  const call = createOperations({ circle, origin, testEmail, now: () => time });
  const req = { action: 'otp', email: testEmail, deviceId: randomUUID() };
  await assert.rejects(call({ ...req, email: 'other@example.test' }), { status: 403 });
  await assert.rejects(call({ ...req, deviceId: '' }), { status: 400 });
  const pending = call(req);
  await assert.rejects(call(req), { status: 409 });
  const data = { otpToken: 'simulated-otp', deviceToken: 'simulated-device', deviceEncryptionKey: 'simulated-key' };
  finish({ data: { ...data, unrelatedField: 'filtered' } });
  assert.deepEqual(await pending, data);
  await assert.rejects(call(req), { status: 429 });
  time = 30_000;
  const next = call(req);
  finish({ data });
  await next;
  assert.equal(count, 2);
});

test('explicit first initialization is deduplicated and repeat login finds the same wallet', async () => {
  const account = fixture();
  const wallet = { id: walletId, address: account.address, blockchain: 'ARC', accountType: 'EOA' };
  let visible = false;
  let requests = 0;
  const circle = {
    listWallets: async ({ userToken, blockchain }) => {
      assert.ok([firstToken, secondToken].includes(userToken));
      assert.equal(blockchain, 'ARC');
      return { data: { wallets: visible ? [{ ...wallet, state: 'LIVE', unrelated: 'ignored' }] : [] } };
    },
    getUserStatus: async () => ({ data: { id: 'same-circle-user' } }),
    listUserChallenges: async () => ({ data: { challenges: requests ? [{ type: 'INITIALIZE', id: challengeId, status: 'PENDING' }] : [] } }),
    createUserPinWithWallets: async input => {
      requests++;
      assert.deepEqual(input.blockchains, ['ARC']);
      assert.equal(input.accountType, 'EOA');
      assert.ok(input.idempotencyKey);
      return { data: { challengeId } };
    },
  };
  const call = createOperations({ circle, origin, testEmail, allowInitialization: true });
  assert.deepEqual(await call({ action: 'wallet', userToken: firstToken }), { wallet: null });
  assert.equal(requests, 0);
  const init = call({ action: 'initialize', userToken: firstToken });
  await assert.rejects(call({ action: 'initialize', userToken: firstToken }), { status: 409 });
  assert.deepEqual(await init, { challengeId });
  assert.deepEqual(await call({ action: 'initialize', userToken: secondToken }), { challengeId });
  const restarted = createOperations({ circle, origin, testEmail, allowInitialization: true });
  assert.deepEqual(await restarted({ action: 'initialize', userToken: firstToken }), { pendingInitialization: true });
  visible = true;
  assert.deepEqual(await call({ action: 'wallet', userToken: firstToken }), { wallet });
  assert.deepEqual(await call({ action: 'wallet', userToken: secondToken }), { wallet });
  assert.deepEqual(await call({ action: 'initialize', userToken: secondToken }), { wallet });
  assert.equal(requests, 1);
});

test('initialization reuses its idempotency key after an ambiguous error', async () => {
  const attempts = [];
  const circle = {
    listWallets: async () => ({ data: { wallets: [] } }),
    getUserStatus: async () => ({ data: { id: 'same-circle-user' } }),
    listUserChallenges: async () => ({ data: {} }),
    createUserPinWithWallets: async ({ idempotencyKey }) => {
      attempts.push(idempotencyKey);
      if (attempts.length === 1) throw new Error('simulated timeout');
      return { data: { challengeId } };
    },
  };
  const call = createOperations({ circle, origin, testEmail, allowInitialization: true });
  await assert.rejects(call({ action: 'initialize', userToken: firstToken }), /simulated timeout/);
  assert.deepEqual(await call({ action: 'initialize', userToken: secondToken }), { challengeId });
  assert.equal(attempts[0], attempts[1]);
});

test('balances require chain 5042 and use native 18-decimal USDC', async () => {
  const { address } = fixture();
  const getBalance = async input => {
    assert.deepEqual(input, { address });
    return 1_250_000_000_000_000_000n;
  };
  assert.deepEqual(await readArcBalance({ ...client(), getBalance }, address), { chainId: 5042, balance: '1.25' });
  await assert.rejects(readArcBalance({
    getChainId: async () => 1, getBalance: () => assert.fail('queried the wrong chain'),
  }, address), /unexpected chain ID/);
});

test('local SIWE uses the Termul EOA verifier and rejects tampering, expiry, wrong signer, chain or bytecode', async () => {
  const account = fixture();
  const now = Date.now();
  const challenge = makeLocalChallenge(origin, account.address, now);
  const { message } = challenge;
  const signature = await account.signMessage({ message });
  const values = { client: client(), origin, challenge, message, signature, now };
  assert.equal(await verifyLocalChallenge(values), true);
  assert.equal(await verifyLocalChallenge({ ...values, message: message + '\n' }), false);
  assert.equal(await verifyLocalChallenge({ ...values, origin: 'http://localhost:9999' }), false);
  assert.equal(await verifyLocalChallenge({ ...values, now: challenge.expiresAt }), false);
  assert.equal(await verifyLocalChallenge({ ...values, signature: await fixture().signMessage({ message }) }), false);
  assert.equal(await verifyLocalChallenge({ ...values, client: { ...client(), getChainId: async () => 1 } }), false);
  assert.equal(await verifyLocalChallenge({ ...values, client: { ...client(), getCode: async () => '0xef0100' } }), false);
});

test('mock Circle message-signing uses the exact SIWE text and consumes the local challenge once', async () => {
  const account = fixture();
  let clock = Date.now();
  let submitted;
  const circle = {
    listWallets: async () => ({ data: { wallets: [
      { id: walletId, address: account.address, blockchain: 'ARC', accountType: 'EOA', state: 'LIVE' },
    ] } }),
    signMessage: async input => {
      assert.equal(input.walletId, walletId);
      assert.equal(input.encodedByHex, false);
      submitted = input.message;
      return { data: { challengeId } };
    },
  };
  const call = createOperations({ circle, arc: client(), origin, testEmail, now: () => clock });
  const { message } = await call({ action: 'sign', userToken: firstToken });
  assert.equal(message, submitted);
  const signature = await account.signMessage({ message });
  const req = { action: 'verify-signature', userToken: firstToken, message, signature, challengeId };
  await assert.rejects(call({ ...req, userToken: secondToken }), { status: 401 });
  const results = await Promise.allSettled([call(req), call(req)]);
  assert.equal(results[0].value.verified, true);
  assert.equal((await call({ action: 'wallet', userToken: firstToken })).verifiedUntil, results[0].value.verifiedUntil);
  assert.equal((await call({ action: 'wallet', userToken: secondToken })).verifiedUntil, undefined);
  assert.equal(results[1].reason.status, 409);
  await assert.rejects(call(req), { status: 401 });
  await assert.rejects(call({ action: 'sign-transaction', userToken: firstToken }), { status: 404 });
  clock = results[0].value.verifiedUntil;
  assert.equal((await call({ action: 'wallet', userToken: firstToken })).verifiedUntil, undefined);
  await call({ action: 'logout', userToken: firstToken });
  assert.equal((await call({ action: 'wallet', userToken: firstToken })).verifiedUntil, undefined);
});

test('mock sign-only EIP-1559 envelope preserves Arc chain ID and reviewed fields', async () => {
  const account = fixture();
  const reviewed = {
    type: 'eip1559', chainId: 5042, to: '0x0000000000000000000000000000000000000001',
    nonce: 7, value: 123n, data: '0x1234', gas: 35_000n,
    maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
  };
  const mockSigner = rawTransaction => account.signTransaction(parseTransaction(rawTransaction));
  const unsigned = serializeTransaction(reviewed);
  const signed = await mockSigner(unsigned);
  for (const parsed of [parseTransaction(unsigned), parseTransaction(signed)]) {
    for (const [field, value] of Object.entries(reviewed)) assert.equal(parsed[field], value, field);
  }
  assert.ok(isAddressEqual(await recoverTransactionAddress({ serializedTransaction: signed }), account.address));
});

test('reconciliation follows a known challenge through indexing lag and preserves the original EOA', async () => {
  const account = fixture();
  const request = { userToken: firstToken };
  let state = 'PENDING';
  let visible = false;
  let creations = 0;
  const circle = {
    listWallets: async () => ({ data: { wallets: visible ? [
      { id: walletId, address: account.address, blockchain: 'ARC', accountType: 'EOA', state: 'LIVE' },
    ] : [] } }),
    getUserStatus: async () => ({ data: { id: 'test-circle-user' } }),
    listUserChallenges: async () => ({ data: { challenges: [] } }),
    getUserChallenge: async ({ challengeId: id }) => {
      assert.equal(id, challengeId);
      return { data: { challenge: { id, type: 'INITIALIZE', status: state } } };
    },
    createUserPinWithWallets: async () => {
      creations++;
      return { data: { challengeId } };
    },
  };
  const call = createOperations({ circle, origin, testEmail, allowInitialization: true });
  assert.equal((await call({ ...request, action: 'initialization-status' })).state, 'retry');
  assert.deepEqual(await call({ ...request, action: 'initialize' }), { challengeId });
  assert.equal((await call({ ...request, action: 'initialization-status' })).state, 'pending');
  state = 'IN_PROGRESS';
  assert.deepEqual(await call({ ...request, action: 'initialize' }), { pendingInitialization: true });
  state = 'COMPLETE';
  assert.equal((await call({ ...request, action: 'initialization-status' })).state, 'complete');
  assert.deepEqual(await call({ ...request, action: 'initialize' }), { alreadyInitialized: true });
  visible = true;
  const result = await call({ ...request, action: 'initialization-status' });
  assert.equal(result.state, 'ready');
  assert.equal(result.wallet.id, walletId);
  assert.equal(result.wallet.address, account.address);
  assert.equal(creations, 1);
});

test('initialization retries only after a terminal failure or expiry and uses a fresh key', async () => {
  for (const status of ['FAILED', 'EXPIRED']) {
    const keys = [];
    let challengeStatus = 'PENDING';
    const circle = {
      listWallets: async () => ({ data: { wallets: [] } }),
      getUserStatus: async () => ({ data: { id: 'test-circle-user' } }),
      listUserChallenges: async () => ({ data: { challenges: keys.length
        ? [{ id: challengeId, type: 'INITIALIZE', status: challengeStatus }]
        : [] } }),
      createUserPinWithWallets: async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        return { data: { challengeId: keys.length === 1 ? challengeId : randomUUID() } };
      },
    };
    const call = createOperations({ circle, origin, testEmail, allowInitialization: true });
    const input = { action: 'initialize', userToken: firstToken };
    await call(input);
    challengeStatus = 'UNRECOGNIZED';
    assert.deepEqual(await call(input), { pendingInitialization: true });
    assert.equal(keys.length, 1);
    challengeStatus = status;
    assert.equal((await call({ ...input, action: 'initialization-status' })).state, 'retry');
    await call(input);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  }
});

test('Circle already-initialized response prevents a second challenge before the wallet is indexed', async () => {
  let attempts = 0;
  const circle = {
    listWallets: async () => ({ data: { wallets: [] } }),
    getUserStatus: async () => ({ data: { id: 'test-circle-user' } }),
    listUserChallenges: async () => ({ data: { challenges: [] } }),
    createUserPinWithWallets: async () => {
      attempts++;
      throw Object.assign(new Error('simulated already initialized'), { code: 155106 });
    },
  };
  const call = createOperations({ circle, origin, testEmail, allowInitialization: true });
  const input = { action: 'initialize', userToken: firstToken };
  assert.deepEqual(await call(input), { wallet: null, alreadyInitialized: true });
  assert.equal((await call({ ...input, action: 'initialization-status' })).state, 'complete');
  assert.deepEqual(await call(input), { alreadyInitialized: true });
  assert.equal(attempts, 1);
});

test('the PoC RPC transport rejects broadcast methods locally', async () => {
  let outbound = 0;
  const arc = createArcReadClient(() => {
    outbound++;
    throw new Error('Unanticipated RPC request.');
  });
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction']) {
    await assert.rejects(arc.request({ method, params: [] }), /is not supported/);
  }
  assert.equal(outbound, 0);
});
