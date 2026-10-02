'use strict';

/*
===========================================================
 PO AI PREDICTOR
 V8.5 • SMART LIVE SCANNER
 Candlestick Patterns + Price-Action Market Psychology

 SOURCE:
 Twelve Data LIVE

 IMPORTANT:
 "Market Psychology" here means price-action behavior inferred
 from OHLC candles, momentum, rejection and trend structure.
 It is NOT direct trader sentiment or order-book data.
===========================================================
*/

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

/* =========================================================
   CONFIG
========================================================= */

const VERSION = 'V8.5';

const PORT = Number(process.env.PORT || 10000);

const TWELVE_DATA_API_KEY =
    process.env.TWELVE_DATA_API_KEY || '';

const TWELVE_DATA_URL =
    process.env.TWELVE_DATA_URL ||
    'https://api.twelvedata.com/time_series';

const TIMEZONE = 'UTC';

const PAIRS = [
    'EUR/USD',
    'GBP/USD',
    'USD/JPY',
    'USD/CHF',
    'AUD/USD',
    'USD/CAD',
    'NZD/USD',
    'EUR/GBP',
    'EUR/JPY',
    'GBP/JPY',
    'AUD/JPY',
    'CAD/JPY',
    'CHF/JPY',
    'EUR/AUD',
    'EUR/CAD',
    'EUR/CHF',
    'GBP/AUD',
    'GBP/CAD',
    'GBP/CHF',
    'NZD/JPY',
    'NZD/CAD',
    'AUD/CAD',
    'AUD/CHF',
    'CAD/CHF'
];

const TIMEFRAMES = [1, 2, 3];

const MAX_CANDLES =
    Number(process.env.MAX_CANDLES || 180);

const MIN_CANDLES =
    Number(process.env.MIN_CANDLES || 60);

const SCAN_BATCH_SIZE =
    Math.max(
        1,
        Number(process.env.SCAN_BATCH_SIZE || 8)
    );

const SCAN_EVERY_MINUTES =
    Math.max(
        1,
        Number(process.env.SCAN_EVERY_MINUTES || 15)
    );

const CACHE_TTL_MINUTES =
    Math.max(
        1,
        Number(process.env.CACHE_TTL_MINUTES || 15)
    );

const RESULT_TTL_SECONDS =
    Math.max(
        10,
        Number(process.env.RESULT_TTL_SECONDS || 30)
    );

const DAILY_REQUEST_LIMIT =
    Math.max(
        1,
        Number(process.env.DAILY_REQUEST_LIMIT || 768)
    );

const SAFETY_RESERVE =
    Math.max(
        0,
        Number(process.env.SAFETY_RESERVE || 32)
    );

const MAX_DAILY_REQUESTS =
    Math.max(
        1,
        DAILY_REQUEST_LIMIT - SAFETY_RESERVE
    );

const ENTRY_BUFFER_SECONDS = 30;

const CACHE_TTL_MS =
    CACHE_TTL_MINUTES * 60 * 1000;

const RESULT_TTL_MS =
    RESULT_TTL_SECONDS * 1000;

const SCAN_EVERY_MS =
    SCAN_EVERY_MINUTES * 60 * 1000;


/* =========================================================
   STATE
========================================================= */

const pairCache = new Map();
const resultCache = new Map();

let scanRunning = false;
let scanCursor = 0;

let lastScanAt = null;
let lastScanError = null;

let totalScanned = 0;
let totalFailed = 0;
let totalApiRequests = 0;

let quotaBlocked = false;
let providerQuotaMessage = null;
let providerQuotaResetAt = null;

let dailyRequests = 0;
let dailyCreditsUsed = 0;
let currentUtcDay = getUtcDay();


/* =========================================================
   TIME HELPERS
========================================================= */

function getUtcDay(date = new Date()) {
    return date.toISOString().slice(0, 10);
}


function getNextUtcMidnight() {
    const now = new Date();

    return new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0,
            0,
            0,
            0
        )
    );
}


function resetDailyStateIfNeeded() {
    const today = getUtcDay();

    if (today !== currentUtcDay) {
        currentUtcDay = today;

        dailyRequests = 0;
        dailyCreditsUsed = 0;

        quotaBlocked = false;
        providerQuotaMessage = null;
        providerQuotaResetAt = null;

        lastScanError = null;
    }
}


function getRemainingRequestBudget() {
    resetDailyStateIfNeeded();

    return Math.max(
        0,
        MAX_DAILY_REQUESTS - dailyRequests
    );
}


/* =========================================================
   NORMALIZATION
========================================================= */

function normalizePair(pair) {
    return String(pair || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
}


function displayPair(pair) {
    const normalized = normalizePair(pair);

    if (
        normalized.length === 6 &&
        !normalized.includes('/')
    ) {
        return `${normalized.slice(0, 3)}/${normalized.slice(3)}`;
    }

    return normalized;
}


function isSupportedPair(pair) {
    const normalized = normalizePair(pair);

    return PAIRS.some(
        item => normalizePair(item) === normalized
    );
}


function normalizeTimeframe(value) {
    const n = Number(value);

    if (TIMEFRAMES.includes(n)) {
        return n;
    }

    return null;
}


/* =========================================================
   NUMBER HELPERS
========================================================= */

function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
}


function roundNumber(value, decimals = 6) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return null;
    }

    return Number(n.toFixed(decimals));
}


function clamp(value, min, max) {
    return Math.min(
        max,
        Math.max(min, value)
    );
}


function priceDecimals(pair) {
    return normalizePair(pair).includes('JPY')
        ? 3
        : 5;
}


function roundPrice(value, pair) {
    return roundNumber(
        value,
        priceDecimals(pair)
    );
}


/* =========================================================
   QUOTA
========================================================= */

function blockForProviderQuota(message) {
    quotaBlocked = true;

    providerQuotaMessage =
        String(message || 'Provider quota reached.');

    providerQuotaResetAt =
        getNextUtcMidnight().toISOString();

    lastScanError =
        providerQuotaMessage;
}


function providerErrorMessage(data) {
    if (!data) {
        return 'Twelve Data returned an empty response.';
    }

    return (
        data.message ||
        data.error ||
        `Twelve Data request failed.`
    );
}


function looksLikeQuotaError(message) {
    const text =
        String(message || '').toLowerCase();

    return (
        text.includes('quota') ||
        text.includes('credit') ||
        text.includes('rate limit') ||
        text.includes('daily limit') ||
        text.includes('too many requests') ||
        text.includes('api limit') ||
        text.includes('maximum')
    );
}


/* =========================================================
   CACHE
========================================================= */

function getCachedPair(pair, allowStale = false) {
    const key = normalizePair(pair);

    const cached = pairCache.get(key);

    if (!cached) {
        return null;
    }

    const age =
        Date.now() - cached.cachedAt;

    if (
        !allowStale &&
        age > CACHE_TTL_MS
    ) {
        return null;
    }

    return {
        ...cached,
        ageMs: Math.max(0, age),
        stale: age > CACHE_TTL_MS
    };
}


function setCachedPair(pair, candles) {
    const key = normalizePair(pair);

    pairCache.set(key, {
        pair: displayPair(pair),
        candles,
        cachedAt: Date.now()
    });
}


function resultCacheKey(pair, timeframe) {
    return `${normalizePair(pair)}:${Number(timeframe)}`;
}


function getCachedResult(pair, timeframe) {
    const key =
        resultCacheKey(pair, timeframe);

    const cached =
        resultCache.get(key);

    if (!cached) {
        return null;
    }

    const age =
        Date.now() - cached.cachedAt;

    if (age > RESULT_TTL_MS) {
        return null;
    }

    return {
        ...cached,
        ageMs: Math.max(0, age)
    };
}


