import { getAddress, isAddress } from 'viem';
import { createInvoicePilot, PilotError } from '../../experiments/circle-wallet-poc/invoice-pilot.js';
import { createCircleSwap, swapDisplayAssets } from '../../experiments/circle-wallet-poc/circle-swap.js';
import { isUuid } from '../../experiments/circle-wallet-poc/pilot-reconciliation.js';
import { createCircleLifi } from './lifi.js';
import { createCircleBridge } from './bridge.js';
import { hash } from './postgrest.js';

import { deny, json, readJson, requireTermulOrigin } from './http.js';
const common = ['action', 'userToken'];
const actions = {
  review: ['kind', 'invoiceId', 'merchant', 'amountBase', 'expiresAt'],
  execute: ['reviewId', 'confirmed'],
  status: [],
  history: [],
  'swap-review': ['from', 'to', 'amount', 'anyToken'],
  'swap-execute': ['reviewId', 'confirmed'],
  'swap-status': [],
  'bridge-review': ['amount'], 'bridge-execute': ['reviewId', 'confirmed'],
  'lifi-review': ['fromChain','toChain','amount'], 'lifi-execute': ['reviewId','confirmed'],
  'lifi-status': [], 'lifi-history': [], 'lifi-close': [],
  'bridge-status': [], 'bridge-history': [], 'bridge-close': [],
};

const historyItem = ({ kind, phase, status, invoiceId, merchant, amountBase, transactionHash, createdAt, gasUsed, costUsdc, verificationSource, allowanceValue, anyToken, assets, from, to }) =>
  ({ kind, phase, status, invoiceId, merchant, amountBase, transactionHash, createdAt, gasUsed, costUsdc, verificationSource, allowanceValue, anyToken, from, to,
    assets: swapDisplayAssets(assets) });

