'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const VERSION = 'V10.4.0';
const PORT = Number(process.env.PORT || 10000);

const API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVE_DATA_KEY ||
  '';

const DATABASE_URL = process.env.DATABASE_URL || '';
const PROVIDER_URL = 'https://api.twelvedata.com/time_series';

/*
 * LIVE FOREX ONLY
 * OTC pairs are intentionally excluded.
 */

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

const PAIRS = [
  ...PRIORITY_PAIRS,
  ...BACKGROUND_PAIRS
];

/*
 * Twelve Data request protection.
 *
 * 24 pairs need approximately 4 minutes per complete
 * sweep at the configured 6 requests/minute limit.
 *
 * One scheduled sweep per hour uses approximately
 * 576 requests/day, leaving room for manual analysis
 * and confirmation requests.
 */

const DAILY_REQUEST_LIMIT = 768;
const DAILY_RESERVE = 32;

const DAILY_USABLE_LIMIT =
  DAILY_REQUEST_LIMIT - DAILY_RESERVE;

const SCANNER_DAILY_BUDGET = 576;
const SCAN_INTERVAL_MS = 60 * 60 * 1000;

const REQUESTS_PER_MINUTE = 6;
const REQUEST_SPACING_MS = 10000;
const PROVIDER_TIMEOUT_MS = 12000;

const PAIR_CACHE_MS = 90000;

const FRESHNESS_SECONDS = 150;
const HARD_STALE_SECONDS = 300;

const SCAN_COOLDOWN_MS = 60000;

const MIN_CANDLES = 60;
const MIN_5M_CANDLES = 30;

/*
 * These thresholds are retained until proper
 * walk-forward tests justify changing them.
 *
 * Evidence score is NOT win probability.
 */

const MIN_SIGNAL_SCORE = 55;
const MIN_SCORE_GAP = 12;
const MIN_OPPOSING_SCORE = 25;

const BROKER_PRICE_MAX_AGE_MS = 30000;
const DEFAULT_MAX_PRICE_GAP_PIPS = 3;

const BACKTEST_MIN_SIGNALS = 30;
const HISTORY_LIMIT = 5000;

/* -------------------------------------------------------
   APPLICATION STATE
------------------------------------------------------- */

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
let scannerCreditsUsed = 0;

let dailyDate = new Date().toISOString().slice(0, 10);

let requestTimes = [];
let lastProviderRequestAt = 0;
let requestQueue = Promise.resolve();

let scannerRunning = false;
let backgroundScanTimer = null;

let scannerStartedAt = null;
let lastScanAt = null;
let lastScanStartedAtMs = 0;

let totalScanned = 0;
let lastScanError = null;

let scanProgress = {
  phase: 'IDLE',
  completed: 0,
  total: 24,

  priorityCompleted: 0,
  priorityTotal: 6,

  backgroundCompleted: 0,
  backgroundTotal: 18,

  pair: null
};

/* -------------------------------------------------------
   COMMON HELPERS
------------------------------------------------------- */

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

function priceDifferencePips(
  pair,
  brokerPrice,
  referencePrice
) {
  return Math.abs(brokerPrice - referencePrice) /
    pipSize(pair);
}

/* -------------------------------------------------------
   DAILY REQUEST COUNTERS
------------------------------------------------------- */

function resetDailyCounter() {
  const today = new Date().toISOString().slice(0, 10);

  if (today !== dailyDate) {
    dailyDate = today;

    dailyCreditsUsed = 0;
    scannerCreditsUsed = 0;

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

    scannerCreditsUsed,
    scannerDailyBudget: SCANNER_DAILY_BUDGET,

    scannerCreditsRemaining: Math.max(
      0,
      SCANNER_DAILY_BUDGET - scannerCreditsUsed
    ),

    requestsPerMinuteLimit: REQUESTS_PER_MINUTE,

    cachedPairs: pairCache.size,

    priorityPairs: PRIORITY_PAIRS.length,
    backgroundPairs: BACKGROUND_PAIRS.length,
    totalPairs: PAIRS.length,

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

    databaseError = String(
      error.message || error
    );

    console.error(
      'PostgreSQL initialization failed:',
      databaseError
    );
  }
}

async function saveSignal(record) {
  if (
    !record ||
    !record.id ||
    signalKeys.has(record.id)
  ) {
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
    databaseError = String(
      error.message || error
    );
  }
}

async function updateSignalOutcome(
  id,
  outcome,
  outcomePrice
) {
  const record = signalHistory.find(
    item => item.id === id
  );

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
    databaseError = String(
      error.message || error
    );
  }
}

async function getHistory(limit = 100) {
  const count = clamp(
    Number(limit) || 100,
    1,
    500
  );

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
      databaseError = String(
        error.message || error
      );
    }
  }

  return signalHistory.slice(0, count);
}

/* -------------------------------------------------------
   TWELVE DATA PROVIDER QUEUE
------------------------------------------------------- */

function enqueueProviderRequest(task) {
  const promise = requestQueue.then(task, task);

  requestQueue = promise.catch(() => {});

  return promise;
}

async function providerFetch(pair, requestSource = 'manual') {
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

      if (
        requestSource === 'scanner' &&
        scannerCreditsUsed >= SCANNER_DAILY_BUDGET
      ) {
        throw new Error(
          'Daily background scanner budget reached.'
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

      const wait = Math.max(
        minuteWait,
        spacingWait
      );

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

    if (requestSource === 'scanner') {
      scannerCreditsUsed++;
    }

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      PROVIDER_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        }
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
        error.message ||
        'Twelve Data request failed.'
      );

    } finally {
      clearTimeout(timer);
    }
  });
}
function normalizeCandles(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      const time = String(row.datetime || row.time || '');
      const open = finite(row.open);
      const high = finite(row.high);
      const low = finite(row.low);
      const close = finite(row.close);
      const volume = finite(row.volume);

      if (
        !time ||
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        high < low
      ) {
        return null;
      }

      return {
        time,
        timestamp: Date.parse(time.replace(' ', 'T') + (time.includes('Z') ? '' : 'Z')),
        open,
        high,
        low,
        close,
        volume: volume === null ? 0 : volume
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter((candle, index, all) =>
      index === 0 || candle.timestamp > all[index - 1].timestamp
    );
}

function candleIsClosed(candle, now = Date.now()) {
  if (!candle || !Number.isFinite(candle.timestamp)) return false;
  return now - candle.timestamp >= 60000;
}

function getClosedCandles(candles, now = Date.now()) {
  return (Array.isArray(candles) ? candles : [])
    .filter((candle) => candleIsClosed(candle, now));
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) {
    return [];
  }

  const multiplier = 2 / (period + 1);
  const output = new Array(values.length).fill(null);

  let seed = 0;
  for (let i = 0; i < period; i += 1) {
    seed += values[i];
  }

  let previous = seed / period;
  output[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    previous = (values[i] - previous) * multiplier + previous;
    output[i] = previous;
  }

  return output;
}

function calculateRsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    averageGain = ((averageGain * (period - 1)) + gain) / period;
    averageLoss = ((averageLoss * (period - 1)) + loss) / period;
  }

  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

function calculateMacd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);

  const macdLine = values.map((_, index) => {
    if (fast[index] === null || slow[index] === null) return null;
    return fast[index] - slow[index];
  });

  const validMacd = macdLine.filter((value) => value !== null);
  const signalValid = ema(validMacd, 9);
  let signalIndex = 0;

  const signalLine = macdLine.map((value) => {
    if (value === null) return null;
    const result = signalValid[signalIndex];
    signalIndex += 1;
    return result === undefined ? null : result;
  });

  const histogram = macdLine.map((value, index) => {
    if (value === null || signalLine[index] === null) return null;
    return value - signalLine[index];
  });

  return {
    macd: macdLine[macdLine.length - 1] ?? null,
    signal: signalLine[signalLine.length - 1] ?? null,
    histogram: histogram[histogram.length - 1] ?? null,
    previousHistogram: histogram.length > 1
      ? histogram[histogram.length - 2]
      : null
  };
}

function calculateAtr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  const recent = ranges.slice(-period);
  if (recent.length < period) return null;

  return recent.reduce((sum, value) => sum + value, 0) / period;
}

function calculateBollinger(values, period = 20, multiplier = 2) {
  if (!Array.isArray(values) || values.length < period) return null;

  const recent = values.slice(-period);
  const middle = recent.reduce((sum, value) => sum + value, 0) / period;

  const variance = recent.reduce(
    (sum, value) => sum + Math.pow(value - middle, 2),
    0
  ) / period;

  const deviation = Math.sqrt(variance);
  const upper = middle + deviation * multiplier;
  const lower = middle - deviation * multiplier;

  return {
    middle,
    upper,
    lower,
    width: middle !== 0 ? ((upper - lower) / middle) * 100 : null,
    position: upper !== lower
      ? (recent[recent.length - 1] - lower) / (upper - lower)
      : 0.5
  };
}

