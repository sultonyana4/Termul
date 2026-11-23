import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, zeroAddress } from 'viem';
import { addressPattern, exchangeChain, hashPattern, lifiOrigin, matches } from './any-token-networks.js';
import { assertProviderChain, sameWallet } from './wallet-provider.js';

const tokenAmount = amount => typeof amount === 'string' && /^\d{1,78}$/.test(amount) ? BigInt(amount) : 0n;
const quantity = value => typeof value === 'bigint' ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  ? BigInt(value) : typeof value === 'string' && /^(?:0x[0-9a-f]{1,64}|\d{1,78})$/i.test(value) ? BigInt(value) : null;

export function preparedExchangeStep(plan, route, selection, networks) {
  const current = reviewExchangeRoute(route, selection, networks);
  if (plan.routeId !== current.routeId || plan.stepId !== current.stepId
    || plan.fromChain !== current.fromChain || plan.toChain !== current.toChain
    || !matches(plan.fromToken.address, current.fromToken.address) || !matches(plan.toToken.address, current.toToken.address)
    || plan.fromToken.decimals !== current.fromToken.decimals || plan.toToken.decimals !== current.toToken.decimals
    || plan.tool !== current.tool
    || plan.amount !== current.amount || tokenAmount(current.minimum) < tokenAmount(plan.minimum)
    || tokenAmount(current.maximumValue) > tokenAmount(plan.maximumValue)) {
    throw new Error('LI.FI changed this route. Review a fresh quote before signing.');
  }
  return route.steps[0].transactionRequest;
}
const hexData = /^0x(?:[0-9a-f]{2}){4,24000}$/i;
const routeMaxAge = 120_000;

export function reviewExchangeRoute(route, selection, networks, now = Date.now()) {
  const step = Array.isArray(route?.steps) && route.steps.length === 1 ? route.steps[0] : null;
  const action = step?.action;
  const from = networks.get(action?.fromChainId);
  const to = networks.get(action?.toChainId);
  const account = selection?.address;
  const validToken = (token, id) => token?.chainId === id && addressPattern.test(token.address)
    && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 36;
  if (!addressPattern.test(account ?? '') || !from || !to || step.type !== 'lifi'
    || typeof route.id !== 'string' || route.id.length > 160 || typeof step.id !== 'string'
    || !matches(action.fromAddress ?? route.fromAddress, account) || !matches(action.toAddress ?? route.toAddress, account)
    || !validToken(action.fromToken, from.chain.id) || !validToken(action.toToken, to.chain.id)
    || (from === to && matches(action.fromToken.address, action.toToken.address))
    || !tokenAmount(action.fromAmount) || !tokenAmount(step.estimate?.toAmountMin)
    || (step.estimate.approvalAddress && !matches(step.estimate.approvalAddress, from.router))
    || (step.includedSteps ?? []).some(part => !['swap', 'cross', 'protocol'].includes(part.type)
      || !networks.has(part.action?.fromChainId) || !networks.has(part.action?.toChainId))
    || (step.estimate.feeCosts ?? []).some(fee => tokenAmount(fee.feeSplit?.integratorFee) > 0n)
    || (step.fee != null && Number(step.fee) !== 0)) throw new Error('Review a supported LI.FI route with this wallet as sender and recipient.');
  const token = value => {
    const symbol = typeof value.symbol === 'string' && /^[\w.\- ]{1,20}$/.test(value.symbol) ? value.symbol : 'token';
    return { address: value.address, decimals: value.decimals, symbol };
  };
  const nativeAmount = matches(action.fromToken.address, zeroAddress) ? tokenAmount(action.fromAmount) : 0n;
  const nativeFees = (step.estimate.feeCosts ?? []).reduce((sum, fee) =>
    fee.included === false && fee.token?.chainId === from.chain.id && matches(fee.token.address, zeroAddress)
      ? sum + tokenAmount(fee.amount) : sum, 0n);
  return {
    routeId: route.id, stepId: step.id, account, connectorId: selection.connectorId, router: from.router,
    fromChain: from.chain.id, toChain: to.chain.id, fromToken: token(action.fromToken), toToken: token(action.toToken),
    amount: action.fromAmount, minimum: step.estimate.toAmountMin, maximumValue: String(nativeAmount + nativeFees),
    tool: typeof step.tool === 'string' && /^[\w.-]{1,48}$/.test(step.tool) ? step.tool : 'LI.FI',
    expires: now + routeMaxAge,
  };
}

