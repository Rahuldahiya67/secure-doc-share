// Shared helpers: Supabase client, sign-in screen, header.
(function () {
  const cfg = window.APP_CONFIG || {};
  const configured = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);

  const sb = configured
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
      })
    : null;

  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Current page URL without the auth code/hash, used as the sign-in redirect.
  function returnUrl() {
    const u = new URL(window.location.href);
    u.hash = "";
    u.searchParams.delete("code");
    return u.toString();
  }

  function renderNotConfigured(target) {
    target.innerHTML = `
      <div class="card narrow">
        <h2>Setup needed</h2>
        <p class="sub">This site isn't connected to Supabase yet.</p>
        <div class="notice">Add your Supabase project URL and anon key to <code>assets/config.js</code>,
        then run <code>supabase/schema.sql</code>. Steps are in the README.</div>
      </div>`;
  }

  function renderSignIn(target, { title, subtitle }) {
    target.innerHTML = `
      <div class="card narrow">
        <h2>${esc(title)}</h2>
        <p class="sub">${esc(subtitle)}</p>
        <button id="google" class="primary full" type="button">Continue with Google</button>
        <div class="divider">or get a sign-in link by email</div>
        <form id="magic">
          <label for="email">Email</label>
          <input id="email" type="email" required autocomplete="email" placeholder="you@gmail.com">
          <div class="row" style="margin-top:12px"><button class="full" type="submit">Email me a sign-in link</button></div>
        </form>
        <div id="authmsg" class="msg"></div>
      </div>`;

    const msg = $("#authmsg", target);
    $("#google", target).onclick = async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: returnUrl() } });
      if (error) { msg.className = "msg err"; msg.textContent = error.message; }
    };
    $("#magic", target).onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.submitter; btn.disabled = true;
      const email = $("#email", target).value.trim().toLowerCase();
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl() } });
      btn.disabled = false;
      if (error) { msg.className = "msg err"; msg.textContent = error.message; }
      else { msg.className = "msg ok"; msg.textContent = `Link sent to ${email}. Open it on this device to continue.`; }
    };
  }

  function renderHeader(user, extra = "") {
    const bar = $("#bar");
    if (!bar) return;
    bar.innerHTML = `
      <div class="brand">${esc(cfg.appName || "Secure Doc Share")}</div>
      <div class="who">${extra}${user ? `<span>${esc(user.email)}</span><button id="signout" class="small" type="button">Sign out</button>` : ""}</div>`;
    const so = $("#signout");
    if (so) so.onclick = async () => { await sb.auth.signOut(); location.href = returnUrl(); };
  }

  async function getUser() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session?.user ?? null;
  }

  window.App = { sb, cfg, configured, $, esc, renderSignIn, renderNotConfigured, renderHeader, getUser, returnUrl };
})();
