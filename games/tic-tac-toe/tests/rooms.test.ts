import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPlayerMove,
  createRoom,
  GameError,
  joinRoom,
  seatOf,
  toState,
  type Room,
} from '../src/server/rooms.ts';

/** A room with both seats filled, ready to play. */
function playingRoom(winLength = 3): Room {
  const room = createRoom('R1', winLength);
  joinRoom(room, 'player-x');
  joinRoom(room, 'player-o');
  return room;
}

const rc = (room: Room, row: number, col: number) => row * room.size + col;

test('a new room waits until both seats are filled', () => {
  const room = createRoom('R1', 3);
  assert.equal(room.status, 'waiting');
  assert.equal(joinRoom(room, 'player-x'), 'X');
  assert.equal(room.status, 'waiting');
  assert.equal(joinRoom(room, 'player-o'), 'O');
  assert.equal(room.status, 'playing');
});

test('rejoining with the same player id returns the same seat', () => {
  const room = playingRoom();
  assert.equal(joinRoom(room, 'player-x'), 'X');
  assert.equal(joinRoom(room, 'player-o'), 'O');
  assert.equal(seatOf(room, 'player-x'), 'X');
  assert.equal(seatOf(room, 'nobody'), null);
});

test('a third player watches instead of taking a seat', () => {
  const room = playingRoom();
  assert.equal(joinRoom(room, 'nosy'), 'spectator');
  assert.throws(() => applyPlayerMove(room, 'nosy', 0), GameError);
});

test('no moves are accepted before an opponent arrives', () => {
  const room = createRoom('R1', 3);
  joinRoom(room, 'player-x');
  assert.throws(() => applyPlayerMove(room, 'player-x', 0), /waiting for an opponent/);
});

test('players alternate and cannot move out of turn', () => {
  const room = playingRoom();
  assert.throws(() => applyPlayerMove(room, 'player-o', 0), /not your turn/);
  applyPlayerMove(room, 'player-x', 0);
  assert.equal(room.turn, 'O');
  assert.throws(() => applyPlayerMove(room, 'player-x', 1), /not your turn/);
  applyPlayerMove(room, 'player-o', 1);
  assert.equal(room.turn, 'X');
});

test('an occupied or off-board cell is refused', () => {
  const room = playingRoom();
  applyPlayerMove(room, 'player-x', 0);
  assert.throws(() => applyPlayerMove(room, 'player-o', 0), /taken/);
  assert.throws(() => applyPlayerMove(room, 'player-o', -1), /not on the board/);
  assert.throws(() => applyPlayerMove(room, 'player-o', room.cells.length), /not on the board/);
});

test('a win ends the game and locks the board', () => {
  const room = playingRoom();
  // X builds a row on row 0; O answers harmlessly on row 5.
  applyPlayerMove(room, 'player-x', rc(room, 0, 0));
  applyPlayerMove(room, 'player-o', rc(room, 5, 0));
  applyPlayerMove(room, 'player-x', rc(room, 0, 1));
  applyPlayerMove(room, 'player-o', rc(room, 5, 1));
  applyPlayerMove(room, 'player-x', rc(room, 0, 2));

  assert.equal(room.status, 'over');
  assert.equal(room.winner, 'X');
  assert.deepEqual(room.winLine, [rc(room, 0, 0), rc(room, 0, 1), rc(room, 0, 2)]);

  // Requirement: no more moves after game over, for either player.
  assert.throws(() => applyPlayerMove(room, 'player-o', rc(room, 5, 2)), /game is over/);
  assert.throws(() => applyPlayerMove(room, 'player-x', rc(room, 7, 7)), /game is over/);
});

test('the state sent to clients never carries player ids', () => {
  const room = playingRoom();
  applyPlayerMove(room, 'player-x', 0);
  const state = toState(room);

  assert.equal(state.board.length, room.size * room.size);
  assert.equal(state.board[0], 'X');
  assert.equal(state.turn, 'O');
  assert.deepEqual(state.seatsTaken, { X: true, O: true });
  assert.ok(!JSON.stringify(state).includes('player-x'));
  assert.ok(!JSON.stringify(state).includes('player-o'));
});

// --- Boundaries, failure modes and stated invariants -------------------------

test('REQUIREMENT: a room can be created at any win length from 3 to 6', () => {
  for (const winLength of [3, 4, 5, 6]) {
    const room = createRoom(`R${winLength}`, winLength);
    assert.equal(room.winLength, winLength);
    assert.equal(room.size, winLength * 2 + 2);
    assert.equal(room.cells.length, room.size * room.size);
    assert.equal(toState(room).size, room.size);
    assert.equal(toState(room).winLength, winLength);
  }
});

test('a win length outside 3..6 is refused, not clamped', () => {
  // OPEN_QUESTIONS.md #2: refused.
  for (const bad of [2, 7, 0, -1, 3.5, Number.NaN]) {
    assert.throws(() => createRoom('R1', bad), `${bad} should be refused`);
  }
});

