// Server-side verification of a finished game. The client submits its move
// log; the server replays it from the puzzle and only accepts the result if
// the replay ends on the solution and the timing is physically plausible.

import { HttpError } from './http.js';

export const MAX_MOVES = 3000;
// Faster than this per empty cell is not a human typing.
export const MIN_MS_PER_CELL = 250;

/**
 * @param {Uint8Array} puzzle
 * @param {Uint8Array} solution
 * @param {unknown} moves   [[cell, value, msSinceStart], ...]
 * @param {number} elapsed  client-reported active play time in ms
 * @param {number} wallMs   server-measured time since the session started
 * @returns {{ ok: boolean, reason?: string, plausible: boolean, moves: number }}
 */
export function verifyReplay(puzzle, solution, moves, elapsed, wallMs) {
  if (!Array.isArray(moves) || moves.length === 0) throw new HttpError(400, 'moves must be a non-empty array');
  if (moves.length > MAX_MOVES) throw new HttpError(413, 'too many moves');
  if (!Number.isInteger(elapsed) || elapsed < 0) throw new HttpError(400, 'elapsed must be a non-negative integer');

  const board = Uint8Array.from(puzzle);
  let last = 0;
  for (const m of moves) {
    if (!Array.isArray(m) || m.length !== 3 || !m.every(Number.isInteger)) {
      return { ok: false, reason: 'malformed move', plausible: false, moves: moves.length };
    }
    const [cell, value, t] = m;
    if (cell < 0 || cell > 80 || value < 0 || value > 9) return fail('move out of range');
    if (puzzle[cell]) return fail('move overwrites a given');
    if (t < last) return fail('moves are out of order');
    last = t;
    board[cell] = value;
  }
  for (let i = 0; i < 81; i++) if (board[i] !== solution[i]) return fail('replay does not solve the puzzle');
  if (last > elapsed + 1000) return fail('moves happen after the reported time');
  if (elapsed > wallMs + 5000) return fail('reported time exceeds session time');

  const empty = puzzle.reduce((n, v) => n + (v ? 0 : 1), 0);
  return { ok: true, plausible: elapsed >= empty * MIN_MS_PER_CELL, moves: moves.length };

  function fail(reason) {
    return { ok: false, reason, plausible: false, moves: moves.length };
  }
}
