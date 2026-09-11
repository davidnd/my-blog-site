/**
 * Write-through storage for rooms. The in-memory map is the working copy and
 * every state change is mirrored here, so a server restart mid-game is just a
 * reload rather than a lost game.
 */

import { DatabaseSync } from 'node:sqlite';

import { boardSizeFor, deserializeBoard, serializeBoard, type Mark } from '../shared/rules.ts';
import type { EndReason, GameStatus, Outcome } from '../shared/types.ts';
import type { Room, Visibility } from './rooms.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  win_length  INTEGER NOT NULL,
  board       TEXT NOT NULL,
  turn        TEXT NOT NULL,
  status      TEXT NOT NULL,
  winner      TEXT,
  end_reason  TEXT,
  win_line    TEXT,
  player_x    TEXT,
  player_o    TEXT,
  created_at  INTEGER NOT NULL,
  turn_deadline INTEGER,
  visibility  TEXT NOT NULL DEFAULT 'private'
);
`;

const UPSERT = `
INSERT INTO rooms (id, win_length, board, turn, status, winner, end_reason, win_line, player_x, player_o, created_at, turn_deadline, visibility)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  board = excluded.board,
  turn = excluded.turn,
  status = excluded.status,
  winner = excluded.winner,
  end_reason = excluded.end_reason,
  win_line = excluded.win_line,
  player_x = excluded.player_x,
  player_o = excluded.player_o,
  turn_deadline = excluded.turn_deadline
`;

type Row = {
  id: string;
  win_length: number;
  board: string;
  turn: string;
  status: string;
  winner: string | null;
  end_reason: string | null;
  win_line: string | null;
  player_x: string | null;
  player_o: string | null;
  created_at: number;
  turn_deadline: number | null;
  visibility: string;
};

const STATUSES: GameStatus[] = ['waiting', 'playing', 'over'];
const END_REASONS: EndReason[] = ['line', 'draw', 'timeout', 'forfeit'];
const VISIBILITIES: Visibility[] = ['private', 'public'];

/** Corrupt rows throw rather than quietly loading a game into a wrong state. */
function rowToRoom(row: Row): Room {
  const size = boardSizeFor(row.win_length);
  const cells = deserializeBoard(row.board);
  if (cells.length !== size * size) {
    throw new Error(
      `room ${row.id}: board has ${cells.length} cells, expected ${size * size}`,
    );
  }
  if (row.turn !== 'X' && row.turn !== 'O') {
    throw new Error(`room ${row.id}: invalid turn ${JSON.stringify(row.turn)}`);
  }
  if (!STATUSES.includes(row.status as GameStatus)) {
    throw new Error(`room ${row.id}: invalid status ${JSON.stringify(row.status)}`);
  }
  if (row.winner !== null && row.winner !== 'X' && row.winner !== 'O' && row.winner !== 'draw') {
    throw new Error(`room ${row.id}: invalid winner ${JSON.stringify(row.winner)}`);
  }
  if (row.end_reason !== null && !END_REASONS.includes(row.end_reason as EndReason)) {
    throw new Error(`room ${row.id}: invalid end reason ${JSON.stringify(row.end_reason)}`);
  }
  if (!VISIBILITIES.includes(row.visibility as Visibility)) {
    throw new Error(`room ${row.id}: invalid visibility ${JSON.stringify(row.visibility)}`);
  }

  return {
    id: row.id,
    winLength: row.win_length,
    visibility: row.visibility as Visibility,
    size,
    cells,
    turn: row.turn as Mark,
    status: row.status as GameStatus,
    winner: row.winner as Outcome | null,
    endReason: row.end_reason as EndReason | null,
    winLine: row.win_line === null ? null : (JSON.parse(row.win_line) as number[]),
    seats: { X: row.player_x, O: row.player_o },
    createdAt: row.created_at,
    turnDeadline: row.turn_deadline,
  };
}

export class RoomStore {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // WAL keeps a reader (a reload) from blocking the write of a move.
    if (path !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  /** Brings a database created before a column existed up to the current shape. */
  #migrate(): void {
    const columns = this.#db.prepare('PRAGMA table_info(rooms)').all() as unknown as Array<{
      name: string;
    }>;
    const have = new Set(columns.map((column) => column.name));
    if (!have.has('turn_deadline')) {
      this.#db.exec('ALTER TABLE rooms ADD COLUMN turn_deadline INTEGER');
    }
    // Rooms from before the flag cannot be told apart, so they take the safe side.
    if (!have.has('visibility')) {
      this.#db.exec("ALTER TABLE rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
    }
    // A game that ended before the reason was recorded keeps a null one, which
    // the client renders as the plain result it used to show.
    if (!have.has('end_reason')) {
      this.#db.exec('ALTER TABLE rooms ADD COLUMN end_reason TEXT');
    }
  }

  loadAll(): Map<string, Room> {
    const rows = this.#db.prepare('SELECT * FROM rooms').all() as unknown as Row[];
    return new Map(rows.map((row) => [row.id, rowToRoom(row)]));
  }

  save(room: Room): void {
    this.#db
      .prepare(UPSERT)
      .run(
        room.id,
        room.winLength,
        serializeBoard(room.cells),
        room.turn,
        room.status,
        room.winner,
        room.endReason,
        room.winLine === null ? null : JSON.stringify(room.winLine),
        room.seats.X,
        room.seats.O,
        room.createdAt,
        room.turnDeadline,
        room.visibility,
      );
  }

  remove(id: string): void {
    this.#db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }

  close(): void {
    this.#db.close();
  }
}
