# Tic Tac Toe

Source for the game served at `/games/tic-tac-toe/`. Unlike the other games,
which are self-contained HTML in `public/games/`, this one is multiplayer, so it
has a server side and therefore a source folder of its own.

Nothing here is built by the Astro build. `npm run build` in this folder writes
the client into `../../public/games/tic-tac-toe/`, and that output is committed,
exactly like the hand-written games next to it.

## Where the code lives

| Path | What it is |
| --- | --- |
| `src/shared/rules.ts` | Board, win detection, win-length validation. Pure. |
| `src/server/rooms.ts` | Room state and every rule for changing it. No sockets, no storage, no clocks. Pure. |
| `src/worker/` | The Cloudflare transport. Durable Objects, what actually gets deployed. |
| `src/server/index.ts` | The Node transport. Local dev and the bulk of the test suite. |
| `src/client/` | React client, shared by both. |

Both transports drive the same `rooms.ts`, so the rules cannot diverge. What
differs is only how a socket finds its room and where state is kept.

## Two transports, one client

The Worker has to choose a Durable Object before the socket exists, so the
client's intent travels in the query string rather than in a first message:

```
/ws?room=ABC123&player=<id>     join, or create at 3 in a row if new
/ws?room=new&player=<id>&win=5  create, the Worker mints the id
/ws?queue=5&player=<id>         ask the lobby for a random opponent
```

The Node server reads the same parameters, which is why one client works against
both. It also still accepts the older first-message form, which is what most of
the test suite uses.

## Running it

```
npm run dev      # Node server + Vite, the fast loop
npm run cf:dev   # wrangler dev, the real Durable Objects
```

For `cf:dev` the client is served separately, pointed at the Worker's port:

```
PORT=8787 npx vite
```

## Tests

```
npm test         # Rules, Node transport, and controlled-clock Worker alarm tests
npm run test:cf  # Integration tests against `wrangler dev --port 8799`
```

`tests/cf/` needs the Worker up and fails loudly if it is not, rather than
skipping, so a dead Worker cannot be mistaken for a pass.

## Room lifetime and alarms

The Worker schedules one-shot alarms for the next turn deadline or room cleanup.
Moves replace the turn deadline; a finished game has no turn alarm. A rematch
keeps the room id and seats, resets the board, and starts a new 30-second turn.

Cleanup is due 24 hours after the last open connection disappears, including
spectators. Reconnecting cancels that cleanup deadline. A public room created by
matchmaking also gets a cleanup deadline until its first connection arrives.
The deadline is persisted, so hibernation and duplicate close events do not
extend it. Rooms from older deployments receive this metadata when they wake.

Expired deadlines are consumed before selecting the next alarm. In particular,
connected rooms no longer reschedule `createdAt + 24h` after it has passed.
`tests/worker/alarms.test.mjs` exercises this regression, cleanup, reconnects,
legacy rooms, and rematches with a controlled clock and platform stand-ins;
`tests/cf/` checks the real Workers runtime and WebSockets.

## Deploying

The Worker owns only the socket. The client is static and Pages already serves
it, so the Worker needs a route covering one path, which takes precedence over
Pages on the same zone.

1. `npx wrangler deploy` from this folder, once, to create the Worker.
2. Uncomment the `routes` block in `wrangler.toml` and deploy again, or add the
   route `davidnd.dev/games/tic-tac-toe/ws` in the dashboard.

SQLite-backed Durable Objects are available on the free plan, subject to its
usage limits. Alarm executions count as requests and scheduling alarms consumes
storage writes. Hibernation avoids duration charges for eligible idle objects;
it does not make alarm executions free.
