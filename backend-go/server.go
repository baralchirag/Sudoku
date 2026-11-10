package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/chiragbaral/sudoku/backend-go/board"
	"github.com/chiragbaral/sudoku/backend-go/generator"
	"github.com/chiragbaral/sudoku/backend-go/logic"
	"github.com/chiragbaral/sudoku/backend-go/storage"
)

const dateLayout = "2006-01-02"

// puzzleResponse is what the client receives for a puzzle. It deliberately
// carries no solution: the server checks moves (/validate) and reveals cells
// (/hint), so the answer never sits in the browser.
type puzzleResponse struct {
	Puzzle     string `json:"puzzle"`
	Difficulty string `json:"difficulty"`
	Technique  string `json:"technique,omitempty"`
	Date       string `json:"date,omitempty"`
	IsDaily    bool   `json:"isDaily,omitempty"`
}

func recordResponse(rec storage.PuzzleRecord) puzzleResponse {
	return puzzleResponse{
		Puzzle:     rec.Puzzle,
		Difficulty: rec.Difficulty,
		Technique:  rec.Technique,
		Date:       rec.Date,
		IsDaily:    rec.IsDaily,
	}
}

// maxBodyBytes caps POST bodies; a request only ever carries two 81-char
// boards and an index.
const maxBodyBytes = 4 << 10

// nowFunc is the clock, swappable in tests.
var nowFunc = time.Now

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
	case "/api/puzzle/hint":
		requireMethod(w, r, http.MethodPost, handleHint)
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
	difficulty := strings.ToLower(r.URL.Query().Get("difficulty"))
	if difficulty == "" {
		difficulty = "medium"
	}
	diff, err := parseDifficulty(difficulty)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	rec, ok, err := storage.Random(difficulty)
	if err != nil {
		log.Printf("error: reading puzzle store: %v", err)
	}
	if ok {
		resp := recordResponse(rec)
		resp.Date, resp.IsDaily = "", false
		writeJSON(w, http.StatusOK, resp)
		return
	}

	// Empty pool: generate on the fly. Not persisted, to keep the pool
	// curated; /validate and /hint re-solve unknown puzzles.
	gen := generator.GeneratePuzzleRecord(diff)
	writeJSON(w, http.StatusOK, puzzleResponse{
		Puzzle:     boardToString(gen.Puzzle),
		Difficulty: difficulty,
		Technique:  gen.Technique.String(),
	})
}

// dailyLevels is the order the daily challenge rotates through.
var dailyLevels = []string{"easy", "medium", "hard", "expert"}

// handleDaily serves the daily puzzle for a date (default: today, UTC).
//
// Players are in every timezone, so "today" spans yesterday through tomorrow
// in UTC; dates in that window get a puzzle assigned on first request. Later
// dates are refused so nobody can preview upcoming challenges, and earlier
// dates are served only if they were assigned at the time — otherwise any
// client could grow the store by walking the calendar.
//
// The puzzle is picked from the pool deterministically from the date, skipping
// puzzles already used as a daily, and stored so it stays fixed all day.
func handleDaily(w http.ResponseWriter, r *http.Request) {
	difficulty := strings.ToLower(r.URL.Query().Get("difficulty"))

	today := nowFunc().UTC().Truncate(24 * time.Hour)
	date := r.URL.Query().Get("date")
	if date == "" {
		date = today.Format(dateLayout)
	}
	parsedDate, err := time.Parse(dateLayout, date)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid date, want YYYY-MM-DD"})
		return
	}
	date = parsedDate.Format(dateLayout) // canonical form

	if difficulty == "" {
		dayIndex := int(parsedDate.Unix() / 86400)
		difficulty = dailyLevels[((dayIndex%len(dailyLevels))+len(dailyLevels))%len(dailyLevels)]
	}
	diff, err := parseDifficulty(difficulty)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	daysFromToday := int(parsedDate.Sub(today).Hours() / 24)
	if daysFromToday > 1 {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "the daily puzzle for " + date + " is not available yet"})
		return
	}

	if rec, ok, err := storage.Daily(date, difficulty); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to read puzzle store"})
		return
	} else if ok {
		writeJSON(w, http.StatusOK, recordResponse(rec))
		return
	}

	if daysFromToday < -1 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no daily puzzle was played on " + date})
		return
	}

	pool, err := storage.Pool(difficulty)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to read puzzle store"})
		return
	}

	var chosen storage.PuzzleRecord
	if len(pool) > 0 {
		start := int(hashString(date+":"+difficulty) % uint64(len(pool)))
		chosen = pool[start] // reused if every puzzle has already been a daily
		for i := 0; i < len(pool); i++ {
			cand := pool[(start+i)%len(pool)]
			used, err := storage.UsedAsDaily(cand.Puzzle)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to read puzzle store"})
				return
			}
			if !used {
				chosen = cand
				break
			}
		}
	} else {
		gen := generator.GeneratePuzzleRecord(diff)
		chosen = storage.NewPuzzleRecord(difficulty, gen.Puzzle, gen.Solution)
		chosen.Technique = gen.Technique.String()
	}

	daily, err := storage.SaveDaily(storage.PuzzleRecord{
		Difficulty: chosen.Difficulty,
		Puzzle:     chosen.Puzzle,
		Solution:   chosen.Solution,
		Technique:  chosen.Technique,
		CreatedAt:  time.Now().UTC(),
		Date:       date,
	})
	if err != nil {
		log.Printf("error: persisting daily puzzle: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to store daily puzzle"})
		return
	}
	writeJSON(w, http.StatusOK, recordResponse(daily))
}

