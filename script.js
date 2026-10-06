'use strict';

/*
============================================================
 PO AI PREDICTOR
 FRONTEND V9.0 FINAL

 ONE API CONTRACT
 -----------------------------------------------------------
 GET /api/best

 response:
 {
   ok: true,
   selectedMarket: {
      pair,
      timeframe,
      signal,
      confidence,
      currentPrice,
      entryTime,
      expiryTime,
      entryInSeconds,
      lastCandle,
      indicators,
      priceAction,
      marketPsychology,
      score,
      quality
   }
 }

 IMPORTANT:
 Frontend never invents a different response shape.
============================================================
*/

/* =========================================================
   CONFIG
========================================================= */

const API_BASE =
  'https://po-ai-predictor-api.onrender.com';

const BEST_ENDPOINT =
  `${API_BASE}/api/best`;

const HEALTH_ENDPOINT =
  `${API_BASE}/api/health`;

const REFRESH_MS =
  15000;

const REQUEST_TIMEOUT_MS =
  20000;

/* =========================================================
   STATE
========================================================= */

let currentMarket = null;
let refreshTimer = null;
let countdownTimer = null;
let requestInProgress = false;

let lastSuccessfulResponse = null;

/* =========================================================
   DOM HELPERS
========================================================= */

function byId(id) {
  return document.getElementById(id);
}

function findElement(ids) {
  for (const id of ids) {
    const el = byId(id);

    if (el) return el;
  }

  return null;
}

function setText(ids, value) {
  const el =
    Array.isArray(ids)
      ? findElement(ids)
      : byId(ids);

  if (el) {
    el.textContent =
      value === null ||
      value === undefined
        ? '—'
        : String(value);
  }
}

function setHTML(ids, value) {
  const el =
    Array.isArray(ids)
      ? findElement(ids)
      : byId(ids);

  if (el) {
    el.innerHTML =
      value === null ||
      value === undefined
        ? ''
        : String(value);
  }
}

function setClass(
  ids,
  className
) {
  const el =
    Array.isArray(ids)
      ? findElement(ids)
      : byId(ids);

  if (!el) return;

  el.classList.remove(
    'call',
    'put',
    'no-trade',
    'signal-call',
    'signal-put',
    'signal-none',
    'success',
    'error',
    'warning'
  );

  if (className) {
    el.classList.add(
      className
    );
  }
}

/* =========================================================
   OPTIONAL AUTO UI ELEMENTS
========================================================= */

function ensureStatusElements() {
  /*
  We do not replace existing HTML.
  These are only fallbacks for missing elements.
  */

  const app =
    document.body;

  if (!app) return;

  if (
    !findElement([
      'dataStatus',
      'status',
      'marketStatus'
    ])
  ) {
    const div =
      document.createElement(
        'div'
      );

    div.id =
      'dataStatus';

    div.style.marginTop =
      '12px';

    app.appendChild(div);
  }
}

/* =========================================================
   API REQUEST
========================================================= */

