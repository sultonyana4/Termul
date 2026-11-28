import { createHash, randomBytes } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { makeLocalChallenge, verifyLocalChallenge } from './siwe.js';

const mint = () => randomBytes(32).toString('hex');
const digest = token => createHash('sha256').update(token).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status, localMetadata: true }); };

export function createLocalWeb3({ arc, origin, metadata, now = Date.now }) {
  const challenges = new Map();
  const sessions = new Map();
  let recentChallenge = [];
  return async (input, authorization) => {
    const time = now();
    for (const values of [challenges, sessions]) {
      for (const [key, item] of values) if (item.expiresAt <= time) values.delete(key);
    }
    if (input.action === 'challenge') {
      if (!isAddress(input.walletAddress ?? '', { strict: false })) fail(400, 'Select a valid Arc wallet.');
      recentChallenge = recentChallenge.filter(at => at > time - 60_000);
      if (recentChallenge.length >= 16 || challenges.size >= 32) fail(429, 'Wait before requesting another verification.');
      recentChallenge.push(time);
      const challenge = makeLocalChallenge(origin, getAddress(input.walletAddress), time);
      const token = mint();
      challenges.set(digest(token), challenge);
      return { challengeToken: token, message: challenge.message };
    }
    if (input.action === 'verify') {
      if (!/^[a-f0-9]{64}$/.test(input.challengeToken ?? '') || typeof input.message !== 'string') fail(400, 'Invalid wallet challenge.');
      const key = digest(input.challengeToken);
      const challenge = challenges.get(key);
      if (!challenge || challenge.inFlight) fail(401, 'Wallet challenge expired or was used.');
      challenge.inFlight = true;
      try {
        if (!await verifyLocalChallenge({ client: arc, origin, challenge, message: input.message, signature: input.signature, now: time })
          || challenge.expiresAt <= now()) fail(401, 'Wallet signature is invalid or expired.');
      } catch (error) {
        if (error.localMetadata) { challenges.delete(key); throw error; }
        fail(503, 'Arc RPC could not verify the selected wallet. Try again.');
      } finally { challenge.inFlight = false; }
      challenges.delete(key);
      if (sessions.size >= 32) fail(429, 'Too many local wallet sessions.');
      const sessionToken = mint();
      const walletAddress = challenge.address.toLowerCase();
      const expiresAt = now() + 12 * 60_000;
      sessions.set(digest(sessionToken), { address: walletAddress, expiresAt, verifiedAt: now() });
      return { sessionToken, walletAddress, expiresAt: new Date(expiresAt).toISOString() };
    }
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? '')?.[1];
    const key = bearer && digest(bearer);
    const session = sessions.get(key);
    if (!session) fail(401, 'Local wallet session expired. Verify again.');
    if (!isAddress(input.walletAddress ?? '', { strict: false }) || input.walletAddress.toLowerCase() !== session.address) {
      fail(403, 'The selected wallet changed.');
    }
    if (input.action === 'logout') { sessions.delete(key); return { ok: true }; }
    if (['save_profile', 'save_invoice'].includes(input.action) && now() - session.verifiedAt >= 6 * 60_000) fail(401, 'Verify ownership again before changing metadata.');
    return metadata.request(session, { ...input, metadataAction: input.action }, { external: true, arc });
  };
}
