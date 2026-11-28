import { resolveReleaseFeePolicy } from '../../src/fee-policy.js';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets';
import { isAddress } from 'viem';
import { openPilotJournal } from './pilot-journal.js';
import { PilotError } from './invoice-pilot.js';
import { openLocalMetadata } from './local-metadata.js';
import { openInitializationStore } from './initialization-store.js';
import { createLocalSessionVault } from './session-vault.js';
import { arcHistoryRpc, arcRpc } from './arc.js';
import { openArcIndex } from './arc-index.js';
import { createLocalWeb3 } from './local-web3.js';
import { describeArcReadFailure, arcReadFailure } from '../../src/arc-read.js';
import { createOperations, emailPattern, LocalError, uuidPattern } from './operations.js';
import { createCircleAnyTokenQuoteFetcher } from './circle-any-token-quotes.js';

const port = 4173;
const host = `localhost:${port}`;
const origin = `http://${host}`;
const { CIRCLE_API_KEY: apiKey, CIRCLE_APP_ID: appId, CIRCLE_TEST_EMAIL: email } = process.env;
const testEmail = email?.trim().toLowerCase();
const ready = Boolean(apiKey && !apiKey.startsWith('replace_') && uuidPattern.test(appId ?? '')
  && emailPattern.test(testEmail ?? '') && !testEmail.endsWith('.invalid'));
const pilotEnabled = process.env.CIRCLE_MANAGED_INVOICE_PILOT === 'enabled';
const paymentEnabled = process.env.CIRCLE_MANAGED_PAYMENT_PILOT === 'enabled';
const localEnabled = process.env.CIRCLE_TERMUL_LOCAL === 'enabled';
const localOrigin = 'http://localhost:5173';
const appEnabled = process.env.CIRCLE_TERMUL_MANAGED === 'enabled' && process.env.CIRCLE_TERMUL_LOCAL === 'enabled';
const swapEnabled = appEnabled && process.env.CIRCLE_TERMUL_ARC_SWAP === 'enabled';
const anyTokenEnabled = swapEnabled && process.env.CIRCLE_TERMUL_ARC_ANY_TOKEN === 'enabled';
const allowInitialization = process.env.CIRCLE_WALLET_INITIALIZATION === 'enabled';
const journalPath = fileURLToPath(new URL('./.env.pilot-journal/attempts.sqlite', import.meta.url));
const pilotJournal = ready && (pilotEnabled || paymentEnabled || localEnabled || existsSync(journalPath)) ? openPilotJournal(journalPath) : undefined;
const initialization = ready && openInitializationStore(fileURLToPath(new URL('./.env.pilot-journal/initialization.sqlite', import.meta.url)));
const otpState = { next: 0, requests: [], pending: false };
const metadata = localEnabled && openLocalMetadata(fileURLToPath(new URL('./.env.pilot-journal/local-metadata.sqlite', import.meta.url)), pilotJournal);
const web3 = localEnabled && createLocalWeb3({ arc: arcRpc, origin: localOrigin, metadata });
const index = localEnabled && openArcIndex(fileURLToPath(new URL('./.env.arc-invoice-index.sqlite', import.meta.url)), arcHistoryRpc, { criticalClient: arcRpc });
const operations = ready && createOperations({
  circle: initiateUserControlledWalletsClient({ apiKey }), arc: arcRpc, origin, testEmail, otpState, initialization, allowInitialization,
  pilotOptions: { enabled: pilotEnabled, paymentEnabled, appEnabled, journal: pilotJournal },
});

const localOperations = ready && localEnabled && createOperations({
  circle: initiateUserControlledWalletsClient({ apiKey }), arc: arcRpc, origin: localOrigin, testEmail, otpState, initialization, allowInitialization,
  pilotOptions: { appEnabled, paymentEnabled: appEnabled, journal: pilotJournal },
  swapOptions: { enabled: swapEnabled, allowAnyToken: anyTokenEnabled,
    anyTokenFetcher: createCircleAnyTokenQuoteFetcher({ apiKey: process.env.TERMUL_CIRCLE_LIFI_API_KEY }),
    maxNetworkFeeUsdc: process.env.TERMUL_CIRCLE_ARC_SWAP_MAX_NETWORK_FEE_USDC, loadPolicy: () =>
    resolveReleaseFeePolicy(process.env.TERMUL_RELEASE_FEE_BPS, process.env.TERMUL_RELEASE_FEE_VERSION) },
  metadata,
});

