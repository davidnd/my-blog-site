/**
 * Pure game rules. No I/O, no clock, no randomness — everything here is a
 * function of its arguments, which is what makes the server authoritative
 * without being hard to test.
 */

export const MIN_WIN_LENGTH = 3;
export const MAX_WIN_LENGTH = 6;

export type Mark = 'X' | 'O';
export type Cell = Mark | '.';

export const EMPTY: Cell = '.';

/** Board is square and derived from the win length, never chosen separately. */
export function boardSizeFor(winLength: number): number {
  assertWinLength(winLength);
  return winLength * 2 + 2;
}

export function isValidWinLength(winLength: unknown): winLength is number {
  return (
    typeof winLength === 'number' &&
    Number.isInteger(winLength) &&
    winLength >= MIN_WIN_LENGTH &&
    winLength <= MAX_WIN_LENGTH
  );
}

export function assertWinLength(winLength: unknown): asserts winLength is number {
  if (!isValidWinLength(winLength)) {
    throw new RangeError(
      `win length must be an integer in ${MIN_WIN_LENGTH}..${MAX_WIN_LENGTH}, got ${String(winLength)}`,
    );
  }
}

export function createBoard(size: number): Cell[] {
  return new Array<Cell>(size * size).fill(EMPTY);
}

export function opponentOf(mark: Mark): Mark {
  return mark === 'X' ? 'O' : 'X';
}

/** Returns a new board. Throws rather than silently ignoring an illegal move. */
export function applyMove(cells: readonly Cell[], index: number, mark: Mark): Cell[] {
  if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
    throw new RangeError(`cell index ${String(index)} is outside the board`);
  }
  if (cells[index] !== EMPTY) {
    throw new Error(`cell ${index} is already taken by ${cells[index]}`);
  }
  const next = cells.slice();
  next[index] = mark;
  return next;
}

/** The four axes through a cell: horizontal, vertical, and both diagonals. */
const AXES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/**
 * Looks for a win through `index` only — the cell just played is the only one
 * that can have completed a line, so this costs O(winLength), not O(size^2).
 * Returns the winning cell indices (ascending along the axis) or null.
 */
export function findWin(
  cells: readonly Cell[],
  size: number,
  index: number,
  winLength: number,
): number[] | null {
  const mark = cells[index];
  if (mark === undefined || mark === EMPTY) return null;

  const row = Math.floor(index / size);
  const col = index % size;

  for (const [dr, dc] of AXES) {
    const line = [index];
    // Row and column are bounds-checked separately, so a line can never wrap
    // from the end of one row onto the start of the next.
    for (const sign of [1, -1] as const) {
      // Walk to the end of the run rather than stopping at winLength, so an
      // overline is reported whole and the UI highlights every winning cell.
      for (let step = 1; step < size; step++) {
        const r = row + dr * step * sign;
        const c = col + dc * step * sign;
        if (r < 0 || r >= size || c < 0 || c >= size) break;
        const at = r * size + c;
        if (cells[at] !== mark) break;
        if (sign === 1) line.push(at);
        else line.unshift(at);
      }
    }
    if (line.length >= winLength) return line;
  }
  return null;
}

export function isDraw(cells: readonly Cell[]): boolean {
  return cells.every((cell) => cell !== EMPTY);
}

export function serializeBoard(cells: readonly Cell[]): string {
  return cells.join('');
}

export function deserializeBoard(board: string): Cell[] {
  return Array.from(board, (char) => {
    if (char !== 'X' && char !== 'O' && char !== EMPTY) {
      throw new Error(`invalid board character ${JSON.stringify(char)}`);
    }
    return char;
  });
}
