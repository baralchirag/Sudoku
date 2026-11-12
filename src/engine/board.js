// Board helpers shared by the server and the browser. A board is a
// Uint8Array(81) with 0 for an empty cell and 1-9 for a digit.

import { CELLS, UNITS } from './geometry.js';

export class BoardError extends Error {}

/** Parses an 81-character string ("." or "0" for blanks). Throws BoardError. */
export function parseBoard(input) {
  if (typeof input !== 'string') throw new BoardError('board must be a string');
  const s = input.replace(/\s+/g, '');
  if (s.length !== CELLS) throw new BoardError(`board must have 81 cells, got ${s.length}`);
  const b = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 46 /* . */) continue;
    const v = ch - 48;
    if (v < 0 || v > 9) throw new BoardError(`invalid character "${s[i]}" at ${i}`);
    b[i] = v;
  }
  return b;
}

export function formatBoard(b) {
  let s = '';
  for (let i = 0; i < CELLS; i++) s += String.fromCharCode(48 + b[i]);
  return s;
}

export const countClues = (b) => b.reduce((n, v) => n + (v ? 1 : 0), 0);

/** Indices of every filled cell that duplicates a digit in one of its units. */
export function findConflicts(b) {
  const bad = new Set();
  for (const unit of UNITS) {
    const seen = new Array(10).fill(-1);
    for (const c of unit) {
      const v = b[c];
      if (!v) continue;
      if (seen[v] >= 0) {
        bad.add(c);
        bad.add(seen[v]);
      } else {
        seen[v] = c;
      }
    }
  }
  return bad;
}

export const isFilled = (b) => b.every((v) => v !== 0);

export function boardsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
