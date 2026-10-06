'use strict';

/*
============================================================
 PO AI PREDICTOR
 FRONTEND V9.0.5
 LIVE ONLY

 Backend:
 https://po-ai-predictor-api.onrender.com

 IMPORTANT:
 Frontend does NOT calculate signals.
 Backend response is the single source of truth.
============================================================
*/

const API_BASE =
  'https://po-ai-predictor-api.onrender.com';

const BEST_ENDPOINT =
  `${API_BASE}/api/best`;

const REFRESH_MS = 15000;

let requestRunning = false;
let lastResponse = null;
let countdownTimer = null;

/* =========================================================
   DOM HELPERS
========================================================= */

function findElement(...ids) {
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
    value == null
      ? '--'
      : String(value);
}

function formatNumber(
  value,
  digits = 5
) {
  if (
    value == null ||
    !Number.isFinite(
      Number(value)
    )
  ) {
    return '--';
  }

  return Number(value).toFixed(
    digits
  );
}

function formatPercent(
  value
) {
  if (
    value == null ||
    !Number.isFinite(
      Number(value)
    )
  ) {
    return '--';
  }

  return `${Number(value)}%`;
}

function formatDate(
  value
) {
  if (!value) return '--';

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '--';
  }

  return date
    .toISOString()
    .replace('T', ' ')
    .replace('.000Z', ' UTC');
}

/* =========================================================
   SIGNAL COLOR
========================================================= */

function applySignalClass(
  element,
  signal
) {
  if (!element) return;

  element.classList.remove(
    'call',
    'put',
    'no-trade',
    'CALL',
    'PUT',
    'NO-TRADE'
  );

  if (signal === 'CALL') {
    element.classList.add(
      'call',
      'CALL'
    );
  } else if (
    signal === 'PUT'
  ) {
    element.classList.add(
      'put',
      'PUT'
    );
  } else {
    element.classList.add(
      'no-trade',
      'NO-TRADE'
    );
  }
}

/* =========================================================
   FETCH
========================================================= */

async function fetchBest() {
  if (requestRunning) {
    return;
  }

  requestRunning = true;

  try {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        20000
      );

    const response =
      await fetch(
        `${BEST_ENDPOINT}?_=${Date.now()}`,
        {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            Accept:
              'application/json'
          }
        }
      );

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data ||
      data.ok !== true
    ) {
      throw new Error(
        'Invalid backend response'
      );
    }

    if (
      !data.selectedMarket
    ) {
      throw new Error(
        'selectedMarket missing'
      );
    }

    lastResponse = data;

    /*
     Single source of truth.
    */
    window.__POAI_LAST_RESPONSE =
      data;

    renderResponse(data);

  } catch (error) {
    console.error(
      'PO AI Predictor:',
      error
    );

    showStatus(
      'Backend temporarily unavailable — keeping last valid result'
    );
  } finally {
    requestRunning = false;
  }
}

/* =========================================================
   STATUS
========================================================= */

function showStatus(
  message
) {
  const status =
    findElement(
      'status',
      'statusText',
      'connectionStatus',
      'marketStatus'
    );

  setText(
    status,
    message
  );
}

/* =========================================================
   RENDER
========================================================= */

function renderResponse(
  data
) {
  const market =
    data.selectedMarket;

  if (!market) {
    return;
  }

  renderMarket(
    market
  );

  renderIndicators(
    market
  );

  renderScores(
    market
  );

  renderMeta(
    data
  );

  renderCandidates(
    data.rankedCandidates
  );

  if (
    market.signal ===
    'NO TRADE'
  ) {
    showStatus(
      market.freshness &&
      market.freshness.status !==
        'FRESH'
        ? `LIVE DATA — ${market.freshness.status}`
        : 'LIVE DATA CONNECTED'
    );
  } else {
    showStatus(
      'LIVE DATA CONNECTED'
    );
  }

  startCountdown(
    market
  );
}

/* =========================================================
   MARKET
========================================================= */

