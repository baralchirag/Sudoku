package generator

import (
	"math/rand"
	"time"

	"github.com/chiragbaral/sudoku/backend-go/board"
)

func init() {
	rand.Seed(time.Now().UnixNano())
}

// GenerateFullBoard creates a new, complete, and valid Sudoku board.
func GenerateFullBoard() board.Board {
	b := board.New()
	fillRandom(b)
	return b
}

// fillRandom uses backtracking to fill the board with a valid solution.
// It tries numbers in a random order to ensure a different grid each time.
func fillRandom(b board.Board) bool {
	idx := findEmptyCell(b)
	if idx == -1 {
		return true // Board is full
	}

	row, col := board.IndexToRowCol(idx)
	numbers := shuffledNumbers()

	for _, num := range numbers {
		if board.IsValid(b, row, col, num) {
			b[idx] = num
			if fillRandom(b) {
				return true
			}
			b[idx] = 0 // Backtrack
		}
	}
	return false
}

func findEmptyCell(b board.Board) int {
	for i, v := range b {
		if v == 0 {
			return i
		}
	}
	return -1
}

func shuffledNumbers() []int {
	nums := []int{1, 2, 3, 4, 5, 6, 7, 8, 9}
	rand.Shuffle(len(nums), func(i, j int) {
		nums[i], nums[j] = nums[j], nums[i]
	})
	return nums
}

// GeneratePuzzle creates a new puzzle with a unique solution by removing cells
// from a fully solved board.
func GeneratePuzzle() board.Board {
	// 1. Start with a full, valid board
	b := GenerateFullBoard()

	// 2. Create a shuffled list of cell indices to remove
	indices := rand.Perm(81)

	// 3. Remove cells one by one
	for _, idx := range indices {
		// 3a. Store the value and attempt to remove it
		value := b[idx]
		if value == 0 {
			continue
		}
		b[idx] = 0

		// 3b. Make a copy to check for a unique solution
		boardCopy := make(board.Board, len(b))
		copy(boardCopy, b)

		// 3c. If removing the cell results in not exactly one solution, put it back
		if board.CountSolutions(boardCopy, 2) != 1 {
			b[idx] = value
		}
	}

	return b
}
