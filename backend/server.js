'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const VERSION = 'V10.3.0';
const PORT = Number(process.env.PORT || 10000);
const API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVE_DATA_KEY ||
  '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PROVIDER_URL = 'https://api.twelvedata.com/time_series';

const PRIORITY_PAIRS = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'USD/CHF',
  'AUD/USD',
  'USD/CAD'
];

const BACKGROUND_PAIRS = [
  'NZD/USD',
  'EUR/GBP',
  'EUR/JPY',
  'GBP/JPY',
  'EUR/CHF',
  'EUR/AUD',
  'EUR/CAD',
  'GBP/CHF',
  'GBP/AUD',
  'GBP/CAD',
  'AUD/JPY',
  'AUD/CAD',
  'AUD/NZD',
  'CAD/JPY',
  'CHF/JPY',
  'NZD/JPY',
  'NZD/CAD',
  'EUR/NZD'
];

const PAIRS = [...PRIORITY_PAIRS, ...BACKGROUND_PAIRS];

const DAILY_REQUEST_LIMIT = 768;
const DAILY_RESERVE = 32;
const DAILY_USABLE_LIMIT =
  DAILY_REQUEST_LIMIT - DAILY_RESERVE;

const REQUESTS_PER_MINUTE = 6;
const REQUEST_SPACING_MS = 10000;
const PROVIDER_TIMEOUT_MS = 12000;
const PAIR_CACHE_MS = 90000;

const FRESHNESS_SECONDS = 150;
const HARD_STALE_SECONDS = 300;
const SCAN_COOLDOWN_MS = 60000;

const MIN_CANDLES = 60;
const MIN_5M_CANDLES = 30;

const MIN_SIGNAL_SCORE = 55;
const MIN_SCORE_GAP = 12;
const MIN_OPPOSING_SCORE = 25;

const BROKER_PRICE_MAX_AGE_MS = 30000;
const DEFAULT_MAX_PRICE_GAP_PIPS = 3;

const BACKTEST_MIN_SIGNALS = 30;
const HISTORY_LIMIT = 5000;

const pairCache = new Map();
const inFlight = new Map();
const latestMarkets = new Map();

const signalHistory = [];
const signalKeys = new Set();

let pgPool = null;
let databaseReady = false;
let databaseError = null;

let providerRequests = 0;
let dailyCreditsUsed = 0;
let dailyDate = new Date().toISOString().slice(0, 10);

let requestTimes = [];
let lastProviderRequestAt = 0;
let requestQueue = Promise.resolve();

let scannerRunning = false;
let scannerStartedAt = null;
let lastScanAt = null;
let lastScanStartedAtMs = 0;
let totalScanned = 0;
let lastScanError = null;

let scanProgress = {
  phase: 'IDLE',
  completed: 0,
  total: 6,
  priorityCompleted: 0,
  priorityTotal: 6,
  backgroundCompleted: 0,
  backgroundTotal: 18,
  pair: null
};

const finite = value =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  Number.isFinite(Number(value));

const avg = values =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) /
      values.length
    : null;

const round = (value, digits = 6) =>
  finite(value)
    ? Number(Number(value).toFixed(digits))
    : null;

const iso = value =>
  Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

function normalizePair(value) {
  const pair = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s/g, '');

  return PAIRS.includes(pair) ? pair : null;
}

function pipSize(pair) {
  return pair.endsWith('/JPY') ? 0.01 : 0.0001;
}

function priceDifferencePips(pair, brokerPrice, referencePrice) {
  return Math.abs(brokerPrice - referencePrice) /
    pipSize(pair);
}

function resetDailyCounter() {
  const today = new Date().toISOString().slice(0, 10);

  if (today !== dailyDate) {
    dailyDate = today;
    dailyCreditsUsed = 0;
    requestTimes = [];
  }
}

function metadata() {
  resetDailyCounter();

  return {
    provider: 'Twelve Data LIVE',
    providerRequests,
    dailyCreditsUsed,
    dailyCreditsRemaining: Math.max(
      0,
      DAILY_USABLE_LIMIT - dailyCreditsUsed
    ),
    dailyRequestLimit: DAILY_REQUEST_LIMIT,
    dailyUsableLimit: DAILY_USABLE_LIMIT,
    requestsPerMinuteLimit: REQUESTS_PER_MINUTE,
    cachedPairs: pairCache.size,
    priorityPairs: PRIORITY_PAIRS.length,
    backgroundPairs: BACKGROUND_PAIRS.length,
    version: VERSION,
    storage: databaseReady
      ? 'POSTGRESQL'
      : 'MEMORY_ONLY',
    databaseConfigured: Boolean(DATABASE_URL),
    databaseReady,
    databaseError
  };
}

/* -------------------------------------------------------
   POSTGRESQL AND SIGNAL HISTORY
------------------------------------------------------- */

async function initializeDatabase() {
  if (!DATABASE_URL) return;

  try {
    const { Pool } = require('pg');

    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === 'disable'
        ? false
        : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS po_signal_history (
        id BIGSERIAL PRIMARY KEY,
        signal_key TEXT UNIQUE NOT NULL,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        evidence_score INTEGER,
        entry_time TIMESTAMPTZ,
        expiry_time TIMESTAMPTZ,
        reference_price DOUBLE PRECISION,
        broker_price DOUBLE PRECISION,
        outcome TEXT DEFAULT 'PENDING',
        outcome_price DOUBLE PRECISION,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        details JSONB DEFAULT '{}'::jsonb
      )
    `);

    await pgPool.query(`
      ALTER TABLE po_signal_history
      ADD COLUMN IF NOT EXISTS broker_price DOUBLE PRECISION
    `);

    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS
      po_signal_history_created_idx
      ON po_signal_history(created_at DESC)
    `);

    databaseReady = true;
    databaseError = null;
  } catch (error) {
    databaseReady = false;
    databaseError = String(error.message || error);
    console.error(
      'PostgreSQL initialization failed:',
      databaseError
    );
  }
}

async function saveSignal(record) {
  if (!record || !record.id || signalKeys.has(record.id)) {
    return;
  }

  signalKeys.add(record.id);
  signalHistory.unshift(record);

  if (signalHistory.length > HISTORY_LIMIT) {
    signalHistory.length = HISTORY_LIMIT;
  }

  if (!databaseReady || !pgPool) return;

  try {
    await pgPool.query(
      `INSERT INTO po_signal_history
      (
        signal_key,
        pair,
        direction,
        evidence_score,
        entry_time,
        expiry_time,
        reference_price,
        broker_price,
        outcome,
        details
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      ON CONFLICT(signal_key) DO NOTHING`,
      [
        record.id,
        record.pair,
        record.signal,
        record.evidenceScore,
        record.entryTime,
        record.expiryTime,
        record.referencePrice,
        record.brokerPrice,
        record.outcome || 'PENDING',
        JSON.stringify(record)
      ]
    );
  } catch (error) {
    databaseError = String(error.message || error);
  }
}

async function updateSignalOutcome(id, outcome, outcomePrice) {
  const record = signalHistory.find(item => item.id === id);

  if (record) {
    record.outcome = outcome;
    record.outcomePrice = outcomePrice;
    record.evaluatedAt = iso(Date.now());
  }

  if (!databaseReady || !pgPool) return;

  try {
    await pgPool.query(
      `UPDATE po_signal_history
       SET outcome=$2,
           outcome_price=$3,
           details=details || $4::jsonb
       WHERE signal_key=$1`,
      [
        id,
        outcome,
        outcomePrice,
        JSON.stringify({
          outcome,
          outcomePrice,
          evaluatedAt: iso(Date.now())
        })
      ]
    );
  } catch (error) {
    databaseError = String(error.message || error);
  }
}

async function getHistory(limit = 100) {
  const count = clamp(Number(limit) || 100, 1, 500);

  if (databaseReady && pgPool) {
    try {
      const result = await pgPool.query(
        `SELECT
          signal_key,
          pair,
          direction,
          evidence_score,
          entry_time,
          expiry_time,
          reference_price,
          broker_price,
          outcome,
          outcome_price,
          created_at,
          details
        FROM po_signal_history
        ORDER BY created_at DESC
        LIMIT $1`,
        [count]
      );

      return result.rows.map(row => ({
        ...row.details,
        id: row.signal_key,
        pair: row.pair,
        signal: row.direction,
        evidenceScore: row.evidence_score,
        entryTime: row.entry_time,
        expiryTime: row.expiry_time,
        referencePrice: row.reference_price,
        brokerPrice: row.broker_price,
        outcome: row.outcome,
        outcomePrice: row.outcome_price,
        createdAt: row.created_at
      }));
    } catch (error) {
      databaseError = String(error.message || error);
    }
  }

  return signalHistory.slice(0, count);
}

