// Daily Sudoku: single-file Cloudflare Worker. Built by scripts/build.mjs; edit src/ instead.

// src/server/http.js
var HttpError = class extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
};
var SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin"
};
var CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");
function withHeaders(response, extra = {}) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}
var errorResponse = (err) => json({ error: err.message, ...err.details ? { details: err.details } : {} }, err.status ?? 500);
async function readJson(request, maxBytes = 16 * 1024) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("application/json")) throw new HttpError(415, "expected application/json");
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw new HttpError(413, "request body too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "request body too large");
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

// src/server/router.js
var Router = class {
  constructor() {
    this.routes = [];
  }
  on(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/\/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return "/([^/]+)";
    });
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }
  get(pattern, handler) {
    return this.on("GET", pattern, handler);
  }
  post(pattern, handler) {
    return this.on("POST", pattern, handler);
  }
  /** Resolves a handler, or throws 404/405 with an Allow header hint. */
  match(method, pathname) {
    const allowed = /* @__PURE__ */ new Set();
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const verbs = route.method === "GET" ? ["GET", "HEAD"] : [route.method];
      if (!verbs.includes(method)) {
        verbs.forEach((v) => allowed.add(v));
        continue;
      }
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { handler: route.handler, params };
    }
    if (allowed.size) throw new HttpError(405, "method not allowed", { allow: [...allowed] });
    throw new HttpError(404, "not found");
  }
};

// src/server/ratelimit.js
var RateLimiter = class {
  constructor({ limit = 60, windowMs = 6e4 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = /* @__PURE__ */ new Map();
  }
  /** Returns seconds to wait, or 0 when the request is allowed. */
  check(key, now = Date.now()) {
    const windowStart = now - now % this.windowMs;
    const entry = this.hits.get(key);
    if (!entry || entry.start !== windowStart) {
      if (this.hits.size > 1e4) this.hits.clear();
      this.hits.set(key, { start: windowStart, count: 1 });
      return 0;
    }
    entry.count += 1;
    if (entry.count <= this.limit) return 0;
    return Math.ceil((windowStart + this.windowMs - now) / 1e3);
  }
};

// src/server/leaderboard.js
var TOP_SIZE = 50;
var NONCE_MEMORY = 2e3;
var BUCKETS = [60, 120, 180, 240, 300, 420, 600, 900, 1200, 1800, 2700, 3600];
var HINT_PENALTY_MS = 3e4;
var MemoryStore = class {
  constructor() {
    this.map = /* @__PURE__ */ new Map();
  }
  async get(key) {
    return this.map.get(key) ?? null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
};
var KVStore = class {
  constructor(namespace) {
    this.ns = namespace;
  }
  get(key) {
    return this.ns.get(key);
  }
  put(key, value) {
    return this.ns.put(key, value, { expirationTtl: 60 * 60 * 24 * 400 });
  }
};
var emptyDoc = () => ({ total: 0, hist: new Array(BUCKETS.length + 1).fill(0), top: [], nonces: [] });
var score = (ms, hints) => ms + hints * HINT_PENALTY_MS;
function bucketOf(ms) {
  const s = ms / 1e3;
  const i = BUCKETS.findIndex((b) => s < b);
  return i === -1 ? BUCKETS.length : i;
}
function percentile(doc, ms) {
  if (doc.total <= 1) return 100;
  const b = bucketOf(ms);
  let slower = 0;
  for (let i = b + 1; i < doc.hist.length; i++) slower += doc.hist[i];
  slower += (doc.hist[b] - 1) / 2;
  return Math.round(100 * slower / (doc.total - 1));
}
function sanitizeName(name) {
  const clean = String(name ?? "").normalize("NFKC").replace(/[^\p{L}\p{N} _.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 20);
  return clean || "Anonymous";
}
var Leaderboard = class {
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
      top: doc.top.slice(0, 10)
    };
  }
};

// src/engine/geometry.js
var CELLS = 81;
var ALL_DIGITS = 1022;
var UNITS = [];
var CELL_UNITS = [];
var PEERS = [];
var IS_PEER = new Uint8Array(CELLS * CELLS);
for (let u = 0; u < 27; u++) UNITS.push([]);
for (let i = 0; i < 9; i++) {
  for (let j = 0; j < 9; j++) {
    UNITS[i].push(i * 9 + j);
    UNITS[9 + i].push(j * 9 + i);
    const br = Math.floor(i / 3) * 3;
    const bc = i % 3 * 3;
    UNITS[18 + i].push((br + Math.floor(j / 3)) * 9 + bc + j % 3);
  }
}
for (let c = 0; c < CELLS; c++) {
  const r = Math.floor(c / 9);
  const col = c % 9;
  CELL_UNITS.push([r, 9 + col, 18 + Math.floor(r / 3) * 3 + Math.floor(col / 3)]);
  const peers = [];
  for (const u of CELL_UNITS[c]) {
    for (const p of UNITS[u]) {
      if (p !== c && !IS_PEER[c * CELLS + p]) {
        IS_PEER[c * CELLS + p] = 1;
        peers.push(p);
      }
    }
  }
  PEERS.push(peers);
}
var rowOf = (i) => Math.floor(i / 9);
var colOf = (i) => i % 9;
var sees = (a, b) => IS_PEER[a * CELLS + b] === 1;
var cellName = (i) => `r${rowOf(i) + 1}c${colOf(i) + 1}`;
function unitName(u) {
  if (u < 9) return `row ${u + 1}`;
  if (u < 18) return `column ${u - 8}`;
  return `box ${u - 17}`;
}
var popcount = (m) => {
  let n = 0;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
};
var lowestDigit = (m) => 31 - Math.clz32(m & -m);
function digitsOf(mask) {
  const out = [];
  for (let v = 1; v <= 9; v++) if (mask & 1 << v) out.push(v);
  return out;
}

// src/engine/board.js
var BoardError = class extends Error {
};
function parseBoard(input) {
  if (typeof input !== "string") throw new BoardError("board must be a string");
  const s = input.replace(/\s+/g, "");
  if (s.length !== CELLS) throw new BoardError(`board must have 81 cells, got ${s.length}`);
  const b = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 46) continue;
    const v = ch - 48;
    if (v < 0 || v > 9) throw new BoardError(`invalid character "${s[i]}" at ${i}`);
    b[i] = v;
  }
  return b;
}
function formatBoard(b) {
  let s = "";
  for (let i = 0; i < CELLS; i++) s += String.fromCharCode(48 + b[i]);
  return s;
}
var countClues = (b) => b.reduce((n, v) => n + (v ? 1 : 0), 0);

// src/engine/logic.js
var Technique = Object.freeze({
  HiddenSingle: 0,
  NakedSingle: 1,
  LockedCandidates: 2,
  NakedPair: 3,
  HiddenPair: 4,
  NakedTriple: 5,
  HiddenTriple: 6,
  XWing: 7,
  XYWing: 8,
  Swordfish: 9
});
var TECHNIQUE_NAMES = [
  "Hidden Single",
  "Naked Single",
  "Locked Candidates",
  "Naked Pair",
  "Hidden Pair",
  "Naked Triple",
  "Hidden Triple",
  "X-Wing",
  "XY-Wing",
  "Swordfish"
];
var LEVELS = ["easy", "medium", "hard", "expert"];
var digitList = (mask) => digitsOf(mask).join("/");
var cellList = (cells) => cells.map(cellName).join(", ");
function step(technique, fields) {
  return {
    technique,
    name: TECHNIQUE_NAMES[technique],
    index: -1,
    value: 0,
    eliminations: [],
    cells: [],
    units: [],
    ...fields
  };
}
var Grid = class _Grid {
  constructor() {
    this.vals = new Uint8Array(81);
    this.cand = new Uint16Array(81).fill(ALL_DIGITS);
  }
  /** Builds a grid from placed digits; returns null if givens clash. */
  static from(board) {
    const g = new _Grid();
    for (let i = 0; i < 81; i++) {
      const v = board[i];
      if (!v) continue;
      if (!(g.cand[i] & 1 << v)) return null;
      g.place(i, v);
    }
    return g;
  }
  place(i, v) {
    this.vals[i] = v;
    this.cand[i] = 0;
    const bit = ~(1 << v);
    for (const p of PEERS[i]) this.cand[p] &= bit;
  }
  apply(s) {
    if (s.index >= 0) this.place(s.index, s.value);
    for (const [c, v] of s.eliminations) this.cand[c] &= ~(1 << v);
  }
  filled() {
    return this.vals.every((v) => v !== 0);
  }
  /** An empty cell without candidates, or a digit with nowhere to go. */
  broken() {
    for (let i = 0; i < 81; i++) if (!this.vals[i] && !this.cand[i]) return true;
    for (const unit of UNITS) {
      let seen = 0;
      for (const c of unit) seen |= this.vals[c] ? 1 << this.vals[c] : this.cand[c];
      if (seen !== ALL_DIGITS) return true;
    }
    return false;
  }
  /** Empty cells of unit u that can still hold v. */
  positions(u, v) {
    const out = [];
    const bit = 1 << v;
    for (const c of UNITS[u]) if (!this.vals[c] && this.cand[c] & bit) out.push(c);
    return out;
  }
  /** Removals of v from empty cells in scope, skipping cells in keep. */
  eliminateFrom(scope, v, keep) {
    const out = [];
    const bit = 1 << v;
    for (const c of scope) {
      if (this.vals[c] || !(this.cand[c] & bit) || keep.includes(c)) continue;
      out.push([c, v]);
    }
    return out;
  }
};
var UNIT_ORDER = [...Array(9).keys()].map((i) => 18 + i).concat([...Array(18).keys()]);
var allInUnit = (cells, u) => cells.every((c) => CELL_UNITS[c].includes(u));
function combinations(items, k, fn) {
  const pick = new Array(k);
  const rec = (start, depth) => {
    if (depth === k) return fn(pick);
    for (let i = start; i <= items.length - (k - depth); i++) {
      pick[depth] = items[i];
      const r = rec(i + 1, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return rec(0, 0);
}
function cellMask(u, cells) {
  let m = 0;
  UNITS[u].forEach((c, j) => {
    if (cells.includes(c)) m |= 1 << j;
  });
  return m;
}
function hiddenSingle(g) {
  for (const u of UNIT_ORDER) {
    for (let v = 1; v <= 9; v++) {
      const pos = g.positions(u, v);
      if (pos.length === 1) {
        return step(Technique.HiddenSingle, {
          index: pos[0],
          value: v,
          cells: UNITS[u],
          units: [u],
          description: `${v} can only go in ${cellName(pos[0])} within ${unitName(u)}.`
        });
      }
    }
  }
  return null;
}
function nakedSingle(g) {
  for (let i = 0; i < 81; i++) {
    if (!g.vals[i] && popcount(g.cand[i]) === 1) {
      const v = lowestDigit(g.cand[i]);
      return step(Technique.NakedSingle, {
        index: i,
        value: v,
        cells: PEERS[i],
        units: CELL_UNITS[i],
        description: `${cellName(i)} sees every digit except ${v}, so it must be ${v}.`
      });
    }
  }
  return null;
}
function lockedCandidates(g) {
  for (let v = 1; v <= 9; v++) {
    for (let b = 18; b < 27; b++) {
      const pos = g.positions(b, v);
      if (pos.length < 2) continue;
      for (const line of CELL_UNITS[pos[0]].slice(0, 2)) {
        if (!allInUnit(pos, line)) continue;
        const elims = g.eliminateFrom(UNITS[line], v, pos);
        if (elims.length) {
          return step(Technique.LockedCandidates, {
            eliminations: elims,
            cells: pos,
            units: [b, line],
            description: `In ${unitName(b)}, ${v} is confined to ${unitName(line)}, so it can be removed from the rest of ${unitName(line)}.`
          });
        }
      }
    }
    for (let line = 0; line < 18; line++) {
      const pos = g.positions(line, v);
      if (pos.length < 2) continue;
      const b = CELL_UNITS[pos[0]][2];
      if (!allInUnit(pos, b)) continue;
      const elims = g.eliminateFrom(UNITS[b], v, pos);
      if (elims.length) {
        return step(Technique.LockedCandidates, {
          eliminations: elims,
          cells: pos,
          units: [line, b],
          description: `In ${unitName(line)}, ${v} is confined to ${unitName(b)}, so it can be removed from the rest of ${unitName(b)}.`
        });
      }
    }
  }
  return null;
}
var subsetTechnique = (naked, n) => naked ? n === 2 ? Technique.NakedPair : Technique.NakedTriple : n === 2 ? Technique.HiddenPair : Technique.HiddenTriple;
function nakedSubset(g, n) {
  for (const u of UNIT_ORDER) {
    const cells = UNITS[u].filter((c) => {
      const k = popcount(g.cand[c]);
      return !g.vals[c] && k >= 2 && k <= n;
    });
    if (cells.length < n) continue;
    const found = combinations(cells, n, (pick) => {
      const union = pick.reduce((m, c) => m | g.cand[c], 0);
      if (popcount(union) !== n) return null;
      const elims = digitsOf(union).flatMap((v) => g.eliminateFrom(UNITS[u], v, pick));
      if (!elims.length) return null;
      const pattern = [...pick];
      return step(subsetTechnique(true, n), {
        eliminations: elims,
        cells: pattern,
        units: [u],
        description: `${cellList(pattern)} in ${unitName(u)} can only hold ${digitList(union)}, so those digits can be removed from the rest of ${unitName(u)}.`
      });
    });
    if (found) return found;
  }
  return null;
}
function hiddenSubset(g, n) {
  for (const u of UNIT_ORDER) {
    const digits = [];
    const posMask = {};
    for (let v = 1; v <= 9; v++) {
      const pos = g.positions(u, v);
      if (pos.length >= 2 && pos.length <= n) {
        digits.push(v);
        posMask[v] = cellMask(u, pos);
      }
    }
    if (digits.length < n) continue;
    const found = combinations(digits, n, (pick) => {
      let cellsMask = 0;
      let digitMask = 0;
      for (const v of pick) {
        cellsMask |= posMask[v];
        digitMask |= 1 << v;
      }
      if (popcount(cellsMask) !== n) return null;
      const cells = UNITS[u].filter((_, j) => cellsMask & 1 << j);
      const elims = cells.flatMap((c) => digitsOf(g.cand[c] & ~digitMask).map((v) => [c, v]));
      if (!elims.length) return null;
      return step(subsetTechnique(false, n), {
        eliminations: elims,
        cells,
        units: [u],
        description: `In ${unitName(u)}, ${digitList(digitMask)} fit only in ${cellList(cells)}, so other candidates can be removed from those cells.`
      });
    });
    if (found) return found;
  }
  return null;
}
function fish(g, n) {
  const technique = n === 2 ? Technique.XWing : Technique.Swordfish;
  const orientations = [
    { base: 0, cover: 9, baseKind: "rows", coverKind: "columns" },
    { base: 9, cover: 0, baseKind: "columns", coverKind: "rows" }
  ];
  for (let v = 1; v <= 9; v++) {
    for (const o of orientations) {
      const bases = [];
      const masks = {};
      for (let b = 0; b < 9; b++) {
        const pos = g.positions(o.base + b, v);
        if (pos.length >= 2 && pos.length <= n) {
          bases.push(b);
          masks[b] = cellMask(o.base + b, pos);
        }
      }
      if (bases.length < n) continue;
      const found = combinations(bases, n, (pick) => {
        const cover = pick.reduce((m, b) => m | masks[b], 0);
        if (popcount(cover) !== n) return null;
        const pattern = pick.flatMap((b) => g.positions(o.base + b, v));
        const coverLines = [...Array(9).keys()].filter((j) => cover & 1 << j);
        const elims = coverLines.flatMap((j) => g.eliminateFrom(UNITS[o.cover + j], v, pattern));
        if (!elims.length) return null;
        return step(technique, {
          eliminations: elims,
          cells: pattern,
          units: [...pick.map((b) => o.base + b), ...coverLines.map((j) => o.cover + j)],
          description: `In ${o.baseKind} ${pick.map((b) => b + 1).join(", ")}, digit ${v} only appears in ${o.coverKind} ${coverLines.map((j) => j + 1).join(", ")}, so it can be removed from the rest of those ${o.coverKind}.`
        });
      });
      if (found) return found;
    }
  }
  return null;
}
function xyWing(g) {
  for (let pivot = 0; pivot < 81; pivot++) {
    const pc = g.cand[pivot];
    if (g.vals[pivot] || popcount(pc) !== 2) continue;
    const wings = PEERS[pivot].filter((p) => {
      const c = g.cand[p];
      return !g.vals[p] && popcount(c) === 2 && c !== pc && popcount(c & pc) === 1;
    });
    for (let i = 0; i < wings.length; i++) {
      for (let j = i + 1; j < wings.length; j++) {
        const a = wings[i];
        const b = wings[j];
        const ca = g.cand[a];
        const cb = g.cand[b];
        const z = ca & cb & ~pc;
        if (popcount(z) !== 1 || ((ca | cb) & pc) !== pc) continue;
        const zv = lowestDigit(z);
        const elims = [];
        for (let c = 0; c < 81; c++) {
          if (c === a || c === b || c === pivot || !sees(a, c) || !sees(b, c)) continue;
          if (!g.vals[c] && g.cand[c] & z) elims.push([c, zv]);
        }
        if (!elims.length) continue;
        return step(Technique.XYWing, {
          eliminations: elims,
          cells: [pivot, a, b],
          description: `Pivot ${cellName(pivot)} (${digitList(pc)}) with pincers ${cellName(a)} (${digitList(ca)}) and ${cellName(b)} (${digitList(cb)}): one pincer must be ${zv}, so ${zv} can be removed from cells that see both.`
        });
      }
    }
  }
  return null;
}
var FINDERS = [
  hiddenSingle,
  nakedSingle,
  lockedCandidates,
  (g) => nakedSubset(g, 2),
  (g) => hiddenSubset(g, 2),
  (g) => nakedSubset(g, 3),
  (g) => hiddenSubset(g, 3),
  (g) => fish(g, 2),
  xyWing,
  (g) => fish(g, 3)
];
function nextStepOnGrid(g) {
  for (const find of FINDERS) {
    const s = find(g);
    if (s) return s;
  }
  return null;
}
function nextPlacement(board, maxSteps = 40) {
  const g = Grid.from(board);
  if (!g || g.broken()) return null;
  const chain = [];
  for (let n = 0; n < maxSteps; n++) {
    const s = nextStepOnGrid(g);
    if (!s) return null;
    if (s.index >= 0) return { placement: s, chain };
    chain.push(s);
    g.apply(s);
  }
  return null;
}

// src/server/crypto.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var keyCache = /* @__PURE__ */ new Map();
function importKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify"
    ]);
    keyCache.set(secret, key);
  }
  return key;
}
function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(str) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmac(secret, message) {
  const key = await importKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}
