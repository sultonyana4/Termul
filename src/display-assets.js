import { tokenArtwork } from './circle-arc-tokens.js';

const tokenImages = {
  USDC: '/brand/usdc.svg',
  EURC: '/brand/eurc.svg',
};

export function setTokenIcon(image, token) {
  const contract = token && typeof token === 'object';
  const url = contract ? tokenArtwork(token.logoURI) : Object.hasOwn(tokenImages, token) ? tokenImages[token] : undefined;
  const fallback = () => {
    image.removeAttribute('src');
    image.classList.toggle('token-fallback', Boolean(contract));
  };
  if (image.dataset.artwork === url && url) return;
  image.dataset.artwork = url ?? '';
  image.onerror = fallback;
  image.referrerPolicy = 'no-referrer';
  image.classList.remove('token-fallback');
  if (url) image.setAttribute('src', url);
  else fallback();
}

export function createTokenIcon(document, token) {
  const image = document.createElement('img');
  image.className = 'token-icon';
  image.alt = '';
  image.width = image.height = 32;
  setTokenIcon(image, token);
  if (typeof token !== 'object' || !token) return image;
  const wrapper = document.createElement('span');
  wrapper.className = 'token-artwork';
  wrapper.setAttribute('aria-hidden', 'true');
  const initials = document.createElement('span');
  initials.className = 'token-initials';
  initials.textContent = Array.from(token.symbol?.trim() ?? '').slice(0, 2).join('').toUpperCase() || '•';
  wrapper.append(image, initials);
  return wrapper;
}

export function renderReceiptAssets(container, symbols) {
  const document = container.ownerDocument;
  const tokens = symbols.filter(token => typeof token === 'object' ? token?.symbol : Object.hasOwn(tokenImages, token));
  container.hidden = !tokens.length;
  container.replaceChildren(...tokens.map(token => {
    const item = document.createElement('span');
    item.className = 'token-label';
    item.append(createTokenIcon(document, token), token.symbol ?? token);
    return item;
  }));
}
