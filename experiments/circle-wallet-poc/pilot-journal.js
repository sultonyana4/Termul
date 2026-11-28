import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { terminal } from './managed-status.js';
export { isUnresolved } from './managed-status.js';

export function openPilotJournal(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS pilot_attempt (
      invoice_id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      resolved INTEGER NOT NULL,
      details TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_unresolved_pilot_per_wallet
      ON pilot_attempt(wallet) WHERE resolved = 0;
  `);
  const latest = db.prepare(`SELECT details FROM pilot_attempt WHERE wallet = ?
    AND (? IS NULL OR (COALESCE(json_extract(details, '$.kind'), '') = 'arc-swap') = ?)
    ORDER BY resolved ASC, rowid DESC LIMIT 1`);
  const reserve = db.prepare(`INSERT OR IGNORE INTO pilot_attempt
    SELECT ?, ?, 0, ? WHERE NOT EXISTS (
      SELECT 1 FROM pilot_attempt WHERE (resolved = 0 OR json_extract(details, '$.status') = 'verified')
        AND json_extract(details, '$.paymentKey') = ?
    )`);
  const read = db.prepare('SELECT details FROM pilot_attempt WHERE invoice_id = ?');
  const write = db.prepare('UPDATE pilot_attempt SET resolved = ?, details = ? WHERE invoice_id = ? AND details = ?');

  return {
    latest(address, scope = null) {
      const isSwap = scope === null ? null : Number(scope === 'swap');
      const row = latest.get(address.toLowerCase(), isSwap, isSwap);
      return row ? JSON.parse(row.details) : null;
    },
    history(address) {
      return db.prepare(`SELECT details FROM pilot_attempt WHERE wallet = ? ORDER BY rowid DESC LIMIT 30`)
        .all(address.toLowerCase()).map(row => JSON.parse(row.details));
    },
    paymentAttempt(merchant, invoiceId, wallet, { includeVerified = false } = {}) {
      const row = db.prepare(`SELECT details FROM pilot_attempt WHERE wallet=?
        AND (resolved=0 OR (?=1 AND json_extract(details, '$.status')='verified'))
        AND json_extract(details, '$.paymentKey')=? ORDER BY resolved, rowid DESC LIMIT 1`)
        .get(wallet.toLowerCase(), Number(includeVerified), merchant.toLowerCase() + ':' + invoiceId.toLowerCase());
      return row ? JSON.parse(row.details) : null;
    },
    byInvoice(invoiceId, wallet) {
      const row = read.get(invoiceId);
      const record = row && JSON.parse(row.details);
      return record?.walletAddress.toLowerCase() === wallet.toLowerCase() ? record : null;
    },
    reserve(record) {
      return reserve.run(record.attemptId ?? record.invoiceId, record.walletAddress.toLowerCase(), JSON.stringify(record), record.paymentKey ?? null).changes === 1;
    },
    update(record, fields) {
      const current = read.get(record.attemptId ?? record.invoiceId);
      const stored = current && JSON.parse(current.details);
      if (!stored || terminal.has(stored.status)) return stored;
      // Preserve newer evidence if an asynchronous reader raced another process.
      if (current.details !== JSON.stringify(record)) return stored;
      const next = { ...stored, ...fields };
      const result = write.run(Number(terminal.has(next.status)), JSON.stringify(next), record.attemptId ?? record.invoiceId, current.details);
      if (result.changes === 1) return next;
      return JSON.parse(read.get(record.attemptId ?? record.invoiceId).details);
    },
    close: () => db.close(),
  };
}
