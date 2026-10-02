'use strict';

/*
===========================================================
 PO AI PREDICTOR
 V8.6.1 • SMART LIVE SCANNER + AUTO SETTLEMENT

 SOURCE:
 Twelve Data LIVE

 V8.6.1 CHANGES
 ----------------------------------------------------------
 1. Quota-safe provider limiter: max 7 requests / rolling min
 2. Separate daily and minute quota protection
 3. Stochastic (14,3,3)
 4. CCI20
 5. MACD retained
 6. Candlestick pattern detection retained
 7. Market psychology retained
 8. Automatic WIN / LOSS / DRAW settlement loop
 9. Fresh candle retrieval for expired signals
10. 3-minute aggregation tolerance / incomplete bucket fix
11. /api/performance
12. /api/history
13. /api/scan/status
14. /api/best
15. /api/selected
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

const VERSION = 'V8.6.1';

const PORT = Number(process.env.PORT || 10000);

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVEDATA_API_KEY ||
  '';

const TWELVE_DATA_URL = 'https://api.twelvedata.com/time_series';

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

const MAX_CANDLES = 180;
const MIN_CANDLES = 60;

/*
Twelve Data account was returning an 8 credits/minute limit.

We intentionally use 7 as the application ceiling.
*/
const PROVIDER_MINUTE_LIMIT = 7;

const SCAN_BATCH_SIZE = Math.min(
  Number(process.env.SCAN_BATCH_SIZE || 7),
  PROVIDER_MINUTE_LIMIT
);

const SCAN_EVERY_MINUTES =
  Number(process.env.SCAN_EVERY_MINUTES || 15);

const SCAN_EVERY_MS = SCAN_EVERY_MINUTES * 60 * 1000;

const CACHE_TTL_MINUTES =
  Number(process.env.CACHE_TTL_MINUTES || 15);

const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

const RESULT_TTL_SECONDS =
  Number(process.env.RESULT_TTL_SECONDS || 30);

const RESULT_TTL_MS = RESULT_TTL_SECONDS * 1000;

const ENTRY_BUFFER_SECONDS =
  Number(process.env.ENTRY_BUFFER_SECONDS || 30);

/*
Daily protection.

We reserve 32 credits and never intentionally consume them.
*/
const DAILY_REQUEST_LIMIT =
  Number(process.env.DAILY_REQUEST_LIMIT || 768);

const SAFETY_RESERVE =
  Number(process.env.SAFETY_RESERVE || 32);

const MAX_DAILY_REQUESTS =
  Math.max(0, DAILY_REQUEST_LIMIT - SAFETY_RESERVE);

/*
Automatic settlement loop.
*/
const SETTLEMENT_INTERVAL_MS = 10000;

const SETTLEMENT_GRACE_SECONDS =
  Number(process.env.SETTLEMENT_GRACE_SECONDS || 10);

const SIGNAL_HISTORY_LIMIT =
  Number(process.env.SIGNAL_HISTORY_LIMIT || 100);

/*
Freshness protection.

If the newest completed 1-minute candle is too old,
the result should not be treated as fresh market analysis.
*/
const MAX_DATA_AGE_SECONDS = 150;

/* =========================================================
   STATE
========================================================= */

const pairCache = new Map();
const resultCache = new Map();

const signalRegistry = new Map();
const signalKeyRegistry = new Map();
const signalHistory = [];

let scanCursor = 0;
let scanRunning = false;
let lastScanAt = null;
let lastScanError = null;
let totalScanned = 0;
let totalFailed = 0;
let totalApiRequests = 0;

/*
Daily request accounting.
*/
let dailyRequests = 0;
let dailyCreditsUsed = 0;
let dailyDateKey = getUtcDateKey(new Date());

let quotaBlocked = false;
let quotaBlockedUntil = null;
let providerQuotaMessage = null;

/*
Rolling 60-second local request limiter.
*/
const providerRequestTimes = [];

let minuteBlockedUntil = null;

/* =========================================================
   HELPERS
========================================================= */

function nowMs() {
  return Date.now();
}

function getUtcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function resetDailyCounterIfNeeded() {
  const currentKey = getUtcDateKey(new Date());

  if (currentKey !== dailyDateKey) {
    dailyDateKey = currentKey;

    dailyRequests = 0;
    dailyCreditsUsed = 0;

    quotaBlocked = false;
    quotaBlockedUntil = null;
    providerQuotaMessage = null;
  }
}

function cleanupProviderRequestTimes() {
  const cutoff = nowMs() - 60000;

  while (
    providerRequestTimes.length &&
    providerRequestTimes[0] <= cutoff
  ) {
    providerRequestTimes.shift();
  }

  if (
    minuteBlockedUntil &&
    nowMs() >= minuteBlockedUntil
  ) {
    minuteBlockedUntil = null;
  }
}

function getRemainingMinuteBudget() {
  cleanupProviderRequestTimes();

  return Math.max(
    0,
    PROVIDER_MINUTE_LIMIT - providerRequestTimes.length
  );
}

function getSecondsUntilMinuteReset() {
  cleanupProviderRequestTimes();

  if (!providerRequestTimes.length) {
    return 0;
  }

  const oldest = providerRequestTimes[0];

  return Math.max(
    0,
    Math.ceil((oldest + 60000 - nowMs()) / 1000)
  );
}

function getRemainingRequestBudget() {
  resetDailyCounterIfNeeded();

  return Math.max(
    0,
    MAX_DAILY_REQUESTS - dailyRequests
  );
}

function canMakeProviderRequest() {
  resetDailyCounterIfNeeded();
  cleanupProviderRequestTimes();

  if (quotaBlocked) {
    return false;
  }

  if (
    quotaBlockedUntil &&
    nowMs() < quotaBlockedUntil
  ) {
    return false;
  }

  if (
    minuteBlockedUntil &&
    nowMs() < minuteBlockedUntil
  ) {
    return false;
  }

  if (dailyRequests >= MAX_DAILY_REQUESTS) {
    return false;
  }

  if (providerRequestTimes.length >= PROVIDER_MINUTE_LIMIT) {
    return false;
  }

  return true;
}

function reserveProviderRequest() {
  resetDailyCounterIfNeeded();
  cleanupProviderRequestTimes();

  if (quotaBlocked) {
    return {
      ok: false,
      reason: 'daily_quota_blocked'
    };
  }

  if (
    minuteBlockedUntil &&
    nowMs() < minuteBlockedUntil
  ) {
    return {
      ok: false,
      reason: 'minute_quota_blocked'
    };
  }

  if (dailyRequests >= MAX_DAILY_REQUESTS) {
    blockForDailyBudget(
      'Local daily safety budget reached.'
    );

    return {
      ok: false,
      reason: 'daily_budget_exhausted'
    };
  }

  if (
    providerRequestTimes.length >=
    PROVIDER_MINUTE_LIMIT
  ) {
    return {
      ok: false,
      reason: 'minute_budget_exhausted'
    };
  }

  providerRequestTimes.push(nowMs());

  dailyRequests += 1;
  dailyCreditsUsed += 1;
  totalApiRequests += 1;

  return {
    ok: true
  };
}

function blockForDailyBudget(message) {
  quotaBlocked = true;
  providerQuotaMessage = message;

  const nextDay = new Date();

  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  nextDay.setUTCHours(0, 0, 0, 0);

  quotaBlockedUntil = nextDay.getTime();
}