async function fetchJson(
  url,
  timeoutMs =
    REQUEST_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
        url,
        {
          method: 'GET',
          headers: {
            Accept:
              'application/json'
          },
          cache: 'no-store',
          signal:
            controller.signal
        }
      );

    let data;

    try {
      data =
        await response.json();
    } catch {
      throw new Error(
        'Backend returned invalid JSON'
      );
    }

    if (!response.ok) {
      throw new Error(
        data.error ||
        `Backend HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   FORMATTERS
========================================================= */

function formatNumber(
  value,
  digits = 2
) {
  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return '—';
  }

  return n.toFixed(digits);
}

function formatPrice(value) {
  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return '—';
  }

  /*
  Forex pairs can require different
  decimal presentation.
  */
  return n >= 100
    ? n.toFixed(3)
    : n.toFixed(5);
}

function formatDateTime(
  iso
) {
  if (!iso) return '—';

  const date =
    new Date(iso);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '—';
  }

  return date.toLocaleTimeString(
    [],
    {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'UTC'
    }
  ) + ' UTC';
}

function formatSeconds(
  seconds
) {
  const n =
    Math.max(
      0,
      Math.floor(
        Number(seconds) || 0
      )
    );

  const minutes =
    Math.floor(n / 60);

  const remainder =
    n % 60;

  if (minutes <= 0) {
    return `${remainder}s`;
  }

  return `${minutes}m ${String(
    remainder
  ).padStart(2, '0')}s`;
}

/* =========================================================
   STATUS
========================================================= */

function showStatus(
  message,
  type = ''
) {
  const el =
    findElement([
      'dataStatus',
      'status',
      'marketStatus',
      'connectionStatus'
    ]);

  if (!el) return;

  el.textContent =
    message;

  el.classList.remove(
    'success',
    'error',
    'warning'
  );

  if (type) {
    el.classList.add(type);
  }
}

/* =========================================================
   SIGNAL
========================================================= */

function signalClass(
  signal
) {
  if (signal === 'CALL') {
    return 'call';
  }

  if (signal === 'PUT') {
    return 'put';
  }

  return 'no-trade';
}

function signalText(
  signal
) {
  if (signal === 'CALL') {
    return 'CALL';
  }

  if (signal === 'PUT') {
    return 'PUT';
  }

  return 'NO TRADE';
}

/* =========================================================
   UPDATE SIGNAL UI
========================================================= */

function updateSignalUI(
  market
) {
  const signal =
    market?.signal ||
    'NO TRADE';

  const signalElement =
    findElement([
      'signal',
      'signalValue',
      'aiSignal',
      'tradeSignal',
      'prediction'
    ]);

  if (signalElement) {
    signalElement.textContent =
      signalText(signal);

    signalElement.classList.remove(
      'call',
      'put',
      'no-trade',
      'signal-call',
      'signal-put',
      'signal-none'
    );

    if (signal === 'CALL') {
      signalElement.classList.add(
        'call',
        'signal-call'
      );
    } else if (
      signal === 'PUT'
    ) {
      signalElement.classList.add(
        'put',
        'signal-put'
      );
    } else {
      signalElement.classList.add(
        'no-trade',
        'signal-none'
      );
    }
  }
}

/* =========================================================
   UPDATE MARKET
========================================================= */

function updateMarketUI(
  market
) {
  if (!market) {
    return;
  }

  currentMarket =
    market;

  /*
  Pair
  */
  setText(
    [
      'pair',
      'pairValue',
      'selectedPair',
      'currencyPair',
      'marketPair'
    ],
    market.pair
  );

  /*
  Timeframe
  */
  setText(
    [
      'timeframe',
      'timeframeValue',
      'selectedTimeframe',
      'expiry',
      'expiryValue'
    ],
    `${market.timeframe} min`
  );

  /*
  Price
  */
  setText(
    [
      'currentPrice',
      'price',
      'priceValue',
      'marketPrice'
    ],
    formatPrice(
      market.currentPrice
    )
  );

  /*
  Confidence
  */
  setText(
    [
      'confidence',
      'confidenceValue',
      'aiConfidence'
    ],
    `${formatNumber(
      market.confidence,
      0
    )}%`
  );

  /*
  Entry
  */
  setText(
    [
      'entryTime',
      'entry',
      'entryValue'
    ],
    formatDateTime(
      market.entryTime
    )
  );

  /*
  Expiry
  */
  setText(
    [
      'expiryTime',
      'expiryAt',
      'expiryTimeValue'
    ],
    formatDateTime(
      market.expiryTime
    )
  );

  /*
  Entry countdown
  */
  setText(
    [
      'entryIn',
      'entryInSeconds',
      'entryCountdown',
      'countdown'
    ],
    formatSeconds(
      market.entryInSeconds
    )
  );

  /*
  Last candle
  */
  setText(
    [
      'lastCandle',
      'lastCandleValue'
    ],
    formatDateTime(
      market.lastCandle
    )
  );

  updateSignalUI(
    market
  );

  updateIndicators(
    market
  );

  updatePsychology(
    market
  );

  updateQuality(
    market
  );
}

/* =========================================================
   INDICATORS
========================================================= */

function updateIndicators(
  market
) {
  const i =
    market.indicators ||
    {};

  setText(
    [
      'ema9',
      'ema9Value'
    ],
    formatPrice(
      i.ema9
    )
  );

  setText(
    [
      'ema21',
      'ema21Value'
    ],
    formatPrice(
      i.ema21
    )
  );

  setText(
    [
      'rsi',
      'rsi14',
      'rsiValue'
    ],
    formatNumber(
      i.rsi14,
      2
    )
  );

  setText(
    [
      'adx',
      'adx14',
      'adxValue'
    ],
    formatNumber(
      i.adx14,
      2
    )
  );

  setText(
    [
      'atr',
      'atr14',
      'atrValue'
    ],
    formatPrice(
      i.atr14
    )
  );

  setText(
    [
      'stochastic',
      'stochastic14',
      'stochasticValue'
    ],
    formatNumber(
      i.stochastic14,
      2
    )
  );

  setText(
    [
      'support',
      'supportValue'
    ],
    formatPrice(
      i.support
    )
  );

  setText(
    [
      'resistance',
      'resistanceValue'
    ],
    formatPrice(
      i.resistance
    )
  );

  setText(
    [
      'bbUpper',
      'bollingerUpper'
    ],
    formatPrice(
      i.bollingerUpper
    )
  );

  setText(
    [
      'bbMiddle',
      'bollingerMiddle'
    ],
    formatPrice(
      i.bollingerMiddle
    )
  );

  setText(
    [
      'bbLower',
      'bollingerLower'
    ],
    formatPrice(
      i.bollingerLower
    )
  );
}

/* =========================================================
   PSYCHOLOGY
========================================================= */

function updatePsychology(
  market
) {
  const p =
    market.marketPsychology ||
    {};

  setText(
    [
      'psychology',
      'marketPsychology',
      'psychologyValue'
    ],
    p.label || '—'
  );

  setText(
    [
      'psychologyDirection',
      'psychologySignal'
    ],
    p.direction || '—'
  );

  setText(
    [
      'psychologyScore'
    ],
    formatNumber(
      p.score,
      0
    )
  );

  const pattern =
    market.priceAction ||
    {};

  setText(
    [
      'pattern',
      'candlestickPattern',
      'priceAction'
    ],
    pattern.name || '—'
  );
}

/* =========================================================
   QUALITY
========================================================= */

function updateQuality(
  market
) {
  const q =
    market.quality ||
    {};

  setText(
    [
      'volatility',
      'volatilityValue'
    ],
    q.volatility || '—'
  );

  setText(
    [
      'scoreGap',
      'gapValue'
    ],
    formatNumber(
      market.score?.gap,
      1
    )
  );
}

/* =========================================================
   COUNTDOWN
========================================================= */

function updateCountdown() {
  if (!currentMarket) {
    return;
  }

  const entry =
    new Date(
      currentMarket.entryTime
    ).getTime();

  if (!Number.isFinite(entry)) {
    return;
  }

  const remaining =
    Math.max(
      0,
      Math.floor(
        (entry - Date.now()) /
        1000
      )
    );

  currentMarket.entryInSeconds =
    remaining;

  setText(
    [
      'entryIn',
      'entryInSeconds',
      'entryCountdown',
      'countdown'
    ],
    formatSeconds(
      remaining
    )
  );

  /*
  When entry is reached,
  show that the signal has entered.
  */
  if (
    remaining <= 0
  ) {
    showStatus(
      'ENTRY TIME REACHED',
      'success'
    );
  } else if (
    remaining <= 10
  ) {
    showStatus(
      `ENTRY IN ${remaining}s`,
      'warning'
    );
  }
}

/* =========================================================
   LOADING STATE
========================================================= */

function showLoading() {
  showStatus(
    'CONNECTING TO LIVE MARKET DATA...'
  );
}

function showSuccess(
  market
) {
  if (!market) {
    showStatus(
      'LIVE DATA CONNECTED'
    );

    return;
  }

  if (
    market.signal ===
    'NO TRADE'
  ) {
    showStatus(
      `LIVE DATA CONNECTED • NO TRADE • ${market.pair}`
    );
  } else {
    showStatus(
      `LIVE DATA CONNECTED • ${market.pair} • ${market.signal}`,
      'success'
    );
  }
}

function showError(
  message
) {
  showStatus(
    `DATA ERROR: ${message}`,
    'error'
  );
}

/* =========================================================
   MAIN ANALYSIS
========================================================= */

async function analyzeMarket(
  force = false
) {
  if (
    requestInProgress &&
    !force
  ) {
    return;
  }

  requestInProgress = true;

  showLoading();

  try {
    const data =
      await fetchJson(
        BEST_ENDPOINT
      );

    /*
    SINGLE API CONTRACT CHECK
    */
    if (
      !data ||
      data.ok !== true
    ) {
      throw new Error(
        data?.error ||
        'Backend returned unsuccessful response'
      );
    }

    if (
      !data.selectedMarket
    ) {
      throw new Error(
        'Backend returned no selected market'
      );
    }

    /*
    Validate the exact fields
    needed by the UI.
    */
    const market =
      normalizeMarket(
        data.selectedMarket
      );

    if (!market) {
      throw new Error(
        'Invalid selectedMarket response'
      );
    }

    lastSuccessfulResponse =
      data;

    updateMarketUI(
      market
    );

    showSuccess(
      market
    );
  } catch (error) {
    console.error(
      'PO AI Predictor:',
      error
    );

    /*
    Keep last valid market visible
    instead of destroying the UI.
    */
    if (
      lastSuccessfulResponse
        ?.selectedMarket
    ) {
      updateMarketUI(
        lastSuccessfulResponse
          .selectedMarket
      );

      showStatus(
        `LIVE CACHE • ${error.message}`,
        'warning'
      );
    } else {
      showError(
        error.message ||
        'Unable to load live market data'
      );
    }
  } finally {
    requestInProgress =
      false;
  }
}

/* =========================================================
   NORMALIZE API OBJECT
========================================================= */

function normalizeMarket(
  raw
) {
  if (
    !raw ||
    typeof raw !== 'object'
  ) {
    return null;
  }

  const pair =
    String(
      raw.pair || ''
    ).trim();

  const timeframe =
    Number(
      raw.timeframe
    );

  const signal =
    raw.signal === 'CALL' ||
    raw.signal === 'PUT'
      ? raw.signal
      : 'NO TRADE';

  const confidence =
    Number(
      raw.confidence
    );

  const entryTime =
    raw.entryTime;

  const expiryTime =
    raw.expiryTime;

  if (
    !pair ||
    ![1, 2, 3].includes(
      timeframe
    ) ||
    !entryTime ||
    !expiryTime
  ) {
    return null;
  }

  return {
    ...raw,

    pair,

    timeframe,

    signal,

    confidence:
      Number.isFinite(
        confidence
      )
        ? confidence
        : 0,

    entryInSeconds:
      Math.max(
        0,
        Number(
          raw.entryInSeconds
        ) || 0
      )
  };
}

/* =========================================================
   HEALTH CHECK
========================================================= */

async function checkBackend() {
  try {
    const data =
      await fetchJson(
        HEALTH_ENDPOINT,
        10000
      );

    if (
      data.ok === true
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/* =========================================================
   ANALYZE BUTTON
========================================================= */

function bindAnalyzeButton() {
  const button =
    findElement([
      'analyzeButton',
      'analyzeBtn',
      'analyzeMarket',
      'analyze'
    ]);

  if (!button) {
    return;
  }

  /*
  Prevent duplicate listeners.
  */
  if (
    button.dataset
      .poAiBound === 'true'
  ) {
    return;
  }

  button.dataset
    .poAiBound = 'true';

  button.addEventListener(
    'click',
    async () => {
      await analyzeMarket(
        true
      );
    }
  );
}

/* =========================================================
   OPTIONAL MARKET SELECT
========================================================= */

function bindMarketControls() {
  /*
  V9 intentionally uses backend-selected
  best market.

  If the old HTML contains pair/timeframe
  selects, they are left visible but do not
  create a second API contract.
  */
}

/* =========================================================
   REFRESH LOOP
========================================================= */

function startRefreshLoop() {
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

function startCountdownLoop() {
  if (countdownTimer) {
    clearInterval(
      countdownTimer
    );
  }

  countdownTimer =
    setInterval(
      updateCountdown,
      1000
    );
}

/* =========================================================
   INIT
========================================================= */

async function init() {
  ensureStatusElements();

  bindAnalyzeButton();

  bindMarketControls();

  startCountdownLoop();

  /*
  First connection.
  */
  await analyzeMarket(
    true
  );

  startRefreshLoop();
}

/* =========================================================
   PUBLIC API
========================================================= */

window.POAI =
  {
    analyzeMarket,
    checkBackend,
    getCurrentMarket:
      () => currentMarket
  };

/* =========================================================
   START AFTER DOM
========================================================= */

if (
  document.readyState ===
  'loading'
) {
  document.addEventListener(
    'DOMContentLoaded',
    init,
    {
      once: true
    }
  );
} else {
  init();
}
