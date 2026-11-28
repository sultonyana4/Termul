# Circle Wallet parity and release status

> **Release scope update.** [Circle Wallet Core Phase 1](circle-core-phase1.md) defines the approved Arc-only Circle scope and current acceptance checklist. The implementation and results below are historical. New Circle cross-chain reviews and execution are disabled. Authenticated recovery of existing operations remains available.

See the [LI.FI execution report](circle-lifi-parity.md) for the newer Circle LI.FI route matrix and checks.

**Release blocked.** The hosted candidate now includes a separately gated, multi-step CCTP Standard Transfer from Arc USDC to Base USDC. Full Circle parity still requires general Any Token and cross-chain swaps, broader bridge routes, independently verified refund or recovery flows where the protocol supports them, and live acceptance. The default localhost and hosted builds keep Circle financial execution disabled.

This report supersedes the bridge and migration status in the [previous implementation report](circle-feature-parity.md). The earlier invoice evidence and worktree changes remain relevant.

## Feature parity

| Workflow | Existing external wallet | Circle |
| --- | --- | --- |
| Wallet selection, login, balance, sessions, and SIWE | Existing Wagmi, EIP-6963, and wallet session | Existing Circle email login and ARC EOA handoff. Prior live OTP and SIWE. Desktop/mobile and hosted session checks use mocks. |
| Invoice creation, payment link, and history | Existing contract path and receipt reconciliation | Two historical ARC creations verified in the prior phase. Existing managed invoice creation/payment, durable history, and checkout browser mocks. Live payment acceptance outstanding. |
| Arc USDC ↔ EURC | Existing LI.FI/Fly route and fees | Existing gated Arc managed swap, with exact approval and receipt checks. Mocked. |
| Any Token on Arc or other networks | Existing LI.FI widget catalog and wallet provider | Any Token shows a narrow USDC CCTP bridge for eligible Circle accounts. General token routes and payment delivery are unimplemented. |
| Arc → Base USDC | Existing LI.FI path | Separate gated CCTP path. Exact approval, burn, and finalized Base USDC mint verified in mocks. Read-only RPC validated the deployed contracts. No live Circle bridge. |
| Base → Arc and other bridges | Existing LI.FI path | No Circle implementation. |
| Cross-chain swaps and multi-token steps | Existing LI.FI execution | No Circle implementation. The CCTP approval/burn/mint sequence is a same-asset transfer. |
| Restart, interruption, refunds | Existing LI.FI status and protocol-dependent routes | Postgres recovery preserves CCTP state through interruption. The worker only reads chain/provider evidence and writes reconciliation state. No automatic CCTP reburn, refund or re-attestation. |

## Chain, token, route, and signing matrix

The current Termul catalog read returned 17 eligible EVM mainnets. The source allowlist also contains Codex, which the LI.FI catalog excluded during the probe. The table lists endpoint capabilities from Circle's user-controlled wallet documentation. Each native managed chain needs a live Circle wallet registration verified against the intended owner. Native-chain eligibility is separate from Termul implementation.

| Termul network | Chain ID | Documented Circle native managed EOA | Token and route implemented for Circle |
| --- | ---: | --- | --- |
| Arc | 5042 | ARC | Existing native USDC invoice path. Existing LI.FI/Fly USDC/EURC swap. CCTP USDC source to Base. |
| Base | 8453 | BASE | CCTP USDC destination only. Existing Circle Base EOA must match the verified Arc address. |
| Ethereum | 1 | ETH | No Circle execution route |
| Arbitrum | 42161 | ARB | No Circle execution route |
| OP Mainnet | 10 | OP | No Circle execution route |
| Polygon | 137 | MATIC | No Circle execution route |
| Avalanche | 43114 | AVAX | No Circle execution route |
| Unichain | 130 | UNI | No Circle execution route |
| Monad | 143 | MONAD | No Circle execution route |
| Linea | 59144 | Generic EVM candidate, no listed native wallet | No Circle execution route. CCTP support on Linea is separate from Wallets signing. |
| World Chain | 480 | Generic EVM candidate, no listed native wallet | No Circle execution route |
| Sonic | 146 | Generic EVM candidate, no listed native wallet | No Circle execution route |
| Sei | 1329 | Generic EVM candidate, no listed native wallet | No Circle execution route |
| XDC | 50 | Generic EVM candidate, no listed native wallet | No Circle execution route |
| Ink | 57073 | Generic EVM candidate, no listed native wallet | No Circle execution route |
| Plume | 98866 | Generic EVM candidate, no listed native wallet | No Circle execution route |
| Morph | 2818 | Generic EVM candidate, no listed native wallet | No Circle execution route |
| Codex | 81224, catalog excluded | Generic EVM candidate, no listed native wallet | Outside the eligible picker in the live probe |

