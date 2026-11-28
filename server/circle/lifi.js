import { randomUUID } from 'node:crypto';
import { encodeFunctionData, erc20Abi, formatUnits, isAddressEqual, keccak256, parseAbiItem, decodeEventLog } from 'viem';
import { isHash, isUuid, lookupPilotTransaction } from '../../experiments/circle-wallet-poc/pilot-reconciliation.js';
import { normalizeMediumQuote } from '../../experiments/circle-wallet-poc/managed-preflight.js';
import { sameFeePolicy } from '../../src/fee-policy.js';
import { circleLifiPairs } from '../../src/circle-lifi-routes.js';
import { lifiClients, lifiNetworks, verifyLifiDeployment } from './lifi-networks.js';
import { depositEvent, fillEvent, transferEvent, proveLifiDestination, proveLifiSource, quoteLifi } from './lifi-protocols.js';
import { deny } from './http.js';

const approveEvent = parseAbiItem('event Approval(address indexed owner,address indexed spender,uint256 value)');
const max = (a, b) => a > b ? a : b;
const min = (a, b) => a < b ? a : b;
const sourcePending = ['submitting','source-pending'];
const active = ['ready', ...sourcePending, 'destination-pending'];

function project(row) {
  if (!row) return null;
  const { amount, status, fromChain, toChain, sourceHash, destinationHash, received, history, recovery } = row.details;
  return { id: row.id, amount, status, fromChain, toChain, sourceHash, destinationHash, received, history, recovery };
}

async function finalized(client, hash) {
  const receipt = await client.getTransactionReceipt({ hash });
  if (receipt.transactionHash !== hash || !receipt.blockHash || typeof receipt.blockNumber !== 'bigint') return null;
  const [block, tip] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlock({ blockTag: 'finalized' })]);
  return block.hash === receipt.blockHash && tip.number >= receipt.blockNumber ? receipt : null;
}

function approves(receipt, step, account) {
  const matching = receipt.logs.filter(log => {
    if (log.removed || log.transactionHash !== receipt.transactionHash || log.blockHash !== receipt.blockHash ||
        !isAddressEqual(log.address, step.target)) return false;
    try {
      const { args } = decodeEventLog({ abi: [approveEvent], data: log.data, topics: log.topics });
      return isAddressEqual(args.owner, account) && isAddressEqual(args.spender, step.plan.router) && args.value === BigInt(step.allowance);
    } catch { return false; }
  });
  return matching.length === 1;
}

