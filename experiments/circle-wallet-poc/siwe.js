import { randomBytes } from 'node:crypto';
import { isAddressEqual, recoverMessageAddress } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { createEOAVerifier } from '../../supabase/functions/termul-wallet-v1/verification.js';
import { arcChainId } from './arc.js';
import { readArc } from '../../src/arc-read.js';

export function makeLocalChallenge(origin, address, now = Date.now()) {
  const expiresAt = now + 5 * 60_000;
  const message = createSiweMessage({
    address, domain: new URL(origin).host, uri: origin, chainId: arcChainId, version: '1',
    nonce: randomBytes(16).toString('hex'), issuedAt: new Date(now), expirationTime: new Date(expiresAt),
    statement: 'Verify ownership for the local Termul wallet session.',
  });
  return { message, expiresAt, address };
}

export async function verifyLocalChallenge({ client, origin, challenge, message, signature, now = Date.now() }) {
  if (challenge.expiresAt <= now || message !== challenge.message || !/^0x[0-9a-f]{130}$/i.test(signature)) return false;
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !isAddressEqual(parsed.address, challenge.address) || parsed.chainId !== arcChainId
    || parsed.domain !== new URL(origin).host || parsed.uri !== origin || parsed.version !== '1'
    || !parsed.nonce || parsed.expirationTime?.getTime() !== challenge.expiresAt) return false;
  const checkedClient = { getChainId: () => readArc(() => client.getChainId()), getCode: args => readArc(() => client.getCode(args)) };
  return createEOAVerifier({ client: checkedClient, recoverMessageAddress })(challenge.address.toLowerCase(), message, signature);
}
