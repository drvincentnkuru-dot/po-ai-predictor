'use strict';

/*
============================================================
 PO AI PREDICTOR
 FRONTEND V9.0.1 FINAL
 LIVE ONLY — TWELVE DATA

 BACKEND:
 https://po-ai-predictor-api.onrender.com

 FINAL ARCHITECTURE
 -----------------------------------------------------------
 /api/best
      ↓
 response.selectedMarket
      ↓
 renderMarket(selectedMarket)
      ↓
 UI

 IMPORTANT:
 - Frontend DOES NOT calculate signal
 - Frontend DOES NOT calculate confidence
 - Frontend DOES NOT select pair
 - Frontend DOES NOT select timeframe
 - Frontend DOES NOT calculate scores
 - Frontend DOES NOT reinterpret indicators
 - Backend selectedMarket is the single source of truth
 - One API response contract
 - Preserves last valid signal during temporary errors
============================================================
*/


/* ==========================================================
   CONFIGURATION
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

let countdownTimer = null;
let refreshTimer = null;

let requestInProgress = false;


/* ==========================================================
   DOM HELPERS
========================================================== */

function $(selector) {
  return document.querySelector(selector);
}

function setText(selector, value) {
  const el = $(selector);

  if (!el) return;

  el.textContent =
    value === undefined ||
    value === null ||
    value === ''
      ? '—'
      : String(value);
}

function setHTML(selector, value) {
  const el = $(selector);

  if (!el) return;

  el.innerHTML =
    value === undefined ||
    value === null
      ? ''
      : String(value);
}

function addClass(selector, className) {
  const el = $(selector);

  if (!el) return;

  el.classList.add(className);
}

function removeClass(selector, className) {
  const el = $(selector);

  if (!el) return;

  el.classList.remove(className);
}


/* ==========================================================
   SAFE NUMBER FORMATTERS
========================================================== */

function numberValue(value, fallback = null) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return n;
}

function formatNumber(value, decimals = 5) {
  const n = numberValue(value);

  if (n === null) {
    return '—';
  }

  return n.toFixed(decimals);
}

function formatPrice(value) {
  const n = numberValue(value);

  if (n === null) {
    return '—';
  }

  /*
   Forex prices can have different decimal precision.
   Preserve useful precision without changing backend data.
  */

  if (Math.abs(n) >= 100) {
    return n.toFixed(3);
  }

  if (Math.abs(n) >= 10) {
    return n.toFixed(4);
  }

  return n.toFixed(5);
}

function formatPercent(value) {
  const n = numberValue(value);

  if (n === null) {
    return '—';
  }

  return `${Math.round(n)}%`;
}

function formatScore(value) {
  const n = numberValue(value);

  if (n === null) {
    return '—';
  }

  return Math.round(n);
}


/* ==========================================================
   TIME HELPERS
========================================================== */

function parseTime(value) {
  if (!value) {
    return null;
  }

  const time = new Date(value);

  if (Number.isNaN(time.getTime())) {
    return null;
  }

  return time;
}

function formatUTC(value) {
  const time = parseTime(value);

  if (!time) {
    return '—';
  }

  return time.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  }) + ' UTC';
}

function formatUTCShort(value) {
  const time = parseTime(value);

  if (!time) {
    return '—';
  }

  return time.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false
  }) + ' UTC';
}

function secondsUntil(value) {
  const time = parseTime(value);

  if (!time) {
    return null;
  }

  return Math.floor(
    (time.getTime() - Date.now()) / 1000
  );
}

function formatCountdown(seconds) {
  if (seconds === null || seconds === undefined) {
    return '—';
  }

  const s = Math.max(0, Math.floor(Number(seconds)));

  const minutes = Math.floor(s / 60);
  const remainder = s % 60;

  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}


/* ==========================================================
   ESCAPE HTML
========================================================== */

