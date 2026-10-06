'use strict';

/*
============================================================
 PO AI PREDICTOR
 Backend V9.0.4
 LIVE ONLY - Twelve Data

 V9.0.4 FINAL FIXES
 -----------------------------------------------------------
 - SINGLE SOURCE OF TRUTH
 - ONE /api/best RESPONSE CONTRACT
 - TIMEFRAME-SPECIFIC FRESHNESS
 - FRESHNESS-AWARE RANKING
 - HARD STALE PROTECTION
 - PROVIDER REQUEST QUEUE / HARD SAFETY
 - NO 8th REQUEST
 - SCAN LOCK / MANUAL LOCK
 - CACHE-SAFE
 - NO DUPLICATE SCANS
 - NO STALE SIGNAL AS HIGH-CONFIDENCE SIGNAL
 - 1m Twelve Data source
 - Local 2m / 3m aggregation
 - EMA9 / EMA21
 - RSI14
 - ATR14
 - ADX14
 - Stochastic14
 - Bollinger20
 - Support / Resistance
 - Candlestick patterns
 - Market psychology
 - CALL / PUT / NO TRADE
 - Entry buffer >= 30 seconds
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

const PORT = process.env.PORT || 10000;

const VERSION = 'V9.0.4';
const SOURCE = 'Twelve Data LIVE';
const TIMEZONE = 'UTC';

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY ||
  process.env.TWELVEDATA_API_KEY ||
  '';

const TWELVE_DATA_URL =
  'https://api.twelvedata.com/time_series';

const TIMEFRAMES = [1, 2, 3];

/*
24 supported LIVE forex pairs.
*/
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

/*
------------------------------------------------------------
Provider safety

Twelve Data plan may allow 8/min.
We deliberately use 6/min internally.

Why?

7 would technically be below 8, but any duplicate/
parallel request or timing ambiguity could produce the
provider's "9 credits / current limit 8" situation.

Therefore:

REAL PROVIDER LIMIT  = 7 safe local requests/minute
HARD INTERNAL TARGET = 6 requests/minute

This leaves one credit as emergency reserve.
------------------------------------------------------------
*/

const PROVIDER_HARD_LIMIT = 7;
const PROVIDER_SAFE_LIMIT = 6;

const PROVIDER_WINDOW_MS = 60 * 1000;

const DAILY_LIMIT = 768;
const DAILY_SAFETY_RESERVE = 32;
const MAX_DAILY_REQUESTS =
  DAILY_LIMIT - DAILY_SAFETY_RESERVE;

/*
Never use the final daily credit.
*/
const DAILY_REQUEST_LIMIT = MAX_DAILY_REQUESTS;

/*
------------------------------------------------------------
Caching
------------------------------------------------------------
*/
const PAIR_CACHE_TTL_MS = 15 * 60 * 1000;
const RESULT_CACHE_TTL_MS = 30 * 1000;

/*
------------------------------------------------------------
Scanner
------------------------------------------------------------
*/

const SCAN_BATCH_SIZE = 6;

/*
We intentionally scan one small batch every minute.
This guarantees that scanner activity cannot exceed the
provider safe rate.
*/
const SCAN_INTERVAL_MS = 60 * 1000;

const REQUEST_DELAY_MS = 1500;

/*
------------------------------------------------------------
Signal freshness

The latest completed candle is not necessarily "now".

Allowed age is timeframe-specific.

1m:
  ideal <= 60 sec
  acceptable <= 90 sec

2m:
  ideal <= 120 sec
  acceptable <= 150 sec

3m:
  ideal <= 180 sec
  acceptable <= 210 sec

Anything beyond HARD_STALE is rejected completely.
------------------------------------------------------------
*/

const MAX_DATA_AGE_BY_TF = {
  1: 90,
  2: 150,
  3: 210
};

const HARD_STALE_SECONDS = 300;

/*
Signal must have enough time before entry.
*/
const ENTRY_BUFFER_SECONDS = 30;

/*
If an entry is already too close, skip to the following
candle boundary.
*/
const MIN_ENTRY_SECONDS = 15;

/*
Minimum candles required after aggregation.
*/
const MAX_CANDLES = 180;
const MIN_CANDLES = 80;

/*
Signal thresholds.
*/
const SIGNAL_THRESHOLD = 55;
const MIN_SCORE_GAP = 12;

/*
============================================================
STATE
============================================================
*/

const pairCache = new Map();
const bestResultCache = {
  response: null,
  createdAt: 0
};

/*
Rolling provider request timestamps.
*/
const providerRequestTimes = [];

/*
Daily usage.
*/
let dailyCreditsUsed = 0;
let dailyDateKey = utcDateKey(new Date());

/*
Scanner state.
*/
let scanRunning = false;
let scanPromise = null;
let scanCursor = 0;
let lastScanAt = null;
let lastScanError = null;

let totalScanned = 0;
let totalFailed = 0;
let totalApiRequests = 0;

/*
============================================================
UTILITY
============================================================
*/

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) return null;

  const p = Math.pow(10, decimals);

  return Math.round(value * p) / p;
}

