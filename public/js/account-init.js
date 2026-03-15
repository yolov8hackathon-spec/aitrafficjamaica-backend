let accountWs = null;
let currentSession = null;
let currentProfile = { username: "User", avatar_url: "" };

function defaultAvatar(seed) {
  const src = String(seed || "whitelinez-user");
  let hash = 0;
  for (let i = 0; i < src.length; i += 1) hash = ((hash << 5) - hash + src.charCodeAt(i)) | 0;
  const h = Math.abs(hash) % 360;
  const h2 = (h + 32) % 360;
  const skins = ["hsl(28,72%,72%)", "hsl(26,62%,64%)", "hsl(24,56%,56%)", "hsl(21,50%,46%)", "hsl(18,44%,36%)"];
  const hairs = ["#17100a", "#3b2008", "#6b3510", "#c48a10", "#7a1515"];
  const skin = skins[Math.abs(hash >> 4) % skins.length];
  const hair = hairs[Math.abs(hash >> 8) % hairs.length];
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

function getAvatarUrl(avatarUrl, seed) {
  return isAllowedAvatarUrl(avatarUrl) ? avatarUrl : defaultAvatar(seed);
}

function cleanUsername(v, fallback = "User") {
  const x = String(v || "").trim().replace(/\s+/g, " ");
  return x ? x.slice(0, 32) : fallback;
}

async function init() {
  const session = await Auth.requireAuth("/login.html");
  if (!session) return;
  currentSession = session;

  await loadProfile();
  await loadHistory();
  connectAccountWs(session.access_token);

  document.getElementById("btn-save-profile")?.addEventListener("click", saveProfile);
  document.getElementById("profile-avatar-input")?.addEventListener("change", onAvatarUpload);
}

async function loadProfile() {
  if (!currentSession) return;
  const user = currentSession.user;
  const fallbackUsername = cleanUsername(
    user?.user_metadata?.username || user?.email?.split("@")[0] || "User",
    "User"
  );

  let profile = null;
  try {
    const { data, error } = await window.sb
      .from("profiles")
      .select("username, avatar_url")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!error) profile = data;
  } catch {
    // profiles table may not exist yet
  }

  currentProfile = {
    username: cleanUsername(profile?.username || fallbackUsername, fallbackUsername),
    avatar_url: profile?.avatar_url || user?.user_metadata?.avatar_url || "",
  };

  const usernameEl = document.getElementById("profile-username");
  const avatarEl = document.getElementById("profile-avatar-img");
  const headerAvatarEl = document.getElementById("account-header-avatar");
  if (usernameEl) usernameEl.value = currentProfile.username;
  const avatarSrc = getAvatarUrl(currentProfile.avatar_url, user.id);
  if (avatarEl) {
    avatarEl.onerror = () => { avatarEl.src = defaultAvatar(user.id); };
    avatarEl.src = avatarSrc;
  }
  if (headerAvatarEl) {
    headerAvatarEl.onerror = () => { headerAvatarEl.src = defaultAvatar(user.id); };
    headerAvatarEl.src = avatarSrc;
  }

  if (user?.app_metadata?.role === "admin") {
    document.getElementById("account-nav-admin")?.classList.remove("hidden");
  }
}

