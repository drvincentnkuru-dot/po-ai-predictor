'use strict';

/*
============================================================
 PO AI PREDICTOR
 Frontend V9.0.4

 BACKEND:
 https://po-ai-predictor-api.onrender.com

 IMPORTANT:
 Frontend is ONLY a renderer.

 Backend is the SINGLE SOURCE OF TRUTH.

 Frontend does NOT calculate:
 - CALL / PUT
 - confidence
 - score
 - entry
 - expiry
 - freshness
 - indicators

 Everything comes from ONE /api/best response.
============================================================
*/

const API_BASE =
  'https://po-ai-predictor-api.onrender.com';

const BEST_ENDPOINT =
  `${API_BASE}/api/best`;

const HEALTH_ENDPOINT =
  `${API_BASE}/api/health`;

/*
============================================================
FRONTEND SETTINGS
============================================================
*/

const REFRESH_INTERVAL_MS =
  15000;

const FETCH_TIMEOUT_MS =
  20000;

const COUNTDOWN_INTERVAL_MS =
  1000;

/*
============================================================
STATE
============================================================
*/

let currentResponse = null;
let currentMarket = null;

let requestRunning = false;

let refreshTimer = null;
let countdownTimer = null;

let lastSuccessfulAt = null;

/*
Expose response for browser debugging.
*/
window.__POAI_LAST_RESPONSE = null;

/*
============================================================
DOM HELPERS
============================================================
*/

function byId(id) {
  return document.getElementById(id);
}

function firstExisting(ids) {
  for (const id of ids) {
    const el = byId(id);

    if (el) {
      return el;
    }
  }

  return null;
}

function setText(
  ids,
  value
) {
  const list =
    Array.isArray(ids)
      ? ids
      : [ids];

  const el =
    firstExisting(list);

  if (el) {
    el.textContent =
      value === null ||
      value === undefined
        ? '--'
        : String(value);
  }
}

function setHTML(
  ids,
  value
) {
  const list =
    Array.isArray(ids)
      ? ids
      : [ids];

  const el =
    firstExisting(list);

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
  const list =
    Array.isArray(ids)
      ? ids
      : [ids];

  const el =
    firstExisting(list);

  if (el) {
    el.className =
      className;
  }
}

function setDisabled(
  ids,
  disabled
) {
  const list =
    Array.isArray(ids)
      ? ids
      : [ids];

  const el =
    firstExisting(list);

  if (el) {
    el.disabled =
      Boolean(disabled);
  }
}

/*
============================================================
FORMATTERS
============================================================
*/

function numberValue(
  value,
  decimals = 6
) {
  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return '--';
  }

  return n.toFixed(decimals);
}

function percentValue(
  value
) {
  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return '--';
  }

  return `${Math.round(n)}%`;
}

function formatTime(
  value
) {
  if (!value) {
    return '--';
  }

  const date =
    new Date(value);

  if (
    !Number.isFinite(
      date.getTime()
    )
  ) {
    return '--';
  }

  return date.toLocaleTimeString(
    [],
    {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }
  );
}

function formatDateTime(
  value
) {
  if (!value) {
    return '--';
  }

  const date =
    new Date(value);

  if (
    !Number.isFinite(
      date.getTime()
    )
  ) {
    return '--';
  }

  return date.toLocaleString(
    [],
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }
  );
}

/*
============================================================
FETCH WITH TIMEOUT
============================================================
*/

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = FETCH_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

/*
============================================================
STATUS
============================================================
*/

function setStatus(
  message,
  type = 'normal'
) {
  const ids = [
    'status',
    'statusText',
    'connectionStatus',
    'liveStatus'
  ];

  const el =
    firstExisting(ids);

  if (!el) {
    return;
  }

  el.textContent =
    message;

  el.dataset.status =
    type;
}

/*
============================================================
SIGNAL DISPLAY
============================================================
*/

function renderSignal(
  market
) {
  if (!market) {
    setText(
      [
        'signal',
        'signalText',
        'prediction',
        'tradeSignal'
      ],
      'NO TRADE'
    );

    return;
  }

  const signal =
    market.signal ||
    'NO TRADE';

  setText(
    [
      'signal',
      'signalText',
      'prediction',
      'tradeSignal'
    ],
    signal
  );

  const signalClass =
    signal === 'CALL'
      ? 'signal-call'
      : signal === 'PUT'
        ? 'signal-put'
        : 'signal-no-trade';

  setClass(
    [
      'signal',
      'signalText',
      'prediction',
      'tradeSignal'
    ],
    signalClass
  );
}

