'use strict';

/*
============================================================
 PO AI PREDICTOR
 Backend V9.0.3
 LIVE ONLY - Twelve Data

 V9.0.3
 - Single source of truth
 - One consistent /api/best response
 - Scan-lock synchronization
 - Never return null selectedMarket while a scan can provide data
 - Fresh/stale cache protection
 - 7 provider requests/minute maximum
 - Daily safety reserve
 - 24 LIVE Forex pairs
 - 1m provider candles
 - Local 2m / 3m aggregation
 - Completed candles only
 - EMA9 / EMA21
 - RSI14
 - ADX14
 - Stochastic14
 - ATR14
 - Bollinger20
 - Support / Resistance
 - Candlestick patterns
 - Price-action market psychology
 - Backend calculates signal
 - Frontend only displays backend response
============================================================
*/

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

/* ==========================================================
   CONFIG
========================================================== */

const VERSION = 'V9.0.3';
const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVE_DATA_KEY ||
  '';

const TWELVE_DATA_URL =
  'https://api.twelvedata.com/time_series';

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

/* Provider safety */
const PROVIDER_MINUTE_LIMIT = 7;
const PROVIDER_WINDOW_MS = 60 * 1000;

/*
 Daily provider allowance:
 768 total
 32 reserved
 = 736 usable by scanner
*/
const DAILY_REQUEST_LIMIT = 768;
const DAILY_SAFETY_RESERVE = 32;
const MAX_DAILY_REQUESTS =
  DAILY_REQUEST_LIMIT - DAILY_SAFETY_RESERVE;

/* Candles */
const CANDLE_OUTPUT_SIZE = 180;
const MIN_CANDLES = 80;

/* Cache */
const PAIR_CACHE_TTL_MS = 15 * 60 * 1000;
const RESULT_CACHE_TTL_MS = 30 * 1000;

/* Scanner */
const SCAN_BATCH_SIZE = 7;
const SCAN_INTERVAL_MS = 60 * 1000;
const SCAN_PAIR_DELAY_MS = 1500;

/* Signal timing */
const ENTRY_BUFFER_SECONDS = 30;

/* Freshness */
const MAX_DATA_AGE_SECONDS = 120;
const HARD_STALE_SECONDS = 300;

/* ==========================================================
   STATE
========================================================== */

const pairCache = new Map();

let bestResultCache = null;

let providerRequestTimes = [];

let dailyCreditsUsed = 0;
let dailyUsageDate = utcDateKey(new Date());

let scanRunning = false;
let scanPromise = null;

let scanCursor = 0;
let lastScanAt = null;
let lastScanError = null;

let totalScanned = 0;
let totalFailed = 0;
let totalApiRequests = 0;

/* ==========================================================
   BASIC HELPERS
========================================================== */

function utcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function nowMs() {
  return Date.now();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function round(value, digits = 5) {
  if (!isFiniteNumber(value)) return null;

  const factor = Math.pow(10, digits);
  return Math.round(Number(value) * factor) / factor;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resetDailyUsageIfNeeded() {
  const today = utcDateKey();

  if (today !== dailyUsageDate) {
    dailyUsageDate = today;
    dailyCreditsUsed = 0;
  }
}

function remainingDailyCredits() {
  resetDailyUsageIfNeeded();

  return Math.max(
    0,
    MAX_DAILY_REQUESTS - dailyCreditsUsed
  );
}

function cleanupProviderWindow() {
  const cutoff = nowMs() - PROVIDER_WINDOW_MS;

  providerRequestTimes =
    providerRequestTimes.filter(ts => ts > cutoff);
}

function providerRequestsInCurrentMinute() {
  cleanupProviderWindow();
  return providerRequestTimes.length;
}

function canRequestProvider() {
  resetDailyUsageIfNeeded();
  cleanupProviderWindow();

  if (dailyCreditsUsed >= MAX_DAILY_REQUESTS) {
    return {
      ok: false,
      reason: 'Daily safety limit reached'
    };
  }

  if (
    providerRequestTimes.length >=
    PROVIDER_MINUTE_LIMIT
  ) {
    return {
      ok: false,
      reason: 'Provider minute safety limit reached'
    };
  }

  return {
    ok: true,
    reason: null
  };
}

function registerProviderRequest() {
  resetDailyUsageIfNeeded();

  providerRequestTimes.push(nowMs());

  dailyCreditsUsed += 1;
  totalApiRequests += 1;
}

/* ==========================================================
   HTTP FETCH
========================================================== */

async function fetchJson(url) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 20000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
      signal: controller.signal
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Provider returned invalid JSON (${response.status})`
      );
    }

    if (!response.ok) {
      throw new Error(
        data?.message ||
        data?.code ||
        `HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/* ==========================================================
   TWELVE DATA
========================================================== */

async function fetchOneMinuteCandles(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      'TWELVE_DATA_API_KEY is not configured'
    );
  }

  const permission = canRequestProvider();

  if (!permission.ok) {
    throw new Error(permission.reason);
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
    String(CANDLE_OUTPUT_SIZE)
  );

  url.searchParams.set(
    'timezone',
    'UTC'
  );

  url.searchParams.set(
    'order',
    'ASC'
  );

  url.searchParams.set(
    'apikey',
    TWELVE_DATA_API_KEY
  );

  registerProviderRequest();

  const data = await fetchJson(url.toString());

  if (
    data &&
    typeof data === 'object' &&
    (
      data.status === 'error' ||
      data.code
    )
  ) {
    throw new Error(
      data.message ||
      `Twelve Data error ${data.code || ''}`.trim()
    );
  }

  if (!Array.isArray(data?.values)) {
    throw new Error(
      'Twelve Data returned no candle values'
    );
  }

  const candles = data.values
    .map(row => {
      const timestamp =
        Date.parse(
          `${row.datetime}Z`
        );

      return {
        time: Number.isFinite(timestamp)
          ? timestamp
          : Date.parse(row.datetime),

        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: isFiniteNumber(row.volume)
          ? Number(row.volume)
          : null
      };
    })
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
      `Insufficient candles: ${candles.length}`
    );
  }

  return candles;
}