test('a fresh room starts empty with X to move and no winner', () => {
  const room = createRoom('R1', 4);
  const state = toState(room);
  assert.equal(state.roomId, 'R1');
  assert.equal(state.status, 'waiting');
  assert.equal(state.turn, 'X');
  assert.equal(state.winner, null);
  assert.equal(state.winLine, null);
  assert.deepEqual(state.seatsTaken, { X: false, O: false });
  assert.equal(state.board, '.'.repeat(state.size * state.size));
});

test('the same player id cannot occupy both seats', () => {
  const room = createRoom('R1', 3);
  assert.equal(joinRoom(room, 'solo'), 'X');
  assert.equal(joinRoom(room, 'solo'), 'X');
  assert.equal(room.status, 'waiting');
  assert.deepEqual(toState(room).seatsTaken, { X: true, O: false });
});

test('REQUIREMENT: rejoining mid-game keeps the seat and the board', () => {
  const room = playingRoom();
  applyPlayerMove(room, 'player-x', 0);
  applyPlayerMove(room, 'player-o', 1);
  const before = toState(room);

  assert.equal(joinRoom(room, 'player-x'), 'X');
  assert.equal(joinRoom(room, 'player-o'), 'O');
  assert.deepEqual(toState(room), before);
  assert.equal(room.status, 'playing');
});

test('any number of extra joiners become spectators without a seat', () => {
  const room = playingRoom();
  for (const id of ['w1', 'w2', 'w3']) {
    assert.equal(joinRoom(room, id), 'spectator');
    assert.equal(seatOf(room, id), null);
  }
  assert.deepEqual(toState(room).seatsTaken, { X: true, O: true });
});

test('a rejected move leaves the board and the turn untouched', () => {
  const room = playingRoom();
  const before = toState(room);
  for (const attempt of [
    () => applyPlayerMove(room, 'player-o', 0), // wrong turn
    () => applyPlayerMove(room, 'player-x', -1), // off board
    () => applyPlayerMove(room, 'player-x', room.cells.length), // off board
    () => applyPlayerMove(room, 'stranger', 0), // not in this room
  ]) {
    assert.throws(attempt, GameError);
  }
  assert.deepEqual(toState(room), before);
});

test('a non-integer index is refused', () => {
  const room = playingRoom();
  for (const bad of [1.5, Number.NaN, Infinity]) {
    assert.throws(() => applyPlayerMove(room, 'player-x', bad), GameError, `${bad}`);
  }
  assert.equal(room.turn, 'X');
});

test('O can win too, and the winning line is reported', () => {
  const room = playingRoom();
  applyPlayerMove(room, 'player-x', rc(room, 0, 0));
  applyPlayerMove(room, 'player-o', rc(room, 5, 0));
  applyPlayerMove(room, 'player-x', rc(room, 0, 1));
  applyPlayerMove(room, 'player-o', rc(room, 6, 0));
  applyPlayerMove(room, 'player-x', rc(room, 3, 7));
  applyPlayerMove(room, 'player-o', rc(room, 7, 0));

  const state = toState(room);
  assert.equal(state.status, 'over');
  assert.equal(state.winner, 'O');
  assert.deepEqual(state.winLine, [rc(room, 5, 0), rc(room, 6, 0), rc(room, 7, 0)]);
});

test('a win at a longer win length needs the full length', () => {
  const room = playingRoom(4);
  // X gets three in a row — not enough when the win length is 4.
  applyPlayerMove(room, 'player-x', rc(room, 0, 0));
  applyPlayerMove(room, 'player-o', rc(room, 5, 0));
  applyPlayerMove(room, 'player-x', rc(room, 0, 1));
  applyPlayerMove(room, 'player-o', rc(room, 5, 1));
  applyPlayerMove(room, 'player-x', rc(room, 0, 2));
  assert.equal(room.status, 'playing');
  assert.equal(room.winner, null);

  applyPlayerMove(room, 'player-o', rc(room, 5, 2));
  applyPlayerMove(room, 'player-x', rc(room, 0, 3));
  assert.equal(room.status, 'over');
  assert.equal(room.winner, 'X');
});

test('a full board with no line ends as a draw and locks', () => {
  const room = playingRoom();
  // Stripe pattern (XXOO along a row, shifted by two each row) has no three in
  // a row on any axis, so filling the board is a draw.
  const markFor = (index: number) => {
    const row = Math.floor(index / room.size);
    const col = index % room.size;
    return (['X', 'X', 'O', 'O'] as const)[(col + row * 2) % 4]!;
  };
  const xs: number[] = [];
  const os: number[] = [];
  for (let i = 0; i < room.cells.length; i++) (markFor(i) === 'X' ? xs : os).push(i);
  assert.equal(xs.length, os.length, 'the pattern must split the board evenly');

  for (let i = 0; i < xs.length; i++) {
    applyPlayerMove(room, 'player-x', xs[i]!);
    applyPlayerMove(room, 'player-o', os[i]!);
  }

  const state = toState(room);
  assert.equal(state.status, 'over');
  assert.equal(state.winner, 'draw');
  assert.equal(state.winLine, null);
  assert.ok(!state.board.includes('.'));
  assert.throws(() => applyPlayerMove(room, 'player-x', 0), /game is over/);
});
