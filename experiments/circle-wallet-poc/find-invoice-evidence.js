// Dependency-free search. An event is only a candidate; callers must verify the full receipt.
export async function findInvoiceEvidence({ arc, record, network, event, pageSize = 9999n, maxPages = 100, oldestFirst = false }) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 || pageSize < 1n || pageSize > 9999n) throw new Error('Invalid search budget.');
  const latest = await arc.getBlock({ blockTag: 'latest' });
  if (typeof latest.number !== 'bigint' || latest.number < network.deploymentBlock) throw new Error('Invalid Arc block height.');
  const isPayment = record.kind === 'payment';
  const args = { invoiceId: record.invoiceId, merchant: isPayment ? record.merchant : record.walletAddress,
    ...(isPayment ? { payer: record.walletAddress } : {}) };
  let from = network.deploymentBlock;
  // Narrow the search using the journal timestamp, with a five-minute clock-skew allowance.
  // Missing or future timestamps use the deployment block rather than guessing.
  const created = Date.parse(record.createdAt);
  if (Number.isFinite(created) && created > 0 && BigInt(Math.floor(created / 1000)) <= latest.timestamp) {
    const threshold = BigInt(Math.floor(created / 1000) - 300);
    let low = from, high = latest.number;
    while (low < high) {
      const mid = (low + high) / 2n;
      const block = await arc.getBlock({ blockNumber: mid });
      if (typeof block.timestamp !== 'bigint') throw new Error('Invalid Arc block timestamp.');
      if (block.timestamp < threshold) low = mid + 1n; else high = mid;
    }
    from = low;
  }
  const hashes = new Set();
  if (oldestFirst) {
    let start = from, pages = 0;
    for (; start <= latest.number && pages < maxPages; pages++) {
      const end = start + pageSize - 1n < latest.number ? start + pageSize - 1n : latest.number;
      const logs = await arc.getLogs({ address: network.contractAddress, event, strict: true, args, fromBlock: start, toBlock: end });
      for (const log of logs) {
        if (!log.removed && /^0x[0-9a-f]{64}$/i.test(log.transactionHash ?? '')) hashes.add(log.transactionHash.toLowerCase());
      }
      if (hashes.size) return { hashes: [...hashes], pages: pages + 1, exhausted: false };
      start = end + 1n;
    }
    return { hashes: [], pages, exhausted: start > latest.number };
  }
  let to = latest.number, pages = 0;
  for (; to >= from && pages < maxPages; pages++) {
    const start = to - pageSize + 1n > from ? to - pageSize + 1n : from;
    const logs = await arc.getLogs({ address: network.contractAddress, event, strict: true, args, fromBlock: start, toBlock: to });
    for (const log of logs) {
      if (!log.removed && /^0x[0-9a-f]{64}$/i.test(log.transactionHash ?? '')) hashes.add(log.transactionHash.toLowerCase());
    }
    // An invoice can be created and paid only once; still verify all exact receipt details.
    if (hashes.size) return { hashes: [...hashes], pages: pages + 1, exhausted: false };
    to = start - 1n;
  }
  return { hashes: [], pages, exhausted: to < from };
}
