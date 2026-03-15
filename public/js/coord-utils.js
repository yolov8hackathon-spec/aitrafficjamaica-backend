/**
 * coord-utils.js — Video content coordinate utilities.
 *
 * All canvas overlays (zone, detection, admin-line) save/render coordinates
 * relative to the actual VIDEO CONTENT (0,0 = top-left of frame, 1,1 = bottom-right).
 *
 * This is necessary because both admin and public videos use object-fit:cover
 * but may have different container aspect ratios, causing different amounts of
 * clipping. Using raw canvas-relative coords produces misaligned overlays.
 *
 * The formula for object-fit:cover:
 *   scale    = max(containerW / videoW, containerH / videoH)
 *   rendered = { w: videoW*scale, h: videoH*scale }
 *   offset   = { x: (containerW - rendered.w)/2, y: (containerH - rendered.h)/2 }
 *              (negative values = content is clipped on that side)
 */

function getContentBounds(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const cw = videoEl.clientWidth;
  const ch = videoEl.clientHeight;

  if (!vw || !vh) {
    // Video metadata not loaded yet — fall back to full canvas
    return { x: 0, y: 0, w: cw, h: ch };
  }

  const scale = Math.max(cw / vw, ch / vh);
  const rw    = vw * scale;
  const rh    = vh * scale;
  return {
    x: (cw - rw) / 2,  // ≤ 0 when clipping left/right
    y: (ch - rh) / 2,  // ≤ 0 when clipping top/bottom
    w: rw,
    h: rh,
  };
}

/**
 * Convert a pointer event's canvas position to content-relative [0,1] coords.
 * @param {number} canvasX - x in canvas/element pixels
 * @param {number} canvasY - y in canvas/element pixels
 * @param {{x,y,w,h}} bounds - from getContentBounds()
 */
function pixelToContent(canvasX, canvasY, bounds) {
  return {
    x: Math.min(1, Math.max(0, (canvasX - bounds.x) / bounds.w)),
    y: Math.min(1, Math.max(0, (canvasY - bounds.y) / bounds.h)),
  };
}

/**
 * Convert content-relative [0,1] to canvas pixel coords for drawing.
 * @param {number} rx - relative x [0,1]
 * @param {number} ry - relative y [0,1]
 * @param {{x,y,w,h}} bounds - from getContentBounds()
 */
function contentToPixel(rx, ry, bounds) {
  return {
    x: rx * bounds.w + bounds.x,
    y: ry * bounds.h + bounds.y,
  };
}

window.getContentBounds  = getContentBounds;
window.pixelToContent    = pixelToContent;
window.contentToPixel    = contentToPixel;
