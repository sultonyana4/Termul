import { assertCurrentFeePolicy, feePolicyChanged, sameFeePolicy } from './fee-policy.js';
import { TERMUL_INTEGRATOR } from './swap-fee.js';
import { decodeEventLog, encodeFunctionData, erc20Abi, keccak256, numberToHex, parseAbi, zeroAddress } from 'viem';
import { arcNetwork } from './arc-network.js';
import { assertWalletProvider, sameWallet } from './wallet-provider.js';
import {
  APPROVAL_GAS_LIMIT, FEE_FORWARDER, FLY_ROUTER, MAX_SWAP_GAS_LIMIT, SWAP_FACET, SWAP_ROUTER, SWAP_TOKENS,
  assertFreshQuote, equalAddress, isHash, unsigned,
} from './swap-quote.js';

const completedAbi = parseAbi(['event LiFiGenericSwapCompleted(bytes32 indexed transactionId,string integrator,string referrer,address receiver,address fromAssetId,address toAssetId,uint256 fromAmount,uint256 toAmount)']);
const loupeAbi = parseAbi(['function facetAddress(bytes4 selector) view returns (address)']);
const tokenPrecisionRatio = 10n ** 12n;
const ARC_MIN_GAS_PRICE = 20_000_000_000n;
const storagePrefix = 'termul.arc-swap.v1:';

async function requireMainnet(client) {
  if (arcNetwork.error || await client.getChainId() !== arcNetwork.id) throw new Error('Arc Mainnet is unavailable. No transaction was requested.');
}

const tokenRead = (client, token, functionName, args) =>
  client.readContract({ address: token.address, abi: erc20Abi, functionName, args });

export async function readSwapBalances(client, address) {
  await requireMainnet(client);
  const [USDC, EURC, native] = await Promise.all([
    tokenRead(client, SWAP_TOKENS.USDC, 'balanceOf', [address]),
    tokenRead(client, SWAP_TOKENS.EURC, 'balanceOf', [address]),
    client.getBalance({ address }),
  ]);
  return { USDC, EURC, native };
}

async function gasPrice(client) {
  const price = await client.getGasPrice();
  return price < ARC_MIN_GAS_PRICE ? ARC_MIN_GAS_PRICE : price;
}

const withGasHeadroom = value => (value * 12n + 9n) / 10n;

export function spendableAmount(balances, token, reserve) {
  if (token !== SWAP_TOKENS.USDC) return balances[token.symbol];
  const remaining = balances.native > reserve ? (balances.native - reserve) / tokenPrecisionRatio : 0n;
  return remaining < balances.USDC ? remaining : balances.USDC;
}

export async function maxSwapAmount(client, address, token) {
  const [balances, price] = await Promise.all([readSwapBalances(client, address), gasPrice(client)]);
  return spendableAmount(balances, token, withGasHeadroom(price) * (MAX_SWAP_GAS_LIMIT + APPROVAL_GAS_LIMIT));
}

function requireBalance(quote, balances, gasBudget) {
  if (balances[quote.from.symbol] < quote.amount) throw new Error(`Insufficient ${quote.from.symbol} balance.`);
  if (spendableAmount(balances, quote.from, gasBudget) < quote.amount || balances.native < gasBudget) {
    throw new Error('Keep enough native USDC to pay the network fee.');
  }
}

export async function reviewSwap(client, quote) {
  assertFreshQuote(quote);
  const [balances, allowance, price] = await Promise.all([
    readSwapBalances(client, quote.account), tokenRead(client, quote.from, 'allowance', [quote.account, SWAP_ROUTER]), gasPrice(client),
  ]);
  const needsApproval = allowance < quote.amount;
  const priceLimit = withGasHeadroom(price);
  const gasBudget = priceLimit * (quote.gasLimit + (needsApproval ? APPROVAL_GAS_LIMIT : 0n));
  requireBalance(quote, balances, gasBudget);
  assertFreshQuote(quote);
  return { needsApproval, gasBudget, gasPrice: priceLimit, feePolicy: quote.feePolicy };
}

async function verifyRouteDeployment(client, data) {
  const [facet, flyCode, feeCode, usdcDecimals, eurcDecimals] = await Promise.all([
    client.readContract({ address: SWAP_ROUTER, abi: loupeAbi, functionName: 'facetAddress', args: [data.slice(0, 10)] }),
    client.getCode({ address: FLY_ROUTER }),
    client.getCode({ address: FEE_FORWARDER }),
    tokenRead(client, SWAP_TOKENS.USDC, 'decimals', []),
    tokenRead(client, SWAP_TOKENS.EURC, 'decimals', []),
  ]);
  if (!equalAddress(facet, SWAP_FACET) || !flyCode || keccak256(flyCode) !== '0xaffe8098fa7a152f718c07de0ea7657382e535a301aaf12f89bbba8f91e4b352'
    || !feeCode || keccak256(feeCode) !== '0x99a76627aece8903612e0246c10f13a46e511a0a074d9a4e68987a28c78ebd52'
    || usdcDecimals !== 6 || eurcDecimals !== 6) throw new Error('The reviewed Arc swap deployment could not be verified.');
}

