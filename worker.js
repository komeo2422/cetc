const CACHE_TTL = 60 * 60 * 1000;
const CACHE_ID  = "pool_v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── PLAYER DATABASE (nomi verificati) ─────────────────────────────────────
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
    if (!p.nome || !p.nome.includes(" ")) return false;
    // Solo giocatori con carriera iniziata dal 1990
    if (p.carriera && p.carriera.length > 0) {
      const earliest = Math.min(...p.carriera.map(c => parseInt(c.anni?.split("-")[0]) || 9999));
      if (earliest < 1990) return false;
    }
    return true;
  });
  for (let i = valid.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [valid[i], valid[j]] = [valid[j], valid[i]];
  }
  return valid.slice(0, 100).map(p => p.nome);
}

// ── WIKIPEDIA (dati accurati) ─────────────────────────────────────────────
const WP_HEADERS = {
  "User-Agent": "CetcFootballTrivia/1.0 (https://cetc.komeobuschito.workers.dev; matteo.buschittari@gmail.com)",
  "Accept": "application/json",
};

async function getWikipediaCareer(playerName) {
  const searchRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(playerName + " footballer")}&format=json&origin=*&srlimit=1`,
    { headers: WP_HEADERS }
  );
  const results = (await searchRes.json()).query?.search || [];
  if (!results.length) throw new Error("Wikipedia not found: " + playerName);

  const pageRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(results[0].title)}&prop=revisions&rvprop=content&rvslots=main&format=json&origin=*`,
    { headers: WP_HEADERS }
  );
  const pages = (await pageRes.json()).query?.pages || {};
  const content = Object.values(pages)[0]?.revisions?.[0]?.slots?.main?.["*"] || "";
  if (!content) throw new Error("Empty Wikipedia page");

  // Parse infobox clubs/caps/goals/years fields for accurate structured data
  const yearsRaw  = content.match(/\|\s*years\s*=\s*([\s\S]+?)(?=\n\s*\|[a-zA-Z])/)?.[1] || "";
  const clubsRaw  = content.match(/\|\s*clubs\s*=\s*([\s\S]+?)(?=\n\s*\|[a-zA-Z])/)?.[1] || "";
  const capsRaw   = content.match(/\|\s*caps\s*=\s*([\s\S]+?)(?=\n\s*\|[a-zA-Z])/)?.[1] || "";
  const goalsRaw  = content.match(/\|\s*goals\s*=\s*([\s\S]+?)(?=\n\s*\|[a-zA-Z])/)?.[1] || "";

  function parseList(raw) {
    return raw
      .replace(/\{\{plainlist\|?\s*/gi, "")
      .replace(/\}\}/g, "")
      .split("\n")
      .map(l => l.replace(/\*\s*/, "").replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1").replace(/\{\{[^}]+\}\}/g, "").replace(/'''|''/g, "").trim())
      .filter(Boolean);
  }

  const years  = parseList(yearsRaw);
  const clubs  = parseList(clubsRaw);
  const caps   = parseList(capsRaw).map(v => parseInt(v.replace(/[^0-9]/g, "")) || 0);
  const goals  = parseList(goalsRaw).map(v => parseInt(v.replace(/[^0-9]/g, "")) || 0);

  if (clubs.length === 0) {
    // Fallback to infobox raw
    const infobox = content.match(/\{\{Infobox football biography([\s\S]{200,6000}?)\}\}/i)?.[0] || content.substring(0, 5000);
    return { title: results[0].title, carriera: null, rawContent: infobox };
  }

  // Build career array — detect loans from club name containing "loan" or "→"
  const carriera = clubs.map((club, i) => {
    const isLoan = /→|loan|\(in\s*prestito\)/i.test(club);
    const cleanClub = club.replace(/→\s*/, "").replace(/\s*\(loan\)/i, "").replace(/\s*\(in\s*prestito\)/i, "").trim();
    return {
      anni: years[i] || "?",
      squadra: cleanClub,
      prestito: isLoan,
      presenze: caps[i] || 0,
      gol: goals[i] || 0,
    };
  }).filter(c =>
    // Remove national team entries
    !/national|nazionale|under-|unter-|olimp|youth/i.test(c.squadra)
  );

  return { title: results[0].title, carriera, rawContent: null };
}

