import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const { window } = new JSDOM(html, { url: 'https://termul.xyz/', runScripts: 'outside-only' });
window.eval(window.document.querySelector('script:not([src])').textContent);
const $ = (selector) => window.document.querySelector(selector);
const accountDialog = $('#account-dialog');
accountDialog.showModal = () => { accountDialog.open = true; };
accountDialog.close = () => { accountDialog.open = false; accountDialog.dispatchEvent(new window.Event('close')); };
for (const nav of ['.mobile-bottom', '.side-nav']) {
  assert.deepEqual([...$(nav).querySelectorAll('[data-nav]')].map(node => node.dataset.nav), ['dashboard', 'create', 'swap']);
}
const address = '0x' + '12'.repeat(20);
const alternate = '0x' + '34'.repeat(20);
let connected = 0;
let authenticated = false;
let authentications = 0;
let saved;
let copied;
window.navigator.clipboard = { writeText: async value => { copied = value; } };
window.termulWallet = {
  connect: () => connected++,
  disconnect: () => { authenticated = false; window.termulConnectionChanged(null); },
  session: { isAuthenticated: () => authenticated, authenticate: async () => {
    authentications++;
    authenticated = true;
    window.termulSessionChanged();
  } },
};
window.arusPayMetadata = {
  getProfile: async () => ({ profile: null }),
  saveProfile: async display_name => { saved = display_name; return { profile: { display_name } }; },
};
let createCalls = 0;
window.arusPayCreateInvoice = () => createCalls++;
assert.equal($('#welcome-view').classList.contains('hidden'), false);
assert.equal($('#dashboard-view').classList.contains('hidden'), true);
assert.equal($('#wallet-balance').textContent, '—');
$('.public-feature button[data-nav="create"]').click();
assert.equal($('#workspace-access').classList.contains('hidden'), false);
$('#invoice-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
assert.equal(createCalls, 0);
window.navigate('dashboard');
assert.match($('.payment-explainer summary').textContent, /How payments work/);
assert.equal($('.payment-explainer').open, false);
assert.equal(connected, 0);
assert.equal(authentications, 0);
$('#connect-wallet').click();
assert.equal(connected, 1);
window.termulConnectionChanged({ address, chainId: 5042, connectorId: 'rabby' });
assert.equal($('#workspace').classList.contains('hidden'), false);
$('[data-wallet-menu]').click();
assert.equal(accountDialog.open, true);
assert.equal($('#display-name-form').classList.contains('hidden'), true);
$('#display-name-input').value = 'Unauthorized';
$('#display-name-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
assert.equal(saved, undefined);
assert.equal(authentications, 0);
$('#account-verify-wallet').click();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal($('#display-name-form').classList.contains('hidden'), false);
assert.match($('#wallet-address-list').textContent, new RegExp(address));
$('[data-copy-wallet]').click();
assert.equal(copied, address);
$('#display-name-input').value = 'Invoice merchant';
$('#display-name-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(saved, 'Invoice merchant');
assert.equal($('#profile-name').textContent, 'Invoice merchant');
window.navigate('dashboard');
window.arusPayApi.replaceInvoices([{ amountBase: '1', onchainVerified: true, name: 'Private client' }]);
assert.match($('#invoice-rows').textContent, /Private client/);
authenticated = false;
window.termulSessionChanged();
assert.equal($('#dashboard-view').classList.contains('hidden'), true);
assert.equal(window.arusPayApi.getInvoices().length, 0);
assert.doesNotMatch($('#invoice-rows').textContent, /Private client/);
window.navigate('create');
window.termulConnectionChanged({ address: alternate, chainId: 1, connectorId: 'injected' });
assert.equal($('#display-name-input').value, '');
assert.equal($('#switch-wallet-network').classList.contains('hidden'), false);
assert.equal($('#verify-wallet').disabled, true);
assert.match($('#wallet-address-list').textContent, new RegExp(alternate));
$('#sign-out').click();
assert.equal($('#workspace').classList.contains('hidden'), false);
assert.equal($('#connect-wallet').classList.contains('hidden'), false);
assert.equal(accountDialog.open, false);
assert.equal($('#workspace-access').classList.contains('hidden'), false);
assert.equal(window.localStorage.length, 0);
window.close();
console.log('Guest navigation, protected workspace, SIWE, profile, session loss and disconnect passed.');