function setCachedResult(pair, timeframe, result) {
    const key =
        resultCacheKey(pair, timeframe);

    resultCache.set(key, {
        result,
        cachedAt: Date.now()
    });
}


/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchTwelveData(pair) {
    resetDailyStateIfNeeded();

    if (quotaBlocked) {
        throw new Error(
            providerQuotaMessage ||
            'Twelve Data quota is temporarily blocked.'
        );
    }

    if (!TWELVE_DATA_API_KEY) {
        throw new Error(
            'TWELVE_DATA_API_KEY is not configured on the backend.'
        );
    }

    if (
        dailyRequests >= MAX_DAILY_REQUESTS
    ) {
        blockForProviderQuota(
            'Daily request safety budget reached. Scanner paused until the next UTC day.'
        );

        throw new Error(
            providerQuotaMessage
        );
    }

    const symbol =
        displayPair(pair);

    const params = new URLSearchParams({
        symbol,
        interval: '1min',
        outputsize: String(MAX_CANDLES),
        timezone: TIMEZONE,
        apikey: TWELVE_DATA_API_KEY
    });

    const url =
        `${TWELVE_DATA_URL}?${params.toString()}`;

    /*
      Count every provider request before sending it.
    */
    dailyRequests += 1;
    dailyCreditsUsed += 1;
    totalApiRequests += 1;

    const response =
        await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'User-Agent': 'PO-AI-Predictor/8.5'
            }
        });

    let data = null;

    try {
        data = await response.json();
    } catch (error) {
        throw new Error(
            `Twelve Data returned invalid JSON (HTTP ${response.status}).`
        );
    }

    if (
        !response.ok ||
        data?.status === 'error' ||
        data?.code ||
        data?.message
    ) {
        const message =
            providerErrorMessage(data);

        if (looksLikeQuotaError(message)) {
            blockForProviderQuota(message);
        }

        throw new Error(message);
    }

    if (
        !data ||
        !Array.isArray(data.values)
    ) {
        throw new Error(
            'Twelve Data returned no candle values.'
        );
    }

    const candles =
        data.values
            .map(item => ({
                time: new Date(item.datetime).getTime(),
                open: Number(item.open),
                high: Number(item.high),
                low: Number(item.low),
                close: Number(item.close),
                volume: isFiniteNumber(item.volume)
                    ? Number(item.volume)
                    : null
            }))
            .filter(candle =>
                Number.isFinite(candle.time) &&
                Number.isFinite(candle.open) &&
                Number.isFinite(candle.high) &&
                Number.isFinite(candle.low) &&
                Number.isFinite(candle.close)
            )
            .sort(
                (a, b) => a.time - b.time
            );

    if (candles.length < MIN_CANDLES) {
        throw new Error(
            `${symbol}: insufficient candle data (${candles.length}/${MIN_CANDLES}).`
        );
    }

    return candles.slice(-MAX_CANDLES);
}


/* =========================================================
   PAIR CANDLE ACCESS
========================================================= */

async function getPairCandles(
    pair,
    options = {}
) {
    const normalized =
        displayPair(pair);

    const forceRefresh =
        options.forceRefresh === true;

    /*
      Fresh cache.
    */
    if (!forceRefresh) {
        const fresh =
            getCachedPair(normalized, false);

        if (fresh) {
            return {
                candles: fresh.candles,
                cached: true,
                stale: false,
                cachedAt: new Date(
                    fresh.cachedAt
                ).toISOString()
            };
        }
    }

    /*
      If provider quota is blocked, use stale cache
      instead of making another provider request.
    */
    if (quotaBlocked) {
        const stale =
            getCachedPair(normalized, true);

        if (stale) {
            return {
                candles: stale.candles,
                cached: true,
                stale: true,
                cachedAt: new Date(
                    stale.cachedAt
                ).toISOString(),
                dataWarning:
                    'Using cached market data because the provider quota is currently blocked.'
            };
        }

        throw new Error(
            providerQuotaMessage ||
            'Provider quota is currently blocked and no cached data is available.'
        );
    }

    try {
        const candles =
            await fetchTwelveData(normalized);

        setCachedPair(
            normalized,
            candles
        );

        const cached =
            getCachedPair(normalized, true);

        return {
            candles,
            cached: false,
            stale: false,
            cachedAt: cached
                ? new Date(
                    cached.cachedAt
                ).toISOString()
                : new Date().toISOString()
        };

    } catch (error) {

        /*
          Never discard usable cache merely because
          a live provider request failed.
        */
        const stale =
            getCachedPair(normalized, true);

        if (stale) {
            return {
                candles: stale.candles,
                cached: true,
                stale: true,
                cachedAt: new Date(
                    stale.cachedAt
                ).toISOString(),
                dataWarning:
                    `Live refresh failed: ${error.message}. Using cached data.`
            };
        }

        throw error;
    }
}


/* =========================================================
   CANDLE AGGREGATION
========================================================= */

function aggregateCandles(
    candles,
    timeframe
) {
    const tf =
        Number(timeframe);

    if (tf === 1) {
        return candles.map(
            candle => ({ ...candle })
        );
    }

    const bucketMs =
        tf * 60 * 1000;

    const buckets = new Map();

    for (const candle of candles) {
        const bucket =
            Math.floor(
                candle.time / bucketMs
            ) * bucketMs;

        if (!buckets.has(bucket)) {
            buckets.set(bucket, {
                time: bucket,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                count: 1
            });
        } else {
            const item =
                buckets.get(bucket);

            item.high =
                Math.max(
                    item.high,
                    candle.high
                );

            item.low =
                Math.min(
                    item.low,
                    candle.low
                );

            item.close =
                candle.close;

            if (
                Number.isFinite(item.volume) &&
                Number.isFinite(candle.volume)
            ) {
                item.volume +=
                    candle.volume;
            } else {
                item.volume = null;
            }

            item.count += 1;
        }
    }

    return Array.from(
        buckets.values()
    )
        .sort(
            (a, b) => a.time - b.time
        )
        .filter(
            candle => candle.count >= tf
        );
}


/* =========================================================
   INDICATORS
========================================================= */

function ema(values, period) {
    if (
        !Array.isArray(values) ||
        values.length < period
    ) {
        return null;
    }

    const multiplier =
        2 / (period + 1);

    let previous =
        values
            .slice(0, period)
            .reduce(
                (sum, value) =>
                    sum + Number(value),
                0
            ) / period;

    for (
        let i = period;
        i < values.length;
        i++
    ) {
        previous =
            (
                Number(values[i]) -
                previous
            ) *
            multiplier +
            previous;
    }

    return previous;
}


function rsi(values, period = 14) {
    if (
        !Array.isArray(values) ||
        values.length <= period
    ) {
        return null;
    }

    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i++) {
        const change =
            Number(values[i]) -
            Number(values[i - 1]);

        if (change > 0) {
            gain += change;
        } else {
            loss += Math.abs(change);
        }
    }

    let avgGain =
        gain / period;

    let avgLoss =
        loss / period;

    for (
        let i = period + 1;
        i < values.length;
        i++
    ) {
        const change =
            Number(values[i]) -
            Number(values[i - 1]);

        const currentGain =
            change > 0 ? change : 0;

        const currentLoss =
            change < 0
                ? Math.abs(change)
                : 0;

        avgGain =
            (
                avgGain * (period - 1) +
                currentGain
            ) / period;

        avgLoss =
            (
                avgLoss * (period - 1) +
                currentLoss
            ) / period;
    }

    if (avgLoss === 0) {
        return 100;
    }

    const rs =
        avgGain / avgLoss;

    return 100 - (100 / (1 + rs));
}


