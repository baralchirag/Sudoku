// Package storage persists puzzles as a JSON file and serves them from an
// in-memory index.
//
// The file is read once and kept in memory with lookups by difficulty, by
// daily date, and by puzzle string, so requests never touch the disk. Writes
// go to a temp file that is renamed into place, so a crash mid-write cannot
// corrupt the store. If the file changes underneath the process (for example
// the CLI regenerates the pool while the server runs), it is reloaded on the
// next access.
package storage

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/baralchirag/sudoku/engine-go/board"
)

// dataFileEnvVar overrides the on-disk puzzle store location when set.
const dataFileEnvVar = "SUDOKU_DATA_FILE"

// defaultFilePath resolves where puzzles are stored. It anchors to this
// source file's directory so the server and CLI work regardless of the
// current working directory. Set SUDOKU_DATA_FILE to override.
func defaultFilePath() string {
	if override := os.Getenv(dataFileEnvVar); override != "" {
		return override
	}
	_, file, _, ok := runtime.Caller(0)
	if ok {
		return filepath.Join(filepath.Dir(file), "..", "data", "puzzles.json")
	}
	return filepath.Join("data", "puzzles.json")
}

// PuzzleRecord stores a generated puzzle, its solution, and metadata.
type PuzzleRecord struct {
	Difficulty string    `json:"difficulty"`
	Puzzle     string    `json:"puzzle"`
	Solution   string    `json:"solution"`
	Technique  string    `json:"technique,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	IsDaily    bool      `json:"isDaily,omitempty"`
	Date       string    `json:"date,omitempty"`
}

// NewPuzzleRecord converts boards into a persisted record.
func NewPuzzleRecord(difficulty string, puzzle, solution board.Board) PuzzleRecord {
	return PuzzleRecord{
		Difficulty: strings.ToLower(difficulty),
		Puzzle:     boardToString(puzzle),
		Solution:   boardToString(solution),
		CreatedAt:  time.Now().UTC(),
	}
}

// ---- in-memory index ----

type index struct {
	path    string
	modTime time.Time
	size    int64

	records   []PuzzleRecord
	pool      map[string][]int // difficulty -> non-daily record positions
	daily     map[string]int   // date|difficulty -> record position
	usedDaily map[string]bool  // puzzle strings already used as a daily
	solutions map[string]string
}

func dailyKey(date, difficulty string) string {
	return date + "|" + strings.ToLower(difficulty)
}

func buildIndex(path string, records []PuzzleRecord) *index {
	ix := &index{
		path:      path,
		pool:      map[string][]int{},
		daily:     map[string]int{},
		usedDaily: map[string]bool{},
		solutions: map[string]string{},
	}
	for _, r := range records {
		ix.add(r)
	}
	return ix
}

func (ix *index) add(r PuzzleRecord) {
	r.Difficulty = strings.ToLower(r.Difficulty)
	pos := len(ix.records)
	ix.records = append(ix.records, r)
	if r.Solution != "" {
		ix.solutions[r.Puzzle] = r.Solution
	}
	if r.IsDaily {
		key := dailyKey(r.Date, r.Difficulty)
		if _, exists := ix.daily[key]; !exists {
			ix.daily[key] = pos
		}
		ix.usedDaily[r.Puzzle] = true
		return
	}
	ix.pool[r.Difficulty] = append(ix.pool[r.Difficulty], pos)
}

var (
	mu  sync.Mutex
	cur *index
)

// current returns the index for the active path, (re)loading it when the
// path changed or the file was modified externally. Callers hold mu.
func current() (*index, error) {
	path := defaultFilePath()
	st, err := os.Stat(path)
	switch {
	case os.IsNotExist(err):
		if cur == nil || cur.path != path || !cur.modTime.IsZero() {
			cur = buildIndex(path, nil)
		}
		return cur, nil
	case err != nil:
		return nil, err
	}
	if cur != nil && cur.path == path && cur.modTime.Equal(st.ModTime()) && cur.size == st.Size() {
		return cur, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var records []PuzzleRecord
	if len(data) > 0 {
		if err := json.Unmarshal(data, &records); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
	}
	ix := buildIndex(path, records)
	ix.modTime, ix.size = st.ModTime(), st.Size()
	cur = ix
	return cur, nil
}

// persist writes all records atomically and refreshes the cached file stamp.
func (ix *index) persist() error {
	if err := os.MkdirAll(filepath.Dir(ix.path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(ix.records, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(ix.path), ".puzzles-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), ix.path); err != nil {
		return err
	}
	if st, err := os.Stat(ix.path); err == nil {
		ix.modTime, ix.size = st.ModTime(), st.Size()
	}
	return nil
}

// ---- public API ----

// Save appends a puzzle record to the store.
func Save(record PuzzleRecord) error {
	return SaveMany([]PuzzleRecord{record})
}

// SaveMany appends multiple puzzle records in one write.
func SaveMany(newRecords []PuzzleRecord) error {
	if len(newRecords) == 0 {
		return nil
	}
	mu.Lock()
	defer mu.Unlock()
	ix, err := current()
	if err != nil {
		return err
	}
	next := buildIndex(ix.path, append(append([]PuzzleRecord(nil), ix.records...), newRecords...))
	if err := next.persist(); err != nil {
		return err
	}
	cur = next
	return nil
}

// ReplacePool swaps every non-daily record for newRecords, keeping daily
// records so past daily challenges stay stable.
func ReplacePool(newRecords []PuzzleRecord) error {
	mu.Lock()
	defer mu.Unlock()
	ix, err := current()
	if err != nil {
		return err
	}
	var kept []PuzzleRecord
	for _, r := range ix.records {
		if r.IsDaily {
			kept = append(kept, r)
		}
	}
	next := buildIndex(ix.path, append(kept, newRecords...))
	if err := next.persist(); err != nil {
		return err
	}
	cur = next
	return nil
}

// List returns a copy of all stored records.
func List() ([]PuzzleRecord, error) {
	mu.Lock()
	defer mu.Unlock()
	ix, err := current()
	if err != nil {
		return nil, err
	}
	return append([]PuzzleRecord(nil), ix.records...), nil
}

// Random returns a random non-daily puzzle of the given difficulty, falling
// back to a daily one of that difficulty if the pool has none.
func Random(difficulty string) (PuzzleRecord, bool, error) {
	mu.Lock()
	defer mu.Unlock()
	ix, err := current()
	if err != nil {
		return PuzzleRecord{}, false, err
	}
	d := strings.ToLower(difficulty)
	if pos := ix.pool[d]; len(pos) > 0 {
		return ix.records[pos[rand.Intn(len(pos))]], true, nil
	}
	for _, r := range ix.records {
		if r.Difficulty == d {
			return r, true, nil
		}
	}
	return PuzzleRecord{}, false, nil
}

// Pool returns the non-daily records of a difficulty, in stored order.
func Pool(difficulty string) ([]PuzzleRecord, error) {
	mu.Lock()
	defer mu.Unlock()
	ix, err := current()
	if err != nil {
		return nil, err
	}
	pos := ix.pool[strings.ToLower(difficulty)]
	out := make([]PuzzleRecord, len(pos))
	for i, p := range pos {
		out[i] = ix.records[p]
	}
	return out, nil
}

// Daily returns the daily record for a date and difficulty, if assigned.
func Daily(date, difficulty string) (PuzzleRecord, bool, error) {
	mu.Lock()
	defer mu.Unlock()
	ix, err := current()
	if err != nil {
		return PuzzleRecord{}, false, err
	}
	pos, ok := ix.daily[dailyKey(date, difficulty)]
	if !ok {
		return PuzzleRecord{}, false, nil
	}
	return ix.records[pos], true, nil
}

// UsedAsDaily reports whether a puzzle has already been a daily challenge.
func UsedAsDaily(puzzle string) (bool, error) {
	mu.Lock()
	defer mu.Unlock()
	ix, err := current()
	if err != nil {
		return false, err
	}
	return ix.usedDaily[puzzle], nil
}

// SaveDaily stores record as the daily for its date and difficulty unless one
// already exists, and returns whichever record is now the daily. The check
// and the write happen under one lock, so concurrent first requests for a day
// cannot assign two different puzzles.
func SaveDaily(record PuzzleRecord) (PuzzleRecord, error) {
	mu.Lock()
	defer mu.Unlock()
	ix, err := current()
	if err != nil {
		return PuzzleRecord{}, err
	}
	record.IsDaily = true
	record.Difficulty = strings.ToLower(record.Difficulty)
	if pos, ok := ix.daily[dailyKey(record.Date, record.Difficulty)]; ok {
		return ix.records[pos], nil
	}
	next := buildIndex(ix.path, append(append([]PuzzleRecord(nil), ix.records...), record))
	if err := next.persist(); err != nil {
		return PuzzleRecord{}, err
	}
	cur = next
	return record, nil
}

// SolutionFor returns the stored solution for a puzzle string.
func SolutionFor(puzzle string) (string, bool, error) {
	mu.Lock()
	defer mu.Unlock()
	ix, err := current()
	if err != nil {
		return "", false, err
	}
	s, ok := ix.solutions[puzzle]
	return s, ok, nil
}

// DefaultPath returns the on-disk file used for storage.
func DefaultPath() string {
	return defaultFilePath()
}

func boardToString(b board.Board) string {
	var builder strings.Builder
	builder.Grow(len(b))
	for _, v := range b {
		builder.WriteByte(byte('0' + v))
	}
	return builder.String()
}

// FormatRecord returns a human-readable single-line summary.
func FormatRecord(index int, record PuzzleRecord) string {
	technique := ""
	if record.Technique != "" {
		technique = " | needs=" + record.Technique
	}
	return fmt.Sprintf("%d) %s%s | created=%s | puzzle=%s", index+1, record.Difficulty, technique, record.CreatedAt.Format(time.RFC3339), record.Puzzle)
}
