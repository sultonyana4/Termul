import assert from 'node:assert/strict';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { recoverMessageAddress } from 'viem';
import { walletApi } from '../supabase/functions/termul-wallet-v1/api.js';
import { createEOAVerifier } from '../supabase/functions/termul-wallet-v1/verification.js';
import { TERMUL_MAINNET as net } from '../supabase/functions/_shared/termul-mainnet.js';

const merchant = '0x' + '12'.repeat(20);
const payer = '0x' + '34'.repeat(20);
const invoiceId = '0x' + 'ab'.repeat(32);
const hash = '0x' + 'de'.repeat(32);
const signature = '0x' + '11'.repeat(65);
const scope = { chainId: 5042, contractAddress: net.contractAddress, merchantAddress: merchant, invoiceId };
const legacy = {
  chain_id: 5042, contract_address: net.contractAddress, merchant_address: merchant, invoice_id: invoiceId,
  client_name: 'Original merchant metadata', client_email: 'secret@test.invalid', description: 'Legacy services', amount_native: '10000000000000001', created_at: '2026-11-20T00:00:00Z',
};
let now = Date.parse('2026-11-23T00:00:00Z');
let expectedSigner = merchant;
const tables = new Map([['termul_mainnet_invoices', [{ ...legacy }]]]);
const rate = new Map();
const rows = (table) => {
  if (!tables.has(table)) tables.set(table, []);
  return tables.get(table);
};
const matches = (row, filters) => Object.entries(filters).every(([k, v]) => (row[k] ?? null) === v);
const db = {
  read: async (table, filters, fields, limit) => rows(table).filter(row => matches(row, filters)).slice(0, limit)
    .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields.split(',').some(field => field.split('::')[0] === key)))),
  insert: async (table, row, keys, resolution) => {
    const existing = keys && rows(table).find(item => keys.split(',').every(key => item[key] === row[key]));
    if (!existing) rows(table).push(row);
    else if (resolution === 'merge-duplicates') Object.assign(existing, row);
  },
  update: async (table, filters, values) => rows(table).filter(row => matches(row, filters)).forEach(row => Object.assign(row, values)),
  rpc: async (fn, input) => {
    if (fn === 'termul_wallet_rate_v1') {
      const key = `${Math.floor(now / 60_000)}:${input.p_bucket}`;
      rate.set(key, 1 + (rate.get(key) || 0));
      return rate.get(key) <= input.p_limit;
    }
    if (fn === 'termul_wallet_confirm_v1') {
      const challenge = rows('termul_wallet_challenges').find(row => row.token_hash === input.p_challenge);
      if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= now
        || challenge.message_hash !== input.p_message || challenge.wallet_address !== input.p_wallet) return false;
      challenge.consumed_at = new Date(now).toISOString();
      rows('termul_wallet_sessions').push({ token_hash: input.p_session, wallet_address: input.p_wallet,
        verified_at: new Date(now).toISOString(), expires_at: new Date(now + 12 * 60_000).toISOString() });
      return true;
    }
    if (fn === 'termul_wallet_reserve_v1') {
      const key = { chain_id: 5042, contract_address: net.contractAddress, merchant_address: input.p_merchant,
        invoice_id: input.p_invoice, payer_address: input.p_payer };
      const previous = rows('termul_wallet_payment_attempts').find(row => matches(row, key));
      if (previous && !previous.resolved_at) return false;
      const row = { ...key, attempt_id: input.p_attempt, tx_hash: null, resolved_at: null, updated_at: new Date(now).toISOString() };
      if (previous) Object.assign(previous, row);
      else rows('termul_wallet_payment_attempts').push(row);
      return true;
    }
    assert.fail(fn);
  },
};
const api = walletApi({
  db, createSiweMessage, parseSiweMessage, now: () => now,
  verifyEOA: async (address, _message, candidate) => address === expectedSigner && candidate === signature,
  verifyCreation: async (call) => call.merchant === merchant && call.txHash === hash && call.amount === 10000000000000001n,
});
async function call(action, body, auth, origin = net.origin) {
  const result = await api(new Request('https://fixture.supabase.co/functions/v1/termul-wallet-v1', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ action, ...body }),
  }));
  return { status: result.status, data: await result.json() };
}
const challenge = async (walletAddress = merchant) => {
  const result = await call('challenge', { walletAddress });
  assert.equal(result.status, 200);
  return result.data;
};
const verify = (c, changes = {}) => call('verify', { ...c, signature, ...changes });
assert.equal((await call('challenge', { walletAddress: merchant }, null, 'https://test.termul.xyz')).status, 403);
// Public payment links may show only exact-invoice display fields, not email.
const publicOriginal = await call('public_invoice', scope);
assert.equal(publicOriginal.status, 200);
assert.deepEqual(publicOriginal.data.invoice, {
  clientName: 'Original merchant metadata', description: 'Legacy services',
});
assert.equal(JSON.stringify(publicOriginal.data).includes('secret@test.invalid'), false);
assert.equal((await call('public_invoice', { ...scope, chainId: 1 })).status, 400);
assert.equal((await call('public_invoice', { ...scope, contractAddress: payer })).status, 400);
assert.equal((await call('public_invoice', { ...scope, merchantAddress: payer })).data.invoice, null);
assert.equal((await call('public_invoice', { ...scope, invoiceId: hash })).data.invoice, null);
const first = await challenge();
assert.equal(parseSiweMessage(first.message).chainId, 5042);
assert.notEqual((await challenge()).message, first.message);
assert.equal((await verify(first, { message: first.message.replace('termul.xyz wants', 'elsewhere.xyz wants') })).status, 401);
assert.equal((await verify(first, { message: first.message.replace('URI: https://termul.xyz', 'URI: https://termul.xyz/other') })).status, 401);
assert.equal((await verify(first, { message: first.message.replace('Chain ID: 5042', 'Chain ID: 1') })).status, 401);
assert.equal((await verify(first, { signature: '0x' + '22'.repeat(65) })).status, 401);
expectedSigner = payer;
assert.equal((await verify(first)).status, 401);
expectedSigner = merchant;
const valid = await challenge();
const replay = await Promise.all([verify(valid), verify(valid)]);
assert.deepEqual(replay.map(x => x.status).sort(), [200, 401]);
const merchantToken = replay.find(x => x.status === 200).data.sessionToken;
const asMerchant = { ...scope, walletAddress: merchant };
assert.equal((await call('get_invoices', asMerchant)).status, 401);
assert.equal((await call('get_invoices', { ...asMerchant, walletAddress: payer }, merchantToken)).status, 403);
assert.equal((await call('get_invoices', { ...asMerchant, merchantAddress: payer }, merchantToken)).status, 403);
assert.equal((await call('get_invoices', { ...asMerchant, chainId: 1 }, merchantToken)).status, 400);
assert.equal((await call('get_invoices', { ...asMerchant, contractAddress: payer }, merchantToken)).status, 400);
assert.deepEqual((await call('get_invoices', asMerchant, merchantToken)).data.invoices, [legacy]);
const write = { ...asMerchant, invoiceId: hash, createTxHash: hash, amountNative: legacy.amount_native, expiresAt: '0',
  clientName: 'Client', clientEmail: 'client@example.test', description: 'Work' };
