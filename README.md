# Sudoku

A complete web Sudoku platform with a Go backend and a dependency-free
vanilla-JS frontend.

## Features

**Gameplay**
- Daily challenge one deterministic puzzle per day for everyone (difficulty rotates daily)
- Endless random puzzles in four difficulties: Easy, Medium, Hard, Expert,
  graded by the techniques needed to solve them (see below)
- Pencil notes (3×3 mini-grid per cell), auto-removed when a number is placed
- Undo / redo (keyboard: `Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`)
- Explained hints: the server finds the simplest logical step and says why
  (e.g. "Hidden Single: 4 can only go in r2c6 within box 2")
- Wrong entries flagged red, checked by the server
- Highlight of the selected cell, its row/column/box, and matching numbers
- Timer that starts on the first move and pauses when the tab is hidden
- Win detection with time/hints summary, "new best" tracking per difficulty
- On-screen number pad with per-digit remaining counts (mobile friendly)
- Full keyboard control (1–9, ⌫, arrow keys, N notes, H hint)
- In-game overlay for the win state

**Platform**
- Progress auto-saved per mode in `localStorage` and resumed on reload
- Daily completion recorded per date (badge + stats)
- The solution never reaches the browser: the server checks boards and reveals hints
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

## Difficulty grading

Difficulty comes from a human-style logic solver (`backend-go/logic`), not from
clue counts. The solver repeatedly applies the simplest technique that makes
progress, and a puzzle's tier is set by the hardest technique it needed:

| Tier | Techniques |
| --- | --- |
| Easy | Hidden Single |
| Medium | Naked Single |
| Hard | Locked Candidates (pointing/claiming), Naked/Hidden Pairs and Triples |
| Expert | X-Wing, XY-Wing, Swordfish |

The generator carves cells from a solved grid, keeping a removal only if the
puzzle still has exactly one solution and logic can still solve it within the
target tier. Every puzzle is therefore solvable without guessing. Tests replay
every deduction against the true solution to prove each technique is sound.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Liveness check |
| `GET /api/puzzle?difficulty=easy\|medium\|hard\|expert` | Random puzzle from the pool → `puzzle`, `difficulty`, `technique` |
| `GET /api/puzzle/daily?date=YYYY-MM-DD` | Daily puzzle (difficulty rotates by day) |
| `POST /api/puzzle/validate` | `{"puzzle","board"}` → `complete`, `emptyCells`, `wrongCells`, `wrongIndices` |
| `POST /api/puzzle/hint` | `{"puzzle","board","index"?}` → `index`, `value`, and `technique` + `description` when a logical step explains it |

All responses are JSON with permissive CORS. No endpoint returns a solution.

- `?difficulty` values other than the four levels return `400`.
- Daily dates from yesterday to tomorrow (UTC, to cover every timezone) are
  assigned on first request. Later dates return `403`, so upcoming puzzles
  can't be previewed. Earlier dates are served only if they were played at the
  time, otherwise `404`, so requests can't grow the store.
- Puzzles under 17 clues return `422`, and request bodies are capped at 4 KB.


## Backend CLI

```bash
cd backend-go
go test ./...          # unit + API tests
go run . pool --difficulty all --count 10   # append graded puzzles to the pool
go run . pool --count 100 --replace          # rebuild the pool (keeps past dailies)
go run . grade --board <81-char-puzzle> --steps   # grade a puzzle, print its logical steps
go run . list          # list stored puzzles
go run . solve --board <81-char-puzzle>
go run . verify --board <81-char-puzzle>    # checks unique solution
```

Environment overrides:
- `SUDOKU_DATA_FILE` — where puzzles are stored (default `backend-go/data/puzzles.json`)
- `SUDOKU_STATIC_DIR` — where the frontend is served from (defaults to the sibling `frontend/`)

