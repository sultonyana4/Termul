import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInvoiceEvidence } from './find-invoice-evidence.js';
const hash = '0x' + 'ab'.repeat(32);
const record = { invoiceId: '0x' + 'cd'.repeat(32), walletAddress: '0x' + '12'.repeat(20) };
const network = { deploymentBlock: 1n, contractAddress: '0x' + '34'.repeat(20) };
const event = { name: 'InvoiceCreated' };
function fake(logs) {
  const calls = [];
  return { calls, getBlock: async ({blockNumber = 100n}) => ({number:blockNumber, timestamp: blockNumber * 10n}), getLogs: async request => { calls.push(request); return logs(request); } };
}
test('search uses exact indexed invoice and merchant, scans backward, deduplicates logs', async () => {
  const arc = fake(q => q.fromBlock <= 85n && q.toBlock >= 85n ? [{transactionHash:hash},{transactionHash:hash},{removed:true, transactionHash:'0x'+'ef'.repeat(32)}] : []);
  const result = await findInvoiceEvidence({arc,record,network,event,pageSize:10n});
  assert.deepEqual(result.hashes,[hash]); assert.equal(result.pages,2);
  assert.deepEqual(arc.calls[0].args,{invoiceId:record.invoiceId,merchant:record.walletAddress});
  assert.equal(arc.calls[0].toBlock,100n); assert.equal(arc.calls[1].toBlock,90n);
});
test('payment filters exact payer and merchant; no result does not prove failure', async () => {
  const arc = fake(()=>[]); const merchant = '0x'+'56'.repeat(20);
  const result = await findInvoiceEvidence({arc,record:{...record,kind:'payment',merchant},network,event,pageSize:10n,maxPages:2});
  assert.deepEqual(arc.calls[0].args,{invoiceId:record.invoiceId,merchant,payer:record.walletAddress});
  assert.deepEqual(result,{hashes:[],pages:2,exhausted:false});
});
test('timestamp search retains five-minute margin', async () => {
  const arc = fake(()=>[]);
  const result = await findInvoiceEvidence({arc,record:{...record,createdAt:new Date(900000).toISOString()},network,event,pageSize:100n});
  assert.equal(arc.calls[0].fromBlock,60n); assert.equal(result.exhausted,true);
});
test('rejects invalid bounds and propagates RPC errors', async () => {
  const arc = fake(()=>{throw new Error('RPC unavailable');});
  await assert.rejects(findInvoiceEvidence({arc,record,network,event,pageSize:0n}),/budget/);
  await assert.rejects(findInvoiceEvidence({arc,record,network,event}),/RPC unavailable/);
});
test('oldest-first searches around original timestamp without walking back from current block', async () => {
 const arc=fake(q=>q.fromBlock<=65n&&q.toBlock>=65n?[{transactionHash:hash}]:[]);
 const result=await findInvoiceEvidence({arc,record:{...record,createdAt:new Date(900000).toISOString()},network,event,pageSize:10n,maxPages:2,oldestFirst:true});
 assert.deepEqual(result.hashes,[hash]);assert.equal(arc.calls[0].fromBlock,60n);assert.equal(arc.calls[0].toBlock,69n);
});
