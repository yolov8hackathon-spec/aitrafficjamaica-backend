/**
 * GET /api/stream
 * Server-side HLS manifest proxy through Railway backend.
 * Uses a short-lived HMAC token and fetches /stream/live.m3u8 from backend.
 */
import crypto from "crypto";

function generateHmacToken(secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = `${ts}.`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `${ts}.${sig}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.WS_AUTH_SECRET;
  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!secret || !railwayUrl) {
    return res.status(500).json({ error: "Stream not configured" });
  }

  const token = generateHmacToken(secret);
  const aliasRaw = String(req.query?.alias || "").trim();
  const alias = /^[A-Za-z0-9_-]+$/.test(aliasRaw) ? aliasRaw : "";
  const backendHttpBase = railwayUrl.replace(/\/+$/, "");
  const manifestUrl =
    `${backendHttpBase}/stream/live.m3u8?token=${encodeURIComponent(token)}`
    + (alias ? `&alias=${encodeURIComponent(alias)}` : "");

  // Fetch backend-generated manifest (backend handles ipcamlive URL + rewrite)
  try {
    const upstream = await fetch(manifestUrl);
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      console.error("[/api/stream] backend status:", upstream.status, body.slice(0, 200));
      return res.status(502).json({ error: "Stream unavailable", upstream_status: upstream.status });
    }
    const text = await upstream.text();
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store");
    return res.status(200).send(text);
  } catch (err) {
    console.error("[/api/stream] backend fetch error:", err);
    return res.status(502).json({ error: "Stream unavailable" });
  }
}
