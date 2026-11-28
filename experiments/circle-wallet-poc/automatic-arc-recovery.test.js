import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticArcRecovery } from './automatic-arc-recovery.js';
const hash = '0x' + 'ab'.repeat(32);
const merchant = '0x' + '12'.repeat(20);
const record = { kind: 'app-creation', chainId: 5042, invoiceId: '0x'+'34'.repeat(32), walletAddress: merchant, amountBase: '10', expiresAt: '999', createdAt: '2026-11-24T13:00:00Z' };
const network = { id: 5042 };
const proof = {status:'verified',transactionHash:hash,verificationSource:'arc-hash'};
function fixture(overrides = {}) {
  const calls = [];
  const input = { arc:{getLogs(){}}, record, network, event:{name:'InvoiceCreated'},
    readInvoice: async () => ({status:1,merchant,amount:10n,expiresAt:999n}),
    search: async args => {calls.push(args);return {hashes:[hash]};},
    verify: async args => {assert.equal(args.record, input.record);assert.equal(args.hash,hash);return proof;}, ...overrides };
  return {input,calls};
}
test('Arc proof recovers a pending creation without Circle or any submission', async () => {
 const {input,calls}=fixture(); assert.deepEqual(await automaticArcRecovery(input),proof);assert.equal(calls.length,1);assert.equal(calls[0].maxPages,1);
});
test('old invoice falls back to bounded timestamp search', async () => {
 const {input}=fixture();const calls=[];input.search=async a=>{calls.push(a);return calls.length===1?{hashes:[],exhausted:false}:{hashes:[hash]};};
 assert.deepEqual(await automaticArcRecovery(input),proof);assert.equal(calls[1].oldestFirst,true);assert.equal(calls[1].maxPages,3);
});
test('no event or multiple candidates never produce success', async () => {
 for (const hashes of [[],[hash,'0x'+'cd'.repeat(32)]]) {const {input}=fixture({search:async()=>({hashes,exhausted:true}),verify:async()=>{throw new Error('must not verify');}});assert.equal(await automaticArcRecovery(input),null);}
});
test('wrong state, amount, merchant, expiry or chain skip event search', async () => {
 for (const fields of [{status:0},{amount:11n},{merchant:'0x'+'ff'.repeat(20)},{expiresAt:998n}]) {const {input,calls}=fixture({readInvoice:async()=>({status:1,merchant,amount:10n,expiresAt:999n,...fields})});assert.equal(await automaticArcRecovery(input),null);assert.equal(calls.length,0);}
 const {input,calls}=fixture({record:{...record,chainId:1}});assert.equal(await automaticArcRecovery(input),null);assert.equal(calls.length,0);
});
test('verification failures and RPC outages remain unresolved', async () => {
 for(const overrides of [{verify:async()=>({status:'verification-failed'})},{verify:async()=>{throw new Error('RPC error');}},{search:async()=>{throw new Error('RPC error');}},{verify:async()=>({...proof,transactionHash:'0x'+'cd'.repeat(32)})}])assert.equal(await automaticArcRecovery(fixture(overrides).input),null);
});
test('payment only accepts paid state and exact payer event search',async()=>{
 const payment={...record,kind:'payment',merchant,walletAddress:'0x'+'56'.repeat(20)};
 const {input,calls}=fixture({record:payment,event:{name:'InvoicePaid'}});assert.equal(await automaticArcRecovery(input),null);assert.equal(calls.length,0);
 input.readInvoice=async()=>({status:2,merchant,amount:10n,expiresAt:999n});assert.deepEqual(await automaticArcRecovery(input),proof);assert.equal(calls[0].record.walletAddress,payment.walletAddress);
});
test('existing transaction hash stays with original verification route',async()=>{
 const {input,calls}=fixture({record:{...record,transactionHash:hash}});assert.equal(await automaticArcRecovery(input),null);assert.equal(calls.length,0);
});
