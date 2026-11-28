import { findInvoiceEvidence } from './find-invoice-evidence.js';

// Only a verified receipt can resolve an existing attempt. No submission or journal writes here.
export async function automaticArcRecovery({ arc, record, network, event, readInvoice, verify, search = findInvoiceEvidence }) {
  if (record.transactionHash || record.chainId !== network.id || !['creation', 'app-creation', 'payment'].includes(record.kind)
    || typeof arc.getLogs !== 'function' || !event) return null;
  try {
    const payment = record.kind === 'payment';
    const merchant = payment ? record.merchant : record.walletAddress;
    const current = await readInvoice(merchant, record.invoiceId);
    if (!(payment ? current.status === 2 : [1, 2, 3].includes(current.status))
      || current.merchant?.toLowerCase() !== merchant.toLowerCase()
      || current.amount !== BigInt(record.amountBase ?? '10000000000000000')
      || current.expiresAt !== BigInt(record.expiresAt)) return null;
    // Recent first: avoid dozens of block lookups for a newly approved transaction.
    let candidates = await search({ arc, record: { ...record, createdAt: undefined }, network, event, maxPages: 1 });
    if (!candidates.hashes.length && !candidates.exhausted) {
      // Older records: search near the original timestamp, with bounded RPC work.
      candidates = await search({ arc, record, network, event, maxPages: 3, oldestFirst: true });
    }
    if (candidates.hashes.length !== 1) return null;
    const hash = candidates.hashes[0];
    const proof = await verify({ arc, record, hash, network, readInvoice });
    return proof.status === 'verified' && proof.transactionHash === hash && proof.verificationSource === 'arc-hash' ? proof : null;
  } catch { return null; } // Missing RPC evidence is not a failed or rejected transaction.
}
