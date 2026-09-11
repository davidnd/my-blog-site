/**
 * Transport: http for the built client, WebSocket for the game. All rules live
 * in rooms.ts — this file only validates messages and fans state out.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientMessage, ServerMessage } from '../shared/types.ts';
import { RoomStore } from './db.ts';
import { createMatchmaker } from './matchmaking.ts';
import { isValidWinLength, MAX_WIN_LENGTH, MIN_WIN_LENGTH } from '../shared/rules.ts';
import {
  applyPlayerMove,
  createRoom,
  GameError,
  joinRoom,
  leaveRoom,
  newRoomId,
  rematch,
  ROOM_TTL_MS,
  resolveTimeout,
  seatOf,
  toState,
  TURN_MS,
  type Room,
} from './rooms.ts';

/** Win length used when someone opens a room id that does not exist yet. */
const DEFAULT_WIN_LENGTH = 3;

type Session = { roomId: string; playerId: string };

export type GameServer = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

export async function startGameServer(options: {
  port?: number;
  staticDir?: string;
  /** SQLite file, or ':memory:' for a server whose rooms die with it. */
  dbPath?: string;
  /** Turn length; shortened in tests so a timeout does not take 30 real seconds. */
  turnMs?: number;
  /** How long an untouched room is kept before being swept. */
  roomTtlMs?: number;
}): Promise<GameServer> {
  const turnMs = options.turnMs ?? TURN_MS;
  const roomTtlMs = options.roomTtlMs ?? ROOM_TTL_MS;
  const store = new RoomStore(options.dbPath ?? ':memory:');
  const rooms = store.loadAll();
  const subscribers = new Map<string, Set<WebSocket>>();
  const sessions = new Map<WebSocket, Session>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const server = createServer((req, res) => {
    if (options.staticDir === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('client not built — run `npm run build`, or use `npm run dev`');
      return;
    }
    void import('./static.ts').then(({ serveStatic }) =>
      serveStatic(options.staticDir!, req, res),
    );
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    // endsWith rather than equals: served from /games/tic-tac-toe/ the socket
    // sits beside the page, and the Worker matches the same way.
    if (pathname !== '/ws' && !pathname.endsWith('/ws')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws: WebSocket, message: ServerMessage) => ws.send(JSON.stringify(message));

  const cancelTimer = (roomId: string) => {
    const timer = timers.get(roomId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(roomId);
    }
  };

  /** Re-arms a room's move clock from its absolute deadline, or clears it. */
  const armTimer = (room: Room) => {
    cancelTimer(room.id);
    if (room.status !== 'playing' || room.turnDeadline === null) return;
    const delay = Math.max(0, room.turnDeadline - Date.now());
    timers.set(
      room.id,
      setTimeout(() => onDeadline(room.id), delay),
    );
  };

  const onDeadline = (roomId: string) => {
    timers.delete(roomId);
    const room = rooms.get(roomId);
    if (!room) return;
    if (!resolveTimeout(room, Date.now())) {
      // Woke early (a timer can fire a hair before its deadline); try again.
      armTimer(room);
      return;
    }
    store.save(room);
    broadcast(roomId);
  };

  /** `except` skips a socket that is already being told directly, avoiding a duplicate. */
  const broadcast = (roomId: string, except?: WebSocket) => {
    const room = rooms.get(roomId);
    const listeners = subscribers.get(roomId);
    if (!room || !listeners) return;
    const message: ServerMessage = {
      type: 'state',
      state: toState(room),
      serverNow: Date.now(),
    };
    const payload = JSON.stringify(message);
    for (const ws of listeners) {
      if (ws !== except && ws.readyState === ws.OPEN) ws.send(payload);
    }
  };

  const requirePlayerId = (value: unknown): string => {
    if (typeof value !== 'string' || value === '') throw new GameError('missing player id');
    return value;
  };

  const requireWinLength = (value: unknown): number => {
    if (!isValidWinLength(value)) {
      throw new GameError(
        `win length must be a whole number from ${MIN_WIN_LENGTH} to ${MAX_WIN_LENGTH}`,
      );
    }
    return value;
  };

  /** Seats a player in a room and tells everyone about it. */
  const seat = (ws: WebSocket, room: Room, playerId: string) => {
    const role = joinRoom(room, playerId, Date.now(), turnMs);
    armTimer(room);
    store.save(room);
    sessions.set(ws, { roomId: room.id, playerId });

    let listeners = subscribers.get(room.id);
    if (!listeners) {
      listeners = new Set();
      subscribers.set(room.id, listeners);
    }
    listeners.add(ws);

    // The joiner gets the full picture in `joined`; everyone else gets a state.
    send(ws, { type: 'joined', role, state: toState(room), serverNow: Date.now() });
    broadcast(room.id, ws);
  };

  const handleJoin = (ws: WebSocket, message: Extract<ClientMessage, { type: 'join' }>) => {
    const { roomId } = message;
    if (typeof roomId !== 'string' || roomId === '') throw new GameError('missing room id');
    const playerId = requirePlayerId(message.playerId);

    let room = rooms.get(roomId);
    if (!room) {
      // An invite link for a room that has not been created yet still works.
      room = createRoom(roomId, DEFAULT_WIN_LENGTH);
      rooms.set(roomId, room);
    }
    seat(ws, room, playerId);
    matchmaker.offer(room);
  };

  const handleCreate = (ws: WebSocket, message: Extract<ClientMessage, { type: 'create' }>) => {
    const playerId = requirePlayerId(message.playerId);
    const winLength = requireWinLength(message.winLength);

    const room = createRoom(newRoomId((id) => rooms.has(id)), winLength);
    rooms.set(room.id, room);
    seat(ws, room, playerId);
    matchmaker.offer(room);
  };

  /** Whether someone holding a seat in the room is still connected to it. */
  const hostPresent = (room: Room): boolean => {
    for (const ws of subscribers.get(room.id) ?? []) {
      const session = sessions.get(ws);
      if (ws.readyState === ws.OPEN && session && seatOf(room, session.playerId) !== null) {
        return true;
      }
    }
    return false;
  };

  const matchmaker = createMatchmaker({ rooms, hostPresent, seat });

  const handleQueue = (ws: WebSocket, message: Extract<ClientMessage, { type: 'queue' }>) => {
    matchmaker.queue(ws, requirePlayerId(message.playerId), requireWinLength(message.winLength));
  };

  const handleMove = (ws: WebSocket, message: Extract<ClientMessage, { type: 'move' }>) => {
    const session = sessions.get(ws);
    if (!session) throw new GameError('join a room first');
    const room = rooms.get(session.roomId);
    if (!room) throw new GameError('that room no longer exists');

    applyPlayerMove(room, session.playerId, message.index, Date.now(), turnMs);
    // Moving in time replaces the pending timeout with the next player's.
    armTimer(room);
    store.save(room);
    broadcast(session.roomId);
  };

  const handleRematch = (ws: WebSocket) => {
    const session = sessions.get(ws);
    if (!session) throw new GameError('join a room first');
    const room = rooms.get(session.roomId);
    if (!room) throw new GameError('that room no longer exists');

    rematch(room, session.playerId, Date.now(), turnMs);
    armTimer(room);
    store.save(room);
    broadcast(session.roomId);
    matchmaker.offer(room);
  };

  /**
   * The opposite of `seat`: the socket forgets its room and the seat is freed,
   * so the next person through the invite link gets it rather than a spectator
   * view of an empty chair. A plain close keeps the seat — that is a refresh.
   */
  const handleLeave = (ws: WebSocket) => {
    const session = sessions.get(ws);
    if (!session) throw new GameError('join a room first');
    sessions.delete(ws);
    subscribers.get(session.roomId)?.delete(ws);

    const room = rooms.get(session.roomId);
    if (!room) return;
    if (!leaveRoom(room, session.playerId)) return;
    armTimer(room);
    store.save(room);
    broadcast(session.roomId);
  };

  /**
   * The Cloudflare Worker has to pick a Durable Object before the socket
   * exists, so the client puts its intent in the query string. Reading the same
   * parameters here means one client drives both transports. A connection with
   * no parameters still waits for a first message, which is how the tests and
   * any older client reach this server.
   */
  const seatFromQuery = (ws: WebSocket, req: IncomingMessage) => {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const playerId = params.get('player');
    if (playerId === null || playerId === '') return;

    const queue = params.get('queue');
    const room = params.get('room');
    if (queue !== null) {
      handleQueue(ws, { type: 'queue', winLength: Number(queue), playerId });
    } else if (room === 'new') {
      handleCreate(ws, { type: 'create', winLength: Number(params.get('win')), playerId });
    } else if (room !== null && room !== '') {
      handleJoin(ws, { type: 'join', roomId: room.toUpperCase(), playerId });
    }
  };

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    try {
      seatFromQuery(ws, req);
    } catch (error) {
      if (error instanceof GameError) send(ws, { type: 'error', message: error.message });
      else throw error;
    }

    ws.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        send(ws, { type: 'error', message: 'malformed message' });
        return;
      }
      try {
        if (message.type === 'join') handleJoin(ws, message);
        else if (message.type === 'create') handleCreate(ws, message);
        else if (message.type === 'queue') handleQueue(ws, message);
        else if (message.type === 'move') handleMove(ws, message);
        else if (message.type === 'rematch') handleRematch(ws);
        else if (message.type === 'leave') handleLeave(ws);
        else send(ws, { type: 'error', message: `unknown message type` });
      } catch (error) {
        if (error instanceof GameError) {
          send(ws, { type: 'error', message: error.message });
          return;
        }
        // A bug on our side, not a bad client: tell them, and keep the log.
        console.error('failed to handle message', error);
        send(ws, { type: 'error', message: 'server error' });
      }
    });

    ws.on('close', () => {
      matchmaker.forget(ws);
      const session = sessions.get(ws);
      sessions.delete(ws);
      // The seat stays claimed — that is what lets the player reconnect into it.
      if (session) subscribers.get(session.roomId)?.delete(ws);
    });
  });

  /**
   * Drops rooms nobody has come back to. A room with a live subscriber is kept
   * whatever its age, so a long game is never swept out from under its players.
   */
  const sweepRooms = (now = Date.now()) => {
    for (const [roomId, room] of rooms) {
      if (now - room.createdAt < roomTtlMs) continue;
      if ((subscribers.get(roomId)?.size ?? 0) > 0) continue;
      cancelTimer(roomId);
      subscribers.delete(roomId);
      rooms.delete(roomId);
      store.remove(roomId);
    }
  };

  // Settle any deadline that lapsed while this process was not running, so a
  // restart cannot hand someone free thinking time, then re-arm the live ones.
  const bootedAt = Date.now();
  sweepRooms(bootedAt);
  for (const room of rooms.values()) {
    if (resolveTimeout(room, bootedAt)) store.save(room);
    else armTimer(room);
  }

  const sweepTimer = setInterval(() => sweepRooms(), Math.min(roomTtlMs, 60 * 60 * 1000));
  // Never hold the process open just to run a sweep.
  sweepTimer.unref?.();

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port');
  }

  return {
    server,
    port: address.port,
    close: async () => {
      clearInterval(sweepTimer);
      for (const roomId of [...timers.keys()]) cancelTimer(roomId);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve, reject) =>
        wss.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
    },
  };
}

if (import.meta.main) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = path.resolve(here, '../../dist/client');
  const port = Number(process.env['PORT'] ?? 8787);
  const dbPath = process.env['DB_PATH'] ?? path.resolve(here, '../../axon.sqlite');
  const { port: bound } = await startGameServer({ port, staticDir, dbPath });
  console.log(`axon tic tac toe listening on http://localhost:${bound}`);
}
