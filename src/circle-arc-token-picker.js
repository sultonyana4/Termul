import { erc20Abi, formatUnits } from 'viem';
import { arcTokenAddress, arcTokenCatalog, circleArcChainId } from './circle-arc-tokens.js';
import { createTokenIcon } from './display-assets.js';
import { circleCompactAmount } from './circle-amount.js';

const pageSize = 8;
const balanceTtl = 30_000;

export function createCircleArcTokenPicker({ dialog, client, selection, onSelect, catalog = arcTokenCatalog }) {
  const search = dialog.querySelector('input');
  const status = dialog.querySelector('[role="status"]');
  const results = dialog.querySelector('ul');
  const more = dialog.querySelector('[data-token-more]');
  const balances = new Map();
  let timer, generation = 0, context, limit;

  async function readBalance(wallet, token) {
    const key = wallet.address.toLowerCase() + ':' + token.address;
    const cached = balances.get(key);
    if (cached?.expiresAt > Date.now()) return cached.result;
    const result = client.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] });
    if (balances.size >= 256) balances.delete(balances.keys().next().value);
    balances.set(key, { result, expiresAt: Date.now() + balanceTtl });
    try { return await result; }
    catch (error) { if (balances.get(key)?.result === result) balances.delete(key); throw error; }
  }

  async function render(request) {
    if (!context || request !== generation) return;
    const { wallet, excluded } = context;
    const query = search.value.trim();
    const address = arcTokenAddress(query);
    status.textContent = 'Looking up Arc tokens…';
    let tokens;
    try {
      if (address) {
        const found = await catalog.find(address);
        tokens = found ? [found] : [];
      } else {
        const normalized = query.toLowerCase();
        tokens = (await catalog.load()).filter(token => token.symbol.toLowerCase().includes(normalized)
          || token.name.toLowerCase().includes(normalized));
      }
    } catch {
      if (request === generation) status.textContent = 'The LI.FI catalog is unavailable. Try again.';
      return;
    }
    if (request !== generation) return;
    status.textContent = tokens.length ? '' : 'No matching Arc tokens in LI.FI.';
    let next = 0;
    const rows = tokens.slice(0, limit).map(token => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-quiet circle-token-row';
      button.disabled = token.address.toLowerCase() === excluded.toLowerCase();
      const detail = document.createElement('span');
      const symbol = document.createElement('strong');
      symbol.textContent = token.symbol;
      const label = document.createElement('small');
      label.textContent = token.name;
      const address = document.createElement('small');
      address.className = 'mono';
      address.textContent = token.address;
      detail.append(symbol, label, address);
      const balance = document.createElement('span');
      balance.textContent = '—';
      balance.className = 'circle-token-balance';
      button.append(createTokenIcon(document, token), detail, balance);
      button.addEventListener('click', () => {
        if (request !== generation || !context || wallet !== selection()) return;
        onSelect(context.side, token);
        dialog.close();
      });
      item.append(button);
      return { item, token, balance };
    });
    results.replaceChildren(...rows.map(row => row.item));
    more.hidden = tokens.length <= limit;
    try { if (await client.getChainId() !== circleArcChainId) return; } catch { return; }
    const readRows = async () => {
      while (request === generation && next < rows.length) {
        const { token, balance } = rows[next++];
        try {
          const value = await readBalance(wallet, token);
          if (request === generation && wallet === selection()) {
            balance.title = formatUnits(value, token.decimals) + ' ' + token.symbol;
            balance.textContent = circleCompactAmount(formatUnits(value, token.decimals));
          }
        } catch { /* The token remains discoverable when its balance is unavailable. */ }
      }
    };
    await Promise.all([readRows(), readRows()]);
  }

  function update(delay) {
    const request = ++generation;
    clearTimeout(timer);
    results.replaceChildren();
    more.hidden = true;
    timer = setTimeout(() => void render(request), delay);
  }
  search.addEventListener('input', () => { limit = pageSize; update(250); });
  more.addEventListener('click', () => { limit += pageSize; update(0); });
  dialog.querySelector('[data-token-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearTimeout(timer); generation++; context = undefined; });
  return {
    open(side, excluded) {
      const wallet = selection();
      if (wallet?.type !== 'circle' || wallet.chainId !== circleArcChainId || dialog.open) return;
      context = { side, excluded, wallet };
      search.value = '';
      limit = pageSize;
      dialog.showModal();
      search.focus();
      update(0);
    },
    close() { if (dialog.open) dialog.close(); },
    clearBalances() { balances.clear(); },
  };
}
