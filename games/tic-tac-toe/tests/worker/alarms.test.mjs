/**
 * Exercise the real GameRoom handlers with a controlled clock and storage.
 * Only Cloudflare's platform boundary is replaced. The separate test:cf suite
 * covers actual WebSocket lifecycle and alarms in the Workers runtime.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createRoom, joinRoom, ROOM_TTL_MS, TURN_MS } from '../../src/server/rooms.ts';

const platform = 'data:text/javascript,' + encodeURIComponent(`
  export class DurableObject {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  }
`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'cloudflare:workers'
      ? { url: platform, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { GameRoom } = await import('../../src/worker/room.ts');
hooks.deregister();

class Socket {
  static READY_STATE_OPEN = 1;
  readyState = 1;
  messages = [];
  constructor(playerId = '') { this.session = { playerId }; }
  serializeAttachment(session) { this.session = session; }
  deserializeAttachment() { return this.session; }
  send(payload) { this.messages.push(JSON.parse(payload)); }
  close() { this.readyState = 2; }
}

// Test files run in isolated Node processes, so these do not affect other suites.
globalThis.WebSocket = Socket;
globalThis.WebSocketPair = class {
  constructor() { this[0] = new Socket(); this[1] = new Socket(); }
};
globalThis.Response = class {
  constructor(body, init) { this.body = body; Object.assign(this, init); }
};

const NOW = 2_000_000_000_000;
const freshRoom = () => ({ ...createRoom('ROOM', 3, NOW), cleanupAt: null });

async function harness(t, stored = freshRoom(), sockets = []) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const values = new Map(stored === null ? [] : [['room', structuredClone(stored)]]);
  const alarms = [];
  let scheduled = null;
  let initialized;
  const closedRooms = [];
  const ctx = {
    storage: {
      async get(key) { return structuredClone(values.get(key)); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      async getAlarm() { return scheduled; },
      async setAlarm(time) { alarms.push(time); scheduled = time; },
      async deleteAlarm() { scheduled = null; },
      async deleteAll() { values.clear(); scheduled = null; },
    },
    getWebSockets() { return sockets; },
    acceptWebSocket(ws) { sockets.push(ws); },
    blockConcurrencyWhile(fn) { initialized = fn(); return initialized; },
  };
  const env = {
    LOBBY: { getByName: () => ({
      async roomClosed(id) { closedRooms.push(id); },
      async roomOpened() {},
    }) },
  };
  let worker = new GameRoom(ctx, env);
  await initialized;
  return {
    get worker() { return worker; },
    get room() { return values.get('room'); },
    get scheduled() { return scheduled; },
    set scheduled(value) { scheduled = value; },
    alarms, sockets, closedRooms,
    advance(ms) { t.mock.timers.tick(ms); },
    async wake() { worker = new GameRoom(ctx, env); await initialized; },
    async fire() { scheduled = null; await worker.alarm(); },
    async connect(playerId = 'px') {
      return worker.fetch({ url: `https://game.test/ws?room=ROOM&player=${playerId}` });
    },
  };
}

test('an old connected room consumes the legacy expiry without rearming it', async (t) => {
  const legacy = createRoom('ROOM', 3, NOW - 2 * ROOM_TTL_MS);
  const h = await harness(t, legacy, [new Socket('px')]);
  await h.fire();
  assert.equal(h.scheduled, null);
  assert.equal(h.room.cleanupAt, null);
  assert.equal(h.room.createdAt, legacy.createdAt);
  assert.deepEqual(h.alarms, [], 'no past-dated alarm starts another loop');
  await h.wake();
  await h.fire();
  assert.equal(h.scheduled, null);
});

test('an old connected game keeps only its future turn deadline', async (t) => {
  const legacy = createRoom('ROOM', 3, NOW - 2 * ROOM_TTL_MS);
  joinRoom(legacy, 'px', NOW);
  joinRoom(legacy, 'po', NOW);
  const h = await harness(t, legacy, [new Socket('px'), new Socket('po')]);
  await h.fire();
  assert.equal(h.scheduled, NOW + TURN_MS);
  assert.deepEqual(h.alarms, [NOW + TURN_MS]);
});

test('legacy empty rooms receive one persisted grace period across wakeups', async (t) => {
  const h = await harness(t, createRoom('ROOM', 3, NOW - 2 * ROOM_TTL_MS));
  await h.fire();
  assert.equal(h.scheduled, NOW + ROOM_TTL_MS);
  h.advance(60_000);
  await h.wake();
  await h.fire();
  assert.equal(h.scheduled, NOW + ROOM_TTL_MS, 'waking does not extend cleanup');
});

test('cleanup starts only after the last open connection closes', async (t) => {
  const x = new Socket('px');
  const watcher = new Socket('watcher');
  const h = await harness(t, freshRoom(), [x, watcher]);
  x.close();
  await h.worker.webSocketClose();
  assert.equal(h.scheduled, null, 'a connected spectator also keeps the room');
  watcher.close();
  await h.worker.webSocketClose();
  assert.equal(h.scheduled, NOW + ROOM_TTL_MS, 'closing sockets do not block cleanup');
  h.advance(60_000);
  await h.worker.webSocketClose();
  assert.equal(h.scheduled, NOW + ROOM_TTL_MS, 'duplicate closes do not extend the deadline');
  assert.equal(h.alarms.length, 1, 'an unchanged deadline is not written again');
});

test('rejoining cancels cleanup and retains the existing board and seat', async (t) => {
  const room = freshRoom();
  joinRoom(room, 'px', NOW);
  room.cells[0] = 'X';
  room.cleanupAt = NOW + 1_000;
  const h = await harness(t, room);
  h.scheduled = room.cleanupAt;
  const response = await h.connect('px');
  assert.equal(response.status, 101);
  assert.equal(h.room.cleanupAt, null);
  assert.equal(h.scheduled, null);
  const joined = h.sockets.at(-1).messages.find((message) => message.type === 'joined');
  assert.equal(joined.role, 'X');
  assert.equal(joined.state.board[0], 'X');
  h.advance(2_000);
  await h.fire();
  assert.ok(h.room, 'a stale alarm cannot delete a reconnected room');
  h.sockets.at(-1).close();
  await h.worker.webSocketClose();
  assert.equal(h.scheduled, NOW + 2_000 + ROOM_TTL_MS, 'a new absence gets a full day');
});

test('timeouts stop, and New game restarts both players in the same old room', async (t) => {
  const room = freshRoom();
  room.createdAt = NOW - 2 * ROOM_TTL_MS;
  joinRoom(room, 'px', NOW - TURN_MS);
  joinRoom(room, 'po', NOW - TURN_MS);
  const x = new Socket('px');
  const o = new Socket('po');
  const h = await harness(t, room, [x, o]);
  await h.fire();
  assert.equal(h.room.status, 'over');
  assert.equal(h.room.winner, 'O');
  assert.equal(h.scheduled, null);
  h.advance(5_000);
  await h.worker.webSocketMessage(o, JSON.stringify({ type: 'rematch' }));
  for (const socket of [x, o]) {
    const state = socket.messages.at(-1).state;
    assert.equal(state.roomId, 'ROOM');
    assert.equal(state.board, '.'.repeat(room.size ** 2));
    assert.equal(state.turn, 'X');
    assert.equal(state.status, 'playing');
    assert.equal(state.turnDeadline, NOW + 5_000 + TURN_MS);
  }
  assert.deepEqual(h.room.seats, { X: 'px', O: 'po' });
  assert.equal(h.scheduled, NOW + 5_000 + TURN_MS);
  h.advance(1_000);
  await h.worker.webSocketMessage(x, JSON.stringify({ type: 'move', index: 0 }));
  assert.equal(h.scheduled, NOW + 6_000 + TURN_MS, 'a move replaces the old deadline');
});

test('winning cancels the turn alarm and does not schedule connected-room cleanup', async (t) => {
  const room = freshRoom();
  joinRoom(room, 'px', NOW);
  joinRoom(room, 'po', NOW);
  const x = new Socket('px');
  const o = new Socket('po');
  const h = await harness(t, room, [x, o]);
  for (const [socket, index] of [[x, 0], [o, room.size], [x, 1], [o, room.size + 1], [x, 2]]) {
    await h.worker.webSocketMessage(socket, JSON.stringify({ type: 'move', index }));
  }
  assert.equal(h.room.status, 'over');
  assert.equal(h.room.winner, 'X');
  assert.equal(h.scheduled, null);
});

test('a disconnected game times out once, then waits for its original cleanup deadline', async (t) => {
  const room = freshRoom();
  joinRoom(room, 'px', NOW);
  joinRoom(room, 'po', NOW);
  const h = await harness(t, room);
  await h.worker.webSocketClose();
  assert.equal(h.room.cleanupAt, NOW + ROOM_TTL_MS);
  assert.equal(h.scheduled, NOW + TURN_MS);
  h.advance(TURN_MS);
  await h.fire();
  assert.equal(h.room.status, 'over');
  assert.equal(h.scheduled, NOW + ROOM_TTL_MS);
  h.advance(ROOM_TTL_MS - TURN_MS);
  await h.fire();
  assert.equal(h.room, undefined);
  assert.equal(h.scheduled, null);
  await h.fire();
  assert.equal(h.scheduled, null);
});

test('explicit leave and connection errors also schedule abandoned-room cleanup', async (t) => {
  const room = freshRoom();
  joinRoom(room, 'px', NOW);
  const x = new Socket('px');
  const h = await harness(t, room, [x]);
  await h.worker.webSocketMessage(x, JSON.stringify({ type: 'leave' }));
  assert.equal(h.scheduled, NOW + ROOM_TTL_MS);
  await h.connect('px');
  assert.equal(h.scheduled, null);
  await h.worker.webSocketError(h.sockets.at(-1));
  assert.equal(h.scheduled, NOW + ROOM_TTL_MS);
});

test('a public room whose matched players never arrive is cleaned up once', async (t) => {
  const h = await harness(t, null);
  await h.worker.openPublic('PUBLIC', 3);
  assert.equal(h.scheduled, NOW + ROOM_TTL_MS);
  await h.wake();
  h.advance(ROOM_TTL_MS);
  await h.fire();
  assert.deepEqual(h.closedRooms, ['PUBLIC']);
  assert.equal(h.room, undefined);
  assert.equal(h.scheduled, null);
});
