'use strict';

/*
===========================================================
 PO AI PREDICTOR
 V8.4.1 • SMART LIVE SCANNER FRONTEND
===========================================================

Backend:
https://po-ai-predictor-api.onrender.com

Main flow:

ANALYZE MARKET
      ↓
GET /api/best
      ↓
Backend scans / reads live results
      ↓
Smart ranking
      ↓
SELECTED MARKET
      ↓
CALL / PUT / NO TRADE
      ↓
TIMEFRAME + CONFIDENCE
      ↓
ENTRY + EXPIRY
      ↓
REASONS
===========================================================
*/

const API_URL = 'https://po-ai-predictor-api.onrender.com';

const BEST_URL = `${API_URL}/api/best`;
const HEALTH_URL = `${API_URL}/api/health`;
const SCAN_STATUS_URL = `${API_URL}/api/scan/status`;


/* =========================================================
   DOM
========================================================= */

const el = {
    backendStatus: document.getElementById('backendStatus'),

    analyzeBtn: document.getElementById('analyzeBtn'),

    errorBox: document.getElementById('errorBox'),

    signalCard: document.getElementById('signalCard'),

    selectedPair: document.getElementById('selectedPair'),
    trendBadge: document.getElementById('trendBadge'),
    signalBadge: document.getElementById('signalBadge'),

    confidence: document.getElementById('confidence'),
    timeframe: document.getElementById('timeframe'),

    countdown: document.getElementById('countdown'),

    entryTime: document.getElementById('entryTime'),
    expiryTime: document.getElementById('expiryTime'),
    entryPrice: document.getElementById('entryPrice'),

    callScore: document.getElementById('callScore'),
    putScore: document.getElementById('putScore'),

    support: document.getElementById('support'),
    resistance: document.getElementById('resistance'),

    dataAge: document.getElementById('dataAge'),

    ema9: document.getElementById('ema9'),
    ema21: document.getElementById('ema21'),
    rsi: document.getElementById('rsi'),
    adx: document.getElementById('adx'),

    reasons: document.getElementById('reasons'),

    scanInfo: document.getElementById('scanInfo'),
    scanner: document.getElementById('scanner')
};


/* =========================================================
   STATE
========================================================= */

let currentResult = null;
let countdownTimer = null;
let healthTimer = null;
let scannerTimer = null;

let analyzing = false;


/* =========================================================
   HELPERS
========================================================= */

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}


function safeNumber(value, decimals = 5) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return '—';
    }

    return n.toFixed(decimals);
}


function percent(value) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return '—';
    }

    return `${Math.round(n)}%`;
}


function formatPrice(value, pair = '') {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return '—';
    }

    const normalizedPair = String(pair || '').toUpperCase();

    /*
      JPY pairs normally need 3 decimals.
      Other FX pairs normally use 5 decimals.
    */
    const decimals = normalizedPair.includes('JPY') ? 3 : 5;

    return n.toFixed(decimals);
}


function formatTimeframe(minutes) {
    const n = Number(minutes);

    if (!Number.isFinite(n)) {
        return '—';
    }

    return `${n} MIN`;
}


function formatUTC(value) {
    if (!value) {
        return '—';
    }

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
        return String(value);
    }

    return d.toLocaleString('en-GB', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }) + ' UTC';
}


function shortUTC(value) {
    if (!value) {
        return '—';
    }

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
        return String(value);
    }

    return d.toLocaleTimeString('en-GB', {
        timeZone: 'UTC',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }) + ' UTC';
}


function secondsUntil(value) {
    if (!value) {
        return null;
    }

    const target = new Date(value).getTime();

    if (!Number.isFinite(target)) {
        return null;
    }

    return Math.floor((target - Date.now()) / 1000);
}


function formatCountdown(seconds) {
    if (!Number.isFinite(seconds)) {
        return '—';
    }

    if (seconds <= 0) {
        return 'ENTER NOW';
    }

    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;

    if (min > 0) {
        return `${min}m ${String(sec).padStart(2, '0')}s`;
    }

    return `${sec}s`;
}


function clearCountdown() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
}


function clearError() {
    if (!el.errorBox) {
        return;
    }

    el.errorBox.textContent = '';
    el.errorBox.style.display = 'none';
}


function showError(message) {
    if (!el.errorBox) {
        return;
    }

    el.errorBox.textContent = message;
    el.errorBox.style.display = 'block';
}


