// Payment submissions: details, amounts with live percentage, where to pay
// (Google Pay / PhonePe / Paytm / any UPI app / QR / copy UPI ID), proof, history.
(function () {
  const { sb, inApp, cfg, $, $$, esc, icon, fmtDate, toast } = window.App;

  const inr = n => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const STATUS = {
    pending: { cls: "warn", text: "Under review" },
    verified: { cls: "live", text: "Verified" },
    rejected: { cls: "off", text: "Rejected" }
  };
  const VIA = { gpay: "Google Pay", phonepe: "PhonePe", paytm: "Paytm", upi: "Other UPI app", qr: "Scanned QR", bank: "Bank transfer", other: "Other" };
  const MAX_AMOUNT = 1000000;

  // App builds: v2 added the photo picker, v4 lets UPI links open payment apps.
  const app = window.SecureDocApp;
  const canUpload = !inApp || typeof app.supportsUpload === "function";
  const canOpenUpi = !inApp || typeof app.supportsUpi === "function";

  let accounts = [];
  let chosenAccount = null;

  async function render(root, user) {
    const name = user.user_metadata?.full_name || user.user_metadata?.name || "";
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    root.innerHTML = `
      <a href="./" class="back">${icon("back")} Home</a>
      <form id="payForm" novalidate>
        <div class="card">
          <h2>Submit a payment</h2>
          <p class="sub">Four quick steps. You'll see the status below once it's reviewed.</p>
          <div id="dueBox"></div>
          ${canUpload ? "" : `<div class="notice" style="margin-bottom:12px">This version of the app can't attach screenshots.
            <a href="${esc(cfg.apkUrl)}">Download the latest app</a>, or <a href="#" data-open-chrome>open this form in Chrome</a>.</div>`}
          <h3 class="step"><span>1</span>Your details</h3>
          <div class="form-grid">
            <div><label for="pName">Full name</label>
              <input id="pName" type="text" required maxlength="120" autocomplete="name" value="${esc(name)}"></div>
            <div><label for="pEmail">Email</label>
              <input id="pEmail" type="email" value="${esc(user.email)}" readonly>
              <p class="hint">From your Google sign-in.</p></div>
            <div><label for="pOutlier">Outlier ID</label>
              <input id="pOutlier" type="text" required maxlength="120" autocomplete="off"></div>
            <div><label for="pRef">Invited / referred by</label>
              <input id="pRef" type="text" maxlength="120" autocomplete="off" placeholder="Name or email of who invited you"></div>
            <div><label for="pDate">Payout date</label>
              <input id="pDate" type="date" required max="${today}" value="${today}">
              <p class="hint">The date on your payouts screenshot.</p></div>
          </div>

          <h3 class="step"><span>2</span>Amounts</h3>
          <div class="form-grid">
            <div><label for="pEarned">Amount you earned (₹)</label>
              <input id="pEarned" type="number" inputmode="decimal" min="0" max="${MAX_AMOUNT}" step="0.01" required placeholder="0"></div>
            <div><label for="pSent">Amount you're paying (₹)</label>
              <input id="pSent" type="number" inputmode="decimal" min="0" max="${MAX_AMOUNT}" step="0.01" required placeholder="0"></div>
          </div>
          <div class="pct" id="pct" hidden></div>
        </div>

        <div class="card">
          <h3 class="step" style="margin-top:0"><span>3</span>Pay</h3>
          <div id="payTo"><p class="muted">Loading payment details…</p></div>
        </div>

        <div class="card">
          <h3 class="step" style="margin-top:0"><span>4</span>Proof of payment</h3>
          <div class="form-grid">
            <div><label for="pVia">Paid using</label>
              <select id="pVia" required>
                <option value="">Choose…</option>
                ${Object.entries(VIA).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
              </select></div>
            <div><label for="pUtr">UPI reference / UTR number</label>
              <input id="pUtr" type="text" required maxlength="35" autocomplete="off" inputmode="text" placeholder="e.g. 412345678901">
              <p class="hint">Find it in your UPI app under the payment details (usually 12 digits).</p></div>
          </div>
          <div class="form-grid" style="margin-top:4px">
            ${shotField("pShotEarn", "Earnings (payouts) screenshot", true)}
            ${shotField("pShotRef", "Referral screenshot", true)}
            ${shotField("pShotPay", "Payment successful screenshot (optional)", false)}
          </div>
          <div class="msg" id="payMsg" role="status"></div>
          <button class="primary full" type="submit" style="margin-top:18px" ${canUpload ? "" : "disabled"}>Submit payment</button>
        </div>
      </form>
      <div class="card">
        <h2>Your submissions</h2>
        <div id="myPays" style="margin-top:12px"><p class="muted">Loading…</p></div>
      </div>`;

    $$("[data-open-chrome]", root).forEach(a => a.onclick = e => {
      e.preventDefault();
      const u = new URL(location.href); u.search = "?view=pay"; u.hash = "";
      app.openExternal(u.toString());
    });

    ["pShotEarn", "pShotRef", "pShotPay"].forEach(wireShot);
    ["pEarned", "pSent"].forEach(id => $(`#${id}`).addEventListener("input", onAmounts));
    $("#pOutlier").addEventListener("input", () => drawPayTo());
    $("#payForm").onsubmit = e => submit(e, user);
    await loadAccounts();
    loadMine(user); drawDue(user); prefillFromProfile();
  }

  // ---------- step 2: live percentage ----------
  function onAmounts() {
    const earned = Number($("#pEarned").value), sent = Number($("#pSent").value);
    const box = $("#pct");
    if ($("#pEarned").value === "" || $("#pSent").value === "" || !(earned > 0)) { box.hidden = true; drawPayTo(); return; }
    const pct = (sent / earned) * 100;
    box.hidden = false;
    box.className = `pct${sent > earned ? " warn" : ""}`;
    box.innerHTML = sent > earned
      ? `You're paying more than you earned. Please check both amounts.`
      : `You're paying <strong>${pct.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%</strong> of your earnings (${inr(sent)} of ${inr(earned)}).`;
    drawPayTo();
  }

  // ---------- step 3: where to pay ----------
  async function loadAccounts() {
    const { data, error } = await sb.from("payment_accounts")
      .select("id,label,upi_id,payee_name,qr_path,instructions").eq("is_active", true)
      .order("sort_order").order("created_at");
    accounts = error ? [] : data || [];
    if (accounts.some(a => a.qr_path)) {
      const { data: urls } = await sb.storage.from("payment-qr").createSignedUrls(accounts.filter(a => a.qr_path).map(a => a.qr_path), 3600);
      (urls || []).forEach(u => { const a = accounts.find(x => x.qr_path === u.path); if (a) a.qrUrl = u.signedUrl; });
    }
    chosenAccount = accounts[0] || null;
    drawPayTo();
  }

  function upiUrl(scheme, a, amount, note) {
    const q = new URLSearchParams({ pa: a.upi_id, pn: a.payee_name, cu: "INR" });
    if (amount > 0) q.set("am", amount.toFixed(2));
    if (note) q.set("tn", note.slice(0, 50));
    const base = { upi: "upi://pay", gpay: "tez://upi/pay", phonepe: "phonepe://pay", paytm: "paytmmp://pay" }[scheme];
    return `${base}?${q.toString().replace(/\+/g, "%20")}`;
  }

  function drawPayTo() {
    const box = $("#payTo");
    if (!box) return;
    if (!accounts.length) {
      box.innerHTML = `<p class="muted">Payment details haven't been added yet. Please check with the owner before paying.</p>`;
      return;
    }
    const amount = Number($("#pSent")?.value) || 0;
    const outlier = $("#pOutlier")?.value.trim();
    const note = outlier ? `Outlier ${outlier}` : "Outlier payment";
    const a = chosenAccount || accounts[0];

    box.innerHTML = `
      ${accounts.length > 1 ? `<div class="seg" role="tablist" aria-label="Pay to">${accounts.map(x =>
        `<button type="button" role="tab" data-acc="${x.id}" aria-selected="${x.id === a.id}">${esc(x.label)}</button>`).join("")}</div>` : ""}
      <div class="payee">
        <div class="payee-main">
          <div class="muted small-text">Paying</div>
          <div class="payee-name">${esc(a.payee_name)}</div>
          ${a.upi_id ? `<div class="row" style="gap:8px;margin-top:8px">
            <button type="button" class="small" data-copy="1">Copy UPI ID</button></div>` : ""}
          <div class="amount-due">${amount > 0 ? `Amount: <strong>${inr(amount)}</strong>` : `<span class="muted">Enter the amount in step 2 to fill it in automatically.</span>`}</div>
          ${a.instructions ? `<p class="hint" style="margin-top:8px">${esc(a.instructions)}</p>` : ""}
        </div>
        <div class="qr" id="qrBox" aria-label="QR code to pay"></div>
      </div>
      ${a.upi_id ? `
        <div class="upi-apps">
          <a class="btn" href="${esc(upiUrl("gpay", a, amount, note))}" data-via="gpay">Google Pay</a>
          <a class="btn" href="${esc(upiUrl("phonepe", a, amount, note))}" data-via="phonepe">PhonePe</a>
          <a class="btn" href="${esc(upiUrl("paytm", a, amount, note))}" data-via="paytm">Paytm</a>
          <a class="btn" href="${esc(upiUrl("upi", a, amount, note))}" data-via="upi">Other UPI app</a>
        </div>
        ${canOpenUpi ? "" : `<p class="hint">Update the app to open UPI apps with one tap. Until then, scan the QR from another phone or copy the UPI ID.</p>`}` : ""}
      <div class="safety">${icon("shield")}<span>Before you confirm, check that your UPI app shows the name <strong>${esc(a.payee_name)}</strong>. If it shows a different name, don't pay, and contact the owner.</span></div>`;

    // QR: the owner's uploaded image if there is one, otherwise generated here with the amount built in.
    const qrBox = $("#qrBox");
    if (a.qrUrl) qrBox.innerHTML = `<img src="${esc(a.qrUrl)}" alt="QR code for ${esc(a.payee_name)}">`;
    else if (a.upi_id && window.qrcode) {
      const qr = window.qrcode(0, "M");
      qr.addData(upiUrl("upi", a, amount, note));
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } else qrBox.hidden = true;

    $$("[data-acc]", box).forEach(b => b.onclick = () => { chosenAccount = accounts.find(x => x.id === b.dataset.acc); drawPayTo(); });
    // The UPI ID isn't shown on screen; it only goes to the clipboard.
    $$("[data-copy]", box).forEach(b => b.onclick = async () => {
      try { await navigator.clipboard.writeText(a.upi_id); toast("UPI ID copied. Paste it in your UPI app."); }
      catch { toast("Couldn't copy here. Scan the QR or use a UPI app button instead."); }
    });
    $$("[data-via]", box).forEach(link => link.addEventListener("click", e => {
      const via = $("#pVia");
      if (via && !via.value) via.value = link.dataset.via;
      if (!canOpenUpi) { e.preventDefault(); toast("Update the app to open UPI apps from here."); }
    }));
  }

  // ---------- step 4: screenshots ----------
  function shotField(id, label, required) {
    return `<div><label for="${id}">${label}</label>
      <label class="shot" for="${id}" id="${id}Box">
        <input id="${id}" type="file" accept="image/*" ${required ? "required" : ""}>
        <span class="shot-empty">${icon("upload")}<span>Tap to choose a screenshot</span></span>
        <img alt="" hidden>
      </label></div>`;
  }

  function wireShot(id) {
    const input = $(`#${id}`), box = $(`#${id}Box`), img = $("img", box);
    input.onchange = () => {
      const f = input.files[0];
      if (!f) { img.hidden = true; box.classList.remove("has"); return; }
      if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) && !/^image\//.test(f.type)) { toast("Choose an image file."); input.value = ""; return; }
      if (f.size > 25 * 1024 * 1024) { toast("That image is too large. Choose one under 25 MB."); input.value = ""; return; }
      img.src = URL.createObjectURL(f);
      img.hidden = false;
      box.classList.add("has");
    };
  }

  // Fingerprint of the original file, so the owner sees if the same screenshot is reused.
  // Visual fingerprint (difference hash): similar-looking images get similar values,
  // even after re-saving, resizing or recompressing.
  async function dhash(file) {
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement("canvas"); c.width = 9; c.height = 8;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(bmp, 0, 0, 9, 8);
      const px = g.getImageData(0, 0, 9, 8).data;
      const lum = i => px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      let bits = "";
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += lum((y * 9 + x) * 4) > lum((y * 9 + x + 1) * 4) ? "1" : "0";
      return bits.match(/.{4}/g).map(b => parseInt(b, 2).toString(16)).join("");
    } catch (_) { return null; }
  }
  async function sha256(file) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    } catch (_) { return null; }
  }

  // Shrink big screenshots before upload: long side at most 2000 px, JPEG.
  async function compress(file) {
    const url = URL.createObjectURL(file);
    try {
      const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 2000 / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * scale);
      c.height = Math.round(im.naturalHeight * scale);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.86));
      if (blob && (blob.size < file.size || !/^image\/(jpeg|png|webp)$/.test(file.type))) return blob;
      return file;
    } catch (_) {
      return file;
    } finally { URL.revokeObjectURL(url); }
  }

  async function submit(e, user) {
    e.preventDefault();
    const msg = $("#payMsg"), btn = e.submitter || $('#payForm button[type="submit"]');
    const val = id => $(`#${id}`).value.trim();
    const say = (t, ok) => { msg.className = `msg ${ok ? "ok" : "err"}`; msg.textContent = t; };
    const earned = Number(val("pEarned")), sent = Number(val("pSent"));
    const utr = val("pUtr").replace(/\s+/g, "").toUpperCase();
    const files = ["pShotEarn", "pShotRef", "pShotPay"].map(id => $(`#${id}`).files[0] || null);

    if (!val("pName")) return say("Enter your full name.");
    if (!val("pOutlier")) return say("Enter your Outlier ID.");
    if (!val("pDate")) return say("Enter the payout date.");
    if (val("pEarned") === "" || !(earned >= 0) || earned > MAX_AMOUNT) return say("Enter the amount you earned, in rupees.");
    if (val("pSent") === "" || !(sent >= 0) || sent > MAX_AMOUNT) return say("Enter the amount you're paying, in rupees.");
    if (sent > earned) return say("The amount you're paying is more than you earned. Please check both amounts.");
    if (!val("pVia")) return say("Choose how you paid.");
    if (!/^[A-Z0-9]{6,35}$/.test(utr)) return say("Enter the UPI reference / UTR number from your payment (letters and numbers only).");
    if (!files[0]) return say("Add the earnings (payouts) screenshot.");
    if (!files[1]) return say("Add the referral screenshot.");

    btn.disabled = true;
    say("Uploading screenshots…", true);
    try {
      const uid = user.id, stamp = Date.now();
      const kinds = ["earnings", "referral", "payment"];
      const [hashes, blobs, looks] = await Promise.all([
        Promise.all(files.map(f => (f ? sha256(f) : null))),
        Promise.all(files.map(f => (f ? compress(f) : null))),
        Promise.all(files.map(f => (f ? dhash(f) : null)))
      ]);
      const paths = [null, null, null];
      for (let i = 0; i < 3; i++) {
        if (!blobs[i]) continue;
        const type = /^image\/(jpeg|png|webp)$/.test(blobs[i].type) ? blobs[i].type : "image/jpeg";
        const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type];
        paths[i] = `${uid}/${stamp}-${kinds[i]}.${ext}`;
        const { error } = await sb.storage.from("payment-proofs").upload(paths[i], blobs[i], { contentType: type, upsert: false });
        if (error) throw error;
      }
      say("Saving…", true);
      const row = {
        name: val("pName"), outlier_id: val("pOutlier"), referred_by: val("pRef") || null, payout_date: val("pDate"),
        amount_earned: earned, amount_sent: sent, paid_via: val("pVia"), utr,
        account_id: chosenAccount?.id || null,
        earnings_path: paths[0], referral_path: paths[1], payment_path: paths[2],
        earnings_hash: hashes[0], referral_hash: hashes[1], payment_hash: hashes[2],
        earnings_phash: looks[0], referral_phash: looks[1], payment_phash: looks[2]
      };
      let { error } = await sb.from("payment_submissions").insert(row);
      // Before 009_security.sql is run the fingerprint columns don't exist yet.
      if (error && /phash/.test(error.message)) {
        delete row.earnings_phash; delete row.referral_phash; delete row.payment_phash;
        ({ error } = await sb.from("payment_submissions").insert(row));
      }

      if (error) throw error;
      $("#payForm").reset();
      $("#pEmail").value = user.email;
      $("#pct").hidden = true;
      ["pShotEarn", "pShotRef", "pShotPay"].forEach(id => { const b = $(`#${id}Box`); b.classList.remove("has"); $("img", b).hidden = true; });
      drawPayTo();
      say("Payment submitted. It's now under review.", true);
      toast("Payment submitted");
      loadMine(user); drawDue(user);
    } catch (err) {
      const m = err.message || String(err);
      say(/utr_used/.test(m) ? "This UTR number has already been submitted. Check the number, or contact the owner if you think that's a mistake."
        : /too_many_submissions/.test(m) ? "You've reached today's limit of 10 submissions. Try again tomorrow."
        : /row-level|security/i.test(m) ? "This account can't submit payments. Contact the owner if you think that's a mistake."
        : /payment_amount_cap/.test(m) ? "Amounts can't be more than ₹10,00,000."
        : `Couldn't submit: ${m}`);
    } finally { btn.disabled = false; }
  }

  async function loadMine(user) {
    const box = $("#myPays");
    const { data, error } = await sb.from("payment_submissions")
      .select("id,created_at,payout_date,outlier_id,amount_earned,amount_sent,percent_sent,utr,status,admin_note")
      .eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
    if (error) {
      box.innerHTML = /relation|does not exist|schema cache|column/i.test(error.message)
        ? `<p class="muted">Payments aren't switched on yet.</p>` : `<p class="msg err">${esc(error.message)}</p>`;
      return;
    }
    if (!data.length) { box.innerHTML = `<div class="empty"><strong>No submissions yet</strong>Your submitted payments will appear here.</div>`; return; }
    box.innerHTML = `<ul class="pay-list">${data.map(p => {
      const st = STATUS[p.status] || STATUS.pending;
      return `<li><div class="grow"><div class="t">${inr(p.amount_sent)} paid <span class="muted">of ${inr(p.amount_earned)} earned${p.percent_sent != null ? ` (${Number(p.percent_sent)}%)` : ""}</span></div>
        <div class="s">${p.payout_date ? `Payout ${esc(new Date(p.payout_date).toLocaleDateString(undefined, { day: "numeric", month: "short" }))}, ` : ""}submitted ${esc(fmtDate(p.created_at))}${p.utr ? `, UTR ${esc(p.utr)}` : ""}${p.admin_note ? `<br>Note: ${esc(p.admin_note)}` : ""}</div></div>
        <span class="tag ${st.cls}">${st.text}</span></li>`;
    }).join("")}</ul>`;
  }

  // Fill name, Outlier ID and referrer from the person's saved profile.
  async function prefillFromProfile() {
    const [{ data: pr, error }, { data: fin }] = await Promise.all([
      sb.from("candidate_profiles").select("full_name,outlier_id,referred_by").maybeSingle(),
      sb.rpc("my_referrer").then(r => r, () => ({ data: null }))
    ]);
    // A referrer set by the owner/admin is final.
    if (fin) { const ref = $("#pRef"); if (ref) { ref.value = fin; ref.readOnly = true; ref.title = "Set by Pro AI Trainers"; } }
    if (error) return;
    if (!pr) {
      $("#pName")?.closest("div")?.parentElement?.insertAdjacentHTML("beforebegin", `<p class="hint" id="prfHint" style="margin:0 0 10px"><a href="?view=me#profile">Complete your profile</a> and these details fill themselves in every time.</p>`);
      return;
    }
    const set = (id, v) => { const el = $(id); if (el && v && !el.value.trim()) el.value = v; };
    const nm = $("#pName"); if (nm && pr.full_name) nm.value = pr.full_name;
    set("#pOutlier", pr.outlier_id); set("#pRef", pr.referred_by);
    $("#pName")?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // This week's payment: when it's due and whether it's been sent.
  async function weekStatus(user) {
    let day = 3; // Wednesday
    const { data: st } = await sb.from("app_settings").select("value").eq("key", "payment_day").maybeSingle();
    if (st && Number(st.value) >= 0 && Number(st.value) <= 6) day = Number(st.value);
    const c = window.App.payCycle(day);
    const { data } = await sb.from("payment_submissions").select("status,created_at")
      .eq("user_id", user.id).gte("created_at", c.start.toISOString()).neq("status", "rejected").limit(1);
    return { cycle: c, paid: Boolean(data?.length), dueToday: new Date().getDay() === day };
  }
  async function drawDue(user) {
    const box = $("#dueBox"); if (!box) return;
    const w = await weekStatus(user);
    box.innerHTML = w.paid
      ? `<div class="due ok">${icon("seal")}<span>You've sent this week's payment. Next one is due ${esc(w.cycle.dayName)}, ${esc(nextLabel(w))}.</span></div>`
      : `<div class="due ${w.dueToday ? "today" : ""}">${icon("wallet")}<span>Payments are due every <strong>${esc(w.cycle.dayName)}</strong>. This week's is due <strong>${w.dueToday ? "today" : esc(w.cycle.label)}</strong>.</span></div>`;
  }
  function nextLabel(w) { const d = new Date(w.cycle.end); d.setDate(d.getDate() + 7); return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }); }

  window.Payments = { render, weekStatus };
})();