/* -------------------------------------------------------
   TWELVE DATA PROVIDER
------------------------------------------------------- */

function enqueueProviderRequest(task) {
  const promise = requestQueue.then(task, task);
  requestQueue = promise.catch(() => {});
  return promise;
}

async function providerFetch(pair) {
  return enqueueProviderRequest(async () => {
    if (!API_KEY) {
      throw new Error(
        'Twelve Data API key is not configured.'
      );
    }

    while (true) {
      resetDailyCounter();

      const now = Date.now();

      requestTimes = requestTimes.filter(
        time => now - time < 60000
      );

      if (dailyCreditsUsed >= DAILY_USABLE_LIMIT) {
        throw new Error(
          'Daily Twelve Data safety limit reached.'
        );
      }

      const minuteWait =
        requestTimes.length >= REQUESTS_PER_MINUTE
          ? Math.max(
              250,
              60000 - (now - requestTimes[0]) + 100
            )
          : 0;

      const spacingWait = Math.max(
        0,
        REQUEST_SPACING_MS -
          (now - lastProviderRequestAt)
      );

      const wait = Math.max(minuteWait, spacingWait);

      if (wait > 0) {
        await sleep(wait);
        continue;
      }

      break;
    }

    const url = new URL(PROVIDER_URL);

    url.searchParams.set('symbol', pair);
    url.searchParams.set('interval', '1min');
    url.searchParams.set('outputsize', '500');
    url.searchParams.set('timezone', 'UTC');
    url.searchParams.set('apikey', API_KEY);

    const sentAt = Date.now();

    lastProviderRequestAt = sentAt;
    requestTimes.push(sentAt);
    providerRequests++;
    dailyCreditsUsed++;

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      PROVIDER_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });

      if (!response.ok) {
        throw new Error(
          `Twelve Data HTTP ${response.status}.`
        );
      }

      const json = await response.json();

      if (
        json.status === 'error' ||
        json.code ||
        !Array.isArray(json.values)
      ) {
        throw new Error(
          json.message ||
          'Provider returned no candle values.'
        );
      }

      const candles = normalizeCandles(json.values);

      if (!candles.length) {
        throw new Error(
          'No valid candles returned by Twelve Data.'
        );
      }

      return {
        candles,
        fetchedAt: Date.now(),
        source: 'Twelve Data LIVE'
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(
          'Twelve Data request timed out.'
        );
      }

      throw new Error(
        error.message || 'Twelve Data request failed.'
      );
    } finally {
      clearTimeout(timer);
    }
  });
}

function normalizeCandles(rows) {
  const byTime = new Map();

  for (const row of rows) {
    const raw = String(
      row.datetime || row.time || ''
    ).trim();

    const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);

    const time = Date.parse(
      raw && !zoned
        ? `${raw.replace(' ', 'T')}Z`
        : raw
    );

    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);

    if (
      !Number.isFinite(time) ||
      ![open, high, low, close].every(Number.isFinite)
    ) {
      continue;
    }

    if (
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high)
    ) {
      continue;
    }

    byTime.set(time, {
      time,
      open,
      high,
      low,
      close
    });
  }

  return [...byTime.values()]
    .sort((a, b) => a.time - b.time);
}

async function getPairData(pair, force = false) {
  const cached = pairCache.get(pair);

  if (
    !force &&
    cached &&
    Date.now() - cached.fetchedAt < PAIR_CACHE_MS
  ) {
    return cached;
  }

  if (inFlight.has(pair)) {
    return inFlight.get(pair);
  }

  const promise = providerFetch(pair)
    .then(data => {
      pairCache.set(pair, data);
      return data;
    })
    .finally(() => inFlight.delete(pair));

  inFlight.set(pair, promise);

  return promise;
}

function closedCandles(candles, now = Date.now()) {
  return candles.filter(
    candle => candle.time + 60000 <= now
  );
}

function hasContinuousMinutes(candles) {
  if (candles.length < 2) return true;

  for (let i = 1; i < candles.length; i++) {
    if (
      candles[i].time - candles[i - 1].time !== 60000
    ) {
      return false;
    }
  }

  return true;
}

/* -------------------------------------------------------
   TECHNICAL INDICATORS
------------------------------------------------------- */

function ema(values, period) {
  const output = Array(values.length).fill(null);

  if (values.length < period) return output;

  let value = avg(values.slice(0, period));

  output[period - 1] = value;

  const alpha = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value =
      values[i] * alpha +
      value * (1 - alpha);

    output[i] = value;
  }

  return output;
}

function rsi(values, period = 14) {
  const output = Array(values.length).fill(null);

  if (values.length <= period) return output;

  let gains = 0;
  let losses = 0;  for (let i = 1; i <= period; i++) {
    const difference = values[i] - values[i - 1];

    gains += Math.max(difference, 0);
    losses += Math.max(-difference, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  const calculate = () =>
    averageLoss === 0
      ? averageGain === 0
        ? 50
        : 100
      : 100 - 100 / (1 + averageGain / averageLoss);

  output[period] = calculate();

  for (let i = period + 1; i < values.length; i++) {
    const difference = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) +
        Math.max(difference, 0)) / period;

    averageLoss =
      (averageLoss * (period - 1) +
        Math.max(-difference, 0)) / period;

    output[i] = calculate();
  }

  return output;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);

  const line = values.map((_, index) =>
    finite(fast[index]) && finite(slow[index])
      ? fast[index] - slow[index]
      : null
  );

  const compact = ema(line.filter(finite), 9);
  const signal = Array(values.length).fill(null);

  let cursor = 0;

  for (let i = 0; i < line.length; i++) {
    if (finite(line[i])) {
      signal[i] = compact[cursor++];
    }
  }

  return {
    line,
    signal,
    histogram: line.map((value, index) =>
      finite(value) && finite(signal[index])
        ? value - signal[index]
        : null
    )
  };
}

function atr(candles, period = 14) {
  const trueRanges = Array(candles.length).fill(null);

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const previousClose = candles[i - 1].close;

    trueRanges[i] = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  }

  const output = Array(candles.length).fill(null);

  if (candles.length <= period) return output;

  let value = avg(trueRanges.slice(1, period + 1));

  output[period] = value;

  for (let i = period + 1; i < candles.length; i++) {
    value =
      (value * (period - 1) + trueRanges[i]) / period;

    output[i] = value;
  }

  return output;
}

function bollinger(values, period = 20, multiplier = 2) {
  const upper = Array(values.length).fill(null);
  const middle = Array(values.length).fill(null);
  const lower = Array(values.length).fill(null);
  const width = Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    const sample = values.slice(i - period + 1, i + 1);
    const mean = avg(sample);

    const deviation = Math.sqrt(
      avg(sample.map(value => (value - mean) ** 2))
    );

    middle[i] = mean;
    upper[i] = mean + multiplier * deviation;
    lower[i] = mean - multiplier * deviation;

    width[i] = mean
      ? ((upper[i] - lower[i]) / mean) * 100
      : null;
  }

  return { upper, middle, lower, width };
}

function cross(a0, b0, a1, b1) {
  if (![a0, b0, a1, b1].every(finite)) {
    return 'UNAVAILABLE';
  }

  if (a0 <= b0 && a1 > b1) {
    return 'BULLISH_CROSSOVER';
  }

  if (a0 >= b0 && a1 < b1) {
    return 'BEARISH_CROSSOVER';
  }

  return 'NO_CROSSOVER';
}

function aggregate5m(candles, now = Date.now()) {
  const groups = new Map();

  for (const candle of candles) {
    const start =
      Math.floor(candle.time / 300000) * 300000;

    let group = groups.get(start);

    if (!group) {
      group = {
        time: start,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        count: 1,
        lastTime: candle.time
      };

      groups.set(start, group);
    } else {
      group.high = Math.max(group.high, candle.high);
      group.low = Math.min(group.low, candle.low);
      group.close = candle.close;
      group.count++;
      group.lastTime = candle.time;
    }
  }

  return [...groups.values()]
    .filter(group =>
      group.count === 5 &&
      group.lastTime === group.time + 240000 &&
      group.time + 300000 <= now
    )
    .map(({ count, lastTime, ...group }) => group)
    .sort((a, b) => a.time - b.time);
}

