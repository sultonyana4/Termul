import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, isAddressEqual } from 'viem';
import { TERMUL_MAINNET } from '../../supabase/functions/_shared/termul-mainnet.js';
import { invoiceAbi, reviewedInvoiceCalls } from './managed-preflight.js';

const payer = '0x5042000000000000000000000000000000000001';
const other = '0x5042000000000000000000000000000000000002';
const contract = TERMUL_MAINNET.contractAddress;
const hash = `0x${'12'.repeat(32)}`;
const walletId = 'synthetic-arc-eoa';
const session = 'synthetic-session';
const [create, pay] = reviewedInvoiceCalls(payer);

function makeReview(call) {
  return {
    walletId, session, chainId: 5042, from: payer, to: contract, input: call.data,
    value: call.value, gas: 100_000n, maxFeePerGas: 22_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n, call,
  };
}

function proofState(review, { transaction, receipt }, expectedHash) {
  try {
    if (transaction.hash !== expectedHash || receipt.transactionHash !== expectedHash
      || !isAddressEqual(transaction.from, review.from) || !isAddressEqual(transaction.to, review.to)
      || transaction.chainId !== review.chainId || transaction.input !== review.input || transaction.value !== review.value
      || transaction.gas !== review.gas || transaction.maxFeePerGas !== review.maxFeePerGas
      || transaction.maxPriorityFeePerGas !== review.maxPriorityFeePerGas
      || receipt.gasUsed <= 0n || receipt.gasUsed > review.gas) return 'ambiguous';
    if (receipt.status === 'reverted') return 'reverted';
    if (receipt.status !== 'success') return 'ambiguous';

    const creation = review.call.functionName === 'createInvoice';
    const eventName = creation ? 'InvoiceCreated' : 'InvoicePaid';
    const confirmed = receipt.logs.some(log => {
      if (log.removed || log.transactionHash !== expectedHash || !isAddressEqual(log.address, review.to)) return false;
      try {
        const { args } = decodeEventLog({ abi: invoiceAbi, eventName, topics: log.topics, data: log.data });
        return args.invoiceId === create.args[0] && isAddressEqual(args.merchant, review.from)
          && args.amount === BigInt(create.args[1])
          && (creation ? args.expiresAt === BigInt(create.args[2]) : isAddressEqual(args.payer, review.from));
      } catch {
        return false;
      }
    });
    return confirmed ? 'confirmed' : 'ambiguous';
  } catch {
    return 'ambiguous';
  }
}

// This model receives fixture events only. It is never imported by the app or server.
function createLifecycle(review) {
  let state = 'reviewed';
  let transactionHash;
  let interactive = true;
  return {
    get state() { return state; },
    request(authorization) {
      if (state !== 'reviewed' || !interactive || authorization?.walletId !== review.walletId
        || authorization?.session !== review.session) return false;
      state = 'approval-required';
      return true;
    },
    event(type, fixture) {
      if (type === 'session-expired' || type === 'wallet-switched') {
        interactive = false;
        if (['reviewed', 'approval-required'].includes(state)) state = 'invalidated';
        if (state === 'challenge-pending') state = 'ambiguous';
        return;
      }
      if (type === 'challenge-created' && state === 'approval-required') state = 'challenge-pending';
      if (type === 'rejected' && state === 'challenge-pending') state = 'rejected';
      if (type === 'expired' && state === 'challenge-pending') state = 'expired';
      if (type === 'circle-approved' && state === 'challenge-pending') state = 'submission-pending';
      if (type === 'submission-unknown' && ['challenge-pending', 'submission-pending', 'hash-available'].includes(state)) {
        state = 'ambiguous';
      }
      if (type === 'hash' && ['submission-pending', 'ambiguous'].includes(state)
        && /^0x[0-9a-f]{64}$/.test(fixture) && (!transactionHash || transactionHash === fixture)) {
        transactionHash = fixture;
        state = 'hash-available';
      }
      if (type === 'receipt' && state === 'hash-available') state = proofState(review, fixture, transactionHash);
    },
  };
}

