# Engine (Go)

The puzzle factory. It generates puzzles, grades them by the techniques a human
needs, and stores the graded pool that `scripts/export-bank.mjs` turns into the
Worker's puzzle bank. It also ships a CLI and a standalone JSON API.

Packages:

- `board` — grid type, rules, backtracking solver and solution counter
- `logic` — human-style solver: applies techniques from Hidden Single up to
  Swordfish, records an explained step for each deduction, and grades puzzles
- `generator` — builds puzzles graded by the techniques they require
- `storage` — JSON-file store with an in-memory index and atomic writes

```bash
go test ./...                  # engine + API tests
go run . server --port 8090    # run the platform (open http://localhost:8090)
```

## HTTP API

- `GET /api/health`
- `GET /api/puzzle?difficulty=easy|medium|hard|expert` — random pool puzzle
- `GET /api/puzzle/daily?date=YYYY-MM-DD` — daily puzzle; difficulty rotates
  by date when omitted. Only yesterday–tomorrow (UTC) can be created
- `POST /api/puzzle/validate` — body `{"puzzle": "...", "board": "..."}`
  (81-char strings) → `complete`, `emptyCells`, `wrongCells`, `wrongIndices`
- `POST /api/puzzle/hint` — same body plus optional `"index"` → `index`,
  `value`, and an explanation (`technique`, `description`) when available

Responses never include solutions.

## CLI

```bash
go run . generate --difficulty medium   # generate + persist one puzzle
go run . pool --difficulty all --count 10 [--replace]
go run . grade --board <81 digits> [--steps]
go run . list
go run . solve --board <81 digits>
go run . verify --board <81 digits>
go run . server --port 8090
```

## Storage & environment

Puzzles persist as JSON in `data/puzzles.json` (anchored to this directory, so
the working directory does not matter). The file is loaded once into an
in-memory index (by difficulty, daily date and puzzle), written atomically via
temp file + rename, and reloaded automatically if another process changes it.

| Variable | Purpose |
| --- | --- |
| `SUDOKU_DATA_FILE` | Override the puzzle store location |
| `SUDOKU_STATIC_DIR` | Override the frontend directory served at `/` |

## Daily puzzles

`/api/puzzle/daily` picks deterministically from the stored (non-daily) pool
using the date as a seed, skipping puzzles already used as a daily, stores the
pick as that date's record (first write wins, so concurrent requests agree),
and returns the same puzzle all day for everyone. Without a `difficulty` param the
level rotates `easy → medium → hard → expert` by day. When no pool exists yet
the server generates and persists the day's puzzle on first request.
