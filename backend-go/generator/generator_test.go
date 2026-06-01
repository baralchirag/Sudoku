package generator

import (
	"fmt"
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
	for _, difficulty := range []Difficulty{Easy, Medium, Hard, Expert} {
		t.Run(fmt.Sprintf("Difficulty_%d", difficulty), func(t *testing.T) {
			puzzle := GeneratePuzzle(difficulty)

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
		})
	}
}
