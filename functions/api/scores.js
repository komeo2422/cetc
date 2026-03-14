function sbHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates",
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/leaderboard?select=*&order=avg_score.desc`,
      { headers: sbHeaders(env.SUPABASE_KEY) }
    );
    const data = await res.json();
    return new Response(JSON.stringify(data), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { username, pts } = await request.json();
    const SB_URL = env.SUPABASE_URL;
    const SB_KEY = env.SUPABASE_KEY;

    const r = await fetch(
      `${SB_URL}/rest/v1/leaderboard?username=eq.${encodeURIComponent(username)}`,
      { headers: sbHeaders(SB_KEY) }
    );
    const rows = await r.json();
    const ex = rows[0];
    const ns = (ex?.total_score || 0) + pts;
    const nq = (ex?.total_q || 0) + 1;
    const avg = Math.round(ns / nq * 100) / 100;

    await fetch(`${SB_URL}/rest/v1/leaderboard`, {
      method: "POST",
      headers: sbHeaders(SB_KEY),
      body: JSON.stringify({ username, total_score: ns, total_q: nq, avg_score: avg, updated_at: new Date().toISOString() }),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
