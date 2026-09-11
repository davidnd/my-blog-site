/**
 * Random matching. Rooms the matchmaker opens are public: a queued player drops
 * into one that is waiting with a free seat, and a seat that opens in one is
 * offered back to the queue. Rooms made on purpose — "Create a room", invite
 * links — are private and never touched here (OPEN_QUESTIONS #10). Only when
 * no public room is open do two queued players get a fresh room between them.
 */

import type { WebSocket } from 'ws';

import { createRoom, newRoomId, seatOf, type Room } from './rooms.ts';

type Waiting = { ws: WebSocket; playerId: string };

export type Matchmaker = {
  /** A player wants a random game at this win length. */
  queue: (ws: WebSocket, playerId: string, winLength: number) => void;
  /** A seat may have opened in this room; hand it to whoever queued longest. */
  offer: (room: Room) => void;
  /** The socket is gone or has moved on; forget it. */
  forget: (ws: WebSocket) => void;
};

export function createMatchmaker(deps: {
  rooms: Map<string, Room>;
  /** Whether a seat-holder is still connected to the room, so nobody is matched into an empty chair. */
  hostPresent: (room: Room) => boolean;
  /** Seats the player and tells everyone; the transport owns sockets and storage. */
  seat: (ws: WebSocket, room: Room, playerId: string) => void;
}): Matchmaker {
  const { rooms, hostPresent, seat } = deps;
  /** Players with no room yet, oldest first, keyed by win length. */
  const queues = new Map<number, Waiting[]>();

  const forget = (ws: WebSocket) => {
    for (const [winLength, waiting] of queues) {
      const remaining = waiting.filter((entry) => entry.ws !== ws);
      if (remaining.length === 0) queues.delete(winLength);
      else if (remaining.length !== waiting.length) queues.set(winLength, remaining);
    }
  };

  const openRoomFor = (winLength: number, playerId: string): Room | undefined => {
    for (const room of rooms.values()) {
      if (room.visibility !== 'public') continue;
      if (room.status !== 'waiting' || room.winLength !== winLength) continue;
      if (room.seats.X !== null && room.seats.O !== null) continue;
      if (seatOf(room, playerId) !== null) continue;
      if (hostPresent(room)) return room;
    }
    return undefined;
  };

  const offer = (room: Room) => {
    if (room.visibility !== 'public' || room.status !== 'waiting') return;
    const waiting = queues.get(room.winLength);
    if (!waiting) return;
    const index = waiting.findIndex(
      (entry) => entry.ws.readyState === entry.ws.OPEN && seatOf(room, entry.playerId) === null,
    );
    if (index === -1) return;
    const entry = waiting[index]!;
    waiting.splice(index, 1);
    if (waiting.length === 0) queues.delete(room.winLength);
    seat(entry.ws, room, entry.playerId);
  };

  /**
   * A player with nobody to pair with is told nothing — there is no room to
   * show them yet, and inventing one would leak an empty room per click.
   */
  const queue = (ws: WebSocket, playerId: string, winLength: number) => {
    // Re-queueing replaces the earlier entry rather than stacking up.
    forget(ws);
    const open = openRoomFor(winLength, playerId);
    if (open) {
      seat(ws, open, playerId);
      return;
    }
    const waiting = (queues.get(winLength) ?? []).filter(
      (entry) => entry.playerId !== playerId && entry.ws.readyState === entry.ws.OPEN,
    );

    const partner = waiting.shift();
    if (partner === undefined) {
      waiting.push({ ws, playerId });
      queues.set(winLength, waiting);
      return;
    }
    queues.set(winLength, waiting);

    // Board size derives from win length, so only equal win lengths can pair.
    const room = createRoom(newRoomId((id) => rooms.has(id)), winLength, Date.now(), 'public');
    rooms.set(room.id, room);
    seat(partner.ws, room, partner.playerId);
    seat(ws, room, playerId);
  };

  return { queue, offer, forget };
}
