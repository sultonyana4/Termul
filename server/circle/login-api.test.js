import assert from 'node:assert/strict';
import test from 'node:test';
import { createSiweMessage } from 'viem/siwe';
import { createCircleLoginApi } from './login-api.js';
import { hash } from './postgrest.js';
import loginRoute from '../../api/termul-circle-login.js';

const wallet = { id: '11111111-1111-4111-8111-111111111111', address: '0x' + '12'.repeat(20),
  blockchain: 'ARC', accountType: 'EOA', state: 'LIVE' };
const appId = '22222222-2222-4222-8222-222222222222';
const challengeToken = 'aa'.repeat(32);
const challengeId = '33333333-3333-4333-8333-333333333333';
const origin = 'https://termul.xyz';
const email = 'fixture@example.invalid';

const makeMessage = domain => createSiweMessage({ domain, address: wallet.address, uri: 'https://' + domain,
  version: '1', chainId: 5042, nonce: 'mocknonce2026', expirationTime: new Date(Date.now() + 1000 * 60 * 5) });

function request(body, actualOrigin = origin) {
  return new Request(origin + '/api/termul-circle-login', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: actualOrigin }, body: JSON.stringify(body) });
}

function fixture(issued, override) {
  const calls = [];
  let valid = true;
  const circle = {
    listWallets: async () => ({ data: { wallets: [wallet] } }),
    createDeviceTokenForEmailLogin: async input => {
      calls.push(input);
      return { data: { otpToken: 'synthetic', deviceToken: 'device', deviceEncryptionKey: 'handoff', unexpected: 'never-return' } };
    },
    signMessage: async input => {
      calls.push(input);
      return { data: { challengeId, additional: 'never-return' } };
    },
  };
  const store = { rate: async () => valid, siweChallenge: async token => token === challengeToken
    ? { wallet_address: wallet.address, message_hash: hash(issued) } : null };
  const api = createCircleLoginApi({ circle, store, appId, enabled: true, allowedEmails: [email], ...override });
  return { api, calls, limit() { valid = false; } };
}

test('production OTP endpoint is disabled by default and enforces origin, allowlist and durable limits', async () => {
  const otp = { action: 'otp', email, deviceId: wallet.id };
  assert.equal((await createCircleLoginApi({})(request(otp))).status, 404);
  const f = fixture('');
  assert.equal((await f.api(request(otp, 'https://wrong.invalid'))).status, 403);
  assert.equal((await f.api(request({ ...otp, email: 'wrong@example.invalid' }))).status, 403);
  const response = await f.api(request(otp));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { otpToken: 'synthetic', deviceToken: 'device', deviceEncryptionKey: 'handoff' });
  assert.equal(f.calls[0].email, email);
  f.limit();
  assert.equal((await f.api(request(otp))).status, 429);
  assert.equal(f.calls.length, 1);
});

test('hosted login route enables public discovery with an unset or blank allowlist and rejects an invalid configured list', async t => {
  const env = {
    TERMUL_CIRCLE_LOGIN_API: 'enabled', TERMUL_CIRCLE_APP_ID: appId, TERMUL_CIRCLE_API_KEY: 'synthetic-api-key',
    TERMUL_CIRCLE_SUPABASE_URL: 'https://fixture.invalid', TERMUL_CIRCLE_SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
    TERMUL_CIRCLE_SESSION_KEY: 'ab'.repeat(32), TERMUL_CIRCLE_INITIALIZATION: 'enabled',
    TERMUL_CIRCLE_LOGIN_EMAIL_ALLOWLIST: undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Configuration discovery must stay offline.'); });
  const config = () => loginRoute.fetch(new Request(origin + '/api/termul-circle-login'));
  assert.equal((await (await config()).json()).initialization, true);
  for (const value of ['', '   ']) {
    process.env.TERMUL_CIRCLE_LOGIN_EMAIL_ALLOWLIST = value;
    const response = await config();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).appId, appId);
  }
  process.env.TERMUL_CIRCLE_LOGIN_EMAIL_ALLOWLIST = ' , invalid , ';
  assert.equal((await config()).status, 404);
});

test('public OTP accepts new emails and keeps the same normalized-email and global rate limits', async () => {
  const rates = [];
  const calls = [];
  const api = createCircleLoginApi({ appId, enabled: true, store: {
    async rate(bucket, limit) {
      rates.push([bucket, limit]);
      return rates.filter(([used]) => bucket === used).length <= limit;
    },
  }, circle: {
    async createDeviceTokenForEmailLogin(input) {
      calls.push(input.email);
      return { data: { otpToken: 'synthetic', deviceToken: 'synthetic', deviceEncryptionKey: 'synthetic' } };
    },
  } });
  const otp = email => request({ action: 'otp', email, deviceId: wallet.id });
  assert.equal((await api(otp('invalid'))).status, 400);
  assert.equal((await api(otp('  New@Example.invalid  '))).status, 200);
  assert.equal((await api(otp('new@example.invalid'))).status, 200);
  assert.equal((await api(otp('NEW@example.invalid'))).status, 429);
  assert.equal((await api(otp('another@example.invalid'))).status, 200);
  assert.deepEqual(calls, ['new@example.invalid', 'new@example.invalid', 'another@example.invalid']);
  assert.deepEqual(rates.slice(0, 2), [['circle-otp:global', 40], ['circle-otp:' + hash(calls[0]), 2]]);
  assert.equal((await api(request({ action: 'initialize' }))).status, 401);
});

