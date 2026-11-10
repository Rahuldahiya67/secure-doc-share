// Admin dashboard: share documents, manage access, see who read what and for how long.
(async function () {
  const {
    sb, cfg, configured, $, $$, esc, icon, brandHTML, fmtDuration, timeAgo, fmtDate, initials, toast,
    renderSignIn, renderNotConfigured, getUser, signOut
  } = window.App;
  const app = $("#app");

  if (!configured) { app.innerHTML = "<main></main>"; renderNotConfigured($("main", app)); return; }

  const user = await getUser();
  if (!user) {
    app.innerHTML = "<main></main>";
    renderSignIn($("main", app), { title: "Owner sign in", subtitle: "Sign in with the email listed as admin in Supabase." });
    return;
  }

  const { data: isAdmin } = await sb.rpc("is_admin");
  if (!isAdmin) {
    app.innerHTML = `<main><div class="card narrow">${brandHTML()}<h2>This account isn't an owner</h2>
      <p class="sub">${esc(user.email)} isn't in the admins table. Add it in Supabase (see the README), or sign in with your owner account.</p>
      <button id="so" type="button">Sign out</button></div></main>`;
    $("#so").onclick = signOut;
    return;
  }

  // ---------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------
  const LIVE_MS = 45 * 1000;
  const S = { docs: [], sessions: [], blocked: [], payments: [], accounts: [], audit: [], peopleRows: [], groups: [], requests: [] };
  const D = {}; // derived indexes

  async function load() {
    const [docs, sessions, blocked, payments, accounts, settings, audit, owner, peopleRows, groups, requests, docViews, anns, faqs, feedback, role, locks, devReqs, admins, quizRows, profiles] = await Promise.all([
      sb.from("documents")
        .select("*,document_access(email,added_at)")
        .order("created_at", { ascending: false }),
      sb.from("view_sessions")
        .select("id,document_id,email,device_id,device_label,page_count,max_page,seconds,page_seconds,started_at,last_seen_at")
        .order("started_at", { ascending: false }).limit(5000),
      sb.from("blocked_emails").select("email,reason,blocked_at").order("blocked_at", { ascending: false }),
      sb.from("payment_submissions").select("*").order("created_at", { ascending: false }).limit(3000),
      sb.from("payment_accounts").select("*").order("sort_order").order("created_at"),
      sb.from("app_settings").select("key,value"),
      sb.from("audit_log").select("*").order("at", { ascending: false }).limit(1000),
      sb.rpc("is_owner"),
      sb.from("people").select("*"),
      sb.from("groups").select("id,name,description,created_at,group_members(email,added_at),group_documents(document_id)").order("name"),
      sb.from("access_requests").select("*").order("created_at", { ascending: false }).limit(500),
      sb.from("document_views").select("*"),
      sb.from("announcements").select("*").order("pinned", { ascending: false }).order("created_at", { ascending: false }),
      sb.from("faqs").select("*").order("sort_order").order("updated_at"),
      sb.from("feedback").select("*").order("created_at", { ascending: false }).limit(500),
      sb.rpc("my_role"),
      sb.from("device_locks").select("*"),
      sb.from("device_requests").select("*").order("created_at", { ascending: false }).limit(300),
      sb.from("admins").select("*").order("email"),
      sb.from("quizzes").select("*,quiz_questions(*),quiz_attempts(id,email,score,total,passed,answers,created_at)").order("created_at", { ascending: false }),
      sb.from("candidate_profiles").select("*")
    ]);
    if (docs.error) throw docs.error;
    S.docs = docs.data || [];
    S.sessions = sessions.error ? [] : sessions.data || [];
    S.blocked = blocked.error ? [] : blocked.data || [];
    S.analyticsMissing = Boolean(sessions.error || blocked.error);
    S.payments = payments.error ? [] : payments.data || [];
    S.paymentsMissing = Boolean(payments.error);
    S.paymentsV2 = !accounts.error && !audit.error;
    S.accounts = accounts.error ? [] : accounts.data || [];
    S.audit = audit.error ? [] : audit.data || [];
    S.isOwner = owner.error ? false : Boolean(owner.data);
    S.peopleV2 = !peopleRows.error && !groups.error && !requests.error;
    S.peopleRows = peopleRows.error ? [] : peopleRows.data || [];
    S.groups = groups.error ? [] : groups.data || [];
    S.requests = requests.error ? [] : requests.data || [];
    S.docsV3 = !docViews.error;
    S.docViews = docViews.error ? [] : docViews.data || [];
    S.portalV1 = !anns.error && !faqs.error && !feedback.error;
    S.announcements = anns.data || []; S.faqs = faqs.data || []; S.feedback = feedback.data || [];
    S.securityV1 = !role.error && !locks.error && !devReqs.error;
    S.role = role.error ? (S.isOwner ? "owner" : "admin") : role.data || "admin";
    S.deviceLocks = locks.data || []; S.deviceRequests = devReqs.data || []; S.admins = admins.data || [];
    S.quizV1 = !quizRows.error;
    S.profiles = profiles.error ? [] : profiles.data || [];
    S.profilesV1 = !profiles.error;
    S.quizzes = (quizRows.data || []).map(z => ({ ...z, quiz_attempts: (z.quiz_attempts || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) }));
    const exp = (settings.data || []).find(s => s.key === "expected_percent");
    S.expectedPercent = exp ? Number(exp.value) : 0;
    const pd = (settings.data || []).find(s => s.key === "payment_day");
    S.payDay = pd && Number(pd.value) >= 0 && Number(pd.value) <= 6 ? Number(pd.value) : 3; // Wednesday
    S.deviceLock = (settings.data || []).find(s => s.key === "device_lock")?.value === true;
    S.sheetKey = (settings.data || []).find(s => s.key === "sheet_token")?.value || null;
    if (S.accounts.some(x => x.qr_path)) {
      const { data: urls } = await sb.storage.from("payment-qr").createSignedUrls(S.accounts.filter(x => x.qr_path).map(x => x.qr_path), 3600);
      (urls || []).forEach(u => { const x = S.accounts.find(y => y.qr_path === u.path); if (x) x.qrUrl = u.signedUrl; });
    }
    derive();
  }

  function derive() {
    D.doc = new Map(S.docs.map(d => [d.id, d]));
    D.blocked = new Set(S.blocked.map(b => b.email));
    D.sessByDoc = groupBy(S.sessions, s => s.document_id);
    D.sessByEmail = groupBy(S.sessions, s => s.email);
    D.people = new Map(); // email -> { docs:Set, opened:Set }
    // Who can open each document: its own list plus members of any group it's shared with.
    D.access = new Map(); // doc id -> Map(email -> { direct:bool, groups:[names] })
    S.docs.forEach(d => {
      const m = new Map(d.document_access.map(a => [a.email, { direct: true, added_at: a.added_at, groups: [] }]));
      D.access.set(d.id, m);
    });
    S.groups.forEach(g => g.group_documents.forEach(gd => {
      const m = D.access.get(gd.document_id); if (!m) return;
      g.group_members.forEach(gm => {
        if (!m.has(gm.email)) m.set(gm.email, { direct: false, added_at: gm.added_at, groups: [] });
        m.get(gm.email).groups.push(g.name);
      });
    }));
    D.access.forEach((m, id) => m.forEach((_, email) => person(email).docs.add(id)));
    S.sessions.forEach(s => person(s.email).opened.add(s.document_id));
    S.payments.forEach(p => person(p.email));
    S.peopleRows.forEach(p => person(p.email));
    S.groups.forEach(g => g.group_members.forEach(m => person(m.email)));
    S.requests.forEach(r => person(r.email));
    S.feedback.forEach(f => person(f.email));
    S.profiles.forEach(p => person(p.email));
    D.alerts = computeAlerts();
    document.body.classList.toggle("readonly", S.role === "viewer");
  }
  function person(email) {
    if (!D.people.has(email)) D.people.set(email, { docs: new Set(), opened: new Set() });
    return D.people.get(email);
  }
  function groupBy(list, key) {
    const m = new Map();
    list.forEach(x => { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
    return m;
  }
  const sum = (list, f) => list.reduce((t, x) => t + (f(x) || 0), 0);
  const isLive = s => Date.now() - new Date(s.last_seen_at).getTime() < LIVE_MS;
  const docTitle = id => D.doc.get(id)?.title || "Deleted document";
  function docStatus(d) {
    if (!d.is_active) return { cls: "off", text: "Link off" };
    if (d.available_from && new Date(d.available_from) > new Date()) return { cls: "warn", text: `Opens in ${timeLeft(d.available_from)}` };
    if (d.expires_at && new Date(d.expires_at) < new Date()) return { cls: "warn", text: "Expired" };
    if (d.expires_at) return { cls: "live", text: `Closes in ${timeLeft(d.expires_at)}` };
    return { cls: "live", text: "Sharing" };
  }
  function timeLeft(iso) {
    const m = Math.max(0, Math.round((new Date(iso) - Date.now()) / 6e4));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 48) return mm ? `${h}h ${mm}m` : `${h}h`;
    return `${Math.round(h / 24)} days`;
  }
  // 1 to 24 hours, then a few longer choices.
  const EXPIRY_OPTIONS = [...Array.from({ length: 24 }, (_, i) => [i + 1, `${i + 1} ${i ? "hours" : "hour"}`]),
    [48, "2 days"], [72, "3 days"], [168, "7 days"], [720, "30 days"]];
  const expirySelect = (id, selected = 1) =>
    `<select id="${id}" style="width:auto;min-width:130px">${EXPIRY_OPTIONS.map(([h, l]) => `<option value="${h}"${h === selected ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  const toLocalInput = iso => iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "";
  const folderList = () => [...new Set(S.docs.map(d => d.folder).filter(Boolean))].sort();
  const folderDatalist = () => `<datalist id="folderList">${folderList().map(f => `<option value="${esc(f)}">`).join("")}</datalist>`;
  // Extra document settings (folder, opens at, one view) for the upload and edit dialogs.
  function docOptionsHTML(d = {}) {
    if (!S.docsV3) return `<p class="hint">Run supabase/007_documents.sql to add folders, an opening time and one-time view.</p>`;
    return `
      <div class="form-grid">
        <div><label for="xFolder">Folder (optional)</label><input id="xFolder" type="text" maxlength="60" list="folderList" placeholder="e.g. Guides" value="${esc(d.folder || "")}">${folderDatalist()}</div>
        <div><label for="xFrom">Opens at (optional)</label><input id="xFrom" type="datetime-local" value="${toLocalInput(d.available_from)}"></div>
      </div>
      <label class="row" style="gap:8px;font-weight:400;margin-top:14px"><input type="checkbox" id="xOnce" style="width:auto;margin:0" ${d.one_time ? "checked" : ""}> One view only: each person can open it once</label>`;
  }
  function docOptionsValue() {
    if (!S.docsV3) return {};
    const from = $("#xFrom").value;
    return { folder: $("#xFolder").value.trim() || null, available_from: from ? new Date(from).toISOString() : null, one_time: $("#xOnce").checked };
  }
  function shareLink(id) {
    const u = new URL("./", location.href);
    u.searchParams.set("doc", id);
    return u.toString();
  }
  function parseEmails(text) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const all = String(text).split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    return { valid: [...new Set(all.filter(e => re.test(e)))], invalid: all.filter(e => !re.test(e)) };
  }

  // ---------------------------------------------------------------
  // Shell & routing
  // ---------------------------------------------------------------
  const NAV = [
    ["overview", "Overview", "overview"],
    ["documents", "Documents", "docs"],
    ["people", "People", "people"],
    ["activity", "Activity", "activity"],
    ["payments", "Payments", "wallet"],
    ["quizzes", "Quizzes", "quiz"],
    ["messages", "Messages", "chat"],
    ["security", "Security", "shield"],
    ["blocked", "Blocked", "block"]
  ];

  app.innerHTML = `
    <div class="shell">
      <aside class="side">
        ${brandHTML("Owner dashboard")}
        <nav class="nav" aria-label="Sections">
          ${NAV.map(([id, label, ic]) => `<a href="#${id}" data-nav="${id}">${icon(ic)}<span>${label}</span><span class="count" data-count="${id}"></span></a>`).join("")}
        </nav>
        <div class="side-foot"><span>${esc(user.email)}</span><button class="small" id="signout" type="button">Sign out</button></div>
      </aside>
      <section class="main" id="view" tabindex="-1"></section>
    </div>
    <dialog id="dlg"></dialog>
    <input type="file" id="replaceFile" accept="application/pdf" hidden>`;
  $("#signout").onclick = signOut;

  const view = $("#view");

  function route(silent) {
    const [name, arg, arg2] = decodeURIComponent(location.hash.slice(1) || "overview").split("/");
    const section = { doc: "documents", person: "people", group: "people", statement: "people", payment: "payments", quiz: "quizzes" }[name] || name;
    $$("[data-nav]").forEach(a => { if (a.dataset.nav === section) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    $('[data-count="documents"]').textContent = S.docs.length || "";
    const pendReq = S.requests.filter(r => r.status === "pending").length;
    $('[data-count="people"]').textContent = pendReq ? `${pendReq} new` : (D.people.size || "");
    $('[data-count="blocked"]').textContent = S.blocked.length || "";
    const pendingPays = S.payments.filter(p => p.status === "pending").length;
    $('[data-count="payments"]').textContent = pendingPays ? `${pendingPays} new` : "";
    const secCount = D.alerts.filter(a => a.level === "high").length + S.deviceRequests.filter(r => r.status === "pending").length;
    $('[data-count="security"]').textContent = secCount || "";
    const newFb = S.feedback.filter(f => f.status === "new").length;
    $('[data-count="messages"]').textContent = newFb ? `${newFb} new` : "";

    const pages = { overview, documents, doc: docDetail, people, person: personDetail, group: groupDetail, statement, messages, security, quizzes, quiz: quizDetail, activity, blocked, payments, payment: paymentDetail };
    (pages[name] || overview)(arg, arg2);
    if (!silent) { window.scrollTo(0, 0); }
  }

  function head(title, sub, actions = "", back = "") {
    if (S.role === "viewer") back = `<div class="ro-banner">${icon("lock")} You have view-only access. Ask the owner if you need to change something.</div>${back}`;
    return `${back}<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div><div class="row">${actions}</div></div>`;
  }
  const shareBtn = `<button class="primary" type="button" data-act="new">${icon("upload")}Share a document</button>`;
  function wireCommon() {
    $$('[data-act="new"]', view).forEach(b => b.onclick = openUpload);
    $$("tr[data-href]", view).forEach(tr => {
      tr.onclick = e => { if (!e.target.closest("button,a,input")) location.hash = tr.dataset.href; };
      tr.onkeydown = e => { if (e.key === "Enter") location.hash = tr.dataset.href; };
    });
  }
  const migrationNote = () => S.analyticsMissing
    ? `<div class="notice" style="margin-bottom:16px">Reading-time tracking isn't switched on yet. Run <code>supabase/003_analytics.sql</code> in the Supabase SQL Editor.</div>` : "";

  // ---------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------
  function overview() {
    const totalSec = sum(S.sessions, s => s.seconds);
    const weekAgo = Date.now() - 7 * 864e5;
    const weekSec = sum(S.sessions.filter(s => new Date(s.started_at) > weekAgo), s => s.seconds);
    const live = S.sessions.filter(isLive);
    const people = [...D.people.values()];
    const openedPeople = people.filter(p => p.opened.size).length;
    const active = S.docs.filter(d => docStatus(d).cls === "live").length;

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      days.push({ start: d.getTime(), label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), value: 0 });
    }
    S.sessions.forEach(s => {
      const t = new Date(s.started_at).getTime();
      for (let i = days.length - 1; i >= 0; i--) if (t >= days[i].start) { days[i].value += s.seconds / 60; break; }
    });

    const topDocs = S.docs.map(d => {
      const ss = D.sessByDoc.get(d.id) || [];
      const allowed = new Set(D.access.get(d.id).keys());
      return { d, secs: sum(ss, s => s.seconds), viewers: new Set(ss.map(s => s.email).filter(e => allowed.has(e))).size, last: ss[0]?.last_seen_at };
    }).sort((a, b) => b.secs - a.secs).slice(0, 5);

    view.innerHTML = `
      ${head("Overview", "How your shared documents are being read.",
        `${S.docs.some(d => d.document_access.length) ? `<button class="danger" type="button" data-act="revokeAll">Remove everyone's access</button>` : ""}${shareBtn}`)}
      ${migrationNote()}
      <div class="kpis">
        ${kpi("Documents sharing", active, `${S.docs.length} in total`)}
        ${kpi("People with access", people.filter(p => p.docs.size).length, `${openedPeople} have opened something`)}
        ${kpi("Reading time", fmtDuration(totalSec), `${fmtDuration(weekSec)} in the last 7 days`)}
        ${kpi("Reading now", live.length, live.length ? esc(live.map(s => s.email.split("@")[0]).slice(0, 2).join(", ")) : "Nobody right now")}
      </div>
      ${S.docs.length ? `<div class="panel" style="margin-bottom:16px">
        <div class="panel-head"><h2>All links</h2><span class="muted small-text">${linkSummary()}</span></div>
        <div class="panel-body row" style="justify-content:space-between;gap:16px">
          <div class="row"><label for="allExp" style="margin:0">Close all links after</label>${expirySelect("allExp", 1)}
            <button type="button" data-act="expireAll">Set for all documents</button></div>
          <button type="button" class="primary" data-act="openAll">Turn all links on</button>
        </div>
        <p class="hint" style="padding:0 18px 14px;margin:0">Turning all links on also removes every expiry time. People already removed from a document stay removed.</p>
      </div>` : ""}
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Reading time per day</h2><span class="muted small-text">Last 14 days, in minutes</span></div>
          <div class="panel-body"><div id="dailyChart"></div></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Recent activity</h2><a href="#activity" class="small-text">See all</a></div>
          ${feed(S.sessions.slice(0, 7))}
        </div>
      </div>
      <div class="panel section-gap">
        <div class="panel-head"><h2>Most-read documents</h2><a href="#documents" class="small-text">All documents</a></div>
        ${topDocs.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Document</th><th class="num">Opened by</th><th class="num">Reading time</th><th class="hide-sm">Last opened</th></tr></thead>
          <tbody>${topDocs.map(({ d, secs, viewers, last }) => `
            <tr class="clickable" tabindex="0" data-href="doc/${d.id}"><td><div class="cell-title">${esc(d.title)}</div></td>
            <td class="num">${viewers} of ${D.access.get(d.id).size}</td><td class="num">${fmtDuration(secs)}</td>
            <td class="hide-sm muted">${last ? esc(timeAgo(last)) : "Not opened yet"}</td></tr>`).join("")}</tbody></table></div>`
          : emptyState("No documents yet", "Share your first PDF to start tracking who reads it.")}
      </div>`;
    barChart($("#dailyChart"), days.map(d => ({ label: d.label, value: d.value, tip: `${d.label}: ${fmtDuration(d.value * 60)}` })), { fmt: v => v === 0 ? "0" : `${Math.round(v)}m` });
    const revokeBtn = $('[data-act="revokeAll"]', view);
    if (revokeBtn) revokeBtn.onclick = () => revokeAccess(S.docs);
    const expBtn = $('[data-act="expireAll"]', view);
    if (expBtn) expBtn.onclick = () => setExpiry(S.docs, Number($("#allExp").value));
    const openBtn = $('[data-act="openAll"]', view);
    if (openBtn) openBtn.onclick = () => openLinks(S.docs);
    wireCommon();
  }

  function kpi(label, value, note) {
    return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-note">${note}</div></div>`;
  }
  function emptyState(title, text) { return `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`; }
  function feed(list) {
    if (!list.length) return emptyState("No reading activity yet", "When someone opens a document in the app, it shows up here.");
    return `<ul class="feed">${list.map(s => `
      <li><span class="avatar">${esc(initials(s.email))}</span>
        <div><div class="what"><a href="#person/${encodeURIComponent(s.email)}">${esc(s.email)}</a> read <a href="#doc/${s.document_id}">${esc(docTitle(s.document_id))}</a> for ${fmtDuration(s.seconds)}</div>
        <div class="when">${isLive(s) ? `<span class="tag now">Reading now</span>` : esc(timeAgo(s.last_seen_at))}${s.device_label ? `, on ${esc(s.device_label)}` : ""}</div></div></li>`).join("")}</ul>`;
  }

  // ---------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------
  function documents() {
    view.innerHTML = `
      ${head("Documents", "Every PDF you've shared, with who has opened it.", shareBtn)}
      <div class="panel">
        <div class="panel-head"><div class="row" style="flex:1"><input type="search" id="q" placeholder="Search documents" style="max-width:320px" aria-label="Search documents">
          ${folderList().length ? `<select id="fFolder" style="width:auto" aria-label="Folder"><option value="">All folders</option>${folderList().map(f => `<option>${esc(f)}</option>`).join("")}<option value="__none">No folder</option></select>` : ""}</div></div>
        <div id="docTable"></div>
      </div>`;
    const draw = () => {
      const q = $("#q").value.trim().toLowerCase();
      const ff = $("#fFolder")?.value || "";
      const list = S.docs.filter(d => d.title.toLowerCase().includes(q) && (!ff || (ff === "__none" ? !d.folder : d.folder === ff)));
      $("#docTable").innerHTML = list.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Document</th><th>Status</th><th class="num">Opened by</th><th class="num">Reading time</th><th class="hide-sm">Last opened</th></tr></thead>
        <tbody>${list.map(d => {
          const ss = D.sessByDoc.get(d.id) || [];
          const st = docStatus(d);
          const live = ss.some(isLive);
          return `<tr class="clickable" tabindex="0" data-href="doc/${d.id}">
            <td><div class="cell-title">${esc(d.title)}</div><div class="cell-sub">${d.folder ? `${esc(d.folder)} · ` : ""}Shared ${esc(timeAgo(d.created_at))}${d.expires_at ? `, expires ${esc(fmtDate(d.expires_at))}` : ""}${d.one_time ? " · One view only" : ""}</div></td>
            <td>${live ? `<span class="tag now">Being read</span>` : `<span class="tag ${st.cls}">${st.text}</span>`}</td>
            <td class="num">${new Set(ss.map(s => s.email).filter(e => D.access.get(d.id).has(e))).size} of ${D.access.get(d.id).size}</td>
            <td class="num">${fmtDuration(sum(ss, s => s.seconds))}</td>
            <td class="hide-sm muted">${ss[0] ? esc(timeAgo(ss[0].last_seen_at)) : "Not opened yet"}</td></tr>`;
        }).join("")}</tbody></table></div>`
        : S.docs.length ? emptyState("No matches", "Try a different search.") : emptyState("No documents yet", "Share a PDF to get a private link for the people you choose.");
      wireCommon();
    };
    $("#q").oninput = draw;
    if ($("#fFolder")) $("#fFolder").onchange = draw;
    draw();
    wireCommon();
  }

  function docDetail(id) {
    const d = D.doc.get(id);
    if (!d) { view.innerHTML = head("Document not found", "It may have been deleted.", "", backLink("#documents", "Documents")); return; }
    const ss = D.sessByDoc.get(d.id) || [];
    const st = docStatus(d);
    const acc = D.access.get(d.id);
    const allowed = [...acc.keys()].sort();
    const direct = d.document_access.map(a => a.email);
    const docGroups = S.groups.filter(g => g.group_documents.some(x => x.document_id === d.id));
    const otherGroups = S.groups.filter(g => !docGroups.includes(g));
    const readers = new Set(ss.map(s => s.email));
    const totalSec = sum(ss, s => s.seconds);
    const pageCount = Math.max(0, ...ss.map(s => s.page_count || 0));

    // per page totals
    const pageSec = Array.from({ length: pageCount }, () => 0);
    ss.forEach(s => Object.entries(s.page_seconds || {}).forEach(([p, v]) => { if (pageSec[p - 1] !== undefined) pageSec[p - 1] += v; }));

    // people rows: allowed + anyone who read (e.g. later removed)
    const emails = [...new Set([...allowed, ...readers])];
    const rows = emails.map(email => {
      const mine = ss.filter(s => s.email === email);
      return {
        email, mine, allowed: allowed.includes(email), direct: direct.includes(email), via: acc.get(email)?.groups || [], secs: sum(mine, s => s.seconds),
        furthest: Math.max(0, ...mine.map(s => s.max_page || 0)), last: mine[0]?.last_seen_at, live: mine.some(isLive)
      };
    }).sort((a, b) => (b.live - a.live) || (b.secs - a.secs) || a.email.localeCompare(b.email));
    // Allowed people who haven't opened it or haven't reached the last page.
    const behind = rows.filter(r => r.allowed && !D.blocked.has(r.email) && (!r.mine.length || (pageCount && r.furthest < pageCount)));
    const viewsOf = email => S.docViews.find(v => v.document_id === d.id && v.email === email);

    view.innerHTML = `
      ${head(d.title, `<span class="tag ${st.cls}">${st.text}</span>&nbsp; ${d.folder ? `${esc(d.folder)} · ` : ""}Shared ${esc(fmtDate(d.created_at))}${d.available_from ? `, opens ${esc(fmtDate(d.available_from))}` : ""}${d.expires_at ? `, closes ${esc(fmtDate(d.expires_at))}` : ", no expiry"}${d.one_time ? " · One view only" : ""}`,
        `<button type="button" data-act="edit">Edit</button>
         <button type="button" data-act="replace">Replace PDF</button>
         <button type="button" data-act="toggle">${d.is_active ? "Turn link off" : "Turn link on"}</button>
         <button type="button" class="danger" data-act="delete">Delete</button>`,
        backLink("#documents", "Documents"))}
      <div class="panel" style="margin-bottom:16px"><div class="panel-body">
        <label for="link" style="margin-top:0">Share link</label>
        <div class="linkbox"><input id="link" type="text" readonly value="${esc(shareLink(d.id))}">
          <button type="button" data-act="copy">Copy</button>
          <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`${d.title}\n${shareLink(d.id)}\n\nOpen it on your Android phone and sign in with Google using the email ID you shared with me.`)}">WhatsApp</a></div>
        <p class="hint">Only the people listed below can open it, and only in the Android app.</p>
        <div class="row" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--rule)">
          <label for="docExp" style="margin:0">Close this link after</label>${expirySelect("docExp", 1)}
          <button type="button" data-act="expireDoc">Set</button>
          ${d.expires_at ? `<button type="button" data-act="clearExp">Remove expiry</button>` : ""}
          <span class="spacer"></span>
          <span class="muted small-text">${d.expires_at
            ? (new Date(d.expires_at) < new Date() ? `Closed ${esc(fmtDate(d.expires_at))}` : `Closes ${esc(fmtDate(d.expires_at))} (in ${timeLeft(d.expires_at)})`)
            : "No expiry set"}</span>
        </div>
      </div></div>
      <div class="kpis">
        ${kpi("Opened by", `${[...readers].filter(e => allowed.includes(e)).length} of ${allowed.length}`, `${allowed.length - [...readers].filter(e => allowed.includes(e)).length} haven't opened it yet`)}
        ${kpi("Reading time", fmtDuration(totalSec), `${ss.length} ${ss.length === 1 ? "session" : "sessions"}`)}
        ${kpi("Average per reader", fmtDuration(readers.size ? totalSec / readers.size : 0), pageCount ? `${pageCount} pages` : "Page count after first open")}
        ${kpi("Read to the end", `${rows.filter(r => pageCount && r.furthest >= pageCount).length}`, pageCount ? `reached page ${pageCount}` : "Not opened yet")}
      </div>
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>People</h2><div class="row"><span class="muted small-text">${allowed.length} allowed</span>
            ${behind.length ? `<button class="small" type="button" data-act="remind">Remind ${behind.length}</button>` : ""}
            ${direct.length ? `<button class="small danger" type="button" data-act="revokeDoc">Remove everyone</button>` : ""}</div></div>
          ${rows.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>Email</th><th>Status</th><th class="num">Time</th><th class="num hide-sm">Furthest page</th><th></th></tr></thead>
            <tbody>${rows.map(r => `<tr>
              <td><a href="#person/${encodeURIComponent(r.email)}" class="cell-title">${esc(r.email)}</a>
                <div class="cell-sub">${r.last ? `Last opened ${esc(timeAgo(r.last))}` : "Not opened yet"}${r.via.length && !r.direct ? `, via ${esc(r.via.join(", "))}` : ""}</div></td>
              <td>${personTag(r.email, r)}${d.one_time && r.allowed ? (() => { const v = viewsOf(r.email); const used = v?.used || 0, allowedN = v?.allowed ?? 1;
                return `<div class="cell-sub">${used} of ${allowedN} ${allowedN === 1 ? "view" : "views"} used${used >= allowedN ? ` <button class="small ghost" type="button" data-moreview="${esc(r.email)}">Give another view</button>` : ""}</div>`; })() : ""}</td>
              <td class="num">${r.secs ? fmtDuration(r.secs) : "–"}</td>
              <td class="num hide-sm">${r.furthest ? `${r.furthest} of ${pageCount}` : "–"}</td>
              <td class="num">${r.direct ? `<button class="small ghost" data-remove="${esc(r.email)}" type="button">Remove</button>` : r.via.length ? `<span class="muted small-text">Group</span>` : ""}</td></tr>`).join("")}
            </tbody></table></div>` : emptyState("No one has access", "Add email IDs below.")}
          <div class="panel-body" style="border-top:1px solid var(--rule)">
            <label for="addEmails" style="margin-top:0">Add people</label>
            <textarea id="addEmails" rows="3" style="min-height:72px" placeholder="Paste email IDs, separated by commas or new lines"></textarea>
            <div class="row" style="margin-top:10px"><button class="primary small" type="button" data-act="add">Add to this document</button><span id="addMsg" class="msg" style="margin:0"></span></div>
          </div>
        </div>
        <div>
        <div class="panel">
          <div class="panel-head"><h2>Groups</h2><span class="muted small-text">Every member can open this</span></div>
          ${docGroups.length ? `<ul class="rank">${docGroups.map(g => `<li><a href="#group/${g.id}">${esc(g.name)} <span class="muted small-text">${g.group_members.length} members</span></a>
            <button class="small ghost" type="button" data-ungroup="${g.id}">Remove</button></li>`).join("")}</ul>`
            : `<div class="panel-body"><p class="muted small-text" style="margin:0">${S.peopleV2 ? (S.groups.length ? "Not shared with any group." : `No groups yet. <a href="#people/groups">Create one</a> to share with a whole batch at once.`) : "Run supabase/006_people.sql to use groups."}</p></div>`}
          ${otherGroups.length ? `<div class="panel-body row" style="border-top:1px solid var(--rule)">
            <select id="dGroup" style="flex:1;min-width:160px" aria-label="Group">${otherGroups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select>
            <button class="small primary" type="button" data-act="addGroup">Share with group</button></div>` : ""}
        </div>
        <div class="panel section-gap">
          <div class="panel-head"><h2>Time on each page</h2><span class="muted small-text">All readers combined</span></div>
          <div class="panel-body">${pageCount ? `<div id="pageChart"></div>
            <details class="table-view"><summary>Show as a table</summary><div class="table-wrap"><table class="data"><thead><tr><th>Page</th><th class="num">Time</th></tr></thead>
            <tbody>${pageSec.map((v, i) => `<tr><td>Page ${i + 1}</td><td class="num">${fmtDuration(v)}</td></tr>`).join("")}</tbody></table></div></details>`
            : `<p class="muted small-text">Appears after someone opens the document in the app.</p>`}</div>
        </div>
        </div>
      </div>
      <div class="panel section-gap">
        <div class="panel-head"><h2>Sessions</h2><span class="muted small-text">Each time someone opened this document</span></div>
        ${sessionTable(ss.slice(0, 100), { showDoc: false })}
      </div>`;

    if (pageCount) {
      barChart($("#pageChart"), pageSec.map((v, i) => ({ label: String(i + 1), value: v / 60, tip: `Page ${i + 1}: ${fmtDuration(v)}` })), { fmt: v => v === 0 ? "0" : `${v < 10 ? v.toFixed(1) : Math.round(v)}m`, height: 200 });
    }

    const act = name => $(`[data-act="${name}"]`, view);
    act("copy").onclick = async () => { try { await navigator.clipboard.writeText(shareLink(d.id)); toast("Link copied"); } catch { $("#link").select(); } };
    act("edit").onclick = () => openEdit(d);
    act("replace").onclick = () => replacePdf(d);
    act("expireDoc").onclick = () => setExpiry([d], Number($("#docExp").value));
    if (act("clearExp")) act("clearExp").onclick = async () => {
      const { error } = await sb.from("documents").update({ expires_at: null }).eq("id", d.id);
      if (error) return toast(error.message);
      toast(d.is_active ? "Expiry removed. The link stays open." : "Expiry removed. Turn the link on to share again.");
      await refresh();
    };
    act("toggle").onclick = async () => {
      const { error } = await sb.from("documents").update({ is_active: !d.is_active }).eq("id", d.id);
      if (error) return toast(error.message);
      toast(d.is_active ? "Link turned off. Nobody can open it now." : "Link turned on");
      await refresh();
    };
    if (act("revokeDoc")) act("revokeDoc").onclick = () => revokeAccess([d]);
    act("delete").onclick = () => confirmDialog({
      title: `Delete "${d.title}"?`,
      text: "The PDF, its access list and its reading history are removed for good. The share link stops working.",
      confirm: "Delete document", danger: true,
      run: async () => {
        await sb.storage.from("documents").remove([d.storage_path]);
        const { error } = await sb.from("documents").delete().eq("id", d.id);
        if (error) throw error;
        toast("Document deleted");
        location.hash = "documents";
        await refresh();
      }
    });
    act("add").onclick = async () => {
      const msg = $("#addMsg");
      const { valid, invalid } = parseEmails($("#addEmails").value);
      if (invalid.length) { msg.className = "msg err"; msg.textContent = `Check these: ${invalid.join(", ")}`; return; }
      const fresh = valid.filter(e => !direct.includes(e));
      if (!fresh.length) { msg.className = "msg err"; msg.textContent = "Those email IDs already have access."; return; }
      const { error } = await sb.from("document_access").insert(fresh.map(email => ({ document_id: d.id, email })));
      if (error) { msg.className = "msg err"; msg.textContent = error.message; return; }
      toast(`Added ${fresh.length} ${fresh.length === 1 ? "person" : "people"}`);
      await refresh();
    };
    if (act("remind")) act("remind").onclick = () => remindDialog(d, behind, pageCount);
    $$("[data-moreview]", view).forEach(b => b.onclick = async () => {
      const email = b.dataset.moreview, v = viewsOf(email);
      const { error } = await sb.from("document_views").upsert({ document_id: d.id, email, used: v?.used || 0, allowed: (v?.used || 0) + 1 });
      if (error) return toast(error.message);
      toast(`${email} can open it once more`); await refresh();
    });
    if (act("addGroup")) act("addGroup").onclick = async () => {
      const { error } = await sb.from("group_documents").insert({ group_id: $("#dGroup").value, document_id: d.id });
      if (error) return toast(error.message);
      toast("Shared with the group"); await refresh();
    };
    $$("[data-ungroup]", view).forEach(b => b.onclick = async () => {
      const { error } = await sb.from("group_documents").delete().eq("group_id", b.dataset.ungroup).eq("document_id", d.id);
      if (error) return toast(error.message);
      toast("Group removed from this document"); await refresh();
    });
    $$("[data-remove]", view).forEach(b => b.onclick = async () => {
      const email = b.dataset.remove;
      const { error } = await sb.from("document_access").delete().eq("document_id", d.id).eq("email", email);
      if (error) return toast(error.message);
      toast(`Removed ${email}`);
      await refresh();
    });
    wireCommon();
  }

  function personTag(email, r) {
    if (D.blocked.has(email)) return `<span class="tag off">Blocked</span>`;
    if (r.live) return `<span class="tag now">Reading now</span>`;
    if (!r.allowed) return `<span class="tag plain">Removed</span>`;
    if (r.secs || r.mine.length) return `<span class="tag live">Opened</span>`;
    return `<span class="tag warn">Not opened</span>`;
  }
  function backLink(href, text) { return `<a class="back" href="${href}">${icon("back")} ${esc(text)}</a>`; }

  function sessionTable(list, { showDoc = true, showEmail = true } = {}) {
    if (!list.length) return emptyState("No sessions yet", "Sessions appear when someone opens a document in the app.");
    return `<div class="table-wrap"><table class="data">
      <thead><tr><th>Started</th>${showEmail ? "<th>Person</th>" : ""}${showDoc ? "<th>Document</th>" : ""}<th class="num">Time</th><th class="num hide-sm">Pages reached</th><th class="hide-sm">Device</th></tr></thead>
      <tbody>${list.map(s => `<tr>
        <td>${esc(fmtDate(s.started_at))}${isLive(s) ? ` <span class="tag now">Now</span>` : ""}</td>
        ${showEmail ? `<td><a href="#person/${encodeURIComponent(s.email)}">${esc(s.email)}</a></td>` : ""}
        ${showDoc ? `<td><a href="#doc/${s.document_id}">${esc(docTitle(s.document_id))}</a></td>` : ""}
        <td class="num">${fmtDuration(s.seconds)}</td>
        <td class="num hide-sm">${s.max_page} of ${s.page_count || "?"}</td>
        <td class="hide-sm muted">${esc(s.device_label || "Unknown")}</td></tr>`).join("")}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------
  // People: list, groups, referral tree, access requests, profiles
  // ---------------------------------------------------------------
  const PEOPLE_TABS = [["", "People"], ["groups", "Groups"], ["tree", "Referral tree"], ["requests", "Access requests"]];
  const peopleTabs = active => {
    const pend = S.requests.filter(r => r.status === "pending").length;
    return `<nav class="tabs" aria-label="People">${PEOPLE_TABS.map(([k, l]) =>
      `<a href="#people${k ? "/" + k : ""}" ${k === active ? 'aria-current="page"' : ""}>${l}${k === "requests" && pend ? ` (${pend})` : ""}</a>`).join("")}</nav>`;
  };
  const r2Note = () => S.peopleV2 ? "" : `<div class="notice" style="margin-bottom:16px">Run <code>supabase/006_people.sql</code> in Supabase to switch on profiles, tags, notes, groups and access requests.</div>`;
  const tagChips = tags => (tags || []).map(t => `<span class="tag plain">${esc(t)}</span>`).join(" ");

  function people(tab = "") {
    const pages = { "": peopleList, groups: groupsPage, tree: treePage, requests: requestsPage };
    (pages[tab] || peopleList)();
  }

  // Candidates whose app profile (name, phone, Outlier ID) isn't saved yet. Admins and blocked people don't count.
  const adminEmails = () => new Set([user.email, ...S.admins.map(a => a.email)]);
  const noProfile = () => S.profilesV1 ? [...D.people.keys()].filter(e => !adminEmails().has(e) && !D.blocked.has(e) && !S.profiles.some(p => p.email === e)).sort() : [];

  function peopleList() {
    const allTags = [...new Set(S.peopleRows.flatMap(p => p.tags || []))].sort();
    const missing = noProfile();
    const total = [...D.people.keys()].filter(e => !adminEmails().has(e) && !D.blocked.has(e)).length;
    view.innerHTML = `
      ${head("People", "Everyone you've shared with, paid by, or who asked for access.")}
      ${peopleTabs("")}${r2Note()}
      ${S.profilesV1 ? `<div class="panel" style="margin-bottom:16px"><div class="panel-body row" style="justify-content:space-between">
        <div><strong>${missing.length ? `${missing.length} of ${total} haven't completed their profile` : "Everyone has completed their profile"}</strong>
          <p class="hint" style="margin:4px 0 0">Profile = name, phone and Outlier ID saved under My account in the app. ${total - missing.length} done.</p></div>
        ${missing.length ? `<div class="row"><button type="button" data-act="showMissing">Show them</button><button type="button" class="primary" data-act="remindProfile">Remind them</button></div>` : ""}
      </div></div>` : ""}
      <div class="panel">
        <div class="panel-head"><div class="row" style="flex:1">
          <input type="search" id="q" placeholder="Search name, email, phone or Outlier ID" style="max-width:300px" aria-label="Search people">
          <select id="fTag" style="width:auto" aria-label="Filter by tag"><option value="">All tags</option>${allTags.map(t => `<option>${esc(t)}</option>`).join("")}</select>
          <select id="fGroup" style="width:auto" aria-label="Filter by group"><option value="">All groups</option>${S.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select>
          <label class="row small-text" style="margin:0;gap:6px;font-weight:400"><input type="checkbox" id="onlyUnopened"> Haven't opened anything</label>
          ${S.profilesV1 ? `<label class="row small-text" style="margin:0;gap:6px;font-weight:400"><input type="checkbox" id="onlyNoProfile"> Profile not filled</label>` : ""}
        </div><span class="muted small-text" id="pplCount"></span></div>
        <div id="peopleTable"></div>
      </div>`;
    const draw = () => {
      const q = $("#q").value.trim().toLowerCase(), tag = $("#fTag").value, grp = $("#fGroup").value, onlyUn = $("#onlyUnopened").checked;
      const onlyNp = $("#onlyNoProfile")?.checked, miss = new Set(missing);
      const list = [...D.people.keys()].map(email => personSummary(email))
        .filter(r => (!q || [r.email, r.name, r.outlierId, r.phone].some(v => String(v || "").toLowerCase().includes(q)))
          && (!tag || r.tags.includes(tag)) && (!grp || r.groups.some(g => g.id === grp)) && (!onlyUn || !r.sessions.length) && (!onlyNp || miss.has(r.email)))
        .sort((a, b) => (b.live - a.live) || ((b.lastActive ? new Date(b.lastActive) : 0) - (a.lastActive ? new Date(a.lastActive) : 0)) || a.email.localeCompare(b.email));
      $("#pplCount").textContent = `${list.length} ${list.length === 1 ? "person" : "people"}`;
      $("#peopleTable").innerHTML = list.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Person</th><th>Status</th><th class="num">Docs opened</th><th class="num">Reading</th><th class="num hide-sm">Paid</th><th class="hide-sm">Last active</th></tr></thead>
        <tbody>${list.map(r => `<tr class="clickable" tabindex="0" data-href="person/${encodeURIComponent(r.email)}">
          <td><div class="row" style="gap:10px;flex-wrap:nowrap"><span class="avatar">${esc(initials(r.name || r.email))}</span>
            <div><div class="cell-title">${esc(r.name || r.email)}</div>${r.name ? `<div class="cell-sub">${esc(r.email)}</div>` : ""}
            ${r.tags.length || r.groups.length || miss.has(r.email) ? `<div class="flags">${miss.has(r.email) ? `<span class="tag warn">Profile not filled</span> ` : ""}${tagChips(r.tags)} ${r.groups.map(g => `<span class="tag live">${esc(g.name)}</span>`).join(" ")}</div>` : ""}</div></div></td>
          <td>${D.blocked.has(r.email) ? `<span class="tag off">Blocked</span>` : r.live ? `<span class="tag now">Reading now</span>` : r.sessions.length ? `<span class="tag live">Active</span>` : r.docs.size ? `<span class="tag warn">Not opened</span>` : `<span class="tag plain">No documents</span>`}</td>
          <td class="num">${r.opened.size} of ${r.docs.size}</td>
          <td class="num">${r.secs ? fmtDuration(r.secs) : "–"}</td>
          <td class="num hide-sm">${r.paid ? inr(r.paid) : "–"}</td>
          <td class="hide-sm muted">${r.lastActive ? esc(timeAgo(r.lastActive)) : "Never"}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState(D.people.size ? "No matches" : "No people yet", D.people.size ? "Try a different search or filter." : "People appear here once you share a document with them.");
      wireCommon();
    };
    ["fTag", "fGroup", "onlyUnopened", "onlyNoProfile"].forEach(id => { const el = $(`#${id}`); if (el) el.onchange = draw; });
    $("#q").oninput = draw;
    const sm = $('[data-act="showMissing"]');
    if (sm) sm.onclick = () => { $("#onlyNoProfile").checked = true; draw(); $("#peopleTable").scrollIntoView({ behavior: "smooth", block: "start" }); };
    const rp = $('[data-act="remindProfile"]');
    if (rp) rp.onclick = () => profileReminder(missing);
    draw();
  }

  function profileReminder(emails) {
    const text = `Hi, please complete your profile in the Pro AI Trainers app: open the app, tap My account, and fill in your name, phone number, Outlier ID and who invited you. It takes a minute, and your payment form will fill itself in after that.\n\nApp link: ${location.origin}${location.pathname.replace(/admin\.html$/, "")}`;
    openDialog(`
      <div class="dlg-head"><h2>Remind ${emails.length} ${emails.length === 1 ? "person" : "people"}</h2><p class="sub" style="margin:6px 0 0">Copy the message, or open your email with everyone in BCC. Nothing is sent until you send it.</p></div>
      <div class="dlg-body">
        <label style="margin-top:4px">Profile not filled</label>
        <ul class="plain-list">${emails.map(e => `<li>${esc(nameOf(e))}${nameOf(e) !== e ? ` <span class="muted small-text">${esc(e)}</span>` : ""}</li>`).join("")}</ul>
        <label for="pfText">Message</label><textarea id="pfText" rows="6">${esc(text)}</textarea>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Close</button>
        <button type="button" data-pf="csv">Download list</button>
        <button type="button" data-pf="mail">Email them</button>
        <button type="button" data-pf="wa">WhatsApp</button>
        <button class="primary" type="button" data-pf="copy">Copy message</button></div>`, async () => {});
    const msg = () => $("#pfText").value;
    $('[data-pf="copy"]', dlg).onclick = async () => { try { await navigator.clipboard.writeText(msg()); toast("Message copied"); } catch { $("#pfText").select(); } };
    $('[data-pf="wa"]', dlg).onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(msg())}`, "_blank", "noopener");
    $('[data-pf="mail"]', dlg).onclick = () => { location.href = `mailto:?bcc=${encodeURIComponent(emails.join(","))}&subject=${encodeURIComponent("Please complete your Pro AI Trainers profile")}&body=${encodeURIComponent(msg())}`; };
    $('[data-pf="csv"]', dlg).onclick = () => downloadCsv([["Name", "Email"], ...emails.map(e => [nameOf(e) === e ? "" : nameOf(e), e])], "profile-not-filled.csv");
  }

  // Everything known about one person, from every table.
  function personSummary(email) {
    const p = D.people.get(email) || { docs: new Set(), opened: new Set() };
    const row = S.peopleRows.find(x => x.email === email) || null;
    const pays = S.payments.filter(x => x.email === email);
    const sessions = D.sessByEmail.get(email) || [];
    const prof = S.profiles.find(x => x.email === email) || null;
    const name = row?.display_name || prof?.full_name || pays[0]?.name || S.requests.find(x => x.email === email)?.name || "";
    const lastActive = [sessions[0]?.last_seen_at, pays[0]?.created_at].filter(Boolean).sort().pop();
    return {
      email, row, name, tags: row?.tags || [], notes: row?.notes || "", outlierId: prof?.outlier_id || pays[0]?.outlier_id || "",
      phone: prof?.phone || "", profile: prof,
      referrer: referrerOf(email), referredText: prof?.referred_by || pays.find(x => x.referred_by)?.referred_by || "",
      groups: S.groups.filter(g => g.group_members.some(m => m.email === email)),
      docs: p.docs, opened: p.opened, sessions, secs: sum(sessions, s => s.seconds), live: sessions.some(isLive),
      pays, paid: sum(pays.filter(x => x.status !== "rejected"), x => Number(x.amount_sent)),
      earned: sum(pays.filter(x => x.status !== "rejected"), x => Number(x.amount_earned)), lastActive
    };
  }

  // Referrer: set by you on the profile, otherwise matched from the "referred by" the person typed.
  function referrerOf(email) {
    const row = S.peopleRows.find(x => x.email === email);
    if (row?.referred_by_email) return row.referred_by_email;
    const text = (S.profiles.find(x => x.email === email)?.referred_by || S.payments.find(x => x.email === email && x.referred_by)?.referred_by || "").trim().toLowerCase();
    if (!text) return null;
    if (text.includes("@")) return D.people.has(text) && text !== email ? text : null;
    for (const e of D.people.keys()) {
      if (e === email) continue;
      const n = (S.peopleRows.find(x => x.email === e)?.display_name || S.payments.find(x => x.email === e)?.name || "").trim().toLowerCase();
      if (n && n === text) return e;
    }
    return null;
  }
  const nameOf = email => S.peopleRows.find(x => x.email === email)?.display_name || S.profiles.find(x => x.email === email)?.full_name || S.payments.find(x => x.email === email)?.name || email;

  function personDetail(emailArg) {
    const email = decodeURIComponent(emailArg || "");
    const r = personSummary(email);
    const blocked = D.blocked.has(email);
    const devices = groupBy(r.sessions.filter(s => s.device_id), s => s.device_id);
    const docIds = [...new Set([...r.docs, ...r.opened])];
    const directDocs = new Set(S.docs.filter(d => d.document_access.some(a => a.email === email)).map(d => d.id));
    const team = descendants(email);
    const others = [...D.people.keys()].filter(e => e !== email).sort();

    view.innerHTML = `
      ${head(r.name || email, `${blocked ? `<span class="tag off">Blocked</span>&nbsp; ` : ""}${esc(email)}${r.phone ? `, ${esc(r.phone)}` : ""}${r.outlierId ? `, Outlier ID ${esc(r.outlierId)}` : ""}${r.profile ? "" : S.profiles.length || S.profilesV1 ? ` <span class="tag warn">Profile not filled</span>` : ""}`,
        `${blocked ? `<button type="button" data-act="unblock">Unblock</button>` : `<button type="button" class="danger" data-act="block">Block</button>`}
         ${r.pays.length ? `<a class="btn" href="#statement/${encodeURIComponent(email)}">Monthly statement</a>` : ""}
         ${directDocs.size ? `<button type="button" data-act="removeAll">Remove from all documents</button>` : ""}`,
        backLink("#people", "People"))}
      <div class="kpis">
        ${kpi("Reading time", fmtDuration(r.secs), `${r.sessions.length} ${r.sessions.length === 1 ? "session" : "sessions"}, ${r.opened.size} of ${r.docs.size} documents`)}
        ${kpi("Paid", inr(r.paid), r.earned ? `of ${inr(r.earned)} earned (${pctTxt(r.earned ? (r.paid / r.earned) * 100 : null)})` : "No payments yet")}
        ${kpi("Team", team.length, team.length ? `${inr(sum(team, e => personSummary(e).earned))} team earnings` : "Hasn't referred anyone")}
        ${kpi("Last active", r.lastActive ? esc(timeAgo(r.lastActive)) : "Never", devices.size > 1 ? `${devices.size} phones used` : devices.size ? "One phone" : "No app use yet")}
      </div>
      <div class="grid-2">
        <div>
          <div class="panel">
            <div class="panel-head"><h2>Profile</h2><span class="muted small-text">Only admins see this</span></div>
            <div class="panel-body">
              <div class="form-grid">
                <div><label for="prName" style="margin-top:0">Name</label><input id="prName" type="text" maxlength="120" value="${esc(r.row?.display_name || r.name)}"></div>
                <div><label for="prRef" style="margin-top:0">Referred by</label>
                  <select id="prRef"><option value="">Nobody / not known</option>${others.map(e => `<option value="${esc(e)}" ${r.referrer === e ? "selected" : ""}>${esc(nameOf(e))}${nameOf(e) !== e ? ` (${esc(e)})` : ""}</option>`).join("")}</select>
                  ${r.referredText ? `<p class="hint">They wrote: "${esc(r.referredText)}"${r.row?.referred_by_email ? "" : r.referrer ? " (matched automatically)" : " (no match yet, pick the right person)"}</p>` : ""}</div>
              </div>
              <label for="prTags">Tags</label>
              <input id="prTags" type="text" maxlength="300" placeholder="e.g. active, needs follow-up, top performer" value="${esc(r.tags.join(", "))}">
              <p class="hint">Separate with commas.${S.peopleRows.flatMap(x => x.tags || []).length ? ` Used so far: ${esc([...new Set(S.peopleRows.flatMap(x => x.tags || []))].slice(0, 12).join(", "))}` : ""}</p>
              <label for="prNotes">Notes</label>
              <textarea id="prNotes" rows="4" maxlength="5000" placeholder="Anything you want to remember about this person">${esc(r.notes)}</textarea>
              <div class="row" style="margin-top:12px"><button class="primary small" type="button" data-act="saveProfile" ${S.peopleV2 ? "" : "disabled"}>Save profile</button></div>
            </div>
          </div>
          <div class="panel section-gap">
            <div class="panel-head"><h2>Groups</h2></div>
            <div class="panel-body">${S.groups.length ? `<div class="check-list">${S.groups.map(g => `<label class="row" style="margin:0;gap:8px;font-weight:400">
              <input type="checkbox" data-group="${g.id}" ${r.groups.some(x => x.id === g.id) ? "checked" : ""}> ${esc(g.name)}
              <span class="muted small-text">${g.group_documents.length} ${g.group_documents.length === 1 ? "document" : "documents"}</span></label>`).join("")}</div>`
              : `<p class="muted small-text">No groups yet. <a href="#people/groups">Create one</a>.</p>`}</div>
          </div>
        </div>
        <div>
          <div class="panel">
            <div class="panel-head"><h2>Documents</h2></div>
            ${docIds.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Document</th><th class="num">Time</th><th class="num hide-sm">Furthest</th></tr></thead>
            <tbody>${docIds.map(id => {
              const mine = r.sessions.filter(s => s.document_id === id);
              const pc = Math.max(0, ...mine.map(s => s.page_count || 0));
              const via = directDocs.has(id) ? "" : r.docs.has(id) ? `via ${S.groups.filter(g => g.group_documents.some(x => x.document_id === id) && r.groups.some(y => y.id === g.id)).map(g => g.name).join(", ")}` : "Access removed";
              return `<tr class="clickable" tabindex="0" data-href="doc/${id}"><td><div class="cell-title">${esc(docTitle(id))}</div>${via ? `<div class="cell-sub">${esc(via)}</div>` : ""}</td>
                <td class="num">${mine.length ? fmtDuration(sum(mine, s => s.seconds)) : "–"}</td>
                <td class="num hide-sm">${mine.length ? `${Math.max(...mine.map(s => s.max_page))} of ${pc}` : "–"}</td></tr>`;
            }).join("")}</tbody></table></div>` : emptyState("No documents", "Nothing is shared with this email.")}
          </div>
          <div class="panel section-gap">
            <div class="panel-head"><h2>Payments</h2>${r.pays.length ? `<a class="small-text" href="#payments">All payments</a>` : ""}</div>
            ${r.pays.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Payout</th><th class="num">Earned</th><th class="num">Paid</th><th>Status</th></tr></thead>
              <tbody>${r.pays.slice(0, 20).map(p => `<tr class="clickable" tabindex="0" data-href="payment/${p.id}">
                <td class="muted">${esc(payDay(p).toLocaleDateString(undefined, { day: "numeric", month: "short" }))}</td>
                <td class="num">${inr(p.amount_earned)}</td><td class="num">${inr(p.amount_sent)}</td><td>${payTag(p.status)}</td></tr>`).join("")}</tbody></table></div>`
              : emptyState("No payments", "Submissions from this person appear here.")}
          </div>
          ${S.securityV1 ? (() => { const l = S.deviceLocks.find(x => x.email === email), rq = S.deviceRequests.find(x => x.email === email && x.status === "pending");
            return `<div class="panel section-gap"><div class="panel-head"><h2>Phone lock</h2>${S.deviceLock ? "" : `<span class="muted small-text">Lock is off</span>`}</div>
              <div class="panel-body small-text">${l ? `Locked to <strong>${esc(l.device_label || "Android phone")}</strong> since ${esc(fmtDate(l.locked_at))}.` : "No phone locked yet."}
              ${rq ? `<p style="margin:8px 0 0"><span class="tag warn">Waiting</span> Wants to switch to ${esc(rq.device_label || "a new phone")}. <a href="#security/phones">Review</a></p>` : ""}
              ${l ? `<div class="row" style="margin-top:10px"><button class="small" type="button" data-act="resetPhone">Reset phone lock</button></div>` : ""}</div></div>`; })() : ""}
          <div class="panel section-gap">
            <div class="panel-head"><h2>Devices</h2></div>
            ${devices.size ? `<ul class="feed">${[...devices.values()].map(list => `
              <li><span class="avatar">${icon("phone")}</span><div><div class="what">${esc(list[0].device_label || "Android phone")}</div>
              <div class="when">${list.length} ${list.length === 1 ? "session" : "sessions"}, last used ${esc(timeAgo(list[0].last_seen_at))}</div></div></li>`).join("")}</ul>`
              : emptyState("No devices yet", "Shows once this person opens a document.")}
          </div>
          ${team.length ? `<div class="panel section-gap"><div class="panel-head"><h2>Their team</h2><a class="small-text" href="#people/tree">Referral tree</a></div>
            <ul class="rank">${team.slice(0, 30).map(e => `<li><a href="#person/${encodeURIComponent(e)}">${esc(nameOf(e))}</a><span class="v">${inr(personSummary(e).earned)}</span></li>`).join("")}</ul></div>` : ""}
        </div>
      </div>
      <div class="panel section-gap"><div class="panel-head"><h2>Reading sessions</h2></div>${sessionTable(r.sessions.slice(0, 50), { showEmail: false })}</div>`;

    const act = n => $(`[data-act="${n}"]`, view);
    if (act("block")) act("block").onclick = () => blockDialog(email);
    if (act("unblock")) act("unblock").onclick = async () => {
      const { error } = await sb.from("blocked_emails").delete().eq("email", email);
      if (error) return toast(error.message);
      toast(`${email} unblocked`); await refresh();
    };
    if (act("removeAll")) act("removeAll").onclick = () => confirmDialog({
      title: `Remove ${email} from every document?`,
      text: `They lose direct access to ${directDocs.size} ${directDocs.size === 1 ? "document" : "documents"}. Access through groups stays until you take them out of the group. Their history stays.`,
      confirm: "Remove access", danger: true,
      run: async () => {
        const { error } = await sb.from("document_access").delete().eq("email", email);
        if (error) throw error;
        toast("Access removed"); await refresh();
      }
    });
    if (act("resetPhone")) act("resetPhone").onclick = async () => {
      const { error } = await sb.from("device_locks").delete().eq("email", email);
      if (error) return toast(error.message);
      toast("Phone lock reset. Their next phone becomes the locked one."); await refresh();
    };
    act("saveProfile").onclick = async () => {
      const tags = [...new Set($("#prTags").value.split(",").map(t => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
      const { error } = await sb.from("people").upsert({
        email, display_name: $("#prName").value.trim() || null, referred_by_email: $("#prRef").value || null,
        tags, notes: $("#prNotes").value.trim() || null, updated_at: new Date().toISOString()
      });
      if (error) return toast(error.message);
      toast("Profile saved"); await refresh();
    };
    $$("[data-group]", view).forEach(cb => cb.onchange = async () => {
      const gid = cb.dataset.group;
      const { error } = cb.checked
        ? await sb.from("group_members").insert({ group_id: gid, email })
        : await sb.from("group_members").delete().eq("group_id", gid).eq("email", email);
      if (error) { cb.checked = !cb.checked; return toast(error.message); }
      toast(cb.checked ? "Added to group" : "Removed from group"); await refresh();
    });
    wireCommon();
  }

  // ---------- groups ----------
  function groupsPage() {
    view.innerHTML = `
      ${head("People", "Share documents with a whole group. Anyone you add later gets access automatically.",
        S.peopleV2 ? `<button class="primary" type="button" data-act="newGroup">New group</button>` : "")}
      ${peopleTabs("groups")}${r2Note()}
      <div class="panel">${S.groups.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Group</th><th class="num">Members</th><th class="num">Documents</th><th class="num hide-sm">Paid by members</th></tr></thead>
        <tbody>${S.groups.map(g => `<tr class="clickable" tabindex="0" data-href="group/${g.id}">
          <td><div class="cell-title">${esc(g.name)}</div>${g.description ? `<div class="cell-sub">${esc(g.description)}</div>` : ""}</td>
          <td class="num">${g.group_members.length}</td><td class="num">${g.group_documents.length}</td>
          <td class="num hide-sm">${inr(sum(g.group_members, m => personSummary(m.email).paid))}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState("No groups yet", "Make groups like \"Batch 3\" or \"Referred by Hrsh\".")}</div>`;
    const b = $('[data-act="newGroup"]'); if (b) b.onclick = () => groupDialog(null);
    wireCommon();
  }

  function groupDialog(g) {
    openDialog(`
      <div class="dlg-head"><h2>${g ? "Edit group" : "New group"}</h2></div>
      <div class="dlg-body">
        <label for="gName">Name</label><input id="gName" type="text" required maxlength="80" placeholder="e.g. Batch 3" value="${esc(g?.name || "")}">
        <label for="gDesc">Description (optional)</label><input id="gDesc" type="text" maxlength="300" value="${esc(g?.description || "")}">
        ${g ? "" : `<label for="gEmails">Members (optional)</label><textarea id="gEmails" placeholder="Paste email IDs, separated by commas or new lines"></textarea>`}
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">${g ? "Save" : "Create group"}</button></div>`,
      async () => {
        const name = $("#gName").value.trim(), description = $("#gDesc").value.trim() || null;
        if (g) {
          const { error } = await sb.from("groups").update({ name, description }).eq("id", g.id);
          if (error) throw error;
          dlg.close(); toast("Group saved"); await refresh(); return;
        }
        const { valid, invalid } = parseEmails($("#gEmails").value);
        if (invalid.length) throw new Error(`Check these email IDs: ${invalid.join(", ")}`);
        const { data, error } = await sb.from("groups").insert({ name, description }).select("id").single();
        if (error) throw new Error(/duplicate/.test(error.message) ? "A group with that name already exists." : error.message);
        if (valid.length) {
          const { error: e2 } = await sb.from("group_members").insert(valid.map(email => ({ group_id: data.id, email })));
          if (e2) throw e2;
        }
        dlg.close(); toast("Group created"); await refresh(); location.hash = `group/${data.id}`;
      });
  }

  function groupDetail(id) {
    const g = S.groups.find(x => x.id === id);
    if (!g) { view.innerHTML = head("Group not found", "It may have been deleted.", "", backLink("#people/groups", "Groups")); return; }
    const members = g.group_members.map(m => m.email).sort();
    const docIds = g.group_documents.map(x => x.document_id);
    const otherDocs = S.docs.filter(d => !docIds.includes(d.id));
    view.innerHTML = `
      ${head(g.name, g.description ? esc(g.description) : `${members.length} members, ${docIds.length} documents`,
        `<button type="button" data-act="editGroup">Edit</button><button type="button" class="danger" data-act="delGroup">Delete group</button>`,
        backLink("#people/groups", "Groups"))}
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Members</h2><span class="muted small-text">${members.length}</span></div>
          ${members.length ? `<div class="table-wrap"><table class="data"><tbody>${members.map(e => {
            const r = personSummary(e);
            return `<tr><td><a class="cell-title" href="#person/${encodeURIComponent(e)}">${esc(r.name || e)}</a><div class="cell-sub">${esc(e)}</div></td>
              <td class="num hide-sm">${r.secs ? fmtDuration(r.secs) : "–"}</td>
              <td class="num"><button class="small ghost" type="button" data-unmember="${esc(e)}">Remove</button></td></tr>`;
          }).join("")}</tbody></table></div>` : emptyState("No members yet", "Add email IDs below.")}
          <div class="panel-body" style="border-top:1px solid var(--rule)">
            <label for="gAdd" style="margin-top:0">Add members</label>
            <textarea id="gAdd" rows="3" style="min-height:72px" placeholder="Paste email IDs, separated by commas or new lines"></textarea>
            <div class="row" style="margin-top:10px"><button class="primary small" type="button" data-act="addMembers">Add to group</button><span id="gMsg" class="msg" style="margin:0"></span></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Documents</h2><span class="muted small-text">Every member can open these</span></div>
          ${docIds.length ? `<ul class="rank">${docIds.map(did => `<li><a href="#doc/${did}">${esc(docTitle(did))}</a>
            <button class="small ghost" type="button" data-undoc="${did}">Remove</button></li>`).join("")}</ul>` : emptyState("No documents yet", "Pick one below.")}
          ${otherDocs.length ? `<div class="panel-body row" style="border-top:1px solid var(--rule)">
            <select id="gDoc" style="flex:1;min-width:180px" aria-label="Document to share">${otherDocs.map(d => `<option value="${d.id}">${esc(d.title)}</option>`).join("")}</select>
            <button class="small primary" type="button" data-act="addDoc">Share with group</button></div>` : ""}
        </div>
      </div>`;
    $('[data-act="editGroup"]').onclick = () => groupDialog(g);
    $('[data-act="delGroup"]').onclick = () => confirmDialog({
      title: `Delete "${g.name}"?`, text: "Members lose any access that came only from this group. People and documents are not deleted.",
      confirm: "Delete group", danger: true,
      run: async () => { const { error } = await sb.from("groups").delete().eq("id", g.id); if (error) throw error; toast("Group deleted"); location.hash = "people/groups"; await refresh(); }
    });
    $('[data-act="addMembers"]').onclick = async () => {
      const msg = $("#gMsg");
      const { valid, invalid } = parseEmails($("#gAdd").value);
      if (invalid.length) { msg.className = "msg err"; msg.textContent = `Check these: ${invalid.join(", ")}`; return; }
      const fresh = valid.filter(e => !members.includes(e));
      if (!fresh.length) { msg.className = "msg err"; msg.textContent = "Those email IDs are already in the group."; return; }
      const { error } = await sb.from("group_members").insert(fresh.map(email => ({ group_id: g.id, email })));
      if (error) { msg.className = "msg err"; msg.textContent = error.message; return; }
      toast(`Added ${fresh.length} ${fresh.length === 1 ? "person" : "people"}`); await refresh();
    };
    const addDoc = $('[data-act="addDoc"]');
    if (addDoc) addDoc.onclick = async () => {
      const { error } = await sb.from("group_documents").insert({ group_id: g.id, document_id: $("#gDoc").value });
      if (error) return toast(error.message);
      toast("Shared with the group"); await refresh();
    };
    $$("[data-unmember]", view).forEach(b => b.onclick = async () => {
      const { error } = await sb.from("group_members").delete().eq("group_id", g.id).eq("email", b.dataset.unmember);
      if (error) return toast(error.message);
      toast("Removed from group"); await refresh();
    });
    $$("[data-undoc]", view).forEach(b => b.onclick = async () => {
      const { error } = await sb.from("group_documents").delete().eq("group_id", g.id).eq("document_id", b.dataset.undoc);
      if (error) return toast(error.message);
      toast("Document removed from group"); await refresh();
    });
  }

  // ---------- referral tree ----------
  function descendants(email, seen = new Set()) {
    const kids = [...D.people.keys()].filter(e => !seen.has(e) && referrerOf(e) === email);
    kids.forEach(k => seen.add(k));
    return kids.flatMap(k => [k, ...descendants(k, seen)]);
  }

  function treePage() {
    const all = [...D.people.keys()];
    const parent = new Map(all.map(e => [e, referrerOf(e)]));
    const kids = new Map();
    all.forEach(e => { const p = parent.get(e); if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(e); } });
    const roots = all.filter(e => kids.has(e) && !parent.get(e)).sort((a, b) => descendants(b).length - descendants(a).length);
    const unmatched = all.filter(e => !parent.get(e)).map(e => ({ e, text: S.payments.find(x => x.email === e && x.referred_by)?.referred_by }))
      .filter(x => x.text);
    const node = (e, depth, seen) => {
      if (seen.has(e) || depth > 12) return "";
      seen.add(e);
      const team = descendants(e);
      const s = personSummary(e);
      const children = (kids.get(e) || []).sort((a, b) => descendants(b).length - descendants(a).length);
      return `<li><details ${depth < 2 ? "open" : ""}><summary>
        <a href="#person/${encodeURIComponent(e)}" class="cell-title">${esc(s.name || e)}</a>
        <span class="muted small-text">${team.length ? `team of ${team.length}, ${inr(sum(team, x => personSummary(x).earned))} team earnings` : `${inr(s.earned)} earned`}</span></summary>
        ${children.length ? `<ul class="tree">${children.map(c => node(c, depth + 1, seen)).join("")}</ul>` : ""}</details></li>`;
    };
    view.innerHTML = `
      ${head("People", "Who invited whom, from \"referred by\" on payments and the referrer you set on profiles.")}
      ${peopleTabs("tree")}${r2Note()}
      <div class="panel">${roots.length ? `<div class="panel-body"><ul class="tree root">${roots.map(r => node(r, 0, new Set())).join("")}</ul></div>`
        : emptyState("No referrals linked yet", "When people fill in \"referred by\", or you set it on their profile, the tree appears here.")}</div>
      ${unmatched.length ? `<div class="panel section-gap"><div class="panel-head"><h2>Referrers not matched yet</h2><span class="muted small-text">Open the person and pick the right referrer</span></div>
        <div class="table-wrap"><table class="data"><thead><tr><th>Person</th><th>They wrote</th></tr></thead>
        <tbody>${unmatched.map(x => `<tr class="clickable" tabindex="0" data-href="person/${encodeURIComponent(x.e)}"><td>${esc(nameOf(x.e))}<div class="cell-sub">${esc(x.e)}</div></td><td>${esc(x.text)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
    wireCommon();
  }

  // ---------- access requests ----------
  function requestsPage() {
    const pend = S.requests.filter(r => r.status === "pending");
    const done = S.requests.filter(r => r.status !== "pending").slice(0, 50);
    view.innerHTML = `
      ${head("People", "People who signed in and asked for access.")}
      ${peopleTabs("requests")}${r2Note()}
      <div class="panel">
        <div class="panel-head"><h2>Waiting</h2><span class="muted small-text">${pend.length}</span></div>
        ${pend.length ? `<div class="table-wrap"><table class="data"><tbody>${pend.map(r => `<tr>
          <td><div class="cell-title">${esc(r.name)}</div><div class="cell-sub">${esc(r.email)}, ${esc(timeAgo(r.created_at))}</div>${r.message ? `<div class="cell-sub">"${esc(r.message)}"</div>` : ""}</td>
          <td class="num"><div class="row end"><button class="small primary" type="button" data-approve="${r.id}">Approve</button>
            <button class="small" type="button" data-decline="${r.id}">Decline</button></div></td></tr>`).join("")}</tbody></table></div>`
          : emptyState("No requests waiting", "When someone with no documents taps Request access in the app, they show up here.")}
      </div>
      ${done.length ? `<div class="panel section-gap"><div class="panel-head"><h2>Decided</h2></div><div class="table-wrap"><table class="data"><tbody>${done.map(r => `<tr>
        <td><a href="#person/${encodeURIComponent(r.email)}">${esc(r.name)}</a><div class="cell-sub">${esc(r.email)}</div></td>
        <td>${r.status === "approved" ? `<span class="tag live">Approved</span>` : `<span class="tag off">Declined</span>`}</td>
        <td class="muted hide-sm">${esc(r.decided_by || "")}, ${esc(timeAgo(r.decided_at))}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
    $$("[data-approve]", view).forEach(b => b.onclick = () => approveDialog(S.requests.find(r => r.id === b.dataset.approve)));
    $$("[data-decline]", view).forEach(b => b.onclick = async () => {
      const { error } = await sb.from("access_requests").update({ status: "declined", decided_by: user.email, decided_at: new Date().toISOString() }).eq("id", b.dataset.decline);
      if (error) return toast(error.message);
      toast("Request declined"); await refresh();
    });
  }

  function approveDialog(req) {
    openDialog(`
      <div class="dlg-head"><h2>Approve ${esc(req.name)}</h2><p class="sub" style="margin:6px 0 0">${esc(req.email)}. Choose what they can open.</p></div>
      <div class="dlg-body">
        ${S.groups.length ? `<label style="margin-top:6px">Add to groups</label><div class="check-list">${S.groups.map(g => `<label class="row" style="margin:0;gap:8px;font-weight:400"><input type="checkbox" name="apG" value="${g.id}"> ${esc(g.name)} <span class="muted small-text">${g.group_documents.length} docs</span></label>`).join("")}</div>` : ""}
        <label>Give access to documents</label>
        <div class="check-list" style="max-height:220px;overflow:auto">${S.docs.map(d => `<label class="row" style="margin:0;gap:8px;font-weight:400"><input type="checkbox" name="apD" value="${d.id}"> ${esc(d.title)}</label>`).join("") || `<p class="muted small-text">No documents yet.</p>`}</div>
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Approve</button></div>`,
      async () => {
        const gs = $$('input[name="apG"]:checked', dlg).map(i => i.value), ds = $$('input[name="apD"]:checked', dlg).map(i => i.value);
        if (!gs.length && !ds.length) throw new Error("Pick at least one group or document.");
        if (gs.length) { const { error } = await sb.from("group_members").upsert(gs.map(group_id => ({ group_id, email: req.email })), { onConflict: "group_id,email", ignoreDuplicates: true }); if (error) throw error; }
        if (ds.length) { const { error } = await sb.from("document_access").upsert(ds.map(document_id => ({ document_id, email: req.email })), { onConflict: "document_id,email", ignoreDuplicates: true }); if (error) throw error; }
        const { error } = await sb.from("access_requests").update({ status: "approved", decided_by: user.email, decided_at: new Date().toISOString() }).eq("id", req.id);
        if (error) throw error;
        dlg.close(); toast(`${req.name} approved`); await refresh();
      });
  }

  // ---------------------------------------------------------------
  // Messages: announcements, Help/FAQ, feedback inbox
  // ---------------------------------------------------------------
  const MSG_TABS = [["", "Announcements"], ["faq", "Help & FAQ"], ["feedback", "Feedback"]];
  const msgTabs = active => {
    const fresh = S.feedback.filter(f => f.status === "new").length;
    return `<nav class="tabs" aria-label="Messages">${MSG_TABS.map(([k, l]) =>
      `<a href="#messages${k ? "/" + k : ""}" ${k === active ? 'aria-current="page"' : ""}>${l}${k === "feedback" && fresh ? ` (${fresh})` : ""}</a>`).join("")}</nav>`;
  };
  function messages(tab = "") {
    if (!S.portalV1) {
      view.innerHTML = `${head("Messages", "Announcements, help pages and feedback for your people.")}
        <div class="notice">Run <code>supabase/008_portal.sql</code> in the Supabase SQL Editor to switch this on.</div>`;
      return;
    }
    ({ "": announcementsPage, faq: faqPage, feedback: feedbackPage }[tab] || announcementsPage)();
  }

  function announcementsPage() {
    const now = new Date();
    const state = a => !a.is_active ? ["off", "Hidden"] : a.expires_at && new Date(a.expires_at) < now ? ["warn", "Ended"] : ["live", a.pinned ? "Pinned" : "Showing"];
    view.innerHTML = `
      ${head("Messages", "Shown at the top of everyone's home screen in the app.", `<button class="primary" type="button" data-act="newAnn">${icon("megaphone")}New announcement</button>`)}
      ${msgTabs("")}
      <div class="panel">${S.announcements.length ? `<div class="table-wrap"><table class="data"><tbody>${S.announcements.map(a => { const [c, t] = state(a); return `<tr>
        <td><div class="cell-title">${esc(a.title)}</div>${a.body ? `<div class="cell-sub clamp">${esc(a.body)}</div>` : ""}
          <div class="cell-sub">${esc(timeAgo(a.created_at))} by ${esc(a.created_by)}${a.expires_at ? `, until ${esc(fmtDate(a.expires_at))}` : ""}</div></td>
        <td><span class="tag ${c}">${t}</span></td>
        <td class="num"><div class="row end"><button class="small" type="button" data-edit-ann="${a.id}">Edit</button><button class="small ghost" type="button" data-del-ann="${a.id}">Delete</button></div></td></tr>`; }).join("")}</tbody></table></div>`
        : emptyState("No announcements yet", "Post news, deadlines or reminders. Everyone sees them when they open the app.")}</div>`;
    $('[data-act="newAnn"]').onclick = () => annDialog(null);
    $$("[data-edit-ann]", view).forEach(b => b.onclick = () => annDialog(S.announcements.find(a => a.id === b.dataset.editAnn)));
    $$("[data-del-ann]", view).forEach(b => b.onclick = () => confirmDialog({ title: "Delete this announcement?", text: "It disappears from everyone's home screen.", confirm: "Delete", danger: true,
      run: async () => { const { error } = await sb.from("announcements").delete().eq("id", b.dataset.delAnn); if (error) throw error; toast("Announcement deleted"); await refresh(); } }));
  }
  function annDialog(a) {
    openDialog(`
      <div class="dlg-head"><h2>${a ? "Edit announcement" : "New announcement"}</h2></div>
      <div class="dlg-body">
        <label for="anTitle">Title</label><input id="anTitle" type="text" required maxlength="120" value="${esc(a?.title || "")}" placeholder="e.g. New assessment batch starts Monday">
        <label for="anBody">Message (optional)</label><textarea id="anBody" rows="5" maxlength="2000">${esc(a?.body || "")}</textarea>
        <label for="anExp">Show until (optional)</label><input id="anExp" type="datetime-local" value="${toLocalInput(a?.expires_at)}">
        <label class="row" style="gap:8px;font-weight:400"><input type="checkbox" id="anPin" style="width:auto;margin:0" ${a?.pinned ? "checked" : ""}> Pin to the top</label>
        <label class="row" style="gap:8px;font-weight:400;margin-top:8px"><input type="checkbox" id="anOn" style="width:auto;margin:0" ${a ? (a.is_active ? "checked" : "") : "checked"}> Showing</label>
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">${a ? "Save" : "Post"}</button></div>`,
      async () => {
        const exp = $("#anExp").value;
        const row = { title: $("#anTitle").value.trim(), body: $("#anBody").value.trim() || null, pinned: $("#anPin").checked, is_active: $("#anOn").checked, expires_at: exp ? new Date(exp).toISOString() : null };
        const { error } = a ? await sb.from("announcements").update(row).eq("id", a.id) : await sb.from("announcements").insert(row);
        if (error) throw error;
        dlg.close(); toast(a ? "Saved" : "Posted"); await refresh();
      });
  }

  function faqPage() {
    view.innerHTML = `
      ${head("Messages", "Questions and answers people see on the Help page in the app.", `<button class="primary" type="button" data-act="newFaq">Add a question</button>`)}
      ${msgTabs("faq")}
      <div class="panel">${S.faqs.length ? `<div class="table-wrap"><table class="data"><tbody>${S.faqs.map((f, i) => `<tr>
        <td><div class="cell-title">${esc(f.question)}</div><div class="cell-sub clamp">${esc(f.answer)}</div></td>
        <td>${f.is_active ? `<span class="tag live">Showing</span>` : `<span class="tag off">Hidden</span>`}</td>
        <td class="num"><div class="row end">
          <button class="small ghost" type="button" data-move="${i}" data-dir="-1" ${i ? "" : "disabled"} aria-label="Move up">↑</button>
          <button class="small ghost" type="button" data-move="${i}" data-dir="1" ${i < S.faqs.length - 1 ? "" : "disabled"} aria-label="Move down">↓</button>
          <button class="small" type="button" data-edit-faq="${f.id}">Edit</button><button class="small ghost" type="button" data-del-faq="${f.id}">Delete</button></div></td></tr>`).join("")}</tbody></table></div>`
        : emptyState("No questions yet", "Add answers to what people ask you most: how to install the app, how to pay, who to contact.")}</div>`;
    $('[data-act="newFaq"]').onclick = () => faqDialog(null);
    $$("[data-edit-faq]", view).forEach(b => b.onclick = () => faqDialog(S.faqs.find(f => f.id === b.dataset.editFaq)));
    $$("[data-del-faq]", view).forEach(b => b.onclick = () => confirmDialog({ title: "Delete this question?", text: "It's removed from the Help page.", confirm: "Delete", danger: true,
      run: async () => { const { error } = await sb.from("faqs").delete().eq("id", b.dataset.delFaq); if (error) throw error; toast("Deleted"); await refresh(); } }));
    $$("[data-move]", view).forEach(b => b.onclick = async () => {
      const list = S.faqs.slice(), i = Number(b.dataset.move), j = i + Number(b.dataset.dir);
      [list[i], list[j]] = [list[j], list[i]];
      const res = await Promise.all(list.map((f, k) => f.sort_order === k ? null : sb.from("faqs").update({ sort_order: k }).eq("id", f.id)).filter(Boolean));
      const err = res.find(r => r.error); if (err) return toast(err.error.message);
      await refresh();
    });
  }
  function faqDialog(f) {
    openDialog(`
      <div class="dlg-head"><h2>${f ? "Edit question" : "Add a question"}</h2></div>
      <div class="dlg-body">
        <label for="fqQ">Question</label><input id="fqQ" type="text" required maxlength="300" value="${esc(f?.question || "")}" placeholder="e.g. How do I install the app?">
        <label for="fqA">Answer</label><textarea id="fqA" rows="7" required maxlength="4000">${esc(f?.answer || "")}</textarea>
        <p class="hint">Plain text. Line breaks are kept, and links starting with https:// become tappable.</p>
        <label class="row" style="gap:8px;font-weight:400"><input type="checkbox" id="fqOn" style="width:auto;margin:0" ${f ? (f.is_active ? "checked" : "") : "checked"}> Showing</label>
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Save</button></div>`,
      async () => {
        const row = { question: $("#fqQ").value.trim(), answer: $("#fqA").value.trim(), is_active: $("#fqOn").checked, updated_at: new Date().toISOString() };
        const { error } = f ? await sb.from("faqs").update(row).eq("id", f.id) : await sb.from("faqs").insert({ ...row, sort_order: S.faqs.length });
        if (error) throw error;
        dlg.close(); toast("Saved"); await refresh();
      });
  }

  const FB_KIND = { idea: "Idea", problem: "Problem", question: "Question", other: "Other" };
  function feedbackPage() {
    const order = { new: 0, seen: 1, done: 2 };
    const list = S.feedback.slice().sort((a, b) => order[a.status] - order[b.status] || new Date(b.created_at) - new Date(a.created_at));
    view.innerHTML = `
      ${head("Messages", "What people sent from the Feedback button in the app.")}
      ${msgTabs("feedback")}
      <div class="panel">${list.length ? `<ul class="fb-list">${list.map(f => `<li class="fb ${f.status}">
        <div class="row" style="justify-content:space-between;gap:8px">
          <div><a class="cell-title" href="#person/${encodeURIComponent(f.email)}">${esc(nameOf(f.email))}</a>
            <span class="muted small-text">${esc(FB_KIND[f.kind] || f.kind)}, ${esc(timeAgo(f.created_at))}</span></div>
          <span class="tag ${f.status === "new" ? "warn" : f.status === "done" ? "live" : "plain"}">${f.status === "new" ? "New" : f.status === "done" ? "Done" : "Seen"}</span></div>
        <p class="fb-msg">${esc(f.message)}</p>
        ${f.admin_reply ? `<p class="fb-reply"><strong>Your reply</strong> (${esc(f.replied_by || "")}): ${esc(f.admin_reply)}</p>` : ""}
        <div class="row">
          <button class="small primary" type="button" data-reply="${f.id}">${f.admin_reply ? "Edit reply" : "Reply"}</button>
          ${f.status !== "done" ? `<button class="small" type="button" data-fbs="${f.id}" data-to="done">Mark done</button>` : `<button class="small" type="button" data-fbs="${f.id}" data-to="seen">Reopen</button>`}
          ${f.status === "new" ? `<button class="small ghost" type="button" data-fbs="${f.id}" data-to="seen">Mark seen</button>` : ""}
          <span class="spacer"></span><button class="small ghost" type="button" data-fbdel="${f.id}">Delete</button></div></li>`).join("")}</ul>`
        : emptyState("No feedback yet", "When someone taps Send feedback in the app, it lands here.")}</div>`;
    $$("[data-fbs]", view).forEach(b => b.onclick = async () => {
      const { error } = await sb.from("feedback").update({ status: b.dataset.to }).eq("id", b.dataset.fbs);
      if (error) return toast(error.message); await refresh();
    });
    $$("[data-fbdel]", view).forEach(b => b.onclick = () => confirmDialog({ title: "Delete this message?", text: "It's removed for good.", confirm: "Delete", danger: true,
      run: async () => { const { error } = await sb.from("feedback").delete().eq("id", b.dataset.fbdel); if (error) throw error; toast("Deleted"); await refresh(); } }));
    $$("[data-reply]", view).forEach(b => b.onclick = () => {
      const f = S.feedback.find(x => x.id === b.dataset.reply);
      openDialog(`
        <div class="dlg-head"><h2>Reply to ${esc(nameOf(f.email))}</h2><p class="sub" style="margin:6px 0 0">They see your reply in the app under Send feedback.</p></div>
        <div class="dlg-body"><blockquote class="fb-quote">${esc(f.message)}</blockquote>
          <label for="fbR">Reply</label><textarea id="fbR" rows="5" required maxlength="2000">${esc(f.admin_reply || "")}</textarea>
          <div class="msg dlg-msg" role="status"></div></div>
        <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Send reply</button></div>`,
        async () => {
          const { error } = await sb.from("feedback").update({ admin_reply: $("#fbR").value.trim(), replied_by: user.email, replied_at: new Date().toISOString(), status: "done" }).eq("id", f.id);
          if (error) throw error;
          dlg.close(); toast("Reply saved"); await refresh();
        });
    });
    // Opening the inbox marks new items as seen.
    const fresh = S.feedback.filter(f => f.status === "new").map(f => f.id);
    if (fresh.length) setTimeout(async () => {
      await sb.from("feedback").update({ status: "seen" }).in("id", fresh);
      S.feedback.forEach(f => { if (fresh.includes(f.id)) f.status = "seen"; });
      const c = $('[data-count="messages"]'); if (c) c.textContent = "";
    }, 4000);
  }

  // ---------------------------------------------------------------
  // Monthly statement for one person (print or save as PDF)
  // ---------------------------------------------------------------
  function statement(emailArg, monthArg) {
    const email = decodeURIComponent(emailArg || "");
    const r = personSummary(email);
    const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const months = [...new Set(r.pays.map(p => monthKey(payDay(p))))].sort().reverse();
    const month = monthArg || months[0] || monthKey(new Date());
    const [y, m] = month.split("-").map(Number);
    const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const rows = r.pays.filter(p => monthKey(payDay(p)) === month).sort((a, b) => payDay(a) - payDay(b));
    const counted = rows.filter(p => p.status !== "rejected");
    const earned = sum(counted, p => Number(p.amount_earned)), paid = sum(counted, p => Number(p.amount_sent));
    const verified = sum(rows.filter(p => p.status === "verified"), p => Number(p.amount_sent));
    const expected = S.expectedPercent ? earned * S.expectedPercent / 100 : null;
    view.innerHTML = `
      <div class="no-print">${head("Monthly statement", esc(r.name || email), `<button class="primary" type="button" data-act="print">Print or save as PDF</button>`, backLink(`#person/${encodeURIComponent(email)}`, r.name || email))}
        <div class="row" style="margin-bottom:16px"><label for="stMonth" style="margin:0">Month</label>
          <select id="stMonth" style="width:auto">${[...new Set([month, ...months])].sort().reverse().map(k => { const [yy, mm] = k.split("-").map(Number);
            return `<option value="${k}" ${k === month ? "selected" : ""}>${new Date(yy, mm - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</option>`; }).join("")}</select></div></div>
      <article class="statement">
        <header class="st-head"><div>${brandHTML()}<p class="muted small-text" style="margin:6px 0 0">Statement for ${esc(label)}</p></div>
          <div class="st-to"><strong>${esc(r.name || email)}</strong><br>${esc(email)}${r.outlierId ? `<br>Outlier ID ${esc(r.outlierId)}` : ""}</div></header>
        <div class="st-totals">
          <div><span>Earned</span><strong>${inr(earned)}</strong></div>
          <div><span>Paid</span><strong>${inr(paid)}</strong></div>
          <div><span>Share paid</span><strong>${pctTxt(earned ? (paid / earned) * 100 : null)}</strong></div>
          ${expected != null ? `<div><span>Expected at ${S.expectedPercent}%</span><strong>${inr(expected)}</strong></div>` : ""}
        </div>
        ${rows.length ? `<table class="data st-table"><thead><tr><th>Payout date</th><th>UTR</th><th class="num">Earned</th><th class="num">Paid</th><th class="num">Share</th><th>Status</th></tr></thead>
          <tbody>${rows.map(p => `<tr><td>${esc(payDay(p).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }))}</td><td>${esc(p.utr || "–")}</td>
            <td class="num">${inr(p.amount_earned)}</td><td class="num">${inr(p.amount_sent)}</td><td class="num">${pctTxt(Number(p.amount_earned) ? (p.amount_sent / p.amount_earned) * 100 : null)}</td>
            <td>${(PAY_STATUS[p.status] || PAY_STATUS.pending)[1]}</td></tr>`).join("")}</tbody>
          <tfoot><tr><th colspan="2">Total (excluding rejected)</th><th class="num">${inr(earned)}</th><th class="num">${inr(paid)}</th><th class="num">${pctTxt(earned ? (paid / earned) * 100 : null)}</th><th></th></tr></tfoot></table>`
          : `<p class="muted">No payments with a payout date in ${esc(label)}.</p>`}
        <p class="muted small-text st-foot">Verified so far: ${inr(verified)}. ${expected != null && paid < expected ? `Short by ${inr(expected - paid)} against the expected ${S.expectedPercent}%.` : ""} Generated ${esc(new Date().toLocaleString())}.</p>
      </article>`;
    $("#stMonth").onchange = e => { location.hash = `statement/${encodeURIComponent(email)}/${e.target.value}`; };
    $('[data-act="print"]').onclick = () => window.print();
  }

  // ---------------------------------------------------------------
  // Security: alerts, one-phone lock, admins, full change log
  // ---------------------------------------------------------------
  const SEC_TABS = [["", "Alerts"], ["phones", "Phone lock"], ["admins", "Admins"], ["log", "Change log"]];
  const secTabs = active => {
    const pend = S.deviceRequests.filter(r => r.status === "pending").length;
    return `<nav class="tabs" aria-label="Security">${SEC_TABS.map(([k, l]) =>
      `<a href="#security${k ? "/" + k : ""}" ${k === active ? 'aria-current="page"' : ""}>${l}${k === "phones" && pend ? ` (${pend})` : k === "" && D.alerts.length ? ` (${D.alerts.length})` : ""}</a>`).join("")}</nav>`;
  };
  const secNote = () => S.securityV1 ? "" : `<div class="notice" style="margin-bottom:16px">Run <code>supabase/009_security.sql</code> to switch on view-only admins, the phone lock and the full change log.</div>`;
  function security(tab = "") {
    ({ "": alertsPage, phones: phonesPage, admins: adminsPage, log: fullLog }[tab] || alertsPage)();
  }

  // Patterns worth a look, worked out from reading sessions and payments.
  function computeAlerts() {
    const out = [];
    const since = Date.now() - 14 * 864e5;
    const recent = S.sessions.filter(s => new Date(s.started_at) > since && s.device_id);
    // One phone, several accounts: likely a shared or borrowed account.
    groupBy(recent, s => s.device_id).forEach((list, dev) => {
      const emails = [...new Set(list.map(s => s.email))];
      if (emails.length > 1) out.push({ level: "high", kind: "Shared phone", emails, text: `${emails.length} accounts read on the same phone (${list[0].device_label || "Android"})`, when: list[0].last_seen_at });
    });
    // One account, many phones.
    groupBy(recent, s => s.email).forEach((list, email) => {
      const devs = new Set(list.map(s => s.device_id));
      if (devs.size >= 3) out.push({ level: "med", kind: "Many phones", emails: [email], text: `Used ${devs.size} different phones in 2 weeks`, when: list[0].last_seen_at });
      // Two phones at the same time.
      const sorted = list.slice().sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1], b = sorted[i];
        if (a.device_id !== b.device_id && new Date(b.started_at) < new Date(a.last_seen_at)) {
          out.push({ level: "high", kind: "Two phones at once", emails: [email], text: `Reading on ${a.device_label || "one phone"} and ${b.device_label || "another"} at the same time`, when: b.started_at });
          break;
        }
      }
      // Very long sessions in the middle of the night (local time).
      const night = list.filter(s => { const h = new Date(s.started_at).getHours(); return h >= 1 && h < 5 && s.seconds > 1800; });
      if (night.length >= 3) out.push({ level: "low", kind: "Night reading", emails: [email], text: `${night.length} long sessions between 1 and 5 am`, when: night[0].started_at });
    });
    // Blocked people who still have sessions after being blocked.
    S.blocked.forEach(b => {
      const after = (D.sessByEmail.get(b.email) || []).filter(s => new Date(s.last_seen_at) > new Date(b.blocked_at));
      if (after.length) out.push({ level: "high", kind: "Blocked but active", emails: [b.email], text: "Still reading after being blocked; check their access", when: after[0].last_seen_at });
    });
    // Payments with reused UTRs or matching screenshots.
    S.payments.filter(p => p.status === "pending").forEach(p => {
      const f = payFlags(p).filter(x => !x.cls);
      if (f.length) out.push({ level: "med", kind: "Payment check", emails: [p.email], text: `${inr(p.amount_sent)} payment: ${f.map(x => x.text).join(", ")}`, when: p.created_at, href: `payment/${p.id}` });
    });
    const rank = { high: 0, med: 1, low: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level] || new Date(b.when) - new Date(a.when));
  }

  function alertsPage() {
    const A = D.alerts;
    const lvl = { high: ["off", "Check now"], med: ["warn", "Worth a look"], low: ["plain", "FYI"] };
    view.innerHTML = `
      ${head("Security", "Unusual patterns from the last 2 weeks of reading and from pending payments.")}
      ${secTabs("")}${secNote()}
      <div class="panel">${A.length ? `<div class="table-wrap"><table class="data"><tbody>${A.map(a => `<tr${a.href ? ` class="clickable" tabindex="0" data-href="${a.href}"` : ""}>
        <td><span class="tag ${lvl[a.level][0]}">${lvl[a.level][1]}</span></td>
        <td><div class="cell-title">${esc(a.kind)}</div><div class="cell-sub">${esc(a.text)}</div></td>
        <td>${a.emails.slice(0, 4).map(e => `<a href="#person/${encodeURIComponent(e)}">${esc(nameOf(e))}</a>`).join("<br>")}${a.emails.length > 4 ? `<br><span class="muted small-text">+${a.emails.length - 4} more</span>` : ""}</td>
        <td class="muted hide-sm">${esc(timeAgo(a.when))}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState("Nothing unusual", "Shared phones, two phones at once, blocked people still reading and suspicious payments show up here.")}</div>
      <p class="hint">Alerts are hints, not proof. Open the person to see their phones and sessions before you block anyone.</p>`;
    wireCommon();
  }

  function phonesPage() {
    const pend = S.deviceRequests.filter(r => r.status === "pending");
    const lockLabel = e => S.deviceLocks.find(l => l.email === e);
    view.innerHTML = `
      ${head("Security", "Each person can read on one phone. A new phone needs your approval.")}
      ${secTabs("phones")}${secNote()}
      <div class="panel" style="margin-bottom:16px"><div class="panel-body row" style="justify-content:space-between">
        <div><strong>One-phone lock is ${S.deviceLock ? "on" : "off"}</strong>
          <p class="hint" style="margin:4px 0 0">${S.deviceLock ? "The first phone someone opens a document on becomes their phone. Admins are never locked." : "Anyone with access can read on any phone with the app."}</p></div>
        ${S.isOwner && S.securityV1 ? `<button type="button" class="${S.deviceLock ? "" : "primary"}" data-act="toggleLock">${S.deviceLock ? "Turn off" : "Turn on"}</button>` : ""}
      </div></div>
      <div class="panel">
        <div class="panel-head"><h2>Asking to use a new phone</h2><span class="muted small-text">${pend.length}</span></div>
        ${pend.length ? `<div class="table-wrap"><table class="data"><tbody>${pend.map(r => { const l = lockLabel(r.email); return `<tr>
          <td><a class="cell-title" href="#person/${encodeURIComponent(r.email)}">${esc(nameOf(r.email))}</a><div class="cell-sub">${esc(r.email)}, ${esc(timeAgo(r.created_at))}</div></td>
          <td><div>${esc(r.device_label || "Android phone")}</div><div class="cell-sub">Now locked to ${esc(l?.device_label || "another phone")}</div></td>
          <td class="num"><div class="row end"><button class="small primary" type="button" data-dev="${r.id}" data-to="approved">Allow new phone</button>
            <button class="small" type="button" data-dev="${r.id}" data-to="declined">Decline</button></div></td></tr>`; }).join("")}</tbody></table></div>`
          : emptyState("No requests", "When a locked person opens a document on a different phone, they can ask here.")}
      </div>
      <div class="panel section-gap">
        <div class="panel-head"><h2>Locked phones</h2><span class="muted small-text">${S.deviceLocks.length}</span></div>
        ${S.deviceLocks.length ? `<div class="table-wrap"><table class="data"><tbody>${S.deviceLocks.slice().sort((a, b) => new Date(b.locked_at) - new Date(a.locked_at)).map(l => `<tr>
          <td><a class="cell-title" href="#person/${encodeURIComponent(l.email)}">${esc(nameOf(l.email))}</a><div class="cell-sub">${esc(l.email)}</div></td>
          <td>${esc(l.device_label || "Android phone")}<div class="cell-sub">since ${esc(fmtDate(l.locked_at))}</div></td>
          <td class="num"><button class="small ghost" type="button" data-unlock="${esc(l.email)}">Reset</button></td></tr>`).join("")}</tbody></table></div>`
          : emptyState("No phones locked yet", S.deviceLock ? "Phones get locked the first time each person opens a document." : "Turn the lock on to start.")}
      </div>`;
    const t = $('[data-act="toggleLock"]');
    if (t) t.onclick = () => confirmDialog({
      title: S.deviceLock ? "Turn off the one-phone lock?" : "Turn on the one-phone lock?",
      text: S.deviceLock ? "People can read on any phone again. Saved phones are kept in case you turn it back on." : "Each person's next document opens their phone lock. If they switch phones later, they ask you first. People on app version 4 or older will be asked to update.",
      confirm: S.deviceLock ? "Turn off" : "Turn on",
      run: async () => {
        const { error } = await sb.from("app_settings").upsert({ key: "device_lock", value: !S.deviceLock, updated_at: new Date().toISOString() });
        if (error) throw error; toast(S.deviceLock ? "Phone lock off" : "Phone lock on"); await refresh();
      }
    });
    $$("[data-dev]", view).forEach(b => b.onclick = async () => {
      const { error } = await sb.from("device_requests").update({ status: b.dataset.to, decided_by: user.email, decided_at: new Date().toISOString() }).eq("id", b.dataset.dev);
      if (error) return toast(error.message);
      toast(b.dataset.to === "approved" ? "New phone allowed. The old phone can't open documents now." : "Request declined"); await refresh();
    });
    $$("[data-unlock]", view).forEach(b => b.onclick = () => confirmDialog({
      title: `Reset ${b.dataset.unlock}'s phone?`, text: "The next phone they open a document on becomes their phone.", confirm: "Reset",
      run: async () => { const { error } = await sb.from("device_locks").delete().eq("email", b.dataset.unlock); if (error) throw error; toast("Phone lock reset"); await refresh(); }
    }));
    wireCommon();
  }

  const ROLE = { owner: "Owner", admin: "Admin", viewer: "View only" };
  function adminsPage() {
    view.innerHTML = `
      ${head("Security", "Who can open this dashboard.", S.isOwner && S.securityV1 ? `<button class="primary" type="button" data-act="addAdmin">Add an admin</button>` : "")}
      ${secTabs("admins")}${secNote()}
      <div class="panel">${S.admins.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>${S.admins.map(a => `<tr>
        <td><div class="cell-title">${esc(a.email)}</div>${a.email === user.email ? `<div class="cell-sub">You</div>` : ""}</td>
        <td>${S.isOwner && a.email !== user.email && S.securityV1 ? `<select data-role="${esc(a.email)}" style="width:auto">${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${a.role === k ? "selected" : ""}>${l}</option>`).join("")}</select>`
          : `<span class="tag ${a.role === "viewer" ? "plain" : "live"}">${ROLE[a.role] || a.role}</span>`}</td>
        <td class="num">${S.isOwner && a.email !== user.email && S.securityV1 ? `<button class="small ghost" type="button" data-rmadmin="${esc(a.email)}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState("Admins", "Only the owner can see the full list.")}</div>
      <div class="panel section-gap"><div class="panel-body small-text">
        <p style="margin:0 0 6px"><strong>Owner</strong>: everything, including payment accounts, settings and admins.</p>
        <p style="margin:0 0 6px"><strong>Admin</strong>: share documents, manage people, review payments and reply to feedback.</p>
        <p style="margin:0"><strong>View only</strong>: can see the dashboard but can't change anything. The database refuses their changes.</p>
      </div></div>`;
    const add = $('[data-act="addAdmin"]');
    if (add) add.onclick = () => openDialog(`
      <div class="dlg-head"><h2>Add an admin</h2><p class="sub" style="margin:6px 0 0">They sign in at the admin page with this Google account.</p></div>
      <div class="dlg-body"><label for="adEmail">Email</label><input id="adEmail" type="email" required>
        <label for="adRole">Role</label><select id="adRole"><option value="viewer">View only</option><option value="admin">Admin</option></select>
        <div class="msg dlg-msg" role="status"></div></div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Add</button></div>`,
      async () => {
        const { error } = await sb.from("admins").insert({ email: $("#adEmail").value.trim().toLowerCase(), role: $("#adRole").value });
        if (error) throw new Error(/duplicate/.test(error.message) ? "That email is already an admin." : /bad_email/.test(error.message) ? "Check the email." : error.message);
        dlg.close(); toast("Admin added"); await refresh();
      });
    $$("[data-role]", view).forEach(sel => sel.onchange = async () => {
      const { error } = await sb.from("admins").update({ role: sel.value }).eq("email", sel.dataset.role);
      if (error) { toast(/last_owner/.test(error.message) ? "There must always be one owner." : error.message); return refresh(); }
      toast("Role changed"); await refresh();
    });
    $$("[data-rmadmin]", view).forEach(b => b.onclick = () => confirmDialog({
      title: `Remove ${b.dataset.rmadmin}?`, text: "They lose access to this dashboard straight away.", confirm: "Remove", danger: true,
      run: async () => { const { error } = await sb.from("admins").delete().eq("email", b.dataset.rmadmin); if (error) throw new Error(/last_owner/.test(error.message) ? "There must always be one owner." : error.message); toast("Admin removed"); await refresh(); }
    }));
  }

  function fullLog(filter = "") {
    const AREAS = { "": "Everything", payments: "Payments", docs: "Documents & access", people: "People & groups", messages: "Messages", security: "Admins & security" };
    const area = t => /^payment|app_settings/.test(t) ? "payments" : /^document|blocked/.test(t) ? "docs" : /^people|group|access_requests/.test(t) ? "people" : /^announce|faq|feedback/.test(t) ? "messages" : "security";
    const L = S.audit.filter(r => !filter || area(r.table_name) === filter);
    view.innerHTML = `
      ${head("Security", "Every change made from the dashboard. Recorded by the database; nobody can edit or delete it.", `<button type="button" data-act="csv">Download CSV</button>`)}
      ${secTabs("log")}${secNote()}
      <div class="panel">
        <div class="panel-head"><select id="logArea" style="width:auto" aria-label="Area">${Object.entries(AREAS).map(([k, l]) => `<option value="${k}" ${k === filter ? "selected" : ""}>${l}</option>`).join("")}</select>
          <span class="muted small-text">Latest ${S.audit.length}</span></div>
        ${L.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Who</th><th>What happened</th></tr></thead>
        <tbody>${L.map(r => `<tr><td class="muted">${esc(fmtDate(r.at))}</td><td>${esc(r.actor)}</td><td style="white-space:normal">${esc(auditSummary(r))}</td></tr>`).join("")}</tbody></table></div>`
          : emptyState("Nothing recorded yet", "Changes appear here as they happen.")}
      </div>`;
    $("#logArea").onchange = e => fullLog(e.target.value);
    $('[data-act="csv"]').onclick = () => downloadCsv([["When", "Who", "Table", "Action", "Summary"], ...L.map(r => [r.at, r.actor, r.table_name, r.action, auditSummary(r)])], "change-log.csv");
  }

  // ---------------------------------------------------------------
  // Quizzes
  // ---------------------------------------------------------------
  function quizzes() {
    if (!S.quizV1) {
      view.innerHTML = `${head("Quizzes", "Check that people understood what they read.")}
        <div class="notice">Run <code>supabase/010_quizzes.sql</code> in the Supabase SQL Editor to switch this on.</div>`;
      return;
    }
    view.innerHTML = `
      ${head("Quizzes", "Check that people understood what they read. Answers stay in the database; people only see them after they submit.", `<button class="primary" type="button" data-act="newQuiz">${icon("quiz")}New quiz</button>`)}
      <div class="panel">${S.quizzes.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Quiz</th><th class="num">Questions</th><th class="num">People</th><th class="num">Passed</th><th class="num hide-sm">Average</th></tr></thead>
        <tbody>${S.quizzes.map(z => { const st = quizStats(z); return `<tr class="clickable" tabindex="0" data-href="quiz/${z.id}">
          <td><div class="cell-title">${esc(z.title)}</div><div class="cell-sub">${z.document_id ? `For "${esc(docTitle(z.document_id))}" readers` : "Anyone signed in"}${z.is_active ? "" : " · Hidden"}${z.one_attempt ? " · One try" : ""}</div></td>
          <td class="num">${z.quiz_questions.length}</td><td class="num">${st.people}</td>
          <td class="num">${st.people ? `${st.passed} of ${st.people}` : "–"}</td><td class="num hide-sm">${st.avg == null ? "–" : `${st.avg}%`}</td></tr>`; }).join("")}</tbody></table></div>`
        : emptyState("No quizzes yet", "Make a short multiple-choice quiz for a document or for everyone.")}</div>`;
    $('[data-act="newQuiz"]').onclick = () => quizDialog(null);
    wireCommon();
  }
  function quizStats(z) {
    const byEmail = groupBy(z.quiz_attempts, a => a.email);
    const best = [...byEmail.values()].map(l => Math.max(...l.map(a => a.total ? (100 * a.score) / a.total : 0)));
    return { people: byEmail.size, passed: [...byEmail.values()].filter(l => l.some(a => a.passed)).length, avg: best.length ? Math.round(best.reduce((t, v) => t + v, 0) / best.length) : null, byEmail };
  }
  function quizDialog(z) {
    openDialog(`
      <div class="dlg-head"><h2>${z ? "Quiz settings" : "New quiz"}</h2></div>
      <div class="dlg-body">
        <label for="qzT">Title</label><input id="qzT" type="text" required maxlength="150" value="${esc(z?.title || "")}" placeholder="e.g. Onboarding guide check">
        <label for="qzD">Description (optional)</label><input id="qzD" type="text" maxlength="1000" value="${esc(z?.description || "")}">
        <label for="qzDoc">Who can take it</label><select id="qzDoc"><option value="">Anyone signed in</option>${S.docs.map(d => `<option value="${d.id}" ${z?.document_id === d.id ? "selected" : ""}>People who can open "${esc(d.title)}"</option>`).join("")}</select>
        <div class="form-grid"><div><label for="qzP">Pass mark (%)</label><input id="qzP" type="number" min="0" max="100" value="${z?.pass_percent ?? 60}"></div></div>
        <label class="row" style="gap:8px;font-weight:400;margin-top:14px"><input type="checkbox" id="qzOne" style="width:auto;margin:0" ${z?.one_attempt ? "checked" : ""}> One try only</label>
        <label class="row" style="gap:8px;font-weight:400;margin-top:8px"><input type="checkbox" id="qzShow" style="width:auto;margin:0" ${z ? (z.show_answers ? "checked" : "") : "checked"}> Show correct answers after they submit</label>
        <label class="row" style="gap:8px;font-weight:400;margin-top:8px"><input type="checkbox" id="qzOn" style="width:auto;margin:0" ${z ? (z.is_active ? "checked" : "") : "checked"}> Showing in the app</label>
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">${z ? "Save" : "Create quiz"}</button></div>`,
      async () => {
        const row = { title: $("#qzT").value.trim(), description: $("#qzD").value.trim() || null, document_id: $("#qzDoc").value || null,
          pass_percent: Math.min(100, Math.max(0, Number($("#qzP").value) || 0)), one_attempt: $("#qzOne").checked, show_answers: $("#qzShow").checked, is_active: $("#qzOn").checked };
        if (z) { const { error } = await sb.from("quizzes").update(row).eq("id", z.id); if (error) throw error; dlg.close(); toast("Saved"); await refresh(); return; }
        const { data, error } = await sb.from("quizzes").insert(row).select("id").single();
        if (error) throw error;
        dlg.close(); toast("Quiz created. Add questions next."); await refresh(); location.hash = `quiz/${data.id}`;
      });
  }
  function quizDetail(id) {
    const z = S.quizzes.find(x => x.id === id);
    if (!z) { view.innerHTML = head("Quiz not found", "It may have been deleted.", "", backLink("#quizzes", "Quizzes")); return; }
    const Q = z.quiz_questions.slice().sort((a, b) => a.sort_order - b.sort_order);
    const st = quizStats(z);
    const L = "ABCDEF";
    view.innerHTML = `
      ${head(z.title, `${z.document_id ? `For people who can open "${esc(docTitle(z.document_id))}"` : "Anyone signed in"} · pass mark ${z.pass_percent}%${z.one_attempt ? " · one try" : ""}${z.is_active ? "" : " · <strong>hidden</strong>"}`,
        `<button type="button" data-act="settings">Settings</button><button type="button" class="danger" data-act="delQuiz">Delete</button>`, backLink("#quizzes", "Quizzes"))}
      <div class="kpis">
        ${kpi("Questions", Q.length, Q.length ? "" : "Add at least one")}
        ${kpi("People", st.people, `${z.quiz_attempts.length} ${z.quiz_attempts.length === 1 ? "attempt" : "attempts"}`)}
        ${kpi("Passed", st.people ? `${st.passed} of ${st.people}` : "–", `${z.pass_percent}% or more`)}
        ${kpi("Average best score", st.avg == null ? "–" : `${st.avg}%`, "")}
      </div>
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Questions</h2><button class="small primary" type="button" data-act="addQ">Add question</button></div>
          ${Q.length ? `<ol class="q-list">${Q.map((q, i) => {
            const wrong = z.quiz_attempts.filter(a => a.answers && a.answers[q.id] !== undefined && a.answers[q.id] !== q.correct).length;
            return `<li><div class="q-prompt">${esc(q.prompt)}</div>
            <ul class="q-opts">${q.options.map((o, k) => `<li class="${k === q.correct ? "right" : ""}"><span>${L[k]}</span>${esc(o)}</li>`).join("")}</ul>
            ${q.explanation ? `<p class="hint">${esc(q.explanation)}</p>` : ""}
            <div class="row"><button class="small" type="button" data-editq="${q.id}">Edit</button>
              <button class="small ghost" type="button" data-mvq="${i}" data-dir="-1" ${i ? "" : "disabled"} aria-label="Move up">↑</button>
              <button class="small ghost" type="button" data-mvq="${i}" data-dir="1" ${i < Q.length - 1 ? "" : "disabled"} aria-label="Move down">↓</button>
              <button class="small ghost" type="button" data-delq="${q.id}">Delete</button>
              <span class="spacer"></span>${z.quiz_attempts.length ? `<span class="muted small-text">${wrong} got it wrong</span>` : ""}</div></li>`; }).join("")}</ol>`
            : emptyState("No questions yet", "Add multiple-choice questions with 2 to 6 options.")}
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Results</h2>${st.people ? `<button class="small" type="button" data-act="csv">CSV</button>` : ""}</div>
          ${st.people ? `<div class="table-wrap"><table class="data"><tbody>${[...st.byEmail.entries()].map(([email, l]) => {
            const best = l.reduce((b, a) => (a.score / a.total > b.score / b.total ? a : b), l[0]);
            return `<tr><td><a href="#person/${encodeURIComponent(email)}">${esc(nameOf(email))}</a><div class="cell-sub">${l.length} ${l.length === 1 ? "try" : "tries"}, last ${esc(timeAgo(l[0].created_at))}</div></td>
              <td class="num">${best.score}/${best.total}</td><td>${l.some(a => a.passed) ? `<span class="tag live">Passed</span>` : `<span class="tag warn">Not yet</span>`}</td>
              <td class="num">${z.one_attempt ? `<button class="small ghost" type="button" data-retry="${esc(email)}" title="Delete their attempts so they can try again">Allow retry</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>`
            : emptyState("No attempts yet", "Results show up here once people take the quiz in the app.")}
        </div>
      </div>`;
    const act = n => $(`[data-act="${n}"]`, view);
    act("settings").onclick = () => quizDialog(z);
    act("addQ").onclick = () => questionDialog(z, null);
    act("delQuiz").onclick = () => confirmDialog({ title: `Delete "${z.title}"?`, text: "Its questions and results are deleted too.", confirm: "Delete quiz", danger: true,
      run: async () => { const { error } = await sb.from("quizzes").delete().eq("id", z.id); if (error) throw error; toast("Quiz deleted"); location.hash = "quizzes"; await refresh(); } });
    if (act("csv")) act("csv").onclick = () => downloadCsv([["Email", "Name", "Score", "Total", "Passed", "When"], ...z.quiz_attempts.map(a => [a.email, nameOf(a.email), a.score, a.total, a.passed ? "yes" : "no", a.created_at])], `${z.title}-results.csv`);
    $$("[data-editq]", view).forEach(b => b.onclick = () => questionDialog(z, Q.find(q => q.id === b.dataset.editq)));
    $$("[data-delq]", view).forEach(b => b.onclick = async () => { const { error } = await sb.from("quiz_questions").delete().eq("id", b.dataset.delq); if (error) return toast(error.message); toast("Question deleted"); await refresh(); });
    $$("[data-mvq]", view).forEach(b => b.onclick = async () => {
      const list = Q.slice(), i = Number(b.dataset.mvq), j = i + Number(b.dataset.dir);
      [list[i], list[j]] = [list[j], list[i]];
      const res = await Promise.all(list.map((q, k) => q.sort_order === k ? null : sb.from("quiz_questions").update({ sort_order: k }).eq("id", q.id)).filter(Boolean));
      const err = res.find(r => r.error); if (err) return toast(err.error.message); await refresh();
    });
    $$("[data-retry]", view).forEach(b => b.onclick = async () => {
      const { error } = await sb.from("quiz_attempts").delete().eq("quiz_id", z.id).eq("email", b.dataset.retry);
      if (error) return toast(error.message); toast("They can take it again"); await refresh();
    });
  }
  function questionDialog(z, q) {
    const opts = q ? q.options.slice() : ["", "", "", ""];
    while (opts.length < 6) opts.push("");
    openDialog(`
      <div class="dlg-head"><h2>${q ? "Edit question" : "Add question"}</h2><p class="sub" style="margin:6px 0 0">Fill in 2 to 6 options and pick the right one.</p></div>
      <div class="dlg-body">
        <label for="qP">Question</label><textarea id="qP" rows="3" required maxlength="1000">${esc(q?.prompt || "")}</textarea>
        <label>Options</label>
        <div class="q-edit">${opts.map((o, k) => `<label class="row" style="margin:0;gap:8px;font-weight:400;flex-wrap:nowrap">
          <input type="radio" name="qC" value="${k}" style="width:auto;margin:0" ${q ? (q.correct === k ? "checked" : "") : k === 0 ? "checked" : ""} aria-label="Option ${"ABCDEF"[k]} is correct">
          <span class="muted" style="width:14px">${"ABCDEF"[k]}</span><input type="text" data-opt="${k}" maxlength="300" value="${esc(o)}" placeholder="${k < 2 ? "Required" : "Optional"}"></label>`).join("")}</div>
        <p class="hint">The selected circle marks the correct answer.</p>
        <label for="qE">Explanation (optional)</label><input id="qE" type="text" maxlength="1000" value="${esc(q?.explanation || "")}" placeholder="Shown after they submit">
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Save</button></div>`,
      async () => {
        const raw = $$("[data-opt]", dlg).map(i => i.value.trim());
        const chosen = Number($('input[name="qC"]:checked', dlg)?.value ?? 0);
        if (!raw[chosen]) throw new Error("The correct answer can't be empty.");
        const keep = raw.map((t, k) => ({ t, k })).filter(x => x.t);
        if (keep.length < 2) throw new Error("Add at least two options.");
        const row = { prompt: $("#qP").value.trim(), options: keep.map(x => x.t), correct: keep.findIndex(x => x.k === chosen), explanation: $("#qE").value.trim() || null };
        const { error } = q ? await sb.from("quiz_questions").update(row).eq("id", q.id)
          : await sb.from("quiz_questions").insert({ ...row, quiz_id: z.id, sort_order: z.quiz_questions.length });
        if (error) throw error;
        dlg.close(); toast("Saved"); await refresh();
      });
  }

  // ---------------------------------------------------------------
  // Activity
  // ---------------------------------------------------------------
  function activity() {
    view.innerHTML = `
      ${head("Activity", "Every reading session, newest first.", `<button type="button" data-act="csv">Download CSV</button>`)}
      ${migrationNote()}
      <div class="panel">
        <div class="panel-head">
          <div class="row" style="flex:1">
            <select id="fDoc" style="max-width:260px" aria-label="Filter by document"><option value="">All documents</option>
              ${S.docs.map(d => `<option value="${d.id}">${esc(d.title)}</option>`).join("")}</select>
            <input type="search" id="fEmail" placeholder="Filter by email" style="max-width:240px" aria-label="Filter by email">
          </div>
          <span class="muted small-text" id="fCount"></span>
        </div>
        <div id="actTable"></div>
      </div>`;
    const filtered = () => {
      const doc = $("#fDoc").value, q = $("#fEmail").value.trim().toLowerCase();
      return S.sessions.filter(s => (!doc || s.document_id === doc) && (!q || s.email.includes(q)));
    };
    const draw = () => {
      const list = filtered();
      $("#fCount").textContent = `${list.length} ${list.length === 1 ? "session" : "sessions"}, ${fmtDuration(sum(list, s => s.seconds))}`;
      $("#actTable").innerHTML = sessionTable(list.slice(0, 300));
    };
    $("#fDoc").onchange = draw;
    $("#fEmail").oninput = draw;
    $('[data-act="csv"]').onclick = () => {
      const rows = [["started", "last_active", "email", "document", "seconds", "max_page", "page_count", "device"]]
        .concat(filtered().map(s => [s.started_at, s.last_seen_at, s.email, docTitle(s.document_id), s.seconds, s.max_page, s.page_count, s.device_label || ""]));
      const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `reading-activity-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    draw();
  }

  // ---------------------------------------------------------------
  // Blocked
  // ---------------------------------------------------------------
  function blocked() {
    view.innerHTML = `
      ${head("Blocked", "Blocked emails can't open any document, even if they're on its list.", `<button type="button" data-act="addBlock">Block an email</button>`)}
      ${migrationNote()}
      <div class="panel">
        ${S.blocked.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Email</th><th class="hide-sm">Reason</th><th>Blocked</th><th></th></tr></thead>
          <tbody>${S.blocked.map(b => `<tr>
            <td><a class="cell-title" href="#person/${encodeURIComponent(b.email)}">${esc(b.email)}</a></td>
            <td class="hide-sm muted">${esc(b.reason || "–")}</td>
            <td class="muted">${esc(timeAgo(b.blocked_at))}</td>
            <td class="num"><button class="small" type="button" data-unblock="${esc(b.email)}">Unblock</button></td></tr>`).join("")}</tbody></table></div>`
          : emptyState("Nobody is blocked", "Block someone from their page under People, or with the button above.")}
      </div>`;
    $('[data-act="addBlock"]').onclick = () => blockDialog("");
    $$("[data-unblock]", view).forEach(b => b.onclick = async () => {
      const { error } = await sb.from("blocked_emails").delete().eq("email", b.dataset.unblock);
      if (error) return toast(error.message);
      toast(`${b.dataset.unblock} unblocked`); await refresh();
    });
  }

  // ---------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------
  const inr = n => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const pctTxt = n => (n == null ? "–" : `${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`);
  const PAY_STATUS = { pending: ["warn", "Pending"], verified: ["live", "Verified"], rejected: ["off", "Rejected"] };
  const PAID_VIA = { gpay: "Google Pay", phonepe: "PhonePe", paytm: "Paytm", upi: "Other UPI app", qr: "Scanned QR", bank: "Bank transfer", other: "Other" };
  const payTag = s => { const [c, t] = PAY_STATUS[s] || PAY_STATUS.pending; return `<span class="tag ${c}">${t}</span>`; };
  const payDay = p => new Date(p.payout_date ? `${p.payout_date}T12:00:00` : p.created_at);
  // Weeks run up to the payment day (Wednesday unless the owner changes it).
  const cycle = d => window.App.payCycle(S.payDay, d);
  function weekStart(d) { return cycle(d).start; }
  const weekKey = d => cycle(d).key;

  // Things worth a second look on a submission.
  function payFlags(p) {
    const flags = [];
    const exp = S.expectedPercent;
    if (exp > 0 && Number(p.amount_earned) > 0) {
      const due = (Number(p.amount_earned) * exp) / 100;
      const short = Math.round((due - Number(p.amount_sent)) * 100) / 100;
      if (short > 0.5) flags.push({ cls: "warn", text: `Short by ${inr(short)}` });
    }
    if (p.utr && S.payments.some(x => x.id !== p.id && x.utr === p.utr)) flags.push({ cls: "", text: "UTR used twice" });
    const mine = [p.earnings_hash, p.referral_hash, p.payment_hash].filter(Boolean);
    const twin = mine.length && S.payments.find(x => x.id !== p.id && [x.earnings_hash, x.referral_hash, x.payment_hash].some(h => h && mine.includes(h)));
    if (twin) flags.push({ cls: "", text: twin.email === p.email ? "Same screenshot as an earlier submission" : `Same screenshot as ${twin.name}` });
    // Looks the same even if re-saved, cropped slightly or recompressed.
    const ph = [p.earnings_phash, p.referral_phash, p.payment_phash].filter(Boolean);
    if (!twin && ph.length) {
      const near = S.payments.find(x => x.id !== p.id && new Date(x.created_at) < new Date(p.created_at)
        && [x.earnings_phash, x.referral_phash, x.payment_phash].some(h => h && ph.some(m => hamming(m, h) <= 4)));
      if (near) flags.push({ cls: "", text: near.email === p.email ? "Screenshot looks like an earlier one" : `Screenshot looks like ${near.name}'s` });
    }
    return flags;
  }
  function hamming(a, b) {
    let d = 0;
    for (let i = 0; i < 16; i += 4) { let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16); while (x) { d += x & 1; x >>= 1; } }
    return d;
  }
  const flagsHTML = p => { const f = payFlags(p); return f.length ? `<div class="flags">${f.map(x => `<span class="flag ${x.cls}">${esc(x.text)}</span>`).join("")}</div>` : ""; };

  const PAY_TABS = [["", "Submissions"], ["dashboard", "Dashboard"], ["missing", "Missing"], ["settings", "Payment settings"], ["log", "Change log"]];
  const payTabs = active => `<nav class="tabs" aria-label="Payments">${PAY_TABS.map(([k, l]) =>
    `<a href="#payments${k ? "/" + k : ""}" ${k === active ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;

  function payments(tab = "", sub = "") {
    if (S.paymentsMissing) {
      view.innerHTML = `${head("Payments", "Payment submissions from your people.")}
        <div class="notice">Payments aren't switched on yet. Run <code>supabase/004_payments.sql</code> and then <code>supabase/005_payments_v2.sql</code> in the Supabase SQL Editor.</div>`;
      return;
    }
    const pages = { "": paySubmissions, dashboard: payDashboard, missing: payMissing, settings: paySettings, log: payLog };
    (pages[tab] || paySubmissions)(sub);
  }

  function v2Note() {
    return S.paymentsV2 ? "" : `<div class="notice" style="margin-bottom:16px">Run <code>supabase/005_payments_v2.sql</code> in Supabase to switch on payment accounts, UTR checks, the change log and the security rules.</div>`;
  }

  function paySubmissions() {
    const P = S.payments;
    const pending = P.filter(p => p.status === "pending");
    view.innerHTML = `
      ${head("Payments", "Submissions with earnings, referral and payment screenshots.", `<button type="button" data-act="payCsv">Download CSV</button>`)}
      ${payTabs("")}${v2Note()}
      <div class="panel">
        <div class="panel-head">
          <div class="row" style="flex:1">
            <select id="pStatus" style="width:auto" aria-label="Filter by status">
              <option value="">All statuses</option><option value="pending" ${pending.length ? "selected" : ""}>Pending</option><option value="verified">Verified</option><option value="rejected">Rejected</option></select>
            <label class="row small-text" style="margin:0;gap:6px;font-weight:400"><input type="checkbox" id="pFlagged"> Only flagged</label>
            <input type="search" id="pQ" placeholder="Search name, email, Outlier ID, UTR or referrer" style="max-width:340px" aria-label="Search payments">
          </div>
          <span class="muted small-text" id="pCount"></span>
        </div>
        <div id="payTable"></div>
      </div>`;
    const filtered = () => {
      const st = $("#pStatus").value, q = $("#pQ").value.trim().toLowerCase(), fl = $("#pFlagged").checked;
      return P.filter(p => (!st || p.status === st) && (!fl || payFlags(p).length) &&
        (!q || [p.name, p.email, p.outlier_id, p.referred_by, p.utr].some(v => String(v || "").toLowerCase().includes(q))));
    };
    const draw = () => {
      const list = filtered();
      $("#pCount").textContent = `${list.length} shown, ${inr(sum(list, p => Number(p.amount_sent)))} paid`;
      $("#payTable").innerHTML = list.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Payout</th><th>Person</th><th class="hide-sm">Outlier ID / UTR</th>
          <th class="num">Earned</th><th class="num">Paid</th><th class="num">Share</th><th>Status</th></tr></thead>
        <tbody>${list.map(p => `<tr class="clickable" tabindex="0" data-href="payment/${p.id}">
          <td class="muted">${esc(payDay(p).toLocaleDateString(undefined, { day: "numeric", month: "short" }))}<div class="cell-sub">sent ${esc(timeAgo(p.created_at))}</div></td>
          <td><div class="cell-title">${esc(p.name)}</div><div class="cell-sub">${esc(p.email)}</div>${flagsHTML(p)}</td>
          <td class="hide-sm">${esc(p.outlier_id)}<div class="cell-sub">${esc(p.utr || "No UTR")}</div></td>
          <td class="num">${inr(p.amount_earned)}</td><td class="num">${inr(p.amount_sent)}</td>
          <td class="num">${pctTxt(p.percent_sent)}</td>
          <td>${payTag(p.status)}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState(P.length ? "Nothing matches" : "No payments yet", P.length ? "Try another status or search." : "Submissions from the app appear here.");
      wireCommon();
    };
    ["pStatus", "pFlagged"].forEach(id => $(`#${id}`).onchange = draw);
    $("#pQ").oninput = draw;
    $('[data-act="payCsv"]').onclick = () => {
      const acc = id => S.accounts.find(a => a.id === id)?.label || "";
      const rows = [["submitted", "payout_date", "name", "email", "outlier_id", "referred_by", "amount_earned_inr", "amount_paid_inr", "percent", "paid_via", "paid_to", "utr", "status", "flags", "admin_note", "reviewed_by", "reviewed_at"]]
        .concat(filtered().map(p => [p.created_at, p.payout_date || "", p.name, p.email, p.outlier_id, p.referred_by || "", p.amount_earned, p.amount_sent,
          p.percent_sent ?? "", PAID_VIA[p.paid_via] || "", acc(p.account_id), p.utr || "", p.status, payFlags(p).map(f => f.text).join("; "),
          p.admin_note || "", p.reviewed_by || "", p.reviewed_at || ""]));
      downloadCsv(rows, `payments-${new Date().toISOString().slice(0, 10)}.csv`);
    };
    draw();
  }

  function payDashboard(mode = "") {
    const monthly = mode === "monthly";
    const live = S.payments.filter(p => p.status !== "rejected");
    const verified = S.payments.filter(p => p.status === "verified");
    const pending = S.payments.filter(p => p.status === "pending");
    const withPct = verified.filter(p => Number(p.amount_earned) > 0);
    const avgPct = withPct.length ? (sum(withPct, p => Number(p.amount_sent)) / sum(withPct, p => Number(p.amount_earned))) * 100 : null;

    const weeks = [];
    const thisWeek = weekStart(new Date());
    for (let i = 11; i >= 0; i--) { const d = new Date(thisWeek); d.setDate(d.getDate() - i * 7); const c = cycle(d); weeks.push({ key: c.key, d: c.end, v: 0 }); }
    live.forEach(p => { const w = weeks.find(x => x.key === weekKey(payDay(p))); if (w) w.v += Number(p.amount_sent); });
    const months = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); months.push({ key: d.toISOString().slice(0, 7), d, v: 0, e: 0 }); }
    const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    months.forEach(m => { m.key = monthKey(m.d); });
    live.forEach(p => { const m = months.find(x => x.key === monthKey(payDay(p))); if (m) { m.v += Number(p.amount_sent); m.e += Number(p.amount_earned); } });

    const byPerson = new Map();
    live.forEach(p => { const r = byPerson.get(p.email) || { name: p.name, earned: 0, paid: 0, n: 0 }; r.earned += Number(p.amount_earned); r.paid += Number(p.amount_sent); r.n++; byPerson.set(p.email, r); });
    const topEarners = [...byPerson.entries()].sort((a, b) => b[1].earned - a[1].earned).slice(0, 6);
    const byRef = new Map();
    live.filter(p => p.referred_by).forEach(p => {
      const k = p.referred_by.trim().toLowerCase();
      const r = byRef.get(k) || { label: p.referred_by.trim(), people: new Set(), earned: 0 };
      r.people.add(p.email); r.earned += Number(p.amount_earned); byRef.set(k, r);
    });
    const topRefs = [...byRef.values()].sort((a, b) => b.people.size - a.people.size || b.earned - a.earned).slice(0, 6);

    view.innerHTML = `
      ${head("Payments", "How much is coming in, and from whom.")}
      ${payTabs("dashboard")}
      <div class="kpis">
        ${kpi("Received (verified)", inr(sum(verified, p => Number(p.amount_sent))), `${verified.length} ${verified.length === 1 ? "payment" : "payments"}`)}
        ${kpi("Waiting for review", inr(sum(pending, p => Number(p.amount_sent))), `${pending.length} ${pending.length === 1 ? "submission" : "submissions"}`)}
        ${kpi("Average share paid", pctTxt(avgPct), S.expectedPercent ? `Expected ${S.expectedPercent}%` : "Of verified earnings")}
        ${kpi("People paying", byPerson.size, `${inr(sum([...byPerson.values()], r => r.earned))} earned in total`)}
      </div>
      <div class="panel" style="margin-bottom:16px">
        <div class="panel-head"><h2>Paid per ${monthly ? "month" : "week"}</h2>
          <div class="row"><span class="muted small-text hide-sm">Last 12 ${monthly ? "months" : "weeks"}, by payout date, pending and verified</span>
          <div class="seg" role="group" aria-label="Chart period"><a href="#payments/dashboard" ${monthly ? "" : 'aria-current="true"'}>Weekly</a><a href="#payments/dashboard/monthly" ${monthly ? 'aria-current="true"' : ""}>Monthly</a></div></div></div>
        <div class="panel-body"><div id="weekChart"></div>
          ${monthly ? `<details class="table-view"><summary>Show as a table</summary><div class="table-wrap"><table class="data"><thead><tr><th>Month</th><th class="num">Earned</th><th class="num">Paid</th><th class="num">Share</th></tr></thead>
          <tbody>${months.slice().reverse().map(m => `<tr><td>${esc(m.d.toLocaleDateString(undefined, { month: "long", year: "numeric" }))}</td><td class="num">${inr(m.e)}</td><td class="num">${inr(m.v)}</td><td class="num">${pctTxt(m.e ? (m.v / m.e) * 100 : null)}</td></tr>`).join("")}</tbody></table></div></details>` : ""}</div>
      </div>
      <div class="grid-2">
        <div class="panel"><div class="panel-head"><h2>Top earners</h2><span class="muted small-text">Earned, and paid</span></div>
          ${topEarners.length ? `<ul class="rank">${topEarners.map(([email, r]) => `<li><span><a href="#person/${encodeURIComponent(email)}">${esc(r.name)}</a>
            <span class="cell-sub">${r.n} ${r.n === 1 ? "payout" : "payouts"}</span></span>
            <span class="v">${inr(r.earned)}<span class="cell-sub" style="text-align:right">${inr(r.paid)} paid</span></span></li>`).join("")}</ul>`
            : emptyState("No payments yet", "Top earners show up here.")}</div>
        <div class="panel"><div class="panel-head"><h2>Top referrers</h2><span class="muted small-text">From "referred by"</span></div>
          ${topRefs.length ? `<ul class="rank">${topRefs.map(r => `<li><span>${esc(r.label)}<span class="cell-sub">${r.people.size} ${r.people.size === 1 ? "person" : "people"} referred</span></span>
            <span class="v">${inr(r.earned)}<span class="cell-sub" style="text-align:right">team earnings</span></span></li>`).join("")}</ul>`
            : emptyState("No referrals yet", "Shows once people fill in who referred them.")}</div>
      </div>`;
    const series = monthly
      ? months.map(m => ({ label: m.d.toLocaleDateString(undefined, { month: "short" }), value: m.v, tip: `${m.d.toLocaleDateString(undefined, { month: "long", year: "numeric" })}: ${inr(m.v)} paid of ${inr(m.e)} earned` }))
      : null;
    if (series) barChart($("#weekChart"), series, { fmt: v => v === 0 ? "0" : v >= 1000 ? `₹${Math.round(v / 100) / 10}k` : `₹${Math.round(v)}`, height: 200 });
    else barChart($("#weekChart"), weeks.map(w => ({ label: w.d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), value: w.v, tip: `Week to ${w.d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}: ${inr(w.v)}` })),
      { fmt: v => v === 0 ? "0" : v >= 1000 ? `₹${Math.round(v / 100) / 10}k` : `₹${Math.round(v)}`, height: 200 });
  }

  function payMissing() {
    // A submission counts for the week in which it was sent; each week ends on the payment day.
    const live = S.payments.filter(p => p.status !== "rejected");
    const now = cycle(new Date());
    const prevDay = new Date(now.start); prevDay.setDate(prevDay.getDate() - 1);
    const prev = cycle(prevDay);
    const keysBack = n => Array.from({ length: n }, (_, i) => { const d = new Date(prev.start); d.setDate(d.getDate() - 1 - i * 7); return cycle(d).key; });
    const earlier = new Set(keysBack(4)); // the 4 weeks before last week
    const sentIn = new Map(); // email -> Set(cycle keys)
    live.forEach(p => { const k = cycle(new Date(p.created_at)).key; if (!sentIn.has(p.email)) sentIn.set(p.email, new Set()); sentIn.get(p.email).add(k); });
    const nameFor = email => S.payments.find(p => p.email === email)?.name || nameOf(email);
    const lastPaid = email => S.payments.find(p => p.email === email && p.status !== "rejected");
    const regulars = [...sentIn.keys()].filter(e => !D.blocked.has(e));
    const missedLast = regulars.filter(e => !sentIn.get(e).has(prev.key) && [...sentIn.get(e)].some(k => earlier.has(k)));
    const dueNow = regulars.filter(e => !sentIn.get(e).has(now.key) && (sentIn.get(e).has(prev.key) || [...sentIn.get(e)].some(k => earlier.has(k))));
    const paidNow = regulars.filter(e => sentIn.get(e).has(now.key));
    const never = [...D.people.keys()].filter(e => !sentIn.has(e) && !D.blocked.has(e) && !S.payments.some(p => p.email === e)).sort();
    const daysLeft = Math.ceil((now.end - Date.now()) / 864e5);
    const dueText = daysLeft <= 1 ? (new Date().getDay() === S.payDay ? "today" : "tomorrow") : `in ${daysLeft} days`;
    const reminder = `Hi, a reminder that payments are due every ${now.dayName}. Please submit this week's payment by ${now.label} in the Pro AI Trainers app (Submit a payment).`;
    const list = (emails, note) => `<ul class="rank">${emails.map(e => { const l = lastPaid(e); return `<li><span><a href="#person/${encodeURIComponent(e)}">${esc(nameFor(e))}</a><span class="cell-sub">${esc(e)}</span></span>
      <span class="v">${l ? inr(l.amount_sent) : "–"}<span class="cell-sub" style="text-align:right">${l ? `last paid ${esc(timeAgo(l.created_at))}` : note}</span></span></li>`; }).join("")}</ul>`;

    view.innerHTML = `
      ${head("Payments", `Payments are due every ${now.dayName}. This week's is due ${esc(now.label)} (${dueText}).`)}
      ${payTabs("missing")}
      <div class="kpis">
        ${kpi("Paid this week", paidNow.length, `of ${paidNow.length + dueNow.length} regular payers`)}
        ${kpi("Not paid yet", dueNow.length, `Due ${esc(now.label)}`)}
        ${kpi(`Missed ${esc(prev.label)}`, missedLast.length, "Paid before, skipped last week")}
        ${kpi("Never submitted", never.length, "People with access or requests")}
      </div>
      <div class="grid-2">
        <div>
          <div class="panel">
            <div class="panel-head"><h2>Not paid yet this week</h2><span class="muted small-text">Week ${esc(now.start.toLocaleDateString(undefined, { day: "numeric", month: "short" }))} to ${esc(now.label)}</span></div>
            ${dueNow.length ? list(dueNow, "") : emptyState("Everyone's paid", "All regular payers have submitted this week.")}
          </div>
          <div class="panel section-gap">
            <div class="panel-head"><h2>Missed last ${esc(now.dayName)}</h2><span class="muted small-text">${esc(prev.label)}</span></div>
            ${missedLast.length ? list(missedLast, "") : emptyState("Nobody missed it", "Everyone who usually pays paid last week.")}
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Never submitted</h2><span class="muted small-text">People with access or requests</span></div>
          ${never.length ? `<ul class="rank">${never.slice(0, 200).map(e => `<li><a href="#person/${encodeURIComponent(e)}">${esc(nameOf(e))}</a></li>`).join("")}</ul>`
            : emptyState("No one missing", "Everyone with access has submitted at least once.")}
        </div>
      </div>
      <div class="panel section-gap"><div class="panel-body">
        <label for="remind" style="margin-top:0">Reminder message</label>
        <textarea id="remind" rows="3">${esc(reminder)}</textarea>
        <div class="row" style="margin-top:10px"><button type="button" class="primary" data-act="copyRemind">Copy</button>
          <a class="btn" target="_blank" rel="noopener" id="waRemind" href="https://wa.me/?text=${encodeURIComponent(reminder)}">WhatsApp</a>
          ${dueNow.length ? `<a class="btn" id="mailRemind" href="mailto:?bcc=${encodeURIComponent(dueNow.join(","))}&subject=${encodeURIComponent(`Payment due ${now.label}`)}&body=${encodeURIComponent(reminder)}">Email the ${dueNow.length} not paid yet</a>` : ""}</div>
      </div></div>`;
    $('[data-act="copyRemind"]').onclick = async () => { try { await navigator.clipboard.writeText($("#remind").value); toast("Message copied"); } catch { $("#remind").select(); } };
    $("#remind").oninput = () => {
      $("#waRemind").href = `https://wa.me/?text=${encodeURIComponent($("#remind").value)}`;
      const m = $("#mailRemind"); if (m) m.href = `mailto:?bcc=${encodeURIComponent(dueNow.join(","))}&subject=${encodeURIComponent(`Payment due ${now.label}`)}&body=${encodeURIComponent($("#remind").value)}`;
    };
  }


  function qrSvg(a) {
    if (!a.upi_id || !window.qrcode) return "";
    const q = window.qrcode(0, "M");
    q.addData(`upi://pay?${new URLSearchParams({ pa: a.upi_id, pn: a.payee_name, cu: "INR" }).toString().replace(/\+/g, "%20")}`);
    q.make();
    return q.createSvgTag({ cellSize: 3, margin: 1, scalable: true });
  }

  async function paySettings() {
    const owner = S.isOwner;
    view.innerHTML = `
      ${head("Payments", "Where people pay, and what you expect them to pay.",
        owner && S.paymentsV2 ? `<button class="primary" type="button" data-act="addAcct">Add payment account</button>` : "")}
      ${payTabs("settings")}${v2Note()}
      ${owner ? "" : `<div class="notice" style="margin-bottom:16px">Only the owner can change payment accounts and the expected share. You can view them.</div>`}
      <div class="panel" style="margin-bottom:16px">
        <div class="panel-head"><h2>Payment accounts</h2><span class="muted small-text">Shown to people in step 3 of the form</span></div>
        <div id="acctList"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Expected share</h2></div>
        <div class="panel-body row">
          <label for="expPct" style="margin:0">People should pay</label>
          <input id="expPct" type="number" min="0" max="100" step="0.5" value="${S.expectedPercent ?? ""}" style="width:110px" ${owner ? "" : "disabled"}>
          <span>% of what they earn</span>
          ${owner ? `<button type="button" data-act="saveExp">Save</button>` : ""}
        </div>
        <p class="hint" style="padding:0 18px 14px;margin:0">Submissions below this are flagged "Short by ₹…". Set 0 to turn the check off.</p>
      </div>
      <div class="panel section-gap">
        <div class="panel-head"><h2>Payment day</h2></div>
        <div class="panel-body row">
          <label for="payDay" style="margin:0">Payments are due every</label>
          <select id="payDay" style="width:auto" ${owner ? "" : "disabled"}>${window.App.DAY_NAMES.map((n, i) => `<option value="${i}" ${i === S.payDay ? "selected" : ""}>${n}</option>`).join("")}</select>
          ${owner ? `<button type="button" data-act="savePayDay">Save</button>` : ""}
        </div>
        <p class="hint" style="padding:0 18px 14px;margin:0">People see the due date in the app, and the Missing tab and weekly chart use weeks that end on this day.</p>
      </div>
      <div class="panel section-gap">
        <div class="panel-head"><h2>Google Sheet</h2><span class="muted small-text">${S.sheetKey ? `Connected since ${esc(fmtDate(S.sheetKey.created_at))}` : "Not connected"}</span></div>
        <div class="panel-body">
          <p class="small-text" style="margin:0">Keep a Google Sheet that fills itself every hour: one tab with every payment: date, name, email, earned, paid, % paid, paid via, UTR, status, and a "View screenshots" link that opens the payment in this dashboard. Screenshots themselves stay private.</p>
          ${owner ? `<div class="row" style="margin-top:12px"><button type="button" class="${S.sheetKey ? "" : "primary"}" data-act="sheetKey">${S.sheetKey ? "Make a new key and script" : "Connect a Google Sheet"}</button>
            ${S.sheetKey ? `<button type="button" class="ghost" data-act="sheetOff">Disconnect</button>` : ""}</div>` : `<p class="hint">Only the owner can connect a sheet.</p>`}
        </div>
      </div>`;

    const list = $("#acctList");
    list.innerHTML = S.accounts.length ? S.accounts.map(a => `
      <div class="acct">
        <div class="qr">${a.qrUrl ? `<img src="${esc(a.qrUrl)}" alt="">` : qrSvg(a)}</div>
        <div class="grow"><div class="cell-title">${esc(a.label)} ${a.is_active ? `<span class="tag live">Shown</span>` : `<span class="tag plain">Hidden</span>`}</div>
          <div class="cell-sub">${esc(a.payee_name)}${a.upi_id ? `, ${esc(a.upi_id)}` : ""}${a.qr_path ? ", own QR image" : ""}</div>
          ${a.instructions ? `<div class="cell-sub">${esc(a.instructions)}</div>` : ""}</div>
        ${owner ? `<div class="row"><button class="small" type="button" data-edit="${a.id}">Edit</button>
          <button class="small" type="button" data-toggle="${a.id}">${a.is_active ? "Hide" : "Show"}</button>
          <button class="small danger" type="button" data-del="${a.id}">Delete</button></div>` : ""}
      </div>`).join("") : emptyState("No payment accounts yet", owner ? "Add your UPI ID so people can pay from the form." : "The owner hasn't added any yet.");

    if (!owner) return;
    const addBtn = $('[data-act="addAcct"]'); if (addBtn) addBtn.onclick = () => acctDialog(null);
    $$("[data-edit]", view).forEach(b => b.onclick = () => acctDialog(S.accounts.find(a => a.id === b.dataset.edit)));
    $$("[data-toggle]", view).forEach(b => b.onclick = async () => {
      const a = S.accounts.find(x => x.id === b.dataset.toggle);
      const { error } = await sb.from("payment_accounts").update({ is_active: !a.is_active }).eq("id", a.id);
      if (error) return toast(error.message);
      toast(a.is_active ? "Hidden from the form" : "Shown in the form"); await refresh();
    });
    $$("[data-del]", view).forEach(b => b.onclick = () => {
      const a = S.accounts.find(x => x.id === b.dataset.del);
      confirmDialog({ title: `Delete "${a.label}"?`, text: "People won't see it in the form any more. Past submissions keep their record of what was paid.", confirm: "Delete account", danger: true,
        run: async () => {
          if (a.qr_path) await sb.storage.from("payment-qr").remove([a.qr_path]);
          const { error } = await sb.from("payment_accounts").delete().eq("id", a.id);
          if (error) throw error;
          toast("Account deleted"); await refresh();
        } });
    });
    const sk = $('[data-act="sheetKey"]');
    if (sk) sk.onclick = () => S.sheetKey
      ? confirmDialog({ title: "Make a new key?", text: "The script in your current sheet stops working until you paste the new script into it.", confirm: "Make new key", run: async () => { dlg.close(); await sheetSetup(); } })
      : sheetSetup();
    const so = $('[data-act="sheetOff"]');
    if (so) so.onclick = () => confirmDialog({ title: "Disconnect the Google Sheet?", text: "The sheet keeps what it already has but stops updating.", confirm: "Disconnect", danger: true,
      run: async () => { const { error } = await sb.from("app_settings").delete().eq("key", "sheet_token"); if (error) throw error; toast("Sheet disconnected"); await refresh(); } });
    const saveDay = $('[data-act="savePayDay"]');
    if (saveDay) saveDay.onclick = async () => {
      const v = Number($("#payDay").value);
      const { error } = await sb.from("app_settings").upsert({ key: "payment_day", value: v, updated_at: new Date().toISOString() });
      if (error) return toast(error.message);
      toast(`Payments are now due every ${window.App.DAY_NAMES[v]}`); await refresh();
    };
    const save = $('[data-act="saveExp"]');
    if (save) save.onclick = async () => {
      const v = Number($("#expPct").value);
      if (!(v >= 0 && v <= 100)) return toast("Enter a percentage from 0 to 100.");
      const { error } = await sb.from("app_settings").upsert({ key: "expected_percent", value: v, updated_at: new Date().toISOString() });
      if (error) return toast(error.message);
      toast(v ? `Expected share set to ${v}%` : "Short-payment check turned off"); await refresh();
    };
  }

  function acctDialog(a) {
    openDialog(`
      <div class="dlg-head"><h2>${a ? "Edit payment account" : "Add payment account"}</h2>
        <p class="sub" style="margin:6px 0 0">People see these details in the payment form. Every change is recorded in the change log.</p></div>
      <div class="dlg-body">
        <label for="aLabel">Name for this account</label>
        <input id="aLabel" type="text" required maxlength="60" placeholder="e.g. Main UPI" value="${esc(a?.label || "")}">
        <label for="aPayee">Payee name, exactly as your UPI app shows it</label>
        <input id="aPayee" type="text" required maxlength="80" value="${esc(a?.payee_name || "")}">
        <label for="aUpi">UPI ID</label>
        <input id="aUpi" type="text" maxlength="200" placeholder="name@okaxis" autocomplete="off" value="${esc(a?.upi_id || "")}">
        <label for="aQr">Your own QR image (optional)</label>
        <div class="file-drop"><input id="aQr" type="file" accept="image/png,image/jpeg,image/webp"></div>
        <p class="hint">Without one, a QR is made from the UPI ID with the amount built in.${a?.qr_path ? ` <label class="row" style="display:inline-flex;margin:0;gap:6px;font-weight:400"><input type="checkbox" id="aQrRemove"> Remove the current QR image</label>` : ""}</p>
        <label for="aInstr">Instructions (optional)</label>
        <input id="aInstr" type="text" maxlength="400" placeholder="e.g. Add your Outlier ID in the payment note" value="${esc(a?.instructions || "")}">
        <label for="aSort">Order</label>
        <input id="aSort" type="number" step="1" style="width:110px" value="${a?.sort_order ?? S.accounts.length}">
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">${a ? "Save changes" : "Add account"}</button></div>`,
      async () => {
        const upi = $("#aUpi").value.trim();
        if (upi && !/^[A-Za-z0-9._-]{2,128}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(upi)) throw new Error("That doesn't look like a UPI ID. It should look like name@bank.");
        const file = $("#aQr").files[0];
        let qr_path = a?.qr_path || null;
        if ($("#aQrRemove")?.checked) qr_path = null;
        if (file) {
          if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("The QR image must be PNG, JPG or WebP.");
          qr_path = `${crypto.randomUUID()}.${file.type.split("/")[1].replace("jpeg", "jpg")}`;
          const up = await sb.storage.from("payment-qr").upload(qr_path, file, { contentType: file.type, upsert: false });
          if (up.error) throw up.error;
        }
        if (!upi && !qr_path) throw new Error("Add a UPI ID or a QR image.");
        const row = { label: $("#aLabel").value.trim(), payee_name: $("#aPayee").value.trim(), upi_id: upi || null, qr_path,
          instructions: $("#aInstr").value.trim() || null, sort_order: Number($("#aSort").value) || 0 };
        const { error } = a ? await sb.from("payment_accounts").update(row).eq("id", a.id) : await sb.from("payment_accounts").insert(row);
        if (error) throw error;
        if (a?.qr_path && a.qr_path !== qr_path) await sb.storage.from("payment-qr").remove([a.qr_path]);
        dlg.close(); toast(a ? "Account updated" : "Account added"); await refresh();
      });
  }

  function auditSummary(r) {
    const o = r.old_data || {}, n = r.new_data || {};
    const changed = Object.keys({ ...o, ...n }).filter(k => !["updated_at", "created_at"].includes(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k]));
    const fmt = v => (v === null || v === undefined || v === "" ? "empty" : typeof v === "object" ? JSON.stringify(v) : String(v));
    if (r.table_name === "payment_accounts") {
      const name = n.label || o.label || "account";
      if (r.action === "insert") return `Added payment account "${name}" (${fmt(n.upi_id)}, ${fmt(n.payee_name)})`;
      if (r.action === "delete") return `Deleted payment account "${name}" (${fmt(o.upi_id)})`;
      return `Changed payment account "${name}": ${changed.map(k => `${k.replace(/_/g, " ")} ${fmt(o[k])} → ${fmt(n[k])}`).join(", ")}`;
    }
    if (r.table_name === "payment_submissions") {
      const who = n.name || o.name || "someone";
      if (r.action === "delete") return `Deleted the ${inr(o.amount_sent)} submission from ${who}`;
      if (changed.includes("status")) return `${n.status === "verified" ? "Verified" : n.status === "rejected" ? "Rejected" : "Moved back to pending"} the ${inr(n.amount_sent)} submission from ${who}${n.admin_note ? ` (note: ${n.admin_note})` : ""}`;
      return `Edited the submission from ${who}: ${changed.join(", ")}`;
    }
    if (r.table_name === "app_settings") return `Set ${String(n.key || o.key).replace(/_/g, " ")} to ${fmt(n.value)}${o.value !== undefined ? ` (was ${fmt(o.value)})` : ""}`;
    if (r.table_name === "admins") {
      if (r.action === "insert") return `Made ${n.email} an ${n.role || "admin"}`;
      if (r.action === "delete") return `Removed ${o.email} as ${o.role || "admin"}`;
      return `Changed ${n.email}'s role ${fmt(o.role)} → ${fmt(n.role)}`;
    }
    const row = r.action === "delete" ? o : n;
    const docName = id => D.doc.get(id)?.title || o.title || n.title || "a document";
    const grpName = id => S.groups.find(g => g.id === id)?.name || "a group";
    const verb = r.action === "insert" ? "Added" : r.action === "delete" ? "Removed" : "Changed";
    switch (r.table_name) {
      case "documents": return r.action === "insert" ? `Shared "${n.title}"` : r.action === "delete" ? `Deleted "${o.title}"` : `Changed "${n.title}": ${changed.filter(k => k !== "storage_path").map(k => k.replace(/_/g, " ")).join(", ") || "replaced the PDF"}`;
      case "document_access": return `${r.action === "insert" ? "Gave" : "Removed"} ${row.email} ${r.action === "insert" ? "access to" : "from"} "${docName(row.document_id)}"`;
      case "blocked_emails": return r.action === "insert" ? `Blocked ${n.email}${n.reason ? ` (${n.reason})` : ""}` : `Unblocked ${o.email}`;
      case "people": return `${verb} profile of ${row.email}${r.action === "update" ? `: ${changed.map(k => k.replace(/_/g, " ")).join(", ")}` : ""}`;
      case "groups": return `${verb} group "${row.name}"`;
      case "group_members": return `${r.action === "insert" ? "Added" : "Removed"} ${row.email} ${r.action === "insert" ? "to" : "from"} ${grpName(row.group_id)}`;
      case "group_documents": return `${r.action === "insert" ? "Shared" : "Unshared"} "${docName(row.document_id)}" ${r.action === "insert" ? "with" : "from"} ${grpName(row.group_id)}`;
      case "access_requests": return r.action === "delete" ? `Deleted access request from ${o.email}` : `${n.status === "approved" ? "Approved" : n.status === "declined" ? "Declined" : "Changed"} access request from ${n.email}`;
      case "document_views": return r.action === "delete" ? `Reset views of "${docName(o.document_id)}" for ${o.email}` : `Gave ${n.email} ${n.allowed} ${n.allowed === 1 ? "view" : "views"} of "${docName(n.document_id)}"`;
      case "announcements": return `${verb} announcement "${row.title}"`;
      case "faqs": return `${verb} help question "${row.question}"`;
      case "feedback": return r.action === "delete" ? `Deleted feedback from ${o.email}` : changed.includes("admin_reply") ? `Replied to ${n.email}'s feedback` : `Marked ${n.email}'s feedback ${n.status}`;
      case "device_locks": return r.action === "delete" ? `Reset the phone lock for ${o.email}` : `Moved ${n.email}'s phone lock to ${n.device_label || "a new phone"}`;
      case "device_requests": return `${n.status === "approved" ? "Allowed" : n.status === "declined" ? "Declined" : "Changed"} ${row.email}'s new phone (${row.device_label || "Android"})`;
    }
    return `${r.action} on ${r.table_name}`;
  }

  function payLog() {
    const L = S.audit.filter(r => ["payment_accounts", "payment_submissions", "app_settings", "admins"].includes(r.table_name));
    view.innerHTML = `
      ${head("Payments", `Every change to payment accounts, reviews, settings and admins. Recorded by the database, can't be edited. Changes to everything else are in <a href="#security/log">Security, Change log</a>.`)}
      ${payTabs("log")}${v2Note()}
      <div class="panel">${L.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>When</th><th>Who</th><th>What happened</th></tr></thead>
        <tbody>${L.map(r => {
          const money = r.table_name === "payment_accounts" || r.table_name === "admins";
          return `<tr><td class="muted">${esc(fmtDate(r.at))}</td><td>${esc(r.actor)}</td>
            <td style="white-space:normal">${money ? `<span class="flag warn">Payment details</span> ` : ""}${esc(auditSummary(r))}</td></tr>`;
        }).join("")}</tbody></table></div>` : emptyState("Nothing recorded yet", "Changes appear here as they happen.")}</div>`;
  }

  async function paymentDetail(id) {
    const p = S.payments.find(x => x.id === id);
    if (!p) { view.innerHTML = head("Payment not found", "It may have been deleted.", "", backLink("#payments", "Payments")); return; }
    const others = S.payments.filter(x => x.email === p.email && x.id !== p.id);
    const acct = S.accounts.find(a => a.id === p.account_id);
    const flags = payFlags(p);
    const exp = S.expectedPercent;
    const shots = [["Earnings (payouts)", p.earnings_path], ["Referral", p.referral_path], ["Payment successful", p.payment_path]].filter(s => s[1]);
    view.innerHTML = `
      ${head(`${p.name}`, `${payTag(p.status)}&nbsp; Submitted ${esc(fmtDate(p.created_at))}${p.reviewed_at ? `, reviewed ${esc(fmtDate(p.reviewed_at))} by ${esc(p.reviewed_by || "admin")}` : ""}`,
        `<button type="button" class="danger" data-act="payDelete">Delete</button>`, backLink("#payments", "Payments"))}
      ${flags.length ? `<div class="notice" style="margin-bottom:16px;border-style:solid;color:var(--ink-2)"><strong>Check this one:</strong> ${flags.map(f => esc(f.text)).join(", ")}.</div>` : ""}
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Screenshots</h2><span class="muted small-text">Tap to open full size</span></div>
          <div class="panel-body"><div class="proofs">
            ${shots.map((s, i) => `<figure><figcaption>${s[0]}</figcaption><a target="_blank" rel="noopener noreferrer" id="pf${i}"><p class="muted small-text" style="padding:16px">Loading…</p></a></figure>`).join("")}
          </div></div>
        </div>
        <div>
          <div class="panel">
            <div class="panel-head"><h2>Details</h2></div>
            <div class="panel-body"><dl class="facts">
              <dt>Name</dt><dd>${esc(p.name)}</dd>
              <dt>Email</dt><dd><a href="#person/${encodeURIComponent(p.email)}">${esc(p.email)}</a></dd>
              <dt>Outlier ID</dt><dd>${esc(p.outlier_id)}</dd>
              <dt>Referred by</dt><dd>${esc(p.referred_by || "–")}</dd>
              <dt>Payout date</dt><dd>${p.payout_date ? esc(new Date(`${p.payout_date}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })) : "–"}</dd>
              <dt>Amount earned</dt><dd>${inr(p.amount_earned)}</dd>
              <dt>Amount paid</dt><dd><strong>${inr(p.amount_sent)}</strong> (${pctTxt(p.percent_sent)}${exp ? `, expected ${exp}% = ${inr((Number(p.amount_earned) * exp) / 100)}` : ""})</dd>
              <dt>Paid using</dt><dd>${esc(PAID_VIA[p.paid_via] || "–")}${acct ? ` to ${esc(acct.label)} (${esc(acct.upi_id || "QR")})` : ""}</dd>
              <dt>UTR</dt><dd>${p.utr ? `<code>${esc(p.utr)}</code> <button class="small ghost" type="button" data-copy-utr>Copy</button>` : "–"}</dd>
              <dt>Other submissions</dt><dd>${others.length ? `${others.length}, ${inr(sum(others, x => Number(x.amount_sent)))} paid in total` : "None"}</dd>
            </dl>
            <p class="hint" style="margin-top:12px">Check the UTR and amount in your UPI or bank history before verifying. Screenshots can be edited.</p></div>
          </div>
          <div class="panel section-gap">
            <div class="panel-head"><h2>Review</h2></div>
            <div class="panel-body">
              <label for="payNote" style="margin-top:0">Note to the person (optional)</label>
              <textarea id="payNote" rows="3" style="min-height:72px" placeholder="e.g. Payment not received for this UTR">${esc(p.admin_note || "")}</textarea>
              <div class="row" style="margin-top:12px">
                <button type="button" class="primary" data-review="verified">Mark verified</button>
                <button type="button" class="danger" data-review="rejected">Reject</button>
                ${p.status !== "pending" ? `<button type="button" class="ghost" data-review="pending">Move back to pending</button>` : ""}
              </div>
              <p class="hint">They see the status and your note in the app. Verified payments can't have their amounts or UTR changed.</p>
            </div>
          </div>
        </div>
      </div>`;

    const cu = $("[data-copy-utr]", view);
    if (cu) cu.onclick = async () => { try { await navigator.clipboard.writeText(p.utr); toast("UTR copied"); } catch { toast(p.utr); } };
    $$("[data-review]", view).forEach(b => b.onclick = async () => {
      const status = b.dataset.review;
      const note = $("#payNote").value.trim() || null;
      const { error } = await sb.from("payment_submissions").update({
        status, admin_note: note,
        reviewed_by: status === "pending" ? null : user.email,
        reviewed_at: status === "pending" ? null : new Date().toISOString()
      }).eq("id", p.id);
      if (error) return toast(error.message);
      toast(status === "verified" ? "Marked verified" : status === "rejected" ? "Rejected" : "Moved back to pending");
      const next = S.payments.find(x => x.status === "pending" && x.id !== p.id);
      await refresh();
      if (status !== "pending" && next) location.hash = `payment/${next.id}`;
    });
    $('[data-act="payDelete"]').onclick = () => confirmDialog({
      title: `Delete this submission from ${p.name}?`,
      text: "The submission and its screenshots are removed for good. The change log keeps a record that it was deleted.",
      confirm: "Delete submission", danger: true,
      run: async () => {
        await sb.storage.from("payment-proofs").remove(shots.map(s => s[1]));
        const { error } = await sb.from("payment_submissions").delete().eq("id", p.id);
        if (error) throw error;
        toast("Submission deleted");
        location.hash = "payments";
        await refresh();
      }
    });

    // Short-lived links to the private screenshots.
    const { data } = await sb.storage.from("payment-proofs").createSignedUrls(shots.map(s => s[1]), 600);
    shots.forEach((s, i) => {
      const a = $(`#pf${i}`, view); if (!a) return;
      const url = data?.[i]?.signedUrl;
      if (url) { a.href = url; a.innerHTML = `<img src="${esc(url)}" alt="${esc(s[0])} screenshot">`; }
      else a.innerHTML = `<p class="muted small-text" style="padding:16px">Screenshot not found.</p>`;
    });
  }

  function downloadCsv(rows, filename) {
    const csv = "\ufeff" + rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ---------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------
  const dlg = $("#dlg");
  function openDialog(html, onSubmit) {
    dlg.innerHTML = `<form method="dialog" id="dlgForm">${html}</form>`;
    dlg.showModal();
    $$("[data-close]", dlg).forEach(b => b.onclick = e => { e.preventDefault(); dlg.close(); });
    $("#dlgForm").onsubmit = async e => {
      e.preventDefault();
      const btn = e.submitter || $('button[type="submit"]', dlg);
      const msg = $(".dlg-msg", dlg);
      btn.disabled = true;
      try { await onSubmit(btn, msg); }
      catch (err) { msg.className = "msg err dlg-msg"; msg.textContent = err.message || String(err); btn.disabled = false; }
    };
  }

  function openUpload() {
    openDialog(`
      <div class="dlg-head"><h2>Share a document</h2><p class="sub" style="margin:6px 0 0">PDF only, up to 50 MB. Only the email IDs you add can open it, in the Android app.</p></div>
      <div class="dlg-body">
        <label for="uTitle">Title</label>
        <input id="uTitle" type="text" required maxlength="200" placeholder="e.g. Onboarding guide v2">
        <label for="uFile">PDF file</label>
        <div class="file-drop"><input id="uFile" type="file" accept="application/pdf" required></div>
        <label for="uEmails">Who can open it</label>
        <textarea id="uEmails" placeholder="Paste email IDs, separated by commas or new lines"></textarea>
        <label for="uExp">Stop sharing on (optional)</label>
        <input id="uExp" type="datetime-local">
        ${docOptionsHTML()}
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Upload and share</button></div>`,
      async (btn, msg) => {
        const file = $("#uFile").files[0];
        const title = $("#uTitle").value.trim();
        const { valid, invalid } = parseEmails($("#uEmails").value);
        const exp = $("#uExp").value;
        if (!file || file.type !== "application/pdf") throw new Error("Choose a PDF file.");
        if (invalid.length) throw new Error(`Check these email IDs: ${invalid.join(", ")}`);
        msg.className = "msg dlg-msg"; msg.textContent = "Uploading…";
        const path = `${crypto.randomUUID()}.pdf`;
        const up = await sb.storage.from("documents").upload(path, file, { contentType: "application/pdf", upsert: false });
        if (up.error) throw up.error;
        const { data: doc, error } = await sb.from("documents")
          .insert({ title, storage_path: path, expires_at: exp ? new Date(exp).toISOString() : null, ...docOptionsValue() }).select("id").single();
        if (error) { await sb.storage.from("documents").remove([path]); throw error; }
        if (valid.length) {
          const { error: aErr } = await sb.from("document_access").insert(valid.map(email => ({ document_id: doc.id, email })));
          if (aErr) throw aErr;
        }
        dlg.close();
        toast(`Shared with ${valid.length} ${valid.length === 1 ? "person" : "people"}`);
        await refresh();
        location.hash = `doc/${doc.id}`;
      });
  }

  function openEdit(d) {
    const local = d.expires_at ? new Date(new Date(d.expires_at).getTime() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "";
    openDialog(`
      <div class="dlg-head"><h2>Edit document</h2></div>
      <div class="dlg-body">
        <label for="eTitle">Title</label>
        <input id="eTitle" type="text" required maxlength="200" value="${esc(d.title)}">
        <label for="eExp">Stop sharing on</label>
        <input id="eExp" type="datetime-local" value="${local}">
        <p class="hint">Leave empty to share until you turn the link off.</p>
        ${docOptionsHTML(d)}
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Save changes</button></div>`,
      async () => {
        const exp = $("#eExp").value;
        const { error } = await sb.from("documents")
          .update({ title: $("#eTitle").value.trim(), expires_at: exp ? new Date(exp).toISOString() : null, ...docOptionsValue() }).eq("id", d.id);
        if (error) throw error;
        dlg.close(); toast("Changes saved"); await refresh();
      });
  }

  function replacePdf(d) {
    const input = $("#replaceFile");
    input.value = "";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.type !== "application/pdf") return toast("Choose a PDF file.");
      toast("Uploading new version…");
      const path = `${crypto.randomUUID()}.pdf`;
      const up = await sb.storage.from("documents").upload(path, file, { contentType: "application/pdf", upsert: false });
      if (up.error) return toast(up.error.message);
      const { error } = await sb.from("documents").update({ storage_path: path }).eq("id", d.id);
      if (error) { await sb.storage.from("documents").remove([path]); return toast(error.message); }
      await sb.storage.from("documents").remove([d.storage_path]);
      toast("PDF replaced. The link and access list stay the same.");
      await refresh();
    };
    input.click();
  }

  // Google Sheet: make a secret key, keep only its fingerprint, and hand over a ready script.
  async function sheetSetup() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, "0")).join("");
    const { error } = await sb.from("app_settings").upsert({ key: "sheet_token", value: { hash, created_at: new Date().toISOString() }, updated_at: new Date().toISOString() });
    if (error) return toast(/payments_by_day|does not exist/.test(error.message) ? "Run supabase/011_sheet_export.sql first." : error.message);
    const script = sheetScript(token);
    openDialog(`
      <div class="dlg-head"><h2>Connect your Google Sheet</h2><p class="sub" style="margin:6px 0 0">This key is shown only once. Copy the script now.</p></div>
      <div class="dlg-body">
        <ol class="steps-list">
          <li>Open your Google Sheet (or make a new one), then <strong>Extensions → Apps Script</strong>.</li>
          <li>Delete what's there, paste the script below, and click <strong>Save</strong>.</li>
          <li>At the top, pick <strong>setupHourly</strong> and click <strong>Run</strong>. Allow access when Google asks (it's your own script).</li>
          <li>A tab called <strong>Payments</strong> appears and refreshes every hour.</li>
        </ol>
        <textarea id="shScript" rows="10" readonly style="font-family:ui-monospace,monospace;font-size:12px">${esc(script)}</textarea>
        <p class="hint">Keep this script and the sheet private: they show names, emails, amounts and UTRs. If the script leaks, make a new key here and the old one stops working.</p>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Done</button><button class="primary" type="button" data-act="copyScript">Copy script</button></div>`, async () => {});
    $('[data-act="copyScript"]', dlg).onclick = async () => { try { await navigator.clipboard.writeText(script); toast("Script copied"); } catch { $("#shScript").select(); } };
    dlg.addEventListener("close", () => refresh(), { once: true });
  }
  function sheetScript(token) {
    return `// Pro AI Trainers: payments by day. Paste into Extensions -> Apps Script.
// Run setupHourly once; after that the sheet updates itself every hour.
const API = ${JSON.stringify(cfg.supabaseUrl + "/rest/v1/rpc/")};
const ANON_KEY = ${JSON.stringify(cfg.supabaseAnonKey)};
const DASHBOARD = ${JSON.stringify(location.origin + location.pathname)};
const SHEET_KEY = ${JSON.stringify(token)};

function call(fn) {
  const res = UrlFetchApp.fetch(API + fn, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { apikey: ANON_KEY, Authorization: "Bearer " + ANON_KEY },
    payload: JSON.stringify({ token: SHEET_KEY, days: 365 })
  });
  if (res.getResponseCode() !== 200) throw new Error("Couldn't get payments: " + res.getContentText());
  return JSON.parse(res.getContentText());
}
function toDate(s) { if (!s) return ""; const p = String(s).slice(0, 10).split("-"); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
function toDateTime(s) { if (!s) return ""; const m = String(s).match(/(\\d+)-(\\d+)-(\\d+)[T ](\\d+):(\\d+)/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : s; }
function writeTab(name, head, data, formats) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight("bold");
  if (data.length) {
    sh.getRange(2, 1, data.length, head.length).setValues(data);
    formats.forEach(f => sh.getRange(2, f[0], data.length, f[1]).setNumberFormat(f[2]));
  }
  sh.getRange(1, head.length + 2).setValue("Last updated");
  sh.getRange(2, head.length + 2).setValue(new Date()).setNumberFormat("d mmm yyyy, h:mm am/pm");
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, head.length + 2);
}

function updatePayments() {
  const list = call("payments_list");
  const STATUS = { pending: "Pending", verified: "Verified", rejected: "Rejected" };
  const VIA = { gpay: "Google Pay", phonepe: "PhonePe", paytm: "Paytm", upi: "Other UPI app", qr: "Scanned QR", bank: "Bank transfer", other: "Other" };
  writeTab("Payments",
    ["Date", "Name", "Email", "Earned (Rs)", "Paid (Rs)", "% paid", "Paid via", "UTR", "Status", "Screenshots"],
    list.map(r => [toDateTime(r.submitted_at), r.name, r.email,
      Number(r.earned), Number(r.paid), r.percent == null ? "" : Number(r.percent) / 100,
      VIA[r.paid_via] || r.paid_via || "", r.utr ? "'" + r.utr : "", STATUS[r.status] || r.status,
      '=HYPERLINK("' + DASHBOARD + '#payment/' + r.id + '","View screenshots")']),
    [[1, 1, "d mmm yyyy, h:mm am/pm"], [4, 2, "#,##0.00"], [6, 1, "0.0%"]]);
  colourStatus();
}

// Green for verified, amber for pending, red for rejected.
function colourStatus() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Payments");
  const range = sh.getRange("I2:I");
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("Verified").setBackground("#d9f2e6").setFontColor("#0f5132").setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("Pending").setBackground("#fff3cd").setFontColor("#664d03").setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("Rejected").setBackground("#f8d7da").setFontColor("#842029").setRanges([range]).build()
  ]);
}

function setupHourly() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "updatePayments")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("updatePayments").timeBased().everyHours(1).create();
  updatePayments();
}
`;
  }

  function remindDialog(d, behind, pageCount) {
    const notOpened = behind.filter(r => !r.mine.length), unfinished = behind.filter(r => r.mine.length);
    const text = `Hi, a reminder to read "${d.title}"${pageCount ? ` (${pageCount} pages)` : ""}${d.expires_at ? `. It's available until ${new Date(d.expires_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""}.\n\nOpen it in the Pro AI Trainers app:\n${shareLink(d.id)}`;
    const list = rs => rs.map(r => `<li>${esc(nameOf(r.email))}${nameOf(r.email) !== r.email ? ` <span class="muted small-text">${esc(r.email)}</span>` : ""}${r.mine.length ? ` <span class="muted small-text">page ${r.furthest} of ${pageCount}</span>` : ""}</li>`).join("");
    openDialog(`
      <div class="dlg-head"><h2>Remind people</h2><p class="sub" style="margin:6px 0 0">Copy the message, or open your email with everyone in BCC. Nothing is sent until you send it.</p></div>
      <div class="dlg-body">
        ${notOpened.length ? `<label style="margin-top:4px">Haven't opened it (${notOpened.length})</label><ul class="plain-list">${list(notOpened)}</ul>` : ""}
        ${unfinished.length ? `<label>Haven't finished (${unfinished.length})</label><ul class="plain-list">${list(unfinished)}</ul>` : ""}
        <label for="rmText">Message</label><textarea id="rmText" rows="6">${esc(text)}</textarea>
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Close</button>
        <button type="button" data-rm="mail">Email them</button>
        <button type="button" data-rm="wa">WhatsApp</button>
        <button class="primary" type="button" data-rm="copy">Copy message</button></div>`, async () => {});
    const msgText = () => $("#rmText").value;
    $('[data-rm="copy"]', dlg).onclick = async () => { try { await navigator.clipboard.writeText(msgText()); toast("Message copied"); } catch { $("#rmText").select(); } };
    $('[data-rm="wa"]', dlg).onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(msgText())}`, "_blank", "noopener");
    $('[data-rm="mail"]', dlg).onclick = () => { location.href = `mailto:?bcc=${encodeURIComponent(behind.map(r => r.email).join(","))}&subject=${encodeURIComponent(`Reminder: ${d.title}`)}&body=${encodeURIComponent(msgText())}`; };
  }

  function blockDialog(email) {
    openDialog(`
      <div class="dlg-head"><h2>Block an email</h2><p class="sub" style="margin:6px 0 0">They can't open any document until you unblock them. Their access lists stay as they are.</p></div>
      <div class="dlg-body">
        <label for="bEmail">Email</label>
        <input id="bEmail" type="email" required value="${esc(email)}" ${email ? "readonly" : ""}>
        <label for="bReason">Reason (only you see this)</label>
        <input id="bReason" type="text" maxlength="200" placeholder="e.g. Shared screenshots">
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Block</button></div>`,
      async () => {
        const e = $("#bEmail").value.trim().toLowerCase();
        const { error } = await sb.from("blocked_emails").upsert({ email: e, reason: $("#bReason").value.trim() || null });
        if (error) throw error;
        dlg.close(); toast(`${e} blocked`); await refresh();
      });
  }

  function linkSummary() {
    const n = { on: 0, closing: 0, off: 0, expired: 0 };
    S.docs.forEach(d => {
      const st = docStatus(d).cls;
      if (st === "off") n.off++; else if (st === "warn") n.expired++; else if (d.expires_at) n.closing++; else n.on++;
    });
    return [n.on && `${n.on} open`, n.closing && `${n.closing} closing on a timer`, n.expired && `${n.expired} expired`, n.off && `${n.off} turned off`]
      .filter(Boolean).join(", ");
  }

  // Close the given documents' links after N hours (one document, or all).
  function setExpiry(docs, hours) {
    const at = new Date(Date.now() + hours * 36e5);
    const label = EXPIRY_OPTIONS.find(([h]) => h === hours)?.[1] || `${hours} hours`;
    const one = docs.length === 1;
    const off = docs.filter(d => !d.is_active).length;
    confirmDialog({
      title: one ? `Close "${docs[0].title}" after ${label}?` : `Close all ${docs.length} links after ${label}?`,
      text: `${one ? "The link stops" : "Every link stops"} working at ${fmtDate(at.toISOString())}. People can read until then. `
        + (one ? "" : "This replaces any expiry already set. ")
        + (off ? `${off === 1 && one ? "This link is" : `${off} ${off === 1 ? "link is" : "links are"}`} turned off right now and ${off === 1 ? "stays" : "stay"} off.` : ""),
      confirm: "Set expiry",
      run: async () => {
        const { error } = await sb.from("documents").update({ expires_at: at.toISOString() }).in("id", docs.map(d => d.id));
        if (error) throw error;
        toast(one ? `Link closes in ${label}` : `All links close in ${label}`);
        await refresh();
      }
    });
  }

  // Turn links back on and clear their expiry.
  function openLinks(docs) {
    const affected = docs.filter(d => !d.is_active || d.expires_at);
    if (!affected.length) return toast("All links are already on with no expiry.");
    confirmDialog({
      title: "Turn all links on?",
      text: `${affected.length} ${affected.length === 1 ? "document is" : "documents are"} turned off, expired or on a timer. `
        + "They'll all be open again with no expiry, for the people on each document's list.",
      confirm: "Turn all links on",
      run: async () => {
        const { error } = await sb.from("documents").update({ is_active: true, expires_at: null }).in("id", affected.map(d => d.id));
        if (error) throw error;
        toast("All links are on, with no expiry");
        await refresh();
      }
    });
  }

  // Remove every person's access from the given documents (all of them, or one).
  function revokeAccess(docs) {
    const withPeople = docs.filter(d => d.document_access.length);
    const people = new Set(withPeople.flatMap(d => d.document_access.map(a => a.email)));
    if (!people.size) return toast("Nobody has access to remove.");
    const one = docs.length === 1;
    const live = S.sessions.filter(s => isLive(s) && withPeople.some(d => d.id === s.document_id)).length;
    confirmDialog({
      title: one ? `Remove everyone from "${docs[0].title}"?` : "Remove everyone's access to all documents?",
      text: `${people.size} ${people.size === 1 ? "person loses" : "people lose"} access${one ? "" : ` across ${withPeople.length} ${withPeople.length === 1 ? "document" : "documents"}`}. `
        + "They can't open anything until you add them again. Documents, links and reading history stay as they are."
        + (live ? ` ${live} ${live === 1 ? "person is" : "people are"} reading right now; the page they have open stays on their screen until they close it.` : ""),
      confirm: one ? "Remove everyone" : "Remove all access", danger: true,
      run: async () => {
        const { error } = await sb.from("document_access").delete().in("document_id", withPeople.map(d => d.id));
        if (error) throw error;
        toast(one ? "Everyone removed from this document" : "Everyone's access removed from all documents");
        await refresh();
      }
    });
  }

  function confirmDialog({ title, text, confirm, danger, run }) {
    openDialog(`
      <div class="dlg-head"><h2>${esc(title)}</h2></div>
      <div class="dlg-body"><p class="muted" style="margin-top:8px">${esc(text)}</p><div class="msg dlg-msg" role="status"></div></div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="${danger ? "danger" : "primary"}" type="submit">${esc(confirm)}</button></div>`,
      async () => { await run(); dlg.close(); });
  }

  async function refresh() {
    try { await load(); } catch (e) { toast(e.message); }
    route(true);
  }

  // ---------------------------------------------------------------
  // Bar chart: one series, one hue, thin bars with rounded data-ends,
  // recessive grid, hover tooltip, and a label on the tallest bar only.
  // ---------------------------------------------------------------
  function barChart(el, data, { height = 180, fmt = v => String(v) } = {}) {
    if (!el) return;
    const W = Math.max(280, Math.round(el.clientWidth || 640)), H = height, padL = 38, padB = 26, padT = 20;
    const max = Math.max(...data.map(d => d.value), 0);
    const nice = niceMax(max);
    const plotW = W - padL, plotH = H - padB - padT;
    const n = data.length;
    const step = plotW / n;
    const bw = Math.max(3, Math.min(28, step * 0.62));
    const ticks = [0, nice / 2, nice];
    const every = Math.ceil(n / 10);
    const maxIdx = data.findIndex(d => d.value === max && max > 0);

    const bars = data.map((d, i) => {
      const h = nice ? (d.value / nice) * plotH : 0;
      const x = padL + i * step + (step - bw) / 2;
      const y = padT + plotH - h;
      const r = Math.min(4, bw / 2, h);
      const path = h > 0
        ? `M${x},${padT + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${padT + plotH} Z`
        : "";
      return `<g data-i="${i}"><rect class="hit" x="${padL + i * step}" y="${padT}" width="${step}" height="${plotH}"></rect>
        ${path ? `<path class="bar" d="${path}"></path>` : ""}
        ${i === maxIdx ? `<text class="lbl" x="${x + bw / 2}" y="${y - 6}" text-anchor="middle">${esc(fmt(d.value))}</text>` : ""}
        ${i % every === 0 || i === n - 1 ? `<text class="axis-x" x="${padL + i * step + step / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>` : ""}</g>`;
    }).join("");

    el.classList.add("chart");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">
      <g class="grid">${ticks.map(t => { const y = padT + plotH - (nice ? (t / nice) * plotH : 0); return `<line x1="${padL}" x2="${W}" y1="${y}" y2="${y}"></line>`; }).join("")}</g>
      <g class="axis">${ticks.map(t => { const y = padT + plotH - (nice ? (t / nice) * plotH : 0); return `<text x="${padL - 8}" y="${y + 4}" text-anchor="end">${esc(fmt(t))}</text>`; }).join("")}</g>
      <g class="axis">${bars}</g></svg><div class="tooltip" role="status"></div>`;

    const tip = $(".tooltip", el);
    $$("g[data-i]", el).forEach(g => {
      const d = data[Number(g.dataset.i)];
      g.addEventListener("mouseenter", () => {
        const box = el.getBoundingClientRect(), r = $("rect", g).getBoundingClientRect();
        tip.textContent = d.tip;
        tip.style.left = `${r.left - box.left + r.width / 2}px`;
        tip.style.top = `${Math.max(16, r.top - box.top + 18)}px`;
        tip.classList.add("show");
        $(".bar", g)?.classList.add("hl");
      });
      g.addEventListener("mouseleave", () => { tip.classList.remove("show"); $(".bar", g)?.classList.remove("hl"); });
    });
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  // ---------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------
  try { await load(); }
  catch (e) { view.innerHTML = `<div class="card"><p class="msg err">${esc(e.message)}</p></div>`; return; }

  // Back from sign-in: reopen the page the link pointed to (e.g. a payment from the Google Sheet).
  try {
    const back = sessionStorage.getItem("returnHash");
    sessionStorage.removeItem("returnHash");
    if (back && location.hash.length <= 1) history.replaceState(null, "", back);
  } catch (_) {}
  window.addEventListener("hashchange", () => route());
  route();

  // Quiet refresh so "Reading now" stays current.
  setInterval(async () => {
    if (document.visibilityState !== "visible" || dlg.open) return;
    const active = document.activeElement;
    if (active && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return;
    try { await load(); route(true); } catch (_) {}
  }, 30000);
})();
