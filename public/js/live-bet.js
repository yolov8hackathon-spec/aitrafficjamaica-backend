/**
 * live-bet.js — Exact-count micro-bet panel logic.
 * Works with the bet-panel in the sidebar.
 */

const LiveBet = (() => {
  let _round = null;
  let _vehicleClass = "";    // "" = all
  let _windowSec = 60;
  let _countdownTimer = null;
  let _wsAccountRef = null;  // set by index-init

  function _ensureSpinnerStyle() {
    if (document.getElementById("live-bet-spinner-style")) return;
    const style = document.createElement("style");
    style.id = "live-bet-spinner-style";
    style.textContent = `
      .wlz-inline-spinner {
        display: inline-block;
        width: 12px;
        height: 12px;
        margin-right: 6px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.25);
        border-top-color: currentColor;
        animation: wlzSpin .8s linear infinite;
        vertical-align: -2px;
      }
      @keyframes wlzSpin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  // ── Open / close panel ────────────────────────────────────────────

  function open(round) {
    _round = round;

    const panel = document.getElementById("bet-panel");
    if (!panel) return;

    // Reset form
    document.getElementById("bp-error").textContent = "";
    document.getElementById("bp-count").value = "5";
    _hideBpActiveBet();

    // Reset pills
    _setPill("bp-vehicle-pills", "");
    _setPill("bp-window-pills", "60");

    panel.classList.remove("hidden");
    requestAnimationFrame(() => panel.classList.add("visible"));
  }

  function close() {
    const panel = document.getElementById("bet-panel");
    if (!panel) return;
    panel.classList.remove("visible");
    setTimeout(() => panel.classList.add("hidden"), 260);
  }

  // ── Pill selection ────────────────────────────────────────────────

  function _setPill(groupId, val) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll(".pill").forEach(p => {
      p.classList.toggle("active", p.dataset.val === val);
    });
  }

  // ── Submit ────────────────────────────────────────────────────────

  async function submit() {
    const errorEl = document.getElementById("bp-error");
    const submitBtn = document.getElementById("bp-submit");
    errorEl.textContent = "";

    const amount = 10;
    const exact = parseInt(document.getElementById("bp-count")?.value ?? 0, 10);

    if (!_round) { errorEl.textContent = "No active round"; return; }
    if (isNaN(exact) || exact < 0) { errorEl.textContent = "Enter a valid count"; return; }
    if (String(_round.status || "").toLowerCase() !== "open") { errorEl.textContent = "Round is not open for guesses"; return; }
    if (_round.closes_at) {
      const closesAt = new Date(_round.closes_at).getTime();
      if (Number.isFinite(closesAt) && Date.now() >= closesAt) {
        errorEl.textContent = "Guess window has closed";
        return;
      }
    }
    if (_round.ends_at) {
      const endsAt = new Date(_round.ends_at).getTime();
      if (Number.isFinite(endsAt) && (Date.now() + (_windowSec * 1000)) > endsAt) {
        errorEl.textContent = "Selected window extends past match end";
        return;
      }
    }

    let jwt = await Auth.getJwt();
    if (!jwt) {
      submitBtn.disabled = true;
      errorEl.textContent = "Starting guest session…";
      try {
        jwt = await Auth.signInAnon();
        if (!jwt) throw new Error("Guest session failed");
        window.dispatchEvent(new CustomEvent("session:guest"));
      } catch (e) {
        errorEl.textContent = e.message || "Login required to submit a guess";
        submitBtn.disabled = false;
        return;
      }
    }

    if (submitBtn && !submitBtn.dataset.defaultHtml) {
      submitBtn.dataset.defaultHtml = submitBtn.innerHTML;
    }
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="wlz-inline-spinner" aria-hidden="true"></span>Submitting...`;
    errorEl.textContent = "";

    try {
      const res = await fetch("/api/bets/place?live=1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          round_id: _round.id,
          window_duration_sec: _windowSec,
          vehicle_class: _vehicleClass || null,
          exact_count: exact,
          amount,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.detail || "Submission failed";
        return;
      }

      // Show countdown + receipt
      _showBpActiveBet(data.window_end, exact);
      window.dispatchEvent(new CustomEvent("bet:placed", {
        detail: {
          ...data,
          bet_type: "exact_count",
          round_id: _round?.id || null,
          window_duration_sec: _windowSec,
          vehicle_class: _vehicleClass || null,
          exact_count: exact,
        },
      }));

    } catch (e) {
      errorEl.textContent = "Network error — try again";
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = submitBtn.dataset.defaultHtml || "Submit Guess";
    }
  }

  function _showBpActiveBet(windowEndIso, guessCount) {
    const activeEl  = document.getElementById("bp-active-bet");
    const cdEl      = document.getElementById("bp-countdown");
    const hintEl    = document.getElementById("bp-active-hint");
    const submitBtn = document.getElementById("bp-submit");
    if (!activeEl || !cdEl) return;

    // Receipt fields
    const receiptGuessEl = document.getElementById("bpa-receipt-guess");
    if (receiptGuessEl) receiptGuessEl.textContent = guessCount ?? "—";

    const winTagEl = document.getElementById("bpa-window-tag");
    if (winTagEl) {
      const labels = { 60: "1 MIN", 180: "3 MIN", 300: "5 MIN" };
      winTagEl.textContent = labels[_windowSec] || `${Math.round(_windowSec / 60)} MIN`;
    }

    activeEl.classList.remove("hidden");
    submitBtn.classList.add("hidden");

    const endTime = new Date(windowEndIso).getTime();

    clearInterval(_countdownTimer);
    _countdownTimer = setInterval(() => {
      const diffRaw = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
      const m = Math.floor(diffRaw / 60).toString().padStart(2, "0");
      const s = (diffRaw % 60).toString().padStart(2, "0");
      cdEl.textContent = `${m}:${s}`;
      if (diffRaw === 0) {
        clearInterval(_countdownTimer);
        cdEl.textContent = "00:00";
        if (hintEl) hintEl.textContent = "Calculating your score...";
      }
    }, 200);
  }

  function _hideBpActiveBet() {
    clearInterval(_countdownTimer);
    document.getElementById("bp-active-bet")?.classList.add("hidden");
    document.getElementById("bp-submit")?.classList.remove("hidden");
  }

  // ── Handle ws_account bet_resolved event ─────────────────────────

  function onBetResolved(data) {
    _hideBpActiveBet();
    if (data.won) {
      _showToast(`WIN! +${data.payout.toLocaleString()} pts — count was ${data.actual} (you guessed: ${data.exact})`, "win");
    } else {
      _showToast(`MISS — count was ${data.actual}, you guessed ${data.exact}`, "loss");
    }
  }

  function _showToast(msg, type = "info") {
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ── Init ──────────────────────────────────────────────────────────

  function init() {
    _ensureSpinnerStyle();
    // Back button
    document.getElementById("bet-panel-back")?.addEventListener("click", close);

    // Window pill selection
    document.getElementById("bp-window-pills")?.addEventListener("click", (e) => {
      const pill = e.target.closest(".pill");
      if (!pill) return;
      _windowSec = parseInt(pill.dataset.val, 10);
      _setPill("bp-window-pills", pill.dataset.val);
    });

    // Count adjusters
    document.getElementById("bp-count-minus")?.addEventListener("click", () => {
      const el = document.getElementById("bp-count");
      if (el) el.value = Math.max(0, parseInt(el.value || 0, 10) - 1);
    });
    document.getElementById("bp-count-plus")?.addEventListener("click", () => {
      const el = document.getElementById("bp-count");
      if (el) el.value = Math.min(10000, parseInt(el.value || 0, 10) + 1);
    });

    // Submit
    document.getElementById("bp-submit")?.addEventListener("click", submit);
  }

  return { init, open, close, onBetResolved, setRound: (r) => { _round = r; } };
})();

window.LiveBet = LiveBet;
