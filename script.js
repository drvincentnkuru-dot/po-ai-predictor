'use strict';

/*
============================================================
 PO AI PREDICTOR
 FRONTEND V9.0.2 FINAL
 LIVE ONLY — TWELVE DATA

 BACKEND:
 https://po-ai-predictor-api.onrender.com

 MATCHED EXACTLY TO:
 index.html V9.0

 ARCHITECTURE
 -----------------------------------------------------------
 /api/best
      ↓
 response.selectedMarket
      ↓
 renderMarket()
      ↓
 EXISTING HTML IDs
      ↓
 UI

 IMPORTANT:
 - Backend is the single source of truth
 - Frontend does NOT calculate signals
 - Frontend does NOT calculate confidence
 - Frontend does NOT choose pair
 - Frontend does NOT choose timeframe
 - Frontend does NOT create a second strategy
 - Frontend only displays selectedMarket
 - No server.js changes required
============================================================
*/


/* ==========================================================
   CONFIG
========================================================== */

const API_BASE =
  'https://po-ai-predictor-api.onrender.com';

const BEST_ENDPOINT =
  `${API_BASE}/api/best`;

const HEALTH_ENDPOINT =
  `${API_BASE}/api/health`;

const REFRESH_MS = 15000;
const FETCH_TIMEOUT_MS = 20000;


/* ==========================================================
   STATE
========================================================== */

let currentMarket = null;
let currentResponse = null;

let refreshTimer = null;
let countdownTimer = null;

let requestInProgress = false;


/* ==========================================================
   DOM HELPER
========================================================== */

function $(selector) {
  return document.querySelector(selector);
}

function setText(selector, value) {
  const element = $(selector);

  if (!element) {
    return;
  }

  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    element.textContent = '—';
  } else {
    element.textContent = String(value);
  }
}


/* ==========================================================
   SAFE NUMBER
========================================================== */

function toNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


/* ==========================================================
   NUMBER FORMAT
========================================================== */

function formatPrice(value) {
  const number = toNumber(value);

  if (number === null) {
    return '—';
  }

  if (Math.abs(number) >= 100) {
    return number.toFixed(3);
  }

  if (Math.abs(number) >= 10) {
    return number.toFixed(4);
  }

  return number.toFixed(5);
}


function formatDecimal(value, decimals = 2) {
  const number = toNumber(value);

  if (number === null) {
    return '—';
  }

  return number.toFixed(decimals);
}


function formatInteger(value) {
  const number = toNumber(value);

  if (number === null) {
    return '—';
  }

  return Math.round(number);
}


/* ==========================================================
   TIME
========================================================== */

function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}


function formatUTC(value) {
  const date = parseDate(value);

  if (!date) {
    return '—';
  }

  return (
    date.toLocaleTimeString(
      'en-GB',
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'UTC'
      }
    ) + ' UTC'
  );
}


function secondsUntil(value) {
  const date = parseDate(value);

  if (!date) {
    return null;
  }

  return Math.floor(
    (date.getTime() - Date.now()) / 1000
  );
}


function formatCountdown(seconds) {
  if (
    seconds === null ||
    seconds === undefined
  ) {
    return '—';
  }

  const safeSeconds =
    Math.max(
      0,
      Math.floor(Number(seconds))
    );

  const minutes =
    Math.floor(
      safeSeconds / 60
    );

  const remaining =
    safeSeconds % 60;

  return (
    String(minutes).padStart(2, '0') +
    ':' +
    String(remaining).padStart(2, '0')
  );
}


/* ==========================================================
   BACKEND STATUS
========================================================== */

function setBackendStatus(text) {
  const element =
    $('#backendStatus');

  if (!element) {
    return;
  }

  element.textContent = text;
}


/* ==========================================================
   ERROR BOX
========================================================== */

function showError(message) {
  const errorBox =
    $('#errorBox');

  if (!errorBox) {
    return;
  }

  errorBox.textContent =
    message || 'Unknown error';

  errorBox.classList.remove('hidden');
}


function hideError() {
  const errorBox =
    $('#errorBox');

  if (!errorBox) {
    return;
  }

  errorBox.textContent = '';

  errorBox.classList.add('hidden');
}


/* ==========================================================
   SIGNAL
========================================================== */