function atr(candles, period = 14) {
    if (
        !Array.isArray(candles) ||
        candles.length <= period
    ) {
        return null;
    }

    const trueRanges = [];

    for (let i = 1; i < candles.length; i++) {
        const current = candles[i];
        const previous = candles[i - 1];

        const tr =
            Math.max(
                current.high - current.low,
                Math.abs(
                    current.high -
                    previous.close
                ),
                Math.abs(
                    current.low -
                    previous.close
                )
            );

        trueRanges.push(tr);
    }

    if (trueRanges.length < period) {
        return null;
    }

    let value =
        trueRanges
            .slice(0, period)
            .reduce(
                (sum, x) => sum + x,
                0
            ) / period;

    for (
        let i = period;
        i < trueRanges.length;
        i++
    ) {
        value =
            (
                value * (period - 1) +
                trueRanges[i]
            ) / period;
    }

    return value;
}


function adx(candles, period = 14) {
    if (
        !Array.isArray(candles) ||
        candles.length < period * 2 + 1
    ) {
        return null;
    }

    const trs = [];
    const plusDM = [];
    const minusDM = [];

    for (let i = 1; i < candles.length; i++) {
        const current = candles[i];
        const previous = candles[i - 1];

        const upMove =
            current.high -
            previous.high;

        const downMove =
            previous.low -
            current.low;

        const tr =
            Math.max(
                current.high - current.low,
                Math.abs(
                    current.high -
                    previous.close
                ),
                Math.abs(
                    current.low -
                    previous.close
                )
            );

        trs.push(tr);

        plusDM.push(
            upMove > downMove &&
            upMove > 0
                ? upMove
                : 0
        );

        minusDM.push(
            downMove > upMove &&
            downMove > 0
                ? downMove
                : 0
        );
    }

    if (trs.length < period) {
        return null;
    }

    let trSmooth =
        trs
            .slice(0, period)
            .reduce(
                (sum, x) => sum + x,
                0
            );

    let plusSmooth =
        plusDM
            .slice(0, period)
            .reduce(
                (sum, x) => sum + x,
                0
            );

    let minusSmooth =
        minusDM
            .slice(0, period)
            .reduce(
                (sum, x) => sum + x,
                0
            );

    const dxValues = [];

    for (
        let i = period;
        i < trs.length;
        i++
    ) {
        if (i > period) {
            trSmooth =
                trSmooth -
                trSmooth / period +
                trs[i];

            plusSmooth =
                plusSmooth -
                plusSmooth / period +
                plusDM[i];

            minusSmooth =
                minusSmooth -
                minusSmooth / period +
                minusDM[i];
        }

        const plusDI =
            trSmooth === 0
                ? 0
                : 100 *
                    (plusSmooth / trSmooth);

        const minusDI =
            trSmooth === 0
                ? 0
                : 100 *
                    (minusSmooth / trSmooth);

        const denominator =
            plusDI + minusDI;

        const dx =
            denominator === 0
                ? 0
                : 100 *
                    Math.abs(
                        plusDI - minusDI
                    ) /
                    denominator;

        dxValues.push(dx);
    }

    if (dxValues.length < period) {
        return null;
    }

    let adxValue =
        dxValues
            .slice(0, period)
            .reduce(
                (sum, x) => sum + x,
                0
            ) / period;

    for (
        let i = period;
        i < dxValues.length;
        i++
    ) {
        adxValue =
            (
                adxValue * (period - 1) +
                dxValues[i]
            ) / period;
    }

    return adxValue;
}


function standardDeviation(values) {
    if (
        !Array.isArray(values) ||
        values.length === 0
    ) {
        return null;
    }

    const mean =
        values.reduce(
            (sum, x) =>
                sum + Number(x),
            0
        ) / values.length;

    const variance =
        values.reduce(
            (sum, x) =>
                sum +
                Math.pow(
                    Number(x) - mean,
                    2
                ),
            0
        ) / values.length;

    return Math.sqrt(variance);
}


function bollinger(values, period = 20, multiplier = 2) {
    if (
        !Array.isArray(values) ||
        values.length < period
    ) {
        return null;
    }

    const recent =
        values.slice(-period);

    const middle =
        recent.reduce(
            (sum, x) =>
                sum + Number(x),
            0
        ) / period;

    const sd =
        standardDeviation(recent);

    if (!Number.isFinite(sd)) {
        return null;
    }

    return {
        upper:
            middle + multiplier * sd,
        middle,
        lower:
            middle - multiplier * sd
    };
}


function supportResistance(candles) {
    const recent =
        candles.slice(-50);

    if (!recent.length) {
        return {
            support: null,
            resistance: null
        };
    }

    return {
        support:
            Math.min(
                ...recent.map(
                    candle => candle.low
                )
            ),

        resistance:
            Math.max(
                ...recent.map(
                    candle => candle.high
                )
            )
    };
}


/* =========================================================
   CANDLE ANATOMY
========================================================= */

function candleAnatomy(candle) {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);

    const range =
        Math.max(0, high - low);

    const body =
        Math.abs(close - open);

    const upperWick =
        Math.max(
            0,
            high - Math.max(open, close)
        );

    const lowerWick =
        Math.max(
            0,
            Math.min(open, close) - low
        );

    const bodyRatio =
        range > 0
            ? body / range
            : 0;

    const closeLocation =
        range > 0
            ? (close - low) / range
            : 0.5;

    return {
        bullish: close > open,
        bearish: close < open,
        doji: bodyRatio <= 0.10,
        range,
        body,
        upperWick,
        lowerWick,
        bodyRatio,
        closeLocation
    };
}


/* =========================================================
   CANDLESTICK PATTERNS
========================================================= */

function detectCandlestickPatterns(candles) {
    if (
        !Array.isArray(candles) ||
        candles.length < 3
    ) {
        return [];
    }

    const patterns = [];

    const n =
        candles.length;

    const c1 = candles[n - 3];
    const c2 = candles[n - 2];
    const c3 = candles[n - 1];

    const a1 = candleAnatomy(c1);
    const a2 = candleAnatomy(c2);
    const a3 = candleAnatomy(c3);

    function add(
        name,
        direction,
        strength,
        description
    ) {
        patterns.push({
            name,
            direction,
            strength,
            description
        });
    }

    /*
      DOJI
    */
    if (a3.doji) {
        add(
            'Doji',
            'NEUTRAL',
            35,
            'The latest candle shows indecision between buyers and sellers.'
        );
    }

    /*
      HAMMER
    */
    if (
        a3.range > 0 &&
        a3.lowerWick >= Math.max(
            a3.body * 2,
            a3.range * 0.45
        ) &&
        a3.upperWick <=
            Math.max(
                a3.body * 1.25,
                a3.range * 0.12
            ) &&
        a3.closeLocation >= 0.60
    ) {
        add(
            'Hammer',
            'BULLISH',
            65,
            'The latest candle rejected lower prices and closed relatively near its high.'
        );
    }

    /*
      SHOOTING STAR
    */
    if (
        a3.range > 0 &&
        a3.upperWick >= Math.max(
            a3.body * 2,
            a3.range * 0.45
        ) &&
        a3.lowerWick <=
            Math.max(
                a3.body * 1.25,
                a3.range * 0.12
            ) &&
        a3.closeLocation <= 0.40
    ) {
        add(
            'Shooting Star',
            'BEARISH',
            65,
            'The latest candle rejected higher prices and closed relatively near its low.'
        );
    }

    /*
      BULLISH PIN BAR
    */
    if (
        a3.range > 0 &&
        a3.lowerWick >=
            a3.body * 2 &&
        a3.closeLocation >= 0.65
    ) {
        add(
            'Bullish Pin Bar',
            'BULLISH',
            60,
            'A long lower wick shows rejection of lower prices.'
        );
    }

    /*
      BEARISH PIN BAR
    */
    if (
        a3.range > 0 &&
        a3.upperWick >=
            a3.body * 2 &&
        a3.closeLocation <= 0.35
    ) {
        add(
            'Bearish Pin Bar',
            'BEARISH',
            60,
            'A long upper wick shows rejection of higher prices.'
        );
    }

    /*
      BULLISH ENGULFING
    */
    if (
        a2.bearish &&
        a3.bullish &&
        a3.body > 0 &&
        a2.body > 0 &&
        c3.open <= c2.close &&
        c3.close >= c2.open
    ) {
        add(
            'Bullish Engulfing',
            'BULLISH',
            80,
            'The latest bullish body engulfs the previous bearish body, showing a shift toward buyers.'
        );
    }

    /*
      BEARISH ENGULFING
    */
    if (
        a2.bullish &&
        a3.bearish &&
        a3.body > 0 &&
        a2.body > 0 &&
        c3.open >= c2.close &&
        c3.close <= c2.open
    ) {
        add(
            'Bearish Engulfing',
            'BEARISH',
            80,
            'The latest bearish body engulfs the previous bullish body, showing a shift toward sellers.'
        );
    }

    /*
      MORNING STAR
      FX often has no reliable gap, therefore the
      middle candle is evaluated mainly by small body.
    */
    const firstBearish =
        a1.bearish;

    const middleSmall =
        a2.bodyRatio <= 0.35;

    const finalBullish =
        a3.bullish;

    const finalIntoFirst =
        c3.close >
        (
            c1.open +
            c1.close
        ) / 2;

    if (
        firstBearish &&
        middleSmall &&
        finalBullish &&
        finalIntoFirst
    ) {
        add(
            'Morning Star',
            'BULLISH',
            75,
            'A three-candle structure shows selling pressure weakening and buyers recovering control.'
        );
    }

    /*
      EVENING STAR
    */
    const firstBullish =
        a1.bullish;

    const finalBearish =
        a3.bearish;

    const finalBelowFirst =
        c3.close <
        (
            c1.open +
            c1.close
        ) / 2;

    if (
        firstBullish &&
        middleSmall &&
        finalBearish &&
        finalBelowFirst
    ) {
        add(
            'Evening Star',
            'BEARISH',
            75,
            'A three-candle structure shows buying pressure weakening and sellers recovering control.'
        );
    }

    /*
      Keep strongest patterns first.
    */
    patterns.sort(
        (a, b) =>
            b.strength - a.strength
    );

    return patterns;
}


