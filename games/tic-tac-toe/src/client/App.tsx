import { useEffect, useState } from 'react';

import { Board } from './Board.tsx';
import { Lobby } from './Lobby.tsx';
import { Timer } from './Timer.tsx';
import { useGameSocket, type Intent } from './useGameSocket.ts';
import { boardSizeFor } from '../shared/rules.ts';
import type { GameState, Role } from '../shared/types.ts';

/** An invite link is just the page with ?room=CODE on it. */
function roomFromUrl(): string | null {
  const room = new URLSearchParams(location.search).get('room');
  return room === null || room === '' ? null : room.toUpperCase();
}

/**
 * A win on the board explains itself. A forfeit or a flag fall does not — the
 * winner may not have played a single move — so those say what ended the game.
 */
function statusLine(state: GameState, role: Role | null): string {
  if (state.status === 'waiting') return 'Waiting for an opponent…';
  if (state.status !== 'over') {
    return state.turn === role ? 'Your turn.' : `${state.turn} to play…`;
  }
  if (state.winner === 'draw') return 'Draw.';
  if (state.winner === null) return 'Game over.';

  const winner = state.winner;
  const loser = winner === 'X' ? 'O' : 'X';
  const youWon = winner === role;

  if (state.endReason === 'forfeit') {
    return youWon ? 'Your opponent left. You win.' : `${loser} left. ${winner} wins.`;
  }
  if (state.endReason === 'timeout') {
    if (youWon) return 'Your opponent ran out of time. You win.';
    const who = role === loser ? 'You' : loser;
    return `${who} ran out of time. ${winner} wins.`;
  }
  return youWon ? 'You win.' : `${winner} wins.`;
}

export function App() {
  const [intent, setIntent] = useState<Intent | null>(() => {
    const room = roomFromUrl();
    return room === null ? null : { kind: 'join', roomId: room };
  });
  const { state, role, error, connected, searching, clockOffset, play, rematch, leave } =
    useGameSocket(intent);

  // Keep the address bar on the room we are actually in, so the tab itself is
  // the invite link and a refresh comes back to the same game.
  useEffect(() => {
    if (state === null) return;
    if (roomFromUrl() === state.roomId) return;
    history.replaceState(null, '', `?room=${encodeURIComponent(state.roomId)}`);
  }, [state]);

  if (intent === null) {
    return (
      <main className="app">
        <h1>Tic Tac Toe</h1>
        <Lobby
          searching={false}
          onCreate={(winLength) => setIntent({ kind: 'create', winLength })}
          onQueue={(winLength) => setIntent({ kind: 'queue', winLength })}
          onJoin={(roomId) => setIntent({ kind: 'join', roomId })}
        />
        {error !== null && <p className="error">{error}</p>}
      </main>
    );
  }

  if (state === null) {
    // Between the lobby and a room: queued for a random game, or still joining.
    return (
      <main className="app">
        <h1>Tic Tac Toe</h1>
        <section className="panel" aria-live="polite">
          <div className="pulse" aria-hidden="true">
            <span className="mark-X">X</span>
            <span className="mark-O">O</span>
          </div>
          <p className="status">
            {!connected ? 'Connecting…' : searching ? 'Looking for an opponent…' : 'Joining…'}
          </p>
          {intent.kind === 'join' ? (
            <p className="hint">Room {intent.roomId}</p>
          ) : (
            <p className="hint">
              {boardSizeFor(intent.winLength)}×{boardSizeFor(intent.winLength)} board ·{' '}
              {intent.winLength} in a row
            </p>
          )}
          {error !== null && <p className="error">{error}</p>}
          <button type="button" onClick={() => setIntent(null)}>
            Cancel
          </button>
        </section>
      </main>
    );
  }

  const invite = `${location.origin}${location.pathname}?room=${state.roomId}`;

  return (
    <main className="app">
      <header>
        <h1>Tic Tac Toe</h1>
        <p className="meta">
          Room {state.roomId} · {state.size}×{state.size} · {state.winLength} in a row ·{' '}
          {role === 'spectator' ? 'watching' : `you are ${role ?? '…'}`}
        </p>
      </header>

      <p className={`status${state.status === 'over' ? ' over' : ''}`}>
        {statusLine(state, role)}{' '}
        {state.turnDeadline !== null && (
          <Timer deadline={state.turnDeadline} clockOffset={clockOffset} />
        )}
      </p>

      {state.status === 'waiting' && (
        <p className="invite">
          Share this link: <code>{invite}</code>{' '}
          <button type="button" onClick={() => void navigator.clipboard?.writeText(invite)}>
            Copy
          </button>
        </p>
      )}

      <Board state={state} role={role} onPlay={play} />

      <div className="actions-row">
        {state.status === 'over' && role !== 'spectator' && (
          <button type="button" className="primary" onClick={rematch}>
            New game
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            leave();
            history.replaceState(null, '', location.pathname);
            setIntent(null);
          }}
        >
          Leave
        </button>
      </div>

      {error !== null && <p className="error">{error}</p>}
      {!connected && <p className="error">Reconnecting…</p>}
    </main>
  );
}
