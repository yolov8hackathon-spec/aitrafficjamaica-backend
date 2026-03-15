const GUEST_TS_KEY = "wlz.guest.session_ts";

(async () => {
  const PUBLIC_DAY_PRESET = {
    brightness: 102,
    contrast: 106,
    saturate: 104,
    hue: 0,
    blur: 0,
  };
  const PUBLIC_NIGHT_PRESET = {
    brightness: 132,
    contrast: 136,
    saturate: 122,
    hue: 0,
    blur: 0.2,
  };
  const PUBLIC_DETECTION_SETTINGS_KEY = "whitelinez.detection.overlay_settings.v4";
  async function resolveActiveCamera() {
    const { data, error } = await window.sb
      .from("cameras")
      .select("id, ipcam_alias, created_at, feed_appearance")
      .eq("is_active", true);
    if (error) throw error;
    const cams = Array.isArray(data) ? data : [];
    if (!cams.length) return null;
    const rank = (cam) => {
      const alias = String(cam?.ipcam_alias || "").trim();
      if (!alias) return 0;
      if (alias.toLowerCase() === "your-alias") return 1;
      return 2;
    };
    cams.sort((a, b) => {
      const ar = rank(a);
      const br = rank(b);
      if (ar !== br) return br - ar;
      const at = Date.parse(a?.created_at || 0) || 0;
      const bt = Date.parse(b?.created_at || 0) || 0;
      if (at !== bt) return bt - at;
      return String(b?.id || "").localeCompare(String(a?.id || ""));
    });
    return cams[0] || null;
  }

  function isNightWindowNow() {
    const h = new Date().getHours();
    return h >= 18 || h < 6;
  }
  function buildVideoFilter(a) {
    const brightness = Math.max(50, Math.min(180, Number(a?.brightness) || 100));
    const contrast = Math.max(50, Math.min(200, Number(a?.contrast) || 100));
    const saturate = Math.max(0, Math.min(220, Number(a?.saturate) || 100));
    const hue = Math.max(0, Math.min(360, Number(a?.hue) || 0));
    const blur = Math.max(0, Math.min(4, Number(a?.blur) || 0));
    return `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%) hue-rotate(${hue}deg) blur(${blur.toFixed(1)}px)`;
  }
  async function applyPublicFeedAppearance(videoEl) {
    if (!videoEl || !window.sb) return;
    try {
      const cam = await resolveActiveCamera();
      const cfg = cam?.feed_appearance && typeof cam.feed_appearance === "object"
        ? cam.feed_appearance
        : null;
      if (!cfg || cfg.push_public === false) {
        videoEl.style.filter = "";
        return;
      }
      if (cfg.detection_overlay && typeof cfg.detection_overlay === "object") {
        const publicOverlayCfg = {
          ...cfg.detection_overlay,
          outside_scan_show_labels: true,
        };
        try {
          localStorage.setItem(PUBLIC_DETECTION_SETTINGS_KEY, JSON.stringify(publicOverlayCfg));
        } catch {}
        window.dispatchEvent(new CustomEvent("detection:settings-update", { detail: publicOverlayCfg }));
      }
      const appearance = cfg.auto_day_night
        ? (isNightWindowNow() ? PUBLIC_NIGHT_PRESET : PUBLIC_DAY_PRESET)
        : (cfg.appearance || {});
      videoEl.style.filter = buildVideoFilter(appearance);
    } catch {
      // Keep public view resilient if appearance config fetch fails.
    }
  }

  // ── Guest session 48h expiry scrub ────────────────────────────────────────
  {
    const earlySession = await Auth.getSession();
    if (earlySession?.user?.is_anonymous) {
      const ts = Number(localStorage.getItem(GUEST_TS_KEY) || 0);
      if (ts > 0 && Date.now() - ts > 48 * 60 * 60 * 1000) {
        localStorage.removeItem(GUEST_TS_KEY);
        try { await window.sb.auth.signOut(); } catch {}
        window.location.reload();
        return;
      }
    }
  }

  const session = await Auth.getSession();
  const currentUserId = session?.user?.id || "";

  async function refreshNavBalance() {
    if (!currentUserId) return;
    try {
      const { data } = await window.sb
        .from("user_balances")
        .select("balance")
        .eq("user_id", currentUserId)
        .maybeSingle();
      const balEl = document.getElementById("nav-balance");
      if (balEl && data?.balance != null) {
        balEl.textContent = "$ " + Number(data.balance).toLocaleString();
        balEl.classList.remove("hidden");
      }
    } catch {
      // WS updates still handle most cases; keep silent on poll failures.
    }
  }

  function defaultAvatar(seed) {
    const src = String(seed || "whitelinez-user");
    let hash = 0;
    for (let i = 0; i < src.length; i += 1) hash = ((hash << 5) - hash + src.charCodeAt(i)) | 0;
    const h = Math.abs(hash) % 360;
    const h2 = (h + 32) % 360;
    // Skin tone palette (light → dark)
    const skins = [
      "hsl(28,72%,72%)", "hsl(26,62%,64%)", "hsl(24,56%,56%)",
      "hsl(21,50%,46%)", "hsl(18,44%,36%)",
    ];
    // Hair color palette
    const hairs = ["#17100a", "#3b2008", "#6b3510", "#c48a10", "#7a1515"];
    const skin  = skins[Math.abs(hash >> 4) % skins.length];
    const hair  = hairs[Math.abs(hash >> 8) % hairs.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'>
      <defs>
        <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0%' stop-color='hsl(${h},60%,28%)'/>
          <stop offset='100%' stop-color='hsl(${h2},68%,16%)'/>
        </linearGradient>
        <clipPath id='c'><circle cx='48' cy='48' r='48'/></clipPath>
      </defs>
      <circle cx='48' cy='48' r='48' fill='url(#g)'/>
      <ellipse cx='48' cy='92' rx='40' ry='26' fill='rgba(0,0,0,0.30)' clip-path='url(#c)'/>
      <rect x='43' y='63' width='10' height='15' rx='5' fill='${skin}' clip-path='url(#c)'/>
      <circle cx='48' cy='44' r='23' fill='${skin}'/>
      <path d='M25 44 Q26 18 48 16 Q70 18 71 44 Q66 28 48 27 Q30 28 25 44Z' fill='${hair}' clip-path='url(#c)'/>
      <ellipse cx='40' cy='43' rx='4.8' ry='5.2' fill='rgba(12,8,4,0.88)'/>
      <ellipse cx='56' cy='43' rx='4.8' ry='5.2' fill='rgba(12,8,4,0.88)'/>
      <ellipse cx='41.6' cy='41.2' rx='2' ry='2.2' fill='rgba(255,255,255,0.62)'/>
      <ellipse cx='57.6' cy='41.2' rx='2' ry='2.2' fill='rgba(255,255,255,0.62)'/>
      <path d='M40 52 Q48 59 56 52' stroke='rgba(8,4,2,0.28)' stroke-width='2.8' fill='none' stroke-linecap='round'/>
      <circle cx='48' cy='48' r='46' fill='none' stroke='rgba(255,255,255,0.10)' stroke-width='1.5'/>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  function isAllowedAvatarUrl(url) {
    if (!url || typeof url !== "string") return false;
    const u = url.trim();
    if (!u) return false;
    if (u.startsWith("data:image/")) return true;
    if (u.startsWith("blob:")) return true;
    if (u.startsWith("/")) return true;
    try {
      const parsed = new URL(u, window.location.origin);
      if (parsed.origin === window.location.origin) return true;
      if (parsed.hostname.endsWith(".supabase.co")) return true;
      return false;
    } catch {
      return false;
    }
  }

  function _applyNavSession(s) {
    if (!s) return;
    document.getElementById("nav-auth")?.classList.add("hidden");
    document.getElementById("nav-user")?.classList.remove("hidden");
    const user = s.user || {};
    const isAnon = Auth.isAnonymous(s);
    const avatarRaw = user.user_metadata?.avatar_url || "";
    const avatar = isAllowedAvatarUrl(avatarRaw)
      ? avatarRaw
      : defaultAvatar(user.id || user.email || "user");
    const navAvatar = document.getElementById("nav-avatar");
    if (navAvatar) {
      navAvatar.onerror = () => { navAvatar.src = defaultAvatar(user.id || "user"); };
      navAvatar.src = avatar;
    }
    if (isAnon) {
      // Show a guest badge next to balance
      const balEl = document.getElementById("nav-balance");
      if (balEl && !document.getElementById("nav-guest-badge")) {
        const badge = document.createElement("span");
        badge.id = "nav-guest-badge";
        badge.className = "nav-guest-badge";
        badge.textContent = "Guest";
        balEl.insertAdjacentElement("afterend", badge);
      }
    }
    if (user.app_metadata?.role === "admin") {
      document.getElementById("nav-admin-link")?.classList.remove("hidden");
    }
  }

  // Nav auth state
  _applyNavSession(session);

  // When a guest session is created mid-session, update nav + balance
  window.addEventListener("session:guest", async () => {
    const newSession = await Auth.getSession();
    _applyNavSession(newSession);
    refreshNavBalance();
  });

  // Play overlay
  document.getElementById("btn-play")?.addEventListener("click", () => {
    document.getElementById("live-video")?.play();
    document.getElementById("play-overlay")?.classList.add("hidden");
  });

  // Logout
  document.getElementById("btn-logout")?.addEventListener("click", () => Auth.logout());

  // Load all active cameras for failover
  let _streamCameras = [];
  let _streamCamIdx = 0;
  let _failoverPending = false;
  try {
    const { data: camData } = await window.sb
      .from("cameras")
      .select("id, ipcam_alias, created_at")
      .eq("is_active", true);
    if (Array.isArray(camData)) {
      _streamCameras = camData
        .filter(c => {
          const a = String(c.ipcam_alias || "").trim();
          return a && a.toLowerCase() !== "your-alias";
        })
        .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
    }
  } catch { /* silent — stream works without failover list */ }

  // Stream offline overlay + camera failover
  window.addEventListener("stream:status", (e) => {
    const overlay = document.getElementById("stream-offline-overlay");
    const infoEl = overlay?.querySelector(".stream-offline-info");

    if (e.detail?.status === "down") {
      overlay?.classList.remove("hidden");

      // Try next camera if multiple are configured
      if (!_failoverPending && _streamCameras.length > 1) {
        _failoverPending = true;
        _streamCamIdx = (_streamCamIdx + 1) % _streamCameras.length;
        const next = _streamCameras[_streamCamIdx];
        if (infoEl) infoEl.textContent = "Trying backup stream...";
        setTimeout(() => {
          Stream.setAlias(next?.ipcam_alias || "");
          _failoverPending = false;
        }, 2500);
      } else if (infoEl) {
        infoEl.textContent = "Reconnecting to live feed...";
      }
    } else if (e.detail?.status === "ok") {
      overlay?.classList.add("hidden");
      _failoverPending = false;
    }
  });

  // Stream
  const video = document.getElementById("live-video");
  await Stream.init(video);
  await applyPublicFeedAppearance(video);
  setInterval(() => applyPublicFeedAppearance(video), 15000);
  FpsOverlay.init(video, document.getElementById("fps-overlay"));

  // Canvas overlays
  const zoneCanvas = document.getElementById("zone-canvas");
  ZoneOverlay.init(video, zoneCanvas);

  const detectionCanvas = document.getElementById("detection-canvas");
  DetectionOverlay.init(video, detectionCanvas);

  // Floating count widget
  const streamWrapper = document.querySelector(".stream-wrapper");
  FloatingCount.init(streamWrapper);

  // Count widget — mobile tap toggle (desktop uses CSS :hover)
  const countWidget = document.getElementById("count-widget");
  if (countWidget) {
    let _cwTouchMoved = false;
    countWidget.addEventListener("touchstart", () => { _cwTouchMoved = false; }, { passive: true });
    countWidget.addEventListener("touchmove",  () => { _cwTouchMoved = true;  }, { passive: true });
    countWidget.addEventListener("touchend", (e) => {
      if (_cwTouchMoved) return; // ignore scroll swipes
      e.stopPropagation();
      countWidget.classList.toggle("cw-active");
    }, { passive: true });
    document.addEventListener("touchstart", (e) => {
      if (!countWidget.contains(e.target)) countWidget.classList.remove("cw-active");
    }, { passive: true });
  }
  MlOverlay.init();

  // WS counter — hooks into floating widget
  Counter.init();

  // Patch Counter to update FloatingCount status dot
  window.addEventListener("count:update", () => FloatingCount.setStatus(true));

  // Markets + Live Bet panel
  LiveBet.init();
  Markets.init();

  // Chat
  Chat.init(session);
  StreamChatOverlay.init();

  // Activity — broadcasts to chat; leaderboard loads lazily on tab open
  Activity.init();
  let _lbWindow = 60;

  document.querySelector('.tab-btn[data-tab="leaderboard"]')?.addEventListener("click", () => {
    Activity.loadLeaderboard(_lbWindow);
  });
  document.getElementById("lb-refresh")?.addEventListener("click", () => {
    Activity.loadLeaderboard(_lbWindow);
  });

  // Window tab switching on leaderboard
  document.getElementById("tab-leaderboard")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".lb-wtab");
    if (!btn) return;
    _lbWindow = parseInt(btn.dataset.win, 10);
    document.querySelectorAll(".lb-wtab").forEach(b => b.classList.toggle("active", b === btn));
    Activity.loadLeaderboard(_lbWindow);
  });

  // ── Global heartbeat ─────────────────────────────────────────────────────
  // Supabase realtime: auto-refresh markets + banners when rounds/sessions/banners change.
  if (window.sb) {
    window.sb.channel("site-heartbeat")
      .on("postgres_changes", { event: "*", schema: "public", table: "bet_rounds" }, () => {
        Markets.loadMarkets();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "round_sessions" }, () => {
        Markets.loadMarkets();
        // Re-poll session state in banners (triggers play/default tile swap)
        if (window.Banners) window.Banners.show();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "banners" }, () => {
        if (window.Banners) window.Banners.show();
      })
      .subscribe();
  }

  MlShowcase.init();
  CameraSwitcher.init();

  // ws_account — per-user events (balance, bet resolution)
  if (session) {
    refreshNavBalance();
    setInterval(refreshNavBalance, 20000);
    _connectUserWs(session);
  }

  // Nav balance display from ws_account
  window.addEventListener("balance:update", (e) => {
    const balEl = document.getElementById("nav-balance");
    if (balEl) {
      balEl.textContent = "$ " + (e.detail ?? 0).toLocaleString();
      balEl.classList.remove("hidden");
    }
  });

  // Reload markets on bet placed
  window.addEventListener("bet:placed", () => Markets.loadMarkets());
  window.addEventListener("bet:placed", refreshNavBalance);

  // Handle bet resolution from ws_account
  window.addEventListener("bet:resolved", (e) => {
    LiveBet.onBetResolved(e.detail);
    refreshNavBalance();
  });
})();


