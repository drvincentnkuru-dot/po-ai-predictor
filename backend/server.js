'use strict';

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

/* =========================================================
   PO AI PREDICTOR
   V8.5
   SMART LIVE SCANNER
   CANDLESTICK + MARKET BEHAVIOR CONFLUENCE
========================================================= */

const VERSION = 'V8.5';
const PORT = Number(process.env.PORT || 10000);
const TIMEZONE = 'UTC';

const TWELVE_DATA_URL =
    process.env.TWELVE_DATA_URL ||
    'https://api.twelvedata.com/time_series';

const TWELVE_DATA_API_KEY =
    process.env.TWELVE_DATA_API_KEY || '';


/* =========================================================
   LIVE PAIRS
========================================================= */

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


/* =========================================================
   CONFIG
========================================================= */

const MAX_CANDLES =
    Number(process.env.MAX_CANDLES || 180);

const MIN_CANDLES =
    Number(process.env.MIN_CANDLES || 60);

const SCAN_BATCH_SIZE =
    Math.max(
        1,
        Math.min(
            PAIRS.length,
            Number(process.env.SCAN_BATCH_SIZE || 8)
        )
    );

const SCAN_EVERY_MS =
    Math.max(
        60_000,
        Number(process.env.SCAN_EVERY_MINUTES || 15) *
        60_000
    );

const CACHE_TTL_MS =
    Math.max(
        60_000,
        Number(process.env.CACHE_TTL_MINUTES || 15) *
        60_000
    );

const RESULT_TTL_MS =
    Math.max(
        10_000,
        Number(process.env.RESULT_TTL_SECONDS || 30) *
        1000
    );

const ENTRY_BUFFER_SECONDS = 30;

const DAILY_REQUEST_LIMIT =
    Number(process.env.DAILY_REQUEST_LIMIT || 768);

const SAFETY_RESERVE =
    Number(process.env.SAFETY_RESERVE || 32);

const MAX_SAFE_REQUESTS =
    Math.max(
        1,
        DAILY_REQUEST_LIMIT - SAFETY_RESERVE
    );


/* =========================================================
   CACHE
========================================================= */

const pairCache = new Map();
const resultCache = new Map();


/* =========================================================
   STATE
========================================================= */

const state = {
    scanRunning: false,
    scanCursor: 0,

    lastScanAt: null,
    lastScanError: null,

    totalScanned: 0,
    totalFailed: 0,

    totalApiRequests: 0,

    dailyRequestsUsed: 0,
    dailyResetAt: null,

    quotaBlocked: false,
    quotaBlockReason: null,

    lastProviderMessage: null
};


/* =========================================================
   BASIC HELPERS
========================================================= */

function utcDateKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}


function resetDailyBudgetIfNeeded() {
    const key = utcDateKey();

    if (state.dailyResetAt !== key) {
        state.dailyResetAt = key;

        state.dailyRequestsUsed = 0;

        state.quotaBlocked = false;
        state.quotaBlockReason = null;

        state.lastProviderMessage = null;
    }
}


function normalizePair(pair) {
    return String(pair || '')
        .trim()
        .toUpperCase()
        .replace('-', '/')
        .replace(/\s+/g, '');
}


function isValidPair(pair) {
    return PAIRS.includes(
        normalizePair(pair)
    );
}


function pairToTwelveData(pair) {
    return normalizePair(pair)
        .replace('/', '');
}


function round(value, decimals = 6) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return null;
    }

    const p = 10 ** decimals;

    return Math.round(n * p) / p;
}


function clamp(value, min, max) {
    return Math.max(
        min,
        Math.min(max, value)
    );
}


function average(values) {
    const valid = values.filter(
        Number.isFinite
    );

    if (!valid.length) {
        return null;
    }

    return valid.reduce(
        (a, b) => a + b,
        0
    ) / valid.length;
}


/* =========================================================
   EMA
========================================================= */

function ema(values, period) {
    if (values.length < period) {
        return null;
    }

    const k = 2 / (period + 1);

    let value =
        average(
            values.slice(0, period)
        );

    for (
        let i = period;
        i < values.length;
        i++
    ) {
        value =
            values[i] * k +
            value * (1 - k);
    }

    return value;
}


/* =========================================================
   RSI
========================================================= */

function rsi(values, period = 14) {
    if (
        values.length <
        period + 1
    ) {
        return null;
    }

    let gains = 0;
    let losses = 0;

    for (
        let i = 1;
        i <= period;
        i++
    ) {
        const diff =
            values[i] -
            values[i - 1];

        if (diff >= 0) {
            gains += diff;
        } else {
            losses -= diff;
        }
    }

    let avgGain =
        gains / period;

    let avgLoss =
        losses / period;

    for (
        let i = period + 1;
        i < values.length;
        i++
    ) {
        const diff =
            values[i] -
            values[i - 1];

        const gain =
            Math.max(0, diff);

        const loss =
            Math.max(0, -diff);

        avgGain =
            (
                avgGain * (period - 1) +
                gain
            ) / period;

        avgLoss =
            (
                avgLoss * (period - 1) +
                loss
            ) / period;
    }

    if (avgLoss === 0) {
        return 100;
    }

    const rs =
        avgGain / avgLoss;

    return 100 -
        (100 / (1 + rs));
}


/* =========================================================
   TRUE RANGE / ATR
========================================================= */

function trueRange(
    candle,
    previousClose
) {
    if (!candle) {
        return null;
    }

    if (!Number.isFinite(previousClose)) {
        return candle.high -
            candle.low;
    }

    return Math.max(
        candle.high - candle.low,

        Math.abs(
            candle.high -
            previousClose
        ),

        Math.abs(
            candle.low -
            previousClose
        )
    );
}


