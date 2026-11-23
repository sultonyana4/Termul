import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const { window } = new JSDOM(html, { url: 'https://termul.xyz/', runScripts: 'outside-only' });
window.eval(window.document.querySelector('script:not([src])').textContent);
const $ = (selector) => window.document.querySelector(selector);
const address = '0x' + '12'.repeat(20);
const alternate = '0x' + '34'.repeat(20);
let connected = 0;
let authenticated = false;
let saved;
let copied;
window.navigator.clipboard = { writeText: async value => { copied = value; } };
window.termulWallet = {
  connect: () => connected++,
  disconnect: () => { authenticated = false; window.termulConnectionChanged(null); },
  session: { isAuthenticated: () => authenticated, authenticate: async () => { authenticated = true; } },
};
window.arusPayMetadata = {
  getProfile: async () => ({ profile: null }),
  saveProfile: async display_name => { saved = display_name; return { profile: { display_name } }; },
};
$('#connect-wallet').click();
assert.equal(connected, 1);
window.termulConnectionChanged({ address, chainId: 5042, connectorId: 'rabby' });
assert.equal($('#workspace').classList.contains('hidden'), false);
window.navigate('profile');
assert.match($('#wallet-address-list').textContent, new RegExp(address));
$('[data-copy-wallet]').click();
assert.equal(copied, address);
$('#display-name-input').value = 'Invoice merchant';
$('#display-name-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(saved, 'Invoice merchant');
assert.equal($('#profile-name').textContent, 'Invoice merchant');
authenticated = false;
window.termulConnectionChanged({ address: alternate, chainId: 1, connectorId: 'injected' });
assert.equal($('#display-name-input').value, '');
assert.equal($('#switch-wallet-network').classList.contains('hidden'), false);
assert.equal($('#verify-wallet').disabled, true);
assert.match($('#wallet-address-list').textContent, new RegExp(alternate));
$('#sign-out').click();
assert.equal($('#signin').classList.contains('hidden'), false);
assert.equal(window.localStorage.length, 0);
window.close();
console.log('Wallet-native connection, profile, balance placeholder, account change and disconnect smoke tests passed.');