function validateRecord(record, account) {
  if (!equalAddress(record?.account, account) || !Object.hasOwn(SWAP_TOKENS, record.from)
    || !Object.hasOwn(SWAP_TOKENS, record.to) || record.from === record.to
    || !['approval', 'swap'].includes(record.phase) || !isHash(record.dataHash) || !isHash(record.id)
    || (record.hash !== null && !isHash(record.hash)) || (record.approvalHash && !isHash(record.approvalHash))
    || (record.integrator !== undefined && record.integrator !== TERMUL_INTEGRATOR)
    || !['pending', 'done'].includes(record.state) || unsigned(record.amount) <= 0n || unsigned(record.minimum) <= 0n) {
    throw new Error('The saved swap reference is invalid.');
  }
  return record;
}

export function swapLedger(storage) {
  const key = account => storagePrefix + account.toLowerCase();
  return {
    get(account) {
      const raw = storage.getItem(key(account));
      return raw ? validateRecord(JSON.parse(raw), account) : null;
    },
    put(record) { storage.setItem(key(record.account), JSON.stringify(record)); },
  };
}

function verifiedTransfers(receipt, record) {
  const from = SWAP_TOKENS[record.from];
  const to = SWAP_TOKENS[record.to];
  let spent = 0n;
  let received = 0n;
  let completion;
  for (const log of receipt.logs) {
    if (log.removed || log.transactionHash?.toLowerCase() !== record.hash.toLowerCase()) continue;
    if (equalAddress(log.address, SWAP_ROUTER)) {
      try {
        const { args } = decodeEventLog({ abi: completedAbi, data: log.data, topics: log.topics });
        if (completion || args.transactionId.toLowerCase() !== record.id.toLowerCase() || args.integrator !== (record.integrator ?? 'lifi-api')
          || !equalAddress(args.referrer, zeroAddress) || !equalAddress(args.receiver, record.account) || !equalAddress(args.fromAssetId, from.address)
          || !equalAddress(args.toAssetId, to.address) || args.fromAmount !== unsigned(record.amount)) return null;
        completion = args;
      } catch { /* Other router events carry no settlement proof. */ }
    } else if (equalAddress(log.address, from.address) || equalAddress(log.address, to.address)) {
      try {
        const { args } = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics });
        const debit = equalAddress(args.from, record.account) && equalAddress(args.to, SWAP_ROUTER);
        const credit = equalAddress(args.from, SWAP_ROUTER) && equalAddress(args.to, record.account);
        if (equalAddress(log.address, from.address)) spent += debit ? args.value : credit ? -args.value : 0n;
        else received += credit ? args.value : debit ? -args.value : 0n;
      } catch { /* Ignore non-Transfer logs. */ }
    }
  }
  return completion && spent > 0n && spent <= unsigned(record.amount)
    && received >= unsigned(record.minimum) && received === completion.toAmount ? { spent, received } : null;
}

export async function verifySwapRecord(client, record, receiptHint) {
  validateRecord(record, record.account);
  if (!record.hash) return { status: 'pending' };
  try {
    await requireMainnet(client);
    const [receipt, tx] = await Promise.all([
      receiptHint || client.getTransactionReceipt({ hash: record.hash }),
      client.getTransaction({ hash: record.hash }),
    ]);
    const target = record.phase === 'approval' ? SWAP_TOKENS[record.from].address : SWAP_ROUTER;
    if (!receipt || !tx || receipt.transactionHash?.toLowerCase() !== record.hash.toLowerCase()
      || tx.hash?.toLowerCase() !== record.hash.toLowerCase()
      || !equalAddress(tx.from, record.account) || !equalAddress(tx.to, target) || tx.value !== 0n
      || (tx.chainId !== undefined && tx.chainId !== arcNetwork.id)
      || keccak256(tx.input) !== record.dataHash) return { status: 'pending' };
    if (receipt.status === 'reverted') return { status: 'reverted' };
    if (receipt.status !== 'success') return { status: 'pending' };
    if (record.phase === 'approval') return { status: 'approved' };
    const amounts = verifiedTransfers(receipt, record);
    return amounts ? { status: 'confirmed', ...amounts } : { status: 'pending' };
  } catch {
    return { status: 'pending' };
  }
}

function sameSelection(wallet, selection, quote) {
  if (!sameWallet(selection, wallet.getSelection()) || selection.chainId !== arcNetwork.id || !equalAddress(selection.address, quote.account)) {
    throw new Error('The account or network changed. Review a new quote.');
  }
}

