# Circle Wallet and LI.FI execution

> **Release scope update.** [Circle Wallet Core Phase 1](circle-core-phase1.md) defines the approved Arc-only Circle scope and current acceptance checklist. The implementation and results below are historical. New Circle cross-chain reviews and execution are disabled. Authenticated recovery of existing operations remains available.

**Full parity remains a release blocker.** The hosted Circle candidate now uses LI.FI quote and step preparation APIs for six directed USDC lanes on four networks. Both protocol proof adapters and the hosted workflow passed mocked execution. No live payment approval, transaction, or wallet registration was performed.

## Product parity

| Existing features | External Web3 | Circle |
| --- | --- | --- |
| Connect Wallet, Wagmi, injected providers | Existing behavior preserved | Separate email login and Circle SDK. No injected-provider emulation. |
| Arc balance, invoice payments, invoice history | Existing behavior preserved | Existing managed invoice and history code. Two historical creation receipts were independently verified in the previous phase. Payment acceptance uses mocks. |
| Arc USDC ↔ EURC | Existing LI.FI/Fly path | Existing Circle managed Arc swap on its own tab, verified with mocks. |
| Any Token, same-asset USDC transfers | Existing network and token selectors | New hosted Circle selection across six directed USDC lanes. See the route table below. |
| Any Token, arbitrary token or native asset swaps, cross-chain swaps and composite routes | Existing LI.FI paths | Release blocker. No execution permission for these route families. |
| CCTP Arc→Base | Existing external path unaffected | Existing Circle CCTP option is separate and still unavailable under a nonzero Termul integrator fee policy. |
| Recovery and refunds | Existing protocol handling preserved | Durable LI.FI authorization, pending submission recovery and independent settlement. Reported refunds, expired fill windows and delivery failures stay unresolved. Sender refunds and re-attestation execution remain release blockers. |

## Chain and route capability matrix

Termul's existing catalog offered 17 of its 18 configured EVM chains during the most recent catalog read. Codex is in Termul's configured list and was excluded by the upstream catalog. The native EOA codes are taken from Circle's Wallets list. The capability is conditional on an existing verified Circle EOA registration on that chain. The LI.FI adapter verifies both source and destination registrations against the Arc SIWE address. It never creates a registration. [Circle supported blockchains](https://developers.circle.com/wallets/supported-blockchains) · [Unified EVM addressing](https://developers.circle.com/wallets/unified-wallet-addressing-evm)

| Network | Chain ID | Circle native managed EOA | Circle LI.FI implementation |
| --- | ---: | --- | --- |
| Arc | 5042 | ARC | USDC source via Across to Base. Destination via Polymer from Base. |
| Base | 8453 | BASE | USDC source via Across to OP Mainnet or Arbitrum, and via Polymer to Arc. Destination via Across from Arc, OP Mainnet or Arbitrum. |
| Arbitrum | 42161 | ARB | USDC via Across to and from Base. |
| OP Mainnet | 10 | OP | USDC via Across to and from Base. |
| Ethereum | 1 | ETH | No admitted route |
| Polygon | 137 | MATIC | No admitted route |
| Avalanche | 43114 | AVAX | No admitted route |
| Unichain | 130 | UNI | No admitted route |
| Monad | 143 | MONAD | No admitted route |
| Linea | 59144 | Unlisted native EOA | Generic EVM candidate, registration and signing unverified. No admitted route. |
| World Chain | 480 | Unlisted native EOA | Generic EVM candidate, no admitted route. |
| Sonic | 146 | Unlisted native EOA | Generic EVM candidate, no admitted route. |
| Sei | 1329 | Unlisted native EOA | Generic EVM candidate, no admitted route. |
| XDC | 50 | Unlisted native EOA | Generic EVM candidate, no admitted route. |
| Ink | 57073 | Unlisted native EOA | Generic EVM candidate, no admitted route. |
| Plume | 98866 | Unlisted native EOA | Generic EVM candidate, no admitted route. |
| Morph | 2818 | Unlisted native EOA | Generic EVM candidate, no admitted route. |
| Codex | 81224 | Unlisted native EOA | Configured by Termul, excluded by the current upstream catalog. No admitted Circle route. |