function calculateCandlePatterns(candles) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return {
      direction: 'NEUTRAL',
      patterns: [],
      strength: 0
    };
  }

  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const body = Math.abs(current.close - current.open);
  const range = Math.max(current.high - current.low, 1e-10);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;

  const previousBullish = previous.close > previous.open;
  const previousBearish = previous.close < previous.open;
  const currentBullish = current.close > current.open;
  const currentBearish = current.close < current.open;

  const patterns = [];
  let direction = 'NEUTRAL';
  let strength = 0;

  if (
    previousBearish &&
    currentBullish &&
    current.open <= previous.close &&
    current.close >= previous.open
  ) {
    patterns.push('BULLISH_ENGULFING');
    direction = 'BUY';
    strength = Math.max(strength, 2);
  }

  if (
    previousBullish &&
    currentBearish &&
    current.open >= previous.close &&
    current.close <= previous.open
  ) {
    patterns.push('BEARISH_ENGULFING');
    direction = 'SELL';
    strength = Math.max(strength, 2);
  }

  if (
    body / range <= 0.30 &&
    lowerWick >= body * 2 &&
    upperWick <= Math.max(body * 1.2, range * 0.15)
  ) {
    patterns.push('HAMMER');
    if (current.close >= current.open) {
      direction = 'BUY';
      strength = Math.max(strength, 1);
    }
  }

  if (
    body / range <= 0.30 &&
    upperWick >= body * 2 &&
    lowerWick <= Math.max(body * 1.2, range * 0.15)
  ) {
    patterns.push('SHOOTING_STAR');
    if (current.close <= current.open) {
      direction = 'SELL';
      strength = Math.max(strength, 1);
    }
  }

  if (body / range <= 0.10) {
    patterns.push('DOJI');
  }

  if (patterns.length === 0 && currentBullish) {
    patterns.push('BULLISH_CANDLE');
    direction = 'BUY';
    strength = 0.5;
  } else if (patterns.length === 0 && currentBearish) {
    patterns.push('BEARISH_CANDLE');
    direction = 'SELL';
    strength = 0.5;
  }

  return { direction, patterns, strength };
}

function calculateSupportResistance(candles, lookback = 40) {
  const recent = candles.slice(-lookback);

  if (recent.length < 10) {
    return {
      support: null,
      resistance: null,
      nearestDistancePips: null
    };
  }

  const lows = recent.map((candle) => candle.low);
  const highs = recent.map((candle) => candle.high);

  const support = Math.min(...lows);
  const resistance = Math.max(...highs);
  const price = recent[recent.length - 1].close;

  const pip = pipSize('EUR/USD');
  const nearestDistance = Math.min(
    Math.abs(price - support),
    Math.abs(resistance - price)
  );

  return {
    support,
    resistance,
    nearestDistancePips: pip > 0 ? nearestDistance / pip : null,
    supportDistance: price - support,
    resistanceDistance: resistance - price
  };
}

function calculateTrendline(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  if (recent.length < 8) return { direction: 'NEUTRAL', slope: 0 };

  const first = recent[0].close;
  const last = recent[recent.length - 1].close;
  const change = last - first;
  const threshold = Math.abs(first) * 0.00005;

  if (change > threshold) {
    return { direction: 'BUY', slope: change / recent.length };
  }

  if (change < -threshold) {
    return { direction: 'SELL', slope: change / recent.length };
  }

  return { direction: 'NEUTRAL', slope: change / recent.length };
}

