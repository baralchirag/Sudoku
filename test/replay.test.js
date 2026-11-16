import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePuzzle, dailyStatus } from '../src/server/puzzles.js';
import { verifyReplay } from '../src/server/replay.js';
import { Leaderboard, MemoryStore, percentile, sanitizeName } from '../src/server/leaderboard.js';
import { solveLogically, LEVELS } from '../src/engine/logic.js';
import { hasUniqueSolution } from '../src/engine/solver.js';

const solveMoves = (p, s) => [...p].flatMap((v, i) => (v ? [] : [[i, s[i], i * 1000]]));

test('daily puzzles are deterministic, unique and keep their grade', async () => {
  for (const level of LEVELS) {
    const a = await resolvePuzzle('k', `d:2026-11-23:${level}`);
    const b = await resolvePuzzle('k', `d:2026-11-23:${level}`);
    const other = await resolvePuzzle('other-secret', `d:2026-11-23:${level}`);
    assert.deepEqual(a.puzzle, b.puzzle);
    assert.notDeepEqual(a.puzzle, other.puzzle);
    assert.ok(hasUniqueSolution(a.puzzle));
    assert.equal(LEVELS[solveLogically(a.puzzle).level], level);
  }
});

test('daily status windows', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  assert.equal(dailyStatus('2026-11-24', now, '2026-11-01'), 'live');
  assert.equal(dailyStatus('2026-11-25', now, '2026-11-01'), 'future');
  assert.equal(dailyStatus('2026-11-10', now, '2026-11-01'), 'archive');
  assert.equal(dailyStatus('2026-10-10', now, '2026-11-01'), 'prelaunch');
});

test('replay accepts a real solve and rejects cheats', async () => {
  const { puzzle, solution } = await resolvePuzzle('k', 'd:2026-11-23:easy');
  const moves = solveMoves(puzzle, solution);
  const elapsed = moves.at(-1)[2] + 500;
  assert.equal(verifyReplay(puzzle, solution, moves, elapsed, elapsed + 1000).ok, true);
  assert.equal(verifyReplay(puzzle, solution, moves.slice(1), elapsed, elapsed).ok, false);
  assert.equal(verifyReplay(puzzle, solution, moves, elapsed, 1000).ok, false);
  const fast = moves.map(([c, v]) => [c, v, 0]);
  assert.equal(verifyReplay(puzzle, solution, fast, 10, 10).plausible, false);
});

test('leaderboard ranks, dedupes nonces and computes percentiles', async () => {
  const lb = new Leaderboard(new MemoryStore());
  await lb.record('d', 'easy', { nonce: 'a', name: 'slow', ms: 600_000, hints: 0 });
  const fast = await lb.record('d', 'easy', { nonce: 'b', name: '<b>fast</b>', ms: 90_000, hints: 0 });
  assert.equal(fast.rank, 1);
  assert.equal(fast.top[0].name, 'bfastb');
  assert.equal(await lb.record('d', 'easy', { nonce: 'b', name: 'x', ms: 1, hints: 0 }), null);
  assert.equal(percentile({ total: 1, hist: [1] }, 1), 100);
  assert.equal(sanitizeName('   '), 'Anonymous');
});
