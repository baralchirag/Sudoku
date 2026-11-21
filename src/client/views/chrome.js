// Shared page chrome: the newspaper masthead and dateline.

import { h, longDate } from '../dom.js';
import { icon } from '../icons.js';
import { statsDialog, leaderboardDialog, settingsDialog } from '../dialogs.js';

export function masthead({ date, number, onSettings }) {
  return [
    h('header', { class: 'masthead' },
      h('div', { class: 'masthead__meta' }, number ? `No. ${number}` : 'Puzzles'),
      h('h1', { class: 'masthead__title' }, h('a', { href: '/' }, 'The Daily Sudoku')),
      h('div', { class: 'masthead__meta masthead__meta--end' },
        h('a', { class: 'icon-btn', href: '/archive', 'aria-label': 'Archive', title: 'Archive' }, icon('calendar')),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Leaderboard', title: 'Leaderboard', onclick: () => leaderboardDialog(date) }, icon('trophy')),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Statistics', title: 'Statistics', onclick: statsDialog }, icon('chart')),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Settings', title: 'Settings', onclick: () => settingsDialog(onSettings) }, icon('gear')),
      ),
    ),
    h('div', { class: 'dateline' },
      h('span', null, longDate(date)),
      h('span', null, 'Four puzzles · graded by technique'),
    ),
  ];
}
