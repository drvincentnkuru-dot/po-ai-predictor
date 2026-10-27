'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

const VERSION = 'V9.3.1';
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

const PAIR_CACHE_MS = 120 * 1000;
const FRESHNESS_SECONDS = { 1: 150, 2: 210, 3: 270 };
const HARD_STALE_SECONDS = 360;

// Mode A: automatic scanning of all 24 pairs is disabled.
const SCAN_INTERVAL_MS = 150000;
const SCAN_BATCH_SIZE = 0;

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
let totalScanned = 0;
let scanCursor = 0;
let cachedResult = null;
let lastScanError = null;

const finite = v =>
  v !== null &&
  v !== undefined &&
  v !== '' &&
  Number.isFinite(Number(v));

const avg = a =>
  a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

const round = (v, d = 6) =>
  finite(v) ? Number(Number(v).toFixed(d)) : null;

const iso = v =>
  Number.isFinite(v) ? new Date(v).toISOString() : null;

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

    // Count the attempt before I/O because failed requests and timeouts
    // may still consume a provider request.
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

    const hasTimezone =
      /(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawTime);

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

    byTime.set(time, {
      time,
      open,
      high,
      low,
      close
    });
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function getPairData(pair) {
  const cached = pairCache.get(pair);

  if (cached && Date.now() - cached.fetchedAt < PAIR_CACHE_MS) {
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

function closedCandles(candles, minutes, now = Date.now()) {
  const duration = minutes * 60000;

  return candles.filter(
    c => c.time + duration <= now
  );
}

function aggregateCandles(candles, minutes, now = Date.now()) {
  const duration = minutes * 60000;
  const buckets = new Map();

  for (const c of candles) {
    const start = Math.floor(c.time / duration) * duration;

    if (start + duration > now) continue;

    if (!buckets.has(start)) {
      buckets.set(start, []);
    }

    buckets.get(start).push(c);
  }

  const out = [];

  for (
    const [time, rows] of
    [...buckets.entries()].sort((a, b) => a[0] - b[0])
  ) {
    rows.sort((a, b) => a.time - b.time);

    if (rows.length !== minutes) continue;

    if (
      rows.some(
        (c, i) =>
          i > 0 &&
          c.time - rows[i - 1].time !== 60000
      )
    ) {
      continue;
    }

    out.push({
      time,
      open: rows[0].open,
      high: Math.max(...rows.map(c => c.high)),
      low: Math.min(...rows.map(c => c.low)),
      close: rows[rows.length - 1].close
    });
  }

  return out;
}

function ema(values, period) {
  const out = Array(values.length).fill(null);

  if (values.length < period) return out;

  let value = avg(values.slice(0, period));

  out[period - 1] = value;

  const alpha = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value =
      values[i] * alpha +
      value * (1 - alpha);

    out[i] = value;
  }

  return out;
}

function rsi(values, period = 9) {
  const out = Array(values.length).fill(null);

  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];

    gain += Math.max(ch, 0);
    loss += Math.max(-ch, 0);
  }

  let ag = gain / period;
  let al = loss / period;

  const calc = () =>
    al === 0
      ? (ag === 0 ? 50 : 100)
      : 100 - 100 / (1 + ag / al);

  out[period] = calc();

  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];

    ag =
      (ag * (period - 1) + Math.max(ch, 0)) /
      period;

    al =
      (al * (period - 1) + Math.max(-ch, 0)) /
      period;

    out[i] = calc();
  }

  return out;
}

function trueRanges(c) {
  return c.map((x, i) =>
    i === 0
      ? x.high - x.low
      : Math.max(
          x.high - x.low,
          Math.abs(x.high - c[i - 1].close),
          Math.abs(x.low - c[i - 1].close)
        )
  );
}

