// Modal dialogs built on the native <dialog> element (focus trapping, Esc
// to close and the backdrop come for free).

import { h, formatTime, capitalize, toast } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { store } from './store.js';
import { streaks, levelStats, LEVELS } from './stats.js';
import { shareText, share } from './share.js';

export function openDialog(title, body, foot = null, { onClose } = {}) {
  const dlg = h(
    'dialog',
    { 'aria-label': title },
    h('div', { class: 'dlg__head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close')),
    ),
    h('div', { class: 'dlg__body' }, body),
    foot && h('div', { class: 'dlg__foot' }, foot),
  );
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close(); // backdrop click
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.();
  });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// ---- charts & tables ----

const bucketLabel = (s) => (s < 60 ? `${s}s` : `${s / 60}m`);

/** Solve-time distribution as an SVG bar chart, your bucket in accent. */
export function histogram({ buckets, hist }, ms) {
  const W = 460;
  const H = 120;
  const n = hist.length;
  const bw = W / n;
  const max = Math.max(1, ...hist);
  const you = ms == null ? -1 : (() => {
    const i = buckets.findIndex((b) => ms / 1000 < b);
    return i === -1 ? buckets.length : i;
  })();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 18}`);
  svg.setAttribute('class', 'hist');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Distribution of solve times today');
  hist.forEach((count, i) => {
    const bh = count ? Math.max(3, (count / max) * H) : 1;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(i * bw + 2));
    rect.setAttribute('y', String(H - bh));
    rect.setAttribute('width', String(bw - 4));
    rect.setAttribute('height', String(bh));
    if (i === you) rect.setAttribute('class', 'you');
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${count} solver${count === 1 ? '' : 's'}`;
    rect.append(title);
    svg.append(rect);
    if (i % 2 === 0 || n < 8) {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', String(i * bw + bw / 2));
      t.setAttribute('y', String(H + 14));
      t.setAttribute('text-anchor', 'middle');
      t.textContent = i < buckets.length ? `<${bucketLabel(buckets[i])}` : `${bucketLabel(buckets.at(-1))}+`;
      svg.append(t);
    }
  });
  return svg;
}

export function leaderboardTable(top, meName) {
  if (!top?.length) return h('p', { class: 'empty' }, 'No verified solves yet. Be the first.');
  return h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Name'), h('th', { class: 'num' }, 'Hints'), h('th', { class: 'num' }, 'Time'))),
    h('tbody', null, top.map((e, i) =>
      h('tr', { class: meName && e.name === meName ? 'me' : null },
        h('td', null, i + 1),
        h('td', null, e.name),
        h('td', { class: 'num' }, e.hints || '–'),
        h('td', { class: 'num' }, formatTime(e.ms)),
      ))),
  );
}

// ---- completion ----

const fill = (el, ...children) => el.replaceChildren(...children.filter(Boolean));

/**
 * Shown when a board is solved. For ranked dailies without a saved name it
 * asks for one before submitting; afterwards it shows rank, percentile and the
 * day's distribution.
 */