function escapeHTML(value) {
  return String(
    value === undefined ||
    value === null
      ? ''
      : value
  )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


/* ==========================================================
   SIGNAL DISPLAY
========================================================== */

function updateSignal(signal) {
  const normalized =
    String(signal || 'NO TRADE')
      .trim()
      .toUpperCase();

  const signalEl =
    $('#signal') ||
    $('#signalBadge') ||
    $('.signal-badge');

  const trendEl =
    $('#trend') ||
    $('#trendText') ||
    $('.trend');

  /*
   Remove previous signal classes.
  */

  const possibleClasses = [
    'call',
    'put',
    'no-trade',
    'CALL',
    'PUT',
    'NO-TRADE',
    'buy',
    'sell',
    'bullish',
    'bearish'
  ];

  if (signalEl) {
    possibleClasses.forEach(cls => {
      signalEl.classList.remove(cls);
    });
  }

  if (trendEl) {
    possibleClasses.forEach(cls => {
      trendEl.classList.remove(cls);
    });
  }

  let displaySignal = normalized;

  if (
    normalized !== 'CALL' &&
    normalized !== 'PUT' &&
    normalized !== 'NO TRADE'
  ) {
    displaySignal = 'NO TRADE';
  }

  if (signalEl) {
    signalEl.textContent = displaySignal;

    if (displaySignal === 'CALL') {
      signalEl.classList.add('call');
    }

    if (displaySignal === 'PUT') {
      signalEl.classList.add('put');
    }

    if (displaySignal === 'NO TRADE') {
      signalEl.classList.add('no-trade');
    }
  }

  if (trendEl) {
    trendEl.textContent =
      displaySignal === 'CALL'
        ? 'CALL'
        : displaySignal === 'PUT'
          ? 'PUT'
          : 'NO TRADE';

    if (displaySignal === 'CALL') {
      trendEl.classList.add('call');
    }

    if (displaySignal === 'PUT') {
      trendEl.classList.add('put');
    }

    if (displaySignal === 'NO TRADE') {
      trendEl.classList.add('no-trade');
    }
  }
}


/* ==========================================================
   STATUS DISPLAY
========================================================== */

function setStatus(message, type = '') {
  const candidates = [
    $('#status'),
    $('#statusText'),
    $('#connectionStatus'),
    $('.status')
  ].filter(Boolean);

  candidates.forEach(el => {
    el.textContent = message;

    el.classList.remove(
      'success',
      'error',
      'warning',
      'connected',
      'disconnected'
    );

    if (type) {
      el.classList.add(type);
    }
  });
}

function setBackendStatus(online) {
  if (online) {
    setStatus('LIVE DATA CONNECTED.', 'success');
  } else {
    setStatus('BACKEND CONNECTION ERROR.', 'error');
  }
}


/* ==========================================================
   MARKET IDENTIFICATION
========================================================== */

function renderPair(market) {
  const pair =
    market && market.pair
      ? market.pair
      : '—';

  setText('#selectedPair', pair);
  setText('#pair', pair);
  setText('#marketPair', pair);
  setText('#currentPair', pair);
}

function renderTimeframe(market) {
  const timeframe =
    numberValue(
      market && market.timeframe,
      null
    );

  if (timeframe === null) {
    return;
  }

  const text = `${timeframe} MIN`;

  setText('#selectedTimeframe', text);
  setText('#timeframe', text);
  setText('#expiryTimeframe', text);
  setText('#currentTimeframe', text);
}


/* ==========================================================
   CONFIDENCE
========================================================== */

function renderConfidence(market) {
  const confidence =
    market
      ? numberValue(market.confidence, null)
      : null;

  if (confidence === null) {
    return;
  }

  const text = `${Math.round(confidence)}%`;

  setText('#confidence', text);
  setText('#confidenceValue', text);
  setText('#confidenceScore', text);
}


/* ==========================================================
   ENTRY / EXPIRY
========================================================== */

function renderEntryExpiry(market) {
  if (!market) {
    return;
  }

  const entryTime =
    market.entryTime || null;

  const expiryTime =
    market.expiryTime || null;

  setText(
    '#entryTime',
    formatUTC(entryTime)
  );

  setText(
    '#entry',
    formatUTC(entryTime)
  );

  setText(
    '#expiryTime',
    formatUTC(expiryTime)
  );

  setText(
    '#expiry',
    formatUTC(expiryTime)
  );

  setText(
    '#lastCandle',
    formatUTC(market.lastCandle)
  );

  const entrySeconds =
    numberValue(
      market.entryInSeconds,
      null
    );

  if (entrySeconds !== null) {
    setText(
      '#entryInSeconds',
      `${Math.max(0, Math.round(entrySeconds))} sec`
    );
  }
}


/* ==========================================================
   CURRENT PRICE
========================================================== */

function renderCurrentPrice(market) {
  if (!market) {
    return;
  }

  const price =
    formatPrice(market.currentPrice);

  setText('#currentPrice', price);
  setText('#price', price);
  setText('#marketPrice', price);
}


/* ==========================================================
   INDICATORS
========================================================== */

function renderIndicators(market) {
  if (!market) {
    return;
  }

  const indicators =
    market.indicators || {};

  /*
   IMPORTANT:
   These values are DISPLAY ONLY.

   Frontend does not interpret them.
   Frontend does not create signal logic from them.
  */

  setText(
    '#ema9',
    formatPrice(indicators.ema9)
  );

  setText(
    '#ema21',
    formatPrice(indicators.ema21)
  );

  setText(
    '#rsi14',
    formatNumber(indicators.rsi14, 2)
  );

  setText(
    '#adx14',
    formatNumber(indicators.adx14, 2)
  );

  setText(
    '#atr14',
    formatNumber(indicators.atr14, 6)
  );

  setText(
    '#stochastic14',
    formatNumber(indicators.stochastic14, 2)
  );

  setText(
    '#support',
    formatPrice(indicators.support)
  );

  setText(
    '#resistance',
    formatPrice(indicators.resistance)
  );

  setText(
    '#bollingerUpper',
    formatPrice(indicators.bollingerUpper)
  );

  setText(
    '#bollingerMiddle',
    formatPrice(indicators.bollingerMiddle)
  );

  setText(
    '#bollingerLower',
    formatPrice(indicators.bollingerLower)
  );
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

  setText(
    '#priceActionPattern',
    priceAction.pattern || '—'
  );

  setText(
    '#pattern',
    priceAction.pattern || '—'
  );

  setText(
    '#priceActionDirection',
    priceAction.direction || '—'
  );

  setText(
    '#priceActionStrength',
    priceAction.strength !== undefined
      ? priceAction.strength
      : '—'
  );
}


/* ==========================================================
   MARKET PSYCHOLOGY
========================================================== */

function renderMarketPsychology(market) {
  if (!market) {
    return;
  }

  const psychology =
    market.marketPsychology || {};

  /*
   IMPORTANT:
   "Market Psychology" is backend price-action inference.
   Frontend only displays backend values.
  */

  setText(
    '#marketPsychology',
    psychology.label || '—'
  );

  setText(
    '#psychologyLabel',
    psychology.label || '—'
  );

  setText(
    '#psychologyDirection',
    psychology.direction || '—'
  );

  setText(
    '#psychologyScore',
    psychology.score !== undefined
      ? psychology.score
      : '—'
  );
}


/* ==========================================================
   SCORE
========================================================== */

function renderScore(market) {
  if (!market) {
    return;
  }

  const score =
    market.score || {};

  setText(
    '#callScore',
    formatScore(score.call)
  );

  setText(
    '#putScore',
    formatScore(score.put)
  );

  setText(
    '#signalGap',
    formatScore(score.gap)
  );
}


/* ==========================================================
   QUALITY
========================================================== */

function renderQuality(market) {
  if (!market) {
    return;
  }

  const quality =
    market.quality || {};

  setText(
    '#volatility',
    quality.volatility || '—'
  );

  setText(
    '#nearSupport',
    quality.nearSupport === true
      ? 'YES'
      : quality.nearSupport === false
        ? 'NO'
        : '—'
  );

  setText(
    '#nearResistance',
    quality.nearResistance === true
      ? 'YES'
      : quality.nearResistance === false
        ? 'NO'
        : '—'
  );
}


/* ==========================================================
   DISPLAY-ONLY MARKET FACTS
========================================================== */

function renderMarketFacts(market) {
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

   This section intentionally does NOT say:
   - RSI bullish
   - RSI bearish
   - EMA bullish
   - EMA bearish
   - ADX strong
   - pattern means CALL
   - psychology means PUT

   It only displays the exact backend values.

   Therefore frontend cannot accidentally create
   a second signal engine.
  */

  const facts = [];

  if (
    indicators.ema9 !== undefined &&
    indicators.ema21 !== undefined
  ) {
    facts.push(
      `EMA9 ${formatPrice(indicators.ema9)}`
    );

    facts.push(
      `EMA21 ${formatPrice(indicators.ema21)}`
    );
  }

  if (indicators.rsi14 !== undefined) {
    facts.push(
      `RSI14 ${formatNumber(indicators.rsi14, 2)}`
    );
  }

  if (indicators.adx14 !== undefined) {
    facts.push(
      `ADX14 ${formatNumber(indicators.adx14, 2)}`
    );
  }

  if (indicators.stochastic14 !== undefined) {
    facts.push(
      `STOCH ${formatNumber(indicators.stochastic14, 2)}`
    );
  }

  if (priceAction.pattern) {
    facts.push(
      `PATTERN ${priceAction.pattern}`
    );
  }

  if (psychology.label) {
    facts.push(
      `PSYCHOLOGY ${psychology.label}`
    );
  }

  if (
    score.call !== undefined &&
    score.put !== undefined
  ) {
    facts.push(
      `CALL ${formatScore(score.call)} / PUT ${formatScore(score.put)}`
    );
  }

  if (
    score.gap !== undefined
  ) {
    facts.push(
      `GAP ${formatScore(score.gap)}`
    );
  }

  const factsText =
    facts.length > 0
      ? facts.join(' • ')
      : 'Backend market data received.';

  /*
   Support several possible IDs so this remains
   compatible with the existing HTML.
  */

  setText('#marketReasons', factsText);
  setText('#signalReasons', factsText);
  setText('#reasons', factsText);
  setText('#analysisReasons', factsText);
}


/* ==========================================================
   DATA AGE
========================================================== */

function renderDataAge(market) {
  if (!market) {
    return;
  }

  /*
   Backend V9 response does not necessarily provide dataAge.
   Therefore only display it when it exists.
  */

  if (
    market.dataAge !== undefined &&
    market.dataAge !== null
  ) {
    const age =
      numberValue(
        market.dataAge,
        null
      );

    if (age !== null) {
      setText(
        '#dataAge',
        `${Math.round(age)} sec`
      );
    }
  }

  if (
    market.dataAgeSeconds !== undefined &&
    market.dataAgeSeconds !== null
  ) {
    const age =
      numberValue(
        market.dataAgeSeconds,
        null
      );

    if (age !== null) {
      setText(
        '#dataAge',
        `${Math.round(age)} sec`
      );
    }
  }
}


/* ==========================================================
   COUNTDOWN
========================================================== */

function updateCountdown() {
  if (!currentMarket) {
    return;
  }

  const seconds =
    secondsUntil(
      currentMarket.entryTime
    );

  if (seconds === null) {
    return;
  }

  const countdown =
    formatCountdown(seconds);

  setText(
    '#countdown',
    countdown
  );

  setText(
    '#entryCountdown',
    countdown
  );

  setText(
    '#timeToEntry',
    countdown
  );

  /*
   Also expose raw seconds where the HTML supports it.
  */

  setText(
    '#countdownSeconds',
    `${Math.max(0, seconds)} sec`
  );
}


/* ==========================================================
   SCANNER INFORMATION
========================================================== */

function renderScanner(response) {
  if (!response) {
    return;
  }

  const scanner =
    response.scanner || {};

  const metadata =
    response.metadata || {};

  setText(
    '#scannerStatus',
    scanner.scanRunning === true
      ? 'RUNNING'
      : 'READY'
  );

  setText(
    '#scanCursor',
    scanner.scanCursor !== undefined
      ? scanner.scanCursor
      : '—'
  );

  setText(
    '#scanBatchSize',
    scanner.scanBatchSize !== undefined
      ? scanner.scanBatchSize
      : '—'
  );

  setText(
    '#lastScan',
    formatUTC(scanner.lastScanAt)
  );

  setText(
    '#totalScanned',
    scanner.totalScanned !== undefined
      ? scanner.totalScanned
      : '—'
  );

  setText(
    '#totalFailed',
    scanner.totalFailed !== undefined
      ? scanner.totalFailed
      : '—'
  );

  setText(
    '#apiRequests',
    scanner.totalApiRequests !== undefined
      ? scanner.totalApiRequests
      : '—'
  );

  setText(
    '#candidateCount',
    response.candidateCount !== undefined
      ? response.candidateCount
      : '—'
  );

  if (
    metadata.dailyCreditsUsed !== undefined
  ) {
    setText(
      '#dailyCreditsUsed',
      metadata.dailyCreditsUsed
    );
  }

  if (
    metadata.dailyCreditsRemaining !== undefined
  ) {
    setText(
      '#dailyCreditsRemaining',
      metadata.dailyCreditsRemaining
    );
  }

  if (
    metadata.providerMinuteLimit !== undefined
  ) {
    setText(
      '#providerMinuteLimit',
      metadata.providerMinuteLimit
    );
  }
}


/* ==========================================================
   RENDER COMPLETE MARKET
========================================================== */

function renderMarket(market, response = null) {
  if (!market) {
    return;
  }

  /*
   This is the most important architectural rule:

   market = response.selectedMarket

   Everything shown below is read directly from
   that object.

   No frontend prediction engine exists here.
  */

  currentMarket = market;

  if (response) {
    currentResponse = response;
  }

  /*
   Core signal
  */

  updateSignal(market.signal);

  /*
   Market
  */

  renderPair(market);
  renderTimeframe(market);

  /*
   Confidence
  */

  renderConfidence(market);

  /*
   Entry / expiry
  */

  renderEntryExpiry(market);

  /*
   Current price
  */

  renderCurrentPrice(market);

  /*
   Indicators
  */

  renderIndicators(market);

  /*
   Price action
  */

  renderPriceAction(market);

  /*
   Market psychology
  */

  renderMarketPsychology(market);

  /*
   Backend score
  */

  renderScore(market);

  /*
   Backend quality
  */

  renderQuality(market);

  /*
   Display-only facts.

   No interpretation.
  */

  renderMarketFacts(market);

  /*
   Data age if available
  */

  renderDataAge(market);

  /*
   Countdown
  */

  updateCountdown();

  /*
   Scanner metadata
  */

  if (response) {
    renderScanner(response);
  }

  /*
   Optional generic market timestamp
  */

  setText(
    '#updatedAt',
    formatUTCShort(
      market.lastCandle
    )
  );

  setText(
    '#marketUpdatedAt',
    formatUTCShort(
      market.lastCandle
    )
  );
}


/* ==========================================================
   FETCH WITH TIMEOUT
========================================================== */

async function fetchJSON(
  url,
  options = {},
  timeout = FETCH_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timeoutId =
    setTimeout(
      () => controller.abort(),
      timeout
    );

  try {
    const response =
      await fetch(
        url,
        {
          ...options,
          signal: controller.signal,
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            ...(options.headers || {})
          }
        }
      );

    const text =
      await response.text();

    let data = null;

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

      throw new Error(message);
    }

    return data;

  } finally {
    clearTimeout(timeoutId);
  }
}