function confirm5m(candles) {
  const five = aggregate5m(candles);

  if (five.length < MIN_5M_CANDLES) {
    return {
      status: 'UNAVAILABLE',
      direction: 'NEUTRAL',
      candles: five.length,
      required: MIN_5M_CANDLES,
      reason:
        'Not enough complete 5-minute candles.'
    };
  }

  const closes = five.map(candle => candle.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const index = closes.length - 1;

  const direction =
    fast[index] > slow[index]
      ? 'BULLISH'
      : fast[index] < slow[index]
        ? 'BEARISH'
        : 'NEUTRAL';

  return {
    status: direction === 'NEUTRAL'
      ? 'MIXED'
      : 'CONFIRMED',
    direction,
    ema9: round(fast[index]),
    ema21: round(slow[index]),
    candles: five.length,
    lastCandle: iso(five[index].time),
    reason: `5-minute EMA9/EMA21 trend is ${direction}.`
  };
}

function candlePattern(candles) {
  if (candles.length < 3) {
    return {
      name: 'INSUFFICIENT CANDLES',
      direction: 'NEUTRAL'
    };
  }

  const current = candles.at(-1);
  const previous = candles.at(-2);
  const previous2 = candles.at(-3);

  const body = Math.abs(current.close - current.open);
  const range = Math.max(
    current.high - current.low,
    Number.EPSILON
  );

  const upperWick =
    current.high - Math.max(current.open, current.close);

  const lowerWick =
    Math.min(current.open, current.close) - current.low;

  const ratio = body / range;

  const bullish = current.close > current.open;
  const bearish = current.close < current.open;

  const previousBullish =
    previous.close > previous.open;

  const previousBearish =
    previous.close < previous.open;

  if (
    previousBearish &&
    bullish &&
    current.open <= previous.close &&
    current.close >= previous.open
  ) {
    return {
      name: 'BULLISH ENGULFING',
      direction: 'BULLISH'
    };
  }

  if (
    previousBullish &&
    bearish &&
    current.open >= previous.close &&
    current.close <= previous.open
  ) {
    return {
      name: 'BEARISH ENGULFING',
      direction: 'BEARISH'
    };
  }

  if (
    ratio <= 0.35 &&
    lowerWick >= body * 2 &&
    upperWick <= Math.max(body * 0.7, range * 0.05)
  ) {
    return {
      name: 'HAMMER',
      direction: 'POTENTIAL BULLISH'
    };
  }

  if (
    ratio <= 0.35 &&
    upperWick >= body * 2 &&
    lowerWick <= Math.max(body * 0.7, range * 0.05)
  ) {
    return {
      name: 'SHOOTING STAR',
      direction: 'POTENTIAL BEARISH'
    };
  }

  if (
    previous2.close < previous2.open &&
    Math.abs(previous.close - previous.open) <
      Math.abs(previous2.close - previous2.open) * 0.4 &&
    bullish &&
    current.close >
      (previous2.open + previous2.close) / 2
  ) {
    return {
      name: 'MORNING STAR',
      direction: 'BULLISH'
    };
  }

  if (
    previous2.close > previous2.open &&
    Math.abs(previous.close - previous.open) <
      Math.abs(previous2.close - previous2.open) * 0.4 &&
    bearish &&
    current.close <
      (previous2.open + previous2.close) / 2
  ) {
    return {
      name: 'EVENING STAR',
      direction: 'BEARISH'
    };
  }

  if (ratio < 0.08) {
    return {
      name: 'DOJI',
      direction: 'NEUTRAL'
    };
  }

  if (ratio > 0.9 && upperWick < range * 0.05 &&
      lowerWick < range * 0.05) {
    return {
      name: bullish
        ? 'BULLISH MARUBOZU'
        : 'BEARISH MARUBOZU',
      direction: bullish ? 'BULLISH' : 'BEARISH'
    };
  }

  return {
    name: bullish
      ? 'BULLISH CANDLE'
      : bearish
        ? 'BEARISH CANDLE'
        : 'NO CLEAR PATTERN',
    direction: bullish
      ? 'BULLISH'
      : bearish
        ? 'BEARISH'
        : 'NEUTRAL'
  };
}

function psychology(candles) {
  const recent = candles.slice(-8);

  if (recent.length < 7) {
    return {
      psychology: 'INSUFFICIENT PRICE EVIDENCE',
      direction: 'NEUTRAL',
      buyerPressure: 0,
      sellerPressure: 0
    };
  }

  let up = 0;
  let down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) up++;
    if (recent[i].close < recent[i - 1].close) down++;
  }

  const last = recent.at(-1);

  const location =
    (last.close - last.low) /
    Math.max(last.high - last.low, 1e-12);

  if (up >= 5 && location >= 0.65) {
    return {
      psychology: 'BUYERS SHOWING RECENT CONTROL',
      direction: 'BULLISH',
      buyerPressure: up,
      sellerPressure: down
    };
  }

  if (down >= 5 && location <= 0.35) {
    return {
      psychology: 'SELLERS SHOWING RECENT CONTROL',
      direction: 'BEARISH',
      buyerPressure: up,
      sellerPressure: down
    };
  }

  return {
    psychology: 'MIXED BUYER/SELLER PRESSURE',
    direction: 'NEUTRAL',
    buyerPressure: up,
    sellerPressure: down
  };
}

function trendline(candles) {
  const sample = candles.slice(-30);

  if (sample.length < 15) {
    return {
      direction: 'UNAVAILABLE',
      slopePercent: null,
      description: 'Not enough candles for trendline.'
    };
  }

  const xs = sample.map((_, index) => index);
  const ys = sample.map(candle => candle.close);

  const meanX = avg(xs);
  const meanY = avg(ys);

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < sample.length; i++) {
    numerator +=
      (xs[i] - meanX) * (ys[i] - meanY);

    denominator += (xs[i] - meanX) ** 2;
  }

  const slope = denominator
    ? numerator / denominator
    : 0;

  const slopePercent =
    meanY ? slope / meanY * 100 : 0;

  const direction =
    slopePercent > 0.002
      ? 'BULLISH'
      : slopePercent < -0.002
        ? 'BEARISH'
        : 'SIDEWAYS';

  return {
    direction,
    slopePercent: round(slopePercent, 6),
    description: `30-candle regression trend: ${direction}.`
  };
}

function levels(candles) {
  const previous = candles.slice(-31, -1);

  if (previous.length < 15) {
    return {
      support: null,
      resistance: null,
      position: 'UNAVAILABLE',
      direction: 'NEUTRAL'
    };
  }

  const support = Math.min(
    ...previous.map(candle => candle.low)
  );

  const resistance = Math.max(
    ...previous.map(candle => candle.high)
  );

  const current = candles.at(-1);
  const range = Math.max(
    current.high - current.low,
    1e-12
  );

  let position = 'BETWEEN LEVELS';
  let direction = 'NEUTRAL';

  if (current.close > resistance) {
    position = 'CLOSED-CANDLE RESISTANCE BREAKOUT';
    direction = 'BULLISH';
  } else if (current.close < support) {
    position = 'CLOSED-CANDLE SUPPORT BREAKDOWN';
    direction = 'BEARISH';
  } else if (
    current.low <= support + range * 0.15 &&
    current.close > current.open
  ) {
    position = 'POSSIBLE SUPPORT REJECTION';
    direction = 'BULLISH';
  } else if (
    current.high >= resistance - range * 0.15 &&
    current.close < current.open
  ) {
    position = 'POSSIBLE RESISTANCE REJECTION';
    direction = 'BEARISH';
  }

  return {
    support: round(support),
    resistance: round(resistance),
    position,
    direction,
    distanceToSupportPercent:
      round((current.close - support) / current.close * 100, 5),
    distanceToResistancePercent:
      round((resistance - current.close) / current.close * 100, 5)
  };
}