export function completionDialog({ game, submit, onClose }) {
  const s = game.session;
  const settings = store.settings();
  const body = h('div');
  const foot = h('div', { class: 'dlg__foot' });
  const dlg = openDialog(`Solved · No. ${s.number}`, body, null, { onClose });
  dlg.append(foot);

  const header = h('div', { class: 'result' },
    h('span', { class: 'result__time' }, formatTime(game.time())),
    h('span', { class: 'result__sub' },
      `${capitalize(s.level)} · ${game.hints ? `${game.hints} hint${game.hints > 1 ? 's' : ''} (+${game.hints * 30}s)` : 'no hints'}`),
  );

  const showResult = (r) => {
    const results = store.results();
    const streak = streaks(results).current;
    const facts = h('div', { class: 'facts' },
      h('div', null, h('b', null, r.rank ? `#${r.rank}` : '–'), h('span', null, 'Rank')),
      h('div', null, h('b', null, r.percentile != null ? `${r.percentile}%` : '–'), h('span', null, 'Faster than')),
      h('div', null, h('b', null, r.total ?? '–'), h('span', null, 'Solvers')),
    );
    const notes = [];
    if (s.mode === 'daily' && !s.ranked) notes.push('Past puzzles are verified but not ranked.');
    if (r.verified && !r.plausible) notes.push('That was faster than our human limit, so it was not ranked.');
    if (r.duplicate) notes.push('This game was already on the board.');

    fill(body,
      header,
      s.mode === 'daily' ? facts : null,
      r.total ? histogram(r, r.ms) : null,
      r.total ? h('p', { class: 'caption' }, 'Solve times today across all verified players. Yours is highlighted.') : null,
      notes.length ? h('p', { class: 'caption' }, notes.join(' ')) : null,
      r.top ? leaderboardTable(r.top, settings.name || 'Anonymous') : null,
    );
    fill(foot,
      s.mode === 'daily'
        ? h('button', {
            class: 'btn btn--accent', type: 'button',
            onclick: async () => {
              const text = shareText({ number: s.number, level: s.level, ms: r.ms, hints: r.hints, percentile: r.percentile, rank: r.rank, streak });
              const how = await share(text);
              toast(how === 'copied' ? 'Result copied to clipboard' : how === 'shared' ? 'Shared' : 'Could not share');
            },
          }, icon('share'), 'Share')
        : null,
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Close'),
    );
    foot.after(nextPuzzle());
  };

  const run = async (name) => {
    body.replaceChildren(header, h('p', { class: 'empty' }, 'Verifying your solve on the server…'));
    foot.replaceChildren();
    try {
      showResult(await submit(name));
    } catch (err) {
      body.replaceChildren(header, h('p', { class: 'caption' }, `Could not verify: ${err.message}`));
      foot.replaceChildren(h('button', { class: 'btn btn--primary', type: 'button', onclick: () => run(name) }, 'Try again'));
    }
  };

  if (game.result) {
    showResult(game.result);
  } else if (s.ranked && !settings.name) {
    const input = h('input', { class: 'input', id: 'name', maxlength: '20', autocomplete: 'nickname', placeholder: 'Anonymous' });
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const name = input.value.trim();
        store.saveSettings({ name });
        run(name);
      },
    },
      h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name on today\'s leaderboard'), input),
      h('button', { class: 'btn btn--accent', type: 'submit' }, 'Submit result'),
    );
    body.replaceChildren(header, form);
    setTimeout(() => input.focus(), 50);
  } else {
    run(settings.name);
  }
  return dlg;
}

// ---- leaderboard ----

export function leaderboardDialog(date, initialLevel = 'easy') {
  const content = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const select = async (level) => {
    for (const t of tabs.children) t.setAttribute('aria-selected', String(t.dataset.level === level));
    content.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
    try {
      const lb = await api.leaderboard(date, level);
      content.replaceChildren(
        lb.total ? histogram(lb, null) : null,
        lb.total ? h('p', { class: 'caption' }, `${lb.total} verified solver${lb.total === 1 ? '' : 's'} today.`) : null,
        leaderboardTable(lb.top, store.settings().name),
      );
    } catch (err) {
      content.replaceChildren(h('p', { class: 'empty' }, err.message));
    }
  };
  for (const level of LEVELS) {
    tabs.append(h('button', { class: 'tab', role: 'tab', type: 'button', dataset: { level }, onclick: () => select(level) }, capitalize(level)));
  }
  openDialog('Leaderboard', [tabs, content]);
  select(initialLevel);
}

// ---- statistics ----

