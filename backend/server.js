'use strict';

/*
============================================================
 PO AI PREDICTOR
 Backend V8.6.3
 LIVE ONLY - Twelve Data

 ONE API CONTRACT
 Frontend uses:
   GET /api/best

 Main response:
 {
   ok: true,
   selectedMarket: {
      pair,
      timeframe,
      signal,
      confidence,
      currentPrice,
      entryTime,
      expiryTime,
      entryInSeconds,
      reason,
      marketCondition,
      indicators
   },
   markets: [],
   meta: {}
 }

 V8.6.3
 - MACD removed
 - CCI20 removed
 - EMA9 / EMA21
 - RSI14
 - ADX14
 - Stochastic
 - Support / Resistance
 - Candlestick patterns
 - Price-action market psychology
 - LIVE ONLY
 - Twelve Data only
 - Cache safe
 - Provider request budget <= 7 requests/minute
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
  process.env.TWELVEDATA_API_KEY ||
  '';

const VERSION = 'V8.6.3';
const SOURCE = 'Twelve Data LIVE';
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
 Twelve Data request budget.

 We intentionally keep provider requests below 7/minute.
 Each scan cycle processes only SCAN_BATCH_SIZE pairs.
 The cache keeps the results between cycles.
*/
const SCAN_BATCH_SIZE = 6;
const SCAN_EVERY_MS = 60 * 1000;

const CACHE_TTL_MS = 75 * 1000;

const ENTRY_BUFFER_SECONDS = 30;

const REQUEST_TIMEOUT_MS = 15000;

/* =========================================================
   STATE
========================================================= */

const pairCache = new Map();

let scanCursor = 0;
let scanRunning = false;
let lastScanAt = null;
let lastScanError = null;

let totalApiRequests = 0;
let totalScanned = 0;
let totalFailed = 0;

/* =========================================================
   BASIC HELPERS
========================================================= */

function nowMs() {
  return Date.now();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) return null;
  const p = Math.pow(10, decimals);
  return Math.round(value * p) / p;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================================
   CANDLE NORMALIZATION
========================================================= */

function normalizeCandle(row) {
  return {
    datetime: row.datetime,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume != null ? Number(row.volume) : null
  };
}

function validCandle(c) {
  return (
    c &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close)
  );
}

