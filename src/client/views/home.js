// Front page: today's four puzzles, streak, the difficulty ladder and
// practice mode.

import { h, mount, $, localDate, formatTime, capitalize } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { streaks, LEVELS } from '../stats.js';
import { masthead } from './chrome.js';

const LADDER = [
  ['Easy', 'Hidden singles: a digit has only one home in a box, row or column.'],
  ['Medium', 'Naked singles: a cell sees eight digits, so the ninth is forced.'],
  ['Hard', 'Locked candidates, naked and hidden pairs and triples.'],
  ['Expert', 'X-Wing, XY-Wing and Swordfish patterns across the grid.'],
];

export function miniBoard(saved) {
  const grid = h('div', { class: 'card__mini', 'aria-hidden': 'true' });
  const puzzle = saved.session.puzzle;
  for (let i = 0; i < 81; i++) {
    const given = puzzle[i] !== '0';
    const filled = saved.values[i] !== '0';
    grid.append(h('i', { class: given ? 'f' : filled ? 'p' : null }));
  }
  return grid;
}

export function puzzleCard(date, { level, technique, clues }, result) {
  const saved = store.game(`d:${date}:${level}`);
  const idx = LEVELS.indexOf(level);
  let status;
  if (result) status = h('span', { class: 'badge badge--done' }, `Solved ${formatTime(result.ms)}`);
  else if (saved) status = h('span', { class: 'badge badge--progress' }, `In progress ${formatTime(saved.elapsed)}`);
  else status = h('span', { class: 'badge' }, 'Not started');
  return h('a', { class: 'card', href: `/play/${date}/${level}`, 'aria-label': `${capitalize(level)} puzzle, ${result ? 'solved' : saved ? 'in progress' : 'not started'}` },
    h('div', { class: 'card__pips', 'aria-hidden': 'true' }, LEVELS.map((_, i) => h('span', { class: i <= idx ? 'on' : null }))),
    h('h3', { class: 'card__level' }, capitalize(level)),
    h('p', { class: 'card__meta' }, 'Needs ', h('strong', null, technique)),
    h('p', { class: 'card__meta' }, `${clues} clues`),
    saved ? miniBoard(saved) : h('div', { class: 'card__mini', 'aria-hidden': 'true' }),
    h('div', { class: 'card__status' }, status),
  );
}

export function homeView() {
  const main = $('#main');
  let alive = true;
  const today = localDate();

  const render = (day) => {
    if (!alive) return;
    const results = store.results()[day.date] || {};
    const st = streaks(store.results());
    const solved = Object.keys(results).length;
    mount(main,
      masthead({ date: day.date, number: day.number, onSettings: () => render(day) }),
      h('section', { class: 'lede' },
        h('div', null,
          h('p', { class: 'lede__kicker' }, solved === 4 ? 'All four solved' : solved ? `${solved} of 4 solved` : "Today's puzzles"),
          h('h2', { class: 'lede__headline' }, solved === 4 ? 'A clean sweep. Come back tomorrow.' : 'Four grids, one day, no guessing required.'),
          h('p', { class: 'lede__body' },
            'Every puzzle is graded by the hardest technique it needs and can be solved by pure logic. Stuck? Hints explain the next deduction instead of just giving it away. Finished times are replayed and verified on the server before they reach the leaderboard.'),
        ),
        h('div', { class: 'streak' },
          h('div', { class: 'streak__cell' }, h('span', { class: 'streak__value' }, st.current), h('span', { class: 'streak__label' }, 'Day streak')),
          h('div', { class: 'streak__cell' }, h('span', { class: 'streak__value' }, st.best), h('span', { class: 'streak__label' }, 'Best')),
          h('div', { class: 'streak__cell' }, h('span', { class: 'streak__value' }, `${solved}/4`), h('span', { class: 'streak__label' }, 'Today')),
        ),
      ),
      h('div', { class: 'section-title' }, h('h2', null, 'Today'), h('a', { href: '/archive' }, 'Past puzzles')),
      h('div', { class: 'cards' }, day.levels.map((l) => puzzleCard(day.date, l, results[l.level]))),
      h('div', { class: 'columns' },
        h('section', null,
          h('div', { class: 'section-title' }, h('h2', null, 'How difficulty works')),
          h('ol', { class: 'ladder' }, LADDER.map(([name, text]) => h('li', null, h('b', null, name), h('span', null, text)))),
        ),
        h('section', null,
          h('div', { class: 'section-title' }, h('h2', null, 'Practice')),
          h('p', { class: 'lede__body' }, 'Unlimited unranked puzzles at any level, drawn from the same graded bank with a fresh symmetry each time.'),
          h('p', null),
          h('div', { class: 'practice' }, LEVELS.map((l) => h('a', { class: 'btn', href: `/practice/${l}` }, capitalize(l)))),
        ),
      ),
      h('footer', { class: 'footer' },
        h('span', null, 'Built with a Go grading engine and a single-file Cloudflare Worker.'),
        h('span', null, 'Keyboard: 1–9, arrows, N for notes, H for hints'),
      ),
    );
  };

  api.daily(today)
    .catch(() => api.daily(new Date().toISOString().slice(0, 10)))
    .then(render)
    .catch((err) => mount(main, h('p', { class: 'boot' }, err.message)));

  return () => {
    alive = false;
  };
}
