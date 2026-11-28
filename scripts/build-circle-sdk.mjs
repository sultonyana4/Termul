import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { nodeModulesPolyfillPlugin } from 'esbuild-plugins-node-modules-polyfill';

export async function bundleCircleSdk() {
  const result = await build({
    stdin: { contents: "export { W3SSdk } from '@circle-fin/w3s-pw-web-sdk';",
      resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
    bundle: true, format: 'esm', minify: true, write: false,
    alias: { stream: 'stream-browserify' },
    plugins: [nodeModulesPolyfillPlugin({
      globals: { Buffer: true, process: true },
      modules: { buffer: true, crypto: true, events: true, process: true, util: true },
    })],
  });
  return result.outputFiles[0].contents;
}
