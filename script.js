'use strict';

/*
============================================================
 PO AI PREDICTOR
 Frontend V9.0.3

 Backend:
 https://po-ai-predictor-api.onrender.com

 IMPORTANT:
 - Backend is the SINGLE SOURCE OF TRUTH.
 - Frontend does NOT calculate CALL/PUT.
 - Frontend only displays /api/best.
 - One API response contract.
============================================================
*/

const API_BASE =
  'https://po-ai-predictor-api.onrender.com';

const BEST_ENDPOINT =
  `${API_BASE}/api/best`;

const HEALTH_ENDPOINT =
  `${API_BASE}/api/health`;

const REFRESH_INTERVAL_MS =
  15 * 1000;

const FETCH_TIMEOUT_MS =
  20 * 1000;

/* ==========================================================
   STATE
========================================================== */

let currentMarket = null;
let currentResponse = null;

let refreshTimer = null;
let countdownTimer = null;

let requestInProgress = false;

/* ==========================================================
   DOM HELPERS
========================================================== */

function $(...ids) {
  for (const id of ids) {
    const element =
      document.getElementById(id);

    if (element) {
      return element;
    }
  }

  return null;
}

function setText(
  element,
  value
) {
  if (!element) return;

  element.textContent =
    value === null ||
    value === undefined ||
    value === ''
      ? '—'
      : String(value);
}

function addClass(
  element,
  className
) {
  if (element) {
    element.classList.add(
      className
    );
  }
}

function removeClass(
  element,
  className
) {
  if (element) {
    element.classList.remove(
      className
    );
  }
}

/* ==========================================================
   FORMATTERS
========================================================== */

function numberValue(
  value,
  fallback = null
) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function formatNumber(
  value,
  digits = 2
) {
  const n =
    numberValue(value);

  if (n === null) {
    return '—';
  }

  return n.toFixed(digits);
}

function formatPrice(
  value
) {
  const n =
    numberValue(value);

  if (n === null) {
    return '—';
  }

  /*
   Forex pairs:
   JPY often needs 3 decimals.
   Most other pairs commonly use 5.
  */
  if (
    currentMarket?.pair?.includes(
      'JPY'
    )
  ) {
    return n.toFixed(3);
  }

  return n.toFixed(5);
}

function formatUTC(
  iso
) {
  if (!iso) {
    return '—';
  }

  const date =
    new Date(iso);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '—';
  }

  return (
    date.toISOString()
      .slice(11, 19) +
    ' UTC'
  );
}

function formatDateUTC(
  iso
) {
  if (!iso) {
    return '—';
  }

  const date =
    new Date(iso);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '—';
  }

  return (
    date.toISOString()
      .slice(0, 10) +
    ' ' +
    date.toISOString()
      .slice(11, 19) +
    ' UTC'
  );
}

function secondsRemaining(
  entryTime
) {
  if (!entryTime) {
    return null;
  }

  const entry =
    new Date(
      entryTime
    ).getTime();

  if (
    !Number.isFinite(entry)
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.floor(
      (entry - Date.now()) /
      1000
    )
  );
}

function formatCountdown(
  seconds
) {
  if (
    !Number.isFinite(
      seconds
    )
  ) {
    return '—';
  }

  const safe =
    Math.max(
      0,
      Math.floor(seconds)
    );

  const minutes =
    Math.floor(
      safe / 60
    );

  const secs =
    safe % 60;

  return (
    String(minutes)
      .padStart(2, '0') +
    ':' +
    String(secs)
      .padStart(2, '0')
  );
}

/* ==========================================================
   SIGNAL DISPLAY
========================================================== */

function renderSignal(
  market
) {
  const signalElement =
    $(
      'signal',
      'signalText',
      'marketSignal',
      'signalValue'
    );

  if (!signalElement) {
    return;
  }

  const signal =
    String(
      market?.signal ||
      'NO TRADE'
    ).toUpperCase();

  setText(
    signalElement,
    signal
  );

  removeClass(
    signalElement,
    'call'
  );

  removeClass(
    signalElement,
    'put'
  );

  removeClass(
    signalElement,
    'no-trade'
  );

  removeClass(
    signalElement,
    'CALL'
  );

  removeClass(
    signalElement,
    'PUT'
  );

  if (signal === 'CALL') {
    addClass(
      signalElement,
      'call'
    );

    addClass(
      signalElement,
      'CALL'
    );
  } else if (
    signal === 'PUT'
  ) {
    addClass(
      signalElement,
      'put'
    );

    addClass(
      signalElement,
      'PUT'
    );
  } else {
    addClass(
      signalElement,
      'no-trade'
    );
  }
}

