/**
 * detection-overlay.js — Draws live vehicle bounding boxes on a canvas
 * overlaid on the public stream. Receives detection data via count:update events.
 * Coordinates are content-relative [0,1] and mapped via coord-utils.js,
 * so boxes align correctly regardless of container aspect ratio.
 */

const DetectionOverlay = (() => {
  let canvas, ctx, video;
  let _dpr = 1;
  let latestDetections = [];
  let rafId = null;
  const SETTINGS_KEY = "whitelinez.detection.overlay_settings.v4";
  let pixiApp = null;
  let pixiEnabled = false;
  let isMobileClient = false;
  const pixiGraphicsPool = [];
  const pixiTextPool = [];
  let pixiGraphicsUsed = 0;
  let pixiTextUsed = 0;
  let forceRender = true;
  let lastFrameKey = "";
  let ghostSeq = 0;
  const laneSmoothing = new Map();

  let settings = {
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
    show_ground_plane_public: false,
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
  };
  const outsideGhosts = new Map();

  function detectMobileClient() {
    try {
      const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      const narrow = window.matchMedia && window.matchMedia("(max-width: 980px)").matches;
      const ua = String(navigator.userAgent || "").toLowerCase();
      const uaMobile = /android|iphone|ipad|ipod|mobile|tablet/.test(ua);
      return Boolean(coarse || narrow || uaMobile);
    } catch {
      return false;
    }
  }

  function hexToPixi(hex) {
    const raw = String(hex || "").replace("#", "");
    const safe = raw.length === 3
      ? raw.split("").map((c) => c + c).join("")
      : raw.padEnd(6, "0").slice(0, 6);
    const n = Number.parseInt(safe, 16);
    return Number.isFinite(n) ? n : 0x66bb6a;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      settings = {
        ...settings,
        ...parsed,
        colors: { ...settings.colors, ...(parsed?.colors || {}) },
      };
    } catch {}
  }

  function applySettings(nextSettings) {
    if (!nextSettings || typeof nextSettings !== "object") return;
    settings = {
      ...settings,
      ...nextSettings,
      colors: { ...settings.colors, ...(nextSettings?.colors || {}) },
    };
    forceRender = true;
  }

  function buildFrameKey(detections) {
    if (!Array.isArray(detections) || detections.length === 0) return "empty";
    const lim = Math.min(detections.length, 80);
    let key = `${lim}|`;
    for (let i = 0; i < lim; i += 1) {
      const d = detections[i] || {};
      key += [
        d.tracker_id ?? -1,
        d.cls || "u",
        Number(d.conf || 0).toFixed(2),
        Number(d.x1 || 0).toFixed(3),
        Number(d.y1 || 0).toFixed(3),
        Number(d.x2 || 0).toFixed(3),
        Number(d.y2 || 0).toFixed(3),
        d.in_detect_zone === false ? "0" : "1",
      ].join(",");
      key += ";";
    }
    return key;
  }

  function hexToRgba(hex, alpha) {
    const raw = String(hex || "").replace("#", "");
    const safe = raw.length === 3
      ? raw.split("").map((c) => c + c).join("")
      : raw.padEnd(6, "0").slice(0, 6);
    const n = Number.parseInt(safe, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function getGroundQuadPixels(bounds) {
    const q = settings.ground_quad || {};
    const pts = [
      { x: Number(q.x1), y: Number(q.y1) },
      { x: Number(q.x2), y: Number(q.y2) },
      { x: Number(q.x3), y: Number(q.y3) },
      { x: Number(q.x4), y: Number(q.y4) },
    ];
    if (!pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
    if (!pts.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return null;
    return pts.map((p) => contentToPixel(p.x, p.y, bounds));
  }

  function drawGroundOverlayCanvas(bounds, detections) {
    if (!ctx || settings.ground_overlay_enabled === false) return;
    const quad = getGroundQuadPixels(bounds);
    if (!quad) return;

    const alpha = Math.max(0, Math.min(0.45, Number(settings.ground_overlay_alpha) || 0.16));
    const gridDensity = Math.max(2, Math.min(16, Number(settings.ground_grid_density) || 6));

    const p1 = quad[0];
    const p2 = quad[1];
    const p3 = quad[2];
    const p4 = quad[3];

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();
    ctx.fillStyle = hexToRgba("#17d1ff", alpha * 0.55);
    ctx.fill();
    ctx.strokeStyle = hexToRgba("#33d8ff", Math.min(0.9, alpha + 0.25));
    ctx.lineWidth = 1.25;
    ctx.stroke();

    ctx.strokeStyle = hexToRgba("#36ccff", Math.min(0.9, alpha + 0.14));
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    for (let i = 1; i <= gridDensity; i += 1) {
      const t = i / (gridDensity + 1);
      const pt = Math.pow(t, 1.25);
      const lx = lerp(p1.x, p4.x, pt);
      const ly = lerp(p1.y, p4.y, pt);
      const rx = lerp(p2.x, p3.x, pt);
      const ry = lerp(p2.y, p3.y, pt);
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(rx, ry);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const cxTop = { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
    const cxBot = { x: (p4.x + p3.x) * 0.5, y: (p4.y + p3.y) * 0.5 };
    ctx.strokeStyle = hexToRgba("#86e8ff", Math.min(0.95, alpha + 0.3));
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cxTop.x, cxTop.y);
    ctx.lineTo(cxBot.x, cxBot.y);
    ctx.stroke();

    // Keep the ground projection visually behind overlays; do not punch holes under boxes.
    ctx.restore();
  }

  function drawGroundOverlayPixi(bounds) {
    if (!pixiEnabled || !pixiApp || settings.ground_overlay_enabled === false) return;
    const quad = getGroundQuadPixels(bounds);
    if (!quad) return;
    const alpha = Math.max(0, Math.min(0.45, Number(settings.ground_overlay_alpha) || 0.16));
    const gridDensity = Math.max(2, Math.min(16, Number(settings.ground_grid_density) || 6));
    const colorMain = 0x17d1ff;
    const colorGrid = 0x36ccff;
    const g = getPixiGraphic();
    if (!g) return;

    const p1 = quad[0];
    const p2 = quad[1];
    const p3 = quad[2];
    const p4 = quad[3];

    g.beginFill(colorMain, alpha * 0.55);
    g.moveTo(p1.x, p1.y);
    g.lineTo(p2.x, p2.y);
    g.lineTo(p3.x, p3.y);
    g.lineTo(p4.x, p4.y);
    g.lineTo(p1.x, p1.y);
    g.endFill();

    g.lineStyle(1.25, colorMain, Math.min(0.95, alpha + 0.28));
    g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y);
    g.lineTo(p3.x, p3.y); g.lineTo(p4.x, p4.y); g.lineTo(p1.x, p1.y);

    g.lineStyle(1, colorGrid, Math.min(0.95, alpha + 0.16));
    for (let i = 1; i <= gridDensity; i += 1) {
      const t = i / (gridDensity + 1);
      const pt = Math.pow(t, 1.25);
      const lx = lerp(p1.x, p4.x, pt);
      const ly = lerp(p1.y, p4.y, pt);
      const rx = lerp(p2.x, p3.x, pt);
      const ry = lerp(p2.y, p3.y, pt);
      g.moveTo(lx, ly);
      g.lineTo(rx, ry);
    }

    const cxTop = { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
    const cxBot = { x: (p4.x + p3.x) * 0.5, y: (p4.y + p3.y) * 0.5 };
    g.lineStyle(1.4, 0x86e8ff, Math.min(0.95, alpha + 0.3));
    g.moveTo(cxTop.x, cxTop.y);
    g.lineTo(cxBot.x, cxBot.y);
  }

  function drawCornerBox(x, y, w, h, color, lineWidth) {
    const c = Math.max(6, Math.min(20, Math.floor(Math.min(w, h) * 0.2)));
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
    ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c);
    ctx.moveTo(x + w, y + h - c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - c, y + h);
    ctx.moveTo(x + c, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - c);
    ctx.stroke();
  }

  function drawCornerBoxPixi(g, x, y, w, h, colorNum, lineWidth) {
    const c = Math.max(6, Math.min(20, Math.floor(Math.min(w, h) * 0.2)));
    g.lineStyle(lineWidth, colorNum, 1);
    g.moveTo(x, y + c); g.lineTo(x, y); g.lineTo(x + c, y);
    g.moveTo(x + w - c, y); g.lineTo(x + w, y); g.lineTo(x + w, y + c);
    g.moveTo(x + w, y + h - c); g.lineTo(x + w, y + h); g.lineTo(x + w - c, y + h);
    g.moveTo(x + c, y + h); g.lineTo(x, y + h); g.lineTo(x, y + h - c);
  }

  function canUseUnsafeEval() {
    try {
      // Pixi shader bootstrap uses Function/eval under the hood unless unsafe-eval is allowed.
      // Probe once so we can skip noisy init failures when CSP forbids it.
      // eslint-disable-next-line no-new-func
      const fn = new Function("return 1;");
      return fn() === 1;
    } catch {
      return false;
    }
  }

  function initPixiRenderer() {
    if (!canvas) {
      console.warn("[DetectionOverlay] Pixi init skipped: missing canvas");
      return false;
    }
    if (!window.PIXI) {
      console.warn("[DetectionOverlay] Pixi init skipped: PIXI not loaded (CDN blocked or script failed)");
      return false;
    }
    let hasWebGL = false;
    try {
      const probe = document.createElement("canvas");
      hasWebGL = Boolean(
        probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ||
        probe.getContext("webgl", { failIfMajorPerformanceCaveat: true }) ||
        probe.getContext("experimental-webgl", { failIfMajorPerformanceCaveat: true })
      );
    } catch {
      hasWebGL = false;
    }
    if (!hasWebGL) {
      console.warn("[DetectionOverlay] WebGL unsupported/blocked on this browser context");
    }
    if (!canUseUnsafeEval()) {
      console.warn("[DetectionOverlay] Pixi init skipped: CSP blocks unsafe-eval; using Canvas2D fallback");
      return false;
    }
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    const cssW = Math.max(1, (video?.clientWidth) || 1);
    const cssH = Math.max(1, (video?.clientHeight) || 1);
    const desktopCfg = {
      view: canvas,
      width: cssW,
      height: cssH,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(dpr, 2),
      powerPreference: "high-performance",
      preference: "webgl",
    };
    const mobileCfg = {
      view: canvas,
      width: cssW,
      height: cssH,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(dpr, 2),
      powerPreference: "low-power",
      preference: "webgl",
    };
    const tries = isMobileClient ? [mobileCfg, desktopCfg] : [desktopCfg, mobileCfg];
    try {
      let lastErr = null;
      for (const cfg of tries) {
        try {
          pixiApp = new window.PIXI.Application(cfg);
          pixiEnabled = true;
          const mode = isMobileClient ? "mobile" : "desktop";
          console.info(`[DetectionOverlay] Renderer: WebGL (PixiJS, ${mode})`);
          window.dispatchEvent(new CustomEvent("detection:renderer", { detail: { mode: "webgl", profile: mode } }));
          return true;
        } catch (e) {
          lastErr = e;
          pixiApp = null;
        }
      }
      if (lastErr) {
        console.warn("[DetectionOverlay] Pixi WebGL init failed:", lastErr);
      }
      return false;
    } catch (err) {
      console.warn("[DetectionOverlay] Pixi init failed, falling back to 2D:", err);
      pixiEnabled = false;
      pixiApp = null;
      return false;
    }
  }

  function beginPixiFrame() {
    pixiGraphicsUsed = 0;
    pixiTextUsed = 0;
  }

  function endPixiFrame() {
    for (let i = pixiGraphicsUsed; i < pixiGraphicsPool.length; i += 1) {
      pixiGraphicsPool[i].visible = false;
    }
    for (let i = pixiTextUsed; i < pixiTextPool.length; i += 1) {
      pixiTextPool[i].visible = false;
    }
  }

  function getPixiGraphic() {
    if (!pixiApp) return null;
    if (pixiGraphicsUsed >= pixiGraphicsPool.length) {
      const g = new window.PIXI.Graphics();
      g.visible = false;
      pixiGraphicsPool.push(g);
      pixiApp.stage.addChild(g);
    }
    const g = pixiGraphicsPool[pixiGraphicsUsed];
    pixiGraphicsUsed += 1;
    g.clear();
    g.visible = true;
    return g;
  }

  function getPixiText() {
    if (!pixiApp) return null;
    if (pixiTextUsed >= pixiTextPool.length) {
      const t = new window.PIXI.Text("", {
        fontFamily: "Inter, sans-serif",
        fontSize: 11,
        fill: 0x0d1118,
      });
      t.visible = false;
      pixiTextPool.push(t);
      pixiApp.stage.addChild(t);
    }
    const t = pixiTextPool[pixiTextUsed];
    pixiTextUsed += 1;
    t.visible = true;
    return t;
  }

  function buildGhostKey(det) {
    const tid = Number(det?.tracker_id);
    if (Number.isFinite(tid) && tid >= 0) return `t:${tid}:${String(det?.cls || "vehicle")}`;
    const x1 = Math.round(Number(det?.x1 || 0) * 100);
    const y1 = Math.round(Number(det?.y1 || 0) * 100);
    const x2 = Math.round(Number(det?.x2 || 0) * 100);
    const y2 = Math.round(Number(det?.y2 || 0) * 100);
    return `b:${String(det?.cls || "vehicle")}:${x1}:${y1}:${x2}:${y2}`;
  }

  function centerOf(det) {
    return {
      x: (Number(det?.x1 || 0) + Number(det?.x2 || 0)) * 0.5,
      y: (Number(det?.y1 || 0) + Number(det?.y2 || 0)) * 0.5,
    };
  }

  function findMatchingGhostKey(det) {
    const target = centerOf(det);
    let bestKey = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const [k, v] of outsideGhosts.entries()) {
      const gd = v?.det;
      if (!gd) continue;
      if (String(gd?.cls || "") !== String(det?.cls || "")) continue;
      const c = centerOf(gd);
      const dx = target.x - c.x;
      const dy = target.y - c.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.08 && dist < bestDist) {
        bestDist = dist;
        bestKey = k;
      }
    }
    return bestKey;
  }

  function smoothLaneDetections(detections, now) {
    const out = [];
    for (const det of detections) {
      const tid = Number(det?.tracker_id);
      if (!Number.isFinite(tid) || tid < 0) {
        out.push(det);
        continue;
      }
      const key = `lane:${tid}:${String(det?.cls || "vehicle")}`;
      const prev = laneSmoothing.get(key);
      if (!prev) {
        laneSmoothing.set(key, {
          x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2, ts: now,
        });
        out.push(det);
        continue;
      }
      const alpha = 0.42;
      const sm = {
        ...det,
        x1: prev.x1 + (det.x1 - prev.x1) * alpha,
        y1: prev.y1 + (det.y1 - prev.y1) * alpha,
        x2: prev.x2 + (det.x2 - prev.x2) * alpha,
        y2: prev.y2 + (det.y2 - prev.y2) * alpha,
      };
      laneSmoothing.set(key, {
        x1: sm.x1, y1: sm.y1, x2: sm.x2, y2: sm.y2, ts: now,
      });
      out.push(sm);
    }

    for (const [k, v] of laneSmoothing.entries()) {
      if (!v || Number(v.ts || 0) + 1200 < now) laneSmoothing.delete(k);
    }
    return out;
  }

  function drawDetectionBox(det, bounds, opts = {}) {
    if (pixiEnabled && pixiApp) {
      return drawDetectionBoxPixi(det, bounds, opts);
    }
    if (!ctx) return;
    const p1 = contentToPixel(det.x1, det.y1, bounds);
    const p2 = contentToPixel(det.x2, det.y2, bounds);
    const bw = p2.x - p1.x;
    const bh = p2.y - p1.y;
    if (bw < 4 || bh < 4) return;

    const color = opts.color || settings.colors?.[det.cls] || "#66BB6A";
    const lineWidth = Math.max(1, Number(opts.lineWidth ?? settings.line_width) || 1.5);
    const alpha = Math.max(0, Math.min(0.45, Number(opts.alpha ?? settings.fill_alpha) || 0));
    const doFill = opts.fill !== false;
    const style = String(opts.style || settings.box_style || "solid");
    const showLabels = opts.showLabels !== false;
    const labelText = opts.labelText;

    if (doFill) {
      ctx.fillStyle = hexToRgba(color, alpha);
      ctx.fillRect(p1.x, p1.y, bw, bh);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (style === "dashed") ctx.setLineDash([8, 4]);
    else ctx.setLineDash([]);
    if (style === "corner") drawCornerBox(p1.x, p1.y, bw, bh, color, lineWidth);
    else ctx.strokeRect(p1.x, p1.y, bw, bh);

    if (showLabels) {
      const defaultConf = Number(det?.conf || 0) > 0 ? ` ${(Number(det.conf) * 100).toFixed(0)}%` : "";
      const label = labelText || `${String(det?.cls || "vehicle").toUpperCase()}${defaultConf}`;
      ctx.setLineDash([]);
      ctx.font = "11px Inter, sans-serif";
      const padX = 6;
      const padY = 4;
      const tw = Math.max(30, Math.ceil(ctx.measureText(label).width + padX * 2));
      const th = 18;
      const lx = p1.x;
      const ly = Math.max(2, p1.y - th - 2);
      ctx.fillStyle = hexToRgba(color, opts.labelBgAlpha ?? 0.85);
      ctx.fillRect(lx, ly, tw, th);
      ctx.fillStyle = opts.labelColor || "#0d1118";
      ctx.fillText(label, lx + padX, ly + th - padY);
    }
  }

  function drawDetectionBoxPixi(det, bounds, opts = {}) {
    const g = getPixiGraphic();
    if (!g) return;
    const p1 = contentToPixel(det.x1, det.y1, bounds);
    const p2 = contentToPixel(det.x2, det.y2, bounds);
    const bw = p2.x - p1.x;
    const bh = p2.y - p1.y;
    if (bw < 4 || bh < 4) {
      g.visible = false;
      return;
    }

    const color = opts.color || settings.colors?.[det.cls] || "#66BB6A";
    const colorNum = hexToPixi(color);
    const lineWidth = Math.max(1, Number(opts.lineWidth ?? settings.line_width) || 1.5);
    const alpha = Math.max(0, Math.min(0.45, Number(opts.alpha ?? settings.fill_alpha) || 0));
    const doFill = opts.fill !== false;
    const style = String(opts.style || settings.box_style || "solid");
    const showLabels = opts.showLabels !== false;
    const labelText = opts.labelText;

    if (doFill) {
      g.beginFill(colorNum, alpha);
      g.drawRect(p1.x, p1.y, bw, bh);
      g.endFill();
    }

    if (style === "corner") {
      drawCornerBoxPixi(g, p1.x, p1.y, bw, bh, colorNum, lineWidth);
    } else {
      g.lineStyle(lineWidth, colorNum, 1);
      g.drawRect(p1.x, p1.y, bw, bh);
    }

    if (!showLabels) return;

    const defaultConf = Number(det?.conf || 0) > 0 ? ` ${(Number(det.conf) * 100).toFixed(0)}%` : "";
    const label = labelText || `${String(det?.cls || "vehicle").toUpperCase()}${defaultConf}`;
    const txt = getPixiText();
    if (!txt) return;

    txt.text = label;
    txt.style.fill = hexToPixi(opts.labelColor || "#0d1118");

    const padX = 6;
    const th = 18;
    const tw = Math.max(30, Math.ceil(txt.width + padX * 2));
    const lx = p1.x;
    const ly = Math.max(2, p1.y - th - 2);

    g.beginFill(colorNum, Math.max(0, Math.min(1, Number(opts.labelBgAlpha ?? 0.85))));
    g.drawRect(lx, ly, tw, th);
    g.endFill();

    txt.x = lx + padX;
    txt.y = ly + 2;
  }

  function init(videoEl, canvasEl) {
    video  = videoEl;
    canvas = canvasEl;
    isMobileClient = detectMobileClient();
    loadSettings();

    syncSize();
    if (!initPixiRenderer()) {
      ctx = canvas.getContext("2d");
      ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
      pixiEnabled = false;
      const hasPixi = Boolean(window.PIXI);
      let webglAvailable = false;
      try {
        const probe = document.createElement("canvas");
        webglAvailable = Boolean(
          probe.getContext("webgl2") ||
          probe.getContext("webgl") ||
          probe.getContext("experimental-webgl")
        );
      } catch {
        webglAvailable = false;
      }
      console.info(`[DetectionOverlay] Renderer: Canvas2D fallback (PIXI=${hasPixi}, WebGL=${webglAvailable})`);
      window.dispatchEvent(new CustomEvent("detection:renderer", { detail: { mode: "canvas", profile: isMobileClient ? "mobile" : "desktop" } }));
    }

    window.addEventListener("resize", syncSize);
    video.addEventListener("loadedmetadata", syncSize);

    window.addEventListener("count:update", (e) => {
      latestDetections = e.detail?.detections ?? [];
      const nextKey = buildFrameKey(latestDetections);
      if (nextKey !== lastFrameKey) {
        forceRender = true;
        lastFrameKey = nextKey;
      }
      if (!rafId) {
        rafId = requestAnimationFrame(renderFrame);
      }
    });

    window.addEventListener("detection:settings-update", (e) => {
      applySettings(e.detail);
      if (!rafId) rafId = requestAnimationFrame(renderFrame);
    });
  }

  function renderFrame() {
    rafId = null;
    if (!forceRender) return;
    draw(latestDetections);
  }

  function syncSize() {
    if (!video || !canvas) return;
    _dpr = window.devicePixelRatio || 1;
    const cssW = video.clientWidth;
    const cssH = video.clientHeight;
    if (pixiEnabled && pixiApp?.renderer) {
      // Pixi manages canvas backing store via autoDensity; pass CSS dimensions
      pixiApp.renderer.resize(Math.max(1, cssW), Math.max(1, cssH));
      forceRender = true;
      return;
    }
    const newW = Math.round(cssW * _dpr);
    const newH = Math.round(cssH * _dpr);
    const changed = canvas.width !== newW || canvas.height !== newH;
    canvas.width  = newW;
    canvas.height = newH;
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    if (changed) forceRender = true;
    if (ctx) ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
  }

  function draw(detections) {
    if (!canvas) return;
    if (pixiEnabled) beginPixiFrame();
    else if (ctx) {
      ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
      ctx.clearRect(0, 0, video.clientWidth, video.clientHeight);
    }
    else return;
    const bounds = getContentBounds(video);
    if (settings.show_ground_plane_public === true) {
      if (pixiEnabled) drawGroundOverlayPixi(bounds);
      else drawGroundOverlayCanvas(bounds, detections);
    }
    if (!detections.length) {
      if (pixiEnabled) endPixiFrame();
      return;
    }

    const laneHardCap = isMobileClient ? 12 : 15;
    const laneMaxBoxes = Math.max(1, Math.min(laneHardCap, Number(settings.max_boxes) || 10));
    const laneDetections = [];
    const outsideDetections = [];
    for (const det of detections) {
      if (det?.in_detect_zone === false) outsideDetections.push(det);
      else laneDetections.push(det);
    }

    const liveLane = laneDetections.slice(0, laneMaxBoxes);
    for (const det of liveLane) {
      drawDetectionBox(det, bounds, {
        style: settings.box_style,
        lineWidth: Math.max(1, Number(settings.line_width || 2)),
        alpha: 0,
        fill: false,
        showLabels: settings.show_labels !== false,
        labelBgAlpha: 0.90,
      });
    }

    if (settings.detect_zone_only || settings.outside_scan_enabled === false) {
      if (pixiEnabled) endPixiFrame();
      return;
    }

    const minConf = Math.max(0, Math.min(1, Number(settings.outside_scan_min_conf) || 0.45));
    const outsideHardCap = isMobileClient ? 24 : 35;
    const outsideMax = Math.max(1, Math.min(outsideHardCap, Number(settings.outside_scan_max_boxes) || 25));
    const fresh = outsideDetections
      .filter((d) => Number(d?.conf || 0) >= minConf)
      .sort((a, b) => Number(b?.conf || 0) - Number(a?.conf || 0))
      .slice(0, outsideMax);

    for (const det of fresh) {
      drawDetectionBox(det, bounds, {
        style: "dashed",
        lineWidth: 1.0,
        alpha: 0,
        fill: false,
        showLabels: settings.outside_scan_show_labels === true,
        labelText: "SCAN",
        labelBgAlpha: 0.10,
        labelColor: "#D7E6F5",
      });
    }
    if (pixiEnabled) endPixiFrame();
    forceRender = false;
  }

  return { init };
})();

window.DetectionOverlay = DetectionOverlay;
