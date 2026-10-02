'use strict';

/*
===========================================================
 PO AI PREDICTOR
 V8.6 • QUOTA-SAFE SMART LIVE SCANNER
 Stochastic + CCI + Candlestick Price Action
 Automatic WIN / LOSS / DRAW tracking

 SOURCE: Twelve Data LIVE

 IMPORTANT:
 "Market Psychology" is inferred from OHLC price action.
 It is NOT direct trader sentiment or order-book data.

 IMPORTANT ABOUT RESULTS:
 WIN/LOSS is measured from actual candle prices after the
 signal's entry/expiry window. It is performance tracking,
 not a guarantee of future results.
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

const VERSION = 'V8.6';

const PORT = Number(
    process.env.PORT || 10000
);

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
    Math.max(
        100,
        Number(
            process.env.MAX_CANDLES || 180
        )
    );

const MIN_CANDLES =
    Math.max(
        50,
        Number(
            process.env.MIN_CANDLES || 60
        )
    );

/*
  Your Twelve Data limit is 8 credits/minute.
  We intentionally use 7 and keep 1 as reserve.
*/
const SCAN_BATCH_SIZE =
    Math.max(
        1,
        Number(
            process.env.SCAN_BATCH_SIZE || 7
        )
    );

const SCAN_EVERY_MINUTES =
    Math.max(
        1,
        Number(
            process.env.SCAN_EVERY_MINUTES || 15
        )
    );

const CACHE_TTL_MINUTES =
    Math.max(
        1,
        Number(
            process.env.CACHE_TTL_MINUTES || 15
        )
    );

const RESULT_TTL_SECONDS =
    Math.max(
        10,
        Number(
            process.env.RESULT_TTL_SECONDS || 30
        )
    );

const DAILY_REQUEST_LIMIT =
    Math.max(
        1,
        Number(
            process.env.DAILY_REQUEST_LIMIT || 768
        )
    );

const SAFETY_RESERVE =
    Math.max(
        0,
        Number(
            process.env.SAFETY_RESERVE || 32
        )
    );

const MAX_DAILY_REQUESTS =
    Math.max(
        1,
        DAILY_REQUEST_LIMIT -
        SAFETY_RESERVE
    );

/*
  Provider limit:
  8 credits/minute available.
  We intentionally reserve one.
*/
const PROVIDER_MINUTE_LIMIT =
    Math.max(
        1,
        Number(
            process.env.PROVIDER_MINUTE_LIMIT || 7
        )
    );

const ENTRY_BUFFER_SECONDS = 30;

const HISTORY_LIMIT = 100;

const CACHE_TTL_MS =
    CACHE_TTL_MINUTES *
    60 *
    1000;

const RESULT_TTL_MS =
    RESULT_TTL_SECONDS *
    1000;

const SCAN_EVERY_MS =
    SCAN_EVERY_MINUTES *
    60 *
    1000;


/* =========================================================
   STATE
========================================================= */

const pairCache = new Map();

const resultCache = new Map();

/*
  Signal registry:
  key = pair + timeframe + entry + direction
*/
const signalRegistry = new Map();

const signalKeyRegistry = new Map();

const providerRequestTimes = [];

const signalHistory = [];

let signalSequence = 0;

let scanRunning = false;

let scanCursor = 0;

let lastScanAt = null;

let lastScanError = null;

let totalScanned = 0;

let totalFailed = 0;

let totalApiRequests = 0;

/*
  Daily quota block.
*/
let quotaBlocked = false;

let providerQuotaMessage = null;

let providerQuotaResetAt = null;

/*
  Minute-level quota block.
  IMPORTANT:
  This does NOT permanently block the system.
  It waits only until the next minute.
*/
let minuteBlockedUntil = 0;

let dailyRequests = 0;

let dailyCreditsUsed = 0;

let currentUtcDay =
    getUtcDay();


/* =========================================================
   TIME / BUDGET HELPERS
========================================================= */

