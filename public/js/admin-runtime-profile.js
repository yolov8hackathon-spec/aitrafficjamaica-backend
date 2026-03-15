/**
 * admin-runtime-profile.js
 * Runtime autotune controls + live status for admin panel.
 */
(function RuntimeProfileAdminInit() {
  let lastLiveProfile = "";
  let lastLiveReason = "";
  let lastLiveAt = 0;

  function el(id) {
    return document.getElementById(id);
  }

  function setMsg(text, ok = true) {
    const node = el("runtime-profile-msg");
    if (!node) return;
    node.textContent = text || "";
    node.style.color = ok ? "var(--green)" : "var(--red)";
  }

  function setErrorBanner(text = "") {
    const node = el("runtime-profile-error");
    if (!node) return;
    const msg = String(text || "").trim();
    if (!msg) {
      node.style.display = "none";
      node.textContent = "";
      return;
    }
    node.textContent = msg;
    node.style.display = "block";
  }

  function toLocalInput(iso) {
    if (!iso) return "";
    const dt = new Date(iso);
    if (!Number.isFinite(dt.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }

  function fromLocalInput(value) {
    if (!value) return null;
    const dt = new Date(value);
    if (!Number.isFinite(dt.getTime())) return null;
    return dt.toISOString();
  }

  function human(name) {
    return String(name || "")
      .replaceAll("_", " ")
      .trim();
  }

  function updateRuntimeStatusChip(mode, profile, reason) {
    const chip = el("runtime-profile-status");
    const live = el("runtime-profile-live");
    const detProfile = el("det-runtime-profile");
    const detReason = el("det-runtime-reason");
    if (chip) {
      chip.textContent = mode === "manual" ? "Manual" : "Auto";
      chip.classList.toggle("ok", mode !== "manual");
    }
    if (live) {
      const p = human(profile) || "-";
      const r = human(reason) || "-";
      live.textContent = `Current: ${p} | Reason: ${r}`;
    }
    if (detProfile) detProfile.textContent = human(profile) || "Unknown";
    if (detReason) detReason.textContent = human(reason) || "Unknown";
  }

  function readForm() {
    return {
      mode: String(el("runtime-profile-mode")?.value || "auto"),
      manual_profile: String(el("runtime-manual-profile")?.value || "").trim(),
      manual_until: fromLocalInput(String(el("runtime-manual-until")?.value || "").trim()),
      autotune_interval_sec: Number(el("runtime-autotune-interval")?.value || 20),
      profile_cooldown_sec: Number(el("runtime-cooldown-sec")?.value || 600),
      stream_grab_latest: Number(el("runtime-stream-grab-latest")?.value || 1) === 1,
    };
  }

  function writeForm(state) {
    if (!state) return;
    if (el("runtime-profile-mode")) el("runtime-profile-mode").value = String(state.mode || "auto");
    if (el("runtime-manual-until")) el("runtime-manual-until").value = toLocalInput(state.manual_until);
    if (el("runtime-autotune-interval")) el("runtime-autotune-interval").value = String(state.autotune_interval_sec ?? 20);
    if (el("runtime-cooldown-sec")) el("runtime-cooldown-sec").value = String(state.profile_cooldown_sec ?? 600);
    if (el("runtime-stream-grab-latest")) el("runtime-stream-grab-latest").value = String((state.stream_grab_latest ?? 1) ? 1 : 0);

    const profileSel = el("runtime-manual-profile");
    const available = Array.isArray(state.available_profiles) ? state.available_profiles : [];
    if (profileSel && available.length) {
      profileSel.innerHTML = available
        .map((name) => `<option value="${name}">${human(name)}</option>`)
        .join("");
      profileSel.value = String(state.manual_profile || available[0] || "");
    }
  }

  async function getJwt() {
    try {
      if (window.Auth?.getJwt) return await window.Auth.getJwt();
    } catch {}
    return "";
  }

  async function fetchRuntimeState() {
    const jwt = await getJwt();
    if (!jwt) return null;
    const res = await fetch("/api/admin/ml-runtime-profile", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to load runtime profile");
    return payload;
  }

  async function saveRuntimeState(patch) {
    const jwt = await getJwt();
    if (!jwt) throw new Error("Missing admin session");
    const res = await fetch("/api/admin/ml-runtime-profile", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch || {}),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || "Failed to save runtime profile");
    return payload;
  }

  async function refresh() {
    try {
      const state = await fetchRuntimeState();
      if (!state) return;
      setErrorBanner("");
      writeForm(state);
      updateRuntimeStatusChip(
        String(state.mode || "auto"),
        lastLiveProfile || state.manual_profile || "",
        lastLiveReason || (String(state.mode || "auto") === "manual" ? "manual_override" : "auto"),
      );
    } catch (e) {
      const msg = e?.message || "Runtime profile unavailable";
      setMsg(msg, false);
      setErrorBanner(`Runtime profile load failed: ${msg}`);
    }
  }

  async function handleSave() {
    try {
      const form = readForm();
      const payload = {
        mode: form.mode,
        manual_profile: form.manual_profile || "",
        manual_until: form.manual_until,
        autotune_interval_sec: form.autotune_interval_sec,
        profile_cooldown_sec: form.profile_cooldown_sec,
        stream_grab_latest: form.stream_grab_latest,
      };
      await saveRuntimeState(payload);
      setErrorBanner("");
      setMsg("Runtime profile controls saved.", true);
      await refresh();
    } catch (e) {
      const msg = e?.message || "Failed to save runtime profile";
      setMsg(msg, false);
      setErrorBanner(`Runtime profile save failed: ${msg}`);
    }
  }

  async function handleForceAuto() {
    try {
      await saveRuntimeState({
        mode: "auto",
        manual_profile: "",
        manual_until: null,
      });
      setErrorBanner("");
      setMsg("Auto mode restored.", true);
      await refresh();
    } catch (e) {
      const msg = e?.message || "Failed to force auto mode";
      setMsg(msg, false);
      setErrorBanner(`Force auto failed: ${msg}`);
    }
  }

  function onLiveCount(data) {
    if (!data || typeof data !== "object") return;
    lastLiveAt = Date.now();
    lastLiveProfile = String(data.runtime_profile || "").trim();
    lastLiveReason = String(data.runtime_profile_reason || "").trim();
    if (!lastLiveProfile && !lastLiveReason) return;
    const mode = String(el("runtime-profile-mode")?.value || "auto");
    updateRuntimeStatusChip(mode, lastLiveProfile, lastLiveReason);
  }

  function init() {
    const saveBtn = el("btn-save-runtime-profile");
    const forceBtn = el("btn-runtime-force-auto");
    if (saveBtn && !saveBtn.dataset.wiredRuntime) {
      saveBtn.dataset.wiredRuntime = "1";
      saveBtn.addEventListener("click", handleSave);
    }
    if (forceBtn && !forceBtn.dataset.wiredRuntime) {
      forceBtn.dataset.wiredRuntime = "1";
      forceBtn.addEventListener("click", handleForceAuto);
    }

    window.addEventListener("admin:live-count", (e) => onLiveCount(e.detail || {}));
    refresh();
    setInterval(refresh, 30000);
    setInterval(() => {
      const live = el("runtime-profile-live");
      if (!live) return;
      if (!lastLiveAt) return;
      const ageSec = Math.max(0, Math.round((Date.now() - lastLiveAt) / 1000));
      if (ageSec > 5 && (lastLiveProfile || lastLiveReason)) {
        live.textContent = `Current: ${human(lastLiveProfile) || "-"} | Reason: ${human(lastLiveReason) || "-"} | Live update ${ageSec}s ago`;
      }
    }, 2000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
