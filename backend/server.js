'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

const VERSION = 'V9.3.0';
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_KEY || '';
const PROVIDER_URL = 'https://api.twelvedata.com/time_series';

const PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD',
  'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'CAD/JPY',
  'CHF/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF', 'GBP/AUD', 'GBP/CAD',
  'GBP/CHF', 'NZD/JPY', 'NZD/CAD', 'AUD/CAD', 'AUD/CHF', 'CAD/CHF'
];
const TIMEFRAMES = [1, 2, 3];

const DAILY_REQUEST_LIMIT = 768;
const DAILY_RESERVE = 32;
const DAILY_USABLE_LIMIT = DAILY_REQUEST_LIMIT - DAILY_RESERVE;
const REQUESTS_PER_MINUTE = 6;
const REQUEST_SPACING_MS = 10000;
const PROVIDER_TIMEOUT_MS = 15000;
const PAIR_CACHE_MS = 60000;
const FRESHNESS_SECONDS = { 1: 90, 2: 150, 3: 210 };
const HARD_STALE_SECONDS = 300;
const SCAN_INTERVAL_MS = 60000;
const SCAN_BATCH_SIZE = 6;

const pairCache = new Map();
const inFlight = new Map();
let providerRequests = 0;
let dailyCreditsUsed = 0;
let dailyDate = new Date().toISOString().slice(0, 10);
let requestTimes = [];
let lastProviderRequestAt = 0;
let requestQueue = Promise.resolve();
let scannerRunning = false;
let scannerStartedAt = null;
let lastScanAt = null;
let totalScanned = 0;
let scanCursor = 0;
let cachedResult = null;
let lastScanError = null;

function finite(value) {
  return value !== null && value !== undefined && value !== '' &&
    Number.isFinite(Number(value));
}

function round(value, digits = 6) {
  if (!finite(value)) return null;
  return Number(Number(value).toFixed(digits));
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function stddev(values) {
  if (!values.length) return null;
  const mean = avg(values);
  return Math.sqrt(avg(values.map(value => (value - mean) ** 2)));
}

function iso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    version: VERSION
  };
}

/* Provider requests share one queue so scanner and manual analysis cannot
   independently exceed the configured rate limit. */
function enqueueProviderRequest(task) {
  const run = requestQueue.then(task, task);
  requestQueue = run.catch(() => {});
  return run;
}

async function providerFetch(pair) {
  return enqueueProviderRequest(async () => {
    resetDailyCounter();

    if (!API_KEY) {
      throw new Error('Missing Twelve Data API key. Configure TWELVE_DATA_API_KEY in Render.');
    }

    while (true) {
      resetDailyCounter();
      const now = Date.now();
      requestTimes = requestTimes.filter(time => now - time < 60000);

      if (dailyCreditsUsed >= DAILY_USABLE_LIMIT) {
        throw new Error('Daily Twelve Data safety limit reached.');
      }

      const rateWait = requestTimes.length >= REQUESTS_PER_MINUTE
        ? Math.max(250, 60000 - (now - requestTimes[0]) + 100)
        : 0;
      const spacingWait = Math.max(0, REQUEST_SPACING_MS - (now - lastProviderRequestAt));
      const wait = Math.max(rateWait, spacingWait);

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let response;

    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
    } catch (error) {
      throw new Error(error.name === 'AbortError'
        ? 'Twelve Data request timed out.'
        : `Twelve Data network error: ${error.message || error}`);
    } finally {
      clearTimeout(timeout);
    }

    const sentAt = Date.now();
    lastProviderRequestAt = sentAt;
    requestTimes.push(sentAt);
    providerRequests++;
    dailyCreditsUsed++;

    if (!response.ok) {
      throw new Error(`Twelve Data returned HTTP ${response.status}.`);
    }

    const json = await response.json();
    if (json.status === 'error' || json.code || !Array.isArray(json.values)) {
      throw new Error(json.message || 'Twelve Data returned no candle values.');
    }

    const candles = normalizeCandles(json.values);
    if (!candles.length) throw new Error('No valid candles were returned by the provider.');

    return { candles, fetchedAt: Date.now(), source: 'Twelve Data LIVE' };
  });
}

