'use strict';

/*
 * PO AI PREDICTOR — V10.7.0
 * LIVE FOREX ONLY. OTC is deliberately not supported.
 * Technical evidence engine; evidence score is NOT win probability.
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const VERSION = 'V10.7.0';
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PROVIDER_URL = 'https://api.twelvedata.com/time_series';

const PRIORITY_PAIRS = Object.freeze([
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF',
  'AUD/USD', 'USD/CAD', 'EUR/JPY', 'GBP/JPY'
]);

const BACKGROUND_PAIRS = Object.freeze([
  'NZD/USD', 'EUR/GBP', 'EUR/CHF', 'EUR/AUD',
  'EUR/CAD', 'GBP/CHF', 'GBP/AUD', 'GBP/CAD',
  'AUD/JPY', 'AUD/CAD', 'AUD/NZD', 'CAD/JPY',
  'CHF/JPY', 'NZD/JPY', 'NZD/CAD', 'EUR/NZD'
]);

const PAIRS = Object.freeze([...PRIORITY_PAIRS, ...BACKGROUND_PAIRS]);

const CFG = Object.freeze({
  outputsize: 500,
  minCandles: 60,
  freshnessMs: 150000,
  hardStaleMs: 300000,
  pairCacheMs: 90000,
  requestsPerMinute: 6,
  requestSpacingMs: 10000,
  providerTimeoutMs: 12000,
  dailyRequestLimit: 768,
  dailyReserve: 32,
  scannerDailyBudget: 576,
  scanIntervalMs: 60 * 60 * 1000,
  minScore: 50,
  minScoreGap: 10,
  maxOpposingScore: 35,
  brokerMaxAgeMs: 30000,
  brokerMaxGapPips: 3,
  backtestMinSamples: 30,
  historyLimit: 5000
});

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

const marketCache = new Map();
const history = [];
const pendingSignals = new Map();
const providerQueue = [];
const providerRequestTimes = [];

let providerWorkerRunning = false;
let lastProviderRequestAt = 0;
let dailyCounterDate = new Date().toISOString().slice(0, 10);
let dailyRequests = 0;
let scannerRequests = 0;
let dbReady = false;
let dbError = null;
let scanState = {
  running: false,
  startedAt: null,
  completedAt: null,
  currentPair: null,
  completedPairs: 0,
  successfulPairs: 0,
  failedPairs: 0,
  phase: 'WAITING',
  lastError: null,
  nextScanAt: null
};

const now = () => Date.now();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n, d = 5) => Number(Number(n).toFixed(d));
const isNum = n => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));
const num = n => isNum(n) ? Number(n) : null;
const iso = t => new Date(t).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalizePair = value => String(value || '').trim().toUpperCase().replace(/\s/g, '');
const validPair = pair => PAIRS.includes(normalizePair(pair));
const pipSize = pair => pair.endsWith('/JPY') ? 0.01 : 0.0001;
const pipGap = (pair, a, b) => Math.abs(Number(a) - Number(b)) / pipSize(pair);

function resetDailyCounterIfNeeded() {
  const date = new Date().toISOString().slice(0, 10);
  if (date !== dailyCounterDate) {
    dailyCounterDate = date;
    dailyRequests = 0;
    scannerRequests = 0;
    providerRequestTimes.length = 0;
  }
}

function metadata() {
  return {
    databaseReady: dbReady,
    databaseError: dbError,
    storage: dbReady ? 'POSTGRESQL' : 'MEMORY_ONLY',
    provider: 'TWELVE_DATA',
    configured: Boolean(API_KEY),
    dailyRequests,
    dailyRequestLimit: CFG.dailyRequestLimit - CFG.dailyReserve,
    scannerRequests,
    scannerDailyBudget: CFG.scannerDailyBudget
  };
}

function normalizeCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const parsed = [];

  for (const row of rows) {
    const closeTime = row.datetime || row.time || row.timestamp;
    let timestamp = typeof closeTime === 'number'
      ? closeTime
      : Date.parse(String(closeTime || ''));

    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < 1e12) timestamp *= 1000;

    const open = num(row.open);
    const high = num(row.high);
    const low = num(row.low);
    const close = num(row.close);
    const volume = num(row.volume) || 0;

    if ([open, high, low, close].some(v => v === null || v <= 0)) continue;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;

    parsed.push({
      timestamp,
      time: iso(timestamp),
      open,
      high,
      low,
      close,
      volume
    });
  }

  const unique = new Map();
  for (const candle of parsed) unique.set(candle.timestamp, candle);
  return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function enqueueProvider(task) {
  return new Promise((resolve, reject) => {
    providerQueue.push({ task, resolve, reject });
    processProviderQueue().catch(() => {});
  });
}

async function processProviderQueue() {
  if (providerWorkerRunning) return;
  providerWorkerRunning = true;

  try {
    while (providerQueue.length) {
      resetDailyCounterIfNeeded();

      const item = providerQueue[0];
      const current = now();

      while (
        providerRequestTimes.length &&
        current - providerRequestTimes[0] >= 60000
      ) {
        providerRequestTimes.shift();
      }

      const waitSpacing = Math.max(
        0,
        CFG.requestSpacingMs - (current - lastProviderRequestAt)
      );

      const waitMinute = providerRequestTimes.length >= CFG.requestsPerMinute
        ? Math.max(0, 60000 - (current - providerRequestTimes[0]))
        : 0;

      const wait = Math.max(waitSpacing, waitMinute);
      if (wait > 0) await sleep(wait);

      resetDailyCounterIfNeeded();

      if (dailyRequests >= CFG.dailyRequestLimit - CFG.dailyReserve) {
        providerQueue.shift();
        item.reject(new Error('DAILY_PROVIDER_BUDGET_EXHAUSTED'));
        continue;
      }

      providerQueue.shift();

      const requestAt = now();
      lastProviderRequestAt = requestAt;
      providerRequestTimes.push(requestAt);
      dailyRequests += 1;

      if (item.task.source === 'scanner') scannerRequests += 1;

      try {
        item.resolve(await item.task.run());
      } catch (error) {
        item.reject(error);
      }
    }
  } finally {
    providerWorkerRunning = false;
    if (providerQueue.length) processProviderQueue().catch(() => {});
  }
}

/*
 * beforeRequest runs AFTER queue waiting and immediately BEFORE the
 * provider request. This prevents an old Pocket Option quote from
 * becoming eligible merely because it waited in the provider queue.
 */
