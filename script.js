/* =========================================================
   PO AI PREDICTOR
   V8.3.5 • SMART LIVE SCANNER FRONTEND
   Backend: Twelve Data LIVE
   ========================================================= */

const API_URL = "https://po-ai-predictor-api.onrender.com";

const ANALYZE_URL = `${API_URL}/api/analyze`;
const SCANNER_URL = `${API_URL}/api/scanner`;
const HEALTH_URL = `${API_URL}/api/health`;


/* =========================================================
   DOM
   ========================================================= */

const backendStatus = document.getElementById("backendStatus");
const analyzeBtn = document.getElementById("analyzeBtn");

const errorBox = document.getElementById("errorBox");
const signalCard = document.getElementById("signalCard");

const selectedPair = document.getElementById("selectedPair");
const trendBadge = document.getElementById("trendBadge");
const signalBadge = document.getElementById("signalBadge");

const confidence = document.getElementById("confidence");
const timeframe = document.getElementById("timeframe");
const countdown = document.getElementById("countdown");

const entryTime = document.getElementById("entryTime");
const expiryTime = document.getElementById("expiryTime");
const entryPrice = document.getElementById("entryPrice");

const callScore = document.getElementById("callScore");
const putScore = document.getElementById("putScore");

const support = document.getElementById("support");
const resistance = document.getElementById("resistance");

const dataAge = document.getElementById("dataAge");

const ema9 = document.getElementById("ema9");
const ema21 = document.getElementById("ema21");
const rsi = document.getElementById("rsi");
const adx = document.getElementById("adx");

const reasons = document.getElementById("reasons");

const scanInfo = document.getElementById("scanInfo");
const scanner = document.getElementById("scanner");


/* =========================================================
   STATE
   ========================================================= */

let currentResult = null;
let countdownTimer = null;
let healthTimer = null;
let scannerTimer = null;


/* =========================================================
   HELPERS
   ========================================================= */

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function safeNumber(value, digits = 5) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return number.toFixed(digits);
}


function percentage(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return `${Math.round(number)}%`;
}


function formatTimeframe(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return `${number} MIN`;
}


/* =========================================================
   UTC TIME
   ========================================================= */

function formatUTC(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}


function formatShortUTC(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");

  return `${hours}:${minutes}:${seconds} UTC`;
}


/* =========================================================
   ERROR UI
   ========================================================= */

function showError(message) {
  if (!errorBox) {
    return;
  }

  errorBox.textContent = message || "Unable to load live market data.";
  errorBox.classList.remove("hidden");
}


function hideError() {
  if (!errorBox) {
    return;
  }

  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}


/* =========================================================
   BACKEND STATUS
   ========================================================= */

function setBackendStatus(text, state = "normal") {
  if (!backendStatus) {
    return;
  }

  backendStatus.textContent = text;

  const dot = document.querySelector(".dot");

  if (!dot) {
    return;
  }

  if (state === "online") {
    dot.style.background = "#21e38a";
  } else if (state === "error") {
    dot.style.background = "#ff5575";
  } else if (state === "loading") {
    dot.style.background = "#ffc857";
  } else {
    dot.style.background = "#ffc857";
  }
}


/* =========================================================
   LOADING
   ========================================================= */

function showLoading() {
  hideError();

  setBackendStatus("SCANNING", "loading");

  if (analyzeBtn) {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "SCANNING...";
  }

  if (selectedPair) {
    selectedPair.textContent = "Scanning live pairs...";
  }

  if (trendBadge) {
    trendBadge.textContent = "ANALYZING";
  }

  if (signalBadge) {
    signalBadge.className = "signal-badge no-trade";
    signalBadge.textContent = "SCANNING";
  }

  if (confidence) {
    confidence.textContent = "—";
  }

  if (timeframe) {
    timeframe.textContent = "—";
  }

  if (countdown) {
    countdown.textContent = "—";
  }

  if (entryTime) {
    entryTime.textContent = "—";
  }

  if (expiryTime) {
    expiryTime.textContent = "—";
  }

  if (entryPrice) {
    entryPrice.textContent = "—";
  }
}


/* =========================================================
   FINISH BUTTON
   ========================================================= */

function finishAnalyzeButton() {
  if (!analyzeBtn) {
    return;
  }

  analyzeBtn.disabled = false;
  analyzeBtn.textContent = "ANALYZE MARKET";
}