/*
============================================================
MARKET
============================================================
*/

function renderMarket(
  market
) {
  if (!market) {
    return;
  }

  setText(
    [
      'pair',
      'currencyPair',
      'selectedPair',
      'marketPair'
    ],
    market.pair
  );

  setText(
    [
      'timeframe',
      'selectedTimeframe',
      'expiryTimeframe',
      'tf'
    ],
    market.timeframe
      ? `${market.timeframe}m`
      : '--'
  );

  setText(
    [
      'confidence',
      'confidenceValue'
    ],
    percentValue(
      market.confidence
    )
  );

  setText(
    [
      'currentPrice',
      'price',
      'marketPrice'
    ],
    numberValue(
      market.currentPrice,
      6
    )
  );

  setText(
    [
      'entryPrice',
      'entry'
    ],
    numberValue(
      market.entryPrice,
      6
    )
  );

  setText(
    [
      'entryTime',
      'entryAt'
    ],
    formatTime(
      market.entryTime
    )
  );

  setText(
    [
      'expiryTime',
      'expiryAt'
    ],
    formatTime(
      market.expiryTime
    )
  );

  setText(
    [
      'lastCandle',
      'lastCandleTime'
    ],
    formatDateTime(
      market.lastCandle
    )
  );

  setText(
    [
      'dataAge',
      'dataAgeSeconds',
      'dataFreshness'
    ],
    Number.isFinite(
      Number(
        market.dataAgeSeconds
      )
    )
      ? `${Math.round(
          Number(
            market.dataAgeSeconds
          )
        )}s`
      : '--'
  );

  renderSignal(
    market
  );
}

/*
============================================================
COUNTDOWN
============================================================
*/

function calculateCountdownSeconds(
  expiryTime
) {
  if (!expiryTime) {
    return null;
  }

  const expiry =
    new Date(
      expiryTime
    ).getTime();

  if (!Number.isFinite(expiry)) {
    return null;
  }

  return Math.max(
    0,
    Math.floor(
      (expiry -
        Date.now()) /
        1000
    )
  );
}

function renderCountdown() {
  if (!currentMarket) {
    setText(
      [
        'countdown',
        'entryCountdown',
        'timer',
        'countdownTimer'
      ],
      '--'
    );

    return;
  }

  /*
  Countdown is based on backend expiryTime.
  */
  const seconds =
    calculateCountdownSeconds(
      currentMarket.expiryTime
    );

  if (
    seconds === null
  ) {
    setText(
      [
        'countdown',
        'entryCountdown',
        'timer',
        'countdownTimer'
      ],
      '--'
    );

    return;
  }

  const minutes =
    Math.floor(
      seconds / 60
    );

  const remaining =
    seconds % 60;

  const text =
    `${String(minutes).padStart(2, '0')}:` +
    `${String(remaining).padStart(2, '0')}`;

  setText(
    [
      'countdown',
      'entryCountdown',
      'timer',
      'countdownTimer'
    ],
    text
  );
}

/*
============================================================
SCORES
============================================================
*/

function renderScores(
  market
) {
  if (!market) {
    return;
  }

  setText(
    [
      'callScore',
      'callScoreValue'
    ],
    market.callScore
  );

  setText(
    [
      'putScore',
      'putScoreValue'
    ],
    market.putScore
  );

  setText(
    [
      'scoreGap',
      'gap',
      'gapValue'
    ],
    market.gap
  );
}

/*
============================================================
INDICATORS
============================================================
*/

function renderIndicators(
  market
) {
  if (!market) {
    return;
  }

  const i =
    market.indicators || {};

  setText(
    [
      'ema9',
      'ema9Value'
    ],
    numberValue(
      i.ema9,
      6
    )
  );

  setText(
    [
      'ema21',
      'ema21Value'
    ],
    numberValue(
      i.ema21,
      6
    )
  );

  setText(
    [
      'rsi14',
      'rsi',
      'rsiValue'
    ],
    numberValue(
      i.rsi14,
      2
    )
  );

  setText(
    [
      'adx14',
      'adx',
      'adxValue'
    ],
    numberValue(
      i.adx14,
      2
    )
  );

  setText(
    [
      'stochastic14',
      'stochastic',
      'stochValue'
    ],
    numberValue(
      i.stochastic14,
      2
    )
  );

  setText(
    [
      'atr14',
      'atr',
      'atrValue'
    ],
    numberValue(
      i.atr14,
      8
    )
  );

  const b =
    i.bollinger || {};

  setText(
    [
      'bollingerUpper',
      'bbUpper'
    ],
    numberValue(
      b.upper,
      6
    )
  );

  setText(
    [
      'bollingerMiddle',
      'bbMiddle'
    ],
    numberValue(
      b.middle,
      6
    )
  );

  setText(
    [
      'bollingerLower',
      'bbLower'
    ],
    numberValue(
      b.lower,
      6
    )
  );
}