test('Circle advertises recovery separately from execution and fails closed for non-Arc or ambiguous wallets', async () => {
  const f = fixture('', { allowTransferRecovery: true, allowBridge: true, allowLifi: true });
  const response = await f.api(new Request(origin + '/api/termul-circle-login'));
  assert.deepEqual(await response.json(), { appId, managed: false, arcSwap: false, transferRecovery: true, initialization: false });
  const base = { ...wallet, blockchain: 'BASE' };
  const frozen = { ...wallet, state: 'FROZEN', id: appId };
  const payload = { action: 'wallet', userToken: 'mock' };
  for (const wallets of [[base], [wallet, frozen], [frozen], [null, base]]) {
    const { api } = fixture('', { circle: { listWallets: async ({ blockchain }) => {
      assert.equal(blockchain, 'ARC');
      return { data: { wallets } };
    } } });
    assert.equal((await api(request(payload))).status, 409);
  }
});

test('production Circle message approval is limited to an unconsumed, exact Termul SIWE challenge', async () => {
  const message = makeMessage('termul.xyz');
  const f = fixture(message);
  const payload = { action: 'sign', userToken: 'mock', challengeToken, message };
  assert.equal((await f.api(request({ ...payload, message: 'Arbitrary signature' }))).status, 401);
  assert.equal((await f.api(request({ ...payload, challengeToken: 'bb'.repeat(32) }))).status, 401);
  const wrong = makeMessage('wrong.invalid');
  assert.equal((await fixture(wrong).api(request({ ...payload, message: wrong }))).status, 401);
  for (let i = 0; i < 2; i++) {
    const approved = await f.api(request(payload));
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), { challengeId });
  }
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].walletId, wallet.id);
  assert.equal(f.calls[0].message, message);
  assert.match(f.calls[0].idempotencyKey, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(f.calls[0].idempotencyKey, f.calls[1].idempotencyKey);
});

test('hosted wallet initialization is an explicit opt-in and reserves durably before provider handoff', async () => {
  const input = { action: 'initialize', userToken: 'mock' };
  assert.equal((await fixture('').api(request(input))).status, 403);
  let existing, challengeCount = 0, available = false;
  const initialization = {
    get: async () => existing,
    claim: async (_, previous, next) => {
      if (existing === previous) existing = next;
      return existing;
    },
    save: async (_, previous, next) => {
      if (existing !== previous) return false;
      existing = next;
      return true;
    },
  };
  const circle = {
    listWallets: async () => ({ data: { wallets: available ? [wallet] : [] } }),
    getUserStatus: async () => ({ data: { id: 'existing-synthetic-user' } }),
    listUserChallenges: async () => ({ data: { challenges: existing?.challengeId
      ? [{ id: challengeId, type: 'INITIALIZE', status: 'PENDING' }] : [] } }),
    createUserPinWithWallets: async options => {
      assert.equal(options.idempotencyKey, existing.idempotencyKey);
      assert.deepEqual(options.blockchains, ['ARC']);
      assert.equal(options.accountType, 'EOA');
      challengeCount++;
      return { data: { challengeId } };
    },
  };
  const build = () => createCircleLoginApi({ circle, store: { rate: async () => true, initialization },
    appId, enabled: true, allowInitialization: true });
  const discovery = await build()(request({ ...input, action: 'initialization-status' }));
  assert.equal((await discovery.json()).state, 'retry');
  assert.equal(challengeCount, 0);
  const retry = { ...input, userToken: 'different-token-for-same-provider-user' };
  const responses = await Promise.all([build()(request(input)), build()(request(retry))]);
  const concurrent = await Promise.all(responses.map(response => response.json()));
  assert.equal(concurrent.filter(result => result.challengeId === challengeId).length, 1);
  assert.equal(concurrent.filter(result => result.pendingInitialization).length, 1);
  const pending = await build()(request({ ...retry, action: 'initialization-status' }));
  assert.deepEqual(await pending.json(), { wallet: null, state: 'pending', resumable: true });
  assert.equal((await (await build()(request(retry))).json()).challengeId, challengeId);
  available = true;
  const returning = await (await build()(request(retry))).json();
  assert.equal(returning.wallet.id, wallet.id);
  assert.equal(returning.wallet.address, wallet.address);
  assert.equal(challengeCount, 1);
});
