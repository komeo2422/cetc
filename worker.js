const CACHE_TTL = 60 * 60 * 1000;
const CACHE_ID  = "pool_v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── PLAYER DATABASE ───────────────────────────────────────────────────────
let _playerDB = null;
async function getPlayerDB(env) {
  if (_playerDB) return _playerDB;
  const res = await env.ASSETS.fetch("https://cetc.komeobuschito.workers.dev/serie_a_players.json");
  if (!res.ok) throw new Error("Cannot load player database");
  _playerDB = await res.json();
  return _playerDB;
}

// ── CLAUDE ────────────────────────────────────────────────────────────────
async function askClaude(prompt, maxTokens, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const rawText = await res.text();
  let data;
  try { data = JSON.parse(rawText); }
  catch (e) { throw new Error("Anthropic non-JSON: " + rawText.substring(0, 150)); }
  if (data.error) throw new Error("Anthropic: " + data.error.message);
  return data.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
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
  const valid = db.filter(p => {
    if (!p.nome || !p.nome.includes(" ") || !p.carriera || p.carriera.length === 0) return false;
    // Must have started career in 1990 or later
    const earliest = Math.min(...p.carriera.map(c => parseInt(c.anni?.split("-")[0]) || 9999));
    return earliest >= 1990;
  });
  for (let i = valid.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [valid[i], valid[j]] = [valid[j], valid[i]];
  }
  return valid.slice(0, 100).map(p => p.nome);
}

// ── /api/ask ──────────────────────────────────────────────────────────────
async function handleAsk(request, env) {
  const { diff } = await request.json();
  const AN_KEY = env.ANTHROPIC_API_KEY;
  const SB_URL = env.SUPABASE_URL;
  const SB_KEY = env.SUPABASE_KEY;

  if (!AN_KEY) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), { status: 500, headers: CORS });

  const db = await getPlayerDB(env);
  const dbMap = Object.fromEntries(db.map(p => [p.nome, p]));

  let { players, expired } = await poolRead(SB_URL, SB_KEY);
  if (expired || players.length === 0) {
    players = await buildPool(env);
    await poolWrite(SB_URL, SB_KEY, players, true);
  }

  const diffGuide = {
    Facile:     "famoso a livello internazionale: campione del mondo, Pallone d'Oro, icona assoluta della Serie A",
    Intermedio: "conosciuto dagli appassionati italiani: almeno 2-3 stagioni solide in Serie A",
    Difficile:  "poco noto: poche presenze in Serie A, giocato principalmente in serie minori",
  };

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!players.length) {
      players = await buildPool(env);
      await poolWrite(SB_URL, SB_KEY, players, true);
    }

    const idx = Math.floor(Math.random() * players.length);
    const playerName = players[idx];
    players = await poolConsume(SB_URL, SB_KEY, players, playerName);

    try {
      const p = dbMap[playerName];
      if (!p) throw new Error("Player not found in DB: " + playerName);
      if (!p.carriera || p.carriera.length === 0) throw new Error("No career data");

      // Must have started career 1990+
      const earliest = Math.min(...p.carriera.map(c => parseInt(c.anni?.split("-")[0]) || 9999));
      if (earliest < 1990) throw new Error("career_too_old");

      // Count Serie A apps
      const SERIE_A_CLUBS = ["Milan","Inter","Juventus","Roma","Lazio","Fiorentina","Napoli",
        "Torino","Sampdoria","Genoa","Atalanta","Bologna","Parma","Udinese","Cagliari",
        "Palermo","Reggina","Chievo","Lecce","Brescia","Bari","Verona","Vicenza","Piacenza",
        "Perugia","Empoli","Siena","Livorno","Catania","Cesena","Crotone","Benevento",
        "Sassuolo","Hellas Verona","Frosinone","SPAL","Spezia","Venezia","Salernitana"];
      const serieAApps = p.carriera
        .filter(c => SERIE_A_CLUBS.some(club => c.squadra?.includes(club)))
        .reduce((s, c) => s + (c.presenze || 0), 0);
      if (serieAApps < 20) throw new Error("too_few_serie_a");

      // Generate episodio with Claude (fast — just one sentence)
      const episodio = await askClaude(
        `In una frase sola, scrivi un fatto o episodio noto al pubblico italiano sul calciatore ${p.nome}. Solo la frase, nient'altro.`,
        80, AN_KEY
      );

      // Build cognome for nomi_alternativi
      const parts = p.nome.trim().split(" ");
      const cognome = parts[parts.length - 1];

      const result = {
        nome: p.nome,
        nomi_alternativi: [cognome],
        ruolo: p.ruolo || "Calciatore",
        nazionalita: p.nazionalita || "",
        episodio: episodio,
        carriera: p.carriera,
      };

      return new Response(JSON.stringify(result), { status: 200, headers: CORS });

    } catch (e) {
      console.error("attempt failed:", e.message);
      if (attempt === MAX_ATTEMPTS - 1) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
      continue;
    }
  }
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
    body: JSON.stringify({ username, total_score: ns, total_q: nq, avg_score: avg, updated_at: new Date().toISOString() }),
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
        ak: !!env.ANTHROPIC_API_KEY,
        su: !!env.SUPABASE_URL,
        sk: !!env.SUPABASE_KEY,
        assets: !!env.ASSETS,
      }), { status: 200, headers: CORS });
    }

    if (path === "/api/testanthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }),
      });
      return new Response(await res.text(), { status: 200, headers: CORS });
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
