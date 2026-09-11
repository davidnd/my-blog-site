/**
 * Boundaries and edge cases for the pure rules engine, derived from
 * REQUIREMENTS.md (win length 3..6, a comfortable arena, draws) and plan.md
 * (board size = winLength * 2 + 2, no wrapping across board edges).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMove,
  assertWinLength,
  boardSizeFor,
  createBoard,
  deserializeBoard,
  EMPTY,
  findWin,
  isDraw,
  MAX_WIN_LENGTH,
  MIN_WIN_LENGTH,
  serializeBoard,
  type Cell,
  type Mark,
} from '../src/shared/rules.ts';

/** Places marks on a fresh board and returns it. */
function boardWith(size: number, mark: Mark, indices: number[]): Cell[] {
  let cells = createBoard(size);
  for (const index of indices) cells = applyMove(cells, index, mark);
  return cells;
}

const rc = (size: number, row: number, col: number) => row * size + col;

test('REQUIREMENT: win length is configurable between 3 and 6 inclusive', () => {
  assert.equal(MIN_WIN_LENGTH, 3);
  assert.equal(MAX_WIN_LENGTH, 6);
  for (let n = MIN_WIN_LENGTH; n <= MAX_WIN_LENGTH; n++) {
    assert.doesNotThrow(() => assertWinLength(n), `${n} must be accepted`);
  }
  assert.throws(() => assertWinLength(MIN_WIN_LENGTH - 1), RangeError);
  assert.throws(() => assertWinLength(MAX_WIN_LENGTH + 1), RangeError);
});

test('REQUIREMENT: every arena is large enough to play comfortably', () => {
  // plan.md: size = winLength * 2 + 2, so the board always leaves room for a
  // full line plus space on both sides of it.
  for (let winLength = MIN_WIN_LENGTH; winLength <= MAX_WIN_LENGTH; winLength++) {
    const size = boardSizeFor(winLength);
    assert.equal(size, winLength * 2 + 2);
    assert.ok(size >= 8, `board of ${size} is too small`);
    assert.ok(size > winLength, 'a winning line must fit with room to spare');
    assert.equal(createBoard(size).length, size * size);
  }
});

test('a fresh board is made only of empty cells', () => {
  const cells = createBoard(boardSizeFor(6));
  assert.equal(cells.length, 196);
  assert.ok(cells.every((cell) => cell === EMPTY));
  assert.equal(serializeBoard(cells), '.'.repeat(196));
});

test('applyMove leaves every other cell untouched', () => {
  const size = 8;
  const before = boardWith(size, 'X', [0, 1]);
  const after = applyMove(before, 40, 'O');
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    if (i !== 40) assert.equal(after[i], before[i], `cell ${i} changed`);
  }
  assert.equal(after[40], 'O');
});

test('a win is found no matter which cell of the line was played last', () => {
  const size = 10;
  const winLength = 4;
  const line = [0, 1, 2, 3].map((col) => rc(size, 4, col + 2));
  const cells = boardWith(size, 'X', line);
  for (const played of line) {
    assert.deepEqual(findWin(cells, size, played, winLength), line, `played ${played}`);
  }
});

test('exactly one short of the win length never wins, at every win length', () => {
  for (let winLength = MIN_WIN_LENGTH; winLength <= MAX_WIN_LENGTH; winLength++) {
    const size = boardSizeFor(winLength);
    const line = Array.from({ length: winLength - 1 }, (_, i) => rc(size, 2, i + 1));
    const cells = boardWith(size, 'X', line);
    assert.equal(findWin(cells, size, line.at(-1)!, winLength), null, `winLength ${winLength}`);
  }
});

test('exactly the win length wins, at every win length and on every axis', () => {
  const axes: Array<[number, number]> = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (let winLength = MIN_WIN_LENGTH; winLength <= MAX_WIN_LENGTH; winLength++) {
    const size = boardSizeFor(winLength);
    for (const [dr, dc] of axes) {
      const startRow = dr < 0 ? size - 1 : 2;
      const startCol = dc < 0 ? size - 2 : 1;
      const line = Array.from({ length: winLength }, (_, i) =>
        rc(size, startRow + dr * i, startCol + dc * i),
      );
      const cells = boardWith(size, 'X', line);
      assert.deepEqual(
        findWin(cells, size, line[0]!, winLength),
        line,
        `winLength ${winLength} axis ${dr},${dc}`,
      );
    }
  }
});

test('two short runs separated by a gap are not a win', () => {
  const size = 10;
  // X X . X X on one row: four marks, but never four consecutive.
  const cells = boardWith(size, 'X', [rc(size, 3, 1), rc(size, 3, 2), rc(size, 3, 4), rc(size, 3, 5)]);
  for (const played of [rc(size, 3, 1), rc(size, 3, 2), rc(size, 3, 4), rc(size, 3, 5)]) {
    assert.equal(findWin(cells, size, played, 4), null, `played ${played}`);
  }
});

test('an anti-diagonal does not wrap at the left board edge', () => {
  const size = 8;
  // (2,0) then (3,-1) would be the next (+1,-1) step; if columns wrapped it
  // would land on (3,7) and (4,6), which must not count.
  const cells = boardWith(size, 'X', [rc(size, 2, 0), rc(size, 3, 7), rc(size, 4, 6)]);
  assert.equal(findWin(cells, size, rc(size, 2, 0), 3), null);
});

test('a vertical line at the bottom edge does not read past the board', () => {
  const size = 8;
  const line = [rc(size, 5, 3), rc(size, 6, 3), rc(size, 7, 3)];
  const cells = boardWith(size, 'O', line);
  assert.deepEqual(findWin(cells, size, line[2]!, 3), line);
});

test('a line of the opponent under the played cell is not counted', () => {
  const size = 8;
  let cells = boardWith(size, 'O', [rc(size, 1, 1), rc(size, 2, 1)]);
  cells = applyMove(cells, rc(size, 3, 1), 'X');
  // X just played below two Os: X has one, O has two, nobody has three.
  assert.equal(findWin(cells, size, rc(size, 3, 1), 3), null);
});

test('a board with a single empty cell left is not yet a draw', () => {
  const size = 4;
  const cells: Cell[] = Array.from({ length: size * size }, (_, i) => (i % 2 ? 'O' : 'X'));
  cells[size * size - 1] = EMPTY;
  assert.equal(isDraw(cells), false);
  cells[size * size - 1] = 'O';
  assert.equal(isDraw(cells), true);
});

test('deserializeBoard refuses anything that is not X, O or a dot', () => {
  for (const bad of ['x', 'o', ' ', 'XY', '-']) {
    assert.throws(() => deserializeBoard(bad), /invalid board character/, `"${bad}"`);
  }
});