/* =========================================================
   CANDLE PATTERN SUMMARY
========================================================= */

function summarizePatterns(patterns) {
    if (!patterns.length) {
        return {
            direction: 'NEUTRAL',
            strength: 0,
            names: [],
            text:
                'No strong named candlestick pattern was detected in the latest candles.'
        };
    }

    let bullish = 0;
    let bearish = 0;

    for (const pattern of patterns) {
        if (pattern.direction === 'BULLISH') {
            bullish += pattern.strength;
        }

        if (pattern.direction === 'BEARISH') {
            bearish += pattern.strength;
        }
    }

    let direction = 'NEUTRAL';

    if (
        bullish > bearish &&
        bullish >= 50
    ) {
        direction = 'BULLISH';
    } else if (
        bearish > bullish &&
        bearish >= 50
    ) {
        direction = 'BEARISH';
    }

    const strongest =
        patterns[0];

    const difference =
        Math.abs(
            bullish - bearish
        );

    const strength =
        clamp(
            strongest.strength +
            Math.min(
                20,
                difference * 0.10
            ),
            0,
            100
        );

    return {
        direction,
        strength: Math.round(strength),
        bullishScore: Math.round(
            bullish
        ),
        bearishScore: Math.round(
            bearish
        ),
        names:
            patterns
                .slice(0, 3)
                .map(
                    pattern => pattern.name
                ),
        text:
            patterns
                .slice(0, 3)
                .map(
                    pattern =>
                        `${pattern.name}: ${pattern.description}`
                )
                .join(' ')
    };
}


/* =========================================================
   MARKET PSYCHOLOGY / PRICE ACTION
========================================================= */

function calculateMarketPsychology(
    candles,
    indicators
) {
    const recent =
        candles.slice(-10);

    if (!recent.length) {
        return {
            sentiment: 'BALANCED',
            buyerPressure: 50,
            sellerPressure: 50,
            conviction: 0,
            rejection: 'NONE',
            indecision: 0,
            score: 0,
            description:
                'Insufficient recent candle data.'
        };
    }

    let buyerPoints = 0;
    let sellerPoints = 0;

    let bullishCount = 0;
    let bearishCount = 0;
    let indecisionCount = 0;

    let bullishBody = 0;
    let bearishBody = 0;

    let lowerRejections = 0;
    let upperRejections = 0;

    for (const candle of recent) {
        const a =
            candleAnatomy(candle);

        if (a.bullish) {
            bullishCount += 1;
            bullishBody += a.bodyRatio;
        }

        if (a.bearish) {
            bearishCount += 1;
            bearishBody += a.bodyRatio;
        }

        if (a.doji) {
            indecisionCount += 1;
        }

        /*
          Body direction.
        */
        if (a.bullish) {
            buyerPoints +=
                1.5 * a.bodyRatio;
        }

        if (a.bearish) {
            sellerPoints +=
                1.5 * a.bodyRatio;
        }

        /*
          Close location.
        */
        buyerPoints +=
            Math.max(
                0,
                a.closeLocation - 0.50
            );

        sellerPoints +=
            Math.max(
                0,
                0.50 - a.closeLocation
            );

        /*
          Rejection.
        */
        if (
            a.lowerWick >
            Math.max(
                a.body * 1.5,
                a.range * 0.30
            )
        ) {
            lowerRejections += 1;
            buyerPoints += 0.7;
        }

        if (
            a.upperWick >
            Math.max(
                a.body * 1.5,
                a.range * 0.30
            )
        ) {
            upperRejections += 1;
            sellerPoints += 0.7;
        }
    }

    const totalPressure =
        buyerPoints +
        sellerPoints;

    let buyerPressure =
        totalPressure > 0
            ? 100 *
                buyerPoints /
                totalPressure
            : 50;

    let sellerPressure =
        totalPressure > 0
            ? 100 *
                sellerPoints /
                totalPressure
            : 50;

    buyerPressure =
        clamp(
            buyerPressure,
            0,
            100
        );

    sellerPressure =
        clamp(
            sellerPressure,
            0,
            100
        );

    /*
      Trend conviction:
      candle consistency + ADX.
    */
    const directionalCount =
        bullishCount +
        bearishCount;

    const consistency =
        directionalCount > 0
            ? Math.abs(
                bullishCount -
                bearishCount
            ) /
                directionalCount
            : 0;

    const adxValue =
        Number(indicators?.adx14);

    const adxComponent =
        Number.isFinite(adxValue)
            ? clamp(
                adxValue / 40,
                0,
                1
            )
            : 0;

    const conviction =
        Math.round(
            clamp(
                (
                    consistency * 0.55 +
                    adxComponent * 0.45
                ) * 100,
                0,
                100
            )
        );

    const indecision =
        Math.round(
            clamp(
                (
                    indecisionCount /
                    recent.length
                ) * 100,
                0,
                100
            )
        );

    let sentiment =
        'BALANCED';

    if (
        buyerPressure >= 58 &&
        buyerPressure > sellerPressure + 5
    ) {
        sentiment = 'BUYER DOMINANCE';
    } else if (
        sellerPressure >= 58 &&
        sellerPressure > buyerPressure + 5
    ) {
        sentiment = 'SELLER DOMINANCE';
    } else if (
        indecision >= 30
    ) {
        sentiment = 'INDECISION';
    }

    let rejection = 'NONE';

    if (
        lowerRejections >
        upperRejections
    ) {
        rejection =
            'LOWER-PRICE REJECTION';
    } else if (
        upperRejections >
        lowerRejections
    ) {
        rejection =
            'HIGHER-PRICE REJECTION';
    } else if (
        lowerRejections > 0 &&
        upperRejections > 0
    ) {
        rejection = 'TWO-SIDED REJECTION';
    }

    const pressureDifference =
        Math.abs(
            buyerPressure -
            sellerPressure
        );

    const score =
        Math.round(
            clamp(
                pressureDifference * 0.55 +
                conviction * 0.30 +
                (100 - indecision) * 0.15,
                0,
                100
            )
        );

    let description =
        'Buyer and seller pressure are relatively balanced.';

    if (
        sentiment === 'BUYER DOMINANCE'
    ) {
        description =
            `Recent candles show stronger buyer pressure (${Math.round(buyerPressure)}%) with ${conviction}% directional conviction.`;
    } else if (
        sentiment === 'SELLER DOMINANCE'
    ) {
        description =
            `Recent candles show stronger seller pressure (${Math.round(sellerPressure)}%) with ${conviction}% directional conviction.`;
    } else if (
        sentiment === 'INDECISION'
    ) {
        description =
            `Recent candles contain elevated indecision (${indecision}%), so directional conviction is limited.`;
    }

    if (rejection !== 'NONE') {
        description +=
            ` Recent price action also shows ${rejection.toLowerCase()}.`;
    }

    return {
        sentiment,
        buyerPressure:
            Math.round(buyerPressure),
        sellerPressure:
            Math.round(sellerPressure),
        conviction,
        rejection,
        indecision,
        score,
        recentCandles:
            recent.length,
        bullishCandles:
            bullishCount,
        bearishCandles:
            bearishCount,
        description
    };
}


