package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/chiragbaral/sudoku/backend-go/board"
	"github.com/chiragbaral/sudoku/backend-go/generator"
	"github.com/chiragbaral/sudoku/backend-go/storage"
)

const dateLayout = "2006-01-02"

type puzzleResponse struct {
	Puzzle     string `json:"puzzle"`
	Solution   string `json:"solution"`
	Difficulty string `json:"difficulty"`
	Date       string `json:"date,omitempty"`
	IsDaily    bool   `json:"isDaily,omitempty"`
}

func startServer(port int) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", handleAPI)
	mux.Handle("/", frontendHandler())

	addr := ":" + strconv.Itoa(port)
	log.Printf("starting server on %s", addr)
	log.Printf("puzzle store: %s", storage.DefaultPath())
	log.Fatal(http.ListenAndServe(addr, withLogging(mux)))
}

// handleAPI routes all /api/* requests by path suffix.
func handleAPI(w http.ResponseWriter, r *http.Request) {
	setCORS(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	switch strings.TrimSuffix(r.URL.Path, "/") {
	case "/api/health":
		handleHealth(w, r)
	case "/api/puzzle":
		requireMethod(w, r, http.MethodGet, handlePuzzle)
	case "/api/puzzle/daily":
		requireMethod(w, r, http.MethodGet, handleDaily)
	case "/api/puzzle/validate":
		requireMethod(w, r, http.MethodPost, handleValidate)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

// frontendHandler serves the static frontend when it is available next to the
// backend source tree, so the whole platform runs from a single origin.
func frontendHandler() http.Handler {
	dir := staticFrontendDir()
	if dir == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprintf(w, "<h1>Sudoku API</h1><p>Backend is running. API endpoints live under <code>/api/</code>. Serve the frontend from the repo checkout, or set <code>SUDOKU_STATIC_DIR</code>.</p>")
		})
	}
	log.Printf("serving frontend from %s", dir)
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		// Fall back to index.html so the frontend can own non-file routes.
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}

