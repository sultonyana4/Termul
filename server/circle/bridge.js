import { randomUUID } from 'node:crypto';
import { erc20Abi, formatUnits, isAddress, isAddressEqual, keccak256 } from 'viem';
import { isHash, isUuid, lookupPilotTransaction } from '../../experiments/circle-wallet-poc/pilot-reconciliation.js';
import { normalizeMediumQuote } from '../../experiments/circle-wallet-poc/managed-preflight.js';
import { deny } from './http.js';
import { ARC_USDC, BASE_USDC, approvalEvent, bridgeCall, burnEvent, destinationProof, feeForBridge, iris,
  messenger, sourceProof, verifyDeployment } from './cctp.js';

const pending = new Set(['submitting', 'source-pending', 'destination-pending']);
const active = state => state === 'ready' || pending.has(state);
const max = (a, b) => a > b ? a : b;
const min = (a, b) => a < b ? a : b;
const project = row => {
  if (!row) return null;
  const { amount, status, sourceHash, destinationHash, history, received, fee } = row.details;
  return { id: row.id, amount, status, sourceHash, destinationHash, history, received, fee };
};

export function createCircleBridge({ circle, arc, base, store, enabled = false, now = Date.now, loadPolicy, read = iris, check = verifyDeployment }) {
  async function ownership({ wallet, userToken }) {
    const { data } = await circle.listWallets({ userToken, blockchain: 'BASE', pageSize: 50 });
    const candidates = data?.wallets;
    if (!Array.isArray(candidates) || candidates.length >= 50 || candidates.filter(item => item.blockchain === 'BASE' &&
        item.accountType === 'EOA' && item.state === 'LIVE' && isUuid(item.id) &&
        isAddress(item.address ?? '', { strict: false }) && isAddressEqual(item.address, wallet.address)).length !== 1) {
      deny(409, 'This route requires a matching live Base EOA in your existing Circle wallet account.');
    }
  }

  async function preflight(context, amount) {
    if (loadPolicy && (await loadPolicy()).bps !== 0) deny(409, 'The CCTP pilot requires a zero-fee Termul policy.');

    const { wallet, userToken } = context;
    await Promise.all([ownership(context), check(arc, 5042), check(base, 8453)]);
    const [allowance, balance, gasBalance, fee, sourceDecimals, destDecimals] = await Promise.all([
      arc.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: 'allowance', args: [wallet.address, messenger] }),
      arc.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] }),
      arc.getBalance({ address: wallet.address }), feeForBridge(amount, read),
      arc.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: 'decimals' }),
      base.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    if (sourceDecimals !== 6 || destDecimals !== 6 || fee * 100n > amount * 5n || balance < amount) {
      deny(409, 'The transfer exceeds the fee limit or available Arc USDC balance.');
    }
    const call = bridgeCall(wallet.address, amount, fee, allowance);
    const [gas, price, circleFees, block] = await Promise.all([
      arc.estimateGas({ account: wallet.address, to: call.target, data: call.data, value: 0n }),
      arc.getGasPrice(),
      circle.estimateContractExecutionFee({ userToken, source: { walletId: wallet.id }, contractAddress: call.target, callData: call.data }),
      arc.getBlockNumber(),
    ]);
    const estimated = normalizeMediumQuote(circleFees.data);
    const gasLimit = max((gas * 12n + 9n) / 10n, BigInt(estimated.gasUnits));
    const maxFeePerGas = max(price, BigInt(estimated.maxFeeWeiPerGas));
    const tip = BigInt(estimated.priorityFeeWeiPerGas);
    const cost = gasLimit * maxFeePerGas;
    if (!estimated.meetsArcFeeFloor || gas <= 0n || price <= 0n || gasLimit > 600000n || cost > 10n ** 17n ||
        gasBalance < amount * 10n ** 12n + cost) deny(409, 'The Arc balance or network fee exceeds this route’s limits.');
    return { ...call, maxFee: String(fee), minimum: String(amount - fee), fromBlock: String(block + 1n),
      gasLimit: String(gasLimit), maxFeePerGas: String(maxFeePerGas), tip: String(tip), gasBalance: String(gasBalance) };
  }

  function requireEnabled() {
    if (!enabled) deny(403, 'Circle CCTP execution is disabled.');
  }

  async function update(row, data, session) {
    return store.update(row, { ...row.details, ...data }, session);
  }

  async function reconcile(row, userToken) {
    const route = row.details;
    if (!pending.has(route.status)) return row;
    if (route.status === 'destination-pending') {
      const proof = await destinationProof(base, route, read, check);
      return proof ? await update(row, { ...proof, status: 'settled' }) ?? row : row;
    }

    let providerHash = route.step.providerHash;
    let rejected = false;
    if (userToken && !providerHash) {
      try {
        const candidate = await lookupPilotTransaction(circle, {
          walletId: route.walletId, walletAddress: route.walletAddress, target: route.step.target, idempotencyKey: route.step.key,
        }, userToken);
        let hint = candidate?.txHash;
        if (candidate && !isHash(hint)) {
          const { data } = await circle.getTransaction({ userToken, id: candidate.id });
          const detail = data?.transaction;
          if (detail?.id === candidate.id && detail.refId === route.step.key &&
              detail.walletId === route.walletId && detail.operation === 'CONTRACT_EXECUTION' && detail.blockchain === 'ARC') {
            hint = detail.txHash;
          }
        }
        if (isHash(hint)) {
          providerHash = hint.toLowerCase();
          row = await update(row, { step: { ...route.step, providerHash } }) ?? row;
        }
        if (!candidate && route.step.challengeId) {
          const { data } = await circle.getUserChallenge({ userToken, challengeId: route.step.challengeId });
          const challenge = data?.challenge;
          if (challenge?.id === route.step.challengeId && challenge.type === 'CONTRACT_EXECUTION' &&
              (challenge.status === 'EXPIRED' || (challenge.status === 'FAILED' && challenge.errorCode === 155701))) {
            rejected = true;
          }
        }
      } catch { /* Provider data is optional for independent reconciliation. */ }
    }

    const hashes = new Set(providerHash ? [providerHash] : []);
    let scanned = false;
    let resume;
    try {
      const anchor = BigInt(route.step.fromBlock);
      const fromBlock = max(anchor, BigInt(route.scanFrom ?? anchor));
      const { number: finalized } = await arc.getBlock({ blockTag: 'finalized' });
      const head = await arc.getBlockNumber();
      const toBlock = min(finalized, fromBlock + 1999n);
      const isBurn = route.step.phase === 'burn';
      const logs = fromBlock <= toBlock ? await arc.getLogs({ address: route.step.target,
        event: isBurn ? burnEvent : approvalEvent, args: isBurn ? { depositor: route.walletAddress } :
          { owner: route.walletAddress, spender: messenger }, fromBlock, toBlock, strict: true }) : [];
      if (rejected && toBlock === finalized && head - finalized <= 100n) {
        const start = max(anchor, finalized + 1n);
        const recent = start <= head ? await arc.getLogs({ address: route.step.target, event: isBurn ? burnEvent : approvalEvent,
          args: isBurn ? { depositor: route.walletAddress } : { owner: route.walletAddress, spender: messenger },
          fromBlock: start, toBlock: head, strict: true }) : [];
        scanned = recent.length === 0;
      }
      if (!logs.length && fromBlock <= toBlock) resume = String(toBlock + 1n);
      for (const log of logs) if (isHash(log.transactionHash)) hashes.add(log.transactionHash.toLowerCase());
    } catch { /* A later status check can retry reads. */ }
    if (rejected && scanned && !hashes.size) return await update(row, { status: 'rejected' }) ?? row;
    if (hashes.size > 8) return row;
    const proofs = (await Promise.all([...hashes].map(async hash => {
      try { return await sourceProof(arc, route, hash, check); } catch { return null; }
    }))).filter(Boolean);
    if (proofs.length !== 1) return resume ? await update(row, { scanFrom: resume }) ?? row : row;
    const proof = proofs[0];
    return await update(row, {
      status: proof.status, review: null, scanFrom: null, step: proof.status === 'ready' ? null : row.details.step,
      history: [...route.history, { phase: route.step.phase, hash: proof.hash, status: proof.status }],
      ...(proof.message ? { sourceHash: proof.hash, sourceMessage: proof.message } : {}),
    }) ?? row;
  }

  return {
    async prepare(context, amountText) {
      requireEnabled();
      context.authorize();
      if (typeof amountText !== 'string' || !/^[1-9]\d{0,11}$/.test(amountText)) deny(400, 'Enter a valid USDC amount.');
      const amount = BigInt(amountText);
      let row = await store.latest(context.wallet.address);
      if (row && active(row.details.status) && (row.details.status !== 'ready' || row.details.amount !== amountText ||
          row.details.walletId !== context.wallet.id)) deny(409, 'Resolve or close your existing bridge first.');
      const terms = await preflight(context, amount);
      const refreshed = await context.revalidate();
      if (refreshed.id !== context.wallet.id) deny(409, 'The wallet changed.');
      if (!row || !active(row.details.status)) row = await store.insert({
        walletAddress: context.wallet.address, walletId: context.wallet.id, amount: amountText, status: 'ready', history: [],
      });
      if (!row || row.details.status !== 'ready' || row.details.amount !== amountText ||
          row.details.walletId !== context.wallet.id) deny(409, 'A bridge is already in progress.');
      const { gasBalance, ...call } = terms;
      const review = { ...call, id: randomUUID(), sessionHash: context.sessionHash, expiresAt: now() + 45_000 };
      if (!await update(row, { review })) deny(409, 'The bridge changed. Review it again.');
      return { review: { id: review.id, phase: terms.phase, from: 'Arc', to: 'Base', token: 'USDC',
        recipient: context.wallet.address, amount: amountText, allowance: terms.value, minimum: terms.minimum,
        maxFee: terms.maxFee, networkFee: formatUnits(BigInt(terms.gasLimit) * BigInt(terms.maxFeePerGas), 18),
        target: terms.target, calldataHash: keccak256(terms.data) } };
    },

    async execute(context, reviewId) {
      requireEnabled();
      context.authorize();
      const row = await store.latest(context.wallet.address);
      const review = row?.details.review;
      if (!review || review.id !== reviewId || review.sessionHash !== context.sessionHash || review.expiresAt <= now() ||
          row.details.status !== 'ready' || row.details.walletId !== context.wallet.id) deny(409, 'The bridge review expired or changed.');
      const fresh = await preflight(context, BigInt(row.details.amount));
      if (fresh.phase !== review.phase || fresh.target !== review.target ||
          BigInt(fresh.maxFee) > BigInt(review.maxFee) || BigInt(fresh.gasLimit) > BigInt(review.gasLimit) ||
          BigInt(fresh.maxFeePerGas) > BigInt(review.maxFeePerGas) || BigInt(fresh.tip) > BigInt(review.tip) ||
          BigInt(fresh.gasBalance) < BigInt(row.details.amount) * 10n ** 12n + BigInt(review.gasLimit) * BigInt(review.maxFeePerGas) ||
          bridgeCall(context.wallet.address, BigInt(row.details.amount), BigInt(review.maxFee),
            fresh.phase === 'burn' ? BigInt(row.details.amount) : fresh.phase === 'approve' ? 0n : 1n).data !== review.data) {
        deny(409, 'Bridge terms changed. Request a fresh review.');
      }
      const wallet = await context.revalidate();
      if (wallet.id !== context.wallet.id || review.expiresAt <= now()) deny(409, 'The wallet or review changed.');
      const { sessionHash, ...terms } = review;
      const step = { ...terms, fromBlock: fresh.fromBlock, key: randomUUID() };
      const claimed = await update(row, { status: 'submitting', step, review: null }, sessionHash);
      if (!claimed) deny(409, 'The bridge step is already reserved or expired.');
      try {
        const { data } = await circle.createUserTransactionContractExecutionChallenge({
          userToken: context.userToken, walletId: wallet.id, contractAddress: step.target, callData: step.data,
          idempotencyKey: step.key, refId: step.key, fee: { type: 'absolute', config: {
            gasLimit: step.gasLimit, maxFee: formatUnits(BigInt(step.maxFeePerGas), 9), priorityFee: formatUnits(BigInt(step.tip), 9),
          } },
        });
        if (isUuid(data?.challengeId)) {
          const changes = { status: 'source-pending', step: { ...step, challengeId: data.challengeId } };
          if (await update(claimed, changes)) return { challengeId: data.challengeId };
          // A status reader may have advanced the scan while the provider call was in flight.
          const current = await store.latest(wallet.address);
          if (current?.id === claimed.id && current.details.status === 'submitting' && current.details.step.key === step.key &&
              await update(current, { ...changes, step: { ...current.details.step, challengeId: data.challengeId } })) {
            return { challengeId: data.challengeId };
          }
        }
      } catch { /* The reserved step may have reached Circle. Never send a second challenge. */ }
      return { pending: true };
    },

    async status(context) {
      const found = await store.latest(context.wallet.address);
      if (!found || found.details.walletId !== context.wallet.id) return { bridge: null };
      try { return { bridge: project(await reconcile(found, context.userToken)) }; }
      catch { return { bridge: project(found), retry: true }; }
    },

    async history(context) {
      return { bridges: (await store.history(context.wallet.address)).filter(row => row.details.walletId === context.wallet.id).map(project) };
    },

    async close(context) {
      context.authorize();
      const row = await store.latest(context.wallet.address);
      if (!row || row.details.walletId !== context.wallet.id || row.details.status !== 'ready' ||
          !await update(row, { status: 'closed', review: null })) deny(409, 'Only an unsubmitted bridge can be closed.');
      return { closed: true };
    },

    async run() {
      const rows = await store.due();
      return Promise.allSettled(rows.map(async row => {
        try { await reconcile(row); }
        finally { await update(row, {}); }
      }));
    },
  };
}