/* =========================================================
   PATTERN + PSYCHOLOGY SCORE
========================================================= */

function calculateConfirmation(
    patternSummary,
    psychology,
    baseTrend
) {
    let call = 0;
    let put = 0;

    /*
      Pattern confirmation max contribution:
      approximately 15 points.
    */
    if (
        patternSummary.direction ===
        'BULLISH'
    ) {
        call +=
            Math.min(
                15,
                patternSummary.strength * 0.15
            );
    }

    if (
        patternSummary.direction ===
        'BEARISH'
    ) {
        put +=
            Math.min(
                15,
                patternSummary.strength * 0.15
            );
    }

    /*
      Psychology confirmation max contribution:
      approximately 10 points.
    */
    if (
        psychology.sentiment ===
        'BUYER DOMINANCE'
    ) {
        call +=
            Math.min(
                10,
                psychology.score * 0.10
            );
    }

    if (
        psychology.sentiment ===
        'SELLER DOMINANCE'
    ) {
        put +=
            Math.min(
                10,
                psychology.score * 0.10
            );
    }

    /*
      Do not reward psychology when market is clearly
      indecisive.
    */
    if (
        psychology.sentiment ===
        'INDECISION'
    ) {
        call *= 0.45;
        put *= 0.45;
    }

    /*
      Alignment bonus.
    */
    if (
        baseTrend === 'UPTREND' &&
        call > put
    ) {
        call += 2;
    }

    if (
        baseTrend === 'DOWNTREND' &&
        put > call
    ) {
        put += 2;
    }

    return {
        call: Math.round(
            clamp(call, 0, 17)
        ),
        put: Math.round(
            clamp(put, 0, 17)
        )
    };
}


/* =========================================================
   MARKET ANALYSIS
========================================================= */

