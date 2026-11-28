import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const key = identity => createHash('sha256').update(identity).digest('hex');

export function openInitializationStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS circle_initialization (
      owner TEXT PRIMARY KEY, details TEXT NOT NULL
    );`);
  const get = db.prepare('SELECT details FROM circle_initialization WHERE owner=?');
  const reserve = db.prepare('INSERT OR IGNORE INTO circle_initialization VALUES (?,?)');
  const replace = db.prepare('UPDATE circle_initialization SET details=? WHERE owner=? AND details=?');

  function read(identity) {
    const row = get.get(key(identity));
    return row ? JSON.parse(row.details) : undefined;
  }

  return {
    get: read,
    claim(identity, previous, request) {
      const owner = key(identity);
      const details = JSON.stringify(request);
      if (previous) replace.run(details, owner, JSON.stringify(previous));
      else reserve.run(owner, details);
      return read(identity);
    },
    save(identity, previous, request) {
      return replace.run(JSON.stringify(request), key(identity), JSON.stringify(previous)).changes === 1;
    },
    close() { db.close(); },
  };
}
