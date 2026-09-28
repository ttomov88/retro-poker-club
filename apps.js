/* Retro Poker Club — app logic */

(function () {
  "use strict";

  // ---------------- State ----------------
  const state = {
    currentTab: "nights",
    currentNightId: null,
    currentPlayerId: null,
    nightDetailReturnTo: "nights", // 'nights' | 'player-detail'
    settingsReturnTab: "nights",
    currencySymbol: "\u20AC",
    currencyCode: "EUR",
  };

  // ---------------- Helpers ----------------
  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function getCurrencySymbol() {
    return state.currencySymbol || "\u20AC";
  }

  function getCurrencyCode() {
    return state.currencyCode || "EUR";
  }

  function fmtMoney(n) {
    const v = round2(n || 0);
    return getCurrencySymbol() + v.toFixed(2);
  }

  function fmtSigned(n) {
    const v = round2(n || 0);
    const sym = getCurrencySymbol();
    if (v > 0) return "+" + sym + v.toFixed(2);
    if (v < 0) return "-" + sym + Math.abs(v).toFixed(2);
    return sym + v.toFixed(2);
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
    return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  }

  function todayISO() {
    const d = new Date();
    const off = d.getTimezoneOffset();
    const local = new Date(d.getTime() - off * 60000);
    return local.toISOString().slice(0, 10);
  }

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._h);
    toast._h = setTimeout(() => (t.hidden = true), 2200);
  }

  function buyinTotal(np) {
    return round2((np.buyins || []).reduce((s, b) => s + Number(b.amount || 0), 0));
  }

  function nightPotTotal(night) {
    return round2((night.players || []).reduce((s, np) => s + buyinTotal(np), 0));
  }

  async function loadSettings() {
    try {
      const symSetting = await DB.get("settings", "currencySymbol");
      if (symSetting && symSetting.value) state.currencySymbol = symSetting.value;

      const codeSetting = await DB.get("settings", "currencyCode");
      if (codeSetting && codeSetting.value) state.currencyCode = codeSetting.value;
    } catch (e) {
      console.error("Failed loading settings", e);
    }
  }

  // ---------------- Navigation ----------------
  function showView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
    const target = document.getElementById("view-" + name);
    if (target) target.classList.add("is-active");

    const tabRoots = ["nights", "players", "chips"];
    if (tabRoots.includes(name)) {
      state.currentTab = name;
      document.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.tab === name);
      });
      document.getElementById("pot-strip").hidden = true;
    }
    window.scrollTo(0, 0);
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      showView(tab);
      if (tab === "nights") renderNightsList();
      if (tab === "players") renderPlayersList();
      if (tab === "chips") renderChipsList();
    });
  });

  document.getElementById("btn-brand-home").addEventListener("click", () => {
    showView("nights");
    renderNightsList();
  });

  document.querySelectorAll("[data-back]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fallback = btn.dataset.back;
      if (fallback === "night-detail") {
        showView("night-detail");
        renderNightDetail(state.currentNightId);
        updatePotStrip();
      } else {
        showView(fallback);
        if (fallback === "nights") renderNightsList();
        if (fallback === "players") renderPlayersList();
      }
    });
  });

  // ---------------- Modal system ----------------
  const backdrop = document.getElementById("modal-backdrop");
  const modalRoot = document.getElementById("modal-root");

  function syncViewportHeight() {
    if (window.visualViewport) {
      backdrop.style.height = window.visualViewport.height + "px";
    }
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
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });

  modalRoot.addEventListener("focusin", (e) => {
    if (e.target.matches("input, select, textarea") && typeof e.target.scrollIntoView === "function") {
      setTimeout(() => {
        e.target.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 300);
    }
  });

  // ---------------- Pot strip (global header) ----------------
  async function updatePotStrip() {
    const strip = document.getElementById("pot-strip");
    if (!state.currentNightId) {
      strip.hidden = true;
      return;
    }
    const night = await DB.get("nights", state.currentNightId);
    if (!night || night.status !== "open") {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    document.getElementById("pot-strip-night").textContent = fmtDate(night.date);
    document.getElementById("pot-strip-amount").textContent = fmtMoney(nightPotTotal(night));
  }

  // ================= NIGHTS =================
  async function renderNightsList() {
    const nights = await DB.getAll("nights");
    nights.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : b.id - a.id));
    const list = document.getElementById("nights-list");
    const empty = document.getElementById("nights-empty");
    list.innerHTML = "";
    empty.hidden = nights.length > 0;

    nights.forEach((night) => {
      const pot = nightPotTotal(night);
      const count = (night.players || []).length;
      const statusLabel = night.status === "open" ? "Open" : "Closed";
      const card = el(`
        <div class="card card-tappable">
          <div class="card-row">
            <div>
              <div class="card-title">${fmtDate(night.date)}</div>
              <div class="card-sub">${count} player${count === 1 ? "" : "s"} &middot; ${fmtMoney(pot)} in play${night.location ? " &middot; " + escapeHtml(night.location) : ""}</div>
            </div>
            <span class="badge ${night.status === "closed" ? "is-closed" : ""}">${statusLabel}</span>
          </div>
        </div>
      `);
      card.addEventListener("click", () => {
        state.currentNightId = night.id;
        state.nightDetailReturnTo = "nights";
        showView("night-detail");
        renderNightDetail(night.id);
        updatePotStrip();
      });
      list.appendChild(card);
    });
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : s;
    return d.innerHTML;
  }

  document.getElementById("btn-new-night").addEventListener("click", () => {
    openModal(`
      <h2>New Event</h2>
      <div class="field">
        <label for="f-date">Date</label>
        <input type="date" id="f-date" value="${todayISO()}">
      </div>
      <div class="field">
        <label for="f-location">Location <span style="opacity:.6">(optional)</span></label>
        <input type="text" id="f-location" placeholder="e.g. Marto's place">
      </div>
      <div class="field">
        <label for="f-notes">Notes <span style="opacity:.6">(optional)</span></label>
        <input type="text" id="f-notes" placeholder="Anything worth remembering">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-create">Start event</button>
      </div>
    `);
    document.getElementById("m-cancel").addEventListener("click", closeModal);
    document.getElementById("m-create").addEventListener("click", async () => {
      const date = document.getElementById("f-date").value || todayISO();
      const location = document.getElementById("f-location").value.trim();
      const notes = document.getElementById("f-notes").value.trim();
      const night = {
        date,
        location,
        notes,
        status: "open",
        players: [],
        createdAt: Date.now(),
      };
      const id = await DB.add("nights", night);
      closeModal();
      state.currentNightId = id;
      state.nightDetailReturnTo = "nights";
      showView("night-detail");
      renderNightDetail(id);
      updatePotStrip();
    });
  });

  // ================= NIGHT DETAIL =================
  async function renderNightDetail(nightId) {
    const night = await DB.get("nights", nightId);
    if (!night) return;

    document.getElementById("nd-date").textContent = fmtDate(night.date) + (night.location ? " \u2014 " + night.location : "");
    const statusBadge = document.getElementById("nd-status");
    statusBadge.textContent = night.status === "open" ? "Open" : "Closed";
    statusBadge.className = "badge" + (night.status === "closed" ? " is-closed" : "");

    document.getElementById("nd-pot-amount").textContent = fmtMoney(nightPotTotal(night));
    document.getElementById("nd-pot-hero").querySelector(".pot-hero-label").textContent =
      night.status === "open" ? "Total buy-ins" : "Total buy-ins (final)";

    const openActions = document.getElementById("nd-open-actions");
    const closedSummary = document.getElementById("nd-closed-summary");

    if (night.status === "open") {
      openActions.hidden = false;
      closedSummary.hidden = true;
      renderNightPlayersEditable(night);
    } else {
      openActions.hidden = true;
      closedSummary.hidden = false;
      document.getElementById("nd-players").innerHTML = "";
      document.getElementById("nd-players-empty").hidden = true;
      renderNightResults(night);
    }
  }

  function renderNightPlayersEditable(night) {
    const wrap = document.getElementById("nd-players");
    const empty = document.getElementById("nd-players-empty");
    wrap.innerHTML = "";
    const players = night.players || [];
    empty.hidden = players.length > 0;

    players.forEach((np) => {
      const total = buyinTotal(np);
      const chips = (np.buyins || [])
        .map((b, i) => `<button type="button" class="buyin-chip" data-idx="${i}">${fmtMoney(b.amount)}</button>`)
        .join("");
      const row = el(`
        <div class="card player-row">
          <div class="card-row">
            <div class="card-title">${escapeHtml(np.name)}</div>
            <div class="money" style="font-weight:700;color:var(--gold-light)">${fmtMoney(total)}</div>
          </div>
          <div class="buyin-list">${chips}</div>
          <div class="player-actions">
            <button class="btn btn-ghost-gold btn-sm btn-add-buyin">+ Buy-in</button>
            <button class="btn btn-ghost btn-sm btn-remove-player">Remove</button>
          </div>
        </div>
      `);
      row.querySelector(".btn-add-buyin").addEventListener("click", () => openBuyinModal(night.id, np.playerId));
      row.querySelectorAll(".buyin-chip").forEach((chipEl) => {
        const idx = Number(chipEl.dataset.idx);
        chipEl.addEventListener("click", () => openEditBuyinModal(night.id, np.playerId, idx));
      });
      row.querySelector(".btn-remove-player").addEventListener("click", async () => {
        if (!confirm(`Remove ${np.name} from this event? Their buy-ins will be removed too.`)) return;
        const fresh = await DB.get("nights", night.id);
        fresh.players = fresh.players.filter((p) => p.playerId !== np.playerId);
        await DB.put("nights", fresh);
        renderNightDetail(night.id);
        updatePotStrip();
      });
      wrap.appendChild(row);
    });
  }

  function renderNightResults(night) {
    const wrap = document.getElementById("nd-results");
    wrap.innerHTML = "";
    (night.players || []).forEach((np) => {
      const total = buyinTotal(np);
      const row = el(`
        <div class="card">
          <div class="card-row">
            <div class="card-title">${escapeHtml(np.name)}</div>
            <div class="money ${amountClass(np.net)}">${fmtSigned(np.net)}</div>
          </div>
          <div class="card-sub">Buy-in ${fmtMoney(total)} &middot; Cash-out ${fmtMoney(np.cashOut)}</div>
        </div>
      `);
      wrap.appendChild(row);
    });
  }

  function openBuyinModal(nightId, playerId) {
    openModal(`
      <h2>Add buy-in</h2>
      <div class="field">
        <label for="f-amount">Amount (${escapeHtml(getCurrencyCode())})</label>
        <input type="number" id="f-amount" inputmode="decimal" step="0.01" min="0" placeholder="0.00" class="amount-input">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-add">Add buy-in</button>
      </div>
    `);
    const input = document.getElementById("f-amount");
    setTimeout(() => input.focus(), 50);
    document.getElementById("m-cancel").addEventListener("click", closeModal);
    document.getElementById("m-add").addEventListener("click", async () => {
      const amount = round2(parseFloat(input.value));
      if (!amount || amount <= 0) {
        toast("Enter an amount above zero");
        return;
      }
      const night = await DB.get("nights", nightId);
      const np = night.players.find((p) => p.playerId === playerId);
      np.buyins = np.buyins || [];
      np.buyins.push({ amount, ts: Date.now() });
      await DB.put("nights", night);
      closeModal();
      renderNightDetail(nightId);
      updatePotStrip();
    });
  }

  async function openEditBuyinModal(nightId, playerId, buyinIndex) {
    const night = await DB.get("nights", nightId);
    const np = night.players.find((p) => p.playerId === playerId);
    const buyin = np && np.buyins ? np.buyins[buyinIndex] : null;
    if (!buyin) return;

    openModal(`
      <h2>Edit buy-in</h2>
      <div class="field">
        <label for="f-edit-amount">Amount (${escapeHtml(getCurrencyCode())})</label>
        <input type="number" id="f-edit-amount" inputmode="decimal" step="0.01" min="0" class="amount-input" value="${buyin.amount}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-danger-text" id="m-delete">Delete</button>
        <button class="btn btn-gold" id="m-save">Save</button>
      </div>
    `);
    const input = document.getElementById("f-edit-amount");
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);

    document.getElementById("m-delete").addEventListener("click", async () => {
      if (!confirm("Delete this buy-in?")) return;
      const fresh = await DB.get("nights", nightId);
      const freshNp = fresh.players.find((p) => p.playerId === playerId);
      freshNp.buyins.splice(buyinIndex, 1);
      await DB.put("nights", fresh);
      closeModal();
      renderNightDetail(nightId);
      updatePotStrip();
    });

    document.getElementById("m-save").addEventListener("click", async () => {
      const amount = round2(parseFloat(input.value));
      if (!amount || amount <= 0) {
        toast("Enter an amount above zero");
        return;
      }
      const fresh = await DB.get("nights", nightId);
      const freshNp = fresh.players.find((p) => p.playerId === playerId);
      freshNp.buyins[buyinIndex].amount = amount;
      await DB.put("nights", fresh);
      closeModal();
      renderNightDetail(nightId);
      updatePotStrip();
    });
  }

  document.getElementById("btn-add-player-to-night").addEventListener("click", async () => {
    const night = await DB.get("nights", state.currentNightId);
    const roster = await DB.getAll("players");
    const already = new Set((night.players || []).map((p) => p.playerId));
    const available = roster.filter((p) => !already.has(p.id));

    const picks = new Set();
    openModal(`
      <h2>Add players</h2>
      ${available.length ? `<div class="roster-pick" id="roster-pick"></div>` : `<p class="hint-text">No one else in your roster yet &mdash; add a new name below.</p>`}
      <div class="field">
        <label for="f-newname">New player</label>
        <input type="text" id="f-newname" placeholder="Type a name and tap Add">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-gold" id="m-confirm">Add to event</button>
      </div>
    `);

    if (available.length) {
      const pickWrap = document.getElementById("roster-pick");
      available.forEach((p) => {
        const pill = el(`<button type="button" class="roster-pill">${escapeHtml(p.name)}</button>`);
        pill.addEventListener("click", () => {
          if (picks.has(p.id)) {
            picks.delete(p.id);
            pill.classList.remove("is-picked");
          } else {
            picks.add(p.id);
            pill.classList.add("is-picked");
          }
        });
        pickWrap.appendChild(pill);
      });
    }

    document.getElementById("m-cancel").addEventListener("click", closeModal);
    document.getElementById("m-confirm").addEventListener("click", async () => {
      const newName = document.getElementById("f-newname").value.trim();
      const freshNight = await DB.get("nights", state.currentNightId);
      freshNight.players = freshNight.players || [];

      for (const pid of picks) {
        const p = roster.find((r) => r.id === pid);
        if (p) freshNight.players.push({ playerId: p.id, name: p.name, buyins: [], cashOut: null, net: null });
      }
      if (newName) {
        const newId = await DB.add("players", { name: newName, createdAt: Date.now() });
        freshNight.players.push({ playerId: newId, name: newName, buyins: [], cashOut: null, net: null });
      }
      await DB.put("nights", freshNight);
      closeModal();
      renderNightDetail(state.currentNightId);
      updatePotStrip();
    });
  });

  document.getElementById("btn-close-night").addEventListener("click", async () => {
    const night = await DB.get("nights", state.currentNightId);
    if (!night.players || night.players.length === 0) {
      toast("Add players before closing the event");
      return;
    }
    showView("closeout");
    renderCloseout(night);
  });

  document.getElementById("btn-reopen-night").addEventListener("click", async () => {
    if (!confirm("Reopen this event? You'll be able to edit buy-ins and results again.")) return;
    const night = await DB.get("nights", state.currentNightId);
    night.status = "open";
    night.closedAt = null;
    await DB.put("nights", night);
    renderNightDetail(night.id);
    updatePotStrip();
  });

  document.getElementById("btn-delete-night").addEventListener("click", async () => {
    if (!confirm("Delete this event permanently? Buy-ins and results will be lost. This can't be undone.")) return;
    await DB.delete("nights", state.currentNightId);
    state.currentNightId = null;
    if (state.nightDetailReturnTo === "player-detail") {
      showView("player-detail");
      renderPlayerDetail(state.currentPlayerId);
    } else {
      showView("nights");
      renderNightsList();
    }
    updatePotStrip();
    toast("Event deleted");
  });

  // ================= CLOSEOUT =================
  function renderCloseout(night) {
    const wrap = document.getElementById("closeout-list");
    wrap.innerHTML = "";

    night.players.forEach((np) => {
      const total = buyinTotal(np);
      const row = el(`
        <div class="card closeout-row" data-pid="${np.playerId}">
          <div class="card-row">
            <div class="card-title">${escapeHtml(np.name)}</div>
            <div class="card-sub">Buy-in ${fmtMoney(total)}</div>
          </div>
          <div class="field-row">
            <label>Cash-out</label>
            <input type="number" inputmode="decimal" step="0.01" class="amount-input" id="in-${np.playerId}" placeholder="0.00">
          </div>
        </div>
      `);

      const inputEl = row.querySelector(`#in-${np.playerId}`);
      inputEl.addEventListener("input", () => updateCloseoutCheck(night));

      wrap.appendChild(row);
    });

    updateCloseoutCheck(night);
  }

  function readCloseoutRows(night) {
    return night.players.map((np) => {
      const total = buyinTotal(np);
      const raw = document.getElementById(`in-${np.playerId}`);
      const val = raw && raw.value !== "" ? round2(parseFloat(raw.value)) : null;
      let cashOut = null;
      let net = null;
      if (val !== null && !isNaN(val)) {
        cashOut = val;
        net = round2(cashOut - total);
      }
      return { playerId: np.playerId, name: np.name, total, cashOut, net };
    });
  }

  function updateCloseoutCheck(night) {
    const rows = readCloseoutRows(night);
    const checkEl = document.getElementById("closeout-check");
    const filled = rows.filter((r) => r.net !== null);
    if (filled.length < rows.length) {
      checkEl.className = "closeout-check";
      checkEl.textContent = `${filled.length} of ${rows.length} players entered`;
      return;
    }
    const sumNet = round2(rows.reduce((s, r) => s + r.net, 0));
    if (Math.abs(sumNet) < 0.005) {
      checkEl.className = "closeout-check is-balanced";
      checkEl.textContent = "Balanced \u2713 \u2014 buy-ins match cash-outs";
    } else {
      checkEl.className = "closeout-check is-off";
      checkEl.textContent = `Off by ${fmtMoney(Math.abs(sumNet))} \u2014 ${sumNet > 0 ? "more cashed out than bought in" : "less cashed out than bought in"}`;
    }
  }

  document.getElementById("btn-finish-night").addEventListener("click", async () => {
    const night = await DB.get("nights", state.currentNightId);
    const rows = readCloseoutRows(night);
    const missing = rows.filter((r) => r.net === null);
    if (missing.length) {
      toast(`Enter a result for ${missing[0].name}`);
      return;
    }
    const sumNet = round2(rows.reduce((s, r) => s + r.net, 0));
    if (Math.abs(sumNet) >= 0.005) {
      const proceed = confirm(
        `Buy-ins and cash-outs are off by ${fmtMoney(Math.abs(sumNet))}. Save anyway?`
      );
      if (!proceed) return;
    }

    night.players = night.players.map((np) => {
      const r = rows.find((x) => x.playerId === np.playerId);
      return { ...np, cashOut: r.cashOut, net: r.net };
    });
    night.status = "closed";
    night.closedAt = Date.now();
    await DB.put("nights", night);

    await autoBackup();

    showView("night-detail");
    renderNightDetail(night.id);
    updatePotStrip();
    toast("Event closed \u2014 backup saved");
  });

  // ================= PLAYERS =================
  async function computePlayerStats(playerId) {
    const nights = await DB.getAll("nights");
    const closed = nights.filter((n) => n.status === "closed");
    let nightsPlayed = 0,
      totalBuyIn = 0,
      totalCashOut = 0,
      net = 0;
    let biggestWin = null,
      biggestLoss = null;
    const history = [];

    closed.forEach((n) => {
      const np = (n.players || []).find((p) => p.playerId === playerId);
      if (!np) return;
      nightsPlayed++;
      const bi = buyinTotal(np);
      totalBuyIn += bi;
      totalCashOut += Number(np.cashOut || 0);
      net += Number(np.net || 0);
      if (np.net > 0 && (biggestWin === null || np.net > biggestWin)) biggestWin = np.net;
      if (np.net < 0 && (biggestLoss === null || np.net < biggestLoss)) biggestLoss = np.net;
      history.push({ nightId: n.id, date: n.date, net: np.net });
    });

    history.sort((a, b) => (b.date < a.date ? -1 : 1));

    return {
      nightsPlayed,
      totalBuyIn: round2(totalBuyIn),
      totalCashOut: round2(totalCashOut),
      net: round2(net),
      biggestWin: biggestWin === null ? null : round2(biggestWin),
      biggestLoss: biggestLoss === null ? null : round2(biggestLoss),
      history,
    };
  }

  async function confirmDeletePlayer(playerId) {
    if (!confirm("Remove this player from the roster? Past event results stay in history.")) return false;
    await DB.delete("players", playerId);
    return true;
  }

  async function renderPlayersList() {
    const roster = await DB.getAll("players");
    const list = document.getElementById("players-list");
    const empty = document.getElementById("players-empty");
    list.innerHTML = "";
    empty.hidden = roster.length > 0;

    const withStats = await Promise.all(
      roster.map(async (p) => ({ p, stats: await computePlayerStats(p.id) }))
    );
    withStats.sort((a, b) => a.p.name.localeCompare(b.p.name));

    withStats.forEach(({ p, stats }) => {
      const card = el(`
        <div class="card card-tappable">
          <div class="card-row">
            <div>
              <div class="card-title">${escapeHtml(p.name)}</div>
              <div class="card-sub">${stats.nightsPlayed} event${stats.nightsPlayed === 1 ? "" : "s"} played</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <div class="money ${amountClass(stats.net)}">${fmtSigned(stats.net)}</div>
              <button type="button" class="icon-btn icon-btn-sm btn-roster-delete" aria-label="Remove ${escapeHtml(p.name)} from roster">
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 7h12l-1 13.5a1.5 1.5 0 0 1-1.5 1.5h-7a1.5 1.5 0 0 1-1.5-1.5L6 7zm3-3h6l1 2H8l1-2zM4 7h16" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
              </button>
            </div>
          </div>
        </div>
      `);
      card.addEventListener("click", () => {
        state.currentPlayerId = p.id;
        showView("player-detail");
        renderPlayerDetail(p.id);
      });
      card.querySelector(".btn-roster-delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await confirmDeletePlayer(p.id);
        if (!ok) return;
        renderPlayersList();
      });
      list.appendChild(card);
    });
  }

  document.getElementById("btn-add-player").addEventListener("click", () => {
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
    const input = document.getElementById("f-pname");
    setTimeout(() => input.focus(), 50);
    document.getElementById("m-cancel").addEventListener("click", closeModal);
    document.getElementById("m-add").addEventListener("click", async () => {
      const name = input.value.trim();
      if (!name) {
        toast("Enter a name");
        return;
      }
      await DB.add("players", { name, createdAt: Date.now() });
      closeModal();
      renderPlayersList();
    });
  });

  async function renderPlayerDetail(playerId) {
    const player = await DB.get("players", playerId);
    if (!player) return;
    document.getElementById("pd-name").textContent = player.name;
    const stats = await computePlayerStats(playerId);

    const statCards = [
      ["Events played", stats.nightsPlayed, ""],
      ["Net profit/loss", fmtSigned(stats.net), amountClass(stats.net)],
      ["Total buy-in", fmtMoney(stats.totalBuyIn), ""],
      ["Total cash-out", fmtMoney(stats.totalCashOut), ""],
      ["Biggest win", stats.biggestWin === null ? "\u2014" : fmtSigned(stats.biggestWin), "amount-pos"],
      ["Biggest loss", stats.biggestLoss === null ? "\u2014" : fmtSigned(stats.biggestLoss), "amount-neg"],
    ];
    const grid = document.getElementById("pd-stats");
    grid.innerHTML = statCards
      .map(
        ([label, value, cls]) => `
      <div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value ${cls}">${value}</div>
      </div>`
      )
      .join("");

    const nightsWrap = document.getElementById("pd-nights");
    const nightsEmpty = document.getElementById("pd-nights-empty");
    nightsWrap.innerHTML = "";
    nightsEmpty.hidden = stats.history.length > 0;
    stats.history.forEach((h) => {
      const row = el(`
        <div class="card card-tappable">
          <div class="card-row">
            <div class="card-title">${fmtDate(h.date)}</div>
            <div class="money ${amountClass(h.net)}">${fmtSigned(h.net)}</div>
          </div>
        </div>
      `);
      row.addEventListener("click", () => {
        state.currentNightId = h.nightId;
        state.nightDetailReturnTo = "player-detail";
        showView("night-detail");
        renderNightDetail(h.nightId);
        updatePotStrip();
      });
      nightsWrap.appendChild(row);
    });
  }

  document.getElementById("btn-edit-player-name").addEventListener("click", async () => {
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
    const input = document.getElementById("f-pname-edit");
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
    document.getElementById("m-cancel").addEventListener("click", closeModal);
    document.getElementById("m-save").addEventListener("click", async () => {
      const newName = input.value.trim();
      if (!newName) {
        toast("Enter a name");
        return;
      }
      player.name = newName;
      await DB.put("players", player);

      const allNights = await DB.getAll("nights");
      for (const night of allNights) {
        let changed = false;
        (night.players || []).forEach((np) => {
          if (np.playerId === player.id && np.name !== newName) {
            np.name = newName;
            changed = true;
          }
        });
        if (changed) await DB.put("nights", night);
      }

      closeModal();
      renderPlayerDetail(state.currentPlayerId);
      toast("Name updated");
    });
  });

  document.getElementById("btn-delete-player").addEventListener("click", async () => {
    const ok = await confirmDeletePlayer(state.currentPlayerId);
    if (!ok) return;
    showView("players");
    renderPlayersList();
  });

  document.querySelectorAll('#view-night-detail .btn-back').forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.nightDetailReturnTo === "player-detail") {
        showView("player-detail");
        renderPlayerDetail(state.currentPlayerId);
      } else {
        showView("nights");
        renderNightsList();
      }
    });
  });

  // ================= CHIPS =================
  async function renderChipsList() {
    const chips = await DB.getAll("chips");
    chips.sort((a, b) => a.value - b.value);
    const list = document.getElementById("chips-list");
    const empty = document.getElementById("chips-empty");
    list.innerHTML = "";
    empty.hidden = chips.length > 0;

    let totalValue = 0;
    chips.forEach((c) => {
      totalValue += (Number(c.value) || 0) * (Number(c.qty) || 0);
      const row = el(`
        <div class="card card-tappable chip-row">
          <span class="chip-swatch" style="background:${escapeHtml(c.color)}"></span>
          <div class="chip-info">
            <div class="card-title">${escapeHtml(c.label)}</div>
            <div class="chip-qty">${fmtMoney(c.value)} each &middot; ${c.qty} owned</div>
          </div>
          <div class="money" style="font-weight:700;color:var(--gold-light)">${fmtMoney(c.value * c.qty)}</div>
        </div>
      `);
      row.addEventListener("click", () => openChipModal(c));
      list.appendChild(row);
    });
    document.getElementById("chips-total-value").textContent = fmtMoney(totalValue);
  }

  function openChipModal(existing) {
    const isEdit = !!existing;
    openModal(`
      <h2>${isEdit ? "Edit chip" : "Add chip"}</h2>
      <div class="field">
        <label for="f-color">Color</label>
        <input type="color" id="f-color" value="${existing ? existing.color : "#BC9D58"}">
      </div>
      <div class="field">
        <label for="f-label">Label</label>
        <input type="text" id="f-label" placeholder="e.g. Red" value="${existing ? escapeHtml(existing.label) : ""}">
      </div>
      <div class="field">
        <label for="f-value">Value (${escapeHtml(getCurrencyCode())})</label>
        <input type="number" id="f-value" step="0.01" min="0" inputmode="decimal" value="${existing ? existing.value : ""}">
      </div>
      <div class="field">
        <label for="f-qty">Quantity owned</label>
        <input type="number" id="f-qty" step="1" min="0" inputmode="numeric" value="${existing ? existing.qty : ""}">
      </div>
      <div class="modal-actions">
        ${isEdit ? `<button class="btn btn-ghost btn-danger-text" id="m-delete">Delete</button>` : `<button class="btn btn-ghost" id="m-cancel">Cancel</button>`}
        <button class="btn btn-gold" id="m-save">${isEdit ? "Save" : "Add chip"}</button>
      </div>
    `);
    if (!isEdit) document.getElementById("m-cancel").addEventListener("click", closeModal);
    if (isEdit)
      document.getElementById("m-delete").addEventListener("click", async () => {
        if (!confirm(`Delete the ${existing.label} chip?`)) return;
        await DB.delete("chips", existing.id);
        closeModal();
        renderChipsList();
      });
    document.getElementById("m-save").addEventListener("click", async () => {
      const color = document.getElementById("f-color").value;
      const label = document.getElementById("f-label").value.trim();
      const value = round2(parseFloat(document.getElementById("f-value").value));
      const qty = parseInt(document.getElementById("f-qty").value, 10);
      if (!label || isNaN(value) || isNaN(qty)) {
        toast("Fill in every field");
        return;
      }
      const obj = { color, label, value, qty };
      if (isEdit) {
        obj.id = existing.id;
        await DB.put("chips", obj);
      } else {
        await DB.add("chips", obj);
      }
      closeModal();
      renderChipsList();
    });
  }

  document.getElementById("btn-add-chip").addEventListener("click", () => openChipModal(null));

  // ================= SETTINGS / EXPORT / IMPORT =================
  document.getElementById("btn-open-settings").addEventListener("click", () => {
    state.settingsReturnTab = state.currentTab;
    document.getElementById("f-currency-symbol").value = state.currencySymbol;
    document.getElementById("f-currency-code").value = state.currencyCode;
    showView("settings");
  });

  document.getElementById("btn-save-currency").addEventListener("click", async () => {
    const sym = document.getElementById("f-currency-symbol").value.trim() || "\u20AC";
    const code = document.getElementById("f-currency-code").value.trim().toUpperCase() || "EUR";

    state.currencySymbol = sym;
    state.currencyCode = code;

    await DB.put("settings", { key: "currencySymbol", value: sym });
    await DB.put("settings", { key: "currencyCode", value: code });

    toast("Currency updated");
  });

  document.querySelector('#view-settings .btn-back').addEventListener("click", () => {
    showView(state.settingsReturnTab);
    if (state.settingsReturnTab === "nights") renderNightsList();
    if (state.settingsReturnTab === "players") renderPlayersList();
    if (state.settingsReturnTab === "chips") renderChipsList();
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
    const stamp = d.toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return `retro-poker-club-backup-${stamp}.json`;
  }

  async function autoBackup() {
    try {
      const data = await DB.exportAll();
      downloadJSON(data, backupFilename());
    } catch (e) {
      console.error("Auto-backup failed", e);
    }
  }

  document.getElementById("btn-export").addEventListener("click", async () => {
    const data = await DB.exportAll();
    downloadJSON(data, backupFilename());
    toast("Backup exported");
  });

  document.getElementById("btn-import").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });

  document.getElementById("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm("Importing will replace everything currently stored on this device. Continue?")) {
      e.target.value = "";
      return;
    }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await DB.importAll(data);
      await loadSettings();
      toast("Backup restored");
      renderNightsList();
      renderPlayersList();
      renderChipsList();
      showView("nights");
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    } finally {
      e.target.value = "";
    }
  });

  // ================= Service worker =================
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.error("SW registration failed", err));
    });
  }

  // ================= Exit confirmation =================
  history.pushState({ rpcGuard: true }, "", location.href);
  window.addEventListener("popstate", () => {
    if (confirm("Close Retro Poker Club?")) {
      history.back();
    } else {
      history.pushState({ rpcGuard: true }, "", location.href);
    }
  });
  window.addEventListener("beforeunload", (e) => {
    e.preventDefault();
    e.returnValue = "";
  });

  // ================= Init =================
  async function init() {
    await openDB();
    await loadSettings();
    showView("nights");
    renderNightsList();
  }
  init();
})();