function safeNumber(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function resetDailyIfNeeded() {
  const today = utcDateKey(new Date());

  if (today !== dailyDateKey) {
    dailyDateKey = today;
    dailyCreditsUsed = 0;
  }
}

function providerRequestsThisMinute() {
  const cutoff = nowMs() - PROVIDER_WINDOW_MS;

  while (
    providerRequestTimes.length &&
    providerRequestTimes[0] <= cutoff
  ) {
    providerRequestTimes.shift();
  }

  return providerRequestTimes.length;
}

function dailyCreditsRemaining() {
  resetDailyIfNeeded();

  return Math.max(
    0,
    DAILY_REQUEST_LIMIT - dailyCreditsUsed
  );
}

function providerCanRequestNow() {
  resetDailyIfNeeded();

  const minuteCount = providerRequestsThisMinute();

  if (dailyCreditsUsed >= DAILY_REQUEST_LIMIT) {
    return {
      ok: false,
      reason: 'Daily request safety reserve reached'
    };
  }

  /*
  Safe local limit is 6.
  Hard limit is 7.
  */
  if (minuteCount >= PROVIDER_SAFE_LIMIT) {
    return {
      ok: false,
      reason: 'Provider safe minute limit reached'
    };
  }

  if (minuteCount >= PROVIDER_HARD_LIMIT) {
    return {
      ok: false,
      reason: 'Provider hard minute limit reached'
    };
  }

  return {
    ok: true
  };
}

/*
============================================================
PROVIDER QUEUE

This is important.

No request is sent until the rolling limiter says it is safe.

This prevents:
 - scanner + manual call collision
 - duplicate requests
 - accidental 8th request
 - overlapping provider calls
============================================================
*/

let providerQueue = Promise.resolve();

function enqueueProviderRequest(task) {
  const run = providerQueue.then(async () => {
    /*
    Wait until a safe provider slot exists.
    */
    while (true) {
      const status = providerCanRequestNow();

      if (status.ok) {
        break;
      }

      /*
      If daily limit is reached, do not wait forever.
      */
      if (
        status.reason.includes('Daily')
      ) {
        throw new Error(status.reason);
      }

      const count = providerRequestsThisMinute();

      if (count > 0) {
        const oldest = providerRequestTimes[0];
        const waitFor =
          Math.max(
            1000,
            PROVIDER_WINDOW_MS -
              (nowMs() - oldest) +
              250
          );

        await sleep(waitFor);
      } else {
        await sleep(1000);
      }
    }

    /*
    Reserve slot immediately BEFORE request.
    */
    resetDailyIfNeeded();

    providerRequestsThisMinute();

    providerRequestTimes.push(nowMs());

    dailyCreditsUsed += 1;
    totalApiRequests += 1;

    return task();
  });

  /*
  Keep queue alive even after failure.
  */
  providerQueue = run.catch(() => {});

  return run;
}

/*
============================================================
HTTP FETCH WITH TIMEOUT
============================================================
*/

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json'
      }
    });

    const text = await response.text();

    let json;

    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid provider JSON (${response.status})`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Provider HTTP ${response.status}`
      );
    }

    return json;
  } finally {
    clearTimeout(timer);
  }
}

/*
============================================================
TWELVE DATA
============================================================
*/

async function fetchOneMinuteCandles(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      'TWELVE_DATA_API_KEY is not configured'
    );
  }

  const url =
    `${TWELVE_DATA_URL}` +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=1min` +
    `&outputsize=${MAX_CANDLES}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

  const data = await enqueueProviderRequest(
    () => fetchJson(url)
  );

  if (
    data &&
    typeof data.message === 'string'
  ) {
    throw new Error(data.message);
  }

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
      'Twelve Data returned no candle values'
    );
  }

  const candles = data.values
    .map(row => {
      const time = new Date(row.datetime);

      const open = safeNumber(row.open);
      const high = safeNumber(row.high);
      const low = safeNumber(row.low);
      const close = safeNumber(row.close);
      const volume = safeNumber(row.volume) || 0;

      if (
        !Number.isFinite(time.getTime()) ||
        open === null ||
        high === null ||
        low === null ||
        close === null
      ) {
        return null;
      }

      return {
        time,
        open,
        high,
        low,
        close,
        volume
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.time.getTime() -
        b.time.getTime()
    );

  /*
  Remove current/forming candle.
  */
  const completed = completedCandles(candles);

  if (completed.length < MIN_CANDLES) {
    throw new Error(
      `Insufficient completed candles (${completed.length}/${MIN_CANDLES})`
    );
  }

  return completed.slice(-MAX_CANDLES);
}

/*
============================================================
COMPLETED CANDLES
============================================================
*/

function completedCandles(candles) {
  const now = new Date();

  return candles.filter(candle => {
    const nextMinute =
      new Date(
        candle.time.getTime() +
        60 * 1000
      );

    return nextMinute <= now;
  });
}

/*
============================================================
AGGREGATION
============================================================
*/

function aggregateCandles(candles, timeframe) {
  if (timeframe === 1) {
    return candles.slice(-MAX_CANDLES);
  }

  const groups = new Map();

  for (const candle of candles) {
    const d = new Date(candle.time);

    const minute =
      d.getUTCMinutes();

    const bucketMinute =
      Math.floor(minute / timeframe) *
      timeframe;

    const bucket = new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        d.getUTCHours(),
        bucketMinute,
        0,
        0
      )
    );

    const key = bucket.toISOString();

    if (!groups.has(key)) {
      groups.set(key, {
        time: bucket,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
        count: 1
      });
    } else {
      const g = groups.get(key);

      g.high =
        Math.max(g.high, candle.high);

      g.low =
        Math.min(g.low, candle.low);

      g.close =
        candle.close;

      g.volume +=
        candle.volume || 0;

      g.count += 1;
    }
  }

  const output = Array.from(
    groups.values()
  )
    .filter(g => g.count === timeframe)
    .map(g => ({
      time: g.time,
      open: g.open,
      high: g.high,
      low: g.low,
      close: g.close,
      volume: g.volume
    }))
    .sort(
      (a, b) =>
        a.time.getTime() -
        b.time.getTime()
    );

  return output.slice(-MAX_CANDLES);
}

/*
============================================================
EMA
============================================================
*/

function ema(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
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
      (
        values[i] - previous
      ) * multiplier +
      previous;
  }

  return previous;
}

/*
EMA series
*/
function emaSeries(values, period) {
  const result =
    new Array(values.length).fill(null);

  if (values.length < period) {
    return result;
  }

  let previous = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    previous += values[i];
  }

  previous /= period;

  result[period - 1] = previous;

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    previous =
      (
        values[i] - previous
      ) * multiplier +
      previous;

    result[i] = previous;
  }

  return result;
}

/*
============================================================
RSI
============================================================
*/