function normalizeCandles(rows) {
  const byTime = new Map();

  for (const row of rows) {
    const time = Date.parse(row.datetime || row.time || '');
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);

    if (!Number.isFinite(time) ||
        ![open, high, low, close].every(Number.isFinite) ||
        high < Math.max(open, close, low) ||
        low > Math.min(open, close, high)) continue;

    byTime.set(time, { time, open, high, low, close });
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function getPairData(pair) {
  const cached = pairCache.get(pair);
  if (cached && Date.now() - cached.fetchedAt < PAIR_CACHE_MS) return cached;

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

function closedCandles(candles, minutes, now = Date.now()) {
  const interval = minutes * 60000;
  return candles.filter(candle => candle.time + interval <= now);
}

function aggregateCandles(candles, minutes, now = Date.now()) {
  if (minutes === 1) return closedCandles(candles, 1, now);

  const buckets = new Map();
  const duration = minutes * 60000;

  for (const candle of candles) {
    const start = Math.floor(candle.time / duration) * duration;
    if (start + duration > now) continue;
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(candle);
  }

  const result = [];
  for (const [time, rows] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    rows.sort((a, b) => a.time - b.time);
    if (rows.length !== minutes) continue;

    let contiguous = true;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].time - rows[i - 1].time !== 60000) contiguous = false;
    }
    if (!contiguous) continue;

    result.push({
      time,
      open: rows[0].open,
      high: Math.max(...rows.map(row => row.high)),
      low: Math.min(...rows.map(row => row.low)),
      close: rows[rows.length - 1].close
    });
  }
  return result;
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

function rsi(values, period = 9) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  const calculate = () => averageLoss === 0
    ? (averageGain === 0 ? 50 : 100)
    : 100 - 100 / (1 + averageGain / averageLoss);

  out[period] = calculate();
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = calculate();
  }
  return out;
}

function trueRanges(candles) {
  return candles.map((candle, i) => i === 0
    ? candle.high - candle.low
    : Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - candles[i - 1].close),
        Math.abs(candle.low - candles[i - 1].close)
      ));
}

function wilderSum(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0);
  out[period - 1] = value;

  for (let i = period; i < values.length; i++) {
    value = value - value / period + values[i];
    out[i] = value;
  }
  return out;
}

function adx(candles, period = 14) {
  const n = candles.length;
  const tr = trueRanges(candles);
  const plus = Array(n).fill(0);
  const minus = Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plus[i] = up > down && up > 0 ? up : 0;
    minus[i] = down > up && down > 0 ? down : 0;
  }

  const smTr = wilderSum(tr, period);
  const smPlus = wilderSum(plus, period);
  const smMinus = wilderSum(minus, period);
  const dx = Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (!finite(smTr[i]) || smTr[i] === 0 ||
        !finite(smPlus[i]) || !finite(smMinus[i])) continue;
    const pdi = 100 * smPlus[i] / smTr[i];
    const mdi = 100 * smMinus[i] / smTr[i];
    dx[i] = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  }

  const out = Array(n).fill(null);
  const first = dx.findIndex(value => value !== null);
  if (first < 0 || first + period > n) return out;

  const seed = dx.slice(first, first + period);
  if (seed.some(value => value === null)) return out;
  let value = avg(seed);
  const start = first + period - 1;
  out[start] = value;

  for (let i = start + 1; i < n; i++) {
    if (dx[i] === null) continue;
    value = (value * (period - 1) + dx[i]) / period;
    out[i] = value;
  }
  return out;
}

function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const k = Array(candles.length).fill(null);
  const d = Array(candles.length).fill(null);

  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...slice.map(c => c.high));
    const low = Math.min(...slice.map(c => c.low));
    k[i] = high === low ? 50 : 100 * (candles[i].close - low) / (high - low);

    const values = k.slice(Math.max(0, i - dPeriod + 1), i + 1);
    if (values.length === dPeriod && values.every(finite)) d[i] = avg(values);
  }
  return { k, d };
}

