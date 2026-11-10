
'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const VERSION = 'V10.1.0';
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PROVIDER_URL = 'https://api.twelvedata.com/time_series';

const PRIORITY_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY',
  'USD/CHF', 'AUD/USD', 'USD/CAD'
];

const BACKGROUND_PAIRS = [
  'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY',
  'AUD/JPY', 'CAD/JPY', 'CHF/JPY', 'EUR/AUD',
  'EUR/CAD', 'EUR/CHF', 'GBP/AUD', 'GBP/CAD',
  'GBP/CHF', 'NZD/JPY', 'NZD/CAD', 'AUD/CAD',
  'AUD/CHF', 'CAD/CHF'
];

const PAIRS = [...PRIORITY_PAIRS, ...BACKGROUND_PAIRS];

const DAILY_REQUEST_LIMIT = 768;
const DAILY_RESERVE = 32;
const DAILY_USABLE_LIMIT = DAILY_REQUEST_LIMIT - DAILY_RESERVE;
const REQUESTS_PER_MINUTE = 6;
const REQUEST_SPACING_MS = 10000;
const PROVIDER_TIMEOUT_MS = 12000;
const PAIR_CACHE_MS = 120000;
const FRESHNESS_SECONDS = 150;
const HARD_STALE_SECONDS = 300;
const SCAN_COOLDOWN_MS = 60000;

const MIN_CANDLES = 60;
const MIN_SIGNAL_SCORE = 55;
const MIN_SCORE_GAP = 12;
const MIN_5M_CANDLES = 30;
const HISTORY_LIMIT = 5000;
const BACKTEST_MIN_SIGNALS = 30;

const pairCache = new Map();
const inFlight = new Map();
const latestMarkets = new Map();
const signalHistory = [];

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
  total: PAIRS.length,
  priorityCompleted: 0,
  priorityTotal: PRIORITY_PAIRS.length,
  backgroundCompleted: 0,
  backgroundTotal: BACKGROUND_PAIRS.length,
  pair: null
};

const finite = value =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  Number.isFinite(Number(value));

const avg = values =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

const round = (value, digits = 6) =>
  finite(value) ? Number(Number(value).toFixed(digits)) : null;

const iso = value =>
  Number.isFinite(value) ? new Date(value).toISOString() : null;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function normalizePair(value) {
  const pair = String(value || '').trim().toUpperCase().replace(/\s/g, '');
  return PAIRS.includes(pair) ? pair : null;
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
    dailyCreditsRemaining: Math.max(0, DAILY_USABLE_LIMIT - dailyCreditsUsed),
    dailyRequestLimit: DAILY_REQUEST_LIMIT,
    dailyUsableLimit: DAILY_USABLE_LIMIT,
    requestsPerMinuteLimit: REQUESTS_PER_MINUTE,
    cachedPairs: pairCache.size,
    priorityPairs: PRIORITY_PAIRS.length,
    backgroundPairs: BACKGROUND_PAIRS.length,
    version: VERSION,
    storage: databaseReady ? 'POSTGRESQL' : 'MEMORY_ONLY',
    databaseConfigured: Boolean(DATABASE_URL),
    databaseReady,
    databaseError
  };
}

/* -------------------------------------------------------
   OPTIONAL POSTGRESQL SIGNAL STORAGE
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
        outcome TEXT DEFAULT 'PENDING',
        outcome_price DOUBLE PRECISION,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        details JSONB DEFAULT '{}'::jsonb
      )
    `);

    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS po_signal_history_created_idx
      ON po_signal_history(created_at DESC)
    `);

    databaseReady = true;
    databaseError = null;
  } catch (error) {
    databaseReady = false;
    databaseError = String(error.message || error);
    console.error('Database initialization failed:', databaseError);
  }
}

async function saveSignal(record) {
  signalHistory.unshift(record);

  if (signalHistory.length > HISTORY_LIMIT) {
    signalHistory.length = HISTORY_LIMIT;
  }

  if (!databaseReady || !pgPool) return;

  try {
    await pgPool.query(
      `INSERT INTO po_signal_history
       (signal_key, pair, direction, evidence_score, entry_time,
        expiry_time, reference_price, outcome, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (signal_key) DO NOTHING`,
      [
        record.id,
        record.pair,
        record.signal,
        record.evidenceScore,
        record.entryTime,
        record.expiryTime,
        record.referencePrice,
        record.outcome,
        JSON.stringify(record)
      ]
    );
  } catch (error) {
    databaseError = String(error.message || error);
  }
}

async function getHistory(limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));

  if (databaseReady && pgPool) {
    try {
      const result = await pgPool.query(
        `SELECT id, signal_key, pair, direction, evidence_score,
                entry_time, expiry_time, reference_price, outcome,
                outcome_price, created_at, details
         FROM po_signal_history
         ORDER BY created_at DESC
         LIMIT $1`,
        [safeLimit]
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
        outcome: row.outcome,
        outcomePrice: row.outcome_price,
        createdAt: row.created_at
      }));
    } catch (error) {
      databaseError = String(error.message || error);
    }
  }

  return signalHistory.slice(0, safeLimit);
}

/* -------------------------------------------------------
   TWELVE DATA PROVIDER
------------------------------------------------------- */

function enqueueProviderRequest(task) {
  const run = requestQueue.then(task, task);
  requestQueue = run.catch(() => {});
  return run;
}

async function providerFetch(pair) {
  return enqueueProviderRequest(async () => {
    if (!API_KEY) {
      throw new Error('Twelve Data API key is not configured.');
    }

    while (true) {
      resetDailyCounter();

      const now = Date.now();
      requestTimes = requestTimes.filter(time => now - time < 60000);

      if (dailyCreditsUsed >= DAILY_USABLE_LIMIT) {
        throw new Error('Daily Twelve Data safety limit reached.');
      }

      const minuteWait = requestTimes.length >= REQUESTS_PER_MINUTE
        ? Math.max(250, 60000 - (now - requestTimes[0]) + 100)
        : 0;

      const spacingWait = Math.max(
        0,
        REQUEST_SPACING_MS - (now - lastProviderRequestAt)
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
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`Twelve Data HTTP ${response.status}.`);
      }

      const json = await response.json();

      if (json.status === 'error' || json.code || !Array.isArray(json.values)) {
        throw new Error(json.message || 'Provider returned no candle values.');
      }

      const candles = normalizeCandles(json.values);

      if (!candles.length) {
        throw new Error('No valid candles returned by Twelve Data.');
      }

      return {
        candles,
        fetchedAt: Date.now(),
        source: 'Twelve Data LIVE'
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Twelve Data request timed out.');
      }
      throw new Error(error.message || 'Twelve Data request failed.');
    } finally {
      clearTimeout(timeout);
    }
  });
}