// ── Bot info in VISION HUD — training day + knowledge % ──────────────────────
(function initBotHud() {
  const TRAIN_START  = new Date('2026-02-23T00:00:00');
  const BASE_KNOW    = 71.8;   // % on day 0
  const KNOW_PER_DAY = 0.35;   // % gained per day
  const KNOW_MAX     = 98.5;

  function update() {
    const days = Math.floor((Date.now() - TRAIN_START) / 86400000);
    const know = Math.min(KNOW_MAX, BASE_KNOW + days * KNOW_PER_DAY).toFixed(1);
    const el = document.getElementById('ml-hud-bot');
    if (el) el.innerHTML = `<span>TRAIN · DAY ${days}</span><span>KNOW · ${know}%</span>`;
  }

  update();
  // Schedule a re-tick at the next midnight, then daily after that
  const now = new Date();
  const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
  setTimeout(() => { update(); setInterval(update, 86400000); }, msToMidnight);
})();


// ── Logo AI frame — random pulse ──────────────────────────────────────────────
(function initLogoPulse() {
  const frame = document.querySelector('.logo-ai-frame');
  const logo  = document.querySelector('.logo');
  if (!frame || !logo) return;

  function schedule() {
    const delay = 4000 + Math.random() * 10000; // 4–14 s between pulses
    setTimeout(() => {
      if (logo.matches(':hover') || frame.classList.contains('logo-ai-pulsing')) {
        schedule(); // hovering or already animating — skip, try again soon
        return;
      }
      frame.classList.add('logo-ai-pulsing');
      frame.addEventListener('animationend', () => {
        frame.classList.remove('logo-ai-pulsing');
        schedule();
      }, { once: true });
    }, delay);
  }

  schedule();
})();