function macd(values) {
  const e12 = ema(values, 12);
  const e26 = ema(values, 26);
  const line = values.map((_, i) => finite(e12[i]) && finite(e26[i]) ? e12[i] - e26[i] : null);
  const start = line.findIndex(finite);
  const signal = Array(values.length).fill(null);

  if (start >= 0) {
    const signalValues = ema(line.slice(start).map(value => value === null ? NaN : value).filter(Number.isFinite), 9);
    const compact = line.slice(start);
    let j = 0;
    for (let i = 0; i < compact.length; i++) {
      if (compact[i] !== null && j < signalValues.length) signal[start + i] = signalValues[j++];
    }
  }

  const histogram = line.map((value, i) =>
    finite(value) && finite(signal[i]) ? value - signal[i] : null
  );
  return { line, signal, histogram };
}

function atr(candles, period = 14) {
  const tr = trueRanges(candles);
  const out = Array(tr.length).fill(null);
  if (tr.length < period) return out;

  let value = avg(tr.slice(0, period));
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
  const middle = avg(closes);
  const deviation = stddev(closes);
  return { upper: middle + 2 * deviation, middle, lower: middle - 2 * deviation };
}

function cross(previousA, previousB, currentA, currentB) {
  if (![previousA, previousB, currentA, currentB].every(finite)) return 'UNAVAILABLE';
  if (previousA <= previousB && currentA > currentB) return 'BULLISH_CROSSOVER';
  if (previousA >= previousB && currentA < currentB) return 'BEARISH_CROSSOVER';
  return 'NO_CROSSOVER';
}

function candlePattern(candles) {
  if (candles.length < 2) return { name: 'INSUFFICIENT CANDLES', direction: 'NEUTRAL' };
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, Number.EPSILON);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  if (body / range <= 0.1) return { name: 'DOJI', direction: 'NEUTRAL' };
  if (body / range <= 0.35 && lower >= body * 2 && upper <= body * 0.7) {
    return { name: 'HAMMER', direction: 'BULLISH' };
  }
  if (body / range <= 0.35 && upper >= body * 2 && lower <= body * 0.7) {
    return { name: 'SHOOTING STAR', direction: 'BEARISH' };
  }
  if (p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open) {
    return { name: 'BULLISH ENGULFING', direction: 'BULLISH' };
  }
  if (p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open) {
    return { name: 'BEARISH ENGULFING', direction: 'BEARISH' };
  }
  return { name: 'NO CLEAR PATTERN', direction: 'NEUTRAL' };
}

function marketContext(candles) {
  if (candles.length < 10) {
    return { psychology: 'INSUFFICIENT PRICE EVIDENCE', priceAction: 'INSUFFICIENT HISTORY' };
  }

  const last = candles[candles.length - 1];
  const recent = candles.slice(-6);
  let up = 0;
  let down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) up++;
    if (recent[i].close < recent[i - 1].close) down++;
  }

  const range = Math.max(last.high - last.low, Number.EPSILON);
  const location = (last.close - last.low) / range;
  let psychology = 'MIXED BUYER/SELLER PRESSURE';

  if (up >= 4 && location >= 0.65) psychology = 'BUYERS SHOWING RECENT CONTROL';
  else if (down >= 4 && location <= 0.35) psychology = 'SELLERS SHOWING RECENT CONTROL';
  else if (Math.abs(last.close - last.open) / range < 0.15) psychology = 'INDECISION / SMALL REAL BODY';

  const prior = candles.slice(-21, -1);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  let priceAction = 'RANGE / MIXED STRUCTURE';

  if (highs[5] > highs[0] && lows[5] > lows[0] && up >= 3) {
    priceAction = 'SHORT-TERM HIGHER HIGHS / HIGHER LOWS';
  } else if (highs[5] < highs[0] && lows[5] < lows[0] && down >= 3) {
    priceAction = 'SHORT-TERM LOWER HIGHS / LOWER LOWS';
  } else if (prior.length && last.close > Math.max(...prior.map(c => c.high))) {
    priceAction = 'CLOSED-CANDLE UPSIDE BREAKOUT';
  } else if (prior.length && last.close < Math.min(...prior.map(c => c.low))) {
    priceAction = 'CLOSED-CANDLE DOWNSIDE BREAKOUT';
  }

  return { psychology, priceAction };
}

