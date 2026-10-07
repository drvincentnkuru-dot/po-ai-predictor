'use strict';

/*
============================================================
 PO AI PREDICTOR
 BACKEND V9.2.1
 LIVE ONLY - Twelve Data

 TARGETED FIX:
 - Keeps V9.2 API response contract
 - Keeps V9.1 frontend compatible
 - Keeps 24 pairs
 - Keeps 1m / 2m / 3m
 - Keeps EMA9/21, RSI14, ADX14, Stochastic,
   ATR, Bollinger, Support/Resistance,
   Candlestick Price Action, Market Psychology
 - NO MACD
 - NO CCI

 MAIN FIX IN V9.2.1:
 The previous V9.2 pair cache could remain usable for
 15 minutes even when its latest candle was already stale.

 V9.2.1 now separates:
   1. transport/cache lifetime
   2. market-data freshness

 A cached pair is refreshed when its latest 1-minute
 candle becomes too old.

 IMPORTANT:
 - script.js V9.1 does NOT need to change
 - index.html V9.1 does NOT need to change
 - frontend remains a pure renderer of /api/best
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

const VERSION = 'V9.2.1';

const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVE_DATA_KEY ||
  '';

const TWELVE_DATA_BASE_URL =
  'https://api.twelvedata.com/time_series';

/* =========================================================
   PROVIDER QUOTA
========================================================= */

const PROVIDER_HARD_LIMIT = 7;
const PROVIDER_SAFE_LIMIT = 6;
const PROVIDER_WINDOW_MS = 60 * 1000;

/*
 One request every 1.5 seconds.
 This gives the provider queue enough spacing.
*/
const PROVIDER_DELAY_MS = 1500;

/* =========================================================
   DAILY QUOTA
========================================================= */

const DAILY_REQUEST_LIMIT = 768;
const DAILY_SAFETY_RESERVE = 32;

const DAILY_USABLE_LIMIT =
  DAILY_REQUEST_LIMIT - DAILY_SAFETY_RESERVE;

/* =========================================================
   CACHE
========================================================= */

/*
 Transport cache may remain in memory for 15 minutes.

 IMPORTANT:
 This is NOT the market freshness rule.

 V9.2.1 checks the latest candle independently.
*/
const PAIR_CACHE_TTL_MS = 15 * 60 * 1000;

/*
 Result cache is intentionally short because /api/best
 must remain responsive while signals can change quickly.
*/
const RESULT_CACHE_TTL_MS = 30 * 1000;

/*
 V9.2.1:
 A 1-minute candle older than 90 seconds causes the pair
 to require a provider refresh.

 This fixes the previous situation where a 15-minute cache
 could contain 10+ minute old candles.
*/
const BASE_PAIR_REFRESH_MAX_AGE_SECONDS = 90;

/* =========================================================
   FRESHNESS RULES
========================================================= */

const FRESHNESS_RULES = {
  1: 90,
  2: 150,
  3: 210
};

const HARD_STALE_SECONDS = 300;

/* =========================================================
   ENTRY RULES
========================================================= */

const ENTRY_BUFFER_SECONDS = 30;
const MIN_ENTRY_SECONDS = 30;

/* =========================================================
   SCANNER
========================================================= */

const SCAN_BATCH_SIZE = 6;
const SCAN_EVERY_MS = 60 * 1000;

/* =========================================================
   MARKET
========================================================= */

const SUPPORTED_TIMEFRAMES = [1, 2, 3];

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

/* =========================================================
   STATE
========================================================= */

const pairCache = new Map();
const resultCache = new Map();

let providerRequestTimes = [];
let providerQueue = Promise.resolve();

let dailyCreditsUsed = 0;

let scanRunning = false;
let scanCursor = 0;
let lastScanAt = null;
let lastScanError = null;

let totalScanned = 0;
let totalFailed = 0;
let totalApiRequests = 0;

/* =========================================================
   DAILY RESET
========================================================= */

let dailyKey = getUtcDayKey();

function getUtcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyIfNeeded() {
  const currentKey = getUtcDayKey();

  if (currentKey !== dailyKey) {
    dailyKey = currentKey;
    dailyCreditsUsed = 0;
    providerRequestTimes = [];
  }
}

/* =========================================================
   QUOTA HELPERS
========================================================= */

function getDailyCreditsRemaining() {
  resetDailyIfNeeded();

  return Math.max(
    0,
    DAILY_USABLE_LIMIT - dailyCreditsUsed
  );
}

function cleanupProviderRequestTimes() {
  const now = Date.now();

  providerRequestTimes =
    providerRequestTimes.filter(
      (timestamp) =>
        now - timestamp < PROVIDER_WINDOW_MS
    );
}

function getProviderWaitMs() {
  cleanupProviderRequestTimes();

  if (
    providerRequestTimes.length <
    PROVIDER_SAFE_LIMIT
  ) {
    return 0;
  }

  const oldest =
    providerRequestTimes[0];

  return Math.max(
    0,
    PROVIDER_WINDOW_MS -
      (Date.now() - oldest)
  );
}

