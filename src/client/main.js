// Browser entry: one header bar and today's puzzle. No pages, no router.

import { h, localDate } from './dom.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { LEVELS } from './stats.js';
import { applyTheme, helpDialog, statsDialog, leaderboardDialog, settingsDialog } from './dialogs.js';
import { mountGame } from './views/play.js';

applyTheme(store.settings().theme);

const date = localDate();
const btn = (name, label, onclick) =>
  h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick }, icon(name));

const game = h('main', { class: 'game' });
let level = new URLSearchParams(location.search).get('level');

document.getElementById('app').append(
  h('header', { class: 'top' },
    h('div', null, btn('help', 'How to play', helpDialog)),
    h('h1', null, 'Sudoku'),
    h('div', { class: 'top__right' },
      btn('trophy', 'Leaderboard', () => leaderboardDialog(date, level)),
      btn('chart', 'Statistics', statsDialog),
      btn('gear', 'Settings', () => settingsDialog(() => window.dispatchEvent(new Event('settings')))),
    ),
  ),
  game,
);

// Start on the requested level, else the first one not yet solved today.
if (!LEVELS.includes(level)) {
  const solved = store.results()[date] || {};
  level = LEVELS.find((l) => !solved[l]) || 'expert';
}

let unmount = () => {};
function show(next) {
  unmount();
  level = next;
  history.replaceState(null, '', next === 'easy' ? '/' : `/?level=${next}`);
  unmount = mountGame(game, { date, level, onLevel: show, settings: () => store.settings() });
}
show(level);

if (!store.settings().seenHelp) {
  store.saveSettings({ seenHelp: true });
  helpDialog();
}
