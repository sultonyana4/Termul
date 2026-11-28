import { randomBytes, randomUUID } from 'node:crypto';
import { decodeFunctionData, encodeFunctionData, formatUnits, getAddress, isAddress, keccak256, numberToHex, parseUnits } from 'viem';
import { invoiceAbi, normalizeMediumQuote, verifyManagedDeployment } from './managed-preflight.js';
import { isUnresolved } from './managed-status.js';
import { automaticArcRecovery } from './automatic-arc-recovery.js';
import { feeCap, invoiceAmount, isHash, isUuid, lookupPilotTransaction, pilotDiagnostic, reconcilePilot, recoverPilotHash } from './pilot-reconciliation.js';
import { TERMUL_MAINNET } from '../../supabase/functions/_shared/termul-mainnet.js';
import { arcReadFailure, describeArcReadFailure, readArc, readArcStage } from '../../src/arc-read.js';

const reviewLifetime = 90_000;
const invoiceLifetime = 900n;
export class PilotError extends Error {
  constructor(status, message, code, feeChanges) {
    super(message);
    this.status = status;
    this.code = code;
    this.feeChanges = feeChanges;
  }
}

function calldata(intent) {
  const options = intent.kind === 'payment'
    ? { abi: invoiceAbi, functionName: 'payInvoice', args: [intent.merchant, intent.invoiceId] }
    : { abi: invoiceAbi, functionName: 'createInvoice', args: [intent.invoiceId, BigInt(intent.amountBase), BigInt(intent.expiresAt)] };
  const data = encodeFunctionData(options);
  const decoded = decodeFunctionData({ abi: invoiceAbi, data });
  if (decoded.functionName !== options.functionName || decoded.args.some((arg, i) => String(arg).toLowerCase() !== String(options.args[i]).toLowerCase())) {
    throw new Error('Pilot calldata round-trip mismatch.');
  }
  return data;
}

function publicAttempt(record) {
  if (!record) return null;
  const { kind, amountBase, merchant, invoiceId, walletAddress, chainId, calldataHash, expiresAt, gasLimit, maxFeePerGas, priorityFeePerGas,
    status, challengeStatus, transactionStatus, transactionId, transactionHash, gasUsed, costUsdc,
    verificationSource, invoiceStatusAtReceipt, latestInvoice, blockNumber, diagnostic } = record;
  return { kind, amountBase, merchant, invoiceId, walletAddress, chainId, calldataHash, expiresAt, gasLimit, maxFeePerGas, priorityFeePerGas,
    status, challengeStatus, transactionStatus, transactionId, transactionHash, gasUsed, costUsdc,
    verificationSource, invoiceStatusAtReceipt, latestInvoice, blockNumber, diagnostic };
}

function max(a, b) { return a > b ? a : b; }
function min(a, b) { return a < b ? a : b; }
function increase(value, percent) { return (value * (100n + percent) + 99n) / 100n; }
function amount(value) { return formatUnits(value, 18); }

