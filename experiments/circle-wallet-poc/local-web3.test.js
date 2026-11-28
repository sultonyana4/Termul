import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { createLocalWeb3 } from './local-web3.js';

test('localhost Web3 uses origin-bound, single-use SIWE with isolated sessions and expiry', async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  let clock = Date.now();
  const origin = 'http://localhost:5173';
  const api = createLocalWeb3({ origin, now: () => clock,
    arc: { getChainId: async () => 5042, getCode: async () => undefined },
    metadata: { request: session => ({ address: session.address }) },
  });
  async function login(signer = wallet) {
    const { message, challengeToken } = await api({ action: 'challenge', walletAddress: wallet.address });
    const parsed = parseSiweMessage(message);
    assert.equal(parsed.domain, 'localhost:5173');
    assert.equal(parsed.uri, origin);
    assert.equal(parsed.chainId, 5042);
    const input = { action: 'verify', message, challengeToken, signature: await signer.signMessage({ message }) };
    if (signer !== wallet) { await assert.rejects(api(input), { status: 401 }); return; }
    const session = await api(input);
    await assert.rejects(api(input), { status: 401 });
    return 'Bearer ' + session.sessionToken;
  }
  await login(other);
  const bearer = await login();
  await assert.rejects(api({ action: 'get_profile', walletAddress: other.address }, bearer), { status: 403 });
  const restore = { action: 'get_profile', walletAddress: wallet.address };
  assert.equal((await api(restore, bearer)).address, wallet.address.toLowerCase());
  await api({ ...restore, action: 'logout' }, bearer);
  await assert.rejects(api(restore, bearer), { status: 401 });
  const expiring = await login();
  clock += 12 * 60_000;
  await assert.rejects(api(restore, expiring), { status: 401 });
});
