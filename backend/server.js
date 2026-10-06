'use strict';

/*
============================================================
 PO AI PREDICTOR
 BACKEND V9.0.5
 LIVE ONLY - TWELVE DATA

 MAIN FIX:
 - Freshness-aware cache
 - Never treat old cache as live
 - 1m max age = 90s
 - 2m max age = 150s
 - 3m max age = 210s
 - hard stale = 300s
 - Provider safe limit = 6 requests/minute
 - Daily maximum = 736
 - Single provider queue
 - No duplicate scans
 - Fresh data has priority
 - One API response contract
 - Backend is the only signal engine
 - No MACD
 - No CCI
 - No OTC
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

const VERSION = 'V9.0.5';
const SOURCE = 'Twelve Data LIVE';
const TIMEZONE = 'UTC';

const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVEDATA_API_KEY ||
  '';

const TWELVE_DATA_BASE =
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

/*
 IMPORTANT:
 Twelve Data is queried at 1 minute.
 2m and 3m are built locally from completed 1m candles.
*/

const SOURCE_INTERVAL = '1min';

const MAX_CANDLES = 180;
const MIN_CANDLES = 60;

/*
 Provider safety
*/
const PROVIDER_HARD_LIMIT = 7;
const PROVIDER_SAFE_LIMIT = 6;

const PROVIDER_WINDOW_MS = 60 * 1000;
const PROVIDER_DELAY_MS = 1500;

/*
 Daily safety
*/
const DAILY_REQUEST_LIMIT = 768;
const DAILY_SAFETY_RESERVE = 32;
const MAX_DAILY_REQUESTS =
  DAILY_REQUEST_LIMIT - DAILY_SAFETY_RESERVE;

/*
 Cache
*/
const PAIR_CACHE_TTL_MS = 15 * 60 * 1000;
const RESULT_CACHE_TTL_MS = 30 * 1000;

/*
 Freshness
*/
const MAX_DATA_AGE_SECONDS = {
  1: 90,
  2: 150,
  3: 210
};

const HARD_STALE_SECONDS = 300;

/*
 Entry
*/
const ENTRY_BUFFER_SECONDS = 30;
const MIN_ENTRY_SECONDS = 30;

/*
 Scanner
*/
const SCAN_BATCH_SIZE = 6;
const SCAN_INTERVAL_MS = 60 * 1000;

/* =========================================================
   STATE
========================================================= */

const pairCache = new Map();

/*
 pairCache entry:

 {
   pair,
   candles,
   fetchedAt,
   latestCandleTime
 }
*/

const resultCache = new Map();

/*
 resultCache:

 pair -> {
   result,
   createdAt
 }
*/

let scanCursor = 0;
let scanRunning = false;
let scanPromise = null;

let lastScanAt = null;
let lastScanError = null;

let totalScanned = 0;
let totalFailed = 0;
let totalApiRequests = 0;

/*
 Rolling provider request timestamps
*/
const providerRequestTimes = [];

/*
 Daily counter
*/
let dailyCreditsUsed = 0;
let dailyCounterDate = utcDateKey(new Date());

/* =========================================================
   TIME HELPERS
========================================================= */

function nowMs() {
  return Date.now();
}

function utcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function resetDailyCounterIfNeeded() {
  const today = utcDateKey();

  if (today !== dailyCounterDate) {
    dailyCounterDate = today;
    dailyCreditsUsed = 0;
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function secondsFromNow(ms) {
  return Math.max(
    0,
    Math.floor((ms - nowMs()) / 1000)
  );
}

/* =========================================================
   PROVIDER LIMIT
========================================================= */

function cleanProviderRequestTimes() {
  const cutoff = nowMs() - PROVIDER_WINDOW_MS;

  while (
    providerRequestTimes.length &&
    providerRequestTimes[0] <= cutoff
  ) {
    providerRequestTimes.shift();
  }
}

function providerRequestsThisMinute() {
  cleanProviderRequestTimes();
  return providerRequestTimes.length;
}

function dailyRequestsRemaining() {
  resetDailyCounterIfNeeded();

  return Math.max(
    0,
    MAX_DAILY_REQUESTS - dailyCreditsUsed
  );
}

function reserveProviderRequest() {
  resetDailyCounterIfNeeded();
  cleanProviderRequestTimes();

  if (dailyCreditsUsed >= MAX_DAILY_REQUESTS) {
    throw new Error(
      'Daily provider safety limit reached'
    );
  }

  /*
   We deliberately stop at 6/min.
   Credit #7 remains unused as a safety margin.
  */
  if (
    providerRequestTimes.length >=
    PROVIDER_SAFE_LIMIT
  ) {
    throw new Error(
      'Provider minute safety limit reached'
    );
  }

  providerRequestTimes.push(nowMs());
  dailyCreditsUsed += 1;
  totalApiRequests += 1;
}

/*
 One queue for every Twelve Data request.
*/
let providerQueue = Promise.resolve();

function enqueueProviderRequest(task) {
  const run = providerQueue.then(async () => {
    resetDailyCounterIfNeeded();
    cleanProviderRequestTimes();

    /*
     Wait until a safe provider slot exists.
    */
    while (
      providerRequestTimes.length >=
      PROVIDER_SAFE_LIMIT
    ) {
      cleanProviderRequestTimes();

      if (
        providerRequestTimes.length <
        PROVIDER_SAFE_LIMIT
      ) {
        break;
      }

      const oldest =
        providerRequestTimes[0];

      const waitMs = Math.max(
        250,
        oldest +
          PROVIDER_WINDOW_MS -
          nowMs() +
          100
      );

      await sleep(waitMs);
    }

    if (
      dailyCreditsUsed >=
      MAX_DAILY_REQUESTS
    ) {
      throw new Error(
        'Daily provider safety limit reached'
      );
    }

    await sleep(PROVIDER_DELAY_MS);

    reserveProviderRequest();

    return task();
  });

  providerQueue = run.catch(() => {});

  return run;
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

/* =========================================================
   HTTP FETCH
========================================================= */

async function fetchJson(url) {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    18000
  );

  try {
    const response = await fetch(
      url,
      {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        }
      }
    );

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Provider returned invalid JSON (${response.status})`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Provider HTTP ${response.status}`
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

async function requestTwelveData(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      'TWELVE_DATA_API_KEY is not configured'
    );
  }

  const params = new URLSearchParams({
    symbol: pair,
    interval: SOURCE_INTERVAL,
    outputsize: String(MAX_CANDLES),
    timezone: 'UTC',
    apikey: TWELVE_DATA_API_KEY
  });

  const url =
    `${TWELVE_DATA_BASE}?${params.toString()}`;

  const data =
    await enqueueProviderRequest(
      () => fetchJson(url)
    );

  if (
    data &&
    typeof data === 'object' &&
    data.status === 'error'
  ) {
    throw new Error(
      data.message ||
      'Twelve Data provider error'
    );
  }

  if (
    data &&
    data.code &&
    data.message
  ) {
    throw new Error(
      data.message
    );
  }

  if (
    !data ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      'Twelve Data returned no candle values'
    );
  }

  const candles = normalizeCandles(
    data.values
  );

  if (candles.length < MIN_CANDLES) {
    throw new Error(
      `${pair}: insufficient candle data (${candles.length})`
    );
  }

  return candles;
}

/* =========================================================
   CANDLE NORMALIZATION
========================================================= */

function normalizeCandles(values) {
  const result = [];

  for (const row of values) {
    const time = Date.parse(
      String(row.datetime)
    );

    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);

    if (
      !Number.isFinite(time) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }

    result.push({
      time,
      open,
      high,
      low,
      close
    });
  }

  result.sort(
    (a, b) => a.time - b.time
  );

  /*
   Remove duplicate timestamps.
  */
  const unique = [];
  const seen = new Set();

  for (const candle of result) {
    if (seen.has(candle.time)) {
      continue;
    }

    seen.add(candle.time);
    unique.push(candle);
  }

  return unique.slice(-MAX_CANDLES);
}

/* =========================================================
   COMPLETED CANDLES
========================================================= */

function completedOneMinuteCandles(
  candles
) {
  const currentMinute =
    Math.floor(nowMs() / 60000) * 60000;

  return candles.filter(
    candle =>
      candle.time <
      currentMinute
  );
}

/* =========================================================
   LOCAL AGGREGATION
========================================================= */

function aggregateCandles(
  oneMinuteCandles,
  timeframe
) {
  if (timeframe === 1) {
    return oneMinuteCandles.slice();
  }

  const bucketMs =
    timeframe * 60 * 1000;

  const buckets = new Map();

  for (const candle of oneMinuteCandles) {
    const bucketStart =
      Math.floor(
        candle.time / bucketMs
      ) * bucketMs;

    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, []);
    }

    buckets
      .get(bucketStart)
      .push(candle);
  }

  const output = [];

  for (const [
    bucketStart,
    group
  ] of buckets.entries()) {
    if (!group.length) continue;

    group.sort(
      (a, b) => a.time - b.time
    );

    const first = group[0];
    const last =
      group[group.length - 1];

    /*
     Do not use incomplete aggregate candles.
    */
    const expectedCount = timeframe;

    if (group.length < expectedCount) {
      continue;
    }

    output.push({
      time: bucketStart,
      open: first.open,
      high: Math.max(
        ...group.map(x => x.high)
      ),
      low: Math.min(
        ...group.map(x => x.low)
      ),
      close: last.close
    });
  }

  return output;
}

/* =========================================================
   FRESHNESS
========================================================= */

function getFreshness(
  lastCandleTime,
  timeframe
) {
  if (!lastCandleTime) {
    return {
      status: 'NO_DATA',
      maxAgeSeconds: null,
      dataAgeSeconds: null
    };
  }

  const ageSeconds = Math.max(
    0,
    Math.floor(
      (nowMs() - lastCandleTime) /
        1000
    )
  );

  const maxAge =
    MAX_DATA_AGE_SECONDS[timeframe];

  let status = 'FRESH';

  if (ageSeconds > HARD_STALE_SECONDS) {
    status = 'HARD_STALE';
  } else if (ageSeconds > maxAge) {
    status = 'STALE';
  }

  return {
    status,
    maxAgeSeconds: maxAge,
    dataAgeSeconds: ageSeconds
  };
}