// ── User WebSocket (/ws/account) ──────────────────────────────────────────────
function _connectUserWs(session) {
  let ws = null;
  let backoff = 2000;
  let attempts = 0;
  let waitForToken = null;
  let reconnectTimer = null;

  async function connect() {
    const jwt = await Auth.getJwt();
    if (!jwt) return;
    const wssUrl = window._wssUrl;
    if (!wssUrl) {
      // Derive from public WS URL by replacing /ws/live → /ws/account
      // Try again once ws token is available
      setTimeout(connect, 3000);
      return;
    }
    const accountUrl = wssUrl.replace("/ws/live", "/ws/account");
    ws = new WebSocket(`${accountUrl}?token=${encodeURIComponent(jwt)}`);
    attempts += 1;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      backoff = 2000;
      attempts = 0;
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "balance") {
          window.dispatchEvent(new CustomEvent("balance:update", { detail: data.balance }));
        } else if (data.type === "bet_resolved") {
          if (data.user_id && String(data.user_id) !== String(session?.user?.id || "")) return;
          window.dispatchEvent(new CustomEvent("bet:resolved", { detail: data }));
        }
      } catch {}
    };

    ws.onclose = (evt) => {
      ws = null;
      const hardRejected = evt?.code === 4001 || evt?.code === 4003;
      if (hardRejected) {
        // Auth/origin failures won't self-heal with rapid retries.
        reconnectTimer = setTimeout(connect, 60000);
        return;
      }
      if (!opened && attempts >= 8) {
        // Keep nav balance alive via HTTP polling; stop aggressive WS retry loop.
        return;
      }
      backoff = Math.min(backoff * 2, 30000);
      reconnectTimer = setTimeout(connect, backoff);
    };

    ws.onerror = () => {
      // Browser prints socket errors to console; keep handler silent.
    };
  }

  // Wait for ws token to be available (set by Counter.init/stream.js)
  waitForToken = setInterval(() => {
    if (window._wssUrl) {
      clearInterval(waitForToken);
      connect();
    }
  }, 1000);

  window.addEventListener("beforeunload", () => {
    if (waitForToken) clearInterval(waitForToken);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch {}
  });
}

