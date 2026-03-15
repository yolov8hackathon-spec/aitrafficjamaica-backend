/**
 * GET /api/admin/ml-capture-status
 * Proxy ML capture/upload status from Railway backend.
 */
export default async function handler(req, res) {
  if (!["GET", "PATCH"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) return res.status(500).json({ error: "Server misconfiguration" });

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  try {
    const limit = Number(req.query?.limit || 30);
    const isPatch = req.method === "PATCH";
    const upstreamUrl = isPatch
      ? `${railwayUrl}/admin/ml/capture-status`
      : `${railwayUrl}/admin/ml/capture-status?limit=${encodeURIComponent(limit)}`;
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        Authorization: authHeader,
        ...(isPatch ? { "Content-Type": "application/json" } : {}),
      },
      ...(isPatch ? { body: JSON.stringify(req.body || {}) } : {}),
    });
    const raw = await upstream.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw || "Upstream returned non-JSON" }; }
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[/api/admin/ml-capture-status] Upstream error:", err);
    return res.status(502).json({ error: "Upstream request failed" });
  }
}