function isFreshEnough(
  freshness
) {
  return (
    freshness.status === 'FRESH'
  );
}

/* =========================================================
   CACHE
========================================================= */

function setPairCache(
  pair,
  candles
) {
  const latest =
    candles.length
      ? candles[candles.length - 1].time
      : null;

  pairCache.set(pair, {
    pair,
    candles,
    fetchedAt: nowMs(),
    latestCandleTime: latest
  });
}

function getPairCache(pair) {
  return pairCache.get(pair) || null;
}

function cacheAgeMs(cache) {
  if (!cache) return Infinity;

  return nowMs() - cache.fetchedAt;
}

function cacheIsUsableForTransport(
  cache
) {
  return (
    cache &&
    cacheAgeMs(cache) <
      PAIR_CACHE_TTL_MS
  );
}

/*
 IMPORTANT:

 A cache can be transport-valid but
 signal-stale.

 We therefore NEVER use cache TTL
 as signal freshness.
*/
function cacheCanProvideFreshSignal(
  cache,
  timeframe
) {
  if (!cache) return false;

  const candles =
    completedOneMinuteCandles(
      cache.candles
    );

  if (!candles.length) return false;

  const aggregated =
    aggregateCandles(
      candles,
      timeframe
    );

  if (!aggregated.length) {
    return false;
  }

  const last =
    aggregated[
      aggregated.length - 1
    ];

  const freshness =
    getFreshness(
      last.time,
      timeframe
    );

  return isFreshEnough(freshness);
}

/* =========================================================
   LOAD PAIR
========================================================= */

async function loadPair(
  pair,
  options = {}
) {
  const forceRefresh =
    options.forceRefresh === true;

  const cache =
    getPairCache(pair);

  /*
   First preference:
   fresh signal from cache.
  */
  if (
    !forceRefresh &&
    cacheIsUsableForTransport(cache)
  ) {
    const cacheFreshForAny =
      TIMEFRAMES.some(
        tf =>
          cacheCanProvideFreshSignal(
            cache,
            tf
          )
      );

    if (cacheFreshForAny) {
      return cache;
    }
  }

  /*
   If cached data exists but its latest
   candle is stale, refresh it.

   This is the main V9.0.5 fix.
  */
  const candles =
    await requestTwelveData(pair);

  setPairCache(
    pair,
    candles
  );

  return getPairCache(pair);
}

/* =========================================================
   INDICATORS
========================================================= */

function sma(values, period) {
  if (
    values.length < period
  ) {
    return null;
  }

  const slice =
    values.slice(-period);

  return (
    slice.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / period
  );
}

function ema(values, period) {
  if (
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      (
        values[i] - result
      ) *
        multiplier +
      result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (
    values.length <
    period + 1
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const diff =
      values[i] -
      values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] -
      values[i - 1];

    const gain =
      Math.max(0, diff);

    const loss =
      Math.max(0, -diff);

    avgGain =
      (
        avgGain *
          (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function atr(
  candles,
  period = 14
) {
  if (
    candles.length <
    period + 1
  ) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(
        current.high -
          current.low,
        Math.abs(
          current.high -
            previous.close
        ),
        Math.abs(
          current.low -
            previous.close
        )
      );

    trs.push(tr);
  }

  if (trs.length < period) {
    return null;
  }

  let value =
    trs
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    value =
      (
        value *
          (period - 1) +
        trs[i]
      ) / period;
  }

  return value;
}

function adx(
  candles,
  period = 14
) {
  if (
    candles.length <
    period * 2 + 1
  ) {
    return null;
  }

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const c =
      candles[i];

    const p =
      candles[i - 1];

    const up =
      c.high - p.high;

    const down =
      p.low - c.low;

    const trueRange =
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high - p.close
        ),
        Math.abs(
          c.low - p.close
        )
      );

    trs.push(trueRange);

    plusDM.push(
      up > down && up > 0
        ? up
        : 0
    );

    minusDM.push(
      down > up && down > 0
        ? down
        : 0
    );
  }

  let tr14 =
    trs
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      );

  let plus14 =
    plusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      );

  let minus14 =
    minusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      );

  const dx = [];

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    if (i > period) {
      tr14 =
        tr14 -
        tr14 / period +
        trs[i];

      plus14 =
        plus14 -
        plus14 / period +
        plusDM[i];

      minus14 =
        minus14 -
        minus14 / period +
        minusDM[i];
    }

    const plusDI =
      tr14 === 0
        ? 0
        : 100 *
          (plus14 / tr14);

    const minusDI =
      tr14 === 0
        ? 0
        : 100 *
          (minus14 / tr14);

    const denominator =
      plusDI + minusDI;

    const value =
      denominator === 0
        ? 0
        : 100 *
          Math.abs(
            plusDI - minusDI
          ) /
          denominator;

    dx.push(value);
  }

  if (dx.length < period) {
    return null;
  }

  let result =
    dx
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < dx.length;
    i++
  ) {
    result =
      (
        result *
          (period - 1) +
        dx[i]
      ) / period;
  }

  return result;
}

