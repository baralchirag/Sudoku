import { fromString, solve, countSolutions } from '../src/solver';

test('solver solves sample puzzle', () => {
  const sample =
    '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
  const grid = fromString(sample);
  const solved = solve(grid);
  expect(solved).not.toBeNull();
  if (solved) {
    // ensure solved grid has no zeros
    expect(solved.every(n => n >= 1 && n <= 9)).toBe(true);
  }
});

test('countSolutions stops at 2', () => {
  // an empty grid has many solutions; count should reach limit
  const empty = '0'.repeat(81);
  const grid = fromString(empty);
  const c = countSolutions(grid, 2);
  expect(c).toBeGreaterThanOrEqual(2);
});