function normalizeCandles(rows) {
  const byTime = new Map();

  for (const row of rows) {
    const rawTime = String(row.datetime || row.time || '').trim();
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawTime);

    const time = Date.parse(
      rawTime && !hasTimezone
        ? `${rawTime.replace(' ', 'T')}Z`
        : rawTime
    );

    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);

    if (!Number.isFinite(time) ||
        ![open, high, low, close].every(Number.isFinite)) {
      continue;
    }

    if (high < Math.max(open, close, low) ||
        low > Math.min(open, close, high)) {
      continue;
    }

    byTime.set(time, { time, open, high, low, close });
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function getPairData(pair, forceRefresh = false) {
  const cached = pairCache.get(pair);

  if (!forceRefresh && cached &&
      Date.now() - cached.fetchedAt < PAIR_CACHE_MS) {
    return cached;
  }

  if (inFlight.has(pair)) return inFlight.get(pair);

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
  return candles.filter(candle => candle.time + 60000 <= now);
}

/* -------------------------------------------------------
   TECHNICAL INDICATORS — ONLY THE APPROVED SET
------------------------------------------------------- */

function ema(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;

  let value = avg(values.slice(0, period));
  output[period - 1] = value;
  const alpha = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value = values[i] * alpha + value * (1 - alpha);
    output[i] = value;
  }

  return output;
}

function rsi(values, period = 14) {
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;

  const calculate = () => averageLoss === 0
    ? (averageGain === 0 ? 50 : 100)
    : 100 - 100 / (1 + averageGain / averageLoss);

  output[period] = calculate();

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain = (
      averageGain * (period - 1) + Math.max(change, 0)
    ) / period;

    averageLoss = (
      averageLoss * (period - 1) + Math.max(-change, 0)
    ) / period;

    output[i] = calculate();
  }

  return output;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);

  const line = values.map((_, i) =>
    finite(fast[i]) && finite(slow[i]) ? fast[i] - slow[i] : null
  );

  const valid = line.filter(finite);
  const compactSignal = ema(valid, 9);
  const signal = Array(values.length).fill(null);
  let j = 0;

  for (let i = 0; i < line.length; i++) {
    if (finite(line[i])) signal[i] = compactSignal[j++];
  }

  const histogram = line.map((value, i) =>
    finite(value) && finite(signal[i]) ? value - signal[i] : null
  );

  return { line, signal, histogram };
}

function atr(candles, period = 14) {
  const tr = Array(candles.length).fill(null);

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;

    tr[i] = Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose)
    );
  }

  const output = Array(candles.length).fill(null);
  if (candles.length <= period) return output;

  let value = avg(tr.slice(1, period + 1));
  output[period] = value;

  for (let i = period + 1; i < candles.length; i++) {
    value = ((value * (period - 1)) + tr[i]) / period;
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
    const variance = avg(sample.map(value => (value - mean) ** 2));
    const deviation = Math.sqrt(variance);

    middle[i] = mean;
    upper[i] = mean + multiplier * deviation;
    lower[i] = mean - multiplier * deviation;
    width[i] = mean ? ((upper[i] - lower[i]) / mean) * 100 : null;
  }

  return { upper, middle, lower, width };
}

function crossover(previousA, previousB, currentA, currentB) {
  if (![previousA, previousB, currentA, currentB].every(finite)) {
    return 'UNAVAILABLE';
  }

  if (previousA <= previousB && currentA > currentB) {
    return 'BULLISH_CROSSOVER';
  }

  if (previousA >= previousB && currentA < currentB) {
    return 'BEARISH_CROSSOVER';
  }

  return 'NO_CROSSOVER';
}

function findRsiDivergence(candles, rsiValues, lookback = 40) {
  const start = Math.max(0, candles.length - lookback);
  const points = [];

  for (let i = start + 2; i < candles.length - 2; i++) {
    const isLow =
      candles[i].low <= candles[i - 1].low &&
      candles[i].low <= candles[i + 1].low;

    const isHigh =
      candles[i].high >= candles[i - 1].high &&
      candles[i].high >= candles[i + 1].high;

    if (finite(rsiValues[i]) && (isLow || isHigh)) {
      points.push({
        index: i,
        low: candles[i].low,
        high: candles[i].high,
        rsi: rsiValues[i],
        type: isLow ? 'LOW' : 'HIGH'
      });
    }
  }

  const lows = points.filter(point => point.type === 'LOW').slice(-2);
  const highs = points.filter(point => point.type === 'HIGH').slice(-2);

  if (lows.length === 2) {
    const [a, b] = lows;
    if (b.low < a.low && b.rsi > a.rsi) {
      return {
        type: 'BULLISH_DIVERGENCE',
        direction: 'BULLISH',
        description: 'Price made a lower low while RSI made a higher low.'
      };
    }
  }

  if (highs.length === 2) {
    const [a, b] = highs;
    if (b.high > a.high && b.rsi < a.rsi) {
      return {
        type: 'BEARISH_DIVERGENCE',
        direction: 'BEARISH',
        description: 'Price made a higher high while RSI made a lower high.'
      };
    }
  }

  return {
    type: 'NO_CONFIRMED_DIVERGENCE',
    direction: 'NEUTRAL',
    description: 'No confirmed RSI divergence in the recent lookback.'
  };
}

/* -------------------------------------------------------
   CANDLESTICK PATTERNS
------------------------------------------------------- */

