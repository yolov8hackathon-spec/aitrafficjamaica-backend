/**
 * /api/admin/ml-jobs
 * - GET (default): list ML jobs
 * - GET ?action=diagnostics: fetch diagnostics
 * - POST ?action=one-click: run one-click pipeline
 * - POST ?action=train-captures: run training for live-capture dataset
 * - POST (default): trigger retrain
 */
export default async function handler(req, res) {
  const method = req.method || "GET";
  if (!["GET", "POST"].includes(method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) return res.status(500).json({ error: "Server misconfiguration" });

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  try {
    const action = String(req.query?.action || "").trim().toLowerCase();
    let upstream;

    if (method === "GET") {
      if (action === "diagnostics") {
        upstream = await fetch(`${railwayUrl}/admin/ml/diagnostics`, {
          method: "GET",
          headers: { Authorization: authHeader },
        });
      } else {
        const limit = Number(req.query?.limit || 50);
        upstream = await fetch(`${railwayUrl}/admin/ml/jobs?limit=${encodeURIComponent(limit)}`, {
          method: "GET",
          headers: { Authorization: authHeader },
        });
      }
    } else {
      const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
      let targetPath = "/admin/ml/retrain-async";
      if (action === "one-click") targetPath = "/admin/ml/one-click";
      if (action === "train-captures") targetPath = "/admin/ml/train-captures-async";
      upstream = await fetch(`${railwayUrl}${targetPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body,
      });
    }

    const raw = await upstream.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw || "Upstream returned non-JSON" }; }
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[/api/admin/ml-jobs] Upstream error:", err);
    return res.status(502).json({ error: "Upstream request failed" });
  }
}
