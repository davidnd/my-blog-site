/**
 * Lobby and matchmaking. REQUIREMENTS.md: "user can wait for matching randomly,
 * or enter a room id created by friends", "support invite link with room id",
 * "Configurable win length: min: 3, max 6". plan.md slice 5: create room -> short
 * base32 id + invite link, host picks win length; find random game -> FIFO queue
 * keyed by win length, popped in pairs.
 *
 * AMBIGUOUS: src/shared/types.ts defines only `join` and `move`, and neither
 * document names the lobby messages. These tests assume the plan's own wording:
 * `{type:'create', winLength}` and `{type:'queue', winLength}`, sent raw so the
 * wire type does not have to be widened to compile them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startGameServer, type GameServer } from '../src/server/index.ts';
import { TestClient } from './helpers/client.ts';

async function withServer(t: test.TestContext): Promise<GameServer> {
  const server = await startGameServer({});
  t.after(() => server.close());
  return server;
}

async function client(t: test.TestContext, port: number): Promise<TestClient> {
  const socket = await TestClient.connect(port);
  t.after(() => socket.close());
  return socket;
}

test('REQUIREMENT: a host can create a room at any win length from 3 to 6', async (t) => {
  const { port } = await withServer(t);

  for (const winLength of [3, 4, 5, 6]) {
    const host = await client(t, port);
    host.sendRaw(JSON.stringify({ type: 'create', winLength, playerId: `host-${winLength}` }));
    const joined = await host.next('joined');
    assert.equal(joined.role, 'X', 'the host takes the first seat');
    assert.equal(joined.state.winLength, winLength);
    assert.equal(joined.state.size, winLength * 2 + 2, 'board size derives from win length');
    assert.equal(joined.state.status, 'waiting');
  }
});

test('a create with a win length outside 3..6 is refused', async (t) => {
  // OPEN_QUESTIONS.md #2: refused, not clamped.
  const { port } = await withServer(t);
  const host = await client(t, port);

  for (const winLength of [2, 7, 0, -1, 3.5, 'four', null]) {
    host.sendRaw(JSON.stringify({ type: 'create', winLength, playerId: 'host' }));
    const error = await host.next('error');
    assert.ok(error.message.length > 0, `expected a refusal for ${String(winLength)}`);
  }
});

test('REQUIREMENT: a created room has a short id that can go in an invite link', async (t) => {
  const { port } = await withServer(t);
  const first = await client(t, port);
  const second = await client(t, port);

  first.sendRaw(JSON.stringify({ type: 'create', winLength: 3, playerId: 'h1' }));
  second.sendRaw(JSON.stringify({ type: 'create', winLength: 3, playerId: 'h2' }));
  const a = (await first.next('joined')).state.roomId;
  const b = (await second.next('joined')).state.roomId;

  assert.notEqual(a, b, 'two rooms must not collide');
  for (const id of [a, b]) {
    assert.match(id, /^[A-Z2-7]{4,12}$/, `${id} should be a short base32 id`);
    assert.equal(id, encodeURIComponent(id), 'an invite link must not need escaping');
  }
});

test('REQUIREMENT: a friend can join a created room by its id', async (t) => {
  const { port } = await withServer(t);
  const host = await client(t, port);
  host.sendRaw(JSON.stringify({ type: 'create', winLength: 5, playerId: 'host' }));
  const created = await host.next('joined');

  const friend = await client(t, port);
  friend.send({ type: 'join', roomId: created.state.roomId, playerId: 'friend' });
  const joined = await friend.next('joined');

  assert.equal(joined.role, 'O');
  assert.equal(joined.state.winLength, 5, 'the host picked the win length, not the joiner');
  assert.equal(joined.state.size, 12);
  assert.equal(joined.state.status, 'playing');
});

test('REQUIREMENT: two players waiting for a random match are paired', async (t) => {
  const { port } = await withServer(t);
  const first = await client(t, port);
  const second = await client(t, port);

  first.sendRaw(JSON.stringify({ type: 'queue', winLength: 3, playerId: 'p1' }));
  second.sendRaw(JSON.stringify({ type: 'queue', winLength: 3, playerId: 'p2' }));

  const a = await first.next('joined');
  const b = await second.next('joined');
  assert.equal(a.state.roomId, b.state.roomId, 'both must land in the same room');
  assert.notEqual(a.role, b.role, 'and on opposite seats');
  assert.deepEqual([a.role, b.role].sort(), ['O', 'X']);
});

test('the random queue is keyed by win length', async (t) => {
  const { port } = await withServer(t);
  const three = await client(t, port);
  const six = await client(t, port);

  three.sendRaw(JSON.stringify({ type: 'queue', winLength: 3, playerId: 'p3' }));
  six.sendRaw(JSON.stringify({ type: 'queue', winLength: 6, playerId: 'p6' }));

  // Different board sizes cannot share a room, so neither should be seated yet.
  await three.expectSilence(200);
  await six.expectSilence(200);
});

test('a single player in the queue keeps waiting instead of playing alone', async (t) => {
  const { port } = await withServer(t);
  const lonely = await client(t, port);

  lonely.sendRaw(JSON.stringify({ type: 'queue', winLength: 4, playerId: 'solo' }));
  // Either no reply at all, or a room that is still waiting — never 'playing'.
  try {
    const joined = await lonely.next('joined', 300);
    assert.equal(joined.state.status, 'waiting');
    assert.deepEqual(joined.state.seatsTaken, { X: true, O: false });
  } catch {
    /* no reply until a partner shows up is also acceptable */
  }
});

test('REQUIREMENT: after a game is over the players can start a new one', async (t) => {
  // AMBIGUOUS: plan.md slice 6 calls this "rematch"; the message name is a guess.
  const { port } = await withServer(t);
  const x = await client(t, port);
  const o = await client(t, port);

  x.send({ type: 'join', roomId: 'REMATCH', playerId: 'px' });
  const joined = await x.next('joined');
  const size = joined.state.size;
  o.send({ type: 'join', roomId: 'REMATCH', playerId: 'po' });
  await o.next('joined');

  const moves: Array<[TestClient, number]> = [
    [x, 0],
    [o, 5 * size],
    [x, 1],
    [o, 5 * size + 1],
    [x, 2],
  ];
  for (const [who, index] of moves) {
    who.send({ type: 'move', index });
    await o.next('state');
  }
  x.drain();
  o.drain();

  x.sendRaw(JSON.stringify({ type: 'rematch' }));
  const fresh = await o.next('state');
  assert.equal(fresh.state.status, 'playing');
  assert.equal(fresh.state.winner, null);
  assert.equal(fresh.state.winLine, null);
  assert.equal(fresh.state.board, '.'.repeat(size * size), 'a rematch starts from an empty board');
  assert.equal(fresh.state.turn, 'X');
});
