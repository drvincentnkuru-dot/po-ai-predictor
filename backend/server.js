'use strict';

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

/* =========================================================
   PO AI PREDICTOR
   V8.4.1 — QUOTA-SAFE + CACHE-SAFE
   Source: Twelve Data LIVE
   ========================================================= */

const VERSION = 'V8.4.1';
const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || '';

const TWELVE_DATA_URL =
  process.env.TWELVE_DATA_URL ||
  'https://api.twelvedata.com/time_series';

const TIMEZONE = 'UTC';

/*
  Supported live pairs.
  One Twelve Data 1-minute request gives us the candles
  needed to build 1m / 2m / 3m locally.
*/
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
  Scanner deliberately works in small batches.
  This prevents a single scan from spending the whole quota.
*/
const SCAN_BATCH_SIZE = Math.max(
  1,
  Number(process.env.SCAN_BATCH_SIZE || 8)
);

/*
  Do not scan every minute.
  15 minutes is the V8.4 architecture.
*/
const SCAN_EVERY_MS =
  Math.max(
    1,
    Number(process.env.SCAN_EVERY_MINUTES || 15)
  ) * 60 * 1000;

/*
  Successful pair data remains usable for this period.
  We never refetch a fresh pair while it is still valid.
*/
const CACHE_TTL_MS =
  Math.max(
    1,
    Number(process.env.CACHE_TTL_MINUTES || 15)
  ) * 60 * 1000;

/*
  Analysis results can be reused briefly by the frontend.
*/
const RESULT_TTL_MS =
  Math.max(
    1,
    Number(process.env.RESULT_TTL_SECONDS || 30)
  ) * 1000;

/*
  Safety limits.
  These are backend limits, not claims about the Twelve Data plan.
*/
const DAILY_REQUEST_LIMIT = Math.max(
  1,
  Number(process.env.DAILY_REQUEST_LIMIT || 768)
);

const SAFETY_RESERVE = Math.max(
  0,
  Number(process.env.SAFETY_RESERVE || 32)
);

const MAX_DAILY_REQUESTS = Math.max(
  1,
  DAILY_REQUEST_LIMIT - SAFETY_RESERVE
);

/*
  We intentionally stop requesting when the backend believes
  the daily safe budget has been reached.
*/
const ENTRY_BUFFER_SECONDS = 30;

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

let currentUtcDay = getUtcDayKey(new Date());

/* =========================================================
   HELPERS
   ========================================================= */

function getUtcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getNextUtcMidnight(date = new Date()) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

function resetDailyStateIfNeeded() {
  const nowDay = getUtcDayKey(new Date());

  if (nowDay !== currentUtcDay) {
    currentUtcDay = nowDay;

    dailyRequests = 0;
    dailyCreditsUsed = 0;

    /*
      We reset our local block at UTC midnight.
      The provider may still have a different restriction,
      so a provider quota error will immediately block again.
    */
    quotaBlocked = false;
    providerQuotaMessage = null;
    providerQuotaResetAt = null;

    console.log(
      `[QUOTA] New UTC day ${currentUtcDay}. Local counters reset.`
    );
  }
}

function getDailyCreditsLeft() {
  return Math.max(
    0,
    MAX_DAILY_REQUESTS - dailyCreditsUsed
  );
}

function getDailyRequestsLeft() {
  return Math.max(
    0,
    MAX_DAILY_REQUESTS - dailyRequests
  );
}

function isBudgetAvailable() {
  resetDailyStateIfNeeded();

  if (quotaBlocked) {
    return false;
  }

  if (dailyRequests >= MAX_DAILY_REQUESTS) {
    return false;
  }

  return true;
}

function normalizePair(pair) {
  if (!pair) return null;

  const value = String(pair).trim().toUpperCase();

  if (PAIRS.includes(value)) {
    return value;
  }

  return null;
}

