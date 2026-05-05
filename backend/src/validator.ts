import { Grid, isValidPlacement } from './solver';

export function isMoveValid(grid: Grid, idx: number, value: number): boolean {
  if (value < 1 || value > 9) return false;
  if (grid[idx] !== 0) return false; // can't move into a fixed cell
  return isValidPlacement(grid, idx, value);
}

export function validateFullGrid(grid: Grid): boolean {
  // ensure all filled and no conflicts
  for (let i = 0; i < 81; i++) {
    const v = grid[i];
    if (v < 1 || v > 9) return false;
    // temporarily clear and check
    const tmp = grid[i];
    // create shallow copy with zero at i to reuse isValidPlacement
    grid[i] = 0;
    const ok = isValidPlacement(grid, i, tmp);
    grid[i] = tmp;
    if (!ok) return false;
  }
  return true;
}

export default { isMoveValid, validateFullGrid };