func hashString(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

// boardRequest carries a puzzle and the player's current board.
type boardRequest struct {
	Puzzle string `json:"puzzle"`
	Board  string `json:"board"`
	// Index optionally names the cell to reveal (hint only).
	Index *int `json:"index,omitempty"`
}

// apiError is an error with the HTTP status it should produce.
type apiError struct {
	status int
	msg    string
}

func (e *apiError) Error() string { return e.msg }

// decodeBoardRequest parses the body and resolves the puzzle's solution.
func decodeBoardRequest(w http.ResponseWriter, r *http.Request) (boardRequest, board.Board, board.Board, board.Board, *apiError) {
	var req boardRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return req, nil, nil, nil, &apiError{http.StatusBadRequest, "invalid JSON"}
	}
	puzzle, err := parseBoard(req.Puzzle)
	if err != nil {
		return req, nil, nil, nil, &apiError{http.StatusBadRequest, "invalid puzzle: " + err.Error()}
	}
	boardIn, err := parseBoard(req.Board)
	if err != nil {
		return req, nil, nil, nil, &apiError{http.StatusBadRequest, "invalid board: " + err.Error()}
	}
	solution, apiErr := solutionFor(puzzle)
	if apiErr != nil {
		return req, nil, nil, nil, apiErr
	}
	return req, puzzle, boardIn, solution, nil
}

// minClues is the fewest givens a uniquely solvable Sudoku can have.
const minClues = 17

// solutionFor looks the puzzle up in the store, and otherwise solves it.
// Puzzles below 17 clues cannot have a unique answer and are rejected before
// any search runs.
func solutionFor(puzzle board.Board) (board.Board, *apiError) {
	if sol, ok, err := storage.SolutionFor(boardToString(puzzle)); err == nil && ok {
		if b, err := parseBoard(sol); err == nil {
			return b, nil
		}
	}
	clues := 0
	for _, v := range puzzle {
		if v != 0 {
			clues++
		}
	}
	if clues < minClues {
		return nil, &apiError{http.StatusUnprocessableEntity, "puzzle has fewer than 17 clues and cannot have a unique solution"}
	}
	solution, ok := board.Solve(puzzle)
	if !ok {
		return nil, &apiError{http.StatusUnprocessableEntity, "puzzle has no solution"}
	}
	return solution, nil
}

// handleValidate checks the player's board against the solution and reports
// which cells are wrong. It never returns the solution itself.
func handleValidate(w http.ResponseWriter, r *http.Request) {
	_, _, boardIn, solution, apiErr := decodeBoardRequest(w, r)
	if apiErr != nil {
		writeJSON(w, apiErr.status, map[string]string{"error": apiErr.msg})
		return
	}

	empty := 0
	wrong := []int{}
	for i := range solution {
		switch {
		case boardIn[i] == 0:
			empty++
		case boardIn[i] != solution[i]:
			wrong = append(wrong, i)
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"complete":     empty == 0 && len(wrong) == 0,
		"emptyCells":   empty,
		"wrongCells":   len(wrong),
		"wrongIndices": wrong,
	})
}

// hintResponse reveals one cell. When the server picked the cell, it also
// explains the logical step that finds it.
type hintResponse struct {
	Index       int    `json:"index"`
	Value       int    `json:"value"`
	Technique   string `json:"technique,omitempty"`
	Description string `json:"description,omitempty"`
}

// handleHint reveals one cell. If the request names an empty cell, that cell
// is revealed, with an explanation when a single proves it. Otherwise the server finds the simplest logical placement on
// the player's board (ignoring their wrong entries) and explains it, falling
// back to the first empty cell when no single is available.
func handleHint(w http.ResponseWriter, r *http.Request) {
	req, puzzle, boardIn, solution, apiErr := decodeBoardRequest(w, r)
	if apiErr != nil {
		writeJSON(w, apiErr.status, map[string]string{"error": apiErr.msg})
		return
	}

	// Only trust the player's correct entries when reasoning.
	known := board.New()
	firstEmpty := -1
	for i := range known {
		if puzzle[i] != 0 {
			known[i] = puzzle[i]
		} else if boardIn[i] == solution[i] {
			known[i] = boardIn[i]
		} else if boardIn[i] == 0 && firstEmpty == -1 {
			firstEmpty = i
		}
	}
	if firstEmpty == -1 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no empty cell to reveal"})
		return
	}

	if req.Index != nil {
		i := *req.Index
		if i >= 0 && i < 81 && puzzle[i] == 0 && boardIn[i] == 0 {
			resp := hintResponse{Index: i, Value: solution[i]}
			if step, ok := logic.ExplainCell(known, i); ok {
				resp.Technique, resp.Description = step.Name, step.Description
			}
			writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	if step, ok := logic.NextStep(known); ok && step.Index >= 0 && boardIn[step.Index] == 0 {
		writeJSON(w, http.StatusOK, hintResponse{
			Index:       step.Index,
			Value:       solution[step.Index],
			Technique:   step.Name,
			Description: step.Description,
		})
		return
	}
	writeJSON(w, http.StatusOK, hintResponse{Index: firstEmpty, Value: solution[firstEmpty]})
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
