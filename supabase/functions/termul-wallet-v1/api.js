import { TERMUL_MAINNET as deployment } from '../_shared/termul-mainnet.js';

const BODY_LIMIT = 16 * 1024;
const TOKEN = /^[a-f0-9]{64}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const INVOICE_FIELDS = 'chain_id,contract_address,merchant_address,invoice_id,amount_native::text,client_name,client_email,description,expires_at,create_tx_hash,created_at';
const ATTEMPT_FIELDS = 'attempt_id,payer_address,tx_hash,updated_at,resolved_at';
const SCOPED = { chain_id: deployment.id, contract_address: deployment.contractAddress };
const encoder = new TextEncoder();
/** @returns {never} */
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function token(value) {
  if (typeof value !== 'string' || !TOKEN.test(value) || value.length !== 64) fail(400, 'Invalid authentication value.');
  return value;
}
function address(value) {
  if (typeof value !== 'string' || value.length !== 42 || !/^0x[a-f0-9]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) {
    fail(400, 'Invalid wallet address.');
  }
  return value.toLowerCase();
}
function hex32(value) {
  if (typeof value !== 'string' || value.length !== 66 || !/^0x[a-f0-9]{64}$/i.test(value)) fail(400, 'Invalid invoice or transaction identifier.');
  return value.toLowerCase();
}
function text(value, max) {
  if (typeof value !== 'string' || value.length > max) fail(400, 'Invalid metadata field.');
  return value.trim();
}
function attemptId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    fail(400, 'Invalid payment attempt.');
  }
  return value;
}
async function parseBody(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('Content-Type') || '')) fail(415, 'JSON is required.');
  if (!request.body) fail(400, 'A request body is required.');
  if (Number(request.headers.get('Content-Length') || 0) > BODY_LIMIT) fail(413, 'Request is too large.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let raw = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > BODY_LIMIT) fail(413, 'Request is too large.');
      raw += decoder.decode(chunk.value, { stream: true });
    }
    const payload = JSON.parse(raw + decoder.decode());
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'Invalid request.');
    return payload;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error.status) throw error;
    fail(400, 'Invalid request.');
  } finally {
    reader.releaseLock();
  }
}