function aggregateFiveMinute(candles) {
  const groups = new Map();

  for (const candle of candles) {
    const bucket = Math.floor(candle.timestamp / 300000) * 300000;

    if (!groups.has(bucket)) {
      groups.set(bucket, {
        timestamp: bucket,
        time: new Date(bucket).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      });
    } else {
      const group = groups.get(bucket);
      group.high = Math.max(group.high, candle.high);
      group.low = Math.min(group.low, candle.low);
      group.close = candle.close;
      group.volume += candle.volume;
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => a.timestamp - b.timestamp
  );
}

function calculateMarketPsychology(candles) {
  const recent = candles.slice(-10);
  if (recent.length < 5) {
    return { direction: 'NEUTRAL', score: 0, description: 'Insufficient candles' };
  }

  let bullish = 0;
  let bearish = 0;
  let totalBody = 0;
  let totalRange = 0;

  for (const candle of recent) {
    const body = candle.close - candle.open;
    totalBody += Math.abs(body);
    totalRange += Math.max(candle.high - candle.low, 0);

    if (body > 0) bullish += 1;
    else if (body < 0) bearish += 1;
  }

  const averageBodyRatio = totalRange > 0 ? totalBody / totalRange : 0;
  const difference = bullish - bearish;

  if (difference >= 3 && averageBodyRatio >= 0.35) {
    return {
      direction: 'BUY',
      score: Math.min(3, difference),
      description: 'Bullish candle pressure'
    };
  }

  if (difference <= -3 && averageBodyRatio >= 0.35) {
    return {
      direction: 'SELL',
      score: Math.min(3, Math.abs(difference)),
      description: 'Bearish candle pressure'
    };
  }

  return {
    direction: 'NEUTRAL',
    score: 0,
    description: 'Mixed market pressure'
  };
}

function calculateVolatility(candles, atrValue, pair) {
  const price = candles[candles.length - 1]?.close;
  const pip = pipSize(pair);

  if (!price || !atrValue || !pip) {
    return {
      regime: 'UNKNOWN',
      atrPips: null,
      riskPenalty: 0
    };
  }

  const atrPips = atrValue / pip;
  const atrPercent = (atrValue / price) * 100;

  let regime = 'NORMAL';
  let riskPenalty = 0;

  if (atrPercent < 0.015) {
    regime = 'LOW';
    riskPenalty = 1;
  } else if (atrPercent > 0.12) {
    regime = 'HIGH';
    riskPenalty = 8;
  } else if (atrPercent > 0.08) {
    regime = 'ELEVATED';
    riskPenalty = 4;
  }

  return { regime, atrPips, atrPercent, riskPenalty };
}

function detectRecentEmaCross(fastValues, slowValues, maxBars = 4) {
  const start = Math.max(1, fastValues.length - maxBars);

  for (let i = fastValues.length - 1; i >= start; i -= 1) {
    const fastNow = fastValues[i];
    const slowNow = slowValues[i];
    const fastBefore = fastValues[i - 1];
    const slowBefore = slowValues[i - 1];

    if (
      fastNow === null || slowNow === null ||
      fastBefore === null || slowBefore === null
    ) {
      continue;
    }

    if (fastBefore <= slowBefore && fastNow > slowNow) {
      return { direction: 'BUY', barsAgo: fastValues.length - 1 - i };
    }

    if (fastBefore >= slowBefore && fastNow < slowNow) {
      return { direction: 'SELL', barsAgo: fastValues.length - 1 - i };
    }
  }

  return { direction: 'NONE', barsAgo: null };
}

function hasPriceFollowThrough(candles, direction) {
  if (candles.length < 3) return false;

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const prior = candles[candles.length - 3];

  if (direction === 'BUY') {
    return (
      last.close > last.open &&
      last.close > previous.close &&
      last.close >= prior.close
    );
  }

  if (direction === 'SELL') {
    return (
      last.close < last.open &&
      last.close < previous.close &&
      last.close <= prior.close
    );
  }

  return false;
}
function scoreMarket(pair, rawCandles, fetchedAt = Date.now()) {
  const candles = getClosedCandles(rawCandles);

  const rejectedReasons = [];
  const evidence = [];
  const warnings = [];

  if (candles.length < MIN_CANDLES) {
    return {
      pair,
      signal: 'NO TRADE',
      direction: 'NONE',
      qualified: false,
      score: 0,
      buyScore: 0,
      sellScore: 0,
      evidenceScore: 0,
      rejectedReasons: ['INSUFFICIENT_CANDLES'],
      evidence,
      warnings,
      candleCount: candles.length,
      fetchedAt
    };
  }

  const closes = candles.map((candle) => candle.close);
  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ema9Values = ema(closes, 9);
  const ema21Values = ema(closes, 21);

  const ema9 = ema9Values[ema9Values.length - 1];
  const ema21 = ema21Values[ema21Values.length - 1];

  const previousEma9 = ema9Values[ema9Values.length - 2];
  const previousEma21 = ema21Values[ema21Values.length - 2];

  const cross = detectRecentEmaCross(
    ema9Values,
    ema21Values,
    4
  );

  const macd = calculateMacd(closes);
  const rsi = calculateRsi(closes, 14);
  const atr = calculateAtr(candles, 14);
  const bollinger = calculateBollinger(closes, 20, 2);
  const patterns = calculateCandlePatterns(candles);
  const levels = calculateSupportResistance(candles, 40);
  const trendline = calculateTrendline(candles, 20);
  const psychology = calculateMarketPsychology(candles);
  const volatility = calculateVolatility(candles, atr, pair);

  const fiveMinuteCandles = aggregateFiveMinute(candles);
  const fiveMinuteCloses = fiveMinuteCandles.map((candle) => candle.close);
  const fiveMinuteEma9 = ema(fiveMinuteCloses, 9);
  const fiveMinuteEma21 = ema(fiveMinuteCloses, 21);

  let fiveMinuteDirection = 'UNKNOWN';

  if (
    fiveMinuteEma9.length &&
    fiveMinuteEma21.length &&
    fiveMinuteEma9[fiveMinuteEma9.length - 1] !== null &&
    fiveMinuteEma21[fiveMinuteEma21.length - 1] !== null
  ) {
    fiveMinuteDirection =
      fiveMinuteEma9[fiveMinuteEma9.length - 1] >
      fiveMinuteEma21[fiveMinuteEma21.length - 1]
        ? 'BUY'
        : 'SELL';
  }

  const buy = { score: 0, reasons: [] };
  const sell = { score: 0, reasons: [] };

  function addEvidence(direction, points, reason) {
    if (direction === 'BUY') {
      buy.score += points;
      buy.reasons.push(reason);
    } else if (direction === 'SELL') {
      sell.score += points;
      sell.reasons.push(reason);
    }
  }

  // EMA trend alignment.
  if (ema9 > ema21) {
    addEvidence('BUY', 15, 'EMA9_ABOVE_EMA21');
  } else if (ema9 < ema21) {
    addEvidence('SELL', 15, 'EMA9_BELOW_EMA21');
  }

  // A recent crossover is required for a new entry.
  if (cross.direction === 'BUY') {
    addEvidence('BUY', 15, 'RECENT_BULLISH_EMA_CROSS');
  } else if (cross.direction === 'SELL') {
    addEvidence('SELL', 15, 'RECENT_BEARISH_EMA_CROSS');
  } else {
    rejectedReasons.push('NO_RECENT_EMA_CROSS');
  }

  // Price must follow through after the crossover.
  const buyFollowThrough = hasPriceFollowThrough(candles, 'BUY');
  const sellFollowThrough = hasPriceFollowThrough(candles, 'SELL');

  if (cross.direction === 'BUY' && buyFollowThrough) {
    addEvidence('BUY', 12, 'BULLISH_PRICE_FOLLOW_THROUGH');
  } else if (cross.direction === 'SELL' && sellFollowThrough) {
    addEvidence('SELL', 12, 'BEARISH_PRICE_FOLLOW_THROUGH');
  } else {
    rejectedReasons.push('NO_PRICE_FOLLOW_THROUGH');
  }

  // MACD is supporting evidence, not a standalone signal.
  if (
    macd.histogram !== null &&
    macd.previousHistogram !== null
  ) {
    if (macd.histogram > 0 && macd.histogram >= macd.previousHistogram) {
      addEvidence('BUY', 8, 'MACD_BULLISH_MOMENTUM');
    } else if (
      macd.histogram < 0 &&
      macd.histogram <= macd.previousHistogram
    ) {
      addEvidence('SELL', 8, 'MACD_BEARISH_MOMENTUM');
    }
  }

  // Candlestick evidence.
  if (patterns.direction !== 'NEUTRAL') {
    addEvidence(
      patterns.direction,
      patterns.strength >= 2 ? 10 : 5,
      'CANDLE_PATTERN_' + patterns.patterns.join('_')
    );
  }

  // Market structure / trendline evidence.
  if (trendline.direction !== 'NEUTRAL') {
    addEvidence(trendline.direction, 6, 'TRENDLINE_DIRECTION');
  }

  // Psychology and short-term candle pressure.
  if (psychology.direction !== 'NEUTRAL') {
    addEvidence(
      psychology.direction,
      5,
      'MARKET_PSYCHOLOGY_SUPPORT'
    );
  }

  // Support and resistance proximity.
  const pip = pipSize(pair);
  const supportDistancePips = pip
    ? (current.close - levels.support) / pip
    : null;
  const resistanceDistancePips = pip
    ? (levels.resistance - current.close) / pip
    : null;

  if (
    supportDistancePips !== null &&
    supportDistancePips >= 0 &&
    supportDistancePips <= 5
  ) {
    addEvidence('BUY', 5, 'PRICE_NEAR_SUPPORT');
  }

  if (
    resistanceDistancePips !== null &&
    resistanceDistancePips >= 0 &&
    resistanceDistancePips <= 5
  ) {
    addEvidence('SELL', 5, 'PRICE_NEAR_RESISTANCE');
  }

  // Breakout evidence must be supported by a candle close.
  const structureCandles = candles.slice(-21, -1);
  const recentHigh = structureCandles.length
    ? Math.max(...structureCandles.map((candle) => candle.high))
    : null;
  const recentLow = structureCandles.length
    ? Math.min(...structureCandles.map((candle) => candle.low))
    : null;

  if (recentHigh !== null && current.close > recentHigh) {
    addEvidence('BUY', 7, 'BULLISH_CLOSED_CANDLE_BREAKOUT');
  }

  if (recentLow !== null && current.close < recentLow) {
    addEvidence('SELL', 7, 'BEARISH_CLOSED_CANDLE_BREAKOUT');
  }

  // Volatility changes risk and score; it is not an automatic veto.
  if (volatility.riskPenalty > 0) {
    buy.score -= volatility.riskPenalty;
    sell.score -= volatility.riskPenalty;

    warnings.push(
      'VOLATILITY_' + volatility.regime
    );
  }

  // RSI is diagnostic only. It does not create or block a trade.
  if (rsi !== null) {
    if (rsi >= 70) warnings.push('RSI_OVERBOUGHT_DIAGNOSTIC');
    if (rsi <= 30) warnings.push('RSI_OVERSOLD_DIAGNOSTIC');
  }

  // Five-minute direction is diagnostic only, not a hard gate.
  if (
    fiveMinuteDirection !== 'UNKNOWN' &&
    fiveMinuteDirection !== cross.direction
  ) {
    warnings.push('FIVE_MINUTE_DIRECTION_CONFLICT');
  }

  const buyScore = Math.round(clamp(buy.score, 0, 100));
  const sellScore = Math.round(clamp(sell.score, 0, 100));

  const difference = Math.abs(buyScore - sellScore);
  const direction = buyScore > sellScore ? 'BUY' : 'SELL';
  const selectedScore = Math.max(buyScore, sellScore);
  const opposingScore = Math.min(buyScore, sellScore);

  if (cross.direction === 'NONE') {
    rejectedReasons.push('EMA_CROSS_NOT_RECENT');
  }

  if (cross.direction !== direction) {
    rejectedReasons.push('EMA_CROSS_DIRECTION_MISMATCH');
  }

  if (
    direction === 'BUY' && !buyFollowThrough
  ) {
    rejectedReasons.push('BUY_FOLLOW_THROUGH_MISSING');
  }

  if (
    direction === 'SELL' && !sellFollowThrough
  ) {
    rejectedReasons.push('SELL_FOLLOW_THROUGH_MISSING');
  }

  if (selectedScore < MIN_SIGNAL_SCORE) {
    rejectedReasons.push('SCORE_BELOW_MINIMUM');
  }

  if (difference < MIN_SCORE_GAP) {
    rejectedReasons.push('INSUFFICIENT_SCORE_GAP');
  }

  if (opposingScore >= MIN_OPPOSING_SCORE) {
    rejectedReasons.push('OPPOSING_EVIDENCE_TOO_HIGH');
  }

  const qualified =
    cross.direction === direction &&
    (direction === 'BUY' ? buyFollowThrough : sellFollowThrough) &&
    selectedScore >= MIN_SIGNAL_SCORE &&
    difference >= MIN_SCORE_GAP &&
    opposingScore < MIN_OPPOSING_SCORE;

  const selectedReasons = direction === 'BUY'
    ? buy.reasons
    : sell.reasons;

  const evidenceScore = qualified
    ? selectedScore
    : Math.min(selectedScore, 49);

  return {
    pair,
    signal: qualified ? direction : 'NO TRADE',
    direction: qualified ? direction : 'NONE',
    qualified,
    score: selectedScore,
    buyScore,
    sellScore,
    scoreGap: difference,
    opposingScore,
    evidenceScore,
    evidenceLabel: evidenceScore >= 75
      ? 'STRONG'
      : evidenceScore >= 55
        ? 'MODERATE'
        : 'INSUFFICIENT',
    scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY',
    entryPrice: current.close,
    candleTime: current.time,
    fetchedAt,
    candleCount: candles.length,
    indicators: {
      ema9,
      ema21,
      previousEma9,
      previousEma21,
      emaCross: cross,
      macd,
      rsi14: rsi,
      atr14: atr,
      bollinger,
      support: levels.support,
      resistance: levels.resistance,
      trendline,
      candlePatterns: patterns,
      psychology,
      volatility,
      fiveMinuteDirection,
      fiveMinuteCandleCount: fiveMinuteCandles.length
    },
    evidence: selectedReasons,
    rejectedReasons: qualified ? [] : [...new Set(rejectedReasons)],
    warnings
  };
}
// ============================================================
// V10.4.0 — MARKET CACHE AND 24-PAIR SCANNER
// ============================================================

const v104MarketCache = new Map();

const v104ScannerState = {
  running: false,
  startedAt: null,
  completedAt: null,
  lastError: null,
  currentPair: null,
  completedPairs: 0,
  totalPairs: PAIRS.length,
  lastResults: [],
  nextScanAt: null
};

function getMarketCacheEntry(pair) {
  return v104MarketCache.get(normalizePair(pair)) || null;
}

function isMarketDataFresh(entry, now = Date.now()) {
  if (!entry || !Array.isArray(entry.candles)) return false;
  if (!Number.isFinite(entry.fetchedAt)) return false;

  const age = now - entry.fetchedAt;

  return (
    age >= 0 &&
    age <= 150000 &&
    entry.candles.length >= MIN_CANDLES
  );
}

function isMarketDataHardStale(entry, now = Date.now()) {
  if (!entry || !Number.isFinite(entry.fetchedAt)) return true;
  return now - entry.fetchedAt > 300000;
}

function saveMarketCache(pair, candles, fetchedAt, source) {
  const normalizedPair = normalizePair(pair);
  const normalizedCandles = Array.isArray(candles) ? candles : [];

  if (!normalizedPair || normalizedCandles.length === 0) {
    return null;
  }

  const entry = {
    pair: normalizedPair,
    candles: normalizedCandles,
    fetchedAt: Number(fetchedAt) || Date.now(),
    source: source || 'unknown',
    updatedAt: Date.now()
  };

  v104MarketCache.set(normalizedPair, entry);
  return entry;
}

function getCachedMarketAnalysis(pair) {
  const normalizedPair = normalizePair(pair);
  const entry = getMarketCacheEntry(normalizedPair);

  if (!entry) {
    return {
      pair: normalizedPair,
      available: false,
      fresh: false,
      reason: 'NO_CACHED_MARKET_DATA'
    };
  }

  const fresh = isMarketDataFresh(entry);

  if (!fresh) {
    return {
      pair: normalizedPair,
      available: false,
      fresh: false,
      reason: isMarketDataHardStale(entry)
        ? 'MARKET_DATA_HARD_STALE'
        : 'MARKET_DATA_NOT_FRESH',
      fetchedAt: entry.fetchedAt,
      ageMs: Date.now() - entry.fetchedAt
    };
  }

  const analysis = scoreMarket(
    normalizedPair,
    entry.candles,
    entry.fetchedAt
  );

  return {
    ...analysis,
    available: true,
    fresh: true,
    ageMs: Date.now() - entry.fetchedAt,
    dataSource: entry.source
  };
}

function getFreshCachedAnalyses(pairs = PAIRS) {
  const results = [];

  for (const pair of pairs) {
    const result = getCachedMarketAnalysis(pair);

    if (result.available && result.fresh) {
      results.push(result);
    }
  }

  return results;
}

function rankQualifiedMarkets(results) {
  return results
    .filter((result) => result && result.qualified === true)
    .sort((a, b) => {
      if (b.evidenceScore !== a.evidenceScore) {
        return b.evidenceScore - a.evidenceScore;
      }

      if (b.scoreGap !== a.scoreGap) {
        return b.scoreGap - a.scoreGap;
      }

      return (a.ageMs || 0) - (b.ageMs || 0);
    });
}

function getBestCachedMarket() {
  const analyses = getFreshCachedAnalyses(PAIRS);
  const qualified = rankQualifiedMarkets(analyses);

  if (!qualified.length) {
    return {
      signal: 'NO TRADE',
      direction: 'NONE',
      qualified: false,
      reason: 'NO_FRESH_QUALIFIED_MARKET',
      scannedFreshPairs: analyses.length,
      totalPairs: PAIRS.length,
      evidenceScore: 0,
      scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY'
    };
  }

  return {
    ...qualified[0],
    selectedBy: 'BEST_FRESH_QUALIFIED_MARKET',
    scannedFreshPairs: analyses.length,
    totalPairs: PAIRS.length
  };
}

async function scanOnePair(pair) {
  const normalizedPair = normalizePair(pair);

  if (!normalizedPair || !PAIRS.includes(normalizedPair)) {
    return {
      pair: normalizedPair,
      success: false,
      reason: 'PAIR_NOT_SUPPORTED'
    };
  }

  try {
    const providerResult = await providerFetch(
      normalizedPair,
      'scanner'
    );

    if (
      !providerResult ||
      !Array.isArray(providerResult.candles) ||
      providerResult.candles.length < MIN_CANDLES
    ) {
      return {
        pair: normalizedPair,
        success: false,
        reason: 'INSUFFICIENT_PROVIDER_CANDLES'
      };
    }

    const entry = saveMarketCache(
      normalizedPair,
      providerResult.candles,
      providerResult.fetchedAt,
      providerResult.source || 'twelve_data'
    );

    const analysis = scoreMarket(
      normalizedPair,
      entry.candles,
      entry.fetchedAt
    );

    return {
      pair: normalizedPair,
      success: true,
      fetchedAt: entry.fetchedAt,
      candleCount: entry.candles.length,
      analysis
    };
  } catch (error) {
    return {
      pair: normalizedPair,
      success: false,
      reason: error && error.message
        ? error.message
        : 'PAIR_SCAN_FAILED'
    };
  }
}

async function runBackgroundScan(options = {}) {
  if (v104ScannerState.running) {
    return {
      started: false,
      reason: 'SCAN_ALREADY_RUNNING',
      progress: { ...v104ScannerState }
    };
  }

  const force = options.force === true;
  const now = Date.now();

  // Avoid overlapping sweeps and protect the provider's daily quota.
  if (!force && v104ScannerState.nextScanAt &&
      now < v104ScannerState.nextScanAt) {
    return {
      started: false,
      reason: 'SCAN_INTERVAL_NOT_REACHED',
      nextScanAt: v104ScannerState.nextScanAt
    };
  }

  const remainingDaily = Math.max(
    0,
    DAILY_USABLE_LIMIT - dailyCreditsUsed
  );

  const remainingScanner = Math.max(
    0,
    SCANNER_DAILY_BUDGET - scannerCreditsUsed
  );

  if (
    remainingDaily < PAIRS.length ||
    remainingScanner < PAIRS.length
  ) {
    v104ScannerState.lastError = 'INSUFFICIENT_DAILY_SCAN_BUDGET';

    return {
      started: false,
      reason: 'INSUFFICIENT_DAILY_SCAN_BUDGET',
      remainingDaily,
      remainingScanner
    };
  }

  v104ScannerState.running = true;
  v104ScannerState.startedAt = Date.now();
  v104ScannerState.completedAt = null;
  v104ScannerState.lastError = null;
  v104ScannerState.currentPair = null;
  v104ScannerState.completedPairs = 0;
  v104ScannerState.totalPairs = PAIRS.length;
  v104ScannerState.lastResults = [];

  const orderedPairs = [
    ...PRIORITY_PAIRS,
    ...BACKGROUND_PAIRS
  ];

  try {
    for (const pair of orderedPairs) {
      v104ScannerState.currentPair = pair;

      const result = await scanOnePair(pair);

      v104ScannerState.lastResults.push(result);
      v104ScannerState.completedPairs += 1;

      // Yield between requests. providerFetch also enforces
      // the provider queue's request spacing and per-minute limit.
      await sleep(100);
    }

    v104ScannerState.completedAt = Date.now();
    v104ScannerState.nextScanAt =
      v104ScannerState.completedAt + SCAN_INTERVAL_MS;

    return {
      started: true,
      completed: true,
      startedAt: v104ScannerState.startedAt,
      completedAt: v104ScannerState.completedAt,
      completedPairs: v104ScannerState.completedPairs,
      totalPairs: v104ScannerState.totalPairs,
      successfulPairs: v104ScannerState.lastResults.filter(
        (item) => item.success
      ).length,
      failedPairs: v104ScannerState.lastResults.filter(
        (item) => !item.success
      ).length
    };
  } catch (error) {
    v104ScannerState.lastError = error && error.message
      ? error.message
      : 'BACKGROUND_SCAN_ERROR';

    return {
      started: true,
      completed: false,
      error: v104ScannerState.lastError,
      completedPairs: v104ScannerState.completedPairs,
      totalPairs: v104ScannerState.totalPairs
    };
  } finally {
    v104ScannerState.running = false;
    v104ScannerState.currentPair = null;

    if (!v104ScannerState.nextScanAt) {
      v104ScannerState.nextScanAt =
        Date.now() + SCAN_INTERVAL_MS;
    }
  }
}

function getScannerStatus() {
  return {
    running: v104ScannerState.running,
    startedAt: v104ScannerState.startedAt,
    completedAt: v104ScannerState.completedAt,
    currentPair: v104ScannerState.currentPair,
    completedPairs: v104ScannerState.completedPairs,
    totalPairs: v104ScannerState.totalPairs,
    successfulPairs: v104ScannerState.lastResults.filter(
      (item) => item.success
    ).length,
    failedPairs: v104ScannerState.lastResults.filter(
      (item) => !item.success
    ).length,
    lastError: v104ScannerState.lastError,
    nextScanAt: v104ScannerState.nextScanAt,
    priorityPairs: PRIORITY_PAIRS,
    backgroundPairs: BACKGROUND_PAIRS,
    freshCachedPairs: getFreshCachedAnalyses(PAIRS).length
  };
}
// ============================================================
// V10.4.0 — ANALYSIS AND SCANNER API
// ============================================================

function buildNoTradeResponse(reason, extra = {}) {
  return {
    version: VERSION,
    signal: 'NO TRADE',
    direction: 'NONE',
    qualified: false,
    evidenceScore: 0,
    evidenceLabel: 'INSUFFICIENT',
    scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY',
    reason,
    ...extra
  };
}

function buildAnalysisResponse(result) {
  if (!result || !result.available || !result.fresh) {
    return buildNoTradeResponse(
      result?.reason || 'MARKET_DATA_UNAVAILABLE',
      {
        pair: result?.pair || null,
        fetchedAt: result?.fetchedAt || null,
        ageMs: result?.ageMs ?? null
      }
    );
  }

  return {
    version: VERSION,
    pair: result.pair,
    signal: result.signal,
    direction: result.direction,
    qualified: result.qualified,
    score: result.score,
    buyScore: result.buyScore,
    sellScore: result.sellScore,
    scoreGap: result.scoreGap,
    opposingScore: result.opposingScore,
    evidenceScore: result.evidenceScore,
    evidenceLabel: result.evidenceLabel,
    scoreMeaning: result.scoreMeaning,
    entryPrice: result.entryPrice,
    candleTime: result.candleTime,
    fetchedAt: result.fetchedAt,
    ageMs: result.ageMs,
    candleCount: result.candleCount,
    indicators: result.indicators,
    evidence: result.evidence,
    rejectedReasons: result.rejectedReasons,
    warnings: result.warnings,
    dataSource: result.dataSource
  };
}

function getAnalysisForPair(pair) {
  const normalizedPair = normalizePair(pair);

  if (!PAIRS.includes(normalizedPair)) {
    return buildNoTradeResponse('UNSUPPORTED_PAIR', {
      pair: normalizedPair
    });
  }

  const result = getCachedMarketAnalysis(normalizedPair);
  return buildAnalysisResponse(result);
}

function getBestAnalysisResponse() {
  const best = getBestCachedMarket();

  if (!best || !best.qualified) {
    return buildNoTradeResponse(
      best?.reason || 'NO_FRESH_QUALIFIED_MARKET',
      {
        scannedFreshPairs: best?.scannedFreshPairs || 0,
        totalPairs: PAIRS.length,
        scanner: getScannerStatus()
      }
    );
  }

  return {
    version: VERSION,
    ...best,
    scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY',
    scanner: getScannerStatus()
  };
}

// Health check.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    service: 'PO AI PREDICTOR',
    mode: 'LIVE_FOREX_ONLY',
    timestamp: new Date().toISOString()
  });
});

