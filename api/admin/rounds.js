/**
 * /api/admin/rounds
 * Proxy admin round/session operations to Railway backend.
 */
export default async function handler(req, res) {
  const method = req.method || "GET";
  if (!["GET", "POST", "PATCH"].includes(method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) return res.status(500).json({ error: "Server misconfiguration" });

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  try {
    const mode = String(req.query?.mode || "");
    let url = `${railwayUrl}/admin/rounds`;
    let body;

    // Backward compatibility for older frontend query modes.
    if (mode === "sessions") {
      if (method === "GET") {
        const limit = Number(req.query?.limit || 20);
        url = `${railwayUrl}/admin/round-sessions?limit=${encodeURIComponent(limit)}`;
      } else if (method === "POST") {
        url = `${railwayUrl}/admin/round-sessions`;
      }
    } else if (mode === "session-stop" && method === "PATCH") {
      const sessionId = String(req.query?.id || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "Missing session id" });
      }
      url = `${railwayUrl}/admin/round-sessions/${encodeURIComponent(sessionId)}/stop`;
    } else {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query || {})) {
        if (k === "mode" || typeof v === "undefined") continue;
        if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
        else params.set(k, String(v));
      }
      const query = params.toString();
      url = `${railwayUrl}/admin/rounds${query ? `?${query}` : ""}`;
    }

    if (!["GET"].includes(method)) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    }

    const upstream = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    const raw = await upstream.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw || "Upstream returned non-JSON" }; }
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[/api/admin/rounds] Upstream error:", err);
    return res.status(502).json({ error: "Upstream request failed" });
  }
}