export function statsDialog() {
  const results = store.results();
  const st = streaks(results);
  const per = levelStats(results);
  openDialog('Statistics', [
    h('div', { class: 'facts' },
      h('div', null, h('b', null, st.days), h('span', null, 'Days played')),
      h('div', null, h('b', null, st.current), h('span', null, 'Streak')),
      h('div', null, h('b', null, st.best), h('span', null, 'Best streak')),
    ),
    h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Level'), h('th', { class: 'num' }, 'Solved'), h('th', { class: 'num' }, 'Best'), h('th', { class: 'num' }, 'Average'))),
      h('tbody', null, LEVELS.map((l, i) => {
        const s = per[l];
        return h('tr', null,
          h('td', null, i + 1),
          h('td', null, capitalize(l)),
          h('td', { class: 'num' }, s.solved),
          h('td', { class: 'num' }, s.best != null ? formatTime(s.best) : '–'),
          h('td', { class: 'num' }, s.average != null ? formatTime(s.average) : '–'),
        );
      })),
    ),
    nextPuzzle(),
  ]);
}

// ---- next puzzle countdown ----

/** Live countdown to local midnight, when the next set of puzzles unlocks. */
export function nextPuzzle() {
  const value = h('b');
  const el = h('div', { class: 'result' }, h('span', { class: 'sub' }, 'Next puzzles in'), h('span', { class: 'result__time' }, value));
  const update = () => {
    if (!el.isConnected && el.dataset.started) return clearInterval(timer);
    el.dataset.started = '1';
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const left = Math.max(0, Math.floor((midnight - now) / 1000));
    value.textContent = [left / 3600, (left % 3600) / 60, left % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
  };
  const timer = setInterval(update, 1000);
  update();
  return el;
}

// ---- help ----

export function helpDialog() {
  openDialog('How to play', h('div', { class: 'help' },
    h('p', null, 'Fill the grid so every row, column and 3×3 box contains the digits 1 to 9 exactly once.'),
    h('ul', null,
      h('li', null, 'There are four new puzzles every day, from Easy to Expert. Everyone gets the same ones.'),
      h('li', null, 'Every puzzle can be solved by logic alone. The label tells you the hardest technique it needs.'),
      h('li', null, 'A hint explains the next logical step instead of just giving the answer. Each hint adds 30 seconds.'),
      h('li', null, 'When you finish, the server replays your moves to verify the solve before it goes on the leaderboard.'),
    ),
    h('p', null, 'Keys: 1–9 to place, Shift+digit or N for notes, arrows to move, Backspace to erase, H for a hint, Space to pause, Ctrl+Z to undo.'),
  ));
}

// ---- settings ----

export function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

export function settingsDialog(onChange) {
  const s = store.settings();
  const update = (patch) => {
    const next = store.saveSettings(patch);
    applyTheme(next.theme);
    onChange?.(next);
  };
  const themeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' });
  for (const t of ['auto', 'light', 'dark']) {
    themeSeg.append(h('button', {
      type: 'button', 'aria-pressed': String(s.theme === t),
      onclick: (e) => {
        for (const b of themeSeg.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        update({ theme: t });
      },
    }, capitalize(t)));
  }
  const toggle = (key, label) => {
    const input = h('input', { type: 'checkbox', id: `opt-${key}`, onchange: (e) => update({ [key]: e.target.checked }) });
    input.checked = s[key];
    return h('label', { class: 'toggle', for: `opt-${key}` }, label, input);
  };
  const name = h('input', { class: 'input', id: 'opt-name', maxlength: '20', value: s.name, placeholder: 'Anonymous', onchange: (e) => update({ name: e.target.value.trim() }) });
  openDialog('Settings', [
    h('div', { class: 'field' }, h('label', { for: 'opt-name' }, 'Leaderboard name'), name),
    h('div', { class: 'field' }, h('label', null, 'Theme'), themeSeg),
    toggle('highlightPeers', 'Highlight row, column and box'),
    toggle('highlightSame', 'Highlight matching digits'),
    toggle('showConflicts', 'Mark rule conflicts'),
    toggle('autoNotes', 'Remove notes when placing a digit'),
  ]);
}