function breakout(candles) {
  if (candles.length < 8) {
    return {
      status: 'UNAVAILABLE',
      direction: 'NEUTRAL',
      description: 'Insufficient range history.'
    };
  }

  const current = candles.at(-1);
  const previous = candles.at(-2);
  const prior = candles.slice(-7, -2);

  const high = Math.max(...prior.map(item => item.high));
  const low = Math.min(...prior.map(item => item.low));

  if (previous.close <= high && current.close > high) {
    return {
      status: 'BREAKOUT',
      direction: 'BULLISH',
      level: round(high),
      description: 'Completed candle closed above prior range.'
    };
  }

  if (previous.close >= low && current.close < low) {
    return {
      status: 'BREAKDOWN',
      direction: 'BEARISH',
      level: round(low),
      description: 'Completed candle closed below prior range.'
    };
  }

  if (
    previous.close > high &&
    current.low <= high &&
    current.close > high
  ) {
    return {
      status: 'BULLISH_RETEST',
      direction: 'BULLISH',
      level: round(high),
      description: 'Retest held above breakout level.'
    };
  }

  if (
    previous.close < low &&
    current.high >= low &&
    current.close < low
  ) {
    return {
      status: 'BEARISH_RETEST',
      direction: 'BEARISH',
      level: round(low),
      description: 'Retest held below breakdown level.'
    };
  }

  if (previous.close > high && current.close < high) {
    return {
      status: 'FALSE_BULLISH_BREAKOUT',
      direction: 'BEARISH',
      level: round(high),
      description: 'Price returned inside range after upside break.'
    };
  }

  if (previous.close < low && current.close > low) {
    return {
      status: 'FALSE_BEARISH_BREAKOUT',
      direction: 'BULLISH',
      level: round(low),
      description: 'Price returned inside range after downside break.'
    };
  }

  return {
    status: 'NO_CONFIRMED_BREAKOUT',
    direction: 'NEUTRAL',
    description: 'No confirmed breakout/retest.'
  };
}

function volatility(atrValues, widths, candles) {
  const index = atrValues.length - 1;
  const atrValue = atrValues[index];
  const close = candles[index]?.close;

  const atrPercent =
    finite(atrValue) && close
      ? atrValue / close * 100
      : null;

  const width = widths[index];
  const valid = widths.filter(finite);

  if (
    !finite(atrPercent) ||
    !finite(width) ||
    valid.length < 30
  ) {
    return {
      regime: 'UNAVAILABLE',
      atr: round(atrValue),
      atrPercent: round(atrPercent, 5),
      bollingerWidth: round(width, 5)
    };
  }

  const sorted = [...valid].sort((a, b) => a - b);

  const low = sorted[
    Math.floor((sorted.length - 1) * 0.25)
  ];

  const high = sorted[
    Math.floor((sorted.length - 1) * 0.75)
  ];

  const regime =
    width <= low
      ? 'LOW'
      : width >= high
        ? 'HIGH'
        : 'NORMAL';

  return {
    regime,
    atr: round(atrValue),
    atrPercent: round(atrPercent, 5),
    bollingerWidth: round(width, 5),
    lowWidthThreshold: round(low, 5),
    highWidthThreshold: round(high, 5)
  };
}/* -------------------------------------------------------
   MARKET ANALYSIS AND SIGNAL QUALIFICATION
------------------------------------------------------- */

function emptyMarket(
  pair = 'NO MARKET',
  reason = 'No usable market data.'
) {
  return {
    pair,
    timeframe: 1,
    signal: 'NO TRADE',
    technicalSignal: 'NO TRADE',
    confidence: null,
    callScore: 0,
    putScore: 0,
    gap: 0,
    entryTime: null,
    expiryTime: null,
    currentPrice: null,
    entryPrice: null,
    entryPriceStatus: 'WAITING_FOR_ENTRY_PRICE',
    freshness: 'NO DATA',
    dataAgeSeconds: null,
    lastCandle: null,
    indicators: {},
    reasons: [reason],
    source: 'Twelve Data LIVE',
    evidenceLabel: 'Evidence score, not win probability',
    insufficientData: true,
    tradeAllowed: false,
    noTrade: true
  };
}

function scoreMarket(raw, pair, fetchedAt) {
  const now = Date.now();
  const candles = closedCandles(raw, now);
  const last = candles.at(-1);

  if (!last) {
    return emptyMarket(
      pair,
      'No completed 1-minute candles.'
    );
  }

  const age = Math.max(
    0,
    (now - (last.time + 60000)) / 1000
  );

  const freshness =
    age <= FRESHNESS_SECONDS
      ? 'FRESH'
      : age <= HARD_STALE_SECONDS
        ? 'STALE'
        : 'HARD STALE';

  const closes = candles.map(candle => candle.close);
  const index = candles.length - 1;
  const previousIndex = index - 1;

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsi14 = rsi(closes);
  const macdValues = macd(closes);
  const atr14 = atr(candles);
  const bands = bollinger(closes);

  const emaCross = cross(
    ema9[previousIndex],
    ema21[previousIndex],
    ema9[index],
    ema21[index]
  );

  const macdCross = cross(
    macdValues.line[previousIndex],
    macdValues.signal[previousIndex],
    macdValues.line[index],
    macdValues.signal[index]
  );

  const pattern = candlePattern(candles);
  const marketPsychology = psychology(candles);
  const supportResistance = levels(candles);
  const trendLine = trendline(candles);
  const breakoutResult = breakout(candles);
  const confirmation5m = confirm5m(candles);
  const volatilityResult = volatility(
    atr14,
    bands.width,
    candles
  );

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  function add(direction, points, reason) {
    if (direction === 'BULLISH') {
      callScore += points;
    }

    if (direction === 'BEARISH') {
      putScore += points;
    }

    if (
      direction !== 'NEUTRAL' &&
      direction !== 'UNAVAILABLE' &&
      points > 0
    ) {
      reasons.push(reason);
    }
  }

  const patternPoints = {
    'BULLISH ENGULFING': 12,
    'BEARISH ENGULFING': 12,
    'MORNING STAR': 12,
    'EVENING STAR': 12,
    'HAMMER': 6,
    'SHOOTING STAR': 6,
    'BULLISH MARUBOZU': 7,
    'BEARISH MARUBOZU': 7
  };

  add(
    pattern.direction,
    patternPoints[pattern.name] || 0,
    `Candlestick: ${pattern.name}.`
  );

  add(
    marketPsychology.direction,
    8,
    `Market psychology: ${marketPsychology.psychology}.`
  );

  add(
    supportResistance.direction,
    8,
    `Support/resistance: ${supportResistance.position}.`
  );

  add(
    trendLine.direction,
    7,
    `Trendline: ${trendLine.direction}.`
  );

  if (emaCross === 'BULLISH_CROSSOVER') {
    add('BULLISH', 7, 'EMA9 crossed above EMA21.');
  } else if (emaCross === 'BEARISH_CROSSOVER') {
    add('BEARISH', 7, 'EMA9 crossed below EMA21.');
  } else if (
    finite(ema9[index]) &&
    finite(ema21[index])
  ) {
    add(
      ema9[index] > ema21[index]
        ? 'BULLISH'
        : 'BEARISH',
      3,
      'EMA9/EMA21 alignment.'
    );
  }

  if (
    finite(rsi14[index]) &&
    finite(rsi14[previousIndex])
  ) {
    if (
      rsi14[previousIndex] < 30 &&
      rsi14[index] >= 30
    ) {
      add('BULLISH', 5, 'RSI14 recovered above 30.');
    } else if (
      rsi14[previousIndex] > 70 &&
      rsi14[index] <= 70
    ) {
      add('BEARISH', 5, 'RSI14 fell below 70.');
    } else if (
      rsi14[index] > 50 &&
      rsi14[index] < 70
    ) {
      add('BULLISH', 2, 'RSI14 positive momentum.');
    } else if (
      rsi14[index] < 50 &&
      rsi14[index] > 30
    ) {
      add('BEARISH', 2, 'RSI14 negative momentum.');
    }
  }

  if (macdCross === 'BULLISH_CROSSOVER') {
    add('BULLISH', 6, 'MACD bullish crossover.');
  } else if (macdCross === 'BEARISH_CROSSOVER') {
    add('BEARISH', 6, 'MACD bearish crossover.');
  } else if (
    finite(macdValues.histogram[index]) &&
    finite(macdValues.histogram[previousIndex]) &&
    macdValues.histogram[index] >
      macdValues.histogram[previousIndex] &&
    macdValues.histogram[index] > 0
  ) {
    add('BULLISH', 2, 'MACD histogram strengthening positive.');
  } else if (
    finite(macdValues.histogram[index]) &&
    finite(macdValues.histogram[previousIndex]) &&
    macdValues.histogram[index] <
      macdValues.histogram[previousIndex] &&
    macdValues.histogram[index] < 0
  ) {
    add('BEARISH', 2, 'MACD histogram strengthening negative.');
  }

  add(
    breakoutResult.direction,
    breakoutResult.status.includes('RETEST')
      ? 8
      : breakoutResult.status.includes('FALSE')
        ? 0
        : 5,
    `Breakout/retest: ${breakoutResult.status}.`
  );

  const direction =
    callScore > putScore
      ? 'BULLISH'
      : putScore > callScore
        ? 'BEARISH'
        : 'NEUTRAL';

  const winningScore = Math.max(callScore, putScore);
  const opposingScore = Math.min(callScore, putScore);
  const scoreGap = Math.abs(callScore - putScore);

  const guards = [];

  if (candles.length < MIN_CANDLES) {
    guards.push(
      `Fewer than ${MIN_CANDLES} completed 1-minute candles.`
    );
  }

  if (!hasContinuousMinutes(candles.slice(-60))) {
    guards.push(
      'Missing minute candles in the recent data window.'
    );
  }

  if (freshness !== 'FRESH') {
    guards.push('Market data is not fresh.');
  }

  if (confirmation5m.status === 'UNAVAILABLE') {
    guards.push(
      '5-minute confirmation is unavailable.'
    );
  } else if (confirmation5m.direction !== direction) {
    guards.push(
      '5-minute trend does not confirm the 1-minute direction.'
    );
  }

  if (volatilityResult.regime === 'UNAVAILABLE') {
    guards.push('Volatility regime is unavailable.');
  } else if (volatilityResult.regime === 'HIGH') {
    guards.push(
      'High-volatility regime: signal withheld.'
    );
  }

  if (
    ![
      rsi14[index],
      ema9[index],
      ema21[index],
      macdValues.histogram[index],
      atr14[index],
      bands.width[index]
    ].every(finite) ||
    trendLine.direction === 'UNAVAILABLE' ||
    supportResistance.position === 'UNAVAILABLE'
  ) {
    guards.push(
      'One or more required technical measurements are unavailable.'
    );
  }

  if (
    direction === 'NEUTRAL' ||
    scoreGap < MIN_SCORE_GAP
  ) {
    guards.push(
      'Directional evidence conflicts or score gap is too small.'
    );
  }

  if (winningScore < MIN_SIGNAL_SCORE) {
    guards.push(
      'Evidence score is below the minimum threshold.'
    );
  }

  if (opposingScore >= MIN_OPPOSING_SCORE) {
    guards.push(
      'Opposing directional evidence is material.'
    );
  }

  if (breakoutResult.status.startsWith('FALSE_')) {
    guards.push('False-breakout risk detected.');
  }

  const technicalSignal =
    guards.length > 0
      ? 'NO TRADE'
      : direction === 'BULLISH'
        ? 'BUY'
        : 'SELL';

  reasons.push(
    ...guards.map(reason => `NO TRADE: ${reason}`)
  );

  return {
    pair,
    timeframe: 1,
    signal: 'NO TRADE',
    technicalSignal,
    confidence: Math.min(100, winningScore),
    callScore: round(callScore, 0),
    putScore: round(putScore, 0),
    gap: round(scoreGap, 0),
    entryTime: null,
    expiryTime: null,
    currentPrice: last.close,
    entryPrice: null,
    entryPriceStatus: 'WAITING_FOR_ENTRY_PRICE',
    brokerPrice: null,
    brokerPriceStatus: 'NOT_SUBMITTED',
    brokerPriceGapPips: null,
    brokerPriceTolerancePips: DEFAULT_MAX_PRICE_GAP_PIPS,
    freshness,
    dataAgeSeconds: round(age, 1),
    lastCandle: iso(last.time),
    fetchedAt: iso(fetchedAt),
    supportResistance,
    trendLine,
    marketPsychology,
    priceAction: supportResistance.position,
    candlePattern: pattern,
    breakout: breakoutResult,
    confirmation5m,
    volatility: volatilityResult,
    indicators: {
      ema9: round(ema9[index]),
      ema21: round(ema21[index]),
      emaCross,
      rsi14: round(rsi14[index], 2),
      macd: {
        line: round(macdValues.line[index]),
        signal: round(macdValues.signal[index]),
        histogram: round(
          macdValues.histogram[index]
        ),
        crossover: macdCross
      },
      atr14: round(atr14[index]),
      bollinger: {
        upper: round(bands.upper[index]),
        middle: round(bands.middle[index]),
        lower: round(bands.lower[index]),
        width: round(bands.width[index], 5)
      }
    },
    reasons,
    source: 'Twelve Data LIVE',
    evidenceLabel: 'Evidence score, not win probability',
    tradeAllowed: false,
    noTrade: true,
    insufficientData: guards.length > 0
  };
}

