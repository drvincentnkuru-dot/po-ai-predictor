'use strict';

/*
============================================================
 PO AI PREDICTOR
 Frontend V8.6.3

 MATCHES:
 backend/server.js V8.6.3

 ONLY MAIN DATA ENDPOINT:
 GET /api/best

 API CONTRACT:
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
      reason,
      marketCondition,
      indicators
   },
   markets: [],
   meta: {}
 }
============================================================
*/

/* =========================================================
   CONFIG
========================================================= */

const API_BASE =
  'https://po-ai-predictor-api.onrender.com';

const BEST_URL =
  `${API_BASE}/api/best`;

const REFRESH_MS = 30000;

/* =========================================================
   DOM HELPERS
========================================================= */

function $(selector) {
  return document.querySelector(selector);
}

function setText(selector, value) {
  const element = $(selector);

  if (element) {
    element.textContent =
      value == null ? '—' : String(value);
  }
}

function setHTML(selector, value) {
  const element = $(selector);

  if (element) {
    element.innerHTML =
      value == null ? '' : String(value);
  }
}

function setClass(selector, className) {
  const element = $(selector);

  if (element) {
    element.className = className;
  }
}

/* =========================================================
   STATE
========================================================= */

let currentMarket = null;
let refreshTimer = null;
let countdownTimer = null;
let requestRunning = false;

/* =========================================================
   INITIALIZATION
========================================================= */

document.addEventListener(
  'DOMContentLoaded',
  () => {
    bindAnalyzeButton();

    /*
     Support both possible button IDs.
    */
    bindIfExists(
      '#analyzeBtn',
      analyzeMarket
    );

    bindIfExists(
      '#analyzeButton',
      analyzeMarket
    );

    /*
     Do not automatically show an old/stale signal.
     */
    clearSignalUI();

    /*
     Start with a live request.
    */
    analyzeMarket();
  }
);

/* =========================================================
   EVENT BINDING
========================================================= */

function bindIfExists(
  selector,
  handler
) {
  const element = $(selector);

  if (!element) return;

  element.addEventListener(
    'click',
    handler
  );
}

function bindAnalyzeButton() {
  const candidates = [
    '#analyzeBtn',
    '#analyzeButton',
    '[data-action="analyze"]',
    'button'
  ];

  for (const selector of candidates) {
    const element = $(selector);

    if (!element) continue;

    if (
      element.dataset.bound === 'true'
    ) {
      continue;
    }

    const text =
      (
        element.textContent || ''
      ).toLowerCase();

    if (
      text.includes('analyze')
    ) {
      element.dataset.bound = 'true';

      element.addEventListener(
        'click',
        analyzeMarket
      );

      return;
    }
  }
}

/* =========================================================
   MAIN ACTION
========================================================= */

