const { getStore } = require("@netlify/blobs");

const AN_KEY   = process.env.ANTHROPIC_API_KEY;
const CACHE_TTL = 60 * 60 * 1000; // 1 ora
const POOL_SIZE = 50;

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

// ── NETLIFY BLOBS POOL ────────────────────────────────────────────────────
function getBlob() {
  return getStore({ name: "cetc-pool", consistency: "strong" });
}

async function poolRead() {
  try {
    const store = getBlob();
    const raw = await store.get("pool", { type: "json" });
    if (!raw) return { players: [], expired: true };
    const expired = Date.now() - new Date(raw.updated_at).getTime() > CACHE_TTL;
    return { players: raw.players || [], expired };
  } catch { return { players: [], expired: true }; }
}

async function poolWrite(players, resetTimer = false) {
  try {
    const store = getBlob();
    const existing = await store.get("pool", { type: "json" }).catch(() => null);
    const updated_at = resetTimer
      ? new Date().toISOString()
      : (existing?.updated_at || new Date().toISOString());
    await store.set("pool", JSON.stringify({ players, updated_at }));
  } catch (e) { console.warn("blob write failed", e.message); }
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

  // 1. Leggi pool da Netlify Blobs
  let { players, expired } = await poolRead();

  // 2. Ricarica se scaduto o vuoto
  if (expired || players.length === 0) {
    try {
      players = await fetchFromWikidata();
      await poolWrite(players, true);
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
    // Pool esaurito mid-loop → ricomincia
    if (!players.length) {
      try {
        players = await fetchFromWikidata();
        await poolWrite(players, true);
      } catch {
        return { statusCode: 500, body: JSON.stringify({ error: "Pool exhausted" }) };
      }
    }

    // Prendi un giocatore casuale e rimuovilo subito
    const idx = Math.floor(Math.random() * players.length);
    const playerName = players.splice(idx, 1)[0];
    await poolWrite(players); // salva pool aggiornato senza resettare il timer

    try {
      const { title, content } = await getWikipediaCareer(playerName);

      const json = await askClaude(`Sei un esperto di calcio italiano. Analizza il contenuto Wikipedia per "${title}".

LIVELLO RICHIESTO: ${diff} — ${diffGuide[diff]}
Se NON corrisponde al livello → {"error":"wrong_difficulty"}
Se non è un calciatore professionista → {"error":"not_footballer"}
Se ha meno di 20 presenze totali in Serie A → {"error":"too_few_apps"}

REGOLE:
- Ogni trasferimento/prestito = riga SEPARATA (mai raggruppare)
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
      if (attempt === MAX_ATTEMPTS - 1) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
      }
      continue;
    }
  }
};
