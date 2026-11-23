import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import * as domain from '../supabase/functions/aruspay-api/domain.js';

const subject = 'did:privy:edge-test';
const merchant = '0x1234567890abcdef1234567890abcdef12345678';
const invoiceId = `0x${'ab'.repeat(32)}`;
const operations = [];
let handler;
function builder(table) {
  const operation = { table, filters: [] };
  operations.push(operation);
  const result = () => ({ data: operation.row || (table === 'profiles' ? null : []), error: null });
  const query = {
    select(columns) { operation.columns = columns; return query; },
    eq(column, value) { operation.filters.push([column, value]); return query; },
    order() { return query; },
    limit() { return query; },
    upsert(row) { operation.row = row; return query; },
    delete() { operation.deleted = true; return query; },
    maybeSingle() { return Promise.resolve(result()); },
    single() { return Promise.resolve(result()); },
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
  };
  return query;
}
const jwtVerify = async (token, _jwks, options) => {
  assert.equal(options.issuer, domain.PRIVY_ISSUER);
  assert.equal(options.audience, domain.PRIVY_APP_ID);
  assert.deepEqual(options.algorithms, ['ES256']);
  const lifetime = { iat: 1, exp: 9_999_999_999 };
  let payload;
  if (token === 'access') payload = { sub: subject, sid: 'session-fixture', ...lifetime };
  if (token === 'identity') payload = { sub: subject, ...lifetime, linked_accounts: JSON.stringify([{ type: 'wallet', address: merchant }]) };
  if (token === 'wrong-user') payload = { sub: 'did:privy:other', ...lifetime, linked_accounts: [{ type: 'wallet', address: merchant }] };
  if (token === 'wrong-wallet') payload = { sub: subject, ...lifetime, linked_accounts: [] };
  if (token === 'no-expiry') payload = { sub: subject, iat: 1, sid: 'session-fixture' };
  if (payload && options.requiredClaims.every((claim) => Object.hasOwn(payload, claim))) return { payload };
  throw new Error('Invalid token');
};
const source = await readFile(new URL('../supabase/functions/aruspay-api/index.ts', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'index.ts', { format: 'cjs', target: 'es2022' });
const requireMock = (name) => {
  if (name.startsWith('jsr:')) return {};
  if (name.includes('@supabase/supabase-js')) return { createClient: () => ({ from: builder }) };
  if (name.includes('/jose@')) return { createRemoteJWKSet: () => ({}), jwtVerify };
  if (name === './domain.js') return domain;
  throw new Error(`Unexpected dependency: ${name}`);
};
function configureEdge(mainnetAddress, mainnetOrigin) {
  new Function('require', 'Deno', code)(requireMock, {
    env: { get: (key) => ({
      TERMUL_MAINNET_CONTRACT_ADDRESS: mainnetAddress,
      TERMUL_MAINNET_ORIGIN: mainnetOrigin,
      SUPABASE_URL: 'https://example.test',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-value',
    })[key] },
    serve: (callback) => { handler = callback; },
  });
}
configureEdge();
assert.equal(typeof handler, 'function');
const invoice = {
  chainId: domain.ARC_CHAIN_ID,
  contractAddress: domain.ARUSPAY_CONTRACT_ADDRESS,
  merchantAddress: merchant,
  invoiceId,
  amountNative: '1000000000000000000',
  createTxHash: `0x${'cd'.repeat(32)}`,
  description: 'Test-only isolated fixture',
  merchant_privy_user_id: 'did:privy:forged',
  status: 'paid',
};
async function request(action, { identity, access = 'access', origin = domain.PRODUCTION_ORIGIN, payload = {} } = {}) {
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  if (access) headers.Authorization = `Bearer ${access}`;
  if (identity) headers['X-Privy-Identity-Token'] = identity;
  const before = operations.length;
  const response = await handler(new Request('https://example.test/aruspay-api', {
    method: 'POST', headers, body: JSON.stringify({ action, expectedPrivyUserId: subject, ...payload }),
  }));
  return { response, operations: operations.slice(before) };
}
for (const identity of [undefined, 'wrong-user', 'wrong-wallet', 'invalid']) {
  for (const action of ['get_invoices', 'save_invoice']) {
    const result = await request(action, { identity, payload: { merchantAddress: merchant, invoice } });
    assert.equal(result.response.status, 403, `${action} must reject missing or mismatched linked-wallet proof`);
    assert.equal(result.operations.length, 0, 'Authorization must run before database access.');
  }
}
const read = await request('get_invoices', { identity: 'identity', payload: { merchantAddress: merchant } });
assert.equal(read.response.status, 200);
assert.deepEqual(read.operations[0].filters, [
  ['merchant_privy_user_id', subject], ['chain_id', domain.ARC_CHAIN_ID],
  ['contract_address', domain.ARUSPAY_CONTRACT_ADDRESS], ['merchant_address', merchant],
]);
const save = await request('save_invoice', { identity: 'identity', payload: { invoice } });
assert.equal(save.response.status, 200);
assert.equal(save.operations[0].row.merchant_privy_user_id, subject);
assert.equal(Object.hasOwn(save.operations[0].row, 'status'), false);
const unauthenticated = await request('get_profile', { access: null });
assert.equal(unauthenticated.response.status, 401);
assert.equal(unauthenticated.operations.length, 0);
for (const access of ['identity', 'no-expiry']) {
  const result = await request('get_profile', { access });
  assert.equal(result.response.status, 401);
  assert.equal(result.operations.length, 0);
}
const callsBeforeLargeBody = operations.length;
let chunksRead = 0;
let canceled = false;
const oversizedStream = new ReadableStream({
  pull(controller) {
    chunksRead++;
    controller.enqueue(new Uint8Array(9 * 1024).fill(0x20));
  },
  cancel() { canceled = true; },
}, { highWaterMark: 0 });
const largeBody = await handler(new Request('https://example.test/aruspay-api', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access' },
  body: oversizedStream,
  duplex: 'half',
}));
assert.equal(largeBody.status, 413);
assert.equal(operations.length, callsBeforeLargeBody);
assert.ok(canceled);
assert.equal(chunksRead, 2);
const wrongAccount = await request('save_profile', { payload: { displayName: 'Stale account', expectedPrivyUserId: 'did:privy:other' } });
assert.equal(wrongAccount.response.status, 403);
assert.equal(wrongAccount.operations.length, 0);
const preview = await request('get_profile', { origin: 'https://aruspay-preview.vercel.app' });
assert.equal(preview.response.status, 403);
assert.equal(preview.operations.length, 0);
const profile = await request('get_profile');
assert.equal(profile.response.status, 200);
assert.deepEqual(profile.operations[0].filters, [['privy_user_id', subject]]);
const mainnetAddress = '0x' + '75'.repeat(20);
const mainnetOrigin = 'https://mainnet.example.test';
const mainnet = { chainId: 5042, contractAddress: mainnetAddress };
const scope = { deployment: mainnet, merchantAddress: merchant, invoiceId };
const disabledMainnet = await request('get_payment_attempt', { payload: scope });
assert.equal(disabledMainnet.response.status, 400);
assert.equal(disabledMainnet.operations.length, 0);