// staticFrontendDir resolves the sibling frontend directory. Override with
// SUDOKU_STATIC_DIR when the frontend lives elsewhere.
func staticFrontendDir() string {
	if override := os.Getenv("SUDOKU_STATIC_DIR"); override != "" {
		return override
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return ""
	}
	candidate := filepath.Join(filepath.Dir(file), "..", "frontend")
	if st, err := os.Stat(candidate); err == nil && st.IsDir() {
		return candidate
	}
	return ""
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handlePuzzle(w http.ResponseWriter, r *http.Request) {
	difficulty := r.URL.Query().Get("difficulty")
	if difficulty == "" {
		difficulty = "medium"
	}
	if _, err := parseDifficulty(difficulty); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := storage.List()
	if err == nil && len(records) > 0 {
		var candidates []storage.PuzzleRecord
		for _, rec := range records {
			if strings.EqualFold(rec.Difficulty, difficulty) && !rec.IsDaily {
				candidates = append(candidates, rec)
			}
		}
		if len(candidates) == 0 { // fall back to any record of that difficulty
			for _, rec := range records {
				if strings.EqualFold(rec.Difficulty, difficulty) {
					candidates = append(candidates, rec)
				}
			}
		}
		if len(candidates) > 0 {
			pick := candidates[rand.Intn(len(candidates))]
			resp := puzzleResponse{Puzzle: pick.Puzzle, Solution: pick.Solution, Difficulty: pick.Difficulty}
			writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	// Fallback: generate on the fly (does not persist — avoids pool pollution).
	diff, _ := parseDifficulty(difficulty)
	gen := generator.GeneratePuzzleRecord(diff)
	resp := puzzleResponse{Puzzle: boardToString(gen.Puzzle), Solution: boardToString(gen.Solution), Difficulty: strings.ToLower(difficulty)}
	writeJSON(w, http.StatusOK, resp)
}

// handleDaily serves the deterministic daily puzzle for a given date
// (defaults to today, UTC) and difficulty (defaults to medium). The puzzle is
// picked from the non-daily pool seeded by the date, so everyone sees the
// same puzzle all day and it does not repeat across days until the pool is
// exhausted. The selection is stored as a daily record for later lookup.
func handleDaily(w http.ResponseWriter, r *http.Request) {
	difficulty := r.URL.Query().Get("difficulty")

	date := r.URL.Query().Get("date")
	if date == "" {
		date = time.Now().UTC().Format(dateLayout)
	}
	parsedDate, err := time.Parse(dateLayout, date)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid date, want YYYY-MM-DD"})
		return
	}

	// No difficulty requested: rotate through the levels by day so the daily
	// challenge stays varied while remaining identical for everyone that day.
	if difficulty == "" {
		levels := []string{"easy", "medium", "hard", "expert"}
		dayIndex := int(parsedDate.Unix() / 86400)
		difficulty = levels[((dayIndex%len(levels))+len(levels))%len(levels)]
	}
	if _, err := parseDifficulty(difficulty); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := storage.List()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to read puzzle store"})
		return
	}

	// A daily puzzle already assigned for this date wins.
	for _, rec := range records {
		if rec.IsDaily && rec.Date == date && strings.EqualFold(rec.Difficulty, difficulty) {
			resp := puzzleResponse{Puzzle: rec.Puzzle, Solution: rec.Solution, Difficulty: rec.Difficulty, Date: rec.Date, IsDaily: true}
			writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	// Collect the non-daily pool for this difficulty, and remember every
	// puzzle string that has already been used as a daily challenge.
	var pool []storage.PuzzleRecord
	usedAsDaily := map[string]bool{}
	for _, rec := range records {
		if rec.IsDaily {
			usedAsDaily[rec.Puzzle] = true
		} else if strings.EqualFold(rec.Difficulty, difficulty) {
			pool = append(pool, rec)
		}
	}

	// Deterministically index into the pool from the date.
	seed := hashString(date + ":" + strings.ToLower(difficulty))

	var chosen *storage.PuzzleRecord
	if len(pool) > 0 {
		start := seed % uint64(len(pool))
		for i := 0; i < len(pool); i++ {
			cand := pool[(int(start)+i)%len(pool)]
			if !usedAsDaily[cand.Puzzle] {
				c := cand
				chosen = &c
				break
			}
		}
		if chosen == nil { // entire pool has been a daily already — reuse oldest pick
			c := pool[int(start)%len(pool)]
			chosen = &c
		}
	}

	if chosen == nil { // empty pool: generate one and save it so today stays stable
		diff, _ := parseDifficulty(difficulty)
		gen := generator.GeneratePuzzleRecord(diff)
		chosen = &storage.PuzzleRecord{
			Difficulty: strings.ToLower(difficulty),
			Puzzle:     boardToString(gen.Puzzle),
			Solution:   boardToString(gen.Solution),
		}
	}

	daily := storage.PuzzleRecord{
		Difficulty: chosen.Difficulty,
		Puzzle:     chosen.Puzzle,
		Solution:   chosen.Solution,
		CreatedAt:  time.Now().UTC(),
		IsDaily:    true,
		Date:       date,
	}
	if err := storage.Save(daily); err != nil {
		log.Printf("warning: failed to persist daily puzzle: %v", err)
	}

	resp := puzzleResponse{Puzzle: daily.Puzzle, Solution: daily.Solution, Difficulty: daily.Difficulty, Date: daily.Date, IsDaily: true}
	writeJSON(w, http.StatusOK, resp)
}

func hashString(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

// validateRequest carries the puzzle plus the player's filled-in board.
type validateRequest struct {
	Puzzle string `json:"puzzle"`
	Board  string `json:"board"`
}

// handleValidate checks a fully filled board against the puzzle's unique
// solution. It reports how many cells are still empty, how many are wrong,
// and whether the board is complete and correct.
func handleValidate(w http.ResponseWriter, r *http.Request) {
	var req validateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	defer r.Body.Close()

	puzzle, err := parseBoard(req.Puzzle)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid puzzle: " + err.Error()})
		return
	}
	boardIn, err := parseBoard(req.Board)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid board: " + err.Error()})
		return
	}

	solution, ok := board.Solve(puzzle)
	if !ok {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "puzzle has no solution"})
		return
	}

	empty, wrong := 0, 0
	for i := range solution {
		if boardIn[i] == 0 {
			empty++
		} else if boardIn[i] != solution[i] {
			wrong++
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"complete":   empty == 0 && wrong == 0,
		"emptyCells": empty,
		"wrongCells": wrong,
		"solution":   boardToString(solution),
		"isDaily":    false,
	})
}

// ---- shared helpers ----

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string, next http.HandlerFunc) {
	if r.Method != method {
		w.Header().Set("Allow", method)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	next(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("warning: failed to encode response: %v", err)
	}
}

// withLogging logs each request with its method, path, status and duration.
func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// boardToString formats a board as an 81-character digit string.
func boardToString(b board.Board) string {
	var sb strings.Builder
	sb.Grow(len(b))
	for _, v := range b {
		sb.WriteByte(byte('0' + v))
	}
	return sb.String()
}
