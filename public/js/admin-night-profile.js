/**
 * admin-night-profile.js
 * Admin controls for runtime night tracking profile.
 */

(function () {
  const PRESETS = {
    conservative: {
      yolo_conf: 0.36,
      infer_size: 576,
      iou: 0.50,
      max_det: 90,
    },
    aggressive: {
      yolo_conf: 0.24,
      infer_size: 768,
      iou: 0.42,
      max_det: 150,
    },
  };

  function el(id) {
    return document.getElementById(id);
  }

  async function getJwt() {
    const session = await window.Auth?.getSession?.();
    return session?.access_token || null;
  }

  function setMsg(text, ok) {
    const msg = el("night-profile-msg");
    if (!msg) return;
    msg.textContent = text || "";
    if (!text) return;
    msg.style.color = ok ? "var(--green)" : "var(--red)";
  }

  function isNightWindowActive(hour, startHour, endHour) {
    if (startHour === endHour) return true;
    if (startHour < endHour) return hour >= startHour && hour < endHour;
    return hour >= startHour || hour < endHour;
  }

  function fmtAgo(ts) {
    if (!ts) return "-";
    const ms = Date.now() - new Date(ts).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "just now";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }

  function setLiveField(id, value) {
    const node = el(id);
    if (node) node.textContent = value || "-";
  }

  let liveRefreshRunning = false;

  async function refreshNightLiveData() {
    if (liveRefreshRunning) return;
    liveRefreshRunning = true;
    try {
      const enabled = Number(el("night-profile-enabled")?.value || 0) === 1;
      const startHour = Number(el("night-start-hour")?.value || 18);
      const endHour = Number(el("night-end-hour")?.value || 6);
      const now = new Date();
      const activeNow = enabled && isNightWindowActive(now.getHours(), startHour, endHour);

      setLiveField("night-live-now", now.toLocaleString());
      setLiveField("night-live-window-state", enabled ? (activeNow ? "IN NIGHT WINDOW" : "Waiting for window") : "Night profile disabled");
      setLiveField(
        "night-live-thresholds",
        `conf ${Number(el("night-yolo-conf")?.value || 0).toFixed(2)} | iou ${Number(el("night-iou")?.value || 0).toFixed(2)} | size ${Number(el("night-infer-size")?.value || 0)} | max det ${Number(el("night-max-det")?.value || 0)}`
      );

      const summary = el("night-live-summary");
      if (summary) {
        summary.textContent = !enabled
          ? "Night overrides are OFF. Day profile is in use."
          : activeNow
            ? "Night overrides are ACTIVE now. Detector is using night thresholds."
            : "Night profile is enabled but currently outside night hours.";
      }

      const jwt = await getJwt();
      if (!jwt) {
        setLiveField("night-live-counters", "Sign in required");
        setLiveField("night-live-training", "Sign in required");
        setLiveField("night-live-telemetry", "Sign in required");
        return;
      }

      const [captureRes, jobsRes] = await Promise.all([
        fetch("/api/admin/ml-capture-status?limit=5", { headers: { Authorization: `Bearer ${jwt}` } }),
        fetch("/api/admin/ml-jobs?limit=1", { headers: { Authorization: `Bearer ${jwt}` } }),
      ]);

      const capturePayload = await captureRes.json().catch(() => ({}));
      const jobsPayload = await jobsRes.json().catch(() => ({}));

      if (captureRes.ok) {
        const saved = Number(capturePayload?.capture_total || 0).toLocaleString();
        const upOk = Number(capturePayload?.upload_success_total || 0).toLocaleString();
        const upFail = Number(capturePayload?.upload_fail_total || 0).toLocaleString();
        setLiveField("night-live-counters", `${saved} saved | ${upOk} uploaded | ${upFail} failed`);
      } else {
        setLiveField("night-live-counters", "Capture status unavailable");
      }

      if (jobsRes.ok) {
        const j = (jobsPayload?.jobs || [])[0];
        setLiveField(
          "night-live-training",
          j ? `${String(j.job_type || "-").toUpperCase()} | ${String(j.status || "-").toUpperCase()} | ${fmtAgo(j.created_at)}` : "No jobs yet"
        );
      } else {
        setLiveField("night-live-training", "Training status unavailable");
      }

      if (window.sb) {
        const resp = await window.sb
          .from("ml_detection_events")
          .select("captured_at, detections_count, avg_confidence, model_name")
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!resp.error && resp.data) {
          const d = resp.data;
          const conf = Number(d.avg_confidence || 0);
          setLiveField(
            "night-live-telemetry",
            `${d.model_name || "-"} | det ${Number(d.detections_count || 0)} | conf ${(conf * 100).toFixed(1)}% | ${fmtAgo(d.captured_at)}`
          );
        } else {
          setLiveField("night-live-telemetry", "No telemetry yet");
        }
      } else {
        setLiveField("night-live-telemetry", "Telemetry client unavailable");
      }
    } catch {
      setLiveField("night-live-counters", "Live data unavailable");
      setLiveField("night-live-training", "Live data unavailable");
      setLiveField("night-live-telemetry", "Live data unavailable");
    } finally {
      liveRefreshRunning = false;
    }
  }

  function updateNightProfileIndicator() {
    const statusEl = el("night-profile-status");
    const windowEl = el("night-profile-window");
    if (!statusEl || !windowEl) return;

    const enabled = Number(el("night-profile-enabled")?.value || 0) === 1;
    const startHour = Number(el("night-start-hour")?.value || 18);
    const endHour = Number(el("night-end-hour")?.value || 6);
    const nowHour = new Date().getHours();
    const activeNow = enabled && isNightWindowActive(nowHour, startHour, endHour);

    statusEl.className = "ml-status-chip";
    if (!enabled) {
      statusEl.classList.add("disabled");
      statusEl.textContent = "Disabled";
    } else if (activeNow) {
      statusEl.classList.add("enabled-active");
      statusEl.textContent = "Active Now";
    } else {
      statusEl.classList.add("enabled-idle");
      statusEl.textContent = "Enabled (Day)";
    }
    windowEl.textContent = `Window: ${startHour}:00 - ${endHour}:00 local time`;
    refreshNightLiveData();
  }

  function initMlSubnav() {
    const nav = el("ml-subnav");
    const panel = el("panel-ml");
    if (!nav || !panel) return;

    const buttons = Array.from(nav.querySelectorAll(".ml-subnav-btn"));
    const sections = Array.from(panel.querySelectorAll(".ml-section"));
    const opsGrid = el("ml-ops-grid");
    if (!buttons.length || !sections.length) return;

    function showSection(targetId) {
      const target = sections.find((section) => section.id === targetId) || sections[0];
      const targetInOps = !!(opsGrid && target.parentElement === opsGrid);

      sections.forEach((section) => {
        section.hidden = section !== target;
      });

      if (opsGrid) {
        opsGrid.hidden = !targetInOps;
        opsGrid.classList.toggle("single-view", targetInOps);
      }

      buttons.forEach((btn) => {
        const isActive = btn.getAttribute("data-target") === target.id;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => showSection(btn.getAttribute("data-target")));
    });

    showSection(buttons[0].getAttribute("data-target"));
  }

  function fillForm(s) {
    if (!s) return;
    if (el("night-profile-enabled")) el("night-profile-enabled").value = s.enabled ? "1" : "0";
    if (el("night-start-hour")) el("night-start-hour").value = Number(s.start_hour ?? 18);
    if (el("night-end-hour")) el("night-end-hour").value = Number(s.end_hour ?? 6);
    if (el("night-yolo-conf")) el("night-yolo-conf").value = Number(s.yolo_conf ?? 0.30);
    if (el("night-infer-size")) el("night-infer-size").value = Number(s.infer_size ?? 640);
    if (el("night-iou")) el("night-iou").value = Number(s.iou ?? 0.45);
    if (el("night-max-det")) el("night-max-det").value = Number(s.max_det ?? 120);
    detectModeFromFields();
    updateNightProfileIndicator();
  }

  function detectModeFromFields() {
    const modeEl = el("night-profile-mode");
    if (!modeEl) return;
    const conf = Number(el("night-yolo-conf")?.value || 0);
    const infer = Number(el("night-infer-size")?.value || 0);
    const iou = Number(el("night-iou")?.value || 0);
    const maxDet = Number(el("night-max-det")?.value || 0);
    const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0001;
    if (
      eq(conf, PRESETS.aggressive.yolo_conf) &&
      eq(infer, PRESETS.aggressive.infer_size) &&
      eq(iou, PRESETS.aggressive.iou) &&
      eq(maxDet, PRESETS.aggressive.max_det)
    ) {
      modeEl.value = "aggressive";
      return;
    }
    modeEl.value = "conservative";
  }

  function applyPreset() {
    const mode = String(el("night-profile-mode")?.value || "conservative");
    const preset = PRESETS[mode] || PRESETS.conservative;
    if (el("night-yolo-conf")) el("night-yolo-conf").value = preset.yolo_conf;
    if (el("night-infer-size")) el("night-infer-size").value = preset.infer_size;
    if (el("night-iou")) el("night-iou").value = preset.iou;
    if (el("night-max-det")) el("night-max-det").value = preset.max_det;
    setMsg(`${mode[0].toUpperCase() + mode.slice(1)} preset applied. Click Save to activate.`, true);
  }

  async function loadSettings() {
    const btn = el("btn-save-night-profile");
    if (!btn) return;
    const jwt = await getJwt();
    if (!jwt) return;
    try {
      setMsg("Loading...", true);
      const res = await fetch("/api/admin/ml-runtime-profile?scope=night", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.detail || "Failed to load");
      fillForm(payload);
      setMsg("Loaded", true);
      setTimeout(() => setMsg("", true), 1200);
    } catch (e) {
      setMsg(e?.message || "Failed to load", false);
    }
  }

  async function saveSettings() {
    const jwt = await getJwt();
    if (!jwt) {
      setMsg("Missing admin session", false);
      return;
    }
    try {
      setMsg("Saving...", true);
      const body = {
        enabled: Number(el("night-profile-enabled")?.value || 0) === 1,
        start_hour: Number(el("night-start-hour")?.value || 18),
        end_hour: Number(el("night-end-hour")?.value || 6),
        yolo_conf: Number(el("night-yolo-conf")?.value || 0.30),
        infer_size: Number(el("night-infer-size")?.value || 640),
        iou: Number(el("night-iou")?.value || 0.45),
        max_det: Number(el("night-max-det")?.value || 120),
      };
      const res = await fetch("/api/admin/ml-runtime-profile?scope=night", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.detail || "Failed to save");
      fillForm(payload?.settings || body);
      setMsg("Saved. Applied immediately.", true);
    } catch (e) {
      setMsg(e?.message || "Failed to save", false);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = el("btn-save-night-profile");
    const presetBtn = el("btn-apply-night-preset");
    if (!btn) return;
    initMlSubnav();
    if (presetBtn) presetBtn.addEventListener("click", applyPreset);
    ["night-yolo-conf", "night-infer-size", "night-iou", "night-max-det"].forEach((id) => {
      el(id)?.addEventListener("input", detectModeFromFields);
      el(id)?.addEventListener("change", detectModeFromFields);
    });
    ["night-profile-enabled", "night-start-hour", "night-end-hour"].forEach((id) => {
      el(id)?.addEventListener("input", updateNightProfileIndicator);
      el(id)?.addEventListener("change", updateNightProfileIndicator);
    });
    btn.addEventListener("click", saveSettings);
    updateNightProfileIndicator();
    setInterval(updateNightProfileIndicator, 60_000);
    setInterval(refreshNightLiveData, 10_000);
    refreshNightLiveData();
    loadSettings();
  });
})();
