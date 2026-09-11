import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RoomStore } from '../src/server/db.ts';
import { applyPlayerMove, createRoom, joinRoom, type Room } from '../src/server/rooms.ts';

/** A real file, because ':memory:' cannot prove anything survives a reopen. */
async function tempDbPath(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'axon-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'rooms.sqlite');
}

function playedRoom(): Room {
  const room = createRoom('R1', 4, 1700000000000);
  joinRoom(room, 'player-x');
  joinRoom(room, 'player-o');
  applyPlayerMove(room, 'player-x', 0);
  applyPlayerMove(room, 'player-o', 1);
  return room;
}

test('a room survives being written and read back from a new connection', async (t) => {
  const dbPath = await tempDbPath(t);
  const room = playedRoom();

  const writer = new RoomStore(dbPath);
  writer.save(room);
  writer.close();

  const reader = new RoomStore(dbPath);
  const loaded = reader.loadAll().get('R1');
  reader.close();

  assert.deepEqual(loaded, room);
});

test('saving the same room twice updates rather than duplicating it', async (t) => {
  const dbPath = await tempDbPath(t);
  const store = new RoomStore(dbPath);
  t.after(() => store.close());

  const room = playedRoom();
  store.save(room);
  applyPlayerMove(room, 'player-x', 2);
  store.save(room);

  const all = store.loadAll();
  assert.equal(all.size, 1);
  assert.equal(all.get('R1')!.cells[2], 'X');
});

test('a finished game keeps its winner and winning line', async (t) => {
  const dbPath = await tempDbPath(t);
  const room = createRoom('R2', 3);
  joinRoom(room, 'player-x');
  joinRoom(room, 'player-o');
  for (const [player, index] of [
    ['player-x', 0],
    ['player-o', 40],
    ['player-x', 1],
    ['player-o', 41],
    ['player-x', 2],
  ] as const) {
    applyPlayerMove(room, player, index);
  }
  assert.equal(room.status, 'over');

  const store = new RoomStore(dbPath);
  store.save(room);
  const loaded = store.loadAll().get('R2')!;
  store.close();

  assert.equal(loaded.status, 'over');
  assert.equal(loaded.winner, 'X');
  assert.deepEqual(loaded.winLine, [0, 1, 2]);
});

test('an empty room with no players round-trips with null seats', async (t) => {
  const dbPath = await tempDbPath(t);
  const store = new RoomStore(dbPath);
  t.after(() => store.close());

  const room = createRoom('R3', 6);
  store.save(room);
  const loaded = store.loadAll().get('R3')!;

  assert.deepEqual(loaded.seats, { X: null, O: null });
  assert.equal(loaded.winner, null);
  assert.equal(loaded.winLine, null);
  assert.equal(loaded.size, 14);
  assert.equal(loaded.cells.length, 14 * 14);
});

test('remove deletes a room', async (t) => {
  const dbPath = await tempDbPath(t);
  const store = new RoomStore(dbPath);
  t.after(() => store.close());

  store.save(createRoom('R4', 3));
  assert.equal(store.loadAll().size, 1);
  store.remove('R4');
  assert.equal(store.loadAll().size, 0);
});

test('a corrupted row is reported instead of loading a wrong game', async (t) => {
  const dbPath = await tempDbPath(t);
  const store = new RoomStore(dbPath);
  t.after(() => store.close());

  const room = createRoom('R5', 3);
  store.save(room);
  // Truncate the board behind the store's back.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE rooms SET board = 'XO.' WHERE id = 'R5'").run();
  raw.close();

  assert.throws(() => store.loadAll(), /board has 3 cells, expected 64/);
});

test('a public room is still public after a reload', async (t) => {
  const dbPath = await tempDbPath(t);
  const store = new RoomStore(dbPath);
  store.save(createRoom('PUB', 3, Date.now(), 'public'));
  store.save(createRoom('PRV', 3));
  store.close();

  const reader = new RoomStore(dbPath);
  t.after(() => reader.close());
  const rooms = reader.loadAll();
  assert.equal(rooms.get('PUB')?.visibility, 'public');
  assert.equal(rooms.get('PRV')?.visibility, 'private');
});

test('a database from before rooms had a visibility loads them as private', async (t) => {
  const dbPath = await tempDbPath(t);
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, win_length INTEGER NOT NULL, board TEXT NOT NULL,
      turn TEXT NOT NULL, status TEXT NOT NULL, winner TEXT, win_line TEXT,
      player_x TEXT, player_o TEXT, created_at INTEGER NOT NULL, turn_deadline INTEGER
    )`);
  raw
    .prepare(
      "INSERT INTO rooms VALUES ('OLD', 3, ?, 'X', 'waiting', NULL, NULL, 'p1', NULL, 1, NULL)",
    )
    .run('.'.repeat(64));
  raw.close();

  const store = new RoomStore(dbPath);
  t.after(() => store.close());
  assert.equal(store.loadAll().get('OLD')?.visibility, 'private');
});
