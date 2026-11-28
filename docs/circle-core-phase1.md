# Circle Wallet Core Phase 1

**Status: READY FOR LIVE ACCEPTANCE.** Existing-wallet localhost workflows have operator Mainnet evidence. The final UI needs a read-only operator check, and new-user onboarding and isolated hosted acceptance are pending. Circle Email Wallet remains scoped to Arc Mainnet (5042). Existing Web3 wallets remain multichain.

## Final reconciliation and dashboard follow-up

The November 27, 01:05 WIB operator checkpoint established live Circle and external SIWE, same-tab refresh, invoice creation, and settlement in both directions. The remaining defect was in the shared payer view. Its Paid-state branch ignored an available transaction hash and required an event lookup. The localhost lookup supplied raw receipt logs to a helper that expected decoded `args`, so it produced no proof even when the invoice index held the correct receipt. A terminal Circle callback could also clear the pending browser record before updating the dialog. The average metric had a separate cause. Its display was hardcoded to a dash despite the index already storing canonical creation and payment times.

- The shared payer flow now tries the known hash before looking up events. An indexed hash, receipt hint, or exact recent invoice log is a candidate for independent verification. The verifier checks the exact calldata, native value, payer, merchant, invoice, chain and contract, successful receipt and unique event, agreement with the finalized canonical block, and Paid state at that block. A Paid status without matching proof stays pending. A different payer or a different submitted hash does not become the current attempt’s success. Late Circle journal results and restored reservations update the matching dialog before it resolves the hint. No recovery path submits a transaction.
- The local metadata store archives a matching external settlement separately and retains the original reservation row and hash. A known pending hash cannot be cleared as successful through a browser-only assertion. The sidecar independently verifies the finalized receipt before recording success. The Circle journal retains the original matching payment and exposes its hash as a scoped recovery hint.
- A cold or far-behind index first verifies one recent finalized window, then continues from the original contiguous checkpoint. It persists the recent evidence separately, overlays it without double counting, and reuses the window when the main checkpoint reaches it. A recent payment whose creation is outside the covered range appears as verified partial history. Its missing creation timestamp is omitted from the average. All aggregates remain withheld until coverage is complete. Checkout uses cached history or a single recent targeted lookup and retains priority over paced background reads. [Arc event indexing](https://docs.arc.io/integrate/infrastructure/indexing-events)
- Average Payment Time uses only verified matching paid invoice timestamps. A complete history can display a sample count when some timestamps are missing. A same-block or same-timestamp settlement contributes zero seconds. The display uses seconds and minutes, so the actual **67 seconds** is visible.

### Independently verified Arc Mainnet evidence

All three transactions matched their creation and payment calls, emitters, exact invoice terms, finalized canonical block hashes, and state at the corresponding receipt blocks. These are existing transactions.

| Payment | Invoice ID | Creation → payment block | Amount | Duration |
| --- | --- | ---: | ---: | ---: |
| [External → Circle](https://explorer.arc.io/tx/0xf89d98091b830fbab91de1077734ea56de7747b3e575bab8adbfcc315c90cb49) | `0xf1205fd0fbd9ab391bb38c7b8398bb7fd0965ea5ea543ef893ae5bc9ef1f885f` | 33,277,511 → 33,277,654 | 0.10 USDC | 73 s |
| [Circle → external](https://explorer.arc.io/tx/0x16dac795d09fe208a2795ec48bb7dc7d1ba26ecc38ead135f5ac5dca1a551916) | `0xdfbf048a3f4467b1e79a28d71b42198ea91af4bf7804fe2272734c4495ac2551` | 33,278,629 → 33,284,169 | 0.01 USDC | 2,806 s |
| [External → Circle on localhost](https://explorer.arc.io/tx/0x001890f0ca4b0fa178513dabf82c1d18be8d262eb8004c0faabc24c0dd9bc7d4) | `0xd6d1550b2bf72994b88ba10bcc8b6e1f42a0476a79ad6ab81e5ca7b52238a04a` | 33,285,234 → 33,285,354 | 0.05 USDC | 61 s |

The Circle merchant’s two verified receipts total **0.15 USDC**, with **0 outstanding** at the operator checkpoint and an average of **1 min 7 s**. The local Circle journal has **five resolved attempts and zero unresolved attempts**. Local external metadata had one pending reservation and now retains its original row with one verified resolution. The metadata and index were backed up using SQLite’s backup API before changes. Integrity checks passed. Two actual localhost service starts recovered the same paid rows and original checkpoint **33,285,804** with financial execution off. Existing journals and earlier backups were preserved.

### Measured index recovery

- The copied warm index restored four Circle merchant invoices and both payments in **74 ms with zero RPC requests**. A six-page catch-up ran in **3.48 s using nine RPC requests** and kept totals marked incomplete while the roughly 149,000-block gap remained.
- A fresh index staged the recent window and fetched one forward page in **5.96 s using 15 RPC requests**, including two log queries and canonical proofs for two events. The recent interval and forward cursor survived reopening with zero RPC. At the current head this latest window contained no Circle merchant records, so the cold probe correctly reported incomplete coverage. The same-merchant tail merge and duplicate prevention were exercised with deterministic fixtures. The earlier full-scan HTTP 429 evidence is retained below.

### Verification and worktree

Passed **70 PoC tests**, **23 hosted API tests**, **11 Termul regression suites**, **18 Solidity tests**, and disposable PostgreSQL migration, security and concurrency checks. Desktop and mobile Chromium exercised delayed Circle receipts, external localhost payment from pending to success, a verified Arc link, refresh recovery, same-block average display, wallet switching and session restoration. The existing external Web3 suite passed across six viewports. Default and Circle-enabled builds passed, with no synthetic server credential in either artifact. These are automated checks. Current Mainnet evidence comes from the independent reads and operator checkpoint above.

Final branch `feat/circle-email-wallet` at `2b8b968`, with 20 modified tracked files and 75 untracked files including earlier work. Nothing is staged and `git diff --check` passed. Production, deployed contracts, the 0.1% LI.FI fee, the Circle 0.01 USDC fee cap, and the cross-chain admission boundary were unchanged. No new wallet or financial transaction was created. No commit, push, merge, or deployment occurred.

### Manual acceptance using existing receipts

Stop the previous runner with Ctrl+C, then start with financial execution off:

```bash
cd /home/deseti213/projects/Termul-circle-email-wallet
CIRCLE_WALLET_INITIALIZATION=disabled npm run dev:circle
```

Open `http://localhost:5173`. With each payer selected in turn, reopen the corresponding existing paid invoice link and use **View transaction status**. Check the exact verified hash and Arc Explorer link against the table, then refresh and reopen it. In the Circle merchant dashboard, check **0.15 USDC received**, **2 confirmed payments**, and **1 min 7 s** after sync completes. No live payment needs to be repeated. New-user live onboarding and isolated hosted acceptance remain separate release blockers requiring operator approval. Phase 1 remains **READY FOR LIVE ACCEPTANCE**.

## Public RPC and localhost wallet follow-up

The original external Web3 client at `2b8b968` permitted SIWE only against the hosted wallet API on the Termul production origin. The previous localhost runner provided an alternate Circle OTP and SIWE path but no alternate injected-wallet challenge endpoint. The latest localhost external wallet failure occurred in that origin/routing guard before any challenge or signature. The operator reports that production still prompts after refresh. The baseline held its proof in memory, and this investigation made no deployment. The updated local release candidate preserves production origin validation and tab-scoped restore and adds a separate localhost-only Web3 SIWE endpoint. It verifies Arc 5042 and EOA state, exact SIWE text, signature, nonce, and expiry against a server-side challenge. Sessions are address-scoped, expire after 12 minutes, and are validated server-side during same-tab restore. The local endpoint retains wallet-scoped metadata and duplicate-payment reservations in SQLite. A live read-only localhost smoke test exercised wrong-origin rejection, a synthetic EOA signature, replay rejection, validation and logout.

The old browser dashboard scanned twice from block 32,700,130 on first load and again after losing its in-memory cursor on reload. The same public endpoint served a separate sidecar client. Both callers repeated deployment-block and pre-deployment `eth_getCode` reads, with extra prechecks during payment navigation, review and execution. These reads competed with checkout and verification. The original latest failure hid the exact stage of the generic error after the portal message. HTTP 429 is reproducible on this endpoint, and pre-deployment bytecode is available when read under the revised budget.

| Request source | Previous behavior | Current local behavior |
| --- | --- | --- |
| Startup and wallet selection | SDK restore, balance and merchant sync could cascade after authentication. | External local SIWE requires only chain ID and wallet code. The history index starts from an active dashboard request. Checkout lookup of an indexed invoice does not start a historical scan. |
| Deployment verification | Chain ID plus latest, deployment-block and pre-deployment bytecode on every check. | Concurrent checks share one flight. The first complete bytecode proof is persisted under RPC origin, chain, address, deployment block and runtime hash. Every later financial verification still checks the current chain and runtime. |
| History | Two browser scans per merchant, 9,999 blocks per log call, plus transaction and receipt verification. | Shared local sidecar reads creation, payment and cancellation in one log stream. It writes canonical receipts and the checkpoint atomically to an isolated SQLite index. Refresh and restart return verified rows before catch-up. Incomplete or stale rows are shown as verified history, with aggregate metrics unavailable until coverage is current. |
| Checkout, review and execution | Pinned state and invoice reads, duplicate deployment checks and a browser merchant history scan. | Checkout reads the current invoice directly, and the managed sidecar revalidates the live deployment, wallet, invoice, simulation and fees. Arc and Circle quote outages are reported as separate pre-submission errors. One background request at a time is paced at 400 ms and shares a two-request limit with priority given to critical sidecar reads. |
| Reconciliation | Circle status and bounded receipt discovery, with repeated archive checks. | Existing bounded reconciliation and finalized canonical checks remain in force. Local paid-link lookup uses a cached event hash as a receipt hint. It never submits or renews a transaction. |

### Controlled read-only measurements

The probe used the official Arc Mainnet endpoint, an isolated new SQLite file, and no Circle session or financial access. At finalized block **33,282,648**, the old two-pass algorithm required **118 log pages** by calculation. It was not rerun at full volume. A separate prior read-only request over the whole range returned `-32012 requested range too large`. The new scan reached finalized block **33,282,653** in **59 successful log pages**, with 106 successful requests overall including deployment, finalized blocks, transactions, receipts and block-pinned invoice calls. The probe added one synthetic 429 to exercise Retry-After handling. The upstream separately returned **12 real HTTP 429s** (11 log requests and one transaction request), which the same run recovered from. Cold deployment verification used four requests (chain ID and three bytecode reads). A warm verification used two (chain ID and current bytecode). After reopening the database the exact 0.1 USDC settlement was available with **zero RPC requests**, then catch-up used one chain ID, one current bytecode, one finalized-head and one log request. [Arc RPC event indexing](https://docs.arc.io/integrate/infrastructure/indexing-events)

The indexed Circle merchant settlement matched transaction `0xf89d98091b830fbab91de1077734ea56de7747b3e575bab8adbfcc315c90cb49` and invoice `0xf1205fd0fbd9ab391bb38c7b8398bb7fd0965ea5ea543ef893ae5bc9ef1f885f`. The external merchant invoice `0xdfbf048a3f4467b1e79a28d71b42198ea91af4bf7804fe2272734c4495ac2551` remained **Open and unexpired at the independent read**, with exact native amount **0.01 USDC**. An `eth_call` from the Circle EOA succeeded and `eth_estimateGas` returned **51,326 gas**. This does not exercise Circle's fee estimate or approval. Journal `quick_check` was `ok`, with three resolved creation attempts and zero payment or unresolved rows. No reservation, challenge or submission was recorded for the failed Circle payment. Its historical provider response is unavailable.

The persistent index is a local sidecar feature. Hosted builds benefit from current/immutable deployment check separation, same-tab auth restoration, and existing browser recovery. A hosted persistent index would require a separately reviewed runtime and database plan if that capability is required before release. If the official public RPC cannot sustain operator use, Arc documents running an operator-controlled full node with direct JSON-RPC. No alternate endpoint or provider was configured. [Arc full node](https://docs.arc.io/arc/concepts/running-a-node)

Local verification passed **69 PoC tests**, **23 hosted API tests**, all **11 Termul regression suites**, disposable PostgreSQL security and concurrency, default and Circle-enabled builds, and mocked Chromium for local and hosted Circle plus external Web3 across six viewports. The local browser also exercised real localhost SIWE logic with a synthetic RPC and wallet signer, same-tab restoration, and cached dashboard recovery with mocked API results. The public-chain measurements and actual loopback smoke test above ran separately. Synthetic build credentials were absent from served artifacts.

### Restart and repeat acceptance

1. Stop the old runner with Ctrl+C. From `/home/deseti213/projects/Termul-circle-email-wallet`, run `CIRCLE_WALLET_INITIALIZATION=disabled npm run dev:circle` and open `http://localhost:5173`. Do not use `127.0.0.1` in the browser because its origin differs from the signed SIWE origin.
2. Connect the existing Circle wallet, verify once, then open the dashboard. Let the first backfill finish and check the verified 0.1 USDC payment. Refresh and restart. The verified rows should appear from the index after authentication, and totals should become current after catch-up. Use **Refresh** if needed. Keep the ignored `.env.arc-invoice-index.sqlite` file.
3. Switch to the existing external wallet on the same local URL. Switch to Arc if prompted, sign the localhost SIWE challenge, and reload the same tab before expiry. The app should restore without a second signature. Explicit logout, identity changes or expiry require verification again.
4. For separately authorized live Circle payment, stop the runner and run `CIRCLE_WALLET_INITIALIZATION=disabled npm run dev:circle -- --managed`. Use the checkout URL below if still Open and unexpired. Check the existing attempt first. Review exactly **0.01 USDC** attached and **no more than 0.01 USDC** network fee. Confirm each review and the Circle prompt explicitly, then require the canonical finalized `InvoicePaid` receipt and Paid state. Do not retry an unresolved attempt.

## Live creation, settlement and refresh follow-up

The operator passed Circle email OTP, Arc EOA connection, and localhost Circle invoice creation. They paid the Circle invoice using the external wallet through production, then created a separate 0.01 USDC invoice with the external wallet. Paying the second invoice through Circle on localhost stopped at a deployment RPC read. The following evidence was reproduced using public Arc reads. Each receipt was checked against its finalized block, transaction sender, target, exact calldata and native value, invoice event and state at the receipt block.

| Arc evidence | Finalized block | Terms and result |
| --- | ---: | --- |
| [Circle merchant invoice creation](https://explorer.arc.io/tx/0xedf6238bec162c32c922faf351ef0e45c53dd54bc6afdfdd8b21ef6136545a8e) | 33,277,511 | Invoice `0xf1205fd0fbd9ab391bb38c7b8398bb7fd0965ea5ea543ef893ae5bc9ef1f885f`, 0.1 USDC, zero attached, Open at creation |
| [External wallet payment to Circle merchant](https://explorer.arc.io/tx/0xf89d98091b830fbab91de1077734ea56de7747b3e575bab8adbfcc315c90cb49) | 33,277,654 | Payer `0x8D5D8e0D68C4815621260e5C64C20c6FC525b3A1`, merchant `0x6CB6b5a1b437591d4155975c35DF6448bFE88614`, exactly 0.1 native USDC attached, Paid at receipt and at latest read |
| [External wallet invoice creation](https://explorer.arc.io/tx/0x9c771f996904cd63f30dc5206ee875c93cbb78c02f5955b1285e4b20371be3c8) | 33,278,629 | Invoice `0xdfbf048a3f4467b1e79a28d71b42198ea91af4bf7804fe2272734c4495ac2551`, 0.01 USDC, zero attached, Open at creation and latest read. Check expiry `1795798799` again before use. |

The Circle native balance returned `0.192443614790130545 USDC`. SQLite integrity passed with three resolved creation attempts and zero unresolved rows. No payment reservation, challenge ID, or transaction hash was recorded for the failed payment. The underlying error text from the original request was discarded by the old catch, so its exact provider response cannot be recovered.

- **BUG-001.** Previously the hosted SIWE bearer existed only in memory. Circle's cookie restored its SDK session, while local SIWE ownership proof remained server-side and the restored browser received no expiry. Hosted Circle and external wallets now retain only the short-lived Termul SIWE bearer in per-tab `sessionStorage`, isolated by wallet type, address, connector and API endpoint. Restoration checks the selected wallet and revalidates the bearer through the existing authenticated wallet API. External restoration also rechecks the live provider's account and chain. Local Circle restores the original proof expiry from its server-side vault, tied to the same Circle token and EOA. Full expiry, account changes, logout and local server restart still require new proof as applicable. Existing challenge and fresh-authorization checks remain in effect. Localhost external wallets still follow the existing origin boundary for hosted metadata and do not gain access to production-authenticated metadata through the local server.
- **BUG-002.** The old dashboard treated a deployment or event scan error as unavailable for all metrics. RPC returned `-32012` for a wide event range and HTTP 429 / `-32005` during paginated log reads and block-pinned invoice reads. Balance could succeed because it required fewer reads. The dashboard now scans finalized pages in sequence, narrows rejected ranges, backs off on transient errors, resumes completed pages in the current wallet view, and deduplicates concurrent sync. Offchain metadata is optional. Totals and history publish only after matching canonical receipts and contract state. Failed reads keep totals unavailable and explain how to refresh. The display uses up to six decimals and exposes the exact native balance separately. [Arc event indexing](https://docs.arc.io/integrate/infrastructure/indexing-events)
- **BUG-003.** The message was thrown by `invoice-pilot.js` around `verifyManagedDeployment`, before either a quote-time or execution-time check can reserve an attempt. That catch covered failed `eth_chainId` and latest/historical `eth_getCode` requests. A returned chain or runtime mismatch had a different error. Current read-only checks returned chain 5042 and the pinned runtime hash at latest and deployment block 32,700,130, with empty bytecode at block 32,700,129. The same endpoint demonstrably rate-limited other historical reads during the investigation. The operator's exact RPC error and check stage were unrecorded. The deployment verifier now retries transient reads within a bounded budget and identifies the failed check stage if it cannot recover. Contract identity, native value, fee review, the **0.01 USDC** network fee cap and finalized receipt validation remain enforced. Circle continues using its server-owned transaction while external payments continue through the connected provider.

### Repeat acceptance for the remaining payment

1. Stop the previous local application and restart it from the development worktree with `CIRCLE_WALLET_INITIALIZATION=disabled npm run dev:circle -- --managed`. Open `http://localhost:5173`. Reuse the existing Circle EOA. Verify ownership once, reload the same tab within the proof lifetime, and verify that it remains authenticated.
2. Open the dashboard. Check that the verified 0.1 USDC external payment appears in history and totals and that the native balance is shown separately. If RPC sync is interrupted, use **Refresh** and wait for the current scan to complete.
3. Check **Check Circle attempt** for unresolved work. Then reopen the original external invoice link if still Open and unexpired. Use an independently authorized replacement 0.01 USDC invoice if the original expired. Verify the external merchant, Circle payer, native value **0.01 USDC**, and network fee at most **0.01 USDC**. Confirm the app review and then Circle's native prompt only under the existing live authorization rules. Require a finalized success, exact `InvoicePaid` event and Paid state. Refresh and confirm the same proof remains visible. A pending or ambiguous result should be checked through the existing attempt.

Original external invoice checkout on the local candidate:

```text
http://localhost:5173/?chainId=5042&contract=0x62209ab89631492e7943ef21baee792d430f5d0e&merchant=0x8D5D8e0D68C4815621260e5C64C20c6FC525b3A1&invoiceId=0xdfbf048a3f4467b1e79a28d71b42198ea91af4bf7804fe2272734c4495ac2551
```

The follow-up checks passed 66 Circle PoC tests, 23 hosted API tests, all 11 Termul regression suites, and the disposable PostgreSQL security and concurrency rehearsal. Chromium covered Circle restore, metadata failure with verified dashboard settlement, rate-limit recovery, fee refresh, and managed payment with mocks. It also covered the external wallet across six viewports, including proof restoration without `personal_sign`. Both builds passed, and the synthetic server credential was absent from the artifacts. A new live Circle payment remains outstanding. No new signing or financial submission was made during this investigation.

## Live acceptance follow-up — invoice fee review

The operator completed Circle email login and connected the Arc wallet. The subsequent **0.01 USDC** invoice creation was rejected during fee revalidation. The earlier implementation allowed 10% gas-limit and 5% price and tip headroom, with no headroom on any field if the combined bound did not fit the budget. Any of the three comparisons returned the same error. It also left the failed review usable until expiry. The reported error confirms at least one threshold was crossed. It does not identify which threshold. The paired estimates were not persisted, and later fee observations cannot reconstruct them. This rejection occurred before reservation and Circle challenge creation. SQLite integrity passed and the journal held exactly two prior verified rows and zero unresolved attempts. No new attempt, challenge, or submission was recorded.

Arc RPC estimates simulated units and supplies a gas-price recommendation. Circle's Medium quote supplies its own gas limit and EIP-1559 fee caps. Historical creation estimates were 92,530 RPC units and 124,915 Circle units, a difference in the estimates themselves. A Nov 26 read-only Arc RPC sample returned a 20 Gwei block base fee, 25 Gwei gas price and 5 Gwei suggested priority fee. Circle publishes no formula for the Medium quote on the consulted endpoint. The implementation converts Circle's decimal Gwei to integer base units and validates precision before conversion. No conversion or rounding defect was demonstrated. The external wallet uses a single RPC estimate and passes the chosen EIP-1559 values to the injected wallet. It does not compare two Circle quotes. That external path is unchanged. [Arc gas and fees](https://docs.arc.io/arc/references/gas-and-fees) · [Circle contract fee estimate](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-transaction-estimate-fee) · [Circle absolute fee fields](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge)

- A Circle review starts with the larger RPC or Circle gas estimate. Its fee baseline is the highest of the RPC gas price, Circle max fee, and latest Arc base fee plus Circle's quoted tip. The UI shows the approved maximum fee. The server aims for 15% gas and 25% price headroom and scales both down as necessary to fit the smaller of the **0.01 USDC** ceiling and the native balance remaining after attached value. The tip allowance is up to the larger of 50% or 1 Gwei extra, within the approved per-gas ceiling. The challenge uses the revalidated tip within that allowance and the approved gas and max-fee limits. The journal records the exact parameters sent to Circle.
- Fresh estimates outside the review invalidate the specific review before reservation. The API identifies any crossed fields and reports the approved and current values. Circle creation and payment offer one replacement review with the original calldata hash and attached value. The replacement requires another explicit **Continue to Circle** action, then Circle approval. Cancelling keeps the creation form. If the replacement goes stale, the flow returns control with a fee-review message. Above the absolute cap, the operation stops without issuing a replacement challenge or raising the cap.
- Wallet ownership, fresh authorization, unchanged calldata, sufficient funds, journal reservation, idempotency, and finalized canonical receipt checks remain required. A timeout or an ambiguous submission stays on the existing recovery path. There is no automatic financial retry.
- Follow-up tests passed: **66 Circle PoC**, **23 hosted API**, all **11 Termul regression suites**, disposable PostgreSQL, and default and Circle-enabled builds with a synthetic credential scan. Local Chromium cancelled an updated creation review and retained all invoice fields. Hosted Chromium required a second explicit confirmation before the mocked payment challenge. The external Web3 browser suite passed across six viewports. No new financial action was performed.

For the repeat, stop the earlier local server with Ctrl+C, then use the exact managed startup command in the checklist below. Reuse the existing Arc EOA and use **Check Circle attempt** if an unresolved outcome is shown. Verify zero attached USDC for the creation and a reviewed network cap at or below **0.01 USDC**. If **Review updated Circle fees** appears, compare the invoice terms, calldata and new maximum cost before separately confirming. If the hard-cap message appears, stop and check again later. Finish only after the exact finalized receipt and event are visible. A current-candidate live creation and an authorized payment verification remain outstanding.

## Audit and scope

The development worktree was on `feat/circle-email-wallet` at `2b8b968`. Its existing, unstaged Circle integration included local and hosted email OTP, wallet discovery and initialization, SIWE, session restoration, Circle managed invoices, Arc USDC/EURC, CCTP and LI.FI cross-chain adapters. Cross-chain admission had opt-in environment variables. Arc invoice verification compared transaction and receipt block hashes without checking their hash against a finalized canonical block. The local PoC could offer wallet setup with no dedicated environment gate. The existing pilot journal contained two verified invoice attempts. The updated Circle API authentication HTTP 200 is operator-reported. The environment file was confirmed ignored with permissions 600.

Circle's current documentation lists ARC Mainnet EOAs as supported, provides SDK-based email OTP and native challenge confirmation, and documents contract execution with explicit fee parameters. The installed versions are `@circle-fin/user-controlled-wallets@10.8.1` and `@circle-fin/w3s-pw-web-sdk@1.1.11`. [Circle networks](https://developers.circle.com/wallets/supported-blockchains) · [Circle wallet app and OTP](https://developers.circle.com/wallets/user-controlled/build-a-wallet-app) · [Circle managed execution](https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge)

| Feature | External Web3 | Circle in Phase 1 |
| --- | --- | --- |
| Login, wallet ownership, balances | Existing Connect Wallet, Wagmi and chain support | Circle OTP, one existing Arc EOA, SIWE, native USDC balance, refresh and logout. New EOA setup requires a separate explicit opt-in and Circle confirmation. |
| Invoice creation, links, payment and history | Existing Arc workflow | Existing managed Arc execution and independent receipt reconciliation. Historical creation evidence, mocked current-candidate creation and payment. |
| USDC/EURC on Arc | Existing swap | Prior gated adapter preserved. Current regression uses mocks. No new swap functionality in Phase 1. |
| Any Token within Arc | Existing widget | Approved future core scope. General route execution deferred beyond Phase 1. |
| Multichain Any Token and bridges | Existing catalog, connection and fees | Deferred. Owner-scoped recovery and history for previously admitted CCTP and LI.FI operations. |
| Fiat ramps | Outside this work | Deferred. |

## Changes and recovery

- The hosted managed API denies cross-chain review and execution, even with a confirmed prior review ID or stale admission flags. The Circle frontend also rejects those actions and hides their forms. The **Previous Circle transfers** section only exposes status, links and closing an eligible unsubmitted route. Closing a route leaves any confirmed allowance in place.
- Authenticated recovery checks the Circle token, unique Arc EOA, SIWE wallet ownership and stored route wallet ID. The existing background reconciliation flags still operate independently of new financial execution. Existing routes with an already-issued provider challenge remain subject to its provider lifecycle. Disabling admission does not revoke a challenge previously issued by Circle.
- Invoice transaction and receipt evidence must agree with a finalized canonical block before an attempt can resolve. Unfinalized, mismatched, or unavailable proof leaves the attempt pending. Existing settlement checks still bind exact calldata, sender, Termul contract, attached native value, reviewed gas, expected event and block-pinned invoice state. Refresh, restart and temporary provider failure never resubmit an ambiguous transaction.
- Native USDC is reviewed and displayed in 18-decimal base units. Existing ERC-20 swap amounts remain token-specific. Invoice execution requires a fresh SIWE proof and explicit application and Circle approvals, reserves one durable attempt and rechecks fees and payer balance. The invoice network fee ceiling remains **0.01 USDC**.
- Local wallet initialization is disabled by default. `CIRCLE_WALLET_INITIALIZATION=enabled` is a separate local opt-in. Hosted initialization retains its existing `TERMUL_CIRCLE_INITIALIZATION` gate. The browser checks selection after asynchronous initialization and SIWE before using the selected wallet for an invoice review.
- The existing Termul contract, migrations, SQLite journals, external connector and swap execution paths, and LI.FI fee policy are preserved. Release and external browser builds were exercised with 10 bps (0.1%).

## Verification

| Check | Result |
| --- | --- |
| Circle PoC | 63 tests passed, including opt-in wallet initialization, native balance and invoice verification, challenge handling and restart recovery |
| Hosted API and adapters | 22 tests passed, including disabled cross-chain admission, owner-scoped recovery, finality, concurrent reservation and session isolation |
| Existing Termul and Solidity | 11 regression suites and 18 Solidity tests passed |
| Local PostgreSQL | Entire migration sequence passed in a disposable database. RLS, grants, wallet scope, concurrency, stale/expired challenges and restart recovery passed |
| Default and Circle-enabled production builds | Passed with synthetic endpoint and 10 bps fee settings. Vite reported its large chunk advisory. The default artifact excludes the Circle SDK and the synthetic server key was absent from both artifacts |
| Worktree-local startup | Supervisor started with execution off. SQLite journals and backups retained identical hashes |
| Browser | Local and hosted Circle Chromium passed with mocks on desktop and mobile. Tests covered OTP, SIWE, wallet switching, session restoration, invoice review and rejection, payment-link settlement, disabled financial flags, and historical CCTP/LI.FI recovery after refresh. The external Web3 browser suite passed across six viewports with the 10 bps fee build. |

## Mainnet evidence

Read-only Arc RPC confirmed chain 5042, the expected Termul runtime hash, finalized canonical blocks, exact historical creation receipts and open invoice state at the event blocks. Both invoices are now expired and are unsuitable for the live payment check. The SQLite journal returned `PRAGMA integrity_check = ok`.

| Historical Arc invoice creation | Finalized block | Actual fee |
| --- | ---: | ---: |
| [e9b0bcff…4244](https://explorer.arc.io/tx/0xe9b0bcffd545c894b32c99dbe81d4aa6144e9f2fe87a5d5973b2f045b3124244) | 32,911,215 | 0.002783725574483098 USDC |
| [f49c7786…aa4c](https://explorer.arc.io/tx/0xf49c778697f5abdee1c9646b4245a78ecbfe8deae800017545d64643bf1baa4c) | 32,916,388 | 0.002369370354136357 USDC |

There was no new live OTP, wallet setup, invoice creation, or payment during this phase. Full transaction acceptance and isolated hosted end-to-end integration with actual provider sessions remain outstanding. General Arc Any Token and Circle bridges do not block Phase 1.

## Start locally

From the development worktree, with the existing ignored sidecar environment and installed dependencies:

```bash
cd /home/deseti213/projects/Termul-circle-email-wallet
CIRCLE_WALLET_INITIALIZATION=disabled npm run dev:circle
```

Open `http://localhost:5173`. The localhost sidecar runs on port 4173. Use **Continue with Email**, reuse an existing Arc EOA, verify SIWE as prompted, refresh, sign out, and switch between wallet types. Stop both services with Ctrl+C. The default leaves financial execution off. The existing `--managed --arc-swap` development option remains available outside the Phase 1 acceptance script.

### Operator live acceptance after separate authorization

1. With execution off, reuse the existing approved Circle account. Check OTP delivery, address and balance, SIWE, refresh, expiry, logout and switching to external Web3. If onboarding needs live acceptance, separately approve an unused test identity and enable `CIRCLE_WALLET_INITIALIZATION` for that test only. A returning-user pass must retrieve the same EOA and show no initialization prompt.
2. After explicit financial authorization, run `CIRCLE_WALLET_INITIALIZATION=disabled npm run dev:circle -- --managed`. Create an invoice for **0.01 USDC**, select tomorrow as the due date, and confirm the reviewed expiry is **23:59:59 local time** on that date. Attached native USDC must be zero. Maximum network fee **0.01 USDC**. Use application review and Circle confirmation. Require a finalized success, exact `InvoiceCreated` event, merchant, invoice ID, amount, expiration and Open state at the receipt block. Copy and open the payment link from a separate browser context.
3. Separately authorize the payment using a suitable existing, funded payer with a distinct address. Confirm the invoice is still Open and unexpired. Review **0.01 USDC attached** and network fee **at most 0.01 USDC**, for **at most 0.02 USDC** total from the payer. Decline the first challenge and verify there is no payment before fresh authorization. Confirm a finalized success with exact `InvoicePaid` event, merchant, payer, invoice ID, amount and Paid state. Confirm the history and payment link update after refresh. Stop if a quote exceeds the cap or either identity is unavailable. Do not retry a pending or ambiguous submission.
4. Repeat equivalent acceptance against an isolated hosted environment before release. Existing cross-chain recovery must remain read-only with respect to blockchain writes.

## Phase files and Git status

- Admission and recovery: `api/termul-circle-{login,managed}.js`, `server/circle/{login-api,managed-api,login-api.test,managed-api.test}.js`, `index.html`, `src/{circle-wallet,swap-tabs,circle-bridge-ui,circle-lifi-ui}.js`, and `.env.example`.
- Local core and reconciliation: `experiments/circle-wallet-poc/{.env.example,browser.js,server.js,operations.js,poc.test.js,invoice-pilot.test.js,pilot-reconciliation.js}` and `scripts/circle-browser.test.mjs`.
- Release notes: this report and the four prior Circle scope and release reports. No migration added.

The worktree remained on `feat/circle-email-wallet` at `2b8b968`. The RPC follow-up left 19 modified tracked files and 75 untracked files including the earlier integration. There were no staged changes. `git diff --check` passed. No production database, worktree, site, GitHub, Vercel, Supabase, deployed contract or financial state was modified. No commit, push, merge or deployment occurred.
