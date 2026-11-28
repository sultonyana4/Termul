import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk';
import { isAddressEqual, recoverMessageAddress } from 'viem';
import { parseSiweMessage } from 'viem/siwe';

const el = id => document.getElementById(id);
const show = (id, visible) => { el(id).hidden = !visible; };
const status = message => { el('status').textContent = message; };
let sdk;
let appSettings;
let otp;
let auth;
let wallet;
let canInitialize = false;
let busy = false;
let resending = false;
let pilotEnabled = false;
let paymentEnabled = false;
let pilotReviewEnabled = false;
let pilotReview;
let pilotReviewTimer;
const lifetime = new AbortController();

function draw() {
  show('email-form', Boolean(sdk && !otp && !auth));
  show('verify', Boolean(otp && !auth));
  show('refresh', Boolean(auth));
  show('initialize', Boolean(auth && canInitialize && !wallet));
  show('wallet', Boolean(wallet));
  show('managed-preflight', Boolean(wallet));
  show('invoice-pilot', Boolean(wallet));
  show('pilot-confirmation', Boolean(pilotReviewEnabled && pilotReview && wallet?.id === pilotReview.walletId));
  el('pilot-mode').textContent = (pilotEnabled || paymentEnabled)
    ? 'Execution is enabled for an explicitly confirmed review.'
    : 'Execution is disabled. Review and attempt status are available.';
  show('logout', Boolean(sdk));
  for (const button of document.querySelectorAll('button:not(#logout)')) button.disabled = busy;
  el('pilot-execute').disabled = busy || !el('pilot-confirm').checked || !pilotReview;
  if (wallet) {
    el('wallet-id').textContent = wallet.id;
    el('wallet-address').textContent = wallet.address;
    el('wallet-chain').textContent = `${wallet.blockchain} · Arc Mainnet (5042) · ${wallet.accountType}`;
  }
}

class DisplayError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.status = statusCode;
  }
}

async function api(action, body = {}) {
  const response = await fetch('/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: lifetime.signal,
    body: JSON.stringify({ action, ...body, ...(auth ? { userToken: auth.userToken } : {}) }),
  });
  const data = await response.json();
  if (!response.ok) throw new DisplayError(data.error, response.status);
  return data;
}

function circleError(error, message) {
  const code = Number.isInteger(error?.code) ? ` (Circle code ${error.code})` : '';
  return new DisplayError(`${message}${code}`);
}

async function run(work, fallback) {
  if (busy || lifetime.signal.aborted) return;
  busy = true;
  draw();
  try {
    await work();
  } catch (error) {
    if (!lifetime.signal.aborted) status(error instanceof DisplayError ? error.message : fallback);
  } finally {
    busy = false;
    draw();
  }
}

function setOtpConfig() {
  const { otpToken, deviceToken, deviceEncryptionKey, email } = otp;
  sdk.updateConfigs({ appSettings, loginConfigs: { otpToken, deviceToken, deviceEncryptionKey, email: { email } } }, onLogin);
}

async function refreshWallet() {
  canInitialize = false;
  draw();
  const state = await api('initialization-status');
  if (wallet?.id !== state.wallet?.id || wallet?.address !== state.wallet?.address) {
    el('preflight-results').replaceChildren();
    clearPilotReview();
    el('pilot-details').replaceChildren();
  }
  wallet = state.wallet;
  canInitialize = !wallet && state.state === 'retry';
  if (wallet) {
    status('Arc EOA retrieved.');
  } else if (state.state === 'disabled') {
    status('No Arc wallet is available on this account. New wallet setup is disabled.');
  } else if (state.state === 'complete') {
    status('Circle completed initialization. Waiting for the Arc EOA to appear.');
  } else if (!canInitialize) {
    status('Circle initialization is still pending. Refresh wallet to check again.');
  } else if (state.retrySameRequest) {
    status('Circle has not confirmed the previous request. Retrying will use the same request key.');
  } else if (state.priorAttempt) {
    status('Circle reports that the earlier challenge failed or expired. You can request approval again.');
  } else {
    status('Email verified. Approve creation to set up an Arc EOA.');
  }
  return wallet ? 'ready' : state.state;
}