export function createManagedCircleApi({ circle, arc, store, enabled = false, allowExecution = false, allowArcSwap = false, allowArcAnyToken = false,
  maxArcSwapNetworkFeeUsdc, anyTokenFetcher, lifiOptions, base, loadPolicy, now = Date.now, network }) {
  const pilot = enabled && createInvoicePilot({ circle, arc, appEnabled: allowExecution, paymentEnabled: allowExecution,
    journal: store.journal, reviews: store.reviews, now, network });

  const swap = enabled && createCircleSwap({ circle, arc, journal: store.journal,
    reviews: store.reviews, loadPolicy, enabled: allowExecution && allowArcSwap, allowAnyToken: allowArcAnyToken, now,
    requireFeeCeiling: true, maxNetworkFeeUsdc: maxArcSwapNetworkFeeUsdc, anyTokenFetcher });

  const bridge = enabled && createCircleBridge({ circle, arc, base, store: store.bridges, now, loadPolicy });

  const lifi = enabled && createCircleLifi({ circle, store: store.lifi, loadPolicy, now, ...lifiOptions, enabled: false });

  return async function handle(request) {
    if (!enabled) return json({ error: 'Circle managed invoices are disabled.' }, 404);
    try {
      requireTermulOrigin(request);
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!bearer) deny(401, 'A wallet ownership session is required.');
      const session = await store.session(bearer);
      if (!session?.wallet_address) deny(401, 'Verify control of the selected wallet.');
      const input = await readJson(request);
      if (!input || typeof input !== 'object' || !Object.hasOwn(actions, input.action)
        || Object.keys(input).some(key => !common.includes(key) && !actions[input.action].includes(key))
        || typeof input.userToken !== 'string' || !input.userToken || input.userToken.length > 4096) deny(400, 'Invalid Circle request.');
      if (input.action === 'review' && !['payment', 'app-creation'].includes(input.kind)) deny(400, 'Invalid invoice operation.');
      if (['bridge-review', 'bridge-execute', 'lifi-review', 'lifi-execute'].includes(input.action)) {
        deny(403, 'New Circle transactions are available on Arc Mainnet only. You can still check previous transfers.');
      }
      if (['swap-execute', 'swap-review'].includes(input.action) && (!allowExecution || !allowArcSwap)) {
        deny(403, 'Managed Arc swaps are disabled.');
      }
      if (input.action.startsWith('bridge-') && !store.bridges) deny(403, 'Circle bridge storage is unavailable.');
      if (input.action.startsWith('lifi-') && !store.lifi) deny(403, 'Circle LI.FI storage is unavailable.');
      if (['execute', 'swap-execute'].includes(input.action) && (!allowExecution || !isUuid(input.reviewId) || input.confirmed !== true)) deny(403, 'Managed execution requires an active review and explicit approval.');
      if (!await store.rate('circle:' + session.wallet_address, 24)) deny(429, 'Too many requests. Try again shortly.');
      const getSelectedWallet = async () => {
        const response = await circle.listWallets({ userToken: input.userToken, blockchain: 'ARC', pageSize: 50 });
        const wallets = response.data?.wallets;
        if (!Array.isArray(wallets) || wallets.length >= 50) deny(409, 'Circle wallet selection is unavailable.');
        const candidates = wallets.filter(w => w?.blockchain === 'ARC' && w.accountType === 'EOA');
        const wallet = candidates[0];
        if (candidates.length !== 1 || wallet.state !== 'LIVE' || !isUuid(wallet.id) || !isAddress(wallet.address, { strict: false })
          || wallet.address.toLowerCase() !== session.wallet_address) deny(403, 'The Circle wallet does not match the wallet ownership session.');
        return { id: wallet.id, address: getAddress(wallet.address) };
      };
      const wallet = await getSelectedWallet();
      const owner = hash(bearer + ':' + input.userToken);
      const authorize = () => {
        const verifiedAt = Date.parse(session.verified_at);
        if (!Number.isFinite(verifiedAt) || verifiedAt > now() || now() - verifiedAt >= 5 * 60_000) deny(401, 'Verify control of your wallet again.');
      };
      const options = { wallet, userToken: input.userToken, owner, sessionHash: hash(bearer), authorize, async revalidate() {
        const [current, currentWallet] = await Promise.all([store.session(bearer), getSelectedWallet()]);
        if (current?.wallet_address !== session.wallet_address || currentWallet.id !== wallet.id) deny(401, 'The wallet session changed.');
        return currentWallet;
      } };
      if (input.action === 'lifi-status') return json(await lifi.status(options));
      if (input.action === 'lifi-history') return json(await lifi.history(options));
      if (input.action === 'lifi-close') return json(await lifi.close(options));
      if (input.action === 'bridge-status') return json(await bridge.status(options));
      if (input.action === 'bridge-history') return json(await bridge.history(options));
      if (input.action === 'bridge-close') return json(await bridge.close(options));
      if (input.action === 'swap-status') return json(await swap.status(options));
      if (input.action === 'swap-review') return json(await swap.prepare({ ...options, from: input.from, to: input.to, amount: input.amount, anyToken: input.anyToken }));
      if (input.action === 'swap-execute') return json(await swap.execute({ ...options, reviewId: input.reviewId, confirmed: input.confirmed }));
      if (input.action === 'status') {
        const { attempt } = await pilot.status(options);
        return json({ attempt: attempt && { ...historyItem(attempt), walletAddress: attempt.walletAddress,
          invoiceStatusAtReceipt: attempt.invoiceStatusAtReceipt, latestInvoice: attempt.latestInvoice, blockNumber: attempt.blockNumber } });
      }
      if (input.action === 'history') return json({ attempts: (await store.journal.history(wallet.address)).filter(record => record.walletId === wallet.id).map(historyItem) });
      if (input.action === 'review') return json(await pilot.prepare({ ...options, kind: input.kind,
        invoiceId: input.invoiceId, merchant: input.merchant, amountBase: input.amountBase, expiresAt: input.expiresAt }));
      return json(await pilot.execute({ ...options, reviewId: input.reviewId, confirmed: input.confirmed }));
    } catch (error) {
      if (error instanceof PilotError) return json({ error: error.message, code: error.code, feeChanges: error.feeChanges }, error.status);
      if ([155103, 155104, 155105, 155718].includes(error?.code)) return json({ error: 'Circle session is invalid or expired.' }, 401);
      return json({ error: 'Circle managed transactions are temporarily unavailable.' }, 502);
    }
  };
}
