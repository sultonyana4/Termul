import { arcNetwork } from './arc-network.js';
import { endpointFor } from './wallet-session.js';

const scope = { chainId: arcNetwork.id, contractAddress: arcNetwork.contractAddress };
const pendingWrites = new Map();
function request(action, payload, expectedAddress) {
  const session = window.termulWallet?.session;
  if (!session) return Promise.reject(new Error('Connect and verify your wallet to access Termul metadata.'));
  return session.request(action, { ...scope, ...payload }, expectedAddress);
}

// Only public display metadata travels on this unauthenticated path.
// The service returns neither client email nor merchant profile details.
async function publicInvoice(merchantAddress, invoiceId) {
  const endpoint = endpointFor(import.meta.env.VITE_TERMUL_WALLET_API_URL);
  if (!endpoint || typeof window === 'undefined' || window.location.origin !== arcNetwork.origin) return null;
  try {
    const result = await fetch(endpoint, {
      method: 'POST', credentials: 'omit', mode: 'cors', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scope, action: 'public_invoice', merchantAddress, invoiceId }),
    });
    if (!result.ok) return null;
    const payload = await result.json();
    return payload?.invoice && typeof payload.invoice.clientName === 'string'
      && typeof payload.invoice.description === 'string' ? payload.invoice : null;
  } catch {
    // Metadata cannot override or prevent authoritative on-chain payment display.
    return null;
  }
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
  publicInvoice,
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