async function signToken(secret, payload) {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const sig = base64url(await hmac(secret, body));
  return `${body}.${sig}`;
}
async function verifyToken(secret, token) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  try {
    const key = await importKey(secret);
    const ok = await crypto.subtle.verify("HMAC", key, fromBase64url(token.slice(dot + 1)), encoder.encode(body));
    return ok ? JSON.parse(decoder.decode(fromBase64url(body))) : null;
  } catch {
    return null;
  }
}
function randomId(bytes = 12) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// src/data/bank.js
var TECHNIQUES = ["Hidden Single", "Naked Single", "Locked Candidates", "Naked Pair", "Hidden Pair", "Naked Triple", "Hidden Triple", "X-Wing", "XY-Wing", "Swordfish"];
var BANK = {
  easy: [
    "6800305700548073020072046980600201035030100000405000074016089000951400000703054006829315749548673123172546987684291535237168491495832674316789258951427362763954810",
    "1003209000406190539005000600700060100042806790914730280178050060060304010200000051653289477426198539835471622789563145342816796914735284178952368567324913291647850",
    "0805060706000135020310780940071059001600072000030047080000010270080591360003004599825463716749135825312786948471259631698372452536947183954618274287591367163824590",
    "0895713260259300006000800000401600038170040095367208403040000000500006802006450304895713261259364786734829159421687538173542695367298413648175927512936842986451370",
    "8240010300504301890900000740308500264002005100650000075090003606070409503000057488249716357564321891935862749318574264782695132653148975497283616871439523126957480",
    "3800000000062078000108050091200000306003421858000500070004786924900210502605030143829645719562178437148352691257894366793421858431569275314786924976213582685937140",
    "0705039001502907433800000050001064500400370020270053817050800000020008769307010202745139681562987433896742158931264575418376926279453817654821394123598769387615240",
    "0003867000600000828590721000030402067142600952065003404280009016300040000050210001423867593671594828594721635839472167142638952965183474286359716317945289758216340",
    "8513402000600913050028000460000006000380005949000200104037590626270830000091024008513462797642913853928751461759346282386175949465287134137598626274839515891624370",
    "3070050002007395069001204070090400080000916700060082000009007157038049620905008433674851292147395869851264371296473585382916744763582918429637157538149626915728430",
    "0000760400003510090130098003920647011047020565600000940302180070000300122706050009258761437483516296134298753925647811847923565671832944392185678569374122716459380",
    "9010632400842106570760080310000370000008200000001900656200800704053720860109003009517632483842196572765489315496378121678254938321947656234815794953721867189563240",
    "2901036080802060001650000929270048504000059066519300200065700008024000095400800002941536787832961451658473929276148534387259166519384273165792848724615395493827610",
    "6059800701070048060096005305001024600183460054020093000710056000000080033060910806459832711375248962896175345931724687183469254628593178712356499247681533564917820",
    "1070002000237684050400213907000421302093000040000975085104006030001560400040700011579342869237684158465213977658421392893157644316975285124896733781569426942738510",
    "5678300201495728000004900074100000003000002858750093019002050300500000026030471505678314291495728632384965174123589763967142858756293419812657347541836926239471580",
    "1700308960200680078567040030080020049076030850020507007910063020050100000830005701742358963291684578567941235389726149176432854628517397915863422453179686834295710",
    "8300010600208007046070009180926800570685032090030700802000586030050600009000328058397415625218967346473259181926843577685132494532791862741586933859674219164328750",
    "8009507000040079250000000460004002000080126590010900074270631905100283646001400708629547131346879259752318463964752817483126592518964374275631985197283646831495720",
    "5090010000410500000007008510500270040109400830340800753070105401800607204005793105798314628416529372637948516583271947129456839341862753972185461854637294265793180",
    "1592600470847039520020050003270900600910000008004200300408095000006320900030540261592683476847139527329456813275914684913862758654271392468795135186327949731548260",
    "0000720008369007427926003510001004700030045066147538090005070000470690305000000604513726988369157427926483512851964739732845166147538293695271841478692355284319670",
    "0712069034865030100200004652900571400000020090009100001034008000470385000501096305712469834865937123297814652983571467148623596359142781634258979476385218521796340",
    "9004516000000000006510270300050809602007040500090650048900030061462780930070492109834516727249361856518274394153829672687943513791658248925137461462785935376492180",
    "8000400024200010967090061300850126000406093006020500003000980505100340092940657008619435724235718967598261349853126471476893256324579183762984515187342692941657830",
    "2143006005300800000980140731504700699000325007000058000250400000010004204608207512143976855372861946985142731524783699861325477439658128257419363716594284698237510",
    "4681027500300846900006504017594100000430701600000000740810305000045000005028470064681927531357846929276534817594162382439781658163259746812395473745618295928473160",
    "2005080005070042369000260050000004200709320000504671000206093413002056790097130002365789145871942369413267856938514271749325688524671937256893413182456794697138520",
    "9130000200040100690807941037490380100600503000500010906273895408005007004050200009138654275742138692867941537496382151689523743524716986273895418915467324351279860",
    "0205946814000600006187200590030097409420701630010002080060075000906008370000500203275946814591683726187234598632197459428751635714362982369875141956428377843519260",
    "9400728010006000055100000201008430020507064180040590006050912742000801060000650899465728317326189455189346271678435923597264188241597636853912742934871564712653890",
    "0400076580002500415876019009000060000081703626725031000050100700398640000207050002419376583962587415876419239134265874581793626725831948653124797398642151247958360",
    "1295600730740380008000104520080003070103090059078502140406000202054010000800000411295648735742381698639174526581423974123796859378562147416935282954817363867259410",
    "0029300803600420095906100401004809700850761000730502000107605202073000100000018907429356813618427595986173421264839759852761344731592688197645232573984166345218970",
    "1020360900090040065002198300070000858901000000430850607016504294000006530503021001728365943895742165642198376174239858951673422439857617316584294287916539563421780",
    "0060407004702000983209000410020000740006940300030208066003024802307001597504093008961457234712635983259786415628319741876942359435278166193524872347861597584193620",
    "0000049579007802037000054080700010850806003010318500093020670000460100025002480361683249579547862137231954682794316854856793216318527493125678948469135725972481360",
    "8920000013006400200000190005194000704200070100079000452801040060705268040468730508927354613516489277642195835194623784283576196379812452851947361735268949468731520",
    "5600000907010006004002967000506024100200419800140700069401052780708040600809003405627138947914586324382967513596824176275419838143795269431652782758341691869273450",
    "0000001061005200870001000056708002015020916000410700007000409032539078640003567123257841961645293879871634256798352415324916788416725397162489532539178644983567120",
    "3849612751090000000000280046000103008010005074007800210060020002006457089580730023849612751294578365673289146725143898912365474357896217468921532136457989581734620",
    "0520608147082100033040950000007006406000210800396400070010069002961504000009801059523678147682145933148957268257396416475213891396482575814769322961534784739821650",
    "2080410305000000040100060000078050463051007808900035126005300017510009000306198572789416355637281949143562781278953463451627898964735126895374217512849634326198570",
    "3910000806400700237200090010070923150108006045367400002095004681509000000000071503912547866451789237283695414876923159128356745367418922795134681549862378634271590",
    "6200038500046152000930000700704003000009810000400279800592741004001395083000680096217938547846152935938426719784563122359814671463279858592741364671395283125687490",
    "7000380522647018930800007140080070060030040800021039471260000705078002000092000607914386522647518933859627144185973269736241856521839471263495785478162398392754610",
    "0000063020000026703005870100042680506009502402517400600468205000200054000106347001754963824983126753625879149342681576879512432517438697468295318231754965196347280",
    "0000758300008100708000030202039061070167300000871509600054280103485010900010900501642758395328196748796435212539861479167342854871529637954283163485617926213974580",
    "0010840966387100020200308011000020037020915483400650208100000304000280002970500005712843966387194529245368711854729637623915483498651278169472354536287192971536840",
    "9410700068032090452600008000070009346801007520300200080085072600000005970020064819418753268732691452653418791276589346841937525397246184985172633164825977529364810",
    "5000600029070084161300000857410060206027458310009200400702000088030002742090700005841673929275384161364927857413865296927458313589216474752139688136592742698741530",
    "0048060090907054231050090780032015040190037820000003618400000070309040100000782063748261596987154231254396787632815945196437824825973618461529372379648159513782460",
    "0420006900096324053659400006002710000930040075010800044280050300000900029060230788421576937196324853659487216842713592935648175713892644287159361378965429564231780",
    "0000905000540060000012403060864390505000004080107082030059876000721038050680040376238915748543761297912453862864397515376124984197582633459876129721638451685249370",
    "0040800925123900060690005730000203510000000000910607280081500344508390001006709807345861925123978468692415736479283512857134693914657289781526344568392171236749850",
    "4600007230006000009004870560002003008731600020907340180053060846148790300095000004689517231576238499324871565412983678731654922967345187253169846148792353895426710",
    "8000365700250003100102080900090050800460907202584700030025600305070008000613802078941365726257493187132586943796254811468937252584719634825671395379128469613842570",
    "0500002001482705000008107000104098002067010934793801060050439080910000470006073006579342811482765399328157645134698722867514934793821567651439283915286478246973150",
    "5007000488405000216134207090580410001623070800906820050000348060000960070000700105297136488475693216134287597589412631623579843946821752751348964812965379368754120",
    "0895746002019005040408100000581000600026050086943800100604901500050603900230008003895746212719365845468127397581294631326459786943872158674931524152683979237518460",
    "6010007280009073400300861957804000000200005045043712000480059600107048529000000306915437288529173464372861957894526131238695745643712892481359673167948529756284310",
    "6830002900096000040008901608100005463000400094900810200617004027249150380080000706831542971596273842478931658123795463752468194965817239617384527249156385384629710",
    "0267590005003410080010009502580030090040000061002903006839007144020805037150300008267594315793416283418629572586731499345182761672943856839257144921875637154368920",
    "0015800460800270000004012380900005204600520808023000706309700120090350607080060539215837463846271955764912381937685244671523898523496716359748122198354677482169530",
    "0290000404002500913010065006300000009150207007406019800901050701079620080647030505293178464762583913814965276385792149158247637426319858931456721579624382647831590",
    "8002000900069580070007106827050000080020090340046800290708930060684279002400000738172364954269583179537146827953421686821795341346857295718932463684279512495618730",
    "1038002900802130002450900010785000000019703040904015029000047088000600236073084001638452977892136452456978314785329165219763843964815729321547688547691236173284590",
    "0321640580065073008752306004506000303000000006070900050000705000100204797690458209321647581465873928752396144586129373917582466274931852849715635138264797693458210",
    "0060081790580790060706030500371052800000805074000006000042070035008410000209368453465281791584793262796134589371652846123845974857926318642579135938417627219368450",
    "9230450000609102001708200600301080002000763904162005703805019200413000006000800509236458178649172351758234697391586422584763914162395783875619245413927866927841530",
    "0004500800800000000003870908100023075746109082308746510001004704010680093670000051924567837839215646453871928165923475746139282398746519281354764517682393672498150",
    "0059040310003000079130076506000780001700009035040031780064020198007005422070093007859642314623518979138276546391784251782459635246931783564827198917365422475193860",
    "0628073040002610870900001003265184008007005300003000009056847030370020000840706901628973544532619877984351623265184798417295365793462189156847236379528412841736950",
    "0130584060503200002479615000000000404008900726214008900080402505002000000726359009137584268563247192479615387895126434358961726214738953681492575942873611726359840",
    "1000403900648395100907000409470680056080000700014000607392040564009500030000760801756423982648395178937156429471682356285934713514278697392841564869517235123769840",
    "5000620030105740000028394503010005690000962004960050802600000050040500700597238065481627939135746286728394513214875697853962144962153872679481358346519721597238460",
    "0013604080031076007602400102704001009367800504000230003000100001008769036070008215213694788431576927692483152784951369367812544156237893849125671528769436975348210",
    "0305049164700000800500130000000500043400260982000497009206813000030070407104350698325749164719625836598134721973586243457261982861497359246813575632978417184352690",
    "3007009010123950700408160000900600101209005005060010000000781456812040070500306283657429818123954769478162534985637121239875645764218392396781456812543977541396280",
    "0008710047216005000000020600967200000003109003024056809035070160070498032500607405698713247216345988349521671967284354853169723724956819435872166172498532581637490",
    "0000005097010008202906001704027306080760813501005642000198700000370520000040107803681275497413958262956481734527396189762813541835642975198764328374529616249137850",
    "5782036140240180000030408290070023060951600002800004000014809008009301400390010005782936149246185736137458291478523963951642872863794517514869328629371454395217680",
    "5901028006079030401006800000500300260600207134307015000190700308050061703000059045931428676879532411246873597518394269685247134327615982194786358453961723762159840",
    "9007530000100045080050000390092703066043109070304602505400267030609010050020300609867534122136945784751826391592783466243159877384692515418267933679418258925371640",
    "5009300060068070301004659020321007004007536090502068038940100603000800400150000905289314769468271351734659826321987544817536297592468138943125673675892412156743980",
    "2130090547680302009041000005470030080060040020090705434809006050013500070700469002137698547684352199541283765472931681365847928296715434829176356913524873758469210",
    "0000006800800020031608930720209304160037160989162487002000040000003200548005000203724516895896721431648935727289354164537162989162487352351849676913278548475693210",
    "0093054707084600004630012505000300046940500028072000903457000099000208011020940002193854767584629134639712585218397646941573828372461953457186299765238411826945370",
    "0700001632000009056015807240092000400346070500200400090071320900108704300520640015784291632437169856915837248692513471346972587253486194871325969168754323529648710",
    "0000030008000120930500000080050083709371600801807356095742900300200560000183400527916835248465127932534791684659283719371642851827356495742918363298564176183479520",
    "8070000101925048004600000022016050030090170280709081460060700850001004090348906008572693141925348674637819522816457936493175283759281469164732857281564395348926710",
    "0090451735030010004010938000507000040420805000070569000160304800945680310800000968692451735238716494716938529587123646423895171374569282169374857945682313851247960",
    "6008379500059400004300217689002580365000004201200030902000853097003000820000906006128379548759462134395217689472581365836194271264738952641853797913645823587926410",
    "0802073012051040009100680040090005800280560001540090320410800908300001266900100404862973512751349689135682743694215877283564191548796325416827938379451266927138450",
    "0004008739800630500040006020050320070030500200216970450009002305092410080480760101564298739827634513745186924651329877938541268216973456179852345392417682483765190",
    "9241050701704300920000974610900200048300100054008000090605092033000020872000709069241653781764385925832974616957238148379146254128567397615892433596421872483719560",
    "0270010530307500000050261978006050047031005005028470003005008622760089009002000016279814531397546284853261978916352747431925865628473193145798622764189359582637410",
    "9007100080100060205060423000752600002605387900000745000080201067030809400500072839427136583178564295869423171752698342645387918391745624983251767236819456514972830",
    "0600590310398000541020300960007003459005030003400000020700085030900106270106754098642597317398612541524378966817923459275431683451869724769285135983146272136754890",
    "0007906030002600183205100702900000800100320500500710928704060354000508695000802401857946239472635183265189742936457817189324566548713928794261354321578695613892470"
  ],
  medium: [
    "5000000300070090000010527007000000200000350043006100004000030000705008490500960005861749322378694519413527867659481231982356743246175984197832656735218498524963171",
    "0008020001020070309000017022973800104601003080010500060000605000000000670200000043748926511526478399865317422973864154651293788317542967194685235482139676239751841",
    "2000000004032090106017800007000000000003500965000162000000000380040900670000010522791356844832697156517843297369285411423578965984162739156724388245931673678419521",
    "3000100200400028070000000500006007000002080310504000600005000702840930000031000003978154261453628976289471538326517494692785317514392689165843722847936155731269841",
    "0025000309000421508007000020000000007908000606040000150000000000060580070034900861625897349376421588457136923581642797918254636249378155892763414163589272734915861",
    "0000507000079000005300400020106903040602010000000000804080000070008100000090740009461527382879634515317486928156973243642815797924351864583269176738192451295748631",
    "0060003090000900160010000825001002089800000070600270000000800900030000017004000004562183792785934163917645825371492689826351471648279356253817948439726517194568231",
    "0000900007000063050140000000270010800080000030000000490000000515930046000000057002351984677892463156143578929274315861485692733568721494726839515937146288619257341",
    "0000700002000300007060080956230405010000016030003000293000000009004000180140620001359748622986351747462183956237495818795216434513867293821974569674532185148629371",
    "0040009080053080020000400000790140050000860100000007207001004500060500000000006001346259789653781428279415363792148655427863196815397247981624534168532972534976811",
    "0307008004700000068056000046000153000080390010102000000820004600010080050005000001367548294791825368256937146978153422584396713142679585829714637613482959435261871",
    "3000000970080001060010760001509000000000500700070086006094000000000300400040005023625418974782931565918764231539672842861543799473286156294857317156329488347195621",
    "2000079500970034000000000008400600070058700040003400001047305867006502000030200002614879535972134684385961728429653173158726949763418251247395867896542316531287491",
    "9587200000200500007100842090050003002000030000002100060030009028021306000070004009587261433249518677163842596754983212816735944392157865638479128421396751975624381",
    "5000000000071200000004007003000000017016089320427000680290000008702000000068050005149873266971238542834567193685924717516489329427315681293746858752691434368152971",
    "0040001201020300740000200008050046003000000000000904000903067002000000086007000099348671251629358745874219368152746933496182577265934814983567122731495686517823491",
    "4002000000001000007130900002003400005380000700600050000900800100000029060000004834862573919521638477134986252793415685389261741648752393956847128417329566275194831",
    "0913000004061000082378000400005200000000009070400000050830052000000000700240600318913467524561723982378591466795214835186349273429876157834152691652938749247685311",
    "2007005800050206000000687000400000060003000003096000500000009408004072000700000182617495837851236949345687215479821366283514793196748521528369478934172654762953181",
    "0020090300013000407000000020030068005800900100068004099000607800000700600000100048426591376513279487394816522931468755847923161768354299152647834289735613675182941",
    "0000007090005004008600105009000000000060000000010902062000310706000070280040091001453827693925764818679145329286453174761238955317982462598316746134579287842691531",
    "2006000000800010040040730000080051000200000900003400001000500073002008100750000002516843797839215646945732814387951265278164939163427581624589373492678158751396421",
    "0000600000900702000070084033007900000090030600040010070002807009026003008000000501483625795931742862679584133157968247298431656845219374362857919526173488714396521",
    "7300002100000350900000180000050030606708000003000478005000006000400860092000900007384692154612357989527183468159234676748519323296478515931726841473865292865941731",
    "2000000000000900400060007290008700000379012050654000900017080020091500006080000002946173587835926411563847299128754364379612858654231975417389623291568746782495131",
    "0000300207200000090007004054020500170070090005006000000000720608000639400600900081589347267245861399367214854923586176172498535836172943498725618751639422614953781",
    "0000900300007100046405000000000070960080007009070603050100090000020804007004010001758946322837169546495321784513278963689457219271683458142795635926834177364512891",
    "5000200090093000400180706301000020060520810030800900100210005008050000700068000005631247892793681454185796321974328566527814933846952177219435688352169749468573211",
    "5006080001200308000007001300900000008054700600000050744000090000000800000600400905736184291269348579487521367942635818354719626128953744873296152591867433615472981",
    "0010700008700030140960043006000000090004391600000867200040900010600000089023004004319756828752639142968143576537218497284391651495867235846972313671425989123584761",
    "0000900007001000090390540606580701000208000040003600000010804300630009500020307002456983177861235491397542686584791233278156949143628755719864328632479514925317861",
    "9000000000065004000307040000100530008000000210400097060000100050200000400084000729543682177865214392317945686172538948956473213421897564739126855298761431684359721",
    "0180604500600008170001000067208000030000200908500370606000080059002000000816400003187624592653948174971853267268195431345267988594372616429781359732516845816439721",
    "0008020100025000009000000044000900780000060015014800000000300000000000868009070326538429171425798639873612544261953783987265415714836292146387957392541868659174321",
    "0050030601407800000006001070084079000030900100001000002000010000000000300300407018759132641467825933926541875184379267238964159641253782573618494815796326392487511",
    "0070090005000070010280000500000019000600900852093000000000000000006501080800403904175298635968374213284167598542619371637942852793856146319785429426531787851423961",
    "0000009040930205060500070100000036400000020000075100801057600900304000000840000602716859348931245764563972185128736493689427519475163821257684936394518277842391651",
    "7803000600600800300000504070040000001500000960200007000306001009402100002000008507853249614617895323921564878749623151538472966295317485376981249482156732164738591",
    "0301000090000000070100054007060000088006000019010200400607800000000090040900417004351786292894365176172954837469132588236549719518273463647821951725698345983417621",
    "0007000000906000300001300500072000030100570288523000940064002005498000000030160706357891424916258377281349569672485133149576288523617941764932855498723612835164791",
    "6001000000400900070090705000000000360680047004007000000800009620503000000010068006271453981458936278396725417129584365682347194937612853845179622563891749714268531",
    "3000941000687003001008000400904030800060000027800200050000820000070090000005000003752941684687153291298365472914537865369784127846219359531826748473692516125478931",
    "8546200010600500000000100605020000000000406006070012540009020079251000000010030008546273911634597282793184655427961833182456796978312544369825179251748367815639421",
    "0000405090000700000098000062009000580000000646304070208020040000407082000530160003671425895816794324298351762149637587985213646354879218723946151467582939532168471",
    "4000063080008105000000020600000000010900870206000000002030000009054000030000780054129563787698135425387421698572649313915874266241398572836957149754216831463782951",
    "0024007000008003927010090600400009136030040000053000400709021500290400080500000009324567815648713927812394658476259136931845272153978463789621541295436784567182391",
    "4000000000000007092570000469000280010306400000807900000005000005082063000700002954691578328134627592579831469463285717356419281827954633245196875982763146718342951",
    "5080600107309000600498517321700030480000000010030180902000000000050209700070050065283674197319428656498517321726935488965743214532186972647891533851269749174352861",
    "0003080090000504010000040000004060904000820031629035000090000460082000002500000005413286798267594319731648253854167924975821631629735847198352466382419572546973181",
    "4000005000000004390000090000902000000710000002560000070800200450004006080000183904397815267186524395623498718942671533718952642561349871839267459254736186475183921",
    "9000640050050073083040001060017800000800300000001000000000002042004000300006030109183647256259173483748521964317896525892364717621459831935782642564918378476235191",
    "9010084050040000090000001000508197002004000800100720001702000560400900006380570009617284353845612797259431684568197232974356818136725941792843565423968176381579421",
    "0000000000000000370400020163060080000040193001003000420600400000102060052000500706821734599516842377435928163764285915247193681983657428659471234172369852398516741",
    "0000670329000005002063000080010530007000080400000200050000000500050306904000007015841679329378425162163954786419532877526183493987241651294768538752316944635897211",
    "0090500080024009000800100700000050004500030067000000000080000600003200510157000201392576486724389155846193728269451374518732967931625842485917639673248513157864291",
    "6084700000000100200003000751000400900002000000400607089600005000000070007506040016284753195378194264913268751857436923762981542495617389631825478149572637526349811",
    "0600004003801027060000800010170000500000100070000781491008069000000203040390010055613974283841527967926845314172698539584132676235781491458369728769253142397416851",
    "1500709300000004800300000069001000040000060006030000900000000005900108007603000211568749322796314854382591769271836548459263176137452983815627495924178637643985211",
    "0000008060010003400000480099208006030672000000045000002000010070730020804000095007491358266819273453526487199258146738672931541345762982983514675734629814167895321",
    "0000054000027000034070100200041800500090020600300000147002006000065970000200305001938254768527641934673198256741839525194723682389567147852416393465972819216385471",
    "1060980000730000000000420300041000070072860009080302010090000057320600090800000001463985722736154988957421366241593873172869549584372614698237157325618495819746231",
    "0300400000009000009003018070726000006000800505800024001600047000005060010200030002317485698479651239563218474726593186134879525891324761682947353945762817258136941",
    "7060205000007001200020050070000020300000048194900000000809300500500082700000000007463215985387491269128653478671924353256748194915837622849376516594182731732569841",
    "0090600200007000045000130009600000831000000000020061006000950700870040900000000107394685212167598345482137699645712831738429568529361476213954783871246954956873121",
    "0560047000090700000000000040640200800000804101300490050000920005800302400024008363562147984195783628279631547641259832953864171387496256438925715816372499724518361",
    "1000009000706000002490180000040067000007000680060300500070248904003000005020004101654739823786925412495183768142567399537412687268391546371248954913856275829674131",
    "0005090620083000003000008790000000100054006001406000500640100080000640007009200064175893626983721453521468798362579142754916831496382579647135285238647917819254361",
    "0000010006005098000980000000750000090003200700200000002000000900062001050300050407426819536135498275987324163754162894693285718219573642541637989862741351378956421",
    "0005001003006020042000900308060000410790506005000060000040000000009280000980002109475831263856127942617948358362795414793516825128463796241379581539284677984652131",
    "7000000090060030150100000006000200072006000003008100900620010000070468020900007017481653299267834155134926786813295472796541833548172968625719341379468524952387611",
    "0600130488040092010000800000810050000900004055020060030006021500000306070090000249672135488547692311235847964813759623961284755724968137386421592459316876198573241",
    "0000009000000700104000827007002003000090000078000346502100030040000000005008060001876459326523794184931827657652983413495612878217346592169538749384175265748261931",
    "0090080030010305003006020011200000700000892460000000058500000029000270046028003005697184232719345683846527911263458797351892464982761358574639129135276846428913571",
    "9500170000002040100019007003100000002067310907050003200205098000908000000080702009523174868732649154619857323194526782867315947456983211275498636948231575381762491",
    "0430100761804700006700038400000000055001300094100007388207000000500806000000450002439185761854762936792538413978241655681374294125697388267913549543826177316459821",
    "0010005200000000040700080100201009306005000020590000400059000600007300800020000039614735282386517945742983164271869356135498728593276413859124671467352897928641531",
    "0053070090200000510080200000000010000008300960070000000005140084002009000000090601653472897236984519481256378369715425148327962974568136795143284812639753527891641",
    "0000709000800020000270300480000403610000075006045030000002904030983006000030050003468719529814527365276391487529483618391675246145238971752964832983146754637852191",
    "3005900620000015405100007900002006009070000012000789300000043850003850100009004703485971627968215435126437984812396579374568212651789341297643856743852198539124761",
    "0004000006940000000100070000020410800650004000800500968400093101000206400000007007284169356948351275132978649726415833659824714817532968465793121573286492391647581",
    "0000089000006000070000048136012004000200500090597060200009001083004250000070030044751389621836925472965748136312894757243516898597463215429671383184257969678132541",
    "4000013900000030000030090860007200157600150022004000081000005000000008606700000004265813978976432515132794863497286157683159422514967381849625739321578646758341291",
    "0002900085030140006000000000060708544019000030305020900604000700040000010000376091472965385837149626923854179261738544519687237385421968694213753746592812158376491",
    "0000090800001006300006001040510907400890710000002000003000064210003400005600000901465392877251846398936271546518937422894713654372659183789564219123485765647128931",
    "4016003000093000025000000907000304090000982700024768002000030406180500000000021004716293858693457125238176947862314591345982769524768312971635486187549233459821671",
    "0058000010000000203000207080600400100079030002007100005000391000045000000701845006258973417483516293914267588632459174179632852597184635826391741345728969761845321",
    "4000701000092435000050060407000804050600007900000040000004009000000100302006000504368751291792435868251963477123894653645217989587642136834529715479186322916378541",
    "0080350060630012000200004708700100600000070900000000020800000000000900200007801507482359169634712851258694738729135643546278916915487322891563475173946284367821591",
    "7605100090050000000004030780030900050006000000500408010012300000040010000008060207685124393457896121924635784731982658196257432563478916812349575249713869378561241",
    "0710609050009020004000006003005000470000000900050300001000000002400987009000100008713649255369821744921576383195268476248715937854392161672453892436987519587134621",
    "0080500000000010004500973018300000050020009060650000007000800090002004000040768002186537943794215684568973218379621451427359869651482737215846396832194575943768121",
    "0010000025006001000000027380007000060900000000700649200000203004000000700503780907318495625286371496495127382147938563962854178751649239674213854839562711523786941",
    "0006054170001070200002000681200500048690001030750100000000009050087090400005318069326854175861473297412935681239567848694721534753186926178249353587692412945318761",
    "0050000008000300010020003502800100457005000000008009060003092100006400303090080049354816728672354914127963582869137457945621831538749266483592175216478393791285641",
    "0619275000000000200000850096720000010301000701000090000034607080005002030890030653619275848953416274276851396728349519341568721582793465134627987465982132897134651",
    "0000097000632000500743500067210030600001763006000009018000210000170000080090000005824697139632178541743582967218934654951763826385429718467215392179356483596841271",
    "0003000760010070007306809020205030070000008250501203005000006006000090003080002092893154764612975387356849128265431971439768259571283645947326816128597433784612591",
    "0000204600900060100560080200050000090080100000008070050400030000300406808010000041835294677924365184561789233152648799783152466248971352496837515379416828617523941",
    "0000700862060000000090040300007400509040200006003807090000005005000000030930028044319752862561384977892641353187496529745263186253817498674935215428179631936528741",
    "7000009000500000070010230000080000000400061000050000480308004090060010000090047057236459816541983279817236543984125762475861931653792485328674194769518328192347651"
  ],
  hard: [
    "5840100007620000400010007000000008000000000024102000902038500000060790800000300095843179267625983419316247586297418353789654124152836972938561741564792838471325692",
    "1000007200040800016001000030000000023005206000700000002500003044017030080904000061896347257342859616251974839463718523185296475728461392579683144617532988934125762",
    "0004000316805002903010900005300070040200001060009000707000090000001800000020740002794685316845312973517924685362179849278431561489563727156298434631857298923746152",
    "0000000000506030480048200602000100900002500815000060000070020009020000350000847006281493571596732487348251692764185934932576815813964728675329149427618353159847264",
    "4000010000000690400000002090005040011000008000008000366000001000800407009100073004593216788217695437364582193685749211426938575978124366749351822831467959152873642",
    "2780104000042007903000000000900000051000030000000013244050900070375401000000060002783194566142857933594672817938246151426539785869713244651928379375481628217365493",
    "0000000253402050010000108000687000500000002040050000805030070000160000028201600006813794253472859619526148734687321591798562342359417865934276187165983428241635972",
    "2095000040312000000000010003000008900050004000907053060000607108000070400108400502695781344312965877584312693726148956853294711947853265439627188261579439178436522",
    "0003089000000000078201000000007001004090060000060500006000004000900003215002030061653789429435628178271946352587391644198265733764512896329174587946853215812437962",
    "6010032800801000090302004004000000600100007005608309003500040060000100000700025006419532872851476397392684154235798619184267535678319243527841968946153721763925484",
    "1840000000000070007000006000014600500000050690080000204008000900009005036501000001846297352365879147953416829214683573472158695687934214738521968129765436591342782",
    "2040560030062000009000000104308006020900000006000070400007000007036040088000054002149567833862715949753482164378196525984623716215378491427839657536941288691254372",
    "0000500000057014000000087060020000907006002001064000300009008000300070000000260736792543813857614294213987568421356977536892141964725382679138459385471625148269732",
    "0060709808000400600000300510307000090000000000000802070100050040000006009634000003465719828512497632798364516327548194871925361956832477189653245243176989634281752",
    "3000720000004089305800034000000000800020896000080400206030508100900000000001000003495721682764189355816934724352617897123896549687453216239548171978265438541372962",
    "0700000522310008000000080005009000709004170000000009400070010001005960200000430008761394522316548974592783165439826719684172357123659483978215641845967236257431892",
    "0041800570805000000000000000508300404060020900200900300430000099000004108050093003941862572815479635679231847598316424367528911286947356432185799723654188154793263",
    "0000000309703500600402100086098000047000020000000000500070203050000000000820050012156874399783541623462195786598732147315429868241967531679283455934618274827356913",
    "0002904500400060800000000306045002001030095000000300017004000200020089005000700008172934563491567822568471396745812931836295479257348617914653284623189755389726143",
    "0000024000060013050500000200902000000007408600030900000049802000371009000000500043895624712468713957514396286982157431257438694736985125149862378371249569623571842",
    "0002501000060903001208005900026004008050400000900700109000360012000070030004000004792531685867913241238645977126894358351429766943758129475362812589176433614287592",
    "0000064150500000002000050900003090800062000009000400300200000001040082008907003403879264154598136272614758937423591865362819749186475326231947581745382698957623413",
    "0000070066000509370070600800030080700024000030005090000200008400100060590050000002593874166841529371379642855936281748624715934715396283267958417182463599458137623",
    "0000300050070020040025000080003840000942000600010090000004601590000000060700000209487362151578926343625419787263845918942153675316798422834671594159237866791584232",
    "0100508490030000000081000370300000001000206080040095038050420700000004020000080066123578497932841655481962379368157241574236982846795138659423713795614824217389562",
    "0008500000000040300400200000002000001500003002070069000200306700860000047000900006738514298927641355413297864692835171589473622375169489254386713861752947146928532",
    "0600080035701000042005000101007000003506090700900102009060007000100800000009001004612785935731968242895436171427359863586294716978142359263517487154823698349671522",
    "0008090003080507040000000016090000800040700090006004120302800454050010001000400007418295363981567245627348916594123872143786598736954129362871454859612731275439682",
    "0010070006000290300900108008400015000700302090000007009603000400000520000000000502318476956875294315946138278427915631764352893592867149653781424189523767231649582",
    "5800902003640170000000000004000620950009700300090300000070008040080006000006010005813962473642175897924583614738621951269754388591347266375298149187436522456819732",
    "0300560208970006000060300000000439700800000100030810023091000000080900000100050301349568278974126532567381946215439784852793169736815423691247855483972617128654392",
    "0007050020080300070750010009010000000800902500020008408000006000100670900068000234697853121289345673756219849412587366874932515321768498943126752135674987568491232",
    "7000309008502700400000090250008001020000070000000050901070500000023600003047000007215349688592763416431897259768431524159276832386154971674582395923618743847925162",
    "0260000009006300003400500000904001000008000030000006080012800700000062007001000905267184399176345823489527618954631271648279532735916486512893744893762157321458963",
    "0000250000031000000000001090040000083900040060700390000560003000014605000003007001879256439231468574657831295146729383985142766728394157562913848314675922493587612",
    "0008405600090120405000000000000019049000006010030090580700000036000900003900207101328475698695123475479361827562819349283546714136792582741658936817934253954287162",
    "0082010700007001090070900000004009007018020000600002500800040015320000000000206009482315762567481393176958428254639177918524634639172586895743215321867941743296852",
    "3000070080863207500001089300704003000030016200005300000012000000300060007400000003156972489863247514271589361784623955938716242645391876512834798397465127429158633",
    "0384100020070008600000070040802009031200000000000600500500900000000400000906050385384167924173298659625873147862519431259346873497682518531924766718435292946751383",
    "0000000060001000900046001576008000209073000000010090000000870000800107020064500091587942367621354983946281576358719249473625818215496734192873655839167422764538192",
    "0800000005049870000130000900004010590000002000060203000000059472000980600000000036891345725249876317136524988324617594958732161765293843682159472473981659517468232",
    "0000020141000009060001800000467090007000084630080007000600003000000102500030000816359728141823549764971865325467391287195284633284617952618953478746132599532476812",
    "0010054003002000000057100000370000904080005020000200800640003010000809070000300007213954683892467156457182392378516944189635725964271838645793211536829479721348563",
    "0102050300057000900000084100205010000070900020003006001706009000400000000000090048192457364657132987329684156245713893874961525913826471786549239438275612561398742",
    "0002060000060408500200900000031720000000800040000007053000000670050090200800050008342569719763418525218973464531726897695832142189647353924185676457391281876254932",
    "0024010507000000000100008060007420000010600704000080000301070020000003005003000688624317597538962149142758363957426812819634754765189236391875421286543975473291682",
    "0004060000000000050000709300560030700030000980800091000100683000005400002009000405394162878473926156218759349561834721736245984827591637142683593985417262659378412",
    "0090050700020016500072309000007008000040500068000024000000102000900030010604090306398451724829716535172369841237648959741583268563924173485172692956837417614295383",
    "7900000000000403500020000086000000739000500100100000000015000005700681040400107657936854211869423574521376986248915739374568128157239463615742895792681342483197652",
    "0080950704200001000006000002003004500600010000500007007001500090000060088400300106182953744257831969736148252893674513675419821548297637321586495914762388469325173",
    "4029001303000000009800000060000000970000004007038106050006315000310800000000450004729561383164789529851237461543628976285974137938146252476315895317892648692453712",
    "0729000000002050100006007022040000580050020000000093000030060005680072030470000066729148353892756144516387922347619587953824618164593271238465795681972439475231862",
    "0000080096001000040140000061000009023800200410200003789700300000000020000069050107536481296921537848142975361673849523857296414295163789784312655318624972469758132",
    "9000003150010970000300509060207005000050300000000008045608004010009050020070100009782463156513972484321589761267845938456391277935218645698724313149657822874136593",
    "0000007404070620810100000000400100705703004620000005000800200000390400500056080009628317454579623818137549263462158795713894622984765131845236976391472587256981342",
    "0000700250600031700900000040000320001005402000006010000710000009000060400804500303189746255642831797921653846458329171395472688276914534713285969537168422864597313",
    "9503000040061000070107050631000000000206003004908030000024000060009020400000061009573682148361245972147958631632574897286493514958136725724819366819327453495761282",
    "0070000000502000310241350000005083066009200700036000000000600430000509001000020503174962859562874318241357697425183966819235745936748122758691434683519271397426584",
    "7000138200006709500000006000060000800070850090030607406004000000100000960920000057695138242816749535349286179263475811472853698531697426754912383187524964928361752",
    "0920010050752400008000900200800050002090000000007008020200307000000100406000001904926713853752486198165934277831259642693845711547698329214367585389172466478521932",
    "0902000000000040120040050000000000070050019007000600858036000706000500004201003001972365485389746122648157939165482373857219647423691858536924716714538294291873562",
    "2390080000100008000000500000083406901060004800430000507009020000007100090900000762394781654156298376871539245283476911762954839438617527649325188527163493915842762",
    "7058000000004000000105020494000000000030500008070001900009108000002060002090480067458932619264713583185627494521896371936574828673241956749158235812369742397485163",
    "3000007000480096030005300000000000080090000000700810400009705068000030070600500203568427912487196539175362845342971681894653726723819454219785368956234177631548294",
    "0076042914000310000002000305103000000794050000000000020000000166250009000400030058376542914529316871962875345183267492794153683648791527835924166251489739417638252",
    "0060100820700630095000000000050003003000026070000080400000900002070000000580000914365197828724631595198274639657413283849526177216389451432958762971865346583742914",
    "1500040000700020000047603000030706010100009000056300805001000700000508600000001091583947263768125942947653188235796416172489359456312875891264734319578627624831592",
    "7905200062000070000010005006000053103000600000000920000040097000200014390700002807985231462654178934319865276897453123521689741473926588142397655268714399736542813",
    "0000007500010050980508920000000170060309000000000002370096800000060018000000300108941637522614753987538924614253179866379281459185462371796845233462518795827396142",
    "0300000140504682000023506000790000005009000006000104000006401000050800007000009068367925141574682399423516784792368515819743626238154973986471252651897437145239862",
    "0040300002901080000500960000009000100000040070800200450608090700050108038000700096142357982971485363587961245469873121325649877893216454638592719754128638216734592",
    "0450002060790625000005000900000040500200100000000059003071008000104500200007030098453912761798625342365471989816743525239184677642359813971268456184597234527836193",
    "0040001003000780000000602000010000000500008900705010300000030005004000002000960809642351783251786491879642534316897256523478918795214367468539125984123672137965842",
    "0020518000100000470004200150000001096000300020000925701000003000300060000002700604627518939153682477834296155276841396915374823481925761769453282398167548542739612",
    "7000051000006000900090410006300700022143000090000104600065000000700690000501009007638951241456328978297416356389745122143567895972184639865273413714692584521839762",
    "0010003000500010000002800710005008600000060050060390046070400500090000028000209004817953267523614989632845711345728692984167355768392146279481533491576828156239472",
    "1506000900830401600000000040000000703060000509050070384000000800083000020001709001546238972837491656978513248415362793769824519254176384192657837683945125321789462",
    "0900042002005300000009000000000006700103768400658000030504000920010000300007030065936142872475389611869273548341526799123768457658491233584617926712954384297835163",
    "0008000030006000057500200000040010002800340010000000591700060000000100009600700044268951738316479257591238466947512382859347613172684591734865925423196879685723142",
    "0003704060981000700000000000600100002700090000010502600007000040874900019000007301523784966981243757439651288692135472756498134318572695267319843874926519145867322",
    "0000040000009180020000030050500806076000509009200000000012005004053000092600004308125743965369187427496238151534896276741529839287361543912475684853612792678954312",
    "0074062030002000800080357060035000091706003000000005703009004000000000000800000209174862535362791842481357968235476191756923484698135723519284676927548317843619252",
    "3000000700042001900010002839083710040004600090000000000306900020000320102001000003829164755742831966917542839283716547134658294658297311376985428465329172591473682",
    "0042507100230609000060080300000010007020000900304050070070048600000004000480100008942537165231679481769485324897216537523861946314952872175348693658794219486123752",
    "0810402704508000036002000009000020801060507002000010060200000000000005900030050003815462794528796136972138459357621841469587322784319565291843678643275917136954282",
    "0700001004060095800080002040013000020601207080000003000005000007020400600090600252758341964162795833986512748413976529631257485274863196845129377529438611397684252",
    "8004000000002000100200708004050200030000100000090005000007600349080000056000010208314962577942853165261738494158276933675194822896345711527689349783421656439517282",
    "6043057000200070000090003000300600055027030008000490000680040070000080249000000106143957823256871497894213564318629755927134688765492312681345971539786249472568132",
    "0001000062000007080010470007060800030000350000507000904203700008100000000038002009371284562645937185816479327469815231982356743527648914253761898194523676738192453",
    "1060000900700000000001000320900020005000000036003001000008569000080000004000200751362854972754396818491675323945127685176982436823741597238569149587413264619238752",
    "6000597000020000050007018000800070000000160202400080037010000000940000510000003006184597324726839155397218461832475699573164282465981737619352843948726518251643973",
    "8200040000000000940148000600005000100301009005600000300070200000000000011060070508296541736752138943148795624925386177381469255617924389574213862839657411463872592",
    "9070000000107000000000050040010060400203097008000006003600820900906000307009000059572483162147635896831952745718269434263197588395746213654821971986574327429318652",
    "0860030007000000002006105003000608070000040505020804090200001004000310080082000001867539427354926812946185733415698278791243565623874196238751944579312689182467352",
    "0004078000825610007040900010009000000100000320050000400000080105600000041000593086514378299825614737348926512739145864167859328953261473296487155681732941472593682",
    "0801074000020005003700500000000087100000040007000006900090310070000029001079603009851274364123865793764591822346987156915748237582136945498312678637429511279653482",
    "9060005400000051000300000090000000007000002303480090000000080075001930000845000009163875428729451634356128796217349857598612343482597161934286575671934282845763912",
    "0007000100000035090000007202000106046000802010700090000300004805020700001800000009257463188671235493148957262583176946935842714712698357396514825429781631864329572",
    "0040003010050800007000520004000000070976030000000005693400082000002700000000010008247693511653847927391526484869251375976138242138475693415982769582764136724319852",
    "5307000000006000000904016070000008500530097000000070090000040003791000060400005025367921487146382958924516379273168544532897616815473292658749133791254861489635724"
  ],
  expert: [
    "0702005000000000284000063000090070540060000090000600700204001008000500400009200003782945166917354284521863972893176547165428395438692719254781638376519421649237858",
    "6000000000486009271900084500692100005300060000009050700000000829201000000000027046754298313486519271927384567692135485348762192819456734563971829271843658135627948",
    "3400700000075030000000410087006000000050326078307005290004000900200074050700000033418792562875639415692413787926581344159326878367145291534867926283974159741258638",
    "0000018000007300090970080032090000003000140006009003000000006170062050000080700005234918768647321591975682432798534613856147926419273854523896177162459389381765248",
    "0078000090090603070000078209010000020007009000620801054059010001900000700000030006278354198192643573541978269315467825487129637623891454759216381936582742864735918",
    "0060208700806705910350094000100069002090000000000000100000010209273600080000400501965248734826735917351894623142569872794186356589372145438917269273651488617423598",
    "0060005070000380090007000000600700000000900010570032002300070048013000200000048053169425877245381695987163429628714534832956711574632982356879148413597266791248358",
    "7602130802000053600000405003000600200000070500704000006300040009810300070000090007652134892489753611936485723598617244123976588764529136371248959815362475247891368",
    "4286093000008400000000700640000002405009000000300860108562000000900076080070000294286193576738451929153728647895312465619247832347869158562934711924576383471685298",
    "0100400060000864000031000080000300900000008010200016009000042007000000000400021508157439262795864134631295781864357925942678313278916459316542877529183646483721597",
    "5000009302000000000107030040000006900009000080693210500408300700052040030020500005781429362345967819167835241534786924279653188693214576418392757952148633826571498",
    "2040050900600100039000308400501009001004060000000080000926000305002406010005030092348651978679142539157328463581279641294563787463985124926817355732496816815734298",
    "0040207006000500009007000200001450000000000005400009301000002003000080010070305808143267596728593149537146287391458622689731455416829371854672933265984714972315868",
    "0005079010060008040300020060502001000000000003000060891054800000000030008006000002485679315763918249318427566592381477829143653147562891254896734671235988936754128",
    "0060000007201000000300020092007000000015000470970000120080709044009186000500307801864972537291534685348621792457813963615298478973465126182759344739186259526347818",
    "5000007040900600050008000000500003216010025080000084000840509602604008000000870405163297847981642354238756198597463216419325783725184961842539672674918539356871428",
    "0020035078090600000009056000000080062030000004001003050000504000400000025070400096124835978597612347349256181752389462635948714981763259216574833468197525873421698",
    "0310500000200000008003005000450000060000490020006000801807043000040006000900080044318569275294718638763925419452871363681497522176354891827643957549236186935182748",
    "6300000470090018030007000051000004000008000000039007000015040600200000805060009006382591477594618234127386951856274399748132562639457188915743623271965845463829718",
    "0038000005000009000094200010702010080000902040950080600810000790000005000060070007138694255421739868694257316742513981387962542953481674815326799276845133569178428",
    "0800005007010048209528700300061000900200000003095400000054007000000350104100090006849235717316548299528714365461823971283976453795461822954187638672359144137692588",
    "0600000000708400301307090000000020050004000000043008902000036043800001090005800204681359729728465311357294688136927457964582135243178962519736843872641596495813278",
    "2004000870506170030000000400000010700020001000007200544010000305201000006702400052164395878546179239375826413458912767623541981987263544819657325231784696792438157",
    "8040302000000600030100000000003070002000005060500004074810700000009060100701000588647352917952618433128946756483571292374195861596284374815739625239867149761423588",
    "0020900000000100707000003010090030003500086004010279359030000040000091508002000931327945865683124797945863216291538473579486124816279359138752642764391588452617938",
    "0610000300000010058090300004001000007300460100000050700002000510800070040009000035614982372437618958795321464581793627328465199163254786942837513856179241279546838",
    "0003001000690000000156000380080000002000708900030480070900800004010309000000060028243571693698215747156942381782693452465738919531486276924857134817329565379164828",
    "1028000077000019000800750040009000150000140060610008006900830518070000900000000001428965377564319823892751644239687159785143265613278496947832518176524932351496789",
    "9207006000850060000003051200005070640400007000000003023000000100070600006002500739237816451854269377643951282395178648469327515716483923928745164571632896182594738",
    "5000040000090000003000000650608020000100570060526104034000005900007062300003400005719643826295837413482719657648321599134578268526194734361285971857962342973456188",
    "0700000089010042000060000007020054000054000090000830100000521700040605000000000302735169489518342678469273517126954833854716294692837156983521741347685925271498368",
    "0000360005007000000104090030380100400402009000000000000509007006000020000920730054298365715837216947164598239386152471452879362673941583549687126715423898921734658",
    "2800000000004039010418006500000402650000560100620080708000000000075008900200000372891657437564239813418976521387492659742563185623184798936715244175328966259841378",
    "0000400350801000070430009000002000000000007500078003609004060001500092030000100806719428355891634272435789168652371943126947584978513629384265711567892437243156898",
    "5400890000270500000091030421004050070600000090000002018003000000000000030030687055412893763276541986891735421984256372657314897348962518523179649765428134139687258",
    "0005098000700030020500010041009872000096003005000004000062000000000040004027000012415798369784631526538219741349872658296453175673124983162587497851946234927365818",
    "0875092400502008002000000655000060000040506009007000840060100070000000207108053003875692416512748392491837655784369121249586739637215848963124574356971287128453968",
    "0050100009670000000000075060040030086004003290100084000000200004900000000021097408359162749675428312418375967246931586584713293192584671763249854937856125821697438",
    "0005000003800060000000308620140509000500020049230005000000070404069002052000401701625847933892764517451398628147539266578923149234615875913276484769182352386451798",
    "0300150900560070000070800520008094300790600080000005600080063400600020015000000708326157949562478131479836526158294373795641282843715697281963454637529815914382768",
    "6000005030190000405700006000018900500000300000000020000009504000500030003271000806487195232193657485734286917318942564625318798956723141869574329542831673271469858",
    "0620400100082710007000004090000000910000560780000002500800300400060007831035000023629458174982715367153684298547236919214563786378192542896371455461927831735849628",
    "1000607008900021002300000060003060000000700020709000500050000009002000710106003801548697238967321452374158965293864176485719323719246587851932649632485714126573898",
    "0040012002080005001600020080006001046000508028700000500000000090900430800000904007549812632384675911695327489256781346413598728732149564867253195921436873178964258",
    "0075600000000090150051302000060500010000000900986000008612000405207000830700009202175684396834297159451372684369528717523816941986743528612935475297461833748159268",
    "0009000066000021900817060200005739018500000070170002505000000600000900030008000192359187466743521989817463254625739818594216373176892545981374621462958737238645199",
    "0002900000207000001000645800000028042350080090006003200000000170000160000800000904682951735237819461973645827169328542351487698496573213548296179725164386814732958",
    "0008160000094005006000052009601000800080300092000001005006000040400806000000040004528169737894235166137952489651473821785324692349681575216798343472816958963547218",
    "0639005000000250000000400964507160030308000090000000705020097000080040003012800002639785419146253877853412964597168231378524698264931755421697386785349123912876548",
    "0300000000000604000427016000100000000070400590050000161900072000065130000030000006394285717819654235427316989183567423671428594258793161946872352765139848532941678",
    "0030020086400007000000803900000090000610000004000578000700004030060015005002039009537126486483957122174863958356291747618342594921578361795684233269415875842739618",
    "0010009000957260000400807251504730890000590709000000000000300070005000000206003402713459688957264133469817251524736894638591729871625346192348577345182965286973418",
    "9080020500500000300079004100000000000300009000107800060900000000706500020020178009481326576518742393279654182865913747352469814197835261943287658736591425624178939",
    "0002830072300709008000600000050000047003000900000080700506090800210000400900000515192834672365749188749615231657928347823461959431582764576193826218357493984276518",
    "0000809000030000407080930000050100000008000051600700203070000600005000000890670035217849366932518477486932518753126949328461751649753283571284694165397822894675138",
    "0300000170403000000000419800000000500500030700865000095000020013000006009000370008392654171473892656257419832938761544519238767865143295684927313741586929126375488",
    "0205917000000008100706800000004006306302000040090000000420030008000020000008004903285917469643278151756843292814596376372189544597362815429731688961425737138654928",
    "0000070090000900010801020050600005071508004920930700000206100000080000000790000065413872697325968419861423758649215371578634922934756183256197846187549234792381568",
    "0105007030060170000900000001000000200000500070054006900002080190000400520000004004185927633268179455973642811697835248426591377354216986542783199731468522819354768",
    "4000000500070000020065720000090100700100002060586000349000050630010300008007000004239618575973486121865723492694135783148572967586291349421857636712349858357964218",
    "0574082000602300000040006100000003050003000700010049004007805000030060008001000901574682399682317543249576187896123456423958715318749624167895232935461878751234968",
    "0070400320000009713000060086000080170405070000000002000890017041000740850000000008571496322643859713917265486352984179425178637184632595896317241269743854738521968",
    "7001000080040805960200000000300000020060150008004000100500408004000000039832000407951642383147825966285391745319784622463159878794263151576438294628917539832576419",
    "0009000079080020000000053407000500200020068000000006041600000000740310003006000086539142879483725612178653497964581234321968755817236941695874328742319563256497188",
    "0004000250700001600320100070931000000000000100000050064000070500102600040070009009614738258749521635326184977931265482567843191483952764298376513152697846875419328",
    "5609000007000013801000050070000030042100000030057040000001000309200700000070480105639871427496213851824359678762135942148596733957648214581927369213764586375482198",
    "0005000902000007000807010000008004073040070000000500000006000011300802047090246006175423982453987169837615425618394273942178658724561394286739511369852747591246838",
    "9003000010050007000305076005008009026000200000010060000004053000940600102000000009763482514156927838325176945478319626897241353219568471684753297942635182531894768",
    "1080200405326000000400310008030000700090403010600005080900030100004500000052000001789256435326741899468317528531629747295483614613975286947832152174598363852164978",
    "0080300203000207040020075009531000000000080700000000090400000070000948067000160005784396213965217844128675939531724681649583728276431596412859372357948167893162458",
    "3000002000001700090003007810020005078007000107530009084006000050780050065000800003175982646841723592953647811628495378497536127532169484316278959784351265269814737",
    "9000000000052903700000541000000784006000200508000400070040390010000000003100000099213678454852913767638541921529784636471239588395462172746395815987126343164857298",
    "0208906008000010070700000000106500000000000960060042007000400035007800200600000501238976458452619376794358129126583744871235963569742817985421635317864292643197588",
    "9000301000008006008307000023270800004000010000000500000001000400406052000020000039645321872718496358357164923279845614582613791963578245891237467436952186124789538",
    "8000009000560000780010030000000003100403070000004150000150200000000000609007800058271569433569421784918736525792683141423975866384152977156248392845397619637814258",
    "1700000044000300180080200000000000005020709000030850709000085060006020000000510001758692344295376183681247597942163855824739616139854729317485268576921432463518978",
    "0004300080009000000800076000018000564037000000900500000070000826400039102005080601724365983649852719851276347218943564537618298963521475376194826482739152195487638",
    "0006010070000305240050009002000036000064000000395060000010950029000804300037600094926513871689375243752489612148736955864297137395162486413958729571824368237641598",
    "0030000708000000500600008090700005005900840006005203017006000200000010300100509071539682748497126532674358193721965485913847626845273917386491259258714364162539878",
    "0900350048002000301000000003009207050005801000687000029060072000050020030800500076921358748572946311436785293149267857295831465687413929364172584758629132813594678",
    "0000007300000030000970412604063200980000050240006000000010520000200900500090300702485697311652738493978412654163275988739156249526843177314529866247981535891364728",
    "0000030000130052064000001803001065700900000040500080000017003000020300900002000016284139579138752464756921833841265792963578141579486328417693257625314985392847618",
    "0005001800470000050062007000000200000824309010001003700090140001008005000086020102935471868479612355162837949317256487824369514651983726593148271248795633786524198",
    "0000010093020000054000092707000000002804100305140000680200004006089020000007000008762513493926748154518392767635981242894165375143279689271654836389427511457836928",
    "0084300000200975005006000007000090020010000070600800048000030100090000061040003006184357294238975615976128437453691829815246373627819548769432152391584761542763988",
    "0090063010000100807008050400010007200000706050670000002304000600061020040050600008592463716243175897138952465916847234829736153675214982384591679761328541457689328",
    "3508007600000002001800000048640500900000000002004090000200850400000900057052030803528417694795362181869725348643571925916284732374198569231856476187943257452639818",
    "5000000039100000808002400000429070000903002007004600080600504010000048000807000605261987439145736828732461591429875366983152747354629183678594212516348974897213658",
    "0000800000806093000000400070603000057020608034007100002060310700000500000080006029731824565846793216215439878693247157129658434357182692968315743472561981584976328",
    "0000050002001086004006000070000010700500091600307000028020000090190200500000960006739452182951786344816325979283614757542891631367549828625137493194278565478963218",
    "0700020000040000105280973401000400750000080000060794000000030007600500904000200076714329583946857125281973461392468752475186398563794219157632847628541934839215678",
    "0203000040030000104000000090006040010008000239007000600390000000841005021000060007213896548934652174652178393726549815468917239187324652395481766841735921579263488",
    "0807100006100900459000000000400000000080000600600025914300579000000000000200614585847162396132987459725431861456398272981753643674825914368579128519246737293614588",
    "4683071000230006001000002080006025907900100000069000009320080600040090000070060004683271595238916741795642383416825977954138262869754139321487656147593828572369418",
    "0067000307304085000080067000040090000100809700005000000506008200000100063000000505967214387324985611483567922741396856152849739835672144516738298279153463698421577",
    "4030600070560000300000000648000062530000407005000070083107000000005304290900000714231685971564798327892531648479162539328457165613279483147926856785314292956843718",
    "2041080070006000340000200009000000000200000610030000206980700000070004084005000062541386978716952343697241859862175437253498611438567296984713525379624184125839768",
    "0070060822060500003807000100009100360206000048000030000980000600000002000320000599571364822164589733847296157459128361236875948695431275982743616713952484328617598",
    "8000960009000030560040070000000802000026000000500300100000018000007006002000607038315964729278431565642173897931852641426795386584329174763218953897546212159687437",
    "0000250790008000000007900610600300008000009502040000004050070800210005079706501031864253793978614255427938617695342188132769542541897364359176826213485979786521438"
  ]
};