function setBackendStatus(text, online = false) {
    if (!el.backendStatus) {
        return;
    }

    el.backendStatus.textContent = text;

    el.backendStatus.classList.toggle('online', online);
    el.backendStatus.classList.toggle('offline', !online);
}


function setLoading(loading) {
    analyzing = loading;

    if (!el.analyzeBtn) {
        return;
    }

    el.analyzeBtn.disabled = loading;

    if (loading) {
        el.analyzeBtn.dataset.originalText =
            el.analyzeBtn.textContent || 'ANALYZE MARKET';

        el.analyzeBtn.textContent = 'SCANNING LIVE MARKET...';
        el.analyzeBtn.classList.add('loading');
    } else {
        el.analyzeBtn.textContent =
            el.analyzeBtn.dataset.originalText || 'ANALYZE MARKET';

        el.analyzeBtn.classList.remove('loading');
    }
}


function showSignalCard(show = true) {
    if (!el.signalCard) {
        return;
    }

    el.signalCard.style.display = show ? '' : 'none';
}


/* =========================================================
   SIGNAL / TREND
========================================================= */

function normalizeSignal(signal) {
    const value = String(signal || '').trim().toUpperCase();

    if (value === 'CALL') {
        return 'CALL';
    }

    if (value === 'PUT') {
        return 'PUT';
    }

    return 'NO TRADE';
}


function normalizeTrend(condition) {
    const value = String(condition || '').trim().toUpperCase();

    switch (value) {
        case 'UPTREND':
            return 'UPTREND';

        case 'DOWNTREND':
            return 'DOWNTREND';

        case 'LOW_VOLATILITY_RANGE':
            return 'LOW VOLATILITY RANGE';

        case 'RANGING':
            return 'RANGING';

        default:
            return value || 'MARKET CONDITION —';
    }
}


function applySignalBadge(signal) {
    if (!el.signalBadge) {
        return;
    }

    const normalized = normalizeSignal(signal);

    el.signalBadge.textContent = normalized;

    el.signalBadge.classList.remove(
        'call',
        'put',
        'no-trade',
        'CALL',
        'PUT',
        'NO-TRADE'
    );

    if (normalized === 'CALL') {
        el.signalBadge.classList.add('call');
    } else if (normalized === 'PUT') {
        el.signalBadge.classList.add('put');
    } else {
        el.signalBadge.classList.add('no-trade');
    }
}


/* =========================================================
   REASON ENGINE
========================================================= */

/*
  Backend V8.4.1 already returns "reasons".

  This function uses backend reasons first.

  If backend reasons are missing, we create a transparent
  fallback explanation from the actual returned indicators.

  IMPORTANT:
  We never invent market data.
*/

