/**
 * ml-showcase.js - Live ML showcase panel for public users.
 * Uses real stream events + Supabase telemetry to visualize model activity.
 */

const MlShowcase = (() => {
  const escHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const state = {
    startedAt: Date.now(),
    frames: 0,
    objects: 0,
    confSum: 0,
    confCount: 0,
    rows24h: 0,
    modelName: "-",
    lastSeenIso: "",
    streamItems: [],
    fallbackItems: [],
    seededFromTelemetry: false,
    lifetimeTotal: 0,
    lifetimeBreakdown: {},
  };

  let _bound = false;
  let _pollTimer = null;

  function init() {
    if (_bound) return;
    _bound = true;
    state.startedAt = Date.now();

    window.addEventListener("count:update", (e) => onCountUpdate(e.detail || {}));
    pollTelemetry();
    _pollTimer = setInterval(pollTelemetry, 20000);
    render();
  }

  function destroy() {
    clearInterval(_pollTimer);
    _pollTimer = null;
    _bound = false;
  }

  function onCountUpdate(payload) {
    const detections = Array.isArray(payload?.detections) ? payload.detections : [];
    const breakdown = payload?.vehicle_breakdown || {};
    state.frames += 1;
    state.objects += detections.length;
    state.lastSeenIso = new Date().toISOString();

    // Track lifetime totals (cumulative from backend counter, survives redeploys)
    const payloadTotal = Number(payload?.total ?? 0);
    if (payloadTotal > state.lifetimeTotal) {
      state.lifetimeTotal = payloadTotal;
      state.lifetimeBreakdown = { ...breakdown };
    }

    for (const d of detections) {
      const c = Number(d?.conf);
      if (Number.isFinite(c) && c >= 0 && c <= 1) {
        state.confSum += c;
        state.confCount += 1;
      }
    }
    const sample = {
      captured_at: new Date().toISOString(),
      detections_count: detections.length,
      avg_confidence: detections.length
        ? detections.reduce((s, d) => s + (Number(d?.conf) || 0), 0) / detections.length
        : null,
      model_name: "live",
      breakdown,
    };
    state.fallbackItems.unshift(sample);
    state.fallbackItems = state.fallbackItems.slice(0, 12);
    render();
  }

  async function pollTelemetry() {
    try {
      const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
      const [rows24Resp, recentResp, healthResp] = await Promise.all([
        window.sb
          .from("ml_detection_events")
          .select("id", { count: "exact", head: true })
          .gte("captured_at", since24h),
        window.sb
          .from("ml_detection_events")
          .select("captured_at, detections_count, avg_confidence, model_name")
          .order("captured_at", { ascending: false })
          .limit(12),
        fetch("/api/health"),
      ]);

      state.rows24h = Number(rows24Resp?.count || 0);

      const recent = recentResp?.data || [];
      if (recent.length > 0) {
        state.lastSeenIso = recent[0].captured_at || "";
        state.modelName = recent[0].model_name || state.modelName || "-";
      }
      if (!state.seededFromTelemetry && recent.length > 0) {
        let detCount = 0;
        let confWeighted = 0;
        for (const row of recent) {
          const d = Number(row?.detections_count || 0);
          const c = Number(row?.avg_confidence);
          if (Number.isFinite(d) && d > 0) {
            detCount += d;
            if (Number.isFinite(c) && c >= 0 && c <= 1) {
              confWeighted += c * d;
            }
          }
        }
        if (detCount > 0) {
          state.objects += detCount;
          state.confSum += confWeighted;
          state.confCount += detCount;
        }
        state.frames += recent.length;
        state.seededFromTelemetry = true;
      }
      state.streamItems = recent;

      if (healthResp.ok) {
        const health = await healthResp.json();
        if (health?.ml_retrain_task_running) {
          state.modelName = `${state.modelName} (retraining)`;
        }
        // Seed lifetime totals from latest snapshot if higher than current
        const snap = health?.latest_snapshot;
        if (snap) {
          const snapTotal = Number(snap.total ?? 0);
          if (snapTotal > state.lifetimeTotal) {
            state.lifetimeTotal = snapTotal;
            state.lifetimeBreakdown = { ...(snap.vehicle_breakdown || {}) };
          }
        }
      }
    } catch {
      // Keep previous values and fallback to live stream-only mode.
    }
    render();
  }

  function avgConf() {
    if (!state.confCount) return null;
    return state.confSum / state.confCount;
  }

  function objectsPerMinute() {
    const elapsedMin = Math.max(1 / 6, (Date.now() - state.startedAt) / 60000);
    return state.objects / elapsedMin;
  }

  function framesPerMinute() {
    const elapsedMin = Math.max(1 / 6, (Date.now() - state.startedAt) / 60000);
    return state.frames / elapsedMin;
  }

  function ago(iso) {
    if (!iso) return "No telemetry yet";
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "just now";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  function render() {
    const objectsEl = document.getElementById("mls-live-objects");
    const rateEl = document.getElementById("mls-live-rate");
    const rowsEl = document.getElementById("mls-rows-24h");
    const modelEl = document.getElementById("mls-model-name");
    const lastSeenEl = document.getElementById("mls-last-seen");
    const streamEl = document.getElementById("mls-stream-list");

    if (!objectsEl || !rateEl || !rowsEl || !modelEl || !lastSeenEl || !streamEl) return;

    const rate = objectsPerMinute();

    objectsEl.textContent = state.objects.toLocaleString();
    rateEl.textContent = `${rate.toFixed(1)} objects/min`;
    rowsEl.textContent = state.rows24h.toLocaleString();
    modelEl.textContent = `Model: ${state.modelName || "-"}`;
    lastSeenEl.textContent = `Last telemetry ${ago(state.lastSeenIso)}`;

    // Lifetime totals
    const ltTotal = document.getElementById("mls-lifetime-total");
    const ltCar   = document.getElementById("mls-lt-car");
    const ltTruck = document.getElementById("mls-lt-truck");
    const ltBus   = document.getElementById("mls-lt-bus");
    const ltMoto  = document.getElementById("mls-lt-moto");
    const bd = state.lifetimeBreakdown;
    if (ltTotal) ltTotal.textContent = state.lifetimeTotal > 0 ? state.lifetimeTotal.toLocaleString() : "—";
    if (ltCar)   ltCar.textContent   = state.lifetimeTotal > 0 ? (Number(bd.car        ?? 0)).toLocaleString() : "—";
    if (ltTruck) ltTruck.textContent = state.lifetimeTotal > 0 ? (Number(bd.truck      ?? 0)).toLocaleString() : "—";
    if (ltBus)   ltBus.textContent   = state.lifetimeTotal > 0 ? (Number(bd.bus        ?? 0)).toLocaleString() : "—";
    if (ltMoto)  ltMoto.textContent  = state.lifetimeTotal > 0 ? (Number(bd.motorcycle ?? 0)).toLocaleString() : "—";

    const items = state.streamItems.length ? state.streamItems : state.fallbackItems;
    if (!items.length) {
      streamEl.innerHTML = `<p class="loading">Collecting live AI events...</p>`;
      return;
    }

    const liveFrameRate = framesPerMinute();
    streamEl.innerHTML = items.map((r) => {
      const det = Number(r.detections_count || 0);
      const c = Number(r.avg_confidence || 0);
      const rawModel = String(r.model_name || "live");
      const model = escHtml(rawModel);
      const b = r.breakdown || {};
      const detail = [Number(b.car || 0), Number(b.truck || 0), Number(b.bus || 0), Number(b.motorcycle || 0)]
        .some((v) => v > 0)
        ? ` | C:${Number(b.car || 0)} T:${Number(b.truck || 0)} B:${Number(b.bus || 0)} M:${Number(b.motorcycle || 0)}`
        : "";
      return `
        <div class="mls-item">
          <span class="mls-item-main">${model} | ${det} detections | ${Number.isFinite(c) && c > 0 ? `${(c * 100).toFixed(1)}% conf` : "conf n/a"}${detail}${rawModel === "live" ? ` | ${liveFrameRate.toFixed(1)} frames/min` : ""}</span>
          <span class="mls-item-meta">${escHtml(ago(r.captured_at))}</span>
        </div>
      `;
    }).join("");
  }

  return { init, destroy };
})();

window.MlShowcase = MlShowcase;
