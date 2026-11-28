import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, numberToHex } from 'viem';
import { TERMUL_MAINNET as n } from '../../supabase/functions/_shared/termul-mainnet.js';
import { invoiceAbi as abi } from './managed-preflight.js';
import { openArcIndex } from './arc-index.js';

const merchant = '0x' + 'aa'.repeat(20);
const payer = '0x' + 'bb'.repeat(20);
const invoiceId = '0x' + '11'.repeat(32);
const blockHash = '0x' + '22'.repeat(32);
const creation = '0x' + '33'.repeat(32);
const payment = '0x' + '44'.repeat(32);
const amount = 10n ** 17n;
const log = (paid, height) => ({ address: n.contractAddress, transactionHash: paid ? payment : creation, blockNumber: numberToHex(height),
  blockHash, removed: false, transactionIndex: paid ? '0x1' : '0x0', logIndex: paid ? '0x1' : '0x0',
  topics: encodeEventTopics({ abi, eventName: paid ? 'InvoicePaid' : 'InvoiceCreated', args: { invoiceId, merchant, ...(paid && { payer }) } }),
  data: paid ? encodeAbiParameters([{ type: 'uint256' }], [amount])
    : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [amount, 0n]),
});

const makeFixture = (height, pages, { badReceipt = () => false, countArchive = () => {} } = {}) => {
  const runtime = '0x12';
  const network = { ...n, runtimeHash: keccak256(runtime) };
  const client = () => ({
    getChainId: async () => 5042,
    getCode: async ({ blockNumber }) => {
      if (blockNumber !== undefined) countArchive();
      return blockNumber === n.deploymentBlock - 1n ? undefined : runtime;
    },
    getBlock: async () => ({ number: height, hash: blockHash, timestamp: 1790000000n }),
    request: async ({ method, params: [{ fromBlock, toBlock }] }) => {
      assert.equal(method, 'eth_getLogs');
      pages.push([BigInt(fromBlock), BigInt(toBlock)]);
      return BigInt(fromBlock) <= height && height <= BigInt(toBlock) ? [log(true, height), log(false, height), log(false, height)] : [];
    },
    getTransaction: async ({ hash }) => ({ hash, chainId: 5042, blockNumber: height, blockHash, to: n.contractAddress,
      from: hash === payment ? payer : merchant, value: hash === payment ? amount : 0n,
      input: encodeFunctionData({ abi, functionName: hash === payment ? 'payInvoice' : 'createInvoice',
        args: hash === payment ? [merchant, invoiceId] : [invoiceId, amount, 0n] }) }),
    getTransactionReceipt: async ({ hash }) => ({ transactionHash: hash, blockNumber: height, blockHash,
      status: badReceipt() && hash === payment ? 'reverted' : 'success',
      logs: [{ ...log(hash === payment, height), blockNumber: height, logIndex: hash === payment ? 1 : 0 }] }),
    readContract: async () => ({ merchant, amount, expiresAt: 0n, status: 2 }),
  });
  return { network, client };
};

test('Arc index commits verified canonical records atomically and restores settled history across reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-index-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'index.sqlite');
  let badReceipt = true;
  let archiveReads = 0;
  const height = n.deploymentBlock;
  const { network, client } = makeFixture(height, [], { badReceipt: () => badReceipt, countArchive: () => archiveReads++ });
  let index = openArcIndex(path, client(), { network });
  await index.sync();
  assert.equal(index.snapshot(merchant).status, 'unavailable');
  assert.equal(index.snapshot(merchant).throughBlock, Number(height) - 1);
  assert.deepEqual(index.snapshot(merchant).invoices, []);
  index.close();
  badReceipt = false;
  index = openArcIndex(path, client(), { network });
  await index.sync();
  assert.equal(index.snapshot(merchant).status, 'current');
  assert.equal(index.snapshot(merchant).invoices[0].paymentTxHash, payment);
  assert.deepEqual(index.snapshot(payer).invoices, []);
  index.close();
  index = openArcIndex(path, client(), { network });
  assert.equal(index.snapshot(merchant).status, 'stale');
  assert.equal(index.snapshot(merchant).invoices[0].amount, '0.1');
  assert.equal(archiveReads, 2);
  index.close();
});

test('recent evidence survives restart and later joins the contiguous checkpoint without a duplicate read', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-tail-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'index.sqlite');
  const height = n.deploymentBlock + 30_000n;
  const pages = [];
  const { network, client } = makeFixture(height, pages);
  let index = openArcIndex(path, client(), { network });
  await index.sync(2);
  const partial = index.snapshot(merchant);
  assert.equal(partial.status, 'indexing');
  assert.equal(partial.invoices[0].paymentTxHash, payment);
  assert.ok(BigInt(partial.throughBlock) < height);
  assert.deepEqual(pages[0], [height - 9998n, height]);
  index.close();
  index = openArcIndex(path, client(), { network });
  assert.equal(index.snapshot(merchant).status, 'stale');
  assert.equal(index.get(merchant, invoiceId).paymentTxHash, payment);
  await index.sync();
  const complete = index.snapshot(merchant);
  assert.equal(complete.status, 'current');
  assert.equal(complete.invoices.length, 1);
  assert.equal(complete.invoices[0].createdBlockTime, complete.invoices[0].paidBlockTime);
  assert.equal(pages.filter(([, to]) => to === height).length, 1);
  index.close();
});