- **Native managed execution.** Circle documents an EOA challenge for these supported native networks. The native `ARC` wallet's managed endpoint accepts contract calldata and fee caps. A native chain code in the wallet catalog does not give Termul authority to use the wallet without a corresponding registration, matching owner, and explicit challenge. [Supported Wallets blockchains](https://developers.circle.com/wallets/supported-blockchains) · [Managed contract execution](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge)
- **Generic signing.** Circle's sign-only endpoint explicitly describes `EVM`/`EVM-TESTNET` and Solana. Generic EVM must be registered separately. Circle describes unified addressing for supported EVM registrations under the same identity, but this worktree does not infer another registration's address or its authorization from the Arc address. Generic signing still needs independently verified registration, exact chain-bound signing and broadcast validation, and a complete route-specific settlement and recovery design. Neither registration nor signing was performed here. [Sign-only endpoint](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/sign-user-transaction) · [Unified EVM addressing](https://developers.circle.com/wallets/unified-wallet-addressing-evm)
- **LI.FI routes.** The existing Widget V4 path uses the SDK's EVM provider. LI.FI's quote, step and execution APIs can request allowance, permit, swap and bridge actions. An adapter must validate the chain, wallet, target, selector, nested calls, value, fees, minimum output and safe expiry for each route. Read-only probes in this phase received an Across Arc→Base quote and a Polymer Standard Base→Arc quote. Both returned protocol and cross-chain steps. An Across deposit requires a matching destination fill. This worktree has no protocol-specific Circle execution and fill/refund verifier for either of those LI.FI routes. No Polymer Standard integration guarantee was inferred from the tool identifier or an API status. [LI.FI route execution](https://docs.li.fi/sdk/execute-routes) · [LI.FI transfer status](https://docs.li.fi/api-reference/check-the-status-of-a-cross-chain-transfer) · [Across deposit tracking](https://docs.across.to/introduction/tracking-deposits)

## Implemented Arc to Base route

The hosted Any Token panel displays a dedicated Circle CCTP review for eligible wallets. The browser sends only the six-decimal amount and the server-issued review identifier. The backend checks existing ARC and BASE registrations using the same Circle session and compares both with the verified Arc SIWE address. Base forwarding performs destination minting, so the user does not submit a Base transaction or need Base gas for this lane.

The server checks chain IDs, USDC decimals, canonical deployment bytecode, CCTP proxy implementations, and Base USDC's implementation. It fetches a fresh Standard Transfer forwarding fee from Iris, checks the user's balance and the Arc and Circle gas estimates, and limits the maximum CCTP fee to 5% of the transfer value for the pilot. Arc native USDC gas uses 18 decimals and the transfer and allowance terms use six. The reviewed calldata is locally constructed for exactly one step. An existing mismatched allowance requires a separate zero reset, then an exact approval. The burn requires its own new review and Circle confirmation. The burn amount includes the capped CCTP fee, and the review shows the minimum Base amount after fees. This is a separate CCTP path and is disabled when a nonzero Termul integrator fee policy applies. The existing LI.FI settings and wallet execution have not changed. [Circle Forwarding Service](https://developers.circle.com/cctp/concepts/forwarding-service) · [Forwarding walkthrough](https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service) · [CCTP contract addresses](https://developers.circle.com/cctp/references/contract-addresses) · [Arc EVM and USDC units](https://docs.arc.io/arc/references/evm-differences)

Postgres reserves a single active bridge per wallet. A locked fresh SIWE session, unexpired quote, revision check, and immutable route terms gate each reservation. The stored idempotency key is sent with the single explicit execution request. No timeout causes resubmission. Canonical finalized Arc receipts must match the sender, calldata, target, reviewed EIP-1559 caps and exact approval or burn event. A burn must emit the corresponding CCTP message. The Arc search advances a persistent scan cursor; Circle hashes are optional hints. The candidate is still pending until the Base finalized receipt binds the attested CCTP message and nonce to the Arc burn, the exact recipient and Base USDC mint, the minimum output, and the transfer log. The operator can refresh status or query history after restart. The worker never submits a financial transaction. [CCTP message format](https://developers.circle.com/cctp/references/technical-guide) · [Messages API](https://developers.circle.com/api-reference/cctp/all/get-messages-v2)

The UI preserves rejected, reverted, ambiguous submission, and destination-pending states. Closing a route before a burn does not automatically revoke a previously approved allowance. A confirmed burn with delayed forwarding stays open and keeps its source receipt. CCTP expiry may need issuer re-attestation of that same burn and subsequent delivery. This recovery does not create a second burn. The candidate includes read-only evidence recovery and does not implement a live re-attestation or refund workflow. [CCTP technical guide](https://developers.circle.com/cctp/references/technical-guide)

## Hosted storage, verification, and rollout

- `termul_circle_bridges` and its reservation/CAS RPC have RLS and explicit service-role grants. Browser callers receive only wallet-scoped projections. User tokens, credentials, and signed transaction objects stay out of route persistence. All status and execution requests use existing origin, SIWE and rate-limit checks.
- The full migration sequence ran in a disposable, Unix-socket-only PostgreSQL 16 cluster. Tests denied real SQL access to the public roles, checked wallet scope, rejected missing sessions and altered terms, proved a single winner for competing step claims, restarted PostgreSQL, and recovered the persisted reservation. Stale writes were rejected. The rehearsal also exercised the hosted invoice and swap journal reservation, consumed reviews, wallet exclusivity, and proof-state updates.
- Mainnet evidence is read-only. Arc and Base reported the expected IDs and finalized blocks, the CCTP and USDC deployments matched the reviewed pins, and the public Iris fee endpoint returned Arc→Base Standard Transfer prices. No historical public transfer in the sample matched the exact forwarding fixture. New bridge settlement was verified using synthetic Circle and RPC evidence.
- Clean checks include the existing **62 PoC tests**, **11 Termul regression suites**, and **18 Solidity tests**. The **15 hosted API and adapter tests** include bridge fee and calldata validation, source→destination steps, expiry, duplicate reservations, wrong destination, transport interruption, indexed-hash fallback, and wallet isolation. Local and hosted Circle Chromium passed. The hosted Any Token run separately confirmed allowance and burn across desktop and mobile, then checked the Base receipt link only after the fixture minted. The external wallet Chromium suite across six viewports passed.
- Default and opt-in production-mode builds passed. The default excludes the Circle SDK asset. Artifact scans checked a synthetic server credential sentinel. Root and PoC npm audits reported zero vulnerabilities. No dependencies changed.

Run `npm run dev:circle` from the worktree root with the previously configured local environment. The localhost supervisor passed a startup and shutdown smoke test with execution off. The existing SQLite journal checksum stayed identical. The new bridge is exposed only through the hosted API candidate and its hosted Chromium fixtures.

| Scope | Environment names |
| --- | --- |
| Existing local sidecar | `CIRCLE_API_KEY`, `CIRCLE_APP_ID`, `CIRCLE_TEST_EMAIL` |
| Existing hosted app | `VITE_TERMUL_WALLET_API_URL`, `TERMUL_CIRCLE_RELEASE_UI`, `TERMUL_CIRCLE_LOGIN_API`, `TERMUL_CIRCLE_APP_ID`, `TERMUL_CIRCLE_API_KEY`, `TERMUL_CIRCLE_LOGIN_EMAIL_ALLOWLIST`, `TERMUL_CIRCLE_SUPABASE_URL`, `TERMUL_CIRCLE_SUPABASE_SERVICE_ROLE_KEY` |
| Hosted execution and recovery | `TERMUL_CIRCLE_MANAGED_API`, `TERMUL_CIRCLE_MANAGED_EXECUTION`, `TERMUL_CIRCLE_CCTP_ARC_BASE`, `TERMUL_CIRCLE_BRIDGE_RECONCILE`, `TERMUL_CIRCLE_RECONCILE_SECRET` |
| Pre-existing optional settings | `TERMUL_CIRCLE_ARC_SWAP`, `TERMUL_CIRCLE_INITIALIZATION`, `TERMUL_CIRCLE_SESSION_KEY`, `TERMUL_RELEASE_FEE_BPS`, `TERMUL_RELEASE_FEE_VERSION` |

The new gates are disabled unless set explicitly. To roll back, disable the bridge execution gate and keep authenticated read-only reconciliation available until all admitted routes are accounted for. Enabling a hosted environment or scheduling its recovery worker requires separate release approval.

## Changes in this phase

- `server/circle/{bridge,bridge.test,cctp,managed-api,managed-api.test,login-api,postgrest}.js`
- `api/{termul-circle-login,termul-circle-managed,termul-circle-reconcile}.js`
- `src/{circle-bridge-ui,circle-wallet,swap-tabs,wallet-auth}.js`, `index.html`, `.env.example`
- `experiments/circle-wallet-poc/arc.js`, `scripts/{circle-browser.test.mjs,wallet-db.test.sh}`
- `supabase/migrations/20261124152229_circle_bridge.sql`, `docs/circle-feature-parity.md`, and this report

One consolidated acceptance window remains. Rehearse the hosted Data API and worker in an approved isolated environment, confirm the existing Circle account has a matching Base EOA, then separately authorize a low-value reviewed allowance and burn. Verify the finalized Base mint after refresh/restart and compare the received amount and fee. Complete and independently accept the still-unimplemented general LI.FI routes and refund paths before release. Any provider account registration, financial action, or production change requires separate authorization.

No production resource, deployed contract, existing journal, backup, wallet, or operator environment was changed.
