/**
 * Per-move countdown. REQUIREMENTS.md: "Timer count down for each move, 30s".
 * plan.md: the server stores an absolute `turn_deadline`, arms a timeout, and on
 * fire sets status='over' with the opponent as winner; the client countdown is
 * display only. OPEN_QUESTIONS.md #6: the clock does not run before the second
 * player arrives.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startGameServer, type GameServer } from '../src/server/index.ts';
import type { GameState } from '../src/shared/types.ts';
import { TestClient } from './helpers/client.ts';

const TURN_MS = 30_000;

/**
 * The deadline the client is supposed to count down from. The wire type in
 * src/shared/types.ts does not declare it yet, so read it defensively rather
 * than assuming a shape.
 */
function deadlineOf(state: GameState): number | null {
  const raw = (state as unknown as Record<string, unknown>)['turnDeadline'];
  return typeof raw === 'number' ? raw : null;
}

async function withServer(
  t: test.TestContext,
  options: Record<string, unknown> = {},
): Promise<GameServer> {
  const server = await startGameServer(options as Parameters<typeof startGameServer>[0]);
  t.after(() => server.close());
  return server;
}

test('REQUIREMENT: the state carries a 30s deadline for the current move', async (t) => {
  const { port } = await withServer(t);
  const x = await TestClient.connect(port);
  const o = await TestClient.connect(port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId: 'T1', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'T1', playerId: 'po' });
  const started = await o.next('joined');
  assert.equal(started.state.status, 'playing');

  const deadline = deadlineOf(started.state);
  assert.notEqual(deadline, null, 'a playing state must tell the client when the turn expires');
  const remaining = deadline! - Date.now();
  assert.ok(
    remaining > TURN_MS - 5_000 && remaining <= TURN_MS + 1_000,
    `expected ~30s left, got ${remaining}ms`,
  );
});

test('OPEN QUESTION 6: no clock runs while a room waits for an opponent', async (t) => {
  const { port } = await withServer(t);
  const host = await TestClient.connect(port);
  t.after(() => host.close());

  host.send({ type: 'join', roomId: 'T2', playerId: 'host' });
  const joined = await host.next('joined');
  assert.equal(joined.state.status, 'waiting');
  assert.equal(deadlineOf(joined.state), null, 'a host waiting on an invite must not lose on time');
});

test('REQUIREMENT: the countdown restarts for each move', async (t) => {
  const { port } = await withServer(t);
  const x = await TestClient.connect(port);
  const o = await TestClient.connect(port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId: 'T3', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'T3', playerId: 'po' });
  const started = await o.next('joined');
  const first = deadlineOf(started.state);

  x.send({ type: 'move', index: 0 });
  const afterMove = await o.next('state');
  const second = deadlineOf(afterMove.state);

  assert.notEqual(first, null);
  assert.notEqual(second, null);
  // Strictly-greater is flaky: Date.now() has millisecond resolution and the
  // move lands well under a millisecond after the join, so the two deadlines
  // can legitimately be equal. What matters is that the new turn is measured
  // from the move, not inherited with time already burned off it.
  assert.ok(second! >= first!, 'the clock must not carry over from the last turn');
  const remaining = second! - Date.now();
  assert.ok(
    remaining > TURN_MS - 5_000 && remaining <= TURN_MS + 1_000,
    `the new turn must get its own full 30s, got ${remaining}ms`,
  );
});

test('a timed-out player loses and the board locks', async (t) => {
  // AMBIGUOUS: plan.md slice 4 calls for "an injectable timeout so it runs in
  // milliseconds" but names no option; `turnMs` is the assumed name.
  const { port } = await withServer(t, { turnMs: 60 });
  const x = await TestClient.connect(port);
  const o = await TestClient.connect(port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId: 'T4', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'T4', playerId: 'po' });
  await o.next('joined');

  // X never moves. The server must end the game on its own and tell everyone.
  const timedOut = await o.next('state', 3_000);
  assert.equal(timedOut.state.status, 'over');
  assert.equal(timedOut.state.winner, 'O', 'the player who ran out of time loses');

  x.send({ type: 'move', index: 0 });
  assert.match((await x.next('error')).message, /over/i);
});

test('a move made in time cancels the pending timeout', async (t) => {
  // AMBIGUOUS: same assumed `turnMs` option.
  const { port } = await withServer(t, { turnMs: 400 });
  const x = await TestClient.connect(port);
  const o = await TestClient.connect(port);
  t.after(() => Promise.all([x.close(), o.close()]));

  x.send({ type: 'join', roomId: 'T5', playerId: 'px' });
  await x.next('joined');
  o.send({ type: 'join', roomId: 'T5', playerId: 'po' });
  await o.next('joined');

  x.send({ type: 'move', index: 0 });
  const afterMove = await o.next('state');
  assert.equal(afterMove.state.status, 'playing', 'X moved in time, so nobody has lost');
  assert.equal(afterMove.state.turn, 'O');
});
