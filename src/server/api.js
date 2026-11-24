// API handlers. Every handler receives a context { request, params, env, now,
// secret, leaderboard } and returns plain data or a Response.

import { parseBoard, formatBoard, BoardError } from '../engine/board.js';
import { nextPlacement, LEVELS } from '../engine/logic.js';
import { cellName, CELL_UNITS } from '../engine/geometry.js';
import { signToken, verifyToken, randomId } from './crypto.js';
import { HttpError, readJson } from './http.js';
import { resolvePuzzle, dailyStatus, dailyNumber, utcDay, isLevel } from './puzzles.js';
import { verifyReplay } from './replay.js';
import { score } from './leaderboard.js';

// Best-effort memory of the most hints each session has taken, so replaying
// an older (fewer-hints) token on submit is caught within an isolate.
const hintLedger = new Map();

function requireLevel(level) {
  if (!isLevel(level)) throw new HttpError(400, `level must be one of ${LEVELS.join(', ')}`);
  return level;
}

async function openSession(ctx, body) {
  const session = await verifyToken(ctx.secret, body.token);
  if (!session) throw new HttpError(401, 'invalid or expired session');
  if (ctx.now - session.iat > 7 * 86_400_000) throw new HttpError(401, 'session expired');
  const puzzle = await resolvePuzzle(ctx.secret, session.id);
  return { session, puzzle };
}

function readBoard(value, puzzle) {
  let board;
  try {
    board = parseBoard(value);
  } catch (err) {
    if (err instanceof BoardError) throw new HttpError(400, `board: ${err.message}`);
    throw err;
  }
  for (let i = 0; i < 81; i++) {
    if (puzzle[i] && board[i] !== puzzle[i]) throw new HttpError(400, 'board does not match the puzzle givens');
  }
  return board;
}

export function health() {
  return { status: 'ok' };
}

/** Overview of a day's four puzzles; never includes the grids. */
export async function daily(ctx) {
  const url = new URL(ctx.request.url);
  const date = url.searchParams.get('date') || utcDay(ctx.now);
  const status = dailyStatus(date, ctx.now, ctx.launch);
  if (status === 'future') throw new HttpError(403, `the puzzles for ${date} are not released yet`);
  if (status === 'prelaunch') throw new HttpError(404, `no puzzles before ${ctx.launch}`);
  const levels = await Promise.all(
    LEVELS.map(async (level) => {
      const p = await resolvePuzzle(ctx.secret, `d:${date}:${level}`);
      return { level, technique: p.technique, clues: p.clues };
    }),
  );
  return { date, number: dailyNumber(date, ctx.launch), status, launch: ctx.launch, today: utcDay(ctx.now), levels };
}

/** Starts a game and returns the puzzle with a signed session token. */
export async function startSession(ctx) {
  const body = await readJson(ctx.request);
  const level = requireLevel(body.level);
  let id;
  let ranked = false;
  let date = null;
  if (body.mode === 'daily') {
    date = typeof body.date === 'string' ? body.date : utcDay(ctx.now);
    const status = dailyStatus(date, ctx.now, ctx.launch);
    if (status === 'future') throw new HttpError(403, `the puzzles for ${date} are not released yet`);
    if (status === 'prelaunch') throw new HttpError(404, `no puzzles before ${ctx.launch}`);
    ranked = status === 'live';
    id = `d:${date}:${level}`;
  } else if (body.mode === 'practice') {
    id = `p:${level}:${randomId(9)}`;
  } else {
    throw new HttpError(400, 'mode must be daily or practice');
  }
  const p = await resolvePuzzle(ctx.secret, id);
  const token = await signToken(ctx.secret, { id, iat: ctx.now, n: randomId(), h: 0 });
  return {
    token,
    id,
    mode: body.mode,
    level,
    date,
    number: date ? dailyNumber(date, ctx.launch) : null,
    ranked,
    puzzle: formatBoard(p.puzzle),
    technique: p.technique,
    clues: p.clues,
  };
}

