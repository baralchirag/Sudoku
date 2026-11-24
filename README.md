# Sudoku

A new Sudoku every day, the same for everyone.

Four levels: Easy, Medium, Hard and Expert. Hints explain the next move
instead of just filling it in. Finish a puzzle to see your time on the daily
leaderboard.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:8787.

## Deploy

```bash
npm run build
```

Paste `dist/worker.js` into a Cloudflare Worker.