// src/engine/rng.js
function sfc32(a, b, c, d) {
  return function next() {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = c << 21 | c >>> 11;
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}
function rngFromBytes(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rng = sfc32(v.getUint32(0), v.getUint32(4), v.getUint32(8), v.getUint32(12));
  for (let i = 0; i < 12; i++) rng();
  return rng;
}
var randInt = (rng, n) => Math.floor(rng() * n);
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// src/engine/transform.js
function linePermutation(rng) {
  const bands = shuffle([0, 1, 2], rng);
  const out = [];
  for (const band of bands) {
    for (const offset of shuffle([0, 1, 2], rng)) out.push(band * 3 + offset);
  }
  return out;
}
function randomTransform(rng) {
  const digits = [0, ...shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rng)];
  return {
    digits,
    rows: linePermutation(rng),
    cols: linePermutation(rng),
    transpose: rng() < 0.5
  };
}
var IDENTITY = Object.freeze({
  digits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  rows: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  cols: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  transpose: false
});
function applyTransform(board, t) {
  const out = new Uint8Array(81);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      let sr = t.rows[r];
      let sc = t.cols[c];
      if (t.transpose) [sr, sc] = [sc, sr];
      out[r * 9 + c] = t.digits[board[sr * 9 + sc]];
    }
  }
  return out;
}