function buildFallbackReasons(result) {
    const reasons = [];

    const signal = normalizeSignal(result?.signal);

    const indicators = result?.indicators || {};

    const ema9 = Number(indicators.ema9);
    const ema21 = Number(indicators.ema21);
    const rsi = Number(indicators.rsi14);
    const adx = Number(indicators.adx14);

    const currentPrice = Number(result?.currentPrice);
    const support = Number(indicators.support);
    const resistance = Number(indicators.resistance);

    const callScore = Number(result?.callScore);
    const putScore = Number(result?.putScore);

    if (signal === 'CALL') {
        if (
            Number.isFinite(ema9) &&
            Number.isFinite(ema21) &&
            ema9 > ema21
        ) {
            reasons.push(
                'EMA9 is above EMA21, supporting bullish momentum.'
            );
        }

        if (Number.isFinite(rsi)) {
            if (rsi >= 50 && rsi < 70) {
                reasons.push(
                    `RSI14 is ${rsi.toFixed(1)}, supporting bullish momentum without being deeply overbought.`
                );
            } else if (rsi >= 70) {
                reasons.push(
                    `RSI14 is ${rsi.toFixed(1)}, showing strong momentum but also elevated overbought risk.`
                );
            } else {
                reasons.push(
                    `RSI14 is ${rsi.toFixed(1)} and is not strongly bearish.`
                );
            }
        }

        if (Number.isFinite(adx)) {
            if (adx >= 25) {
                reasons.push(
                    `ADX14 is ${adx.toFixed(1)}, indicating a meaningful trend strength.`
                );
            } else {
                reasons.push(
                    `ADX14 is ${adx.toFixed(1)}, so trend strength is moderate.`
                );
            }
        }

        if (
            Number.isFinite(currentPrice) &&
            Number.isFinite(resistance) &&
            resistance > currentPrice
        ) {
            reasons.push(
                `Price is below resistance at ${formatPrice(resistance, result.pair)}, leaving a defined resistance level above.`
            );
        }

        if (
            Number.isFinite(callScore) &&
            Number.isFinite(putScore)
        ) {
            reasons.push(
                `CALL score ${Math.round(callScore)}% is above PUT score ${Math.round(putScore)}%.`
            );
        }
    }

    if (signal === 'PUT') {
        if (
            Number.isFinite(ema9) &&
            Number.isFinite(ema21) &&
            ema9 < ema21
        ) {
            reasons.push(
                'EMA9 is below EMA21, supporting bearish momentum.'
            );
        }

        if (Number.isFinite(rsi)) {
            if (rsi <= 50 && rsi > 30) {
                reasons.push(
                    `RSI14 is ${rsi.toFixed(1)}, supporting bearish momentum without being deeply oversold.`
                );
            } else if (rsi <= 30) {
                reasons.push(
                    `RSI14 is ${rsi.toFixed(1)}, showing strong bearish momentum but also elevated oversold risk.`
                );
            } else {
                reasons.push(
                    `RSI14 is ${rsi.toFixed(1)} and is not strongly bullish.`
                );
            }
        }

        if (Number.isFinite(adx)) {
            if (adx >= 25) {
                reasons.push(
                    `ADX14 is ${adx.toFixed(1)}, indicating a meaningful trend strength.`
                );
            } else {
                reasons.push(
                    `ADX14 is ${adx.toFixed(1)}, so trend strength is moderate.`
                );
            }
        }

        if (
            Number.isFinite(currentPrice) &&
            Number.isFinite(support) &&
            currentPrice > support
        ) {
            reasons.push(
                `Price is above support at ${formatPrice(support, result.pair)}, leaving a defined support level below.`
            );
        }

        if (
            Number.isFinite(callScore) &&
            Number.isFinite(putScore)
        ) {
            reasons.push(
                `PUT score ${Math.round(putScore)}% is above CALL score ${Math.round(callScore)}%.`
            );
        }
    }

    if (signal === 'NO TRADE') {
        reasons.push(
            'The available indicators are not sufficiently aligned for a high-confidence CALL or PUT.'
        );

        if (
            Number.isFinite(callScore) &&
            Number.isFinite(putScore)
        ) {
            reasons.push(
                `CALL score ${Math.round(callScore)}% vs PUT score ${Math.round(putScore)}%.`
            );
        }

        if (Number.isFinite(adx)) {
            reasons.push(
                `ADX14 is ${adx.toFixed(1)}, which is considered when evaluating trend strength.`
            );
        }
    }

    return reasons;
}


function getReasons(result) {
    const backendReasons = result?.reasons;

    if (Array.isArray(backendReasons)) {
        const clean = backendReasons
            .map(item => {
                if (typeof item === 'string') {
                    return item.trim();
                }

                if (item && typeof item === 'object') {
                    return (
                        item.reason ||
                        item.message ||
                        item.text ||
                        ''
                    ).toString().trim();
                }

                return '';
            })
            .filter(Boolean);

        if (clean.length > 0) {
            return clean;
        }
    }

    return buildFallbackReasons(result);
}


function renderReasons(result) {
    if (!el.reasons) {
        return;
    }

    const reasons = getReasons(result);

    if (!reasons.length) {
        el.reasons.innerHTML =
            '<div class="reason-item">No detailed reason returned by backend.</div>';

        return;
    }

    el.reasons.innerHTML = reasons
        .map(reason => `
            <div class="reason-item">
                <span class="reason-dot">•</span>
                <span>${escapeHtml(reason)}</span>
            </div>
        `)
        .join('');
}


/* =========================================================
   DATA AGE
========================================================= */

function renderDataAge(result) {
    if (!el.dataAge) {
        return;
    }

    /*
      V8.4.1 currently exposes analysisTime rather than
      lastCandle. We therefore do NOT falsely label analysis
      time as "last candle".

      If a future backend response provides lastCandle,
      we use it.
    */

    const timestamp =
        result?.lastCandle ||
        result?.analysisTime ||
        null;

    if (!timestamp) {
        el.dataAge.textContent = '—';
        return;
    }

    const d = new Date(timestamp);

    if (Number.isNaN(d.getTime())) {
        el.dataAge.textContent = '—';
        return;
    }

    const ageSeconds =
        Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));

    if (result?.lastCandle) {
        el.dataAge.textContent =
            `${ageSeconds}s old`;
    } else {
        el.dataAge.textContent =
            `analysis ${ageSeconds}s ago`;
    }
}


