/**
 * One Durable Object per room. It owns the state, the sockets connected to it,
 * and the clock — the three things the Node server held per-room in a process
 * that never stopped. The rules still live entirely in rooms.ts; this file is
 * transport, storage and alarms, the same division of labour as index.ts.
 */

import { DurableObject } from 'cloudflare:workers';

import {
  applyPlayerMove,
  createRoom,
  GameError,
  joinRoom,
  leaveRoom,
  rematch,
  resolveTimeout,
  ROOM_TTL_MS,
  seatOf,
  toState,
  TURN_MS,
  type Room,
} from '../server/rooms.ts';
import type { ClientMessage, ServerMessage } from '../shared/types.ts';
import type { LobbyRoom } from './lobby.ts';

/** Win length used when someone opens a room id that does not exist yet. */
const DEFAULT_WIN_LENGTH = 3;

/**
 * Per-socket data. It survives hibernation, which is what lets this replace the
 * `sessions` map the Node server kept in memory.
 */
type Session = { playerId: string };

/** A persisted, one-shot cleanup deadline; null while anyone is connected. */
type StoredRoom = Room & { cleanupAt: number | null };

export type RoomEnv = {
  ROOM: DurableObjectNamespace<GameRoom>;
  LOBBY: DurableObjectNamespace<LobbyRoom>;
};

