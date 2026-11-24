import { feePolicyChanged, loadFeePolicy, sameFeePolicy } from './fee-policy.js';
import { TERMUL_FEE_LABEL } from './swap-fee.js';
import { createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { getConnectorClient } from '@wagmi/core';
import { LiFiWidget, WidgetEvent, useWidgetEvents } from '@lifi/widget';
import { EthereumProvider as WidgetEthereumProvider } from '@lifi/widget-provider-ethereum';
import { EthereumProvider as SdkEthereumProvider } from '@lifi/sdk-provider-ethereum';
import { createPublicClient, formatUnits, http } from 'viem';
import { sendTransaction } from 'viem/actions';
import { walletConfig } from './wallet-auth.js';
import { arcNetwork } from './arc-network.js';
import {
  exchangeChain, exchangeWidgetConfig, hashPattern, loadExchangeNetworks, matches, scanLink, transactionLink,
} from './any-token-networks.js';
import { createExchangeSender, exchangeLedger, preparedExchangeStep, reconcileExchange, reviewExchangeRoute } from './any-token-transfers.js';
import { transactionDialogFor } from './transaction-dialog.js';

const stages = {
  wallet: 'Confirm the request in your wallet.',
  unknown: 'The wallet did not return a verifiable result. Check your wallet activity before retrying.',
  submitted: 'Submitted. Waiting for a source-chain receipt.',
  'approval-only': 'Token approval confirmed. The exchange itself has not been sent.',
  'source-confirmed': 'Source transaction confirmed. Checking for settlement.',
  processing: 'The route is still processing. Settlement has not been confirmed.',
  completed: 'Settlement confirmed.',
  rejected: 'Request declined in your wallet.',
  reverted: 'The source transaction reverted.',
  partial: 'LI.FI reports a partial transfer. Check the route details before trying again.',
  failed: 'LI.FI reports a failed route. Check for a refund before trying again.',
  refunded: 'LI.FI reports that this route was refunded. Check LI.FI Scan for details.',
};
const pollStages = new Set(['submitted', 'source-confirmed', 'processing', 'failed', 'partial']);
const finalStages = new Set(['completed', 'reverted', 'refunded', 'failed', 'partial']);
const $ = selector => document.querySelector(selector);
const amountText = (amount, token) => formatUnits(BigInt(amount), token.decimals) + ' ' + token.symbol;


function Events({ listeners }) {
  const events = useWidgetEvents();
  useEffect(() => {
    for (const [event, handler] of listeners) events.on(event, handler);
    return () => { for (const [event, handler] of listeners) events.off(event, handler); };
  }, [events, listeners]);
  return null;
}

function exchangeLinks(record) {
  const source = exchangeChain(record.fromChain);
  const destination = exchangeChain(record.toChain);
  return [
    ...(record.approvals ?? []).map(({ hash }, i) =>
      ({ href: transactionLink(record.fromChain, hash), label: `Approval ${i + 1} · ${source.name}` })),
    { href: transactionLink(record.fromChain, record.hash), label: `${record.kind === 'approval' ? 'Approval' : 'Source'} · ${source.name}` },
    { href: matches(record.hash, record.destinationHash) ? null : transactionLink(record.toChain, record.destinationHash),
      label: `Destination · ${destination.name}` },
    { href: record.kind === 'source' ? scanLink(record.hash) : null, label: 'LI.FI Scan' },
  ].filter((link, i, links) => link.href && links.findIndex(other => other.href === link.href) === i);
}

export async function mountAnyToken({ root, active, status }) {
  if (arcNetwork.error) throw new Error(arcNetwork.error);
  const networks = await loadExchangeNetworks();
  const wallet = window.termulWallet;
  const clients = new Map();
  const chainClient = id => {
    if (!clients.has(id)) {
      const chain = exchangeChain(id);
      if (!chain) throw new Error('Unsupported network.');
      clients.set(id, createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 8000, retryCount: 0 }) }));
    }
    return clients.get(id);
  };
  const ledger = exchangeLedger(window.localStorage);
  const dialog = transactionDialogFor($('#transaction-dialog'));
  const recovery = $('#exchange-recovery');
  const check = $('#exchange-check');
  const lookup = $('#exchange-hash');
  const feedback = $('#exchange-check-status');
  const networkSummary = $('#exchange-networks');
  const networkLabels = { fromChain: $('[data-exchange-network="from"]'), toChain: $('[data-exchange-network="to"]') };
  let plan;
  let prepared;
  let preparing;
  let current;
  let checking = false;
  let running = false;
  let pollTimer;
  let polls = 0;
  let shown = false;

  const setStatus = message => { status.textContent = message; };
  const feeDisclosure = $('#exchange-termul-fee');
  let activePolicy;
  function showNetwork(field, chainId) {
    const label = networkLabels[field];
    const network = networks.get(chainId);
    label.textContent = network?.name ?? 'Choose network';
    if (!network?.iconUrl) return;
    const icon = document.createElement('img');
    icon.alt = '';
    icon.referrerPolicy = 'no-referrer';
    icon.addEventListener('error', () => icon.remove(), { once: true });
    icon.src = network.iconUrl;
    label.prepend(icon);
  }
  const render = (record, stage = record?.stage) => {
    recovery.classList.toggle('hidden', !record);
    if (!record) return;
    $('#exchange-stage').textContent = stage === 'wallet' && record.kind === 'approval'
      ? 'Approve the reviewed token amount in your wallet.' : stages[stage] || 'Checking the latest exchange.';
    const links = exchangeLinks(record).map(({ href, label }) => {
      const a = document.createElement('a');
      a.className = 'btn btn-quiet';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label;
      return a;
    });
    $('#exchange-links').replaceChildren(...links);
    $('#exchange-hash-label').classList.toggle('hidden', Boolean(record.hash) || record.stage !== 'unknown' || running);
    check.disabled = checking || running;
    check.textContent = record.stage === 'completed' ? 'View receipt' : 'Check status';
  };

  const popup = record => {
    const source = exchangeChain(record.fromChain);
    const destination = exchangeChain(record.toChain);
    const isBridge = record.fromChain !== record.toChain;
    const stage = record.stage;
    const operation = dialog.begin({
      network: { name: source.name, explorerUrl: source.blockExplorers.default.url, explorerName: `${source.name} Explorer` },
      networks: `${source.name} → ${destination.name}`,
      destinationHash: isBridge ? record.destinationHash : undefined,
      type: record.kind === 'approval' ? 'Token approval' : isBridge ? 'Cross-chain exchange' : 'Token swap',
      amount: stage === 'completed' ? amountText(record.sent, record.fromToken) : 'Requested ' + amountText(record.amount, record.fromToken),
      detail: `LI.FI · ${record.tool}`, origin: check, successTitle: isBridge ? 'Bridge Completed!' : 'Swap Successful!',
      links: exchangeLinks(record).filter(link => link.href !== transactionLink(record.fromChain, record.hash)),
    });
    if (stage === 'completed') {
      operation.update('confirmed', { verifiedHash: record.hash, received: amountText(record.received, record.toToken),
        message: 'The route settled on the destination network.' });
    } else if (stage === 'rejected' || stage === 'reverted' || stage === 'refunded' || stage === 'failed' || stage === 'partial') {
      operation.update(stage === 'rejected' ? 'rejected' : 'failed', { referenceHash: record.hash, message: stages[stage],
        title: { refunded: 'Route refunded', partial: 'Partial settlement' }[stage] });
    } else if (stage === 'approval-only') {
      operation.update('pending', { title: 'Approval confirmed', referenceHash: record.hash, message: stages[stage] });
    } else {
      operation.update('pending', { referenceHash: record.hash, message: stages[stage] });
    }
  };

  async function refresh(interactive = false) {
    if (!active() || checking || running || !current) return;
    if (!interactive && (!pollStages.has(current.stage) || polls++ >= 30)) return;
    const saved = current;
    const candidate = saved.hash || (interactive ? lookup.value.trim() : '');
    if (!hashPattern.test(candidate ?? '')) {
      feedback.textContent = interactive ? 'Enter the transaction hash from your wallet activity.' : '';
      return;
    }
    checking = true;
    feedback.textContent = '';
    render(saved);
    try {
      const outcome = await reconcileExchange({ ...saved, hash: candidate }, chainClient);
      if (!active() || current !== saved || !matches(wallet.getSelection()?.address, saved.account)) return;
      if (!saved.hash && ['submitted', 'unknown'].includes(outcome.stage)) {
        feedback.textContent = 'Could not match that hash to this request yet.';
        return;
      }
      current = { ...saved, ...outcome, hash: candidate };
      if (current.kind === 'approval' && current.stage === 'approval-only'
        && !(current.approvals ?? []).some(item => matches(item.hash, candidate))) {
        current.approvals = [...(current.approvals ?? []), { hash: candidate, reset: saved.reset }];
      }
      ledger.put(current);
      render(current);
      if (interactive || (finalStages.has(current.stage) && current.stage !== saved.stage)) popup(current);
    } catch {
      feedback.textContent = 'Could not check the exchange. Try again shortly.';
    } finally {
      checking = false;
      render(current);
    }
  }

  check.addEventListener('click', () => void refresh(true));

  function update(record, stage) {
    if (matches(wallet.getSelection()?.address, record.account)) {
      current = record;
      lookup.value = '';
      polls = 0;
      render(record, stage);
    }
  }

  const send = createExchangeSender({ wallet, chainClient, ledger, active, update, verifyPolicy: checkPolicy });

  async function guardedClient() {
    const selection = wallet.getSelection();
    if (!selection) throw new Error('Connect your wallet first.');
    const client = await getConnectorClient(walletConfig);
    return client.extend(() => ({
      async getCapabilities() { return {}; },
      async sendTransaction(request) {
        if (request.chain && request.chain.id !== selection.chainId) throw new Error('The source chain changed. Review the route again.');
        const requestAccount = typeof request.account === 'string' ? request.account : request.account?.address;
        if (!matches(requestAccount, selection.address)) throw new Error('The selected wallet changed.');
        const currentPlan = plan;
        const currentPrepared = prepared;
        const tx = { ...request, from: requestAccount, chainId: selection.chainId };
        if (!currentPlan || !preparing) throw new Error('LI.FI has no reviewed transaction to send.');
        if (!matches(preparing.data, request.data) || !matches(preparing.to, request.to)) {
          throw new Error('The transaction changed. Review the route again.');
        }
        const start = () => {
          if (plan !== currentPlan) throw new Error('The route changed. Review a fresh quote.');
          return send(currentPlan, currentPrepared, tx, reviewed => sendTransaction(client, {
            to: reviewed.to, data: reviewed.data, value: BigInt(reviewed.value ?? 0),
            gas: BigInt(reviewed.gas), gasPrice: reviewed.gasPrice,
            maxPriorityFeePerGas: reviewed.maxPriorityFeePerGas, maxFeePerGas: reviewed.maxFeePerGas,
            account: client.account, chain: client.chain,
          }));
        };
        running = true;
        try {
          return await (navigator.locks ? navigator.locks.request('termul.exchange:' + selection.address.toLowerCase(), { ifAvailable: true }, lock => {
            if (!lock) throw new Error('An exchange is already open for this wallet in another tab.');
            return start();
          }) : start());
        } finally {
          running = false;
          preparing = null;
          if (active()) void refresh();
        }
      },
    }));
  }

  const providers = [WidgetEthereumProvider({
    disableMessageSigning: true,
    sdkProvider: () => SdkEthereumProvider({
      disableMessageSigning: true,
      getWalletClient: guardedClient,
      async switchChain(id) {
        if (!active() || !networks.has(id) || plan?.fromChain !== id) throw new Error('Review a quote on a supported source network.');
        await wallet.switchExchangeNetwork(networks.get(id).chain);
        return guardedClient();
      },
    }),
  })];

  const listeners = policy => [
    [WidgetEvent.FormFieldChanged, ({ fieldName, newValue }) => {
      if (Object.hasOwn(networkLabels, fieldName)) showNetwork(fieldName, newValue);
    }],
    [WidgetEvent.RouteExecutionStarted, route => {
      if (policy !== activePolicy) return;
      plan = null;
      prepared = null;
      preparing = null;
      if (!active()) return;
      try {
        plan = reviewExchangeRoute(route, wallet.getSelection(), networks, Date.now(), policy);
        setStatus(plan.fee
          ? `${TERMUL_FEE_LABEL} · ${amountText(plan.fee.integratorFee, plan.fromToken)} included. LI.FI fee · ${amountText(plan.fee.providerFee, plan.fromToken)} included.`
          : 'Route reviewed. Follow the next step in the exchange.');
      } catch (error) { setStatus(error.message); }
    }],
    [WidgetEvent.RouteExecutionUpdated, ({ route, action }) => {
      if (policy !== activePolicy || !active() || !plan || route.id !== plan.routeId || action.status !== 'ACTION_REQUIRED'
        || !['CROSS_CHAIN', 'SWAP'].includes(action.type)) return;
      try { prepared = preparedExchangeStep(plan, route, wallet.getSelection(), networks, policy); }
      catch (error) { prepared = null; setStatus(error.message); }
    }],
    [WidgetEvent.RouteExecutionCompleted, () => { if (active()) void refresh(); }],
    [WidgetEvent.RouteExecutionFailed, () => { if (active()) void refresh(); }],
  ];

  const widgetRoot = createRoot(root);
  function applyPolicy(policy) {
    if (sameFeePolicy(policy, activePolicy)) return false;
    activePolicy = policy;
    plan = prepared = preparing = null;
    feeDisclosure.hidden = !policy.bps;
    feeDisclosure.textContent = policy.bps
      ? `${TERMUL_FEE_LABEL} is included in the quote. Network and other provider fees are shown separately.` : '';
    const config = exchangeWidgetConfig(networks, providers, () => wallet.connect(), async request => {
      const reviewed = plan;
      if (policy !== activePolicy || !active() || !reviewed || !matches(reviewed.account, wallet.getSelection()?.address)) {
        throw new Error('The route or selected wallet changed. Review it again.');
      }
      if (request.requestType !== 'approve' && request.requestType !== 'transaction') throw new Error('Unsupported exchange request.');
      await checkPolicy(reviewed.feePolicy);
      if (reviewed !== plan) throw new Error('The route changed. Review a fresh quote.');
      // Require both this hook and the next ACTION_REQUIRED event.
      if (request.requestType === 'transaction') prepared = null;
      preparing = request;
      return request;
    }, policy);
    const query = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
    showNetwork('fromChain', config.fromChain);
    showNetwork('toChain', config.toChain);
    networkSummary.hidden = false;
    widgetRoot.render(h(QueryClientProvider, { key: policy.version + ':' + policy.bps, client: query },
      h(WagmiProvider, { config: walletConfig, reconnectOnMount: false },
        h(LiFiWidget, { integrator: config.integrator, config }), h(Events, { listeners: listeners(policy) }))));
    return true;
  }

  async function checkPolicy(expected) {
    const current = await loadFeePolicy();
    if (!sameFeePolicy(expected, activePolicy)) throw new Error(feePolicyChanged);
    if (!sameFeePolicy(expected, current)) {
      applyPolicy(current);
      setStatus(feePolicyChanged);
      throw new Error(feePolicyChanged);
    }
  }

  function walletChanged() {
    const selection = wallet.getSelection();
    if (!matches(selection?.address, plan?.account) || selection?.connectorId !== plan?.connectorId) {
      plan = null;
      prepared = null;
      preparing = null;
    }
    lookup.value = '';
    feedback.textContent = '';
    try { current = selection ? ledger.get(selection.address) : null; }
    catch (error) { current = null; setStatus(error.message); }
    render(current);
    if (active()) void refresh();
  }

  function show(open) {
    if (shown === open) return;
    shown = open;
    clearInterval(pollTimer);
    if (!open) return;
    polls = 0;
    walletChanged();
    void loadFeePolicy().then(policy => {
      if (shown && applyPolicy(policy)) setStatus('');
    }).catch(error => { if (shown) setStatus(error.message); });
    pollTimer = setInterval(refresh, 15_000);
  }
  setStatus('');
  return { show, walletChanged };
}