function stochastic(
  candles,
  period = 14
) {
  if (
    candles.length < period
  ) {
    return null;
  }

  const recent =
    candles.slice(-period);

  const highest =
    Math.max(
      ...recent.map(
        x => x.high
      )
    );

  const lowest =
    Math.min(
      ...recent.map(
        x => x.low
      )
    );

  const close =
    recent[
      recent.length - 1
    ].close;

  if (highest === lowest) {
    return 50;
  }

  return (
    (
      (close - lowest) /
      (highest - lowest)
    ) * 100
  );
}

function bollinger(
  values,
  period = 20,
  multiplier = 2
) {
  if (
    values.length < period
  ) {
    return {
      upper: null,
      middle: null,
      lower: null
    };
  }

  const middle =
    sma(values, period);

  const slice =
    values.slice(-period);

  const variance =
    slice.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - middle,
          2
        ),
      0
    ) / period;

  const sd =
    Math.sqrt(variance);

  return {
    upper:
      middle +
      multiplier * sd,
    middle,
    lower:
      middle -
      multiplier * sd
  };
}

/* =========================================================
   PRICE ACTION
========================================================= */

function candlePattern(candles) {
  if (candles.length < 3) {
    return {
      pattern: 'INSUFFICIENT DATA',
      direction: 'NEUTRAL',
      strength: 0
    };
  }

  const c =
    candles[candles.length - 1];

  const p =
    candles[candles.length - 2];

  const body =
    Math.abs(
      c.close - c.open
    );

  const range =
    c.high - c.low;

  if (range <= 0) {
    return {
      pattern: 'MIXED PRICE ACTION',
      direction: 'NEUTRAL',
      strength: 0
    };
  }

  const bodyRatio =
    body / range;

  if (
    c.close > c.open &&
    bodyRatio >= 0.65
  ) {
    return {
      pattern: 'STRONG BULLISH CANDLE',
      direction: 'CALL',
      strength: 4
    };
  }

  if (
    c.close < c.open &&
    bodyRatio >= 0.65
  ) {
    return {
      pattern: 'STRONG BEARISH CANDLE',
      direction: 'PUT',
      strength: 4
    };
  }

  const upperWick =
    c.high -
    Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) -
    c.low;

  if (
    lowerWick > body * 2 &&
    lowerWick > upperWick * 1.5
  ) {
    return {
      pattern: 'BULLISH REJECTION',
      direction: 'CALL',
      strength: 3
    };
  }

  if (
    upperWick > body * 2 &&
    upperWick > lowerWick * 1.5
  ) {
    return {
      pattern: 'BEARISH REJECTION',
      direction: 'PUT',
      strength: 3
    };
  }

  if (
    c.close > c.open &&
    p.close < p.open &&
    c.close > p.open
  ) {
    return {
      pattern: 'BULLISH REVERSAL',
      direction: 'CALL',
      strength: 3
    };
  }

  if (
    c.close < c.open &&
    p.close > p.open &&
    c.close < p.open
  ) {
    return {
      pattern: 'BEARISH REVERSAL',
      direction: 'PUT',
      strength: 3
    };
  }

  return {
    pattern: 'MIXED PRICE ACTION',
    direction: 'NEUTRAL',
    strength: 0
  };
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
  candles
) {
  if (candles.length < 20) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    candles.slice(-30);

  const support =
    Math.min(
      ...recent.map(
        x => x.low
      )
    );

  const resistance =
    Math.max(
      ...recent.map(
        x => x.high
      )
    );

  return {
    support,
    resistance
  };
}

/* =========================================================
   MARKET PSYCHOLOGY
========================================================= */

function marketPsychology(
  candles,
  ema9,
  ema21,
  rsi14
) {
  if (
    !ema9 ||
    !ema21 ||
    rsi14 == null
  ) {
    return {
      label:
        'Insufficient market structure',
      direction: 'NEUTRAL',
      strength: 0
    };
  }

  const close =
    candles[
      candles.length - 1
    ].close;

  if (
    ema9 < ema21 &&
    rsi14 < 48 &&
    close < ema21
  ) {
    return {
      label:
        'Bearish momentum / sellers in control',
      direction: 'PUT',
      strength: 8
    };
  }

  if (
    ema9 > ema21 &&
    rsi14 > 52 &&
    close > ema21
  ) {
    return {
      label:
        'Bullish momentum / buyers in control',
      direction: 'CALL',
      strength: 8
    };
  }

  return {
    label:
      'Balanced / mixed price action',
    direction: 'NEUTRAL',
    strength: 0
  };
}

/* =========================================================
   ANALYZE CANDLES
========================================================= */

