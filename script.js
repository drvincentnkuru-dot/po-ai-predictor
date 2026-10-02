'use strict';

/*
===========================================================
 PO AI PREDICTOR
 V8.5 • SMART LIVE SCANNER FRONTEND

 NEW:
 - Candlestick pattern display
 - Market psychology display
 - Buyer / seller pressure
 - Trend conviction
 - Rejection / indecision
 - Pattern confirmation
 - Psychology confirmation

 Backend:
 https://po-ai-predictor-api.onrender.com
===========================================================
*/

const API_URL =
    'https://po-ai-predictor-api.onrender.com';

const BEST_URL =
    `${API_URL}/api/best`;

const HEALTH_URL =
    `${API_URL}/api/health`;

const SCAN_STATUS_URL =
    `${API_URL}/api/scan/status`;


/* =========================================================
   DOM
========================================================= */

const el = {
    backendStatus:
        document.getElementById('backendStatus'),

    analyzeBtn:
        document.getElementById('analyzeBtn'),

    errorBox:
        document.getElementById('errorBox'),

    signalCard:
        document.getElementById('signalCard'),

    selectedPair:
        document.getElementById('selectedPair'),

    trendBadge:
        document.getElementById('trendBadge'),

    signalBadge:
        document.getElementById('signalBadge'),

    confidence:
        document.getElementById('confidence'),

    timeframe:
        document.getElementById('timeframe'),

    countdown:
        document.getElementById('countdown'),

    entryTime:
        document.getElementById('entryTime'),

    expiryTime:
        document.getElementById('expiryTime'),

    entryPrice:
        document.getElementById('entryPrice'),

    callScore:
        document.getElementById('callScore'),

    putScore:
        document.getElementById('putScore'),

    support:
        document.getElementById('support'),

    resistance:
        document.getElementById('resistance'),

    dataAge:
        document.getElementById('dataAge'),

    ema9:
        document.getElementById('ema9'),

    ema21:
        document.getElementById('ema21'),

    rsi:
        document.getElementById('rsi'),

    adx:
        document.getElementById('adx'),

    reasons:
        document.getElementById('reasons'),

    scanInfo:
        document.getElementById('scanInfo'),

    scanner:
        document.getElementById('scanner')
};


/* =========================================================
   STATE
========================================================= */

let currentResult = null;

let countdownTimer = null;
let healthTimer = null;
let scannerTimer = null;

let analyzing = false;

let insightBox = null;


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

    const normalizedPair =
        String(pair || '')
            .toUpperCase();

    const decimals =
        normalizedPair.includes('JPY')
            ? 3
            : 5;

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

    return d.toLocaleString(
        'en-GB',
        {
            timeZone: 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }
    ) + ' UTC';
}


function shortUTC(value) {
    if (!value) {
        return '—';
    }

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
        return String(value);
    }

    return d.toLocaleTimeString(
        'en-GB',
        {
            timeZone: 'UTC',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }
    ) + ' UTC';
}


function secondsUntil(value) {
    if (!value) {
        return null;
    }

    const target =
        new Date(value).getTime();

    if (!Number.isFinite(target)) {
        return null;
    }

    return Math.floor(
        (
            target -
            Date.now()
        ) / 1000
    );
}


function formatCountdown(seconds) {
    if (!Number.isFinite(seconds)) {
        return '—';
    }

    if (seconds <= 0) {
        return 'ENTER NOW';
    }

    const min =
        Math.floor(seconds / 60);

    const sec =
        seconds % 60;

    if (min > 0) {
        return `${min}m ${String(sec).padStart(2, '0')}s`;
    }

    return `${sec}s`;
}