function rsi(values, period = 14) {
  if (values.length <= period) {
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
      values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
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
    const change =
      values[i] - values[i - 1];

    const gain =
      Math.max(change, 0);

    const loss =
      Math.max(-change, 0);

    avgGain =
      (
        avgGain * (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 -
    (100 / (1 + rs));
}

/*
============================================================
TRUE RANGE / ATR
============================================================
*/

function trueRanges(candles) {
  const tr = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const a =
      current.high -
      current.low;

    const b =
      Math.abs(
        current.high -
        previous.close
      );

    const c =
      Math.abs(
        current.low -
        previous.close
      );

    tr.push(
      Math.max(a, b, c)
    );
  }

  return tr;
}

function atr(candles, period = 14) {
  const tr =
    trueRanges(candles);

  if (tr.length < period) {
    return null;
  }

  let value = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    value += tr[i];
  }

  value /= period;

  for (
    let i = period;
    i < tr.length;
    i++
  ) {
    value =
      (
        value * (period - 1) +
        tr[i]
      ) / period;
  }

  return value;
}

/*
============================================================
ADX
============================================================
*/

function adx(candles, period = 14) {
  if (
    candles.length <
    period * 2 + 2
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

  if (trs.length < period) {
    return null;
  }

  let tr14 = 0;
  let plus14 = 0;
  let minus14 = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    tr14 += trs[i];
    plus14 += plusDM[i];
    minus14 += minusDM[i];
  }

  const dxValues = [];

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

    if (tr14 === 0) {
      dxValues.push(0);
      continue;
    }

    const plusDI =
      100 * plus14 / tr14;

    const minusDI =
      100 * minus14 / tr14;

    const sum =
      plusDI + minusDI;

    const dx =
      sum === 0
        ? 0
        : 100 *
          Math.abs(
            plusDI - minusDI
          ) /
          sum;

    dxValues.push(dx);
  }

  if (dxValues.length < period) {
    return null;
  }

  let adxValue = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    adxValue += dxValues[i];
  }

  adxValue /= period;

  for (
    let i = period;
    i < dxValues.length;
    i++
  ) {
    adxValue =
      (
        adxValue * (period - 1) +
        dxValues[i]
      ) / period;
  }

  return adxValue;
}

/*
============================================================
STOCHASTIC
============================================================
*/

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
      ...recent.map(c => c.high)
    );

  const lowest =
    Math.min(
      ...recent.map(c => c.low)
    );

  const close =
    recent[recent.length - 1]
      .close;

  if (highest === lowest) {
    return 50;
  }

  return (
    (close - lowest) /
    (highest - lowest)
  ) * 100;
}

/*
============================================================
BOLLINGER
============================================================
*/

function bollinger(
  values,
  period = 20,
  multiplier = 2
) {
  if (
    values.length < period
  ) {
    return null;
  }

  const recent =
    values.slice(-period);

  const mean =
    recent.reduce(
      (a, b) => a + b,
      0
    ) / period;

  const variance =
    recent.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - mean,
          2
        ),
      0
    ) / period;

  const std =
    Math.sqrt(variance);

  return {
    upper:
      mean + multiplier * std,
    middle:
      mean,
    lower:
      mean - multiplier * std
  };
}

/*
============================================================
SUPPORT / RESISTANCE
============================================================
*/

function supportResistance(candles) {
  const recent =
    candles.slice(-40);

  const support =
    Math.min(
      ...recent.map(c => c.low)
    );

  const resistance =
    Math.max(
      ...recent.map(c => c.high)
    );

  return {
    support,
    resistance
  };
}

/*
============================================================
CANDLESTICK PATTERNS
============================================================
*/

function candlePattern(candles) {
  if (candles.length < 3) {
    return {
      pattern: 'INSUFFICIENT DATA',
      direction: 'NEUTRAL',
      strength: 0
    };
  }

  const a =
    candles[candles.length - 1];

  const b =
    candles[candles.length - 2];

  const body =
    Math.abs(
      a.close - a.open
    );

  const range =
    a.high - a.low;

  const upperWick =
    a.high -
    Math.max(a.open, a.close);

  const lowerWick =
    Math.min(a.open, a.close) -
    a.low;

  /*
  Bullish engulfing
  */
  if (
    b.close < b.open &&
    a.close > a.open &&
    a.open <= b.close &&
    a.close >= b.open
  ) {
    return {
      pattern: 'BULLISH ENGULFING',
      direction: 'CALL',
      strength: 8
    };
  }

  /*
  Bearish engulfing
  */
  if (
    b.close > b.open &&
    a.close < a.open &&
    a.open >= b.close &&
    a.close <= b.open
  ) {
    return {
      pattern: 'BEARISH ENGULFING',
      direction: 'PUT',
      strength: 8
    };
  }

  /*
  Hammer
  */
  if (
    range > 0 &&
    lowerWick >= body * 2 &&
    upperWick <= body * 0.8
  ) {
    return {
      pattern: 'HAMMER',
      direction: 'CALL',
      strength: 5
    };
  }

  /*
  Shooting star
  */
  if (
    range > 0 &&
    upperWick >= body * 2 &&
    lowerWick <= body * 0.8
  ) {
    return {
      pattern: 'SHOOTING STAR',
      direction: 'PUT',
      strength: 5
    };
  }

  /*
  Strong bullish candle
  */
  if (
    a.close > a.open &&
    range > 0 &&
    body / range >= 0.65
  ) {
    return {
      pattern: 'STRONG BULLISH CANDLE',
      direction: 'CALL',
      strength: 4
    };
  }

  /*
  Strong bearish candle
  */
  if (
    a.close < a.open &&
    range > 0 &&
    body / range >= 0.65
  ) {
    return {
      pattern: 'STRONG BEARISH CANDLE',
      direction: 'PUT',
      strength: 4
    };
  }

  return {
    pattern: 'MIXED PRICE ACTION',
    direction: 'NEUTRAL',
    strength: 0
  };
}

/*
============================================================
MARKET PSYCHOLOGY
============================================================

This is inferred from OHLC price action.
It is NOT order-book sentiment.
============================================================
*/