function renderSignal(market) {
  if (!market) {
    return;
  }

  const signal =
    String(
      market.signal || 'NO TRADE'
    ).trim().toUpperCase();

  const signalBadge =
    $('#signalBadge');

  const trendBadge =
    $('#trendBadge');

  if (signalBadge) {

    signalBadge.classList.remove(
      'call',
      'put',
      'no-trade',
      'CALL',
      'PUT',
      'NO-TRADE'
    );

    /*
     IMPORTANT:
     We do NOT calculate the signal here.

     We simply display:
     market.signal
    */

    if (signal === 'CALL') {

      signalBadge.textContent =
        'CALL';

      signalBadge.classList.add(
        'call'
      );

    } else if (signal === 'PUT') {

      signalBadge.textContent =
        'PUT';

      signalBadge.classList.add(
        'put'
      );

    } else {

      signalBadge.textContent =
        'NO TRADE';

      signalBadge.classList.add(
        'no-trade'
      );
    }
  }


  if (trendBadge) {

    trendBadge.classList.remove(
      'call',
      'put',
      'no-trade'
    );

    if (signal === 'CALL') {

      trendBadge.textContent =
        'CALL';

      trendBadge.classList.add(
        'call'
      );

    } else if (signal === 'PUT') {

      trendBadge.textContent =
        'PUT';

      trendBadge.classList.add(
        'put'
      );

    } else {

      trendBadge.textContent =
        'NO TRADE';

      trendBadge.classList.add(
        'no-trade'
      );
    }
  }
}


/* ==========================================================
   MARKET CORE
========================================================== */

function renderMarketCore(market) {
  if (!market) {
    return;
  }

  /*
   PAIR
  */

  setText(
    '#selectedPair',
    market.pair
  );


  /*
   TIMEFRAME
  */

  if (
    market.timeframe !== undefined &&
    market.timeframe !== null
  ) {

    setText(
      '#timeframe',
      `${market.timeframe} MIN`
    );

  } else {

    setText(
      '#timeframe',
      '—'
    );
  }


  /*
   CONFIDENCE
  */

  const confidence =
    toNumber(
      market.confidence
    );

  if (confidence !== null) {

    setText(
      '#confidence',
      `${Math.round(confidence)}%`
    );

  } else {

    setText(
      '#confidence',
      '—'
    );
  }


  /*
   ENTRY TIME
  */

  setText(
    '#entryTime',
    formatUTC(
      market.entryTime
    )
  );


  /*
   EXPIRY TIME
  */

  setText(
    '#expiryTime',
    formatUTC(
      market.expiryTime
    )
  );


  /*
   ENTRY PRICE

   V9 backend may not provide a separate
   entryPrice field.

   Therefore:
   - use market.entryPrice if available
   - otherwise use market.currentPrice
  */

  const entryPrice =
    market.entryPrice !== undefined &&
    market.entryPrice !== null
      ? market.entryPrice
      : market.currentPrice;

  setText(
    '#entryPrice',
    formatPrice(entryPrice)
  );


  /*
   COUNTDOWN
  */

  updateCountdown();
}


/* ==========================================================
   SCORES
========================================================== */

function renderScores(market) {
  if (!market) {
    return;
  }

  const score =
    market.score || {};


  setText(
    '#callScore',
    formatInteger(
      score.call
    )
  );


  setText(
    '#putScore',
    formatInteger(
      score.put
    )
  );


  /*
   SUPPORT
  */

  const indicators =
    market.indicators || {};

  setText(
    '#support',
    formatPrice(
      indicators.support
    )
  );


  /*
   RESISTANCE
  */

  setText(
    '#resistance',
    formatPrice(
      indicators.resistance
    )
  );
}


/* ==========================================================
   TECHNICAL INDICATORS
========================================================== */

function renderIndicators(market) {
  if (!market) {
    return;
  }

  const indicators =
    market.indicators || {};


  /*
   EMA 9
  */

  setText(
    '#ema9',
    formatPrice(
      indicators.ema9
    )
  );


  /*
   EMA 21
  */

  setText(
    '#ema21',
    formatPrice(
      indicators.ema21
    )
  );


  /*
   RSI 14

   IMPORTANT:
   HTML ID = rsi
  */

  setText(
    '#rsi',
    formatDecimal(
      indicators.rsi14,
      2
    )
  );


  /*
   ADX 14

   IMPORTANT:
   HTML ID = adx
  */

  setText(
    '#adx',
    formatDecimal(
      indicators.adx14,
      2
    )
  );


  /*
   STOCHASTIC

   IMPORTANT:
   HTML ID = stochastic
  */

  setText(
    '#stochastic',
    formatDecimal(
      indicators.stochastic14,
      2
    )
  );


  /*
   ATR

   IMPORTANT:
   HTML ID = atr
  */

  setText(
    '#atr',
    formatDecimal(
      indicators.atr14,
      6
    )
  );
}