/**
 * Explains the next move. Wrong entries are pointed out first; otherwise the
 * logic engine finds the simplest placement and the chain of eliminations
 * that unlocks it. Each hint costs a penalty, tracked inside the new token.
 */
export async function hint(ctx) {
  const body = await readJson(ctx.request);
  const { session, puzzle } = await openSession(ctx, body);
  const board = readBoard(body.board, puzzle.puzzle);
  const { solution } = puzzle;

  const hints = session.h + 1;
  hintLedger.set(session.n, Math.max(hints, hintLedger.get(session.n) ?? 0));
  if (hintLedger.size > 50_000) hintLedger.clear();
  const token = await signToken(ctx.secret, { ...session, h: hints });

  const wrong = [];
  for (let i = 0; i < 81; i++) if (board[i] && board[i] !== solution[i]) wrong.push(i);
  if (wrong.length) {
    const i = wrong[0];
    return {
      token, hints, kind: 'mistake', index: i, wrong,
      technique: 'Mistake',
      description: `The ${board[i]} at ${cellName(i)} is wrong${wrong.length > 1 ? `, and ${wrong.length - 1} other cell${wrong.length > 2 ? 's are' : ' is'} wrong too` : ''}.`,
      cells: [i], units: [], eliminations: [], chain: [],
    };
  }
  if (board.every((v) => v)) throw new HttpError(409, 'the board is already complete');

  const found = nextPlacement(board);
  if (!found) {
    const i = board.findIndex((v) => !v);
    return {
      token, hints, kind: 'reveal', index: i, value: solution[i],
      technique: 'Reveal', description: `The answer at ${cellName(i)} is ${solution[i]}.`,
      cells: [i], units: CELL_UNITS[i], eliminations: [], chain: [],
    };
  }
  const { placement, chain } = found;
  return {
    token, hints, kind: 'placement',
    index: placement.index,
    value: placement.value,
    technique: placement.name,
    description: placement.description,
    cells: placement.cells,
    units: placement.units,
    eliminations: chain.flatMap((s) => s.eliminations),
    chain: chain.map((s) => ({ technique: s.name, description: s.description, cells: s.cells, eliminations: s.eliminations })),
  };
}

/** Verifies a finished game by replay and records ranked daily results. */
export async function submit(ctx) {
  const body = await readJson(ctx.request, 64 * 1024);
  const { session, puzzle } = await openSession(ctx, body);
  const result = verifyReplay(puzzle.puzzle, puzzle.solution, body.moves, body.elapsed, ctx.now - session.iat);
  if (!result.ok) throw new HttpError(422, `submission rejected: ${result.reason}`);

  const hints = Math.max(session.h, hintLedger.get(session.n) ?? 0);
  const out = {
    verified: true,
    plausible: result.plausible,
    ms: body.elapsed,
    hints,
    score: score(body.elapsed, hints),
    ranked: false,
  };

  const [kind, date, level] = session.id.split(':');
  if (kind !== 'd') return out;
  const live = dailyStatus(date, ctx.now, ctx.launch) === 'live';
  if (live && result.plausible) {
    const standing = await ctx.leaderboard.record(date, level, {
      nonce: session.n, name: body.name, ms: body.elapsed, hints,
    });
    if (standing) return { ...out, ranked: true, ...standing };
    return { ...out, duplicate: true, ...(await ctx.leaderboard.view(date, level)) };
  }
  return { ...out, ...(await ctx.leaderboard.view(date, level)) };
}

export async function leaderboard(ctx) {
  const { date, level } = ctx.params;
  requireLevel(level);
  const status = dailyStatus(date, ctx.now, ctx.launch);
  if (status === 'future' || status === 'prelaunch') throw new HttpError(404, 'no leaderboard for that date');
  return { date, level, ...(await ctx.leaderboard.view(date, level)) };
}
