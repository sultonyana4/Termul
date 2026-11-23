# Termul

Termul creates and settles invoices in native USDC on Arc Mainnet. The wallet-native app uses Wagmi Core, Viem, and Termul’s injected-wallet picker. Invoices and the custom USDC/EURC swap require Arc Mainnet. Any Token supports selected production networks. A verified wallet signature authorizes access to protected metadata.

The existing TermulInvoices deployment is pinned in source. Invoice status comes from Arc, including when the metadata service is unavailable. Public links contain the merchant, invoice ID, chain ID, and contract address.

Use Node.js 22 to install, build, and run offline regression scripts.

```bash
npm ci
npm run build
npm run test:wallet
npm run test:siwe
npm run test:metadata
npm run test:profile
npm run test:invoice-creation
npm run test:payment-result
npm run test:arc-network
npm run test:transaction-dialog
npm run test:swap
npm run test:any-token
```

Live wallet verification requires the exact HTTPS production origin. The offline fixtures do not use a real signature, wallet, or blockchain transaction. See the [wallet migration runbook](docs/WALLET_MIGRATION.md) and [security review](docs/SECURITY_REVIEW.md).

## Phase 1 browser acceptance

Run `npm run dev -- --host 127.0.0.1` and open the printed local URL in a private window. Start on the public overview. Check that desktop and mobile navigation contain Home, Create, and Swap. Use **Create invoice** to open the protected creation flow and **How payments work** to expand the explanation without leaving Home. Guests see no private balances or payment history. When connected, open the top-right wallet control for the full address, verification, display name, and disconnect.

For a read-only link check, paste the query string from a known Arc Mainnet invoice link onto the local URL. A Paid invoice with verified receipt evidence offers **View transaction status**. Check the amount, hash, Arc Explorer destination, copy action, and focus return after Escape or Done. Leave any Pay action untouched during read-only checks.

Use the [offline Chromium fixture instructions](docs/WALLET_MIGRATION.md#offline-chromium-smoke-test) to verify wallet and SIWE behavior with mocked providers and RPC. Run `npm run test:arc-network` for simulated creation, approval, submission, confirmation, rejection, and duplicate-submission checks. The localhost build cannot complete SIWE against the production-origin configuration.

## Phase 2 swap acceptance

1. Run `npm run dev -- --host 127.0.0.1` and open `http://127.0.0.1:5173/` if that is the URL Vite prints. Select **Swap**. Enter `10`, wait for the quote, and switch directions. Check the estimate, minimum received, provider and network fees, 0% Termul fee, and mobile layout.
2. For a read-only wallet check, connect Rabby or MetaMask, select Arc Mainnet, and check balances, **Max**, and **Review swap**. Close the review with **Cancel** before sending any transaction. Swap access uses the wallet connection without SIWE. Connected-wallet quotes send the public wallet address to LI.FI.
3. Use `npm run test:swap` for mocked approval and swap execution. The [offline Chromium fixture](docs/WALLET_MIGRATION.md#offline-chromium-smoke-test) also covers guest quotes, mobile review, and reopening a verified swap result after refresh.

Swap executes the reviewed LI.FI Fly route only, using both Circle tokens’ six-decimal ERC-20 interfaces. Arc network fees use native USDC with 18 decimals. Unsupported routing changes and expired quotes require a fresh review. Approval is a separate, exact-amount transaction when allowance is insufficient. A confirmed approval can remain in place if the quote expires, the swap is rejected, or the swap reverts. [Arc contracts](https://docs.arc.io/arc/references/contract-addresses) · [LI.FI Arc deployments](https://github.com/lifinance/contracts/blob/main/deployments/arc.json)

The last swap request is stored locally for the selected wallet. After a reload, use **Check status**. If the wallet did not return a hash, enter one from your wallet activity. Termul checks the stored request against the Arc transaction and receipt. An unresolved request remains blocked rather than being sent again. This recovery is specific to the browser profile.

The locally hosted [USDC token SVG](public/brand/usdc.svg) and [EURC token SVG](public/brand/eurc.svg) are the unmodified token marks from the official [Circle Brand Kit](https://www.circle.com/pressroom#brandkit). The Arc Mainnet badge uses text and a status dot.

## Phase 3 Any Token acceptance

1. Run `npm ci` and `npm run dev -- --host 127.0.0.1`. Open the local URL Vite prints. Select **Swap → Any Token** as a guest. Arc is the initial source and Base is the initial destination. Choose tokens and an amount, compare the route, estimated output and costs, and reverse the direction. Try a same-chain quote by changing the destination network to match the source. Availability depends on the pair and LI.FI’s current routes.
2. For a read-only wallet check, connect Rabby or MetaMask from the exchange and confirm the selected account matches Termul’s account menu. Browse quotes and balances and stop before initiating execution. Return to **USDC & EURC** to check the custom Arc swap. Open a known invoice link locally to check public payment access. SIWE for protected merchant features uses the production origin.
3. Run `npm run test:any-token` for mocked execution and settlement. The [offline Chromium fixture](docs/WALLET_MIGRATION.md#offline-chromium-smoke-test) also renders the official Widget at six viewport widths and checks a stored Arc-to-Base transfer against mocked source and destination receipts.

The official LI.FI Widget loads on demand in an isolated React root and shares Termul’s Wagmi configuration and wallet picker. The full Widget’s Ethereum provider supports disabling permit signatures and checking the SDK’s prepared transactions before handing them to the selected wallet. It requests a source-chain switch during route execution. Termul’s platform fee is 0%. LI.FI prices the provider, bridge, and network costs. [LI.FI Widget overview](https://docs.li.fi/widget/overview) · [Wallet management](https://docs.li.fi/widget/wallet-management)

The selector intersects Termul’s production mainnet allowlist with LI.FI’s live EVM catalog. The observed catalog included Arc, Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Linea, Unichain, World Chain, Sonic, Sei, XDC, Ink, Plume, Monad, and Morph. Codex is configured in the allowlist and appears in the selector only when LI.FI lists it. Termul accepts a reviewed single-step LI.FI route and separately checks any exact-amount approval. Provider availability and quote expiration can require a fresh route.

The most recent exchange is kept in the current browser profile for each wallet. Reopen **Any Token** with that wallet and use **Check status** or **View receipt**. If the wallet response was ambiguous, paste the hash from wallet activity to verify it against the stored request. Source confirmation is followed by a separate settlement check. The receipt uses independently verified ERC-20 balance movements from transaction logs where available. Native destination amounts depend on LI.FI’s settlement data and a successful destination receipt. Refunds, partial routes and unverified transfers have separate states. [LI.FI transfer status](https://docs.li.fi/api-reference/check-the-status-of-a-cross-chain-transfer)