function clearCountdown() {
    if (countdownTimer) {
        clearInterval(
            countdownTimer
        );

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

    el.errorBox.textContent =
        message;

    el.errorBox.style.display =
        'block';
}


function setBackendStatus(
    text,
    online = false
) {
    if (!el.backendStatus) {
        return;
    }

    el.backendStatus.textContent =
        text;

    el.backendStatus.classList.toggle(
        'online',
        online
    );

    el.backendStatus.classList.toggle(
        'offline',
        !online
    );
}


function setLoading(loading) {
    analyzing = loading;

    if (!el.analyzeBtn) {
        return;
    }

    el.analyzeBtn.disabled =
        loading;

    if (loading) {
        el.analyzeBtn.dataset.originalText =
            el.analyzeBtn.textContent ||
            'ANALYZE MARKET';

        el.analyzeBtn.textContent =
            'SCANNING LIVE MARKET...';

        el.analyzeBtn.classList.add(
            'loading'
        );
    } else {
        el.analyzeBtn.textContent =
            el.analyzeBtn.dataset.originalText ||
            'ANALYZE MARKET';

        el.analyzeBtn.classList.remove(
            'loading'
        );
    }
}


function showSignalCard(
    show = true
) {
    if (!el.signalCard) {
        return;
    }

    el.signalCard.style.display =
        show ? '' : 'none';
}


/* =========================================================
   SIGNAL
========================================================= */

function normalizeSignal(signal) {
    const value =
        String(signal || '')
            .trim()
            .toUpperCase();

    if (value === 'CALL') {
        return 'CALL';
    }

    if (value === 'PUT') {
        return 'PUT';
    }

    return 'NO TRADE';
}


function normalizeTrend(condition) {
    const value =
        String(condition || '')
            .trim()
            .toUpperCase();

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
            return (
                value ||
                'MARKET CONDITION —'
            );
    }
}


function applySignalBadge(signal) {
    if (!el.signalBadge) {
        return;
    }

    const normalized =
        normalizeSignal(signal);

    el.signalBadge.textContent =
        normalized;

    el.signalBadge.classList.remove(
        'call',
        'put',
        'no-trade',
        'CALL',
        'PUT',
        'NO-TRADE'
    );

    if (normalized === 'CALL') {
        el.signalBadge.classList.add(
            'call'
        );
    } else if (
        normalized === 'PUT'
    ) {
        el.signalBadge.classList.add(
            'put'
        );
    } else {
        el.signalBadge.classList.add(
            'no-trade'
        );
    }
}


/* =========================================================
   DYNAMIC INSIGHT PANEL
========================================================= */

function ensureInsightBox() {
    if (insightBox) {
        return insightBox;
    }

    /*
      If #reasons exists, put the new panel directly
      after it. Otherwise attach it to signalCard.
    */
    const parent =
        el.reasons?.parentElement ||
        el.signalCard ||
        document.body;

    insightBox =
        document.createElement('div');

    insightBox.id =
        'v85MarketInsights';

    insightBox.style.marginTop =
        '14px';

    insightBox.style.display =
        'block';

    parent.appendChild(
        insightBox
    );

    return insightBox;
}


function insightClass(direction) {
    const value =
        String(direction || '')
            .toUpperCase();

    if (
        value.includes('BULLISH') ||
        value.includes('BUYER')
    ) {
        return 'bullish';
    }

    if (
        value.includes('BEARISH') ||
        value.includes('SELLER')
    ) {
        return 'bearish';
    }

    return 'neutral';
}


