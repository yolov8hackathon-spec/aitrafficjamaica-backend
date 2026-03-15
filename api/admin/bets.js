/**
 * GET /api/admin/bets
 * Proxy admin recent bets feed from Railway backend.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) return res.status(500).json({ error: "Server misconfiguration" });

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  try {
    const mode = String(req.query?.mode || "").trim().toLowerCase();
    const limit = Number(req.query?.limit || 200);
    const targetUrl = mode === "validation-status"
      ? `${railwayUrl}/admin/bets/validation-status`
      : `${railwayUrl}/admin/bets?limit=${encodeURIComponent(limit)}`;
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers: { Authorization: authHeader },
    });
    const raw = await upstream.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw || "Upstream returned non-JSON" }; }
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[/api/admin/bets] Upstream error:", err);
    return res.status(502).json({ error: "Upstream request failed" });
  }
}
