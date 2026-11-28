import { formatUnits } from 'viem';
import { ARC_ANY_SWAP_TOKENS, SLIPPAGE, swapRate } from './swap-quote.js';
import { circleCompactAmount } from './circle-amount.js';

export function circleSwapStep({ phase, allowanceValue }) {
  return phase === 'swap' ? 'Swap' : allowanceValue === '0' ? 'Allowance reset' : 'Token approval';
}

export function renderCircleSwapReview(root, review) {
  const [source, destination] = review.assets ?? [ARC_ANY_SWAP_TOKENS[review.from], ARC_ANY_SWAP_TOKENS[review.to]];
  const units = (value, token) => formatUnits(BigInt(value), token.decimals);
  const approval = review.phase === 'approval';
  const amount = units(review.amount, source);
  const allowance = approval ? units(review.allowanceValue, source) : null;
  const output = units(review.received, destination);
  const minimum = units(review.minimum, destination);
  const reset = review.allowanceValue === '0';
  const el = (tag, text) => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  function section(title, rows) {
    const block = document.createElement('section');
    const list = document.createElement('dl');
    for (const [label, value, exact] of rows) {
      const term = el('dt', label);
      const detail = el('dd', value);
      if (exact) detail.title = exact;
      list.append(term, detail);
    }
    block.append(el('h3', title), list);
    return block;
  }
  const instruction = approval
    ? reset ? 'Reset the router allowance to zero. A fresh review follows onchain verification.'
      : 'Approve this exact allowance. The swap requires a separate review and Circle confirmation.'
    : 'Check the latest quote before authorizing the swap in Circle.';
  const summary = section('Arc Mainnet', [
    ['Send', `${circleCompactAmount(amount)} ${source.symbol}`, `${amount} ${source.symbol}`],
    ...(approval ? [['Router allowance', `${circleCompactAmount(allowance)} ${source.symbol}`, `${allowance} ${source.symbol}`]] : []),
    ['Estimated output', `${circleCompactAmount(output)} ${destination.symbol}`, `${output} ${destination.symbol}`],
    ['Minimum received', `${circleCompactAmount(minimum, 'down')} ${destination.symbol}`, `${minimum} ${destination.symbol}`],
    ['Exchange rate', `1 ${source.symbol} ≈ ${swapRate(BigInt(review.amount), BigInt(review.received), source.decimals, destination.decimals)} ${destination.symbol}`],
    ['Slippage', `${SLIPPAGE * 100}%`],
    ['Price impact', review.priceImpact == null ? 'Unavailable' : `${review.referenceImpact ? '≈ ' : ''}${review.priceImpact}%`],
  ]);
  const fees = section('Fees', [
    [`Maximum ${circleSwapStep(review).toLowerCase()} network fee`, `${circleCompactAmount(review.networkFee, 'up')} USDC`, `${review.networkFee} USDC`],
    ...(approval ? [['Swap network fee', 'Available after the allowance is verified']] : []),
    [review.feeBps ? 'Termul fee (0.1%)' : 'Termul fee',
      `${circleCompactAmount(units(review.integratorFee, source))} ${source.symbol}${review.integratorFeeRounded ? ' (rounded down)' : ''}`],
    ['LI.FI fee', `${circleCompactAmount(units(review.providerFee, source))} ${source.symbol}`],
  ]);
  const details = document.createElement('details');
  details.append(el('summary', 'Technical details'), section('Exact terms', [
    ['Recipient', review.recipient], ['Send contract', source.address], ['Receive contract', destination.address],
    ['Target', review.target], ['Calldata hash', review.calldataHash], ['Gas limit', review.gasLimit],
    ['Fee cap (wei/gas)', review.maxFeePerGas], ['Priority fee (wei/gas)', review.priorityFeePerGas],
    ['Exact network fee maximum', `${review.networkFee} USDC`], ['Exact estimated output', `${output} ${destination.symbol}`],
    ['Exact send amount', `${amount} ${source.symbol}`],
    ...(approval ? [['Exact router allowance', `${allowance} ${source.symbol}`]] : []),
    ['Exact minimum received', `${minimum} ${destination.symbol}`], ['Review expires', new Date(review.reviewExpiresAt).toLocaleTimeString()],
  ]));
  root.replaceChildren(el('p', instruction), summary, fees, details);
}
