export type Grid = number[]; // 81-length array, 0 = empty

function rowOf(i: number) { return Math.floor(i / 9); }
function colOf(i: number) { return i % 9; }
function boxStart(row: number, col: number) { return Math.floor(row / 3) * 3 * 9 + Math.floor(col / 3) * 3; }

export function isValidPlacement(grid: Grid, idx: number, value: number): boolean {
  const r = rowOf(idx);
  const c = colOf(idx);
  // Row
  for (let j = r * 9; j < r * 9 + 9; j++) if (grid[j] === value) return false;
  // Column
  for (let i = c; i < 81; i += 9) if (grid[i] === value) return false;
  // Box
  const boxR = Math.floor(r / 3) * 3;
  const boxC = Math.floor(c / 3) * 3;
  for (let dr = 0; dr < 3; dr++) {
    for (let dc = 0; dc < 3; dc++) {
      const pos = (boxR + dr) * 9 + (boxC + dc);
      if (grid[pos] === value) return false;
    }
  }
  return true;
}

function findEmpty(grid: Grid): number {
  for (let i = 0; i < 81; i++) if (grid[i] === 0) return i;
  return -1;
}

export function solve(gridIn: Grid): Grid | null {
  const grid = gridIn.slice();
  const solved = backtrackSolve(grid);
  return solved ? grid : null;
}

function backtrackSolve(grid: Grid): boolean {
  const idx = findEmpty(grid);
  if (idx === -1) return true;
  for (let v = 1; v <= 9; v++) {
    if (isValidPlacement(grid, idx, v)) {
      grid[idx] = v;
      if (backtrackSolve(grid)) return true;
      grid[idx] = 0;
    }
  }
  return false;
}

export function countSolutions(gridIn: Grid, limit = 2): number {
  const grid = gridIn.slice();
  let count = 0;

  function dfs(): boolean {
    if (count >= limit) return true; // early stop
    const idx = findEmpty(grid);
    if (idx === -1) {
      count++;
      return false; // continue searching until limit
    }
    for (let v = 1; v <= 9; v++) {
      if (isValidPlacement(grid, idx, v)) {
        grid[idx] = v;
        dfs();
        grid[idx] = 0;
        if (count >= limit) return true;
      }
    }
    return false;
  }

  dfs();
  return count;
}

// Export a helper to convert string <-> grid
export function fromString(s: string): Grid {
  const g: Grid = new Array(81).fill(0);
  for (let i = 0; i < Math.min(81, s.length); i++) {
    const ch = s[i];
    g[i] = ch === '0' || ch === '.' ? 0 : parseInt(ch, 10) || 0;
  }
  return g;
}

export function toString(grid: Grid): string {
  return grid.map(n => (n === 0 ? '0' : String(n))).join('');
}

export default { solve, countSolutions, isValidPlacement, fromString, toString };