export class GameRoom extends DurableObject<RoomEnv> {
  #room: StoredRoom | null = null;

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    // No event is delivered until this resolves, so every handler below may
    // treat #room as already loaded rather than awaiting storage itself.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<Room & { cleanupAt?: number | null }>('room');
      if (stored === undefined) return;
      this.#room = {
        ...stored,
        // Rooms from the old deployment have no idle deadline. Give empty
        // rooms a full grace period; connected rooms no longer expire by age.
        cleanupAt: stored.cleanupAt === undefined
          ? (this.#hasConnections() ? null : Date.now() + ROOM_TTL_MS)
          : stored.cleanupAt,
      };
      if (stored.cleanupAt === undefined) await ctx.storage.put('room', this.#room);
      // Do not schedule here: an existing alarm may be waking this object.
      // Its handler will consume the old deadline and select a future one.
    });
  }

  /**
   * The socket upgrade. A Durable Object is never told the name it was
   * addressed by, so the room id rides in the URL and the Worker puts it there.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('room') ?? '';
    const playerId = url.searchParams.get('player') ?? '';
    if (roomId === '' || playerId === '') {
      return new Response('missing room or player id', { status: 400 });
    }

    if (this.#room === null) {
      const asked = url.searchParams.get('win');
      const winLength = asked === null ? DEFAULT_WIN_LENGTH : Number(asked);
      try {
        // A client can only ever open a private room. The lobby calls
        // openPublic() before handing an id out, so visibility is not forgeable.
        this.#room = { ...createRoom(roomId, winLength, Date.now(), 'private'), cleanupAt: null };
      } catch {
        return new Response('invalid win length', { status: 400 });
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // acceptWebSocket, not accept: this is what lets the object be evicted
    // while the socket stays open at the edge.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId } satisfies Session);

    const role = joinRoom(this.#room, playerId, Date.now(), TURN_MS);
    await this.#persist();

    // The joiner gets the full picture; everyone else gets a state.
    this.#send(server, {
      type: 'joined',
      role,
      state: toState(this.#room),
      serverNow: Date.now(),
    });
    this.#broadcast(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called by the lobby before it hands this id to two queued players. */
  async openPublic(roomId: string, winLength: number): Promise<void> {
    if (this.#room !== null) return;
    this.#room = { ...createRoom(roomId, winLength, Date.now(), 'public'), cleanupAt: null };
    await this.#persist();
  }

  /**
   * The lobby's registry is only a hint, because it can go stale between a room
   * freeing a seat and someone acting on it. This is the authority.
   */
  async joinable(): Promise<boolean> {
    const room = this.#room;
    if (room === null || room.status !== 'waiting') return false;
    if (room.seats.X !== null && room.seats.O !== null) return false;
    // A seat held by someone who has gone is not an invitation to play.
    return this.ctx
      .getWebSockets()
      .some((ws) => ws.readyState === WebSocket.READY_STATE_OPEN &&
        seatOf(room, (ws.deserializeAttachment() as Session | null)?.playerId ?? '') !== null);
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const room = this.#room;
    const session = ws.deserializeAttachment() as Session | null;
    if (room === null || session === null) return;

    let message: ClientMessage;
    try {
      message = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw),
      ) as ClientMessage;
    } catch {
      this.#send(ws, { type: 'error', message: 'malformed message' });
      return;
    }

    try {
      if (message.type === 'move') {
        applyPlayerMove(room, session.playerId, message.index, Date.now(), TURN_MS);
        await this.#persist();
        this.#broadcast();
      } else if (message.type === 'rematch') {
        rematch(room, session.playerId, Date.now(), TURN_MS);
        await this.#persist();
        this.#broadcast();
        await this.#reportSeats();
      } else if (message.type === 'leave') {
        const changed = leaveRoom(room, session.playerId);
        if (changed) {
          await this.#persist();
          // Everyone but the leaver: they are gone and should hear nothing.
          this.#broadcast(ws);
        }
        ws.close(1000, 'left');
        await this.#syncAlarm();
        if (changed) await this.#reportSeats();
      } else {
        this.#send(ws, { type: 'error', message: 'unknown message type' });
      }
    } catch (error) {
      if (error instanceof GameError) {
        this.#send(ws, { type: 'error', message: error.message });
        return;
      }
      // A bug on our side, not a bad client: tell them, and keep the log.
      console.error('failed to handle message', error);
      this.#send(ws, { type: 'error', message: 'server error' });
    }
  }

  /**
   * A plain close keeps the seat. That is what makes a refresh land back in the
   * same game, exactly as it did on Node.
   */
  override async webSocketClose(): Promise<void> {
    await this.#syncAlarm();
    await this.#reportSeats();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, 'connection error');
    await this.#syncAlarm();
    await this.#reportSeats();
  }

  /**
   * A one-shot alarm handles whichever deadline is due. No recurring sweep.
   */
  override async alarm(): Promise<void> {
    await this.#syncAlarm();
  }

  async #persist(): Promise<void> {
    if (this.#room === null) return;
    await this.ctx.storage.put('room', this.#room);
    await this.#syncAlarm();
  }

  #hasConnections(): boolean {
    // getWebSockets() can still include sockets whose close handshake is in
    // progress. Those must not keep an abandoned room alive.
    return this.ctx.getWebSockets().some((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
  }

  /** Consume expired deadlines before scheduling the next one. */
  async #syncAlarm(): Promise<void> {
    const room = this.#room;
    if (room === null) return;
    const now = Date.now();
    const timedOut = resolveTimeout(room, now);
    const cleanupAt = this.#hasConnections() ? null : (room.cleanupAt ?? now + ROOM_TTL_MS);
    const cleanupChanged = cleanupAt !== room.cleanupAt;
    room.cleanupAt = cleanupAt;

    if (timedOut || cleanupChanged) await this.ctx.storage.put('room', room);
    if (timedOut) this.#broadcast();

    if (cleanupAt !== null && cleanupAt <= now) {
      // Reporting to the lobby is an external RPC. Keep a reconnect from
      // interleaving with cleanup while that RPC is in flight.
      await this.ctx.blockConcurrencyWhile(async () => {
        await this.#reportClosed();
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.#room = null;
      });
      return;
    }

    const turn = room.status === 'playing' ? room.turnDeadline : null;
    const next = turn === null ? cleanupAt : cleanupAt === null ? turn : Math.min(turn, cleanupAt);
    const scheduled = await this.ctx.storage.getAlarm();
    if (next === scheduled) return;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /** Tells the lobby whether this public room is worth sending anyone to. */
  async #reportSeats(): Promise<void> {
    const room = this.#room;
    if (room === null || room.visibility !== 'public') return;
    if (await this.joinable()) {
      await this.#lobby().roomOpened(room.id);
    } else {
      await this.#lobby().roomClosed(room.id);
    }
  }

  async #reportClosed(): Promise<void> {
    const room = this.#room;
    if (room === null || room.visibility !== 'public') return;
    await this.#lobby().roomClosed(room.id);
  }

  #lobby(): DurableObjectStub<LobbyRoom> {
    return this.env.LOBBY.getByName(`lobby:${this.#room?.winLength ?? DEFAULT_WIN_LENGTH}`);
  }

  #send(ws: WebSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  /** `except` skips a socket that was already told directly. */
  #broadcast(except?: WebSocket): void {
    const room = this.#room;
    if (room === null) return;
    const payload = JSON.stringify({
      type: 'state',
      state: toState(room),
      serverNow: Date.now(),
    } satisfies ServerMessage);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except && ws.readyState === WebSocket.READY_STATE_OPEN) ws.send(payload);
    }
  }
}
