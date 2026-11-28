// The external-wallet catalog is independent of Circle protocol coverage.
export const circleLifiNetworks = Object.freeze({ 5042: 'Arc', 8453: 'Base', 42161: 'Arbitrum', 10: 'OP Mainnet' });
export const circleLifiPairs = Object.freeze({
  '5042:8453': 'across',
  '8453:5042': 'polymerStandard',
  '8453:10': 'across',
  '10:8453': 'across',
  '42161:8453': 'across',
  '8453:42161': 'across',
});
