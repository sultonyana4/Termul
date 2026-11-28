import { createCircleSwap } from '../../experiments/circle-wallet-poc/circle-swap.js';
import { automaticArcRecovery } from '../../experiments/circle-wallet-poc/automatic-arc-recovery.js';
import { invoiceAbi, verifyManagedDeployment } from '../../experiments/circle-wallet-poc/managed-preflight.js';
import { verifyPilotReceipt, recoverPilotHash } from '../../experiments/circle-wallet-poc/pilot-reconciliation.js';
import { TERMUL_MAINNET as network } from '../../supabase/functions/_shared/termul-mainnet.js';

export async function reconcilePendingCircleAttempts({ arc, journal }) {
  const records = await journal.due();
  if (records.some(record => record.kind !== 'arc-swap') && (await verifyManagedDeployment(arc, network)).status !== 'verified') {
    throw new Error('Arc contract cannot be verified.');
  }
  const readInvoice = (merchant, id, blockNumber) => arc.readContract({
    address: network.contractAddress, abi: invoiceAbi, functionName: 'getInvoice', args: [merchant, id], blockNumber,
  });
  const swap = createCircleSwap({ arc, journal });
  const results = await Promise.allSettled(records.map(async record => {
    if (record.kind === 'arc-swap') {
      const { attempt } = await swap.status({ wallet: { id: record.walletId, address: record.walletAddress } });
      if (['verified', 'reverted'].includes(attempt?.status)) return true;
      await journal.update(record, {});
      return false;
    }
    const event = invoiceAbi.find(item => item.type === 'event' && item.name === (record.kind === 'payment' ? 'InvoicePaid' : 'InvoiceCreated'));
    let proof;
    const hash = record.transactionHash ?? record.providerHash;
    if (hash) {
      try { proof = await verifyPilotReceipt(arc, { ...record, transactionHash: hash }, readInvoice); }
      catch { /* An unavailable receipt is inconclusive. */ }
      if (['verified', 'reverted'].includes(proof?.status)) {
        proof.transactionHash = hash;
        if (proof.status === 'verified') proof.verificationSource = 'arc-hash';
      }
    }
    if (!['verified', 'reverted'].includes(proof?.status)) {
      proof = await automaticArcRecovery({ arc, record, network, event, readInvoice, verify: recoverPilotHash });
    }
    if (proof?.status === 'verified' || proof?.status === 'reverted') {
      return ['verified', 'reverted'].includes((await journal.update(record, proof))?.status);
    }
    await journal.update(record, {});
    return false;
  }));
  await journal.purgeExpired();
  return { checked: results.length, resolved: results.filter(result => result.status === 'fulfilled' && result.value).length,
    unavailable: results.filter(result => result.status === 'rejected').length };
}