| Route | Signer and approval | Independent settlement | Refund and recovery | Evidence |
| --- | --- | --- | --- | --- |
| Arc→Base, Base→Arbitrum, Arbitrum→Base, Base→OP Mainnet, OP Mainnet→Base | The source network's native Circle EOA. Exact USDC allowance, a zero-reset review when needed, and separate transfer challenge. | Finalized source receipt with exact LI.FI/Across deposit, then finalized Across fill linked by origin and deposit ID with the expected recipient and USDC credit. | Source reverts and challenge rejection are recognized. An unverified refund or expired fill window keeps the route reserved. | All five quote/preparation and deployment probes passed. Base→OP passed mocked adapter and browser checkout. Other directions passed route checks. |
| Base→Arc | Base Circle EOA and exact USDC allowance | Exact source receipt and gross token debit. On Arc, the CCTP message/nonce must bind the burn to the recipient's net USDC credit. | Issuer re-attestation and refund execution unimplemented. | Quote, preparation, deployment probes and independent proof fixtures passed. |
| Other routes | Native Circle-managed eligibility sometimes exists, or generic EVM signing may be an option | Requires a vetted route verifier | Requires protocol-specific lifecycle and refund attribution | Unimplemented |

The installed LI.FI EVM provider handles wallet-client `sendTransaction`, allowance, and typed-data signing. Circle managed calls instead return an approval challenge tied to a registered wallet and later publish a transaction record. A browser transport that claims to implement the injected-provider contract would hide those differences. The hosted architecture uses LI.FI's dedicated server-side quote and preparation endpoints, then invokes the official Circle managed challenge for one approved financial step. Circle's generic EVM sign-only endpoint is a separate flow involving registration, explicit EVM chain binding and broadcasting by the integrator. Its endpoint note does not grant native ARC sign-only support. Circle also exposes native asset transfer operations, but this LI.FI adapter deliberately requires ERC-20 USDC and zero transaction value. Neither the generic sign-only flow nor native LI.FI routes were enabled. [LI.FI SDK execution](https://docs.li.fi/sdk/execute-routes) · [Prepare step](https://docs.li.fi/api-reference/advanced/populate-a-step-with-transaction-data) · [Circle managed execution](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge) · [Circle sign-only](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/sign-user-transaction)

## Authorization, pricing, and state

- The Any Token panel posts an allowlisted chain pair and a six-decimal amount. Existing origin, SIWE ownership, Circle session, and rate limits authorize each request. Execution also requires the exact unexpired review ID and affirmative confirmation.
- The backend fetches its own LI.FI quote and step transaction. It revalidates both responses against a fixed route and tool registry, matching the step identity, token addresses, recipient, amounts, slippage and fee split. The prepared step cannot lower the accepted minimum. It decodes and re-encodes the exact transaction and inspects nested fee forwarding. Arbitrary swap calls, permits, native value and destination calldata fail closed.
- The adapter checks chain ID, token decimals, router facet selection, fee-forwarder code, and protocol and token deployments, including proxy implementation hashes. It checks source allowance, native gas and token balances. The application uses exact reset/approval and independent Circle confirmation for the source transaction. The EIP-1559 review bounds the execution gas cap. OP-stack L1 data charges may be additional, so the application discloses this and the hosted pilot still needs live fee acceptance.
- The migration adds the workflow discriminator to the existing guarded route journal. A single open reservation is enforced per wallet across LI.FI and CCTP, with a locked fresh SIWE session and revision checks. The ledger persists linked wallet IDs, server-owned reviews, fees, sanitized plan, idempotency keys, the current step, receipt evidence, status and history. The HTTP DTO omits private transaction terms and session identifiers.
- The reconciler reads Circle and LI.FI status as hints. It scans source events for lost provider responses and looks for a matching Across destination fill if the LI.FI receiving hash is delayed. An ambiguous submission retains its reservation. Payment cannot become verified from a provider success or the source transaction alone. No recovery polls submit a new transaction.
- Across refund bundles associate payouts with leaves and recipients. This implementation does not establish an independently verified, deposit-specific refund binding. The browser shows that a refund report is unverified. Polymer delivery recovery also remains open until the actual CCTP message is delivered. [Across deposit tracking](https://docs.across.to/introduction/tracking-deposits) · [Across refunds](https://docs.across.to/introduction/refunds) · [LI.FI status](https://docs.li.fi/api-reference/check-the-status-of-a-cross-chain-transfer)

## Verification and rollout

- Read-only Mainnet checks validated LI.FI quotes, fresh step preparation and RPC pins for all six admitted directions. The existing fee policy's zero- and nonzero-fee quote modes both passed. Hosted browser calls and financial submissions used mocks.
- Disposable PostgreSQL applied the complete migration sequence. Runtime checks covered public-role access denial, minimum grants, wallet and session scope, exclusivity between workflows, exact competing claims, stale writes, persistent unresolved refund state, and restarting PostgreSQL after a LI.FI reservation.
- 62 Circle PoC tests, 21 hosted API and adapter tests, all 11 Termul regression suites and 18 Solidity tests passed. Local and hosted Circle Playwright passed. Hosted Any Token covered Base→OP approval on desktop, transfer on mobile, refresh and session restoration while delivery was pending, and the eventual destination link. The existing external Web3 suite passed across six viewports.
- Default and opt-in production builds passed. A synthetic server credential was absent from both artifacts. The default artifact excluded the Circle SDK. Root and PoC dependency audits reported zero advisories. No dependencies or deployed contract sources changed.

Start with `npm run dev:circle`. The normal local start keeps financial execution off. LI.FI execution uses the hosted API candidate and its mocked hosted harness.

| Scope | Configuration names |
| --- | --- |
| Circle hosted UI and services | `VITE_TERMUL_WALLET_API_URL`, `TERMUL_CIRCLE_RELEASE_UI`, `TERMUL_CIRCLE_LOGIN_API`, `TERMUL_CIRCLE_MANAGED_API`, `TERMUL_CIRCLE_MANAGED_EXECUTION`, `TERMUL_CIRCLE_APP_ID`, `TERMUL_CIRCLE_API_KEY`, `TERMUL_CIRCLE_LOGIN_EMAIL_ALLOWLIST`, `TERMUL_CIRCLE_SUPABASE_URL`, `TERMUL_CIRCLE_SUPABASE_SERVICE_ROLE_KEY` |
| LI.FI admission and recovery | `TERMUL_CIRCLE_LIFI`, `TERMUL_CIRCLE_LIFI_RECONCILE`, `TERMUL_CIRCLE_RECONCILE_SECRET` |
| Existing fees and other Circle modes | `TERMUL_RELEASE_FEE_BPS`, `TERMUL_RELEASE_FEE_VERSION`, `TERMUL_CIRCLE_CCTP_ARC_BASE`, `TERMUL_CIRCLE_BRIDGE_RECONCILE`, `TERMUL_CIRCLE_ARC_SWAP`, `TERMUL_CIRCLE_SESSION_KEY`, `TERMUL_CIRCLE_INITIALIZATION` |
| Existing local sidecar | `CIRCLE_API_KEY`, `CIRCLE_APP_ID`, `CIRCLE_TEST_EMAIL` |

Both new gates default off. Disable LI.FI admission first during rollback, keeping authorized read-only recovery running until every admitted route is reconciled. Credential values remain server-side. No hosted environment or schedule was configured.

## Files in this phase

- Added `server/circle/lifi.js`, `server/circle/lifi-networks.js`, `server/circle/lifi-protocols.js`, `server/circle/lifi.test.js`, `src/circle-lifi-ui.js`, `src/circle-lifi-routes.js`, and `supabase/migrations/20261124160329_circle_lifi.sql`.
- Updated `server/circle/{managed-api,managed-api.test,login-api,postgrest}.js`, the three `api/termul-circle-*.js` handlers, and `experiments/circle-wallet-poc/pilot-reconciliation.js`.
- Updated `index.html`, `src/{circle-wallet,wallet-auth,swap-tabs}.js`, `.env.example`, `scripts/circle-browser.test.mjs`, `scripts/wallet-db.test.sh`, and the phase reports.

## Remaining acceptance

Use one separately authorized window to verify existing Circle EOA ownership, then approve a low-value Across transfer and Polymer transfer and independently verify source and destination receipts after refresh. Confirm actual execution and L2 data fees, and rehearse the hosted RPC/Data API and worker with an isolated deployment. General Any Token, native asset routes, multi-transaction LI.FI plans, cross-token swaps, wider Circle chain coverage, and independently verified refunds remain mandatory release blockers.

The prior local journal and checkpoint remain intact. No remote environment, GitHub, Vercel, Supabase, Termul deployment, deployed contract, or Mainnet financial state was modified.