function normalizeTimeframe(value) {
  const tf = Number(value);

  if (TIMEFRAMES.includes(tf)) {
    return tf;
  }

  return null;
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function round(value, decimals = 5) {
  if (!Number.isFinite(value)) return null;

  const factor = Math.pow(10, decimals);

  return Math.round(value * factor) / factor;
}

function priceDecimals(pair) {
  if (pair && pair.includes('JPY')) {
    return 3;
  }

  return 5;
}

/* =========================================================
   QUOTA MANAGEMENT
   ========================================================= */

function blockForProviderQuota(message) {
  quotaBlocked = true;

  providerQuotaMessage =
    message ||
    'Twelve Data quota is currently unavailable.';

  providerQuotaResetAt =
    getNextUtcMidnight(new Date()).toISOString();

  console.warn(
    `[QUOTA BLOCKED] ${providerQuotaMessage}`
  );
}

function providerErrorMessage(data, statusCode) {
  if (!data) {
    return `Twelve Data HTTP ${statusCode}`;
  }

  if (typeof data === 'string') {
    return data;
  }

  return (
    data.message ||
    data.error ||
    data.code ||
    `Twelve Data HTTP ${statusCode}`
  );
}

function looksLikeQuotaError(message, data) {
  const text = [
    message,
    data && data.message,
    data && data.error,
    data && data.status,
    data && data.code
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    text.includes('quota') ||
    text.includes('credit') ||
    text.includes('credits') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('api limit') ||
    text.includes('daily limit') ||
    text.includes('run out')
  );
}

/* =========================================================
   CACHE
   ========================================================= */

function getCachedPair(pair) {
  const cached = pairCache.get(pair);

  if (!cached) {
    return null;
  }

  if (
    Date.now() - cached.timestamp >
    CACHE_TTL_MS
  ) {
    return null;
  }

  return cached;
}

function setCachedPair(pair, candles) {
  pairCache.set(pair, {
    timestamp: Date.now(),
    candles
  });
}

function getCachedResult(key) {
  const cached = resultCache.get(key);

  if (!cached) {
    return null;
  }

  if (
    Date.now() - cached.timestamp >
    RESULT_TTL_MS
  ) {
    return null;
  }

  return cached.result;
}

function setCachedResult(key, result) {
  resultCache.set(key, {
    timestamp: Date.now(),
    result
  });
}

/* =========================================================
   TWELVE DATA
   ========================================================= */

async function fetchTwelveData(pair) {
  resetDailyStateIfNeeded();

  /*
    IMPORTANT:
    Never spend another API request while quotaBlocked.
  */
  if (quotaBlocked) {
    throw new Error(
      providerQuotaMessage ||
      'Twelve Data quota is blocked.'
    );
  }

  /*
    Backend safety budget.
  */
  if (!isBudgetAvailable()) {
    throw new Error(
      'Backend daily API safety budget reached.'
    );
  }

  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      'TWELVE_DATA_API_KEY is not configured.'
    );
  }

  const url = new URL(TWELVE_DATA_URL);

  url.searchParams.set('symbol', pair);
  url.searchParams.set('interval', '1min');
  url.searchParams.set(
    'outputsize',
    String(MAX_CANDLES)
  );
  url.searchParams.set('apikey', TWELVE_DATA_API_KEY);
  url.searchParams.set('timezone', TIMEZONE);

  totalApiRequests++;
  dailyRequests++;
  dailyCreditsUsed++;

  console.log(
    `[TWELVE DATA] ${pair} request #${dailyRequests}`
  );

  let response;

  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PO-AI-Predictor/8.4.1'
      }
    });
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
      `Twelve Data returned invalid JSON (HTTP ${response.status}).`
    );
  }

  const providerMessage =
    providerErrorMessage(
      data,
      response.status
    );

  /*
    Detect quota before doing anything else.
  */
  if (
    !response.ok ||
    data.status === 'error' ||
    data.code ||
    data.message
  ) {
    if (
      looksLikeQuotaError(
        providerMessage,
        data
      )
    ) {
      blockForProviderQuota(
        providerMessage
      );
    }

    throw new Error(providerMessage);
  }

  if (
    !Array.isArray(data.values) ||
    data.values.length === 0
  ) {
    throw new Error(
      `Twelve Data returned no candles for ${pair}.`
    );
  }

  const candles = data.values
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
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < MIN_CANDLES) {
    throw new Error(
      `${pair}: insufficient candle data (${candles.length}/${MIN_CANDLES}).`
    );
  }

  return candles;
}