// Application metadata.
app.get('/api/status', (req, res) => {
  res.json({
    ...metadata(),
    version: VERSION,
    mode: 'LIVE_FOREX_ONLY',
    pairs: PAIRS,
    priorityPairs: PRIORITY_PAIRS,
    backgroundPairs: BACKGROUND_PAIRS,
    scanner: getScannerStatus()
  });
});

// Scanner status.
app.get('/api/scanner/status', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    scanner: getScannerStatus()
  });
});

// Cached analysis for a selected pair.
// This endpoint does not make a Twelve Data request.
app.get('/api/analyze', (req, res) => {
  const pair = normalizePair(req.query.pair || '');

  if (!pair || !PAIRS.includes(pair)) {
    return res.status(400).json(
      buildNoTradeResponse('UNSUPPORTED_PAIR', { pair })
    );
  }

  return res.json(getAnalysisForPair(pair));
});

// Compatibility endpoint for existing frontend.
app.get('/api/best', (req, res) => {
  return res.json(getBestAnalysisResponse());
});

// Full cached scanner overview.
app.get('/api/markets', (req, res) => {
  const results = getFreshCachedAnalyses(PAIRS);

  return res.json({
    version: VERSION,
    mode: 'LIVE_FOREX_ONLY',
    totalPairs: PAIRS.length,
    freshPairs: results.length,
    qualifiedPairs: results.filter(
      (item) => item.qualified
    ).length,
    markets: results.map((item) => ({
      pair: item.pair,
      signal: item.signal,
      qualified: item.qualified,
      evidenceScore: item.evidenceScore,
      evidenceLabel: item.evidenceLabel,
      ageMs: item.ageMs,
      fetchedAt: item.fetchedAt,
      rejectedReasons: item.rejectedReasons
    })),
    scanner: getScannerStatus()
  });
});

