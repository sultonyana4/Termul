import { arcNetwork } from './arc-network.js';

const DEFAULT_ARUSPAY_API_URL = 'https://xudcqwfyrfsjrjxbcssy.supabase.co/functions/v1/aruspay-api';
const configuredApiUrl = import.meta.env?.VITE_ARUSPAY_API_URL;
const testnetApiUrl = configuredApiUrl || DEFAULT_ARUSPAY_API_URL;
const isMainnet = arcNetwork.chain?.testnet === false;
const paymentAttemptWrites = new Map();
const currentUserId = () => globalThis.window?.arusPayCurrentPrivyUserId || null;

async function request(action, payload = {}, expectedUserId = currentUserId()) {
  const invoiceAction = action !== 'get_profile' && action !== 'save_profile';
  if (invoiceAction && arcNetwork.error) throw new Error(arcNetwork.error);
  const deployment = invoiceAction && isMainnet
    ? { chainId: arcNetwork.chain.id, contractAddress: arcNetwork.contractAddress }
    : undefined;
  const apiUrl = isMainnet ? arcNetwork.metadataUrl : testnetApiUrl;
  if (!apiUrl) throw new Error('The Arc Mainnet metadata endpoint is unavailable.');
  if (!expectedUserId) throw new Error('Sign in with Privy to sync Termul metadata.');
  const assertSameUser = () => {
    if (currentUserId() !== expectedUserId) throw new Error('Your Privy account changed. Retry from the current account.');
  };
  assertSameUser();
  const accessToken = await globalThis.window?.arusPayPrivy?.getAccessToken?.();
  assertSameUser();
  if (!accessToken) throw new Error('Sign in with Privy to sync Termul metadata.');

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (action === 'get_invoices' || action === 'save_invoice') {
    const identityToken = await globalThis.window?.arusPayPrivy?.getIdentityToken?.();
    assertSameUser();
    if (!identityToken) throw new Error('Privy identity tokens must be enabled to sync invoice metadata securely.');
    headers['X-Privy-Identity-Token'] = identityToken;
  }

  const post = async (body) => {
    const response = await fetch(apiUrl, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers,
      body: JSON.stringify({ ...body, deployment, expectedPrivyUserId: expectedUserId }),
    });
    let result = null;
    try {
      result = await response.json();
    } catch {
      // Keep backend details out of the browser error surface.
    }
    assertSameUser();
    if (!response.ok) {
      if (response.status === 401) throw new Error('Your Privy session could not be verified. Sign in again and retry.');
      throw new Error(result?.error || 'Termul cloud metadata is temporarily unavailable.');
    }
    return result || {};
  };
  if (deployment) {
    const { deployment: approved } = await post({ action: 'get_deployment' });
    if (approved?.chainId !== deployment.chainId || approved?.contractAddress !== deployment.contractAddress) {
      throw new Error('The metadata server did not confirm the configured mainnet deployment.');
    }
  }
  return post({ action, ...payload });
}

function queuePaymentAttempt(action, payload) {
  const userId = currentUserId();
  const key = `${userId}:${payload.merchantAddress.toLowerCase()}:${payload.invoiceId.toLowerCase()}`;
  const previous = paymentAttemptWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => request(action, payload, userId));
  paymentAttemptWrites.set(key, pending);
  const cleanup = () => { if (paymentAttemptWrites.get(key) === pending) paymentAttemptWrites.delete(key); };
  pending.then(cleanup, cleanup);
  return pending;
}

export const metadataApi = Object.freeze({
  getProfile: () => request('get_profile'),
  saveProfile: (displayName) => request('save_profile', { displayName }),
  listInvoices: (merchantAddress) => request('get_invoices', { merchantAddress }),
  saveInvoice: (invoice) => request('save_invoice', { invoice }),
  getPaymentAttempt: (merchantAddress, invoiceId) => request('get_payment_attempt', { merchantAddress, invoiceId }),
  savePaymentAttempt: (merchantAddress, invoiceId, payerAddress, transactionHash = null) => queuePaymentAttempt(
    'save_payment_attempt',
    { merchantAddress, invoiceId, payerAddress, transactionHash },
  ),
  clearPaymentAttempt: (merchantAddress, invoiceId) => queuePaymentAttempt('clear_payment_attempt', { merchantAddress, invoiceId }),
});

if (typeof window !== 'undefined') window.arusPayMetadata = metadataApi;
