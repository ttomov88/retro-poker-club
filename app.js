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
  const DATE_LOCALE = "en-GB"; // fixed, so dates match the English UI regardless of phone language
  const TAB_ROOTS = ["nights", "players", "chips"];

  // ================= Helpers =================
  const $ = (id) => document.getElementById(id);

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
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

  function fmtDate(iso) {
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(DATE_LOCALE, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
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

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._h);
    toast._h = setTimeout(() => (t.hidden = true), 2400);
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
        console.error(err);
        toast("Something went wrong \u2014 please try again");
      } finally {
        button.disabled = false;
      }
    });
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
  }

  function openTab(tab) {
    showView(tab);
    if (tab === "nights") renderNightsList();
    if (tab === "players") renderPlayersList();
    if (tab === "chips") renderChipsList();
  }

  function openEvent(nightId, returnTo) {
    state.currentNightId = nightId;
    state.nightDetailReturnTo = returnTo || "nights";
    showView("night-detail");
    renderNightDetail(nightId);
  }

  function openPlayer(playerId) {
    state.currentPlayerId = playerId;
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
        openTab("players");
        return true;
      case "settings":
        openTab(state.settingsReturnTab);
        return true;
      case "players":
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

  function openModal(html) {
    modalRoot.innerHTML = html;
    backdrop.hidden = false;
    syncViewportHeight();
  }
  function closeModal() {
    backdrop.hidden = true;
    modalRoot.innerHTML = "";
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

  $("btn-new-night").addEventListener("click", () => {
    openModal(`
      <h2>New Event</h2>
      <div class="field">
        <label for="f-date">Date</label>
        <input type="date" id="f-date" value="${todayISO()}">
      </div>
      <div class="field">
        <label for="f-location">Location <span class="muted">(optional)</span></label>
        <input type="text" id="f-location" placeholder="e.g. Marto's place">
      </div>
      <div class="field">
        <label for="f-notes">Notes <span class="muted">(optional)</span></label>
        <input type="text" id="f-notes" placeholder="Anything worth remembering">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-create">Start event</button>
      </div>
    `);
    $("m-cancel").addEventListener("click", closeModal);
    onTap($("m-create"), async () => {
      const id = await DB.add("nights", {
        date: $("f-date").value || todayISO(),
        location: $("f-location").value.trim(),
        notes: $("f-notes").value.trim(),
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
    const night = await DB.get("nights", nightId);
    if (isStale("nightDetail", token) || !night) return;

    const isOpen = night.status === "open";
    $("nd-date").textContent = fmtDate(night.date) + (night.location ? " \u2014 " + night.location : "");
    $("nd-status").textContent = isOpen ? "Open" : "Closed";
    $("nd-status").className = "badge" + (isOpen ? "" : " is-closed");

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
        .map((b, i) => `<button type="button" class="buyin-chip" data-idx="${i}">${fmtMoney(b.amount)}</button>`)
        .join("");
      const row = el(`
        <div class="card player-row">
          <div class="card-row">
            <div class="card-title">${escapeHtml(np.name)}</div>
            <div class="money money-strong">${fmtMoney(buyinTotal(np))}</div>
          </div>
          <div class="buyin-list">${chips}</div>
          <div class="player-actions">
            <button class="btn btn-ghost-gold btn-sm btn-quick-buyin">+${fmtMoney(QUICK_BUYINS[0]).replace(".00", "")}</button>
            <button class="btn btn-ghost-gold btn-sm btn-add-buyin">+ Buy-in</button>
            <button class="btn btn-ghost btn-sm btn-remove-player">Remove</button>
          </div>
        </div>
      `);
      onTap(row.querySelector(".btn-quick-buyin"), async () => {
        if (await addBuyin(night.id, np.playerId, QUICK_BUYINS[0])) toast(`${fmtMoney(QUICK_BUYINS[0])} added for ${np.name}`);
      });
      row.querySelector(".btn-add-buyin").addEventListener("click", () => openBuyinModal(night.id, np.playerId, np.name));
      row.querySelectorAll(".buyin-chip").forEach((chipEl) => {
        chipEl.addEventListener("click", () => openEditBuyinModal(night.id, np.playerId, Number(chipEl.dataset.idx)));
      });
      onTap(row.querySelector(".btn-remove-player"), async () => {
        if (!confirm(`Remove ${np.name} from this event? Their buy-ins will be removed too.`)) return;
        const fresh = await DB.get("nights", night.id);
        fresh.players = fresh.players.filter((p) => p.playerId !== np.playerId);
        await DB.put("nights", fresh);
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

  async function addBuyin(nightId, playerId, amount) {
    const night = await DB.get("nights", nightId);
    const np = night && night.players.find((p) => p.playerId === playerId);
    if (!np) return false;
    np.buyins = np.buyins || [];
    np.buyins.push({ amount, ts: Date.now() });
    await DB.put("nights", night);
    await refreshEvent(nightId);
    return true;
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

  async function openEditBuyinModal(nightId, playerId, buyinIndex) {
    const night = await DB.get("nights", nightId);
    const np = night && night.players.find((p) => p.playerId === playerId);
    const buyin = np && np.buyins ? np.buyins[buyinIndex] : null;
    if (!buyin) return;

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
      const fresh = await DB.get("nights", nightId);
      const freshNp = fresh.players.find((p) => p.playerId === playerId);
      if (!freshNp || !freshNp.buyins[buyinIndex]) return closeModal();
      change(freshNp.buyins);
      await DB.put("nights", fresh);
      closeModal();
      await refreshEvent(nightId);
    }

    onTap($("m-delete"), async () => {
      if (!confirm("Delete this buy-in?")) return;
      await updateBuyin((buyins) => buyins.splice(buyinIndex, 1));
    });
    onTap($("m-save"), async () => {
      const amount = readAmount(input);
      if (!amount) return toast("Enter an amount above zero");
      await updateBuyin((buyins) => (buyins[buyinIndex].amount = amount));
    });
  }

  $("btn-add-player-to-night").addEventListener("click", async () => {
    const night = await DB.get("nights", state.currentNightId);
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

      toAdd.forEach((p) => freshNight.players.push({ playerId: p.id, name: p.name, buyins: [], cashOut: null, net: null }));
      await DB.put("nights", freshNight);
      closeModal();
      await refreshEvent(state.currentNightId);
      if (note) toast(note);
    });
  });

  onTap($("btn-close-night"), async () => {
    const night = await DB.get("nights", state.currentNightId);
    if (!night.players || night.players.length === 0) return toast("Add players before closing the event");
    showView("closeout");
    renderCloseout(night);
  });

  onTap($("btn-reopen-night"), async () => {
    if (!confirm("Reopen this event? You'll be able to edit buy-ins and results again.")) return;
    const night = await DB.get("nights", state.currentNightId);
    night.status = "open";
    night.closedAt = null;
    await DB.put("nights", night);
    await refreshEvent(night.id);
  });

  onTap($("btn-delete-night"), async () => {
    if (!confirm("Delete this event permanently? Buy-ins and results will be lost. This can't be undone.")) return;
    await DB.delete("nights", state.currentNightId);
    state.currentNightId = null;
    if (state.nightDetailReturnTo === "player-detail" && state.currentPlayerId) openPlayer(state.currentPlayerId);
    else openTab("nights");
    toast("Event deleted");
  });

  // ================= CLOSE-OUT =================
  function renderCloseout(night) {
    const wrap = $("closeout-list");
    wrap.innerHTML = "";
    night.players.forEach((np) => {
      const row = el(`
        <div class="card closeout-row">
          <div class="card-row">
            <div class="card-title">${escapeHtml(np.name)}</div>
            <div class="card-sub">Buy-in ${fmtMoney(buyinTotal(np))}</div>
          </div>
          <div class="field-row">
            <label for="in-${np.playerId}">Cash-out</label>
            <input type="number" inputmode="decimal" step="0.01" min="0" class="amount-input" id="in-${np.playerId}" placeholder="0.00" value="${np.cashOut != null ? escapeHtml(np.cashOut) : ""}">
            <span class="co-net" id="net-${np.playerId}"></span>
          </div>
        </div>
      `);
      row.querySelector("input").addEventListener("input", () => updateCloseoutCheck(night));
      wrap.appendChild(row);
    });
    updateCloseoutCheck(night);
  }

  function readCloseoutRows(night) {
    return night.players.map((np) => {
      const total = buyinTotal(np);
      const input = $(`in-${np.playerId}`);
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
    if (autoBackupEnabled()) {
      toast((await autoBackup()) ? "Event closed \u2014 backup saved" : "Event closed \u2014 backup failed, export manually");
    } else {
      toast("Event closed");
    }
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
      card.addEventListener("click", () => openPlayer(p.id));
      list.appendChild(card);
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

  async function renderPlayerDetail(playerId) {
    const token = renderToken("playerDetail");
    const [player, nights] = await Promise.all([DB.get("players", playerId), DB.getAll("nights")]);
    if (isStale("playerDetail", token) || !player) return;

    const stats = playerStats(nights, playerId);
    $("pd-name").textContent = player.name;
    $("pd-archived").hidden = !player.archived;
    $("btn-archive-player").textContent = player.archived ? "Restore to roster" : "Archive player";

    const statCards = [
      ["Events played", stats.eventsPlayed, ""],
      ["Net profit/loss", fmtSigned(stats.net), amountClass(stats.net)],
      ["Total buy-in", fmtMoney(stats.totalBuyIn), ""],
      ["Total cash-out", fmtMoney(stats.totalCashOut), ""],
      ["Biggest win", stats.biggestWin === null ? "\u2014" : fmtSigned(stats.biggestWin), "amount-pos"],
      ["Biggest loss", stats.biggestLoss === null ? "\u2014" : fmtSigned(stats.biggestLoss), "amount-neg"],
      ["ROI (return on investment)",
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
    const player = await DB.get("players", state.currentPlayerId);
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

      player.name = newName;
      await DB.put("players", player);
      // Keep past events in sync with the new name
      for (const night of await DB.getAll("nights")) {
        const mine = (night.players || []).filter((np) => np.playerId === player.id && np.name !== newName);
        if (mine.length) {
          mine.forEach((np) => (np.name = newName));
          await DB.put("nights", night);
        }
      }
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
      row.addEventListener("click", () => openChipModal(c));
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
        await DB.delete("chips", existing.id);
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
      if (isEdit) await DB.put("chips", { ...obj, id: existing.id });
      else await DB.add("chips", obj);
      closeModal();
      renderChipsList();
    });
  }

  $("btn-add-chip").addEventListener("click", () => openChipModal(null));

  // ================= SETTINGS / EXPORT / IMPORT =================
  $("btn-open-settings").addEventListener("click", () => {
    if (state.currentView !== "settings") state.settingsReturnTab = state.currentTab;
    updateLastBackupLabel();
    showView("settings");
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
  const AUTO_BACKUP_KEY = "rpc-auto-backup";
  const LAST_BACKUP_KEY = "rpc-last-backup";
  const RESTORE_DISMISSED_KEY = "rpc-restore-dismissed";

  function autoBackupEnabled() {
    return pref.get(AUTO_BACKUP_KEY) !== "off";
  }
  function setAutoBackup(on) {
    pref.set(AUTO_BACKUP_KEY, on ? "on" : "off");
  }

  function timeAgo(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.floor(hours / 24);
    return days === 1 ? "yesterday" : days + " days ago";
  }
  function updateLastBackupLabel() {
    const ts = Number(pref.get(LAST_BACKUP_KEY));
    $("last-backup").textContent = ts ? "Last backup: " + timeAgo(ts) : "No backup yet on this device";
  }
  $("auto-backup").checked = autoBackupEnabled();
  $("auto-backup").addEventListener("change", (e) => {
    setAutoBackup(e.target.checked);
    toast(e.target.checked ? "Auto-backup on" : "Auto-backup off");
  });

  async function autoBackup() {
    try {
      downloadJSON(await DB.exportAll(), backupFilename());
      pref.set(LAST_BACKUP_KEY, String(Date.now()));
      updateLastBackupLabel();
      return true;
    } catch (e) {
      console.error("Auto-backup failed", e);
      return false;
    }
  }

  onTap($("btn-export"), async () => {
    toast((await autoBackup()) ? "Backup exported" : "Export failed \u2014 please try again");
  });

  $("btn-import").addEventListener("click", () => $("import-file").click());

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (!(await isDatabaseEmpty()) && !confirm("Replace all data on this device with this backup?")) return;
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
      alert("Couldn't import that file: " + err.message);
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
    const H = listTop + 34 + rows.length * ROW + 28;
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
    return canvas;
  }

  onTap($("btn-share-event"), async () => {
    const night = await DB.get("nights", state.currentNightId);
    if (!night) return;
    await fontsReady();
    const canvas = drawEventImage(night);
    await shareCanvas(canvas, `poker-${night.date}-${slug(night.location)}.png`, `Poker — ${fmtDate(night.date)}`);
  });

  // ---- All-time player stats ----
  function drawStatsImage(rows, eventCount) {
    const c = palette();
    const PAD = 28, ROW = 44;
    // Column order: who → how often → money in → money out → extremes → bottom line (sort key)
    const cols = [
      { key: "rank", label: "#", w: 30, align: "left" },
      { key: "name", label: "Player", w: 170, align: "left" },
      { key: "events", label: "Events", w: 64, align: "right" },
      { key: "totalBuyIn", label: "Total buy-in", w: 104, align: "right", money: true },
      { key: "avgBuyIn", label: "Avg buy-in", w: 96, align: "right", money: true },
      { key: "totalCashOut", label: "Total cash-out", w: 124, align: "right", money: true },
      { key: "avgCashOut", label: "Avg cash-out", w: 104, align: "right", money: true },
      { key: "biggestWin", label: "Biggest win", w: 100, align: "right", signed: true },
      { key: "biggestLoss", label: "Biggest loss", w: 100, align: "right", signed: true },
      { key: "net", label: "Net ▾", w: 108, align: "right", signed: true, strong: true, sort: true },
      { key: "roi", label: "ROI", w: 80, align: "right", pct: true },
      { key: "winRate", label: "Win rate", w: 118, align: "right", pct: true },
    ];
    const tableW = cols.reduce((s, col) => s + col.w, 0) + 24;
    const W = tableW + PAD * 2;
    const listTop = 150;
    const notes = [
      ["ROI (return on investment)", "net result \u00F7 total buy-in: how much a player wins or loses per euro bought in."],
      ["Win rate", "share of events a player finished in profit."],
    ];
    if (rows.some((r) => r.fewEvents)) notes.push(["*", `fewer than ${MIN_EVENTS_FOR_RATES} events, too few to be reliable.`]);
    const NOTE_LINE = 20;
    const H = listTop + 40 + rows.length * ROW + 34 + notes.length * NOTE_LINE + 30;
    const { canvas, ctx } = makeCanvas(W, H);

    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    drawBrand(ctx, c, W, PAD, fmtDate(todayISO()));
    text(ctx, "All-time player stats", PAD, 94, { font: `600 26px ${SERIF}`, color: c.ink });
    text(ctx, `${rows.length} players · ${eventCount} event${eventCount === 1 ? "" : "s"}`, PAD, 124, { font: `14px ${SANS}`, color: c.soft });

    // column x positions (left edge / right edge for right-aligned)
    let x = PAD + 12;
    cols.forEach((col) => {
      col.x = col.align === "right" ? x + col.w - 8 : x;
      x += col.w;
    });

    const headY = listTop + 18;
    cols.forEach((col) => {
      text(ctx, col.label, col.x, headY, { font: `600 12px ${SANS}`, color: col.sort ? c.goldDeep : c.soft, align: col.align });
    });

    rows.forEach((r, i) => {
      const y = listTop + 40 + i * ROW;
      if (i % 2 === 0) {
        roundRect(ctx, PAD, y, tableW, ROW, 8);
        ctx.fillStyle = c.surface;
        ctx.fill();
      }
      const mid = y + ROW / 2;
      cols.forEach((col) => {
        const v = r[col.key];
        let str, color = c.soft, font = `15px ${SANS}`;
        if (col.key === "rank") str = String(i + 1);
        else if (col.key === "name") { str = v; color = c.ink; font = `700 16px ${SANS}`; }
        else if (col.key === "events") { str = String(v); color = c.ink; }
        else if (col.key === "roi") {
          str = fmtPct(v, true) + (r.fewEvents && v !== null ? "*" : "");
          color = v === null || r.fewEvents ? c.soft : netColor(c, v);
        } else if (col.key === "winRate") {
          str = v === null ? "\u2014" : `${fmtPct(v)} (${r.eventsWon}/${r.events})` + (r.fewEvents ? "*" : "");
          color = r.fewEvents ? c.soft : c.ink;
        } else if (col.signed) { str = v === null ? "—" : fmtSigned(v); color = v === null ? c.soft : netColor(c, v); }
        else str = fmtMoney(v);
        if (col.strong) font = `700 16px ${SANS}`;
        text(ctx, str, col.x, mid, { font, color, align: col.align, max: col.key === "name" ? col.w - 12 : undefined });
      });
    });

    // short explanation under the table
    let ny = listTop + 40 + rows.length * ROW + 30;
    notes.forEach(([term, def]) => {
      text(ctx, term, PAD, ny, { font: `700 13px ${SANS}`, color: c.ink });
      const tw = ctx.measureText(term).width;
      text(ctx, " \u2014 " + def.replace(/^\u2014 /, ""), PAD + tw, ny, { font: `13px ${SANS}`, color: c.soft });
      ny += NOTE_LINE;
    });
    text(ctx, "Archived players not shown", PAD, ny + 4, { font: `12px ${SANS}`, color: c.soft });
    return canvas;
  }

  onTap($("btn-share-players"), async () => {
    const [roster, nights] = await Promise.all([DB.getAll("players"), DB.getAll("nights")]);
    const rows = roster
      .filter((p) => !p.archived)
      .map((p) => {
        const s = playerStats(nights, p.id);
        return {
          name: p.name,
          events: s.eventsPlayed,
          totalBuyIn: s.totalBuyIn,
          avgBuyIn: s.eventsPlayed ? round2(s.totalBuyIn / s.eventsPlayed) : 0,
          totalCashOut: s.totalCashOut,
          avgCashOut: s.eventsPlayed ? round2(s.totalCashOut / s.eventsPlayed) : 0,
          biggestWin: s.biggestWin,
          biggestLoss: s.biggestLoss,
          roi: s.roi,
          winRate: s.winRate,
          eventsWon: s.eventsWon,
          fewEvents: s.fewEvents,
          net: s.net,
        };
      })
      .filter((r) => r.events > 0)
      .sort((a, b) => b.net - a.net || b.totalCashOut - a.totalCashOut || a.name.localeCompare(b.name));
    if (!rows.length) return toast("No closed events yet — nothing to share");
    await fontsReady();
    const eventCount = nights.filter((n) => n.status === "closed").length;
    await shareCanvas(drawStatsImage(rows, eventCount), `poker-stats-${todayISO()}.png`, "Poker — all-time stats");
  });

  // ================= Service worker =================
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.error("SW registration failed", err));
    });
  }

  // ================= Android back gesture =================
  // Back closes an open popup, otherwise steps back one screen; only on the
  // Events home screen does it ask before leaving the app.
  // (Swiping the app away in the task switcher can't be intercepted by any web app.)
  history.pushState({ rpcGuard: true }, "", location.href);
  window.addEventListener("popstate", () => {
    if (isModalOpen()) {
      closeModal();
    } else if (!goBack()) {
      if (confirm("Close Retro Poker Club?")) {
        history.back();
        return;
      }
    }
    history.pushState({ rpcGuard: true }, "", location.href);
  });

  // ================= Data protection =================
  async function isDatabaseEmpty() {
    const data = await DB.exportAll();
    return !data.players.length && !data.nights.length && !data.chips.length;
  }

  // Ask Chrome to treat this app's storage as persistent, so it isn't
  // silently evicted when the phone runs low on space. (A manual
  // "Clear browsing data" still removes it — hence the restore prompt below.)
  async function requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    } catch (_) {}
  }

  // Empty app (fresh install or Chrome data was cleared): offer a one-tap
  // restore from the backup file in Downloads.
  async function offerRestoreIfEmpty() {
    if (!(await isDatabaseEmpty()) || pref.get(RESTORE_DISMISSED_KEY) === "1") return;
    openModal(`
      <h2>No data found</h2>
      <p class="hint-text">Restore from a backup file? Auto-backups are in your Downloads folder.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Start fresh</button>
        <button class="btn btn-gold" id="m-restore">Restore</button>
      </div>
    `);
    $("m-cancel").addEventListener("click", () => {
      pref.set(RESTORE_DISMISSED_KEY, "1");
      closeModal();
    });
    $("m-restore").addEventListener("click", () => {
      closeModal();
      $("import-file").click();
    });
  }

  // ================= Init =================
  async function init() {
    await openDB();
    openTab("nights");
    requestPersistentStorage();
    offerRestoreIfEmpty();
  }
  init();
})();