// ── /api/ask ──────────────────────────────────────────────────────────────
async function handleAsk(request, env) {
  const AN_KEY = env.ANTHROPIC_API_KEY;
  const SB_URL = env.SUPABASE_URL;
  const SB_KEY = env.SUPABASE_KEY;

  if (!AN_KEY) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), { status: 500, headers: CORS });

  let { players, expired } = await poolRead(SB_URL, SB_KEY);
  if (expired || players.length === 0) {
    players = await buildPool(env);
    await poolWrite(SB_URL, SB_KEY, players, true);
  }

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
      const { title, carriera, rawContent } = await getWikipediaCareer(playerName);

      let finalCarriera = carriera;

      // If structured parsing failed, use Claude to extract
      if (!finalCarriera) {
        const json = await askClaude(`Estrai la carriera da calciatore (non allenatore, non nazionale) da questo testo Wikipedia per "${title}".
Ogni riga = una squadra o prestito separato. Indica prestito:true se è un prestito.
Escludi nazionali e squadre giovanili.
RISPONDI SOLO JSON:
[{"anni":"XXXX-XXXX","squadra":"...","prestito":false,"presenze":0,"gol":0}]

Testo:
${rawContent}`, 600, AN_KEY);
        finalCarriera = JSON.parse(json.replace(/```json|```/g, "").trim());
      }

      if (!finalCarriera || finalCarriera.length === 0) throw new Error("no career");

      // Check Serie A presence (20+ apps)
      const SERIE_A = ["milan","inter","juventus","roma","lazio","fiorentina","napoli",
        "torino","sampdoria","genoa","atalanta","bologna","parma","udinese","cagliari",
        "palermo","reggina","chievo","lecce","brescia","bari","verona","vicenza","piacenza",
        "perugia","empoli","siena","livorno","catania","cesena","crotone","benevento",
        "sassuolo","frosinone","spal","spezia","venezia","salernitana","hellas"];
      const serieAApps = finalCarriera
        .filter(c => SERIE_A.some(s => c.squadra.toLowerCase().includes(s)))
        .reduce((sum, c) => sum + (c.presenze || 0), 0);
      if (serieAApps < 20) throw new Error("too_few_serie_a");

      // Check career start 1990+
      const earliest = Math.min(...finalCarriera.map(c => parseInt(c.anni?.split("-")[0]) || 9999));
      if (earliest < 1990) throw new Error("career_too_old");

      // Generate episodio
      const episodio = await askClaude(
        `In una frase sola, scrivi un fatto o episodio noto al pubblico italiano sul calciatore ${playerName}. Solo la frase, nient'altro.`,
        80, AN_KEY
      );

  // Extract nationality and position from infobox
  const natMatch  = content.match(/\|\s*(?:nationalteam|birth_place|nationality)[^\n]*\n[\s\S]*?\|\s*nat\w*\s*=\s*([^\n|]+)/i)
                 || content.match(/\|\s*nat\w*\s*=\s*([^\n|{]+)/i);
  const posMatch  = content.match(/\|\s*position\s*=\s*([^\n|{]+)/i);
  const citizenship = content.match(/\|\s*birth_place\s*=\s*([^\n|{]+)/i);

  // Also try parsing from categories
  const natFromLabel = content.match(/\[\[Category:[A-Za-z\s]+(?:footballer|player)/i);

  // Extract nationality from "nat =" field in infobox
  let nazionalita = "";
  const natField = content.match(/\|\s*nat\d*\s*=\s*([A-Z]{2,3})/g);
  if (natField && natField.length > 0) {
    const code = natField[0].match(/([A-Z]{2,3})$/)?.[1] || "";
    const codeMap = {
      ITA:"Italiano", ENG:"Inglese", FRA:"Francese", ESP:"Spagnolo",
      BRA:"Brasiliano", ARG:"Argentino", NED:"Olandese", GER:"Tedesco",
      POR:"Portoghese", CRO:"Croato", SRB:"Serbo", BEL:"Belga",
      URU:"Uruguaiano", COL:"Colombiano", CHI:"Cileno", PAR:"Paraguaiano",
      NOR:"Norvegese", SWE:"Svedese", DEN:"Danese", POL:"Polacco",
      CZE:"Ceco", SVK:"Slovacco", HUN:"Ungherese", ROM:"Rumeno",
      UKR:"Ucraino", RUS:"Russo", TUR:"Turco", GHA:"Ghanese",
      CIV:"Ivoriano", SEN:"Senegalese", NGA:"Nigeriano", CMR:"Camerunese",
      USA:"Americano", MEX:"Messicano", JAP:"Giapponese", KOR:"Sudcoreano",
      AUS:"Australiano", SCO:"Scozzese", WAL:"Gallese", IRL:"Irlandese",
      SUI:"Svizzero", AUT:"Austriaco", GRE:"Greco", ALB:"Albanese",
      MKD:"Macedone", BIH:"Bosniaco", SVN:"Sloveno", MNE:"Montenegrino",
    };
    nazionalita = codeMap[code] || code;
  }

  // Position mapping
  const posRaw = posMatch?.[1]?.trim().replace(/\[\[|\]\]/g,"") || "";
  const posMap = {
    "goalkeeper":"Portiere","defender":"Difensore","midfielder":"Centrocampista",
    "forward":"Attaccante","striker":"Centravanti","winger":"Ala",
    "centre-back":"Difensore centrale","central defender":"Difensore centrale",
    "left back":"Terzino sinistro","right back":"Terzino destro",
    "centre midfield":"Centrocampista","defensive midfield":"Mediano",
    "attacking midfield":"Trequartista","left midfield":"Ala sinistra",
    "right midfield":"Ala destra",
  };
  const ruolo = posMap[posRaw.toLowerCase()] || posRaw || "Calciatore";

      return new Response(JSON.stringify({
        nome: playerName,
        nomi_alternativi: [cognome],
        ruolo: "",
        nazionalita: "",
        episodio,
        carriera: finalCarriera,
      }), { status: 200, headers: CORS });

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
