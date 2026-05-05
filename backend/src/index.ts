import solver from './solver';

const sample =
  '530070000600195000098000060800060003400803001700020006060000280000419005000080079';

console.log('Sample puzzle:');
console.log(sample);
const grid = solver.fromString(sample);
const solved = solver.solve(grid);
if (solved) {
  console.log('Solved:');
  console.log(solver.toString(solved));
} else {
  console.log('No solution found');
}