// src/server/puzzles.js
var DAY = 864e5;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var isLevel = (l) => LEVELS.includes(l);
function parseDate(date) {
  if (typeof date !== "string" || !DATE_RE.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) throw new HttpError(400, "invalid date");
  return t;
}
var utcDay = (now) => new Date(Math.floor(now / DAY) * DAY).toISOString().slice(0, 10);
function dailyStatus(date, now, launch) {
  const t = parseDate(date);
  const today = Math.floor(now / DAY) * DAY;
  const offset = Math.round((t - today) / DAY);
  if (offset > 1) return "future";
  if (t < parseDate(launch)) return "prelaunch";
  return offset >= -1 ? "live" : "archive";
}
var dailyNumber = (date, launch) => Math.round((parseDate(date) - parseDate(launch)) / DAY) + 1;
async function resolvePuzzle(secret, id) {
  const parts = String(id).split(":");
  let level;
  if (parts[0] === "d" && parts.length === 3) {
    parseDate(parts[1]);
    level = parts[2];
  } else if (parts[0] === "p" && parts.length === 3 && /^[A-Za-z0-9_-]{4,32}$/.test(parts[2])) {
    level = parts[1];
  } else {
    throw new HttpError(400, "invalid puzzle id");
  }
  if (!isLevel(level)) throw new HttpError(400, "invalid level");
  const rng = rngFromBytes(await hmac(secret, `puzzle:v1:${id}`));
  const entries = BANK[level];
  const entry = entries[randInt(rng, entries.length)];
  const transform = randomTransform(rng);
  const puzzle = applyTransform(parseBoard(entry.slice(0, 81)), transform);
  const solution = applyTransform(parseBoard(entry.slice(81, 162)), transform);
  return {
    id,
    level,
    puzzle,
    solution,
    technique: TECHNIQUES[Number(entry.slice(162))],
    clues: countClues(puzzle)
  };
}

