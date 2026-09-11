import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startGameServer } from '../src/server/index.ts';
import { TestClient } from './helpers/client.ts';

async function tempDbPath(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'axon-reconnect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'rooms.sqlite');
}

/** Seats both players and plays one move each, so there is real state to lose. */
async function playedGame(port: number, t: test.TestContext) {
  const alice = await TestClient.connect(port);
  const bob = await TestClient.connect(port);
  t.after(() => Promise.all([alice.close(), bob.close()]));

  alice.send({ type: 'join', roomId: 'R1', playerId: 'alice' });
  await alice.next('joined');
  bob.send({ type: 'join', roomId: 'R1', playerId: 'bob' });
  const joined = await bob.next('joined');
  const size = joined.state.size;
  // Await each broadcast in order rather than draining, which would race the
  // "game started" message still in flight to Alice.
  assert.equal((await alice.next('state')).state.status, 'playing');

  alice.send({ type: 'move', index: 0 });
  await alice.next('state');
  await bob.next('state');

  bob.send({ type: 'move', index: 5 * size });
  await bob.next('state');
  const after = await alice.next('state');

  return { alice, bob, size, state: after.state };
}

test('REQUIREMENT: a dropped socket rejoins into the same seat and board', async (t) => {
  const server = await startGameServer({ dbPath: await tempDbPath(t) });
  t.after(() => server.close());

  const { alice, state: before } = await playedGame(server.port, t);

  // Alice's browser goes away entirely.
  await alice.close();

  const returning = await TestClient.connect(server.port);
  t.after(() => returning.close());
  returning.send({ type: 'join', roomId: 'R1', playerId: 'alice' });
  const rejoined = await returning.next('joined');

  assert.equal(rejoined.role, 'X', 'Alice must land back in her own seat');
  assert.deepEqual(rejoined.state, before, 'the board must come back unchanged');

  // And she can keep playing.
  returning.send({ type: 'move', index: 1 });
  assert.equal((await returning.next('state')).state.board[1], 'X');
});

test('REQUIREMENT: the game survives a full server restart', async (t) => {
  const dbPath = await tempDbPath(t);
  const first = await startGameServer({ dbPath });
  const { state: before } = await playedGame(first.port, t);
  await first.close();

  // A new process, same database file.
  const second = await startGameServer({ dbPath });
  t.after(() => second.close());

  const alice = await TestClient.connect(second.port);
  const bob = await TestClient.connect(second.port);
  t.after(() => Promise.all([alice.close(), bob.close()]));

  alice.send({ type: 'join', roomId: 'R1', playerId: 'alice' });
  const aliceBack = await alice.next('joined');
  assert.equal(aliceBack.role, 'X');
  assert.deepEqual(aliceBack.state, before);

  bob.send({ type: 'join', roomId: 'R1', playerId: 'bob' });
  assert.equal((await bob.next('joined')).role, 'O');
  await alice.next('state'); // Bob's rejoin is broadcast to Alice

  // The restored game is still playable, and still knows whose turn it is.
  bob.send({ type: 'move', index: 2 });
  assert.match((await bob.next('error')).message, /not your turn/);
  alice.send({ type: 'move', index: 2 });
  assert.equal((await alice.next('state')).state.board[2], 'X');
});

test('a finished game is still finished after a restart', async (t) => {
  const dbPath = await tempDbPath(t);
  const first = await startGameServer({ dbPath });

  const alice = await TestClient.connect(first.port);
  const bob = await TestClient.connect(first.port);
  alice.send({ type: 'join', roomId: 'R2', playerId: 'alice' });
  await alice.next('joined');
  bob.send({ type: 'join', roomId: 'R2', playerId: 'bob' });
  const size = (await bob.next('joined')).state.size;

  for (const [client, index] of [
    [alice, 0],
    [bob, 5 * size],
    [alice, 1],
    [bob, 5 * size + 1],
    [alice, 2],
  ] as const) {
    client.send({ type: 'move', index });
    await alice.next('state');
    await bob.next('state');
  }
  await Promise.all([alice.close(), bob.close()]);
  await first.close();

  const second = await startGameServer({ dbPath });
  t.after(() => second.close());
  const back = await TestClient.connect(second.port);
  t.after(() => back.close());

  back.send({ type: 'join', roomId: 'R2', playerId: 'bob' });
  const joined = await back.next('joined');
  assert.equal(joined.state.status, 'over');
  assert.equal(joined.state.winner, 'X');
  assert.deepEqual(joined.state.winLine, [0, 1, 2]);

  // Requirement: no more moves after game over, restart or not.
  back.send({ type: 'move', index: 5 * size + 2 });
  assert.match((await back.next('error')).message, /game is over/);
});

test('a room created before the restart keeps its free seats available', async (t) => {
  const dbPath = await tempDbPath(t);
  const first = await startGameServer({ dbPath });
  const host = await TestClient.connect(first.port);
  host.send({ type: 'join', roomId: 'R3', playerId: 'host' });
  assert.equal((await host.next('joined')).role, 'X');
  await host.close();
  await first.close();

  const second = await startGameServer({ dbPath });
  t.after(() => second.close());
  const guest = await TestClient.connect(second.port);
  t.after(() => guest.close());

  guest.send({ type: 'join', roomId: 'R3', playerId: 'guest' });
  const joined = await guest.next('joined');
  assert.equal(joined.role, 'O', 'the free seat should still be free');
  assert.equal(joined.state.status, 'playing');
});