/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchCandles(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error('TWELVE_DATA_API_KEY is not configured');
  }

  const url =
    'https://api.twelvedata.com/time_series' +
    '?symbol=' +
    encodeURIComponent(pair) +
    '&interval=1min' +
    '&outputsize=' +
    MAX_CANDLES +
    '&order=asc' +
    '&apikey=' +
    encodeURIComponent(TWELVE_DATA_API_KEY);

  totalApiRequests++;

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json'
      }
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Twelve Data returned invalid JSON for ${pair}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Twelve Data HTTP ${response.status} for ${pair}`
      );
    }

    if (data.status === 'error') {
      throw new Error(
        data.message ||
        data.code ||
        `Twelve Data error for ${pair}`
      );
    }

    if (!Array.isArray(data.values)) {
      throw new Error(
        `No candle data returned for ${pair}`
      );
    }

    const candles = data.values
      .map(normalizeCandle)
      .filter(validCandle);

    if (candles.length < MIN_CANDLES) {
      throw new Error(
        `${pair}: insufficient candles (${candles.length})`
      );
    }

    return candles;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   ARRAY MATH
========================================================= */

function ema(values, period) {
  if (values.length < period) return [];

  const result = [];
  const multiplier = 2 / (period + 1);

  let previous = average(values.slice(0, period));

  result.push(previous);

  for (let i = period; i < values.length; i++) {
    previous =
      (values[i] - previous) * multiplier +
      previous;

    result.push(previous);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function trueRanges(candles) {
  const result = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    result.push(tr);
  }

  return result;
}

function atr(candles, period = 14) {
  const trs = trueRanges(candles);

  if (trs.length < period) return null;

  return average(
    trs.slice(trs.length - period)
  );
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

    let plus = 0;
    let minus = 0;

    if (upMove > downMove && upMove > 0) {
      plus = upMove;
    }

    if (downMove > upMove && downMove > 0) {
      minus = downMove;
    }

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
    plusDM.push(plus);
    minusDM.push(minus);
  }

  const dx = [];

  for (let i = period; i < trs.length; i++) {
    const trWindow =
      trs.slice(i - period + 1, i + 1);

    const plusWindow =
      plusDM.slice(i - period + 1, i + 1);

    const minusWindow =
      minusDM.slice(i - period + 1, i + 1);

    const trAvg = average(trWindow);

    if (!trAvg || trAvg === 0) continue;

    const plusDI =
      100 * sum(plusWindow) / (trAvg * period);

    const minusDI =
      100 * sum(minusWindow) / (trAvg * period);

    const denominator =
      plusDI + minusDI;

    if (denominator === 0) continue;

    const currentDX =
      100 *
      Math.abs(plusDI - minusDI) /
      denominator;

    dx.push(currentDX);
  }

  if (!dx.length) return null;

  return average(
    dx.slice(-period)
  );
}

function stochastic(candles, period = 14) {
  if (candles.length < period) return null;

  const recent =
    candles.slice(candles.length - period);

  const highest = Math.max(
    ...recent.map(c => c.high)
  );

  const lowest = Math.min(
    ...recent.map(c => c.low)
  );

  const close =
    candles[candles.length - 1].close;

  if (highest === lowest) return 50;

  return (
    ((close - lowest) /
      (highest - lowest)) *
    100
  );
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(candles, lookback = 30) {
  const recent =
    candles.slice(-lookback);

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
   CANDLESTICK PATTERNS
========================================================= */

function candlePattern(candles) {
  if (candles.length < 3) {
    return {
      pattern: 'NONE',
      bias: 'NEUTRAL'
    };
  }

  const a = candles[candles.length - 3];
  const b = candles[candles.length - 2];
  const c = candles[candles.length - 1];

  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;

  const upperWick =
    c.high - Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  if (range > 0) {
    if (
      lowerWick > body * 2 &&
      lowerWick > upperWick * 1.5 &&
      c.close >= c.open
    ) {
      return {
        pattern: 'BULLISH_REJECTION',
        bias: 'BULLISH'
      };
    }

    if (
      upperWick > body * 2 &&
      upperWick > lowerWick * 1.5 &&
      c.close <= c.open
    ) {
      return {
        pattern: 'BEARISH_REJECTION',
        bias: 'BEARISH'
      };
    }
  }

  const bBull = b.close > b.open;
  const bBear = b.close < b.open;

  const cBull = c.close > c.open;
  const cBear = c.close < c.open;

  if (
    bBear &&
    cBull &&
    c.open <= b.close &&
    c.close >= b.open
  ) {
    return {
      pattern: 'BULLISH_ENGULFING',
      bias: 'BULLISH'
    };
  }

  if (
    bBull &&
    cBear &&
    c.open >= b.close &&
    c.close <= b.open
  ) {
    return {
      pattern: 'BEARISH_ENGULFING',
      bias: 'BEARISH'
    };
  }

  if (
    cBull &&
    c.close > b.high &&
    b.close > a.high
  ) {
    return {
      pattern: 'BULLISH_BREAKOUT',
      bias: 'BULLISH'
    };
  }

  if (
    cBear &&
    c.close < b.low &&
    b.close < a.low
  ) {
    return {
      pattern: 'BEARISH_BREAKDOWN',
      bias: 'BEARISH'
    };
  }

  return {
    pattern: 'NONE',
    bias: 'NEUTRAL'
  };
}

/* =========================================================
   MARKET PSYCHOLOGY
========================================================= */

function marketPsychology(
  candles,
  ema9Value,
  ema21Value,
  rsiValue,
  adxValue
) {
  const last = candles[candles.length - 1];
  const previous =
    candles[candles.length - 2];

  const body =
    Math.abs(last.close - last.open);

  const range =
    last.high - last.low;

  const bodyRatio =
    range > 0 ? body / range : 0;

  const priceChange =
    previous.close !== 0
      ? ((last.close - previous.close) /
          previous.close) * 100
      : 0;

  let trend = 'NEUTRAL';

  if (
    ema9Value != null &&
    ema21Value != null
  ) {
    if (ema9Value > ema21Value) {
      trend = 'BULLISH';
    } else if (ema9Value < ema21Value) {
      trend = 'BEARISH';
    }
  }

  let behavior = 'BALANCED';

  if (bodyRatio > 0.65) {
    behavior =
      last.close > last.open
        ? 'BUYING_PRESSURE'
        : 'SELLING_PRESSURE';
  } else if (bodyRatio < 0.25) {
    behavior = 'INDECISION';
  }

  let condition = 'RANGING';

  if (adxValue != null) {
    if (adxValue >= 25) {
      condition = 'TRENDING';
    } else if (adxValue < 18) {
      condition = 'LOW_VOLATILITY_RANGE';
    } else {
      condition = 'RANGING';
    }
  }

  return {
    trend,
    behavior,
    condition,
    priceChangePct: round(priceChange, 5)
  };
}

/* =========================================================
   TIMEFRAME AGGREGATION
========================================================= */

function aggregateCandles(candles, minutes) {
  if (minutes === 1) {
    return candles.slice();
  }

  const result = [];

  let bucket = null;

  for (const candle of candles) {
    const time =
      new Date(candle.datetime).getTime();

    if (!Number.isFinite(time)) continue;

    const bucketMs =
      minutes * 60 * 1000;

    const bucketStart =
      Math.floor(time / bucketMs) *
      bucketMs;

    if (!bucket || bucket.time !== bucketStart) {
      bucket = {
        time: bucketStart,
        datetime: new Date(bucketStart).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      };

      result.push(bucket);
    } else {
      bucket.high =
        Math.max(bucket.high, candle.high);

      bucket.low =
        Math.min(bucket.low, candle.low);

      bucket.close =
        candle.close;

      if (
        Number.isFinite(candle.volume)
      ) {
        bucket.volume =
          (bucket.volume || 0) +
          candle.volume;
      }
    }
  }

  return result.map(c => ({
    datetime: c.datetime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume
  }));
}

/* =========================================================
   TIMEFRAME ANALYSIS
========================================================= */

function analyzeTimeframe(
  pair,
  candles,
  timeframe
) {
  const tfCandles =
    aggregateCandles(candles, timeframe);

  if (tfCandles.length < MIN_CANDLES / timeframe) {
    return null;
  }

  const closes =
    tfCandles.map(c => c.close);

  const ema9Series =
    ema(closes, 9);

  const ema21Series =
    ema(closes, 21);

  if (
    !ema9Series.length ||
    !ema21Series.length
  ) {
    return null;
  }

  const ema9Value =
    ema9Series[ema9Series.length - 1];

  const ema21Value =
    ema21Series[ema21Series.length - 1];

  const rsiValue =
    rsi(closes, 14);

  const adxValue =
    adx(tfCandles, 14);

  const stochasticValue =
    stochastic(tfCandles, 14);

  const atrValue =
    atr(tfCandles, 14);

  const sr =
    supportResistance(tfCandles, 30);

  const pattern =
    candlePattern(tfCandles);

  const psychology =
    marketPsychology(
      tfCandles,
      ema9Value,
      ema21Value,
      rsiValue,
      adxValue
    );

  const last =
    tfCandles[tfCandles.length - 1];

  const price =
    last.close;

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  /* EMA */

  if (ema9Value > ema21Value) {
    callScore += 22;
    reasons.push('EMA9 above EMA21');
  } else if (ema9Value < ema21Value) {
    putScore += 22;
    reasons.push('EMA9 below EMA21');
  }

  /* RSI */

  if (rsiValue != null) {
    if (
      rsiValue >= 52 &&
      rsiValue <= 70
    ) {
      callScore += 15;
      reasons.push('RSI bullish');
    } else if (
      rsiValue <= 48 &&
      rsiValue >= 30
    ) {
      putScore += 15;
      reasons.push('RSI bearish');
    } else if (rsiValue > 75) {
      putScore += 8;
      reasons.push('RSI overbought');
    } else if (rsiValue < 25) {
      callScore += 8;
      reasons.push('RSI oversold');
    }
  }

  /* ADX */

  if (adxValue != null) {
    if (adxValue >= 25) {
      callScore +=
        ema9Value > ema21Value ? 10 : 0;

      putScore +=
        ema9Value < ema21Value ? 10 : 0;

      reasons.push('ADX confirms trend');
    } else if (adxValue < 18) {
      reasons.push('Low trend strength');
    }
  }

  /* STOCHASTIC */

  if (stochasticValue != null) {
    if (
      stochasticValue >= 50 &&
      stochasticValue <= 85
    ) {
      callScore += 10;
      reasons.push('Stochastic bullish');
    } else if (
      stochasticValue <= 50 &&
      stochasticValue >= 15
    ) {
      putScore += 10;
      reasons.push('Stochastic bearish');
    }
  }

  /* SUPPORT / RESISTANCE */

  const range =
    sr.resistance - sr.support;

  if (range > 0) {
    const position =
      (price - sr.support) / range;

    if (position <= 0.30) {
      callScore += 8;
      reasons.push('Near support');
    }

    if (position >= 0.70) {
      putScore += 8;
      reasons.push('Near resistance');
    }
  }

  /* CANDLE PATTERN */

  if (pattern.bias === 'BULLISH') {
    callScore += 10;
    reasons.push(pattern.pattern);
  } else if (pattern.bias === 'BEARISH') {
    putScore += 10;
    reasons.push(pattern.pattern);
  }

  /* MARKET PSYCHOLOGY */

  if (
    psychology.behavior === 'BUYING_PRESSURE'
  ) {
    callScore += 7;
    reasons.push('Buying pressure');
  }

  if (
    psychology.behavior === 'SELLING_PRESSURE'
  ) {
    putScore += 7;
    reasons.push('Selling pressure');
  }

  /* =======================================================
     DECISION
  ======================================================= */

  const difference =
    Math.abs(callScore - putScore);

  let signal = 'NO TRADE';
  let confidence = 40;

  if (
    callScore >= 65 &&
    callScore > putScore &&
    difference >= 15
  ) {
    signal = 'CALL';

    confidence =
      70 +
      Math.round(
        ((callScore - 65) / 35) * 25
      );

    confidence =
      clamp(confidence, 70, 95);
  } else if (
    putScore >= 65 &&
    putScore > callScore &&
    difference >= 15
  ) {
    signal = 'PUT';

    confidence =
      70 +
      Math.round(
        ((putScore - 65) / 35) * 25
      );

    confidence =
      clamp(confidence, 70, 95);
  } else {
    confidence =
      40 +
      clamp(
        Math.round(difference / 2),
        0,
        29
      );
  }

  /* =======================================================
     ENTRY / EXPIRY
  ======================================================= */

  const now = Date.now();

  const tfMs =
    timeframe * 60 * 1000;

  /*
   Entry is the next timeframe boundary.
   This makes the signal usable before the next candle.
  */
  let entryMs =
    Math.floor(now / tfMs + 1) *
    tfMs;

  let entryInSeconds =
    Math.max(
      0,
      Math.floor(
        (entryMs - now) / 1000
      )
    );

  /*
   If entry is too close, use the following boundary.
  */
  if (
    entryInSeconds < ENTRY_BUFFER_SECONDS
  ) {
    entryMs += tfMs;

    entryInSeconds =
      Math.floor(
        (entryMs - now) / 1000
      );
  }

  const expiryMs =
    entryMs + tfMs;

  /*
   If there is no enough preparation time,
   do not issue a trade signal.
  */
  if (
    signal !== 'NO TRADE' &&
    entryInSeconds < ENTRY_BUFFER_SECONDS
  ) {
    signal = 'NO TRADE';
    confidence = 40;
  }

  const reason =
    signal === 'NO TRADE'
      ? 'Signals are not sufficiently aligned'
      : reasons.slice(0, 5).join(', ');

  return {
    pair,
    timeframe,
    signal,
    confidence,
    currentPrice: round(price, 6),

    entryTime: iso(entryMs),
    expiryTime: iso(expiryMs),
    entryInSeconds,

    reason,

    marketCondition:
      psychology.condition,

    indicators: {
      ema9: round(ema9Value, 6),
      ema21: round(ema21Value, 6),
      rsi14: round(rsiValue, 2),
      adx14: round(adxValue, 2),
      stochastic14: round(stochasticValue, 2),
      atr14: round(atrValue, 6),

      support: round(sr.support, 6),
      resistance: round(sr.resistance, 6),

      candlestickPattern:
        pattern.pattern,

      patternBias:
        pattern.bias,

      psychologyTrend:
        psychology.trend,

      psychologyBehavior:
        psychology.behavior,

      callScore,
      putScore,
      scoreDifference: difference
    },

    source: SOURCE,
    lastCandle:
      tfCandles[tfCandles.length - 1].datetime
  };
}

/* =========================================================
   FULL PAIR ANALYSIS
========================================================= */

function analyzePair(pair, candles) {
  const results = [];

  for (const timeframe of TIMEFRAMES) {
    const result =
      analyzeTimeframe(
        pair,
        candles,
        timeframe
      );

    if (result) {
      results.push(result);
    }
  }

  return results;
}

/* =========================================================
   RANKING
========================================================= */

function rankingScore(result) {
  if (!result) return -Infinity;

  let score =
    result.confidence;

  if (result.signal !== 'NO TRADE') {
    score += 25;
  }

  const adx =
    safeNumber(
      result.indicators &&
      result.indicators.adx14
    );

  if (adx != null) {
    score +=
      Math.min(adx, 40) * 0.2;
  }

  const difference =
    safeNumber(
      result.indicators &&
      result.indicators.scoreDifference
    );

  if (difference != null) {
    score +=
      Math.min(difference, 30) * 0.5;
  }

  return score;
}

function selectBest(results) {
  if (!results.length) return null;

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
   CACHE
========================================================= */

function savePairResult(
  pair,
  candles,
  results
) {
  const best =
    selectBest(results);

  pairCache.set(pair, {
    pair,
    candles,
    results,
    best,
    updatedAt: nowMs()
  });
}

function getCachedResults() {
  const all = [];

  for (const entry of pairCache.values()) {
    if (
      nowMs() - entry.updatedAt <=
      CACHE_TTL_MS
    ) {
      if (Array.isArray(entry.results)) {
        all.push(...entry.results);
      }
    }
  }

  return all;
}

/* =========================================================
   SCANNER
========================================================= */

async function scanBatch() {
  if (scanRunning) {
    return;
  }

  scanRunning = true;
  lastScanError = null;

  const batch = [];

  for (let i = 0; i < SCAN_BATCH_SIZE; i++) {
    const index =
      (scanCursor + i) %
      PAIRS.length;

    batch.push(PAIRS[index]);
  }

  scanCursor =
    (scanCursor + SCAN_BATCH_SIZE) %
    PAIRS.length;

  try {
    for (const pair of batch) {
      try {
        const candles =
          await fetchCandles(pair);

        const results =
          analyzePair(pair, candles);

        if (!results.length) {
          throw new Error(
            `${pair}: no valid timeframe analysis`
          );
        }

        savePairResult(
          pair,
          candles,
          results
        );

        totalScanned++;
      } catch (error) {
        totalFailed++;

        lastScanError =
          `${pair}: ${error.message}`;

        console.error(
          `[SCAN ERROR] ${lastScanError}`
        );
      }

      /*
       Small delay prevents bursty requests.
      */
      await sleep(250);
    }

    lastScanAt = iso(nowMs());
  } finally {
    scanRunning = false;
  }
}

/* =========================================================
   BEST MARKET
========================================================= */

function buildBestResponse() {
  const results =
    getCachedResults();

  const valid =
    results.filter(Boolean);

  const best =
    selectBest(valid);

  const markets =
    valid
      .slice()
      .sort(
        (a, b) =>
          rankingScore(b) -
          rankingScore(a)
      )
      .slice(0, 20);

  return {
    ok: true,

    selectedMarket: best || null,

    markets,

    meta: {
      version: VERSION,
      source: SOURCE,
      timezone: TIMEZONE,

      pairs: PAIRS.length,

      supportedTimeframes:
        TIMEFRAMES,

      cachedPairs:
        pairCache.size,

      cachedResults:
        valid.length,

      scanRunning,

      scanCursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      lastScanAt,

      lastScanError,

      totalScanned,

      totalFailed,

      totalApiRequests,

      apiBudget: {
        maxRequestsPerMinute: 7,
        batchSize: SCAN_BATCH_SIZE,
        strategy: 'cached-batch-scan'
      }
    }
  };
}

/* =========================================================
   ROUTES
========================================================= */

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'PO AI PREDICTOR',
    version: VERSION,
    source: SOURCE,
    endpoint: '/api/best'
  });
});

/* ---------------------------------------------------------
   HEALTH
--------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,
    timezone: TIMEZONE,

    pairs: PAIRS.length,

    supportedTimeframes:
      TIMEFRAMES,

    cachedPairs:
      pairCache.size,

    cachedResults:
      getCachedResults().length,

    scanRunning,

    scanCursor,

    scanBatchSize:
      SCAN_BATCH_SIZE,

    lastScanAt,

    lastScanError,

    totalScanned,

    totalFailed,

    totalApiRequests,

    apiKeyConfigured:
      Boolean(TWELVE_DATA_API_KEY),

    apiBudget: {
      maxRequestsPerMinute: 7,
      currentBatchSize:
        SCAN_BATCH_SIZE
    }
  });
});

/* ---------------------------------------------------------
   BEST
--------------------------------------------------------- */

app.get('/api/best', async (req, res) => {
  try {
    /*
     If no cache exists, perform one batch immediately.
     Later requests use cached results.
    */
    if (pairCache.size === 0) {
      await scanBatch();
    }

    /*
     Refresh if cache has become stale.
     The frontend does not need to know about this.
    */
    const hasFresh =
      Array.from(
        pairCache.values()
      ).some(
        entry =>
          nowMs() - entry.updatedAt <=
          CACHE_TTL_MS
      );

    if (!hasFresh && !scanRunning) {
      await scanBatch();
    }

    const response =
      buildBestResponse();

    res.json(response);
  } catch (error) {
    console.error(
      '[BEST ERROR]',
      error
    );

    res.status(500).json({
      ok: false,
      selectedMarket: null,
      markets: [],
      meta: {
        version: VERSION,
        source: SOURCE,
        error: error.message
      }
    });
  }
});

/* ---------------------------------------------------------
   ANALYZE
--------------------------------------------------------- */

app.get('/api/analyze', async (req, res) => {
  const pair =
    String(
      req.query.pair || ''
    ).trim();

  const timeframe =
    Number(
      req.query.timeframe || 1
    );

  if (!PAIRS.includes(pair)) {
    return res.status(400).json({
      ok: false,
      error: 'Unsupported pair',
      supportedPairs: PAIRS
    });
  }

  if (!TIMEFRAMES.includes(timeframe)) {
    return res.status(400).json({
      ok: false,
      error: 'Unsupported timeframe',
      supportedTimeframes:
        TIMEFRAMES
    });
  }

  try {
    const cached =
      pairCache.get(pair);

    if (
      !cached ||
      nowMs() - cached.updatedAt >
        CACHE_TTL_MS
    ) {
      await scanBatch();
    }

    const updated =
      pairCache.get(pair);

    if (!updated) {
      return res.status(503).json({
        ok: false,
        error:
          'Market data is not available yet'
      });
    }

    const result =
      updated.results.find(
        item =>
          item.timeframe ===
          timeframe
      );

    if (!result) {
      return res.status(503).json({
        ok: false,
        error:
          'Timeframe analysis unavailable'
      });
    }

    res.json({
      ok: true,
      selectedMarket: result,
      markets: [result],
      meta: {
        version: VERSION,
        source: SOURCE,
        timezone: TIMEZONE
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      selectedMarket: null,
      markets: [],
      meta: {
        version: VERSION,
        source: SOURCE,
        error: error.message
      }
    });
  }
});

/* ---------------------------------------------------------
   MANUAL SCAN
--------------------------------------------------------- */

app.post('/api/scan', async (req, res) => {
  if (scanRunning) {
    return res.json({
      ok: true,
      started: false,
      message: 'Scan already running',
      ...buildBestResponse()
    });
  }

  scanBatch()
    .catch(error => {
      console.error(
        '[MANUAL SCAN ERROR]',
        error
      );
    });

  res.json({
    ok: true,
    started: true,
    message: 'Scan started',
    ...buildBestResponse()
  });
});

/* =========================================================
   BACKGROUND SCANNER
========================================================= */

setTimeout(() => {
  scanBatch().catch(error => {
    console.error(
      '[INITIAL SCAN ERROR]',
      error
    );
  });
}, 3000);

setInterval(() => {
  scanBatch().catch(error => {
    console.error(
      '[SCHEDULED SCAN ERROR]',
      error
    );
  });
}, SCAN_EVERY_MS);

/* =========================================================
   SERVER
========================================================= */

app.listen(PORT, () => {
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
    `Timeframes: ${TIMEFRAMES.join(', ')}`
  );

  console.log(
    `Provider budget: <= 7 requests/minute`
  );

  console.log(
    `API: /api/best`
  );
});
