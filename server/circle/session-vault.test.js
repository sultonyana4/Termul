import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedSessionVault } from './session-vault.js';

function makeFixture() {
  const rows = new Map();
  const store = {
    get: async id => rows.get(id),
    remove: async id => rows.delete(id),
    replace: async (prev, id, sealed, expires_at) => {
      if (prev && !rows.delete(prev)) return false;
      rows.set(id, { sealed, expires_at });
      return true;
    },
  };
  const key = 'ab'.repeat(32);
  let time = Date.now();
  const auth = { userToken: 'synthetic-circle-user-token', encryptionKey: 'synthetic-circle-key' };
  const wallet = { id: 'sample-wallet-id', address: '0x' + '12'.repeat(20) };
  const find = async token => {
    assert.equal(token, auth.userToken);
    return wallet;
  };
  const build = overrides => createHostedSessionVault({ store, key, now: () => time, ...overrides });
  return { rows, store, auth, wallet, find, build, advance() { time += 10 * 60_000; } };
}

test('hosted session restoration across handler restart stores only authenticated ciphertext and a hashed cookie handle', async () => {
  const f = makeFixture();
  const issue = await f.build()({ action: 'remember', ...f.auth }, '', f.find);
  assert.match(issue.cookie, /HttpOnly; Secure; SameSite=Strict/);
  const handle = issue.cookie.split(';')[0];
  assert.equal(f.rows.size, 1);
  assert.doesNotMatch(JSON.stringify([...f.rows]), /synthetic-circle/);
  assert.ok(!JSON.stringify([...f.rows]).includes(handle.split('=')[1]));
  assert.deepEqual((await f.build()({ action: 'restore' }, handle, f.find)).body, { wallet: f.wallet, auth: f.auth });
  for (const verify of [async () => null, async () => ({ ...f.wallet, id: 'changed' })]) {
    assert.deepEqual((await f.build()({ action: 'restore' }, handle, verify)).body, {});
  }
  assert.deepEqual((await f.build({ key: 'cd'.repeat(32) })({ action: 'restore' }, handle, f.find)).body, {});
  f.advance();
  assert.deepEqual((await f.build()({ action: 'restore' }, handle, f.find)).body, {});
});

test('concurrent logout prevents hosted restoration and replacement with a revoked cookie', async () => {
  const f = makeFixture();
  const handle = (await f.build()({ action: 'remember', ...f.auth }, '', f.find)).cookie.split(';')[0];
  let validate, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const request = f.build()({ action: 'restore' }, handle, () => new Promise(resolve => { validate = resolve; entered(); }));
  await started;
  await f.build()({ action: 'forget' }, handle, f.find);
  validate(f.wallet);
  assert.deepEqual((await request).body, {});
  assert.deepEqual((await f.build()({ action: 'remember', ...f.auth }, handle, f.find)).body, {});
  assert.equal(f.rows.size, 0);
});
