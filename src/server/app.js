// Wires the router, rate limiting, static assets and storage into a fetch
// handler. Kept separate from the Worker entry so tests can build an app with
// fake assets and a fake clock.

import { Router } from './router.js';
import { HttpError, json, errorResponse, withHeaders, CSP } from './http.js';
import { RateLimiter } from './ratelimit.js';
import { Leaderboard, MemoryStore, KVStore } from './leaderboard.js';
import * as api from './api.js';

const DEV_SECRET = 'dev-only-secret-set-SESSION_SECRET-in-production';
const DEFAULT_LAUNCH = '2026-11-01';

export function createApp({ assets, now = () => Date.now() }) {
  const router = new Router()
    .get('/api/health', api.health)
    .get('/api/daily', api.daily)
    .post('/api/session', api.startSession)
    .post('/api/hint', api.hint)
    .post('/api/submit', api.submit)
    .get('/api/leaderboard/:date/:level', api.leaderboard);

  const limiter = new RateLimiter({ limit: 90, windowMs: 60_000 });
  const memory = new MemoryStore();
  let warned = false;

  const staticRoutes = {
    '/app.js': { body: assets.js, type: 'text/javascript; charset=utf-8', immutable: true },
    '/app.css': { body: assets.css, type: 'text/css; charset=utf-8', immutable: true },
    '/favicon.svg': { body: assets.favicon, type: 'image/svg+xml', immutable: false },
    '/manifest.webmanifest': { body: assets.manifest, type: 'application/manifest+json', immutable: false },
    '/robots.txt': { body: 'User-agent: *\nAllow: /\n', type: 'text/plain', immutable: false },
  };

  function serveStatic(request, url) {
    const route = staticRoutes[url.pathname];
    const etag = `"${assets.version}"`;
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    if (route) {
      return new Response(request.method === 'HEAD' ? null : route.body, {
        headers: {
          'Content-Type': route.type,
          ETag: etag,
          'Cache-Control': route.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
        },
      });
    }
    // Every other path is a client route rendered by the single-page app.
    return new Response(request.method === 'HEAD' ? null : assets.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': CSP,
        ETag: etag,
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
    });
  }

  async function handleApi(request, url, env) {
    if (request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const wait = limiter.check(ip);
      if (wait) return json({ error: 'too many requests' }, 429, { 'Retry-After': String(wait) });
    }
    const { handler, params } = router.match(request.method, url.pathname);
    if (!env.SESSION_SECRET && !warned) {
      warned = true;
      console.warn('SESSION_SECRET is not set; using an insecure development secret');
    }
    const ctx = {
      request,
      params,
      env,
      now: now(),
      secret: env.SESSION_SECRET || DEV_SECRET,
      launch: env.LAUNCH_DATE || DEFAULT_LAUNCH,
      leaderboard: new Leaderboard(env.LEADERBOARD ? new KVStore(env.LEADERBOARD) : memory),
    };
    const result = await handler(ctx);
    return result instanceof Response ? result : json(result);
  }

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      let response;
      try {
        response = url.pathname.startsWith('/api/')
          ? await handleApi(request, url, env)
          : ['GET', 'HEAD'].includes(request.method)
            ? serveStatic(request, url)
            : json({ error: 'method not allowed' }, 405);
      } catch (err) {
        if (!(err instanceof HttpError)) {
          console.error(err);
          err = new HttpError(500, 'internal error');
        }
        response = errorResponse(err);
        if (err.status === 405 && err.details?.allow) response.headers.set('Allow', err.details.allow.join(', '));
      }
      return withHeaders(response);
    },
  };
}
