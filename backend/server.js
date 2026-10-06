'use strict';

/*
============================================================
 PO AI PREDICTOR
 BACKEND V9.0 FINAL
 LIVE ONLY — TWELVE DATA

 FINAL ARCHITECTURE
 -----------------------------------------------------------
 One provider response per pair
        ↓
 Local 1m / 2m / 3m candle construction
        ↓
 Indicators
        ↓
 Signal engine
        ↓
 Ranking
        ↓
 ONE selectedMarket object
        ↓
 /api/best
        ↓
 script.js

 IMPORTANT:
 - No OTC
 - No MACD
 - No CCI
 - No external sentiment claims
 - Market Psychology = price-action inference only
 - Maximum 7 Twelve Data requests per minute
 - Daily safety limit
 - Cached pair data
 - Cached analysis results
============================================================
*/

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVE_DATA_KEY ||
  '';

const TWELVE_DATA_URL =
  'https://api.twelvedata.com/time_series';

const VERSION = 'V9.0 FINAL';
const SOURCE = 'Twelve Data LIVE';
const TIMEZONE = 'UTC';

const TIMEFRAMES = [1, 2, 3];

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

/*
Twelve Data credit protection.

We intentionally stay below a possible provider limit of 8
credits/minute.
*/
const PROVIDER_MINUTE_LIMIT = 7;

const DAILY_REQUEST_LIMIT = 768;
const DAILY_SAFETY_RESERVE = 32;

const EFFECTIVE_DAILY_LIMIT =
  DAILY_REQUEST_LIMIT - DAILY_SAFETY_RESERVE;

const CANDLE_OUTPUT_SIZE = 180;

const PAIR_CACHE_TTL_MS = 15 * 60 * 1000;
const RESULT_CACHE_TTL_MS = 30 * 1000;

const PROVIDER_REQUEST_WINDOW_MS = 60 * 1000;

const SCAN_BATCH_SIZE = 7;
const SCAN_INTERVAL_MS = 60 * 1000;

const MIN_CANDLES = 80;

const ENTRY_BUFFER_SECONDS = 30;

const MAX_CANDLE_AGE_SECONDS = 120;
const HARD_STALE_SECONDS = 300;

/* =========================================================
   STATE
========================================================= */

const pairCache = new Map();
const resultCache = new Map();

const providerRequestTimes = [];

let dailyCreditsUsed = 0;
let dailyDateKey = getUtcDateKey();

let scanRunning = false;
let scanCursor = 0;
let lastScanAt = null;
let lastScanError = null;

let totalScanned = 0;
let totalFailed = 0;
let totalApiRequests = 0;

/* =========================================================
   HELPERS
========================================================= */

function nowMs() {
  return Date.now();
}

function getUtcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyCounterIfNeeded() {
  const today = getUtcDateKey();

  if (today !== dailyDateKey) {
    dailyDateKey = today;
    dailyCreditsUsed = 0;
  }
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) return null;

  const p = Math.pow(10, decimals);

  return Math.round(value * p) / p;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function minutesAgo(date) {
  return Math.floor((Date.now() - new Date(date).getTime()) / 60000);
}

/* =========================================================
   PROVIDER RATE LIMIT
========================================================= */

function pruneProviderRequestTimes() {
  const cutoff = Date.now() - PROVIDER_REQUEST_WINDOW_MS;

  while (
    providerRequestTimes.length &&
    providerRequestTimes[0] < cutoff
  ) {
    providerRequestTimes.shift();
  }
}

function providerMinuteAvailable() {
  pruneProviderRequestTimes();

  return providerRequestTimes.length < PROVIDER_MINUTE_LIMIT;
}

function dailyCreditsAvailable() {
  resetDailyCounterIfNeeded();

  return dailyCreditsUsed < EFFECTIVE_DAILY_LIMIT;
}

async function waitForProviderSlot() {
  while (!providerMinuteAvailable()) {
    pruneProviderRequestTimes();

    const oldest = providerRequestTimes[0];

    if (!oldest) break;

    const waitMs =
      PROVIDER_REQUEST_WINDOW_MS -
      (Date.now() - oldest) +
      1000;

    await sleep(Math.max(1000, waitMs));
  }
}

function registerProviderRequest() {
  providerRequestTimes.push(Date.now());

  dailyCreditsUsed += 1;
  totalApiRequests += 1;
}