function candlePattern(candles) {
  if (candles.length < 3) {
    return { name: 'INSUFFICIENT CANDLES', direction: 'NEUTRAL' };
  }

  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const p2 = candles[candles.length - 3];

  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, Number.EPSILON);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const bodyRatio = body / range;

  const bullish = c.close > c.open;
  const bearish = c.close < c.open;
  const previousBearish = p.close < p.open;
  const previousBullish = p.close > p.open;

  if (bodyRatio <= 0.08) {
    return { name: 'DOJI', direction: 'NEUTRAL' };
  }

  if (previousBearish && bullish &&
      c.open <= p.close && c.close >= p.open) {
    return { name: 'BULLISH ENGULFING', direction: 'BULLISH' };
  }

  if (previousBullish && bearish &&
      c.open >= p.close && c.close <= p.open) {
    return { name: 'BEARISH ENGULFING', direction: 'BEARISH' };
  }

  if (bodyRatio <= 0.35 && lower >= body * 2 &&
      upper <= Math.max(body * 0.7, range * 0.05)) {
    return { name: 'HAMMER', direction: 'BULLISH' };
  }

  if (bodyRatio <= 0.35 && upper >= body * 2 &&
      lower <= Math.max(body * 0.7, range * 0.05)) {
    return { name: 'SHOOTING STAR', direction: 'BEARISH' };
  }

  if (previousBearish && bullish &&
      c.open > p.close && c.close < (p.open + p.close) / 2) {
    return { name: 'PIERCING LINE', direction: 'BULLISH' };
  }

  if (previousBullish && bearish &&
      c.open < p.close && c.close > (p.open + p.close) / 2) {
    return { name: 'DARK CLOUD COVER', direction: 'BEARISH' };
  }

  if (previousBearish && bullish &&
      c.open > p.close && c.close < p.open) {
    return { name: 'BULLISH HARAMI', direction: 'BULLISH' };
  }

  if (previousBullish && bearish &&
      c.open < p.close && c.close > p.open) {
    return { name: 'BEARISH HARAMI', direction: 'BEARISH' };
  }

  if (p2.close < p2.open &&
      Math.abs(p.close - p.open) < Math.abs(p2.close - p2.open) * 0.4 &&
      bullish && c.close > (p2.open + p2.close) / 2) {
    return { name: 'MORNING STAR', direction: 'BULLISH' };
  }

  if (p2.close > p2.open &&
      Math.abs(p.close - p.open) < Math.abs(p2.close - p2.open) * 0.4 &&
      bearish && c.close < (p2.open + p2.close) / 2) {
    return { name: 'EVENING STAR', direction: 'BEARISH' };
  }

  if (bodyRatio <= 0.2 && lower > range * 0.55) {
    return { name: 'DRAGONFLY DOJI', direction: 'POTENTIAL BULLISH' };
  }

  if (bodyRatio <= 0.2 && upper > range * 0.55) {
    return { name: 'GRAVESTONE DOJI', direction: 'POTENTIAL BEARISH' };
  }

  return {
    name: bullish ? 'BULLISH CANDLE' : bearish ? 'BEARISH CANDLE' : 'NO CLEAR PATTERN',
    direction: bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'NEUTRAL'
  };
}

/* -------------------------------------------------------
   PRICE STRUCTURE AND MARKET CONTEXT
------------------------------------------------------- */

function marketPsychology(candles) {
  if (candles.length < 10) {
    return {
      psychology: 'INSUFFICIENT PRICE EVIDENCE',
      direction: 'NEUTRAL',
      buyerPressure: 0,
      sellerPressure: 0
    };
  }

  const recent = candles.slice(-8);
  let up = 0;
  let down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) up++;
    if (recent[i].close < recent[i - 1].close) down++;
  }

  const last = recent[recent.length - 1];
  const range = Math.max(last.high - last.low, Number.EPSILON);
  const closeLocation = (last.close - last.low) / range;

  if (up >= 5 && closeLocation >= 0.65) {
    return {
      psychology: 'BUYERS SHOWING RECENT CONTROL',
      direction: 'BULLISH',
      buyerPressure: up,
      sellerPressure: down
    };
  }

  if (down >= 5 && closeLocation <= 0.35) {
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

function trendLine(candles) {
  const sample = candles.slice(-30);

  if (sample.length < 15) {
    return { direction: 'UNAVAILABLE', slopePercent: null };
  }

  const xs = sample.map((_, index) => index);
  const ys = sample.map(candle => candle.close);
  const meanX = avg(xs);
  const meanY = avg(ys);

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < sample.length; i++) {
    numerator += (xs[i] - meanX) * (ys[i] - meanY);
    denominator += (xs[i] - meanX) ** 2;
  }

  const slope = denominator ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;
  const projected = intercept + slope * (sample.length - 1);
  const slopePercent = meanY ? slope / meanY * 100 : 0;

  const direction = slopePercent > 0.002
    ? 'BULLISH'
    : slopePercent < -0.002
      ? 'BEARISH'
      : 'SIDEWAYS';

  return {
    direction,
    slopePercent: round(slopePercent, 6),
    projectedPrice: round(projected),
    aboveLine: ys[ys.length - 1] > projected,
    belowLine: ys[ys.length - 1] < projected,
    description: `30-candle regression trend: ${direction}.`
  };
}

function supportResistance(candles) {
  const previous = candles.slice(-31, -1);

  if (previous.length < 15) {
    return {
      support: null,
      resistance: null,
      position: 'UNAVAILABLE',
      direction: 'NEUTRAL'
    };
  }

  const support = Math.min(...previous.map(candle => candle.low));
  const resistance = Math.max(...previous.map(candle => candle.high));
  const last = candles[candles.length - 1];
  const range = Math.max(last.high - last.low, Number.EPSILON);

  let position = 'BETWEEN LEVELS';
  let direction = 'NEUTRAL';

  if (last.close > resistance) {
    position = 'CLOSED-CANDLE RESISTANCE BREAKOUT';
    direction = 'BULLISH';
  } else if (last.close < support) {
    position = 'CLOSED-CANDLE SUPPORT BREAKDOWN';
    direction = 'BEARISH';
  } else if (last.low <= support + range * 0.15 && last.close > last.open) {
    position = 'POSSIBLE SUPPORT REJECTION';
    direction = 'BULLISH';
  } else if (last.high >= resistance - range * 0.15 && last.close < last.open) {
    position = 'POSSIBLE RESISTANCE REJECTION';
    direction = 'BEARISH';
  }

  return {
    support: round(support),
    resistance: round(resistance),
    position,
    direction,
    distanceToSupportPercent: last.close
      ? round((last.close - support) / last.close * 100, 5)
      : null,
    distanceToResistancePercent: last.close
      ? round((resistance - last.close) / last.close * 100, 5)
      : null
  };
}

