import { randomUUID } from 'node:crypto';
import { decodeEventLog, encodeFunctionData, erc20Abi, formatUnits, keccak256, parseAbi, parseUnits } from 'viem';
import { fetchSwapQuote, APPROVAL_GAS_LIMIT, SWAP_ROUTER, SWAP_TOKENS, ARC_ANY_SWAP_TOKENS, MAX_SWAP_GAS_LIMIT } from '../../src/swap-quote.js';
import { readSwapBalances, reviewSwap, spendableAmount, verifyRouteDeployment, verifySwapRecord } from '../../src/swap-execution.js';
import { sameFeePolicy } from '../../src/fee-policy.js';
import { TERMUL_MAINNET as network } from '../../supabase/functions/_shared/termul-mainnet.js';
import { normalizeMediumQuote } from './managed-preflight.js';
import { isHash, isUuid, lookupPilotTransaction, pilotDiagnostic } from './pilot-reconciliation.js';
import { isUnresolved } from './managed-status.js';
import { PilotError } from './invoice-pilot.js';
import { createCircleAnyTokenQuoteFetcher } from './circle-any-token-quotes.js';
import { arcTokenAddress, arcTokenCatalog, normalizeArcToken } from '../../src/circle-arc-tokens.js';

const statusName = status => ['approved', 'confirmed'].includes(status) ? 'verified' : status;
const swapEvent = parseAbi(['event LiFiGenericSwapCompleted(bytes32 indexed transactionId,string integrator,string referrer,address receiver,address fromAssetId,address toAssetId,uint256 fromAmount,uint256 toAmount)'])[0];
const approvalEvent = erc20Abi.find(entry => entry.type === 'event' && entry.name === 'Approval');
const maximum = (a, b) => a > b ? a : b;
const fail = (status, message, code) => { throw new PilotError(status, message, code); };
const tokenCatalog = anyToken => anyToken ? ARC_ANY_SWAP_TOKENS : SWAP_TOKENS;
export const swapDisplayAssets = assets => assets?.map(({ address, chainId, symbol, name, decimals, logoURI }) =>
  ({ address, chainId, symbol, name, decimals, logoURI }));
const project = r => r && ({ kind: 'arc-swap', anyToken: r.anyToken, attemptId: r.attemptId, phase: r.phase, status: r.status,
  transactionHash: r.transactionHash, from: r.from, to: r.to, amount: r.amount, minimum: r.minimum,
  assets: swapDisplayAssets(r.assets), allowanceValue: r.allowanceValue, spent: r.spent, received: r.received, costUsdc: r.costUsdc });

function restoreReview(stored, owner) {
  if (stored?.kind !== 'arc-swap') return undefined;
  const tokens = tokenCatalog(stored.anyToken);
  const gasLimit = BigInt(stored.gasLimit);
  const maxFeePerGas = BigInt(stored.maxFeePerGas);
  return {
    ...stored, id: stored.reviewId, owner, approved: BigInt(stored.approved),
    q: { ...stored.q, from: stored.assets?.[0] ?? tokens[stored.from], to: stored.assets?.[1] ?? tokens[stored.to],
      amount: BigInt(stored.amount), minimum: BigInt(stored.minimum),
      gasLimit: stored.q.gasLimit === undefined ? undefined : BigInt(stored.q.gasLimit) },
    fee: { gasLimit, maxFeePerGas, tip: BigInt(stored.priorityFeePerGas), budget: gasLimit * maxFeePerGas },
  };
}

