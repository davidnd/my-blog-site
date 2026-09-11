/**
 * WebSocket protocol: join/move dispatch, error paths, and the reconnection
 * behaviour REQUIREMENTS.md asks for ("game survive browser refresh or
 * reconnection"). Everything here goes over a real socket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startGameServer, type GameServer } from '../src/server/index.ts';
import type { GameState } from '../src/shared/types.ts';
import { TestClient } from './helpers/client.ts';

/**
 * Consumes state broadcasts until one satisfies `predicate`. Joins and moves
 * both fan state out, so a client's queue can hold older snapshots; this waits
 * for the one the assertion is about instead of assuming it is first.
 */
async function stateUntil(
  client: TestClient,
  predicate: (state: GameState) => boolean,
  timeoutMs = 2000,
): Promise<GameState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timed out waiting for a matching state');
    const message = await client.next('state', remaining);
    if (predicate(message.state)) return message.state;
  }
}

async function withServer(t: test.TestContext): Promise<GameServer> {
  const server = await startGameServer({});
  t.after(() => server.close());
  return server;
}

/** Seats two players in a room and returns them once the game is playing. */
async function seatedPair(
  t: test.TestContext,
  port: number,
  roomId: string,
): Promise<{ x: TestClient; o: TestClient; size: number }> {
  const x = await TestClient.connect(port);
  const o = await TestClient.connect(port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId, playerId: 'player-x' });
  const first = await x.next('joined');
  assert.equal(first.role, 'X');
  o.send({ type: 'join', roomId, playerId: 'player-o' });
  const second = await o.next('joined');
  assert.equal(second.role, 'O');
  assert.equal((await x.next('state')).state.status, 'playing');
  x.drain();
  o.drain();
  return { x, o, size: first.state.size };
}

test('REQUIREMENT: a reconnecting player gets their seat and the live board back', async (t) => {
  const { port } = await withServer(t);
  const { x, o, size } = await seatedPair(t, port, 'RECONNECT');

  x.send({ type: 'move', index: 0 });
  const beforeDrop = (await o.next('state')).state;
  assert.equal(beforeDrop.board[0], 'X');

  // The browser goes away entirely — tab closed, wifi dropped, refresh.
  await x.close();

  const reborn = await TestClient.connect(port);
  t.after(() => reborn.close());
  reborn.send({ type: 'join', roomId: 'RECONNECT', playerId: 'player-x' });
  const rejoined = await reborn.next('joined');

  assert.equal(rejoined.role, 'X', 'the same playerId must get the same seat');
  assert.deepEqual(rejoined.state, beforeDrop, 'state must survive the reconnect');
});

test('REQUIREMENT: a reconnected player can keep playing and still receives updates', async (t) => {
  const { port } = await withServer(t);
  const { x, o } = await seatedPair(t, port, 'RESUME');

  x.send({ type: 'move', index: 0 });
  await o.next('state');
  await x.close();

  const reborn = await TestClient.connect(port);
  t.after(() => reborn.close());
  reborn.send({ type: 'join', roomId: 'RESUME', playerId: 'player-x' });
  await reborn.next('joined');

  // The opponent moves: the new socket must be subscribed to the room.
  o.send({ type: 'move', index: 1 });
  const seen = await stateUntil(reborn, (state) => state.board[1] === 'O');
  assert.equal(seen.turn, 'X');

  // And the reconnected player's own move is accepted.
  reborn.send({ type: 'move', index: 2 });
  const afterOwnMove = await stateUntil(o, (state) => state.board[2] !== '.');
  assert.equal(afterOwnMove.board[2], 'X');
  assert.equal(afterOwnMove.turn, 'O');
});

test('an opponent disconnecting does not destroy the room or the game', async (t) => {
  // OPEN_QUESTIONS.md #5: no special handling, the room stays alive.
  const { port } = await withServer(t);
  const { x, o } = await seatedPair(t, port, 'ABANDONED');

  x.send({ type: 'move', index: 0 });
  await o.next('state');
  await o.close();

  const watcher = await TestClient.connect(port);
  t.after(() => watcher.close());
  watcher.send({ type: 'join', roomId: 'ABANDONED', playerId: 'player-o' });
  const rejoined = await watcher.next('joined');
  assert.equal(rejoined.role, 'O');
  assert.equal(rejoined.state.status, 'playing');
  assert.equal(rejoined.state.board[0], 'X');
});

test('a move sent before joining is refused', async (t) => {
  const { port } = await withServer(t);
  const client = await TestClient.connect(port);
  t.after(() => client.close());

  client.send({ type: 'move', index: 0 });
  const error = await client.next('error');
  assert.ok(error.message.length > 0);

  // The socket still works afterwards.
  client.send({ type: 'join', roomId: 'LATE', playerId: 'p' });
  assert.equal((await client.next('joined')).role, 'X');
});

