const API_URL =
  window.PO_API_URL ||
  "https://po-ai-predictor-api.onrender.com";

const $ = id => document.getElementById(id);

let current = null;
let timer = null;
let busy = false;

const pairRows = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD",
  "EUR/GBP",
  "EUR/JPY",
  "GBP/JPY",
  "AUD/JPY",
  "CAD/JPY",
  "CHF/JPY",
  "EUR/AUD",
  "EUR/CAD",
  "EUR/CHF",
  "GBP/AUD",
  "GBP/CAD",
  "GBP/CHF",
  "NZD/JPY",
  "NZD/CAD",
  "AUD/CAD",
  "AUD/CHF",
  "CAD/CHF"
];

function fmtTime(iso) {
  if (!iso) return "—";

  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function countdown(iso) {
  const seconds = Math.max(
    0,
    Math.floor((new Date(iso) - Date.now()) / 1000)
  );

  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(
    secs
  ).padStart(2, "0")}`;
}

function price(value) {
  if (value == null || value === "") {
    return "—";
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return number.toFixed(
    String(value).includes(".") ? 5 : 2
  );
}

function setStatus(ok) {
  const status = $("backendStatus");
  const dot = document.querySelector(".dot");

  if (status) {
    status.textContent = ok
      ? "LIVE CONNECTED"
      : "OFFLINE";
  }

  if (dot) {
    dot.style.background = ok
      ? "#21e38a"
      : "#ff5575";
  }
}

function showError(message) {
  const box = $("errorBox");

  if (!box) return;

  box.textContent = message;
  box.classList.remove("hidden");
}

function clearError() {
  const box = $("errorBox");

  if (!box) return;

  box.classList.add("hidden");
}

function render(data) {
  const x = data.selected;

  if (!x) {
    throw new Error("No selected market returned by backend.");
  }

  current = x;

  clearError();
  setStatus(true);

  $("selectedPair").textContent =
    `${x.pair} LIVE`;

  $("trendBadge").textContent =
    x.trend || "—";

  const badge = $("signalBadge");

  badge.textContent =
    x.signal || "NO TRADE";

  badge.className =
    `signal-badge ${
      (x.signal || "NO TRADE")
        .toLowerCase()
        .replace(" ", "-")
    }`;

  $("confidence").textContent =
    `${x.confidence ?? "—"}%`;

  $("timeframe").textContent =
    `${x.timeframe ?? "—"} MIN`;

  $("countdown").textContent =
    countdown(x.entryTime);

  $("entryTime").textContent =
    fmtTime(x.entryTime);

  $("expiryTime").textContent =
    fmtTime(x.expiryTime);

  $("entryPrice").textContent =
    price(x.entryPrice);

  $("callScore").textContent =
    `${x.callScore ?? "—"}%`;

  $("putScore").textContent =
    `${x.putScore ?? "—"}%`;

  $("support").textContent =
    price(x.support);

  $("resistance").textContent =
    price(x.resistance);

  $("ema9").textContent =
    price(x.ema9);

  $("ema21").textContent =
    price(x.ema21);

  $("rsi").textContent =
    x.rsi ?? "—";

  $("adx").textContent =
    x.adx ?? "—";

  $("reasons").textContent =
    x.reasons?.join(" • ") ||
    "No extra reason";

  $("dataAge").textContent =
    `Updated ${fmtTime(x.generatedAt)}`;

  $("scanInfo").textContent =
    `${data.cachedPairs ?? 0}/${data.scannedPairs ?? 0} pairs cached`;

  const rows =
    (data.candidates || [])
      .map(candidate => {

        const signal =
          candidate.signal || "NO TRADE";

        const signalClass =
          signal === "CALL"
            ? "scan-call"
            : signal === "PUT"
              ? "scan-put"
              : "scan-wait";

        return `
          <div class="scan-row">

            <strong>
              ${candidate.pair}
              •
              ${candidate.timeframe}M
            </strong>

            <b class="${signalClass}">
              ${signal}
            </b>

            <span>
              ${candidate.confidence ?? "—"}%
            </span>

          </div>
        `;
      })
      .join("");

  $("scanner").innerHTML =
    rows ||
    "<div class='scan-row'>Waiting for more live pairs…</div>";
}

async function analyze() {

  if (busy) {
    return;
  }

  busy = true;

  const button = $("analyzeBtn");

  if (button) {
    button.disabled = true;
    button.textContent = "SCANNING…";
  }

  try {

    const response = await fetch(
      `${API_URL}/api/analyze?ts=${Date.now()}`,
      {
        cache: "no-store"
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        `HTTP ${response.status}`
      );
    }

    render(data);

  } catch (error) {

    setStatus(false);

    showError(
      error.message ||
      "Backend connection failed."
    );

  } finally {

    busy = false;

    if (button) {
      button.disabled = false;
      button.textContent = "ANALYZE MARKET";
    }
  }
}

function tick() {

  if (!current) {
    return;
  }

  $("countdown").textContent =
    countdown(current.entryTime);

  const expiry =
    new Date(current.expiryTime).getTime();

  if (
    Date.now() >
    expiry + 2000
  ) {
    analyze();
  }
}


/*
  MANUAL ANALYZE
*/

$("analyzeBtn").addEventListener(
  "click",
  analyze
);


/*
  FIRST ANALYSIS
*/

analyze();


/*
  REFRESH MARKET ANALYSIS
  EVERY 20 SECONDS
*/

setInterval(
  analyze,
  20000
);


/*
  COUNTDOWN
  EVERY 1 SECOND
*/

timer = setInterval(
  tick,
  1000
);