/* ==========================================================
   MARKET CORE
========================================================== */

function renderMarketCore(
  market
) {
  setText(
    $(
      'selectedPair',
      'pair',
      'marketPair',
      'pairValue'
    ),
    market?.pair
  );

  setText(
    $(
      'timeframe',
      'selectedTimeframe',
      'marketTimeframe',
      'timeframeValue'
    ),
    market?.timeframe
      ? `${market.timeframe} MIN`
      : '—'
  );

  setText(
    $(
      'confidence',
      'confidenceValue',
      'marketConfidence'
    ),
    market?.confidence !== undefined
      ? `${market.confidence}%`
      : '—'
  );

  setText(
    $(
      'currentPrice',
      'price',
      'marketPrice',
      'priceValue'
    ),
    formatPrice(
      market?.currentPrice
    )
  );

  setText(
    $(
      'entryPrice',
      'entryPriceValue'
    ),
    formatPrice(
      market?.entryPrice ??
      market?.currentPrice
    )
  );

  setText(
    $(
      'entryTime',
      'entry',
      'entryTimeValue'
    ),
    formatDateUTC(
      market?.entryTime
    )
  );

  setText(
    $(
      'expiryTime',
      'expiry',
      'expiryTimeValue'
    ),
    formatDateUTC(
      market?.expiryTime
    )
  );

  setText(
    $(
      'entryInSeconds',
      'entryCountdown',
      'countdown',
      'countdownValue'
    ),
    market?.entryInSeconds !== undefined
      ? formatCountdown(
          market.entryInSeconds
        )
      : '—'
  );
}

/* ==========================================================
   SCORE DISPLAY
========================================================== */

function renderScores(
  market
) {
  setText(
    $(
      'callScore',
      'callScoreValue'
    ),
    formatNumber(
      market?.callScore,
      1
    )
  );

  setText(
    $(
      'putScore',
      'putScoreValue'
    ),
    formatNumber(
      market?.putScore,
      1
    )
  );

  setText(
    $(
      'scoreGap',
      'gap',
      'gapValue'
    ),
    formatNumber(
      market?.gap,
      1
    )
  );

  setText(
    $(
      'support',
      'supportValue'
    ),
    formatPrice(
      market?.supportResistance
        ?.support
    )
  );

  setText(
    $(
      'resistance',
      'resistanceValue'
    ),
    formatPrice(
      market?.supportResistance
        ?.resistance
    )
  );
}

/* ==========================================================
   INDICATORS
========================================================== */

function renderIndicators(
  market
) {
  const indicators =
    market?.indicators || {};

  setText(
    $(
      'ema9',
      'ema9Value'
    ),
    formatPrice(
      indicators.ema9
    )
  );

  setText(
    $(
      'ema21',
      'ema21Value'
    ),
    formatPrice(
      indicators.ema21
    )
  );

  setText(
    $(
      'rsi14',
      'rsi',
      'rsi14Value'
    ),
    formatNumber(
      indicators.rsi14,
      2
    )
  );

  setText(
    $(
      'adx14',
      'adx',
      'adx14Value'
    ),
    formatNumber(
      indicators.adx14,
      2
    )
  );

  setText(
    $(
      'stochastic14',
      'stochastic',
      'stoch',
      'stochastic14Value'
    ),
    formatNumber(
      indicators.stochastic14,
      2
    )
  );

  setText(
    $(
      'atr14',
      'atr',
      'atr14Value'
    ),
    formatPrice(
      indicators.atr14
    )
  );

  setText(
    $(
      'bbUpper',
      'bollingerUpper'
    ),
    formatPrice(
      indicators.bollinger
        ?.upper
    )
  );

  setText(
    $(
      'bbMiddle',
      'bollingerMiddle'
    ),
    formatPrice(
      indicators.bollinger
        ?.middle
    )
  );

  setText(
    $(
      'bbLower',
      'bollingerLower'
    ),
    formatPrice(
      indicators.bollinger
        ?.lower
    )
  );
}

/* ==========================================================
   PRICE ACTION
========================================================== */

function renderPriceAction(
  market
) {
  const pa =
    market?.priceAction || {};

  setText(
    $(
      'priceAction',
      'priceActionValue',
      'pattern',
      'patternValue'
    ),
    pa.pattern
  );

  setText(
    $(
      'priceActionDirection',
      'patternDirection'
    ),
    pa.direction
  );

  setText(
    $(
      'patternStrength',
      'priceActionStrength'
    ),
    pa.strength !== undefined
      ? pa.strength
      : '—'
  );
}

/* ==========================================================
   MARKET PSYCHOLOGY
========================================================== */

