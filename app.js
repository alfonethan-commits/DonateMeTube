(() => {
  "use strict";

  const app = document.querySelector("#app");
  const state = { csrf: "", user: null, ownStall: null, search: "", toastTimer: null, menuOpen: false };
  const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents || 0) / 100);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const initials = (value) => (String(value || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "?");
  const dateShort = (value) => value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  const hashRoute = () => location.hash.replace(/^#\/?/, "").split("?")[0] || "home";
  const pathSlug = () => {
    const path = location.pathname.replace(/^\/+|\/+$/g, "");
    return path && !["index.html"].includes(path) && !path.startsWith("api/") && !path.startsWith("uploads/") ? decodeURIComponent(path.split("/")[0]) : "";
  };
  const toast = (message, isError = false) => {
    const node = document.querySelector("#toast");
    if (!node) return;
    node.textContent = message;
    node.className = `toast${isError ? " error" : ""}`;
    node.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
  };

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (["POST", "PUT", "PATCH", "DELETE"].includes(options.method || "GET")) headers["X-CSRF-Token"] = state.csrf;
    let response;
    try {
      response = await fetch(url, { credentials: "same-origin", ...options, headers });
    } catch {
      throw new Error("Unable to reach DonateMeTube. Check your connection and try again.");
    }
    let result;
    try { result = await response.json(); } catch { throw new Error("The server returned an invalid response."); }
    if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
    return result;
  }

  function header(active = "") {
    const links = [
      ["home", "Home"], ["discover", "Discover creators"], ["create", "Create a Stall"],
    ];
    if (state.user) links.push(["dashboard", "Dashboard"]);
    if (state.user?.role === "admin") links.push(["admin", "Admin"]);
    return `<header class="site-header"><nav class="container nav" aria-label="Main navigation">
      <a class="brand" href="/#home" aria-label="DonateMeTube home"><span class="brand-mark">D<span>+</span></span><span class="brand-name">Donate<em>Me</em>Tube</span></a>
      <button class="nav-toggle" type="button" aria-label="Toggle menu" aria-expanded="${state.menuOpen}">☰</button>
      <div class="nav-links${state.menuOpen ? " open" : ""}">${links.map(([route, label]) => `<a class="${active === route ? "active" : ""}" href="/#${route}">${label}</a>`).join("")}</div>
      <div class="nav-actions">${state.user
        ? `${state.user.role === "admin" ? `<a class="nav-account" href="/#admin">Admin</a>` : ""}<a class="nav-account" href="/#dashboard">${esc(state.user.display_name)}</a><button class="button button-small button-quiet" data-action="logout" type="button">Log out</button>`
        : `<a class="nav-account" href="/#login">Log in</a><a class="button button-small" href="/#register">Get started</a>`}
      </div>
    </nav></header>`;
  }

  function footer() {
    return `<footer class="site-footer"><div class="container footer-inner">
      <div><a class="brand" href="/#home"><span class="brand-mark">D<span>+</span></span><span class="brand-name">Donate<em>Me</em>Tube</span></a><p class="footer-brand">A little support goes a long way.</p></div>
      <nav class="footer-links" aria-label="Footer">${[["about", "About"], ["contact", "Contact"], ["terms", "Terms of Service"], ["privacy", "Privacy Policy"]].map(([route, label]) => `<a href="/#${route}">${label}</a>`).join("")}</nav>
    </div></footer>`;
  }

  function shell(content, active = "") {
    app.innerHTML = `${header(active)}<main>${content}</main>${footer()}<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>`;
    app.querySelectorAll("[data-progress]").forEach((node) => {
      const progress = Number(node.dataset.progress);
      node.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    });
    app.querySelectorAll("[data-bar-height]").forEach((node) => {
      const height = Number(node.dataset.barHeight);
      node.style.height = `${Math.max(7, Math.min(100, height))}%`;
    });
  }

  function avatar(stall, extra = "") {
    const label = esc(stall.creator_name || "Creator");
    return `<div class="avatar ${extra}">${stall.avatar_url ? `<img src="${esc(stall.avatar_url)}" alt="${label} profile picture" loading="lazy">` : esc(initials(stall.creator_name))}</div>`;
  }

  function card(stall) {
    const goal = stall.goal_cents ? `<div class="goal-mini"><div class="progress-label"><span>Test goal progress</span><strong>${stall.goal_progress}%</strong></div><div class="progress-track"><div class="progress-fill" data-progress="${stall.goal_progress}"></div></div></div>` : "";
    return `<article class="creator-card">${`<div class="creator-card-top">${avatar(stall)}<div><h3>${esc(stall.creator_name)}</h3><p class="creator-handle">@${esc(stall.username)}</p></div></div>`}
      <p class="creator-bio">${esc(stall.bio)}</p>${goal}
      <div class="card-bottom"><span class="test-amount">${money(stall.test_raised_cents)} test support</span><a class="small-link" href="/${encodeURIComponent(stall.slug)}">Visit Stall →</a></div>
    </article>`;
  }

  function emptyStalls() {
    return `<div class="empty-state">No Stalls yet. Be the first creator to make one.</div>`;
  }

  async function renderHome() {
    const result = await api("/api/stalls");
    const stalls = result.stalls;
    const featured = stalls.filter((stall) => stall.test_donations > 0);
    shell(`<div class="container"><section class="hero"><div class="hero-inner">
      <div><p class="eyebrow"><span class="eyebrow-dot"></span> A home for every creator</p>
        <h1>Support the<br>Creators You <span>Love.</span></h1>
        <p class="hero-copy">Every creator deserves a chance. Start supporting your favorite creators or create your own Stall today, even with zero subscribers.</p>
        <div class="hero-actions"><a class="button button-lime" href="/#discover">Discover creators <span aria-hidden="true">→</span></a><a class="button button-quiet" href="/#create">Create your Stall</a></div>
        <p class="hero-note">No follower count required. No real payments in test mode.</p>
      </div><div class="hero-visual" aria-hidden="true"><span class="hero-spark spark-one">✳</span><div class="support-card"><div class="support-card-top"><div class="avatar">A</div><div><p class="support-name">A creator's corner</p><p class="support-handle">Your support, their next idea</p></div></div><hr class="support-divider"><p class="support-amount">A little goes a long way</p><p class="support-label">Every Stall starts somewhere.</p><span class="support-pill">Made for creators at every stage</span></div><span class="hero-spark spark-two">+</span></div>
    </div></section>
    <section class="section"><div class="section-heading"><div><p class="eyebrow green-kicker">Community picks</p><h2>Featured creators</h2><p>Creators with confirmed test support, surfaced from the Stalls people have made.</p></div><a class="section-link" href="/#discover">Explore all creators →</a></div>
      <div class="card-grid">${featured.length ? featured.slice(0, 3).map(card).join("") : `<div class="empty-state">Creators with confirmed test support will be featured here.</div>`}</div></section>
    <section class="section section-tight"><div class="section-heading"><div><p class="eyebrow green-kicker">Fresh starts</p><h2>Recently created Stalls</h2><p>Every creator starts somewhere. See who just set up their space.</p></div></div>
      <div class="card-grid">${stalls.length ? [...stalls].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 3).map(card).join("") : emptyStalls()}</div></section>
    <section class="section"><div class="section-heading"><div><p class="eyebrow green-kicker">How it works</p><h2>Simple support, real impact.</h2><p>No subscriber thresholds. No complicated setup. Just a place for creators and supporters to meet.</p></div></div>
      <div class="how-grid"><article class="how-step"><span class="step-number">01</span><h3>Make your Stall</h3><p>Sign up, tell people what you create, and share your one-of-a-kind page.</p></article><article class="how-step"><span class="step-number">02</span><h3>Find your people</h3><p>Share your Stall with your audience or help new creators get discovered.</p></article><article class="how-step"><span class="step-number">03</span><h3>Support the work</h3><p>Try a clearly labeled test donation. No money changes hands in this version.</p></article></div>
    </section><section class="callout"><div><h2>Your audience starts with one person.</h2><p>Create a Stall and give supporters a simple way to say thanks.</p></div><a class="button" href="/#create">Create your Stall →</a></section></div>`, "home");
  }

  async function renderDiscover() {
    const params = new URLSearchParams(state.search ? { q: state.search } : {});
    const result = await api(`/api/stalls?${params}`);
    shell(`<div class="container"><section class="page-intro"><p class="eyebrow"><span class="eyebrow-dot"></span> Find your next favorite</p><h1>Discover creators</h1><p>Explore real Stalls made by creators at every stage. Search by creator name or username.</p></section>
      <form class="search-row" id="search-form"><label class="search-wrap"><span class="search-icon" aria-hidden="true">⌕</span><span class="sr-only">Search creators</span><input name="q" value="${esc(state.search)}" placeholder="Search creators or usernames…" maxlength="80"></label><button class="button" type="submit">Search</button></form>
      <div class="card-grid">${result.stalls.length ? result.stalls.map(card).join("") : state.search ? `<div class="empty-state">No creators found for “${esc(state.search)}”. Try another search.</div>` : emptyStalls()}</div>
    </div>`, "discover");
  }

  function pageIntro(kicker, title, copy = "") {
    return `<section class="page-intro"><p class="eyebrow"><span class="eyebrow-dot"></span> ${esc(kicker)}</p><h1>${esc(title)}</h1>${copy ? `<p>${esc(copy)}</p>` : ""}</section>`;
  }

  function authCard(title, subtitle, fields, submit, foot, extra = "") {
    return `<div class="container auth-wrap"><section class="auth-card"><h1>${title}</h1><p>${subtitle}</p><form data-form="${submit}" novalidate>${fields}<p class="field-error" data-error></p><button class="button" type="submit">${submit === "login" ? "Log in" : submit === "register" ? "Create account" : submit === "reset" ? "Send reset link" : "Update password"}</button></form>${extra}<p class="auth-foot">${foot}</p></section></div>`;
  }

  function renderLogin() {
    shell(authCard("Welcome back", "Sign in to manage your Stall and account.", `<div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128"></div>`, "login", `New to DonateMeTube? <a href="/#register">Create an account</a>`, `<div class="link-row"><span></span><a href="/#forgot">Forgot password?</a></div>`), "login");
  }

  function renderRegister() {
    shell(authCard("Create your account", "Start your creator journey. You can make one Stall for each account.", `<div class="field"><label for="display_name">Your name</label><input id="display_name" name="display_name" autocomplete="name" required maxlength="60"></div><div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_]+" aria-describedby="username-hint"><small id="username-hint">3–24 letters, numbers, or underscores. This will be your Stall URL.</small></div><div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required maxlength="128"><small>Use at least 10 characters.</small></div>`, "register", `Already have an account? <a href="/#login">Log in</a>`), "register");
  }

  function renderForgot() {
    shell(authCard("Reset your password", "Enter your account email. In this development version, reset instructions are written to the server console.", `<div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email"></div>`, "forgot", `Remembered your password? <a href="/#login">Log in</a>`), "login");
  }

  function renderReset(token) {
    shell(authCard("Choose a new password", "Reset links expire after 30 minutes and can be used once.", `<input name="token" type="hidden" value="${esc(token)}"><div class="field"><label for="password">New password</label><input id="password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password"></div>`, "reset-password", `Back to <a href="/#login">log in</a>`), "login");
  }

  async function renderCreate() {
    if (!state.user) {
      shell(`<div class="container auth-wrap"><section class="auth-card"><h1>Every creator can start here.</h1><p>Create a free account to make your one personal Stall. Zero subscribers? That's okay.</p><a class="button" href="/#register">Create an account</a><p class="auth-foot">Already registered? <a href="/#login">Log in</a></p></section></div>`, "create");
      return;
    }
    if (state.ownStall) {
      shell(`<div class="container auth-wrap"><section class="auth-card"><h1>Your Stall is ready.</h1><p>This account already has its one Stall. Edit its details from your creator dashboard.</p><a class="button" href="/#dashboard">Open creator dashboard</a><p class="auth-foot"><a href="/${encodeURIComponent(state.ownStall.slug)}">Visit your public Stall</a></p></section></div>`, "create");
      return;
    }
    shell(`<div class="container"><section class="page-intro"><p class="eyebrow"><span class="eyebrow-dot"></span> Your own corner of the internet</p><h1>Create your Stall</h1><p>Set up your one personal creator page. Your username becomes your unique Stall URL.</p></section>
      <section class="panel narrow-panel"><form data-form="create-stall" novalidate>
        <div class="field-row"><div class="field"><label for="creator_name">Creator or channel name</label><input id="creator_name" name="creator_name" value="${esc(state.user.display_name)}" maxlength="60" required></div><div class="field"><label>Your Stall URL</label><input value="donateme.tube/${esc(state.user.username)}" disabled></div></div>
        <div class="field"><label for="bio">What do you create?</label><textarea id="bio" name="bio" maxlength="500" required placeholder="Tell people what you make and what their support helps you do."></textarea></div>
        <div class="field"><label for="goal">Optional test donation goal</label><input id="goal" name="goal" type="number" min="1" max="10000" step="0.01" placeholder="Leave blank if you don't have a goal"><small>Optional. Test donations never represent real earnings.</small></div>
        <div class="field-row"><div class="field"><label for="instagram">Instagram link <span class="field-hint">optional</span></label><input id="instagram" name="instagram" type="url" placeholder="https://…"></div><div class="field"><label for="youtube">YouTube link <span class="field-hint">optional</span></label><input id="youtube" name="youtube" type="url" placeholder="https://…"></div></div>
        <div class="field-row"><div class="field"><label for="tiktok">TikTok link <span class="field-hint">optional</span></label><input id="tiktok" name="tiktok" type="url" placeholder="https://…"></div><div class="field"><label for="website">Website <span class="field-hint">optional</span></label><input id="website" name="website" type="url" placeholder="https://…"></div></div>
        <p class="field-error" data-error></p><button class="button" type="submit">Create my one Stall →</button>
      </form></section></div>`, "create");
  }

  async function renderStall(slug) {
    let stall;
    try { stall = (await api(`/api/stalls/${encodeURIComponent(slug)}`)).stall; }
    catch (error) {
      shell(`<div class="container">${pageIntro("Stall not found", "We couldn't find that creator.", error.message)}<a class="button" href="/#discover">Discover creators</a></div>`);
      return;
    }
    const goal = stall.goal_cents ? `<div class="goal-box"><div class="progress-label"><span>Test goal progress</span><strong>${stall.goal_progress}%</strong></div><div class="progress-track"><div class="progress-fill" data-progress="${stall.goal_progress}"></div></div><div class="progress-label"><span>${money(stall.test_raised_cents)} test support</span><span>Goal ${money(stall.goal_cents)}</span></div></div>` : `<p class="test-amount">${money(stall.test_raised_cents)} confirmed test support</p>`;
    const socialLabels = { instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok", website: "Website" };
    shell(`<div class="container">
      <section class="stall-banner">${avatar(stall, "avatar-large")}<div class="stall-banner-copy"><p class="stall-handle">@${esc(stall.username)}</p><h1>${esc(stall.creator_name)}</h1><p>Creator on DonateMeTube · Joined ${dateShort(stall.created_at)}</p></div>${state.user && state.ownStall && state.ownStall.slug === stall.slug ? `<a class="button button-quiet" href="/#dashboard">Edit Stall</a>` : ""}</section>
      <div class="stall-columns"><section class="panel"><h2>About this creator</h2><p>${esc(stall.bio)}</p><div class="creator-socials">${Object.entries(stall.socials || {}).map(([key, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${socialLabels[key] || "Social"} ↗</a>`).join("")}</div><p class="report-action">Something not right? <button class="text-button" data-action="report" data-slug="${esc(stall.slug)}">Report this Stall</button></p></section>
        <aside class="panel"><h2>Support this creator</h2><span class="test-label">Test mode · No real payment</span><div class="stall-goal-wrap">${goal}</div>
          <div class="donate-form" id="donate-area"><h3>Leave a little encouragement</h3><p>This demo flow records a test transaction only. No card details or money are collected.</p>
          <form data-form="donate-review"><div class="amount-options">${[5, 10, 25].map((amount) => `<button class="amount-choice" type="button" data-amount="${amount}">$${amount}</button>`).join("")}</div>
            <div class="field"><label for="donation-amount">Donation amount (USD)</label><input id="donation-amount" name="amount" type="number" value="5" min="1" max="10000" step="0.01" required></div>
            <div class="field"><label for="supporter-name">Your name</label><input id="supporter-name" name="supporter_name" maxlength="60" required></div>
            <div class="field"><label for="supporter-message">Message <span class="field-hint">optional</span></label><textarea id="supporter-message" name="message" maxlength="240" placeholder="Share a kind word…"></textarea></div>
            <p class="field-error" data-error></p><button class="button" type="submit">Review test donation →</button></form></div>
          <div class="report-action">Test donations: ${stall.test_donations} · Test supporters: ${stall.test_supporters}</div>
        </aside></div>
    </div>`);
  }

  async function renderDashboard() {
    if (!state.user) {
      location.hash = "login";
      return;
    }
    const data = await api("/api/dashboard");
    if (!data.stall) {
      shell(`<div class="container">${pageIntro("Creator dashboard", "Your creator journey starts here.", "You haven't created a Stall yet.")}<a class="button" href="/#create">Create your Stall</a></div>`, "create");
      return;
    }
    const transactionRows = data.transactions.length ? data.transactions.map((item) => `<tr><td>${dateShort(item.created_at)}</td><td>${esc(item.supporter_name)}${item.message ? `<br><span class="muted-inline">${esc(item.message)}</span>` : ""}</td><td>${money(item.amount_cents)}</td><td><span class="status-pill status-${esc(item.status)}">${esc(item.status)} · test</span></td></tr>`).join("") : `<tr><td colspan="4" class="empty-table-cell">No test donations yet.</td></tr>`;
    const historyMax = Math.max(1, ...data.history.map((item) => item.amount_cents));
    const bars = data.history.length ? data.history.map((item) => `<div class="history-bar" title="${esc(item.day)}: ${money(item.amount_cents)}" data-bar-height="${Math.max(7, Math.round(item.amount_cents * 100 / historyMax))}"></div>`).join("") : `<div class="empty-state history-empty">Your earnings history will appear after a test donation.</div>`;
    const stall = data.stall;
    shell(`<div class="container">
      <div class="dashboard-head"><section class="page-intro"><p class="eyebrow"><span class="eyebrow-dot"></span> Your creator space</p><h1>Creator dashboard</h1><p>Welcome back, ${esc(state.user.display_name)}. This account can manage one Stall.</p></section><a class="button button-quiet" href="/${encodeURIComponent(stall.slug)}">View public Stall ↗</a></div>
      <div class="notice notice-warn"><strong>Test mode:</strong> these transactions are test records, not real payments or cash earnings. Real earnings: $0.00.</div>
      <section class="stats-grid"><article class="stat-card"><div class="stat-label">Confirmed test support</div><div class="stat-value">${money(data.totals.raised)}</div><div class="stat-sub">Not real earnings</div></article><article class="stat-card"><div class="stat-label">Confirmed test donations</div><div class="stat-value">${data.totals.donations}</div><div class="stat-sub">Test records only</div></article><article class="stat-card"><div class="stat-label">Test supporters</div><div class="stat-value">${data.totals.supporters}</div><div class="stat-sub">Based on confirmed tests</div></article><article class="stat-card"><div class="stat-label">Test goal progress</div><div class="stat-value">${stall.goal_progress === null ? "—" : `${stall.goal_progress}%`}</div><div class="stat-sub">${stall.goal_cents ? `${money(stall.test_raised_cents)} of ${money(stall.goal_cents)}` : "No goal set"}</div></article></section>
      <div class="dashboard-grid"><section class="panel"><h2>Recent test transactions</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Supporter</th><th>Amount</th><th>Status</th></tr></thead><tbody>${transactionRows}</tbody></table></div></section>
      <section class="panel"><h2>Test support history</h2><div class="history-bars" aria-label="Confirmed test donation history">${bars}</div><div class="history-caption"><span>${data.history.length ? esc(data.history[0].day) : "No history yet"}</span><span>${data.history.length ? esc(data.history[data.history.length - 1].day) : ""}</span></div></section></div>
      <section class="section section-tight"><div class="section-heading"><div><p class="eyebrow green-kicker">Make it yours</p><h2>Edit your Stall</h2><p>Your public profile details and account email are private to your dashboard.</p></div></div>
        <div class="panel"><form data-form="edit-stall" novalidate><div class="avatar-editor">${avatar(stall, "avatar-large")}<div><label class="field-label" for="avatar-file">Profile picture</label><input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp"><small class="field-hint">Images are resized in your browser and stored locally.</small></div></div>
          <div class="field-row"><div class="field"><label for="creator_name">Creator name</label><input id="creator_name" name="creator_name" value="${esc(stall.creator_name)}" maxlength="60" required></div><div class="field"><label for="stall-username">Stall username / URL</label><input id="stall-username" name="username" value="${esc(stall.username)}" maxlength="24" required></div></div>
          <div class="field"><label for="bio">Description</label><textarea id="bio" name="bio" maxlength="500" required>${esc(stall.bio)}</textarea></div>
          <div class="field"><label for="goal">Optional test donation goal</label><input id="goal" name="goal" type="number" min="1" max="10000" step="0.01" value="${stall.goal_cents ? stall.goal_cents / 100 : ""}" placeholder="Leave blank for no goal"></div>
          <div class="field-row">${["instagram", "youtube", "tiktok", "website"].map((key) => `<div class="field"><label for="${key}">${key[0].toUpperCase() + key.slice(1)} link</label><input id="${key}" name="${key}" type="url" value="${esc(stall.socials[key] || "")}" placeholder="https://…"></div>`).join("")}</div>
          <p class="field-error" data-error></p><button class="button" type="submit">Save Stall changes</button></form></div>
      </section>
      <section class="section section-tight"><div class="panel"><h2>Account information</h2><form data-form="account" novalidate><div class="field-row"><div class="field"><label for="account-name">Your name</label><input id="account-name" name="display_name" value="${esc(data.account.display_name)}" maxlength="60" required></div><div class="field"><label for="account-email">Email address (private)</label><input id="account-email" name="email" type="email" value="${esc(data.account.email)}" maxlength="254" required></div></div><p class="field-error" data-error></p><button class="button button-quiet" type="submit">Save account changes</button></form></div></section>
    </div>`, "dashboard");
  }

  async function renderAdmin() {
    if (!state.user) { location.hash = "login"; return; }
    const data = await api("/api/admin/overview");
    const userRows = data.users.map((user) => `<tr><td>${esc(user.display_name)}<br><span class="muted-inline">${esc(user.email)}</span></td><td>@${esc(user.username)}</td><td>${esc(user.role)} · ${user.suspended ? "suspended" : "active"}</td><td>${user.role === "admin" ? "—" : `<button class="button ${user.suspended ? "button-quiet" : "button-danger"}" data-action="suspend" data-id="${user.id}" data-suspended="${!user.suspended}">${user.suspended ? "Restore" : "Suspend"}</button>`}</td></tr>`).join("") || `<tr><td colspan="4">No accounts.</td></tr>`;
    const stallRows = data.stalls.map((stall) => `<tr><td><a href="/${encodeURIComponent(stall.slug)}">@${esc(stall.slug)}</a></td><td>${esc(stall.creator_name)}</td><td>${esc(stall.email)}</td><td>${stall.suspended ? "Suspended" : "Active"}</td></tr>`).join("") || `<tr><td colspan="4">No Stalls.</td></tr>`;
    const reportRows = data.reports.map((report) => `<tr><td>@${esc(report.slug)}</td><td>${esc(report.reason)}<br><span class="muted-inline">${esc(report.details)}</span></td><td><span class="status-pill status-${esc(report.status)}">${esc(report.status)}</span></td><td>${report.status === "open" ? `<div class="admin-actions"><button class="button button-small" data-action="report-status" data-id="${report.id}" data-status="resolved">Resolve</button><button class="button button-small button-quiet" data-action="report-status" data-id="${report.id}" data-status="dismissed">Dismiss</button></div>` : "—"}</td></tr>`).join("") || `<tr><td colspan="4">No reports.</td></tr>`;
    const txRows = data.transactions.map((tx) => `<tr><td>${dateShort(tx.created_at)}</td><td>@${esc(tx.slug)}</td><td>${money(tx.amount_cents)}</td><td><span class="status-pill status-${esc(tx.status)}">${esc(tx.status)} · ${esc(tx.payment_mode)}</span></td></tr>`).join("") || `<tr><td colspan="4">No transactions.</td></tr>`;
    shell(`<div class="container">${pageIntro("Restricted area", "Administration", "Manage accounts, creator Stalls, content reports, and test transaction records.")}<div class="notice notice-warn">Admin access is server-authorized. Payments in this app are test-mode only.</div>
      <section class="admin-section panel"><h2>Registered accounts (${data.users.length})</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Account</th><th>Username</th><th>Status</th><th>Action</th></tr></thead><tbody>${userRows}</tbody></table></div></section>
      <section class="admin-section panel"><h2>Creator Stalls (${data.stalls.length})</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Stall</th><th>Creator</th><th>Account email</th><th>Status</th></tr></thead><tbody>${stallRows}</tbody></table></div></section>
      <section class="admin-section panel"><h2>Reported content</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Stall</th><th>Report</th><th>Status</th><th>Action</th></tr></thead><tbody>${reportRows}</tbody></table></div></section>
      <section class="admin-section panel"><h2>Transaction records</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Stall</th><th>Amount</th><th>Status</th></tr></thead><tbody>${txRows}</tbody></table></div></section>
    </div>`, "admin");
  }

  function renderLegal(route) {
    const legal = {
      about: ["About DonateMeTube", `<h2>Built for creators at every stage</h2><p>DonateMeTube gives independent creators one simple place to introduce their work and invite support. You do not need subscribers, followers, or an audience minimum to make a Stall.</p><h2>A note about payments</h2><p>This first version uses a clearly labeled test-payment flow only. It does not collect money, process cards, or represent test transactions as real earnings.</p>`],
      contact: ["Contact", `<h2>Get in touch</h2><p>For product questions or support, contact the administrator responsible for this DonateMeTube site. Do not send passwords, payment details, or other sensitive information in a support request.</p><p>To report a creator Stall, use the “Report this Stall” link on its public page.</p>`],
      terms: ["Terms of Service", `<p>By using DonateMeTube, you agree to use the service lawfully and respectfully. Do not impersonate others, post unlawful or abusive content, spam creators, or attempt to access another person's account or private information.</p><h2>Test mode and money</h2><p>All donations in this version are test transactions. No payment provider is connected, no card information is requested or stored, and no real money is charged or paid out. Test totals are not earnings.</p><h2>Accounts and Stalls</h2><p>Each account may create one Stall. You are responsible for your account credentials and the content you publish. We may suspend accounts or remove Stalls that violate these terms.</p><h2>Availability</h2><p>The service is provided as an early version and may change. Do not rely on it for payment processing, financial records, or time-critical services.</p>`],
      privacy: ["Privacy Policy", `<p>DonateMeTube stores account email addresses and password hashes, public Stall details, reports, and test transaction records in its database. Passwords are hashed; raw card details are never collected.</p><h2>Public information</h2><p>Your Stall name, username, description, optional profile picture, links, test goal, and clearly labeled test totals are publicly visible. Your email address, account password hash, and dashboard details are not public.</p><h2>Test transactions</h2><p>Test records may contain the supporter name and optional message entered for that test. Those details are available to the Stall owner and authorized administrators. Do not enter sensitive personal information.</p><h2>Local development</h2><p>Password-reset tokens are printed only to the local development server console because no email provider is configured. A production deployment must configure a secure email delivery service and secret management before enabling account recovery.</p><h2>Data and security</h2><p>This initial version stores data in a local SQLite database. Do not expose a development deployment to the public internet. Contact the site operator about privacy requests.</p>`],
    };
    const [title, body] = legal[route];
    shell(`<div class="container">${pageIntro("DonateMeTube", title)}<article class="legal-copy">${body}</article></div>`);
  }

  async function render() {
    state.menuOpen = false;
    try {
      const slug = pathSlug();
      if (slug) return await renderStall(slug);
      const route = hashRoute();
      if (route === "home") return await renderHome();
      if (route === "discover") return await renderDiscover();
      if (route === "create") return await renderCreate();
      if (route === "login") return renderLogin();
      if (route === "register") return renderRegister();
      if (route === "forgot") return renderForgot();
      if (route === "reset") {
        const token = new URLSearchParams(location.hash.split("?")[1] || "").get("token") || "";
        return renderReset(token);
      }
      if (route === "dashboard") return await renderDashboard();
      if (route === "admin") return await renderAdmin();
      if (["about", "contact", "terms", "privacy"].includes(route)) return renderLegal(route);
      location.hash = "home";
    } catch (error) {
      shell(`<div class="container">${pageIntro("Something went wrong", "We couldn't load this page.", error.message)}<button class="button" data-action="retry">Try again</button></div>`);
    }
  }

  function formValues(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function socialValues(values) {
    return Object.fromEntries(["instagram", "youtube", "tiktok", "website"].filter((key) => values[key]).map((key) => [key, values[key]]));
  }

  function showFormError(form, message) {
    const target = form.querySelector("[data-error]");
    if (target) target.textContent = message;
    else toast(message, true);
  }

  async function handleSubmit(form) {
    const type = form.dataset.form;
    const values = formValues(form);
    const button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.dataset.original = button.textContent; button.textContent = "Please wait…"; }
    try {
      if (type === "login" || type === "register") {
        const result = await api(`/api/${type}`, { method: "POST", body: JSON.stringify(values) });
        state.user = result.user;
        state.csrf = result.csrf_token;
        await refreshSession();
        location.hash = "dashboard";
        return;
      }
      if (type === "forgot") {
        const result = await api("/api/password-reset/request", { method: "POST", body: JSON.stringify(values) });
        form.innerHTML = `<div class="notice">${esc(result.message)} Check the local development server console for a reset link.</div><a class="button" href="/#login">Back to log in</a>`;
        return;
      }
      if (type === "reset-password") {
        const result = await api("/api/password-reset/complete", { method: "POST", body: JSON.stringify(values) });
        toast(result.message);
        location.hash = "login";
        return;
      }
      if (type === "create-stall") {
        await api("/api/stalls", { method: "POST", body: JSON.stringify({ ...values, socials: socialValues(values) }) });
        await refreshSession();
        toast("Your Stall is live.");
        location.hash = "dashboard";
        return;
      }
      if (type === "donate-review") {
        const result = await api("/api/donations/start", { method: "POST", body: JSON.stringify({ ...values, slug: pathSlug(), idempotency_key: crypto.randomUUID() }) });
        const amount = money(result.amount_cents);
        const area = document.querySelector("#donate-area");
        area.innerHTML = `<div class="donation-review"><span class="test-label">Test payment review</span><p class="donation-intro">You're testing a donation of</p><strong>${amount}</strong><p class="donation-disclaimer">No real money will be charged. Choose a test outcome below.</p><div class="payment-actions"><button class="button" data-action="complete-donation" data-outcome="confirm" data-id="${esc(result.transaction_id)}">Confirm test donation</button><button class="button button-quiet" data-action="complete-donation" data-outcome="decline" data-id="${esc(result.transaction_id)}">Simulate declined test payment</button></div></div>`;
        return;
      }
      if (type === "edit-stall") {
        const goal = values.goal;
        await api("/api/stall", { method: "PUT", body: JSON.stringify({ ...values, goal: goal || null, socials: socialValues(values) }) });
        await refreshSession();
        toast("Stall details saved.");
        await renderDashboard();
        return;
      }
      if (type === "account") {
        await api("/api/account", { method: "PUT", body: JSON.stringify(values) });
        await refreshSession();
        toast("Account information saved.");
        await renderDashboard();
      }
    } catch (error) {
      showFormError(form, error.message);
    } finally {
      if (button && button.isConnected) { button.disabled = false; button.textContent = button.dataset.original || button.textContent; }
    }
  }

  async function refreshSession() {
    const result = await api("/api/session");
    state.user = result.user;
    state.ownStall = result.stall;
    state.csrf = result.csrf_token;
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    button.disabled = true;
    try {
      if (action === "logout") {
        const result = await api("/api/logout", { method: "POST", body: "{}" });
        state.user = null;
        state.ownStall = null;
        state.csrf = result.csrf_token;
        location.hash = "home";
        return;
      }
      if (action === "retry") return render();
      if (action === "complete-donation") {
        const result = await api(`/api/donations/${encodeURIComponent(button.dataset.id)}/complete`, { method: "POST", body: JSON.stringify({ outcome: button.dataset.outcome }) });
        const succeeded = result.status === "confirmed";
        document.querySelector("#donate-area").innerHTML = `<div class="notice${succeeded ? "" : " notice-warn"}"><strong>${succeeded ? "Test donation confirmed!" : "Test payment declined."}</strong><br>${succeeded ? "It is recorded as test support only. No money changed hands." : "This test transaction was not added to support totals. No money changed hands."}</div><button class="button button-quiet" data-action="reload-stall">Back to Stall</button>`;
        return;
      }
      if (action === "reload-stall") return renderStall(pathSlug());
      if (action === "report") {
        const reason = prompt("Why are you reporting this Stall? Enter spam, harassment, misleading, or other.");
        if (!reason) return;
        const allowed = ["spam", "harassment", "misleading", "other"];
        const normalized = reason.trim().toLowerCase();
        if (!allowed.includes(normalized)) throw new Error("Choose spam, harassment, misleading, or other.");
        const details = prompt("Add any helpful details (optional).") || "";
        const result = await api("/api/reports", { method: "POST", body: JSON.stringify({ slug: button.dataset.slug, reason: normalized, details }) });
        toast(result.message);
        return;
      }
      if (action === "suspend") {
        await api(`/api/admin/users/${button.dataset.id}/suspend`, { method: "POST", body: JSON.stringify({ suspended: button.dataset.suspended === "true" }) });
        toast("Account status updated.");
        return renderAdmin();
      }
      if (action === "report-status") {
        await api(`/api/admin/reports/${button.dataset.id}`, { method: "POST", body: JSON.stringify({ status: button.dataset.status }) });
        toast("Report updated.");
        return renderAdmin();
      }
    } catch (error) {
      toast(error.message, true);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  async function handleAvatar(input) {
    const file = input.files?.[0];
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast("Choose a PNG, JPEG, or WebP image.", true);
      input.value = "";
      return;
    }
    if (file.size > 10_000_000) {
      toast("Choose an image smaller than 10 MB.", true);
      input.value = "";
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 384 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const dataUrl = canvas.toDataURL("image/webp", 0.82);
      if (dataUrl.length > 500_000) throw new Error("That picture is too large. Choose a simpler image.");
      await api("/api/stall/avatar", { method: "POST", body: JSON.stringify({ image: dataUrl }) });
      toast("Profile picture updated.");
      await renderDashboard();
    } catch (error) {
      toast(error.message || "That image could not be processed.", true);
    } finally {
      input.value = "";
    }
  }

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("form");
    if (!form) return;
    event.preventDefault();
    if (form.id === "search-form") {
      state.search = new FormData(form).get("q").trim();
      renderDiscover();
      return;
    }
    if (!form.reportValidity()) return;
    handleSubmit(form);
  });

  document.addEventListener("click", (event) => {
    const amount = event.target.closest("[data-amount]");
    if (amount) {
      const input = document.querySelector("#donation-amount");
      if (input) input.value = amount.dataset.amount;
      document.querySelectorAll(".amount-choice").forEach((item) => item.classList.toggle("selected", item === amount));
      return;
    }
    const action = event.target.closest("[data-action]");
    if (action) handleAction(action);
    const toggle = event.target.closest(".nav-toggle");
    if (toggle) {
      state.menuOpen = !state.menuOpen;
      toggle.setAttribute("aria-expanded", String(state.menuOpen));
      document.querySelector(".nav-links")?.classList.toggle("open", state.menuOpen);
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "avatar-file") handleAvatar(event.target);
  });

  window.addEventListener("hashchange", () => render());
  window.addEventListener("popstate", () => render());

  (async () => {
    try {
      await refreshSession();
      await render();
    } catch (error) {
      shell(`<div class="container">${pageIntro("Connection issue", "DonateMeTube is unavailable.", error.message)}<button class="button" data-action="retry">Try again</button></div>`);
    }
  })();
})();
