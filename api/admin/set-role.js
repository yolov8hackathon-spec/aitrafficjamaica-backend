/**
 * /api/admin/set-role
 * - GET: list users (proxies to /admin/users)
 * - POST: set role (proxies to /admin/set-role)
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
    let upstream;
    if (method === "GET") {
      const mode = String(req.query?.mode || "").trim().toLowerCase();
      if (mode === "active-users") {
        upstream = await fetch(
          `${railwayUrl}/admin/active-users`,
          { method: "GET", headers: { Authorization: authHeader } }
        );
      } else {
        const page = Number(req.query?.page || 1);
        const perPage = Number(req.query?.per_page || 200);
        upstream = await fetch(
          `${railwayUrl}/admin/users?page=${encodeURIComponent(page)}&per_page=${encodeURIComponent(perPage)}`,
          { method: "GET", headers: { Authorization: authHeader } }
        );
      }
    } else {
      const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
      upstream = await fetch(`${railwayUrl}/admin/set-role`, {
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
    console.error("[/api/admin/set-role] Upstream error:", err);
    return res.status(502).json({ error: "Upstream request failed" });
  }
}
