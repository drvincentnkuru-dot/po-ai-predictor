'use strict';

/*
============================================================
 PO AI PREDICTOR
 BACKEND V9.2
 LIVE ONLY - TWELVE DATA

 SERVER-ONLY FIX FOR V9.1.1

 FIXES:
 - dailyCreditsRemaining scope bug fixed
 - Provider quota reservation is atomic
 - No false "failed pair" when provider quota is full
 - Rolling 60-second provider limit
 - Safe provider limit = 6 requests/minute
 - Hard provider limit = 7
 - Daily usable limit = 736
 - Scanner does not duplicate
 - Scanner pauses when quota slot is unavailable
 - Pair cache + result cache preserved
 - 1m / 2m / 3m supported
 - 2m / 3m candles aggregated locally
 - EMA9 / EMA21
 - RSI14
 - ADX14
 - Stochastic14
 - ATR14
 - Bollinger Bands
 - Support / Resistance
 - Candlestick price action
 - Market psychology from price action
 - NO MACD
 - NO CCI
 - Existing frontend response contract preserved
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

const VERSION = 'V9.2';
const SOURCE = 'Twelve Data LIVE';
const TIMEZONE = 'UTC';

const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || '';

const SOURCE_INTERVAL = '1min';

const MAX_CANDLES = 180;
const MIN_CANDLES = 60;

/* Provider protection */
const PROVIDER_HARD_LIMIT = 7;
const PROVIDER_SAFE_LIMIT = 6;
const PROVIDER_WINDOW_MS = 60 * 1000;
const PROVIDER_DELAY_MS = 1500;

/* Daily protection */
const DAILY_REQUEST_LIMIT = 768;
const DAILY_SAFETY_RESERVE = 32;
const DAILY_MAX_USABLE =
  DAILY_REQUEST_LIMIT - DAILY_SAFETY_RESERVE;

/* Cache */
const PAIR_CACHE_TTL_MS = 15 * 60 * 1000;
const RESULT_CACHE_TTL_MS = 30 * 1000;

/* Freshness */
const FRESHNESS_RULES = {
  1: 90,
  2: 150,
  3: 210
};

const HARD_STALE_SECONDS = 300;

/* Entry */
const ENTRY_BUFFER_SECONDS = 30;
const MIN_ENTRY_SECONDS = 30;

/* Scanner */
const SCAN_BATCH_SIZE = 6;
const SCAN_EVERY_MS = 60 * 1000;

/* Network */
const REQUEST_TIMEOUT_MS = 18000;

/* =========================================================
   PAIRS
========================================================= */

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

/* =========================================================
   STATE
========================================================= */

const pairCache = new Map();
const resultCache = new Map();

let scanCursor = 0;
let scanRunning = false;
let scanPromise = null;

let lastScanAt = null;
let lastScanError = null;

let totalScanned = 0;
let totalFailed = 0;
let totalApiRequests = 0;

let providerRequestTimes = [];

let dailyCreditsUsed = 0;
let dailyCounterDate = getUtcDateKey();

let providerQueue = Promise.resolve();

let nextScanTimer = null;

/* =========================================================
   TIME HELPERS
========================================================= */

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function getUtcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function resetDailyCounterIfNeeded() {
  const today = getUtcDateKey();

  if (today !== dailyCounterDate) {
    dailyCounterDate = today;
    dailyCreditsUsed = 0;
  }
}

function getDailyCreditsRemaining() {
  resetDailyCounterIfNeeded();

  return Math.max(
    0,
    DAILY_MAX_USABLE - dailyCreditsUsed
  );
}

function cleanProviderRequestTimes() {
  const cutoff = nowMs() - PROVIDER_WINDOW_MS;

  providerRequestTimes =
    providerRequestTimes.filter(
      (timestamp) => timestamp > cutoff
    );
}

function getProviderRequestsLastMinute() {
  cleanProviderRequestTimes();
  return providerRequestTimes.length;
}

/* =========================================================
   PROVIDER QUOTA
========================================================= */

/*
 IMPORTANT:

 We do NOT reserve provider quota outside the queue.

 This prevents multiple scanner operations from all seeing
 "6 slots available" and then racing into the same quota.
*/

function getProviderWaitMs() {
  cleanProviderRequestTimes();

  if (
    dailyCreditsUsed >= DAILY_MAX_USABLE
  ) {
    return Infinity;
  }

  if (
    providerRequestTimes.length <
    PROVIDER_SAFE_LIMIT
  ) {
    return 0;
  }

  const oldest =
    Math.min(...providerRequestTimes);

  const wait =
    oldest +
    PROVIDER_WINDOW_MS -
    nowMs();

  return Math.max(0, wait);
}

