// The game screen: board, number pad, tools, explained hints, timer, pause,
// keyboard control, autosave and server verification on completion.

import { h, mount, $, toast, formatTime, capitalize } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { Game } from '../game.js';
import { BoardView } from '../board-view.js';
import { completionDialog, settingsDialog } from '../dialogs.js';
import { navigate } from '../router.js';
import { LEVELS } from '../stats.js';

const storageKey = (mode, date, level) => (mode === 'daily' ? `d:${date}:${level}` : `practice:${level}`);

export function playView({ date, level }, mode = 'daily') {
  const main = $('#main');
  if (!LEVELS.includes(level)) return navigate('/', { replace: true });
  const key = storageKey(mode, date, level);
  let teardown = () => {};
  let alive = true;

  mount(main, h('p', { class: 'boot' }, 'Setting the type…'));

  (async () => {
    let saved = store.game(key);
    if (saved && mode === 'practice' && saved.done) saved = null;
    let game;
    try {
      game = saved?.session
        ? new Game(saved.session, saved)
        : new Game(await api.start(mode === 'daily' ? { mode, date, level } : { mode, level }));
    } catch (err) {
      if (alive) mount(main, h('p', { class: 'boot' }, err.message, h('br'), h('a', { class: 'link', href: '/' }, 'Back to today')));
      return;
    }
    if (alive) teardown = renderGame(game, key, mode);
  })();

  return () => {
    alive = false;
    teardown();
  };
}