// ── Login Modal ────────────────────────────────────────────────────────────────
(function _loginModal() {
  const modal    = document.getElementById("login-modal");
  const backdrop = document.getElementById("login-modal-backdrop");
  const closeBtn = document.getElementById("login-modal-close");
  const openBtn  = document.getElementById("btn-open-login");
  const form     = document.getElementById("modal-login-form");
  const errorEl  = document.getElementById("modal-auth-error");
  const submitBtn = document.getElementById("modal-submit-btn");

  if (!modal) return;

  function open() {
    modal.classList.remove("hidden");
    document.getElementById("modal-email")?.focus();
  }

  function close() {
    modal.classList.add("hidden");
    if (errorEl) errorEl.textContent = "";
    if (form) form.reset();
  }

  openBtn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errorEl) errorEl.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    try {
      await Auth.login(
        document.getElementById("modal-email").value,
        document.getElementById("modal-password").value
      );
      // Reload the page with the active session
      window.location.reload();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message || "Login failed";
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign In";
    }
  });

  // Switch to register modal
  document.getElementById("switch-to-register")?.addEventListener("click", (e) => {
    e.preventDefault();
    close();
    document.getElementById("register-modal")?.classList.remove("hidden");
    document.getElementById("modal-reg-email")?.focus();
  });

  // Guest login
  document.getElementById("modal-guest-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("modal-guest-btn");
    const errEl = document.getElementById("modal-auth-error");
    if (errEl) errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Connecting...";
    try {
      await Auth.signInAnon();
      localStorage.setItem(GUEST_TS_KEY, String(Date.now()));
      window.location.reload();
    } catch (err) {
      console.error("[GuestLogin] Full error object:", err);
      const msg = err?.message || "Guest access unavailable.";
      // Surface actionable hint for the most common Supabase config issue
      const display = msg.toLowerCase().includes("disabled")
        ? "Anonymous sign-ins are disabled in Supabase. Enable under Authentication → Providers → Anonymous."
        : msg;
      if (errEl) errEl.textContent = display;
      btn.disabled = false;
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"/></svg> Continue as Guest`;
    }
  });
}());

