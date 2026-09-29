/*
=========================================================
PO AI PREDICTOR
FRONTEND V7.2
LIVE MARKET
TIMEFRAME SELECTOR
=========================================================

Backend:
https://po-ai-predictor-api.onrender.com

This frontend uses:

/api/health
/api/pairs
/api/signal?pair=EUR/USD&timeframe=1

The user selects:

1. Currency Pair
2. Timeframe

Then only ONE selected timeframe is analyzed.
=========================================================
*/


// =======================================================
// BACKEND URL
// =======================================================

const API_URL =
  "https://po-ai-predictor-api.onrender.com";


// =======================================================
// LIVE PAIRS
// =======================================================

const PAIRS = [

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


// =======================================================
// STATE
// =======================================================

let currentPair = "EUR/USD";

let currentTimeframe = "1";

let isAnalyzing = false;

let autoRefreshTimer = null;


// =======================================================
// DOM HELPER
// =======================================================

function getElement(id) {

  return document.getElementById(id);

}


// =======================================================
// PAIR SELECTOR
// =======================================================

function setupPairSelector() {

  const pairSelect = getElement("pair");

  if (!pairSelect) {

    console.error(
      "Pair selector #pair was not found."
    );

    return;

  }


  pairSelect.innerHTML = "";


  PAIRS.forEach((pair) => {

    const option =
      document.createElement("option");

    option.value = pair;

    option.textContent =
      `${pair} LIVE`;

    pairSelect.appendChild(option);

  });


  pairSelect.value = currentPair;


  pairSelect.addEventListener(
    "change",
    function () {

      currentPair = this.value;

      updateMarketLabels();

      clearResults();

      setStatus(
        "READY",
        "normal"
      );

    }
  );

}


// =======================================================
// TIMEFRAME SELECTOR
// =======================================================

function setupTimeframeSelector() {

  const timeframeSelect =
    getElement("timeframe");


  if (!timeframeSelect) {

    console.error(
      "Timeframe selector #timeframe was not found."
    );

    return;

  }


  timeframeSelect.value =
    currentTimeframe;


  timeframeSelect.addEventListener(
    "change",
    function () {

      currentTimeframe =
        this.value;


      updateMarketLabels();

      clearResults();

      setStatus(
        "READY",
        "normal"
      );

    }
  );

}


// =======================================================
// TIMEFRAME TEXT
// =======================================================

function getTimeframeText(timeframe) {

  const value =
    String(timeframe);


  if (value === "1") {

    return "1 MINUTE";

  }


  if (value === "2") {

    return "2 MINUTES";

  }


  if (value === "3") {

    return "3 MINUTES";

  }


  return `${value} MINUTES`;

}


// =======================================================
// UPDATE MARKET LABELS
// =======================================================

function updateMarketLabels() {

  const pairLabel =
    getElement("pairLabel");


  const timeframeLabel =
    getElement("timeframeLabel");


  if (pairLabel) {

    pairLabel.textContent =
      `${currentPair} LIVE`;

  }


  if (timeframeLabel) {

    timeframeLabel.textContent =
      getTimeframeText(
        currentTimeframe
      );

  }

}


// =======================================================
// STATUS
// =======================================================

function setStatus(message, type = "normal") {

  const status =
    getElement("status");


  if (!status) {

    return;

  }


  status.textContent =
    message;


  status.className =
    `status-${type}`;

}


// =======================================================
// DATA STATUS
// =======================================================

function setDataStatus(message) {

  const dataStatus =
    getElement("dataStatus");


  if (!dataStatus) {

    return;

  }


  dataStatus.textContent =
    message;

}


// =======================================================
// LOADING STATE
// =======================================================

function setLoading(isLoading) {

  const button =
    getElement("analyzeBtn");


  if (!button) {

    return;

  }


  if (isLoading) {

    button.disabled = true;

    button.textContent =
      "ANALYZING...";

  } else {

    button.disabled = false;

    button.textContent =
      "ANALYZE MARKET";

  }

}


// =======================================================
// CLEAR RESULTS
// =======================================================

function clearResults() {

  const results =
    getElement("results");


  if (!results) {

    return;

  }


  results.innerHTML = `

    <div class="empty-state">

      <h2>READY TO ANALYZE</h2>

      <p>
        Select a currency pair and timeframe,
        then press ANALYZE MARKET.
      </p>

    </div>

  `;

}


// =======================================================
// HTML ESCAPE
// =======================================================

function escapeHtml(value) {

  if (
    value === null ||
    value === undefined
  ) {

    return "";

  }


  return String(value)

    .replace(
      /&/g,
      "&amp;"
    )

    .replace(
      /</g,
      "&lt;"
    )

    .replace(
      />/g,
      "&gt;"
    )

    .replace(
      /"/g,
      "&quot;"
    )

    .replace(
      /'/g,
      "&#039;"
    );

}


// =======================================================
// NUMBER FORMAT
// =======================================================

function formatNumber(
  value,
  decimals = 5
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return "—";

  }


  const number =
    Number(value);


  if (
    !Number.isFinite(number)
  ) {

    return escapeHtml(value);

  }


  return number.toFixed(
    decimals
  );

}


