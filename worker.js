const CACHE_TTL = 60 * 60 * 1000;
const POOL_SIZE  = 50;
const CACHE_ID   = "pool_v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

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
  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!text) throw new Error("Empty response from Claude");
  return text;
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

// ── WIKIDATA ──────────────────────────────────────────────────────────────
async function fetchFromWikidata() {
  const offset = Math.floor(Math.random() * 1500);
  const sparql = `
    SELECT DISTINCT ?playerLabel WHERE {
      ?player wdt:P31 wd:Q5 ;
              wdt:P106 wd:Q937857 ;
              wdt:P54 ?club .
      ?club wdt:P118 wd:Q15804 .
      ?player wdt:P569 ?birth .
      FILTER(YEAR(?birth) >= 1960 && YEAR(?birth) <= 1998)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
    }
    LIMIT ${POOL_SIZE}
    OFFSET ${offset}
  `;

  const res = await fetch(
    `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`,
    {
      headers: {
        "User-Agent": "CetcFootballTrivia/1.0 (https://cetc.komeobuschito.workers.dev; matteo.buschittari@gmail.com) Cloudflare-Worker",
        "Accept": "application/sparql-results+json",
      }
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Wikidata HTTP ${res.status}: ${txt.substring(0, 100)}`);
  }

  const data = await res.json();
  const players = (data.results?.bindings || [])
    .map(b => b.playerLabel?.value)
    .filter(n => n && !n.startsWith("Q") && /\s/.test(n));

  if (players.length < 5) throw new Error("Wikidata too few results: " + players.length);
  return players;
}

// ── WIKIPEDIA ─────────────────────────────────────────────────────────────
async function getWikipediaCareer(playerName) {
  const WP_HEADERS = {
    "User-Agent": "CetcFootballTrivia/1.0 (https://cetc.komeobuschito.workers.dev; matteo.buschittari@gmail.com) Cloudflare-Worker",
    "Accept": "application/json",
  };

  const searchRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(playerName + " footballer")}&format=json&origin=*&srlimit=1`,
    { headers: WP_HEADERS }
  );
  const results = (await searchRes.json()).query?.search || [];
  if (!results.length) throw new Error("Wikipedia not found: " + playerName);

  const pageRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(results[0].title)}&prop=revisions&rvprop=content&rvslots=main&format=json&origin=*&rvsection=0`,
    { headers: WP_HEADERS }
  );
  const pages = (await pageRes.json()).query?.pages || {};
  const content = Object.values(pages)[0]?.revisions?.[0]?.slots?.main?.["*"] || "";
  if (!content) throw new Error("Empty Wikipedia page");

  // Extract only the clubs/career stats section from the infobox
  const clubsMatch = content.match(/\|\s*clubs\s*=\s*([\s\S]+?)(?=\n\s*\|\s*caps|\n\s*\|\s*goals|\n\s*\|\s*nationalteam|\n\s*\|\s*youthclubs|\}\})/i);
  const capsMatch  = content.match(/\|\s*caps\s*=\s*([\s\S]+?)(?=\n\s*\|\s*goals|\n\s*\|\s*nationalteam|\n\s*\|\s*youthclubs|\}\})/i);
  const goalsMatch = content.match(/\|\s*goals\s*=\s*([\s\S]+?)(?=\n\s*\|\s*nationalteam|\n\s*\|\s*youthclubs|\}\})/i);
  const yearsMatch = content.match(/\|\s*years\s*=\s*([\s\S]+?)(?=\n\s*\|\s*clubs|\n\s*\|\s*caps|\}\})/i);

  if (clubsMatch && capsMatch && goalsMatch) {
    // Parse structured infobox data
    const clubs = clubsMatch[1].split("{{plainlist|").join("").split("{{Plainlist|").join("")
      .split("\n").map(l => l.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1").replace(/\{\{.*?\}\}/g, "").replace(/[*'\[\]]/g, "").trim()).filter(Boolean);
    const caps  = capsMatch[1].split("\n").map(l => l.replace(/[^0-9]/g, "").trim()).filter(Boolean);
    const goals = goalsMatch[1].split("\n").map(l => l.replace(/[^0-9]/g, "").trim()).filter(Boolean);
    const years = yearsMatch ? yearsMatch[1].split("\n").map(l => l.replace(/[*'\[\]]/g, "").trim()).filter(Boolean) : [];

    const rows = clubs.map((club, i) => `${years[i] || "?"} | ${club} | ${caps[i] || "0"} presenze | ${goals[i] || "0"} gol`).join("\n");
    return { title: results[0].title, content: `Carriera di ${results[0].title}:\n${rows}` };
  }

  // Fallback: use infobox or raw content
  const infobox = content.match(/\{\{Infobox football biography([\s\S]{200,6000}?)\}\}/i)?.[0];
  return { title: results[0].title, content: infobox || content.substring(0, 5000) };
}

// ── /api/ask ──────────────────────────────────────────────────────────────
async function handleAsk(request, env) {
  const { diff } = await request.json();
  const AN_KEY = env.ANTHROPIC_API_KEY;
  const SB_URL = env.SUPABASE_URL;
  const SB_KEY = env.SUPABASE_KEY;

  if (!AN_KEY) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), { status: 500, headers: CORS });

  let { players, expired } = await poolRead(SB_URL, SB_KEY);
  if (expired || players.length === 0) {
    players = await fetchFromWikidata();
    await poolWrite(SB_URL, SB_KEY, players, true);
  }

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!players.length) {
      players = await fetchFromWikidata();
      await poolWrite(SB_URL, SB_KEY, players, true);
    }

    const idx = Math.floor(Math.random() * players.length);
    const playerName = players[idx];
    players = await poolConsume(SB_URL, SB_KEY, players, playerName);

    try {
      const { title, content } = await getWikipediaCareer(playerName);

      const json = await askClaude(`Sei un esperto di calcio. Analizza questo testo Wikipedia per "${title}".

Se NON è un calciatore professionista rispondi SOLO: {"error":"not_footballer"}
Se ha meno di 20 presenze TOTALI in Serie A (considera Serie A solo le squadre della massima divisione italiana: Milan, Inter, Juventus, Roma, Lazio, Fiorentina, Napoli, Torino, Sampdoria, Genoa, Atalanta, Bologna, Parma, Udinese, Cagliari, Palermo, Reggina, Chievo, Lecce, Brescia, Bari, Verona, Vicenza, Piacenza, Perugia, ecc.) rispondi SOLO: {"error":"too_few_serie_a"}

Altrimenti rispondi SOLO con questo JSON (nient'altro):
{"nome":"...","nomi_alternativi":["Cognome"],"ruolo":"ruolo in italiano","nazionalita":"nazionalità in italiano","episodio":"Un fatto sulla sua carriera noto al pubblico italiano.","carriera":[{"anni":"XXXX-XXXX","squadra":"...","presenze":0,"gol":0}]}

Regole: ogni squadra/prestito = riga separata. Presenze e gol: numeri interi (0 se non disponibile).

Wikipedia:
${content}`, 900, AN_KEY);

      const clean = json.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed.error) throw new Error(parsed.error);
      return new Response(JSON.stringify(parsed), { status: 200, headers: CORS });

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
