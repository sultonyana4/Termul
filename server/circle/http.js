import { PilotError } from '../../experiments/circle-wallet-poc/invoice-pilot.js';

export const deny = (status, message) => { throw new PilotError(status, message); };
export const json = (body, status = 200, additional) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...additional } });

export async function readJson(request) {
  if (!request.body) deny(400, 'Invalid request.');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 8192) {
      await reader.cancel();
      deny(413, 'Request exceeds the allowed size.');
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { deny(400, 'Invalid request.'); }
}

export function requireTermulOrigin(request) {
  if (request.method !== 'POST' || request.headers.get('origin') !== 'https://termul.xyz' ||
    request.headers.get('sec-fetch-site') === 'cross-site') deny(403, 'The Termul origin is required.');
  if (request.headers.get('content-type') !== 'application/json') deny(415, 'JSON is required.');
}
