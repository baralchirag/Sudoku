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
	if _, ok := out["solution"].(string); !ok {
		t.Fatalf("expected solution field")
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
}

func TestDailyIsStableAndPersisted(t *testing.T) {
	first := getJSON(t, "/api/puzzle/daily?date=2030-05-01")
	second := getJSON(t, "/api/puzzle/daily?date=2030-05-01")
	if first["puzzle"] != second["puzzle"] {
		t.Fatalf("daily puzzle for same date differs between calls")
	}
	if first["date"] != "2030-05-01" {
		t.Fatalf("expected date echoed, got %v", first["date"])
	}
}

func TestDailyRotatesDifficulty(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 8; i++ {
		date := fmt.Sprintf("2031-06-%02d", i+1)
		out := getJSON(t, "/api/puzzle/daily?date="+date)
		diff, _ := out["difficulty"].(string)
		seen[diff] = true
	}
	if len(seen) < 2 {
		t.Fatalf("expected difficulty to rotate across days, got %v", seen)
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