function breakoutAnalysis(candles, levels) {
  if (candles.length < 5 || !finite(levels.resistance) || !finite(levels.support)) {
    return {
      status: 'UNAVAILABLE',
      direction: 'NEUTRAL',
      description: 'Insufficient candles for breakout/retest analysis.'
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const earlier = candles.slice(-6, -1);

  const priorHigh = Math.max(...earlier.map(candle => candle.high));
  const priorLow = Math.min(...earlier.map(candle => candle.low));

  if (last.close > priorHigh && previous.close <= priorHigh) {
    return {
      status: 'BREAKOUT',
      direction: 'BULLISH',
      level: round(priorHigh),
      description: 'Completed candle closed above the recent range.'
    };
  }

  if (last.close < priorLow && previous.close >= priorLow) {
    return {
      status: 'BREAKDOWN',
      direction: 'BEARISH',
      level: round(priorLow),
      description: 'Completed candle closed below the recent range.'
    };
  }

  if (previous.close > priorHigh && last.low <= priorHigh && last.close > priorHigh) {
    return {
      status: 'BULLISH_RETEST',
      direction: 'BULLISH',
      level: round(priorHigh),
      description: 'Price retested the breakout level and closed above it.'
    };
  }

  if (previous.close < priorLow && last.high >= priorLow && last.close < priorLow) {
    return {
      status: 'BEARISH_RETEST',
      direction: 'BEARISH',
      level: round(priorLow),
      description: 'Price retested the breakdown level and closed below it.'
    };
  }

  if (previous.close > priorHigh && last.close < priorHigh) {
    return {
      status: 'FALSE_BULLISH_BREAKOUT',
      direction: 'BEARISH',
      level: round(priorHigh),
      description: 'Price moved back inside the prior range after an upside break.'
    };
  }

  if (previous.close < priorLow && last.close > priorLow) {
    return {
      status: 'FALSE_BEARISH_BREAKOUT',
      direction: 'BULLISH',
      level: round(priorLow),
      description: 'Price moved back inside the prior range after a downside break.'
    };
  }

  return {
    status: 'NO_CONFIRMED_BREAKOUT',
    direction: 'NEUTRAL',
    description: 'No confirmed breakout or retest pattern.'
  };
}

function aggregateFiveMinute(candles) {
  const groups = new Map();

  for (const candle of candles) {
    const bucket = Math.floor(candle.time / 300000) * 300000;
    const existing = groups.get(bucket);

    if (!existing) {
      groups.set(bucket, {
        time: bucket,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        count: 1,
        lastTime: candle.time
      });
    } else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.count++;
      existing.lastTime = candle.time;
    }
  }

  return [...groups.values()]
    .filter(group =>
      group.count === 5 &&
      group.lastTime === group.time + 240000 &&
      group.time + 300000 <= Date.now()
    )
    .map(({ count, lastTime, ...candle }) => candle)
    .sort((a, b) => a.time - b.time);
}

function fiveMinuteConfirmation(candles) {
  const five = aggregateFiveMinute(candles);

  if (five.length < MIN_5M_CANDLES) {
    return {
      status: 'UNAVAILABLE',
      direction: 'NEUTRAL',
      candles: five.length,
      required: MIN_5M_CANDLES,
      reason: 'Not enough complete 5-minute candles aggregated from 1-minute data.'
    };
  }

  const closes = five.map(candle => candle.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const i = closes.length - 1;

  const direction = fast[i] > slow[i]
    ? 'BULLISH'
    : fast[i] < slow[i]
      ? 'BEARISH'
      : 'NEUTRAL';

  return {
    status: direction === 'NEUTRAL' ? 'MIXED' : 'CONFIRMED',
    direction,
    ema9: round(fast[i]),
    ema21: round(slow[i]),
    candles: five.length,
    lastCandle: iso(five[i].time),
    reason: `5-minute EMA9/EMA21 trend is ${direction}.`
  };
}

function volatilityRegime(atrValues, bbWidth, candles) {
  const i = atrValues.length - 1;
  const currentAtr = atrValues[i];
  const close = candles[i]?.close;
  const atrPercent = finite(currentAtr) && close
    ? currentAtr / close * 100
    : null;

  const widthValues = bbWidth.filter(finite);
  const currentWidth = bbWidth[i];

  if (!finite(atrPercent) || !finite(currentWidth) || widthValues.length < 30) {
    return {
      regime: 'UNAVAILABLE',
      atr: round(currentAtr),
      atrPercent: round(atrPercent, 5),
      bollingerWidth: round(currentWidth, 5)
    };
  }

  const sorted = [...widthValues].sort((a, b) => a - b);
  const lowThreshold = sorted[Math.floor((sorted.length - 1) * 0.25)];
  const highThreshold = sorted[Math.floor((sorted.length - 1) * 0.75)];

  const regime = currentWidth <= lowThreshold
    ? 'LOW'
    : currentWidth >= highThreshold
      ? 'HIGH'
      : 'NORMAL';

  return {
    regime,
    atr: round(currentAtr),
    atrPercent: round(atrPercent, 5),
    bollingerWidth: round(currentWidth, 5),
    lowWidthThreshold: round(lowThreshold, 5),
    highWidthThreshold: round(highThreshold, 5)
  };
}

/* -------------------------------------------------------
   SIGNAL ANALYSIS
------------------------------------------------------- */

function emptyMarket(pair = 'NO MARKET', reason = 'No usable market data.') {
  return {
    pair,
    timeframe: 1,
    signal: 'NO TRADE',
    confidence: null,
    callScore: 0,
    putScore: 0,
    gap: 0,
    entryTime: null,
    expiryTime: null,
    currentPrice: null,
    entryPrice: null,
    freshness: 'NO DATA',
    dataAgeSeconds: null,
    lastCandle: null,
    indicators: {},
    reasons: [reason],
    source: 'Twelve Data LIVE',
    newsStatus: 'NOT_CONFIGURED',
    fundamentalStatus: 'NOT_CONFIGURED',
    evidenceLabel: 'Evidence score, not win probability'
  };
}

function scoreMarket(rawCandles, pair, fetchedAt) {
  const now = Date.now();
  const candles = closedCandles(rawCandles, now);
  const last = candles[candles.length - 1];

  if (!last) return emptyMarket(pair, 'No completed 1-minute candles.');

  const age = Math.max(0, (now - (last.time + 60000)) / 1000);
  const freshness = age <= FRESHNESS_SECONDS
    ? 'FRESH'
    : age <= HARD_STALE_SECONDS
      ? 'STALE'
      : 'HARD STALE';

  const closes = candles.map(candle => candle.close);
  const i = candles.length - 1;
  const p = i - 1;

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsi14 = rsi(closes, 14);
  const mc = macd(closes);
  const atr14 = atr(candles, 14);
  const bb = bollinger(closes, 20, 2);

  const emaCross = crossover(ema9[p], ema21[p], ema9[i], ema21[i]);
  const macdCross = crossover(mc.line[p], mc.signal[p], mc.line[i], mc.signal[i]);

  const divergence = findRsiDivergence(candles, rsi14);
  const pattern = candlePattern(candles);
  const psychology = marketPsychology(candles);
  const levels = supportResistance(candles);
  const line = trendLine(candles);
  const breakout = breakoutAnalysis(candles, levels);
  const confirmation5m = fiveMinuteConfirmation(candles);
  const volatility = volatilityRegime(atr14, bb.width, candles);

  let callScore = 0;
  let putScore = 0;
  const reasons = [];

  function add(direction, points, reason) {
    if (direction === 'BULLISH') callScore += points;
    if (direction === 'BEARISH') putScore += points;
    if (direction !== 'NEUTRAL' && points > 0) reasons.push(reason);
  }

  const patternPoints = {
    'BULLISH ENGULFING': 12,
    'BEARISH ENGULFING': 12,
    'HAMMER': 8,
    'SHOOTING STAR': 8,
    'MORNING STAR': 12,
    'EVENING STAR': 12,
    'PIERCING LINE': 8,
    'DARK CLOUD COVER': 8,
    'BULLISH HARAMI': 6,
    'BEARISH HARAMI': 6
  };

  add(pattern.direction, patternPoints[pattern.name] || 0,
    `Candlestick pattern: ${pattern.name}.`);

  add(psychology.direction, 8,
    `Market psychology: ${psychology.psychology}.`);

  add(levels.direction, 10,
    `Support/resistance: ${levels.position}.`);

  add(line.direction, 8,
    `Trendline direction: ${line.direction}.`);

  if (emaCross === 'BULLISH_CROSSOVER') {
    add('BULLISH', 7, 'EMA9 crossed above EMA21.');
  } else if (emaCross === 'BEARISH_CROSSOVER') {
    add('BEARISH', 7, 'EMA9 crossed below EMA21.');
  } else if (finite(ema9[i]) && finite(ema21[i])) {
    if (ema9[i] > ema21[i]) add('BULLISH', 3, 'EMA9 is above EMA21.');
    if (ema9[i] < ema21[i]) add('BEARISH', 3, 'EMA9 is below EMA21.');
  }

  if (finite(rsi14[i]) && finite(rsi14[p])) {
    if (rsi14[p] < 30 && rsi14[i] >= 30) {
      add('BULLISH', 5, 'RSI14 recovered above 30.');
    } else if (rsi14[p] > 70 && rsi14[i] <= 70) {
      add('BEARISH', 5, 'RSI14 fell below 70.');
    } else if (rsi14[i] > 50 && rsi14[i] < 70) {
      add('BULLISH', 2, 'RSI14 supports positive momentum.');
    } else if (rsi14[i] < 50 && rsi14[i] > 30) {
      add('BEARISH', 2, 'RSI14 supports negative momentum.');
    }
  }

  add(divergence.direction, 8,
    `RSI divergence: ${divergence.type}.`);

  if (macdCross === 'BULLISH_CROSSOVER') {
    add('BULLISH', 6, 'MACD bullish crossover.');
  } else if (macdCross === 'BEARISH_CROSSOVER') {
    add('BEARISH', 6, 'MACD bearish crossover.');
  } else if (finite(mc.histogram[i]) && finite(mc.histogram[p])) {
    if (mc.histogram[i] > mc.histogram[p] && mc.histogram[i] > 0) {
      add('BULLISH', 2, 'MACD histogram is strengthening above zero.');
    } else if (mc.histogram[i] < mc.histogram[p] && mc.histogram[i] < 0) {
      add('BEARISH', 2, 'MACD histogram is strengthening below zero.');
    }
  }

  add(breakout.direction,
    breakout.status.includes('RETEST') ? 8 :
      breakout.status.includes('FALSE') ? 6 : 5,
    `Breakout analysis: ${breakout.status}.`);

  // The 5m filter is a confirmation gate, not an extra indicator score.
  const direction = callScore > putScore
    ? 'BULLISH'
    : putScore > callScore
      ? 'BEARISH'
      : 'NEUTRAL';

  const winning = Math.max(callScore, putScore);
  const opposing = Math.min(callScore, putScore);
  const gap = Math.abs(callScore - putScore);

  const guards = [];

  if (candles.length < MIN_CANDLES) {
    guards.push(`Fewer than ${MIN_CANDLES} completed 1-minute candles.`);
  }

  if (freshness !== 'FRESH') {
    guards.push('Market data is not fresh.');
  }

  if (confirmation5m.status === 'UNAVAILABLE') {
    guards.push('5-minute trend confirmation is unavailable.');
  } else if (confirmation5m.direction !== direction) {
    guards.push('5-minute trend confirmation conflicts with the 1-minute direction.');
  }

  if (volatility.regime === 'UNAVAILABLE') {
    guards.push('Volatility regime cannot be calculated reliably.');
  } else if (volatility.regime === 'HIGH') {
    guards.push('High-volatility regime: directional signal is withheld.');
  }

  if (!finite(rsi14[i]) || !finite(ema9[i]) || !finite(ema21[i]) ||
      !finite(mc.histogram[i]) || !finite(atr14[i]) ||
      !finite(bb.width[i]) || line.direction === 'UNAVAILABLE' ||
      levels.position === 'UNAVAILABLE') {
    guards.push('One or more required technical measurements are unavailable.');
  }

  if (direction === 'NEUTRAL' || gap < MIN_SCORE_GAP) {
    guards.push('Directional evidence conflicts or score gap is too small.');
  }

  if (winning < MIN_SIGNAL_SCORE) {
    guards.push('Evidence score is below the minimum threshold.');
  }

  if (opposing >= 25) {
    guards.push('Opposing directional evidence is material.');
  }

  if (breakout.status === 'FALSE_BULLISH_BREAKOUT' ||
      breakout.status === 'FALSE_BEARISH_BREAKOUT') {
    guards.push('False-breakout risk detected.');
  }

  const signal = guards.length
    ? 'NO TRADE'
    : direction === 'BULLISH'
      ? 'BUY'
      : 'SELL';

  reasons.push(...guards.map(reason => `NO TRADE: ${reason}`));

  const nextMinute = (Math.floor(now / 60000) + 1) * 60000;
  const entryTime = nextMinute;
  const expiryTime = entryTime + 60000;

  const result = {
    pair,
    timeframe: 1,
    signal,
    confidence: signal === 'NO TRADE' ? null : Math.min(100, winning),
    callScore: round(callScore, 0),
    putScore: round(putScore, 0),
    gap: round(gap, 0),
    entryTime: signal === 'NO TRADE' ? null : iso(entryTime),
    expiryTime: signal === 'NO TRADE' ? null : iso(expiryTime),
    currentPrice: last.close,
    entryPrice: null,
    entryPriceStatus: 'WAITING_FOR_ENTRY_PRICE',
    freshness,
    dataAgeSeconds: round(age, 1),
    lastCandle: iso(last.time),
    fetchedAt: iso(fetchedAt),
    supportResistance: levels,
    trendLine: line,
    marketPsychology: psychology.psychology,
    priceAction: levels.position,
    candlePattern: pattern,
    breakout,
    confirmation5m,
    volatility,
    indicators: {
      ema9: round(ema9[i]),
      ema21: round(ema21[i]),
      emaCross,
      rsi14: round(rsi14[i], 2),
      rsiDivergence: divergence,
      macd: {
        line: round(mc.line[i]),
        signal: round(mc.signal[i]),
        histogram: round(mc.histogram[i]),
        crossover: macdCross
      },
      atr14: round(atr14[i]),
      bollinger: {
        upper: round(bb.upper[i]),
        middle: round(bb.middle[i]),
        lower: round(bb.lower[i]),
        width: round(bb.width[i], 5)
      }
    },
    reasons,
    source: 'Twelve Data LIVE',
    newsStatus: 'NOT_CONFIGURED',
    fundamentalStatus: 'NOT_CONFIGURED',
    evidenceLabel: 'Evidence score, not win probability'
  };

  if (signal !== 'NO TRADE') {
    const signalKey = `${pair}-${signal}-${last.time}-${VERSION}`;
    void saveSignal({
      id: signalKey,
      pair,
      signal,
      evidenceScore: result.confidence,
      entryTime: result.entryTime,
      expiryTime: result.expiryTime,
      referencePrice: null,
      outcome: 'PENDING',
      createdAt: iso(now),
      technicalSnapshot: {
        emaCross,
        rsi14: result.indicators.rsi14,
        divergence,
        macdCross,
        pattern,
        psychology,
        levels,
        line,
        breakout,
        confirmation5m,
        volatility
      }
    });
  }

  return result;
}

/* -------------------------------------------------------
   FRESHNESS, SCANNER AND SELECTION
------------------------------------------------------- */

function evaluateFreshness(market, now = Date.now()) {
  if (!market || Number(market.timeframe) !== 1) {
    return {
      ...(market || emptyMarket()),
      freshness: 'NO DATA',
      signal: 'NO TRADE',
      confidence: null
    };
  }

  const candleOpen = Date.parse(market.lastCandle || '');

  if (!Number.isFinite(candleOpen)) {
    return {
      ...market,
      freshness: 'NO DATA',
      dataAgeSeconds: null,
      signal: 'NO TRADE',
      confidence: null
    };
  }

  const age = Math.max(0, (now - (candleOpen + 60000)) / 1000);
  const freshness = age <= FRESHNESS_SECONDS
    ? 'FRESH'
    : age <= HARD_STALE_SECONDS
      ? 'STALE'
      : 'HARD STALE';

  if (freshness === 'FRESH') {
    return { ...market, freshness, dataAgeSeconds: round(age, 1) };
  }

  return {
    ...market,
    freshness,
    dataAgeSeconds: round(age, 1),
    signal: 'NO TRADE',
    confidence: null,
    reasons: [
      ...(Array.isArray(market.reasons) ? market.reasons : []),
      'NO TRADE: latest completed candle is stale.'
    ]
  };
}

function rankCandidates(markets) {
  const priorityIndex = new Map(PRIORITY_PAIRS.map((pair, index) => [pair, index]));

  return markets
    .map(evaluateFreshness)
    .sort((a, b) => {
      const aTrade = a.freshness === 'FRESH' && a.signal !== 'NO TRADE';
      const bTrade = b.freshness === 'FRESH' && b.signal !== 'NO TRADE';

      return Number(bTrade) - Number(aTrade) ||
        Number(b.freshness === 'FRESH') - Number(a.freshness === 'FRESH') ||
        Math.max(b.callScore || 0, b.putScore || 0) -
          Math.max(a.callScore || 0, a.putScore || 0) ||
        (priorityIndex.get(a.pair) ?? 999) -
          (priorityIndex.get(b.pair) ?? 999);
    })
    .map((market, index) => ({
      rank: index + 1,
      pair: market.pair,
      timeframe: 1,
      signal: market.signal,
      confidence: market.confidence,
      callScore: market.callScore,
      putScore: market.putScore,
      gap: market.gap,
      freshness: market.freshness,
      dataAgeSeconds: market.dataAgeSeconds,
      entryTime: market.entryTime,
      reason: market.reasons?.[0] || 'Evidence review.'
    }));
}

function makeResponse(selectedMarket, rankedCandidates = [], extra = {}) {
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
      mode: 'PRIORITY + BACKGROUND LIVE FOREX',
      phase: scanProgress.phase,
      batchSize: PRIORITY_PAIRS.length,
      pairs: PAIRS.length,
      priorityPairs: PRIORITY_PAIRS,
      backgroundPairs: BACKGROUND_PAIRS,
      progress: { ...scanProgress },
      cooldownRemainingMs: Math.max(
        0,
        SCAN_COOLDOWN_MS - (Date.now() - lastScanStartedAtMs)
      )
    },
    metadata: metadata(),
    source: 'Twelve Data LIVE',
    diagnostic: { lastScanError },
    ...extra
  };
}