configureEdge(mainnetAddress, mainnetOrigin);
const handshake = await request('get_deployment', { origin: mainnetOrigin, payload: scope });
assert.equal(handshake.response.status, 200);
assert.deepEqual(await handshake.response.json(), { deployment: mainnet });
assert.equal(handshake.operations.length, 0);
assert.equal(handshake.response.headers.get('access-control-allow-origin'), mainnetOrigin);
const invalidDeployment = await request('get_payment_attempt', {
  payload: { ...scope, deployment: { ...mainnet, contractAddress: domain.ARUSPAY_CONTRACT_ADDRESS } },
});
assert.equal(invalidDeployment.response.status, 400);
assert.equal(invalidDeployment.operations.length, 0);
const wrongNetworkInvoice = await request('save_invoice', { identity: 'identity', payload: { ...scope, invoice } });
assert.equal(wrongNetworkInvoice.response.status, 400);
assert.equal(wrongNetworkInvoice.operations.length, 0);
const mainnetSave = await request('save_invoice', { identity: 'identity', payload: { ...scope, invoice: { ...invoice, ...mainnet } } });
assert.equal(mainnetSave.response.status, 200);
assert.equal(mainnetSave.operations[0].table, 'termul_mainnet_invoices');
assert.equal(mainnetSave.operations[0].row.chain_id, 5042);
assert.equal(mainnetSave.operations[0].row.contract_address, mainnetAddress);
const spoofedMainnetRead = await request('get_invoices', { identity: 'wrong-wallet', payload: scope });
assert.equal(spoofedMainnetRead.response.status, 403);
assert.equal(spoofedMainnetRead.operations.length, 0);
const mainnetHint = await request('save_payment_attempt', { payload: { ...scope, payerAddress: merchant } });
assert.equal(mainnetHint.response.status, 200);
assert.equal(mainnetHint.operations[0].table, 'termul_mainnet_payment_attempts');
assert.equal(mainnetHint.operations[0].row.payer_privy_user_id, subject);
const mainnetClear = await request('clear_payment_attempt', { payload: scope });
assert.deepEqual(mainnetClear.operations[0].filters, [
  ['chain_id', 5042], ['contract_address', mainnetAddress], ['merchant_address', merchant],
  ['invoice_id', invoiceId], ['payer_privy_user_id', subject],
]);
const legacyHint = await request('get_payment_attempt', { payload: { merchantAddress: merchant, invoiceId } });
assert.equal(legacyHint.response.status, 200);
assert.equal(legacyHint.operations[0].table, 'payment_attempts');
assert.deepEqual(legacyHint.operations[0].filters.slice(0, 2), [
  ['chain_id', domain.ARC_CHAIN_ID], ['contract_address', domain.ARUSPAY_CONTRACT_ADDRESS],
]);
console.log('Edge Function route authorization tests passed (mocked JWT/database only; no network or transactions).');
