package board

import "testing"

func TestNewBoardLength(t *testing.T) {
	b := New()
	if len(b) != 81 {
		t.Fatalf("expected length 81, got %d", len(b))
	}
}

func TestIndexRowColConversions(t *testing.T) {
	for idx := 0; idx < 81; idx++ {
		r, c := IndexToRowCol(idx)
		got := RowColToIndex(r, c)
		if got != idx {
			t.Fatalf("roundtrip failed for idx=%d -> %d/%d -> %d", idx, r, c, got)
		}
	}
}

func TestSetGet(t *testing.T) {
	b := New()
	if err := b.Set(0, 5); err != nil {
		t.Fatalf("set failed: %v", err)
	}
	v, err := b.Get(0)
	if err != nil {
		t.Fatalf("get failed: %v", err)
	}
	if v != 5 {
		t.Fatalf("expected 5, got %d", v)
	}
}

func TestIsValidChecks(t *testing.T) {
	b := New()
	// empty board: placing 5 at 0,0 should be valid
	if !IsValid(b, 0, 0, 5) {
		t.Fatalf("expected valid on empty board")
	}
	// row conflict
	if err := b.Set(RowColToIndex(0, 1), 5); err != nil {
		t.Fatalf("set failed: %v", err)
	}
	if IsValid(b, 0, 0, 5) {
		t.Fatalf("expected invalid due to row conflict")
	}
	// reset
	if err := b.Set(RowColToIndex(0, 1), 0); err != nil {
		t.Fatalf("reset failed: %v", err)
	}
	// column conflict
	if err := b.Set(RowColToIndex(1, 0), 6); err != nil {
		t.Fatalf("set failed: %v", err)
	}
	if IsValid(b, 0, 0, 6) {
		t.Fatalf("expected invalid due to column conflict")
	}
	if err := b.Set(RowColToIndex(1, 0), 0); err != nil {
		t.Fatalf("reset failed: %v", err)
	}
	// box conflict
	if err := b.Set(RowColToIndex(1, 1), 7); err != nil {
		t.Fatalf("set failed: %v", err)
	}
	if IsValid(b, 0, 0, 7) {
		t.Fatalf("expected invalid due to box conflict")
	}
}

func TestSolveFullBoard(t *testing.T) {
	puzzle := Board{
		5, 3, 0, 0, 7, 0, 0, 0, 0,
		6, 0, 0, 1, 9, 5, 0, 0, 0,
		0, 9, 8, 0, 0, 0, 0, 6, 0,
		8, 0, 0, 0, 6, 0, 0, 0, 3,
		4, 0, 0, 8, 0, 3, 0, 0, 1,
		7, 0, 0, 0, 2, 0, 0, 0, 6,
		0, 6, 0, 0, 0, 0, 2, 8, 0,
		0, 0, 0, 4, 1, 9, 0, 0, 5,
		0, 0, 0, 0, 8, 0, 0, 7, 9,
	}

	solved, ok := Solve(puzzle)
	if !ok {
		t.Fatalf("expected puzzle to be solvable")
	}
	if len(solved) != 81 {
		t.Fatalf("expected solved board length 81, got %d", len(solved))
	}
	for i, v := range solved {
		if v < 1 || v > 9 {
			t.Fatalf("unexpected value at index %d: %d", i, v)
		}
	}
	// ensure original puzzle was not modified
	if puzzle[2] != 0 {
		t.Fatalf("expected original puzzle to remain unchanged")
	}
	// a solved board must satisfy IsValid for every cell's value
	for idx, num := range solved {
		row, col := IndexToRowCol(idx)
		if !IsValid(solved, row, col, num) {
			t.Fatalf("solved board invalid at index %d (%d,%d) = %d", idx, row, col, num)
		}
	}
}

func TestCountSolutions(t *testing.T) {
	t.Run("zero solutions", func(t *testing.T) {
		board := New()
		if err := board.Set(RowColToIndex(0, 0), 1); err != nil {
			t.Fatalf("set failed: %v", err)
		}
		if err := board.Set(RowColToIndex(0, 1), 1); err != nil {
			t.Fatalf("set failed: %v", err)
		}
		if got := CountSolutions(board, 2); got != 0 {
			t.Fatalf("expected 0 solutions, got %d", got)
		}
	})

	t.Run("one solution", func(t *testing.T) {
		puzzle := Board{
			5, 3, 0, 0, 7, 0, 0, 0, 0,
			6, 0, 0, 1, 9, 5, 0, 0, 0,
			0, 9, 8, 0, 0, 0, 0, 6, 0,
			8, 0, 0, 0, 6, 0, 0, 0, 3,
			4, 0, 0, 8, 0, 3, 0, 0, 1,
			7, 0, 0, 0, 2, 0, 0, 0, 6,
			0, 6, 0, 0, 0, 0, 2, 8, 0,
			0, 0, 0, 4, 1, 9, 0, 0, 5,
			0, 0, 0, 0, 8, 0, 0, 7, 9,
		}
		if got := CountSolutions(puzzle, 2); got != 1 {
			t.Fatalf("expected 1 solution, got %d", got)
		}
	})

	t.Run("multiple solutions", func(t *testing.T) {
		board := New()
		if err := board.Set(RowColToIndex(0, 0), 1); err != nil {
			t.Fatalf("set failed: %v", err)
		}
		if got := CountSolutions(board, 2); got != 2 {
			t.Fatalf("expected to stop at 2 solutions, got %d", got)
		}
	})
}

package generator

import (
    "testing"

    "github.com/chiragbaral/sudoku/backend-go/board"
)

func TestGenerateFullBoard(t *testing.T) {
    b := GenerateFullBoard()

    if len(b) != 81 {
        t.Fatalf("expected board length 81, got %d", len(b))
    }

    // Check if the board is fully filled
    for i, cell := range b {
        if cell == 0 {
            t.Fatalf("board is not full, empty cell at index %d", i)
        }
    }

    // Check if the generated board is valid
    for i, cell := range b {
        row, col := board.IndexToRowCol(i)
        // Temporarily empty the cell to check if the number can be placed there
        b[i] = 0
        if !board.IsValid(b, row, col, cell) {
            t.Fatalf("invalid board: value %d at row %d, col %d is not valid", cell, row, col)
        }
        // Restore the cell value
        b[i] = cell
    }
}

func TestGeneratesDifferentBoards(t *testing.T) {
    board1 := GenerateFullBoard()
    board2 := GenerateFullBoard()

    // It's statistically very unlikely they are the same.
    // A simple check is enough.
    if board.BoardsEqual(board1, board2) {
        t.Errorf("Generated two identical boards, which is highly unlikely and may indicate a problem with randomness.")
    }
}

func TestGeneratePuzzle(t *testing.T) {
    puzzle := GeneratePuzzle()

    // 1. Check that the puzzle is not empty
    if puzzle == nil || len(puzzle) != 81 {
        t.Fatalf("puzzle is nil or has incorrect length")
    }

    // 2. Check that the puzzle has empty cells
    hasEmptyCells := false
    for _, cell := range puzzle {
        if cell == 0 {
            hasEmptyCells = true
            break
        }
    }
    if !hasEmptyCells {
        t.Errorf("generated puzzle has no empty cells")
    }

    // 3. Check that the puzzle has exactly one solution
    solutionCount := board.CountSolutions(puzzle, 2)
    if solutionCount != 1 {
        t.Errorf("expected puzzle to have 1 solution, but got %d", solutionCount)
    }
}