function adx(candles, period = 14) {
  const n = candles.length;
  const tr = trueRanges(candles);
  const plus = Array(n).fill(0);
  const minus = Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;

    plus[i] =
      up > down && up > 0 ? up : 0;

    minus[i] =
      down > up && down > 0 ? down : 0;
  }

  function smooth(a) {
    const o = Array(n).fill(null);

    if (n < period) return o;

    let v = a
      .slice(0, period)
      .reduce((s, x) => s + x, 0);

    o[period - 1] = v;

    for (let i = period; i < n; i++) {
      v = v - v / period + a[i];
      o[i] = v;
    }

    return o;
  }

  const st = smooth(tr);
  const sp = smooth(plus);
  const sm = smooth(minus);
  const dx = Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (
      !finite(st[i]) ||
      st[i] === 0 ||
      !finite(sp[i]) ||
      !finite(sm[i])
    ) {
      continue;
    }

    const p = 100 * sp[i] / st[i];
    const m = 100 * sm[i] / st[i];

    dx[i] =
      p + m === 0
        ? 0
        : 100 * Math.abs(p - m) / (p + m);
  }

  const first = dx.findIndex(finite);
  const out = Array(n).fill(null);

  if (first < 0 || first + period > n) {
    return out;
  }

  const seed = dx.slice(first, first + period);

  if (seed.some(v => !finite(v))) {
    return out;
  }

  let v = avg(seed);
  const start = first + period - 1;

  out[start] = v;

  for (let i = start + 1; i < n; i++) {
    if (finite(dx[i])) {
      v = (v * (period - 1) + dx[i]) / period;
      out[i] = v;
    }
  }

  return out;
}

function stochastic(c, kp = 14, dp = 3) {
  const k = Array(c.length).fill(null);
  const d = Array(c.length).fill(null);

  for (let i = kp - 1; i < c.length; i++) {
    const s = c.slice(i - kp + 1, i + 1);
    const hi = Math.max(...s.map(x => x.high));
    const lo = Math.min(...s.map(x => x.low));

    k[i] =
      hi === lo
        ? 50
        : 100 * (c[i].close - lo) / (hi - lo);

    const vals = k.slice(i - dp + 1, i + 1);

    if (
      vals.length === dp &&
      vals.every(finite)
    ) {
      d[i] = avg(vals);
    }
  }

  return { k, d };
}

function macd(values) {
  const a = ema(values, 12);
  const b = ema(values, 26);

  const line = values.map((_, i) =>
    finite(a[i]) && finite(b[i])
      ? a[i] - b[i]
      : null
  );

  const valid = line.filter(finite);
  const compactSignal = ema(valid, 9);
  const signal = Array(values.length).fill(null);

  let j = 0;

  for (let i = 0; i < line.length; i++) {
    if (finite(line[i])) {
      signal[i] = compactSignal[j++];
    }
  }

  const histogram = line.map((v, i) =>
    finite(v) && finite(signal[i])
      ? v - signal[i]
      : null
  );

  return { line, signal, histogram };
}

function cross(pa, pb, ca, cb) {
  if (![pa, pb, ca, cb].every(finite)) {
    return 'UNAVAILABLE';
  }

  if (pa <= pb && ca > cb) {
    return 'BULLISH_CROSSOVER';
  }

  if (pa >= pb && ca < cb) {
    return 'BEARISH_CROSSOVER';
  }

  return 'NO_CROSSOVER';
}

function candlePattern(c) {
  if (c.length < 2) {
    return {
      name: 'INSUFFICIENT CANDLES',
      direction: 'NEUTRAL'
    };
  }

  const x = c[c.length - 1];
  const p = c[c.length - 2];

  const body = Math.abs(x.close - x.open);
  const range = Math.max(
    x.high - x.low,
    Number.EPSILON
  );

  const upper =
    x.high - Math.max(x.open, x.close);

  const lower =
    Math.min(x.open, x.close) - x.low;

  if (body / range <= 0.1) {
    return { name: 'DOJI', direction: 'NEUTRAL' };
  }

  if (
    body / range <= 0.35 &&
    lower >= body * 2 &&
    upper <= body * 0.7
  ) {
    return { name: 'HAMMER', direction: 'BULLISH' };
  }

  if (
    body / range <= 0.35 &&
    upper >= body * 2 &&
    lower <= body * 0.7
  ) {
    return {
      name: 'SHOOTING STAR',
      direction: 'BEARISH'
    };
  }

  if (
    p.close < p.open &&
    x.close > x.open &&
    x.open <= p.close &&
    x.close >= p.open
  ) {
    return {
      name: 'BULLISH ENGULFING',
      direction: 'BULLISH'
    };
  }

  if (
    p.close > p.open &&
    x.close < x.open &&
    x.open >= p.close &&
    x.close <= p.open
  ) {
    return {
      name: 'BEARISH ENGULFING',
      direction: 'BEARISH'
    };
  }

  return {
    name: 'NO CLEAR PATTERN',
    direction: 'NEUTRAL'
  };
}