async function getPairCandles(pair, options = {}) {
  const forceRefresh =
    options.forceRefresh === true;

  const cached = getCachedPair(pair);

  if (cached && !forceRefresh) {
    return {
      candles: cached.candles,
      source: 'CACHE',
      cachedAt: cached.timestamp
    };
  }

  /*
    If provider quota is blocked, NEVER attempt another call.
    Return cache if one exists, otherwise throw.
  */
  if (quotaBlocked) {
    if (cached) {
      return {
        candles: cached.candles,
        source: 'CACHE_STALE',
        cachedAt: cached.timestamp
      };
    }

    throw new Error(
      providerQuotaMessage ||
      'Twelve Data quota is blocked.'
    );
  }

  try {
    const candles =
      await fetchTwelveData(pair);

    setCachedPair(pair, candles);

    return {
      candles,
      source: 'LIVE',
      cachedAt: Date.now()
    };
  } catch (error) {
    /*
      If live request fails, use existing cache.
    */
    if (cached) {
      console.warn(
        `[CACHE FALLBACK] ${pair}: ${error.message}`
      );

      return {
        candles: cached.candles,
        source: 'CACHE_STALE',
        cachedAt: cached.timestamp,
        warning: error.message
      };
    }

    throw error;
  }
}

/* =========================================================
   CANDLE AGGREGATION
   ========================================================= */

function aggregateCandles(candles, timeframe) {
  if (timeframe === 1) {
    return candles.slice();
  }

  const result = [];
  const bucketMs =
    timeframe * 60 * 1000;

  let bucket = null;

  for (const candle of candles) {
    const bucketTime =
      Math.floor(candle.time / bucketMs) *
      bucketMs;

    if (!bucket || bucket.time !== bucketTime) {
      if (bucket) {
        result.push(bucket);
      }

      bucket = {
        time: bucketTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
        count: 1
      };
    } else {
      bucket.high = Math.max(
        bucket.high,
        candle.high
      );

      bucket.low = Math.min(
        bucket.low,
        candle.low
      );

      bucket.close = candle.close;

      if (Number.isFinite(candle.volume)) {
        bucket.volume += candle.volume;
      }

      bucket.count++;
    }
  }

  if (bucket) {
    result.push(bucket);
  }

  return result;
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

  let current = 0;

  for (let i = 0; i < period; i++) {
    current += values[i];
  }

  current /= period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    current =
      (values[i] - current) *
      multiplier +
      current;
  }

  return current;
}

function emaSeries(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return [];
  }

  const multiplier =
    2 / (period + 1);

  const series =
    new Array(values.length).fill(null);

  let current = 0;

  for (let i = 0; i < period; i++) {
    current += values[i];
  }

  current /= period;

  series[period - 1] = current;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    current =
      (values[i] - current) *
      multiplier +
      current;

    series[i] = current;
  }

  return series;
}

function rsi(values, period = 14) {
  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain =
    gains / period;

  let averageLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    const gain =
      change > 0 ? change : 0;

    const loss =
      change < 0 ? Math.abs(change) : 0;

    averageGain =
      ((averageGain * (period - 1)) +
        gain) /
      period;

    averageLoss =
      ((averageLoss * (period - 1)) +
        loss) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (
    !Array.isArray(candles) ||
    candles.length <= period
  ) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
    );

    trs.push(tr);
  }

  if (trs.length < period) {
    return null;
  }

  let value = 0;

  for (let i = 0; i < period; i++) {
    value += trs[i];
  }

  value /= period;

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    value =
      ((value * (period - 1)) +
        trs[i]) /
      period;
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
      current.high - previous.high;

    const downMove =
      previous.low - current.low;

    const tr = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
    );

    trs.push(tr);

    plusDM.push(
      upMove > downMove && upMove > 0
        ? upMove
        : 0
    );

    minusDM.push(
      downMove > upMove && downMove > 0
        ? downMove
        : 0
    );
  }

  if (trs.length < period) {
    return null;
  }

  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;

  for (let i = 0; i < period; i++) {
    trSum += trs[i];
    plusSum += plusDM[i];
    minusSum += minusDM[i];
  }

  const dx = [];

  function pushDx() {
    if (trSum <= 0) {
      dx.push(0);
      return;
    }

    const plusDI =
      100 * (plusSum / trSum);

    const minusDI =
      100 * (minusSum / trSum);

    const denominator =
      plusDI + minusDI;

    const value =
      denominator === 0
        ? 0
        : 100 *
          Math.abs(
            plusDI - minusDI
          ) /
          denominator;

    dx.push(value);
  }

  pushDx();

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    trSum =
      trSum -
      trSum / period +
      trs[i];

    plusSum =
      plusSum -
      plusSum / period +
      plusDM[i];

    minusSum =
      minusSum -
      minusSum / period +
      minusDM[i];

    pushDx();
  }

  if (dx.length < period) {
    return null;
  }

  let adxValue = 0;

  for (let i = 0; i < period; i++) {
    adxValue += dx[i];
  }

  adxValue /= period;

  for (
    let i = period;
    i < dx.length;
    i++
  ) {
    adxValue =
      ((adxValue * (period - 1)) +
        dx[i]) /
      period;
  }

  return adxValue;
}