function marketPsychology(
  candles,
  ema9,
  ema21,
  rsi14
) {
  const latest =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  if (!latest || !previous) {
    return {
      label: 'Neutral market',
      direction: 'NEUTRAL',
      strength: 0
    };
  }

  const bullish =
    latest.close > previous.close &&
    latest.close > ema9 &&
    ema9 > ema21 &&
    rsi14 >= 50;

  const bearish =
    latest.close < previous.close &&
    latest.close < ema9 &&
    ema9 < ema21 &&
    rsi14 <= 50;

  if (bullish) {
    return {
      label:
        'Bullish momentum / buyers in control',
      direction: 'CALL',
      strength: 8
    };
  }

  if (bearish) {
    return {
      label:
        'Bearish momentum / sellers in control',
      direction: 'PUT',
      strength: 8
    };
  }

  return {
    label: 'Balanced / mixed price action',
    direction: 'NEUTRAL',
    strength: 0
  };
}

/*
============================================================
VOLATILITY
============================================================
*/

function volatilityLabel(
  candles,
  atr14,
  currentPrice
) {
  if (
    !Number.isFinite(atr14) ||
    !Number.isFinite(currentPrice) ||
    currentPrice === 0
  ) {
    return 'UNKNOWN';
  }

  const pct =
    (atr14 / currentPrice) *
    100;

  if (pct < 0.025) {
    return 'LOW';
  }

  if (pct < 0.08) {
    return 'MEDIUM';
  }

  return 'HIGH';
}

/*
============================================================
FRESHNESS
============================================================
*/

function freshnessLimitForTimeframe(
  timeframe
) {
  return (
    MAX_DATA_AGE_BY_TF[timeframe] ||
    90
  );
}

function calculateDataAgeSeconds(
  lastCandle
) {
  if (!lastCandle) {
    return Infinity;
  }

  return Math.max(
    0,
    Math.floor(
      (
        nowMs() -
        new Date(lastCandle).getTime()
      ) / 1000
    )
  );
}

function freshnessStatus(
  timeframe,
  ageSeconds
) {
  const maxAge =
    freshnessLimitForTimeframe(
      timeframe
    );

  if (
    !Number.isFinite(ageSeconds)
  ) {
    return 'INVALID';
  }

  if (
    ageSeconds >
    HARD_STALE_SECONDS
  ) {
    return 'HARD_STALE';
  }

  if (
    ageSeconds > maxAge
  ) {
    return 'STALE';
  }

  /*
  Very fresh.
  */
  if (
    ageSeconds <=
    Math.floor(maxAge * 0.55)
  ) {
    return 'FRESH';
  }

  return 'ACCEPTABLE';
}

/*
============================================================
ENTRY / EXPIRY
============================================================
*/

function nextBoundary(
  timeframe,
  minimumSeconds
) {
  const now =
    new Date();

  const ms =
    now.getTime();

  const tfMs =
    timeframe *
    60 *
    1000;

  /*
  Round to next timeframe boundary.
  */
  let boundary =
    Math.ceil(
      ms / tfMs
    ) * tfMs;

  let seconds =
    Math.floor(
      (boundary - ms) / 1000
    );

  /*
  Guarantee enough time.
  */
  if (
    seconds < minimumSeconds
  ) {
    boundary += tfMs;

    seconds =
      Math.floor(
        (boundary - ms) / 1000
      );
  }

  return {
    entryTime:
      new Date(boundary),
    entryInSeconds:
      seconds,
    expiryTime:
      new Date(
        boundary + tfMs
      )
  };
}

/*
============================================================
ANALYZE CANDLES
============================================================
*/