/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchPairFromProvider(pair) {
  resetDailyCounterIfNeeded();

  if (!TWELVE_DATA_API_KEY) {
    throw new Error('TWELVE_DATA_API_KEY is missing');
  }

  if (!dailyCreditsAvailable()) {
    throw new Error('Daily safety limit reached');
  }

  await waitForProviderSlot();

  const url = new URL(TWELVE_DATA_URL);

  url.searchParams.set('symbol', pair);
  url.searchParams.set('interval', '1min');
  url.searchParams.set('outputsize', String(CANDLE_OUTPUT_SIZE));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('order', 'asc');
  url.searchParams.set('apikey', TWELVE_DATA_API_KEY);

  registerProviderRequest();

  const response = await fetch(url.toString());

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error('Invalid Twelve Data response');
  }

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
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
    throw new Error(
      data.message ||
      data.code ||
      'Twelve Data provider error'
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error('Twelve Data returned no candle values');
  }

  const candles = data.values
    .map(item => ({
      time: new Date(item.datetime).toISOString(),
      open: safeNumber(item.open),
      high: safeNumber(item.high),
      low: safeNumber(item.low),
      close: safeNumber(item.close),
      volume: safeNumber(item.volume)
    }))
    .filter(c =>
      c.open !== null &&
      c.high !== null &&
      c.low !== null &&
      c.close !== null &&
      Number.isFinite(new Date(c.time).getTime())
    )
    .sort(
      (a, b) =>
        new Date(a.time).getTime() -
        new Date(b.time).getTime()
    );

  if (candles.length < MIN_CANDLES) {
    throw new Error(
      `${pair}: insufficient candles (${candles.length})`
    );
  }

  const latest = candles[candles.length - 1];

  const ageSeconds =
    (Date.now() - new Date(latest.time).getTime()) / 1000;

  if (ageSeconds > HARD_STALE_SECONDS) {
    throw new Error(
      `${pair}: data too stale (${Math.round(ageSeconds)}s)`
    );
  }

  return {
    pair,
    candles,
    latest,
    fetchedAt: new Date().toISOString(),
    ageSeconds: Math.max(0, Math.round(ageSeconds))
  };
}

/* =========================================================
   LOCAL CANDLE AGGREGATION
========================================================= */

function aggregateCandles(candles, timeframeMinutes) {
  if (timeframeMinutes === 1) {
    return candles.slice();
  }

  const bucketMap = new Map();

  for (const candle of candles) {
    const timestamp =
      new Date(candle.time).getTime();

    const bucketSize =
      timeframeMinutes * 60 * 1000;

    const bucket =
      Math.floor(timestamp / bucketSize) *
      bucketSize;

    if (!bucketMap.has(bucket)) {
      bucketMap.set(bucket, {
        time: new Date(bucket).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0
      });
    } else {
      const item = bucketMap.get(bucket);

      item.high = Math.max(
        item.high,
        candle.high
      );

      item.low = Math.min(
        item.low,
        candle.low
      );

      item.close = candle.close;

      item.volume += candle.volume || 0;
    }
  }

  return Array.from(bucketMap.values())
    .sort(
      (a, b) =>
        new Date(a.time).getTime() -
        new Date(b.time).getTime()
    );
}

/*
Do not use a currently-forming candle as the signal candle.

We use the latest completed bucket.
*/
function completedCandles(candles, timeframeMinutes) {
  if (!candles.length) return [];

  const bucketSize =
    timeframeMinutes * 60 * 1000;

  const now = Date.now();

  return candles.filter(c => {
    const t = new Date(c.time).getTime();

    return (
      t + bucketSize <= now
    );
  });
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier =
    2 / (period + 1);

  let previous = 0;

  for (let i = 0; i < period; i++) {
    previous += values[i];
  }

  previous /= period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    previous =
      (values[i] - previous) *
      multiplier +
      previous;
  }

  return previous;
}

function emaSeries(values, period) {
  if (values.length < period) return [];

  const result = [];

  const multiplier =
    2 / (period + 1);

  let previous = 0;

  for (let i = 0; i < period; i++) {
    previous += values[i];
  }

  previous /= period;

  result.push(previous);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    previous =
      (values[i] - previous) *
      multiplier +
      previous;

    result.push(previous);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) gain += diff;
    else loss -= diff;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] - values[i - 1];

    const currentGain =
      diff > 0 ? diff : 0;

    const currentLoss =
      diff < 0 ? -diff : 0;

    avgGain =
      (avgGain * (period - 1) +
        currentGain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) +
        currentLoss) /
      period;
  }

  if (avgLoss === 0) return 100;

  const rs =
    avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function trueRange(candles, index) {
  if (index === 0) {
    return (
      candles[index].high -
      candles[index].low
    );
  }

  const current = candles[index];
  const previous = candles[index - 1];

  return Math.max(
    current.high - current.low,
    Math.abs(
      current.high - previous.close
    ),
    Math.abs(
      current.low - previous.close
    )
  );
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  let value = 0;

  for (let i = 0; i < period; i++) {
    value += trueRange(candles, i);
  }

  value /= period;

  for (
    let i = period;
    i < candles.length;
    i++
  ) {
    value =
      (value * (period - 1) +
        trueRange(candles, i)) /
      period;
  }

  return value;
}

