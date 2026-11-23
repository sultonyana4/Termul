# Termul wallet-native migration

**Local implementation ready for review.** The production dependency audit is clean. Hosted gateway and real-wallet compatibility checks remain part of the external cutover. See [security review](SECURITY_REVIEW.md).

## Deployment boundary

| Item | Pinned value |
| --- | --- |
| Origin | `https://termul.xyz` |
| Chain | Arc Mainnet, `5042` |
| RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| Contract | `TermulInvoices`, `0x62209AB89631492E7943ef21bAee792d430f5D0E` |
| Deployment block | `32700130` |
| Runtime hash | `0x935f2f9ac6d407cbad56cd8f50ad87691ea68626052a2e64fab471153846839f` |

The frontend checks chain ID, exact runtime bytecode at latest and at the deployment block, and empty code in the preceding block. Existing Mainnet links with chain and contract tags keep the same meaning. The migration contains no contract deployment or transaction on the live chain. The owner's successful 0.01 USDC creation and payment remain part of the original contract history. The owner can compare their existing receipt hashes during review.

## Wallet and session model

Termul’s wallet picker uses Wagmi Core 2.22.1 and Viem 2.57.17. It shows EIP-6963 announcements separately and captures the provider object behind each option. It lists compatible legacy providers from the browser’s provider array and uses the single legacy global when there are no announcements. Rabby, MetaMask, Coinbase Wallet and other self-custodial wallets can connect in an environment exposing a compatible injected provider. Mobile users need a browser or wallet context offering injection. [Wagmi connector interface](https://wagmi.sh/core/api/createConnector) · [EIP-6963 discovery](https://eips.ethereum.org/EIPS/eip-6963)

A silent reconnect checks that one announced provider matches the stored wallet identifier and still exposes the previously selected primary account. An ambiguous match requires choosing again. The stored identifier and public address are preferences. Wallet names, domains and icons are extension claims. The picker uses text and bounded image data URLs for them. Disconnect clears the preference. Account or chain changes invalidate the in-memory authenticated session and request server revocation. Termul can disconnect locally while the wallet extension retains its browser permission. The user can revoke that permission in the extension.

A connected wallet can view public contract data. Protected reads and writes require an address proven by SIWE. The versioned Edge Function generates the exact message for `termul.xyz`, URI `https://termul.xyz`, chain `5042`, a random nonce, and a five-minute challenge. It hashes the challenge token and message. It checks Arc for the selected wallet's code and recovers the EIP-191 signer with Viem before atomically consuming the challenge and issuing a session. ERC-1271 wallets and accounts with deployed or delegated code fail closed.

The browser keeps a random opaque bearer token in memory for up to 12 minutes. Supabase stores the token's SHA-256 digest. Requests omit credentials and cookies, so cross-site cookie rules do not affect the session from the frontend to the Supabase hostname. The API requires the exact browser Origin and returns strict CORS headers. The frontend rejects redirects and validates the configured Supabase Function endpoint. Page refresh requires wallet verification again. Logout, account and chain changes clear the in-memory token and request revocation. Network outages can prevent revocation from reaching the server, so server-side expiry is the backstop. A request already authorized before a revocation may complete. Same-origin script compromise would still put an in-memory session at risk.

Each protected request derives ownership from the server session, checks the expected wallet, and scopes data by chain, contract, merchant or payer, and invoice ID. Profile and invoice metadata writes require a wallet proof less than six minutes old. Global and per-wallet, challenge, or session database rate limits bound API work. Input is streamed to a 16 KiB limit. Prune expired challenge/session rows and inactive rate buckets on a reviewed maintenance schedule. Reproduce the local migration, grants, and concurrency checks with `bash scripts/wallet-db.test.sh` using an installed PostgreSQL toolchain. Use monitoring or edge rate limiting if invalid origin or request floods exhaust the gateway. No authentication token or secret is persisted in browser storage.

## Data and payment recovery

The additive migration `20261123084651_termul_wallet_auth_v1.sql` adds wallet profiles, invoice metadata, use-once challenges, revocable sessions, rate limits, payment attempt reservations, and an index for legacy recovery. Its tables are RLS-enabled with service-only privileges. The versioned function `termul-wallet-v1` uses validated sessions instead of Supabase JWTs. Keep the existing hosted endpoint and original records for rollback.

Existing Mainnet merchant metadata is returned only for the exact original merchant address after EOA ownership is proved. New records use the wallet-owned table and a matching onchain creation receipt. Existing original metadata wins if both sources contain the same scoped invoice. Original testnet records and account-based profiles remain preserved. A legacy display name is not auto-linked, and historic records for inaccessible embedded keys or unsupported contract wallets remain private. A person who can prove the same original EOA via a supported wallet can recover its protected metadata. Approve any exceptional owner recovery separately with independent proof.

Payment submission checks the exact live invoice amount, payer account, chain, gas budget, deployment address, explicit nonce, and calldata. The injected wallet owns the signing prompt. Termul verifies resulting onchain state and matching receipt evidence. The application cannot inspect private signed bytes before the injected provider submits them. A provider that changes transaction terms can affect the request it submits. Review the wallet prompt before approval.

The browser and database persist non-authoritative recovery hints. A server reservation prevents simultaneous submissions for the same payer and invoice across devices. The contract prevents double settlement even across different payers. Ambiguous submissions remain reserved and are reconciled against Arc. The migration can read a legacy attempt by the original payer wallet and record its resolution in the new table without mutating the old record. Local storage contains the public wallet selection and public invoice recovery details. Recovery across devices requires wallet verification and a reachable API. If a wallet never returns a hash or a tab closes after reserving, review wallet activity, current contract state, pending nonce and any receipt before resolving the attempt. Preserve reservations when the outcome is uncertain. A reservation or metadata record never marks an invoice Paid.

## Offline Chromium smoke test

Run the contract build locally so the browser fixture can compare the artifact with the pinned runtime hash. Build with an isolated output directory and the fixture API URL. Use Playwright from a separate local installation. The harness intercepts the exact production origin, Arc RPC and fixture API, blocks other network traffic and uses simulated wallet responses.

```bash
(cd contracts && forge build)
VITE_TERMUL_WALLET_API_URL=https://fixture.supabase.co/functions/v1/termul-wallet-v1 \
  npm run build -- --outDir /tmp/termul-wallet-browser-dist
TERMUL_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs \
  TERMUL_FIXTURE_DIST=/tmp/termul-wallet-browser-dist \
  node scripts/wallet-browser.test.mjs
```

Set `TERMUL_CHROMIUM` to use a specific installed Chromium executable. The browser fixture covers injected selection, wrong-network recovery, balance, invoice indexing, rejected signature, sessions, reconnect, account switching, disconnect and a Paid invoice link.

## External reviewer cutover

1. Review the exact packaged build and rerun the production audit. Verify both independent RPC and explorer data for the pinned contract and the owner's two existing receipts. Confirm legacy Mainnet links still resolve before enabling production access.
2. Check backups, schema/grants, Gateway settings, and the active legacy frontend release. Rehearse the additive migration and wallet API against an isolated schema populated with representative legacy rows. Validate scope, nonce uniqueness, replay, Origin, JWT setting, and exact receipt verification.
3. Apply the additive migration to the reviewed project. Deploy only the new named function `termul-wallet-v1`. Configure its Supabase URL and `SUPABASE_SERVICE_ROLE_KEY` through the host's server configuration. The Function's `verify_jwt = false` setting is specific to this function, which verifies its own opaque session. Preserve the hosted legacy function and its settings.
4. Add the public `VITE_TERMUL_WALLET_API_URL` build variable for `https://<project-ref>.supabase.co/functions/v1/termul-wallet-v1`. The branch accepts HTTPS and this exact versioned route. Optional inherited `VITE_TERMUL_NETWORK`, Mainnet address, block, runtime hash, and RPC fields must agree with the pinned values if present. Retire old identity frontend variables from the new release configuration only after rollback is documented. Keep the legacy release's configuration available.
5. Verify the exact-origin browser flow with owner-approved wallets and the new API under controlled exposure. Check Rabby and MetaMask, Coinbase injection if offered, wrong-network switching, disconnect and account changes, rejected signature, original metadata retrieval, read-only Paid status and receipt links, refresh, and cross-device recovery. Enable the new production frontend only after the reviewer accepts those checks. Any real payment smoke test belongs to separate owner authorization.
6. Monitor verification failures, API rate limits, RPC code availability, failed recovery lookups, and invoice indexing times during cutover.

## Rollback

Restore the previous immutable frontend release and its associated configuration or pause the new frontend while leaving Arc invoice visibility available. The original hosted metadata endpoint and all legacy tables remain in place. Keep new wallet-owned rows, reservations, and payment evidence for reconciliation when resuming the new release. The old frontend may show new invoice metadata as unavailable because it reads the original tables. It can still derive invoice existence and payment status from Arc. Notify affected merchants and avoid recreating paid invoices or resubmitting uncertain payments.
