# Termul Circle Wallet local integration

> **Release scope update.** [Circle Wallet Core Phase 1](circle-core-phase1.md) defines the approved Arc-only Circle scope and current acceptance checklist. The implementation and results below are historical. New Circle cross-chain reviews and execution are disabled. Authenticated recovery of existing operations remains available.

See [the feature parity report](circle-feature-parity.md) for the current adapter, backend draft, validation and release blockers.

## Recovery result

The existing pilot journal was backed up using SQLite's backup API before recovery. The database passed `PRAGMA integrity_check` and retained its original invoice row and idempotency key. No schema change was required. The backup is in the ignored `.env.pilot-journal/` directory next to the original database. The verified result was saved through the journal's conditional atomic update.

| Evidence | Result |
| --- | --- |
| Chain and contract | Arc Mainnet 5042, `0x62209ab89631492e7943ef21baee792d430f5d0e` with pinned runtime hash `0x935f2f9ac6d407cbad56cd8f50ad87691ea68626052a2e64fab471153846839f` |
| Transaction | `0xe9b0bcffd545c894b32c99dbe81d4aa6144e9f2fe87a5d5973b2f045b3124244`, block 32911215, exact journaled sender, calldata hash, EIP-1559 limits and zero native value |
| Invoice | `0x851c2e4be40a8e4d12ea275f05641efa8d7815dfe9b00e87e3210f8dfbed3ec3`, exact `InvoiceCreated` event for 0.01 USDC, Open at the receipt block, expired on the later read |
| Gas | 91,651 gas, 0.002783725574483098 native USDC |
| Provider correlation | Transaction ID remains absent in the journal. Evidence is recorded as `arc-hash`. The operator's Circle Console observation is separate. |

The prior implementation dropped errors from challenge retrieval and returned a generic reconciliation error for other failures. The saved row contains a challenge ID, with neither a Circle transaction ID nor a hash. That proves the observation stops before correlation. It does not establish whether the provider rejected a query, returned an unexpected shape, failed to index the reference or was temporarily unavailable. Reproducing the original provider call requires a fresh authenticated Circle session from the operator. The updated PoC exposes sanitized stage, HTTP status, Circle code and known correlation identifiers. Its normal Termul UI uses user-facing status messages. The PoC's **Check Circle provider history (read-only)** button checks the original reference even after Arc recovery without changing the journal. The documented automatic path checks challenge status, lists paginated transactions scoped to the wallet, matches the exact reference and polls the returned transaction ID. A submitted hash is only a candidate for independent proof. [Challenge API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/get-user-challenge) · [Transaction list](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/list-transactions) · [Transaction status](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/get-transaction)

## Transaction review and payments

The initial review can include 10% gas-unit headroom and 5% max-fee and priority-fee headroom. It displays the resulting absolute limits. If the buffered quote exceeds the 0.01 USDC fee ceiling or balance, it displays the unbuffered quote when that quote still fits. Confirmation obtains fresh estimates, verifies sufficient balance and uses the approved absolute fields. A change beyond the reviewed limits requires a new review. The older exact-quote behavior explains why a small estimate increase could trigger rejection, even with the total budget still available.

Circle documents optional display amounts and network fee values in its confirmation screens. Termul's nonpayable creation attaches zero native value. Its invoice amount is an argument in calldata. The blank Circle Total field was not reproduced with the operator's native dialog, and these API facts do not establish its exact rendering cause. Termul's own review displays the invoice amount, attached value and maximum network fee separately. The native Circle confirmation remains in the flow. [Circle Confirmation UIs](https://developers.circle.com/sdks/user-controlled/confirmation-uis)

The payment pilot resolves the merchant and invoice from Arc, encodes `payInvoice(address,bytes32)`, and requires the exact native USDC value from the Open, unexpired invoice. The contract forwards that amount atomically and emits `InvoicePaid` with merchant, payer, invoice ID and amount. The receipt and Paid state are both required. The contract permits payment by the merchant's own address, but a distinct existing payer and merchant provide a clearer live acceptance test. The recovered invoice is expired and is unsuitable. Existing funded wallets and a separately authorized suitable invoice are required for any live payment test. [Contract](../contracts/src/TermulInvoices.sol) · [Payment reconciliation](../src/payment-result.js) · [Managed execution API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge)

## Local application boundary