// =======================================================
// PERCENT FORMAT
// =======================================================

function formatPercent(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return "—";

  }


  const number =
    Number(value);


  if (
    !Number.isFinite(number)
  ) {

    return escapeHtml(value);

  }


  return `${number}%`;

}


// =======================================================
// TIME FORMAT
// =======================================================

function formatDateTime(value) {

  if (!value) {

    return "—";

  }


  const date =
    new Date(value);


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return escapeHtml(value);

  }


  return date.toLocaleString();

}


// =======================================================
// SIGNAL CLASS
// =======================================================

function getSignalClass(signal) {

  const value =
    String(
      signal || ""
    ).toUpperCase();


  if (value === "CALL") {

    return "signal-call";

  }


  if (value === "PUT") {

    return "signal-put";

  }


  return "signal-none";

}


// =======================================================
// SIGNAL ICON
// =======================================================

function getSignalIcon(signal) {

  const value =
    String(
      signal || ""
    ).toUpperCase();


  if (value === "CALL") {

    return "▲";

  }


  if (value === "PUT") {

    return "▼";

  }


  return "—";

}


// =======================================================
// SIGNAL TITLE
// =======================================================

function getSignalTitle(signal) {

  const value =
    String(
      signal || "NO TRADE"
    ).toUpperCase();


  if (value === "CALL") {

    return "CALL";

  }


  if (value === "PUT") {

    return "PUT";

  }


  return "NO TRADE";

}


// =======================================================
// INDICATOR VALUE HELPER
// =======================================================

function indicatorValue(
  indicators,
  keys,
  decimals = 5
) {

  if (
    !indicators ||
    typeof indicators !== "object"
  ) {

    return "—";

  }


  for (
    const key of keys
  ) {

    if (
      indicators[key] !== undefined &&
      indicators[key] !== null
    ) {

      return formatNumber(
        indicators[key],
        decimals
      );

    }

  }


  return "—";

}


// =======================================================
// REASONS
// =======================================================

function renderReasons(reasons) {

  if (!Array.isArray(reasons)) {

    return "";

  }


  if (reasons.length === 0) {

    return "";

  }


  const items =
    reasons.map(
      (reason) => {

        return `
          <li>
            ${escapeHtml(reason)}
          </li>
        `;

      }
    ).join("");


  return `

    <div class="reasons">

      <h3>ANALYSIS REASONS</h3>

      <ul>
        ${items}
      </ul>

    </div>

  `;

}


// =======================================================
// INDICATORS
// =======================================================

