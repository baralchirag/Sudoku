// Persistence in localStorage: saved games, finished results and settings.
// Every access is guarded: private mode or full storage must never break play.

const PREFIX = 'sudoku.v1.';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the game keeps working in memory */
  }
}

function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

const DEFAULT_SETTINGS = {
  name: '',
  theme: 'auto',
  highlightPeers: true,
  highlightSame: true,
  autoNotes: true,
  showConflicts: true,
  seenHelp: false,
};

export const store = {
  settings() {
    return { ...DEFAULT_SETTINGS, ...read('settings', {}) };
  },
  saveSettings(patch) {
    const next = { ...this.settings(), ...patch };
    write('settings', next);
    return next;
  },

  game(id) {
    return read(`game.${id}`, null);
  },
  saveGame(id, data) {
    write(`game.${id}`, data);
  },
  dropGame(id) {
    remove(`game.${id}`);
  },

  /** results[date][level] = { ms, hints, rank, percentile, total } */
  results() {
    return read('results', {});
  },
  saveResult(date, level, result) {
    const all = this.results();
    all[date] = { ...(all[date] || {}), [level]: result };
    write('results', all);
  },
};
