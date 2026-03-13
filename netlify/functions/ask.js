const ANTHROPIC_HEADERS = () => ({
  "Content-Type": "application/json",
  "x-api-key": process.env.ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
});

async function askClaude(prompt, maxTokens = 150) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: ANTHROPIC_HEADERS(),
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

async function getRandomPlayerFromWikipedia(diff) {
  const categories = {
    Facile:     ["Category:Italy_international_footballers", "Category:Serie_A_top_scorers"],
    Intermedio: ["Category:Serie_A_players", "Category:Serie_A_players"],
    Difficile:  ["Category:Serie_B_players", "Category:Serie_C1_players"],
  };
  const cats = categories[diff] || categories.Intermedio;
  const cat  = cats[Math.floor(Math.random() * cats.length)];
  const offset = Math.floor(Math.random() * 400);

  const res = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(cat)}&cmlimit=50&cmoffset=${offset}&cmtype=page&format=json&origin=*`
  );
  const data = await res.json();
  const members = data.query?.categorymembers || [];
  if (!members.length) throw new Error("Category empty");
  return members[Math.floor(Math.random() * members.length)].title;
}

async function getWikipediaContent(playerName) {
  const searchRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(playerName + " footballer")}&format=json&origin=*&srlimit=1`
  );
  const searchData = await searchRes.json();
  if (!searchData.query?.search?.length) throw new Error("Not found on Wikipedia");
  const title = searchData.query.search[0].title;

  const pageRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json&origin=*`
  );
  const pageData = await pageRes.json();
  const pages = pageData.query.pages;
  const content = Object.values(pages)[0]?.revisions?.[0]?.slots?.main?.["*"] || "";

  const statsMatch = content.match(/\|\s*clubs\s*=([\s\S]*?)(?:\n\|[a-z]|\}\})/i)
    || content.match(/senior career([\s\S]{0,3000})/i);
  return { title, content: statsMatch ? statsMatch[0] : content.substring(0, 4000) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  let diff;
  try { diff = JSON.parse(event.body).diff; }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const MAX_ATTEMPTS = 4;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // STEP 1 — Prendi un nome reale da Wikipedia
      const playerName = await getRandomPlayerFromWikipedia(diff);

      // STEP 2 — Prendi il contenuto Wikipedia del giocatore
      const { title, content } = await getWikipediaContent(playerName);

      // STEP 3 — Claude estrae i dati strutturati
      const json = await askClaude(
        `Basandoti su questo contenuto Wikipedia per "${title}", estrai i dati del calciatore.
REGOLE:
- Elenca OGNI trasferimento e prestito come riga separata — NON raggruppare mai più periodi nella stessa squadra
- Includi tutta la carriera da calciatore (non da allenatore)
- Il calciatore DEVE aver giocato almeno 20 presenze totali in Serie A
- Se non è un calciatore o ha meno di 20 presenze in Serie A, rispondi SOLO con: {"error":"not_valid"}
- Per presenze e gol usa numeri interi (0 se non disponibile nel testo)

RISPONDI SOLO CON JSON VALIDO, niente altro:
{"nome":"...","nomi_alternativi":["cognome"],"ruolo":"ruolo in italiano","nazionalita":"nazionalità in italiano","episodio":"Una frase su un fatto noto in Italia.","carriera":[{"anni":"XXXX-XXXX","squadra":"...","presenze":0,"gol":0}]}

Contenuto Wikipedia:
${content}`,
        800
      );

      const clean = json.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed.error) throw new Error(parsed.error);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) };

    } catch (e) {
      if (attempt === MAX_ATTEMPTS - 1) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message, key_set: !!process.env.ANTHROPIC_API_KEY }) };
      }
      continue;
    }
  }
};
