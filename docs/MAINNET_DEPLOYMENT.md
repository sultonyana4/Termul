# TermulInvoices Arc Mainnet deployment runbook

The owner runs the signing and verification steps manually from WSL Ubuntu after reviewing Phase 1.1. Arc Mainnet uses chain ID `5042` (`0x13b2`), `https://rpc.mainnet.arc.io`, and native USDC with 18 decimals. Use [Arc network details](https://docs.arc.io/arc/references/connect-to-arc), [RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints), and [Arc gas and fees](https://docs.arc.io/arc/references/gas-and-fees.md).

## Read-only preflight and local build

Open a dedicated WSL Ubuntu Bash session and run the blocks in order. A failed preflight command exits that session. Adjust the path if the reviewed checkout was moved.

```bash
set -euo pipefail
cd /home/deseti213/projects/Termul
git status --short --branch
git rev-parse HEAD
git diff --stat
git diff --check
forge --version
cast --version
arc-forge --version
arc-cast --version
arc-forge create --help
arc-cast wallet address --help
arc-forge verify-contract --help
```

Phase 1 was based on `64f90ac95050dd068821430d4b353ba696278ee4`. Review the tracked and untracked Phase 1 source before using the build. Phase 1 checked Foundry `1.5.1-stable` and Arc Foundry `1.7.1-dev` at `3e95efaeaaaca64d6ac9c1ee988968683dbd0d22`. Both `forge create` and `arc-forge create` list `--account <ACCOUNT_NAME>`, `--keystore <PATH>`, and `--broadcast`. Prefer Arc Foundry for deployment and Arc-specific simulation. [Arc Foundry deployment guide](https://docs.arc.io/arc/tutorials/deploy-on-arc).

```bash
cd contracts
forge build
forge test
arc-forge build
arc-forge test --network arc
```

Review the artifact and hashes. The fully qualified contract is `src/TermulInvoices.sol:TermulInvoices` relative to `contracts/`. The build has no external libraries, no constructor arguments, and no initialized immutable values. The Solidity compiler is `0.8.24+commit.e11b9ed9`, optimizer enabled with 200 runs, EVM target Cancun, via IR disabled, and CBOR metadata enabled with an IPFS hash.

```bash
ARTIFACT=out/TermulInvoices.sol/TermulInvoices.json
jq -e '.metadata.settings |
  select(.evmVersion == "cancun" and .optimizer == {"enabled":true,"runs":200}
         and .metadata.bytecodeHash == "ipfs") |
  {optimizer, evmVersion, metadata}' "$ARTIFACT"
jq '.abi' "$ARTIFACT"
CREATION_CODE="$(jq -er '.bytecode.object' "$ARTIFACT")"
REVIEWED_RUNTIME="$(jq -er '.deployedBytecode.object' "$ARTIFACT")"
CREATION_HASH="$(arc-cast keccak "$CREATION_CODE")"
RUNTIME_HASH="$(arc-cast keccak "$REVIEWED_RUNTIME")"
printf 'Creation hash %s\nRuntime hash %s\n' "$CREATION_HASH" "$RUNTIME_HASH"
test "$CREATION_HASH" = 0xa632c5bb00e25ca074c1ec2574ff89a21faa7aa5f6000e9ee60d6f8c155acc7c
test "$RUNTIME_HASH" = 0x935f2f9ac6d407cbad56cd8f50ad87691ea68626052a2e64fab471153846839f
```

The Phase 1 artifact has 2,079 bytes of creation code and 2,046 bytes of runtime code. The creation hash is `0xa632c5bb00e25ca074c1ec2574ff89a21faa7aa5f6000e9ee60d6f8c155acc7c`. The runtime hash is `0x935f2f9ac6d407cbad56cd8f50ad87691ea68626052a2e64fab471153846839f`. A change to source, source path, compiler, or settings can change these hashes. Investigate any mismatch before deploying.

Set the public RPC and verify its chain, current block, and gas quote. Enter the expected **public** deployer address from the owner's records.

```bash
ARC_RPC=https://rpc.mainnet.arc.io
test "$(arc-cast chain-id --rpc-url "$ARC_RPC")" = 5042
arc-cast block-number --rpc-url "$ARC_RPC"
arc-cast gas-price --rpc-url "$ARC_RPC"
read -r -p 'Expected public deployer address: ' PUBLIC_DEPLOYER
[[ "$PUBLIC_DEPLOYER" =~ ^0x[[:xdigit:]]{40}$ ]]
arc-cast balance --rpc-url "$ARC_RPC" "$PUBLIC_DEPLOYER"
arc-cast balance --ether --rpc-url "$ARC_RPC" "$PUBLIC_DEPLOYER"
```

A failed check stops preflight. The first balance is in native base units. The second command scales by 18 decimals and the resulting amount is USDC on Arc.

Select the existing account by its Foundry keystore filename. The following local command can prompt for the password to derive the public address. Type it only into the interactive terminal prompt. Compare the result with `PUBLIC_DEPLOYER` and stop on a mismatch. If the existing encrypted file lives outside Foundry's default directory, use `--keystore "$KEYSTORE_PATH"` in both wallet address and deployment commands instead of `--account`. The keystore path stays outside the repository.

```bash
read -r -p 'Existing Foundry keystore account name: ' TERMUL_DEPLOYER_ACCOUNT
KEYSTORE_DEPLOYER="$(arc-cast wallet address --account "$TERMUL_DEPLOYER_ACCOUNT")"
printf 'Keystore public address %s\n' "$KEYSTORE_DEPLOYER"
test "${KEYSTORE_DEPLOYER,,}" = "${PUBLIC_DEPLOYER,,}"
```

Estimate creation from the confirmed deployer without signing. Use a fresh fee quote. The cap below uses 120% of the suggested price with the current 20 Gwei Arc floor. The deployment gas limit includes a 20% margin. Both values remain subject to the wallet balance and prevailing network fees.

```bash
ESTIMATE_REQUEST="$(jq -nc --arg from "$PUBLIC_DEPLOYER" --arg data "$CREATION_CODE" '{from:$from,data:$data,value:"0x0"}')"
ESTIMATE_HEX="$(arc-cast rpc --rpc-url "$ARC_RPC" eth_estimateGas "$ESTIMATE_REQUEST" | jq -er '.')"
ESTIMATED_GAS="$(arc-cast to-dec "$ESTIMATE_HEX")"
GAS_PRICE="$(arc-cast gas-price --rpc-url "$ARC_RPC")"
PRIORITY_QUOTE="$(arc-cast rpc --rpc-url "$ARC_RPC" eth_maxPriorityFeePerGas | jq -er '.')"
PRIORITY_FEE="$(arc-cast to-dec "$PRIORITY_QUOTE")"
DEPLOY_GAS_LIMIT=$(( (ESTIMATED_GAS * 120 + 99) / 100 ))
FEE_CAP=$(( (GAS_PRICE * 120 + 99) / 100 ))
if (( FEE_CAP < 20000000000 )); then FEE_CAP=20000000000; fi
if (( FEE_CAP < PRIORITY_FEE )); then FEE_CAP=$PRIORITY_FEE; fi
DEPLOY_MAX_COST="$(python3 -c 'import sys; print(int(sys.argv[1]) * int(sys.argv[2]))' "$DEPLOY_GAS_LIMIT" "$FEE_CAP")"
printf 'Estimated gas %s\nGas limit %s\nFee cap %s base units per gas\n' "$ESTIMATED_GAS" "$DEPLOY_GAS_LIMIT" "$FEE_CAP"
arc-cast to-unit "$DEPLOY_MAX_COST" ether
DEPLOY_BALANCE="$(arc-cast balance --rpc-url "$ARC_RPC" "$PUBLIC_DEPLOYER")"
python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else "Insufficient native USDC for the gas budget.")' \
  "$DEPLOY_BALANCE" "$DEPLOY_MAX_COST"
```

The displayed amount is the upper budget in native USDC. Re-estimate if the session was interrupted or quotes moved. The broadcast block rechecks the chain ID, confirmed deployer, and current balance before signing. [Arc fee floor and runtime behavior](https://docs.arc.io/arc/references/evm-differences).

## Owner-only command that broadcasts

Run this once, after all preflight checks and only when ready to deploy. Keep shell tracing off. Use the current terminal's interactive keystore prompt and keep the password out of shell arguments, environment variables, logs, and the repository.

```bash
(
  set -euo pipefail
  test "$(arc-cast chain-id --rpc-url "$ARC_RPC")" = 5042
  test "${KEYSTORE_DEPLOYER,,}" = "${PUBLIC_DEPLOYER,,}"
  DEPLOY_BALANCE="$(arc-cast balance --rpc-url "$ARC_RPC" "$PUBLIC_DEPLOYER")"
  python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else "Insufficient native USDC for the gas budget.")' \
    "$DEPLOY_BALANCE" "$DEPLOY_MAX_COST"
  arc-forge create src/TermulInvoices.sol:TermulInvoices \
    --rpc-url "$ARC_RPC" --chain 5042 --from "$PUBLIC_DEPLOYER" \
    --account "$TERMUL_DEPLOYER_ACCOUNT" \
    --gas-limit "$DEPLOY_GAS_LIMIT" --gas-price "$FEE_CAP" \
    --priority-gas-price "$PRIORITY_FEE" --value 0 --broadcast
)
```

Record the public deployer, contract address, transaction hash, deployment block, compiler settings, source revision, and bytecode hashes. If the output is ambiguous, inspect the deployer's activity, nonce, and any returned hash on Arc Mainnet before deciding whether another deployment is required.

## Read-only verification of the deployment

Enter the actual public hash and address from the deployment output. Inspect the receipt and transaction. Confirm receipt status is success (`0x1`), transaction and receipt name the expected hash and deployer, the transaction has a null `to` and zero value, the receipt's `contractAddress` matches the recorded address, and the transaction's input equals the reviewed creation bytecode. The receipt is the source of the deployment block.

```bash
read -r -p 'Deployment transaction hash: ' DEPLOY_TX
read -r -p 'Deployed TermulInvoices address: ' CONTRACT_ADDRESS
arc-cast receipt --rpc-url "$ARC_RPC" "$DEPLOY_TX" --json
arc-cast tx --rpc-url "$ARC_RPC" "$DEPLOY_TX" --json
RECEIPT_BLOCK="$(arc-cast receipt --rpc-url "$ARC_RPC" "$DEPLOY_TX" blockNumber)"
DEPLOY_BLOCK="$(arc-cast to-dec "$RECEIPT_BLOCK")"
(( DEPLOY_BLOCK > 0 ))
DEPLOYED_CODE="$(arc-cast code --rpc-url "$ARC_RPC" "$CONTRACT_ADDRESS" --block "$DEPLOY_BLOCK")"
PREVIOUS_CODE="$(arc-cast code --rpc-url "$ARC_RPC" "$CONTRACT_ADDRESS" --block "$((DEPLOY_BLOCK - 1))")"
test "$DEPLOYED_CODE" = "$REVIEWED_RUNTIME"
test "$PREVIOUS_CODE" = 0x
ONCHAIN_CODE="$(arc-cast code --rpc-url "$ARC_RPC" "$CONTRACT_ADDRESS")"
test "$ONCHAIN_CODE" = "$REVIEWED_RUNTIME"
test "$(arc-cast keccak "$ONCHAIN_CODE")" = "$RUNTIME_HASH"
```

Record `DEPLOY_BLOCK` as the decimal value for Vite. Repeat the historical code checks on the browser RPC endpoint selected for activation.

## Manual source verification on Blockscout

The [Arc Mainnet Explorer](https://explorer.arc.io/) identifies itself as Blockscout. Phase 1 verified that the installed Arc Forge CLI lists `--verifier blockscout` and `--verifier-url`. Mainnet API probes received HTTP 403 from this environment, and Arc's deployment tutorial documents the Testnet verification endpoint. The actual Mainnet verification API route and permissions remain unconfirmed. Use the explorer UI if enabled, or ask Arc for the supported Mainnet verifier workflow if the form is unavailable. [Blockscout verification documentation](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification).

Export Solidity Standard JSON directly from the same build's build-info. Phase 1 found that Arc Forge's `verify-contract --show-standard-json-input` produced Shanghai settings even with the explicit Cancun flag. The build-info method below was independently recompiled with solc and produced both Phase 1 hashes. This command only generates local build files.

```bash
VERIFICATION_DIR="$(mktemp -d "$PWD/cache/termul-verification.XXXXXX")"
arc-forge build src/TermulInvoices.sol --force --build-info \
  --build-info-path "$VERIFICATION_DIR/build-info" --out "$VERIFICATION_DIR/out"
mapfile -t BUILD_INFO < <(find "$VERIFICATION_DIR/build-info" -maxdepth 1 -name '*.json')
test "${#BUILD_INFO[@]}" = 1
jq -e '.input | {language,sources,settings} |
  select((.sources | keys) == ["src/TermulInvoices.sol"] and
         .sources["src/TermulInvoices.sol"].content != null and
         .settings.evmVersion == "cancun" and
         .settings.optimizer == {"enabled":true,"runs":200})' \
  "${BUILD_INFO[0]}" > cache/TermulInvoices.standard.json
VERIFY_ARTIFACT="$VERIFICATION_DIR/out/TermulInvoices.sol/TermulInvoices.json"
test "$(jq -er '.bytecode.object' "$VERIFY_ARTIFACT")" = "$CREATION_CODE"
test "$(jq -er '.deployedBytecode.object' "$VERIFY_ARTIFACT")" = "$REVIEWED_RUNTIME"
jq '.abi' "$VERIFY_ARTIFACT" > cache/TermulInvoices.abi.json
```

1. Open the deployed address on `https://explorer.arc.io/address/<CONTRACT_ADDRESS>`. Open **Contract** → **Verify and Publish** and choose **Solidity (Standard JSON input)**.
2. Upload `cache/TermulInvoices.standard.json`. Select `v0.8.24+commit.e11b9ed9` if prompted. Select `src/TermulInvoices.sol:TermulInvoices` if the form requests the contract identifier. Leave constructor arguments empty. The JSON supplies optimizer, EVM version, and metadata settings.
3. Confirm the explorer shows verified source for the exact address, contract name, and compiler settings. Confirm the decoded ABI includes `createInvoice(bytes32,uint256,uint64)`, `payInvoice(address,bytes32)`, `cancelInvoice(address,bytes32)`, `getInvoice(address,bytes32)`, and the indexed `InvoiceCreated`, `InvoicePaid`, and `InvoiceCancelled` events. Compare against `cache/TermulInvoices.abi.json` and keep the independent runtime comparison above.
4. Record the address verification link and successful match. If the UI is unavailable or bytecode verification fails, source verification stays pending and production activation waits.

Continue with the separately authorized [activation, first payment, and recovery checklist](MAINNET_READINESS.md).
