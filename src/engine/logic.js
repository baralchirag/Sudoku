// Human-style solver: repeatedly applies the simplest technique that makes
// progress, never guessing. Each deduction is a Step that carries enough
// detail (pattern cells, eliminations, wording) to explain it to a player.
//
// This mirrors engine-go/logic, which grades the puzzle bank offline; the
// Worker uses this port to explain hints and to re-check grades in tests.

import {
  UNITS, CELL_UNITS, PEERS, ALL_DIGITS,
  sees, cellName, unitName, popcount, lowestDigit, digitsOf,
} from './geometry.js';

export const Technique = Object.freeze({
  HiddenSingle: 0,
  NakedSingle: 1,
  LockedCandidates: 2,
  NakedPair: 3,
  HiddenPair: 4,
  NakedTriple: 5,
  HiddenTriple: 6,
  XWing: 7,
  XYWing: 8,
  Swordfish: 9,
});

export const TECHNIQUE_NAMES = [
  'Hidden Single', 'Naked Single', 'Locked Candidates', 'Naked Pair', 'Hidden Pair',
  'Naked Triple', 'Hidden Triple', 'X-Wing', 'XY-Wing', 'Swordfish',
];

export const LEVELS = ['easy', 'medium', 'hard', 'expert'];

/** Difficulty tier (0-3) a technique belongs to. */
export function techniqueLevel(t) {
  if (t <= Technique.HiddenSingle) return 0;
  if (t === Technique.NakedSingle) return 1;
  if (t <= Technique.HiddenTriple) return 2;
  return 3;
}

const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const digitList = (mask) => and(digitsOf(mask));
const cellList = (cells) => and(cells.map(cellName));

/**
 * @typedef {object} Step
 * @property {number} technique
 * @property {string} name
 * @property {number} index        placed cell, or -1 for elimination-only steps
 * @property {number} value        placed digit (0 when index is -1)
 * @property {number[][]} eliminations  [cell, digit] pairs
 * @property {number[]} cells      cells forming the pattern
 * @property {number[]} units      units the pattern lives in (for highlighting)
 * @property {string} description
 */
function step(technique, fields) {
  return {
    technique,
    name: TECHNIQUE_NAMES[technique],
    index: -1,
    value: 0,
    eliminations: [],
    cells: [],
    units: [],
    ...fields,
  };
}

// ---- candidate grid ----

export class Grid {
  constructor() {
    this.vals = new Uint8Array(81);
    this.cand = new Uint16Array(81).fill(ALL_DIGITS);
  }

  /** Builds a grid from placed digits; returns null if givens clash. */
  static from(board) {
    const g = new Grid();
    for (let i = 0; i < 81; i++) {
      const v = board[i];
      if (!v) continue;
      if (!(g.cand[i] & (1 << v))) return null;
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
}

// ---- helpers ----

// Boxes first: a hidden single in a box is the easiest thing to spot.
const UNIT_ORDER = [...Array(9).keys()].map((i) => 18 + i).concat([...Array(18).keys()]);

const allInUnit = (cells, u) => cells.every((c) => CELL_UNITS[c].includes(u));

/** Calls fn with each k-subset of items; stops early when fn returns truthy. */
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

/** Bitmask of cells' positions (0-8) inside unit u. */
function cellMask(u, cells) {
  let m = 0;
  UNITS[u].forEach((c, j) => {
    if (cells.includes(c)) m |= 1 << j;
  });
  return m;
}

// ---- techniques ----

function hiddenSingle(g) {
  for (const u of UNIT_ORDER) {
    for (let v = 1; v <= 9; v++) {
      const pos = g.positions(u, v);
      if (pos.length === 1) {
        return step(Technique.HiddenSingle, {
          index: pos[0], value: v, cells: UNITS[u], units: [u],
          description: `In ${unitName(u)}, the only place for ${v} is ${cellName(pos[0])}.`,
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
        index: i, value: v, cells: PEERS[i], units: CELL_UNITS[i],
        description: `${cap(cellName(i))} already sees every number except ${v}, so it must be ${v}.`,
      });
    }
  }
  return null;
}

// Pointing: a digit confined to one line inside a box clears that line
// outside the box. Claiming: a digit confined to one box inside a line clears
// that box outside the line.
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
            eliminations: elims, cells: pos, units: [b, line],
            description: `In ${unitName(b)}, ${v} can only go in ${unitName(line)}. So ${v} can't go anywhere else in ${unitName(line)}.`,
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
          eliminations: elims, cells: pos, units: [line, b],
          description: `In ${unitName(line)}, ${v} can only go in ${unitName(b)}. So ${v} can't go anywhere else in ${unitName(b)}.`,
        });
      }
    }
  }
  return null;
}