function renderMarketInsights(result) {
    const box =
        ensureInsightBox();

    if (!box) {
        return;
    }

    const patterns =
        Array.isArray(
            result?.candlestickPatterns
        )
            ? result.candlestickPatterns
            : [];

    const summary =
        result?.patternSummary ||
        {};

    const psychology =
        result?.marketPsychology ||
        {};

    const confirmation =
        result?.confirmation ||
        {};

    const patternNames =
        Array.isArray(summary.names)
            ? summary.names
            : [];

    const patternDirection =
        summary.direction ||
        'NEUTRAL';

    const psychologySentiment =
        psychology.sentiment ||
        'BALANCED';

    const patternText =
        patternNames.length
            ? patternNames
                .map(name =>
                    escapeHtml(name)
                )
                .join(' • ')
            : 'No strong named pattern';

    const psychologyDescription =
        psychology.description ||
        'No psychology summary returned.';

    const rejection =
        psychology.rejection ||
        'NONE';

    const conviction =
        Number.isFinite(
            Number(
                psychology.conviction
            )
        )
            ? Math.round(
                Number(
                    psychology.conviction
                )
            )
            : null;

    const buyerPressure =
        Number.isFinite(
            Number(
                psychology.buyerPressure
            )
        )
            ? Math.round(
                Number(
                    psychology.buyerPressure
                )
            )
            : null;

    const sellerPressure =
        Number.isFinite(
            Number(
                psychology.sellerPressure
            )
        )
            ? Math.round(
                Number(
                    psychology.sellerPressure
                )
            )
            : null;

    const indecision =
        Number.isFinite(
            Number(
                psychology.indecision
            )
        )
            ? Math.round(
                Number(
                    psychology.indecision
                )
            )
            : null;

    const patternScore =
        Number.isFinite(
            Number(
                result?.patternScore
            )
        )
            ? Math.round(
                Number(
                    result.patternScore
                )
            )
            : 0;

    const psychologyScore =
        Number.isFinite(
            Number(
                result?.psychologyScore
            )
        )
            ? Math.round(
                Number(
                    result.psychologyScore
                )
            )
            : 0;

    box.innerHTML = `
        <div class="v85-insights"
             style="
                border:1px solid rgba(128,128,128,.25);
                border-radius:14px;
                padding:14px;
                margin-top:12px;
             ">

            <div style="
                font-weight:700;
                margin-bottom:12px;
            ">
                MARKET PRICE-ACTION INSIGHTS
            </div>

            <div style="
                display:grid;
                grid-template-columns:
                    repeat(auto-fit,minmax(210px,1fr));
                gap:10px;
            ">

                <div class="v85-insight-card"
                     style="
                        padding:12px;
                        border-radius:10px;
                        border:1px solid rgba(128,128,128,.18);
                     ">

                    <div style="
                        font-weight:700;
                        margin-bottom:7px;
                    ">
                        CANDLESTICK PATTERN
                    </div>

                    <div class="${insightClass(patternDirection)}"
                         style="
                            font-weight:700;
                            margin-bottom:5px;
                         ">
                        ${escapeHtml(patternDirection)}
                    </div>

                    <div style="
                        font-size:.9rem;
                        margin-bottom:6px;
                    ">
                        ${patternText}
                    </div>

                    <div style="
                        font-size:.82rem;
                        opacity:.75;
                    ">
                        Confirmation:
                        ${escapeHtml(String(patternScore))}
                    </div>
                </div>


                <div class="v85-insight-card"
                     style="
                        padding:12px;
                        border-radius:10px;
                        border:1px solid rgba(128,128,128,.18);
                     ">

                    <div style="
                        font-weight:700;
                        margin-bottom:7px;
                    ">
                        MARKET PSYCHOLOGY
                    </div>

                    <div class="${insightClass(psychologySentiment)}"
                         style="
                            font-weight:700;
                            margin-bottom:5px;
                         ">
                        ${escapeHtml(psychologySentiment)}
                    </div>

                    <div style="
                        font-size:.88rem;
                        line-height:1.4;
                        margin-bottom:7px;
                    ">
                        ${escapeHtml(psychologyDescription)}
                    </div>

                    <div style="
                        font-size:.82rem;
                        opacity:.82;
                    ">
                        Buyers:
                        <strong>
                            ${buyerPressure !== null
                                ? `${buyerPressure}%`
                                : '—'}
                        </strong>
                        &nbsp;|&nbsp;
                        Sellers:
                        <strong>
                            ${sellerPressure !== null
                                ? `${sellerPressure}%`
                                : '—'}
                        </strong>
                    </div>
                </div>


                <div class="v85-insight-card"
                     style="
                        padding:12px;
                        border-radius:10px;
                        border:1px solid rgba(128,128,128,.18);
                     ">

                    <div style="
                        font-weight:700;
                        margin-bottom:7px;
                    ">
                        MARKET BEHAVIOR
                    </div>

                    <div style="
                        font-size:.88rem;
                        line-height:1.7;
                    ">
                        <div>
                            Conviction:
                            <strong>
                                ${conviction !== null
                                    ? `${conviction}%`
                                    : '—'}
                            </strong>
                        </div>

                        <div>
                            Rejection:
                            <strong>
                                ${escapeHtml(rejection)}
                            </strong>
                        </div>

                        <div>
                            Indecision:
                            <strong>
                                ${indecision !== null
                                    ? `${indecision}%`
                                    : '—'}
                            </strong>
                        </div>

                        <div>
                            Pattern confirmation:
                            <strong>
                                ${patternScore}
                            </strong>
                        </div>

                        <div>
                            Psychology confirmation:
                            <strong>
                                ${psychologyScore}
                            </strong>
                        </div>
                    </div>
                </div>

            </div>

            ${
                patterns.length
                    ? `
                        <div style="
                            margin-top:12px;
                            font-size:.85rem;
                            opacity:.82;
                        ">
                            Detected:
                            ${patterns
                                .slice(0, 5)
                                .map(pattern => `
                                    <span style="
                                        display:inline-block;
                                        margin:3px 4px 3px 0;
                                        padding:4px 7px;
                                        border-radius:7px;
                                        border:1px solid rgba(128,128,128,.2);
                                    ">
                                        ${escapeHtml(
                                            pattern.name
                                        )}
                                    </span>
                                `)
                                .join('')}
                        </div>
                    `
                    : ''
            }

            <div style="
                margin-top:10px;
                font-size:.75rem;
                opacity:.62;
            ">
                Price-action psychology is inferred from recent
                OHLC candles; it is not direct order-book sentiment.
            </div>

        </div>
    `;
}


