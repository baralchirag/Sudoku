// Daily leaderboards. Each (date, level) is one document holding the top
// entries, a solve-time histogram (for percentiles over *all* solvers, not
// just the top) and recent session nonces (so a token can only score once).
//
// Backed by Workers KV when a LEADERBOARD binding exists, otherwise by an
// in-memory map so the app still runs from a single pasted file.

export const TOP_SIZE = 50;
const NONCE_MEMORY = 2000;
// Histogram bucket upper bounds in seconds; the last bucket is open-ended.
export const BUCKETS = [60, 120, 180, 240, 300, 420, 600, 900, 1200, 1800, 2700, 3600];
export const HINT_PENALTY_MS = 30_000;

export class MemoryStore {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.get(key) ?? null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
}

export class KVStore {
  constructor(namespace) {
    this.ns = namespace;
  }
  get(key) {
    return this.ns.get(key);
  }
  put(key, value) {
    return this.ns.put(key, value, { expirationTtl: 60 * 60 * 24 * 400 });
  }
}

const emptyDoc = () => ({ total: 0, hist: new Array(BUCKETS.length + 1).fill(0), top: [], nonces: [] });

export const score = (ms, hints) => ms + hints * HINT_PENALTY_MS;

export function bucketOf(ms) {
  const s = ms / 1000;
  const i = BUCKETS.findIndex((b) => s < b);
  return i === -1 ? BUCKETS.length : i;
}

/** Share of all recorded solvers strictly slower than ms (0-100). */
export function percentile(doc, ms) {
  if (doc.total <= 1) return 100;
  const b = bucketOf(ms);
  let slower = 0;
  for (let i = b + 1; i < doc.hist.length; i++) slower += doc.hist[i];
  slower += (doc.hist[b] - 1) / 2; // assume the middle of your own bucket
  return Math.round((100 * slower) / (doc.total - 1));
}

export function sanitizeName(name) {
  const clean = String(name ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return clean || 'Anonymous';
}

export class Leaderboard {
  constructor(store) {
    this.store = store;
  }

  key(date, level) {
    return `lb:v1:${date}:${level}`;
  }

  async load(date, level) {
    const raw = await this.store.get(this.key(date, level));
    return raw ? JSON.parse(raw) : emptyDoc();
  }

  /** Public view: no nonces. */
  async view(date, level) {
    const doc = await this.load(date, level);
    return { total: doc.total, buckets: BUCKETS, hist: doc.hist, top: doc.top.slice(0, 20) };
  }

  /**
   * Records a verified result. Returns null when the nonce already scored.
   * KV is eventually consistent, so two simultaneous submits can race; the
   * nonce list makes replays of the same token harmless either way.
   */
  async record(date, level, { nonce, name, ms, hints }) {
    const doc = await this.load(date, level);
    if (doc.nonces.includes(nonce)) return null;
    doc.nonces.push(nonce);
    if (doc.nonces.length > NONCE_MEMORY) doc.nonces.splice(0, doc.nonces.length - NONCE_MEMORY);

    doc.total += 1;
    doc.hist[bucketOf(ms)] += 1;
    const entry = { name: sanitizeName(name), ms, hints, score: score(ms, hints), at: Date.now() };
    doc.top.push(entry);
    doc.top.sort((a, b) => a.score - b.score || a.at - b.at);
    const rank = doc.top.indexOf(entry) + 1;
    doc.top.length = Math.min(doc.top.length, TOP_SIZE);
    await this.store.put(this.key(date, level), JSON.stringify(doc));

    return {
      rank: rank <= TOP_SIZE ? rank : null,
      total: doc.total,
      percentile: percentile(doc, ms),
      buckets: BUCKETS,
      hist: doc.hist,
      top: doc.top.slice(0, 10),
    };
  }
}