function atr(
    candles,
    period = 14
) {
    if (
        candles.length <
        period + 1
    ) {
        return null;
    }

    const trs = [];

    for (
        let i = 0;
        i < candles.length;
        i++
    ) {
        trs.push(
            trueRange(
                candles[i],
                i
                    ? candles[i - 1].close
                    : null
            )
        );
    }

    return average(
        trs.slice(-period)
    );
}


/* =========================================================
   ADX
========================================================= */

function adx(
    candles,
    period = 14
) {
    if (
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

        trs.push(
            trueRange(
                current,
                previous.close
            )
        );

        const upMove =
            current.high -
            previous.high;

        const downMove =
            previous.low -
            current.low;

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

    const dx = [];

    for (
        let i = period;
        i < trs.length;
        i++
    ) {
        const trSum =
            average(
                trs.slice(
                    i - period + 1,
                    i + 1
                )
            ) * period;

        const plusSum =
            plusDM
                .slice(
                    i - period + 1,
                    i + 1
                )
                .reduce(
                    (a, b) => a + b,
                    0
                );

        const minusSum =
            minusDM
                .slice(
                    i - period + 1,
                    i + 1
                )
                .reduce(
                    (a, b) => a + b,
                    0
                );

        if (!trSum) {
            continue;
        }

        const plusDI =
            100 *
            plusSum /
            trSum;

        const minusDI =
            100 *
            minusSum /
            trSum;

        const denominator =
            plusDI +
            minusDI;

        if (!denominator) {
            continue;
        }

        dx.push(
            100 *
            Math.abs(
                plusDI -
                minusDI
            ) /
            denominator
        );
    }

    if (!dx.length) {
        return null;
    }

    return average(
        dx.slice(-period)
    );
}


/* =========================================================
   STANDARD DEVIATION
========================================================= */

function standardDeviation(
    values
) {
    const avg =
        average(values);

    if (!Number.isFinite(avg)) {
        return null;
    }

    return Math.sqrt(
        average(
            values.map(
                value =>
                    (value - avg) ** 2
            )
        )
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
        values.length <
        period
    ) {
        return null;
    }

    const slice =
        values.slice(-period);

    const middle =
        average(slice);

    const deviation =
        standardDeviation(slice);

    return {
        middle,
        upper:
            middle +
            multiplier *
            deviation,
        lower:
            middle -
            multiplier *
            deviation
    };
}


/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
    candles,
    lookback = 50
) {
    const slice =
        candles.slice(-lookback);

    if (!slice.length) {
        return {
            support: null,
            resistance: null
        };
    }

    return {
        support:
            Math.min(
                ...slice.map(
                    c => c.low
                )
            ),

        resistance:
            Math.max(
                ...slice.map(
                    c => c.high
                )
            )
    };
}


/* =========================================================
   CANDLE HELPERS
========================================================= */

function candleBody(candle) {
    return Math.abs(
        candle.close -
        candle.open
    );
}


function candleRange(candle) {
    return Math.max(
        0,
        candle.high -
        candle.low
    );
}


function upperWick(candle) {
    return (
        candle.high -
        Math.max(
            candle.open,
            candle.close
        )
    );
}


function lowerWick(candle) {
    return (
        Math.min(
            candle.open,
            candle.close
        ) -
        candle.low
    );
}


function isBull(candle) {
    return candle.close >
        candle.open;
}


function isBear(candle) {
    return candle.close <
        candle.open;
}


/* =========================================================
   CANDLESTICK PATTERN ENGINE
========================================================= */

function detectCandlestickPatterns(
    candles
) {
    const patterns = [];

    if (candles.length < 5) {
        return patterns;
    }

    const current =
        candles[candles.length - 1];

    const previous =
        candles[candles.length - 2];

    const older =
        candles[candles.length - 3];

    const range =
        candleRange(current);

    const body =
        candleBody(current);

    const safeRange =
        Math.max(
            range,
            Number.EPSILON
        );


    /* -----------------------------------------------------
       BULLISH ENGULFING
    ----------------------------------------------------- */

    if (
        isBull(current) &&
        isBear(previous) &&
        current.open <=
            previous.close &&
        current.close >=
            previous.open
    ) {
        patterns.push({
            name:
                'Bullish Engulfing',

            direction:
                'CALL',

            strength: 3
        });
    }


    /* -----------------------------------------------------
       BEARISH ENGULFING
    ----------------------------------------------------- */

    if (
        isBear(current) &&
        isBull(previous) &&
        current.open >=
            previous.close &&
        current.close <=
            previous.open
    ) {
        patterns.push({
            name:
                'Bearish Engulfing',

            direction:
                'PUT',

            strength: 3
        });
    }


    /* -----------------------------------------------------
       HAMMER
    ----------------------------------------------------- */

    if (
        lowerWick(current) >=
            body * 2 &&

        upperWick(current) <=
            body * 1.2 &&

        body / safeRange <=
            0.45
    ) {
        patterns.push({
            name:
                'Hammer',

            direction:
                'CALL',

            strength: 2
        });
    }


    /* -----------------------------------------------------
       SHOOTING STAR
    ----------------------------------------------------- */

    if (
        upperWick(current) >=
            body * 2 &&

        lowerWick(current) <=
            body * 1.2 &&

        body / safeRange <=
            0.45
    ) {
        patterns.push({
            name:
                'Shooting Star',

            direction:
                'PUT',

            strength: 2
        });
    }


    /* -----------------------------------------------------
       DOJI
    ----------------------------------------------------- */

    if (
        body / safeRange <=
        0.12
    ) {
        patterns.push({
            name:
                'Doji',

            direction:
                'NEUTRAL',

            strength: 1
        });
    }


    /* -----------------------------------------------------
       INSIDE BAR CONTEXT
    ----------------------------------------------------- */

    if (
        older &&
        isBull(older) &&
        isBull(current) &&

        previous.high <
            older.high &&

        previous.low >
            older.low
    ) {
        patterns.push({
            name:
                'Bullish Inside Bar Breakout Context',

            direction:
                'CALL',

            strength: 2
        });
    }


    if (
        older &&
        isBear(older) &&
        isBear(current) &&

        previous.high <
            older.high &&

        previous.low >
            older.low
    ) {
        patterns.push({
            name:
                'Bearish Inside Bar Breakout Context',

            direction:
                'PUT',

            strength: 2
        });
    }


    return patterns;
}