export function validateExchangeRequest(plan, prepared, tx, selection, now = Date.now()) {
  if (!plan || now >= plan.expires || !selection || selection.chainId !== plan.fromChain
    || selection.connectorId !== plan.connectorId || !matches(selection.address, plan.account)
    || !tx || (tx.chainId != null && quantity(tx.chainId) !== BigInt(plan.fromChain))
    || !matches(tx.from, plan.account) || !hexData.test(tx.data ?? '') || !addressPattern.test(tx.to ?? '')
    || tx.authorizationList != null || tx.blobs != null) throw new Error('The route or wallet changed. Review a fresh route.');
  const value = quantity(tx.value ?? '0');
  if (value == null || value < 0n) throw new Error('Invalid transaction value.');
  if (tx.data.slice(0, 10).toLowerCase() === '0x095ea7b3') {
    const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    if (value !== 0n || matches(plan.fromToken.address, zeroAddress) || !matches(tx.to, plan.fromToken.address)
      || !matches(args[0], plan.router) || (args[1] !== 0n && args[1] !== tokenAmount(plan.amount))
      || !matches(tx.data, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args }))) {
      throw new Error('This approval does not match the reviewed token, spender, or amount.');
    }
    return { kind: 'approval', reset: args[1] === 0n, value };
  }
  if (!prepared || !matches(tx.to, plan.router) || !matches(prepared.to, plan.router)
    || !matches(prepared.data, tx.data) || quantity(prepared.value ?? '0') !== value
    || (prepared.chainId != null && quantity(prepared.chainId) !== BigInt(plan.fromChain))
    || (prepared.from != null && !matches(prepared.from, plan.account))
    || value > tokenAmount(plan.maximumValue)
    || (matches(plan.fromToken.address, zeroAddress) && value < tokenAmount(plan.amount))) {
    throw new Error('LI.FI has not supplied a matching prepared transaction for this route. Refresh the quote.');
  }
  return { kind: 'source', reset: false, value };
}

const recordKey = account => 'termul.any-token.v1:' + account.toLowerCase();
export function exchangeLedger(storage) {
  return {
    get(account) {
      const raw = storage.getItem(recordKey(account));
      if (!raw) return null;
      const r = JSON.parse(raw);
      if (!matches(r.account, account) || !exchangeChain(r.fromChain) || !exchangeChain(r.toChain)
        || !addressPattern.test(r.router ?? '') || !addressPattern.test(r.target ?? '') || !hashPattern.test(r.dataHash ?? '')
        || !addressPattern.test(r.fromToken?.address ?? '') || !addressPattern.test(r.toToken?.address ?? '')
        || !['approval', 'source'].includes(r.kind) || (r.hash != null && !hashPattern.test(r.hash))) {
        throw new Error('Could not read this wallet’s last exchange request.');
      }
      return r;
    },
    put(record) { storage.setItem(recordKey(record.account), JSON.stringify(record)); },
  };
}

async function readExactSource(record, chainClient) {
  const client = chainClient(record.fromChain);
  const [chain, receipt, tx] = await Promise.all([
    client.getChainId(), client.getTransactionReceipt({ hash: record.hash }), client.getTransaction({ hash: record.hash }),
  ]);
  if (chain !== record.fromChain || !matches(receipt.transactionHash, record.hash) || !matches(tx.hash, record.hash)
    || !matches(tx.from, record.account) || !matches(tx.to, record.target) || !hexData.test(tx.input ?? '')
    || !matches(keccak256(tx.input), record.dataHash) || tx.value !== quantity(record.value)) return null;
  return receipt;
}