async function analyzeMarket() {
  if (requestRunning) {
    return;
  }

  requestRunning = true;

  showLoading();

  try {
    const response =
      await fetch(
        `${BEST_URL}?t=${Date.now()}`,
        {
          method: 'GET',
          cache: 'no-store',
          headers: {
            Accept:
              'application/json'
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `Backend HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    /*
     This is the ONE contract.
    */
    if (!data || data.ok !== true) {
      throw new Error(
        getBackendError(data)
      );
    }

    if (
      !data.selectedMarket
    ) {
      throw new Error(
        'Backend returned no selected market'
      );
    }

    validateMarket(
      data.selectedMarket
    );

    currentMarket =
      data.selectedMarket;

    renderMarket(
      currentMarket
    );

    renderMeta(
      data.meta
    );

    startRefreshLoop();
    startCountdown();

  } catch (error) {
    console.error(
      '[PO AI ERROR]',
      error
    );

    showError(
      error.message ||
      'Unable to load live market data'
    );
  } finally {
    requestRunning = false;
  }
}

/* =========================================================
   RESPONSE VALIDATION
========================================================= */

function validateMarket(market) {
  const required = [
    'pair',
    'timeframe',
    'signal',
    'confidence',
    'currentPrice',
    'entryTime',
    'expiryTime',
    'entryInSeconds'
  ];

  for (const field of required) {
    if (
      market[field] === undefined ||
      market[field] === null
    ) {
      throw new Error(
        `Invalid backend response: missing ${field}`
      );
    }
  }

  if (
    ![
      'CALL',
      'PUT',
      'NO TRADE'
    ].includes(
      market.signal
    )
  ) {
    throw new Error(
      'Invalid signal returned by backend'
    );
  }
}

function getBackendError(data) {
  if (!data) {
    return 'Backend returned empty response';
  }

  if (
    data.meta &&
    data.meta.error
  ) {
    return data.meta.error;
  }

  if (data.error) {
    return data.error;
  }

  return 'Backend returned an invalid response';
}

/* =========================================================
   RENDER MARKET
========================================================= */

function renderMarket(market) {
  const signal =
    String(
      market.signal || 'NO TRADE'
    ).toUpperCase();

  /*
   Pair
  */
  setManyText(
    [
      '#pair',
      '#selectedPair',
      '#marketPair'
    ],
    market.pair
  );

  /*
   Timeframe
  */
  setManyText(
    [
      '#timeframe',
      '#selectedTimeframe',
      '#marketTimeframe'
    ],
    `${market.timeframe} MIN`
  );

  /*
   Signal
  */
  setManyText(
    [
      '#signal',
      '#selectedSignal',
      '#marketSignal'
    ],
    signal
  );

  /*
   Confidence
  */
  setManyText(
    [
      '#confidence',
      '#selectedConfidence',
      '#marketConfidence'
    ],
    `${market.confidence}%`
  );

  /*
   Current price
  */
  setManyText(
    [
      '#currentPrice',
      '#price',
      '#marketPrice'
    ],
    formatPrice(
      market.currentPrice
    )
  );

  /*
   Entry
  */
  setManyText(
    [
      '#entryTime',
      '#entry',
      '#marketEntry'
    ],
    formatDateTime(
      market.entryTime
    )
  );

  /*
   Expiry
  */
  setManyText(
    [
      '#expiryTime',
      '#expiry',
      '#marketExpiry'
    ],
    formatDateTime(
      market.expiryTime
    )
  );

  /*
   Countdown
  */
  setManyText(
    [
      '#entryIn',
      '#entryCountdown',
      '#entrySeconds'
    ],
    formatEntrySeconds(
      market.entryInSeconds
    )
  );

  /*
   Reason
  */
  setManyText(
    [
      '#reason',
      '#signalReason',
      '#marketReason'
    ],
    market.reason ||
      'Live market analysis'
  );

  /*
   Market condition
  */
  setManyText(
    [
      '#marketCondition',
      '#condition'
    ],
    market.marketCondition ||
      '—'
  );

  /*
   Signal visual class
  */
  applySignalClass(
    signal
  );

  /*
   Indicator values if UI has them.
  */
  renderIndicators(
    market.indicators
  );
}

/* =========================================================
   SIGNAL COLOR / CLASS
========================================================= */

function applySignalClass(signal) {
  const selectors = [
    '#signal',
    '#selectedSignal',
    '#marketSignal',
    '.signal-value',
    '.signal-card'
  ];

  for (const selector of selectors) {
    const elements =
      document.querySelectorAll(
        selector
      );

    elements.forEach(element => {
      element.classList.remove(
        'call',
        'put',
        'no-trade',
        'signal-call',
        'signal-put',
        'signal-no-trade'
      );

      if (signal === 'CALL') {
        element.classList.add(
          'call',
          'signal-call'
        );
      } else if (
        signal === 'PUT'
      ) {
        element.classList.add(
          'put',
          'signal-put'
        );
      } else {
        element.classList.add(
          'no-trade',
          'signal-no-trade'
        );
      }
    });
  }
}

/* =========================================================
   INDICATORS
========================================================= */

function renderIndicators(
  indicators
) {
  if (!indicators) return;

  setManyText(
    ['#ema9', '#ema9Value'],
    formatNumber(
      indicators.ema9
    )
  );

  setManyText(
    ['#ema21', '#ema21Value'],
    formatNumber(
      indicators.ema21
    )
  );

  setManyText(
    ['#rsi14', '#rsiValue'],
    formatNumber(
      indicators.rsi14,
      2
    )
  );

  setManyText(
    ['#adx14', '#adxValue'],
    formatNumber(
      indicators.adx14,
      2
    )
  );

  setManyText(
    [
      '#stochastic14',
      '#stochasticValue'
    ],
    formatNumber(
      indicators.stochastic14,
      2
    )
  );

  setManyText(
    ['#support', '#supportValue'],
    formatNumber(
      indicators.support
    )
  );

  setManyText(
    [
      '#resistance',
      '#resistanceValue'
    ],
    formatNumber(
      indicators.resistance
    )
  );

  setManyText(
    [
      '#candlestickPattern',
      '#pattern'
    ],
    indicators.candlestickPattern ||
      'NONE'
  );

  setManyText(
    [
      '#psychology',
      '#marketPsychology'
    ],
    indicators.psychologyBehavior ||
      '—'
  );
}

/* =========================================================
   META
========================================================= */

function renderMeta(meta) {
  if (!meta) return;

  setManyText(
    [
      '#backendVersion',
      '#version'
    ],
    meta.version || 'V8.6.3'
  );

  setManyText(
    [
      '#dataSource',
      '#source'
    ],
    meta.source ||
      'Twelve Data LIVE'
  );

  setManyText(
    [
      '#scanStatus',
      '#scannerStatus'
    ],
    meta.scanRunning
      ? 'SCANNING'
      : 'LIVE'
  );
}

/* =========================================================
   COUNTDOWN
========================================================= */

function startCountdown() {
  if (countdownTimer) {
    clearInterval(
      countdownTimer
    );
  }

  updateCountdown();

  countdownTimer =
    setInterval(
      updateCountdown,
      1000
    );
}

function updateCountdown() {
  if (!currentMarket) {
    return;
  }

  const entryMs =
    new Date(
      currentMarket.entryTime
    ).getTime();

  if (!Number.isFinite(entryMs)) {
    return;
  }

  const seconds =
    Math.max(
      0,
      Math.floor(
        (entryMs - Date.now()) /
          1000
      )
    );

  currentMarket.entryInSeconds =
    seconds;

  setManyText(
    [
      '#entryIn',
      '#entryCountdown',
      '#entrySeconds'
    ],
    formatEntrySeconds(seconds)
  );

  /*
   Refresh after expiry.
  */
  const expiryMs =
    new Date(
      currentMarket.expiryTime
    ).getTime();

  if (
    Number.isFinite(expiryMs) &&
    Date.now() >= expiryMs
  ) {
    setManyText(
      [
        '#entryIn',
        '#entryCountdown',
        '#entrySeconds'
      ],
      'EXPIRED'
    );
  }
}

/* =========================================================
   AUTO REFRESH
========================================================= */

function startRefreshLoop() {
  if (refreshTimer) {
    clearTimeout(
      refreshTimer
    );
  }

  refreshTimer =
    setTimeout(
      async () => {
        await analyzeMarket();
      },
      REFRESH_MS
    );
}

/* =========================================================
   LOADING
========================================================= */

function showLoading() {
  setManyText(
    [
      '#status',
      '#systemStatus',
      '#dataStatus'
    ],
    'SCANNING LIVE MARKET...'
  );

  setManyText(
    [
      '#selectedPair',
      '#pair',
      '#marketPair'
    ],
    'Scanning...'
  );

  setManyText(
    [
      '#selectedSignal',
      '#signal',
      '#marketSignal'
    ],
    '...'
  );

  setManyText(
    [
      '#confidence',
      '#selectedConfidence'
    ],
    '—'
  );

  setManyText(
    [
      '#entryTime',
      '#entry',
      '#marketEntry'
    ],
    '—'
  );

  setManyText(
    [
      '#expiryTime',
      '#expiry',
      '#marketExpiry'
    ],
    '—'
  );

  applySignalClass(
    'NO TRADE'
  );
}

/* =========================================================
   ERROR
========================================================= */

function showError(message) {
  setManyText(
    [
      '#status',
      '#systemStatus',
      '#dataStatus'
    ],
    'DATA ERROR'
  );

  setManyText(
    [
      '#selectedSignal',
      '#signal',
      '#marketSignal'
    ],
    'NO TRADE'
  );

  setManyText(
    [
      '#reason',
      '#signalReason',
      '#marketReason'
    ],
    message
  );

  setManyText(
    [
      '#confidence',
      '#selectedConfidence'
    ],
    '—'
  );

  setManyText(
    [
      '#entryTime',
      '#entry',
      '#marketEntry'
    ],
    '—'
  );

  setManyText(
    [
      '#expiryTime',
      '#expiry',
      '#marketExpiry'
    ],
    '—'
  );

  applySignalClass(
    'NO TRADE'
  );
}

/* =========================================================
   CLEAR
========================================================= */

function clearSignalUI() {
  setManyText(
    [
      '#selectedPair',
      '#pair',
      '#marketPair'
    ],
    '—'
  );

  setManyText(
    [
      '#selectedSignal',
      '#signal',
      '#marketSignal'
    ],
    '—'
  );

  setManyText(
    [
      '#confidence',
      '#selectedConfidence'
    ],
    '—'
  );

  setManyText(
    [
      '#entryTime',
      '#entry',
      '#marketEntry'
    ],
    '—'
  );

  setManyText(
    [
      '#expiryTime',
      '#expiry',
      '#marketExpiry'
    ],
    '—'
  );
}

/* =========================================================
   DOM UTILITIES
========================================================= */

function setManyText(
  selectors,
  value
) {
  selectors.forEach(
    selector => {
      const elements =
        document.querySelectorAll(
          selector
        );

      elements.forEach(
        element => {
          element.textContent =
            value == null
              ? '—'
              : String(value);
        }
      );
    }
  );
}

/* =========================================================
   FORMATTING
========================================================= */

function formatPrice(value) {
  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return '—';
  }

  if (Math.abs(n) >= 100) {
    return n.toFixed(3);
  }

  if (Math.abs(n) >= 10) {
    return n.toFixed(4);
  }

  return n.toFixed(5);
}

function formatNumber(
  value,
  decimals = 5
) {
  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return '—';
  }

  return n.toFixed(
    decimals
  );
}

function formatDateTime(
  value
) {
  const date =
    new Date(value);

  if (
    !Number.isFinite(
      date.getTime()
    )
  ) {
    return '—';
  }

  /*
   Display in user's local browser time.
  */
  return date.toLocaleTimeString(
    [],
    {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }
  );
}

function formatEntrySeconds(
  seconds
) {
  const n =
    Number(seconds);

  if (!Number.isFinite(n)) {
    return '—';
  }

  if (n <= 0) {
    return 'NOW';
  }

  if (n < 60) {
    return `${n}s`;
  }

  const minutes =
    Math.floor(n / 60);

  const remaining =
    n % 60;

  return `${minutes}m ${remaining}s`;
}

/* =========================================================
   PUBLIC DEBUG HELPERS
========================================================= */

window.POAI = {
  analyzeMarket,
  getCurrentMarket() {
    return currentMarket;
  },
  api: BEST_URL,
  version: 'V8.6.3'
};
