// Global top-10 leaderboards for the games under public/games/.
// Backed by a KV namespace bound as `SCORES` (Pages > Settings > Bindings).
// GET  /api/scores?game=fish   -> { scores: [{ name, score, ts }] }
// POST /api/scores             <- { name, score, game }
//                              -> { saved: boolean, ts?: number, scores: [...] }
// `game` defaults to "fish", whose board keeps the original "top10" KV key.

interface Env {
  SCORES: KVNamespace;
}

interface Entry {
  name: string;
  score: number;
  ts: number;
}

// key = KV key (fish predates multi-game support, so it keeps the bare "top10").
// maxScore = far beyond any legitimate run, per game.
const GAMES: Record<string, { key: string; maxScore: number }> = {
  fish: { key: "top10", maxScore: 1_000_000 },
  tetris: { key: "top10:tetris", maxScore: 5_000_000 },
};

const MAX_ENTRIES = 10;
const MAX_NAME_LEN = 20;

function gameConfig(name: unknown) {
  return GAMES[typeof name === "string" && name ? name : "fish"] ?? null;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function readBoard(env: Env, key: string): Promise<Entry[]> {
  const list = await env.SCORES.get<Entry[]>(key, "json");
  return Array.isArray(list) ? list : [];
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.SCORES) return json({ error: "SCORES KV binding is not configured" }, 500);
  const game = gameConfig(new URL(request.url).searchParams.get("game"));
  if (!game) return json({ error: "unknown game" }, 400);
  return json({ scores: await readBoard(env, game.key) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.SCORES) return json({ error: "SCORES KV binding is not configured" }, 500);

  let body: { name?: unknown; score?: unknown; game?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const game = gameConfig(body.game);
  if (!game) return json({ error: "unknown game" }, 400);

  const score = body.score;
  if (typeof score !== "number" || !Number.isInteger(score) || score <= 0 || score > game.maxScore) {
    return json({ error: "invalid score" }, 400);
  }

  // Strip control characters, collapse whitespace, cap length.
  const name =
    String(typeof body.name === "string" ? body.name : "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME_LEN) || "Anonymous";

  const list = await readBoard(env, game.key);
  const full = list.length >= MAX_ENTRIES;
  if (full && score <= list[list.length - 1].score) {
    return json({ saved: false, scores: list });
  }

  const entry: Entry = { name, score, ts: Date.now() };
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.ts - b.ts);
  const top = list.slice(0, MAX_ENTRIES);
  await env.SCORES.put(game.key, JSON.stringify(top));

  return json({ saved: true, ts: entry.ts, scores: top });
};