function selectBestMarket(markets) {
  const ranked = rankCandidates(markets);
  const best = ranked.find(market =>
    market.freshness === 'FRESH' && market.signal !== 'NO TRADE'
  );

  if (best) {
    return { selected: latestMarkets.get(best.pair), ranked };
  }

  const diagnostic = markets
    .map(evaluateFreshness)
    .sort((a, b) =>
      Number(b.freshness === 'FRESH') - Number(a.freshness === 'FRESH') ||
      Math.max(b.callScore || 0, b.putScore || 0) -
        Math.max(a.callScore || 0, a.putScore || 0)
    )[0];

  return { selected: diagnostic || emptyMarket(), ranked };
}

function getCurrentAnalysis() {
  const markets = [...latestMarkets.values()].map(evaluateFreshness);
  const result = selectBestMarket(markets);

  return {
    selectedMarket: result.selected || emptyMarket(
      'NO MARKET',
      API_KEY ? 'Priority scan is required.' : 'Twelve Data API key is not configured.'
    ),
    rankedCandidates: result.ranked
  };
}

function refreshCandidates() {
  const result = getCurrentAnalysis();
  cachedResult = makeResponse(result.selectedMarket, result.rankedCandidates);
}

async function processPair(pair, phase) {
  try {
    let data = await getPairData(pair, false);
    let market = scoreMarket(data.candles, pair, data.fetchedAt);
    market = evaluateFreshness(market);

    if (market.freshness !== 'FRESH') {
      data = await getPairData(pair, true);
      market = evaluateFreshness(scoreMarket(data.candles, pair, data.fetchedAt));
    }

    latestMarkets.set(pair, market);
    return { pair, phase, success: true, market };
  } catch (error) {
    lastScanError = `${pair}: ${String(error.message || error)}`;
    return { pair, phase, success: false, error: lastScanError };
  } finally {
    refreshCandidates();
  }
}

