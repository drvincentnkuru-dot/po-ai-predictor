'use strict';

/*
============================================================
 PO AI PREDICTOR
 V9.1 • SYNCHRONIZED FRONTEND

 Backend:
 https://po-ai-predictor-api.onrender.com

 IMPORTANT:
 - Frontend does NOT calculate signals.
 - Backend is the single signal engine.
 - All displayed values come from ONE API response.
============================================================
*/

const API_BASE =
  'https://po-ai-predictor-api.onrender.com';

const BEST_ENDPOINT =
  `${API_BASE}/api/best`;

const HEALTH_ENDPOINT =
  `${API_BASE}/api/health`;

const REFRESH_MS = 15000;
const REQUEST_TIMEOUT_MS = 25000;

let requestRunning = false;
let lastResponse = null;
let countdownTimer = null;
let refreshTimer = null;

/* =========================================================
   DOM
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
  ids,
  value = '—'
) {
  const list =
    Array.isArray(ids)
      ? ids
      : [ids];

  const element =
    findElement(...list);

  if (element) {
    element.textContent =
      value === null ||
      value === undefined ||
      value === ''
        ? '—'
        : String(value);
  }
}

function formatNumber(
  value,
  decimals = 5
) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return '—';
  }

  return n.toFixed(decimals);
}

function formatPercent(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return '—';
  }

  return `${Math.round(n)}%`;
}

function formatDate(value) {
  if (!value) {
    return '—';
  }

  const date =
    new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return date.toISOString()
    .replace('T', ' ')
    .replace('.000Z', ' UTC');
}

function formatAge(seconds) {
  const n = Number(seconds);

  if (!Number.isFinite(n)) {
    return '—';
  }

  if (n < 60) {
    return `${Math.max(0, Math.floor(n))}s`;
  }

  const minutes =
    Math.floor(n / 60);

  const remainder =
    Math.floor(n % 60);

  return `${minutes}m ${remainder}s`;
}

function formatTimeframe(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return '—';
  }

  return `${n} MIN`;
}

/* =========================================================
   SIGNAL STYLING
========================================================= */

function applySignalClass(signal) {
  const badge =
    findElement(
      'signalBadge'
    );

  const card =
    findElement(
      'signalCard'
    );

  if (badge) {
    badge.classList.remove(
      'call',
      'put',
      'no-trade'
    );

    if (signal === 'CALL') {
      badge.classList.add('call');
    } else if (signal === 'PUT') {
      badge.classList.add('put');
    } else {
      badge.classList.add('no-trade');
    }
  }

  if (card) {
    card.classList.remove(
      'signal-call',
      'signal-put',
      'signal-no-trade'
    );

    if (signal === 'CALL') {
      card.classList.add(
        'signal-call'
      );
    } else if (signal === 'PUT') {
      card.classList.add(
        'signal-put'
      );
    } else {
      card.classList.add(
        'signal-no-trade'
      );
    }
  }
}

/* =========================================================
   STATUS
========================================================= */

function setBackendStatus(
  text,
  connected = false
) {
  setText(
    'backendStatus',
    text
  );

  const status =
    document.querySelector(
      '.status-pill'
    );

  if (status) {
    status.classList.toggle(
      'connected',
      connected
    );
  }
}

function showError(message) {
  const box =
    findElement(
      'errorBox'
    );

  if (!box) {
    return;
  }

  box.textContent =
    message || 'Unknown error';

  box.classList.remove(
    'hidden'
  );
}

function hideError() {
  const box =
    findElement(
      'errorBox'
    );

  if (box) {
    box.textContent = '';
    box.classList.add(
      'hidden'
    );
  }
}

/* =========================================================
   API REQUEST
========================================================= */

