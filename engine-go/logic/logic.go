// Package logic solves Sudoku the way a person does: by repeatedly applying
// the simplest human technique that makes progress, never guessing.
//
// The hardest technique a puzzle requires is a far better difficulty measure
// than its clue count — a 24-clue puzzle can need nothing but singles, while a
// 28-clue puzzle can demand an X-Wing. The generator uses Grade to label
// puzzles, and each Step carries enough detail to explain a hint to a player.
package logic

import (
	"fmt"
	"math/bits"
	"strings"

	"github.com/baralchirag/sudoku/engine-go/board"
)

// Technique is a human solving technique, ordered from simplest to hardest.
type Technique int

const (
	HiddenSingle Technique = iota
	NakedSingle
	LockedCandidates
	NakedPair
	HiddenPair
	NakedTriple
	HiddenTriple
	XWing
	XYWing
	Swordfish
)

var techniqueNames = [...]string{
	HiddenSingle:     "Hidden Single",
	NakedSingle:      "Naked Single",
	LockedCandidates: "Locked Candidates",
	NakedPair:        "Naked Pair",
	HiddenPair:       "Hidden Pair",
	NakedTriple:      "Naked Triple",
	HiddenTriple:     "Hidden Triple",
	XWing:            "X-Wing",
	XYWing:           "XY-Wing",
	Swordfish:        "Swordfish",
}

func (t Technique) String() string {
	if t >= 0 && int(t) < len(techniqueNames) {
		return techniqueNames[t]
	}
	return fmt.Sprintf("Technique(%d)", int(t))
}

// Difficulty levels a technique maps to. They line up with generator.Difficulty.
const (
	LevelEasy = iota
	LevelMedium
	LevelHard
	LevelExpert
)

// Level is the difficulty tier a technique belongs to:
//   - Easy:   hidden singles only
//   - Medium: naked singles
//   - Hard:   locked candidates, naked/hidden pairs and triples
//   - Expert: X-Wing, XY-Wing, Swordfish
func (t Technique) Level() int {
	switch {
	case t <= HiddenSingle:
		return LevelEasy
	case t == NakedSingle:
		return LevelMedium
	case t <= HiddenTriple:
		return LevelHard
	default:
		return LevelExpert
	}
}

// Elimination removes candidate Value from cell Index.
type Elimination struct {
	Index int `json:"index"`
	Value int `json:"value"`
}

// Step is one deduction. A placement sets Value at Index; otherwise Index is
// -1 and the step only eliminates candidates. Cells lists the cells forming
// the pattern, so a UI can highlight why the deduction holds.
type Step struct {
	Technique    Technique     `json:"-"`
	Name         string        `json:"technique"`
	Index        int           `json:"index"`
	Value        int           `json:"value,omitempty"`
	Eliminations []Elimination `json:"eliminations,omitempty"`
	Cells        []int         `json:"cells,omitempty"`
	Description  string        `json:"description"`
}

// Result is the outcome of solving a puzzle logically.
type Result struct {
	// Solved is false when the techniques run out before the grid is full
	// (the puzzle would need guessing or a technique not implemented here),
	// or when the puzzle is contradictory.
	Solved bool
	// Hardest is the most advanced technique used. Meaningless when no step
	// was taken.
	Hardest Technique
	Steps   []Step
	// Board is the grid as far as logic got.
	Board board.Board
}

// Level is the difficulty tier of the hardest technique used.
func (r Result) Level() int {
	if len(r.Steps) == 0 {
		return LevelEasy
	}
	return r.Hardest.Level()
}

// ---- static geometry ----

var (
	units     [27][9]int // 0-8 rows, 9-17 columns, 18-26 boxes
	cellUnits [81][3]int // row, column, box unit for each cell
	peers     [81][20]int
	isPeer    [81][81]bool
)

func init() {
	for i := 0; i < 9; i++ {
		for j := 0; j < 9; j++ {
			units[i][j] = i*9 + j
			units[9+i][j] = j*9 + i
			br, bc := (i/3)*3, (i%3)*3
			units[18+i][j] = (br+j/3)*9 + bc + j%3
		}
	}
	for c := 0; c < 81; c++ {
		r, col := c/9, c%9
		cellUnits[c] = [3]int{r, 9 + col, 18 + (r/3)*3 + col/3}
		n := 0
		for _, u := range cellUnits[c] {
			for _, p := range units[u] {
				if p != c && !isPeer[c][p] {
					isPeer[c][p] = true
					peers[c][n] = p
					n++
				}
			}
		}
	}
}

