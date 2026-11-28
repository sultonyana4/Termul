import { build } from 'esbuild';
import { nodeModulesPolyfillPlugin } from 'esbuild-plugins-node-modules-polyfill';

await build({
  entryPoints: ['browser.js', 'circle-sdk.js'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  minify: true,
  // The official Web SDK loads CommonJS dependencies shared with social login.
  alias: { stream: 'stream-browserify' },
  plugins: [nodeModulesPolyfillPlugin({ globals: { Buffer: true, process: true }, modules: { buffer: true, crypto: true, events: true, process: true, util: true } })],
});
