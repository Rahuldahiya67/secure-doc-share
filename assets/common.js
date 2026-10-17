// Shared helpers: Supabase client, brand, sign-in screens, formatting, toasts.
(function () {
  const cfg = window.APP_CONFIG || {};
  const configured = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);

  const sb = configured
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
      })
    : null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // The Android app injects window.SecureDocApp into its WebView.
  const inApp = typeof window.SecureDocApp === "object" && window.SecureDocApp !== null;

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- icons (inline, 24px grid, stroke) ----------
  const ICONS = {
    seal: '<path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
    overview: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z"/>',
    docs: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
    shield: '<path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6l7-3z"/>'
  };
  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  function brandHTML(sub) {
    return `<a class="brand" href="./"><span class="brand-seal">${icon("seal")}</span>
      <span>${esc(cfg.appName || "Secure Doc Share")}${sub ? `<small>${esc(sub)}</small>` : ""}</span></a>`;
  }

  // ---------- formatting ----------
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return s && m < 10 ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60), mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  }
  function timeAgo(iso) {
    if (!iso) return "never";
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 45) return "just now";
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    if (d < 86400 * 7) return `${Math.round(d / 86400)} d ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
  }
  function initials(email) {
    const name = String(email || "?").split("@")[0].replace(/[^a-z]/gi, " ").trim();
    const parts = name.split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)) || "?";
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(text) {
    let el = $("#toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
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
        ${brandHTML()}
        <h2>Setup needed</h2>
        <p class="sub">This site isn't connected to Supabase yet.</p>
        <div class="notice">Add your Supabase project URL and anon key to <code>assets/config.js</code>,
        then run the SQL files in <code>supabase/</code>. Steps are in the README.</div>
      </div>`;
  }

  function renderSignIn(target, { title, subtitle }) {
    if (inApp) return renderAppSignIn(target, { title, subtitle });
    target.innerHTML = `
      <div class="card narrow">
        ${brandHTML()}
        <h2>${esc(title)}</h2>
        <p class="sub">${esc(subtitle)}</p>
        <button id="google" class="primary full" type="button">Continue with Google</button>
        <div class="divider">or get a sign-in link by email</div>
        <form id="magic">
          <label for="email">Email</label>
          <input id="email" type="email" required autocomplete="email" placeholder="you@gmail.com">
          <button class="full" type="submit" style="margin-top:12px">Email me a sign-in link</button>
        </form>
        <div id="authmsg" class="msg" role="status"></div>
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
      if (error) {
        msg.className = "msg err";
        msg.textContent = /rate limit/i.test(error.message)
          ? "Too many sign-in emails were sent in the last hour. Use Continue with Google, or try again later."
          : error.message;
      } else { msg.className = "msg ok"; msg.textContent = `Link sent to ${email}. Open it in this browser to continue.`; }
    };
  }

  // Inside the app Google refuses embedded sign-in, so the app opens the
  // Google page in Chrome and Supabase sends the user back via securedocshare://auth.
  function renderAppSignIn(target, { title, subtitle }) {
    target.innerHTML = `
      <div class="card narrow">
        ${brandHTML()}
        <h2>${esc(title)}</h2>
        <p class="sub">${esc(subtitle)}</p>
        <button id="google" class="primary full" type="button">Continue with Google</button>
        <p class="hint" style="margin-top:12px">Google sign-in opens in Chrome and brings you back here.</p>
        <div id="authmsg" class="msg" role="status"></div>
      </div>`;
    const msg = $("#authmsg", target);
    $("#google", target).onclick = async () => {
      const doc = new URLSearchParams(location.search).get("doc");
      try { if (doc) localStorage.setItem("pendingDoc", doc); } catch (_) {}
      const { data, error } = await sb.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${cfg.appScheme}://auth`, skipBrowserRedirect: true }
      });
      if (error) { msg.className = "msg err"; msg.textContent = error.message; return; }
      window.SecureDocApp.openExternal(data.url);
    };
  }

  function renderHeader(user, extra = "") {
    const bar = $("#bar");
    if (!bar) return;
    bar.innerHTML = `
      ${brandHTML()}
      <div class="who">${extra}${user ? `<span>${esc(user.email)}</span><button id="signout" class="small" type="button">Sign out</button>` : ""}</div>`;
    const so = $("#signout");
    if (so) so.onclick = signOut;
  }

  async function signOut() {
    await sb.auth.signOut();
    location.href = returnUrl();
  }

  async function getUser() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session?.user ?? null;
  }

  window.App = {
    sb, cfg, configured, inApp, $, $$, esc, icon, brandHTML, fmtDuration, timeAgo, fmtDate, initials, toast,
    renderSignIn, renderNotConfigured, renderHeader, getUser, returnUrl, signOut
  };
})();
