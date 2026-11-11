package generator

import (
	"math/rand"
	"time"

	"github.com/chiragbaral/sudoku/backend-go/board"
	"github.com/chiragbaral/sudoku/backend-go/logic"
)

// Difficulty represents the puzzle's difficulty level.
type Difficulty int

const (
	Easy Difficulty = iota
	Medium
	Hard
	Expert
)

// clueCeiling is the most clues a puzzle of each level may keep. Difficulty
// itself comes from the techniques required (see package logic); the ceiling
// only stops, say, a Hard puzzle from being handed out with 40 clues.
var clueCeiling = map[Difficulty]int{
	Easy:   40,
	Medium: 34,
	Hard:   28,
	Expert: 30,
}

// maxAttempts bounds how many fresh grids are tried per puzzle before settling
// for the closest grade found.
const maxAttempts = 60

// GeneratedPuzzle bundles the puzzle, its solution, and its grade.
type GeneratedPuzzle struct {
	Difficulty Difficulty
	Puzzle     board.Board
	Solution   board.Board
	// Technique is the hardest technique needed to solve the puzzle by logic.
	Technique logic.Technique
	// Clues is the number of givens.
	Clues int
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

// GeneratePuzzleRecord creates a puzzle with a unique solution whose hardest
// required technique falls in the requested difficulty tier. Every puzzle is
// solvable by pure logic — no guessing — using the techniques in package logic.
func GeneratePuzzleRecord(difficulty Difficulty) GeneratedPuzzle {
	target := int(difficulty)
	var best GeneratedPuzzle
	bestLevel := -1
	for attempt := 0; attempt < maxAttempts; attempt++ {
		solution := GenerateFullBoard()
		puzzle, result := carvePuzzle(solution, difficulty)
		level := result.Level()
		candidate := GeneratedPuzzle{
			Difficulty: difficulty,
			Puzzle:     puzzle,
			Solution:   solution,
			Technique:  result.Hardest,
			Clues:      countClues(puzzle),
		}
		if level == target {
			return candidate
		}
		if level > bestLevel {
			best, bestLevel = candidate, level
		}
	}
	return best
}

// carvePuzzle removes givens from a solved grid in random order. A removal is
// kept only if the puzzle still has one solution and logic can still solve it
// without needing a technique above the target tier. Carving stops once the
// puzzle reaches the target tier and is under the clue ceiling.
func carvePuzzle(solution board.Board, difficulty Difficulty) (board.Board, logic.Result) {
	target := int(difficulty)
	ceiling, ok := clueCeiling[difficulty]
	if !ok {
		ceiling = clueCeiling[Medium]
	}

	puzzle := make(board.Board, len(solution))
	copy(puzzle, solution)
	result := logic.Solve(puzzle)
	clues := 81

	for _, idx := range rand.Perm(81) {
		if clues <= ceiling && result.Level() == target {
			break
		}
		value := puzzle[idx]
		puzzle[idx] = 0
		if board.CountSolutions(puzzle, 2) != 1 {
			puzzle[idx] = value
			continue
		}
		graded := logic.Solve(puzzle)
		if !graded.Solved || graded.Level() > target {
			puzzle[idx] = value
			continue
		}
		result = graded
		clues--
	}
	return puzzle, result
}

func countClues(b board.Board) int {
	n := 0
	for _, v := range b {
		if v != 0 {
			n++
		}
	}
	return n
}