function calculateMarketAnalysis(
    pair,
    timeframe,
    sourceCandles
) {
    const tf =
        Number(timeframe);

    const candles =
        aggregateCandles(
            sourceCandles,
            tf
        );

    if (candles.length < MIN_CANDLES) {
        throw new Error(
            `${pair} ${tf}m: insufficient aggregated candles (${candles.length}/${MIN_CANDLES}).`
        );
    }

    const closes =
        candles.map(
            candle => candle.close
        );

    const currentPrice =
        closes[closes.length - 1];

    const ema9 =
        ema(closes, 9);

    const ema21 =
        ema(closes, 21);

    const rsi14 =
        rsi(closes, 14);

    const adx14 =
        adx(candles, 14);

    const atr14 =
        atr(candles, 14);

    const bb =
        bollinger(
            closes,
            20,
            2
        );

    const sr =
        supportResistance(
            candles
        );

    if (
        !Number.isFinite(ema9) ||
        !Number.isFinite(ema21) ||
        !Number.isFinite(rsi14)
    ) {
        throw new Error(
            `${pair} ${tf}m: indicator calculation incomplete.`
        );
    }

    let callScore = 0;
    let putScore = 0;

    const reasons = [];

    /*
      =======================================================
      1. EMA TREND
      =======================================================
    */
    let baseTrend = 'RANGING';

    if (ema9 > ema21) {
        callScore += 30;
        baseTrend = 'UPTREND';

        reasons.push(
            'EMA9 is above EMA21, supporting bullish direction.'
        );
    } else if (ema9 < ema21) {
        putScore += 30;
        baseTrend = 'DOWNTREND';

        reasons.push(
            'EMA9 is below EMA21, supporting bearish direction.'
        );
    } else {
        reasons.push(
            'EMA9 and EMA21 are closely aligned.'
        );
    }

    /*
      =======================================================
      2. RSI
      =======================================================
    */
    if (
        rsi14 >= 52 &&
        rsi14 <= 68
    ) {
        callScore += 20;

        reasons.push(
            `RSI14 ${rsi14.toFixed(1)} supports bullish momentum without being deeply overbought.`
        );
    } else if (
        rsi14 >= 32 &&
        rsi14 <= 48
    ) {
        putScore += 20;

        reasons.push(
            `RSI14 ${rsi14.toFixed(1)} supports bearish momentum without being deeply oversold.`
        );
    } else if (
        rsi14 > 70
    ) {
        putScore += 8;

        reasons.push(
            `RSI14 ${rsi14.toFixed(1)} is overbought, adding a limited bearish reversal factor.`
        );
    } else if (
        rsi14 < 30
    ) {
        callScore += 8;

        reasons.push(
            `RSI14 ${rsi14.toFixed(1)} is oversold, adding a limited bullish reversal factor.`
        );
    }

    /*
      =======================================================
      3. MOMENTUM
      =======================================================
    */
    const momentumLookback =
        Math.min(
            5,
            closes.length - 1
        );

    const momentum =
        currentPrice -
        closes[
            closes.length -
            1 -
            momentumLookback
        ];

    if (momentum > 0) {
        callScore += 20;

        reasons.push(
            'Recent candle momentum is positive.'
        );
    } else if (momentum < 0) {
        putScore += 20;

        reasons.push(
            'Recent candle momentum is negative.'
        );
    }

    /*
      =======================================================
      4. ADX
      =======================================================
    */
    if (
        Number.isFinite(adx14)
    ) {
        if (adx14 >= 20) {
            if (
                baseTrend === 'UPTREND'
            ) {
                callScore += 15;

                reasons.push(
                    `ADX14 ${adx14.toFixed(1)} supports meaningful trend strength.`
                );
            } else if (
                baseTrend === 'DOWNTREND'
            ) {
                putScore += 15;

                reasons.push(
                    `ADX14 ${adx14.toFixed(1)} supports meaningful trend strength.`
                );
            }
        } else {
            reasons.push(
                `ADX14 ${adx14.toFixed(1)} indicates relatively weak trend strength.`
            );
        }
    }

    /*
      =======================================================
      5. SUPPORT / RESISTANCE
      =======================================================
    */
    if (
        Number.isFinite(sr.support) &&
        Number.isFinite(sr.resistance) &&
        sr.resistance > sr.support
    ) {
        const position =
            (
                currentPrice -
                sr.support
            ) /
            (
                sr.resistance -
                sr.support
            );

        if (
            baseTrend === 'UPTREND' &&
            position < 0.78
        ) {
            callScore += 10;

            reasons.push(
                'Price structure leaves room below the recent resistance zone.'
            );
        }

        if (
            baseTrend === 'DOWNTREND' &&
            position > 0.22
        ) {
            putScore += 10;

            reasons.push(
                'Price structure leaves room above the recent support zone.'
            );
        }
    }

    /*
      =======================================================
      6. MARKET CONDITION
      =======================================================
    */
    let marketCondition =
        baseTrend;

    if (
        bb &&
        currentPrice > 0
    ) {
        const width =
            (
                bb.upper -
                bb.lower
            ) /
            currentPrice;

        if (width < 0.0008) {
            marketCondition =
                'LOW_VOLATILITY_RANGE';
        } else if (
            baseTrend === 'UPTREND'
        ) {
            marketCondition =
                'UPTREND';
        } else if (
            baseTrend === 'DOWNTREND'
        ) {
            marketCondition =
                'DOWNTREND';
        } else {
            marketCondition =
                'RANGING';
        }
    }

    /*
      =======================================================
      7. CANDLESTICK PATTERNS
      =======================================================
    */
    const candlestickPatterns =
        detectCandlestickPatterns(
            candles
        );

    const patternSummary =
        summarizePatterns(
            candlestickPatterns
        );

    /*
      =======================================================
      8. MARKET PSYCHOLOGY
      =======================================================
    */
    const marketPsychology =
        calculateMarketPsychology(
            candles,
            {
                adx14,
                ema9,
                ema21
            }
        );

    /*
      =======================================================
      9. PATTERN + PSYCHOLOGY CONFIRMATION
      =======================================================
    */
    const confirmation =
        calculateConfirmation(
            patternSummary,
            marketPsychology,
            baseTrend
        );

    callScore +=
        confirmation.call;

    putScore +=
        confirmation.put;

    /*
      Explain pattern contribution.
    */
    if (
        patternSummary.direction ===
        'BULLISH'
    ) {
        reasons.push(
            `Candlestick confirmation is bullish: ${patternSummary.names.join(', ')}.`
        );
    } else if (
        patternSummary.direction ===
        'BEARISH'
    ) {
        reasons.push(
            `Candlestick confirmation is bearish: ${patternSummary.names.join(', ')}.`
        );
    } else {
        reasons.push(
            'Candlestick patterns do not provide a strong directional confirmation.'
        );
    }

    /*
      Explain psychology.
    */
    if (
        marketPsychology.sentiment ===
        'BUYER DOMINANCE'
    ) {
        reasons.push(
            `Price-action psychology shows buyer pressure at ${marketPsychology.buyerPressure}%.`
        );
    } else if (
        marketPsychology.sentiment ===
        'SELLER DOMINANCE'
    ) {
        reasons.push(
            `Price-action psychology shows seller pressure at ${marketPsychology.sellerPressure}%.`
        );
    } else {
        reasons.push(
            `Price-action psychology is ${marketPsychology.sentiment.toLowerCase()}, limiting directional confirmation.`
        );
    }

    /*
      =======================================================
      10. DECISION
      =======================================================
    */

    const strongest =
        Math.max(
            callScore,
            putScore
        );

    const difference =
        Math.abs(
            callScore -
            putScore
        );

    let signal =
        'NO TRADE';

    if (
        strongest >= 65 &&
        difference >= 15
    ) {
        signal =
            callScore > putScore
                ? 'CALL'
                : 'PUT';
    }

    /*
      Confidence.
      Pattern/psychology can strengthen a setup,
      but cannot force a signal.
    */
    let confidence = 0;

    if (signal === 'CALL') {
        confidence =
            clamp(
                Math.round(
                    50 +
                    callScore * 0.45 +
                    difference * 0.25
                ),
                70,
                95
            );
    } else if (
        signal === 'PUT'
    ) {
        confidence =
            clamp(
                Math.round(
                    50 +
                    putScore * 0.45 +
                    difference * 0.25
                ),
                70,
                95
            );
    } else {
        confidence =
            clamp(
                Math.round(
                    40 +
                    strongest * 0.30
                ),
                40,
                69
            );

        reasons.push(
            'Signals are not sufficiently aligned for a high-confidence directional setup.'
        );
    }

    /*
      =======================================================
      11. ENTRY / EXPIRY
      =======================================================
    */

    const now =
        new Date();

    const timeframeMs =
        tf * 60 * 1000;

    let entryMs =
        Math.floor(
            now.getTime() /
            timeframeMs
        ) *
            timeframeMs +
        timeframeMs;

    let entryInSeconds =
        Math.floor(
            (
                entryMs -
                now.getTime()
            ) / 1000
        );

    /*
      Guarantee at least 30 seconds
      before the entry.
    */
    if (
        entryInSeconds <
        ENTRY_BUFFER_SECONDS
    ) {
        entryMs +=
            timeframeMs;

        entryInSeconds =
            Math.floor(
                (
                    entryMs -
                    now.getTime()
                ) / 1000
            );
    }

    const expiryMs =
        entryMs +
        timeframeMs;

    const entryTime =
        new Date(
            entryMs
        ).toISOString();

    const expiryTime =
        new Date(
            expiryMs
        ).toISOString();

    /*
      Last actual candle time.
    */
    const lastCandle =
        candles[
            candles.length - 1
        ];

    /*
      Pattern score direction.
    */
    const patternScore =
        patternSummary.direction ===
        'BULLISH'
            ? confirmation.call
            : patternSummary.direction ===
                'BEARISH'
                ? confirmation.put
                : 0;

    const psychologyScore =
        marketPsychology.sentiment ===
        'BUYER DOMINANCE'
            ? confirmation.call
            : marketPsychology.sentiment ===
                'SELLER DOMINANCE'
                ? confirmation.put
                : 0;

    return {
        pair:
            displayPair(pair),

        timeframe:
            tf,

        signal,

        confidence,

        currentPrice:
            roundPrice(
                currentPrice,
                pair
            ),

        entryTime,

        expiryTime,

        entryInSeconds,

        lastCandle:
            lastCandle
                ? new Date(
                    lastCandle.time
                ).toISOString()
                : null,

        marketCondition,

        callScore:
            Math.round(
                clamp(
                    callScore,
                    0,
                    100
                )
            ),

        putScore:
            Math.round(
                clamp(
                    putScore,
                    0,
                    100
                )
            ),

        indicators: {
            ema9:
                roundPrice(
                    ema9,
                    pair
                ),

            ema21:
                roundPrice(
                    ema21,
                    pair
                ),

            rsi14:
                roundNumber(
                    rsi14,
                    2
                ),

            adx14:
                roundNumber(
                    adx14,
                    2
                ),

            atr14:
                roundPrice(
                    atr14,
                    pair
                ),

            support:
                roundPrice(
                    sr.support,
                    pair
                ),

            resistance:
                roundPrice(
                    sr.resistance,
                    pair
                ),

            bollinger: bb
                ? {
                    upper:
                        roundPrice(
                            bb.upper,
                            pair
                        ),

                    middle:
                        roundPrice(
                            bb.middle,
                            pair
                        ),

                    lower:
                        roundPrice(
                            bb.lower,
                            pair
                        )
                }
                : null
        },

        /*
          =====================================================
          NEW V8.5 DATA
          =====================================================
        */

        candlestickPatterns,

        patternSummary,

        patternScore,

        marketPsychology,

        psychologyScore,

        confirmation: {
            pattern:
                patternScore,

            psychology:
                psychologyScore,

            total:
                Math.round(
                    patternScore +
                    psychologyScore
                )
        },

        candles:
            candles.length,

        source:
            'Twelve Data LIVE',

        timezone:
            TIMEZONE,

        analysisTime:
            new Date().toISOString(),

        reasons:
            reasons
                .slice(0, 10)
    };
}