function renderPsychology(
  market
) {
  const psychology =
    market?.marketPsychology ||
    {};

  setText(
    $(
      'marketPsychology',
      'psychology',
      'psychologyValue'
    ),
    psychology.label
  );

  setText(
    $(
      'psychologyDirection',
      'marketPsychologyDirection'
    ),
    psychology.direction
  );
}

/* ==========================================================
   VOLATILITY
========================================================== */

function renderVolatility(
  market
) {
  setText(
    $(
      'volatility',
      'volatilityValue'
    ),
    market?.volatility
  );
}

/* ==========================================================
   DATA AGE
========================================================== */

function renderDataAge(
  market
) {
  const age =
    numberValue(
      market?.dataAgeSeconds
    );

  if (age === null) {
    setText(
      $(
        'dataAge',
        'dataAgeSeconds',
        'dataFreshness'
      ),
      '—'
    );

    return;
  }

  setText(
    $(
      'dataAge',
      'dataAgeSeconds',
      'dataFreshness'
    ),
    `${age}s`
  );
}

/* ==========================================================
   REASONS
========================================================== */

function renderReasons(
  market
) {
  const container =
    $(
      'signalReasons',
      'reasons',
      'reasonsList',
      'analysisReasons'
    );

  if (!container) {
    return;
  }

  container.innerHTML = '';

  const reasons =
    Array.isArray(
      market?.reasons
    )
      ? market.reasons
      : [];

  if (!reasons.length) {
    const item =
      document.createElement(
        'div'
      );

    item.textContent =
      'No additional reason available.';

    container.appendChild(
      item
    );

    return;
  }

  for (const reason of reasons) {
    const item =
      document.createElement(
        'div'
      );

    item.className =
      'signal-reason';

    item.textContent =
      reason;

    container.appendChild(
      item
    );
  }
}

/* ==========================================================
   SCANNER
========================================================== */

function renderScanner(
  response
) {
  const scanner =
    response?.scanner || {};

  const metadata =
    response?.metadata || {};

  setText(
    $(
      'cachedPairs',
      'scannerCachedPairs'
    ),
    scanner.cachedPairs
  );

  setText(
    $(
      'candidateCount',
      'scannerCandidates'
    ),
    scanner.candidateCount
  );

  setText(
    $(
      'totalScanned',
      'scannerTotalScanned'
    ),
    scanner.totalScanned
  );

  setText(
    $(
      'totalFailed',
      'scannerTotalFailed'
    ),
    scanner.totalFailed
  );

  setText(
    $(
      'totalApiRequests',
      'scannerApiRequests'
    ),
    scanner.totalApiRequests
  );

  setText(
    $(
      'dailyCreditsUsed',
      'creditsUsed'
    ),
    metadata.dailyCreditsUsed
  );

  setText(
    $(
      'dailyCreditsRemaining',
      'creditsRemaining'
    ),
    metadata.dailyCreditsRemaining
  );

  setText(
    $(
      'providerRequestsThisMinute',
      'minuteRequests'
    ),
    metadata.providerRequestsThisMinute
  );

  setText(
    $(
      'scannerStatus',
      'scanStatus'
    ),
    scanner.scanRunning
      ? 'SCANNING'
      : 'READY'
  );

  setText(
    $(
      'lastScanAt',
      'scannerLastScan'
    ),
    formatDateUTC(
      scanner.lastScanAt
    )
  );

  setText(
    $(
      'lastScanError',
      'scannerError'
    ),
    scanner.lastScanError ||
      'NONE'
  );
}

/* ==========================================================
   MAIN RENDER
========================================================== */

function renderMarket(
  market,
  response = null
) {
  if (!market) {
    return;
  }

  currentMarket =
    market;

  if (response) {
    currentResponse =
      response;
  }

  renderSignal(
    market
  );

  renderMarketCore(
    market
  );

  renderScores(
    market
  );

  renderIndicators(
    market
  );

  renderPriceAction(
    market
  );

  renderPsychology(
    market
  );

  renderVolatility(
    market
  );

  renderDataAge(
    market
  );

  renderReasons(
    market
  );

  if (response) {
    renderScanner(
      response
    );
  }

  updateCountdown();
}

/* ==========================================================
   COUNTDOWN
========================================================== */

function updateCountdown() {
  if (!currentMarket) {
    return;
  }

  const seconds =
    secondsRemaining(
      currentMarket.entryTime
    );

  const countdownText =
    formatCountdown(
      seconds
    );

  setText(
    $(
      'entryInSeconds',
      'entryCountdown',
      'countdown',
      'countdownValue'
    ),
    countdownText
  );

  /*
   Keep the frontend display synchronized with
   backend entryTime. It does NOT create a new signal.
  */
}