async function scanBatch() {
  if (scannerRunning || !API_KEY) return;

  scannerRunning = true;
  scannerStartedAt = iso(Date.now());
  lastScanStartedAtMs = Date.now();
  lastScanError = null;

  scanProgress = {
    phase: 'PRIORITY',
    completed: 0,
    total: PAIRS.length,
    priorityCompleted: 0,
    priorityTotal: PRIORITY_PAIRS.length,
    backgroundCompleted: 0,
    backgroundTotal: BACKGROUND_PAIRS.length,
    pair: null
  };

  try {
    for (const pair of PRIORITY_PAIRS) {
      scanProgress.phase = 'PRIORITY';
      scanProgress.pair = pair;
      await processPair(pair, 'PRIORITY');
      scanProgress.priorityCompleted++;
      scanProgress.completed++;
    }

    for (const pair of BACKGROUND_PAIRS) {
      scanProgress.phase = 'BACKGROUND';
      scanProgress.pair = pair;
      await processPair(pair, 'BACKGROUND');
      scanProgress.backgroundCompleted++;
      scanProgress.completed++;
    }

    totalScanned += scanProgress.completed;
    lastScanAt = iso(Date.now());
  } finally {
    scannerRunning = false;
    scanProgress.phase = 'IDLE';
    scanProgress.pair = null;
    refreshCandidates();
  }
}

