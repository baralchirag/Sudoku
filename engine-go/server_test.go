package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chiragbaral/sudoku/backend-go/storage"
)

func stringsReader(s string) *strings.Reader {
	return strings.NewReader(s)
}

// TestMain isolates the puzzle store to a temp file so tests never touch the
// real data/puzzles.json.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "sudoku-test")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(dir)
	os.Setenv("SUDOKU_DATA_FILE", filepath.Join(dir, "puzzles.json"))
	os.Setenv("SUDOKU_STATIC_DIR", "")
	code := m.Run()
	os.Unsetenv("SUDOKU_DATA_FILE")
	os.Unsetenv("SUDOKU_STATIC_DIR")
	os.Exit(code)
}

func getJSON(t *testing.T, target string) map[string]interface{} {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	handleAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s -> status %d, body %s", target, rec.Code, rec.Body.String())
	}
	var out map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("invalid JSON from %s: %v", target, err)
	}
	return out
}

func TestHealth(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	handleAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestPuzzleEndpoint(t *testing.T) {
	out := getJSON(t, "/api/puzzle?difficulty=easy")
	puzzle, ok := out["puzzle"].(string)
	if !ok || len(puzzle) != 81 {
		t.Fatalf("expected 81-char puzzle, got %q", puzzle)
	}
	if _, leaked := out["solution"]; leaked {
		t.Fatalf("puzzle response must not include the solution")
	}
}

func TestPuzzleUnknownDifficulty(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/puzzle?difficulty=impossible", nil)
	rec := httptest.NewRecorder()
	handleAPI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad difficulty, got %d", rec.Code)
	}
}

func TestValidateEndpoint(t *testing.T) {
	// A known single-solution puzzle and its solution.
	puzzle := "530070000600195000098000060800060003400803001700020006060000280000419005000080079"
	solution := "534678912672195348198342567859761423426853791713924856961537284287419635345286179"
	body := fmt.Sprintf(`{"puzzle":%q,"board":%q}`, puzzle, solution)

	req := httptest.NewRequest(http.MethodPost, "/api/puzzle/validate", stringsReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handleAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["complete"] != true {
		t.Fatalf("expected complete=true, got %v", out)
	}
	if _, leaked := out["solution"]; leaked {
		t.Fatalf("validate must not include the solution")
	}
}

func TestValidateRejectsWrongBoard(t *testing.T) {
	puzzle := "530070000600195000098000060800060003400803001700020006060000280000419005000080079"
	// Break the first given digit.
	wrong := "130070000600195000098000060800060003400803001700020006060000280000419005000080079"
	body := fmt.Sprintf(`{"puzzle":%q,"board":%q}`, puzzle, wrong)
	req := httptest.NewRequest(http.MethodPost, "/api/puzzle/validate", stringsReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handleAPI(rec, req)
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["wrongCells"].(float64) < 1 {
		t.Fatalf("expected wrongCells >= 1, got %v", out["wrongCells"])
	}
	idx, _ := out["wrongIndices"].([]interface{})
	if len(idx) != 1 || idx[0].(float64) != 0 {
		t.Fatalf("expected wrongIndices [0], got %v", out["wrongIndices"])
	}
}

// fixClock pins the server clock for a test.
func fixClock(t *testing.T, date string) time.Time {
	t.Helper()
	now, err := time.Parse("2006-01-02 15:04", date+" 12:00")
	if err != nil {
		t.Fatal(err)
	}
	nowFunc = func() time.Time { return now }
	t.Cleanup(func() { nowFunc = time.Now })
	return now
}

func status(t *testing.T, method, target, body string) (int, map[string]interface{}) {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, stringsReader(body))
	}
	rec := httptest.NewRecorder()
	handleAPI(rec, req)
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestDailyIsStableAndPersisted(t *testing.T) {
	fixClock(t, "2030-05-01")
	first := getJSON(t, "/api/puzzle/daily?date=2030-05-01")
	second := getJSON(t, "/api/puzzle/daily?date=2030-05-01")
	if first["puzzle"] != second["puzzle"] {
		t.Fatalf("daily puzzle for same date differs between calls")
	}
	if first["date"] != "2030-05-01" {
		t.Fatalf("expected date echoed, got %v", first["date"])
	}
	if _, leaked := first["solution"]; leaked {
		t.Fatalf("daily response must not include the solution")
	}
}

func TestDailyRotatesDifficulty(t *testing.T) {
	fixClock(t, "2031-06-02")
	seen := map[string]bool{}
	for _, date := range []string{"2031-06-01", "2031-06-02", "2031-06-03"} {
		out := getJSON(t, "/api/puzzle/daily?date="+date)
		diff, _ := out["difficulty"].(string)
		seen[diff] = true
	}
	if len(seen) != 3 {
		t.Fatalf("expected a different difficulty on each of 3 days, got %v", seen)
	}
}

func TestDailyRefusesFutureDates(t *testing.T) {
	fixClock(t, "2032-01-10")
	if code, _ := status(t, http.MethodGet, "/api/puzzle/daily?date=2032-01-11", ""); code != http.StatusOK {
		t.Fatalf("tomorrow (UTC) should be allowed for timezones ahead, got %d", code)
	}
	if code, _ := status(t, http.MethodGet, "/api/puzzle/daily?date=2032-01-12", ""); code != http.StatusForbidden {
		t.Fatalf("expected 403 for a date two days ahead, got %d", code)
	}
}

func TestDailyOldDatesAreReadOnly(t *testing.T) {
	fixClock(t, "2033-03-10")
	assigned := getJSON(t, "/api/puzzle/daily?date=2033-03-10")

	// Later, the assigned day is still served, but unplayed past days are not created.
	fixClock(t, "2033-03-20")
	again := getJSON(t, "/api/puzzle/daily?date=2033-03-10")
	if again["puzzle"] != assigned["puzzle"] {
		t.Fatalf("past daily changed")
	}
	before, _ := storage.List()
	if code, _ := status(t, http.MethodGet, "/api/puzzle/daily?date=2033-03-01", ""); code != http.StatusNotFound {
		t.Fatalf("expected 404 for an unplayed past date, got %d", code)
	}
	after, _ := storage.List()
	if len(after) != len(before) {
		t.Fatalf("an old-date request must not write to the store")
	}
}

const (
	samplePuzzle   = "530070000600195000098000060800060003400803001700020006060000280000419005000080079"
	sampleSolution = "534678912672195348198342567859761423426853791713924856961537284287419635345286179"
)

func TestHintRevealsRequestedCell(t *testing.T) {
	code, out := status(t, http.MethodPost, "/api/puzzle/hint",
		fmt.Sprintf(`{"puzzle":%q,"board":%q,"index":2}`, samplePuzzle, samplePuzzle))
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, out)
	}
	if out["index"].(float64) != 2 || out["value"].(float64) != float64(sampleSolution[2]-'0') {
		t.Fatalf("expected cell 2 = %c, got %v", sampleSolution[2], out)
	}
}

