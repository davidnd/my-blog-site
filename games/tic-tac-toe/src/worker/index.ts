/**
 * The Worker is only a router. It decides which Durable Object should own the
 * socket and forwards the upgrade; every rule and every piece of state lives
 * inside the objects. This replaces node:http, `ws` and static.ts, none of
 * which have an equivalent here because there is no long-lived process.
 */

import { newRoomId } from '../server/rooms.ts';
import { isValidWinLength, MAX_WIN_LENGTH, MIN_WIN_LENGTH } from '../shared/rules.ts';
import { GameRoom } from './room.ts';
import { LobbyRoom } from './lobby.ts';

export { GameRoom, LobbyRoom };

type Env = {
  ROOM: DurableObjectNamespace<GameRoom>;
  LOBBY: DurableObjectNamespace<LobbyRoom>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/ws')) {
      return new Response('not found', { status: 404 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const playerId = url.searchParams.get('player');
    if (playerId === null || playerId === '') {
      return new Response('missing player id', { status: 400 });
    }

    // Routing has to happen before the socket opens, so what the Node server
    // read from the first message is carried in the query string instead.
    const queue = url.searchParams.get('queue');
    if (queue !== null) {
      const winLength = Number(queue);
      if (!isValidWinLength(winLength)) {
        return new Response(
          `win length must be a whole number from ${MIN_WIN_LENGTH} to ${MAX_WIN_LENGTH}`,
          { status: 400 },
        );
      }
      return env.LOBBY.getByName(`lobby:${winLength}`).fetch(request);
    }

    const asked = url.searchParams.get('room');
    if (asked === null || asked === '') {
      return new Response('missing room id', { status: 400 });
    }
    // An object never learns the name it was addressed by, so a minted id has
    // to be written back into the URL for the object to read.
    const roomId = asked === 'new' ? newRoomId(() => false) : asked.toUpperCase();
    const forward = new URL(url);
    forward.searchParams.set('room', roomId);
    return env.ROOM.getByName(roomId).fetch(new Request(forward, request));
  },
};
