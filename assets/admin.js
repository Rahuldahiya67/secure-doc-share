// Admin: upload PDFs, choose allowed email IDs, see who viewed.
(async function () {
  const { sb, configured, $, esc, renderSignIn, renderNotConfigured, renderHeader, getUser } = window.App;
  const root = $("#app");

  if (!configured) { renderHeader(null); renderNotConfigured(root); return; }

  const user = await getUser();
  renderHeader(user, `<a href="./">Viewer</a>`);
  if (!user) { renderSignIn(root, { title: "Admin sign in", subtitle: "Sign in with the email listed as admin in Supabase." }); return; }

  const { data: isAdmin } = await sb.rpc("is_admin");
  if (!isAdmin) {
    root.innerHTML = `<div class="card narrow"><h2>Not an admin</h2>
      <p class="sub">${esc(user.email)} isn't in the <code>admins</code> table. Add it in Supabase (see README).</p></div>`;
    return;
  }

  root.innerHTML = `
    <div class="card">
      <h2>Share a new document</h2>
      <p class="sub">PDF only, up to 50 MB. Only the email IDs you list can open it.</p>
      <form id="upload">
        <label for="title">Title</label>
        <input id="title" type="text" required maxlength="200" placeholder="e.g. Onboarding guide v2">
        <label for="file">PDF file</label>
        <input id="file" type="file" accept="application/pdf" required>
        <label for="emails">Allowed email IDs</label>
        <textarea id="emails" placeholder="Paste emails separated by commas, spaces or new lines"></textarea>
        <label for="expires">Expires (optional)</label>
        <input id="expires" type="datetime-local">
        <div class="row" style="margin-top:16px"><button class="primary" type="submit">Upload and share</button></div>
        <div id="upmsg" class="msg"></div>
      </form>
    </div>
    <div class="card"><h2>Your documents</h2><p class="sub">Click a document to manage access and see views.</p><div id="docs"><p class="muted">Loading…</p></div></div>`;

  $("#upload").onsubmit = onUpload;
  await loadDocs();

  // ---------------------------------------------------------------
  function parseEmails(text) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const all = text.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const valid = [...new Set(all.filter(e => re.test(e)))];
    const invalid = all.filter(e => !re.test(e));
    return { valid, invalid };
  }

  function shareLink(id) {
    const u = new URL("./", location.href);
    u.searchParams.set("doc", id);
    return u.toString();
  }

  async function onUpload(e) {
    e.preventDefault();
    const msg = $("#upmsg");
    const btn = e.submitter;
    const file = $("#file").files[0];
    const title = $("#title").value.trim();
    const { valid, invalid } = parseEmails($("#emails").value);
    const exp = $("#expires").value;

    msg.className = "msg";
    if (!file || file.type !== "application/pdf") { msg.className = "msg err"; msg.textContent = "Choose a PDF file."; return; }
    if (invalid.length) { msg.className = "msg err"; msg.textContent = `Fix these email IDs: ${invalid.join(", ")}`; return; }

    btn.disabled = true; msg.textContent = "Uploading…";
    const path = `${crypto.randomUUID()}.pdf`;
    const up = await sb.storage.from("documents").upload(path, file, { contentType: "application/pdf", upsert: false });
    if (up.error) { btn.disabled = false; msg.className = "msg err"; msg.textContent = up.error.message; return; }

    const { data: doc, error } = await sb.from("documents")
      .insert({ title, storage_path: path, expires_at: exp ? new Date(exp).toISOString() : null })
      .select("id").single();
    if (error) {
      await sb.storage.from("documents").remove([path]);
      btn.disabled = false; msg.className = "msg err"; msg.textContent = error.message; return;
    }
    if (valid.length) {
      const { error: aErr } = await sb.from("document_access").insert(valid.map(email => ({ document_id: doc.id, email })));
      if (aErr) { msg.className = "msg err"; msg.textContent = aErr.message; }
    }
    btn.disabled = false;
    e.target.reset();
    msg.className = "msg ok";
    msg.innerHTML = `Shared with ${valid.length} email ID(s). Link: <a href="${esc(shareLink(doc.id))}">${esc(shareLink(doc.id))}</a>`;
    await loadDocs();
  }

  async function loadDocs() {
    const box = $("#docs");
    const { data, error } = await sb.from("documents")
      .select("id,title,storage_path,is_active,expires_at,created_at,document_access(email),view_logs(count)")
      .order("created_at", { ascending: false });
    if (error) { box.innerHTML = `<p class="msg err">${esc(error.message)}</p>`; return; }
    if (!data.length) { box.innerHTML = `<p class="muted">No documents yet.</p>`; return; }

    box.innerHTML = data.map(d => {
      const emails = d.document_access.map(a => a.email).sort();
      const views = d.view_logs?.[0]?.count ?? 0;
      const expired = d.expires_at && new Date(d.expires_at) < new Date();
      return `
      <details class="doc" data-id="${esc(d.id)}">
        <summary><strong>${esc(d.title)}</strong>
          <span class="tag">${emails.length} allowed</span><span class="tag">${views} views</span>
          ${!d.is_active ? `<span class="tag off">disabled</span>` : ""}${expired ? `<span class="tag off">expired</span>` : ""}</summary>
        <div class="body stack">
          <div class="row"><input type="text" readonly value="${esc(shareLink(d.id))}" style="flex:1;min-width:200px">
            <button class="small" data-act="copy" type="button">Copy link</button></div>
          <label>Allowed email IDs</label>
          <textarea data-role="emails">${esc(emails.join("\n"))}</textarea>
          <div class="row">
            <button class="small primary" data-act="save" type="button">Save access list</button>
            <button class="small" data-act="toggle" type="button">${d.is_active ? "Disable link" : "Enable link"}</button>
            <button class="small" data-act="logs" type="button">Show views</button>
            <button class="small danger" data-act="delete" type="button">Delete</button>
          </div>
          <div class="msg" data-role="msg"></div>
          <div class="table-wrap" data-role="logs"></div>
        </div>
      </details>`;
    }).join("");

    box.querySelectorAll("details.doc").forEach(el => {
      const d = data.find(x => x.id === el.dataset.id);
      el.addEventListener("click", ev => {
        const act = ev.target.closest("button")?.dataset.act;
        if (act) handle(act, d, el);
      });
    });
  }

  async function handle(act, d, el) {
    const msg = el.querySelector('[data-role="msg"]');
    const say = (t, ok = true) => { msg.className = `msg ${ok ? "ok" : "err"}`; msg.textContent = t; };

    if (act === "copy") {
      try { await navigator.clipboard.writeText(shareLink(d.id)); say("Link copied."); }
      catch { say("Copy failed, select the link and copy it manually.", false); }
    }
    if (act === "save") {
      const { valid, invalid } = parseEmails(el.querySelector('[data-role="emails"]').value);
      if (invalid.length) return say(`Fix these email IDs: ${invalid.join(", ")}`, false);
      const current = d.document_access.map(a => a.email);
      const toAdd = valid.filter(e => !current.includes(e));
      const toRemove = current.filter(e => !valid.includes(e));
      if (toRemove.length) {
        const { error } = await sb.from("document_access").delete().eq("document_id", d.id).in("email", toRemove);
        if (error) return say(error.message, false);
      }
      if (toAdd.length) {
        const { error } = await sb.from("document_access").insert(toAdd.map(email => ({ document_id: d.id, email })));
        if (error) return say(error.message, false);
      }
      d.document_access = valid.map(email => ({ email }));
      say(`Saved: ${toAdd.length} added, ${toRemove.length} removed.`);
    }
    if (act === "toggle") {
      const { error } = await sb.from("documents").update({ is_active: !d.is_active }).eq("id", d.id);
      if (error) return say(error.message, false);
      await loadDocs();
    }
    if (act === "logs") {
      const { data, error } = await sb.from("view_logs").select("email,viewed_at,user_agent")
        .eq("document_id", d.id).order("viewed_at", { ascending: false }).limit(200);
      if (error) return say(error.message, false);
      el.querySelector('[data-role="logs"]').innerHTML = data.length
        ? `<table class="logs"><thead><tr><th>Email</th><th>When</th><th>Device</th></tr></thead><tbody>${
            data.map(r => `<tr><td>${esc(r.email)}</td><td>${new Date(r.viewed_at).toLocaleString()}</td><td class="muted">${esc((r.user_agent || "").slice(0, 60))}</td></tr>`).join("")
          }</tbody></table>`
        : `<p class="muted">No views yet.</p>`;
    }
    if (act === "delete") {
      if (!el.dataset.confirm) { el.dataset.confirm = "1"; return say("Click Delete again to permanently remove this document.", false); }
      const rm = await sb.storage.from("documents").remove([d.storage_path]);
      if (rm.error) return say(rm.error.message, false);
      const { error } = await sb.from("documents").delete().eq("id", d.id);
      if (error) return say(error.message, false);
      await loadDocs();
    }
  }
})();
