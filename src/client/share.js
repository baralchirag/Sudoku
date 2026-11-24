// Spoiler-free share text for a finished daily.

import { formatTime, capitalize, shortDate } from './dom.js';

export function shareText({ date, level, ms, hints, percentile, rank, streak }) {
  const lines = [`Sudoku · ${shortDate(date)} · ${capitalize(level)}`];
  const parts = [formatTime(ms), hints ? `${hints} hint${hints > 1 ? 's' : ''}` : 'no hints'];
  if (rank) parts.push(`#${rank} today`);
  else if (percentile != null) parts.push(`faster than ${percentile}%`);
  lines.push(parts.join(' · '));
  if (streak > 1) lines.push(`${streak}-day streak`);
  lines.push(location.origin);
  return lines.join('\n');
}

export async function share(text) {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch {
      /* fall back to the clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