/*
============================================================
SUPPORT / RESISTANCE
============================================================
*/

function renderSupportResistance(
  market
) {
  if (!market) {
    return;
  }

  const sr =
    market.supportResistance ||
    {};

  setText(
    [
      'support',
      'supportValue'
    ],
    numberValue(
      sr.support,
      6
    )
  );

  setText(
    [
      'resistance',
      'resistanceValue'
    ],
    numberValue(
      sr.resistance,
      6
    )
  );
}

/*
============================================================
PRICE ACTION
============================================================
*/

function renderPriceAction(
  market
) {
  if (!market) {
    return;
  }

  const pa =
    market.priceAction ||
    {};

  setText(
    [
      'priceAction',
      'priceActionPattern',
      'pattern'
    ],
    pa.pattern
  );

  setText(
    [
      'priceActionDirection',
      'patternDirection'
    ],
    pa.direction
  );

  setText(
    [
      'priceActionStrength',
      'patternStrength'
    ],
    pa.strength
  );
}

/*
============================================================
MARKET PSYCHOLOGY
============================================================
*/

function renderPsychology(
  market
) {
  if (!market) {
    return;
  }

  const p =
    market.marketPsychology ||
    {};

  setText(
    [
      'marketPsychology',
      'psychology',
      'psychologyLabel'
    ],
    p.label
  );

  setText(
    [
      'psychologyDirection'
    ],
    p.direction
  );

  setText(
    [
      'psychologyStrength'
    ],
    p.strength
  );
}

/*
============================================================
VOLATILITY / FRESHNESS
============================================================
*/

function renderQuality(
  market
) {
  if (!market) {
    return;
  }

  setText(
    [
      'volatility',
      'volatilityValue'
    ],
    market.volatility
  );

  const freshness =
    market.freshness ||
    {};

  setText(
    [
      'freshnessStatus',
      'freshness',
      'dataStatus'
    ],
    freshness.status ||
      '--'
  );

  setText(
    [
      'freshnessLimit',
      'maxDataAge'
    ],
    Number.isFinite(
      Number(
        freshness.maxAgeSeconds
      )
    )
      ? `${freshness.maxAgeSeconds}s`
      : '--'
  );
}

/*
============================================================
REASONS
============================================================
*/

function renderReasons(
  market
) {
  const reasons =
    market &&
    Array.isArray(
      market.reasons
    )
      ? market.reasons
      : [];

  const el =
    firstExisting([
      'reasons',
      'signalReasons',
      'analysisReasons',
      'reasonList'
    ]);

  if (!el) {
    return;
  }

  if (!reasons.length) {
    el.innerHTML =
      '<div>No reasons available.</div>';

    return;
  }

  el.innerHTML =
    reasons
      .map(
        reason =>
          `<div class="reason-item">${escapeHtml(
            reason
          )}</div>`
      )
      .join('');
}

/*
============================================================
ESCAPE HTML
============================================================
*/

function escapeHtml(
  value
) {
  return String(value)
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&#039;'
    );
}

/*
============================================================
SCANNER METADATA
============================================================
*/

function renderScanner(
  response
) {
  if (!response) {
    return;
  }

  const metadata =
    response.metadata ||
    {};

  const scanner =
    response.scanner ||
    {};

  setText(
    [
      'provider',
      'dataSource'
    ],
    response.source ||
      metadata.provider ||
      '--'
  );

  setText(
    [
      'cachedPairs'
    ],
    scanner.cachedPairs
  );

  setText(
    [
      'candidateCount'
    ],
    scanner.candidateCount
  );

  setText(
    [
      'scanRunning'
    ],
    scanner.scanRunning
      ? 'YES'
      : 'NO'
  );

  setText(
    [
      'lastScanAt'
    ],
    formatDateTime(
      scanner.lastScanAt
    )
  );

  setText(
    [
      'lastScanError'
    ],
    scanner.lastScanError ||
      'None'
  );

  setText(
    [
      'providerRequestsThisMinute',
      'minuteRequests'
    ],
    metadata.providerRequestsThisMinute
  );

  setText(
    [
      'dailyCreditsUsed'
    ],
    metadata.dailyCreditsUsed
  );

  setText(
    [
      'dailyCreditsRemaining'
    ],
    metadata.dailyCreditsRemaining
  );
}

