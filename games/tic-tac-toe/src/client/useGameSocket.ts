import { useCallback, useEffect, useRef, useState } from 'react';

import type { GameState, Role, ServerMessage } from '../shared/types.ts';

const PLAYER_ID_KEY = 'axon.playerId';
const FIRST_RETRY_MS = 400;
const MAX_RETRY_MS = 8000;

/** Stable per-browser identity. This is what a seat is tied to. */
export function playerId(): string {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (id === null) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

/**
 * The socket sits next to the page, so it is `/ws` in dev and
 * `/games/tic-tac-toe/ws` once Pages serves the client from that folder.
 */
function wsPath(): string {
  return `${location.pathname.replace(/[^/]*$/, '')}ws`;
}

/**
 * Where to connect, and what for. The Cloudflare Worker has to choose a Durable
 * Object before the socket exists, so what used to be the first message over
 * the wire is carried in the query string instead. The Node server reads the
 * same parameters, which is why one client drives both.
 */
function socketUrl(intent: Intent, roomId: string | null): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ player: playerId() });
  if (roomId !== null) {
    params.set('room', roomId);
  } else if (intent.kind === 'join') {
    params.set('room', intent.roomId);
  } else if (intent.kind === 'create') {
    params.set('room', 'new');
    params.set('win', String(intent.winLength));
  } else {
    params.set('queue', String(intent.winLength));
  }
  return `${scheme}://${location.host}${wsPath()}?${params.toString()}`;
}

/** How this browser wants to get into a game. Null means "still in the lobby". */
export type Intent =
  | { kind: 'join'; roomId: string }
  | { kind: 'create'; winLength: number }
  | { kind: 'queue'; winLength: number };

export type Connection = {
  state: GameState | null;
  role: Role | null;
  error: string | null;
  connected: boolean;
  /** Queued for a random game, with no opponent found yet. */
  searching: boolean;
  /** Add to Date.now() to read the server's clock; covers browser clock skew. */
  clockOffset: number;
  play: (index: number) => void;
  /** Clear the board for another game in the same room. */
  rematch: () => void;
  /** Give the seat back; the caller then drops the intent to close the socket. */
  leave: () => void;
};

export function useGameSocket(intent: Intent | null): Connection {
  const [state, setState] = useState<GameState | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [searching, setSearching] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  /**
   * Once the server has put us in a room, every later connection rejoins that
   * room by id. Replaying 'create' or 'queue' on a reconnect would open a
   * second room and strand the game we were already in.
   */
  const roomRef = useRef<string | null>(null);

  useEffect(() => {
    // A new intent is a new game. Nothing from the last room may leak into it,
    // or the finished board would show while we queue for the next opponent.
    roomRef.current = null;
    setState(null);
    setRole(null);
    setError(null);
    setSearching(intent?.kind === 'queue');
    if (intent === null) return;

    let disposed = false;
    let retryMs = FIRST_RETRY_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /** Set when the lobby named our room, so the reconnect is immediate. */
    let straightBack = false;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(socketUrl(intent, roomRef.current));
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (disposed) return;
        retryMs = FIRST_RETRY_MS;
        setConnected(true);
      });

      socket.addEventListener('message', (event) => {
        if (disposed) return;
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === 'joined' || message.type === 'state') {
          // Rough, but the countdown only needs to be right to the second.
          setClockOffset(message.serverNow - Date.now());
        }
        if (message.type === 'matched') {
          // The lobby cannot hand us a seat, only a room id. Go there at once.
          roomRef.current = message.roomId;
          straightBack = true;
          socket.close();
        } else if (message.type === 'joined') {
          roomRef.current = message.state.roomId;
          setRole(message.role);
          setState(message.state);
          setSearching(false);
          setError(null);
        } else if (message.type === 'state') {
          setState(message.state);
        } else if (message.type === 'error') {
          setError(message.message);
          setSearching(false);
        }
      });

      socket.addEventListener('close', () => {
        if (disposed) return;
        setConnected(false);
        if (straightBack) {
          // Not a failure: we were told where to go, so no backoff.
          straightBack = false;
          retryMs = FIRST_RETRY_MS;
          connect();
          return;
        }
        // Back off so a server that is down does not get hammered.
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      });
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [intent]);

  const play = useCallback((index: number) => {
    setError(null);
    socketRef.current?.send(JSON.stringify({ type: 'move', index }));
  }, []);

  const rematch = useCallback(() => {
    setError(null);
    socketRef.current?.send(JSON.stringify({ type: 'rematch' }));
  }, []);

  const leave = useCallback(() => {
    // Sent before the socket closes, so the server frees the seat instead of
    // holding it for a reconnect that is never coming. While reconnecting there
    // is no session to leave, and send() on a socket that is not open throws.
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave' }));
  }, []);

  return { state, role, error, connected, searching, clockOffset, play, rematch, leave };
}
