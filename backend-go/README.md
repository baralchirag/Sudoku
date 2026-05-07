# Backend (Go)

This folder contains the Sudoku backend and CLI tools.

Generated puzzles are stored in `data/puzzles.json` and each record includes:
- Puzzle
- Solution
- Difficulty

Quick run (requires Go 1.20+):

```bash
cd backend-go
go test ./...
```

Generate and persist one puzzle:

```bash
go run . generate --difficulty easy
```

Bulk-generate a pre-filled pool and persist it:

```bash
# 25 medium puzzles
go run . pool --difficulty medium --count 25

# 10 per difficulty (easy, medium, hard)
go run . pool --difficulty all --count 10
```

List stored puzzles:

```bash
go run . list
```
