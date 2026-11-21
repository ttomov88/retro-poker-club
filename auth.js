/* Retro Poker Club — sign-in gate

   Shows the sign-in screen until the person is signed in, is on the members
   list, and (for admins) has entered their authenticator code. Then it starts
   the app with their role. The database enforces the same rules, so this is
   about a clear experience, not the only line of defence. */

(function () {
  "use strict";

  const sb = DB.client;
  const ROLE_KEY = "rpc-role";
  const EMAIL_KEY = "rpc-email";
  const $ = (id) => document.getElementById(id);
  const authEl = $("auth");
  const bodyEl = $("auth-body");

  const AUTH = {
    role: null, // 'owner' | 'admin' | 'viewer'
    email: "",
    userId: null,
    isEditor: false,
    mfaOn: false,
    signOut,
    setupAuthenticator: () => showEnroll(false),
  };
  window.RPC_AUTH = AUTH;

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch (_) {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch (_) {}
    },
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function show(html) {
    document.getElementById("app").hidden = true;
    authEl.hidden = false;
    bodyEl.innerHTML = html;
  }

  function setError(msg) {
    const e = $("auth-error");
    if (e) {
      e.textContent = msg || "";
      e.hidden = !msg;
    }
  }

  // Disables the button while working; shows any error in the card.
  function busy(button, work) {
    button.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      setError("");
      try {
        await work();
      } catch (err) {
        console.error(err);
        setError(friendly(err));
      } finally {
        button.disabled = false;
      }
    });
  }

  function friendly(err) {
    const msg = String((err && err.message) || err || "");
    if (navigator.onLine === false || /fetch|network/i.test(msg)) return "No connection. Try again when you're online.";
    if (/invalid login credentials/i.test(msg)) return "Wrong email or password.";
    if (/invalid totp|invalid code|expired/i.test(msg)) return "That code didn't work. Check the latest code and try again.";
    if (/rate limit|too many/i.test(msg)) return "Too many attempts. Wait a minute and try again.";
    return msg || "Something went wrong. Try again.";
  }

  // ---------- Sign in ----------
  function showLogin(prefillEmail) {
    show(`
      <h1 class="auth-title">Sign in</h1>
      <form class="auth-form" autocomplete="on">
        <div class="field">
          <label for="a-email">Email</label>
          <input type="email" id="a-email" autocomplete="username" inputmode="email" value="${esc(prefillEmail || store.get(EMAIL_KEY) || "")}">
        </div>
        <div class="field">
          <label for="a-pass">Password</label>
          <input type="password" id="a-pass" autocomplete="current-password">
        </div>
        <p class="auth-error" id="auth-error" hidden></p>
        <button class="btn btn-gold btn-block" id="a-go" type="submit">Sign in</button>
      </form>
      <button class="auth-link" id="a-first">First time here? Set your password</button>
      <p class="auth-note">Forgot your password? Ask an admin to reset your login.</p>
    `);
    busy($("a-go"), async () => {
      const email = $("a-email").value.trim().toLowerCase();
      const password = $("a-pass").value;
      if (!email || !password) return setError("Enter your email and password.");
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      store.set(EMAIL_KEY, email);
      await afterSignIn();
    });
    $("a-first").addEventListener("click", () => showClaim($("a-email").value.trim()));
  }

  // ---------- First time: set a password for an invited email ----------
  function showClaim(prefillEmail) {
    show(`
      <h1 class="auth-title">Set your password</h1>
      <p class="auth-note">Use the email and invite code an admin sent you.</p>
      <form class="auth-form">
        <div class="field">
          <label for="c-email">Email</label>
          <input type="email" id="c-email" autocomplete="username" inputmode="email" value="${esc(prefillEmail)}">
        </div>
        <div class="field">
          <label for="c-code">Invite code</label>
          <input type="text" id="c-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
        </div>
        <div class="field">
          <label for="c-pass">New password <span class="muted">(8+ characters)</span></label>
          <input type="password" id="c-pass" autocomplete="new-password">
        </div>
        <div class="field">
          <label for="c-pass2">Repeat password</label>
          <input type="password" id="c-pass2" autocomplete="new-password">
        </div>
        <p class="auth-error" id="auth-error" hidden></p>
        <button class="btn btn-gold btn-block" id="c-go" type="submit">Create login</button>
      </form>
      <button class="auth-link" id="c-back">Back to sign in</button>
    `);
    busy($("c-go"), async () => {
      const email = $("c-email").value.trim().toLowerCase();
      const password = $("c-pass").value;
      const code = $("c-code").value.replace(/\D/g, "");
      if (!email) return setError("Enter your email.");
      if (code.length !== 6) return setError("Enter the 6-digit invite code.");
      if (password.length < 8) return setError("Password must be at least 8 characters.");
      if (password !== $("c-pass2").value) return setError("The passwords don't match.");
      const res = await fetch(`${SUPABASE_URL}/functions/v1/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
        body: JSON.stringify({ email, password, code }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) return setError(out.error || "Couldn't create the login. Try again.");
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      store.set(EMAIL_KEY, email);
      await afterSignIn();
    });
    $("c-back").addEventListener("click", () => showLogin($("c-email").value.trim()));
  }

  // ---------- Authenticator code (every sign-in, once set up) ----------
  function showCode(factorId) {
    show(`
      <h1 class="auth-title">Authenticator code</h1>
      <p class="auth-note">Open Google Authenticator and enter the 6-digit code for Retro Poker Club.</p>
      <form class="auth-form">
        <div class="field">
          <input type="text" id="m-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
        </div>
        <p class="auth-error" id="auth-error" hidden></p>
        <button class="btn btn-gold btn-block" id="m-go" type="submit">Continue</button>
      </form>
      <button class="auth-link" id="m-out">Sign out</button>
    `);
    const input = $("m-code");
    setTimeout(() => input.focus(), 50);
    busy($("m-go"), async () => {
      const code = input.value.replace(/\D/g, "");
      if (code.length !== 6) return setError("Enter the 6-digit code.");
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code });
      if (error) throw error;
      await afterSignIn();
    });
    $("m-out").addEventListener("click", signOut);
  }

  // ---------- Set up the authenticator ----------
  async function showEnroll(required) {
    show(`<p class="auth-note">Preparing…</p>`);
    let enrolled;
    try {
      // Drop any half-finished setup from an earlier attempt.
      const { data: list } = await sb.auth.mfa.listFactors();
      for (const f of (list && list.all) || []) {
        if (f.factor_type === "totp" && f.status !== "verified") await sb.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Retro Poker Club", issuer: "Retro Poker Club" });
      if (error) throw error;
      enrolled = data;
    } catch (err) {
      console.error(err);
      show(`
        <h1 class="auth-title">Two-step login</h1>
        <p class="auth-error" id="auth-error">${esc(friendly(err))}</p>
        <button class="btn btn-gold btn-block" id="e-retry">Try again</button>
        <button class="auth-link" id="e-out">${required ? "Sign out" : "Back"}</button>
      `);
      $("e-retry").addEventListener("click", () => showEnroll(required));
      $("e-out").addEventListener("click", required ? signOut : () => afterSignIn());
      return;
    }

    const secret = enrolled.totp.secret;
    const qr = String(enrolled.totp.qr_code || "");
    const qrSrc = qr.startsWith("data:") ? qr : "data:image/svg+xml;utf-8," + encodeURIComponent(qr);
    const grouped = secret.replace(/(.{4})/g, "$1 ").trim();
    show(`
      <h1 class="auth-title">Two-step login</h1>
      <p class="auth-note">${required ? "Admins need a code from Google Authenticator each time they sign in." : "Add a code from Google Authenticator to your sign-in."}</p>
      <ol class="auth-steps">
        <li>In <strong>Google Authenticator</strong> tap <strong>+</strong> &rarr; <strong>Enter a setup key</strong>. Name it <em>Retro Poker Club</em> and paste this key (time based):
          <div class="secret-box"><code id="e-secret">${esc(grouped)}</code><button class="btn btn-ghost-gold btn-sm" id="e-copy" type="button">Copy</button></div>
          <a class="auth-link" href="${esc(enrolled.totp.uri)}">Or open it in your authenticator app</a>
          <details class="qr-details"><summary>Setting up on another device? Show QR code</summary><img alt="QR code" src="${esc(qrSrc)}" width="180" height="180"></details>
        </li>
        <li>Enter the 6-digit code it shows:
          <input type="text" id="e-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
        </li>
      </ol>
      <p class="auth-error" id="auth-error" hidden></p>
      <button class="btn btn-gold btn-block" id="e-go">Turn on</button>
      <button class="auth-link" id="e-out">${required ? "Sign out" : "Not now"}</button>
    `);
    $("e-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(secret);
        $("e-copy").textContent = "Copied";
      } catch (_) {
        $("e-copy").textContent = "Select & copy";
      }
    });
    busy($("e-go"), async () => {
      const code = $("e-code").value.replace(/\D/g, "");
      if (code.length !== 6) return setError("Enter the 6-digit code.");
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: enrolled.id, code });
      if (error) throw error;
      await afterSignIn();
    });
    $("e-out").addEventListener("click", async () => {
      if (required) return signOut();
      try {
        await sb.auth.mfa.unenroll({ factorId: enrolled.id });
      } catch (_) {}
      afterSignIn();
    });
  }

  function showNoAccess(email) {
    DB.clearCache(); // no access any more: don't keep the club's data on this phone
    store.set(ROLE_KEY, null);
    show(`
      <h1 class="auth-title">No access</h1>
      <p class="auth-note">${esc(email)} isn't on the members list any more. Ask an admin to add you again.</p>
      <button class="btn btn-gold btn-block" id="n-out">Sign out</button>
    `);
    $("n-out").addEventListener("click", signOut);
  }

  // ---------- After sign-in: role + two-step checks ----------
  let started = false;

  async function afterSignIn() {
    const { data: sess } = await sb.auth.getSession();
    const session = sess && sess.session;
    if (!session) return showLogin();
    AUTH.userId = session.user.id;
    AUTH.email = session.user.email || "";

    // Role (fall back to the last known role when offline)
    let role = null;
    try {
      const { data, error } = await sb.from("members").select("role").eq("user_id", session.user.id).maybeSingle();
      if (error) throw error;
      role = data ? data.role : null;
      store.set(ROLE_KEY, role);
      if (!role) return showNoAccess(AUTH.email);
    } catch (err) {
      role = store.get(ROLE_KEY);
      if (!role) {
        show(`
          <h1 class="auth-title">No connection</h1>
          <p class="auth-note">Connect to the internet once to load the club data.</p>
          <button class="btn btn-gold btn-block" id="r-retry">Try again</button>`);
        $("r-retry").addEventListener("click", afterSignIn);
        return;
      }
    }
    AUTH.role = role;
    const editorRole = role === "owner" || role === "admin";

    // Two-step login
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    const hasFactor = aal && aal.nextLevel === "aal2";
    AUTH.mfaOn = !!hasFactor;
    if (hasFactor && aal.currentLevel !== "aal2") {
      try {
        const { data: list, error } = await sb.auth.mfa.listFactors();
        if (error) throw error;
        const factor = (list.totp || []).find((f) => f.status === "verified");
        if (factor) return showCode(factor.id);
      } catch (err) {
        if (!navigator.onLine) return startApp(false); // offline: read-only until back online
        throw err;
      }
    }
    if (editorRole && !hasFactor) return showEnroll(true);

    startApp(editorRole && aal.currentLevel === "aal2");
  }

  function startApp(isEditor) {
    AUTH.isEditor = isEditor;
    document.body.dataset.role = isEditor ? "editor" : "viewer";
    document.body.classList.toggle("is-owner", isEditor && AUTH.role === "owner");
    authEl.hidden = true;
    bodyEl.innerHTML = "";
    document.getElementById("app").hidden = false;
    if (!started) {
      started = true;
      window.RPC_APP.start();
    } else {
      window.RPC_APP.refresh();
    }
  }

  async function signOut() {
    try {
      await sb.auth.signOut();
    } catch (_) {}
    DB.clearCache();
    store.set(ROLE_KEY, null);
    location.reload();
  }

  // If the session ends elsewhere (e.g. login reset by an admin), go back to sign-in.
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      DB.clearCache();
      store.set(ROLE_KEY, null);
      if (started) location.reload();
    }
  });

  async function boot() {
    try {
      const { data } = await sb.auth.getSession();
      if (!data || !data.session) return showLogin();
      await afterSignIn();
    } catch (err) {
      console.error(err);
      showLogin();
      setError(friendly(err));
    }
  }

  window.addEventListener("load", boot);
})();
