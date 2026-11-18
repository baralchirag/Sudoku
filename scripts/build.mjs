// Builds the whole app into ONE file: dist/worker.js.
//
//  1. bundle + minify the browser app (src/client) into a string
//  2. minify the stylesheet and read the HTML shell
//  3. bundle the Worker, inlining (1) and (2) through a virtual module
//
// The output has no imports and no bindings it can't live without, so it can
// be pasted straight into the Cloudflare dashboard editor.

import { build, transform } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFile(root + p, 'utf8');

export async function buildAll({ quiet = false } = {}) {
  const started = Date.now();
  const client = await build({
    entryPoints: [root + 'src/client/main.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    write: false,
    legalComments: 'none',
  });
  const js = client.outputFiles[0].text;
  const css = (await transform(await read('src/client/styles.css'), { loader: 'css', minify: true })).code;
  const version = createHash('sha256').update(js).update(css).digest('hex').slice(0, 12);
  const html = (await read('src/client/index.html')).replaceAll('{{VERSION}}', version);
  const assets = {
    html,
    js,
    css,
    version,
    favicon: await read('src/client/favicon.svg'),
    manifest: await read('src/client/manifest.webmanifest'),
  };

  const virtualAssets = {
    name: 'virtual-assets',
    setup(b) {
      b.onResolve({ filter: /^virtual:assets$/ }, () => ({ path: 'assets', namespace: 'virtual' }));
      b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({
        contents: `export default ${JSON.stringify(assets)};`,
        loader: 'js',
      }));
    },
  };

  await mkdir(root + 'dist', { recursive: true });
  const worker = await build({
    entryPoints: [root + 'src/worker.js'],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    plugins: [virtualAssets],
    banner: { js: '// Daily Sudoku: single-file Cloudflare Worker. Built by scripts/build.mjs; edit src/ instead.' },
  });
  await writeFile(root + 'dist/worker.js', worker.outputFiles[0].text);
  if (!quiet) {
    const kb = (worker.outputFiles[0].text.length / 1024).toFixed(1);
    console.log(`dist/worker.js  ${kb} KB  (client ${(js.length / 1024).toFixed(1)} KB, v${version}) in ${Date.now() - started}ms`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildAll();
}