// src/server/replay.js
var MAX_MOVES = 3e3;
var MIN_MS_PER_CELL = 250;
function verifyReplay(puzzle, solution, moves, elapsed, wallMs) {
  if (!Array.isArray(moves) || moves.length === 0) throw new HttpError(400, "moves must be a non-empty array");
  if (moves.length > MAX_MOVES) throw new HttpError(413, "too many moves");
  if (!Number.isInteger(elapsed) || elapsed < 0) throw new HttpError(400, "elapsed must be a non-negative integer");
  const board = Uint8Array.from(puzzle);
  let last = 0;
  for (const m of moves) {
    if (!Array.isArray(m) || m.length !== 3 || !m.every(Number.isInteger)) {
      return { ok: false, reason: "malformed move", plausible: false, moves: moves.length };
    }
    const [cell, value, t] = m;
    if (cell < 0 || cell > 80 || value < 0 || value > 9) return fail("move out of range");
    if (puzzle[cell]) return fail("move overwrites a given");
    if (t < last) return fail("moves are out of order");
    last = t;
    board[cell] = value;
  }
  for (let i = 0; i < 81; i++) if (board[i] !== solution[i]) return fail("replay does not solve the puzzle");
  if (last > elapsed + 1e3) return fail("moves happen after the reported time");
  if (elapsed > wallMs + 5e3) return fail("reported time exceeds session time");
  const empty = puzzle.reduce((n, v) => n + (v ? 0 : 1), 0);
  return { ok: true, plausible: elapsed >= empty * MIN_MS_PER_CELL, moves: moves.length };
  function fail(reason) {
    return { ok: false, reason, plausible: false, moves: moves.length };
  }
}

