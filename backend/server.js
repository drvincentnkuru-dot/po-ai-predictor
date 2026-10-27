
'use strict';

/*
 PO AI PREDICTOR V9.3.0
 Live Twelve Data scanner. Backend is the single signal engine.
 A setup score is NOT a win probability. No guaranteed outcome.
*/

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

const VERSION = 'V9.3.0';
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_KEY || '';
const PROVIDER_URL = 'https://api.twelvedata.com/time_series';
const REQUESTS_PER_MINUTE = 6;
const DAILY_REQUEST_LIMIT = 768;
const DAILY_RESERVE = 32;
const DAILY_USABLE_LIMIT = DAILY_REQUEST_LIMIT - DAILY_RESERVE;
const REQUEST_DELAY_MS = 1500;
const PAIR_CACHE_MS = 60 * 1000;
const RESULT_CACHE_MS = 30 * 1000;
const SCAN_INTERVAL_MS = 60 * 1000;
const SCAN_BATCH_SIZE = 6;
const FRESHNESS_SECONDS = { 1: 90, 2: 150, 3: 210 };
const HARD_STALE_SECONDS = 300;
const ENTRY_BUFFER_SECONDS = 30;
const MIN_ENTRY_SECONDS = 30;
const MIN_1M_CANDLES = 80;
const MIN_5M_CANDLES = 30;
const TIMEFRAMES = [1, 2, 3];

const PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP',
  'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'CAD/JPY', 'CHF/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF',
  'GBP/AUD', 'GBP/CAD', 'GBP/CHF', 'NZD/JPY', 'NZD/CAD', 'AUD/CAD', 'AUD/CHF', 'CAD/CHF'
];

const pairCache = new Map();
let providerRequests = 0;
let dailyCreditsUsed = 0;
let dailyDate = new Date().toISOString().slice(0, 10);
let minuteRequestTimes = [];
let lastProviderRequestAt = 0;
let scannerRunning = false;
let scannerStartedAt = null;
let lastScanAt = null;
let totalScanned = 0;
let scanCursor = 0;
let cachedResult = null;
let cachedResultAt = 0;
let lastScanError = null;

function resetDailyCounterIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyDate) {
    dailyDate = today;
    dailyCreditsUsed = 0;
    minuteRequestTimes = [];
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function finite(n) {
  return Number.isFinite(Number(n));
}

function round(n, digits = 6) {
  return finite(n) ? Number(Number(n).toFixed(digits)) : null;
}

function average(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}

function stddev(values) {
  if (!values.length) return null;
  const m = average(values);
  return Math.sqrt(average(values.map(v => (v - m) ** 2)));
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/* =========================================================
   CANDLE NORMALIZATION AND CLOSED-CANDLE FILTERING
========================================================= */

function normalizeCandles(raw) {
  return raw.map(c => {
    const time = Date.parse(c.datetime || c.time || '');
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);

    if (
      !Number.isFinite(time) ||
      ![open, high, low, close].every(Number.isFinite) ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high)
    ) {
      return null;
    }

    return {
      time,
      open,
      high,
      low,
      close,
      volume: finite(c.volume) ? Number(c.volume) : null
    };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}

function getClosedCandles(candles, minutes, now = Date.now()) {
  const interval = minutes * 60 * 1000;

  return candles
    .filter(c => c.time + interval <= now)
    .map(c => ({ ...c }));
}

function aggregateCandles(oneMinuteCandles, minutes, now = Date.now()) {
  if (minutes === 1) {
    return getClosedCandles(oneMinuteCandles, 1, now);
  }

  const groups = new Map();
  const interval = minutes * 60 * 1000;

  for (const c of oneMinuteCandles) {
    const bucket = Math.floor(c.time / interval) * interval;

    if (bucket + interval > now) continue;

    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(c);
  }

  const result = [];

  for (const [time, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.time - b.time);

    // Incomplete or discontinuous buckets are never used.
    if (list.length !== minutes) continue;

    let contiguous = true;

    for (let i = 1; i < list.length; i++) {
      if (list[i].time - list[i - 1].time !== 60_000) {
        contiguous = false;
        break;
      }
    }

    if (!contiguous) continue;

    result.push({
      time,
      open: list[0].open,
      high: Math.max(...list.map(c => c.high)),
      low: Math.min(...list.map(c => c.low)),
      close: list[list.length - 1].close,
      volume: null
    });
  }

  return result;
}

/* =========================================================
   INDICATORS
========================================================= */

function emaSeries(values, period) {
  if (values.length < period) return [];

  const out = Array(values.length).fill(null);
  let seed = average(values.slice(0, period));
  out[period - 1] = seed;

  const alpha = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    seed = values[i] * alpha + seed * (1 - alpha);
    out[i] = seed;
  }

  return out;
}

function rsiSeries(values, period = 9) {
  const out = Array(values.length).fill(null);

  if (values.length <= period) return out;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  const calculate = () => {
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  };

  out[period] = calculate();

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;

    out[i] = calculate();
  }

  return out;
}

