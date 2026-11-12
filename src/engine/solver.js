// Exhaustive solver: bitmask constraint propagation with a
// minimum-remaining-values heuristic. Used to verify uniqueness and to solve
// arbitrary boards; it is not what explains moves to players (see logic.js).

import { CELLS, CELL_UNITS, ALL_DIGITS, popcount, lowestDigit } from './geometry.js';

/**
 * Searches for solutions of `board`, stopping after `limit` are found.
 * @returns {{ count: number, solution: Uint8Array | null }}
 */
export function search(board, limit = 1) {
  const grid = Uint8Array.from(board);
  const used = new Uint16Array(27); // digits placed per unit
  for (let i = 0; i < CELLS; i++) {
    const v = grid[i];
    if (!v) continue;
    const bit = 1 << v;
    for (const u of CELL_UNITS[i]) {
      if (used[u] & bit) return { count: 0, solution: null }; // givens clash
      used[u] |= bit;
    }
  }

  let count = 0;
  let solution = null;

  const recurse = () => {
    // Pick the empty cell with the fewest candidates.
    let best = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < CELLS; i++) {
      if (grid[i]) continue;
      const [r, c, b] = CELL_UNITS[i];
      const mask = ALL_DIGITS & ~(used[r] | used[c] | used[b]);
      const n = popcount(mask);
      if (n === 0) return false; // dead end
      if (n < bestCount) {
        best = i;
        bestMask = mask;
        bestCount = n;
        if (n === 1) break;
      }
    }
    if (best === -1) {
      count++;
      if (!solution) solution = Uint8Array.from(grid);
      return count >= limit;
    }
    const [r, c, b] = CELL_UNITS[best];
    let mask = bestMask;
    while (mask) {
      const v = lowestDigit(mask);
      const bit = 1 << v;
      mask &= ~bit;
      grid[best] = v;
      used[r] |= bit;
      used[c] |= bit;
      used[b] |= bit;
      const stop = recurse();
      used[r] &= ~bit;
      used[c] &= ~bit;
      used[b] &= ~bit;
      grid[best] = 0;
      if (stop) return true;
    }
    return false;
  };

  recurse();
  return { count, solution };
}

/** Returns the first solution, or null when the board is unsolvable. */
export const solve = (board) => search(board, 1).solution;

/** Counts solutions up to `limit` (2 is enough to test uniqueness). */
export const countSolutions = (board, limit = 2) => search(board, limit).count;

export const hasUniqueSolution = (board) => countSolutions(board, 2) === 1;