function renderGame(game, key, mode) {
  const main = $('#main');
  const s = game.session;
  let settings = store.settings();
  let notesMode = false;
  let hint = null;
  let busy = false;

  const save = () => store.saveGame(key, game.snapshot());

  // ---- elements ----

  const timerEl = h('span', { class: 'timer', 'aria-live': 'off' }, formatTime(game.time()));
  const pauseBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Pause', onclick: () => togglePause() }, icon('pause'));
  const board = new BoardView(game, settings, { onSelect: (i) => select(i) });
  const boardWrap = h('div', { class: 'board-wrap' }, board.el);
  const explain = h('div', { 'aria-live': 'polite' });

  const tool = (name, label, onclick, extra = {}) =>
    h('button', { class: 'tool', type: 'button', onclick, title: label, ...extra }, icon(name), label);
  const undoBtn = tool('undo', 'Undo', () => game.undo());
  const redoBtn = tool('redo', 'Redo', () => game.redo());
  const eraseBtn = tool('erase', 'Erase', () => board.selected >= 0 && game.erase(board.selected));
  const notesBtn = tool('pencil', 'Notes', () => setNotesMode(!notesMode), { 'aria-pressed': 'false' });
  const hintCount = h('span', { class: 'tool__count' });
  const hintBtn = tool('bulb', 'Hint', () => requestHint());
  hintBtn.append(hintCount);

  const keys = [];
  const pad = h('div', { class: 'pad' });
  for (let d = 1; d <= 9; d++) {
    const left = h('small');
    const key = h('button', { class: 'key', type: 'button', 'aria-label': `Enter ${d}`, onclick: () => input(d) }, String(d), left);
    keys.push({ key, left });
    pad.append(key);
  }

  const panel = h('div', { class: 'panel' },
    h('div', { class: 'tools' }, undoBtn, redoBtn, eraseBtn, notesBtn, hintBtn),
    pad,
    explain,
    h('div', { class: 'keys-help' },
      h('kbd', null, '1'), '–', h('kbd', null, '9'), ' place · ', h('kbd', null, 'Shift'), '+digit note · ',
      h('kbd', null, 'N'), ' notes · ', h('kbd', null, 'H'), ' hint · ', h('kbd', null, 'Ctrl Z'), ' undo · ',
      h('kbd', null, 'Space'), ' pause · ', h('button', { class: 'link', type: 'button', onclick: () => game.fillNotes() }, 'fill all notes')),
  );

  const title = mode === 'daily'
    ? `${capitalize(s.level)} · No. ${s.number}`
    : `Practice · ${capitalize(s.level)}`;
  mount(main,
    h('header', { class: 'playbar' },
      h('div', { class: 'playbar__side' },
        h('a', { class: 'icon-btn', href: mode === 'daily' && !s.ranked ? '/archive' : '/', 'aria-label': 'Back' }, icon('back')),
      ),
      h('div', { class: 'playbar__title' },
        h('h1', null, title),
        h('small', null, `Needs ${s.technique}${mode === 'daily' && !s.ranked ? ' · archive' : ''}`),
      ),
      h('div', { class: 'playbar__side playbar__side--end' },
        timerEl,
        pauseBtn,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Settings', onclick: () => settingsDialog((next) => { settings = next; board.settings = next; board.renderAll(); }) }, icon('gear')),
      ),
    ),
    h('section', { class: 'play' }, boardWrap, panel),
  );

  // ---- rendering ----

  function refreshControls() {
    const left = game.remaining();
    keys.forEach(({ key, left: small }, i) => {
      small.textContent = left[i + 1] > 0 ? String(left[i + 1]) : '';
      key.disabled = game.done || (left[i + 1] <= 0 && !notesMode);
    });
    undoBtn.disabled = game.done || !game.undoStack.length;
    redoBtn.disabled = game.done || !game.redoStack.length;
    eraseBtn.disabled = game.done;
    hintBtn.disabled = game.done || busy;
    notesBtn.disabled = game.done;
    hintCount.textContent = game.hints ? String(game.hints) : '';
  }

  function setNotesMode(on) {
    notesMode = on;
    notesBtn.setAttribute('aria-pressed', String(on));
    pad.classList.toggle('notes-mode', on);
    refreshControls();
  }

  function select(i) {
    if (hint) clearHint();
    board.select(i);
  }

  function input(d, asNote = notesMode) {
    if (game.done) return;
    const i = board.selected;
    if (i < 0) return toast('Select a cell first');
    if (game.isGiven(i)) return;
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
    refreshControls();
    try {
      const res = await api.hint(game.token, game.board());
      game.token = res.token;
      game.hints = res.hints;
      game.start();
      save();
      hint = res;
      board.showHint(res);
      renderExplanation(res);
    } catch (err) {
      toast(err.message);
    } finally {
      busy = false;
      refreshControls();
    }
  }

  function renderExplanation(res) {
    const actions = h('div', { class: 'explain__actions' });
    if (res.kind === 'mistake') {
      actions.append(h('button', { class: 'btn btn--accent', type: 'button', onclick: () => { const i = res.index; clearHint(); game.erase(i); board.select(i); } }, 'Clear that cell'));
    } else {
      if (res.eliminations.length) {
        actions.append(h('button', { class: 'btn', type: 'button', onclick: () => game.applyEliminations(res.eliminations) }, 'Remove candidates'));
      }
      actions.append(h('button', { class: 'btn btn--primary', type: 'button', onclick: () => { const { index, value } = res; clearHint(); game.setValue(index, value, { autoNotes: settings.autoNotes }); board.select(index); board.pop(index); } }, `Place ${res.value}`));
    }
    actions.append(h('button', { class: 'btn btn--ghost', type: 'button', onclick: clearHint }, 'Dismiss'));
    explain.replaceChildren(h('div', { class: `explain${res.kind === 'mistake' ? ' explain--mistake' : ''}` },
      h('div', { class: 'explain__head' }, h('h3', null, res.technique), h('span', { class: 'caption' }, `Hint ${res.hints} · +30s`)),
      res.chain.length
        ? h('ol', null,
            res.chain.map((c) => h('li', null, h('b', null, `${c.technique}: `), c.description)),
            h('li', null, h('b', null, 'Then: '), res.description))
        : h('p', null, res.description),
      actions,
    ));
  }

  // ---- pause & clock ----

  let pauseOverlay = null;
  function togglePause(force) {
    if (game.done) return;
    const pausing = force ?? !pauseOverlay;
    if (pausing && !pauseOverlay) {
      game.pause();
      pauseOverlay = h('div', { class: 'pause' },
        h('h2', null, 'Paused'),
        h('p', null, formatTime(game.time())),
        h('button', { class: 'btn btn--primary', type: 'button', onclick: () => togglePause(false) }, icon('play'), 'Resume'),
      );
      boardWrap.append(pauseOverlay);
      pauseBtn.replaceChildren(icon('play'));
      pauseBtn.setAttribute('aria-label', 'Resume');
      save();
    } else if (!pausing && pauseOverlay) {
      pauseOverlay.remove();
      pauseOverlay = null;
      pauseBtn.replaceChildren(icon('pause'));
      pauseBtn.setAttribute('aria-label', 'Pause');
      if (game.moves.length) game.start();
    }
  }

  const tick = setInterval(() => {
    timerEl.textContent = formatTime(game.time());
  }, 250);
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
    refreshControls();
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
        if (mode === 'daily') {
          store.saveResult(s.date, s.level, { ms: result.ms, hints: result.hints, rank: result.rank ?? null, percentile: result.percentile ?? null });
        } else {
          store.savePractice(s.level, result.ms);
        }
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
    if (k === ' ' || k === 'p' || k === 'P') {
      e.preventDefault();
      return togglePause();
    }
    if (pauseOverlay || game.done) return;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      e.preventDefault();
      return input(Number(digit[1]), notesMode !== e.shiftKey);
    }
    if (k === 'Backspace' || k === 'Delete' || k === '0') {
      e.preventDefault();
      return board.selected >= 0 && game.erase(board.selected);
    }
    if (k === 'n' || k === 'N') return setNotesMode(!notesMode);
    if (k === 'h' || k === 'H') return requestHint();
    if (k === 'Escape') return hint ? clearHint() : null;
    const moves = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };
    if (k in moves) {
      e.preventDefault();
      const cur = board.selected < 0 ? 40 : board.selected;
      let r = Math.floor(cur / 9);
      let c = cur % 9;
      if (Math.abs(moves[k]) === 9) r = (r + Math.sign(moves[k]) + 9) % 9;
      else c = (c + moves[k] + 9) % 9;
      select(r * 9 + c);
    }
  }
  document.addEventListener('keydown', onKey);

  // ---- wiring ----

  const off = game.onChange((kind, detail) => {
    if (kind === 'board') {
      board.renderCells(detail.cells);
      refreshControls();
      save();
    }
    if (kind === 'complete') finish();
  });

  refreshControls();
  if (game.done) {
    board.renderAll();
    if (game.result) setTimeout(showResult, 200);
    else showResult();
  } else {
    const firstEmpty = game.values.findIndex((v) => !v);
    board.select(firstEmpty);
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
    document.querySelectorAll('dialog').forEach((d) => d.close());
  };
}