/* =========================================================
   SIGNAL BADGE
   ========================================================= */

function applySignalBadge(signal) {
  const normalized = String(signal || "NO TRADE")
    .trim()
    .toUpperCase();

  if (!signalBadge) {
    return;
  }

  signalBadge.classList.remove(
    "call",
    "put",
    "no-trade"
  );

  if (normalized === "CALL") {
    signalBadge.classList.add("call");
    signalBadge.textContent = "CALL";
    return;
  }

  if (normalized === "PUT") {
    signalBadge.classList.add("put");
    signalBadge.textContent = "PUT";
    return;
  }

  signalBadge.classList.add("no-trade");
  signalBadge.textContent = "NO TRADE";
}


/* =========================================================
   TREND
   ========================================================= */

function formatTrend(value) {
  if (!value) {
    return "—";
  }

  return String(value)
    .replace(/_/g, " ")
    .toUpperCase();
}


/* =========================================================
   REASONS
   ========================================================= */

function formatReasons(value) {
  if (!value) {
    return "No additional analysis reasons.";
  }

  if (Array.isArray(value)) {
    return value
      .filter(Boolean)
      .map(item => String(item))
      .join(" • ");
  }

  return String(value);
}


/* =========================================================
   DATA AGE
   ========================================================= */

function renderDataAge(result) {
  if (!dataAge) {
    return;
  }

  const candle = result?.lastCandle;

  if (!candle) {
    dataAge.textContent = "Last candle: —";
    return;
  }

  let candleTime = null;

  if (typeof candle === "string") {
    candleTime = candle;
  } else if (typeof candle === "object") {
    candleTime =
      candle.time ||
      candle.datetime ||
      candle.timestamp ||
      null;
  }

  if (!candleTime) {
    dataAge.textContent = "Last candle: —";
    return;
  }

  const candleDate = new Date(candleTime);

  if (Number.isNaN(candleDate.getTime())) {
    dataAge.textContent = `Last candle: ${candleTime}`;
    return;
  }

  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - candleDate.getTime()) / 1000)
  );

  dataAge.textContent =
    `Last candle: ${formatShortUTC(candleDate)} • Age ${ageSeconds}s`;
}


/* =========================================================
   RENDER SIGNAL
   ========================================================= */

function renderSignal(result) {
  if (!result) {
    throw new Error("Backend returned no selected market.");
  }

  currentResult = result;

  if (selectedPair) {
    selectedPair.textContent =
      result.pair || "Unknown pair";
  }

  if (trendBadge) {
    trendBadge.textContent =
      formatTrend(result.trend);
  }

  applySignalBadge(result.signal);

  if (confidence) {
    confidence.textContent =
      percentage(result.confidence);
  }

  if (timeframe) {
    timeframe.textContent =
      formatTimeframe(result.timeframe);
  }

  if (entryTime) {
    entryTime.textContent =
      formatUTC(result.entryTime);
  }

  if (expiryTime) {
    expiryTime.textContent =
      formatUTC(result.expiryTime);
  }

  if (entryPrice) {
    entryPrice.textContent =
      safeNumber(result.entryPrice, 5);
  }

  if (callScore) {
    callScore.textContent =
      percentage(result.callScore);
  }

  if (putScore) {
    putScore.textContent =
      percentage(result.putScore);
  }

  if (support) {
    support.textContent =
      safeNumber(result.support, 5);
  }

  if (resistance) {
    resistance.textContent =
      safeNumber(result.resistance, 5);
  }

  if (ema9) {
    ema9.textContent =
      safeNumber(result.ema9, 5);
  }

  if (ema21) {
    ema21.textContent =
      safeNumber(result.ema21, 5);
  }

  if (rsi) {
    rsi.textContent =
      safeNumber(result.rsi, 2);
  }

  if (adx) {
    adx.textContent =
      safeNumber(result.adx, 2);
  }

  if (reasons) {
    reasons.textContent =
      formatReasons(result.reasons);
  }

  renderDataAge(result);

  startCountdown();

  if (signalCard) {
    signalCard.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
}


/* =========================================================
   COUNTDOWN
   ========================================================= */

function startCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  updateCountdown();

  countdownTimer = setInterval(
    updateCountdown,
    1000
  );
}