- **Continue with Email** is additive. A Circle selection has an explicit type and capabilities. It uses its own service and in-memory session. The existing Wagmi/EIP-6963 path continues to connect, restore and switch external wallets. Circle does not expose an injected provider. Switching wallets invalidates the prior active authentication. The app reuses the account address and balance UI, invoice form, payment view, dashboard and Arc reconciliation.
- Circle signs a server-issued, origin-bound SIWE message through its native SDK. Wallet recovery and proof are checked by the verifier against Arc 5042. The local proof expires after five minutes, is bound to the Circle token and selected EOA, and is consumed once. Logout revokes the local proof. The existing production Supabase SIWE endpoint and origin check are unchanged. Local metadata lives in a separate ignored SQLite file. It is wallet-scoped, saves invoice metadata only after matching journal proof, and excludes client email from public links.
- The local server allows only the approved test email. Both PoC and app share a 30-second OTP cooldown, in-flight deduplication, and a five-request rolling 15-minute window. Origin, wallet identity, exact request fields, pinned deployment and calldata are checked on the server. The attempt journal locks unresolved payments across merchant/invoice, including across payer sessions in the same journal. A provider timeout never starts a replacement. The Arc RPC transport includes read methods only.
- Native Arc Circle supports OTP, EOA wallet access, SIWE and managed invoice calls. Creation has prior live evidence. Payment, application integration and resumed provider polling have mocks plus the existing historical Arc evidence as applicable. The gated Circle stablecoin adapter covers the Arc USDC/EURC lane. Circle execution is disabled for general Any Token and cross-chain routes. Native ARC sign-only and fixed managed nonce control are still unavailable for this integration. The current product UI exposes creation and payment. Contract cancellation is not currently exposed as an existing application operation.
- Local metadata supports the configured test account and the local browser origin. A production release needs a reviewed integration with Termul's existing verified session and metadata architecture, shared durable throttling, and production-grade deployment of the journal or an approved replacement. An additive production migration is proposed separately for durable managed invoice reviews and attempts. SQLite creates its isolated tables locally. An in-flight attempt can be recovered after reload, but unsaved form metadata may need re-entry if the browser closes before the verified creation response.

## Start and accept locally

Install dependencies from their respective lockfiles with `npm ci` at the repository root and in `experiments/circle-wallet-poc`. Use the existing ignored Circle credentials. Keep `CIRCLE_API_KEY`, `CIRCLE_APP_ID`, and `CIRCLE_TEST_EMAIL` in the sidecar environment. Only the public App ID and local mode flags cross the config endpoint.

Start the sidecar in one terminal:

```sh
cd experiments/circle-wallet-poc
CIRCLE_TERMUL_LOCAL=enabled CIRCLE_TERMUL_MANAGED=disabled npm start
```

Start Vite from the repository root in another terminal:

```sh
TERMUL_LOCAL_CIRCLE=enabled ./node_modules/.bin/vite --mode circle-local --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://localhost:5173`. Use the hostname `localhost` for the origin-bound flow. The integration flag only exists in the local Vite dev mode. Production artifacts leave it disabled even when the shell flag is set. The standalone PoC remains at `http://localhost:4173`.

1. Start with the feature disabled and verify the existing Connect Wallet path, reconnect and normal payment link display.
2. Enable local mode. Use **Continue with Email** with the existing approved account, verify OTP and then verify SIWE. Check the existing address, balance and wallet copy action. Sign out, sign back in and check the same EOA. Verify metadata switching in both directions.
3. In the PoC use **Check attempt status** on the existing wallet. Confirm the recovered Arc result and current expiry. Use the explicitly labelled hash verification only for unresolved attempts. Keep the journal and backup.
4. Compare an application's quote and amount with independent Arc reads. Confirm unsupported Circle routes remain disabled and the Arc stablecoin adapter only appears when explicitly enabled. Verify external swaps and bridges still use their existing review paths.
5. For a separately authorized local integration transaction, restart the sidecar with `CIRCLE_TERMUL_LOCAL=enabled CIRCLE_TERMUL_MANAGED=enabled npm start`. For a separately authorized standalone payment pilot use `CIRCLE_MANAGED_PAYMENT_PILOT=enabled npm start`. The standalone creation pilot uses `CIRCLE_MANAGED_INVOICE_PILOT=enabled npm start`. All execution flags default to disabled.
6. Exercise decline and a fresh fee review first. For an approved live payment use an Open, unexpired authorized invoice, a distinct suitable payer where available, and the existing funded wallet. Confirm the exact attached USDC and caps in the app, then use Circle's native confirmation. Refresh or re-login with the pending attempt and require the matching Arc receipt, event and invoice state before acceptance.

### OTP email rendering

The supplied checkpoint establishes delivery and successful code entry. It does not include the rendered email or a precise formatting symptom, so the template cause is unverified. Before release, inspect a redacted message in the affected mail clients, confirm any Circle template placeholders survive rendering, and check text and HTML alternatives in light and dark modes. Circle Console and Resend configuration were untouched. [Circle email OTP setup](https://developers.circle.com/wallets/user-controlled/build-a-wallet-app#email-otp)
