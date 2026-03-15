/**
 * GET /api/token
 * Issues a short-lived HMAC WebSocket token and the WSS URL.
 * Railway backend URL is never sent directly as an HTTP endpoint.
 * The Railway WSS URL is returned here — it's safe because:
 *   - The WS endpoint itself validates the HMAC token
 *   - The token is time-limited to a 5-minute window
 */
import crypto from "crypto";

const TOKEN_TTL_SECONDS = 300;

function generateHmacToken(secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = `${ts}.`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `${ts}.${sig}`;
}

export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.WS_AUTH_SECRET;
  const railwayUrl = process.env.RAILWAY_BACKEND_URL;

  if (!secret || !railwayUrl) {
    console.error("[/api/token] Missing env vars");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  const token = generateHmacToken(secret);
  const wssUrl = railwayUrl.replace(/^https?:\/\//, "wss://") + "/ws/live";
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    token,
    wss_url: wssUrl,
    expires_in: TOKEN_TTL_SECONDS,
  });
}