test('a join with missing or malformed fields is refused without dropping the socket', async (t) => {
  const { port } = await withServer(t);
  const client = await TestClient.connect(port);
  t.after(() => client.close());

  const bad = [
    { type: 'join' },
    { type: 'join', roomId: 'R' },
    { type: 'join', playerId: 'p' },
    { type: 'join', roomId: 42, playerId: 'p' },
    { type: 'join', roomId: 'R', playerId: null },
    { type: 'join', roomId: '', playerId: 'p' }, // AMBIGUOUS: empty id treated as invalid
  ];
  for (const message of bad) {
    client.sendRaw(JSON.stringify(message));
    const error = await client.next('error');
    assert.ok(error.message.length > 0, `expected an error for ${JSON.stringify(message)}`);
  }

  client.send({ type: 'join', roomId: 'AFTERBAD', playerId: 'p' });
  assert.equal((await client.next('joined')).role, 'X');
});

test('a move with a malformed index is refused and nothing is broadcast', async (t) => {
  const { port } = await withServer(t);
  const { x, o, size } = await seatedPair(t, port, 'BADINDEX');

  for (const index of [-1, size * size, 1.5, 'three', null, undefined, Number.NaN]) {
    x.sendRaw(JSON.stringify({ type: 'move', index }));
    const error = await x.next('error');
    assert.ok(error.message.length > 0, `expected an error for index ${String(index)}`);
  }

  await o.expectSilence();
});

test('rooms are isolated from each other', async (t) => {
  const { port } = await withServer(t);
  const a = await seatedPair(t, port, 'ROOM-A');
  const b = await seatedPair(t, port, 'ROOM-B');

  a.x.send({ type: 'move', index: 0 });
  assert.equal((await a.o.next('state')).state.board[0], 'X');
  await b.x.expectSilence();

  b.x.send({ type: 'move', index: 5 });
  const bState = (await b.o.next('state')).state;
  assert.equal(bState.roomId, 'ROOM-B');
  assert.equal(bState.board[0], '.');
  assert.equal(bState.board[5], 'X');
});

test('REQUIREMENT: joining a friend-supplied room id puts both players in that room', async (t) => {
  const { port } = await withServer(t);
  const { x, o } = await seatedPair(t, port, 'FRIENDS1');

  x.send({ type: 'move', index: 3 });
  const state = (await o.next('state')).state;
  assert.equal(state.roomId, 'FRIENDS1');
  assert.deepEqual(state.seatsTaken, { X: true, O: true });
});

test('both players are told about every move, including the mover', async (t) => {
  const { port } = await withServer(t);
  const { x, o } = await seatedPair(t, port, 'BROADCAST');

  x.send({ type: 'move', index: 7 });
  const forMover = await x.next('state');
  const forOpponent = await o.next('state');
  assert.deepEqual(forMover.state, forOpponent.state);
  assert.equal(forMover.state.board[7], 'X');
});

test('a second socket using the same playerId shares the seat rather than taking a new one', async (t) => {
  // A refresh can leave the old socket briefly open; the spec's identity model
  // says the seat belongs to the playerId, not the socket.
  const { port } = await withServer(t);
  const { x, o } = await seatedPair(t, port, 'DOUBLE');

  const twin = await TestClient.connect(port);
  t.after(() => twin.close());
  twin.send({ type: 'join', roomId: 'DOUBLE', playerId: 'player-x' });
  assert.equal((await twin.next('joined')).role, 'X');

  twin.send({ type: 'move', index: 4 });
  const seenByOpponent = await stateUntil(o, (state) => state.board[4] !== '.');
  assert.equal(seenByOpponent.board[4], 'X');
  const seenByOriginal = await stateUntil(x, (state) => state.board[4] !== '.');
  assert.equal(seenByOriginal.turn, 'O');
});

test('the same socket can move on to another room', async (t) => {
  const { port } = await withServer(t);
  const client = await TestClient.connect(port);
  t.after(() => client.close());

  client.send({ type: 'join', roomId: 'FIRST', playerId: 'p' });
  assert.equal((await client.next('joined')).state.roomId, 'FIRST');

  client.send({ type: 'join', roomId: 'SECOND', playerId: 'p' });
  const second = await client.next('joined');
  assert.equal(second.state.roomId, 'SECOND');
  assert.equal(second.state.board, '.'.repeat(second.state.size * second.state.size));
});

test('every server message is one of the three documented types', async (t) => {
  const { port } = await withServer(t);
  const client = await TestClient.connect(port);
  t.after(() => client.close());

  client.send({ type: 'join', roomId: 'SHAPE', playerId: 'p' });
  const joined = await client.next('joined');
  assert.ok(['X', 'O', 'spectator'].includes(joined.role));
  const state = joined.state;
  assert.equal(typeof state.roomId, 'string');
  assert.equal(typeof state.winLength, 'number');
  assert.equal(typeof state.size, 'number');
  assert.equal(state.board.length, state.size * state.size);
  assert.ok(['waiting', 'playing', 'over'].includes(state.status));
  assert.ok(['X', 'O'].includes(state.turn));
  assert.equal(state.winner, null);
  assert.equal(state.winLine, null);
});