function trueRanges(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;

    return Math.max(
      c.high - c.low,
      Math.abs(c.high - candles[i - 1].close),
      Math.abs(c.low - candles[i - 1].close)
    );
  });
}

function wilderSmooth(values, period) {
  const out = Array(values.length).fill(null);

  if (values.length < period) return out;

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  out[period - 1] = sum;

  for (let i = period; i < values.length; i++) {
    out[i] = out[i - 1] - out[i - 1] / period + values[i];
  }

  return out;
}

function adxWilder(candles, period = 14) {
  const n = candles.length;
  const tr = trueRanges(candles);
  const plusDM = Array(n).fill(0);
  const minusDM = Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;

    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  const smTR = wilderSmooth(tr, period);
  const smPlus = wilderSmooth(plusDM, period);
  const smMinus = wilderSmooth(minusDM, period);
  const dx = Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (smTR[i] === null || smTR[i] === 0 ||
        smPlus[i] === null || smMinus[i] === null) {
      continue;
    }

    const pdi = 100 * smPlus[i] / smTR[i];
    const mdi = 100 * smMinus[i] / smTR[i];

    dx[i] = pdi + mdi === 0
      ? 0
      : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  }

  const out = Array(n).fill(null);
  const first = dx.findIndex(v => v !== null);

  if (first < 0 || first + period > n) return out;

  const seedValues = dx.slice(first, first + period);

  if (seedValues.some(v => v === null)) return out;

  let seed = average(seedValues);
  const start = first + period - 1;

  out[start] = seed;

  for (let i = start + 1; i < n; i++) {
    if (dx[i] === null) continue;
    seed = ((seed * (period - 1)) + dx[i]) / period;
    out[i] = seed;
  }

  return out;
}

function stochasticSeries(candles, kPeriod = 14, dPeriod = 3) {
  const k = Array(candles.length).fill(null);

  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...slice.map(c => c.high));
    const lowest = Math.min(...slice.map(c => c.low));

    k[i] = highest === lowest
      ? 50
      : 100 * (candles[i].close - lowest) / (highest - lowest);
  }

  const d = Array(candles.length).fill(null);

  for (let i = 0; i < candles.length; i++) {
    const values = k.slice(Math.max(0, i - dPeriod + 1), i + 1);

    if (values.length === dPeriod && values.every(v => v !== null)) {
      d[i] = average(values);
    }
  }

  return { k, d };
}

function macdSeries(values) {
  const e12 = emaSeries(values, 12);
  const e26 = emaSeries(values, 26);

  const line = values.map((_, i) =>
    e12[i] === null || e26[i] === null
      ? null
      : e12[i] - e26[i]
  );

  const validStart = line.findIndex(v => v !== null);
  const compact = validStart < 0 ? [] : line.slice(validStart);
  const signalCompact = emaSeries(compact, 9);
  const signal = Array(values.length).fill(null);

  for (let i = 0; i < signalCompact.length; i++) {
    signal[validStart + i] = signalCompact[i];
  }

  const histogram = line.map((v, i) =>
    v === null || signal[i] === null
      ? null
      : v - signal[i]
  );

  return { line, signal, histogram };
}

function atrSeries(candles, period = 14) {
  const tr = trueRanges(candles);
  const out = Array(candles.length).fill(null);

  if (tr.length < period) return out;

  let value = average(tr.slice(0, period));
  out[period - 1] = value;

  for (let i = period; i < tr.length; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    out[i] = value;
  }

  return out;
}

