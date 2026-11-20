// Game state: values, pencil notes, undo/redo, the move log the server
// replays, and an active-time clock that only runs while the game is visible.
// The browser never knows the solution; it only checks Sudoku rules locally
// using the same engine code the server runs.

import { parseBoard, formatBoard, findConflicts } from '../engine/board.js';
import { PEERS } from '../engine/geometry.js';

export class Game {
  /** @param {object} session  response of POST /api/session (or a saved game) */
  constructor(session, saved = null) {
    this.session = session;
    this.puzzle = parseBoard(session.puzzle);
    this.values = saved ? parseBoard(saved.values) : Uint8Array.from(this.puzzle);
    this.notes = saved ? Uint16Array.from(saved.notes) : new Uint16Array(81);
    this.moves = saved ? saved.moves : [];
    this.elapsed = saved ? saved.elapsed : 0;
    this.hints = saved ? saved.hints : 0;
    this.token = saved ? saved.token : session.token;
    this.done = saved ? saved.done : false;
    this.result = saved ? saved.result : null;
    this.undoStack = [];
    this.redoStack = [];
    this.runningSince = null;
    this.listeners = new Set();
    this.refreshConflicts();
  }

  // ---- events ----

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind, detail) {
    for (const fn of this.listeners) fn(kind, detail);
  }

  // ---- clock ----

  start() {
    if (this.done || this.runningSince !== null) return;
    this.runningSince = performance.now();
    this.emit('clock');
  }

  pause() {
    if (this.runningSince === null) return;
    this.elapsed += Math.round(performance.now() - this.runningSince);
    this.runningSince = null;
    this.emit('clock');
  }

  get running() {
    return this.runningSince !== null;
  }

  time() {
    return this.elapsed + (this.runningSince === null ? 0 : Math.round(performance.now() - this.runningSince));
  }

  // ---- queries ----

  isGiven(i) {
    return this.puzzle[i] !== 0;
  }

  refreshConflicts() {
    this.conflicts = findConflicts(this.values);
  }

  /** How many of each digit are still missing (index 1..9). */
  remaining() {
    const left = new Array(10).fill(9);
    for (const v of this.values) if (v) left[v]--;
    return left;
  }

  get complete() {
    return this.values.every((v) => v !== 0) && this.conflicts.size === 0;
  }

  board() {
    return formatBoard(this.values);
  }

  // ---- edits ----

  /** Applies a list of cell changes as one undoable action. */
  commit(changes, { record = true } = {}) {
    if (!changes.length) return;
    for (const c of changes) {
      if (c.v1 !== this.values[c.i]) this.log(c.i, c.v1);
      this.values[c.i] = c.v1;
      this.notes[c.i] = c.n1;
    }
    if (record) {
      this.undoStack.push(changes);
      if (this.undoStack.length > 500) this.undoStack.shift();
      this.redoStack = [];
    }
    this.refreshConflicts();
    this.emit('board', { cells: changes.map((c) => c.i) });
    if (this.complete) this.emit('complete');
  }

  log(cell, value) {
    this.start();
    this.moves.push([cell, value, this.time()]);
  }

  change(i, v1, n1) {
    return { i, v0: this.values[i], n0: this.notes[i], v1, n1 };
  }

  /** Places (or toggles off) a digit. Auto-clears that note from peers. */
  setValue(i, v, { autoNotes = true } = {}) {
    if (this.done || this.isGiven(i)) return false;
    const next = this.values[i] === v ? 0 : v;
    const changes = [this.change(i, next, 0)];
    if (next && autoNotes) {
      const bit = 1 << next;
      for (const p of PEERS[i]) {
        if (!this.values[p] && this.notes[p] & bit) changes.push(this.change(p, 0, this.notes[p] & ~bit));
      }
    }
    this.commit(changes);
    return true;
  }

  toggleNote(i, v) {
    if (this.done || this.isGiven(i) || this.values[i]) return false;
    this.commit([this.change(i, 0, this.notes[i] ^ (1 << v))]);
    return true;
  }

  erase(i) {
    if (this.done || this.isGiven(i) || (!this.values[i] && !this.notes[i])) return false;
    this.commit([this.change(i, 0, 0)]);
    return true;
  }

  /** Fills every empty cell with all candidates that don't break the rules. */
  fillNotes() {
    if (this.done) return;
    const changes = [];
    for (let i = 0; i < 81; i++) {
      if (this.values[i]) continue;
      let mask = 0x3fe;
      for (const p of PEERS[i]) if (this.values[p]) mask &= ~(1 << this.values[p]);
      if (mask !== this.notes[i]) changes.push(this.change(i, 0, mask));
    }
    this.commit(changes);
  }

  /** Removes the struck-through candidates of a hint explanation. */
  applyEliminations(elims) {
    const changes = [];
    const masks = new Map();
    for (const [c, v] of elims) {
      if (this.values[c]) continue;
      masks.set(c, (masks.get(c) ?? this.notes[c]) & ~(1 << v));
    }
    for (const [c, mask] of masks) if (mask !== this.notes[c]) changes.push(this.change(c, 0, mask));
    this.commit(changes);
  }

  undo() {
    const changes = this.undoStack.pop();
    if (!changes || this.done) return false;
    this.redoStack.push(changes);
    this.commit(changes.map((c) => ({ i: c.i, v0: c.v1, n0: c.n1, v1: c.v0, n1: c.n0 })).reverse(), { record: false });
    return true;
  }

  redo() {
    const changes = this.redoStack.pop();
    if (!changes || this.done) return false;
    this.undoStack.push(changes);
    this.commit(changes, { record: false });
    return true;
  }

  // ---- persistence ----

  snapshot() {
    return {
      session: this.session,
      values: this.board(),
      notes: [...this.notes],
      moves: this.moves,
      elapsed: this.time(),
      hints: this.hints,
      token: this.token,
      done: this.done,
      result: this.result,
      savedAt: Date.now(),
    };
  }
}
