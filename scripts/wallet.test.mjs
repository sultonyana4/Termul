import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect, createConfig, disconnect, getConnection, reconnect, watchConnection } from '@wagmi/core';
import { http } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { arcChain } from '../src/arc-network.js';
import { discoverInjectedWallets, injectedConnector } from '../src/injected-wallets.js';
import { assertWalletProvider, sameWallet, switchWalletToArc } from '../src/wallet-provider.js';
import { createWalletSession, endpointFor } from '../src/wallet-session.js';

const a = '0x' + '12'.repeat(20);
const b = '0x' + '34'.repeat(20);
const url = 'https://fixture.supabase.co/functions/v1/termul-wallet-v1';
const origin = () => 'https://termul.xyz';
const signature = '0x' + '11'.repeat(65);

class FixtureProvider extends EventEmitter {
  calls = [];
  chain = '0x13b2';
  constructor(account) { super(); this.account = account; }
  async request({ method }) {
    this.calls.push(method);
    if (method === 'eth_requestAccounts' && this.rejected) throw Object.assign(new Error('Declined'), { code: 4001 });
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [this.account];
    if (method === 'eth_chainId') return this.chain;
    assert.fail(method);
  }
}
const rabby = new FixtureProvider(a);
const metamask = new FixtureProvider(b);
const coinbase = new FixtureProvider(b);
coinbase.isCoinbaseWallet = true;
const browser = Object.assign(new EventTarget(), { Event, ethereum: { providers: [rabby, metamask, coinbase] } });
const discovery = discoverInjectedWallets(browser, () => {});
function announce(provider, name, rdns, icon) {
  browser.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
    provider, info: { uuid: '350670db-19fa-4704-a166-e52e178b59d2', name, rdns, icon },
  } }));
}
announce(rabby, 'Rabby', 'io.rabby', 'https://untrusted.invalid/icon.png');
announce(metamask, 'MetaMask', 'io.metamask', 'data:image/png;base64,aA==');
announce(rabby, 'Duplicate announcement', 'io.rabby');
const [first, second, legacy] = discovery.list();
assert.deepEqual(discovery.list().map(wallet => wallet.name), ['Rabby', 'MetaMask', 'Coinbase Wallet']);
assert.equal(first.icon, null);
assert.equal(second.icon, 'data:image/png;base64,aA==');
assert.equal(legacy.provider, coinbase);
announce(new FixtureProvider(b), 'Rabby', 'io.rabby');
assert.equal(discovery.list().filter(wallet => wallet.rdns === 'io.rabby').length, 2);
const config = createConfig({ chains: [arcChain], transports: { [arcChain.id]: http() },
  storage: null, multiInjectedProviderDiscovery: false });
const states = [];
const unwatch = watchConnection(config, { onChange: value => states.push(value.status) });
rabby.rejected = true;
await assert.rejects(connect(config, { connector: injectedConnector(first) }), { code: 4001 });
assert.equal(getConnection(config).status, 'disconnected');
assert.deepEqual(metamask.calls, []);
await connect(config, { connector: injectedConnector(second) });
assert.equal(getConnection(config).address, b);
assert.equal(await getConnection(config).connector.getProvider(), metamask);
metamask.chain = '0x1';
metamask.emit('chainChanged', metamask.chain);
assert.equal(getConnection(config).chainId, 1);
metamask.chain = '0x13b2';
metamask.emit('chainChanged', metamask.chain);
assert.equal(getConnection(config).chainId, 5042);
metamask.account = a;
metamask.emit('accountsChanged', [a, b]);
assert.equal(getConnection(config).address, a);
await disconnect(config);
assert.equal(metamask.listenerCount('accountsChanged'), 0);
metamask.emit('accountsChanged', [b]);
assert.equal(getConnection(config).status, 'disconnected');
const prompts = metamask.calls.filter(method => method === 'eth_requestAccounts').length;
assert.deepEqual(await reconnect(config, { connectors: [injectedConnector(second, b)] }), []);
assert.equal((await reconnect(config, { connectors: [injectedConnector(second, a)] })).length, 1);
assert.equal(metamask.calls.filter(method => method === 'eth_requestAccounts').length, prompts);
metamask.emit('accountsChanged', []);
assert.equal(getConnection(config).status, 'disconnected');
assert.ok(states.includes('connected'));
unwatch();