function renderIndicators(data) {

  const indicators =
    data.indicators || {};


  const bollinger =
    indicators.bollinger ||
    indicators.bollingerBands ||
    {};


  const stochastic =
    indicators.stochastic ||
    {};


  const macd =
    indicators.macd ||
    {};


  const ema9 =
    indicators.ema9 ??
    indicators.EMA9;


  const ema21 =
    indicators.ema21 ??
    indicators.EMA21;


  const rsi =
    indicators.rsi ??
    indicators.RSI;


  const atr =
    indicators.atr ??
    indicators.ATR;


  const momentum =
    indicators.momentum;


  const macdLine =
    macd.line ??
    macd.macd ??
    indicators.macdLine;


  const macdSignal =
    macd.signal ??
    indicators.macdSignal;


  const macdHistogram =
    macd.histogram ??
    indicators.macdHistogram;


  const stochasticK =
    stochastic.k ??
    stochastic.K ??
    indicators.stochasticK;


  const stochasticD =
    stochastic.d ??
    stochastic.D ??
    indicators.stochasticD;


  const bbUpper =
    bollinger.upper ??
    indicators.bbUpper;


  const bbMiddle =
    bollinger.middle ??
    indicators.bbMiddle;


  const bbLower =
    bollinger.lower ??
    indicators.bbLower;


  return `

    <div class="indicators">

      <h3>TECHNICAL INDICATORS</h3>

      <div class="indicator-grid">

        <div class="indicator">
          <span>EMA 9</span>
          <strong>
            ${formatNumber(ema9)}
          </strong>
        </div>

        <div class="indicator">
          <span>EMA 21</span>
          <strong>
            ${formatNumber(ema21)}
          </strong>
        </div>

        <div class="indicator">
          <span>RSI 14</span>
          <strong>
            ${formatNumber(rsi, 2)}
          </strong>
        </div>

        <div class="indicator">
          <span>MACD</span>
          <strong>
            ${formatNumber(macdLine, 5)}
          </strong>
        </div>

        <div class="indicator">
          <span>MACD SIGNAL</span>
          <strong>
            ${formatNumber(macdSignal, 5)}
          </strong>
        </div>

        <div class="indicator">
          <span>MACD HISTOGRAM</span>
          <strong>
            ${formatNumber(macdHistogram, 5)}
          </strong>
        </div>

        <div class="indicator">
          <span>ATR 14</span>
          <strong>
            ${formatNumber(atr, 5)}
          </strong>
        </div>

        <div class="indicator">
          <span>STOCH K</span>
          <strong>
            ${formatNumber(stochasticK, 2)}
          </strong>
        </div>

        <div class="indicator">
          <span>STOCH D</span>
          <strong>
            ${formatNumber(stochasticD, 2)}
          </strong>
        </div>

        <div class="indicator">
          <span>BB UPPER</span>
          <strong>
            ${formatNumber(bbUpper)}
          </strong>
        </div>

        <div class="indicator">
          <span>BB MIDDLE</span>
          <strong>
            ${formatNumber(bbMiddle)}
          </strong>
        </div>

        <div class="indicator">
          <span>BB LOWER</span>
          <strong>
            ${formatNumber(bbLower)}
          </strong>
        </div>

        <div class="indicator">
          <span>MOMENTUM</span>
          <strong>
            ${formatNumber(momentum, 5)}
          </strong>
        </div>

      </div>

    </div>

  `;

}


// =======================================================
// SIGNAL CARD
// =======================================================

