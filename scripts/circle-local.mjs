// Local only: start the existing sidecar and Vite together. No production changes.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const sidecar = fileURLToPath(new URL('../experiments/circle-wallet-poc/', import.meta.url));
const args = process.argv.slice(2);
const managed = args.includes('--managed');
const arcSwap = args.includes('--arc-swap');
const arcAnyToken = args.includes('--arc-any-token');
if (args.some(a => !['--managed', '--arc-swap', '--arc-any-token'].includes(a)) ||
  new Set(args).size !== args.length || (arcSwap && !managed) || (arcAnyToken && !arcSwap)) {
  throw new Error('Usage: node scripts/circle-local.mjs [--managed [--arc-swap [--arc-any-token]]]');
}
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 3000);
  timer.unref();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
function run(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  children.add(child);
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) { console.error(`Local process stopped (${code ?? signal}).`); stop(1); }
  });
  return child;
}
async function checkPort(port) {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(port, '127.0.0.1', () => socket.close(resolve));
  }).catch(() => { throw new Error(`Port ${port} is occupied. Stop its existing server first; no process was killed.`); });
}
async function main() {
  if (!existsSync(root + 'node_modules/vite/bin/vite.js') || !existsSync(sidecar + 'node_modules/esbuild/package.json')) throw new Error('Dependencies missing. Install from the existing lockfiles first.');
  if (!existsSync(sidecar + '.env')) throw new Error('Existing sidecar .env not found. Do not create a replacement wallet.');
  await checkPort(4173); await checkPort(5173);
  // Build completes before starting either persistent process. Do not use npm as a process supervisor.
  const build = spawn(process.execPath, ['build.js'], { cwd: sidecar, stdio: 'inherit' });
  children.add(build);
  await new Promise((resolve, reject) => {
    build.once('error', error => { children.delete(build); reject(error); });
    build.once('exit', code => { children.delete(build); code === 0 ? resolve() : reject(new Error('Circle SDK build failed.')); });
  });
  if (stopping) return;
  run(process.execPath, ['--env-file-if-exists=.env', 'server.js'], sidecar, {
    ...process.env, CIRCLE_TERMUL_LOCAL: 'enabled', CIRCLE_TERMUL_MANAGED: managed ? 'enabled' : 'disabled',
    CIRCLE_TERMUL_ARC_SWAP: arcSwap ? 'enabled' : 'disabled',
    CIRCLE_TERMUL_ARC_ANY_TOKEN: arcAnyToken ? 'enabled' : 'disabled',
    CIRCLE_MANAGED_INVOICE_PILOT: 'disabled', CIRCLE_MANAGED_PAYMENT_PILOT: 'disabled',
  });
  let ready = false;
  for (let i = 0; i < 60 && !stopping; i++) {
    try {
      const config = await new Promise((resolve, reject) => {
        const req = get({ hostname: '127.0.0.1', port: 4173, path: '/termul-config', headers: { Host: 'localhost:4173' }, timeout: 1000 }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(new Error('Oversized config')); });
          res.on('error', reject);
          res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch (error) { reject(error); } });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Local config timeout')));
      });
      if (config) {
        if (!config.appId || config.managed !== managed || config.arcSwap !== arcSwap || config.arcAnyToken !== arcAnyToken) {
          throw new Error('Circle local config is not ready.');
        }
        ready = true; break;
      }
    } catch { /* Wait for the local backend, not a remote service. */ }
    await delay(500);
  }
  if (stopping) return;
  if (!ready) throw new Error('Local Circle backend did not become ready.');
  run(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'circle-local', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], root, { ...process.env, TERMUL_LOCAL_CIRCLE: 'enabled' });
  console.log(`\nOpen http://localhost:5173 after Vite is ready. Managed execution: ${managed ? 'ENABLED (explicit approval required)' : 'DISABLED'}. Arc swaps: ${arcSwap ? 'ENABLED' : 'DISABLED'}. Circle Any Token: ${arcAnyToken ? 'ENABLED' : 'DISABLED'}. Ctrl+C stops both servers.\n`);
}
main().catch(error => { if (!stopping) { console.error(error.message); stop(1); } });
