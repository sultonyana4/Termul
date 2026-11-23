# Wallet migration security review

**SECURITY GATE PASSED — LOCAL IMPLEMENTATION READY FOR REVIEW**

## Dependency audit

| Production tree | Critical | High | Moderate | Low | Total | Distinct advisories |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Local branch before this change | 0 | 16 | 11 | 0 | 27 | 6 |
| Local branch after clean install | 0 | 0 | 0 | 0 | 0 | 0 |
| Separately audited Edge Function npm pins | 0 | 0 | 0 | 0 | 0 | 0 |

The working project passed `npm ci` and both the JSON and text production audits. The new lock was resolved from the pared-down manifest by npm. The manifest removes ConnectKit, Wagmi React, React, React DOM and TanStack React Query. Privy was already removed in the inherited migration. Removing Wagmi React eliminates its `@wagmi/connectors` dependency and the WalletConnect, Reown, Coinbase/Base Account, MetaMask SDK and Gemini branches. Optional Zod is absent. npm resolution used standard peer requirements and no overrides or audit suppressions.

| Former advisory | Former dependency path | Final resolution |
| --- | --- | --- |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | WalletConnect Ethereum Provider → Reown AppKit Wallet → Zod 3.22.4. Base Account → Coinbase CDP → Zod 3.25.76. | Zod and both connector branches are absent. |
| [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr), [GHSA-qr28-fpjm-wq7f](https://github.com/advisories/GHSA-qr28-fpjm-wq7f) | WalletConnect utils → query-string 7.1.3 → decode-uri-component 0.2.2. | Both transitive packages are absent. |
| [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx), [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) | WalletConnect/Reown → WalletConnect utils → Viem 2.23.2 → ws 8.18.0. | The sole installed ws version is 8.21.0 through Viem 2.57.17 and isows. Termul’s browser uses HTTP RPC. |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | MetaMask SDK and its communication layer → uuid 8.3.2. MetaMask Utils, Gemini and a legacy Coinbase dependency also resolved uuid 9.0.1. | The npm uuid package is absent. |

`npm ls --all` succeeded. `npm explain` traced Wagmi Core and Viem to Termul and ws to Viem and isows. The former connector packages are absent from the installed dependency graph. A separate sourcemap build checked emitted source paths. It found none from Privy, ConnectKit, Wagmi React, `@wagmi/connectors`, WalletConnect, Reown, Coinbase, Zod, decode-uri-component, uuid or ws.

### Final production graph

| Root | Installed dependencies |
| --- | --- |
| `@wagmi/core@2.22.1` | `eventemitter3@5.0.1`, `mipd@0.0.7`, `zustand@5.0.0` and the existing `viem@2.57.17` peer. |
| `viem@2.57.17` | `@adraffy/ens-normalize@1.11.1`, `@noble/ciphers@1.3.0`, `@noble/curves@1.9.1`, `@noble/hashes@1.8.0`, `@scure/base@1.2.6`, `@scure/bip32@1.7.0`, `@scure/bip39@1.6.0`, `abitype@1.2.3`, `eventemitter3@5.0.1`, `isows@1.0.7`, `ox@0.14.63` and `ws@8.21.0`. Several dependencies are shared. |

The Edge Function imports pinned Viem and Viem SIWE modules. An independent npm audit used the same 13 package versions as the frozen Deno lock and returned zero findings. Deno checked the source with its frozen lock.

## Controls and local regression evidence

- Wagmi Core uses a connector for the captured EIP-1193 provider. Viem maintains the existing Mainnet-only contract reads and transaction encoding. Wrong provider, account, chain and contract fixtures fail closed. A provider change during reservation prevented the send. An account/provider change after the wallet received the request left the transaction hash under the original payer for recovery and issued a single send request.
- The existing SIWE flow uses server-created canonical messages, an expiring random challenge, atomic one-time consumption and EOA-only verification on Arc Mainnet. Sessions use opaque hashed tokens, in-memory browser storage, scoped authorization, expiry and revocation. The offline API and wallet tests covered replay, wrong signer and altered fields, session expiry and revocation, and cross-merchant access.
- Isolated PostgreSQL validated additive migrations, RLS, restricted grants, expiry, rate limits and concurrent single-winner challenge confirmation and payment reservation. Wallet-auth SQL, Edge Function source and contract source were preserved during this update.
- The production build and all seven non-broadcast npm regression scripts passed. Headless Chromium 156 with Playwright 1.65.1 passed multi-wallet selection, Arc switching, native balance, profile verification and rejected signature handling, reconnect, logout and account-change revocation, dashboard indexing and verified Paid-link display. The browser used intercepted RPC and API responses, mock providers and the compiled artifact matching the pinned runtime hash.
- Forge and Arc Forge each passed 18 tests with zero failures or skips. `git diff --check` passed.

The test run used no real wallet signatures, blockchain transactions or hosted project access. Review actual wallet compatibility, hosted API gateway and CORS behavior, and the original payment receipts before production cutover. [Cutover and rollback runbook](WALLET_MIGRATION.md)
