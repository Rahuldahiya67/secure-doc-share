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
  const S = { docs: [], sessions: [], blocked: [] };
  const D = {}; // derived indexes

  async function load() {
    const [docs, sessions, blocked] = await Promise.all([
      sb.from("documents")
        .select("id,title,storage_path,is_active,expires_at,created_at,document_access(email,added_at)")
        .order("created_at", { ascending: false }),
      sb.from("view_sessions")
        .select("id,document_id,email,device_id,device_label,page_count,max_page,seconds,page_seconds,started_at,last_seen_at")
        .order("started_at", { ascending: false }).limit(5000),
      sb.from("blocked_emails").select("email,reason,blocked_at").order("blocked_at", { ascending: false })
    ]);
    if (docs.error) throw docs.error;
    S.docs = docs.data || [];
    S.sessions = sessions.error ? [] : sessions.data || [];
    S.blocked = blocked.error ? [] : blocked.data || [];
    S.analyticsMissing = Boolean(sessions.error || blocked.error);
    derive();
  }

  function derive() {
    D.doc = new Map(S.docs.map(d => [d.id, d]));
    D.blocked = new Set(S.blocked.map(b => b.email));
    D.sessByDoc = groupBy(S.sessions, s => s.document_id);
    D.sessByEmail = groupBy(S.sessions, s => s.email);
    D.people = new Map(); // email -> { docs:Set, opened:Set }
    S.docs.forEach(d => d.document_access.forEach(a => person(a.email).docs.add(d.id)));
    S.sessions.forEach(s => person(s.email).opened.add(s.document_id));
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
    const section = { doc: "documents", person: "people" }[name] || name;
    $$("[data-nav]").forEach(a => { if (a.dataset.nav === section) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    $('[data-count="documents"]').textContent = S.docs.length || "";
    $('[data-count="people"]').textContent = D.people.size || "";
    $('[data-count="blocked"]').textContent = S.blocked.length || "";

    const pages = { overview, documents, doc: docDetail, people, person: personDetail, activity, blocked };
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
      const allowed = new Set(d.document_access.map(x => x.email));
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
            <td class="num">${viewers} of ${d.document_access.length}</td><td class="num">${fmtDuration(secs)}</td>
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
        <div class="panel-head"><input type="search" id="q" placeholder="Search documents" style="max-width:320px" aria-label="Search documents"></div>
        <div id="docTable"></div>
      </div>`;
    const draw = () => {
      const q = $("#q").value.trim().toLowerCase();
      const list = S.docs.filter(d => d.title.toLowerCase().includes(q));
      $("#docTable").innerHTML = list.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Document</th><th>Status</th><th class="num">Opened by</th><th class="num">Reading time</th><th class="hide-sm">Last opened</th></tr></thead>
        <tbody>${list.map(d => {
          const ss = D.sessByDoc.get(d.id) || [];
          const st = docStatus(d);
          const live = ss.some(isLive);
          return `<tr class="clickable" tabindex="0" data-href="doc/${d.id}">
            <td><div class="cell-title">${esc(d.title)}</div><div class="cell-sub">Shared ${esc(timeAgo(d.created_at))}${d.expires_at ? `, expires ${esc(fmtDate(d.expires_at))}` : ""}</div></td>
            <td>${live ? `<span class="tag now">Being read</span>` : `<span class="tag ${st.cls}">${st.text}</span>`}</td>
            <td class="num">${new Set(ss.map(s => s.email).filter(e => d.document_access.some(x => x.email === e))).size} of ${d.document_access.length}</td>
            <td class="num">${fmtDuration(sum(ss, s => s.seconds))}</td>
            <td class="hide-sm muted">${ss[0] ? esc(timeAgo(ss[0].last_seen_at)) : "Not opened yet"}</td></tr>`;
        }).join("")}</tbody></table></div>`
        : S.docs.length ? emptyState("No matches", "Try a different search.") : emptyState("No documents yet", "Share a PDF to get a private link for the people you choose.");
      wireCommon();
    };
    $("#q").oninput = draw;
    draw();
    wireCommon();
  }

  function docDetail(id) {
    const d = D.doc.get(id);
    if (!d) { view.innerHTML = head("Document not found", "It may have been deleted.", "", backLink("#documents", "Documents")); return; }
    const ss = D.sessByDoc.get(d.id) || [];
    const st = docStatus(d);
    const allowed = d.document_access.map(a => a.email).sort();
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
        email, mine, allowed: allowed.includes(email), secs: sum(mine, s => s.seconds),
        furthest: Math.max(0, ...mine.map(s => s.max_page || 0)), last: mine[0]?.last_seen_at, live: mine.some(isLive)
      };
    }).sort((a, b) => (b.live - a.live) || (b.secs - a.secs) || a.email.localeCompare(b.email));

    view.innerHTML = `
      ${head(d.title, `<span class="tag ${st.cls}">${st.text}</span>&nbsp; Shared ${esc(fmtDate(d.created_at))}${d.expires_at ? `, expires ${esc(fmtDate(d.expires_at))}` : ", no expiry"}`,
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
            ${allowed.length ? `<button class="small danger" type="button" data-act="revokeDoc">Remove everyone</button>` : ""}</div></div>
          ${rows.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>Email</th><th>Status</th><th class="num">Time</th><th class="num hide-sm">Furthest page</th><th></th></tr></thead>
            <tbody>${rows.map(r => `<tr>
              <td><a href="#person/${encodeURIComponent(r.email)}" class="cell-title">${esc(r.email)}</a>
                <div class="cell-sub">${r.last ? `Last opened ${esc(timeAgo(r.last))}` : "Not opened yet"}</div></td>
              <td>${personTag(r.email, r)}</td>
              <td class="num">${r.secs ? fmtDuration(r.secs) : "–"}</td>
              <td class="num hide-sm">${r.furthest ? `${r.furthest} of ${pageCount}` : "–"}</td>
              <td class="num">${r.allowed ? `<button class="small ghost" data-remove="${esc(r.email)}" type="button">Remove</button>` : ""}</td></tr>`).join("")}
            </tbody></table></div>` : emptyState("No one has access", "Add email IDs below.")}
          <div class="panel-body" style="border-top:1px solid var(--rule)">
            <label for="addEmails" style="margin-top:0">Add people</label>
            <textarea id="addEmails" rows="3" style="min-height:72px" placeholder="Paste email IDs, separated by commas or new lines"></textarea>
            <div class="row" style="margin-top:10px"><button class="primary small" type="button" data-act="add">Add to this document</button><span id="addMsg" class="msg" style="margin:0"></span></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Time on each page</h2><span class="muted small-text">All readers combined</span></div>
          <div class="panel-body">${pageCount ? `<div id="pageChart"></div>
            <details class="table-view"><summary>Show as a table</summary><div class="table-wrap"><table class="data"><thead><tr><th>Page</th><th class="num">Time</th></tr></thead>
            <tbody>${pageSec.map((v, i) => `<tr><td>Page ${i + 1}</td><td class="num">${fmtDuration(v)}</td></tr>`).join("")}</tbody></table></div></details>`
            : `<p class="muted small-text">Appears after someone opens the document in the app.</p>`}</div>
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
      const fresh = valid.filter(e => !allowed.includes(e));
      if (!fresh.length) { msg.className = "msg err"; msg.textContent = "Those email IDs already have access."; return; }
      const { error } = await sb.from("document_access").insert(fresh.map(email => ({ document_id: d.id, email })));
      if (error) { msg.className = "msg err"; msg.textContent = error.message; return; }
      toast(`Added ${fresh.length} ${fresh.length === 1 ? "person" : "people"}`);
      await refresh();
    };
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
  // People
  // ---------------------------------------------------------------
  function people() {
    view.innerHTML = `
      ${head("People", "Everyone you've shared with, and how much they've read.")}
      <div class="panel">
        <div class="panel-head"><input type="search" id="q" placeholder="Search by email" style="max-width:320px" aria-label="Search people">
          <label class="row small-text" style="margin:0;gap:6px;font-weight:400"><input type="checkbox" id="onlyUnopened"> Only people who haven't opened anything</label></div>
        <div id="peopleTable"></div>
      </div>`;
    const draw = () => {
      const q = $("#q").value.trim().toLowerCase();
      const onlyUn = $("#onlyUnopened").checked;
      const list = [...D.people.entries()].map(([email, p]) => {
        const ss = D.sessByEmail.get(email) || [];
        return { email, p, ss, secs: sum(ss, s => s.seconds), devices: new Set(ss.map(s => s.device_id).filter(Boolean)).size, last: ss[0]?.last_seen_at, live: ss.some(isLive) };
      }).filter(r => r.email.includes(q) && (!onlyUn || !r.ss.length))
        .sort((a, b) => (b.live - a.live) || ((b.last ? new Date(b.last) : 0) - (a.last ? new Date(a.last) : 0)) || a.email.localeCompare(b.email));
      $("#peopleTable").innerHTML = list.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Person</th><th>Status</th><th class="num">Opened</th><th class="num">Reading time</th><th class="num hide-sm">Devices</th><th class="hide-sm">Last active</th></tr></thead>
        <tbody>${list.map(r => `<tr class="clickable" tabindex="0" data-href="person/${encodeURIComponent(r.email)}">
          <td><div class="row" style="gap:10px;flex-wrap:nowrap"><span class="avatar">${esc(initials(r.email))}</span><span class="cell-title">${esc(r.email)}</span></div></td>
          <td>${D.blocked.has(r.email) ? `<span class="tag off">Blocked</span>` : r.live ? `<span class="tag now">Reading now</span>` : r.ss.length ? `<span class="tag live">Active</span>` : `<span class="tag warn">Not opened</span>`}</td>
          <td class="num">${r.p.opened.size} of ${r.p.docs.size}</td>
          <td class="num">${r.secs ? fmtDuration(r.secs) : "–"}</td>
          <td class="num hide-sm">${r.devices > 1 ? `<span class="tag warn">${r.devices}</span>` : r.devices || "–"}</td>
          <td class="hide-sm muted">${r.last ? esc(timeAgo(r.last)) : "Never"}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState(D.people.size ? "No matches" : "No people yet", D.people.size ? "Try a different search." : "People appear here once you share a document with them.");
      wireCommon();
    };
    $("#q").oninput = draw;
    $("#onlyUnopened").onchange = draw;
    draw();
  }

  function personDetail(emailArg) {
    const email = decodeURIComponent(emailArg || "");
    const p = D.people.get(email) || { docs: new Set(), opened: new Set() };
    const ss = D.sessByEmail.get(email) || [];
    const blocked = D.blocked.has(email);
    const devices = groupBy(ss.filter(s => s.device_id), s => s.device_id);
    const docIds = [...new Set([...p.docs, ...p.opened])];

    view.innerHTML = `
      ${head(email, blocked ? `<span class="tag off">Blocked</span>&nbsp; Can't open any document` : `${p.docs.size} ${p.docs.size === 1 ? "document" : "documents"} shared with this person`,
        `${blocked ? `<button type="button" data-act="unblock">Unblock</button>` : `<button type="button" class="danger" data-act="block">Block</button>`}
         ${p.docs.size ? `<button type="button" data-act="removeAll">Remove from all documents</button>` : ""}`,
        backLink("#people", "People"))}
      <div class="kpis">
        ${kpi("Reading time", fmtDuration(sum(ss, s => s.seconds)), `${ss.length} ${ss.length === 1 ? "session" : "sessions"}`)}
        ${kpi("Documents opened", `${p.opened.size} of ${p.docs.size}`, p.docs.size - [...p.docs].filter(id => p.opened.has(id)).length ? `${p.docs.size - [...p.docs].filter(id => p.opened.has(id)).length} not opened yet` : "Opened everything shared")}
        ${kpi("Devices used", devices.size || "–", devices.size > 1 ? "More than one phone" : devices.size ? "One phone" : "None yet")}
        ${kpi("Last active", ss[0] ? esc(timeAgo(ss[0].last_seen_at)) : "Never", ss[0] ? esc(fmtDate(ss[0].last_seen_at)) : "")}
      </div>
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Documents</h2></div>
          ${docIds.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Document</th><th class="num">Time</th><th class="num hide-sm">Furthest page</th><th class="hide-sm">Last opened</th></tr></thead>
          <tbody>${docIds.map(id => {
            const mine = ss.filter(s => s.document_id === id);
            const pc = Math.max(0, ...mine.map(s => s.page_count || 0));
            return `<tr class="clickable" tabindex="0" data-href="doc/${id}"><td><div class="cell-title">${esc(docTitle(id))}</div>${p.docs.has(id) ? "" : `<div class="cell-sub">Access removed</div>`}</td>
              <td class="num">${mine.length ? fmtDuration(sum(mine, s => s.seconds)) : "–"}</td>
              <td class="num hide-sm">${mine.length ? `${Math.max(...mine.map(s => s.max_page))} of ${pc}` : "–"}</td>
              <td class="hide-sm muted">${mine[0] ? esc(timeAgo(mine[0].last_seen_at)) : "Not opened yet"}</td></tr>`;
          }).join("")}</tbody></table></div>` : emptyState("No documents", "Nothing is shared with this email.")}
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Devices</h2></div>
          ${devices.size ? `<ul class="feed">${[...devices.values()].map(list => `
            <li><span class="avatar">${icon("phone")}</span><div><div class="what">${esc(list[0].device_label || "Android phone")}</div>
            <div class="when">${list.length} ${list.length === 1 ? "session" : "sessions"}, last used ${esc(timeAgo(list[0].last_seen_at))}</div></div></li>`).join("")}</ul>
            ${devices.size > 1 ? `<div class="panel-body small-text muted" style="border-top:1px solid var(--rule)">Opened on more than one phone. That can mean a new phone, or a shared Google account.</div>` : ""}`
            : emptyState("No devices yet", "Shows once this person opens a document.")}
        </div>
      </div>
      <div class="panel section-gap"><div class="panel-head"><h2>Sessions</h2></div>${sessionTable(ss.slice(0, 100), { showEmail: false })}</div>`;

    const act = n => $(`[data-act="${n}"]`, view);
    if (act("block")) act("block").onclick = () => blockDialog(email);
    if (act("unblock")) act("unblock").onclick = async () => {
      const { error } = await sb.from("blocked_emails").delete().eq("email", email);
      if (error) return toast(error.message);
      toast(`${email} unblocked`); await refresh();
    };
    if (act("removeAll")) act("removeAll").onclick = () => confirmDialog({
      title: `Remove ${email} from every document?`,
      text: `They lose access to all ${p.docs.size} documents. Their reading history stays.`,
      confirm: "Remove access", danger: true,
      run: async () => {
        const { error } = await sb.from("document_access").delete().eq("email", email);
        if (error) throw error;
        toast("Access removed"); await refresh();
      }
    });
    wireCommon();
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
          .insert({ title, storage_path: path, expires_at: exp ? new Date(exp).toISOString() : null }).select("id").single();
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
        <div class="msg dlg-msg" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Save changes</button></div>`,
      async () => {
        const exp = $("#eExp").value;
        const { error } = await sb.from("documents")
          .update({ title: $("#eTitle").value.trim(), expires_at: exp ? new Date(exp).toISOString() : null }).eq("id", d.id);
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
