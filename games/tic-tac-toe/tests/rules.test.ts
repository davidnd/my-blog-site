import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMove,
  boardSizeFor,
  createBoard,
  deserializeBoard,
  findWin,
  isDraw,
  isValidWinLength,
  opponentOf,
  serializeBoard,
  type Cell,
  type Mark,
} from '../src/shared/rules.ts';

/** Places marks on a fresh board and returns it. Last index is the "just played" cell. */
function boardWith(size: number, mark: Mark, indices: number[]): Cell[] {
  let cells = createBoard(size);
  for (const index of indices) cells = applyMove(cells, index, mark);
  return cells;
}

const rc = (size: number, row: number, col: number) => row * size + col;

test('board size is derived from win length', () => {
  assert.equal(boardSizeFor(3), 8);
  assert.equal(boardSizeFor(4), 10);
  assert.equal(boardSizeFor(5), 12);
  assert.equal(boardSizeFor(6), 14);
});

test('win length outside 3..6 is rejected, not clamped', () => {
  for (const bad of [2, 7, 0, -1, 3.5, Number.NaN, '4', null, undefined]) {
    assert.equal(isValidWinLength(bad), false, `${String(bad)} should be invalid`);
    assert.throws(() => boardSizeFor(bad as number), RangeError, `${String(bad)} should throw`);
  }
  for (const good of [3, 4, 5, 6]) {
    assert.equal(isValidWinLength(good), true);
  }
});

test('a new board is empty and square', () => {
  const cells = createBoard(8);
  assert.equal(cells.length, 64);
  assert.ok(cells.every((cell) => cell === '.'));
  assert.equal(isDraw(cells), false);
});

test('applyMove does not mutate the board it was given', () => {
  const before = createBoard(8);
  const after = applyMove(before, 10, 'X');
  assert.equal(before[10], '.');
  assert.equal(after[10], 'X');
});

test('applyMove rejects an occupied cell and an off-board index', () => {
  const cells = applyMove(createBoard(8), 10, 'X');
  assert.throws(() => applyMove(cells, 10, 'O'), /already taken/);
  assert.throws(() => applyMove(cells, 10, 'X'), /already taken/);
  assert.throws(() => applyMove(cells, 64, 'X'), RangeError);
  assert.throws(() => applyMove(cells, -1, 'X'), RangeError);
  assert.throws(() => applyMove(cells, 1.5, 'X'), RangeError);
});

test('finds a horizontal win', () => {
  const size = 8;
  const line = [rc(size, 3, 2), rc(size, 3, 3), rc(size, 3, 4)];
  const cells = boardWith(size, 'X', line);
  assert.deepEqual(findWin(cells, size, line[2]!, 3), line);
});

test('finds a vertical win', () => {
  const size = 8;
  const line = [rc(size, 1, 5), rc(size, 2, 5), rc(size, 3, 5)];
  const cells = boardWith(size, 'O', line);
  assert.deepEqual(findWin(cells, size, line[0]!, 3), line);
});

test('finds a down-right diagonal win', () => {
  const size = 8;
  const line = [rc(size, 2, 1), rc(size, 3, 2), rc(size, 4, 3)];
  const cells = boardWith(size, 'X', line);
  assert.deepEqual(findWin(cells, size, line[1]!, 3), line);
});

test('finds a down-left diagonal win', () => {
  const size = 8;
  const line = [rc(size, 2, 5), rc(size, 3, 4), rc(size, 4, 3)];
  const cells = boardWith(size, 'O', line);
  // Down-left is walked as (+1,-1), so the returned line is in that order.
  assert.deepEqual(findWin(cells, size, line[2]!, 3), line);
});

test('a line completed from the middle still wins', () => {
  const size = 8;
  const left = rc(size, 4, 2);
  const right = rc(size, 4, 4);
  const middle = rc(size, 4, 3);
  const cells = boardWith(size, 'X', [left, right, middle]);
  assert.deepEqual(findWin(cells, size, middle, 3), [left, middle, right]);
});

test('one short of the win length is not a win', () => {
  const size = 10;
  const line = [rc(size, 5, 1), rc(size, 5, 2), rc(size, 5, 3)];
  const cells = boardWith(size, 'X', line);
  assert.equal(findWin(cells, size, line[2]!, 4), null);
});

test('an opponent mark breaks the line', () => {
  const size = 10;
  let cells = boardWith(size, 'X', [rc(size, 5, 1), rc(size, 5, 2)]);
  cells = applyMove(cells, rc(size, 5, 3), 'O');
  cells = applyMove(cells, rc(size, 5, 4), 'X');
  cells = applyMove(cells, rc(size, 5, 5), 'X');
  assert.equal(findWin(cells, size, rc(size, 5, 5), 4), null);
});

test('a line does not wrap from the end of one row to the start of the next', () => {
  const size = 8;
  // Adjacent in the flat array (7, 8, 9) but not on the board: 7 is the last
  // cell of row 0, while 8 and 9 open row 1.
  const cells = boardWith(size, 'X', [7, 8, 9]);
  assert.equal(findWin(cells, size, 8, 3), null);
  assert.equal(findWin(cells, size, 9, 3), null);
});

test('a diagonal does not wrap around a board edge', () => {
  const size = 8;
  // (0,7), (1,0)... would be a (+1,+1) step only if columns wrapped.
  const cells = boardWith(size, 'O', [rc(size, 0, 7), rc(size, 1, 0), rc(size, 2, 1)]);
  assert.equal(findWin(cells, size, rc(size, 1, 0), 3), null);
});

test('win detection works at the maximum win length and board edge', () => {
  const winLength = 6;
  const size = boardSizeFor(winLength); // 14
  const line = Array.from({ length: winLength }, (_, i) => rc(size, size - 1, size - winLength + i));
  const cells = boardWith(size, 'X', line);
  assert.deepEqual(findWin(cells, size, line[0]!, winLength), line);
});

test('an overline longer than the win length still wins', () => {
  const size = 10;
  const line = [0, 1, 2, 3, 4].map((col) => rc(size, 2, col));
  const cells = boardWith(size, 'X', line);
  assert.deepEqual(findWin(cells, size, line[4]!, 4), line);
});

test('findWin on an empty cell is null', () => {
  assert.equal(findWin(createBoard(8), 8, 0, 3), null);
});

test('a full board with no line is a draw', () => {
  const size = 4; // not a real game size, but enough to fill cheaply
  const cells: Cell[] = [];
  // Stripe pattern that never puts 3 in a row on any axis.
  const pattern: Mark[] = ['X', 'X', 'O', 'O'];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      cells.push(pattern[(col + row * 2) % 4]!);
    }
  }
  assert.equal(isDraw(cells), true);
  for (let i = 0; i < cells.length; i++) {
    assert.equal(findWin(cells, size, i, 3), null, `unexpected win at ${i}`);
  }
});

test('opponentOf flips the mark', () => {
  assert.equal(opponentOf('X'), 'O');
  assert.equal(opponentOf('O'), 'X');
});

test('a board survives a serialize/deserialize round trip', () => {
  const size = 8;
  const cells = boardWith(size, 'X', [0, 9, 18]);
  const text = serializeBoard(cells);
  assert.equal(text.length, 64);
  assert.deepEqual(deserializeBoard(text), cells);
  assert.throws(() => deserializeBoard('XO?'), /invalid board character/);
});