function marketContext(c) {
  if (c.length < 10) {
    return {
      psychology: 'INSUFFICIENT PRICE EVIDENCE',
      priceAction: 'INSUFFICIENT HISTORY'
    };
  }

  const last = c[c.length - 1];
  const recent = c.slice(-6);

  let up = 0;
  let down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) up++;
    if (recent[i].close < recent[i - 1].close) down++;
  }

  const range = Math.max(
    last.high - last.low,
    Number.EPSILON
  );

  const loc = (last.close - last.low) / range;

  let psychology = 'MIXED BUYER/SELLER PRESSURE';

  if (up >= 4 && loc >= 0.65) {
    psychology = 'BUYERS SHOWING RECENT CONTROL';
  } else if (down >= 4 && loc <= 0.35) {
    psychology = 'SELLERS SHOWING RECENT CONTROL';
  } else if (
    Math.abs(last.close - last.open) / range < 0.15
  ) {
    psychology = 'INDECISION / SMALL REAL BODY';
  }

  const prior = c.slice(-21, -1);
  let priceAction = 'RANGE / MIXED STRUCTURE';

  if (
    recent[5].high > recent[0].high &&
    recent[5].low > recent[0].low &&
    up >= 3
  ) {
    priceAction = 'SHORT-TERM HIGHER HIGHS / HIGHER LOWS';
  } else if (
    recent[5].high < recent[0].high &&
    recent[5].low < recent[0].low &&
    down >= 3
  ) {
    priceAction = 'SHORT-TERM LOWER HIGHS / LOWER LOWS';
  } else if (
    prior.length &&
    last.close > Math.max(...prior.map(x => x.high))
  ) {
    priceAction = 'CLOSED-CANDLE UPSIDE BREAKOUT';
  } else if (
    prior.length &&
    last.close < Math.min(...prior.map(x => x.low))
  ) {
    priceAction = 'CLOSED-CANDLE DOWNSIDE BREAKOUT';
  }

  return { psychology, priceAction };
}

function emptyMarket(
  pair = 'NO MARKET',
  timeframe = null,
  reason = 'No usable market data.'
) {
  return {
    pair,
    timeframe,
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
    supportResistance: {
      support: null,
      resistance: null
    },
    marketPsychology: 'NO PRICE EVIDENCE',
    priceAction: 'NO DATA',
    candlePattern: {
      name: 'UNAVAILABLE',
      direction: 'NEUTRAL'
    },
    indicators: {},
    reasons: [reason],
    source: 'Twelve Data LIVE',
    evidenceLabel: 'Evidence score, not win probability'
  };
}