function renderSignalCard(data) {

  const signal =
    String(
      data.signal ||
      "NO TRADE"
    ).toUpperCase();


  const signalClass =
    getSignalClass(signal);


  const icon =
    getSignalIcon(signal);


  const title =
    getSignalTitle(signal);


  const timeframe =
    data.timeframe ||
    currentTimeframe;


  const pair =
    data.pair ||
    currentPair;


  const confidence =
    data.confidence ??
    0;


  const callScore =
    data.callScore ??
    data.call ??
    0;


  const putScore =
    data.putScore ??
    data.put ??
    0;


  const entry =
    data.entry ??
    data.price ??
    data.currentPrice;


  const expiry =
    data.expiry ??
    timeframe;


  const marketCondition =
    data.marketCondition ||
    data.condition ||
    "UNKNOWN";


  const support =
    data.support;


  const resistance =
    data.resistance;


  const lastCandle =
    data.lastCandle ||
    data.lastCandleTime;


  const candleCount =
    data.candleCount;


  return `

    <section class="signal-card">

      <!-- SIGNAL HEADER -->

      <div class="signal-header">

        <div>

          <span class="small-label">
            ${escapeHtml(pair)}
          </span>

          <h2>
            ${getTimeframeText(timeframe)}
          </h2>

        </div>

        <div class="market-condition">
          ${escapeHtml(marketCondition)}
        </div>

      </div>


      <!-- MAIN SIGNAL -->

      <div class="signal-main ${signalClass}">

        <div class="signal-icon">
          ${icon}
        </div>

        <div class="signal-title">
          ${title}
        </div>

        <div class="confidence">

          <span>
            CONFIDENCE
          </span>

          <strong>
            ${formatPercent(confidence)}
          </strong>

        </div>

      </div>


      <!-- TRADE INFORMATION -->

      <div class="trade-grid">

        <div class="trade-item">

          <span>PAIR</span>

          <strong>
            ${escapeHtml(pair)}
          </strong>

        </div>


        <div class="trade-item">

          <span>TIMEFRAME</span>

          <strong>
            ${getTimeframeText(timeframe)}
          </strong>

        </div>


        <div class="trade-item">

          <span>EXPIRY</span>

          <strong>
            ${escapeHtml(expiry)} MIN
          </strong>

        </div>


        <div class="trade-item">

          <span>ENTRY</span>

          <strong>
            ${formatNumber(entry)}
          </strong>

        </div>

      </div>


      <!-- SCORES -->

      <div class="scores">

        <div class="score-box">

          <span>CALL SCORE</span>

          <strong>
            ${formatPercent(callScore)}
          </strong>

        </div>


        <div class="score-box">

          <span>PUT SCORE</span>

          <strong>
            ${formatPercent(putScore)}
          </strong>

        </div>

      </div>


      <!-- SUPPORT / RESISTANCE -->

      <div class="levels">

        <div>

          <span>SUPPORT</span>

          <strong>
            ${formatNumber(support)}
          </strong>

        </div>


        <div>

          <span>RESISTANCE</span>

          <strong>
            ${formatNumber(resistance)}
          </strong>

        </div>

      </div>


      <!-- INDICATORS -->

      ${renderIndicators(data)}


      <!-- REASONS -->

      ${renderReasons(data.reasons)}


      <!-- CANDLE INFORMATION -->

      <div class="data-info">

        <div>

          <span>LAST CANDLE</span>

          <strong>
            ${formatDateTime(lastCandle)}
          </strong>

        </div>


        <div>

          <span>CANDLES USED</span>

          <strong>
            ${candleCount ?? "—"}
          </strong>

        </div>

      </div>


      <!-- DISCLAIMER -->

      <div class="signal-note">

        Signal is based on technical market analysis.
        It is not a guarantee of future results.

      </div>

    </section>

  `;

}


// =======================================================
// RENDER RESULT
// =======================================================

function renderResult(data) {

  const results =
    getElement("results");


  if (!results) {

    return;

  }


  results.innerHTML =
    renderSignalCard(data);

}


// =======================================================
// BACKEND HEALTH CHECK
// =======================================================

