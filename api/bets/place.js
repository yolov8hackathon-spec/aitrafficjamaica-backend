/**
 * /api/bets/place
 * Single function endpoint for:
 * - POST market bet (/bets/place)
 * - POST live bet   (/bets/place-live)
 * - GET history     (/bets/history)
 * - GET my-round    (/bets/my-round)
 */
export default async function handler(req, res) {
  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) {
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  const mode = String(req.query?.mode || "").trim().toLowerCase();

  try {
    let upstream;
    if (req.method === "GET") {
      if (mode === "history") {
        const limit = Number(req.query?.limit || 100);
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 100;
        const roundId = String(req.query?.round_id || "").trim();
        const qs = new URLSearchParams({ limit: String(safeLimit) });
        if (roundId) qs.set("round_id", roundId);
        upstream = await fetch(`${railwayUrl}/bets/history?${qs.toString()}`, {
          method: "GET",
          headers: { Authorization: authHeader },
        });
      } else if (mode === "my-round") {
        const roundId = String(req.query?.round_id || "").trim();
        if (!roundId) {
          return res.status(400).json({ error: "Missing round_id" });
        }
        const limit = Number(req.query?.limit || 20);
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 20;
        const qs = new URLSearchParams({ round_id: roundId, limit: String(safeLimit) });
        upstream = await fetch(`${railwayUrl}/bets/my-round?${qs.toString()}`, {
          method: "GET",
          headers: { Authorization: authHeader },
        });
      } else {
        return res.status(405).json({ error: "Method not allowed" });
      }
    } else if (req.method === "POST") {
      let body;
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const isLive = String(req.query?.live || "") === "1";
      const upstreamPath = isLive ? "/bets/place-live" : "/bets/place";
      upstream = await fetch(`${railwayUrl}${upstreamPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
      });
    } else {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const raw = await upstream.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : (req.method === "GET" ? [] : {});
    } catch {
      data = { detail: raw || "Upstream returned a non-JSON response" };
    }
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[/api/bets/place] Upstream error:", err);
    return res.status(502).json({ error: "Upstream request failed" });
  }
}
