import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeEventLog, decodeFunctionData, formatLog, formatUnits, numberToHex, parseAbi, toEventSelector } from 'viem';
import { TERMUL_MAINNET } from '../../supabase/functions/_shared/termul-mainnet.js';
import { arcReadFailure, deploymentKey, readArc, setArcDeploymentStore } from '../../src/arc-read.js';
import { invoiceAbi, verifyManagedDeployment } from './managed-preflight.js';

const abi = [...invoiceAbi, ...parseAbi([
  'function cancelInvoice(address merchant, bytes32 invoiceId)',
  'event InvoiceCancelled(bytes32 indexed invoiceId, address indexed merchant)',
])];
const events = abi.filter(item => item.type === 'event');
const topics = events.map(toEventSelector);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const stamp = value => new Date(Number(value) * 1000).toISOString();

export function openArcIndex(path, arc, { criticalClient = arc, network = TERMUL_MAINNET } = {}) {
  const identity = deploymentKey(network);
  const start = Number(network.deploymentBlock);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS deployment_proofs (identity TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS index_state (identity TEXT PRIMARY KEY, next_block INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS index_tail (
      identity TEXT PRIMARY KEY, from_block INTEGER NOT NULL, to_block INTEGER NOT NULL, details TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoice_history (
      identity TEXT NOT NULL, merchant TEXT NOT NULL, invoice_id TEXT NOT NULL,
      block_number INTEGER NOT NULL, details TEXT NOT NULL, PRIMARY KEY (identity,merchant,invoice_id)
    );
  `);
  const store = {
    hasDeployment: key => Boolean(db.prepare('SELECT 1 FROM deployment_proofs WHERE identity=?').get(key)),
    saveDeployment: key => db.prepare('INSERT OR IGNORE INTO deployment_proofs VALUES (?)').run(key),
  };
  setArcDeploymentStore(arc, store);
  setArcDeploymentStore(criticalClient, store);
  db.prepare('INSERT OR IGNORE INTO index_state VALUES (?,?)').run(identity, start);
  const cursor = () => db.prepare('SELECT next_block FROM index_state WHERE identity=?').get(identity).next_block;
  const find = db.prepare('SELECT details FROM invoice_history WHERE identity=? AND merchant=? AND invoice_id=?');
  const cached = (merchant, id) => JSON.parse(find.get(identity, merchant, id)?.details ?? 'null');
  const tail = () => db.prepare('SELECT * FROM index_tail WHERE identity=?').get(identity);
  const recentEvents = (recent, next) => recent ? JSON.parse(recent.details).filter(event => event.block >= next) : [];
  const get = (merchant, id) => recentEvents(tail(), cursor())
    .filter(event => event.merchant === merchant && event.invoiceId === id)
    .reduce(applyEvidence, cached(merchant, id));
  let target, targetAt = 0, pending, issue, afterError = 0, range = 9999;
  const endpointError = error => arcReadFailure(error) === 'rate-limit' || /rate-limiting/.test(error?.message)
    ? 'rate-limited' : 'unavailable';
  const read = request => readArc(request, { delay: 1200 });

  async function proof(log) {
    const { eventName, args } = decodeEventLog({ abi: events, data: log.data, topics: log.topics, strict: true });
    const { invoiceId, merchant } = args;
    const hash = log.transactionHash;
    const tx = await read(() => arc.getTransaction({ hash }));
    const receipt = await read(() => arc.getTransactionReceipt({ hash }));
    const block = await read(() => arc.getBlock({ blockNumber: log.blockNumber }));
    const { functionName, args: input } = decodeFunctionData({ abi, data: tx.input });
    const kind = eventName === 'InvoiceCreated' ? 'create' : eventName === 'InvoicePaid' ? 'pay' : 'cancel';
    const expectedFn = kind === 'create' ? 'createInvoice' : kind === 'pay' ? 'payInvoice' : 'cancelInvoice';
    const identityMatches = kind === 'create' ? same(tx.from, merchant) && input[0] === invoiceId &&
      input[1] === args.amount && input[2] === args.expiresAt : same(input[0], merchant) && input[1] === invoiceId
        && same(tx.from, kind === 'pay' ? args.payer : merchant);
    if (!same(log.address, network.contractAddress) || log.removed || functionName !== expectedFn || !identityMatches
      || tx.hash !== hash || tx.chainId !== network.id || !same(tx.to, network.contractAddress)
      || tx.value !== (kind === 'pay' ? args.amount : 0n) || tx.blockNumber !== log.blockNumber
      || tx.blockHash !== log.blockHash || receipt.blockHash !== log.blockHash || receipt.blockNumber !== log.blockNumber
      || block.number !== log.blockNumber || block.hash !== log.blockHash || receipt.status !== 'success'
      || receipt.transactionHash !== hash || !receipt.logs.some(item => !item.removed && item.transactionHash === hash
        && same(item.address, log.address) && item.logIndex === log.logIndex && item.data === log.data && item.topics.join() === log.topics.join())) {
      throw new Error('Arc history receipt does not match its finalized transaction.');
    }
    const state = await read(() => arc.readContract({ address: network.contractAddress, abi, functionName: 'getInvoice',
      args: [merchant, invoiceId], blockNumber: log.blockNumber }));
    if (!same(state.merchant, merchant) || state.amount <= 0n
      || (kind === 'create' && (state.amount !== args.amount || state.expiresAt !== args.expiresAt || ![1, 2, 3].includes(state.status)))
      || (kind === 'pay' && (state.status !== 2 || state.amount !== args.amount)) || (kind === 'cancel' && state.status !== 3)) {
      throw new Error('Finalized Arc invoice state does not match the event.');
    }
    return { kind, merchant: merchant.toLowerCase(), invoiceId, hash, block: Number(log.blockNumber),
      amountBase: String(state.amount), expiresAt: String(state.expiresAt), at: stamp(block.timestamp), payer: args.payer };
  }

  function applyEvidence(row, event) {
    const { kind, merchant, invoiceId, amountBase, expiresAt, at, hash, payer } = event;
    const base = row ?? { invoiceId, merchant, amountBase, expiresAt, createdAt: null };
    if (kind === 'create') return { ...base, state: 'open', createdAt: at, createTxHash: hash };
    if (kind === 'pay') return { ...base, state: 'paid', paidAt: at, paymentTxHash: hash, payer };
    return { ...base, state: 'cancelled' };
  }

  async function readEvidence(from, to) {
    const raw = await read(() => arc.request({ method: 'eth_getLogs', params: [{
      address: network.contractAddress, topics: [topics], fromBlock: numberToHex(from), toBlock: numberToHex(to),
    }] }));
    const seen = new Set();
    const records = [];
    const logs = raw.map(item => formatLog(item)).sort((a,b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
    for (const log of logs) {
      if (log.blockNumber < BigInt(from) || log.blockNumber > BigInt(to) || !Number.isSafeInteger(log.logIndex)) throw new Error('Unexpected Arc log range.');
      const key = [log.blockHash, log.transactionHash, log.logIndex].join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(await proof(log));
    }
    return records;
  }

  function commit(from, to, records) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (cursor() === from) {
        for (const event of records) {
          const { kind, merchant, invoiceId, block, amountBase, expiresAt } = event;
          const row = cached(merchant, invoiceId);
          if (kind === 'create' ? row !== null : !row || row.state !== 'open' || row.amountBase !== amountBase || row.expiresAt !== expiresAt) {
            throw new Error('Arc invoice events are inconsistent with the indexed history.');
          }
          const detail = applyEvidence(row, event);
          db.prepare('INSERT OR REPLACE INTO invoice_history VALUES (?,?,?,?,?)').run(identity, merchant, invoiceId, block, JSON.stringify(detail));
        }
        db.prepare('UPDATE index_state SET next_block=? WHERE identity=?').run(to + 1, identity);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  async function sync(pages = 6) {
    if (pending) return pending;
    if (afterError > Date.now() || (target !== undefined && cursor() > target && Date.now() - targetAt < 10_000)) return;
    pending = (async () => {
      try {
        if ((await verifyManagedDeployment(arc, network)).status !== 'verified') throw new Error('Arc deployment verification failed.');
        const head = await read(() => arc.getBlock({ blockTag: 'finalized' }));
        if (typeof head.number !== 'bigint' || head.number < network.deploymentBlock) throw new Error('Invalid finalized Arc head.');
        target = Number(head.number); targetAt = Date.now();
        for (let step = 0; step < pages && cursor() <= target;) {
          const from = cursor();
          const recent = tail();
          try {
            if ((!recent || from > recent.to_block) && target - from + 1 > range * 2 && step < pages - 1) {
              const recentStart = target - range + 1;
              const records = await readEvidence(recentStart, target);
              db.prepare('INSERT OR REPLACE INTO index_tail VALUES (?,?,?,?)').run(identity, recentStart, target, JSON.stringify(records));
            } else if (recent && from >= recent.from_block && from <= recent.to_block) {
              // All events in the staged interval already have canonical receipts.
              const to = Math.min(recent.to_block, target);
              commit(from, to, recentEvents(recent, from).filter(event => event.block <= to));
            } else {
              const beforeTail = recent && from < recent.from_block ? recent.from_block - 1 : target;
              const to = Math.min(from + range - 1, target, beforeTail);
              commit(from, to, await readEvidence(from, to));
            }
            step++;
          } catch (error) {
            if (arcReadFailure(error) !== 'range' || range < 2) throw error;
            range = Math.floor(range / 2);
          }
        }
        issue = undefined;
      } catch (error) { issue = endpointError(error); afterError = Date.now() + 8000; }
    })();
    try { await pending; } finally { pending = null; }
  }

  function snapshot(merchant) {
    const next = cursor();
    const status = issue ? next === start ? 'unavailable' : 'stale'
      : target === undefined ? next === start ? 'indexing' : 'stale'
      : next <= target ? 'indexing' : 'current';
    const recent = tail();
    const owner = merchant.toLowerCase();
    const rows = new Map(db.prepare('SELECT details FROM invoice_history WHERE identity=? AND merchant=? ORDER BY block_number DESC')
      .all(identity, owner).map(({ details }) => { const row = JSON.parse(details); return [row.invoiceId, row]; }));
    for (const event of recentEvents(recent, next)) if (event.merchant === owner) rows.set(event.invoiceId, applyEvidence(rows.get(event.invoiceId), event));
    return { status, issue, throughBlock: next - 1, targetBlock: target, coverageStarted: next > start || Boolean(recent),
      ...(recent && next < recent.from_block && { recentFromBlock: recent.from_block, recentThroughBlock: recent.to_block }),
      invoices: [...rows.values()].sort((a,b) => (b.paidAt ?? b.createdAt ?? '').localeCompare(a.paidAt ?? a.createdAt ?? '')).map(row => {
          const expired = row.state === 'open' && row.expiresAt !== '0' && BigInt(row.expiresAt) <= BigInt(Math.floor(Date.now() / 1000));
          return { ...row, amount: formatUnits(BigInt(row.amountBase), 18), status: expired ? 'expired' : row.state,
            createdBlockTime: row.createdAt, paidBlockTime: row.paidAt,
            due: row.expiresAt === '0' || BigInt(row.expiresAt) > 253402300799n ? '' : stamp(row.expiresAt).slice(0, 10),
            id: 'INV-' + row.invoiceId.slice(2, 10).toUpperCase(), name: 'On-chain invoice', description: 'On-chain invoice',
            initials: 'AP', onchainVerified: true,
            ...(row.createTxHash && { explorerUrl: network.explorerUrl + '/tx/' + row.createTxHash }),
            ...(row.paymentTxHash && { paymentExplorerUrl: network.explorerUrl + '/tx/' + row.paymentTxHash }),
          };
        }),
    };
  }

  return { sync, snapshot, get, close: () => db.close() };
}
