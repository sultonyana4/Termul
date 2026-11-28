import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openInitializationStore } from './initialization-store.js';
import { createLocalSessionVault } from './session-vault.js';

test('initialization persists the same idempotency key across handles and omits raw Circle user identifiers', t => {
  const dir = mkdtempSync(join(tmpdir(), 'termul-init-'));
  const path = join(dir, 'init.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const one = openInitializationStore(path);
  const subject = 'synthetic-not-persisted-subject';
  const record = { idempotencyKey: '11111111-1111-4111-8111-111111111111' };
  assert.deepEqual(one.claim(subject, undefined, record), record);
  one.close();
  const two = openInitializationStore(path);
  try {
    assert.deepEqual(two.claim(subject, undefined, { idempotencyKey: 'unexpected' }), record);
    const next = { ...record, confirmed: true };
    assert.equal(two.save(subject, record, next), true);
    assert.equal(two.save(subject, record, { ...record, challengeId: 'unexpected' }), false);
    assert.deepEqual(two.get(subject), next);
    assert.ok(!readFileSync(path).includes(subject));
  } finally { two.close(); }
});

test('refresh cookies are opaque, same-site, expire and are invalidated by logout or a wallet change', async () => {
  let time = 0;
  let id = 'original';
  const auth = { userToken: 'synthetic-session-token', encryptionKey: 'synthetic-encryption-material' };
  const vault = createLocalSessionVault({ now: () => time });
  const validate = async token => {
    assert.equal(token, auth.userToken);
    return { wallet: { id } };
  };
  const remember = async () => {
    const result = await vault.handle({ ...auth, action: 'remember' }, '', validate);
    assert.doesNotMatch(result.cookie, /synthetic/);
    assert.match(result.cookie, /HttpOnly; SameSite=Strict; Secure/);
    return result.cookie.split(';')[0];
  };
  let handle = await remember();
  assert.deepEqual((await vault.handle({ action: 'restore' }, handle, validate)).body.auth, auth);
  id = 'different';
  assert.deepEqual((await vault.handle({ action: 'restore' }, handle, validate)).body, {});
  handle = await remember();
  await vault.handle({ action: 'forget' }, handle, validate);
  assert.deepEqual((await vault.handle({ action: 'restore' }, handle, validate)).body, {});
  handle = await remember();
  time = 601_000;
  assert.deepEqual((await vault.handle({ action: 'restore' }, handle, validate)).body, {});
});

test('a refresh blocked on Circle cannot revive an already logged-out session', async () => {
  const vault = createLocalSessionVault();
  const validate = async () => ({ wallet: { id: 'expected' } });
  const { cookie } = await vault.handle({ action: 'remember', userToken: 'mock', encryptionKey: 'mock' }, '', validate);
  const handle = cookie.split(';')[0];
  let resume;
  const pending = vault.handle({ action: 'restore' }, handle, () => new Promise(resolve => { resume = resolve; }));
  await vault.handle({ action: 'forget' }, handle, validate);
  resume(await validate());
  assert.deepEqual((await pending).body, {});
});
