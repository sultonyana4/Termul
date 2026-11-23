import { arcNetwork } from './arc-network.js';

const scope = { chainId: arcNetwork.id, contractAddress: arcNetwork.contractAddress };
const pendingWrites = new Map();
function request(action, payload, expectedAddress) {
  const session = window.termulWallet?.session;
  if (!session) return Promise.reject(new Error('Connect and verify your wallet to access Termul metadata.'));
  return session.request(action, { ...scope, ...payload }, expectedAddress);
}

function writeAttempt(action, merchantAddress, invoiceId, attempt = {}) {
  const address = window.termulCurrentWalletAddress;
  const key = `${address}:${merchantAddress.toLowerCase()}:${invoiceId.toLowerCase()}`;
  const previous = pendingWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() =>
    request(action, { merchantAddress, invoiceId, ...attempt }, address));
  pendingWrites.set(key, pending);
  const cleanup = () => { if (pendingWrites.get(key) === pending) pendingWrites.delete(key); };
  pending.then(cleanup, cleanup);
  return pending;
}

export const metadataApi = Object.freeze({
  getProfile: () => request('get_profile'),
  saveProfile: (displayName) => request('save_profile', { displayName }),
  listInvoices: (merchantAddress) => request('get_invoices', { merchantAddress }),
  saveInvoice: (invoice) => request('save_invoice', invoice, invoice.merchantAddress),
  getPaymentAttempt: (merchantAddress, invoiceId) => request('get_payment_attempt', { merchantAddress, invoiceId }),
  reservePaymentAttempt: (merchantAddress, invoiceId) => request('reserve_payment_attempt', { merchantAddress, invoiceId }),
  savePaymentAttempt: (merchantAddress, invoiceId, attemptId, transactionHash) => writeAttempt(
    'save_payment_attempt', merchantAddress, invoiceId, { attemptId, transactionHash },
  ),
  clearPaymentAttempt: (merchantAddress, invoiceId, attemptId) => writeAttempt(
    'clear_payment_attempt', merchantAddress, invoiceId, { attemptId },
  ),
});

if (typeof window !== 'undefined') window.arusPayMetadata = metadataApi;