function standardDeviation(values) {
  if (!values.length) {
    return null;
  }

  const mean =
    values.reduce(
      (sum, value) => sum + value,
      0
    ) / values.length;

  const variance =
    values.reduce(
      (sum, value) =>
        sum +
        Math.pow(value - mean, 2),
      0
    ) / values.length;

  return Math.sqrt(variance);
}

function bollinger(candles, period = 20) {
  if (candles.length < period) {
    return null;
  }

  const closes =
    candles
      .slice(-period)
      .map(c => c.close);

  const middle =
    closes.reduce(
      (a, b) => a + b,
      0
    ) / period;

  const sd =
    standardDeviation(closes);

  return {
    middle,
    upper: middle + 2 * sd,
    lower: middle - 2 * sd
  };
}

function supportResistance(candles) {
  if (candles.length < 20) {
    return {
      support: null,
      resistance: null
    };
  }

  const window =
    candles.slice(-50);

  let support = Infinity;
  let resistance = -Infinity;

  for (const candle of window) {
    support =
      Math.min(support, candle.low);

    resistance =
      Math.max(
        resistance,
        candle.high
      );
  }

  return {
    support:
      Number.isFinite(support)
        ? support
        : null,

    resistance:
      Number.isFinite(resistance)
        ? resistance
        : null
  };
}

/* =========================================================
   MARKET ANALYSIS
   ========================================================= */