async function providerFetch(
  pair,
  source = 'manual',
  force = false,
  beforeRequest = null
) {
  if (!API_KEY) throw new Error('TWELVE_DATA_API_KEY_NOT_CONFIGURED');

  const cached = marketCache.get(pair);

  if (
    !force &&
    cached &&
    now() - cached.fetchedAt <= CFG.pairCacheMs &&
    cached.candles.length >= CFG.minCandles
  ) {
    return {
      candles: cached.candles,
      fetchedAt: cached.fetchedAt,
      source: 'CACHE'
    };
  }

  return enqueueProvider({
    source,
    run: async () => {
      if (typeof beforeRequest === 'function') beforeRequest();

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        CFG.providerTimeoutMs
      );

      try {
        const url = new URL(PROVIDER_URL);
        url.searchParams.set('symbol', pair);
        url.searchParams.set('interval', '1min');
        url.searchParams.set('outputsize', String(CFG.outputsize));
        url.searchParams.set('format', 'JSON');
        url.searchParams.set('timezone', 'UTC');
        url.searchParams.set('apikey', API_KEY);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' }
        });

        const data = await response.json();

        if (
          !response.ok ||
          data.status === 'error' ||
          data.code ||
          !Array.isArray(data.values)
        ) {
          throw new Error(
            data.message ||
            data.status ||
            `TWELVE_DATA_HTTP_${response.status}`
          );
        }

        const candles = normalizeCandles(data.values);

        if (candles.length < CFG.minCandles) {
          throw new Error(`INSUFFICIENT_CANDLES_${candles.length}`);
        }

        return {
          candles,
          fetchedAt: now(),
          source: 'TWELVE_DATA'
        };
      } catch (error) {
        if (error.name === 'AbortError') {
          throw new Error('TWELVE_DATA_TIMEOUT');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  });
}

function emaSeries(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  let current = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  const result = Array(period - 1).fill(null);
  result.push(current);

  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    result.push(current);
  }

  return result;
}

function calculateMacd(values) {
  if (values.length < 35) {
    return {
      line: null,
      signal: null,
      histogram: null,
      crossover: 'UNAVAILABLE'
    };
  }

  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);

  const line = values.map((_, i) =>
    fast[i] === null || slow[i] === null
      ? null
      : fast[i] - slow[i]
  );

  const compact = line.filter(v => v !== null);
  const signalSeries = emaSeries(compact, 9);

  const currentLine = line[line.length - 1];
  const previousLine = line[line.length - 2];
  const currentSignal = signalSeries[signalSeries.length - 1];
  const previousSignal = signalSeries[signalSeries.length - 2];

  let crossover = 'NEUTRAL';

  if (
    previousLine !== null &&
    previousSignal !== null &&
    currentLine > currentSignal &&
    previousLine <= previousSignal
  ) {
    crossover = 'BULLISH';
  } else if (
    previousLine !== null &&
    previousSignal !== null &&
    currentLine < currentSignal &&
    previousLine >= previousSignal
  ) {
    crossover = 'BEARISH';
  } else if (currentLine > currentSignal) {
    crossover = 'BULLISH';
  } else if (currentLine < currentSignal) {
    crossover = 'BEARISH';
  }

  return {
    line: currentLine,
    signal: currentSignal,
    histogram: currentLine - currentSignal,
    crossover
  };
}

