import { randomBytes } from 'node:crypto';

const cookieName = 'termul_circle_local';
const lifetime = 10 * 60;
const credentials = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;

export function createLocalSessionVault({ now = Date.now } = {}) {
  const sessions = new Map();
  const cookie = (value, maxAge) =>
    `${cookieName}=${value}; Max-Age=${maxAge}; Path=/__termul_circle/; HttpOnly; SameSite=Strict; Secure`;
  return {
    async handle(input, header, validate) {
      const handles = (header ?? '').split(';').map(item => item.trim())
        .filter(item => item.startsWith(cookieName + '=')).map(item => item.slice(cookieName.length + 1));
      const id = handles.length === 1 && /^[a-f0-9]{64}$/.test(handles[0]) ? handles[0] : undefined;
      for (const [key, record] of sessions) if (record.expiresAt <= now()) sessions.delete(key);
      const existing = sessions.get(id);
      const clear = cookie('', 0);
      if (input.action === 'forget') {
        if (id) sessions.delete(id);
        return { cookie: clear, body: {} };
      }
      if (input.action === 'restore') {
        if (!existing) return { cookie: clear, body: {} };
        let result;
        try { result = await validate(existing.auth.userToken); }
        catch (error) {
          if (![155103, 155104, 155105, 155718].includes(error?.code)) throw error;
        }
        if (sessions.get(id) !== existing || existing.expiresAt <= now() || result?.wallet?.id !== existing.walletId) {
          sessions.delete(id);
          return { cookie: clear, body: {} };
        }
        return { body: { auth: existing.auth, wallet: result.wallet, verifiedUntil: result.verifiedUntil } };
      }
      if (input.action === 'remember' && credentials(input.userToken) && credentials(input.encryptionKey)) {
        const { wallet } = await validate(input.userToken);
        if (!wallet || (existing && sessions.get(id) !== existing)) return { body: {} };
        if (id) sessions.delete(id);
        if (sessions.size >= 16) sessions.delete(sessions.keys().next().value);
        const key = randomBytes(32).toString('hex');
        sessions.set(key, { expiresAt: now() + lifetime * 1000, walletId: wallet.id,
          auth: { userToken: input.userToken, encryptionKey: input.encryptionKey } });
        return { cookie: cookie(key, lifetime), body: {} };
      }
      return { body: { error: 'Invalid local session request.' }, status: 400 };
    },
  };
}