async function reconcileInitialization() {
  for (const delay of [0, 500, 1000, 2000, 4000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (lifetime.signal.aborted) return;
    try {
      const state = await refreshWallet();
      if (state === 'ready' || state === 'retry') return;
    } catch (error) {
      if (error instanceof DisplayError && error.status === 401) throw error;
      if (!lifetime.signal.aborted) status('Initialization outcome is unknown. Refresh wallet to check again.');
    }
  }
}

function onLogin(error, result) {
  if (!otp || auth || lifetime.signal.aborted) return;
  if (error || !result?.userToken || !result?.encryptionKey) {
    status(circleError(error, 'Circle OTP verification did not complete.').message);
    draw();
    return;
  }
  busy = false;
  auth = { userToken: result.userToken, encryptionKey: result.encryptionKey };
  otp = null;
  sdk.updateConfigs({ appSettings });
  sdk.setAuthentication(auth);
  void run(refreshWallet, 'Email verified. Refresh the wallet to try again.');
}

async function resend() {
  if (!otp || resending) return;
  resending = true;
  try {
    const { email, deviceId } = otp;
    const result = await api('otp', { email, deviceId });
    if (!otp || auth) return;
    otp = { ...result, email, deviceId };
    setOtpConfig();
    sdk.verifyOtp();
    status('Requested another OTP. Check the approved inbox.');
  } catch (error) {
    status(error instanceof DisplayError ? error.message : 'Could not resend the OTP.');
  } finally {
    resending = false;
  }
}

function approve(challengeId) {
  return new Promise((resolve, reject) => {
    const signal = lifetime.signal;
    if (signal.aborted) return reject(signal.reason);
    let iframe;
    let finished = false;
    const observer = new MutationObserver(() => {
      if (iframe && !iframe.isConnected) finish(reject, new DisplayError('Circle closed the approval window.'));
    });
    const onAbort = () => finish(reject, signal.reason);
    const timeout = setTimeout(() => finish(reject, new DisplayError('Circle approval outcome is unknown.')), 120_000);
    function finish(settle, value) {
      if (finished) return;
      finished = true;
      observer.disconnect();
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
      settle(value);
    }

    signal.addEventListener('abort', onAbort, { once: true });
    try {
      sdk.execute(challengeId, (error, result) => {
        if (error || result?.status !== 'COMPLETE') {
          finish(reject, circleError(error, 'Circle approval outcome is unknown.'));
        } else {
          finish(resolve, result);
        }
      });
      // The pinned Web SDK can remove its iframe on dismissal without calling back.
      iframe = el('sdkIframe');
      if (iframe && !finished) observer.observe(document.body, { childList: true });
    } catch (error) {
      finish(reject, error);
    }
  });
}

el('email-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    status('Requesting an email OTP…');
    const email = el('email').value.trim().toLowerCase();
    const deviceId = await sdk.getDeviceId();
    const result = await api('otp', { email, deviceId });
    otp = { ...result, email, deviceId };
    setOtpConfig();
    status('Check the approved inbox, then enter the OTP in Circle.');
  }, 'Could not request an OTP.');
});

el('verify').addEventListener('click', () => {
  if (busy || !otp) return;
  busy = true;
  draw();
  status('Complete OTP verification in Circle.');
  try {
    sdk.verifyOtp();
  } catch {
    busy = false;
    draw();
    status('Could not open Circle OTP verification.');
  }
});

el('refresh').addEventListener('click', () => void run(refreshWallet, 'Could not refresh the wallet.'));
el('initialize').addEventListener('click', () => void run(async () => {
  canInitialize = false;
  status('Checking initialization with Circle…');
  try {
    const response = await api('initialize');
    if (response.wallet) {
      wallet = response.wallet;
      status('Arc EOA retrieved.');
      return;
    }
    if (response.challengeId) {
      status('Approve EOA creation in Circle.');
      await approve(response.challengeId);
    }
  } catch (error) {
    if (error instanceof DisplayError && error.status === 401) throw error;
    if (lifetime.signal.aborted) return;
  }
  status('Checking Circle challenge and wallet status…');
  await reconcileInitialization();
}, 'Initialization outcome is unknown. Refresh wallet to check again.'));

el('balance').addEventListener('click', () => void run(async () => {
  const { chainId, balance } = await api('balance');
  el('wallet-balance').textContent = `${balance} USDC (chain ${chainId})`;
  status('Arc balance read successfully.');
}, 'Could not read the Arc balance.'));

