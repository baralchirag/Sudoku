// The game: level tabs, timer, board, tools, number row and explained hints.
// Autosaves locally and has the server verify the solve on completion.

import { h, mount, toast, formatTime, capitalize, shortDate } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { Game } from '../game.js';
import { BoardView } from '../board-view.js';
import { completionDialog } from '../dialogs.js';
import { LEVELS } from '../stats.js';

/**
 * Mounts today's puzzle for `level` into `root`. Returns a cleanup function.
 * @param {{ date: string, level: string, onLevel: (l: string) => void, settings: () => object }} opts
 */
export function mountGame(root, { date, level, onLevel, settings: getSettings }) {
  const key = `d:${date}:${level}`;
  let teardown = () => {};
  let alive = true;

  const tabs = () => {
    const solved = store.results()[date] || {};
    return h('div', { class: 'levels', role: 'tablist' }, LEVELS.map((l) =>
      h('button', {
        class: `level${solved[l] ? ' done' : ''}`, type: 'button', role: 'tab',
        'aria-current': String(l === level), onclick: () => l !== level && onLevel(l),
      }, capitalize(l))));
  };

  mount(root, h('div', { class: 'bar' }, tabs()), h('p', { class: 'boot' }, 'Loading…'));

  (async () => {
    const saved = store.game(key);
    let game;
    try {
      game = saved?.session ? new Game(saved.session, saved) : new Game(await api.start({ mode: 'daily', date, level }));
    } catch (err) {
      if (alive) mount(root, h('div', { class: 'bar' }, tabs()), h('p', { class: 'boot' }, err.message));
      return;
    }
    if (alive) teardown = render(game);
  })();

  function render(game) {
    let settings = getSettings();
    let notesMode = false;
    let hint = null;
    let busy = false;
    const save = () => store.saveGame(key, game.snapshot());

    const timerEl = h('span', null, formatTime(game.time()));
    const pauseBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Pause', onclick: () => togglePause() }, icon('pause'));
    const status = h('p', { class: 'status' }, shortDate(date));
    const board = new BoardView(game, settings, { onSelect: (i) => select(i) });
    const boardWrap = h('div', { class: 'board-wrap' }, board.el);
    const explain = h('div', { 'aria-live': 'polite' });

    const tool = (name, label, onclick, extra = {}) =>
      h('button', { class: 'tool', type: 'button', onclick, ...extra }, icon(name), label);
    const undoBtn = tool('undo', 'Undo', () => game.undo());
    const eraseBtn = tool('erase', 'Erase', () => board.selected >= 0 && game.erase(board.selected));
    const notesBtn = tool('pencil', 'Notes', () => setNotesMode(!notesMode), { 'aria-pressed': 'false' });
    const hintCount = h('span', { class: 'tool__count' });
    const hintBtn = tool('bulb', 'Hint', () => requestHint());
    hintBtn.append(hintCount);

    const keys = [];
    const pad = h('div', { class: 'pad' });
    for (let d = 1; d <= 9; d++) {
      const k = h('button', { class: 'key', type: 'button', 'aria-label': `Enter ${d}`, onclick: () => input(d) }, String(d));
      keys.push(k);
      pad.append(k);
    }

    mount(root,
      h('div', { class: 'bar' }, tabs(), h('div', { class: 'clock' }, timerEl, pauseBtn)),
      status,
      boardWrap,
      h('div', { class: 'tools' }, undoBtn, eraseBtn, notesBtn, hintBtn),
      pad,
      explain,
    );

    function refresh() {
      const left = game.remaining();
      keys.forEach((k, i) => {
        k.disabled = game.done || (left[i + 1] <= 0 && !notesMode);
      });
      undoBtn.disabled = game.done || !game.undoStack.length;
      eraseBtn.disabled = notesBtn.disabled = game.done;
      hintBtn.disabled = game.done || busy;
      hintCount.textContent = game.hints ? String(game.hints) : '';
    }

    function setNotesMode(on) {
      notesMode = on;
      notesBtn.setAttribute('aria-pressed', String(on));
      pad.classList.toggle('notes-mode', on);
      refresh();
    }

    function select(i) {
      if (hint) clearHint();
      board.select(i);
    }

    function input(d, asNote = notesMode) {
      const i = board.selected;
      if (game.done || i < 0 || game.isGiven(i)) return;
      if (hint) clearHint();
      const changed = asNote ? game.toggleNote(i, d) : game.setValue(i, d, { autoNotes: settings.autoNotes });
      if (changed && !asNote) board.pop(i);
    }

    // ---- hints ----

    function clearHint() {
      hint = null;
      board.clearHint();
      explain.replaceChildren();
    }

    async function requestHint() {
      if (busy || game.done) return;
      busy = true;
      refresh();
      try {
        const res = await api.hint(game.token, game.board());
        game.token = res.token;
        game.hints = res.hints;
        game.start();
        save();
        hint = res;
        board.showHint(res);
        explainHint(res);
      } catch (err) {
        toast(err.message);
      } finally {
        busy = false;
        refresh();
      }
    }

    function explainHint(res) {
      const actions = h('div', { class: 'explain__actions' });
      if (res.kind === 'mistake') {
        actions.append(h('button', { class: 'btn btn--primary', type: 'button', onclick: () => { const i = res.index; clearHint(); game.erase(i); board.select(i); } }, 'Clear it'));
      } else {
        if (res.eliminations.length) {
          actions.append(h('button', { class: 'btn', type: 'button', onclick: () => game.applyEliminations(res.eliminations) }, 'Remove notes'));
        }
        actions.append(h('button', { class: 'btn btn--primary', type: 'button', onclick: () => { const { index, value } = res; clearHint(); game.setValue(index, value, { autoNotes: settings.autoNotes }); board.select(index); board.pop(index); } }, `Place ${res.value}`));
      }
      actions.append(h('button', { class: 'btn btn--ghost', type: 'button', onclick: clearHint }, 'Close'));
      explain.replaceChildren(h('div', { class: 'explain' },
        h('h3', null, res.kind === 'mistake' ? 'Mistake' : 'Hint'),
        res.chain.length
          ? h('ol', null, res.chain.map((c) => h('li', null, c.description)), h('li', null, h('b', null, res.description)))
          : h('p', null, res.description),
        actions,
      ));
    }

    // ---- pause & clock ----

    let overlay = null;
    function togglePause(force) {
      if (game.done) return;
      const pausing = force ?? !overlay;
      if (pausing && !overlay) {
        game.pause();
        overlay = h('div', { class: 'pause' },
          h('p', null, 'Paused'),
          h('button', { class: 'btn btn--primary', type: 'button', onclick: () => togglePause(false) }, 'Resume'));
        boardWrap.append(overlay);
        pauseBtn.replaceChildren(icon('play'));
        save();
      } else if (!pausing && overlay) {
        overlay.remove();
        overlay = null;
        pauseBtn.replaceChildren(icon('pause'));
        if (game.moves.length) game.start();
      }
    }

    const tick = setInterval(() => (timerEl.textContent = formatTime(game.time())), 250);
    const autosave = setInterval(() => game.running && save(), 5000);
    const onVisibility = () => document.hidden && togglePause(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', save);

    // ---- completion ----

    function finish() {
      game.pause();
      game.done = true;
      save();
      clearHint();
      refresh();
      board.celebrate();
      setTimeout(showResult, 700);
    }

    function showResult() {
      completionDialog({
        game,
        submit: async (name) => {
          const result = await api.submit({ token: game.token, moves: game.moves, elapsed: game.time(), name });
          game.result = result;
          save();
          store.saveResult(date, level, { ms: result.ms, hints: result.hints, rank: result.rank ?? null, percentile: result.percentile ?? null });
          root.querySelector('.levels')?.replaceWith(tabs());
          return result;
        },
      });
    }

    // ---- keyboard ----

    function onKey(e) {
      if (document.querySelector('dialog[open]') || e.target.closest('input')) return;
      const k = e.key;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k.toLowerCase() === 'z') {
        e.preventDefault();
        return e.shiftKey ? game.redo() : game.undo();
      }
      if (mod && k.toLowerCase() === 'y') {
        e.preventDefault();
        return game.redo();
      }
      if (mod || e.altKey) return;
      if (k === ' ') {
        e.preventDefault();
        return togglePause();
      }
      if (overlay || game.done) return;
      const digit = /^Digit([1-9])$/.exec(e.code) || /^Numpad([1-9])$/.exec(e.code);
      if (digit) {
        e.preventDefault();
        return input(Number(digit[1]), notesMode !== e.shiftKey);
      }
      if (k === 'Backspace' || k === 'Delete') {
        e.preventDefault();
        return board.selected >= 0 && game.erase(board.selected);
      }
      if (k === 'n' || k === 'N') return setNotesMode(!notesMode);
      if (k === 'h' || k === 'H') return requestHint();
      if (k === 'Escape' && hint) return clearHint();
      const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k];
      if (step) {
        e.preventDefault();
        const cur = board.selected < 0 ? 40 : board.selected;
        const r = (Math.floor(cur / 9) + step[0] + 9) % 9;
        const c = ((cur % 9) + step[1] + 9) % 9;
        select(r * 9 + c);
      }
    }
    document.addEventListener('keydown', onKey);

    const off = game.onChange((kind, detail) => {
      if (kind === 'board') {
        board.renderCells(detail.cells);
        refresh();
        save();
      }
      if (kind === 'complete') finish();
    });

    const onSettings = () => {
      settings = getSettings();
      board.settings = settings;
      board.renderAll();
    };
    window.addEventListener('settings', onSettings);

    refresh();
    if (game.done) {
      board.renderAll();
      status.textContent = `Solved in ${formatTime(game.time())}`;
    } else {
      board.select(game.values.findIndex((v) => !v));
      if (game.moves.length) game.start();
    }

    return () => {
      save();
      off();
      clearInterval(tick);
      clearInterval(autosave);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', save);
      window.removeEventListener('settings', onSettings);
    };
  }

  return () => {
    alive = false;
    teardown();
  };
}