/* =========================================================
   RESULT RANKING
========================================================= */

function rankResult(result) {
    if (!result) {
        return -Infinity;
    }

    const confidence =
        Number(result.confidence || 0);

    const callScore =
        Number(result.callScore || 0);

    const putScore =
        Number(result.putScore || 0);

    const difference =
        Math.abs(
            callScore -
            putScore
        );

    if (
        result.signal ===
        'NO TRADE'
    ) {
        return (
            confidence * 0.35 +
            Number(
                result.psychologyScore || 0
            ) * 0.10
        );
    }

    let score =
        confidence +
        difference * 0.60;

    /*
      Trend alignment.
    */
    if (
        result.signal === 'CALL' &&
        result.marketCondition ===
            'UPTREND'
    ) {
        score += 8;
    }

    if (
        result.signal === 'PUT' &&
        result.marketCondition ===
            'DOWNTREND'
    ) {
        score += 8;
    }

    /*
      Strong ADX.
    */
    if (
        Number(
            result.indicators?.adx14
        ) >= 25
    ) {
        score += 5;
    }

    /*
      Candlestick confirmation.
    */
    if (
        result.signal === 'CALL' &&
        result.patternSummary?.direction ===
            'BULLISH'
    ) {
        score += 5;
    }

    if (
        result.signal === 'PUT' &&
        result.patternSummary?.direction ===
            'BEARISH'
    ) {
        score += 5;
    }

    /*
      Psychology confirmation.
    */
    if (
        result.signal === 'CALL' &&
        result.marketPsychology?.sentiment ===
            'BUYER DOMINANCE'
    ) {
        score += 4;
    }

    if (
        result.signal === 'PUT' &&
        result.marketPsychology?.sentiment ===
            'SELLER DOMINANCE'
    ) {
        score += 4;
    }

    return score;
}


function chooseBest(results) {
    const valid =
        results.filter(Boolean);

    if (!valid.length) {
        return null;
    }

    return valid
        .slice()
        .sort(
            (a, b) =>
                rankResult(b) -
                rankResult(a)
        )[0];
}


/* =========================================================
   ANALYZE ONE PAIR
========================================================= */

async function analyzePair(
    pair,
    options = {}
) {
    const normalized =
        displayPair(pair);

    if (
        !isSupportedPair(normalized)
    ) {
        throw new Error(
            `${normalized}: unsupported pair.`
        );
    }

    const forceRefresh =
        options.forceRefresh === true;

    const pairData =
        await getPairCandles(
            normalized,
            {
                forceRefresh
            }
        );

    const results = [];

    for (const timeframe of TIMEFRAMES) {

        if (!forceRefresh) {
            const cached =
                getCachedResult(
                    normalized,
                    timeframe
                );

            if (cached) {
                results.push(
                    {
                        ...cached.result,
                        cacheAgeSeconds:
                            Math.floor(
                                cached.ageMs / 1000
                            ),
                        dataCached: true
                    }
                );

                continue;
            }
        }

        const result =
            calculateMarketAnalysis(
                normalized,
                timeframe,
                pairData.candles
            );

        result.dataCached =
            pairData.cached;

        result.dataStale =
            pairData.stale;

        if (
            pairData.dataWarning
        ) {
            result.dataWarning =
                pairData.dataWarning;
        }

        setCachedResult(
            normalized,
            timeframe,
            result
        );

        results.push(result);
    }

    return {
        pair:
            normalized,

        source:
            'Twelve Data LIVE',

        cached:
            pairData.cached,

        stale:
            pairData.stale,

        cachedAt:
            pairData.cachedAt,

        dataWarning:
            pairData.dataWarning ||
            null,

        results
    };
}


/* =========================================================
   SCANNER
========================================================= */

async function scanBatch() {
    resetDailyStateIfNeeded();

    if (scanRunning) {
        return {
            ok: true,
            alreadyRunning: true,
            message:
                'Scanner is already running.'
        };
    }

    if (quotaBlocked) {
        return {
            ok: false,
            quotaBlocked: true,
            error:
                providerQuotaMessage ||
                'Provider quota is blocked.'
        };
    }

    if (
        getRemainingRequestBudget() <= 0
    ) {
        blockForProviderQuota(
            'Daily request safety budget reached. Scanner paused until the next UTC day.'
        );

        return {
            ok: false,
            quotaBlocked: true,
            error:
                providerQuotaMessage
        };
    }

    scanRunning = true;
    lastScanError = null;

    const startCursor =
        scanCursor;

    const batch = [];

    for (
        let i = 0;
        i < SCAN_BATCH_SIZE;
        i++
    ) {
        const index =
            (
                startCursor + i
            ) % PAIRS.length;

        batch.push(
            PAIRS[index]
        );
    }

    let scanned = 0;
    let failed = 0;

    const errors = [];

    try {
        for (const pair of batch) {

            if (quotaBlocked) {
                break;
            }

            try {
                await analyzePair(
                    pair,
                    {
                        forceRefresh: true
                    }
                );

                scanned += 1;
                totalScanned += 1;

            } catch (error) {
                failed += 1;
                totalFailed += 1;

                const message =
                    `${pair}: ${error.message}`;

                errors.push(
                    message
                );

                /*
                  Continue scanning other pairs.
                  A symbol/provider error must not kill
                  the entire scanner.
                */
                lastScanError =
                    message;
            }
        }

        scanCursor =
            (
                startCursor +
                batch.length
            ) % PAIRS.length;

        lastScanAt =
            new Date().toISOString();

    } finally {
        scanRunning = false;
    }

    return {
        ok:
            !quotaBlocked,

        scanned,

        failed,

        batch,

        nextCursor:
            scanCursor,

        quotaBlocked,

        errors,

        lastScanAt
    };
}


/* =========================================================
   ROUTES
========================================================= */

app.get(
    '/',
    (req, res) => {
        res.json({
            ok: true,
            service:
                'PO AI Predictor API',

            version:
                VERSION,

            source:
                'Twelve Data LIVE',

            timezone:
                TIMEZONE,

            endpoints: [
                '/api/health',
                '/api/scan/status',
                '/api/scan',
                '/api/analyze?pair=EUR/USD',
                '/api/best',
                '/api/selected'
            ]
        });
    }
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
    '/api/health',
    (req, res) => {
        resetDailyStateIfNeeded();

        res.json({
            ok: true,

            version:
                VERSION,

            source:
                'Twelve Data LIVE',

            timezone:
                TIMEZONE,

            pairs:
                PAIRS.length,

            supportedTimeframes:
                TIMEFRAMES,

            cachedPairs:
                pairCache.size,

            cachedResults:
                resultCache.size,

            scanRunning,

            scanCursor,

            scanBatchSize:
                SCAN_BATCH_SIZE,

            lastScanAt,

            lastScanError,

            totalScanned,

            totalFailed,

            totalApiRequests,

            quotaBlocked,

            providerQuotaMessage,

            providerQuotaResetAt,

            dailyRequests,

            dailyCreditsUsed,

            apiBudget: {
                dailyLimit:
                    DAILY_REQUEST_LIMIT,

                safetyReserve:
                    SAFETY_RESERVE,

                maxDailyRequests:
                    MAX_DAILY_REQUESTS,

                used:
                    dailyRequests,

                remaining:
                    getRemainingRequestBudget()
            },

            cacheTTLMinutes:
                CACHE_TTL_MINUTES,

            resultTTLSeconds:
                RESULT_TTL_SECONDS,

            scanEveryMinutes:
                SCAN_EVERY_MINUTES,

            time:
                new Date().toISOString()
        });
    }
);


/* =========================================================
   SCAN STATUS
========================================================= */