function scoreMarket(raw, pair, timeframe, fetchedAt) {
  const now = Date.now();

  const one = closedCandles(raw, 1, now);
  const candles = aggregateCandles(one, timeframe, now);
  const five = aggregateCandles(one, 5, now);

  const last = candles[candles.length - 1];

  if (!last) {
    return emptyMarket(
      pair,
      timeframe,
      'No completed candles are available.'
    );
  }

  // Measure freshness against the latest completed candle for the
  // requested analysis timeframe, not the latest 1-minute source candle.
  const age = Math.max(
    0,
    (now - (last.time + timeframe * 60000)) / 1000
  );

  const freshness =
    age <= FRESHNESS_SECONDS[timeframe]
      ? 'FRESH'
      : age <= HARD_STALE_SECONDS
        ? 'STALE'
        : 'HARD STALE';

  const closes = candles.map(c => c.close);

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const rs = rsi(closes, 9);
  const dx = adx(candles, 14);
  const mc = macd(closes);
  const st = stochastic(candles);

  // Wilder ATR(14).
  const trs = trueRanges(candles);
  let atr = null;

  if (trs.length >= 14) {
    atr = avg(trs.slice(0, 14));

    for (let j = 14; j < trs.length; j++) {
      atr = ((atr * 13) + trs[j]) / 14;
    }
  }

  const fiveCloses = five.map(c => c.close);
  const e5 = ema(fiveCloses, 21);

  const i = candles.length - 1;
  const p = i - 1;

  const emaCross = cross(
    e9[p],
    e21[p],
    e9[i],
    e21[i]
  );

  const rsiCross =
    finite(rs[p]) && finite(rs[i])
      ? rs[p] <= 30 && rs[i] > 30
        ? 'CROSSED_UP_30'
        : rs[p] >= 70 && rs[i] < 70
          ? 'CROSSED_DOWN_70'
          : 'NO_CROSSOVER'
      : 'UNAVAILABLE';

  const macdCross = cross(
    mc.line[p],
    mc.signal[p],
    mc.line[i],
    mc.signal[i]
  );

  const stochCross = cross(
    st.k[p],
    st.d[p],
    st.k[i],
    st.d[i]
  );

  const ema21_5m = e5[e5.length - 1];
  const last5 = five[five.length - 1];

  const trend5m =
    finite(ema21_5m) && last5
      ? last5.close > ema21_5m
        ? 'BULLISH'
        : last5.close < ema21_5m
          ? 'BEARISH'
          : 'NEUTRAL'
      : 'UNAVAILABLE';

  const ind = {
    ema9: e9[i],
    ema21: e21[i],
    emaCross,
    rsi9: rs[i],
    rsi9Previous: rs[p],
    rsiCross,
    adx14: dx[i],
    macd: {
      line: mc.line[i],
      signal: mc.signal[i],
      histogram: mc.histogram[i],
      crossover: macdCross
    },
    stochastic: {
      k: st.k[i],
      d: st.d[i],
      crossover: stochCross
    },
    atr14: atr,
    bollinger: null,
    ema21_5m,
    trend5m
  };

  if (candles.length >= 20) {
    const vals = closes.slice(-20);
    const mid = avg(vals);

    const sd = Math.sqrt(
      avg(vals.map(v => (v - mid) ** 2))
    );

    ind.bollinger = {
      upper: mid + 2 * sd,
      middle: mid,
      lower: mid - 2 * sd
    };
  }

  const pattern = candlePattern(candles);
  const context = marketContext(candles);
  const prior = candles.slice(-31, -1);

  const support =
    prior.length >= 10
      ? Math.min(...prior.map(c => c.low))
      : null;

  const resistance =
    prior.length >= 10
      ? Math.max(...prior.map(c => c.high))
      : null;

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  const add = (dir, points, reason) => {
    if (dir === 'BULLISH') callScore += points;
    if (dir === 'BEARISH') putScore += points;

    if (dir !== 'NEUTRAL') {
      reasons.push(reason);
    }
  };

  if (emaCross === 'BULLISH_CROSSOVER') {
    add('BULLISH', 18, 'EMA9 crossed above EMA21.');
  } else if (emaCross === 'BEARISH_CROSSOVER') {
    add('BEARISH', 18, 'EMA9 crossed below EMA21.');
  } else {
    reasons.push(
      'No new EMA9/EMA21 crossover on the latest completed candle.'
    );
  }

  if (rsiCross === 'CROSSED_UP_30') {
    add('BULLISH', 14, 'RSI9 crossed above 30.');
  }

  if (rsiCross === 'CROSSED_DOWN_70') {
    add('BEARISH', 14, 'RSI9 crossed below 70.');
  }

  if (trend5m === 'BULLISH') {
    add('BULLISH', 12, 'Completed 5m close is above EMA21.');
  }

  if (trend5m === 'BEARISH') {
    add('BEARISH', 12, 'Completed 5m close is below EMA21.');
  }

  if (macdCross === 'BULLISH_CROSSOVER') {
    add('BULLISH', 12, 'MACD bullish crossover.');
  }

  if (macdCross === 'BEARISH_CROSSOVER') {
    add('BEARISH', 12, 'MACD bearish crossover.');
  }

  if (
    stochCross === 'BULLISH_CROSSOVER' &&
    st.k[i] < 35
  ) {
    add(
      'BULLISH',
      8,
      'Stochastic bullish crossover in lower zone.'
    );
  }

  if (
    stochCross === 'BEARISH_CROSSOVER' &&
    st.k[i] > 65
  ) {
    add(
      'BEARISH',
      8,
      'Stochastic bearish crossover in upper zone.'
    );
  }

  if (
    finite(dx[i]) &&
    dx[i] >= 20 &&
    finite(e9[i]) &&
    finite(e21[i])
  ) {
    if (e9[i] > e21[i]) {
      add(
        'BULLISH',
        6,
        'ADX14 shows trend strength with EMA9 above EMA21.'
      );
    }

    if (e9[i] < e21[i]) {
      add(
        'BEARISH',
        6,
        'ADX14 shows trend strength with EMA9 below EMA21.'
      );
    }
  }

  add(
    pattern.direction,
    8,
    `Latest completed candle pattern: ${pattern.name}.`
  );

  if (context.psychology.includes('BUYERS')) {
    add(
      'BULLISH',
      4,
      'Recent closed candles show buyer pressure.'
    );
  }

  if (context.psychology.includes('SELLERS')) {
    add(
      'BEARISH',
      4,
      'Recent closed candles show seller pressure.'
    );
  }

  callScore = Math.min(100, callScore);
  putScore = Math.min(100, putScore);

  const gap = Math.abs(callScore - putScore);

  const direction =
    callScore > putScore
      ? 'CALL'
      : putScore > callScore
        ? 'PUT'
        : 'NONE';

  const winning = Math.max(callScore, putScore);

  const opposing =
    direction === 'CALL'
      ? putScore
      : direction === 'PUT'
        ? callScore
        : 0;

  const guards = [];

  if (
    candles.length < Math.ceil(80 / timeframe) ||
    five.length < 30
  ) {
    guards.push(
      'Insufficient completed 1m/5m candle history.'
    );
  }

  if (
    freshness !== 'FRESH' ||
    age > HARD_STALE_SECONDS
  ) {
    guards.push('Market data is stale.');
  }

  if (
    [
      emaCross,
      rsiCross,
      macdCross,
      stochCross
    ].includes('UNAVAILABLE') ||
    trend5m === 'UNAVAILABLE' ||
    !finite(dx[i])
  ) {
    guards.push(
      'One or more required indicators are unavailable.'
    );
  }

  if (direction === 'NONE' || gap < 18) {
    guards.push(
      'Directional evidence conflicts or the score gap is too small.'
    );
  }

  if (winning < 58) {
    guards.push(
      'Evidence score is below the research threshold.'
    );
  }

  if (
    direction === 'CALL' &&
    trend5m !== 'BULLISH'
  ) {
    guards.push(
      'CALL conflicts with the 5m EMA21 trend filter.'
    );
  }

  if (
    direction === 'PUT' &&
    trend5m !== 'BEARISH'
  ) {
    guards.push(
      'PUT conflicts with the 5m EMA21 trend filter.'
    );
  }

  if (
    direction === 'CALL' &&
    emaCross !== 'BULLISH_CROSSOVER'
  ) {
    guards.push(
      'CALL requires a new bullish EMA crossover.'
    );
  }

  if (
    direction === 'PUT' &&
    emaCross !== 'BEARISH_CROSSOVER'
  ) {
    guards.push(
      'PUT requires a new bearish EMA crossover.'
    );
  }

  if (opposing >= 18) {
    guards.push('Opposing evidence is material.');
  }

  const signal = guards.length
    ? 'NO TRADE'
    : direction;

  reasons.push(
    ...guards.map(x => `NO TRADE: ${x}`)
  );

  const nowSec = Math.floor(now / 1000);

  const boundary =
    (Math.floor(nowSec / (timeframe * 60)) + 1) *
    timeframe *
    60;

  const entry = Math.max(
    boundary,
    nowSec + 30
  );

  return {
    pair,
    timeframe,
    signal,
    confidence: signal === 'NO TRADE' ? null : winning,
    callScore,
    putScore,
    gap,

    entryTime:
      signal === 'NO TRADE'
        ? null
        : new Date(entry * 1000).toISOString(),

    expiryTime:
      signal === 'NO TRADE'
        ? null
        : new Date(
            (entry + timeframe * 60) * 1000
          ).toISOString(),

    currentPrice: last.close,
    entryPrice: last.close,
    freshness,
    dataAgeSeconds: round(age, 1),
    lastCandle: iso(last.time),

    volatility:
      finite(atr) && last.close
        ? atr / last.close > 0.003
          ? 'HIGH'
          : atr / last.close > 0.001
            ? 'MEDIUM'
            : 'LOW'
        : 'UNKNOWN',

    supportResistance: {
      support: round(support),
      resistance: round(resistance)
    },

    marketPsychology: context.psychology,
    priceAction: context.priceAction,
    candlePattern: pattern,

    indicators: {
      ema9: round(ind.ema9),
      ema21: round(ind.ema21),
      emaCross: ind.emaCross,

      rsi9: round(ind.rsi9, 2),
      rsi9Previous: round(ind.rsi9Previous, 2),
      rsiCross: ind.rsiCross,

      adx14: round(ind.adx14, 2),

      macd: {
        line: round(ind.macd.line),
        signal: round(ind.macd.signal),
        histogram: round(ind.macd.histogram),
        crossover: ind.macd.crossover
      },

      stochastic: {
        k: round(ind.stochastic.k, 2),
        d: round(ind.stochastic.d, 2),
        crossover: ind.stochastic.crossover
      },

      atr14: round(ind.atr14),

      bollinger: ind.bollinger
        ? {
            upper: round(ind.bollinger.upper),
            middle: round(ind.bollinger.middle),
            lower: round(ind.bollinger.lower)
          }
        : null,

      ema21_5m: round(ind.ema21_5m),
      trend5m: ind.trend5m
    },

    reasons,
    source: 'Twelve Data LIVE',
    fetchedAt: iso(fetchedAt),
    evidenceLabel: 'Evidence score, not win probability'
  };
}