assert.equal((await call('save_invoice', { ...write, merchantAddress: payer }, merchantToken)).status, 403);
assert.equal((await call('save_invoice', { ...write, amountNative: '100' }, merchantToken)).status, 422);
assert.equal((await call('save_invoice', write, merchantToken)).data.invoice.amount_native, legacy.amount_native);
assert.deepEqual((await call('public_invoice', { ...scope, invoiceId: hash })).data.invoice, {
  clientName: 'Client', description: 'Work',
});
assert.equal((await call('save_invoice', { ...write, invoiceId }, merchantToken)).data.invoice.client_name, legacy.client_name);
assert.deepEqual(rows('termul_mainnet_invoices'), [legacy]);
assert.equal((await call('save_profile', { walletAddress: merchant, displayName: 'Merchant' }, merchantToken)).status, 200);

expectedSigner = payer;
const payerToken = (await verify(await challenge(payer))).data.sessionToken;
const asPayer = { ...scope, walletAddress: payer };
assert.equal((await call('get_invoices', asPayer, payerToken)).status, 403);
rows('termul_mainnet_payment_attempts').push({
  chain_id: 5042, contract_address: net.contractAddress, merchant_address: merchant, invoice_id: invoiceId,
  payer_address: payer, tx_hash: hash, updated_at: new Date(now).toISOString(),
});
assert.equal((await call('get_payment_attempt', asMerchant, merchantToken)).data.attempt, null);
assert.equal((await call('get_payment_attempt', asPayer, payerToken)).data.attempt.tx_hash, hash);
assert.equal((await call('reserve_payment_attempt', asPayer, payerToken)).status, 409);
assert.equal((await call('clear_payment_attempt', asPayer, payerToken)).status, 200);
assert.equal(rows('termul_mainnet_payment_attempts').length, 1);
const reserved = await Promise.all([
  call('reserve_payment_attempt', asPayer, payerToken), call('reserve_payment_attempt', asPayer, payerToken),
]);
assert.deepEqual(reserved.map(x => x.status).sort(), [200, 409]);
const attemptId = reserved.find(x => x.status === 200).data.attemptId;
assert.equal((await call('save_payment_attempt', { ...asPayer, attemptId, transactionHash: hash }, payerToken)).status, 200);
assert.equal((await call('get_payment_attempt', asPayer, payerToken)).data.attempt.tx_hash, hash);
assert.equal((await call('get_payment_attempt', asMerchant, merchantToken)).data.attempt, null);

const expires = await challenge(payer);
now += 7 * 60_000;
assert.equal((await verify(expires)).status, 401);
assert.equal((await call('save_profile', { walletAddress: payer, displayName: 'Payer' }, payerToken)).status, 401);
assert.equal((await call('logout', asPayer, payerToken)).status, 200);
assert.equal((await call('get_profile', asPayer, payerToken)).status, 401);
now += 6 * 60_000;
assert.equal((await call('get_profile', asMerchant, merchantToken)).status, 401);
assert.equal((await call('challenge', { walletAddress: payer, filler: 'a'.repeat(17_000) })).status, 413);
for (let n = 0; n < 5; n++) await challenge(payer);
assert.equal((await call('challenge', { walletAddress: payer })).status, 429);

// Public viem recovery fixture. No signing or private key is used.
const known = '0xa461f509887bd19e312c0c58467ce8ff8e300d3c1a90b608a760c5b80318eaf15fe57c96f9175d6cd4daad4663763baa7e78836e067d0163e9a2ccf2ff753f5b1b';
const knownSigner = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const client = { getChainId: async () => 5042, getCode: async () => undefined };
assert.equal(await createEOAVerifier({ client, recoverMessageAddress })(knownSigner, 'hello world', known), true);
assert.equal(await createEOAVerifier({ client, recoverMessageAddress })(payer, 'hello world', known), false);
assert.equal(await createEOAVerifier({ client: { ...client, getCode: async () => '0x6000' }, recoverMessageAddress })(knownSigner, 'hello world', known), false);
assert.equal(await createEOAVerifier({ client: { ...client, getChainId: async () => 1 }, recoverMessageAddress })(knownSigner, 'hello world', known), false);
console.log('SIWE, replay, session, rate, EOA recovery, and wallet-scoped metadata tests passed.');