function analyzeCandles(
  pair,
  timeframe,
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < MIN_CANDLES
  ) {
    return null;
  }

  const closes =
    candles.map(
      c => c.close
    );

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
    stochastic(candles, 14);

  const boll =
    bollinger(
      closes,
      20,
      2
    );

  const sr =
    supportResistance(
      candles
    );

  const pattern =
    candlePattern(
      candles
    );

  if (
    ema9 === null ||
    ema21 === null ||
    rsi14 === null ||
    atr14 === null ||
    adx14 === null ||
    stochastic14 === null ||
    boll === null
  ) {
    return null;
  }

  const last =
    candles[candles.length - 1];

  const currentPrice =
    last.close;

  const lastCandle =
    last.time;

  const dataAgeSeconds =
    calculateDataAgeSeconds(
      lastCandle
    );

  const freshLimit =
    freshnessLimitForTimeframe(
      timeframe
    );

  const freshStatus =
    freshnessStatus(
      timeframe,
      dataAgeSeconds
    );

  let callScore = 0;
  let putScore = 0;

  const reasonsCall = [];
  const reasonsPut = [];

  /*
  ----------------------------------------------------------
  EMA
  ----------------------------------------------------------
  */
  if (ema9 > ema21) {
    callScore += 20;
    reasonsCall.push(
      'EMA9 is above EMA21'
    );
  } else if (ema9 < ema21) {
    putScore += 20;
    reasonsPut.push(
      'EMA9 is below EMA21'
    );
  }

  /*
  ----------------------------------------------------------
  RSI
  ----------------------------------------------------------
  */
  if (rsi14 >= 52 && rsi14 <= 68) {
    callScore += 12;
    reasonsCall.push(
      'RSI supports bullish momentum'
    );
  } else if (
    rsi14 <= 48 &&
    rsi14 >= 32
  ) {
    putScore += 12;
    reasonsPut.push(
      'RSI supports bearish momentum'
    );
  } else if (rsi14 < 30) {
    callScore += 5;
    reasonsCall.push(
      'RSI is deeply oversold'
    );
  } else if (rsi14 > 70) {
    putScore += 5;
    reasonsPut.push(
      'RSI is deeply overbought'
    );
  }

  /*
  ----------------------------------------------------------
  ADX
  ----------------------------------------------------------
  */
  if (adx14 >= 25) {
    if (ema9 > ema21) {
      callScore += 15;
      reasonsCall.push(
        'ADX confirms trend strength'
      );
    } else if (ema9 < ema21) {
      putScore += 15;
      reasonsPut.push(
        'ADX confirms trend strength'
      );
    }
  } else {
    callScore = Math.max(
      0,
      callScore - 4
    );

    putScore = Math.max(
      0,
      putScore - 4
    );
  }

  /*
  ----------------------------------------------------------
  STOCHASTIC
  ----------------------------------------------------------
  */
  if (
    stochastic14 >= 55 &&
    stochastic14 <= 82
  ) {
    callScore += 8;
    reasonsCall.push(
      'Stochastic supports CALL momentum'
    );
  } else if (
    stochastic14 <= 45 &&
    stochastic14 >= 18
  ) {
    putScore += 8;
    reasonsPut.push(
      'Stochastic supports PUT momentum'
    );
  } else if (
    stochastic14 < 18
  ) {
    callScore += 4;
    reasonsCall.push(
      'Stochastic is deeply oversold'
    );
  } else if (
    stochastic14 > 82
  ) {
    putScore += 4;
    reasonsPut.push(
      'Stochastic is deeply overbought'
    );
  }

  /*
  ----------------------------------------------------------
  CANDLE PATTERN
  ----------------------------------------------------------
  */
  if (
    pattern.direction === 'CALL'
  ) {
    callScore +=
      pattern.strength;

    reasonsCall.push(
      pattern.pattern
    );
  }

  if (
    pattern.direction === 'PUT'
  ) {
    putScore +=
      pattern.strength;

    reasonsPut.push(
      pattern.pattern
    );
  }

  /*
  ----------------------------------------------------------
  MARKET PSYCHOLOGY
  ----------------------------------------------------------
  */
  const psychology =
    marketPsychology(
      candles,
      ema9,
      ema21,
      rsi14
    );

  if (
    psychology.direction === 'CALL'
  ) {
    callScore +=
      psychology.strength;

    reasonsCall.push(
      psychology.label
    );
  }

  if (
    psychology.direction === 'PUT'
  ) {
    putScore +=
      psychology.strength;

    reasonsPut.push(
      psychology.label
    );
  }

  /*
  ----------------------------------------------------------
  SUPPORT / RESISTANCE
  ----------------------------------------------------------
  */

  const range =
    sr.resistance -
    sr.support;

  const distanceToResistance =
    sr.resistance -
    currentPrice;

  const distanceToSupport =
    currentPrice -
    sr.support;

  if (
    range > 0 &&
    distanceToResistance >
      range * 0.25
  ) {
    if (ema9 > ema21) {
      callScore += 6;
      reasonsCall.push(
        'Room remains toward resistance'
      );
    }
  }

  if (
    range > 0 &&
    distanceToSupport >
      range * 0.25
  ) {
    if (ema9 < ema21) {
      putScore += 6;
      reasonsPut.push(
        'Room remains toward support'
      );
    }
  }

  /*
  ----------------------------------------------------------
  BOLLINGER
  ----------------------------------------------------------
  */

  if (
    currentPrice >
    boll.middle &&
    currentPrice <
    boll.upper &&
    ema9 > ema21
  ) {
    callScore += 5;
    reasonsCall.push(
      'Price is above Bollinger middle'
    );
  }

  if (
    currentPrice <
    boll.middle &&
    currentPrice >
    boll.lower &&
    ema9 < ema21
  ) {
    putScore += 5;
    reasonsPut.push(
      'Price is below Bollinger middle'
    );
  }

  /*
  ----------------------------------------------------------
  VOLATILITY
  ----------------------------------------------------------
  */

  const volatility =
    volatilityLabel(
      candles,
      atr14,
      currentPrice
    );

  if (volatility === 'HIGH') {
    callScore = Math.max(
      0,
      callScore - 5
    );

    putScore = Math.max(
      0,
      putScore - 5
    );
  }

  /*
  ----------------------------------------------------------
  SCORE
  ----------------------------------------------------------
  */

  callScore =
    Math.round(callScore);

  putScore =
    Math.round(putScore);

  const strongestScore =
    Math.max(
      callScore,
      putScore
    );

  const gap =
    Math.abs(
      callScore -
      putScore
    );

  let signal = 'NO TRADE';

  if (
    callScore >= SIGNAL_THRESHOLD &&
    callScore > putScore &&
    gap >= MIN_SCORE_GAP
  ) {
    signal = 'CALL';
  } else if (
    putScore >= SIGNAL_THRESHOLD &&
    putScore > callScore &&
    gap >= MIN_SCORE_GAP
  ) {
    signal = 'PUT';
  }

  /*
  ----------------------------------------------------------
  FRESHNESS OVERRIDE
  ----------------------------------------------------------
  This is the major V9.0.4 fix.

  A signal outside its timeframe-specific freshness window
  MUST NOT be returned as CALL/PUT.
  ----------------------------------------------------------
  */

  if (
    freshStatus === 'STALE' ||
    freshStatus === 'HARD_STALE' ||
    freshStatus === 'INVALID'
  ) {
    signal = 'NO TRADE';
  }

  /*
  ----------------------------------------------------------
  ENTRY
  ----------------------------------------------------------
  */

  const timing =
    nextBoundary(
      timeframe,
      ENTRY_BUFFER_SECONDS
    );

  if (
    timing.entryInSeconds <
    MIN_ENTRY_SECONDS
  ) {
    signal = 'NO TRADE';
  }

  /*
  ----------------------------------------------------------
  CONFIDENCE
  ----------------------------------------------------------
  */

  let confidence = 50;

  if (signal !== 'NO TRADE') {
    confidence =
      50 +
      (
        strongestScore -
        SIGNAL_THRESHOLD
      ) * 0.7 +
      gap * 0.55;

    /*
    Freshness bonus.
    */
    if (
      freshStatus === 'FRESH'
    ) {
      confidence += 3;
    }

    /*
    High volatility penalty.
    */
    if (
      volatility === 'HIGH'
    ) {
      confidence -= 5;
    }

    confidence =
      clamp(
        Math.round(confidence),
        45,
        97
      );
  } else {
    /*
    Never display a fake high confidence on NO TRADE.
    */
    confidence =
      clamp(
        Math.round(
          45 +
          Math.min(
            14,
            gap * 0.25
          )
        ),
        40,
        59
      );
  }

  /*
  ----------------------------------------------------------
  DATA AGE / FRESHNESS
  ----------------------------------------------------------
  */

  const freshness =
    {
      status: freshStatus,
      maxAgeSeconds:
        freshLimit,
      dataAgeSeconds
    };

  /*
  ----------------------------------------------------------
  REASONS
  ----------------------------------------------------------
  */

  let reasons;

  if (signal === 'CALL') {
    reasons =
      reasonsCall.slice(0, 8);
  } else if (
    signal === 'PUT'
  ) {
    reasons =
      reasonsPut.slice(0, 8);
  } else {
    reasons = [
      ...reasonsCall.slice(0, 3),
      ...reasonsPut.slice(0, 3)
    ];

    if (
      freshStatus === 'STALE'
    ) {
      reasons.push(
        `Data is stale for ${timeframe}m timeframe`
      );
    }

    if (
      freshStatus === 'HARD_STALE'
    ) {
      reasons.push(
        'Data is hard stale'
      );
    }

    if (
      signal === 'NO TRADE'
    ) {
      reasons.push(
        'No sufficiently strong directional setup'
      );
    }
  }

  /*
  ----------------------------------------------------------
  RETURN OBJECT
  ----------------------------------------------------------
  */

  return {
    pair,
    timeframe,

    signal,
    confidence,

    currentPrice:
      round(currentPrice),

    entryPrice:
      round(currentPrice),

    entryTime:
      timing.entryTime.toISOString(),

    expiryTime:
      timing.expiryTime.toISOString(),

    entryInSeconds:
      timing.entryInSeconds,

    lastCandle:
      lastCandle.toISOString(),

    dataAgeSeconds,

    freshness,

    callScore,
    putScore,
    gap,

    volatility,

    indicators: {
      ema9:
        round(ema9),
      ema21:
        round(ema21),
      rsi14:
        round(rsi14, 2),
      adx14:
        round(adx14, 2),
      stochastic14:
        round(
          stochastic14,
          2
        ),
      atr14:
        round(atr14, 8),
      bollinger: {
        upper:
          round(
            boll.upper
          ),
        middle:
          round(
            boll.middle
          ),
        lower:
          round(
            boll.lower
          )
      }
    },

    supportResistance: {
      support:
        round(sr.support),
      resistance:
        round(sr.resistance)
    },

    priceAction: pattern,

    marketPsychology:
      psychology,

    reasons
  };
}

