/**
 * GET /api/health
 * Proxy backend health to keep Railway URL out of the client.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) {
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  try {
    const upstream = await fetch(`${railwayUrl}/health`, { method: "GET" });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[/api/health] Upstream error:", err);
    return res.status(502).json({ error: "Upstream request failed" });
  }
}