function makeResponse(
  selectedMarket,
  rankedCandidates = [],
  scanner = {}
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
      batchSize: SCAN_BATCH_SIZE,
      pairs: PAIRS.length,
      ...scanner
    },

    metadata: metadata(),
    source: 'Twelve Data LIVE',
    diagnostic: { lastScanError }
  };
}

function emptyResponse(pair, timeframe, reason) {
  return makeResponse(
    emptyMarket(pair, timeframe, reason)
  );
}

function diagnosticMarket(results) {
  if (!results.length) {
    return emptyMarket();
  }

  // Prefer fresh data, then the strongest evidence score.
  return results.slice().sort((a, b) =>
    (b.freshness === 'FRESH' ? 1 : 0) -
      (a.freshness === 'FRESH' ? 1 : 0) ||
    Math.max(b.callScore || 0, b.putScore || 0) -
      Math.max(a.callScore || 0, a.putScore || 0)
  )[0];
}

function refreshCandidates() {
  const markets = [];

  for (const [pair, data] of pairCache.entries()) {
    for (const tf of TIMEFRAMES) {
      const market = scoreMarket(
        data.candles,
        pair,
        tf,
        data.fetchedAt
      );

      latestMarkets.set(`${pair}|${tf}`, market);
      markets.push(market);
    }
  }

  const rankedCandidates = markets
    .filter(
      m =>
        m.freshness === 'FRESH' &&
        (m.signal === 'CALL' || m.signal === 'PUT')
    )
    .sort(
      (a, b) =>
        (b.confidence || 0) - (a.confidence || 0)
    )
    .map((m, i) => ({
      rank: i + 1,
      pair: m.pair,
      timeframe: m.timeframe,
      signal: m.signal,
      confidence: m.confidence,
      callScore: m.callScore,
      putScore: m.putScore,
      entryTime: m.entryTime,
      reason: m.reasons[0] || 'Evidence review.'
    }));

  const bestCandidate =
    rankedCandidates[0] &&
    latestMarkets.get(
      `${rankedCandidates[0].pair}|${rankedCandidates[0].timeframe}`
    );

  const diagnostic = diagnosticMarket(markets);

  cachedResult = makeResponse(
    bestCandidate || diagnostic,
    rankedCandidates
  );
}

