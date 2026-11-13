import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoard, formatBoard, findConflicts } from '../src/engine/board.js';
import { solve, countSolutions } from '../src/engine/solver.js';
import { rngFromString } from '../src/engine/rng.js';
import { randomTransform, applyTransform, IDENTITY } from '../src/engine/transform.js';

const PUZZLE = parseBoard('530070000600195000098000060800060003400803001700020006060000280000419005000080079');
const SOLUTION = solve(PUZZLE);

test('rng is deterministic per seed', () => {
  const a = rngFromString('2026-11-23');
  const b = rngFromString('2026-11-23');
  const c = rngFromString('2026-11-24');
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  assert.notDeepEqual(xs, [c(), c(), c()]);
});

test('identity transform is a no-op', () => {
  assert.equal(formatBoard(applyTransform(PUZZLE, IDENTITY)), formatBoard(PUZZLE));
});

test('transforms preserve validity and uniqueness', () => {
  for (let i = 0; i < 50; i++) {
    const t = randomTransform(rngFromString(`seed-${i}`));
    const puzzle = applyTransform(PUZZLE, t);
    const solution = applyTransform(SOLUTION, t);
    assert.equal(findConflicts(solution).size, 0);
    assert.equal(countSolutions(puzzle), 1);
    assert.equal(formatBoard(solve(puzzle)), formatBoard(solution));
  }
});
