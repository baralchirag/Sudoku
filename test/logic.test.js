import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBoard } from '../src/engine/board.js';
import { solve } from '../src/engine/solver.js';
import { solveLogically, nextPlacement, TECHNIQUE_NAMES, LEVELS } from '../src/engine/logic.js';

// The Go engine graded this pool offline; the JS port must agree with it.
const pool = JSON.parse(readFileSync(new URL('../engine-go/data/puzzles.json', import.meta.url)))
  .filter((r) => r.technique);

test('grades match the Go engine on the whole pool', () => {
  for (const rec of pool) {
    const res = solveLogically(parseBoard(rec.puzzle));
    assert.ok(res.solved, `logic should solve ${rec.puzzle}`);
    assert.equal(TECHNIQUE_NAMES[res.hardest], rec.technique, rec.puzzle);
    assert.equal(LEVELS[res.level], rec.difficulty, rec.puzzle);
  }
});

test('every deduction is sound against the true solution', () => {
  for (const rec of pool.filter((_, i) => i % 7 === 0)) {
    const puzzle = parseBoard(rec.puzzle);
    const solution = solve(puzzle);
    for (const s of solveLogically(puzzle).steps) {
      if (s.index >= 0) assert.equal(s.value, solution[s.index], s.description);
      for (const [c, v] of s.eliminations) {
        assert.notEqual(solution[c], v, `${s.name} wrongly removed ${v} from ${c}`);
      }
    }
  }
});

test('nextPlacement explains the first placement of an expert puzzle', () => {
  const rec = pool.find((r) => r.difficulty === 'expert');
  const puzzle = parseBoard(rec.puzzle);
  const solution = solve(puzzle);
  const hint = nextPlacement(puzzle);
  assert.ok(hint);
  assert.equal(hint.placement.value, solution[hint.placement.index]);
  assert.ok(hint.placement.description.length > 10);
});