// Manually request a background scan.
// The scanner still observes the daily request budget.
app.post('/api/scanner/start', async (req, res) => {
  if (v104ScannerState.running) {
    return res.status(409).json({
      ok: false,
      reason: 'SCAN_ALREADY_RUNNING',
      scanner: getScannerStatus()
    });
  }

  const result = await runBackgroundScan({
    force: req.body?.force === true
  });

  if (!result.started) {
    return res.status(429).json({
      ok: false,
      ...result,
      scanner: getScannerStatus()
    });
  }

  return res.json({
    ok: true,
    ...result,
    scanner: getScannerStatus()
  });
});

// Scan one requested pair manually.
// This endpoint is separate from Analyze and is subject
// to provider request limits.
app.post('/api/scan/pair', async (req, res) => {
  const pair = normalizePair(req.body?.pair || '');

  if (!pair || !PAIRS.includes(pair)) {
    return res.status(400).json({
      ok: false,
      reason: 'UNSUPPORTED_PAIR'
    });
  }

  try {
    const result = await scanOnePair(pair);

    if (!result.success) {
      return res.status(503).json({
        ok: false,
        pair,
        reason: result.reason || 'PAIR_SCAN_FAILED'
      });
    }

    return res.json({
      ok: true,
      pair,
      analysis: buildAnalysisResponse(
        getCachedMarketAnalysis(pair)
      )
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      pair,
      reason: error?.message || 'PAIR_SCAN_ERROR'
    });
  }
});

// ============================================================
// V10.4.0 — DATA FRESHNESS HELPERS
// ============================================================

function validateMarketDataForSignal(pair) {
  const entry = getMarketCacheEntry(pair);

  if (!entry) {
    return {
      valid: false,
      reason: 'NO_MARKET_DATA'
    };
  }

  const ageMs = Date.now() - entry.fetchedAt;

  if (ageMs > HARD_STALE_MS) {
    return {
      valid: false,
      reason: 'MARKET_DATA_HARD_STALE',
      ageMs
    };
  }

  if (ageMs > DATA_FRESHNESS_MS) {
    return {
      valid: false,
      reason: 'MARKET_DATA_NOT_FRESH',
      ageMs
    };
  }

  if (entry.candles.length < MIN_CANDLES) {
    return {
      valid: false,
      reason: 'INSUFFICIENT_CANDLES',
      candleCount: entry.candles.length
    };
  }

  return {
    valid: true,
    pair,
    ageMs,
    fetchedAt: entry.fetchedAt,
    candleCount: entry.candles.length
  };
}

function validateFreshProviderResult(providerResult) {
  if (
    !providerResult ||
    !Array.isArray(providerResult.candles)
  ) {
    return {
      valid: false,
      reason: 'PROVIDER_DATA_MISSING'
    };
  }

  if (providerResult.candles.length < MIN_CANDLES) {
    return {
      valid: false,
      reason: 'INSUFFICIENT_PROVIDER_CANDLES',
      candleCount: providerResult.candles.length
    };
  }

  const fetchedAt = Number(providerResult.fetchedAt);

  if (!Number.isFinite(fetchedAt)) {
    return {
      valid: false,
      reason: 'INVALID_PROVIDER_TIMESTAMP'
    };
  }

  const ageMs = Date.now() - fetchedAt;

  if (ageMs < 0 || ageMs > DATA_FRESHNESS_MS) {
    return {
      valid: false,
      reason: 'PROVIDER_DATA_NOT_FRESH',
      ageMs
    };
  }

  return {
    valid: true,
    fetchedAt,
    ageMs,
    candleCount: providerResult.candles.length
  };
}
// ============================================================
// V10.4.0 — POCKET OPTION BROKER PRICE VALIDATION
// ============================================================

