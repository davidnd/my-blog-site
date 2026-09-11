/**
 * "Waiting for an opponent" and "Looking for an opponent" must find each other
 * — in a public room. A public room is one the matchmaker opened; a random
 * player drops into one that is waiting with a free seat and a connected host,
 * and a queued player is pulled in the moment such a seat opens. A room made
 * with "Create a room" or an invite link is private: room id only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startGameServer } from '../src/server/index.ts';
import { TestClient } from './helpers/client.ts';

const WIN = 5;

/** Two random players meet, so the room is public; X wins it. Returns both. */
async function finishedGame(t: test.TestContext) {
  const server = await startGameServer({});
  t.after(() => server.close());
  const x = await TestClient.connect(server.port);
  const o = await TestClient.connect(server.port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'queue', winLength: WIN, playerId: 'px' });
  await x.expectSilence();
  o.send({ type: 'queue', winLength: WIN, playerId: 'po' });
  const { roomId, size } = (await o.next('joined')).state;
  assert.equal((await x.next('joined')).role, 'X');
  assert.equal((await x.next('state')).state.status, 'playing');

  // X fills row 0 while O fills row 5.
  for (let i = 0; i < WIN; i++) {
    x.send({ type: 'move', index: i });
    await x.next('state');
    await o.next('state');
    if (i === WIN - 1) break;
    o.send({ type: 'move', index: 5 * size + i });
    await x.next('state');
    await o.next('state');
  }
  return { server, x, o, roomId };
}

test('a random player joins the public room a rematch left waiting', async (t) => {
  const { server, x, o, roomId } = await finishedGame(t);

  o.send({ type: 'leave' });
  await x.next('state');
  x.send({ type: 'rematch' });
  assert.equal((await x.next('state')).state.status, 'waiting');

  const random = await TestClient.connect(server.port);
  t.after(() => random.close());
  random.send({ type: 'queue', winLength: WIN, playerId: 'pr' });
  const joined = await random.next('joined');
  assert.equal(joined.state.roomId, roomId);
  assert.equal(joined.role, 'O');
  assert.equal(joined.state.status, 'playing');
  assert.equal((await x.next('state')).state.status, 'playing');
});

test('a rematch into an empty public seat pulls in a player who was already queued', async (t) => {
  const { server, x, o, roomId } = await finishedGame(t);

  const random = await TestClient.connect(server.port);
  t.after(() => random.close());
  random.send({ type: 'queue', winLength: WIN, playerId: 'pr' });
  await random.expectSilence();

  o.send({ type: 'leave' });
  await x.next('state');
  x.send({ type: 'rematch' });

  const joined = await random.next('joined');
  assert.equal(joined.state.roomId, roomId);
  assert.equal(joined.role, 'O');
  // X hears the rematch and then the arrival; the last word is a live game.
  let last = await x.next('state');
  if (last.state.status === 'waiting') last = await x.next('state');
  assert.equal(last.state.status, 'playing');
  assert.equal(last.state.seatsTaken.O, true);
});

test('a public room only matches players who want the same win length', async (t) => {
  const { server, x, o } = await finishedGame(t);
  o.send({ type: 'leave' });
  await x.next('state');
  x.send({ type: 'rematch' });
  await x.next('state');

  const random = await TestClient.connect(server.port);
  t.after(() => random.close());
  random.send({ type: 'queue', winLength: WIN - 1, playerId: 'pr' });
  await random.expectSilence();
  await x.expectSilence();
});

test('a public room whose host has gone is not offered to a random player', async (t) => {
  const { server, x, o } = await finishedGame(t);
  o.send({ type: 'leave' });
  await x.next('state');
  x.send({ type: 'rematch' });
  await x.next('state');
  await x.close();

  const random = await TestClient.connect(server.port);
  t.after(() => random.close());
  random.send({ type: 'queue', winLength: WIN, playerId: 'pr' });
  await random.expectSilence();
});

test('a room made with "Create a room" is private: random players never land in it', async (t) => {
  const server = await startGameServer({});
  t.after(() => server.close());
  const host = await TestClient.connect(server.port);
  const random = await TestClient.connect(server.port);
  t.after(() => Promise.all([host.close(), random.close()]));

  // Queued before the room exists: the new seat is not offered to them.
  random.send({ type: 'queue', winLength: 3, playerId: 'pr' });
  await random.expectSilence();
  host.send({ type: 'create', winLength: 3, playerId: 'ph' });
  assert.equal((await host.next('joined')).state.status, 'waiting');
  await random.expectSilence();
  // Queued again while it waits: still not let in.
  random.send({ type: 'queue', winLength: 3, playerId: 'pr' });
  await random.expectSilence();
  await host.expectSilence();
});

test('a room opened from an invite link before its host arrives is private too', async (t) => {
  const server = await startGameServer({});
  t.after(() => server.close());
  const friend = await TestClient.connect(server.port);
  const random = await TestClient.connect(server.port);
  t.after(() => Promise.all([friend.close(), random.close()]));

  friend.send({ type: 'join', roomId: 'INVITE', playerId: 'pf' });
  await friend.next('joined');
  random.send({ type: 'queue', winLength: 3, playerId: 'pr' });
  await random.expectSilence();
  await friend.expectSilence();
});

test('a private room stays private through a rematch, and still fills by room id', async (t) => {
  const server = await startGameServer({});
  t.after(() => server.close());
  const x = await TestClient.connect(server.port);
  const o = await TestClient.connect(server.port);
  const random = await TestClient.connect(server.port);
  const friend = await TestClient.connect(server.port);
  t.after(() => Promise.all([x.close(), o.close(), random.close(), friend.close()]));

  x.send({ type: 'create', winLength: 3, playerId: 'px' });
  const { roomId, size } = (await x.next('joined')).state;
  o.send({ type: 'join', roomId, playerId: 'po' });
  await o.next('joined');
  await x.next('state');
  for (const [who, index] of [[x, 0], [o, size], [x, 1], [o, size + 1], [x, 2]] as const) {
    who.send({ type: 'move', index });
    await x.next('state');
    await o.next('state');
  }

  o.send({ type: 'leave' });
  await x.next('state');
  random.send({ type: 'queue', winLength: 3, playerId: 'pr' });
  await random.expectSilence();
  x.send({ type: 'rematch' });
  assert.equal((await x.next('state')).state.status, 'waiting');
  await random.expectSilence();

  friend.send({ type: 'join', roomId, playerId: 'pf' });
  const joined = await friend.next('joined');
  assert.equal(joined.role, 'O');
  assert.equal(joined.state.status, 'playing');
});