function analyzeCandles(
  pair,
  timeframe,
  candles
) {
  const closes =
    candles.map(
      x => x.close
    );

  const current =
    candles[
      candles.length - 1
    ];

  const currentPrice =
    current.close;

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const rsi14 =
    rsi(closes, 14);

  const atr14 =
    atr(candles, 14);

  const adx14 =
    adx(candles, 14);

  const stochastic14 =
    stochastic(
      candles,
      14
    );

  const bollinger20 =
    bollinger(
      closes,
      20,
      2
    );

  const sr =
    supportResistance(
      candles
    );

  const priceAction =
    candlePattern(
      candles
    );

  const psychology =
    marketPsychology(
      candles,
      ema9,
      ema21,
      rsi14
    );

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  /*
   EMA
  */
  if (
    ema9 != null &&
    ema21 != null
  ) {
    if (ema9 > ema21) {
      callScore += 18;
      reasons.push(
        'EMA9 is above EMA21'
      );
    } else if (ema9 < ema21) {
      putScore += 18;
      reasons.push(
        'EMA9 is below EMA21'
      );
    }
  }

  /*
   RSI
  */
  if (rsi14 != null) {
    if (rsi14 >= 55) {
      callScore += 12;
      reasons.push(
        'RSI supports bullish momentum'
      );
    } else if (rsi14 <= 45) {
      putScore += 12;
      reasons.push(
        'RSI supports bearish momentum'
      );
    }
  }

  /*
   ADX
  */
  if (
    adx14 != null &&
    adx14 >= 20
  ) {
    if (
      ema9 != null &&
      ema21 != null
    ) {
      if (ema9 > ema21) {
        callScore += 10;
      } else if (ema9 < ema21) {
        putScore += 10;
      }

      reasons.push(
        'ADX confirms trend strength'
      );
    }
  }

  /*
   Stochastic
  */
  if (stochastic14 != null) {
    if (
      stochastic14 >= 80
    ) {
      /*
       Overbought is NOT automatically
       a PUT. It is a caution signal.
      */
      if (
        ema9 < ema21
      ) {
        putScore += 8;
      }

      reasons.push(
        'Stochastic is deeply overbought'
      );
    } else if (
      stochastic14 <= 20
    ) {
      /*
       Oversold is NOT automatically
       a CALL. It is a caution signal.
      */
      if (
        ema9 > ema21
      ) {
        callScore += 8;
      }

      reasons.push(
        'Stochastic is deeply oversold'
      );
    }
  }

  /*
   Price action
  */
  if (
    priceAction.direction ===
    'CALL'
  ) {
    callScore +=
      priceAction.strength;
    reasons.push(
      priceAction.pattern
    );
  }

  if (
    priceAction.direction ===
    'PUT'
  ) {
    putScore +=
      priceAction.strength;
    reasons.push(
      priceAction.pattern
    );
  }

  /*
   Psychology
  */
  if (
    psychology.direction ===
    'CALL'
  ) {
    callScore +=
      psychology.strength;
    reasons.push(
      psychology.label
    );
  }

  if (
    psychology.direction ===
    'PUT'
  ) {
    putScore +=
      psychology.strength;
    reasons.push(
      psychology.label
    );
  }

  /*
   Bollinger context
  */
  if (
    bollinger20.upper != null &&
    bollinger20.lower != null
  ) {
    if (
      currentPrice >
      bollinger20.middle
    ) {
      callScore += 3;
    } else if (
      currentPrice <
      bollinger20.middle
    ) {
      putScore += 3;
    }
  }

  /*
   Support / resistance context
  */
  if (
    sr.support != null &&
    sr.resistance != null
  ) {
    const range =
      sr.resistance -
      sr.support;

    if (range > 0) {
      const location =
        (
          currentPrice -
          sr.support
        ) / range;

      /*
       Avoid blindly calling at resistance
       or PUT directly at support.
      */
      if (
        location > 0.82
      ) {
        putScore += 3;
      }

      if (
        location < 0.18
      ) {
        callScore += 3;
      }
    }
  }

  const gap =
    Math.abs(
      callScore -
      putScore
    );

  let signal = 'NO TRADE';

  /*
   Base directional threshold.
  */
  if (
    callScore >= 55 &&
    callScore > putScore &&
    gap >= 12
  ) {
    signal = 'CALL';
  } else if (
    putScore >= 55 &&
    putScore > callScore &&
    gap >= 12
  ) {
    signal = 'PUT';
  }

  /*
   Confidence
  */
  const winningScore =
    Math.max(
      callScore,
      putScore
    );

  let confidence =
    Math.min(
      94,
      Math.round(
        45 +
        winningScore * 0.55 +
        Math.min(gap, 30) * 0.35
      )
    );

  if (signal === 'NO TRADE') {
    confidence = Math.min(
      59,
      Math.max(
        40,
        Math.round(
          45 +
          winningScore * 0.15
        )
      )
    );
  }

  let volatility = 'LOW';

  if (
    atr14 != null &&
    currentPrice > 0
  ) {
    const atrPct =
      (atr14 / currentPrice) *
      100;

    if (atrPct >= 0.08) {
      volatility = 'HIGH';
    } else if (
      atrPct >= 0.03
    ) {
      volatility = 'MEDIUM';
    }
  }

  return {
    currentPrice,

    callScore,
    putScore,
    gap,

    signal,
    confidence,

    volatility,

    indicators: {
      ema9,
      ema21,
      rsi14,
      adx14,
      stochastic14,
      atr14,
      bollinger: bollinger20
    },

    supportResistance: sr,

    priceAction,

    marketPsychology: psychology,

    reasons
  };
}

