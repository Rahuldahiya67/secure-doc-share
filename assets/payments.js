// Payment submissions: form with two screenshots, plus the person's own history.
(function () {
  const { sb, inApp, cfg, $, esc, icon, timeAgo, fmtDate, toast } = window.App;

  const inr = n => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const STATUS = {
    pending: { cls: "warn", text: "Under review" },
    verified: { cls: "live", text: "Verified" },
    rejected: { cls: "off", text: "Rejected" }
  };

  // The first app version can't open the photo picker; newer builds add supportsUpload().
  const canUpload = !inApp || typeof window.SecureDocApp.supportsUpload === "function";

  async function render(root, user) {
    const name = user.user_metadata?.full_name || user.user_metadata?.name || "";
    root.innerHTML = `
      <a href="./" class="back">${icon("back")} Home</a>
      <div class="card">
        <h2>Submit a payment</h2>
        <p class="sub">Fill in your details and add both screenshots. You'll see the status below once it's reviewed.</p>
        ${canUpload ? "" : `<div class="notice" style="margin-bottom:12px">This version of the app can't attach screenshots.
          <a href="${esc(cfg.apkUrl)}">Download the latest app</a>, or <a href="#" id="openChrome">open this form in Chrome</a>.</div>`}
        <form id="payForm" novalidate>
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
            <div><label for="pEarned">Amount earned (₹)</label>
              <input id="pEarned" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="0"></div>
            <div><label for="pSent">Amount sent (₹)</label>
              <input id="pSent" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="0"></div>
          </div>
          <div class="form-grid" style="margin-top:4px">
            ${shotField("pShotEarn", "Earnings (payouts) screenshot")}
            ${shotField("pShotRef", "Referral screenshot")}
          </div>
          <div class="msg" id="payMsg" role="status"></div>
          <button class="primary full" type="submit" style="margin-top:18px" ${canUpload ? "" : "disabled"}>Submit payment</button>
        </form>
      </div>
      <div class="card">
        <h2>Your submissions</h2>
        <div id="myPays" style="margin-top:12px"><p class="muted">Loading…</p></div>
      </div>`;

    const openChrome = $("#openChrome");
    if (openChrome) openChrome.onclick = e => {
      e.preventDefault();
      const u = new URL(location.href); u.search = "?view=pay"; u.hash = "";
      window.SecureDocApp.openExternal(u.toString());
    };

    wireShot("pShotEarn");
    wireShot("pShotRef");
    $("#payForm").onsubmit = e => submit(e, user);
    loadMine(user);
  }

  function shotField(id, label) {
    return `<div><label for="${id}">${label}</label>
      <label class="shot" for="${id}" id="${id}Box">
        <input id="${id}" type="file" accept="image/*" required>
        <span class="shot-empty">${icon("upload")}<span>Tap to choose a screenshot</span></span>
        <img alt="" hidden>
      </label></div>`;
  }

  function wireShot(id) {
    const input = $(`#${id}`), box = $(`#${id}Box`), img = $("img", box);
    input.onchange = () => {
      const f = input.files[0];
      if (!f) { img.hidden = true; box.classList.remove("has"); return; }
      if (!/^image\//.test(f.type)) { toast("Choose an image file."); input.value = ""; return; }
      img.src = URL.createObjectURL(f);
      img.hidden = false;
      box.classList.add("has");
    };
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
      return blob && blob.size < file.size ? blob : file;
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
    const fEarn = $("#pShotEarn").files[0], fRef = $("#pShotRef").files[0];

    if (!val("pName")) return say("Enter your full name.");
    if (!val("pOutlier")) return say("Enter your Outlier ID.");
    if (val("pEarned") === "" || !(earned >= 0)) return say("Enter the amount you earned, in rupees.");
    if (val("pSent") === "" || !(sent >= 0)) return say("Enter the amount you sent, in rupees.");
    if (!fEarn) return say("Add the earnings (payouts) screenshot.");
    if (!fRef) return say("Add the referral screenshot.");

    btn.disabled = true;
    say("Uploading screenshots…", true);
    try {
      const uid = user.id, stamp = Date.now();
      const paths = [`${uid}/${stamp}-earnings.jpg`, `${uid}/${stamp}-referral.jpg`];
      const blobs = await Promise.all([compress(fEarn), compress(fRef)]);
      for (let i = 0; i < 2; i++) {
        const type = blobs[i].type || "image/jpeg";
        const path = type === "image/jpeg" ? paths[i] : paths[i].replace(/\.jpg$/, type === "image/png" ? ".png" : ".webp");
        paths[i] = path;
        const { error } = await sb.storage.from("payment-proofs").upload(path, blobs[i], { contentType: type, upsert: false });
        if (error) throw error;
      }
      const { error } = await sb.from("payment_submissions").insert({
        name: val("pName"), outlier_id: val("pOutlier"), referred_by: val("pRef") || null,
        amount_earned: earned, amount_sent: sent, earnings_path: paths[0], referral_path: paths[1]
      });
      if (error) throw error;
      $("#payForm").reset();
      $("#pEmail").value = user.email;
      ["pShotEarn", "pShotRef"].forEach(id => { const b = $(`#${id}Box`); b.classList.remove("has"); $("img", b).hidden = true; });
      say("Payment submitted. It's now under review.", true);
      toast("Payment submitted");
      loadMine(user);
    } catch (err) {
      say(/row-level|security/i.test(err.message || "")
        ? "This account can't submit payments. Contact the owner if you think that's a mistake."
        : `Couldn't submit: ${err.message || err}`);
    } finally { btn.disabled = false; }
  }

  async function loadMine(user) {
    const box = $("#myPays");
    const { data, error } = await sb.from("payment_submissions")
      .select("id,created_at,outlier_id,amount_earned,amount_sent,status,admin_note")
      .eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
    if (error) {
      box.innerHTML = /relation|does not exist|schema cache/i.test(error.message)
        ? `<p class="muted">Payments aren't switched on yet.</p>` : `<p class="msg err">${esc(error.message)}</p>`;
      return;
    }
    if (!data.length) { box.innerHTML = `<div class="empty"><strong>No submissions yet</strong>Your submitted payments will appear here.</div>`; return; }
    box.innerHTML = `<ul class="pay-list">${data.map(p => {
      const st = STATUS[p.status] || STATUS.pending;
      return `<li><div class="grow"><div class="t">${inr(p.amount_sent)} sent <span class="muted">of ${inr(p.amount_earned)} earned</span></div>
        <div class="s">${esc(fmtDate(p.created_at))}, Outlier ID ${esc(p.outlier_id)}${p.admin_note ? `<br>Note: ${esc(p.admin_note)}` : ""}</div></div>
        <span class="tag ${st.cls}">${st.text}</span></li>`;
    }).join("")}</ul>`;
  }

  window.Payments = { render };
})();
