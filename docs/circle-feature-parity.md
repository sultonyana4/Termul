# Termul Circle Wallet feature parity

> **Release scope update.** [Circle Wallet Core Phase 1](circle-core-phase1.md) defines the approved Arc-only Circle scope and current acceptance checklist. The implementation and results below are historical. New Circle cross-chain reviews and execution are disabled. Authenticated recovery of existing operations remains available.

See the [current bridge and parity report](circle-final-parity.md) for the latest hosted implementation and local PostgreSQL evidence.

**Release is blocked.** Circle Email Login is additive in the local worktree. The existing native ARC EOA can use the local invoice creation and payment paths, and a separately gated Arc USDC/EURC adapter is available for testing. General Any Token, cross-chain swaps, and bridging remain disabled for Circle. The default production build keeps Circle disabled. An explicit opt-in build exercises the hosted Circle handoff in mocked Chromium.

## Workflow evidence

| Workflow | External wallet | Circle Email Wallet |
| --- | --- | --- |
| Connection and account lifecycle | Existing Wagmi and EIP-6963 flows. Offline Chromium covers connection, account changes, reconnect and disconnect. | Prior live OTP, ARC wallet reuse and SIWE. Local Chromium covers login, wallet switching, reload and logout. Native Circle approval remains required. |
| Wallet details, balance and profile | Existing Arc reads and wallet-scoped metadata. | Local account view, address copying, Arc native balance and wallet-specific profile. Authenticated metadata uses separate local storage. |
| Invoice creation and payment links | Existing UI, contract and metadata service. | Two historical creations independently reverified. Local browser uses the same form and review adapter. Invoice links resolve from chain state; metadata is optional and redacts client email. |
| Invoice payment | Existing UI, checks and external submission. | Local managed payment tested with synthetic Circle and Arc settlement. Live distinct-merchant payment is outstanding. |
| Invoice dashboard, history and recovery | Existing event synchronization and transaction activity. | Existing onchain invoice dashboard plus Circle-only attempt history. The selected wallet polls unresolved invoices and refreshes after terminal evidence. |
| Arc USDC/EURC stablecoin swap | Existing LI.FI/Fly execution and fee policy. | Server-validated LI.FI/Fly quote, exact approval or zero-reset as a separate review, independent settlement checks. Mocked adapter and browser; live Arc swap is outstanding. |
| Any Token, other-chain swaps and cross-chain bridges | Current LI.FI integration stays available. Existing Chromium has synthetic Arc-to-Base settlement. | Disabled. Requires validated route-specific quote, authorization, execution and destination proof. |
| Contract cancellation | No current Termul UI action. | The deployed ABI has merchant-only cancellation. No new cancellation workflow was added. |
| Supported layouts | Existing responsive checkout, account and widget views. | Circle desktop and mobile Chromium fixtures. |

## Reconciliation and historical evidence

The existing SQLite pilot journal passed `PRAGMA integrity_check`. Both records are terminal and there were no unresolved records. The bytes of the existing journal were checked across the default app startup and shutdown. The separate initialization store does not change the attempt schema.

The second historical attempt recorded Circle challenge `COMPLETE`, followed by HTTP 400 at the Circle transaction-list stage. The saved diagnostic has no Circle error code and does not identify the rejected filter, request shape, or other provider-side cause. The official SDK loopback test serializes the documented wallet, blockchain and operation filters. A new mocked regression exercises a single read-only HTTP 400 fallback using the wallet filter alone. Both reads require an exact reference, wallet, blockchain and operation before the result is used. New errors carry a generated provider request ID and sanitized stage, status and numeric code. The earlier attempt has no provider diagnostic. Both verified statuses below reflect independent Arc evidence.