/* ==========================================================
   MARKET PSYCHOLOGY
========================================================== */

function renderPsychology(market) {
  if (!market) {
    return;
  }

  const psychology =
    market.marketPsychology || {};

  /*
   Display backend value only.

   No frontend interpretation.
  */

  if (psychology.label) {

    setText(
      '#psychology',
      psychology.label
    );

  } else if (
    psychology.direction
  ) {

    setText(
      '#psychology',
      psychology.direction
    );

  } else {

    setText(
      '#psychology',
      '—'
    );
  }
}


/* ==========================================================
   PRICE ACTION
========================================================== */

function renderPriceAction(market) {
  if (!market) {
    return;
  }

  const priceAction =
    market.priceAction || {};

  /*
   Display backend value only.
  */

  if (priceAction.pattern) {

    setText(
      '#priceAction',
      priceAction.pattern
    );

  } else if (
    priceAction.direction
  ) {

    setText(
      '#priceAction',
      priceAction.direction
    );

  } else {

    setText(
      '#priceAction',
      '—'
    );
  }
}


/* ==========================================================
   ANALYSIS REASONS
========================================================== */

function renderReasons(market) {
  if (!market) {
    return;
  }

  const indicators =
    market.indicators || {};

  const priceAction =
    market.priceAction || {};

  const psychology =
    market.marketPsychology || {};

  const score =
    market.score || {};

  /*
   IMPORTANT:

   These are DISPLAY FACTS ONLY.

   We do NOT say:
   RSI > 50 = CALL
   EMA > EMA = CALL
   etc.

   The backend already made the final decision.
  */

  const reasons = [];


  if (
    indicators.ema9 !== undefined
  ) {
    reasons.push(
      `EMA9 ${formatPrice(indicators.ema9)}`
    );
  }


  if (
    indicators.ema21 !== undefined
  ) {
    reasons.push(
      `EMA21 ${formatPrice(indicators.ema21)}`
    );
  }


  if (
    indicators.rsi14 !== undefined
  ) {
    reasons.push(
      `RSI14 ${formatDecimal(indicators.rsi14, 2)}`
    );
  }


  if (
    indicators.adx14 !== undefined
  ) {
    reasons.push(
      `ADX14 ${formatDecimal(indicators.adx14, 2)}`
    );
  }


  if (
    indicators.stochastic14 !== undefined
  ) {
    reasons.push(
      `STOCH ${formatDecimal(indicators.stochastic14, 2)}`
    );
  }


  if (
    priceAction.pattern
  ) {
    reasons.push(
      `PATTERN ${priceAction.pattern}`
    );
  }


  if (
    psychology.label
  ) {
    reasons.push(
      `PSYCHOLOGY ${psychology.label}`
    );
  }


  if (
    score.call !== undefined &&
    score.put !== undefined
  ) {
    reasons.push(
      `CALL ${formatInteger(score.call)} / PUT ${formatInteger(score.put)}`
    );
  }


  if (
    score.gap !== undefined
  ) {
    reasons.push(
      `GAP ${formatInteger(score.gap)}`
    );
  }


  setText(
    '#reasons',
    reasons.length
      ? reasons.join(' • ')
      : '—'
  );
}


/* ==========================================================
   DATA AGE
========================================================== */

function renderDataAge(market) {
  if (!market) {
    return;
  }

  let age = null;

  if (
    market.dataAgeSeconds !== undefined
  ) {
    age =
      toNumber(
        market.dataAgeSeconds
      );
  }

  if (
    age === null &&
    market.dataAge !== undefined
  ) {
    age =
      toNumber(
        market.dataAge
      );
  }

  if (age !== null) {

    setText(
      '#dataAge',
      `${Math.round(age)} sec`
    );

  } else {

    /*
     If backend does not provide dataAge,
     do not invent one.
    */

    setText(
      '#dataAge',
      '—'
    );
  }
}


/* ==========================================================
   COUNTDOWN
========================================================== */

function updateCountdown() {
  if (!currentMarket) {
    return;
  }

  /*
   The backend provides entryTime.

   Countdown is simply the time remaining
   until that backend-selected entryTime.
  */

  const seconds =
    secondsUntil(
      currentMarket.entryTime
    );

  if (seconds === null) {

    setText(
      '#countdown',
      '—'
    );

    return;
  }


  setText(
    '#countdown',
    formatCountdown(seconds)
  );
}


/* ==========================================================
   SCANNER
========================================================== */