function adx(candles, period = 14) {
  if (candles.length < period * 2 + 2) {
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

    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(
          current.high - previous.close
        ),
        Math.abs(
          current.low - previous.close
        )
      )
    );
  }

  let tr14 = 0;
  let plus14 = 0;
  let minus14 = 0;

  for (let i = 0; i < period; i++) {
    tr14 += trs[i];
    plus14 += plusDM[i];
    minus14 += minusDM[i];
  }

  const dxValues = [];

  function calculateDX() {
    const plusDI =
      tr14 === 0
        ? 0
        : 100 * (plus14 / tr14);

    const minusDI =
      tr14 === 0
        ? 0
        : 100 * (minus14 / tr14);

    const denominator =
      plusDI + minusDI;

    if (denominator === 0) return 0;

    return (
      100 *
      Math.abs(
        plusDI - minusDI
      ) /
      denominator
    );
  }

  dxValues.push(calculateDX());

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    tr14 =
      tr14 -
      tr14 / period +
      trs[i];

    plus14 =
      plus14 -
      plus14 / period +
      plusDM[i];

    minus14 =
      minus14 -
      minus14 / period +
      minusDM[i];

    dxValues.push(calculateDX());
  }

  if (dxValues.length < period) {
    return null;
  }

  let result = 0;

  for (let i = 0; i < period; i++) {
    result += dxValues[i];
  }

  result /= period;

  for (
    let i = period;
    i < dxValues.length;
    i++
  ) {
    result =
      (result * (period - 1) +
        dxValues[i]) /
      period;
  }

  return result;
}

function stochastic(candles, period = 14) {
  if (candles.length < period) return null;

  const recent =
    candles.slice(-period);

  const highest =
    Math.max(
      ...recent.map(c => c.high)
    );

  const lowest =
    Math.min(
      ...recent.map(c => c.low)
    );

  const close =
    candles[candles.length - 1].close;

  if (highest === lowest) {
    return 50;
  }

  return (
    100 *
    ((close - lowest) /
      (highest - lowest))
  );
}