func unitName(u int) string {
	switch {
	case u < 9:
		return fmt.Sprintf("row %d", u+1)
	case u < 18:
		return fmt.Sprintf("column %d", u-8)
	default:
		return fmt.Sprintf("box %d", u-17)
	}
}

// CellName formats a cell index as r<row>c<col>, 1-based.
func CellName(i int) string { return fmt.Sprintf("r%dc%d", i/9+1, i%9+1) }

func cellList(cells []int) string {
	names := make([]string, len(cells))
	for i, c := range cells {
		names[i] = CellName(c)
	}
	return strings.Join(names, ", ")
}

func digitList(mask uint16) string {
	var parts []string
	for v := 1; v <= 9; v++ {
		if mask&(1<<v) != 0 {
			parts = append(parts, fmt.Sprint(v))
		}
	}
	return strings.Join(parts, "/")
}

// ---- grid state ----

type grid struct {
	vals [81]int
	cand [81]uint16 // bit v set when v is still possible
}

const allDigits uint16 = 0x3FE // bits 1..9

func newGrid(b board.Board) (*grid, bool) {
	g := &grid{}
	for i := range g.cand {
		g.cand[i] = allDigits
	}
	for i, v := range b {
		if v == 0 {
			continue
		}
		if g.cand[i]&(1<<v) == 0 {
			return nil, false // given conflicts with another given
		}
		g.place(i, v)
	}
	return g, true
}

func (g *grid) place(i, v int) {
	g.vals[i] = v
	g.cand[i] = 0
	for _, p := range peers[i] {
		g.cand[p] &^= 1 << v
	}
}

func (g *grid) apply(s Step) {
	if s.Index >= 0 {
		g.place(s.Index, s.Value)
	}
	for _, e := range s.Eliminations {
		g.cand[e.Index] &^= 1 << e.Value
	}
}

func (g *grid) filled() bool {
	for _, v := range g.vals {
		if v == 0 {
			return false
		}
	}
	return true
}

// broken reports an empty cell with no candidates, or a unit where some
// missing digit has nowhere to go.
func (g *grid) broken() bool {
	for i := 0; i < 81; i++ {
		if g.vals[i] == 0 && g.cand[i] == 0 {
			return true
		}
	}
	for u := 0; u < 27; u++ {
		var seen uint16
		for _, c := range units[u] {
			if g.vals[c] != 0 {
				seen |= 1 << g.vals[c]
			} else {
				seen |= g.cand[c]
			}
		}
		if seen != allDigits {
			return true
		}
	}
	return false
}

func (g *grid) board() board.Board {
	b := board.New()
	copy(b, g.vals[:])
	return b
}

// positions returns the empty cells in unit u that can still hold v.
func (g *grid) positions(u, v int) []int {
	var out []int
	for _, c := range units[u] {
		if g.vals[c] == 0 && g.cand[c]&(1<<v) != 0 {
			out = append(out, c)
		}
	}
	return out
}

// ---- solving ----

type finder func(*grid) (Step, bool)

// finders in the order a person would try them.
var finders = []finder{
	findHiddenSingle,
	findNakedSingle,
	findLockedCandidates,
	func(g *grid) (Step, bool) { return findNakedSubset(g, 2) },
	func(g *grid) (Step, bool) { return findHiddenSubset(g, 2) },
	func(g *grid) (Step, bool) { return findNakedSubset(g, 3) },
	func(g *grid) (Step, bool) { return findHiddenSubset(g, 3) },
	func(g *grid) (Step, bool) { return findFish(g, 2) },
	findXYWing,
	func(g *grid) (Step, bool) { return findFish(g, 3) },
}

// Solve applies techniques until the grid is full or nothing applies.
func Solve(b board.Board) Result {
	g, ok := newGrid(b)
	if !ok {
		return Result{Board: board.New()}
	}
	res := Result{}
	for !g.filled() {
		if g.broken() {
			res.Board = g.board()
			return res
		}
		step, found := nextStep(g)
		if !found {
			break
		}
		if len(res.Steps) == 0 || step.Technique > res.Hardest {
			res.Hardest = step.Technique
		}
		res.Steps = append(res.Steps, step)
		g.apply(step)
	}
	res.Solved = g.filled()
	res.Board = g.board()
	return res
}

// NextStep returns the simplest deduction available on b, computing
// candidates from the placed digits only.
func NextStep(b board.Board) (Step, bool) {
	g, ok := newGrid(b)
	if !ok || g.broken() {
		return Step{}, false
	}
	return nextStep(g)
}