/*
============================================================
PAIR CACHE
============================================================
*/

function getPairCache(pair) {
  const item =
    pairCache.get(pair);

  if (!item) {
    return null;
  }

  if (
    nowMs() -
      item.createdAt >
    PAIR_CACHE_TTL_MS
  ) {
    return null;
  }

  return item;
}

function setPairCache(
  pair,
  candles
) {
  pairCache.set(
    pair,
    {
      candles,
      createdAt: nowMs()
    }
  );
}

/*
============================================================
FETCH PAIR WITH CACHE
============================================================
*/

async function getPairCandles(
  pair
) {
  const cached =
    getPairCache(pair);

  if (cached) {
    return {
      candles: cached.candles,
      fromCache: true
    };
  }

  const candles =
    await fetchOneMinuteCandles(
      pair
    );

  setPairCache(
    pair,
    candles
  );

  return {
    candles,
    fromCache: false
  };
}

/*
============================================================
ANALYZE PAIR
============================================================
*/

async function analyzePair(
  pair
) {
  const result = {
    pair,
    analyses: [],
    fromCache: false
  };

  const data =
    await getPairCandles(pair);

  result.fromCache =
    data.fromCache;

  for (
    const timeframe of TIMEFRAMES
  ) {
    const aggregated =
      aggregateCandles(
        data.candles,
        timeframe
      );

    if (
      aggregated.length <
      MIN_CANDLES
    ) {
      continue;
    }

    const analysis =
      analyzeCandles(
        pair,
        timeframe,
        aggregated
      );

    if (analysis) {
      result.analyses.push(
        analysis
      );
    }
  }

  if (
    result.analyses.length === 0
  ) {
    throw new Error(
      `${pair}: no valid timeframe analysis`
    );
  }

  return result;
}

/*
============================================================
ALL VALID CANDIDATES
============================================================
*/

function collectCandidates() {
  const candidates = [];

  for (
    const item of pairCache.values()
  ) {
    if (!item || !item.candles) {
      continue;
    }

    for (
      const timeframe of TIMEFRAMES
    ) {
      const aggregated =
        aggregateCandles(
          item.candles,
          timeframe
        );

      if (
        aggregated.length <
        MIN_CANDLES
      ) {
        continue;
      }

      const analysis =
        analyzeCandles(
          /*
          pair is not stored inside cache.
          */
          item.pair || '',
          timeframe,
          aggregated
        );

      if (analysis) {
        candidates.push(
          analysis
        );
      }
    }
  }

  return candidates;
}

/*
============================================================
REBUILD ALL CANDIDATES

Pair is stored explicitly here because older cache entries
may not contain it.
============================================================
*/

function collectCandidatesFromCache() {
  const candidates = [];

  for (
    const [pair, item]
    of pairCache.entries()
  ) {
    if (
      !item ||
      !Array.isArray(item.candles)
    ) {
      continue;
    }

    /*
    Pair cache itself must still be fresh.
    */
    if (
      nowMs() -
        item.createdAt >
      PAIR_CACHE_TTL_MS
    ) {
      continue;
    }

    for (
      const timeframe of TIMEFRAMES
    ) {
      const aggregated =
        aggregateCandles(
          item.candles,
          timeframe
        );

      if (
        aggregated.length <
        MIN_CANDLES
      ) {
        continue;
      }

      const analysis =
        analyzeCandles(
          pair,
          timeframe,
          aggregated
        );

      if (analysis) {
        candidates.push(
          analysis
        );
      }
    }
  }

  return candidates;
}

/*
============================================================
RANKING

Freshness is now a major ranking factor.

A 94% stale signal must NOT beat a fresh 88% signal.
============================================================
*/

