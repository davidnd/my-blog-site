/**
 * The Cloudflare transport, driven over real WebSockets against a running
 * `wrangler dev`. The rules are covered by rules.test.ts and rooms.test.ts,
 * which are pure and transport-free; what is exercised here is only the part
 * the port actually rewrote — Durable Object routing, hibernation attachments,
 * storage and the lobby handshake.
 *
 * Start the Worker first, in another terminal:
 *   npm run cf:dev
 * then:
 *   npm run test:cf
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TestClient } from '../helpers/client.ts';

const PORT = Number(process.env['WORKER_PORT'] ?? 8799);

/** Fails loudly rather than skipping, so a dead Worker cannot look like a pass. */
test('the worker is running', async () => {
  const response = await fetch(`http://localhost:${PORT}/ws`).catch((cause: unknown) => {
    throw new Error(
      `no worker on port ${PORT}. Run \`npm run cf:dev\` first. (${String(cause)})`,
    );
  });
  // A plain GET is not an upgrade, so the Worker should say so rather than 404.
  assert.equal(response.status, 426);
  await response.text();
});

/** Unique per run: Durable Object storage survives between `wrangler dev` runs. */
const roomId = (name: string) => `T${name}${Date.now().toString(36).toUpperCase()}`.slice(0, 12);

async function joinPair(t: test.TestContext, room: string, win: number) {
  const x = await TestClient.connect(PORT, `room=${room}&player=px&win=${win}`);
  const o = await TestClient.connect(PORT, `room=${room}&player=po`);
  t.after(() => Promise.all([x.close(), o.close()]));
  const first = await x.next('joined');
  const second = await o.next('joined');
  await x.next('state');
  return { x, o, size: first.state.size, roleX: first.role, roleO: second.role };
}

test('two players share a room, take turns, and the board persists', async (t) => {
  const room = roomId('PLAY');
  const { x, o, size, roleX, roleO } = await joinPair(t, room, 3);
  assert.equal(roleX, 'X');
  assert.equal(roleO, 'O');

  x.send({ type: 'move', index: 0 });
  assert.equal((await o.next('state')).state.board[0], 'X');
  await x.next('state');
  o.send({ type: 'move', index: size });
  assert.equal((await x.next('state')).state.board[size], 'O');
});

test('REQUIREMENT: a 30s deadline is armed once both seats are filled', async (t) => {
  const room = roomId('CLK');
  const x = await TestClient.connect(PORT, `room=${room}&player=px&win=3`);
  t.after(() => x.close());
  const alone = await x.next('joined');
  assert.equal(alone.state.status, 'waiting');
  assert.equal(alone.state.turnDeadline, null, 'no clock runs against an empty chair');

  const o = await TestClient.connect(PORT, `room=${room}&player=po`);
  t.after(() => o.close());
  const both = await o.next('joined');
  assert.equal(both.state.status, 'playing');
  assert.ok(both.state.turnDeadline !== null);
  assert.ok(both.state.turnDeadline - both.serverNow > 25_000);
});

test('REQUIREMENT: a reconnect lands back in the same seat and game', async (t) => {
  const room = roomId('RC');
  const { x, o, size } = await joinPair(t, room, 3);
  x.send({ type: 'move', index: 0 });
  await x.next('state');
  await o.next('state');
  await o.close();

  const back = await TestClient.connect(PORT, `room=${room}&player=po`);
  t.after(() => back.close());
  const rejoined = await back.next('joined');
  assert.equal(rejoined.role, 'O', 'the seat was held for the same player id');
  assert.equal(rejoined.state.board[0], 'X', 'the board survived the disconnect');
  assert.equal(rejoined.state.board.length, size * size);
  assert.equal(rejoined.state.turn, 'O');
});

test('a third person watches, and cannot move', async (t) => {
  const room = roomId('SPEC');
  const { x } = await joinPair(t, room, 3);
  const watcher = await TestClient.connect(PORT, `room=${room}&player=pw`);
  t.after(() => watcher.close());
  assert.equal((await watcher.next('joined')).role, 'spectator');
  await x.next('state');

  watcher.send({ type: 'move', index: 4 });
  assert.match((await watcher.next('error')).message, /spectators cannot move/);
});

test('leaving frees the seat, and a rematch then waits for someone new', async (t) => {
  const room = roomId('LV');
  const { x, o } = await joinPair(t, room, 3);

  o.send({ type: 'leave' });
  const afterLeave = await x.next('state');
  assert.equal(afterLeave.state.seatsTaken.O, false);
  assert.equal(afterLeave.state.status, 'over', 'walking out of a live game forfeits it');

  x.send({ type: 'rematch' });
  const restarted = await x.next('state');
  assert.equal(restarted.state.status, 'waiting');
  assert.equal(restarted.state.turnDeadline, null);

  const friend = await TestClient.connect(PORT, `room=${room}&player=pf`);
  t.after(() => friend.close());
  assert.equal((await friend.next('joined')).role, 'O');
});

