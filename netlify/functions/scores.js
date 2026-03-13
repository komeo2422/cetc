const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

const headers = {
  "apikey": SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };

  // GET → fetch leaderboard
  if (event.httpMethod === "GET") {
    const r = await fetch(`${SB_URL}/rest/v1/leaderboard?select=*&order=avg_score.desc`, { headers });
    const data = await r.json();
    return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(data) };
  }

  // POST → upsert score
  if (event.httpMethod === "POST") {
    const { username, pts } = JSON.parse(event.body);

    // fetch existing row
    const r = await fetch(`${SB_URL}/rest/v1/leaderboard?username=eq.${encodeURIComponent(username)}`, { headers });
    const rows = await r.json();
    const ex = rows[0];
    const ns = (ex?.total_score || 0) + pts;
    const nq = (ex?.total_q || 0) + 1;
    const avg = Math.round(ns / nq * 100) / 100;

    await fetch(`${SB_URL}/rest/v1/leaderboard`, {
      method: "POST",
      headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ username, total_score: ns, total_q: nq, avg_score: avg, updated_at: new Date().toISOString() }),
    });

    return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: cors, body: "Method not allowed" };
};
