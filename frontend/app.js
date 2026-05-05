document.addEventListener('DOMContentLoaded', () => {
    const boardElement = document.getElementById('sudoku-board');
    const cells = [];
    const gameState = {
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

    document.addEventListener('keydown', handleKeyPress);

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

    function handleKeyPress(event) {
        const idx = gameState.selected;
        if (idx === -1) return;

        if (gameState.fixedSet.has(idx)) return;

        const key = event.key;
        if (key >= '1' && key <= '9') {
            gameState.current[idx] = parseInt(key, 10);
            cells[idx].textContent = key;
        } else if (key === 'Backspace' || key === 'Delete') {
            gameState.current[idx] = 0;
            cells[idx].textContent = '';
        }
    }
});