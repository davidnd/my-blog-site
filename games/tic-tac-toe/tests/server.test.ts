import test from 'node:test';
import assert from 'node:assert/strict';

import { startGameServer, type GameServer } from '../src/server/index.ts';
import { TestClient } from './helpers/client.ts';

/** Boots a server on an ephemeral port and tears it down with the test. */
async function withServer(t: test.TestContext): Promise<GameServer> {
  const server = await startGameServer({});
  t.after(() => server.close());
  return server;
}

test('two clients play a real game over websockets', async (t) => {
  const { port } = await withServer(t);
  const alice = await TestClient.connect(port);
  const bob = await TestClient.connect(port);
  t.after(() => Promise.all([alice.close(), bob.close()]));

  alice.send({ type: 'join', roomId: 'R1', playerId: 'alice' });
  const aliceJoined = await alice.next('joined');
  assert.equal(aliceJoined.role, 'X');
  assert.equal(aliceJoined.state.status, 'waiting');
  assert.equal(aliceJoined.state.size, 8);

  bob.send({ type: 'join', roomId: 'R1', playerId: 'bob' });
  const bobJoined = await bob.next('joined');
  assert.equal(bobJoined.role, 'O');

  // Alice learns that the game started without having to ask.
  const started = await alice.next('state');
  assert.equal(started.state.status, 'playing');
  assert.equal(started.state.turn, 'X');

  alice.send({ type: 'move', index: 0 });
  const afterMove = await bob.next('state');
  assert.equal(afterMove.state.board[0], 'X');
  assert.equal(afterMove.state.turn, 'O');
});

test('the server rejects a move made out of turn and leaves the board alone', async (t) => {
  const { port } = await withServer(t);
  const alice = await TestClient.connect(port);
  const bob = await TestClient.connect(port);
  t.after(() => Promise.all([alice.close(), bob.close()]));

  alice.send({ type: 'join', roomId: 'R2', playerId: 'alice' });
  await alice.next('joined');
  bob.send({ type: 'join', roomId: 'R2', playerId: 'bob' });
  await bob.next('joined');
  // Alice is told the game started; after that she should hear nothing more.
  assert.equal((await alice.next('state')).state.status, 'playing');

  bob.send({ type: 'move', index: 5 });
  const error = await bob.next('error');
  assert.match(error.message, /not your turn/);

  // Alice was never told about a move, because none happened.
  await alice.expectSilence();
});

test('a spectator sees the game but cannot move', async (t) => {
  const { port } = await withServer(t);
  const alice = await TestClient.connect(port);
  const bob = await TestClient.connect(port);
  const watcher = await TestClient.connect(port);
  t.after(() => Promise.all([alice.close(), bob.close(), watcher.close()]));

  for (const [client, id] of [
    [alice, 'alice'],
    [bob, 'bob'],
    [watcher, 'watcher'],
  ] as const) {
    client.send({ type: 'join', roomId: 'R3', playerId: id });
    await client.next('joined');
  }

  watcher.send({ type: 'move', index: 3 });
  assert.match((await watcher.next('error')).message, /spectators cannot move/);

  // Ignore the state broadcasts the joins already produced.
  watcher.drain();
  alice.send({ type: 'move', index: 3 });
  const seen = await watcher.next('state');
  assert.equal(seen.state.board[3], 'X');
});

test('the board locks for everyone once the game is over', async (t) => {
  const { port } = await withServer(t);
  const alice = await TestClient.connect(port);
  const bob = await TestClient.connect(port);
  t.after(() => Promise.all([alice.close(), bob.close()]));

  alice.send({ type: 'join', roomId: 'R4', playerId: 'alice' });
  await alice.next('joined');
  bob.send({ type: 'join', roomId: 'R4', playerId: 'bob' });
  const { state } = await bob.next('joined');
  const size = state.size;
  alice.drain(); // the "game started" broadcast from Bob's join

  // X takes row 0; O answers on row 5. Win length is 3.
  const moves: Array<[TestClient, number]> = [
    [alice, 0],
    [bob, 5 * size],
    [alice, 1],
    [bob, 5 * size + 1],
    [alice, 2],
  ];
  for (const [client, index] of moves) {
    client.send({ type: 'move', index });
    await alice.next('state');
    await bob.next('state');
  }

  bob.send({ type: 'move', index: 5 * size + 2 });
  assert.match((await bob.next('error')).message, /game is over/);
});

test('a malformed message gets an error rather than killing the connection', async (t) => {
  const { port } = await withServer(t);
  const alice = await TestClient.connect(port);
  t.after(() => alice.close());

  alice.sendRaw('not json at all {');
  assert.match((await alice.next('error')).message, /malformed/);

  alice.sendRaw(JSON.stringify({ type: 'nonsense' }));
  assert.match((await alice.next('error')).message, /unknown message type/);

  // Still usable afterwards.
  alice.send({ type: 'join', roomId: 'R5', playerId: 'alice' });
  assert.equal((await alice.next('joined')).role, 'X');
});
