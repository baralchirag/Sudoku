#!/bin/sh
# Seed the puzzle pool into the persistent volume on first boot, then run the server.
set -e

if [ ! -f "$SUDOKU_DATA_FILE" ]; then
  echo "Seeding puzzle pool from /seed/puzzles.json"
  mkdir -p "$(dirname "$SUDOKU_DATA_FILE")"
  cp /seed/puzzles.json "$SUDOKU_DATA_FILE"
fi

exec /app/sudoku-server "$@"