function bollinger(candles, period = 20) {
  if (candles.length < period) return null;

  const values =
    candles
      .slice(-period)
      .map(c => c.close);

  const mean =
    values.reduce(
      (a, b) => a + b,
      0
    ) / values.length;

  const variance =
    values.reduce(
      (sum, value) =>
        sum +
        Math.pow(value - mean, 2),
      0
    ) / values.length;

  const deviation =
    Math.sqrt(variance);

  return {
    middle: mean,
    upper: mean + 2 * deviation,
    lower: mean - 2 * deviation
  };
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(candles, lookback = 40) {
  const recent =
    candles.slice(-lookback);

  if (!recent.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const lows =
    recent.map(c => c.low);

  const highs =
    recent.map(c => c.high);

  return {
    support: Math.min(...lows),
    resistance: Math.max(...highs)
  };
}

/* =========================================================
   CANDLE PATTERNS
========================================================= */

function candlePattern(candles) {
  if (candles.length < 3) {
    return {
      name: 'NONE',
      direction: 'NEUTRAL',
      strength: 0
    };
  }

  const a =
    candles[candles.length - 3];

  const b =
    candles[candles.length - 2];

  const c =
    candles[candles.length - 1];

  const body =
    Math.abs(c.close - c.open);

  const range =
    Math.max(
      c.high - c.low,
      0.00000001
    );

  const upperWick =
    c.high - Math.max(
      c.open,
      c.close
    );

  const lowerWick =
    Math.min(
      c.open,
      c.close
    ) - c.low;

  const bullish =
    c.close > c.open;

  const bearish =
    c.close < c.open;

  /* Bullish engulfing */
  if (
    b.close < b.open &&
    bullish &&
    c.open <= b.close &&
    c.close >= b.open
  ) {
    return {
      name: 'BULLISH_ENGULFING',
      direction: 'CALL',
      strength: 8
    };
  }

  /* Bearish engulfing */
  if (
    b.close > b.open &&
    bearish &&
    c.open >= b.close &&
    c.close <= b.open
  ) {
    return {
      name: 'BEARISH_ENGULFING',
      direction: 'PUT',
      strength: 8
    };
  }

  /* Hammer */
  if (
    lowerWick > body * 2 &&
    upperWick < body * 1.2
  ) {
    return {
      name: 'HAMMER',
      direction: 'CALL',
      strength: 6
    };
  }

  /* Shooting star */
  if (
    upperWick > body * 2 &&
    lowerWick < body * 1.2
  ) {
    return {
      name: 'SHOOTING_STAR',
      direction: 'PUT',
      strength: 6
    };
  }

  /* Strong bullish candle */
  if (
    bullish &&
    body / range > 0.65
  ) {
    return {
      name: 'STRONG_BULLISH',
      direction: 'CALL',
      strength: 4
    };
  }

  /* Strong bearish candle */
  if (
    bearish &&
    body / range > 0.65
  ) {
    return {
      name: 'STRONG_BEARISH',
      direction: 'PUT',
      strength: 4
    };
  }

  /*
  Three candle continuation.
  */
  if (
    a.close < b.close &&
    b.close < c.close
  ) {
    return {
      name: 'THREE_CANDLE_UP',
      direction: 'CALL',
      strength: 5
    };
  }

  if (
    a.close > b.close &&
    b.close > c.close
  ) {
    return {
      name: 'THREE_CANDLE_DOWN',
      direction: 'PUT',
      strength: 5
    };
  }

  return {
    name: 'NEUTRAL',
    direction: 'NEUTRAL',
    strength: 0
  };
}

/* =========================================================
   MARKET PSYCHOLOGY
========================================================= */

function marketPsychology(
  candles,
  ema9,
  ema21,
  rsiValue,
  adxValue
) {
  const latest =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  if (!latest || !previous) {
    return {
      label: 'NEUTRAL',
      direction: 'NEUTRAL',
      score: 0
    };
  }

  const body =
    Math.abs(
      latest.close - latest.open
    );

  const range =
    Math.max(
      latest.high - latest.low,
      0.00000001
    );

  const bodyRatio =
    body / range;

  let score = 0;
  let direction = 'NEUTRAL';
  let label = 'BALANCED';

  if (
    ema9 !== null &&
    ema21 !== null &&
    ema9 > ema21
  ) {
    score += 2;
    direction = 'CALL';
  }

  if (
    ema9 !== null &&
    ema21 !== null &&
    ema9 < ema21
  ) {
    score -= 2;
    direction = 'PUT';
  }

  if (
    latest.close > previous.close
  ) {
    score += 1;
  } else if (
    latest.close < previous.close
  ) {
    score -= 1;
  }

  if (
    bodyRatio >= 0.65
  ) {
    score +=
      latest.close > latest.open
        ? 2
        : -2;
  }

  if (
    Number.isFinite(adxValue) &&
    adxValue >= 25
  ) {
    score +=
      direction === 'CALL'
        ? 1
        : direction === 'PUT'
          ? -1
          : 0;
  }

  if (
    Number.isFinite(rsiValue)
  ) {
    if (rsiValue > 55) score += 1;
    if (rsiValue < 45) score -= 1;
  }

  if (score >= 4) {
    label = 'BULLISH_PRESSURE';
    direction = 'CALL';
  } else if (score <= -4) {
    label = 'BEARISH_PRESSURE';
    direction = 'PUT';
  } else if (score >= 2) {
    label = 'MILD_BULLISH';
    direction = 'CALL';
  } else if (score <= -2) {
    label = 'MILD_BEARISH';
    direction = 'PUT';
  } else {
    label = 'BALANCED';
    direction = 'NEUTRAL';
  }

  return {
    label,
    direction,
    score
  };
}

/* =========================================================
   ANALYZE TIMEFRAME
========================================================= */

function analyzeTimeframe(
  pair,
  timeframe,
  candles
) {
  if (candles.length < MIN_CANDLES / timeframe) {
    return null;
  }

  const closes =
    candles.map(c => c.close);

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const rsiValue =
    rsi(closes, 14);

  const adxValue =
    adx(candles, 14);

  const atrValue =
    atr(candles, 14);

  const stochasticValue =
    stochastic(candles, 14);

  const bollingerValue =
    bollinger(candles, 20);

  const sr =
    supportResistance(candles, 40);

  const pattern =
    candlePattern(candles);

  const psychology =
    marketPsychology(
      candles,
      ema9,
      ema21,
      rsiValue,
      adxValue
    );

  const current =
    candles[candles.length - 1];

  const price =
    current.close;

  let callScore = 0;
  let putScore = 0;

  /* =======================================================
     EMA
  ======================================================= */

  if (
    ema9 !== null &&
    ema21 !== null
  ) {
    if (ema9 > ema21) {
      callScore += 20;
    } else if (ema9 < ema21) {
      putScore += 20;
    }
  }

  /* =======================================================
     RSI
  ======================================================= */

  if (rsiValue !== null) {
    if (
      rsiValue >= 52 &&
      rsiValue <= 68
    ) {
      callScore += 12;
    }

    if (
      rsiValue <= 48 &&
      rsiValue >= 32
    ) {
      putScore += 12;
    }

    /*
    Avoid blindly buying extreme RSI.
    */
    if (rsiValue > 75) {
      putScore += 4;
    }

    if (rsiValue < 25) {
      callScore += 4;
    }
  }

  /* =======================================================
     ADX
  ======================================================= */

  if (adxValue !== null) {
    if (adxValue >= 25) {
      if (
        ema9 !== null &&
        ema21 !== null
      ) {
        if (ema9 > ema21) {
          callScore += 15;
        } else {
          putScore += 15;
        }
      }
    } else {
      /*
      Weak trend = reduce confidence.
      */
      callScore -= 4;
      putScore -= 4;
    }
  }

  /* =======================================================
     STOCHASTIC
  ======================================================= */

  if (
    stochasticValue !== null
  ) {
    if (
      stochasticValue >= 50 &&
      stochasticValue <= 85
    ) {
      callScore += 8;
    }

    if (
      stochasticValue <= 50 &&
      stochasticValue >= 15
    ) {
      putScore += 8;
    }
  }

  /* =======================================================
     PRICE ACTION
  ======================================================= */

  if (
    pattern.direction === 'CALL'
  ) {
    callScore += pattern.strength;
  }

  if (
    pattern.direction === 'PUT'
  ) {
    putScore += pattern.strength;
  }

  /* =======================================================
     PSYCHOLOGY
  ======================================================= */

  if (
    psychology.direction === 'CALL'
  ) {
    callScore += 8;
  }

  if (
    psychology.direction === 'PUT'
  ) {
    putScore += 8;
  }

  /* =======================================================
     SUPPORT / RESISTANCE
  ======================================================= */

  let nearSupport = false;
  let nearResistance = false;

  if (
    sr.support !== null &&
    atrValue !== null
  ) {
    const distance =
      Math.abs(
        price - sr.support
      );

    nearSupport =
      distance <= atrValue * 0.8;
  }

  if (
    sr.resistance !== null &&
    atrValue !== null
  ) {
    const distance =
      Math.abs(
        sr.resistance - price
      );

    nearResistance =
      distance <= atrValue * 0.8;
  }

  if (nearSupport) {
    callScore += 6;
  }

  if (nearResistance) {
    putScore += 6;
  }

  /* =======================================================
     BOLLINGER
  ======================================================= */

  if (bollingerValue) {
    if (
      price >
      bollingerValue.middle
    ) {
      callScore += 3;
    } else if (
      price <
      bollingerValue.middle
    ) {
      putScore += 3;
    }

    /*
    Do not chase extreme outer band.
    */
    if (
      price >=
      bollingerValue.upper
    ) {
      callScore -= 5;
    }

    if (
      price <=
      bollingerValue.lower
    ) {
      putScore -= 5;
    }
  }

  /* =======================================================
     FINAL DIRECTION
  ======================================================= */

  const strongestScore =
    Math.max(
      callScore,
      putScore
    );

  const weakestScore =
    Math.min(
      callScore,
      putScore
    );

  const gap =
    Math.abs(
      callScore - putScore
    );

  let signal = 'NO TRADE';

  if (
    callScore >= 55 &&
    callScore > putScore &&
    gap >= 12
  ) {
    signal = 'CALL';
  }

  if (
    putScore >= 55 &&
    putScore > callScore &&
    gap >= 12
  ) {
    signal = 'PUT';
  }

  /*
  Confidence is deliberately conservative.
  */
  let confidence =
    50 +
    (strongestScore - 55) * 0.7 +
    gap * 0.55;

  if (signal === 'NO TRADE') {
    confidence =
      Math.min(
        59,
        45 + gap * 0.35
      );
  }

  confidence =
    Math.round(
      clamp(
        confidence,
        45,
        97
      )
    );

  /*
  Volatility quality.
  */
  let volatilityQuality =
    'NORMAL';

  if (
    atrValue !== null &&
    price !== 0
  ) {
    const atrPercent =
      (atrValue / price) * 100;

    if (atrPercent < 0.01) {
      volatilityQuality = 'LOW';
    } else if (
      atrPercent > 0.25
    ) {
      volatilityQuality = 'HIGH';
    }
  }

  /*
  If volatility is extremely high,
  do not pretend confidence is higher.
  */
  if (
    volatilityQuality === 'HIGH'
  ) {
    confidence =
      Math.max(
        45,
        confidence - 5
      );
  }

  const candleTime =
    new Date(current.time);

  const bucketMs =
    timeframe *
    60 *
    1000;

  /*
  Entry is the next candle opening time.
  */
  const entryDate =
    new Date(
      candleTime.getTime() +
      bucketMs
    );

  /*
  If the calculated entry is too close,
  move to the following candle.
  */
  const secondsToEntry =
    Math.floor(
      (entryDate.getTime() -
        Date.now()) /
      1000
    );

  let finalEntry =
    entryDate;

  if (
    secondsToEntry <
    ENTRY_BUFFER_SECONDS
  ) {
    finalEntry =
      new Date(
        entryDate.getTime() +
        bucketMs
      );
  }

  const expiryDate =
    new Date(
      finalEntry.getTime() +
      bucketMs
    );

  const finalEntryInSeconds =
    Math.max(
      0,
      Math.floor(
        (finalEntry.getTime() -
          Date.now()) /
        1000
      )
    );

  /*
  Signal should not be too close to expiry.
  */
  if (
    finalEntryInSeconds < 15
  ) {
    signal = 'NO TRADE';
  }

  return {
    pair,
    timeframe,

    signal,

    confidence,

    currentPrice: round(
      price,
      6
    ),

    entryTime:
      finalEntry.toISOString(),

    expiryTime:
      expiryDate.toISOString(),

    entryInSeconds:
      finalEntryInSeconds,

    lastCandle:
      current.time,

    indicators: {
      ema9: round(ema9, 6),
      ema21: round(ema21, 6),
      rsi14: round(rsiValue, 2),
      adx14: round(adxValue, 2),
      atr14: round(atrValue, 6),
      stochastic14: round(
        stochasticValue,
        2
      ),

      support: round(
        sr.support,
        6
      ),

      resistance: round(
        sr.resistance,
        6
      ),

      bollingerUpper:
        bollingerValue
          ? round(
              bollingerValue.upper,
              6
            )
          : null,

      bollingerMiddle:
        bollingerValue
          ? round(
              bollingerValue.middle,
              6
            )
          : null,

      bollingerLower:
        bollingerValue
          ? round(
              bollingerValue.lower,
              6
            )
          : null
    },

    priceAction: {
      pattern:
        pattern.name,

      direction:
        pattern.direction,

      strength:
        pattern.strength
    },

    marketPsychology: {
      label:
        psychology.label,

      direction:
        psychology.direction,

      score:
        psychology.score
    },

    score: {
      call:
        round(callScore, 2),

      put:
        round(putScore, 2),

      gap:
        round(gap, 2)
    },

    quality: {
      volatility:
        volatilityQuality,

      nearSupport,
      nearResistance
    }
  };
}

/* =========================================================
   PAIR ANALYSIS
========================================================= */

function analyzePair(pairData) {
  const results = [];

  for (const timeframe of TIMEFRAMES) {
    const aggregated =
      aggregateCandles(
        pairData.candles,
        timeframe
      );

    const completed =
      completedCandles(
        aggregated,
        timeframe
      );

    const result =
      analyzeTimeframe(
        pairData.pair,
        timeframe,
        completed
      );

    if (result) {
      results.push(result);
    }
  }

  return results;
}

/* =========================================================
   CACHE
========================================================= */

function getCachedPair(pair) {
  const item =
    pairCache.get(pair);

  if (!item) return null;

  if (
    Date.now() - item.cachedAt >
    PAIR_CACHE_TTL_MS
  ) {
    return null;
  }

  return item;
}

function getAnyPairCache(pair) {
  return pairCache.get(pair) || null;
}

function setPairCache(pair, data) {
  pairCache.set(
    pair,
    {
      ...data,
      cachedAt: Date.now()
    }
  );
}

function getCachedResult(key) {
  const item =
    resultCache.get(key);

  if (!item) return null;

  if (
    Date.now() - item.cachedAt >
    RESULT_CACHE_TTL_MS
  ) {
    resultCache.delete(key);
    return null;
  }

  return item.value;
}

function setCachedResult(key, value) {
  resultCache.set(
    key,
    {
      value,
      cachedAt: Date.now()
    }
  );
}

/* =========================================================
   RANKING
========================================================= */

function rankingScore(result) {
  if (!result) return -9999;

  let score =
    result.confidence;

  if (
    result.signal === 'NO TRADE'
  ) {
    score -= 30;
  }

  score +=
    Math.min(
      15,
      result.score.gap
    );

  if (
    result.indicators.adx14 !== null &&
    result.indicators.adx14 >= 25
  ) {
    score += 5;
  }

  if (
    result.entryInSeconds >= 30 &&
    result.entryInSeconds <= 180
  ) {
    score += 4;
  }

  if (
    result.quality.volatility ===
    'HIGH'
  ) {
    score -= 5;
  }

  return score;
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
          rankingScore(b) -
          rankingScore(a)
      );

  return sorted[0];
}

/* =========================================================
   BUILD API CONTRACT
========================================================= */

function buildApiResponse(
  selectedMarket,
  extra = {}
) {
  return {
    ok: true,

    version: VERSION,

    source: SOURCE,

    timezone: TIMEZONE,

    selectedMarket:
      selectedMarket || null,

    supportedTimeframes:
      TIMEFRAMES,

    pairs: PAIRS.length,

    metadata: {
      provider:
        'Twelve Data',

      liveOnly: true,

      providerMinuteLimit:
        PROVIDER_MINUTE_LIMIT,

      dailyLimit:
        DAILY_REQUEST_LIMIT,

      dailySafetyReserve:
        DAILY_SAFETY_RESERVE,

      dailyCreditsUsed:
        dailyCreditsUsed,

      dailyCreditsRemaining:
        Math.max(
          0,
          EFFECTIVE_DAILY_LIMIT -
            dailyCreditsUsed
        ),

      cacheTTLSeconds:
        PAIR_CACHE_TTL_MS / 1000,

      resultTTLSeconds:
        RESULT_CACHE_TTL_MS / 1000,

      entryBufferSeconds:
        ENTRY_BUFFER_SECONDS
    },

    scanner: {
      scanRunning,

      scanCursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      lastScanAt,

      lastScanError,

      totalScanned,

      totalFailed,

      totalApiRequests
    },

    ...extra
  };
}

/* =========================================================
   SCAN ONE PAIR
========================================================= */

async function scanPair(pair) {
  try {
    let pairData =
      getCachedPair(pair);

    if (!pairData) {
      pairData =
        await fetchPairFromProvider(
          pair
        );

      setPairCache(
        pair,
        pairData
      );
    }

    const analyses =
      analyzePair(pairData);

    if (!analyses.length) {
      throw new Error(
        `${pair}: no valid timeframe analysis`
      );
    }

    totalScanned += 1;

    return {
      pair,
      data: pairData,
      analyses
    };
  } catch (error) {
    totalFailed += 1;

    /*
    Stale cache fallback.
    */
    const stale =
      getAnyPairCache(pair);

    if (stale) {
      try {
        const analyses =
          analyzePair(stale);

        if (analyses.length) {
          return {
            pair,
            data: stale,
            analyses,
            stale: true
          };
        }
      } catch {
        /* continue */
      }
    }

    throw error;
  }
}

/* =========================================================
   FULL / BATCH SCAN
========================================================= */

async function scanBatch() {
  if (scanRunning) {
    return;
  }

  scanRunning = true;
  lastScanError = null;

  try {
    let processed = 0;

    /*
    Start at cursor.
    */
    while (
      processed < SCAN_BATCH_SIZE &&
      scanCursor < PAIRS.length
    ) {
      const pair =
        PAIRS[scanCursor];

      try {
        await scanPair(pair);
      } catch (error) {
        lastScanError =
          `${pair}: ${error.message}`;
      }

      scanCursor += 1;
      processed += 1;

      /*
      Respect provider spacing.
      */
      if (
        processed < SCAN_BATCH_SIZE
      ) {
        await sleep(1500);
      }
    }

    /*
    When all pairs are visited,
    restart cursor for next cycle.
    */
    if (
      scanCursor >= PAIRS.length
    ) {
      scanCursor = 0;
    }

    lastScanAt =
      new Date().toISOString();
  } finally {
    scanRunning = false;
  }
}

/*
Background scanner.

Because requests are rate-limited,
the scanner processes only a safe batch.
*/
setInterval(() => {
  scanBatch().catch(error => {
    lastScanError =
      error.message;
  });
}, SCAN_INTERVAL_MS);

/* =========================================================
   BEST MARKET
========================================================= */

async function getBestMarket() {
  const cacheKey =
    'BEST_MARKET';

  const cached =
    getCachedResult(cacheKey);

  if (cached) {
    return cached;
  }

  /*
  First collect already-cached analyses.
  */
  const candidates = [];

  for (const pair of PAIRS) {
    const cachedPair =
      getAnyPairCache(pair);

    if (!cachedPair) {
      continue;
    }

    try {
      const analyses =
        analyzePair(cachedPair);

      for (const analysis of analyses) {
        candidates.push(
          analysis
        );
      }
    } catch {
      /* ignore */
    }
  }

  /*
  If there is not enough cached data,
  synchronously fill a safe batch.
  */
  if (
    candidates.length === 0
  ) {
    await scanBatch();

    for (const pair of PAIRS) {
      const cachedPair =
        getAnyPairCache(pair);

      if (!cachedPair) continue;

      try {
        const analyses =
          analyzePair(cachedPair);

        candidates.push(
          ...analyses
        );
      } catch {
        /* ignore */
      }
    }
  }

  const best =
    chooseBest(candidates);

  if (!best) {
    return null;
  }

  const response =
    buildApiResponse(
      best,
      {
        candidateCount:
          candidates.length
      }
    );

  setCachedResult(
    cacheKey,
    response
  );

  return response;
}

/* =========================================================
   ROUTES
========================================================= */

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'PO AI Predictor',
    version: VERSION,
    source: SOURCE,
    message:
      'PO AI Predictor API is running',
    endpoints: [
      '/api/health',
      '/api/best',
      '/api/analyze?pair=EUR/USD',
      '/api/pairs'
    ]
  });
});