// ExplainCell returns a single (hidden or naked) that places a digit in cell
// idx on board b right now, if one exists. Used to explain a hint the player
// asked for on a specific cell.
func ExplainCell(b board.Board, idx int) (Step, bool) {
	if idx < 0 || idx >= 81 || b[idx] != 0 {
		return Step{}, false
	}
	g, ok := newGrid(b)
	if !ok {
		return Step{}, false
	}
	for _, u := range []int{cellUnits[idx][2], cellUnits[idx][0], cellUnits[idx][1]} {
		for v := 1; v <= 9; v++ {
			if pos := g.positions(u, v); len(pos) == 1 && pos[0] == idx {
				return Step{
					Technique: HiddenSingle, Name: HiddenSingle.String(), Index: idx, Value: v, Cells: units[u][:],
					Description: fmt.Sprintf("%d can only go in %s within %s.", v, CellName(idx), unitName(u)),
				}, true
			}
		}
	}
	if bits.OnesCount16(g.cand[idx]) == 1 {
		v := bits.TrailingZeros16(g.cand[idx])
		return Step{
			Technique: NakedSingle, Name: NakedSingle.String(), Index: idx, Value: v, Cells: peers[idx][:],
			Description: fmt.Sprintf("%s sees every digit except %d, so it must be %d.", CellName(idx), v, v),
		}, true
	}
	return Step{}, false
}

func nextStep(g *grid) (Step, bool) {
	for _, f := range finders {
		if s, ok := f(g); ok {
			s.Name = s.Technique.String()
			return s, true
		}
	}
	return Step{}, false
}

// ---- techniques ----

// unitOrder checks boxes first: a hidden single in a box is the easiest
// thing for a person to spot.
var unitOrder = func() []int {
	out := make([]int, 0, 27)
	for u := 18; u < 27; u++ {
		out = append(out, u)
	}
	for u := 0; u < 18; u++ {
		out = append(out, u)
	}
	return out
}()

func findHiddenSingle(g *grid) (Step, bool) {
	for _, u := range unitOrder {
		for v := 1; v <= 9; v++ {
			pos := g.positions(u, v)
			if len(pos) == 1 {
				return Step{
					Technique:   HiddenSingle,
					Index:       pos[0],
					Value:       v,
					Cells:       units[u][:],
					Description: fmt.Sprintf("%d can only go in %s within %s.", v, CellName(pos[0]), unitName(u)),
				}, true
			}
		}
	}
	return Step{}, false
}

func findNakedSingle(g *grid) (Step, bool) {
	for i := 0; i < 81; i++ {
		if g.vals[i] == 0 && bits.OnesCount16(g.cand[i]) == 1 {
			v := bits.TrailingZeros16(g.cand[i])
			return Step{
				Technique:   NakedSingle,
				Index:       i,
				Value:       v,
				Cells:       peers[i][:],
				Description: fmt.Sprintf("%s sees every digit except %d, so it must be %d.", CellName(i), v, v),
			}, true
		}
	}
	return Step{}, false
}

// findLockedCandidates covers pointing (a digit confined to one line inside a
// box clears that line outside the box) and claiming (a digit confined to one
// box inside a line clears that box outside the line).
func findLockedCandidates(g *grid) (Step, bool) {
	for v := 1; v <= 9; v++ {
		// Pointing.
		for b := 18; b < 27; b++ {
			pos := g.positions(b, v)
			if len(pos) < 2 {
				continue
			}
			for _, line := range []int{cellUnits[pos[0]][0], cellUnits[pos[0]][1]} {
				if !allInUnit(pos, line) {
					continue
				}
				if elims := g.eliminateFrom(units[line][:], v, pos); len(elims) > 0 {
					return Step{
						Technique:    LockedCandidates,
						Index:        -1,
						Eliminations: elims,
						Cells:        pos,
						Description: fmt.Sprintf("In %s, %d is confined to %s, so it can be removed from the rest of %s.",
							unitName(b), v, unitName(line), unitName(line)),
					}, true
				}
			}
		}
		// Claiming.
		for line := 0; line < 18; line++ {
			pos := g.positions(line, v)
			if len(pos) < 2 {
				continue
			}
			b := cellUnits[pos[0]][2]
			if !allInUnit(pos, b) {
				continue
			}
			if elims := g.eliminateFrom(units[b][:], v, pos); len(elims) > 0 {
				return Step{
					Technique:    LockedCandidates,
					Index:        -1,
					Eliminations: elims,
					Cells:        pos,
					Description: fmt.Sprintf("In %s, %d is confined to %s, so it can be removed from the rest of %s.",
						unitName(line), v, unitName(b), unitName(b)),
				}, true
			}
		}
	}
	return Step{}, false
}

