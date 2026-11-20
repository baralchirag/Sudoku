// Derived player statistics: streaks, solve counts and best times, computed
// from the stored daily results.

import { localDate, addDays } from './dom.js';

export const LEVELS = ['easy', 'medium', 'hard', 'expert'];

/** A day counts toward the streak when at least one daily was solved. */
export function streaks(results, today = localDate()) {
  const days = new Set(Object.keys(results).filter((d) => Object.keys(results[d]).length));
  let current = 0;
  let cursor = days.has(today) ? today : addDays(today, -1);
  while (days.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of [...days].sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best, days: days.size };
}

export function levelStats(results) {
  const out = Object.fromEntries(LEVELS.map((l) => [l, { solved: 0, best: null, total: 0, noHints: 0 }]));
  for (const day of Object.values(results)) {
    for (const [level, r] of Object.entries(day)) {
      const s = out[level];
      if (!s) continue;
      s.solved++;
      s.total += r.ms;
      if (!r.hints) s.noHints++;
      if (s.best === null || r.ms < s.best) s.best = r.ms;
    }
  }
  for (const s of Object.values(out)) s.average = s.solved ? Math.round(s.total / s.solved) : null;
  return out;
}