/* =========================================================
   BUILD MARKET RESULT
========================================================= */

function buildMarketResult(
  pair,
  timeframe,
  candles
) {
  if (!candles.length) {
    return null;
  }

  const last =
    candles[
      candles.length - 1
    ];

  const freshness =
    getFreshness(
      last.time,
      timeframe
    );

  const analysis =
    analyzeCandles(
      pair,
      timeframe,
      candles
    );

  /*
   HARD RULE:
   A stale market can NEVER be CALL/PUT.
  */
  if (
    !isFreshEnough(freshness)
  ) {
    analysis.signal =
      'NO TRADE';

    analysis.confidence =
      40;

    analysis.reasons.push(
      freshness.status ===
      'HARD_STALE'
        ? 'Data is hard stale'
        : 'Data is stale'
    );

    analysis.reasons.push(
      'No sufficiently fresh directional setup'
    );
  }

  /*
   Entry must always be in the future.
   Align entry to the next whole minute,
   plus safety buffer.
  */
  const currentMinute =
    Math.floor(
      nowMs() / 60000
    ) * 60000;

  let entryTime =
    currentMinute +
    60000;

  /*
   Ensure >= 30 seconds.
  */
  if (
    entryTime - nowMs() <
    MIN_ENTRY_SECONDS * 1000
  ) {
    entryTime += 60000;
  }

  /*
   If NO TRADE, these times are informational
   only. They must never be presented as an
   executable signal by frontend.
  */
  const expiryTime =
    entryTime +
    timeframe * 60000;

  return {
    pair,
    timeframe,

    signal: analysis.signal,
    confidence: analysis.confidence,

    currentPrice:
      analysis.currentPrice,

    entryPrice:
      analysis.currentPrice,

    entryTime: iso(entryTime),
    expiryTime: iso(expiryTime),

    entryInSeconds:
      secondsFromNow(entryTime),

    lastCandle:
      iso(last.time),

    dataAgeSeconds:
      freshness.dataAgeSeconds,

    freshness,

    callScore:
      analysis.callScore,

    putScore:
      analysis.putScore,

    gap:
      analysis.gap,

    volatility:
      analysis.volatility,

    indicators:
      analysis.indicators,

    supportResistance:
      analysis.supportResistance,

    priceAction:
      analysis.priceAction,

    marketPsychology:
      analysis.marketPsychology,

    reasons:
      analysis.reasons
  };
}

/* =========================================================
   PAIR ANALYSIS
========================================================= */

async function analyzePair(
  pair,
  options = {}
) {
  const forceRefresh =
    options.forceRefresh === true;

  const cache =
    await loadPair(
      pair,
      { forceRefresh }
    );

  const baseCandles =
    completedOneMinuteCandles(
      cache.candles
    );

  const markets = [];

  for (const timeframe of TIMEFRAMES) {
    const candles =
      aggregateCandles(
        baseCandles,
        timeframe
      );

    if (
      candles.length <
      MIN_CANDLES / timeframe
    ) {
      continue;
    }

    const market =
      buildMarketResult(
        pair,
        timeframe,
        candles
      );

    if (market) {
      markets.push(market);
    }
  }

  /*
   Prefer fresh valid signals.
  */
  const valid =
    markets.filter(
      m =>
        m.signal !== 'NO TRADE' &&
        m.freshness.status ===
          'FRESH'
    );

  if (valid.length) {
    valid.sort(
      compareMarkets
    );

    return valid[0];
  }

  /*
   If there is no valid signal, return
   the freshest market for diagnostics.
  */
  markets.sort(
    compareDiagnosticMarkets
  );

  return (
    markets[0] ||
    null
  );
}

/* =========================================================
   RANKING
========================================================= */

function compareMarkets(a, b) {
  /*
   Freshness first.
  */
  const ageA =
    a.dataAgeSeconds ?? 99999;

  const ageB =
    b.dataAgeSeconds ?? 99999;

  if (ageA !== ageB) {
    return ageA - ageB;
  }

  /*
   Confidence second.
  */
  if (
    b.confidence !==
    a.confidence
  ) {
    return (
      b.confidence -
      a.confidence
    );
  }

  /*
   Gap third.
  */
  return (
    b.gap -
    a.gap
  );
}

function compareDiagnosticMarkets(
  a,
  b
) {
  const freshnessRank = {
    FRESH: 0,
    STALE: 1,
    HARD_STALE: 2,
    NO_DATA: 3
  };

  const ar =
    freshnessRank[
      a.freshness.status
    ] ?? 9;

  const br =
    freshnessRank[
      b.freshness.status
    ] ?? 9;

  if (ar !== br) {
    return ar - br;
  }

  return (
    (a.dataAgeSeconds ?? 99999) -
    (b.dataAgeSeconds ?? 99999)
  );
}

/* =========================================================
   CANDIDATES FROM CACHE
========================================================= */

