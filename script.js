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

/* ============================================================
   DOM ELEMENTS
   ============================================================ */

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
    const option =
      document.createElement("option");

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

  if (marketType.value === "otc") {
    dataStatus.textContent =
      "OTC DATA NOT CONNECTED";
  } else {
    dataStatus.textContent =
      "READY";
  }
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

  signal.textContent =
    "ANALYZING";

  signal.className =
    "signal neutral";

  confidence.textContent =
    "--";

  entryTime.textContent =
    "--";

  expiryTime.textContent =
    "--";

  countdown.textContent =
    "--";

  const selectedMarket =
    marketType.value;

  const selectedPair =
    pair.value;

  const duration =
    Number(expiry.value);

  const now =
    new Date();


  /* ==========================================================
     OTC CHECK
     ========================================================== */

  if (selectedMarket === "otc") {
    dataStatus.textContent =
      "OTC DATA NOT AVAILABLE";

    signal.textContent =
      "NO TRADE";

    signal.className =
      "signal neutral";

    confidence.textContent =
      "0%";

    entryTime.textContent =
      getTimeString(now);

    expiryTime.textContent =
      "--";

    countdown.textContent =
      "--";

    currentSignal = {
      id: Date.now(),

      market:
        "otc",

      pair:
        selectedPair,

      direction:
        "NO TRADE",

      confidence:
        0,

      entry:
        getTimeString(now),

      expiry:
        "--",

      result:
        "PENDING"
    };

    saveSignal(
      currentSignal
    );

    analyzeBtn.disabled = false;

    return;
  }


  /* ==========================================================
     CLEAN SYMBOL
     ========================================================== */

  const symbol =
    selectedPair
      .replace(
        /\s+OTC$/i,
        ""
      )
      .trim()
      .toUpperCase();


  try {

    /* ========================================================
       CALL RENDER BACKEND
       ======================================================== */

    const url =
      `${API_URL}/api/signal?symbol=${encodeURIComponent(symbol)}`;

    const response =
      await fetch(url, {
        method: "GET",

        headers: {
          Accept:
            "application/json"
        },

        cache:
          "no-store"
      });


    /* ========================================================
       PARSE JSON
       ======================================================== */

    let data;

    try {
      data =
        await response.json();

    } catch {
      throw new Error(
        "Backend returned an invalid JSON response."
      );
    }

    console.log(
      "PO AI Predictor API response:",
      data
    );


    /* ========================================================
       API ERROR
       ======================================================== */

    if (!response.ok) {
      throw new Error(
        data.message ||
        data.error ||
        data.analysis?.reason ||
        `API error: ${response.status}`
      );
    }


    /* ========================================================
       READ BACKEND DATA
       ======================================================== */

    const analysis =
      data.analysis || {};

    const backendSignal =
      data.signal ||
      analysis.signal ||
      "NO TRADE";

    let confidenceValue =
      Number(
        data.confidence ??
        analysis.confidence ??
        0
      );

    if (
      Number.isNaN(
        confidenceValue
      )
    ) {
      confidenceValue = 0;
    }


    /* ========================================================
       LIMIT CONFIDENCE
       ======================================================== */

    confidenceValue =
      Math.max(
        0,
        Math.min(
          100,
          confidenceValue
        )
      );


    /* ========================================================
       NORMALIZE SIGNAL
       ======================================================== */

    let direction =
      String(
        backendSignal
      )
        .trim()
        .toUpperCase();

    if (
      direction !== "CALL" &&
      direction !== "PUT"
    ) {
      direction =
        "NO TRADE";
    }


    /* ========================================================
       MARKET INFORMATION
       ======================================================== */

    const market =
      analysis.market || {};

    const indicators =
      analysis.indicators || {};

    const scores =
      analysis.scores || {};


    const currentPrice =
      market.currentPrice ??
      null;

    const lastUpdate =
      market.lastUpdate ??
      null;

    const ema9 =
      indicators.ema9 ??
      null;

    const ema21 =
      indicators.ema21 ??
      null;

    const rsi14 =
      indicators.rsi14 ??
      null;

    const momentum =
      indicators.momentum ??
      null;

    const momentumPercent =
      indicators.momentumPercent ??
      null;

    const bullishScore =
      scores.bullish ??
      0;

    const bearishScore =
      scores.bearish ??
      0;

    const reason =
      analysis.reason ||
      "Market conditions are not sufficiently aligned.";


    /* ========================================================
       LOG TECHNICAL DATA
       ======================================================== */

    console.log(
      "Market:",
      symbol
    );

    console.log(
      "Current price:",
      currentPrice
    );

    console.log(
      "EMA9:",
      ema9
    );

    console.log(
      "EMA21:",
      ema21
    );

    console.log(
      "RSI14:",
      rsi14
    );

    console.log(
      "Momentum:",
      momentum
    );

    console.log(
      "Momentum %:",
      momentumPercent
    );

    console.log(
      "Bullish score:",
      bullishScore
    );

    console.log(
      "Bearish score:",
      bearishScore
    );

    console.log(
      "Reason:",
      reason
    );


    /* ========================================================
       NO TRADE
       ======================================================== */

    if (
      direction === "NO TRADE" ||
      confidenceValue <= 0
    ) {

      currentSignal = {
        id:
          Date.now(),

        market:
          "live",

        pair:
          symbol,

        direction:
          "NO TRADE",

        confidence:
          0,

        entry:
          getTimeString(now),

        expiry:
          "--",

        result:
          "PENDING",

        currentPrice:
          currentPrice,

        lastUpdate:
          lastUpdate,

        ema9:
          ema9,

        ema21:
          ema21,

        rsi14:
          rsi14,

        momentum:
          momentum,

        momentumPercent:
          momentumPercent,

        bullishScore:
          bullishScore,

        bearishScore:
          bearishScore,

        reason:
          reason
      };


      dataStatus.textContent =
        "LIVE DATA CONNECTED — NO TRADE";

      showSignal(
        currentSignal
      );

      saveSignal(
        currentSignal
      );

      return;
    }


    /* ========================================================
       CREATE EXPIRY
       ======================================================== */

    const end =
      new Date(
        now.getTime() +
        duration *
          60 *
          1000
      );


    /* ========================================================
       SAVE CURRENT SIGNAL
       ======================================================== */

    currentSignal = {
      id:
        Date.now(),

      market:
        "live",

      pair:
        symbol,

      direction:
        direction,

      confidence:
        confidenceValue,

      entry:
        getTimeString(now),

      expiry:
        getTimeString(end),

      result:
        "PENDING",

      currentPrice:
        currentPrice,

      lastUpdate:
        lastUpdate,

      ema9:
        ema9,

      ema21:
        ema21,

      rsi14:
        rsi14,

      momentum:
        momentum,

      momentumPercent:
        momentumPercent,

      bullishScore:
        bullishScore,

      bearishScore:
        bearishScore,

      reason:
        reason
    };


    /* ========================================================
       DISPLAY SIGNAL
       ======================================================== */

    dataStatus.textContent =
      "LIVE DATA CONNECTED";

    showSignal(
      currentSignal
    );

    saveSignal(
      currentSignal
    );

    startCountdown(
      end
    );

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

    currentSignal =
      null;

    alert(
      "Unable to connect to the Render analysis server. Please try again."
    );

  } finally {

    analyzeBtn.disabled =
      false;
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


  if (
    item.direction ===
    "CALL"
  ) {

    signal.classList.add(
      "call"
    );

  } else if (
    item.direction ===
    "PUT"
  ) {

    signal.classList.add(
      "put"
    );

  } else {

    signal.classList.add(
      "neutral"
    );
  }


  confidence.textContent =
    `${item.confidence}%`;

  entryTime.textContent =
    item.entry;

  expiryTime.textContent =
    item.expiry;


  /* ==========================================================
     OPTIONAL CONSOLE DETAILS
     ========================================================== */

  console.log(
    "Displayed signal:",
    item.direction
  );

  console.log(
    "Confidence:",
    item.confidence + "%"
  );

  console.log(
    "Price:",
    item.currentPrice
  );

  console.log(
    "EMA9:",
    item.ema9
  );

  console.log(
    "EMA21:",
    item.ema21
  );

  console.log(
    "RSI14:",
    item.rsi14
  );

  console.log(
    "Momentum:",
    item.momentum
  );

  console.log(
    "Reason:",
    item.reason
  );
}