function renderMarket(
  market
) {
  const pair =
    findElement(
      'pair',
      'currencyPair',
      'selectedPair',
      'pairValue'
    );

  const timeframe =
    findElement(
      'timeframe',
      'selectedTimeframe',
      'expiry',
      'timeframeValue'
    );

  const signal =
    findElement(
      'signal',
      'signalValue',
      'prediction',
      'tradeSignal'
    );

  const confidence =
    findElement(
      'confidence',
      'confidenceValue'
    );

  const currentPrice =
    findElement(
      'currentPrice',
      'price',
      'currentPriceValue'
    );

  const entryPrice =
    findElement(
      'entryPrice',
      'entryPriceValue'
    );

  const entryTime =
    findElement(
      'entryTime',
      'entryTimeValue'
    );

  const expiryTime =
    findElement(
      'expiryTime',
      'expiryTimeValue'
    );

  const freshness =
    findElement(
      'freshness',
      'freshnessValue'
    );

  const age =
    findElement(
      'dataAge',
      'dataAgeValue',
      'dataAgeSeconds'
    );

  setText(
    pair,
    market.pair || '--'
  );

  setText(
    timeframe,
    market.timeframe
      ? `${market.timeframe} MIN`
      : '--'
  );

  setText(
    signal,
    market.signal || 'NO TRADE'
  );

  setText(
    confidence,
    formatPercent(
      market.confidence
    )
  );

  setText(
    currentPrice,
    formatNumber(
      market.currentPrice,
      5
    )
  );

  setText(
    entryPrice,
    formatNumber(
      market.entryPrice,
      5
    )
  );

  setText(
    entryTime,
    formatDate(
      market.entryTime
    )
  );

  setText(
    expiryTime,
    formatDate(
      market.expiryTime
    )
  );

  setText(
    freshness,
    market.freshness
      ? market.freshness.status
      : '--'
  );

  setText(
    age,
    market.dataAgeSeconds ==
      null
      ? '--'
      : `${market.dataAgeSeconds}s`
  );

  applySignalClass(
    signal,
    market.signal
  );
}

/* =========================================================
   INDICATORS
========================================================= */

function renderIndicators(
  market
) {
  const i =
    market.indicators ||
    {};

  setText(
    findElement(
      'ema9',
      'ema9Value'
    ),
    formatNumber(
      i.ema9,
      6
    )
  );

  setText(
    findElement(
      'ema21',
      'ema21Value'
    ),
    formatNumber(
      i.ema21,
      6
    )
  );

  setText(
    findElement(
      'rsi14',
      'rsiValue',
      'rsi14Value'
    ),
    formatNumber(
      i.rsi14,
      2
    )
  );

  setText(
    findElement(
      'adx14',
      'adxValue',
      'adx14Value'
    ),
    formatNumber(
      i.adx14,
      2
    )
  );

  setText(
    findElement(
      'stochastic14',
      'stochasticValue',
      'stochValue'
    ),
    formatNumber(
      i.stochastic14,
      2
    )
  );

  setText(
    findElement(
      'atr14',
      'atrValue',
      'atr14Value'
    ),
    formatNumber(
      i.atr14,
      6
    )
  );

  const bb =
    i.bollinger ||
    {};

  setText(
    findElement(
      'bollingerUpper',
      'bbUpper'
    ),
    formatNumber(
      bb.upper,
      6
    )
  );

  setText(
    findElement(
      'bollingerMiddle',
      'bbMiddle'
    ),
    formatNumber(
      bb.middle,
      6
    )
  );

  setText(
    findElement(
      'bollingerLower',
      'bbLower'
    ),
    formatNumber(
      bb.lower,
      6
    )
  );
}

/* =========================================================
   SCORES
========================================================= */

function renderScores(
  market
) {
  setText(
    findElement(
      'callScore',
      'callScoreValue'
    ),
    market.callScore
  );

  setText(
    findElement(
      'putScore',
      'putScoreValue'
    ),
    market.putScore
  );

  setText(
    findElement(
      'gap',
      'gapValue'
    ),
    market.gap
  );

  setText(
    findElement(
      'volatility',
      'volatilityValue'
    ),
    market.volatility
  );

  setText(
    findElement(
      'lastCandle',
      'lastCandleValue'
    ),
    formatDate(
      market.lastCandle
    )
  );

  const reasons =
    findElement(
      'reasons',
      'reasonList',
      'signalReasons'
    );

  if (reasons) {
    reasons.innerHTML = '';

    const list =
      Array.isArray(
        market.reasons
      )
        ? market.reasons
        : [];

    for (const reason of list) {
      const item =
        document.createElement(
          'div'
        );

      item.textContent =
        `• ${reason}`;

      reasons.appendChild(
        item
      );
    }
  }

  const pattern =
    market.priceAction || {};

  setText(
    findElement(
      'priceAction',
      'priceActionValue'
    ),
    pattern.pattern
  );

  const psychology =
    market.marketPsychology ||
    {};

  setText(
    findElement(
      'marketPsychology',
      'psychologyValue'
    ),
    psychology.label
  );

  const sr =
    market.supportResistance ||
    {};

  setText(
    findElement(
      'support',
      'supportValue'
    ),
    formatNumber(
      sr.support,
      6
    )
  );

  setText(
    findElement(
      'resistance',
      'resistanceValue'
    ),
    formatNumber(
      sr.resistance,
      6
    )
  );
}

/* =========================================================
   METADATA
========================================================= */

