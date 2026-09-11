import type { Mark } from './rules.ts';

export type Seat = Mark;
/** Spectators watch without a seat. */
export type Role = Seat | 'spectator';

export type GameStatus = 'waiting' | 'playing' | 'over';
export type Outcome = Mark | 'draw';

/**
 * Why a game ended. A win on the board reads for itself, but a forfeit or a
 * flag fall leaves a board that does not explain the result — the winner may
 * not have played a single move — so the reason travels with the state.
 */
export type EndReason = 'line' | 'draw' | 'timeout' | 'forfeit';

/**
 * What a client is allowed to know. Deliberately carries no player ids — those
 * are bearer tokens for a seat, so they never travel to the other player.
 */
export type GameState = {
  roomId: string;
  winLength: number;
  size: number;
  /** One character per cell: 'X', 'O' or '.'. */
  board: string;
  turn: Mark;
  status: GameStatus;
  winner: Outcome | null;
  /** Set exactly when `status` is 'over'. */
  endReason: EndReason | null;
  winLine: number[] | null;
  seatsTaken: { X: boolean; O: boolean };
  /**
   * Epoch ms by which the current player must move, or null when no clock is
   * running (waiting for an opponent, or the game is over). Display only — the
   * server is what actually enforces it.
   */
  turnDeadline: number | null;
};

export type ClientMessage =
  | { type: 'join'; roomId: string; playerId: string }
  | { type: 'create'; winLength: number; playerId: string }
  | { type: 'queue'; winLength: number; playerId: string }
  | { type: 'move'; index: number }
  | { type: 'rematch' }
  /** Give the seat back for good; a refresh should reconnect, not leave. */
  | { type: 'leave' };

/**
 * `serverNow` rides on the envelope rather than inside GameState so that two
 * states can still be compared for equality. The client uses it to correct for
 * a browser clock that disagrees with the server's.
 */
export type ServerMessage =
  | { type: 'joined'; role: Role; state: GameState; serverNow: number }
  /**
   * Only the Cloudflare lobby sends this. A WebSocket cannot be moved between
   * Durable Objects, so the lobby names the room and the client connects to it
   * itself. The Node server seats the player directly and never sends it.
   */
  | { type: 'matched'; roomId: string }
  | { type: 'state'; state: GameState; serverNow: number }
  | { type: 'error'; message: string };
