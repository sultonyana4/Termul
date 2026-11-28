import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { arcRpc } from './arc.js';
import { invoiceAbi } from './managed-preflight.js';
import { openPilotJournal, isUnresolved } from './pilot-journal.js';
import { recoverPilotHash } from './pilot-reconciliation.js';
import { TERMUL_MAINNET as network } from '../../supabase/functions/_shared/termul-mainnet.js';

const [wallet, hash] = process.argv.slice(2);
if (!/^0x[0-9a-f]{40}$/i.test(wallet ?? '') || !/^0x[0-9a-f]{64}$/i.test(hash ?? '')) {
  throw new Error('Supply the existing wallet address and Arc transaction hash.');
}
const path = fileURLToPath(new URL('./.env.pilot-journal/attempts.sqlite', import.meta.url));
const source = new DatabaseSync(path, { readOnly: true });
const snapshot = path + '.backup-' + Date.now();
try {
  if (source.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Journal integrity check failed.');
  await backup(source, snapshot);
  chmodSync(snapshot, 0o600);
} finally { source.close(); }
const journal = openPilotJournal(path);
try {
  const record = journal.latest(wallet);
  if (!isUnresolved(record)) throw new Error('There is no unresolved attempt for this wallet.');
  const evidence = await recoverPilotHash({
    arc: arcRpc, record, hash, readInvoice: (merchant, id, blockNumber) => arcRpc.readContract({
      address: network.contractAddress, abi: invoiceAbi, functionName: 'getInvoice', args: [merchant, id], blockNumber,
    }),
  });
  if (evidence.status !== 'verified') throw new Error('The transaction does not prove the journaled attempt.');
  const saved = journal.update(record, evidence);
  if (saved?.status !== 'verified' || saved.transactionHash !== evidence.transactionHash) throw new Error('Journal changed during recovery.');
  console.log(JSON.stringify({ backup: snapshot, invoiceId: saved.invoiceId, ...evidence }));
} finally { journal.close(); }