function bollinger(candles, period = 20) {
  if (candles.length < period) return null;

  const closes = candles.slice(-period).map(c => c.close);
  const middle = average(closes);
  const sd = stddev(closes);

  return {
    upper: middle + 2 * sd,
    middle,
    lower: middle - 2 * sd
  };
}

/* =========================================================
   CANDLE PATTERNS AND PRICE-BASED MARKET CONTEXT
========================================================= */

function candlePattern(candles) {
  if (candles.length < 2) {
    return { name: 'INSUFFICIENT CANDLES', direction: 'NEUTRAL' };
  }

  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, Number.EPSILON);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  if (body / range <= 0.1) {
    return { name: 'DOJI', direction: 'NEUTRAL' };
  }

  if (body / range <= 0.35 && lower >= body * 2 && upper <= body * 0.7) {
    return { name: 'HAMMER', direction: 'BULLISH' };
  }

  if (body / range <= 0.35 && upper >= body * 2 && lower <= body * 0.7) {
    return { name: 'SHOOTING STAR', direction: 'BEARISH' };
  }

  const prevBull = p.close > p.open;
  const currBull = c.close > c.open;

  if (!prevBull && currBull && c.open <= p.close && c.close >= p.open) {
    return { name: 'BULLISH ENGULFING', direction: 'BULLISH' };
  }

  if (prevBull && !currBull && c.open >= p.close && c.close <= p.open) {
    return { name: 'BEARISH ENGULFING', direction: 'BEARISH' };
  }

  return { name: 'NO CLEAR PATTERN', direction: 'NEUTRAL' };
}

function pricePsychology(candles) {
  if (candles.length < 10) {
    return {
      psychology: 'INSUFFICIENT PRICE EVIDENCE',
      priceAction: 'INSUFFICIENT HISTORY'
    };
  }

  const last = candles[candles.length - 1];
  const recent = candles.slice(-6);

  const upCloses = recent.slice(1).filter(
    (c, i) => c.close > recent[i].close
  ).length;

  const downCloses = recent.slice(1).filter(
    (c, i) => c.close < recent[i].close
  ).length;

  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, Number.EPSILON);
  const closeLocation = (last.close - last.low) / range;

  let psychology = 'MIXED BUYER/SELLER PRESSURE';

  if (upCloses >= 4 && closeLocation >= 0.65) {
    psychology = 'BUYERS SHOWING RECENT CONTROL';
  } else if (downCloses >= 4 && closeLocation <= 0.35) {
    psychology = 'SELLERS SHOWING RECENT CONTROL';
  } else if (body / range < 0.15) {
    psychology = 'INDECISION / SMALL REAL BODY';
  }

  let priceAction = 'RANGE / MIXED STRUCTURE';
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  if (highs[5] > highs[0] && lows[5] > lows[0] && upCloses >= 3) {
    priceAction = 'SHORT-TERM HIGHER HIGHS / HIGHER LOWS';
  } else if (highs[5] < highs[0] && lows[5] < lows[0] && downCloses >= 3) {
    priceAction = 'SHORT-TERM LOWER HIGHS / LOWER LOWS';
  } else if (last.close > Math.max(...candles.slice(-21, -1).map(c => c.high))) {
    priceAction = 'CLOSED-CANDLE UPSIDE BREAKOUT';
  } else if (last.close < Math.min(...candles.slice(-21, -1).map(c => c.low))) {
    priceAction = 'CLOSED-CANDLE DOWNSIDE BREAKOUT';
  }

  return { psychology, priceAction };
}

function supportResistance(candles) {
  // Use only prior completed candles; exclude the latest candle.
  const prior = candles.slice(-31, -1);

  if (prior.length < 10) {
    return { support: null, resistance: null };
  }

  return {
    support: Math.min(...prior.map(c => c.low)),
    resistance: Math.max(...prior.map(c => c.high))
  };
}

/* =========================================================
   INDICATOR SNAPSHOT AND CROSSOVERS
========================================================= */

