package board

import "fmt"

// Board is a 81-length slice representing the Sudoku board.
// Cells use 0 for empty, 1-9 for values.
type Board []int

// New creates a new empty board (length 81) filled with zeros.
func New() Board {
	b := make([]int, 81)
	return b
}

// IndexToRowCol converts a linear index (0..80) to row, col (0..8).
func IndexToRowCol(idx int) (row int, col int) {
	return idx / 9, idx % 9
}

// RowColToIndex converts row and column (0..8) to linear index (0..80).
func RowColToIndex(row int, col int) int {
	return row*9 + col
}

// ValidateIndex returns an error if idx is out of range.
func ValidateIndex(idx int) error {
	if idx < 0 || idx >= 81 {
		return fmt.Errorf("index out of range: %d", idx)
	}
	return nil
}

// ValidateRowCol ensures row and column are in 0..8.
func ValidateRowCol(row, col int) error {
	if row < 0 || row >= 9 || col < 0 || col >= 9 {
		return fmt.Errorf("row/col out of range: %d/%d", row, col)
	}
	return nil
}

// Get returns the value at idx (0..80).
func (b Board) Get(idx int) (int, error) {
	if err := ValidateIndex(idx); err != nil {
		return 0, err
	}
	return b[idx], nil
}

// Set sets a value (0..9) at idx. Use 0 to clear.
func (b Board) Set(idx int, val int) error {
	if err := ValidateIndex(idx); err != nil {
		return err
	}
	if val < 0 || val > 9 {
		return fmt.Errorf("value out of range: %d", val)
	}
	b[idx] = val
	return nil
}

// IsValid checks whether placing num (1..9) at (row,col) is valid
// against Sudoku rules: no duplicate in the same row, column, or 3x3 box.
// It does not modify the board. The function assumes row/col are 0-based.
func IsValid(b Board, row, col, num int) bool {
	if err := ValidateRowCol(row, col); err != nil {
		return false
	}
	if num < 1 || num > 9 {
		return false
	}

	// Check row
	for c := 0; c < 9; c++ {
		if b[RowColToIndex(row, c)] == num {
			return false
		}
	}
	// Check column
	for r := 0; r < 9; r++ {
		if b[RowColToIndex(r, col)] == num {
			return false
		}
	}
	// Check 3x3 box
	startRow := (row / 3) * 3
	startCol := (col / 3) * 3
	for dr := 0; dr < 3; dr++ {
		for dc := 0; dc < 3; dc++ {
			if b[RowColToIndex(startRow+dr, startCol+dc)] == num {
				return false
			}
		}
	}
	return true
}

// Solve returns a solved copy of the board using backtracking.
// The input board is not modified.
func Solve(b Board) (Board, bool) {
	grid := make(Board, len(b))
	copy(grid, b)
	if solveBacktrack(grid) {
		return grid, true
	}
	return nil, false
}

// CountSolutions counts how many solutions the board has, stopping once
// the count reaches limit. A limit of 2 is enough to distinguish
// 0, 1, and multiple solutions.
func CountSolutions(b Board, limit int) int {
	if limit <= 0 {
		return 0
	}
	grid := make(Board, len(b))
	copy(grid, b)
	count := 0
	countSolutionsBacktrack(grid, limit, &count)
	return count
}

func solveBacktrack(b Board) bool {
	idx := findEmptyCell(b)
	if idx == -1 {
		return true
	}
	row, col := IndexToRowCol(idx)
	for num := 1; num <= 9; num++ {
		if IsValid(b, row, col, num) {
			b[idx] = num
			if solveBacktrack(b) {
				return true
			}
			b[idx] = 0
		}
	}
	return false
}

func countSolutionsBacktrack(b Board, limit int, count *int) {
	if *count >= limit {
		return
	}
	idx := findEmptyCell(b)
	if idx == -1 {
		*count++
		return
	}
	row, col := IndexToRowCol(idx)
	for num := 1; num <= 9; num++ {
		if IsValid(b, row, col, num) {
			b[idx] = num
			countSolutionsBacktrack(b, limit, count)
			b[idx] = 0
			if *count >= limit {
				return
			}
		}
	}
}

func findEmptyCell(b Board) int {
	for i, v := range b {
		if v == 0 {
			return i
		}
	}
	return -1
}

// BoardsEqual checks if two boards are identical.
func BoardsEqual(b1, b2 Board) bool {
	if len(b1) != len(b2) {
		return false
	}
	for i := range b1 {
		if b1[i] != b2[i] {
			return false
		}
	}
	return true
}