export function createCircleSwap({ arc, circle, journal, enabled = false, allowAnyToken = false, loadPolicy, quote = fetchSwapQuote,
  checkDeployment = verifyRouteDeployment, reviews, now = Date.now, maxNetworkFeeUsdc, requireFeeCeiling = false,
  anyTokenFetcher = createCircleAnyTokenQuoteFetcher(), catalog = arcTokenCatalog }) {
  let review;
  function requireFreshQuote(q) {
    if (now() >= q.expiresAt) fail(409, 'The quote expired. Request a new review.', 'CIRCLE_SWAP_REVIEW_EXPIRED');
  }
  async function verifyWallet(wallet) {
    if (await arc.getChainId() !== network.id) fail(409, 'Wrong Arc chain.');
    const code = await arc.getCode({ address: wallet.address });
    if (code && code !== '0x') fail(409, 'The selected wallet is not an Arc EOA.');
  }
  const allowance = q => arc.readContract({ address: q.from.address, abi: erc20Abi, functionName: 'allowance', args: [q.account, SWAP_ROUTER] });

  async function verifyAsset(address) {
    let token;
    try { token = normalizeArcToken(await catalog.find(address)); }
    catch { fail(503, 'Could not look up this token in the LI.FI Arc catalog.'); }
    if (token?.address !== address) fail(422, 'LI.FI could not identify this token on Arc Mainnet.');
    const known = Object.values(ARC_ANY_SWAP_TOKENS).find(item => item.address.toLowerCase() === address.toLowerCase());
    const [code, decimals, symbol, name] = await Promise.all([
      arc.getCode({ address }),
      ...['decimals', 'symbol', 'name'].map(functionName => arc.readContract({ address, abi: erc20Abi, functionName })),
    ]);
    const runtimeHash = code && code !== '0x' ? keccak256(code) : null;
    if (!runtimeHash || (known?.runtimeHash && runtimeHash !== known.runtimeHash) || token.decimals !== decimals
      || !normalizeArcToken({ ...token, name, symbol, decimals }) || symbol.toLowerCase() !== token.symbol.toLowerCase()) {
      fail(422, 'The Arc token contract does not match the catalog metadata.');
    }
    return { ...token, runtimeHash, contractSymbol: symbol, contractName: name };
  }
  function configuredCeiling(anyToken) {
    if ((maxNetworkFeeUsdc === undefined || maxNetworkFeeUsdc === '') && !requireFeeCeiling && !anyToken) return undefined;
    if (typeof maxNetworkFeeUsdc !== 'string' || !/^\d{1,18}(?:\.\d{1,18})?$/.test(maxNetworkFeeUsdc)
      || parseUnits(maxNetworkFeeUsdc, 18) <= 0n) {
      fail(503, 'Circle swap fee limits are not configured. No transaction was requested.', 'CIRCLE_SWAP_FEE_NOT_CONFIGURED');
    }
    return parseUnits(maxNetworkFeeUsdc, 18);
  }

  async function systemBudget(q, operation, ceiling) {
    if (ceiling !== undefined && operation.phase === 'swap') return ceiling;
    if (q.gasLimit === undefined) fail(409, 'Request a new Circle swap review.');
    const { gasBudget } = await reviewSwap(arc, q, [q.from, q.to]);
    // Retain the existing approval budget alongside any configured system ceiling.
    return ceiling !== undefined && ceiling < gasBudget ? ceiling : gasBudget;
  }

  async function invalidateReview(owner, current) {
    if (reviews) await reviews.forget(owner, current.id);
    else if (review === current) review = undefined;
  }

  async function limits(q, wallet, userToken, operation, { reviewBudget, approvedFee } = {}) {
    const [balance, gas, price, response] = await Promise.all([
      readSwapBalances(arc, wallet.address, [q.from]),
      arc.estimateGas({ account: wallet.address, to: operation.target, data: operation.calldata, value: 0n }),
      arc.getGasPrice(),
      circle.estimateContractExecutionFee({ userToken, contractAddress: operation.target,
        source: { walletId: wallet.id }, callData: operation.calldata }),
    ]);
    const fees = normalizeMediumQuote(response.data);
    if (gas <= 0n || price <= 0n) fail(409, 'Invalid Arc gas estimate.');
    const gasCeiling = operation.phase === 'approval' ? APPROVAL_GAS_LIMIT : MAX_SWAP_GAS_LIMIT;
    let gasLimit = maximum(gas, BigInt(fees.gasUnits));
    let maxFeePerGas = maximum(price, BigInt(fees.maxFeeWeiPerGas));
    let tip = BigInt(fees.priorityFeeWeiPerGas);
    if (reviewBudget !== undefined) {
      const paddedGas = maximum((gas * 12n + 9n) / 10n, gasLimit);
      const paddedPrice = (maxFeePerGas * 105n + 99n) / 100n;
      if (paddedGas > gasCeiling) {
        fail(409, `This ${operation.phase} needs a gas limit of ${paddedGas}, above Termul’s ${gasCeiling} limit. No transaction was requested.`,
          'CIRCLE_SWAP_GAS_LIMIT_EXCEEDED');
      }
      const required = paddedGas * maxFeePerGas;
      if (required > reviewBudget) {
        fail(409, `This Circle ${operation.phase} needs a maximum network fee of ${formatUnits(required, 18)} USDC ` +
          `(${paddedGas} gas × ${formatUnits(maxFeePerGas, 9)} gwei), above Termul’s ${formatUnits(reviewBudget, 18)} USDC budget. ` +
          'No transaction was requested. Try a fresh quote for the same amount.',
        'CIRCLE_SWAP_FEE_BUDGET_EXCEEDED');
      }
      gasLimit = paddedGas;
      if (gasLimit * paddedPrice <= reviewBudget && balance.native >= gasLimit * paddedPrice
        && spendableAmount(balance, q.from, gasLimit * paddedPrice) >= q.amount) {
        maxFeePerGas = paddedPrice;
        tip = (tip * 105n + 99n) / 100n;
      }
    }
    const budget = gasLimit * maxFeePerGas;
    if (approvedFee && (gasLimit > approvedFee.gasLimit || maxFeePerGas > approvedFee.maxFeePerGas || tip > approvedFee.tip)) {
      fail(409, 'Network fees changed. Request a new review and confirm the new maximum.', 'CIRCLE_SWAP_FEE_CHANGED');
    }
    const reserve = maximum(budget, approvedFee?.budget ?? 0n);
    if (!fees.meetsArcFeeFloor || gasLimit > gasCeiling
      || balance.native < reserve || spendableAmount(balance, q.from, reserve) < q.amount) {
      fail(409, 'The Arc swap does not fit the balance or reviewed gas limits.');
    }
    return { gasLimit, maxFeePerGas, tip, budget };
  }

  async function verifyTransaction(record, hash) {
    try {
      const [tx, receipt] = await Promise.all([arc.getTransaction({ hash }), arc.getTransactionReceipt({ hash })]);
      if (Number(tx.chainId) !== record.chainId || tx.type !== 'eip1559' || tx.gas !== BigInt(record.gasLimit)
        || tx.maxFeePerGas !== BigInt(record.maxFeePerGas) || tx.maxPriorityFeePerGas !== BigInt(record.priorityFeePerGas)
        || typeof tx.blockNumber !== 'bigint' || tx.blockNumber < BigInt(record.proofFromBlock)
        || !tx.blockHash || receipt.blockHash !== tx.blockHash || receipt.blockNumber !== tx.blockNumber
        || typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed <= 0n || receipt.gasUsed > tx.gas
        || typeof receipt.effectiveGasPrice !== 'bigint' || receipt.effectiveGasPrice <= 0n
        || receipt.effectiveGasPrice > tx.maxFeePerGas) return null;
      const finalized = await arc.getBlock({ blockTag: 'finalized' });
      if (typeof finalized?.number !== 'bigint' || finalized.number < tx.blockNumber) return null;
      const canonical = finalized.number === tx.blockNumber ? finalized : await arc.getBlock({ blockNumber: tx.blockNumber });
      if (canonical?.number !== tx.blockNumber || canonical.hash !== tx.blockHash) return null;
      const result = await verifySwapRecord(arc, { ...record, hash, state: 'pending' }, receipt, tx, tokenCatalog(record.anyToken), record.assets);
      if (result.status === 'pending') return null;
      if (result.status === 'approved' && !receipt.logs.some(log => {
        if (log.removed || log.transactionHash !== hash || log.address.toLowerCase() !== record.target.toLowerCase()) return false;
        try {
          const { args } = decodeEventLog({ abi: [approvalEvent], data: log.data, topics: log.topics });
          return args.owner.toLowerCase() === record.account.toLowerCase()
            && args.spender.toLowerCase() === SWAP_ROUTER.toLowerCase() && args.value === BigInt(record.allowanceValue);
        } catch { return false; }
      })) return null;
      return { status: statusName(result.status), transactionHash: hash, gasUsed: String(receipt.gasUsed),
        costUsdc: formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18),
        ...(result.spent ? { spent: String(result.spent), received: String(result.received) } : {}) };
    } catch { return null; }
  }

  return {
    forget(owner) { if (review?.owner === owner) review = undefined; },
    async prepare({ wallet, userToken, owner, authorize, from, to, amount, anyToken = false }) {
      if (!enabled || !journal) fail(403, 'Circle Arc swaps are disabled.');
      if (typeof anyToken !== 'boolean') fail(400, 'Invalid Circle swap selection.');
      if (anyToken && !allowAnyToken) fail(403, 'Circle Any Token swaps are disabled.');
      const ceiling = configuredCeiling(anyToken);
      authorize();
      if (isUnresolved(await journal.latest(wallet.address))) fail(409, 'Check the previous Circle attempt before starting a swap.');
      const tokens = tokenCatalog(anyToken);
      const addresses = [arcTokenAddress(from), arcTokenAddress(to)];
      const dynamic = anyToken && addresses.every(Boolean);
      if (typeof from !== 'string' || typeof to !== 'string' ||
        (dynamic ? addresses[0] === addresses[1] : !Object.hasOwn(tokens, from) || !Object.hasOwn(tokens, to) || from === to) ||
        typeof amount !== 'string' || !/^[1-9]\d{0,77}$/.test(amount) || BigInt(amount) >= 1n << 256n) fail(400, 'Invalid Arc token pair or amount.');
      await verifyWallet(wallet);
      const policy = await loadPolicy();
      if (anyToken && policy?.bps !== 10) fail(503, 'The 0.1% Termul fee policy is unavailable.');
      const assets = dynamic ? await Promise.all(addresses.map(verifyAsset)) : undefined;
      const [source, destination] = assets ?? [tokens[from], tokens[to]];
      let q;
      try {
        q = await quote({ account: wallet.address, from: source, to: destination, amount: BigInt(amount), anyToken, verifiedAssets: assets },
          AbortSignal.timeout(12_000), anyToken ? anyTokenFetcher : undefined, now, policy);
      } catch (error) {
        if (!anyToken || error instanceof PilotError) throw error;
        if (error.message.startsWith('No supported route') || error.message.includes('route this app does not support')
          || error.message.includes('unsupported or inconsistent Arc route')) {
          fail(422, 'No supported Arc route for this pair and amount. Try different tokens or an amount.');
        }
        fail(503, 'Arc swap quotes are temporarily unavailable. No transaction was requested.');
      }
      await checkDeployment(arc, q.data, [q.from, q.to]);
      const approved = await allowance(q);
      const phase = approved < q.amount ? 'approval' : 'swap';
      const allowanceValue = approved === 0n ? q.amount : 0n;
      const operation = phase === 'approval'
        ? { phase, allowanceValue: String(allowanceValue), target: q.from.address, calldata: encodeFunctionData({
          abi: erc20Abi, functionName: 'approve', args: [SWAP_ROUTER, allowanceValue],
        }) } : { phase, target: SWAP_ROUTER, calldata: q.data };
      const fee = await limits(q, wallet, userToken, operation, { reviewBudget: await systemBudget(q, operation, ceiling) });
      requireFreshQuote(q);
      authorize();
      const id = randomUUID();
      const display = { reviewId: id, reviewExpiresAt: q.expiresAt, phase, anyToken, allowanceValue: operation.allowanceValue,
        from: source.symbol, to: destination.symbol, assets: swapDisplayAssets(assets),
        recipient: wallet.address, target: operation.target, spender: SWAP_ROUTER, amount, minimum: String(q.minimum),
        received: String(q.received), priceImpact: q.priceImpact ?? q.referencePriceImpact ?? null,
        referenceImpact: q.priceImpact == null && q.referencePriceImpact != null, route: q.route, feeBps: policy.bps,
        integratorFeeRounded: anyToken && policy.bps > 0 && q.integratorFee === 0n,
        integratorFee: String(q.integratorFee), providerFee: String(q.providerFee),
        networkFee: formatUnits(fee.budget, 18), gasLimit: String(fee.gasLimit), maxFeePerGas: String(fee.maxFeePerGas),
        priorityFeePerGas: String(fee.tip), calldataHash: keccak256(operation.calldata) };
      if (reviews) {
        await reviews.set(owner, { ...display, assets, kind: 'arc-swap', chainId: network.id, walletAddress: wallet.address, walletId: wallet.id,
          operation, approved: String(approved), policy, q: { account: q.account, id: q.id, expiresAt: q.expiresAt, data: q.data,
            gasLimit: String(q.gasLimit), integrator: q.integrator },
          budget: String(fee.budget) });
      } else review = { id, owner, q, walletId: wallet.id, operation, fee, approved, policy, anyToken, assets };
      return { enabled, review: display };
    },
    async execute({ wallet, userToken, owner, authorize, revalidate, reviewId, confirmed, sessionHash }) {
      if (!enabled || !journal) fail(403, 'Circle Arc swaps are disabled.');
      if (confirmed !== true) fail(400, 'Explicit approval is required.');
      authorize();
      const current = reviews ? restoreReview(await reviews.get(owner, reviewId), owner) : review;
      if (!current || current.id !== reviewId || current.owner !== owner || current.walletId !== wallet.id) fail(409, 'The swap review changed.');
      if (current.anyToken && !allowAnyToken) fail(403, 'Circle Any Token swaps are disabled.');
      const ceiling = configuredCeiling(current.anyToken);
      const { q, fee, operation } = current;
      requireFreshQuote(q);
      if (q.account.toLowerCase() !== wallet.address.toLowerCase() ||
        (reviews && current.calldataHash !== keccak256(operation.calldata))) fail(409, 'The reviewed transaction changed.');
      await verifyWallet(wallet);
      if (!sameFeePolicy(current.policy, await loadPolicy())) fail(409, 'Fee policy changed. Request a new quote.');
      await checkDeployment(arc, q.data, [q.from, q.to]);
      if (await allowance(q) !== current.approved) fail(409, 'Token allowance changed. Request a new quote.');
      if (fee.budget > await systemBudget(q, operation, ceiling)) {
        await invalidateReview(owner, current);
        fail(409, 'The reviewed fee exceeds the current Circle network fee limit. Request a new review.', 'CIRCLE_SWAP_FEE_CHANGED');
      }
      try { await limits(q, wallet, userToken, operation, { approvedFee: fee }); }
      catch (error) {
        if (error.code === 'CIRCLE_SWAP_FEE_CHANGED') await invalidateReview(owner, current);
        throw error;
      }
      const approved = await allowance(q);
      if (approved !== current.approved) fail(409, 'Token allowance changed. Request a new quote.');
      await revalidate();
      authorize();
      requireFreshQuote(q);
      if (!reviews && review !== current) fail(409, 'The swap review changed.');
      const proofFromBlock = String((await arc.getBlockNumber()) + 1n);
      authorize();
      requireFreshQuote(q);
      if (!reviews && review !== current) fail(409, 'The swap review changed.');
      const record = {
        attemptId: randomUUID(), kind: 'arc-swap', anyToken: current.anyToken, invoiceId: q.id, id: q.id,
        walletAddress: wallet.address, walletId: wallet.id, account: wallet.address, chainId: network.id,
        from: q.from.symbol, to: q.to.symbol, assets: current.assets, amount: String(q.amount), minimum: String(q.minimum), integrator: q.integrator,
        phase: operation.phase, target: operation.target, allowanceValue: operation.allowanceValue, dataHash: keccak256(operation.calldata),
        gasLimit: String(fee.gasLimit), maxFeePerGas: String(fee.maxFeePerGas), priorityFeePerGas: String(fee.tip),
        proofFromBlock, createdAt: new Date(now()).toISOString(), idempotencyKey: randomUUID(), status: 'requesting',
        transactionHash: null, challengeId: null,
      };
      review = undefined;
      if (!await journal.reserve(record, { owner, reviewId, sessionHash })) fail(409, 'A prior Circle attempt still needs reconciliation.');
      let challengeId;
      try {
        const result = await circle.createUserTransactionContractExecutionChallenge({
          userToken, walletId: wallet.id, contractAddress: record.target, callData: operation.calldata,
          refId: record.idempotencyKey, idempotencyKey: record.idempotencyKey,
          fee: { type: 'absolute', config: { gasLimit: record.gasLimit, maxFee: formatUnits(fee.maxFeePerGas, 9), priorityFee: formatUnits(fee.tip, 9) } },
        });
        challengeId = result.data?.challengeId;
        if (!isUuid(challengeId)) throw new Error('Missing identifier.');
      } catch {
        return { attempt: project(await journal.update(record, { status: 'ambiguous' })) };
      }
      const saved = await journal.update(record, { status: 'challenge-pending', challengeId });
      try { await revalidate(); authorize(); requireFreshQuote(q); }
      catch { return { attempt: project(saved) }; }
      return { attempt: project(saved), ...(saved.challengeId === challengeId ? { challengeId } : {}) };
    },
    async status({ wallet, userToken }) {
      const record = await journal?.latest(wallet.address, 'swap');
      if (record?.kind !== 'arc-swap' || record.walletId !== wallet.id) return { attempt: null };
      if (!isUnresolved(record)) return { attempt: project(record) };
      let provider, challenge, diagnostic;
      try {
        if (userToken) [provider, challenge] = await Promise.all([
          lookupPilotTransaction(circle, record, userToken, item => { diagnostic = item; }),
          record.challengeId && circle.getUserChallenge({ userToken, challengeId: record.challengeId }).then(r => r.data?.challenge).catch(() => null),
        ]);
      } catch { /* Arc evidence may be available before the provider record. */ }
      const providerId = provider?.id ?? record.transactionId;
      if (userToken && providerId && !isHash(provider?.txHash) && typeof circle.getTransaction === 'function') {
        try {
          const { data } = await circle.getTransaction({ userToken, id: providerId });
          const tx = data?.transaction;
          if (tx?.id === providerId && tx.refId === record.idempotencyKey && tx.walletId === record.walletId
            && tx.blockchain === 'ARC' && tx.operation === 'CONTRACT_EXECUTION') provider = tx;
        } catch (error) { diagnostic = pilotDiagnostic('swap-transaction-read', error, record); }
      }
      const providerHash = isHash(provider?.txHash) ? provider.txHash.toLowerCase() : undefined;
      const hashes = new Set([record.transactionHash, record.providerHash, providerHash].filter(isHash));
      const verified = [];
      for (const hash of hashes) {
        const proof = await verifyTransaction(record, hash);
        if (proof) verified.push(proof);
      }
      let scanFromBlock, scanCaughtUp;
      if (!verified.length) {
        try {
          if (await arc.getChainId() !== network.id) return { attempt: project(record) };
          const { number: tip } = await arc.getBlock({ blockTag: 'finalized' });
          const event = record.phase === 'swap' ? swapEvent : approvalEvent;
          const args = record.phase === 'swap' ? { transactionId: record.id } : { owner: record.account, spender: SWAP_ROUTER };
          const fromBlock = BigInt(record.scanFromBlock ?? record.proofFromBlock);
          const toBlock = tip < fromBlock + 3999n ? tip : fromBlock + 3999n;
          const logs = fromBlock > tip ? [] : await arc.getLogs({ address: record.target, event, args, fromBlock, toBlock, strict: true });
          const candidates = new Set(logs.map(log => log.transactionHash).filter(isHash));
          if (!candidates.size && fromBlock <= tip) scanFromBlock = String(toBlock + 1n);
          if (candidates.size <= 16) {
            for (const hash of candidates) {
              if (hashes.has(hash)) continue;
              hashes.add(hash);
              const proof = await verifyTransaction(record, hash);
              if (proof) verified.push(proof);
            }
          }
          scanCaughtUp = toBlock === tip;
          if (candidates.size > 16) scanCaughtUp = false;
        } catch { /* Missing evidence remains pending. */ }
      }
      if (verified.length === 1) return { attempt: project(await journal.update(record, {
        ...verified[0], ...(providerId && { transactionId: providerId }),
        verificationSource: providerHash === verified[0].transactionHash ? 'circle-reference-and-arc' : 'arc-hash',
      })) };
      if (!providerId && challenge?.id === record.challengeId && challenge?.type === 'CONTRACT_EXECUTION'
        && (challenge.status === 'EXPIRED' || (challenge.status === 'FAILED' && challenge.errorCode === 155701))) {
        // An empty successful list is positive evidence only if the provider read succeeded.
        try {
          const existing = await lookupPilotTransaction(circle, record, userToken);
          if (!existing && !hashes.size && scanCaughtUp) return { attempt: project(await journal.update(record,
            { status: challenge.status === 'EXPIRED' ? 'expired' : 'rejected' })) };
        } catch { /* An API failure cannot release this attempt. */ }
      }
      const fields = {
        ...(scanFromBlock && { scanFromBlock }),
        ...(providerId && { transactionId: providerId }),
        ...(providerHash && { providerHash }),
        ...(diagnostic && { diagnostic }),
        ...(hashes.size ? { status: 'receipt-pending' } : providerId ? { status: 'hash-pending' }
          : challenge?.id === record.challengeId && challenge?.status === 'COMPLETE' ? { status: 'transaction-pending' } : {}),
      };
      return { attempt: project(Object.keys(fields).length ? await journal.update(record, fields) : record) };
    },
  };
}
