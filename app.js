(() => {
  "use strict";

  const STORAGE_KEY = "wallet-total:v1";
  const RATES_URL = "https://api.coinbase.com/v2/exchange-rates?currency=USD";
  const DEFAULT_INTERVAL_MS = 60_000;

  const el = (id) => document.getElementById(id);
  const totalEl = el("total");
  const updatedEl = el("updated");
  const nextUpdateEl = el("next-update");
  const statusDot = el("status-dot");
  const statusText = el("status-text");
  const holdingsBody = el("holdings-body");
  const addForm = el("add-form");
  const symbolInput = el("symbol-input");
  const amountInput = el("amount-input");
  const refreshBtn = el("refresh-btn");
  const pauseBtn = el("pause-btn");
  const resetBtn = el("reset-btn");
  const intervalButtons = document.querySelectorAll(".interval");

  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const pct = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const num = (n, max = 8) => new Intl.NumberFormat("en-US", { maximumFractionDigits: max }).format(n);

  /** @type {{ holdings: Array<{symbol:string, amount:number}>, intervalMs:number, paused:boolean }} */
  const state = loadState();

  let rates = null;          // USD -> { SYMBOL: rateString } (1 USD = rate SYMBOL)
  let lastUpdated = 0;
  let timerId = null;
  let nextTickAt = 0;
  let countdownId = null;
  let inFlight = false;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) throw new Error("empty");
      const parsed = JSON.parse(raw);
      return {
        holdings: Array.isArray(parsed.holdings) ? parsed.holdings : [],
        intervalMs: Number.isFinite(parsed.intervalMs) ? parsed.intervalMs : DEFAULT_INTERVAL_MS,
        paused: Boolean(parsed.paused),
      };
    } catch {
      return { holdings: [], intervalMs: DEFAULT_INTERVAL_MS, paused: false };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function setStatus(kind, text) {
    statusDot.dataset.kind = kind;
    statusText.textContent = text;
  }

  async function fetchRates() {
    if (inFlight) return;
    inFlight = true;
    setStatus("loading", "Fetching prices…");
    try {
      const res = await fetch(RATES_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json?.data?.rates) throw new Error("Malformed response");
      rates = json.data.rates;
      lastUpdated = Date.now();
      setStatus(state.paused ? "paused" : "ok", state.paused ? "Paused" : "Live");
      render();
    } catch (err) {
      setStatus("error", `Error: ${err.message}`);
    } finally {
      inFlight = false;
    }
  }

  function priceOf(symbol) {
    if (!rates) return null;
    const r = rates[symbol.toUpperCase()];
    if (!r) return null;
    const n = Number(r);
    if (!Number.isFinite(n) || n === 0) return null;
    return 1 / n; // rates are USD->X, so USD value of 1 X = 1/rate
  }

  function computeRows() {
    return state.holdings.map((h) => {
      const price = priceOf(h.symbol);
      const value = price == null ? null : price * h.amount;
      return { ...h, price, value };
    });
  }

  function render() {
    renderHoldings();
    renderTotal();
    renderTimestamp();
  }

  function renderTotal() {
    const rows = computeRows();
    const known = rows.filter((r) => r.value != null);
    const total = known.reduce((s, r) => s + r.value, 0);
    totalEl.textContent = usd.format(total);
    const missing = rows.length - known.length;
    if (missing > 0) {
      totalEl.title = `${missing} symbol(s) had no price and were excluded.`;
    } else {
      totalEl.removeAttribute("title");
    }
  }

  function renderHoldings() {
    if (state.holdings.length === 0) {
      holdingsBody.innerHTML = `<tr class="empty"><td colspan="6">No holdings yet — add one above.</td></tr>`;
      return;
    }
    const rows = computeRows();
    const totalValue = rows.reduce((s, r) => s + (r.value ?? 0), 0);
    holdingsBody.innerHTML = "";
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      const share = totalValue > 0 && r.value != null ? r.value / totalValue : 0;
      tr.innerHTML = `
        <td class="sym">${escapeHtml(r.symbol)}</td>
        <td class="num">${num(r.amount)}</td>
        <td class="num">${r.price == null ? "—" : usd.format(r.price)}</td>
        <td class="num">${r.value == null ? "—" : usd.format(r.value)}</td>
        <td class="num">${r.value == null ? "—" : pct.format(share)}</td>
        <td class="actions"><button class="link" data-remove="${i}" type="button" aria-label="Remove ${escapeHtml(r.symbol)}">Remove</button></td>
      `;
      holdingsBody.appendChild(tr);
    });
  }

  function renderTimestamp() {
    if (!lastUpdated) {
      updatedEl.textContent = "Never updated";
    } else {
      updatedEl.textContent = `Updated ${formatTime(lastUpdated)}`;
    }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function scheduleNext() {
    clearTimeout(timerId);
    clearInterval(countdownId);
    if (state.paused) {
      nextUpdateEl.textContent = "Paused";
      return;
    }
    nextTickAt = Date.now() + state.intervalMs;
    timerId = setTimeout(async () => {
      await fetchRates();
      scheduleNext();
    }, state.intervalMs);
    updateCountdown();
    countdownId = setInterval(updateCountdown, 1000);
  }

  function updateCountdown() {
    const ms = Math.max(0, nextTickAt - Date.now());
    nextUpdateEl.textContent = `next in ${formatDuration(ms)}`;
  }

  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function setInterval_(ms) {
    state.intervalMs = ms;
    saveState();
    paintIntervalButtons();
    scheduleNext();
  }

  function paintIntervalButtons() {
    intervalButtons.forEach((btn) => {
      const active = Number(btn.dataset.ms) === state.intervalMs;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function paintPauseBtn() {
    pauseBtn.textContent = state.paused ? "Resume" : "Pause";
    pauseBtn.setAttribute("aria-pressed", state.paused ? "true" : "false");
  }

  function addHolding(symbol, amount) {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const existing = state.holdings.find((h) => h.symbol === sym);
    if (existing) {
      existing.amount = amt;
    } else {
      state.holdings.push({ symbol: sym, amount: amt });
    }
    saveState();
    render();
  }

  function removeHolding(index) {
    state.holdings.splice(index, 1);
    saveState();
    render();
  }

  // Wire up events
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    addHolding(symbolInput.value, amountInput.value);
    symbolInput.value = "";
    amountInput.value = "";
    symbolInput.focus();
  });

  holdingsBody.addEventListener("click", (e) => {
    const target = e.target.closest("[data-remove]");
    if (!target) return;
    removeHolding(Number(target.dataset.remove));
  });

  intervalButtons.forEach((btn) => {
    btn.addEventListener("click", () => setInterval_(Number(btn.dataset.ms)));
  });

  refreshBtn.addEventListener("click", async () => {
    await fetchRates();
    if (!state.paused) scheduleNext();
  });

  pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    saveState();
    paintPauseBtn();
    setStatus(state.paused ? "paused" : "ok", state.paused ? "Paused" : "Live");
    scheduleNext();
  });

  resetBtn.addEventListener("click", () => {
    if (!confirm("Clear all holdings and reset settings?")) return;
    localStorage.removeItem(STORAGE_KEY);
    state.holdings = [];
    state.intervalMs = DEFAULT_INTERVAL_MS;
    state.paused = false;
    paintIntervalButtons();
    paintPauseBtn();
    render();
    scheduleNext();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !state.paused) {
      // If we slept past the next tick, fetch now and reschedule.
      if (Date.now() >= nextTickAt) {
        fetchRates().then(scheduleNext);
      }
    }
  });

  // Init
  paintIntervalButtons();
  paintPauseBtn();
  render();
  fetchRates().then(() => scheduleNext());

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => { /* ignore */ });
    });
  }
})();
