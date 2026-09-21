const API_URL = "https://po-ai-predictor-api.onrender.com";

const livePairs = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD",
  "EUR/GBP",
  "EUR/JPY",
  "GBP/JPY"
];

const otcPairs = [
  "EUR/USD OTC",
  "GBP/USD OTC",
  "USD/JPY OTC",
  "USD/CHF OTC",
  "AUD/USD OTC",
  "USD/CAD OTC",
  "NZD/USD OTC",
  "EUR/GBP OTC",
  "EUR/JPY OTC",
  "GBP/JPY OTC"
];

const marketType = document.getElementById("marketType");
const pair = document.getElementById("pair");
const expiry = document.getElementById("expiry");
const analyzeBtn = document.getElementById("analyzeBtn");

const signal = document.getElementById("signal");
const confidence = document.getElementById("confidence");
const entryTime = document.getElementById("entryTime");
const expiryTime = document.getElementById("expiryTime");
const countdown = document.getElementById("countdown");

const marketLabel = document.getElementById("marketLabel");
const pairLabel = document.getElementById("pairLabel");
const dataStatus = document.getElementById("dataStatus");

const history = document.getElementById("history");
const total = document.getElementById("total");
const wins = document.getElementById("wins");
const losses = document.getElementById("losses");
const winRate = document.getElementById("winRate");

let countdownTimer = null;
let currentSignal = null;


/* ============================================================
   LOAD PAIRS
   ============================================================ */

function loadPairs() {
  const list =
    marketType.value === "otc"
      ? otcPairs
      : livePairs;

  pair.innerHTML = "";

  list.forEach((item) => {
    const option = document.createElement("option");

    option.value = item;
    option.textContent = item;

    pair.appendChild(option);
  });

  updateLabels();
}


/* ============================================================
   UPDATE LABELS
   ============================================================ */

function updateLabels() {
  marketLabel.textContent =
    marketType.value === "otc"
      ? "OTC MARKET"
      : "LIVE MARKET";

  pairLabel.textContent =
    pair.value || "--";

  dataStatus.textContent = "READY";
}


/* ============================================================
   TIME FORMAT
   ============================================================ */

function getTimeString(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}


/* ============================================================
   ANALYZE MARKET
   ============================================================ */