const preflightLabels = {
  checked: 'Preflight checks finished.',
  'wrong-chain': 'Arc RPC returned a different chain.',
  'runtime-mismatch': 'The contract bytecode did not match the pinned deployment.',
  'deployment-rpc-error': 'Arc RPC could not verify the deployment.',
  'wallet-has-code': 'The selected address has onchain code and failed the EOA check.',
  'wallet-rpc-error': 'Arc RPC could not verify the selected wallet.',
  simulated: 'Simulation succeeded',
  estimated: 'Estimate returned',
  'unexpected-result': 'Unexpected simulation result',
  'insufficient-funds': 'Insufficient native USDC',
  'contract-revert': 'Contract reverted in simulation',
  'rpc-error': 'RPC request failed',
  'unsupported-blockchain': 'Circle reported unsupported blockchain',
  'circle-error': 'Circle fee request failed',
  'circle-authentication-error': 'Circle rejected authentication or API permission',
  'invalid-fee-response': 'Circle returned unrecognized fee units or fields',
};

function describeProbe(probe) {
  return [preflightLabels[probe.status] ?? probe.status, probe.reason,
    probe.code ? `Circle code ${probe.code}` : null].filter(Boolean).join(' · ');
}

function preflightDetails(parent, rows) {
  const list = document.createElement('dl');
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    list.append(term, detail);
  }
  parent.append(list);
}

function renderPreflight(report) {
  status(preflightLabels[report.status] ?? 'Preflight could not be completed.');
  if (report.status !== 'checked') return;
  const results = el('preflight-results');
  preflightDetails(results, [
    ['Verified Arc chain and contract', `${report.deployment.chainId} · ${report.deployment.address}`],
    ['Runtime hash', report.deployment.runtimeHash],
    ['Wallet balance', `${report.balanceUsdc} native USDC (${report.nativeDecimals} decimals)`],
    ['RPC gas price', report.rpcGasPriceWei === null ? 'Unavailable' : `${report.rpcGasPriceWei} base units per gas`],
  ]);
  for (const call of report.calls) {
    const heading = document.createElement('h3');
    heading.textContent = call.functionName;
    results.append(heading);
    preflightDetails(results, [
      ['Decoded arguments', call.args.join(', ')],
      ['Calldata', call.calldata],
      ['Native value', `${call.valueUsdc} USDC (${call.valueBaseUnits} base units)`],
      ['Balance covers native value', call.balanceCoversValue ? 'Yes' : 'No'],
      ['Arc eth_call', describeProbe(call.rpcCall)],
      ['Arc eth_estimateGas', call.rpcGas.gasUnits ? `${call.rpcGas.gasUnits} gas units` : describeProbe(call.rpcGas)],
      ['RPC indicative cost', call.rpcIndicativeCostUsdc === null ? 'Unavailable' : `${call.rpcIndicativeCostUsdc} USDC`],
      ['Balance covers value and indicative gas', call.balanceCoversRpcTotal == null ? 'Unavailable' : call.balanceCoversRpcTotal ? 'Yes' : 'No'],
      ['Circle medium fee estimate', call.circle.gasUnits
        ? `${call.circle.gasUnits} gas units · ${call.circle.maxFeeWeiPerGas} max and ${call.circle.priorityFeeWeiPerGas} tip (base units per gas) · ${call.circle.capCostUsdc} USDC at cap${call.circle.meetsArcFeeFloor ? '' : ' · below Arc fee floor'}`
        : describeProbe(call.circle)],
      ['Circle minus RPC gas units', call.gasUnitsDelta ?? 'Unavailable'],
    ]);
  }
}

el('run-preflight').addEventListener('click', () => void run(async () => {
  el('preflight-results').replaceChildren();
  status('Checking the selected Arc EOA and estimating fees…');
  const selected = wallet;
  const report = await api('managed-preflight', { walletId: selected.id, walletAddress: selected.address });
  if (lifetime.signal.aborted || wallet !== selected) return;
  renderPreflight(report);
}, 'Could not complete the managed execution preflight.'));

function clearPilotReview() {
  clearTimeout(pilotReviewTimer);
  pilotReview = null;
  el('pilot-confirm').checked = false;
}

function pilotSelection() {
  return { walletId: wallet.id, walletAddress: wallet.address };
}

