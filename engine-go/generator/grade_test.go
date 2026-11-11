package generator

import (
	"testing"

	"github.com/baralchirag/sudoku/engine-go/logic"
)

func TestGeneratedPuzzlesMatchTheirGrade(t *testing.T) {
	for _, d := range []Difficulty{Easy, Medium, Hard, Expert} {
		for i := 0; i < 3; i++ {
			g := GeneratePuzzleRecord(d)
			res := logic.Solve(g.Puzzle)
			if !res.Solved {
				t.Fatalf("difficulty %d: puzzle not solvable by logic", d)
			}
			if res.Level() != int(d) {
				t.Errorf("difficulty %d: graded level %d (%s), clues %d", d, res.Level(), res.Hardest, g.Clues)
			}
			if g.Clues > clueCeiling[d] {
				t.Errorf("difficulty %d: %d clues exceeds ceiling %d", d, g.Clues, clueCeiling[d])
			}
		}
	}
}
