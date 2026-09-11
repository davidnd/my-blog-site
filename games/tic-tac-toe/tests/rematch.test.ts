/**
 * REQUIREMENTS.md: "No more moves can be done after game over. user must play a
 * new game." A rematch is how that new game starts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startGameServer } from '../src/server/index.ts';
import { TestClient } from './helpers/client.ts';

/** Plays a room to an X win and returns the clients plus the board size. */
async function finishedGame(t: test.TestContext, roomId: string) {
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
  return { server, x, o, size };
}

test('a rematch clears the board and restarts the clock for both players', async (t) => {
  const { x, o, size } = await finishedGame(t, 'RM1');

  x.sendRaw(JSON.stringify({ type: 'rematch' }));
  const forX = await x.next('state');
  const forO = await o.next('state');

  for (const state of [forX.state, forO.state]) {
    assert.equal(state.board, '.'.repeat(size * size));
    assert.equal(state.status, 'playing');
    assert.equal(state.winner, null);
    assert.equal(state.winLine, null);
    assert.equal(state.turn, 'X');
    assert.notEqual(state.turnDeadline, null, 'the new game gets a fresh clock');
  }

  // And the new game is actually playable.
  x.send({ type: 'move', index: 7 });
  assert.equal((await o.next('state')).state.board[7], 'X');
});

test('either player can call the rematch, and seats do not move', async (t) => {
  const { x, o } = await finishedGame(t, 'RM2');

  // The loser asks this time.
  o.sendRaw(JSON.stringify({ type: 'rematch' }));
  await x.next('state');
  await o.next('state');

  // X still holds X: O moving first is refused.
  o.send({ type: 'move', index: 3 });
  assert.match((await o.next('error')).message, /not your turn/);
  x.send({ type: 'move', index: 3 });
  assert.equal((await x.next('state')).state.board[3], 'X');
});

test('a rematch is refused while a game is still going', async (t) => {
  const server = await startGameServer({});
  t.after(() => server.close());
  const x = await TestClient.connect(server.port);
  const o = await TestClient.connect(server.port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId: 'RM3', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'RM3', playerId: 'po' });
  await o.next('joined');

  x.sendRaw(JSON.stringify({ type: 'rematch' }));
  assert.match((await x.next('error')).message, /still going/);

  // The game in progress is untouched.
  x.send({ type: 'move', index: 0 });
  assert.equal((await o.next('state')).state.board[0], 'X');
});

test('a spectator cannot start a new game for the players', async (t) => {
  const { server, x } = await finishedGame(t, 'RM4');

  const watcher = await TestClient.connect(server.port);
  t.after(() => watcher.close());
  watcher.send({ type: 'join', roomId: 'RM4', playerId: 'watcher' });
  assert.equal((await watcher.next('joined')).role, 'spectator');

  watcher.sendRaw(JSON.stringify({ type: 'rematch' }));
  assert.match((await watcher.next('error')).message, /spectators cannot/);

  // The finished game is still finished.
  x.drain();
  x.sendRaw(JSON.stringify({ type: 'rematch' }));
  assert.equal((await x.next('state')).state.status, 'playing');
});

test('a rematch survives a reconnect', async (t) => {
  const { server, x, o, size } = await finishedGame(t, 'RM5');

  x.sendRaw(JSON.stringify({ type: 'rematch' }));
  await x.next('state');
  await o.next('state');
  x.send({ type: 'move', index: 4 });
  await x.next('state');
  await o.close();

  const back = await TestClient.connect(server.port);
  t.after(() => back.close());
  back.send({ type: 'join', roomId: 'RM5', playerId: 'po' });
  const rejoined = await back.next('joined');

  assert.equal(rejoined.role, 'O');
  assert.equal(rejoined.state.status, 'playing');
  assert.equal(rejoined.state.board[4], 'X');
  assert.equal(rejoined.state.board.length, size * size);
  assert.equal(rejoined.state.turn, 'O');
});
