// Archive: a month calendar of past dailies with per-level completion dots.

import { h, mount, $, localDate, capitalize } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { LEVELS } from '../stats.js';
import { masthead } from './chrome.js';
import { puzzleCard } from './home.js';

const LAUNCH = '2026-11-01';

export function archiveView({ month } = {}) {
  const main = $('#main');
  const today = localDate();
  const [y, m] = (month || today.slice(0, 7)).split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const label = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const results = store.results();
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const prev = ym(new Date(y, m - 2, 1));
  const next = ym(new Date(y, m, 1));
  const panel = h('div', { class: 'day-panel' });

  const cal = h('div', { class: 'cal' });
  for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) cal.append(h('div', { class: 'cal__dow' }, d));
  const offset = (first.getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) cal.append(h('div', { class: 'cal__day off' }));
  const days = new Date(y, m, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const playable = date >= LAUNCH && date <= today;
    const dots = h('span', { class: 'cal__dots', 'aria-hidden': 'true' }, LEVELS.map((l) => {
      const done = results[date]?.[l];
      const prog = !done && store.game(`d:${date}:${l}`);
      return h('i', { class: done ? 'done' : prog ? 'prog' : null });
    }));
    const solved = Object.keys(results[date] || {}).length;
    const cls = `cal__day${playable ? '' : ' off'}${date === today ? ' today' : ''}`;
    cal.append(playable
      ? h('a', { class: cls, href: `#${date}`, 'aria-label': `${date}, ${solved} of 4 solved`, onclick: (e) => { e.preventDefault(); showDay(date); } },
          h('span', { class: 'cal__num' }, d), dots)
      : h('div', { class: cls }, h('span', { class: 'cal__num' }, d)));
  }

  async function showDay(date) {
    panel.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
    try {
      const day = await api.daily(date);
      const res = store.results()[date] || {};
      panel.replaceChildren(
        h('div', { class: 'section-title' }, h('h2', null, `No. ${day.number} · ${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`)),
        h('div', { class: 'cards' }, day.levels.map((l) => puzzleCard(date, l, res[l.level]))),
      );
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      panel.replaceChildren(h('p', { class: 'empty' }, err.message));
    }
  }

  mount(main,
    masthead({ date: today, number: null }),
    h('div', { class: 'archive-head' },
      h('a', { class: 'icon-btn', href: `/archive/${prev}`, 'aria-label': 'Previous month' }, icon('left')),
      h('h2', null, capitalize(label)),
      next <= today.slice(0, 7)
        ? h('a', { class: 'icon-btn', href: `/archive/${next}`, 'aria-label': 'Next month' }, icon('right'))
        : h('span', { class: 'icon-btn' }),
    ),
    cal,
    h('p', { class: 'caption' }, 'Filled dots are solved puzzles, blue ones are in progress. Archive games are verified but only the live day is ranked.'),
    panel,
  );
}