// src/server/api.js
var hintLedger = /* @__PURE__ */ new Map();
function requireLevel(level) {
  if (!isLevel(level)) throw new HttpError(400, `level must be one of ${LEVELS.join(", ")}`);
  return level;
}
async function openSession(ctx, body) {
  const session = await verifyToken(ctx.secret, body.token);
  if (!session) throw new HttpError(401, "invalid or expired session");
  if (ctx.now - session.iat > 7 * 864e5) throw new HttpError(401, "session expired");
  const puzzle = await resolvePuzzle(ctx.secret, session.id);
  return { session, puzzle };
}
function readBoard(value, puzzle) {
  let board;
  try {
    board = parseBoard(value);
  } catch (err) {
    if (err instanceof BoardError) throw new HttpError(400, `board: ${err.message}`);
    throw err;
  }
  for (let i = 0; i < 81; i++) {
    if (puzzle[i] && board[i] !== puzzle[i]) throw new HttpError(400, "board does not match the puzzle givens");
  }
  return board;
}
function health() {
  return { status: "ok" };
}
async function daily(ctx) {
  const url = new URL(ctx.request.url);
  const date = url.searchParams.get("date") || utcDay(ctx.now);
  const status = dailyStatus(date, ctx.now, ctx.launch);
  if (status === "future") throw new HttpError(403, `the puzzles for ${date} are not released yet`);
  if (status === "prelaunch") throw new HttpError(404, `no puzzles before ${ctx.launch}`);
  const levels = await Promise.all(
    LEVELS.map(async (level) => {
      const p = await resolvePuzzle(ctx.secret, `d:${date}:${level}`);
      return { level, technique: p.technique, clues: p.clues };
    })
  );
  return { date, number: dailyNumber(date, ctx.launch), status, launch: ctx.launch, today: utcDay(ctx.now), levels };
}
async function startSession(ctx) {
  const body = await readJson(ctx.request);
  const level = requireLevel(body.level);
  let id;
  let ranked = false;
  let date = null;
  if (body.mode === "daily") {
    date = typeof body.date === "string" ? body.date : utcDay(ctx.now);
    const status = dailyStatus(date, ctx.now, ctx.launch);
    if (status === "future") throw new HttpError(403, `the puzzles for ${date} are not released yet`);
    if (status === "prelaunch") throw new HttpError(404, `no puzzles before ${ctx.launch}`);
    ranked = status === "live";
    id = `d:${date}:${level}`;
  } else if (body.mode === "practice") {
    id = `p:${level}:${randomId(9)}`;
  } else {
    throw new HttpError(400, "mode must be daily or practice");
  }
  const p = await resolvePuzzle(ctx.secret, id);
  const token = await signToken(ctx.secret, { id, iat: ctx.now, n: randomId(), h: 0 });
  return {
    token,
    id,
    mode: body.mode,
    level,
    date,
    number: date ? dailyNumber(date, ctx.launch) : null,
    ranked,
    puzzle: formatBoard(p.puzzle),
    technique: p.technique,
    clues: p.clues
  };
}
async function hint(ctx) {
  const body = await readJson(ctx.request);
  const { session, puzzle } = await openSession(ctx, body);
  const board = readBoard(body.board, puzzle.puzzle);
  const { solution } = puzzle;
  const hints = session.h + 1;
  hintLedger.set(session.n, Math.max(hints, hintLedger.get(session.n) ?? 0));
  if (hintLedger.size > 5e4) hintLedger.clear();
  const token = await signToken(ctx.secret, { ...session, h: hints });
  const wrong = [];
  for (let i = 0; i < 81; i++) if (board[i] && board[i] !== solution[i]) wrong.push(i);
  if (wrong.length) {
    const i = wrong[0];
    return {
      token,
      hints,
      kind: "mistake",
      index: i,
      wrong,
      technique: "Mistake",
      description: `The ${board[i]} in ${cellName(i)} is not part of the solution${wrong.length > 1 ? `, and ${wrong.length - 1} other cell${wrong.length > 2 ? "s are" : " is"} wrong too` : ""}.`,
      cells: [i],
      units: [],
      eliminations: [],
      chain: []
    };
  }
  if (board.every((v) => v)) throw new HttpError(409, "the board is already complete");
  const found = nextPlacement(board);
  if (!found) {
    const i = board.findIndex((v) => !v);
    return {
      token,
      hints,
      kind: "reveal",
      index: i,
      value: solution[i],
      technique: "Reveal",
      description: `${cellName(i)} is ${solution[i]}.`,
      cells: [i],
      units: CELL_UNITS[i],
      eliminations: [],
      chain: []
    };
  }
  const { placement, chain } = found;
  return {
    token,
    hints,
    kind: "placement",
    index: placement.index,
    value: placement.value,
    technique: placement.name,
    description: placement.description,
    cells: placement.cells,
    units: placement.units,
    eliminations: chain.flatMap((s) => s.eliminations),
    chain: chain.map((s) => ({ technique: s.name, description: s.description, cells: s.cells, eliminations: s.eliminations }))
  };
}
async function submit(ctx) {
  const body = await readJson(ctx.request, 64 * 1024);
  const { session, puzzle } = await openSession(ctx, body);
  const result = verifyReplay(puzzle.puzzle, puzzle.solution, body.moves, body.elapsed, ctx.now - session.iat);
  if (!result.ok) throw new HttpError(422, `submission rejected: ${result.reason}`);
  const hints = Math.max(session.h, hintLedger.get(session.n) ?? 0);
  const out = {
    verified: true,
    plausible: result.plausible,
    ms: body.elapsed,
    hints,
    score: score(body.elapsed, hints),
    ranked: false
  };
  const [kind, date, level] = session.id.split(":");
  if (kind !== "d") return out;
  const live = dailyStatus(date, ctx.now, ctx.launch) === "live";
  if (live && result.plausible) {
    const standing = await ctx.leaderboard.record(date, level, {
      nonce: session.n,
      name: body.name,
      ms: body.elapsed,
      hints
    });
    if (standing) return { ...out, ranked: true, ...standing };
    return { ...out, duplicate: true, ...await ctx.leaderboard.view(date, level) };
  }
  return { ...out, ...await ctx.leaderboard.view(date, level) };
}
async function leaderboard(ctx) {
  const { date, level } = ctx.params;
  requireLevel(level);
  const status = dailyStatus(date, ctx.now, ctx.launch);
  if (status === "future" || status === "prelaunch") throw new HttpError(404, "no leaderboard for that date");
  return { date, level, ...await ctx.leaderboard.view(date, level) };
}

// src/server/app.js
var DEV_SECRET = "dev-only-secret-set-SESSION_SECRET-in-production";
var DEFAULT_LAUNCH = "2026-11-01";
function createApp({ assets, now = () => Date.now() }) {
  const router = new Router().get("/api/health", health).get("/api/daily", daily).post("/api/session", startSession).post("/api/hint", hint).post("/api/submit", submit).get("/api/leaderboard/:date/:level", leaderboard);
  const limiter = new RateLimiter({ limit: 90, windowMs: 6e4 });
  const memory = new MemoryStore();
  let warned = false;
  const staticRoutes = {
    "/app.js": { body: assets.js, type: "text/javascript; charset=utf-8", immutable: true },
    "/app.css": { body: assets.css, type: "text/css; charset=utf-8", immutable: true },
    "/favicon.svg": { body: assets.favicon, type: "image/svg+xml", immutable: false },
    "/manifest.webmanifest": { body: assets.manifest, type: "application/manifest+json", immutable: false },
    "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain", immutable: false }
  };
  function serveStatic(request, url) {
    const route = staticRoutes[url.pathname];
    const etag = `"${assets.version}"`;
    if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    if (route) {
      return new Response(request.method === "HEAD" ? null : route.body, {
        headers: {
          "Content-Type": route.type,
          ETag: etag,
          "Cache-Control": route.immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600"
        }
      });
    }
    return new Response(request.method === "HEAD" ? null : assets.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": CSP,
        ETag: etag,
        "Cache-Control": "public, max-age=0, must-revalidate"
      }
    });
  }
  async function handleApi(request, url, env) {
    if (request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      const wait = limiter.check(ip);
      if (wait) return json({ error: "too many requests" }, 429, { "Retry-After": String(wait) });
    }
    const { handler, params } = router.match(request.method, url.pathname);
    if (!env.SESSION_SECRET && !warned) {
      warned = true;
      console.warn("SESSION_SECRET is not set; using an insecure development secret");
    }
    const ctx = {
      request,
      params,
      env,
      now: now(),
      secret: env.SESSION_SECRET || DEV_SECRET,
      launch: env.LAUNCH_DATE || DEFAULT_LAUNCH,
      leaderboard: new Leaderboard(env.LEADERBOARD ? new KVStore(env.LEADERBOARD) : memory)
    };
    const result = await handler(ctx);
    return result instanceof Response ? result : json(result);
  }
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      let response;
      try {
        response = url.pathname.startsWith("/api/") ? await handleApi(request, url, env) : ["GET", "HEAD"].includes(request.method) ? serveStatic(request, url) : json({ error: "method not allowed" }, 405);
      } catch (err) {
        if (!(err instanceof HttpError)) {
          console.error(err);
          err = new HttpError(500, "internal error");
        }
        response = errorResponse(err);
        if (err.status === 405 && err.details?.allow) response.headers.set("Allow", err.details.allow.join(", "));
      }
      return withHeaders(response);
    }
  };
}

