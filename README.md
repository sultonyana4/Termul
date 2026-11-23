# Termul

Termul creates and settles invoices in native USDC on Arc Mainnet. The wallet-native branch uses Wagmi Core v2, Viem, and Termul’s injected-wallet picker. Arc Mainnet is the only transaction network. A verified wallet signature authorizes access to protected metadata.

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
```

Live wallet verification requires the exact HTTPS production origin. The offline fixtures do not use a real signature, wallet, or blockchain transaction. See the [wallet migration runbook](docs/WALLET_MIGRATION.md) and [security review](docs/SECURITY_REVIEW.md).
