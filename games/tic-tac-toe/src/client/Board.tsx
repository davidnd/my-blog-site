import type { CSSProperties } from 'react';

import type { GameState, Role } from '../shared/types.ts';

export function Board({
  state,
  role,
  onPlay,
}: {
  state: GameState;
  role: Role | null;
  onPlay: (index: number) => void;
}) {
  const cells = [...state.board];
  const yourTurn = state.status === 'playing' && role === state.turn;
  const winning = new Set(state.winLine ?? []);

  return (
    <div className="board" style={{ '--size': state.size } as CSSProperties}>
      {cells.map((cell, index) => {
        const empty = cell === '.';
        return (
          <button
            key={index}
            type="button"
            className={`cell${empty ? '' : ` mark-${cell}`}${winning.has(index) ? ' winning' : ''}`}
            disabled={!yourTurn || !empty}
            aria-label={
              empty ? `empty cell ${index + 1}` : `cell ${index + 1}, taken by ${cell}`
            }
            onClick={() => onPlay(index)}
          >
            {empty ? '' : cell}
          </button>
        );
      })}
    </div>
  );
}
