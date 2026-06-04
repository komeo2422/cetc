const CACHE_TTL = 60 * 60 * 1000;
const CACHE_ID  = "pool_v2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const SERIE_A = [
  "milan","inter","juventus","roma","lazio","fiorentina","napoli",
  "torino","sampdoria","genoa","atalanta","bologna","parma","udinese","cagliari",
  "palermo","reggina","chievo","lecce","brescia","bari","verona","vicenza","piacenza",
  "perugia","empoli","siena","livorno","catania","cesena","crotone","benevento",
  "sassuolo","frosinone","spal","spezia","venezia","salernitana","hellas","reggiana",
  "ancona","ascoli","avellino","foggia","messina","modena","novara","pisa",
  "ternana","triestina","pescara","cremonese","monza","lecco","como","lucchese",
];

// ── PLAYER DATABASE ────────────────────────────────────────────────────────
let _playerDB = null;
async function getPlayerDB(env) {
  if (_playerDB) return _playerDB;
  const res = await env.ASSETS.fetch("https://cetc.komeobuschito.workers.dev/serie_a_players.json");
  if (!res.ok) throw new Error("Cannot load player database");
  _playerDB = await res.json();
  return _playerDB;
}

function isValidPlayer(p) {
  if (!p.nome || !p.nome.includes(" ")) return false;
  const carriera = p.carriera;
  if (!carriera || carriera.length === 0) return false;

  // Must have career starting 1990 or later
  const years = carriera
    .map(c => parseInt(c.anni?.split("-")[0]))
    .filter(y => !isNaN(y));
  if (years.length === 0) return false;
  if (Math.min(...years) < 1990) return false;

  // Must have at least one Serie A club with data
  const hasSerieA = carriera.some(c =>
    SERIE_A.some(s => c.squadra?.toLowerCase().includes(s))
  );
  if (!hasSerieA) return false;

  // Must have some appearances recorded (not all zeros across entire career)
  const totalApps = carriera.reduce((s, c) => s + (c.presenze || 0), 0);
  if (totalApps === 0) return false;

  return true;
}

// ── SUPABASE ──────────────────────────────────────────────────────────────
function sbH(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates",
  };
}

async function poolRead(sbUrl, sbKey) {
  try {
    const res = await fetch(
      `${sbUrl}/rest/v1/player_cache?id=eq.${CACHE_ID}&select=players,updated_at`,
      { headers: sbH(sbKey) }
    );
    const rows = await res.json();
    if (!rows.length) return { players: [], expired: true };
    const expired = Date.now() - new Date(rows[0].updated_at).getTime() > CACHE_TTL;
    return { players: rows[0].players || [], expired };
  } catch { return { players: [], expired: true }; }
}

async function poolWrite(sbUrl, sbKey, players, resetTimer = false) {
  const body = { id: CACHE_ID, players };
  if (resetTimer) body.updated_at = new Date().toISOString();
  await fetch(`${sbUrl}/rest/v1/player_cache`, {
    method: "POST",
    headers: sbH(sbKey),
    body: JSON.stringify(body),
  });
}

async function poolConsume(sbUrl, sbKey, players, name) {
  const updated = players.filter(p => p !== name);
  await poolWrite(sbUrl, sbKey, updated);
  return updated;
}

async function buildPool(env) {
  const db = await getPlayerDB(env);
  const valid = db.filter(isValidPlayer);
  // Fisher-Yates shuffle
  for (let i = valid.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [valid[i], valid[j]] = [valid[j], valid[i]];
  }
  return valid.slice(0, 150).map(p => p.nome);
}

// ── /api/ask ──────────────────────────────────────────────────────────────
async function handleAsk(request, env) {
  const SB_URL = env.SUPABASE_URL;
  const SB_KEY = env.SUPABASE_KEY;

  let { players, expired } = await poolRead(SB_URL, SB_KEY);
  if (expired || players.length === 0) {
    players = await buildPool(env);
    await poolWrite(SB_URL, SB_KEY, players, true);
  }

  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!players.length) {
      players = await buildPool(env);
      await poolWrite(SB_URL, SB_KEY, players, true);
    }

    const idx = Math.floor(Math.random() * players.length);
    const playerName = players[idx];
    players = await poolConsume(SB_URL, SB_KEY, players, playerName);

    // Look up pre-built career from the JSON
    const db = await getPlayerDB(env);
    const player = db.find(p => p.nome === playerName);

    if (!player || !isValidPlayer(player)) continue;

    // Filter out national team / youth entries from career display
    const carriera = player.carriera.filter(c =>
      !/national|nazionale|under-|unter-|olimp|youth|u\d{2}/i.test(c.squadra || "")
    );

    if (carriera.length === 0) continue;

    return new Response(JSON.stringify({
      nome: player.nome,
      ruolo: player.ruolo || "",
      nazionalita: player.nazionalita || "",
      carriera,
    }), { status: 200, headers: CORS });
  }

  return new Response(JSON.stringify({ error: "No valid player found after retries" }), { status: 500, headers: CORS });
}

// ── /api/scores ───────────────────────────────────────────────────────────
async function handleScoresGet(env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/leaderboard?select=*&order=avg_score.desc`,
    { headers: sbH(env.SUPABASE_KEY) }
  );
  return new Response(await res.text(), { status: 200, headers: CORS });
}

async function handleScoresPost(request, env) {
  const { username, pts } = await request.json();
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/leaderboard?username=eq.${encodeURIComponent(username)}`,
    { headers: sbH(env.SUPABASE_KEY) }
  );
  const rows = await r.json();
  const ex = rows[0];
  const ns = (ex?.total_score || 0) + pts;
  const nq = (ex?.total_q || 0) + 1;
  const avg = Math.round(ns / nq * 100) / 100;
  await fetch(`${env.SUPABASE_URL}/rest/v1/leaderboard`, {
    method: "POST",
    headers: sbH(env.SUPABASE_KEY),
    body: JSON.stringify({
      username,
      total_score: ns,
      total_q: nq,
      avg_score: avg,
      updated_at: new Date().toISOString(),
    }),
  });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
}

// ── ROUTER ────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/api/test") {
      return new Response(JSON.stringify({
        su: !!env.SUPABASE_URL,
        sk: !!env.SUPABASE_KEY,
        assets: !!env.ASSETS,
      }), { status: 200, headers: CORS });
    }

    try {
      if (path === "/api/ask"    && method === "POST") return await handleAsk(request, env);
      if (path === "/api/scores" && method === "GET")  return await handleScoresGet(env);
      if (path === "/api/scores" && method === "POST") return await handleScoresPost(request, env);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