function calculateIndicators(candles, fiveMinuteCandles) {
  const closes = candles.map(c => c.close);

  const ema9s = emaSeries(closes, 9);
  const ema21s = emaSeries(closes, 21);
  const rsi9s = rsiSeries(closes, 9);
  const adxs = adxWilder(candles, 14);
  const stoch = stochasticSeries(candles, 14, 3);
  const macd = macdSeries(closes);
  const atrs = atrSeries(candles, 14);

  const fiveCloses = fiveMinuteCandles.map(c => c.close);
  const fiveEma21s = emaSeries(fiveCloses, 21);

  const i = candles.length - 1;
  const prev = i - 1;

  const valid = value =>
    value !== null &&
    value !== undefined &&
    Number.isFinite(value);

  const emaCross =
    valid(ema9s[prev]) &&
    valid(ema21s[prev]) &&
    valid(ema9s[i]) &&
    valid(ema21s[i])
      ? (
          ema9s[prev] <= ema21s[prev] && ema9s[i] > ema21s[i]
            ? 'BULLISH_CROSSOVER'
            : ema9s[prev] >= ema21s[prev] && ema9s[i] < ema21s[i]
              ? 'BEARISH_CROSSOVER'
              : 'NO_CROSSOVER'
        )
      : 'UNAVAILABLE';

  const rsiCross =
    valid(rsi9s[prev]) && valid(rsi9s[i])
      ? (
          rsi9s[prev] <= 30 && rsi9s[i] > 30
            ? 'CROSSED_UP_30'
            : rsi9s[prev] >= 70 && rsi9s[i] < 70
              ? 'CROSSED_DOWN_70'
              : 'NO_CROSSOVER'
        )
      : 'UNAVAILABLE';

  const m = macd.line[i];
  const ms = macd.signal[i];
  const mh = macd.histogram[i];
  const pm = macd.line[prev];
  const pms = macd.signal[prev];

  const macdCross =
    [m, ms, pm, pms].every(valid)
      ? (
          pm <= pms && m > ms
            ? 'BULLISH_CROSSOVER'
            : pm >= pms && m < ms
              ? 'BEARISH_CROSSOVER'
              : 'NO_CROSSOVER'
        )
      : 'UNAVAILABLE';

  const k = stoch.k[i];
  const d = stoch.d[i];
  const pk = stoch.k[prev];
  const pd = stoch.d[prev];

  const stochasticCross =
    [k, d, pk, pd].every(valid)
      ? (
          pk <= pd && k > d
            ? 'BULLISH_CROSSOVER'
            : pk >= pd && k < d
              ? 'BEARISH_CROSSOVER'
              : 'NO_CROSSOVER'
        )
      : 'UNAVAILABLE';

  const fiveEma21 = fiveEma21s[fiveEma21s.length - 1];
  const last5 = fiveMinuteCandles[fiveMinuteCandles.length - 1];

  const trend5m =
    valid(fiveEma21) && last5
      ? (
          last5.close > fiveEma21
            ? 'BULLISH'
            : last5.close < fiveEma21
              ? 'BEARISH'
              : 'NEUTRAL'
        )
      : 'UNAVAILABLE';

  return {
    ema9: ema9s[i],
    ema21: ema21s[i],
    ema9Previous: ema9s[prev],
    ema21Previous: ema21s[prev],
    emaCross,
    rsi9: rsi9s[i],
    rsi9Previous: rsi9s[prev],
    rsiCross,
    adx14: adxs[i],
    macd: { line: m, signal: ms, histogram: mh, crossover: macdCross },
    stochastic: { k, d, crossover: stochasticCross },
    atr14: atrs[i],
    bollinger: bollinger(candles),
    ema21_5m: fiveEma21,
    trend5m
  };
}

/* =========================================================
   TWELVE DATA LIVE REQUESTS AND QUOTA PROTECTION
========================================================= */

