# Backend (Go)

Sudoku engine, puzzle pool, HTTP API, and CLI. The server also serves the
static frontend from the sibling `frontend/` directory, so `go run . server`
runs the whole platform on one origin.

For the deep dive — puzzle-generation algorithms, the deterministic daily
puzzle, solver internals, and the rationale behind every design choice — see
[`../docs/TECHNICAL.md`](../docs/TECHNICAL.md).

```bash
go test ./...                  # engine + API tests
go run . server --port 8090    # run the platform (open http://localhost:8090)
```

## HTTP API

- `GET /api/health`
- `GET /api/puzzle?difficulty=easy|medium|hard|expert` — random pool puzzle
- `GET /api/puzzle/daily?date=YYYY-MM-DD` — deterministic daily puzzle;
  difficulty rotates by date when omitted
- `POST /api/puzzle/validate` — body `{"puzzle": "...", "board": "..."}`
  (81-char strings) → `complete`, `emptyCells`, `wrongCells`, `solution`

## CLI

```bash
go run . generate --difficulty medium   # generate + persist one puzzle
go run . pool --difficulty all --count 10
go run . list
go run . solve --board <81 digits>
go run . verify --board <81 digits>
go run . server --port 8090
```

## Storage & environment

Puzzles persist as JSON in `data/puzzles.json` (anchored to this directory, so
the working directory does not matter).

| Variable | Purpose |
| --- | --- |
| `SUDOKU_DATA_FILE` | Override the puzzle store location |
| `SUDOKU_STATIC_DIR` | Override the frontend directory served at `/` |

## Daily puzzles

`/api/puzzle/daily` picks deterministically from the stored (non-daily) pool
using the date as a seed, marks the pick as that date's daily record, and
returns the same puzzle all day for everyone. Without a `difficulty` param the
level rotates `easy → medium → hard → expert` by day. When no pool exists yet
the server generates and persists the day's puzzle on first request.
