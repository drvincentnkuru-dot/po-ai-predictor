'use strict';

/*
============================================================
 PO AI PREDICTOR
 V9.1 • SYNCHRONIZED LIVE ENGINE

 SOURCE:
 Twelve Data LIVE

 IMPORTANT:
 - Backend is the ONLY signal engine.
 - Frontend never calculates signals.
 - One API response contract is used everywhere.
 - LIVE forex only.
 - No OTC.
 - No MACD.
 - No CCI.

 INDICATORS:
 EMA 9 / EMA 21
 RSI 14
 ADX 14
 Stochastic 14
 ATR 14
 Bollinger Bands
 Support / Resistance
 Candlestick Price Action
 Market Psychology

 SAFETY:
 - Provider hard limit: 7 requests/minute
 - Safe operating limit: 6 requests/minute
 - Daily total limit: 768
 - Daily safety reserve: 32
 - Maximum usable daily requests: 736
 - One provider request queue
 - Duplicate scan protection
 - Fresh/stale/hard-stale protection
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

const VERSION = 'V9.1';
const SOURCE = 'Twelve Data LIVE';
const TIMEZONE = 'UTC';

const PORT = Number(process.env.PORT || 10000);

const API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVEDATA_API_KEY ||
  '';

const TWELVE_DATA_URL =
  'https://api.twelvedata.com/time_series';

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

const SOURCE_INTERVAL = '1min';

const MAX_CANDLES = 180;
const MIN_CANDLES = 60;

/* Provider safety */
const PROVIDER_HARD_LIMIT = 7;
const PROVIDER_SAFE_LIMIT = 6;
const PROVIDER_WINDOW_MS = 60 * 1000;
const PROVIDER_DELAY_MS = 1500;

/* Daily safety */
const DAILY_REQUEST_LIMIT = 768;
const DAILY_SAFETY_RESERVE = 32;
const DAILY_MAX_USABLE =
  DAILY_REQUEST_LIMIT - DAILY_SAFETY_RESERVE;

/* Cache */
const PAIR_CACHE_TTL_MS = 15 * 60 * 1000;
const RESULT_CACHE_TTL_MS = 30 * 1000;

/* Freshness */
const MAX_DATA_AGE_SECONDS = {
  1: 90,
  2: 150,
  3: 210
};

const HARD_STALE_SECONDS = 300;

/* Entry */
const ENTRY_BUFFER_SECONDS = 30;
const MIN_ENTRY_SECONDS = 30;

/* Scanner */
const SCAN_BATCH_SIZE = 6;
const SCAN_EVERY_MS = 60 * 1000;

/* Network */
const REQUEST_TIMEOUT_MS = 18000;

/* =========================================================
   STATE
========================================================= */

const pairCache = new Map();
const resultCache = new Map();

let scanCursor = 0;
let scanRunning = false;
let scanPromise = null;

let lastScanAt = null;
let lastScanError = null;

let totalScanned = 0;
let totalFailed = 0;
let totalApiRequests = 0;

let providerRequestTimes = [];

let dailyCreditsUsed = 0;
let dailyCounterDate = null;

let providerQueue = Promise.resolve();

/* =========================================================
   BASIC HELPERS
========================================================= */

function nowMs() {
  return Date.now();
}

function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyCounterIfNeeded() {
  const today = utcDateKey();

  if (dailyCounterDate !== today) {
    dailyCounterDate = today;
    dailyCreditsUsed = 0;
  }
}

function iso(value) {
  if (!value) return null;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value, fallback = null) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function secondsFromNow(time) {
  const t = new Date(time).getTime();

  if (!Number.isFinite(t)) {
    return null;
  }

  return Math.max(
    0,
    Math.floor((t - nowMs()) / 1000)
  );
}

/* =========================================================
   PROVIDER SAFETY
========================================================= */

function cleanProviderRequestTimes() {
  const cutoff = nowMs() - PROVIDER_WINDOW_MS;

  providerRequestTimes =
    providerRequestTimes.filter(t => t >= cutoff);
}

function providerRequestsThisMinute() {
  cleanProviderRequestTimes();
  return providerRequestTimes.length;
}

function dailyRequestsRemaining() {
  resetDailyCounterIfNeeded();

  return Math.max(
    0,
    DAILY_MAX_USABLE - dailyCreditsUsed
  );
}

function providerCanRequest() {
  if (!API_KEY) {
    return {
      ok: false,
      reason: 'Twelve Data API key is not configured'
    };
  }

  if (providerRequestsThisMinute() >= PROVIDER_SAFE_LIMIT) {
    return {
      ok: false,
      reason: 'Provider safe minute limit reached'
    };
  }

  if (dailyRequestsRemaining() <= 0) {
    return {
      ok: false,
      reason: 'Daily provider safety limit reached'
    };
  }

  return {
    ok: true,
    reason: null
  };
}