function renderScanner(response) {
  if (!response) {
    return;
  }

  const scanner =
    response.scanner || {};

  const metadata =
    response.metadata || {};


  /*
   LIVE PAIR SCANNER

   Keep this section simple and compatible
   with existing HTML.
  */

  const parts = [];


  if (
    response.pairs !== undefined
  ) {
    parts.push(
      `${response.pairs} pairs`
    );
  }


  if (
    response.candidateCount !== undefined
  ) {
    parts.push(
      `${response.candidateCount} setups`
    );
  }


  if (
    scanner.totalScanned !== undefined
  ) {
    parts.push(
      `${scanner.totalScanned} scanned`
    );
  }


  if (
    scanner.totalFailed !== undefined
  ) {
    parts.push(
      `${scanner.totalFailed} failed`
    );
  }


  if (
    metadata.dailyCreditsUsed !== undefined
  ) {
    parts.push(
      `${metadata.dailyCreditsUsed} credits`
    );
  }


  setText(
    '#scanInfo',
    parts.length
      ? parts.join(' • ')
      : 'LIVE'
  );


  /*
   Scanner detail
  */

  const scannerElement =
    $('#scanner');

  if (!scannerElement) {
    return;
  }


  const status =
    scanner.scanRunning === true
      ? 'SCANNING'
      : 'READY';


  const batch =
    scanner.scanBatchSize !== undefined
      ? scanner.scanBatchSize
      : '—';


  const lastScan =
    scanner.lastScanAt
      ? formatUTC(
          scanner.lastScanAt
        )
      : '—';


  scannerElement.textContent =
    `${status} • Batch ${batch} • Last scan ${lastScan}`;
}


/* ==========================================================
   COMPLETE MARKET RENDER
========================================================== */

function renderMarket(
  market,
  response = null
) {
  if (!market) {
    return;
  }

  /*
   SINGLE SOURCE OF TRUTH

   Everything comes from:
   response.selectedMarket
  */

  currentMarket =
    market;

  if (response) {
    currentResponse =
      response;
  }


  /*
   Signal
  */

  renderSignal(
    market
  );


  /*
   Core market
  */

  renderMarketCore(
    market
  );


  /*
   Scores
  */

  renderScores(
    market
  );


  /*
   Indicators
  */

  renderIndicators(
    market
  );


  /*
   Psychology
  */

  renderPsychology(
    market
  );


  /*
   Price action
  */

  renderPriceAction(
    market
  );


  /*
   Reasons
  */

  renderReasons(
    market
  );


  /*
   Data age
  */

  renderDataAge(
    market
  );


  /*
   Scanner
  */

  if (response) {
    renderScanner(
      response
    );
  }
}


/* ==========================================================
   FETCH JSON
========================================================== */

async function fetchJSON(
  url,
  timeout = FETCH_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => {
        controller.abort();
      },
      timeout
    );


  try {

    const response =
      await fetch(
        url,
        {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            'Accept':
              'application/json'
          }
        }
      );


    const text =
      await response.text();


    let data;


    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch (error) {

      throw new Error(
        `Invalid JSON response (${response.status})`
      );
    }


    if (!response.ok) {

      const message =
        data &&
        data.error
          ? data.error
          : `HTTP ${response.status}`;

      throw new Error(
        message
      );
    }


    return data;

  } finally {

    clearTimeout(
      timer
    );
  }
}


/* ==========================================================
   HEALTH CHECK
========================================================== */

async function checkBackend() {
  try {

    const data =
      await fetchJSON(
        HEALTH_ENDPOINT
      );


    if (
      data &&
      data.ok === true
    ) {

      setBackendStatus(
        'LIVE'
      );

      return data;
    }


    setBackendStatus(
      'ERROR'
    );

    return null;

  } catch (error) {

    console.error(
      '[POAI] Health check error:',
      error
    );


    /*
     Do not destroy existing market.
    */

    if (!currentMarket) {

      setBackendStatus(
        'ERROR'
      );
    }


    return null;
  }
}


/* ==========================================================
   MAIN ANALYSIS
========================================================== */