function calculateMarketAnalysis(
  pair,
  timeframe,
  candles
) {
  const tfCandles =
    aggregateCandles(
      candles,
      timeframe
    );

  if (
    tfCandles.length <
    MIN_CANDLES
  ) {
    throw new Error(
      `${pair} ${timeframe}m: insufficient aggregated candles.`
    );
  }

  const closes =
    tfCandles.map(c => c.close);

  const current =
    tfCandles[tfCandles.length - 1];

  const currentPrice =
    current.close;

  const ema9Value =
    ema(closes, 9);

  const ema21Value =
    ema(closes, 21);

  const rsiValue =
    rsi(closes, 14);

  const adxValue =
    adx(tfCandles, 14);

  const atrValue =
    atr(tfCandles, 14);

  const bb =
    bollinger(tfCandles, 20);

  const sr =
    supportResistance(
      tfCandles
    );

  if (
    !Number.isFinite(ema9Value) ||
    !Number.isFinite(ema21Value) ||
    !Number.isFinite(rsiValue)
  ) {
    throw new Error(
      `${pair} ${timeframe}m: indicators unavailable.`
    );
  }

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  /* ---------------- EMA TREND ---------------- */

  if (ema9Value > ema21Value) {
    callScore += 30;
    reasons.push('EMA9 above EMA21');
  } else if (ema9Value < ema21Value) {
    putScore += 30;
    reasons.push('EMA9 below EMA21');
  }

  /* ---------------- RSI ---------------- */

  if (
    rsiValue >= 52 &&
    rsiValue <= 68
  ) {
    callScore += 20;
    reasons.push('RSI supports bullish momentum');
  } else if (
    rsiValue <= 48 &&
    rsiValue >= 32
  ) {
    putScore += 20;
    reasons.push('RSI supports bearish momentum');
  } else if (rsiValue > 70) {
    putScore += 8;
    reasons.push('RSI is overbought');
  } else if (rsiValue < 30) {
    callScore += 8;
    reasons.push('RSI is oversold');
  }

  /* ---------------- PRICE MOMENTUM ---------------- */

  const lookback =
    Math.min(5, closes.length - 1);

  const previousPrice =
    closes[
      closes.length - 1 - lookback
    ];

  const momentum =
    currentPrice - previousPrice;

  if (momentum > 0) {
    callScore += 20;
    reasons.push('Short-term momentum bullish');
  } else if (momentum < 0) {
    putScore += 20;
    reasons.push('Short-term momentum bearish');
  }

  /* ---------------- ADX ---------------- */

  if (
    Number.isFinite(adxValue) &&
    adxValue >= 20
  ) {
    if (ema9Value > ema21Value) {
      callScore += 15;
    } else {
      putScore += 15;
    }

    reasons.push(
      `ADX confirms trend (${round(adxValue, 1)})`
    );
  } else {
    reasons.push('ADX indicates weak trend');
  }

  /* ---------------- SUPPORT / RESISTANCE ---------------- */

  if (
    Number.isFinite(sr.support) &&
    Number.isFinite(sr.resistance)
  ) {
    const range =
      sr.resistance - sr.support;

    if (range > 0) {
      const position =
        (currentPrice - sr.support) /
        range;

      /*
        Avoid calling a CALL immediately into resistance
        or PUT immediately into support.
      */
      if (
        ema9Value > ema21Value &&
        position < 0.78
      ) {
        callScore += 10;
      }

      if (
        ema9Value < ema21Value &&
        position > 0.22
      ) {
        putScore += 10;
      }
    }
  }

  /* ---------------- BOLLINGER / VOLATILITY ---------------- */

  let marketCondition =
    'RANGING';

  if (bb && atrValue) {
    const width =
      bb.upper - bb.lower;

    const relativeWidth =
      currentPrice !== 0
        ? width / currentPrice
        : 0;

    if (
      relativeWidth < 0.0008
    ) {
      marketCondition =
        'LOW_VOLATILITY_RANGE';
    } else if (
      ema9Value > ema21Value
    ) {
      marketCondition =
        'UPTREND';
    } else if (
      ema9Value < ema21Value
    ) {
      marketCondition =
        'DOWNTREND';
    }
  }

  const strongest =
    Math.max(
      callScore,
      putScore
    );

  const difference =
    Math.abs(
      callScore - putScore
    );

  let signal = 'NO TRADE';

  /*
    V8.4.1 deliberately requires both:
      - enough directional score
      - enough separation between CALL and PUT
  */
  if (
    strongest >= 65 &&
    difference >= 15
  ) {
    signal =
      callScore > putScore
        ? 'CALL'
        : 'PUT';
  }

  let confidence = 40;

  if (signal === 'CALL') {
    confidence = Math.min(
      95,
      Math.round(
        50 +
        callScore * 0.45 +
        difference * 0.25
      )
    );
  } else if (signal === 'PUT') {
    confidence = Math.min(
      95,
      Math.round(
        50 +
        putScore * 0.45 +
        difference * 0.25
      )
    );
  } else {
    confidence = Math.min(
      69,
      Math.max(
        40,
        Math.round(
          40 +
          strongest * 0.30
        )
      )
    );
  }

  /*
    Entry is the next timeframe boundary.
    This keeps ENTRY and EXPIRY synchronized to UTC.
  */
  const now =
    new Date();

  const tfMs =
    timeframe *
    60 *
    1000;

  let entryTime =
    Math.ceil(
      now.getTime() / tfMs
    ) * tfMs;

  /*
    If the next boundary is less than 30 seconds away,
    use the following boundary.
  */
  if (
    entryTime -
      now.getTime() <
    ENTRY_BUFFER_SECONDS * 1000
  ) {
    entryTime += tfMs;
  }

  const expiryTime =
    entryTime + tfMs;

  const entryInSeconds =
    Math.max(
      0,
      Math.ceil(
        (entryTime -
          now.getTime()) /
          1000
      )
    );

  return {
    pair,
    timeframe,
    signal,
    confidence,

    currentPrice:
      round(
        currentPrice,
        priceDecimals(pair)
      ),

    entryTime:
      new Date(entryTime).toISOString(),

    expiryTime:
      new Date(expiryTime).toISOString(),

    entryInSeconds,

    marketCondition,

    callScore:
      Math.min(
        100,
        Math.round(callScore)
      ),

    putScore:
      Math.min(
        100,
        Math.round(putScore)
      ),

    indicators: {
      ema9:
        round(
          ema9Value,
          priceDecimals(pair)
        ),

      ema21:
        round(
          ema21Value,
          priceDecimals(pair)
        ),

      rsi14:
        round(rsiValue, 2),

      adx14:
        Number.isFinite(adxValue)
          ? round(adxValue, 2)
          : null,

      atr14:
        Number.isFinite(atrValue)
          ? round(
              atrValue,
              priceDecimals(pair)
            )
          : null,

      support:
        Number.isFinite(sr.support)
          ? round(
              sr.support,
              priceDecimals(pair)
            )
          : null,

      resistance:
        Number.isFinite(sr.resistance)
          ? round(
              sr.resistance,
              priceDecimals(pair)
            )
          : null,

      bollingerUpper:
        bb
          ? round(
              bb.upper,
              priceDecimals(pair)
            )
          : null,

      bollingerMiddle:
        bb
          ? round(
              bb.middle,
              priceDecimals(pair)
            )
          : null,

      bollingerLower:
        bb
          ? round(
              bb.lower,
              priceDecimals(pair)
            )
          : null
    },

    candles:
      tfCandles.length,

    source: 'Twelve Data LIVE',

    analysisTime:
      new Date().toISOString(),

    reasons:
      reasons.slice(0, 6)
  };
}

