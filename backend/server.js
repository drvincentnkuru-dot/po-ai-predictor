
'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

const VERSION = 'V9.5.0';
const PORT = Number(process.env.PORT || 10000);
const API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVE_DATA_KEY ||
  '';

const PROVIDER_URL = 'https://api.twelvedata.com/time_series';

const PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD',
  'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'CAD/JPY',
  'CHF/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF', 'GBP/AUD', 'GBP/CAD',
  'GBP/CHF', 'NZD/JPY', 'NZD/CAD', 'AUD/CAD', 'AUD/CHF', 'CAD/CHF'
];

const TIMEFRAMES = [1];

const DAILY_REQUEST_LIMIT = 768;
const DAILY_RESERVE = 32;
const DAILY_USABLE_LIMIT = DAILY_REQUEST_LIMIT - DAILY_RESERVE;

const REQUESTS_PER_MINUTE = 6;
const REQUEST_SPACING_MS = 10000;
const PROVIDER_TIMEOUT_MS = 12000;

const PAIR_CACHE_MS = 120000;
const FRESHNESS_SECONDS = { 1: 150 };
const HARD_STALE_SECONDS = 300;

const SCAN_COOLDOWN_MS = 240000;
const SCAN_BATCH_SIZE = PAIRS.length;

const pairCache = new Map();
const inFlight = new Map();
const latestMarkets = new Map();

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
let scanProgress = {
  completed: 0,
  total: PAIRS.length,
  pair: null
};
let cachedResult = null;
let lastScanError = null;

const finite = v =>
  v !== null &&
  v !== undefined &&
  v !== '' &&
  Number.isFinite(Number(v));

const avg = values =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

const round = (value, decimals = 6) =>
  finite(value) ? Number(Number(value).toFixed(decimals)) : null;

const iso = value =>
  Number.isFinite(value) ? new Date(value).toISOString() : null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    version: VERSION
  };
}

function enqueueProviderRequest(task) {
  const run = requestQueue.then(task, task);
  requestQueue = run.catch(() => {});
  return run;
}

