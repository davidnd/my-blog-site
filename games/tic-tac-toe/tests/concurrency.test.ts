/**
 * Two players on separate machines means messages can arrive back-to-back with
 * no round trip in between. The server is the only authority (plan.md), so
 * these check the invariants hold when clients do not wait their turn politely.
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

const countOf = (board: string, mark: string) => [...board].filter((c) => c === mark).length;

test('simultaneous joins hand out exactly one X, one O and the rest spectate', async (t) => {
  const { port } = await withServer(t);
  const clients = await Promise.all([1, 2, 3, 4].map(() => TestClient.connect(port)));
  t.after(() => Promise.all(clients.map((c) => c.close())));

  // All four fire at once, before anyone has heard a reply.
  clients.forEach((c, i) => c.send({ type: 'join', roomId: 'RACE', playerId: `p${i}` }));
  const roles = await Promise.all(clients.map(async (c) => (await c.next('joined')).role));

  assert.equal(roles.filter((r) => r === 'X').length, 1, `roles were ${roles.join(',')}`);
  assert.equal(roles.filter((r) => r === 'O').length, 1, `roles were ${roles.join(',')}`);
  assert.equal(roles.filter((r) => r === 'spectator').length, 2);
});

test('a player firing two moves without waiting only lands the first', async (t) => {
  const { port } = await withServer(t);
  const x = await TestClient.connect(port);
  const o = await TestClient.connect(port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId: 'DOUBLEFIRE', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'DOUBLEFIRE', playerId: 'po' });
  await o.next('joined');
  o.drain();

  x.send({ type: 'move', index: 0 });
  x.send({ type: 'move', index: 1 });

  assert.match((await x.next('error')).message, /turn/i);
  const state = (await o.next('state')).state;
  assert.equal(countOf(state.board, 'X'), 1, 'only one of the two moves may land');
  assert.equal(state.board[0], 'X');
  assert.equal(state.turn, 'O');
  await o.expectSilence();
});

test('both players racing for the same cell leaves exactly one mark', async (t) => {
  const { port } = await withServer(t);
  const x = await TestClient.connect(port);
  const o = await TestClient.connect(port);
  const watcher = await TestClient.connect(port);
  t.after(() => Promise.all([x.close(), o.close(), watcher.close()]));

  x.send({ type: 'join', roomId: 'SAMECELL', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'SAMECELL', playerId: 'po' });
  await o.next('joined');
  watcher.send({ type: 'join', roomId: 'SAMECELL', playerId: 'pw' });
  await watcher.next('joined');
  watcher.drain();

  x.send({ type: 'move', index: 12 });
  o.send({ type: 'move', index: 12 });

  assert.match((await o.next('error')).message, /./);
  const state = (await watcher.next('state')).state;
  assert.equal(state.board[12], 'X', 'the player whose turn it was wins the race');
  assert.equal(countOf(state.board, 'X') + countOf(state.board, 'O'), 1);
  await watcher.expectSilence();
});