/* =========================================================
   BEST RESULT SELECTION
   ========================================================= */

function rankResult(result) {
  if (!result) {
    return -Infinity;
  }

  if (
    result.signal === 'NO TRADE'
  ) {
    return (
      result.confidence * 0.35
    );
  }

  const score =
    result.confidence +
    Math.abs(
      result.callScore -
      result.putScore
    ) *
      0.6;

  let bonus = 0;

  if (
    result.marketCondition ===
      'UPTREND' &&
    result.signal === 'CALL'
  ) {
    bonus += 8;
  }

  if (
    result.marketCondition ===
      'DOWNTREND' &&
    result.signal === 'PUT'
  ) {
    bonus += 8;
  }

  if (
    result.indicators.adx14 !== null &&
    result.indicators.adx14 >= 25
  ) {
    bonus += 5;
  }

  return score + bonus;
}

function chooseBest(results) {
  if (!results.length) {
    return null;
  }

  const sorted =
    results
      .slice()
      .sort(
        (a, b) =>
          rankResult(b) -
          rankResult(a)
      );

  return sorted[0];
}

/* =========================================================
   PAIR ANALYSIS
   ========================================================= */

async function analyzePair(
  pair,
  options = {}
) {
  const normalized =
    normalizePair(pair);

  if (!normalized) {
    throw new Error(
      `Unsupported pair: ${pair}`
    );
  }

  const data =
    await getPairCandles(
      normalized,
      options
    );

  const results = [];

  for (const timeframe of TIMEFRAMES) {
    const key =
      `${normalized}:${timeframe}`;

    const cachedResult =
      getCachedResult(key);

    if (
      cachedResult &&
      !options.forceRefresh
    ) {
      results.push(
        cachedResult
      );
      continue;
    }

    const result =
      calculateMarketAnalysis(
        normalized,
        timeframe,
        data.candles
      );

    result.dataSource =
      data.source;

    if (data.warning) {
      result.dataWarning =
        data.warning;
    }

    setCachedResult(
      key,
      result
    );

    results.push(result);
  }

  return {
    pair: normalized,
    source: data.source,
    cachedAt: data.cachedAt,
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
      skipped: true,
      reason: 'scan_already_running'
    };
  }

  /*
    Do not start a provider scan while quota is blocked.
  */
  if (quotaBlocked) {
    return {
      skipped: true,
      reason: 'provider_quota_blocked'
    };
  }

  /*
    Do not consume requests after backend budget.
  */
  if (!isBudgetAvailable()) {
    return {
      skipped: true,
      reason: 'daily_budget_reached'
    };
  }

  scanRunning = true;

  const startedAt =
    new Date().toISOString();

  const batch =
    [];

  for (
    let i = 0;
    i < SCAN_BATCH_SIZE;
    i++
  ) {
    const index =
      (scanCursor + i) %
      PAIRS.length;

    batch.push(
      PAIRS[index]
    );
  }

  let scannedThisRun = 0;
  let failedThisRun = 0;

  try {
    for (const pair of batch) {
      /*
        If quota gets blocked during a pair,
        stop immediately.
      */
      if (quotaBlocked) {
        break;
      }

      try {
        const analysis =
          await analyzePair(
            pair,
            {
              forceRefresh: true
            }
          );

        scannedThisRun++;
        totalScanned++;

        console.log(
          `[SCAN] ${pair} OK (${analysis.source})`
        );
      } catch (error) {
        failedThisRun++;
        totalFailed++;

        lastScanError =
          `${pair}: ${error.message}`;

        console.warn(
          `[SCAN] ${lastScanError}`
        );

        /*
          Critical quota protection:
          do not continue requesting more pairs.
        */
        if (quotaBlocked) {
          break;
        }
      }
    }

    scanCursor =
      (scanCursor +
        batch.length) %
      PAIRS.length;

    lastScanAt =
      new Date().toISOString();

    return {
      skipped: false,
      startedAt,
      completedAt: lastScanAt,
      scannedThisRun,
      failedThisRun,
      scanCursor,
      quotaBlocked
    };
  } finally {
    scanRunning = false;
  }
}