// virtual:assets
var assets_default = { "html": '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n  <title>Sudoku \xB7 Daily</title>\n  <meta name="description" content="A new Sudoku every day. Explained hints, verified leaderboard.">\n  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">\n  <meta name="theme-color" content="#121212" media="(prefers-color-scheme: dark)">\n  <link rel="icon" href="/favicon.svg" type="image/svg+xml">\n  <link rel="manifest" href="/manifest.webmanifest">\n  <link rel="stylesheet" href="/app.css?v=7151e37d65a0">\n</head>\n<body>\n  <div id="app"></div>\n  <div id="toast" class="toast" role="status" aria-live="polite"></div>\n  <noscript>Sudoku needs JavaScript.</noscript>\n  <script src="/app.js?v=7151e37d65a0" defer><\/script>\n</body>\n</html>\n', "js": '(()=>{function s(n,t,...e){let o=document.createElement(n);if(t)for(let[i,r]of Object.entries(t))r==null||r===!1||(i==="class"?o.className=r:i==="html"?o.innerHTML=r:i.startsWith("on")?o.addEventListener(i.slice(2).toLowerCase(),r):i==="dataset"?Object.assign(o.dataset,r):o.setAttribute(i,r===!0?"":r));return et(o,e),o}function et(n,t){for(let e of t)e==null||e===!1||(Array.isArray(e)?et(n,e):n.append(e instanceof Node?e:document.createTextNode(String(e))))}var te=(n,t=document)=>t.querySelector(n);function V(n,...t){n.replaceChildren(),et(n,t)}var Lt;function G(n,t=2400){let e=te("#toast");e.textContent=n,e.classList.add("show"),clearTimeout(Lt),Lt=setTimeout(()=>e.classList.remove("show"),t)}function w(n){let t=Math.floor(n/1e3),e=Math.floor(t/3600),o=Math.floor(t%3600/60),i=String(t%60).padStart(2,"0");return e?`${e}:${String(o).padStart(2,"0")}:${i}`:`${o}:${i}`}var L=n=>n.charAt(0).toUpperCase()+n.slice(1);function I(n=new Date){let t=n.getFullYear(),e=String(n.getMonth()+1).padStart(2,"0"),o=String(n.getDate()).padStart(2,"0");return`${t}-${e}-${o}`}function q(n,t){let e=new Date(`${n}T12:00:00`);return e.setDate(e.getDate()+t),I(e)}var ee={back:\'<path d="M15 18l-6-6 6-6"/>\',undo:\'<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>\',redo:\'<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>\',erase:\'<path d="M20 20H8.5L3.6 15.1a2 2 0 010-2.8L13 3l8 8-6.9 6.9"/><path d="M8 9l7 7"/>\',pencil:\'<path d="M17 3l4 4L8 20H4v-4L17 3z"/>\',bulb:\'<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z"/>\',pause:\'<path d="M9 5v14M15 5v14"/>\',play:\'<path d="M7 4l13 8-13 8z"/>\',chart:\'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>\',trophy:\'<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4z"/><path d="M17 6h3a3 3 0 01-3 4M7 6H4a3 3 0 003 4"/>\',gear:\'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.6 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.6-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/>\',help:\'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 014.9.8c0 1.7-2.4 2.2-2.4 3.7M12 17h.01"/>\',calendar:\'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>\',close:\'<path d="M18 6L6 18M6 6l12 12"/>\',share:\'<path d="M4 12v8h16v-8M12 3v13M7 8l5-5 5 5"/>\',check:\'<path d="M20 6L9 17l-5-5"/>\',left:\'<path d="M15 18l-6-6 6-6"/>\',right:\'<path d="M9 18l6-6-6-6"/>\'};function $(n,t){let e=document.createElement("span");return e.className="icon",e.innerHTML=`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${t?`role="img" aria-label="${t}"`:\'aria-hidden="true"\'}>${ee[n]}</svg>`,e.firstChild}var ot="sudoku.v1.";function nt(n,t){try{let e=localStorage.getItem(ot+n);return e?JSON.parse(e):t}catch{return t}}function st(n,t){try{localStorage.setItem(ot+n,JSON.stringify(t))}catch{}}function ne(n){try{localStorage.removeItem(ot+n)}catch{}}var se={name:"",theme:"auto",highlightPeers:!0,highlightSame:!0,autoNotes:!0,showConflicts:!0,seenHelp:!1},y={settings(){return{...se,...nt("settings",{})}},saveSettings(n){let t={...this.settings(),...n};return st("settings",t),t},game(n){return nt(`game.${n}`,null)},saveGame(n,t){st(`game.${n}`,t)},dropGame(n){ne(`game.${n}`)},results(){return nt("results",{})},saveResult(n,t,e){let o=this.results();o[n]={...o[n]||{},[t]:e},st("results",o)}};var C=["easy","medium","hard","expert"];function it(n,t=I()){let e=new Set(Object.keys(n).filter(p=>Object.keys(n[p]).length)),o=0,i=e.has(t)?t:q(t,-1);for(;e.has(i);)o++,i=q(i,-1);let r=0,c=0,h=null;for(let p of[...e].sort())c=h&&q(h,1)===p?c+1:1,r=Math.max(r,c),h=p;return{current:o,best:r,days:e.size}}function Ct(n){let t=Object.fromEntries(C.map(e=>[e,{solved:0,best:null,total:0,noHints:0}]));for(let e of Object.values(n))for(let[o,i]of Object.entries(e)){let r=t[o];r&&(r.solved++,r.total+=i.ms,i.hints||r.noHints++,(r.best===null||i.ms<r.best)&&(r.best=i.ms))}for(let e of Object.values(t))e.average=e.solved?Math.round(e.total/e.solved):null;return t}var W=class extends Error{constructor(t,e){super(e),this.status=t}};async function j(n,t){let e;try{e=await fetch(n,t?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}:{headers:{Accept:"application/json"}})}catch{throw new W(0,"You appear to be offline.")}let o=await e.json().catch(()=>({}));if(!e.ok)throw new W(e.status,o.error||`Request failed (${e.status})`);return o}var H={daily:n=>j(`/api/daily?date=${encodeURIComponent(n)}`),start:n=>j("/api/session",n),hint:(n,t)=>j("/api/hint",{token:n,board:t}),submit:n=>j("/api/submit",n),leaderboard:(n,t)=>j(`/api/leaderboard/${n}/${t}`)};function Mt({number:n,level:t,ms:e,hints:o,percentile:i,rank:r,streak:c}){let h=[`Daily Sudoku No. ${n} \\xB7 ${L(t)}`],p=[w(e),o?`${o} hint${o>1?"s":""}`:"no hints"];return r?p.push(`#${r} today`):i!=null&&p.push(`faster than ${i}%`),h.push(p.join(" \\xB7 ")),c>1&&h.push(`${c}-day streak`),h.push(location.origin),h.join(`\n`)}async function Et(n){if(navigator.share&&matchMedia("(pointer: coarse)").matches)try{return await navigator.share({text:n}),"shared"}catch{}try{return await navigator.clipboard.writeText(n),"copied"}catch{return"failed"}}function R(n,t,e=null,{onClose:o}={}){let i=s("dialog",{"aria-label":n},s("div",{class:"dlg__head"},s("h2",null,n),s("button",{class:"icon-btn",type:"button","aria-label":"Close",onclick:()=>i.close()},$("close"))),s("div",{class:"dlg__body"},t),e&&s("div",{class:"dlg__foot"},e));return i.addEventListener("click",r=>{r.target===i&&i.close()}),i.addEventListener("close",()=>{i.remove(),o?.()}),document.body.append(i),i.showModal(),i}var At=n=>n<60?`${n}s`:`${n/60}m`;function Dt({buckets:n,hist:t},e){let r=t.length,c=460/r,h=Math.max(1,...t),p=e==null?-1:(()=>{let u=n.findIndex(f=>e/1e3<f);return u===-1?n.length:u})(),S="http://www.w3.org/2000/svg",l=document.createElementNS(S,"svg");return l.setAttribute("viewBox","0 0 460 138"),l.setAttribute("class","hist"),l.setAttribute("role","img"),l.setAttribute("aria-label","Distribution of solve times today"),t.forEach((u,f)=>{let x=u?Math.max(3,u/h*120):1,g=document.createElementNS(S,"rect");g.setAttribute("x",String(f*c+2)),g.setAttribute("y",String(120-x)),g.setAttribute("width",String(c-4)),g.setAttribute("height",String(x)),f===p&&g.setAttribute("class","you");let v=document.createElementNS(S,"title");if(v.textContent=`${u} solver${u===1?"":"s"}`,g.append(v),l.append(g),f%2===0||r<8){let k=document.createElementNS(S,"text");k.setAttribute("x",String(f*c+c/2)),k.setAttribute("y",String(134)),k.setAttribute("text-anchor","middle"),k.textContent=f<n.length?`<${At(n[f])}`:`${At(n.at(-1))}+`,l.append(k)}}),l}function Nt(n,t){return n?.length?s("table",{class:"table"},s("thead",null,s("tr",null,s("th",null,"#"),s("th",null,"Name"),s("th",{class:"num"},"Hints"),s("th",{class:"num"},"Time"))),s("tbody",null,n.map((e,o)=>s("tr",{class:t&&e.name===t?"me":null},s("td",null,o+1),s("td",null,e.name),s("td",{class:"num"},e.hints||"\\u2013"),s("td",{class:"num"},w(e.ms)))))):s("p",{class:"empty"},"No verified solves yet. Be the first.")}var lt=(n,...t)=>n.replaceChildren(...t.filter(Boolean));function Tt({game:n,submit:t,onClose:e}){let o=n.session,i=y.settings(),r=s("div"),c=s("div",{class:"dlg__foot"}),h=R(`Solved \\xB7 No. ${o.number}`,r,null,{onClose:e});h.append(c);let p=s("div",{class:"result"},s("span",{class:"result__time"},w(n.time())),s("span",{class:"result__sub"},`${L(o.level)} \\xB7 ${n.hints?`${n.hints} hint${n.hints>1?"s":""} (+${n.hints*30}s)`:"no hints"}`)),S=u=>{let f=y.results(),x=it(f).current,g=s("div",{class:"facts"},s("div",null,s("b",null,u.rank?`#${u.rank}`:"\\u2013"),s("span",null,"Rank")),s("div",null,s("b",null,u.percentile!=null?`${u.percentile}%`:"\\u2013"),s("span",null,"Faster than")),s("div",null,s("b",null,u.total??"\\u2013"),s("span",null,"Solvers"))),v=[];o.mode==="daily"&&!o.ranked&&v.push("Past puzzles are verified but not ranked."),u.verified&&!u.plausible&&v.push("That was faster than our human limit, so it was not ranked."),u.duplicate&&v.push("This game was already on the board."),lt(r,p,o.mode==="daily"?g:null,u.total?Dt(u,u.ms):null,u.total?s("p",{class:"caption"},"Solve times today across all verified players. Yours is highlighted."):null,v.length?s("p",{class:"caption"},v.join(" ")):null,u.top?Nt(u.top,i.name||"Anonymous"):null),lt(c,o.mode==="daily"?s("button",{class:"btn btn--accent",type:"button",onclick:async()=>{let k=Mt({number:o.number,level:o.level,ms:u.ms,hints:u.hints,percentile:u.percentile,rank:u.rank,streak:x}),N=await Et(k);G(N==="copied"?"Result copied to clipboard":N==="shared"?"Shared":"Could not share")}},$("share"),"Share"):null,s("button",{class:"btn",type:"button",onclick:()=>h.close()},"Close")),c.after(_t())},l=async u=>{r.replaceChildren(p,s("p",{class:"empty"},"Verifying your solve on the server\\u2026")),c.replaceChildren();try{S(await t(u))}catch(f){r.replaceChildren(p,s("p",{class:"caption"},`Could not verify: ${f.message}`)),c.replaceChildren(s("button",{class:"btn btn--primary",type:"button",onclick:()=>l(u)},"Try again"))}};if(n.result)S(n.result);else if(o.ranked&&!i.name){let u=s("input",{class:"input",id:"name",maxlength:"20",autocomplete:"nickname",placeholder:"Anonymous"}),f=s("form",{onsubmit:x=>{x.preventDefault();let g=u.value.trim();y.saveSettings({name:g}),l(g)}},s("div",{class:"field"},s("label",{for:"name"},"Name on today\'s leaderboard"),u),s("button",{class:"btn btn--accent",type:"submit"},"Submit result"));r.replaceChildren(p,f),setTimeout(()=>u.focus(),50)}else l(i.name);return h}function Ht(n,t="easy"){let e=s("div"),o=s("div",{class:"tabs",role:"tablist"}),i=async r=>{for(let c of o.children)c.setAttribute("aria-selected",String(c.dataset.level===r));e.replaceChildren(s("p",{class:"empty"},"Loading\\u2026"));try{let c=await H.leaderboard(n,r);lt(e,c.total?Dt(c,null):null,c.total?s("p",{class:"caption"},`${c.total} verified solver${c.total===1?"":"s"} today.`):null,Nt(c.top,y.settings().name))}catch(c){e.replaceChildren(s("p",{class:"empty"},c.message))}};for(let r of C)o.append(s("button",{class:"tab",role:"tab",type:"button",dataset:{level:r},onclick:()=>i(r)},L(r)));R("Leaderboard",[o,e]),i(t)}function zt(){let n=y.results(),t=it(n),e=Ct(n);R("Statistics",[s("div",{class:"facts"},s("div",null,s("b",null,t.days),s("span",null,"Days played")),s("div",null,s("b",null,t.current),s("span",null,"Streak")),s("div",null,s("b",null,t.best),s("span",null,"Best streak"))),s("table",{class:"table"},s("thead",null,s("tr",null,s("th",null,""),s("th",null,"Level"),s("th",{class:"num"},"Solved"),s("th",{class:"num"},"Best"),s("th",{class:"num"},"Average"))),s("tbody",null,C.map((o,i)=>{let r=e[o];return s("tr",null,s("td",null,i+1),s("td",null,L(o)),s("td",{class:"num"},r.solved),s("td",{class:"num"},r.best!=null?w(r.best):"\\u2013"),s("td",{class:"num"},r.average!=null?w(r.average):"\\u2013"))}))),_t()])}function _t(){let n=s("b"),t=s("div",{class:"result"},s("span",{class:"sub"},"Next puzzles in"),s("span",{class:"result__time"},n)),e=()=>{if(!t.isConnected&&t.dataset.started)return clearInterval(o);t.dataset.started="1";let i=new Date,r=new Date(i.getFullYear(),i.getMonth(),i.getDate()+1),c=Math.max(0,Math.floor((r-i)/1e3));n.textContent=[c/3600,c%3600/60,c%60].map(h=>String(Math.floor(h)).padStart(2,"0")).join(":")},o=setInterval(e,1e3);return e(),t}function rt(){R("How to play",s("div",{class:"help"},s("p",null,"Fill the grid so every row, column and 3\\xD73 box contains the digits 1 to 9 exactly once."),s("ul",null,s("li",null,"There are four new puzzles every day, from Easy to Expert. Everyone gets the same ones."),s("li",null,"Every puzzle can be solved by logic alone. The label tells you the hardest technique it needs."),s("li",null,"A hint explains the next logical step instead of just giving the answer. Each hint adds 30 seconds."),s("li",null,"When you finish, the server replays your moves to verify the solve before it goes on the leaderboard.")),s("p",null,"Keys: 1\\u20139 to place, Shift+digit or N for notes, arrows to move, Backspace to erase, H for a hint, Space to pause, Ctrl+Z to undo.")))}function at(n){n==="auto"?document.documentElement.removeAttribute("data-theme"):document.documentElement.setAttribute("data-theme",n)}function It(n){let t=y.settings(),e=c=>{let h=y.saveSettings(c);at(h.theme),n?.(h)},o=s("div",{class:"seg",role:"group","aria-label":"Theme"});for(let c of["auto","light","dark"])o.append(s("button",{type:"button","aria-pressed":String(t.theme===c),onclick:h=>{for(let p of o.children)p.setAttribute("aria-pressed",String(p===h.currentTarget));e({theme:c})}},L(c)));let i=(c,h)=>{let p=s("input",{type:"checkbox",id:`opt-${c}`,onchange:S=>e({[c]:S.target.checked})});return p.checked=t[c],s("label",{class:"toggle",for:`opt-${c}`},h,p)},r=s("input",{class:"input",id:"opt-name",maxlength:"20",value:t.name,placeholder:"Anonymous",onchange:c=>e({name:c.target.value.trim()})});R("Settings",[s("div",{class:"field"},s("label",{for:"opt-name"},"Leaderboard name"),r),s("div",{class:"field"},s("label",null,"Theme"),o),i("highlightPeers","Highlight row, column and box"),i("highlightSame","Highlight matching digits"),i("showConflicts","Mark rule conflicts"),i("autoNotes","Remove notes when placing a digit")])}var M=[],jt=[],z=[],Rt=new Uint8Array(6561);for(let n=0;n<27;n++)M.push([]);for(let n=0;n<9;n++)for(let t=0;t<9;t++){M[n].push(n*9+t),M[9+n].push(t*9+n);let e=Math.floor(n/3)*3,o=n%3*3;M[18+n].push((e+Math.floor(t/3))*9+o+t%3)}for(let n=0;n<81;n++){let t=Math.floor(n/9),e=n%9;jt.push([t,9+e,18+Math.floor(t/3)*3+Math.floor(e/3)]);let o=[];for(let i of jt[n])for(let r of M[i])r!==n&&!Rt[n*81+r]&&(Rt[n*81+r]=1,o.push(r));z.push(o)}var oe=n=>Math.floor(n/9),ie=n=>n%9;var Bt=n=>`r${oe(n)+1}c${ie(n)+1}`;var B=class extends Error{};function ct(n){if(typeof n!="string")throw new B("board must be a string");let t=n.replace(/\\s+/g,"");if(t.length!==81)throw new B(`board must have 81 cells, got ${t.length}`);let e=new Uint8Array(81);for(let o=0;o<81;o++){let i=t.charCodeAt(o);if(i===46)continue;let r=i-48;if(r<0||r>9)throw new B(`invalid character "${t[o]}" at ${o}`);e[o]=r}return e}function Ot(n){let t="";for(let e=0;e<81;e++)t+=String.fromCharCode(48+n[e]);return t}function Pt(n){let t=new Set;for(let e of M){let o=new Array(10).fill(-1);for(let i of e){let r=n[i];r&&(o[r]>=0?(t.add(i),t.add(o[r])):o[r]=i)}}return t}var O=class{constructor(t,e=null){this.session=t,this.puzzle=ct(t.puzzle),this.values=e?ct(e.values):Uint8Array.from(this.puzzle),this.notes=e?Uint16Array.from(e.notes):new Uint16Array(81),this.moves=e?e.moves:[],this.elapsed=e?e.elapsed:0,this.hints=e?e.hints:0,this.token=e?e.token:t.token,this.done=e?e.done:!1,this.result=e?e.result:null,this.undoStack=[],this.redoStack=[],this.runningSince=null,this.listeners=new Set,this.refreshConflicts()}onChange(t){return this.listeners.add(t),()=>this.listeners.delete(t)}emit(t,e){for(let o of this.listeners)o(t,e)}start(){this.done||this.runningSince!==null||(this.runningSince=performance.now(),this.emit("clock"))}pause(){this.runningSince!==null&&(this.elapsed+=Math.round(performance.now()-this.runningSince),this.runningSince=null,this.emit("clock"))}get running(){return this.runningSince!==null}time(){return this.elapsed+(this.runningSince===null?0:Math.round(performance.now()-this.runningSince))}isGiven(t){return this.puzzle[t]!==0}refreshConflicts(){this.conflicts=Pt(this.values)}remaining(){let t=new Array(10).fill(9);for(let e of this.values)e&&t[e]--;return t}get complete(){return this.values.every(t=>t!==0)&&this.conflicts.size===0}board(){return Ot(this.values)}commit(t,{record:e=!0}={}){if(t.length){for(let o of t)o.v1!==this.values[o.i]&&this.log(o.i,o.v1),this.values[o.i]=o.v1,this.notes[o.i]=o.n1;e&&(this.undoStack.push(t),this.undoStack.length>500&&this.undoStack.shift(),this.redoStack=[]),this.refreshConflicts(),this.emit("board",{cells:t.map(o=>o.i)}),this.complete&&this.emit("complete")}}log(t,e){this.start(),this.moves.push([t,e,this.time()])}change(t,e,o){return{i:t,v0:this.values[t],n0:this.notes[t],v1:e,n1:o}}setValue(t,e,{autoNotes:o=!0}={}){if(this.done||this.isGiven(t))return!1;let i=this.values[t]===e?0:e,r=[this.change(t,i,0)];if(i&&o){let c=1<<i;for(let h of z[t])!this.values[h]&&this.notes[h]&c&&r.push(this.change(h,0,this.notes[h]&~c))}return this.commit(r),!0}toggleNote(t,e){return this.done||this.isGiven(t)||this.values[t]?!1:(this.commit([this.change(t,0,this.notes[t]^1<<e)]),!0)}erase(t){return this.done||this.isGiven(t)||!this.values[t]&&!this.notes[t]?!1:(this.commit([this.change(t,0,0)]),!0)}fillNotes(){if(this.done)return;let t=[];for(let e=0;e<81;e++){if(this.values[e])continue;let o=1022;for(let i of z[e])this.values[i]&&(o&=~(1<<this.values[i]));o!==this.notes[e]&&t.push(this.change(e,0,o))}this.commit(t)}applyEliminations(t){let e=[],o=new Map;for(let[i,r]of t)this.values[i]||o.set(i,(o.get(i)??this.notes[i])&~(1<<r));for(let[i,r]of o)r!==this.notes[i]&&e.push(this.change(i,0,r));this.commit(e)}undo(){let t=this.undoStack.pop();return!t||this.done?!1:(this.redoStack.push(t),this.commit(t.map(e=>({i:e.i,v0:e.v1,n0:e.n1,v1:e.v0,n1:e.n0})).reverse(),{record:!1}),!0)}redo(){let t=this.redoStack.pop();return!t||this.done?!1:(this.undoStack.push(t),this.commit(t,{record:!1}),!0)}snapshot(){return{session:this.session,values:this.board(),notes:[...this.notes],moves:this.moves,elapsed:this.time(),hints:this.hints,token:this.token,done:this.done,result:this.result,savedAt:Date.now()}}};var K=class{constructor(t,e,{onSelect:o}){this.game=t,this.settings=e,this.selected=-1,this.hint=null,this.cells=[],this.el=s("div",{class:"board",role:"grid","aria-label":"Sudoku board"});for(let i=0;i<81;i++){let r=s("button",{class:"cell",type:"button",role:"gridcell",tabindex:"-1",onclick:()=>o(i)});this.cells.push(r),this.el.append(r)}this.renderAll()}select(t){this.selected=t,this.cells[t]?.focus({preventScroll:!0}),this.paint()}showHint(t){this.hint=t,this.paint()}clearHint(){this.hint&&(this.hint=null,this.renderAll())}renderAll(){for(let t=0;t<81;t++)this.renderCell(t);this.paint()}renderCells(t){for(let e of t)this.renderCell(e);this.paint()}renderCell(t){let{game:e}=this,o=this.cells[t],i=e.values[t];if(o.classList.toggle("given",e.isGiven(t)),i)o.textContent=String(i);else if(e.notes[t]){let c=s("span",{class:"notes","aria-hidden":"true"});for(let h=1;h<=9;h++)c.append(s("span",{dataset:{d:h}},e.notes[t]&1<<h?String(h):""));o.replaceChildren(c)}else o.textContent="";let r=[...Array(9).keys()].filter(c=>e.notes[t]&1<<c+1).map(c=>c+1);o.setAttribute("aria-label",`${Bt(t)}, ${i?`${i}${e.isGiven(t)?", given":""}`:r.length?`notes ${r.join(" ")}`:"empty"}`)}paint(){let{game:t,selected:e,settings:o,hint:i}=this,r=e>=0?t.values[e]:0,c=new Set(e>=0&&o.highlightPeers?z[e]:[]),h=new Set(i?i.units.flatMap(l=>M[l]):[]),p=new Set(i?i.cells:[]),S=new Map;if(i)for(let[l,u]of i.eliminations)S.set(l,(S.get(l)||0)|1<<u);for(let l=0;l<81;l++){let u=this.cells[l].classList;u.toggle("selected",l===e),u.toggle("peer",!i&&c.has(l)),u.toggle("same",!i&&o.highlightSame&&r!==0&&t.values[l]===r&&l!==e),u.toggle("conflict",o.showConflicts&&t.conflicts.has(l)&&!t.isGiven(l)),u.toggle("hint-unit",h.has(l)),u.toggle("hint-cell",p.has(l)&&l!==i?.index),u.toggle("hint-target",i?.index===l),this.cells[l].setAttribute("aria-selected",String(l===e));let f=this.cells[l].querySelector(".notes");if(f){let x=S.get(l)||0;for(let g of f.children){let v=Number(g.dataset.d);g.classList.toggle("elim",!!(x&1<<v)),g.classList.toggle("match",!i&&o.highlightSame&&r===v&&g.textContent!=="")}}}}pop(t){let e=this.cells[t];e.classList.remove("pop"),e.offsetWidth,e.classList.add("pop")}celebrate(){this.selected=-1,this.paint(),this.cells.forEach((t,e)=>{t.style.animationDelay=`${(Math.floor(e/9)+e%9)*35}ms`,t.classList.add("wave")})}};function Ut(n,{date:t,level:e,onLevel:o,settings:i}){let r=`d:${t}:${e}`,c=()=>{},h=!0,p=()=>{let l=y.results()[t]||{};return s("div",{class:"levels",role:"tablist"},C.map(u=>s("button",{class:`level${l[u]?" done":""}`,type:"button",role:"tab","aria-current":String(u===e),onclick:()=>u!==e&&o(u)},L(u))))};V(n,s("div",{class:"bar"},p()),s("p",{class:"boot"},"Loading\\u2026")),(async()=>{let l=y.game(r),u;try{u=l?.session?new O(l.session,l):new O(await H.start({mode:"daily",date:t,level:e}))}catch(f){h&&V(n,s("div",{class:"bar"},p()),s("p",{class:"boot"},f.message));return}h&&(c=S(u))})();function S(l){let u=i(),f=!1,x=null,g=!1,v=()=>y.saveGame(r,l.snapshot()),k=s("span",null,w(l.time())),N=s("button",{class:"icon-btn",type:"button","aria-label":"Pause",onclick:()=>U()},$("pause")),ht=s("p",{class:"status"},`No. ${l.session.number} \\xB7 needs ${l.session.technique}`),b=new K(l,u,{onSelect:a=>bt(a)}),dt=s("div",{class:"board-wrap"},b.el),J=s("div",{"aria-live":"polite"}),P=(a,d,m,D={})=>s("button",{class:"tool",type:"button",onclick:m,...D},$(a),d),pt=P("undo","Undo",()=>l.undo()),ft=P("erase","Erase",()=>b.selected>=0&&l.erase(b.selected)),Z=P("pencil","Notes",()=>vt(!f),{"aria-pressed":"false"}),mt=s("span",{class:"tool__count"}),X=P("bulb","Hint",()=>St());X.append(mt);let gt=[],Q=s("div",{class:"pad"});for(let a=1;a<=9;a++){let d=s("button",{class:"key",type:"button","aria-label":`Enter ${a}`,onclick:()=>yt(a)},String(a));gt.push(d),Q.append(d)}V(n,s("div",{class:"bar"},p(),s("div",{class:"clock"},k,N)),ht,dt,s("div",{class:"tools"},pt,ft,Z,X),Q,J);function T(){let a=l.remaining();gt.forEach((d,m)=>{d.disabled=l.done||a[m+1]<=0&&!f}),pt.disabled=l.done||!l.undoStack.length,ft.disabled=Z.disabled=l.done,X.disabled=l.done||g,mt.textContent=l.hints?String(l.hints):""}function vt(a){f=a,Z.setAttribute("aria-pressed",String(a)),Q.classList.toggle("notes-mode",a),T()}function bt(a){x&&A(),b.select(a)}function yt(a,d=f){let m=b.selected;if(l.done||m<0||l.isGiven(m))return;x&&A(),(d?l.toggleNote(m,a):l.setValue(m,a,{autoNotes:u.autoNotes}))&&!d&&b.pop(m)}function A(){x=null,b.clearHint(),J.replaceChildren()}async function St(){if(!(g||l.done)){g=!0,T();try{let a=await H.hint(l.token,l.board());l.token=a.token,l.hints=a.hints,l.start(),v(),x=a,b.showHint(a),Wt(a)}catch(a){G(a.message)}finally{g=!1,T()}}}function Wt(a){let d=s("div",{class:"explain__actions"});a.kind==="mistake"?d.append(s("button",{class:"btn btn--primary",type:"button",onclick:()=>{let m=a.index;A(),l.erase(m),b.select(m)}},"Clear it")):(a.eliminations.length&&d.append(s("button",{class:"btn",type:"button",onclick:()=>l.applyEliminations(a.eliminations)},"Remove notes")),d.append(s("button",{class:"btn btn--primary",type:"button",onclick:()=>{let{index:m,value:D}=a;A(),l.setValue(m,D,{autoNotes:u.autoNotes}),b.select(m),b.pop(m)}},`Place ${a.value}`))),d.append(s("button",{class:"btn btn--ghost",type:"button",onclick:A},"Close")),J.replaceChildren(s("div",{class:"explain"},s("h3",null,a.technique),a.chain.length?s("ol",null,a.chain.map(m=>s("li",null,s("b",null,`${m.technique}: `),m.description)),s("li",null,a.description)):s("p",null,a.description),d))}let E=null;function U(a){if(l.done)return;let d=a??!E;d&&!E?(l.pause(),E=s("div",{class:"pause"},s("p",null,"Paused"),s("button",{class:"btn btn--primary",type:"button",onclick:()=>U(!1)},"Resume")),dt.append(E),N.replaceChildren($("play")),v()):!d&&E&&(E.remove(),E=null,N.replaceChildren($("pause")),l.moves.length&&l.start())}let Ft=setInterval(()=>k.textContent=w(l.time()),250),Kt=setInterval(()=>l.running&&v(),5e3),xt=()=>document.hidden&&U(!0);document.addEventListener("visibilitychange",xt),window.addEventListener("pagehide",v);function Yt(){l.pause(),l.done=!0,v(),A(),T(),b.celebrate(),setTimeout(Jt,700)}function Jt(){Tt({game:l,submit:async a=>{let d=await H.submit({token:l.token,moves:l.moves,elapsed:l.time(),name:a});return l.result=d,v(),y.saveResult(t,e,{ms:d.ms,hints:d.hints,rank:d.rank??null,percentile:d.percentile??null}),n.querySelector(".levels")?.replaceWith(p()),d}})}function wt(a){if(document.querySelector("dialog[open]")||a.target.closest("input"))return;let d=a.key,m=a.ctrlKey||a.metaKey;if(m&&d.toLowerCase()==="z")return a.preventDefault(),a.shiftKey?l.redo():l.undo();if(m&&d.toLowerCase()==="y")return a.preventDefault(),l.redo();if(m||a.altKey)return;if(d===" ")return a.preventDefault(),U();if(E||l.done)return;let D=/^Digit([1-9])$/.exec(a.code)||/^Numpad([1-9])$/.exec(a.code);if(D)return a.preventDefault(),yt(Number(D[1]),f!==a.shiftKey);if(d==="Backspace"||d==="Delete")return a.preventDefault(),b.selected>=0&&l.erase(b.selected);if(d==="n"||d==="N")return vt(!f);if(d==="h"||d==="H")return St();if(d==="Escape"&&x)return A();let tt={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[d];if(tt){a.preventDefault();let $t=b.selected<0?40:b.selected,Xt=(Math.floor($t/9)+tt[0]+9)%9,Qt=($t%9+tt[1]+9)%9;bt(Xt*9+Qt)}}document.addEventListener("keydown",wt);let Zt=l.onChange((a,d)=>{a==="board"&&(b.renderCells(d.cells),T(),v()),a==="complete"&&Yt()}),kt=()=>{u=i(),b.settings=u,b.renderAll()};return window.addEventListener("settings",kt),T(),l.done?(b.renderAll(),ht.textContent=`Solved in ${w(l.time())}`):(b.select(l.values.findIndex(a=>!a)),l.moves.length&&l.start()),()=>{v(),Zt(),clearInterval(Ft),clearInterval(Kt),document.removeEventListener("keydown",wt),document.removeEventListener("visibilitychange",xt),window.removeEventListener("pagehide",v),window.removeEventListener("settings",kt)}}return()=>{h=!1,c()}}at(y.settings().theme);var ut=I(),Y=(n,t,e)=>s("button",{class:"icon-btn",type:"button","aria-label":t,title:t,onclick:e},$(n)),Gt=s("main",{class:"game"}),_=new URLSearchParams(location.search).get("level");document.getElementById("app").append(s("header",{class:"top"},s("div",null,Y("help","How to play",rt)),s("h1",null,"Sudoku"),s("div",{class:"top__right"},Y("trophy","Leaderboard",()=>Ht(ut,_)),Y("chart","Statistics",zt),Y("gear","Settings",()=>It(()=>window.dispatchEvent(new Event("settings")))))),Gt);if(!C.includes(_)){let n=y.results()[ut]||{};_=C.find(t=>!n[t])||"expert"}var Vt=()=>{};function qt(n){Vt(),_=n,history.replaceState(null,"",n==="easy"?"/":`/?level=${n}`),Vt=Ut(Gt,{date:ut,level:_,onLevel:qt,settings:()=>y.settings()})}qt(_);y.settings().seenHelp||(y.saveSettings({seenHelp:!0}),rt());})();\n', "css": ':root{--bg: #ffffff;--text: #121213;--muted: #787c7e;--line: #d3d6da;--line-strong: #121213;--key: #e9ebee;--key-hover: #dcdfe3;--accent: #2f6fde;--accent-text: #ffffff;--entry: #2f6fde;--sel: #bcd3fb;--peer: #eef1f5;--same: #d6e3fb;--bad: #d93a3a;--hint: #fff1c2;color-scheme:light}@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg: #121213;--text: #f2f2f2;--muted: #8b8f94;--line: #3a3a3c;--line-strong: #c8c8c8;--key: #2c2c2e;--key-hover: #3a3a3c;--accent: #5b8ff0;--accent-text: #0b1220;--entry: #7ea8f5;--sel: #23406f;--peer: #1c1d20;--same: #1f3152;--bad: #ff6b6b;--hint: #4a3d12;color-scheme:dark}}:root[data-theme=dark]{--bg: #121213;--text: #f2f2f2;--muted: #8b8f94;--line: #3a3a3c;--line-strong: #c8c8c8;--key: #2c2c2e;--key-hover: #3a3a3c;--accent: #5b8ff0;--accent-text: #0b1220;--entry: #7ea8f5;--sel: #23406f;--peer: #1c1d20;--same: #1f3152;--bad: #ff6b6b;--hint: #4a3d12;color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}button,input{font:inherit;color:inherit}button{cursor:pointer}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.top{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;height:56px;padding:0 8px;border-bottom:1px solid var(--line)}.top h1{margin:0;font-size:26px;font-weight:800;letter-spacing:.02em}.top__right{display:flex;justify-content:flex-end}.icon-btn{display:inline-grid;place-items:center;width:40px;height:40px;border:0;border-radius:8px;background:none}.icon-btn:hover{background:var(--peer)}.icon{width:22px;height:22px}.game{width:100%;max-width:500px;margin:0 auto;padding:12px 12px 24px}.bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}.levels{display:flex;gap:4px}.level{border:0;border-radius:999px;padding:5px 11px;background:none;font-size:13px;font-weight:600;color:var(--muted)}.level:hover{color:var(--text)}.level[aria-current=true]{background:var(--text);color:var(--bg)}.level.done:after{content:" \\2713"}.clock{display:flex;align-items:center;font-variant-numeric:tabular-nums;font-weight:600;color:var(--muted)}.clock .icon-btn{width:32px;height:32px}.clock .icon{width:18px;height:18px}.status{min-height:20px;margin:0 0 8px;font-size:13px;color:var(--muted);text-align:center}.board-wrap{position:relative}.board{display:grid;grid-template-columns:repeat(9,1fr);aspect-ratio:1;border:2px solid var(--line-strong);user-select:none;-webkit-user-select:none;touch-action:manipulation}.cell{position:relative;display:grid;place-items:center;padding:0;border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:transparent;font-size:clamp(20px,6vw,30px);font-weight:500;color:var(--entry)}.cell:focus-visible{outline:none}.cell:nth-child(9n){border-right:0}.cell:nth-child(9n+3),.cell:nth-child(9n+6){border-right:2px solid var(--line-strong)}.cell:nth-child(n+19):nth-child(-n+27),.cell:nth-child(n+46):nth-child(-n+54){border-bottom:2px solid var(--line-strong)}.cell:nth-child(n+73){border-bottom:0}.cell.given{color:var(--text);font-weight:700}.cell.peer{background:var(--peer)}.cell.same{background:var(--same)}.cell.selected{background:var(--sel)}.cell.conflict{color:var(--bad)}.cell.hint-unit{background:var(--hint)}.cell.hint-cell{box-shadow:inset 0 0 0 2px var(--accent)}.cell.hint-target{box-shadow:inset 0 0 0 3px var(--bad)}.cell.pop{animation:pop .15s ease-out}@keyframes pop{50%{transform:scale(1.15)}}.cell.wave{animation:flip .5s ease-out both}@keyframes flip{50%{transform:rotateX(90deg)}}.notes{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);width:100%;height:100%;font-size:clamp(8px,2vw,11px);font-weight:500;color:var(--muted)}.notes span{display:grid;place-items:center}.notes span.match{color:var(--accent);font-weight:700}.notes span.elim{color:var(--bad);text-decoration:line-through;font-weight:700}.pause{position:absolute;inset:0;display:grid;place-content:center;gap:12px;background:var(--bg);border:2px solid var(--line-strong);text-align:center}.pause p{margin:0;font-weight:600}.tools{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:14px 0 8px}.tool{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;border:0;border-radius:8px;background:none;font-size:12px;font-weight:600;color:var(--muted)}.tool:hover:not(:disabled){color:var(--text);background:var(--peer)}.tool:disabled{opacity:.35;cursor:default}.tool[aria-pressed=true]{color:var(--accent)}.tool[aria-pressed=true]:after{content:"ON";position:absolute;top:2px;right:18%;font-size:9px;padding:0 4px;border-radius:4px;background:var(--accent);color:var(--accent-text)}.tool__count{position:absolute;top:2px;right:22%;font-size:10px;color:var(--bad)}.pad{display:grid;grid-template-columns:repeat(9,1fr);gap:5px}.key{display:grid;place-items:center;height:56px;border:0;border-radius:6px;background:var(--key);font-size:22px;font-weight:600}.key:hover:not(:disabled){background:var(--key-hover)}.key:disabled{opacity:.3;cursor:default}.key small{display:none}.notes-mode .key{color:var(--accent);font-size:16px}.explain{margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;font-size:14px}.explain h3{margin:0 0 4px;font-size:15px}.explain p,.explain ol{margin:0 0 10px;color:var(--muted)}.explain ol{padding-left:18px}.explain b{color:var(--text)}.explain__actions{display:flex;flex-wrap:wrap;gap:8px}.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;padding:0 16px;border:0;border-radius:8px;background:var(--key);font-weight:600;text-decoration:none;color:var(--text)}.btn:hover{background:var(--key-hover)}.btn--primary,.btn--accent{background:var(--accent);color:var(--accent-text)}.btn--primary:hover,.btn--accent:hover{background:var(--accent);filter:brightness(1.08)}.btn--ghost{background:none}.link{border:0;background:none;padding:0;color:var(--muted);text-decoration:underline}dialog{width:min(440px,calc(100vw - 24px));max-height:calc(100dvh - 40px);padding:0;border:0;border-radius:12px;background:var(--bg);color:var(--text);box-shadow:0 10px 40px #00000040}dialog::backdrop{background:#00000080}dialog[open]{animation:rise .18s ease-out}@keyframes rise{0%{opacity:0;transform:translateY(10px)}}.dlg__head{display:flex;align-items:center;justify-content:space-between;padding:12px 10px 4px 20px}.dlg__head h2{margin:0;font-size:17px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}.dlg__body{padding:8px 20px 20px}.dlg__foot{display:flex;justify-content:center;flex-wrap:wrap;gap:8px;padding:0 20px 20px}.result{text-align:center;padding:4px 0 14px}.result__time{display:block;font-size:44px;font-weight:800;font-variant-numeric:tabular-nums}.result__sub{color:var(--muted);font-size:14px}.facts{display:grid;grid-template-columns:repeat(3,1fr);margin-bottom:16px;text-align:center}.facts b{display:block;font-size:30px;font-weight:700;font-variant-numeric:tabular-nums}.facts span{font-size:12px;color:var(--muted)}.sub{margin:4px 0 8px;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}.hist{display:block;width:100%;height:auto}.hist rect{fill:var(--line)}.hist rect.you{fill:var(--accent)}.hist text{fill:var(--muted);font-size:10px}.caption{margin:8px 0 14px;font-size:12px;color:var(--muted)}.table{width:100%;border-collapse:collapse;font-size:14px}.table th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:4px;border-bottom:1px solid var(--line)}.table td{padding:7px 4px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}.table td:first-child{width:28px;color:var(--muted)}.table .num{text-align:right}.table tr.me td{font-weight:700}.tabs{display:flex;gap:4px;margin-bottom:12px}.tab{border:0;border-radius:999px;padding:5px 11px;background:none;font-size:13px;font-weight:600;color:var(--muted)}.tab[aria-selected=true]{background:var(--text);color:var(--bg)}.field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}.field label{font-size:13px;font-weight:600}.input{height:40px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}.seg{display:inline-flex;gap:4px}.seg button{border:1px solid var(--line);border-radius:8px;background:none;padding:6px 12px;font-size:13px}.seg button[aria-pressed=true]{background:var(--text);border-color:var(--text);color:var(--bg)}.toggle{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--line);font-size:15px}.toggle input{width:18px;height:18px;accent-color:var(--accent)}.help p,.help li{font-size:14px}.help ul{padding-left:18px}.empty{color:var(--muted);padding:8px 0}.boot{text-align:center;color:var(--muted);padding:30vh 16px}.toast{position:fixed;left:50%;top:70px;transform:translate(-50%);padding:10px 14px;border-radius:6px;background:var(--text);color:var(--bg);font-weight:600;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:50}.toast.show{opacity:1}@media (max-width: 420px){.key{height:52px;font-size:20px}.level{padding:5px 8px}}@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}\n', "version": "7151e37d65a0", "favicon": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2f6fde"/><path d="M24 10v44M40 10v44M10 24h44M10 40h44" stroke="#fff" stroke-opacity=".45" stroke-width="2"/><text x="32" y="45" font-family="system-ui,sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">9</text></svg>\n', "manifest": '{\n  "name": "Daily Sudoku",\n  "short_name": "Sudoku",\n  "start_url": "/",\n  "display": "standalone",\n  "background_color": "#ffffff",\n  "theme_color": "#ffffff",\n  "icons": [{ "src": "/favicon.svg", "sizes": "any", "type": "image/svg+xml" }]\n}\n' };

// src/worker.js
var app = createApp({ assets: assets_default });
var worker_default = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx)
};
export {
  worker_default as default
};
