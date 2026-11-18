// Local development server: runs dist/worker.js inside Node by adapting
// node:http to the Fetch API, and rebuilds + reloads when src/ changes.
//
//   npm run dev            -> http://localhost:8787
//   PORT=3000 npm run dev
//
// Values in .dev.vars (KEY=value lines) become the Worker env, like wrangler.

import { createServer } from 'node:http';
import { readFileSync, existsSync, watch } from 'node:fs';
import { buildAll } from './build.mjs';

const root = new URL('..', import.meta.url).pathname;
const port = Number(process.env.PORT || 8787);

const env = {};
if (existsSync(root + '.dev.vars')) {
  for (const line of readFileSync(root + '.dev.vars', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

let worker = (await import(root + 'dist/worker.js')).default;
let generation = 0;

let timer;
watch(root + 'src', { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      await buildAll({ quiet: true });
      worker = (await import(`${root}dist/worker.js?v=${++generation}`)).default;
      console.log(`rebuilt (#${generation})`);
    } catch (err) {
      console.error('build failed:', err.message);
    }
  }, 80);
});

createServer(async (req, res) => {
  const started = Date.now();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('CF-Connecting-IP', req.socket.remoteAddress || 'local');

  const response = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body }), env, {
    waitUntil() {},
  });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  if (req.url.startsWith('/api/')) console.log(`${req.method} ${req.url} -> ${response.status} ${Date.now() - started}ms`);
}).listen(port, () => console.log(`Daily Sudoku running at http://localhost:${port}`));