async function reserveProviderRequest() {
  resetDailyCounterIfNeeded();

  cleanProviderRequestTimes();

  if (!API_KEY) {
    throw new Error(
      'Twelve Data API key is not configured'
    );
  }

  if (
    providerRequestTimes.length >=
    PROVIDER_SAFE_LIMIT
  ) {
    throw new Error(
      'Provider safe minute limit reached'
    );
  }

  if (
    providerRequestTimes.length >=
    PROVIDER_HARD_LIMIT
  ) {
    throw new Error(
      'Provider hard minute limit reached'
    );
  }

  if (dailyCreditsUsed >= DAILY_MAX_USABLE) {
    throw new Error(
      'Daily provider safety limit reached'
    );
  }

  providerRequestTimes.push(nowMs());

  dailyCreditsUsed += 1;
  totalApiRequests += 1;
}

function enqueueProviderRequest(task) {
  const run = providerQueue.then(async () => {
    await sleep(PROVIDER_DELAY_MS);
    return task();
  });

  providerQueue = run.catch(() => {});

  return run;
}

/* =========================================================
   HTTP FETCH
========================================================= */

async function fetchJson(url) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json'
      }
    });

    const text = await response.text();

    let data = null;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Provider returned invalid JSON (HTTP ${response.status})`
      );
    }

    if (!response.ok) {
      const message =
        data?.message ||
        data?.code ||
        `HTTP ${response.status}`;

      throw new Error(
        `Twelve Data HTTP error: ${message}`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   TWELVE DATA
========================================================= */

function normalizeCandles(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const map = new Map();

  for (const row of values) {
    const time = iso(row?.datetime);

    const open = safeNumber(row?.open);
    const high = safeNumber(row?.high);
    const low = safeNumber(row?.low);
    const close = safeNumber(row?.close);

    if (
      !time ||
      open === null ||
      high === null ||
      low === null ||
      close === null
    ) {
      continue;
    }

    map.set(time, {
      time,
      open,
      high,
      low,
      close
    });
  }

  return [...map.values()]
    .sort(
      (a, b) =>
        new Date(a.time).getTime() -
        new Date(b.time).getTime()
    )
    .slice(-MAX_CANDLES);
}

async function requestTwelveData(pair) {
  const safety = providerCanRequest();

  if (!safety.ok) {
    throw new Error(safety.reason);
  }

  return enqueueProviderRequest(async () => {
    await reserveProviderRequest();

    const params = new URLSearchParams({
      symbol: pair,
      interval: SOURCE_INTERVAL,
      outputsize: String(MAX_CANDLES),
      timezone: TIMEZONE,
      apikey: API_KEY
    });

    const url =
      `${TWELVE_DATA_URL}?${params.toString()}`;

    const data = await fetchJson(url);

    if (data?.status === 'error') {
      throw new Error(
        data?.message ||
        'Twelve Data returned an error'
      );
    }

    const candles =
      normalizeCandles(data?.values);

    if (candles.length < MIN_CANDLES) {
      throw new Error(
        `${pair}: insufficient candle data (${candles.length})`
      );
    }

    return candles;
  });
}

/* =========================================================
   CANDLE COMPLETION
========================================================= */

function completedOneMinuteCandles(candles) {
  if (!candles.length) {
    return [];
  }

  const currentMinute =
    Math.floor(nowMs() / 60000) * 60000;

  return candles.filter(c => {
    const t = new Date(c.time).getTime();

    return Number.isFinite(t) &&
      t < currentMinute;
  });
}

/* =========================================================
   AGGREGATION
========================================================= */

function aggregateCandles(candles, timeframe) {
  if (timeframe === 1) {
    return candles.slice();
  }

  const bucketMs =
    timeframe * 60 * 1000;

  const groups = new Map();

  for (const candle of candles) {
    const time =
      new Date(candle.time).getTime();

    if (!Number.isFinite(time)) {
      continue;
    }

    const bucket =
      Math.floor(time / bucketMs) * bucketMs;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups.get(bucket).push(candle);
  }

  const result = [];

  for (const [bucket, rows] of groups) {
    rows.sort(
      (a, b) =>
        new Date(a.time).getTime() -
        new Date(b.time).getTime()
    );

    if (rows.length < timeframe) {
      continue;
    }

    const first = rows[0];
    const last = rows[rows.length - 1];

    result.push({
      time: new Date(bucket).toISOString(),
      open: first.open,
      high: Math.max(...rows.map(x => x.high)),
      low: Math.min(...rows.map(x => x.low)),
      close: last.close
    });
  }

  return result
    .sort(
      (a, b) =>
        new Date(a.time).getTime() -
        new Date(b.time).getTime()
    )
    .slice(-MAX_CANDLES);
}

/* =========================================================
   FRESHNESS
========================================================= */

function getLastCandle(candles) {
  return candles?.length
    ? candles[candles.length - 1]
    : null;
}

function getDataAgeSeconds(candles) {
  const last = getLastCandle(candles);

  if (!last) {
    return null;
  }

  const t =
    new Date(last.time).getTime();

  if (!Number.isFinite(t)) {
    return null;
  }

  return Math.max(
    0,
    Math.floor((nowMs() - t) / 1000)
  );
}

function getFreshness(timeframe, dataAgeSeconds) {
  if (dataAgeSeconds === null) {
    return 'NO_DATA';
  }

  if (dataAgeSeconds <= MAX_DATA_AGE_SECONDS[timeframe]) {
    return 'FRESH';
  }

  if (dataAgeSeconds <= HARD_STALE_SECONDS) {
    return 'STALE';
  }

  return 'HARD_STALE';
}

function isFreshEnough(timeframe, candles) {
  if (!candles || candles.length < MIN_CANDLES) {
    return false;
  }

  const age = getDataAgeSeconds(candles);

  return (
    age !== null &&
    age <= MAX_DATA_AGE_SECONDS[timeframe]
  );
}

/* =========================================================
   PAIR CACHE
========================================================= */

function setPairCache(pair, candles) {
  pairCache.set(pair, {
    pair,
    candles,
    fetchedAt: nowMs()
  });
}

function getPairCache(pair) {
  return pairCache.get(pair) || null;
}

function pairCacheTransportValid(entry) {
  if (!entry?.candles?.length) {
    return false;
  }

  return (
    nowMs() - entry.fetchedAt <
    PAIR_CACHE_TTL_MS
  );
}

function pairHasFreshTimeframe(entry) {
  if (!entry?.candles?.length) {
    return false;
  }

  return TIMEFRAMES.some(tf =>
    isFreshEnough(
      tf,
      aggregateCandles(
        entry.candles,
        tf
      )
    )
  );
}

async function loadPair(pair, forceRefresh = false) {
  const cached = getPairCache(pair);

  if (
    !forceRefresh &&
    cached &&
    pairCacheTransportValid(cached) &&
    pairHasFreshTimeframe(cached)
  ) {
    return cached.candles;
  }

  const candles =
    await requestTwelveData(pair);

  const completed =
    completedOneMinuteCandles(candles);

  if (completed.length < MIN_CANDLES) {
    throw new Error(
      `${pair}: not enough completed candles`
    );
  }

  setPairCache(pair, completed);

  return completed;
}

/* =========================================================
   INDICATORS
========================================================= */

function sma(values, period) {
  if (values.length < period) {
    return null;
  }

  const slice =
    values.slice(-period);

  return (
    slice.reduce(
      (sum, value) => sum + value,
      0
    ) / period
  );
}

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  let value =
    sma(values.slice(0, period), period);

  if (value === null) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    value =
      (values[i] - value) *
      multiplier +
      value;
  }

  return value;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] - values[i - 1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      ((avgGain * (period - 1)) + gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function trueRanges(candles) {
  const result = [];

  for (let i = 0; i < candles.length; i++) {
    const current = candles[i];

    if (i === 0) {
      result.push(
        current.high - current.low
      );
      continue;
    }

    const previous =
      candles[i - 1];

    result.push(
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

  return result;
}

function atr(candles, period = 14) {
  const tr =
    trueRanges(candles);

  return ema(tr, period);
}

function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) {
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

  if (trs.length < period) {
    return null;
  }

  let trAvg = sma(trs.slice(0, period), period);
  let plusAvg =
    sma(plusDM.slice(0, period), period);
  let minusAvg =
    sma(minusDM.slice(0, period), period);

  const dxValues = [];

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    if (i > period) {
      trAvg =
        ((trAvg * (period - 1)) + trs[i]) /
        period;

      plusAvg =
        ((plusAvg * (period - 1)) + plusDM[i]) /
        period;

      minusAvg =
        ((minusAvg * (period - 1)) + minusDM[i]) /
        period;
    }

    if (!trAvg) {
      continue;
    }

    const plusDI =
      100 * plusAvg / trAvg;

    const minusDI =
      100 * minusAvg / trAvg;

    const denominator =
      plusDI + minusDI;

    if (denominator === 0) {
      continue;
    }

    dxValues.push(
      100 *
      Math.abs(plusDI - minusDI) /
      denominator
    );
  }

  return ema(dxValues, period);
}

function stochastic(candles, period = 14) {
  if (candles.length < period) {
    return null;
  }

  const recent =
    candles.slice(-period);

  const highest =
    Math.max(...recent.map(x => x.high));

  const lowest =
    Math.min(...recent.map(x => x.low));

  const close =
    recent[recent.length - 1].close;

  if (highest === lowest) {
    return 50;
  }

  return (
    ((close - lowest) /
      (highest - lowest)) * 100
  );
}

function bollinger(candles, period = 20) {
  if (candles.length < period) {
    return null;
  }

  const closes =
    candles
      .slice(-period)
      .map(x => x.close);

  const middle =
    sma(closes, period);

  if (middle === null) {
    return null;
  }

  const variance =
    closes.reduce(
      (sum, value) =>
        sum + Math.pow(value - middle, 2),
      0
    ) / period;

  const deviation =
    Math.sqrt(variance);

  return {
    upper: middle + deviation * 2,
    middle,
    lower: middle - deviation * 2
  };
}

/* =========================================================
   PRICE ACTION
========================================================= */

function candlePattern(candles) {
  if (candles.length < 3) {
    return {
      label: 'INSUFFICIENT DATA',
      bias: 'NEUTRAL',
      strength: 0
    };
  }

  const c =
    candles[candles.length - 1];

  const p =
    candles[candles.length - 2];

  const body =
    Math.abs(c.close - c.open);

  const range =
    Math.max(
      c.high - c.low,
      Number.EPSILON
    );

  const upperWick =
    c.high - Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  const bullish =
    c.close > c.open;

  const bearish =
    c.close < c.open;

  if (
    bullish &&
    body / range >= 0.65
  ) {
    return {
      label: 'STRONG BULLISH CANDLE',
      bias: 'BULLISH',
      strength: 4
    };
  }

  if (
    bearish &&
    body / range >= 0.65
  ) {
    return {
      label: 'STRONG BEARISH CANDLE',
      bias: 'BEARISH',
      strength: 4
    };
  }

  if (
    lowerWick > body * 1.8 &&
    c.close > c.open
  ) {
    return {
      label: 'BULLISH REJECTION',
      bias: 'BULLISH',
      strength: 3
    };
  }

  if (
    upperWick > body * 1.8 &&
    c.close < c.open
  ) {
    return {
      label: 'BEARISH REJECTION',
      bias: 'BEARISH',
      strength: 3
    };
  }

  if (
    bullish &&
    p.close < p.open &&
    c.close > p.open
  ) {
    return {
      label: 'BULLISH REVERSAL',
      bias: 'BULLISH',
      strength: 3
    };
  }

  if (
    bearish &&
    p.close > p.open &&
    c.close < p.open
  ) {
    return {
      label: 'BEARISH REVERSAL',
      bias: 'BEARISH',
      strength: 3
    };
  }

  return {
    label: 'MIXED PRICE ACTION',
    bias: 'NEUTRAL',
    strength: 0
  };
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(candles) {
  const recent =
    candles.slice(-30);

  if (!recent.length) {
    return {
      support: null,
      resistance: null
    };
  }

  return {
    support:
      Math.min(...recent.map(x => x.low)),
    resistance:
      Math.max(...recent.map(x => x.high))
  };
}

/* =========================================================
   MARKET PSYCHOLOGY
========================================================= */

function marketPsychology(
  close,
  ema9Value,
  ema21Value,
  rsiValue
) {
  if (
    ema9Value === null ||
    ema21Value === null ||
    rsiValue === null
  ) {
    return {
      label: 'INSUFFICIENT DATA',
      bias: 'NEUTRAL',
      strength: 0
    };
  }

  if (
    ema9Value > ema21Value &&
    close > ema9Value &&
    rsiValue >= 55
  ) {
    return {
      label: 'BULLISH MOMENTUM',
      bias: 'BULLISH',
      strength: 8
    };
  }

  if (
    ema9Value < ema21Value &&
    close < ema9Value &&
    rsiValue <= 45
  ) {
    return {
      label: 'BEARISH MOMENTUM',
      bias: 'BEARISH',
      strength: 8
    };
  }

  if (
    ema9Value > ema21Value &&
    close > ema21Value
  ) {
    return {
      label: 'MILD BULLISH BIAS',
      bias: 'BULLISH',
      strength: 4
    };
  }

  if (
    ema9Value < ema21Value &&
    close < ema21Value
  ) {
    return {
      label: 'MILD BEARISH BIAS',
      bias: 'BEARISH',
      strength: 4
    };
  }

  return {
    label: 'NEUTRAL / MIXED',
    bias: 'NEUTRAL',
    strength: 0
  };
}

/* =========================================================
   ANALYSIS ENGINE
========================================================= */

function analyzeCandles(
  pair,
  timeframe,
  candles
) {
  if (
    !candles ||
    candles.length < MIN_CANDLES
  ) {
    return null;
  }

  const closes =
    candles.map(x => x.close);

  const current =
    candles[candles.length - 1];

  const currentPrice =
    current.close;

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
    bollinger(candles, 20);

  const pattern =
    candlePattern(candles);

  const sr =
    supportResistance(candles);

  const psychology =
    marketPsychology(
      currentPrice,
      ema9Value,
      ema21Value,
      rsiValue
    );

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  /* EMA */
  if (
    ema9Value !== null &&
    ema21Value !== null
  ) {
    if (ema9Value > ema21Value) {
      callScore += 18;
      reasons.push('EMA bullish');
    } else if (
      ema9Value < ema21Value
    ) {
      putScore += 18;
      reasons.push('EMA bearish');
    }
  }

  /* RSI */
  if (rsiValue !== null) {
    if (rsiValue >= 55 && rsiValue < 75) {
      callScore += 12;
      reasons.push('RSI supports CALL');
    } else if (
      rsiValue <= 45 &&
      rsiValue > 25
    ) {
      putScore += 12;
      reasons.push('RSI supports PUT');
    } else if (rsiValue >= 75) {
      putScore += 5;
      reasons.push('RSI overbought caution');
    } else if (rsiValue <= 25) {
      callScore += 5;
      reasons.push('RSI oversold rebound');
    }
  }

  /* ADX */
  if (
    adxValue !== null &&
    adxValue >= 20
  ) {
    if (ema9Value > ema21Value) {
      callScore += 10;
      reasons.push('ADX confirms trend');
    } else if (
      ema9Value < ema21Value
    ) {
      putScore += 10;
      reasons.push('ADX confirms trend');
    }
  }

  /* Stochastic */
  if (
    stochasticValue !== null &&
    ema9Value !== null &&
    ema21Value !== null
  ) {
    if (
      stochasticValue >= 50 &&
      stochasticValue <= 85 &&
      ema9Value > ema21Value
    ) {
      callScore += 8;
      reasons.push('Stochastic bullish');
    }

    if (
      stochasticValue <= 50 &&
      stochasticValue >= 15 &&
      ema9Value < ema21Value
    ) {
      putScore += 8;
      reasons.push('Stochastic bearish');
    }
  }

  /* Price action */
  if (pattern.bias === 'BULLISH') {
    callScore += pattern.strength;
    reasons.push(pattern.label);
  }

  if (pattern.bias === 'BEARISH') {
    putScore += pattern.strength;
    reasons.push(pattern.label);
  }

  /* Psychology */
  if (psychology.bias === 'BULLISH') {
    callScore += psychology.strength;
    reasons.push(psychology.label);
  }

  if (psychology.bias === 'BEARISH') {
    putScore += psychology.strength;
    reasons.push(psychology.label);
  }

  /* Bollinger */
  if (bb) {
    if (
      currentPrice > bb.middle &&
      currentPrice < bb.upper &&
      ema9Value > ema21Value
    ) {
      callScore += 3;
    }

    if (
      currentPrice < bb.middle &&
      currentPrice > bb.lower &&
      ema9Value < ema21Value
    ) {
      putScore += 3;
    }
  }

  /* Support / resistance */
  if (
    sr.support !== null &&
    sr.resistance !== null
  ) {
    const range =
      sr.resistance - sr.support;

    if (range > 0) {
      const location =
        (currentPrice - sr.support) /
        range;

      if (
        location <= 0.20 &&
        ema9Value > ema21Value
      ) {
        callScore += 3;
        reasons.push('Near support');
      }

      if (
        location >= 0.80 &&
        ema9Value < ema21Value
      ) {
        putScore += 3;
        reasons.push('Near resistance');
      }
    }
  }

  callScore =
    Math.round(clamp(callScore, 0, 100));

  putScore =
    Math.round(clamp(putScore, 0, 100));

  const winningScore =
    Math.max(callScore, putScore);

  const losingScore =
    Math.min(callScore, putScore);

  const gap =
    winningScore - losingScore;

  let signal = 'NO TRADE';

  if (
    winningScore >= 55 &&
    gap >= 12
  ) {
    signal =
      callScore > putScore
        ? 'CALL'
        : 'PUT';
  }

  let confidence = 40;

  if (signal !== 'NO TRADE') {
    confidence =
      Math.round(
        clamp(
          50 +
          winningScore * 0.40 +
          gap * 0.45,
          55,
          94
        )
      );
  } else {
    confidence =
      Math.round(
        clamp(
          35 + winningScore * 0.25,
          40,
          59
        )
      );
  }

  const dataAgeSeconds =
    getDataAgeSeconds(candles);

  const freshness =
    getFreshness(
      timeframe,
      dataAgeSeconds
    );

  let volatility = 'NORMAL';

  if (
    atrValue !== null &&
    currentPrice > 0
  ) {
    const atrPercent =
      (atrValue / currentPrice) * 100;

    if (atrPercent >= 0.15) {
      volatility = 'HIGH';
    } else if (atrPercent <= 0.03) {
      volatility = 'LOW';
    }
  }

  const entryTime =
    new Date(
      Math.ceil(
        nowMs() / 60000
      ) * 60000
    );

  const expiryTime =
    new Date(
      entryTime.getTime() +
      timeframe * 60000
    );

  const entryInSeconds =
    secondsFromNow(entryTime);

  return {
    pair,
    timeframe,
    signal,
    confidence,
    currentPrice,
    entryPrice: currentPrice,
    entryTime: entryTime.toISOString(),
    expiryTime: expiryTime.toISOString(),
    entryInSeconds,
    lastCandle: current.time,
    dataAgeSeconds,
    freshness,
    callScore,
    putScore,
    gap,
    volatility,
    indicators: {
      ema9: ema9Value,
      ema21: ema21Value,
      rsi14: rsiValue,
      adx14: adxValue,
      stochastic14: stochasticValue,
      atr14: atrValue,
      bollinger: bb
    },
    supportResistance: sr,
    priceAction: pattern.label,
    marketPsychology: psychology.label,
    reasons: [
      ...new Set(reasons)
    ].slice(0, 8)
  };
}

/* =========================================================
   MARKET RESULT
========================================================= */

function buildMarketResult(
  pair,
  timeframe,
  candles
) {
  const analysis =
    analyzeCandles(
      pair,
      timeframe,
      candles
    );

  if (!analysis) {
    return null;
  }

  if (
    analysis.freshness !== 'FRESH'
  ) {
    analysis.signal = 'NO TRADE';
    analysis.confidence = 40;
  }

  if (
    analysis.signal !== 'NO TRADE' &&
    analysis.entryInSeconds < MIN_ENTRY_SECONDS
  ) {
    analysis.signal = 'NO TRADE';
    analysis.confidence = 40;
    analysis.reasons = [
      'Entry window is too close'
    ];
  }

  return analysis;
}

/* =========================================================
   PAIR ANALYSIS
========================================================= */

function diagnosticRank(market) {
  if (!market) {
    return 99;
  }

  const order = {
    FRESH: 0,
    STALE: 1,
    HARD_STALE: 2,
    NO_DATA: 3
  };

  return order[market.freshness] ?? 99;
}

function compareMarkets(a, b) {
  const signalA =
    a.signal === 'CALL' ||
    a.signal === 'PUT';

  const signalB =
    b.signal === 'CALL' ||
    b.signal === 'PUT';

  if (signalA !== signalB) {
    return signalA ? -1 : 1;
  }

  if (a.freshness !== b.freshness) {
    return (
      diagnosticRank(a) -
      diagnosticRank(b)
    );
  }

  if (
    a.confidence !==
    b.confidence
  ) {
    return (
      b.confidence -
      a.confidence
    );
  }

  if (a.gap !== b.gap) {
    return b.gap - a.gap;
  }

  return (
    (a.dataAgeSeconds ?? 999999) -
    (b.dataAgeSeconds ?? 999999)
  );
}

async function analyzePair(
  pair,
  forceRefresh = false
) {
  const candles =
    await loadPair(
      pair,
      forceRefresh
    );

  const markets =
    TIMEFRAMES
      .map(tf => {
        const tfCandles =
          aggregateCandles(
            candles,
            tf
          );

        return buildMarketResult(
          pair,
          tf,
          tfCandles
        );
      })
      .filter(Boolean);

  if (!markets.length) {
    return null;
  }

  markets.sort(compareMarkets);

  return markets[0];
}

/* =========================================================
   RESULT CACHE
========================================================= */

function setResultCache(market) {
  if (!market?.pair) {
    return;
  }

  const key =
    `${market.pair}|${market.timeframe}`;

  resultCache.set(key, {
    market,
    storedAt: nowMs()
  });
}

function getValidResultCache() {
  const markets = [];

  for (
    const [key, entry]
    of resultCache.entries()
  ) {
    if (
      nowMs() - entry.storedAt >
      RESULT_CACHE_TTL_MS
    ) {
      resultCache.delete(key);
      continue;
    }

    const market =
      entry.market;

    if (
      market.freshness === 'FRESH' &&
      (
        market.signal === 'CALL' ||
        market.signal === 'PUT'
      ) &&
      market.entryInSeconds >=
        MIN_ENTRY_SECONDS
    ) {
      markets.push(market);
    }
  }

  markets.sort(compareMarkets);

  return markets;
}

/* =========================================================
   CACHE DIAGNOSTICS
========================================================= */

function cachedDiagnosticMarkets() {
  const markets = [];

  for (const pair of PAIRS) {
    const entry =
      getPairCache(pair);

    if (!entry?.candles?.length) {
      continue;
    }

    for (const tf of TIMEFRAMES) {
      const tfCandles =
        aggregateCandles(
          entry.candles,
          tf
        );

      const market =
        buildMarketResult(
          pair,
          tf,
          tfCandles
        );

      if (market) {
        markets.push(market);
      }
    }
  }

  markets.sort((a, b) => {
    const rank =
      diagnosticRank(a) -
      diagnosticRank(b);

    if (rank !== 0) {
      return rank;
    }

    return (
      (a.dataAgeSeconds ?? 999999) -
      (b.dataAgeSeconds ?? 999999)
    );
  });

  return markets;
}

/* =========================================================
   NO TRADE MARKET
========================================================= */

function noTradeMarket(
  diagnostic = null
) {
  if (diagnostic) {
    return {
      ...diagnostic,
      signal: 'NO TRADE',
      confidence: 40,
      entryPrice:
        diagnostic.currentPrice ?? null,
      reasons:
        diagnostic.reasons?.length
          ? diagnostic.reasons
          : [
              'No sufficiently fresh valid signal available'
            ]
    };
  }

  return {
    pair: null,
    timeframe: null,
    signal: 'NO TRADE',
    confidence: 40,
    currentPrice: null,
    entryPrice: null,
    entryTime: null,
    expiryTime: null,
    entryInSeconds: null,
    lastCandle: null,
    dataAgeSeconds: null,
    freshness: 'NO_DATA',
    callScore: 0,
    putScore: 0,
    gap: 0,
    volatility: 'UNKNOWN',
    indicators: {
      ema9: null,
      ema21: null,
      rsi14: null,
      adx14: null,
      stochastic14: null,
      atr14: null,
      bollinger: null
    },
    supportResistance: {
      support: null,
      resistance: null
    },
    priceAction: 'NO VALID SIGNAL',
    marketPsychology:
      'No sufficiently fresh market data',
    reasons: [
      'No sufficiently fresh valid signal available'
    ]
  };
}

/* =========================================================
   BEST MARKET
========================================================= */

function bestMarket() {
  const cached =
    getValidResultCache();

  if (cached.length) {
    return cached[0];
  }

  const diagnostics =
    cachedDiagnosticMarkets();

  if (diagnostics.length) {
    return noTradeMarket(
      diagnostics[0]
    );
  }

  return noTradeMarket();
}

/* =========================================================
   SCANNER
========================================================= */

async function scanBatch() {
  if (scanRunning) {
    return scanPromise;
  }

  scanRunning = true;

  scanPromise = (async () => {
    let batchError = null;

    try {
      const batch =
        [];

      for (
        let i = 0;
        i < SCAN_BATCH_SIZE;
        i++
      ) {
        if (!PAIRS.length) {
          break;
        }

        const index =
          (scanCursor + i) %
          PAIRS.length;

        batch.push(PAIRS[index]);
      }

      for (const pair of batch) {
        try {
          const cached =
            getPairCache(pair);

          const needsRefresh =
            !cached ||
            !pairCacheTransportValid(cached) ||
            !pairHasFreshTimeframe(cached);

          const market =
            await analyzePair(
              pair,
              needsRefresh
            );

          totalScanned += 1;

          if (market) {
            for (const tf of TIMEFRAMES) {
              const tfCandles =
                aggregateCandles(
                  getPairCache(pair).candles,
                  tf
                );

              const tfMarket =
                buildMarketResult(
                  pair,
                  tf,
                  tfCandles
                );

              if (
                tfMarket &&
                tfMarket.freshness === 'FRESH'
              ) {
                setResultCache(tfMarket);
              }
            }
          }
        } catch (error) {
          totalFailed += 1;

          batchError =
            `${pair}: ${error.message}`;

          lastScanError =
            batchError;
        }
      }

      scanCursor =
        (scanCursor + batch.length) %
        PAIRS.length;

      lastScanAt =
        new Date().toISOString();

      return true;
    } finally {
      scanRunning = false;
      scanPromise = null;
    }
  })();

  return scanPromise;
}

/* =========================================================
   WAIT FOR USEFUL MARKET
========================================================= */

async function ensureUsefulMarket() {
  const existing =
    getValidResultCache();

  if (existing.length) {
    return existing[0];
  }

  /*
   On cold start or after cache expiry, perform one
   synchronized batch and WAIT for it.

   This fixes the old behavior where /api/best
   returned NO TRADE immediately while the scan was
   still running.
  */
  try {
    await scanBatch();
  } catch (error) {
    lastScanError = error.message;
  }

  const afterScan =
    getValidResultCache();

  if (afterScan.length) {
    return afterScan[0];
  }

  return bestMarket();
}

/* =========================================================
   RESPONSE CONTRACT
========================================================= */

function makeResponse(selectedMarket) {
  resetDailyCounterIfNeeded();

  const rankedCandidates =
    getValidResultCache()
      .slice(0, 10)
      .map((market, index) => ({
        rank: index + 1,
        pair: market.pair,
        timeframe: market.timeframe,
        signal: market.signal,
        confidence: market.confidence,
        currentPrice: market.currentPrice,
        entryTime: market.entryTime,
        expiryTime: market.expiryTime,
        entryInSeconds: market.entryInSeconds,
        freshness: market.freshness,
        gap: market.gap
      }));

  return {
    ok: true,
    version: VERSION,
    source: SOURCE,
    timezone: TIMEZONE,

    selectedMarket:
      selectedMarket || noTradeMarket(),

    supportedTimeframes:
      TIMEFRAMES,

    pairs: PAIRS,

    metadata: {
      provider: SOURCE,
      interval: SOURCE_INTERVAL,

      providerRequests:
        providerRequestsThisMinute(),

      providerMinuteSafeLimit:
        PROVIDER_SAFE_LIMIT,

      providerMinuteHardLimit:
        PROVIDER_HARD_LIMIT,

      dailyCreditsUsed,

      dailyCreditsRemaining:
        dailyRequestsRemaining(),

      cachedPairs:
        pairCache.size,

      cachedResults:
        resultCache.size,

      resultCacheTtlSeconds:
        Math.floor(
          RESULT_CACHE_TTL_MS / 1000
        ),

      pairCacheTtlMinutes:
        Math.floor(
          PAIR_CACHE_TTL_MS /
          60000
        ),

      entryBufferSeconds:
        ENTRY_BUFFER_SECONDS,

      freshnessRules:
        MAX_DATA_AGE_SECONDS,

      hardStaleSeconds:
        HARD_STALE_SECONDS
    },

    scanner: {
      running: scanRunning,
      cursor: scanCursor,
      batchSize: SCAN_BATCH_SIZE,
      intervalSeconds:
        Math.floor(
          SCAN_EVERY_MS / 1000
        ),
      lastScanAt,
      lastScanError,
      totalScanned,
      totalFailed,
      totalApiRequests
    },

    rankedCandidates
  };
}

/* =========================================================
   ROUTES
========================================================= */

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'PO AI Predictor API',
    version: VERSION,
    source: SOURCE,
    timezone: TIMEZONE,
    endpoint: '/api/best'
  });
});

app.get('/api/health', async (req, res) => {
  try {
    const market =
      await ensureUsefulMarket();

    res.json(
      makeResponse(market)
    );
  } catch (error) {
    lastScanError =
      error.message;

    res.status(200).json(
      makeResponse(bestMarket())
    );
  }
});

app.get('/api/best', async (req, res) => {
  try {
    const market =
      await ensureUsefulMarket();

    res.status(200).json(
      makeResponse(market)
    );
  } catch (error) {
    lastScanError =
      error.message;

    res.status(200).json(
      makeResponse(bestMarket())
    );
  }
});

app.get('/api/analyze', async (req, res) => {
  const pair =
    String(
      req.query.pair || ''
    ).trim().toUpperCase();

  if (!pair) {
    return res.status(400).json({
      ok: false,
      version: VERSION,
      error: 'pair query parameter is required'
    });
  }

  if (!PAIRS.includes(pair)) {
    return res.status(400).json({
      ok: false,
      version: VERSION,
      error: 'Unsupported currency pair',
      supportedPairs: PAIRS
    });
  }

  try {
    const market =
      await analyzePair(
        pair,
        true
      );

    if (market) {
      for (const tf of TIMEFRAMES) {
        const entry =
          getPairCache(pair);

        if (!entry) {
          continue;
        }

        const tfCandles =
          aggregateCandles(
            entry.candles,
            tf
          );

        const tfMarket =
          buildMarketResult(
            pair,
            tf,
            tfCandles
          );

        if (
          tfMarket &&
          tfMarket.freshness === 'FRESH'
        ) {
          setResultCache(tfMarket);
        }
      }
    }

    res.status(200).json(
      makeResponse(
        market ||
        noTradeMarket()
      )
    );
  } catch (error) {
    lastScanError =
      `${pair}: ${error.message}`;

    res.status(200).json(
      makeResponse(
        bestMarket()
      )
    );
  }
});

app.get('/api/pairs', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,
    pairs: PAIRS,
    supportedTimeframes: TIMEFRAMES
  });
});

/* =========================================================
   BACKGROUND SCANNER
========================================================= */

setTimeout(() => {
  scanBatch().catch(error => {
    lastScanError =
      error.message;
  });
}, 5000);

setInterval(() => {
  if (!scanRunning) {
    scanBatch().catch(error => {
      lastScanError =
        error.message;
    });
  }
}, SCAN_EVERY_MS);

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
  console.log(
    `PO AI Predictor ${VERSION} listening on port ${PORT}`
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
    `Provider safe limit: ${PROVIDER_SAFE_LIMIT}/min`
  );

  console.log(
    `Daily usable limit: ${DAILY_MAX_USABLE}`
  );

  if (!API_KEY) {
    console.warn(
      'WARNING: Twelve Data API key is not configured.'
    );
  }
});