function startScanIfPossible() {
  if (!API_KEY || scannerRunning) return false;

  const remaining = Math.max(
    0,
    SCAN_COOLDOWN_MS - (Date.now() - lastScanStartedAtMs)
  );

  if (lastScanStartedAtMs && remaining > 0) return false;

  resetDailyCounter();

  if (DAILY_USABLE_LIMIT - dailyCreditsUsed < 1) {
    lastScanError = 'Daily Twelve Data safety limit reached.';
    return false;
  }

  void scanBatch().catch(error => {
    lastScanError = String(error.message || error);
    scannerRunning = false;
    scanProgress.phase = 'IDLE';
    scanProgress.pair = null;
    refreshCandidates();
  });

  return true;
}

/* -------------------------------------------------------
   WALK-FORWARD BACKTEST
   Uses chronological data and does not claim predictive certainty.
------------------------------------------------------- */

function evaluateHistoricalDirection(candles, index) {
  const sample = candles.slice(0, index + 1);
  if (sample.length < MIN_CANDLES) return null;

  const closes = sample.map(candle => candle.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const rsiValues = rsi(closes, 14);
  const macdValues = macd(closes);
  const i = sample.length - 1;

  if (![fast[i], slow[i], rsiValues[i], macdValues.histogram[i]].every(finite)) {
    return null;
  }

  let score = 0;
  if (fast[i] > slow[i]) score += 2;
  if (fast[i] < slow[i]) score -= 2;
  if (rsiValues[i] > 50) score += 1;
  if (rsiValues[i] < 50) score -= 1;
  if (macdValues.histogram[i] > 0) score += 1;
  if (macdValues.histogram[i] < 0) score -= 1;

  if (score >= 3) return 'BUY';
  if (score <= -3) return 'SELL';
  return null;
}

function runWalkForward(candles, expiryMinutes = 1) {
  const horizon = Math.max(1, Math.min(3, Number(expiryMinutes) || 1));
  const start = Math.max(MIN_CANDLES, Math.floor(candles.length * 0.5));
  const split = Math.floor(candles.length * 0.7);

  let developmentSignals = 0;
  let developmentHits = 0;
  let holdoutSignals = 0;
  let holdoutHits = 0;
  let totalSignals = 0;

  for (let i = start; i + horizon < candles.length; i++) {
    const direction = evaluateHistoricalDirection(candles, i);
    if (!direction) continue;

    const entry = candles[i].close;
    const exit = candles[i + horizon].close;
    const hit = direction === 'BUY' ? exit > entry : exit < entry;

    totalSignals++;

    if (i < split) {
      developmentSignals++;
      if (hit) developmentHits++;
    } else {
      holdoutSignals++;
      if (hit) holdoutHits++;
    }
  }

  const developmentRate = developmentSignals
    ? developmentHits / developmentSignals * 100
    : null;

  const holdoutRate = holdoutSignals
    ? holdoutHits / holdoutSignals * 100
    : null;

  const baseline = 50;
  const sufficient = holdoutSignals >= BACKTEST_MIN_SIGNALS;

  return {
    method: 'CHRONOLOGICAL WALK-FORWARD',
    lookAheadBiasControl: 'Each historical decision uses candles available only up to that point.',
    expiryMinutes: horizon,
    candles: candles.length,
    development: {
      signals: developmentSignals,
      hits: developmentHits,
      hitRate: round(developmentRate, 2)
    },
    holdout: {
      signals: holdoutSignals,
      hits: holdoutHits,
      hitRate: round(holdoutRate, 2),
      baselinePercent: baseline,
      sufficientSample: sufficient
    },
    totalSignals,
    conclusion: !sufficient
      ? 'INSUFFICIENT HOLDOUT SAMPLE — no performance claim.'
      : holdoutRate > baseline
        ? 'Holdout result exceeded the 50% directional reference in this sample; not a guarantee.'
        : 'Holdout result did not exceed the 50% directional reference.',
    warning: 'Historical backtest results do not predict or guarantee future outcomes.'
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
    scannerMode: 'PRIORITY + BACKGROUND',
    scannerStartedAt,
    lastScanAt,
    totalScanned,
    priorityPairs: PRIORITY_PAIRS,
    backgroundPairs: BACKGROUND_PAIRS,
    scanProgress: { ...scanProgress },
    cooldownRemainingMs: Math.max(
      0,
      SCAN_COOLDOWN_MS - (Date.now() - lastScanStartedAtMs)
    ),
    newsStatus: 'NOT_CONFIGURED',
    fundamentalStatus: 'NOT_CONFIGURED',
    metadata: metadata()
  });
});