func allInUnit(cells []int, u int) bool {
	for _, c := range cells {
		in := false
		for _, cu := range cellUnits[c] {
			if cu == u {
				in = true
				break
			}
		}
		if !in {
			return false
		}
	}
	return true
}

// eliminateFrom lists removals of v from the empty cells in scope, skipping
// the pattern cells in keep.
func (g *grid) eliminateFrom(scope []int, v int, keep []int) []Elimination {
	var out []Elimination
	for _, c := range scope {
		if g.vals[c] != 0 || g.cand[c]&(1<<v) == 0 || contains(keep, c) {
			continue
		}
		out = append(out, Elimination{Index: c, Value: v})
	}
	return out
}

func contains(xs []int, x int) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// combinations calls fn with every k-sized subset of items, stopping when fn
// returns true.
func combinations(items []int, k int, fn func([]int) bool) bool {
	pick := make([]int, k)
	var rec func(start, depth int) bool
	rec = func(start, depth int) bool {
		if depth == k {
			return fn(pick)
		}
		for i := start; i <= len(items)-(k-depth); i++ {
			pick[depth] = items[i]
			if rec(i+1, depth+1) {
				return true
			}
		}
		return false
	}
	return rec(0, 0)
}

func subsetTechnique(naked bool, n int) Technique {
	switch {
	case naked && n == 2:
		return NakedPair
	case naked:
		return NakedTriple
	case n == 2:
		return HiddenPair
	default:
		return HiddenTriple
	}
}

// findNakedSubset: n cells in a unit whose candidates together are exactly n
// digits — those digits can be removed from the rest of the unit.
func findNakedSubset(g *grid, n int) (Step, bool) {
	var step Step
	found := false
	for _, u := range unitOrder {
		var cells []int
		for _, c := range units[u] {
			if g.vals[c] == 0 {
				if k := bits.OnesCount16(g.cand[c]); k >= 2 && k <= n {
					cells = append(cells, c)
				}
			}
		}
		if len(cells) < n {
			continue
		}
		found = combinations(cells, n, func(pick []int) bool {
			var union uint16
			for _, c := range pick {
				union |= g.cand[c]
			}
			if bits.OnesCount16(union) != n {
				return false
			}
			var elims []Elimination
			for v := 1; v <= 9; v++ {
				if union&(1<<v) != 0 {
					elims = append(elims, g.eliminateFrom(units[u][:], v, pick)...)
				}
			}
			if len(elims) == 0 {
				return false
			}
			pattern := append([]int(nil), pick...)
			step = Step{
				Technique:    subsetTechnique(true, n),
				Index:        -1,
				Eliminations: elims,
				Cells:        pattern,
				Description: fmt.Sprintf("%s in %s can only hold %s, so those digits can be removed from the rest of %s.",
					cellList(pattern), unitName(u), digitList(union), unitName(u)),
			}
			return true
		})
		if found {
			return step, true
		}
	}
	return Step{}, false
}

// findHiddenSubset: n digits that, within a unit, fit only in the same n
// cells — every other candidate can be removed from those cells.
func findHiddenSubset(g *grid, n int) (Step, bool) {
	var step Step
	found := false
	for _, u := range unitOrder {
		var digits []int
		posMask := map[int]uint{}
		for v := 1; v <= 9; v++ {
			pos := g.positions(u, v)
			if len(pos) >= 2 && len(pos) <= n {
				digits = append(digits, v)
				posMask[v] = cellMask(u, pos)
			}
		}
		if len(digits) < n {
			continue
		}
		found = combinations(digits, n, func(pick []int) bool {
			var cellsMask uint
			var digitMask uint16
			for _, v := range pick {
				cellsMask |= posMask[v]
				digitMask |= 1 << v
			}
			if bits.OnesCount(cellsMask) != n {
				return false
			}
			var cells []int
			for j, c := range units[u] {
				if cellsMask&(1<<uint(j)) != 0 {
					cells = append(cells, c)
				}
			}
			var elims []Elimination
			for _, c := range cells {
				extra := g.cand[c] &^ digitMask
				for v := 1; v <= 9; v++ {
					if extra&(1<<v) != 0 {
						elims = append(elims, Elimination{Index: c, Value: v})
					}
				}
			}
			if len(elims) == 0 {
				return false
			}
			step = Step{
				Technique:    subsetTechnique(false, n),
				Index:        -1,
				Eliminations: elims,
				Cells:        cells,
				Description: fmt.Sprintf("In %s, %s fit only in %s, so other candidates can be removed from those cells.",
					unitName(u), digitList(digitMask), cellList(cells)),
			}
			return true
		})
		if found {
			return step, true
		}
	}
	return Step{}, false
}