function renderPilotAttempt(attempt, notice) {
  const details = el('pilot-details');
  details.replaceChildren();
  if (!attempt) {
    status('No pilot attempt was found for the selected wallet.');
    return;
  }
  preflightDetails(details, [
    ['Attempt status', attempt.status],
    ...(attempt.verificationSource ? [['Evidence source', attempt.verificationSource]] : []),
    ...(attempt.latestInvoice ? [['Latest invoice state', `${attempt.latestInvoice.status}${attempt.latestInvoice.expired ? ' · expired' : ''}`]] : []),
    ...(attempt.diagnostic ? [['Provider diagnostic', JSON.stringify(attempt.diagnostic)]] : []),
    ['Invoice ID', attempt.invoiceId],
    ['Wallet', attempt.walletAddress],
    ['Arc chain ID', attempt.chainId],
    ['Calldata hash', attempt.calldataHash],
    ['Reviewed gas limit', attempt.gasLimit],
    ['Reviewed max fee per gas (base units)', attempt.maxFeePerGas],
    ['Reviewed tip per gas (base units)', attempt.priorityFeePerGas],
    ...(attempt.challengeStatus ? [['Circle challenge status', attempt.challengeStatus]] : []),
    ...(attempt.transactionStatus ? [['Circle transaction status', attempt.transactionStatus]] : []),
    ...(attempt.transactionId ? [['Circle transaction ID', attempt.transactionId]] : []),
    ...(attempt.transactionHash ? [['Arc transaction hash', attempt.transactionHash]] : []),
    ...(attempt.gasUsed ? [['Actual gas used', attempt.gasUsed], ['Actual network cost', `${attempt.costUsdc} USDC`]] : []),
  ]);
  status(notice ?? (attempt.status === 'verified'
    ? (attempt.kind === 'payment' ? 'Invoice payment verified on Arc.' : 'Invoice creation verified on Arc.')
    : 'Check attempt status again as needed. Circle approval alone does not confirm invoice creation.'));
}

el('pilot-confirm').addEventListener('change', draw);
function preparePilot(payment = false) { return run(async () => {
  clearPilotReview();
  const details = el('pilot-details');
  details.replaceChildren();
  status('Simulating invoice creation and checking current fees…');
  const response = await api('pilot-review', { ...pilotSelection(), ...(payment ? {
    kind: 'payment', merchant: el('pilot-merchant').value.trim(), invoiceId: el('pilot-invoice-input').value.trim(),
  } : {}) });
  if (lifetime.signal.aborted) return;
  pilotReviewEnabled = response.enabled;
  pilotReview = response.review;
  const r = pilotReview;
  preflightDetails(details, [
    ['Merchant and Circle wallet', `${r.walletAddress} · ${r.walletId}`],
    ['Verified chain and contract', `${r.chainId} · ${r.contract}`],
    ['Contract runtime hash', r.runtimeHash],
    ['Invoice ID', r.invoiceId],
    ['Invoice amount', `${r.invoiceAmountUsdc} USDC`],
    ['Invoice expiry', new Date(Number(r.expiresAt) * 1000).toISOString()],
    ['Native transaction value', `${r.valueUsdc} USDC`],
    ['Decoded function', r.kind === 'payment' ? 'payInvoice(address,bytes32)' : 'createInvoice(bytes32,uint256,uint64)'],
    ['Calldata', r.calldata],
    ['Calldata hash', r.calldataHash],
    ['RPC and Circle estimated gas units', `${r.rpcGasUnits} · ${r.circleGasUnits}`],
    ['RPC gas price (base units per gas)', r.rpcGasPriceWei],
    ['Reviewed gas limit', r.gasLimit],
    ['Reviewed max fee per gas (base units)', r.maxFeePerGas],
    ['Reviewed tip per gas (base units)', r.priorityFeePerGas],
    ['Maximum network cost', `${r.maxCostUsdc} USDC (pilot cap ${r.feeBudgetUsdc} USDC)`],
    ['Wallet balance', `${r.balanceUsdc} USDC`],
    ['Fee headroom', r.headroom ? '10% gas units and 5% fee and tip' : 'Current estimate only'],
    ['Review expires', new Date(r.reviewExpiresAt).toISOString()],
  ]);
  pilotReviewTimer = setTimeout(() => {
    clearPilotReview();
    draw();
    if (!busy) status('Invoice review expired. Prepare a new review.');
  }, Math.max(0, r.reviewExpiresAt - Date.now()));
  status(pilotReviewEnabled ? 'Review the invoice and network fee before continuing.' : 'Invoice review prepared. Execution is disabled.');
}, 'Could not prepare the invoice review.'); }
el('pilot-review').addEventListener('click', () => void preparePilot());
el('pilot-review-payment').addEventListener('click', () => void preparePilot(true));
el('pilot-recover').addEventListener('click', () => void run(async () => {
  const result = await api('pilot-recover', { ...pilotSelection(), hash: el('pilot-hash').value.trim() });
  renderPilotAttempt(result.attempt, result.notice);
}, 'Arc could not verify this hash against the existing attempt.'));