function calculateAtr(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    trs.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateBollinger(values, period = 20, mult = 2) {
  if (values.length < period) {
    return {
      upper: null,
      middle: null,
      lower: null,
      width: null,
      position: 'UNAVAILABLE'
    };
  }

  const sample = values.slice(-period);
  const middle = sample.reduce((a, b) => a + b, 0) / period;
  const variance = sample.reduce(
    (a, b) => a + (b - middle) ** 2,
    0
  ) / period;

  const sd = Math.sqrt(variance);
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;
  const current = values[values.length - 1];

  return {
    upper,
    middle,
    lower,
    width: middle ? (upper - lower) / middle * 100 : null,
    position: current > upper
      ? 'ABOVE_UPPER'
      : current < lower
        ? 'BELOW_LOWER'
        : current >= middle
          ? 'UPPER_HALF'
          : 'LOWER_HALF'
  };
}

function detectCandlePattern(candles) {
  if (candles.length < 2) {
    return { name: 'NONE', direction: 'NEUTRAL', strength: 0 };
  }

  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, 1e-12);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;

  if (
    c.close > c.open &&
    p.close < p.open &&
    c.close >= p.open &&
    c.open <= p.close
  ) {
    return { name: 'BULLISH_ENGULFING', direction: 'BUY', strength: 2 };
  }

  if (
    c.close < c.open &&
    p.close > p.open &&
    c.open >= p.close &&
    c.close <= p.open
  ) {
    return { name: 'BEARISH_ENGULFING', direction: 'SELL', strength: 2 };
  }

  if (lowerWick > body * 2 && upperWick < body && c.close > c.open) {
    return { name: 'BULLISH_PIN_BAR', direction: 'BUY', strength: 1 };
  }

  if (upperWick > body * 2 && lowerWick < body && c.close < c.open) {
    return { name: 'BEARISH_PIN_BAR', direction: 'SELL', strength: 1 };
  }

  if (body / range > 0.72 && c.close > c.open) {
    return { name: 'BULLISH_MARUBOZU', direction: 'BUY', strength: 1 };
  }

  if (body / range > 0.72 && c.close < c.open) {
    return { name: 'BEARISH_MARUBOZU', direction: 'SELL', strength: 1 };
  }

  return { name: 'NO_CLEAR_PATTERN', direction: 'NEUTRAL', strength: 0 };
}

function detectRecentCross(candles) {
  const closes = candles.map(c => c.close);
  const e9 = emaSeries(closes, 9);
  const e21 = emaSeries(closes, 21);

  for (
    let i = closes.length - 1;
    i >= Math.max(1, closes.length - 4);
    i--
  ) {
    const p9 = e9[i - 1];
    const p21 = e21[i - 1];
    const c9 = e9[i];
    const c21 = e21[i];

    if ([p9, p21, c9, c21].some(v => v === null)) continue;

    if (p9 <= p21 && c9 > c21) {
      return {
        direction: 'BUY',
        barsAgo: closes.length - 1 - i,
        ema9: c9,
        ema21: c21
      };
    }

    if (p9 >= p21 && c9 < c21) {
      return {
        direction: 'SELL',
        barsAgo: closes.length - 1 - i,
        ema9: c9,
        ema21: c21
      };
    }
  }

  return {
    direction: 'NONE',
    barsAgo: null,
    ema9: e9[e9.length - 1],
    ema21: e21[e21.length - 1]
  };
}

function followThrough(candles, direction) {
  if (candles.length < 3) return false;

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, 1e-12);

  if (direction === 'BUY') {
    return (
      last.close > last.open &&
      last.close >= previous.close &&
      last.close >= last.low + range * 0.65 &&
      body / range >= 0.25
    );
  }

  if (direction === 'SELL') {
    return (
      last.close < last.open &&
      last.close <= previous.close &&
      last.close <= last.high - range * 0.65 &&
      body / range >= 0.25
    );
  }

  return false;
}

function supportResistance(candles) {
  const sample = candles.slice(-40);

  return {
    support: Math.min(...sample.map(c => c.low)),
    resistance: Math.max(...sample.map(c => c.high))
  };
}

function volatilityInfo(atr, price, bollinger) {
  const atrPercent = atr && price ? atr / price * 100 : null;
  const width = num(bollinger.width);

  let regime = 'NORMAL';

  if (
    (atrPercent !== null && atrPercent > 0.12) ||
    (width !== null && width > 0.65)
  ) {
    regime = 'HIGH';
  } else if (
    atrPercent !== null &&
    atrPercent < 0.025 &&
    width !== null &&
    width < 0.12
  ) {
    regime = 'LOW';
  }

  return {
    regime,
    atrPercent,
    bollingerWidth: width,
    riskAdjustment: regime === 'HIGH' ? -8 : regime === 'LOW' ? -2 : 0
  };
}
