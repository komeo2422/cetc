const CACHE_TTL = 60 * 60 * 1000;
const CACHE_ID  = "pool_v11";

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

// Pattern regex strict per ogni club Serie A italiano.
// Esclude omonimi stranieri (Internacional brasiliana, Inter Zaprešic, etc)
// e altri club italiani con nome simile (Atletico Roma, Internapoli, etc).
const TEAM_PATTERNS = {
  milan:       /^(ac\s+|acf\s+|associazione\s+calcio\s+)?milan$/i,
  inter:       /^(fc\s+|football\s+club\s+)?(inter|internazionale)(\s+milano?)?$/i,
  juventus:    /^juventus(\s+(fc|football\s+club))?$/i,
  roma:        /^(as\s+|associazione\s+sportiva\s+)?roma$/i,
  lazio:       /^(ss\s+|società\s+sportiva\s+)?lazio$/i,
  fiorentina:  /^(acf\s+|associazione\s+calcio\s+)?fiorentina$/i,
  napoli:      /^(ssc\s+|società\s+sportiva\s+calcio\s+)?napoli$/i,
  torino:      /^torino(\s+(fc|football\s+club|calcio))?$/i,
  sampdoria:   /^(uc\s+|unione\s+calcio\s+)?sampdoria$/i,
  genoa:       /^genoa(\s+(cfc|cricket\s+and\s+football\s+club))?$/i,
  atalanta:    /^atalanta(\s+(bc|bergamasca\s+calcio))?$/i,
  bologna:     /^bologna(\s+(fc|football\s+club))?(\s+1909)?$/i,
  parma:       /^parma(\s+(fc|calcio))?(\s+1913)?$/i,
  udinese:     /^udinese(\s+calcio)?$/i,
  cagliari:    /^cagliari(\s+calcio)?$/i,
  palermo:     /^palermo(\s+(fc|football\s+club|calcio))?$/i,
  reggina:     /^reggina(\s+1914)?$/i,
  chievo:      /^(ac\s+|associazione\s+calcio\s+)?chievo(\s*verona)?$|^chievoverona$/i,
  lecce:       /^(us\s+|unione\s+sportiva\s+)?lecce$/i,
  brescia:     /^brescia(\s+calcio)?$/i,
  bari:        /^(ssc\s+|società\s+sportiva\s+calcio\s+|as\s+|fc\s+)?bari$/i,
  verona:      /^(h\.\s*|hellas\s+)?verona$|^hellas\s+verona(\s+fc)?$/i,
  hellas:      /^hellas\s+verona(\s+fc)?$/i,
  vicenza:     /^(l\.r\.\s+)?vicenza(\s+(calcio|virtus))?$/i,
  piacenza:    /^piacenza(\s+calcio)?(\s+1919)?$/i,
  perugia:     /^(ac\s+)?perugia(\s+calcio)?$/i,
  empoli:      /^empoli(\s+football\s+club)?$/i,
  siena:       /^(ac\s+|robur\s+)?siena(\s+football\s+club)?$/i,
  livorno:     /^(us\s+|associazione\s+sportiva\s+)?livorno(\s+1915)?$/i,
  catania:     /^catania(\s+(football\s+club|calcio))?$/i,
  cesena:      /^cesena(\s+football\s+club)?$/i,
  crotone:     /^(fc\s+)?crotone$/i,
  benevento:   /^benevento(\s+calcio)?$/i,
  sassuolo:    /^(unione\s+sportiva\s+sassuolo\s+calcio|us\s+sassuolo(\s+calcio)?|sassuolo(\s+calcio)?)$/i,
  frosinone:   /^frosinone(\s+calcio)?$/i,
  spal:        /^(s\.p\.a\.l\.|spal)$/i,
  spezia:      /^spezia(\s+calcio)?$/i,
  venezia:     /^venezia(\s+(fc|calcio))?$|^calcio\s+venezia$/i,
  salernitana: /^(us\s+|unione\s+sportiva\s+)?salernitana(\s+1919)?$/i,
  reggiana:    /^(ac\s+)?reggiana(\s+1919)?$/i,
  ancona:      /^(società\s+sportiva\s+calcio\s+|us\s+|ssc\s+)?ancona$/i,
  ascoli:      /^ascoli(\s+calcio(\s+1898\s+fc)?)?$/i,
  avellino:    /^(us\s+|unione\s+sportiva\s+)?avellino(\s+1912)?$/i,
  foggia:      /^(calcio\s+)?foggia(\s+1920)?$/i,
  messina:     /^(acr\s+|fc\s+)?messina$/i,
  modena:      /^modena(\s+football\s+club(\s+2018)?)?$/i,
  novara:      /^novara(\s+fc|\s+calcio)?$/i,
  pisa:        /^pisa(\s+sporting\s+club|\s+calcio)?$/i,
  ternana:     /^ternana(\s+calcio)?$/i,
  triestina:   /^(us\s+)?triestina(\s+calcio\s+1918)?$/i,
  pescara:     /^(delfino\s+)?pescara(\s+1936)?(\s+calcio)?$/i,
  cremonese:   /^(us\s+|unione\s+sportiva\s+)?cremonese$/i,
  monza:       /^(ac\s+|associazione\s+calcio\s+)?monza$/i,
  lecco:       /^(calcio\s+)?lecco(\s+1912)?$/i,
  como:        /^como(\s+(1907|2000))?$/i,
  lucchese:    /^lucchese(\s+1905)?$/i,
};