/* ==========================================================
   FETCH WITH TIMEOUT
========================================================== */

async function fetchJSON(
  url
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      FETCH_TIMEOUT_MS
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

          cache:
            'no-store',

          signal:
            controller.signal
        }
      );

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON response (${response.status})`
      );
    }

    if (!response.ok) {
      throw new Error(
        data?.error ||
        `HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(
      timeout
    );
  }
}

/* ==========================================================
   STATUS
========================================================== */

function setConnectionStatus(
  text
) {
  setText(
    $(
      'status',
      'connectionStatus',
      'liveStatus',
      'backendStatus'
    ),
    text
  );
}

/* ==========================================================
   BACKEND HEALTH
========================================================== */

async function checkBackend() {
  try {
    const data =
      await fetchJSON(
        HEALTH_ENDPOINT
      );

    if (
      data?.ok
    ) {
      setConnectionStatus(
        'LIVE DATA CONNECTED'
      );

      return data;
    }

    throw new Error(
      data?.error ||
      'Backend health check failed'
    );
  } catch (error) {
    setConnectionStatus(
      'LIVE DATA CONNECTION ISSUE'
    );

    return null;
  }
}

/* ==========================================================
   ANALYZE MARKET
========================================================== */

async function analyzeMarket(
  options = {}
) {
  if (
    requestInProgress &&
    !options.force
  ) {
    return;
  }

  requestInProgress =
    true;

  setConnectionStatus(
    'ANALYZING LIVE MARKET...'
  );

  try {
    /*
     IMPORTANT:
     Only ONE endpoint determines the signal.
    */
    const data =
      await fetchJSON(
        `${BEST_ENDPOINT}?_=${Date.now()}`
      );

    /*
     Store the complete backend response.
    */
    currentResponse =
      data;

    window.__POAI_LAST_RESPONSE =
      data;

    /*
     Backend is the single source of truth.
    */
    if (
      data?.ok !== true
    ) {
      throw new Error(
        data?.error ||
        'Backend returned ok=false'
      );
    }

    if (
      !data.selectedMarket ||
      typeof data.selectedMarket !==
        'object'
    ) {
      /*
       Keep the previous valid market instead of
       destroying the UI.
      */
      if (
        currentMarket
      ) {
        setConnectionStatus(
          'LIVE DATA WAITING FOR FRESH SIGNAL'
        );

        renderScanner(
          data
        );

        return data;
      }

      throw new Error(
        data.error ||
        'No selected market is currently available'
      );
    }

    /*
     Render EXACTLY what backend selected.
    */
    renderMarket(
      data.selectedMarket,
      data
    );

    setConnectionStatus(
      'LIVE DATA CONNECTED'
    );

    return data;
  } catch (error) {
    console.error(
      'PO AI Predictor:',
      error
    );

    /*
     Never erase a valid previous signal just
     because one refresh failed.
    */
    if (
      currentMarket
    ) {
      setConnectionStatus(
        'LIVE DATA TEMPORARILY UNAVAILABLE'
      );

      return currentResponse;
    }

    setConnectionStatus(
      'LIVE DATA ERROR'
    );

    setText(
      $(
        'signal',
        'signalText',
        'marketSignal',
        'signalValue'
      ),
      'NO DATA'
    );

    return null;
  } finally {
    requestInProgress =
      false;
  }
}

/* ==========================================================
   AUTO REFRESH
========================================================== */

function startAutoRefresh() {
  if (
    refreshTimer
  ) {
    clearInterval(
      refreshTimer
    );
  }

  refreshTimer =
    setInterval(
      () => {
        analyzeMarket();
      },
      REFRESH_INTERVAL_MS
    );
}

function startCountdown() {
  if (
    countdownTimer
  ) {
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
   BUTTON
========================================================== */

function bindAnalyzeButton() {
  const button =
    $(
      'analyzeBtn',
      'analyzeMarketBtn',
      'analyzeButton',
      'analyzeMarket'
    );

  if (!button) {
    return;
  }

  button.addEventListener(
    'click',
    () => {
      analyzeMarket({
        force: true
      });
    }
  );
}

/* ==========================================================
   INIT
========================================================== */

async function init() {
  bindAnalyzeButton();

  startCountdown();

  startAutoRefresh();

  /*
   First live request.
  */
  await analyzeMarket({
    force: true
  });

  /*
   Health is informational only.
   It does NOT determine the signal.
  */
  await checkBackend();
}

/* ==========================================================
   PUBLIC API
========================================================== */

window.POAI = {
  version:
    'V9.0.3',

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
  document.readyState ===
  'loading'
) {
  document.addEventListener(
    'DOMContentLoaded',
    init
  );
} else {
  init();
}
