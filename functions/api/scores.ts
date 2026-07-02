// Global top-10 leaderboard for the fish game (public/games/fish/).
// Backed by a KV namespace bound as `SCORES` (Pages > Settings > Bindings).
// GET  /api/scores          -> { scores: [{ name, score, ts }] }
// POST /api/scores          <- { name, score }
//                           -> { saved: boolean, ts?: number, scores: [...] }

interface Env {
  SCORES: KVNamespace;
}

interface Entry {
  name: string;
  score: number;
  ts: number;
}

const KEY = "top10";
const MAX_ENTRIES = 10;
const MAX_NAME_LEN = 20;
const MAX_SCORE = 1_000_000; // far beyond any legitimate run

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function readBoard(env: Env): Promise<Entry[]> {
  const list = await env.SCORES.get<Entry[]>(KEY, "json");
  return Array.isArray(list) ? list : [];
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.SCORES) return json({ error: "SCORES KV binding is not configured" }, 500);
  return json({ scores: await readBoard(env) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.SCORES) return json({ error: "SCORES KV binding is not configured" }, 500);

  let body: { name?: unknown; score?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const score = body.score;
  if (typeof score !== "number" || !Number.isInteger(score) || score <= 0 || score > MAX_SCORE) {
    return json({ error: "invalid score" }, 400);
  }

  // Strip control characters, collapse whitespace, cap length.
  const name =
    String(typeof body.name === "string" ? body.name : "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME_LEN) || "Anonymous";

  const list = await readBoard(env);
  const full = list.length >= MAX_ENTRIES;
  if (full && score <= list[list.length - 1].score) {
    return json({ saved: false, scores: list });
  }

  const entry: Entry = { name, score, ts: Date.now() };
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.ts - b.ts);
  const top = list.slice(0, MAX_ENTRIES);
  await env.SCORES.put(KEY, JSON.stringify(top));

  return json({ saved: true, ts: entry.ts, scores: top });
};