/* ==========================================================
   BACKEND HEALTH CHECK
========================================================== */

async function checkBackend() {
  try {
    const data =
      await fetchJSON(
        HEALTH_ENDPOINT
      );

    if (
      data &&
      (
        data.ok === true ||
        data.status === 'ok'
      )
    ) {
      setBackendStatus(true);

      /*
       Health is informational only.
       It does not control the market signal.
      */

      return data;
    }

    throw new Error(
      'Backend health check failed'
    );

  } catch (error) {
    console.error(
      '[POAI] Backend health error:',
      error
    );

    /*
     Do not erase the last valid market.
     Only update connection status.
    */

    setBackendStatus(false);

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

  requestInProgress = true;

  const button =
    $('#analyzeButton') ||
    $('#analyzeBtn') ||
    $('button[data-action="analyze"]');

  if (button) {
    button.disabled = true;

    /*
     Preserve original button text where possible.
    */

    if (!button.dataset.originalText) {
      button.dataset.originalText =
        button.textContent;
    }

    button.textContent =
      'ANALYZING...';
  }

  try {
    setStatus(
      'CONNECTING TO LIVE DATA...',
      'warning'
    );

    /*
     ONE endpoint.
     ONE response.
     ONE selectedMarket.

     No pair/timeframe request is sent from frontend.
    */

    const data =
      await fetchJSON(
        BEST_ENDPOINT
      );

    /*
     Strict response validation.
    */

    if (!data || data.ok !== true) {
      throw new Error(
        data && data.error
          ? data.error
          : 'Backend returned ok:false'
      );
    }

    if (
      !data.selectedMarket ||
      typeof data.selectedMarket !== 'object'
    ) {
      throw new Error(
        'Backend response has no selectedMarket'
      );
    }

    /*
     Store complete backend response for debugging.
    */

    currentResponse = data;

    try {
      window.__POAI_LAST_RESPONSE = data;
    } catch (error) {
      /*
       Ignore storage/debug assignment failure.
      */
    }

    /*
     THE ONLY MARKET OBJECT USED BY THE FRONTEND.
    */

    const selectedMarket =
      data.selectedMarket;

    /*
     Render exactly what backend selected.
    */

    renderMarket(
      selectedMarket,
      data
    );

    /*
     Successful connection.
    */

    setBackendStatus(true);

    /*
     Additional status information.
    */

    const signal =
      String(
        selectedMarket.signal || 'NO TRADE'
      ).toUpperCase();

    const pair =
      selectedMarket.pair || '—';

    const timeframe =
      selectedMarket.timeframe !== undefined
        ? `${selectedMarket.timeframe}M`
        : '';

    setText(
      '#analysisStatus',
      `${pair} • ${timeframe} • ${signal}`
    );

    return data;

  } catch (error) {
    console.error(
      '[POAI] Analyze error:',
      error
    );

    /*
     VERY IMPORTANT:

     Do not replace a valid previous signal with
     fake values simply because the network failed.

     Keep currentMarket visible.
    */

    if (currentMarket) {
      setStatus(
        'LIVE CONNECTION TEMPORARILY UNAVAILABLE — SHOWING LAST VALID SIGNAL.',
        'warning'
      );

      updateCountdown();

    } else {
      setStatus(
        `LIVE DATA ERROR: ${error.message}`,
        'error'
      );
    }

    return null;

  } finally {
    requestInProgress = false;

    if (button) {
      button.disabled = false;

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
    clearInterval(refreshTimer);
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
    clearInterval(countdownTimer);
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
   BUTTON BINDING
========================================================== */

function bindAnalyzeButton() {
  const button =
    $('#analyzeButton') ||
    $('#analyzeBtn') ||
    $('button[data-action="analyze"]');

  if (!button) {
    console.warn(
      '[POAI] Analyze button not found.'
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
   SELECT / INPUT COMPATIBILITY
========================================================== */

function preserveExistingControls() {
  /*
   V9 backend automatically selects the strongest market.

   Therefore frontend does not use pair/timeframe controls
   to generate a separate prediction.

   Existing dropdowns can remain in the HTML without
   affecting backend selectedMarket.
  */

  const pairSelect =
    $('#pairSelect') ||
    $('#currencyPair') ||
    $('#pair');

  const timeframeSelect =
    $('#timeframeSelect') ||
    $('#expirySelect') ||
    $('#timeframe');

  /*
   These controls are intentionally NOT used to calculate
   signal/pair/confidence.

   They remain compatible with the existing UI.
  */

  if (pairSelect) {
    pairSelect.dataset.backendControlled = 'true';
  }

  if (timeframeSelect) {
    timeframeSelect.dataset.backendControlled = 'true';
  }
}


/* ==========================================================
   INITIAL UI STATE
========================================================== */

function initializeUI() {
  setStatus(
    'CONNECTING TO LIVE DATA...',
    'warning'
  );

  /*
   Do not fabricate:
   - CALL
   - PUT
   - confidence
   - pair
   - timeframe

   until backend returns selectedMarket.
  */

  setText(
    '#countdown',
    '—'
  );

  setText(
    '#entryCountdown',
    '—'
  );

  setText(
    '#confidence',
    '—'
  );
}


/* ==========================================================
   INITIAL LOAD
========================================================== */

async function init() {
  console.log(
    '[POAI] PO AI Predictor V9.0.1 FINAL starting...'
  );

  console.log(
    '[POAI] Backend:',
    API_BASE
  );

  initializeUI();

  preserveExistingControls();

  bindAnalyzeButton();

  startCountdown();

  /*
   First live analysis.
  */

  await analyzeMarket();

  /*
   Informational health check.
   It does not create or modify the signal.
  */

  checkBackend();

  /*
   Continue refreshing the ONE /api/best response.
  */

  startAutoRefresh();
}


/* ==========================================================
   PUBLIC API
========================================================== */

window.POAI = {
  version: 'V9.0.1 FINAL',

  analyzeMarket,

  checkBackend,

  renderMarket,

  getCurrentMarket: () =>
    currentMarket,

  getLastResponse: () =>
    currentResponse
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
 END OF PO AI PREDICTOR FRONTEND V9.0.1 FINAL
============================================================ */
