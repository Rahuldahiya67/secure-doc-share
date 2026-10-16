// Viewer: sign in, list documents shared with you, read one in a protected view.
(async function () {
  const { sb, cfg, configured, inApp, $, esc, renderSignIn, renderNotConfigured, renderHeader, getUser } = window.App;
  const root = $("#app");

  if (!configured) { renderHeader(null); renderNotConfigured(root); return; }

  const params = new URLSearchParams(location.search);
  let docId = params.get("doc");

  // Documents open only inside the Android app. The database enforces this too
  // (start_view needs the app key), so this screen is just the friendly part.
  if (!inApp) { renderHeader(null); renderAppGate(docId); return; }

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  // Coming back from Google sign-in: restore the document they were opening.
  if (!docId) {
    try {
      const pending = localStorage.getItem("pendingDoc");
      if (pending) { localStorage.removeItem("pendingDoc"); docId = pending; }
    } catch (_) {}
  }

  const user = await getUser();
  renderHeader(user);
  if (!user) {
    renderSignIn(root, {
      title: docId ? "Sign in to view this document" : "Sign in",
      subtitle: "Only email IDs the owner has allowed can open shared documents."
    });
    return;
  }

  if (docId) await openDocument(docId, user);
  else await listDocuments();

  // ---------------------------------------------------------------
  function renderAppGate(id) {
    const ua = navigator.userAgent;
    const isAndroid = /Android/i.test(ua);
    const apk = cfg.apkUrl;
    const intentUrl = `intent://open${id ? `?doc=${encodeURIComponent(id)}` : ""}#Intent;scheme=${cfg.appScheme};package=${cfg.androidPackage};S.browser_fallback_url=${encodeURIComponent(apk)};end`;

    root.innerHTML = isAndroid ? `
      <div class="card narrow">
        <h2>Open in the app</h2>
        <p class="sub">This document can only be viewed in the Secure Doc Share Android app, which blocks screenshots and screen recording.</p>
        <a class="btn primary full" href="${esc(intentUrl)}">Open in app</a>
        <div class="divider">don't have the app yet?</div>
        <a class="btn full" href="${esc(apk)}">Download the app (APK)</a>
        <ol class="muted" style="font-size:13px;padding-left:18px;margin:14px 0 0">
          <li>Tap <strong>Download the app</strong> and open the downloaded file.</li>
          <li>If asked, allow <strong>Install unknown apps</strong> for your browser, then tap <strong>Install</strong>.</li>
          <li>Come back to this page and tap <strong>Open in app</strong>.</li>
        </ol>
      </div>` : `
      <div class="card narrow">
        <h2>Android phone required</h2>
        <p class="sub">This document can only be viewed in the Secure Doc Share app on an Android phone.</p>
        <div class="notice">Open this same link on your Android phone to install the app and view the document.</div>
      </div>`;
  }

  // ---------------------------------------------------------------
  async function listDocuments() {
    const { data, error } = await sb.from("documents")
      .select("id,title,created_at,expires_at").order("created_at", { ascending: false });
    if (error) { root.innerHTML = `<div class="card"><p class="msg err">${esc(error.message)}</p></div>`; return; }
    if (!data.length) {
      root.innerHTML = `<div class="card"><h2>Shared with you</h2>
        <p class="sub">Nothing has been shared with ${esc(user.email)} yet. If you expected a document,
        ask the owner to add this exact email ID.</p></div>`;
      return;
    }
    root.innerHTML = `<div class="card"><h2>Shared with you</h2><p class="sub">${data.length} document(s)</p>
      <ul class="doc-list">${data.map(d => `
        <li><div><strong>${esc(d.title)}</strong><div class="muted" style="font-size:13px">
          Shared ${new Date(d.created_at).toLocaleDateString()}${d.expires_at ? ` · expires ${new Date(d.expires_at).toLocaleString()}` : ""}</div></div>
          <a class="btn small" href="?doc=${encodeURIComponent(d.id)}">Open</a></li>`).join("")}
      </ul></div>`;
  }

  // ---------------------------------------------------------------
  async function openDocument(id, user) {
    root.innerHTML = `<div class="card"><p class="muted">Checking access…</p></div>`;

    const noAccess = () => {
      root.innerHTML = `<div class="card narrow"><h2>No access</h2>
        <p class="sub">${esc(user.email)} isn't on the allowed list for this document, or the link has expired or been turned off.</p>
        <a class="btn" href="./">See documents shared with you</a></div>`;
    };

    const { data: doc, error } = await sb.from("documents")
      .select("id,title").eq("id", id).maybeSingle();
    if (error || !doc) return noAccess();

    // Ask the database for a short-lived grant; it checks the email list and the app key.
    let appKey = "";
    try { appKey = window.SecureDocApp.getKey(); } catch (_) {}
    const { data: path, error: gErr } = await sb.rpc("start_view", { doc: doc.id, app_key: appKey });
    if (gErr) {
      if (/app_required/.test(gErr.message)) {
        root.innerHTML = `<div class="card narrow"><h2>Update the app</h2>
          <p class="sub">This version of the app can't open documents. Download the latest version and try again.</p>
          <a class="btn primary" href="${esc(cfg.apkUrl)}">Download latest app</a></div>`;
        return;
      }
      return noAccess();
    }

    const { data: signed, error: sErr } = await sb.storage.from("documents")
      .createSignedUrl(path, cfg.signedUrlSeconds || 60);
    if (sErr) { root.innerHTML = `<div class="card"><p class="msg err">${esc(sErr.message)}</p></div>`; return; }

    root.innerHTML = `
      <div class="viewer">
        <div class="toolbar"><div><a href="./" class="muted">← All documents</a><h2 style="margin:4px 0 0">${esc(doc.title)}</h2></div>
        <span class="tag">View only</span></div>
        <div class="viewer-banner">Viewing as <strong>${esc(user.email)}</strong>. Screenshots and recording are blocked, and every page is watermarked with your email.</div>
        <div class="pages" id="pages"><p class="muted">Loading document…</p></div>
      </div>
      <div class="shield">Content hidden. Tap here to keep reading.</div>`;

    const buf = await (await fetch(signed.signedUrl)).arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    const pagesEl = $("#pages");
    pagesEl.innerHTML = "";

    const stamp = `${user.email} · ${new Date().toLocaleString()}`;
    const maxWidth = Math.min(pagesEl.clientWidth || 900, 900);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = (maxWidth / base.width) * ratio;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(vp.width / ratio)}px`;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      watermark(ctx, canvas.width, canvas.height, stamp, ratio);
      pagesEl.appendChild(canvas);
    }
    protect();
  }

  // Tiled diagonal watermark drawn into the page pixels (can't be removed via the DOM).
  function watermark(ctx, w, h, text, ratio) {
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `600 ${Math.round(16 * ratio)}px system-ui, sans-serif`;
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 6);
    const stepX = ctx.measureText(text).width + 80 * ratio;
    const stepY = 110 * ratio;
    const span = Math.hypot(w, h);
    for (let y = -span; y < span; y += stepY) {
      const offset = (Math.round(y / stepY) % 2) * (stepX / 2);
      for (let x = -span; x < span; x += stepX) ctx.fillText(text, x + offset, y);
    }
    ctx.restore();
  }

  // Deterrents. Browsers cannot fully block screenshots or a phone camera;
  // the per-viewer watermark makes any leak traceable.
  function protect() {
    const body = document.body;
    const shield = () => body.classList.add("shielded");
    const unshield = () => body.classList.remove("shielded");

    ["contextmenu", "dragstart", "selectstart", "copy", "cut"].forEach(ev =>
      document.addEventListener(ev, e => e.preventDefault()));

    document.addEventListener("keydown", e => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ["p", "s", "c", "a", "u"].includes(k)) e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && ["i", "j", "c", "s", "3", "4", "5"].includes(k)) { e.preventDefault(); shield(); }
      if (k === "printscreen" || k === "f12") { e.preventDefault(); shield(); }
      if (e.metaKey && e.shiftKey) shield(); // macOS screenshot shortcuts
    });
    document.addEventListener("keyup", e => {
      if (e.key === "PrintScreen") {
        shield();
        try { navigator.clipboard.writeText(""); } catch (_) {}
      }
    });

    window.addEventListener("blur", shield);
    window.addEventListener("focus", unshield);
    document.addEventListener("visibilitychange", () => (document.hidden ? shield() : null));
    document.querySelector(".shield").addEventListener("click", unshield);
    window.addEventListener("beforeprint", shield);
  }
})();