function freshnessScore(
  candidate
) {
  const age =
    candidate.dataAgeSeconds;

  const maxAge =
    freshnessLimitForTimeframe(
      candidate.timeframe
    );

  if (
    !Number.isFinite(age)
  ) {
    return -1000;
  }

  if (
    age > HARD_STALE_SECONDS
  ) {
    return -1000;
  }

  if (
    age > maxAge
  ) {
    return -500;
  }

  /*
  0 = max age
  20 = very fresh
  */
  return clamp(
    20 *
      (
        1 -
        age / maxAge
      ),
    0,
    20
  );
}

function candidateRank(
  candidate
) {
  if (
    !candidate ||
    candidate.signal === 'NO TRADE'
  ) {
    return -10000;
  }

  const fresh =
    freshnessScore(
      candidate
    );

  if (fresh < 0) {
    return -10000;
  }

  /*
  Confidence remains important,
  but freshness is explicitly weighted.
  */
  const score =
    candidate.confidence * 1.0 +
    candidate.gap * 0.35 +
    fresh * 2.0;

  /*
  Prefer shorter timeframe when quality is
  essentially equal.
  */
  const tfBonus =
    candidate.timeframe === 1
      ? 3
      : candidate.timeframe === 2
        ? 2
        : 1;

  return score + tfBonus;
}

function rankCandidates(
  candidates
) {
  return candidates
    .filter(
      c =>
        c &&
        c.signal !== 'NO TRADE' &&
        freshnessScore(c) >= 0
    )
    .sort(
      (a, b) =>
        candidateRank(b) -
        candidateRank(a)
    );
}

/*
============================================================
SCANNER

One scanner operation at a time.
============================================================
*/

async function scanBatch() {
  if (scanRunning) {
    return scanPromise;
  }

  scanRunning = true;

  scanPromise =
    (async () => {
      let scanned = 0;
      let failed = 0;
      let localError = null;

      /*
      Maximum 6 provider calls in this batch.
      */
      const batch = [];

      for (
        let i = 0;
        i < SCAN_BATCH_SIZE;
        i++
      ) {
        const index =
          (
            scanCursor + i
          ) %
          PAIRS.length;

        batch.push(
          PAIRS[index]
        );
      }

      for (
        const pair of batch
      ) {
        try {
          /*
          Provider queue handles timing.
          */
          await analyzePair(pair);

          scanned += 1;
          totalScanned += 1;
        } catch (error) {
          failed += 1;
          totalFailed += 1;

          localError =
            `${pair}: ${
              error.message
            }`;
        }

        /*
        Space requests even though the queue
        itself is safe.
        */
        await sleep(
          REQUEST_DELAY_MS
        );
      }

      scanCursor =
        (
          scanCursor +
          batch.length
        ) %
        PAIRS.length;

      lastScanAt =
        new Date().toISOString();

      lastScanError =
        localError;

      /*
      Critical:
      invalidate best response after new scan.
      */
      bestResultCache.response =
        null;

      bestResultCache.createdAt =
        0;

      return {
        scanned,
        failed,
        cursor: scanCursor
      };
    })();

  try {
    return await scanPromise;
  } finally {
    scanRunning = false;
    scanPromise = null;
  }
}

/*
============================================================
ENSURE CANDIDATES

We don't force another provider request if cache already
contains usable data.
============================================================
*/

async function ensureCandidates() {
  let candidates =
    collectCandidatesFromCache();

  const valid =
    rankCandidates(
      candidates
    );

  if (valid.length > 0) {
    return {
      candidates,
      valid
    };
  }

  /*
  No valid fresh candidates.
  Scan synchronously.
  */
  await scanBatch();

  candidates =
    collectCandidatesFromCache();

  return {
    candidates,
    valid:
      rankCandidates(
        candidates
      )
  };
}

/*
============================================================
API RESPONSE BUILDER

THIS IS THE SINGLE CONTRACT USED BY FRONTEND.
============================================================
*/

