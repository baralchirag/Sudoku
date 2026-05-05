document.addEventListener('DOMContentLoaded', () => {
    const boardElement = document.getElementById('sudoku-board');
    const cells = [];

    for (let i = 0; i < 81; i++) {
        const cell = document.createElement('div');
        cell.classList.add('cell');
        cell.dataset.index = i;
        boardElement.appendChild(cell);
        cells.push(cell);

        cell.addEventListener('click', () => selectCell(i));
    }

    function selectCell(index) {
        // Clear previous highlights
        cells.forEach(c => {
            c.classList.remove('selected', 'highlighted');
        });

        const selectedCell = cells[index];
        selectedCell.classList.add('selected');

        highlightRelated(index);
    }

    function highlightRelated(index) {
        const row = Math.floor(index / 9);
        const col = index % 9;
        const boxStartRow = Math.floor(row / 3) * 3;
        const boxStartCol = Math.floor(col / 3) * 3;

        // Highlight row and column
        for (let i = 0; i < 9; i++) {
            // Row
            cells[row * 9 + i].classList.add('highlighted');
            // Column
            cells[i * 9 + col].classList.add('highlighted');
        }

        // Highlight box
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                cells[(boxStartRow + r) * 9 + (boxStartCol + c)].classList.add('highlighted');
            }
        }

        // The selected cell should not have the 'highlighted' class, only 'selected'
        cells[index].classList.remove('highlighted');
    }
});