func TestHintExplainsALogicalStep(t *testing.T) {
	code, out := status(t, http.MethodPost, "/api/puzzle/hint",
		fmt.Sprintf(`{"puzzle":%q,"board":%q}`, samplePuzzle, samplePuzzle))
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, out)
	}
	i := int(out["index"].(float64))
	if out["value"].(float64) != float64(sampleSolution[i]-'0') {
		t.Fatalf("hint value is wrong: %v", out)
	}
	if out["technique"] == nil || out["description"] == nil {
		t.Fatalf("expected an explained hint, got %v", out)
	}
}

func TestHintOnFullBoard(t *testing.T) {
	code, _ := status(t, http.MethodPost, "/api/puzzle/hint",
		fmt.Sprintf(`{"puzzle":%q,"board":%q}`, samplePuzzle, sampleSolution))
	if code != http.StatusConflict {
		t.Fatalf("expected 409 when nothing is left to reveal, got %d", code)
	}
}

func TestValidateRejectsTooFewClues(t *testing.T) {
	empty := strings.Repeat("0", 81)
	code, _ := status(t, http.MethodPost, "/api/puzzle/validate",
		fmt.Sprintf(`{"puzzle":%q,"board":%q}`, empty, empty))
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for an empty puzzle, got %d", code)
	}
}

func TestValidateRejectsHugeBody(t *testing.T) {
	big := fmt.Sprintf(`{"puzzle":%q,"board":%q,"pad":%q}`, samplePuzzle, samplePuzzle, strings.Repeat("x", 10000))
	code, _ := status(t, http.MethodPost, "/api/puzzle/validate", big)
	if code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an oversized body, got %d", code)
	}
}

func TestMethodsEnforced(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/puzzle", nil)
	rec := httptest.NewRecorder()
	handleAPI(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for POST /api/puzzle, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/puzzle/validate", nil)
	rec = httptest.NewRecorder()
	handleAPI(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for GET /api/puzzle/validate, got %d", rec.Code)
	}
}

func TestOptionsCORS(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/api/puzzle", nil)
	rec := httptest.NewRecorder()
	handleAPI(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS, got %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("expected CORS header")
	}
}

func TestTrailingSlash(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/puzzle/", nil)
	rec := httptest.NewRecorder()
	handleAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for trailing slash, got %d", rec.Code)
	}
}
