import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { decodeEventLog } from 'viem';
import { matchesInvoiceCreationTransaction } from '../../src/invoice-creation.js';
import { verifyPaymentReceipt, verifyRevertedPayment } from '../../src/payment-result.js';
import { invoiceAbi, verifyManagedDeployment } from './managed-preflight.js';
import { TERMUL_MAINNET as network } from '../../supabase/functions/_shared/termul-mainnet.js';

const address = /^[a-f0-9]{40}$/i;
const hash = /^0x[a-f0-9]{64}$/i;
const fail = (status, message) => { throw Object.assign(new Error(message), { status, localMetadata: true }); };
const clean = (value, maximum) => {
  if (typeof value !== 'string' || value.length > maximum) fail(400, 'Invalid invoice or profile details.');
  return value.trim();
};

export function openLocalMetadata(path, journal) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS profiles (address TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoices (merchant TEXT, id TEXT, details TEXT, PRIMARY KEY (merchant,id));
    CREATE TABLE IF NOT EXISTS external_payment_attempts (
      merchant TEXT, invoice_id TEXT, payer_address TEXT, attempt_id TEXT NOT NULL, tx_hash TEXT, updated_at TEXT,
      PRIMARY KEY (merchant,invoice_id,payer_address)
    );
    CREATE TABLE IF NOT EXISTS external_payment_resolutions (
      attempt_id TEXT PRIMARY KEY, tx_hash TEXT NOT NULL, resolved_at TEXT NOT NULL
    );
  `);
  const find = db.prepare('SELECT details FROM invoices WHERE merchant=? AND id=?');
  const externalAttempt = db.prepare('SELECT a.*, r.tx_hash AS verified_hash FROM external_payment_attempts a LEFT JOIN external_payment_resolutions r USING(attempt_id) WHERE merchant=? AND invoice_id=? AND payer_address=?');

  function scope(input) {
    if (input.chainId !== network.id || (typeof input.contractAddress !== 'string' || input.contractAddress.toLowerCase() !== network.contractAddress)
      || typeof input.merchantAddress !== 'string' || !input.merchantAddress.startsWith('0x')
      || !address.test(input.merchantAddress.slice(2))) fail(400, 'Invalid invoice scope.');
    return input.merchantAddress.toLowerCase();
  }
  function identifier(input) {
    if (typeof input.invoiceId !== 'string' || !hash.test(input.invoiceId)) fail(400, 'Invalid invoice identifier.');
    return input.invoiceId.toLowerCase();
  }

  function saveInvoice(input, merchant, id, expiry, txHash) {
    const invoice = {
      chain_id: network.id, contract_address: network.contractAddress, merchant_address: merchant, invoice_id: id,
      amount_native: input.amountNative, expires_at: new Date(Number(expiry) * 1000).toISOString(),
      create_tx_hash: txHash, client_name: clean(input.clientName, 120),
      client_email: clean(input.clientEmail, 254), description: clean(input.description, 1000), created_at: new Date().toISOString(),
    };
    db.prepare('INSERT OR IGNORE INTO invoices VALUES (?,?,?)').run(merchant, id, JSON.stringify(invoice));
    return { invoice: JSON.parse(find.get(merchant, id).details) };
  }

  async function saveExternal(input, merchant, id, arc) {
    const txHash = input.createTxHash;
    if (!hash.test(txHash ?? '') || !/^[1-9]\d{0,77}$/.test(input.amountNative ?? '') || !/^\d{1,12}$/.test(input.expiresAt ?? '')
      || BigInt(input.expiresAt) > 253402300799n) fail(400, 'Invalid invoice proof terms.');
    if ((await verifyManagedDeployment(arc)).status !== 'verified') fail(409, 'Cannot verify the Arc invoice deployment.');
    const [tx, receipt, finalized] = await Promise.all([arc.getTransaction({ hash: txHash }), arc.getTransactionReceipt({ hash: txHash }), arc.getBlock({ blockTag: 'finalized' })]);
    const block = await arc.getBlock({ blockNumber: receipt.blockNumber });
    const amount = BigInt(input.amountNative), expiresAt = BigInt(input.expiresAt);
    const matches = receipt.logs.filter(log => {
      try {
        const { args } = decodeEventLog({ abi: invoiceAbi, eventName: 'InvoiceCreated', topics: log.topics, data: log.data });
        return !log.removed && log.address.toLowerCase() === network.contractAddress && log.transactionHash === txHash
          && args.invoiceId === id && args.merchant.toLowerCase() === merchant && args.amount === amount && args.expiresAt === expiresAt;
      } catch { return false; }
    });
    if (!matchesInvoiceCreationTransaction(tx, { abi: invoiceAbi, merchant, invoiceId: id, amount, expiresAt, chainId: network.id, contract: network.contractAddress })
      || tx.hash !== txHash || receipt.transactionHash !== txHash || receipt.status !== 'success' || matches.length !== 1
      || receipt.blockNumber > finalized.number || tx.blockHash !== block.hash || receipt.blockHash !== block.hash
      || tx.blockNumber !== receipt.blockNumber || block.number !== receipt.blockNumber) fail(409, 'Missing finalized invoice creation proof.');
    return saveInvoice(input, merchant, id, input.expiresAt, txHash);
  }

  async function resolveExternalPayment(merchant, id, payer, attemptId, verifiedHash, arc) {
    const row = externalAttempt.get(merchant.toLowerCase(), id.toLowerCase(), payer.toLowerCase());
    if (row?.attempt_id !== attemptId || !hash.test(verifiedHash ?? '') || (row.tx_hash && row.tx_hash.toLowerCase() !== verifiedHash.toLowerCase())) {
      fail(409, 'The payment reservation does not match this receipt.');
    }
    if (row.verified_hash) return { ok: true };
    if ((await verifyManagedDeployment(arc)).status !== 'verified') fail(409, 'Cannot verify the Arc invoice deployment.');
    const read = blockNumber => arc.readContract({ address: network.contractAddress, abi: invoiceAbi, functionName: 'getInvoice',
      args: [merchant, id], ...(blockNumber !== undefined && { blockNumber }) });
    const state = await read();
    const proof = await verifyPaymentReceipt({ abi: invoiceAbi, merchant, invoiceId: id, payer, chainId: network.id,
      contract: network.contractAddress, amount: state.amount }, {
      readReceipt: tx => arc.getTransactionReceipt({ hash: tx }), readTransaction: tx => arc.getTransaction({ hash: tx }),
      readBlock: blockNumber => arc.getBlock({ blockNumber }), readFinalizedBlock: () => arc.getBlock({ blockTag: 'finalized' }), readInvoiceAt: read,
    }, verifiedHash);
    if (!proof?.payerMatchesExpected) fail(409, 'Could not verify a finalized payment for this reservation.');
    const result = db.prepare(`INSERT OR IGNORE INTO external_payment_resolutions
      SELECT attempt_id, ?, ? FROM external_payment_attempts
      WHERE merchant=? AND invoice_id=? AND payer_address=? AND attempt_id=? AND (tx_hash IS NULL OR lower(tx_hash)=lower(?))`).run(
      verifiedHash, new Date().toISOString(), merchant.toLowerCase(), id.toLowerCase(), payer.toLowerCase(), attemptId, verifiedHash);
    if (!result.changes && !externalAttempt.get(merchant.toLowerCase(), id.toLowerCase(), payer.toLowerCase())?.verified_hash) fail(409, 'The payment reservation changed during receipt verification.');
    return { ok: true };
  }

  async function clearExternalPayment(keys, input, arc) {
    const [merchant, id, payer] = keys;
    const row = externalAttempt.get(...keys);
    if (row?.attempt_id !== input.attemptId || row.verified_hash) return { ok: true };
    if (input.verifiedHash) return resolveExternalPayment(...keys, input.attemptId, input.verifiedHash, arc);
    if (row.tx_hash) {
      if (input.revertedHash !== row.tx_hash || (await verifyManagedDeployment(arc)).status !== 'verified') fail(409, 'The submitted payment still requires receipt verification.');
      const state = await arc.readContract({ address: network.contractAddress, abi: invoiceAbi, functionName: 'getInvoice', args: [merchant, id] });
      if (!await verifyRevertedPayment({ abi: invoiceAbi, merchant, invoiceId: id, payer, chainId: network.id,
        contract: network.contractAddress, amount: state.amount }, {
        readReceipt: tx => arc.getTransactionReceipt({ hash: tx }), readTransaction: tx => arc.getTransaction({ hash: tx }),
        readBlock: blockNumber => arc.getBlock({ blockNumber }), readFinalizedBlock: () => arc.getBlock({ blockTag: 'finalized' }),
      }, row.tx_hash)) fail(409, 'The submitted payment still requires receipt verification.');
    }
    db.prepare(`DELETE FROM external_payment_attempts WHERE merchant=? AND invoice_id=? AND payer_address=? AND attempt_id=? AND tx_hash IS ?
      AND NOT EXISTS (SELECT 1 FROM external_payment_resolutions WHERE attempt_id=external_payment_attempts.attempt_id)`).run(...keys, input.attemptId, row.tx_hash);
    return { ok: true };
  }

  return {
    close: () => db.close(),
    resolveExternalPayment,
    publicInvoice(input) {
      const row = find.get(scope(input), identifier(input));
      const invoice = row && JSON.parse(row.details);
      return { invoice: invoice ? { clientName: invoice.client_name, description: invoice.description } : null };
    },
    request(wallet, input, { external = false, arc } = {}) {
      const payer = wallet.address.toLowerCase();
      const action = input.metadataAction;
      if (action === 'get_profile') {
        const profile = db.prepare('SELECT name AS display_name FROM profiles WHERE address=?').get(payer);
        return { profile: profile ?? null };
      }
      if (action === 'save_profile') {
        const display_name = clean(input.displayName, 40);
        if (!display_name) fail(400, 'Enter a display name.');
        db.prepare('INSERT OR REPLACE INTO profiles VALUES (?,?)').run(payer, display_name);
        return { profile: { display_name } };
      }
      const merchant = scope(input);
      if (action === 'get_invoices' || action === 'save_invoice') {
        if (merchant !== payer) fail(403, 'This wallet does not own the merchant namespace.');
        if (action === 'get_invoices') return { invoices: db.prepare(
          'SELECT details FROM invoices WHERE merchant=? ORDER BY rowid DESC LIMIT 200',
        ).all(merchant).map(row => JSON.parse(row.details)) };
        const id = identifier(input);
        if (external) return saveExternal(input, merchant, id, arc);
        const proof = journal?.byInvoice(id, payer);
        if (proof?.status !== 'verified' || proof.kind === 'payment' || proof.transactionHash !== input.createTxHash
          || String(proof.amountBase ?? '10000000000000000') !== input.amountNative
          || proof.expiresAt !== input.expiresAt) fail(409, 'The journal lacks matching Arc invoice proof.');
        return saveInvoice(input, merchant, id, proof.expiresAt, proof.transactionHash);
      }
      const id = identifier(input);
      if (external) {
        const keys = [merchant, id, payer];
        if (action === 'get_payment_attempt') {
          const row = externalAttempt.get(...keys);
          return row?.verified_hash ? { attempt: null, settled: { tx_hash: row.verified_hash } } : { attempt: row ?? null };
        }
        if (action === 'reserve_payment_attempt') {
          const attemptId = randomUUID();
          if (!db.prepare('INSERT OR IGNORE INTO external_payment_attempts VALUES (?,?,?,?,NULL,?)').run(...keys, attemptId, new Date().toISOString()).changes) fail(409, 'An existing payment requires reconciliation.');
          return { attemptId };
        }
        if (action === 'save_payment_attempt' && hash.test(input.transactionHash ?? '') && typeof input.attemptId === 'string') {
          db.prepare(`UPDATE external_payment_attempts SET tx_hash=?, updated_at=? WHERE merchant=? AND invoice_id=? AND payer_address=? AND attempt_id=?
            AND (tx_hash IS NULL OR lower(tx_hash)=lower(?))`)
            .run(input.transactionHash, new Date().toISOString(), ...keys, input.attemptId, input.transactionHash);
          return { ok: true };
        }
        if (action === 'clear_payment_attempt' && typeof input.attemptId === 'string') {
          return clearExternalPayment(keys, input, arc);
        }
      }
      const pending = journal?.paymentAttempt(merchant, id, payer, { includeVerified: true });
      if (action === 'get_payment_attempt') return pending?.status === 'verified'
        ? { attempt: null, settled: { tx_hash: pending.transactionHash } } : { attempt: pending ? {
        payer_address: payer, attempt_id: pending.attemptId, tx_hash: pending.transactionHash,
        updated_at: pending.createdAt,
      } : null };
      if (action === 'clear_payment_attempt' && (!pending || pending.status === 'verified')) return { ok: true };
      fail(400, 'Unsupported metadata operation.');
    },
  };
}
