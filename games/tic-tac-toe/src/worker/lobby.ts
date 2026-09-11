/**
 * Random matchmaking, one object per win length.
 *
 * The Node server could scan `rooms.values()` for a free seat because every
 * room lived in one process. Durable Objects cannot be enumerated, so that scan
 * is impossible and this object takes its place: every player wanting a given
 * win length is routed here by name, `lobby:5`, from anywhere in the world.
 *
 * It holds two things. The people waiting are simply its open sockets, with
 * their identity in the hibernation attachment, so there is no queue structure
 * to keep. The ids of public rooms with a free seat do need storage, because a
 * room can free a seat while nobody is queued at all.
 *
 * It never seats anyone. A WebSocket cannot be moved between objects, so it
 * names a room and the client connects to that room itself.
 */

import { DurableObject } from 'cloudflare:workers';

import { newRoomId } from '../server/rooms.ts';
import { isValidWinLength } from '../shared/rules.ts';
import type { ServerMessage } from '../shared/types.ts';
import type { GameRoom } from './room.ts';

/** Survives hibernation on the socket itself; this is the whole queue entry. */
type Waiting = { playerId: string; winLength: number };

export type LobbyEnv = { ROOM: DurableObjectNamespace<GameRoom> };

export class LobbyRoom extends DurableObject<LobbyEnv> {
  /** Public rooms believed to have a free seat. A hint: the room is the authority. */
  #open: string[] = [];

  constructor(ctx: DurableObjectState, env: LobbyEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.#open = (await ctx.storage.get<string[]>('open')) ?? [];
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const playerId = url.searchParams.get('player') ?? '';
    const winLength = Number(url.searchParams.get('queue'));
    if (playerId === '') return new Response('missing player id', { status: 400 });
    if (!isValidWinLength(winLength)) return new Response('invalid win length', { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId, winLength } satisfies Waiting);

    // Runs after the upgrade response goes back, so the client is listening by
    // the time a match lands. waitUntil keeps it alive past the return.
    this.ctx.waitUntil(this.#match(server, playerId, winLength));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A public room says it has a seat going spare. */
  async roomOpened(roomId: string): Promise<void> {
    if (!this.#open.includes(roomId)) {
      this.#open = [...this.#open, roomId];
      await this.ctx.storage.put('open', this.#open);
    }
    const waiting = this.#waiting();
    if (waiting === undefined) return;
    // Somebody is already queued for exactly this, so pair them immediately.
    if (!(await this.env.ROOM.getByName(roomId).joinable())) return;
    await this.#forget(roomId);
    this.#matched(waiting, roomId);
  }

  /** A public room filled up, or died. */
  async roomClosed(roomId: string): Promise<void> {
    await this.#forget(roomId);
  }

  async #match(ws: WebSocket, playerId: string, winLength: number): Promise<void> {
    // A half-full public room beats opening a new one: someone is already there.
    for (const roomId of [...this.#open]) {
      const joinable = await this.env.ROOM.getByName(roomId).joinable();
      await this.#forget(roomId);
      if (joinable) {
        this.#matched(ws, roomId);
        return;
      }
    }

    const partner = this.ctx.getWebSockets().find((other) => {
      if (other === ws || other.readyState !== WebSocket.READY_STATE_OPEN) return false;
      const waiting = other.deserializeAttachment() as Waiting | null;
      return waiting !== null && waiting.winLength === winLength && waiting.playerId !== playerId;
    });
    // Nobody about. Say nothing, and let the object hibernate holding the socket.
    if (partner === undefined) return;

    // Board size derives from win length, so only equal win lengths can pair.
    // There is no global room map to check an id against, so this leans on the
    // id space instead; a collision would land two games in one object.
    const roomId = newRoomId(() => false);
    await this.env.ROOM.getByName(roomId).openPublic(roomId, winLength);
    this.#matched(partner, roomId);
    this.#matched(ws, roomId);
  }

  /** The oldest player still connected, or undefined if the queue is empty. */
  #waiting(): WebSocket | undefined {
    return this.ctx
      .getWebSockets()
      .find((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
  }

  #matched(ws: WebSocket, roomId: string): void {
    ws.send(JSON.stringify({ type: 'matched', roomId } satisfies ServerMessage));
    ws.close(1000, 'matched');
  }

  async #forget(roomId: string): Promise<void> {
    const next = this.#open.filter((id) => id !== roomId);
    if (next.length === this.#open.length) return;
    this.#open = next;
    // Emptying the storage entirely means the object ceases to exist once the
    // last waiting socket goes, so a lobby needs no sweep of its own.
    if (next.length === 0) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.put('open', next);
  }
}
