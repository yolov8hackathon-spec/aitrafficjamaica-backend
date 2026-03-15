/**
 * admin-init.js — Admin dashboard: round creation, stats, recent rounds,
 * guardrail preview, user management, and dual zone editor init.
 */

let adminSession = null;
let latestCaptureUploadError = null;
let mlCaptureStats = { captureTotal: 0, uploadSuccessTotal: 0, uploadFailTotal: 0 };
let capturePaused = false;
let adminLiveWs = null;
let adminLiveWsTimer = null;
let adminLiveWsBackoffMs = 2000;
let activeCameraId = null;
let audienceSnapshot = null;
let audienceSnapshotAt = 0;

async function getAdminJwt() {
  const jwt = await Auth.getJwt();
  if (jwt && adminSession) {
    adminSession.access_token = jwt;
  }
  return jwt || adminSession || null;
}

async function getAdminHeaders(extra = {}) {
  const jwt = await getAdminJwt();
  if (!jwt) throw new Error("Admin session expired");
  return { ...extra, Authorization: `Bearer ${jwt}` };
}

async function resolveActiveCameraId() {
  try {
    const { data, error } = await window.sb
      .from("cameras")
      .select("id, ipcam_alias, created_at")
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
    return cams[0]?.id || null;
  } catch {
    return null;
  }
}
const DEFAULT_ML_DATASET_YAML_URL = "https://zaxycvrbdzkptjzrcxel.supabase.co/storage/v1/object/public/ml-datasets/datasets/whitelinez/data-v3.yaml";
const ML_DATASET_URL_STORAGE_KEY = "whitelinez.ml.dataset_yaml_url";
const DETECTION_SETTINGS_STORAGE_KEY = "whitelinez.detection.overlay_settings.v4";
const DETECTION_DEFAULT_SETTINGS = {
  box_style: "solid",
  line_width: 2,
  fill_alpha: 0.10,
  max_boxes: 10,
  show_labels: true,
  detect_zone_only: true,
  outside_scan_enabled: true,
  outside_scan_min_conf: 0.45,
  outside_scan_max_boxes: 25,
  outside_scan_hold_ms: 220,
  outside_scan_show_labels: true,
  ground_overlay_enabled: true,
  ground_overlay_alpha: 0.16,
  ground_grid_density: 6,
  ground_occlusion_cutout: 0.38,
  ground_quad: {
    x1: 0.34, y1: 0.58,
    x2: 0.78, y2: 0.58,
    x3: 0.98, y3: 0.98,
    x4: 0.08, y4: 0.98,
  },
  colors: {
    car: "#29B6F6",
    truck: "#FF7043",
    bus: "#AB47BC",
    motorcycle: "#FFD600",
  },
  appearance: {
    brightness: 100,
    contrast: 100,
    saturate: 100,
    hue: 0,
    blur: 0,
  },
};
const DETECTION_NIGHT_SETTINGS_PRESET = {
  box_style: "solid",
  line_width: 2,
  fill_alpha: 0.14,
  max_boxes: 12,
  show_labels: true,
  detect_zone_only: true,
  outside_scan_enabled: true,
  outside_scan_min_conf: 0.45,
  outside_scan_max_boxes: 30,
  outside_scan_hold_ms: 260,
  outside_scan_show_labels: true,
  ground_overlay_enabled: true,
  ground_overlay_alpha: 0.18,
  ground_grid_density: 6,
  ground_occlusion_cutout: 0.42,
};
const FEED_APPEARANCE_DAY_PRESET = {
  brightness: 102,
  contrast: 106,
  saturate: 104,
  hue: 0,
  blur: 0,
};
const FEED_APPEARANCE_NIGHT_PRESET = {
  brightness: 132,
  contrast: 136,
  saturate: 122,
  hue: 0,
  blur: 0.2,
};

// ── Guardrail constants ────────────────────────────────────────────────────────
const MIN_DURATION_MIN      = 5;
const MAX_DURATION_MIN      = 480;
const THRESHOLD_MIN_PER_MIN = 0.5;
const THRESHOLD_MAX_PER_MIN = 25.0;
const CLASS_RATE_FALLBACK = { car: 0.50, motorcycle: 0.20, truck: 0.15, bus: 0.10 };

// ── Historical baseline ────────────────────────────────────────────────────────
const hourlyBaseline = {};
let baselineLoaded   = false;
let baselineLoading  = false;

async function loadBaseline() {
  if (baselineLoaded || baselineLoading) return;
  baselineLoading = true;
  try {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data } = await window.sb
      .from("ml_detection_events")
      .select("captured_at, detections_count, class_counts, avg_confidence")
      .gte("captured_at", since)
      .order("captured_at", { ascending: true })
      .limit(20000);

    if (!data) return;

    const deltas = [];
    for (let i = 1; i < data.length; i += 1) {
      const prevTs = new Date(data[i - 1].captured_at).getTime();
      const currTs = new Date(data[i].captured_at).getTime();
      const diffSec = (currTs - prevTs) / 1000;
      if (Number.isFinite(diffSec) && diffSec >= 1 && diffSec <= 120) deltas.push(diffSec);
    }
    const sampleIntervalSec = deltas.length
      ? deltas.sort((a, b) => a - b)[Math.floor(deltas.length / 2)]
      : 5;
    const perEventToMinute = 60 / Math.max(1, sampleIntervalSec);

    const buckets = {};
    for (const row of data) {
      const hour = new Date(row.captured_at).getHours();
      const det = Number(row.detections_count || 0);
      if (!buckets[hour]) {
        buckets[hour] = {
          sample_count: 0,
          rate_sum: 0,
          rate_sq_sum: 0,
          conf_sum: 0,
          conf_count: 0,
          class_sums: { car: 0, truck: 0, bus: 0, motorcycle: 0 },
        };
      }
      const b = buckets[hour];
      b.sample_count += 1;

      const perMinute = det * perEventToMinute;
      b.rate_sum += perMinute;
      b.rate_sq_sum += perMinute * perMinute;

      const conf = Number(row.avg_confidence);
      if (Number.isFinite(conf) && conf >= 0 && conf <= 1) {
        b.conf_sum += conf;
        b.conf_count += 1;
      }

      const cc = row.class_counts || {};
      b.class_sums.car += Number(cc.car || 0);
      b.class_sums.truck += Number(cc.truck || 0);
      b.class_sums.bus += Number(cc.bus || 0);
      b.class_sums.motorcycle += Number(cc.motorcycle || 0);
    }

    for (const h in buckets) {
      const b = buckets[h];
      const n = Math.max(1, b.sample_count);
      const avgPerMin = b.rate_sum / n;
      const variance = Math.max(0, (b.rate_sq_sum / n) - (avgPerMin * avgPerMin));
      const classTotal = Math.max(1, b.class_sums.car + b.class_sums.truck + b.class_sums.bus + b.class_sums.motorcycle);

      hourlyBaseline[h] = {
        sample_count: b.sample_count,
        avg_per_min: avgPerMin,
        std_per_min: Math.sqrt(variance),
        avg_conf: b.conf_count > 0 ? b.conf_sum / b.conf_count : null,
        class_share: {
          car: b.class_sums.car / classTotal,
          truck: b.class_sums.truck / classTotal,
          bus: b.class_sums.bus / classTotal,
          motorcycle: b.class_sums.motorcycle / classTotal,
        },
      };
    }
    baselineLoaded = true;
  } catch (e) {
    console.warn("[admin-init] Baseline load failed:", e);
  } finally {
    baselineLoading = false;
  }
}

