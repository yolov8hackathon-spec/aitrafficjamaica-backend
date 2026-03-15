(function () {
  const GUEST_KEY = "whitelinez.site.guest_id";
  const SESSION_KEY = "whitelinez.site.session_id";
  const LAST_SENT_PREFIX = "whitelinez.site.last_sent.";
  const SEND_COOLDOWN_MS = 5 * 60 * 1000;

  function getOrCreateId(storageKey, prefix) {
    try {
      let value = String(localStorage.getItem(storageKey) || "").trim();
      if (!value) {
        value = `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(storageKey, value);
      }
      return value;
    } catch {
      return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  function shouldSend(path) {
    const key = `${LAST_SENT_PREFIX}${path}`;
    const now = Date.now();
    try {
      const last = Number(localStorage.getItem(key) || 0);
      if (Number.isFinite(last) && now - last < SEND_COOLDOWN_MS) return false;
      localStorage.setItem(key, String(now));
      return true;
    } catch {
      return true;
    }
  }

  async function logSiteView() {
    if (!window.sb) return;
    const path = `${window.location.pathname || "/"}${window.location.search || ""}`;
    if (!shouldSend(path)) return;

    const guestId = getOrCreateId(GUEST_KEY, "guest");
    const sessionId = getOrCreateId(SESSION_KEY, "sess");
    let userId = null;

    try {
      const sessionResp = await window.sb.auth.getSession();
      userId = sessionResp?.data?.session?.user?.id || null;
    } catch {}

    try {
      await window.sb.from("site_views").insert({
        user_id: userId,
        guest_id: userId ? null : guestId,
        page_path: path.slice(0, 200),
        referrer: (document.referrer || "").slice(0, 500),
        user_agent: (navigator.userAgent || "").slice(0, 500),
        session_id: sessionId,
        source: "web",
      });
    } catch {
      // telemetry failure should never block UX
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { logSiteView(); });
  } else {
    logSiteView();
  }
})();
