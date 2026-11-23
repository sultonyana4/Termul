import assert from 'node:assert/strict';
import { metadataApi } from '../src/metadata-api.js';
import { arcNetwork } from '../src/arc-network.js';

const merchant = '0x' + 'aa'.repeat(20);
const invoice = '0x' + 'bb'.repeat(32);
const hash = '0x' + 'cc'.repeat(32);
const attempt = 'abcdef01-2345-6789-0123-456789abcdef';
const calls = [];
let finishWrite;
globalThis.window = { termulCurrentWalletAddress: merchant, termulWallet: { session: {
  request(action, body, expectedAddress) {
    calls.push({ action, body, expectedAddress });
    return action === 'save_payment_attempt' ? new Promise(resolve => { finishWrite = resolve; }) : Promise.resolve({});
  },
} } };
await metadataApi.listInvoices(merchant);
assert.deepEqual(calls[0].body, { chainId: 5042, contractAddress: arcNetwork.contractAddress, merchantAddress: merchant });
await metadataApi.saveInvoice({ merchantAddress: merchant, invoiceId: invoice, createTxHash: hash });
assert.equal(calls[1].expectedAddress, merchant);
const pending = metadataApi.savePaymentAttempt(merchant, invoice, attempt, hash);
const clear = metadataApi.clearPaymentAttempt(merchant, invoice, attempt);
while (!finishWrite) await Promise.resolve();
assert.equal(calls.at(-1).action, 'save_payment_attempt');
assert.equal(calls.at(-1).body.attemptId, attempt);
window.termulCurrentWalletAddress = '0x' + 'dd'.repeat(20);
finishWrite();
await Promise.all([pending, clear]);
assert.equal(calls.at(-1).action, 'clear_payment_attempt');
assert.equal(calls.at(-1).expectedAddress, merchant);
delete globalThis.window;
console.log('Wallet metadata scoping and queued attempt identity tests passed.');
