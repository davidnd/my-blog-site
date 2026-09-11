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
npm test         # 131 tests, pure logic and the Node transport, no setup
npm run test:cf  # 13 tests against a running `npm run cf:dev`
```

`tests/cf/` needs the Worker up and fails loudly if it is not, rather than
skipping, so a dead Worker cannot be mistaken for a pass.

## Deploying

The Worker owns only the socket. The client is static and Pages already serves
it, so the Worker needs a route covering one path, which takes precedence over
Pages on the same zone.

1. `npx wrangler deploy` from this folder, once, to create the Worker.
2. Uncomment the `routes` block in `wrangler.toml` and deploy again, or add the
   route `davidnd.dev/games/tic-tac-toe/ws` in the dashboard.

All of it fits the free plan. Durable Objects are free with the SQLite storage
backend, which is what `new_sqlite_classes` in `wrangler.toml` selects, and
hibernation means an idle room or lobby accrues no duration charge.