/* =========================================================
   RENDER SELECTED MARKET
========================================================= */

function renderSignal(result) {
    if (!result) {
        return;
    }

    currentResult = result;

    const pair = result.pair || '—';
    const signal = normalizeSignal(result.signal);
    const trend = normalizeTrend(result.marketCondition);

    const indicators = result.indicators || {};

    showSignalCard(true);

    /* Pair */
    if (el.selectedPair) {
        el.selectedPair.textContent = pair;
    }

    /* Trend / market condition */
    if (el.trendBadge) {
        el.trendBadge.textContent = trend;
    }

    /* Signal */
    applySignalBadge(signal);

    /* Confidence */
    if (el.confidence) {
        el.confidence.textContent = percent(result.confidence);
    }

    /* Timeframe */
    if (el.timeframe) {
        el.timeframe.textContent =
            formatTimeframe(result.timeframe);
    }

    /* Entry time */
    if (el.entryTime) {
        el.entryTime.textContent =
            formatUTC(result.entryTime);
    }

    /* Expiry time */
    if (el.expiryTime) {
        el.expiryTime.textContent =
            formatUTC(result.expiryTime);
    }

    /*
      Backend V8.4.1 returns currentPrice.

      The UI's existing field is called entryPrice.
      We display the current market price here as the
      reference price at analysis time.

      It is NOT a fabricated future quote.
    */
    if (el.entryPrice) {
        el.entryPrice.textContent =
            formatPrice(result.currentPrice, pair);
    }

    /* Scores */
    if (el.callScore) {
        el.callScore.textContent =
            percent(result.callScore);
    }

    if (el.putScore) {
        el.putScore.textContent =
            percent(result.putScore);
    }

    /* Support / resistance */
    if (el.support) {
        el.support.textContent =
            formatPrice(indicators.support, pair);
    }

    if (el.resistance) {
        el.resistance.textContent =
            formatPrice(indicators.resistance, pair);
    }

    /* Technical indicators */
    if (el.ema9) {
        el.ema9.textContent =
            formatPrice(indicators.ema9, pair);
    }

    if (el.ema21) {
        el.ema21.textContent =
            formatPrice(indicators.ema21, pair);
    }

    if (el.rsi) {
        el.rsi.textContent =
            safeNumber(indicators.rsi14, 1);
    }

    if (el.adx) {
        el.adx.textContent =
            safeNumber(indicators.adx14, 1);
    }

    /* Reasons */
    renderReasons(result);

    /* Data age */
    renderDataAge(result);

    /* Scanner information */
    if (el.scanInfo) {
        const source =
            result.source || 'Twelve Data LIVE';

        el.scanInfo.textContent =
            `${pair} selected from ${source}`;
    }

    /* Start countdown */
    startCountdown();
}


/* =========================================================
   COUNTDOWN
========================================================= */

function startCountdown() {
    clearCountdown();

    updateCountdown();

    countdownTimer = setInterval(() => {
        updateCountdown();
    }, 1000);
}


function updateCountdown() {
    if (!el.countdown) {
        return;
    }

    if (!currentResult) {
        el.countdown.textContent = '—';
        return;
    }

    const seconds = secondsUntil(
        currentResult.entryTime
    );

    if (seconds === null) {
        el.countdown.textContent = '—';
        return;
    }

    if (seconds <= 0) {
        el.countdown.textContent = 'ENTER NOW';

        if (seconds < -5) {
            clearCountdown();
        }

        return;
    }

    el.countdown.textContent =
        formatCountdown(seconds);
}


/* =========================================================
   LOADING STATE
========================================================= */

