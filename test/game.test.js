import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/client/game.js';
import { streaks } from '../src/client/stats.js';

const PUZZLE = '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const session = { puzzle: PUZZLE, token: 't', level: 'easy', mode: 'practice' };

test('placing, toggling and conflicts', () => {
  const g = new Game(session);
  assert.equal(g.setValue(0, 1), false, 'givens are locked');
  g.setValue(2, 5); // duplicates the 5 in r1c1
  assert.ok(g.conflicts.has(2));
  g.setValue(2, 5); // same digit again clears it
  assert.equal(g.values[2], 0);
  assert.equal(g.conflicts.size, 0);
});

test('notes are removed from peers when a digit is placed', () => {
  const g = new Game(session);
  g.toggleNote(3, 6);
  g.toggleNote(2, 6);
  g.setValue(2, 4);
  assert.equal(g.notes[3] & (1 << 6), 1 << 6, 'unrelated digit kept');
  g.toggleNote(3, 4);
  g.setValue(2, 0);
  g.setValue(2, 4);
  assert.equal(g.notes[3] & (1 << 4), 0, 'peer note cleared');
});

test('undo and redo restore values and notes, and every change is logged', () => {
  const g = new Game(session);
  g.toggleNote(2, 4);
  g.setValue(2, 4);
  g.undo();
  assert.equal(g.values[2], 0);
  assert.equal(g.notes[2], 1 << 4);
  g.redo();
  assert.equal(g.values[2], 4);
  assert.deepEqual(g.moves.map(([c, v]) => [c, v]), [[2, 4], [2, 0], [2, 4]]);
});

test('fillNotes only offers legal candidates', () => {
  const g = new Game(session);
  g.fillNotes();
  assert.equal(g.notes[2], (1 << 1) | (1 << 2) | (1 << 4));
});

test('snapshot round-trips', () => {
  const g = new Game(session);
  g.setValue(2, 4);
  const restored = new Game(session, JSON.parse(JSON.stringify(g.snapshot())));
  assert.equal(restored.board(), g.board());
  assert.deepEqual(restored.moves, g.moves);
});

test('streaks count consecutive days', () => {
  const r = { '2026-11-20': { easy: {} }, '2026-11-21': { hard: {} }, '2026-11-22': { easy: {} }, '2026-11-18': { easy: {} } };
  assert.deepEqual(streaks(r, '2026-11-23'), { current: 3, best: 3, days: 4 });
  assert.equal(streaks(r, '2026-11-25').current, 0);
});
