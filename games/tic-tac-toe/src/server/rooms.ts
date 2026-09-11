/**
 * Room state and the rules for changing it. Still free of sockets, storage and
 * clocks — the transport in index.ts is the only thing that knows about those.
 */

import {
  applyMove,
  boardSizeFor,
  createBoard,
  findWin,
  isDraw,
  opponentOf,
  serializeBoard,
  type Cell,
  type Mark,
} from '../shared/rules.ts';
import type { EndReason, GameState, GameStatus, Outcome, Role, Seat } from '../shared/types.ts';

/** REQUIREMENTS.md: "Timer count down for each move, 30s". */
export const TURN_MS = 30_000;

/** OPEN_QUESTIONS.md #4: rooms nobody came back to are dropped after a day. */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Who may be seated by the server without a room id. A private room is one
 * someone made on purpose — "Create a room" or an invite link — and only the
 * room id gets you in. A public room is one the matchmaker opened between two
 * random players; a seat that frees up in it goes back to the random pool.
 */
export type Visibility = 'private' | 'public';

export type Room = {
  id: string;
  winLength: number;
  visibility: Visibility;
  size: number;
  cells: Cell[];
  turn: Mark;
  status: GameStatus;
  winner: Outcome | null;
  /** Why the game ended; null until it does. */
  endReason: EndReason | null;
  winLine: number[] | null;
  /** playerId occupying each seat, or null while it is free. */
  seats: { X: string | null; O: string | null };
  /** Epoch ms, used to sweep rooms nobody came back to. */
  createdAt: number;
  /** Epoch ms the current player must move by; null when no clock is running. */
  turnDeadline: number | null;
};

/** Thrown for anything a client did wrong; the transport turns it into an error message. */
export class GameError extends Error {}

export function createRoom(
  id: string,
  winLength: number,
  now = Date.now(),
  visibility: Visibility = 'private',
): Room {
  const size = boardSizeFor(winLength);
  return {
    id,
    winLength,
    visibility,
    size,
    cells: createBoard(size),
    turn: 'X',
    status: 'waiting',
    winner: null,
    endReason: null,
    winLine: null,
    seats: { X: null, O: null },
    createdAt: now,
    turnDeadline: null,
  };
}

export function seatOf(room: Room, playerId: string): Seat | null {
  if (room.seats.X === playerId) return 'X';
  if (room.seats.O === playerId) return 'O';
  return null;
}

/**
 * Seats a player, or returns their existing seat if they are already in the
 * room — which is what makes a reconnect indistinguishable from a first join.
 * A third player watches.
 */
export function joinRoom(
  room: Room,
  playerId: string,
  now = Date.now(),
  turnMs = TURN_MS,
): Role {
  const existing = seatOf(room, playerId);
  if (existing) return existing;

  const free = room.seats.X === null ? 'X' : room.seats.O === null ? 'O' : null;
  if (free === null) return 'spectator';

  room.seats[free] = playerId;
  if (room.seats.X !== null && room.seats.O !== null && room.status === 'waiting') {
    room.status = 'playing';
    // The clock starts only now, so a host waiting on an invite cannot lose on time.
    room.turnDeadline = now + turnMs;
  }
  return free;
}

export function applyPlayerMove(
  room: Room,
  playerId: string,
  index: number,
  now = Date.now(),
  turnMs = TURN_MS,
): void {
  if (room.status === 'over') {
    throw new GameError('the game is over — start a new one');
  }
  if (room.status === 'waiting') {
    throw new GameError('waiting for an opponent');
  }
  const seat = seatOf(room, playerId);
  if (seat === null) {
    throw new GameError('spectators cannot move');
  }
  if (seat !== room.turn) {
    throw new GameError('not your turn');
  }
  if (!Number.isInteger(index) || index < 0 || index >= room.cells.length) {
    throw new GameError('that cell is not on the board');
  }
  if (room.cells[index] !== '.') {
    throw new GameError('that cell is taken');
  }

  room.cells = applyMove(room.cells, index, seat);

  const winLine = findWin(room.cells, room.size, index, room.winLength);
  if (winLine) {
    room.status = 'over';
    room.winner = seat;
    room.endReason = 'line';
    room.winLine = winLine;
    room.turnDeadline = null;
    return;
  }
  if (isDraw(room.cells)) {
    room.status = 'over';
    room.winner = 'draw';
    room.endReason = 'draw';
    room.turnDeadline = null;
    return;
  }
  room.turn = opponentOf(seat);
  // Each move buys the next player a fresh full turn.
  room.turnDeadline = now + turnMs;
}

/**
 * Ends the game if the current player's deadline has passed. Returns whether it
 * changed anything, so callers can skip a pointless save and broadcast. Taking
 * `now` as an argument is what lets a restart settle a deadline that expired
 * while the process was down.
 */
export function resolveTimeout(room: Room, now = Date.now()): boolean {
  if (room.status !== 'playing' || room.turnDeadline === null) return false;
  if (now < room.turnDeadline) return false;

  room.status = 'over';
  room.winner = opponentOf(room.turn);
  room.endReason = 'timeout';
  room.turnDeadline = null;
  return true;
}

export function toState(room: Room): GameState {
  return {
    roomId: room.id,
    winLength: room.winLength,
    size: room.size,
    board: serializeBoard(room.cells),
    turn: room.turn,
    status: room.status,
    winner: room.winner,
    endReason: room.endReason,
    winLine: room.winLine,
    seatsTaken: { X: room.seats.X !== null, O: room.seats.O !== null },
    turnDeadline: room.turnDeadline,
  };
}

/**
 * Clears the board for another game in the same room. Seats stay put, so both
 * clients keep the role they already know, and X leads again.
 */
export function rematch(
  room: Room,
  playerId: string,
  now = Date.now(),
  turnMs = TURN_MS,
): void {
  if (room.status !== 'over') {
    throw new GameError('the current game is still going');
  }
  if (seatOf(room, playerId) === null) {
    throw new GameError('spectators cannot start a new game');
  }

  room.cells = createBoard(room.size);
  room.turn = 'X';
  room.winner = null;
  room.endReason = null;
  room.winLine = null;
  const bothSeated = room.seats.X !== null && room.seats.O !== null;
  room.status = bothSeated ? 'playing' : 'waiting';
  room.turnDeadline = bothSeated ? now + turnMs : null;
}

/**
 * Gives a seat back for good. Walking out on a live game forfeits it, so the
 * opponent is not left waiting on a clock for a player who is never coming
 * back. Spectators and strangers leave nothing behind. Returns whether the room
 * changed, so the transport knows whether anyone needs telling.
 */
export function leaveRoom(room: Room, playerId: string): boolean {
  const seat = seatOf(room, playerId);
  if (seat === null) return false;

  room.seats[seat] = null;
  if (room.status === 'playing') {
    room.status = 'over';
    room.winner = opponentOf(seat);
    room.endReason = 'forfeit';
    room.turnDeadline = null;
  }
  return true;
}

/**
 * RFC 4648 base32 without padding: unambiguous in speech, URL-safe with no
 * escaping, and short enough to read out of an invite link.
 */
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ID_LENGTH = 6;

export function newRoomId(taken: (id: string) => boolean): string {
  // 256 is a multiple of 32, so the modulo introduces no bias. `crypto` is a
  // global in both Node and Workers, which keeps this file free of `node:`.
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
    const id = Array.from(bytes, (byte) => ID_ALPHABET[byte % 32]).join('');
    if (!taken(id)) return id;
  }
  throw new Error('could not allocate an unused room id');
}