export function createInvoicePilot({ circle, arc, enabled = false, paymentEnabled = false, appEnabled = false, journal, now = Date.now, network = TERMUL_MAINNET, reviews }) {
  let review;

  const readInvoice = (merchant, invoiceId, blockNumber) => arc.readContract({
    address: TERMUL_MAINNET.contractAddress, abi: invoiceAbi, functionName: 'getInvoice', args: [merchant, invoiceId],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  });

  async function verifyContext(wallet) {
    let deployment;
    let code;
    try {
      deployment = await verifyManagedDeployment(arc, network);
      if (deployment.status === 'verified') code = await readArcStage('wallet bytecode', () => arc.getCode({ address: wallet.address }));
    } catch (error) {
      if (error.code === 'ARC_DEPLOYMENT_RPC') throw new PilotError(502, error.message, error.code);
      throw error;
    }
    if (deployment.status !== 'verified') throw new PilotError(409, 'Wrong Arc chain or Termul runtime.');
    if (code !== undefined && code !== '0x') throw new PilotError(409, 'The selected wallet is not an Arc EOA.');
    return deployment;
  }

  async function checkPreflight({ wallet, userToken, intent, data }) {
    async function rpc(label, request) {
      try { return await readArc(request); }
      catch (error) {
        if (arcReadFailure(error)) throw new PilotError(503, `${describeArcReadFailure(error)} Could not check ${label}. No transaction was submitted.`, 'ARC_PREFLIGHT_RPC');
        throw error;
      }
    }
    const block = await rpc('the current block', () => arc.getBlock({ blockTag: 'latest', includeTransactions: false }));
    const isPayment = intent.kind === 'payment';
    const value = isPayment ? BigInt(intent.amountBase) : 0n;
    if (BigInt(intent.expiresAt) !== 0n && BigInt(intent.expiresAt) <= block.timestamp + (isPayment ? 0n : 120n)) {
      throw new PilotError(409, 'The invoice expired or its expiry is too close.');
    }
    const current = await rpc('the invoice', () => readInvoice(intent.merchant, intent.invoiceId));
    if (isPayment) {
      if (current.status !== 1 || current.merchant.toLowerCase() !== intent.merchant.toLowerCase()
        || current.amount !== value || current.expiresAt !== BigInt(intent.expiresAt)) {
        throw new PilotError(409, 'The invoice is closed or its terms changed.');
      }
    } else if (current.status !== 0) {
      throw new PilotError(409, 'The invoice ID already exists in this merchant namespace.');
    }
    const payload = { from: wallet.address, to: TERMUL_MAINNET.contractAddress, data, value: numberToHex(value) };
    if (await rpc('invoice simulation', () => arc.request({ method: 'eth_call', params: [payload, 'latest'] })) !== '0x') {
      throw new PilotError(409, 'Invoice operation did not pass Arc simulation.');
    }
    const [rawGas, rawPrice, balance, quoteResponse] = await Promise.all([
      rpc('estimated gas', () => arc.request({ method: 'eth_estimateGas', params: [payload, 'latest'] })),
      rpc('the gas price', () => arc.request({ method: 'eth_gasPrice' })),
      rpc('the native balance', () => arc.getBalance({ address: wallet.address })),
      circle.estimateContractExecutionFee({
        userToken, contractAddress: TERMUL_MAINNET.contractAddress, callData: data, source: { walletId: wallet.id }, ...(value ? { amount: amount(value) } : {}),
      }).catch(error => {
        if ([155103, 155104, 155105, 155718].includes(error?.code)) throw error;
        if ([155204, 155205, 155258].includes(error?.code)) throw new PilotError(409, 'Insufficient native USDC for this invoice and its network fee.');
        throw new PilotError(503, 'Circle could not estimate the network fee. No transaction was submitted.', 'CIRCLE_FEE_QUOTE_UNAVAILABLE');
      }),
    ]);
    const rpcGas = BigInt(rawGas);
    const rpcPrice = BigInt(rawPrice);
    const quote = normalizeMediumQuote(quoteResponse.data);
    if (rpcGas <= 0n || rpcPrice <= 0n || !quote.meetsArcFeeFloor) throw new PilotError(409, 'Invalid Arc fee estimates.');
    const gasLimit = max(rpcGas, BigInt(quote.gasUnits));
    const priorityFeePerGas = BigInt(quote.priorityFeeWeiPerGas);
    const baseFee = block.baseFeePerGas ?? 0n;
    const maxFeePerGas = max(max(rpcPrice, BigInt(quote.maxFeeWeiPerGas)), baseFee + priorityFeePerGas);
    const cost = gasLimit * maxFeePerGas;
    if (cost > feeCap || parseUnits(quote.estimatedNetworkFeeUsdc ?? '0', 18) > feeCap) {
      throw new PilotError(409, 'Network estimates exceed the 0.01 USDC fee cap. No transaction was submitted. Check again later.', 'CIRCLE_FEE_CAP_EXCEEDED');
    }
    if (balance < value + cost) throw new PilotError(409, 'Insufficient native USDC for the reviewed network fee.');
    return { gasLimit, maxFeePerGas, priorityFeePerGas, balance, rpcGas, rpcPrice, baseFee, quote, value };
  }

  function reviewedFeeLimits(fees) {
    const budget = min(feeCap, fees.balance - fees.value);
    // Scale gas and price headroom together when the ideal bounds would exceed the budget.
    for (const share of [100n, 75n, 50n, 25n, 0n]) {
      const gasLimit = increase(fees.gasLimit, 15n * share / 100n);
      const maxFeePerGas = increase(fees.maxFeePerGas, 25n * share / 100n);
      if (gasLimit * maxFeePerGas > budget) continue;
      const priorityFeePerGas = min(max(increase(fees.priorityFeePerGas, 50n), fees.priorityFeePerGas + 1_000_000_000n), maxFeePerGas - fees.baseFee);
      return { ...fees, gasLimit, maxFeePerGas, priorityFeePerGas, headroom: share > 0n || priorityFeePerGas > fees.priorityFeePerGas };
    }
    throw new PilotError(409, 'Insufficient native USDC for the reviewed network fee.');
  }

  async function invalidateReview(owner, selected) {
    if (reviews) await reviews.forget(owner, selected.reviewId);
    else if (review?.display === selected) review = null;
  }

  async function assertUnresolvedFree(wallet) {
    if (isUnresolved(await journal?.latest(wallet.address))) {
      throw new PilotError(409, 'An unresolved pilot attempt already exists. Check its status.');
    }
  }

  return {
    async forget(owner) {
      if (reviews) await reviews.forget(owner);
      if (review?.owner === owner) review = null;
    },
    async prepare({ wallet, userToken, owner, authorize, kind = 'creation', invoiceId: targetId, merchant: targetMerchant, amountBase: requestedAmount, expiresAt: requestedExpiry }) {
      review = null;
      authorize();
      await assertUnresolvedFree(wallet);
      const deployment = await verifyContext(wallet);
      let intent;
      if (kind === 'payment') {
        if (!isHash(targetId) || typeof targetMerchant !== 'string' || !isAddress(targetMerchant)) {
          throw new PilotError(400, 'Enter a valid merchant and invoice ID.');
        }
        const merchant = getAddress(targetMerchant);
        const invoiceId = targetId.toLowerCase();
        const current = await readInvoice(merchant, invoiceId);
        if (current.status !== 1 || current.amount <= 0n || current.merchant.toLowerCase() !== merchant.toLowerCase()) {
          throw new PilotError(409, 'The invoice is not open for payment.');
        }
        intent = { kind, invoiceId, merchant, amountBase: String(current.amount), expiresAt: String(current.expiresAt) };
      } else if (kind === 'app-creation' && appEnabled) {
        if (!isHash(targetId) || /^0x0{64}$/i.test(targetId) || typeof requestedAmount !== 'string'
          || !/^[1-9]\d{0,77}$/.test(requestedAmount) || BigInt(requestedAmount) >= 1n << 256n
          || typeof requestedExpiry !== 'string' || !/^[1-9]\d{0,11}$/.test(requestedExpiry)
          || BigInt(requestedExpiry) > 253402300799n) {
          throw new PilotError(400, 'Invalid invoice terms.');
        }
        intent = { kind, invoiceId: targetId.toLowerCase(), merchant: wallet.address,
          amountBase: requestedAmount, expiresAt: requestedExpiry };
      } else if (kind === 'creation') {
        const block = await arc.getBlock({ blockTag: 'latest', includeTransactions: false });
        intent = { kind, invoiceId: `0x${randomBytes(32).toString('hex')}`, merchant: wallet.address,
          amountBase: String(invoiceAmount), expiresAt: String(block.timestamp + invoiceLifetime) };
      } else {
        throw new PilotError(403, 'Managed invoice creation is unavailable.');
      }
      const data = calldata(intent);
      const fees = reviewedFeeLimits(await checkPreflight({ wallet, userToken, intent, data }));
      authorize();
      const reviewId = randomUUID();
      const reviewExpiresAt = now() + reviewLifetime;
      const display = Object.freeze({
        reviewId, reviewExpiresAt, ...intent, walletAddress: wallet.address, walletId: wallet.id,
        chainId: deployment.chainId, contract: deployment.address, runtimeHash: deployment.runtimeHash,
        calldata: data, calldataHash: keccak256(data), invoiceAmountUsdc: amount(BigInt(intent.amountBase)), valueUsdc: amount(fees.value),
        gasLimit: String(fees.gasLimit), maxFeePerGas: String(fees.maxFeePerGas),
        priorityFeePerGas: String(fees.priorityFeePerGas), maxCostUsdc: amount(fees.gasLimit * fees.maxFeePerGas),
        balanceUsdc: amount(fees.balance), rpcGasUnits: String(fees.rpcGas),
        rpcGasPriceWei: String(fees.rpcPrice), arcBaseFeeWei: String(fees.baseFee), circleGasUnits: fees.quote.gasUnits,
        circleMaxFeeWei: fees.quote.maxFeeWeiPerGas, circlePriorityFeeWei: fees.quote.priorityFeeWeiPerGas,
        feeBudgetUsdc: amount(feeCap), headroom: fees.headroom,
      });
      if (reviews) await reviews.set(owner, display);
      else review = { owner, display };
      return { enabled: kind === 'payment' ? paymentEnabled : kind === 'app-creation' ? appEnabled : enabled, review: display };
    },

    async execute({ wallet, userToken, owner, authorize, revalidate, reviewId, confirmed, sessionHash }) {
      if ((!enabled && !paymentEnabled && !appEnabled) || !journal) throw new PilotError(403, 'Managed invoice execution is disabled.');
      if (confirmed !== true) throw new PilotError(400, 'Explicit operator confirmation is required.');
      authorize();
      const selected = reviews ? await reviews.get(owner, reviewId, { includeExpired: true }) : review?.owner === owner ? review.display : undefined;
      if (!selected || selected.reviewId !== reviewId
        || selected.walletAddress !== wallet.address || selected.walletId !== wallet.id) {
        throw new PilotError(409, 'The reviewed wallet or invoice changed. Build a new review.');
      }
      if (!(selected.kind === 'payment' ? paymentEnabled : selected.kind === 'app-creation' ? appEnabled : enabled)) {
        throw new PilotError(403, 'Managed execution for this operation is disabled.');
      }
      if (selected.reviewExpiresAt <= now()) {
        await invalidateReview(owner, selected);
        throw new PilotError(409, 'The transaction review expired. No transaction was submitted.', 'CIRCLE_FEE_REVIEW_EXPIRED');
      }
      await assertUnresolvedFree(wallet);
      await verifyContext(wallet);
      const data = calldata(selected);
      if (data !== selected.calldata || keccak256(data) !== selected.calldataHash) {
        throw new PilotError(409, 'The invoice calldata changed.');
      }
      let fresh;
      try { fresh = await checkPreflight({ wallet, userToken, intent: selected, data }); }
      catch (error) {
        if (error.code === 'CIRCLE_FEE_CAP_EXCEEDED') await invalidateReview(owner, selected);
        throw error;
      }
      const gas = BigInt(selected.gasLimit);
      const maxFee = BigInt(selected.maxFeePerGas);
      const tip = fresh.priorityFeePerGas;
      const feeChanges = ['gasLimit', 'maxFeePerGas', 'priorityFeePerGas'].filter(field => fresh[field] > BigInt(selected[field]))
        .map(field => ({ field, reviewed: selected[field], current: String(fresh[field]) }));
      if (feeChanges.length) {
        await invalidateReview(owner, selected);
        throw new PilotError(409, 'Network fees changed. Review the updated fee before confirming. No transaction was submitted.', 'CIRCLE_FEE_REVIEW_STALE', feeChanges);
      }
      if (gas * maxFee > feeCap || fresh.balance < fresh.value + gas * maxFee) {
        throw new PilotError(409, 'The reviewed fee cap or native USDC balance check failed.');
      }
      await revalidate();
      authorize();
      if (selected.reviewExpiresAt <= now()) {
        await invalidateReview(owner, selected);
        throw new PilotError(409, 'The transaction review expired. No transaction was submitted.', 'CIRCLE_FEE_REVIEW_EXPIRED');
      }
      if (!reviews && review?.display !== selected) throw new PilotError(409, 'The transaction review was cleared.');
      const record = {
        invoiceId: selected.invoiceId, expiresAt: selected.expiresAt, walletAddress: wallet.address,
        kind: selected.kind, merchant: selected.merchant, amountBase: selected.amountBase,
        ...(selected.kind === 'payment' ? { attemptId: randomUUID(),
          paymentKey: selected.merchant.toLowerCase() + ':' + selected.invoiceId } : {}),
        walletId: wallet.id, chainId: selected.chainId, calldataHash: selected.calldataHash,
        gasLimit: selected.gasLimit, maxFeePerGas: selected.maxFeePerGas,
        priorityFeePerGas: String(tip), idempotencyKey: randomUUID(),
        challengeId: null, transactionId: null, transactionHash: null, status: 'requesting', createdAt: new Date(now()).toISOString(),
      };
      if (!await journal.reserve(record, { owner, reviewId, sessionHash })) throw new PilotError(409, 'An unresolved pilot attempt already exists.');
      review = null;
      let challengeId;
      try {
        const { data: result } = await circle.createUserTransactionContractExecutionChallenge({
          userToken, walletId: wallet.id, contractAddress: TERMUL_MAINNET.contractAddress, callData: data,
           ...(fresh.value ? { amount: amount(fresh.value) } : {}),
          idempotencyKey: record.idempotencyKey, refId: record.idempotencyKey,
          fee: { type: 'absolute', config: {
            gasLimit: record.gasLimit, maxFee: formatUnits(maxFee, 9), priorityFee: formatUnits(tip, 9),
          } },
        });
        if (!isUuid(result?.challengeId)) throw new Error('Missing challenge identifier.');
        challengeId = result.challengeId;
      } catch {
        return { attempt: publicAttempt(await journal.update(record, { status: 'ambiguous' })) };
      }
      const saved = await journal.update(record, { status: 'challenge-pending', challengeId });
      // A concurrent status reader may have recorded ambiguity while the request was in flight.
      const final = saved?.challengeId || !saved ? saved : await journal.update(saved, { status: 'challenge-pending', challengeId });
      try { await revalidate(); authorize(); }
      catch { return { attempt: publicAttempt(final) }; }
      if (selected.reviewExpiresAt <= now() || final?.challengeId !== challengeId || final.status !== 'challenge-pending') {
        return { attempt: publicAttempt(final) };
      }
      return { attempt: publicAttempt(final), challengeId };
    },

    async recover({ wallet, hash }) {
      const record = await journal?.latest(wallet.address, 'invoice');
      if (!isUnresolved(record) || record.walletId !== wallet.id) {
        throw new PilotError(409, 'No unresolved attempt exists for this Circle wallet.');
      }
      const result = await recoverPilotHash({ arc, record, hash, readInvoice, network });
      if (result.status !== 'verified') throw new PilotError(409, 'This hash did not prove the reviewed invoice transaction.');
      return { enabled, attempt: publicAttempt(await journal.update(record, result)) };
    },

    async providerStatus({ wallet, userToken }) {
      const record = await journal?.latest(wallet.address, 'invoice');
      if (!record || record.walletId !== wallet.id) return { provider: [] };
      const provider = [];
      if (record.challengeId) {
        try {
          const { data } = await circle.getUserChallenge({ userToken, challengeId: record.challengeId });
          const status = data?.challenge?.id === record.challengeId && data.challenge.status;
          provider.push({ ...pilotDiagnostic('challenge-read', null, record),
            result: ['PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED', 'EXPIRED'].includes(status) ? status : 'unrecognized' });
        } catch (error) { provider.push(pilotDiagnostic('challenge-read', error, record)); }
      }
      let transactionId;
      try {
        const diagnostics = [];
        const match = await lookupPilotTransaction(circle, record, userToken, item => diagnostics.push(item));
        provider.push(...diagnostics);
        transactionId = match?.id;
        provider.push({ ...pilotDiagnostic('transaction-list', null, { ...record, transactionId }),
          result: transactionId ? 'reference-matched' : 'reference-not-found' });
      } catch (error) { provider.push(pilotDiagnostic('transaction-list', error, record)); }
      if (transactionId) {
        const context = { ...record, transactionId };
        try {
          const { data } = await circle.getTransaction({ userToken, id: transactionId });
          const tx = data?.transaction;
          const expected = tx?.id === transactionId && tx.refId === record.idempotencyKey;
          provider.push({ ...pilotDiagnostic('transaction-read', null, context),
            result: !expected ? 'reference-not-confirmed' : !isHash(tx.txHash) ? 'hash-pending'
              : !record.transactionHash ? 'hash-available' :
                record.transactionHash === tx.txHash.toLowerCase() ? 'hash-matches-journal' : 'hash-differs-from-journal' });
        } catch (error) { provider.push(pilotDiagnostic('transaction-read', error, context)); }
      }
      return { provider };
    },

    async status({ wallet, userToken }) {
      const record = await journal?.latest(wallet.address, 'invoice');
      if (record?.walletId !== wallet.id) return { enabled, attempt: null };
      if (!isUnresolved(record)) {
        if (record?.status !== 'verified') return { enabled, attempt: publicAttempt(record) };
        let attempt = publicAttempt(record);
        try {
          const [latest, block] = await Promise.all([readInvoice(record.merchant ?? record.walletAddress, record.invoiceId),
            arc.getBlock({ blockTag: 'latest' })]);
          if (latest.merchant.toLowerCase() === (record.merchant ?? record.walletAddress).toLowerCase()
            && latest.amount === BigInt(record.amountBase ?? invoiceAmount) && latest.expiresAt === BigInt(record.expiresAt)) {
            attempt = { ...attempt, latestInvoice: { status: latest.status,
              expired: latest.expiresAt !== 0n && latest.expiresAt <= block.timestamp } };
          }
        } catch { /* Preserve the journaled historical proof. */ }
        return { enabled, attempt };
      }
      if (record.walletId !== wallet.id) throw new PilotError(409, 'The existing attempt belongs to a different Circle wallet ID.');
      try {
        // A successful contract execution can precede Circle's transaction listing.
        // Recover only from the exact, independently verified Arc receipt.
        const event = invoiceAbi.find(item => item.type === 'event' && item.name === (record.kind === 'payment' ? 'InvoicePaid' : 'InvoiceCreated'));
        const proof = await automaticArcRecovery({ arc, record, network, event, readInvoice, verify: recoverPilotHash });
        const fields = proof ?? await reconcilePilot({ circle, arc, record, userToken, readInvoice, network });
        return { enabled, attempt: publicAttempt(await journal.update(record, fields)) };
      } catch (error) {
        if ([155103, 155104, 155105, 155718].includes(error?.code)) throw error;
        return { enabled, attempt: publicAttempt(record), notice: 'Reconciliation is currently unavailable. Try checking status again.', diagnostic: pilotDiagnostic('reconcile', error, record) };
      }
    },
  };
}