app.get('/api/best', (_req, res) => {
  const analysis = getCurrentAnalysis();
  res.json(makeResponse(analysis.selectedMarket, analysis.rankedCandidates));
});

app.get('/api/analyze', async (req, res) => {
  const requestedPair = req.query.pair
    ? normalizePair(req.query.pair)
    : null;

  if (req.query.pair && !requestedPair) {
    return res.status(400).json({
      ok: false,
      version: VERSION,
      error: 'Invalid pair. Select one of the supported 24 LIVE forex pairs.'
    });
  }

  if (requestedPair) {
    try {
      const data = await getPairData(requestedPair, false);
      let market = scoreMarket(data.candles, requestedPair, data.fetchedAt);
      market = evaluateFreshness(market);

      if (market.freshness !== 'FRESH') {
        const refreshed = await getPairData(requestedPair, true);
        market = evaluateFreshness(
          scoreMarket(refreshed.candles, requestedPair, refreshed.fetchedAt)
        );
      }

      latestMarkets.set(requestedPair, market);

      const all = getCurrentAnalysis();
      return res.json(makeResponse(
        market,
        all.rankedCandidates,
        {
          selectedPair: requestedPair,
          analysisMode: 'USER SELECTED PAIR',
          note: `Analysis is for the selected pair ${requestedPair}.`
        }
      ));
    } catch (error) {
      return res.status(503).json({
        ok: false,
        version: VERSION,
        selectedPair: requestedPair,
        error: String(error.message || error),
        selectedMarket: emptyMarket(requestedPair, 'Selected-pair analysis failed.')
      });
    }
  }

  const analysis = getCurrentAnalysis();
  const scanStarted = startScanIfPossible();

  return res.json(makeResponse(
    analysis.selectedMarket,
    analysis.rankedCandidates,
    {
      analysisMode: 'BEST AVAILABLE SCANNER RESULT',
      scanStarted,
      note: analysis.rankedCandidates.length
        ? 'Showing currently available market results while scanner updates in background.'
        : 'No scored market data is available yet. A priority scan has been requested.'
    }
  ));
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
      error: 'Scanner is already running.',
      scanner: { running: true, progress: { ...scanProgress } }
    });
  }

  const remaining = Math.max(
    0,
    SCAN_COOLDOWN_MS - (Date.now() - lastScanStartedAtMs)
  );

  if (lastScanStartedAtMs && remaining > 0) {
    return res.status(429).json({
      ok: false,
      version: VERSION,
      error: 'Please wait before starting another scan.',
      cooldownRemainingMs: remaining
    });
  }

  const started = startScanIfPossible();

  return res.status(started ? 202 : 429).json({
    ok: started,
    version: VERSION,
    message: started ? 'LIVE forex scan started.' : 'Scan could not start.',
    scanner: {
      running: scannerRunning,
      progress: { ...scanProgress },
      priorityPairs: PRIORITY_PAIRS,
      backgroundPairs: BACKGROUND_PAIRS
    }
  });
});

app.get('/api/history', async (req, res) => {
  const history = await getHistory(req.query.limit);

  res.json({
    ok: true,
    version: VERSION,
    storage: databaseReady ? 'POSTGRESQL' : 'MEMORY_ONLY',
    persistent: databaseReady,
    count: history.length,
    history
  });
});

app.get('/api/backtest', async (req, res) => {
  const pair = normalizePair(req.query.pair || 'EUR/USD');
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
      note: 'Backtest depth is limited by the historical candles supplied by the provider.'
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
   STARTUP
------------------------------------------------------- */

if (require.main === module) {
  initializeDatabase().finally(() => {
    app.listen(PORT, () => {
      console.log(`PO AI Predictor ${VERSION} listening on ${PORT}`);
      console.log('Mode: LIVE FOREX ONLY');
      console.log(`Twelve Data configured: ${Boolean(API_KEY)}`);
      console.log(`PostgreSQL configured: ${Boolean(DATABASE_URL)}`);
    });
  });
}

module.exports = app;