function evaluateFreshness(market, now = Date.now()) {
  if (!market) return emptyMarket();

  const candleTime = Date.parse(market.lastCandle || '');

  if (!Number.isFinite(candleTime)) {
    return {
      ...market,
      signal: 'NO TRADE',
      tradeAllowed: false,
      noTrade: true,
      freshness: 'NO DATA',
      dataAgeSeconds: null
    };
  }

  const age = Math.max(
    0,
    (now - (candleTime + 60000)) / 1000
  );

  const freshness =
    age <= FRESHNESS_SECONDS
      ? 'FRESH'
      : age <= HARD_STALE_SECONDS
        ? 'STALE'
        : 'HARD STALE';

  if (freshness !== 'FRESH') {
    return {
      ...market,
      signal: 'NO TRADE',
      tradeAllowed: false,
      noTrade: true,
      freshness,
      dataAgeSeconds: round(age, 1),
      reasons: [
        ...(market.reasons || []),
        'NO TRADE: latest completed candle is stale.'
      ]
    };
  }

  return {
    ...market,
    freshness,
    dataAgeSeconds: round(age, 1)
  };
}

/* -------------------------------------------------------
   POCKET OPTION MANUAL PRICE VALIDATION
------------------------------------------------------- */

function applyBrokerPrice(
  market,
  brokerPriceValue,
  capturedAtMs = Date.now()
) {
  const result = {
    ...market,
    signal: 'NO TRADE',
    tradeAllowed: false,
    noTrade: true,
    brokerPrice: null,
    brokerPriceStatus: 'INVALID_OR_MISSING',
    brokerPriceGapPips: null,
    brokerPriceTolerancePips:
      DEFAULT_MAX_PRICE_GAP_PIPS,
    entryPrice: null,
    entryPriceStatus: 'WAITING_FOR_ENTRY_PRICE'
  };

  const brokerPrice = Number(brokerPriceValue);

  if (
    brokerPriceValue === undefined ||
    brokerPriceValue === null ||
    brokerPriceValue === '' ||
    !Number.isFinite(brokerPrice) ||
    brokerPrice <= 0
  ) {
    result.reasons = [
      ...(market.reasons || []),
      'NO TRADE: enter a valid Pocket Option broker price.'
    ];

    return result;
  }

  result.brokerPrice = brokerPrice;
  result.brokerPriceSubmittedAt = iso(capturedAtMs);
  result.brokerPriceCapturedAt = iso(capturedAtMs);
  result.brokerPriceSource = 'USER ENTERED POCKET OPTION PRICE';

  if (market.freshness !== 'FRESH') {
    result.brokerPriceStatus = 'MARKET_DATA_NOT_FRESH';
    result.reasons = [
      ...(market.reasons || []),
      'NO TRADE: market data is not fresh.'
    ];

    return result;
  }

  if (market.technicalSignal === 'NO TRADE') {
    result.brokerPriceStatus = 'TECHNICAL_FILTER_FAILED';
    result.reasons = [
      ...(market.reasons || []),
      'NO TRADE: technical qualification did not pass.'
    ];

    return result;
  }

  if (!finite(market.currentPrice) || market.currentPrice <= 0) {
    result.brokerPriceStatus = 'REFERENCE_PRICE_UNAVAILABLE';
    result.reasons = [
      ...(market.reasons || []),
      'NO TRADE: Twelve Data reference price is unavailable.'
    ];

    return result;
  }

  const gap = priceDifferencePips(
    market.pair,
    brokerPrice,
    Number(market.currentPrice)
  );

  result.brokerPriceGapPips = round(gap, 2);

  if (gap > DEFAULT_MAX_PRICE_GAP_PIPS) {
    result.brokerPriceStatus = 'PRICE_GAP_TOO_LARGE';

    result.reasons = [
      ...(market.reasons || []),
      `NO TRADE: Pocket Option price differs from Twelve Data by ${round(gap, 2)} pips; maximum allowed is ${DEFAULT_MAX_PRICE_GAP_PIPS}.`
    ];

    return result;
  }

  const now = Date.now();
  const entry = (Math.floor(now / 60000) + 1) * 60000;
  const expiry = entry + 60000;

  result.signal = market.technicalSignal;
  result.tradeAllowed = true;
  result.noTrade = false;
  result.entryPrice = brokerPrice;
  result.entryPriceStatus = 'USER_ENTERED_PRICE_ACCEPTED';
  result.brokerPriceStatus = 'WITHIN_TOLERANCE';
  result.entryTime = iso(entry);
  result.expiryTime = iso(expiry);

  result.reasons = [
    ...(market.reasons || []),
    `Pocket Option user-entered price is within ${DEFAULT_MAX_PRICE_GAP_PIPS}-pip tolerance.`,
    '5-minute trend confirmation passed.',
    'Live signal duration is one minute.'
  ];

  return result;
}