function reserveProviderRequest() {
  resetDailyCounterIfNeeded();
  cleanProviderRequestTimes();

  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      'TWELVE_DATA_API_KEY is not configured'
    );
  }

  if (
    dailyCreditsUsed >=
    DAILY_MAX_USABLE
  ) {
    throw new ProviderQuotaError(
      'Daily provider safety limit reached',
      Infinity
    );
  }

  if (
    providerRequestTimes.length >=
    PROVIDER_SAFE_LIMIT
  ) {
    const oldest =
      Math.min(...providerRequestTimes);

    const waitMs = Math.max(
      0,
      oldest +
        PROVIDER_WINDOW_MS -
        nowMs()
    );

    throw new ProviderQuotaError(
      'Provider safe minute limit reached',
      waitMs
    );
  }

  if (
    providerRequestTimes.length >=
    PROVIDER_HARD_LIMIT
  ) {
    throw new ProviderQuotaError(
      'Provider hard minute limit reached',
      0
    );
  }

  providerRequestTimes.push(nowMs());

  dailyCreditsUsed += 1;
  totalApiRequests += 1;
}

class ProviderQuotaError extends Error {
  constructor(message, waitMs = 0) {
    super(message);
    this.name = 'ProviderQuotaError';
    this.waitMs = waitMs;
    this.isQuotaWait = true;
  }
}

/*
 Queue is used for actual network operations.

 There is only one provider queue.
*/
function enqueueProviderRequest(task) {
  const run = providerQueue.then(
    async () => {
      await sleep(PROVIDER_DELAY_MS);
      return task();
    }
  );

  providerQueue = run.catch(() => {});

  return run;
}

/*
 This function DOES NOT wait one minute.

 It checks the current rolling quota atomically when
 the queued task reaches execution.
*/
function requestTwelveData(pair) {
  return enqueueProviderRequest(async () => {
    const waitMs = getProviderWaitMs();

    if (waitMs !== 0) {
      throw new ProviderQuotaError(
        'Provider safe minute limit reached',
        waitMs
      );
    }

    reserveProviderRequest();

    return fetchTwelveData(pair);
  });
}

/* =========================================================
   GENERIC HELPERS
========================================================= */

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor =
    Math.pow(10, decimals);

  return (
    Math.round(value * factor) /
    factor
  );
}

function isFiniteNumber(value) {
  return Number.isFinite(
    Number(value)
  );
}

function safeNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

/* =========================================================
   HTTP FETCH
========================================================= */

async function fetchJson(
  url,
  timeoutMs = REQUEST_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
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

    const text =
      await response.text();

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
        data?.message ||
          data?.code ||
          `Provider HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchTwelveData(pair) {
  const url =
    'https://api.twelvedata.com/time_series' +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=${SOURCE_INTERVAL}` +
    `&outputsize=${MAX_CANDLES}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(
      TWELVE_DATA_API_KEY
    )}`;

  const data =
    await fetchJson(url);

  if (
    data &&
    data.status === 'error'
  ) {
    throw new Error(
      data.message ||
        'Twelve Data provider error'
    );
  }

  if (
    !data ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      `${pair}: Twelve Data returned no candles`
    );
  }

  const candles =
    data.values
      .map((row) => ({
        time: parseProviderTime(
          row.datetime
        ),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close)
      }))
      .filter(
        (candle) =>
          Number.isFinite(
            candle.time
          ) &&
          Number.isFinite(
            candle.open
          ) &&
          Number.isFinite(
            candle.high
          ) &&
          Number.isFinite(
            candle.low
          ) &&
          Number.isFinite(
            candle.close
          )
      )
      .sort(
        (a, b) =>
          a.time - b.time
      );

  if (
    candles.length <
    MIN_CANDLES
  ) {
    throw new Error(
      `${pair}: insufficient candles (${candles.length})`
    );
  }

  return {
    pair,
    candles: candles.slice(
      -MAX_CANDLES
    ),
    fetchedAt: nowMs()
  };
}

function parseProviderTime(value) {
  if (!value) {
    return NaN;
  }

  const normalized =
    String(value).includes('T')
      ? String(value)
      : String(value).replace(
          ' ',
          'T'
        );

  const timestamp = Date.parse(
    normalized.endsWith('Z')
      ? normalized
      : `${normalized}Z`
  );

  return timestamp;
}

/* =========================================================
   LOCAL TIMEFRAME AGGREGATION
========================================================= */

function aggregateCandles(
  candles,
  timeframe
) {
  if (timeframe === 1) {
    return candles.slice();
  }

  const bucketMs =
    timeframe *
    60 *
    1000;

  const groups = new Map();

  for (const candle of candles) {
    const bucket =
      Math.floor(
        candle.time / bucketMs
      ) * bucketMs;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups
      .get(bucket)
      .push(candle);
  }

  const result = [];

  for (
    const [bucket, rows]
    of groups.entries()
  ) {
    if (!rows.length) {
      continue;
    }

    const first = rows[0];
    const last =
      rows[rows.length - 1];

    result.push({
      time: bucket,
      open: first.open,
      high: Math.max(
        ...rows.map(
          (x) => x.high
        )
      ),
      low: Math.min(
        ...rows.map(
          (x) => x.low
        )
      ),
      close: last.close
    });
  }

  return result.sort(
    (a, b) =>
      a.time - b.time
  );
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(values, period) {
  if (
    values.length <
    period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let previous = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    previous += values[i];
  }

  previous /= period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    previous =
      (values[i] -
        previous) *
        multiplier +
      previous;
  }

  return previous;
}