let selected = { address: a, chainId: 5042, connectorId: 'rabby' };
const methods = [];
const provider = { request: async ({ method, params }) => {
  methods.push({ method, params });
  if (method === 'eth_chainId') return '0x' + selected.chainId.toString(16);
  if (method === 'eth_accounts') return [selected.address];
  if (method === 'personal_sign') return signature; // Fixture response. No signing.
  assert.fail(method);
} };
const requests = [];
let tryChangeAccount = false;
let rejectSignature = false;
let badDomain = false;
let verifyResponseStarted;
let releaseVerify;
const fakeFetch = async (address, options) => {
  assert.equal(address, url);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  const payload = JSON.parse(options.body);
  requests.push({ payload, headers: options.headers });
  if (payload.action === 'challenge') return Response.json({
    challengeToken: 'aa'.repeat(32),
    message: createSiweMessage({ address: selected.address, chainId: 5042,
      domain: badDomain ? 'other.example' : 'termul.xyz', uri: origin(), nonce: 'a'.repeat(32),
      version: '1', issuedAt: new Date(), expirationTime: new Date(Date.now() + 120_000) }),
  });
  if (payload.action === 'verify') {
    assert.equal(payload.signature, signature);
    if (verifyResponseStarted) { verifyResponseStarted(); await new Promise(resolve => { releaseVerify = resolve; }); }
    return Response.json({ sessionToken: 'bb'.repeat(32), walletAddress: a, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  }
  return Response.json({ ok: true });
};
const session = createWalletSession({ getWallet: () => selected, url: endpointFor(url), origin,
  getProvider: async () => ({ request: async (input) => {
    const result = await provider.request(input);
    if (input.method === 'personal_sign' && tryChangeAccount) selected = { ...selected, address: b };
    if (input.method === 'personal_sign' && rejectSignature) throw Object.assign(new Error('User rejected'), { code: 4001 });
    return result;
  } }), fetchRequest: fakeFetch,
});
assert.equal(endpointFor('https://unsafe.test/functions/v1/termul-wallet-v1'), null);
assert.equal(endpointFor('https://fixture.supabase.co/functions/v1/aruspay-api'), null);
assert.equal(endpointFor('https://fixture.supabase.co/functions/v1/termul-wallet-v1?x=1'), null);
await assert.rejects(session.request('get_profile', {}), /Verify ownership/);
await assert.rejects(assertWalletProvider(provider, b), /account changed/);
assert.equal(sameWallet(selected, { ...selected, connectorId: 'replacement' }), false);
selected = { ...selected, chainId: 1 };
await assert.rejects(session.authenticate(), /Arc Mainnet/);
await assert.rejects(assertWalletProvider(provider, a), /Arc Mainnet/);
const switches = [];
await switchWalletToArc({ request: async request => {
  switches.push(request);
  if (switches.length === 1) throw Object.assign(new Error('Unknown chain'), { code: 4902 });
} });
assert.deepEqual(switches.map(x => x.method), ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
assert.equal(switches[1].params[0].chainId, '0x13b2');
selected = { ...selected, chainId: 5042 };
badDomain = true;
await assert.rejects(session.authenticate(), /challenge changed/);
assert.equal(methods.filter(x => x.method === 'personal_sign').length, 0);
badDomain = false;
rejectSignature = true;
await assert.rejects(session.authenticate(), /User rejected/);
rejectSignature = false;
tryChangeAccount = true;
await assert.rejects(session.authenticate(), /account changed/);
assert.ok(!requests.some(x => x.payload.action === 'verify'));
tryChangeAccount = false;
selected = { ...selected, address: a };
await Promise.all([session.authenticate(), session.authenticate()]);
assert.equal(requests.filter(x => x.payload.action === 'verify').length, 1);
assert.equal(session.isAuthenticated(), true);
await session.request('get_profile', {}, a);
assert.equal(requests.at(-1).headers.Authorization, 'Bearer ' + 'bb'.repeat(32));
await assert.rejects(session.request('get_profile', {}, b), /Verify ownership/);
selected = { ...selected, chainId: 1 };
assert.equal(session.isAuthenticated(), false);
session.invalidate();
assert.equal(requests.at(-1).payload.action, 'logout');

selected = { ...selected, chainId: 5042 };
const verifyStarted = new Promise(resolve => { verifyResponseStarted = resolve; });
const old = session.authenticate();
await verifyStarted;
selected = { ...selected, address: b };
session.invalidate();
releaseVerify();
await assert.rejects(old, /wallet changed/);
assert.equal(requests.at(-1).payload.action, 'logout');
assert.equal(session.isAuthenticated(), false);
console.log('Wallet connection, wrong-network recovery, rejected signature, account-change and session tests passed.');
