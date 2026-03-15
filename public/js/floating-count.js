/**
 * floating-count.js — Floating count widget on the video stream.
 *
 * NORMAL MODE: shows global total.
 * GUESS MODE: hides global total; shows X/Y progress toward the user's guess,
 *   with a colour-coded bar (green → yellow → red as it approaches/exceeds target).
 */

const FloatingCount = (() => {
  let _wrapper      = null;
  let _lastTotal    = 0;
  let _guessBaseline = null;   // total at moment guess was placed
  let _guessTarget   = null;   // user's guessed count

  function init(streamWrapper) {
    _wrapper = streamWrapper;

    window.addEventListener("count:update", (e) => update(e.detail));

    // Enter guess mode when a guess is submitted.
    window.addEventListener("bet:placed", (e) => {
      const detail = e.detail || {};
      _guessTarget   = detail.exact_count ?? null;
      _guessBaseline = _lastTotal;
      _enterGuessMode();
    });

    // Return to normal mode when result comes back.
    window.addEventListener("bet:resolved", _exitGuessMode);
  }

  // ── Mode switches ─────────────────────────────────────────────

  function _enterGuessMode() {
    document.getElementById("cw-normal")?.classList.add("hidden");
    const gm = document.getElementById("cw-guess-mode");
    if (gm) gm.classList.remove("hidden");

    const targetEl = document.getElementById("cw-gm-target");
    if (targetEl) targetEl.textContent = _guessTarget ?? "—";

    _setGuessProgress(0);
  }

  function _exitGuessMode() {
    _guessBaseline = null;
    _guessTarget   = null;
    document.getElementById("cw-normal")?.classList.remove("hidden");
    document.getElementById("cw-guess-mode")?.classList.add("hidden");
  }

  function _setGuessProgress(sinceGuess) {
    const currentEl = document.getElementById("cw-gm-current");
    const barEl     = document.getElementById("cw-gm-bar");
    if (currentEl) currentEl.textContent = sinceGuess;
    if (barEl && _guessTarget > 0) {
      const pct = Math.min(100, (sinceGuess / _guessTarget) * 100);
      barEl.style.width = pct + "%";
      barEl.style.background =
        pct >= 100 ? "#ef4444" :   // red — overshot
        pct >= 80  ? "#eab308" :   // yellow — getting close
                     "#22c55e";    // green — on track
    }
  }

  // ── Count update ──────────────────────────────────────────────

  function update(data) {
    const total    = data.total ?? 0;
    const bd       = data.vehicle_breakdown ?? {};
    const crossings = data.new_crossings ?? 0;

    _lastTotal = total;
    window._lastCountPayload = data;

    const totalEl  = document.getElementById("cw-total");
    const carsEl   = document.getElementById("cw-cars");
    const trucksEl = document.getElementById("cw-trucks");
    const busesEl  = document.getElementById("cw-buses");
    const motosEl  = document.getElementById("cw-motos");

    if (totalEl)  totalEl.textContent  = total.toLocaleString();
    if (carsEl)   carsEl.textContent   = bd.car        ?? 0;
    if (trucksEl) trucksEl.textContent = bd.truck      ?? 0;
    if (busesEl)  busesEl.textContent  = bd.bus        ?? 0;
    if (motosEl)  motosEl.textContent  = bd.motorcycle ?? 0;

    // Update guess-mode progress bar if active
    if (_guessBaseline !== null && _guessTarget !== null) {
      const sinceGuess = Math.max(0, total - _guessBaseline);
      _setGuessProgress(sinceGuess);
    }

    if (crossings > 0) spawnPop(crossings);
  }

  function setStatus(ok) {
    const dot = document.getElementById("cw-ws-dot");
    if (!dot) return;
    dot.className = ok ? "cw-ws-dot cw-ws-ok" : "cw-ws-dot cw-ws-err";
  }

  function spawnPop(n) {
    if (!_wrapper) return;
    const el = document.createElement("div");
    el.className = "count-pop";
    el.textContent = "+" + n;

    const widget = document.getElementById("count-widget");
    if (widget) {
      const rect  = widget.getBoundingClientRect();
      const wRect = _wrapper.getBoundingClientRect();
      el.style.left = (rect.left - wRect.left + rect.width / 2) + "px";
      el.style.top  = (rect.top  - wRect.top  - 10) + "px";
    } else {
      el.style.left   = "80px";
      el.style.bottom = "60px";
    }

    _wrapper.appendChild(el);
    setTimeout(() => el.remove(), 1050);
  }

  return { init, update, setStatus };
})();

window.FloatingCount = FloatingCount;