/* ==========================================================
   COMPLETED CANDLES
========================================================== */

function completedCandles(candles) {
  if (!Array.isArray(candles)) {
    return [];
  }

  const currentMinuteStart =
    Math.floor(nowMs() / 60000) * 60000;

  return candles.filter(
    candle =>
      candle.time < currentMinuteStart
  );
}

/* ==========================================================
   TIMEFRAME AGGREGATION
========================================================== */

function aggregateCandles(candles, minutes) {
  if (minutes === 1) {
    return candles.slice();
  }

  const buckets = new Map();

  for (const candle of candles) {
    const bucketSize =
      minutes * 60 * 1000;

    const bucket =
      Math.floor(candle.time / bucketSize) *
      bucketSize;

    if (!buckets.has(bucket)) {
      buckets.set(bucket, {
        time: bucket,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
        count: 1
      });
    } else {
      const item = buckets.get(bucket);

      item.high =
        Math.max(item.high, candle.high);

      item.low =
        Math.min(item.low, candle.low);

      item.close =
        candle.close;

      if (Number.isFinite(candle.volume)) {
        item.volume += candle.volume;
      }

      item.count += 1;
    }
  }

  return [...buckets.values()]
    .filter(item => item.count === minutes)
    .map(item => ({
      time: item.time,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume
    }))
    .sort((a, b) => a.time - b.time);
}

/* ==========================================================
   BASIC MATH
========================================================== */

function sma(values, period) {
  if (values.length < period) {
    return null;
  }

  const slice =
    values.slice(values.length - period);

  return (
    slice.reduce(
      (sum, value) => sum + value,
      0
    ) / period
  );
}

function emaSeries(values, period) {
  const output =
    new Array(values.length).fill(null);

  if (values.length < period) {
    return output;
  }

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  let ema = sum / period;

  output[period - 1] = ema;

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    ema =
      (values[i] - ema) *
      multiplier +
      ema;

    output[i] = ema;
  }

  return output;
}

function ema(values, period) {
  const series =
    emaSeries(values, period);

  return series[series.length - 1] ?? null;
}

/* ==========================================================
   RSI
========================================================== */