| Transaction | Block | Gas used | Actual network cost | Invoice state |
| --- | ---: | ---: | ---: | --- |
| [e9b0bcff…4244](https://explorer.arc.io/tx/0xe9b0bcffd545c894b32c99dbe81d4aa6144e9f2fe87a5d5973b2f045b3124244) | 32,911,215 | 91,651 | 0.002783725574483098 USDC | Open at creation. Latest read showed expired. |
| [f49c7786…aa4c](https://explorer.arc.io/tx/0xf49c778697f5abdee1c9646b4245a78ecbfe8deae800017545d64643bf1baa4c) | 32,916,388 | 91,663 | 0.002369370354136357 USDC | Open at creation. Latest read during verification was Open and unexpired. |

A managed attempt is reserved before calling Circle, with a UUIDv4 idempotency key also sent as `refId`. Circle's challenge ID authorizes native confirmation. The status path can discover a matching transaction ID through a bounded wallet-scoped listing, retrieve a transaction hash, and verify it through Arc. If provider indexing fails, a bounded event search can recover the original transaction independently, including after a restart. Reconciliation verifies the configured runtime, exact sender and destination, chain, calldata and native value, reviewed EIP-1559 constraints, receipt, event, and block-pinned invoice state. It can tolerate a changed latest invoice state after creation. A provider hash is stored separately from verified onchain evidence. A wrong hint cannot prevent exact Arc recovery. A transient error leaves the attempt reserved. Neither browser refresh, SDK callback, worker polling, provider error, nor timeout sends another transaction.

The invoice fee budget remains 0.01 native USDC. Reviews retain the existing 10% gas and 5% fee headroom when it fits both the cap and balance. A fresh increase above the reviewed bound requires a new review. Circle's managed API has no caller-controlled nonce. Termul uses immutable reviewed terms, atomic reservation and independent verification. A native confirmation's blank Total has no confirmed rendering diagnosis. The app displays the invoice amount, attached value, and maximum fee separately.

## Circle managed payment and stablecoin swaps

Invoice payment is built from the pinned `payInvoice(address,bytes32)` interface. The backend reads the invoice, verifies merchant and ID, rejects closed or expired invoices, simulates the exact native value, checks balance for value plus the maximum fee, and rebuilds and compares the calldata before requesting a challenge. A successful payment requires a matching `InvoicePaid` event and resulting Paid state. The contract does not forbid merchant self-payment. Distinct payer and merchant addresses remain the meaningful live acceptance case. Active attempts lock the payer wallet and payment invoice in the managed journal. The deployed contract is the final protection against cross-wallet or external-path duplicate settlement.

The stablecoin adapter uses the existing Arc quote and fee code. It validates the fixed router and Fly route, recipient, tokens, min-out, slippage and fee split, verifies the pinned deployment, and simulates on Arc. Browser inputs are limited to token symbols and the amount. The restricted adapter generates an exact approval or a zero reset when required and requests fresh terms after independent approval settlement. Every transaction has its own Circle confirmation. A completed swap requires the exact reviewed transaction, Arc receipt, matching LI.FI event and token transfers. The Circle quote must fit the existing Termul swap gas budget. Approval-time quote freshness is enforced through server handoff. Circle does not expose a caller-set challenge deadline or managed nonce, so the application cannot extend its UI expiry guarantee into the native confirmation. The route's onchain min-out remains mandatory.

## Provider capabilities and cross-chain release blocker

- Native `ARC` supports user-controlled EOAs and the managed contract execution challenge. The managed endpoint accepts raw calldata, native amount in human units, and explicit EIP-1559 caps in gwei with gas as units. Installed Node SDK 10.8.1 covers create, estimate, challenge lookup, listing and transaction lookup. The current local client uses Web SDK 1.1.11. [Wallet network support](https://developers.circle.com/wallets/supported-blockchains) · [Managed contract execution](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge) · [Fee estimate](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-transaction-estimate-fee)
- The sign-only endpoint explicitly lists `SOL`, `SOL-DEVNET`, `EVM` and `EVM-TESTNET`. The broad field enum also contains native network identifiers. Use the endpoint's narrower statement. Unified EVM addresses are derived consistently within a Circle identity. Adding a chain uses another Circle wallet registration, even when the address remains the same. No additional wallet was created here. [Sign-only request](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/sign-user-transaction) · [Unified EVM addressing](https://developers.circle.com/wallets/unified-wallet-addressing-evm)
- Termul's full catalog includes Linea, which Circle's native user-controlled wallet table does not list. LI.FI routes can require chain switching, allowance resets, permits, multiple submissions, and destination recovery. A Circle ARC EOA supplies no injected provider. Broad route parity requires a lane-specific validator with audited target and decoded terms, verified ownership and gas on each source chain, separate approvals, fresh quotes, durable source-to-destination tracking, and independent destination receipts. LI.FI status or a wallet provider's confirmation can contribute evidence. Neither alone proves settlement. [LI.FI route execution](https://docs.li.fi/sdk/execute-routes) · [LI.FI transfer status](https://docs.li.fi/api-reference/check-the-status-of-a-cross-chain-transfer)
- Circle documents a possible alternative for unsupported native chains using generic EVM registration and sign-only, with app-owned broadcast and verification. This changes the execution architecture and requires wallet identity, authorization and chain-specific proof. The existing native ARC wallet is not evidence that this path works. Circle also lists a narrower USDC bridge alternative using CCTP Standard Transfer, including Arc as domain 26, and a Forwarding Service. That lane would require separately approved economics, contracts and destinations, exact allowance and burn reviews, attestation verification, and destination mint proof. It does not cover all LI.FI tokens or routes. Neither alternative was enabled or executed. A read-only LI.FI probe returned an Across quote for Arc to Base and a Polymer Standard quote for Base to Arc. Each advertised protocol and cross-chain steps. Provider quote availability alone supplies no Circle execution or settlement evidence. [Circle CCTP support](https://developers.circle.com/cctp/concepts/supported-chains-and-domains) · [Circle Wallet network limitations](https://developers.circle.com/wallets/supported-blockchains)

## Storage, access and production prerequisites

The local source uses separate adapters for Circle and the external provider. Circle credentials are confined to the localhost sidecar and official SDK handoff. A short-lived, opaque HttpOnly, SameSite=Strict cookie can restore the local SDK after refresh. The server-side vault is memory-only. A server restart requires login again and preserves transaction and initialization journals. Termul SIWE must still be renewed after restore. Local app data and passwords or OTPs never share the journal. Root and sidecar dotenv files and journal paths are ignored. The application exposes no generic contract execution endpoint and the Arc RPC client only allows read methods.

The proposed Vercel endpoints are independent from the existing external-wallet and Supabase routes. The login API defaults off and uses an approved-email gate, persisted throttling, and Circle ARC wallet discovery. First-time initialization has its own opt-in and stores a hashed provider identity and idempotency record before requesting Circle approval. The hosted browser flow takes a challenge from the existing Termul SIWE API, asks Circle to sign that exact unused challenge, and sends the result to the original verifier and nonce consumption path. Profile and invoice metadata continue through that verified session. The optional hosted session vault uses a secure HttpOnly cookie with a hashed handle and AES-256-GCM-sealed Circle SDK handoff, in a separate short-lived table. Restoring Circle prompts for fresh Termul SIWE before protected operations.

The managed API requires both a valid existing Termul SIWE session and the same live Circle ARC EOA. Invoice execution and Arc stablecoin execution have separate gates. Postgres stores short-lived reviews and attempt state. The migration enables RLS and grants table and RPC access only to the service role. Reservation locks the valid SIWE session and the review, and atomically reserves the unique key before requesting a challenge. The swap review stores a reconstructable, server-validated quote and fee constraints. Partial unique indexes prevent unresolved duplicates and reuse after verified invoice creation or payment. A CAS RPC protects evidence and immutable review fields. A separate bearer-authenticated worker only reads Arc and writes journal evidence. It needs approved scheduling to reconcile while users are away. Code and migration checks used mocks. The migration was not applied to a live or local database.

| Scope | Variables |
| --- | --- |
| Local sidecar | `CIRCLE_API_KEY`, `CIRCLE_APP_ID`, `CIRCLE_TEST_EMAIL` |
| Local CLI | `--managed` enables invoice execution. `--managed --arc-swap` adds the narrow Arc swap. Keep execution off during unattended tests. |
| Existing root build | `VITE_TERMUL_WALLET_API_URL` is the public Termul endpoint. The existing optional pair is `TERMUL_RELEASE_FEE_BPS` and `TERMUL_RELEASE_FEE_VERSION`. |
| Proposed server | `TERMUL_CIRCLE_RELEASE_UI`, `TERMUL_CIRCLE_LOGIN_API`, `TERMUL_CIRCLE_INITIALIZATION`, `TERMUL_CIRCLE_MANAGED_API`, `TERMUL_CIRCLE_MANAGED_EXECUTION`, `TERMUL_CIRCLE_ARC_SWAP`, `TERMUL_CIRCLE_APP_ID`, `TERMUL_CIRCLE_API_KEY`, `TERMUL_CIRCLE_LOGIN_EMAIL_ALLOWLIST`, `TERMUL_CIRCLE_SUPABASE_URL`, `TERMUL_CIRCLE_SUPABASE_SERVICE_ROLE_KEY`, `TERMUL_CIRCLE_RECONCILE_SECRET`, optional `TERMUL_CIRCLE_SESSION_KEY` |

Deployment rollback is to keep all Circle server flags disabled and leave the frontend build without Circle. Preserve the journal so an independently initiated read-only recovery can still resolve admitted attempts.

## Local start and manual acceptance

Run once after checkout using Node 22.18 or later.

```bash
npm ci
npm --prefix experiments/circle-wallet-poc ci
npm run dev:circle
```

Open `http://localhost:5173`. The same supervisor starts the localhost sidecar on 4173 and cleans up both processes on Ctrl+C. The operator's existing ignored local environment is used by the sidecar. The normal start disables financial challenges.

1. Once per release candidate, reuse the existing Arc wallet and verify live OTP, restore, wallet switch, ownership, balance and profile. Exercise Circle's native confirmation on the release candidate and validate a redacted OTP email in affected clients.
2. After separate financial authorization, verify app-mediated creation and payment with a suitable open invoice and distinct merchant and payer. Exercise rejection, refresh after approval, exact receipt, event and state, and payment link from a fresh browser.
3. After separate authorization, verify exact Arc allowance and native approval, max-fee enforcement, and min-out settlement for the narrow stablecoin route. Confirm late or rejected challenges remain reserved until reconciled.
4. Independently verify the hosted frontend and durable initialization against an isolated runtime. Rehearse and independently review the additive migration, origins, grants, rate limits, worker and callback rendering in an isolated environment.
5. Complete and accept cross-chain and Any Token route coverage before requesting release approval. Keep all Circle release flags off until then.

No financial submission or production modification was required for this report.

## Validation and changed files

- The local supervisor passed startup, loopback routing with query strings, SDK asset serving, rejection of foreign origins, execution flags, controlled shutdown, and a byte-for-byte check of the existing attempt journal.
- 62 PoC tests and 10 hosted API tests passed after clean installs. The PoC suite preserves all 52 original cases and adds approval, gas, persistent review, provider hash, initialization and session recovery coverage. All 11 Termul regression suites and 18 Solidity tests passed. API tests exercise the disabled defaults, production origin, SIWE bindings, fee constraints, atomic reservation, independent receipt proof and encrypted session vault.
- Mocked Chromium exercises local desktop and mobile, Circle and external wallet switching, SIWE after refresh, reviewed Arc swaps, invoice rejection and confirmation, history, and the disabled Any Token state. The opt-in production artifact runs a shared invoice checkout from the payment link through the existing SIWE transport and mocked Arc settlement. The existing external-wallet browser suite covers six viewport widths and synthetic cross-chain settlement.
- The default and opt-in production builds were verified locally with a synthetic public wallet API URL. The default artifact excludes the Circle SDK asset and login route. Static scans used a synthetic server credential sentinel. Root and PoC dependency audits include development dependencies. Both audits returned zero advisories. The browser SDK branch pins patched Firebase transitives. Termul’s LI.FI fee configuration is preserved.
- The existing PostgreSQL runtime regression script applies every migration. It was excluded under the no-migration-execution instruction. The PostgreSQL parser accepted 32 SQL statements and four PL/pgSQL function bodies without a database connection. The PostgREST adapter and concurrent reservation tests used mocks.

| Area | Files changed during this session |
| --- | --- |
| Root shell and build | `.env.example`, `index.html`, `package.json`, `package-lock.json`, `vite.config.js`, `scripts/circle-local.mjs`, `scripts/build-circle-sdk.mjs`, `scripts/circle-browser.test.mjs` |
| App | `src/arc-invoices.js`, `src/circle-wallet.js`, `src/swap-execution.js`, `src/swap-page.js`, `src/swap-tabs.js`, `src/wallet-auth.js`, `src/wallet-session.js` |
| PoC under `experiments/circle-wallet-poc/` | `.env.example`, `arc.js`, `circle-swap.js`, `circle-swap.test.js`, `initialization-store.js`, `invoice-pilot.js`, `invoice-pilot.test.js`, `managed-status.js`, `operations.js`, `pilot-journal.js`, `pilot-reconciliation.js`, `recovery-storage.test.js`, `server.js`, `session-vault.js` |
| Hosted APIs | `api/termul-circle-login.js`, `api/termul-circle-managed.js`, `api/termul-circle-reconcile.js` |
| Hosted server under `server/circle/` | `http.js`, `login-api.js`, `login-api.test.js`, `managed-api.js`, `managed-api.test.js`, `postgrest.js`, `reconcile.js`, `session-vault.js`, `session-vault.test.js` |
| SQL and docs | `supabase/migrations/20261124142000_termul_circle_managed_v1.sql`, `docs/circle-feature-parity.md`, `docs/circle-local-integration.md` |

The worktree started at `2b8b968` on `feat/circle-email-wallet`. Other uncommitted application and PoC files predate this session. The current Git status includes that earlier work.

### Reproduce browser checks

```bash
npx playwright install chromium
(cd contracts && forge build)
VITE_TERMUL_WALLET_API_URL=https://example-termul.supabase.co/functions/v1/termul-wallet-v1 \
  TERMUL_CIRCLE_RELEASE_UI=enabled npm run build -- --outDir .env.circle-hosted
TERMUL_CIRCLE_HOSTED_DIST="$PWD/.env.circle-hosted" npm run test:circle:browser
```

The Chromium suite intercepts the hosted origin, Circle SDK, wallet API and Arc RPC. That test artifact uses a synthetic wallet API endpoint.

During rollback, disable Circle's execution and initialization gates first. Keep the database and read-only reconciliation available for admitted attempts until review can account for each one. Afterward the local supervisor and hosted UI can remain disabled independently.
