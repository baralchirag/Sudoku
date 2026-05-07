package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"strconv"
	"strings"

	"github.com/chiragbaral/sudoku/backend-go/board"
	"github.com/chiragbaral/sudoku/backend-go/generator"
	"github.com/chiragbaral/sudoku/backend-go/storage"
)

type puzzleResponse struct {
	Puzzle     string `json:"puzzle"`
	Solution   string `json:"solution"`
	Difficulty string `json:"difficulty"`
}

func startServer(port int) {
	http.HandleFunc("/api/puzzle", handlePuzzle)
	addr := ":" + strconv.Itoa(port)
	log.Printf("starting server on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func handlePuzzle(w http.ResponseWriter, r *http.Request) {
	// CORS for local frontend testing
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	difficulty := r.URL.Query().Get("difficulty")
	if difficulty == "" {
		difficulty = "medium"
	}

	// Try to load stored puzzles and pick one matching difficulty
	records, err := storage.List()
	if err == nil && len(records) > 0 {
		var candidates []storage.PuzzleRecord
		for _, rec := range records {
			if strings.EqualFold(rec.Difficulty, difficulty) {
				candidates = append(candidates, rec)
			}
		}
		if len(candidates) > 0 {
			pick := candidates[rand.Intn(len(candidates))]
			resp := puzzleResponse{Puzzle: pick.Puzzle, Solution: pick.Solution, Difficulty: pick.Difficulty}
			_ = json.NewEncoder(w).Encode(resp)
			return
		}
	}

	// Fallback: generate a new puzzle
	diff, _ := parseDifficulty(difficulty)
	gen := generator.GeneratePuzzleRecord(diff)
	resp := puzzleResponse{Puzzle: boardToString(gen.Puzzle), Solution: boardToString(gen.Solution), Difficulty: difficulty}
	_ = json.NewEncoder(w).Encode(resp)
}

// simple helper to format board as digits
func boardToString(b board.Board) string {
	var sb strings.Builder
	for _, v := range b {
		sb.WriteByte(byte('0' + v))
	}
	return sb.String()
}
