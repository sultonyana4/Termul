import { formatUnits, isAddressEqual, recoverMessageAddress } from 'viem';
import { circleLifiNetworks } from './circle-lifi-routes.js';
import { createWalletSession } from './wallet-session.js';
import { isInvoiceReadError } from './payment-result.js';
import { parseSiweMessage } from 'viem/siwe';
import { ARC_ANY_SWAP_TOKENS } from './swap-quote.js';
import { renderReceiptAssets } from './display-assets.js';
import { circleSwapStep, renderCircleSwapReview } from './circle-swap-review.js';

const prefix = '/__termul_circle';
const chainId = 5042;
const selectedId = 'circle-email';
const declined = () => Object.assign(new Error('Wallet approval was declined.'), { code: 4001 });
const ambiguous = () => Object.assign(new Error('The Circle submission outcome is ambiguous. Check the existing attempt before trying again.'), { code: 'CIRCLE_PENDING' });

export function createCircleWallet({ changed, sessionChanged, production = false, walletApiUrl }) {
  const login = document.getElementById('circle-login-dialog');
  const reviewBox = document.getElementById('circle-review-dialog');
  const message = document.getElementById('circle-login-status');
  const form = document.getElementById('circle-email-form');
  const continueButton = document.getElementById('circle-otp-continue');
  const initButton = document.getElementById('circle-initialize');
  const refreshButton = document.getElementById('circle-refresh');
  let sdk, appSettings, auth, otp, wallet, verifiedUntil, sequence = 0, sessionTimer, busy = false, authRequest, managed, arcSwap, arcAnyToken, transferRecovery;
  let selection;
  let vaultQueue = Promise.resolve();
  const sessionRequest = (action, value) => {
    const operation = vaultQueue.then(async () => {
      const response = await fetch(production ? '/api/termul-circle-login' : prefix + '/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error',
        body: JSON.stringify({ action, ...value }), signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error('The local Circle session is unavailable.');
      return response.json();
    });
    vaultQueue = operation.catch(() => {});
    return operation;
  };

  async function request(action, input = {}, token = auth?.userToken) {
    try {
      if (production && (action.startsWith('pilot-') || action.startsWith('swap-') || action.startsWith('bridge-') || action.startsWith('lifi-') || action === 'attempt-history')) {
        const { walletId, walletAddress, ...terms } = input;
        const operation = action === 'attempt-history' ? 'history' : action.startsWith('pilot-') ? action.slice(6) : action;
        return await hostedSession.requestManagedInvoice(operation, { ...terms, userToken: token });
      }
      const response = await fetch(production ? '/api/termul-circle-login' : prefix + '/api', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error',
        body: JSON.stringify({ ...input, action, ...(token ? { userToken: token } : {}) }),
        signal: AbortSignal.timeout(40_000),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || 'Circle Wallet is unavailable.'), { status: response.status, code: result.code });
      return result;
    } catch (error) {
      if (error.status === 401 && token && token === auth?.userToken) {
        if (error.message.startsWith('Circle session is invalid or expired')) signOut();
        else invalidate();
      }
      throw error;
    }
  }

  const hostedSession = production ? createWalletSession({
    getWallet: () => selection, url: walletApiUrl, origin: () => location.origin, onChange: sessionChanged,
    async circleSign({ wallet: selected, message, challengeToken }) {
      if (selected !== selection || !auth) throw new Error('The selected Circle wallet changed.');
      const modal = document.getElementById('account-dialog');
      if (modal.open) modal.close();
      const { challengeId } = await request('sign', { challengeToken, message });
      if (selected !== selection || !auth) throw new Error('The selected Circle wallet changed.');
      const { data } = await approve(challengeId);
      const signature = data?.signature;
      if (selected !== selection || !/^0x[0-9a-f]{130}$/i.test(signature) ||
        !isAddressEqual(await recoverMessageAddress({ message, signature }), selected.address)) {
        throw new Error('Wallet signature verification failed.');
      }
      return signature;
    },
  }) : undefined;

  function invalidate() {
    if (hostedSession) return hostedSession.invalidate();
    const wasVerified = Boolean(verifiedUntil);
    clearTimeout(sessionTimer);
    verifiedUntil = 0;
    if (wasVerified) sessionChanged();
  }

  function signOut() {
    const token = auth?.userToken;
    hostedSession?.invalidate();
    const wasSelected = Boolean(selection);
    sequence++;
    clearTimeout(sessionTimer);
    verifiedUntil = 0;
    auth = undefined;
    otp = undefined;
    wallet = undefined;
    selection = undefined;
    authRequest = undefined;
    sdk?.updateConfigs({ appSettings });
    void sessionRequest('forget').catch(() => {});
    if (!production && token) void request('logout', {}, token).catch(() => {});
    if (wasSelected) changed();
  }

  const ownsSession = () => hostedSession ? hostedSession.isAuthenticated() : Boolean(selection && verifiedUntil > Date.now());
  function setLocalProof(until) {
    if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + 5 * 60_000) return;
    verifiedUntil = until;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(invalidate, verifiedUntil - Date.now());
    sessionChanged();
  }
  function useWallet(result, { restored = false } = {}) {
    if (!result || result.blockchain !== 'ARC' || result.accountType !== 'EOA') throw new Error('An Arc EOA is required.');
    wallet = result;
    selection = {
      address: result.address, chainId, connectorId: selectedId, revision: ++sequence,
      type: 'circle', capabilities: Object.freeze({ invoice: managed === true, arcSwap: arcSwap === true,
        arcAnyToken: arcSwap === true && arcAnyToken === true, transferRecovery, exchange: false, injectedProvider: false }),
    };
    login.close();
    if (!restored) void sessionRequest('remember', auth).catch(() => {});
    changed();
  }

  async function refresh() {
    const generation = sequence;
    const state = await request('initialization-status');
    if (generation !== sequence) return;
    if (state.wallet) return useWallet(state.wallet);
    const resume = state.state === 'pending' && state.resumable === true;
    initButton.hidden = state.state !== 'retry' && !resume;
    initButton.textContent = resume ? 'Continue wallet setup' : 'Approve wallet creation';
    refreshButton.hidden = false;
    message.textContent = state.state === 'disabled' ? 'No Arc wallet is available on this account. New wallet setup is disabled.'
      : state.state === 'retry' ? 'Approve creation of your Arc wallet in Circle.'
        : resume ? 'Continue your pending Arc wallet setup in Circle.'
        : 'Circle is still preparing your wallet. Check status again.';
  }

  function startOtp() {
    const generation = sequence;
    login.close();
    sdk.updateConfigs({ appSettings, loginConfigs: {
      deviceToken: otp.deviceToken, deviceEncryptionKey: otp.deviceEncryptionKey, otpToken: otp.otpToken, email: { email: otp.email },
    } }, (error, result) => {
      if (generation !== sequence || !otp) return;
      if (error || !result?.userToken || !result.encryptionKey) {
        message.textContent = 'Circle could not verify the code. Check it or request a new code.';
        return;
      }
      auth = { userToken: result.userToken, encryptionKey: result.encryptionKey };
      otp = undefined;
      sdk.updateConfigs({ appSettings });
      sdk.setAuthentication(auth);
      refreshButton.hidden = false;
      void runLogin(refresh);
    });
    watchClosedFrame(() => {
      if (generation === sequence && !selection && !login.open) login.showModal();
    });
    try { sdk.verifyOtp(); }
    catch { if (!login.open) login.showModal(); message.textContent = 'Circle verification could not open.'; }
  }

  async function runLogin(work) {
    if (busy) return;
    busy = true;
    const buttons = [...login.querySelectorAll('button[type="button"], button[type="submit"]')];
    buttons.forEach(button => { button.disabled = true; });
    try { await work(); }
    catch (error) {
      if (!login.open && !selection) login.showModal();
      message.textContent = error.message;
    } finally {
      buttons.forEach(button => { button.disabled = false; });
      busy = false;
    }
  }

  function watchClosedFrame(closed) {
    let iframe;
    const observer = new MutationObserver(() => {
      iframe ??= document.getElementById('sdkIframe');
      if (iframe && !iframe.isConnected) stop(true);
    });
    const timer = setTimeout(() => stop(true), 120_000);
    function stop(cancelled = false) {
      observer.disconnect();
      clearTimeout(timer);
      if (cancelled) closed();
    }
    observer.observe(document.body, { childList: true });
    queueMicrotask(() => { iframe ??= document.getElementById('sdkIframe'); });
    return stop;
  }

  function approve(challengeId) {
    return new Promise((resolve, reject) => {
      const feedback = document.getElementById('transaction-dialog');
      const restore = feedback.open;
      const activeSelection = selection;
      if (restore) feedback.close();
      const stop = watchClosedFrame(() => { resumeFeedback(); reject(ambiguous()); });
      function resumeFeedback() {
        if (restore && activeSelection === selection && !feedback.open) feedback.showModal();
      }
      try {
        sdk.execute(challengeId, (error, result) => {
          stop();
          resumeFeedback();
          if (error?.code === 155701) reject(declined());
          else if (error || result?.status !== 'COMPLETE') reject(ambiguous());
          else resolve(result);
        });
      } catch (error) { stop(); resumeFeedback(); reject(error); }
    });
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    void runLogin(async () => {
      const generation = sequence;
      const email = form.elements.email.value.trim();
      const deviceId = await sdk.getDeviceId();
      const result = await request('otp', { email, deviceId });
      if (generation !== sequence) return;
      otp = { ...result, email, deviceId };
      continueButton.hidden = false;
      message.textContent = 'Check your inbox for the Circle verification code.';
    });
  });
  continueButton.addEventListener('click', startOtp);
  refreshButton.addEventListener('click', () => void runLogin(refresh));
  initButton.addEventListener('click', () => void runLogin(async () => {
    const generation = sequence;
    initButton.hidden = true;
    const result = await request('initialize');
    if (generation !== sequence) return;
    if (result.wallet) return useWallet(result.wallet);
    if (result.challengeId) {
      login.close();
      try { await approve(result.challengeId); } catch { /* Reconcile the initialized wallet. */ }
    }
    if (generation !== sequence) return;
    if (!login.open) login.showModal();
    await refresh();
  }));

  async function authenticate(options) {
    if (hostedSession) return hostedSession.authenticate(options);
    if (ownsSession()) return;
    if (authRequest) return authRequest;
    const snapshot = selection;
    if (!snapshot) throw new Error('Choose the Circle wallet first.');
    const active = () => snapshot === selection && Boolean(auth);
    const pending = (async () => {
      const { message: text, challengeId } = await request('sign');
      const parsed = parseSiweMessage(text);
      if (!active() || parsed.domain !== location.host || parsed.uri !== location.origin
        || parsed.chainId !== chainId || parsed.version !== '1' || !parsed.nonce
        || !parsed.address || !isAddressEqual(parsed.address, snapshot.address)
        || !(parsed.expirationTime?.getTime() > Date.now())) throw new Error('The wallet challenge changed.');
      const modal = document.getElementById('account-dialog');
      if (modal.open) modal.close();
      const { data } = await approve(challengeId);
      const signature = data?.signature;
      if (!active() || !/^0x[0-9a-f]{130}$/i.test(signature) ||
        !isAddressEqual(await recoverMessageAddress({ message: text, signature }), snapshot.address)) {
        throw new Error('Wallet signature verification failed.');
      }
      const result = await request('verify-signature', { message: text, signature, challengeId });
      if (!active() || result.verified !== true) throw new Error('The wallet session changed.');
      setLocalProof(result.verifiedUntil);
      if (!ownsSession()) throw new Error('The local wallet verification expired.');
    })();
    authRequest = pending;
    try { await pending; } finally { if (authRequest === pending) authRequest = undefined; }
  }

  function chooseReview(review, notice = '', swap = false) {
    const assets = review.assets ?? (swap ? [ARC_ANY_SWAP_TOKENS[review.from], ARC_ANY_SWAP_TOKENS[review.to]].filter(Boolean) : []);
    renderReceiptAssets(document.getElementById('circle-review-assets'),
      review.phase === 'approval' ? assets.slice(0, 1) : assets);
    const heading = document.getElementById('circle-review-title');
    heading.textContent = swap ? 'Review ' + (notice && review.phase === 'swap' ? 'updated swap' : circleSwapStep(review).toLowerCase())
      : notice ? 'Review updated Circle fees' : 'Review Circle transaction';
    const status = document.getElementById('circle-review-notice');
    status.textContent = notice;
    status.hidden = !notice;
    const summary = document.getElementById('circle-swap-review-terms');
    const legacy = document.getElementById('circle-review-details');
    summary.hidden = !swap;
    legacy.hidden = swap;
    if (swap) renderCircleSwapReview(summary, review);
    else legacy.textContent =
      review.tool && review.fromChain ? `LI.FI · ${circleLifiNetworks[review.fromChain]} → ${circleLifiNetworks[review.toChain]}
${review.phase === 'transfer' ? 'Send ' + formatUnits(BigInt(review.amount), 6) + ' USDC' :
    'Set router allowance to ' + formatUnits(BigInt(review.allowance), 6) + ' USDC'}
Recipient ${review.recipient}
Minimum received ${formatUnits(BigInt(review.minimum), 6)} USDC
Termul fee ${formatUnits(BigInt(review.integratorFee), 6)} USDC · LI.FI fee ${formatUnits(BigInt(review.lifiFee), 6)} USDC
Bridge fee ${formatUnits(BigInt(review.bridgeFee), 6)} USDC
Execution gas cap ${review.networkFee} ${review.gasToken} · L2 data charges can be additional
Target ${review.target}
Calldata hash ${review.calldataHash}` :
      review.token === 'USDC' && review.to === 'Base' ? `Arc → Base · CCTP Standard Transfer
${review.phase === 'burn' ? 'Burn ' + formatUnits(BigInt(review.amount), 6) + ' USDC for delivery on Base' :
    'Set TokenMessenger allowance to ' + formatUnits(BigInt(review.allowance), 6) + ' USDC'}
Recipient ${review.recipient}
Minimum received ${formatUnits(BigInt(review.minimum), 6)} USDC
Maximum CCTP fee ${formatUnits(BigInt(review.maxFee), 6)} USDC
Maximum Arc network fee for this step ${review.networkFee} USDC
Target ${review.target}
Calldata hash ${review.calldataHash}` :
      `Arc Mainnet (5042) · ${review.walletAddress}\nMerchant ${review.merchant}\nContract ${review.contract}\nInvoice ${review.invoiceId}\n` +
      `Invoice amount ${review.invoiceAmountUsdc} USDC\nAttached value ${review.valueUsdc} USDC\n` +
      `Maximum network fee ${review.maxCostUsdc} USDC\nGas limit ${review.gasLimit}\n` +
      `Fee cap ${review.maxFeePerGas} base units/gas · Maximum tip ${review.priorityFeePerGas}\n` +
      `Review expires ${new Date(review.reviewExpiresAt).toLocaleTimeString()}\nCalldata hash ${review.calldataHash}`;
    return new Promise(resolve => {
      reviewBox.returnValue = '';
      reviewBox.addEventListener('close', () => resolve(reviewBox.returnValue === 'continue'), { once: true });
      reviewBox.showModal();
    });
  }

  async function loadSdk() {
    if (sdk) return;
    const config = await (await fetch(production ? '/api/termul-circle-login' : prefix + '/config', { cache: 'no-store' })).json();
    if (!config.appId) throw new Error('Circle Email Login is unavailable.');
    const { W3SSdk } = await import(/* @vite-ignore */ (production ? '/assets/termul-circle-sdk.js' : prefix + '/sdk.js'));
    managed = config.managed;
    arcSwap = config.arcSwap;
    arcAnyToken = config.arcAnyToken;
    transferRecovery = production && config.transferRecovery === true;
    appSettings = { appId: config.appId };
    sdk = new W3SSdk({ appSettings });
    const theme = getComputedStyle(document.documentElement);
    const color = name => theme.getPropertyValue('--' + name).trim();
    sdk.setThemeColor?.({
      bg: color('panel'), backdrop: color('bg'), backdropOpacity: 0.78, divider: '#334056',
      textMain: color('text'), textMain2: color('text'), textAuxiliary: '#b5bfd1', textAuxiliary2: '#b5bfd1',
      textSummary: color('text'), textSummaryHighlight: color('cyan'), textDetailToggle: color('cyan'),
      textInteractive: color('cyan'), interactiveBg: color('panel3'), tooltipText: color('text'), tooltipBg: color('panel3'),
      success: color('green'), error: color('red'), textPlaceholder: '#a4b1c5',
      inputText: color('text'), inputBg: color('panel2'), inputBgDisabled: color('panel3'), inputBorderFocused: color('cyan'),
      dropdownBg: color('panel2'), dropdownBorderIsOpen: color('cyan'),
      mainBtnText: color('bg'), mainBtnTextOnHover: color('bg'), mainBtnBg: color('cyan'), mainBtnBgOnHover: color('cyan2'),
      mainBtnBgDisabled: color('panel3'), mainBtnTextDisabled: '#a4b1c5',
      secondBtnText: color('text'), secondBtnBorder: '#53647e', secondBtnTextOnHover: color('cyan'),
      secondBtnBorderOnHover: color('cyan'), secondBtnBgOnHover: color('panel3'),
      plainBtnText: color('cyan'), plainBtnTextOnHover: color('text'),
      pinDotBase: color('panel2'), pinDotBaseBorder: '#a4b1c5', pinDotActivated: color('cyan'), enteredPinText: color('text'),
    });
    sdk.setOnResendOtpEmail(() => {
      if (!otp) return;
      const { email, deviceId } = otp;
      const generation = sequence;
      void runLogin(async () => {
        const next = await request('otp', { email, deviceId });
        if (generation !== sequence || !otp) return;
        otp = { ...next, email, deviceId };
        startOtp();
      });
    });
  }

  async function managedRoute(kind, action) {
    const selected = selection;
    if (!selected?.capabilities.transferRecovery || !['poll', 'status', 'history', 'close'].includes(action)) {
      throw new Error('New Circle transactions are available on Arc Mainnet only.');
    }
    if (action === 'poll' && !ownsSession()) return null;
    if (action !== 'poll') await authenticate({ fresh: action === 'close' });
    if (selected !== selection) throw new Error('The selected wallet changed.');
    const result = await request(kind + '-' + (action === 'poll' ? 'status' : action));
    if (selected !== selection) throw new Error('The selected wallet changed.');
    return result;
  }


  return {
    selection: () => selection,
    signOut,
    async open() {
      if (login.open || busy) return;
      signOut();
      continueButton.hidden = true;
      initButton.hidden = true;
      refreshButton.hidden = true;
      message.textContent = '';
      login.showModal();
      await runLogin(loadSdk);
    },
    async restore(canRestore) {
      const generation = sequence;
      try {
        const restored = await sessionRequest('restore');
        if (!restored?.wallet || !restored.auth || !canRestore() || generation !== sequence) return;
        await loadSdk();
        if (!canRestore() || generation !== sequence) return;
        sdk.setAuthentication(restored.auth);
        auth = restored.auth;
        useWallet(restored.wallet, { restored: true });
        if (hostedSession) await hostedSession.restore();
        else setLocalProof(restored.verifiedUntil);
      } catch { /* Email login remains available. */ }
    },
    session: {
      authenticate, invalidate, isAuthenticated: ownsSession,
      async request(metadataAction, payload, expectedAddress) {
        if (hostedSession) return hostedSession.request(metadataAction, payload, expectedAddress);
        const snapshot = selection;
        if (!ownsSession() || (expectedAddress && !isAddressEqual(expectedAddress, snapshot.address))) {
          throw new Error('Verify ownership of the selected Circle wallet.');
        }
        const result = await request('local-metadata', { ...payload, metadataAction });
        if (snapshot !== selection) throw new Error('The wallet session changed.');
        return result;
      },
    },
    async history() {
      const selected = selection;
      if (!selected || !wallet || (production && !ownsSession())) return [];
      const result = await request('attempt-history', { walletId: wallet.id, walletAddress: selected.address });
      return selected === selection ? result.attempts : [];
    },
    bridge: action => managedRoute('bridge', action),
    lifi: action => managedRoute('lifi', action),
    async swapStatus() {
      const selected = selection;
      if (!selected || !wallet || (production && !ownsSession())) return null;
      const result = await request('swap-status', { walletId: wallet.id, walletAddress: selected.address });
      if (selected !== selection) throw new Error('The selected wallet changed.');
      return result.attempt;
    },
    async sendArcSwap(selected, input, { reviewed, submitted, active = () => true, notice = '' } = {}) {
      if (selected !== selection || !selected.capabilities.arcSwap) throw new Error('Circle Arc swaps are unavailable.');
      if (input.anyToken && !selected.capabilities.arcAnyToken) throw new Error('Circle Any Token swaps are unavailable.');
      await authenticate({ fresh: true });
      const checkSelection = () => {
        if (selected !== selection || !ownsSession()) throw new Error('The selected wallet session changed.');
        if (!active()) throw declined();
      };
      checkSelection();
      const identity = { walletId: wallet.id, walletAddress: selected.address };
      let result;
      for (let retry = 0; ; retry++) {
        const { enabled, review } = await request('swap-review', { ...identity, ...input });
        checkSelection();
        if (!enabled) throw new Error('Circle Arc swaps are unavailable.');
        reviewed?.(review);
        if (!await chooseReview(review, notice, true)) throw declined();
        checkSelection();
        try {
          if (Date.now() >= review.reviewExpiresAt) {
            throw Object.assign(new Error('The quote expired. Review fresh terms.'), { status: 409, code: 'CIRCLE_SWAP_REVIEW_EXPIRED' });
          }
          result = await request('swap-execute', { ...identity, reviewId: review.reviewId, confirmed: true });
          break;
        } catch (error) {
          if (!retry && ['CIRCLE_SWAP_REVIEW_EXPIRED', 'CIRCLE_SWAP_FEE_CHANGED'].includes(error.code)) {
            notice = 'The previous terms expired or changed. Review and confirm these fresh terms.';
            continue;
          }
          if (error.status >= 400 && error.status < 500) throw error;
          throw ambiguous();
        }
      }
      if (selected === selection) submitted?.(result.attempt);
      if (result.challengeId && selected === selection) {
        try { await approve(result.challengeId); } catch { /* Reconcile the same submission. */ }
      }
      if (selected !== selection) throw ambiguous();
      try { return (await this.swapStatus()) ?? result.attempt; }
      catch {
        if (result.attempt) return result.attempt;
        throw ambiguous();
      }
    },
    async status() {
      if (!wallet || !selection) throw new Error('Sign in to check a Circle attempt.');
      if (production && !ownsSession()) return null;
      const snapshot = selection;
      const result = await request('pilot-status', { walletId: wallet.id, walletAddress: wallet.address });
      if (snapshot !== selection) throw new Error('The selected wallet changed.');
      return result.attempt;
    },
    async sendInvoice(selected, operation, { submitted } = {}) {
      if (selected !== selection || !selected.capabilities.invoice) throw new Error('Managed invoice execution is unavailable.');
      await authenticate({ fresh: true });
      if (selected !== selection || !ownsSession()) throw new Error('The selected wallet session changed.');
      const identity = { walletId: wallet.id, walletAddress: selected.address };
      const terms = { ...identity, ...operation };
      let review, notice;
      let result;
      for (;;) {
        const next = await request('pilot-review', terms);
        if (!next.enabled || selected !== selection) throw new Error('Managed invoice execution is unavailable.');
        if (review && (next.review.calldataHash !== review.calldataHash || next.review.valueUsdc !== review.valueUsdc)) {
          throw new Error('The invoice terms changed. Return to the invoice before reviewing again.');
        }
        review = next.review;
        if (!await chooseReview(review, notice)) throw declined();
        if (selected !== selection || !ownsSession()) throw new Error('The selected wallet session changed.');
        try {
          result = await request('pilot-execute', { ...identity, reviewId: review.reviewId, confirmed: true });
          break;
        } catch (error) {
          if (error.status === 409 && !notice && ['CIRCLE_FEE_REVIEW_STALE', 'CIRCLE_FEE_REVIEW_EXPIRED'].includes(error.code)) {
            notice = error.message;
            continue;
          }
          if ((error.status >= 400 && error.status < 500) || isInvoiceReadError(error)) throw error;
          submitted?.(null);
          throw ambiguous();
        }
      }
      if (result.attempt) submitted?.(null);
      if (!result.challengeId || selected !== selection) throw ambiguous();
      try { await approve(result.challengeId); } catch { /* The journal and Arc determine the outcome. */ }
      for (let check = 0; check < 5 && selected === selection; check++) {
        const attempt = await this.status().catch(() => null);
        if (attempt?.invoiceId === review.invoiceId && ['verified', 'reverted'].includes(attempt.status)) {
          submitted?.(attempt.transactionHash);
          return attempt.transactionHash;
        }
        if (attempt?.invoiceId === review.invoiceId && ['rejected', 'expired'].includes(attempt.status)) throw declined();
        await new Promise(resolve => setTimeout(resolve, 1_200));
      }
      throw ambiguous();
    },
  };
}