/* =========================================================
   MARKET BEHAVIOR / PSYCHOLOGY PROXY
========================================================= */

function analyzeMarketBehavior(
    candles,
    support,
    resistance
) {
    if (candles.length < 8) {
        return null;
    }

    const recent =
        candles.slice(-5);

    const last =
        recent[recent.length - 1];

    const bodies =
        recent.map(
            candleBody
        );

    const ranges =
        recent.map(
            candleRange
        );

    const averageBody =
        average(bodies);

    const averageRange =
        average(ranges);

    const currentRange =
        candleRange(last);

    const currentBody =
        candleBody(last);

    const price =
        last.close;

    const bullishCount =
        recent.filter(
            isBull
        ).length;

    const bearishCount =
        recent.filter(
            isBear
        ).length;

    const bodyRatio =
        currentRange > 0
            ? currentBody /
              currentRange
            : 0;


    const nearSupport =
        Number.isFinite(
            support
        ) &&
        price > support &&
        (
            price -
            support
        ) <=
        Math.max(
            averageRange * 1.2,
            price * 0.0005
        );


    const nearResistance =
        Number.isFinite(
            resistance
        ) &&
        resistance > price &&
        (
            resistance -
            price
        ) <=
        Math.max(
            averageRange * 1.2,
            price * 0.0005
        );


    const bullishRejection =
        nearSupport &&
        lowerWick(last) >
            currentBody * 1.25;


    const bearishRejection =
        nearResistance &&
        upperWick(last) >
            currentBody * 1.25;


    const expanding =
        Number.isFinite(
            averageRange
        ) &&
        currentRange >
            averageRange * 1.2;


    const compressed =
        Number.isFinite(
            averageRange
        ) &&
        currentRange <
            averageRange * 0.7;


    let callPressure = 0;
    let putPressure = 0;

    const reasons = [];


    /* Buying pressure */

    if (bullishCount >= 4) {
        callPressure += 2;

        reasons.push(
            'Recent candles show persistent buying pressure.'
        );
    }


    /* Selling pressure */

    if (bearishCount >= 4) {
        putPressure += 2;

        reasons.push(
            'Recent candles show persistent selling pressure.'
        );
    }


    /* Support rejection */

    if (bullishRejection) {
        callPressure += 2;

        reasons.push(
            'Price is showing bullish rejection near support.'
        );
    }


    /* Resistance rejection */

    if (bearishRejection) {
        putPressure += 2;

        reasons.push(
            'Price is showing bearish rejection near resistance.'
        );
    }


    /* Strong candle body */

    if (bodyRatio >= 0.65) {
        if (isBull(last)) {
            callPressure += 1;

            reasons.push(
                'The latest candle has a strong bullish body.'
            );
        }

        if (isBear(last)) {
            putPressure += 1;

            reasons.push(
                'The latest candle has a strong bearish body.'
            );
        }
    }


    /* Range expansion */

    if (expanding) {
        reasons.push(
            'Recent candle range is expanding, indicating increased short-term activity.'
        );
    }


    /* Range compression */

    if (compressed) {
        reasons.push(
            'Recent candle range is compressed, indicating reduced short-term activity.'
        );
    }


    return {
        callPressure,
        putPressure,

        buyingPressure:
            bullishCount /
            recent.length,

        sellingPressure:
            bearishCount /
            recent.length,

        nearSupport,
        nearResistance,

        rejectionCall:
            bullishRejection,

        rejectionPut:
            bearishRejection,

        expanding,
        compressed,

        reasons
    };
}


/* =========================================================
   AGGREGATE 1M → 2M / 3M
========================================================= */

function aggregateCandles(
    candles,
    timeframe
) {
    if (timeframe === 1) {
        return candles.slice();
    }

    const buckets =
        new Map();

    const milliseconds =
        timeframe *
        60_000;


    for (const candle of candles) {
        const bucket =
            Math.floor(
                candle.time /
                milliseconds
            ) *
            milliseconds;

        if (!buckets.has(bucket)) {
            buckets.set(
                bucket,
                []
            );
        }

        buckets
            .get(bucket)
            .push(candle);
    }


    const result = [];


    for (
        const [
            time,
            group
        ] of [
            ...buckets.entries()
        ].sort(
            (a, b) =>
                a[0] - b[0]
        )
    ) {
        if (!group.length) {
            continue;
        }

        result.push({
            time,

            open:
                group[0].open,

            high:
                Math.max(
                    ...group.map(
                        c => c.high
                    )
                ),

            low:
                Math.min(
                    ...group.map(
                        c => c.low
                    )
                ),

            close:
                group[
                    group.length - 1
                ].close,

            volume:
                group.reduce(
                    (sum, c) =>
                        sum +
                        (
                            Number(
                                c.volume
                            ) || 0
                        ),
                    0
                ),

            completeMinutes:
                group.length
        });
    }


    return result;
}


/* =========================================================
   TWELVE DATA PARSER
========================================================= */