app.get(
    '/api/scan/status',
    (req, res) => {
        resetDailyStateIfNeeded();

        res.json({
            ok: true,

            version:
                VERSION,

            scanRunning,

            scanCursor,

            scanBatchSize:
                SCAN_BATCH_SIZE,

            pairs:
                PAIRS.length,

            cachedPairs:
                pairCache.size,

            cachedResults:
                resultCache.size,

            lastScanAt,

            lastScanError,

            quotaBlocked,

            providerQuotaMessage,

            providerQuotaResetAt,

            dailyRequests,

            dailyCreditsUsed,

            remainingBudget:
                getRemainingRequestBudget(),

            time:
                new Date().toISOString()
        });
    }
);


/* =========================================================
   MANUAL SCAN
========================================================= */

app.get(
    '/api/scan',
    async (req, res) => {
        try {
            const result =
                await scanBatch();

            if (
                result.quotaBlocked
            ) {
                return res
                    .status(429)
                    .json(result);
            }

            return res.json(result);

        } catch (error) {
            scanRunning = false;

            lastScanError =
                error.message;

            return res
                .status(500)
                .json({
                    ok: false,
                    error:
                        error.message
                });
        }
    }
);


/* =========================================================
   ANALYZE SPECIFIC PAIR
========================================================= */

app.get(
    '/api/analyze',
    async (req, res) => {
        const pair =
            displayPair(
                req.query.pair
            );

        if (!pair) {
            return res
                .status(400)
                .json({
                    ok: false,
                    error:
                        'Missing pair parameter.'
                });
        }

        if (
            !isSupportedPair(pair)
        ) {
            return res
                .status(400)
                .json({
                    ok: false,
                    error:
                        `${pair} is not in the supported live pair list.`,
                    supportedPairs:
                        PAIRS
                });
        }

        const refresh =
            String(
                req.query.refresh || ''
            ) === '1';

        try {
            const data =
                await analyzePair(
                    pair,
                    {
                        forceRefresh:
                            refresh
                    }
                );

            return res.json({
                ok: true,
                ...data
            });

        } catch (error) {

            if (
                quotaBlocked
            ) {
                return res
                    .status(429)
                    .json({
                        ok: false,
                        quotaBlocked: true,
                        error:
                            error.message,
                        resetAt:
                            providerQuotaResetAt
                    });
            }

            return res
                .status(500)
                .json({
                    ok: false,
                    error:
                        error.message
                });
        }
    }
);


/* =========================================================
   BEST MARKET
========================================================= */

app.get(
    '/api/best',
    async (req, res) => {
        resetDailyStateIfNeeded();

        try {

            /*
              First use only fresh result cache.
              This prevents every frontend click from
              immediately consuming a Twelve Data request.
            */
            const cachedResults = [];

            for (const pair of PAIRS) {
                for (
                    const timeframe of TIMEFRAMES
                ) {
                    const cached =
                        getCachedResult(
                            pair,
                            timeframe
                        );

                    if (cached) {
                        cachedResults.push(
                            {
                                ...cached.result,
                                cacheAgeSeconds:
                                    Math.floor(
                                        cached.ageMs /
                                        1000
                                    ),
                                dataCached: true
                            }
                        );
                    }
                }
            }

            let results =
                cachedResults;

            /*
              If nothing is available, perform exactly
              one controlled scan batch.
            */
            if (!results.length) {

                if (quotaBlocked) {
                    return res
                        .status(429)
                        .json({
                            ok: false,
                            quotaBlocked: true,
                            error:
                                providerQuotaMessage ||
                                'Provider quota is blocked.'
                        });
                }

                const scan =
                    await scanBatch();

                if (
                    scan.quotaBlocked
                ) {
                    return res
                        .status(429)
                        .json({
                            ok: false,
                            ...scan
                        });
                }

                /*
                  Read fresh results generated by scan.
                */
                results = [];

                for (
                    const pair of scan.batch
                ) {
                    for (
                        const timeframe of TIMEFRAMES
                    ) {
                        const cached =
                            getCachedResult(
                                pair,
                                timeframe
                            );

                        if (cached) {
                            results.push(
                                cached.result
                            );
                        }
                    }
                }
            }

            const best =
                chooseBest(results);

            if (!best) {
                return res.json({
                    ok: true,
                    selectedMarket: null,
                    scannedResults:
                        results.length,
                    message:
                        'No market result is currently available.'
                });
            }

            return res.json({
                ok: true,

                selectedMarket:
                    best,

                selected:
                    best,

                best,

                scannedResults:
                    results.length,

                source:
                    'Twelve Data LIVE',

                time:
                    new Date().toISOString()
            });

        } catch (error) {

            if (
                quotaBlocked
            ) {
                return res
                    .status(429)
                    .json({
                        ok: false,
                        quotaBlocked: true,
                        error:
                            providerQuotaMessage ||
                            error.message
                    });
            }

            return res
                .status(500)
                .json({
                    ok: false,
                    error:
                        error.message
                });
        }
    }
);


/* =========================================================
   SELECTED COMPATIBILITY ROUTE
========================================================= */

app.get(
    '/api/selected',
    (req, res) => {
        resetDailyStateIfNeeded();

        const results = [];

        for (const pair of PAIRS) {
            for (
                const timeframe of TIMEFRAMES
            ) {
                const cached =
                    getCachedResult(
                        pair,
                        timeframe
                    );

                if (cached) {
                    results.push(
                        cached.result
                    );
                }
            }
        }

        const best =
            chooseBest(results);

        res.json({
            ok: true,

            selectedMarket:
                best || null,

            selected:
                best || null,

            source:
                'Twelve Data LIVE',

            cached:
                true,

            scannedResults:
                results.length,

            time:
                new Date().toISOString()
        });
    }
);


/* =========================================================
   404
========================================================= */

app.use(
    (req, res) => {
        res.status(404).json({
            ok: false,
            error:
                'Endpoint not found.'
        });
    }
);


/* =========================================================
   SERVER
========================================================= */

app.listen(
    PORT,
    () => {
        console.log(
            '================================================'
        );

        console.log(
            `PO AI PREDICTOR ${VERSION}`
        );

        console.log(
            `PORT: ${PORT}`
        );

        console.log(
            `SOURCE: Twelve Data LIVE`
        );

        console.log(
            `TIMEZONE: ${TIMEZONE}`
        );

        console.log(
            `PAIRS: ${PAIRS.length}`
        );

        console.log(
            `TIMEFRAMES: ${TIMEFRAMES.join(', ')}`
        );

        console.log(
            `SCAN BATCH: ${SCAN_BATCH_SIZE}`
        );

        console.log(
            `CACHE TTL: ${CACHE_TTL_MINUTES} minutes`
        );

        console.log(
            `RESULT TTL: ${RESULT_TTL_SECONDS} seconds`
        );

        console.log(
            `DAILY REQUEST LIMIT: ${DAILY_REQUEST_LIMIT}`
        );

        console.log(
            `SAFETY RESERVE: ${SAFETY_RESERVE}`
        );

        console.log(
            `API KEY CONFIGURED: ${Boolean(TWELVE_DATA_API_KEY)}`
        );

        console.log(
            '================================================'
        );
    }
);


/* =========================================================
   AUTOMATIC SCANNER
========================================================= */

setTimeout(
    async () => {
        try {
            if (
                !quotaBlocked &&
                !scanRunning
            ) {
                await scanBatch();
            }
        } catch (error) {
            lastScanError =
                error.message;

            console.error(
                '[INITIAL SCAN]',
                error.message
            );
        }
    },
    10000
);


setInterval(
    async () => {
        resetDailyStateIfNeeded();

        if (
            quotaBlocked ||
            scanRunning
        ) {
            return;
        }

        try {
            await scanBatch();
        } catch (error) {
            lastScanError =
                error.message;

            console.error(
                '[AUTO SCAN]',
                error.message
            );
        }
    },
    SCAN_EVERY_MS
);
