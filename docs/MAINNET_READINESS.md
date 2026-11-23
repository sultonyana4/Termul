# Termul Arc Mainnet readiness

## Phase 1.1 checkpoint

| Milestone | Status |
| --- | --- |
| A. Contract ready for owner deployment review | Locally built and tested with Foundry and Arc Foundry. The manual WSL runbook is prepared. |
| B. Contract actually deployed | Pending owner deployment. Address, transaction hash, and block are unset. |
| C. Mainnet source verified | Pending the deployed address and explorer verification. |
| D. Frontend activated on mainnet | Pending production authorization and cutover. The default build selects testnet. |
| E. First real payment confirmed | Pending activation and the owner-led payment test. |

### Deployment and network configuration

| Field | Arc Testnet | Arc Mainnet |
| --- | --- | --- |
| Chain ID | `5042002` | `5042` |
| Browser JSON-RPC default | `https://rpc.blockdaemon.testnet.arc.io` | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.testnet.arc.io` | `https://explorer.arc.io` |
| Native balance, gas, and value | USDC, 18 decimals | USDC, 18 decimals |
| Invoice contract | `ArusPayInvoices`, `0x0cc3b91Fc603Ef15d80B3C0e8DB222e5988b8926` | `TermulInvoices`, address pending |
| Start block | `71546111` | Pending deployment receipt |