function renderMeta(
  data
) {
  const metadata =
    data.metadata ||
    {};

  const scanner =
    data.scanner ||
    {};

  setText(
    findElement(
      'provider',
      'providerValue'
    ),
    metadata.provider
  );

  setText(
    findElement(
      'providerRequests',
      'providerRequestsValue'
    ),
    metadata.providerRequestsThisMinute
  );

  setText(
    findElement(
      'dailyCreditsUsed',
      'dailyCreditsUsedValue'
    ),
    metadata.dailyCreditsUsed
  );

  setText(
    findElement(
      'dailyCreditsRemaining',
      'dailyCreditsRemainingValue'
    ),
    metadata.dailyCreditsRemaining
  );

  setText(
    findElement(
      'cachedPairs',
      'cachedPairsValue'
    ),
    scanner.cachedPairs
  );

  setText(
    findElement(
      'candidateCount',
      'candidateCountValue'
    ),
    scanner.candidateCount
  );

  setText(
    findElement(
      'scannerStatus',
      'scannerStatusValue'
    ),
    scanner.scanRunning
      ? 'SCANNING'
      : 'IDLE'
  );

  setText(
    findElement(
      'lastScanAt',
      'lastScanAtValue'
    ),
    formatDate(
      scanner.lastScanAt
    )
  );
}

/* =========================================================
   RANKED CANDIDATES
========================================================= */

function renderCandidates(
  candidates
) {
  const container =
    findElement(
      'rankedCandidates',
      'candidateList',
      'signalsList'
    );

  if (!container) {
    return;
  }

  container.innerHTML = '';

  if (
    !Array.isArray(
      candidates
    ) ||
    candidates.length === 0
  ) {
    const empty =
      document.createElement(
        'div'
      );

    empty.textContent =
      'No sufficiently fresh signal available';

    container.appendChild(
      empty
    );

    return;
  }

  for (
    const candidate
    of candidates
  ) {
    const row =
      document.createElement(
        'div'
      );

    row.className =
      'candidate-row';

    row.textContent =
      `#${candidate.rank} ` +
      `${candidate.pair} ` +
      `${candidate.timeframe}m ` +
      `${candidate.signal} ` +
      `${candidate.confidence}%`;

    container.appendChild(
      row
    );
  }
}

/* =========================================================
   COUNTDOWN
========================================================= */

function startCountdown(
  market
) {
  if (countdownTimer) {
    clearInterval(
      countdownTimer
    );
  }

  const countdown =
    findElement(
      'countdown',
      'entryCountdown',
      'countdownValue'
    );

  if (!countdown) {
    return;
  }

  function update() {
    if (
      !market.entryTime
    ) {
      setText(
        countdown,
        '--'
      );
      return;
    }

    const entry =
      new Date(
        market.entryTime
      ).getTime();

    const remaining =
      Math.max(
        0,
        Math.floor(
          (
            entry -
            Date.now()
          ) / 1000
        )
      );

    if (
      market.signal ===
      'NO TRADE'
    ) {
      setText(
        countdown,
        '--'
      );
      return;
    }

    setText(
      countdown,
      `${remaining}s`
    );

    /*
     Automatically refresh when entry
     moment has passed.
    */
    if (
      remaining <= 0
    ) {
      fetchBest();
    }
  }

  update();

  countdownTimer =
    setInterval(
      update,
      1000
    );
}

/* =========================================================
   MANUAL ANALYZE
========================================================= */

async function analyzeMarket() {
  /*
   IMPORTANT:
   No local signal calculation.
   Just request the single backend response.
  */
  await fetchBest();
}

/* =========================================================
   HEALTH
========================================================= */

async function checkHealth() {
  try {
    const response =
      await fetch(
        `${API_BASE}/api/health?_=${Date.now()}`,
        {
          cache: 'no-store'
        }
      );

    const data =
      await response.json();

    window.__POAI_HEALTH =
      data;

    return data;
  } catch (error) {
    console.error(
      'Health check failed:',
      error
    );

    return null;
  }
}

/* =========================================================
   PUBLIC API
========================================================= */

window.POAI = {
  analyzeMarket,
  fetchBest,
  checkHealth,

  getLastResponse:
    () =>
      window.__POAI_LAST_RESPONSE ||
      null
};

/* =========================================================
   START
========================================================= */

document.addEventListener(
  'DOMContentLoaded',
  () => {
    const button =
      findElement(
        'analyzeBtn',
        'analyzeButton',
        'analyzeMarket',
        'analyze-market'
      );

    if (button) {
      button.addEventListener(
        'click',
        analyzeMarket
      );
    }

    /*
     Initial request
    */
    fetchBest();

    /*
     Refresh every 15 seconds.
    */
    setInterval(
      () => {
        fetchBest();
      },
      REFRESH_MS
    );
  }
);