function buildApiResponse(
  selectedMarket,
  rankedCandidates
) {
  resetDailyIfNeeded();

  const providerMinute =
    providerRequestsThisMinute();

  const cachedPairCount =
    Array.from(
      pairCache.values()
    ).filter(
      item =>
        item &&
        nowMs() -
          item.createdAt <=
          PAIR_CACHE_TTL_MS
    ).length;

  const selected =
    selectedMarket || {
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

  return {
    ok: true,

    version: VERSION,

    source: SOURCE,

    timezone: TIMEZONE,

    selectedMarket: selected,

    supportedTimeframes:
      TIMEFRAMES,

    pairs:
      PAIRS,

    metadata: {
      provider:
        SOURCE,

      liveOnly:
        true,

      providerMinuteLimit:
        PROVIDER_HARD_LIMIT,

      providerSafeMinuteLimit:
        PROVIDER_SAFE_LIMIT,

      providerRequestsThisMinute:
        providerMinute,

      dailyLimit:
        DAILY_LIMIT,

      dailySafetyReserve:
        DAILY_SAFETY_RESERVE,

      maxDailyRequests:
        DAILY_REQUEST_LIMIT,

      dailyCreditsUsed:
        dailyCreditsUsed,

      dailyCreditsRemaining:
        dailyCreditsRemaining(),

      pairCacheTtlSeconds:
        Math.floor(
          PAIR_CACHE_TTL_MS /
          1000
        ),

      resultCacheTtlSeconds:
        Math.floor(
          RESULT_CACHE_TTL_MS /
          1000
        ),

      entryBufferSeconds:
        ENTRY_BUFFER_SECONDS,

      maxDataAgeSeconds: {
        1: MAX_DATA_AGE_BY_TF[1],
        2: MAX_DATA_AGE_BY_TF[2],
        3: MAX_DATA_AGE_BY_TF[3]
      },

      hardStaleSeconds:
        HARD_STALE_SECONDS
    },

    scanner: {
      scanRunning,

      scanCursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      cachedPairs:
        cachedPairCount,

      candidateCount:
        rankedCandidates.length,

      lastScanAt,

      lastScanError,

      totalScanned,

      totalFailed,

      totalApiRequests
    },

    rankedCandidates:
      rankedCandidates
        .slice(0, 10)
        .map(item => ({
          pair:
            item.pair,

          timeframe:
            item.timeframe,

          signal:
            item.signal,

          confidence:
            item.confidence,

          gap:
            item.gap,

          dataAgeSeconds:
            item.dataAgeSeconds,

          freshness:
            item.freshness
        }))
  };
}

/*
============================================================
/api/best
============================================================
*/

app.get(
  '/api/best',
  async (req, res) => {
    try {
      resetDailyIfNeeded();

      /*
      Fresh result cache.
      */
      if (
        bestResultCache.response &&
        nowMs() -
          bestResultCache.createdAt <=
          RESULT_CACHE_TTL_MS
      ) {
        return res.json(
          bestResultCache.response
        );
      }

      /*
      Only one synchronized analysis operation.
      */
      const result =
        await ensureCandidates();

      const ranked =
        rankCandidates(
          result.candidates
        );

      const selected =
        ranked.length > 0
          ? ranked[0]
          : null;

      const response =
        buildApiResponse(
          selected,
          ranked
        );

      /*
      Cache response only if selected market
      itself is valid and fresh.

      NO TRADE responses are short-lived too.
      */
      bestResultCache.response =
        response;

      bestResultCache.createdAt =
        nowMs();

      return res.json(
        response
      );
    } catch (error) {
      console.error(
        'GET /api/best error:',
        error
      );

      /*
      Never return an incompatible response.
      */
      return res.status(200).json(
        buildApiResponse(
          null,
          []
        )
      );
    }
  }
);

/*
============================================================
/api/analyze
============================================================
*/

app.get(
  '/api/analyze',
  async (req, res) => {
    try {
      const pair =
        String(
          req.query.pair || ''
        ).trim();

      if (!pair) {
        return res.status(400).json({
          ok: false,
          version: VERSION,
          error:
            'Missing pair parameter'
        });
      }

      if (
        !PAIRS.includes(pair)
      ) {
        return res.status(400).json({
          ok: false,
          version: VERSION,
          error:
            'Unsupported pair',
          pairs: PAIRS
        });
      }

      const result =
        await analyzePair(pair);

      const analyses =
        result.analyses;

      const ranked =
        rankCandidates(
          analyses
        );

      const selected =
        ranked.length
          ? ranked[0]
          : analyses[0] || null;

      return res.json(
        buildApiResponse(
          selected,
          ranked
        )
      );
    } catch (error) {
      console.error(
        'GET /api/analyze error:',
        error
      );

      return res.status(200).json(
        buildApiResponse(
          null,
          []
        )
      );
    }
  }
);

/*
============================================================
/api/health
============================================================
*/

app.get(
  '/api/health',
  (req, res) => {
    resetDailyIfNeeded();

    const cachedPairCount =
      Array.from(
        pairCache.values()
      ).filter(
        item =>
          item &&
          nowMs() -
            item.createdAt <=
            PAIR_CACHE_TTL_MS
      ).length;

    res.json({
      ok: true,

      version: VERSION,

      source: SOURCE,

      timezone: TIMEZONE,

      apiKeyConfigured:
        Boolean(
          TWELVE_DATA_API_KEY
        ),

      pairs:
        PAIRS.length,

      supportedTimeframes:
        TIMEFRAMES,

      cachedPairs:
        cachedPairCount,

      cachedResults:
        bestResultCache.response
          ? 1
          : 0,

      scanRunning,

      scanCursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      lastScanAt,

      lastScanError,

      totalScanned,

      totalFailed,

      totalApiRequests,

      providerRequestsThisMinute:
        providerRequestsThisMinute(),

      providerMinuteLimit:
        PROVIDER_HARD_LIMIT,

      providerSafeMinuteLimit:
        PROVIDER_SAFE_LIMIT,

      dailyLimit:
        DAILY_LIMIT,

      dailySafetyReserve:
        DAILY_SAFETY_RESERVE,

      maxDailyRequests:
        DAILY_REQUEST_LIMIT,

      dailyCreditsUsed,

      dailyCreditsRemaining:
        dailyCreditsRemaining(),

      freshness: {
        1: MAX_DATA_AGE_BY_TF[1],
        2: MAX_DATA_AGE_BY_TF[2],
        3: MAX_DATA_AGE_BY_TF[3]
      },

      hardStaleSeconds:
        HARD_STALE_SECONDS
    });
  }
);

/*
============================================================
/api/pairs
============================================================
*/

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

/*
============================================================
ROOT
============================================================
*/

app.get(
  '/',
  (req, res) => {
    res.json({
      ok: true,
      app:
        'PO AI Predictor',
      version:
        VERSION,
      source:
        SOURCE,
      status:
        'LIVE',
      endpoints: [
        '/api/health',
        '/api/pairs',
        '/api/best',
        '/api/analyze?pair=EUR/USD'
      ]
    });
  }
);

/*
============================================================
404
============================================================
*/

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      version: VERSION,
      error:
        'Endpoint not found'
    });
  }
);

/*
============================================================
START
============================================================
*/

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
      `Timeframes: ${TIMEFRAMES.join(', ')}`
    );

    console.log(
      `Provider safe limit: ${PROVIDER_SAFE_LIMIT}/min`
    );

    console.log(
      `Daily safe limit: ${DAILY_REQUEST_LIMIT}`
    );

    /*
    First scan after startup.

    We do NOT immediately hammer Twelve Data.
    */
    setTimeout(
      () => {
        scanBatch().catch(
          error => {
            console.error(
              'Initial scan error:',
              error
            );
          }
        );
      },
      5000
    );

    /*
    Continue rotating through pairs.

    scanBatch() itself has a lock, so even if a previous
    scan is still running, a duplicate scan cannot start.
    */
    setInterval(
      () => {
        if (!scanRunning) {
          scanBatch().catch(
            error => {
              console.error(
                'Background scan error:',
                error
              );
            }
          );
        }
      },
      SCAN_INTERVAL_MS
    );
  }
);