async function scanBatch() {
  // Kept only for compatibility; Mode A disables background scanning.
  if (scannerRunning || !API_KEY || SCAN_BATCH_SIZE === 0) {
    return;
  }

  scannerRunning = true;
  scannerStartedAt = iso(Date.now());
  lastScanError = null;

  try {
    const batch = [];

    for (let i = 0; i < SCAN_BATCH_SIZE; i++) {
      batch.push(
        PAIRS[(scanCursor + i) % PAIRS.length]
      );
    }

    scanCursor =
      (scanCursor + batch.length) % PAIRS.length;

    for (const pair of batch) {
      try {
        await getPairData(pair);
      } catch (error) {
        lastScanError = String(error.message || error);
      }
    }

    totalScanned += batch.length;
    lastScanAt = iso(Date.now());

    refreshCandidates();
  } finally {
    scannerRunning = false;

    if (cachedResult) {
      cachedResult.scanner.running = false;
    }
  }
}

app.get('/', (_req, res) =>
  res.json({
    ok: true,
    name: 'PO AI Predictor API',
    version: VERSION,
    endpoints: [
      '/api/best',
      '/api/health',
      '/api/analyze'
    ]
  })
);

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    version: VERSION,
    provider: 'Twelve Data LIVE',
    configured: Boolean(API_KEY),
    scannerRunning,
    lastScanAt,
    totalScanned,
    metadata: metadata()
  })
);

