import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { hash } from './postgrest.js';

const name = '__Secure-termul_circle';
const duration = 9 * 60;
const credential = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const cookie = (handle, age) => `${name}=${handle}; Max-Age=${age}; Path=/api/termul-circle-login; HttpOnly; Secure; SameSite=Strict`;
const aad = (id, until) => Buffer.from(`termul-circle-v1:${id}:${until}`);

export function createHostedSessionVault({ key, store, now = Date.now }) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('Use a random 32-byte hexadecimal key.');
  const secret = Buffer.from(key, 'hex');
  const decode = str => Buffer.from(str, 'base64url');

  return async function handle(input, header, findWallet) {
    const choices = (header ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(name + '='));
    const handle = choices.length === 1 ? choices[0].slice(name.length + 1) : undefined;
    const id = /^[a-f0-9]{64}$/.test(handle ?? '') ? hash(handle) : undefined;
    if (input.action === 'forget') {
      if (id) await store.remove(id);
      return { cookie: cookie('', 0), body: {} };
    }
    if (input.action === 'remember') {
      if (!credential(input.userToken) || !credential(input.encryptionKey)) return { status: 400, body: { error: 'Invalid Circle session.' } };
      const wallet = await findWallet(input.userToken);
      if (!wallet) return { status: 401, body: { error: 'Circle wallet is unavailable.' } };
      const next = randomBytes(32).toString('hex');
      const keyId = hash(next);
      const until = now() + duration * 1000;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv).setAAD(aad(keyId, until));
      const payload = JSON.stringify({ userToken: input.userToken, encryptionKey: input.encryptionKey, walletId: wallet.id, address: wallet.address });
      const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
      const sealed = [iv, cipher.getAuthTag(), ciphertext].map(bytes => bytes.toString('base64url')).join('.');
      if (!await store.replace(id, keyId, sealed, new Date(until).toISOString())) return { cookie: cookie('', 0), body: {} };
      return { cookie: cookie(next, duration), body: {} };
    }
    const stored = id && await store.get(id);
    const until = Date.parse(stored?.expires_at);
    if (!Number.isFinite(until) || until <= now()) return { cookie: cookie('', 0), body: {} };
    let session;
    try {
      const [iv, tag, encrypted] = stored.sealed.split('.').map(decode);
      const decipher = createDecipheriv('aes-256-gcm', secret, iv).setAAD(aad(id, until)).setAuthTag(tag);
      session = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
    } catch {
      return { cookie: cookie('', 0), body: {} };
    }
    let wallet;
    try { wallet = await findWallet(session.userToken); }
    catch (error) {
      if (![155103, 155104, 155105, 155718].includes(error?.code)) throw error;
    }
    if (wallet?.id !== session.walletId || wallet?.address !== session.address || until <= now() ||
      (await store.get(id))?.sealed !== stored.sealed) return { cookie: cookie('', 0), body: {} };
    return { body: { wallet, auth: { userToken: session.userToken, encryptionKey: session.encryptionKey } } };
  };
}
