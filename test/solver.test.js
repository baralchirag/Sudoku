import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoard, formatBoard, findConflicts } from '../src/engine/board.js';
import { solve, countSolutions } from '../src/engine/solver.js';

const PUZZLE = '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const SOLUTION = '534678912672195348198342567859761423426853791713924856961537284287419635345286179';

test('solves a classic puzzle', () => {
  assert.equal(formatBoard(solve(parseBoard(PUZZLE))), SOLUTION);
});

test('detects a unique solution', () => {
  assert.equal(countSolutions(parseBoard(PUZZLE)), 1);
});

test('detects multiple solutions on a sparse board', () => {
  assert.equal(countSolutions(parseBoard('0'.repeat(81))), 2);
});

test('rejects clashing givens', () => {
  const b = parseBoard('55' + '0'.repeat(79));
  assert.equal(solve(b), null);
  assert.deepEqual([...findConflicts(b)].sort(), [0, 1]);
});

test('parse accepts dots and rejects bad input', () => {
  assert.equal(formatBoard(parseBoard('.'.repeat(81))), '0'.repeat(81));
  assert.throws(() => parseBoard('123'));
  assert.throws(() => parseBoard('x'.repeat(81)));
});
