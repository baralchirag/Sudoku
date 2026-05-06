document.addEventListener('DOMContentLoaded', () => {
    const boardElement = document.getElementById('sudoku-board');
    const difficultyButtons = Array.from(document.querySelectorAll('.difficulty-option'));
    const resetBtn = document.getElementById('reset-btn');
    const clearBtn = document.getElementById('clear-btn');
    const cells = [];
    const gameState = {
        difficulty: 'easy',
        initial: [
            5, 3, 0, 0, 7, 0, 0, 0, 0,
            6, 0, 0, 1, 9, 5, 0, 0, 0,
            0, 9, 8, 0, 0, 0, 0, 6, 0,
            8, 0, 0, 0, 6, 0, 0, 0, 3,
            4, 0, 0, 8, 0, 3, 0, 0, 1,
            7, 0, 0, 0, 2, 0, 0, 0, 6,
            0, 6, 0, 0, 0, 0, 2, 8, 0,
            0, 0, 0, 4, 1, 9, 0, 0, 5,
            0, 0, 0, 0, 8, 0, 0, 7, 9,
        ],
        current: [],
        selected: -1,
        fixedSet: new Set(),
    };

    gameState.current = gameState.initial.slice();
    gameState.initial.forEach((v, i) => { if (v !== 0) gameState.fixedSet.add(i); });

    difficultyButtons.forEach(button => {
        button.addEventListener('click', () => {
            gameState.difficulty = button.dataset.difficulty;
            difficultyButtons.forEach(option => option.classList.toggle('active', option === button));
        });
    });

    // wire action buttons
    if (resetBtn) resetBtn.addEventListener('click', resetPuzzle);
    if (clearBtn) clearBtn.addEventListener('click', clearBoard);

    boardElement.tabIndex = 0;

    for (let i = 0; i < 81; i++) {
        const cell = document.createElement('div');
        cell.classList.add('cell');
        cell.dataset.index = i;
        cell.addEventListener('click', () => selectCell(i));
        boardElement.appendChild(cell);
        cells.push(cell);
    }

    // render initial values and mark fixed cells
    for (let i = 0; i < 81; i++) {
        const v = gameState.current[i];
        const el = cells[i];
        if (v !== 0) {
            el.textContent = String(v);
            el.classList.add('fixed');
        } else {
            el.textContent = '';
        }
    }
    // Timer functions
    const timerEl = document.getElementById('timer');
    // initial validation for conflicts
    validateBoard();

    boardElement.addEventListener('keydown', handleKeyPress);

    function selectCell(index) {
        // clear previous selection and highlights
        if (gameState.selected !== -1) {
            cells[gameState.selected].classList.remove('selected');
        }
        cells.forEach(c => c.classList.remove('highlighted'));

        gameState.selected = index;
        const selectedCell = cells[gameState.selected];
        selectedCell.classList.add('selected');
        highlightRelated(index);
        boardElement.focus();
    }

    function highlightRelated(index) {
        const row = Math.floor(index / 9);
        const col = index % 9;
        const boxStartRow = Math.floor(row / 3) * 3;
        const boxStartCol = Math.floor(col / 3) * 3;

        for (let i = 0; i < 9; i++) {
            cells[row * 9 + i].classList.add('highlighted');
            cells[i * 9 + col].classList.add('highlighted');
        }

        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                cells[(boxStartRow + r) * 9 + (boxStartCol + c)].classList.add('highlighted');
            }
        }
        cells[index].classList.remove('highlighted');
    }

    // Validate board and mark conflicts (duplicates in row/col/box)
    function validateBoard() {
        const conflicts = new Set();

        // rows
        for (let r = 0; r < 9; r++) {
            const seen = {};
            for (let c = 0; c < 9; c++) {
                const idx = r * 9 + c;
                const v = gameState.current[idx];
                if (!v) continue;
                if (!seen[v]) seen[v] = [];
                seen[v].push(idx);
            }
            Object.values(seen).forEach(list => { if (list.length > 1) list.forEach(i => conflicts.add(i)); });
        }

        // columns
        for (let c = 0; c < 9; c++) {
            const seen = {};
            for (let r = 0; r < 9; r++) {
                const idx = r * 9 + c;
                const v = gameState.current[idx];
                if (!v) continue;
                if (!seen[v]) seen[v] = [];
                seen[v].push(idx);
            }
            Object.values(seen).forEach(list => { if (list.length > 1) list.forEach(i => conflicts.add(i)); });
        }

        // boxes
        for (let br = 0; br < 3; br++) {
            for (let bc = 0; bc < 3; bc++) {
                const seen = {};
                for (let r = 0; r < 3; r++) {
                    for (let c = 0; c < 3; c++) {
                        const rr = br * 3 + r;
                        const cc = bc * 3 + c;
                        const idx = rr * 9 + cc;
                        const v = gameState.current[idx];
                        if (!v) continue;
                        if (!seen[v]) seen[v] = [];
                        seen[v].push(idx);
                    }
                }
                Object.values(seen).forEach(list => { if (list.length > 1) list.forEach(i => conflicts.add(i)); });
            }
        }

        // apply classes
        for (let i = 0; i < 81; i++) {
            cells[i].classList.toggle('conflict', conflicts.has(i));
        }
    }

    function resetPuzzle() {
        // restore initial state
        gameState.current = gameState.initial.slice();
        // clear selection and highlights
        if (gameState.selected !== -1) {
            cells[gameState.selected].classList.remove('selected');
            gameState.selected = -1;
        }
        cells.forEach(c => { c.classList.remove('highlighted', 'conflict'); });

        // render cells
        for (let i = 0; i < 81; i++) {
            const el = cells[i];
            const v = gameState.current[i];
            el.textContent = v === 0 ? '' : String(v);
            el.classList.toggle('fixed', gameState.fixedSet.has(i));
        }

        // stop and reset timer
        stopTimer();
        if (timerEl) timerEl.textContent = '00:00';
        gameState.timer = null;
    }

    function clearBoard() {
        // clear only non-fixed cells
        for (let i = 0; i < 81; i++) {
            if (!gameState.fixedSet.has(i)) {
                gameState.current[i] = 0;
                cells[i].textContent = '';
            }
            cells[i].classList.remove('conflict');
        }
        validateBoard();
    }

    function formatTime(sec) {
        const m = Math.floor(sec / 60).toString().padStart(2, '0');
        const s = (sec % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    function startTimer() {
        if (!timerEl) return;
        if (gameState.timer && gameState.timer.interval) return; // already running
        gameState.timer = {
            startAt: Date.now(),
            elapsed: 0,
            interval: null,
        };
        // update immediately
        timerEl.textContent = formatTime(0);
        gameState.timer.interval = setInterval(() => {
            gameState.timer.elapsed = Math.floor((Date.now() - gameState.timer.startAt) / 1000);
            timerEl.textContent = formatTime(gameState.timer.elapsed);
        }, 1000);
    }

    function stopTimer() {
        if (gameState.timer && gameState.timer.interval) {
            clearInterval(gameState.timer.interval);
            gameState.timer.interval = null;
        }
    }

    function handleKeyPress(event) {
        const idx = gameState.selected;
        if (idx === -1) return;

        if (gameState.fixedSet.has(idx)) return;

        const key = event.key;
        if (key >= '1' && key <= '9') {
            event.preventDefault();
            startTimer();
            gameState.current[idx] = parseInt(key, 10);
            cells[idx].textContent = key;
            validateBoard();
        } else if (key === 'Backspace' || key === 'Delete') {
            event.preventDefault();
            gameState.current[idx] = 0;
            cells[idx].textContent = '';
            validateBoard();
        }
    }
});