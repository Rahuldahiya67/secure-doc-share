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
    const [docs, sessions, blocked, payments, accounts, settings, audit, owner, peopleRows, groups, requests, docViews] = await Promise.all([
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
      sb.from("audit_log").select("*").order("at", { ascending: false }).limit(300),
      sb.rpc("is_owner"),
      sb.from("people").select("*"),
      sb.from("groups").select("id,name,description,created_at,group_members(email,added_at),group_documents(document_id)").order("name"),
      sb.from("access_requests").select("*").order("created_at", { ascending: false }).limit(500),
      sb.from("document_views").select("*")
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
    const exp = (settings.data || []).find(s => s.key === "expected_percent");
    S.expectedPercent = exp ? Number(exp.value) : 0;
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
    const [name, arg] = decodeURIComponent(location.hash.slice(1) || "overview").split("/");
    const section = { doc: "documents", person: "people", group: "people", payment: "payments" }[name] || name;
    $$("[data-nav]").forEach(a => { if (a.dataset.nav === section) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    $('[data-count="documents"]').textContent = S.docs.length || "";
    const pendReq = S.requests.filter(r => r.status === "pending").length;
    $('[data-count="people"]').textContent = pendReq ? `${pendReq} new` : (D.people.size || "");
    $('[data-count="blocked"]').textContent = S.blocked.length || "";
    const pendingPays = S.payments.filter(p => p.status === "pending").length;
    $('[data-count="payments"]').textContent = pendingPays ? `${pendingPays} new` : "";

    const pages = { overview, documents, doc: docDetail, people, person: personDetail, group: groupDetail, activity, blocked, payments, payment: paymentDetail };
    (pages[name] || overview)(arg);
    if (!silent) { window.scrollTo(0, 0); }
  }

  function head(title, sub, actions = "", back = "") {
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

  function peopleList() {
    const allTags = [...new Set(S.peopleRows.flatMap(p => p.tags || []))].sort();
    view.innerHTML = `
      ${head("People", "Everyone you've shared with, paid by, or who asked for access.")}
      ${peopleTabs("")}${r2Note()}
      <div class="panel">
        <div class="panel-head"><div class="row" style="flex:1">
          <input type="search" id="q" placeholder="Search name, email or Outlier ID" style="max-width:300px" aria-label="Search people">
          <select id="fTag" style="width:auto" aria-label="Filter by tag"><option value="">All tags</option>${allTags.map(t => `<option>${esc(t)}</option>`).join("")}</select>
          <select id="fGroup" style="width:auto" aria-label="Filter by group"><option value="">All groups</option>${S.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select>
          <label class="row small-text" style="margin:0;gap:6px;font-weight:400"><input type="checkbox" id="onlyUnopened"> Haven't opened anything</label>
        </div><span class="muted small-text" id="pplCount"></span></div>
        <div id="peopleTable"></div>
      </div>`;
    const draw = () => {
      const q = $("#q").value.trim().toLowerCase(), tag = $("#fTag").value, grp = $("#fGroup").value, onlyUn = $("#onlyUnopened").checked;
      const list = [...D.people.keys()].map(email => personSummary(email))
        .filter(r => (!q || [r.email, r.name, r.outlierId].some(v => String(v || "").toLowerCase().includes(q)))
          && (!tag || r.tags.includes(tag)) && (!grp || r.groups.some(g => g.id === grp)) && (!onlyUn || !r.sessions.length))
        .sort((a, b) => (b.live - a.live) || ((b.lastActive ? new Date(b.lastActive) : 0) - (a.lastActive ? new Date(a.lastActive) : 0)) || a.email.localeCompare(b.email));
      $("#pplCount").textContent = `${list.length} ${list.length === 1 ? "person" : "people"}`;
      $("#peopleTable").innerHTML = list.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Person</th><th>Status</th><th class="num">Docs opened</th><th class="num">Reading</th><th class="num hide-sm">Paid</th><th class="hide-sm">Last active</th></tr></thead>
        <tbody>${list.map(r => `<tr class="clickable" tabindex="0" data-href="person/${encodeURIComponent(r.email)}">
          <td><div class="row" style="gap:10px;flex-wrap:nowrap"><span class="avatar">${esc(initials(r.name || r.email))}</span>
            <div><div class="cell-title">${esc(r.name || r.email)}</div>${r.name ? `<div class="cell-sub">${esc(r.email)}</div>` : ""}
            ${r.tags.length || r.groups.length ? `<div class="flags">${tagChips(r.tags)} ${r.groups.map(g => `<span class="tag live">${esc(g.name)}</span>`).join(" ")}</div>` : ""}</div></div></td>
          <td>${D.blocked.has(r.email) ? `<span class="tag off">Blocked</span>` : r.live ? `<span class="tag now">Reading now</span>` : r.sessions.length ? `<span class="tag live">Active</span>` : r.docs.size ? `<span class="tag warn">Not opened</span>` : `<span class="tag plain">No documents</span>`}</td>
          <td class="num">${r.opened.size} of ${r.docs.size}</td>
          <td class="num">${r.secs ? fmtDuration(r.secs) : "–"}</td>
          <td class="num hide-sm">${r.paid ? inr(r.paid) : "–"}</td>
          <td class="hide-sm muted">${r.lastActive ? esc(timeAgo(r.lastActive)) : "Never"}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState(D.people.size ? "No matches" : "No people yet", D.people.size ? "Try a different search or filter." : "People appear here once you share a document with them.");
      wireCommon();
    };
    ["fTag", "fGroup", "onlyUnopened"].forEach(id => $(`#${id}`).onchange = draw);
    $("#q").oninput = draw;
    draw();
  }

  // Everything known about one person, from every table.
  function personSummary(email) {
    const p = D.people.get(email) || { docs: new Set(), opened: new Set() };
    const row = S.peopleRows.find(x => x.email === email) || null;
    const pays = S.payments.filter(x => x.email === email);
    const sessions = D.sessByEmail.get(email) || [];
    const name = row?.display_name || pays[0]?.name || S.requests.find(x => x.email === email)?.name || "";
    const lastActive = [sessions[0]?.last_seen_at, pays[0]?.created_at].filter(Boolean).sort().pop();
    return {
      email, row, name, tags: row?.tags || [], notes: row?.notes || "", outlierId: pays[0]?.outlier_id || "",
      referrer: referrerOf(email), referredText: pays.find(x => x.referred_by)?.referred_by || "",
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
    const text = (S.payments.find(x => x.email === email && x.referred_by)?.referred_by || "").trim().toLowerCase();
    if (!text) return null;
    if (text.includes("@")) return D.people.has(text) && text !== email ? text : null;
    for (const e of D.people.keys()) {
      if (e === email) continue;
      const n = (S.peopleRows.find(x => x.email === e)?.display_name || S.payments.find(x => x.email === e)?.name || "").trim().toLowerCase();
      if (n && n === text) return e;
    }
    return null;
  }
  const nameOf = email => S.peopleRows.find(x => x.email === email)?.display_name || S.payments.find(x => x.email === email)?.name || email;

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
      ${head(r.name || email, `${blocked ? `<span class="tag off">Blocked</span>&nbsp; ` : ""}${esc(email)}${r.outlierId ? `, Outlier ID ${esc(r.outlierId)}` : ""}`,
        `${blocked ? `<button type="button" data-act="unblock">Unblock</button>` : `<button type="button" class="danger" data-act="block">Block</button>`}
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
  function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  const weekKey = d => weekStart(d).toISOString().slice(0, 10);

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
    return flags;
  }
  const flagsHTML = p => { const f = payFlags(p); return f.length ? `<div class="flags">${f.map(x => `<span class="flag ${x.cls}">${esc(x.text)}</span>`).join("")}</div>` : ""; };

  const PAY_TABS = [["", "Submissions"], ["dashboard", "Dashboard"], ["missing", "Missing"], ["settings", "Payment settings"], ["log", "Change log"]];
  const payTabs = active => `<nav class="tabs" aria-label="Payments">${PAY_TABS.map(([k, l]) =>
    `<a href="#payments${k ? "/" + k : ""}" ${k === active ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;

  function payments(tab = "") {
    if (S.paymentsMissing) {
      view.innerHTML = `${head("Payments", "Payment submissions from your people.")}
        <div class="notice">Payments aren't switched on yet. Run <code>supabase/004_payments.sql</code> and then <code>supabase/005_payments_v2.sql</code> in the Supabase SQL Editor.</div>`;
      return;
    }
    const pages = { "": paySubmissions, dashboard: payDashboard, missing: payMissing, settings: paySettings, log: payLog };
    (pages[tab] || paySubmissions)();
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

  function payDashboard() {
    const live = S.payments.filter(p => p.status !== "rejected");
    const verified = S.payments.filter(p => p.status === "verified");
    const pending = S.payments.filter(p => p.status === "pending");
    const withPct = verified.filter(p => Number(p.amount_earned) > 0);
    const avgPct = withPct.length ? (sum(withPct, p => Number(p.amount_sent)) / sum(withPct, p => Number(p.amount_earned))) * 100 : null;

    const weeks = [];
    const thisWeek = weekStart(new Date());
    for (let i = 11; i >= 0; i--) { const d = new Date(thisWeek); d.setDate(d.getDate() - i * 7); weeks.push({ key: d.toISOString().slice(0, 10), d, v: 0 }); }
    live.forEach(p => { const w = weeks.find(x => x.key === weekKey(payDay(p))); if (w) w.v += Number(p.amount_sent); });

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
        <div class="panel-head"><h2>Paid per week</h2><span class="muted small-text">Last 12 weeks, by payout date, pending and verified</span></div>
        <div class="panel-body"><div id="weekChart"></div></div>
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
    barChart($("#weekChart"), weeks.map(w => ({ label: w.d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), value: w.v, tip: `Week of ${w.d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}: ${inr(w.v)}` })),
      { fmt: v => v === 0 ? "0" : v >= 1000 ? `₹${Math.round(v / 100) / 10}k` : `₹${Math.round(v)}`, height: 200 });
  }

  function payMissing() {
    const live = S.payments.filter(p => p.status !== "rejected");
    const thisKey = weekKey(new Date());
    const last = new Date(weekStart(new Date())); last.setDate(last.getDate() - 7);
    const lastKey = last.toISOString().slice(0, 10);
    const byEmail = groupBy(live, p => p.email);
    const lastWeekOnly = [...byEmail.entries()].filter(([, l]) => l.some(p => weekKey(payDay(p)) === lastKey) && !l.some(p => weekKey(payDay(p)) === thisKey))
      .map(([email, l]) => ({ email, name: l[0].name, last: l[0] }));
    const everPaid = new Set(S.payments.map(p => p.email));
    const never = [...D.people.keys()].filter(e => !everPaid.has(e) && !D.blocked.has(e)).sort();
    const reminder = `Hi, a reminder to submit this week's payment in the Secure Doc Share app (Submit a payment).`;

    view.innerHTML = `
      ${head("Payments", "Who hasn't paid yet.")}
      ${payTabs("missing")}
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Paid last week, not this week</h2><span class="muted small-text">Week starting ${esc(new Date(`${thisKey}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }))}</span></div>
          ${lastWeekOnly.length ? `<ul class="rank">${lastWeekOnly.map(r => `<li><span><a href="#person/${encodeURIComponent(r.email)}">${esc(r.name)}</a><span class="cell-sub">${esc(r.email)}</span></span>
            <span class="v">${inr(r.last.amount_sent)}<span class="cell-sub" style="text-align:right">last time</span></span></li>`).join("")}</ul>`
            : emptyState("Everyone's up to date", "Nobody who paid last week is missing this week.")}
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Never submitted</h2><span class="muted small-text">People with document access</span></div>
          ${never.length ? `<ul class="rank">${never.slice(0, 200).map(e => `<li><a href="#person/${encodeURIComponent(e)}">${esc(e)}</a></li>`).join("")}</ul>`
            : emptyState("No one missing", "Everyone with access has submitted at least once.")}
        </div>
      </div>
      <div class="panel section-gap"><div class="panel-body">
        <label for="remind" style="margin-top:0">Reminder message</label>
        <div class="linkbox"><input id="remind" type="text" value="${esc(reminder)}"><button type="button" data-act="copyRemind">Copy</button>
          <a class="btn" target="_blank" rel="noopener" id="waRemind" href="https://wa.me/?text=${encodeURIComponent(reminder)}">WhatsApp</a></div>
      </div></div>`;
    $('[data-act="copyRemind"]').onclick = async () => { try { await navigator.clipboard.writeText($("#remind").value); toast("Message copied"); } catch { $("#remind").select(); } };
    $("#remind").oninput = () => { $("#waRemind").href = `https://wa.me/?text=${encodeURIComponent($("#remind").value)}`; };
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
    return `${r.action} on ${r.table_name}`;
  }

  function payLog() {
    const L = S.audit;
    view.innerHTML = `
      ${head("Payments", "Every change to payment accounts, reviews, settings and admins. Recorded by the database, can't be edited.")}
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

  function remindDialog(d, behind, pageCount) {
    const notOpened = behind.filter(r => !r.mine.length), unfinished = behind.filter(r => r.mine.length);
    const text = `Hi, a reminder to read "${d.title}"${pageCount ? ` (${pageCount} pages)` : ""}${d.expires_at ? `. It's available until ${new Date(d.expires_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""}.\n\nOpen it in the Secure Doc Share app:\n${shareLink(d.id)}`;
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