/*
============================================================
RANKED CANDIDATES
============================================================
*/

function renderRankedCandidates(
  response
) {
  const el =
    firstExisting([
      'rankedCandidates',
      'candidateList',
      'marketCandidates'
    ]);

  if (!el) {
    return;
  }

  const candidates =
    Array.isArray(
      response.rankedCandidates
    )
      ? response.rankedCandidates
      : [];

  if (!candidates.length) {
    el.innerHTML =
      '<div>No valid fresh candidates.</div>';

    return;
  }

  el.innerHTML =
    candidates
      .map(
        (item, index) => {
          const signal =
            item.signal ||
            'NO TRADE';

          const freshness =
            item.freshness &&
            item.freshness.status
              ? item.freshness.status
              : '--';

          return `
            <div class="candidate-row">
              <span>${index + 1}. ${escapeHtml(
                item.pair
              )}</span>
              <span>${escapeHtml(
                `${item.timeframe}m`
              )}</span>
              <span>${escapeHtml(
                signal
              )}</span>
              <span>${escapeHtml(
                `${item.confidence}%`
              )}</span>
              <span>${escapeHtml(
                freshness
              )}</span>
              <span>${escapeHtml(
                `${item.dataAgeSeconds}s`
              )}</span>
            </div>
          `;
        }
      )
      .join('');
}

/*
============================================================
RENDER ONE COMPLETE API RESPONSE
============================================================
*/

function renderResponse(
  response
) {
  /*
  Validate response.
  */
  if (
    !response ||
    response.ok !== true
  ) {
    return false;
  }

  /*
  Keep the entire response.
  */
  currentResponse =
    response;

  window.__POAI_LAST_RESPONSE =
    response;

  /*
  Single source of truth.
  */
  if (
    response.selectedMarket
  ) {
    currentMarket =
      response.selectedMarket;
  }

  /*
  If backend explicitly gives NO TRADE
  with a selectedMarket, render it.
  */
  if (
    response.selectedMarket &&
    response.selectedMarket.signal
  ) {
    currentMarket =
      response.selectedMarket;
  }

  renderMarket(
    currentMarket
  );

  renderScores(
    currentMarket
  );

  renderIndicators(
    currentMarket
  );

  renderSupportResistance(
    currentMarket
  );

  renderPriceAction(
    currentMarket
  );

  renderPsychology(
    currentMarket
  );

  renderQuality(
    currentMarket
  );

  renderReasons(
    currentMarket
  );

  renderScanner(
    response
  );

  renderRankedCandidates(
    response
  );

  return true;
}

/*
============================================================
GET /api/best
============================================================
*/