function blockForMinuteQuota(message) {
  providerQuotaMessage = message;

  const now = new Date();

  const nextMinute = new Date(now);

  nextMinute.setUTCSeconds(0, 0);
  nextMinute.setUTCMinutes(
    nextMinute.getUTCMinutes() + 1
  );

  minuteBlockedUntil = nextMinute.getTime();
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function roundPrice(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (Math.abs(value) >= 20) {
    return Number(value.toFixed(3));
  }

  if (Math.abs(value) >= 5) {
    return Number(value.toFixed(4));
  }

  return Number(value.toFixed(5));
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();

  return Number.isFinite(timestamp)
    ? timestamp
    : null;
}

/* =========================================================
   QUOTA ERROR DETECTION
========================================================= */

function isMinuteQuotaMessage(message) {
  const text = String(message || '').toLowerCase();

  return (
    text.includes('current minute') ||
    text.includes('per minute') ||
    text.includes('minute limit') ||
    text.includes('minute quota') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('api credits') &&
    (
      text.includes('minute') ||
      text.includes('limit')
    )
  );
}

function isDailyQuotaMessage(message) {
  const text = String(message || '').toLowerCase();

  return (
    text.includes('daily limit') ||
    text.includes('daily quota') ||
    text.includes('daily credits') ||
    text.includes('credits exhausted') ||
    text.includes('run out of api credits')
  );
}

/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchTwelveData(
  pair,
  outputsize = MAX_CANDLES
) {
  const reservation = reserveProviderRequest();

  if (!reservation.ok) {
    throw new Error(
      `Provider request blocked locally: ${reservation.reason}`
    );
  }

  const url = new URL(TWELVE_DATA_URL);

  url.searchParams.set(
    'symbol',
    pair
  );

  url.searchParams.set(
    'interval',
    '1min'
  );

  url.searchParams.set(
    'outputsize',
    String(outputsize)
  );

  url.searchParams.set(
    'order',
    'asc'
  );

  url.searchParams.set(
    'timezone',
    TIMEZONE
  );

  url.searchParams.set(
    'apikey',
    TWELVE_DATA_API_KEY
  );

  let response;

  try {
    response = await fetch(
      url.toString(),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json'
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
    data = await response.json();
  } catch (error) {
    throw new Error(
      `Twelve Data returned invalid JSON. HTTP ${response.status}`
    );
  }

  if (
    data &&
    (
      data.status === 'error' ||
      data.code ||
      data.message
    )
  ) {
    const message =
      data.message ||
      data.code ||
      `HTTP ${response.status}`;

    if (isMinuteQuotaMessage(message)) {
      blockForMinuteQuota(message);
    }

    if (isDailyQuotaMessage(message)) {
      blockForDailyBudget(message);
    }

    throw new Error(
      `Twelve Data: ${message}`
    );
  }

  if (
    !data ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      `Twelve Data returned no candle values for ${pair}.`
    );
  }

  return normalizeCandles(data.values);
}

/* =========================================================
   CANDLE NORMALIZATION
========================================================= */

function normalizeCandles(values) {
  const candles = [];

  for (const row of values) {
    const timestamp =
      parseTimestamp(row.datetime);

    const open = safeNumber(row.open);
    const high = safeNumber(row.high);
    const low = safeNumber(row.low);
    const close = safeNumber(row.close);

    if (
      timestamp === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null
    ) {
      continue;
    }

    candles.push({
      time: timestamp,
      open,
      high,
      low,
      close
    });
  }

  candles.sort(
    (a, b) => a.time - b.time
  );

  return candles;
}

/* =========================================================
   CANDLE QUALITY / GAP HANDLING
========================================================= */

function candleMinuteKey(timestamp) {
  return Math.floor(timestamp / 60000);
}

function deduplicateCandles(candles) {
  const map = new Map();

  for (const candle of candles) {
    map.set(
      candleMinuteKey(candle.time),
      candle
    );
  }

  return Array.from(map.values())
    .sort((a, b) => a.time - b.time);
}

function getLatestCandleAgeSeconds(candles) {
  if (!candles.length) {
    return Infinity;
  }

  const latest =
    candles[candles.length - 1].time;

  return Math.max(
    0,
    Math.floor(
      (nowMs() - latest) / 1000
    )
  );
}

function isCandleDataFresh(candles) {
  return (
    getLatestCandleAgeSeconds(candles) <=
    MAX_DATA_AGE_SECONDS
  );
}

/* =========================================================
   CACHE
========================================================= */

function setPairCache(pair, candles) {
  pairCache.set(pair, {
    candles,
    fetchedAt: nowMs()
  });
}

function getPairCache(pair) {
  return pairCache.get(pair) || null;
}

function getFreshPairCache(pair) {
  const cached = getPairCache(pair);

  if (!cached) {
    return null;
  }

  if (
    nowMs() - cached.fetchedAt >
    CACHE_TTL_MS
  ) {
    return null;
  }

  return cached;
}

function getStalePairCache(pair) {
  return getPairCache(pair);
}

async function getPairCandles(
  pair,
  options = {}
) {
  const allowStale =
    options.allowStale !== false;

  const forceFresh =
    options.forceFresh === true;

  const fresh =
    forceFresh
      ? null
      : getFreshPairCache(pair);

  if (fresh) {
    return {
      candles: fresh.candles,
      cached: true,
      stale: false,
      fetchedAt: fresh.fetchedAt,
      source: 'CACHE'
    };
  }

  if (!TWELVE_DATA_API_KEY) {
    const stale =
      getStalePairCache(pair);

    if (stale && allowStale) {
      return {
        candles: stale.candles,
        cached: true,
        stale: true,
        fetchedAt: stale.fetchedAt,
        source: 'STALE_CACHE'
      };
    }

    throw new Error(
      'TWELVE_DATA_API_KEY is not configured.'
    );
  }

  if (!canMakeProviderRequest()) {
    const stale =
      getStalePairCache(pair);

    if (stale && allowStale) {
      return {
        candles: stale.candles,
        cached: true,
        stale: true,
        fetchedAt: stale.fetchedAt,
        source: 'STALE_CACHE'
      };
    }

    throw new Error(
      'Twelve Data request temporarily blocked by local quota protection.'
    );
  }

  try {
    const candles =
      await fetchTwelveData(
        pair,
        MAX_CANDLES
      );

    if (candles.length < MIN_CANDLES) {
      throw new Error(
        `${pair}: insufficient candles (${candles.length}/${MIN_CANDLES}).`
      );
    }

    setPairCache(pair, candles);

    return {
      candles,
      cached: false,
      stale: false,
      fetchedAt: nowMs(),
      source: 'TWELVE_DATA'
    };
  } catch (error) {
    const stale =
      getStalePairCache(pair);

    if (stale && allowStale) {
      return {
        candles: stale.candles,
        cached: true,
        stale: true,
        fetchedAt: stale.fetchedAt,
        source: 'STALE_CACHE',
        fallbackError: error.message
      };
    }

    throw error;
  }
}

/* =========================================================
   AGGREGATION
========================================================= */

function aggregateCandles(
  candles,
  timeframe
) {
  if (timeframe === 1) {
    return deduplicateCandles(candles);
  }

  const sorted =
    deduplicateCandles(candles);

  const buckets = new Map();

  for (const candle of sorted) {
    const minute =
      candleMinuteKey(candle.time);

    const bucketStart =
      Math.floor(
        minute / timeframe
      ) * timeframe * 60000;

    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, []);
    }

    buckets.get(bucketStart).push(candle);
  }

  const result = [];

  for (const [
    bucketStart,
    bucket
  ] of buckets.entries()) {
    /*
    Important V8.6.1 fix:

    Only complete timeframe buckets are used.
    For example, 3m requires 3 actual minute candles.
    */
    const minuteKeys =
      new Set(
        bucket.map(
          candle =>
            candleMinuteKey(candle.time)
        )
      );

    let complete = true;

    for (
      let i = 0;
      i < timeframe;
      i++
    ) {
      if (
        !minuteKeys.has(
          candleMinuteKey(bucketStart) + i
        )
      ) {
        complete = false;
        break;
      }
    }

    if (!complete) {
      continue;
    }

    bucket.sort(
      (a, b) => a.time - b.time
    );

    result.push({
      time: bucketStart,
      open: bucket[0].open,
      high: Math.max(
        ...bucket.map(c => c.high)
      ),
      low: Math.min(
        ...bucket.map(c => c.low)
      ),
      close:
        bucket[bucket.length - 1].close
    });
  }

  return result.sort(
    (a, b) => a.time - b.time
  );
}

/* =========================================================
   EMA
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

  let value = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    value += values[i];
  }

  value /= period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    value =
      (
        values[i] - value
      ) *
        multiplier +
      value;
  }

  return value;
}

/* =========================================================
   SMA
========================================================= */

function sma(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  let total = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    total += values[i];
  }

  return total / period;
}

/* =========================================================
   RSI
========================================================= */