const subsetTechnique = (naked, n) =>
  naked
    ? n === 2 ? Technique.NakedPair : Technique.NakedTriple
    : n === 2 ? Technique.HiddenPair : Technique.HiddenTriple;

// n cells of a unit whose candidates together are exactly n digits.
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
        eliminations: elims, cells: pattern, units: [u],
        description: `In ${unitName(u)}, ${cellList(pattern)} can only hold ${digitList(union)} between them. So those numbers can't go anywhere else in ${unitName(u)}.`,
      });
    });
    if (found) return found;
  }
  return null;
}

// n digits that, within a unit, fit only in the same n cells.
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
      const cells = UNITS[u].filter((_, j) => cellsMask & (1 << j));
      const elims = cells.flatMap((c) => digitsOf(g.cand[c] & ~digitMask).map((v) => [c, v]));
      if (!elims.length) return null;
      return step(subsetTechnique(false, n), {
        eliminations: elims, cells, units: [u],
        description: `In ${unitName(u)}, ${digitList(digitMask)} only fit in ${cellList(cells)}. So those cells can't hold any other number.`,
      });
    });
    if (found) return found;
  }
  return null;
}

// X-Wing (n=2) and Swordfish (n=3): if v's candidates in n rows fall within
// the same n columns, v leaves those columns everywhere else (and vice versa).
function fish(g, n) {
  const technique = n === 2 ? Technique.XWing : Technique.Swordfish;
  const orientations = [
    { base: 0, cover: 9, baseKind: 'rows', coverKind: 'columns' },
    { base: 9, cover: 0, baseKind: 'columns', coverKind: 'rows' },
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
        const coverLines = [...Array(9).keys()].filter((j) => cover & (1 << j));
        const elims = coverLines.flatMap((j) => g.eliminateFrom(UNITS[o.cover + j], v, pattern));
        if (!elims.length) return null;
        return step(technique, {
          eliminations: elims, cells: pattern,
          units: [...pick.map((b) => o.base + b), ...coverLines.map((j) => o.cover + j)],
          description: `In ${o.baseKind} ${and(pick.map((b) => b + 1))}, ${v} only fits in ${o.coverKind} ${and(coverLines.map((j) => j + 1))}. So ${v} can't go anywhere else in those ${o.coverKind}.`,
        });
      });
      if (found) return found;
    }
  }
  return null;
}

// A pivot {x,y} sees pincers {x,z} and {y,z}: one pincer must be z, so z
// leaves every cell that sees both pincers.
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
          eliminations: elims, cells: [pivot, a, b],
          description: `${cap(cellName(pivot))} is ${digitList(pc).replace(' and ', ' or ')}. Either way, ${cellName(a)} or ${cellName(b)} ends up as ${zv}. So ${zv} can't go in any cell that sees both of them.`,
        });
      }
    }
  }
  return null;
}

/** Finders in the order a person would try them. */
const FINDERS = [
  hiddenSingle,
  nakedSingle,
  lockedCandidates,
  (g) => nakedSubset(g, 2),
  (g) => hiddenSubset(g, 2),
  (g) => nakedSubset(g, 3),
  (g) => hiddenSubset(g, 3),
  (g) => fish(g, 2),
  xyWing,
  (g) => fish(g, 3),
];

/** The simplest deduction available on a candidate grid. */
export function nextStepOnGrid(g) {
  for (const find of FINDERS) {
    const s = find(g);
    if (s) return s;
  }
  return null;
}

/**
 * @typedef {{ solved: boolean, hardest: number, level: number, steps: Step[], board: Uint8Array }} LogicResult
 * @returns {LogicResult}
 */
export function solveLogically(board) {
  const g = Grid.from(board);
  if (!g) return { solved: false, hardest: -1, level: 0, steps: [], board: new Uint8Array(81) };
  const steps = [];
  let hardest = -1;
  while (!g.filled() && !g.broken()) {
    const s = nextStepOnGrid(g);
    if (!s) break;
    hardest = Math.max(hardest, s.technique);
    steps.push(s);
    g.apply(s);
  }
  return {
    solved: g.filled(),
    hardest,
    level: hardest < 0 ? 0 : techniqueLevel(hardest),
    steps,
    board: Uint8Array.from(g.vals),
  };
}

/**
 * Walks logic forward from `board` until the first placement, collecting the
 * elimination steps that lead to it. This is the explanation behind a hint:
 * "after this X-Wing, r4c2 becomes a naked single".
 * @returns {{ placement: Step, chain: Step[] } | null}
 */
export function nextPlacement(board, maxSteps = 40) {
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