/* ============================================================
   COUNTDOWN
   ============================================================ */

function startCountdown(
  endTime
) {

  clearInterval(
    countdownTimer
  );


  function update() {

    const remaining =
      endTime.getTime() -
      Date.now();


    if (
      remaining <= 0
    ) {

      countdown.textContent =
        "EXPIRED";

      clearInterval(
        countdownTimer
      );

      return;
    }


    const seconds =
      Math.ceil(
        remaining /
          1000
      );


    const minutes =
      Math.floor(
        seconds /
          60
      );


    const secs =
      seconds %
      60;


    countdown.textContent =
      `${minutes}:${String(
        secs
      ).padStart(
        2,
        "0"
      )}`;
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

function saveSignal(
  item
) {

  const list =
    getHistory();


  list.unshift(
    item
  );


  localStorage.setItem(
    "po_ai_history",
    JSON.stringify(
      list.slice(
        0,
        50
      )
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


  if (
    !list.length
  ) {

    history.innerHTML =
      '<p class="empty">No signals yet.</p>';

  } else {

    history.innerHTML =
      "";


    list.forEach(
      (item) => {

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
            ${String(item.market).toUpperCase()}
            • ${item.entry}
            • ${item.confidence}%
            • <span class="pending">${item.result}</span>
          </div>
        `;


        history.appendChild(
          div
        );
      }
    );
  }


  updateStats(
    list
  );
}


/* ============================================================
   STATISTICS
   ============================================================ */

function updateStats(
  list
) {

  const completed =
    list.filter(
      (item) =>
        item.result ===
          "WIN" ||
        item.result ===
          "LOSS"
    );


  const winCount =
    list.filter(
      (item) =>
        item.result ===
        "WIN"
    ).length;


  const lossCount =
    list.filter(
      (item) =>
        item.result ===
        "LOSS"
    ).length;


  total.textContent =
    completed.length;

  wins.textContent =
    winCount;

  losses.textContent =
    lossCount;


  if (
    completed.length >
    0
  ) {

    winRate.textContent =
      Math.round(
        (
          winCount /
          completed.length
        ) *
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