/* =========================================================
   ROUTES
   ========================================================= */

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'PO AI Predictor',
    version: VERSION,
    source: 'Twelve Data LIVE',
    status: quotaBlocked
      ? 'QUOTA_BLOCKED'
      : 'ONLINE',
    endpoints: [
      '/api/health',
      '/api/analyze',
      '/api/best',
      '/api/scan',
      '/api/scan/status'
    ]
  });
});

/* ---------------------------------------------------------
   HEALTH
   --------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  resetDailyStateIfNeeded();

  const cachedPairs =
    Array.from(
      pairCache.entries()
    ).filter(
      ([, value]) =>
        Date.now() -
          value.timestamp <=
        CACHE_TTL_MS
    ).length;

  const cachedResults =
    Array.from(
      resultCache.entries()
    ).filter(
      ([, value]) =>
        Date.now() -
          value.timestamp <=
        RESULT_TTL_MS
    ).length;

  res.json({
    ok: true,
    version: VERSION,
    source: 'Twelve Data LIVE',
    timezone: TIMEZONE,

    pairs: PAIRS.length,
    supportedTimeframes:
      TIMEFRAMES,

    cachedPairs,
    cachedResults,

    scanRunning,
    scanCursor,
    scanBatchSize:
      SCAN_BATCH_SIZE,

    scanEveryMinutes:
      SCAN_EVERY_MS / 60000,

    cacheTtlMinutes:
      CACHE_TTL_MS / 60000,

    lastScanAt,
    lastScanError,

    totalScanned,
    totalFailed,
    totalApiRequests,

    apiBudget: {
      dailyLimit:
        DAILY_REQUEST_LIMIT,

      safetyReserve:
        SAFETY_RESERVE,

      maxDailyRequests:
        MAX_DAILY_REQUESTS,

      dailyRequests,

      dailyCreditsUsed,

      dailyCreditsLeft:
        getDailyCreditsLeft(),

      dailyRequestsLeft:
        getDailyRequestsLeft(),

      quotaBlocked,

      providerQuotaMessage,

      quotaResetAt:
        providerQuotaResetAt
    },

    time:
      new Date().toISOString()
  });
});

/* ---------------------------------------------------------
   SCAN STATUS
   --------------------------------------------------------- */

app.get(
  '/api/scan/status',
  (req, res) => {
    resetDailyStateIfNeeded();

    res.json({
      ok: true,
      version: VERSION,
      scanRunning,
      scanCursor,
      scanBatchSize:
        SCAN_BATCH_SIZE,
      pairs: PAIRS.length,
      lastScanAt,
      lastScanError,
      quotaBlocked,
      providerQuotaMessage,
      quotaResetAt:
        providerQuotaResetAt,
      cachedPairs:
        pairCache.size,
      cachedResults:
        resultCache.size,
      time:
        new Date().toISOString()
    });
  }
);

/* ---------------------------------------------------------
   MANUAL SCAN
   --------------------------------------------------------- */

app.get(
  '/api/scan',
  async (req, res) => {
    try {
      const result =
        await scanBatch();

      res.json({
        ok: true,
        version: VERSION,
        ...result
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        version: VERSION,
        error: error.message
      });
    }
  }
);

/* ---------------------------------------------------------
   ANALYZE ONE PAIR
   --------------------------------------------------------- */

app.get(
  '/api/analyze',
  async (req, res) => {
    resetDailyStateIfNeeded();

    const pair =
      normalizePair(
        req.query.pair
      );

    if (!pair) {
      return res.status(400).json({
        ok: false,
        error:
          'Valid pair is required.',
        supportedPairs: PAIRS
      });
    }

    try {
      const analysis =
        await analyzePair(
          pair,
          {
            forceRefresh:
              req.query.refresh === '1'
          }
        );

      res.json({
        ok: true,
        version: VERSION,
        ...analysis
      });
    } catch (error) {
      const status =
        quotaBlocked
          ? 429
          : 500;

      res.status(status).json({
        ok: false,
        version: VERSION,
        pair,
        error: error.message,
        quotaBlocked,
        quotaResetAt:
          providerQuotaResetAt,
        time:
          new Date().toISOString()
      });
    }
  }
);

/* ---------------------------------------------------------
   BEST RESULT
   --------------------------------------------------------- */