function renderLoading() {
    showSignalCard(true);

    if (el.selectedPair) {
        el.selectedPair.textContent =
            'SCANNING 24 LIVE PAIRS...';
    }

    if (el.trendBadge) {
        el.trendBadge.textContent =
            'AI SELECTING';
    }

    if (el.signalBadge) {
        el.signalBadge.textContent =
            'SCANNING...';

        el.signalBadge.classList.remove(
            'call',
            'put',
            'no-trade'
        );
    }

    if (el.confidence) {
        el.confidence.textContent = '—';
    }

    if (el.timeframe) {
        el.timeframe.textContent = '—';
    }

    if (el.entryTime) {
        el.entryTime.textContent = '—';
    }

    if (el.expiryTime) {
        el.expiryTime.textContent = '—';
    }

    if (el.entryPrice) {
        el.entryPrice.textContent = '—';
    }

    if (el.callScore) {
        el.callScore.textContent = '—';
    }

    if (el.putScore) {
        el.putScore.textContent = '—';
    }

    if (el.support) {
        el.support.textContent = '—';
    }

    if (el.resistance) {
        el.resistance.textContent = '—';
    }

    if (el.ema9) {
        el.ema9.textContent = '—';
    }

    if (el.ema21) {
        el.ema21.textContent = '—';
    }

    if (el.rsi) {
        el.rsi.textContent = '—';
    }

    if (el.adx) {
        el.adx.textContent = '—';
    }

    if (el.countdown) {
        el.countdown.textContent =
            'Finding strongest setup...';
    }

    if (el.reasons) {
        el.reasons.innerHTML = `
            <div class="reason-item">
                <span class="reason-dot">•</span>
                <span>
                    Scanning live markets and comparing the available setups...
                </span>
            </div>
        `;
    }

    if (el.scanInfo) {
        el.scanInfo.textContent =
            'Smart scanner is selecting the strongest available setup...';
    }
}


/* =========================================================
   ERROR STATE
========================================================= */

function renderErrorState(message) {
    clearCountdown();

    currentResult = null;

    if (el.signalBadge) {
        el.signalBadge.textContent = 'ERROR';

        el.signalBadge.classList.remove(
            'call',
            'put',
            'no-trade'
        );
    }

    if (el.countdown) {
        el.countdown.textContent = '—';
    }

    if (el.reasons) {
        el.reasons.innerHTML = `
            <div class="reason-item">
                <span class="reason-dot">!</span>
                <span>${escapeHtml(message)}</span>
            </div>
        `;
    }
}


/* =========================================================
   FETCH JSON
========================================================= */

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        cache: 'no-store',
        ...options
    });

    let data = null;

    try {
        data = await response.json();
    } catch (error) {
        throw new Error(
            `Backend returned invalid JSON (${response.status}).`
        );
    }

    if (!response.ok) {
        const message =
            data?.error ||
            data?.message ||
            `Backend request failed with HTTP ${response.status}.`;

        throw new Error(message);
    }

    return data;
}


/* =========================================================
   HEALTH
========================================================= */

async function checkHealth() {
    try {
        const data = await fetchJson(HEALTH_URL);

        if (data?.ok) {
            const version =
                data.version
                    ? ` ${data.version}`
                    : '';

            setBackendStatus(
                `LIVE${version}`,
                true
            );

            return data;
        }

        throw new Error('Backend health check failed.');
    } catch (error) {
        setBackendStatus(
            'BACKEND OFFLINE',
            false
        );

        return null;
    }
}


/* =========================================================
   SCANNER STATUS
========================================================= */

function renderScanner(data) {
    if (!el.scanner) {
        return;
    }

    if (!data) {
        el.scanner.textContent =
            'Scanner status unavailable.';
        return;
    }

    const running =
        data.scanRunning === true;

    const cachedPairs =
        Number.isFinite(Number(data.cachedPairs))
            ? Number(data.cachedPairs)
            : 0;

    const cachedResults =
        Number.isFinite(Number(data.cachedResults))
            ? Number(data.cachedResults)
            : 0;

    const cursor =
        Number.isFinite(Number(data.scanCursor))
            ? Number(data.scanCursor)
            : null;

    const batchSize =
        Number.isFinite(Number(data.scanBatchSize))
            ? Number(data.scanBatchSize)
            : null;

    const quotaBlocked =
        data.quotaBlocked === true;

    let status = running
        ? 'SCANNING'
        : 'READY';

    if (quotaBlocked) {
        status = 'QUOTA BLOCKED';
    }

    el.scanner.innerHTML = `
        <div class="scanner-status">
            <strong>${escapeHtml(status)}</strong>
        </div>

        <div class="scanner-line">
            Cached pairs:
            <strong>${cachedPairs}</strong>
        </div>

        <div class="scanner-line">
            Cached results:
            <strong>${cachedResults}</strong>
        </div>

        <div class="scanner-line">
            Batch size:
            <strong>${batchSize ?? '—'}</strong>
        </div>

        <div class="scanner-line">
            Scan cursor:
            <strong>${cursor ?? '—'}</strong>
        </div>
    `;
}