// Periodi storici in cui ciascuna squadra ha militato in Serie A.
// Range [startYear, endYear] inclusivi (anno = inizio stagione).
const SERIE_A_HISTORY = {
  milan:       [[1929, 2026]],
  inter:       [[1929, 2026]],
  juventus:    [[1929, 2006], [2007, 2026]],
  roma:        [[1952, 2026]],
  lazio:       [[1988, 2026]],
  fiorentina:  [[1931, 1993], [1994, 2002], [2004, 2026]],
  napoli:      [[1929, 1998], [2000, 2001], [2007, 2026]],
  torino:      [[1929, 1959], [1960, 1989], [1990, 1996], [1999, 2000], [2001, 2003], [2005, 2009], [2012, 2026]],
  sampdoria:   [[1982, 2011], [2012, 2023]],
  genoa:       [[1929, 1934], [1937, 1965], [1973, 1995], [2007, 2022], [2023, 2026]],
  atalanta:    [[1937, 1939], [1940, 1958], [1959, 1981], [1984, 1987], [1988, 1994], [1995, 1998], [2000, 2003], [2006, 2010], [2011, 2026]],
  bologna:     [[1929, 2005], [2008, 2014], [2015, 2026]],
  parma:       [[1990, 2008], [2009, 2015], [2018, 2024]],
  udinese:     [[1995, 2026]],
  cagliari:    [[1964, 2000], [2001, 2014], [2016, 2022], [2023, 2026]],
  palermo:     [[2004, 2013], [2014, 2017]],
  reggina:     [[1995, 1997], [1999, 2009]],
  chievo:      [[2001, 2007], [2008, 2019]],
  lecce:       [[1985, 1996], [1997, 2007], [2008, 2011], [2019, 2026]],
  brescia:     [[1994, 1995], [1997, 1998], [1999, 2001], [2003, 2005], [2010, 2011], [2013, 2014], [2019, 2020]],
  bari:        [[1985, 1997], [2001, 2011]],
  verona:      [[1985, 1990], [1992, 2002], [2013, 2018], [2019, 2026]],
  hellas:      [[1985, 1990], [1992, 2002], [2013, 2018], [2019, 2026]],
  vicenza:     [[1990, 1996], [2000, 2001]],
  piacenza:    [[1993, 1996], [1997, 2003]],
  perugia:     [[1996, 2004]],
  empoli:      [[1986, 1989], [1997, 2002], [2005, 2008], [2014, 2017], [2018, 2019], [2021, 2026]],
  siena:       [[2003, 2010], [2011, 2013]],
  livorno:     [[2004, 2008], [2009, 2010], [2013, 2014]],
  catania:     [[2006, 2014]],
  cesena:      [[1991, 1994], [2010, 2012], [2014, 2015]],
  crotone:     [[2016, 2018], [2020, 2021]],
  benevento:   [[2017, 2018], [2020, 2021]],
  sassuolo:    [[2013, 2023]],
  frosinone:   [[2015, 2016], [2018, 2019], [2023, 2024]],
  spal:        [[2017, 2020]],
  spezia:      [[2020, 2023]],
  venezia:     [[1998, 2002], [2021, 2022], [2024, 2025]],
  salernitana: [[1998, 1999], [2021, 2024]],
  reggiana:    [[1993, 1995], [1996, 1997]],
  ancona:      [[1992, 1993], [2003, 2004]],
  ascoli:      [[1990, 1991]],
  avellino:    [],
  foggia:      [[1991, 1995]],
  messina:     [[2004, 2007]],
  modena:      [[2002, 2004]],
  novara:      [[2011, 2012]],
  pisa:        [[1990, 1991], [2025, 2026]],
  ternana:     [],
  triestina:   [],
  pescara:     [[1990, 1992], [2012, 2013], [2016, 2017]],
  cremonese:   [[1989, 1992], [1993, 1995], [2022, 2023], [2025, 2026]],
  monza:       [[2022, 2025]],
  lecco:       [[2023, 2024]],
  como:        [[2024, 2026]],
  lucchese:    [],
};

