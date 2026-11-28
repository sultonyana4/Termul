// READ ONLY: never creates a challenge, broadcasts, changes the journal, or reads .env.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import { invoiceAbi } from './managed-preflight.js';
import { recoverPilotHash } from './pilot-reconciliation.js';
import { findInvoiceEvidence } from './find-invoice-evidence.js';
import { TERMUL_MAINNET as network } from '../../supabase/functions/_shared/termul-mainnet.js';
const path = fileURLToPath(new URL('./.env.pilot-journal/attempts.sqlite', import.meta.url));
if (!existsSync(path)) throw new Error('Existing journal not found. No file was created.');
const db = new DatabaseSync(path, { readOnly: true });
let rows;
try {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Journal integrity check failed.');
  rows = db.prepare('SELECT details FROM pilot_attempt WHERE resolved=0 ORDER BY rowid DESC').all().map(row => JSON.parse(row.details));
} finally { db.close(); }
const arc = createPublicClient({ transport: http(network.rpcUrl, { timeout: 10000, retryCount: 0,
  methods: { include: ['eth_chainId','eth_getCode','eth_getBlockByNumber','eth_getLogs','eth_getTransactionByHash','eth_getTransactionReceipt','eth_call'] } }) });
if (await arc.getChainId() !== network.id) throw new Error('Wrong Arc chain.');
console.log(JSON.stringify({ unresolved: rows.length, mode: 'read-only', chainId: network.id }));
for (const record of rows) {
  const context = { walletAddress: record.walletAddress, invoiceId: record.invoiceId, kind: record.kind, journalStatus: record.status };
  try {
    const event = invoiceAbi.find(item => item.type === 'event' && item.name === (record.kind === 'payment' ? 'InvoicePaid' : 'InvoiceCreated'));
    const search = record.transactionHash ? { hashes: [record.transactionHash], pages: 0 } : await findInvoiceEvidence({ arc, record, network, event });
    if (search.hashes.length !== 1) { console.log(JSON.stringify({ ...context, result: search.hashes.length ? 'ambiguous' : 'not-found-in-search', pages: search.pages, exhausted: search.exhausted })); continue; }
    const proof = await recoverPilotHash({ arc, record, hash: search.hashes[0], network,
      readInvoice: (merchant, id, blockNumber) => arc.readContract({ address: network.contractAddress, abi: invoiceAbi, functionName: 'getInvoice', args: [merchant, id], ...(blockNumber === undefined ? {} : { blockNumber }) }) });
    console.log(JSON.stringify({ ...context, candidateHash: search.hashes[0], proof, pages: search.pages }));
  } catch (error) { console.log(JSON.stringify({ ...context, result: 'unverified', errorType: error?.name ?? 'Error' })); }
}