const vault = createLocalSessionVault();

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/circle-sdk.js', ['dist/circle-sdk.js', 'text/javascript; charset=utf-8']],
  ['/browser.js', ['dist/browser.js', 'text/javascript; charset=utf-8']],
]);

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readInput(request) {
  if (request.headers['content-type'] !== 'application/json') throw new LocalError(415, 'Expected JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12_000) throw new LocalError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new LocalError(400, 'Invalid JSON.');
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  if (request.headers.host !== host) return json(response, 403, { error: 'Use the local PoC URL.' });
  try {
    const path = request.url.split('?', 1)[0];
    if (request.method === 'GET' && path === '/config') return json(response, 200, { appId: ready ? appId : null, pilotEnabled: Boolean(ready && pilotEnabled), paymentEnabled: Boolean(ready && paymentEnabled) });
    if (request.method === 'GET' && files.has(path)) {
      const [file, contentType] = files.get(path);
      const body = await readFile(new URL(file, import.meta.url));
      response.writeHead(200, { 'Content-Type': contentType });
      return response.end(body);
    }
    if (request.method === 'GET' && path === '/termul-config') {
      return json(response, 200, { appId: localOperations ? appId : null, managed: Boolean(localOperations && appEnabled),
        arcSwap: Boolean(localOperations && swapEnabled), arcAnyToken: Boolean(localOperations && anyTokenEnabled) });
    }
    if (request.method === 'POST' && request.url === '/termul-session') {
      if (request.headers.origin !== localOrigin) throw new LocalError(403, 'The local Termul origin is required.');
      if (!localOperations) throw new LocalError(503, 'Local Circle sign-in is unavailable.');
      const result = await vault.handle(await readInput(request), request.headers.cookie,
        userToken => localOperations({ action: 'wallet', userToken }));
      if (result.cookie) response.setHeader('Set-Cookie', result.cookie);
      return json(response, result.status ?? 200, result.body);
    }
    if (request.method === 'POST' && ['/termul-web3', '/termul-history'].includes(path)) {
      if (request.headers.origin !== localOrigin || !localEnabled) throw new LocalError(403, 'The local Termul origin is required.');
      const input = await readInput(request);
      if (path === '/termul-web3') return json(response, 200, await web3(input, request.headers.authorization));
      if (!isAddress(input.merchant ?? '', { strict: false })) throw new LocalError(400, 'Select a valid invoice merchant.');
      if (input.invoiceId !== undefined) {
        if (!/^0x[\da-f]{64}$/i.test(input.invoiceId)) throw new LocalError(400, 'Invalid invoice identifier.');
        return json(response, 200, { invoice: index.get(input.merchant.toLowerCase(), input.invoiceId.toLowerCase()) });
      }
      void index.sync();
      return json(response, 200, index.snapshot(input.merchant));
    }
    if (request.method === 'POST' && request.url === '/termul-api') {
      if (request.headers.origin !== localOrigin) throw new LocalError(403, 'The local Termul origin is required.');
      if (!localOperations) throw new LocalError(503, 'Local Circle sign-in is unavailable.');
      return json(response, 200, await localOperations(await readInput(request)));
    }
    if (request.method !== 'POST' || request.url !== '/api') return json(response, 404, { error: 'Not found.' });
    if (request.headers.origin !== origin) throw new LocalError(403, 'The local origin is required.');
    if (!ready) throw new LocalError(503, 'Configure the local Circle environment and restart.');
    return json(response, 200, await operations(await readInput(request)));
  } catch (error) {
    if (error instanceof PilotError) return json(response, error.status, { error: error.message, code: error.code, feeChanges: error.feeChanges });
    if (error instanceof LocalError || error?.localMetadata === true) return json(response, error.status, { error: error.message });
    if (arcReadFailure(error)) return json(response, 503, { error: describeArcReadFailure(error), code: 'ARC_RPC_UNAVAILABLE' });
    const code = Number.isInteger(error?.code) && error.code >= 100000 && error.code < 1000000 ? error.code : undefined;
    if ([155103, 155104, 155105, 155718].includes(code)) {
      return json(response, 401, { error: 'Circle session is invalid or expired. Log in again.' });
    }
    const message = code ? `Circle rejected the request (code ${code}).` : 'The request could not be completed.';
    return json(response, 502, { error: message });
  }
});
server.requestTimeout = 15_000;
server.listen(port, '127.0.0.1', () => console.log(`Termul Circle Wallet PoC at ${origin}`));