function getBaselineForHour(dateObj) {
  return hourlyBaseline[dateObj.getHours()] ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtLocal(d) { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function fmtDurationMin(min) {
  if (min >= 60) { const h = Math.floor(min/60); const m = min%60; return m === 0 ? `${h}h` : `${h}h ${m}m`; }
  return `${min}m`;
}
function getDetectionSettings() {
  try {
    const raw = localStorage.getItem(DETECTION_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DETECTION_DEFAULT_SETTINGS, colors: { ...DETECTION_DEFAULT_SETTINGS.colors } };
    const parsed = JSON.parse(raw);
    return {
      ...DETECTION_DEFAULT_SETTINGS,
      ...parsed,
      colors: { ...DETECTION_DEFAULT_SETTINGS.colors, ...(parsed?.colors || {}) },
      appearance: { ...DETECTION_DEFAULT_SETTINGS.appearance, ...(parsed?.appearance || {}) },
    };
  } catch {
    return { ...DETECTION_DEFAULT_SETTINGS, colors: { ...DETECTION_DEFAULT_SETTINGS.colors } };
  }
}
function publishDetectionSettings(settings) {
  applyAdminVideoAppearance(settings);
  window.dispatchEvent(new CustomEvent("detection:settings-update", { detail: settings }));
}
function buildAdminVideoFilter(settings) {
  const a = settings?.appearance || {};
  const brightness = Math.max(50, Math.min(180, Number(a.brightness) || 100));
  const contrast = Math.max(50, Math.min(200, Number(a.contrast) || 100));
  const saturate = Math.max(0, Math.min(220, Number(a.saturate) || 100));
  const hue = Math.max(0, Math.min(360, Number(a.hue) || 0));
  const blur = Math.max(0, Math.min(4, Number(a.blur) || 0));
  return `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%) hue-rotate(${hue}deg) blur(${blur.toFixed(1)}px)`;
}
function isNightWindowNow() {
  const h = new Date().getHours();
  return h >= 18 || h < 6;
}
function getAutoAppearancePreset() {
  return isNightWindowNow() ? FEED_APPEARANCE_NIGHT_PRESET : FEED_APPEARANCE_DAY_PRESET;
}
function updateAppearanceLabels(settings) {
  const a = settings?.appearance || {};
  const setText = (id, value) => {
    const n = document.getElementById(id);
    if (n) n.textContent = value;
  };
  setText("det-video-brightness-val", `${Math.round(Number(a.brightness) || 100)}%`);
  setText("det-video-contrast-val", `${Math.round(Number(a.contrast) || 100)}%`);
  setText("det-video-saturate-val", `${Math.round(Number(a.saturate) || 100)}%`);
  setText("det-video-hue-val", `${Math.round(Number(a.hue) || 0)}deg`);
  setText("det-video-blur-val", `${(Number(a.blur) || 0).toFixed(1)}px`);
}
function applyAdminVideoAppearance(settings) {
  const video = document.getElementById("admin-video");
  if (!video) return;
  video.style.filter = buildAdminVideoFilter(settings || getDetectionSettings());
}
function applyDetectionSettingsToForm(settings) {
  const s = settings || getDetectionSettings();
  const setVal = (id, v) => { const n = document.getElementById(id); if (n) n.value = v; };
  setVal("det-box-style", s.box_style);
  setVal("det-line-width", String(s.line_width));
  setVal("det-fill-alpha", String(s.fill_alpha));
  setVal("det-max-boxes", String(s.max_boxes));
  setVal("det-show-labels", s.show_labels ? "1" : "0");
  setVal("det-show-zone-only", s.detect_zone_only ? "1" : "0");
  setVal("det-color-car", s.colors?.car || DETECTION_DEFAULT_SETTINGS.colors.car);
  setVal("det-color-truck", s.colors?.truck || DETECTION_DEFAULT_SETTINGS.colors.truck);
  setVal("det-color-bus", s.colors?.bus || DETECTION_DEFAULT_SETTINGS.colors.bus);
  setVal("det-color-motorcycle", s.colors?.motorcycle || DETECTION_DEFAULT_SETTINGS.colors.motorcycle);
  setVal("det-ground-enabled", s.ground_overlay_enabled === false ? "0" : "1");
  setVal("det-ground-alpha", String(s.ground_overlay_alpha ?? DETECTION_DEFAULT_SETTINGS.ground_overlay_alpha));
  setVal("det-ground-grid", String(s.ground_grid_density ?? DETECTION_DEFAULT_SETTINGS.ground_grid_density));
  setVal("det-ground-cutout", String(s.ground_occlusion_cutout ?? DETECTION_DEFAULT_SETTINGS.ground_occlusion_cutout));
  setVal("det-ground-x1", String(s.ground_quad?.x1 ?? DETECTION_DEFAULT_SETTINGS.ground_quad.x1));
  setVal("det-ground-y1", String(s.ground_quad?.y1 ?? DETECTION_DEFAULT_SETTINGS.ground_quad.y1));
  setVal("det-ground-x2", String(s.ground_quad?.x2 ?? DETECTION_DEFAULT_SETTINGS.ground_quad.x2));
  setVal("det-ground-y2", String(s.ground_quad?.y2 ?? DETECTION_DEFAULT_SETTINGS.ground_quad.y2));
  setVal("det-ground-x3", String(s.ground_quad?.x3 ?? DETECTION_DEFAULT_SETTINGS.ground_quad.x3));
  setVal("det-ground-y3", String(s.ground_quad?.y3 ?? DETECTION_DEFAULT_SETTINGS.ground_quad.y3));
  setVal("det-ground-x4", String(s.ground_quad?.x4 ?? DETECTION_DEFAULT_SETTINGS.ground_quad.x4));
  setVal("det-ground-y4", String(s.ground_quad?.y4 ?? DETECTION_DEFAULT_SETTINGS.ground_quad.y4));
  setVal("det-video-brightness", String(s.appearance?.brightness ?? DETECTION_DEFAULT_SETTINGS.appearance.brightness));
  setVal("det-video-contrast", String(s.appearance?.contrast ?? DETECTION_DEFAULT_SETTINGS.appearance.contrast));
  setVal("det-video-saturate", String(s.appearance?.saturate ?? DETECTION_DEFAULT_SETTINGS.appearance.saturate));
  setVal("det-video-hue", String(s.appearance?.hue ?? DETECTION_DEFAULT_SETTINGS.appearance.hue));
  setVal("det-video-blur", String(s.appearance?.blur ?? DETECTION_DEFAULT_SETTINGS.appearance.blur));
  updateAppearanceLabels(s);
  applyAdminVideoAppearance(s);
}
function readDetectionSettingsFromForm() {
  const getVal = (id, fallback = "") => document.getElementById(id)?.value ?? fallback;
  return {
    box_style: String(getVal("det-box-style", "solid")),
    line_width: Math.max(1, Math.min(5, Number(getVal("det-line-width", "2")) || 2)),
    fill_alpha: Math.max(0, Math.min(0.45, Number(getVal("det-fill-alpha", "0.10")) || 0.10)),
    max_boxes: Math.max(1, Math.min(40, Number(getVal("det-max-boxes", "10")) || 10)),
    show_labels: String(getVal("det-show-labels", "1")) === "1",
    detect_zone_only: String(getVal("det-show-zone-only", "1")) === "1",
    outside_scan_enabled: true,
    outside_scan_min_conf: Number(DETECTION_DEFAULT_SETTINGS.outside_scan_min_conf || 0.45),
    outside_scan_max_boxes: Number(DETECTION_DEFAULT_SETTINGS.outside_scan_max_boxes || 25),
    outside_scan_hold_ms: Number(DETECTION_DEFAULT_SETTINGS.outside_scan_hold_ms || 220),
    outside_scan_show_labels: Boolean(DETECTION_DEFAULT_SETTINGS.outside_scan_show_labels),
    ground_overlay_enabled: String(getVal("det-ground-enabled", "1")) === "1",
    ground_overlay_alpha: Math.max(0, Math.min(0.45, Number(getVal("det-ground-alpha", String(DETECTION_DEFAULT_SETTINGS.ground_overlay_alpha))) || DETECTION_DEFAULT_SETTINGS.ground_overlay_alpha)),
    ground_grid_density: Math.max(2, Math.min(16, Number(getVal("det-ground-grid", String(DETECTION_DEFAULT_SETTINGS.ground_grid_density))) || DETECTION_DEFAULT_SETTINGS.ground_grid_density)),
    ground_occlusion_cutout: Math.max(0, Math.min(0.85, Number(getVal("det-ground-cutout", String(DETECTION_DEFAULT_SETTINGS.ground_occlusion_cutout))) || DETECTION_DEFAULT_SETTINGS.ground_occlusion_cutout)),
    ground_quad: {
      x1: Math.max(0, Math.min(1, Number(getVal("det-ground-x1", String(DETECTION_DEFAULT_SETTINGS.ground_quad.x1))) || DETECTION_DEFAULT_SETTINGS.ground_quad.x1)),
      y1: Math.max(0, Math.min(1, Number(getVal("det-ground-y1", String(DETECTION_DEFAULT_SETTINGS.ground_quad.y1))) || DETECTION_DEFAULT_SETTINGS.ground_quad.y1)),
      x2: Math.max(0, Math.min(1, Number(getVal("det-ground-x2", String(DETECTION_DEFAULT_SETTINGS.ground_quad.x2))) || DETECTION_DEFAULT_SETTINGS.ground_quad.x2)),
      y2: Math.max(0, Math.min(1, Number(getVal("det-ground-y2", String(DETECTION_DEFAULT_SETTINGS.ground_quad.y2))) || DETECTION_DEFAULT_SETTINGS.ground_quad.y2)),
      x3: Math.max(0, Math.min(1, Number(getVal("det-ground-x3", String(DETECTION_DEFAULT_SETTINGS.ground_quad.x3))) || DETECTION_DEFAULT_SETTINGS.ground_quad.x3)),
      y3: Math.max(0, Math.min(1, Number(getVal("det-ground-y3", String(DETECTION_DEFAULT_SETTINGS.ground_quad.y3))) || DETECTION_DEFAULT_SETTINGS.ground_quad.y3)),
      x4: Math.max(0, Math.min(1, Number(getVal("det-ground-x4", String(DETECTION_DEFAULT_SETTINGS.ground_quad.x4))) || DETECTION_DEFAULT_SETTINGS.ground_quad.x4)),
      y4: Math.max(0, Math.min(1, Number(getVal("det-ground-y4", String(DETECTION_DEFAULT_SETTINGS.ground_quad.y4))) || DETECTION_DEFAULT_SETTINGS.ground_quad.y4)),
    },
    colors: {
      car: String(getVal("det-color-car", DETECTION_DEFAULT_SETTINGS.colors.car)),
      truck: String(getVal("det-color-truck", DETECTION_DEFAULT_SETTINGS.colors.truck)),
      bus: String(getVal("det-color-bus", DETECTION_DEFAULT_SETTINGS.colors.bus)),
      motorcycle: String(getVal("det-color-motorcycle", DETECTION_DEFAULT_SETTINGS.colors.motorcycle)),
    },
    appearance: {
      brightness: Math.max(50, Math.min(180, Number(getVal("det-video-brightness", "100")) || 100)),
      contrast: Math.max(50, Math.min(200, Number(getVal("det-video-contrast", "100")) || 100)),
      saturate: Math.max(0, Math.min(220, Number(getVal("det-video-saturate", "100")) || 100)),
      hue: Math.max(0, Math.min(360, Number(getVal("det-video-hue", "0")) || 0)),
      blur: Math.max(0, Math.min(4, Number(getVal("det-video-blur", "0")) || 0)),
    },
  };
}
function applyAppearancePresetToForm(preset) {
  const setVal = (id, v) => { const n = document.getElementById(id); if (n) n.value = String(v); };
  setVal("det-video-brightness", preset?.brightness ?? 100);
  setVal("det-video-contrast", preset?.contrast ?? 100);
  setVal("det-video-saturate", preset?.saturate ?? 100);
  setVal("det-video-hue", preset?.hue ?? 0);
  setVal("det-video-blur", preset?.blur ?? 0);
  const s = readDetectionSettingsFromForm();
  updateAppearanceLabels(s);
  publishDetectionSettings(s);
}
function setFeedAppearanceMsg(msg, isError = false) {
  const el = document.getElementById("feed-settings-msg");
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? "var(--danger)" : "var(--green)";
}
async function loadCameraFeedAppearance() {
  if (!activeCameraId) return;
  try {
    const { data, error } = await window.sb
      .from("cameras")
      .select("feed_appearance")
      .eq("id", activeCameraId)
      .maybeSingle();
    if (error) throw error;
    const cfg = (data?.feed_appearance && typeof data.feed_appearance === "object")
      ? data.feed_appearance
      : {};
    if (cfg.detection_overlay && typeof cfg.detection_overlay === "object") {
      const merged = {
        ...getDetectionSettings(),
        ...cfg.detection_overlay,
        colors: { ...getDetectionSettings().colors, ...(cfg.detection_overlay.colors || {}) },
      };
      applyDetectionSettingsToForm(merged);
      publishDetectionSettings(merged);
    }
    if (cfg.appearance && typeof cfg.appearance === "object") {
      applyAppearancePresetToForm(cfg.appearance);
    }
    const pushEl = document.getElementById("feed-push-public");
    if (pushEl) pushEl.value = cfg.push_public === false ? "0" : "1";
    const autoEl = document.getElementById("feed-auto-preset");
    if (autoEl) autoEl.value = cfg.auto_day_night ? "1" : "0";
    if (cfg.auto_day_night) {
      applyAppearancePresetToForm(getAutoAppearancePreset());
    }
  } catch (e) {
    console.warn("[admin-init] Could not load feed appearance:", e);
  }
}
async function pushFeedAppearanceToPublic() {
  if (!activeCameraId) {
    setFeedAppearanceMsg("No active camera found.", true);
    return;
  }
  try {
    const autoEnabled = document.getElementById("feed-auto-preset")?.value === "1";
    if (autoEnabled) {
      applyAppearancePresetToForm(getAutoAppearancePreset());
    }
    const settings = readDetectionSettingsFromForm();
    const pushPublic = document.getElementById("feed-push-public")?.value !== "0";
    const payload = {
      appearance: settings.appearance,
      detection_overlay: {
        box_style: settings.box_style,
        line_width: settings.line_width,
        fill_alpha: settings.fill_alpha,
        max_boxes: settings.max_boxes,
        show_labels: settings.show_labels,
        detect_zone_only: settings.detect_zone_only,
        colors: settings.colors,
        outside_scan_enabled: settings.outside_scan_enabled,
        outside_scan_min_conf: settings.outside_scan_min_conf,
        outside_scan_max_boxes: settings.outside_scan_max_boxes,
        outside_scan_hold_ms: settings.outside_scan_hold_ms,
        outside_scan_show_labels: settings.outside_scan_show_labels,
        ground_overlay_enabled: settings.ground_overlay_enabled,
        ground_overlay_alpha: settings.ground_overlay_alpha,
        ground_grid_density: settings.ground_grid_density,
        ground_occlusion_cutout: settings.ground_occlusion_cutout,
        ground_quad: settings.ground_quad,
      },
      push_public: pushPublic,
      auto_day_night: autoEnabled,
      updated_at: new Date().toISOString(),
    };
    const { error } = await window.sb
      .from("cameras")
      .update({ feed_appearance: payload })
      .eq("id", activeCameraId);
    if (error) throw error;
    setFeedAppearanceMsg("Appearance pushed to public view.");
  } catch (e) {
    setFeedAppearanceMsg(e.message || "Failed to push appearance", true);
  }
}
function saveDetectionSettings() {
  const settings = readDetectionSettingsFromForm();
  localStorage.setItem(DETECTION_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  publishDetectionSettings(settings);
  const msg = document.getElementById("det-settings-msg");
  if (msg) {
    msg.style.color = "var(--green)";
    msg.textContent = "Saved. Overlay + appearance settings apply immediately.";
  }
}
function resetDetectionSettings() {
  localStorage.setItem(DETECTION_SETTINGS_STORAGE_KEY, JSON.stringify(DETECTION_DEFAULT_SETTINGS));
  applyDetectionSettingsToForm(DETECTION_DEFAULT_SETTINGS);
  publishDetectionSettings(DETECTION_DEFAULT_SETTINGS);
  const msg = document.getElementById("det-settings-msg");
  if (msg) {
    msg.style.color = "var(--muted)";
    msg.textContent = "Defaults restored.";
  }
}
function applyDetectionPreset(preset, label) {
  const current = getDetectionSettings();
  const merged = {
    ...current,
    ...preset,
    colors: { ...(current?.colors || DETECTION_DEFAULT_SETTINGS.colors) },
    appearance: { ...(current?.appearance || DETECTION_DEFAULT_SETTINGS.appearance) },
  };
  applyDetectionSettingsToForm(merged);
  publishDetectionSettings(merged);
  const msg = document.getElementById("det-settings-msg");
  if (msg) {
    msg.style.color = "var(--green)";
    msg.textContent = `${label} applied. Click Save Detection Settings to persist.`;
  }
}
async function loadDetectionStatus() {
  const setText = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  try {
    const [latestResp, healthResp] = await Promise.all([
      window.sb
        .from("ml_detection_events")
        .select("captured_at, detections_count, avg_confidence, model_name")
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      fetch("/api/health").catch(() => null),
    ]);

    const latest = latestResp?.data || null;
    const modelName = latest?.model_name || "none";
    const avgConf = Number(latest?.avg_confidence || 0);
    setText("det-status-model", modelName);
    setText("det-model-banner-name", modelName);
    setText("det-status-conf", latest ? `${(avgConf * 100).toFixed(1)}%` : "-");
    setText("det-status-last", latest?.captured_at ? fmtAgo(latest.captured_at) : "No telemetry");

    if (healthResp && healthResp.ok) {
      const health = await healthResp.json();
      setText("det-runtime-ai", health.ai_task_running ? "Running" : "Stopped");
      const streamConfigured = Boolean(health.stream_configured ?? health.stream_url);
      setText("det-runtime-stream", streamConfigured ? "Connected" : "Missing stream URL");
      setText("det-runtime-profile", "Waiting for live runtime profile...");
      setText("det-runtime-reason", "Waiting for live runtime reason...");
    } else {
      setText("det-runtime-ai", "Unavailable");
      setText("det-runtime-stream", "Unavailable");
      setText("det-runtime-profile", "Unavailable");
      setText("det-runtime-reason", "Unavailable");
    }

    if (adminSession) {
      const nightRes = await fetch("/api/admin/ml-runtime-profile?scope=night", {
        headers: await getAdminHeaders(),
      });
      if (nightRes.ok) {
        const night = await nightRes.json();
        const enabled = !!night?.enabled;
        const nowHour = new Date().getHours();
        const startHour = Number(night?.start_hour ?? 18);
        const endHour = Number(night?.end_hour ?? 6);
        const inNightWindow = enabled && (startHour === endHour
          ? true
          : startHour < endHour
            ? (nowHour >= startHour && nowHour < endHour)
            : (nowHour >= startHour || nowHour < endHour));
        setText("det-runtime-night", enabled ? (inNightWindow ? "Enabled (active now)" : "Enabled (day window)") : "Disabled");
        setText("det-runtime-focus", inNightWindow
          ? "Full-feed scan with night-tuned thresholds"
          : "Full-feed scan with day profile");
      }
    }
  } catch {
    setText("det-status-model", "-");
    setText("det-model-banner-name", "-");
    setText("det-status-conf", "-");
    setText("det-status-last", "Unavailable");
    setText("det-runtime-ai", "Unavailable");
    setText("det-runtime-stream", "Unavailable");
    setText("det-runtime-night", "Unavailable");
    setText("det-runtime-profile", "Unavailable");
    setText("det-runtime-reason", "Unavailable");
  }
}
function initDetectionStudio() {
  applyDetectionSettingsToForm(getDetectionSettings());
  publishDetectionSettings(getDetectionSettings());

  document.getElementById("btn-det-save")?.addEventListener("click", saveDetectionSettings);
  document.getElementById("btn-det-reset")?.addEventListener("click", resetDetectionSettings);
  document.getElementById("btn-det-preset-balanced")?.addEventListener("click", () => {
    applyDetectionPreset(DETECTION_DEFAULT_SETTINGS, "Preset A overlay");
  });
  document.getElementById("btn-det-preset-night")?.addEventListener("click", () => {
    applyDetectionPreset(DETECTION_NIGHT_SETTINGS_PRESET, "Preset B overlay");
  });
  document.getElementById("btn-video-push-public")?.addEventListener("click", pushFeedAppearanceToPublic);
  document.getElementById("btn-feed-preset-day")?.addEventListener("click", () => {
    applyAppearancePresetToForm(FEED_APPEARANCE_DAY_PRESET);
    setFeedAppearanceMsg("Day preset applied.");
  });
  document.getElementById("btn-feed-preset-night")?.addEventListener("click", () => {
    applyAppearancePresetToForm(FEED_APPEARANCE_NIGHT_PRESET);
    setFeedAppearanceMsg("Night preset applied.");
  });
  document.getElementById("btn-feed-apply-auto")?.addEventListener("click", () => {
    applyAppearancePresetToForm(getAutoAppearancePreset());
    setFeedAppearanceMsg(`Auto preset applied (${isNightWindowNow() ? "night" : "day"}).`);
  });

  [
    "det-box-style", "det-line-width", "det-fill-alpha", "det-max-boxes",
    "det-show-labels", "det-show-zone-only", "det-color-car", "det-color-truck",
    "det-color-bus", "det-color-motorcycle", "det-video-brightness", "det-video-contrast",
    "det-video-saturate", "det-video-hue", "det-video-blur",
    "det-ground-enabled", "det-ground-alpha", "det-ground-grid", "det-ground-cutout",
    "det-ground-x1", "det-ground-y1", "det-ground-x2", "det-ground-y2",
    "det-ground-x3", "det-ground-y3", "det-ground-x4", "det-ground-y4",
  ].forEach((id) => {
    const emit = () => {
      const s = readDetectionSettingsFromForm();
      updateAppearanceLabels(s);
      publishDetectionSettings(s);
    };
    document.getElementById(id)?.addEventListener("input", emit);
    document.getElementById(id)?.addEventListener("change", emit);
  });

  loadDetectionStatus();
  setInterval(loadDetectionStatus, 10000);
}

function isValidCountLine(line) {
  if (!line || typeof line !== "object") return false;
  const hasPoly = ["x1","y1","x2","y2","x3","y3","x4","y4"].every((k) => typeof line[k] === "number");
  const hasLine = ["x1","y1","x2","y2"].every((k) => typeof line[k] === "number");
  const keys = hasPoly ? ["x1","y1","x2","y2","x3","y3","x4","y4"] : hasLine ? ["x1","y1","x2","y2"] : [];
  if (!keys.length) return false;
  return keys.every((k) => line[k] >= 0 && line[k] <= 1);
}

async function ensureCountZoneSaved(cameraId) {
  if (!cameraId) return false;
  const { data, error } = await window.sb
    .from("cameras")
    .select("count_line")
    .eq("id", cameraId)
    .maybeSingle();
  if (error) throw error;
  return isValidCountLine(data?.count_line);
}

function getComputedTimes() {
  const startsVal = document.getElementById("starts-at")?.value;
  const duration  = parseInt(document.getElementById("duration")?.value || "0", 10);
  const cutoff    = parseInt(document.getElementById("bet-cutoff")?.value || "1", 10);
  if (!startsVal || !duration) return null;
  const starts = new Date(startsVal);
  const ends   = new Date(starts.getTime() + duration * 60_000);
  const closes = new Date(ends.getTime()   - cutoff  * 60_000);
  return { starts, ends, closes, duration, cutoff };
}

// ── Live stats ────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    // Fetch latest snapshot
    const { data: snap } = await window.sb
      .from("count_snapshots")
      .select("total")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const countEl = document.getElementById("stat-count");
    if (countEl) countEl.textContent = snap?.total ?? "—";

    // Active round
    const { data: round } = await window.sb
      .from("bet_rounds")
      .select("status")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();

    const roundEl = document.getElementById("stat-round");
    if (roundEl) {
      if (round?.status) {
        roundEl.textContent = String(round.status).toUpperCase();
      } else {
        // Fallback: show next known lifecycle state if no open round exists.
        const { data: fallbackRound } = await window.sb
          .from("bet_rounds")
          .select("status")
          .in("status", ["upcoming", "locked"])
          .order("opens_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        roundEl.textContent = fallbackRound?.status ? String(fallbackRound.status).toUpperCase() : "—";
      }
    }

    // Bets placed today
    const since = new Date(); since.setHours(0,0,0,0);
    const { count: betCount } = await window.sb
      .from("bets")
      .select("id", { count: "exact", head: true })
      .gte("placed_at", since.toISOString());

    const betsEl = document.getElementById("stat-bets");
    if (betsEl) betsEl.textContent = betCount ?? "—";

    // WS users + visits from health endpoint (best effort)
    try {
      const h = await fetch("/api/health");
      if (h.ok) {
        const hData = await h.json();
        const usersEl = document.getElementById("stat-users");
        if (usersEl) usersEl.textContent = Number(hData.total_ws_connections ?? 0).toLocaleString();
        const visitsEl = document.getElementById("stat-visits");
        if (visitsEl) visitsEl.textContent = Number(hData.public_ws_total_visits ?? 0).toLocaleString();
        renderHealthOverview(hData);
      } else {
        renderHealthOverview(null, `HTTP ${h.status}`);
      }
    } catch {
      renderHealthOverview(null, "Unavailable");
    }
  } catch (e) {
    console.warn("[admin-init] Stats load failed:", e);
  }
}
function _setAdminLiveStatCount(value) {
  const countEl = document.getElementById("stat-count");
  if (!countEl) return;
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  countEl.textContent = n.toLocaleString();
}

function _setAdminLiveStatRound(round) {
  const roundEl = document.getElementById("stat-round");
  if (!roundEl) return;
  if (!round || !round.status) return;
  roundEl.textContent = String(round.status).toUpperCase();
}

async function connectAdminLiveStatsWs() {
  try {
    if (adminLiveWs && (adminLiveWs.readyState === WebSocket.OPEN || adminLiveWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const tokenResp = await fetch("/api/token");
    if (!tokenResp.ok) throw new Error(`token ${tokenResp.status}`);
    const tokenData = await tokenResp.json();
    const wsUrl = `${tokenData.wss_url}?token=${encodeURIComponent(tokenData.token)}`;
    adminLiveWs = new WebSocket(wsUrl);

    adminLiveWs.onopen = () => {
      adminLiveWsBackoffMs = 2000;
    };

    adminLiveWs.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data?.type === "count") {
          if (typeof data.total !== "undefined") _setAdminLiveStatCount(data.total);
          if (data.round) _setAdminLiveStatRound(data.round);
          window.dispatchEvent(new CustomEvent("admin:live-count", { detail: data }));
        } else if (data?.type === "round") {
          _setAdminLiveStatRound(data.round);
          window.dispatchEvent(new CustomEvent("admin:live-round", { detail: data.round || null }));
        }
      } catch {}
    };

    adminLiveWs.onclose = () => {
      clearTimeout(adminLiveWsTimer);
      adminLiveWsTimer = setTimeout(connectAdminLiveStatsWs, adminLiveWsBackoffMs);
      adminLiveWsBackoffMs = Math.min(adminLiveWsBackoffMs * 2, 30000);
    };

    adminLiveWs.onerror = () => {
      try { adminLiveWs?.close(); } catch {}
    };
  } catch {
    clearTimeout(adminLiveWsTimer);
    adminLiveWsTimer = setTimeout(connectAdminLiveStatsWs, adminLiveWsBackoffMs);
    adminLiveWsBackoffMs = Math.min(adminLiveWsBackoffMs * 2, 30000);
  }
}

function statusPill(ok) {
  return `<span class="round-badge round-${ok ? "open" : "locked"}">${ok ? "OK" : "DOWN"}</span>`;
}

function fmtAgo(iso) {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function fmtInOrAgo(iso) {
  if (!iso) return "-";
  const targetMs = new Date(iso).getTime();
  if (!Number.isFinite(targetMs)) return "-";
  const diffSec = Math.floor((targetMs - Date.now()) / 1000);
  if (Math.abs(diffSec) < 5) return "just now";
  const absSec = Math.abs(diffSec);
  if (absSec < 60) return diffSec > 0 ? `in ${absSec}s` : `${absSec}s ago`;
  const absMin = Math.floor(absSec / 60);
  if (absMin < 60) return diffSec > 0 ? `in ${absMin}m` : `${absMin}m ago`;
  const absHr = Math.floor(absMin / 60);
  if (absHr < 24) return diffSec > 0 ? `in ${absHr}h` : `${absHr}h ago`;
  const absDay = Math.floor(absHr / 24);
  return diffSec > 0 ? `in ${absDay}d` : `${absDay}d ago`;
}

function escHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortText(input, max = 180) {
  const text = String(input || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function formatTrainingJobSummary(job) {
  if (!job) return "No training jobs yet";
  const type = String(job.job_type || "-").toUpperCase();
  const status = String(job.status || "-").toUpperCase();
  return `${type} | ${status} | ${fmtAgo(job.created_at)}`;
}

function getTrainingFailureReason(job) {
  if (!job) return "";
  const status = String(job.status || "").toLowerCase();
  if (status !== "failed") return "";
  return shortText(job.notes || job.error || "");
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function datasetLevel(totalRows, rows24h, avgConf) {
  const totalScore = Math.min(1, totalRows / 50000);
  const dayScore = Math.min(1, rows24h / 5000);
  const confScore = Math.min(1, (avgConf || 0) / 0.55);
  const score = (totalScore * 0.5) + (dayScore * 0.3) + (confScore * 0.2);

  if (score >= 0.85) return { key: "platinum", label: "Platinum", hint: "Production-ready telemetry volume" };
  if (score >= 0.65) return { key: "gold", label: "Gold", hint: "Strong dataset with good momentum" };
  if (score >= 0.4) return { key: "silver", label: "Silver", hint: "Usable but still improving" };
  if (score > 0) return { key: "bronze", label: "Bronze", hint: "Early stage dataset, collect more" };
  return { key: "unknown", label: "Unknown", hint: "No telemetry data yet" };
}

function setMlBar(fillId, textId, pct, label) {
  const fillEl = document.getElementById(fillId);
  const textEl = document.getElementById(textId);
  if (fillEl) fillEl.style.width = `${clampPct(pct)}%`;
  if (textEl) textEl.textContent = label;
}

function renderMlVisualSummary(totalRows, rows24h, avgConf, activeModel, latestTs) {
  const total = Number(totalRows || 0);
  const day = Number(rows24h || 0);
  const conf = Number(avgConf || 0);
  const level = datasetLevel(total, day, conf);
  const totalPct = total > 0 ? (total / 50000) * 100 : 0;
  const dayPct = day > 0 ? (day / 5000) * 100 : 0;
  const confPct = conf > 0 ? (conf / 0.55) * 100 : 0;
  const dayGap = day - 5000;
  const hasModel = String(activeModel || "").trim() && String(activeModel || "").trim().toLowerCase() !== "none";
  const momentumText = day >= 5000 ? `Above target by ${dayGap.toLocaleString()} rows` : `Below target by ${Math.abs(dayGap).toLocaleString()} rows`;

  const totalKpi = document.getElementById("ml-kpi-total");
  const dayKpi = document.getElementById("ml-kpi-24h");
  const confKpi = document.getElementById("ml-kpi-confidence");
  const levelKpi = document.getElementById("ml-kpi-level");
  const levelSub = document.getElementById("ml-kpi-level-sub");
  const totalSub = document.getElementById("ml-kpi-total-sub");
  const daySub = document.getElementById("ml-kpi-24h-sub");
  const confSub = document.getElementById("ml-kpi-confidence-sub");
  const glance = document.getElementById("ml-glance-summary");

  if (totalKpi) totalKpi.textContent = total.toLocaleString();
  if (dayKpi) dayKpi.textContent = day.toLocaleString();
  if (confKpi) confKpi.textContent = total > 0 ? `${(conf * 100).toFixed(1)}%` : "-";
  if (totalSub) totalSub.textContent = `Target 50,000 | ${totalPct.toFixed(1)}% complete`;
  if (daySub) daySub.textContent = `Target 5,000/day | ${dayPct.toFixed(1)}% (${momentumText})`;
  if (confSub) confSub.textContent = total > 0
    ? `Target 55%+ | ${(conf * 100).toFixed(1)}% current`
    : "Need telemetry before confidence can be measured";
  if (levelKpi) {
    levelKpi.textContent = level.label;
    levelKpi.className = `ml-kpi-level level-${level.key}`;
  }
  if (levelSub) levelSub.textContent = level.hint;

  const uploadTotal = Number(mlCaptureStats.uploadSuccessTotal || 0) + Number(mlCaptureStats.uploadFailTotal || 0);
  const uploadPct = uploadTotal > 0 ? (Number(mlCaptureStats.uploadSuccessTotal || 0) / uploadTotal) * 100 : 0;

  setMlBar("ml-health-total-fill", "ml-health-total-text", (total / 50000) * 100, `${total.toLocaleString()} / 50,000`);
  setMlBar("ml-health-24h-fill", "ml-health-24h-text", (day / 5000) * 100, `${day.toLocaleString()} / 5,000`);
  setMlBar("ml-health-confidence-fill", "ml-health-confidence-text", (conf / 0.55) * 100, `${(conf * 100).toFixed(1)}% / 55%`);
  setMlBar(
    "ml-health-upload-fill",
    "ml-health-upload-text",
    uploadPct,
    uploadTotal > 0 ? `${uploadPct.toFixed(1)}% success (${uploadTotal.toLocaleString()} uploads)` : "No uploads yet"
  );

  if (glance) {
    glance.innerHTML = `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Data Level</span>
          <span class="round-row-meta"><span class="round-badge round-open">${level.label}</span> ${escHtml(level.hint)}</span>
        </div>
      </div>
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Active Model</span>
          <span class="round-row-meta"><span class="round-badge ${hasModel ? "round-open" : "round-locked"}">${hasModel ? "ACTIVE" : "NONE"}</span> ${escHtml(activeModel || "none")}</span>
        </div>
      </div>
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Latest Telemetry</span>
          <span class="round-row-meta">${latestTs ? `${new Date(latestTs).toLocaleString()} (${fmtAgo(latestTs)})` : "No telemetry yet"}</span>
        </div>
      </div>
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Collection Momentum</span>
          <span class="round-row-meta"><span class="round-badge ${day >= 5000 ? "round-open" : "round-locked"}">${day >= 5000 ? "ON TRACK" : "LOW"}</span> ${momentumText}</span>
        </div>
      </div>
    `;
  }
}

function initMlDatasetUrlField() {
  const datasetEl = document.getElementById("ml-dataset-yaml");
  if (!datasetEl) return;
  const saved = localStorage.getItem(ML_DATASET_URL_STORAGE_KEY) || "";
  const current = String(datasetEl.value || "").trim();
  if (!current) {
    datasetEl.value = saved || DEFAULT_ML_DATASET_YAML_URL;
  }
}

function persistMlDatasetUrl(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return;
  localStorage.setItem(ML_DATASET_URL_STORAGE_KEY, normalized);
}

function initAdminSections() {
  const navBtns = Array.from(document.querySelectorAll(".admin-nav-btn"));
  const panels = Array.from(document.querySelectorAll(".admin-panel"));
  if (!navBtns.length || !panels.length) return;

  const storageKey = "whitelinez.admin.active_panel";
  const normalize = (value) => String(value || "").replace(/^#?panel-?/, "").trim();
  const show = (panelName) => {
    const target = normalize(panelName);
    navBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.panel === target));
    panels.forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${target}`));
    localStorage.setItem(storageKey, target);
    window.dispatchEvent(new CustomEvent("admin:panel-change", { detail: { panel: target } }));
    if (target === "overview") {
      setTimeout(() => window.AdminLine?.refresh?.(), 0);
      setTimeout(() => window.AdminLine?.refresh?.(), 180);
    }
  };

  const fromHash = normalize(window.location.hash);
  const saved = normalize(localStorage.getItem(storageKey));
  const initial = fromHash || saved || "overview";
  show(initial);

  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => show(btn.dataset.panel));
  });
}

function renderHealthOverview(health, errMsg = "") {
  const box = document.getElementById("health-overview");
  if (!box) return;
  if (!health) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">/health unavailable${errMsg ? ` (${errMsg})` : ""}</p>`;
    return;
  }

  const statusText = (ok) => ok ? "OK" : "Down";
  const dot = (ok) => `<span class="health-dot ${ok ? "ok" : "down"}"></span>${statusText(ok)}`;
  const weather = health.weather_api || {};
  const weatherStatus = String(weather.status || "not_checked");
  const weatherOk = weatherStatus === "ok";
  const weatherLabel =
    weatherStatus === "ok" ? "OK" :
    weatherStatus === "stale" ? "Stale" :
    weatherStatus === "error" ? "Error" : "Not checked";
  const weatherAge = Number.isFinite(Number(weather.cache_age_sec))
    ? `${Number(weather.cache_age_sec)}s ago`
    : "-";
  const weatherMeta = weather?.latest
    ? `${String(weather.latest.lighting || "-")} / ${String(weather.latest.weather || "-")}`
    : (weather.last_error ? "fetch failed" : "waiting");

  const publicWs = Number(health.public_ws_connections || 0);
  const authWs = Number(health.user_ws_connections || 0);
  const totalWs = Number(health.total_ws_connections || (publicWs + Number(health.user_ws_sockets || 0)));
  const runtimeVisits = Number(health.public_ws_total_visits || 0);
  const wsBar = Math.max(0, Math.min(100, totalWs * 6));
  const visitBar = Math.max(0, Math.min(100, runtimeVisits > 0 ? Math.log10(runtimeVisits + 1) * 25 : 0));
  const watchdogOk = Boolean(health.watchdog_task_running);
  const restartCounts = health.watchdog_restart_counts || {};
  const restartTotal =
    Number(restartCounts.refresh || 0) +
    Number(restartCounts.ai || 0) +
    Number(restartCounts.round || 0) +
    Number(restartCounts.resolver || 0) +
    Number(restartCounts.ml_retrain || 0);

  box.innerHTML = `
    <div class="health-grid">
      <div class="health-item">
        <p class="health-item-title">API</p>
        <p class="health-item-value">${dot(health.status === "ok")}</p>
      </div>
      <div class="health-item">
        <p class="health-item-title">AI Task</p>
        <p class="health-item-value">${dot(Boolean(health.ai_task_running))}</p>
      </div>
      <div class="health-item">
        <p class="health-item-title">Refresh Task</p>
        <p class="health-item-value">${dot(Boolean(health.refresh_task_running))}</p>
      </div>
      <div class="health-item">
        <p class="health-item-title">Round Task</p>
        <p class="health-item-value">${dot(Boolean(health.round_task_running))}</p>
      </div>
      <div class="health-item">
        <p class="health-item-title">Resolver Task</p>
        <p class="health-item-value">${dot(Boolean(health.resolver_task_running))}</p>
      </div>
      <div class="health-item">
        <p class="health-item-title">Auto Recovery</p>
        <p class="health-item-value">${dot(watchdogOk)} <span class="muted">${restartTotal.toLocaleString()} restarts</span></p>
      </div>
      <div class="health-item">
        <p class="health-item-title">Stream URL</p>
        <p class="health-item-value">${dot(Boolean(health.stream_configured ?? health.stream_url))}</p>
      </div>
      <div class="health-item">
        <p class="health-item-title">AI Heartbeat</p>
        <p class="health-item-value">${dot(!Boolean(health.ai_heartbeat_stale))} <span class="muted">${health.ai_last_frame_age_sec == null ? "-" : `${Number(health.ai_last_frame_age_sec).toFixed(1)}s`}</span></p>
      </div>
      <div class="health-item">
        <p class="health-item-title">AI FPS</p>
        <p class="health-item-value">${Number(health.ai_fps_estimate || 0).toFixed(2)} fps <span class="muted">${Number(health.ai_frames_total || 0).toLocaleString()} frames</span></p>
      </div>
      <div class="health-item">
        <p class="health-item-title">Public WS / User WS</p>
        <p class="health-item-value">${publicWs} / ${authWs} users</p>
        <div class="health-inline-bar"><span style="width:${wsBar}%"></span></div>
      </div>
      <div class="health-item">
        <p class="health-item-title">Public Visits (Runtime)</p>
        <p class="health-item-value">${runtimeVisits.toLocaleString()}</p>
        <div class="health-inline-bar"><span style="width:${visitBar}%"></span></div>
      </div>
      <div class="health-item">
        <p class="health-item-title">Active Round</p>
        <p class="health-item-value">${health.active_round_id ? `${String(health.active_round_status || "active").toUpperCase()} (${String(health.active_round_id).slice(0, 8)}...)` : "none"}</p>
      </div>
      <div class="health-item">
        <p class="health-item-title">Weather API</p>
        <p class="health-item-value"><span class="health-dot ${weatherOk ? "ok" : "down"}"></span>${weatherLabel} (${weatherAge})</p>
      </div>
      <div class="health-item">
        <p class="health-item-title">Weather Snapshot</p>
        <p class="health-item-value">${weatherMeta}</p>
      </div>
    </div>
  `;
}

function shortUserAgent(raw) {
  const value = String(raw || "").trim();
  if (!value) return "-";
  return value.length > 58 ? `${value.slice(0, 58)}...` : value;
}

function fmtConnectedAt(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "-";
  }
}

async function loadActiveUsers() {
  const box = document.getElementById("active-users-list");
  if (!box || !adminSession) return;

  try {
    const data = await fetchAudienceSnapshot();
    if (!data) throw new Error("No audience payload");
    const online = data?.online_now || {};
    const visits = data?.visit_totals || {};
    const db = data?.db || {};
    const publicClients = Array.isArray(data?.active_public_clients) ? data.active_public_clients : [];
    const authUsers = Array.isArray(data?.active_authenticated_users) ? data.active_authenticated_users : [];
    const recentEvents = Array.isArray(data?.recent_events) ? data.recent_events.slice(-6).reverse() : [];
    const guestRecent = Array.isArray(db?.guest_recent) ? db.guest_recent.slice(0, 10) : [];
    const topPages = Array.isArray(db?.site_views_top_pages_24h) ? db.site_views_top_pages_24h.slice(0, 10) : [];
    const recentViews = Array.isArray(db?.site_views_recent) ? db.site_views_recent.slice(0, 10) : [];
    const recentUsers = Array.isArray(db?.registered_users_recent) ? db.registered_users_recent.slice(0, 10) : [];

    const publicRows = publicClients.slice(0, 8).map((entry) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Guest/Public WS</span>
          <span class="round-row-meta">${escHtml(entry.ip || "-")} | ${fmtConnectedAt(entry.connected_at)} | ${escHtml(shortUserAgent(entry.user_agent))}</span>
        </div>
      </div>
    `).join("");

    const authRows = authUsers.slice(0, 8).map((entry) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">User ${escHtml(String(entry.user_id || "").slice(0, 8))}... (${Number(entry.socket_count || 0)} sockets)</span>
          <span class="round-row-meta">Last ${fmtConnectedAt(entry.last_connected_at)} | IPs: ${escHtml((entry.ips || []).join(", ") || "-")}</span>
        </div>
      </div>
    `).join("");

    const eventRows = recentEvents.map((event) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">${escHtml(String(event.channel || "").toUpperCase())} ${escHtml(String(event.event || "").toUpperCase())}</span>
          <span class="round-row-meta">${fmtConnectedAt(event.at)} | ${escHtml(event.ip || "-")}</span>
        </div>
      </div>
    `).join("");

    const recentUserRows = recentUsers.map((user) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">${escHtml(user.username || "user")} (${escHtml(String(user.user_id || "").slice(0, 8))}...)</span>
          <span class="round-row-meta">updated ${fmtAgo(user.updated_at || user.created_at)}</span>
        </div>
      </div>
    `).join("");

    const guestRows = guestRecent.map((guest) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">${escHtml(guest.username || guest.guest_id || "guest")} (${Number(guest.messages || 0)} msgs)</span>
          <span class="round-row-meta">last ${fmtAgo(guest.last_seen)} | ${escHtml(String(guest.last_message || "").slice(0, 70))}</span>
        </div>
      </div>
    `).join("");

    const topPageRows = topPages.map((p) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">${escHtml(p.page_path || "/")}</span>
          <span class="round-row-meta">${Number(p.views || 0).toLocaleString()} views (24h)</span>
        </div>
      </div>
    `).join("");

    const recentViewRows = recentViews.map((view) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">${escHtml(view.page_path || "/")} (${escHtml(view.source || "web")})</span>
          <span class="round-row-meta">${fmtAgo(view.viewed_at)} | ${escHtml(view.user_id ? "user" : (view.guest_id || "guest"))}</span>
        </div>
      </div>
    `).join("");

    box.innerHTML = `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Online Now</span>
          <span class="round-row-meta">Public ${Number(online.public_ws_connections || 0)} | Auth Users ${Number(online.account_ws_users || 0)} | Total WS ${Number(online.total_ws_connections || 0)}</span>
        </div>
      </div>
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Visit Totals (Runtime)</span>
          <span class="round-row-meta">Public ${Number(visits.public_ws_connections_total || 0).toLocaleString()} | Account ${Number(visits.account_ws_connections_total || 0).toLocaleString()} | Combined ${Number(visits.combined_ws_connections_total || 0).toLocaleString()}</span>
        </div>
      </div>
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">DB Audience Totals</span>
          <span class="round-row-meta">Users ${Number(db.registered_users_total || 0).toLocaleString()} | Guests ${Number(db.guests_total || 0).toLocaleString()} (${Number(db.guests_24h || 0).toLocaleString()} / 24h) | Views ${Number(db.site_views_total || 0).toLocaleString()} (${Number(db.site_views_24h || 0).toLocaleString()} / 24h)</span>
        </div>
      </div>
      ${recentUserRows || `<p class="muted" style="font-size:0.82rem;">No registered user history.</p>`}
      ${guestRows || `<p class="muted" style="font-size:0.82rem;">No guest history yet.</p>`}
      ${topPageRows || `<p class="muted" style="font-size:0.82rem;">No site-view page stats yet.</p>`}
      ${recentViewRows || `<p class="muted" style="font-size:0.82rem;">No site-view history yet.</p>`}
      ${publicRows || `<p class="muted" style="font-size:0.82rem;">No active public clients.</p>`}
      ${authRows || `<p class="muted" style="font-size:0.82rem;">No active authenticated users.</p>`}
      ${eventRows || `<p class="muted" style="font-size:0.82rem;">No recent connect/disconnect events.</p>`}
    `;
  } catch (e) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">Active user feed unavailable.</p>`;
  }
}

async function fetchAudienceSnapshot(force = false) {
  const now = Date.now();
  if (!force && audienceSnapshot && now - audienceSnapshotAt < 8000) {
    return audienceSnapshot;
  }
  const headers = await getAdminHeaders();
  const res = await fetch("/api/admin/set-role?mode=active-users", { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  audienceSnapshot = data || {};
  audienceSnapshotAt = now;
  return audienceSnapshot;
}

function _audSourceFilter() {
  const el = document.getElementById("aud-source-filter");
  const v = String(el?.value || "all").trim().toLowerCase();
  return v || "all";
}

function _renderAudienceTopPages(topPages, recentViews, sourceFilter) {
  const box = document.getElementById("aud-top-pages");
  if (!box) return;
  let pages = Array.isArray(topPages) ? [...topPages] : [];

  if (sourceFilter !== "all") {
    const counts = {};
    (recentViews || [])
      .filter((row) => String(row?.source || "").toLowerCase() === sourceFilter)
      .forEach((row) => {
        const path = String(row?.page_path || "/").trim() || "/";
        counts[path] = (counts[path] || 0) + 1;
      });
    pages = Object.entries(counts)
      .map(([page_path, views]) => ({ page_path, views }))
      .sort((a, b) => Number(b.views || 0) - Number(a.views || 0))
      .slice(0, 10);
  }

  if (!pages.length) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">No page stats for this filter.</p>`;
    return;
  }
  const maxViews = Math.max(...pages.map((p) => Number(p.views || 0)), 1);
  box.innerHTML = pages
    .map((p) => {
      const views = Number(p.views || 0);
      const width = Math.max(6, Math.round((views / maxViews) * 100));
      return `
        <div class="aud-page-row">
          <span class="aud-page-label" title="${escHtml(p.page_path || "/")}">${escHtml(p.page_path || "/")}</span>
          <span class="aud-page-value">${views.toLocaleString()}</span>
          <div class="aud-page-bar"><div class="aud-page-fill" style="width:${width}%"></div></div>
        </div>
      `;
    })
    .join("");
}

function _renderAudienceRecentViews(recentViews, sourceFilter) {
  const box = document.getElementById("aud-recent-views");
  if (!box) return;
  const rows = (recentViews || [])
    .filter((row) => sourceFilter === "all" || String(row?.source || "").toLowerCase() === sourceFilter)
    .slice(0, 14);

  if (!rows.length) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">No recent views for this filter.</p>`;
    return;
  }

  box.innerHTML = rows
    .map((view) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">${escHtml(view.page_path || "/")} <span class="round-badge round-upcoming">${escHtml(view.source || "web")}</span></span>
          <span class="round-row-meta">${fmtAgo(view.viewed_at)} | ${escHtml(view.user_id ? "registered-user" : (view.guest_id || "guest"))}</span>
        </div>
      </div>
    `)
    .join("");
}

function _renderAudienceGuests(guestRecent) {
  const box = document.getElementById("aud-guest-activity");
  if (!box) return;
  const rows = (guestRecent || []).slice(0, 14);
  if (!rows.length) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">No guest activity yet.</p>`;
    return;
  }
  box.innerHTML = rows
    .map((guest) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">${escHtml(guest.username || guest.guest_id || "guest")} <span class="round-badge round-open">${Number(guest.messages || 0)} msgs</span></span>
          <span class="round-row-meta">last ${fmtAgo(guest.last_seen)} | ${escHtml(String(guest.last_message || "").slice(0, 90))}</span>
        </div>
      </div>
    `)
    .join("");
}

function _renderAudienceUsers(users) {
  const box = document.getElementById("aud-registered-users");
  if (!box) return;
  const rows = (users || []).slice(0, 14);
  if (!rows.length) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">No registered user activity yet.</p>`;
    return;
  }
  box.innerHTML = rows
    .map((user) => `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">${escHtml(user.username || "user")} (${escHtml(String(user.user_id || "").slice(0, 8))}...)</span>
          <span class="round-row-meta">updated ${fmtAgo(user.updated_at || user.created_at)}</span>
        </div>
      </div>
    `)
    .join("");
}

async function loadAudiencePanel(force = false) {
  if (!adminSession) return;
  try {
    const data = await fetchAudienceSnapshot(force);
    const db = data?.db || {};
    const sourceFilter = _audSourceFilter();
    const topPages = Array.isArray(db?.site_views_top_pages_24h) ? db.site_views_top_pages_24h : [];
    const recentViews = Array.isArray(db?.site_views_recent) ? db.site_views_recent : [];
    const guestRecent = Array.isArray(db?.guest_recent) ? db.guest_recent : [];
    const recentUsers = Array.isArray(db?.registered_users_recent) ? db.registered_users_recent : [];

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    setText("aud-kpi-views-total", Number(db.site_views_total || 0).toLocaleString());
    setText("aud-kpi-views-24h", Number(db.site_views_24h || 0).toLocaleString());
    setText("aud-kpi-guests-total", Number(db.guests_total || 0).toLocaleString());
    setText("aud-kpi-guests-24h", Number(db.guests_24h || 0).toLocaleString());
    setText("aud-kpi-users-total", Number(db.registered_users_total || 0).toLocaleString());

    _renderAudienceTopPages(topPages, recentViews, sourceFilter);
    _renderAudienceRecentViews(recentViews, sourceFilter);
    _renderAudienceGuests(guestRecent);
    _renderAudienceUsers(recentUsers);
  } catch (e) {
    const ids = ["aud-top-pages", "aud-recent-views", "aud-guest-activity", "aud-registered-users"];
    ids.forEach((id) => {
      const box = document.getElementById(id);
      if (box) box.innerHTML = `<p class="muted" style="font-size:0.82rem;">Audience data unavailable.</p>`;
    });
  }
}

async function loadMlProgress() {
  const totalEl = document.getElementById("ml-points-total");
  const dayEl = document.getElementById("ml-points-24h");
  const confEl = document.getElementById("ml-conf-avg");
  const modelEl = document.getElementById("ml-model-active");
  const fillEl = document.getElementById("ml-progress-fill");
  const pctEl = document.getElementById("ml-progress-text");
  const hintEl = document.getElementById("ml-progress-hint");
  const lastSeenBox = document.getElementById("ml-last-seen");
  if (!totalEl || !dayEl || !confEl || !modelEl || !fillEl || !pctEl || !hintEl || !lastSeenBox) return;

  try {
    const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();

    const [{ count: totalRows }, { count: rows24h }, recentResp, activeModelResp, lastJobsResp] = await Promise.all([
      window.sb.from("ml_detection_events").select("id", { count: "exact", head: true }),
      window.sb.from("ml_detection_events").select("id", { count: "exact", head: true }).gte("captured_at", since24h),
      window.sb
        .from("ml_detection_events")
        .select("captured_at, avg_confidence, detections_count, model_name")
        .order("captured_at", { ascending: false })
        .limit(120),
      window.sb
        .from("ml_model_registry")
        .select("model_name, status, promoted_at")
        .eq("status", "active")
        .order("promoted_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      window.sb
        .from("ml_training_jobs")
        .select("job_type, status, created_at, completed_at, notes")
        .order("created_at", { ascending: false })
        .limit(3),
    ]);

    const rows = recentResp?.data || [];
    const avgConf = rows.length
      ? rows.reduce((s, r) => s + Number(r.avg_confidence || 0), 0) / rows.length
      : 0;
    const latest = rows[0] || null;

    const total = Number(totalRows || 0);
    const dayCount = Number(rows24h || 0);
    const readinessPct = Math.max(0, Math.min(100, Math.round((Math.min(dayCount, 5000) / 5000) * 100)));
    const activeModel = activeModelResp?.data?.model_name ? String(activeModelResp.data.model_name) : "none";

    totalEl.textContent = total.toLocaleString();
    dayEl.textContent = dayCount.toLocaleString();
    confEl.textContent = rows.length ? `${(avgConf * 100).toFixed(1)}%` : "-";
    modelEl.textContent = activeModel;
    fillEl.style.width = `${readinessPct}%`;
    pctEl.textContent = `${readinessPct}%`;
    hintEl.textContent = `Last 24h target: 5,000 rows. Current: ${dayCount.toLocaleString()} rows.`;
    renderMlVisualSummary(total, dayCount, avgConf, activeModel, latest?.captured_at || null);

    const lastJob = (lastJobsResp?.data || [])[0];
    const failReason = getTrainingFailureReason(lastJob);
    lastSeenBox.innerHTML = `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Last Telemetry</span>
          <span class="round-row-meta">${latest ? `${new Date(latest.captured_at).toLocaleString()} (${fmtAgo(latest.captured_at)})` : "No data yet"}</span>
        </div>
      </div>
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Last Model Used</span>
          <span class="round-row-meta">${latest?.model_name || "-"}</span>
        </div>
      </div>
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Last Training Job</span>
          <span class="round-row-meta">${escHtml(formatTrainingJobSummary(lastJob))}</span>
        </div>
      </div>
      ${
        failReason
          ? `<div class="round-row"><div class="round-row-info"><span class="round-row-id">Failure Reason</span><span class="round-row-meta">${escHtml(failReason)}</span></div></div>`
          : ""
      }
    `;
  } catch (e) {
    totalEl.textContent = "-";
    dayEl.textContent = "-";
    confEl.textContent = "-";
    modelEl.textContent = "-";
    fillEl.style.width = "0%";
    pctEl.textContent = "0%";
    hintEl.textContent = "ML tables unavailable. Run latest schema migration.";
    lastSeenBox.innerHTML = `<p class="muted" style="font-size:0.82rem;">ML telemetry unavailable.</p>`;
    renderMlVisualSummary(0, 0, 0, "none", null);
  }
}

async function loadMlUsage() {
  const usageBox = document.getElementById("ml-usage");
  if (!usageBox || !adminSession) return;

  try {
    const [jobsRes, modelsRes] = await Promise.all([
      fetch("/api/admin/ml-jobs?limit=5", {
        headers: await getAdminHeaders(),
      }),
      fetch("/api/admin/ml-models?limit=5", {
        headers: await getAdminHeaders(),
      }),
    ]);

    const jobsPayload = await jobsRes.json().catch(() => ({}));
    const modelsPayload = await modelsRes.json().catch(() => ({}));
    if (!jobsRes.ok) throw new Error(jobsPayload?.detail || jobsPayload?.error || "Failed to load jobs");
    if (!modelsRes.ok) throw new Error(modelsPayload?.detail || modelsPayload?.error || "Failed to load models");

    const jobs = jobsPayload?.jobs || [];
    const models = modelsPayload?.models || [];
    const lastJob = jobs[0];
    const lastModel = models[0];
    const failReason = getTrainingFailureReason(lastJob);

    usageBox.innerHTML = `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Last Training Job</span>
          <span class="round-row-meta">${escHtml(formatTrainingJobSummary(lastJob))}</span>
        </div>
      </div>
      ${
        failReason
          ? `<div class="round-row"><div class="round-row-info"><span class="round-row-id">Failure Reason</span><span class="round-row-meta">${escHtml(failReason)}</span></div></div>`
          : ""
      }
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Last Model Entry</span>
          <span class="round-row-meta">${lastModel ? `${lastModel.model_name || "-"} | ${String(lastModel.status || "-").toUpperCase()} | ${fmtAgo(lastModel.created_at)}` : "No model entries yet"}</span>
        </div>
      </div>
    `;
  } catch (e) {
    usageBox.innerHTML = `<p class="muted" style="font-size:0.82rem;">ML usage unavailable.</p>`;
  }
}

async function loadMlCaptureStatus() {
  const box = document.getElementById("ml-capture-log");
  if (!box || !adminSession) return;

  try {
    const res = await fetch("/api/admin/ml-capture-status?limit=30", {
      headers: await getAdminHeaders(),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to load capture logs");

    const events = payload?.events || [];
    latestCaptureUploadError = events
      .slice()
      .reverse()
      .find((evt) => evt?.event === "upload_failed") || null;
    const classes = (payload?.capture_classes || []).join(", ") || "-";
    const captureState = payload?.capture_enabled ? "ON" : "OFF";
    const uploadState = payload?.upload_enabled ? "ON" : "OFF";
    capturePaused = !!payload?.capture_paused;
    mlCaptureStats = {
      captureTotal: Number(payload?.capture_total || 0),
      uploadSuccessTotal: Number(payload?.upload_success_total || 0),
      uploadFailTotal: Number(payload?.upload_fail_total || 0),
    };
    const pauseBtn = document.getElementById("btn-toggle-capture-pause");
    if (pauseBtn) {
      pauseBtn.textContent = capturePaused ? "Resume Capture" : "Pause Capture";
    }

    const rows = events.slice().reverse().slice(0, 40).map((evt) => {
      const ts = evt?.ts ? `${new Date(evt.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} (${fmtAgo(evt.ts)})` : "-";
      const msg = escHtml(evt?.message || evt?.event || "event");
      const meta = evt?.meta ? escHtml(JSON.stringify(evt.meta, null, 2)) : "";
      const badgeClass = evt?.event === "upload_failed" ? "round-locked" : "round-open";
      return `
        <div class="round-row">
          <div class="round-row-info">
            <span class="round-row-id">${ts}</span>
            <span class="round-row-meta"><span class="round-badge ${badgeClass}">${escHtml(evt?.event || "event")}</span> ${msg}</span>
            ${meta ? `<details class="log-meta"><summary>Details</summary><pre>${meta}</pre></details>` : ""}
          </div>
        </div>
      `;
    }).join("");

    box.innerHTML = `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Live Capture</span>
          <span class="round-row-meta">Capture: ${captureState} | Upload: ${uploadState} | Paused: ${capturePaused ? "YES" : "NO"} | Classes: ${escHtml(classes)}</span>
        </div>
      </div>
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Counters</span>
          <span class="round-row-meta">${mlCaptureStats.captureTotal.toLocaleString()} saved | ${mlCaptureStats.uploadSuccessTotal.toLocaleString()} uploaded | ${mlCaptureStats.uploadFailTotal.toLocaleString()} failed</span>
        </div>
      </div>
      ${rows || `<p class="muted" style="font-size:0.82rem;">No capture events yet.</p>`}
    `;

    // Keep dashboard bars in sync when capture/upload counters change.
    const total = Number(document.getElementById("ml-points-total")?.textContent?.replace(/,/g, "") || 0);
    const day = Number(document.getElementById("ml-points-24h")?.textContent?.replace(/,/g, "") || 0);
    const confText = String(document.getElementById("ml-conf-avg")?.textContent || "0").replace("%", "");
    const conf = Number(confText) / 100;
    const model = document.getElementById("ml-model-active")?.textContent || "none";
    renderMlVisualSummary(total, day, Number.isFinite(conf) ? conf : 0, model, null);
  } catch (e) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">Capture logs unavailable.</p>`;
  }
}

async function copyLatestCaptureError() {
  const msgEl = document.getElementById("ml-capture-copy-msg");
  if (!msgEl) return;

  if (!latestCaptureUploadError) {
    msgEl.style.color = "var(--muted)";
    msgEl.textContent = "No upload_failed event yet.";
    return;
  }

  const payload = {
    ts: latestCaptureUploadError.ts || null,
    event: latestCaptureUploadError.event || "upload_failed",
    message: latestCaptureUploadError.message || "",
    meta: latestCaptureUploadError.meta || {},
  };
  const text = JSON.stringify(payload, null, 2);

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (!ok) throw new Error("clipboard unavailable");
    }
    msgEl.style.color = "var(--green)";
    msgEl.textContent = "Copied latest upload error.";
  } catch {
    msgEl.style.color = "var(--red)";
    msgEl.textContent = "Copy failed. Open browser console logs.";
  }
}

async function toggleCapturePause() {
  const btn = document.getElementById("btn-toggle-capture-pause");
  const msgEl = document.getElementById("ml-capture-pause-msg");
  if (!btn || !adminSession) return;

  const nextPaused = !capturePaused;
  btn.disabled = true;
  if (msgEl) {
    msgEl.style.color = "var(--muted)";
    msgEl.textContent = nextPaused ? "Pausing capture..." : "Resuming capture...";
  }

  try {
    const res = await fetch("/api/admin/ml-capture-status", {
      method: "PATCH",
      headers: await getAdminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ paused: nextPaused }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to update capture state");
    capturePaused = !!payload?.capture_paused;
    if (msgEl) {
      msgEl.style.color = "var(--green)";
      msgEl.textContent = capturePaused ? "Capture paused." : "Capture resumed.";
    }
    await loadMlCaptureStatus();
  } catch (e) {
    if (msgEl) {
      msgEl.style.color = "var(--red)";
      msgEl.textContent = e?.message || "Could not update capture state.";
    }
  } finally {
    btn.disabled = false;
  }
}

async function handleMlRetrain() {
  const btn = document.getElementById("btn-ml-retrain");
  const msg = document.getElementById("ml-control-msg");
  const datasetEl = document.getElementById("ml-dataset-yaml");
  const epochsEl = document.getElementById("ml-epochs");
  const imgszEl = document.getElementById("ml-imgsz");
  const batchEl = document.getElementById("ml-batch");
  if (!btn || !msg || !adminSession) return;

  const dataset_yaml_url = String(datasetEl?.value || "").trim();
  const epochs = Number(epochsEl?.value || 20);
  const imgsz = Number(imgszEl?.value || 640);
  const batch = Number(batchEl?.value || 16);
  if (!dataset_yaml_url) {
    msg.textContent = "Dataset YAML URL is required.";
    msg.style.color = "var(--red)";
    return;
  }
  persistMlDatasetUrl(dataset_yaml_url);

  btn.disabled = true;
  msg.textContent = "Starting retrain...";
  msg.style.color = "var(--muted)";

  try {
    const res = await fetch("/api/admin/ml-jobs", {
      method: "POST",
      headers: await getAdminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        dataset_yaml_url,
        epochs: Number.isFinite(epochs) ? epochs : 20,
        imgsz: Number.isFinite(imgsz) ? imgsz : 640,
        batch: Number.isFinite(batch) ? batch : 16,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to trigger retrain");

    msg.textContent = payload?.message || "Retrain triggered.";
    msg.style.color = "var(--green)";
    loadMlUsage();
    loadMlProgress();
  } catch (e) {
    try {
      const check = await fetch("/api/admin/ml-jobs?limit=1", {
        headers: await getAdminHeaders(),
      });
      const checkPayload = await check.json().catch(() => ({}));
      const latest = (checkPayload?.jobs || [])[0];
      if (check.ok && latest?.job_type === "train" && latest?.status === "running") {
        msg.textContent = "Training is running. Status may take a while to update.";
        msg.style.color = "var(--green)";
      } else {
        msg.textContent = e?.message || "Retrain failed.";
        msg.style.color = "var(--red)";
      }
    } catch {
      msg.textContent = e?.message || "Retrain failed.";
      msg.style.color = "var(--red)";
    }
  } finally {
    btn.disabled = false;
  }
}

async function handleMlTrainCaptures() {
  const btn = document.getElementById("btn-ml-train-captures");
  const msg = document.getElementById("ml-control-msg");
  const epochsEl = document.getElementById("ml-epochs");
  const imgszEl = document.getElementById("ml-imgsz");
  const batchEl = document.getElementById("ml-batch");
  if (!btn || !msg || !adminSession) return;

  const epochs = Number(epochsEl?.value || 20);
  const imgsz = Number(imgszEl?.value || 640);
  const batch = Number(batchEl?.value || 16);

  btn.disabled = true;
  msg.textContent = "Starting live-capture training...";
  msg.style.color = "var(--muted)";

  try {
    const res = await fetch("/api/admin/ml-jobs?action=train-captures", {
      method: "POST",
      headers: await getAdminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        epochs: Number.isFinite(epochs) ? epochs : 20,
        imgsz: Number.isFinite(imgsz) ? imgsz : 640,
        batch: Number.isFinite(batch) ? batch : 16,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to queue live-capture training");

    msg.textContent = payload?.message || "Live-capture training queued.";
    msg.style.color = "var(--green)";
    loadMlUsage();
    loadMlProgress();
  } catch (e) {
    msg.textContent = e?.message || "Live-capture training failed.";
    msg.style.color = "var(--red)";
  } finally {
    btn.disabled = false;
  }
}

// ── Recent rounds ─────────────────────────────────────────────────────────────
async function loadRecentRounds() {
  const container = document.getElementById("recent-rounds");
  if (!container) return;

  try {
    const { data } = await window.sb
      .from("bet_rounds")
      .select("id, status, market_type, opens_at, ends_at")
      .order("opens_at", { ascending: false })
      .limit(10);

    if (!data || data.length === 0) {
      container.innerHTML = `<p class="muted" style="font-size:0.85rem">No rounds yet.</p>`;
      return;
    }

    container.innerHTML = data.map(r => {
      const d = new Date(r.opens_at);
      const timeStr = d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
      const canResolve = r.status === "locked" || r.status === "resolved";
      const resolveLabel = r.status === "resolved" ? "Override" : "Resolve";
      return `
        <div class="round-row">
          <div class="round-row-info">
            <span class="round-row-id">${r.id.slice(0,8)}…</span>
            <span class="round-row-meta">
              <span class="round-badge round-${r.status}">${r.status.toUpperCase()}</span>
              ${r.market_type.replace(/_/g," ")} · ${timeStr}
            </span>
          </div>
          ${canResolve ? `<button class="btn-resolve" data-round-id="${r.id}">${resolveLabel}</button>` : ""}
        </div>`;
    }).join("");

    // Resolve buttons
    container.querySelectorAll(".btn-resolve").forEach(btn => {
      btn.addEventListener("click", () => resolveRound(btn.dataset.roundId, btn));
    });

  } catch (e) {
    console.warn("[admin-init] Recent rounds load failed:", e);
  }
}

function formatBetDescriptor(b) {
  if (b.bet_type === "exact_count") {
    const cls = b.vehicle_class ? `${b.vehicle_class}s` : "vehicles";
    const win = b.window_duration_sec ? `${b.window_duration_sec}s` : "window";
    return `Exact ${b.exact_count ?? 0} ${cls} in ${win}`;
  }
  const market = b.markets || {};
  const odds = Number(market.odds || 0);
  const oddsText = odds > 0 ? `${odds.toFixed(2)}x` : "-";
  return `${market.label || "Market bet"} (${oddsText})`;
}

function formatBetDebugInfo(b) {
  const baseline = Number(b.baseline_count || 0);
  const actual = b.actual_count == null ? null : Number(b.actual_count || 0);
  const ws = b.window_start ? new Date(b.window_start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
  const dur = Number(b.window_duration_sec || 0);
  const windowLabel = ws && dur > 0 ? `${ws} + ${dur}s` : null;
  const parts = [`baseline ${baseline.toLocaleString()}`];
  if (windowLabel) parts.push(`window ${windowLabel}`);
  if (actual != null) parts.push(`actual ${actual.toLocaleString()}`);
  return parts.join(" • ");
}

function formatValidationReasonLabel(reason) {
  const text = String(reason || "").trim();
  if (!text) return "Unknown";
  return text.length > 88 ? `${text.slice(0, 88)}...` : text;
}

async function loadBetValidationStatus() {
  const box = document.getElementById("bet-validation-status");
  if (!box || !adminSession) return;

  try {
    const res = await fetch("/api/admin/bets?mode=validation-status", {
      headers: await getAdminHeaders(),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to load validation status");

    const accepted = Number(payload?.accepted_total || 0);
    const rejected = Number(payload?.rejected_total || 0);
    const total = Number(payload?.total_evaluated || accepted + rejected);
    const rejectRate = total > 0 ? (rejected / total) * 100 : 0;
    const lastEvent = payload?.last_event_at ? fmtAgo(payload.last_event_at) : "no events yet";
    const reasonsObj = (payload?.reasons && typeof payload.reasons === "object") ? payload.reasons : {};
    const reasonRows = Object.entries(reasonsObj)
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .slice(0, 6);

    const reasonsHtml = reasonRows.length
      ? reasonRows.map(([reason, count]) => (
          `<div class="round-row-meta"><span class="muted">${formatValidationReasonLabel(reason)}</span> - ${Number(count || 0).toLocaleString()}</div>`
        )).join("")
      : `<div class="round-row-meta"><span class="muted">No rejection reasons recorded yet.</span></div>`;

    box.innerHTML = `
      <div class="round-row">
        <div class="round-row-info">
          <span class="round-row-id">Accepted ${accepted.toLocaleString()} • Rejected ${rejected.toLocaleString()} • Checked ${total.toLocaleString()}</span>
          <span class="round-row-meta">Reject rate ${rejectRate.toFixed(1)}% • Last event ${lastEvent}</span>
          ${reasonsHtml}
        </div>
      </div>
    `;
  } catch (e) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">Validation status unavailable.</p>`;
  }
}

async function loadRecentBets() {
  const box = document.getElementById("recent-bets");
  if (!box || !adminSession) return;

  try {
    const res = await fetch("/api/admin/bets?limit=200", {
      headers: await getAdminHeaders(),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to load bets");

    const bets = payload?.bets || [];
    if (!bets.length) {
      box.innerHTML = `<p class="muted" style="font-size:0.82rem;">No bets found.</p>`;
      return;
    }

    box.innerHTML = bets.slice(0, 120).map((b) => {
      const userLabel = b.username || (b.user_id ? `${String(b.user_id).slice(0, 8)}…` : "unknown");
      const placed = b.placed_at
        ? new Date(b.placed_at).toLocaleString([], { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "—";
      return `
        <div class="round-row">
          <div class="round-row-info">
            <span class="round-row-id">${userLabel} • ${placed}</span>
              <span class="round-row-meta">
                <span class="round-badge round-${b.status}">${String(b.status || "pending").toUpperCase()}</span>
                ${formatBetDescriptor(b)} • Stake ${Number(b.amount || 0).toLocaleString()} • Payout ${Number(b.potential_payout || 0).toLocaleString()}
                <br><span class="muted" style="font-size:0.78rem;">${formatBetDebugInfo(b)}</span>
              </span>
            </div>
          </div>
      `;
    }).join("");
  } catch (e) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">Recent bets unavailable.</p>`;
  }
}

async function resolveRound(roundId, btn) {
  if (!adminSession) return;
  btn.disabled = true;
  btn.textContent = "Resolving...";
  try {
    const res = await fetch(`/api/admin/rounds`, {
      method: "PATCH",
      headers: await getAdminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ round_id: roundId }),
    });
    if (res.ok) {
      loadRecentRounds();
    } else {
      btn.textContent = "Error";
      btn.disabled = false;
    }
  } catch {
    btn.textContent = "Error";
    btn.disabled = false;
  }
}

// ── Preview update ────────────────────────────────────────────────────────────
async function updatePreview() {
  const marketType = document.getElementById("market-type")?.value;
  const vehicleClass = document.getElementById("vehicle-class")?.value;
  const threshold = parseInt(document.getElementById("threshold")?.value || "0", 10);

  const preview = document.getElementById("round-preview");
  const prevDur = document.getElementById("prev-duration");
  const prevRate = document.getElementById("prev-rate");
  const prevExpRow = document.getElementById("prev-expected-row");
  const prevExp = document.getElementById("prev-expected");
  const prevWarn = document.getElementById("prev-warning");
  const prevOk = document.getElementById("prev-ok");
  const submitBtn = document.getElementById("round-submit-btn");
  const ctRow = document.getElementById("computed-times");
  const ctCloses = document.getElementById("computed-closes");
  const ctEnds = document.getElementById("computed-ends");

  const times = getComputedTimes();
  if (!times) {
    preview?.classList.add("hidden");
    if (ctRow) ctRow.style.display = "none";
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  const { starts, ends, closes, duration } = times;
  if (ctRow) ctRow.style.display = "";
  if (ctCloses) ctCloses.textContent = fmtLocal(closes);
  if (ctEnds) ctEnds.textContent = fmtLocal(ends);

  preview?.classList.remove("hidden");
  if (prevDur) prevDur.textContent = fmtDurationMin(duration);

  await loadBaseline();
  const baseline = getBaselineForHour(starts);
  const avgPerMin = baseline?.avg_per_min ?? null;
  const stdPerMin = baseline?.std_per_min ?? null;
  const avgConf = baseline?.avg_conf ?? null;

  if (prevRate) {
    prevRate.textContent = avgPerMin !== null
      ? `~${avgPerMin.toFixed(1)} / min (${baseline.sample_count} samples${avgConf != null ? `, ${(avgConf * 100).toFixed(1)}% conf` : ""})`
      : "No telemetry profile for this hour yet";
  }

  prevWarn?.classList.add("hidden");
  prevOk?.classList.add("hidden");
  const warnings = [];

  if (duration < MIN_DURATION_MIN) warnings.push(`Too short - minimum is ${MIN_DURATION_MIN} minutes.`);
  if (duration > MAX_DURATION_MIN) warnings.push(`Too long - maximum is ${MAX_DURATION_MIN} minutes.`);

  if (marketType === "over_under" || marketType === "vehicle_count") {
    prevExpRow?.classList.remove("hidden");

    const classShare = marketType === "vehicle_count"
      ? (baseline?.class_share?.[vehicleClass] ?? CLASS_RATE_FALLBACK[vehicleClass] ?? 0.25)
      : 1.0;

    const guardrailMin = Math.max(1, Math.ceil(duration * THRESHOLD_MIN_PER_MIN * classShare));
    const guardrailMax = Math.max(5, Math.floor(duration * THRESHOLD_MAX_PER_MIN * classShare));

    let minThresh = guardrailMin;
    let maxThresh = guardrailMax;
    let expectedText = `${guardrailMin}-${guardrailMax}`;

    if (avgPerMin !== null) {
      const mean = Math.max(1, avgPerMin * duration * classShare);
      const sigma = Math.max(Math.sqrt(mean), (stdPerMin ?? 0) * duration * classShare);
      const lowData = Math.max(1, Math.floor(mean - 1.2 * sigma));
      const highData = Math.max(lowData + 1, Math.ceil(mean + 1.2 * sigma));
      minThresh = Math.max(guardrailMin, lowData);
      maxThresh = Math.min(guardrailMax, highData);
      if (minThresh > maxThresh) {
        minThresh = guardrailMin;
        maxThresh = guardrailMax;
      }
      expectedText = `${minThresh}-${maxThresh} (from telemetry, mean ${Math.round(mean)})`;
    }

    if (prevExp) prevExp.textContent = expectedText;

    const typeLabel = marketType === "vehicle_count"
      ? `for ${vehicleClass}s in ${fmtDurationMin(duration)}`
      : `for ${fmtDurationMin(duration)}`;

    if (!isNaN(threshold)) {
      if (threshold < minThresh) warnings.push(`Threshold ${threshold} too low ${typeLabel}. Min: ${minThresh}.`);
      else if (threshold > maxThresh) warnings.push(`Threshold ${threshold} too high ${typeLabel}. Max: ${maxThresh}.`);
    }
  } else {
    prevExpRow?.classList.add("hidden");
  }

  if (warnings.length) {
    if (prevWarn) {
      prevWarn.innerHTML = warnings.map((w) => `<div>WARN: ${w}</div>`).join("");
      prevWarn.classList.remove("hidden");
    }
    if (submitBtn) submitBtn.disabled = true;
  } else if (duration >= MIN_DURATION_MIN) {
    if (prevOk) {
      const quality = avgConf == null
        ? "using telemetry range"
        : `using ${(avgConf * 100).toFixed(1)}% avg confidence profile`;
      prevOk.textContent = `Round looks competitive - ${quality}`;
      prevOk.classList.remove("hidden");
    }
    if (submitBtn) submitBtn.disabled = false;
  }
}
function buildMarkets(marketType, vehicleClass, threshold) {
  if (marketType === "over_under") {
    return [
      { label: `Over ${threshold} vehicles`,    outcome_key: "over",  odds: 1.85 },
      { label: `Under ${threshold} vehicles`,   outcome_key: "under", odds: 1.85 },
      { label: `Exactly ${threshold} vehicles`, outcome_key: "exact", odds: 15.0 },
    ];
  }
  if (marketType === "vehicle_count") {
    const label = { car:"cars", truck:"trucks", bus:"buses", motorcycle:"motorcycles" }[vehicleClass] ?? vehicleClass;
    return [
      { label: `Over ${threshold} ${label}`,    outcome_key: "over",  odds: 1.85 },
      { label: `Under ${threshold} ${label}`,   outcome_key: "under", odds: 1.85 },
      { label: `Exactly ${threshold} ${label}`, outcome_key: "exact", odds: 15.0 },
    ];
  }
  if (marketType === "vehicle_type") {
    return [
      { label: "Cars lead",        outcome_key: "car",        odds: 2.00 },
      { label: "Trucks lead",      outcome_key: "truck",      odds: 3.50 },
      { label: "Buses lead",       outcome_key: "bus",        odds: 4.00 },
      { label: "Motorcycles lead", outcome_key: "motorcycle", odds: 5.00 },
    ];
  }
  return [];
}

async function loadRoundSessions() {
  const box = document.getElementById("session-list");
  const statusEl = document.getElementById("session-status");
  if (!box || !adminSession) return;
  try {
    const res = await fetch("/api/admin/rounds?mode=sessions&limit=20", {
      headers: await getAdminHeaders(),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to load sessions");
    const sessions = payload?.sessions || [];
    if (!sessions.length) {
      box.innerHTML = `<p class="muted" style="font-size:0.82rem;">No active sessions.</p>`;
      if (statusEl) statusEl.textContent = "";
      return;
    }
    box.innerHTML = sessions.map((s) => {
      const status = String(s.status || "active");
      const next = s.next_round_at ? `${new Date(s.next_round_at).toLocaleString()} (${fmtInOrAgo(s.next_round_at)})` : "n/a";
      const th = s.threshold != null ? `T${s.threshold}` : "no-threshold";
      const vc = s.vehicle_class ? ` ${s.vehicle_class}` : "";
      return `
        <div class="round-row">
          <div class="round-row-info">
            <span class="round-row-id">${String(s.id).slice(0, 8)}... <span class="round-badge round-${status === "active" ? "open" : "locked"}">${status.toUpperCase()}</span></span>
            <span class="round-row-meta">${s.market_type}${vc} • ${th} • next ${next} • rounds ${Number(s.created_rounds || 0)}${s.max_rounds ? "/" + s.max_rounds : ""}</span>
          </div>
          ${status === "active" ? `<button class="btn-resolve btn-stop-session" data-id="${s.id}">Stop</button>` : ""}
        </div>
      `;
    }).join("");
    box.querySelectorAll(".btn-stop-session").forEach((btn) => {
      btn.addEventListener("click", () => stopRoundSession(btn.dataset.id, btn));
    });
    if (statusEl) statusEl.textContent = "";
  } catch (e) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">Sessions unavailable: ${escHtml(e?.message || "unknown error")}</p>`;
    if (statusEl) statusEl.textContent = e?.message || "Could not load sessions.";
  }
}

async function stopRoundSession(sessionId, btn) {
  if (!adminSession || !sessionId) return;
  const statusEl = document.getElementById("session-status");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Stopping...";
  try {
    const res = await fetch(`/api/admin/rounds?mode=session-stop&id=${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: await getAdminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to stop session");
    if (statusEl) statusEl.textContent = "Session stopped.";
    await loadRoundSessions();
  } catch (e) {
    if (statusEl) statusEl.textContent = e?.message || "Could not stop session.";
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function handleStartSession() {
  const statusEl = document.getElementById("session-status");
  if (statusEl) statusEl.textContent = "";
  if (!adminSession) return;

  const marketType = document.getElementById("market-type")?.value;
  const vehicleClass = document.getElementById("vehicle-class")?.value;
  const threshold = parseInt(document.getElementById("threshold")?.value || "0", 10);
  const duration = parseInt(document.getElementById("duration")?.value || "10", 10);
  const cutoff = parseInt(document.getElementById("bet-cutoff")?.value || "1", 10);
  const sessionDuration = parseInt(document.getElementById("session-duration")?.value || "120", 10);
  const intervalMin = parseInt(document.getElementById("session-interval")?.value || "2", 10);
  const maxRoundsRaw = parseInt(document.getElementById("session-max-rounds")?.value || "", 10);
  const maxRounds = Number.isFinite(maxRoundsRaw) ? maxRoundsRaw : null;
  if (!Number.isFinite(duration) || duration < 5) {
    if (statusEl) statusEl.textContent = "Round duration must be at least 5 minutes.";
    return;
  }
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff >= duration) {
    if (statusEl) statusEl.textContent = "Bet cutoff must be less than round duration.";
    return;
  }
  if (!Number.isFinite(sessionDuration) || sessionDuration < duration) {
    if (statusEl) statusEl.textContent = "Session duration must be >= round duration.";
    return;
  }

  const cameraId = await resolveActiveCameraId();
  if (!cameraId) {
    if (statusEl) statusEl.textContent = "No active camera found.";
    return;
  }

  const body = {
    camera_id: cameraId,
    market_type: marketType,
    threshold: (marketType === "over_under" || marketType === "vehicle_count") ? threshold : null,
    vehicle_class: marketType === "vehicle_count" ? vehicleClass : null,
    round_duration_min: duration,
    bet_cutoff_min: cutoff,
    interval_min: intervalMin,
    session_duration_min: sessionDuration,
    max_rounds: maxRounds,
  };

  try {
    const res = await fetch("/api/admin/rounds?mode=sessions", {
      method: "POST",
      headers: await getAdminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to start session");
    if (statusEl) statusEl.textContent = "Session started. Rounds will auto-loop.";
    await loadRoundSessions();
  } catch (e) {
    if (statusEl) statusEl.textContent = e.message || "Could not start session.";
  }
}

// ── Form submission ───────────────────────────────────────────────────────────
async function handleSubmit(e) {
  e.preventDefault();
  const errorEl   = document.getElementById("round-error");
  const successEl = document.getElementById("round-success");
  const btn       = document.getElementById("round-submit-btn");
  errorEl.textContent = "";
  successEl.textContent = "";
  btn.disabled = true;

  const jwt = adminSession;
  if (!jwt) return;

  const marketType   = document.getElementById("market-type").value;
  const vehicleClass = document.getElementById("vehicle-class").value;
  const threshold    = parseInt(document.getElementById("threshold").value, 10);
  const times        = getComputedTimes();
  if (!times) { errorEl.textContent = "Fill in start time and duration."; btn.disabled = false; return; }

  const { starts, ends, closes } = times;
  const cameraId = await resolveActiveCameraId();
  if (!cameraId) { errorEl.textContent = "No active camera found."; btn.disabled = false; return; }
  try {
    const zoneReady = await ensureCountZoneSaved(cameraId);
    if (!zoneReady) {
      errorEl.textContent = "Save a valid count area first. Round creation is blocked until count zone is set.";
      btn.disabled = false;
      return;
    }
  } catch {
    errorEl.textContent = "Could not validate count area. Try again.";
    btn.disabled = false;
    return;
  }

  const markets = buildMarkets(marketType, vehicleClass, threshold);
  const params  = {
    threshold,
    vehicle_class: marketType === "vehicle_count" ? vehicleClass : undefined,
    duration_sec: Math.floor((ends - starts) / 1000),
  };

  try {
    const res = await fetch("/api/admin/rounds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        camera_id: cameraId,
        market_type: marketType,
        params,
        opens_at:  starts.toISOString(),
        closes_at: closes.toISOString(),
        ends_at:   ends.toISOString(),
        markets,
      }),
    });

    if (!res.ok) { const err = await res.json(); throw new Error(err.detail || "Failed"); }

    successEl.textContent = "Round created! Auto-opens at scheduled time.";
    document.getElementById("round-form").reset();
    document.getElementById("round-preview")?.classList.add("hidden");
    document.getElementById("computed-times").style.display = "none";
    setDefaultTimes();
    loadRecentRounds();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ── User management ───────────────────────────────────────────────────────────
async function handleSetAdmin() {
  const emailEl = document.getElementById("admin-email-input");
  const msgEl   = document.getElementById("user-mgmt-msg");
  const email   = emailEl?.value?.trim();
  if (!email) return;
  if (!adminSession) return;
  msgEl.textContent = "Setting...";
  try {
    // Use Supabase admin RPC or update user_metadata
    // This calls an RPC set_admin_by_email if available, otherwise shows a note
    const { error } = await window.sb.rpc("set_admin_by_email", { p_email: email });
    if (error) throw error;
    msgEl.style.color = "var(--green)";
    msgEl.textContent = `Admin role set for ${email}`;
    loadRegisteredUsers();
  } catch (e) {
    msgEl.style.color = "var(--red)";
    msgEl.textContent = e.message || "Failed — ensure set_admin_by_email RPC exists";
  }
}

async function fetchAllAdminUsers(jwt) {
  const perPage = 200;
  const maxPages = 10;
  const byId = new Map();

  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetch(`/api/admin/set-role?page=${page}&per_page=${perPage}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to load users");

    const pageUsers = Array.isArray(payload?.users) ? payload.users : [];
    for (const u of pageUsers) {
      const key = String(u?.id || "").trim();
      if (!key) continue;
      if (!byId.has(key)) byId.set(key, u);
    }

    if (pageUsers.length < perPage) break;
  }

  return Array.from(byId.values());
}

async function loadRegisteredUsers() {
  const box = document.getElementById("registered-users");
  if (!box || !adminSession) return;

  try {
    const jwt = await getAdminJwt();
    if (!jwt) throw new Error("Admin session expired");
    const users = await fetchAllAdminUsers(jwt);
    if (!users.length) {
      box.innerHTML = `<p class="muted" style="font-size:0.82rem;">No registered users found.</p>`;
      return;
    }

    box.innerHTML = users.map((u) => {
      const email = escHtml(u.email || "no-email");
      const uid = escHtml(String(u.id || "").slice(0, 8));
      const roleValue = String(u.role || "user").toLowerCase();
      const role = escHtml(roleValue.toUpperCase());
      const roleClass = roleValue === "admin" ? "round-open" : "round-upcoming";
      const username = u.username ? `@${escHtml(String(u.username))}` : "";
      const created = u.created_at
        ? new Date(u.created_at).toLocaleString([], {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "-";
      const lastSignIn = u.last_sign_in_at ? fmtAgo(u.last_sign_in_at) : "never";

      const bs = u.bet_summary || {};
      const betCount = Number(bs.bet_count || 0);
      const totalStaked = Number(bs.total_staked || 0);
      const wonCount = Number(bs.won_count || 0);
      const lostCount = Number(bs.lost_count || 0);
      const pendingCount = Number(bs.pending_count || 0);
      const lastBetLabel = bs.last_bet_label ? escHtml(String(bs.last_bet_label)) : "None";
      const lastBetAmount = Number(bs.last_bet_amount || 0).toLocaleString();
      const lastBetStatus = escHtml(String(bs.last_bet_status || "-").toUpperCase());
      const lastBetAt = bs.last_bet_at ? fmtAgo(bs.last_bet_at) : "never";

      return `
        <div class="user-card">
          <div class="user-card-top">
            <div>
              <p class="user-email">${email}</p>
              <p class="user-meta">${username ? `${username} | ` : ""}ID ${uid}... | Joined ${created} | Last sign-in ${lastSignIn}</p>
            </div>
            <span class="round-badge ${roleClass}">${role}</span>
          </div>
          <p class="user-stats">Bets ${betCount} | Staked ${totalStaked.toLocaleString()} | W ${wonCount} | L ${lostCount} | P ${pendingCount}</p>
          <p class="user-latest">Latest: ${lastBetLabel} | Stake ${lastBetAmount} | ${lastBetStatus} | ${lastBetAt}</p>
        </div>
      `;
    }).join("");
  } catch (e) {
    box.innerHTML = `<p class="muted" style="font-size:0.82rem;">Users list unavailable.</p>`;
  }
}
function setDefaultTimes() {
  const now = new Date(); now.setSeconds(0, 0);
  const starts = new Date(now.getTime() + 60_000);
  const pad = (n) => String(n).padStart(2, "0");
  const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const el = document.getElementById("starts-at");
  if (el) el.value = toLocal(starts);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  adminSession = await Auth.requireAdmin("/index.html");
  if (!adminSession) return;
  initMlDatasetUrlField();
  initDetectionStudio();

  const cameraId = await resolveActiveCameraId();
  activeCameraId = cameraId || null;

  const video  = document.getElementById("admin-video");
  const canvas = document.getElementById("line-canvas");
  await Stream.init(video);
  AdminLine.init(video, canvas, cameraId);
  await loadCameraFeedAppearance();

  // Load stats + recent rounds
  loadBaseline();
  loadStats();
  connectAdminLiveStatsWs();
  loadMlProgress();
  loadMlUsage();
  loadMlCaptureStatus();
  loadBetValidationStatus();
  loadRecentRounds();
  loadRecentBets();
  loadRoundSessions();
  loadRegisteredUsers();
  loadActiveUsers();
  loadAudiencePanel(true);
  setInterval(loadStats, 10_000);
  setInterval(loadMlProgress, 15_000);
  setInterval(loadMlUsage, 20_000);
  setInterval(loadMlCaptureStatus, 8_000);
  setInterval(loadBetValidationStatus, 8_000);
  setInterval(loadRecentBets, 15_000);
  setInterval(loadRoundSessions, 15_000);
  setInterval(loadRegisteredUsers, 30_000);
  setInterval(loadActiveUsers, 10_000);
  setInterval(loadAudiencePanel, 12_000);
}

document.addEventListener("DOMContentLoaded", () => {
  initAdminSections();
  document.getElementById("btn-logout")?.addEventListener("click", () => Auth.logout());
  document.getElementById("round-form")?.addEventListener("submit", handleSubmit);
  document.getElementById("btn-set-admin")?.addEventListener("click", handleSetAdmin);
  document.getElementById("btn-session-start")?.addEventListener("click", handleStartSession);
  document.getElementById("btn-ml-retrain")?.addEventListener("click", handleMlRetrain);
  document.getElementById("btn-ml-train-captures")?.addEventListener("click", handleMlTrainCaptures);
  document.getElementById("btn-toggle-capture-pause")?.addEventListener("click", toggleCapturePause);
  document.getElementById("btn-copy-capture-error")?.addEventListener("click", copyLatestCaptureError);
  document.getElementById("aud-refresh-btn")?.addEventListener("click", () => loadAudiencePanel(true));
  document.getElementById("aud-source-filter")?.addEventListener("change", () => loadAudiencePanel(false));
  window.addEventListener("admin:panel-change", (e) => {
    const panel = String(e?.detail?.panel || "");
    if (panel === "audience") loadAudiencePanel(true);
    if (panel === "banners") { window.AdminBanners?.init(); window.AdminBanners?.load(); }
    if (panel === "streams") { window.AdminStreams?.init(); }
  });

  // initAdminSections() fires admin:panel-change before the listener above is registered.
  // Re-trigger any panel that needs lazy loading for the initial active panel.
  {
    const _initPanel = localStorage.getItem("whitelinez.admin.active_panel") || "overview";
    if (_initPanel === "audience") loadAudiencePanel(true);
    if (_initPanel === "banners") { window.AdminBanners?.init(); window.AdminBanners?.load(); }
    if (_initPanel === "streams") { window.AdminStreams?.init(); }
  }

  // Market type visibility
  document.getElementById("market-type")?.addEventListener("change", (e) => {
    const type = e.target.value;
    document.getElementById("threshold-field").style.display  = type === "vehicle_type" ? "none" : "";
    document.getElementById("vehicle-class-field").style.display = type === "vehicle_count" ? "" : "none";
    const lbl = document.getElementById("threshold-label");
    if (lbl) lbl.textContent = type === "vehicle_count" ? "Threshold (vehicles of that type)" : "Threshold (vehicles)";
    updatePreview();
  });

  ["market-type","vehicle-class","threshold","starts-at","duration","bet-cutoff"].forEach(id => {
    document.getElementById(id)?.addEventListener("input",  updatePreview);
    document.getElementById(id)?.addEventListener("change", updatePreview);
  });

  setDefaultTimes();
  updatePreview();
});

init();


// ML panel pipeline sync (keeps new workflow cards updated from live admin data)
(function mlPipelineSyncInit() {
  function text(id) {
    const el = document.getElementById(id);
    return el ? String(el.textContent || "").trim() : "";
  }

  function set(id, value) {
    const el = document.getElementById(id);
    if (el && value) el.textContent = value;
  }

  function parseLatestTrainingText(rawText) {
    const textValue = String(rawText || "").trim();
    if (!textValue) return "No training job found";
    const parts = textValue.split("/");
    if (parts.length < 2) return textValue;
    const jobType = String(parts[0] || "").trim();
    const statusWithTime = String(parts.slice(1).join("/") || "").trim();
    return `${jobType.toUpperCase()} | ${statusWithTime}`;
  }

  function syncMlPipelineCards() {
    const total = text("ml-points-total") || text("ml-kpi-total") || "-";
    const day = text("ml-points-24h") || text("ml-kpi-24h") || "-";
    const model = text("ml-model-active") || "none";
    const modelText = model && model !== "-" && model.toLowerCase() !== "none"
      ? model
      : "No active model selected";

    set("ml-pipe-dataset-value", `${total} total | ${day} in last 24h`);
    set("ml-pipe-model-value", modelText);

    const usage = document.getElementById("ml-usage");
    if (usage) {
      const firstMeta = usage.querySelector(".round-row .round-row-meta");
      if (firstMeta && firstMeta.textContent) {
        set("ml-pipe-training-value", parseLatestTrainingText(firstMeta.textContent.trim()));
      }
    }

    const captureState = (window.mlCaptureStats || mlCaptureStats || {});
    const saved = Number(captureState.captureTotal || 0);
    const upOk = Number(captureState.uploadSuccessTotal || 0);
    const upFail = Number(captureState.uploadFailTotal || 0);
    if (saved > 0 || upOk > 0 || upFail > 0) {
      set("ml-pipe-capture-value", `${saved.toLocaleString()} saved | ${upOk.toLocaleString()} uploaded | ${upFail.toLocaleString()} failed`);
    }
  }

  setInterval(syncMlPipelineCards, 2500);
  setTimeout(syncMlPipelineCards, 300);
})();
// ML pipeline stage health badges (live)
(function mlPipelineStageHealthInit() {
  const STAGE_ACTIONS = {
    capture: { target: "ml-sec-capture", hint: "Open Capture Logs" },
    dataset: { target: "ml-sec-kpis", hint: "Open Dataset KPI" },
    training: { target: "ml-sec-night", hint: "Open Training Controls" },
    model: { target: "ml-sec-oneclick", hint: "Open One-Click Model Pipeline" },
  };

  function openMlSection(targetId) {
    document.querySelector('.admin-nav-btn[data-panel="ml"]')?.click();
    document.querySelector(`#ml-subnav .ml-subnav-btn[data-target="${targetId}"]`)?.click();
  }

  function updateCardActionability(stage) {
    const card = document.getElementById(`ml-pipeline-${stage}`);
    const action = STAGE_ACTIONS[stage];
    if (!card || !action) return;

    const inactive = !card.classList.contains("status-ok");
    card.classList.toggle("is-actionable", inactive);
    card.setAttribute("tabindex", inactive ? "0" : "-1");
    card.setAttribute("role", "button");
    card.setAttribute("aria-disabled", inactive ? "false" : "true");
    card.title = inactive ? `${action.hint} (click)` : "";
  }

  function wireCardActions() {
    Object.keys(STAGE_ACTIONS).forEach((stage) => {
      const card = document.getElementById(`ml-pipeline-${stage}`);
      if (!card || card.dataset.wiredAction === "1") return;
      card.dataset.wiredAction = "1";

      const runAction = () => {
        if (!card.classList.contains("is-actionable")) return;
        const action = STAGE_ACTIONS[stage];
        openMlSection(action.target);

        if (stage === "training") {
          const retrainBtn = document.getElementById("btn-ml-retrain");
          if (retrainBtn) {
            retrainBtn.click();
          }
        }

        if (stage === "model") {
          const oneClickBtn = document.getElementById("btn-ml-one-click");
          if (oneClickBtn) {
            oneClickBtn.click();
          }
        }
      };

      card.addEventListener("click", runAction);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          runAction();
        }
      });
    });
  }

  function readNum(id) {
    const el = document.getElementById(id);
    if (!el) return NaN;
    const n = Number(String(el.textContent || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : NaN;
  }

  function setStage(stage, status, label) {
    const card = document.getElementById(`ml-pipeline-${stage}`);
    const badge = document.getElementById(`ml-pipe-${stage}-badge`);
    if (!card || !badge) return;

    card.classList.remove("status-ok", "status-warn", "status-fail");
    badge.classList.remove("status-ok", "status-warn", "status-fail");

    const finalStatus = ["ok", "warn", "fail"].includes(status) ? status : "warn";
    card.classList.add(`status-${finalStatus}`);
    badge.classList.add(`status-${finalStatus}`);
    badge.textContent = label || (finalStatus === "ok" ? "Healthy" : finalStatus === "fail" ? "Failed" : "Warning");
  }

  function syncStageHealth() {
    const cap = (window.mlCaptureStats || mlCaptureStats || {});
    const saved = Number(cap.captureTotal || 0);
    const upOk = Number(cap.uploadSuccessTotal || 0);
    const upFail = Number(cap.uploadFailTotal || 0);
    const upTotal = upOk + upFail;
    const upRate = upTotal > 0 ? upOk / upTotal : 0;
    if (saved <= 0) setStage("capture", "warn", "No Data");
    else if (upTotal > 5 && upRate < 0.85) setStage("capture", "fail", "Upload Fail");
    else if (upTotal > 0 && upRate < 0.95) setStage("capture", "warn", "Partial");
    else setStage("capture", "ok", "Healthy");

    const totalRows = readNum("ml-kpi-total");
    const rows24h = readNum("ml-kpi-24h");
    const confTextEl = document.getElementById("ml-kpi-confidence");
    const conf = confTextEl ? Number(String(confTextEl.textContent || "").replace("%", "")) : NaN;
    if (!Number.isFinite(totalRows) || totalRows <= 0) setStage("dataset", "warn", "No Data");
    else if ((rows24h >= 5000) && (Number.isFinite(conf) && conf >= 55)) setStage("dataset", "ok", "Healthy");
    else if (rows24h < 1000) setStage("dataset", "warn", "Low 24h");
    else setStage("dataset", "warn", "Building");

    const trainingValueEl = document.getElementById("ml-pipe-training-value");
    const trainingText = String(trainingValueEl?.textContent || "").toLowerCase();
    if (!trainingText || trainingText.includes("no training jobs")) setStage("training", "warn", "No Jobs");
    else if (trainingText.includes("failed")) setStage("training", "fail", "Failed");
    else if (trainingText.includes("running")) setStage("training", "ok", "Running");
    else if (trainingText.includes("completed")) setStage("training", "ok", "Completed");
    else setStage("training", "warn", "Checking");

    const modelValueEl = document.getElementById("ml-pipe-model-value");
    const modelText = String(modelValueEl?.textContent || "").trim().toLowerCase();
    if (!modelText || modelText === "none" || modelText.includes("no active model")) {
      setStage("model", "warn", "No Model");
    } else {
      setStage("model", "ok", "Active");
    }

    updateCardActionability("capture");
    updateCardActionability("dataset");
    updateCardActionability("training");
    updateCardActionability("model");
  }

  document.addEventListener("DOMContentLoaded", wireCardActions);
  setInterval(syncStageHealth, 2500);
  setTimeout(syncStageHealth, 400);
})();
// One-click ML diagnostics + trigger helpers
(function mlOneClickToolsInit() {
  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function loadMlDiagnosticsPanel() {
    const box = document.getElementById("ml-diagnostics");
    if (!box || !adminSession) return;

    try {
      const res = await fetch("/api/admin/ml-jobs?action=diagnostics", {
        headers: await getAdminHeaders(),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to load diagnostics");

      const checks = payload?.checks || [];
      const latestError = payload?.latest_error || "";
      const ready = Boolean(payload?.ready_for_one_click);
      const summary = payload?.summary || {};

      const rows = checks.map((c) => {
        const isOk = String(c?.status || "") === "ok";
        const badge = isOk ? "round-open" : "round-locked";
        const label = isOk ? "OK" : "BLOCKED";
        return `
          <div class="ml-diag-row">
            <div class="ml-diag-text">
              <p class="ml-diag-name">${esc(c?.name || "Check")}</p>
              <p class="ml-diag-detail">${esc(c?.detail || "")}</p>
            </div>
            <span class="round-badge ${badge}">${label}</span>
          </div>
        `;
      }).join("");

      box.innerHTML = `
        <div class="round-row">
          <div class="round-row-info">
            <span class="round-row-id">Pipeline Readiness</span>
            <span class="round-row-meta"><span class="round-badge ${ready ? "round-open" : "round-locked"}">${ready ? "READY" : "BLOCKED"}</span></span>
          </div>
        </div>
        <div class="round-row">
          <div class="round-row-info">
            <span class="round-row-id">Rows / 24h / Active</span>
            <span class="round-row-meta">${Number(summary.total_rows || 0).toLocaleString()} / ${Number(summary.rows_24h || 0).toLocaleString()} / ${esc(summary.active_model_name || "none")}</span>
          </div>
        </div>
        ${rows || `<p class="muted" style="font-size:0.82rem;">No diagnostics checks yet.</p>`}
        ${latestError ? `<div class="round-row"><div class="round-row-info"><span class="round-row-id">Latest Training Error</span><span class="round-row-meta">${esc(latestError)}</span></div></div>` : ""}
      `;
    } catch (e) {
      box.innerHTML = `<p class="muted" style="font-size:0.82rem;">Diagnostics unavailable.</p>`;
    }
  }

  async function runMlOneClickPipeline() {
    const btn = document.getElementById("btn-ml-one-click");
    const msg = document.getElementById("ml-one-click-msg");
    const datasetEl = document.getElementById("ml-dataset-yaml");
    const epochsEl = document.getElementById("ml-epochs");
    const imgszEl = document.getElementById("ml-imgsz");
    const batchEl = document.getElementById("ml-batch");
    if (!btn || !msg || !adminSession) return;

    const dataset_yaml_url = String(datasetEl?.value || "").trim();
    const epochs = Number(epochsEl?.value || 20);
    const imgsz = Number(imgszEl?.value || 640);
    const batch = Number(batchEl?.value || 16);

    btn.disabled = true;
    msg.style.color = "var(--muted)";
    msg.textContent = "Running one-click pipeline...";

    try {
      const res = await fetch("/api/admin/ml-jobs?action=one-click", {
        method: "POST",
        headers: await getAdminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          dataset_yaml_url,
          epochs: Number.isFinite(epochs) ? epochs : 20,
          imgsz: Number.isFinite(imgsz) ? imgsz : 640,
          batch: Number.isFinite(batch) ? batch : 16,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = payload?.detail;
        if (typeof detail === "string") throw new Error(detail);
        if (detail?.message) throw new Error(detail.message);
        throw new Error(payload?.error || "One-click pipeline failed");
      }

      const state = payload?.result?.status || "completed";
      if (state === "queued") {
        msg.style.color = "var(--green)";
        msg.textContent = "One-click pipeline queued. Watch Latest Jobs for progress.";
      } else if (state === "skipped") {
        msg.style.color = "#f1b37c";
        msg.textContent = payload?.result?.reason || "Pipeline skipped by guardrails.";
      } else {
        msg.style.color = "var(--green)";
        msg.textContent = "One-click pipeline completed.";
      }

      if (typeof loadMlUsage === "function") loadMlUsage();
      if (typeof loadMlProgress === "function") loadMlProgress();
      if (typeof loadMlCaptureStatus === "function") loadMlCaptureStatus();
      await loadMlDiagnosticsPanel();
    } catch (e) {
      msg.style.color = "var(--red)";
      msg.textContent = e?.message || "One-click pipeline failed.";
      await loadMlDiagnosticsPanel();
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("btn-ml-one-click");
    if (btn && !btn.dataset.wiredOneClick) {
      btn.dataset.wiredOneClick = "1";
      btn.addEventListener("click", runMlOneClickPipeline);
    }
    setTimeout(loadMlDiagnosticsPanel, 700);
    setInterval(loadMlDiagnosticsPanel, 20000);
  });
})();