async function analyzeMarket() {

  if (requestInProgress) {
    return;
  }


  requestInProgress =
    true;


  const button =
    $('#analyzeBtn');


  if (button) {

    button.disabled =
      true;

    if (
      !button.dataset.originalText
    ) {

      button.dataset.originalText =
        button.textContent;
    }

    button.textContent =
      'ANALYZING...';
  }


  hideError();


  try {

    setBackendStatus(
      'CONNECTING'
    );


    /*
     ONE API CALL

     No pair parameter.
     No timeframe parameter.
     No second prediction engine.

     Backend chooses everything.
    */

    const data =
      await fetchJSON(
        BEST_ENDPOINT
      );


    /*
     Validate backend response.
    */

    if (
      !data ||
      data.ok !== true
    ) {

      throw new Error(
        data &&
        data.error
          ? data.error
          : 'Backend returned ok:false'
      );
    }


    /*
     Validate selectedMarket.
    */

    if (
      !data.selectedMarket ||
      typeof data.selectedMarket !== 'object'
    ) {

      throw new Error(
        'Backend response does not contain selectedMarket'
      );
    }


    /*
     Save complete response.
    */

    currentResponse =
      data;


    try {

      window.__POAI_LAST_RESPONSE =
        data;

    } catch (error) {
      /*
       Ignore debug-storage problems.
      */


    }


    /*
     THIS IS THE ONLY MARKET OBJECT
     USED BY THE FRONTEND.
    */

    const selectedMarket =
      data.selectedMarket;


    /*
     Render backend decision.
    */

    renderMarket(
      selectedMarket,
      data
    );


    /*
     Backend connected successfully.
    */

    setBackendStatus(
      'LIVE'
    );


    return data;

  } catch (error) {

    console.error(
      '[POAI] Analyze error:',
      error
    );


    /*
     Do NOT create fake signal.

     If previous valid market exists,
     keep displaying it.
    */

    if (currentMarket) {

      setBackendStatus(
        'LIVE'
      );

      showError(
        'Temporary connection issue. Showing last valid market.'
      );

      updateCountdown();

    } else {

      setBackendStatus(
        'ERROR'
      );

      showError(
        `LIVE DATA ERROR: ${error.message}`
      );
    }


    return null;

  } finally {

    requestInProgress =
      false;


    if (button) {

      button.disabled =
        false;

      button.textContent =
        button.dataset.originalText ||
        'ANALYZE MARKET';
    }
  }
}


/* ==========================================================
   AUTO REFRESH
========================================================== */

function startAutoRefresh() {

  if (refreshTimer) {

    clearInterval(
      refreshTimer
    );
  }


  refreshTimer =
    setInterval(
      () => {

        analyzeMarket();

      },
      REFRESH_MS
    );
}


/* ==========================================================
   COUNTDOWN TIMER
========================================================== */

function startCountdown() {

  if (countdownTimer) {

    clearInterval(
      countdownTimer
    );
  }


  countdownTimer =
    setInterval(
      () => {

        updateCountdown();

      },
      1000
    );
}


/* ==========================================================
   INITIAL UI
========================================================== */

function initializeUI() {

  setBackendStatus(
    'CONNECTING'
  );


  setText(
    '#selectedPair',
    'Waiting for live data…'
  );


  setText(
    '#signalBadge',
    'NO TRADE'
  );


  setText(
    '#trendBadge',
    '—'
  );


  setText(
    '#confidence',
    '—'
  );


  setText(
    '#timeframe',
    '—'
  );


  setText(
    '#countdown',
    '—'
  );


  setText(
    '#entryTime',
    '—'
  );


  setText(
    '#expiryTime',
    '—'
  );


  setText(
    '#entryPrice',
    '—'
  );
}


/* ==========================================================
   BUTTON
========================================================== */

function bindAnalyzeButton() {

  const button =
    $('#analyzeBtn');


  if (!button) {

    console.error(
      '[POAI] #analyzeBtn was not found.'
    );

    return;
  }


  button.addEventListener(
    'click',
    () => {

      analyzeMarket();

    }
  );
}


/* ==========================================================
   INIT
========================================================== */

async function init() {

  console.log(
    '[POAI] PO AI Predictor V9.0.2 FINAL'
  );

  console.log(
    '[POAI] Backend:',
    API_BASE
  );


  initializeUI();


  bindAnalyzeButton();


  startCountdown();


  /*
   FIRST LIVE ANALYSIS
  */

  await analyzeMarket();


  /*
   Health is informational.
  */

  checkBackend();


  /*
   Automatic refresh every 15 seconds.
  */

  startAutoRefresh();
}


/* ==========================================================
   PUBLIC API
========================================================== */

window.POAI = {

  version:
    'V9.0.2 FINAL',

  analyzeMarket,

  checkBackend,

  renderMarket,

  getCurrentMarket:
    () => currentMarket,

  getLastResponse:
    () => currentResponse
};


/* ==========================================================
   START
========================================================== */

if (
  document.readyState === 'loading'
) {

  document.addEventListener(
    'DOMContentLoaded',
    init
  );

} else {

  init();
}


/* ============================================================
 END OF PO AI PREDICTOR FRONTEND V9.0.2 FINAL
============================================================ */
