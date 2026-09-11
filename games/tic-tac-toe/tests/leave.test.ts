/**
 * Leaving a room gives the seat back. Without this, a player who left for good
 * still counted as present, so the other player's rematch started a clocked
 * game against nobody and no one else could take the empty chair.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startGameServer } from '../src/server/index.ts';
import { TestClient } from './helpers/client.ts';

async function twoPlayers(t: test.TestContext, roomId: string) {
  const server = await startGameServer({});
  t.after(() => server.close());

  const x = await TestClient.connect(server.port);
  const o = await TestClient.connect(server.port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId, playerId: 'px' });
  const size = (await x.next('joined')).state.size;
  o.send({ type: 'join', roomId, playerId: 'po' });
  await o.next('joined');
  await x.next('state');
  return { server, x, o, size };
}

/** Plays to an X win in the top-left corner. */
async function finish(x: TestClient, o: TestClient, size: number) {
  for (const [who, index] of [
    [x, 0],
    [o, 5 * size],
    [x, 1],
    [o, 5 * size + 1],
    [x, 2],
  ] as const) {
    who.send({ type: 'move', index });
    await x.next('state');
    await o.next('state');
  }
}

test('after the opponent leaves, a rematch waits for a new player instead of starting alone', async (t) => {
  const { server, x, o, size } = await twoPlayers(t, 'LV1');
  await finish(x, o, size);

  o.send({ type: 'leave' });
  const afterLeave = await x.next('state');
  assert.equal(afterLeave.state.seatsTaken.O, false, 'the seat is released');

  x.send({ type: 'rematch' });
  const rematched = await x.next('state');
  assert.equal(rematched.state.status, 'waiting');
  assert.equal(rematched.state.turnDeadline, null, 'no clock runs against an empty chair');

  // Someone opening the invite link takes the empty seat and the game starts.
  const friend = await TestClient.connect(server.port);
  t.after(() => friend.close());
  friend.send({ type: 'join', roomId: 'LV1', playerId: 'pf' });
  const joined = await friend.next('joined');
  assert.equal(joined.role, 'O');
  assert.equal(joined.state.status, 'playing');
  assert.equal((await x.next('state')).state.status, 'playing');

  // The player who left is no longer in the room: their socket cannot act on it.
  o.send({ type: 'rematch' });
  assert.match((await o.next('error')).message, /join a room first/);
});

test('leaving mid-game forfeits it to the opponent', async (t) => {
  const { x, o } = await twoPlayers(t, 'LV2');
  x.send({ type: 'move', index: 0 });
  await x.next('state');
  await o.next('state');

  x.send({ type: 'leave' });
  const forO = await o.next('state');
  assert.equal(forO.state.status, 'over');
  assert.equal(forO.state.winner, 'O');
  assert.equal(forO.state.turnDeadline, null);
  assert.equal(forO.state.seatsTaken.X, false);

  // The leaver does not hear about it — they are gone.
  await x.expectSilence();
});

test('leaving a room you were waiting in frees it for the next host', async (t) => {
  const server = await startGameServer({});
  t.after(() => server.close());
  const host = await TestClient.connect(server.port);
  t.after(() => host.close());

  host.send({ type: 'join', roomId: 'LV3', playerId: 'ph' });
  await host.next('joined');
  host.send({ type: 'leave' });
  await host.expectSilence();

  const next = await TestClient.connect(server.port);
  t.after(() => next.close());
  next.send({ type: 'join', roomId: 'LV3', playerId: 'pn' });
  assert.equal((await next.next('joined')).role, 'X');
});

test('a spectator can leave without touching the game', async (t) => {
  const { server, x, o } = await twoPlayers(t, 'LV4');
  const watcher = await TestClient.connect(server.port);
  t.after(() => watcher.close());
  watcher.send({ type: 'join', roomId: 'LV4', playerId: 'pw' });
  assert.equal((await watcher.next('joined')).role, 'spectator');
  await x.next('state');
  await o.next('state');

  watcher.send({ type: 'leave' });
  await x.expectSilence();

  x.send({ type: 'move', index: 0 });
  assert.equal((await o.next('state')).state.status, 'playing');
});