async function analyzeMarket() {
  clearInterval(countdownTimer);

  analyzeBtn.disabled = true;

  dataStatus.textContent =
    "CONNECTING TO LIVE DATA...";

  signal.textContent = "ANALYZING";
  signal.className = "signal neutral";

  confidence.textContent = "--";
  countdown.textContent = "--";

  const selectedMarket = marketType.value;
  const selectedPair = pair.value;
  const duration = Number(expiry.value);

  const now = new Date();

  try {
    /*
      IMPORTANT:
      Backend /api/signal uses GET.
      Therefore we must NOT send POST here.
    */

    const response = await fetch(
      `${API_URL}/api/signal`,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    console.log(
      "Render API response:",
      data
    );

    /*
      If backend says live data is unavailable,
      do not create a fake CALL/PUT signal.
    */

    if (!response.ok) {
      throw new Error(
        data.message ||
        `API error: ${response.status}`
      );
    }

    const direction =
      data.signal ||
      data.analysis?.signal ||
      "NO TRADE";

    let confidenceValue =
      Number(
        data.confidence ??
        data.analysis?.confidence ??
        0
      );

    if (Number.isNaN(confidenceValue)) {
      confidenceValue = 0;
    }

    /*
      Safety:
      If confidence is zero, force NO TRADE.
    */

    if (confidenceValue <= 0) {
      currentSignal = {
        id: Date.now(),

        market: selectedMarket,

        pair: selectedPair,

        direction: "NO TRADE",

        confidence: 0,

        entry: getTimeString(now),

        expiry: "--",

        result: "PENDING"
      };

      dataStatus.textContent =
        "LIVE DATA CONNECTED — NO TRADE";

      showSignal(currentSignal);

      saveSignal(currentSignal);

      return;
    }

    const end = new Date(
      now.getTime() +
      duration * 60 * 1000
    );

    currentSignal = {
      id: Date.now(),

      market: selectedMarket,

      pair: selectedPair,

      direction: direction,

      confidence: confidenceValue,

      entry: getTimeString(now),

      expiry: getTimeString(end),

      result: "PENDING"
    };

    dataStatus.textContent =
      "LIVE DATA CONNECTED";

    showSignal(currentSignal);

    saveSignal(currentSignal);

    startCountdown(end);

  } catch (error) {
    console.error(
      "Analysis error:",
      error
    );

    dataStatus.textContent =
      "API CONNECTION ERROR";

    signal.textContent =
      "NO TRADE";

    signal.className =
      "signal neutral";

    confidence.textContent =
      "0%";

    entryTime.textContent =
      "--";

    expiryTime.textContent =
      "--";

    countdown.textContent =
      "--";

    currentSignal = null;

    alert(
      "Unable to connect to the Render analysis server. Please try again."
    );

  } finally {
    analyzeBtn.disabled = false;
  }
}


/* ============================================================
   SHOW SIGNAL
   ============================================================ */

function showSignal(item) {
  signal.textContent =
    item.direction;

  signal.className =
    "signal";

  if (item.direction === "CALL") {
    signal.classList.add("call");

  } else if (item.direction === "PUT") {
    signal.classList.add("put");

  } else {
    signal.classList.add("neutral");
  }

  confidence.textContent =
    item.confidence + "%";

  entryTime.textContent =
    item.entry;

  expiryTime.textContent =
    item.expiry;
}


/* ============================================================
   COUNTDOWN
   ============================================================ */

function startCountdown(endTime) {
  function update() {
    const remaining =
      endTime.getTime() -
      Date.now();

    if (remaining <= 0) {
      countdown.textContent =
        "EXPIRED";

      clearInterval(
        countdownTimer
      );

      return;
    }

    const seconds =
      Math.ceil(
        remaining / 1000
      );

    const minutes =
      Math.floor(
        seconds / 60
      );

    const secs =
      seconds % 60;

    countdown.textContent =
      minutes +
      ":" +
      String(secs).padStart(
        2,
        "0"
      );
  }

  update();

  countdownTimer =
    setInterval(
      update,
      1000
    );
}


/* ============================================================
   HISTORY
   ============================================================ */

function getHistory() {
  try {
    return JSON.parse(
      localStorage.getItem(
        "po_ai_history"
      ) || "[]"
    );

  } catch {
    return [];
  }
}


/* ============================================================
   SAVE SIGNAL
   ============================================================ */

function saveSignal(item) {
  const list =
    getHistory();

  list.unshift(item);

  localStorage.setItem(
    "po_ai_history",
    JSON.stringify(
      list.slice(0, 50)
    )
  );

  renderHistory();
}


/* ============================================================
   RENDER HISTORY
   ============================================================ */

function renderHistory() {
  const list =
    getHistory();

  if (!list.length) {
    history.innerHTML =
      '<p class="empty">No signals yet.</p>';

  } else {
    history.innerHTML = "";

    list.forEach((item) => {
      const div =
        document.createElement(
          "div"
        );

      div.className =
        "history-item";

      div.innerHTML = `
        <div class="top">
          <strong>${item.pair}</strong>
          <strong>${item.direction}</strong>
        </div>

        <div class="bottom">
          ${item.market.toUpperCase()}
          • ${item.entry}
          • ${item.confidence}%
          • <span class="pending">${item.result}</span>
        </div>
      `;

      history.appendChild(div);
    });
  }

  updateStats(list);
}


/* ============================================================
   STATISTICS
   ============================================================ */

function updateStats(list) {
  const completed =
    list.filter(
      (item) =>
        item.result === "WIN" ||
        item.result === "LOSS"
    );

  const winCount =
    list.filter(
      (item) =>
        item.result === "WIN"
    ).length;

  const lossCount =
    list.filter(
      (item) =>
        item.result === "LOSS"
    ).length;

  total.textContent =
    completed.length;

  wins.textContent =
    winCount;

  losses.textContent =
    lossCount;

  if (completed.length > 0) {
    winRate.textContent =
      Math.round(
        (winCount /
          completed.length) *
          100
      ) + "%";

  } else {
    winRate.textContent =
      "0%";
  }
}


/* ============================================================
   EVENT LISTENERS
   ============================================================ */

marketType.addEventListener(
  "change",
  loadPairs
);

pair.addEventListener(
  "change",
  updateLabels
);

analyzeBtn.addEventListener(
  "click",
  analyzeMarket
);


/* ============================================================
   INITIALIZE
   ============================================================ */

loadPairs();

renderHistory();
