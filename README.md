# Sudoku — a full Sudoku platform

A complete web Sudoku platform with a Go backend and a dependency-free
vanilla-JS frontend.

## Features

**Gameplay**
- Daily challenge — one deterministic puzzle per day for everyone (difficulty rotates daily)
- Endless random puzzles in four difficulties: Easy, Medium, Hard, Expert
- Pencil notes (3×3 mini-grid per cell), auto-removed when a number is placed
- Undo / redo (keyboard: `Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`)
- Hints that reveal the correct digit in an empty cell
- Wrong entries flagged red (auto-check)
- Highlight of the selected cell, its row/column/box, and matching numbers
- Timer that starts on the first move and pauses when the tab is hidden
- Win detection with time/hints summary, "new best" tracking per difficulty
- On-screen number pad with per-digit remaining counts (mobile friendly)
- Full keyboard control (1–9, ⌫, arrow keys, N notes, H hint)
- In-game overlay for the win state

**Platform**
- Progress auto-saved per mode in `localStorage` and resumed on reload
- Daily completion recorded per date (badge + stats)
- Works offline by falling back to a built-in sample puzzle
- Single binary serves both the API **and** the static frontend

## Quick start

Requires Go 1.20+.

```bash
cd backend-go
go run . server --port 8090
```

Then open <http://localhost:8090>. The server serves the frontend from the
repo's `frontend/` directory and the API under `/api/`.

If you already have puzzles generated, they live in `backend-go/data/puzzles.json`.
With an empty store the server generates puzzles on the fly and persists the
daily one.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Liveness check |
| `GET /api/puzzle?difficulty=easy\|medium\|hard\|expert` | Random puzzle from the pool |
| `GET /api/puzzle/daily?date=YYYY-MM-DD` | Deterministic daily puzzle (difficulty rotates by day) |
| `POST /api/puzzle/validate` | Check a filled board: `{"puzzle","board"}` → `complete`, `emptyCells`, `wrongCells`, `solution` |

All responses are JSON with permissive CORS. `?difficulty` values other than
the four levels return `400`.


## Backend CLI

```bash
cd backend-go
go test ./...          # unit + API tests
go run . pool --difficulty all --count 10   # generate a puzzle pool
go run . list          # list stored puzzles
go run . solve --board <81-char-puzzle>
go run . verify --board <81-char-puzzle>    # checks unique solution
```

Environment overrides:
- `SUDOKU_DATA_FILE` — where puzzles are stored (default `backend-go/data/puzzles.json`)
- `SUDOKU_STATIC_DIR` — where the frontend is served from (defaults to the sibling `frontend/`)