function parseTwelveData(data) {
    if (
        !data ||
        !Array.isArray(
            data.values
        )
    ) {
        return [];
    }


    return data.values
        .map(value => ({
            time:
                new Date(
                    value.datetime
                ).getTime(),

            open:
                Number(value.open),

            high:
                Number(value.high),

            low:
                Number(value.low),

            close:
                Number(value.close),

            volume:
                Number(
                    value.volume || 0
                )
        }))

        .filter(
            candle =>
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
}


/* =========================================================
   QUOTA DETECTION
========================================================= */

function providerQuotaError(
    message = ''
) {
    const value =
        String(message)
            .toLowerCase();

    return (
        value.includes('credit') ||
        value.includes('quota') ||
        value.includes('rate limit') ||
        value.includes('api limit') ||
        value.includes('too many requests')
    );
}


/* =========================================================
   TWELVE DATA FETCH
========================================================= */

async function fetchTwelveData(
    pair
) {
    resetDailyBudgetIfNeeded();


    if (!TWELVE_DATA_API_KEY) {
        throw new Error(
            'TWELVE_DATA_API_KEY is not configured.'
        );
    }


    if (state.quotaBlocked) {
        throw new Error(
            state.quotaBlockReason ||
            'Twelve Data quota is temporarily blocked.'
        );
    }


    if (
        state.dailyRequestsUsed >=
        MAX_SAFE_REQUESTS
    ) {
        state.quotaBlocked = true;

        state.quotaBlockReason =
            `Daily safety budget reached (${MAX_SAFE_REQUESTS} requests).`;

        throw new Error(
            state.quotaBlockReason
        );
    }


    const symbol =
        pairToTwelveData(pair);


    const url =
        new URL(
            TWELVE_DATA_URL
        );


    url.searchParams.set(
        'symbol',
        symbol
    );

    url.searchParams.set(
        'interval',
        '1min'
    );

    url.searchParams.set(
        'outputsize',
        String(MAX_CANDLES)
    );

    url.searchParams.set(
        'timezone',
        'UTC'
    );

    url.searchParams.set(
        'apikey',
        TWELVE_DATA_API_KEY
    );


    state.dailyRequestsUsed += 1;
    state.totalApiRequests += 1;


    let response;

    try {
        response =
            await fetch(
                url.toString(),
                {
                    headers: {
                        accept:
                            'application/json'
                    }
                }
            );
    } catch (error) {
        throw new Error(
            `Twelve Data network error: ${error.message}`
        );
    }


    let data;

    try {
        data =
            await response.json();
    } catch (_) {
        data = null;
    }


    const providerMessage =
        data?.message ||
        data?.code ||
        '';


    if (
        !response.ok ||
        data?.status === 'error' ||
        providerMessage
    ) {
        state.lastProviderMessage =
            String(
                providerMessage ||
                `HTTP ${response.status}`
            );


        if (
            providerQuotaError(
                providerMessage
            )
        ) {
            state.quotaBlocked = true;

            state.quotaBlockReason =
                `Twelve Data quota/rate limit: ${state.lastProviderMessage}`;
        }


        throw new Error(
            state.lastProviderMessage ||
            `Twelve Data HTTP ${response.status}`
        );
    }


    const candles =
        parseTwelveData(data);


    if (
        candles.length <
        MIN_CANDLES
    ) {
        throw new Error(
            `${pair}: only ${candles.length} candles received; ${MIN_CANDLES} required.`
        );
    }


    return candles;
}


/* =========================================================
   PAIR CACHE
========================================================= */

async function getPairCandles(
    pair,
    options = {}
) {
    resetDailyBudgetIfNeeded();

    const key =
        normalizePair(pair);

    const cached =
        pairCache.get(key);

    const now =
        Date.now();


    if (
        !options.forceRefresh &&
        cached &&
        now - cached.cachedAt <
            CACHE_TTL_MS
    ) {
        return {
            candles:
                cached.candles,

            cachedAt:
                cached.cachedAt,

            stale:
                false,

            fromCache:
                true
        };
    }


    try {
        const candles =
            await fetchTwelveData(
                key
            );


        pairCache.set(
            key,
            {
                candles,
                cachedAt: now
            }
        );


        return {
            candles,
            cachedAt: now,
            stale: false,
            fromCache: false
        };

    } catch (error) {

        /*
          Stale cache is allowed as a
          fallback if live provider fails.
        */

        if (
            cached &&
            cached.candles?.length >=
                MIN_CANDLES
        ) {
            return {
                candles:
                    cached.candles,

                cachedAt:
                    cached.cachedAt,

                stale:
                    true,

                fromCache:
                    true,

                warning:
                    error.message
            };
        }


        throw error;
    }
}


/* =========================================================
   ENTRY / EXPIRY
========================================================= */

function entryAndExpiry(
    timeframe
) {
    const now =
        new Date();

    const milliseconds =
        timeframe *
        60_000;


    let entryMs =
        Math.ceil(
            now.getTime() /
            milliseconds
        ) *
        milliseconds;


    const secondsAway =
        (
            entryMs -
            now.getTime()
        ) / 1000;


    if (
        secondsAway <
        ENTRY_BUFFER_SECONDS
    ) {
        entryMs +=
            milliseconds;
    }


    return {
        entryTime:
            new Date(entryMs),

        expiryTime:
            new Date(
                entryMs +
                milliseconds
            ),

        entryInSeconds:
            Math.max(
                0,
                Math.floor(
                    (
                        entryMs -
                        now.getTime()
                    ) / 1000
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
    candles,
    freshness = {}
) {
    const timeframeCandles =
        aggregateCandles(
            candles,
            timeframe
        );


    if (
        timeframeCandles.length <
        MIN_CANDLES
    ) {
        throw new Error(
            `${pair} ${timeframe}m: insufficient candles (${timeframeCandles.length}).`
        );
    }


    const closes =
        timeframeCandles.map(
            candle =>
                candle.close
        );


    const currentPrice =
        closes[
            closes.length - 1
        ];


    const ema9 =
        ema(closes, 9);

    const ema21 =
        ema(closes, 21);

    const rsi14 =
        rsi(closes, 14);

    const adx14 =
        adx(
            timeframeCandles,
            14
        );

    const atr14 =
        atr(
            timeframeCandles,
            14
        );

    const bollingerBands =
        bollinger(
            closes,
            20,
            2
        );

    const sr =
        supportResistance(
            timeframeCandles,
            50
        );


    /* =====================================================
       NEW V8.5 ENGINES
    ===================================================== */

    const candlestickPatterns =
        detectCandlestickPatterns(
            timeframeCandles
        );


    const marketBehavior =
        analyzeMarketBehavior(
            timeframeCandles,
            sr.support,
            sr.resistance
        );


    /* =====================================================
       MOMENTUM
    ===================================================== */

    const recentMomentum =
        closes.length >= 6
            ? (
                (
                    currentPrice -
                    closes[
                        closes.length - 6
                    ]
                ) /
                closes[
                    closes.length - 6
                ]
            ) * 100
            : 0;


    /* =====================================================
       SCORES
    ===================================================== */

    let callScore = 0;
    let putScore = 0;

    const reasons = [];


    /* -----------------------------------------------------
       EMA / TREND — 30
    ----------------------------------------------------- */

    if (
        Number.isFinite(ema9) &&
        Number.isFinite(ema21)
    ) {
        if (
            ema9 >
            ema21
        ) {
            callScore += 30;

            reasons.push(
                'EMA9 is above EMA21, supporting bullish trend direction.'
            );
        }

        else if (
            ema9 <
            ema21
        ) {
            putScore += 30;

            reasons.push(
                'EMA9 is below EMA21, supporting bearish trend direction.'
            );
        }
    }


    /* -----------------------------------------------------
       RSI — 20
    ----------------------------------------------------- */

    if (
        Number.isFinite(rsi14)
    ) {
        if (
            rsi14 >= 52 &&
            rsi14 < 70
        ) {
            callScore += 20;

            reasons.push(
                `RSI14 is ${rsi14.toFixed(1)}, supporting bullish momentum.`
            );
        }

        else if (
            rsi14 <= 48 &&
            rsi14 > 30
        ) {
            putScore += 20;

            reasons.push(
                `RSI14 is ${rsi14.toFixed(1)}, supporting bearish momentum.`
            );
        }

        else if (
            rsi14 >= 70
        ) {
            callScore += 8;

            reasons.push(
                `RSI14 is ${rsi14.toFixed(1)}, but overbought risk limits the bullish score.`
            );
        }

        else if (
            rsi14 <= 30
        ) {
            putScore += 8;

            reasons.push(
                `RSI14 is ${rsi14.toFixed(1)}, but oversold risk limits the bearish score.`
            );
        }
    }


    /* -----------------------------------------------------
       MOMENTUM — 20
    ----------------------------------------------------- */

    if (
        recentMomentum > 0
    ) {
        callScore += 20;

        reasons.push(
            `Recent momentum is positive (${recentMomentum.toFixed(3)}%).`
        );
    }

    else if (
        recentMomentum < 0
    ) {
        putScore += 20;

        reasons.push(
            `Recent momentum is negative (${recentMomentum.toFixed(3)}%).`
        );
    }


    /* -----------------------------------------------------
       ADX — 15
    ----------------------------------------------------- */

    if (
        Number.isFinite(adx14)
    ) {
        if (
            adx14 >= 25
        ) {
            if (
                callScore >=
                putScore
            ) {
                callScore += 15;
            }

            else {
                putScore += 15;
            }

            reasons.push(
                `ADX14 is ${adx14.toFixed(1)}, confirming meaningful trend strength.`
            );
        }

        else {
            reasons.push(
                `ADX14 is ${adx14.toFixed(1)}, so trend strength is moderate or weak.`
            );
        }
    }


    /* -----------------------------------------------------
       SUPPORT / RESISTANCE BEHAVIOR
    ----------------------------------------------------- */

    if (marketBehavior) {

        if (
            marketBehavior.nearSupport &&
            marketBehavior.rejectionCall
        ) {
            callScore += 5;

            reasons.push(
                'Price is rejecting support with bullish candle structure.'
            );
        }


        if (
            marketBehavior.nearResistance &&
            marketBehavior.rejectionPut
        ) {
            putScore += 5;

            reasons.push(
                'Price is rejecting resistance with bearish candle structure.'
            );
        }
    }


    /* =====================================================
       CANDLESTICK CONFIRMATION
       Maximum contribution: 8 points
    ===================================================== */

    const patternCall =
        candlestickPatterns
            .filter(
                pattern =>
                    pattern.direction ===
                    'CALL'
            )
            .reduce(
                (sum, pattern) =>
                    sum +
                    pattern.strength,
                0
            );


    const patternPut =
        candlestickPatterns
            .filter(
                pattern =>
                    pattern.direction ===
                    'PUT'
            )
            .reduce(
                (sum, pattern) =>
                    sum +
                    pattern.strength,
                0
            );


    callScore +=
        Math.min(
            8,
            patternCall * 2
        );


    putScore +=
        Math.min(
            8,
            patternPut * 2
        );


    for (
        const pattern of
        candlestickPatterns
    ) {
        if (
            pattern.direction ===
            'CALL'
        ) {
            reasons.push(
                `${pattern.name} detected, providing bullish price-action confirmation.`
            );
        }

        else if (
            pattern.direction ===
            'PUT'
        ) {
            reasons.push(
                `${pattern.name} detected, providing bearish price-action confirmation.`
            );
        }

        else {
            reasons.push(
                `${pattern.name} detected, so short-term direction needs confirmation.`
            );
        }
    }


    /* =====================================================
       MARKET BEHAVIOR / PSYCHOLOGY PROXY
    ===================================================== */

    if (marketBehavior) {

        if (
            marketBehavior.callPressure >
            marketBehavior.putPressure
        ) {
            callScore +=
                Math.min(
                    7,
                    marketBehavior.callPressure * 2
                );


            reasons.push(
                ...marketBehavior.reasons
                    .filter(
                        reason =>
                            /buying|bullish|support|activity/i
                                .test(reason)
                    )
            );
        }


        else if (
            marketBehavior.putPressure >
            marketBehavior.callPressure
        ) {
            putScore +=
                Math.min(
                    7,
                    marketBehavior.putPressure * 2
                );


            reasons.push(
                ...marketBehavior.reasons
                    .filter(
                        reason =>
                            /selling|bearish|resistance|activity/i
                                .test(reason)
                    )
            );
        }
    }


    /* =====================================================
       FINAL DECISION
    ===================================================== */

    const difference =
        Math.abs(
            callScore -
            putScore
        );


    const strongest =
        Math.max(
            callScore,
            putScore
        );


    let signal =
        'NO TRADE';


    /*
      Directional signal requires:

      strongest score >= 65
      AND
      score difference >= 15
    */

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


    /* =====================================================
       CONFIDENCE
    ===================================================== */

    const confidence =
        signal === 'NO TRADE'

            ? Math.round(
                clamp(
                    40 +
                    strongest *
                    0.35,

                    40,
                    69
                )
            )

            : Math.round(
                clamp(
                    50 +
                    strongest *
                    0.45 +
                    difference *
                    0.25,

                    50,
                    95
                )
            );


    /* =====================================================
       MARKET CONDITION
    ===================================================== */

    let marketCondition =
        'RANGING';


    if (
        Number.isFinite(adx14) &&
        adx14 < 18
    ) {
        marketCondition =
            'LOW_VOLATILITY_RANGE';
    }

    else if (
        ema9 > ema21 &&
        recentMomentum > 0
    ) {
        marketCondition =
            'UPTREND';
    }

    else if (
        ema9 < ema21 &&
        recentMomentum < 0
    ) {
        marketCondition =
            'DOWNTREND';
    }


    /* =====================================================
       FINAL REASON
    ===================================================== */

    if (
        signal ===
        'NO TRADE'
    ) {
        reasons.push(
            'Signals are not sufficiently aligned for a high-confidence directional setup.'
        );
    }

    else {
        reasons.push(
            `${signal} selected because the strongest directional score is ${Math.round(strongest)} with a ${Math.round(difference)}-point advantage.`
        );
    }


    /* =====================================================
       ENTRY / EXPIRY
    ===================================================== */

    const timing =
        entryAndExpiry(
            timeframe
        );


    const uniqueReasons =
        [
            ...new Set(
                reasons.filter(Boolean)
            )
        ];


    /* =====================================================
       RESULT
    ===================================================== */

    return {
        pair,

        timeframe,

        signal,

        confidence,

        currentPrice:
            round(
                currentPrice,
                pair.includes('JPY')
                    ? 3
                    : 5
            ),

        entryTime:
            timing.entryTime
                .toISOString(),

        expiryTime:
            timing.expiryTime
                .toISOString(),

        entryInSeconds:
            timing.entryInSeconds,

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


        /* =================================================
           TECHNICAL INDICATORS
        ================================================= */

        indicators: {
            ema9:
                round(
                    ema9,
                    6
                ),

            ema21:
                round(
                    ema21,
                    6
                ),

            rsi14:
                round(
                    rsi14,
                    2
                ),

            adx14:
                round(
                    adx14,
                    2
                ),

            atr14:
                round(
                    atr14,
                    6
                ),

            support:
                round(
                    sr.support,
                    6
                ),

            resistance:
                round(
                    sr.resistance,
                    6
                ),

            bollinger:
                bollingerBands
                    ? {
                        middle:
                            round(
                                bollingerBands.middle,
                                6
                            ),

                        upper:
                            round(
                                bollingerBands.upper,
                                6
                            ),

                        lower:
                            round(
                                bollingerBands.lower,
                                6
                            )
                    }
                    : null
        },


        /* =================================================
           CANDLESTICK PATTERNS
        ================================================= */

        candlestickPatterns:
            candlestickPatterns.map(
                pattern => ({
                    name:
                        pattern.name,

                    direction:
                        pattern.direction,

                    strength:
                        pattern.strength
                })
            ),


        /* =================================================
           MARKET BEHAVIOR
        ================================================= */

        marketBehavior:
            marketBehavior
                ? {
                    buyingPressure:
                        round(
                            marketBehavior.buyingPressure,
                            3
                        ),

                    sellingPressure:
                        round(
                            marketBehavior.sellingPressure,
                            3
                        ),

                    nearSupport:
                        marketBehavior.nearSupport,

                    nearResistance:
                        marketBehavior.nearResistance,

                    bullishRejection:
                        marketBehavior.rejectionCall,

                    bearishRejection:
                        marketBehavior.rejectionPut,

                    rangeExpanding:
                        marketBehavior.expanding,

                    rangeCompressed:
                        marketBehavior.compressed
                }
                : null,


        candles:
            timeframeCandles.length,


        source:
            'Twelve Data LIVE',


        analysisTime:
            new Date().toISOString(),


        lastCandle:
            timeframeCandles[
                timeframeCandles.length - 1
            ]?.time

                ? new Date(
                    timeframeCandles[
                        timeframeCandles.length - 1
                    ].time
                ).toISOString()

                : null,


        staleData:
            Boolean(
                freshness.stale
            ),


        dataWarning:
            freshness.warning ||
            null,


        reasons:
            uniqueReasons
    };
}


/* =========================================================
   RESULT RANKING
========================================================= */

function rankResult(result) {
    if (!result) {
        return -Infinity;
    }


    const difference =
        Math.abs(
            (
                result.callScore ||
                0
            ) -
            (
                result.putScore ||
                0
            )
        );


    let rank =
        result.signal ===
        'NO TRADE'

            ? result.confidence *
              0.35

            : result.confidence +
              difference *
              0.6;


    if (
        result.marketCondition ===
        'UPTREND' &&
        result.signal ===
        'CALL'
    ) {
        rank += 8;
    }


    if (
        result.marketCondition ===
        'DOWNTREND' &&
        result.signal ===
        'PUT'
    ) {
        rank += 8;
    }


    if (
        (
            result.indicators?.adx14 ||
            0
        ) >= 25
    ) {
        rank += 5;
    }


    const matchingPattern =
        result
            .candlestickPatterns
            ?.some(
                pattern =>
                    pattern.direction ===
                    result.signal &&
                    pattern.direction !==
                    'NEUTRAL'
            );


    if (matchingPattern) {
        rank += 3;
    }


    return rank;
}


/* =========================================================
   BEST RESULT
========================================================= */

function chooseBest(results) {
    return results
        .filter(Boolean)
        .sort(
            (a, b) =>
                rankResult(b) -
                rankResult(a)
        )[0] || null;
}


/* =========================================================
   ANALYZE ONE PAIR
========================================================= */

async function analyzePair(
    pair,
    options = {}
) {
    const normalized =
        normalizePair(pair);


    if (
        !isValidPair(
            normalized
        )
    ) {
        throw new Error(
            `Invalid pair: ${pair}`
        );
    }


    const market =
        await getPairCandles(
            normalized,
            options
        );


    const results = [];


    for (
        const timeframe of
        TIMEFRAMES
    ) {
        try {
            results.push(
                calculateMarketAnalysis(
                    normalized,
                    timeframe,
                    market.candles,
                    market
                )
            );
        }

        catch (_) {
            /*
              One timeframe failure
              must not destroy the
              other valid timeframes.
            */
        }
    }


    if (!results.length) {
        throw new Error(
            `${normalized}: no valid timeframe analysis.`
        );
    }


    const cachedAt =
        Date.now();


    for (
        const result of
        results
    ) {
        resultCache.set(
            `${normalized}:${result.timeframe}`,
            {
                result,
                cachedAt
            }
        );
    }


    return {
        pair:
            normalized,

        source:
            'Twelve Data LIVE',

        cachedAt:
            new Date(
                cachedAt
            ).toISOString(),

        results
    };
}


/* =========================================================
   SCAN BATCH
========================================================= */

async function scanBatch() {
    resetDailyBudgetIfNeeded();


    if (state.scanRunning) {
        return {
            skipped: true,
            reason:
                'scan_already_running'
        };
    }


    if (state.quotaBlocked) {
        return {
            skipped: true,
            reason:
                state.quotaBlockReason ||
                'quota_blocked'
        };
    }


    state.scanRunning =
        true;

    state.lastScanError =
        null;


    const started =
        Date.now();


    const selectedPairs = [];


    for (
        let i = 0;
        i < SCAN_BATCH_SIZE;
        i++
    ) {
        selectedPairs.push(
            PAIRS[
                (
                    state.scanCursor +
                    i
                ) %
                PAIRS.length
            ]
        );
    }


    let scanned = 0;
    let failed = 0;

    const errors = [];


    try {

        for (
            const pair of
            selectedPairs
        ) {
            if (
                state.quotaBlocked
            ) {
                break;
            }


            try {

                /*
                  IMPORTANT:

                  Use the pair cache when
                  it is still valid.

                  This protects the
                  Twelve Data quota.
                */

                await analyzePair(
                    pair,
                    {
                        forceRefresh:
                            false
                    }
                );

                scanned++;
            }

            catch (error) {
                failed++;

                errors.push(
                    `${pair}: ${error.message}`
                );
            }
        }


        state.scanCursor =
            (
                state.scanCursor +
                selectedPairs.length
            ) %
            PAIRS.length;


        state.totalScanned =
            scanned;

        state.totalFailed =
            failed;


        state.lastScanAt =
            new Date()
                .toISOString();


        if (errors.length) {
            state.lastScanError =
                errors.join(
                    ' | '
                );
        }

    }

    finally {
        state.scanRunning =
            false;
    }


    return {
        scanned,

        failed,

        pairs:
            selectedPairs,

        durationMs:
            Date.now() -
            started,

        errors
    };
}


/* =========================================================
   FRESH RESULTS
========================================================= */

function freshResults() {
    const now =
        Date.now();

    const results = [];


    for (
        const item of
        resultCache.values()
    ) {
        if (
            now -
            item.cachedAt <=
            RESULT_TTL_MS
        ) {
            results.push(
                item.result
            );
        }
    }


    return results;
}


/* =========================================================
   HEALTH
========================================================= */

function healthPayload() {
    resetDailyBudgetIfNeeded();


    return {
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
            freshResults().length,

        scanRunning:
            state.scanRunning,

        scanCursor:
            state.scanCursor,

        scanBatchSize:
            SCAN_BATCH_SIZE,

        lastScanAt:
            state.lastScanAt,

        lastScanError:
            state.lastScanError,

        totalScanned:
            state.totalScanned,

        totalFailed:
            state.totalFailed,

        totalApiRequests:
            state.totalApiRequests,

        apiKeyConfigured:
            Boolean(
                TWELVE_DATA_API_KEY
            ),

        quotaBlocked:
            state.quotaBlocked,

        apiBudget: {
            dailyRequestLimit:
                DAILY_REQUEST_LIMIT,

            safetyReserve:
                SAFETY_RESERVE,

            maxSafeRequests:
                MAX_SAFE_REQUESTS,

            requestsUsedToday:
                state.dailyRequestsUsed,

            requestsRemainingSafe:
                Math.max(
                    0,
                    MAX_SAFE_REQUESTS -
                    state.dailyRequestsUsed
                )
        },

        time:
            new Date().toISOString()
    };
}


/* =========================================================
   ROOT
========================================================= */

app.get(
    '/',
    (req, res) => {
        res.json({
            ok: true,

            name:
                'PO AI Predictor API',

            version:
                VERSION,

            endpoints: [
                '/api/health',
                '/api/best',
                '/api/analyze?pair=EUR/USD',
                '/api/scan',
                '/api/scan/status',
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
        res.json(
            healthPayload()
        );
    }
);


/* =========================================================
   SCAN STATUS
========================================================= */

app.get(
    '/api/scan/status',
    (req, res) => {
        resetDailyBudgetIfNeeded();


        res.json({
            ok: true,

            version:
                VERSION,

            scanRunning:
                state.scanRunning,

            scanCursor:
                state.scanCursor,

            scanBatchSize:
                SCAN_BATCH_SIZE,

            cachedPairs:
                pairCache.size,

            cachedResults:
                freshResults().length,

            lastScanAt:
                state.lastScanAt,

            lastScanError:
                state.lastScanError,

            totalScanned:
                state.totalScanned,

            totalFailed:
                state.totalFailed,

            quotaBlocked:
                state.quotaBlocked,

            quotaBlockReason:
                state.quotaBlockReason,

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


            res.json({
                ok: true,

                version:
                    VERSION,

                ...result,

                time:
                    new Date()
                        .toISOString()
            });

        }

        catch (error) {
            res.status(500)
                .json({
                    ok: false,

                    version:
                        VERSION,

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
            normalizePair(
                req.query.pair
            );


        if (
            !isValidPair(pair)
        ) {
            return res
                .status(400)
                .json({
                    ok: false,

                    version:
                        VERSION,

                    error:
                        'Valid pair is required.',

                    pairs:
                        PAIRS
                });
        }


        try {

            const result =
                await analyzePair(
                    pair,
                    {
                        forceRefresh:
                            req.query.refresh ===
                            '1'
                    }
                );


            res.json({
                ok: true,

                version:
                    VERSION,

                ...result
            });

        }

        catch (error) {

            res.status(503)
                .json({
                    ok: false,

                    version:
                        VERSION,

                    error:
                        error.message
                });
        }
    }
);


/* =========================================================
   SMART BEST MARKET
========================================================= */

app.get(
    '/api/best',
    async (req, res) => {

        resetDailyBudgetIfNeeded();


        let results =
            freshResults();


        /*
          If there are no fresh results,
          run one controlled scan.
        */

        if (
            !results.length &&
            !state.quotaBlocked
        ) {
            await scanBatch();

            results =
                freshResults();
        }


        const best =
            chooseBest(results);


        if (!best) {

            return res
                .status(503)
                .json({

                    ok: false,

                    version:
                        VERSION,

                    error:
                        state.quotaBlocked

                            ? (
                                state.quotaBlockReason ||
                                'Live data quota is temporarily blocked.'
                            )

                            : 'No selected market is currently available.',

                    quotaBlocked:
                        state.quotaBlocked,

                    time:
                        new Date()
                            .toISOString()
                });
        }


        res.json({
            ok: true,

            version:
                VERSION,

            selectedMarket:
                best,

            scannedResults:
                results.length,

            quotaBlocked:
                state.quotaBlocked,

            time:
                new Date()
                    .toISOString()
        });
    }
);


/* =========================================================
   SELECTED COMPATIBILITY ROUTE
========================================================= */

app.get(
    '/api/selected',
    (req, res) => {

        const best =
            chooseBest(
                freshResults()
            );


        if (!best) {
            return res
                .status(404)
                .json({

                    ok: false,

                    version:
                        VERSION,

                    error:
                        'No fresh selected market available.'
                });
        }


        res.json({
            ok: true,

            version:
                VERSION,

            selectedMarket:
                best,

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
        res.status(404)
            .json({
                ok: false,

                error:
                    'Not found',

                version:
                    VERSION
            });
    }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    () => {

        resetDailyBudgetIfNeeded();


        console.log(
            `[PO AI PREDICTOR] ${VERSION} running on port ${PORT}`
        );

        console.log(
            `[PO AI PREDICTOR] Source: Twelve Data LIVE`
        );

        console.log(
            `[PO AI PREDICTOR] Pairs: ${PAIRS.length}`
        );

        console.log(
            `[PO AI PREDICTOR] Timeframes: ${TIMEFRAMES.join(', ')}`
        );

        console.log(
            `[PO AI PREDICTOR] Candlestick engine: ENABLED`
        );

        console.log(
            `[PO AI PREDICTOR] Market behavior engine: ENABLED`
        );

        console.log(
            `[PO AI PREDICTOR] Safe daily request budget: ${MAX_SAFE_REQUESTS}`
        );


        /*
          Initial controlled scan.
        */

        setTimeout(
            () => {
                scanBatch()
                    .catch(
                        error =>
                            console.error(
                                '[INITIAL SCAN ERROR]',
                                error.message
                            )
                    );
            },
            10_000
        );


        /*
          Scheduled controlled scan.
        */

        setInterval(
            () => {
                scanBatch()
                    .catch(
                        error =>
                            console.error(
                                '[SCHEDULED SCAN ERROR]',
                                error.message
                            )
                    );
            },
            SCAN_EVERY_MS
        );
    }
);