test('a minted room reports the id it was actually given', async (t) => {
  const fresh = await TestClient.connect(PORT, 'room=new&player=pn&win=4');
  t.after(() => fresh.close());
  const joined = await fresh.next('joined');
  assert.match(joined.state.roomId, /^[A-Z2-7]{6}$/, 'a base32 id the Worker minted');
  assert.equal(joined.state.winLength, 4);
  assert.equal(joined.state.size, 10);
});

/** Resolves true if the socket ever opened. A refused upgrade never does. */
async function opens(query: string): Promise<boolean> {
  const socket = new WebSocket(`ws://localhost:${PORT}/ws?${query}`);
  return await new Promise<boolean>((resolve) => {
    socket.addEventListener('open', () => {
      socket.close();
      resolve(true);
    }, { once: true });
    socket.addEventListener('error', () => resolve(false), { once: true });
    socket.addEventListener('close', () => resolve(false), { once: true });
  });
}

test('an out-of-range win length is refused rather than quietly clamped', async () => {
  assert.equal(await opens('queue=9&player=pbad'), false, '9 is past the maximum of 6');
  assert.equal(await opens('queue=2&player=pbad'), false, '2 is below the minimum of 3');
  assert.equal(await opens('room=new&player=pbad&win=7'), false, 'and on a created room too');
  assert.equal(await opens('queue=5&player=pbad'), true, 'but a valid one connects');
});

test('a connection with no player id is refused', async () => {
  assert.equal(await opens('room=SOMEWHERE'), false);
});

test('two queued players are matched into one room', async (t) => {
  const first = await TestClient.connect(PORT, 'queue=5&player=pq1');
  t.after(() => first.close());
  await first.expectSilence(250);

  const second = await TestClient.connect(PORT, 'queue=5&player=pq2');
  t.after(() => second.close());

  const forFirst = await first.next('matched');
  const forSecond = await second.next('matched');
  assert.equal(forFirst.roomId, forSecond.roomId, 'both were sent to the same room');

  // The lobby only names the room; the players connect to it themselves.
  const a = await TestClient.connect(PORT, `room=${forFirst.roomId}&player=pq1`);
  const b = await TestClient.connect(PORT, `room=${forSecond.roomId}&player=pq2`);
  t.after(() => Promise.all([a.close(), b.close()]));
  assert.equal((await a.next('joined')).role, 'X');
  const seated = await b.next('joined');
  assert.equal(seated.role, 'O');
  assert.equal(seated.state.status, 'playing');
  assert.equal(seated.state.winLength, 5);
});

test('queueing for a different win length does not match', async (t) => {
  const three = await TestClient.connect(PORT, 'queue=3&player=pw3');
  const six = await TestClient.connect(PORT, 'queue=6&player=pw6');
  t.after(() => Promise.all([three.close(), six.close()]));
  await three.expectSilence(300);
  await six.expectSilence(300);
});

test('a room made by hand stays private, and no random player is sent to it', async (t) => {
  const room = roomId('PRIV');
  const host = await TestClient.connect(PORT, `room=${room}&player=ph&win=4`);
  t.after(() => host.close());
  assert.equal((await host.next('joined')).state.status, 'waiting');

  const random = await TestClient.connect(PORT, 'queue=4&player=pr');
  t.after(() => random.close());
  await random.expectSilence(400);
  await host.expectSilence(100);
});

test('a public room that frees a seat takes the next queued player', async (t) => {
  // Make a public room the only way there is: let the lobby pair two players.
  const one = await TestClient.connect(PORT, 'queue=3&player=pp1');
  const two = await TestClient.connect(PORT, 'queue=3&player=pp2');
  t.after(() => Promise.all([one.close(), two.close()]));
  const room = (await one.next('matched')).roomId;
  await two.next('matched');

  const a = await TestClient.connect(PORT, `room=${room}&player=pp1`);
  const b = await TestClient.connect(PORT, `room=${room}&player=pp2`);
  t.after(() => Promise.all([a.close(), b.close()]));
  await a.next('joined');
  await b.next('joined');
  await a.next('state');

  b.send({ type: 'leave' });
  await a.next('state');
  a.send({ type: 'rematch' });
  assert.equal((await a.next('state')).state.status, 'waiting');

  const random = await TestClient.connect(PORT, 'queue=3&player=pp3');
  t.after(() => random.close());
  assert.equal((await random.next('matched')).roomId, room, 'sent to the half-full room');
});