function sma(values, period) {
  if (
    values.length <
    period
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

function calculateRSI(
  closes,
  period = 14
) {
  if (
    closes.length <= period
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
    const change =
      closes[i] -
      closes[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < closes.length;
    i++
  ) {
    const change =
      closes[i] -
      closes[i - 1];

    const gain =
      Math.max(change, 0);

    const loss =
      Math.max(-change, 0);

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
    100 / (1 + rs)
  );
}

function calculateTR(candles) {
  const tr = [];

  for (
    let i = 0;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    if (i === 0) {
      tr.push(
        current.high -
          current.low
      );
      continue;
    }

    const previous =
      candles[i - 1];

    tr.push(
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
      )
    );
  }

  return tr;
}

function calculateATR(
  candles,
  period = 14
) {
  const tr =
    calculateTR(candles);

  if (
    tr.length <
    period
  ) {
    return null;
  }

  return sma(tr, period);
}

function calculateADX(
  candles,
  period = 14
) {
  if (
    candles.length <
    period * 2
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

    const trueRange =
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

    trs.push(trueRange);

    plusDM.push(
      upMove > downMove &&
      upMove > 0
        ? upMove
        : 0
    );

    minusDM.push(
      downMove > upMove &&
      downMove > 0
        ? downMove
        : 0
    );
  }

  const dx = [];

  for (
    let i = period;
    i <= trs.length;
    i++
  ) {
    const trSlice =
      trs.slice(
        i - period,
        i
      );

    const plusSlice =
      plusDM.slice(
        i - period,
        i
      );

    const minusSlice =
      minusDM.slice(
        i - period,
        i
      );

    const atrValue =
      trSlice.reduce(
        (a, b) =>
          a + b,
        0
      ) / period;

    if (atrValue === 0) {
      dx.push(0);
      continue;
    }

    const plus =
      plusSlice.reduce(
        (a, b) =>
          a + b,
        0
      ) / atrValue *
      100;

    const minus =
      minusSlice.reduce(
        (a, b) =>
          a + b,
        0
      ) / atrValue *
      100;

    const denominator =
      plus + minus;

    const currentDx =
      denominator === 0
        ? 0
        : Math.abs(
            plus - minus
          ) /
            denominator *
            100;

    dx.push(currentDx);
  }

  if (
    dx.length <
    period
  ) {
    return null;
  }

  return sma(dx, period);
}

function calculateStochastic(
  candles,
  period = 14
) {
  if (
    candles.length <
    period
  ) {
    return null;
  }

  const slice =
    candles.slice(-period);

  const highest =
    Math.max(
      ...slice.map(
        (c) => c.high
      )
    );

  const lowest =
    Math.min(
      ...slice.map(
        (c) => c.low
      )
    );

  const close =
    slice[
      slice.length - 1
    ].close;

  if (
    highest === lowest
  ) {
    return 50;
  }

  return (
    (close - lowest) /
      (highest - lowest) *
    100
  );
}

function calculateBollinger(
  closes,
  period = 20,
  multiplier = 2
) {
  if (
    closes.length <
    period
  ) {
    return null;
  }

  const slice =
    closes.slice(-period);

  const middle =
    slice.reduce(
      (a, b) =>
        a + b,
      0
    ) / period;

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

  const deviation =
    Math.sqrt(variance);

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

function calculateSupportResistance(
  candles,
  lookback = 30
) {
  const slice =
    candles.slice(-lookback);

  if (!slice.length) {
    return {
      support: null,
      resistance: null
    };
  }

  return {
    support: Math.min(
      ...slice.map(
        (c) => c.low
      )
    ),
    resistance: Math.max(
      ...slice.map(
        (c) => c.high
      )
    )
  };
}

/* =========================================================
   PRICE ACTION
========================================================= */

function getCandlePattern(
  candles
) {
  if (
    candles.length <
    3
  ) {
    return {
      pattern: 'NO VALID SIGNAL',
      bullish: false,
      bearish: false
    };
  }

  const c =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const body =
    Math.abs(
      c.close - c.open
    );

  const range =
    c.high - c.low;

  if (range <= 0) {
    return {
      pattern: 'NEUTRAL CANDLE',
      bullish: false,
      bearish: false
    };
  }

  const upperWick =
    c.high -
    Math.max(
      c.open,
      c.close
    );

  const lowerWick =
    Math.min(
      c.open,
      c.close
    ) - c.low;

  const bullish =
    c.close > c.open;

  const bearish =
    c.close < c.open;

  const strongBody =
    body / range >= 0.65;

  if (
    bullish &&
    strongBody
  ) {
    return {
      pattern:
        'STRONG BULLISH CANDLE',
      bullish: true,
      bearish: false
    };
  }

  if (
    bearish &&
    strongBody
  ) {
    return {
      pattern:
        'STRONG BEARISH CANDLE',
      bullish: false,
      bearish: true
    };
  }

  if (
    bullish &&
    lowerWick >
      body * 1.5
  ) {
    return {
      pattern:
        'BULLISH REJECTION',
      bullish: true,
      bearish: false
    };
  }

  if (
    bearish &&
    upperWick >
      body * 1.5
  ) {
    return {
      pattern:
        'BEARISH REJECTION',
      bullish: false,
      bearish: true
    };
  }

  if (
    previous.close <
      previous.open &&
    bullish &&
    c.close >
      previous.open
  ) {
    return {
      pattern:
        'BULLISH ENGULFING',
      bullish: true,
      bearish: false
    };
  }

  if (
    previous.close >
      previous.open &&
    bearish &&
    c.close <
      previous.open
  ) {
    return {
      pattern:
        'BEARISH ENGULFING',
      bullish: false,
      bearish: true
    };
  }

  return {
    pattern: 'NEUTRAL PRICE ACTION',
    bullish: false,
    bearish: false
  };
}

/* =========================================================
   MARKET PSYCHOLOGY
========================================================= */

function getMarketPsychology(
  candles,
  ema9,
  ema21,
  rsi,
  adx,
  pattern
) {
  if (
    !Number.isFinite(ema9) ||
    !Number.isFinite(ema21)
  ) {
    return 'INSUFFICIENT DATA';
  }

  if (
    ema9 > ema21 &&
    pattern.bullish &&
    Number.isFinite(adx) &&
    adx >= 20
  ) {
    return 'BULLISH MOMENTUM';
  }

  if (
    ema9 < ema21 &&
    pattern.bearish &&
    Number.isFinite(adx) &&
    adx >= 20
  ) {
    return 'BEARISH MOMENTUM';
  }

  if (
    Number.isFinite(rsi) &&
    rsi >= 70
  ) {
    return 'OVERBOUGHT PRESSURE';
  }

  if (
    Number.isFinite(rsi) &&
    rsi <= 30
  ) {
    return 'OVERSOLD PRESSURE';
  }

  return 'MIXED MARKET PRESSURE';
}

/* =========================================================
   FRESHNESS
========================================================= */

function getDataAgeSeconds(
  lastCandle
) {
  if (
    !Number.isFinite(
      lastCandle
    )
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.floor(
      (nowMs() -
        lastCandle) /
        1000
    )
  );
}

function getFreshness(
  timeframe,
  ageSeconds
) {
  if (
    !Number.isFinite(
      ageSeconds
    )
  ) {
    return 'NO_DATA';
  }

  if (
    ageSeconds <=
    FRESHNESS_RULES[
      timeframe
    ]
  ) {
    return 'FRESH';
  }

  if (
    ageSeconds <=
    HARD_STALE_SECONDS
  ) {
    return 'STALE';
  }

  return 'HARD_STALE';
}

/* =========================================================
   ENTRY
========================================================= */

function getNextEntryTime(
  timeframe
) {
  const now =
    nowMs();

  const intervalMs =
    timeframe *
    60 *
    1000;

  /*
   Entry is the next timeframe boundary.
  */
  return (
    Math.floor(
      now / intervalMs
    ) *
      intervalMs +
    intervalMs
  );
}

/* =========================================================
   ANALYZE CANDLES
========================================================= */

function analyzeCandles(
  pair,
  timeframe,
  candles
) {
  if (
    candles.length <
    MIN_CANDLES
  ) {
    throw new Error(
      `${pair}: insufficient ${timeframe}m candles`
    );
  }

  const closes =
    candles.map(
      (c) => c.close
    );

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const rsi14 =
    calculateRSI(
      closes,
      14
    );

  const adx14 =
    calculateADX(
      candles,
      14
    );

  const stochastic14 =
    calculateStochastic(
      candles,
      14
    );

  const atr14 =
    calculateATR(
      candles,
      14
    );

  const bollinger =
    calculateBollinger(
      closes,
      20,
      2
    );

  const supportResistance =
    calculateSupportResistance(
      candles,
      30
    );

  const pattern =
    getCandlePattern(
      candles
    );

  const psychology =
    getMarketPsychology(
      candles,
      ema9,
      ema21,
      rsi14,
      adx14,
      pattern
    );

  const currentPrice =
    candles[
      candles.length - 1
    ].close;

  let callScore = 0;
  let putScore = 0;

  const reasonsCall = [];
  const reasonsPut = [];

  /* EMA */
  if (
    Number.isFinite(ema9) &&
    Number.isFinite(ema21)
  ) {
    if (ema9 > ema21) {
      callScore += 20;
      reasonsCall.push(
        'EMA bullish'
      );
    } else if (
      ema9 < ema21
    ) {
      putScore += 20;
      reasonsPut.push(
        'EMA bearish'
      );
    }
  }

  /* RSI */
  if (
    Number.isFinite(rsi14)
  ) {
    if (
      rsi14 >= 52 &&
      rsi14 < 70
    ) {
      callScore += 15;
      reasonsCall.push(
        'RSI supports CALL'
      );
    } else if (
      rsi14 <= 48 &&
      rsi14 > 30
    ) {
      putScore += 15;
      reasonsPut.push(
        'RSI supports PUT'
      );
    }
  }

  /* ADX */
  if (
    Number.isFinite(adx14) &&
    adx14 >= 20
  ) {
    if (
      ema9 > ema21
    ) {
      callScore += 15;
      reasonsCall.push(
        'ADX confirms trend'
      );
    } else if (
      ema9 < ema21
    ) {
      putScore += 15;
      reasonsPut.push(
        'ADX confirms trend'
      );
    }
  }

  /* Stochastic */
  if (
    Number.isFinite(
      stochastic14
    )
  ) {
    if (
      stochastic14 >= 50 &&
      stochastic14 < 85
    ) {
      callScore += 10;
      reasonsCall.push(
        'Stochastic supports CALL'
      );
    } else if (
      stochastic14 <= 50 &&
      stochastic14 > 15
    ) {
      putScore += 10;
      reasonsPut.push(
        'Stochastic supports PUT'
      );
    }
  }

  /* Price action */
  if (
    pattern.bullish
  ) {
    callScore += 15;
    reasonsCall.push(
      pattern.pattern
    );
  }

  if (
    pattern.bearish
  ) {
    putScore += 15;
    reasonsPut.push(
      pattern.pattern
    );
  }

  /* Bollinger */
  if (
    bollinger
  ) {
    if (
      currentPrice >
      bollinger.middle &&
      currentPrice <
      bollinger.upper
    ) {
      callScore += 5;
    }

    if (
      currentPrice <
      bollinger.middle &&
      currentPrice >
      bollinger.lower
    ) {
      putScore += 5;
    }
  }

  /* Market psychology */
  if (
    psychology ===
    'BULLISH MOMENTUM'
  ) {
    callScore += 10;
    reasonsCall.push(
      'BULLISH MOMENTUM'
    );
  }

  if (
    psychology ===
    'BEARISH MOMENTUM'
  ) {
    putScore += 10;
    reasonsPut.push(
      'BEARISH MOMENTUM'
    );
  }

  callScore = clamp(
    Math.round(callScore),
    0,
    100
  );

  putScore = clamp(
    Math.round(putScore),
    0,
    100
  );

  const gap =
    Math.abs(
      callScore -
        putScore
    );

  let signal =
    'NO TRADE';

  let confidence = 40;
  let reasons = [
    'No sufficiently fresh valid signal available'
  ];

  if (
    callScore >= 65 &&
    callScore > putScore &&
    gap >= 15
  ) {
    signal = 'CALL';
    confidence = clamp(
      callScore,
      0,
      100
    );
    reasons =
      reasonsCall;
  } else if (
    putScore >= 65 &&
    putScore > callScore &&
    gap >= 15
  ) {
    signal = 'PUT';
    confidence = clamp(
      putScore,
      0,
      100
    );
    reasons =
      reasonsPut;
  }

  const lastCandle =
    candles[
      candles.length - 1
    ].time;

  const dataAgeSeconds =
    getDataAgeSeconds(
      lastCandle
    );

  const freshness =
    getFreshness(
      timeframe,
      dataAgeSeconds
    );

  const entryTime =
    getNextEntryTime(
      timeframe
    );

  const entryInSeconds =
    Math.max(
      0,
      Math.floor(
        (entryTime -
          nowMs()) /
          1000
      )
    );

  /*
   A signal is invalid if data is not fresh
   or if the next entry is too close.
  */
  if (
    freshness !==
      'FRESH' ||
    entryInSeconds <
      MIN_ENTRY_SECONDS
  ) {
    signal = 'NO TRADE';
    confidence = 40;

    if (
      freshness !==
      'FRESH'
    ) {
      reasons = [
        'No sufficiently fresh valid signal available'
      ];
    } else {
      reasons = [
        'Entry window too close'
      ];
    }
  }

  const expiryTime =
    entryTime +
    timeframe *
      60 *
      1000;

  let volatility =
    'LOW';

  if (
    Number.isFinite(
      atr14
    ) &&
    currentPrice > 0
  ) {
    const atrPercent =
      (atr14 /
        currentPrice) *
      100;

    if (
      atrPercent >= 0.08
    ) {
      volatility =
        'HIGH';
    } else if (
      atrPercent >= 0.03
    ) {
      volatility =
        'MEDIUM';
    }
  }

  return {
    pair,
    timeframe,
    signal,
    confidence,

    currentPrice:
      round(
        currentPrice,
        6
      ),

    entryPrice:
      round(
        currentPrice,
        6
      ),

    entryTime:
      new Date(
        entryTime
      ).toISOString(),

    expiryTime:
      new Date(
        expiryTime
      ).toISOString(),

    entryInSeconds,

    lastCandle:
      new Date(
        lastCandle
      ).toISOString(),

    dataAgeSeconds,

    freshness,

    callScore,
    putScore,
    gap,

    volatility,

    indicators: {
      ema9:
        round(
          ema9,
          8
        ),
      ema21:
        round(
          ema21,
          8
        ),
      rsi14:
        round(
          rsi14,
          2
        ),
      adx14:
        round(
          adx14,
          2
        ),
      stochastic14:
        round(
          stochastic14,
          2
        ),
      atr14:
        round(
          atr14,
          8
        ),
      bollinger:
        bollinger
          ? {
              upper:
                round(
                  bollinger.upper,
                  8
                ),
              middle:
                round(
                  bollinger.middle,
                  8
                ),
              lower:
                round(
                  bollinger.lower,
                  8
                )
            }
          : null
    },

    supportResistance: {
      support:
        round(
          supportResistance.support,
          6
        ),
      resistance:
        round(
          supportResistance.resistance,
          6
        )
    },

    priceAction:
      pattern.pattern,

    marketPsychology:
      psychology,

    reasons:
      reasons.length
        ? reasons
        : [
            'No sufficiently fresh valid signal available'
          ]
  };
}

/* =========================================================
   PAIR CACHE
========================================================= */

function getCachedPair(pair) {
  const cached =
    pairCache.get(pair);

  if (!cached) {
    return null;
  }

  if (
    nowMs() -
      cached.fetchedAt >
    PAIR_CACHE_TTL_MS
  ) {
    pairCache.delete(pair);
    return null;
  }

  return cached;
}

async function loadPair(pair) {
  const cached =
    getCachedPair(pair);

  if (cached) {
    return cached;
  }

  const fresh =
    await requestTwelveData(
      pair
    );

  pairCache.set(
    pair,
    fresh
  );

  return fresh;
}

/* =========================================================
   RESULT CACHE
========================================================= */

function resultCacheKey(
  pair,
  timeframe
) {
  return `${pair}|${timeframe}`;
}

function setResultCache(
  result
) {
  resultCache.set(
    resultCacheKey(
      result.pair,
      result.timeframe
    ),
    {
      storedAt: nowMs(),
      result
    }
  );
}

function getResultCache(
  pair,
  timeframe
) {
  const cached =
    resultCache.get(
      resultCacheKey(
        pair,
        timeframe
      )
    );

  if (!cached) {
    return null;
  }

  if (
    nowMs() -
      cached.storedAt >
    RESULT_CACHE_TTL_MS
  ) {
    resultCache.delete(
      resultCacheKey(
        pair,
        timeframe
      )
    );

    return null;
  }

  return cached.result;
}

function getValidResultCache() {
  const candidates = [];

  for (
    const [key, cached]
    of resultCache.entries()
  ) {
    if (
      nowMs() -
        cached.storedAt >
      RESULT_CACHE_TTL_MS
    ) {
      resultCache.delete(key);
      continue;
    }

    const result =
      cached.result;

    if (
      result.signal !==
        'CALL' &&
      result.signal !==
        'PUT'
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
      !Number.isFinite(
        result.entryInSeconds
      ) ||
      result.entryInSeconds <
        MIN_ENTRY_SECONDS
    ) {
      continue;
    }

    candidates.push(
      result
    );
  }

  return candidates;
}

/* =========================================================
   ANALYZE PAIR
========================================================= */

async function analyzePair(
  pair
) {
  const pairData =
    await loadPair(pair);

  const results = [];

  for (
    const timeframe
    of TIMEFRAMES
  ) {
    const candles =
      aggregateCandles(
        pairData.candles,
        timeframe
      );

    if (
      candles.length <
      MIN_CANDLES
    ) {
      continue;
    }

    const result =
      analyzeCandles(
        pair,
        timeframe,
        candles
      );

    setResultCache(result);

    results.push(result);
  }

  return results;
}

/* =========================================================
   RANKING
========================================================= */

function candidateRank(
  result
) {
  if (
    !result ||
    (result.signal !==
      'CALL' &&
      result.signal !==
        'PUT')
  ) {
    return -Infinity;
  }

  let score =
    result.confidence * 2;

  score +=
    result.gap;

  if (
    result.freshness ===
    'FRESH'
  ) {
    score += 30;
  }

  if (
    result.entryInSeconds >=
    45
  ) {
    score += 10;
  }

  if (
    result.timeframe === 1
  ) {
    score += 4;
  }

  if (
    result.timeframe === 2
  ) {
    score += 6;
  }

  if (
    result.timeframe === 3
  ) {
    score += 5;
  }

  return score;
}

function rankCandidates(
  candidates
) {
  return candidates
    .filter(
      (candidate) =>
        candidate &&
        candidate.signal !==
          'NO TRADE'
    )
    .sort(
      (a, b) =>
        candidateRank(b) -
        candidateRank(a)
    );
}

/* =========================================================
   DIAGNOSTIC MARKET
========================================================= */

function buildNoDataMarket() {
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
    freshness: 'NO_DATA',
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
      bollinger: null
    },

    supportResistance: {
      support: null,
      resistance: null
    },

    priceAction:
      'NO VALID SIGNAL',

    marketPsychology:
      'No sufficiently fresh market data',

    reasons: [
      'No sufficiently fresh valid signal available'
    ]
  };
}

function cachedDiagnosticMarkets() {
  const markets = [];

  for (
    const pair of PAIRS
  ) {
    const pairData =
      getCachedPair(pair);

    if (!pairData) {
      continue;
    }

    for (
      const timeframe
      of TIMEFRAMES
    ) {
      try {
        const candles =
          aggregateCandles(
            pairData.candles,
            timeframe
          );

        if (
          candles.length <
          MIN_CANDLES
        ) {
          continue;
        }

        markets.push(
          analyzeCandles(
            pair,
            timeframe,
            candles
          )
        );
      } catch {
        /* diagnostic only */
      }
    }
  }

  return markets;
}

/* =========================================================
   SCANNER
========================================================= */

function quotaWaitMessage(
  waitMs
) {
  if (
    waitMs === Infinity
  ) {
    return 'Daily provider safety limit reached';
  }

  const seconds =
    Math.max(
      1,
      Math.ceil(
        waitMs / 1000
      )
    );

  return `Provider quota slot unavailable; retry in ${seconds}s`;
}

async function scanBatch() {
  if (scanRunning) {
    return scanPromise;
  }

  scanRunning = true;

  scanPromise =
    (async () => {
      let scannedThisBatch = 0;
      let failedThisBatch = 0;

      let lastError = null;

      try {
        const batch = [];

        for (
          let i = 0;
          i < SCAN_BATCH_SIZE;
          i++
        ) {
          const index =
            (scanCursor + i) %
            PAIRS.length;

          batch.push(
            PAIRS[index]
          );
        }

        for (
          const pair of batch
        ) {
          /*
           Before starting a new pair, check quota.
           If no slot exists, PAUSE the scanner.
           This is NOT a pair failure.
          */
          const waitMs =
            getProviderWaitMs();

          if (
            waitMs !== 0
          ) {
            lastError =
              quotaWaitMessage(
                waitMs
              );

            break;
          }

          try {
            await analyzePair(
              pair
            );

            totalScanned += 1;
            scannedThisBatch += 1;

            scanCursor =
              (
                scanCursor +
                1
              ) %
              PAIRS.length;
          } catch (error) {
            if (
              error instanceof
              ProviderQuotaError
            ) {
              /*
               Quota wait is not a pair failure.
              */
              lastError =
                quotaWaitMessage(
                  error.waitMs
                );

              break;
            }

            totalFailed += 1;
            failedThisBatch += 1;

            lastError =
              `${pair}: ${
                error.message ||
                'Unknown scanner error'
              }`;

            /*
             The pair failed for a real reason,
             so move cursor forward.
            */
            scanCursor =
              (
                scanCursor +
                1
              ) %
              PAIRS.length;
          }
        }

        lastScanAt =
          nowIso();

        /*
         Only record real errors.
         A quota pause is informational.
        */
        if (
          lastError &&
          lastError.startsWith(
            'Provider quota slot unavailable'
          )
        ) {
          lastScanError =
            lastError;
        } else if (
          lastError
        ) {
          lastScanError =
            lastError;
        } else {
          lastScanError =
            null;
        }

        return {
          scannedThisBatch,
          failedThisBatch,
          lastError
        };
      } finally {
        scanRunning = false;
        scanPromise = null;
      }
    })();

  return scanPromise;
}

/* =========================================================
   SCHEDULE NEXT SCAN
========================================================= */

function scheduleNextScan(
  delay = SCAN_EVERY_MS
) {
  if (nextScanTimer) {
    clearTimeout(
      nextScanTimer
    );
  }

  nextScanTimer =
    setTimeout(
      async () => {
        nextScanTimer = null;

        try {
          await scanBatch();
        } catch (error) {
          lastScanError =
            error.message ||
            'Scanner error';
        }

        scheduleNextScan(
          SCAN_EVERY_MS
        );
      },
      delay
    );
}

/* =========================================================
   BEST MARKET
========================================================= */

async function ensureUsefulMarket() {
  /*
   First use valid fresh result cache.
  */
  let candidates =
    getValidResultCache();

  if (candidates.length) {
    return rankCandidates(
      candidates
    );
  }

  /*
   If scanner is already running, wait for it.
  */
  if (scanRunning) {
    try {
      await scanPromise;
    } catch {
      /* handled below */
    }

    candidates =
      getValidResultCache();

    if (candidates.length) {
      return rankCandidates(
        candidates
      );
    }
  }

  /*
   Run one batch immediately when there is
   a provider slot available.
  */
  const waitMs =
    getProviderWaitMs();

  if (
    waitMs === 0
  ) {
    try {
      await scanBatch();
    } catch (error) {
      lastScanError =
        error.message ||
        'Scanner error';
    }
  } else {
    /*
     Do not wait 60+ seconds inside /api/best.
     Scanner will retry on its normal schedule.
    */
    lastScanError =
      quotaWaitMessage(
        waitMs
      );
  }

  candidates =
    getValidResultCache();

  return rankCandidates(
    candidates
  );
}

/* =========================================================
   RESPONSE
========================================================= */

function makeResponse(
  selectedMarket,
  rankedCandidates
) {
  const selected =
    selectedMarket ||
    buildNoDataMarket();

  resetDailyCounterIfNeeded();

  return {
    ok: true,

    version: VERSION,

    source: SOURCE,

    timezone: TIMEZONE,

    selectedMarket: selected,

    supportedTimeframes:
      TIMEFRAMES,

    pairs: PAIRS,

    metadata: {
      provider:
        SOURCE,

      interval:
        SOURCE_INTERVAL,

      providerRequests:
        getProviderRequestsLastMinute(),

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

      entryBufferSeconds:
        ENTRY_BUFFER_SECONDS,

      freshnessRules:
        FRESHNESS_RULES,

      hardStaleSeconds:
        HARD_STALE_SECONDS
    },

    scanner: {
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
    },

    rankedCandidates:
      rankedCandidates || []
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
      timezone: TIMEZONE
    });
  }
);