el('pilot-execute').addEventListener('click', () => void run(async () => {
  if (!pilotReview || !el('pilot-confirm').checked) return;
  const reviewId = pilotReview.reviewId;
  const selection = pilotSelection();
  clearPilotReview();
  status('Rechecking the invoice and requesting a Circle challenge…');
  const result = await api('pilot-execute', { ...selection, reviewId, confirmed: true });
  if (lifetime.signal.aborted) return;
  renderPilotAttempt(result.attempt);
  if (!result.challengeId) return;
  status('Review and approve or decline the invoice in Circle.');
  try { await approve(result.challengeId); }
  catch {
    if (lifetime.signal.aborted) return;
  }
  const current = await api('pilot-status', selection);
  renderPilotAttempt(current.attempt, current.notice);
}, 'Execution outcome is unknown. Check the existing attempt before continuing.'));

el('pilot-provider-status').addEventListener('click', () => void run(async () => {
  clearPilotReview();
  const { provider } = await api('pilot-provider-status', pilotSelection());
  preflightDetails(el('pilot-details'), provider.map(row => [
    row.stage, [row.result, row.details, row.httpStatus && `HTTP ${row.httpStatus}`,
      row.circleCode && `Circle ${row.circleCode}`, row.referenceId, row.transactionId].filter(Boolean).join(' · ') || 'Unavailable',
  ]));
  status(provider.length ? 'Provider history checked. Journal proof is unchanged.' : 'No Circle attempt was found.');
}, 'Could not check Circle provider history.'));

el('pilot-reconcile').addEventListener('click', () => void run(async () => {
  clearPilotReview();
  const result = await api('pilot-status', pilotSelection());
  pilotEnabled = result.enabled;
  renderPilotAttempt(result.attempt && { ...result.attempt, diagnostic: result.diagnostic ?? result.attempt.diagnostic }, result.notice);
}, 'Could not check the existing pilot attempt.'));

el('sign').addEventListener('click', () => void run(async () => {
  const { message, challengeId } = await api('sign');
  const parsed = parseSiweMessage(message);
  if (parsed.domain !== location.host || parsed.uri !== location.origin || parsed.chainId !== 5042
    || parsed.version !== '1' || !parsed.nonce || !(parsed.expirationTime?.getTime() > Date.now())
    || !parsed.address || !isAddressEqual(parsed.address, wallet.address)) {
    throw new DisplayError('The local SIWE challenge did not match this wallet and origin.');
  }
  el('message').textContent = message;
  show('message', true);
  status('Review the local SIWE message and approve it in Circle.');
  const result = await approve(challengeId);
  const signature = result.data?.signature;
  if (!/^0x[0-9a-f]{130}$/i.test(signature) || !isAddressEqual(await recoverMessageAddress({ message, signature }), wallet.address)) {
    throw new DisplayError('The signature did not recover the displayed wallet address.');
  }
  await api('verify-signature', { message, signature, challengeId });
  status('Signature recovered the expected EOA. Local SIWE verified on Arc Mainnet.');
}, 'Could not verify the local SIWE signature.'));

el('logout').addEventListener('click', () => {
  if (auth) void fetch('/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ action: 'logout', userToken: auth.userToken }),
  }).catch(() => {});
  lifetime.abort();
  auth = null;
  otp = null;
  wallet = null;
  sdk.updateConfigs({ appSettings });
  location.replace('/');
});

window.addEventListener('pagehide', () => {
  lifetime.abort();
  auth = null;
  otp = null;
  sdk?.updateConfigs({ appSettings });
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

async function boot() {
  const { appId, pilotEnabled: configuredPilot, paymentEnabled: configuredPayment } = await (await fetch('/config', { cache: 'no-store' })).json();
  if (!appId) {
    status('Configure the local Circle environment and restart.');
    return;
  }
  pilotEnabled = configuredPilot === true;
  paymentEnabled = configuredPayment === true;
  appSettings = { appId };
  sdk = new W3SSdk({ appSettings }, onLogin);
  sdk.setOnResendOtpEmail(() => void resend());
  draw();
  status('Ready to request an email OTP.');
}

void boot().catch(() => status('Could not start the Circle Web SDK.'));