async function refreshScanner() {
    try {
        const data =
            await fetchJson(SCAN_STATUS_URL);

        renderScanner(data);

        return data;
    } catch (error) {
        if (el.scanner) {
            el.scanner.textContent =
                'Scanner status unavailable.';
        }

        return null;
    }
}


/* =========================================================
   MAIN ANALYZE FUNCTION
========================================================= */

async function analyzeMarket() {
    if (analyzing) {
        return;
    }

    clearError();
    clearCountdown();

    currentResult = null;

    setLoading(true);
    renderLoading();

    try {
        /*
        =====================================================
        IMPORTANT

        DO NOT use /api/analyze here.

        /api/analyze requires a pair.

        V8 Smart Scanner must let the backend choose
        the market automatically.

        Therefore:

            /api/best

        =====================================================
        */

        const data =
            await fetchJson(BEST_URL);

        if (!data || data.ok !== true) {
            throw new Error(
                data?.error ||
                data?.message ||
                'Smart scanner returned an invalid response.'
            );
        }

        const selected =
            data.selectedMarket ||
            data.selected ||
            data.best ||
            null;

        if (!selected) {
            throw new Error(
                'Smart scanner did not return a selected market.'
            );
        }

        /*
          Make sure we have an actual signal object.
        */
        const signal =
            normalizeSignal(selected.signal);

        if (
            !selected.pair ||
            !selected.timeframe ||
            !selected.entryTime ||
            !selected.expiryTime
        ) {
            throw new Error(
                'Selected market response is incomplete.'
            );
        }

        /*
          Store selected result.
        */
        currentResult = selected;

        /*
          Render selected market.
        */
        renderSignal(selected);

        /*
          Explain selection.
        */
        if (el.scanInfo) {
            const scanned =
                Number(data.scannedResults);

            const scanText =
                Number.isFinite(scanned)
                    ? ` Compared ${scanned} available result(s).`
                    : '';

            el.scanInfo.textContent =
                `AI selected ${selected.pair} • ${formatTimeframe(selected.timeframe)} • ${signal}.${scanText}`;
        }

        /*
          If backend reports stale-cache warning, show it
          without pretending it is a live fresh quote.
        */
        if (
            selected.dataWarning &&
            el.scanInfo
        ) {
            el.scanInfo.textContent +=
                ` ${selected.dataWarning}`;
        }

        /*
          Refresh scanner information after selection.
        */
        await refreshScanner();

    } catch (error) {
        console.error(
            '[PO AI PREDICTOR] Analyze error:',
            error
        );

        const message =
            error?.message ||
            'Unable to load live market data.';

        showError(message);
        renderErrorState(message);

        if (el.scanInfo) {
            el.scanInfo.textContent =
                'Smart scanner could not select a valid market.';
        }

    } finally {
        setLoading(false);
    }
}


/* =========================================================
   AUTO REFRESH STATUS
========================================================= */

function startStatusRefresh() {
    if (healthTimer) {
        clearInterval(healthTimer);
    }

    if (scannerTimer) {
        clearInterval(scannerTimer);
    }

    /*
      Health every 30 seconds.
    */
    healthTimer = setInterval(() => {
        checkHealth();
    }, 30000);

    /*
      Scanner status every 15 seconds.
      This does NOT trigger a new scan.
    */
    scannerTimer = setInterval(() => {
        refreshScanner();
    }, 15000);
}


/* =========================================================
   VISIBILITY CHANGE
========================================================= */

document.addEventListener(
    'visibilitychange',
    () => {
        if (!document.hidden) {
            checkHealth();
            refreshScanner();

            if (currentResult) {
                renderDataAge(currentResult);
                updateCountdown();
            }
        }
    }
);


/* =========================================================
   BUTTON
========================================================= */

function bindEvents() {
    if (el.analyzeBtn) {
        el.analyzeBtn.addEventListener(
            'click',
            analyzeMarket
        );
    }
}


/* =========================================================
   INIT
========================================================= */

async function init() {
    clearError();
    clearCountdown();

    setBackendStatus(
        'CONNECTING...',
        false
    );

    bindEvents();

    await checkHealth();

    await refreshScanner();

    startStatusRefresh();

    /*
      Do NOT automatically place or generate a trade signal
      on page load.

      The user explicitly chooses when to analyze by pressing:

          ANALYZE MARKET
    */
}


/* =========================================================
   SAFE DOM READY
========================================================= */

if (document.readyState === 'loading') {
    document.addEventListener(
        'DOMContentLoaded',
        init
    );
} else {
    init();
}
