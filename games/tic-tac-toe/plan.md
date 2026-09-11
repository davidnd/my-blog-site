# Tic Tac Toe — multiplayer web game

## Context

`REQUIREMENTS.md` asks for a tic tac toe game that is really a small real-time
multiplayer system: two players, remote, on separate machines, with rooms,
invite links, per-move timers, and state that survives a refresh. The repo is
empty — this is a greenfield build.

The requirements force an **authoritative server**. Anything the client is
allowed to decide (whose turn it is, whether someone won, how much time is
left) can be lied about, and "game survives refresh" means the truth has to
live somewhere other than the browser. So: server owns the game, client is a
renderer.

Decisions confirmed with the user:

| Question     | Decision                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| Stack        | Node + TypeScript server, React client                                                 |
| Board size   | Derived from win length: `size = winLength * 2 + 2` → 3→8×8, 4→10×10, 5→12×12, 6→14×14 |
| Timer expiry | Timed-out player **loses** immediately                                                 |
| Persistence  | SQLite, so state survives server restart as well as refresh                            |

## Dependencies

Node 26 covers more than usual, so the list is short. Please confirm these when
approving:

- **Runtime:** `ws` (Node has a WebSocket _client_ built in, but no server).
- **Dev:** `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `typescript`,
  `@types/{react,react-dom,ws,node}`.
- **Deliberately not added:** no SQLite driver (`node:sqlite` is built in), no
  test runner (`node:test`), no `tsx`/`ts-node` (Node 26 strips types natively,
  so `node --test tests/*.ts` just works).

## Layout

```
src/shared/types.ts     wire protocol + GameState DTO (imported by both sides)
src/shared/rules.ts     PURE engine — no I/O, no time, no randomness
src/server/db.ts        node:sqlite schema, load/save room
src/server/rooms.ts     room lifecycle, seats, matchmaking queue, turn timers
src/server/index.ts     http (serves client build) + ws upgrade + dispatch
src/client/App.tsx      lobby ⇄ game, reads ?room= from URL
src/client/useGameSocket.ts  connect, reconnect w/ backoff, playerId identity
src/client/Board.tsx    grid, Cell, winning-line highlight
src/client/Timer.tsx    countdown rendered from server deadline
tests/*.test.ts         node:test
```

Keeping `rules.ts` pure is the main structural bet: it makes the hard part
(win detection on a 14×14 board with variable win length) testable without a
socket, a clock, or a browser.

## Core design

**Win detection** scans only the 4 axes through the cell just played, walking
out in both directions and counting — `O(winLength)`, not a full board scan.
It must not wrap around row edges; that's an explicit test case.

**Identity.** Client generates a `playerId` (`crypto.randomUUID()`) once and
keeps it in `localStorage`. Every join sends `{roomId, playerId}`. The server
matches that id to a seat (X or O) and replays current state. This single
mechanism covers refresh, tab close, laptop sleep, and flaky wifi — they are
all just "reconnect".

**Persistence** is write-through: the in-memory room map is the working copy,
every state transition also writes the row. Schema:

```sql
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, win_length INTEGER, board_size INTEGER,
  board TEXT,              -- 'size*size' chars of '.', 'X', 'O'
  turn TEXT, status TEXT,  -- waiting | playing | over
  winner TEXT, win_line TEXT,
  player_x TEXT, player_o TEXT,
  turn_deadline INTEGER, created_at INTEGER
);
```

On boot the server loads rooms from disk. A room whose `turn_deadline` already
passed while the server was down is resolved as a timeout at load time, so
restarts can't hand someone free extra thinking time.

**Timer.** The server stores an absolute `turn_deadline` and arms a
`setTimeout`. On fire: `status='over'`, winner = opponent, broadcast. The
client countdown is derived from that deadline (with a clock offset measured at
join) and is _display only_ — it never decides anything.

**Game-over lock.** The server rejects any move when `status !== 'playing'`;
the client also disables the board. Two layers, but only the server's counts.

**Matchmaking.** Two doors from the lobby: _Create room_ → short base32 id +
invite link `/?room=ABC123`, host picks win length; _Find random game_ → FIFO
queue keyed by win length (it has to be, since board size derives from it),
popped in pairs. A third connection to a full room becomes a read-only
spectator rather than an error.

## Slices

Each ends green, gets reported, and gets committed before the next starts.

1. **Rules engine.** `boardSizeFor`, `createBoard`, `applyMove`, `findWin`,
   `isDraw`. Tests: all four directions, win exactly at length, **no wrap
   across row edges**, draw on a full board, illegal move rejected, win length
   clamped to 3–6. No server, no UI.
2. **Two browsers can play.** http + ws server, one hardcoded room, React board
   that renders state and sends moves. No persistence, timer, or lobby yet.
3. **Persistence + reconnect.** `db.ts` write-through; rejoin by `playerId`.
   Test: play moves → drop socket → rejoin → identical state; and restart the
   server process mid-game → state loads from disk.
4. **Turn timer.** Deadline on the server, countdown in the UI, timeout ends
   the game. Test with an injectable timeout so it runs in milliseconds:
   assert `status==='over'`, winner is the opponent, and a later move is
   rejected.
5. **Lobby.** Win-length selector (shows the derived board size), create room,
   invite link, `?room=` deep link, random queue. Test: two queued players with
   matching win length land in one room with opposite seats.
6. **Classic polish + rematch.** Grid and X/O styling, winning line highlight,
   turn/status banner, "waiting for opponent", rematch that resets the room and
   swaps who moves first.

## Verification

- `npm test` — `node --test tests/` after each slice.
- `npm run dev`, then two browser windows:
  - create a room in one, paste the invite link into the other, play a full
    game to a win and confirm the board locks;
  - **refresh mid-game** — board, turn, and remaining time all come back;
  - **kill and restart the server mid-game** — same, from SQLite;
  - sit on a turn for 30s — the idle player loses, board locks;
  - two windows both clicking "Find random game" with the same win length get
    paired.

## Open questions (going into `OPEN_QUESTIONS.md`, with the simple option taken)

- Spectators for a third joiner — assumed read-only view, no chat, no limit.
- Abandoned rooms — assumed a periodic sweep deleting rooms untouched for 24h.
- Explicit "opponent left" handling — assumed none beyond the 30s timer, which
  already ends stalled games.
