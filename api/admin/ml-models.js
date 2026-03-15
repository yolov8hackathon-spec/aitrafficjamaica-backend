/**
 * GET /api/admin/ml-models
 * Proxy model registry list from Railway backend.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) return res.status(500).json({ error: "Server misconfiguration" });

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  try {
    const limit = Number(req.query?.limit || 50);
    const upstream = await fetch(`${railwayUrl}/admin/ml/models?limit=${encodeURIComponent(limit)}`, {
      method: "GET",
      headers: { Authorization: authHeader },
    });
    const raw = await upstream.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw || "Upstream returned non-JSON" }; }
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[/api/admin/ml-models] Upstream error:", err);
    return res.status(502).json({ error: "Upstream request failed" });
  }
}

