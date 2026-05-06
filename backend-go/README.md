# Backend (Go)

This folder contains a minimal Go backend scaffold and the `board` package.

It now also stores generated puzzles in a JSON file at `data/puzzles.json`.

Quick run (requires Go 1.20+):

```bash
cd backend-go
go test ./...
go run ./...

Generate and persist a puzzle:

```bash
go run . generate --difficulty easy
```

List stored puzzles:

```bash
go run . list
```
```
