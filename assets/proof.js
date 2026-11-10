// Payment screenshots page: opened from the Google Sheet's "View screenshots" link.
// Only admins and people on the screenshot-viewer list can see anything here.
(async function () {
  const { sb, configured, $, esc, brandHTML, renderSignIn, renderNotConfigured, getUser, signOut } = window.App;
  const app = $("#app");
  app.innerHTML = "<main></main>";
  const main = $("main", app);
  if (!configured) return renderNotConfigured(main);

  const id = new URLSearchParams(location.search).get("id") || "";
  const user = await getUser();
  if (!user) return renderSignIn(main, { title: "Payment screenshots", subtitle: "Sign in with the Google account the owner allowed to view screenshots." });

  const shell = inner => {
    main.innerHTML = `<div class="card proof-card">
      <div class="row" style="justify-content:space-between;margin-bottom:18px">${brandHTML()}<button type="button" class="ghost small" id="so">Sign out</button></div>
      ${inner}</div>`;
    $("#so").onclick = signOut;
  };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return shell(`<h2>Link not complete</h2><p class="sub">Open this page from the "View screenshots" link in the payments sheet.</p>`);

  const { data, error } = await sb.rpc("payment_screenshots", { pid: id });
  if (error) {
    return shell(/no_access/.test(error.message)
      ? `<h2>No access</h2><p class="sub">${esc(user.email)} isn't allowed to view payment screenshots. Ask the owner to add this email, or sign out and use the right account.</p>`
      : `<h2>Couldn't load</h2><p class="sub">Please try again in a moment.</p>`);
  }
  const p = data?.[0];
  if (!p) return shell(`<h2>Payment not found</h2><p class="sub">It may have been deleted.</p>`);

  const shots = [["Earnings (payouts)", p.earnings_path], ["Referral", p.referral_path], ["Payment", p.payment_path]].filter(s => s[1]);
  shell(`<h2 style="margin-bottom:2px">${esc(p.name)}</h2>
    <p class="sub">Submitted ${esc(new Date(p.submitted_at).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }))}</p>
    <div class="proof-grid">${shots.map((s, i) => `<figure><figcaption>${esc(s[0])}</figcaption><a id="sl${i}" target="_blank" rel="noopener"><img id="si${i}" alt="${esc(s[0])} screenshot"></a></figure>`).join("")}</div>
    <p class="hint">Tap a screenshot to open it full size. Links expire after 10 minutes; reload the page to see them again.</p>`);
  const { data: urls } = await sb.storage.from("payment-proofs").createSignedUrls(shots.map(s => s[1]), 600);
  (urls || []).forEach((u, i) => {
    if (!u.signedUrl) { $(`#si${i}`).replaceWith(Object.assign(document.createElement("p"), { className: "muted small-text", textContent: "Couldn't load this screenshot." })); return; }
    $(`#si${i}`).src = u.signedUrl; $(`#sl${i}`).href = u.signedUrl;
  });
})();
