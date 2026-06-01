package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/chiragbaral/sudoku/backend-go/board"
	"github.com/chiragbaral/sudoku/backend-go/generator"
	"github.com/chiragbaral/sudoku/backend-go/storage"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("expected 'generate', 'pool', 'list', 'solve', or 'verify' subcommands")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "generate":
		generateCmd := flag.NewFlagSet("generate", flag.ExitOnError)
		difficultyStr := generateCmd.String("difficulty", "medium", "puzzle difficulty: easy, medium, hard, or expert")
		generateCmd.Parse(os.Args[2:])

		diff, err := parseDifficulty(*difficultyStr)
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		record := generator.GeneratePuzzleRecord(diff)
		if err := storage.Save(storage.NewPuzzleRecord(*difficultyStr, record.Puzzle, record.Solution)); err != nil {
			fmt.Printf("Error saving puzzle: %v\n", err)
			os.Exit(1)
		}

		puzzle := record.Puzzle
		printBoard(puzzle)
		fmt.Printf("Saved puzzle to %s\n", storage.DefaultPath())

	case "pool":
		poolCmd := flag.NewFlagSet("pool", flag.ExitOnError)
		difficultyStr := poolCmd.String("difficulty", "all", "pool difficulty: easy, medium, hard, expert, or all")
		count := poolCmd.Int("count", 10, "number of puzzles to generate per difficulty")
		poolCmd.Parse(os.Args[2:])

		if *count <= 0 {
			fmt.Println("count must be > 0")
			os.Exit(1)
		}

		c := *count

		type level struct {
			name string
			diff generator.Difficulty
		}

		var levels []level
		if strings.EqualFold(*difficultyStr, "all") {
			levels = []level{
				{name: "easy", diff: generator.Easy},
				{name: "medium", diff: generator.Medium},
				{name: "hard", diff: generator.Hard},
				{name: "expert", diff: generator.Expert},
			}
		} else {
			diff, err := parseDifficulty(*difficultyStr)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
			levels = []level{{name: strings.ToLower(*difficultyStr), diff: diff}}
		}

		records := make([]storage.PuzzleRecord, 0, len(levels)*c)
		for _, lvl := range levels {
			for i := 0; i < *count; i++ {
				generated := generator.GeneratePuzzleRecord(lvl.diff)
				records = append(records, storage.NewPuzzleRecord(lvl.name, generated.Puzzle, generated.Solution))
			}
		}

		if err := storage.SaveMany(records); err != nil {
			fmt.Printf("Error saving pool: %v\n", err)
			os.Exit(1)
		}

		fmt.Printf("Saved %d puzzles to %s\n", len(records), storage.DefaultPath())
		for _, lvl := range levels {
			fmt.Printf("- %s: %d\n", lvl.name, *count)
		}

	case "list":
		records, err := storage.List()
		if err != nil {
			fmt.Printf("Error loading puzzles: %v\n", err)
			os.Exit(1)
		}
		if len(records) == 0 {
			fmt.Println("No stored puzzles yet.")
			return
		}
		for i, record := range records {
			fmt.Println(storage.FormatRecord(i, record))
		}

	case "solve":
		solveCmd := flag.NewFlagSet("solve", flag.ExitOnError)
		boardStr := solveCmd.String("board", "", "puzzle to solve as a string of 81 numbers")
		solveCmd.Parse(os.Args[2:])

		puzzle, err := parseBoard(*boardStr)
		if err != nil {
			fmt.Printf("Error parsing board: %v\n", err)
			os.Exit(1)
		}

		solution, ok := board.Solve(puzzle)
		if !ok {
			fmt.Println("Puzzle has no solution.")
		} else {
			fmt.Println("Solution:")
			printBoard(solution)
		}

	case "verify":
		verifyCmd := flag.NewFlagSet("verify", flag.ExitOnError)
		boardStr := verifyCmd.String("board", "", "puzzle to verify as a string of 81 numbers")
		verifyCmd.Parse(os.Args[2:])

		puzzle, err := parseBoard(*boardStr)
		if err != nil {
			fmt.Printf("Error parsing board: %v\n", err)
			os.Exit(1)
		}

		count := board.CountSolutions(puzzle, 2)
		fmt.Printf("Found %d solution(s).\n", count)
		if count == 1 {
			fmt.Println("Puzzle has a unique solution.")
		} else {
			fmt.Println("Puzzle does not have a unique solution.")
		}

	case "server":
		serverCmd := flag.NewFlagSet("server", flag.ExitOnError)
		port := serverCmd.Int("port", 8080, "port to serve the HTTP API on")
		serverCmd.Parse(os.Args[2:])

		startServer(*port)

	default:
		fmt.Println("expected 'generate', 'pool', 'list', 'solve', 'verify', or 'server' subcommands")
		os.Exit(1)
	}
}

func parseDifficulty(value string) (generator.Difficulty, error) {
	switch strings.ToLower(value) {
	case "easy":
		return generator.Easy, nil
	case "medium":
		return generator.Medium, nil
	case "hard":
		return generator.Hard, nil
	case "expert":
		return generator.Expert, nil
	default:
		return 0, fmt.Errorf("unknown difficulty: %s", value)
	}
}

func printBoard(b board.Board) {
	for r := 0; r < 9; r++ {
		if r%3 == 0 && r != 0 {
			fmt.Println("------+-------+------")
		}
		for c := 0; c < 9; c++ {
			if c%3 == 0 && c != 0 {
				fmt.Print("| ")
			}
			val := b[board.RowColToIndex(r, c)]
			if val == 0 {
				fmt.Print(". ")
			} else {
				fmt.Printf("%d ", val)
			}
		}
		fmt.Println()
	}
}

func parseBoard(s string) (board.Board, error) {
	b := board.New()
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, ".", "0")

	if len(s) != 81 {
		return nil, fmt.Errorf("input string must have 81 digits, but has %d", len(s))
	}

	for i, char := range s {
		val := int(char - '0')
		if val < 0 || val > 9 {
			return nil, fmt.Errorf("invalid character '%c' in input string", char)
		}
		b[i] = val
	}
	return b, nil
}
