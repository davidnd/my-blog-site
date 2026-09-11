/**
 * Persistence properties that the restart tests in reconnect.test.ts do not
 * cover: plan.md says the store is *write-through* ("every state transition
 * also writes the row"), that the in-memory map is only a working copy, and
 * that a room whose deadline expired while the server was down is resolved at
 * load time rather than granting free thinking time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startGameServer, type GameServer } from '../src/server/index.ts';
import { TestClient } from './helpers/client.ts';

async function tempDbPath(t: test.TestContext, tag = 'persist'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `axon-${tag}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'rooms.sqlite');
}

async function serverOn(t: test.TestContext, dbPath: string): Promise<GameServer> {
  const server = await startGameServer({ dbPath });
  t.after(() => server.close());
  return server;
}

test('every move is written through immediately, not flushed at shutdown', async (t) => {
  const dbPath = await tempDbPath(t, 'writethrough');
  const live = await serverOn(t, dbPath);

  const x = await TestClient.connect(live.port);
  const o = await TestClient.connect(live.port);
  t.after(() => Promise.all([x.close(), o.close()]));
  x.send({ type: 'join', roomId: 'WT', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'WT', playerId: 'po' });
  await o.next('joined');
  x.send({ type: 'move', index: 0 });
  const written = (await o.next('state')).state;
  assert.equal(written.board[0], 'X');

  // A second server reads the same file while the first is still running and
  // has never been asked to shut down. If saving were deferred, this is empty.
  const reader = await serverOn(t, dbPath);
  const peek = await TestClient.connect(reader.port);
  t.after(() => peek.close());
  peek.send({ type: 'join', roomId: 'WT', playerId: 'px' });
  const seen = await peek.next('joined');

  assert.equal(seen.role, 'X');
  assert.equal(seen.state.board, written.board);
  assert.equal(seen.state.turn, 'O');
  assert.equal(seen.state.status, 'playing');
});

test('two servers on different stores do not share rooms', async (t) => {
  const a = await serverOn(t, await tempDbPath(t, 'storeA'));
  const b = await serverOn(t, await tempDbPath(t, 'storeB'));

  const first = await TestClient.connect(a.port);
  const second = await TestClient.connect(b.port);
  t.after(() => Promise.all([first.close(), second.close()]));

  first.send({ type: 'join', roomId: 'SAME-ID', playerId: 'px' });
  assert.equal((await first.next('joined')).role, 'X');

  second.send({ type: 'join', roomId: 'SAME-ID', playerId: 'other' });
  const joined = await second.next('joined');
  assert.equal(joined.role, 'X', 'a separate store means a fresh room');
  assert.equal(joined.state.status, 'waiting');
  assert.deepEqual(joined.state.seatsTaken, { X: true, O: false });
});

test('an in-memory server keeps nothing after it stops', async (t) => {
  const first = await startGameServer({ dbPath: ':memory:' });
  const client = await TestClient.connect(first.port);
  client.send({ type: 'join', roomId: 'EPHEMERAL', playerId: 'px' });
  await client.next('joined');
  await client.close();
  await first.close();

  const second = await serverOn(t, ':memory:');
  const later = await TestClient.connect(second.port);
  t.after(() => later.close());
  later.send({ type: 'join', roomId: 'EPHEMERAL', playerId: 'someone-else' });
  const joined = await later.next('joined');
  assert.equal(joined.role, 'X');
  assert.deepEqual(joined.state.seatsTaken, { X: true, O: false });
});

test('a deadline that expired while the server was down is resolved on load', async (t) => {
  // plan.md: "A room whose turn_deadline already passed while the server was
  // down is resolved as a timeout at load time, so restarts can't hand someone
  // free extra thinking time."
  // AMBIGUOUS: `turnMs` is the assumed name of the injectable turn length from
  // plan.md slice 4.
  const dbPath = await tempDbPath(t, 'deadline');
  type Options = Parameters<typeof startGameServer>[0];
  const first = await startGameServer({ dbPath, turnMs: 50 } as unknown as Options);
  const x = await TestClient.connect(first.port);
  const o = await TestClient.connect(first.port);
  x.send({ type: 'join', roomId: 'STALE', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'STALE', playerId: 'po' });
  await o.next('joined');
  // Stop the server immediately, while X is still on the clock.
  await Promise.all([x.close(), o.close()]);
  await first.close();

  // Come back well after the deadline would have passed.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const second = await serverOn(t, dbPath);
  const reborn = await TestClient.connect(second.port);
  t.after(() => reborn.close());
  reborn.send({ type: 'join', roomId: 'STALE', playerId: 'px' });
  const joined = await reborn.next('joined');

  assert.equal(joined.state.status, 'over', 'the missed deadline must be honoured');
  assert.equal(joined.state.winner, 'O');
});
