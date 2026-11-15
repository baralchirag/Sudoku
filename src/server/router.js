// A minimal router: "GET /api/leaderboard/:date/:level" style patterns,
// compiled to regular expressions once at startup.

import { HttpError } from './http.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  on(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/\/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  get(pattern, handler) {
    return this.on('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.on('POST', pattern, handler);
  }

  /** Resolves a handler, or throws 404/405 with an Allow header hint. */
  match(method, pathname) {
    const allowed = new Set();
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const verbs = route.method === 'GET' ? ['GET', 'HEAD'] : [route.method];
      if (!verbs.includes(method)) {
        verbs.forEach((v) => allowed.add(v));
        continue;
      }
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { handler: route.handler, params };
    }
    if (allowed.size) throw new HttpError(405, 'method not allowed', { allow: [...allowed] });
    throw new HttpError(404, 'not found');
  }
}
