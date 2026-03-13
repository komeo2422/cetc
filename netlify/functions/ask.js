exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

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
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
