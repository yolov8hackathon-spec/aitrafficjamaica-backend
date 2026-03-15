/**
 * camera-switcher.js — Public camera location modal.
 * Loads active cameras, shows live previews, lets users switch the main stream.
 */
const CameraSwitcher = (() => {
  let _cameras = [];
  let _activeCamId = null;
  const _hlsMap = {};
  let _loaded = false;

  function _isUrl(s) {
    return /^https?:\/\//i.test(String(s || ""));
  }

  function _camLabel(cam) {
    return cam?.feed_appearance?.label || cam?.ipcam_alias || "Camera";
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Load cameras ──────────────────────────────────────────────
  async function _loadCameras() {
    if (!window.sb) return;
    const { data } = await window.sb
      .from("cameras")
      .select("id, ipcam_alias, feed_appearance, is_active, created_at")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    _cameras = Array.isArray(data)
      ? data.filter(c => c.ipcam_alias && c.ipcam_alias.toLowerCase() !== "your-alias")
      : [];
    _loaded = true;
  }

  // ── Render modal body ─────────────────────────────────────────
  function _renderModal() {
    const body = document.getElementById("cam-modal-body");
    if (!body) return;

    if (!_cameras.length) {
      body.innerHTML = '<p class="cam-modal-empty">No camera sources configured.</p>';
      return;
    }

    body.innerHTML = _cameras.map(cam => {
      const label = _camLabel(cam);
      const alias = cam.ipcam_alias || "";
      const isActive = String(cam.id) === String(_activeCamId);
      return `
        <div class="cam-card ${isActive ? "cam-card-active" : ""}" data-id="${cam.id}" data-alias="${esc(alias)}">
          <div class="cam-card-preview">
            <video class="cam-preview-video" data-cam-id="${cam.id}" muted playsinline></video>
            <div class="cam-preview-placeholder">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="7" width="14" height="10" rx="1.5"/>
                <path d="M16 10l5-3v10l-5-3"/>
              </svg>
              <span>Click to preview</span>
            </div>
            ${isActive ? '<span class="cam-active-badge">Active</span>' : ""}
          </div>
          <div class="cam-card-info">
            <span class="cam-card-label">${esc(label)}</span>
            <span class="cam-card-type">${_isUrl(alias) ? "Direct" : "Alias"}</span>
          </div>
          <div class="cam-card-actions">
            <button class="btn-cam-preview" data-id="${cam.id}" data-alias="${esc(alias)}">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="5 3 13 8 5 13"/></svg>
              Preview
            </button>
            <button class="btn-cam-switch ${isActive ? "btn-cam-switch-active" : ""}" data-id="${cam.id}" data-alias="${esc(alias)}" ${isActive ? "disabled" : ""}>
              ${isActive ? "Current" : "Switch Here"}
            </button>
          </div>
        </div>`;
    }).join("");

    // Wire buttons
    body.querySelectorAll(".btn-cam-preview").forEach(btn => {
      btn.addEventListener("click", () => _previewCam(btn.dataset.id, btn.dataset.alias));
    });
    body.querySelectorAll(".btn-cam-switch:not([disabled])").forEach(btn => {
      btn.addEventListener("click", () => _switchCam(btn.dataset.id, btn.dataset.alias));
    });
  }

  // ── Preview ───────────────────────────────────────────────────
  function _previewCam(camId, alias) {
    const videoEl = document.querySelector(`.cam-preview-video[data-cam-id="${camId}"]`);
    const placeholder = videoEl?.closest(".cam-card-preview")?.querySelector(".cam-preview-placeholder");
    if (!videoEl) return;

    // If already loading, stop it
    if (_hlsMap[camId]) {
      _hlsMap[camId].destroy();
      delete _hlsMap[camId];
      videoEl.src = "";
      placeholder?.classList.remove("hidden");
      return;
    }

    placeholder?.classList.add("hidden");
    const url = _isUrl(alias) ? alias : `/api/stream?alias=${encodeURIComponent(alias)}`;

    if (Hls.isSupported()) {
      const h = new Hls({ enableWorker: false, maxBufferLength: 6 });
      h.loadSource(url);
      h.attachMedia(videoEl);
      h.on(Hls.Events.MANIFEST_PARSED, () => { videoEl.play().catch(() => {}); });
      h.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) { placeholder?.classList.remove("hidden"); }
      });
      _hlsMap[camId] = h;
    } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      videoEl.src = url;
      videoEl.play().catch(() => {});
    }
  }

  // ── Switch main stream ────────────────────────────────────────
  function _switchCam(camId, alias) {
    _stopAllPreviews();
    _activeCamId = camId;
    if (window.Stream) {
      Stream.setAlias(alias);
    }
    _close();
    // Dispatch event so other parts can react
    window.dispatchEvent(new CustomEvent("camera:switched", { detail: { camId, alias } }));
  }

  function _stopAllPreviews() {
    Object.keys(_hlsMap).forEach(id => {
      _hlsMap[id]?.destroy();
      delete _hlsMap[id];
    });
    document.querySelectorAll(".cam-preview-video").forEach(v => { v.src = ""; v.pause(); });
  }

  // ── Open / Close ──────────────────────────────────────────────
  async function open() {
    const modal = document.getElementById("camera-modal");
    if (!modal) return;

    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");

    const body = document.getElementById("cam-modal-body");
    if (!_loaded) {
      if (body) body.innerHTML = '<p class="cam-modal-empty">Loading cameras...</p>';
      await _loadCameras();
    }
    _renderModal();
  }

  function _close() {
    _stopAllPreviews();
    document.getElementById("camera-modal")?.classList.add("hidden");
    document.body.classList.remove("modal-open");
  }

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    // Close button
    document.getElementById("cam-modal-close")?.addEventListener("click", _close);
    document.getElementById("cam-modal-backdrop")?.addEventListener("click", _close);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") _close();
    });

    // Open from camera tile
    document.addEventListener("click", e => {
      if (e.target.closest("#bnr-camera-tile")) open();
    });

    // Preload cameras list in background
    if (window.sb) _loadCameras();
  }

  return { init, open };
})();

window.CameraSwitcher = CameraSwitcher;