function indicatorsFor(candles, five) {
  const closes = candles.map(c => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const rsi9 = rsi(closes, 9);
  const adx14 = adx(candles, 14);
  const macdValues = macd(closes);
  const stoch = stochastic(candles);
  const atr14 = atr(candles);
  const fiveEma = ema(five.map(c => c.close), 21);
  const i = candles.length - 1;
  const p = i - 1;

  const emaCross = cross(e9[p], e21[p], e9[i], e21[i]);
  let rsiCross = 'UNAVAILABLE';
  if (finite(rsi9[p]) && finite(rsi9[i])) {
    rsiCross = rsi9[p] <= 30 && rsi9[i] > 30 ? 'CROSSED_UP_30'
      : rsi9[p] >= 70 && rsi9[i] < 70 ? 'CROSSED_DOWN_70'
      : 'NO_CROSSOVER';
  }

  const macdCross = cross(macdValues.line[p], macdValues.signal[p], macdValues.line[i], macdValues.signal[i]);
  const stochasticCross = cross(stoch.k[p], stoch.d[p], stoch.k[i], stoch.d[i]);
  const ema21_5m = fiveEma[fiveEma.length - 1];
  const last5 = five[five.length - 1];
  const trend5m = finite(ema21_5m) && last5
    ? last5.close > ema21_5m ? 'BULLISH' : last5.close < ema21_5m ? 'BEARISH' : 'NEUTRAL'
    : 'UNAVAILABLE';

  return {
    ema9: e9[i], ema21: e21[i], emaCross,
    rsi9: rsi9[i], rsi9Previous: rsi9[p], rsiCross,
    adx14: adx14[i],
    macd: {
      line: macdValues.line[i], signal: macdValues.signal[i],
      histogram: macdValues.histogram[i], crossover: macdCross
    },
    stochastic: { k: stoch.k[i], d: stoch.d[i], crossover: stochasticCross },
    atr14: atr14[i], bollinger: bollinger(candles), ema21_5m, trend5m
  };
}

function emptyMarket(pair = 'NO MARKET', timeframe = null, reason = 'No usable market data.') {
  return {
    pair, timeframe, signal: 'NO TRADE', confidence: null,
    callScore: 0, putScore: 0, gap: 0,
    entryTime: null, expiryTime: null, currentPrice: null, entryPrice: null,
    freshness: 'NO DATA', dataAgeSeconds: null,
    supportResistance: { support: null, resistance: null },
    marketPsychology: 'NO PRICE EVIDENCE', priceAction: 'NO DATA',
    candlePattern: { name: 'UNAVAILABLE', direction: 'NEUTRAL' },
    indicators: {}, reasons: [reason],
    source: 'Twelve Data LIVE',
    evidenceLabel: 'Evidence score, not win probability'
  };
}

function scoreMarket(rawCandles, pair, timeframe, fetchedAt) {
  const now = Date.now();
  const one = closedCandles(rawCandles, 1, now);
  const candles = aggregateCandles(one, timeframe, now);
  const five = aggregateCandles(one, 5, now);
  const last = candles[candles.length - 1];
  const reasons = [];

  if (!last) return emptyMarket(pair, timeframe, 'No completed candles are available.');

  const age = Math.max(0, (now - (one.length ? one[one.length - 1].time + 60000 : 0)) / 1000);
  const freshness = age <= FRESHNESS_SECONDS[timeframe] ? 'FRESH'
    : age <= HARD_STALE_SECONDS ? 'STALE' : 'HARD STALE';

  const required = candles.length >= Math.ceil(80 / timeframe) && five.length >= 30;
  const ind = indicatorsFor(candles, five);
  const pattern = candlePattern(candles);
  const context = marketContext(candles);
  const prior = candles.slice(-31, -1);
  const support = prior.length >= 10 ? Math.min(...prior.map(c => c.low)) : null;
  const resistance = prior.length >= 10 ? Math.max(...prior.map(c => c.high)) : null;

  let callScore = 0;
  let putScore = 0;
  const add = (direction, points, text) => {
    if (direction === 'BULLISH') callScore += points;
    if (direction === 'BEARISH') putScore += points;
    if (direction === 'BULLISH' || direction === 'BEARISH') reasons.push(text);
  };

  if (ind.emaCross === 'BULLISH_CROSSOVER') add('BULLISH', 18, 'EMA9 crossed above EMA21.');
  else if (ind.emaCross === 'BEARISH_CROSSOVER') add('BEARISH', 18, 'EMA9 crossed below EMA21.');
  else reasons.push('No new EMA9/EMA21 crossover on the latest completed candle.');

  if (ind.rsiCross === 'CROSSED_UP_30') add('BULLISH', 14, 'RSI9 crossed above 30.');
  if (ind.rsiCross === 'CROSSED_DOWN_70') add('BEARISH', 14, 'RSI9 crossed below 70.');
  if (ind.trend5m === 'BULLISH') add('BULLISH', 12, 'Completed 5m close is above EMA21.');
  if (ind.trend5m === 'BEARISH') add('BEARISH', 12, 'Completed 5m close is below EMA21.');
  if (ind.macd.crossover === 'BULLISH_CROSSOVER') add('BULLISH', 12, 'MACD bullish crossover.');
  if (ind.macd.crossover === 'BEARISH_CROSSOVER') add('BEARISH', 12, 'MACD bearish crossover.');

  if (ind.stochastic.crossover === 'BULLISH_CROSSOVER' && ind.stochastic.k < 35) {
    add('BULLISH', 8, 'Stochastic bullish crossover in the lower zone.');
  }
  if (ind.stochastic.crossover === 'BEARISH_CROSSOVER' && ind.stochastic.k > 65) {
    add('BEARISH', 8, 'Stochastic bearish crossover in the upper zone.');
  }
  if (finite(ind.adx14) && ind.adx14 >= 20) {
    if (finite(ind.ema9) && finite(ind.ema21) && ind.ema9 > ind.ema21) {
      add('BULLISH', 6, 'ADX14 shows trend strength with EMA9 above EMA21.');
    } else if (finite(ind.ema9) && finite(ind.ema21) && ind.ema9 < ind.ema21) {
      add('BEARISH', 6, 'ADX14 shows trend strength with EMA9 below EMA21.');
    }
  }
  add(pattern.direction, 8, `Latest completed candle pattern: ${pattern.name}.`);
  if (context.psychology.includes('BUYERS')) add('BULLISH', 4, 'Recent closed candles show buyer pressure.');
  if (context.psychology.includes('SELLERS')) add('BEARISH', 4, 'Recent closed candles show seller pressure.');

  callScore = Math.min(100, callScore);
  putScore = Math.min(100, putScore);
  const gap = Math.abs(callScore - putScore);
  const direction = callScore > putScore ? 'CALL' : putScore > callScore ? 'PUT' : 'NONE';
  const winning = Math.max(callScore, putScore);
  const opposing = direction === 'CALL' ? putScore : direction === 'PUT' ? callScore : 0;
  const guards = [];

  if (!required) guards.push('Insufficient completed 1m/5m candle history.');
  if (freshness !== 'FRESH' || age > HARD_STALE_SECONDS) guards.push('Market data is stale.');
  if ([ind.emaCross, ind.rsiCross, ind.macd.crossover, ind.stochastic.crossover].includes('UNAVAILABLE') ||
      ind.trend5m === 'UNAVAILABLE' || !finite(ind.adx14)) {
    guards.push('One or more required indicators are unavailable.');
  }
  if (direction === 'NONE' || gap < 18) guards.push('Directional evidence conflicts or the score gap is too small.');
  if (winning < 58) guards.push('Evidence score is below the research threshold.');
  if (direction === 'CALL' && ind.trend5m !== 'BULLISH') guards.push('CALL conflicts with the 5m EMA21 trend filter.');
  if (direction === 'PUT' && ind.trend5m !== 'BEARISH') guards.push('PUT conflicts with the 5m EMA21 trend filter.');
  if (direction === 'CALL' && ind.emaCross !== 'BULLISH_CROSSOVER') guards.push('CALL requires a new bullish EMA crossover.');
  if (direction === 'PUT' && ind.emaCross !== 'BEARISH_CROSSOVER') guards.push('PUT requires a new bearish EMA crossover.');
  if (opposing >= 18) guards.push('Opposing evidence is material.');

  const signal = guards.length === 0 ? direction : 'NO TRADE';
  reasons.push(...guards.map(reason => `NO TRADE: ${reason}`));

  const ageNow = Math.floor(now / 1000);
  const boundary = (Math.floor(ageNow / (timeframe * 60)) + 1) * timeframe * 60;
  const entry = Math.max(boundary, ageNow + 30);
  const entryTime = signal === 'NO TRADE' ? null : new Date(entry * 1000).toISOString();
  const expiryTime = signal === 'NO TRADE' ? null : new Date((entry + timeframe * 60) * 1000).toISOString();

  return {
    pair, timeframe, signal,
    confidence: signal === 'NO TRADE' ? null : winning,
    callScore, putScore, gap,
    entryTime, expiryTime,
    currentPrice: last.close, entryPrice: last.close,
    freshness, dataAgeSeconds: round(age, 1),
    lastCandle: iso(last.time),
    volatility: finite(ind.atr14) && last.close
      ? ind.atr14 / last.close > 0.003 ? 'HIGH'
        : ind.atr14 / last.close > 0.001 ? 'MEDIUM' : 'LOW'
      : 'UNKNOWN',
    supportResistance: { support: round(support), resistance: round(resistance) },
    marketPsychology: context.psychology,
    priceAction: context.priceAction,
    candlePattern: pattern,
    indicators: {
      ema9: round(ind.ema9), ema21: round(ind.ema21), emaCross: ind.emaCross,
      rsi9: round(ind.rsi9, 2), rsi9Previous: round(ind.rsi9Previous, 2), rsiCross: ind.rsiCross,
      adx14: round(ind.adx14, 2),
      macd: {
        line: round(ind.macd.line), signal: round(ind.macd.signal),
        histogram: round(ind.macd.histogram), crossover: ind.macd.crossover
      },
      stochastic: {
        k: round(ind.stochastic.k, 2), d: round(ind.stochastic.d, 2),
        crossover: ind.stochastic.crossover
      },
      atr14: round(ind.atr14),
      bollinger: ind.bollinger ? {
        upper: round(ind.bollinger.upper), middle: round(ind.bollinger.middle),
        lower: round(ind.bollinger.lower)
      } : null,
      ema21_5m: round(ind.ema21_5m), trend5m: ind.trend5m
    },
    reasons, source: 'Twelve Data LIVE', fetchedAt: iso(fetchedAt),
    evidenceLabel: 'Evidence score, not win probability'
  };
}

function makeResponse(selectedMarket, rankedCandidates = [], scanner = {}) {
  return {
    ok: true, version: VERSION, selectedMarket,
    rankedCandidates,
    scanner: {
      running: scannerRunning, startedAt: scannerStartedAt, lastScanAt,
      totalScanned, batchSize: SCAN_BATCH_SIZE, pairs: PAIRS.length,
      ...scanner
    },
    metadata: metadata(),
    source: 'Twelve Data LIVE',
    diagnostic: { lastScanError }
  };
}

function emptyResponse(pair, timeframe, reason) {
  return makeResponse(emptyMarket(pair, timeframe, reason));
}

function diagnosticMarket(results) {
  if (!results.length) return emptyMarket();
  return results.slice().sort((a, b) =>
    (a.freshness === 'FRESH' ? 1 : 0) - (b.freshness === 'FRESH' ? 1 : 0) ||
    Math.max(b.callScore || 0, b.putScore || 0) - Math.max(a.callScore || 0, a.putScore || 0)
  )[0];
}

async function scanBatch() {
  if (scannerRunning || !API_KEY) return;
  scannerRunning = true;
  scannerStartedAt = iso(Date.now());
  lastScanError = null;

  try {
    const batch = [];
    for (let i = 0; i < SCAN_BATCH_SIZE; i++) {
      batch.push(PAIRS[(scanCursor + i) % PAIRS.length]);
    }
    scanCursor = (scanCursor + batch.length) % PAIRS.length;

    const markets = [];
    for (const pair of batch) {
      try {
        const data = await getPairData(pair);
        for (const timeframe of TIMEFRAMES) {
          markets.push(scoreMarket(data.candles, pair, timeframe, data.fetchedAt));
        }
      } catch (error) {
        lastScanError = String(error.message || error);
      }
    }

    totalScanned += batch.length;
    lastScanAt = iso(Date.now());
    const rankedCandidates = markets
      .filter(market => market.signal === 'CALL' || market.signal === 'PUT')
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .map((market, index) => ({
        rank: index + 1, pair: market.pair, timeframe: market.timeframe,
        signal: market.signal, confidence: market.confidence,
        callScore: market.callScore, putScore: market.putScore,
        entryTime: market.entryTime, reason: market.reasons[0] || 'Evidence review.'
      }));

    const best = rankedCandidates.length
      ? markets.find(market =>
          market.pair === rankedCandidates[0].pair &&
          market.timeframe === rankedCandidates[0].timeframe)
      : diagnosticMarket(markets);

    cachedResult = makeResponse(best || emptyMarket(), rankedCandidates);
  } finally {
    scannerRunning = false;
  }
}

app.get('/', (_req, res) => {
  res.json({
    ok: true, name: 'PO AI Predictor API', version: VERSION,
    endpoints: ['/api/best', '/api/health', '/api/analyze']
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true, version: VERSION, provider: 'Twelve Data LIVE',
    configured: Boolean(API_KEY), scannerRunning, lastScanAt, totalScanned,
    metadata: metadata()
  });
});

app.get('/api/best', (_req, res) => {
  if (!scannerRunning && API_KEY && (!cachedResult || !lastScanAt ||
      Date.now() - Date.parse(lastScanAt) > SCAN_INTERVAL_MS)) {
    scanBatch().catch(error => { lastScanError = String(error.message || error); });
  }
  res.json(cachedResult || emptyResponse('NO MARKET', null, API_KEY
    ? 'Scanner is starting; no completed scan is available yet.'
    : 'The Twelve Data API key is not configured.'));
});

app.get('/api/analyze', async (req, res) => {
  const pair = String(req.query.pair || '').trim().toUpperCase();
  const timeframe = Number(req.query.timeframe || 1);

  if (!PAIRS.includes(pair)) {
    return res.status(400).json({ ok: false, error: 'Unsupported pair.', allowedPairs: PAIRS });
  }
  if (!TIMEFRAMES.includes(timeframe)) {
    return res.status(400).json({ ok: false, error: 'Unsupported timeframe; use 1, 2, or 3.' });
  }

  try {
    const data = await getPairData(pair);
    const market = scoreMarket(data.candles, pair, timeframe, data.fetchedAt);
    return res.json(makeResponse(market, cachedResult?.rankedCandidates || []));
  } catch (error) {
    return res.status(503).json({
      ok: false, version: VERSION,
      error: String(error.message || error),
      selectedMarket: emptyMarket(pair, timeframe, 'Analysis failed; do not infer a trade.')
    });
  }
});

const scannerTimer = setInterval(() => {
  if (!scannerRunning && API_KEY) {
    scanBatch().catch(error => { lastScanError = String(error.message || error); });
  }
}, SCAN_INTERVAL_MS);
scannerTimer.unref?.();

if (require.main === module) {
  app.listen(PORT, () => console.log(`PO AI Predictor ${VERSION} listening on ${PORT}`));
}

module.exports = app;