async function fetchJson(
  url,
  timeoutMs = REQUEST_TIMEOUT_MS
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
        `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`,
        {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            Accept: 'application/json'
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

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   MAIN REQUEST
========================================================= */

async function fetchBest() {
  if (requestRunning) {
    return lastResponse;
  }

  requestRunning = true;

  try {
    setBackendStatus(
      'ANALYZING',
      false
    );

    const data =
      await fetchJson(
        BEST_ENDPOINT
      );

    if (
      !data ||
      data.ok !== true ||
      !data.selectedMarket
    ) {
      throw new Error(
        'Invalid backend response'
      );
    }

    lastResponse = data;

    window.__POAI_LAST_RESPONSE =
      data;

    hideError();

    renderResponse(data);

    setBackendStatus(
      'LIVE CONNECTED',
      true
    );

    return data;
  } catch (error) {
    console.error(
      'PO AI request error:',
      error
    );

    setBackendStatus(
      'BACKEND ERROR',
      false
    );

    showError(
      'Backend temporarily unavailable. Keeping the last valid market result.'
    );

    return lastResponse;
  } finally {
    requestRunning = false;
  }
}

/* =========================================================
   RESPONSE RENDER
========================================================= */

function renderResponse(data) {
  const market =
    data.selectedMarket || {};

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
    data.rankedCandidates || []
  );

  updateSignalStatus(
    market
  );

  startCountdown(
    market
  );
}

/* =========================================================
   MARKET
========================================================= */

function renderMarket(market) {
  const signal =
    market.signal || 'NO TRADE';

  const pair =
    market.pair || 'NO MARKET';

  setText(
    'selectedPair',
    pair
  );

  const badge =
    findElement(
      'signalBadge'
    );

  if (badge) {
    badge.textContent =
      signal;
  }

  setText(
    'trendBadge',
    signal === 'CALL'
      ? 'BULLISH'
      : signal === 'PUT'
        ? 'BEARISH'
        : 'WAIT'
  );

  setText(
    'confidence',
    formatPercent(
      market.confidence
    )
  );

  setText(
    'timeframe',
    formatTimeframe(
      market.timeframe
    )
  );

  setText(
    'entryTime',
    formatDate(
      market.entryTime
    )
  );

  setText(
    'expiryTime',
    formatDate(
      market.expiryTime
    )
  );

  setText(
    'entryPrice',
    formatNumber(
      market.entryPrice ??
      market.currentPrice,
      5
    )
  );

  setText(
    'currentPrice',
    formatNumber(
      market.currentPrice,
      5
    )
  );

  setText(
    'freshness',
    market.freshness ||
      '—'
  );

  setText(
    'dataAge',
    market.dataAgeSeconds !== null &&
    market.dataAgeSeconds !== undefined
      ? `DATA AGE ${formatAge(market.dataAgeSeconds)}`
      : 'DATA AGE —'
  );

  applySignalClass(
    signal
  );
}

/* =========================================================
   INDICATORS
========================================================= */

function renderIndicators(market) {
  const indicators =
    market.indicators || {};

  setText(
    'ema9',
    formatNumber(
      indicators.ema9,
      5
    )
  );

  setText(
    'ema21',
    formatNumber(
      indicators.ema21,
      5
    )
  );

  setText(
    'rsi',
    formatNumber(
      indicators.rsi14,
      2
    )
  );

  setText(
    'adx',
    formatNumber(
      indicators.adx14,
      2
    )
  );

  setText(
    'stochastic',
    formatNumber(
      indicators.stochastic14,
      2
    )
  );

  setText(
    'atr',
    formatNumber(
      indicators.atr14,
      5
    )
  );

  const bb =
    indicators.bollinger;

  setText(
    'bollingerUpper',
    formatNumber(
      bb?.upper,
      5
    )
  );

  setText(
    'bollingerMiddle',
    formatNumber(
      bb?.middle,
      5
    )
  );

  setText(
    'bollingerLower',
    formatNumber(
      bb?.lower,
      5
    )
  );

  setText(
    'psychology',
    market.marketPsychology ||
      '—'
  );

  setText(
    'priceAction',
    market.priceAction ||
      '—'
  );

  setText(
    'reasons',
    Array.isArray(
      market.reasons
    )
      ? market.reasons.join(' • ')
      : market.reasons || '—'
  );
}

/* =========================================================
   SCORES
========================================================= */

function renderScores(market) {
  setText(
    'callScore',
    Number.isFinite(
      Number(market.callScore)
    )
      ? Math.round(
          Number(market.callScore)
        )
      : '—'
  );

  setText(
    'putScore',
    Number.isFinite(
      Number(market.putScore)
    )
      ? Math.round(
          Number(market.putScore)
        )
      : '—'
  );

  setText(
    'gap',
    Number.isFinite(
      Number(market.gap)
    )
      ? Math.round(
          Number(market.gap)
        )
      : '—'
  );

  setText(
    'volatility',
    market.volatility ||
      '—'
  );

  const sr =
    market.supportResistance ||
    {};

  setText(
    'support',
    formatNumber(
      sr.support,
      5
    )
  );

  setText(
    'resistance',
    formatNumber(
      sr.resistance,
      5
    )
  );

  setText(
    'lastCandle',
    formatDate(
      market.lastCandle
    )
  );
}

/* =========================================================
   METADATA
========================================================= */

function renderMeta(data) {
  const metadata =
    data.metadata || {};

  const scanner =
    data.scanner || {};

  setText(
    'provider',
    metadata.provider ||
      data.source ||
      '—'
  );

  setText(
    'providerRequests',
    metadata.providerRequests ??
      '—'
  );

  setText(
    'dailyCreditsUsed',
    metadata.dailyCreditsUsed ??
      '—'
  );

  setText(
    'dailyCreditsRemaining',
    metadata.dailyCreditsRemaining ??
      '—'
  );

  setText(
    'cachedPairs',
    metadata.cachedPairs ??
      '—'
  );

  setText(
    'candidateCount',
    Array.isArray(
      data.rankedCandidates
    )
      ? data.rankedCandidates.length
      : 0
  );

  setText(
    'scannerStatus',
    scanner.running
      ? 'RUNNING'
      : 'READY'
  );

  setText(
    'lastScanAt',
    formatDate(
      scanner.lastScanAt
    )
  );

  setText(
    'scanInfo',
    scanner.running
      ? `SCANNING • ${scanner.totalScanned || 0} PAIRS`
      : `READY • ${scanner.totalScanned || 0} SCANNED`
  );
}

/* =========================================================
   CANDIDATES
========================================================= */

function renderCandidates(
  candidates
) {
  const container =
    findElement(
      'scanner'
    );

  if (!container) {
    return;
  }

  container.innerHTML = '';

  if (!candidates.length) {
    const empty =
      document.createElement(
        'div'
      );

    empty.className =
      'scanner-empty';

    empty.textContent =
      'No fresh executable signal currently available.';

    container.appendChild(
      empty
    );

    return;
  }

  candidates.forEach(
    candidate => {
      const row =
        document.createElement(
          'div'
        );

      row.className =
        'scanner-row';

      const signal =
        candidate.signal ||
        'NO TRADE';

      row.innerHTML = `
        <span class="rank">
          #${candidate.rank ?? '—'}
        </span>

        <span class="pair">
          ${candidate.pair || '—'}
        </span>

        <span class="tf">
          ${candidate.timeframe ?? '—'}m
        </span>

        <span class="candidate-signal ${signal.toLowerCase()}">
          ${signal}
        </span>

        <span class="candidate-confidence">
          ${formatPercent(candidate.confidence)}
        </span>
      `;

      container.appendChild(
        row
      );
    }
  );
}

/* =========================================================
   SIGNAL STATUS
========================================================= */

function updateSignalStatus(
  market
) {
  const signal =
    market.signal || 'NO TRADE';

  if (signal === 'CALL') {
    setText(
      'marketStatus',
      'LIVE CALL SETUP'
    );
    return;
  }

  if (signal === 'PUT') {
    setText(
      'marketStatus',
      'LIVE PUT SETUP'
    );
    return;
  }

  setText(
    'marketStatus',
    market.freshness === 'FRESH'
      ? 'LIVE DATA — NO TRADE'
      : `WAITING — ${market.freshness || 'NO DATA'}`
  );
}

/* =========================================================
   COUNTDOWN
========================================================= */

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(
      countdownTimer
    );

    countdownTimer = null;
  }
}