function response(status, body = null, cors = false) {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' });
  if (cors) {
    headers.set('Access-Control-Allow-Origin', deployment.origin);
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  if (body) headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(body ? JSON.stringify(body) : null, { status, headers });
}

export function walletApi({ db, createSiweMessage, parseSiweMessage, verifyEOA, verifyCreation, now = Date.now }) {
  const limited = async (bucket, max) => {
    if (!await db.rpc('termul_wallet_rate_v1', { p_bucket: bucket, p_limit: max })) fail(429, 'Too many requests. Try again shortly.');
  };
  const sessionFor = async (request, input) => {
    const authorization = request.headers.get('Authorization') || '';
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
    if (!match) fail(401, 'Verify your wallet first.');
    const hash = await digest(match[1]);
    const [session] = await db.read('termul_wallet_sessions', { token_hash: hash }, 'wallet_address,expires_at,verified_at,revoked_at', 1);
    if (!session || session.revoked_at || !(Date.parse(session.expires_at) > now())) fail(401, 'Wallet session expired. Verify again.');
    if (address(input.walletAddress) !== session.wallet_address) fail(403, 'The wallet changed. Verify the selected account.');
    await limited('session:' + hash, 120);
    return { ...session, hash };
  };

  const getAttempt = async (key) => {
    const [latest] = await db.read('termul_wallet_payment_attempts', key, ATTEMPT_FIELDS, 1);
    if (latest) return latest.resolved_at ? null : latest;
    const old = await db.read('termul_mainnet_payment_attempts', key, 'payer_address,tx_hash,updated_at', 2, 'updated_at.desc');
    if (!old.length) return null;
    return { ...old[0], tx_hash: old.length === 1 ? old[0].tx_hash : null, legacy: true };
  };

  return async (request) => {
    if (request.headers.get('Origin') !== deployment.origin) return response(403, { error: 'Origin rejected.' });
    if (request.method === 'OPTIONS') return response(204, null, true);
    if (request.method !== 'POST') return response(405, { error: 'Method rejected.' }, true);
    try {
      const input = await parseBody(request);
      const action = input.action;
      if (action === 'challenge') {
        const wallet = address(input.walletAddress);
        await limited('challenge:global', 90);
        await limited('challenge:' + wallet, 5);
        const challengeToken = randomToken();
        const issuedAt = new Date(now());
        const expirationTime = new Date(issuedAt.getTime() + 5 * 60_000);
        const message = createSiweMessage({
          address: wallet, chainId: deployment.id, domain: deployment.domain, uri: deployment.origin,
          version: '1', nonce: randomToken(), issuedAt, expirationTime,
          statement: 'Verify your wallet to access your Termul profile and invoice metadata.',
        });
        await db.insert('termul_wallet_challenges', {
          token_hash: await digest(challengeToken), message_hash: await digest(message),
          wallet_address: wallet, expires_at: expirationTime.toISOString(),
        });
        return response(200, { challengeToken, message }, true);
      }
      if (action === 'verify') {
        await limited('verify:global', 120);
        const challengeHash = await digest(token(input.challengeToken));
        const [challenge] = await db.read('termul_wallet_challenges', { token_hash: challengeHash },
          'wallet_address,message_hash,expires_at,consumed_at', 1);
        if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= now()) fail(401, 'Challenge expired or already used.');
        await limited('verify:' + challengeHash, 5);
        if (typeof input.message !== 'string' || input.message.length > 1400
          || typeof input.signature !== 'string' || input.signature.length !== 132 || !/^0x[0-9a-f]{130}$/i.test(input.signature)) {
          fail(400, 'Invalid wallet signature format.');
        }
        const messageHash = await digest(input.message);
        const message = parseSiweMessage(input.message);
        if (messageHash !== challenge.message_hash || message.domain !== deployment.domain
          || message.uri !== deployment.origin || message.chainId !== deployment.id || message.version !== '1'
          || message.address?.toLowerCase() !== challenge.wallet_address) fail(401, 'Invalid wallet challenge.');
        if (!await verifyEOA(challenge.wallet_address, input.message, input.signature)) fail(401, 'Wallet signature verification failed.');
        const sessionToken = randomToken();
        const confirmed = await db.rpc('termul_wallet_confirm_v1', {
          p_challenge: challengeHash, p_message: messageHash, p_wallet: challenge.wallet_address, p_session: await digest(sessionToken),
        });
        if (!confirmed) fail(401, 'Challenge expired or already used.');
        return response(200, { sessionToken, walletAddress: challenge.wallet_address,
          expiresAt: new Date(now() + 12 * 60_000).toISOString() }, true);
      }

      await limited('session:global', 1000);
      const session = await sessionFor(request, input);
      const wallet = session.wallet_address;
      if (action === 'logout') {
        await db.update('termul_wallet_sessions', { token_hash: session.hash }, { revoked_at: new Date(now()).toISOString() });
        return response(200, { ok: true }, true);
      }
      if (['save_profile', 'save_invoice'].includes(action) && now() - Date.parse(session.verified_at) >= 6 * 60_000) {
        fail(401, 'Verify your wallet again before changing metadata.');
      }
      if (action === 'get_profile') {
        const [profile] = await db.read('termul_wallet_profiles', { wallet_address: wallet }, 'display_name', 1);
        return response(200, { profile: profile || null }, true);
      }
      if (action === 'save_profile') {
        const display_name = text(input.displayName, 40);
        if (!display_name) fail(400, 'Enter a display name.');
        await db.insert('termul_wallet_profiles', { wallet_address: wallet, display_name }, 'wallet_address', 'merge-duplicates');
        return response(200, { profile: { display_name } }, true);
      }
      if (input.chainId !== deployment.id || typeof input.contractAddress !== 'string' || input.contractAddress.toLowerCase() !== deployment.contractAddress) {
        fail(400, 'Unsupported invoice deployment.');
      }
      const merchant = address(input.merchantAddress);
      if (action === 'get_invoices' || action === 'save_invoice') {
        if (merchant !== wallet) fail(403, 'The signed wallet does not own this merchant namespace.');
        const key = { ...SCOPED, merchant_address: wallet };
        if (action === 'get_invoices') {
          const [original, current] = await Promise.all(['termul_mainnet_invoices', 'termul_wallet_invoices']
            .map((table) => db.read(table, key, INVOICE_FIELDS, 200, 'created_at.desc')));
          const invoices = [...new Map([...current, ...original].map((row) => [row.invoice_id, row])).values()]
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 200);
          return response(200, { invoices }, true);
        }
        const invoiceId = hex32(input.invoiceId);
        const txHash = hex32(input.createTxHash);
        if (typeof input.amountNative !== 'string' || !/^[1-9][0-9]{0,77}$/.test(input.amountNative)
          || BigInt(input.amountNative) > MAX_UINT256) fail(400, 'Invalid amount.');
        if (typeof input.expiresAt !== 'string' || !/^(0|[1-9][0-9]{0,11})$/.test(input.expiresAt)
          || BigInt(input.expiresAt) > 253402300799n) fail(400, 'Invalid invoice expiry.');
        const details = { ...key, invoice_id: invoiceId, create_tx_hash: txHash, amount_native: input.amountNative,
          client_name: text(input.clientName, 120), client_email: text(input.clientEmail, 254), description: text(input.description, 1000),
          expires_at: input.expiresAt === '0' ? null : new Date(Number(input.expiresAt) * 1000).toISOString() };
        const [original] = await db.read('termul_mainnet_invoices', { ...key, invoice_id: invoiceId }, INVOICE_FIELDS, 1);
        if (original) return response(200, { invoice: original }, true);
        if (!await verifyCreation({ merchant, invoiceId, txHash, amount: BigInt(input.amountNative), expiresAt: BigInt(input.expiresAt) })) {
          fail(422, 'The invoice creation receipt could not be verified.');
        }
        await db.insert('termul_wallet_invoices', details, 'chain_id,contract_address,merchant_address,invoice_id', 'ignore-duplicates');
        const [invoice] = await db.read('termul_wallet_invoices', { ...key, invoice_id: invoiceId }, INVOICE_FIELDS, 1);
        return response(200, { invoice }, true);
      }

      const id = hex32(input.invoiceId);
      const key = { ...SCOPED, merchant_address: merchant, invoice_id: id, payer_address: wallet };
      if (action === 'get_payment_attempt') return response(200, { attempt: await getAttempt(key) }, true);
      if (action === 'reserve_payment_attempt') {
        if (await getAttempt(key)) fail(409, 'A prior wallet submission still needs reconciliation.');
        const attempt = crypto.randomUUID();
        if (!await db.rpc('termul_wallet_reserve_v1', { p_merchant: merchant, p_invoice: id, p_payer: wallet, p_attempt: attempt })) {
          fail(409, 'A prior wallet submission still needs reconciliation.');
        }
        return response(200, { attemptId: attempt }, true);
      }
      if (action === 'save_payment_attempt') {
        await db.update('termul_wallet_payment_attempts', { ...key, attempt_id: attemptId(input.attemptId), resolved_at: null },
          { tx_hash: hex32(input.transactionHash), updated_at: new Date(now()).toISOString() });
        return response(200, { ok: true }, true);
      }
      if (action === 'clear_payment_attempt') {
        const resolved_at = new Date(now()).toISOString();
        if (input.attemptId) {
          await db.update('termul_wallet_payment_attempts', { ...key, attempt_id: attemptId(input.attemptId), resolved_at: null }, { resolved_at });
        } else if ((await getAttempt(key))?.legacy) {
          await db.insert('termul_wallet_payment_attempts', { ...key, attempt_id: crypto.randomUUID(), resolved_at },
            'chain_id,contract_address,merchant_address,invoice_id,payer_address', 'ignore-duplicates');
        }
        return response(200, { ok: true }, true);
      }
      fail(400, 'Unsupported action.');
    } catch (error) {
      return response(error.status || 503, { error: error.status ? error.message : 'Wallet metadata service is temporarily unavailable.' }, true);
    }
  };
}