app.get(
  '/api/best',
  async (req, res) => {
    resetDailyStateIfNeeded();

    const results = [];

    /*
      Prefer already cached results.
      This endpoint does NOT automatically make
      24 fresh Twelve Data requests.
    */
    for (const [
      key,
      value
    ] of resultCache.entries()) {
      if (
        Date.now() -
          value.timestamp >
        RESULT_TTL_MS
      ) {
        continue;
      }

      if (value.result) {
        results.push(
          value.result
        );
      }
    }

    /*
      If cache has no results, perform ONE controlled scan batch.
      Never scan all 24 pairs from this endpoint.
    */
    if (
      results.length === 0 &&
      !quotaBlocked
    ) {
      try {
        await scanBatch();
      } catch (error) {
        lastScanError =
          error.message;
      }

      for (const [
        ,
        value
      ] of resultCache.entries()) {
        if (
          Date.now() -
            value.timestamp <=
          RESULT_TTL_MS
        ) {
          if (value.result) {
            results.push(
              value.result
            );
          }
        }
      }
    }

    const best =
      chooseBest(results);

    if (!best) {
      return res.status(503).json({
        ok: false,
        version: VERSION,
        error:
          quotaBlocked
            ? (
                providerQuotaMessage ||
                'Twelve Data quota is blocked.'
              )
            : 'No selected market is currently available.',
        quotaBlocked,
        quotaResetAt:
          providerQuotaResetAt,
        cachedResults:
          results.length,
        time:
          new Date().toISOString()
      });
    }

    res.json({
      ok: true,
      version: VERSION,
      selectedMarket: best,
      scannedResults:
        results.length,
      quotaBlocked,
      time:
        new Date().toISOString()
    });
  }
);

/* ---------------------------------------------------------
   COMPATIBILITY ROUTE
   --------------------------------------------------------- */

app.get(
  '/api/selected',
  async (req, res) => {
    try {
      const results = [];

      for (const [
        ,
        value
      ] of resultCache.entries()) {
        if (
          Date.now() -
            value.timestamp <=
          RESULT_TTL_MS
        ) {
          if (value.result) {
            results.push(
              value.result
            );
          }
        }
      }

      const best =
        chooseBest(results);

      if (!best) {
        return res.status(503).json({
          ok: false,
          error:
            quotaBlocked
              ? (
                  providerQuotaMessage ||
                  'Twelve Data quota is blocked.'
                )
              : 'No selected market is currently available.',
          quotaBlocked,
          quotaResetAt:
            providerQuotaResetAt
        });
      }

      res.json({
        ok: true,
        version: VERSION,
        selectedMarket: best
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   404
   ========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error: 'Endpoint not found.',
      version: VERSION
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
      '=============================================='
    );

    console.log(
      `PO AI PREDICTOR ${VERSION}`
    );

    console.log(
      'Source: Twelve Data LIVE'
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Pairs: ${PAIRS.length}`
    );

    console.log(
      `Timeframes: ${TIMEFRAMES.join(', ')} minutes`
    );

    console.log(
      `Scan batch: ${SCAN_BATCH_SIZE}`
    );

    console.log(
      `Scan interval: ${SCAN_EVERY_MS / 60000} minutes`
    );

    console.log(
      `Cache TTL: ${CACHE_TTL_MS / 60000} minutes`
    );

    console.log(
      `Daily safe request budget: ${MAX_DAILY_REQUESTS}`
    );

    console.log(
      `API key configured: ${Boolean(
        TWELVE_DATA_API_KEY
      )}`
    );

    console.log(
      '=============================================='
    );
  }
);

/* =========================================================
   AUTOMATIC SCANNER
   ========================================================= */

/*
  Delayed startup prevents Render restart from immediately
  consuming an API request.
*/
setTimeout(
  async () => {
    try {
      console.log(
        '[SCANNER] Initial controlled scan starting...'
      );

      await scanBatch();
    } catch (error) {
      lastScanError =
        error.message;

      console.error(
        '[SCANNER] Initial scan error:',
        error.message
      );
    }
  },
  10000
);

/*
  Every 15 minutes:
  - check quota
  - scan only one small batch
  - never scan all 24 at once
*/
setInterval(
  async () => {
    resetDailyStateIfNeeded();

    if (quotaBlocked) {
      console.log(
        '[SCANNER] Skipped — Twelve Data quota blocked.'
      );
      return;
    }

    if (scanRunning) {
      console.log(
        '[SCANNER] Skipped — previous scan still running.'
      );
      return;
    }

    try {
      await scanBatch();
    } catch (error) {
      lastScanError =
        error.message;

      console.error(
        '[SCANNER] Error:',
        error.message
      );
    }
  },
  SCAN_EVERY_MS
);