function updateCountdown() {
  if (!countdown) {
    return;
  }

  if (!currentResult || !currentResult.entryTime) {
    countdown.textContent = "—";
    return;
  }

  const entryTimestamp =
    new Date(currentResult.entryTime).getTime();

  if (!Number.isFinite(entryTimestamp)) {
    countdown.textContent = "—";
    return;
  }

  const now = Date.now();

  const seconds =
    Math.ceil((entryTimestamp - now) / 1000);

  if (seconds <= 0) {
    countdown.textContent = "NOW";
    return;
  }

  const minutes =
    Math.floor(seconds / 60);

  const remainingSeconds =
    seconds % 60;

  if (minutes > 0) {
    countdown.textContent =
      `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
  } else {
    countdown.textContent =
      `${remainingSeconds}s`;
  }
}


/* =========================================================
   SCANNER UI
   ========================================================= */

function renderScanner(data) {
  if (!scanner) {
    return;
  }

  scanner.innerHTML = "";

  const cachedResults =
    Number(data?.cachedResults || 0);

  const totalScanned =
    Number(data?.totalScanned || 0);

  const totalFailed =
    Number(data?.totalFailed || 0);

  const scanBatchSize =
    Number(data?.scanBatchSize || 0);

  const scanCursor =
    Number(data?.scanCursor || 0);

  const lastScanAt =
    data?.lastScanAt || null;

  if (scanInfo) {
    if (lastScanAt) {
      scanInfo.textContent =
        `${totalScanned} scanned • ${cachedResults} cached • Last ${formatShortUTC(lastScanAt)}`;
    } else {
      scanInfo.textContent =
        `${totalScanned} scanned • ${cachedResults} cached`;
    }
  }

  const rows = [
    {
      title: "SCANNER",
      value:
        data?.scanRunning
          ? "RUNNING"
          : "READY",
      className:
        data?.scanRunning
          ? "scan-call"
          : "scan-wait"
    },
    {
      title: "PAIRS SCANNED",
      value:
        `${totalScanned}`,
      className:
        totalScanned > 0
          ? "scan-call"
          : "scan-wait"
    },
    {
      title: "RESULTS CACHED",
      value:
        `${cachedResults}`,
      className:
        cachedResults > 0
          ? "scan-call"
          : "scan-wait"
    },
    {
      title: "BATCH",
      value:
        scanBatchSize > 0
          ? `${scanBatchSize} pairs`
          : "—",
      className: "scan-wait"
    },
    {
      title: "FAILED",
      value:
        `${totalFailed}`,
      className:
        totalFailed > 0
          ? "scan-put"
          : "scan-wait"
    },
    {
      title: "CURSOR",
      value:
        `${scanCursor}`,
      className: "scan-wait"
    }
  ];

  rows.forEach(row => {
    const element =
      document.createElement("div");

    element.className = "scan-row";

    element.innerHTML = `
      <strong>${escapeHtml(row.title)}</strong>
      <span class="${escapeHtml(row.className)}">
        ${escapeHtml(row.value)}
      </span>
      <span></span>
    `;

    scanner.appendChild(element);
  });
}


/* =========================================================
   SCANNER REQUEST
   ========================================================= */

async function refreshScanner() {
  try {
    const response = await fetch(
      SCANNER_URL,
      {
        method: "GET",
        cache: "no-store"
      }
    );

    const data =
      await response.json();

    if (data && data.ok) {
      renderScanner(data);
    }
  } catch (error) {
    console.warn(
      "Scanner status unavailable:",
      error
    );
  }
}


/* =========================================================
   HEALTH CHECK
   ========================================================= */

async function checkHealth() {
  try {
    const response = await fetch(
      HEALTH_URL,
      {
        method: "GET",
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error(
        `Health HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (data?.ok) {
      setBackendStatus(
        "LIVE",
        "online"
      );

      if (scanInfo && !currentResult) {
        scanInfo.textContent =
          `Backend ${data.version || "V8"} • ${data.pairs || 24} pairs`;
      }

      return data;
    }

    throw new Error(
      "Backend health check failed."
    );

  } catch (error) {

    console.warn(
      "Backend health error:",
      error
    );

    setBackendStatus(
      "OFFLINE",
      "error"
    );

    return null;
  }
}


