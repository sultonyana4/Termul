# Termul Phase 2A · Circle Wallet PoC

This experiment runs on `http://localhost:4173` with a single Node server bound to `127.0.0.1`. It uses the existing Termul EOA verifier as a local import and Arc Mainnet RPC for public reads.

For the complete local setup, verified recovery and release boundaries, see [Circle Wallet local integration](../../docs/circle-local-integration.md).

## Phase 2B.2 · Managed Invoice Creation Pilot

The pilot constructs only `createInvoice(bytes32,uint256,uint64)` for the existing Termul deployment. It generates a merchant-scoped ID, uses a 15-minute expiry based on the Arc block timestamp, and sets the invoice amount to 0.01 USDC with zero attached native value. Neither the browser nor the operator can supply transaction fields through the API.

### Official managed execution and transaction handoff

- Circle documents native `ARC` for user-controlled EOAs and in the dedicated contract-execution blockchain type. SDK `10.8.1` accepts a wallet ID, raw calldata, an optional native amount, a UUIDv4 idempotency key, a reference ID, and an absolute fee configuration. The actual SDK request uses integer gas units and decimal gwei strings for `maxFee` and `priorityFee`. Omit the amount for this nonpayable call. The response identifies the challenge. [Support matrix](https://developers.circle.com/wallets/supported-blockchains) · [Contract execution challenge](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge)
- After explicit local confirmation, the browser opens the Circle Web SDK's native confirmation UI with the persisted challenge ID. Circle submits after user approval. The SDK callback gives approval feedback. The challenge response schema does not document a managed transaction ID, and the correlation-IDs description omits `CONTRACT_EXECUTION`. The pilot never reads an assumed transaction identifier from either payload. [Managed submission guide](https://developers.circle.com/wallets/user-controlled/transfer-tokens) · [Challenge status](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/get-user-challenge)
- The pilot sends the same unique UUID as the documented transaction `refId` and idempotency key. During status checks it scans the authorized wallet's Arc contract-execution records via `listTransactions` using the SDK's `Link` pagination cursor. It requires an exact, unique reference match, records the returned transaction `id`, then calls `getTransaction` for the provider state and `txHash`. A missing or conflicting reference, ID, or hash holds the attempt unresolved. The route and fields are documented. Their behavior on an actual native-ARC managed execution remains an operator verification item. [List transactions](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/list-transactions) · [Get a transaction](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/get-transaction)
- Once the hash is known, the pilot independently verifies Arc chain 5042, the exact sender and contract, zero value, calldata hash, reviewed EIP-1559 limits, receipt, and the matching `InvoiceCreated` event. A read at the receipt block checks the merchant, amount, expiry, and Open invoice state. Verified receipts report `gasUsed × effectiveGasPrice` in native USDC. A successful Circle callback, a complete Circle challenge, and a Circle transaction status never settle the attempt by themselves. Provider rejection and expiration are reconciled against the transaction list and invoice state before release. Other ambiguous outcomes remain locked. [Termul contract](../../contracts/src/TermulInvoices.sol) · [Existing creation reconciliation](../../src/invoice-creation.js)

### Operator setup

1. From `experiments/circle-wallet-poc`, start in safe mode using the existing ignored credential configuration with `CIRCLE_MANAGED_INVOICE_PILOT=disabled npm start`. Open `http://localhost:4173/?check=phase2b2`. Sign in with the existing Circle test account and confirm the original ARC EOA.
2. Use **Sign local SIWE message** immediately before preparing a pilot review. The server checks the Circle token against the current wallet and accepts recent SIWE proof for five minutes. Run the existing **Managed Execution Preflight** to inspect estimates. A wallet with zero native USDC cannot pass the pilot's gas coverage check.
3. Only after separate authorization for a live transaction and its gas expenditure, restart with `CIRCLE_MANAGED_INVOICE_PILOT=enabled npm start`. Keep Circle's native Confirmation UIs enabled. Sign in again, verify SIWE, then select **Prepare invoice review**. The review is valid for 90 seconds and displays the invoice amount separately from maximum gas cost. Historical fee observations are reference results only.
4. Check the existing wallet, chain 5042, verified contract, expiry, calldata and fees. Tick the local confirmation and select **Open Circle confirmation**. The server reruns deployment, invoice existence, simulation, fee and balance checks. The request uses the displayed absolute gas constraints only. The maximum gas limit multiplied by the maximum fee per gas cannot exceed **0.01 USDC**. If fresh fees exceed the reviewed limits or budget, stop and review a new operator-approved plan. Review the native Circle prompt and approve or decline as appropriate.
5. Use **Check attempt status** as needed, including after login renewal or process restart. Successful verification displays the hash and actual gas cost. A dismissed dialog or request timeout can leave the outcome unresolved. Keep the existing journal and reconcile before making any new attempt.

The journal is `.env.pilot-journal/attempts.sqlite` within the PoC. The repository's existing `.env.*` rule ignores this directory and SQLite sidecars. The server writes only wallet, invoice, review limits, calldata hash, idempotency and provider identifiers, and reconciliation metadata. SQLite enforces one unresolved attempt per wallet and reserves it before the SDK call. Node 22 may emit an experimental SQLite warning. A timeout retains the original idempotency key and reference. This pilot only performs read-side recovery after ambiguity and has no button that replays a challenge request. If the challenge ID and matching transaction both remain absent, the attempt stays locked pending provider confirmation. [Circle idempotency](https://developers.circle.com/api-reference/idempotent-requests)

Circle owns managed nonce selection. This pilot makes no exact nonce claim, never raises the reviewed fee caps, and leaves a wrong sender, recipient, calldata, fee limit, receipt or invoice proof unresolved for inspection. Live ARC approval, provider reference visibility, hash propagation, and receipt verification still require separate operator evidence. Preserve the current Wagmi, injected and external-wallet paths when evaluating any later integration.

## Phase 2B.1 · Managed Execution Preflight

The authenticated preflight checks the existing Circle EOA and verified Termul deployment, simulates two fixed invoice calls using Arc RPC, and requests fee quotes from Circle. The only Circle transaction endpoint called by the preflight is the estimate endpoint. The modeled approval and submission lifecycle lives entirely in tests.

### Run the operator preflight

1. Start the PoC with the existing ignored local configuration using `npm start`. Open `http://localhost:4173/?check=phase2b1` and finish OTP with the Phase 2A account. Confirm the wallet ID and address match the existing wallet. If the existing wallet is missing, stop and refresh the wallet state.
2. Select **Run managed execution preflight**. Confirm the ARC EOA, chain 5042, verified Termul address and runtime hash, and native USDC balance. No wallet or invoice initialization is needed for this check.
3. Review the two fixed calls. Creation simulates `createInvoice` with a deterministic fixture ID, invoice amount 0.01 USDC, no expiry, and zero attached value. Payment simulates `payInvoice` for that same ID in the authenticated address's merchant namespace with 0.01 USDC attached. A simulation of creation leaves the invoice absent for the payment probe.
4. Record separate Arc and Circle outcomes. Circle's medium-tier ceiling and the RPC indicative cost use different pricing bases. Gas units can be compared directly when both estimates return. An insufficient-funds result or an invoice revert is separate from a Circle unsupported-chain or permission error. Even if both fee estimates succeed, the result supplies no execution or settlement evidence.

### Endpoint-specific documentation

| Topic | Finding |
| --- | --- |
| Native ARC EOA | Circle lists native `ARC` for user-controlled EOAs. Both managed execution and its estimate use a dedicated `ContractExecutionBlockchain` schema that includes `ARC`, consistent with the installed Node SDK `10.8.1` type. This is distinct from native ARC sign-only support, which remains blocked by that endpoint's specific coverage note. [Supported chains](https://developers.circle.com/wallets/supported-blockchains) · [Managed execution API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge) · [Fee estimate API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-transaction-estimate-fee) |
| Estimation and source identity | `estimateContractExecutionFee` in the Node SDK calls `POST /v1/w3s/transactions/contractExecution/estimateFee`. It uses server-side Bearer authorization and the existing `X-User-Token`. The PoC sends `source: { walletId }` through the SDK, which serializes as `walletId` in the request. The estimate schema returns fee tiers and has no idempotency key, challenge ID, or transaction hash. Address plus blockchain is the alternative source selector. [Fee estimate API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-transaction-estimate-fee) |
| Raw calldata and amounts | The field specification and SDK union allow an even-length, `0x`-prefixed `callData` instead of ABI signature and parameter fields. `amount` is a native-token decimal string for payable calls, so Arc payment uses `"0.01"` while the RPC value is `10000000000000000` base units. A nonpayable creation omits the Circle amount. [Managed execution API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge) · [Arc EVM differences](https://docs.arc.io/arc/references/evm-differences) |
| Fee units and review | Circle `gasLimit` is gas units. Its `maxFee` and `priorityFee` are decimal gwei. Arc RPC values are base units per gas. The comparison uses exact integer conversion, and the UI flags a quote below Arc's documented 20 gwei fee floor. Manual EIP-1559 fee inputs are separate from a dynamic `feeLevel`. Circle documents an EOA gas-limit override when using a fee level. [Fee estimate API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-transaction-estimate-fee) · [Arc EVM differences](https://docs.arc.io/arc/references/evm-differences) |
| Managed lifecycle | `POST /v1/w3s/user/transactions/contractExecution` requires a UUIDv4 idempotency key and returns a challenge ID. Circle's SDK prompts for approval and Circle submits after authorization. A provider transaction record or outbound webhook can supply a `txHash`. Persist the challenge ID and approved intent before polling, and reconcile the hash against Arc receipt, transaction data, and exact Termul event. The challenge docs explicitly describe transaction correlation IDs for several challenge types but omit `CONTRACT_EXECUTION` from that explanation. The exact managed-execution ID handoff still needs live evidence. [Managed execution API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge) · [Challenge API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/get-user-challenge) · [Transaction API](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/get-transaction) · [Submission and monitoring](https://developers.circle.com/wallets/user-controlled/transfer-tokens) |

Circle's example bodies combine mutually exclusive selectors and calldata forms. The managed summary also says ABI parameters are required, while the field descriptions and SDK explicitly allow raw calldata. Fee-field descriptions sometimes point at the developer-controlled transfer estimator. The PoC follows the user-controlled contract estimator and the SDK's exclusive request shapes. No caller-supplied contract address, amount, or calldata is allowed.

### Contract and evidence

The preflight uses Termul's pinned configuration and checks chain 5042, runtime at latest and deployment block 32700130, and absence of code in the preceding block. It mirrors the production ABI entries used by creation and payment without loading the application entry point. The pinned runtime hash is `0x935f2f9ac6d407cbad56cd8f50ad87691ea68626052a2e64fab471153846839f` at `0x62209ab89631492e7943ef21baee792d430f5d0e`. The read-only check found 2,046 bytes of matching runtime at deployment and latest. The public zero-balance caller fixture could simulate creation and estimate 92,530 gas at a sampled RPC gas price of 25 gwei. Both payment probes returned Arc's OutOfFunds revert, classified as insufficient native USDC. A separate getInvoice read returned status 0 (None). Those observations came from Arc RPC without Circle credentials. [Pinned deployment](../../supabase/functions/_shared/termul-mainnet.js) · [Runtime verifier](../../src/arc-network.js) · [Contract](../../contracts/src/TermulInvoices.sol)

Creation requires a nonzero, unused merchant-scoped ID and a positive amount. The creation reconciler checks the exact transaction and `InvoiceCreated` event. Payment requires an open, unexpired invoice and exact native value. Merchant forwarding must succeed atomically. The payment reconciler uses the expected payer, transaction, successful receipt, matching `InvoicePaid` event, and invoice state to resolve or keep an attempt locked. A provider challenge marked complete never supplies that proof. [Creation reconciliation](../../src/invoice-creation.js) · [Payment reconciliation](../../src/payment-result.js)

All 21 Node tests passed, including the 11 regressions and a loopback test of the installed SDK's exact estimate request. Browser checks used synthetic OTP, SIWE, and fee responses. Live Circle estimation for the existing wallet remains an operator check. Live managed approval, nonce and fee enforcement, hash propagation, and onchain receipt reconciliation remain unverified.

### Future integration and separately authorized live test

- Keep Circle OTP as an additional wallet option and preserve Wagmi, injected connectors, and existing swaps and bridges. Use Circle wallet access to establish the selected EOA, then keep the existing SIWE ownership checks and verified Termul session.
- Use an invoice-specific managed adapter with a server-reviewed intent bound to chain, Circle wallet ID, sender, contract, calldata, value, and explicit fee limits. The API can carry exact calldata, value, and custom gas caps. It does not expose an explicit nonce input or a documented way to inspect the final signed bytes before Circle submits. A managed adapter cannot promise the current exact pending-nonce review without an architectural change or a new Circle capability. Validate the resulting onchain transaction and treat any deviation as unresolved. Provider execution and hash delivery are asynchronous, so an adapter should return a durable attempt ID rather than pretending to return an immediate `eth_sendTransaction` hash.
- Preserve Termul's payment reservation, stable idempotency key, attempt journal, and receipt and event checks. Bind the key to the reviewed intent, use a unique reference for correlation, and keep an ambiguous attempt locked while checking both Circle records and Arc. Session expiration or a wallet switch should invalidate approval controls while reconciliation for an in-flight attempt continues.
- After separate authorization and a successful live fee preflight, test a single zero-attached-value invoice creation with a fresh ID, short expiry, explicit reviewed fee limits, and an approved gas budget. Verify the exact onchain transaction and `InvoiceCreated` event before considering any payment test. The current zero-balance wallet cannot cover gas today.

## Phase 2B status

Live sign-only transaction testing with the existing native `ARC` wallet is blocked by the current endpoint documentation. This phase fixes the root route and initialization reconciliation. Use the existing Phase 2A wallet for the operator regression check.

- The HTTP router previously compared the complete request target, so `/?check=phase2b` missed the exact `/` route. The GET allowlist now matches the path while preserving the localhost host and API origin checks.
- Initialization previously treated an SDK error or non-`COMPLETE` callback as final and skipped wallet reconciliation. The installed SDK can also dismiss its iframe without invoking the callback. The exact operator callback payload was unavailable. Initialization now checks for the Arc EOA first, consults Circle challenge status when the EOA is absent, and polls for delayed visibility. A pending or complete challenge holds the creation action while the wallet is being reconciled. Known failed or expired challenges can be retried after reconciliation. A request with an unknown response reuses its idempotency key if retried.

For an operator regression check, start the PoC with its existing local configuration and open `http://localhost:4173/?check=phase2b`. Complete OTP with the existing account, verify the wallet ID and address match Phase 2A, use **Refresh wallet**, and inspect the balance and local SIWE flow. The existing wallet should appear without a creation prompt. Repeat login after logout if desired.

### Phase 2B verification

The local build and 11 Node tests passed, including all seven Phase 2A tests. Chromium used simulated Circle responses for initialization errors, UI dismissal, delayed wallet availability, session expiry and logout during reconciliation. The actual localhost route returned HTTP 200 with a query string. The Arc transport rejected both broadcast RPC methods before egress in a mocked transport test. The public read-only RPC check returned chain ID 5042 and a zero balance for the zero-address fixture.

### Sign-only endpoint findings

- Circle's native Wallets support matrix lists `ARC` for Arc Mainnet EOAs. The user-controlled sign-only endpoint `POST /v1/w3s/user/sign/transaction` explicitly lists `SOL`, `SOL-DEVNET`, `EVM`, and `EVM-TESTNET` in its endpoint-specific support note. The installed Node SDK `10.8.1` repeats that list. The shared request enum contains `ARC` and is broader than the endpoint note. The note controls this feasibility assessment. A generic `EVM` wallet registration falls outside this phase. [Native wallet support](https://developers.circle.com/wallets/supported-blockchains) · [Sign-only endpoint](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/sign-user-transaction)
- For eligible wallets, Circle accepts either an unsigned hex envelope or a JSON EIP-1559 transaction with chain ID, gas limit, max fee and priority fee. The Node SDK returns a challenge ID. The Web SDK `1.1.11` exposes the authorized result as `result.data.signedTransaction` on the `SIGN_TRANSACTION` callback. The public challenge GET response exposes status and error details, with no documented signed-payload field. [Sign-only endpoint](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/sign-user-transaction) · [Request a signature](https://developers.circle.com/wallets/user-controlled/request-a-signature) · [Get challenge](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/get-user-challenge)
- Circle documents rejection in the confirmation UI. The challenge status API distinguishes `PENDING`, `IN_PROGRESS`, `COMPLETE`, `FAILED`, and `EXPIRED`. No separate public revocation endpoint for a pending sign-only challenge was found. A closed SDK iframe supplies no authoritative status by itself. Managed transfer and contract-execution challenges are an onchain submission path and are outside this experiment. [Confirmation UIs](https://developers.circle.com/sdks/user-controlled/confirmation-uis) · [Managed transfers and contract execution](https://developers.circle.com/wallets/user-controlled/transfer-tokens)
- The Phase 2A mock EIP-1559 test checks Viem serialization and local signer recovery at chain ID `5042`. A real sign-only request, raw-result verification, and before/after nonce and balance comparisons require explicit Circle support for the existing native wallet and a subsequent operator test. [Arc RPC parameters](https://docs.arc.io/arc/references/rpc-endpoints)

## Local setup

Use Node 22.18 or newer. From the repository root, confirm the ignore rule before creating the credential file.

```sh
git check-ignore -v experiments/circle-wallet-poc/.env
cd experiments/circle-wallet-poc
npm ci
umask 077
cp -n .env.example .env
chmod 600 .env
```

Edit `.env` locally. Set `CIRCLE_API_KEY` to the restricted Mainnet Wallets Read & Write key, `CIRCLE_APP_ID` to the prepared Circle App ID, and `CIRCLE_TEST_EMAIL` to the dedicated account approved by the operator. You can also provide these through the Node process environment. Keep the API key out of shell history, chat, and browser configuration. The public App ID is the only Circle configuration served to the browser. Circle's Web SDK receives temporary OTP and session credentials in memory as required by its authentication flow.

```sh
npm test
npm run check:arc
npm start
```

The RPC check defaults to the public zero address. To use a different public address, run `npm run check:arc -- 0x…` with a full EVM address. For a startup smoke test, start the server before adding credentials and confirm the browser displays the local configuration prompt.

## Operator browser checks

1. Open `http://localhost:4173` after starting with credentials. Start with an approved account that has never initialized a wallet in this Circle app. Enter that email and select **Request OTP**. Check delivery from `no-reply@mail.termul.xyz` and the Termul template.
2. Select **Enter OTP in Circle** and enter the code in Circle's UI. Confirm that the app offers wallet creation after verification. The PoC limits OTP requests to one per 30 seconds. If you close the hosted prompt without a callback, reload to restart the local flow.
3. Select **Approve Arc EOA creation in Circle** and approve the SDK flow. Record the public wallet ID and address. The blockchain should read `ARC · Arc Mainnet (5042) · EOA`. If the wallet is still being indexed, select **Refresh wallet**.
4. Select **Read Arc balance**. Confirm chain 5042 and a numeric USDC balance. Zero is a valid result for an unfunded wallet.
5. Select **Sign local SIWE message**. Check that Circle shows the local SIWE message with `localhost:4173`, chain ID 5042, the displayed address, and an expiration. Approve in Circle. The result should report that the signature recovered the expected EOA and local SIWE verified. Dismissing a hosted flow can require a page reload.
6. Select **Log out or restart**, complete OTP login again using the same email, and compare both the wallet ID and address with step 3. The app should retrieve the wallet without offering creation. If you retried immediately, wait for the OTP cooldown.

The only browser signing action in this experiment is the local SIWE message. Logout clears local credentials through page navigation. Provider-issued sessions have their own expiration.

## Circle documentation and feasibility

| Capability | Finding |
| --- | --- |
| Email OTP | Circle's device-token API sends through configured SMTP. The Web SDK handles OTP entry and returns the user's session credentials. Circle documents recovery through continued access to the same email account. [Wallet quickstart](https://developers.circle.com/wallets/user-controlled/build-a-wallet-app#email-otp) · [Authentication and recovery](https://developers.circle.com/wallets/user-controlled/authentication-methods#email-otp) |
| SDKs | Circle publishes `@circle-fin/w3s-pw-web-sdk` and `@circle-fin/user-controlled-wallets`. For email onboarding, the documented initialization API returns a challenge for wallet creation, despite the SDK method's PIN-oriented name. [Web SDK](https://developers.circle.com/sdks/user-controlled/web-sdk) · [Node SDK](https://developers.circle.com/sdks/user-controlled-wallets-nodejs-sdk) · [Initialization challenge](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-with-pin-challenge) |
| Native Arc Mainnet EOA | Circle's support matrix and initialization API list `ARC` for Mainnet. Arc documents EVM chain ID `5042`. `ARC-MAINNET` is undocumented for these endpoints. [Circle support matrix](https://developers.circle.com/wallets/supported-blockchains) · [Arc RPC parameters](https://docs.arc.io/arc/references/rpc-endpoints) |
| Generic EVM EOA | Circle lists `EVM` for Mainnet EOA creation and signing on other EVM chains. Its managed balance lookup, transfers, contract execution, acceleration and cancellation are unavailable on that generic path. Callers own RPC balance reads, broadcasting and monitoring. Native `ARC` is the documented path for this PoC. [Circle support matrix](https://developers.circle.com/wallets/supported-blockchains#blockchain-specific-limitations) · [Unified addressing](https://developers.circle.com/wallets/unified-wallet-addressing-evm) |
| EIP-191 | Circle documents personal signing for SIWE. The PoC sends the exact UTF-8 challenge and uses Circle's SDK confirmation UI. Viem recovers the expected address in the browser. The backend checks the same local challenge and calls Termul's EOA verifier, including the Arc chain-ID and bytecode checks. [Request a signature](https://developers.circle.com/wallets/user-controlled/request-a-signature) · [Confirmation UIs](https://developers.circle.com/sdks/user-controlled/confirmation-uis) |
| Sign without broadcasting | The endpoint supports sign-only challenges for eligible wallets. Its explicit chain list excludes native `ARC`, despite the shared enum. The Arc envelope is verified only by the local mock. [User-controlled sign-only endpoint](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/sign-user-transaction) · [Arc RPC parameters](https://docs.arc.io/arc/references/rpc-endpoints) |

## Future Termul integration

- Use Circle email OTP for embedded-wallet access and scope its credentials to the selected wallet and login lifetime. Clear operation state on logout or wallet change. Add Circle as an additional wallet choice around the selection and provider boundary in [wallet-auth.js](../../src/wallet-auth.js) and [wallet-provider.js](../../src/wallet-provider.js). Keep the Wagmi and injected-wallet selection path. Give Circle its own stable connector identity and selection revision. Expose account and chain capabilities only for chains enabled for the wallet.
- Preserve the existing SIWE contract in [wallet-session.js](../../src/wallet-session.js), the Edge Function [challenge and verification flow](../../supabase/functions/termul-wallet-v1/api.js), and [EOA verifier](../../supabase/functions/termul-wallet-v1/verification.js). For Circle personal signing, decode the `personal_sign` hex parameters to the original UTF-8 SIWE message or pass the bytes with Circle's hex encoding option. Keep exact origin, domain, chain ID 5042, selected account, expiry, bytecode and signature checks, plus atomic nonce consumption and session issuance. [metadata-api.js](../../src/metadata-api.js) should continue to use the resulting verified wallet session and its existing access rules. Email OTP grants Circle wallet access. Termul metadata authorization still requires SIWE proof.
- For a later invoice pilot, keep the current Arc deployment and authenticated wallet checks, simulate and validate the reviewed invoice calldata, recipient, sender, pending nonce, value and EIP-1559 fees, and reserve the payment attempt before approval in [arc-invoices.js](../../src/arc-invoices.js). A future sign-only adapter should decode Circle's signed bytes and compare every reviewed field, recover the signer, and recheck selection before any separately authorized broadcast. The existing callers expect a transaction hash from `eth_sendTransaction`. A signing challenge ID and signed transaction bytes cannot serve as that hash.
- Keep the existing attempt journal and ambiguous-outcome recovery. Serialize future submissions by chain and sender, recheck pending nonce and fee validity after approval, and require a new review if a replacement changes reviewed fields. Derive the expected hash from the signed bytes for an approved future submission and persist the attempt before sending. Keep authoritative receipt, calldata, contract state and matching invoice event verification in [invoice-creation.js](../../src/invoice-creation.js) and [payment-result.js](../../src/payment-result.js). Circle challenge completion confirms an approval, while payment or invoice status comes from Termul's onchain checks.
- Keep current swap and any-token execution on its existing wallet path during an invoice pilot. [swap-execution.js](../../src/swap-execution.js) currently constructs a legacy gas-price request and verifies its receipt and transfer logs. Before enabling Circle for swaps, review the applicable fee envelope explicitly. [any-token-widget.js](../../src/any-token-widget.js) and [any-token-transfers.js](../../src/any-token-transfers.js) enforce the reviewed LI.FI route, source-chain checks, approvals, fee policy and receipt/status reconciliation. Enable any future Circle route only after its source-chain signer and these validations have been verified.

## Dependencies

The package and lockfile are scoped to this directory.

| Package | Version |
| --- | --- |
| `@circle-fin/w3s-pw-web-sdk` | `1.1.11` |
| `@circle-fin/user-controlled-wallets` | `10.8.1` |
| `viem` | `2.58.6` |
| `esbuild` | `0.28.2` |
| `esbuild-plugins-node-modules-polyfill` | `1.8.3` |
| `stream-browserify` | `3.0.0` |

The browser SDK requires Node compatibility shims at bundle time. The lockfile includes audit remediation overrides for `undici 6.29.1`, `@grpc/grpc-js 1.14.7`, and the Web SDK's `uuid 11.1.1`.

## Verification status

- Node tests cover OTP request controls and mocked provider handoff, initialization and retry deduplication, returning account retrieval, Arc balance gating, local SIWE with a synthetic EOA, one-time verification, and mock sign-only serialization for chain 5042.
- Chromium rendered the unconfigured PoC and passed a simulated Web SDK flow covering OTP, approval callbacks, wallet reuse, balance, local SIWE and logout. The browser test intercepted Circle and API responses.
- The live public RPC returned chain ID 5042 and native balance 0 USDC for the zero-address fixture.
- Live email delivery and OTP, explicit Circle EOA initialization, re-login with the same provider wallet, that wallet's balance, and Circle-generated SIWE signature recovery require the operator's credentials and approval. Live transaction signing requires separate approval.
