import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { resolvePuzzle } from '../src/server/puzzles.js';
import { parseBoard, formatBoard } from '../src/engine/board.js';

const NOW = Date.parse('2026-11-23T10:00:00Z');
let clock = NOW;
const env = { SESSION_SECRET: 'test-secret', LAUNCH_DATE: '2026-11-01' };
const app = createApp({
  assets: { html: '<!doctype html>', js: '', css: '', favicon: '', manifest: '{}', version: 'v1' },
  now: () => clock,
});

const call = async (path, body) => {
  const init = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await app.fetch(new Request(`http://x${path}`, init), env);
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

test('daily overview lists four levels without grids', async () => {
  const { status, body } = await call('/api/daily?date=2026-11-23');
  assert.equal(status, 200);
  assert.equal(body.number, 23);
  assert.equal(body.levels.length, 4);
  assert.equal(JSON.stringify(body).includes('puzzle'), false);
});

test('future dailies are locked', async () => {
  assert.equal((await call('/api/daily?date=2026-11-30')).status, 403);
  assert.equal((await call('/api/session', { mode: 'daily', level: 'hard', date: '2026-12-01' })).status, 403);
});

test('full daily flow: start, hint, submit, leaderboard', async () => {
  clock = NOW;
  const start = await call('/api/session', { mode: 'daily', level: 'medium', date: '2026-11-23' });
  assert.equal(start.status, 200);
  assert.equal(start.body.ranked, true);
  assert.equal('solution' in start.body, false);

  const { puzzle, solution } = await resolvePuzzle('test-secret', start.body.id);
  const hint = await call('/api/hint', { token: start.body.token, board: start.body.puzzle });
  assert.equal(hint.status, 200);
  assert.equal(hint.body.kind, 'placement');
  assert.equal(hint.body.value, solution[hint.body.index]);

  const wrongBoard = parseBoard(start.body.puzzle);
  const empty = wrongBoard.findIndex((v) => !v);
  wrongBoard[empty] = (solution[empty] % 9) + 1;
  const mistake = await call('/api/hint', { token: hint.body.token, board: formatBoard(wrongBoard) });
  assert.equal(mistake.body.kind, 'mistake');
  assert.equal(mistake.body.hints, 2);

  const moves = [...puzzle].flatMap((v, i) => (v ? [] : [[i, solution[i], 1000 + i * 900]]));
  const elapsed = moves.at(-1)[2] + 100;
  clock = NOW + elapsed + 2000;
  const done = await call('/api/submit', { token: mistake.body.token, moves, elapsed, name: 'Chirag' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.ranked, true);
  assert.equal(done.body.rank, 1);
  assert.equal(done.body.hints, 2);

  const again = await call('/api/submit', { token: mistake.body.token, moves, elapsed });
  assert.equal(again.body.duplicate, true);

  const board = await call('/api/leaderboard/2026-11-23/medium');
  assert.equal(board.body.top[0].name, 'Chirag');
});

test('stale hint tokens cannot drop hint penalties', async () => {
  clock = NOW;
  const start = await call('/api/session', { mode: 'daily', level: 'easy', date: '2026-11-23' });
  await call('/api/hint', { token: start.body.token, board: start.body.puzzle });
  const { puzzle, solution } = await resolvePuzzle('test-secret', start.body.id);
  const moves = [...puzzle].flatMap((v, i) => (v ? [] : [[i, solution[i], i * 1000]]));
  clock = NOW + 200_000;
  const done = await call('/api/submit', { token: start.body.token, moves, elapsed: 100_000 });
  assert.equal(done.body.hints, 1);
});

test('bad input is rejected cleanly', async () => {
  assert.equal((await call('/api/session', { mode: 'daily', level: 'nightmare' })).status, 400);
  assert.equal((await call('/api/hint', { token: 'forged.token', board: '0'.repeat(81) })).status, 401);
  const res = await app.fetch(new Request('http://x/api/session', { method: 'POST', body: 'x' }), env);
  assert.equal(res.status, 415);
  const wrongVerb = await call('/api/hint');
  assert.equal(wrongVerb.status, 405);
  assert.equal(wrongVerb.headers.get('Allow'), 'POST');
});

test('html carries CSP and security headers', async () => {
  const res = await app.fetch(new Request('http://x/daily/2026-11-23'), env);
  assert.match(res.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
});