/* =========================================================
   ANALYZE MARKET
   ========================================================= */

async function analyzeMarket() {
  showLoading();

  try {

    const response =
      await fetch(
        ANALYZE_URL,
        {
          method: "GET",
          cache: "no-store",
          headers: {
            "Accept": "application/json"
          }
        }
      );

    let data = null;

    try {
      data = await response.json();
    } catch (jsonError) {
      throw new Error(
        "Backend returned an invalid JSON response."
      );
    }


    /* -----------------------------------------------------
       HTTP ERROR
       ----------------------------------------------------- */

    if (!response.ok) {

      const backendMessage =
        data?.error ||
        data?.message ||
        data?.lastScanError ||
        `Backend HTTP ${response.status}`;

      throw new Error(
        backendMessage
      );
    }


    /* -----------------------------------------------------
       BACKEND ERROR
       ----------------------------------------------------- */

    if (data?.ok === false) {

      throw new Error(
        data.error ||
        "Backend analysis failed."
      );
    }


    /* -----------------------------------------------------
       IMPORTANT:
       V8.3.4 BACKEND RETURNS:
       data.best

       Older frontend expected:
       data.selected

       We support both so the UI stays compatible.
       ----------------------------------------------------- */

    const selected =
      data?.best ||
      data?.selected ||
      data?.selectedMarket ||
      null;


    if (!selected) {

      throw new Error(
        "Backend has no fresh selected market yet. Wait for the live scanner and try again."
      );
    }


    /* -----------------------------------------------------
       RENDER ONLY ONE RESULT
       ----------------------------------------------------- */

    renderSignal(selected);


    /* -----------------------------------------------------
       BACKEND IS ONLINE
       ----------------------------------------------------- */

    setBackendStatus(
      "LIVE",
      "online"
    );


    /* -----------------------------------------------------
       SCANNER STATUS
       ----------------------------------------------------- */

    if (data?.scanner) {
      renderScanner(data.scanner);
    }

    await refreshScanner();


    /* -----------------------------------------------------
       RETURN RESULT
       ----------------------------------------------------- */

    return selected;

  } catch (error) {

    console.error(
      "Analyze error:",
      error
    );

    setBackendStatus(
      "ERROR",
      "error"
    );

    showError(
      `Unable to load live market data: ${
        error?.message ||
        "Unknown backend error."
      }`
    );

    if (signalBadge) {
      signalBadge.className =
        "signal-badge no-trade";

      signalBadge.textContent =
        "DATA ERROR";
    }

    if (selectedPair) {
      selectedPair.textContent =
        "Live market data unavailable";
    }

    if (trendBadge) {
      trendBadge.textContent =
        "ERROR";
    }

    if (confidence) {
      confidence.textContent =
        "—";
    }

    if (timeframe) {
      timeframe.textContent =
        "—";
    }

    if (countdown) {
      countdown.textContent =
        "—";
    }

    return null;

  } finally {

    finishAnalyzeButton();
  }
}


/* =========================================================
   AUTO REFRESH SCANNER STATUS
   ========================================================= */

function startScannerRefresh() {

  if (scannerTimer) {
    clearInterval(scannerTimer);
  }

  scannerTimer =
    setInterval(
      refreshScanner,
      15000
    );
}


/* =========================================================
   AUTO HEALTH CHECK
   ========================================================= */

function startHealthRefresh() {

  if (healthTimer) {
    clearInterval(healthTimer);
  }

  healthTimer =
    setInterval(
      checkHealth,
      30000
    );
}


/* =========================================================
   BUTTON EVENT
   ========================================================= */

if (analyzeBtn) {

  analyzeBtn.addEventListener(
    "click",
    analyzeMarket
  );

}


/* =========================================================
   STARTUP
   ========================================================= */

document.addEventListener(
  "DOMContentLoaded",
  async () => {

    await checkHealth();

    await refreshScanner();

    startHealthRefresh();

    startScannerRefresh();

  }
);


/* =========================================================
   PAGE VISIBILITY
   ========================================================= */

document.addEventListener(
  "visibilitychange",
  () => {

    if (!document.hidden) {

      checkHealth();
      refreshScanner();

      if (currentResult) {
        updateCountdown();
      }

    }

  }
);