async function providerFetch(pair) {
  resetDailyCounterIfNeeded();

  if (!API_KEY) {
    throw new Error('Missing TWELVE_DATA_API_KEY (or TWELVE_DATA_KEY) environment variable.');
  }

  const now = Date.now();
  minuteRequestTimes = minuteRequestTimes.filter(t => now - t < 60_000);

  if (minuteRequestTimes.length >= REQUESTS_PER_MINUTE) {
    throw new Error('Local provider rate guard: 6 requests/minute reached.');
  }

  if (dailyCreditsUsed >= DAILY_USABLE_LIMIT) {
    throw new Error('Daily Twelve Data request safety limit reached.');
  }

  const wait = Math.max(0, REQUEST_DELAY_MS - (now - lastProviderRequestAt));

  if (wait) await sleep(wait);

  const url = new URL(PROVIDER_URL);
  url.searchParams.set('symbol', pair);
  url.searchParams.set('interval', '1min');
  url.searchParams.set('outputsize', '180');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', API_KEY);

  const response = await fetch(url, {
    headers: { Accept: 'application/json' }
  });

  lastProviderRequestAt = Date.now();
  minuteRequestTimes.push(lastProviderRequestAt);
  providerRequests++;
  dailyCreditsUsed++;

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.status === 'error' || json.code || !Array.isArray(json.values)) {
    throw new Error(json.message || 'Twelve Data returned no candle values.');
  }

  const candles = normalizeCandles(json.values);

  if (!candles.length) {
    throw new Error('Provider returned no valid candles.');
  }

  return {
    candles,
    fetchedAt: Date.now(),
    source: 'Twelve Data LIVE'
  };
}

async function getPairData(pair, force = false) {
  const cached = pairCache.get(pair);

  if (!force && cached && Date.now() - cached.fetchedAt < PAIR_CACHE_MS) {
    return cached;
  }

  const data = await providerFetch(pair);
  pairCache.set(pair, data);

  return data;
}

function getAgeSeconds(candles) {
  if (!candles.length) return Infinity;

  return Math.max(
    0,
    (Date.now() - (candles[candles.length - 1].time + 60_000)) / 1000
  );
}

/* =========================================================
   MARKET SCORING AND NO-TRADE GUARDS
========================================================= */