async function providerFetch(pair) {
  return enqueueProviderRequest(async () => {
    if (!API_KEY) {
      throw new Error(
        'Missing Twelve Data API key. Configure TWELVE_DATA_API_KEY in Render.'
      );
    }

    while (true) {
      resetDailyCounter();

      const now = Date.now();
      requestTimes = requestTimes.filter(t => now - t < 60000);

      if (dailyCreditsUsed >= DAILY_USABLE_LIMIT) {
        throw new Error('Daily Twelve Data safety limit reached.');
      }

      const minuteWait =
        requestTimes.length >= REQUESTS_PER_MINUTE
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
    url.searchParams.set('outputsize', '180');
    url.searchParams.set('timezone', 'UTC');
    url.searchParams.set('apikey', API_KEY);

    const sentAt = Date.now();
    lastProviderRequestAt = sentAt;
    requestTimes.push(sentAt);
    providerRequests++;
    dailyCreditsUsed++;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PROVIDER_TIMEOUT_MS
    );

    let response;

    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
    } catch (error) {
      throw new Error(
        error.name === 'AbortError'
          ? 'Twelve Data request timed out.'
          : `Twelve Data network error: ${error.message || error}`
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Twelve Data returned HTTP ${response.status}.`);
    }

    const json = await response.json();

    if (
      json.status === 'error' ||
      json.code ||
      !Array.isArray(json.values)
    ) {
      throw new Error(
        json.message || 'Twelve Data returned no candle values.'
      );
    }

    const candles = normalizeCandles(json.values);

    if (!candles.length) {
      throw new Error('No valid candles were returned by the provider.');
    }

    return {
      candles,
      fetchedAt: Date.now(),
      source: 'Twelve Data LIVE'
    };
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

    byTime.set(time, { time, open, high, low, close });
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function getPairData(pair, forceRefresh = false) {
  const cached = pairCache.get(pair);

  if (
    !forceRefresh &&
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
  return candles.filter(c => c.time + 60000 <= now);
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;

  let value = avg(values.slice(0, period));
  out[period - 1] = value;

  const alpha = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value = values[i] * alpha + value * (1 - alpha);
    out[i] = value;
  }

  return out;
}

function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;

  const calculate = () =>
    averageLoss === 0
      ? (averageGain === 0 ? 50 : 100)
      : 100 - 100 / (1 + averageGain / averageLoss);

  out[period] = calculate();

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) + Math.max(change, 0)) / period;

    averageLoss =
      (averageLoss * (period - 1) + Math.max(-change, 0)) / period;

    out[i] = calculate();
  }

  return out;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);

  const line = values.map((_, i) =>
    finite(fast[i]) && finite(slow[i])
      ? fast[i] - slow[i]
      : null
  );

  const valid = line.filter(finite);
  const compactSignal = ema(valid, 9);
  const signal = Array(values.length).fill(null);

  let j = 0;

  for (let i = 0; i < line.length; i++) {
    if (finite(line[i])) signal[i] = compactSignal[j++];
  }

  const histogram = line.map((value, i) =>
    finite(value) && finite(signal[i])
      ? value - signal[i]
      : null
  );

  return { line, signal, histogram };
}

function stochastic(candles, period = 14, signalPeriod = 3) {
  const k = Array(candles.length).fill(null);
  const d = Array(candles.length).fill(null);

  for (let i = period - 1; i < candles.length; i++) {
    const sample = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...sample.map(c => c.high));
    const low = Math.min(...sample.map(c => c.low));

    k[i] = high === low
      ? 50
      : 100 * (candles[i].close - low) / (high - low);

    const values = k.slice(i - signalPeriod + 1, i + 1);

    if (
      values.length === signalPeriod &&
      values.every(finite)
    ) {
      d[i] = avg(values);
    }
  }

  return { k, d };
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

function candlePattern(candles) {
  if (candles.length < 2) {
    return { name: 'INSUFFICIENT CANDLES', direction: 'NEUTRAL' };
  }

  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const body = Math.abs(current.close - current.open);
  const range = Math.max(current.high - current.low, Number.EPSILON);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;

  if (body / range <= 0.1) {
    return { name: 'DOJI', direction: 'NEUTRAL' };
  }

  if (
    body / range <= 0.35 &&
    lowerWick >= body * 2 &&
    upperWick <= body * 0.7
  ) {
    return { name: 'HAMMER', direction: 'BULLISH' };
  }

  if (
    body / range <= 0.35 &&
    upperWick >= body * 2 &&
    lowerWick <= body * 0.7
  ) {
    return { name: 'SHOOTING STAR', direction: 'BEARISH' };
  }

  if (
    previous.close < previous.open &&
    current.close > current.open &&
    current.open <= previous.close &&
    current.close >= previous.open
  ) {
    return { name: 'BULLISH ENGULFING', direction: 'BULLISH' };
  }

  if (
    previous.close > previous.open &&
    current.close < current.open &&
    current.open >= previous.close &&
    current.close <= previous.open
  ) {
    return { name: 'BEARISH ENGULFING', direction: 'BEARISH' };
  }

  return { name: 'NO CLEAR PATTERN', direction: 'NEUTRAL' };
}

function marketPsychology(candles) {
  if (candles.length < 10) {
    return {
      psychology: 'INSUFFICIENT PRICE EVIDENCE',
      direction: 'NEUTRAL',
      buyerPressure: 0,
      sellerPressure: 0
    };
  }

  const recent = candles.slice(-6);
  const last = recent[recent.length - 1];

  let up = 0;
  let down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) up++;
    if (recent[i].close < recent[i - 1].close) down++;
  }

  const range = Math.max(last.high - last.low, Number.EPSILON);
  const closeLocation = (last.close - last.low) / range;

  let psychology = 'MIXED BUYER/SELLER PRESSURE';
  let direction = 'NEUTRAL';

  if (up >= 4 && closeLocation >= 0.65) {
    psychology = 'BUYERS SHOWING RECENT CONTROL';
    direction = 'BULLISH';
  } else if (down >= 4 && closeLocation <= 0.35) {
    psychology = 'SELLERS SHOWING RECENT CONTROL';
    direction = 'BEARISH';
  } else if (Math.abs(last.close - last.open) / range < 0.15) {
    psychology = 'INDECISION / SMALL REAL BODY';
  }

  return {
    psychology,
    direction,
    buyerPressure: up,
    sellerPressure: down
  };
}

function trendLine(candles) {
  const sample = candles.slice(-20);

  if (sample.length < 10) {
    return {
      direction: 'UNAVAILABLE',
      slopePercent: null,
      aboveLine: null,
      belowLine: null
    };
  }

  const n = sample.length;
  const xs = sample.map((_, i) => i);
  const ys = sample.map(c => c.close);
  const meanX = avg(xs);
  const meanY = avg(ys);

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (xs[i] - meanX) * (ys[i] - meanY);
    denominator += (xs[i] - meanX) ** 2;
  }

  const slope = denominator ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;
  const projected = intercept + slope * (n - 1);
  const lastPrice = ys[n - 1];
  const slopePercent = meanY
    ? (slope / meanY) * 100
    : 0;

  let direction = 'SIDEWAYS';

  if (slopePercent > 0.003) direction = 'BULLISH';
  if (slopePercent < -0.003) direction = 'BEARISH';

  return {
    direction,
    slopePercent: round(slopePercent, 5),
    projectedPrice: round(projected),
    aboveLine: lastPrice > projected,
    belowLine: lastPrice < projected
  };
}

function supportResistance(candles) {
  const previous = candles.slice(-31, -1);

  if (previous.length < 10) {
    return {
      support: null,
      resistance: null,
      position: 'UNAVAILABLE',
      direction: 'NEUTRAL',
      distanceToSupportPercent: null,
      distanceToResistancePercent: null
    };
  }

  const support = Math.min(...previous.map(c => c.low));
  const resistance = Math.max(...previous.map(c => c.high));
  const last = candles[candles.length - 1];
  const range = Math.max(last.high - last.low, Number.EPSILON);

  const distanceToSupportPercent =
    last.close ? ((last.close - support) / last.close) * 100 : null;

  const distanceToResistancePercent =
    last.close ? ((resistance - last.close) / last.close) * 100 : null;

  let position = 'BETWEEN LEVELS';
  let direction = 'NEUTRAL';

  if (last.close > resistance) {
    position = 'CLOSED-CANDLE RESISTANCE BREAKOUT';
    direction = 'BULLISH';
  } else if (last.close < support) {
    position = 'CLOSED-CANDLE SUPPORT BREAKDOWN';
    direction = 'BEARISH';
  } else if (
    last.low <= support + range * 0.15 &&
    last.close > last.open
  ) {
    position = 'POSSIBLE SUPPORT REJECTION';
    direction = 'BULLISH';
  } else if (
    last.high >= resistance - range * 0.15 &&
    last.close < last.open
  ) {
    position = 'POSSIBLE RESISTANCE REJECTION';
    direction = 'BEARISH';
  }

  return {
    support: round(support),
    resistance: round(resistance),
    position,
    direction,
    distanceToSupportPercent: round(distanceToSupportPercent, 4),
    distanceToResistancePercent: round(distanceToResistancePercent, 4)
  };
}

function emptyMarket(
  pair = 'NO MARKET',
  reason = 'No usable market data.'
) {
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
    supportResistance: {},
    trendLine: {},
    marketPsychology: 'NO PRICE EVIDENCE',
    priceAction: 'NO DATA',
    candlePattern: { name: 'UNAVAILABLE', direction: 'NEUTRAL' },
    indicators: {},
    reasons: [reason],
    source: 'Twelve Data LIVE',
    evidenceLabel: 'Evidence score, not win probability'
  };
}

function scoreMarket(rawCandles, pair, fetchedAt) {
  const now = Date.now();
  const candles = closedCandles(rawCandles, now);
  const last = candles[candles.length - 1];

  if (!last) {
    return emptyMarket(pair, 'No completed 1-minute candles are available.');
  }

  const age = Math.max(0, (now - (last.time + 60000)) / 1000);

  const freshness =
    age <= FRESHNESS_SECONDS[1]
      ? 'FRESH'
      : age <= HARD_STALE_SECONDS
        ? 'STALE'
        : 'HARD STALE';

  const closes = candles.map(c => c.close);
  const i = candles.length - 1;
  const p = i - 1;

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsi14 = rsi(closes, 14);
  const mc = macd(closes);
  const st = stochastic(candles);

  const emaCross = crossover(ema9[p], ema21[p], ema9[i], ema21[i]);
  const macdCross = crossover(
    mc.line[p], mc.signal[p], mc.line[i], mc.signal[i]
  );
  const stochCross = crossover(st.k[p], st.d[p], st.k[i], st.d[i]);

  const pattern = candlePattern(candles);
  const psychology = marketPsychology(candles);
  const levels = supportResistance(candles);
  const line = trendLine(candles);

  let callScore = 0;
  let putScore = 0;
  const reasons = [];

  function add(direction, points, reason) {
    if (direction === 'BULLISH') callScore += points;
    if (direction === 'BEARISH') putScore += points;

    if (direction !== 'NEUTRAL') reasons.push(reason);
  }

  // Primary evidence: candle patterns.
  const patternPoints = {
    'BULLISH ENGULFING': 24,
    'BEARISH ENGULFING': 24,
    'HAMMER': 18,
    'SHOOTING STAR': 18
  };

  add(
    pattern.direction,
    patternPoints[pattern.name] || 0,
    `Candlestick pattern: ${pattern.name}.`
  );

  // Primary evidence: market psychology.
  add(
    psychology.direction,
    18,
    `Market psychology: ${psychology.psychology}.`
  );

  // Primary evidence: support and resistance.
  if (levels.position === 'CLOSED-CANDLE RESISTANCE BREAKOUT') {
    add('BULLISH', 20, 'Latest completed candle closed above resistance.');
  } else if (levels.position === 'CLOSED-CANDLE SUPPORT BREAKDOWN') {
    add('BEARISH', 20, 'Latest completed candle closed below support.');
  } else if (levels.position === 'POSSIBLE SUPPORT REJECTION') {
    add('BULLISH', 14, 'Price action suggests possible support rejection.');
  } else if (levels.position === 'POSSIBLE RESISTANCE REJECTION') {
    add('BEARISH', 14, 'Price action suggests possible resistance rejection.');
  }

  // Primary evidence: trend line.
  add(
    line.direction,
    16,
    `20-candle trend-line direction: ${line.direction}.`
  );

  // Secondary indicators: supportive, never the sole reason for a trade.
  if (emaCross === 'BULLISH_CROSSOVER') {
    add('BULLISH', 6, 'EMA9 crossed above EMA21.');
  } else if (emaCross === 'BEARISH_CROSSOVER') {
    add('BEARISH', 6, 'EMA9 crossed below EMA21.');
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

  if (macdCross === 'BULLISH_CROSSOVER') {
    add('BULLISH', 5, 'MACD bullish crossover.');
  } else if (macdCross === 'BEARISH_CROSSOVER') {
    add('BEARISH', 5, 'MACD bearish crossover.');
  }

  if (stochCross === 'BULLISH_CROSSOVER' && st.k[i] < 35) {
    add('BULLISH', 3, 'Stochastic bullish crossover in lower zone.');
  } else if (stochCross === 'BEARISH_CROSSOVER' && st.k[i] > 65) {
    add('BEARISH', 3, 'Stochastic bearish crossover in upper zone.');
  }

  callScore = Math.min(100, callScore);
  putScore = Math.min(100, putScore);

  const gap = Math.abs(callScore - putScore);
  const direction =
    callScore > putScore ? 'CALL' :
    putScore > callScore ? 'PUT' : 'NONE';

  const winning = Math.max(callScore, putScore);
  const opposing = direction === 'CALL'
    ? putScore
    : direction === 'PUT'
      ? callScore
      : 0;

  const guards = [];

  if (candles.length < 40) {
    guards.push('Fewer than 40 completed 1-minute candles are available.');
  }

  if (freshness !== 'FRESH') {
    guards.push('Market data is not fresh enough.');
  }

  if (
    !finite(rsi14[i]) ||
    !finite(ema9[i]) ||
    !finite(ema21[i]) ||
    line.direction === 'UNAVAILABLE' ||
    levels.position === 'UNAVAILABLE'
  ) {
    guards.push('Required price-history evidence is unavailable.');
  }

  if (direction === 'NONE' || gap < 12) {
    guards.push('Directional evidence conflicts or the score gap is too small.');
  }

  if (winning < 35) {
    guards.push('Evidence score is below the minimum research threshold.');
  }

  if (opposing >= 28) {
    guards.push('Opposing evidence is material.');
  }

  if (
    direction === 'CALL' &&
    pattern.direction === 'BEARISH' &&
    levels.direction === 'BEARISH'
  ) {
    guards.push('Candlestick and support/resistance evidence oppose BUY.');
  }

  if (
    direction === 'PUT' &&
    pattern.direction === 'BULLISH' &&
    levels.direction === 'BULLISH'
  ) {
    guards.push('Candlestick and support/resistance evidence oppose SELL.');
  }

  const signal = guards.length
    ? 'NO TRADE'
    : direction === 'CALL'
      ? 'BUY'
      : 'SELL';

  reasons.push(...guards.map(reason => `NO TRADE: ${reason}`));

  const nowSeconds = Math.floor(now / 1000);
  const nextBoundary = (Math.floor(nowSeconds / 60) + 1) * 60;
  const entrySeconds = Math.max(nextBoundary, nowSeconds + 10);

  return {
    pair,
    timeframe: 1,
    signal,
    confidence: signal === 'NO TRADE' ? null : winning,
    callScore,
    putScore,
    gap,

    entryTime: signal === 'NO TRADE'
      ? null
      : new Date(entrySeconds * 1000).toISOString(),

    expiryTime: signal === 'NO TRADE'
      ? null
      : new Date((entrySeconds + 60) * 1000).toISOString(),

    currentPrice: last.close,
    entryPrice: last.close,
    freshness,
    dataAgeSeconds: round(age, 1),
    lastCandle: iso(last.time),

    supportResistance: {
      support: levels.support,
      resistance: levels.resistance,
      position: levels.position,
      distanceToSupportPercent: levels.distanceToSupportPercent,
      distanceToResistancePercent: levels.distanceToResistancePercent
    },

    trendLine: line,
    marketPsychology: psychology.psychology,
    priceAction: levels.position,
    candlePattern: pattern,

    indicators: {
      ema9: round(ema9[i]),
      ema21: round(ema21[i]),
      emaCross,
      rsi14: round(rsi14[i], 2),
      macd: {
        line: round(mc.line[i]),
        signal: round(mc.signal[i]),
        histogram: round(mc.histogram[i]),
        crossover: macdCross
      },
      stochastic: {
        k: round(st.k[i], 2),
        d: round(st.d[i], 2),
        crossover: stochCross
      }
    },

    reasons,
    source: 'Twelve Data LIVE',
    fetchedAt: iso(fetchedAt),
    evidenceLabel: 'Evidence score, not win probability'
  };
}

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
  const freshness =
    age <= FRESHNESS_SECONDS[1] ? 'FRESH' :
    age <= HARD_STALE_SECONDS ? 'STALE' : 'HARD STALE';

  if (freshness === 'FRESH') {
    return {
      ...market,
      freshness,
      dataAgeSeconds: Math.round(age)
    };
  }

  return {
    ...market,
    freshness,
    dataAgeSeconds: Math.round(age),
    signal: 'NO TRADE',
    confidence: null,
    reasons: [
      ...(Array.isArray(market.reasons) ? market.reasons : []),
      'No trade: latest completed candle is not fresh enough.'
    ]
  };
}

function rankCandidates(markets) {
  return markets
    .map(m => evaluateFreshness(m))
    .sort((a, b) =>
      (b.freshness === 'FRESH' ? 1 : 0) -
        (a.freshness === 'FRESH' ? 1 : 0) ||
      Math.max(b.callScore || 0, b.putScore || 0) -
        Math.max(a.callScore || 0, a.putScore || 0) ||
      (b.gap || 0) - (a.gap || 0) ||
      (a.dataAgeSeconds ?? Infinity) - (b.dataAgeSeconds ?? Infinity)
    )
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

function makeResponse(selectedMarket, rankedCandidates = [], scanner = {}) {
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
      batchSize: SCAN_BATCH_SIZE,
      pairs: PAIRS.length,
      progress: { ...scanProgress },
      cooldownRemainingMs: Math.max(
        0,
        SCAN_COOLDOWN_MS - (Date.now() - lastScanStartedAtMs)
      ),
      ...scanner
    },
    metadata: metadata(),
    source: 'Twelve Data LIVE',
    diagnostic: { lastScanError }
  };
}

function diagnosticMarket(markets) {
  if (!markets.length) return emptyMarket();

  return markets
    .map(m => evaluateFreshness(m))
    .sort((a, b) =>
      (b.freshness === 'FRESH' ? 1 : 0) -
        (a.freshness === 'FRESH' ? 1 : 0) ||
      Math.max(b.callScore || 0, b.putScore || 0) -
        Math.max(a.callScore || 0, a.putScore || 0)
    )[0];
}

function refreshCandidates() {
  const markets = [...latestMarkets.values()].map(evaluateFreshness);
  const ranked = rankCandidates(markets);
  const best = ranked.find(m => m.freshness === 'FRESH' &&
    (m.signal === 'BUY' || m.signal === 'SELL'));

  const selected = best
    ? latestMarkets.get(best.pair)
    : diagnosticMarket(markets);

  cachedResult = makeResponse(
    selected ? evaluateFreshness(selected) : emptyMarket(),
    ranked
  );
}

async function scanBatch() {
  if (scannerRunning || !API_KEY) return;

  scannerRunning = true;
  scannerStartedAt = iso(Date.now());
  lastScanStartedAtMs = Date.now();
  lastScanError = null;
  scanProgress = { completed: 0, total: PAIRS.length, pair: null };

  try {
    for (const pair of PAIRS) {
      scanProgress.pair = pair;

      try {
        const data = await getPairData(pair, true);
        latestMarkets.set(pair, scoreMarket(data.candles, pair, data.fetchedAt));
      } catch (error) {
        lastScanError = `${pair}: ${String(error.message || error)}`;
      } finally {
        scanProgress.completed++;
      }

      // Keep the available results usable while the remaining pairs scan.
      refreshCandidates();
    }

    totalScanned += scanProgress.completed;
    lastScanAt = iso(Date.now());
    refreshCandidates();
  } finally {
    scannerRunning = false;
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

  if (DAILY_USABLE_LIMIT - dailyCreditsUsed < PAIRS.length) {
    lastScanError = 'Not enough safe daily credits for a full 24-pair scan.';
    return false;
  }

  void scanBatch().catch(error => {
    lastScanError = String(error.message || error);
    scannerRunning = false;
  });

  return true;
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'PO AI Predictor API',
    version: VERSION,
    endpoints: ['/api/best', '/api/health', '/api/scan', '/api/analyze']
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    provider: 'Twelve Data LIVE',
    configured: Boolean(API_KEY),
    scannerRunning,
    scannerEnabled: Boolean(API_KEY),
    scannerStartedAt,
    lastScanAt,
    totalScanned,
    scanProgress: { ...scanProgress },
    cooldownRemainingMs: Math.max(
      0,
      SCAN_COOLDOWN_MS - (Date.now() - lastScanStartedAtMs)
    ),
    metadata: metadata()
  });
});

app.get('/api/best', (_req, res) => {
  if (!cachedResult) {
    refreshCandidates();
  }

  const response = cachedResult || makeResponse(emptyMarket());

  response.scanner = {
    ...(response.scanner || {}),
    running: scannerRunning,
    startedAt: scannerStartedAt,
    lastScanAt,
    totalScanned,
    batchSize: SCAN_BATCH_SIZE,
    pairs: PAIRS.length,
    progress: { ...scanProgress },
    cooldownRemainingMs: Math.max(
      0,
      SCAN_COOLDOWN_MS - (Date.now() - lastScanStartedAtMs)
    )
  };

  response.diagnostic = { lastScanError };
  res.json(response);
});

app.post('/api/scan', (_req, res) => {
  if (!API_KEY) {
    return res.status(503).json({
      ok: false,
      version: VERSION,
      error: 'The Twelve Data API key is not configured on the server.'
    });
  }

  if (scannerRunning) {
    return res.status(409).json({
      ok: false,
      version: VERSION,
      error: 'A full scan is already running.',
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
      error: 'Please wait for the scan cooldown.',
      cooldownRemainingMs: remaining
    });
  }

  resetDailyCounter();

  if (DAILY_USABLE_LIMIT - dailyCreditsUsed < PAIRS.length) {
    return res.status(429).json({
      ok: false,
      version: VERSION,
      error: 'Not enough safe daily API credits for a full scan.',
      dailyCreditsRemaining: Math.max(
        0,
        DAILY_USABLE_LIMIT - dailyCreditsUsed
      ),
      requiredCredits: PAIRS.length
    });
  }

  const started = startScanIfPossible();

  return res.status(started ? 202 : 429).json({
    ok: started,
    version: VERSION,
    message: started
      ? 'Full 24-pair scan started in the background.'
      : 'Scan could not start; check cooldown and API credits.',
    scanner: {
      running: scannerRunning,
      progress: { ...scanProgress },
      totalPairs: PAIRS.length,
      timeframesPerPair: TIMEFRAMES
    },
    note: 'The provider request limits mean a cold full scan takes longer than 10 seconds.'
  });
});

app.get('/api/analyze', (_req, res) => {
  // Respond quickly from the latest scored results, then refresh in background.
  if (!cachedResult) refreshCandidates();

  const markets = [...latestMarkets.values()].map(evaluateFreshness);
  const rankedCandidates = rankCandidates(markets);

  const best = rankedCandidates.find(m =>
    m.freshness === 'FRESH' &&
    (m.signal === 'BUY' || m.signal === 'SELL')
  );

  const selected = best
    ? latestMarkets.get(best.pair)
    : diagnosticMarket(markets);

  const selectedMarket = selected
    ? evaluateFreshness(selected)
    : emptyMarket(
        'NO MARKET',
        API_KEY
          ? 'No scored pair data is available yet. The first scan must collect data.'
          : 'The Twelve Data API key is not configured.'
      );

  const scanStarted = startScanIfPossible();

  return res.json(
    makeResponse(selectedMarket, rankedCandidates, {
      analysisMode: 'ALL 24 PAIRS / 1-MINUTE',
      scanStarted,
      note: 'Results are based on available scored data; pairs not yet scanned are not represented as fresh.'
    })
  );
});

if (require.main === module) {
  app.listen(PORT, () =>
    console.log(`PO AI Predictor ${VERSION} listening on ${PORT}`)
  );
}

module.exports = app;
