// Renders the 9x9 grid once and then patches classes and text in place, so a
// keystroke touches a handful of nodes instead of rebuilding the board.

import { h } from './dom.js';
import { PEERS, UNITS, cellName } from '../engine/geometry.js';

export class BoardView {
  constructor(game, settings, { onSelect }) {
    this.game = game;
    this.settings = settings;
    this.selected = -1;
    this.hint = null;
    this.cells = [];
    this.el = h('div', { class: 'board', role: 'grid', 'aria-label': 'Sudoku board' });
    for (let i = 0; i < 81; i++) {
      const cell = h('button', {
        class: 'cell',
        type: 'button',
        role: 'gridcell',
        tabindex: '-1',
        onclick: () => onSelect(i),
      });
      this.cells.push(cell);
      this.el.append(cell);
    }
    this.renderAll();
  }

  select(i) {
    this.selected = i;
    this.cells[i]?.focus({ preventScroll: true });
    this.paint();
  }

  /** Shows a server hint: target cell, pattern cells, units, struck notes. */
  showHint(hint) {
    this.hint = hint;
    this.paint();
  }

  clearHint() {
    if (!this.hint) return;
    this.hint = null;
    this.renderAll();
  }

  renderAll() {
    for (let i = 0; i < 81; i++) this.renderCell(i);
    this.paint();
  }

  renderCells(indices) {
    for (const i of indices) this.renderCell(i);
    this.paint();
  }

  renderCell(i) {
    const { game } = this;
    const cell = this.cells[i];
    const v = game.values[i];
    cell.classList.toggle('given', game.isGiven(i));
    if (v) {
      cell.textContent = String(v);
    } else if (game.notes[i]) {
      const grid = h('span', { class: 'notes', 'aria-hidden': 'true' });
      for (let d = 1; d <= 9; d++) grid.append(h('span', { dataset: { d } }, game.notes[i] & (1 << d) ? String(d) : ''));
      cell.replaceChildren(grid);
    } else {
      cell.textContent = '';
    }
    const notes = [...Array(9).keys()].filter((d) => game.notes[i] & (1 << (d + 1))).map((d) => d + 1);
    cell.setAttribute(
      'aria-label',
      `${cellName(i)}, ${v ? `${v}${game.isGiven(i) ? ', given' : ''}` : notes.length ? `notes ${notes.join(' ')}` : 'empty'}`,
    );
  }

  /** Recomputes highlight classes for every cell. */
  paint() {
    const { game, selected, settings, hint } = this;
    const value = selected >= 0 ? game.values[selected] : 0;
    const peers = new Set(selected >= 0 && settings.highlightPeers ? PEERS[selected] : []);
    const hintUnits = new Set(hint ? hint.units.flatMap((u) => UNITS[u]) : []);
    const hintCells = new Set(hint ? hint.cells : []);
    const elims = new Map();
    if (hint) for (const [c, d] of hint.eliminations) elims.set(c, (elims.get(c) || 0) | (1 << d));

    for (let i = 0; i < 81; i++) {
      const cl = this.cells[i].classList;
      cl.toggle('selected', i === selected);
      cl.toggle('peer', !hint && peers.has(i));
      cl.toggle('same', !hint && settings.highlightSame && value !== 0 && game.values[i] === value && i !== selected);
      cl.toggle('conflict', settings.showConflicts && game.conflicts.has(i) && !game.isGiven(i));
      cl.toggle('hint-unit', hintUnits.has(i));
      cl.toggle('hint-cell', hintCells.has(i) && i !== hint?.index);
      cl.toggle('hint-target', hint?.index === i);
      this.cells[i].setAttribute('aria-selected', String(i === selected));

      const notes = this.cells[i].querySelector('.notes');
      if (notes) {
        const mask = elims.get(i) || 0;
        for (const span of notes.children) {
          const d = Number(span.dataset.d);
          span.classList.toggle('elim', !!(mask & (1 << d)));
          span.classList.toggle('match', !hint && settings.highlightSame && value === d && span.textContent !== '');
        }
      }
    }
  }

  pop(i) {
    const cell = this.cells[i];
    cell.classList.remove('pop');
    void cell.offsetWidth; // restart the animation
    cell.classList.add('pop');
  }

  /** Ripple across the board on completion, row by row. */
  celebrate() {
    this.selected = -1;
    this.paint();
    this.cells.forEach((cell, i) => {
      cell.style.animationDelay = `${(Math.floor(i / 9) + (i % 9)) * 35}ms`;
      cell.classList.add('wave');
    });
  }
}