function scoreMarket(candles, _unusedCandles5m, pair, timeframe, fetchedAt) {
  const now = Date.now();
  const closed1m = getClosedCandles(candles, 1, now);
  const closed = aggregateCandles(closed1m, timeframe, now);
  const five = aggregateCandles(closed1m, 5, now);
  const reasons = [];

  const freshnessAge = getAgeSeconds(closed1m);

  const freshness =
    freshnessAge <= FRESHNESS_SECONDS[timeframe]
      ? 'FRESH'
      : freshnessAge <= HARD_STALE_SECONDS
        ? 'STALE'
        : 'HARD STALE';

  const indicators = calculateIndicators(closed, five);
  const last = closed[closed.length - 1];
  const pattern = candlePattern(closed);
  const psychology = pricePsychology(closed);
  const sr = supportResistance(closed);

  const required =
    closed.length >= MIN_1M_CANDLES / timeframe &&
    five.length >= MIN_5M_CANDLES;

  let callScore = 0;
  let putScore = 0;

  const add = (direction, points, reason) => {
    if (direction === 'BULLISH') {
      callScore += points;
      reasons.push(`+CALL ${points}: ${reason}`);
    } else if (direction === 'BEARISH') {
      putScore += points;
      reasons.push(`+PUT ${points}: ${reason}`);
    }
  };

  if (indicators.emaCross === 'BULLISH_CROSSOVER') {
    add('BULLISH', 18, 'EMA9 crossed above EMA21');
  } else if (indicators.emaCross === 'BEARISH_CROSSOVER') {
    add('BEARISH', 18, 'EMA9 crossed below EMA21');
  } else {
    reasons.push('No fresh EMA9/21 crossover on the latest closed candle.');
  }

  if (indicators.rsiCross === 'CROSSED_UP_30') {
    add('BULLISH', 14, 'RSI9 crossed up through 30');
  } else if (indicators.rsiCross === 'CROSSED_DOWN_70') {
    add('BEARISH', 14, 'RSI9 crossed down through 70');
  }

  if (indicators.trend5m === 'BULLISH') {
    add('BULLISH', 12, '5m close above EMA21');
  } else if (indicators.trend5m === 'BEARISH') {
    add('BEARISH', 12, '5m close below EMA21');
  }

  if (indicators.macd.crossover === 'BULLISH_CROSSOVER') {
    add('BULLISH', 12, 'MACD bullish crossover');
  } else if (indicators.macd.crossover === 'BEARISH_CROSSOVER') {
    add('BEARISH', 12, 'MACD bearish crossover');
  }

  if (
    indicators.stochastic.crossover === 'BULLISH_CROSSOVER' &&
    indicators.stochastic.k < 35
  ) {
    add('BULLISH', 8, 'Stochastic K crossed above D in lower zone');
  } else if (
    indicators.stochastic.crossover === 'BEARISH_CROSSOVER' &&
    indicators.stochastic.k > 65
  ) {
    add('BEARISH', 8, 'Stochastic K crossed below D in upper zone');
  }

  if (indicators.adx14 !== null && indicators.adx14 >= 20) {
    if (indicators.ema9 > indicators.ema21) {
      add('BULLISH', 6, 'ADX14 indicates trend strength');
    } else if (indicators.ema9 < indicators.ema21) {
      add('BEARISH', 6, 'ADX14 indicates trend strength');
    }
  }

  if (pattern.direction !== 'NEUTRAL') {
    add(pattern.direction, 8, `Closed candle pattern: ${pattern.name}`);
  }

  if (psychology.psychology.includes('BUYERS')) {
    add('BULLISH', 4, 'recent closed-candle pressure');
  } else if (psychology.psychology.includes('SELLERS')) {
    add('BEARISH', 4, 'recent closed-candle pressure');
  }

  callScore = Math.min(100, callScore);
  putScore = Math.min(100, putScore);

  const gap = Math.abs(callScore - putScore);
  const direction = callScore > putScore
    ? 'CALL'
    : putScore > callScore
      ? 'PUT'
      : 'NONE';

  const winningScore = Math.max(callScore, putScore);
  const opposingEvidence = direction === 'CALL'
    ? putScore
    : direction === 'PUT'
      ? callScore
      : 0;

  let signal = 'NO TRADE';
  const guards = [];

  if (!required) {
    guards.push('Insufficient completed 1m/5m history');
  }

  if (freshness !== 'FRESH' || freshnessAge > HARD_STALE_SECONDS) {
    guards.push('Market data is stale');
  }

  if (
    indicators.trend5m === 'UNAVAILABLE' ||
    indicators.emaCross === 'UNAVAILABLE' ||
    indicators.rsiCross === 'UNAVAILABLE' ||
    indicators.macd.crossover === 'UNAVAILABLE' ||
    indicators.stochastic.crossover === 'UNAVAILABLE'
  ) {
    guards.push('Required indicators unavailable');
  }

  if (direction === 'NONE' || gap < 18) {
    guards.push('Directional evidence conflicts or is too close');
  }

  if (winningScore < 58) {
    guards.push('Evidence score below minimum threshold');
  }

  if (direction === 'CALL' && indicators.trend5m !== 'BULLISH') {
    guards.push('CALL conflicts with 5m EMA21 trend filter');
  }

  if (direction === 'PUT' && indicators.trend5m !== 'BEARISH') {
    guards.push('PUT conflicts with 5m EMA21 trend filter');
  }

  if (direction === 'CALL' && indicators.emaCross !== 'BULLISH_CROSSOVER') {
    guards.push('CALL requires a confirmed EMA9/21 bullish crossover');
  }

  if (direction === 'PUT' && indicators.emaCross !== 'BEARISH_CROSSOVER') {
    guards.push('PUT requires a confirmed EMA9/21 bearish crossover');
  }

  if (opposingEvidence >= 18) {
    guards.push('Opposing technical evidence is material');
  }

  if (guards.length === 0) {
    signal = direction;
  } else {
    reasons.push(...guards.map(g => `NO TRADE: ${g}`));
  }

  const nowSec = Math.floor(now / 1000);
  const nextBoundary =
    (Math.floor(nowSec / (timeframe * 60)) + 1) * timeframe * 60;

  const entrySec = Math.max(
    nextBoundary,
    nowSec + MIN_ENTRY_SECONDS,
    nowSec + ENTRY_BUFFER_SECONDS
  );

  const entryTime = signal === 'NO TRADE'
    ? null
    : new Date(entrySec * 1000).toISOString();

  const expiryTime = signal === 'NO TRADE'
    ? null
    : new Date((entrySec + timeframe * 60) * 1000).toISOString();

  const lastCandle = closed[closed.length - 1];

  return {
    pair,
    signal,
    timeframe,
    confidence: signal === 'NO TRADE'
      ? null
      : Math.min(95, Math.max(0, winningScore)),
    callScore,
    putScore,
    gap,
    entryTime,
    expiryTime,
    entryPrice: last ? last.close : null,
    currentPrice: last ? last.close : null,
    freshness,
    dataAgeSeconds: round(freshnessAge, 1),
    lastCandle: lastCandle ? iso(lastCandle.time) : null,
    volatility: indicators.atr14 && last
      ? (
          indicators.atr14 / last.close > 0.003
            ? 'HIGH'
            : indicators.atr14 / last.close > 0.001
              ? 'MEDIUM'
              : 'LOW'
        )
      : 'UNKNOWN',
    supportResistance: sr,
    marketPsychology: psychology.psychology,
    priceAction: psychology.priceAction,
    candlePattern: pattern,
    indicators: {
      ema9: round(indicators.ema9),
      ema21: round(indicators.ema21),
      emaCross: indicators.emaCross,
      rsi9: round(indicators.rsi9, 2),
      rsi9Previous: round(indicators.rsi9Previous, 2),
      rsiCross: indicators.rsiCross,
      adx14: round(indicators.adx14, 2),
      macd: {
        line: round(indicators.macd.line),
        signal: round(indicators.macd.signal),
        histogram: round(indicators.macd.histogram),
        crossover: indicators.macd.crossover
      },
      stochastic: {
        k: round(indicators.stochastic.k, 2),
        d: round(indicators.stochastic.d, 2),
        crossover: indicators.stochastic.crossover
      },
      atr14: round(indicators.atr14),
      bollinger: indicators.bollinger
        ? {
            upper: round(indicators.bollinger.upper),
            middle: round(indicators.bollinger.middle),
            lower: round(indicators.bollinger.lower)
          }
        : null,
      ema21_5m: round(indicators.ema21_5m),
      trend5m: indicators.trend5m
    },
    reasons,
    source: 'Twelve Data LIVE',
    fetchedAt: iso(fetchedAt),
    evidenceLabel: 'Evidence score, not win probability'
  };
}

