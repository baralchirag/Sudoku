// Static Sudoku geometry, computed once at module load.
//
// Cells are indexed 0..80 in row-major order. The 27 units are numbered
// 0-8 rows, 9-17 columns, 18-26 boxes, which is the convention every other
// engine module relies on.

export const SIZE = 9;
export const CELLS = 81;
export const ALL_DIGITS = 0x3fe; // candidate bits 1..9

/** @type {number[][]} 27 units of 9 cell indices each. */
export const UNITS = [];
/** @type {number[][]} [row, column, box] unit ids for each cell. */
export const CELL_UNITS = [];
/** @type {number[][]} the 20 peers of each cell. */
export const PEERS = [];
/** Flat 81x81 adjacency matrix: IS_PEER[a * 81 + b] === 1 when a sees b. */
export const IS_PEER = new Uint8Array(CELLS * CELLS);

for (let u = 0; u < 27; u++) UNITS.push([]);
for (let i = 0; i < 9; i++) {
  for (let j = 0; j < 9; j++) {
    UNITS[i].push(i * 9 + j);
    UNITS[9 + i].push(j * 9 + i);
    const br = Math.floor(i / 3) * 3;
    const bc = (i % 3) * 3;
    UNITS[18 + i].push((br + Math.floor(j / 3)) * 9 + bc + (j % 3));
  }
}

for (let c = 0; c < CELLS; c++) {
  const r = Math.floor(c / 9);
  const col = c % 9;
  CELL_UNITS.push([r, 9 + col, 18 + Math.floor(r / 3) * 3 + Math.floor(col / 3)]);
  const peers = [];
  for (const u of CELL_UNITS[c]) {
    for (const p of UNITS[u]) {
      if (p !== c && !IS_PEER[c * CELLS + p]) {
        IS_PEER[c * CELLS + p] = 1;
        peers.push(p);
      }
    }
  }
  PEERS.push(peers);
}

export const rowOf = (i) => Math.floor(i / 9);
export const colOf = (i) => i % 9;
export const boxOf = (i) => CELL_UNITS[i][2] - 18;
export const sees = (a, b) => IS_PEER[a * CELLS + b] === 1;

/** Human-readable cell name, 1-based: "row 3, column 7". */
export const cellName = (i) => `row ${rowOf(i) + 1}, column ${colOf(i) + 1}`;

/** Human-readable unit name: "row 3", "column 7", "box 5". */
export function unitName(u) {
  if (u < 9) return `row ${u + 1}`;
  if (u < 18) return `column ${u - 8}`;
  return `box ${u - 17}`;
}

export const popcount = (m) => {
  let n = 0;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
};

/** Lowest set digit in a candidate mask (mask must be non-zero). */
export const lowestDigit = (m) => 31 - Math.clz32(m & -m);

export function digitsOf(mask) {
  const out = [];
  for (let v = 1; v <= 9; v++) if (mask & (1 << v)) out.push(v);
  return out;
}