// ── Register Modal ─────────────────────────────────────────────────────────────
(function _registerModal() {
  const modal    = document.getElementById("register-modal");
  const backdrop = document.getElementById("register-modal-backdrop");
  const closeBtn = document.getElementById("register-modal-close");
  const openBtn  = document.getElementById("btn-open-register");
  const form     = document.getElementById("modal-register-form");
  const errorEl  = document.getElementById("modal-register-error");
  const submitBtn = document.getElementById("register-submit-btn");

  if (!modal) return;

  function open() {
    modal.classList.remove("hidden");
    document.getElementById("modal-reg-email")?.focus();
  }

  function close() {
    modal.classList.add("hidden");
    if (errorEl) errorEl.textContent = "";
    if (form) form.reset();
  }

  openBtn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);

  // Switch back to login
  document.getElementById("switch-to-login")?.addEventListener("click", (e) => {
    e.preventDefault();
    close();
    document.getElementById("login-modal")?.classList.remove("hidden");
    document.getElementById("modal-email")?.focus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errorEl) errorEl.textContent = "";
    const pass    = document.getElementById("modal-reg-password").value;
    const confirm = document.getElementById("modal-reg-confirm").value;
    if (pass !== confirm) {
      if (errorEl) errorEl.textContent = "Passwords do not match.";
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating account...";
    try {
      await Auth.register(
        document.getElementById("modal-reg-email").value,
        pass
      );
      close();
      // Open login modal with success hint
      document.getElementById("login-modal")?.classList.remove("hidden");
      const authErr = document.getElementById("modal-auth-error");
      if (authErr) {
        authErr.style.color = "#00d4ff";
        authErr.textContent = "Account created. Please sign in.";
      }
      document.getElementById("modal-email")?.focus();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message || "Registration failed.";
      submitBtn.disabled = false;
      submitBtn.textContent = "Create Account";
    }
  });
}());