/* =========================================================
   PAIR SCANNER
========================================================= */

async function analyzePair(pair) {
  const data = await getPairData(pair);
  const markets = [];

  for (const timeframe of TIMEFRAMES) {
    markets.push(scoreMarket(data.candles, [], pair, timeframe, data.fetchedAt));
  }

  return markets;
}

async function scanBatch() {
  if (scannerRunning || !API_KEY) return;

  scannerRunning = true;
  scannerStartedAt = iso(Date.now());
  lastScanError = null;

  try {
    const batch = [];

    for (let i = 0; i < Math.min(SCAN_BATCH_SIZE, PAIRS.length); i++) {
      batch.push(PAIRS[(scanCursor + i) % PAIRS.length]);
    }

    scanCursor = (scanCursor + batch.length) % PAIRS.length;

    const results = [];

    for (const pair of batch) {
      try {
        results.push(...await analyzePair(pair));
      } catch (err) {
        lastScanError = String(err.message || err);
      }
    }

    totalScanned += batch.length;
    lastScanAt = iso(Date.now());

    const rankedCandidates = results
      .filter(m => m.signal === 'CALL' || m.signal === 'PUT')
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .map((m, i) => ({
        rank: i + 1,
        pair: m.pair,
        timeframe: m.timeframe,
        signal: m.signal,
        confidence: m.confidence,
        entryTime: m.entryTime
      }));

    const selectedMarket = rankedCandidates.length
      ? results.find(
          m => m.pair === rankedCandidates[0].pair &&
               m.timeframe === rankedCandidates[0].timeframe
        )
      : chooseDiagnostic(results);

    cachedResult = {
      ok: true,
      version: VERSION,
      selectedMarket: selectedMarket || emptyMarket(),
      rankedCandidates,
      scanner: {
        running: false,
        startedAt: scannerStartedAt,
        lastScanAt,
        totalScanned,
        batchSize: SCAN_BATCH_SIZE,
        pairs: PAIRS.length
      },
      metadata: metadata(),
      source: 'Twelve Data LIVE',
      diagnostic: { lastScanError }
    };

    cachedResultAt = Date.now();
  } finally {
    scannerRunning = false;
  }
}

function chooseDiagnostic(results) {
  if (!results.length) return emptyMarket();

  return results.sort((a, b) => {
    const aFresh = a.freshness === 'FRESH' ? 1 : 0;
    const bFresh = b.freshness === 'FRESH' ? 1 : 0;

    return bFresh - aFresh ||
      Math.max(b.callScore, b.putScore) -
      Math.max(a.callScore, a.putScore);
  })[0];
}

