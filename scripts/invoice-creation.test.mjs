import assert from 'node:assert/strict';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseUnits,
} from 'viem';
import {
  createPaymentSubmissionGate,
} from '../src/payment-result.js';
import {
  matchesInvoiceCreationTransaction,
  pollInvoiceCreationReconciliation,
  reconcileInvoiceCreationAttempt,
  submitInvoiceCreationOnce,
} from '../src/invoice-creation.js';

const chainId = 5042;
const contract = '0x62209ab89631492e7943ef21baee792d430f5d0e';
const merchant = '0x4d3e3dc6d280cdd8ba520f8e4b9ac3bf762bbdfe';
const invoiceId = `0x${'ab'.repeat(32)}`;
const amount = parseUnits('5', 18);
const expiresAt = 1_794_329_999n;
const hash = '0x' + '12'.repeat(32);
const abi = [
  {
    type: 'function',
    name: 'createInvoice',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'invoiceId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'InvoiceCreated',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'invoiceId', type: 'bytes32' },
      { indexed: true, name: 'merchant', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'expiresAt', type: 'uint64' },
    ],
  },
];
const expected = { chainId, contract, merchant, invoiceId, amount, expiresAt, abi };
const calldata = encodeFunctionData({ abi, functionName: 'createInvoice', args: [invoiceId, amount, expiresAt] });
const transaction = { hash, from: merchant, to: contract, input: calldata, value: 0n, chainId };
const eventTopics = encodeEventTopics({ abi, eventName: 'InvoiceCreated', args: { invoiceId, merchant } });
const eventData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [amount, expiresAt]);
const createdLog = {
  address: contract,
  transactionHash: hash,
  topics: eventTopics,
  data: eventData,
};
const successfulReceipt = {
  transactionHash: hash,
  status: 'success',
  logs: [createdLog],
};
const readDeps = {
  readChainId: async () => chainId,
  readReceipt: async () => successfulReceipt,
  readTransaction: async () => transaction,
};

{
  assert.equal(matchesInvoiceCreationTransaction(transaction, expected), true, 'Exact createInvoice calldata, sender, contract, value and chain are accepted.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, from: '0x1111111111111111111111111111111111111111' }, expected), false, 'A different merchant/sender is rejected.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, value: 1n }, expected), false, 'Unexpected native value is rejected.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, input: encodeFunctionData({ abi, functionName: 'createInvoice', args: [invoiceId, amount + 1n, expiresAt] }) }, expected), false, 'A different amount is rejected.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, input: encodeFunctionData({ abi, functionName: 'createInvoice', args: [`0x${'cd'.repeat(32)}`, amount, expiresAt] }) }, expected), false, 'A different invoice ID is rejected.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, input: encodeFunctionData({ abi, functionName: 'createInvoice', args: [invoiceId, amount, expiresAt + 1n] }) }, expected), false, 'A different expiry is rejected.');
}

{
  let submitCount = 0;
  const attempt = await submitInvoiceCreationOnce({
    submit: async () => {
      submitCount++;
      throw Object.assign(new Error('Wallet reported an ambiguous submission'), { transactionHash: hash });
    },
    waitForReceipt: async (transactionHash) => {
      assert.equal(transactionHash, hash);
      return successfulReceipt;
    },
    reconcile: (args) => reconcileInvoiceCreationAttempt({ expected, ...args, ...readDeps }),
  });
  assert.equal(attempt.transactionHash, hash);
  assert.equal(attempt.result.status, 'created');
  assert.equal(attempt.ambiguous, true);
  assert.equal(submitCount, 1);
}

{
  const wrongEvents = [
    { label: 'removed log', log: { ...createdLog, removed: true } },
    {
      label: 'invoice ID',
      log: { ...createdLog, topics: encodeEventTopics({ abi, eventName: 'InvoiceCreated', args: { invoiceId: `0x${'cd'.repeat(32)}`, merchant } }) },
    },
    {
      label: 'merchant',
      log: { ...createdLog, topics: encodeEventTopics({ abi, eventName: 'InvoiceCreated', args: { invoiceId, merchant: '0x1111111111111111111111111111111111111111' } }) },
    },
    {
      label: 'amount',
      log: { ...createdLog, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [amount + 1n, expiresAt]) },
    },
  ];
  for (const { label, log } of wrongEvents) {
    const result = await reconcileInvoiceCreationAttempt({
      expected,
      transactionHash: hash,
      readChainId: async () => chainId,
      readReceipt: async () => ({ ...successfulReceipt, logs: [log] }),
      readTransaction: async () => transaction,
    });
    assert.equal(result.status, 'unmatched', `A receipt with a mismatched InvoiceCreated ${label} never marks the invoice successful.`);
  }
}

{
  let transactionReads = 0;
  const reconcile = () => reconcileInvoiceCreationAttempt({
    expected,
    transactionHash: hash,
    readChainId: async () => chainId,
    readReceipt: async () => successfulReceipt,
    readTransaction: async () => (++transactionReads < 3 ? null : transaction),
  });
  const initialResult = await reconcile();
  assert.equal(initialResult.status, 'pending', 'A receipt alone remains pending while the RPC transaction lookup lags.');
  const delayed = await pollInvoiceCreationReconciliation({
    initialResult,
    reconcile,
    intervalMs: 0,
    maxAttempts: 5,
    sleep: async () => {},
  });
  assert.equal(delayed.status, 'created', 'A successful exact receipt/event is accepted once its matching transaction becomes visible.');
  assert.equal(transactionReads, 3);
}

{
  let submitCount = 0;
  let readCount = 0;
  const delayed = await pollInvoiceCreationReconciliation({
    initialResult: { status: 'pending', transactionHash: hash, ambiguous: true },
    reconcile: async () => {
      readCount += 1;
      return readCount < 3
        ? { status: 'pending', transactionHash: hash, ambiguous: true }
        : { status: 'created', transactionHash: hash };
    },
    intervalMs: 0,
    maxAttempts: 5,
    sleep: async () => {},
  });
  assert.equal(delayed.status, 'created', 'Read-only polling recognizes a receipt that becomes visible later without a page refresh.');
  assert.equal(readCount, 3);
  assert.equal(submitCount, 0, 'Polling never calls a submit function.');
}

{
  let submitCount = 0;
  let waitCount = 0;
  const attempt = await submitInvoiceCreationOnce({
    submit: async () => {
      submitCount += 1;
      throw Object.assign(new Error('User rejected request'), { code: 4001 });
    },
    waitForReceipt: async () => { waitCount += 1; throw new Error('Must not wait without a hash.'); },
    reconcile: (args) => reconcileInvoiceCreationAttempt({ expected, ...args, ...readDeps }),
  });
  assert.equal(attempt.result.status, 'failed', 'A wallet rejection with no transaction hash is not confused with a confirmed invoice.');
  assert.equal(submitCount, 1);
  assert.equal(waitCount, 0);
}

{
  const runIfIdle = createPaymentSubmissionGate();
  let releaseFirst;
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  let submitCount = 0;
  const first = runIfIdle(async () => {
    submitCount += 1;
    await blocked;
  });
  const duplicate = await runIfIdle(async () => { submitCount += 1; });
  assert.equal(duplicate.started, false, 'A rapid second click is ignored while invoice creation is in flight.');
  assert.equal(submitCount, 1, 'Only one createInvoice operation begins.');
  releaseFirst();
  await first;
}

console.log('Invoice-creation mock tests passed. No wallet signing or network transaction was sent.');
