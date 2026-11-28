import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TERMUL_MAINNET as network } from '../../supabase/functions/_shared/termul-mainnet.js';
import { createOperations } from './operations.js';
import { openPilotJournal } from './pilot-journal.js';
import { openLocalMetadata } from './local-metadata.js';

const account = '0x5042000000000000000000000000000000000001';
const other = '0x5042000000000000000000000000000000000002';
const invoiceId = '0x' + 'a1'.repeat(32);
const txHash = '0x' + 'b2'.repeat(32);
const scope = { merchantAddress: account, invoiceId, chainId: 5042, contractAddress: network.contractAddress };

test('local metadata requires matching journal proof and strips private data from payment links', t => {
  const dir = mkdtempSync(join(tmpdir(), 'termul-local-metadata-'));
  const journal = openPilotJournal(join(dir, 'attempts.sqlite'));
  const metadata = openLocalMetadata(join(dir, 'metadata.sqlite'), journal);
  t.after(() => { metadata.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const details = { ...scope, metadataAction: 'save_invoice', createTxHash: txHash, amountNative: '10000000000000000',
    expiresAt: '1800000000', clientName: 'Test client', clientEmail: 'private@example.test', description: 'Review invoice' };
  assert.throws(() => metadata.request({ address: other }, details), { status: 403 });
  assert.throws(() => metadata.request({ address: account }, details), { status: 409 });
  const record = { invoiceId, walletAddress: account, expiresAt: details.expiresAt, status: 'requesting' };
  assert.ok(journal.reserve(record));
  journal.update(record, { status: 'verified', transactionHash: txHash });
  assert.equal(metadata.request({ address: account }, details).invoice.client_email, 'private@example.test');
  assert.deepEqual(metadata.publicInvoice(scope), { invoice: { clientName: 'Test client', description: 'Review invoice' } });
  assert.throws(() => metadata.publicInvoice({ ...scope, chainId: 1 }), { status: 400 });
});

test('unresolved managed attempts are shared across payments without duplicate reservation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'termul-local-payment-'));
  const journal = openPilotJournal(join(dir, 'attempts.sqlite'));
  const metadata = openLocalMetadata(join(dir, 'metadata.sqlite'), journal);
  t.after(() => { metadata.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const record = { invoiceId, walletAddress: other, attemptId: 'alpha', paymentKey: account + ':' + invoiceId,
    status: 'requesting', transactionHash: null };
  assert.ok(journal.reserve(record));
  assert.equal(journal.reserve({ ...record, walletAddress: account, attemptId: 'beta' }), false);
  assert.equal(metadata.request({ address: other }, { ...scope, metadataAction: 'get_payment_attempt' }).attempt.attempt_id, 'alpha');
  assert.equal(metadata.request({ address: account }, { ...scope, metadataAction: 'get_payment_attempt' }).attempt, null);
  journal.update(record, { status: 'reverted' });
  assert.ok(journal.reserve({ ...record, walletAddress: account, attemptId: 'beta' }));
});

test('PoC and app share the bounded OTP rate limiter', async () => {
  const otpState = { next: 0, requests: [], pending: false };
  let now = 0;
  let requests = 0;
  const circle = { createDeviceTokenForEmailLogin: async () => {
    requests++;
    return { data: { otpToken: 'mock', deviceToken: 'mock', deviceEncryptionKey: 'mock' } };
  } };
  const options = { circle, testEmail: 'approved@example.test', now: () => now, otpState };
  const clients = [createOperations(options), createOperations(options)];
  const request = { action: 'otp', email: options.testEmail, deviceId: '00000000-0000-4000-8000-000000000001' };
  for (let i = 0; i < 5; i++) {
    await clients[i % 2](request);
    now += 30_000;
  }
  await assert.rejects(clients[1](request), { status: 429 });
  assert.equal(requests, 5);
});