async function checkBackend() {

  try {

    setStatus(
      "CONNECTING...",
      "loading"
    );


    const response =
      await fetch(
        `${API_URL}/api/health`,
        {
          method: "GET",
          cache: "no-store"
        }
      );


    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`
      );

    }


    const data =
      await response.json();


    if (data.ok) {

      setStatus(
        "CONNECTED",
        "success"
      );


      setDataStatus(
        `${data.source || "Twelve Data LIVE"}`
      );


    } else {

      setStatus(
        "BACKEND ERROR",
        "error"
      );

    }


  } catch (error) {

    console.error(
      "Backend health error:",
      error
    );


    setStatus(
      "OFFLINE",
      "error"
    );


    setDataStatus(
      "Backend unavailable"
    );

  }

}


// =======================================================
// ANALYZE MARKET
// =======================================================

async function analyzeMarket() {

  if (isAnalyzing) {

    return;

  }


  isAnalyzing = true;


  setLoading(true);


  setStatus(
    "ANALYZING...",
    "loading"
  );


  const results =
    getElement("results");


  if (results) {

    results.innerHTML = `

      <div class="loading-state">

        <h2>
          ANALYZING MARKET...
        </h2>

        <p>
          ${escapeHtml(currentPair)}
          •
          ${getTimeframeText(currentTimeframe)}
        </p>

      </div>

    `;

  }


  try {

    /*
    =====================================================
    IMPORTANT

    We use /api/signal

    NOT /api/analyze

    because we want ONLY the selected timeframe.
    =====================================================
    */


    const url =
      `${API_URL}/api/signal` +
      `?pair=${encodeURIComponent(currentPair)}` +
      `&timeframe=${encodeURIComponent(currentTimeframe)}`;


    console.log(
      "Analyzing:",
      url
    );


    const response =
      await fetch(
        url,
        {
          method: "GET",
          cache: "no-store"
        }
      );


    const text =
      await response.text();


    let data;


    try {

      data =
        JSON.parse(text);

    } catch (jsonError) {

      throw new Error(
        `Invalid server response: ${text}`
      );

    }


    console.log(
      "Signal response:",
      data
    );


    if (!response.ok) {

      throw new Error(
        data.error ||
        `HTTP ${response.status}`
      );

    }


    if (
      data.ok === false
    ) {

      throw new Error(
        data.error ||
        "Signal analysis failed."
      );

    }


    /*
    =====================================================
    Some backend versions may return:

    {
      ok: true,
      signal: "CALL",
      ...
    }

    Others may wrap the result inside data.signal.

    This section supports both.
    =====================================================
    */


    let signalData =
      data;


    if (
      data.data &&
      typeof data.data === "object"
    ) {

      signalData =
        data.data;

    }


    if (
      data.result &&
      typeof data.result === "object"
    ) {

      signalData =
        data.result;

    }


    /*
    =====================================================
    If backend returns:

    signal: {
      signal: "CALL",
      ...
    }

    detect that too.
    =====================================================
    */


    if (
      data.signal &&
      typeof data.signal === "object"
    ) {

      signalData =
        data.signal;

    }


    if (
      !signalData ||
      typeof signalData !== "object"
    ) {

      throw new Error(
        "No signal data received from backend."
      );

    }


    renderResult(
      signalData
    );


    setStatus(
      "ANALYSIS COMPLETE",
      "success"
    );


    setDataStatus(
      "Twelve Data LIVE"
    );


  } catch (error) {

    console.error(
      "Analyze error:",
      error
    );


    if (results) {

      results.innerHTML = `

        <div class="error-state">

          <h2>
            ANALYSIS ERROR
          </h2>

          <p>
            ${escapeHtml(
              error.message ||
              "Unable to analyze market."
            )}
          </p>

          <button
            type="button"
            id="retryBtn"
          >
            TRY AGAIN
          </button>

        </div>

      `;


      const retryBtn =
        getElement("retryBtn");


      if (retryBtn) {

        retryBtn.addEventListener(
          "click",
          analyzeMarket
        );

      }

    }


    setStatus(
      "ERROR",
      "error"
    );


  } finally {

    isAnalyzing = false;

    setLoading(false);

  }

}


// =======================================================
// AUTO REFRESH
// =======================================================

function startAutoRefresh() {

  if (autoRefreshTimer) {

    clearInterval(
      autoRefreshTimer
    );

  }


  /*
  Refresh every 60 seconds.

  It keeps the SAME pair and SAME
  selected timeframe.
  */


  autoRefreshTimer =
    setInterval(
      function () {

        /*
        Only refresh if a signal
        has already been displayed.
        */


        const results =
          getElement("results");


        if (!results) {

          return;

        }


        const signalCard =
          results.querySelector(
            ".signal-card"
          );


        if (
          signalCard &&
          !isAnalyzing
        ) {

          analyzeMarket();

        }

      },
      60000
    );

}


// =======================================================
// ANALYZE BUTTON
// =======================================================

function setupAnalyzeButton() {

  const button =
    getElement("analyzeBtn");


  if (!button) {

    console.error(
      "Analyze button not found."
    );

    return;

  }


  button.addEventListener(
    "click",
    analyzeMarket
  );

}


// =======================================================
// MARKET TYPE
// =======================================================

function setupMarketType() {

  const marketType =
    getElement("marketType");


  if (!marketType) {

    return;

  }


  marketType.value =
    "live";


  marketType.addEventListener(
    "change",
    function () {

      /*
      Current backend supports
      LIVE MARKET only.
      */

      if (
        this.value !== "live"
      ) {

        this.value =
          "live";

      }


      clearResults();

    }
  );

}


// =======================================================
// INITIALIZE
// =======================================================

async function initialize() {

  console.log(
    "PO AI Predictor V7.2 starting..."
  );


  setupMarketType();

  setupPairSelector();

  setupTimeframeSelector();

  setupAnalyzeButton();

  updateMarketLabels();

  clearResults();

  await checkBackend();

  startAutoRefresh();


  /*
  Keep backend status updated
  every 60 seconds.
  */

  setInterval(
    checkBackend,
    60000
  );

}


// =======================================================
// START APP
// =======================================================

document.addEventListener(
  "DOMContentLoaded",
  initialize
);
