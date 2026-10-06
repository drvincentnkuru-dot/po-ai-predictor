'use strict';

/*
===========================================================
 PO AI PREDICTOR
 FRONTEND V9.0 FINAL
===========================================================

BACKEND:
https://po-ai-predictor-api.onrender.com

MAIN API:
GET /api/best

IMPORTANT:
Frontend uses ONLY:
response.selectedMarket

No old V8 signal logic.
No separate pair calculation.
No separate confidence calculation.
No separate CALL/PUT decision.

Backend is the single source of truth.
===========================================================
*/

const API_BASE =
  'https://po-ai-predictor-api.onrender.com';

const BEST_ENDPOINT =
  `${API_BASE}/api/best`;

const HEALTH_ENDPOINT =
  `${API_BASE}/api/health`;

const REFRESH_MS = 15000;
const FETCH_TIMEOUT_MS = 20000;

let currentMarket = null;
let refreshTimer = null;
let countdownTimer = null;
let requestInProgress = false;


/* =========================================================
   DOM HELPERS
========================================================= */

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = $(id);
  if (!el) return;

  el.textContent =
    value === undefined ||
    value === null ||
    value === ''
      ? '—'
      : String(value);
}


/* =========================================================
   NUMBER FORMATTERS
========================================================= */

function formatNumber(value, decimals = 5) {
  if (value === undefined || value === null || value === '') {
    return '—';
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return '—';
  }

  return n.toFixed(decimals);
}


function formatPercent(value) {
  if (value === undefined || value === null) {
    return '—';
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return '—';
  }

  return `${Math.round(n)}%`;
}


/* =========================================================
   TIME FORMATTERS
========================================================= */

function formatUTC(iso) {
  if (!iso) return '—';

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');

  return `${hh}:${mm}:${ss} UTC`;
}


function calculateEntrySeconds(entryTime) {
  if (!entryTime) return null;

  const target = new Date(entryTime).getTime();

  if (!Number.isFinite(target)) {
    return null;
  }

  return Math.max(
    0,
    Math.ceil((target - Date.now()) / 1000)
  );
}


/* =========================================================
   STATUS UI
========================================================= */

function setBackendStatus(text, state = '') {
  const el = $('backendStatus');

  if (!el) return;

  el.textContent = text;

  el.classList.remove(
    'online',
    'offline',
    'loading',
    'error'
  );

  if (state) {
    el.classList.add(state);
  }
}


function showError(message) {
  const box = $('errorBox');

  if (!box) return;

  box.textContent = message || 'Unable to load live market data.';
  box.classList.remove('hidden');
}


function hideError() {
  const box = $('errorBox');

  if (!box) return;

  box.textContent = '';
  box.classList.add('hidden');
}


/* =========================================================
   SIGNAL BADGE
========================================================= */

function updateSignal(signal) {
  const badge = $('signalBadge');
  const trend = $('trendBadge');

  if (!badge) return;

  const value =
    String(signal || 'NO TRADE')
      .trim()
      .toUpperCase();

  badge.classList.remove(
    'call',
    'put',
    'no-trade'
  );

  if (value === 'CALL') {
    badge.textContent = 'CALL';
    badge.classList.add('call');

    if (trend) {
      trend.textContent = 'BULLISH';
    }

    return;
  }

  if (value === 'PUT') {
    badge.textContent = 'PUT';
    badge.classList.add('put');

    if (trend) {
      trend.textContent = 'BEARISH';
    }

    return;
  }

  badge.textContent = 'NO TRADE';
  badge.classList.add('no-trade');

  if (trend) {
    trend.textContent = 'WAIT';
  }
}


/* =========================================================
   MARKET RENDER
========================================================= */

