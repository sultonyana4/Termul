import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultFeePolicy, FEE_POLICY_FILE, parseFeePolicy, sameFeePolicy } from '../src/fee-policy.js';
import { endpointFor } from '../src/wallet-session.js';

export { resolveReleaseFeePolicy as releaseFeePolicy } from '../src/fee-policy.js';

export function requireWalletEndpoint(value, browserFixture = false) {
  const endpoint = endpointFor(value);
  if (!endpoint || (!browserFixture && /fixture\.supabase\.co|YOUR_PROJECT_REF\.supabase\.co/i.test(endpoint))) {
    throw new Error('Set VITE_TERMUL_WALLET_API_URL to the approved public Termul wallet API endpoint.');
  }
  return endpoint;
}

export const FIXTURE_MARKER = 'termul-offline-browser-fixture.txt';

const fixtureAddresses = /0x(?:(?:99){20}|(?:12){20}|(?:34){20}|(?:56){20})/i;
const rejectedContent = /VITE_TERMUL_SWAP_FEE_(?:BPS|RECIPIENT)|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;

export async function verifyRelease(directory, expected = defaultFeePolicy, { browserFixture = false, walletEndpoint } = {}) {
  const requiredEndpoint = requireWalletEndpoint(walletEndpoint, browserFixture);
  let hasWalletEndpoint = false;
  const actual = parseFeePolicy(JSON.parse(await readFile(join(directory, FEE_POLICY_FILE), 'utf8')));
  if (!sameFeePolicy(actual, expected)) throw new Error('Artifact fee policy does not match the expected release settings.');

  async function scan(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (!browserFixture && entry.name === FIXTURE_MARKER) throw new Error('Offline browser artifacts cannot be released.');
      if (entry.isDirectory()) await scan(path);
      else if (/\.(?:[cm]?js|css|html|json|map|svg|txt|webmanifest)$/i.test(entry.name)) {
        const content = await readFile(path, 'utf8');
        if (/\.[cm]?js$/i.test(entry.name)) {
          const endpoints = content.match(/https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/termul-wallet-v1\b/gi) ?? [];
          if (endpoints.some(endpoint => endpoint !== requiredEndpoint)) throw new Error('Unexpected public wallet API endpoint in release JavaScript.');
          hasWalletEndpoint ||= endpoints.length > 0;
        }
        if (fixtureAddresses.test(content) || rejectedContent.test(content)
          || (!browserFixture && /fixture\.supabase\.co|YOUR_PROJECT_REF\.supabase\.co/i.test(content))) {
          throw new Error('Forbidden fixture or configuration marker in artifact ' + entry.name + '.');
        }
      }
    }
  }

  await scan(directory);
  if (!hasWalletEndpoint) throw new Error('Required public wallet API endpoint is missing from release JavaScript.');
  return actual;
}