function cachedCandidates() {
  const candidates = [];

  for (const pair of PAIRS) {
    const cache =
      getPairCache(pair);

    if (!cache) continue;

    const baseCandles =
      completedOneMinuteCandles(
        cache.candles
      );

    for (const timeframe of TIMEFRAMES) {
      const candles =
        aggregateCandles(
          baseCandles,
          timeframe
        );

      if (!candles.length) {
        continue;
      }

      const market =
        buildMarketResult(
          pair,
          timeframe,
          candles
        );

      if (!market) continue;

      /*
       ONLY fresh executable signals.
      */
      if (
        market.signal === 'CALL' ||
        market.signal === 'PUT'
      ) {
        if (
          market.freshness.status ===
          'FRESH' &&
          market.entryInSeconds >=
            ENTRY_BUFFER_SECONDS
        ) {
          candidates.push(market);
        }
      }
    }
  }

  candidates.sort(
    compareMarkets
  );

  return candidates;
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
    const started =
      nowMs();

    lastScanError = null;

    let scannedThisRun = 0;

    try {
      /*
       Scan only a controlled batch.
      */
      const end =
        Math.min(
          scanCursor +
            SCAN_BATCH_SIZE,
          PAIRS.length
        );

      const batch =
        PAIRS.slice(
          scanCursor,
          end
        );

      for (const pair of batch) {
        try {
          /*
           V9.0.5:
           First check whether cache can still
           provide a fresh 1m signal.

           If not, refresh.
          */
          let cache =
            getPairCache(pair);

          let needsRefresh =
            !cache;

          if (cache) {
            const hasFresh =
              TIMEFRAMES.some(
                tf =>
                  cacheCanProvideFreshSignal(
                    cache,
                    tf
                  )
              );

            if (!hasFresh) {
              needsRefresh = true;
            }
          }

          if (needsRefresh) {
            cache =
              await loadPair(
                pair,
                {
                  forceRefresh: true
                }
              );
          }

          /*
           Analyze all local timeframes.
          */
          const base =
            completedOneMinuteCandles(
              cache.candles
            );

          for (
            const timeframe
            of TIMEFRAMES
          ) {
            const candles =
              aggregateCandles(
                base,
                timeframe
              );

            if (!candles.length) {
              continue;
            }

            const market =
              buildMarketResult(
                pair,
                timeframe,
                candles
              );

            if (
              market &&
              (
                market.signal === 'CALL' ||
                market.signal === 'PUT'
              ) &&
              market.freshness.status ===
                'FRESH'
            ) {
              resultCache.set(
                `${pair}:${timeframe}`,
                {
                  result: market,
                  createdAt: nowMs()
                }
              );
            }
          }

          scannedThisRun++;
          totalScanned++;
        } catch (error) {
          totalFailed++;

          lastScanError =
            `${pair}: ${
              error.message
            }`;
        }
      }

      scanCursor = end;

      /*
       Start a new cycle after reaching end.
      */
      if (
        scanCursor >= PAIRS.length
      ) {
        scanCursor = 0;
      }

      lastScanAt =
        iso(nowMs());

      return {
        scannedThisRun,
        elapsedMs:
          nowMs() - started
      };
    } finally {
      scanRunning = false;
      scanPromise = null;
    }
  })();

  return scanPromise;
}

/* =========================================================
   BEST MARKET
========================================================= */

function bestMarket() {
  const candidates =
    cachedCandidates();

  if (candidates.length) {
    return candidates[0];
  }

  return null;
}

/* =========================================================
   NO TRADE FALLBACK
========================================================= */

function noTradeMarket() {
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

    freshness: {
      status: 'NO_DATA',
      maxAgeSeconds: null,
      dataAgeSeconds: null
    },

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
      bollinger: {
        upper: null,
        middle: null,
        lower: null
      }
    },

    supportResistance: {
      support: null,
      resistance: null
    },

    priceAction: {
      pattern: 'NO VALID SIGNAL',
      direction: 'NEUTRAL',
      strength: 0
    },

    marketPsychology: {
      label:
        'No sufficiently fresh market data',
      direction: 'NEUTRAL',
      strength: 0
    },

    reasons: [
      'No sufficiently fresh valid signal available'
    ]
  };
}

/* =========================================================
   METADATA
========================================================= */

function metadata() {
  resetDailyCounterIfNeeded();

  return {
    provider: SOURCE,
    liveOnly: true,

    providerMinuteLimit:
      PROVIDER_HARD_LIMIT,

    providerSafeMinuteLimit:
      PROVIDER_SAFE_LIMIT,

    providerRequestsThisMinute:
      providerRequestsThisMinute(),

    dailyLimit:
      DAILY_REQUEST_LIMIT,

    dailySafetyReserve:
      DAILY_SAFETY_RESERVE,

    maxDailyRequests:
      MAX_DAILY_REQUESTS,

    dailyCreditsUsed:
      dailyCreditsUsed,

    dailyCreditsRemaining:
      dailyRequestsRemaining(),

    pairCacheTtlSeconds:
      Math.floor(
        PAIR_CACHE_TTL_MS / 1000
      ),

    resultCacheTtlSeconds:
      Math.floor(
        RESULT_CACHE_TTL_MS / 1000
      ),

    entryBufferSeconds:
      ENTRY_BUFFER_SECONDS,

    maxDataAgeSeconds:
      MAX_DATA_AGE_SECONDS,

    hardStaleSeconds:
      HARD_STALE_SECONDS
  };
}

