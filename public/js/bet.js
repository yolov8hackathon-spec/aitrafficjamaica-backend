/**
 * bet.js — Market bet modal (existing rounds with markets).
 * Coexists with live-bet.js (exact-count micro-bets).
 */

const Bet = (() => {
  let _marketId = null;
  let _odds = null;
  let _marketLabel = "";

  function openModal(marketId, label, odds) {
    _marketId = marketId;
    _odds = odds;
    _marketLabel = String(label || "");

    const round = Markets.getCurrentRound();
    if (!round) return;

    // Build a lightweight inline modal
    _removeExisting();

    const box = document.createElement("div");
    box.id = "bet-modal-inline";
    box.className = "modal";
    box.setAttribute("role", "dialog");
    box.innerHTML = `
      <div class="modal-backdrop" id="bmi-backdrop"></div>
      <div class="modal-box">
        <button class="modal-close" id="bmi-close" aria-label="Close">✕</button>
        <h3>Place Your Guess</h3>
        <p class="modal-label">Your guess: ${esc(label)}</p>
        <p class="modal-label">Quick rule: payout = stake x odds rate.</p>
        <div class="modal-row">
          <span>Payout rate</span>
          <strong>${parseFloat(odds).toFixed(2)}x</strong>
        </div>
        <div class="modal-row">
          <label for="bmi-amount">Amount (credits)</label>
          <input id="bmi-amount" type="number" min="1" placeholder="e.g. 100" />
        </div>
        <div class="modal-row">
          <span>If this wins</span>
          <strong id="bmi-payout">—</strong>
        </div>
        <div id="bmi-loading" class="modal-loading hidden" aria-live="polite">
          <span class="modal-spinner" aria-hidden="true"></span>
          <span>Checking and creating ticket...</span>
        </div>
        <p id="bmi-error" class="modal-error" role="alert"></p>
        <button id="bmi-submit" class="btn-primary btn-full">Place Bet Ticket</button>
      </div>
    `;
    document.body.appendChild(box);

    document.getElementById("bmi-backdrop")?.addEventListener("click", closeModal);
    document.getElementById("bmi-close")?.addEventListener("click", closeModal);
    document.getElementById("bmi-amount")?.addEventListener("input", _updatePayout);
    document.getElementById("bmi-submit")?.addEventListener("click", submit);

    document.getElementById("bmi-amount")?.focus();
  }

  function closeModal() {
    _removeExisting();
    _marketId = null;
    _odds = null;
    _marketLabel = "";
  }

  function _removeExisting() {
    document.getElementById("bet-modal-inline")?.remove();
  }

  function _updatePayout() {
    const amount = parseInt(document.getElementById("bmi-amount")?.value ?? 0, 10);
    const el = document.getElementById("bmi-payout");
    if (!el) return;
    el.textContent = (amount > 0 && _odds) ? Math.floor(amount * _odds).toLocaleString() : "—";
  }

  async function submit() {
    const amountEl = document.getElementById("bmi-amount");
    const errorEl = document.getElementById("bmi-error");
    const submitBtn = document.getElementById("bmi-submit");
    const loadingEl = document.getElementById("bmi-loading");

    const amount = parseInt(amountEl?.value ?? 0, 10);
    const round = Markets.getCurrentRound();

    if (!amount || amount <= 0) {
      if (errorEl) errorEl.textContent = "Enter a valid amount";
      return;
    }
    if (!round) {
      if (errorEl) errorEl.textContent = "No active round";
      return;
    }
    if (String(round.status || "").toLowerCase() !== "open") {
      if (errorEl) errorEl.textContent = `Round is ${String(round.status || "closed")}. Betting is closed.`;
      return;
    }
    if (round.closes_at) {
      const closesAt = new Date(round.closes_at).getTime();
      if (Number.isFinite(closesAt) && Date.now() >= closesAt) {
        if (errorEl) errorEl.textContent = "Betting window has closed.";
        return;
      }
    }

    let jwt = await Auth.getJwt();
    if (!jwt) {
      if (submitBtn) submitBtn.disabled = true;
      if (errorEl) errorEl.textContent = "Starting guest session…";
      try {
        jwt = await Auth.signInAnon();
        if (!jwt) throw new Error("Guest session failed");
        window.dispatchEvent(new CustomEvent("session:guest"));
      } catch (e) {
        if (errorEl) errorEl.textContent = e.message || "Login required to place a bet";
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
    }

    if (submitBtn) submitBtn.disabled = true;
    if (errorEl) errorEl.textContent = "";
    if (loadingEl) loadingEl.classList.remove("hidden");
    if (submitBtn) submitBtn.textContent = "Validating...";

    try {
      const res = await fetch("/api/bets/place", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          round_id: round.id,
          market_id: _marketId,
          amount,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (errorEl) errorEl.textContent = data.detail || "Bet failed";
        return;
      }

      const placedMarketId = _marketId;
      const placedOdds = _odds;
      const placedLabel = _marketLabel;
      closeModal();
      window.dispatchEvent(new CustomEvent("bet:placed", {
        detail: {
          ...data,
          bet_type: "market",
          market_id: placedMarketId,
          market_label: placedLabel,
          market_odds: placedOdds,
          round_id: round.id,
        },
      }));
      _showToast(`Ticket placed. Potential return: ${data.potential_payout.toLocaleString()} credits`);
    } catch (e) {
      if (errorEl) errorEl.textContent = "Network error - try again";
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (submitBtn) submitBtn.textContent = "Place Bet Ticket";
      if (loadingEl) loadingEl.classList.add("hidden");
    }
  }

  function _showToast(msg) {
    const el = document.createElement("div");
    el.className = "toast toast-info";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function esc(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  return { openModal, closeModal };
})();

window.Bet = Bet;

/* Minimal modal styles for dynamic modal */
(function () {
  const s = document.createElement("style");
  s.textContent = `
    .modal { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; }
    .modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.7); }
    .modal-box { position: relative; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 28px; width: 100%; max-width: 380px; box-shadow: var(--shadow); z-index: 1; }
    .modal-close { position: absolute; top: 14px; right: 16px; background: transparent; color: var(--muted); font-size: 1.1rem; }
    .modal-close:hover { color: var(--text); }
    .modal-box h3 { font-size: 1.2rem; margin-bottom: 16px; }
    .modal-label { color: var(--muted); font-size: 0.9rem; margin-bottom: 12px; }
    .modal-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; font-size: 0.9rem; color: var(--muted); }
    .modal-row strong { color: var(--text); font-size: 1rem; }
    .modal-row input { background: var(--bg3); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: var(--radius); font-size: 0.95rem; width: 120px; text-align: right; }
    .modal-loading { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:0.85rem; margin-bottom:10px; }
    .modal-loading.hidden { display:none; }
    .modal-spinner { width:14px; height:14px; border-radius:50%; border:2px solid rgba(255,255,255,0.2); border-top-color: var(--accent); animation: modalSpin .8s linear infinite; }
    @keyframes modalSpin { to { transform: rotate(360deg); } }
    .modal-error { color: var(--red); font-size: 0.85rem; margin-bottom: 10px; min-height: 20px; }
  `;
  document.head.appendChild(s);
})();