function startCountdown(market) {
  stopCountdown();

  const countdown =
    findElement(
      'countdown'
    );

  if (!countdown) {
    return;
  }

  if (
    market.signal !== 'CALL' &&
    market.signal !== 'PUT'
  ) {
    countdown.textContent =
      '—';

    return;
  }

  if (!market.entryTime) {
    countdown.textContent =
      '—';

    return;
  }

  function update() {
    const entry =
      new Date(
        market.entryTime
      ).getTime();

    if (!Number.isFinite(entry)) {
      countdown.textContent =
        '—';

      return;
    }

    const seconds =
      Math.max(
        0,
        Math.ceil(
          (entry - Date.now()) /
          1000
        )
      );

    if (seconds <= 0) {
      countdown.textContent =
        'ENTERING';

      stopCountdown();

      setTimeout(
        () => fetchBest(),
        1000
      );

      return;
    }

    countdown.textContent =
      `${seconds}s`;
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
  return fetchBest();
}

/* =========================================================
   HEALTH
========================================================= */

async function checkHealth() {
  try {
    const data =
      await fetchJson(
        HEALTH_ENDPOINT
      );

    if (data?.ok) {
      setBackendStatus(
        'LIVE CONNECTED',
        true
      );

      return data;
    }

    throw new Error(
      'Health response invalid'
    );
  } catch (error) {
    console.error(
      'Health error:',
      error
    );

    setBackendStatus(
      'BACKEND ERROR',
      false
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
  getLastResponse: () =>
    lastResponse
};

/* =========================================================
   INITIALIZATION
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
     Initial request.
     Backend now waits for a useful batch on cold start,
     instead of immediately returning an empty "--" market.
    */
    fetchBest();

    refreshTimer =
      setInterval(
        () => {
          fetchBest();
        },
        REFRESH_MS
      );
  }
);