let _playerDB = null;
async function getPlayerDB(env) {
  if (_playerDB) return _playerDB;
  const res = await env.ASSETS.fetch("https://cetc.komeobuschito.workers.dev/serie_a_players.json");
  if (!res.ok) throw new Error("Cannot load player database");
  _playerDB = await res.json();
  return _playerDB;
}

const NATIONAL_RE = /national|nazionale|under-|unter-|olimp|youth|u\d{2}/i;

function parseYear(s) {
  const n = parseInt((s || '').split('-')[0]);
  return isNaN(n) || n < 1900 ? null : n;
}

function parseYearEnd(s) {
  const parts = (s || '').split('-');
  const n = parseInt(parts[1] || parts[0]);
  return isNaN(n) || n < 1900 ? null : n;
}

function clubCareer(rawCarriera) {
  return (rawCarriera || []).filter(c =>
    !NATIONAL_RE.test(c.squadra || "") &&
    c.anni && c.anni !== '?' &&
    parseYear(c.anni) !== null
  );
}

// Verifica se uno stint a una squadra ricade in un periodo Serie A reale di quella squadra
function isStintInSerieA(squadra, anniStr) {
  if (!squadra || !anniStr) return false;
  const sq = squadra.trim();
  const sy = parseYear(anniStr);
  const ey = parseYearEnd(anniStr) ?? sy;
  if (!sy) return false;
  for (const [key, pat] of Object.entries(TEAM_PATTERNS)) {
    if (!pat.test(sq)) continue;
    const ranges = SERIE_A_HISTORY[key] || [];
    if (ranges.some(([s, e]) => s <= ey && e >= sy)) return true;
  }
  return false;
}

function detectLoans(carriera) {
  // Aggrega range e apps per club (mergia entry dello stesso club)
  const clubs = {};
  for (const c of carriera) {
    const cs = parseYear(c.anni);
    const ce = parseYearEnd(c.anni) ?? cs;
    if (!cs) continue;
    const k = c.squadra;
    if (!clubs[k]) {
      clubs[k] = { start: cs, end: ce, totalApps: 0 };
    } else {
      clubs[k].start = Math.min(clubs[k].start, cs);
      clubs[k].end   = Math.max(clubs[k].end, ce);
    }
    clubs[k].totalApps += (c.presenze || 0);
  }
  // Uno stint con apps>0 è prestito se esiste un altro club il cui range
  // mergiato lo CONTIENE STRETTAMENTE (almeno un confine strettamente esterno)
  return carriera.map(c => {
    const cs = parseYear(c.anni);
    const ce = parseYearEnd(c.anni) ?? cs;
    if (!cs || !c.presenze) return c;
    const isLoan = Object.entries(clubs).some(([sq, info]) => {
      if (sq === c.squadra) return false;
      if (!(info.start <= cs && info.end >= ce)) return false;
      // Almeno un confine deve essere strettamente esterno
      return info.start < cs || info.end > ce;
    });
    return isLoan ? { ...c, prestito: true } : c;
  });
}

function isValidPlayer(p) {
  if (!p.nome || !p.nome.includes(" ")) return false;
  const carriera = clubCareer(p.carriera);
  if (carriera.length < 3) return false;
  const years = carriera.map(c => parseYear(c.anni)).filter(Boolean);
  if (years.length < carriera.length) return false;
  if (Math.min(...years) < 1990) return false;
  // Almeno uno stint in Serie A reale (anni dentro periodo Serie A della squadra)
  const serieAStints = carriera.filter(c => isStintInSerieA(c.squadra, c.anni));
  if (serieAStints.length === 0) return false;
  // Almeno 50 presenze in un singolo stint di Serie A reale
  const maxAtSerieAClub = Math.max(...serieAStints.map(c => c.presenze || 0), 0);
  if (maxAtSerieAClub < 50) return false;
  return true;
}

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
  for (let i = valid.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [valid[i], valid[j]] = [valid[j], valid[i]];
  }
  return valid.slice(0, 150).map(p => p.nome);
}

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
    const db = await getPlayerDB(env);
    const player = db.find(p => p.nome === playerName);
    if (!player || !isValidPlayer(player)) continue;
    const carriera = detectLoans(clubCareer(player.carriera));
    if (carriera.length < 3) continue;
    return new Response(JSON.stringify({
      nome: player.nome,
      ruolo: player.ruolo || "",
      nazionalita: player.nazionalita || "",
      nomi_alternativi: player.nomi_alternativi || [],
      carriera,
    }), { status: 200, headers: CORS });
  }
  return new Response(JSON.stringify({ error: "No valid player found after retries" }), { status: 500, headers: CORS });
}

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/api/test") {
      return new Response(JSON.stringify({
        su: !!env.SUPABASE_URL,
        sk: !!env.SUPABASE_KEY,
        assets: !!env.ASSETS,
        cache_id: CACHE_ID,
        version: "v10-serie-a-years",
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