export function createSwapExecution({ client, wallet, ledger, deploymentCheck = verifyRouteDeployment, verifyPolicy = assertCurrentFeePolicy }) {
  let busy = false;

  return async function execute(quote, review, selection, onProgress = () => {}) {
    if (busy) throw new Error('A swap request is already in progress.');
    busy = true;
    try {
      sameSelection(wallet, selection, quote);
      if (ledger.get(quote.account)?.state === 'pending') throw new Error('Check the previous swap request before starting another.');
      assertFreshQuote(quote);
      if (!sameFeePolicy(quote.feePolicy, review.feePolicy)) throw new Error(feePolicyChanged);
      await verifyPolicy(quote.feePolicy);
      await requireMainnet(client);
      await deploymentCheck(client, quote.data);
      const provider = await wallet.getProvider(selection);
      const approvalCall = {
        to: quote.from.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SWAP_ROUTER, quote.amount] }),
      };
      const swapCall = { to: SWAP_ROUTER, data: quote.data };
      const allowance = () => tokenRead(client, quote.from, 'allowance', [quote.account, SWAP_ROUTER]);
      let approvalHash;
      // Keep the maximum combined approval + swap network fee inside the reviewed budget.
      let committedGasBudget = 0n;

      async function send(phase, call) {
        assertFreshQuote(quote);
        const [gas, balances, price] = await Promise.all([
          client.estimateGas({ account: quote.account, ...call, value: 0n }),
          readSwapBalances(client, quote.account),
          gasPrice(client),
        ]);
        const bufferedGas = withGasHeadroom(gas);
        const transactionBudget = bufferedGas * price;
        const safeGasLimit = phase === 'approval' ? APPROVAL_GAS_LIMIT : MAX_SWAP_GAS_LIMIT;
        // Re-estimated gas may change after approval, but never exceed the fee limit reviewed by the user.
        if (bufferedGas > safeGasLimit || committedGasBudget + transactionBudget > review.gasBudget) {
          throw new Error('The network fee changed beyond your reviewed limit. Review a new quote.');
        }
        // Reserve the remaining reviewed budget during approval as well, so a first
        // signature cannot consume the USDC needed for the subsequent swap.
        requireBalance(quote, balances, review.gasBudget - committedGasBudget);
        await assertWalletProvider(provider, quote.account);
        await verifyPolicy(quote.feePolicy);
        sameSelection(wallet, selection, quote);
        assertFreshQuote(quote);
        const previous = ledger.get(quote.account);
        if (previous?.state === 'pending') throw new Error('Check the previous swap request before starting another.');
        const record = {
          account: quote.account, from: quote.from.symbol, to: quote.to.symbol, amount: quote.amount.toString(),
          minimum: quote.minimum.toString(), phase, approvalHash: approvalHash || null,
          state: 'pending', hash: null, dataHash: keccak256(call.data), id: quote.id, integrator: quote.integrator,
        };
        ledger.put(record);
        onProgress({ stage: 'wallet', record });
        try {
          const hash = await provider.request({ method: 'eth_sendTransaction', params: [{
            from: quote.account, chainId: numberToHex(arcNetwork.id), ...call, value: '0x0',
            gas: numberToHex(bufferedGas), gasPrice: numberToHex(price),
          }] });
          if (isHash(hash)) {
            record.hash = hash;
            committedGasBudget += transactionBudget;
          }
        } catch (error) {
          if (error?.code === 4001) {
            ledger.put({ ...record, state: 'done' });
            return { status: 'rejected', record };
          }
        }
        if (!record.hash) return { status: 'pending', record };
        if (phase === 'approval') record.approvalHash = record.hash;
        onProgress({ stage: 'submitted', record });
        try {
          ledger.put(record);
          const receipt = await client.waitForTransactionReceipt({
            hash: record.hash, confirmations: 1, checkReplacement: false, timeout: 40_000,
          });
          const outcome = await verifySwapRecord(client, record, receipt);
          if (outcome.status !== 'pending') ledger.put({ ...record, state: 'done' });
          return { ...outcome, record };
        } catch {
          return { status: 'pending', record };
        }
      }

      if (await allowance() < quote.amount) {
        if (!review.needsApproval) throw new Error('Allowance changed. Review the approval and fee again.');
        const approved = await send('approval', approvalCall);
        if (approved.status !== 'approved') return approved;
        approvalHash = approved.record.hash;
        onProgress({ stage: 'approved', record: approved.record });
        if (await allowance() < quote.amount) throw new Error('The confirmed approval did not provide the required allowance.');
      }
      return await send('swap', swapCall);
    } finally {
      busy = false;
    }
  };
}