export function createCircleLifi({ circle, store, enabled = false, loadPolicy, clients = lifiClients,
  fetcher = fetch, now = Date.now, quote = quoteLifi, check = verifyLifiDeployment }) {
  async function walletOn(chainId, context) {
    if (chainId === 5042) return context.wallet;
    const blockchain = lifiNetworks[chainId].code;
    const { data } = await circle.listWallets({ userToken: context.userToken, blockchain, pageSize: 50 });
    const wallets = data?.wallets;
    if (!Array.isArray(wallets) || wallets.length >= 50) deny(409, 'Circle network wallet lookup is unavailable.');
    const owned = wallets.filter(w => w.blockchain === blockchain && w.state === 'LIVE' && w.accountType === 'EOA' &&
      isUuid(w.id) && /^0x[a-f0-9]{40}$/i.test(w.address ?? '') && isAddressEqual(w.address, context.wallet.address));
    if (owned.length !== 1) deny(409, 'A matching live Circle EOA is required on both networks.');
    return owned[0];
  }

  function requireEnabled() {
    if (!enabled) deny(403, 'Circle LI.FI execution is disabled.');
  }

  async function update(row, delta, session) {
    return store.update(row, { ...row.details, ...delta }, session);
  }

  async function simulate(plan, sourceId, context, fixed) {
    const source = clients[plan.fromChain], destination = clients[plan.toChain];
    const owner = plan.account;
    const token = plan.fromToken.address;
    const chain = lifiNetworks[plan.fromChain];
    await Promise.all([check(source, plan), check(destination, plan, { destination: true })]);
    const [allowance, tokenBalance, gasBalance, decimals, destinationDecimals] = await Promise.all([
      source.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, plan.router] }),
      source.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
      source.getBalance({ address: owner }),
      source.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      destination.readContract({ address: plan.toToken.address, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    const amount = BigInt(plan.amount);
    if (decimals !== 6 || destinationDecimals !== 6 || tokenBalance < amount) deny(409, 'The route token or balance changed.');
    const phase = allowance === amount ? 'transfer' : allowance === 0n ? 'approve' : 'reset';
    const target = phase === 'transfer' ? plan.router : token;
    const nextAllowance = phase === 'approve' ? amount : 0n;
    const data = phase === 'transfer' ? plan.data :
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [plan.router, nextAllowance] });
    if (fixed && (fixed.phase !== phase || fixed.data !== data || fixed.target !== target)) deny(409, 'The reviewed allowance changed.');
    const [gas, price, estimate, fromBlock] = await Promise.all([
      source.estimateGas({ account: owner, to: target, data, value: 0n }), source.getGasPrice(),
      circle.estimateContractExecutionFee({ userToken: context.userToken, source: { walletId: sourceId },
        contractAddress: target, callData: data }), source.getBlockNumber(),
    ]);
    const fee = normalizeMediumQuote(estimate.data);
    const gasLimit = max((gas * 12n + 9n) / 10n, BigInt(fee.gasUnits));
    const maxFee = max(price, BigInt(fee.maxFeeWeiPerGas));
    const tip = BigInt(fee.priorityFeeWeiPerGas);
    const maximumCost = gasLimit * maxFee;
    const cap = chain.gas === 'USDC' ? 10n ** 17n : 10n ** 15n;
    if ((chain.gas === 'USDC' && !fee.meetsArcFeeFloor) || gasLimit > 800_000n || gas <= 0n ||
        price <= 0n || maximumCost > cap || gasBalance < maximumCost + (chain.gas === 'USDC' ? amount * 10n ** 12n : 0n)) {
      deny(409, 'Balance or network fee exceeds the LI.FI route limits.');
    }
    if (fixed && (gasLimit > BigInt(fixed.gasLimit) || maxFee > BigInt(fixed.maxFee) || tip > BigInt(fixed.tip) ||
        gasBalance < BigInt(fixed.gasLimit) * BigInt(fixed.maxFee) + (chain.gas === 'USDC' ? amount * 10n ** 12n : 0n))) {
      deny(409, 'Network fees changed. Review a fresh route.');
    }
    return { phase, target, data, allowance: String(nextAllowance), gasLimit: String(gasLimit),
      maxFee: String(maxFee), tip: String(tip), fromBlock: String(fromBlock + 1n) };
  }

  async function reconcileSource(row, context) {
    const route = row.details, step = route.step, plan = step.plan;
    const client = clients[plan.fromChain];
    const network = lifiNetworks[plan.fromChain];
    let hint = step.providerHash, rejected = false;
    if (context && !hint) {
      try {
        const match = await lookupPilotTransaction(circle, {
          blockchain: network.code, walletId: route.sourceWalletId, walletAddress: route.walletAddress, target: step.target, idempotencyKey: step.key,
        }, context.userToken);
        if (isHash(match?.txHash)) hint = match.txHash.toLowerCase();
        if (match && !hint) {
          const { data } = await circle.getTransaction({ userToken: context.userToken, id: match.id });
          const tx = data?.transaction;
          if (tx?.id === match.id && tx.walletId === route.sourceWalletId && tx.blockchain === network.code &&
              tx.refId === step.key && tx.operation === 'CONTRACT_EXECUTION' && isHash(tx.txHash)) hint = tx.txHash.toLowerCase();
        }
        if (!match && step.challengeId) {
          const { data } = await circle.getUserChallenge({ userToken: context.userToken, challengeId: step.challengeId });
          const challenge = data?.challenge;
          rejected = challenge?.id === step.challengeId && challenge.type === 'CONTRACT_EXECUTION' &&
            (challenge.status === 'EXPIRED' || (challenge.status === 'FAILED' && challenge.errorCode === 155701));
        }
      } catch { /* Provider status is an optional hint. */ }
    }

    const candidates = new Set(hint ? [hint] : []);
    let resume = route.scanFrom, noSubmission = false;
    try {
      const tip = (await client.getBlock({ blockTag: 'finalized' })).number;
      const from = BigInt(route.scanFrom ?? step.fromBlock);
      const to = min(tip, from + 1999n);
      const head = rejected ? await client.getBlockNumber() : tip;
      const scan = (fromBlock, toBlock) => fromBlock <= toBlock
        ? client.getLogs(step.phase !== 'transfer' ? {
          address: step.target, event: approveEvent, args: { owner: route.walletAddress, spender: plan.router }, fromBlock, toBlock, strict: true,
        } : plan.tool === 'across' ? {
          address: network.pool[0], event: depositEvent, args: { depositor: '0x' + '0'.repeat(24) + route.walletAddress.slice(2).toLowerCase() }, fromBlock, toBlock, strict: true,
        } : { address: plan.router, event: transferEvent, fromBlock, toBlock, strict: true })
        : [];
      const logs = await scan(from, to);
      for (const log of logs) if (isHash(log.transactionHash)) candidates.add(log.transactionHash.toLowerCase());
      if (!logs.length && from <= to) resume = String(to + 1n);
      if (rejected && to === tip && head - tip <= 100n && !candidates.size) noSubmission = (await scan(max(from, tip + 1n), head)).length === 0;
    } catch { /* Preserve the current scan boundary. */ }
    if (noSubmission) return await update(row, { status: 'rejected' }) ?? row;
    if (candidates.size > 8) {
      // A provider-correlated candidate can still be checked on busy router ranges.
      candidates.clear();
      if (hint) candidates.add(hint);
    }

    const solutions = (await Promise.all([...candidates].map(async hash => {
      try {
        const [receipt, tx] = await Promise.all([finalized(client, hash), client.getTransaction({ hash })]);
        if (!receipt || tx.hash !== hash || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber ||
            tx.blockNumber < BigInt(step.fromBlock) || Number(tx.chainId) !== plan.fromChain || tx.type !== 'eip1559' ||
            !tx.to || !isAddressEqual(tx.to, step.target) || !isAddressEqual(tx.from, route.walletAddress) ||
            tx.input.toLowerCase() !== step.data.toLowerCase() || tx.value !== 0n || tx.gas !== BigInt(step.gasLimit) ||
            tx.maxFeePerGas !== BigInt(step.maxFee) || tx.maxPriorityFeePerGas !== BigInt(step.tip) || !(receipt.gasUsed > 0n && receipt.gasUsed <= tx.gas &&
            receipt.effectiveGasPrice > 0n && receipt.effectiveGasPrice <= tx.maxFeePerGas)) return null;
        await check(client, plan, { blockNumber: receipt.blockNumber });
        if (receipt.status === 'reverted') return { hash, status: 'reverted' };
        if (receipt.status !== 'success') return null;
        if (step.phase !== 'transfer') return approves(receipt, step, route.walletAddress) ? { hash, status: 'ready' } : null;
        const proof = proveLifiSource(plan, receipt);
        return proof ? { hash, status: 'destination-pending', proof } : null;
      } catch { return null; }
    }))).filter(Boolean);
    if (solutions.length !== 1) {
      if (hint !== step.providerHash || resume !== route.scanFrom) {
        return await update(row, { scanFrom: resume, step: { ...step, providerHash: hint } }) ?? row;
      }
      return row;
    }
    const { status, hash, proof } = solutions[0];
    return await update(row, { status, scanFrom: null, step: status === 'ready' ? null : step,
      history: [...route.history, { phase: step.phase, chainId: plan.fromChain, hash, status }],
      ...(proof ? { sourceHash: hash, sourceMessage: proof } : {}),
    }) ?? row;
  }

  async function reconcileDestination(row) {
    const route = row.details;
    const { plan } = route.step;
    const source = clients[plan.fromChain], dest = clients[plan.toChain];
    const hashes = new Set();
    let reported;
    try {
      const query = new URLSearchParams({ txHash: route.sourceHash, fromChain: plan.fromChain, toChain: plan.toChain, bridge: plan.tool });
      const response = await fetcher('https://li.quest/v1/status?' + query, {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const result = await response.json();
        if (result.sending?.txHash?.toLowerCase() === route.sourceHash && result.sending.chainId === plan.fromChain) {
          if (result.substatus === 'REFUNDED') reported = 'refund-reported';
          else if (result.status === 'FAILED' || result.substatus === 'PARTIAL') reported = 'delivery-issue';
          else if (result.receiving?.chainId === plan.toChain && isHash(result.receiving.txHash)) hashes.add(result.receiving.txHash.toLowerCase());
        }
      }
    } catch { /* A LI.FI status outage cannot resolve, cancel, or repeat a transfer. */ }
    if (plan.tool === 'across') {
      try {
        const { number: tip } = await dest.getBlock({ blockTag: 'finalized' });
        const logs = await dest.getLogs({ address: lifiNetworks[plan.toChain].pool[0], event: fillEvent,
          args: { originChainId: BigInt(plan.fromChain), depositId: BigInt(route.sourceMessage.depositId) },
          fromBlock: tip > 1999n ? tip - 1999n : 0n, toBlock: tip, strict: true });
        for (const log of logs) if (isHash(log.transactionHash)) hashes.add(log.transactionHash.toLowerCase());
      } catch { /* Keep pending. */ }
    }
    const sourceReceipt = hashes.size ? await finalized(source, route.sourceHash) : null;
    if (hashes.size <= 4 && sourceReceipt?.status === 'success') {
      for (const hash of hashes) {
        try {
          const receipt = await finalized(dest, hash);
          if (receipt?.status !== 'success') continue;
          await check(dest, plan, { blockNumber: receipt.blockNumber, destination: true });
          const received = await proveLifiDestination(plan, route.sourceMessage, sourceReceipt, receipt, fetcher);
          if (received) return await update(row, { status: 'settled', destinationHash: hash, received, recovery: null }) ?? row;
        } catch { /* Only exact canonical evidence can settle. */ }
      }
    }
    const expired = plan.deposit && plan.deposit.fillDeadline * 1000 < now();
    const recovery = reported ?? (expired ? 'fill-window-ended' : route.recovery);
    return recovery && recovery !== route.recovery ? await update(row, { recovery }) ?? row : row;
  }

  const reconcile = (row, ctx) => sourcePending.includes(row.details.status) ? reconcileSource(row, ctx) :
    row.details.status === 'destination-pending' ? reconcileDestination(row) : row;

  return {
    async prepare(ctx, input) {
      requireEnabled();
      ctx.authorize();
      const { fromChain, toChain, amount } = input;
      if (!Number.isSafeInteger(fromChain) || !Number.isSafeInteger(toChain) ||
          !circleLifiPairs[fromChain + ':' + toChain] || typeof amount !== 'string' || !/^[1-9]\d{0,11}$/.test(amount)) {
        deny(400, 'Select a supported Circle LI.FI USDC route and amount.');
      }
      let row = await store.latest(ctx.wallet.address);
      if (row && active.includes(row.details.status) && (row.details.status !== 'ready' ||
          row.details.fromChain !== fromChain || row.details.toChain !== toChain || row.details.amount !== amount ||
          row.details.walletId !== ctx.wallet.id)) deny(409, 'Resolve the existing LI.FI route first.');
      const policy = await loadPolicy();
      const [sourceWallet, destinationWallet] = await Promise.all([walletOn(fromChain, ctx), walletOn(toChain, ctx)]);
      let plan;
      try { plan = await quote({ fromChain, toChain, amount, account: ctx.wallet.address }, policy, { fetcher, now }); }
      catch { deny(422, 'LI.FI did not provide a compatible quote for this route.'); }
      const started = now();
      const step = await simulate(plan, sourceWallet.id, ctx);
      const revalidated = await ctx.revalidate();
      if (revalidated.id !== ctx.wallet.id || now() - started >= 25_000) deny(409, 'The wallet or quote changed.');
      if (!row || !active.includes(row.details.status)) row = await store.insert({
        status: 'ready', walletId: ctx.wallet.id, walletAddress: ctx.wallet.address, fromChain, toChain,
        sourceWalletId: sourceWallet.id, destinationWalletId: destinationWallet.id, amount, history: [],
      });
      if (!row || row.details.sourceWalletId !== sourceWallet.id || row.details.destinationWalletId !== destinationWallet.id ||
          row.details.status !== 'ready') deny(409, 'A different route is already reserved.');
      const review = { ...step, plan, policy, id: randomUUID(), sessionHash: ctx.sessionHash, expiresAt: started + 30_000 };
      if (!await update(row, { review })) deny(409, 'The route changed. Review it again.');
      return { review: { id: review.id, phase: step.phase, fromChain, toChain, amount, tool: plan.tool, minimum: plan.minimum,
        recipient: plan.account, allowance: step.allowance, integratorFee: plan.integratorFee, lifiFee: plan.lifiFee,
        bridgeFee: plan.bridgeFee, networkFee: formatUnits(BigInt(step.gasLimit) * BigInt(step.maxFee), 18),
        gasToken: lifiNetworks[fromChain].gas, target: step.target, calldataHash: keccak256(step.data),
      } };
    },

    async execute(ctx, id) {
      requireEnabled();
      ctx.authorize();
      const row = await store.latest(ctx.wallet.address);
      const review = row?.details.review;
      if (!review || row.details.status !== 'ready' || row.details.walletId !== ctx.wallet.id ||
          review.id !== id || review.sessionHash !== ctx.sessionHash || review.expiresAt <= now()) deny(409, 'LI.FI review expired or changed.');
      if (!sameFeePolicy(review.policy, await loadPolicy())) deny(409, 'Termul pricing changed. Review a fresh quote.');
      const { fromChain, toChain } = row.details;
      const [sourceWallet, destinationWallet] = await Promise.all([walletOn(fromChain, ctx), walletOn(toChain, ctx)]);
      if (row.details.sourceWalletId !== sourceWallet.id || row.details.destinationWalletId !== destinationWallet.id) deny(409, 'A Circle wallet changed.');
      const fresh = await simulate(review.plan, sourceWallet.id, ctx, review);
      if ((await ctx.revalidate()).id !== ctx.wallet.id || review.expiresAt <= now()) deny(409, 'The wallet or review changed.');
      const { sessionHash, ...terms } = review;
      const step = { ...terms, fromBlock: fresh.fromBlock, key: randomUUID() };
      const claimed = await update(row, { status: 'submitting', review: null, step }, sessionHash);
      if (!claimed) deny(409, 'This LI.FI step was already reserved.');
      try {
        const { data } = await circle.createUserTransactionContractExecutionChallenge({
          userToken: ctx.userToken, walletId: sourceWallet.id, contractAddress: step.target, callData: step.data,
          refId: step.key, idempotencyKey: step.key, fee: { type: 'absolute', config: {
            gasLimit: step.gasLimit, maxFee: formatUnits(BigInt(step.maxFee), 9), priorityFee: formatUnits(BigInt(step.tip), 9),
          } },
        });
        if (isUuid(data?.challengeId)) {
          const next = { status: 'source-pending', step: { ...step, challengeId: data.challengeId } };
          if (await update(claimed, next)) return { challengeId: data.challengeId };
          const saved = await store.latest(ctx.wallet.address);
          if (saved?.id === claimed.id && saved.details.status === 'submitting' && saved.details.step.key === step.key &&
              await update(saved, { ...next, step: { ...saved.details.step, challengeId: data.challengeId } })) return { challengeId: data.challengeId };
        }
      } catch { /* No automatic write retry. Preserve the reservation. */ }
      return { pending: true };
    },

    async status(ctx) {
      const row = await store.latest(ctx.wallet.address);
      if (!row || row.details.walletId !== ctx.wallet.id) return { route: null };
      try { return { route: project(await reconcile(row, ctx)) }; }
      catch { return { route: project(row), retry: true }; }
    },

    async history(ctx) {
      return { routes: (await store.history(ctx.wallet.address)).filter(row => row.details.walletId === ctx.wallet.id).map(project) };
    },

    async close(ctx) {
      ctx.authorize();
      const row = await store.latest(ctx.wallet.address);
      if (!row || row.details.walletId !== ctx.wallet.id || row.details.status !== 'ready' ||
          !await update(row, { review: null, status: 'closed' })) deny(409, 'Only an unsubmitted LI.FI route can be closed.');
      return { closed: true };
    },

    async run() {
      return Promise.allSettled((await store.due()).map(async row => {
        try { await reconcile(row); }
        finally { await update(row, {}); }
      }));
    },
  };
}
