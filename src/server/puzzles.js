// Deterministic puzzle derivation. A puzzle id fully describes a puzzle:
//   d:<date>:<level>     daily challenge, same for everyone that day
//   p:<level>:<seed>     practice puzzle
// The id is HMAC'd with the server secret to pick a bank entry and a random
// symmetry, so the daily is unpredictable without the secret, costs ~0 CPU,
// and never needs to be stored.

import { BANK, TECHNIQUES } from '../data/bank.js';
import { parseBoard, countClues } from '../engine/board.js';
import { rngFromBytes, randInt } from '../engine/rng.js';
import { randomTransform, applyTransform } from '../engine/transform.js';
import { LEVELS } from '../engine/logic.js';
import { hmac } from './crypto.js';
import { HttpError } from './http.js';

const DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isLevel = (l) => LEVELS.includes(l);

export function parseDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) throw new HttpError(400, 'invalid date');
  return t;
}

export const utcDay = (now) => new Date(Math.floor(now / DAY) * DAY).toISOString().slice(0, 10);

/**
 * Classifies a daily date against the current time. Players live in every
 * timezone, so "today" spans yesterday..tomorrow in UTC. Earlier dates are
 * the archive (playable, unranked); later ones are not released yet.
 */
export function dailyStatus(date, now, launch) {
  const t = parseDate(date);
  const today = Math.floor(now / DAY) * DAY;
  const offset = Math.round((t - today) / DAY);
  if (offset > 1) return 'future';
  if (t < parseDate(launch)) return 'prelaunch';
  return offset >= -1 ? 'live' : 'archive';
}

export const dailyNumber = (date, launch) => Math.round((parseDate(date) - parseDate(launch)) / DAY) + 1;

/** Resolves a puzzle id into boards and metadata. */
export async function resolvePuzzle(secret, id) {
  const parts = String(id).split(':');
  let level;
  if (parts[0] === 'd' && parts.length === 3) {
    parseDate(parts[1]);
    level = parts[2];
  } else if (parts[0] === 'p' && parts.length === 3 && /^[A-Za-z0-9_-]{4,32}$/.test(parts[2])) {
    level = parts[1];
  } else {
    throw new HttpError(400, 'invalid puzzle id');
  }
  if (!isLevel(level)) throw new HttpError(400, 'invalid level');

  const rng = rngFromBytes(await hmac(secret, `puzzle:v1:${id}`));
  const entries = BANK[level];
  const entry = entries[randInt(rng, entries.length)];
  const transform = randomTransform(rng);
  const puzzle = applyTransform(parseBoard(entry.slice(0, 81)), transform);
  const solution = applyTransform(parseBoard(entry.slice(81, 162)), transform);
  return {
    id,
    level,
    puzzle,
    solution,
    technique: TECHNIQUES[Number(entry.slice(162))],
    clues: countClues(puzzle),
  };
}
