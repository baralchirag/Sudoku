package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func useTempStore(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "puzzles.json")
	t.Setenv(dataFileEnvVar, path)
	return path
}

func rec(diff, puzzle string) PuzzleRecord {
	return PuzzleRecord{Difficulty: diff, Puzzle: puzzle, Solution: strings.Repeat("1", 81), CreatedAt: time.Now()}
}

func TestEmptyStore(t *testing.T) {
	useTempStore(t)
	if _, ok, err := Random("easy"); err != nil || ok {
		t.Fatalf("expected empty store, ok=%v err=%v", ok, err)
	}
}

func TestSaveAndIndexes(t *testing.T) {
	useTempStore(t)
	if err := SaveMany([]PuzzleRecord{rec("easy", "a"), rec("Hard", "b")}); err != nil {
		t.Fatal(err)
	}
	pool, _ := Pool("hard")
	if len(pool) != 1 || pool[0].Puzzle != "b" || pool[0].Difficulty != "hard" {
		t.Fatalf("difficulty index wrong: %+v", pool)
	}
	if sol, ok, _ := SolutionFor("a"); !ok || sol == "" {
		t.Fatal("solution lookup failed")
	}
}

func TestSaveDailyIsFirstWriteWins(t *testing.T) {
	useTempStore(t)
	first := rec("easy", "first")
	first.Date = "2030-01-01"
	second := rec("easy", "second")
	second.Date = "2030-01-01"

	got, err := SaveDaily(first)
	if err != nil || got.Puzzle != "first" {
		t.Fatalf("got %+v, %v", got, err)
	}
	got, _ = SaveDaily(second)
	if got.Puzzle != "first" {
		t.Fatalf("second SaveDaily replaced the daily: %+v", got)
	}
	if used, _ := UsedAsDaily("first"); !used {
		t.Fatal("expected puzzle marked as used")
	}
	if d, ok, _ := Daily("2030-01-01", "EASY"); !ok || d.Puzzle != "first" {
		t.Fatal("daily lookup failed")
	}
}

func TestReloadsWhenFileChangesOnDisk(t *testing.T) {
	path := useTempStore(t)
	if err := Save(rec("easy", "a")); err != nil {
		t.Fatal(err)
	}
	// Simulate another process (e.g. the CLI) rewriting the file.
	data := `[{"difficulty":"medium","puzzle":"z","solution":"s","createdAt":"2030-01-01T00:00:00Z"}]`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	_ = os.Chtimes(path, future, future)

	all, err := List()
	if err != nil || len(all) != 1 || all[0].Puzzle != "z" {
		t.Fatalf("expected reload from disk, got %+v %v", all, err)
	}
}

func TestReplacePoolKeepsDailies(t *testing.T) {
	useTempStore(t)
	d := rec("easy", "daily")
	d.Date = "2030-01-01"
	_ = Save(rec("easy", "old"))
	_, _ = SaveDaily(d)
	if err := ReplacePool([]PuzzleRecord{rec("easy", "new")}); err != nil {
		t.Fatal(err)
	}
	all, _ := List()
	var names []string
	for _, r := range all {
		names = append(names, r.Puzzle)
	}
	if strings.Join(names, ",") != "daily,new" {
		t.Fatalf("got %v", names)
	}
}

func TestNoTempFilesLeftBehind(t *testing.T) {
	path := useTempStore(t)
	_ = Save(rec("easy", "a"))
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("expected only puzzles.json, found %d entries", len(entries))
	}
}
