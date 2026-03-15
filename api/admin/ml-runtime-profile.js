/**
 * /api/admin/ml-runtime-profile
 * Proxy runtime profile controls to Railway backend.
 */
export default async function handler(req, res) {
  if (!["GET", "PATCH"].includes(req.method)) {
    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const railwayUrl = process.env.RAILWAY_BACKEND_URL;
    if (!railwayUrl) return res.status(500).json({ error: "RAILWAY_BACKEND_URL is not set" });

    const auth = req.headers.authorization || "";
    const scope = String(req.query?.scope || "").toLowerCase();
    const cameraId = req.query?.camera_id ? String(req.query.camera_id) : "";
    const qs = cameraId ? `?camera_id=${encodeURIComponent(cameraId)}` : "";
    const upstreamPath = scope === "night" ? "/admin/ml/night-profile" : `/admin/ml/runtime-profile${qs}`;

    const upstream = await fetch(`${railwayUrl}${upstreamPath}`, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: req.method === "PATCH" ? JSON.stringify(req.body || {}) : undefined,
    });

    const payload = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json(payload);
  } catch (err) {
    console.error("[/api/admin/ml-runtime-profile] Upstream error:", err);
    return res.status(500).json({ error: "Runtime profile proxy failed", detail: String(err?.message || err) });
  }
}