function rsi(values, period = 14) {
  if (values.length <= period) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      values[i] - values[i - 1];

    if (change >= 0) {
      gain += change;
    } else {
      loss += Math.abs(change);
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    const currentGain =
      Math.max(change, 0);

    const currentLoss =
      Math.max(-change, 0);

    avgGain =
      ((avgGain * (period - 1)) +
        currentGain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) +
        currentLoss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

/* ==========================================================
   ATR
========================================================== */

function atr(candles, period = 14) {
  if (candles.length <= period) {
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

  let value =
    trs
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

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

/* ==========================================================
   ADX
========================================================== */

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

  let atrValue =
    trs
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  let plusValue =
    plusDM
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  let minusValue =
    minusDM
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  const dxValues = [];

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    if (i > period) {
      atrValue =
        ((atrValue * (period - 1)) +
          trs[i]) /
        period;

      plusValue =
        ((plusValue * (period - 1)) +
          plusDM[i]) /
        period;

      minusValue =
        ((minusValue * (period - 1)) +
          minusDM[i]) /
        period;
    }

    const plusDI =
      atrValue === 0
        ? 0
        : (100 * plusValue) /
          atrValue;

    const minusDI =
      atrValue === 0
        ? 0
        : (100 * minusValue) /
          atrValue;

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
      .reduce((a, b) => a + b, 0) /
    period;

  for (
    let i = period;
    i < dxValues.length;
    i++
  ) {
    adxValue =
      ((adxValue * (period - 1)) +
        dxValues[i]) /
      period;
  }

  return adxValue;
}

/* ==========================================================
   STOCHASTIC
========================================================== */

function stochastic(
  candles,
  period = 14
) {
  if (candles.length < period) {
    return null;
  }

  const recent =
    candles.slice(
      candles.length - period
    );

  const highest =
    Math.max(
      ...recent.map(c => c.high)
    );

  const lowest =
    Math.min(
      ...recent.map(c => c.low)
    );

  const close =
    recent[recent.length - 1].close;

  if (highest === lowest) {
    return 50;
  }

  return (
    100 *
    (close - lowest) /
    (highest - lowest)
  );
}

/* ==========================================================
   BOLLINGER
========================================================== */

function bollinger(
  values,
  period = 20,
  multiplier = 2
) {
  if (values.length < period) {
    return null;
  }

  const recent =
    values.slice(
      values.length - period
    );

  const middle =
    recent.reduce(
      (a, b) => a + b,
      0
    ) / period;

  const variance =
    recent.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - middle,
          2
        ),
      0
    ) / period;

  const std =
    Math.sqrt(variance);

  return {
    middle,
    upper:
      middle + multiplier * std,
    lower:
      middle - multiplier * std
  };
}

/* ==========================================================
   SUPPORT / RESISTANCE
========================================================== */

function supportResistance(candles) {
  const recent =
    candles.slice(-40);

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

/* ==========================================================
   CANDLE PATTERNS
========================================================== */

function candlePattern(candles) {
  if (candles.length < 3) {
    return {
      direction: 'NEUTRAL',
      pattern: 'NONE',
      strength: 0
    };
  }

  const a =
    candles[candles.length - 3];

  const b =
    candles[candles.length - 2];

  const c =
    candles[candles.length - 1];

  const bodyA =
    Math.abs(a.close - a.open);

  const bodyB =
    Math.abs(b.close - b.open);

  const bodyC =
    Math.abs(c.close - c.open);

  const rangeC =
    Math.max(
      c.high - c.low,
      0.00000001
    );

  const upperWickC =
    c.high -
    Math.max(c.open, c.close);

  const lowerWickC =
    Math.min(c.open, c.close) -
    c.low;

  const bullishEngulfing =
    b.close < b.open &&
    c.close > c.open &&
    c.open <= b.close &&
    c.close >= b.open;

  const bearishEngulfing =
    b.close > b.open &&
    c.close < c.open &&
    c.open >= b.close &&
    c.close <= b.open;

  if (bullishEngulfing) {
    return {
      direction: 'CALL',
      pattern: 'BULLISH ENGULFING',
      strength: 12
    };
  }

  if (bearishEngulfing) {
    return {
      direction: 'PUT',
      pattern: 'BEARISH ENGULFING',
      strength: 12
    };
  }

  if (
    lowerWickC > bodyC * 2 &&
    lowerWickC > upperWickC &&
    c.close >= c.open
  ) {
    return {
      direction: 'CALL',
      pattern: 'HAMMER / LOWER REJECTION',
      strength: 9
    };
  }

  if (
    upperWickC > bodyC * 2 &&
    upperWickC > lowerWickC &&
    c.close <= c.open
  ) {
    return {
      direction: 'PUT',
      pattern: 'SHOOTING STAR / UPPER REJECTION',
      strength: 9
    };
  }

  const bodyRatio =
    bodyC / rangeC;

  if (
    bodyRatio >= 0.65 &&
    c.close > c.open
  ) {
    return {
      direction: 'CALL',
      pattern: 'STRONG BULLISH CANDLE',
      strength: 7
    };
  }

  if (
    bodyRatio >= 0.65 &&
    c.close < c.open
  ) {
    return {
      direction: 'PUT',
      pattern: 'STRONG BEARISH CANDLE',
      strength: 7
    };
  }

  if (
    a.close > a.open &&
    b.close > b.open &&
    c.close > c.open
  ) {
    return {
      direction: 'CALL',
      pattern: 'THREE BULLISH CANDLES',
      strength: 8
    };
  }

  if (
    a.close < a.open &&
    b.close < b.open &&
    c.close < c.open
  ) {
    return {
      direction: 'PUT',
      pattern: 'THREE BEARISH CANDLES',
      strength: 8
    };
  }

  return {
    direction: 'NEUTRAL',
    pattern: 'MIXED PRICE ACTION',
    strength: 0
  };
}

/* ==========================================================
   MARKET PSYCHOLOGY
========================================================== */

function marketPsychology(
  candles,
  ema9Value,
  ema21Value,
  adxValue,
  rsiValue
) {
  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const move =
    last.close - previous.close;

  const body =
    Math.abs(
      last.close - last.open
    );

  const range =
    Math.max(
      last.high - last.low,
      0.00000001
    );

  const bodyRatio =
    body / range;

  if (
    ema9Value > ema21Value &&
    move > 0 &&
    adxValue >= 25 &&
    rsiValue >= 50
  ) {
    return {
      direction: 'CALL',
      label: 'Bullish momentum / buyers in control',
      strength: 8
    };
  }

  if (
    ema9Value < ema21Value &&
    move < 0 &&
    adxValue >= 25 &&
    rsiValue <= 50
  ) {
    return {
      direction: 'PUT',
      label: 'Bearish momentum / sellers in control',
      strength: 8
    };
  }

  if (
    bodyRatio < 0.25
  ) {
    return {
      direction: 'NEUTRAL',
      label: 'Indecision / weak conviction',
      strength: 0
    };
  }

  if (move > 0) {
    return {
      direction: 'CALL',
      label: 'Short-term bullish pressure',
      strength: 4
    };
  }

  if (move < 0) {
    return {
      direction: 'PUT',
      label: 'Short-term bearish pressure',
      strength: 4
    };
  }

  return {
    direction: 'NEUTRAL',
    label: 'Balanced market',
    strength: 0
  };
}

/* ==========================================================
   TIME HELPERS
========================================================== */

function nextBoundary(
  timestamp,
  minutes
) {
  const size =
    minutes * 60 * 1000;

  return (
    Math.floor(
      timestamp / size
    ) + 1
  ) * size;
}

/* ==========================================================
   ANALYZE TIMEFRAME
========================================================== */

function analyzeTimeframe(
  pair,
  timeframe,
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < MIN_CANDLES
  ) {
    return null;
  }

  const closes =
    candles.map(c => c.close);

  const ema9Value =
    ema(closes, 9);

  const ema21Value =
    ema(closes, 21);

  const rsiValue =
    rsi(closes, 14);

  const atrValue =
    atr(candles, 14);

  const adxValue =
    adx(candles, 14);

  const stochasticValue =
    stochastic(candles, 14);

  const bb =
    bollinger(closes, 20, 2);

  const sr =
    supportResistance(candles);

  const pattern =
    candlePattern(candles);

  const psychology =
    marketPsychology(
      candles,
      ema9Value,
      ema21Value,
      adxValue,
      rsiValue
    );

  const last =
    candles[candles.length - 1];

  const currentPrice =
    last.close;

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  /* EMA */
  if (
    ema9Value !== null &&
    ema21Value !== null
  ) {
    if (ema9Value > ema21Value) {
      callScore += 20;

      reasons.push(
        'EMA9 is above EMA21'
      );
    } else if (
      ema9Value < ema21Value
    ) {
      putScore += 20;

      reasons.push(
        'EMA9 is below EMA21'
      );
    }
  }

  /* RSI */
  if (rsiValue !== null) {
    if (
      rsiValue >= 52 &&
      rsiValue <= 68
    ) {
      callScore += 12;

      reasons.push(
        'RSI supports bullish momentum'
      );
    } else if (
      rsiValue >= 32 &&
      rsiValue <= 48
    ) {
      putScore += 12;

      reasons.push(
        'RSI supports bearish momentum'
      );
    } else if (
      rsiValue > 75
    ) {
      putScore += 4;

      reasons.push(
        'RSI is overbought'
      );
    } else if (
      rsiValue < 25
    ) {
      callScore += 4;

      reasons.push(
        'RSI is oversold'
      );
    }
  }

  /* ADX */
  if (
    adxValue !== null
  ) {
    if (adxValue >= 25) {
      if (
        ema9Value > ema21Value
      ) {
        callScore += 15;

        reasons.push(
          'ADX confirms trend strength'
        );
      } else if (
        ema9Value < ema21Value
      ) {
        putScore += 15;

        reasons.push(
          'ADX confirms trend strength'
        );
      }
    } else {
      callScore -= 4;
      putScore -= 4;

      reasons.push(
        'ADX shows weak trend strength'
      );
    }
  }

  /* Stochastic */
  if (
    stochasticValue !== null
  ) {
    if (
      stochasticValue >= 50 &&
      stochasticValue <= 85
    ) {
      callScore += 8;

      reasons.push(
        'Stochastic supports CALL momentum'
      );
    } else if (
      stochasticValue >= 15 &&
      stochasticValue < 50
    ) {
      putScore += 8;

      reasons.push(
        'Stochastic supports PUT momentum'
      );
    }
  }

  /* Pattern */
  if (pattern.direction === 'CALL') {
    callScore += pattern.strength;

    reasons.push(
      pattern.pattern
    );
  }

  if (pattern.direction === 'PUT') {
    putScore += pattern.strength;

    reasons.push(
      pattern.pattern
    );
  }

  /* Psychology */
  if (
    psychology.direction === 'CALL'
  ) {
    callScore += psychology.strength;

    reasons.push(
      psychology.label
    );
  }

  if (
    psychology.direction === 'PUT'
  ) {
    putScore += psychology.strength;

    reasons.push(
      psychology.label
    );
  }

  /* Support / resistance */
  if (
    sr.support !== null &&
    sr.resistance !== null &&
    atrValue !== null
  ) {
    const supportDistance =
      Math.abs(
        currentPrice - sr.support
      );

    const resistanceDistance =
      Math.abs(
        currentPrice - sr.resistance
      );

    if (
      supportDistance <=
      atrValue * 0.8
    ) {
      callScore += 6;

      reasons.push(
        'Price is near support'
      );
    }

    if (
      resistanceDistance <=
      atrValue * 0.8
    ) {
      putScore += 6;

      reasons.push(
        'Price is near resistance'
      );
    }
  }

  /* Bollinger */
  if (
    bb &&
    atrValue !== null
  ) {
    if (
      currentPrice > bb.middle
    ) {
      callScore += 3;
    }

    if (
      currentPrice < bb.middle
    ) {
      putScore += 3;
    }

    if (
      currentPrice >= bb.upper
    ) {
      callScore -= 5;
      putScore += 3;

      reasons.push(
        'Price is near Bollinger upper band'
      );
    }

    if (
      currentPrice <= bb.lower
    ) {
      putScore -= 5;
      callScore += 3;

      reasons.push(
        'Price is near Bollinger lower band'
      );
    }
  }

  callScore =
    Math.max(0, callScore);

  putScore =
    Math.max(0, putScore);

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
    strongestScore -
    weakestScore;

  let signal = 'NO TRADE';

  if (
    callScore >= 55 &&
    callScore > putScore &&
    gap >= 12
  ) {
    signal = 'CALL';
  } else if (
    putScore >= 55 &&
    putScore > callScore &&
    gap >= 12
  ) {
    signal = 'PUT';
  }

  /* Volatility */
  let volatility = 'NORMAL';

  if (
    atrValue !== null &&
    currentPrice > 0
  ) {
    const atrPercent =
      (atrValue / currentPrice) *
      100;

    if (atrPercent >= 0.12) {
      volatility = 'HIGH';
    } else if (
      atrPercent <= 0.03
    ) {
      volatility = 'LOW';
    }
  }

  let confidence =
    50 +
    (strongestScore - 55) * 0.7 +
    gap * 0.55;

  if (
    volatility === 'HIGH'
  ) {
    confidence -= 5;
  }

  confidence =
    clamp(
      confidence,
      45,
      97
    );

  if (
    signal === 'NO TRADE'
  ) {
    confidence =
      Math.min(
        confidence,
        59
      );
  }

  /* Entry / expiry */
  const now = nowMs();

  let entryTime =
    nextBoundary(
      now,
      timeframe
    );

  let secondsToEntry =
    Math.floor(
      (entryTime - now) /
      1000
    );

  if (
    secondsToEntry <
    ENTRY_BUFFER_SECONDS
  ) {
    entryTime +=
      timeframe *
      60 *
      1000;

    secondsToEntry =
      Math.floor(
        (entryTime - now) /
        1000
      );
  }

  const expiryTime =
    entryTime +
    timeframe *
    60 *
    1000;

  /*
   If the entry is too close, do not expose
   a risky immediate signal.
  */
  if (
    secondsToEntry < 15
  ) {
    signal = 'NO TRADE';
    confidence =
      Math.min(
        confidence,
        59
      );
  }

  const latestCandleAgeSeconds =
    Math.max(
      0,
      Math.floor(
        (now - last.time) /
        1000
      )
    );

  if (
    latestCandleAgeSeconds >
    HARD_STALE_SECONDS
  ) {
    signal = 'NO TRADE';

    confidence =
      Math.min(
        confidence,
        55
      );

    reasons.push(
      'Market data is too old'
    );
  }

  if (
    signal === 'NO TRADE'
  ) {
    reasons.push(
      'Signal quality threshold not fully confirmed'
    );
  }

  const entryPrice =
    currentPrice;

  return {
    pair,
    timeframe,

    signal,

    confidence:
      Math.round(confidence),

    currentPrice:
      round(currentPrice, 6),

    entryPrice:
      round(entryPrice, 6),

    entryTime:
      new Date(entryTime).toISOString(),

    expiryTime:
      new Date(expiryTime).toISOString(),

    entryInSeconds:
      Math.max(
        0,
        secondsToEntry
      ),

    lastCandle:
      new Date(last.time).toISOString(),

    dataAgeSeconds:
      latestCandleAgeSeconds,

    callScore:
      round(callScore, 2),

    putScore:
      round(putScore, 2),

    gap:
      round(gap, 2),

    volatility,

    indicators: {
      ema9:
        round(ema9Value, 6),

      ema21:
        round(ema21Value, 6),

      rsi14:
        round(rsiValue, 2),

      adx14:
        round(adxValue, 2),

      stochastic14:
        round(stochasticValue, 2),

      atr14:
        round(atrValue, 6),

      bollinger: bb
        ? {
            upper:
              round(bb.upper, 6),
            middle:
              round(bb.middle, 6),
            lower:
              round(bb.lower, 6)
          }
        : null
    },

    supportResistance: {
      support:
        round(sr.support, 6),

      resistance:
        round(sr.resistance, 6)
    },

    priceAction: {
      pattern:
        pattern.pattern,

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

      strength:
        psychology.strength
    },

    reasons:
      [...new Set(reasons)].slice(0, 10)
  };
}

/* ==========================================================
   ANALYZE PAIR
========================================================== */

function analyzePairFromCandles(
  pair,
  candles
) {
  const completed =
    completedCandles(candles);

  const analyses = {};

  for (const timeframe of TIMEFRAMES) {
    const tfCandles =
      aggregateCandles(
        completed,
        timeframe
      );

    if (
      tfCandles.length >= MIN_CANDLES
    ) {
      analyses[timeframe] =
        analyzeTimeframe(
          pair,
          timeframe,
          tfCandles
        );
    } else {
      analyses[timeframe] = null;
    }
  }

  return analyses;
}

/* ==========================================================
   CACHE HELPERS
========================================================== */

function cacheFresh(entry) {
  if (!entry) {
    return false;
  }

  return (
    nowMs() - entry.fetchedAt <=
    PAIR_CACHE_TTL_MS
  );
}

function cacheUsable(entry) {
  if (!entry) {
    return false;
  }

  if (
    !entry.candles ||
    !entry.candles.length
  ) {
    return false;
  }

  const latest =
    entry.candles[
      entry.candles.length - 1
    ];

  const age =
    Math.max(
      0,
      Math.floor(
        (nowMs() - latest.time) /
        1000
      )
    );

  return (
    age <= HARD_STALE_SECONDS
  );
}

/* ==========================================================
   FETCH + ANALYZE PAIR
========================================================== */

async function refreshPair(pair) {
  const existing =
    pairCache.get(pair);

  if (
    existing &&
    cacheFresh(existing) &&
    cacheUsable(existing)
  ) {
    return existing;
  }

  try {
    const candles =
      await fetchOneMinuteCandles(pair);

    const analyses =
      analyzePairFromCandles(
        pair,
        candles
      );

    const entry = {
      pair,
      candles,
      analyses,
      fetchedAt: nowMs(),
      source: SOURCE
    };

    pairCache.set(
      pair,
      entry
    );

    totalScanned += 1;

    return entry;
  } catch (error) {
    totalFailed += 1;

    /*
     Stale-cache fallback.
     We still use it only while it is inside
     the hard stale window.
    */
    if (
      existing &&
      cacheUsable(existing)
    ) {
      existing.lastError =
        error.message;

      return existing;
    }

    throw error;
  }
}

/* ==========================================================
   CANDIDATES
========================================================== */

function collectCandidates() {
  const candidates = [];

  for (const pair of PAIRS) {
    const entry =
      pairCache.get(pair);

    if (!entry) {
      continue;
    }

    if (!cacheUsable(entry)) {
      continue;
    }

    for (const timeframe of TIMEFRAMES) {
      const market =
        entry.analyses?.[timeframe];

      if (!market) {
        continue;
      }

      candidates.push({
        ...market
      });
    }
  }

  return candidates;
}

/* ==========================================================
   RANKING
========================================================== */

function rankingScore(market) {
  let score =
    Number(market.confidence || 0);

  if (
    market.signal === 'NO TRADE'
  ) {
    score -= 30;
  }

  score +=
    Math.min(
      Number(market.gap || 0),
      15
    );

  if (
    Number(
      market.indicators?.adx14 || 0
    ) >= 25
  ) {
    score += 5;
  }

  const entrySeconds =
    Number(
      market.entryInSeconds || 0
    );

  if (
    entrySeconds >= 30 &&
    entrySeconds <= 180
  ) {
    score += 4;
  }

  if (
    market.volatility === 'HIGH'
  ) {
    score -= 5;
  }

  if (
    Number(
      market.dataAgeSeconds || 0
    ) > MAX_DATA_AGE_SECONDS
  ) {
    score -= 8;
  }

  return score;
}

function chooseBest(candidates) {
  if (!candidates.length) {
    return null;
  }

  return candidates
    .slice()
    .sort(
      (a, b) =>
        rankingScore(b) -
        rankingScore(a)
    )[0];
}

/* ==========================================================
   SCANNER
========================================================== */

async function scanBatch() {
  /*
   If another scan is active, return the SAME promise.
   This is the important synchronization fix.
  */
  if (scanRunning && scanPromise) {
    return scanPromise;
  }

  scanRunning = true;

  scanPromise =
    (async () => {
      let localError = null;

      try {
        const start =
          scanCursor;

        const batch =
          [];

        for (
          let i = 0;
          i < SCAN_BATCH_SIZE;
          i++
        ) {
          const index =
            (start + i) %
            PAIRS.length;

          batch.push(
            PAIRS[index]
          );
        }

        for (
          let i = 0;
          i < batch.length;
          i++
        ) {
          const pair =
            batch[i];

          try {
            await refreshPair(pair);
          } catch (error) {
            localError =
              `${pair}: ${error.message}`;
          }

          if (
            i <
            batch.length - 1
          ) {
            await sleep(
              SCAN_PAIR_DELAY_MS
            );
          }
        }

        scanCursor =
          (start +
            batch.length) %
          PAIRS.length;

        lastScanAt =
          new Date().toISOString();

        lastScanError =
          localError;

        /*
         A new scan invalidates the old ranking result.
        */
        bestResultCache = null;

        return {
          ok: true,
          scannedPairs: batch,
          error: localError
        };
      } finally {
        scanRunning = false;
        scanPromise = null;
      }
    })();

  return scanPromise;
}

/* ==========================================================
   ENSURE DATA
========================================================== */

async function ensureCandidates() {
  let candidates =
    collectCandidates();

  if (candidates.length > 0) {
    return candidates;
  }

  /*
   No candidates.
   Force/wait for a synchronized scan.
  */
  await scanBatch();

  candidates =
    collectCandidates();

  /*
   If we still have no candidate, try one more
   available batch only when the provider allows it.
  */
  if (!candidates.length) {
    const permission =
      canRequestProvider();

    if (permission.ok) {
      await scanBatch();
      candidates =
        collectCandidates();
    }
  }

  return candidates;
}

/* ==========================================================
   API RESPONSE
========================================================== */

function buildApiResponse(
  selectedMarket,
  extra = {}
) {
  resetDailyUsageIfNeeded();

  return {
    ok: true,

    version:
      VERSION,

    source:
      SOURCE,

    timezone:
      TIMEZONE,

    selectedMarket:
      selectedMarket || null,

    supportedTimeframes:
      TIMEFRAMES,

    pairs:
      PAIRS,

    metadata: {
      provider:
        SOURCE,

      liveOnly:
        true,

      providerMinuteLimit:
        PROVIDER_MINUTE_LIMIT,

      providerRequestsThisMinute:
        providerRequestsInCurrentMinute(),

      dailyLimit:
        DAILY_REQUEST_LIMIT,

      dailySafetyReserve:
        DAILY_SAFETY_RESERVE,

      maxDailyRequests:
        MAX_DAILY_REQUESTS,

      dailyCreditsUsed:
        dailyCreditsUsed,

      dailyCreditsRemaining:
        remainingDailyCredits(),

      pairCacheTtlSeconds:
        PAIR_CACHE_TTL_MS / 1000,

      resultCacheTtlSeconds:
        RESULT_CACHE_TTL_MS / 1000,

      entryBufferSeconds:
        ENTRY_BUFFER_SECONDS,

      maxDataAgeSeconds:
        MAX_DATA_AGE_SECONDS,

      hardStaleSeconds:
        HARD_STALE_SECONDS
    },

    scanner: {
      scanRunning,

      scanCursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      cachedPairs:
        pairCache.size,

      candidateCount:
        collectCandidates().length,

      lastScanAt,

      lastScanError,

      totalScanned,

      totalFailed,

      totalApiRequests
    },

    ...extra
  };
}

/* ==========================================================
   /api/best
========================================================== */

app.get(
  '/api/best',
  async (req, res) => {
    try {
      resetDailyUsageIfNeeded();

      /*
       Short result cache.
       Return the exact same API contract.
      */
      if (
        bestResultCache &&
        nowMs() -
          bestResultCache.createdAt <=
          RESULT_CACHE_TTL_MS
      ) {
        return res.json(
          bestResultCache.response
        );
      }

      const candidates =
        await ensureCandidates();

      if (!candidates.length) {
        const response =
          buildApiResponse(
            null,
            {
              error:
                'No fresh market candidate is currently available. Scanner is waiting for fresh LIVE data.'
            }
          );

        return res.json(response);
      }

      const selectedMarket =
        chooseBest(candidates);

      const response =
        buildApiResponse(
          selectedMarket,
          {
            rankedCandidates:
              candidates
                .slice()
                .sort(
                  (a, b) =>
                    rankingScore(b) -
                    rankingScore(a)
                )
                .slice(0, 10)
                .map(item => ({
                  pair:
                    item.pair,

                  timeframe:
                    item.timeframe,

                  signal:
                    item.signal,

                  confidence:
                    item.confidence,

                  gap:
                    item.gap,

                  dataAgeSeconds:
                    item.dataAgeSeconds
                }))
          }
        );

      bestResultCache = {
        createdAt:
          nowMs(),

        response
      };

      return res.json(
        response
      );
    } catch (error) {
      console.error(
        'GET /api/best:',
        error
      );

      return res.status(200).json(
        buildApiResponse(
          null,
          {
            error:
              error.message ||
              'Unable to obtain live market data'
          }
        )
      );
    }
  }
);

/* ==========================================================
   /api/analyze
========================================================== */

app.get(
  '/api/analyze',
  async (req, res) => {
    const pair =
      String(
        req.query.pair || ''
      )
        .trim()
        .toUpperCase();

    if (!PAIRS.includes(pair)) {
      return res.status(400).json({
        ok: false,
        version: VERSION,
        error:
          'Unsupported pair',
        supportedPairs:
          PAIRS
      });
    }

    try {
      const entry =
        await refreshPair(pair);

      const analyses =
        entry.analyses;

      const candidates =
        Object.values(analyses)
          .filter(Boolean);

      const selectedMarket =
        chooseBest(candidates);

      return res.json(
        buildApiResponse(
          selectedMarket,
          {
            pair,
            analyses
          }
        )
      );
    } catch (error) {
      return res.status(200).json(
        buildApiResponse(
          null,
          {
            pair,
            error:
              error.message
          }
        )
      );
    }
  }
);

/* ==========================================================
   /api/health
========================================================== */

app.get(
  '/api/health',
  (req, res) => {
    resetDailyUsageIfNeeded();

    res.json({
      ok: true,

      version:
        VERSION,

      source:
        SOURCE,

      timezone:
        TIMEZONE,

      apiConfigured:
        Boolean(
          TWELVE_DATA_API_KEY
        ),

      pairs:
        PAIRS.length,

      supportedTimeframes:
        TIMEFRAMES,

      cachedPairs:
        pairCache.size,

      cachedResults:
        bestResultCache
          ? 1
          : 0,

      scanRunning,

      scanCursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      lastScanAt,

      lastScanError,

      totalScanned,

      totalFailed,

      totalApiRequests,

      providerRequestsThisMinute:
        providerRequestsInCurrentMinute(),

      dailyCreditsUsed,

      dailyCreditsRemaining:
        remainingDailyCredits(),

      providerMinuteLimit:
        PROVIDER_MINUTE_LIMIT,

      dailyLimit:
        DAILY_REQUEST_LIMIT,

      dailySafetyReserve:
        DAILY_SAFETY_RESERVE,

      maxDailyRequests:
        MAX_DAILY_REQUESTS,

      cacheTtlSeconds:
        PAIR_CACHE_TTL_MS / 1000,

      resultTtlSeconds:
        RESULT_CACHE_TTL_MS / 1000,

      entryBufferSeconds:
        ENTRY_BUFFER_SECONDS
    });
  }
);

/* ==========================================================
   /api/pairs
========================================================== */

app.get(
  '/api/pairs',
  (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      pairs: PAIRS,
      supportedTimeframes:
        TIMEFRAMES
    });
  }
);

