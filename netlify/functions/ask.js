exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  let diff;
  try { diff = JSON.parse(event.body).diff; }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const desc = {
    Facile: "una stella assoluta della Serie A (campioni, bomber iconici, Palloni d'Oro che hanno giocato in Italia dal 1990)",
    Intermedio: "un calciatore con 2-3 stagioni solide in Serie A, noto agli appassionati ma non una superstar",
    Difficile: "un calciatore con pochissime presenze in Serie A (5-20), in squadre piccole o retrocesse, carriera prevalentemente in B/C",
  };

  const MAX_ATTEMPTS = 4;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // STEP 1 — Pesca un nome reale da Wikipedia
      const playerName = await getRandomSerieAPlayer(diff);

      // STEP 2 — Wikipedia
      const { title, content } = await getWikipediaContent(playerName);

      // STEP 3 — Claude estrae i dati
      const json = await askClaude(
        `Basandoti su questo contenuto Wikipedia per "${title}", estrai i dati del calciatore.
REGOLE IMPORTANTI:
- Elenca OGNI trasferimento e prestito separatamente — NON raggruppare più periodi nella stessa squadra
- Includi SOLO stagioni in cui ha giocato almeno 1 partita (presenze > 0), oppure metti 0 se il dato non è disponibile
- Includi SOLO la carriera da calciatore (non da allenatore)
- Il calciatore DEVE aver giocato almeno 20 presenze totali in Serie A — se non è un calciatore o ha meno di 20 presenze in Serie A, rispondi con: {"error":"not_a_footballer"}

RISPONDI SOLO CON JSON VALIDO, niente altro:
{"nome":"...","nomi_alternativi":["cognome"],"ruolo":"ruolo in italiano","nazionalita":"nazionalità in italiano","episodio":"Una frase su un fatto noto in Italia.","carriera":[{"anni":"XXXX-XXXX","squadra":"...","presenze":0,"gol":0}]}

Contenuto Wikipedia:
${content}`,
        800
      );

      const clean = json.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed.error) throw new Error(parsed.error); // not a footballer or <20 Serie A apps → retry
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: clean };

    } catch (e) {
      // se è l'ultimo tentativo, restituisci errore
      if (attempt === MAX_ATTEMPTS - 1) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message, key_set: !!process.env.ANTHROPIC_API_KEY }) };
      }
      // altrimenti riprova con un altro calciatore
      continue;
    }
  }
}; return { statusCode: 405, body: "Method not allowed" };

  let diff;
  try { diff = JSON.parse(event.body).diff; }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) }; }
  const desc = {
    Facile:     "una stella assoluta della Serie A (campioni, bomber iconici, Palloni d'Oro che hanno giocato in Italia dal 1990)",
    Intermedio: "un calciatore con 2-3 stagioni solide in Serie A, noto agli appassionati ma non una superstar",
    Difficile:  "un calciatore con pochissime presenze in Serie A (5-20), in squadre piccole o retrocesse, carriera prevalentemente in B/C",
  };

  const prompt = `Calciatore di Serie A (dal 1990), livello ${diff}: ${desc[diff]}.
SOLO JSON:
{"nome":"...","nomi_alternativi":["cognome"],"ruolo":"...","nazionalita":"...","episodio":"Una frase su fatto noto in Italia.","carriera":[{"anni":"XXXX-XXXX","squadra":"...","presenze":0,"gol":0}]}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    if (data.error) return { statusCode: 500, body: JSON.stringify({ error: data.error.message }) };

    const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
    const clean = text.replace(/```json|```/g, "").trim();
    JSON.parse(clean); // validate before returning
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: clean };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message, stack: e.stack, key_set: !!process.env.ANTHROPIC_API_KEY }) };
  }
};