async function analyzeMarket() {
  /*
  Prevent duplicate frontend requests.
  */
  if (requestRunning) {
    return;
  }

  requestRunning = true;

  setDisabled(
    [
      'analyzeBtn',
      'analyzeButton',
      'analyzeMarket'
    ],
    true
  );

  setStatus(
    'ANALYZING LIVE MARKET...',
    'loading'
  );

  try {
    const response =
      await fetchWithTimeout(
        BEST_ENDPOINT,
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
    Exact contract validation.
    */
    if (
      data.ok !== true
    ) {
      throw new Error(
        data.error ||
        'Backend returned ok=false'
      );
    }

    /*
    selectedMarket is expected from V9.0.4.
    */
    if (
      !data.selectedMarket
    ) {
      throw new Error(
        'Backend response has no selectedMarket'
      );
    }

    /*
    Render ONE response.
    */
    const rendered =
      renderResponse(
        data
      );

    if (!rendered) {
      throw new Error(
        'Invalid backend response'
      );
    }

    lastSuccessfulAt =
      new Date();

    const market =
      data.selectedMarket;

    if (
      market.signal === 'CALL'
    ) {
      setStatus(
        'LIVE DATA CONNECTED • CALL SIGNAL',
        'call'
      );
    } else if (
      market.signal === 'PUT'
    ) {
      setStatus(
        'LIVE DATA CONNECTED • PUT SIGNAL',
        'put'
      );
    } else {
      setStatus(
        'LIVE DATA CONNECTED • NO TRADE',
        'no-trade'
      );
    }

    renderCountdown();
  } catch (error) {
    console.error(
      'PO AI Predictor:',
      error
    );

    /*
    Important:
    Do NOT erase the last valid market because of
    a temporary network/backend problem.
    */
    if (currentMarket) {
      setStatus(
        'LIVE DATA • TEMPORARY CONNECTION ISSUE • SHOWING LAST VALID SIGNAL',
        'warning'
      );
    } else {
      setStatus(
        'WAITING FOR LIVE DATA...',
        'error'
      );
    }
  } finally {
    requestRunning =
      false;

    setDisabled(
      [
        'analyzeBtn',
        'analyzeButton',
        'analyzeMarket'
      ],
      false
    );
  }
}

/*
============================================================
HEALTH
============================================================
*/

async function checkHealth() {
  try {
    const response =
      await fetchWithTimeout(
        HEALTH_ENDPOINT,
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
      return;
    }

    const data =
      await response.json();

    /*
    Do not render health over market response.
    Only store it for diagnostics.
    */
    window.__POAI_HEALTH =
      data;

    /*
    Warn if API version differs.
    */
    if (
      data.version &&
      data.version !==
        'V9.0.4'
    ) {
      console.warn(
        `Frontend V9.0.4 connected to backend ${data.version}`
      );
    }
  } catch (error) {
    console.warn(
      'Health check failed:',
      error
    );
  }
}

/*
============================================================
AUTO REFRESH
============================================================
*/

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
      REFRESH_INTERVAL_MS
    );
}

/*
============================================================
COUNTDOWN TIMER
============================================================
*/

function startCountdown() {
  if (countdownTimer) {
    clearInterval(
      countdownTimer
    );
  }

  countdownTimer =
    setInterval(
      () => {
        renderCountdown();
      },
      COUNTDOWN_INTERVAL_MS
    );
}

/*
============================================================
ANALYZE BUTTON
============================================================
*/

function bindAnalyzeButton() {
  const button =
    firstExisting([
      'analyzeBtn',
      'analyzeButton',
      'analyzeMarket'
    ]);

  if (!button) {
    return;
  }

  /*
  Prevent duplicate listeners.
  */
  if (
    button.dataset.poaiBound ===
    'true'
  ) {
    return;
  }

  button.dataset.poaiBound =
    'true';

  button.addEventListener(
    'click',
    () => {
      analyzeMarket();
    }
  );
}

/*
============================================================
SELECTED PAIR / TIMEFRAME

The backend chooses the best market.

These controls are therefore informational unless the
HTML uses them for a separate /api/analyze request.

No frontend signal calculation is performed.
============================================================
*/

function populatePairs(
  response
) {
  if (
    !response ||
    !Array.isArray(
      response.pairs
    )
  ) {
    return;
  }

  const selects = [
    firstExisting([
      'pairSelect',
      'currencyPair',
      'pair'
    ]),
    firstExisting([
      'timeframeSelect',
      'expirySelect',
      'timeframe'
    ])
  ].filter(Boolean);

  const pairSelect =
    selects[0];

  if (
    pairSelect &&
    pairSelect.tagName ===
      'SELECT'
  ) {
    /*
    Only populate if currently empty.
    */
    if (
      pairSelect.options.length ===
      0
    ) {
      response.pairs.forEach(
        pair => {
          const option =
            document.createElement(
              'option'
            );

          option.value =
            pair;

          option.textContent =
            pair;

          pairSelect.appendChild(
            option
          );
        }
      );
    }
  }
}

/*
============================================================
INITIALIZE
============================================================
*/

async function initPOAI() {
  bindAnalyzeButton();

  startCountdown();

  startAutoRefresh();

  /*
  First market request.
  */
  await analyzeMarket();

  /*
  Health is separate diagnostics only.
  */
  checkHealth();
}

/*
============================================================
PUBLIC API
============================================================
*/

window.POAI = {
  analyzeMarket,
  checkHealth,
  getCurrentResponse:
    () => currentResponse,
  getCurrentMarket:
    () => currentMarket,
  refresh:
    analyzeMarket
};

/*
============================================================
START AFTER DOM READY
============================================================
*/

if (
  document.readyState ===
  'loading'
) {
  document.addEventListener(
    'DOMContentLoaded',
    initPOAI
  );
} else {
  initPOAI();
}
