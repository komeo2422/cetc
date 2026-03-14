const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const AN_KEY = process.env.ANTHROPIC_API_KEY;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 ore

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

// ── SUPABASE CACHE ────────────────────────────────────────────────────────
async function cacheGet(key) {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/player_cache?id=eq.${encodeURIComponent(key)}&select=players,updated_at`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    const rows = await res.json();
    if (!rows.length) return null;
    if (Date.now() - new Date(rows[0].updated_at).getTime() > CACHE_TTL) return null;
    return rows[0].players; // array of strings
  } catch { return null; }
}

async function cacheSet(key, players) {
  try {
    await fetch(`${SB_URL}/rest/v1/player_cache`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ id: key, players, updated_at: new Date().toISOString() }),
    });
  } catch (e) { console.warn("cache write failed", e.message); }
}

// ── WIKIDATA ──────────────────────────────────────────────────────────────
// Single pool: all footballers who played in Serie A (wdt:P118 = Q15804)
// born 1960-1998 so they cover the 1990-today window
async function fetchFromWikidata() {
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
    LIMIT 2000
  `;
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "CetcTrivia/1.0 (football quiz; contact via netlify)" },
  });
  if (!res.ok) throw new Error("Wikidata HTTP " + res.status);
  const data = await res.json();
  const players = (data.results?.bindings || [])
    .map(b => b.playerLabel?.value)
    .filter(n => n && !n.startsWith("Q") && /\s/.test(n)); // nome cognome, no QID
  if (players.length < 50) throw new Error("Wikidata returned too few results");
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

    // Extract the most relevant section
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

  // 1. Get player pool (cache → Wikidata)
  let pool = await cacheGet("pool_all");
  if (!pool) {
    try {
      pool = await fetchFromWikidata();
      await cacheSet("pool_all", pool);
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ error: "Wikidata failed: " + e.message }) };
    }
  }

  const MAX_ATTEMPTS = 5;
  const tried = new Set();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // 2. Pick random player not yet tried this request
      let playerName;
      for (let i = 0; i < 20; i++) {
        const candidate = pool[Math.floor(Math.random() * pool.length)];
        if (!tried.has(candidate)) { playerName = candidate; break; }
      }
      if (!playerName) throw new Error("Pool exhausted");
      tried.add(playerName);

      // 3. Wikipedia career stats
      const { title, content } = await getWikipediaCareer(playerName);

      // 4. Claude: extract + validate difficulty
      const diffGuide = {
        Facile:     "È famoso a livello internazionale: campione del mondo, Pallone d'Oro, o icona assoluta della Serie A. Qualsiasi tifoso italiano lo conosce.",
        Intermedio: "È conosciuto dagli appassionati di calcio italiani: ha giocato almeno 2-3 stagioni regolari in Serie A ma non è una superstar mondiale.",
        Difficile:  "È poco noto: ha fatto poche presenze in Serie A (ma almeno 20 in totale), ha giocato principalmente in Serie B/C o è uno straniero di cui i tifosi ricordano poco.",
      };

      const json = await askClaude(`Sei un esperto di calcio italiano. Analizza il contenuto Wikipedia per "${title}".

LIVELLO RICHIESTO: ${diff} — ${diffGuide[diff]}
Se il calciatore NON corrisponde a questo livello, rispondi SOLO con: {"error":"wrong_difficulty"}
Se non è un calciatore professionista, rispondi SOLO con: {"error":"not_footballer"}
Se ha meno di 20 presenze totali in Serie A, rispondi SOLO con: {"error":"too_few_apps"}

REGOLE per l'estrazione:
- Ogni trasferimento e prestito = riga SEPARATA (non raggruppare mai)
- Usa solo dati presenti nel testo Wikipedia
- Includi solo carriera da giocatore (non da allenatore)
- Presenze e gol: numeri interi (0 se non disponibile)

RISPONDI SOLO con JSON valido:
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
      if (attempt === MAX_ATTEMPTS - 1) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
      }
      continue;
    }
  }
};