/* =========================================================
   REASON ENGINE
========================================================= */

function buildFallbackReasons(result) {
    const reasons = [];

    const signal =
        normalizeSignal(
            result?.signal
        );

    const indicators =
        result?.indicators || {};

    const ema9 =
        Number(indicators.ema9);

    const ema21 =
        Number(indicators.ema21);

    const rsi =
        Number(indicators.rsi14);

    const adx =
        Number(indicators.adx14);

    const currentPrice =
        Number(
            result?.currentPrice
        );

    const support =
        Number(
            indicators.support
        );

    const resistance =
        Number(
            indicators.resistance
        );

    const callScore =
        Number(
            result?.callScore
        );

    const putScore =
        Number(
            result?.putScore
        );

    if (
        signal === 'CALL'
    ) {
        if (
            Number.isFinite(ema9) &&
            Number.isFinite(ema21) &&
            ema9 > ema21
        ) {
            reasons.push(
                'EMA9 is above EMA21, supporting bullish momentum.'
            );
        }

        if (
            Number.isFinite(rsi)
        ) {
            reasons.push(
                `RSI14 is ${rsi.toFixed(1)}.`
            );
        }

        if (
            Number.isFinite(adx)
        ) {
            reasons.push(
                `ADX14 is ${adx.toFixed(1)}.`
            );
        }

        if (
            Number.isFinite(
                currentPrice
            ) &&
            Number.isFinite(
                resistance
            ) &&
            resistance >
                currentPrice
        ) {
            reasons.push(
                `Price is below resistance at ${formatPrice(
                    resistance,
                    result.pair
                )}.`
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

    if (
        signal === 'PUT'
    ) {
        if (
            Number.isFinite(ema9) &&
            Number.isFinite(ema21) &&
            ema9 < ema21
        ) {
            reasons.push(
                'EMA9 is below EMA21, supporting bearish momentum.'
            );
        }

        if (
            Number.isFinite(rsi)
        ) {
            reasons.push(
                `RSI14 is ${rsi.toFixed(1)}.`
            );
        }

        if (
            Number.isFinite(adx)
        ) {
            reasons.push(
                `ADX14 is ${adx.toFixed(1)}.`
            );
        }

        if (
            Number.isFinite(
                currentPrice
            ) &&
            Number.isFinite(
                support
            ) &&
            currentPrice >
                support
        ) {
            reasons.push(
                `Price is above support at ${formatPrice(
                    support,
                    result.pair
                )}.`
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

    if (
        signal === 'NO TRADE'
    ) {
        reasons.push(
            'Available indicators are not sufficiently aligned for a high-confidence CALL or PUT.'
        );

        if (
            Number.isFinite(callScore) &&
            Number.isFinite(putScore)
        ) {
            reasons.push(
                `CALL score ${Math.round(callScore)}% vs PUT score ${Math.round(putScore)}%.`
            );
        }
    }

    return reasons;
}


function getReasons(result) {
    const backendReasons =
        result?.reasons;

    if (
        Array.isArray(
            backendReasons
        )
    ) {
        const clean =
            backendReasons
                .map(item => {
                    if (
                        typeof item ===
                        'string'
                    ) {
                        return item.trim();
                    }

                    if (
                        item &&
                        typeof item ===
                        'object'
                    ) {
                        return (
                            item.reason ||
                            item.message ||
                            item.text ||
                            ''
                        )
                            .toString()
                            .trim();
                    }

                    return '';
                })
                .filter(Boolean);

        if (
            clean.length > 0
        ) {
            return clean;
        }
    }

    return buildFallbackReasons(
        result
    );
}


function renderReasons(result) {
    if (!el.reasons) {
        return;
    }

    const reasons =
        getReasons(result);

    if (!reasons.length) {
        el.reasons.innerHTML =
            '<div class="reason-item">No detailed reason returned by backend.</div>';

        return;
    }

    el.reasons.innerHTML =
        reasons
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

    const timestamp =
        result?.lastCandle ||
        result?.analysisTime ||
        null;

    if (!timestamp) {
        el.dataAge.textContent =
            '—';

        return;
    }

    const d =
        new Date(timestamp);

    if (
        Number.isNaN(
            d.getTime()
        )
    ) {
        el.dataAge.textContent =
            '—';

        return;
    }

    const ageSeconds =
        Math.max(
            0,
            Math.floor(
                (
                    Date.now() -
                    d.getTime()
                ) / 1000
            )
        );

    if (
        result?.lastCandle
    ) {
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

    currentResult =
        result;

    const pair =
        result.pair || '—';

    const signal =
        normalizeSignal(
            result.signal
        );

    const trend =
        normalizeTrend(
            result.marketCondition
        );

    const indicators =
        result.indicators || {};

    showSignalCard(true);

    if (el.selectedPair) {
        el.selectedPair.textContent =
            pair;
    }

    if (el.trendBadge) {
        el.trendBadge.textContent =
            trend;
    }

    applySignalBadge(
        signal
    );

    if (el.confidence) {
        el.confidence.textContent =
            percent(
                result.confidence
            );
    }

    if (el.timeframe) {
        el.timeframe.textContent =
            formatTimeframe(
                result.timeframe
            );
    }

    if (el.entryTime) {
        el.entryTime.textContent =
            formatUTC(
                result.entryTime
            );
    }

    if (el.expiryTime) {
        el.expiryTime.textContent =
            formatUTC(
                result.expiryTime
            );
    }

    if (el.entryPrice) {
        el.entryPrice.textContent =
            formatPrice(
                result.currentPrice,
                pair
            );
    }

    if (el.callScore) {
        el.callScore.textContent =
            percent(
                result.callScore
            );
    }

    if (el.putScore) {
        el.putScore.textContent =
            percent(
                result.putScore
            );
    }

    if (el.support) {
        el.support.textContent =
            formatPrice(
                indicators.support,
                pair
            );
    }

    if (el.resistance) {
        el.resistance.textContent =
            formatPrice(
                indicators.resistance,
                pair
            );
    }

    if (el.ema9) {
        el.ema9.textContent =
            formatPrice(
                indicators.ema9,
                pair
            );
    }

    if (el.ema21) {
        el.ema21.textContent =
            formatPrice(
                indicators.ema21,
                pair
            );
    }

    if (el.rsi) {
        el.rsi.textContent =
            safeNumber(
                indicators.rsi14,
                1
            );
    }

    if (el.adx) {
        el.adx.textContent =
            safeNumber(
                indicators.adx14,
                1
            );
    }

    renderReasons(
        result
    );

    renderDataAge(
        result
    );

    /*
      NEW V8.5
    */
    renderMarketInsights(
        result
    );

    if (el.scanInfo) {
        const source =
            result.source ||
            'Twelve Data LIVE';

        el.scanInfo.textContent =
            `${pair} selected from ${source}`;
    }

    startCountdown();
}


/* =========================================================
   COUNTDOWN
========================================================= */

function startCountdown() {
    clearCountdown();

    updateCountdown();

    countdownTimer =
        setInterval(
            () => {
                updateCountdown();
            },
            1000
        );
}


function updateCountdown() {
    if (!el.countdown) {
        return;
    }

    if (!currentResult) {
        el.countdown.textContent =
            '—';

        return;
    }

    const seconds =
        secondsUntil(
            currentResult.entryTime
        );

    if (
        seconds === null
    ) {
        el.countdown.textContent =
            '—';

        return;
    }

    if (
        seconds <= 0
    ) {
        el.countdown.textContent =
            'ENTER NOW';

        if (
            seconds < -5
        ) {
            clearCountdown();
        }

        return;
    }

    el.countdown.textContent =
        formatCountdown(
            seconds
        );
}


/* =========================================================
   LOADING
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

    const fields = [
        el.confidence,
        el.timeframe,
        el.entryTime,
        el.expiryTime,
        el.entryPrice,
        el.callScore,
        el.putScore,
        el.support,
        el.resistance,
        el.ema9,
        el.ema21,
        el.rsi,
        el.adx
    ];

    fields.forEach(
        field => {
            if (field) {
                field.textContent =
                    '—';
            }
        }
    );

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

    if (insightBox) {
        insightBox.innerHTML = '';
    }
}


/* =========================================================
   ERROR
========================================================= */

function renderErrorState(
    message
) {
    clearCountdown();

    currentResult =
        null;

    if (el.signalBadge) {
        el.signalBadge.textContent =
            'ERROR';

        el.signalBadge.classList.remove(
            'call',
            'put',
            'no-trade'
        );
    }

    if (el.countdown) {
        el.countdown.textContent =
            '—';
    }

    if (el.reasons) {
        el.reasons.innerHTML = `
            <div class="reason-item">
                <span class="reason-dot">!</span>
                <span>${escapeHtml(message)}</span>
            </div>
        `;
    }

    if (insightBox) {
        insightBox.innerHTML =
            '';
    }
}


/* =========================================================
   FETCH
========================================================= */

async function fetchJson(
    url,
    options = {}
) {
    const response =
        await fetch(
            url,
            {
                cache: 'no-store',
                ...options
            }
        );

    let data = null;

    try {
        data =
            await response.json();
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

        throw new Error(
            message
        );
    }

    return data;
}


/* =========================================================
   HEALTH
========================================================= */

async function checkHealth() {
    try {
        const data =
            await fetchJson(
                HEALTH_URL
            );

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

        throw new Error(
            'Backend health check failed.'
        );

    } catch (error) {

        setBackendStatus(
            'BACKEND OFFLINE',
            false
        );

        return null;
    }
}


/* =========================================================
   SCANNER
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
        Number.isFinite(
            Number(
                data.cachedPairs
            )
        )
            ? Number(
                data.cachedPairs
            )
            : 0;

    const cachedResults =
        Number.isFinite(
            Number(
                data.cachedResults
            )
        )
            ? Number(
                data.cachedResults
            )
            : 0;

    const cursor =
        Number.isFinite(
            Number(
                data.scanCursor
            )
        )
            ? Number(
                data.scanCursor
            )
            : null;

    const batchSize =
        Number.isFinite(
            Number(
                data.scanBatchSize
            )
        )
            ? Number(
                data.scanBatchSize
            )
            : null;

    const quotaBlocked =
        data.quotaBlocked === true;

    let status =
        running
            ? 'SCANNING'
            : 'READY';

    if (quotaBlocked) {
        status =
            'QUOTA BLOCKED';
    }

    el.scanner.innerHTML = `
        <div class="scanner-status">
            <strong>
                ${escapeHtml(status)}
            </strong>
        </div>

        <div class="scanner-line">
            Cached pairs:
            <strong>
                ${cachedPairs}
            </strong>
        </div>

        <div class="scanner-line">
            Cached results:
            <strong>
                ${cachedResults}
            </strong>
        </div>

        <div class="scanner-line">
            Batch size:
            <strong>
                ${batchSize ?? '—'}
            </strong>
        </div>

        <div class="scanner-line">
            Scan cursor:
            <strong>
                ${cursor ?? '—'}
            </strong>
        </div>
    `;
}


async function refreshScanner() {
    try {
        const data =
            await fetchJson(
                SCAN_STATUS_URL
            );

        renderScanner(
            data
        );

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
   MAIN ANALYZE
========================================================= */

async function analyzeMarket() {
    if (analyzing) {
        return;
    }

    clearError();

    clearCountdown();

    currentResult =
        null;

    setLoading(true);

    renderLoading();

    try {

        /*
          Smart scanner:
          backend chooses pair + timeframe.
        */
        const data =
            await fetchJson(
                BEST_URL
            );

        if (
            !data ||
            data.ok !== true
        ) {
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

        const signal =
            normalizeSignal(
                selected.signal
            );

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

        currentResult =
            selected;

        renderSignal(
            selected
        );

        if (el.scanInfo) {
            const scanned =
                Number(
                    data.scannedResults
                );

            const scanText =
                Number.isFinite(scanned)
                    ? ` Compared ${scanned} available result(s).`
                    : '';

            el.scanInfo.textContent =
                `AI selected ${selected.pair} • ${formatTimeframe(
                    selected.timeframe
                )} • ${signal}.${scanText}`;
        }

        if (
            selected.dataWarning &&
            el.scanInfo
        ) {
            el.scanInfo.textContent +=
                ` ${selected.dataWarning}`;
        }

        await refreshScanner();

    } catch (error) {

        console.error(
            '[PO AI PREDICTOR] Analyze error:',
            error
        );

        const message =
            error?.message ||
            'Unable to load live market data.';

        showError(
            message
        );

        renderErrorState(
            message
        );

        if (el.scanInfo) {
            el.scanInfo.textContent =
                'Smart scanner could not select a valid market.';
        }

    } finally {
        setLoading(false);
    }
}


/* =========================================================
   AUTO STATUS REFRESH
========================================================= */

function startStatusRefresh() {
    if (healthTimer) {
        clearInterval(
            healthTimer
        );
    }

    if (scannerTimer) {
        clearInterval(
            scannerTimer
        );
    }

    /*
      Health only.
      Does not trigger scanning.
    */
    healthTimer =
        setInterval(
            () => {
                checkHealth();
            },
            30000
        );

    /*
      Scanner status only.
      Does not trigger provider requests.
    */
    scannerTimer =
        setInterval(
            () => {
                refreshScanner();
            },
            15000
        );
}


/* =========================================================
   VISIBILITY
========================================================= */

document.addEventListener(
    'visibilitychange',
    () => {
        if (!document.hidden) {

            checkHealth();

            refreshScanner();

            if (currentResult) {
                renderDataAge(
                    currentResult
                );

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
      No automatic signal generation on page load.
    */
}


/* =========================================================
   DOM READY
========================================================= */

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