function validateBrokerPriceInput(input) {
  const brokerPrice = finite(input?.brokerPrice);
  const capturedAt = finite(input?.brokerPriceCapturedAt);

  if (brokerPrice === null || brokerPrice <= 0) {
    return {
      valid: false,
      reason: 'BROKER_PRICE_MISSING_OR_INVALID'
    };
  }

  if (capturedAt === null || capturedAt <= 0) {
    return {
      valid: false,
      reason: 'BROKER_PRICE_TIMESTAMP_MISSING'
    };
  }

  const ageMs = Date.now() - capturedAt;

  if (ageMs < 0) {
    return {
      valid: false,
      reason: 'BROKER_PRICE_TIMESTAMP_INVALID',
      ageMs
    };
  }

  if (ageMs > BROKER_PRICE_MAX_AGE_MS) {
    return {
      valid: false,
      reason: 'BROKER_PRICE_TOO_OLD',
      ageMs,
      maxAgeMs: BROKER_PRICE_MAX_AGE_MS
    };
  }

  return {
    valid: true,
    brokerPrice,
    capturedAt,
    ageMs
  };
}

function validateBrokerReferenceGap(pair, brokerPrice, referencePrice) {
  const gapPips = priceDifferencePips(
    pair,
    brokerPrice,
    referencePrice
  );

  if (!Number.isFinite(gapPips)) {
    return {
      valid: false,
      reason: 'BROKER_REFERENCE_GAP_UNAVAILABLE'
    };
  }

  if (gapPips > BROKER_MAX_GAP_PIPS) {
    return {
      valid: false,
      reason: 'BROKER_PRICE_TOO_FAR_FROM_REFERENCE',
      gapPips: round(gapPips, 2),
      maxGapPips: BROKER_MAX_GAP_PIPS
    };
  }

  return {
    valid: true,
    gapPips: round(gapPips, 2),
    maxGapPips: BROKER_MAX_GAP_PIPS
  };
}

function buildRejectedConfirmation(reason, details = {}) {
  return {
    ok: false,
    version: VERSION,
    confirmed: false,
    signal: 'NO TRADE',
    direction: 'NONE',
    reason,
    ...details
  };
}

async function confirmSignalHandler(req, res) {
  const pair = normalizePair(req.body?.pair || '');

  if (!pair || !PAIRS.includes(pair)) {
    return res.status(400).json(
      buildRejectedConfirmation('UNSUPPORTED_PAIR', {
        pair
      })
    );
  }

  // Only live forex is accepted by this endpoint.
  const mode = String(req.body?.mode || 'LIVE_FOREX')
    .trim()
    .toUpperCase();

  if (
    mode === 'OTC' ||
    mode.includes('OTC') ||
    mode !== 'LIVE_FOREX'
  ) {
    return res.status(400).json(
      buildRejectedConfirmation('LIVE_FOREX_ONLY')
    );
  }

  // Validate the broker quote timestamp before waiting in
  // the provider queue. It will be checked again afterwards.
  const initialBrokerValidation = validateBrokerPriceInput(
    req.body
  );

  if (!initialBrokerValidation.valid) {
    return res.status(400).json(
      buildRejectedConfirmation(
        initialBrokerValidation.reason,
        initialBrokerValidation
      )
    );
  }

  const expiryMinutes = finite(req.body?.expiryMinutes);

  if (expiryMinutes !== 1) {
    return res.status(400).json(
      buildRejectedConfirmation('INVALID_LIVE_EXPIRY', {
        allowedExpiryMinutes: 1
      })
    );
  }

  let providerResult;

  try {
    // IMPORTANT:
    // Always request fresh Twelve Data before confirmation.
    // Do not use the previously cached candles as confirmation data.
    providerResult = await providerFetch(
      pair,
      'confirm'
    );
  } catch (error) {
    return res.status(503).json(
      buildRejectedConfirmation(
        'FRESH_MARKET_DATA_REQUEST_FAILED',
        {
          detail: error?.message || 'PROVIDER_ERROR'
        }
      )
    );
  }

  // Recheck broker price age after provider queue wait.
  const brokerValidation = validateBrokerPriceInput(
    req.body
  );

  if (!brokerValidation.valid) {
    return res.status(400).json(
      buildRejectedConfirmation(
        brokerValidation.reason,
        brokerValidation
      )
    );
  }

  const providerValidation = validateFreshProviderResult(
    providerResult
  );

  if (!providerValidation.valid) {
    return res.status(503).json(
      buildRejectedConfirmation(
        providerValidation.reason,
        providerValidation
      )
    );
  }

  const marketEntry = saveMarketCache(
    pair,
    providerResult.candles,
    providerResult.fetchedAt,
    'twelve_data_confirm'
  );

  if (!marketEntry) {
    return res.status(503).json(
      buildRejectedConfirmation('MARKET_CACHE_UPDATE_FAILED')
    );
  }

  // Analyze the newly fetched data, not the previous cache.
  const analysis = scoreMarket(
    pair,
    providerResult.candles,
    providerResult.fetchedAt
  );

  if (!analysis.qualified) {
    return res.status(409).json(
      buildRejectedConfirmation(
        'FRESH_MARKET_ANALYSIS_NOT_QUALIFIED',
        {
          pair,
          evidenceScore: analysis.evidenceScore,
          rejectedReasons: analysis.rejectedReasons,
          warnings: analysis.warnings,
          indicators: analysis.indicators
        }
      )
    );
  }

  const referencePrice = finite(analysis.entryPrice);

  if (referencePrice === null || referencePrice <= 0) {
    return res.status(503).json(
      buildRejectedConfirmation('INVALID_REFERENCE_PRICE')
    );
  }

  const gapValidation = validateBrokerReferenceGap(
    pair,
    brokerValidation.brokerPrice,
    referencePrice
  );

  if (!gapValidation.valid) {
    return res.status(409).json(
      buildRejectedConfirmation(
        gapValidation.reason,
        {
          pair,
          brokerPrice: brokerValidation.brokerPrice,
          referencePrice,
          ...gapValidation
        }
      )
    );
  }

  // Make sure the quote is still within its allowed age
  // immediately before final confirmation.
  const finalBrokerValidation = validateBrokerPriceInput(
    req.body
  );

  if (!finalBrokerValidation.valid) {
    return res.status(400).json(
      buildRejectedConfirmation(
        finalBrokerValidation.reason,
        finalBrokerValidation
      )
    );
  }

  const signalId = (
    'PO-' +
    Date.now().toString(36).toUpperCase() +
    '-' +
    Math.random().toString(36).slice(2, 8).toUpperCase()
  );

  const confirmedAt = Date.now();

  const confirmation = {
    ok: true,
    version: VERSION,
    confirmed: true,
    signalId,
    pair,
    signal: analysis.direction,
    direction: analysis.direction,
    mode: 'LIVE_FOREX',
    source: 'USER_ENTERED_POCKET_OPTION_PRICE',
    brokerPrice: brokerValidation.brokerPrice,
    brokerPriceCapturedAt: brokerValidation.capturedAt,
    brokerPriceAgeMs: finalBrokerValidation.ageMs,
    referencePrice,
    gapPips: gapValidation.gapPips,
    entryPrice: brokerValidation.brokerPrice,
    referenceEntryPrice: referencePrice,
    expiryMinutes: 1,
    expiryAt: confirmedAt + 60000,
    confirmedAt,
    evidenceScore: analysis.evidenceScore,
    evidenceLabel: analysis.evidenceLabel,
    scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY',
    candleTime: analysis.candleTime,
    marketFetchedAt: providerResult.fetchedAt,
    indicators: analysis.indicators,
    evidence: analysis.evidence,
    warnings: analysis.warnings,
    outcome: 'PENDING'
  };

  try {
    await saveSignal(confirmation);
  } catch (error) {
    // A database write failure must not silently change
    // the market analysis, but the client must be informed.
    return res.status(503).json(
      buildRejectedConfirmation(
        'SIGNAL_STORAGE_FAILED',
        {
          detail: error?.message || 'DATABASE_ERROR'
        }
      )
    );
  }

  return res.json(confirmation);
}

// Confirmation endpoint.
app.post('/api/confirm-signal', confirmSignalHandler);

// Compatibility alias for clients using a shorter route.
app.post('/api/confirm', confirmSignalHandler);
// ============================================================
// V10.4.0 — SIGNAL OUTCOME AND EXPIRY TRACKING
// ============================================================

const pendingSignalCache = new Map();