async function saveProfile() {
  if (!currentSession) return;
  const msgEl = document.getElementById("profile-msg");
  const usernameEl = document.getElementById("profile-username");
  const saveBtn = document.getElementById("btn-save-profile");
  if (!usernameEl || !saveBtn) return;

  const username = cleanUsername(usernameEl.value, currentProfile.username || "User");
  const avatar_url = currentProfile.avatar_url || "";

  saveBtn.disabled = true;
  if (msgEl) msgEl.textContent = "Saving...";

  try {
    const payload = {
      user_id: currentSession.user.id,
      username,
      avatar_url,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await window.sb.from("profiles").upsert(payload, { onConflict: "user_id" });
    if (upsertError) throw upsertError;

    const { error: authError } = await window.sb.auth.updateUser({
      data: { username, avatar_url },
    });
    if (authError) throw authError;

    currentProfile.username = username;
    if (msgEl) msgEl.textContent = "Saved";
  } catch (e) {
    if (msgEl) msgEl.textContent = "Profile save failed";
    console.error("[Account] saveProfile failed:", e);
  } finally {
    saveBtn.disabled = false;
    setTimeout(() => {
      if (msgEl?.textContent === "Saved") msgEl.textContent = "";
    }, 2000);
  }
}

async function onAvatarUpload(e) {
  if (!currentSession) return;
  const file = e.target.files?.[0];
  if (!file) return;

  const msgEl = document.getElementById("profile-msg");
  if (file.size > 2 * 1024 * 1024) {
    if (msgEl) msgEl.textContent = "Max file size is 2MB";
    return;
  }

  try {
    if (msgEl) msgEl.textContent = "Uploading avatar...";
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const path = `${currentSession.user.id}/${Date.now()}.${ext}`;

    const { error: uploadError } = await window.sb.storage
      .from("avatars")
      .upload(path, file, { upsert: true, contentType: file.type || "image/png" });

    if (uploadError) throw uploadError;

    const { data } = window.sb.storage.from("avatars").getPublicUrl(path);
    const publicUrl = data?.publicUrl ? `${data.publicUrl}?v=${Date.now()}` : "";
    currentProfile.avatar_url = publicUrl;

    const avatarEl = document.getElementById("profile-avatar-img");
    const headerAvatarEl = document.getElementById("account-header-avatar");
    const avatarSrc = getAvatarUrl(currentProfile.avatar_url, currentSession.user.id);
    if (avatarEl) avatarEl.src = avatarSrc;
    if (headerAvatarEl) headerAvatarEl.src = avatarSrc;

    await saveProfile();
  } catch (err) {
    console.error("[Account] avatar upload failed:", err);
    if (msgEl) msgEl.textContent = "Avatar upload failed";
  } finally {
    e.target.value = "";
  }
}

function formatBetDetail(b) {
  if (b.bet_type === "exact_count") {
    const cls = b.vehicle_class ? `${b.vehicle_class}s` : "vehicles";
    const win = b.window_duration_sec ? `${b.window_duration_sec}s` : "window";
    return `Exact ${b.exact_count ?? 0} ${cls} in ${win} (8x)`;
  }
  const market = b.markets || {};
  const odds = Number(market.odds || 0);
  const oddsText = odds > 0 ? `${odds.toFixed(2)}x` : "-";
  return `${market.label || "Market bet"} (${oddsText})`;
}

function formatOutcome(b) {
  if (b.status === "pending") {
    return `If correct: +${(b.potential_payout || 0).toLocaleString()} credits`;
  }
  if (b.status === "won") {
    return `Won +${(b.potential_payout || 0).toLocaleString()} credits`;
  }
  if (b.status === "lost") {
    if (b.bet_type === "exact_count" && b.actual_count != null) {
      return `Lost - actual ${b.actual_count} vs target ${b.exact_count ?? 0}`;
    }
    return "Lost";
  }
  return b.status || "-";
}

function renderPending(pending) {
  const container = document.getElementById("pending-container");
  if (!container) return;

  if (!pending.length) {
    container.innerHTML = `<p class="muted">No pending bets.</p>`;
    return;
  }

  container.innerHTML = pending.map((b) => `
    <div class="pending-card">
      <div class="pending-head">
        <span class="badge badge-pending">pending</span>
        <span class="pending-time">${new Date(b.placed_at).toLocaleString()}</span>
      </div>
      <div class="pending-detail">${formatBetDetail(b)}</div>
      <div class="pending-row"><span>Stake</span><strong>${(b.amount || 0).toLocaleString()}</strong></div>
      <div class="pending-row"><span>Potential Payout</span><strong>${(b.potential_payout || 0).toLocaleString()}</strong></div>
      <div class="pending-row"><span>Outcome</span><strong>${formatOutcome(b)}</strong></div>
    </div>
  `).join("");
}

function renderHistoryRows(data) {
  return data.map((b) => `
    <tr class="bet-${b.status}">
      <td>${new Date(b.placed_at).toLocaleString()}</td>
      <td>${formatBetDetail(b)}</td>
      <td>${(b.amount || 0).toLocaleString()}</td>
      <td>${(b.potential_payout || 0).toLocaleString()}</td>
      <td>${formatOutcome(b)}</td>
      <td><span class="badge badge-${b.status}">${b.status}</span></td>
    </tr>
  `).join("");
}

async function loadHistory() {
  if (!currentSession?.user?.id) return;
  const jwt = await Auth.getJwt();
  if (!jwt) return;

  let data = [];
  let error = null;
  try {
    const res = await fetch("/api/bets/place?mode=history&limit=100", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const payload = await res.json();
    if (!res.ok) {
      error = new Error(payload?.detail || payload?.error || "History load failed");
    } else {
      data = Array.isArray(payload) ? payload : [];
    }
  } catch (err) {
    error = err;
  }

  const pending = (data || []).filter((b) => b.status === "pending");
  renderPending(pending);

  const container = document.getElementById("history-container");
  if (!container) return;

  const resolved = (data || []).filter((b) => b.status !== "pending");
  if (error || !resolved.length) {
    container.innerHTML = `<p class="muted">No resolved bets yet. <a href="/index.html">Place your first bet!</a></p>`;
    return;
  }

  container.innerHTML = `
    <table class="history-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Bet</th>
          <th>Stake</th>
          <th>Payout</th>
          <th>Outcome</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${renderHistoryRows(resolved)}
      </tbody>
    </table>`;
}

function connectAccountWs(jwt) {
  const wsMetaPromise = typeof Auth.getWsMeta === "function"
    ? Auth.getWsMeta()
    : fetch("/api/token").then((r) => r.json());

  wsMetaPromise.then(({ wss_url }) => {
    const wsUrl = wss_url.replace("/ws/live", "/ws/account");
    accountWs = new WebSocket(`${wsUrl}?token=${encodeURIComponent(jwt)}`);

    const statusEl = document.getElementById("account-ws-status");
    const balanceEl = document.getElementById("balance-display");

    accountWs.onopen = () => {
      if (statusEl) { statusEl.textContent = "Live"; statusEl.className = "ws-status ws-ok"; }
    };

    accountWs.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.type === "balance" && balanceEl) {
        balanceEl.textContent = Number(data.balance || 0).toLocaleString();
      }
      if (data.type === "bet_resolved") {
        if (data.user_id && String(data.user_id) !== String(currentSession?.user?.id || "")) return;
        loadHistory();
      }
    };

    accountWs.onclose = () => {
      if (statusEl) { statusEl.textContent = "Disconnected"; statusEl.className = "ws-status ws-err"; }
    };
  }).catch(console.error);
}

document.getElementById("btn-logout")?.addEventListener("click", () => Auth.logout());

init();