function rsi(values, period = 14) {
  if (
    !values ||
    values.length < period + 1
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  const start =
    values.length - period;

  for (
    let i = start;
    i < values.length;
    i++
  ) {
    const previous =
      values[i - 1];

    const change =
      values[i] - previous;

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain =
    gains / period;

  const avgLoss =
    losses / period;

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

/* =========================================================
   ATR
========================================================= */

function atr(candles, period = 14) {
  if (
    !candles ||
    candles.length < period + 1
  ) {
    return null;
  }

  const trs = [];

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
  }

  if (trs.length < period) {
    return null;
  }

  return sma(trs, period);
}

/* =========================================================
   ADX
========================================================= */

function adx(candles, period = 14) {
  if (
    !candles ||
    candles.length < period * 2 + 1
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

  const atrValue =
    sma(trs, period);

  if (
    !atrValue ||
    atrValue === 0
  ) {
    return null;
  }

  const plus =
    sma(plusDM, period);

  const minus =
    sma(minusDM, period);

  if (
    plus === null ||
    minus === null
  ) {
    return null;
  }

  const plusDI =
    100 * (plus / atrValue);

  const minusDI =
    100 * (minus / atrValue);

  const denominator =
    plusDI + minusDI;

  if (denominator === 0) {
    return 0;
  }

  return (
    100 *
    Math.abs(
      plusDI - minusDI
    ) /
    denominator
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
    !values ||
    values.length < period
  ) {
    return null;
  }

  const recent =
    values.slice(-period);

  const middle =
    recent.reduce(
      (a, b) => a + b,
      0
    ) / period;

  let variance = 0;

  for (const value of recent) {
    variance +=
      Math.pow(
        value - middle,
        2
      );
  }

  variance /= period;

  const deviation =
    Math.sqrt(variance);

  return {
    upper:
      middle +
      multiplier * deviation,
    middle,
    lower:
      middle -
      multiplier * deviation
  };
}

/* =========================================================
   MACD
========================================================= */

function macd(values) {
  if (
    !values ||
    values.length < 35
  ) {
    return null;
  }

  const fastValues = [];

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    const slice =
      values.slice(
        0,
        i + 1
      );

    const fast =
      ema(slice, 12);

    const slow =
      ema(slice, 26);

    if (
      fast !== null &&
      slow !== null
    ) {
      fastValues.push(
        fast - slow
      );
    }
  }

  if (fastValues.length < 9) {
    return null;
  }

  const line =
    fastValues[
      fastValues.length - 1
    ];

  const signal =
    ema(
      fastValues,
      9
    );

  if (signal === null) {
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
   STOCHASTIC 14,3,3
========================================================= */

function stochastic(
  candles,
  period = 14,
  smoothK = 3,
  smoothD = 3
) {
  if (
    !candles ||
    candles.length <
      period + smoothK + smoothD
  ) {
    return null;
  }

  const rawK = [];

  for (
    let i = period - 1;
    i < candles.length;
    i++
  ) {
    const window =
      candles.slice(
        i - period + 1,
        i + 1
      );

    const highestHigh =
      Math.max(
        ...window.map(
          c => c.high
        )
      );

    const lowestLow =
      Math.min(
        ...window.map(
          c => c.low
        )
      );

    const range =
      highestHigh -
      lowestLow;

    const current =
      candles[i].close;

    const k =
      range === 0
        ? 50
        : 100 *
          (
            (current -
              lowestLow) /
            range
          );

    rawK.push(k);
  }

  if (rawK.length < smoothK) {
    return null;
  }

  const smoothedK = [];

  for (
    let i = smoothK - 1;
    i < rawK.length;
    i++
  ) {
    const section =
      rawK.slice(
        i - smoothK + 1,
        i + 1
      );

    smoothedK.push(
      section.reduce(
        (a, b) => a + b,
        0
      ) / smoothK
    );
  }

  if (
    smoothedK.length <
    smoothD
  ) {
    return null;
  }

  const k =
    smoothedK[
      smoothedK.length - 1
    ];

  const d =
    smoothedK
      .slice(
        -smoothD
      )
      .reduce(
        (a, b) => a + b,
        0
      ) / smoothD;

  return {
    k,
    d
  };
}

/* =========================================================
   CCI20
========================================================= */

function cci(
  candles,
  period = 20
) {
  if (
    !candles ||
    candles.length < period
  ) {
    return null;
  }

  const typicalPrices =
    candles.map(
      candle =>
        (
          candle.high +
          candle.low +
          candle.close
        ) / 3
    );

  const recent =
    typicalPrices.slice(
      -period
    );

  const mean =
    recent.reduce(
      (a, b) => a + b,
      0
    ) / period;

  let deviation = 0;

  for (const value of recent) {
    deviation +=
      Math.abs(
        value - mean
      );
  }

  const meanDeviation =
    deviation / period;

  if (meanDeviation === 0) {
    return 0;
  }

  const current =
    typicalPrices[
      typicalPrices.length - 1
    ];

  return (
    (current - mean) /
    (0.015 * meanDeviation)
  );
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
  candles,
  lookback = 30
) {
  if (
    !candles ||
    candles.length < lookback
  ) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    candles.slice(
      -lookback
    );

  return {
    support: Math.min(
      ...recent.map(
        c => c.low
      )
    ),
    resistance: Math.max(
      ...recent.map(
        c => c.high
      )
    )
  };
}

/* =========================================================
   MOMENTUM
========================================================= */

function momentum(
  closes,
  lookback = 5
) {
  if (
    !closes ||
    closes.length <= lookback
  ) {
    return null;
  }

  const current =
    closes[
      closes.length - 1
    ];

  const previous =
    closes[
      closes.length -
        1 -
        lookback
    ];

  if (
    previous === 0
  ) {
    return 0;
  }

  return (
    (
      current -
      previous
    ) /
    previous
  ) * 100;
}

/* =========================================================
   CANDLESTICK PATTERNS
========================================================= */

function candleBody(candle) {
  return Math.abs(
    candle.close -
      candle.open
  );
}

function candleRange(candle) {
  return Math.max(
    0.00000001,
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

function isBullish(candle) {
  return (
    candle.close >
    candle.open
  );
}

function isBearish(candle) {
  return (
    candle.close <
    candle.open
  );
}

function detectCandlestickPatterns(
  candles
) {
  if (
    !candles ||
    candles.length < 5
  ) {
    return {
      direction: 'NEUTRAL',
      strength: 0,
      names: [],
      text:
        'Not enough candles for pattern detection.'
    };
  }

  const names = [];
  let bullishScore = 0;
  let bearishScore = 0;

  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const p3 =
    candles[candles.length - 3];

  const body =
    candleBody(last);

  const range =
    candleRange(last);

  const upper =
    upperWick(last);

  const lower =
    lowerWick(last);

  /*
  Doji
  */
  if (
    body <=
    range * 0.10
  ) {
    names.push('Doji');
  }

  /*
  Hammer
  */
  if (
    lower >= body * 2 &&
    upper <= body &&
    body / range <= 0.40
  ) {
    names.push('Hammer');
    bullishScore += 2;
  }

  /*
  Shooting Star
  */
  if (
    upper >= body * 2 &&
    lower <= body &&
    body / range <= 0.40
  ) {
    names.push('Shooting Star');
    bearishScore += 2;
  }

  /*
  Bullish Pin Bar
  */
  if (
    lower >=
      range * 0.55 &&
    upper <=
      range * 0.20
  ) {
    names.push(
      'Bullish Pin Bar'
    );
    bullishScore += 2;
  }

  /*
  Bearish Pin Bar
  */
  if (
    upper >=
      range * 0.55 &&
    lower <=
      range * 0.20
  ) {
    names.push(
      'Bearish Pin Bar'
    );
    bearishScore += 2;
  }

  /*
  Bullish engulfing
  */
  if (
    isBullish(last) &&
    isBearish(previous) &&
    last.open <=
      previous.close &&
    last.close >=
      previous.open
  ) {
    names.push(
      'Bullish Engulfing'
    );
    bullishScore += 3;
  }

  /*
  Bearish engulfing
  */
  if (
    isBearish(last) &&
    isBullish(previous) &&
    last.open >=
      previous.close &&
    last.close <=
      previous.open
  ) {
    names.push(
      'Bearish Engulfing'
    );
    bearishScore += 3;
  }

  /*
  Morning Star
  */
  if (
    isBearish(p3) &&
    candleBody(previous) <
      candleRange(previous) *
        0.35 &&
    isBullish(last) &&
    last.close >
      (
        p3.open +
        p3.close
      ) / 2
  ) {
    names.push(
      'Morning Star'
    );
    bullishScore += 3;
  }

  /*
  Evening Star
  */
  if (
    isBullish(p3) &&
    candleBody(previous) <
      candleRange(previous) *
        0.35 &&
    isBearish(last) &&
    last.close <
      (
        p3.open +
        p3.close
      ) / 2
  ) {
    names.push(
      'Evening Star'
    );
    bearishScore += 3;
  }

  let direction =
    'NEUTRAL';

  let strength = 0;

  if (
    bullishScore >
      bearishScore
  ) {
    direction =
      'BULLISH';

    strength =
      bullishScore;
  } else if (
    bearishScore >
      bullishScore
  ) {
    direction =
      'BEARISH';

    strength =
      bearishScore;
  }

  let text =
    'No strong named candlestick pattern was detected.';

  if (names.length) {
    text =
      names.join(', ');
  }

  return {
    direction,
    strength,
    names,
    text
  };
}

/* =========================================================
   MARKET PSYCHOLOGY
========================================================= */

function analyzeMarketPsychology(
  candles
) {
  const recent =
    candles.slice(-10);

  if (!recent.length) {
    return {
      sentiment: 'NEUTRAL',
      buyerPressure: 50,
      sellerPressure: 50,
      conviction: 0,
      rejection: 'NONE',
      indecision: 0,
      score: 0,
      recentCandles: 0,
      bullishCandles: 0,
      bearishCandles: 0,
      description:
        'No sufficient price-action data.'
    };
  }

  let bullish = 0;
  let bearish = 0;

  let convictionTotal = 0;

  let lowerReject = 0;
  let upperReject = 0;

  let indecision = 0;

  for (const candle of recent) {
    if (isBullish(candle)) {
      bullish++;
    }

    if (isBearish(candle)) {
      bearish++;
    }

    const range =
      candleRange(candle);

    const body =
      candleBody(candle);

    const bodyRatio =
      body / range;

    convictionTotal +=
      bodyRatio * 100;

    if (
      lowerWick(candle) >
      body * 1.5
    ) {
      lowerReject++;
    }

    if (
      upperWick(candle) >
      body * 1.5
    ) {
      upperReject++;
    }

    if (
      bodyRatio < 0.20
    ) {
      indecision++;
    }
  }

  const total =
    recent.length;

  const buyerPressure =
    Math.round(
      (bullish / total) *
        100
    );

  const sellerPressure =
    Math.round(
      (bearish / total) *
        100
    );

  const conviction =
    Math.round(
      convictionTotal / total
    );

  let sentiment =
    'BALANCED';

  if (
    sellerPressure >
      buyerPressure + 10
  ) {
    sentiment =
      'SELLER DOMINANCE';
  } else if (
    buyerPressure >
      sellerPressure + 10
  ) {
    sentiment =
      'BUYER DOMINANCE';
  }

  let rejection =
    'NONE';

  if (
    lowerReject >
      upperReject
  ) {
    rejection =
      'LOWER-PRICE REJECTION';
  } else if (
    upperReject >
      lowerReject
  ) {
    rejection =
      'UPPER-PRICE REJECTION';
  }

  let score = 0;

  if (
    sentiment ===
    'BUYER DOMINANCE'
  ) {
    score +=
      Math.min(
        10,
        Math.round(
          (
            buyerPressure -
            sellerPressure
          ) / 2
        )
      );
  }

  if (
    sentiment ===
    'SELLER DOMINANCE'
  ) {
    score +=
      Math.min(
        10,
        Math.round(
          (
            sellerPressure -
            buyerPressure
          ) / 2
        )
      );
  }

  return {
    sentiment,
    buyerPressure,
    sellerPressure,
    conviction,
    rejection,
    indecision,
    score,
    recentCandles: total,
    bullishCandles: bullish,
    bearishCandles: bearish,
    description:
      `Recent candles show ${
        sentiment === 'SELLER DOMINANCE'
          ? 'stronger seller pressure'
          : sentiment === 'BUYER DOMINANCE'
            ? 'stronger buyer pressure'
            : 'balanced buyer and seller pressure'
      } (${sellerPressure}% sellers / ${buyerPressure}% buyers) with ${conviction}% directional conviction. ${
        rejection !== 'NONE'
          ? `Price action also shows ${rejection.toLowerCase()}.`
          : ''
      }`
  };
}

/* =========================================================
   ENTRY / EXPIRY TIME
========================================================= */

function calculateEntryTime(
  timeframe
) {
  const now =
    new Date();

  const intervalMs =
    timeframe *
    60000;

  const currentMs =
    now.getTime();

  const nextBoundary =
    Math.ceil(
      currentMs /
        intervalMs
    ) * intervalMs;

  let entryMs =
    nextBoundary;

  let seconds =
    Math.floor(
      (
        entryMs -
        currentMs
      ) / 1000
    );

  /*
  Always guarantee the configured
  entry buffer.
  */
  if (
    seconds <
    ENTRY_BUFFER_SECONDS
  ) {
    entryMs +=
      intervalMs;

    seconds =
      Math.floor(
        (
          entryMs -
          currentMs
        ) / 1000
      );
  }

  return {
    entryTime:
      new Date(
        entryMs
      ).toISOString(),

    expiryTime:
      new Date(
        entryMs +
          intervalMs
      ).toISOString(),

    entryInSeconds:
      seconds
  };
}

/* =========================================================
   ANALYSIS
========================================================= */

function calculateMarketAnalysis(
  candles,
  timeframe,
  pair,
  metadata = {}
) {
  const aggregated =
    aggregateCandles(
      candles,
      timeframe
    );

  /*
  V8.6.1:
  We don't reject just because a single raw candle
  created an incomplete final aggregation bucket.
  We only require the number of complete candles
  needed by the indicators.
  */
  if (
    aggregated.length <
    MIN_CANDLES
  ) {
    throw new Error(
      `${pair} ${timeframe}m: insufficient aggregated candles (${aggregated.length}/${MIN_CANDLES}).`
    );
  }

  const closes =
    aggregated.map(
      c => c.close
    );

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const rsi14 =
    rsi(closes, 14);

  const adx14 =
    adx(
      aggregated,
      14
    );

  const atr14 =
    atr(
      aggregated,
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
      aggregated,
      30
    );

  const macdValue =
    macd(closes);

  const stochasticValue =
    stochastic(
      aggregated,
      14,
      3,
      3
    );

  const cci20 =
    cci(
      aggregated,
      20
    );

  const patternSummary =
    detectCandlestickPatterns(
      aggregated
    );

  const psychology =
    analyzeMarketPsychology(
      aggregated
    );

  const momentumValue =
    momentum(
      closes,
      5
    );

  const currentPrice =
    closes[
      closes.length - 1
    ];

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  /* -------------------------------------------------------
     EMA
  ------------------------------------------------------- */

  if (
    ema9 !== null &&
    ema21 !== null
  ) {
    if (
      ema9 > ema21
    ) {
      callScore += 15;

      reasons.push(
        'EMA9 is above EMA21, supporting bullish direction.'
      );
    } else if (
      ema9 < ema21
    ) {
      putScore += 15;

      reasons.push(
        'EMA9 is below EMA21, supporting bearish direction.'
      );
    }
  }

  /* -------------------------------------------------------
     RSI
  ------------------------------------------------------- */

  if (rsi14 !== null) {
    if (rsi14 >= 50) {
      callScore += 10;

      reasons.push(
        `RSI14 ${rsi14.toFixed(1)} supports bullish momentum.`
      );
    } else {
      putScore += 10;

      reasons.push(
        `RSI14 ${rsi14.toFixed(1)} supports bearish momentum.`
      );
    }
  }

  /* -------------------------------------------------------
     Momentum
  ------------------------------------------------------- */

  if (
    momentumValue !== null
  ) {
    if (
      momentumValue > 0
    ) {
      callScore += 10;

      reasons.push(
        'Recent price momentum is positive.'
      );
    } else if (
      momentumValue < 0
    ) {
      putScore += 10;

      reasons.push(
        'Recent price momentum is negative.'
      );
    }
  }

  /* -------------------------------------------------------
     ADX
  ------------------------------------------------------- */

  if (
    adx14 !== null
  ) {
    if (
      adx14 >= 20
    ) {
      if (
        ema9 !== null &&
        ema21 !== null
      ) {
        if (
          ema9 >
          ema21
        ) {
          callScore += 10;
        } else {
          putScore += 10;
        }
      }

      reasons.push(
        `ADX14 ${adx14.toFixed(1)} supports trend strength.`
      );
    }
  }

  /* -------------------------------------------------------
     SUPPORT / RESISTANCE
  ------------------------------------------------------- */

  if (
    sr.support !== null &&
    sr.resistance !== null
  ) {
    const distanceSupport =
      currentPrice -
      sr.support;

    const distanceResistance =
      sr.resistance -
      currentPrice;

    if (
      distanceSupport >
      distanceResistance
    ) {
      putScore += 5;

      reasons.push(
        'Price structure leaves room above recent support.'
      );
    } else {
      callScore += 5;

      reasons.push(
        'Price structure leaves room below recent resistance.'
      );
    }
  }

  /* -------------------------------------------------------
     MARKET CONDITION
  ------------------------------------------------------- */

  let marketCondition =
    'NORMAL';

  if (
    bb &&
    atr14 !== null
  ) {
    const width =
      bb.upper -
      bb.lower;

    const relativeWidth =
      currentPrice !== 0
        ? width /
          currentPrice
        : 0;

    if (
      relativeWidth <
      0.001
    ) {
      marketCondition =
        'LOW_VOLATILITY_RANGE';
    } else if (
      adx14 !== null &&
      adx14 >= 25
    ) {
      marketCondition =
        ema9 > ema21
          ? 'UPTREND'
          : 'DOWNTREND';
    } else {
      marketCondition =
        'RANGING';
    }
  }

  /* -------------------------------------------------------
     MACD
  ------------------------------------------------------- */

  if (macdValue) {
    if (
      macdValue.histogram >
      0
    ) {
      callScore += 10;

      reasons.push(
        'MACD is bullish with positive histogram confirmation.'
      );
    } else if (
      macdValue.histogram <
      0
    ) {
      putScore += 10;

      reasons.push(
        'MACD is bearish with negative histogram confirmation.'
      );
    }
  }

  /* -------------------------------------------------------
     STOCHASTIC
  ------------------------------------------------------- */

  if (
    stochasticValue
  ) {
    const k =
      stochasticValue.k;

    const d =
      stochasticValue.d;

    if (
      k > d &&
      k >= 50 &&
      k <= 85
    ) {
      callScore += 10;

      reasons.push(
        `Stochastic ${k.toFixed(1)}/${d.toFixed(1)} supports bullish momentum.`
      );
    } else if (
      k < d &&
      k >= 15 &&
      k <= 50
    ) {
      putScore += 10;

      reasons.push(
        `Stochastic ${k.toFixed(1)}/${d.toFixed(1)} supports bearish momentum.`
      );
    } else if (
      k < 20 &&
      k > d
    ) {
      callScore += 7;

      reasons.push(
        `Stochastic is recovering from oversold (${k.toFixed(1)}), supporting CALL reversal.`
      );
    } else if (
      k > 80 &&
      k < d
    ) {
      putScore += 7;

      reasons.push(
        `Stochastic is turning down from overbought (${k.toFixed(1)}), supporting PUT reversal.`
      );
    }
  }

  /* -------------------------------------------------------
     CCI20
  ------------------------------------------------------- */

  if (
    cci20 !== null
  ) {
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
      cci20 >= 0
    ) {
      callScore += 5;

      reasons.push(
        `CCI20 ${cci20.toFixed(1)} is positive.`
      );
    } else {
      putScore += 5;

      reasons.push(
        `CCI20 ${cci20.toFixed(1)} is negative.`
      );
    }
  }

  /* -------------------------------------------------------
     CANDLESTICK PATTERN
  ------------------------------------------------------- */

  if (
    patternSummary.direction ===
    'BULLISH'
  ) {
    callScore +=
      Math.min(
        10,
        patternSummary.strength
      );

    reasons.push(
      `Candlestick pattern confirmation: ${patternSummary.names.join(', ')}.`
    );
  } else if (
    patternSummary.direction ===
    'BEARISH'
  ) {
    putScore +=
      Math.min(
        10,
        patternSummary.strength
      );

    reasons.push(
      `Candlestick pattern confirmation: ${patternSummary.names.join(', ')}.`
    );
  } else {
    reasons.push(
      'Candlestick patterns do not provide strong directional confirmation.'
    );
  }

  /* -------------------------------------------------------
     MARKET PSYCHOLOGY
  ------------------------------------------------------- */

  let psychologyScore = 0;

  if (
    psychology.sentiment ===
    'BUYER DOMINANCE'
  ) {
    callScore +=
      psychology.score;

    psychologyScore =
      psychology.score;

    reasons.push(
      `Price-action psychology shows buyer pressure at ${psychology.buyerPressure}%.`
    );
  } else if (
    psychology.sentiment ===
    'SELLER DOMINANCE'
  ) {
    putScore +=
      psychology.score;

    psychologyScore =
      psychology.score;

    reasons.push(
      `Price-action psychology shows seller pressure at ${psychology.sellerPressure}%.`
    );
  }

  const patternScore =
    patternSummary.direction ===
      'BULLISH'
      ? patternSummary.strength
      : patternSummary.direction ===
        'BEARISH'
        ? patternSummary.strength
        : 0;

  const confirmation = {
    pattern: patternScore,
    psychology: psychologyScore,
    total:
      patternScore +
      psychologyScore
  };

  /* -------------------------------------------------------
     SIGNAL DECISION
  ------------------------------------------------------- */

  const strongest =
    Math.max(
      callScore,
      putScore
    );

  const weakest =
    Math.min(
      callScore,
      putScore
    );

  const difference =
    strongest -
    weakest;

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
    signal === 'CALL' ||
    signal === 'PUT'
  ) {
    confidence =
      clamp(
        Math.round(
          70 +
          (
            strongest -
            65
          ) *
            0.714
        ),
        70,
        95
      );
  } else {
    confidence =
      clamp(
        Math.round(
          40 +
          strongest * 0.45
        ),
        40,
        69
      );
  }

  const timing =
    calculateEntryTime(
      timeframe
    );

  return {
    pair,
    timeframe,
    signal,
    confidence,

    currentPrice:
      roundPrice(
        currentPrice
      ),

    entryTime:
      timing.entryTime,

    expiryTime:
      timing.expiryTime,

    entryInSeconds:
      timing.entryInSeconds,

    lastCandle:
      new Date(
        aggregated[
          aggregated.length - 1
        ].time
      ).toISOString(),

    marketCondition,

    callScore,
    putScore,

    indicators: {
      ema9:
        roundPrice(ema9),

      ema21:
        roundPrice(ema21),

      rsi14:
        rsi14 === null
          ? null
          : Number(
              rsi14.toFixed(2)
            ),

      adx14:
        adx14 === null
          ? null
          : Number(
              adx14.toFixed(2)
            ),

      atr14:
        roundPrice(atr14),

      support:
        roundPrice(
          sr.support
        ),

      resistance:
        roundPrice(
          sr.resistance
        ),

      bollinger: bb
        ? {
            upper:
              roundPrice(
                bb.upper
              ),
            middle:
              roundPrice(
                bb.middle
              ),
            lower:
              roundPrice(
                bb.lower
              )
          }
        : null,

      macd:
        macdValue
          ? {
              line:
                Number(
                  macdValue.line.toFixed(5)
                ),
              signal:
                Number(
                  macdValue.signal.toFixed(5)
                ),
              histogram:
                Number(
                  macdValue.histogram.toFixed(5)
                )
            }
          : null,

      stochastic:
        stochasticValue
          ? {
              k:
                Number(
                  stochasticValue.k.toFixed(2)
                ),
              d:
                Number(
                  stochasticValue.d.toFixed(2)
                )
            }
          : null,

      cci20:
        cci20 === null
          ? null
          : Number(
              cci20.toFixed(2)
            )
    },

    candlestickPatterns:
      patternSummary.names,

    patternSummary,

    patternScore,

    marketPsychology:
      psychology,

    psychologyScore,

    confirmation,

    candles:
      aggregated.length,

    source:
      'Twelve Data LIVE',

    timezone:
      TIMEZONE,

    analysisTime:
      new Date().toISOString(),

    reasons
  };
}

/* =========================================================
   SIGNAL TRACKING
========================================================= */

let signalSequence = 0;

function makeSignalId() {
  signalSequence += 1;

  return (
    `PO861-${Date.now()}-${signalSequence}`
  );
}

function signalKey(
  result
) {
  return [
    result.pair,
    result.timeframe,
    Date.parse(
      result.entryTime
    ),
    result.signal
  ].join(':');
}

function findSignalByKey(key) {
  const id =
    signalKeyRegistry.get(key);

  if (!id) {
    return null;
  }

  return (
    signalRegistry.get(id) ||
    null
  );
}

function addSignalTracking(
  result
) {
  if (
    result.signal !== 'CALL' &&
    result.signal !== 'PUT'
  ) {
    return result;
  }

  const key =
    signalKey(result);

  const existing =
    findSignalByKey(key);

  if (existing) {
    result.signalId =
      existing.signalId;

    result.resultStatus =
      existing.result;

    result.entryPrice =
      existing.entryPrice;

    result.exitPrice =
      existing.exitPrice;

    result.settledAt =
      existing.settledAt;

    return result;
  }

  const record = {
    signalId:
      makeSignalId(),

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
    record.signalId,
    record
  );

  signalKeyRegistry.set(
    key,
    record.signalId
  );

  signalHistory.unshift(
    record
  );

  while (
    signalHistory.length >
    SIGNAL_HISTORY_LIMIT
  ) {
    const removed =
      signalHistory.pop();

    if (removed) {
      signalRegistry.delete(
        removed.signalId
      );

      signalKeyRegistry.delete(
        removed.key
      );
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
   FIND CANDLE BY TIME
========================================================= */

function findCandleAtOrAfter(
  candles,
  timestamp
) {
  for (const candle of candles) {
    if (
      candle.time >= timestamp
    ) {
      return candle;
    }
  }

  return null;
}

function findCandleAtOrBefore(
  candles,
  timestamp
) {
  let selected = null;

  for (const candle of candles) {
    if (
      candle.time <= timestamp
    ) {
      selected = candle;
    } else {
      break;
    }
  }

  return selected;
}

/* =========================================================
   SETTLE ONE SIGNAL
========================================================= */

function isReadyForSettlement(
  record
) {
  const expiry =
    parseTimestamp(
      record.expiryTime
    );

  if (!expiry) {
    return false;
  }

  const grace =
    SETTLEMENT_GRACE_SECONDS *
    1000;

  return (
    nowMs() >=
    expiry + grace
  );
}

async function settleSignal(
  record
) {
  if (
    record.result !==
    'PENDING'
  ) {
    return record;
  }

  if (
    !isReadyForSettlement(
      record
    )
  ) {
    return record;
  }

  /*
  One fresh provider request gives us
  enough 1m candles to settle multiple
  signals for this pair.
  */
  let live;

  try {
    live =
      await getPairCandles(
        record.pair,
        {
          forceFresh: true,
          allowStale: false
        }
      );
  } catch (error) {
    /*
    If quota is temporarily exhausted,
    keep signal PENDING.

    It will be retried by the next
    settlement cycle.
    */
    return record;
  }

  const raw =
    live.candles;

  const timeframe =
    record.timeframe;

  const aggregated =
    aggregateCandles(
      raw,
      timeframe
    );

  if (
    aggregated.length <
    2
  ) {
    return record;
  }

  const entryTimestamp =
    parseTimestamp(
      record.entryTime
    );

  const expiryTimestamp =
    parseTimestamp(
      record.expiryTime
    );

  if (
    !entryTimestamp ||
    !expiryTimestamp
  ) {
    return record;
  }

  /*
  Exact candle first.
  If provider timestamp alignment differs slightly,
  use the nearest candle at/after the requested time.
  */
  let entryCandle =
    findCandleAtOrAfter(
      aggregated,
      entryTimestamp
    );

  let expiryCandle =
    findCandleAtOrAfter(
      aggregated,
      expiryTimestamp
    );

  /*
  If exact future candle is not yet present,
  do not guess.
  */
  if (
    !entryCandle ||
    !expiryCandle
  ) {
    return record;
  }

  /*
  Ensure expiry candle is actually at or after expiry.
  */
  if (
    expiryCandle.time <
    expiryTimestamp
  ) {
    return record;
  }

  const entryPrice =
    entryCandle.open;

  const exitPrice =
    expiryCandle.close;

  if (
    !Number.isFinite(
      entryPrice
    ) ||
    !Number.isFinite(
      exitPrice
    )
  ) {
    return record;
  }

  let outcome =
    'DRAW';

  if (
    record.signal ===
    'CALL'
  ) {
    if (
      exitPrice >
      entryPrice
    ) {
      outcome =
        'WIN';
    } else if (
      exitPrice <
      entryPrice
    ) {
      outcome =
        'LOSS';
    }
  } else if (
    record.signal ===
    'PUT'
  ) {
    if (
      exitPrice <
      entryPrice
    ) {
      outcome =
        'WIN';
    } else if (
      exitPrice >
      entryPrice
    ) {
      outcome =
        'LOSS';
    }
  }

  record.entryPrice =
    roundPrice(
      entryPrice
    );

  record.exitPrice =
    roundPrice(
      exitPrice
    );

  record.result =
    outcome;

  record.settledAt =
    new Date().toISOString();

  record.settlementSource =
    'Twelve Data LIVE candle';

  /*
  Update the corresponding cached analysis.
  */
  const cached =
    resultCache.get(
      `${record.pair}:${record.timeframe}`
    );

  if (cached) {
    const updated =
      {
        ...cached.result,
        resultStatus:
          outcome,
        entryPrice:
          record.entryPrice,
        exitPrice:
          record.exitPrice,
        settledAt:
          record.settledAt
      };

    resultCache.set(
      `${record.pair}:${record.timeframe}`,
      {
        result:
          updated,
        createdAt:
          cached.createdAt
      }
    );
  }

  return record;
}

/* =========================================================
   SETTLEMENT ENGINE
========================================================= */

async function settlePendingSignals() {
  const pending =
    signalHistory.filter(
      signal =>
        signal.result ===
          'PENDING' &&
        isReadyForSettlement(
          signal
        )
    );

  if (!pending.length) {
    return;
  }

  /*
  Group by pair so that one fresh
  API request can settle multiple
  timeframes/signals for the same pair.
  */
  const groups =
    new Map();

  for (const signal of pending) {
    if (!groups.has(signal.pair)) {
      groups.set(
        signal.pair,
        []
      );
    }

    groups
      .get(signal.pair)
      .push(signal);
  }

  for (const [
    pair,
    signals
  ] of groups.entries()) {
    if (
      !canMakeProviderRequest()
    ) {
      break;
    }

    let live;

    try {
      live =
        await getPairCandles(
          pair,
          {
            forceFresh: true,
            allowStale: false
          }
        );
    } catch (error) {
      /*
      Do not kill the settlement loop.
      */
      continue;
    }

    for (const signal of signals) {
      if (
        signal.result !==
        'PENDING'
      ) {
        continue;
      }

      await settleSignalFromCandles(
        signal,
        live.candles
      );
    }
  }
}

async function settleSignalFromCandles(
  record,
  rawCandles
) {
  const aggregated =
    aggregateCandles(
      rawCandles,
      record.timeframe
    );

  if (
    aggregated.length <
    2
  ) {
    return;
  }

  const entryTimestamp =
    parseTimestamp(
      record.entryTime
    );

  const expiryTimestamp =
    parseTimestamp(
      record.expiryTime
    );

  if (
    !entryTimestamp ||
    !expiryTimestamp
  ) {
    return;
  }

  const entryCandle =
    findCandleAtOrAfter(
      aggregated,
      entryTimestamp
    );

  const expiryCandle =
    findCandleAtOrAfter(
      aggregated,
      expiryTimestamp
    );

  if (
    !entryCandle ||
    !expiryCandle
  ) {
    return;
  }

  /*
  Never settle using an expiry candle
  that hasn't actually occurred yet.
  */
  if (
    expiryCandle.time >
    nowMs()
  ) {
    return;
  }

  const entryPrice =
    entryCandle.open;

  const exitPrice =
    expiryCandle.close;

  if (
    !Number.isFinite(
      entryPrice
    ) ||
    !Number.isFinite(
      exitPrice
    )
  ) {
    return;
  }

  let outcome =
    'DRAW';

  if (
    record.signal ===
    'CALL'
  ) {
    if (
      exitPrice >
      entryPrice
    ) {
      outcome =
        'WIN';
    } else if (
      exitPrice <
      entryPrice
    ) {
      outcome =
        'LOSS';
    }
  }

  if (
    record.signal ===
    'PUT'
  ) {
    if (
      exitPrice <
      entryPrice
    ) {
      outcome =
        'WIN';
    } else if (
      exitPrice >
      entryPrice
    ) {
      outcome =
        'LOSS';
    }
  }

  record.entryPrice =
    roundPrice(
      entryPrice
    );

  record.exitPrice =
    roundPrice(
      exitPrice
    );

  record.result =
    outcome;

  record.settledAt =
    new Date().toISOString();

  record.settlementSource =
    'Twelve Data LIVE candle';

  updateCachedResultFromSignal(
    record
  );
}

function updateCachedResultFromSignal(
  record
) {
  const keys = [
    `${record.pair}:${record.timeframe}`
  ];

  for (const key of keys) {
    const cached =
      resultCache.get(key);

    if (!cached) {
      continue;
    }

    cached.result = {
      ...cached.result,

      resultStatus:
        record.result,

      entryPrice:
        record.entryPrice,

      exitPrice:
        record.exitPrice,

      settledAt:
        record.settledAt
    };

    resultCache.set(
      key,
      cached
    );
  }
}

async function settlementLoop() {
  try {
    await settlePendingSignals();
  } catch (error) {
    /*
    Settlement errors must never
    crash the server.
    */
    console.error(
      '[SETTLEMENT]',
      error.message
    );
  }
}

/* =========================================================
   PERFORMANCE
========================================================= */

function getPerformance() {
  const total =
    signalHistory.length;

  let pending = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;

  for (const signal of signalHistory) {
    if (
      signal.result ===
      'PENDING'
    ) {
      pending++;
    } else if (
      signal.result ===
      'WIN'
    ) {
      wins++;
    } else if (
      signal.result ===
      'LOSS'
    ) {
      losses++;
    } else if (
      signal.result ===
      'DRAW'
    ) {
      draws++;
    }
  }

  const settled =
    wins +
    losses +
    draws;

  const decisive =
    wins +
    losses;

  const winRate =
    decisive > 0
      ? Number(
          (
            wins /
            decisive *
            100
          ).toFixed(2)
        )
      : null;

  const winRateIncludingDraws =
    settled > 0
      ? Number(
          (
            wins /
            settled *
            100
          ).toFixed(2)
        )
      : null;

  return {
    total,
    pending,
    wins,
    losses,
    draws,
    settled,
    decisive,
    winRate,
    winRateIncludingDraws
  };
}

/* =========================================================
   RESULT CACHE
========================================================= */

function setResultCache(
  result
) {
  resultCache.set(
    `${result.pair}:${result.timeframe}`,
    {
      result,
      createdAt: nowMs()
    }
  );
}

function getFreshResult(
  pair,
  timeframe
) {
  const cached =
    resultCache.get(
      `${pair}:${timeframe}`
    );

  if (!cached) {
    return null;
  }

  if (
    nowMs() -
      cached.createdAt >
    RESULT_TTL_MS
  ) {
    return null;
  }

  return cached.result;
}

/* =========================================================
   ANALYZE PAIR / TIMEFRAME
========================================================= */

async function analyzePairTimeframe(
  pair,
  timeframe,
  options = {}
) {
  const data =
    await getPairCandles(
      pair,
      {
        forceFresh:
          options.forceFresh === true,
        allowStale:
          options.allowStale !== false
      }
    );

  const candles =
    data.candles;

  if (
    candles.length <
    MIN_CANDLES
  ) {
    throw new Error(
      `${pair}: insufficient raw candles (${candles.length}/${MIN_CANDLES}).`
    );
  }

  const latestAge =
    getLatestCandleAgeSeconds(
      candles
    );

  /*
  Do not manufacture a "fresh" signal
  from old market data.

  Stale data can still be returned
  through direct analysis if explicitly
  requested, but scanner selection avoids it.
  */
  const analysis =
    calculateMarketAnalysis(
      candles,
      timeframe,
      pair,
      data
    );

  analysis.dataCached =
    data.cached;

  analysis.dataStale =
    data.stale;

  analysis.cacheAgeSeconds =
    Math.max(
      0,
      Math.floor(
        (
          nowMs() -
          data.fetchedAt
        ) / 1000
      )
    );

  analysis.latestCandleAgeSeconds =
    latestAge;

  /*
  For live scanner results,
  freshness matters.
  */
  if (
    options.requireFresh !== false &&
    (
      data.stale ||
      latestAge >
        MAX_DATA_AGE_SECONDS
    )
  ) {
    throw new Error(
      `${pair} ${timeframe}m: live candle data is too old (${latestAge}s).`
    );
  }

  addSignalTracking(
    analysis
  );

  setResultCache(
    analysis
  );

  return analysis;
}

/* =========================================================
   SCAN
========================================================= */

async function scanBatch() {
  if (scanRunning) {
    return {
      ok: false,
      message:
        'Scan already running.'
    };
  }

  scanRunning = true;
  lastScanError = null;

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  try {
    const startCursor =
      scanCursor;

    const available =
      getRemainingMinuteBudget();

    const batchSize =
      Math.min(
        SCAN_BATCH_SIZE,
        available
      );

    if (
      batchSize <= 0
    ) {
      return {
        ok: true,
        skipped: true,
        reason:
          'Provider minute budget exhausted.',
        scanCursor
      };
    }

    for (
      let i = 0;
      i < batchSize;
      i++
    ) {
      if (
        !canMakeProviderRequest()
      ) {
        break;
      }

      const pairIndex =
        (
          startCursor +
          i
        ) % PAIRS.length;

      const pair =
        PAIRS[pairIndex];

      attempted++;

      try {
        /*
        One Twelve Data request gives
        1m candles. We derive 2m and 3m
        locally.
        */
        const data =
          await getPairCandles(
            pair,
            {
              forceFresh: true,
              allowStale: false
            }
          );

        for (
          const timeframe
          of TIMEFRAMES
        ) {
          try {
            const result =
              calculateMarketAnalysis(
                data.candles,
                timeframe,
                pair,
                data
              );

            result.dataCached =
              data.cached;

            result.dataStale =
              data.stale;

            result.cacheAgeSeconds =
              0;

            result.latestCandleAgeSeconds =
              getLatestCandleAgeSeconds(
                data.candles
              );

            /*
            Scanner must not create a live
            signal from old candles.
            */
            if (
              result.dataStale ||
              result.latestCandleAgeSeconds >
                MAX_DATA_AGE_SECONDS
            ) {
              continue;
            }

            addSignalTracking(
              result
            );

            setResultCache(
              result
            );
          } catch (timeframeError) {
            /*
            One timeframe failing must not
            destroy the pair's other timeframes.
            */
            lastScanError =
              `${pair}: ${timeframeError.message}`;
          }
        }

        succeeded++;
        totalScanned++;
      } catch (error) {
        failed++;
        totalFailed++;

        lastScanError =
          `${pair}: ${error.message}`;

        console.error(
          '[SCAN]',
          lastScanError
        );
      }

      /*
      Very small delay helps avoid
      accidental burst behavior.
      */
      await sleep(100);
    }

    /*
    Advance only by attempted pairs.
    Unattempted pairs are NOT skipped
    when quota is exhausted.
    */
    scanCursor =
      (
        startCursor +
        attempted
      ) % PAIRS.length;

    lastScanAt =
      new Date().toISOString();

    return {
      ok: true,
      attempted,
      succeeded,
      failed,
      scanCursor,
      remainingMinuteBudget:
        getRemainingMinuteBudget()
    };
  } finally {
    scanRunning = false;
  }
}

/* =========================================================
   BEST RESULT
========================================================= */

function collectFreshCachedResults() {
  const results = [];

  for (const [
    key,
    cached
  ] of resultCache.entries()) {
    if (
      nowMs() -
        cached.createdAt >
      RESULT_TTL_MS
    ) {
      continue;
    }

    const result =
      cached.result;

    if (
      result.dataStale
    ) {
      continue;
    }

    results.push(
      result
    );
  }

  return results;
}

function rankResults(results) {
  return results
    .map(result => {
      let rank = 0;

      if (
        result.signal ===
        'CALL' ||
        result.signal ===
        'PUT'
      ) {
        rank +=
          result.confidence;

        rank +=
          Math.abs(
            result.callScore -
            result.putScore
          ) * 0.5;
      }

      const adx =
        result.indicators &&
        result.indicators.adx14;

      if (
        adx !== null &&
        adx !== undefined
      ) {
        rank +=
          Math.min(
            8,
            adx / 4
          );
      }

      const stoch =
        result.indicators &&
        result.indicators.stochastic;

      if (
        stoch
      ) {
        if (
          result.signal ===
            'CALL' &&
          stoch.k >
            stoch.d
        ) {
          rank += 3;
        }

        if (
          result.signal ===
            'PUT' &&
          stoch.k <
            stoch.d
        ) {
          rank += 3;
        }
      }

      const cciValue =
        result.indicators &&
        result.indicators.cci20;

      if (
        cciValue !== null &&
        cciValue !== undefined
      ) {
        if (
          result.signal ===
            'CALL' &&
          cciValue > 0
        ) {
          rank += 3;
        }

        if (
          result.signal ===
            'PUT' &&
          cciValue < 0
        ) {
          rank += 3;
        }
      }

      if (
        result.confirmation &&
        result.confirmation.total
      ) {
        rank +=
          Math.min(
            10,
            result.confirmation.total
          );
      }

      return {
        ...result,
        _rank:
          rank
      };
    })
    .sort(
      (a, b) =>
        b._rank -
        a._rank
    );
}

function getBestResult() {
  const results =
    collectFreshCachedResults();

  const tradable =
    results.filter(
      result =>
        result.signal ===
          'CALL' ||
        result.signal ===
          'PUT'
    );

  const ranked =
    rankResults(
      tradable
    );

  return (
    ranked[0] ||
    null
  );
}

/* =========================================================
   SERIALIZE RESULT
========================================================= */

function publicResult(
  result
) {
  if (!result) {
    return null;
  }

  const copy = {
    ...result
  };

  delete copy._rank;

  return copy;
}

/* =========================================================
   API: ROOT
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
      source:
        'Twelve Data LIVE',
      endpoints: [
        '/api/health',
        '/api/scan/status',
        '/api/scan',
        '/api/best',
        '/api/selected',
        '/api/performance',
        '/api/history',
        '/api/analyze?pair=EUR/USD&timeframe=1'
      ]
    });
  }
);

/* =========================================================
   API: HEALTH
========================================================= */

app.get(
  '/api/health',
  (req, res) => {
    resetDailyCounterIfNeeded();
    cleanupProviderRequestTimes();

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

      providerQuotaResetAt:
        quotaBlockedUntil
          ? new Date(
              quotaBlockedUntil
            ).toISOString()
          : null,

      minuteBlocked:
        Boolean(
          minuteBlockedUntil &&
          nowMs() <
            minuteBlockedUntil
        ),

      minuteResetAt:
        minuteBlockedUntil
          ? new Date(
              minuteBlockedUntil
            ).toISOString()
          : null,

      minuteRetryInSeconds:
        minuteBlockedUntil
          ? Math.max(
              0,
              Math.ceil(
                (
                  minuteBlockedUntil -
                  nowMs()
                ) / 1000
              )
            )
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

      settlementIntervalSeconds:
        SETTLEMENT_INTERVAL_MS /
        1000,

      settlementGraceSeconds:
        SETTLEMENT_GRACE_SECONDS,

      indicators: {
        macd: true,
        stochastic: true,
        cci20: true,
        candlestickPatterns: true,
        marketPsychology: true
      },

      signalTracking: {
        historySize:
          signalHistory.length,

        performance:
          getPerformance()
      },

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   API: SCAN STATUS
========================================================= */

app.get(
  '/api/scan/status',
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      scanRunning,

      scanCursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      lastScanAt,

      lastScanError,

      totalScanned,

      totalFailed,

      totalApiRequests,

      minuteBudget: {
        limit:
          PROVIDER_MINUTE_LIMIT,

        used:
          providerRequestTimes.length,

        remaining:
          getRemainingMinuteBudget()
      },

      dailyBudget: {
        limit:
          MAX_DAILY_REQUESTS,

        used:
          dailyRequests,

        remaining:
          getRemainingRequestBudget()
      },

      signalTracking:
        getPerformance(),

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   API: MANUAL SCAN
========================================================= */

app.get(
  '/api/scan',
  async (req, res) => {
    try {
      const result =
        await scanBatch();

      res.json({
        ...result,

        version:
          VERSION,

        performance:
          getPerformance()
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   API: ANALYZE
========================================================= */

app.get(
  '/api/analyze',
  async (req, res) => {
    const pair =
      String(
        req.query.pair ||
        ''
      ).trim();

    const timeframe =
      Number(
        req.query.timeframe ||
        1
      );

    if (
      !PAIRS.includes(pair)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          `Unsupported pair: ${pair}`,
        supportedPairs:
          PAIRS
      });
    }

    if (
      !TIMEFRAMES.includes(
        timeframe
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          `Unsupported timeframe: ${timeframe}`,
        supportedTimeframes:
          TIMEFRAMES
      });
    }

    try {
      const result =
        await analyzePairTimeframe(
          pair,
          timeframe,
          {
            forceFresh: true,
            allowStale: false,
            requireFresh: true
          }
        );

      res.json({
        ok: true,

        analysis:
          publicResult(
            result
          ),

        performance:
          getPerformance(),

        source:
          'Twelve Data LIVE',

        time:
          new Date().toISOString()
      });
    } catch (error) {
      res.status(503).json({
        ok: false,

        error:
          error.message,

        performance:
          getPerformance(),

        time:
          new Date().toISOString()
      });
    }
  }
);

/* =========================================================
   API: BEST
========================================================= */

app.get(
  '/api/best',
  async (req, res) => {
    /*
    First settle anything already expired.
    It uses the local quota guard.
    */
    try {
      await settlePendingSignals();
    } catch (error) {
      console.error(
        '[BEST SETTLEMENT]',
        error.message
      );
    }

    let best =
      getBestResult();

    /*
    If there is no fresh result,
    attempt a scan.
    */
    if (!best) {
      try {
        await scanBatch();
      } catch (error) {
        lastScanError =
          error.message;
      }

      best =
        getBestResult();
    }

    if (!best) {
      return res.status(503).json({
        ok: false,

        error:
          'No fresh selected market is currently available.',

        performance:
          getPerformance(),

        scan: {
          running:
            scanRunning,

          cursor:
            scanCursor,

          lastScanAt,

          lastScanError
        },

        time:
          new Date().toISOString()
      });
    }

    res.json({
      ok: true,

      selectedMarket:
        publicResult(best),

      selected:
        publicResult(best),

      best:
        publicResult(best),

      scannedResults:
        collectFreshCachedResults()
          .length,

      performance:
        getPerformance(),

      source:
        'Twelve Data LIVE',

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   API: SELECTED
========================================================= */

app.get(
  '/api/selected',
  async (req, res) => {
    try {
      await settlePendingSignals();
    } catch (error) {
      console.error(
        '[SELECTED SETTLEMENT]',
        error.message
      );
    }

    const best =
      getBestResult();

    res.json({
      ok:
        Boolean(best),

      selectedMarket:
        publicResult(best),

      performance:
        getPerformance(),

      source:
        'Twelve Data LIVE',

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   API: PERFORMANCE
========================================================= */

app.get(
  '/api/performance',
  async (req, res) => {
    try {
      await settlePendingSignals();
    } catch (error) {
      console.error(
        '[PERFORMANCE SETTLEMENT]',
        error.message
      );
    }

    res.json({
      ok: true,

      version:
        VERSION,

      performance:
        getPerformance(),

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   API: HISTORY
========================================================= */

app.get(
  '/api/history',
  async (req, res) => {
    try {
      await settlePendingSignals();
    } catch (error) {
      console.error(
        '[HISTORY SETTLEMENT]',
        error.message
      );
    }

    let limit =
      Number(
        req.query.limit ||
        30
      );

    if (
      !Number.isFinite(limit)
    ) {
      limit = 30;
    }

    limit =
      clamp(
        Math.floor(limit),
        1,
        100
      );

    const signals =
      signalHistory
        .slice(
          0,
          limit
        )
        .map(
          signal => ({
            ...signal
          })
        );

    res.json({
      ok: true,

      version:
        VERSION,

      count:
        signals.length,

      performance:
        getPerformance(),

      signals,

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
        'Endpoint not found.',
      path:
        req.path,
      version:
        VERSION
    });
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      '[SERVER ERROR]',
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        error.message ||
        'Internal server error.',
      version:
        VERSION
    });
  }
);

/* =========================================================
   AUTOMATIC SCANNER
========================================================= */

async function automaticScan() {
  if (scanRunning) {
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
}

/* =========================================================
   AUTOMATIC SETTLEMENT START
========================================================= */

setInterval(
  () => {
    settlementLoop();
  },
  SETTLEMENT_INTERVAL_MS
);

/* =========================================================
   AUTOMATIC SCAN START
========================================================= */

setTimeout(
  () => {
    automaticScan();
  },
  10000
);

setInterval(
  () => {
    automaticScan();
  },
  SCAN_EVERY_MS
);

/* =========================================================
   SERVER START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      '==========================================================='
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
      `PAIRS: ${PAIRS.length}`
    );

    console.log(
      `TIMEFRAMES: ${TIMEFRAMES.join(', ')}`
    );

    console.log(
      `PROVIDER MINUTE LIMIT: ${PROVIDER_MINUTE_LIMIT}`
    );

    console.log(
      `SCAN BATCH SIZE: ${SCAN_BATCH_SIZE}`
    );

    console.log(
      `SCAN EVERY: ${SCAN_EVERY_MINUTES} minutes`
    );

    console.log(
      `SETTLEMENT LOOP: ${SETTLEMENT_INTERVAL_MS / 1000}s`
    );

    console.log(
      `API KEY CONFIGURED: ${Boolean(TWELVE_DATA_API_KEY)}`
    );

    console.log(
      '==========================================================='
    );
  }
);