/* ==========================================================
   ROOT
========================================================== */

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
        SOURCE,
      endpoints: [
        '/api/health',
        '/api/best',
        '/api/analyze?pair=EUR/USD',
        '/api/pairs'
      ]
    });
  }
);

/* ==========================================================
   404
========================================================== */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      version: VERSION,
      error: 'Endpoint not found'
    });
  }
);

/* ==========================================================
   BACKGROUND SCANNER
========================================================== */

async function backgroundScan() {
  try {
    await scanBatch();
  } catch (error) {
    lastScanError =
      error.message;

    console.error(
      'Background scan error:',
      error
    );
  }
}

/*
Start initial scan shortly after server starts.
This gives /api/best fresh data as early as possible.
*/
setTimeout(
  () => {
    backgroundScan();
  },
  1500
);

/*
Continue scanning every minute.
7 pairs per batch.
*/
setInterval(
  () => {
    backgroundScan();
  },
  SCAN_INTERVAL_MS
);

/* ==========================================================
   START SERVER
========================================================== */

app.listen(
  PORT,
  () => {
    console.log(
      `PO AI Predictor ${VERSION} running on port ${PORT}`
    );

    console.log(
      `Source: ${SOURCE}`
    );

    console.log(
      `Pairs: ${PAIRS.length}`
    );

    console.log(
      `Timeframes: ${TIMEFRAMES.join(', ')}m`
    );

    console.log(
      `Provider limit: ${PROVIDER_MINUTE_LIMIT}/minute`
    );

    console.log(
      `Daily usable limit: ${MAX_DAILY_REQUESTS}`
    );
  }
);