function createSignalRecord(market) {
  if (
    !market ||
    market.tradeAllowed !== true ||
    !['BUY', 'SELL'].includes(market.signal) ||
    !finite(market.entryPrice)
  ) {
    return null;
  }

  const id = [
    market.pair,
    market.signal,
    market.entryTime,
    market.brokerPrice
  ].join('_');

  return {
    id,
    pair: market.pair,
    signal: market.signal,
    evidenceScore: market.confidence,
    entryTime: market.entryTime,
    expiryTime: market.expiryTime,
    referencePrice: market.currentPrice,
    brokerPrice: market.brokerPrice,
    outcome: 'PENDING',
    createdAt: iso(Date.now()),
    source: 'Twelve Data reference + user-entered broker price',
    brokerPriceSource: market.brokerPriceSource,
    brokerPriceSubmittedAt: market.brokerPriceSubmittedAt,
    brokerPriceGapPips: market.brokerPriceGapPips
  };
}

/* -------------------------------------------------------
   SCANNER AND AUTO SELECTION
------------------------------------------------------- */

function candidateIsQualified(market) {
  return Boolean(
    market &&
    market.freshness === 'FRESH' &&
    market.technicalSignal !== 'NO TRADE' &&
    market.insufficientData !== true &&
    market.confirmation5m &&
    market.confirmation5m.status === 'CONFIRMED' &&
    market.confirmation5m.direction ===
      (market.technicalSignal === 'BUY'
        ? 'BULLISH'
        : 'BEARISH')
  );
}

function rankCandidates(markets) {
  const priorityIndex = new Map(
    PRIORITY_PAIRS.map((pair, index) => [pair, index])
  );

  return markets
    .map(evaluateFreshness)
    .sort((a, b) => {
      const qualifiedDifference =
        Number(candidateIsQualified(b)) -
        Number(candidateIsQualified(a));

      if (qualifiedDifference !== 0) {
        return qualifiedDifference;
      }

      const scoreDifference =
        Math.max(b.callScore || 0, b.putScore || 0) -
        Math.max(a.callScore || 0, a.putScore || 0);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return (
        (priorityIndex.get(a.pair) ?? 999) -
        (priorityIndex.get(b.pair) ?? 999)
      );
    })
    .map((market, index) => ({
      rank: index + 1,
      pair: market.pair,
      timeframe: 1,
      signal: candidateIsQualified(market)
        ? market.technicalSignal
        : 'NO TRADE',
      technicalSignal: market.technicalSignal,
      qualified: candidateIsQualified(market),
      confidence: market.confidence,
      callScore: market.callScore,
      putScore: market.putScore,
      gap: market.gap,
      currentPrice: market.currentPrice,
      freshness: market.freshness,
      dataAgeSeconds: market.dataAgeSeconds,
      entryTime: market.entryTime,
      oneMinuteTrend:
        (market.callScore || 0) > (market.putScore || 0)
          ? 'BULLISH'
          : (market.putScore || 0) > (market.callScore || 0)
            ? 'BEARISH'
            : 'NEUTRAL',
      fiveMinuteConfirmation:
        market.confirmation5m?.direction || 'UNAVAILABLE',
      volatility:
        market.volatility?.regime || 'UNAVAILABLE',
      reason:
        market.reasons?.[0] || 'Evidence review.'
    }));
}

function selectBest(markets) {
  const ranked = rankCandidates(markets);

  const qualified = ranked.find(
    candidate => candidate.qualified === true
  );

  if (!qualified) {
    return {
      selected: emptyMarket(
        'NO QUALIFIED PAIR',
        'No pair passed all live evidence and confirmation requirements.'
      ),
      ranked
    };
  }

  const selected =
    markets.find(market => market.pair === qualified.pair) ||
    latestMarkets.get(qualified.pair);

  return {
    selected: selected || emptyMarket(),
    ranked
  };
}

function getCurrentAnalysis() {
  const markets = [...latestMarkets.values()]
    .map(evaluateFreshness);

  const selection = selectBest(markets);

  return {
    selectedMarket: selection.selected,
    rankedCandidates: selection.ranked
  };
}

function makeResponse(
  selectedMarket,
  rankedCandidates = [],
  extra = {}
) {
  return {
    ok: true,
    version: VERSION,
    selectedMarket,
    rankedCandidates,
    scanner: {
      running: scannerRunning,
      startedAt: scannerStartedAt,
      lastScanAt,
      totalScanned,
      mode:
        'FIRST 6 OF 24 PRIORITY PAIRS; BACKGROUND 18 NOT PART OF INITIAL SCAN',
      phase: scanProgress.phase,
      batchSize: 6,
      pairs: 24,
      priorityPairs: PRIORITY_PAIRS,
      backgroundPairs: BACKGROUND_PAIRS,
      progress: { ...scanProgress },
      cooldownRemainingMs: Math.max(
        0,
        SCAN_COOLDOWN_MS -
          (Date.now() - lastScanStartedAtMs)
      )
    },
    metadata: metadata(),
    source: 'Twelve Data LIVE',
    diagnostic: { lastScanError },
    ...extra
  };
}

function refreshCandidates() {
  const analysis = getCurrentAnalysis();

  return makeResponse(
    analysis.selectedMarket,
    analysis.rankedCandidates
  );
}

async function processPair(pair) {
  try {
    let data = await getPairData(pair, false);

    let market = evaluateFreshness(
      scoreMarket(data.candles, pair, data.fetchedAt)
    );

    if (market.freshness !== 'FRESH') {
      data = await getPairData(pair, true);

      market = evaluateFreshness(
        scoreMarket(data.candles, pair, data.fetchedAt)
      );
    }

    latestMarkets.set(pair, market);

    return {
      pair,
      success: true,
      qualified: candidateIsQualified(market),
      market
    };
  } catch (error) {
    lastScanError =
      `${pair}: ${String(error.message || error)}`;

    const failed = emptyMarket(pair, lastScanError);

    latestMarkets.set(pair, failed);

    return {
      pair,
      success: false,
      qualified: false,
      error: lastScanError
    };
  } finally {
    refreshCandidates();
  }
}

async function scanPriority() {
  if (scannerRunning || !API_KEY) return false;

  scannerRunning = true;
  scannerStartedAt = iso(Date.now());
  lastScanStartedAtMs = Date.now();
  lastScanError = null;

  scanProgress = {
    phase: 'PRIORITY',
    completed: 0,
    total: 6,
    priorityCompleted: 0,
    priorityTotal: 6,
    backgroundCompleted: 0,
    backgroundTotal: 18,
    pair: null
  };

  try {
    for (const pair of PRIORITY_PAIRS) {
      scanProgress.phase = 'PRIORITY';
      scanProgress.pair = pair;

      await processPair(pair);

      scanProgress.priorityCompleted++;
      scanProgress.completed++;
    }

    scanProgress.phase = 'PRIORITY_COMPLETE';
    scanProgress.pair = null;

    lastScanAt = iso(Date.now());
    totalScanned += scanProgress.completed;

    return true;
  } finally {
    scannerRunning = false;
    scanProgress.phase = 'PRIORITY_COMPLETE';
    scanProgress.pair = null;
    refreshCandidates();
  }
}