/* =========================================================
   RANKED CANDIDATES
========================================================= */

function rankedCandidates() {
  return cachedCandidates()
    .slice(0, 10)
    .map((market, index) => ({
      rank: index + 1,
      ...market
    }));
}

/* =========================================================
   API RESPONSE
========================================================= */

function makeResponse(
  selectedMarket
) {
  return {
    ok: true,
    version: VERSION,
    source: SOURCE,
    timezone: TIMEZONE,

    selectedMarket:
      selectedMarket ||
      noTradeMarket(),

    supportedTimeframes:
      TIMEFRAMES,

    pairs:
      PAIRS,

    metadata:
      metadata(),

    scanner: {
      scanRunning,
      scanCursor,
      scanBatchSize:
        SCAN_BATCH_SIZE,

      cachedPairs:
        pairCache.size,

      candidateCount:
        cachedCandidates().length,

      lastScanAt,

      lastScanError,

      totalScanned,
      totalFailed,
      totalApiRequests
    },

    rankedCandidates:
      rankedCandidates()
  };
}

/* =========================================================
   ROUTES
========================================================= */

app.get(
  '/',
  (req, res) => {
    res.json({
      ok: true,
      service:
        'PO AI Predictor API',
      version: VERSION,
      source: SOURCE,
      endpoints: [
        '/api/health',
        '/api/best',
        '/api/analyze?pair=EUR/USD',
        '/api/pairs'
      ]
    });
  }
);

app.get(
  '/api/health',
  (req, res) => {
    res.json(
      makeResponse(
        bestMarket()
      )
    );
  }
);

app.get(
  '/api/best',
  async (req, res) => {
    try {
      /*
       Start/continue scanner, but do not
       create duplicate scans.
      */
      if (!scanRunning) {
        scanBatch().catch(() => {});
      }

      /*
       Use current fresh cached candidates.
      */
      const best =
        bestMarket();

      res.json(
        makeResponse(best)
      );
    } catch (error) {
      res.status(200).json({
        ...makeResponse(null),
        scanner: {
          scanRunning,
          scanCursor,
          scanBatchSize:
            SCAN_BATCH_SIZE,
          cachedPairs:
            pairCache.size,
          candidateCount: 0,
          lastScanAt,
          lastScanError:
            error.message,
          totalScanned,
          totalFailed,
          totalApiRequests
        }
      });
    }
  }
);

app.get(
  '/api/analyze',
  async (req, res) => {
    const pair =
      String(
        req.query.pair || ''
      ).trim();

    if (!pair) {
      return res
        .status(400)
        .json({
          ok: false,
          version: VERSION,
          error:
            'Missing pair parameter'
        });
    }

    const normalized =
      PAIRS.find(
        p =>
          p.toUpperCase() ===
          pair.toUpperCase()
      );

    if (!normalized) {
      return res
        .status(400)
        .json({
          ok: false,
          version: VERSION,
          error:
            'Unsupported currency pair',
          supportedPairs:
            PAIRS
        });
    }

    try {
      /*
       Direct analyze uses fresh-aware
       load logic.
      */
      const result =
        await analyzePair(
          normalized
        );

      res.json(
        makeResponse(result)
      );
    } catch (error) {
      res.status(200).json({
        ...makeResponse(null),
        scanner: {
          scanRunning,
          scanCursor,
          scanBatchSize:
            SCAN_BATCH_SIZE,
          cachedPairs:
            pairCache.size,
          candidateCount: 0,
          lastScanAt,
          lastScanError:
            `${normalized}: ${error.message}`,
          totalScanned,
          totalFailed,
          totalApiRequests
        }
      });
    }
  }
);

app.get(
  '/api/pairs',
  (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      pairs: PAIRS,
      supportedTimeframes:
        TIMEFRAMES
    });
  }
);

/* =========================================================
   BACKGROUND SCANNER
========================================================= */

function startScanner() {
  setTimeout(() => {
    scanBatch().catch(
      error => {
        lastScanError =
          error.message;
      }
    );
  }, 5000);

  setInterval(() => {
    if (!scanRunning) {
      scanBatch().catch(
        error => {
          lastScanError =
            error.message;
        }
      );
    }
  }, SCAN_INTERVAL_MS);
}

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {
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
      `Provider safe limit: ${PROVIDER_SAFE_LIMIT}/minute`
    );

    console.log(
      `Daily maximum: ${MAX_DAILY_REQUESTS}`
    );

    console.log(
      `Freshness: 1m=${MAX_DATA_AGE_SECONDS[1]}s, 2m=${MAX_DATA_AGE_SECONDS[2]}s, 3m=${MAX_DATA_AGE_SECONDS[3]}s`
    );

    startScanner();
  }
);