function getUtcDay(
    date = new Date()
) {
    return date
        .toISOString()
        .slice(0, 10);
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


function getNextMinuteBoundary(
    date = new Date()
) {
    return new Date(
        Math.floor(
            date.getTime() /
            60000
        ) *
        60000 +
        60000
    );
}


function resetDailyStateIfNeeded() {
    const today =
        getUtcDay();

    if (
        today !==
        currentUtcDay
    ) {
        currentUtcDay =
            today;

        dailyRequests = 0;

        dailyCreditsUsed = 0;

        quotaBlocked = false;

        providerQuotaMessage =
            null;

        providerQuotaResetAt =
            null;

        minuteBlockedUntil = 0;

        lastScanError = null;
    }
}


function cleanupProviderRequestTimes() {
    const cutoff =
        Date.now() - 60000;

    while (
        providerRequestTimes.length &&
        providerRequestTimes[0] <=
            cutoff
    ) {
        providerRequestTimes.shift();
    }
}


/*
  FIX FROM V8.5:
  This function was missing in the previous code.
*/
function getRemainingRequestBudget() {
    resetDailyStateIfNeeded();

    return Math.max(
        0,
        MAX_DAILY_REQUESTS -
        dailyRequests
    );
}


function getRemainingMinuteBudget() {
    cleanupProviderRequestTimes();

    return Math.max(
        0,
        PROVIDER_MINUTE_LIMIT -
        providerRequestTimes.length
    );
}


function getSecondsUntilMinuteReset() {
    return Math.max(
        1,
        Math.ceil(
            (
                getNextMinuteBoundary()
                    .getTime() -
                Date.now()
            ) / 1000
        )
    );
}


function canMakeProviderRequest() {
    resetDailyStateIfNeeded();

    cleanupProviderRequestTimes();

    if (quotaBlocked) {
        return false;
    }

    if (
        Date.now() <
        minuteBlockedUntil
    ) {
        return false;
    }

    if (
        dailyRequests >=
        MAX_DAILY_REQUESTS
    ) {
        return false;
    }

    return (
        providerRequestTimes.length <
        PROVIDER_MINUTE_LIMIT
    );
}


function reserveProviderRequest() {
    resetDailyStateIfNeeded();

    cleanupProviderRequestTimes();

    if (quotaBlocked) {
        throw new Error(
            providerQuotaMessage ||
            'Twelve Data quota is blocked.'
        );
    }

    if (
        Date.now() <
        minuteBlockedUntil
    ) {
        throw new Error(
            `Provider minute budget is temporarily paused. Retry in ${getSecondsUntilMinuteReset()} seconds.`
        );
    }

    if (
        dailyRequests >=
        MAX_DAILY_REQUESTS
    ) {
        blockForDailyBudget();

        throw new Error(
            providerQuotaMessage
        );
    }

    if (
        providerRequestTimes.length >=
        PROVIDER_MINUTE_LIMIT
    ) {
        minuteBlockedUntil =
            getNextMinuteBoundary()
                .getTime();

        providerQuotaMessage =
            `Local provider safety limit reached (${PROVIDER_MINUTE_LIMIT} requests/minute). Waiting for the next minute.`;

        providerQuotaResetAt =
            new Date(
                minuteBlockedUntil
            ).toISOString();

        throw new Error(
            providerQuotaMessage
        );
    }

    providerRequestTimes.push(
        Date.now()
    );

    dailyRequests += 1;

    dailyCreditsUsed += 1;

    totalApiRequests += 1;
}


function blockForDailyBudget() {
    quotaBlocked = true;

    providerQuotaMessage =
        'Daily request safety budget reached. Scanner paused until the next UTC day.';

    providerQuotaResetAt =
        getNextUtcMidnight()
            .toISOString();

    lastScanError =
        providerQuotaMessage;
}


function blockForMinuteQuota(
    message
) {
    minuteBlockedUntil =
        getNextMinuteBoundary()
            .getTime();

    providerQuotaMessage =
        String(
            message ||
            'Twelve Data minute quota reached.'
        );

    providerQuotaResetAt =
        new Date(
            minuteBlockedUntil
        ).toISOString();

    lastScanError =
        providerQuotaMessage;
}


/* =========================================================
   NORMALIZATION / NUMBERS
========================================================= */

function normalizePair(pair) {
    return String(
        pair || ''
    )
        .trim()
        .toUpperCase()
        .replace(
            /\s+/g,
            ''
        );
}


function displayPair(pair) {
    const normalized =
        normalizePair(pair);

    if (
        normalized.length === 6 &&
        !normalized.includes('/')
    ) {
        return (
            `${normalized.slice(0, 3)}/${normalized.slice(3)}`
        );
    }

    return normalized;
}


function isSupportedPair(pair) {
    const normalized =
        normalizePair(pair);

    return PAIRS.some(
        item =>
            normalizePair(item) ===
            normalized
    );
}


function normalizeTimeframe(value) {
    const n =
        Number(value);

    return TIMEFRAMES.includes(n)
        ? n
        : null;
}


function isFiniteNumber(value) {
    return Number.isFinite(
        Number(value)
    );
}


function roundNumber(
    value,
    decimals = 6
) {
    const n =
        Number(value);

    return Number.isFinite(n)
        ? Number(
            n.toFixed(decimals)
        )
        : null;
}


function clamp(
    value,
    min,
    max
) {
    return Math.min(
        max,
        Math.max(
            min,
            value
        )
    );
}


function priceDecimals(pair) {
    return normalizePair(pair)
        .includes('JPY')
        ? 3
        : 5;
}


function roundPrice(
    value,
    pair
) {
    return roundNumber(
        value,
        priceDecimals(pair)
    );
}


/* =========================================================
   QUOTA ERROR HELPERS
========================================================= */

function providerErrorMessage(
    data
) {
    if (!data) {
        return (
            'Twelve Data returned an empty response.'
        );
    }

    return (
        data.message ||
        data.error ||
        'Twelve Data request failed.'
    );
}


function looksLikeDailyQuotaError(
    message
) {
    const text =
        String(message || '')
            .toLowerCase();

    return (
        text.includes(
            'daily limit'
        ) ||
        text.includes(
            'daily quota'
        ) ||
        text.includes(
            'daily credits'
        )
    );
}


function looksLikeMinuteQuotaError(
    message
) {
    const text =
        String(message || '')
            .toLowerCase();

    return (
        text.includes(
            'current minute'
        ) ||
        text.includes(
            'per minute'
        ) ||
        text.includes(
            'minute limit'
        ) ||
        text.includes(
            'minute quota'
        ) ||
        text.includes(
            'rate limit'
        ) ||
        text.includes(
            'too many requests'
        ) ||
        text.includes(
            '9 api credits'
        ) ||
        text.includes(
            '8 api credits'
        )
    );
}


function looksLikeQuotaError(
    message
) {
    const text =
        String(message || '')
            .toLowerCase();

    return (
        looksLikeDailyQuotaError(
            text
        ) ||
        looksLikeMinuteQuotaError(
            text
        ) ||
        text.includes(
            'quota'
        ) ||
        text.includes(
            'credit'
        ) ||
        text.includes(
            'api limit'
        )
    );
}


/* =========================================================
   CACHE
========================================================= */

function getCachedPair(
    pair,
    allowStale = false
) {
    const key =
        normalizePair(pair);

    const cached =
        pairCache.get(key);

    if (!cached) {
        return null;
    }

    const age =
        Date.now() -
        cached.cachedAt;

    if (
        !allowStale &&
        age > CACHE_TTL_MS
    ) {
        return null;
    }

    return {
        ...cached,
        ageMs:
            Math.max(
                0,
                age
            ),
        stale:
            age > CACHE_TTL_MS
    };
}


function setCachedPair(
    pair,
    candles
) {
    pairCache.set(
        normalizePair(pair),
        {
            pair:
                displayPair(pair),

            candles,

            cachedAt:
                Date.now()
        }
    );
}


function resultCacheKey(
    pair,
    timeframe
) {
    return (
        `${normalizePair(pair)}:${Number(timeframe)}`
    );
}


function getCachedResult(
    pair,
    timeframe
) {
    const cached =
        resultCache.get(
            resultCacheKey(
                pair,
                timeframe
            )
        );

    if (!cached) {
        return null;
    }

    const age =
        Date.now() -
        cached.cachedAt;

    if (
        age >
        RESULT_TTL_MS
    ) {
        return null;
    }

    return {
        ...cached,
        ageMs:
            Math.max(
                0,
                age
            )
    };
}


function setCachedResult(
    pair,
    timeframe,
    result
) {
    resultCache.set(
        resultCacheKey(
            pair,
            timeframe
        ),
        {
            result,
            cachedAt:
                Date.now()
        }
    );
}


/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchTwelveData(
    pair
) {
    resetDailyStateIfNeeded();

    if (!TWELVE_DATA_API_KEY) {
        throw new Error(
            'TWELVE_DATA_API_KEY is not configured on the backend.'
        );
    }

    /*
      Reserve locally BEFORE request.
      This prevents 9th request in one minute.
    */
    reserveProviderRequest();

    const symbol =
        displayPair(pair);

    const params =
        new URLSearchParams({
            symbol,
            interval: '1min',
            outputsize:
                String(MAX_CANDLES),
            timezone:
                TIMEZONE,
            apikey:
                TWELVE_DATA_API_KEY
        });

    let response;

    try {
        response =
            await fetch(
                `${TWELVE_DATA_URL}?${params.toString()}`,
                {
                    method: 'GET',

                    headers: {
                        Accept:
                            'application/json',

                        'User-Agent':
                            'PO-AI-Predictor/8.6'
                    }
                }
            );
    } catch (error) {
        throw new Error(
            `Twelve Data network error: ${error.message}`
        );
    }

    let data = null;

    try {
        data =
            await response.json();
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
            providerErrorMessage(
                data
            );

        if (
            looksLikeDailyQuotaError(
                message
            )
        ) {
            blockForDailyBudget();
        } else if (
            looksLikeMinuteQuotaError(
                message
            )
        ) {
            blockForMinuteQuota(
                message
            );
        }

        throw new Error(
            message
        );
    }

    if (
        !data ||
        !Array.isArray(
            data.values
        )
    ) {
        throw new Error(
            'Twelve Data returned no candle values.'
        );
    }

    const candles =
        data.values
            .map(item => ({
                time:
                    new Date(
                        item.datetime
                    ).getTime(),

                open:
                    Number(item.open),

                high:
                    Number(item.high),

                low:
                    Number(item.low),

                close:
                    Number(item.close),

                volume:
                    isFiniteNumber(
                        item.volume
                    )
                        ? Number(
                            item.volume
                        )
                        : null
            }))
            .filter(candle =>
                Number.isFinite(
                    candle.time
                ) &&
                Number.isFinite(
                    candle.open
                ) &&
                Number.isFinite(
                    candle.high
                ) &&
                Number.isFinite(
                    candle.low
                ) &&
                Number.isFinite(
                    candle.close
                )
            )
            .sort(
                (a, b) =>
                    a.time -
                    b.time
            );

    if (
        candles.length <
        MIN_CANDLES
    ) {
        throw new Error(
            `${symbol}: insufficient candle data (${candles.length}/${MIN_CANDLES}).`
        );
    }

    return candles.slice(
        -MAX_CANDLES
    );
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
      Fresh cache first.
    */
    if (!forceRefresh) {
        const fresh =
            getCachedPair(
                normalized,
                false
            );

        if (fresh) {
            return {
                candles:
                    fresh.candles,

                cached: true,

                stale: false,

                cachedAt:
                    new Date(
                        fresh.cachedAt
                    ).toISOString()
            };
        }
    }

    const stale =
        getCachedPair(
            normalized,
            true
        );

    /*
      If provider cannot be called,
      use stale cache.
    */
    if (
        quotaBlocked ||
        Date.now() <
            minuteBlockedUntil ||
        getRemainingMinuteBudget() <=
            0
    ) {
        if (stale) {
            return {
                candles:
                    stale.candles,

                cached: true,

                stale: true,

                cachedAt:
                    new Date(
                        stale.cachedAt
                    ).toISOString(),

                dataWarning:
                    quotaBlocked
                        ? 'Using cached market data because the daily provider safety block is active.'
                        : 'Using cached market data because the provider minute budget is temporarily unavailable.'
            };
        }

        throw new Error(
            quotaBlocked
                ? providerQuotaMessage
                : `Provider minute budget unavailable. Retry in ${getSecondsUntilMinuteReset()} seconds.`
        );
    }

    try {
        const candles =
            await fetchTwelveData(
                normalized
            );

        setCachedPair(
            normalized,
            candles
        );

        const cached =
            getCachedPair(
                normalized,
                true
            );

        return {
            candles,

            cached: false,

            stale: false,

            cachedAt:
                cached
                    ? new Date(
                        cached.cachedAt
                    ).toISOString()
                    : new Date()
                        .toISOString()
        };

    } catch (error) {

        /*
          Never throw away usable stale data.
        */
        const staleAfterError =
            getCachedPair(
                normalized,
                true
            );

        if (staleAfterError) {
            return {
                candles:
                    staleAfterError.candles,

                cached: true,

                stale: true,

                cachedAt:
                    new Date(
                        staleAfterError.cachedAt
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
            candle => ({
                ...candle
            })
        );
    }

    const bucketMs =
        tf *
        60 *
        1000;

    const buckets =
        new Map();

    for (
        const candle of candles
    ) {
        const bucket =
            Math.floor(
                candle.time /
                bucketMs
            ) *
            bucketMs;

        if (
            !buckets.has(bucket)
        ) {
            buckets.set(
                bucket,
                {
                    time:
                        bucket,

                    open:
                        candle.open,

                    high:
                        candle.high,

                    low:
                        candle.low,

                    close:
                        candle.close,

                    volume:
                        candle.volume,

                    count: 1
                }
            );
        } else {
            const item =
                buckets.get(
                    bucket
                );

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
                Number.isFinite(
                    item.volume
                ) &&
                Number.isFinite(
                    candle.volume
                )
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
            (a, b) =>
                a.time -
                b.time
        )
        .filter(
            candle =>
                candle.count >= tf
        );
}


/* =========================================================
   EMA
========================================================= */

function ema(
    values,
    period
) {
    if (
        !Array.isArray(values) ||
        values.length <
            period
    ) {
        return null;
    }

    const multiplier =
        2 /
        (period + 1);

    let previous =
        values
            .slice(
                0,
                period
            )
            .reduce(
                (
                    sum,
                    value
                ) =>
                    sum +
                    Number(value),
                0
            ) /
        period;

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


function emaSeries(
    values,
    period
) {
    if (
        !Array.isArray(values) ||
        values.length <
            period
    ) {
        return [];
    }

    const multiplier =
        2 /
        (period + 1);

    let previous =
        values
            .slice(
                0,
                period
            )
            .reduce(
                (
                    sum,
                    value
                ) =>
                    sum +
                    Number(value),
                0
            ) /
        period;

    const series = [
        previous
    ];

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

        series.push(
            previous
        );
    }

    return series;
}


/* =========================================================
   RSI
========================================================= */

function rsi(
    values,
    period = 14
) {
    if (
        !Array.isArray(values) ||
        values.length <= period
    ) {
        return null;
    }

    let gain = 0;
    let loss = 0;

    for (
        let i = 1;
        i <= period;
        i++
    ) {
        const change =
            Number(values[i]) -
            Number(values[i - 1]);

        if (change > 0) {
            gain += change;
        } else {
            loss +=
                Math.abs(change);
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

        avgGain =
            (
                avgGain *
                    (period - 1) +
                (
                    change > 0
                        ? change
                        : 0
                )
            ) /
            period;

        avgLoss =
            (
                avgLoss *
                    (period - 1) +
                (
                    change < 0
                        ? Math.abs(
                            change
                        )
                        : 0
                )
            ) /
            period;
    }

    if (
        avgLoss === 0
    ) {
        return 100;
    }

    return (
        100 -
        (
            100 /
            (
                1 +
                avgGain /
                    avgLoss
            )
        )
    );
}


/* =========================================================
   ATR
========================================================= */

function atr(
    candles,
    period = 14
) {
    if (
        !Array.isArray(candles) ||
        candles.length <= period
    ) {
        return null;
    }

    const trueRanges = [];

    for (
        let i = 1;
        i < candles.length;
        i++
    ) {
        const current =
            candles[i];

        const previous =
            candles[i - 1];

        const tr =
            Math.max(
                current.high -
                    current.low,

                Math.abs(
                    current.high -
                    previous.close
                ),

                Math.abs(
                    current.low -
                    previous.close
                )
            );

        trueRanges.push(
            tr
        );
    }

    if (
        trueRanges.length <
        period
    ) {
        return null;
    }

    let value =
        trueRanges
            .slice(
                0,
                period
            )
            .reduce(
                (
                    sum,
                    x
                ) =>
                    sum + x,
                0
            ) /
        period;

    for (
        let i = period;
        i < trueRanges.length;
        i++
    ) {
        value =
            (
                value *
                    (period - 1) +
                trueRanges[i]
            ) /
            period;
    }

    return value;
}


/* =========================================================
   ADX
========================================================= */

function adx(
    candles,
    period = 14
) {
    if (
        !Array.isArray(candles) ||
        candles.length <
            period * 2 + 1
    ) {
        return null;
    }

    const trs = [];

    const plusDM = [];

    const minusDM = [];

    for (
        let i = 1;
        i < candles.length;
        i++
    ) {
        const current =
            candles[i];

        const previous =
            candles[i - 1];

        const upMove =
            current.high -
            previous.high;

        const downMove =
            previous.low -
            current.low;

        const tr =
            Math.max(
                current.high -
                    current.low,

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
            upMove >
                downMove &&
            upMove > 0
                ? upMove
                : 0
        );

        minusDM.push(
            downMove >
                upMove &&
            downMove > 0
                ? downMove
                : 0
        );
    }

    if (
        trs.length <
        period
    ) {
        return null;
    }

    let trSmooth =
        trs
            .slice(
                0,
                period
            )
            .reduce(
                (
                    sum,
                    x
                ) =>
                    sum + x,
                0
            );

    let plusSmooth =
        plusDM
            .slice(
                0,
                period
            )
            .reduce(
                (
                    sum,
                    x
                ) =>
                    sum + x,
                0
            );

    let minusSmooth =
        minusDM
            .slice(
                0,
                period
            )
            .reduce(
                (
                    sum,
                    x
                ) =>
                    sum + x,
                0
            );

    const dxValues = [];

    for (
        let i = period;
        i < trs.length;
        i++
    ) {
        if (
            i > period
        ) {
            trSmooth =
                trSmooth -
                trSmooth /
                    period +
                trs[i];

            plusSmooth =
                plusSmooth -
                plusSmooth /
                    period +
                plusDM[i];

            minusSmooth =
                minusSmooth -
                minusSmooth /
                    period +
                minusDM[i];
        }

        const plusDI =
            trSmooth === 0
                ? 0
                : 100 *
                    (
                        plusSmooth /
                        trSmooth
                    );

        const minusDI =
            trSmooth === 0
                ? 0
                : 100 *
                    (
                        minusSmooth /
                        trSmooth
                    );

        const denominator =
            plusDI +
            minusDI;

        const dx =
            denominator === 0
                ? 0
                : 100 *
                    Math.abs(
                        plusDI -
                        minusDI
                    ) /
                    denominator;

        dxValues.push(
            dx
        );
    }

    if (
        dxValues.length <
        period
    ) {
        return null;
    }

    let adxValue =
        dxValues
            .slice(
                0,
                period
            )
            .reduce(
                (
                    sum,
                    x
                ) =>
                    sum + x,
                0
            ) /
        period;

    for (
        let i = period;
        i < dxValues.length;
        i++
    ) {
        adxValue =
            (
                adxValue *
                    (period - 1) +
                dxValues[i]
            ) /
            period;
    }

    return adxValue;
}


/* =========================================================
   STANDARD DEVIATION
========================================================= */

function standardDeviation(
    values
) {
    if (
        !Array.isArray(values) ||
        values.length === 0
    ) {
        return null;
    }

    const mean =
        values.reduce(
            (
                sum,
                x
            ) =>
                sum +
                Number(x),
            0
        ) /
        values.length;

    const variance =
        values.reduce(
            (
                sum,
                x
            ) =>
                sum +
                Math.pow(
                    Number(x) -
                        mean,
                    2
                ),
            0
        ) /
        values.length;

    return Math.sqrt(
        variance
    );
}


/* =========================================================
   BOLLINGER
========================================================= */

function bollinger(
    values,
    period = 20,
    multiplier = 2
) {
    if (
        !Array.isArray(values) ||
        values.length <
            period
    ) {
        return null;
    }

    const recent =
        values.slice(
            -period
        );

    const middle =
        recent.reduce(
            (
                sum,
                x
            ) =>
                sum +
                Number(x),
            0
        ) /
        period;

    const sd =
        standardDeviation(
            recent
        );

    if (
        !Number.isFinite(sd)
    ) {
        return null;
    }

    return {
        upper:
            middle +
            multiplier *
                sd,

        middle,

        lower:
            middle -
            multiplier *
                sd
    };
}


/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
    candles
) {
    const recent =
        candles.slice(
            -50
        );

    if (
        !recent.length
    ) {
        return {
            support: null,
            resistance: null
        };
    }

    return {
        support:
            Math.min(
                ...recent.map(
                    candle =>
                        candle.low
                )
            ),

        resistance:
            Math.max(
                ...recent.map(
                    candle =>
                        candle.high
                )
            )
    };
}


/* =========================================================
   STOCHASTIC
   14 / 3 / 3
========================================================= */

function stochastic(
    candles,
    period = 14,
    smoothK = 3,
    smoothD = 3
) {
    if (
        !Array.isArray(candles) ||
        candles.length <
            period +
            smoothK +
            smoothD
    ) {
        return null;
    }

    const rawK = [];

    for (
        let i =
            period - 1;
        i < candles.length;
        i++
    ) {
        const window =
            candles.slice(
                i -
                    period +
                    1,
                i + 1
            );

        const highest =
            Math.max(
                ...window.map(
                    c => c.high
                )
            );

        const lowest =
            Math.min(
                ...window.map(
                    c => c.low
                )
            );

        const range =
            highest -
            lowest;

        rawK.push(
            range === 0
                ? 50
                : 100 *
                    (
                        candles[i].close -
                        lowest
                    ) /
                    range
        );
    }

    const kSeries = [];

    for (
        let i =
            smoothK - 1;
        i < rawK.length;
        i++
    ) {
        const avg =
            rawK
                .slice(
                    i -
                        smoothK +
                        1,
                    i + 1
                )
                .reduce(
                    (
                        sum,
                        x
                    ) =>
                        sum + x,
                    0
                ) /
            smoothK;

        kSeries.push(
            avg
        );
    }

    if (
        kSeries.length <
        smoothD
    ) {
        return null;
    }

    const k =
        kSeries[
            kSeries.length - 1
        ];

    const d =
        kSeries
            .slice(
                -smoothD
            )
            .reduce(
                (
                    sum,
                    x
                ) =>
                    sum + x,
                0
            ) /
        smoothD;

    return {
        k,
        d
    };
}


/* =========================================================
   CCI 20
========================================================= */

function cci(
    candles,
    period = 20
) {
    if (
        !Array.isArray(candles) ||
        candles.length <
            period
    ) {
        return null;
    }

    const typical =
        candles.map(
            candle =>
                (
                    candle.high +
                    candle.low +
                    candle.close
                ) / 3
        );

    const recent =
        typical.slice(
            -period
        );

    const mean =
        recent.reduce(
            (
                sum,
                x
            ) =>
                sum + x,
            0
        ) /
        period;

    const meanDeviation =
        recent.reduce(
            (
                sum,
                x
            ) =>
                sum +
                Math.abs(
                    x - mean
                ),
            0
        ) /
        period;

    if (
        meanDeviation === 0
    ) {
        return 0;
    }

    return (
        (
            recent[
                recent.length - 1
            ] -
            mean
        ) /
        (
            0.015 *
            meanDeviation
        )
    );
}


/* =========================================================
   MACD
========================================================= */

function macd(
    values
) {
    if (
        !Array.isArray(values) ||
        values.length < 35
    ) {
        return null;
    }

    const macdLine = [];

    for (
        let i = 25;
        i < values.length;
        i++
    ) {
        const fast =
            ema(
                values.slice(
                    0,
                    i + 1
                ),
                12
            );

        const slow =
            ema(
                values.slice(
                    0,
                    i + 1
                ),
                26
            );

        if (
            Number.isFinite(
                fast
            ) &&
            Number.isFinite(
                slow
            )
        ) {
            macdLine.push(
                fast - slow
            );
        }
    }

    if (
        macdLine.length <
        10
    ) {
        return null;
    }

    const signal =
        ema(
            macdLine,
            9
        );

    const line =
        macdLine[
            macdLine.length - 1
        ];

    if (
        !Number.isFinite(
            signal
        )
    ) {
        return null;
    }

    return {
        line,

        signal,

        histogram:
            line - signal
    };
}


/* =========================================================
   CANDLE ANATOMY
========================================================= */

function candleAnatomy(
    candle
) {
    const open =
        Number(
            candle.open
        );

    const high =
        Number(
            candle.high
        );

    const low =
        Number(
            candle.low
        );

    const close =
        Number(
            candle.close
        );

    const range =
        Math.max(
            0,
            high - low
        );

    const body =
        Math.abs(
            close - open
        );

    const upperWick =
        Math.max(
            0,
            high -
                Math.max(
                    open,
                    close
                )
        );

    const lowerWick =
        Math.max(
            0,
            Math.min(
                open,
                close
            ) -
                low
        );

    const bodyRatio =
        range > 0
            ? body / range
            : 0;

    const closeLocation =
        range > 0
            ? (
                close -
                low
            ) /
                range
            : 0.5;

    return {
        bullish:
            close > open,

        bearish:
            close < open,

        doji:
            bodyRatio <=
            0.10,

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

function detectCandlestickPatterns(
    candles
) {
    if (
        !Array.isArray(
            candles
        ) ||
        candles.length < 3
    ) {
        return [];
    }

    const patterns = [];

    const n =
        candles.length;

    const c1 =
        candles[n - 3];

    const c2 =
        candles[n - 2];

    const c3 =
        candles[n - 1];

    const a1 =
        candleAnatomy(
            c1
        );

    const a2 =
        candleAnatomy(
            c2
        );

    const a3 =
        candleAnatomy(
            c3
        );

    const add = (
        name,
        direction,
        strength,
        description
    ) => {
        patterns.push({
            name,
            direction,
            strength,
            description
        });
    };

    if (a3.doji) {
        add(
            'Doji',
            'NEUTRAL',
            35,
            'Latest candle shows indecision.'
        );
    }

    if (
        a3.range > 0 &&
        a3.lowerWick >=
            Math.max(
                a3.body * 2,
                a3.range *
                    0.45
            ) &&
        a3.upperWick <=
            Math.max(
                a3.body * 1.25,
                a3.range *
                    0.12
            ) &&
        a3.closeLocation >=
            0.60
    ) {
        add(
            'Hammer',
            'BULLISH',
            65,
            'Lower-price rejection with a relatively strong close.'
        );
    }

    if (
        a3.range > 0 &&
        a3.upperWick >=
            Math.max(
                a3.body * 2,
                a3.range *
                    0.45
            ) &&
        a3.lowerWick <=
            Math.max(
                a3.body * 1.25,
                a3.range *
                    0.12
            ) &&
        a3.closeLocation <=
            0.40
    ) {
        add(
            'Shooting Star',
            'BEARISH',
            65,
            'Higher-price rejection with a relatively weak close.'
        );
    }

    if (
        a3.range > 0 &&
        a3.lowerWick >=
            a3.body * 2 &&
        a3.closeLocation >=
            0.65
    ) {
        add(
            'Bullish Pin Bar',
            'BULLISH',
            60,
            'Long lower wick shows rejection of lower prices.'
        );
    }

    if (
        a3.range > 0 &&
        a3.upperWick >=
            a3.body * 2 &&
        a3.closeLocation <=
            0.35
    ) {
        add(
            'Bearish Pin Bar',
            'BEARISH',
            60,
            'Long upper wick shows rejection of higher prices.'
        );
    }

    if (
        a2.bearish &&
        a3.bullish &&
        a3.body > 0 &&
        a2.body > 0 &&
        c3.open <=
            c2.close &&
        c3.close >=
            c2.open
    ) {
        add(
            'Bullish Engulfing',
            'BULLISH',
            80,
            'Bullish body engulfs the prior bearish body.'
        );
    }

    if (
        a2.bullish &&
        a3.bearish &&
        a3.body > 0 &&
        a2.body > 0 &&
        c3.open >=
            c2.close &&
        c3.close <=
            c2.open
    ) {
        add(
            'Bearish Engulfing',
            'BEARISH',
            80,
            'Bearish body engulfs the prior bullish body.'
        );
    }

    if (
        a1.bearish &&
        a2.bodyRatio <=
            0.35 &&
        a3.bullish &&
        c3.close >
            (
                c1.open +
                c1.close
            ) / 2
    ) {
        add(
            'Morning Star',
            'BULLISH',
            75,
            'Selling pressure weakened and buyers recovered control.'
        );
    }

    if (
        a1.bullish &&
        a2.bodyRatio <=
            0.35 &&
        a3.bearish &&
        c3.close <
            (
                c1.open +
                c1.close
            ) / 2
    ) {
        add(
            'Evening Star',
            'BEARISH',
            75,
            'Buying pressure weakened and sellers recovered control.'
        );
    }

    patterns.sort(
        (a, b) =>
            b.strength -
            a.strength
    );

    return patterns;
}


/* =========================================================
   PATTERN SUMMARY
========================================================= */

function summarizePatterns(
    patterns
) {
    if (
        !patterns.length
    ) {
        return {
            direction:
                'NEUTRAL',

            strength: 0,

            names: [],

            text:
                'No strong named candlestick pattern was detected.'
        };
    }

    let bullish = 0;

    let bearish = 0;

    for (
        const pattern of patterns
    ) {
        if (
            pattern.direction ===
            'BULLISH'
        ) {
            bullish +=
                pattern.strength;
        }

        if (
            pattern.direction ===
            'BEARISH'
        ) {
            bearish +=
                pattern.strength;
        }
    }

    let direction =
        'NEUTRAL';

    if (
        bullish >
            bearish &&
        bullish >= 50
    ) {
        direction =
            'BULLISH';
    } else if (
        bearish >
            bullish &&
        bearish >= 50
    ) {
        direction =
            'BEARISH';
    }

    const difference =
        Math.abs(
            bullish -
            bearish
        );

    const strength =
        clamp(
            patterns[0]
                .strength +
            Math.min(
                20,
                difference *
                    0.10
            ),
            0,
            100
        );

    return {
        direction,

        strength:
            Math.round(
                strength
            ),

        bullishScore:
            Math.round(
                bullish
            ),

        bearishScore:
            Math.round(
                bearish
            ),

        names:
            patterns
                .slice(0, 3)
                .map(
                    pattern =>
                        pattern.name
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
   MARKET PSYCHOLOGY
========================================================= */

function calculateMarketPsychology(
    candles,
    indicators
) {
    const recent =
        candles.slice(
            -10
        );

    if (
        !recent.length
    ) {
        return {
            sentiment:
                'BALANCED',

            buyerPressure: 50,

            sellerPressure: 50,

            conviction: 0,

            rejection:
                'NONE',

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

    let lowerRejections = 0;

    let upperRejections = 0;

    for (
        const candle of recent
    ) {
        const a =
            candleAnatomy(
                candle
            );

        if (a.bullish) {
            bullishCount += 1;
        }

        if (a.bearish) {
            bearishCount += 1;
        }

        if (a.doji) {
            indecisionCount += 1;
        }

        if (a.bullish) {
            buyerPoints +=
                1.5 *
                a.bodyRatio;
        }

        if (a.bearish) {
            sellerPoints +=
                1.5 *
                a.bodyRatio;
        }

        buyerPoints +=
            Math.max(
                0,
                a.closeLocation -
                    0.50
            );

        sellerPoints +=
            Math.max(
                0,
                0.50 -
                    a.closeLocation
            );

        if (
            a.lowerWick >
            Math.max(
                a.body * 1.5,
                a.range * 0.30
            )
        ) {
            lowerRejections += 1;

            buyerPoints +=
                0.7;
        }

        if (
            a.upperWick >
            Math.max(
                a.body * 1.5,
                a.range * 0.30
            )
        ) {
            upperRejections += 1;

            sellerPoints +=
                0.7;
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
        Number(
            indicators?.adx14
        );

    const adxComponent =
        Number.isFinite(
            adxValue
        )
            ? clamp(
                adxValue /
                    40,
                0,
                1
            )
            : 0;

    const conviction =
        Math.round(
            clamp(
                (
                    consistency *
                        0.55 +
                    adxComponent *
                        0.45
                ) *
                    100,
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
                ) *
                    100,
                0,
                100
            )
        );

    let sentiment =
        'BALANCED';

    if (
        buyerPressure >= 58 &&
        buyerPressure >
            sellerPressure + 5
    ) {
        sentiment =
            'BUYER DOMINANCE';

    } else if (
        sellerPressure >= 58 &&
        sellerPressure >
            buyerPressure + 5
    ) {
        sentiment =
            'SELLER DOMINANCE';

    } else if (
        indecision >= 30
    ) {
        sentiment =
            'INDECISION';
    }

    let rejection =
        'NONE';

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
        rejection =
            'TWO-SIDED REJECTION';
    }

    const pressureDifference =
        Math.abs(
            buyerPressure -
            sellerPressure
        );

    const score =
        Math.round(
            clamp(
                pressureDifference *
                    0.55 +
                conviction *
                    0.30 +
                (
                    100 -
                    indecision
                ) *
                    0.15,
                0,
                100
            )
        );

    let description =
        'Buyer and seller pressure are relatively balanced.';

    if (
        sentiment ===
        'BUYER DOMINANCE'
    ) {
        description =
            `Recent candles show stronger buyer pressure (${Math.round(buyerPressure)}%) with ${conviction}% directional conviction.`;

    } else if (
        sentiment ===
        'SELLER DOMINANCE'
    ) {
        description =
            `Recent candles show stronger seller pressure (${Math.round(sellerPressure)}%) with ${conviction}% directional conviction.`;

    } else if (
        sentiment ===
        'INDECISION'
    ) {
        description =
            `Recent candles contain elevated indecision (${indecision}%).`;
    }

    if (
        rejection !== 'NONE'
    ) {
        description +=
            ` Price action also shows ${rejection.toLowerCase()}.`;
    }

    return {
        sentiment,

        buyerPressure:
            Math.round(
                buyerPressure
            ),

        sellerPressure:
            Math.round(
                sellerPressure
            ),

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
   PATTERN + PSYCHOLOGY CONFIRMATION
========================================================= */

function calculateConfirmation(
    patternSummary,
    psychology,
    baseTrend
) {
    let call = 0;

    let put = 0;

    if (
        patternSummary.direction ===
        'BULLISH'
    ) {
        call +=
            Math.min(
                15,
                patternSummary.strength *
                    0.15
            );
    }

    if (
        patternSummary.direction ===
        'BEARISH'
    ) {
        put +=
            Math.min(
                15,
                patternSummary.strength *
                    0.15
            );
    }

    if (
        psychology.sentiment ===
        'BUYER DOMINANCE'
    ) {
        call +=
            Math.min(
                10,
                psychology.score *
                    0.10
            );
    }

    if (
        psychology.sentiment ===
        'SELLER DOMINANCE'
    ) {
        put +=
            Math.min(
                10,
                psychology.score *
                    0.10
            );
    }

    if (
        psychology.sentiment ===
        'INDECISION'
    ) {
        call *=
            0.45;

        put *=
            0.45;
    }

    if (
        baseTrend ===
            'UPTREND' &&
        call > put
    ) {
        call += 2;
    }

    if (
        baseTrend ===
            'DOWNTREND' &&
        put > call
    ) {
        put += 2;
    }

    return {
        call:
            Math.round(
                clamp(
                    call,
                    0,
                    17
                )
            ),

        put:
            Math.round(
                clamp(
                    put,
                    0,
                    17
                )
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

    if (
        candles.length <
        MIN_CANDLES
    ) {
        throw new Error(
            `${pair} ${tf}m: insufficient aggregated candles (${candles.length}/${MIN_CANDLES}).`
        );
    }

    const closes =
        candles.map(
            candle =>
                candle.close
        );

    const currentPrice =
        closes[
            closes.length - 1
        ];

    const ema9 =
        ema(
            closes,
            9
        );

    const ema21 =
        ema(
            closes,
            21
        );

    const rsi14 =
        rsi(
            closes,
            14
        );

    const adx14 =
        adx(
            candles,
            14
        );

    const atr14 =
        atr(
            candles,
            14
        );

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

    const stoch =
        stochastic(
            candles,
            14,
            3,
            3
        );

    const cci20 =
        cci(
            candles,
            20
        );

    const macdValue =
        macd(
            closes
        );

    if (
        !Number.isFinite(
            ema9
        ) ||
        !Number.isFinite(
            ema21
        ) ||
        !Number.isFinite(
            rsi14
        ) ||
        !stoch ||
        !Number.isFinite(
            cci20
        ) ||
        !macdValue
    ) {
        throw new Error(
            `${pair} ${tf}m: indicator calculation incomplete.`
        );
    }

    let callScore = 0;

    let putScore = 0;

    const reasons = [];

    /*
      1. EMA TREND
    */
    let baseTrend =
        'RANGING';

    if (
        ema9 > ema21
    ) {
        callScore += 30;

        baseTrend =
            'UPTREND';

        reasons.push(
            'EMA9 is above EMA21, supporting bullish direction.'
        );

    } else if (
        ema9 < ema21
    ) {
        putScore += 30;

        baseTrend =
            'DOWNTREND';

        reasons.push(
            'EMA9 is below EMA21, supporting bearish direction.'
        );

    } else {
        reasons.push(
            'EMA9 and EMA21 are closely aligned.'
        );
    }

    /*
      2. RSI
    */
    if (
        rsi14 >= 52 &&
        rsi14 <= 68
    ) {
        callScore += 20;

        reasons.push(
            `RSI14 ${rsi14.toFixed(1)} supports bullish momentum.`
        );

    } else if (
        rsi14 >= 32 &&
        rsi14 <= 48
    ) {
        putScore += 20;

        reasons.push(
            `RSI14 ${rsi14.toFixed(1)} supports bearish momentum.`
        );

    } else if (
        rsi14 > 70
    ) {
        putScore += 8;

        reasons.push(
            `RSI14 ${rsi14.toFixed(1)} is overbought, adding reversal pressure.`
        );

    } else if (
        rsi14 < 30
    ) {
        callScore += 8;

        reasons.push(
            `RSI14 ${rsi14.toFixed(1)} is oversold, adding reversal pressure.`
        );
    }

    /*
      3. MOMENTUM
    */
    const lookback =
        Math.min(
            5,
            closes.length - 1
        );

    const momentum =
        currentPrice -
        closes[
            closes.length -
            1 -
            lookback
        ];

    if (
        momentum > 0
    ) {
        callScore += 20;

        reasons.push(
            'Recent price momentum is positive.'
        );

    } else if (
        momentum < 0
    ) {
        putScore += 20;

        reasons.push(
            'Recent price momentum is negative.'
        );
    }

    /*
      4. ADX
    */
    if (
        Number.isFinite(
            adx14
        )
    ) {
        if (
            adx14 >= 20 &&
            baseTrend ===
                'UPTREND'
        ) {
            callScore += 15;

            reasons.push(
                `ADX14 ${adx14.toFixed(1)} supports trend strength.`
            );

        } else if (
            adx14 >= 20 &&
            baseTrend ===
                'DOWNTREND'
        ) {
            putScore += 15;

            reasons.push(
                `ADX14 ${adx14.toFixed(1)} supports trend strength.`
            );

        } else {
            reasons.push(
                `ADX14 ${adx14.toFixed(1)} indicates weaker trend strength.`
            );
        }
    }

    /*
      5. SUPPORT / RESISTANCE
    */
    if (
        Number.isFinite(
            sr.support
        ) &&
        Number.isFinite(
            sr.resistance
        ) &&
        sr.resistance >
            sr.support
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
            baseTrend ===
                'UPTREND' &&
            position < 0.78
        ) {
            callScore += 10;

            reasons.push(
                'Price structure leaves room below recent resistance.'
            );
        }

        if (
            baseTrend ===
                'DOWNTREND' &&
            position > 0.22
        ) {
            putScore += 10;

            reasons.push(
                'Price structure leaves room above recent support.'
            );
        }
    }

    /*
      6. MARKET CONDITION
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

        if (
            width < 0.0008
        ) {
            marketCondition =
                'LOW_VOLATILITY_RANGE';

        } else if (
            baseTrend ===
                'UPTREND'
        ) {
            marketCondition =
                'UPTREND';

        } else if (
            baseTrend ===
                'DOWNTREND'
        ) {
            marketCondition =
                'DOWNTREND';

        } else {
            marketCondition =
                'RANGING';
        }
    }

    /*
      7. MACD
    */
    if (
        macdValue.histogram >
            0 &&
        macdValue.line >
            macdValue.signal
    ) {
        callScore += 12;

        reasons.push(
            'MACD is bullish with positive histogram confirmation.'
        );

    } else if (
        macdValue.histogram <
            0 &&
        macdValue.line <
            macdValue.signal
    ) {
        putScore += 12;

        reasons.push(
            'MACD is bearish with negative histogram confirmation.'
        );

    } else {
        reasons.push(
            'MACD is mixed and does not provide strong directional confirmation.'
        );
    }

    /*
      8. STOCHASTIC
    */
    if (
        stoch.k >
            stoch.d &&
        stoch.k >= 50 &&
        stoch.k <= 85
    ) {
        callScore += 10;

        reasons.push(
            `Stochastic K ${stoch.k.toFixed(1)} is above D ${stoch.d.toFixed(1)}, supporting bullish momentum.`
        );

    } else if (
        stoch.k <
            stoch.d &&
        stoch.k <= 50 &&
        stoch.k >= 15
    ) {
        putScore += 10;

        reasons.push(
            `Stochastic K ${stoch.k.toFixed(1)} is below D ${stoch.d.toFixed(1)}, supporting bearish momentum.`
        );

    } else if (
        stoch.k < 20 &&
        stoch.k >
            stoch.d
    ) {
        callScore += 7;

        reasons.push(
            `Stochastic is recovering from oversold (${stoch.k.toFixed(1)}).`
        );

    } else if (
        stoch.k > 80 &&
        stoch.k <
            stoch.d
    ) {
        putScore += 7;

        reasons.push(
            `Stochastic is turning down from overbought (${stoch.k.toFixed(1)}).`
        );
    }

    /*
      9. CCI
    */
    if (
        cci20 > 100
    ) {
        callScore += 10;

        reasons.push(
            `CCI20 ${cci20.toFixed(1)} confirms strong bullish momentum.`
        );

    } else if (
        cci20 < -100
    ) {
        putScore += 10;

        reasons.push(
            `CCI20 ${cci20.toFixed(1)} confirms strong bearish momentum.`
        );

    } else if (
        cci20 >= 0 &&
        cci20 <= 100
    ) {
        callScore += 5;

    } else if (
        cci20 < 0 &&
        cci20 >= -100
    ) {
        putScore += 5;
    }

    /*
      10. CANDLESTICKS
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
      11. MARKET PSYCHOLOGY
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
      12. CONFIRMATION
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
            'Candlestick patterns do not provide strong directional confirmation.'
        );
    }

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
            `Price-action psychology is ${marketPsychology.sentiment.toLowerCase()}.`
        );
    }

    /*
      13. DECISION
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
            callScore >
            putScore
                ? 'CALL'
                : 'PUT';
    }

    let confidence;

    if (
        signal === 'CALL'
    ) {
        confidence =
            clamp(
                Math.round(
                    50 +
                    callScore *
                        0.40 +
                    difference *
                        0.25
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
                    putScore *
                        0.40 +
                    difference *
                        0.25
                ),
                70,
                95
            );

    } else {
        confidence =
            clamp(
                Math.round(
                    40 +
                    strongest *
                        0.30
                ),
                40,
                69
            );

        reasons.push(
            'Signals are not sufficiently aligned for a high-confidence directional setup.'
        );
    }

    /*
      14. ENTRY / EXPIRY
    */
    const now =
        new Date();

    const timeframeMs =
        tf *
        60 *
        1000;

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
            ) /
                1000
        );

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
                ) /
                    1000
            );
    }

    const expiryMs =
        entryMs +
        timeframeMs;

    const lastCandle =
        candles[
            candles.length - 1
        ];

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

        entryTime:
            new Date(
                entryMs
            ).toISOString(),

        expiryTime:
            new Date(
                expiryMs
            ).toISOString(),

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

            bollinger:
                bb
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
                    : null,

            macd: {
                line:
                    roundPrice(
                        macdValue.line,
                        pair
                    ),

                signal:
                    roundPrice(
                        macdValue.signal,
                        pair
                    ),

                histogram:
                    roundPrice(
                        macdValue.histogram,
                        pair
                    )
            },

            stochastic: {
                k:
                    roundNumber(
                        stoch.k,
                        2
                    ),

                d:
                    roundNumber(
                        stoch.d,
                        2
                    )
            },

            cci20:
                roundNumber(
                    cci20,
                    2
                )
        },

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
            new Date()
                .toISOString(),

        reasons:
            reasons.slice(
                0,
                12
            )
    };
}


/* =========================================================
   SIGNAL TRACKING
========================================================= */

function createSignalId() {
    signalSequence += 1;

    return (
        `PO86-${Date.now()}-${signalSequence}`
    );
}


function signalKey(
    result
) {
    return (
        `${normalizePair(result.pair)}:${result.timeframe}:${new Date(result.entryTime).getTime()}:${result.signal}`
    );
}


function registerSignal(
    result
) {
    if (
        !result ||
        ![
            'CALL',
            'PUT'
        ].includes(
            result.signal
        )
    ) {
        result.resultStatus =
            'NOT_TRACKED';

        return result;
    }

    const key =
        signalKey(
            result
        );

    let record =
        signalRegistry.get(
            key
        );

    if (!record) {
        record = {
            signalId:
                createSignalId(),

            key,

            pair:
                result.pair,

            timeframe:
                result.timeframe,

            signal:
                result.signal,

            confidence:
                result.confidence,

            analysisTime:
                result.analysisTime,

            entryTime:
                result.entryTime,

            expiryTime:
                result.expiryTime,

            predictedPrice:
                result.currentPrice,

            entryPrice:
                null,

            exitPrice:
                null,

            result:
                'PENDING',

            settledAt:
                null,

            settlementSource:
                null
        };

        signalRegistry.set(
            key,
            record
        );

        signalKeyRegistry.set(
            record.signalId,
            key
        );

        signalHistory.unshift(
            record
        );

        if (
            signalHistory.length >
            HISTORY_LIMIT
        ) {
            signalHistory.pop();
        }
    }

    result.signalId =
        record.signalId;

    result.resultStatus =
        record.result;

    result.entryPrice =
        record.entryPrice;

    result.exitPrice =
        record.exitPrice;

    result.settledAt =
        record.settledAt;

    return result;
}


/* =========================================================
   FIND ENTRY CANDLE
========================================================= */

function findCandleForEntry(
    candles,
    entryMs
) {
    return (
        candles.find(
            candle =>
                candle.time ===
                entryMs
        ) ||
        candles.find(
            candle =>
                candle.time >
                entryMs
        )
    );
}


/* =========================================================
   SETTLE SIGNAL
========================================================= */

function settleSignalRecord(
    record,
    sourceCandles
) {
    if (
        !record ||
        record.result !==
            'PENDING'
    ) {
        return false;
    }

    const now =
        Date.now();

    const entryMs =
        new Date(
            record.entryTime
        ).getTime();

    const expiryMs =
        new Date(
            record.expiryTime
        ).getTime();

    if (
        !Number.isFinite(
            entryMs
        ) ||
        !Number.isFinite(
            expiryMs
        )
    ) {
        return false;
    }

    if (
        now < expiryMs
    ) {
        return false;
    }

    const candles =
        aggregateCandles(
            sourceCandles,
            record.timeframe
        );

    const entryCandle =
        findCandleForEntry(
            candles,
            entryMs
        );

    if (
        !entryCandle ||
        !Number.isFinite(
            entryCandle.open
        )
    ) {
        return false;
    }

    const expiryCandle =
        candles.find(
            candle =>
                candle.time ===
                expiryMs
        ) ||
        candles.find(
            candle =>
                candle.time >
                expiryMs
        );

    if (
        !expiryCandle ||
        !Number.isFinite(
            expiryCandle.close
        )
    ) {
        return false;
    }

    record.entryPrice =
        roundPrice(
            entryCandle.open,
            record.pair
        );

    record.exitPrice =
        roundPrice(
            expiryCandle.close,
            record.pair
        );

    if (
        record.signal ===
        'CALL'
    ) {
        if (
            expiryCandle.close >
            entryCandle.open
        ) {
            record.result =
                'WIN';

        } else if (
            expiryCandle.close <
            entryCandle.open
        ) {
            record.result =
                'LOSS';

        } else {
            record.result =
                'DRAW';
        }

    } else if (
        record.signal ===
        'PUT'
    ) {
        if (
            expiryCandle.close <
            entryCandle.open
        ) {
            record.result =
                'WIN';

        } else if (
            expiryCandle.close >
            entryCandle.open
        ) {
            record.result =
                'LOSS';

        } else {
            record.result =
                'DRAW';
        }
    }

    record.settledAt =
        new Date()
            .toISOString();

    record.settlementSource =
        'Twelve Data LIVE candles';

    /*
      Update cached result too.
    */
    const cached =
        resultCache.get(
            resultCacheKey(
                record.pair,
                record.timeframe
            )
        );

    if (
        cached &&
        cached.result.signalId ===
            record.signalId
    ) {
        cached.result.resultStatus =
            record.result;

        cached.result.entryPrice =
            record.entryPrice;

        cached.result.exitPrice =
            record.exitPrice;

        cached.result.settledAt =
            record.settledAt;
    }

    return true;
}


/* =========================================================
   SETTLE SIGNALS FOR PAIR
========================================================= */

function settleSignalsForPair(
    pair,
    sourceCandles
) {
    let settled = 0;

    for (
        const record of signalHistory
    ) {
        if (
            record.result !==
            'PENDING'
        ) {
            continue;
        }

        if (
            normalizePair(
                record.pair
            ) !==
            normalizePair(
                pair
            )
        ) {
            continue;
        }

        if (
            settleSignalRecord(
                record,
                sourceCandles
            )
        ) {
            settled += 1;
        }
    }

    return settled;
}


/* =========================================================
   PERFORMANCE
========================================================= */

function getSignalPerformance() {
    const counts = {
        total:
            signalHistory.length,

        pending: 0,

        wins: 0,

        losses: 0,

        draws: 0
    };

    for (
        const signal of signalHistory
    ) {
        if (
            signal.result ===
            'PENDING'
        ) {
            counts.pending += 1;

        } else if (
            signal.result ===
            'WIN'
        ) {
            counts.wins += 1;

        } else if (
            signal.result ===
            'LOSS'
        ) {
            counts.losses += 1;

        } else if (
            signal.result ===
            'DRAW'
        ) {
            counts.draws += 1;
        }
    }

    const settled =
        counts.wins +
        counts.losses +
        counts.draws;

    const decisive =
        counts.wins +
        counts.losses;

    return {
        ...counts,

        settled,

        decisive,

        winRate:
            decisive > 0
                ? roundNumber(
                    (
                        counts.wins /
                        decisive
                    ) *
                        100,
                    2
                )
                : null,

        winRateIncludingDraws:
            settled > 0
                ? roundNumber(
                    (
                        counts.wins /
                        settled
                    ) *
                        100,
                    2
                )
                : null
    };
}


/* =========================================================
   RESULT RANKING
========================================================= */

function rankResult(
    result
) {
    if (!result) {
        return -Infinity;
    }

    const confidence =
        Number(
            result.confidence ||
            0
        );

    const callScore =
        Number(
            result.callScore ||
            0
        );

    const putScore =
        Number(
            result.putScore ||
            0
        );

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
            confidence *
                0.35 +
            Number(
                result.psychologyScore ||
                0
            ) *
                0.10
        );
    }

    let score =
        confidence +
        difference *
            0.60;

    if (
        result.signal ===
            'CALL' &&
        result.marketCondition ===
            'UPTREND'
    ) {
        score += 8;
    }

    if (
        result.signal ===
            'PUT' &&
        result.marketCondition ===
            'DOWNTREND'
    ) {
        score += 8;
    }

    if (
        Number(
            result.indicators?.adx14
        ) >= 25
    ) {
        score += 5;
    }

    if (
        result.signal ===
            'CALL' &&
        result.patternSummary
            ?.direction ===
            'BULLISH'
    ) {
        score += 5;
    }

    if (
        result.signal ===
            'PUT' &&
        result.patternSummary
            ?.direction ===
            'BEARISH'
    ) {
        score += 5;
    }

    if (
        result.signal ===
            'CALL' &&
        result.marketPsychology
            ?.sentiment ===
            'BUYER DOMINANCE'
    ) {
        score += 4;
    }

    if (
        result.signal ===
            'PUT' &&
        result.marketPsychology
            ?.sentiment ===
            'SELLER DOMINANCE'
    ) {
        score += 4;
    }

    if (
        result.signal ===
            'CALL' &&
        Number(
            result.indicators
                ?.stochastic
                ?.k
        ) >
            Number(
                result.indicators
                    ?.stochastic
                    ?.d
            )
    ) {
        score += 3;
    }

    if (
        result.signal ===
            'PUT' &&
        Number(
            result.indicators
                ?.stochastic
                ?.k
        ) <
            Number(
                result.indicators
                    ?.stochastic
                    ?.d
            )
    ) {
        score += 3;
    }

    if (
        result.signal ===
            'CALL' &&
        Number(
            result.indicators
                ?.cci20
        ) > 100
    ) {
        score += 3;
    }

    if (
        result.signal ===
            'PUT' &&
        Number(
            result.indicators
                ?.cci20
        ) < -100
    ) {
        score += 3;
    }

    return score;
}


function chooseBest(
    results
) {
    const valid =
        results.filter(
            Boolean
        );

    if (
        !valid.length
    ) {
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
        !isSupportedPair(
            normalized
        )
    ) {
        throw new Error(
            `${normalized}: unsupported pair.`
        );
    }

    const forceRefresh =
        options.forceRefresh ===
        true;

    const pairData =
        await getPairCandles(
            normalized,
            {
                forceRefresh
            }
        );

    /*
      First settle old signals
      whenever new candle data is available.
    */
    settleSignalsForPair(
        normalized,
        pairData.candles
    );

    const results = [];

    for (
        const timeframe of
            TIMEFRAMES
    ) {
        if (!forceRefresh) {
            const cached =
                getCachedResult(
                    normalized,
                    timeframe
                );

            if (cached) {
                const enriched =
                    registerSignal(
                        {
                            ...cached.result
                        }
                    );

                enriched.cacheAgeSeconds =
                    Math.floor(
                        cached.ageMs /
                            1000
                    );

                enriched.dataCached =
                    true;

                results.push(
                    enriched
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

        const tracked =
            registerSignal(
                result
            );

        setCachedResult(
            normalized,
            timeframe,
            tracked
        );

        results.push(
            tracked
        );
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

        results,

        performance:
            getSignalPerformance()
    };
}


/* =========================================================
   SCANNER
========================================================= */

async function scanBatch() {
    resetDailyStateIfNeeded();

    if (
        scanRunning
    ) {
        return {
            ok: true,

            alreadyRunning:
                true,

            message:
                'Scanner is already running.'
        };
    }

    if (
        quotaBlocked
    ) {
        return {
            ok: false,

            quotaBlocked:
                true,

            error:
                providerQuotaMessage
        };
    }

    if (
        getRemainingRequestBudget() <=
        0
    ) {
        blockForDailyBudget();

        return {
            ok: false,

            quotaBlocked:
                true,

            error:
                providerQuotaMessage
        };
    }

    if (
        getRemainingMinuteBudget() <=
        0
    ) {
        blockForMinuteQuota(
            `Local provider safety limit reached (${PROVIDER_MINUTE_LIMIT} requests/minute). Waiting for the next minute.`
        );

        return {
            ok: true,

            minuteBlocked:
                true,

            retryInSeconds:
                getSecondsUntilMinuteReset(),

            scanned: 0,

            failed: 0,

            nextCursor:
                scanCursor
        };
    }

    scanRunning =
        true;

    lastScanError =
        null;

    const startCursor =
        scanCursor;

    let scanned = 0;

    let failed = 0;

    let attempted = 0;

    const batch = [];

    const errors = [];

    try {
        for (
            let i = 0;
            i < SCAN_BATCH_SIZE;
            i++
        ) {
            if (
                quotaBlocked ||
                getRemainingRequestBudget() <=
                    0
            ) {
                break;
            }

            if (
                getRemainingMinuteBudget() <=
                0
            ) {
                blockForMinuteQuota(
                    `Local provider safety limit reached (${PROVIDER_MINUTE_LIMIT} requests/minute). Waiting for the next minute.`
                );

                break;
            }

            const index =
                (
                    startCursor +
                    i
                ) %
                PAIRS.length;

            const pair =
                PAIRS[index];

            batch.push(
                pair
            );

            attempted += 1;

            try {
                await analyzePair(
                    pair,
                    {
                        forceRefresh:
                            true
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

                lastScanError =
                    message;

                if (
                    looksLikeMinuteQuotaError(
                        error.message
                    ) ||
                    Date.now() <
                        minuteBlockedUntil
                ) {
                    break;
                }

                if (
                    quotaBlocked
                ) {
                    break;
                }
            }
        }

        /*
          Advance only by actually attempted
          pairs. This prevents skipped pairs.
        */
        scanCursor =
            (
                startCursor +
                attempted
            ) %
            PAIRS.length;

        lastScanAt =
            new Date()
                .toISOString();

    } finally {
        scanRunning =
            false;
    }

    return {
        ok:
            !quotaBlocked,

        scanned,

        failed,

        attempted,

        batch,

        nextCursor:
            scanCursor,

        quotaBlocked,

        minuteBlocked:
            Date.now() <
            minuteBlockedUntil,

        retryInSeconds:
            Date.now() <
            minuteBlockedUntil
                ? getSecondsUntilMinuteReset()
                : 0,

        errors,

        lastScanAt
    };
}


/* =========================================================
   COLLECT FRESH RESULTS
========================================================= */

function collectFreshCachedResults() {
    const results = [];

    for (
        const pair of PAIRS
    ) {
        for (
            const timeframe of
                TIMEFRAMES
        ) {
            const cached =
                getCachedResult(
                    pair,
                    timeframe
                );

            if (cached) {
                const result =
                    registerSignal(
                        {
                            ...cached.result
                        }
                    );

                result.cacheAgeSeconds =
                    Math.floor(
                        cached.ageMs /
                            1000
                    );

                result.dataCached =
                    true;

                results.push(
                    result
                );
            }
        }
    }

    return results;
}


/* =========================================================
   ROOT
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

                '/api/selected',

                '/api/performance',

                '/api/history'
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

            minuteBlocked:
                Date.now() <
                minuteBlockedUntil,

            minuteResetAt:
                Date.now() <
                minuteBlockedUntil
                    ? new Date(
                        minuteBlockedUntil
                    ).toISOString()
                    : null,

            minuteRetryInSeconds:
                Date.now() <
                minuteBlockedUntil
                    ? getSecondsUntilMinuteReset()
                    : 0,

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

            providerMinuteBudget: {
                configuredLimit:
                    PROVIDER_MINUTE_LIMIT,

                usedLastMinute:
                    providerRequestTimes.length,

                remaining:
                    getRemainingMinuteBudget()
            },

            cacheTTLMinutes:
                CACHE_TTL_MINUTES,

            resultTTLSeconds:
                RESULT_TTL_SECONDS,

            scanEveryMinutes:
                SCAN_EVERY_MINUTES,

            indicators: {
                macd:
                    true,

                stochastic:
                    true,

                cci20:
                    true,

                candlestickPatterns:
                    true,

                marketPsychology:
                    true
            },

            signalTracking: {
                historySize:
                    signalHistory.length,

                performance:
                    getSignalPerformance()
            },

            time:
                new Date()
                    .toISOString()
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

            minuteBlocked:
                Date.now() <
                minuteBlockedUntil,

            minuteRetryInSeconds:
                Date.now() <
                minuteBlockedUntil
                    ? getSecondsUntilMinuteReset()
                    : 0,

            dailyRequests,

            dailyCreditsUsed,

            remainingBudget:
                getRemainingRequestBudget(),

            remainingMinuteBudget:
                getRemainingMinuteBudget(),

            time:
                new Date()
                    .toISOString()
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

            return res.json(
                result
            );

        } catch (error) {
            scanRunning =
                false;

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
            !isSupportedPair(
                pair
            )
        ) {
            return res
                .status(400)
                .json({
                    ok: false,

                    error:
                        `${pair} is not supported.`,

                    supportedPairs:
                        PAIRS
                });
        }

        const refresh =
            String(
                req.query.refresh ||
                ''
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

                        quotaBlocked:
                            true,

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
            let results =
                collectFreshCachedResults();

            /*
              Only scan if absolutely necessary.
            */
            if (
                !results.length
            ) {
                if (
                    quotaBlocked
                ) {
                    return res
                        .status(429)
                        .json({
                            ok: false,

                            quotaBlocked:
                                true,

                            error:
                                providerQuotaMessage
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

                results =
                    collectFreshCachedResults();
            }

            const best =
                chooseBest(
                    results
                );

            if (!best) {
                return res.json({
                    ok: true,

                    selectedMarket:
                        null,

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

                performance:
                    getSignalPerformance(),

                source:
                    'Twelve Data LIVE',

                time:
                    new Date()
                        .toISOString()
            });

        } catch (error) {

            if (
                quotaBlocked
            ) {
                return res
                    .status(429)
                    .json({
                        ok: false,

                        quotaBlocked:
                            true,

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
   SELECTED
========================================================= */

app.get(
    '/api/selected',
    (req, res) => {
        resetDailyStateIfNeeded();

        const cachedResults =
            collectFreshCachedResults();

        const best =
            chooseBest(
                cachedResults
            );

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
                cachedResults.length,

            performance:
                getSignalPerformance(),

            time:
                new Date()
                    .toISOString()
        });
    }
);


/* =========================================================
   PERFORMANCE
========================================================= */

app.get(
    '/api/performance',
    (req, res) => {
        res.json({
            ok: true,

            version:
                VERSION,

            performance:
                getSignalPerformance(),

            time:
                new Date()
                    .toISOString()
        });
    }
);


/* =========================================================
   SIGNAL HISTORY
========================================================= */

app.get(
    '/api/history',
    (req, res) => {
        const requested =
            Number(
                req.query.limit ||
                30
            );

        const limit =
            clamp(
                requested,
                1,
                HISTORY_LIMIT
            );

        res.json({
            ok: true,

            count:
                Math.min(
                    limit,
                    signalHistory.length
                ),

            performance:
                getSignalPerformance(),

            signals:
                signalHistory.slice(
                    0,
                    limit
                ),

            time:
                new Date()
                    .toISOString()
        });
    }
);


/* =========================================================
   404
========================================================= */

app.use(
    (req, res) => {
        res
            .status(404)
            .json({
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
            'SOURCE: Twelve Data LIVE'
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
            `PROVIDER MINUTE LIMIT: ${PROVIDER_MINUTE_LIMIT}`
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
            'MACD: ENABLED'
        );

        console.log(
            'STOCHASTIC: ENABLED'
        );

        console.log(
            'CCI20: ENABLED'
        );

        console.log(
            'WIN/LOSS TRACKING: ENABLED'
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
