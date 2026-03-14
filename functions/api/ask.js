const CACHE_TTL = 60 * 60 * 1000; // 1 ora
const POOL_SIZE  = 50;
const CACHE_ID   = "pool_v1";

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
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
}

// ── SUPABASE POOL ─────────────────────────────────────────────────────────
function sbHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates",
  };
}

async function poolRead(sbUrl, sbKey) {
  const res = await fetch(
    `${sbUrl}/rest/v1/player_cache?id=eq.${CACHE_ID}&select=players,updated_at`,
    { headers: sbHeaders(sbKey) }
  );
  const rows = await res.json();
  if (!rows.length) return { players: [], expired: true };
  const expired = Date.now() - new Date(rows[0].updated_at).getTime() > CACHE_TTL;
  return { players: rows[0].players || [], expired };
}

async function poolWrite(sbUrl, sbKey, players, resetTimer = false) {
  const body = { id: CACHE_ID, players };
  if (resetTimer) body.updated_at = new Date().toISOString();
  await fetch(`${sbUrl}/rest/v1/player_cache`, {
    method: "POST",
    headers: sbHeaders(sbKey),
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
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": "CetcTrivia/1.0" } });
  if (!res.ok) throw new Error("Wikidata HTTP " + res.status);
  const data = await res.json();
  const players = (data.results?.bindings || [])
    .map(b => b.playerLabel?.value)
    .filter(n => n && !n.startsWith("Q") && /\s/.test(n));
  if (players.length < 10) throw new Error("Wikidata too few results");
  return players;
}

// ── WIKIPEDIA ─────────────────────────────────────────────────────────────
async function getWikipediaCareer(playerName) {
  const searchRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(playerName + " footballer")}&format=json&origin=*&srlimit=2`
  );
  const results = (await searchRes.json()).query?.search || [];
  if (!results.length) throw new Error("Wikipedia not found: " + playerName);

  for (const r of results) {
    const pageRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(r.title)}&prop=revisions&rvprop=content&rvslots=main&format=json&origin=*`
    );
    const pages = (await pageRes.json()).query?.pages || {};
    const content = Object.values(pages)[0]?.revisions?.[0]?.slots?.main?.["*"] || "";
    if (!content.match(/football|calciat|soccer/i)) continue;
    const infobox = content.match(/\{\{Infobox football biography([\s\S]{200,6000}?)\}\}/i)?.[0];
    const clubs   = content.match(/\|\s*clubs\s*=([\s\S]{50,2000}?)(?=\n\s*\|[a-zA-Z])/)?.[0];
    return { title: r.title, content: infobox || clubs || content.substring(0, 5000) };
  }
  throw new Error("No valid football page for: " + playerName);
}

// ── HANDLER ───────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const AN_KEY = env.ANTHROPIC_API_KEY;
  const SB_URL = env.SUPABASE_URL;
  const SB_KEY = env.SUPABASE_KEY;

  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  let diff;
  try { diff = (await request.json()).diff; }
  catch { return new Response(JSON.stringify({ error: "Invalid body" }), { status: 400, headers: cors }); }

  // 1. Read pool
  let { players, expired } = await poolRead(SB_URL, SB_KEY);

  // 2. Refill if expired or empty
  if (expired || players.length === 0) {
    try {
      players = await fetchFromWikidata();
      await poolWrite(SB_URL, SB_KEY, players, true);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Wikidata failed: " + e.message }), { status: 500, headers: cors });
    }
  }

  const diffGuide = {
    Facile:     "È famoso a livello internazionale: campione del mondo, Pallone d'Oro, o icona assoluta della Serie A.",
    Intermedio: "È conosciuto dagli appassionati italiani: almeno 2-3 stagioni regolari in Serie A ma non superstar mondiale.",
    Difficile:  "È poco noto: poche presenze in Serie A (ma almeno 20), giocato principalmente in Serie B/C.",
  };

  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!players.length) {
      try {
        players = await fetchFromWikidata();
        await poolWrite(SB_URL, SB_KEY, players, true);
      } catch {
        return new Response(JSON.stringify({ error: "Pool exhausted" }), { status: 500, headers: cors });
      }
    }

    const idx = Math.floor(Math.random() * players.length);
    const playerName = players[idx];
    players = await poolConsume(SB_URL, SB_KEY, players, playerName);

    try {
      const { title, content } = await getWikipediaCareer(playerName);

      const json = await askClaude(`Sei un esperto di calcio italiano. Analizza il contenuto Wikipedia per "${title}".

LIVELLO RICHIESTO: ${diff} — ${diffGuide[diff]}
Se il calciatore NON corrisponde a questo livello → {"error":"wrong_difficulty"}
Se non è un calciatore professionista → {"error":"not_footballer"}
Se ha meno di 20 presenze totali in Serie A → {"error":"too_few_apps"}

REGOLE:
- Ogni trasferimento/prestito = riga SEPARATA
- Solo dati presenti nel testo Wikipedia
- Solo carriera da giocatore (non allenatore)
- Presenze e gol: numeri interi (0 se non disponibile)

RISPONDI SOLO con JSON:
{"nome":"...","nomi_alternativi":["Cognome"],"ruolo":"ruolo in italiano","nazionalita":"nazionalità in italiano","episodio":"Una frase su fatto noto al pubblico italiano.","carriera":[{"anni":"XXXX-XXXX","squadra":"...","presenze":0,"gol":0}]}

Contenuto Wikipedia:
${content}`, 900, AN_KEY);

      const clean = json.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed.error) throw new Error(parsed.error);

      return new Response(JSON.stringify(parsed), { status: 200, headers: cors });

    } catch (e) {
      if (attempt === MAX_ATTEMPTS - 1) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
      continue;
    }
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" },
  });
}
