// Viewer: sign in, list documents shared with you, read one in a protected view.
(async function () {
  const { $$ } = window.App;
  const { sb, cfg, configured, inApp, $, esc, icon, brandHTML, timeAgo, renderSignIn, renderNotConfigured, renderHeader, getUser } = window.App;
  const root = $("#app");

  if (!configured) { renderHeader(null); renderNotConfigured(root); return; }

  const params = new URLSearchParams(location.search);
  let docId = params.get("doc");
  let viewName = params.get("view") || "";

  // Coming back from Google sign-in in the app: restore where they were going.
  if (inApp && !docId && !viewName) {
    try {
      const pending = localStorage.getItem("pendingDoc");
      if (pending) { localStorage.removeItem("pendingDoc"); docId = pending; }
      const pv = localStorage.getItem("pendingView");
      if (pv) { localStorage.removeItem("pendingView"); viewName = pv; }
    } catch (_) {}
  }

  // Documents open only inside the Android app. The database enforces this too
  // (start_view needs the app key), so this screen is just the friendly part.
  // The payment form works in a browser as well.
  if (!inApp && (docId || viewName === "docs")) { $("#bar").remove(); renderAppGate(docId); return; }

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  const user = await getUser();
  if (!user) {
    $("#bar").remove();
    renderSignIn(root, {
      title: docId ? "Sign in to open this document" : viewName === "pay" ? "Sign in to submit a payment" : "Sign in",
      subtitle: docId ? "Use the Google account whose email the owner shared this with." : "Use your Google account."
    });
    return;
  }
  renderHeader(user);
  addBell(user);

  if (docId) await openDocument(docId, user);
  else if (viewName === "pay") await window.Payments.render(root, user);
  else if (viewName === "docs") await listDocuments(user);
  else if (viewName === "me") await myAccount(user);
  else if (viewName === "help") await helpPage(user);
  else if (viewName === "feedback") await feedbackPage(user);
  else if (viewName === "quiz") await (params.get("id") ? takeQuiz(user, params.get("id")) : quizList(user));
  else if (viewName === "inbox") await inboxPage(user);
  else await renderHome(user);

  // ---------------------------------------------------------------
  async function renderHome(user) {
    const first = (user.user_metadata?.full_name || user.user_metadata?.name || "").split(" ")[0];
    const { data: anns } = await sb.from("announcements").select("*").order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(10);
    const tile = (href, ic, t, sub) => `<a class="tile" href="${href}"><span class="tile-icon">${icon(ic)}</span>
      <span class="tile-text"><span class="t">${t}</span><span class="s">${sub}</span></span></a>`;
    root.innerHTML = `
      <div class="home-head"><h1>${first ? `Hi ${esc(first)}` : "Welcome"}</h1>
        <p class="sub" style="margin:6px 0 0">What would you like to do?</p></div>
      ${anns?.length ? `<section class="ann-list" aria-label="Announcements">${anns.map(a => `<div class="ann${a.pinned ? " pinned" : ""}">
        <div class="t">${esc(a.title)}</div>${a.body ? `<p class="b">${linkify(a.body)}</p>` : ""}<div class="w">${esc(timeAgo(a.created_at))}</div></div>`).join("")}</section>` : ""}
      <div class="home-tiles">
        <a class="tile" href="?view=docs">
          <span class="tile-icon">${icon("docs")}</span>
          <span class="tile-text"><span class="t">Shared documents</span>
          <span class="s">${inApp ? "Read the documents shared with you." : "Opens in the Android app."}</span></span>
        </a>
        <a class="tile" href="?view=pay">
          <span class="tile-icon">${icon("upload")}</span>
          <span class="tile-text"><span class="t">Submit a payment</span>
          <span class="s" id="payTileSub">Send your earnings, payment and screenshots for review.</span></span>
        </a>
        <span id="quizTile"></span>
        ${tile("?view=me", "user", "My account", "Your documents, reading time, payments and requests.")}
        ${tile("?view=help", "help", "Help", "Answers to common questions.")}
        ${tile("?view=feedback", "chat", "Send feedback", "Ideas, problems or questions for the owner.")}
      </div>`;
    sb.rpc("list_quizzes").then(({ data }) => {
      const el = $("#quizTile"); if (!el || !data?.length) return;
      const todo = data.filter(q => !q.passed && !(q.one_attempt && q.attempts)).length;
      el.outerHTML = tile("?view=quiz", "quiz", "Quizzes", todo ? `${todo} waiting for you.` : "All done. Retake any time.");
    });
    window.Payments?.weekStatus?.(user).then(w => {
      const el = $("#payTileSub"); if (!el) return;
      el.innerHTML = w.paid ? "Done for this week. Thank you!" : `Due every ${esc(w.cycle.dayName)}. This week's is due <strong>${w.dueToday ? "today" : esc(w.cycle.label)}</strong>.`;
    }).catch(() => {});
  }

  function linkify(text) {
    return esc(text).replace(/https:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  }
  // Declared as functions so they're ready before the page routes above run.
  function backLinkHome() { return `<a href="./" class="back">${icon("back")} Home</a>`; }
  function fmtSecs(n) { n = Math.round(n || 0); const h = Math.floor(n / 3600), m = Math.round((n % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }
  function rupees(n) { return `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }

  // ---------------------------------------------------------------
  // Quizzes
  // ---------------------------------------------------------------
  async function quizList(user) {
    const { data, error } = await sb.rpc("list_quizzes");
    const list = error ? [] : data || [];
    root.innerHTML = `${backLinkHome()}<div class="card"><h2>Quizzes</h2><p class="sub">Check what you've learned.</p>
      ${list.length ? `<ul class="doc-list">${list.map(q => `<li><a href="?view=quiz&id=${encodeURIComponent(q.id)}">
        <span class="doc-icon">${icon("quiz")}</span><span class="grow"><span class="t">${esc(q.title)}</span>
        <span class="s">${q.questions} ${q.questions === 1 ? "question" : "questions"}${q.document_title ? `, about "${esc(q.document_title)}"` : ""}${q.attempts ? `, best ${q.best}%` : ""}</span></span>
        ${q.passed ? `<span class="tag live">Passed</span>` : q.one_attempt && q.attempts ? `<span class="tag plain">Done</span>` : `<span class="btn small">${q.attempts ? "Retry" : "Start"}</span>`}</a></li>`).join("")}</ul>`
        : `<div class="empty"><strong>No quizzes right now</strong>When the owner adds one for you, it shows up here.</div>`}</div>`;
  }
  async function takeQuiz(user, id) {
    const { data: q, error } = await sb.rpc("get_quiz", { q: id });
    if (error || !q) { root.innerHTML = `${backLinkHome()}<div class="card narrow"><h2>Quiz not available</h2><p class="sub">It may have been closed, or it's for people who can open a particular document.</p><a class="btn" href="?view=quiz">All quizzes</a></div>`; return; }
    const L = "ABCDEF";
    if (q.one_attempt && q.taken) { root.innerHTML = `${backLinkHome()}<div class="card narrow"><h2>${esc(q.title)}</h2><p class="sub">You've already taken this quiz. It allows one try.</p><a class="btn" href="?view=quiz">All quizzes</a></div>`; return; }
    root.innerHTML = `<a href="?view=quiz" class="back">${icon("back")} Quizzes</a><div class="card"><h2>${esc(q.title)}</h2>
      <p class="sub">${q.description ? `${esc(q.description)} ` : ""}${q.questions.length} questions. Pass mark ${q.pass_percent}%.${q.one_attempt ? " <strong>One try only.</strong>" : ""}</p>
      <form id="quizForm">${q.questions.map((x, i) => `<fieldset class="quiz-q" data-q="${x.id}"><legend class="q-prompt">${i + 1}. ${esc(x.prompt)}</legend>
        ${x.options.map((o, k) => `<label class="quiz-opt"><input type="radio" name="q${i}" value="${k}"><span><span class="muted">${L[k]}.</span> ${esc(o)}</span></label>`).join("")}</fieldset>`).join("")}
        <button class="primary full" type="submit" style="margin-top:16px">Submit answers</button><p class="msg" id="qzMsg" role="status"></p></form></div>`;
    let warned = false;
    $("#quizForm").onsubmit = async e => {
      e.preventDefault();
      const answers = {}; let missing = 0;
      q.questions.forEach((x, i) => { const c = $(`input[name="q${i}"]:checked`); if (c) answers[x.id] = Number(c.value); else missing++; });
      const m = $("#qzMsg");
      if (missing && !warned) { warned = true; m.className = "msg err"; m.textContent = `You haven't answered ${missing} ${missing === 1 ? "question" : "questions"}. Tap Submit again to send anyway.`; return; }
      const btn = $("#quizForm button[type=submit]"); btn.disabled = true;
      const { data: r, error: sErr } = await sb.rpc("submit_quiz", { q: id, answers });
      if (sErr) { btn.disabled = false; m.className = "msg err"; m.textContent = /already_taken/.test(sErr.message) ? "You've already taken this quiz." : /too_many/.test(sErr.message) ? "Too many tries today. Please come back tomorrow." : "Couldn't submit. Please try again."; return; }
      m.textContent = ""; m.className = "msg";
      const pct = r.total ? Math.round((100 * r.score) / r.total) : 0;
      r.review.forEach((v, i) => {
        const fs = $(`[data-q="${v.id}"]`); if (!fs) return;
        $$("input", fs).forEach(inp => { inp.disabled = true; const k = Number(inp.value), lab = inp.closest(".quiz-opt");
          if (v.correct != null && k === v.correct) lab.classList.add("right");
          else if (k === v.chosen && !v.right) lab.classList.add("wrong"); });
        if (v.explanation) fs.insertAdjacentHTML("beforeend", `<p class="hint">${esc(v.explanation)}</p>`);
      });
      btn.remove();
      $("#quizForm").insertAdjacentHTML("afterbegin", `<div class="score"><strong>${r.score} / ${r.total}</strong>${pct}%, ${r.passed ? "passed. Well done!" : `pass mark is ${r.pass_percent}%.`}</div>`);
      $("#quizForm").insertAdjacentHTML("beforeend", `<div class="row" style="margin-top:14px"><a class="btn" href="?view=quiz">All quizzes</a>${q.one_attempt ? "" : `<a class="btn" href="?view=quiz&id=${encodeURIComponent(id)}">Try again</a>`}</div>`);
      window.scrollTo(0, 0);
    };
  }

  // ---------------------------------------------------------------
  // Notifications: what's new since you last looked
  // ---------------------------------------------------------------
  function seenAt() { try { return Number(localStorage.getItem("notifSeen")) || Date.now() - 7 * 864e5; } catch (_) { return Date.now() - 7 * 864e5; } }
  async function gatherNotifications(user) {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const [anns, docs, pays, fb, reqs, devs] = await Promise.all([
      sb.from("announcements").select("id,title,created_at").gte("created_at", since),
      sb.from("documents").select("id,title,created_at").gte("created_at", since),
      sb.from("payment_submissions").select("id,amount_sent,status,admin_note,reviewed_at").eq("user_id", user.id).gte("created_at", since),
      sb.from("feedback").select("id,message,admin_reply,replied_at").gte("created_at", since),
      sb.from("access_requests").select("id,status,decided_at").gte("created_at", since),
      sb.from("device_requests").select("id,status,device_label,decided_at").gte("created_at", since)
    ]);
    const out = [];
    (anns.data || []).forEach(a => out.push({ at: a.created_at, ic: "megaphone", t: a.title, s: "Announcement", href: "./" }));
    (docs.data || []).forEach(d => out.push({ at: d.created_at, ic: "file", t: `New document: ${d.title}`, s: "Shared with you", href: `?doc=${encodeURIComponent(d.id)}` }));
    (pays.data || []).filter(p => p.reviewed_at && p.status !== "pending").forEach(p => out.push({ at: p.reviewed_at, ic: "wallet", t: `Your ${rupees(p.amount_sent)} payment was ${p.status}`, s: p.admin_note || "Payments", href: "?view=pay" }));
    (fb.data || []).filter(f => f.admin_reply && f.replied_at).forEach(f => out.push({ at: f.replied_at, ic: "chat", t: "The owner replied to your feedback", s: f.admin_reply.slice(0, 90), href: "?view=feedback" }));
    (reqs.data || []).filter(r => r.decided_at).forEach(r => out.push({ at: r.decided_at, ic: "lock", t: r.status === "approved" ? "Your access request was approved" : "Your access request was declined", s: "Access", href: "?view=docs" }));
    (devs.data || []).filter(r => r.decided_at).forEach(r => out.push({ at: r.decided_at, ic: "phone", t: r.status === "approved" ? `You can now read on ${r.device_label || "your new phone"}` : "Your new phone wasn't approved", s: "Phone", href: "?view=docs" }));
    return out.sort((a, b) => new Date(b.at) - new Date(a.at));
  }
  async function addBell(user) {
    const who = $("#bar .who"); if (!who) return;
    who.insertAdjacentHTML("afterbegin", `<a class="bell" href="?view=inbox" aria-label="Notifications">${icon("bell")}<span class="dot" hidden></span></a>`);
    try {
      const list = await gatherNotifications(user);
      const n = list.filter(x => new Date(x.at) > seenAt()).length;
      const dot = $("#bar .bell .dot");
      if (n && viewName !== "inbox") { dot.hidden = false; dot.textContent = n > 9 ? "9+" : n; $("#bar .bell").setAttribute("aria-label", `${n} new notifications`); }
    } catch (_) {}
  }
  async function inboxPage(user) {
    const seen = seenAt();
    const list = await gatherNotifications(user);
    try { localStorage.setItem("notifSeen", String(Date.now())); } catch (_) {}
    root.innerHTML = `${backLinkHome()}<div class="card"><h2>Notifications</h2><p class="sub">The last 30 days.</p>
      ${list.length ? `<ul class="notif-list">${list.map(x => `<li class="${new Date(x.at) > seen ? "unread" : ""}"><span class="ic">${icon(x.ic)}</span>
        <a class="grow" href="${esc(x.href)}" style="color:inherit;text-decoration:none"><div class="t">${esc(x.t)}</div><div class="s">${esc(x.s)}, ${esc(timeAgo(x.at))}</div></a></li>`).join("")}</ul>`
        : `<div class="empty"><strong>You're all caught up</strong>New documents, announcements and replies show up here.</div>`}</div>`;
  }

  // ---------------------------------------------------------------
  async function myAccount(user) {
    root.innerHTML = `${backLinkHome()}<div class="card"><p class="muted">Loading…</p></div>`;
    const [docs, sess, pays, reqs] = await Promise.all([
      sb.from("documents").select("id,title"),
      sb.from("view_sessions").select("document_id,seconds,max_page,page_count,last_seen_at").order("last_seen_at", { ascending: false }).limit(500),
      sb.from("payment_submissions").select("amount_earned,amount_sent,status,created_at").eq("user_id", user.id),
      sb.from("access_requests").select("status,created_at").order("created_at", { ascending: false }).limit(1)
    ]);
    const S = sess.error ? [] : sess.data || [], D = docs.data || [], P = pays.error ? [] : pays.data || [];
    const counted = P.filter(p => p.status !== "rejected");
    const byDoc = new Map();
    S.forEach(s => { const r = byDoc.get(s.document_id) || { secs: 0, max: 0, pages: 0, last: s.last_seen_at }; r.secs += s.seconds || 0; r.max = Math.max(r.max, s.max_page || 0); r.pages = Math.max(r.pages, s.page_count || 0); byDoc.set(s.document_id, r); });
    const name = user.user_metadata?.full_name || user.user_metadata?.name || "";
    const req = reqs.data?.[0];
    root.innerHTML = `${backLinkHome()}
      <div class="card">
        <div class="row" style="gap:14px;flex-wrap:nowrap"><span class="avatar lg">${esc((name || user.email).split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase())}</span>
          <div><h2 style="margin:0">${esc(name || "My account")}</h2><p class="sub" style="margin:2px 0 0">${esc(user.email)}</p></div></div>
        <div class="stat-row">
          <div><span>Documents</span><strong>${D.length}</strong></div>
          <div><span>Reading time</span><strong>${fmtSecs(S.reduce((t, s) => t + (s.seconds || 0), 0))}</strong></div>
          <div><span>Earned</span><strong>${rupees(counted.reduce((t, p) => t + Number(p.amount_earned), 0))}</strong></div>
          <div><span>Paid</span><strong>${rupees(counted.reduce((t, p) => t + Number(p.amount_sent), 0))}</strong></div>
        </div>
        ${req?.status === "pending" ? `<div class="notice" style="margin-bottom:12px">Your access request from ${esc(timeAgo(req.created_at))} is waiting for review.</div>` : ""}
        <h3 class="folder-head">Your documents</h3>
        ${D.length ? `<ul class="doc-list">${D.map(d => { const r = byDoc.get(d.id); return `<li><a href="?doc=${encodeURIComponent(d.id)}">
          <span class="doc-icon">${icon("file")}</span><span class="grow"><span class="t">${esc(d.title)}</span>
          <span class="s">${r ? `${fmtSecs(r.secs)} read${r.pages ? `, reached page ${r.max} of ${r.pages}` : ""}` : "Not opened yet"}</span></span></a></li>`; }).join("")}</ul>`
          : `<p class="muted small-text">Nothing shared with you yet. <a href="?view=docs">Request access</a></p>`}
        <h3 class="folder-head">Payments</h3>
        <p class="small-text" style="margin:0">${P.length ? `${P.length} ${P.length === 1 ? "submission" : "submissions"}, ${P.filter(p => p.status === "pending").length} waiting for review.` : "No payments yet."} <a href="?view=pay">Open payments</a></p>
        <div class="row" style="margin-top:22px;gap:10px"><a class="btn" href="?view=help">Help</a><a class="btn" href="?view=feedback">Send feedback</a>
          <span class="spacer"></span><button type="button" class="ghost" id="meOut">Sign out</button></div>
      </div>`;
    $("#meOut").onclick = () => window.App.signOut();
  }

  // ---------------------------------------------------------------
  async function helpPage(user) {
    const { data, error } = await sb.from("faqs").select("question,answer").order("sort_order").order("updated_at");
    const list = error ? [] : data || [];
    root.innerHTML = `${backLinkHome()}<div class="card faq"><h2>Help</h2><p class="sub">Answers to common questions.</p>
      ${list.length ? list.map(f => `<details><summary>${esc(f.question)}</summary><p class="a">${linkify(f.answer)}</p></details>`).join("")
        : `<div class="empty"><strong>No help articles yet</strong>Send a question and the owner will reply.</div>`}
      <p style="margin:18px 0 0">Still stuck? <a href="?view=feedback">Send a question to the owner</a>.</p></div>`;
  }

  // ---------------------------------------------------------------
  async function feedbackPage(user) {
    const { data, error } = await sb.from("feedback").select("*").order("created_at", { ascending: false }).limit(30);
    if (error) { root.innerHTML = `${backLinkHome()}<div class="card"><h2>Send feedback</h2><p class="muted">Feedback isn't switched on yet.</p></div>`; return; }
    root.innerHTML = `${backLinkHome()}<div class="card"><h2>Send feedback</h2><p class="sub">Only the owner sees this. Replies show up below.</p>
      <form id="fbForm">
        <div class="seg" role="radiogroup" aria-label="Type">${[["idea", "Idea"], ["problem", "Problem"], ["question", "Question"], ["other", "Other"]].map(([k, l], i) =>
          `<button type="button" data-kind="${k}" aria-selected="${i ? "false" : "true"}">${l}</button>`).join("")}</div>
        <label for="fbMsg" style="margin-top:0">Message</label><textarea id="fbMsg" rows="5" required maxlength="2000" placeholder="What's on your mind?"></textarea>
        <button class="primary full" type="submit" style="margin-top:12px">Send</button>
        <p class="msg" id="fbStatus" role="status"></p>
      </form>
      ${data.length ? `<h3 class="folder-head">Your messages</h3><ul class="fb-list">${data.map(f => `<li class="fb" style="padding:12px 0">
        <span class="muted small-text">${esc(timeAgo(f.created_at))}</span><p class="fb-msg">${esc(f.message)}</p>
        ${f.admin_reply ? `<p class="fb-reply"><strong>Reply:</strong> ${linkify(f.admin_reply)}</p>` : `<span class="muted small-text">${f.status === "new" ? "Sent" : "Seen by the owner"}</span>`}</li>`).join("")}</ul>` : ""}
    </div>`;
    let kind = "idea";
    $$("[data-kind]").forEach(b => b.onclick = () => { kind = b.dataset.kind; $$("[data-kind]").forEach(x => x.setAttribute("aria-selected", String(x === b))); });
    $("#fbForm").onsubmit = async e => {
      e.preventDefault();
      const btn = $("#fbForm button[type=submit]"), st = $("#fbStatus");
      btn.disabled = true;
      const { error: iErr } = await sb.from("feedback").insert({ kind, message: $("#fbMsg").value.trim() });
      if (iErr) { btn.disabled = false; st.className = "msg err"; st.textContent = /too_many/.test(iErr.message) ? "You've sent a lot today. Please try again tomorrow." : "Couldn't send. Please try again."; return; }
      feedbackPage(user); window.App.toast?.("Sent. Thank you!");
    };
  }

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
      .select("*").order("created_at", { ascending: false });
    if (error) { root.innerHTML = `<div class="card"><p class="msg err">${esc(error.message)}</p></div>`; return; }
    if (!data.length) {
      root.innerHTML = `<a href="./" class="back">${icon("back")} Home</a><div class="card"><h2>Shared with you</h2>
        <div class="empty"><strong>Nothing here yet</strong>
        Documents shared with ${esc(user.email)} will appear here. If you expected one, ask the owner to check your email ID.</div>
        <div id="reqBox" class="req-card"></div></div>`;
      requestAccess(user, $("#reqBox"));
      return;
    }
    const { data: views } = data.some(d => d.one_time) ? await sb.from("document_views").select("document_id,used,allowed") : { data: [] };
    const left = d => { const v = (views || []).find(x => x.document_id === d.id); return v ? Math.max(0, v.allowed - v.used) : 1; };
    const folders = [...new Set(data.map(d => d.folder || ""))].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b));
    const item = d => `
        <li><a href="?doc=${encodeURIComponent(d.id)}">
          <span class="doc-icon">${icon("file")}</span>
          <span class="grow"><span class="t">${esc(d.title)}</span>
            <span class="s">Shared ${esc(timeAgo(d.created_at))}${d.expires_at ? `, available until ${esc(new Date(d.expires_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}` : ""}${d.one_time ? (left(d) ? `, <strong>${left(d) === 1 ? "one view" : `${left(d)} views`} left</strong>` : ", already viewed") : ""}</span></span>
          <span class="btn small">Open</span></a></li>`;
    root.innerHTML = `<a href="./" class="back">${icon("back")} Home</a><div class="card"><h2>Shared with you</h2><p class="sub">${data.length} ${data.length === 1 ? "document" : "documents"}</p>
      ${folders.map(f => `${folders.length > 1 ? `<h3 class="folder-head">${esc(f || "Other documents")}</h3>` : ""}
      <ul class="doc-list">${data.filter(d => (d.folder || "") === f).map(item).join("")}</ul>`).join("")}</div>`;
  }

  // Same ID the app reports for this phone; a saved random ID on older app versions.
  function getDeviceId() {
    try {
      const hw = typeof window.SecureDocApp?.deviceId === "function" ? window.SecureDocApp.deviceId() : "";
      if (hw) return `a:${hw}`;
      let id = localStorage.getItem("deviceId") || "";
      if (!id) { id = crypto.randomUUID(); localStorage.setItem("deviceId", id); }
      return id;
    } catch (_) { return ""; }
  }

  async function phoneLocked(doc) {
    const { data } = await sb.from("device_requests").select("status,created_at").order("created_at", { ascending: false }).limit(1);
    const last = data?.[0];
    const waiting = last?.status === "pending";
    root.innerHTML = `<div class="card narrow"><h2>This account is linked to another phone</h2>
      <p class="sub">To keep documents safe, each account reads on one phone. ${waiting ? "Your request to use this phone is waiting for the owner's approval." : "Ask the owner to switch your account to this phone."}</p>
      ${waiting ? `<button class="full" type="button" id="reAsk">Send the request again</button>` : `<button class="primary full" type="button" id="reAsk">Ask to use this phone</button>`}
      <p class="msg" id="askMsg" role="status"></p>
      <a class="btn full" style="margin-top:10px" href="?view=docs">Back to documents</a></div>`;
    $("#reAsk").onclick = async () => {
      const { error } = await sb.rpc("request_device_change", { device: getDeviceId(), label: deviceLabel() });
      const m = $("#askMsg");
      if (error) { m.className = "msg err"; m.textContent = "Couldn't send the request. Please try again."; return; }
      m.className = "msg ok"; m.textContent = "Request sent. You'll be able to open documents here once it's approved.";
      $("#reAsk").disabled = true;
    };
  }

  function viewUsed(doc) {
    root.innerHTML = `<div class="card narrow"><h2>Already viewed</h2>
      <p class="sub">"${esc(doc.title)}" could be opened only once, and you've used that view. Ask the owner if you need to see it again.</p>
      <a class="btn" href="?view=docs">See documents shared with you</a></div>`;
  }

  // ---------------------------------------------------------------
  // Ask the owner for access; shows the status of the latest request.
  async function requestAccess(user, box) {
    if (!box) return;
    const { data, error } = await sb.from("access_requests").select("status,created_at,decided_at")
      .order("created_at", { ascending: false }).limit(1);
    if (error) { box.remove(); return; } // feature not switched on yet
    const last = data?.[0];
    if (last?.status === "pending") {
      box.innerHTML = `<h3 style="margin:0 0 6px">Request sent</h3><p class="sub" style="margin:0">You asked for access ${esc(timeAgo(last.created_at))}. The owner will review it soon.</p>`;
      return;
    }
    const name = user.user_metadata?.full_name || user.user_metadata?.name || "";
    box.innerHTML = `
      <h3 style="margin:0 0 6px">Request access</h3>
      <p class="sub" style="margin:0 0 6px">${last?.status === "declined" ? "Your last request was declined. You can send a new one." : last?.status === "approved" ? "Your last request was approved. Need more? Ask again." : "Send a request to the owner with your email ID."}</p>
      <form id="reqForm">
        <label for="rqName">Your name</label><input id="rqName" type="text" required maxlength="120" value="${esc(name)}">
        <label for="rqMsg">Message (optional)</label><textarea id="rqMsg" rows="3" maxlength="500" placeholder="e.g. Referred by Hrsh, joining Batch 3"></textarea>
        <button class="primary full" type="submit" style="margin-top:12px">Send request</button>
        <p class="msg" id="rqStatus" role="status"></p>
      </form>`;
    $("#reqForm", box).onsubmit = async e => {
      e.preventDefault();
      const btn = $("button[type=submit]", box); btn.disabled = true;
      const { error: iErr } = await sb.from("access_requests").insert({ name: $("#rqName").value.trim(), message: $("#rqMsg").value.trim() || null });
      if (iErr) {
        btn.disabled = false;
        const st = $("#rqStatus"); st.className = "msg err";
        st.textContent = /duplicate|unique/.test(iErr.message) ? "You already have a request waiting." : "Couldn't send the request. Please try again.";
        return;
      }
      requestAccess(user, box);
    };
  }

  // ---------------------------------------------------------------
  async function openDocument(id, user) {
    root.innerHTML = `<div class="card"><p class="muted">Checking access…</p></div>`;

    const noAccess = () => {
      root.innerHTML = `<div class="card narrow"><h2>You don't have access</h2>
        <p class="sub">${esc(user.email)} isn't on the list for this document, or the link was turned off or has expired. Ask the owner to check your email ID.</p>
        <a class="btn" href="?view=docs">See documents shared with you</a>
        <div id="reqBox" class="req-card"></div></div>`;
      requestAccess(user, $("#reqBox"));
    };

    const { data: doc, error } = await sb.from("documents").select("*").eq("id", id).maybeSingle();
    if (error || !doc) return noAccess();

    // One-time documents: say so before using up the view.
    if (doc.one_time) {
      const { data: vs } = await sb.from("document_views").select("used,allowed,last_opened_at").eq("document_id", doc.id);
      const v = vs?.[0] || { used: 0, allowed: 1 };
      const sameSitting = v.last_opened_at && Date.now() - new Date(v.last_opened_at) < 15 * 60e3;
      if (!sameSitting && v.used >= v.allowed) return viewUsed(doc);
      if (!sameSitting) {
        const left = v.allowed - v.used;
        const go = await new Promise(res => {
          root.innerHTML = `<div class="card narrow"><h2>${esc(doc.title)}</h2>
            <p class="sub">You can open this document ${left === 1 ? "only once" : `${left} more times`}. Once you open it, you have 15 minutes to come back to it if the app closes.</p>
            <button class="primary full" type="button" id="goOpen">Open now</button>
            <a class="btn full" style="margin-top:10px" href="?view=docs">Not now</a></div>`;
          $("#goOpen").onclick = () => res(true);
        });
        if (!go) return;
      }
    }

    // Ask the database for a short-lived grant; it checks the email list and the app key.
    let appKey = "";
    try { appKey = window.SecureDocApp.getKey(); } catch (_) {}
    let { data: path, error: gErr } = await sb.rpc("start_view", { doc: doc.id, app_key: appKey, device: getDeviceId(), label: deviceLabel() });
    // Before 009_security.sql is run, the database only knows the two-argument version.
    if (gErr && (gErr.code === "PGRST202" || /Could not find the function/i.test(gErr.message))) {
      ({ data: path, error: gErr } = await sb.rpc("start_view", { doc: doc.id, app_key: appKey }));
    }
    if (gErr) {
      if (/app_required/.test(gErr.message)) {
        root.innerHTML = `<div class="card narrow"><h2>Update the app</h2>
          <p class="sub">This version of the app can't open documents. Download the latest version and try again.</p>
          <a class="btn primary" href="${esc(cfg.apkUrl)}">Download the latest app</a></div>`;
        return;
      }
      if (/view_used/.test(gErr.message)) return viewUsed(doc);
      if (/device_locked/.test(gErr.message)) return phoneLocked(doc);
      return noAccess();
    }

    const { data: signed, error: sErr } = await sb.storage.from("documents")
      .createSignedUrl(path, cfg.signedUrlSeconds || 60);
    if (sErr) { root.innerHTML = `<div class="card"><p class="msg err">${esc(sErr.message)}</p></div>`; return; }

    root.innerHTML = `
      <div class="viewer">
        <a href="?view=docs" class="back">${icon("back")} All documents</a>
        <div class="reader-head"><h1>${esc(doc.title)}</h1><span class="tag live">View only</span></div>
        <div class="viewer-banner">${icon("lock")}<span>Viewing as <strong>${esc(user.email)}</strong>. Screenshots and recording are blocked, and every page carries your email.</span></div>
        <div class="pages" id="pages"><p class="muted">Loading document…</p></div>
      </div>
      <div class="page-pill" id="pill" hidden>
        <button type="button" class="zbtn" id="zOut" aria-label="Zoom out">−</button>
        <button type="button" class="zlvl" id="zLvl" aria-label="Fit to width">100%</button>
        <button type="button" class="zbtn" id="zIn" aria-label="Zoom in">+</button>
        <span class="zsep" aria-hidden="true"></span>
        <span id="pageNum">Page 1</span>
      </div>
      <div class="shield">Content hidden. Tap to keep reading.</div>`;

    const buf = await (await fetch(signed.signedUrl)).arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    const pagesEl = $("#pages");
    pagesEl.innerHTML = `<div class="zoom-inner" id="zoomInner"></div>`;
    const inner = $("#zoomInner");

    const stamp = `${user.email}  ${new Date().toLocaleString()}`;
    const fitW = Math.min(pagesEl.clientWidth || 900, 900);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    inner.style.width = `${fitW}px`;

    const MIN = 1, MAX = 4;
    let zoom = 1, gen = 0, pending = null;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.dataset.page = String(n);
      canvas.width = Math.floor(fitW * ratio);
      canvas.height = Math.floor(fitW * ratio * base.height / base.width);
      inner.appendChild(canvas);
      const p = { n, page, base, canvas, res: 0 };
      pages.push(p);
      await renderPage(p, 1);
    }

    // ---------- zoom ----------

    // Render (or re-render sharper) a page for the given zoom. Pixel width is
    // capped so very high zoom doesn't exhaust phone memory.
    async function renderPage(p, z) {
      const pxWidth = Math.min(fitW * z * ratio, 3200);
      const scale = pxWidth / p.base.width;
      if (Math.abs(p.res - scale) < 0.01) return;
      const myGen = gen;
      const vp = p.page.getViewport({ scale });
      const off = document.createElement("canvas");
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      const octx = off.getContext("2d");
      await p.page.render({ canvasContext: octx, viewport: vp }).promise;
      watermark(octx, off.width, off.height, stamp, pxWidth / fitW);
      if (myGen !== gen && p.res) return;           // zoom changed meanwhile; a newer render will follow
      p.canvas.width = off.width;
      p.canvas.height = off.height;
      p.canvas.getContext("2d").drawImage(off, 0, 0);
      p.res = scale;
    }

    // Re-render pages near the screen at the new zoom; others when scrolled to.
    const near = new Set();
    const nearObs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        const p = pages[Number(e.target.dataset.page) - 1];
        if (e.isIntersecting) { near.add(p); renderPage(p, zoom); } else near.delete(p);
      });
    }, { rootMargin: "300px 0px" });
    pages.forEach(p => nearObs.observe(p.canvas));

    function setZoom(z, cx = window.innerWidth / 2, cy = window.innerHeight / 2) {
      z = Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100));
      if (z === zoom) return;
      const before = inner.getBoundingClientRect();
      const relX = (cx - before.left) / zoom, relY = (cy - before.top) / zoom;
      zoom = z;
      gen++;
      inner.style.width = `${fitW * zoom}px`;
      pagesEl.classList.toggle("zoomed", zoom > 1);
      const after = inner.getBoundingClientRect();
      pagesEl.scrollLeft += relX * zoom + after.left - cx;
      window.scrollBy(0, relY * zoom + after.top - cy);
      $("#zLvl").textContent = `${Math.round(zoom * 100)}%`;
      clearTimeout(pending);
      pending = setTimeout(() => near.forEach(p => renderPage(p, zoom)), 220);
    }

    $("#zIn").onclick = () => setZoom(zoom + 0.5);
    $("#zOut").onclick = () => setZoom(zoom - 0.5);
    $("#zLvl").onclick = () => setZoom(1);

    // Pinch to zoom (live preview with a transform, then commit) and double-tap.
    let pinch = null, lastTap = 0, lastTapX = 0, lastTapY = 0, moved = false;
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    pagesEl.addEventListener("touchstart", e => {
      if (e.touches.length === 2) {
        const r = inner.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        pinch = { d: dist(e.touches), cx, cy, s: 1 };
        inner.style.transformOrigin = `${cx - r.left}px ${cy - r.top}px`;
      } else { moved = false; }
    }, { passive: true });
    pagesEl.addEventListener("touchmove", e => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const s = Math.min(MAX / zoom, Math.max(MIN / zoom, dist(e.touches) / pinch.d));
        pinch.s = s;
        inner.style.transform = `scale(${s})`;
      } else { moved = true; }
    }, { passive: false });
    pagesEl.addEventListener("touchend", e => {
      if (pinch && e.touches.length < 2) {
        inner.style.transform = "";
        setZoom(zoom * pinch.s, pinch.cx, pinch.cy);
        pinch = null;
        lastTap = 0;
        return;
      }
      if (e.touches.length || moved || !e.changedTouches.length) return;
      const t = e.changedTouches[0], now = Date.now();
      if (now - lastTap < 300 && Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 30) {
        setZoom(zoom > 1 ? 1 : 2.5, t.clientX, t.clientY);
        lastTap = 0;
      } else { lastTap = now; lastTapX = t.clientX; lastTapY = t.clientY; }
    });
    // Ctrl + mouse wheel / trackpad pinch on a computer.
    pagesEl.addEventListener("wheel", e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
    }, { passive: false });

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
      $("#pageNum").textContent = `Page ${current} of ${pageCount}`;
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    document.querySelectorAll("#pages canvas").forEach(c => io.observe(c));

    const deviceId = getDeviceId();
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
