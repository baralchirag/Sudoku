/* Sudoku — full game client.
 * Play & Daily modes, four difficulties, pencil notes, undo/redo, hints,
 * wrong entries flagged red (no mistake limit), timer (pauses when the tab
 * is hidden), win overlay, number pad with per-digit remaining counts, full
 * keyboard support, and localStorage persistence per mode.
 */
'use strict';

document.addEventListener('DOMContentLoaded', () => {
    // ---------- configuration ----------
    const urlParams = new URLSearchParams(window.location.search);
    const apiParam = urlParams.get('api');
    const API_BASE = apiParam !== null
        ? apiParam
        : (location.protocol.startsWith('http') ? '' : 'http://localhost:8090');

    // Built-in sample so the page still works if the backend is offline.
    const SAMPLE = {
        difficulty: 'easy',
        puzzle: '530070000600195000098000060800060003400803001700020006060000280000419005000080079',
        solution: '534678912672195348198342567859761423426853791713924856961537284287419635345286179',
    };

    const MAX_HISTORY = 300;
    const PROGRESS_KEY = 'sudoku.progress';
    const STATS_KEY = 'sudoku.stats';
    const LAST_MODE_KEY = 'sudoku.lastMode';

    // ---------- dom ----------
    const $ = id => document.getElementById(id);
    const el = {
        modeTabs: $('mode-tabs'),
        metaLabel: $('meta-label'),
        timer: $('timer'),
        difficultyRow: $('difficulty-row'),
        board: $('board'),
        notice: $('notice'),
        notesBtn: $('notes-btn'),
        undoBtn: $('undo-btn'),
        redoBtn: $('redo-btn'),
        eraseBtn: $('erase-btn'),
        hintBtn: $('hint-btn'),
        hintCount: $('hint-count'),
        numpad: $('numpad'),
        clearBtn: $('clear-btn'),
        restartBtn: $('restart-btn'),
        newBtn: $('new-btn'),
        dailyBadge: $('daily-badge'),
        overlayRoot: $('overlay-root'),
        overlayClose: $('overlay-close'),
        overlayEmoji: $('overlay-emoji'),
        overlayTitle: $('overlay-title'),
        overlayBody: $('overlay-body'),
        overlayPrimary: $('overlay-primary'),
        overlaySecondary: $('overlay-secondary'),
    };

    // ---------- state ----------
    const G = {
        mode: 'play',
        difficulty: 'easy',
        date: todayStr(),
        puzzle: '',         // 81-char given string
        solution: '',       // 81-char solution string
        board: [],          // 81 ints (0 = empty)
        notes: [],          // 81 x [false x9]
        selected: -1,
        notesMode: false,
        hints: 0,
        history: [],
        redo: [],
        won: false,
        busy: false,
        timer: { started: false, running: false, acc: 0 },
    };

    let stats = loadJSON(STATS_KEY, { daily: {}, best: {} });
    let cells = [];
    let numKeys = {};

    // ---------- tiny helpers ----------
    function todayStr() {
        const d = new Date();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    }

    function progressKey() {
        return `${PROGRESS_KEY}.${G.mode}`;
    }

    function loadJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function saveJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }

    function fmtTime(totalSeconds) {
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        const mm = String(m).padStart(2, '0');
        const ss = String(s).padStart(2, '0');
        return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }

    function isGiven(i) {
        return G.puzzle.charCodeAt(i) > 48;
    }

    // ---------- board & numpad construction ----------
    function buildBoard() {
        el.board.innerHTML = '';
        cells = [];
        for (let i = 0; i < 81; i++) {
            const row = Math.floor(i / 9);
            const col = i % 9;
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.dataset.index = i;
            if (col === 8) cell.style.borderRight = '0';
            if (row === 8) cell.style.borderBottom = '0';
            if (col % 3 === 2 && col !== 8) cell.classList.add('box-r');
            if (row % 3 === 2 && row !== 8) cell.classList.add('box-b');
            cell.addEventListener('click', () => selectCell(i));
            el.board.appendChild(cell);
            cells.push(cell);
        }
    }

    function buildNumpad() {
        el.numpad.innerHTML = '';
        numKeys = {};
        for (let d = 1; d <= 9; d++) {
            const key = document.createElement('button');
            key.type = 'button';
            key.className = 'num-key';
            key.dataset.digit = d;
            key.innerHTML = `<span class="num-main">${d}</span><span class="num-left" data-left></span>`;
            key.addEventListener('click', () => inputDigit(d));
            el.numpad.appendChild(key);
            numKeys[d] = key;
        }
    }

    // ---------- timer ----------
    function tick() {
        if (G.timer.running && !G.won && !document.hidden) {
            G.timer.acc += 1;
        }
        el.timer.textContent = fmtTime(G.timer.acc);
    }

    function startTimer() {
        if (G.won || G.timer.running) return;
        G.timer.started = true;
        G.timer.running = true;
    }

    function pauseTimer() {
        G.timer.running = false;
    }

    function resetTimer() {
        G.timer = { started: false, running: false, acc: 0 };
    }

    // ---------- selection & peer math ----------
    function peersOf(index) {
        const row = Math.floor(index / 9);
        const col = index % 9;
        const out = [];
        for (let c = 0; c < 9; c++) if (c !== col) out.push(row * 9 + c);
        for (let r = 0; r < 9; r++) if (r !== row) out.push(r * 9 + col);
        const br = Math.floor(row / 3) * 3;
        const bc = Math.floor(col / 3) * 3;
        for (let r = br; r < br + 3; r++) {
            for (let c = bc; c < bc + 3; c++) {
                const idx = r * 9 + c;
                if (idx !== index && !out.includes(idx)) out.push(idx);
            }
        }
        return out;
    }

    function selectCell(index) {
        if (G.won) return;
        G.selected = index;
        render();
    }

    // ---------- history (snapshot based) ----------
    function snapshot() {
        return {
            board: G.board.slice(),
            notes: G.notes.map(row => row.slice()),
            hints: G.hints,
            selected: G.selected,
        };
    }

    function restoreSnapshot(snap) {
        G.board = snap.board;
        G.notes = snap.notes;
        G.hints = snap.hints;
        G.selected = snap.selected;
    }

    function pushHistory() {
        G.history.push(snapshot());
        if (G.history.length > MAX_HISTORY) G.history.shift();
        G.redo = [];
    }

    function undo() {
        if (G.won || !G.history.length) return;
        G.redo.push(snapshot());
        restoreSnapshot(G.history.pop());
        render();
        autosave();
    }

    function redo() {
        if (G.won || !G.redo.length) return;
        G.history.push(snapshot());
        restoreSnapshot(G.redo.pop());
        render();
        autosave();
    }

    // ---------- core input ----------
    function inputDigit(digit) {
        if (G.won || G.busy) return;
        const idx = G.selected;
        if (idx === -1) return;

        if (G.notesMode) {
            if (isGiven(idx) || G.board[idx] !== 0) return;
            startTimer();
            pushHistory();
            const pos = digit - 1;
            G.notes[idx][pos] = !G.notes[idx][pos];
            commitChange();
            return;
        }

        if (isGiven(idx)) return;
        const prev = G.board[idx];
        if (prev === digit) {
            startTimer();
            pushHistory();
            G.board[idx] = 0;
            commitChange();
            return;
        }

        startTimer();
        pushHistory();
        G.board[idx] = digit;
        // remove the placed candidate from peers' notes
        for (const p of peersOf(idx)) G.notes[p][digit - 1] = false;
        G.notes[idx] = new Array(9).fill(false);
        commitChange();
    }

    function eraseSelected() {
        if (G.won || G.busy || G.selected === -1) return;
        const idx = G.selected;
        if (isGiven(idx)) return;
        const hadValue = G.board[idx] !== 0;
        const hadNotes = G.notes[idx].some(Boolean);
        if (!hadValue && !hadNotes) return;
        startTimer();
        pushHistory();
        G.board[idx] = 0;
        G.notes[idx] = new Array(9).fill(false);
        commitChange();
    }

    function clearBoard() {
        if (G.won || G.busy) return;
        let changed = false;
        for (let i = 0; i < 81; i++) {
            if (!isGiven(i) && (G.board[i] !== 0 || G.notes[i].some(Boolean))) {
                changed = true;
                break;
            }
        }
        if (!changed) return;
        startTimer();
        pushHistory();
        for (let i = 0; i < 81; i++) {
            if (!isGiven(i)) {
                G.board[i] = 0;
                G.notes[i] = new Array(9).fill(false);
            }
        }
        commitChange();
    }

    function useHint() {
        if (G.won || G.busy) return;
        let idx = -1;
        if (G.selected !== -1 && !isGiven(G.selected) && G.board[G.selected] === 0) {
            idx = G.selected;
        } else {
            for (let i = 0; i < 81; i++) {
                if (!isGiven(i) && G.board[i] === 0) { idx = i; break; }
            }
        }
        if (idx === -1) return;
        startTimer();
        pushHistory();
        G.board[idx] = Number(G.solution[idx]);
        G.notes[idx] = new Array(9).fill(false);
        for (const p of peersOf(idx)) G.notes[p][G.board[idx] - 1] = false;
        G.hints++;
        G.selected = idx;
        commitChange();
        cells[idx].classList.add('hint-flash');
        setTimeout(() => { if (cells[idx]) cells[idx].classList.remove('hint-flash'); }, 700);
    }

    function toggleNotes() {
        if (G.won) return;
        G.notesMode = !G.notesMode;
        render();
    }

    // ---------- win / lose ----------
    const OVERLAY_ICONS = {
        win: '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="24" r="19" stroke="var(--accent)" stroke-width="3"/><path d="M16.5 24.5l5 5.5L31.5 19" stroke="var(--accent)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    };

    function statChips(seconds, withBest) {
        const chips = [
            `<span class="stat-chip"><b>${fmtTime(seconds)}</b><small>time</small></span>`,
            `<span class="stat-chip"><b>${G.hints}</b><small>${G.hints === 1 ? 'hint' : 'hints'}</small></span>`,
        ];
        if (withBest) chips.push('<span class="stat-chip best"><b>★</b><small>new best</small></span>');
        return chips.join('');
    }

    function checkWin() {
        for (let i = 0; i < 81; i++) {
            if (G.board[i] !== Number(G.solution[i])) return false;
        }
        return true;
    }

    function commitChange() {
        render();
        autosave();
        if (!G.won && checkWin()) finish();
    }

    function finish() {
        G.won = true;
        pauseTimer();
        const seconds = G.timer.acc;
        const isNewBest = recordWin(seconds);
        const chips = statChips(seconds, isNewBest);

        render();
        autosave();
        if (G.mode === 'daily') {
            showOverlay('win', 'Daily challenge complete!', chips, 'View board', hideOverlay, false);
        } else {
            showOverlay('win', 'Puzzle solved!', chips, 'Play again', () => newGame(), false);
        }
    }

    function recordWin(seconds) {
        if (G.mode === 'daily') {
            const day = G.date;
            if (!stats.daily[day]) {
                stats.daily[day] = { seconds, hints: G.hints };
                saveJSON(STATS_KEY, stats);
                return true;
            }
            return false;
        }
        const prev = stats.best[G.difficulty];
        if (!prev || seconds < prev.seconds) {
            stats.best[G.difficulty] = { seconds, hints: G.hints };
            saveJSON(STATS_KEY, stats);
            return true;
        }
        return false;
    }

    // ---------- overlays ----------
    function showOverlay(icon, title, bodyHTML, primaryLabel, primaryAction, showSecondary, secondaryLabel = 'Close') {
        el.overlayEmoji.innerHTML = OVERLAY_ICONS[icon] || '';
        el.overlayTitle.textContent = title;
        el.overlayBody.innerHTML = bodyHTML;
        el.overlayPrimary.textContent = primaryLabel;
        el.overlayPrimary.onclick = primaryAction;
        el.overlaySecondary.textContent = secondaryLabel;
        el.overlaySecondary.classList.toggle('hidden', !showSecondary);
        el.overlaySecondary.onclick = () => hideOverlay();
        el.overlayRoot.classList.remove('hidden');
    }

    function hideOverlay() {
        el.overlayRoot.classList.add('hidden');
    }

    // ---------- rendering ----------
    function metaHtml() {
        if (G.mode === 'daily') {
            return `${prettyDate(G.date)}<small>Daily challenge · ${G.difficulty}</small>`;
        }
        return `${cap(G.difficulty)} puzzle<small>Random puzzle</small>`;
    }

    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    function prettyDate(iso) {
        try {
            const [y, m, d] = iso.split('-').map(Number);
            return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        } catch (e) {
            return iso;
        }
    }

    function render() {
        // mode tabs & meta
        el.modeTabs.querySelectorAll('.mode-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === G.mode);
        });
        el.metaLabel.innerHTML = G.puzzle ? metaHtml() : 'Loading…';
        el.difficultyRow.classList.toggle('hidden', G.mode !== 'play');
        el.difficultyRow.querySelectorAll('.diff-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.diff === G.difficulty);
        });

        // timer
        el.timer.textContent = fmtTime(G.timer.acc);

        // tool buttons
        el.notesBtn.classList.toggle('on', G.notesMode);
        el.notesBtn.setAttribute('aria-pressed', String(G.notesMode));
        el.undoBtn.disabled = !G.history.length || G.won;
        el.redoBtn.disabled = !G.redo.length || G.won;
        el.eraseBtn.disabled = G.selected === -1;
        el.hintCount.textContent = G.hints ? String(G.hints) : '';
        el.hintBtn.title = G.hints ? `${G.hints} hint${G.hints === 1 ? '' : 's'} used` : 'Reveal a number';
        el.newBtn.textContent = G.mode === 'daily' ? 'New Daily' : 'New Puzzle';
        el.dailyBadge.classList.toggle('hidden', !(G.mode === 'daily' && stats.daily[G.date]));

        // highlight sets
        const peers = G.selected === -1 ? [] : peersOf(G.selected);
        const peersSet = new Set(peers);
        const sameSet = new Set();
        if (G.selected !== -1 && G.board[G.selected]) {
            const v = G.board[G.selected];
            for (let i = 0; i < 81; i++) {
                if (i !== G.selected && G.board[i] === v) sameSet.add(i);
            }
        }

        for (let i = 0; i < 81; i++) {
            const cell = cells[i];
            const val = G.board[i];
            const isFixed = isGiven(i);
            const given = isFixed && val !== 0;

            cell.className = 'cell';
            if (i % 9 === 8) cell.style.borderRight = '0';
            if (Math.floor(i / 9) === 8) cell.style.borderBottom = '0';
            if (i % 9 % 3 === 2 && i % 9 !== 8) cell.classList.add('box-r');
            if (Math.floor(i / 9) % 3 === 2 && Math.floor(i / 9) !== 8) cell.classList.add('box-b');
            if (given) cell.classList.add('given');
            if (i === G.selected) cell.classList.add('selected');
            if (peersSet.has(i)) cell.classList.add('peer');
            if (sameSet.has(i)) cell.classList.add('same');
            // auto-check: user entries that contradict the solution show as errors
            if (!isFixed && val !== 0 && val !== Number(G.solution[i])) cell.classList.add('wrong');

            cell.textContent = '';
            if (val !== 0) {
                cell.textContent = String(val);
            } else if (!isGiven(i)) {
                const notesEl = document.createElement('div');
                notesEl.className = 'notes-grid';
                for (let d = 1; d <= 9; d++) {
                    const span = document.createElement('span');
                    span.className = 'note-digit';
                    span.textContent = G.notes[i][d - 1] ? String(d) : '';
                    notesEl.appendChild(span);
                }
                cell.appendChild(notesEl);
            }
        }

        // A won board hides the error marks.
        if (G.won) {
            for (let i = 0; i < 81; i++) cells[i].classList.remove('wrong', 'conflict');
        }

        // numpad: dim finished digits, show remaining count
        const counts = new Array(10).fill(0);
        for (let i = 0; i < 81; i++) counts[G.board[i]]++;
        for (let d = 1; d <= 9; d++) {
            const left = 9 - counts[d];
            const key = numKeys[d];
            if (!key) continue;
            const leftEl = key.querySelector('[data-left]');
            if (leftEl) leftEl.textContent = left > 0 && left < 9 ? String(left) : '';
            key.classList.toggle('dim', left <= 0);
        }
    }

    // ---------- persistence ----------
    function autosave() {
        if (!G.puzzle) return;
        saveJSON(progressKey(), {
            mode: G.mode,
            difficulty: G.difficulty,
            date: G.date,
            puzzle: G.puzzle,
            solution: G.solution,
            board: G.board,
            notes: G.notes,
            hints: G.hints,
            won: G.won,
            timerStarted: G.timer.started,
            timerAcc: G.timer.acc,
        });
        saveJSON(LAST_MODE_KEY, G.mode);
    }

    // ---------- game lifecycle ----------
    function setupGame(payload) {
        G.puzzle = payload.puzzle;
        G.solution = payload.solution;
        G.difficulty = (payload.difficulty || G.difficulty).toLowerCase();
        if (payload.date) G.date = payload.date;
        G.board = new Array(81).fill(0);
        for (let i = 0; i < 81; i++) {
            const ch = G.puzzle.charCodeAt(i);
            if (ch > 48) G.board[i] = ch - 48;
        }
        G.notes = Array.from({ length: 81 }, () => new Array(9).fill(false));
        G.selected = -1;
        G.notesMode = false;
        G.hints = 0;
        G.history = [];
        G.redo = [];
        G.won = false;
        resetTimer();
        hideOverlay();
        render();
        updateDailyBadge();
        autosave();
    }

    function loadFromProgress(saved) {
        if (!saved || typeof saved.puzzle !== 'string' || saved.puzzle.length !== 81) return false;
        if (saved.mode === 'daily' && saved.date !== todayStr()) return false; // stale daily
        G.mode = saved.mode || 'play';
        G.difficulty = saved.difficulty || 'easy';
        G.date = saved.date || todayStr();
        G.puzzle = saved.puzzle;
        G.solution = saved.solution;
        G.board = Array.isArray(saved.board) && saved.board.length === 81
            ? saved.board.map(v => Number(v) || 0)
            : new Array(81).fill(0);
        G.notes = Array.isArray(saved.notes) && saved.notes.length === 81
            ? saved.notes.map(row => (Array.isArray(row) && row.length === 9 ? row.map(Boolean) : new Array(9).fill(false)))
            : Array.from({ length: 81 }, () => new Array(9).fill(false));
        G.hints = Number(saved.hints) || 0;
        G.won = !!saved.won;
        G.selected = -1;
        G.history = [];
        G.redo = [];
        G.timer = {
            started: !!saved.timerStarted,
            running: !!saved.timerStarted && !G.won,
            acc: Number(saved.timerAcc) || 0,
        };
        hideOverlay();
        updateDailyBadge();
        if (G.won && G.mode === 'daily' && !stats.daily[G.date]) {
            stats.daily[G.date] = { seconds: G.timer.acc, hints: G.hints };
            saveJSON(STATS_KEY, stats);
            updateDailyBadge();
        }
        render();
        if (G.won) {
            // Restoring a finished game: offer a replay without re-recording stats.
            const chips = statChips(G.timer.acc, false);
            if (G.mode === 'daily') {
                showOverlay('win', 'Daily challenge complete!', chips, 'View board', hideOverlay, false);
            } else {
                showOverlay('win', 'Puzzle solved!', chips, 'Play again', () => newGame(), false);
            }
        }
        return true;
    }

    let loadSeq = 0;

    function newGame() {
        if (G.busy) return;
        hideOverlay();
        G.busy = true;
        G.selected = -1;
        el.metaLabel.innerHTML = 'Loading…';
        const myMode = G.mode;
        const seq = ++loadSeq;
        fetchPuzzle(myMode)
            .then(payload => {
                if (seq !== loadSeq || G.mode !== myMode) return;
                setupGame(payload);
                showNotice(false);
            })
            .catch(() => {
                if (seq !== loadSeq || G.mode !== myMode) return;
                // offline: fall back to built-in sample puzzle
                setupGame({ ...SAMPLE, difficulty: SAMPLE.difficulty });
                showNotice(true);
            })
            .finally(() => {
                if (seq === loadSeq) G.busy = false;
            });
    }

    async function fetchPuzzle(mode) {
        const qs = mode === 'daily'
            ? `date=${encodeURIComponent(todayStr())}`
            : `difficulty=${encodeURIComponent(G.difficulty)}`;
        const endpoint = mode === 'daily' ? '/api/puzzle/daily' : '/api/puzzle';
        const resp = await fetch(`${API_BASE}${endpoint}?${qs}`, { headers: { Accept: 'application/json' } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (!json || typeof json.puzzle !== 'string' || json.puzzle.length !== 81) {
            throw new Error('Malformed puzzle response');
        }
        return json;
    }

    function restartPuzzle() {
        hideOverlay();
        if (!G.puzzle) return;
        G.board = new Array(81).fill(0);
        for (let i = 0; i < 81; i++) {
            const ch = G.puzzle.charCodeAt(i);
            if (ch > 48) G.board[i] = ch - 48;
        }
        G.notes = Array.from({ length: 81 }, () => new Array(9).fill(false));
        G.hints = 0;
        G.history = [];
        G.redo = [];
        G.won = false;
        G.selected = -1;
        resetTimer();
        render();
        updateDailyBadge();
        autosave();
    }

    // ---------- mode / difficulty / limits ----------
    function switchMode(mode) {
        if (mode === G.mode || G.busy) return;
        autosave(); // persist the game we are leaving (uses current mode key)
        G.mode = mode;
        G.notesMode = false;
        G.selected = -1;
        const restored = loadFromProgress(loadJSON(progressKey(), null));
        if (!restored) newGame();
    }

    function showNotice(on) {
        el.notice.classList.toggle('hidden', !on);
        el.notice.textContent = on
            ? '⚠️ Server unreachable — showing a built-in sample. Start the backend for fresh puzzles.'
            : '';
    }

    function updateDailyBadge() {
        el.dailyBadge.classList.toggle('hidden', !(G.mode === 'daily' && stats.daily[G.date]));
    }

    // ---------- keyboard ----------
    function handleKeydown(e) {
        const overlayOpen = !el.overlayRoot.classList.contains('hidden');
        if (overlayOpen) {
            if (e.key === 'Escape' && !el.overlaySecondary.classList.contains('hidden')) {
                hideOverlay();
                e.preventDefault();
            }
            return;
        }

        // undo/redo shortcuts
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
            else if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
            else if (k === 'y') { e.preventDefault(); redo(); }
            return;
        }

        if (e.key >= '1' && e.key <= '9') {
            inputDigit(Number(e.key));
            return;
        }

        switch (e.key) {
            case 'Backspace':
            case 'Delete':
                e.preventDefault();
                eraseSelected();
                break;
            case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
                e.preventDefault();
                if (G.selected === -1) { selectCell(0); return; }
                const row = Math.floor(G.selected / 9);
                const col = G.selected % 9;
                let nr = row, nc = col;
                if (e.key === 'ArrowUp') nr = Math.max(0, row - 1);
                else if (e.key === 'ArrowDown') nr = Math.min(8, row + 1);
                else if (e.key === 'ArrowLeft') nc = Math.max(0, col - 1);
                else if (e.key === 'ArrowRight') nc = Math.min(8, col + 1);
                selectCell(nr * 9 + nc);
                break;
            }
            case 'n': case 'N':
                toggleNotes();
                break;
            case 'h': case 'H':
                useHint();
                break;
            case '0':
                eraseSelected();
                break;
        }
    }

    // ---------- wire up ----------
    buildBoard();
    buildNumpad();

    el.modeTabs.querySelectorAll('.mode-tab').forEach(btn => {
        btn.addEventListener('click', () => switchMode(btn.dataset.mode));
    });
    el.difficultyRow.querySelectorAll('.diff-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (G.mode !== 'play') return;
            if (G.difficulty === btn.dataset.diff) return;
            G.difficulty = btn.dataset.diff;
            autosave();
            newGame();
        });
    });
    el.newBtn.addEventListener('click', () => newGame());
    el.clearBtn.addEventListener('click', () => clearBoard());
    el.restartBtn.addEventListener('click', () => restartPuzzle());
    el.notesBtn.addEventListener('click', () => toggleNotes());
    el.undoBtn.addEventListener('click', () => undo());
    el.redoBtn.addEventListener('click', () => redo());
    el.eraseBtn.addEventListener('click', () => eraseSelected());
    el.hintBtn.addEventListener('click', () => useHint());
    el.overlayClose.addEventListener('click', () => hideOverlay());
    el.board.setAttribute('tabindex', '0');
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) pauseTimer();
        else if (!G.won && G.timer.started) { G.timer.running = true; }
    });
    window.addEventListener('beforeunload', () => autosave());
    setInterval(tick, 1000);

    // ---------- boot ----------
    const lastMode = loadJSON(LAST_MODE_KEY, 'play') === 'daily' ? 'daily' : 'play';
    G.mode = lastMode;
    const restored = loadFromProgress(loadJSON(progressKey(), null));
    if (!restored) {
        render();
        newGame();
    }
});