/* ---------------------------------------------------------
   HEALTH
--------------------------------------------------------- */

app.get(
  '/api/health',
  (req, res) => {
    resetDailyCounterIfNeeded();

    res.json(
      makeResponse(
        null,
        []
      )
    );
  }
);

/* ---------------------------------------------------------
   BEST
--------------------------------------------------------- */

app.get(
  '/api/best',
  async (req, res) => {
    try {
      const candidates =
        await ensureUsefulMarket();

      let selected =
        candidates.length
          ? candidates[0]
          : null;

      /*
       If there is no valid CALL/PUT candidate,
       try cached diagnostic data so frontend still
       receives useful market state.
      */
      if (!selected) {
        const diagnostics =
          cachedDiagnosticMarkets();

        if (
          diagnostics.length
        ) {
          diagnostics.sort(
            (a, b) =>
              (
                (b.freshness ===
                'FRESH'
                  ? 1
                  : 0) -
                (a.freshness ===
                'FRESH'
                  ? 1
                  : 0)
              ) ||
              (
                b.confidence -
                a.confidence
              )
          );

          selected =
            diagnostics[0];
        }
      }

      res.json(
        makeResponse(
          selected,
          candidates
        )
      );
    } catch (error) {
      lastScanError =
        error.message ||
        'Best-market error';

      res.json(
        makeResponse(
          null,
          []
        )
      );
    }
  }
);

