/**
 * markets.js - Renders active bet markets in the sidebar.
 * Manages sidebar tab switching.
 * Connects market cards to bet panel (LiveBet) instead of a modal.
 */

const Markets = (() => {
  let currentRound = null;
  let timersInterval = null;
  let lastRoundId = null;
  let currentUserId = null;
  let latestCountPayload = null;
  let roundBaseline = null;
  let userRoundBets = [];
  let optimisticPendingBet = null;
  let userBetPollTimer = null;
  let nextRoundPollTimer = null;
  let nextRoundTickTimer = null;
  let nextRoundAtIso = null;
  let hasInitialRender = false;
  let lastUserBetMarkup = "";
  let latestResolvedCard = null;
  let roundGuideCollapsed = false;
  let _lastRenderedRoundKey = null;   // prevents timer flicker on 60s polls
  let _receiptSkeletonBetKey = null;  // prevents receipt flicker on count:update
  const dismissedResolvedBetIds = new Set();
  const RESOLVED_CARD_STORAGE_KEY = "wlz_round_result_card_v1";
  const DISMISSED_RESOLVED_STORAGE_KEY = "wlz_round_result_dismissed_v1";
  const ROUND_GUIDE_COLLAPSE_KEY = "wlz_round_guide_collapsed_v1";

  const USER_BET_POLL_MS = 5000;

  function initTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(`tab-${tab}`)?.classList.add("active");
      });
    });
  }

  async function loadMarkets() {
    if (!hasInitialRender) _showSkeleton();
    try {
      await _ensureCurrentUser();
      const round = await _fetchPreferredRound();

      if (!round) {
        renderNoRound();
        return;
      }

      if (currentRound?.id !== round.id) {
        if (latestResolvedCard?.round_id && latestResolvedCard.round_id !== round.id) {
          _clearResolvedOutcomeCard();
        }
        _resetRoundLiveState();
      }

      currentRound = round;
      LiveBet.setRound(round);
      renderRound(round);
      updateRoundStrip(round);
      await _ensureRoundBaseline(round);
      await _loadUserRoundBets();
      _startUserBetPolling();
    } catch (e) {
      console.error("[Markets] Failed to load:", e);
      renderNoRound();
    }
  }

  async function _fetchPreferredRound() {
    const nowIso = new Date().toISOString();
    const recentLockedIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    // 1) Prefer currently open round.
    const { data: openRound, error: openErr } = await window.sb
      .from("bet_rounds")
      .select("*, markets(*)")
      .eq("status", "open")
      .gt("ends_at", nowIso)
      .order("opens_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!openErr && openRound) return openRound;

    // 2) Then a recently locked round (shows "resolving" while settlement runs).
    const { data: lockedRound, error: lockedErr } = await window.sb
      .from("bet_rounds")
      .select("*, markets(*)")
      .eq("status", "locked")
      .gte("ends_at", recentLockedIso)
      .order("ends_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!lockedErr && lockedRound) return lockedRound;

    // 3) Finally, next upcoming round.
    const { data: upcomingRound, error: upcomingErr } = await window.sb
      .from("bet_rounds")
      .select("*, markets(*)")
      .eq("status", "upcoming")
      .order("opens_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!upcomingErr && upcomingRound) return upcomingRound;

    return null;
  }

  function _showSkeleton() {
    const container = document.getElementById("markets-container");
    if (!container) return;
    container.innerHTML = `
      <div class="skeleton" style="height:22px;width:60%;margin-bottom:10px;border-radius:6px;"></div>
      <div class="skeleton" style="height:14px;width:100%;margin-bottom:16px;border-radius:4px;"></div>
      ${Array(3).fill(`<div class="skeleton" style="height:88px;border-radius:8px;margin-bottom:8px;"></div>`).join("")}
    `;
  }

  function renderNoRound() {
    clearInterval(timersInterval);
    timersInterval = null;
    lastRoundId = null;
    _stopUserBetPolling();
    _resetRoundLiveState();
    window.Banners?.show();
    const container = document.getElementById("markets-container");
    if (container) container.classList.remove("mkts-round-hidden");
    if (container) {
      // Keep hidden countdown elements alive for internal logic; no visible empty-state
      // (the banner tile handles "No Active Round" messaging)
      const html = `
        <span id="next-round-note" style="display:none;"></span>
        <strong id="next-round-countdown" style="display:none;">--:--</strong>`;
      if (container.innerHTML !== html) container.innerHTML = html;
    }
    updateRoundStrip(null);
    _startNextRoundCountdown();
    _renderResolvedOutcomeCard();
    hasInitialRender = true;
  }


  function _vehicleClassLabel(cls) {
    const v = String(cls || "").toLowerCase();
    if (v === "car") return "Cars";
    if (v === "truck") return "Trucks";
    if (v === "bus") return "Buses";
    if (v === "motorcycle") return "Motorcycles";
    return "Vehicles";
  }

  function _matchDurationLabel(round) {
    const params = round?.params || {};
    // Derive a friendly label from round timing
    const opensAt  = round?.opens_at  ? new Date(round.opens_at)  : null;
    const endsAt   = round?.ends_at   ? new Date(round.ends_at)   : null;
    if (opensAt && endsAt) {
      const secs = Math.round((endsAt - opensAt) / 1000);
      if (secs <= 90)  return "1 MIN MATCH";
      if (secs <= 240) return "3 MIN MATCH";
      if (secs <= 360) return "5 MIN MATCH";
      return `${Math.round(secs / 60)} MIN MATCH`;
    }
    return "TIMED MATCH";
  }

  function _roundGuide(round) {
    const params = round?.params || {};
    const marketType = String(round?.market_type || "");
    const vehicleClass = String(params?.vehicle_class || "").toLowerCase();
    const cls = vehicleClass ? _vehicleClassLabel(vehicleClass).toLowerCase() : "vehicles";

    return {
      title: "How This Match Works",
      summary: `Watch the live camera and guess how many ${cls} will pass during this match. The count starts at zero when the match opens.`,
      winRule: "The closer your guess is to the real count, the more points you earn. An exact match scores the highest.",
    };
  }

  function _friendlyMarketLabel(round, market) {
    const params = round?.params || {};
    const marketType = String(round?.market_type || "");
    const outcome = String(market?.outcome_key || "").toLowerCase();
    const threshold = Number(params?.threshold || 0);
    const cls = _vehicleClassLabel(params?.vehicle_class);

    if (marketType === "over_under") {
      if (outcome === "over") return `Over ${threshold} vehicles`;
      if (outcome === "under") return `Under ${threshold} vehicles`;
      if (outcome === "exact") return `Exactly ${threshold} vehicles`;
    }

    if (marketType === "vehicle_count") {
      if (outcome === "over") return `Over ${threshold} ${cls.toLowerCase()}`;
      if (outcome === "under") return `Under ${threshold} ${cls.toLowerCase()}`;
      if (outcome === "exact") return `Exactly ${threshold} ${cls.toLowerCase()}`;
    }

    if (marketType === "vehicle_type") {
      return `${String(market?.label || outcome || "Vehicle type")}`;
    }

    return String(market?.label || "Market");
  }

  // ── Enter / exit round view ───────────────────────────────────
  function _enterRound() {
    const container = document.getElementById("markets-container");
    if (container) container.classList.remove("mkts-round-hidden");
    window.Banners?.hide();
  }

  function _exitRound() {
    const container = document.getElementById("markets-container");
    if (container) container.classList.add("mkts-round-hidden");
    window.Banners?.show();
  }

  function renderRound(round) {
    // Do NOT hide banners immediately — user enters the round view intentionally
    const container = document.getElementById("markets-container");
    if (!container) return;

    const isOpen = round.status === "open";
    const opensAt = round.opens_at ? new Date(round.opens_at) : null;
    const closesAt = round.closes_at ? new Date(round.closes_at) : null;
    const endsAt = round.ends_at ? new Date(round.ends_at) : null;
    const guide = _roundGuide(round);

    const matchLabel = _matchDurationLabel(round);
    const statusLabel = round.status === "open" ? "OPEN" : round.status === "locked" ? "LOCKED" : round.status.toUpperCase();

    const html = `
      <button class="mkts-back-btn" id="mkts-back-btn" type="button">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Announcements
      </button>
      <div class="round-header">
        <span class="round-badge round-${round.status}">${statusLabel}</span>
        <span class="round-type">${matchLabel}</span>
      </div>
      <div class="round-timing">
        ${opensAt ? `<div class="timing-row"><span>Started</span><strong id="rt-elapsed"></strong></div>` : ""}
        ${closesAt ? `<div class="timing-row"><span>Guesses close</span><strong id="rt-closes"></strong></div>` : ""}
        ${endsAt ? `<div class="timing-row"><span>Match ends</span><strong id="rt-ends"></strong></div>` : ""}
      </div>
      <div class="round-guide" role="note" aria-live="polite">
        <div class="round-guide-head">
          <p class="round-guide-title">${guide.title}</p>
          <button id="round-guide-toggle" class="round-guide-toggle" type="button">${roundGuideCollapsed ? "Show" : "Hide"}</button>
        </div>
        <div id="round-guide-body" class="round-guide-body${roundGuideCollapsed ? " collapsed" : ""}">
          <p class="round-guide-line">${guide.summary}</p>
          <p class="round-guide-line">${guide.winRule}</p>
        </div>
      </div>
      <div id="user-round-bet" class="user-round-bet hidden"></div>
      ${isOpen ? `
      <div class="mkts-guess-cta">
        <button class="btn-live-bet btn-full" id="btn-open-live-bet">
          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          Make Your Guess
        </button>
        <p class="mkts-guess-sub">Guess the vehicle count — closer wins more points</p>
      </div>` : `
      <div class="mkts-locked-state">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>Guesses are closed for this match</span>
      </div>`}
    `;
    // Only rebuild DOM (and restart timers/listeners) when round identity or
    // status changes. This prevents the timer elements from being destroyed
    // and recreated on every 60-second loadMarkets() poll.
    const roundKey = `${round.id}:${round.status}`;
    if (roundKey !== _lastRenderedRoundKey) {
      // Detect if this is a brand-new round (different ID) vs. same round status change
      const prevRoundId = _lastRenderedRoundKey ? _lastRenderedRoundKey.split(":")[0] : null;
      const isNewRound = !prevRoundId || prevRoundId !== String(round.id);

      _lastRenderedRoundKey = roundKey;
      container.innerHTML = html;
      startTimers(opensAt, closesAt, endsAt);

      document.getElementById("mkts-back-btn")?.addEventListener("click", _exitRound);
      document.getElementById("btn-open-live-bet")?.addEventListener("click", () => {
        LiveBet.open(currentRound);
      });
      document.getElementById("round-guide-toggle")?.addEventListener("click", () => {
        _setRoundGuideCollapsed(!roundGuideCollapsed);
      });

      // New round → stay on banners, let user choose to enter
      if (isNewRound) {
        container.classList.add("mkts-round-hidden");
        window.Banners?.show();
      }
    }

    _renderUserRoundBet();
    _stopNextRoundCountdown();
    _renderResolvedOutcomeCard();
    hasInitialRender = true;
  }

  function renderMarket(round, market, isOpen) {
    const odds = parseFloat(market.odds || 0);
    const payout100 = odds > 0 ? Math.floor(100 * odds) : 0;
    const beginnerLabel = _friendlyMarketLabel(round, market);
    return `
      <div class="market-card"
           data-can-bet="${isOpen ? "1" : "0"}"
           data-market-id="${market.id}"
           data-label="${escAttr(beginnerLabel)}"
           data-odds="${market.odds}">
        <div class="market-label">${beginnerLabel}</div>
        <div class="market-payout">Bet 100 → ${payout100.toLocaleString()} credits</div>
        <div class="market-odds-note">Odds rate: ${odds.toFixed(2)}x payout multiplier</div>
        <div class="market-staked">${(market.total_staked || 0).toLocaleString()} staked</div>
        ${isOpen
          ? `<button class="btn-bet">Guess This Outcome</button>`
          : `<span class="market-closed">Closed</span>`}
      </div>`;
  }

  function _loadRoundGuidePref() {
    try {
      roundGuideCollapsed = localStorage.getItem(ROUND_GUIDE_COLLAPSE_KEY) === "1";
    } catch {
      roundGuideCollapsed = false;
    }
  }

  function _setRoundGuideCollapsed(next) {
    roundGuideCollapsed = !!next;
    try {
      localStorage.setItem(ROUND_GUIDE_COLLAPSE_KEY, roundGuideCollapsed ? "1" : "0");
    } catch {}
    const body = document.getElementById("round-guide-body");
    const toggle = document.getElementById("round-guide-toggle");
    if (body) body.classList.toggle("collapsed", roundGuideCollapsed);
    if (toggle) toggle.textContent = roundGuideCollapsed ? "Show" : "Hide";
  }

  function updateRoundStrip(round) {
    const strip = document.getElementById("round-strip");
    const badge = document.getElementById("rs-badge");
    const timer = document.getElementById("rs-timer");
    if (!strip) return;

    if (!round) {
      strip.classList.add("hidden");
      return;
    }

    strip.classList.remove("hidden");
    if (badge) badge.textContent = round.status.toUpperCase();

    const endsAt = round.ends_at ? new Date(round.ends_at) : null;
    if (!endsAt || !timer) return;

    const tick = () => {
      const diff = Math.max(0, Math.floor((endsAt - Date.now()) / 1000));
      timer.textContent = `${fmtDuration(diff)} left`;
    };
    tick();
    clearInterval(window._roundStripTimer);
    window._roundStripTimer = setInterval(tick, 1000);
  }

  function escAttr(str) {
    return String(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtDuration(sec) {
    if (sec >= 3600) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
      const s = (sec % 60).toString().padStart(2, "0");
      return `${h}:${m}:${s}`;
    }
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = (sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function startTimers(opensAt, closesAt, endsAt) {
    clearInterval(timersInterval);
    let closedFired = false;
    let endedFired = false;

    timersInterval = setInterval(() => {
      const now = Date.now();

      const elapsedEl = document.getElementById("rt-elapsed");
      if (elapsedEl && opensAt) {
        const elapsedRaw = Math.floor((now - opensAt) / 1000);
        if (!Number.isFinite(elapsedRaw) || elapsedRaw < 0) {
          elapsedEl.textContent = "--:--";
        } else {
          elapsedEl.textContent = `${fmtDuration(elapsedRaw)} ago`;
        }
      }

      const closesEl = document.getElementById("rt-closes");
      if (closesEl && closesAt) {
        const diffRaw = Math.floor((closesAt - now) / 1000);
        const diff = Number.isFinite(diffRaw) ? Math.max(0, diffRaw) : 0;
        closesEl.textContent = diff === 0 ? "Closed" : `in ${fmtDuration(diff)}`;
        if (diff === 0 && !closedFired) {
          closedFired = true;
          setTimeout(loadMarkets, 1500);
        }
      }

      const endsEl = document.getElementById("rt-ends");
      if (endsEl && endsAt) {
        const diffRaw = Math.floor((endsAt - now) / 1000);
        const diff = Number.isFinite(diffRaw) ? Math.max(0, diffRaw) : 0;
        endsEl.textContent = diff === 0 ? "Resolving..." : `in ${fmtDuration(diff)}`;
        if (diff === 0 && !endedFired) {
          endedFired = true;
          setTimeout(loadMarkets, 4000);
        }
      }
    }, 1000);
  }

  async function _ensureCurrentUser() {
    if (currentUserId !== null) return;
    const session = await Auth.getSession();
    currentUserId = session?.user?.id || "";
  }

  function _resetRoundLiveState() {
    roundBaseline = null;
    userRoundBets = [];
    optimisticPendingBet = null;
    _lastRenderedRoundKey = null;
    _receiptSkeletonBetKey = null;
  }

  function _loadPersistedResolvedCard() {
    try {
      const rawCard = localStorage.getItem(RESOLVED_CARD_STORAGE_KEY);
      if (rawCard) {
        const parsed = JSON.parse(rawCard);
        if (parsed && parsed.bet_id) latestResolvedCard = parsed;
      }
      const rawDismissed = localStorage.getItem(DISMISSED_RESOLVED_STORAGE_KEY);
      if (rawDismissed) {
        const arr = JSON.parse(rawDismissed);
        if (Array.isArray(arr)) {
          arr.slice(0, 200).forEach((id) => dismissedResolvedBetIds.add(String(id)));
        }
      }
    } catch {}
  }

  function _persistResolvedCard() {
    try {
      if (!latestResolvedCard || !latestResolvedCard.bet_id) {
        localStorage.removeItem(RESOLVED_CARD_STORAGE_KEY);
        return;
      }
      localStorage.setItem(RESOLVED_CARD_STORAGE_KEY, JSON.stringify(latestResolvedCard));
    } catch {}
  }

  function _persistDismissedResolved() {
    try {
      localStorage.setItem(
        DISMISSED_RESOLVED_STORAGE_KEY,
        JSON.stringify(Array.from(dismissedResolvedBetIds).slice(-200)),
      );
    } catch {}
  }

  function _stopUserBetPolling() {
    clearInterval(userBetPollTimer);
    userBetPollTimer = null;
  }

  function _startUserBetPolling() {
    _stopUserBetPolling();
    if (!currentRound || !currentUserId) return;
    userBetPollTimer = setInterval(() => {
      _loadUserRoundBets();
    }, USER_BET_POLL_MS);
  }

  function _formatCountdown(sec) {
    const n = Math.max(0, Math.floor(sec));
    const m = Math.floor(n / 60).toString().padStart(2, "0");
    const s = (n % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function _stopNextRoundCountdown() {
    clearInterval(nextRoundPollTimer);
    clearInterval(nextRoundTickTimer);
    nextRoundPollTimer = null;
    nextRoundTickTimer = null;
    nextRoundAtIso = null;
  }

  async function _pollNextRoundAt() {
    const noteEl = document.getElementById("next-round-note");
    const cdEl = document.getElementById("next-round-countdown");
    if (!noteEl || !cdEl) return;
    try {
      nextRoundAtIso = null;

      // 1) Try backend health first, but do not fail hard if unavailable.
      try {
        const h = await fetch("/api/health");
        if (h.ok) {
          const health = await h.json();
          nextRoundAtIso = health?.next_round_at || null;
        }
      } catch {}

      // 2) Fallback to active session scheduler timestamp.
      if (!nextRoundAtIso && window.sb) {
        const { data: session } = await window.sb
          .from("round_sessions")
          .select("next_round_at,status")
          .eq("status", "active")
          .not("next_round_at", "is", null)
          .order("next_round_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        nextRoundAtIso = session?.next_round_at || null;
      }

      // 3) Final fallback to upcoming rounds table.
      if (!nextRoundAtIso && window.sb) {
        const { data } = await window.sb
          .from("bet_rounds")
          .select("id, opens_at, status")
          .eq("status", "upcoming")
          .order("opens_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        nextRoundAtIso = data?.opens_at || null;
      }
      if (!nextRoundAtIso) {
        noteEl.textContent = "New round schedule will appear shortly.";
        cdEl.textContent = "--:--";
        return;
      }
      noteEl.textContent = "Next round starts soon.";
      const diff = Math.max(0, Math.floor((new Date(nextRoundAtIso).getTime() - Date.now()) / 1000));
      cdEl.textContent = _formatCountdown(diff);
    } catch {
      noteEl.textContent = "Schedule temporarily unavailable.";
      cdEl.textContent = "--:--";
    }
  }

  function _startNextRoundCountdown() {
    _stopNextRoundCountdown();
    _pollNextRoundAt();
    nextRoundPollTimer = setInterval(_pollNextRoundAt, 15000);
    nextRoundTickTimer = setInterval(() => {
      const cdEl = document.getElementById("next-round-countdown");
      const noteEl = document.getElementById("next-round-note");
      if (!cdEl || !nextRoundAtIso) return;
      const diff = Math.max(0, Math.floor((new Date(nextRoundAtIso).getTime() - Date.now()) / 1000));
      cdEl.textContent = _formatCountdown(diff);
      if (diff <= 0) {
        if (noteEl) noteEl.textContent = "Starting next round...";
        _pollNextRoundAt();
        loadMarkets();
      }
    }, 1000);
  }

  async function _ensureRoundBaseline(round) {
    if (!round || !round.camera_id || roundBaseline) return;

    try {
      const opensAt = round.opens_at || new Date().toISOString();
      const { data } = await window.sb
        .from("count_snapshots")
        .select("total, vehicle_breakdown, captured_at")
        .eq("camera_id", round.camera_id)
        .lte("captured_at", opensAt)
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      roundBaseline = {
        total: Number(data?.total || 0),
        vehicle_breakdown: data?.vehicle_breakdown || {},
      };
    } catch {
      roundBaseline = { total: 0, vehicle_breakdown: {} };
    }

    _renderUserRoundBet();
  }

  async function _loadUserRoundBets() {
    const box = document.getElementById("user-round-bet");
    if (!box) return;
    if (!currentRound || !currentUserId) {
      userRoundBets = [];
      _renderUserRoundBet();
      return;
    }

    try {
      const jwt = await Auth.getJwt();
      if (!jwt) {
        userRoundBets = [];
        _renderUserRoundBet();
        return;
      }
      const qs = new URLSearchParams({
        round_id: String(currentRound.id),
        limit: "20",
      });
      const res = await fetch(`/api/bets/place?mode=my-round&${qs.toString()}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload?.detail || payload?.error || "Round bet load failed");
      }
      userRoundBets = Array.isArray(payload) ? payload : [];
      if (optimisticPendingBet?.id) {
        const matched = userRoundBets.some((b) => String(b?.id || "") === String(optimisticPendingBet.id));
        if (matched) optimisticPendingBet = null;
      }
      if (!userRoundBets.some((b) => String(b?.status || "").toLowerCase() === "pending")) {
        optimisticPendingBet = null;
      }
      await _hydrateBetBaselines(userRoundBets);
      _renderUserRoundBet();
    } catch (err) {
      console.warn("[Markets] User bet load failed:", err);
    }
  }

  async function _hydrateBetBaselines(bets) {
    if (!Array.isArray(bets) || !bets.length) return;
    if (!currentRound?.camera_id) return;

    const targets = bets.filter((b) => !!b?.placed_at);
    if (!targets.length) return;

    await Promise.all(targets.map(async (bet) => {
      try {
        const betType = String(bet?.bet_type || "market");
        const mt = String(currentRound?.market_type || "");
        const params = currentRound?.params || {};
        let vehicleClass = null;
        if (betType === "exact_count") {
          vehicleClass = bet?.vehicle_class || null;
        } else if (mt === "vehicle_count") {
          vehicleClass = params.vehicle_class || null;
        }

        const { data } = await window.sb
          .from("count_snapshots")
          .select("total, vehicle_breakdown")
          .eq("camera_id", currentRound.camera_id)
          .gt("total", 0)
          .lte("captured_at", bet.placed_at)
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!data) return;
        const derived = vehicleClass
          ? Number(data?.vehicle_breakdown?.[vehicleClass] || 0)
          : Number(data?.total || 0);
        if (Number.isFinite(derived) && derived > 0) {
          bet._derived_baseline_count = derived;
        }
      } catch {}
    }));
  }

  function _roundProgressCount() {
    if (!latestCountPayload) return null;
    if (!currentRound) return null;
    const mt = currentRound?.market_type;
    const params = currentRound?.params || {};
    const vehicleClass = mt === "vehicle_count" ? params.vehicle_class : null;
    const useRoundRelative = _shouldUseRoundRelativeCounts(currentRound);

    const currentRaw = vehicleClass
      ? Number(latestCountPayload?.vehicle_breakdown?.[vehicleClass] || 0)
      : Number(latestCountPayload?.total || 0);

    if (!useRoundRelative) {
      return Math.max(0, currentRaw);
    }

    const baselineRaw = vehicleClass
      ? Number(roundBaseline?.vehicle_breakdown?.[vehicleClass] || 0)
      : Number(roundBaseline?.total || 0);

    return Math.max(0, currentRaw - baselineRaw);
  }

  function _marketProgressCount(bet) {
    if (!latestCountPayload || !currentRound || !bet) return null;
    const mt = currentRound.market_type;
    const params = currentRound.params || {};
    const vehicleClass = mt === "vehicle_count" ? params.vehicle_class : null;
    const useRoundRelative = _shouldUseRoundRelativeCounts(currentRound);

    const currentRaw = vehicleClass
      ? Number(latestCountPayload?.vehicle_breakdown?.[vehicleClass] || 0)
      : Number(latestCountPayload?.total || 0);

    if (!useRoundRelative) return Math.max(0, currentRaw);

    const baselineDb = Number(bet?.baseline_count);
    const baselineDerived = Number(bet?._derived_baseline_count);
    const baselineFallback = Number(bet?._fallback_baseline_count);
    const betStatus = String(bet?.status || "").toLowerCase();
    let baseline = Number.isFinite(baselineDb) ? baselineDb : NaN;
    if (Number.isFinite(baselineDerived)) {
      baseline = Number.isFinite(baseline) ? Math.max(baseline, baselineDerived) : baselineDerived;
    }
    if (Number.isFinite(baselineFallback)) {
      baseline = Number.isFinite(baseline) ? Math.max(baseline, baselineFallback) : baselineFallback;
    }
    if (betStatus === "pending" && (!Number.isFinite(baseline) || baseline <= 0)) {
      // Keep UX deterministic: when backend baseline is still syncing, anchor
      // to the first seen live count so user progress starts at 0.
      bet._fallback_baseline_count = Math.max(0, currentRaw);
      baseline = Number(bet._fallback_baseline_count);
    }
    if (!Number.isFinite(baseline)) return null;

    return Math.max(0, currentRaw - baseline);
  }

  function _estimateMarketChance(selection, progress, threshold, placedAtIso) {
    if (progress == null || !Number.isFinite(threshold)) return null;
    const now = Date.now();
    const placed = placedAtIso ? new Date(placedAtIso).getTime() : now;
    const ends = currentRound?.ends_at ? new Date(currentRound.ends_at).getTime() : now;
    const elapsedMin = Math.max(0.5, (now - placed) / 60000);
    const leftMin = Math.max(0, (ends - now) / 60000);
    const rate = progress / elapsedMin;
    const projected = progress + (rate * leftMin);

    if (selection === "over") {
      if (progress > threshold) return 100;
      return Math.max(5, Math.min(95, Math.round(50 + ((projected - (threshold + 1)) * 6))));
    }
    if (selection === "under") {
      if (progress > threshold) return 0;
      return Math.max(5, Math.min(95, Math.round(50 + (((threshold - projected)) * 6))));
    }
    if (selection === "exact") {
      const distance = Math.abs(threshold - projected);
      return Math.max(1, Math.min(60, Math.round(35 - (distance * 4))));
    }
    return null;
  }

  function _liveExactProgress(bet) {
    if (!latestCountPayload || !bet) return null;
    const vehicleClass = bet.vehicle_class || null;
    const currentRaw = vehicleClass
      ? Number(latestCountPayload?.vehicle_breakdown?.[vehicleClass] || 0)
      : Number(latestCountPayload?.total || 0);
    if (!_shouldUseRoundRelativeCounts(currentRound)) {
      return Math.max(0, currentRaw);
    }
    const baselineDb = Number(bet?.baseline_count);
    const baselineDerived = Number(bet?._derived_baseline_count);
    const baselineFallback = Number(bet?._fallback_baseline_count);
    const betStatus = String(bet?.status || "").toLowerCase();
    let baseline = Number.isFinite(baselineDb) ? baselineDb : NaN;
    if (Number.isFinite(baselineDerived)) {
      baseline = Number.isFinite(baseline) ? Math.max(baseline, baselineDerived) : baselineDerived;
    }
    if (Number.isFinite(baselineFallback)) {
      baseline = Number.isFinite(baseline) ? Math.max(baseline, baselineFallback) : baselineFallback;
    }
    if (betStatus === "pending" && (!Number.isFinite(baseline) || baseline <= 0)) {
      bet._fallback_baseline_count = Math.max(0, currentRaw);
      baseline = Number(bet._fallback_baseline_count);
    }
    if (!Number.isFinite(baseline)) return null;
    return Math.max(0, currentRaw - baseline);
  }

  function _shouldUseRoundRelativeCounts(round) {
    if (!round) return false;
    const status = String(round?.status || "").toLowerCase();
    const statusAllowsRelative = status === "upcoming" || status === "open" || status === "locked";
    if (!statusAllowsRelative) return false;
    const endsAtMs = round?.ends_at ? new Date(round.ends_at).getTime() : NaN;
    if (!Number.isFinite(endsAtMs)) return statusAllowsRelative;
    // Once round end timestamp passes, UI count views should return to global.
    return Date.now() < endsAtMs;
  }

  function _marketHint(selection, progress, threshold) {
    if (progress == null || !Number.isFinite(threshold)) return "Waiting for live count...";
    if (selection === "over") {
      const need = Math.max(0, threshold + 1 - progress);
      return need === 0 ? "Over line reached." : `Need ${need} more to clear over.`;
    }
    if (selection === "under") {
      if (progress > threshold) return "Under is currently busted.";
      const left = Math.max(0, threshold - progress);
      return `${left} left before under breaks.`;
    }
    if (selection === "exact") {
      const diff = Math.abs(threshold - progress);
      return diff === 0 ? "On exact target." : `${diff} away from exact target.`;
    }
    return "Tracking round progress live.";
  }

  // ── Receipt: SVG scan art + terminal style (AI tab aesthetic) ────────────

  function _buildReceiptSkeleton(active, latestResolved) {
    if (!active) return "";
    const isExact = active.bet_type === "exact_count";
    const stake = Number(active?.amount || 0);
    const payout = Number(active?.potential_payout || 0);

    let targetLabel, targetVal;
    if (isExact) {
      const target = Number(active?.exact_count || 0);
      const cls = active?.vehicle_class || "all vehicles";
      targetLabel = "TARGET";
      targetVal = `${target} ${cls}`;
    } else {
      targetLabel = "PREDICTION";
      targetVal = active?.markets?.label || "Market bet";
    }

    const resolvedBlock = latestResolved
      ? `<div class="brc-resolved brc-${latestResolved.status}">
          <span class="brc-resolved-badge">${latestResolved.status === "won" ? "WIN" : "LOSS"}</span>
          <span class="brc-resolved-val">${latestResolved.status === "won"
            ? `+${Number(latestResolved.potential_payout || 0).toLocaleString()} cr`
            : `−${Number(latestResolved.amount || 0).toLocaleString()} cr`}</span>
        </div>`
      : "";

    return `
      <div class="bet-receipt">
        <div class="brc-art">
          <svg class="brc-scan-svg" viewBox="0 0 140 80" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 24 V10 H24" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M116 10 H130 V24" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10 56 V70 H24" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M116 70 H130 V56" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="46" y="34" width="48" height="20" rx="4" fill="rgba(34,197,94,0.07)" stroke="#22c55e" stroke-width="1" stroke-opacity="0.35"/>
            <path d="M52 34 L58 26 H82 L88 34" stroke="#22c55e" stroke-width="1" stroke-opacity="0.45" stroke-linecap="round"/>
            <circle cx="56" cy="56" r="4" fill="rgba(34,197,94,0.12)" stroke="#22c55e" stroke-width="0.8" stroke-opacity="0.4"/>
            <circle cx="84" cy="56" r="4" fill="rgba(34,197,94,0.12)" stroke="#22c55e" stroke-width="0.8" stroke-opacity="0.4"/>
            <line x1="10" y1="40" x2="130" y2="40" stroke="#22c55e" stroke-width="0.5" stroke-opacity="0.2" stroke-dasharray="3 4"/>
            <circle cx="70" cy="40" r="2.5" fill="#22c55e" fill-opacity="0.4"/>
            <text x="70" y="13" text-anchor="middle" fill="#22c55e" font-size="6" font-family="monospace" opacity="0.6" letter-spacing="1">AI SCAN</text>
          </svg>
        </div>
        <div class="brc-bar">
          <span class="brc-prompt">&gt;_</span>
          <span class="brc-label">${isExact ? "EXACT COUNT" : "MARKET BET"}</span>
          <div class="brc-status"><span class="mls-pulse"></span><span>LIVE</span></div>
        </div>
        <div class="brc-body">
          <div class="brc-row">
            <span class="brc-key">${targetLabel}</span>
            <span class="brc-val">${targetVal}</span>
          </div>
          <div class="brc-row">
            <span class="brc-key">STAKE</span>
            <span class="brc-val">${stake.toLocaleString()} cr</span>
          </div>
          <div class="brc-row">
            <span class="brc-key">WIN</span>
            <span class="brc-val brc-green">${payout.toLocaleString()} cr</span>
          </div>
          <div class="brc-row">
            <span class="brc-key">PROGRESS</span>
            <span class="brc-val" id="brc-progress">—</span>
          </div>
          <div class="brc-track-wrap">
            <div class="brc-track"><div class="brc-fill" id="brc-fill"></div></div>
          </div>
          <div id="brc-hit" class="brc-hit" style="display:none">
            <svg viewBox="0 0 16 16" fill="none" width="11" height="11" aria-hidden="true">
              <polyline points="2 8 6 12 14 4" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            TARGET REACHED — WIN PENDING
          </div>
          <div class="brc-hint" id="brc-hint">Waiting for live count...</div>
          ${active?._optimistic ? `<div class="brc-syncing">· Syncing ticket...</div>` : ""}
        </div>
        ${resolvedBlock}
      </div>
    `;
  }

  function _updateReceiptLiveValues(active) {
    if (!active) return;
    const progressEl = document.getElementById("brc-progress");
    const hintEl = document.getElementById("brc-hint");
    const fillEl = document.getElementById("brc-fill");
    const hitEl = document.getElementById("brc-hit");
    if (!progressEl) return;

    if (active.bet_type === "exact_count") {
      const live = _liveExactProgress(active);
      const target = Number(active?.exact_count || 0);
      const isHit = live != null && live >= target && target > 0;
      const pct = live == null || !target ? 0 : Math.min(100, Math.round((live / target) * 100));
      const liveText = live == null ? "—" : `${live} / ${target}`;
      const hint = live == null
        ? "Waiting for live count..."
        : isHit ? "Target reached — awaiting resolution."
        : `Need ${Math.max(0, target - live)} more to hit target.`;
      if (progressEl.textContent !== liveText) progressEl.textContent = liveText;
      if (hintEl && hintEl.textContent !== hint) hintEl.textContent = hint;
      if (fillEl) fillEl.style.width = `${pct}%`;
      if (hitEl) hitEl.style.display = isHit ? "flex" : "none";
    } else if (active.bet_type === "market") {
      const selection = String(active?.markets?.outcome_key || "").toLowerCase();
      const threshold = Number(currentRound?.params?.threshold ?? 0);
      const progress = _marketProgressCount(active);
      const pct = progress == null || !threshold ? 0 : Math.min(100, Math.round((progress / threshold) * 100));
      const isHit = selection === "over" && progress != null && progress > threshold;
      const liveText = progress == null ? "—" : `${progress.toLocaleString()} / ${threshold.toLocaleString()}`;
      const hint = _marketHint(selection, progress, threshold);
      if (progressEl.textContent !== liveText) progressEl.textContent = liveText;
      if (hintEl && hintEl.textContent !== hint) hintEl.textContent = hint;
      if (fillEl) fillEl.style.width = `${pct}%`;
      if (hitEl) hitEl.style.display = isHit ? "flex" : "none";
    }
  }

  // ── Render user bet receipt (stable skeleton + in-place live updates) ──

  function _renderUserRoundBet() {
    const box = document.getElementById("user-round-bet");
    if (!box) return;

    const pending = userRoundBets.filter((b) => b.status === "pending");
    const allPending = optimisticPendingBet ? [optimisticPendingBet, ...pending] : pending;
    const latestResolved = userRoundBets.find((b) => b.status !== "pending");

    if (latestResolved && !dismissedResolvedBetIds.has(String(latestResolved.id))) {
      latestResolvedCard = {
        bet_id: latestResolved.id,
        round_id: latestResolved.round_id || currentRound?.id || null,
        won: latestResolved.status === "won",
        payout: Number(latestResolved.potential_payout || 0),
        actual: latestResolved.actual_count,
        exact: latestResolved.exact_count,
        vehicle_class: latestResolved.vehicle_class || null,
        amount: Number(latestResolved.amount || 0),
        market_label: latestResolved?.markets?.label || null,
        status: latestResolved.status,
      };
      _persistResolvedCard();
      _renderResolvedOutcomeCard();
    }

    if (!allPending.length && !latestResolved) {
      box.classList.add("hidden");
      if (box.innerHTML) box.innerHTML = "";
      _receiptSkeletonBetKey = null;
      lastUserBetMarkup = "";
      return;
    }

    const active = allPending[0] || null;
    // Stable key: only rebuild skeleton when the active bet itself changes.
    const betKey = active ? `${active.id}:${active.bet_type}` : "resolved-only";
    if (betKey !== _receiptSkeletonBetKey) {
      _receiptSkeletonBetKey = betKey;
      box.innerHTML = _buildReceiptSkeleton(active, latestResolved);
    }
    box.classList.remove("hidden");
    _updateReceiptLiveValues(active);
  }

  function init() {
    _loadRoundGuidePref();
    initTabs();
    loadMarkets();

    setInterval(loadMarkets, 60000);

    window.addEventListener("round:update", (e) => {
      if (e.detail) {
        if (e.detail.id !== lastRoundId) {
          lastRoundId = e.detail.id;
          loadMarkets();
        }
      } else {
        lastRoundId = null;
        renderNoRound();
      }
    });

    window.addEventListener("count:update", (e) => {
      latestCountPayload = e.detail || null;
      _renderUserRoundBet();
    });

    window.addEventListener("bet:placed", (e) => {
      const d = e?.detail || {};
      let optimisticBaseline = null;
      try {
        if (latestCountPayload && currentRound) {
          if (d.bet_type === "exact_count") {
            const cls = d.vehicle_class || null;
            optimisticBaseline = cls
              ? Number(latestCountPayload?.vehicle_breakdown?.[cls] || 0)
              : Number(latestCountPayload?.total || 0);
          } else {
            const mt = String(currentRound?.market_type || "");
            const cls = mt === "vehicle_count" ? currentRound?.params?.vehicle_class : null;
            optimisticBaseline = cls
              ? Number(latestCountPayload?.vehicle_breakdown?.[cls] || 0)
              : Number(latestCountPayload?.total || 0);
          }
          if (!Number.isFinite(optimisticBaseline)) optimisticBaseline = null;
        }
      } catch {
        optimisticBaseline = null;
      }
      optimisticPendingBet = {
        id: String(d.bet_id || `temp-${Date.now()}`),
        round_id: d.round_id || currentRound?.id || null,
        bet_type: d.bet_type || "market",
        status: "pending",
        amount: Number(d.amount || 0),
        potential_payout: Number(d.potential_payout || 0),
        exact_count: d.exact_count ?? null,
        actual_count: null,
        vehicle_class: d.vehicle_class || null,
        window_duration_sec: Number(d.window_duration_sec || 0) || null,
        window_start: new Date().toISOString(),
        baseline_count: optimisticBaseline,
        placed_at: new Date().toISOString(),
        resolved_at: null,
        markets: d.bet_type === "market"
          ? {
              label: d.market_label || "Market bet",
              odds: Number(d.market_odds || 0) || 0,
              outcome_key: null,
            }
          : null,
        _optimistic: true,
      };
      _renderUserRoundBet();
      _loadUserRoundBets();
    });

    window.addEventListener("bet:resolved", () => {
      _loadUserRoundBets();
    });

    window.addEventListener("bet:resolved", (e) => {
      const d = e.detail || {};
      if (d.bet_id && dismissedResolvedBetIds.has(String(d.bet_id))) return;
      latestResolvedCard = {
        bet_id: d.bet_id,
        round_id: d.round_id || currentRound?.id || null,
        won: !!d.won,
        payout: Number(d.payout || 0),
        actual: d.actual,
        exact: d.exact,
        vehicle_class: d.vehicle_class || null,
        amount: Number(d.amount || 0),
        market_label: d.market_label || null,
        status: d.won ? "won" : "lost",
      };
      _persistResolvedCard();
      _renderResolvedOutcomeCard();
    });

    const container = document.getElementById("markets-container");
    if (container) {
      container.addEventListener("click", (e) => {
        const target = e.target.closest(".btn-bet, .market-card");
        if (!target) return;
        const card = target.closest(".market-card");
        if (!card) return;
        if (card.dataset.canBet !== "1") return;
        Bet.openModal(
          card.dataset.marketId,
          card.dataset.label,
          parseFloat(card.dataset.odds)
        );
      });
    }

    document.getElementById("tab-markets")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-dismiss-resolved]");
      if (!btn) return;
      const id = String(btn.getAttribute("data-dismiss-resolved") || "");
      if (id) {
        dismissedResolvedBetIds.add(id);
        _persistDismissedResolved();
      }
      _clearResolvedOutcomeCard();
    });

    _loadPersistedResolvedCard();
    _renderResolvedOutcomeCard();
  }

  function _clearResolvedOutcomeCard() {
    latestResolvedCard = null;
    _persistResolvedCard();
    const card = document.getElementById("round-result-card");
    if (card) card.remove();
  }

  function _renderResolvedOutcomeCard() {
    const tab = document.getElementById("tab-markets");
    if (!tab || !latestResolvedCard || !latestResolvedCard.bet_id) return;
    if (dismissedResolvedBetIds.has(String(latestResolvedCard.bet_id))) return;

    const existing = document.getElementById("round-result-card");
    if (existing) existing.remove();

    const card = document.createElement("div");
    card.id = "round-result-card";
    card.className = `round-result-card ${latestResolvedCard.won ? "result-win" : "result-loss"}`;

    const isWin = latestResolvedCard.won;
    const subtitle = latestResolvedCard.market_label
      ? latestResolvedCard.market_label
      : `Exact ${latestResolvedCard.exact ?? "?"}${latestResolvedCard.vehicle_class ? ` · ${latestResolvedCard.vehicle_class}` : ""}`;
    const payoutVal = isWin
      ? `+${Number(latestResolvedCard.payout || 0).toLocaleString()} cr`
      : `−${Number(latestResolvedCard.amount || 0).toLocaleString()} cr`;
    const winColor = isWin ? "#22c55e" : "#ef4444";
    const cornerStroke = isWin ? "#22c55e" : "#ef4444";

    card.innerHTML = `
      <div class="rrc-art">
        <svg viewBox="0 0 120 54" fill="none" class="rrc-svg">
          <path d="M8 18 V8 H18" stroke="${cornerStroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M102 8 H112 V18" stroke="${cornerStroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M8 36 V46 H18" stroke="${cornerStroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M102 46 H112 V36" stroke="${cornerStroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <text x="60" y="29" text-anchor="middle" fill="${winColor}" font-size="14" font-weight="800" font-family="monospace" letter-spacing="3">${isWin ? "WIN" : "LOSS"}</text>
          <text x="60" y="40" text-anchor="middle" fill="${winColor}" font-size="5.5" font-family="monospace" opacity="0.65" letter-spacing="0.5">${payoutVal}</text>
        </svg>
      </div>
      <div class="rrc-bar">
        <span class="rrc-sub">${subtitle}</span>
        <button class="rrc-close" type="button" data-dismiss-resolved="${latestResolvedCard.bet_id}" aria-label="Dismiss">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l8 8M9 1l-8 8"/></svg>
        </button>
      </div>
      <div class="rrc-body">
        <div class="rrc-row"><span>ACTUAL</span><strong>${latestResolvedCard.actual ?? "—"}</strong></div>
        <div class="rrc-row"><span>TARGET</span><strong>${latestResolvedCard.exact ?? "—"}</strong></div>
      </div>
    `;

    const container = document.getElementById("markets-container");
    if (container) tab.insertBefore(card, container);
    else tab.prepend(card);
  }

  return { init, loadMarkets, getCurrentRound: () => currentRound, enterRound: _enterRound };
})();

window.Markets = Markets;
