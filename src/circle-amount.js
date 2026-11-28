import { formatUnits, parseUnits } from 'viem';

export function circleCompactAmount(exact, bound) {
  const [, fraction = ''] = exact.split('.');
  const first = fraction.search(/[1-9]/);
  const digits = Math.min(12, Math.max(6, first + 3));
  if (fraction.length <= digits) return exact;
  const scale = 10n ** BigInt(fraction.length - digits);
  const amount = parseUnits(exact, fraction.length);
  const rounded = formatUnits(bound === 'up' ? (amount + scale - 1n) / scale : amount / scale, digits);
  if (bound === 'up') return '≤ ' + rounded;
  if (bound === 'down') return '≥ ' + rounded;
  return rounded === '0' ? '< ' + formatUnits(1n, digits) : '≈ ' + rounded;
}
