// Viewer: sign in, list documents shared with you, read one in a protected view.
(async function () {
  const { sb, cfg, configured, inApp, $, esc, icon, brandHTML, timeAgo, renderSignIn, renderNotConfigured, renderHeader, getUser } = window.App;
  const root = $("#app");

  if (!configured) { renderHeader(null); renderNotConfigured(root); return; }

  const params = new URLSearchParams(location.search);
  let docId = params.get("doc");

  // Documents open only inside the Android app. The database enforces this too
  // (start_view needs the app key), so this screen is just the friendly part.
  if (!inApp) { $("#bar").remove(); renderAppGate(docId); return; }

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
  if (!user) {
    $("#bar").remove();
    renderSignIn(root, {
      title: docId ? "Sign in to open this document" : "Sign in",
      subtitle: "Use the Google account whose email the owner shared this with."
    });
    return;
  }
  renderHeader(user);

  if (docId) await openDocument(docId, user);
  else await listDocuments(user);

  // ---------------------------------------------------------------
  function renderAppGate(id) {
    const isAndroid = /Android/i.test(navigator.userAgent);
    const apk = cfg.apkUrl;
    const intentUrl = `intent://open${id ? `?doc=${encodeURIComponent(id)}` : ""}#Intent;scheme=${cfg.appScheme};package=${cfg.androidPackage};S.browser_fallback_url=${encodeURIComponent(apk)};end`;

    root.innerHTML = isAndroid ? `
      <div class="card narrow">
        ${brandHTML()}
        <h2>Open this in the app</h2>
        <p class="sub">Shared documents open only in the Secure Doc Share app, which blocks screenshots and screen recording.</p>
        <a class="btn primary full" href="${esc(intentUrl)}">Open in app</a>
        <div class="divider">first time here?</div>
        <a class="btn full" href="${esc(apk)}">Download the app</a>
        <ol class="small-text muted" style="padding-left:18px;margin:16px 0 0;display:grid;gap:6px">
          <li>Download the app and open the file.</li>
          <li>If Android asks, allow installs from your browser, then tap Install.</li>
          <li>Come back to this page and tap Open in app.</li>
        </ol>
      </div>` : `
      <div class="card narrow">
        ${brandHTML()}
        <h2>Open this link on an Android phone</h2>
        <p class="sub">Shared documents can only be read in the Secure Doc Share app for Android.</p>
        <div class="notice">Send this link to your Android phone and open it there to install the app.</div>
      </div>`;
  }

  // ---------------------------------------------------------------
  async function listDocuments(user) {
    const { data, error } = await sb.from("documents")
      .select("id,title,created_at,expires_at").order("created_at", { ascending: false });
    if (error) { root.innerHTML = `<div class="card"><p class="msg err">${esc(error.message)}</p></div>`; return; }
    if (!data.length) {
      root.innerHTML = `<div class="card"><h2>Shared with you</h2>
        <div class="empty"><strong>Nothing here yet</strong>
        Documents shared with ${esc(user.email)} will appear here. If you expected one, ask the owner to check your email ID.</div></div>`;
      return;
    }
    root.innerHTML = `<div class="card"><h2>Shared with you</h2><p class="sub">${data.length} ${data.length === 1 ? "document" : "documents"}</p>
      <ul class="doc-list">${data.map(d => `
        <li><a href="?doc=${encodeURIComponent(d.id)}">
          <span class="doc-icon">${icon("file")}</span>
          <span class="grow"><span class="t">${esc(d.title)}</span>
            <span class="s">Shared ${esc(timeAgo(d.created_at))}${d.expires_at ? `, available until ${esc(new Date(d.expires_at).toLocaleDateString())}` : ""}</span></span>
          <span class="btn small">Open</span></a></li>`).join("")}
      </ul></div>`;
  }

  // ---------------------------------------------------------------
  async function openDocument(id, user) {
    root.innerHTML = `<div class="card"><p class="muted">Checking access…</p></div>`;

    const noAccess = () => {
      root.innerHTML = `<div class="card narrow"><h2>You don't have access</h2>
        <p class="sub">${esc(user.email)} isn't on the list for this document, or the link was turned off or has expired. Ask the owner to check your email ID.</p>
        <a class="btn" href="./">See documents shared with you</a></div>`;
    };

    const { data: doc, error } = await sb.from("documents").select("id,title").eq("id", id).maybeSingle();
    if (error || !doc) return noAccess();

    // Ask the database for a short-lived grant; it checks the email list and the app key.
    let appKey = "";
    try { appKey = window.SecureDocApp.getKey(); } catch (_) {}
    const { data: path, error: gErr } = await sb.rpc("start_view", { doc: doc.id, app_key: appKey });
    if (gErr) {
      if (/app_required/.test(gErr.message)) {
        root.innerHTML = `<div class="card narrow"><h2>Update the app</h2>
          <p class="sub">This version of the app can't open documents. Download the latest version and try again.</p>
          <a class="btn primary" href="${esc(cfg.apkUrl)}">Download the latest app</a></div>`;
        return;
      }
      return noAccess();
    }

    const { data: signed, error: sErr } = await sb.storage.from("documents")
      .createSignedUrl(path, cfg.signedUrlSeconds || 60);
    if (sErr) { root.innerHTML = `<div class="card"><p class="msg err">${esc(sErr.message)}</p></div>`; return; }

    root.innerHTML = `
      <div class="viewer">
        <a href="./" class="back">${icon("back")} All documents</a>
        <div class="reader-head"><h1>${esc(doc.title)}</h1><span class="tag live">View only</span></div>
        <div class="viewer-banner">${icon("lock")}<span>Viewing as <strong>${esc(user.email)}</strong>. Screenshots and recording are blocked, and every page carries your email.</span></div>
        <div class="pages" id="pages"><p class="muted">Loading document…</p></div>
      </div>
      <div class="page-pill" id="pill" hidden></div>
      <div class="shield">Content hidden. Tap to keep reading.</div>`;

    const buf = await (await fetch(signed.signedUrl)).arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    const pagesEl = $("#pages");
    pagesEl.innerHTML = "";

    const stamp = `${user.email}  ${new Date().toLocaleString()}`;
    const maxWidth = Math.min(pagesEl.clientWidth || 900, 900);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (maxWidth / base.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(vp.width / ratio)}px`;
      canvas.dataset.page = String(n);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      watermark(ctx, canvas.width, canvas.height, stamp, ratio);
      pagesEl.appendChild(canvas);
    }
    protect();
    trackReading(doc.id, pdf.numPages);
  }

  // Reading-time tracking: the server measures elapsed time between heartbeats,
  // so this only tells it which page is on screen and when reading pauses.
  async function trackReading(documentId, pageCount) {
    const pill = $("#pill");
    let current = 1;
    const ratios = new Map();
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => ratios.set(Number(e.target.dataset.page), e.intersectionRatio));
      let best = current, bestR = -1;
      ratios.forEach((r, p) => { if (r > bestR) { bestR = r; best = p; } });
      current = best;
      pill.hidden = false;
      pill.textContent = `Page ${current} of ${pageCount}`;
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    document.querySelectorAll("#pages canvas").forEach(c => io.observe(c));

    let deviceId = "";
    try {
      deviceId = localStorage.getItem("deviceId") || "";
      if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem("deviceId", deviceId); }
    } catch (_) {}
    const label = deviceLabel();

    const { data: sid, error } = await sb.rpc("begin_session", { doc: documentId, device: deviceId, label, pages: pageCount });
    if (error || !sid) return;

    const active = () => document.visibilityState === "visible" && !document.body.classList.contains("shielded");
    const beat = () => sb.rpc("heartbeat", { sid, page: current });
    let wasActive = true;

    setInterval(() => {
      const now = active();
      if (now && wasActive) beat();
      else if (now && !wasActive) sb.rpc("resume_session", { sid });
      wasActive = now;
    }, 15000);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { if (wasActive) beat(); wasActive = false; }
    });
  }

  function deviceLabel() {
    const ua = navigator.userAgent;
    const m = ua.match(/Android [\d.]+; ([^;)]+)/);
    let model = m ? m[1].replace(/ Build.*/, "").trim() : "";
    if (!model || model === "K") model = "Android phone";
    return model.slice(0, 80);
  }

  // Tiled diagonal watermark drawn into the page pixels (can't be removed via the DOM).
  function watermark(ctx, w, h, text, ratio) {
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = "#14213d";
    ctx.font = `600 ${Math.round(16 * ratio)}px "IBM Plex Sans", system-ui, sans-serif`;
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

  // Extra deterrents on top of the app's screenshot block.
  function protect() {
    const body = document.body;
    const shield = () => body.classList.add("shielded");
    const unshield = () => body.classList.remove("shielded");

    ["contextmenu", "dragstart", "selectstart", "copy", "cut"].forEach(ev =>
      document.addEventListener(ev, e => e.preventDefault()));
    document.addEventListener("keydown", e => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ["p", "s", "c", "a", "u"].includes(k)) e.preventDefault();
    });
    window.addEventListener("blur", shield);
    window.addEventListener("focus", unshield);
    document.addEventListener("visibilitychange", () => (document.hidden ? shield() : null));
    document.querySelector(".shield").addEventListener("click", unshield);
    window.addEventListener("beforeprint", shield);
  }
})();
