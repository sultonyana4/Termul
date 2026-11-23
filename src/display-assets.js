const tokenImages = {
  USDC: '/brand/usdc.svg',
  EURC: '/brand/eurc.svg',
};

export function setTokenIcon(image, symbol) {
  if (Object.hasOwn(tokenImages, symbol)) image.setAttribute('src', tokenImages[symbol]);
  else image.removeAttribute('src');
}

export function renderReceiptAssets(container, symbols) {
  const document = container.ownerDocument;
  const tokens = symbols.filter(symbol => Object.hasOwn(tokenImages, symbol));
  container.hidden = !tokens.length;
  container.replaceChildren(...tokens.map(symbol => {
    const item = document.createElement('span');
    item.className = 'token-label';
    const image = document.createElement('img');
    image.className = 'token-icon';
    image.alt = '';
    image.width = image.height = 32;
    setTokenIcon(image, symbol);
    item.append(image, symbol);
    return item;
  }));
}
