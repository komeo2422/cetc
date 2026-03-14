const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const AN_KEY = process.env.ANTHROPIC_API_KEY;
const CACHE_TTL = 60 * 60 * 1000; // 1 ora
const POOL_SIZE = 50;
const CACHE_ID  = "pool_v1";

const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
  Prefer: "resolution=merge-duplicates",
};

// ── CLAUDE ────────────────────────────────────────────────────────────────
async function askClaude(prompt, maxTokens = 900) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": AN_KEY,
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
async function poolRead() {
  const res = await fetch(
    `${SB_URL}/rest/v1/player_cache?id=eq.${CACHE_ID}&select=players,updated_at`,
    { headers: SB_HEADERS }
  );
  const rows = await res.json();
  if (!rows.length) return { players: [], expired: true };
  const expired = Date.now() - new Date(rows[0].updated_at).getTime() > CACHE_TTL;
  return { players: rows[0].players || [], expired };
}

async function poolWrite(players, resetTimer = false) {
  const body = { id: CACHE_ID, players };
  if (resetTimer) body.updated_at = new Date().toISOString();
  await fetch(`${SB_URL}/rest/v1/player_cache`, {
    method: "POST",
    headers: SB_HEADERS,
    body: JSON.stringify(body),
  });
}

// Remove one player from pool and save
async function poolConsume(players, name) {
  const updated = players.filter(p => p !== name);
  await poolWrite(updated); // don't reset timer — keep original hour
  return updated;
}

// ── WIKIDATA ──────────────────────────────────────────────────────────────
async function fetchFromWikidata() {
  const offset = Math.floor(Math.random() * 1500); // random window into the dataset
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
  const res = await fetch(url, {
    headers: { "User-Agent": "CetcTrivia/1.0 (football quiz)" },
  });
  if (!res.ok) throw new Error("Wikidata HTTP " + res.status);
  const data = await res.json();
  const players = (data.results?.bindings || [])
    .map(b => b.playerLabel?.value)
    .filter(n => n && !n.startsWith("Q") && /\s/.test(n));
  if (players.length < 10) throw new Error("Wikidata returned too few results");
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
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  let diff;
  try { diff = JSON.parse(event.body).diff; }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid body" }) }; }

  // 1. Read pool from Supabase
  let { players, expired } = await poolRead();

  // 2. Refill if expired (1h passed) OR empty
  if (expired || players.length === 0) {
    try {
      players = await fetchFromWikidata();
      await poolWrite(players, true); // reset 1h timer
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ error: "Wikidata failed: " + e.message }) };
    }
  }

  const diffGuide = {
    Facile:     "È famoso a livello internazionale: campione del mondo, Pallone d'Oro, o icona assoluta della Serie A.",
    Intermedio: "È conosciuto dagli appassionati italiani: almeno 2-3 stagioni regolari in Serie A ma non superstar mondiale.",
    Difficile:  "È poco noto: poche presenze in Serie A (ma almeno 20), giocato principalmente in Serie B/C o straniero di passaggio.",
  };

  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!players.length) {
      // Pool esaurito mid-loop → ricomincia
      try {
        players = await fetchFromWikidata();
        await poolWrite(players, true);
      } catch {
        return { statusCode: 500, body: JSON.stringify({ error: "Pool exhausted and Wikidata failed" }) };
      }
    }

    // Pick a random player from the pool
    const idx = Math.floor(Math.random() * players.length);
    const playerName = players[idx];

    // Remove from pool immediately (no repeats)
    players = await poolConsume(players, playerName);

    try {
      // Wikipedia stats
      const { title, content } = await getWikipediaCareer(playerName);

      // Claude extraction
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
${content}`);

      const clean = json.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed.error) throw new Error(parsed.error);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      };

    } catch (e) {
      // Player invalid → already removed from pool, try next
      if (attempt === MAX_ATTEMPTS - 1) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
      }
      continue;
    }
  }
};