/* ---------------------------------------------------------
   ANALYZE
--------------------------------------------------------- */

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
          'Unsupported currency pair',
        supportedPairs:
          PAIRS
      });
    }

    try {
      const cachedResults =
        TIMEFRAMES.map(
          (timeframe) =>
            getResultCache(
              pair,
              timeframe
            )
        ).filter(Boolean);

      if (
        cachedResults.length ===
        TIMEFRAMES.length
      ) {
        return res.json({
          ok: true,
          version: VERSION,
          source: SOURCE,
          timezone: TIMEZONE,
          pair,
          results:
            cachedResults
        });
      }

      const results =
        await analyzePair(
          pair
        );

      res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        timezone: TIMEZONE,
        pair,
        results
      });
    } catch (error) {
      if (
        error instanceof
        ProviderQuotaError
      ) {
        return res.status(429).json({
          ok: false,
          error:
            quotaWaitMessage(
              error.waitMs
            ),
          retryAfterSeconds:
            error.waitMs === Infinity
              ? null
              : Math.ceil(
                  error.waitMs /
                    1000
                )
        });
      }

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          'Analyze failed'
      });
    }
  }
);

/* =========================================================
   STARTUP
========================================================= */

function startBackgroundScanner() {
  /*
   Small startup delay gives Render time to start
   before first provider request.
  */
  setTimeout(
    async () => {
      try {
        await scanBatch();
      } catch (error) {
        lastScanError =
          error.message ||
          'Initial scanner error';
      }

      scheduleNextScan(
        SCAN_EVERY_MS
      );
    },
    5000
  );
}

app.listen(
  PORT,
  () => {
    console.log(
      `PO AI Predictor ${VERSION} listening on port ${PORT}`
    );

    console.log(
      `Source: ${SOURCE}`
    );

    console.log(
      `Pairs: ${PAIRS.length}`
    );

    console.log(
      `Timeframes: ${TIMEFRAMES.join(
        ', '
      )}`
    );

    console.log(
      `Provider safe limit: ${PROVIDER_SAFE_LIMIT}/minute`
    );

    console.log(
      `Daily usable limit: ${DAILY_MAX_USABLE}`
    );

    startBackgroundScanner();
  }
);

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
  'unhandledRejection',
  (error) => {
    console.error(
      'Unhandled rejection:',
      error
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