function walletTokenIncome(receipt, token, account) {
  let net = 0n;
  for (const log of receipt.logs ?? []) {
    if (log.removed || !matches(log.address, token)) continue;
    try {
      const { args } = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics });
      if (matches(args.to, account)) net += args.value;
      if (matches(args.from, account)) net -= args.value;
    } catch { /* Ignore unrelated logs from the token. */ }
  }
  return net;
}

export async function reconcileExchange(record, chainClient, fetcher = fetch) {
  if (!hashPattern.test(record.hash ?? '')) return { stage: 'unknown' };
  let source;
  try { source = await readExactSource(record, chainClient); } catch { return { stage: 'submitted' }; }
  if (!source) return { stage: 'submitted' };
  if (source.status === 'reverted') return { stage: 'reverted' };
  if (source.status !== 'success') return { stage: 'submitted' };
  if (record.kind === 'approval') return { stage: 'approval-only' };
  if (record.fromChain === record.toChain && !matches(record.fromToken.address, zeroAddress)
    && !matches(record.toToken.address, zeroAddress)) {
    const sent = -walletTokenIncome(source, record.fromToken.address, record.account);
    const received = walletTokenIncome(source, record.toToken.address, record.account);
    if (sent === tokenAmount(record.amount) && sent > 0n && received >= tokenAmount(record.minimum) && received > 0n) {
      return { stage: 'completed', sent: sent.toString(), received: received.toString(), destinationHash: record.hash };
    }
  }

  try {
    const params = new URLSearchParams({ txHash: record.hash, fromChain: record.fromChain, toChain: record.toChain });
    if (record.fromChain !== record.toChain) params.set('bridge', record.tool);
    const response = await fetcher(lifiOrigin + '/v1/status?' + params, {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { stage: 'source-confirmed' };
    const data = await response.json();
    const { sending, receiving } = data;
    if (!matches(sending?.txHash, record.hash) || sending?.chainId !== record.fromChain) return { stage: 'source-confirmed' };
    if (data.substatus === 'REFUNDED') return { stage: 'refunded' };
    if (data.status === 'FAILED') return { stage: 'failed' };
    if (data.substatus === 'PARTIAL') return { stage: 'partial' };
    if (data.status !== 'DONE' || data.substatus !== 'COMPLETED'
      || !matches(data.fromAddress, record.account) || !matches(data.toAddress, record.account)
      || !matches(sending.token?.address, record.fromToken.address)
      || sending.token?.decimals !== record.fromToken.decimals || !tokenAmount(sending.amount) || tokenAmount(sending.amount) > tokenAmount(record.amount)
      || receiving?.chainId !== record.toChain || !hashPattern.test(receiving.txHash ?? '')
      || !matches(receiving.token?.address, record.toToken.address) || receiving.token?.decimals !== record.toToken.decimals
      || !tokenAmount(receiving.amount) || tokenAmount(receiving.amount) < tokenAmount(record.minimum)) return { stage: 'processing' };
    const destination = chainClient(record.toChain);
    const sameReceipt = record.toChain === record.fromChain && matches(receiving.txHash, record.hash);
    const [id, receipt] = sameReceipt ? [record.fromChain, source] : await Promise.all([
      destination.getChainId(), destination.getTransactionReceipt({ hash: receiving.txHash }),
    ]);
    if (id !== record.toChain || receipt.status !== 'success' || !matches(receipt.transactionHash, receiving.txHash)) return { stage: 'processing' };
    if (!matches(record.fromToken.address, zeroAddress) &&
      walletTokenIncome(source, record.fromToken.address, record.account) !== -tokenAmount(sending.amount)) {
      return { stage: 'processing' };
    }
    if (matches(record.fromToken.address, zeroAddress) && tokenAmount(sending.amount) > quantity(record.value)) {
      return { stage: 'processing' };
    }
    if (!matches(record.toToken.address, zeroAddress)
      && walletTokenIncome(receipt, record.toToken.address, record.account) !== tokenAmount(receiving.amount)) return { stage: 'processing' };
    return { stage: 'completed', received: receiving.amount, sent: sending.amount, destinationHash: receiving.txHash };
  } catch {
    return { stage: 'source-confirmed' };
  }
}

export function createExchangeSender({ wallet, chainClient, ledger, active, update = () => {} }) {
  let busy = false;
  return async (plan, prepared, tx, send) => {
    if (!active() || busy) throw new Error('An exchange request is already open or the tab is inactive.');
    busy = true;
    try {
      const selected = wallet.getSelection();
      const checked = validateExchangeRequest(plan, prepared, tx, selected);
      const previous = ledger.get(plan.account);
      if (previous && !['rejected', 'reverted', 'approval-only', 'completed', 'refunded'].includes(previous.stage)) {
        if (previous.kind !== 'approval' || previous.routeId !== plan.routeId
          || (await reconcileExchange(previous, chainClient)).stage !== 'approval-only') {
          throw new Error('Check the earlier exchange before submitting another request.');
        }
      }
      const approvals = previous?.routeId === plan.routeId ? previous.approvals ?? [] : [];
      if (previous?.routeId === plan.routeId && previous.kind === 'source') throw new Error('Refresh the quote before retrying an exchange.');
      if (checked.kind === 'approval' && approvals.some(item => item.reset === checked.reset)) throw new Error('This approval was already submitted.');
      const client = chainClient(plan.fromChain);
      const args = [plan.account];
      const [rpcChain, balance, gas, price, tokenBalance] = await Promise.all([
        client.getChainId(), client.getBalance({ address: plan.account }),
        client.estimateGas({ account: plan.account, to: tx.to, data: tx.data, value: checked.value }), client.getGasPrice(),
        matches(plan.fromToken.address, zeroAddress) ? Promise.resolve(null)
          : client.readContract({ address: plan.fromToken.address, abi: erc20Abi, functionName: 'balanceOf', args }),
      ]);
      if (rpcChain !== plan.fromChain || gas <= 0n || price <= 0n) throw new Error('Could not verify source-chain fees.');
      const gasLimit = tx.gas == null ? (gas * 12n + 9n) / 10n : quantity(tx.gas);
      const requestedPrice = quantity(tx.maxFeePerGas ?? tx.gasPrice ?? '0');
      const priorityFee = quantity(tx.maxPriorityFeePerGas ?? '0');
      if (gasLimit == null || gasLimit < gas || requestedPrice == null || requestedPrice < 0n
        || priorityFee == null || priorityFee < 0n || (tx.maxFeePerGas != null && priorityFee > requestedPrice)
        || (tx.gasPrice != null && (tx.maxFeePerGas != null || tx.maxPriorityFeePerGas != null))) {
        throw new Error('LI.FI returned invalid network fees.');
      }
      if (balance < checked.value + gasLimit * (requestedPrice > price ? requestedPrice : price)) throw new Error('Not enough native currency for the source network fee.');
      if (tokenBalance != null && tokenBalance < tokenAmount(plan.amount)) throw new Error('Not enough of the source token in this wallet.');
      const provider = await wallet.getProvider(selected);
      await assertProviderChain(provider, plan.account, plan.fromChain);
      if (!active() || !sameWallet(selected, wallet.getSelection())) throw new Error('The wallet or exchange view changed. Review the route again.');
      validateExchangeRequest(plan, prepared, tx, selected);
      const record = { ...plan, connectorId: undefined, kind: checked.kind, target: tx.to, value: checked.value.toString(),
        dataHash: keccak256(tx.data), stage: 'unknown', approvals, reset: checked.reset, hash: null };
      ledger.put(record);
      update(record, 'wallet');
      let hash;
      try { hash = await send({ ...tx, gas: '0x' + gasLimit.toString(16) }); }
      catch (error) {
        if (error.code === 4001 || error.cause?.code === 4001) {
          record.stage = 'rejected';
          ledger.put(record);
          update(record, 'rejected');
        }
        throw error;
      }
      if (!hashPattern.test(hash ?? '')) throw new Error('The wallet did not return a transaction hash. Check wallet activity before retrying.');
      record.hash = hash;
      record.stage = 'submitted';
      if (checked.kind === 'approval') record.approvals = [...approvals, { hash, reset: checked.reset }];
      ledger.put(record);
      update(record, 'submitted');
      return hash;
    } finally { busy = false; }
  };
}
