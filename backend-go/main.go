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
		fmt.Println("expected 'generate', 'solve', or 'verify' subcommands")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "generate":
		generateCmd := flag.NewFlagSet("generate", flag.ExitOnError)
		difficultyStr := generateCmd.String("difficulty", "medium", "puzzle difficulty: easy, medium, or hard")
		generateCmd.Parse(os.Args[2:])

		var diff generator.Difficulty
		switch *difficultyStr {
		case "easy":
			diff = generator.Easy
		case "medium":
			diff = generator.Medium
		case "hard":
			diff = generator.Hard
		default:
			fmt.Printf("Unknown difficulty: %s\n", *difficultyStr)
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

	default:
		fmt.Println("expected 'generate', 'list', 'solve', or 'verify' subcommands")
		os.Exit(1)
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