function invoiceEvidence(review, overrides = {}) {
  const creation = review.call.functionName === 'createInvoice';
  const eventName = creation ? 'InvoiceCreated' : 'InvoicePaid';
  const args = {
    invoiceId: create.args[0], merchant: payer, ...(!creation ? { payer: overrides.eventPayer ?? payer } : {}),
  };
  const types = [{ type: 'uint256' }, ...(creation ? [{ type: 'uint64' }] : [])];
  const values = [overrides.eventAmount ?? BigInt(create.args[1]), ...(creation ? [0n] : [])];
  const { call, walletId: selected, session: authenticated, ...transaction } = review;
  return {
    transaction: { ...transaction, hash, ...overrides.transaction },
    receipt: {
      transactionHash: hash, status: 'success', gasUsed: 70_000n,
      logs: [{
        address: contract, transactionHash: hash,
        topics: encodeEventTopics({ abi: invoiceAbi, eventName, args }),
        data: encodeAbiParameters(types, values),
      }],
      ...overrides.receipt,
    },
  };
}

const authorization = { walletId, session };
function pendingChallenge(review) {
  const lifecycle = createLifecycle(review);
  assert.equal(lifecycle.request(authorization), true);
  lifecycle.event('challenge-created');
  return lifecycle;
}

test('mocked approval requires the review session and wallet and only chain proof confirms settlement', () => {
  for (const call of [create, pay]) {
    const review = makeReview(call);
    const lifecycle = createLifecycle(review);
    lifecycle.event('circle-approved');
    assert.equal(lifecycle.state, 'reviewed');
    assert.equal(lifecycle.request({ ...authorization, session: 'another' }), false);
    assert.equal(lifecycle.request({ ...authorization, walletId: 'another' }), false);
    assert.equal(lifecycle.request(authorization), true);
    assert.equal(lifecycle.state, 'approval-required');
    assert.equal(lifecycle.request(authorization), false);
    lifecycle.event('challenge-created');
    assert.equal(lifecycle.state, 'challenge-pending');
    lifecycle.event('circle-approved');
    assert.equal(lifecycle.state, 'submission-pending');
    lifecycle.event('receipt', invoiceEvidence(review));
    assert.equal(lifecycle.state, 'submission-pending');
    lifecycle.event('hash', hash);
    assert.equal(lifecycle.state, 'hash-available');
    lifecycle.event('receipt', invoiceEvidence(review));
    assert.equal(lifecycle.state, 'confirmed');
  }
});

test('mocked rejection, expiry, logout and wallet switch close local approval', () => {
  for (const event of ['rejected', 'expired', 'session-expired', 'wallet-switched']) {
    const lifecycle = pendingChallenge(makeReview(pay));
    lifecycle.event(event);
    assert.equal(lifecycle.state, ['rejected', 'expired'].includes(event) ? event : 'ambiguous');
    lifecycle.event('circle-approved');
    lifecycle.event('hash', hash);
    assert.equal(lifecycle.request(authorization), false);
  }
});

test('mocked ambiguity blocks duplicate requests while onchain evidence can still reconcile after logout', () => {
  const review = makeReview(pay);
  const lifecycle = pendingChallenge(review);
  lifecycle.event('circle-approved');
  lifecycle.event('session-expired');
  lifecycle.event('submission-unknown');
  assert.equal(lifecycle.state, 'ambiguous');
  assert.equal(lifecycle.request(authorization), false);
  lifecycle.event('hash', hash);
  lifecycle.event('receipt', invoiceEvidence(review));
  assert.equal(lifecycle.state, 'confirmed');
});

test('mocked settlement rejects altered transaction, receipt and invoice event proofs', () => {
  const review = makeReview(pay);
  for (const [overrides, expected] of [
    [{ transaction: { chainId: 1 } }, 'ambiguous'],
    [{ transaction: { from: other } }, 'ambiguous'],
    [{ transaction: { to: other } }, 'ambiguous'],
    [{ transaction: { input: create.data } }, 'ambiguous'],
    [{ transaction: { value: 0n } }, 'ambiguous'],
    [{ transaction: { gas: 100_001n } }, 'ambiguous'],
    [{ transaction: { maxFeePerGas: 25_000_000_000n } }, 'ambiguous'],
    [{ transaction: { maxPriorityFeePerGas: 1n } }, 'ambiguous'],
    [{ receipt: { logs: [] } }, 'ambiguous'],
    [{ receipt: { gasUsed: 100_001n } }, 'ambiguous'],
    [{ eventAmount: 1n }, 'ambiguous'],
    [{ eventPayer: other }, 'ambiguous'],
    [{ receipt: { status: 'reverted', logs: [] } }, 'reverted'],
  ]) {
    const lifecycle = pendingChallenge(review);
    lifecycle.event('circle-approved');
    lifecycle.event('hash', hash);
    lifecycle.event('receipt', invoiceEvidence(review, overrides));
    assert.equal(lifecycle.state, expected);
    assert.equal(lifecycle.request(authorization), false);
  }
});