// cellMask encodes cells by their position (0-8) inside unit u.
func cellMask(u int, cells []int) uint {
	var m uint
	for j, c := range units[u] {
		if contains(cells, c) {
			m |= 1 << uint(j)
		}
	}
	return m
}

// findFish finds X-Wings (n=2) and Swordfish (n=3): if digit v's candidates in
// n rows all fall within the same n columns, v can be removed from those
// columns in every other row (and the same with rows and columns swapped).
func findFish(g *grid, n int) (Step, bool) {
	tech := XWing
	if n == 3 {
		tech = Swordfish
	}
	for v := 1; v <= 9; v++ {
		for _, orient := range []struct {
			base, cover int // unit offsets: rows=0, columns=9
			baseName    string
		}{{0, 9, "rows"}, {9, 0, "columns"}} {
			var bases []int
			masks := map[int]uint{}
			for b := 0; b < 9; b++ {
				pos := g.positions(orient.base+b, v)
				if len(pos) >= 2 && len(pos) <= n {
					bases = append(bases, b)
					masks[b] = cellMask(orient.base+b, pos)
				}
			}
			if len(bases) < n {
				continue
			}
			var step Step
			found := combinations(bases, n, func(pick []int) bool {
				var cover uint
				for _, b := range pick {
					cover |= masks[b]
				}
				if bits.OnesCount(cover) != n {
					return false
				}
				var pattern []int
				for _, b := range pick {
					pattern = append(pattern, g.positions(orient.base+b, v)...)
				}
				var elims []Elimination
				var coverNames []string
				for j := 0; j < 9; j++ {
					if cover&(1<<uint(j)) == 0 {
						continue
					}
					coverNames = append(coverNames, fmt.Sprint(j+1))
					elims = append(elims, g.eliminateFrom(units[orient.cover+j][:], v, pattern)...)
				}
				if len(elims) == 0 {
					return false
				}
				baseNames := make([]string, len(pick))
				for i, b := range pick {
					baseNames[i] = fmt.Sprint(b + 1)
				}
				coverKind := "columns"
				if orient.cover == 0 {
					coverKind = "rows"
				}
				step = Step{
					Technique:    tech,
					Index:        -1,
					Eliminations: elims,
					Cells:        pattern,
					Description: fmt.Sprintf("In %s %s, digit %d only appears in %s %s, so it can be removed from the rest of those %s.",
						orient.baseName, strings.Join(baseNames, ", "), v, coverKind, strings.Join(coverNames, ", "), coverKind),
				}
				return true
			})
			if found {
				return step, true
			}
		}
	}
	return Step{}, false
}

// findXYWing: a pivot with candidates {x,y} sees a pincer {x,z} and a pincer
// {y,z}. Whichever value the pivot takes, one pincer becomes z, so z can be
// removed from every cell that sees both pincers.
func findXYWing(g *grid) (Step, bool) {
	for pivot := 0; pivot < 81; pivot++ {
		pc := g.cand[pivot]
		if g.vals[pivot] != 0 || bits.OnesCount16(pc) != 2 {
			continue
		}
		var wings []int
		for _, p := range peers[pivot] {
			c := g.cand[p]
			if g.vals[p] == 0 && bits.OnesCount16(c) == 2 && c != pc && bits.OnesCount16(c&pc) == 1 {
				wings = append(wings, p)
			}
		}
		for i := 0; i < len(wings); i++ {
			for j := i + 1; j < len(wings); j++ {
				a, b := wings[i], wings[j]
				ca, cb := g.cand[a], g.cand[b]
				z := ca & cb &^ pc
				// The pincers must share z and together cover both pivot digits.
				if bits.OnesCount16(z) != 1 || (ca|cb)&pc != pc {
					continue
				}
				zv := bits.TrailingZeros16(z)
				var elims []Elimination
				for c := 0; c < 81; c++ {
					if c == a || c == b || c == pivot || !isPeer[a][c] || !isPeer[b][c] {
						continue
					}
					if g.vals[c] == 0 && g.cand[c]&z != 0 {
						elims = append(elims, Elimination{Index: c, Value: zv})
					}
				}
				if len(elims) == 0 {
					continue
				}
				return Step{
					Technique:    XYWing,
					Index:        -1,
					Eliminations: elims,
					Cells:        []int{pivot, a, b},
					Description: fmt.Sprintf("Pivot %s (%s) with pincers %s (%s) and %s (%s): one pincer must be %d, so %d can be removed from cells that see both.",
						CellName(pivot), digitList(pc), CellName(a), digitList(ca), CellName(b), digitList(cb), zv, zv),
				}, true
			}
		}
	}
	return Step{}, false
}