function renderMarket(market) {
  if (!market) {
    return;
  }

  currentMarket = market;

  /*
  ---------------------------------------------------------
  CORE MARKET
  ---------------------------------------------------------
  */

  setText(
    'selectedPair',
    market.pair || '—'
  );

  setText(
    'timeframe',
    market.timeframe
      ? `${market.timeframe} min`
      : '—'
  );

  setText(
    'confidence',
    formatPercent(market.confidence)
  );

  setText(
    'entryTime',
    formatUTC(market.entryTime)
  );

  setText(
    'expiryTime',
    formatUTC(market.expiryTime)
  );

  setText(
    'entryPrice',
    formatNumber(market.currentPrice, 5)
  );


  /*
  ---------------------------------------------------------
  SIGNAL
  ---------------------------------------------------------
  */

  updateSignal(market.signal);


  /*
  ---------------------------------------------------------
  SCORES
  ---------------------------------------------------------
  */

  const score = market.score || {};

  setText(
    'callScore',
    score.call !== undefined
      ? score.call
      : '—'
  );

  setText(
    'putScore',
    score.put !== undefined
      ? score.put
      : '—'
  );


  /*
  ---------------------------------------------------------
  INDICATORS
  ---------------------------------------------------------
  */

  const indicators =
    market.indicators || {};

  setText(
    'ema9',
    formatNumber(indicators.ema9, 5)
  );

  setText(
    'ema21',
    formatNumber(indicators.ema21, 5)
  );

  setText(
    'rsi',
    formatNumber(indicators.rsi14, 2)
  );

  setText(
    'adx',
    formatNumber(indicators.adx14, 2)
  );

  setText(
    'stochastic',
    formatNumber(indicators.stochastic14, 2)
  );

  setText(
    'atr',
    formatNumber(indicators.atr14, 6)
  );

  setText(
    'support',
    formatNumber(indicators.support, 5)
  );

  setText(
    'resistance',
    formatNumber(indicators.resistance, 5)
  );


  /*
  ---------------------------------------------------------
  PRICE ACTION
  ---------------------------------------------------------
  */

  const priceAction =
    market.priceAction || {};

  const pattern =
    priceAction.pattern || 'NEUTRAL';

  const direction =
    priceAction.direction || 'NEUTRAL';

  const strength =
    priceAction.strength !== undefined
      ? priceAction.strength
      : 0;

  setText(
    'priceAction',
    `${pattern} • ${direction} • strength ${strength}`
  );


  /*
  ---------------------------------------------------------
  MARKET PSYCHOLOGY
  ---------------------------------------------------------
  */

  const psychology =
    market.marketPsychology || {};

  const psychologyLabel =
    psychology.label || 'NEUTRAL';

  const psychologyDirection =
    psychology.direction || 'NEUTRAL';

  const psychologyScore =
    psychology.score !== undefined
      ? psychology.score
      : 0;

  setText(
    'psychology',
    `${psychologyLabel} • ${psychologyDirection} • score ${psychologyScore}`
  );


  /*
  ---------------------------------------------------------
  QUALITY
  ---------------------------------------------------------
  */

  const quality =
    market.quality || {};

  const volatility =
    quality.volatility || '—';

  const nearSupport =
    quality.nearSupport === true
      ? 'Near support'
      : 'Not near support';

  const nearResistance =
    quality.nearResistance === true
      ? 'Near resistance'
      : 'Not near resistance';


  /*
  ---------------------------------------------------------
  REASONS
  ---------------------------------------------------------
  */

  const reasons = [];

  if (
    Number.isFinite(Number(indicators.ema9)) &&
    Number.isFinite(Number(indicators.ema21))
  ) {
    if (
      Number(indicators.ema9) >
      Number(indicators.ema21)
    ) {
      reasons.push('EMA bullish');
    } else if (
      Number(indicators.ema9) <
      Number(indicators.ema21)
    ) {
      reasons.push('EMA bearish');
    }
  }

  if (Number.isFinite(Number(indicators.rsi14))) {
    if (Number(indicators.rsi14) >= 50) {
      reasons.push('RSI bullish');
    } else {
      reasons.push('RSI bearish');
    }
  }

  if (Number.isFinite(Number(indicators.adx14))) {
    if (Number(indicators.adx14) >= 25) {
      reasons.push('Strong trend');
    } else {
      reasons.push('Moderate trend');
    }
  }

  if (pattern !== 'NEUTRAL') {
    reasons.push(pattern);
  }

  if (psychologyLabel !== 'NEUTRAL') {
    reasons.push(psychologyLabel);
  }

  if (volatility !== '—') {
    reasons.push(`Volatility ${volatility}`);
  }

  if (nearSupport === 'Near support') {
    reasons.push('Near support');
  }

  if (nearResistance === 'Near resistance') {
    reasons.push('Near resistance');
  }

  setText(
    'reasons',
    reasons.length
      ? reasons.join(' • ')
      : 'No additional confirmation'
  );


  /*
  ---------------------------------------------------------
  DATA AGE
  ---------------------------------------------------------
  */

  if (market.lastCandle) {
    const candleTime =
      new Date(market.lastCandle).getTime();

    if (Number.isFinite(candleTime)) {
      const ageSeconds =
        Math.max(
          0,
          Math.floor(
            (Date.now() - candleTime) / 1000
          )
        );

      setText(
        'dataAge',
        `Candle ${ageSeconds}s ago`
      );
    }
  }


  /*
  ---------------------------------------------------------
  ENTRY COUNTDOWN
  ---------------------------------------------------------
  */

  updateCountdown();


  /*
  ---------------------------------------------------------
  SCANNER INFO
  ---------------------------------------------------------
  */

  const candidateCount =
    window.__POAI_LAST_RESPONSE &&
    window.__POAI_LAST_RESPONSE.candidateCount;

  if (candidateCount !== undefined) {
    setText(
      'scanInfo',
      `${candidateCount} live candidates`
    );
  } else {
    setText(
      'scanInfo',
      'LIVE DATA'
    );
  }


  hideError();

  setBackendStatus(
    `LIVE • ${market.pair}`,
    'online'
  );
}


/* =========================================================
   COUNTDOWN
========================================================= */

function updateCountdown() {
  if (!currentMarket) {
    setText('countdown', '—');
    return;
  }

  let seconds =
    calculateEntrySeconds(
      currentMarket.entryTime
    );

  if (seconds === null) {
    seconds =
      Number(currentMarket.entryInSeconds);
  }

  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(Number(seconds))
  ) {
    setText('countdown', '—');
    return;
  }

  seconds = Math.max(
    0,
    Math.ceil(Number(seconds))
  );

  setText(
    'countdown',
    `${seconds}s`
  );
}


function startCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
  }

  updateCountdown();

  countdownTimer =
    setInterval(
      updateCountdown,
      1000
    );
}


/* =========================================================
   FETCH JSON
========================================================= */

async function fetchJSON(url) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        url,
        {
          method: 'GET',
          cache: 'no-store',
          headers: {
            'Accept': 'application/json'
          },
          signal: controller.signal
        }
      );

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Backend returned invalid JSON (${response.status})`
      );
    }

    if (!response.ok) {
      throw new Error(
        data && data.error
          ? data.error
          : `HTTP ${response.status}`
      );
    }

    return data;

  } finally {
    clearTimeout(timeout);
  }
}


/* =========================================================
   HEALTH CHECK
========================================================= */

async function checkBackend() {
  try {
    const data =
      await fetchJSON(
        `${HEALTH_ENDPOINT}?t=${Date.now()}`
      );

    if (
      data &&
      data.ok === true
    ) {
      setBackendStatus(
        'LIVE DATA CONNECTED',
        'online'
      );

      return true;
    }

    return false;

  } catch (error) {

    setBackendStatus(
      'BACKEND OFFLINE',
      'offline'
    );

    return false;
  }
}


/* =========================================================
   MAIN ANALYZE FUNCTION
========================================================= */

async function analyzeMarket() {

  if (requestInProgress) {
    return;
  }

  requestInProgress = true;

  const button =
    $('analyzeBtn');

  if (button) {
    button.disabled = true;
    button.textContent = 'ANALYZING...';
  }

  setBackendStatus(
    'CONNECTING',
    'loading'
  );

  try {

    /*
    =======================================================
    ONLY ONE MARKET ENDPOINT
    =======================================================
    */

    const data =
      await fetchJSON(
        `${BEST_ENDPOINT}?t=${Date.now()}`
      );


    /*
    =======================================================
    RESPONSE VALIDATION
    =======================================================
    */

    if (
      !data ||
      data.ok !== true
    ) {
      throw new Error(
        'Backend did not return ok:true.'
      );
    }

    if (
      !data.selectedMarket
    ) {
      throw new Error(
        'Backend returned no selected market.'
      );
    }


    /*
    =======================================================
    SAVE COMPLETE RESPONSE
    =======================================================
    */

    window.__POAI_LAST_RESPONSE =
      data;


    /*
    =======================================================
    RENDER EXACT BACKEND MARKET
    =======================================================
    */

    renderMarket(
      data.selectedMarket
    );


    /*
    =======================================================
    UPDATE SCANNER
    =======================================================
    */

    const scanner =
      $('scanner');

    if (scanner) {

      const market =
        data.selectedMarket;

      const signal =
        String(
          market.signal || 'NO TRADE'
        ).toUpperCase();

      scanner.innerHTML = `
        <div class="scanner-row">
          <span>${escapeHTML(market.pair || '—')}</span>
          <span>${escapeHTML(
            market.timeframe
              ? `${market.timeframe} min`
              : '—'
          )}</span>
          <span class="scanner-signal ${signal.toLowerCase()}">
            ${escapeHTML(signal)}
          </span>
          <span>
            ${escapeHTML(
              formatPercent(market.confidence)
            )}
          </span>
        </div>
      `;
    }


  } catch (error) {

    console.error(
      'PO AI Predictor:',
      error
    );

    showError(
      error && error.message
        ? error.message
        : 'Unable to load live market data.'
    );

    /*
    IMPORTANT:
    Do NOT replace a valid existing signal
    with fake NO TRADE data.
    */

    if (currentMarket) {
      setBackendStatus(
        `LAST LIVE • ${currentMarket.pair}`,
        'online'
      );
    } else {
      setBackendStatus(
        'DATA ERROR',
        'error'
      );
    }

  } finally {

    requestInProgress = false;

    if (button) {
      button.disabled = false;
      button.textContent = 'ANALYZE MARKET';
    }
  }
}


/* =========================================================
   HTML ESCAPE
========================================================= */

function escapeHTML(value) {

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


/* =========================================================
   AUTO REFRESH
========================================================= */

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


/* =========================================================
   BUTTON
========================================================= */

function bindAnalyzeButton() {

  const button =
    $('analyzeBtn');

  if (!button) {
    console.error(
      'ANALYZE button not found.'
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


/* =========================================================
   INITIALIZATION
========================================================= */

async function init() {

  bindAnalyzeButton();

  startCountdown();

  /*
  Health check is informational.
  /api/best remains the ONLY source
  for the displayed signal.
  */

  await checkBackend();

  await analyzeMarket();

  startAutoRefresh();
}


/* =========================================================
   PUBLIC API
========================================================= */

window.POAI = {

  analyzeMarket,

  checkBackend,

  getCurrentMarket: () =>
    currentMarket,

  getLastResponse: () =>
    window.__POAI_LAST_RESPONSE || null
};


/* =========================================================
   START
========================================================= */

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
