package logic_test

import (
	"testing"

	"github.com/baralchirag/sudoku/engine-go/board"
	"github.com/baralchirag/sudoku/engine-go/generator"
	"github.com/baralchirag/sudoku/engine-go/logic"
)

func parse(t *testing.T, s string) board.Board {
	t.Helper()
	if len(s) != 81 {
		t.Fatalf("bad puzzle length %d", len(s))
	}
	b := board.New()
	for i, ch := range s {
		if ch >= '1' && ch <= '9' {
			b[i] = int(ch - '0')
		}
	}
	return b
}

// checkSound replays every step against the true solution: a placement must
// match it and an elimination must never remove the solution digit.
func checkSound(t *testing.T, puzzle board.Board, res logic.Result) {
	t.Helper()
	solution, ok := board.Solve(puzzle)
	if !ok {
		t.Fatalf("puzzle has no solution")
	}
	for n, s := range res.Steps {
		if s.Index >= 0 && solution[s.Index] != s.Value {
			t.Fatalf("step %d (%s) placed %d at %s, solution has %d: %s",
				n, s.Name, s.Value, logic.CellName(s.Index), solution[s.Index], s.Description)
		}
		for _, e := range s.Eliminations {
			if solution[e.Index] == e.Value {
				t.Fatalf("step %d (%s) eliminated the solution digit %d from %s: %s",
					n, s.Name, e.Value, logic.CellName(e.Index), s.Description)
			}
		}
		if s.Index < 0 && len(s.Eliminations) == 0 {
			t.Fatalf("step %d (%s) made no progress", n, s.Name)
		}
	}
	if res.Solved && !board.BoardsEqual(res.Board, solution) {
		t.Fatalf("logic solution differs from backtracking solution")
	}
}

func TestSolvesEasyPuzzleWithSingles(t *testing.T) {
	p := parse(t, "530070000600195000098000060800060003400803001700020006060000280000419005000080079")
	res := logic.Solve(p)
	if !res.Solved {
		t.Fatal("expected an easy puzzle to be solved")
	}
	if res.Level() > logic.LevelMedium {
		t.Fatalf("expected singles only, hardest was %s", res.Hardest)
	}
	checkSound(t, p, res)
}

func TestRejectsContradictoryGivens(t *testing.T) {
	p := parse(t, "550070000600195000098000060800060003400803001700020006060000280000419005000080079")
	if logic.Solve(p).Solved {
		t.Fatal("expected contradictory puzzle to be unsolved")
	}
}

func TestNextStepExplainsAPlacement(t *testing.T) {
	p := parse(t, "530070000600195000098000060800060003400803001700020006060000280000419005000080079")
	s, ok := logic.NextStep(p)
	if !ok || s.Index < 0 || s.Value == 0 || s.Description == "" || s.Name == "" {
		t.Fatalf("expected an explained placement, got %+v", s)
	}
}

// TestStepsAreSound runs the solver over many maximally carved puzzles, which
// exercise the advanced techniques, and checks every deduction.
func TestStepsAreSound(t *testing.T) {
	used := map[logic.Technique]int{}
	n := 40
	if testing.Short() {
		n = 20
	}
	for i := 0; i < n; i++ {
		g := generator.GeneratePuzzleRecord(generator.Expert)
		// Re-carve fully, ignoring the technique budget, to reach puzzles
		// that need techniques beyond the ones implemented.
		p := make(board.Board, 81)
		copy(p, g.Puzzle)
		for idx := range p {
			if p[idx] == 0 {
				continue
			}
			v := p[idx]
			p[idx] = 0
			if board.CountSolutions(p, 2) != 1 {
				p[idx] = v
			}
		}
		for _, puzzle := range []board.Board{g.Puzzle, p} {
			res := logic.Solve(puzzle)
			checkSound(t, puzzle, res)
			for _, s := range res.Steps {
				used[s.Technique]++
			}
		}
	}
	t.Logf("technique usage: %v", used)
}

// A minimal puzzle whose logical path includes a Swordfish.
func TestSwordfishIsFoundAndSound(t *testing.T) {
	p := parse(t, "090000800801500006004320000008600040000000509010700023000000460080070002005000300")
	res := logic.Solve(p)
	checkSound(t, p, res)
	for _, s := range res.Steps {
		if s.Technique == logic.Swordfish {
			return
		}
	}
	t.Fatal("expected a Swordfish step")
}

func TestExplainCell(t *testing.T) {
	p := parse(t, "530070000600195000098000060800060003400803001700020006060000280000419005000080079")
	solution, _ := board.Solve(p)
	step, ok := logic.NextStep(p)
	if !ok || step.Index < 0 {
		t.Fatal("expected a placement")
	}
	got, ok := logic.ExplainCell(p, step.Index)
	if !ok || got.Value != solution[step.Index] || got.Description == "" {
		t.Fatalf("expected an explanation for %s, got %+v", logic.CellName(step.Index), got)
	}
	if _, ok := logic.ExplainCell(p, 0); ok {
		t.Fatal("a filled cell has nothing to explain")
	}
}
