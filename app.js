/* Retro Poker Club — app logic */

(function () {
  "use strict";

  // ================= State =================
  const state = {
    currentView: "nights",
    currentTab: "nights",
    currentNightId: null,
    currentPlayerId: null,
    nightDetailReturnTo: "nights", // 'nights' | 'player-detail'
    settingsReturnTab: "nights",
    liveNightId: null, // the single open event shown in the header pot strip
  };

  const EUR = "\u20AC";
  const TAB_ROOTS = ["nights", "leaderboard", "players", "chips"];

  // ================= Helpers =================
  const $ = (id) => document.getElementById(id);

  function round2(n) {
    const v = Number(n);
    return (Math.sign(v) * Math.round(Math.abs(v) * 100 + 1e-7)) / 100;
  }

  function fmtMoney(n) {
    return EUR + round2(n || 0).toFixed(2);
  }

  function fmtSigned(n) {
    const v = round2(n || 0);
    if (v > 0) return "+" + EUR + v.toFixed(2);
    if (v < 0) return "-" + EUR + Math.abs(v).toFixed(2);
    return EUR + v.toFixed(2);
  }

  function amountClass(n) {
    const v = round2(n || 0);
    if (v > 0) return "amount-pos";
    if (v < 0) return "amount-neg";
    return "amount-zero";
  }

  // European format: dd.mm.yyyy
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : ""; // anything else is not a date: show nothing
  }

  // Date field shown as dd.mm.yyyy whatever the phone's language. The real
  // value (yyyy-mm-dd) lives in a hidden native picker with id `f-date`,
  // which the calendar button opens.
  function dateField(iso) {
    return `
      <div class="date-field">
        <input type="text" id="f-date-text" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="dd.mm.yyyy" value="${escapeHtml(fmtDate(iso))}">
        <button type="button" class="date-pick" id="f-date-pick" aria-label="Pick a date">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>
        </button>
        <input type="date" id="f-date" class="date-native" value="${escapeHtml(iso)}" tabindex="-1" aria-hidden="true">
      </div>`;
  }
  function parseDate(text) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(text).trim());
    if (!m) return "";
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
    return dt.toISOString().slice(0, 10);
  }
  function bindDateField() {
    const text = $("f-date-text");
    const native = $("f-date");
    $("f-date-pick").addEventListener("click", () => {
      try {
        native.showPicker();
      } catch (_) {
        native.focus();
        native.click();
      }
    });
    native.addEventListener("change", () => {
      if (native.value) text.value = fmtDate(native.value);
    });
    text.addEventListener("input", () => {
      // add the dots while typing: 21112026 -> 21.11.2026
      const digits = text.value.replace(/\D/g, "").slice(0, 8);
      text.value = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join(".");
      native.value = parseDate(text.value);
    });
  }

  function todayISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  // Escapes text for use in HTML content AND inside attribute values.
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function cleanName(s) {
    return String(s || "").trim().replace(/\s+/g, " ");
  }

  function sameName(a, b) {
    return cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
  }

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // Short message at the bottom. Optional action button, e.g. { label: "Undo", run: fn }.
  function toast(msg, action) {
    const t = $("toast");
    t.textContent = msg;
    if (action) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "toast-action";
      b.textContent = action.label;
      b.addEventListener("click", () => {
        t.hidden = true;
        Promise.resolve(action.run()).catch(handleError);
      }, { once: true });
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toast._h);
    toast._h = setTimeout(() => (t.hidden = true), action ? 5000 : 2400);
  }

  // Like mutate, but the change shows on screen immediately and is saved in the
  // background: no waiting for the server on a weak signal. If saving fails,
  // `undo` takes the change back off the screen and the error is shown.
  // Both functions must be safe to run twice (they may be re-applied on a retry).
  async function mutateOptimistic(store, id, change, undo) {
    const local = await DB.read(store, id); // the saved copy, no waiting
    if (!local || change(local) === false) return null;
    DB.setLocal(store, local);
    const saving = (async () => {
      try {
        await DB.put(store, local); // one round trip when nothing else changed
      } catch (err) {
        if (err.kind === "conflict") {
          await mutate(store, id, change); // someone else saved first: re-apply on fresh data
          return;
        }
        const cur = await DB.read(store, id);
        if (cur && undo(cur) !== false) DB.setLocal(store, cur);
        throw err;
      }
    })();
    return { saving };
  }

  // Read-modify-save on one record, retried if someone else saved it at the
  // same moment (so a buy-in tapped by two admins at once is never lost).
  // `change` edits the object in place; returning false cancels the save.
  async function mutate(store, id, change, tries = 3) {
    for (let i = 0; ; i++) {
      const obj = await DB.get(store, id);
      if (!obj) return null;
      if (change(obj) === false) return null;
      try {
        await DB.put(store, obj);
        return obj;
      } catch (err) {
        if (err.kind !== "conflict" || i >= tries - 1) throw err;
      }
    }
  }

  function buyinTotal(np) {
    return round2((np.buyins || []).reduce((s, b) => s + Number(b.amount || 0), 0));
  }

  function nightPotTotal(night) {
    return round2((night.players || []).reduce((s, np) => s + buyinTotal(np), 0));
  }

  // Click handler that blocks double taps: the button is disabled until the
  // async work finishes, so a quick second tap can't create duplicates.
  function onTap(button, handler) {
    button.addEventListener("click", async (e) => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await handler(e);
      } catch (err) {
        handleError(err);
      } finally {
        button.disabled = false;
      }
    });
  }

  function canEdit() {
    return !!(window.RPC_AUTH && window.RPC_AUTH.isEditor);
  }

  // One place that turns failures into a short message.
  function handleError(err) {
    console.error(err);
    const kind = err && err.kind;
    if (kind === "offline") toast("No connection \u2014 not saved. Try again when you're online");
    else if (kind === "conflict") {
      toast("Someone else just changed this \u2014 showing the latest");
      closeModal();
      refreshCurrentView();
    } else if (kind === "denied") toast("You don't have permission to do that");
    else toast("Something went wrong \u2014 please try again");
  }

  // Render guard: if a newer render of the same list started while this one
  // was waiting for the database, the older one quietly drops out instead of
  // appending a second copy of the list.
  const renderSeq = {};
  function renderToken(key) {
    renderSeq[key] = (renderSeq[key] || 0) + 1;
    return renderSeq[key];
  }
  function isStale(key, token) {
    return renderSeq[key] !== token;
  }

  // ================= Navigation =================
  function showView(name) {
    state.currentView = name;
    document.body.dataset.view = name;
    $("toast").hidden = true; // don't carry a message over to the next screen
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + name));
    if (TAB_ROOTS.includes(name)) {
      state.currentTab = name;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
    }
    window.scrollTo(0, 0);
    updatePotStrip();
    if (typeof reloadIfSafe === "function" && TAB_ROOTS.includes(name)) setTimeout(reloadIfSafe, 0);
  }

  function openTab(tab) {
    showView(tab);
    if (tab === "nights") renderNightsList();
    if (tab === "players") renderPlayersList();
    if (tab === "leaderboard") renderLeaderboard();
    if (tab === "chips") renderChipsList();
  }

  function openEvent(nightId, returnTo) {
    state.currentNightId = nightId;
    state.nightDetailReturnTo = returnTo || "nights";
    showView("night-detail");
    renderNightDetail(nightId);
  }

  function openPlayer(playerId, returnTab) {
    state.currentPlayerId = playerId;
    if (returnTab) state.playerReturnTab = returnTab;
    showView("player-detail");
    renderPlayerDetail(playerId);
  }

  // One place that knows what "back" means on every screen. Used by the
  // on-screen back arrows AND the Android back gesture.
  // Returns false when already on the home screen (Events).
  function goBack() {
    switch (state.currentView) {
      case "night-detail":
        if (state.nightDetailReturnTo === "player-detail" && state.currentPlayerId) openPlayer(state.currentPlayerId);
        else openTab("nights");
        return true;
      case "closeout":
        openEvent(state.currentNightId, state.nightDetailReturnTo);
        return true;
      case "player-detail":
        openTab(state.playerReturnTab || "players");
        return true;
      case "settings":
        openTab(state.settingsReturnTab);
        return true;
      case "members":
        openSettings();
        return true;
      case "players":
      case "leaderboard":
      case "chips":
        openTab("nights");
        return true;
      default:
        return false;
    }
  }

  function syncTabbarHeight() {
    document.documentElement.style.setProperty("--tabbar-h", $("tabbar").offsetHeight + "px");
  }
  window.addEventListener("resize", syncTabbarHeight);
  syncTabbarHeight();

  document.querySelectorAll(".tab-btn").forEach((btn) => btn.addEventListener("click", () => openTab(btn.dataset.tab)));
  document.querySelectorAll(".btn-back").forEach((btn) => btn.addEventListener("click", goBack));
  $("btn-brand-home").addEventListener("click", () => openTab("nights"));

  // ================= Modal system =================
  const backdrop = $("modal-backdrop");
  const modalRoot = $("modal-root");

  // Keep the backdrop sized to the visible viewport so the sheet sits above
  // the keyboard (fallback for browsers without interactive-widget support).
  function syncViewportHeight() {
    if (window.visualViewport) backdrop.style.height = window.visualViewport.height + "px";
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportHeight);
    window.visualViewport.addEventListener("scroll", syncViewportHeight);
    syncViewportHeight();
  }

  let modalReturnFocus = null;
  function openModal(html) {
    modalReturnFocus = document.activeElement;
    modalRoot.innerHTML = html;
    modalRoot.setAttribute("role", "dialog");
    modalRoot.setAttribute("aria-modal", "true");
    const title = modalRoot.querySelector("h2");
    if (title) {
      title.id = "modal-title";
      modalRoot.setAttribute("aria-labelledby", "modal-title");
    }
    backdrop.hidden = false;
    syncViewportHeight();
  }
  function closeModal() {
    backdrop.hidden = true;
    modalRoot.innerHTML = "";
    if (modalReturnFocus && document.contains(modalReturnFocus) && typeof modalReturnFocus.focus === "function") {
      modalReturnFocus.focus({ preventScroll: true });
    }
    modalReturnFocus = null;
  }
  function isModalOpen() {
    return !backdrop.hidden;
  }
  function focusField(input, select) {
    setTimeout(() => {
      input.focus();
      if (select) input.select();
    }, 50);
  }

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isModalOpen()) closeModal();
  });
  // If a field still ends up behind the keyboard, scroll it into view.
  modalRoot.addEventListener("focusin", (e) => {
    if (e.target.matches("input, select, textarea") && typeof e.target.scrollIntoView === "function") {
      setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
    }
  });

  // ================= Live pot strip (header) =================
  // Always visible while any event is open, on every screen.
  async function updatePotStrip() {
    const token = renderToken("pot");
    const nights = await DB.getAll("nights");
    if (isStale("pot", token)) return;

    const strip = $("pot-strip");
    const open = nights.filter((n) => n.status === "open");
    if (!open.length) {
      strip.hidden = true;
      state.liveNightId = null;
      return;
    }
    const total = round2(open.reduce((s, n) => s + nightPotTotal(n), 0));
    if (open.length === 1) {
      state.liveNightId = open[0].id;
      $("pot-strip-night").textContent = fmtDate(open[0].date);
    } else {
      state.liveNightId = null;
      $("pot-strip-night").textContent = open.length + " open events";
    }
    $("pot-strip-amount").textContent = fmtMoney(total);
    strip.hidden = false;
  }

  function openLiveEvent() {
    if (state.liveNightId) openEvent(state.liveNightId, "nights");
    else openTab("nights");
  }
  $("pot-strip").addEventListener("click", openLiveEvent);
  $("pot-strip").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openLiveEvent();
    }
  });

  // ================= EVENTS LIST =================
  async function renderNightsList() {
    const token = renderToken("nights");
    const nights = await DB.getAll("nights");
    if (isStale("nights", token)) return;

    nights.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : b.id - a.id));
    const list = $("nights-list");
    list.innerHTML = "";
    $("nights-empty").hidden = nights.length > 0;

    nights.forEach((night) => {
      const count = (night.players || []).length;
      const closed = night.status === "closed";
      const card = el(`
        <div class="card card-tappable">
          <div class="card-row">
            <div>
              <div class="card-title">${fmtDate(night.date)}</div>
              <div class="card-sub">${count} player${count === 1 ? "" : "s"} &middot; ${fmtMoney(nightPotTotal(night))} in play${night.location ? " &middot; " + escapeHtml(night.location) : ""}</div>
            </div>
            <span class="badge ${closed ? "is-closed" : ""}">${closed ? "Closed" : "Open"}</span>
          </div>
        </div>
      `);
      card.addEventListener("click", () => openEvent(night.id, "nights"));
      list.appendChild(card);
    });
  }

  // ---- How the money is settled: cash on the table, or players pay each other after ----
  const SETTLE_LABEL = { cash: "Cash on the table", transfer: "Pay each other" };
  const settleMode = (night) => (night && night.settle === "transfer" ? "transfer" : "cash");

  function settleSwitch(current) {
    return `
      <div class="field">
        <label>Money</label>
        <div class="seg" id="f-settle">
          <button type="button" class="btn btn-ghost${current === "cash" ? " is-on" : ""}" data-settle="cash">${SETTLE_LABEL.cash}</button>
          <button type="button" class="btn btn-ghost${current === "transfer" ? " is-on" : ""}" data-settle="transfer">${SETTLE_LABEL.transfer}</button>
        </div>
      </div>`;
  }
  function bindSettleSwitch() {
    const wrap = $("f-settle");
    wrap.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => wrap.querySelectorAll("button").forEach((x) => x.classList.toggle("is-on", x === b)))
    );
    return () => wrap.querySelector(".is-on").dataset.settle;
  }

  // Fewest payments that settle an event: biggest loser pays biggest winner, repeat.
  // Works in cents so rounding never leaves a stray cent. Each payment has a key
  // (payer > receiver : cents) used to remember it as paid; if the results are
  // changed later, the key changes and the tick disappears, as it should.
  function settleTransfers(night) {
    const people = (night.players || []).map((np) => ({ id: np.playerId, name: np.name, c: Math.round(Number(np.net || 0) * 100) }));
    const order = (a, b) => b.c - a.c || a.name.localeCompare(b.name);
    const payers = people.filter((p) => p.c < 0).map((p) => ({ ...p, c: -p.c }));
    const receivers = people.filter((p) => p.c > 0);
    const out = [];
    while (payers.length && receivers.length) {
      payers.sort(order);
      receivers.sort(order);
      const from = payers[0], to = receivers[0];
      const cents = Math.min(from.c, to.c);
      out.push({ from: from.name, to: to.name, amount: cents / 100, key: `${from.id}>${to.id}:${cents}` });
      from.c -= cents;
      to.c -= cents;
      if (!from.c) payers.shift();
      if (!to.c) receivers.shift();
    }
    return out.sort((a, b) => a.from.localeCompare(b.from) || b.amount - a.amount);
  }

  $("btn-new-night").addEventListener("click", () => {
    openModal(`
      <h2>New Event</h2>
      <div class="field">
        <label for="f-date-text">Date</label>
        ${dateField(todayISO())}
      </div>
      <div class="field">
        <label for="f-location">Location <span class="muted">(optional)</span></label>
        <input type="text" id="f-location" placeholder="e.g. Marto's place">
      </div>
      <div class="field">
        <label for="f-notes">Notes <span class="muted">(optional)</span></label>
        <input type="text" id="f-notes" placeholder="Anything worth remembering">
      </div>
      ${settleSwitch("cash")}
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-create">Start event</button>
      </div>
    `);
    const getSettle = bindSettleSwitch();
    bindDateField();
    $("m-cancel").addEventListener("click", closeModal);
    onTap($("m-create"), async () => {
      if (!$("f-date").value) return toast("Enter the date as dd.mm.yyyy");
      const id = await DB.add("nights", {
        date: $("f-date").value,
        location: $("f-location").value.trim(),
        notes: $("f-notes").value.trim(),
        settle: getSettle(),
        status: "open",
        players: [],
        createdAt: Date.now(),
      });
      closeModal();
      openEvent(id, "nights");
    });
  });

  // ================= EVENT DETAIL =================
  async function renderNightDetail(nightId) {
    const token = renderToken("nightDetail");
    const night = await DB.read("nights", nightId);
    if (isStale("nightDetail", token) || !night) return;

    const isOpen = night.status === "open";
    $("nd-date").textContent = fmtDate(night.date) + (night.location ? " \u2014 " + night.location : "");
    $("nd-status").textContent = isOpen ? "Open" : "Closed";
    $("nd-status").className = "badge" + (isOpen ? "" : " is-closed");

    $("nd-settle").textContent = SETTLE_LABEL[settleMode(night)];

    const notes = $("nd-notes");
    notes.textContent = night.notes || "";
    notes.hidden = !night.notes;

    $("nd-pot-amount").textContent = fmtMoney(nightPotTotal(night));
    $("nd-pot-hero").querySelector(".pot-hero-label").textContent = isOpen ? "Total buy-ins" : "Total buy-ins (final)";

    $("nd-open-actions").hidden = !isOpen;
    $("nd-players-head").hidden = !isOpen;
    $("nd-closed-summary").hidden = isOpen;

    if (isOpen) {
      renderNightPlayersEditable(night);
    } else {
      $("nd-players").innerHTML = "";
      $("nd-players-empty").hidden = true;
      renderNightResults(night);
    }
    renderPayments(night);
  }

  function renderPayments(night) {
    const show = night.status === "closed" && settleMode(night) === "transfer";
    $("nd-payments").hidden = !show;
    if (!show) return;
    const transfers = settleTransfers(night);
    const paid = new Set(night.paid || []);
    const wrap = $("nd-payments-list");
    wrap.innerHTML = "";
    const done = transfers.filter((t) => paid.has(t.key)).length;
    $("nd-payments-count").textContent = transfers.length
      ? done === transfers.length ? "All paid \u2713" : `${done} of ${transfers.length} paid`
      : "";
    $("nd-payments-empty").hidden = transfers.length > 0;
    const off = round2((night.players || []).reduce((sum, np) => sum + Number(np.net || 0), 0));
    $("nd-payments-off").hidden = Math.abs(off) < 0.005;
    $("nd-payments-off").textContent = `Results are off by ${fmtMoney(Math.abs(off))}, so payments don't fully cover it.`;

    transfers.forEach((t) => {
      const isPaid = paid.has(t.key);
      const row = el(`
        <button type="button" class="card payment-row${isPaid ? " is-paid" : ""}" aria-pressed="${isPaid}">
          <span class="pay-check" aria-hidden="true">${isPaid ? "\u2713" : ""}</span>
          <span class="pay-who"><span class="pay-from">${escapeHtml(t.from)}</span><span class="pay-arrow">&rarr;</span><span class="pay-to">${escapeHtml(t.to)}</span></span>
          <span class="money money-strong">${fmtMoney(t.amount)}</span>
        </button>
      `);
      if (canEdit()) onTap(row, () => togglePaid(night.id, t.key));
      else row.disabled = true;
      wrap.appendChild(row);
    });
  }

  async function togglePaid(nightId, key) {
    await mutate("nights", nightId, (night) => {
      const valid = new Set(settleTransfers(night).map((t) => t.key));
      const paid = new Set(night.paid || []);
      if (paid.has(key)) paid.delete(key);
      else if (valid.has(key)) paid.add(key);
      night.paid = [...paid].filter((k) => valid.has(k)); // keep only ticks that match the current results
    });
    await refreshEvent(nightId);
  }

  async function refreshEvent(nightId) {
    await renderNightDetail(nightId);
    updatePotStrip();
  }

  function renderNightPlayersEditable(night) {
    const wrap = $("nd-players");
    wrap.innerHTML = "";
    const players = night.players || [];
    $("nd-players-empty").hidden = players.length > 0;

    players.forEach((np) => {
      const chips = (np.buyins || [])
        .map((b, i) => `<button type="button" class="buyin-chip" data-idx="${i}" data-ts="${Number(b.ts) || ""}">${fmtMoney(b.amount)}<svg class="edit-only" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>`)
        .join("");
      const row = el(`
        <div class="card player-row">
          <div class="card-row">
            <div class="card-title">${escapeHtml(np.name)}</div>
            <div class="money money-strong">${fmtMoney(buyinTotal(np))}</div>
          </div>
          <div class="buyin-list">${chips}</div>
          <div class="player-actions edit-only">
            <button class="btn btn-ghost-gold btn-sm btn-quick-buyin">+${fmtMoney(QUICK_BUYINS[0]).replace(".00", "")}</button>
            <button class="btn btn-ghost-gold btn-sm btn-add-buyin">+ Buy-in</button>
            <button class="btn btn-ghost btn-sm btn-remove-player">Remove</button>
          </div>
        </div>
      `);
      onTap(row.querySelector(".btn-quick-buyin"), async () => {
        const ts = await addBuyin(night.id, np.playerId, QUICK_BUYINS[0]);
        if (ts) toast(`${fmtMoney(QUICK_BUYINS[0])} added for ${np.name}`, { label: "Undo", run: () => removeBuyin(night.id, np.playerId, ts, QUICK_BUYINS[0]) });
        await new Promise((r) => setTimeout(r, 500)); // guard against an accidental double tap
      });
      row.querySelector(".btn-add-buyin").addEventListener("click", () => openBuyinModal(night.id, np.playerId, np.name));
      row.querySelectorAll(".buyin-chip").forEach((chipEl) => {
        chipEl.addEventListener("click", () => {
          if (canEdit()) openEditBuyinModal(night.id, np.playerId, Number(chipEl.dataset.idx), Number(chipEl.dataset.ts) || null);
        });
      });
      onTap(row.querySelector(".btn-remove-player"), async () => {
        if (!confirm(`Remove ${np.name} from this event? Their buy-ins will be removed too.`)) return;
        await mutate("nights", night.id, (fresh) => {
          fresh.players = fresh.players.filter((p) => p.playerId !== np.playerId);
        });
        await refreshEvent(night.id);
      });
      wrap.appendChild(row);
    });
  }

  function renderNightResults(night) {
    const wrap = $("nd-results");
    wrap.innerHTML = "";
    (night.players || []).forEach((np) => {
      wrap.appendChild(
        el(`
        <div class="card">
          <div class="card-row">
            <div class="card-title">${escapeHtml(np.name)}</div>
            <div class="money ${amountClass(np.net)}">${fmtSigned(np.net)}</div>
          </div>
          <div class="card-sub">Buy-in ${fmtMoney(buyinTotal(np))} &middot; Cash-out ${fmtMoney(np.cashOut)}</div>
        </div>
      `)
      );
    });
  }

  const QUICK_BUYINS = [20, 40];

  // Buy-in changes by timestamp (each buy-in's id). Safe to apply twice.
  function pushBuyin(playerId, amount, ts) {
    return (night) => {
      const np = (night.players || []).find((p) => p.playerId === playerId);
      if (!np) return false;
      np.buyins = np.buyins || [];
      if (np.buyins.some((b) => Number(b.ts) === ts)) return false;
      np.buyins.push({ amount, ts });
    };
  }
  function dropBuyin(playerId, ts) {
    return (night) => {
      const np = (night.players || []).find((p) => p.playerId === playerId);
      const i = np ? (np.buyins || []).findIndex((b) => Number(b.ts) === ts) : -1;
      if (i < 0) return false;
      np.buyins.splice(i, 1);
    };
  }

  // Shows the change right away; saving happens in the background.
  async function optimisticNight(nightId, change, undo) {
    const r = await mutateOptimistic("nights", nightId, change, undo);
    if (!r) return false;
    await refreshEvent(nightId);
    r.saving
      .then(() => refreshEvent(nightId))
      .catch((err) => {
        refreshEvent(nightId);
        handleError(err);
      });
    return true;
  }

  // Returns the new buy-in's timestamp (its id), or null.
  async function addBuyin(nightId, playerId, amount) {
    const ts = Date.now();
    const ok = await optimisticNight(nightId, pushBuyin(playerId, amount, ts), dropBuyin(playerId, ts));
    return ok ? ts : null;
  }

  async function removeBuyin(nightId, playerId, ts, amount) {
    if (await optimisticNight(nightId, dropBuyin(playerId, ts), pushBuyin(playerId, amount, ts))) toast("Buy-in removed");
  }

  function readAmount(input) {
    const amount = round2(parseFloat(input.value));
    return amount > 0 ? amount : null;
  }

  function openBuyinModal(nightId, playerId, name) {
    openModal(`
      <h2>Add buy-in &mdash; ${escapeHtml(name)}</h2>
      <div class="quick-amounts">
        ${QUICK_BUYINS.map((v) => `<button type="button" class="btn btn-ghost-gold quick-amt" data-amt="${v}">${fmtMoney(v).replace(".00", "")}</button>`).join("")}
      </div>
      <div class="field">
        <label for="f-amount">Other amount (EUR)</label>
        <input type="number" id="f-amount" inputmode="decimal" step="0.01" min="0" placeholder="0.00" class="amount-input">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-add">Add</button>
      </div>
    `);
    // No auto-focus: the keyboard would cover the quick buttons.
    $("m-cancel").addEventListener("click", closeModal);
    modalRoot.querySelectorAll(".quick-amt").forEach((btn) => {
      onTap(btn, async () => {
        closeModal();
        await addBuyin(nightId, playerId, Number(btn.dataset.amt));
      });
    });
    onTap($("m-add"), async () => {
      const amount = readAmount($("f-amount"));
      if (!amount) return toast("Enter an amount above zero");
      closeModal();
      await addBuyin(nightId, playerId, amount);
    });
  }

  // Finds the buy-in again in fresh data: by its timestamp when it has one
  // (so a buy-in someone else removed meanwhile can't shift the index), else by position.
  function findBuyinIndex(buyins, index, ts) {
    if (!buyins) return -1;
    if (ts) return buyins.findIndex((b) => Number(b.ts) === ts);
    return buyins[index] ? index : -1;
  }

  async function openEditBuyinModal(nightId, playerId, buyinIndex, buyinTs) {
    const night = await DB.read("nights", nightId);
    const np = night && night.players.find((p) => p.playerId === playerId);
    const at = np ? findBuyinIndex(np.buyins, buyinIndex, buyinTs) : -1;
    const buyin = at >= 0 ? np.buyins[at] : null;
    if (!buyin) return refreshEvent(nightId);

    openModal(`
      <h2>Edit buy-in</h2>
      <div class="field">
        <label for="f-edit-amount">Amount (EUR)</label>
        <input type="number" id="f-edit-amount" inputmode="decimal" step="0.01" min="0" class="amount-input" value="${escapeHtml(buyin.amount)}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-danger-text" id="m-delete">Delete</button>
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-save">Save</button>
      </div>
    `);
    const input = $("f-edit-amount");
    focusField(input, true);
    $("m-cancel").addEventListener("click", closeModal);

    async function updateBuyin(change) {
      let gone = false;
      await mutate("nights", nightId, (fresh) => {
        const freshNp = fresh.players.find((p) => p.playerId === playerId);
        const i = freshNp ? findBuyinIndex(freshNp.buyins, buyinIndex, buyinTs) : -1;
        if (i < 0) {
          gone = true;
          return false;
        }
        change(freshNp.buyins, i);
      });
      closeModal();
      if (gone) toast("That buy-in was changed by someone else");
      await refreshEvent(nightId);
    }

    onTap($("m-delete"), async () => {
      if (!confirm("Delete this buy-in?")) return;
      await updateBuyin((buyins, i) => buyins.splice(i, 1));
    });
    onTap($("m-save"), async () => {
      const amount = readAmount(input);
      if (!amount) return toast("Enter an amount above zero");
      await updateBuyin((buyins, i) => (buyins[i].amount = amount));
    });
  }

  $("btn-add-player-to-night").addEventListener("click", async () => {
    const night = await DB.read("nights", state.currentNightId);
    const roster = await DB.getAll("players");
    const already = new Set((night.players || []).map((p) => p.playerId));
    const available = roster.filter((p) => !already.has(p.id) && !p.archived).sort((a, b) => a.name.localeCompare(b.name));

    const picks = new Set();
    openModal(`
      <h2>Add players</h2>
      ${available.length ? `<div class="roster-pick" id="roster-pick"></div>` : `<p class="hint-text">Everyone in your roster is already here &mdash; add a new name below.</p>`}
      <div class="field">
        <label for="f-newname">New player</label>
        <input type="text" id="f-newname" placeholder="Type a name">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-confirm">Add to event</button>
      </div>
    `);

    if (available.length) {
      const pickWrap = $("roster-pick");
      available.forEach((p) => {
        const pill = el(`<button type="button" class="roster-pill">${escapeHtml(p.name)}</button>`);
        pill.addEventListener("click", () => {
          if (picks.has(p.id)) picks.delete(p.id);
          else picks.add(p.id);
          pill.classList.toggle("is-picked", picks.has(p.id));
        });
        pickWrap.appendChild(pill);
      });
    }

    $("m-cancel").addEventListener("click", closeModal);
    onTap($("m-confirm"), async () => {
      const newName = cleanName($("f-newname").value);
      if (!picks.size && !newName) return toast("Pick a player or type a name");

      const freshNight = await DB.get("nights", state.currentNightId);
      const freshRoster = await DB.getAll("players");
      freshNight.players = freshNight.players || [];
      const inEvent = new Set(freshNight.players.map((p) => p.playerId));
      const toAdd = [];
      let note = "";

      picks.forEach((pid) => {
        const p = freshRoster.find((r) => r.id === pid);
        if (p && !inEvent.has(p.id)) toAdd.push(p);
      });

      if (newName) {
        const existing = freshRoster.find((p) => sameName(p.name, newName));
        if (existing && inEvent.has(existing.id)) {
          return toast(`${existing.name} is already in this event`);
        }
        // Reuse a roster match (un-archiving if needed) so stats stay in one place.
        const { player, how } = await findOrCreatePlayer(newName);
        if (!toAdd.some((p) => p.id === player.id)) toAdd.push(player);
        if (how === "existing") note = `${player.name} was already in your roster \u2014 added them`;
        if (how === "restored") note = `${player.name} restored from archive`;
        if (how === "reconnected") note = `${player.name} reconnected to past results`;
      }

      await mutate("nights", state.currentNightId, (n) => {
        n.players = n.players || [];
        const have = new Set(n.players.map((p) => p.playerId));
        toAdd.filter((p) => !have.has(p.id)).forEach((p) => n.players.push({ playerId: p.id, name: p.name, buyins: [], cashOut: null, net: null }));
      });
      closeModal();
      await refreshEvent(state.currentNightId);
      if (note) toast(note);
    });
  });

  $("btn-edit-event").addEventListener("click", async () => {
    const night = await DB.read("nights", state.currentNightId);
    if (!night) return;
    openModal(`
      <h2>Edit event</h2>
      <div class="field">
        <label for="f-date-text">Date</label>
        ${dateField(night.date)}
      </div>
      <div class="field">
        <label for="f-location">Location <span class="muted">(optional)</span></label>
        <input type="text" id="f-location" value="${escapeHtml(night.location || "")}">
      </div>
      <div class="field">
        <label for="f-notes">Notes <span class="muted">(optional)</span></label>
        <input type="text" id="f-notes" value="${escapeHtml(night.notes || "")}">
      </div>
      ${settleSwitch(settleMode(night))}
      <div class="modal-actions">
        <button class="btn btn-ghost btn-danger-text" id="m-delete">Delete</button>
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-save">Save</button>
      </div>
    `);
    const getSettle = bindSettleSwitch();
    bindDateField();
    $("m-cancel").addEventListener("click", closeModal);
    onTap($("m-save"), async () => {
      const date = $("f-date").value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast("Enter the date as dd.mm.yyyy");
      const location = $("f-location").value.trim();
      const notes = $("f-notes").value.trim();
      const settle = getSettle();
      await mutate("nights", state.currentNightId, (fresh) => {
        Object.assign(fresh, { date, location, notes, settle });
      });
      closeModal();
      await refreshEvent(state.currentNightId);
      toast("Event updated");
    });
    onTap($("m-delete"), async () => {
      if (!confirm("Delete this event permanently? Buy-ins and results will be lost.")) return;
      await DB.delete("nights", night.id, night._v); // refused if someone changed it meanwhile
      closeModal();
      state.currentNightId = null;
      if (state.nightDetailReturnTo === "player-detail" && state.currentPlayerId) openPlayer(state.currentPlayerId);
      else openTab("nights");
      toast("Event deleted");
    });
  });

  onTap($("btn-close-night"), async () => {
    const night = await DB.get("nights", state.currentNightId);
    if (!night) return;
    if (!night.players || night.players.length === 0) return toast("Add players before closing the event");
    // Someone added but never bought in didn't play: don't count them as an event played.
    const idle = night.players.filter((np) => buyinTotal(np) <= 0);
    if (idle.length === night.players.length) return toast("Add buy-ins before closing the event");
    if (idle.length) {
      const names = idle.map((np) => np.name).join(", ");
      if (!confirm(`${names} ${idle.length === 1 ? "has" : "have"} no buy-ins and will be removed from this event when you finish. Continue?`)) return;
    }
    showView("closeout");
    renderCloseout(night);
  });

  onTap($("btn-reopen-night"), async () => {
    if (!confirm("Reopen this event? You'll be able to edit buy-ins and results again.")) return;
    await mutate("nights", state.currentNightId, (night) => {
      night.status = "open";
      night.closedAt = null;
    });
    await refreshEvent(state.currentNightId);
  });

  // ================= CLOSE-OUT =================
  // Players who bought in. Anyone added but without buy-ins didn't play and
  // is dropped when the event is finished.
  const playing = (night) => (night.players || []).filter((np) => buyinTotal(np) > 0);

  function renderCloseout(night) {
    state.closeoutNight = night;
    const wrap = $("closeout-list");
    wrap.innerHTML = "";
    playing(night).forEach((np) => {
      const pid = Number(np.playerId);
      const row = el(`
        <div class="card closeout-row">
          <div class="card-row">
            <div class="card-title">${escapeHtml(np.name)}</div>
            <div class="card-sub" id="co-in-${pid}">Buy-in ${fmtMoney(buyinTotal(np))}</div>
          </div>
          <div class="field-row">
            <label for="in-${pid}">Cash-out</label>
            <input type="number" inputmode="decimal" step="0.01" min="0" class="amount-input" id="in-${pid}" placeholder="0.00" value="${np.cashOut != null ? escapeHtml(np.cashOut) : ""}">
            <span class="co-net" id="net-${pid}"></span>
          </div>
        </div>
      `);
      row.querySelector("input").addEventListener("input", () => updateCloseoutCheck(state.closeoutNight));
      wrap.appendChild(row);
    });
    updateCloseoutCheck(night);
  }

  // Someone changed buy-ins while cash-outs are being typed: update the
  // numbers without touching what was typed (re-draw only if players changed).
  async function refreshCloseout() {
    const night = await DB.read("nights", state.currentNightId);
    if (!night || state.currentView !== "closeout") return;
    const ids = (n) => playing(n).map((np) => np.playerId).join(",");
    if (ids(night) !== ids(state.closeoutNight)) {
      const typed = {};
      document.querySelectorAll("#closeout-list input").forEach((i) => (typed[i.id] = i.value));
      renderCloseout(night);
      Object.entries(typed).forEach(([id, v]) => {
        const i = $(id);
        if (i) i.value = v;
      });
    } else {
      state.closeoutNight = night;
      playing(night).forEach((np) => {
        const label = $(`co-in-${Number(np.playerId)}`);
        if (label) label.textContent = `Buy-in ${fmtMoney(buyinTotal(np))}`;
      });
    }
    updateCloseoutCheck(state.closeoutNight);
  }

  function readCloseoutRows(night) {
    return playing(night).map((np) => {
      const total = buyinTotal(np);
      const input = $(`in-${Number(np.playerId)}`);
      const raw = input && input.value !== "" ? round2(parseFloat(input.value)) : null;
      const valid = raw !== null && !isNaN(raw);
      return {
        playerId: np.playerId,
        name: np.name,
        total,
        negative: valid && raw < 0,
        cashOut: valid && raw >= 0 ? raw : null,
        net: valid && raw >= 0 ? round2(raw - total) : null,
      };
    });
  }

  function updateCloseoutCheck(night) {
    const rows = readCloseoutRows(night);
    const pot = nightPotTotal(night);
    const cashed = round2(rows.reduce((s, r) => s + (r.cashOut || 0), 0));
    const filled = rows.filter((r) => r.net !== null).length;
    const diff = round2(cashed - pot);

    // live result next to each player's field
    rows.forEach((r) => {
      const out = $(`net-${r.playerId}`);
      if (!out) return;
      out.textContent = r.net === null ? "" : fmtSigned(r.net);
      out.className = "co-net " + (r.net === null ? "" : amountClass(r.net));
    });

    $("co-total").textContent = fmtMoney(cashed);
    $("co-pot").textContent = fmtMoney(pot);
    $("co-fill").style.width = (pot > 0 ? Math.min(100, (cashed / pot) * 100) : 0) + "%";
    $("co-count").textContent = `${filled} of ${rows.length} players entered`;

    const check = $("closeout-check");
    const status = $("co-status");
    const negative = rows.find((r) => r.negative);
    if (negative) {
      check.className = "closeout-check is-off";
      status.textContent = `Negative for ${negative.name}`;
    } else if (diff > 0.005) {
      check.className = "closeout-check is-off";
      status.textContent = `${fmtMoney(diff)} too much`;
    } else if (Math.abs(diff) < 0.005 && filled === rows.length) {
      check.className = "closeout-check is-balanced";
      status.textContent = "Balanced \u2713";
    } else if (filled === rows.length) {
      check.className = "closeout-check is-off";
      status.textContent = `${fmtMoney(-diff)} missing`;
    } else {
      check.className = "closeout-check";
      status.textContent = `${fmtMoney(-diff)} left`;
    }
  }

  onTap($("btn-finish-night"), async () => {
    const night = await DB.get("nights", state.currentNightId);
    if (!night) return;
    night.players = playing(night); // drop anyone who never bought in
    const rows = readCloseoutRows(night);
    const negative = rows.find((r) => r.negative);
    if (negative) return toast(`Cash-out can't be negative for ${negative.name}`);
    const missing = rows.find((r) => r.net === null);
    if (missing) return toast(`Enter a cash-out for ${missing.name}`);

    const sumNet = round2(rows.reduce((s, r) => s + r.net, 0));
    if (Math.abs(sumNet) >= 0.005 && !confirm(`Buy-ins and cash-outs are off by ${fmtMoney(Math.abs(sumNet))}. Save anyway?`)) return;

    night.players = night.players.map((np) => {
      const r = rows.find((x) => x.playerId === np.playerId);
      return { ...np, cashOut: r.cashOut, net: r.net };
    });
    night.status = "closed";
    night.closedAt = Date.now();
    await DB.put("nights", night);

    openEvent(night.id, state.nightDetailReturnTo);
    toast("Event closed");
  });

  // ================= PLAYERS =================
  // Pure function: stats for one player from an already-loaded list of events.
  // Only closed events count (open ones have no result yet).
  const MIN_EVENTS_FOR_RATES = 3; // below this, ROI / win rate are shown as unreliable

  function fmtPct(v, signed) {
    if (v === null || v === undefined) return "\u2014";
    const r = Math.round(v);
    return (signed && r > 0 ? "+" : "") + r + "%";
  }

  function playerStats(nights, playerId) {
    let eventsPlayed = 0, totalBuyIn = 0, totalCashOut = 0, net = 0;
    let biggestWin = null, biggestLoss = null, eventsWon = 0;
    const history = [];

    nights.forEach((n) => {
      if (n.status !== "closed") return;
      const np = (n.players || []).find((p) => p.playerId === playerId);
      if (!np) return;
      const pNet = Number(np.net || 0);
      eventsPlayed++;
      totalBuyIn += buyinTotal(np);
      totalCashOut += Number(np.cashOut || 0);
      net += pNet;
      if (pNet > 0.004) eventsWon++;
      if (pNet > 0 && (biggestWin === null || pNet > biggestWin)) biggestWin = pNet;
      if (pNet < 0 && (biggestLoss === null || pNet < biggestLoss)) biggestLoss = pNet;
      history.push({ nightId: n.id, date: n.date, net: pNet });
    });

    history.sort((a, b) => (a.date === b.date ? b.nightId - a.nightId : a.date < b.date ? 1 : -1));

    return {
      eventsPlayed,
      totalBuyIn: round2(totalBuyIn),
      totalCashOut: round2(totalCashOut),
      net: round2(net),
      biggestWin: biggestWin === null ? null : round2(biggestWin),
      biggestLoss: biggestLoss === null ? null : round2(biggestLoss),
      eventsWon,
      // ROI: net result per euro bought in. Win rate: share of events finished in profit.
      roi: totalBuyIn > 0 ? (net / totalBuyIn) * 100 : null,
      winRate: eventsPlayed > 0 ? (eventsWon / eventsPlayed) * 100 : null,
      fewEvents: eventsPlayed < MIN_EVENTS_FOR_RATES,
      history,
    };
  }

  // Players are never deleted: archiving hides them from new events but
  // keeps their stats. Re-adding the same name brings them back.
  async function setArchived(playerId, archived) {
    const player = await DB.get("players", playerId);
    if (!player) return false;
    if (archived && !confirm(`Archive ${player.name}? They'll be hidden from new events. Stats are kept.`)) return false;
    player.archived = archived;
    await DB.put("players", player);
    toast(archived ? `${player.name} archived` : `${player.name} restored`);
    return true;
  }

  // Finds a player by name or creates one. Reuses (and un-archives) a roster
  // match, and reconnects to past results of a player who was deleted by an
  // older version of the app, so stats never split into two people.
  async function findOrCreatePlayer(name) {
    const roster = await DB.getAll("players");
    const existing = roster.find((p) => sameName(p.name, name));
    if (existing) {
      if (existing.archived) {
        existing.archived = false;
        await DB.put("players", existing);
        return { player: existing, how: "restored" };
      }
      return { player: existing, how: "existing" };
    }
    const known = new Set(roster.map((p) => p.id));
    for (const n of await DB.getAll("nights")) {
      const orphan = (n.players || []).find((np) => !known.has(np.playerId) && sameName(np.name, name));
      if (orphan) {
        const player = { id: orphan.playerId, name: cleanName(name), createdAt: Date.now() };
        await DB.put("players", player);
        return { player, how: "reconnected" };
      }
    }
    const id = await DB.add("players", { name, createdAt: Date.now() });
    return { player: { id, name }, how: "new" };
  }


  async function renderPlayersList() {
    const token = renderToken("players");
    const [roster, nights] = await Promise.all([DB.getAll("players"), DB.getAll("nights")]);
    if (isStale("players", token)) return;

    const rows = roster
      .map((p) => ({ p, stats: playerStats(nights, p.id) }))
      .sort((a, b) => a.p.name.localeCompare(b.p.name));
    const active = rows.filter((r) => !r.p.archived);
    const archived = rows.filter((r) => r.p.archived);

    $("players-empty").hidden = active.length > 0;
    $("archived-head").hidden = archived.length === 0;
    renderPlayerCards($("players-list"), active, false);
    renderPlayerCards($("players-archived"), archived, true);
  }

  function renderPlayerCards(list, rows, isArchived) {
    list.innerHTML = "";
    rows.forEach(({ p, stats }) => {
      const card = el(`
        <div class="card card-tappable${isArchived ? " is-archived" : ""}">
          <div class="card-row">
            <div class="card-title">${escapeHtml(p.name)}</div>
            <div class="money ${amountClass(stats.net)}">${fmtSigned(stats.net)}</div>
          </div>
        </div>
      `);
      card.addEventListener("click", () => openPlayer(p.id, "players"));
      list.appendChild(card);
    });
  }

  // ================= LEADERBOARD =================
  // All-time ranking by net result. Active players with at least one closed
  // event; full details live on each player's page (tap a row).
  // Short money for the leaderboard: €385 instead of €385.00 (cents kept when there are any)
  function shortMoney(n, signed) {
    const str = signed ? fmtSigned(n) : fmtMoney(n);
    return str.replace(/\.00$/, "");
  }

  const LB_CLUB_KEY = "rpc-lb-club";
  $("lb-club").addEventListener("change", (e) => {
    pref.set(LB_CLUB_KEY, e.target.checked ? "on" : "off");
    renderLeaderboard().catch(handleError);
  });

  async function renderLeaderboard() {
    const token = renderToken("leaderboard");
    const [roster, nights] = await Promise.all([DB.getAll("players"), DB.getAll("nights")]);
    if (isStale("leaderboard", token)) return;
    const clubOnly = pref.get(LB_CLUB_KEY) !== "off"; // on by default: club members only
    $("lb-club").checked = clubOnly;
    const rows = roster
      .filter((p) => !p.archived)
      .map((p) => ({ p, s: playerStats(nights, p.id) }))
      .filter((r) => r.s.eventsPlayed > 0 && (!clubOnly || r.p.clubMember))
      .sort((a, b) => b.s.net - a.s.net || b.s.totalCashOut - a.s.totalCashOut || a.p.name.localeCompare(b.p.name));

    $("lb-empty").hidden = rows.length > 0;
    $("lb-empty").textContent = clubOnly ? "No club members yet. Mark them on each player's page." : "No closed events yet.";
    $("lb-head").hidden = rows.length === 0;
    const list = $("lb-list");
    list.innerHTML = "";
    rows.forEach(({ p, s }, i) => {
      const extras = [`${s.eventsPlayed} event${s.eventsPlayed === 1 ? "" : "s"}`, `in ${shortMoney(s.totalBuyIn)}`, `out ${shortMoney(s.totalCashOut)}`];
      if (s.biggestWin !== null) extras.push(`best ${shortMoney(s.biggestWin, true)}`);
      if (s.biggestLoss !== null) extras.push(`worst ${shortMoney(s.biggestLoss, true)}`);
      const roi = s.roi === null ? "\u2014" : fmtPct(s.roi, true);
      const row = el(`
        <div class="card card-tappable lb-row">
          <div class="lb-grid">
            <span class="lb-rank${i < 3 ? " is-top" : ""}">${i + 1}${p.clubMember ? '<span class="club-mark" title="Club member">&#9824;</span>' : ""}</span>
            <span class="lb-name">${escapeHtml(p.name)}</span>
            <span class="lb-num money ${amountClass(s.net)}">${shortMoney(s.net, true)}</span>
            <span class="lb-num lb-roi ${s.roi === null || s.fewEvents ? "amount-zero" : amountClass(s.roi)}">${roi}</span>
          </div>
          <div class="lb-sub">${extras.map((x) => `<span>${x}</span>`).join(" \u00B7 ")}</div>
        </div>
      `);
      row.addEventListener("click", () => openPlayer(p.id, "leaderboard"));
      list.appendChild(row);
    });
  }

  $("btn-add-player").addEventListener("click", () => {
    openModal(`
      <h2>Add player</h2>
      <div class="field">
        <label for="f-pname">Name</label>
        <input type="text" id="f-pname" placeholder="Player name">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-add">Add</button>
      </div>
    `);
    const input = $("f-pname");
    focusField(input);
    $("m-cancel").addEventListener("click", closeModal);
    onTap($("m-add"), async () => {
      const name = cleanName(input.value);
      if (!name) return toast("Enter a name");
      const existing = (await DB.getAll("players")).find((p) => sameName(p.name, name) && !p.archived);
      if (existing) return toast(`${existing.name} is already in the roster`);
      const { player, how } = await findOrCreatePlayer(name);
      closeModal();
      renderPlayersList();
      if (how === "restored") toast(`${player.name} restored from archive`);
      if (how === "reconnected") toast(`${player.name} reconnected to past results`);
    });
  });

  $("pd-club").addEventListener("change", async (e) => {
    const on = e.target.checked;
    try {
      const player = await mutate("players", state.currentPlayerId, (p) => {
        p.clubMember = on;
      });
      if (player) toast(on ? `${player.name} is a club member` : `${player.name} is no longer a club member`);
    } catch (err) {
      e.target.checked = !on;
      handleError(err);
    }
  });

  async function renderPlayerDetail(playerId) {
    const token = renderToken("playerDetail");
    const [player, nights] = await Promise.all([DB.read("players", playerId), DB.getAll("nights")]);
    if (isStale("playerDetail", token) || !player) return;

    const stats = playerStats(nights, playerId);
    $("pd-name").textContent = player.name;
    $("pd-archived").hidden = !player.archived;
    $("btn-archive-player").textContent = player.archived ? "Restore to roster" : "Archive player";
    $("pd-club").checked = !!player.clubMember;
    $("pd-club").disabled = !canEdit();

    const statCards = [
      ["Events played", stats.eventsPlayed, ""],
      ["Net profit/loss", fmtSigned(stats.net), amountClass(stats.net)],
      ["Total buy-in", fmtMoney(stats.totalBuyIn), ""],
      ["Total cash-out", fmtMoney(stats.totalCashOut), ""],
      ["Biggest win", stats.biggestWin === null ? "\u2014" : fmtSigned(stats.biggestWin), "amount-pos"],
      ["Biggest loss", stats.biggestLoss === null ? "\u2014" : fmtSigned(stats.biggestLoss), "amount-neg"],
      ["ROI",
        fmtPct(stats.roi, true) + (stats.fewEvents && stats.roi !== null ? ' <span class="stat-note">few events</span>' : ""),
        stats.roi === null || stats.fewEvents ? "amount-zero" : amountClass(stats.roi)],
      ["Win rate",
        stats.winRate === null ? "\u2014" : `${fmtPct(stats.winRate)} <span class="stat-note">${stats.eventsWon} of ${stats.eventsPlayed}${stats.fewEvents ? " \u00B7 few events" : ""}</span>`,
        stats.fewEvents ? "amount-zero" : ""],
    ];
    $("pd-stats").innerHTML = statCards
      .map(([label, value, cls]) => `
        <div class="stat-card">
          <div class="stat-label">${label}</div>
          <div class="stat-value ${cls}">${value}</div>
        </div>`)
      .join("");

    const wrap = $("pd-nights");
    wrap.innerHTML = "";
    $("pd-nights-empty").hidden = stats.history.length > 0;
    stats.history.forEach((h) => {
      const row = el(`
        <div class="card card-tappable">
          <div class="card-row">
            <div class="card-title">${fmtDate(h.date)}</div>
            <div class="money ${amountClass(h.net)}">${fmtSigned(h.net)}</div>
          </div>
        </div>
      `);
      row.addEventListener("click", () => openEvent(h.nightId, "player-detail"));
      wrap.appendChild(row);
    });
  }

  $("btn-edit-player-name").addEventListener("click", async () => {
    const player = await DB.read("players", state.currentPlayerId);
    if (!player) return;
    openModal(`
      <h2>Edit name</h2>
      <div class="field">
        <label for="f-pname-edit">Name</label>
        <input type="text" id="f-pname-edit" value="${escapeHtml(player.name)}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-save">Save</button>
      </div>
    `);
    const input = $("f-pname-edit");
    focusField(input, true);
    $("m-cancel").addEventListener("click", closeModal);
    onTap($("m-save"), async () => {
      const newName = cleanName(input.value);
      if (!newName) return toast("Enter a name");
      const clash = (await DB.getAll("players")).find((p) => p.id !== player.id && sameName(p.name, newName));
      if (clash) return toast(`Another player is already called ${clash.name}`);

      // Player and all past events renamed together in one database transaction
      await DB.request(() => DB.client.rpc("rename_player", { p_id: player.id, p_name: newName }));
      await DB.refresh(["players", "nights"]);
      closeModal();
      renderPlayerDetail(player.id);
      toast("Name updated");
    });
  });

  onTap($("btn-archive-player"), async () => {
    const player = await DB.get("players", state.currentPlayerId);
    if (player && (await setArchived(player.id, !player.archived))) renderPlayerDetail(player.id);
  });

  // ================= CHIPS =================
  async function renderChipsList() {
    const token = renderToken("chips");
    const chips = await DB.getAll("chips");
    if (isStale("chips", token)) return;

    chips.sort((a, b) => a.value - b.value);
    const list = $("chips-list");
    list.innerHTML = "";
    $("chips-empty").hidden = chips.length > 0;

    let totalValue = 0;
    chips.forEach((c) => {
      const lineValue = round2((Number(c.value) || 0) * (Number(c.qty) || 0));
      totalValue += lineValue;
      const row = el(`
        <div class="card card-tappable chip-row">
          <span class="chip-swatch"></span>
          <div class="chip-info">
            <div class="card-title">${escapeHtml(c.label)}</div>
            <div class="chip-qty">${fmtMoney(c.value)} each &middot; ${Number(c.qty) || 0} owned</div>
          </div>
          <div class="money money-strong">${fmtMoney(lineValue)}</div>
        </div>
      `);
      row.querySelector(".chip-swatch").style.background = c.color; // set via DOM, never via HTML string
      row.addEventListener("click", () => {
        if (canEdit()) openChipModal(c);
      });
      list.appendChild(row);
    });
    $("chips-total-value").textContent = fmtMoney(totalValue);
  }

  function openChipModal(existing) {
    const isEdit = !!existing;
    openModal(`
      <h2>${isEdit ? "Edit chip" : "Add chip"}</h2>
      <div class="field">
        <label for="f-color">Color</label>
        <input type="color" id="f-color" value="${escapeHtml(isEdit ? existing.color : "#BC9D58")}">
      </div>
      <div class="field">
        <label for="f-label">Label</label>
        <input type="text" id="f-label" placeholder="e.g. Red" value="${isEdit ? escapeHtml(existing.label) : ""}">
      </div>
      <div class="field">
        <label for="f-value">Value (EUR)</label>
        <input type="number" id="f-value" step="0.01" min="0" inputmode="decimal" value="${isEdit ? escapeHtml(existing.value) : ""}">
      </div>
      <div class="field">
        <label for="f-qty">Quantity owned</label>
        <input type="number" id="f-qty" step="1" min="0" inputmode="numeric" value="${isEdit ? escapeHtml(existing.qty) : ""}">
      </div>
      <div class="modal-actions">
        ${isEdit ? `<button class="btn btn-ghost btn-danger-text" id="m-delete">Delete</button>` : ""}
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-save">${isEdit ? "Save" : "Add chip"}</button>
      </div>
    `);
    $("m-cancel").addEventListener("click", closeModal);
    if (isEdit) {
      onTap($("m-delete"), async () => {
        if (!confirm(`Delete the ${existing.label} chip?`)) return;
        await DB.delete("chips", existing.id, existing._v);
        closeModal();
        renderChipsList();
      });
    }
    onTap($("m-save"), async () => {
      const label = $("f-label").value.trim();
      const value = round2(parseFloat($("f-value").value));
      const qtyRaw = $("f-qty").value;
      const qty = Number(qtyRaw);
      if (!label) return toast("Enter a label");
      if (!(value > 0)) return toast("Value must be above zero");
      if (qtyRaw === "" || !Number.isInteger(qty) || qty < 0) return toast("Quantity must be a whole number, 0 or more");

      const obj = { color: $("f-color").value, label, value, qty };
      if (isEdit) await DB.put("chips", { ...obj, id: existing.id, _v: existing._v });
      else await DB.add("chips", obj);
      closeModal();
      renderChipsList();
    });
  }

  $("btn-add-chip").addEventListener("click", () => openChipModal(null));

  // ================= SETTINGS / EXPORT / IMPORT =================
  const ROLE_LABEL = { owner: "Owner", admin: "Admin", viewer: "Viewer" };

  function openSettings() {
    const auth = window.RPC_AUTH || {};
    $("acct-email").textContent = auth.email || "";
    $("acct-role").textContent = ROLE_LABEL[auth.role] || "";
    $("two-step-sub").textContent = auth.mfaOn ? "On" : "Off \u2014 tap to set up";
    $("btn-two-step").disabled = !!auth.mfaOn;
    showView("settings");
  }

  $("btn-open-settings").addEventListener("click", () => {
    if (!["settings", "members"].includes(state.currentView)) state.settingsReturnTab = state.currentTab;
    openSettings();
  });
  $("btn-two-step").addEventListener("click", () => {
    if (!window.RPC_AUTH.mfaOn) window.RPC_AUTH.setupAuthenticator();
  });
  $("btn-sign-out").addEventListener("click", () => {
    if (confirm("Sign out of Retro Poker Club on this phone?")) window.RPC_AUTH.signOut();
  });

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function backupFilename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    return `retro-poker-club-backup-${stamp}.json`;
  }

  // Device-only preferences (small, non-critical; safe if storage is unavailable)
  const pref = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch (_) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (_) {}
    },
  };
  // Export is manual only: a copy is saved to this phone just when you ask for one.
  onTap($("btn-export"), async () => {
    try {
      downloadJSON(await DB.exportAll(), backupFilename());
      toast("Backup saved to Downloads");
    } catch (err) {
      handleError(err);
    }
  });

  $("btn-import").addEventListener("click", () => {
    if (window.RPC_AUTH.role !== "owner") return toast("Only the owner can import");
    $("import-file").click();
  });

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (!(await isDatabaseEmpty()) && !confirm("Replace ALL club data (for everyone) with this backup?")) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch (_) {
        throw new Error("The file isn't valid JSON. Nothing was changed.");
      }
      await DB.importAll(data);
      openTab("nights");
      toast("Backup restored");
    } catch (err) {
      if (err && err.kind) handleError(err);
      else alert("Couldn't import that file: " + err.message);
    } finally {
      e.target.value = "";
    }
  });

  // ================= Share as image =================
  // Images are drawn on a canvas in the app's own colors and fonts, then
  // handed to Android's share sheet (Viber, WhatsApp, …). If sharing files
  // isn't supported, the PNG is downloaded instead.
  function themeColor(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function palette() {
    return {
      bg: themeColor("--bg", "#FAF8F4"),
      surface: themeColor("--surface", "#FFFFFF"),
      raised: themeColor("--surface-raised", "#F3F1EA"),
      line: themeColor("--line", "#E2DFD4"),
      ink: themeColor("--ink", "#1B1C19"),
      soft: themeColor("--ink-soft", "#54554D"),
      gold: themeColor("--gold", "#BC9D58"),
      goldDeep: themeColor("--gold-deep", "#8A6E2F"),
      loss: themeColor("--loss", "#A3402F"),
    };
  }
  const SERIF = "'Source Serif 4', Georgia, serif";
  const SANS = "Inter, Roboto, Arial, sans-serif";

  async function fontsReady() {
    try {
      if (!document.fonts) return;
      await Promise.race([
        Promise.all([
          document.fonts.load(`600 30px ${SERIF}`),
          document.fonts.load(`700 16px ${SANS}`),
          document.fonts.load(`400 16px ${SANS}`),
        ]),
        new Promise((r) => setTimeout(r, 1500)), // offline: don't wait forever
      ]);
    } catch (_) {}
  }

  const SCALE = 2; // draw at 2x so text stays sharp when zoomed in a chat
  function makeCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width * SCALE;
    canvas.height = height * SCALE;
    const ctx = canvas.getContext("2d");
    ctx.scale(SCALE, SCALE);
    ctx.textBaseline = "middle";
    return { canvas, ctx };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth) {
    text = String(text);
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length > 1 && ctx.measureText(text + "…").width > maxWidth) text = text.slice(0, -1);
    return text + "…";
  }

  function text(ctx, str, x, y, { font, color, align = "left", max } = {}) {
    if (font) ctx.font = font;
    if (color) ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(max ? fitText(ctx, str, max) : str, x, y);
  }

  function netColor(c, v) {
    return v > 0.004 ? c.goldDeep : v < -0.004 ? c.loss : c.soft;
  }

  // Shared header: spade + app name on the left, small note on the right
  function drawBrand(ctx, c, width, pad, rightNote) {
    text(ctx, "♠", pad, 34, { font: `22px ${SERIF}`, color: c.goldDeep });
    text(ctx, "Retro Poker Club", pad + 26, 35, { font: `500 17px ${SERIF}`, color: c.ink });
    if (rightNote) text(ctx, rightNote, width - pad, 35, { font: `13px ${SANS}`, color: c.soft, align: "right" });
    ctx.fillStyle = c.line;
    ctx.fillRect(pad, 58, width - pad * 2, 1);
  }

  function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event";
  }

  async function shareCanvas(canvas, filename, title) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Couldn't create the image");
    const file = new File([blob], filename, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return; // user closed the share sheet
        // anything else: fall through to download
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Image saved to Downloads");
  }

  // ---- Closed event results ----
  function drawEventImage(night) {
    const c = palette();
    const W = 540, PAD = 28, ROW = 46;
    const rows = (night.players || [])
      .map((np) => ({ name: np.name, in: buyinTotal(np), out: Number(np.cashOut || 0), net: Number(np.net || 0) }))
      .sort((a, b) => b.net - a.net);
    const listTop = 248;
    const transfers = settleMode(night) === "transfer" ? settleTransfers(night) : [];
    const paid = new Set(night.paid || []);
    const PAY_ROW = 40;
    const payTop = listTop + 34 + rows.length * ROW + 30;
    const H = transfers.length ? payTop + 36 + transfers.length * PAY_ROW + 28 : listTop + 34 + rows.length * ROW + 28;
    const { canvas, ctx } = makeCanvas(W, H);

    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    drawBrand(ctx, c, W, PAD, "Event results");

    text(ctx, fmtDate(night.date), PAD, 92, { font: `600 26px ${SERIF}`, color: c.ink, max: W - PAD * 2 });
    if (night.location) text(ctx, night.location, PAD, 122, { font: `15px ${SANS}`, color: c.soft, max: W - PAD * 2 });

    // total buy-ins card
    const cardY = 146;
    roundRect(ctx, PAD, cardY, W - PAD * 2, 76, 12);
    ctx.fillStyle = c.surface;
    ctx.fill();
    ctx.strokeStyle = c.gold;
    ctx.lineWidth = 1;
    ctx.stroke();
    text(ctx, "Total buy-ins", PAD + 16, cardY + 24, { font: `13px ${SANS}`, color: c.soft });
    text(ctx, fmtMoney(nightPotTotal(night)), PAD + 16, cardY + 52, { font: `600 28px ${SERIF}`, color: c.goldDeep });
    text(ctx, `${rows.length} player${rows.length === 1 ? "" : "s"}`, W - PAD - 16, cardY + 52, { font: `14px ${SANS}`, color: c.soft, align: "right" });

    // results table
    const colIn = W - PAD - 250, colOut = W - PAD - 140, colNet = W - PAD - 12;
    const headY = listTop + 12;
    ctx.font = `600 12px ${SANS}`;
    ctx.fillStyle = c.soft;
    text(ctx, "Player", PAD + 12, headY);
    text(ctx, "In", colIn, headY, { align: "right" });
    text(ctx, "Out", colOut, headY, { align: "right" });
    text(ctx, "Net", colNet, headY, { align: "right" });

    rows.forEach((r, i) => {
      const y = listTop + 34 + i * ROW;
      if (i % 2 === 0) {
        roundRect(ctx, PAD, y, W - PAD * 2, ROW, 8);
        ctx.fillStyle = c.surface;
        ctx.fill();
      }
      const mid = y + ROW / 2;
      text(ctx, r.name, PAD + 12, mid, { font: `700 16px ${SANS}`, color: c.ink, max: colIn - PAD - 70 });
      text(ctx, fmtMoney(r.in), colIn, mid, { font: `15px ${SANS}`, color: c.soft, align: "right" });
      text(ctx, fmtMoney(r.out), colOut, mid, { font: `15px ${SANS}`, color: c.soft, align: "right" });
      text(ctx, fmtSigned(r.net), colNet, mid, { font: `700 16px ${SANS}`, color: netColor(c, r.net), align: "right" });
    });

    if (transfers.length) {
      text(ctx, "Who pays whom", PAD, payTop + 10, { font: `600 20px ${SERIF}`, color: c.ink });
      transfers.forEach((t, i) => {
        const y = payTop + 36 + i * PAY_ROW;
        if (i % 2 === 0) {
          roundRect(ctx, PAD, y, W - PAD * 2, PAY_ROW, 8);
          ctx.fillStyle = c.surface;
          ctx.fill();
        }
        const mid = y + PAY_ROW / 2;
        const isPaid = paid.has(t.key);
        const line = `${t.from}  \u2192  ${t.to}`;
        text(ctx, line, PAD + 12, mid, { font: `600 15px ${SANS}`, color: isPaid ? c.soft : c.ink, max: W - PAD * 2 - 150 });
        text(ctx, (isPaid ? "\u2713 paid  " : "") + fmtMoney(t.amount), W - PAD - 12, mid, { font: `700 15px ${SANS}`, color: isPaid ? c.soft : c.ink, align: "right" });
      });
    }
    return canvas;
  }

  onTap($("btn-share-event"), async () => {
    const night = await DB.read("nights", state.currentNightId);
    if (!night) return;
    await fontsReady();
    const canvas = drawEventImage(night);
    await shareCanvas(canvas, `poker-${night.date}-${slug(night.location)}.png`, `Poker — ${fmtDate(night.date)}`);
  });

  // ================= Service worker =================
  // When a new release has been downloaded, reload into it at a safe moment:
  // never in the middle of typing cash-outs or with a popup open.
  let updateReady = false;
  function reloadIfSafe() {
    if (updateReady && state.currentView !== "closeout" && !isModalOpen()) location.reload();
  }
  if ("serviceWorker" in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) return; // first install, nothing to update
      updateReady = true;
      reloadIfSafe();
    });
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.error("SW registration failed", err));
    });
  }

  // ================= Android back gesture =================
  // Back closes an open popup, otherwise steps back one screen. On the Events
  // home screen the first back shows "Press back again to close"; a second
  // back within 2 seconds leaves the app (there is no guard entry left, so
  // Android closes it). A web app can't close itself any other way, and
  // swiping it away in the task switcher can't be intercepted at all.
  const EXIT_WINDOW_MS = 2000;
  let exitTimer = null;
  function pushGuard() {
    history.pushState({ rpcGuard: true }, "", location.href);
  }
  pushGuard();
  window.addEventListener("popstate", () => {
    if (exitTimer) return; // second back while armed: let it go (app closes)
    if (isModalOpen()) {
      closeModal();
    } else if (!goBack()) {
      toast("Press back again to close");
      exitTimer = setTimeout(() => {
        exitTimer = null;
        pushGuard();
      }, EXIT_WINDOW_MS);
      return;
    }
    pushGuard();
  });

  // ================= Members (admins only) =================
  function memberStatus(m) {
    if (m.user_id) return "Active";
    if (!m.invite_expires) return "No invite code";
    const exp = new Date(m.invite_expires);
    if (exp < new Date()) return "Invite code expired";
    const iso = new Date(exp - exp.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    return `Invited &middot; code valid until ${fmtDate(iso)}`;
  }

  async function renderMembers() {
    const token = renderToken("members");
    const rows = await DB.request(() =>
      DB.client.from("members").select("email,role,user_id,created_at,invite_expires").order("created_at")
    );
    if (isStale("members", token)) return;
    const order = { owner: 0, admin: 1, viewer: 2 };
    rows.sort((a, b) => order[a.role] - order[b.role] || a.email.localeCompare(b.email));
    const me = window.RPC_AUTH.userId;
    const list = $("members-list");
    list.innerHTML = "";
    rows.forEach((m) => {
      const self = m.user_id && m.user_id === me;
      const locked = m.role === "owner" || self;
      const card = el(`
        <div class="card${locked ? "" : " card-tappable"}">
          <div class="card-row">
            <div>
              <div class="card-title">${escapeHtml(m.email)}</div>
              <div class="card-sub member-sub">${self ? "You &middot; " : ""}${memberStatus(m)}</div>
            </div>
            <span class="badge${m.role === "viewer" ? " is-closed" : ""}">${ROLE_LABEL[m.role]}</span>
          </div>
        </div>
      `);
      if (!locked) card.addEventListener("click", () => openMemberModal(m));
      list.appendChild(card);
    });
  }

  function openMembers() {
    showView("members");
    renderMembers().catch(handleError);
  }
  $("btn-members").addEventListener("click", openMembers);

  function roleSwitch(current) {
    return `
      <div class="field">
        <label>Role</label>
        <div class="seg" id="f-role">
          <button type="button" class="btn btn-ghost${current === "viewer" ? " is-on" : ""}" data-role="viewer">Viewer</button>
          <button type="button" class="btn btn-ghost${current === "admin" ? " is-on" : ""}" data-role="admin">Admin</button>
        </div>
      </div>
      <p class="hint-text">Viewers see events and stats. Admins can also edit everything and manage members.</p>`;
  }
  function bindRoleSwitch() {
    const wrap = $("f-role");
    wrap.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        wrap.querySelectorAll("button").forEach((x) => x.classList.toggle("is-on", x === b));
      })
    );
    return () => wrap.querySelector(".is-on").dataset.role;
  }

  // Shows the invite code once, with a ready-to-send message.
  function showInvite(email, code) {
    const link = location.origin + location.pathname;
    const message = `Retro Poker Club\n${link}\nTap "First time here?" and use:\nEmail: ${email}\nInvite code: ${code}\n(valid for 7 days)`;
    openModal(`
      <h2>Invite code</h2>
      <p class="hint-text">Send this to ${escapeHtml(email)}. It works once and expires in 7 days.</p>
      <div class="invite-code">${escapeHtml(code)}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-close">Close</button>
        <button class="btn btn-gold" id="m-send">Send message</button>
      </div>
    `);
    $("m-close").addEventListener("click", closeModal);
    onTap($("m-send"), async () => {
      if (navigator.share) {
        try {
          await navigator.share({ text: message });
          return;
        } catch (err) {
          if (err && err.name === "AbortError") return;
        }
      }
      try {
        await navigator.clipboard.writeText(message);
        toast("Message copied");
      } catch (_) {
        toast("Couldn't copy — note the code down");
      }
    });
  }

  $("btn-add-member").addEventListener("click", () => {
    openModal(`
      <h2>Add member</h2>
      <div class="field">
        <label for="f-memail">Email</label>
        <input type="email" id="f-memail" inputmode="email" placeholder="friend@example.com">
      </div>
      ${roleSwitch("viewer")}
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-add">Add</button>
      </div>
    `);
    const getRole = bindRoleSwitch();
    focusField($("f-memail"));
    $("m-cancel").addEventListener("click", closeModal);
    onTap($("m-add"), async () => {
      const email = $("f-memail").value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("Enter a valid email");
      let code;
      try {
        code = await DB.request(() => DB.client.rpc("invite_member", { p_email: email, p_role: getRole() }));
      } catch (err) {
        if (/already a member/i.test(err.message)) return toast(`${email} is already a member`);
        throw err;
      }
      await renderMembers();
      showInvite(email, code);
    });
  });

  function openMemberModal(m) {
    const pending = !m.user_id;
    openModal(`
      <h2>${escapeHtml(m.email)}</h2>
      ${roleSwitch(m.role)}
      ${pending
        ? `<button class="btn btn-ghost btn-block" id="m-code">New invite code</button>`
        : `<button class="btn btn-ghost btn-block" id="m-reset">Reset login</button>`}
      <div class="modal-actions">
        <button class="btn btn-ghost btn-danger-text" id="m-remove">Remove</button>
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-save">Save</button>
      </div>
    `);
    const getRole = bindRoleSwitch();
    $("m-cancel").addEventListener("click", closeModal);
    const run = async (query, message) => {
      await DB.request(query);
      closeModal();
      await renderMembers();
      toast(message);
    };
    onTap($("m-save"), async () => {
      const role = getRole();
      if (role === m.role) return closeModal();
      await run(() => DB.client.from("members").update({ role }).eq("email", m.email), `${m.email} is now ${ROLE_LABEL[role].toLowerCase()}`);
    });
    if (pending) {
      onTap($("m-code"), async () => {
        const code = await DB.request(() => DB.client.rpc("invite_member", { p_email: m.email, p_role: getRole() }));
        await renderMembers();
        showInvite(m.email, code);
      });
    } else {
      onTap($("m-reset"), async () => {
        if (!confirm(`Reset the login for ${m.email}? They'll be signed out and need a new invite code to set a password.`)) return;
        const code = await DB.request(() => DB.client.rpc("reset_member_login", { p_email: m.email }));
        await renderMembers();
        showInvite(m.email, code);
      });
    }
    onTap($("m-remove"), async () => {
      if (!confirm(`Remove ${m.email}? They won't be able to open the club any more.`)) return;
      await run(() => DB.client.from("members").delete().eq("email", m.email), "Member removed");
    });
  }

  // ================= Data helpers =================
  async function isDatabaseEmpty() {
    const data = await DB.exportAll();
    return !data.players.length && !data.nights.length && !data.chips.length;
  }

  // Keep this phone's copy of the data from being evicted when space runs low.
  async function requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    } catch (_) {}
  }

  // First start after the move to the cloud: an admin whose phone still has
  // the data of the old offline-only version gets a one-tap upload.
  const UPLOAD_DONE_KEY = "rpc-local-uploaded";
  async function offerLocalUpload() {
    if (!canEdit() || pref.get(UPLOAD_DONE_KEY) === "1") return;
    let local;
    try {
      local = await LegacyDB.readAll();
    } catch (_) {
      return;
    }
    if (!local || (!local.nights.length && !local.players.length && !local.chips.length)) return;
    if (!(await isDatabaseEmpty())) return;
    const n = local.nights.length, p = local.players.length;
    openModal(`
      <h2>Move your data to the cloud</h2>
      <p class="hint-text">This phone has ${n} event${n === 1 ? "" : "s"} and ${p} player${p === 1 ? "" : "s"} from the offline version. Upload them so everyone in the club can see them?</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Not now</button>
        <button class="btn btn-gold" id="m-upload">Upload</button>
      </div>
    `);
    $("m-cancel").addEventListener("click", closeModal);
    onTap($("m-upload"), async () => {
      await DB.importAll(local);
      pref.set(UPLOAD_DONE_KEY, "1");
      closeModal();
      refreshCurrentView();
      toast("Data uploaded");
    });
  }

  // ================= Keeping screens current =================
  // Re-draws whatever is on screen. Skips the close-out screen so typed
  // cash-outs are never wiped by someone else's change.
  function refreshCurrentView() {
    const run = (p) => Promise.resolve(p).catch(handleError);
    switch (state.currentView) {
      case "nights": run(renderNightsList()); break;
      case "night-detail": if (state.currentNightId) run(renderNightDetail(state.currentNightId)); break;
      case "players": run(renderPlayersList()); break;
      case "leaderboard": run(renderLeaderboard()); break;
      case "player-detail": if (state.currentPlayerId) run(renderPlayerDetail(state.currentPlayerId)); break;
      case "chips": run(renderChipsList()); break;
      case "members": run(renderMembers()); break;
      case "closeout": run(refreshCloseout()); break;
      default: break;
    }
    if (state.currentView !== "closeout") run(updatePotStrip());
  }

  DB.onStatus((offline) => {
    $("offline-strip").hidden = !offline;
  });
  window.addEventListener("online", () => DB.refresh());
  document.addEventListener("visibilitychange", () => {
    // back in the app: fetch what changed while it was in the background
    if (document.visibilityState === "visible" && window.RPC_AUTH && window.RPC_AUTH.role) DB.refresh();
  });
  // Anything that failed outside a button handler (e.g. a list that couldn't load)
  window.addEventListener("unhandledrejection", (e) => {
    if (e.reason && e.reason.name === "DbError") {
      e.preventDefault();
      if (e.reason.kind !== "offline" || !DB.offline) handleError(e.reason);
    }
  });

  // While typing (keyboard open), hide the tab bar so more of the screen is visible.
  document.addEventListener("focusin", (e) => {
    if (e.target.matches("input:not([type=checkbox]):not([type=file]), textarea")) document.body.classList.add("is-typing");
  });
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || !a.matches("input, textarea")) document.body.classList.remove("is-typing");
    }, 50);
  });

  // ================= Start (called after sign-in) =================
  window.RPC_APP = {
    start() {
      openTab("nights");
      requestPersistentStorage();
      DB.subscribe();
      let redraw = null;
      DB.onChanged(() => {
        clearTimeout(redraw);
        redraw = setTimeout(refreshCurrentView, 150);
      });
      DB.exportAll().catch(() => {}); // load everything once so all tabs work offline
      offerLocalUpload().catch((err) => console.error(err));
    },
    refresh: refreshCurrentView,
  };
})();
