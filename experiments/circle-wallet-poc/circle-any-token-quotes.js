import { PilotError } from './invoice-pilot.js';

export function createCircleAnyTokenQuoteFetcher({ apiKey, fetcher = fetch, now = Date.now } = {}) {
  let retryAt = 0;
  function rateLimited() {
    const minutes = Math.max(1, Math.ceil((retryAt - now()) / 60_000));
    return new PilotError(429, `LI.FI is rate-limiting Circle quotes. Try again in about ${minutes} min. No transaction was requested.`,
      'CIRCLE_ANY_TOKEN_QUOTE_RATE_LIMIT');
  }

  return async (url, options) => {
    const endpoint = new URL(url);
    if (endpoint.origin !== 'https://li.quest' || endpoint.pathname !== '/v1/quote' || endpoint.username || endpoint.password
      || endpoint.searchParams.get('fromChain') !== '5042' || endpoint.searchParams.get('toChain') !== '5042') {
      throw new Error('Unexpected Circle quote request.');
    }
    if (retryAt > now()) throw rateLimited();
    const headers = new Headers(options?.headers);
    if (apiKey) headers.set('x-lifi-api-key', apiKey);
    const response = await fetcher(endpoint.href, { ...options, headers, redirect: 'error' });
    if (response.status === 429) {
      const time = now();
      const retryAfter = response.headers.get('retry-after')?.trim();
      const reset = response.headers.get('ratelimit-reset')?.trim() ?? '';
      const retryDelay = /^\d{1,8}$/.test(retryAfter ?? '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '') - time;
      const resetDelay = /^\d{1,8}$/.test(reset) ? Number(reset) * 1000 : 0;
      retryAt = Math.max(retryAt, time + (Math.max(retryDelay || 0, resetDelay) || 60_000));
      throw rateLimited();
    }
    if (apiKey && (response.status === 401 || response.status === 403)) {
      throw new PilotError(503, 'LI.FI rejected authorization for Circle quotes. Check the server configuration. No transaction was requested.',
        'CIRCLE_ANY_TOKEN_QUOTE_AUTH');
    }
    return response;
  };
}
