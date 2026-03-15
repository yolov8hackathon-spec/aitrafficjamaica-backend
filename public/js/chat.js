/**
 * chat.js - Global chat via Supabase realtime.
 * Guests and logged-in users can send.
 * Avatar and display names are sourced from public profiles table.
 */

const Chat = (() => {
  const GUEST_ID_STORAGE_KEY = "whitelinez.chat.guest_id";
  const GUEST_NAME_STORAGE_KEY = "whitelinez.chat.guest_name";
  let _channel = null;
  let _presenceChannel = null;
  let _userSession = null;
  let _username = "User";
  let _guestId = "";
  const _profileByUserId = new Map();
  const _onlineUsers = new Map();
  const MAX_MESSAGES = 100;
  let _unread = 0;
  let _presenceInitialized = false;
  let _lastRoundEvent = null;
  let _boundRoundUpdates = false;
  let _lastChatUserId = null; // track last message sender for grouping

  // Deterministic per-user accent color — used by avatar AND username label
  function _userAccent(seed) {
    const src = String(seed || "whitelinez-user");
    let hash = 0;
    for (let i = 0; i < src.length; i += 1) hash = ((hash << 5) - hash + src.charCodeAt(i)) | 0;
    const abs = Math.abs(hash);
    const palette = [
      "#00d4ff", // cyan
      "#22c55e", // green
      "#a78bfa", // violet
      "#f472b6", // pink
      "#fb923c", // orange
      "#4ade80", // lime
      "#e879f9", // magenta
      "#60a5fa", // sky-blue
      "#f59e0b", // amber
      "#2dd4bf", // teal
    ];
    return palette[(abs >> 3) % palette.length];
  }

  function defaultAvatar(seed) {
    const src = String(seed || "whitelinez-user");
    let hash = 0;
    for (let i = 0; i < src.length; i += 1) hash = ((hash << 5) - hash + src.charCodeAt(i)) | 0;
    const abs = Math.abs(hash);
    // Background palettes — dark cyber tones anchored around cyan/purple/teal
    const bgs = [
      ["#091a22", "#0e2d3a"], // deep teal
      ["#0a0f1e", "#102040"], // navy blue
      ["#120a1e", "#1e0f35"], // deep purple
      ["#0d1a10", "#0f2d18"], // dark green
      ["#1a0d0d", "#2d1010"], // dark red
    ];
    const bg = bgs[abs % bgs.length];
    const accent = _userAccent(seed);
    // Initials from seed (first 1-2 chars)
    const initials = src.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
    const fontSize = initials.length > 1 ? 34 : 42;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'>
      <defs>
        <linearGradient id='bg${abs}' x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0%' stop-color='${bg[0]}'/>
          <stop offset='100%' stop-color='${bg[1]}'/>
        </linearGradient>
        <clipPath id='cr${abs}'><rect width='96' height='96' rx='12'/></clipPath>
      </defs>
      <rect width='96' height='96' rx='12' fill='url(#bg${abs})'/>
      <!-- Corner brackets -->
      <path d='M6 18 L6 6 L18 6' stroke='${accent}' stroke-width='2.5' fill='none' stroke-linecap='round' opacity='0.55'/>
      <path d='M78 6 L90 6 L90 18' stroke='${accent}' stroke-width='2.5' fill='none' stroke-linecap='round' opacity='0.55'/>
      <path d='M6 78 L6 90 L18 90' stroke='${accent}' stroke-width='2.5' fill='none' stroke-linecap='round' opacity='0.55'/>
      <path d='M78 90 L90 90 L90 78' stroke='${accent}' stroke-width='2.5' fill='none' stroke-linecap='round' opacity='0.55'/>
      <!-- Initials -->
      <text x='48' y='54' text-anchor='middle' dominant-baseline='middle'
        font-family='JetBrains Mono,Fira Code,monospace' font-size='${fontSize}'
        font-weight='700' fill='${accent}' opacity='0.92'
        letter-spacing='-1'>${initials}</text>
      <!-- Subtle bottom glow -->
      <rect x='0' y='70' width='96' height='26' fill='${accent}' opacity='0.04' rx='0'/>
      <rect width='96' height='96' rx='12' fill='none' stroke='${accent}' stroke-width='1.5' opacity='0.18'/>
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

  function init(session) {
    _userSession = session;
    const hint = document.getElementById("chat-login-hint");
    const inputRow = document.querySelector(".chat-input-row");

    if (session) {
      _username = session.user?.user_metadata?.username
        || session.user?.email?.split("@")[0]
        || "User";
      const ownAvatar = session.user?.user_metadata?.avatar_url || "";
      _profileByUserId.set(session.user.id, {
        username: _username,
        avatar_url: ownAvatar,
      });
      _guestId = "";
      if (hint) {
        hint.innerHTML = "";
        hint.classList.add("hidden");
      }
    } else {
      const guest = _getOrCreateGuestIdentity();
      _guestId = guest.id;
      _username = guest.username;
      if (hint) {
        hint.classList.remove("hidden");
        hint.innerHTML = `Chatting as <strong>${esc(_username)}</strong>. <a href="/login.html">Login</a> to keep a profile.`;
      }
    }
    if (inputRow) inputRow.style.display = "";

    _showSkeleton();
    _loadHistory();
    _subscribe();
    _subscribePresence();
    _bindTabIndicator();
    _bindRoundAnnouncements();
    _bindOnlineMentionClicks();
    _renderOnlineUi();

    document.getElementById("chat-send")?.addEventListener("click", send);
    document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });

    // Show bet activity as interleaved chat events
    window.addEventListener("activity:bet", (e) => _renderActivity(e.detail || {}));
  }

  function _chatTabBtn() {
    return document.querySelector('.tab-btn[data-tab="chat"]');
  }

  function _isChatTabActive() {
    return _chatTabBtn()?.classList.contains("active");
  }

  function _renderUnread() {
    const btn = _chatTabBtn();
    const badge = document.getElementById("chat-tab-indicator");
    if (!btn || !badge) return;
    if (_unread > 0) {
      badge.textContent = _unread > 99 ? "99+" : String(_unread);
      badge.classList.remove("hidden");
      btn.classList.add("has-unread");
    } else {
      badge.classList.add("hidden");
      btn.classList.remove("has-unread");
    }
  }

  function _clearUnread() {
    _unread = 0;
    _renderUnread();
  }

  function _bindTabIndicator() {
    const btn = _chatTabBtn();
    if (btn) {
      btn.addEventListener("click", () => {
        _clearUnread();
        // Scroll to newest when tab becomes visible (handles hidden-at-load race)
        requestAnimationFrame(_scrollToBottom);
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && _isChatTabActive()) _clearUnread();
    });
    window.addEventListener("focus", () => {
      if (_isChatTabActive()) _clearUnread();
    });
    _renderUnread();
  }

  function _showSkeleton() {
    const container = document.getElementById("chat-messages");
    if (!container) return;
    container.innerHTML = Array(5).fill(
      `<div class="skeleton" style="height:36px;border-radius:6px;"></div>`
    ).join("");
  }

  function _showEmpty() {
    const container = document.getElementById("chat-messages");
    if (!container) return;
    container.innerHTML = `<div class="empty-state">No messages yet.<br><span>Start the conversation.</span></div>`;
  }

  function _bindOnlineMentionClicks() {
    const list = document.getElementById("chat-online-users");
    if (!list || list.dataset.wired === "1") return;
    list.dataset.wired = "1";
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mention]");
      if (!btn) return;
      _insertMention(btn.dataset.mention || "");
    });
  }

  function _insertMention(name) {
    const cleaned = String(name || "").replace(/\s+/g, "");
    if (!cleaned) return;
    const input = document.getElementById("chat-input");
    if (!input) return;
    const token = `@${cleaned}`;
    const existing = input.value.trim();
    input.value = existing ? `${existing} ${token} ` : `${token} `;
    input.focus();
  }

  function _normalizeName(v) {
    return String(v || "").trim().toLowerCase();
  }

  function _renderOnlineUi() {
    const countEl = document.getElementById("chat-online-count");
    const listEl = document.getElementById("chat-online-users");
    const online = [..._onlineUsers.values()];
    if (countEl) countEl.textContent = `${online.length} online`;
    if (!listEl) return;
    if (!online.length) {
      listEl.innerHTML = "";
      return;
    }
    listEl.innerHTML = online
      .slice(0, 10)
      .map((name) => `<button type="button" class="chat-online-user" data-mention="${escAttr(name)}">@${esc(name)}</button>`)
      .join("");
  }

  function _subscribePresence() {
    if (_presenceChannel) window.sb.removeChannel(_presenceChannel);
    _presenceInitialized = false;
    _onlineUsers.clear();
    _renderOnlineUi();

    const presenceKey = _userSession?.user?.id || _guestId || _getOrCreateGuestIdentity().id;
    _presenceChannel = window.sb
      .channel("chat-presence", { config: { presence: { key: presenceKey } } })
      .on("presence", { event: "sync" }, () => {
        const state = _presenceChannel?.presenceState?.() || {};
        const nowOnline = new Map();

        Object.values(state).forEach((entries) => {
          if (!Array.isArray(entries)) return;
          entries.forEach((entry) => {
            const uid = String(entry?.user_id || entry?.guest_id || "").trim();
            const uname = String(entry?.username || "").trim();
            if (!uid || !uname) return;
            if (!nowOnline.has(uid)) nowOnline.set(uid, uname);
          });
        });

        // Detect joins before overwriting map
        const prevUids = _presenceInitialized ? new Set(_onlineUsers.keys()) : null;

        _onlineUsers.clear();
        nowOnline.forEach((name, uid) => _onlineUsers.set(uid, name));
        _renderOnlineUi();

        // Dispatch online count
        window.dispatchEvent(new CustomEvent("chat:online", { detail: _onlineUsers.size }));

        // Dispatch join events for new arrivals (skip initial sync)
        if (prevUids) {
          nowOnline.forEach((name, uid) => {
            if (!prevUids.has(uid)) {
              window.dispatchEvent(new CustomEvent("chat:join", { detail: { username: name } }));
            }
          });
        }

        _presenceInitialized = true;
      })
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        const payload = _userSession?.user?.id
          ? {
              user_id: _userSession.user.id,
              username: _username,
              online_at: new Date().toISOString(),
            }
          : {
              guest_id: _guestId || _getOrCreateGuestIdentity().id,
              username: _username,
              is_guest: true,
              online_at: new Date().toISOString(),
            };
        await _presenceChannel.track(payload);
      });
  }

  function _bindRoundAnnouncements() {
    if (_boundRoundUpdates) return;
    _boundRoundUpdates = true;
    window.addEventListener("round:update", (e) => {
      const round = e.detail || null;
      const current = round ? {
        id: round.id || null,
        status: String(round.status || "").toLowerCase(),
        opens_at: round.opens_at || null,
      } : null;
      const prev = _lastRoundEvent;
      const becameOpen = !!current
        && current.status === "open"
        && !!prev
        && (prev.id !== current.id || prev.status !== "open");
      if (becameOpen) {
        _addSystemMessage("New match started. Guesses are now open.");
      }
      _lastRoundEvent = current;
    });
  }

  async function _loadProfiles(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return;

    try {
      const { data, error } = await window.sb
        .from("profiles")
        .select("user_id, username, avatar_url")
        .in("user_id", ids);
      if (error || !Array.isArray(data)) return;
      for (const p of data) {
        _profileByUserId.set(p.user_id, {
          username: p.username || "User",
          avatar_url: p.avatar_url || "",
        });
      }
    } catch {
      // profiles table may not exist yet
    }
  }

  async function _loadHistory() {
    try {
      const { data, error } = await window.sb
        .from("messages")
        .select("user_id, username, content, created_at")
        .order("created_at", { ascending: true })
        .limit(50);

      if (error) throw error;

      await _loadProfiles((data || []).map((m) => m.user_id));

      const container = document.getElementById("chat-messages");
      if (!container) return;
      container.innerHTML = "";

      if (!data || data.length === 0) {
        _showEmpty();
        return;
      }

      data.forEach(renderMsg);
      _scrollToBottom();
    } catch (e) {
      console.warn("[Chat] History load failed:", e);
      const container = document.getElementById("chat-messages");
      if (container) {
        container.innerHTML = `<div class="empty-state">Chat unavailable.<br><span>Run SQL migrations to enable chat.</span></div>`;
      }
    }
  }

  function _subscribe() {
    if (_channel) window.sb.removeChannel(_channel);
    _channel = window.sb
      .channel("chat")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" },
        async (payload) => {
          const container = document.getElementById("chat-messages");
          const empty = container?.querySelector(".empty-state");
          if (empty) empty.remove();

          const msg = payload.new || {};
          if (msg.user_id && !_profileByUserId.has(msg.user_id)) {
            await _loadProfiles([msg.user_id]);
          }

          renderMsg(msg);
          _scrollToBottom();

          // Broadcast to stream overlay
          const _ovProfile = msg.user_id ? _profileByUserId.get(msg.user_id) : null;
          const _ovName = _ovProfile?.username || msg.username || "User";
          window.dispatchEvent(new CustomEvent("chat:message", { detail: { username: _ovName, content: msg.content || "" } }));

          const isOwn = !!_userSession?.user?.id && msg.user_id === _userSession.user.id;
          if (!isOwn && !_isChatTabActive()) {
            _unread += 1;
            _renderUnread();
          } else if (_isChatTabActive()) {
            _clearUnread();
          }
        }
      )
      .subscribe();
  }

  function renderMsg(msg) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    while (container.children.length >= MAX_MESSAGES) {
      container.removeChild(container.firstChild);
    }

    if (msg.system) {
      const time = msg.created_at
        ? new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
      const div = document.createElement("div");
      div.className = "chat-msg system";
      div.innerHTML = `<span>${esc(msg.content || "")}</span>${time ? `<span class="chat-time">${time}</span>` : ""}`;
      container.appendChild(div);
      _lastChatUserId = null; // break grouping chain
      return;
    }

    const profile = msg.user_id ? _profileByUserId.get(msg.user_id) : null;
    const username = profile?.username || msg.username || "User";
    const avatar = isAllowedAvatarUrl(profile?.avatar_url)
      ? profile.avatar_url
      : defaultAvatar(msg.user_id || username);
    const time = msg.created_at
      ? new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

    const color = _userAccent(msg.user_id || username);
    const senderKey = msg.user_id || username;
    const isContinued = senderKey === _lastChatUserId;
    _lastChatUserId = senderKey;
    const div = document.createElement("div");
    div.className = isContinued ? "chat-msg chat-continued" : "chat-msg";
    div.innerHTML = `
      <img class="chat-avatar" src="${escAttr(avatar)}" alt="${escAttr(username)}" style="border-color: ${color}55;" />
      <div class="chat-body" style="--user-accent: ${color};">
        <div class="chat-head"><span class="chat-user" style="color: ${color};">${esc(username)}</span><span class="chat-time">${time}</span></div>
        <div class="chat-text">${_formatContent(msg.content)}</div>
      </div>
    `;
    container.appendChild(div);
  }

  function _formatContent(content) {
    const raw = esc(content || "");
    const self = _normalizeName(_username);
    return raw.replace(/(^|[\s(])@([a-zA-Z0-9_.-]{1,32})/g, (full, lead, mention) => {
      const cls = _normalizeName(mention) === self ? "chat-mention chat-mention-self" : "chat-mention";
      return `${lead}<span class="${cls}">@${mention}</span>`;
    });
  }

  function _betDesc(bet) {
    if (bet.bet_type === "exact_count") {
      const cls = bet.vehicle_class ? `${bet.vehicle_class}s` : "vehicles";
      const sec = bet.window_duration_sec;
      const win = sec ? (sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}m`) : "";
      return `Guessed: <strong>${bet.exact_count} ${cls}</strong>${win ? ` in ${win}` : ""}`;
    }
    return "Submitted a guess";
  }

  function _renderActivity(bet) {
    const container = document.getElementById("chat-messages");
    if (!container) return;
    const time = bet.placed_at
      ? new Date(bet.placed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    const div = document.createElement("div");
    _lastChatUserId = null; // break grouping chain
    div.className = "chat-msg chat-activity-item";
    div.innerHTML = `
      <span class="ca-icon">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.4H21l-5.2 3.8 2 6.4L12 14.8 6.2 18.6l2-6.4L3 8.4h6.6z"/></svg>
      </span>
      <span class="ca-text">Someone guessed — ${_betDesc(bet)}</span>
      ${time ? `<span class="ca-time">${time}</span>` : ""}`;
    container.appendChild(div);
    _scrollToBottom();
  }

  function _addSystemMessage(text) {
    renderMsg({
      system: true,
      content: text,
      created_at: new Date().toISOString(),
    });
    _scrollToBottom();
    if (!_isChatTabActive()) {
      _unread += 1;
      _renderUnread();
    }
  }

  function _scrollToBottom() {
    const c = document.getElementById("chat-messages");
    if (c) c.scrollTop = c.scrollHeight;
  }

  async function send() {
    const input = document.getElementById("chat-input");
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;

    input.value = "";
    input.disabled = true;

    try {
      const payload = {
        username: _username,
        content,
      };
      if (_userSession?.user?.id) {
        payload.user_id = _userSession.user.id;
      } else if (_guestId) {
        payload.guest_id = _guestId;
      }
      let { error } = await window.sb.from("messages").insert(payload);
      if (error && String(error.message || "").toLowerCase().includes("guest_id")) {
        const retry = await window.sb.from("messages").insert({
          user_id: payload.user_id || null,
          username: payload.username,
          content: payload.content,
        });
        error = retry.error;
      }
      if (error) throw error;
    } catch (e) {
      console.error("[Chat] Send failed:", e);
      input.value = content;
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  }

  function escAttr(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/\"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function _getOrCreateGuestIdentity() {
    let id = "";
    let name = "";
    try {
      id = String(localStorage.getItem(GUEST_ID_STORAGE_KEY) || "").trim();
      name = String(localStorage.getItem(GUEST_NAME_STORAGE_KEY) || "").trim();
    } catch {}
    if (!id) {
      id = `guest-${Math.random().toString(36).slice(2, 10)}`;
      try { localStorage.setItem(GUEST_ID_STORAGE_KEY, id); } catch {}
    }
    if (!name) {
      name = `Guest-${id.slice(-4).toUpperCase()}`;
      try { localStorage.setItem(GUEST_NAME_STORAGE_KEY, name); } catch {}
    }
    return { id, username: name };
  }

  return { init };
})();

window.Chat = Chat;

// ── Stream Chat Overlay (Twitch-style live feed widget) ────────────────────────
const StreamChatOverlay = (() => {
  const MAX_MSGS = 6;
  const MSG_LIFETIME_MS  = 9000;
  const JOIN_LIFETIME_MS = 4500;

  function _esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function _msgEl() { return document.getElementById("sco-messages"); }
  function _countEl() { return document.getElementById("sco-count"); }

  function _trim(container) {
    while (container.children.length > MAX_MSGS) {
      container.removeChild(container.firstChild);
    }
  }

  function _schedFade(el, lifeMs, fadeDurationMs) {
    setTimeout(() => {
      el.classList.add("fading");
      setTimeout(() => { try { el.remove(); } catch {} }, fadeDurationMs);
    }, lifeMs);
  }

  function _onMessage({ username, content }) {
    const container = _msgEl();
    if (!container) return;
    const div = document.createElement("div");
    div.className = "sco-msg";
    div.innerHTML = `<span class="sco-msg-user">${_esc(username)}</span><span class="sco-msg-text">${_esc(content)}</span>`;
    container.appendChild(div);
    _trim(container);
    _schedFade(div, MSG_LIFETIME_MS, 1000);
  }

  function _onJoin({ username }) {
    const container = _msgEl();
    if (!container) return;
    const div = document.createElement("div");
    div.className = "sco-join";
    div.textContent = `${username} joined`;
    container.appendChild(div);
    _schedFade(div, JOIN_LIFETIME_MS, 700);
  }

  function _onOnline(count) {
    const el = _countEl();
    if (el) el.textContent = `${count} watching`;
  }

  function _onActivity(bet) {
    const container = _msgEl();
    if (!container) return;
    // Only show new real-time bets in overlay, not history replays
    if (!bet.isNew) return;
    let label = "submitted a guess";
    if (bet.bet_type === "exact_count") label = `guessed ${bet.exact_count} vehicles`;
    const div = document.createElement("div");
    div.className = "sco-msg sco-activity";
    div.innerHTML = `<span class="sco-act-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 6.4H21l-5.2 3.8 2 6.4L12 14.8 6.2 18.6l2-6.4L3 8.4h6.6z"/></svg></span><span class="sco-msg-text">Someone ${label}</span>`;
    container.appendChild(div);
    _trim(container);
    _schedFade(div, MSG_LIFETIME_MS, 1000);
  }

  function init() {
    window.addEventListener("chat:message",  (e) => _onMessage(e.detail || {}));
    window.addEventListener("chat:join",     (e) => _onJoin(e.detail || {}));
    window.addEventListener("chat:online",   (e) => _onOnline(e.detail || 0));
    window.addEventListener("activity:bet",  (e) => _onActivity(e.detail || {}));
  }

  return { init };
})();

window.StreamChatOverlay = StreamChatOverlay;