function normalizeOutcome(value) {
  const outcome = String(value || '').trim().toUpperCase();

  if (['WIN', 'LOSS', 'TIE', 'INVALID', 'PENDING'].includes(outcome)) {
    return outcome;
  }

  return null;
}

function calculateSignalOutcome(direction, entryPrice, expiryPrice) {
  const entry = finite(entryPrice);
  const expiry = finite(expiryPrice);
  const side = String(direction || '').toUpperCase();

  if (
    entry === null ||
    expiry === null ||
    entry <= 0 ||
    expiry <= 0 ||
    !['BUY', 'SELL'].includes(side)
  ) {
    return 'INVALID';
  }

  const difference = expiry - entry;

  // A tie means the expiry price equals the entry price.
  if (Math.abs(difference) < 1e-10) {
    return 'TIE';
  }

  if (side === 'BUY') {
    return difference > 0 ? 'WIN' : 'LOSS';
  }

  return difference < 0 ? 'WIN' : 'LOSS';
}

function validateExpiryPrice(expiryPrice, expiryPriceAt, expiryAt) {
  const price = finite(expiryPrice);
  const priceAt = finite(expiryPriceAt);
  const targetExpiry = finite(expiryAt);

  if (price === null || price <= 0) {
    return {
      valid: false,
      reason: 'EXPIRY_PRICE_MISSING_OR_INVALID'
    };
  }

  if (priceAt === null || targetExpiry === null) {
    return {
      valid: false,
      reason: 'EXPIRY_TIMESTAMP_MISSING'
    };
  }

  if (priceAt < targetExpiry) {
    return {
      valid: false,
      reason: 'EXPIRY_PRICE_CAPTURED_TOO_EARLY',
      expiryAt: targetExpiry,
      expiryPriceAt: priceAt
    };
  }

  // Do not accept an expiry observation that is excessively late.
  if (priceAt - targetExpiry > 120000) {
    return {
      valid: false,
      reason: 'EXPIRY_PRICE_CAPTURED_TOO_LATE',
      expiryAt: targetExpiry,
      expiryPriceAt: priceAt
    };
  }

  return {
    valid: true,
    expiryPrice: price,
    expiryPriceAt: priceAt
  };
}

function rememberPendingSignal(signal) {
  if (!signal || !signal.signalId) return;

  pendingSignalCache.set(signal.signalId, {
    ...signal,
    outcome: 'PENDING'
  });
}

function getPendingSignal(signalId) {
  return pendingSignalCache.get(String(signalId || '')) || null;
}

async function recordSignalOutcome(signalId, outcome, details = {}) {
  const normalizedOutcome = normalizeOutcome(outcome);

  if (
    !signalId ||
    !normalizedOutcome ||
    normalizedOutcome === 'PENDING'
  ) {
    throw new Error('INVALID_OUTCOME_UPDATE');
  }

  const signal = getPendingSignal(signalId);

  if (!signal) {
    throw new Error('SIGNAL_NOT_FOUND_IN_ACTIVE_SESSION');
  }

  if (signal.outcome !== 'PENDING') {
    throw new Error('SIGNAL_OUTCOME_ALREADY_RECORDED');
  }

  const updatedAt = Date.now();

  const update = {
    signalId,
    outcome: normalizedOutcome,
    expiryPrice: finite(details.expiryPrice),
    expiryPriceAt: finite(details.expiryPriceAt),
    updatedAt,
    outcomeReason: details.reason || null
  };

  await updateSignalOutcome(signalId, normalizedOutcome, update);

  pendingSignalCache.set(signalId, {
    ...signal,
    ...update
  });

  return {
    ok: true,
    signalId,
    outcome: normalizedOutcome,
    updatedAt
  };
}

// Store successfully confirmed signals in the active session cache.
// This wrapper preserves the existing confirmation handler.
const originalConfirmSignalHandler = confirmSignalHandler;

confirmSignalHandler = async function (req, res) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    if (body && body.ok === true && body.confirmed === true) {
      rememberPendingSignal(body);
    }

    return originalJson(body);
  };

  return originalConfirmSignalHandler(req, res);
};

// ============================================================
// V10.4.0 — OUTCOME API
// ============================================================

// Record an expiry outcome when a trustworthy expiry price
// and timestamp are available.
app.post('/api/signal/outcome', async (req, res) => {
  const signalId = String(req.body?.signalId || '').trim();

  if (!signalId) {
    return res.status(400).json({
      ok: false,
      reason: 'SIGNAL_ID_REQUIRED'
    });
  }

  const signal = getPendingSignal(signalId);

  if (!signal) {
    return res.status(404).json({
      ok: false,
      reason: 'SIGNAL_NOT_FOUND_IN_ACTIVE_SESSION'
    });
  }

  if (signal.outcome !== 'PENDING') {
    return res.status(409).json({
      ok: false,
      reason: 'SIGNAL_OUTCOME_ALREADY_RECORDED',
      outcome: signal.outcome
    });
  }

  const expiryValidation = validateExpiryPrice(
    req.body?.expiryPrice,
    req.body?.expiryPriceAt,
    signal.expiryAt
  );

  if (!expiryValidation.valid) {
    return res.status(400).json({
      ok: false,
      reason: expiryValidation.reason,
      ...expiryValidation
    });
  }

  const outcome = calculateSignalOutcome(
    signal.direction,
    signal.entryPrice,
    expiryValidation.expiryPrice
  );

  if (outcome === 'INVALID') {
    return res.status(400).json({
      ok: false,
      reason: 'OUTCOME_CALCULATION_INVALID'
    });
  }

  try {
    const result = await recordSignalOutcome(
      signalId,
      outcome,
      {
        expiryPrice: expiryValidation.expiryPrice,
        expiryPriceAt: expiryValidation.expiryPriceAt,
        reason: 'USER_SUPPLIED_EXPIRY_PRICE'
      }
    );

    return res.json({
      ...result,
      pair: signal.pair,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      expiryPrice: expiryValidation.expiryPrice,
      expiryAt: signal.expiryAt
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      reason: error?.message || 'OUTCOME_SAVE_FAILED'
    });
  }
});

// Mark a signal invalid only when the user or a trusted
// process has a valid reason for doing so.
app.post('/api/signal/invalidate', async (req, res) => {
  const signalId = String(req.body?.signalId || '').trim();
  const reason = String(req.body?.reason || '').trim();

  if (!signalId || !reason) {
    return res.status(400).json({
      ok: false,
      reason: 'SIGNAL_ID_AND_REASON_REQUIRED'
    });
  }

  const signal = getPendingSignal(signalId);

  if (!signal) {
    return res.status(404).json({
      ok: false,
      reason: 'SIGNAL_NOT_FOUND_IN_ACTIVE_SESSION'
    });
  }

  if (signal.outcome !== 'PENDING') {
    return res.status(409).json({
      ok: false,
      reason: 'SIGNAL_OUTCOME_ALREADY_RECORDED',
      outcome: signal.outcome
    });
  }

  try {
    const result = await recordSignalOutcome(
      signalId,
      'INVALID',
      { reason }
    );

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      reason: error?.message || 'INVALID_OUTCOME_SAVE_FAILED'
    });
  }
});

// ============================================================
// V10.4.0 — SIGNAL HISTORY
// ============================================================

app.get('/api/history', async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || 50);
    const limit = Math.round(
      clamp(
        Number.isFinite(requestedLimit) ? requestedLimit : 50,
        1,
        200
      )
    );

    const history = await getHistory(limit);

    return res.json({
      ok: true,
      version: VERSION,
      count: Array.isArray(history) ? history.length : 0,
      history: Array.isArray(history) ? history : []
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      reason: error?.message || 'HISTORY_LOAD_FAILED',
      history: []
    });
  }
});

// Single signal lookup from active-session memory.
app.get('/api/signal/:signalId', (req, res) => {
  const signal = getPendingSignal(req.params.signalId);

  if (!signal) {
    return res.status(404).json({
      ok: false,
      reason: 'SIGNAL_NOT_FOUND_IN_ACTIVE_SESSION'
    });
  }

  return res.json({
    ok: true,
    signal
  });
});
// ============================================================
// V10.4.0 — WALK-FORWARD BACKTEST ENGINE
// ============================================================

function calculateBacktestMetrics(trades) {
  const completed = trades.filter((trade) =>
    ['WIN', 'LOSS', 'TIE'].includes(trade.outcome)
  );

  const wins = completed.filter(
    (trade) => trade.outcome === 'WIN'
  ).length;

  const losses = completed.filter(
    (trade) => trade.outcome === 'LOSS'
  ).length;

  const ties = completed.filter(
    (trade) => trade.outcome === 'TIE'
  ).length;

  const invalid = trades.filter(
    (trade) => trade.outcome === 'INVALID'
  ).length;

  const winRate = wins + losses > 0
    ? (wins / (wins + losses)) * 100
    : null;

  return {
    totalSignals: trades.length,
    completedTrades: completed.length,
    wins,
    losses,
    ties,
    invalid,
    winRate: winRate === null ? null : round(winRate, 2),
    winRateMeaning: 'HISTORICAL_BACKTEST_RESULT_NOT_FUTURE_PROBABILITY'
  };
}

