/**
 * admin-banners.js — Admin panel: create/edit/pin/archive banners.
 * Info field stores sanitized HTML from the rich text editor.
 */

const AdminBanners = (() => {
  let _banners = [];
  let _editingId = null;

  function _esc(v) {
    return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function _fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString([], { month:"short", day:"numeric", year:"numeric" });
  }

  // ── Simple HTML sanitizer — allows safe inline/block tags only ──
  function _sanitize(html) {
    const allowed = new Set(["b","strong","i","em","u","ul","ol","li","p","br","span","div"]);
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      function clean(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        const tag = node.tagName.toLowerCase();
        const kids = [];
        node.childNodes.forEach(c => { const r = clean(c); if (r) kids.push(r); });
        if (!allowed.has(tag)) {
          const frag = document.createDocumentFragment();
          kids.forEach(k => frag.appendChild(k));
          return frag;
        }
        const el = document.createElement(tag);
        kids.forEach(k => el.appendChild(k));
        return el;
      }
      const wrap = document.createElement("div");
      doc.body.childNodes.forEach(n => { const c = clean(n); if (c) wrap.appendChild(c); });
      return wrap.innerHTML.trim();
    } catch { return ""; }
  }

  // ── Strip HTML to plain text for short preview ──
  function _stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html || "";
    return tmp.textContent || "";
  }

  // ── Load & render list ────────────────────────────────────────
  async function load() {
    const listEl = document.getElementById("admin-banners-list");
    if (!listEl) return;
    listEl.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const { data } = await window.sb
        .from("banners")
        .select("*")
        .order("is_pinned", { ascending: false })
        .order("created_at", { ascending: false });
      _banners = Array.isArray(data) ? data : [];
    } catch { _banners = []; }
    _renderList(listEl);
  }

  function _renderList(listEl) {
    if (!_banners.length) {
      listEl.innerHTML = `<div class="abn-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <p>No banners yet. Create one below.</p>
      </div>`;
      return;
    }
    listEl.innerHTML = _banners.map(b => {
      const preview = _stripHtml(b.info || "").slice(0, 90);
      return `
      <div class="abn-card ${b.is_active ? "" : "abn-card-archived"}">
        <div class="abn-card-thumb">
          ${b.image_url
            ? `<div class="abn-thumb-img" style="background-image:url('${_esc(b.image_url)}')"></div>`
            : `<div class="abn-thumb-empty"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9l4-4 4 4 4-5 4 5"/></svg></div>`}
        </div>
        <div class="abn-card-body">
          <div class="abn-card-top">
            <span class="abn-card-title">${_esc(b.title || "Untitled")}</span>
            <div class="abn-card-badges">
              ${b.is_pinned ? `<span class="abn-badge abn-badge-pin"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.4H21l-5.2 3.8 2 6.4L12 14.8 6.2 18.6l2-6.4L3 8.4h6.6z"/></svg>Pinned</span>` : ""}
              <span class="abn-badge ${b.is_active ? "abn-badge-active" : "abn-badge-archived"}">${b.is_active ? "Active" : "Archived"}</span>
            </div>
          </div>
          ${preview ? `<p class="abn-card-preview">${_esc(preview)}${b.info && _stripHtml(b.info).length > 90 ? "…" : ""}</p>` : ""}
          <div class="abn-card-meta">
            <span class="abn-meta-item">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              ${b.likes || 0}
            </span>
            <span class="abn-meta-item">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              ${_fmtDate(b.created_at)}
            </span>
          </div>
        </div>
        <div class="abn-card-actions">
          <button class="abn-action-btn" data-action="edit" data-id="${_esc(b.id)}" title="Edit">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="abn-action-btn ${b.is_pinned ? "abn-action-btn-on" : ""}" data-action="pin" data-id="${_esc(b.id)}" data-val="${b.is_pinned}" title="${b.is_pinned ? "Unpin" : "Pin"}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="${b.is_pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2l2.4 6.4H21l-5.2 3.8 2 6.4L12 14.8 6.2 18.6l2-6.4L3 8.4h6.6z"/></svg>
            ${b.is_pinned ? "Unpin" : "Pin"}
          </button>
          <button class="abn-action-btn ${!b.is_active ? "abn-action-btn-on" : "abn-action-btn-warn"}" data-action="archive" data-id="${_esc(b.id)}" data-val="${b.is_active}" title="${b.is_active ? "Archive" : "Restore"}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${b.is_active ? `<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>` : `<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.05"/>`}</svg>
            ${b.is_active ? "Archive" : "Restore"}
          </button>
        </div>
      </div>`;
    }).join("");

    listEl.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        const { action, id, val } = btn.dataset;
        if (action === "edit")    _startEdit(id);
        if (action === "pin")     _toggle(id, "is_pinned", val === "true");
        if (action === "archive") _toggle(id, "is_active",  val === "true");
      });
    });
  }

  async function _toggle(id, field, current) {
    try {
      await window.sb.from("banners")
        .update({ [field]: !current, updated_at: new Date().toISOString() })
        .eq("id", id);
      await load();
    } catch (e) { console.error("[AdminBanners] toggle", e); }
  }

  // ── Form helpers ──────────────────────────────────────────────
  function _getFormEls() {
    return {
      heading:   document.getElementById("abn-form-heading"),
      title:     document.getElementById("abn-form-title"),
      editor:    document.getElementById("abn-rte-editor"),
      pinned:    document.getElementById("abn-form-pinned"),
      active:    document.getElementById("abn-form-active"),
      imageFile: document.getElementById("abn-form-image"),
      preview:   document.getElementById("abn-form-preview"),
      dropzone:  document.getElementById("abn-dropzone-inner"),
      clearImg:  document.getElementById("abn-clear-img"),
      msg:       document.getElementById("abn-form-msg"),
      submit:    document.getElementById("abn-form-submit"),
    };
  }

  function _clearForm() {
    _editingId = null;
    const f = _getFormEls();
    if (f.title)    { f.title.value = ""; _updateCharCount(0); }
    if (f.editor)   f.editor.innerHTML = "";
    if (f.pinned)   f.pinned.checked = false;
    if (f.active)   f.active.checked = true;
    if (f.imageFile) f.imageFile.value = "";
    if (f.preview)  { f.preview.src = ""; f.preview.classList.add("hidden"); }
    if (f.dropzone) f.dropzone.classList.remove("hidden");
    if (f.clearImg) f.clearImg.classList.add("hidden");
    if (f.msg)      { f.msg.textContent = ""; f.msg.className = "abn-form-msg"; }
    if (f.heading)  f.heading.textContent = "New Banner";
    if (f.submit) {
      f.submit.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Create Banner`;
    }
    _updateToolbarState();
  }

  function _startEdit(id) {
    const b = _banners.find(x => x.id === id);
    if (!b) return;
    _editingId = id;
    const f = _getFormEls();
    if (f.title)   { f.title.value = b.title || ""; _updateCharCount(f.title.value.length); }
    if (f.editor)  f.editor.innerHTML = b.info || "";
    if (f.pinned)  f.pinned.checked = !!b.is_pinned;
    if (f.active)  f.active.checked = !!b.is_active;
    if (f.preview && b.image_url) {
      f.preview.src = b.image_url;
      f.preview.classList.remove("hidden");
      if (f.dropzone) f.dropzone.classList.add("hidden");
      if (f.clearImg) f.clearImg.classList.remove("hidden");
    }
    if (f.heading) f.heading.textContent = "Edit Banner";
    if (f.submit) {
      f.submit.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Save Changes`;
    }
    if (f.msg) { f.msg.textContent = ""; f.msg.className = "abn-form-msg"; }
    document.getElementById("abn-form-card")?.scrollIntoView({ behavior: "smooth" });
  }

  function _updateCharCount(len) {
    const el = document.getElementById("abn-title-count");
    if (el) el.textContent = len;
  }

  function _updateToolbarState() {
    document.querySelectorAll(".rte-btn[data-cmd]").forEach(btn => {
      try {
        const active = document.queryCommandState(btn.dataset.cmd);
        btn.classList.toggle("rte-btn-active", active);
      } catch {}
    });
  }

  // ── Submit ────────────────────────────────────────────────────
  async function _handleSubmit(e) {
    e.preventDefault();
    const f = _getFormEls();
    if (!f.submit) return;
    f.submit.disabled = true;
    if (f.msg) { f.msg.textContent = "Saving…"; f.msg.className = "abn-form-msg"; }

    try {
      const title     = f.title?.value.trim() || "";
      const info      = _sanitize(f.editor?.innerHTML || "");
      const is_pinned = !!f.pinned?.checked;
      const is_active = !!f.active?.checked;

      let image_url = _editingId
        ? (_banners.find(b => b.id === _editingId)?.image_url || "")
        : "";

      const file = f.imageFile?.files?.[0];
      if (file) {
        if (file.size > 4 * 1024 * 1024) throw new Error("Image too large — max 4 MB");
        const ext  = (file.name.split(".").pop() || "jpg").toLowerCase();
        const path = `banner-${Date.now()}.${ext}`;
        const { error: upErr } = await window.sb.storage
          .from("banners")
          .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
        if (upErr) throw upErr;
        const { data: urlData } = window.sb.storage.from("banners").getPublicUrl(path);
        image_url = urlData?.publicUrl ? `${urlData.publicUrl}?v=${Date.now()}` : "";
        if (f.imageFile) f.imageFile.value = "";
      }

      // If image was cleared via "Remove image" button
      if (f.preview?.classList.contains("hidden") && !file) {
        image_url = "";
      }

      const payload = { title, info, image_url, is_pinned, is_active, updated_at: new Date().toISOString() };

      if (_editingId) {
        const { error } = await window.sb.from("banners").update(payload).eq("id", _editingId);
        if (error) throw error;
      } else {
        const { error } = await window.sb.from("banners").insert({ ...payload, likes: 0 });
        if (error) throw error;
      }

      if (f.msg) { f.msg.textContent = _editingId ? "Saved." : "Banner created."; f.msg.className = "abn-form-msg abn-msg-ok"; }
      _clearForm();
      await load();
      setTimeout(() => { if (f.msg && /Saved|created/.test(f.msg.textContent)) f.msg.textContent = ""; }, 2500);
    } catch (err) {
      if (f.msg) { f.msg.textContent = err.message || "Save failed"; f.msg.className = "abn-form-msg abn-msg-err"; }
      console.error("[AdminBanners]", err);
    } finally {
      if (f.submit) f.submit.disabled = false;
    }
  }

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    document.getElementById("abn-form")?.addEventListener("submit", _handleSubmit);
    document.getElementById("abn-form-cancel")?.addEventListener("click", _clearForm);
    document.getElementById("abn-form-cancel-x")?.addEventListener("click", _clearForm);

    // Title char counter
    document.getElementById("abn-form-title")?.addEventListener("input", (e) => {
      _updateCharCount(e.target.value.length);
    });

    // RTE toolbar buttons
    document.getElementById("abn-rte-toolbar")?.addEventListener("mousedown", (e) => {
      const btn = e.target.closest(".rte-btn[data-cmd]");
      if (!btn) return;
      e.preventDefault(); // keep editor focus
      document.execCommand(btn.dataset.cmd, false, null);
      _updateToolbarState();
    });

    // Update toolbar active state on selection change
    document.getElementById("abn-rte-editor")?.addEventListener("keyup", _updateToolbarState);
    document.getElementById("abn-rte-editor")?.addEventListener("mouseup", _updateToolbarState);

    // Image file input → preview
    document.getElementById("abn-form-image")?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const f = _getFormEls();
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (f.preview) { f.preview.src = ev.target.result; f.preview.classList.remove("hidden"); }
        if (f.dropzone) f.dropzone.classList.add("hidden");
        if (f.clearImg) f.clearImg.classList.remove("hidden");
      };
      reader.readAsDataURL(file);
    });

    // Remove image
    document.getElementById("abn-clear-img")?.addEventListener("click", () => {
      const f = _getFormEls();
      if (f.imageFile) f.imageFile.value = "";
      if (f.preview)  { f.preview.src = ""; f.preview.classList.add("hidden"); }
      if (f.dropzone) f.dropzone.classList.remove("hidden");
      if (f.clearImg) f.clearImg.classList.add("hidden");
    });
  }

  return { init, load };
})();

window.AdminBanners = AdminBanners;
