import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, hmac } from '../src/server/crypto.js';
import { Router } from '../src/server/router.js';

test('signed tokens round-trip', async () => {
  const token = await signToken('s3cret', { id: 'd:2026-11-23:hard', hints: [4] });
  assert.deepEqual(await verifyToken('s3cret', token), { id: 'd:2026-11-23:hard', hints: [4] });
});

test('tampered or foreign tokens are rejected', async () => {
  const token = await signToken('s3cret', { hints: [] });
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ hints: [] , x: 1 })).toString('base64url');
  assert.equal(await verifyToken('s3cret', `${forged}.${sig}`), null);
  assert.equal(await verifyToken('other', token), null);
  assert.equal(await verifyToken('s3cret', body), null);
  assert.equal(await verifyToken('s3cret', 'garbage.!!'), null);
});

test('hmac is deterministic', async () => {
  assert.deepEqual(await hmac('k', 'm'), await hmac('k', 'm'));
});

test('router matches params and reports 405', () => {
  const r = new Router().get('/api/leaderboard/:date/:level', () => 'ok');
  const { params } = r.match('GET', '/api/leaderboard/2026-11-23/hard');
  assert.deepEqual(params, { date: '2026-11-23', level: 'hard' });
  assert.throws(() => r.match('POST', '/api/leaderboard/a/b'), { status: 405 });
  assert.throws(() => r.match('GET', '/nope'), { status: 404 });
});