/* ---------------------------------------------------------
   HEALTH
--------------------------------------------------------- */

app.get(
  '/api/health',
  (req, res) => {
    resetDailyCounterIfNeeded();

    res.json(
      buildApiResponse(
        null,
        {
          health: {
            status: 'online',

            apiKeyConfigured:
              Boolean(
                TWELVE_DATA_API_KEY
              ),

            cachePairs:
              pairCache.size,

            cachedResults:
              resultCache.size,

            providerRequestsLastMinute:
              providerRequestTimes.length,

            quotaBlocked:
              !dailyCreditsAvailable(),

            uptimeSeconds:
              Math.floor(
                process.uptime()
              )
          }
        }
      )
    );
  }
);

/* ---------------------------------------------------------
   PAIRS
--------------------------------------------------------- */

app.get(
  '/api/pairs',
  (req, res) => {
    res.json(
      buildApiResponse(
        null,
        {
          pairsList:
            PAIRS
        }
      )
    );
  }
);

/* ---------------------------------------------------------
   BEST
--------------------------------------------------------- */

app.get(
  '/api/best',
  async (req, res) => {
    try {
      const result =
        await getBestMarket();

      if (!result) {
        return res.status(503).json({
          ...buildApiResponse(null),
          ok: false,
          error:
            'No selected market available yet'
        });
      }

      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        ...buildApiResponse(null),
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* ---------------------------------------------------------
   ANALYZE SPECIFIC PAIR
--------------------------------------------------------- */

app.get(
  '/api/analyze',
  async (req, res) => {
    const pair =
      String(
        req.query.pair || ''
      ).trim();

    if (!pair) {
      return res.status(400).json({
        ok: false,
        error:
          'Missing pair parameter'
      });
    }

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

    try {
      const result =
        await scanPair(pair);

      const selectedMarket =
        chooseBest(
          result.analyses
        );

      return res.json(
        buildApiResponse(
          selectedMarket,
          {
            pair,
            analyses:
              result.analyses
          }
        )
      );
    } catch (error) {
      return res.status(503).json({
        ...buildApiResponse(null),
        ok: false,
        pair,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(err);

    res.status(500).json({
      ok: false,
      version: VERSION,
      error:
        'Internal server error'
    });
  }
);

/* =========================================================
   START
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
      `Port: ${PORT}`
    );

    console.log(
      `Source: ${SOURCE}`
    );

    console.log(
      `Pairs: ${PAIRS.length}`
    );

    console.log(
      `Timeframes: ${TIMEFRAMES.join(', ')}`
    );

    console.log(
      `Provider minute limit: ${PROVIDER_MINUTE_LIMIT}`
    );

    console.log(
      `Daily effective limit: ${EFFECTIVE_DAILY_LIMIT}`
    );

    console.log(
      '================================================'
    );
  }
);
