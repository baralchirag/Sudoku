package generator

import (
	"math/rand"
	"time"

	"github.com/chiragbaral/sudoku/backend-go/board"
)

// Difficulty represents the puzzle's difficulty level.
type Difficulty int

const (
	Easy Difficulty = iota
	Medium
	Hard
	Expert
)

// cluesByDifficulty maps a difficulty level to the approximate number of clues
// that should remain on the board.
var cluesByDifficulty = map[Difficulty]int{
	Easy:   45,
	Medium: 35,
	Hard:   28,
	Expert: 24,
}

// GeneratedPuzzle bundles the puzzle, its solution, and the difficulty used.
type GeneratedPuzzle struct {
	Difficulty Difficulty
	Puzzle     board.Board
	Solution   board.Board
}

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
func GeneratePuzzle(difficulty Difficulty) board.Board {
	return GeneratePuzzleRecord(difficulty).Puzzle
}

// GeneratePuzzleRecord creates a puzzle, keeps its solution, and stores the chosen difficulty.
func GeneratePuzzleRecord(difficulty Difficulty) GeneratedPuzzle {
	solution := GenerateFullBoard()
	puzzle := carvePuzzle(solution, difficulty)
	return GeneratedPuzzle{
		Difficulty: difficulty,
		Puzzle:     puzzle,
		Solution:   solution,
	}
}

func carvePuzzle(solution board.Board, difficulty Difficulty) board.Board {
	puzzle := make(board.Board, len(solution))
	copy(puzzle, solution)

	targetClues, ok := cluesByDifficulty[difficulty]
	if !ok {
		targetClues = cluesByDifficulty[Medium]
	}

	indices := rand.Perm(81)
	clues := 81

	for _, idx := range indices {
		if clues <= targetClues {
			break
		}

		value := puzzle[idx]
		if value == 0 {
			continue
		}
		puzzle[idx] = 0

		boardCopy := make(board.Board, len(puzzle))
		copy(boardCopy, puzzle)
		if board.CountSolutions(boardCopy, 2) != 1 {
			puzzle[idx] = value
		} else {
			clues--
		}
	}

	return puzzle
}
