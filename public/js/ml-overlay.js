/**
 * ml-overlay.js - Live vision status overlay for the public stream.
 * Uses count:update payloads + scene inference for user-friendly status text.
 */

const MlOverlay = (() => {
  const state = {
    startedAt: Date.now(),
    frames: 0,
    detections: 0,
    confSum: 0,
    confCount: 0,
    modelLoop: "unknown",
    seededFromTelemetry: false,
    runtimeProfile: "",
    runtimeReason: "",
    lastCaptureTsMs: null,
    sceneLighting: "unknown",
    sceneWeather: "unknown",
    sceneConfidence: 0,
    liveObjectsNow: 0,
    detRatePerMin: 0,
    crossingRatePerMin: 0,
    lastTickMs: null,
    lastCrossingTotal: null,
  };

  let _bound = false;
  let _pollTimer = null;
  let _titleTimer = null;
  let _titleIndex = 0;

  function init() {
    if (_bound) return;
    _bound = true;
    state.startedAt = Date.now();

    window.addEventListener("count:update", (e) => updateFromCount(e.detail || {}));
    seedFromTelemetry();
    pollHealth();
    _pollTimer = setInterval(pollHealth, 20000);
    render();
  }

  async function seedFromTelemetry() {
    if (state.seededFromTelemetry) return;
    if (!window.sb?.from) return;
    try {
      const since = new Date(Date.now() - 30 * 60_000).toISOString();
      const { data } = await window.sb
        .from("ml_detection_events")
        .select("avg_confidence,detections_count")
        .gte("captured_at", since)
        .order("captured_at", { ascending: false })
        .limit(120);
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return;

      let detCount = 0;
      let confWeighted = 0;
      for (const row of rows) {
        const d = Number(row?.detections_count || 0);
        const c = Number(row?.avg_confidence);
        if (Number.isFinite(d) && d > 0 && Number.isFinite(c) && c >= 0 && c <= 1) {
          detCount += d;
          confWeighted += c * d;
        }
      }
      if (detCount > 0) {
        state.confSum += confWeighted;
        state.confCount += detCount;
        state.detections += detCount;
      }
      state.frames += rows.length;
      state.seededFromTelemetry = true;
      render();
    } catch {
      // Keep live-only mode if telemetry query fails.
    }
  }

  function updateFromCount(data) {
    const nowMs = Date.now();
    const dtMin = state.lastTickMs ? Math.max(1 / 1200, (nowMs - state.lastTickMs) / 60000) : null;
    state.lastTickMs = nowMs;

    state.frames += 1;
    const dets = Array.isArray(data?.detections) ? data.detections : [];
    state.detections += dets.length;
    if (dtMin != null) {
      const instDetRate = dets.length / dtMin;
      state.detRatePerMin = (state.detRatePerMin * 0.7) + (instDetRate * 0.3);
    }
    state.liveObjectsNow = Math.max(0, Math.round((state.liveObjectsNow * 0.45) + (dets.length * 0.55)));

    for (const d of dets) {
      const conf = Number(d?.conf);
      if (Number.isFinite(conf) && conf >= 0 && conf <= 1) {
        state.confSum += conf;
        state.confCount += 1;
      }
    }

    const profile = String(data?.runtime_profile || "").trim();
    const reason = String(data?.runtime_profile_reason || "").trim();
    if (profile) state.runtimeProfile = profile;
    if (reason) state.runtimeReason = reason;
    const sceneLighting = String(data?.scene_lighting || "").trim();
    const sceneWeather = String(data?.scene_weather || "").trim();
    const sceneConfidence = Number(data?.scene_confidence);
    if (sceneLighting) state.sceneLighting = sceneLighting;
    if (sceneWeather) state.sceneWeather = sceneWeather;
    if (Number.isFinite(sceneConfidence)) {
      state.sceneConfidence = Math.max(0, Math.min(1, sceneConfidence));
    }

    const inCount = Number(data?.count_in);
    const outCount = Number(data?.count_out);
    if (Number.isFinite(inCount) && Number.isFinite(outCount)) {
      const crossingsNow = Math.max(0, inCount) + Math.max(0, outCount);
      if (state.lastCrossingTotal != null && dtMin != null) {
        const delta = Math.max(0, crossingsNow - state.lastCrossingTotal);
        const instCrossRate = delta / dtMin;
        state.crossingRatePerMin = (state.crossingRatePerMin * 0.65) + (instCrossRate * 0.35);
      }
      state.lastCrossingTotal = crossingsNow;
    }

    const ts = Date.parse(String(data?.captured_at || ""));
    if (Number.isFinite(ts)) {
      state.lastCaptureTsMs = ts;
    }

    render();
  }

  async function pollHealth() {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) return;
      const payload = await res.json();
      state.modelLoop = payload?.ml_retrain_task_running ? "active" : "idle";
      const latest = payload?.latest_ml_detection || null;
      const wx = payload?.weather_api?.latest || null;
      const conf = Number(latest?.avg_confidence);
      if (Number.isFinite(conf) && conf >= 0 && conf <= 1 && state.confCount === 0) {
        // Seed confidence immediately after deploy/reload even before first WS frame.
        state.confSum = conf;
        state.confCount = 1;
      }
      const latestTs = Date.parse(String(latest?.captured_at || ""));
      if (Number.isFinite(latestTs)) {
        state.lastCaptureTsMs = Math.max(state.lastCaptureTsMs || 0, latestTs);
      }

      // Fallback to weather API when WS scene fields are missing/unknown.
      if (wx && typeof wx === "object") {
        const light = String(wx.lighting || "").trim();
        const weather = String(wx.weather || "").trim();
        const sceneConf = Number(wx.confidence);
        const currLight = mapSceneValue(state.sceneLighting, "scanning");
        const currWeather = mapSceneValue(state.sceneWeather, "scanning");
        if ((currLight === "scanning" || currLight === "unknown") && light) state.sceneLighting = light;
        if ((currWeather === "scanning" || currWeather === "unknown") && weather) state.sceneWeather = weather;
        if (Number.isFinite(sceneConf) && sceneConf >= 0 && sceneConf <= 1 && (!Number.isFinite(state.sceneConfidence) || state.sceneConfidence <= 0)) {
          state.sceneConfidence = sceneConf;
        }
      }
      render();
    } catch {
      // Keep existing state.
    }
  }

  function getAvgConf() {
    if (!state.confCount) return null;
    return state.confSum / state.confCount;
  }

  function getLevel() {
    const elapsedMin = Math.max(1, (Date.now() - state.startedAt) / 60000);
    const frameRate = state.frames / elapsedMin;
    const detRate = state.detections / elapsedMin;
    const avgConf = getAvgConf();

    let score = 0;
    score += Math.min(50, (state.frames / 500) * 50);
    score += Math.min(30, (detRate / 40) * 30);
    if (avgConf != null) score += Math.min(20, (avgConf / 0.6) * 20);

    if (score >= 80) return { label: "Stabilizing", msg: "Detection quality is improving as more traffic is observed." };
    if (score >= 55) return { label: "Adapting", msg: "The model is adapting to this camera and roadway pattern." };
    if (score >= 30) return { label: "Learning", msg: "Vehicle detection gets better over time with more samples." };
    return { label: "Warming up", msg: "Early learning stage. Confidence will increase as data accumulates." };
  }

  function mapSceneValue(value, fallback) {
    const v = String(value || "").trim().toLowerCase();
    if (!v || v === "unknown" || v === "none" || v === "null") return fallback;
    return v.replaceAll("_", " ");
  }

  function sceneTitle(s) {
    const v = String(s || "").trim();
    return v ? (v.charAt(0).toUpperCase() + v.slice(1)) : "Scanning";
  }

  function weatherIcon(weather) {
    const w = mapSceneValue(weather, "scanning");
    if (w.includes("rain")) return "\u{1F327}";
    if (w.includes("cloud")) return "\u2601";
    if (w.includes("sun") || w.includes("clear")) return "\u2600";
    return "\u26C5";
  }

  function lightingIcon(lighting) {
    const l = mapSceneValue(lighting, "scanning");
    if (l === "night") return "\u{1F319}";
    if (l === "day") return "\u2600";
    return "\u25CC";
  }

  function getSceneDisplay() {
    const lighting = mapSceneValue(state.sceneLighting, "scanning");
    const weather = mapSceneValue(state.sceneWeather, "scanning");
    const hasRealScene = lighting !== "scanning" || weather !== "scanning";
    if (!hasRealScene && state.frames === 0) return "Idle";
    if (!hasRealScene) return "Scanning...";
    return `${sceneTitle(lighting)} | ${sceneTitle(weather)}`;
  }

  function getHudState(avgConf) {
    const sceneText = getSceneDisplay();
    if (state.frames === 0) return "Idle";
    if (sceneText === "Scanning...") return "Scanning";
    const lighting = mapSceneValue(state.sceneLighting, "scanning");
    if (lighting === "night") return "Night";
    if (lighting === "day") return "Day";
    if (Number.isFinite(avgConf) && avgConf >= 0.56 && state.detections > 150) return "Ready";
    return "Scanning";
  }

  function percent(n) {
    const v = Math.max(0, Math.min(100, Number(n) || 0));
    return `${Math.round(v)}%`;
  }

  function getVerboseScript({ confPct, scenePct, detections, frames, modelLoop }) {
    const lighting = mapSceneValue(state.sceneLighting, "scanning");
    const weather  = mapSceneValue(state.sceneWeather,  "scanning");
    const crossRate = Math.max(0, Number(state.crossingRatePerMin) || 0);
    const profile   = String(state.runtimeProfile || "").toLowerCase().replaceAll("_", " ");

    const parts = [];

    // ── Scene observation ──────────────────────────────────────
    if (frames < 6) {
      parts.push("initializing scene scan");
    } else {
      const lightDesc =
        lighting === "day"                   ? "daylight scene confirmed" :
        lighting === "night"                 ? "night scene active" :
        (lighting === "dusk" ||
         lighting === "dawn")               ? "low-light transition" :
        lighting === "overcast"              ? "overcast conditions" :
        lighting === "glare"                 ? "glare interference detected" :
        (lighting === "scanning" ||
         lighting === "unknown")            ? "scene lock calibrating" :
        `scene: ${lighting}`;
      parts.push(lightDesc);
    }

    // ── Weather ────────────────────────────────────────────────
    if (weather && weather !== "scanning" && weather !== "unknown") {
      const wxDesc =
        weather === "clear"                  ? "clear sky" :
        (weather === "rain" ||
         weather === "rainy")               ? "rain detected — wet road" :
        weather === "overcast"               ? "overcast sky" :
        (weather === "fog" ||
         weather === "foggy")               ? "fog — reduced visibility" :
        weather === "glare"                  ? "glare conditions" :
        weather === "haze"                   ? "haze detected" :
        `weather: ${weather}`;
      parts.push(wxDesc);
    } else {
      parts.push("weather scanning");
    }

    // ── Traffic load ───────────────────────────────────────────
    if (frames < 4) {
      parts.push("traffic baseline building");
    } else if (crossRate >= 12) {
      parts.push(`heavy volume · ${crossRate.toFixed(1)}/min`);
    } else if (crossRate >= 5) {
      parts.push(`moderate flow · ${crossRate.toFixed(1)}/min`);
    } else if (crossRate > 0) {
      parts.push(`light traffic · ${crossRate.toFixed(1)}/min`);
    } else {
      parts.push("monitoring traffic flow");
    }

    // ── Model / profile ────────────────────────────────────────
    if (profile && profile !== "balanced" && profile !== "") {
      parts.push(`profile: ${profile}`);
    } else {
      parts.push(modelLoop === "active" ? "retrain loop running" : "retrain idle");
    }

    return parts.join(" | ");
  }

  function getTrafficLoadSummary(crossRate, profile, reason) {
    const rate = Math.max(0, Number(crossRate) || 0);
    const p = String(profile || "").trim().toLowerCase();
    const r = String(reason || "").trim().toLowerCase();

    let load = "Light";
    if (rate >= 12) load = "Heavy";
    else if (rate >= 5) load = "Moderate";

    let msg = `Traffic is ${load.toLowerCase()} right now.`;
    if (load === "Heavy") {
      msg = "Heavy flow detected. Tight profile tuning helps prevent missed vehicles.";
    } else if (load === "Moderate") {
      msg = "Moderate flow. Runtime profile should stay balanced for stable counts.";
    }

    if (p.includes("heavy")) {
      msg = `Heavy profile active (${p.replaceAll("_", " ")}). Optimized for dense traffic.`;
    } else if (r.includes("heavy")) {
      msg = `Profile switched for heavy traffic (${r.replaceAll("_", " ")}).`;
    } else if (p.includes("glare")) {
      msg = "Glare profile active to reduce false positives in harsh lighting.";
    } else if (p.includes("night")) {
      msg = "Night profile active for low-light traffic detection.";
    }

    return { load, msg };
  }

  function getDelayMs() {
    if (!Number.isFinite(state.lastCaptureTsMs)) return null;
    return Math.max(0, Date.now() - state.lastCaptureTsMs);
  }

  function formatDelay(ms) {
    if (!Number.isFinite(ms)) return state.frames > 0 ? "Scanning..." : "Idle";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 1000)}s`;
  }

  function render() {
    const titleEl = document.querySelector(".ml-hud-title");
    const levelEl = document.getElementById("ml-hud-level");
    const msgEl = document.getElementById("ml-hud-msg");
    const framesEl = document.getElementById("ml-hud-frames");
    const detsEl = document.getElementById("ml-hud-dets");
    const confEl = document.getElementById("ml-hud-conf");
    const sceneEl = document.getElementById("ml-hud-profile");
    const sceneIconEl = document.getElementById("ml-hud-scene-icon");
    const delayEl = document.getElementById("ml-hud-delay");
    const confBarEl = document.getElementById("ml-hud-conf-bar");
    const sceneConfEl = document.getElementById("ml-hud-scene-conf");
    const trafficMsgEl = document.getElementById("ml-hud-traffic-msg");
    const verboseEl = document.getElementById("ml-hud-verbose");
    if (!titleEl || !levelEl || !msgEl || !framesEl || !detsEl || !confEl || !sceneEl || !delayEl || !confBarEl || !sceneConfEl) return;

    const level = getLevel();
    const avgConf = getAvgConf();
    const isMobile = window.matchMedia("(max-width: 640px)").matches;
    const title = isMobile ? "VISION" : "LIVE VISION HUD";
    const hudState = getHudState(avgConf);
    const modeLabel = state.runtimeProfile ? state.runtimeProfile.replaceAll("_", " ") : "balanced";
    const sceneLabel = getSceneDisplay();
    const delayMs = getDelayMs();
    const delayText = formatDelay(delayMs);
    const reasonText = state.runtimeReason ? state.runtimeReason.replaceAll("_", " ") : "";
    const confPct = avgConf == null ? 0 : Math.max(0, Math.min(100, avgConf * 100));
    const scenePct = Math.max(0, Math.min(100, (Number(state.sceneConfidence) || 0) * 100));
    titleEl.textContent = title;
    levelEl.textContent = sceneLabel;
    levelEl.classList.toggle("is-live", sceneLabel !== "Scanning..." && sceneLabel !== "Idle");
    levelEl.classList.toggle("is-scan", sceneLabel === "Scanning..." || sceneLabel === "Idle");
    levelEl.classList.toggle("is-delay", false);
    msgEl.textContent = `${level.label}. Mode: ${modeLabel}${reasonText ? ` (${reasonText})` : ""}.`;
    framesEl.textContent = state.frames.toLocaleString();
    detsEl.textContent = state.detections.toLocaleString();
    const detRate = Math.max(0, Number(state.detRatePerMin) || 0);
    const crossRate = Math.max(0, Number(state.crossingRatePerMin) || 0);
    const detRatePct = Math.max(0, Math.min(100, (detRate / 45) * 100));
    const trafficLoad = getTrafficLoadSummary(crossRate, state.runtimeProfile, state.runtimeReason);

    confEl.textContent = `${detRate.toFixed(1)}/m`;
    confBarEl.style.setProperty("--pct", detRatePct.toFixed(1));
    sceneConfEl.textContent = trafficLoad.load;
    if (trafficMsgEl) trafficMsgEl.textContent = trafficLoad.msg;
    delayEl.textContent = percent(confPct);
    const liveObjPct = Math.max(0, Math.min(100, (Number(state.liveObjectsNow) / 12) * 100));
    sceneEl.style.setProperty("--pct", liveObjPct.toFixed(1));
    delayEl.style.setProperty("--pct", confPct.toFixed(1));
    sceneEl.textContent = String(state.liveObjectsNow);
    if (sceneIconEl) sceneIconEl.textContent = "";
    if (verboseEl) {
      verboseEl.textContent = getVerboseScript({
        confPct,
        scenePct,
        detections: state.detections,
        frames: state.frames,
        modelLoop: state.modelLoop,
      });
    }
  }

  function destroy() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = null;
    _titleTimer = null;
    _bound = false;
  }

  return { init, destroy };
})();

window.MlOverlay = MlOverlay;



