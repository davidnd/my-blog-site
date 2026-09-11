/**
 * OPEN_QUESTIONS.md #4: rooms nobody came back to are swept after 24h. The TTL
 * is injectable so the test does not have to wait a day.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RoomStore } from '../src/server/db.ts';
import { startGameServer } from '../src/server/index.ts';
import { TestClient } from './helpers/client.ts';

async function tempDbPath(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'axon-sweep-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'rooms.sqlite');
}

test('an abandoned room is swept from disk on the next boot', async (t) => {
  const dbPath = await tempDbPath(t);

  const first = await startGameServer({ dbPath });
  const player = await TestClient.connect(first.port);
  player.send({ type: 'join', roomId: 'OLD', playerId: 'p' });
  await player.next('joined');
  await player.close();
  await first.close();

  // Nobody is connected, and the TTL has effectively passed.
  const second = await startGameServer({ dbPath, roomTtlMs: 0 });
  t.after(() => second.close());

  const store = new RoomStore(dbPath);
  t.after(() => store.close());
  assert.equal(store.loadAll().size, 0, 'the abandoned room should be gone from storage');
});

test('a room with someone still connected is never swept', async (t) => {
  const dbPath = await tempDbPath(t);
  // TTL of zero means every room is instantly old enough to sweep.
  const server = await startGameServer({ dbPath, roomTtlMs: 0 });
  t.after(() => server.close());

  const x = await TestClient.connect(server.port);
  const o = await TestClient.connect(server.port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId: 'LIVE', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'LIVE', playerId: 'po' });
  await o.next('joined');

  x.send({ type: 'move', index: 0 });
  const after = await o.next('state');
  assert.equal(after.state.board[0], 'X', 'the live game must still work');
});

test('a fresh room is kept across a restart', async (t) => {
  const dbPath = await tempDbPath(t);
  const first = await startGameServer({ dbPath });
  const player = await TestClient.connect(first.port);
  player.send({ type: 'join', roomId: 'FRESH', playerId: 'p' });
  await player.next('joined');
  await player.close();
  await first.close();

  // Default TTL is a day, so a room made seconds ago survives.
  const second = await startGameServer({ dbPath });
  t.after(() => second.close());
  const back = await TestClient.connect(second.port);
  t.after(() => back.close());

  back.send({ type: 'join', roomId: 'FRESH', playerId: 'p' });
  assert.equal((await back.next('joined')).role, 'X', 'the seat should still be held');
});