app.get('/api/best', (_req, res) => {
  // Mode A: no automatic scanner. The selected pair is fetched
  // through /api/analyze when the frontend requests it.
  res.json(
    cachedResult ||
      emptyResponse(
        'NO MARKET',
        null,
        API_KEY
          ? 'Selected-pair mode is active. Choose a pair to request a fresh analysis.'
          : 'The Twelve Data API key is not configured.'
      )
  );
});

app.get('/api/analyze', async (req, res) => {
  const pair = String(req.query.pair || '')
    .trim()
    .toUpperCase();

  const timeframe = Number(req.query.timeframe || 1);

  if (!PAIRS.includes(pair)) {
    return res.status(400).json({
      ok: false,
      error: 'Unsupported pair.',
      allowedPairs: PAIRS
    });
  }

  if (!TIMEFRAMES.includes(timeframe)) {
    return res.status(400).json({
      ok: false,
      error: 'Unsupported timeframe; use 1, 2, or 3.'
    });
  }

  try {
    const data = await getPairData(pair);

    const market = scoreMarket(
      data.candles,
      pair,
      timeframe,
      data.fetchedAt
    );

    // Recalculate all supported timeframes for the selected pair
    // from the same provider response.
    for (const tf of TIMEFRAMES) {
      latestMarkets.set(
        `${pair}|${tf}`,
        scoreMarket(
          data.candles,
          pair,
          tf,
          data.fetchedAt
        )
      );
    }

    const allCachedMarkets = [
      ...latestMarkets.values()
    ];

    const rankedCandidates = allCachedMarkets
      .filter(
        m =>
          m.freshness === 'FRESH' &&
          (m.signal === 'CALL' || m.signal === 'PUT')
      )
      .sort(
        (a, b) =>
          (b.confidence || 0) - (a.confidence || 0)
      )
      .map((m, i) => ({
        rank: i + 1,
        pair: m.pair,
        timeframe: m.timeframe,
        signal: m.signal,
        confidence: m.confidence,
        callScore: m.callScore,
        putScore: m.putScore,
        entryTime: m.entryTime,
        reason: m.reasons[0] || 'Evidence review.'
      }));

    cachedResult = makeResponse(
      market,
      rankedCandidates
    );

    return res.json(cachedResult);
  } catch (error) {
    return res.status(503).json({
      ok: false,
      version: VERSION,
      error: String(error.message || error),
      selectedMarket: emptyMarket(
        pair,
        timeframe,
        'Analysis failed; do not infer a trade.'
      )
    });
  }
});

// Automatic scanning is intentionally disabled in Mode A.
// Requests are driven by the selected pair via /api/analyze.

if (require.main === module) {
  app.listen(PORT, () =>
    console.log(
      `PO AI Predictor ${VERSION} listening on ${PORT}`
    )
  );
}

module.exports = app;