function runWalkForwardBacktest(pair, candles, expiryMinutes = 1) {
  const normalizedPair = normalizePair(pair);

  if (!PAIRS.includes(normalizedPair)) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_PAIR'
    };
  }

  if (![1, 2, 3].includes(Number(expiryMinutes))) {
    return {
      ok: false,
      reason: 'INVALID_BACKTEST_EXPIRY',
      allowedExpiryMinutes: [1, 2, 3]
    };
  }

  const expiry = Number(expiryMinutes);
  const historicalCandles = Array.isArray(candles)
    ? candles
    : [];

  const minimumRequired = MIN_CANDLES + expiry + 1;

  if (historicalCandles.length < minimumRequired) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_BACKTEST_HISTORY',
      candleCount: historicalCandles.length,
      minimumRequired
    };
  }

  const trades = [];
  const startIndex = MIN_CANDLES - 1;
  const endIndex = historicalCandles.length - expiry - 1;

  for (
    let index = startIndex;
    index <= endIndex;
    index += 1
  ) {
    // Only candles available at this historical point are used
    // to calculate the signal.
    const trainingWindow = historicalCandles.slice(
      0,
      index + 1
    );

    const entryCandle = historicalCandles[index];
    const expiryCandle = historicalCandles[index + expiry];

    if (!entryCandle || !expiryCandle) continue;

    const analysis = scoreMarket(
      normalizedPair,
      trainingWindow,
      entryCandle.timestamp
    );

    if (!analysis.qualified) continue;

    const entryPrice = entryCandle.close;
    const expiryPrice = expiryCandle.close;

    const outcome = calculateSignalOutcome(
      analysis.direction,
      entryPrice,
      expiryPrice
    );

    trades.push({
      pair: normalizedPair,
      direction: analysis.direction,
      entryTime: entryCandle.time,
      expiryTime: expiryCandle.time,
      entryPrice,
      expiryPrice,
      expiryMinutes: expiry,
      evidenceScore: analysis.evidenceScore,
      scoreGap: analysis.scoreGap,
      outcome
    });
  }

  return {
    ok: true,
    version: VERSION,
    pair: normalizedPair,
    expiryMinutes: expiry,
    method: 'WALK_FORWARD_NO_LOOKAHEAD',
    candleCount: historicalCandles.length,
    firstCandleTime: historicalCandles[0]?.time || null,
    lastCandleTime:
      historicalCandles[historicalCandles.length - 1]?.time || null,
    metrics: calculateBacktestMetrics(trades),
    trades
  };
}

function buildBacktestSummary(results) {
  const validResults = results.filter(
    (result) => result && result.ok
  );

  const allTrades = validResults.flatMap(
    (result) => result.trades || []
  );

  return {
    version: VERSION,
    method: 'WALK_FORWARD_NO_LOOKAHEAD',
    expiryResults: validResults.map((result) => ({
      expiryMinutes: result.expiryMinutes,
      metrics: result.metrics
    })),
    combinedMetrics: calculateBacktestMetrics(allTrades),
    scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY'
  };
}

// ============================================================
// V10.4.0 — BACKTEST API
// ============================================================

// Backtest a selected pair using cached historical candles.
// No new provider request is made by this endpoint.
app.post('/api/backtest', (req, res) => {
  const pair = normalizePair(req.body?.pair || '');

  if (!pair || !PAIRS.includes(pair)) {
    return res.status(400).json({
      ok: false,
      reason: 'UNSUPPORTED_PAIR'
    });
  }

  const entry = getMarketCacheEntry(pair);

  if (!entry || !Array.isArray(entry.candles)) {
    return res.status(503).json({
      ok: false,
      reason: 'NO_CACHED_HISTORICAL_DATA',
      pair
    });
  }

  const expiryMinutes = Number(
    req.body?.expiryMinutes || 1
  );

  const result = runWalkForwardBacktest(
    pair,
    entry.candles,
    expiryMinutes
  );

  if (!result.ok) {
    return res.status(422).json(result);
  }

  return res.json({
    ...result,
    dataFetchedAt: entry.fetchedAt,
    dataSource: entry.source
  });
});

// Run the same cached history against 1, 2 and 3 minute expiries.
app.post('/api/backtest/all', (req, res) => {
  const pair = normalizePair(req.body?.pair || '');

  if (!pair || !PAIRS.includes(pair)) {
    return res.status(400).json({
      ok: false,
      reason: 'UNSUPPORTED_PAIR'
    });
  }

  const entry = getMarketCacheEntry(pair);

  if (!entry || !Array.isArray(entry.candles)) {
    return res.status(503).json({
      ok: false,
      reason: 'NO_CACHED_HISTORICAL_DATA',
      pair
    });
  }

  const results = [1, 2, 3].map((expiryMinutes) =>
    runWalkForwardBacktest(
      pair,
      entry.candles,
      expiryMinutes
    )
  );

  const failed = results.filter((result) => !result.ok);

  if (failed.length) {
    return res.status(422).json({
      ok: false,
      pair,
      reason: 'BACKTEST_COULD_NOT_COMPLETE_ALL_EXPIRIES',
      results
    });
  }

  return res.json({
    ok: true,
    pair,
    dataFetchedAt: entry.fetchedAt,
    dataSource: entry.source,
    results,
    summary: buildBacktestSummary(results)
  });
});

/* -------------------------------------------------------
   V10.4.0 COMPATIBILITY CONSTANTS
------------------------------------------------------- */

// Part 1 stores these limits in seconds.
// Other sections use milliseconds.

const DATA_FRESHNESS_MS =
  FRESHNESS_SECONDS * 1000;

const HARD_STALE_MS =
  HARD_STALE_SECONDS * 1000;

// Keep the broker-price tolerance consistent
// with the approved Part 1 configuration.

const BROKER_MAX_GAP_PIPS =
  DEFAULT_MAX_PRICE_GAP_PIPS;

/* -------------------------------------------------------
   API ERROR HANDLING
------------------------------------------------------- */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    version: VERSION,
    error: 'API endpoint not found.',
    path: req.path
  });
});

app.use((error, req, res, next) => {
  console.error(
    'Unhandled API error:',
    error.message || error
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    version: VERSION,
    error: 'Internal server error.'
  });
});

/* -------------------------------------------------------
   BACKGROUND SCANNER SCHEDULER
------------------------------------------------------- */

function startBackgroundScanner() {
  if (backgroundScanTimer) {
    clearInterval(backgroundScanTimer);
    backgroundScanTimer = null;
  }

  // Start the first complete scan shortly after startup.
  setTimeout(() => {
    if (!scannerRunning) {
      runBackgroundScan().catch(error => {
        lastScanError = String(
          error.message || error
        );

        console.error(
          'Initial background scan failed:',
          lastScanError
        );
      });
    }
  }, 5000);

  // Continue scanning every hour.
  backgroundScanTimer = setInterval(() => {
    if (scannerRunning) return;

    runBackgroundScan().catch(error => {
      lastScanError = String(
        error.message || error
      );

      console.error(
        'Scheduled background scan failed:',
        lastScanError
      );
    });
  }, SCAN_INTERVAL_MS);
}

/* -------------------------------------------------------
   APPLICATION STARTUP
------------------------------------------------------- */

async function startServer() {
  try {
    await initializeDatabase();

    const server = app.listen(PORT, () => {
      console.log('----------------------------------');
      console.log(`PO AI PREDICTOR ${VERSION}`);
      console.log(`Server listening on port ${PORT}`);
      console.log('Market mode: LIVE FOREX ONLY');
      console.log(`Total pairs: ${PAIRS.length}`);
      console.log(`Priority pairs: ${PRIORITY_PAIRS.length}`);
      console.log(`Background pairs: ${BACKGROUND_PAIRS.length}`);
      console.log(
        `Daily provider budget: ${DAILY_USABLE_LIMIT}`
      );
      console.log(
        `Scanner daily budget: ${SCANNER_DAILY_BUDGET}`
      );
      console.log(
        `Scheduled scan interval: ${
          SCAN_INTERVAL_MS / 60000
        } minutes`
      );
      console.log(
        `Database: ${
          databaseReady ? 'POSTGRESQL' : 'MEMORY_ONLY'
        }`
      );
      console.log('----------------------------------');
    });

    server.on('error', error => {
      console.error(
        'HTTP server error:',
        error.message || error
      );
    });

    startBackgroundScanner();

  } catch (error) {
    console.error(
      'Server startup failed:',
      error.message || error
    );

    process.exit(1);
  }
}

startServer();
