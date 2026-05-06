package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/chiragbaral/sudoku/backend-go/board"
)

const defaultFilePath = "data/puzzles.json"

var mu sync.Mutex

// PuzzleRecord stores a generated puzzle, its solution, and metadata.
type PuzzleRecord struct {
	Difficulty string    `json:"difficulty"`
	Puzzle     string    `json:"puzzle"`
	Solution   string    `json:"solution"`
	CreatedAt  time.Time `json:"createdAt"`
}

// NewPuzzleRecord converts boards into a persisted record.
func NewPuzzleRecord(difficulty string, puzzle, solution board.Board) PuzzleRecord {
	return PuzzleRecord{
		Difficulty: difficulty,
		Puzzle:     boardToString(puzzle),
		Solution:   boardToString(solution),
		CreatedAt:  time.Now().UTC(),
	}
}

// Save appends a puzzle record to the backing file.
func Save(record PuzzleRecord) error {
	mu.Lock()
	defer mu.Unlock()

	records, err := loadAllLocked()
	if err != nil {
		return err
	}
	records = append(records, record)
	return writeAllLocked(records)
}

// List returns all stored puzzle records.
func List() ([]PuzzleRecord, error) {
	mu.Lock()
	defer mu.Unlock()

	return loadAllLocked()
}

// DefaultPath returns the on-disk file used for storage.
func DefaultPath() string {
	return defaultFilePath
}

func loadAllLocked() ([]PuzzleRecord, error) {
	data, err := os.ReadFile(defaultFilePath)
	if err != nil {
		if os.IsNotExist(err) {
			return []PuzzleRecord{}, nil
		}
		return nil, err
	}

	var records []PuzzleRecord
	if err := json.Unmarshal(data, &records); err != nil {
		return nil, err
	}
	return records, nil
}

func writeAllLocked(records []PuzzleRecord) error {
	if err := os.MkdirAll(filepath.Dir(defaultFilePath), 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(defaultFilePath, data, 0o644)
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
	return fmt.Sprintf("%d) %s | created=%s | puzzle=%s", index+1, record.Difficulty, record.CreatedAt.Format(time.RFC3339), record.Puzzle)
}
