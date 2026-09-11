/**
 * Why a game ended, not just who won. A forfeit or a flag fall leaves a board
 * that does not explain the result — the winner may not have played a single
 * move — so the state carries the reason and the client can say so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startGameServer, type GameServer } from '../src/server/index.ts';
import { applyPlayerMove, createRoom, joinRoom } from '../src/server/rooms.ts';
import { TestClient } from './helpers/client.ts';

async function serverOn(t: test.TestContext, options = {}): Promise<GameServer> {
  const server = await startGameServer(options);
  t.after(() => server.close());
  return server;
}

/** Two players seated in the same room, X first. */
async function seated(t: test.TestContext, port: number, roomId: string) {
  const x = await TestClient.connect(port);
  const o = await TestClient.connect(port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId, playerId: 'px' });
  const size = (await x.next('joined')).state.size;
  o.send({ type: 'join', roomId, playerId: 'po' });
  await o.next('joined');
  await x.next('state');
  return { x, o, size };
}

test('a player leaving a game in progress ends it as a forfeit', async (t) => {
  const { port } = await serverOn(t);
  const { x, o } = await seated(t, port, 'ER1');

  // Nobody has moved: exactly the case where "You win." explains nothing.
  o.send({ type: 'leave' });
  const after = await x.next('state');

  assert.equal(after.state.status, 'over');
  assert.equal(after.state.winner, 'X');
  assert.equal(after.state.endReason, 'forfeit');
  assert.equal(after.state.winLine, null, 'nothing was won on the board');
  assert.match(after.state.board, /^\.+$/, 'the board is still empty');
});

test('running out of time ends it as a timeout, not as a line', async (t) => {
  const { port } = await serverOn(t, { turnMs: 80 });
  const { x } = await seated(t, port, 'ER2');

  const timedOut = await x.next('state', 2000);
  assert.equal(timedOut.state.status, 'over');
  assert.equal(timedOut.state.winner, 'O', 'X was on the clock');
  assert.equal(timedOut.state.endReason, 'timeout');
  assert.equal(timedOut.state.winLine, null);
});

test('a win on the board is reported as a line, with the winning cells', async (t) => {
  const { port } = await serverOn(t);
  const { x, o, size } = await seated(t, port, 'ER3');

  let last = null;
  for (const [who, index] of [
    [x, 0],
    [o, 5 * size],
    [x, 1],
    [o, 5 * size + 1],
    [x, 2],
  ] as const) {
    who.send({ type: 'move', index });
    last = await x.next('state');
    await o.next('state');
  }

  assert.notEqual(last, null);
  assert.equal(last!.state.status, 'over');
  assert.equal(last!.state.winner, 'X');
  assert.equal(last!.state.endReason, 'line');
  assert.deepEqual(last!.state.winLine, [0, 1, 2]);

  x.send({ type: 'rematch' });
  const fresh = await x.next('state');
  assert.equal(fresh.state.status, 'playing');
  assert.equal(fresh.state.endReason, null, 'a rematch clears the previous reason');
});

test('a full board with no line is reported as a draw', () => {
  // A synthetic board: every cell but one is O, so X's last move completes the
  // board without completing a line. Crafting a real 8x8 draw at win length 3
  // is not possible, and the reason is what is under test.
  const room = createRoom('ER4', 3);
  joinRoom(room, 'px');
  joinRoom(room, 'po');
  room.cells = room.cells.map((_, index) => (index === 0 ? '.' : 'O'));

  applyPlayerMove(room, 'px', 0);

  assert.equal(room.status, 'over');
  assert.equal(room.winner, 'draw');
  assert.equal(room.endReason, 'draw');
});

test('the reason survives a restart, so a refresh still explains the result', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'axon-reason-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'rooms.sqlite');

  const first = await startGameServer({ dbPath });
  const { x, o } = await seated(t, first.port, 'ER5');
  o.send({ type: 'leave' });
  assert.equal((await x.next('state')).state.endReason, 'forfeit');
  await x.close();
  await first.close();

  const second = await serverOn(t, { dbPath });
  const back = await TestClient.connect(second.port);
  t.after(() => back.close());
  back.send({ type: 'join', roomId: 'ER5', playerId: 'px' });
  const rejoined = await back.next('joined');

  assert.equal(rejoined.state.status, 'over');
  assert.equal(rejoined.state.winner, 'X');
  assert.equal(rejoined.state.endReason, 'forfeit');
});