function emptyMarket() {
  return {
    pair: 'NO MARKET',
    signal: 'NO TRADE',
    timeframe: null,
    confidence: null,
    callScore: null,
    putScore: null,
    gap: null,
    entryTime: null,
    expiryTime: null,
    currentPrice: null,
    entryPrice: null,
    freshness: 'NO DATA',
    dataAgeSeconds: null,
    reasons: ['No usable fresh market data.'],
    indicators: {},
    supportResistance: {},
    marketPsychology: 'NO PRICE EVIDENCE',
    priceAction: 'NO DATA',
    candlePattern: { name: 'UNAVAILABLE', direction: 'NEUTRAL' },
    evidenceLabel: 'Evidence score, not win probability'
  };
}

function metadata() {
  resetDailyCounterIfNeeded();

  return {
    provider: 'Twelve Data LIVE',
    providerRequests,
    dailyCreditsUsed,
    dailyCreditsRemaining: Math.max(0, DAILY_USABLE_LIMIT - dailyCreditsUsed),
    dailyRequestLimit: DAILY_REQUEST_LIMIT,
    dailyUsableLimit: DAILY_USABLE_LIMIT,
    cachedPairs: [...pairCache.keys()].length,
    requestsPerMinuteLimit: REQUESTS_PER_MINUTE,
    version: VERSION
  };
}

function buildResponse() {
  if (cachedResult && Date.now() - cachedResultAt < RESULT_CACHE_MS) {
    return cachedResult;
  }

  return {
    ok: true,
    version: VERSION,
    selectedMarket: cachedResult?.selectedMarket || emptyMarket(),
    rankedCandidates: cachedResult?.rankedCandidates || [],
    scanner: {
      running: scannerRunning,
      startedAt: scannerStartedAt,
      lastScanAt,
      totalScanned,
      batchSize: SCAN_BATCH_SIZE,
      pairs: PAIRS.length
    },
    metadata: metadata(),
    source: 'Twelve Data LIVE',
    diagnostic: { lastScanError }
  };
}

/* =========================================================
   API ROUTES
========================================================= */

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'PO AI Predictor API',
    version: VERSION,
    endpoints: ['/api/best', '/api/health', '/api/analyze']
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    provider: 'Twelve Data LIVE',
    configured: Boolean(API_KEY),
    scannerRunning,
    lastScanAt,
    totalScanned,
    metadata: metadata()
  });
});

app.get('/api/best', async (_req, res) => {
  try {
    if (!cachedResult || Date.now() - cachedResultAt >= RESULT_CACHE_MS) {
      if (!scannerRunning && API_KEY) {
        scanBatch().catch(err => {
          lastScanError = String(err.message || err);
        });
      }
    }

    res.json(buildResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err),
      version: VERSION
    });
  }
});

app.get('/api/analyze', async (req, res) => {
  const pair = String(req.query.pair || '').toUpperCase();
  const timeframe = Number(req.query.timeframe || 1);

  if (!PAIRS.includes(pair)) {
    return res.status(400).json({
      ok: false,
      error: 'Unsupported pair',
      allowedPairs: PAIRS
    });
  }

  if (!TIMEFRAMES.includes(timeframe)) {
    return res.status(400).json({
      ok: false,
      error: 'Unsupported timeframe; use 1, 2, or 3 minutes.'
    });
  }

  try {
    const data = await getPairData(pair, true);
    const market = scoreMarket(data.candles, [], pair, timeframe, data.fetchedAt);

    res.json({
      ok: true,
      version: VERSION,
      selectedMarket: market,
      metadata: metadata(),
      source: 'Twelve Data LIVE'
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      version: VERSION,
      error: String(err.message || err)
    });
  }
});

/* Rotate through pairs in small batches to respect provider limits. */
setInterval(() => {
  if (!scannerRunning) {
    scanBatch().catch(err => {
      lastScanError = String(err.message || err);
    });
  }
}, SCAN_INTERVAL_MS).unref?.();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PO AI Predictor ${VERSION} listening on ${PORT}`);
  });
}

module.exports = app;
