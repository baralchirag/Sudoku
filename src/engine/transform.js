// Validity-preserving Sudoku symmetries.
//
// Relabelling digits, permuting rows inside a band, permuting bands (and the
// same for columns), and transposing all map a valid puzzle to another valid
// puzzle with the same unique solution structure. Every technique in logic.js
// is symmetric under these operations, so the transformed puzzle needs exactly
// the same techniques as the original: the difficulty grade is preserved.
//
// 9! * (3!^4 * 3!^4 / ...) * 2 ~ 1.2 trillion variants per source puzzle,
// which lets a few hundred graded puzzles serve a unique-looking daily forever
// at a CPU cost of ~81 array writes.

import { shuffle } from './rng.js';

function linePermutation(rng) {
  const bands = shuffle([0, 1, 2], rng);
  const out = [];
  for (const band of bands) {
    for (const offset of shuffle([0, 1, 2], rng)) out.push(band * 3 + offset);
  }
  return out;
}

/**
 * @typedef {{ digits: number[], rows: number[], cols: number[], transpose: boolean }} Transform
 * @returns {Transform}
 */
export function randomTransform(rng) {
  const digits = [0, ...shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rng)];
  return {
    digits,
    rows: linePermutation(rng),
    cols: linePermutation(rng),
    transpose: rng() < 0.5,
  };
}

export const IDENTITY = Object.freeze({
  digits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  rows: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  cols: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  transpose: false,
});

/** Applies a transform to a board, returning a new Uint8Array. */
export function applyTransform(board, t) {
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