function startScanIfPossible() {
  if (!API_KEY || scannerRunning) return false;

  const remaining = Math.max(
    0,
    SCAN_COOLDOWN_MS -
      (Date.now() - lastScanStartedAtMs)
  );

  if (lastScanStartedAtMs && remaining > 0) {
    return false;
  }

  resetDailyCounter();

  if (DAILY_USABLE_LIMIT - dailyCreditsUsed < 6) {
    lastScanError =
      'Insufficient daily Twelve Data budget for a complete six-pair scan.';

    return false;
  }

  void scanPriority().catch(error => {
    lastScanError = String(error.message || error);
    scannerRunning = false;
    scanProgress.phase = 'ERROR';
    scanProgress.pair = null;
    refreshCandidates();
  });

  return true;
}/* -------------------------------------------------------
   WALK-FORWARD BACKTEST
------------------------------------------------------- */

function historicalSignal(candles, index) {
  const sample = candles.slice(0, index + 1);

  if (sample.length < MIN_CANDLES) return null;

  const closes = sample.map(candle => candle.close);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsi14 = rsi(closes);
  const macdValues = macd(closes);
  const atrValues = atr(sample);
  const bands = bollinger(closes);

  const last = sample.length - 1;

  const values = [
    ema9[last],
    ema21[last],
    rsi14[last],
    macdValues.histogram[last],
    atrValues[last],
    bands.width[last]
  ];

  if (!values.every(finite)) return null;

  const five = aggregate5m(sample);

  if (five.length < MIN_5M_CANDLES) return null;

  const fiveCloses = five.map(candle => candle.close);
  const fiveFast = ema(fiveCloses, 9);
  const fiveSlow = ema(fiveCloses, 21);

  const fiveDirection =
    fiveFast.at(-1) > fiveSlow.at(-1)
      ? 'BULLISH'
      : fiveFast.at(-1) < fiveSlow.at(-1)
        ? 'BEARISH'
        : 'NEUTRAL';

  const pattern = candlePattern(sample);
  const psychologyResult = psychology(sample);
  const supportResistance = levels(sample);
  const trend = trendline(sample);
  const breakoutResult = breakout(sample);

  let bull = 0;
  let bear = 0;

  const add = (direction, points) => {
    if (direction === 'BULLISH') bull += points;
    if (direction === 'BEARISH') bear += points;
  };

  add(
    ema9[last] > ema21[last]
      ? 'BULLISH'
      : 'BEARISH',
    3
  );

  add(
    rsi14[last] > 50 && rsi14[last] < 70
      ? 'BULLISH'
      : rsi14[last] < 50 && rsi14[last] > 30
        ? 'BEARISH'
        : 'NEUTRAL',
    2
  );

  add(
    macdValues.histogram[last] > 0
      ? 'BULLISH'
      : macdValues.histogram[last] < 0
        ? 'BEARISH'
        : 'NEUTRAL',
    2
  );

  add(
    pattern.direction,
    pattern.name.includes('ENGULFING') ||
      pattern.name.includes('STAR')
      ? 8
      : 4
  );

  add(psychologyResult.direction, 4);
  add(supportResistance.direction, 4);
  add(trend.direction, 3);

  add(
    breakoutResult.direction,
    breakoutResult.status.includes('FALSE') ? 0 : 4
  );

  const direction =
    bull > bear
      ? 'BULLISH'
      : bear > bull
        ? 'BEARISH'
        : 'NEUTRAL';

  const winning = Math.max(bull, bear);
  const gap = Math.abs(bull - bear);

  const sortedWidths = bands.width
    .filter(finite)
    .sort((a, b) => a - b);

  const highWidth = sortedWidths[
    Math.floor((sortedWidths.length - 1) * 0.75)
  ];

  if (
    direction === 'NEUTRAL' ||
    winning < 25 ||
    gap < 7 ||
    fiveDirection !== direction ||
    bands.width[last] >= highWidth ||
    breakoutResult.status.startsWith('FALSE')
  ) {
    return null;
  }

  return direction === 'BULLISH' ? 'BUY' : 'SELL';
}

function runWalkForward(candles, expiry = 1) {
  const duration = clamp(Number(expiry) || 1, 1, 3);
  const split = Math.floor(candles.length * 0.7);
  const start = Math.max(
    MIN_CANDLES,
    Math.floor(candles.length * 0.25)
  );

  let developmentSignals = 0;
  let developmentHits = 0;
  let holdoutSignals = 0;
  let holdoutHits = 0;
  let eligible = 0;

  for (
    let index = start;
    index + duration < candles.length - 1;
    index++
  ) {
    const direction = historicalSignal(candles, index);

    if (!direction) continue;

    eligible++;

    const entry = candles[index + 1].open;
    const exit = candles[index + duration].close;

    if (!finite(entry) || !finite(exit) || entry === exit) {
      continue;
    }

    const hit =
      direction === 'BUY'
        ? exit > entry
        : exit < entry;

    if (index < split) {
      developmentSignals++;

      if (hit) developmentHits++;
    } else {
      holdoutSignals++;

      if (hit) holdoutHits++;
    }
  }

  const holdoutRate = holdoutSignals
    ? holdoutHits / holdoutSignals * 100
    : null;

  const developmentRate = developmentSignals
    ? developmentHits / developmentSignals * 100
    : null;

  const sufficient =
    holdoutSignals >= BACKTEST_MIN_SIGNALS;

  return {
    method:
      'CHRONOLOGICAL WALK-FORWARD · NEXT-CANDLE OPEN ENTRY',
    lookAheadBiasControl:
      'Decision uses completed candles through index i; entry is next candle open; exit is expiry candle close.',
    expiryMinutes: duration,
    candles: candles.length,
    coveragePercent: candles.length
      ? round(
          eligible / Math.max(1, candles.length - start - duration) * 100,
          2
        )
      : 0,
    development: {
      signals: developmentSignals,
      hits: developmentHits,
      hitRate: round(developmentRate, 2)
    },
    holdout: {
      signals: holdoutSignals,
      hits: holdoutHits,
      hitRate: round(holdoutRate, 2),
      baselinePercent: 50,
      sufficientSample: sufficient
    },
    totalSignals:
      developmentSignals + holdoutSignals,
    conclusion: !sufficient
      ? 'INSUFFICIENT HOLDOUT SAMPLE — no performance claim.'
      : holdoutRate > 50
        ? 'Holdout exceeded 50% directional reference in this sample only; not a guarantee.'
        : 'Holdout did not exceed the 50% directional reference.',
    limitations: [
      'No broker spread, payout, slippage or execution latency model.',
      'Historical candles are not Pocket Option execution prices.',
      'This is a research comparison, not a probability forecast.'
    ],
    warning:
      'Historical results do not predict or guarantee future outcomes.'
  };
}

/* -------------------------------------------------------
   API ROUTES
------------------------------------------------------- */

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'PO AI Predictor API',
    version: VERSION,
    mode: 'LIVE FOREX ONLY',
    endpoints: [
      '/api/health',
      '/api/best',
      '/api/analyze',
      '/api/scan',
      '/api/confirm-signal',
      '/api/history',
      '/api/backtest'
    ]
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    provider: 'Twelve Data LIVE',
    configured: Boolean(API_KEY),
    mode: 'LIVE FOREX ONLY',
    scannerRunning,
    scannerEnabled: Boolean(API_KEY),
    scannerMode: 'FIRST 6 OF 24',
    scannerStartedAt,
    lastScanAt,
    totalScanned,
    priorityPairs: PRIORITY_PAIRS,
    backgroundPairs: BACKGROUND_PAIRS,
    scanProgress: { ...scanProgress },
    cooldownRemainingMs: Math.max(
      0,
      SCAN_COOLDOWN_MS -
        (Date.now() - lastScanStartedAtMs)
    ),
    brokerPriceMode:
      'MANUAL USER-ENTERED POCKET OPTION PRICE',
    brokerPriceTolerancePips:
      DEFAULT_MAX_PRICE_GAP_PIPS,
    brokerPriceMaxAgeSeconds:
      BROKER_PRICE_MAX_AGE_MS / 1000,
    metadata: metadata()
  });
});

app.get('/api/best', (_req, res) => {
  const analysis = getCurrentAnalysis();

  res.json(
    makeResponse(
      analysis.selectedMarket,
      analysis.rankedCandidates
    )
  );
});

