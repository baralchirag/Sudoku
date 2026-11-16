// Fixed-window rate limiter kept in isolate memory. It is best-effort (each
// isolate counts separately) but cheap, and stops a single client hammering
// the hint and submit endpoints. Put Cloudflare's rate-limiting rules in front
// for hard guarantees.

export class RateLimiter {
  constructor({ limit = 60, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Returns seconds to wait, or 0 when the request is allowed. */
  check(key, now = Date.now()) {
    const windowStart = now - (now % this.windowMs);
    const entry = this.hits.get(key);
    if (!entry || entry.start !== windowStart) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { start: windowStart, count: 1 });
      return 0;
    }
    entry.count += 1;
    if (entry.count <= this.limit) return 0;
    return Math.ceil((windowStart + this.windowMs - now) / 1000);
  }
}
