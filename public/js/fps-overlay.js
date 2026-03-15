/**
 * fps-overlay.js
 * Displays real-time decoded/rendered stream FPS.
 * Uses requestVideoFrameCallback when available, with a fallback.
 */

const FpsOverlay = (() => {
  let _video = null;
  let _el = null;
  let _running = false;
  let _rafId = null;
  let _vfcId = null;
  let _samples = [];
  let _lastNow = 0;
  let _lastVideoTime = -1;

  const MAX_SAMPLES = 45;

  function init(videoEl, overlayEl) {
    _video = videoEl;
    _el = overlayEl;
    if (!_video || !_el || _running) return;
    _running = true;
    _el.textContent = "FPS --.-";

    if (typeof _video.requestVideoFrameCallback === "function") {
      _vfcId = _video.requestVideoFrameCallback(onVideoFrame);
    } else {
      _lastNow = performance.now();
      _rafId = requestAnimationFrame(onAnimationFrame);
    }
  }

  function onVideoFrame(now) {
    if (!_running) return;
    addSample(now);
    render();
    _vfcId = _video.requestVideoFrameCallback(onVideoFrame);
  }

  function onAnimationFrame(now) {
    if (!_running) return;
    const vt = Number(_video?.currentTime || 0);
    if (vt !== _lastVideoTime) {
      _lastVideoTime = vt;
      addSample(now);
      render();
    }
    _rafId = requestAnimationFrame(onAnimationFrame);
  }

  function addSample(now) {
    if (_lastNow > 0) {
      const dt = now - _lastNow;
      if (dt > 0 && dt < 1000) _samples.push(dt);
    }
    _lastNow = now;
    if (_samples.length > MAX_SAMPLES) _samples.shift();
  }

  function computeFps() {
    if (_samples.length < 2) return null;
    const avgMs = _samples.reduce((s, n) => s + n, 0) / _samples.length;
    if (!Number.isFinite(avgMs) || avgMs <= 0) return null;
    return 1000 / avgMs;
  }

  function render() {
    if (!_el) return;
    const fps = computeFps();
    _el.textContent = fps == null ? "FPS --.-" : `FPS ${fps.toFixed(1)}`;
    _el.classList.remove("fps-good", "fps-warn", "fps-bad");
    if (fps == null) return;
    if (fps <= 18) _el.classList.add("fps-bad");
    else if (fps < 19) _el.classList.add("fps-warn");
    else _el.classList.add("fps-good");
  }

  function destroy() {
    _running = false;
    _samples = [];
    _lastNow = 0;
    _lastVideoTime = -1;
    if (_rafId != null) cancelAnimationFrame(_rafId);
    _rafId = null;
    if (_video && _vfcId != null && typeof _video.cancelVideoFrameCallback === "function") {
      _video.cancelVideoFrameCallback(_vfcId);
    }
    _vfcId = null;
  }

  return { init, destroy };
})();

window.FpsOverlay = FpsOverlay;