app.get('/api/analyze', async (req, res) => {
  const rawPair = req.query.pair;
  const pair = rawPair
    ? normalizePair(rawPair)
    : null;

  if (rawPair && !pair) {
    return res.status(400).json({
      ok: false,
      version: VERSION,
      error:
        'Invalid pair. Select one of the supported 24 LIVE forex pairs.'
    });
  }

  /*
   * Explicit pair selection:
   * The user-selected pair is never replaced by AUTO ranking.
   */
  if (pair) {
    try {
      let data = await getPairData(pair, false);

      let market = evaluateFreshness(
        scoreMarket(data.candles, pair, data.fetchedAt)
      );

      if (market.freshness !== 'FRESH') {
        data = await getPairData(pair, true);

        market = evaluateFreshness(
          scoreMarket(data.candles, pair, data.fetchedAt)
        );
      }

      latestMarkets.set(pair, market);

      const brokerPrice = req.query.brokerPrice;

      if (
        brokerPrice !== undefined &&
        brokerPrice !== ''
      ) {
        market = applyBrokerPrice(
          market,
          brokerPrice
        );

        if (market.tradeAllowed === true) {
          const record = createSignalRecord(market);

          if (record) {
            await saveSignal(record);
          }
        }
      }

      const analysis = getCurrentAnalysis();

      return res.json(
        makeResponse(
          market,
          analysis.rankedCandidates,
          {
            selectedPair: pair,
            analysisMode: 'USER SELECTED PAIR',
            note:
              'Analysis is for the selected pair. Manual broker price is required before a live research direction is confirmed.'
          }
        )
      );
    } catch (error) {
      return res.status(503).json({
        ok: false,
        version: VERSION,
        selectedPair: pair,
        error: String(error.message || error),
        selectedMarket: emptyMarket(
          pair,
          'Selected-pair analysis could not be completed.'
        )
      });
    }
  }

  /*
   * AUTO mode:
   * Start or monitor the first-six-pair scan.
   * A selected technical candidate is not an executable signal
   * until its broker price is submitted separately.
   */
  const started = startScanIfPossible();
  const analysis = getCurrentAnalysis();

  return res.json(
    makeResponse(
      analysis.selectedMarket,
      analysis.rankedCandidates,
      {
        analysisMode: 'AI PRIORITY SCAN',
        scanStarted: started,
        note:
          'AI scans the first six priority pairs. No BUY/SELL is confirmed until a manual Pocket Option price is submitted for the selected pair.'
      }
    )
  );
});

app.post('/api/scan', (_req, res) => {
  if (!API_KEY) {
    return res.status(503).json({
      ok: false,
      version: VERSION,
      error: 'Twelve Data API key is not configured.'
    });
  }

  if (scannerRunning) {
    return res.status(409).json({
      ok: false,
      version: VERSION,
      error: 'Priority scanner is already running.',
      scanner: {
        running: true,
        progress: { ...scanProgress }
      }
    });
  }

  const remaining = Math.max(
    0,
    SCAN_COOLDOWN_MS -
      (Date.now() - lastScanStartedAtMs)
  );

  if (lastScanStartedAtMs && remaining > 0) {
    return res.status(429).json({
      ok: false,
      version: VERSION,
      error:
        'Please wait before starting another priority scan.',
      cooldownRemainingMs: remaining
    });
  }

  const started = startScanIfPossible();

  return res.status(started ? 202 : 429).json({
    ok: started,
    version: VERSION,
    message: started
      ? 'Six-pair LIVE forex priority scan started.'
      : 'Priority scan could not start.',
    scanner: {
      running: scannerRunning,
      progress: { ...scanProgress },
      priorityPairs: PRIORITY_PAIRS,
      backgroundPairs: BACKGROUND_PAIRS
    }
  });
});

/*
 * Confirm the exact pair selected and analyzed by the frontend.
 * Pocket Option price is manually entered by the user.
 * The backend checks its timestamp and compares it with
 * the latest Twelve Data reference price.
 */
app.post('/api/confirm-signal', async (req, res) => {
  const body = req.body && typeof req.body === 'object'
    ? req.body
    : {};

  const pair = normalizePair(body.pair);

  if (!pair) {
    return res.status(400).json({
      ok: false,
      version: VERSION,
      error: 'A valid selected LIVE forex pair is required.'
    });
  }

  if (Number(body.expiryMinutes) !== 1) {
    return res.status(400).json({
      ok: false,
      version: VERSION,
      error: 'Live confirmation supports one-minute signals only.'
    });
  }

  if (
    body.source !==
    'USER_ENTERED_POCKET_OPTION_PRICE'
  ) {
    return res.status(400).json({
      ok: false,
      version: VERSION,
      error:
        'Pocket Option price must be submitted as a user-entered quote.'
    });
  }

  const capturedAtMs = Date.parse(
    String(body.brokerPriceCapturedAt || '')
  );

  const now = Date.now();

  if (
    !Number.isFinite(capturedAtMs) ||
    capturedAtMs > now + 5000 ||
    now - capturedAtMs > BROKER_PRICE_MAX_AGE_MS
  ) {
    return res.status(400).json({
      ok: false,
      version: VERSION,
      error:
        'Pocket Option price timestamp is invalid or older than 30 seconds. Enter the current price and confirm again.'
    });
  }

  const storedMarket = latestMarkets.get(pair);

  if (!storedMarket) {
    return res.status(409).json({
      ok: false,
      version: VERSION,
      error:
        'Analyze this exact pair first. No recent market analysis is available.'
    });
  }

  const freshMarket = evaluateFreshness(storedMarket);

  const confirmedMarket = applyBrokerPrice(
    freshMarket,
    body.brokerPrice,
    capturedAtMs
  );

  let recordSaved = false;

  if (confirmedMarket.tradeAllowed === true) {
    const record = createSignalRecord(confirmedMarket);

    if (record) {
      await saveSignal(record);
      recordSaved = true;
    }
  }

  const validated =
    confirmedMarket.tradeAllowed === true;

  const failureReason =
    (confirmedMarket.reasons || []).slice(-1)[0] ||
    'Broker price validation did not pass.';

  return res.json({
    ok: true,
    version: VERSION,
    pair,
    selectedPair: pair,
    tradeAllowed: validated,
    selectedMarket: confirmedMarket,
    market: confirmedMarket,
    brokerPrice: {
      validated,
      status: validated
        ? 'VALIDATED'
        : confirmedMarket.brokerPriceStatus,
      price: confirmedMarket.brokerPrice,
      referencePrice: confirmedMarket.currentPrice,
      differencePips: confirmedMarket.brokerPriceGapPips,
      tolerancePips: DEFAULT_MAX_PRICE_GAP_PIPS,
      capturedAt: iso(capturedAtMs),
      source: 'USER_ENTERED_POCKET_OPTION_PRICE',
      reason: validated
        ? 'Pocket Option user-entered price passed the configured tolerance.'
        : failureReason
    },
    entryPrice: confirmedMarket.entryPrice,
    entryTime: confirmedMarket.entryTime,
    expiryTime: confirmedMarket.expiryTime,
    recordSaved,
    reason: validated
      ? 'All backend confirmation checks passed. One-minute research signal only; no guaranteed outcome.'
      : failureReason
  });
});

app.get('/api/history', async (req, res) => {
  const history = await getHistory(req.query.limit);

  res.json({
    ok: true,
    version: VERSION,
    storage: databaseReady
      ? 'POSTGRESQL'
      : 'MEMORY_ONLY',
    persistent: databaseReady,
    count: history.length,
    history
  });
});

app.get('/api/backtest', async (req, res) => {
  const pair = normalizePair(
    req.query.pair || 'EUR/USD'
  );

  const expiry = Number(req.query.expiry || 1);

  if (!pair) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid currency pair.'
    });
  }

  if (![1, 2, 3].includes(expiry)) {
    return res.status(400).json({
      ok: false,
      error: 'Expiry must be 1, 2 or 3 minutes.'
    });
  }

  try {
    const data = await getPairData(pair, false);
    const candles = closedCandles(data.candles);

    const result = runWalkForward(candles, expiry);

    return res.json({
      ok: true,
      version: VERSION,
      pair,
      result,
      source: 'Twelve Data LIVE historical candles',
      note:
        'Backtest uses next-candle open entry. It does not model Pocket Option payout, spread, slippage or execution latency.'
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      version: VERSION,
      pair,
      error: String(error.message || error)
    });
  }
});

/* -------------------------------------------------------
   SERVER START
------------------------------------------------------- */

if (require.main === module) {
  initializeDatabase().finally(() => {
    app.listen(PORT, () => {
      console.log(
        `PO AI Predictor ${VERSION} listening on ${PORT}`
      );

      console.log('Mode: LIVE FOREX ONLY');
      console.log(
        `Twelve Data configured: ${Boolean(API_KEY)}`
      );

      console.log(
        `PostgreSQL configured: ${Boolean(DATABASE_URL)}`
      );
    });
  });
}

module.exports = app;