function reserveProviderRequest() {
  resetDailyIfNeeded();
  cleanupProviderRequestTimes();

  if (
    dailyCreditsUsed >=
    DAILY_USABLE_LIMIT
  ) {
    throw new ProviderQuotaError(
      'Daily safety quota reached'
    );
  }

  if (
    providerRequestTimes.length >=
    PROVIDER_SAFE_LIMIT
  ) {
    throw new ProviderQuotaError(
      'Provider minute safety limit reached'
    );
  }

  providerRequestTimes.push(Date.now());

  dailyCreditsUsed += 1;
  totalApiRequests += 1;
}

/* =========================================================
   ERRORS
========================================================= */

class ProviderQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderQuotaError';
  }
}

/* =========================================================
   DELAY
========================================================= */

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

/* =========================================================
   PROVIDER QUEUE
========================================================= */

function enqueueProviderTask(task) {
  const run = providerQueue
    .catch(() => {})
    .then(async () => {
      const waitMs =
        getProviderWaitMs();

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      return task();
    });

  providerQueue = run.catch(() => {});

  return run;
}

/* =========================================================
   FETCH TWELVE DATA
========================================================= */

async function fetchTwelveData(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      'TWELVE_DATA_API_KEY is not configured'
    );
  }

  const url =
    `${TWELVE_DATA_BASE_URL}` +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=1min` +
    `&outputsize=180` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(
      TWELVE_DATA_API_KEY
    )}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (
    data &&
    typeof data.code === 'number' &&
    data.code !== 200
  ) {
    const message =
      data.message ||
      `Twelve Data error ${data.code}`;

    if (
      /limit|quota|credit|rate/i.test(
        message
      )
    ) {
      throw new ProviderQuotaError(
        message
      );
    }

    throw new Error(message);
  }

  if (
    !data ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      `${pair}: Twelve Data returned no candle data`
    );
  }

  return data.values;
}

/* =========================================================
   PROVIDER REQUEST
========================================================= */

async function requestTwelveData(pair) {
  return enqueueProviderTask(
    async () => {
      resetDailyIfNeeded();
      cleanupProviderRequestTimes();

      if (
        dailyCreditsUsed >=
        DAILY_USABLE_LIMIT
      ) {
        throw new ProviderQuotaError(
          'Daily safety quota reached'
        );
      }

      if (
        providerRequestTimes.length >=
        PROVIDER_SAFE_LIMIT
      ) {
        throw new ProviderQuotaError(
          'Provider minute safety limit reached'
        );
      }

      /*
       Reserve BEFORE network call.
       This prevents duplicate requests from
       crossing the safety boundary.
      */
      reserveProviderRequest();

      try {
        const values =
          await fetchTwelveData(pair);

        /*
         Space provider requests.
        */
        await sleep(PROVIDER_DELAY_MS);

        return values;
      } catch (error) {
        /*
         The provider request was already counted,
         because the request was actually attempted.
        */
        throw error;
      }
    }
  );
}

/* =========================================================
   DATE PARSING
========================================================= */

function parseProviderTime(value) {
  if (!value) {
    return null;
  }

  let text =
    String(value).trim();

  /*
   Twelve Data is requested in UTC.
   If timezone is not included, treat it as UTC.
  */
  if (
    !/[zZ]$/.test(text) &&
    !/[+-]\d\d:\d\d$/.test(text)
  ) {
    text += 'Z';
  }

  const timestamp =
    new Date(text).getTime();

  if (
    Number.isNaN(timestamp)
  ) {
    return null;
  }

  return new Date(timestamp);
}

/* =========================================================
   NORMALIZE CANDLES
========================================================= */

function normalizeCandles(values) {
  const candles =
    values
      .map((row) => {
        const time =
          parseProviderTime(row.datetime);

        const open =
          Number(row.open);

        const high =
          Number(row.high);

        const low =
          Number(row.low);

        const close =
          Number(row.close);

        if (
          !time ||
          !Number.isFinite(open) ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close)
        ) {
          return null;
        }

        return {
          time: time.toISOString(),
          open,
          high,
          low,
          close
        };
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(a.time) -
          new Date(b.time)
      );

  return candles;
}

/* =========================================================
   AGGREGATE CANDLES
========================================================= */

function aggregateCandles(
  candles,
  minutes
) {
  if (minutes === 1) {
    return candles.slice();
  }

  const bucketMs =
    minutes *
    60 *
    1000;

  const groups = new Map();

  for (const candle of candles) {
    const time =
      new Date(candle.time).getTime();

    const bucket =
      Math.floor(time / bucketMs) *
      bucketMs;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups
      .get(bucket)
      .push(candle);
  }

  const result = [];

  for (const [
    bucket,
    group
  ] of groups.entries()) {
    if (!group.length) {
      continue;
    }

    result.push({
      time:
        new Date(bucket).toISOString(),
      open: group[0].open,
      high: Math.max(
        ...group.map(
          (x) => x.high
        )
      ),
      low: Math.min(
        ...group.map(
          (x) => x.low
        )
      ),
      close:
        group[group.length - 1].close
    });
  }

  return result.sort(
    (a, b) =>
      new Date(a.time) -
      new Date(b.time)
  );
}

/* =========================================================
   CANDLE AGE
========================================================= */

function getLastCandleAgeSeconds(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return Infinity;
  }

  const last =
    candles[candles.length - 1];

  const timestamp =
    new Date(last.time).getTime();

  if (
    Number.isNaN(timestamp)
  ) {
    return Infinity;
  }

  return Math.max(
    0,
    (Date.now() - timestamp) /
      1000
  );
}

/* =========================================================
   V9.2.1 CACHE FRESHNESS
========================================================= */

/*
 This is the critical fix.

 A cached pair can have:
   fetchedAt = recent
 but:
   last candle = old

 We therefore check the candle itself.
*/

function pairNeedsRefresh(
  cached
) {
  if (!cached) {
    return true;
  }

  if (
    !Array.isArray(
      cached.candles
    ) ||
    cached.candles.length === 0
  ) {
    return true;
  }

  const age =
    getLastCandleAgeSeconds(
      cached.candles
    );

  return (
    age >
    BASE_PAIR_REFRESH_MAX_AGE_SECONDS
  );
}

/* =========================================================
   CACHE ACCESS
========================================================= */

/*
 Transport cache:
 - prevents unnecessary memory churn
 - remains available as stale fallback

 It does NOT decide whether the market data
 is fresh enough for trading.
*/

function getCachedPair(
  pair
) {
  const cached =
    pairCache.get(pair);

  if (!cached) {
    return null;
  }

  if (
    Date.now() -
      cached.fetchedAt >
    PAIR_CACHE_TTL_MS
  ) {
    return null;
  }

  return cached;
}

/* =========================================================
   SAVE PAIR
========================================================= */

function savePair(
  pair,
  rawValues
) {
  const candles =
    normalizeCandles(
      rawValues
    );

  if (!candles.length) {
    throw new Error(
      `${pair}: normalized candle set is empty`
    );
  }

  const record = {
    pair,
    candles,
    fetchedAt: Date.now(),
    lastCandle:
      candles[
        candles.length - 1
      ].time
  };

  pairCache.set(
    pair,
    record
  );

  return record;
}

/* =========================================================
   LOAD PAIR
========================================================= */

async function loadPair(
  pair
) {
  const cached =
    getCachedPair(pair);

  /*
   No cache:
   provider request required.
  */
  if (!cached) {
    const raw =
      await requestTwelveData(
        pair
      );

    return savePair(
      pair,
      raw
    );
  }

  /*
   IMPORTANT V9.2.1:
   Do not trust the 15-minute cache
   when its latest candle is old.
  */
  if (
    !pairNeedsRefresh(cached)
  ) {
    return cached;
  }

  /*
   Cached transport record exists,
   but market data is stale.

   Try to refresh from Twelve Data.
  */
  try {
    const raw =
      await requestTwelveData(
        pair
      );

    return savePair(
      pair,
      raw
    );
  } catch (error) {
    /*
     Stale-cache fallback.

     This is intentionally NOT presented as a
     valid trading signal. analyzeCandles()
     will mark it stale / hard stale.

     This protects the API from crashing when
     provider quota is temporarily unavailable.
    */
    if (
      error instanceof ProviderQuotaError
    ) {
      return cached;
    }

    /*
     For provider/network errors, stale data
     can still be used diagnostically.
    */
    return cached;
  }
}

/* =========================================================
   MATH HELPERS
========================================================= */

function average(values) {
  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / values.length
  );
}

function ema(values, period) {
  if (
    values.length <
    period
  ) {
    return null;
  }

  const multiplier =
    2 /
    (period + 1);

  let result =
    average(
      values.slice(
        0,
        period
      )
    );

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      (values[i] -
        result) *
        multiplier +
      result;
  }

  return result;
}

function rsi(
  values,
  period = 14
) {
  if (
    values.length <=
    period
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
      Math.max(diff, 0);

    const loss =
      Math.max(-diff, 0);

    avgGain =
      (avgGain *
        (period - 1) +
        gain) /
      period;

    avgLoss =
      (avgLoss *
        (period - 1) +
        loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 /
      (1 + rs)
  );
}

function trueRanges(
  candles
) {
  const values = [];

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

    values.push(tr);
  }

  return values;
}

function atr(
  candles,
  period = 14
) {
  const trs =
    trueRanges(
      candles
    );

  if (
    trs.length <
    period
  ) {
    return null;
  }

  return average(
    trs.slice(
      trs.length -
        period
    )
  );
}

function adx(
  candles,
  period = 14
) {
  if (
    candles.length <
    period + 2
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
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const upMove =
      current.high -
      previous.high;

    const downMove =
      previous.low -
      current.low;

    let plus = 0;
    let minus = 0;

    if (
      upMove > downMove &&
      upMove > 0
    ) {
      plus = upMove;
    }

    if (
      downMove > upMove &&
      downMove > 0
    ) {
      minus = downMove;
    }

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
    plusDM.push(plus);
    minusDM.push(minus);
  }

  if (
    trs.length <
    period
  ) {
    return null;
  }

  const atrValue =
    average(
      trs.slice(
        trs.length -
          period
      )
    );

  if (
    atrValue === 0
  ) {
    return 0;
  }

  const plusDI =
    100 *
    average(
      plusDM.slice(
        plusDM.length -
          period
      )
    ) /
    atrValue;

  const minusDI =
    100 *
    average(
      minusDM.slice(
        minusDM.length -
          period
      )
    ) /
    atrValue;

  const denominator =
    plusDI +
    minusDI;

  if (
    denominator === 0
  ) {
    return 0;
  }

  const dx =
    100 *
    Math.abs(
      plusDI -
        minusDI
    ) /
    denominator;

  return dx;
}

function stochastic(
  candles,
  period = 14
) {
  if (
    candles.length <
    period
  ) {
    return null;
  }

  const recent =
    candles.slice(
      candles.length -
        period
    );

  const highest =
    Math.max(
      ...recent.map(
        (x) => x.high
      )
    );

  const lowest =
    Math.min(
      ...recent.map(
        (x) => x.low
      )
    );

  const close =
    candles[
      candles.length - 1
    ].close;

  if (
    highest === lowest
  ) {
    return 50;
  }

  return (
    ((close - lowest) /
      (highest - lowest)) *
    100
  );
}

function bollinger(
  values,
  period = 20,
  multiplier = 2
) {
  if (
    values.length <
    period
  ) {
    return null;
  }

  const recent =
    values.slice(
      values.length -
        period
    );

  const middle =
    average(recent);

  const variance =
    average(
      recent.map(
        (value) =>
          Math.pow(
            value -
              middle,
            2
          )
      )
    );

  const deviation =
    Math.sqrt(
      variance
    );

  return {
    upper:
      middle +
      multiplier *
        deviation,
    middle,
    lower:
      middle -
      multiplier *
        deviation
  };
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
  candles
) {
  const recent =
    candles.slice(
      Math.max(
        0,
        candles.length - 30
      )
    );

  return {
    support: Math.min(
      ...recent.map(
        (x) => x.low
      )
    ),
    resistance: Math.max(
      ...recent.map(
        (x) => x.high
      )
    )
  };
}

/* =========================================================
   PRICE ACTION
========================================================= */

function priceAction(
  candles
) {
  if (
    candles.length <
    3
  ) {
    return 'NEUTRAL';
  }

  const last =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const body =
    last.close -
    last.open;

  const range =
    last.high -
    last.low;

  if (
    range <= 0
  ) {
    return 'NEUTRAL';
  }

  const bodyRatio =
    Math.abs(body) /
    range;

  if (
    body > 0 &&
    bodyRatio >= 0.6
  ) {
    return 'STRONG BULLISH CANDLE';
  }

  if (
    body < 0 &&
    bodyRatio >= 0.6
  ) {
    return 'STRONG BEARISH CANDLE';
  }

  if (
    last.close >
      previous.close &&
    body > 0
  ) {
    return 'BULLISH PRICE ACTION';
  }

  if (
    last.close <
      previous.close &&
    body < 0
  ) {
    return 'BEARISH PRICE ACTION';
  }

  return 'NEUTRAL PRICE ACTION';
}

/* =========================================================
   MARKET PSYCHOLOGY
========================================================= */

function marketPsychology(
  candles,
  ema9Value,
  ema21Value,
  rsiValue
) {
  if (
    ema9Value == null ||
    ema21Value == null ||
    rsiValue == null
  ) {
    return 'NEUTRAL';
  }

  if (
    ema9Value >
      ema21Value &&
    rsiValue >= 55
  ) {
    return 'BULLISH MOMENTUM';
  }

  if (
    ema9Value <
      ema21Value &&
    rsiValue <= 45
  ) {
    return 'BEARISH MOMENTUM';
  }

  if (
    rsiValue > 70
  ) {
    return 'OVERBOUGHT PRESSURE';
  }

  if (
    rsiValue < 30
  ) {
    return 'OVERSOLD PRESSURE';
  }

  return 'MIXED MARKET PSYCHOLOGY';
}

/* =========================================================
   FRESHNESS
========================================================= */

function getFreshness(
  ageSeconds,
  timeframe
) {
  if (
    !Number.isFinite(
      ageSeconds
    )
  ) {
    return 'HARD_STALE';
  }

  if (
    ageSeconds >
    HARD_STALE_SECONDS
  ) {
    return 'HARD_STALE';
  }

  const allowed =
    FRESHNESS_RULES[
      timeframe
    ] ||
    FRESHNESS_RULES[1];

  if (
    ageSeconds >
    allowed
  ) {
    return 'STALE';
  }

  return 'FRESH';
}

/* =========================================================
   ENTRY TIME
========================================================= */

function getNextEntryTime(
  timeframe
) {
  const now =
    new Date();

  const minutes =
    now.getUTCMinutes();

  const seconds =
    now.getUTCSeconds();

  const milliseconds =
    now.getUTCMilliseconds();

  const block =
    Math.floor(
      minutes /
        timeframe
    ) *
    timeframe;

  let entry =
    new Date(now);

  entry.setUTCMinutes(
    block,
    0,
    0
  );

  /*
   If the current boundary is too close,
   use the next boundary.
  */
  if (
    entry.getTime() -
      now.getTime() <
    MIN_ENTRY_SECONDS *
      1000
  ) {
    entry = new Date(
      entry.getTime() +
        timeframe *
          60 *
          1000
    );
  }

  return entry;
}

/* =========================================================
   ANALYSIS
========================================================= */

function analyzeCandles(
  pair,
  timeframe,
  baseCandles
) {
  const candles =
    aggregateCandles(
      baseCandles,
      timeframe
    );

  if (
    candles.length <
    60
  ) {
    throw new Error(
      `${pair}: insufficient candles for ${timeframe}m`
    );
  }

  const closes =
    candles.map(
      (x) => x.close
    );

  const currentPrice =
    closes[
      closes.length - 1
    ];

  const ema9Value =
    ema(closes, 9);

  const ema21Value =
    ema(closes, 21);

  const rsiValue =
    rsi(closes, 14);

  const adxValue =
    adx(candles, 14);

  const stochasticValue =
    stochastic(
      candles,
      14
    );

  const atrValue =
    atr(candles, 14);

  const bollingerValue =
    bollinger(
      closes,
      20,
      2
    );

  const sr =
    supportResistance(
      candles
    );

  const action =
    priceAction(
      candles
    );

  const psychology =
    marketPsychology(
      candles,
      ema9Value,
      ema21Value,
      rsiValue
    );

  if (
    ema9Value == null ||
    ema21Value == null ||
    rsiValue == null ||
    adxValue == null ||
    stochasticValue == null ||
    atrValue == null ||
    !bollingerValue
  ) {
    throw new Error(
      `${pair}: insufficient indicator data`
    );
  }

  const lastCandle =
    candles[
      candles.length - 1
    ];

  const dataAgeSeconds =
    getLastCandleAgeSeconds(
      candles
    );

  const freshness =
    getFreshness(
      dataAgeSeconds,
      timeframe
    );

  let callScore = 0;
  let putScore = 0;

  const reasons = [];

  /* EMA trend */

  if (
    ema9Value >
    ema21Value
  ) {
    callScore += 25;
    reasons.push(
      'EMA9 above EMA21'
    );
  } else if (
    ema9Value <
    ema21Value
  ) {
    putScore += 25;
    reasons.push(
      'EMA9 below EMA21'
    );
  }

  /* RSI */

  if (
    rsiValue >= 55 &&
    rsiValue < 70
  ) {
    callScore += 15;
    reasons.push(
      'RSI bullish momentum'
    );
  }

  if (
    rsiValue <= 45 &&
    rsiValue > 30
  ) {
    putScore += 15;
    reasons.push(
      'RSI bearish momentum'
    );
  }

  /* ADX */

  if (
    adxValue >= 25
  ) {
    if (
      ema9Value >
      ema21Value
    ) {
      callScore += 15;
      reasons.push(
        'ADX confirms trend strength'
      );
    } else if (
      ema9Value <
      ema21Value
    ) {
      putScore += 15;
      reasons.push(
        'ADX confirms trend strength'
      );
    }
  }

  /* Stochastic */

  if (
    stochasticValue >= 55 &&
    stochasticValue < 80
  ) {
    callScore += 10;
  }

  if (
    stochasticValue <= 45 &&
    stochasticValue > 20
  ) {
    putScore += 10;
  }

  /* Price action */

  if (
    action.includes(
      'BULLISH'
    )
  ) {
    callScore += 15;
    reasons.push(
      'Bullish price action'
    );
  }

  if (
    action.includes(
      'BEARISH'
    )
  ) {
    putScore += 15;
    reasons.push(
      'Bearish price action'
    );
  }

  /* Market psychology */

  if (
    psychology ===
    'BULLISH MOMENTUM'
  ) {
    callScore += 10;
    reasons.push(
      'Bullish market psychology'
    );
  }

  if (
    psychology ===
    'BEARISH MOMENTUM'
  ) {
    putScore += 10;
    reasons.push(
      'Bearish market psychology'
    );
  }

  /*
   Small support/resistance context.
  */

  if (
    currentPrice >
    sr.resistance
  ) {
    callScore += 5;
  }

  if (
    currentPrice <
    sr.support
  ) {
    putScore += 5;
  }

  const gap =
    Math.abs(
      callScore -
        putScore
    );

  let signal =
    'NO TRADE';

  let confidence = 40;

  if (
    callScore >= 65 &&
    callScore >
      putScore &&
    gap >= 15
  ) {
    signal = 'CALL';
    confidence =
      Math.min(
        95,
        60 +
          Math.round(
            gap * 0.5
          )
      );
  }

  if (
    putScore >= 65 &&
    putScore >
      callScore &&
    gap >= 15
  ) {
    signal = 'PUT';
    confidence =
      Math.min(
        95,
        60 +
          Math.round(
            gap * 0.5
          )
      );
  }

  /*
   Freshness protection.

   NEVER allow stale data to produce
   a tradable signal.
  */
  if (
    freshness !==
    'FRESH'
  ) {
    signal = 'NO TRADE';
    confidence = 40;
  }

  const entry =
    getNextEntryTime(
      timeframe
    );

  const entryInSeconds =
    Math.max(
      0,
      Math.floor(
        (entry.getTime() -
          Date.now()) /
          1000
      )
    );

  /*
   Entry protection.
  */
  if (
    entryInSeconds <
    MIN_ENTRY_SECONDS
  ) {
    signal = 'NO TRADE';
    confidence = 40;
  }

  const expiry =
    new Date(
      entry.getTime() +
        timeframe *
          60 *
          1000
    );

  /*
   Volatility classification.
  */
  let volatility =
    'MEDIUM';

  if (
    atrValue <
    currentPrice *
      0.0002
  ) {
    volatility = 'LOW';
  }

  if (
    atrValue >
    currentPrice *
      0.0007
  ) {
    volatility = 'HIGH';
  }

  const finalReasons =
    signal === 'NO TRADE'
      ? [
          'No sufficiently fresh valid signal available'
        ]
      : reasons.slice(
          0,
          8
        );

  return {
    pair,
    timeframe,
    signal,
    confidence,

    currentPrice,

    entryPrice:
      currentPrice,

    entryTime:
      entry.toISOString(),

    expiryTime:
      expiry.toISOString(),

    entryInSeconds,

    lastCandle:
      lastCandle.time,

    dataAgeSeconds:
      Math.round(
        dataAgeSeconds
      ),

    freshness,

    callScore,
    putScore,
    gap,

    volatility,

    indicators: {
      ema9:
        Number(
          ema9Value.toFixed(8)
        ),

      ema21:
        Number(
          ema21Value.toFixed(8)
        ),

      rsi14:
        Number(
          rsiValue.toFixed(2)
        ),

      adx14:
        Number(
          adxValue.toFixed(2)
        ),

      stochastic14:
        Number(
          stochasticValue.toFixed(2)
        ),

      atr14:
        Number(
          atrValue.toFixed(8)
        ),

      bollinger: {
        upper:
          Number(
            bollingerValue.upper.toFixed(
              8
            )
          ),

        middle:
          Number(
            bollingerValue.middle.toFixed(
              8
            )
          ),

        lower:
          Number(
            bollingerValue.lower.toFixed(
              8
            )
          )
      }
    },

    supportResistance: {
      support:
        Number(
          sr.support.toFixed(8)
        ),

      resistance:
        Number(
          sr.resistance.toFixed(8)
        )
    },

    priceAction:
      action,

    marketPsychology:
      psychology,

    reasons:
      finalReasons
  };
}

/* =========================================================
   ANALYZE PAIR
========================================================= */

async function analyzePair(
  pair
) {
  const pairData =
    await loadPair(pair);

  const markets = [];

  for (
    const timeframe of
    SUPPORTED_TIMEFRAMES
  ) {
    try {
      const result =
        analyzeCandles(
          pair,
          timeframe,
          pairData.candles
        );

      markets.push(
        result
      );

      resultCache.set(
        `${pair}:${timeframe}`,
        {
          result,
          cachedAt: Date.now()
        }
      );
    } catch (error) {
      /*
       One timeframe should not kill
       the entire pair.
      */
    }
  }

  if (!markets.length) {
    throw new Error(
      `${pair}: no timeframe analysis available`
    );
  }

  return markets;
}

/* =========================================================
   RESULT CACHE
========================================================= */

function getValidResultCache() {
  const results = [];

  for (
    const item of
    resultCache.values()
  ) {
    if (
      Date.now() -
        item.cachedAt >
      RESULT_CACHE_TTL_MS
    ) {
      continue;
    }

    const result =
      item.result;

    if (
      !result ||
      result.signal ===
        'NO TRADE'
    ) {
      continue;
    }

    if (
      result.freshness !==
      'FRESH'
    ) {
      continue;
    }

    if (
      result.entryInSeconds <
      MIN_ENTRY_SECONDS
    ) {
      continue;
    }

    results.push(
      result
    );
  }

  return results;
}

/* =========================================================
   CACHED DIAGNOSTICS
========================================================= */

function cachedDiagnosticMarkets() {
  const diagnostics = [];

  for (
    const cached of
    pairCache.values()
  ) {
    if (
      !cached ||
      !Array.isArray(
        cached.candles
      )
    ) {
      continue;
    }

    for (
      const timeframe of
      SUPPORTED_TIMEFRAMES
    ) {
      try {
        const result =
          analyzeCandles(
            cached.pair,
            timeframe,
            cached.candles
          );

        diagnostics.push(
          result
        );
      } catch (error) {
        /* ignore */
      }
    }
  }

  return diagnostics;
}

/* =========================================================
   RANKING
========================================================= */

function rankCandidates(
  markets
) {
  return markets
    .filter(
      (market) =>
        market.signal !==
          'NO TRADE' &&
        market.freshness ===
          'FRESH' &&
        market.entryInSeconds >=
          MIN_ENTRY_SECONDS
    )
    .sort(
      (a, b) => {
        if (
          b.confidence !==
          a.confidence
        ) {
          return (
            b.confidence -
            a.confidence
          );
        }

        return (
          b.gap -
          a.gap
        );
      }
    );
}

/* =========================================================
   SELECT BEST
========================================================= */

function selectDiagnostic(
  markets
) {
  if (!markets.length) {
    return null;
  }

  return markets.sort(
    (a, b) => {
      if (
        b.confidence !==
        a.confidence
      ) {
        return (
          b.confidence -
          a.confidence
        );
      }

      return (
        b.gap -
        a.gap
      );
    }
  )[0];
}

/* =========================================================
   SCAN BATCH
========================================================= */

async function scanBatch() {
  if (scanRunning) {
    return;
  }

  scanRunning = true;
  lastScanError = null;

  try {
    let processed = 0;

    while (
      processed <
        SCAN_BATCH_SIZE &&
      processed <
        PAIRS.length
    ) {
      const pair =
        PAIRS[
          scanCursor
        ];

      /*
       Do not enter provider request when
       minute safety limit is full.
      */
      const waitMs =
        getProviderWaitMs();

      if (
        waitMs > 0
      ) {
        break;
      }

      if (
        getDailyCreditsRemaining() <=
        0
      ) {
        break;
      }

      try {
        await analyzePair(
          pair
        );

        totalScanned += 1;
      } catch (error) {
        if (
          error instanceof
          ProviderQuotaError
        ) {
          /*
           Quota waiting is NOT a pair failure.
          */
          break;
        }

        totalFailed += 1;

        lastScanError =
          `${pair}: ${error.message}`;
      }

      scanCursor =
        (scanCursor + 1) %
        PAIRS.length;

      processed += 1;
    }

    lastScanAt =
      new Date().toISOString();
  } finally {
    scanRunning = false;
  }
}

/* =========================================================
   SCHEDULER
========================================================= */

function scheduleNextScan() {
  setTimeout(
    async () => {
      try {
        await scanBatch();
      } catch (error) {
        lastScanError =
          error.message;
      }

      scheduleNextScan();
    },
    SCAN_EVERY_MS
  );
}

/* =========================================================
   ENSURE USEFUL MARKET
========================================================= */

async function ensureUsefulMarket() {
  /*
   First use currently valid result cache.
  */
  const cached =
    getValidResultCache();

  if (
    cached.length
  ) {
    return;
  }

  /*
   If scanner is already running,
   do not create another scan.
  */
  if (scanRunning) {
    return;
  }

  /*
   Start one batch if quota allows.
  */
  if (
    getProviderWaitMs() === 0 &&
    getDailyCreditsRemaining() >
      0
  ) {
    await scanBatch();
  }
}

/* =========================================================
   METADATA
========================================================= */

function buildMetadata() {
  resetDailyIfNeeded();

  return {
    provider:
      'Twelve Data LIVE',

    interval:
      '1min',

    providerRequests:
      totalApiRequests,

    providerMinuteSafeLimit:
      PROVIDER_SAFE_LIMIT,

    providerMinuteHardLimit:
      PROVIDER_HARD_LIMIT,

    dailyCreditsUsed:
      dailyCreditsUsed,

    dailyCreditsRemaining:
      getDailyCreditsRemaining(),

    cachedPairs:
      pairCache.size,

    cachedResults:
      resultCache.size,

    resultCacheTtlSeconds:
      RESULT_CACHE_TTL_MS /
      1000,

    pairCacheTtlMinutes:
      PAIR_CACHE_TTL_MS /
      60000,

    /*
     New V9.2.1 metadata.
     Existing V9.1 frontend simply ignores
     fields it does not use.
    */
    pairRefreshMaxAgeSeconds:
      BASE_PAIR_REFRESH_MAX_AGE_SECONDS,

    entryBufferSeconds:
      ENTRY_BUFFER_SECONDS,

    freshnessRules:
      FRESHNESS_RULES,

    hardStaleSeconds:
      HARD_STALE_SECONDS
  };
}

/* =========================================================
   SCANNER INFO
========================================================= */

function buildScanner() {
  return {
    running:
      scanRunning,

    cursor:
      scanCursor,

    batchSize:
      SCAN_BATCH_SIZE,

    intervalSeconds:
      SCAN_EVERY_MS /
      1000,

    lastScanAt:
      lastScanAt,

    lastScanError:
      lastScanError,

    totalScanned:
      totalScanned,

    totalFailed:
      totalFailed,

    totalApiRequests:
      totalApiRequests
  };
}

/* =========================================================
   BEST MARKET
========================================================= */

async function getBestMarket() {
  await ensureUsefulMarket();

  const valid =
    getValidResultCache();

  const ranked =
    rankCandidates(
      valid
    );

  if (
    ranked.length
  ) {
    return {
      selectedMarket:
        ranked[0],

      rankedCandidates:
        ranked.slice(
          0,
          10
        )
    };
  }

  /*
   No valid fresh signal.
   Return diagnostic market so the V9.1 UI
   still has something meaningful to display.
  */
  const diagnostics =
    cachedDiagnosticMarkets();

  const diagnostic =
    selectDiagnostic(
      diagnostics
    );

  if (
    diagnostic
  ) {
    return {
      selectedMarket:
        {
          ...diagnostic,
          signal:
            'NO TRADE',
          confidence:
            40,
          reasons: [
            'No sufficiently fresh valid signal available'
          ]
        },

      rankedCandidates:
        []
    };
  }

  /*
   Absolute fallback.
  */
  return {
    selectedMarket: {
      pair:
        PAIRS[0],

      timeframe:
        1,

      signal:
        'NO TRADE',

      confidence:
        40,

      currentPrice:
        null,

      entryPrice:
        null,

      entryTime:
        null,

      expiryTime:
        null,

      entryInSeconds:
        0,

      lastCandle:
        null,

      dataAgeSeconds:
        null,

      freshness:
        'HARD_STALE',

      callScore:
        0,

      putScore:
        0,

      gap:
        0,

      volatility:
        'UNKNOWN',

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

      priceAction:
        'NEUTRAL',

      marketPsychology:
        'NEUTRAL',

      reasons: [
        'Waiting for live market data'
      ]
    },

    rankedCandidates:
      []
  };
}

/* =========================================================
   ROOT
========================================================= */

app.get(
  '/',
  (req, res) => {
    res.json({
      ok: true,
      name:
        'PO AI Predictor API',
      version:
        VERSION,
      source:
        'Twelve Data LIVE',
      message:
        'Backend is running'
    });
  }
);

/* =========================================================
   /api/best
========================================================= */

app.get(
  '/api/best',
  async (req, res) => {
    try {
      const result =
        await getBestMarket();

      res.json({
        ok: true,

        version:
          VERSION,

        source:
          'Twelve Data LIVE',

        timezone:
          'UTC',

        selectedMarket:
          result.selectedMarket,

        supportedTimeframes:
          SUPPORTED_TIMEFRAMES,

        pairs:
          PAIRS,

        metadata:
          buildMetadata(),

        scanner:
          buildScanner(),

        rankedCandidates:
          result.rankedCandidates
      });
    } catch (error) {
      res.status(200).json({
        ok: true,

        version:
          VERSION,

        source:
          'Twelve Data LIVE',

        timezone:
          'UTC',

        selectedMarket: {
          pair:
            PAIRS[0],

          timeframe:
            1,

          signal:
            'NO TRADE',

          confidence:
            40,

          currentPrice:
            null,

          entryPrice:
            null,

          entryTime:
            null,

          expiryTime:
            null,

          entryInSeconds:
            0,

          lastCandle:
            null,

          dataAgeSeconds:
            null,

          freshness:
            'HARD_STALE',

          callScore:
            0,

          putScore:
            0,

          gap:
            0,

          volatility:
            'UNKNOWN',

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

          priceAction:
            'NEUTRAL',

          marketPsychology:
            'NEUTRAL',

          reasons: [
            'Backend temporarily waiting for live data'
          ]
        },

        supportedTimeframes:
          SUPPORTED_TIMEFRAMES,

        pairs:
          PAIRS,

        metadata:
          buildMetadata(),

        scanner:
          buildScanner(),

        rankedCandidates:
          []
      });
    }
  }
);

/* =========================================================
   /api/health
========================================================= */

app.get(
  '/api/health',
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      source:
        'Twelve Data LIVE',

      timezone:
        'UTC',

      pairs:
        PAIRS.length,

      supportedTimeframes:
        SUPPORTED_TIMEFRAMES,

      cachedPairs:
        pairCache.size,

      cachedResults:
        resultCache.size,

      scanRunning:
        scanRunning,

      scanCursor:
        scanCursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      lastScanAt:
        lastScanAt,

      lastScanError:
        lastScanError,

      totalScanned:
        totalScanned,

      totalFailed:
        totalFailed,

      totalApiRequests:
        totalApiRequests,

      dailyCreditsUsed:
        dailyCreditsUsed,

      dailyCreditsRemaining:
        getDailyCreditsRemaining(),

      providerMinuteSafeLimit:
        PROVIDER_SAFE_LIMIT,

      providerMinuteHardLimit:
        PROVIDER_HARD_LIMIT,

      pairRefreshMaxAgeSeconds:
        BASE_PAIR_REFRESH_MAX_AGE_SECONDS,

      freshnessRules:
        FRESHNESS_RULES,

      hardStaleSeconds:
        HARD_STALE_SECONDS
    });
  }
);

/* =========================================================
   /api/analyze
========================================================= */

app.get(
  '/api/analyze',
  async (req, res) => {
    const pair =
      String(
        req.query.pair ||
          ''
      ).trim();

    if (
      !PAIRS.includes(pair)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Unsupported pair',
        supportedPairs:
          PAIRS
      });
    }

    try {
      const markets =
        await analyzePair(
          pair
        );

      const valid =
        rankCandidates(
          markets
        );

      res.json({
        ok: true,

        version:
          VERSION,

        source:
          'Twelve Data LIVE',

        timezone:
          'UTC',

        pair,

        markets,

        selectedMarket:
          valid[0] ||
          selectDiagnostic(
            markets
          ),

        metadata:
          buildMetadata(),

        scanner:
          buildScanner()
      });
    } catch (error) {
      res.status(200).json({
        ok: true,

        version:
          VERSION,

        source:
          'Twelve Data LIVE',

        timezone:
          'UTC',

        pair,

        markets: [],

        selectedMarket:
          null,

        metadata:
          buildMetadata(),

        scanner:
          buildScanner(),

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   STARTUP
========================================================= */

const server =
  app.listen(
    PORT,
    () => {
      console.log(
        `PO AI Predictor ${VERSION} listening on port ${PORT}`
      );

      console.log(
        `Provider: Twelve Data LIVE`
      );

      console.log(
        `Pairs: ${PAIRS.length}`
      );

      console.log(
        `Timeframes: ${SUPPORTED_TIMEFRAMES.join(', ')}`
      );

      console.log(
        `Provider safe limit: ${PROVIDER_SAFE_LIMIT}/minute`
      );

      console.log(
        `Daily usable credits: ${DAILY_USABLE_LIMIT}`
      );

      console.log(
        `Pair refresh max candle age: ${BASE_PAIR_REFRESH_MAX_AGE_SECONDS}s`
      );

      console.log(
        `Frontend contract: V9.1 compatible`
      );
    }
  );

/*
 Initial scan after startup.
*/
setTimeout(
  async () => {
    try {
      await scanBatch();
    } catch (error) {
      lastScanError =
        error.message;
    }
  },
  5000
);

/*
 Continue scanning every minute.
*/
scheduleNextScan();

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
  'unhandledRejection',
  (reason) => {
    console.error(
      'Unhandled rejection:',
      reason
    );
  }
);

process.on(
  'uncaughtException',
  (error) => {
    console.error(
      'Uncaught exception:',
      error
    );
  }
);

module.exports = app;
