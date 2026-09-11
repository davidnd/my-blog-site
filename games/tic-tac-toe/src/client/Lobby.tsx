import { useState } from 'react';

import { MAX_WIN_LENGTH, MIN_WIN_LENGTH } from '../shared/rules.ts';

const WIN_LENGTHS = Array.from(
  { length: MAX_WIN_LENGTH - MIN_WIN_LENGTH + 1 },
  (_, i) => MIN_WIN_LENGTH + i,
);

export function Lobby({
  onCreate,
  onQueue,
  onJoin,
  searching,
}: {
  onCreate: (winLength: number) => void;
  onQueue: (winLength: number) => void;
  onJoin: (roomId: string) => void;
  searching: boolean;
}) {
  const [winLength, setWinLength] = useState(3);
  const [roomId, setRoomId] = useState('');

  return (
    <div className="lobby">
      <fieldset className="field">
        <legend>Win length</legend>
        <div className="choices">
          {WIN_LENGTHS.map((n) => (
            <button
              key={n}
              type="button"
              className={`choice${n === winLength ? ' selected' : ''}`}
              aria-pressed={n === winLength}
              onClick={() => setWinLength(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="hint">
          {n2(winLength)}×{n2(winLength)} board · {winLength} in a row to win
        </p>
      </fieldset>

      <div className="actions">
        <button type="button" className="primary" onClick={() => onCreate(winLength)}>
          Create a room
        </button>
        <button type="button" onClick={() => onQueue(winLength)} disabled={searching}>
          {searching ? 'Looking for an opponent…' : 'Find a random game'}
        </button>
      </div>

      <form
        className="joiner"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = roomId.trim().toUpperCase();
          if (trimmed !== '') onJoin(trimmed);
        }}
      >
        <label htmlFor="room-id">Or join a friend’s room</label>
        <div className="row">
          <input
            id="room-id"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            placeholder="Room code"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={roomId.trim() === ''}>
            Join
          </button>
        </div>
      </form>
    </div>
  );
}

const n2 = (winLength: number) => winLength * 2 + 2;