Official parameters and USDC representations are documented by Arc. [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc), [RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints), and [Stablecoin native model](https://docs.arc.io/arc/concepts/stablecoin-native-model).

Set `VITE_TERMUL_NETWORK=testnet` for the legacy build, or leave it unset. An owner-reviewed mainnet build requires `VITE_TERMUL_NETWORK=mainnet`, `VITE_TERMUL_MAINNET_CONTRACT_ADDRESS`, `VITE_TERMUL_MAINNET_DEPLOYMENT_BLOCK` as a positive decimal integer, `VITE_TERMUL_MAINNET_RUNTIME_HASH` from the reviewed local artifact, and `VITE_TERMUL_MAINNET_API_URL`. The optional `VITE_TERMUL_MAINNET_RPC_URL` is an independent public HTTPS endpoint override. Frontend environment values are public. The existing `VITE_ARUSPAY_*` settings apply to testnet.

The frontend checks RPC chain ID and deployed bytecode before using the invoice deployment. Mainnet also requires the expected runtime hash at the configured block and at latest, plus empty code at the preceding block. The RPC must support those historical reads, recent receipt/indexing methods, and browser CORS from the intended origin. The mainnet RPC answered a read-only chain-ID request with `0x13b2` and returned the expected CORS header for `https://termul.xyz` during Phase 1. Repeat it for the actual mainnet origin.

### Contract and frontend security

- `TermulInvoices` is based on the original contract. Its public function selectors, event signatures and indexed fields, enum values, error selectors, and storage layout are compatible. Compiler ABI `internalType` names and bytecode metadata reflect the new contract name, and `InvoicePaid` uses the validated merchant namespace when emitting. The original source and testnet deployment are retained.
- Invoice IDs are scoped to the calling merchant. Zero IDs and amounts fail, IDs stay reserved after payment or cancellation, and only the merchant can cancel an open invoice. Expiry can be zero for no expiry. A nonzero expiry must be in the future at creation, and payment at the exact expiry second reverts. Expiry is derived from the block timestamp; the stored state can still be `Open` after expiry. Use a time margin for invoices near expiry.
- Payment receives exactly the required `msg.value` in native 18-decimal USDC. The contract writes `Paid` before the external transfer and locks settlement across all invoice IDs. A successful forwarding call emits `InvoicePaid`. A rejected transfer rolls back the state and value changes. The payer can still incur gas for included failures.
- Arc enforces the USDC blocklist at runtime. A blocked party, wallet receiver revert, or gas-consuming receiver can prevent payment. Phase 1 ran Arc-mode unit tests for successful and rejected forwarding, including an adversarial receiver callback. Those tests used local accounts without blocklist entries. A live blocklist scenario was outside Phase 1. [Arc EVM differences and blocklist](https://docs.arc.io/arc/references/evm-differences).
- The merchant call forwards available gas under EVM call rules so contract wallets can receive native funds. An incompatible or out-of-gas receiver can make its invoices unpayable at the cost of payer gas. An unpublished or cancelled invoice can be replaced by its merchant with a fresh ID. When a destination wallet needs to change, cancel the old invoice through its merchant wallet if possible and issue a new invoice from the reviewed receiving wallet.
- The contract has no withdrawal, privileged role, proxy, token approval, payable fallback, or payable receive function. A forced or otherwise unsolicited balance has no recovery path and is never used to fund invoices. Invoice IDs, merchants, payers, values, timestamps, and statuses are public; client names, emails, descriptions, and notes stay off-chain. Use opaque IDs and treat wallet activity as public.
- The frontend scopes selection, metadata, recovery hints, explorer links, and event indexing to the configured deployment. New links carry merchant, invoice ID, chain ID, and contract. Legacy links without chain and contract belong to the testnet build. Wrong-deployment links fail closed.
- The write path rechecks the selected wallet account, EIP-1193 chain, and RPC deployment. Exact native amounts and payment-plus-gas checks use `BigInt`. Embedded-wallet signed bytes are checked for signer, target, chain, calldata, value, gas, fee caps and nonce before a single submission. For external wallets, Termul sends one explicit EIP-1193 request and checks the resulting chain evidence through its own RPC. External wallet behavior remains a launch-verification item.
- Termul accepts authoritative `Paid` state or successful receipt evidence bound to the exact transaction and invoice event. It never infers Paid from Supabase, a wallet prompt, or an unverified hash. The contract prevents a duplicate transfer even across browsers. Pending and ambiguous attempts remain locked in the app. Mainnet records submission hints in browser storage before the submission boundary, uses a same-origin Web Lock where supported, and syncs recovery hints to Supabase when available. Before a new Mainnet wallet request, Termul checks Supabase for an unresolved payment and waits if that check fails. A concurrent attempt on another device can still race before the first hint reaches Supabase. Blocked storage, a dropped transaction, or an unavailable RPC can require manual reconciliation. Storage contains public transaction identifiers scoped to the authenticated account, with no client details, wallet secrets, or authentication tokens.

### Privy readiness

The existing Privy application identity, login methods, account linking, and profile workflows are preserved. The build config supplies one supported/default chain. Mainnet signing requires the selected connected Privy wallet and authenticated user, including when that wallet is provided by an external connector.

As owner, review the chosen production origin under the **same** Privy application. Add only the exact new HTTPS origin and relevant redirect configuration. Keep existing origins and authentication methods for testnet. Confirm identity tokens are enabled and fresh tokens contain the linked EVM wallet. Confirm the current session and existing linked wallet survive refresh on the new origin, and expect a fresh sign-in on another origin if the browser does not share the session. Test embedded provider readiness, correct account and chain, an external wallet that supports Arc, explicit wallet switching, rejected approval, and return to the testnet origin. Wallets and connectors can differ in custom-chain and signing support, so test each supported path before enabling it for real payments. [Privy network setup](https://docs.privy.io/basics/react/advanced/configuring-evm-networks), [Allowed URLs](https://docs.privy.io/recipes/dashboard/allowed-domains), and [Identity tokens](https://docs.privy.io/user-management/users/identity-tokens).

### Supabase readiness and later cutover

Repository review found that the existing `payment_attempts` schema restricts `chain_id` to `5042002`, and the original full production schema for `merchant_invoices` and `profiles` is outside the checked-in migration history. Phase 1 adds two mainnet-only tables with compound keys and chain checks. It keeps the legacy tables and profile data in place. The mainnet tables enable RLS, revoke access from public and browser roles, and grant only the operations the Edge Function uses to `service_role`.

The local `aruspay-api` update verifies Privy ES256 access tokens, requires the access-token session claim and a token lifetime, and derives the subject from the token. It caps streamed request bodies at 16 KiB before parsing. Merchant metadata also requires a signed identity token linking that subject to the merchant wallet. Invoice and payment-attempt reads and writes use a server-approved chain/address and the corresponding tables. The server uses the authenticated payer's Privy ID for attempt hints and never treats those hints as settlement. `get_deployment` lets the mainnet frontend confirm the scoped function supports its deployment before it calls any mainnet metadata route. Existing clients can continue using the testnet routes and the same user profiles.

After specific owner authorization:

1. Review the live schema, grants, migration history, backups, and deployed function authentication settings through the approved process. Validate the additive migration `20261123063010_add_termul_mainnet_metadata.sql` on a local or approved staging database first. Verify RLS, absence of browser grants or policies for the new tables, exact numeric storage, and least-privilege service-role access.
2. Apply the additive migration only to the reviewed production project. Keep existing testnet records, contracts, and migration history.
3. Roll out the updated `aruspay-api` with the same Privy app identity and server-only Supabase credentials. The gateway must permit the function to handle Privy JWTs with its own verification. Preserve the existing deployment's compatible JWT gateway settings and confirm unauthenticated requests fail before DB access. Provide `TERMUL_MAINNET_CONTRACT_ADDRESS` from the verified receipt and `TERMUL_MAINNET_ORIGIN` as the exact reviewed HTTPS origin, with no trailing slash. The existing CORS origins remain available.
4. Exercise both deployment scopes with authorized test users. Verify that unauthorized merchant reads fail, a metadata hint cannot set Paid, old testnet clients still load, and the new frontend's `get_deployment` response matches its public config. Keep the service-role key in Edge Function secrets. [Supabase Edge Function auth](https://supabase.com/docs/guides/functions/auth).

### Activation and first USDC payment

1. Review the working tree and the dependency risks listed below. Then follow the owner-only [WSL deployment and verification runbook](MAINNET_DEPLOYMENT.md). Record the public address, hash, block, exact runtime hash, and successful explorer verification.
2. Complete the Privy and Supabase checks. Keep the existing production/testnet URLs serving their legacy links and records. The recommended cutover uses a dedicated mainnet origin, with its own reviewed build variables. Approve that origin before updating any production configuration. Confirm a copied link for each chain opens only its intended deployment.
3. Build and review the mainnet bundle with the verified deployment values. Check the provider and both historical bytecode reads, wallet switching, live balance, invoice indexing, profile and metadata scoping, and network-specific explorer links. On an authorized production rollout, begin with owner access and enable public traffic only after completing the checkout smoke test.
4. After explicit authorization for real mainnet transactions, use separate controlled merchant and payer wallets with native USDC. Create one low-value invoice, for example 0.01 USDC, with a future expiry. Verify the successful creation receipt and exact `InvoiceCreated` event. Open the copied link in the payer session, verify chain `5042`, contract, merchant, amount and fee, and approve once.
5. Record the successful payment hash and receipt. Cross-check the `payInvoice` calldata, exact `msg.value`, `InvoicePaid` emitter, invoice ID, merchant, payer, amount, and contract state `Paid`. Compare the merchant's balance delta while accounting for unrelated activity. Refresh both sessions and verify there is no second payment action and confirmed dashboard totals match the chain.

### Recovery and remaining risks

If the rollout must be suspended, roll back the mainnet frontend or remove its mainnet configuration at its separate origin. Keep testnet serving from its existing deployment. Disable the mainnet backend scope when necessary while preserving both mainnet and testnet records. Keep receipt evidence and a read-only route to outstanding mainnet invoice status. Completed settlement remains onchain. A frontend rollback does not cancel invoices.

When payment is pending or the submission is ambiguous, keep the public hash and merchant/invoice reference. Inspect the configured chain's wallet history, nonce, receipt, matching event, and current contract state. A missing hash or receipt alone is inconclusive. Avoid repeating the wallet prompt or clearing recovery hints until the prior submission has been resolved or confirmed terminal. For a reverted transfer, resolve the funding, receiver, or blocklist issue and double-check the invoice remains open before making a fresh decision. For long-running RPC or indexing gaps, use a reviewed second RPC for read-only corroboration and preserve the chain-specific evidence.

Remaining launch work includes the owner deployment and source verification, Privy wallet compatibility, deployed function and database checks, browser RPC historical reads against the real address, and the first paid checkout. The application trusts its configured RPC for read evidence, and browser-driven event scanning from the deployment block will get slower as the chain grows. RPC coverage and log scan capacity should be reviewed before wider use. The contract received a local security review and tests, with an independent audit still outstanding.

### Phase 1.1 dependency security review

`npm audit --omit=dev` initially reported 29 affected package entries, 18 high and 11 moderate, arising from six distinct advisories. Review refers to the browser bundle and installed npm production tree. Termul's frontend does not operate a Node WebSocket server and has no first-party Zod, UUID, or query-string parser imports. SDK-dependent pathways remain relevant to wallet connection. The audit does not cover Deno-hosted dependencies in the Edge Function.

| Advisory | Affected installed versions before Phase 1.1 | Termul exposure and disposition |
| --- | --- | --- |
| [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) | `decode-uri-component@0.2.2` through WalletConnect's `query-string@7.1.3` | Potential browser resource exhaustion while a connector handles malformed URI input. Removed with the newer Privy and WalletConnect dependency tree. |
| [GHSA-qr28-fpjm-wq7f](https://github.com/advisories/GHSA-qr28-fpjm-wq7f) | Same decoder and path | Another malformed-decoding resource exhaustion issue in the same path. Removed with the dependency update. |
| [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) | `ws@8.18.0` and `8.18.3` through WalletConnect's nested viem | The uninitialized-memory condition concerns Node WebSocket use. Browser WebSockets are supplied by the browser. The affected npm instances were removed. |
| [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) | Same `ws` versions and path | Resource exhaustion in the Node WebSocket receive path. The affected npm instances were removed. |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `uuid@8.3.2` and `9.0.1` through Wagmi's MetaMask and Gemini branches | Affects UUID v3/v5/v6 calls with a supplied buffer. Termul has no first-party caller. The affected MetaMask/Gemini dependencies were removed from the npm tree. |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | `zod@3.22.4` and `3.25.76`, primarily Reown wallet and Coinbase SDK paths | Oversized constrained collections can exhaust memory during parsing. The Reown and Coinbase bundles can process external connector data. The exact vulnerable schema path has not been demonstrated in Termul. Both Zod 3 versions remain. The fixed release is 4.6.6, and the remaining parents require Zod 3. |

Privy React Auth was updated from `3.51.3` to `3.52.0` within the existing major version. It moved off the legacy `x402@0.7.3`/Wagmi subtree and raised the WalletConnect provider to `2.26.0`. The new scoped `@x402` dependencies resolve patched Zod 4. The release removes the reported URI decoder, WebSocket, and UUID findings without overriding major versions of connector dependencies. [Privy React Auth 3.52.0](https://www.npmjs.com/package/@privy-io/react-auth/v/3.52.0).

The following inventory includes all initial package entries. **P** is the direct Privy React Auth dependency. **W** is the WalletConnect Ethereum provider and **R** is Reown AppKit. A slash between versions denotes multiple installations. Paths show the relevant parent branches for the audit.

| Initial package entry and severity | Initial version | Dependency path | Final result |
| --- | --- | --- | --- |
| `@privy-io/react-auth` high, direct | 3.51.3 | App → P | 3.52.0, reported via W |
| `@walletconnect/ethereum-provider` high | 2.22.4 / 2.21.1 | P → W, or P → x402 → Wagmi connectors → W | 2.26.0, reported via R |
| `@reown/appkit` high | 1.8.9 / 1.7.8 | W → R | 1.8.19, reported via its Zod-dependent packages |
| `@reown/appkit-controllers` high | 1.8.9 / 1.7.8 | R → controllers → wallet and WalletConnect | 1.8.19, reported via wallet |
| `@reown/appkit-pay` high | 1.8.9 / 1.7.8 | R → pay → controllers/UI/utils | 1.8.19, reported via those packages |
| `@reown/appkit-scaffold-ui` high | 1.8.9 / 1.7.8 | R → scaffold UI → controller/UI/pay/utils/wallet | 1.8.19, reported via those packages |
| `@reown/appkit-ui` high | 1.8.9 / 1.7.8 | R → UI → controller/wallet | 1.8.19, reported via wallet |
| `@reown/appkit-utils` high | 1.8.9 / 1.7.8 | R → utils → wallet/WalletConnect | 1.8.19, reported via wallet |
| `@reown/appkit-wallet` high | 1.8.9 / 1.7.8 | R → wallet → Zod | 1.8.19, pins Zod 3.22.4 |
| `@coinbase/cdp-sdk` high | 1.61.0 | P → x402 → Wagmi connectors → Base Account → Coinbase SDK | 1.62.0 via R → utils → Base Account, requires Zod 3 |
| `abitype` high | 1.0.6 / 1.0.8 | Coinbase SDK and nested viem → abitype → optional Zod peer | 1.0.6 pins the affected peer range under Coinbase SDK |
| `zod` high | 3.22.4 / 3.25.76 | R → wallet, or Base Account → Coinbase SDK/abitype, and legacy x402 | Both Zod 3 versions remain in the Reown tree |
| `viem` high, nested instances | 2.23.2 / 2.36.0 | W/R → WalletConnect utils → viem → `ws` / abitype | Reported nested versions removed. Direct viem 2.57.17 was outside this audit entry. |
| `ws` high | 8.18.0 / 8.18.3 | Nested viem → `ws` | Affected versions removed |
| `decode-uri-component` high | 0.2.2 | WalletConnect utils → query-string → decoder | Removed |
| `query-string` high | 7.1.3 | Legacy WalletConnect utils → query-string | Removed |
| `@walletconnect/utils` high | 2.21.0 / 2.21.1 / 2.21.9 | W/R → WalletConnect utils → old viem/query-string | Reported versions removed |
| `x402` high | 0.7.3 | P → x402 → Wagmi/Zod | Replaced by scoped packages with patched Zod |
| `@walletconnect/core` moderate | 2.21.0 / 2.21.1 / 2.21.9 | W/R → sign-client → core → utils | Reported versions removed |
| `@walletconnect/sign-client` moderate | 2.21.0 / 2.21.1 / 2.21.9 | W/R → universal-provider → sign-client → core/utils | Reported versions removed |
| `@walletconnect/universal-provider` moderate | 2.21.0 / 2.21.1 / 2.21.9 | W/R → universal-provider → sign-client/utils | Reported versions removed |
| `wagmi` moderate | 2.19.5 | P → x402 → Wagmi → connectors | Removed |
| `@wagmi/connectors` moderate | 6.2.0 | Wagmi → MetaMask/Gemini/WalletConnect | Removed |
| `@gemini-wallet/core` moderate | 0.3.2 | Wagmi connectors → Gemini → MetaMask RPC errors | Removed |
| `@metamask/sdk` moderate | 0.33.1 | Wagmi connectors → MetaMask SDK → communication layer/UUID | Removed |
| `@metamask/sdk-communication-layer` moderate | 0.33.1 | MetaMask SDK → communication layer → UUID | Removed |
| `@metamask/rpc-errors` moderate | 6.4.0 / 7.0.2 | Gemini and MetaMask JSON-RPC/provider paths → RPC errors → utils | Removed |
| `@metamask/utils` moderate | 8.5.0 / 9.3.0 / 11.12.1 | MetaMask RPC/errors/provider paths → utils → UUID | Removed |
| `uuid` moderate | 8.3.2 / 9.0.1 | MetaMask SDK, communication layer and utils → UUID | Affected versions removed |

All rows except direct Privy are transitive in this audit, including the older viem instances. The remaining compatible Reown 1.8 release examined, 1.8.24, still pins Zod 3.22.4, and Coinbase SDK 1.62.0 requires Zod 3.25.76. npm suggests a breaking downgrade to Privy 2.19.2, which was excluded from the compatible update. For public activation, obtain an upstream release that supports patched Zod and rerun the wallet compatibility checks, or explicitly limit the rollout to wallet paths reviewed with the vendor and accept the residual connector risk. Live connector testing remains a launch gate after the SDK update.

### Local validation

| Check | Result |
| --- | --- |
| `npm ci` | Passed with Privy React Auth pinned to 3.52.0. |
| `npm audit --omit=dev` | Exit 1 with 12 high, 0 moderate, and 0 critical package findings. All 12 trace to the same remaining Zod advisory. |
| `npm run build` | Passed with dependency annotation and bundle-size warnings. |
| `npm run test:profile`, `test:metadata`, `test:payment-result`, `test:invoice-creation`, `test:wallet-diagnostics`, `test:arc-network` | Passed with local fixtures, including exact payment evidence, network scope, duplicate submission, and code/address guards. |
| `forge build`, `arc-forge build` | Passed. Independent builds produced the same creation and runtime bytecode. |
| `forge test`, `arc-forge test --network arc` | Each passed 18 tests with zero failures or skips, including 10 TermulInvoices tests. |
| PostgreSQL 16, isolated local cluster | Old migration and additive migration applied to a seeded test schema. Verified legacy row preservation, RLS and grants, exact numeric storage, service-role writes and deletes, and rejection of the wrong chain. |
| Read-only Arc RPC | Confirmed the Mainnet chain ID and the existing Testnet contract runtime match. |

The real testnet transaction harness was excluded from Phase 1. No blockchain transaction or hosted deployment was performed.
