'use strict';

/*
===========================================================
 PO AI PREDICTOR
 V8.6.2 • QUOTA-SAFE SMART LIVE SCANNER

 SOURCE:
 Twelve Data LIVE ONLY

 FEATURES:
 • 24 LIVE forex pairs
 • 1m / 2m / 3m
 • EMA9 / EMA21
 • RSI14
 • MACD
 • Stochastic 14/3/3
 • CCI20
 • ATR14
 • ADX14
 • Support / Resistance
 • Candlestick patterns
 • Price-action market psychology
 • Smart CALL / PUT / NO TRADE
 • Automatic WIN / LOSS / DRAW settlement
 • Persistent in-memory best-market fallback
 • Quota-safe max 7 requests/minute
 • Automatic settlement every 10 seconds
===========================================================
*/

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const VERSION = 'V8.6.2';

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || '';

const TWELVE_DATA_URL =
  'https://api.twelvedata.com/time_series';

/* =========================================================
   CONFIG
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

const MAX_CANDLES = 180;
const MIN_CANDLES = 60;

/*
IMPORTANT:

Twelve Data account observed limit:
8 credits/minute.

We intentionally stay at:
7 requests/minute.

This leaves one request of safety margin.
*/
const REQUEST_LIMIT_PER_MINUTE = 7;

/*
7 pairs per scan batch.

24 pairs therefore rotate across approximately
4 scan cycles.
*/
const SCAN_BATCH_SIZE = 7;

/*
V8.6.2:
Instead of waiting 15 minutes between batches,
we rotate one batch every minute.

This gives:

Minute 1 -> pairs 1-7
Minute 2 -> pairs 8-14
Minute 3 -> pairs 15-21
Minute 4 -> pairs 22-24

The result cache remains valid for 15 minutes.
*/
const SCAN_EVERY_MS = 60 * 1000;

const SETTLEMENT_INTERVAL_MS =
  10 * 1000;

const ENTRY_BUFFER_SECONDS = 30;

const SETTLEMENT_GRACE_SECONDS = 10;

/*
This is only the "freshness" marker.

IMPORTANT:
A result becoming older than 30 seconds
does NOT delete the last valid selected market.

That is the main V8.6.2 fix.
*/
const RESULT_FRESH_MS = 30 * 1000;

/*
Cached pair candle data may be retained for 15 minutes.
*/
const CACHE_TTL_MS =
  15 * 60 * 1000;

/*
Daily safety budget.
*/
const DAILY_LIMIT = 768;
const SAFETY_RESERVE = 32;
const MAX_DAILY_REQUESTS =
  DAILY_LIMIT - SAFETY_RESERVE;

const HISTORY_SIZE = 5;

/* =========================================================
   MEMORY
========================================================= */

const pairCache = new Map();

const resultCache = new Map();

const signalHistory = [];

const requestTimes = [];

/*
Current scanner position.
*/
let scanCursor = 0;

let scanRunning = false;

let lastScanAt = null;

let lastScanError = null;

let totalScanned = 0;

let totalFailed = 0;

/*
Daily request counter.
*/
let dailyRequests = 0;

let dailyDate = utcDateKey();

/*
Provider quota information.
*/
let lastProviderQuotaMessage = null;

let lastProviderQuotaResetAt = null;

/*
===========================================================
CRITICAL V8.6.2 FALLBACK

This object is deliberately NOT deleted when it becomes
older than RESULT_FRESH_MS.

That prevents:

"No fresh selected market is currently available."

from appearing simply because 30 seconds elapsed.
===========================================================
*/

let lastSelected = null;

let lastSelectedAt = null;

/* =========================================================
   BASIC HELPERS
========================================================= */

function utcDateKey() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function resetDailyIfNeeded() {
  const today = utcDateKey();

  if (today !== dailyDate) {
    dailyDate = today;
    dailyRequests = 0;
  }
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function num(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function avg(values) {
  if (!values.length) {
    return null;
  }

  return values.reduce(
    (a, b) => a + b,
    0
  ) / values.length;
}

function fmt(value, decimals = 5) {
  if (value == null) {
    return null;
  }

  return Number(
    Number(value).toFixed(decimals)
  );
}

/* =========================================================
   QUOTA
========================================================= */

function quotaState() {
  resetDailyIfNeeded();

  const now = Date.now();

  while (
    requestTimes.length &&
    requestTimes[0] <= now - 60000
  ) {
    requestTimes.shift();
  }

  const used = requestTimes.length;

  return {
    usedLastMinute: used,

    remaining: Math.max(
      0,
      REQUEST_LIMIT_PER_MINUTE - used
    ),

    minuteBlocked:
      used >= REQUEST_LIMIT_PER_MINUTE,

    dailyRequests,

    dailyRemaining:
      Math.max(
        0,
        MAX_DAILY_REQUESTS - dailyRequests
      )
  };
}

async function acquireRequestSlot() {
  resetDailyIfNeeded();

  if (
    dailyRequests >=
    MAX_DAILY_REQUESTS
  ) {
    throw new Error(
      'Daily safety budget reached.'
    );
  }

  while (true) {
    const now = Date.now();

    while (
      requestTimes.length &&
      requestTimes[0] <= now - 60000
    ) {
      requestTimes.shift();
    }

    if (
      requestTimes.length <
      REQUEST_LIMIT_PER_MINUTE
    ) {
      requestTimes.push(Date.now());

      dailyRequests++;

      return;
    }

    const wait =
      Math.max(
        250,
        requestTimes[0] +
          60000 -
          now +
          50
      );

    await sleep(
      Math.min(wait, 5000)
    );
  }
}

/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchCandles(
  pair,
  outputsize = MAX_CANDLES
) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      'TWELVE_DATA_API_KEY is not configured.'
    );
  }

  await acquireRequestSlot();

  const url =
    `${TWELVE_DATA_URL}` +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=1min` +
    `&outputsize=${outputsize}` +
    `&order=ASC` +
    `&apikey=${encodeURIComponent(
      TWELVE_DATA_API_KEY
    )}`;

  const response =
    await fetch(url);

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Twelve Data HTTP ${response.status}: invalid JSON`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  if (
    data.status === 'error' ||
    data.code
  ) {
    const message =
      data.message ||
      'Twelve Data error';

    if (
      /credit|quota|limit|rate/i
        .test(message)
    ) {
      lastProviderQuotaMessage =
        message;

      lastProviderQuotaResetAt =
        new Date(
          Date.now() + 60000
        ).toISOString();
    }

    throw new Error(message);
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      'Twelve Data returned no candle values.'
    );
  }

  return data.values
    .map(value => {
      const rawTime =
        String(value.datetime);

      const normalized =
        rawTime.endsWith('Z')
          ? rawTime
          : rawTime.replace(
              ' ',
              'T'
            ) + 'Z';

      return {
        time:
          new Date(
            normalized
          ).getTime(),

        open:
          num(value.open),

        high:
          num(value.high),

        low:
          num(value.low),

        close:
          num(value.close)
      };
    })
    .filter(candle =>
      candle.time &&
      candle.open != null &&
      candle.high != null &&
      candle.low != null &&
      candle.close != null
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

/* =========================================================
   TIMEFRAME AGGREGATION
========================================================= */

function aggregateCandles(
  oneMinuteCandles,
  timeframe
) {
  if (timeframe === 1) {
    return oneMinuteCandles.slice();
  }

  const buckets = new Map();

  const bucketMs =
    timeframe * 60000;

  for (
    const candle
    of oneMinuteCandles
  ) {
    const key =
      Math.floor(
        candle.time / bucketMs
      ) * bucketMs;

    let bucket =
      buckets.get(key);

    if (!bucket) {
      bucket = {
        time: key,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        count: 0
      };

      buckets.set(
        key,
        bucket
      );
    }

    bucket.high =
      Math.max(
        bucket.high,
        candle.high
      );

    bucket.low =
      Math.min(
        bucket.low,
        candle.low
      );

    bucket.close =
      candle.close;

    bucket.count++;
  }

  return [
    ...buckets.values()
  ]
    .filter(
      bucket =>
        bucket.count === timeframe
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(
  values,
  period
) {
  if (
    values.length < period
  ) {
    return null;
  }

  let current =
    avg(
      values.slice(
        0,
        period
      )
    );

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    current =
      values[i] *
        multiplier +
      current *
        (1 - multiplier);
  }

  return current;
}

function rsi(
  values,
  period = 14
) {
  if (
    values.length <= period
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

  return (
    100 -
    100 / (1 + rs)
  );
}

function macd(values) {
  if (
    values.length < 35
  ) {
    return null;
  }

  const fast =
    ema(values, 12);

  const slow =
    ema(values, 26);

  if (
    fast == null ||
    slow == null
  ) {
    return null;
  }

  return {
    line:
      fast - slow
  };
}

function stochastic(
  candles
) {
  if (
    candles.length < 17
  ) {
    return null;
  }

  const recent =
    candles.slice(-14);

  const highest =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const lowest =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

  const last =
    candles.at(-1);

  const k =
    highest === lowest
      ? 50
      : (
          (
            last.close -
            lowest
          ) /
          (
            highest -
            lowest
          )
        ) * 100;

  const kValues = [];

  for (
    let i =
      Math.max(
        13,
        candles.length - 5
      );

    i < candles.length;

    i++
  ) {
    const window =
      candles.slice(
        i - 13,
        i + 1
      );

    const high =
      Math.max(
        ...window.map(
          c => c.high
        )
      );

    const low =
      Math.min(
        ...window.map(
          c => c.low
        )
      );

    const value =
      high === low
        ? 50
        : (
            (
              candles[i].close -
              low
            ) /
            (high - low)
          ) * 100;

    kValues.push(value);
  }

  return {
    k,
    d:
      avg(
        kValues.slice(-3)
      )
  };
}

function cci(
  candles,
  period = 20
) {
  if (
    candles.length < period
  ) {
    return null;
  }

  const typicalPrices =
    candles.map(
      candle =>
        (
          candle.high +
          candle.low +
          candle.close
        ) / 3
    );

  const recent =
    typicalPrices.slice(
      -period
    );

  const mean =
    avg(recent);

  const meanDeviation =
    avg(
      recent.map(
        value =>
          Math.abs(
            value - mean
          )
      )
    );

  if (!meanDeviation) {
    return 0;
  }

  return (
    (
      typicalPrices.at(-1) -
      mean
    ) /
    (
      0.015 *
      meanDeviation
    )
  );
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

  const trueRanges = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    trueRanges.push(
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

  return avg(
    trueRanges.slice(
      -period
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

  const trueRanges = [];
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

    trueRanges.push(
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

    const upMove =
      current.high -
      previous.high;

    const downMove =
      previous.low -
      current.low;

    plusDM.push(
      upMove >
        downMove &&
      upMove > 0
        ? upMove
        : 0
    );

    minusDM.push(
      downMove >
        upMove &&
      downMove > 0
        ? downMove
        : 0
    );
  }

  const tr =
    avg(
      trueRanges.slice(
        -period
      )
    );

  if (!tr) {
    return 0;
  }

  const plus =
    100 *
    avg(
      plusDM.slice(
        -period
      )
    ) /
    tr;

  const minus =
    100 *
    avg(
      minusDM.slice(
        -period
      )
    ) /
    tr;

  return (
    100 *
    Math.abs(
      plus - minus
    ) /
    Math.max(
      0.000001,
      plus + minus
    )
  );
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
  candles
) {
  const recent =
    candles.slice(-20);

  return {
    support:
      Math.min(
        ...recent.map(
          candle =>
            candle.low
        )
      ),

    resistance:
      Math.max(
        ...recent.map(
          candle =>
            candle.high
        )
      )
  };
}

/* =========================================================
   CANDLESTICK PATTERNS
========================================================= */

function detectPatterns(
  candles
) {
  if (
    candles.length < 3
  ) {
    return {};
  }

  const previous =
    candles.at(-2);

  const current =
    candles.at(-1);

  const body =
    Math.abs(
      current.close -
      current.open
    );

  const range =
    current.high -
    current.low ||
    1;

  const lowerWick =
    Math.min(
      current.open,
      current.close
    ) -
    current.low;

  const upperWick =
    current.high -
    Math.max(
      current.open,
      current.close
    );

  const bullishEngulfing =
    previous.close <
      previous.open &&
    current.close >
      current.open &&
    current.open <=
      previous.close &&
    current.close >=
      previous.open;

  const bearishEngulfing =
    previous.close >
      previous.open &&
    current.close <
      current.open &&
    current.open >=
      previous.close &&
    current.close <=
      previous.open;

  const hammer =
    lowerWick >
      body * 2 &&
    upperWick <
      body * 0.8;

  const shootingStar =
    upperWick >
      body * 2 &&
    lowerWick <
      body * 0.8;

  const strongBullish =
    current.close >
      current.open &&
    body / range >
      0.6;

  const strongBearish =
    current.close <
      current.open &&
    body / range >
      0.6;

  return {
    bullishEngulfing,
    bearishEngulfing,
    hammer,
    shootingStar,
    strongBullish,
    strongBearish
  };
}

/* =========================================================
   MARKET PSYCHOLOGY
========================================================= */

function marketPsychology(
  candles,
  indicators
) {
  const recent =
    candles.slice(-5);

  const bullish =
    recent.filter(
      candle =>
        candle.close >
        candle.open
    ).length;

  const bearish =
    recent.filter(
      candle =>
        candle.close <
        candle.open
    ).length;

  const current =
    candles.at(-1);

  const body =
    Math.abs(
      current.close -
      current.open
    );

  const range =
    current.high -
      current.low ||
    1;

  let pressure =
    'BALANCED';

  if (bullish > bearish) {
    pressure =
      'BUYER_PRESSURE';
  }

  if (bearish > bullish) {
    pressure =
      'SELLER_PRESSURE';
  }

  if (
    indicators.stochastic &&
    indicators.rsi != null &&
    indicators.stochastic.k > 80 &&
    indicators.rsi > 60
  ) {
    pressure =
      'BUYERS_EXTENDED';
  }

  if (
    indicators.stochastic &&
    indicators.rsi != null &&
    indicators.stochastic.k < 20 &&
    indicators.rsi < 40
  ) {
    pressure =
      'SELLERS_EXTENDED';
  }

  return {
    pressure,

    bullishCandles:
      bullish,

    bearishCandles:
      bearish,

    rejectionRatio:
      fmt(
        (
          range - body
        ) / range,
        3
      )
  };
}

/* =========================================================
   ANALYSIS
========================================================= */

function analyzeCandles(
  candles,
  timeframe
) {
  if (
    candles.length <
    MIN_CANDLES
  ) {
    throw new Error(
      `${timeframe}m: insufficient aggregated candles (${candles.length}/${MIN_CANDLES}).`
    );
  }

  const closes =
    candles.map(
      candle =>
        candle.close
    );

  const currentPrice =
    closes.at(-1);

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const rsi14 =
    rsi(closes, 14);

  const macdData =
    macd(closes);

  const stochasticData =
    stochastic(candles);

  const cci20 =
    cci(candles, 20);

  const atr14 =
    atr(candles, 14);

  const adx14 =
    adx(candles, 14);

  const sr =
    supportResistance(
      candles
    );

  const patterns =
    detectPatterns(
      candles
    );

  let callScore = 0;
  let putScore = 0;

  /* EMA */

  if (
    ema9 != null &&
    ema21 != null
  ) {
    if (ema9 > ema21) {
      callScore += 18;
    } else if (
      ema9 < ema21
    ) {
      putScore += 18;
    }
  }

  /* RSI */

  if (rsi14 != null) {
    if (rsi14 >= 55) {
      callScore += 12;
    } else if (
      rsi14 <= 45
    ) {
      putScore += 12;
    }
  }

  /* MACD */

  if (macdData) {
    if (
      macdData.line > 0
    ) {
      callScore += 10;
    } else if (
      macdData.line < 0
    ) {
      putScore += 10;
    }
  }

  /* STOCHASTIC */

  if (stochasticData) {
    if (
      stochasticData.k >
        stochasticData.d &&
      stochasticData.k < 80
    ) {
      callScore += 10;
    } else if (
      stochasticData.k <
        stochasticData.d &&
      stochasticData.k > 20
    ) {
      putScore += 10;
    }
  }

  /* CCI20 */

  if (cci20 != null) {
    if (cci20 > 50) {
      callScore += 10;
    } else if (
      cci20 < -50
    ) {
      putScore += 10;
    }
  }

  /* ADX + trend */

  if (
    adx14 != null &&
    adx14 >= 18
  ) {
    if (
      ema9 != null &&
      ema21 != null &&
      ema9 > ema21
    ) {
      callScore += 8;
    } else if (
      ema9 != null &&
      ema21 != null &&
      ema9 < ema21
    ) {
      putScore += 8;
    }
  }

  /* Candle patterns */

  if (
    patterns.bullishEngulfing ||
    patterns.hammer ||
    patterns.strongBullish
  ) {
    callScore += 10;
  }

  if (
    patterns.bearishEngulfing ||
    patterns.shootingStar ||
    patterns.strongBearish
  ) {
    putScore += 10;
  }

  /* Support / resistance */

  if (
    currentPrice >
    sr.resistance
  ) {
    callScore += 5;
  } else if (
    currentPrice <
    sr.support
  ) {
    putScore += 5;
  }

  const strongest =
    Math.max(
      callScore,
      putScore
    );

  const difference =
    Math.abs(
      callScore -
      putScore
    );

  const total =
    callScore +
    putScore;

  let signal =
    'NO TRADE';

  let confidence = 40;

  /*
  Only issue a directional signal when
  there is enough score and enough separation.
  */

  if (
    total >= 55 &&
    difference >= 15
  ) {
    signal =
      callScore >
      putScore
        ? 'CALL'
        : 'PUT';

    confidence =
      clamp(
        55 +
          Math.round(
            (
              strongest /
              Math.max(
                1,
                total
              )
            ) *
              40
          ),
        55,
        95
      );
  }

  const psychology =
    marketPsychology(
      candles,
      {
        stochastic:
          stochasticData,

        rsi:
          rsi14
      }
    );

  const reasons = [];

  if (
    ema9 != null &&
    ema21 != null
  ) {
    reasons.push(
      ema9 > ema21
        ? 'EMA bullish'
        : 'EMA bearish'
    );
  }

  if (
    rsi14 != null
  ) {
    reasons.push(
      `RSI ${fmt(
        rsi14,
        1
      )}`
    );
  }

  if (
    stochasticData
  ) {
    reasons.push(
      `Stoch K ${fmt(
        stochasticData.k,
        1
      )} / D ${fmt(
        stochasticData.d,
        1
      )}`
    );
  }

  if (
    cci20 != null
  ) {
    reasons.push(
      `CCI20 ${fmt(
        cci20,
        1
      )}`
    );
  }

  if (macdData) {
    reasons.push(
      macdData.line > 0
        ? 'MACD bullish'
        : 'MACD bearish'
    );
  }

  if (
    adx14 != null
  ) {
    reasons.push(
      `ADX ${fmt(
        adx14,
        1
      )}`
    );
  }

  reasons.push(
    psychology.pressure
      .replaceAll(
        '_',
        ' '
      )
      .toLowerCase()
  );

  return {
    signal,

    confidence,

    currentPrice:
      fmt(
        currentPrice,
        5
      ),

    indicators: {
      ema9:
        fmt(
          ema9,
          5
        ),

      ema21:
        fmt(
          ema21,
          5
        ),

      rsi:
        fmt(
          rsi14,
          2
        ),

      macd:
        macdData
          ? fmt(
              macdData.line,
              6
            )
          : null,

      stochastic:
        stochasticData
          ? {
              k:
                fmt(
                  stochasticData.k,
                  2
                ),

              d:
                fmt(
                  stochasticData.d,
                  2
                )
            }
          : null,

      cci20:
        fmt(
          cci20,
          2
        ),

      atr:
        fmt(
          atr14,
          6
        ),

      adx:
        fmt(
          adx14,
          2
        ),

      support:
        fmt(
          sr.support,
          5
        ),

      resistance:
        fmt(
          sr.resistance,
          5
        ),

      candlestickPatterns:
        patterns,

      marketPsychology:
        psychology
    },

    reasons
  };
}

/* =========================================================
   ENTRY / EXPIRY
========================================================= */

function nextEntry(
  timeframe,
  now = Date.now()
) {
  const timeframeMs =
    timeframe * 60000;

  const nextBoundary =
    (
      Math.floor(
        now / timeframeMs
      ) + 1
    ) *
    timeframeMs;

  /*
  Never create an entry less than 30 seconds away.
  */

  if (
    nextBoundary -
      now <
    ENTRY_BUFFER_SECONDS *
      1000
  ) {
    return (
      nextBoundary +
      timeframeMs
    );
  }

  return nextBoundary;
}

/* =========================================================
   SIGNAL TRACKING
========================================================= */

function signalKey(
  pair,
  timeframe,
  entryTime,
  signal
) {
  return (
    `${pair}:${timeframe}:${entryTime}:${signal}`
  );
}

function registerSignal(
  result
) {
  if (
    result.signal ===
    'NO TRADE'
  ) {
    return null;
  }

  const entry =
    nextEntry(
      result.timeframe
    );

  const expiry =
    entry +
    result.timeframe *
      60000;

  const key =
    signalKey(
      result.pair,
      result.timeframe,
      entry,
      result.signal
    );

  const existing =
    signalHistory.find(
      item =>
        item.key === key
    );

  if (existing) {
    return existing;
  }

  const signal = {
    signalId:
      `PO862-${Date.now()}-${signalHistory.length + 1}`,

    key,

    pair:
      result.pair,

    timeframe:
      result.timeframe,

    signal:
      result.signal,

    confidence:
      result.confidence,

    analysisTime:
      new Date().toISOString(),

    entryTime:
      new Date(
        entry
      ).toISOString(),

    expiryTime:
      new Date(
        expiry
      ).toISOString(),

    predictedPrice:
      result.currentPrice,

    entryPrice:
      null,

    exitPrice:
      null,

    result:
      'PENDING',

    settledAt:
      null,

    settlementSource:
      null
  };

  signalHistory.unshift(
    signal
  );

  /*
  Keep newest signals only.
  */

  if (
    signalHistory.length >
    HISTORY_SIZE
  ) {
    signalHistory.length =
      HISTORY_SIZE;
  }

  return signal;
}

/* =========================================================
   RESULT OBJECT
========================================================= */

function makeResult(
  pair,
  timeframe,
  analysis
) {
  const entry =
    nextEntry(
      timeframe
    );

  const expiry =
    entry +
    timeframe *
      60000;

  const result = {
    ...analysis,

    pair,

    timeframe,

    entryTime:
      new Date(
        entry
      ).toISOString(),

    expiryTime:
      new Date(
        expiry
      ).toISOString(),

    resultStatus:
      'PENDING'
  };

  const signal =
    registerSignal(
      result
    );

  if (signal) {
    result.signalId =
      signal.signalId;

    result.resultStatus =
      signal.result;
  }

  return result;
}

/* =========================================================
   BEST MARKET SELECTION
========================================================= */

function chooseBest() {
  const now =
    Date.now();

  const candidates =
    [
      ...resultCache.values()
    ].filter(result => {
      const entry =
        new Date(
          result.entryTime
        ).getTime();

      return (
        result.signal !==
          'NO TRADE' &&
        result.confidence >=
          55 &&
        entry > now
      );
    });

  if (!candidates.length) {
    return lastSelected;
  }

  candidates.sort(
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
        new Date(
          a.entryTime
        ).getTime() -
        new Date(
          b.entryTime
        ).getTime()
      );
    }
  );

  const best =
    candidates[0];

  lastSelected = {
    ...best,

    selectedAt:
      new Date().toISOString(),

    fresh:
      true,

    stale:
      false
  };

  lastSelectedAt =
    Date.now();

  return lastSelected;
}

/*
===========================================================
V8.6.2 FIX

Fresh result:
    fresh=true
    stale=false

Older than 30 sec:
    fresh=false
    stale=true

BUT:
    lastSelected remains available.

Therefore /api/best does NOT become empty
just because RESULT_FRESH_MS expired.
===========================================================
*/

function getBest() {
  const now =
    Date.now();

  if (
    lastSelected &&
    lastSelectedAt
  ) {
    const age =
      now -
      lastSelectedAt;

    const isFresh =
      age <=
      RESULT_FRESH_MS;

    return {
      ...lastSelected,

      fresh:
        isFresh,

      stale:
        !isFresh,

      staleSeconds:
        Math.floor(
          age / 1000
        )
    };
  }

  /*
  Fallback to cached results if
  lastSelected has not been initialized.
  */

  const selected =
    chooseBest();

  if (selected) {
    return {
      ...selected,

      fresh: false,

      stale: true
    };
  }

  return null;
}

/* =========================================================
   SCANNER
========================================================= */

async function scanBatch() {
  if (scanRunning) {
    return;
  }

  scanRunning = true;

  lastScanError = null;

  const start =
    scanCursor;

  const batch =
    Array.from(
      {
        length:
          Math.min(
            SCAN_BATCH_SIZE,
            PAIRS.length
          )
      },
      (_, index) =>
        PAIRS[
          (start + index) %
            PAIRS.length
        ]
    );

  scanCursor =
    (
      start +
      batch.length
    ) %
    PAIRS.length;

  try {
    for (
      const pair
      of batch
    ) {
      try {
        /*
        One Twelve Data request per pair.

        All 1m / 2m / 3m analyses
        are built locally from this data.
        */

        const candles =
          await fetchCandles(
            pair,
            MAX_CANDLES
          );

        pairCache.set(
          pair,
          {
            candles,

            updatedAt:
              Date.now()
          }
        );

        for (
          const timeframe
          of TIMEFRAMES
        ) {
          try {
            const aggregated =
              aggregateCandles(
                candles,
                timeframe
              );

            const analysis =
              analyzeCandles(
                aggregated,
                timeframe
              );

            const result =
              makeResult(
                pair,
                timeframe,
                analysis
              );

            resultCache.set(
              `${pair}:${timeframe}`,
              {
                ...result,

                cachedAt:
                  Date.now()
              }
            );
          } catch (error) {
            /*
            A single timeframe problem
            must not crash the whole pair.
            */

            lastScanError =
              `${pair}: ${error.message}`;
          }
        }

        totalScanned++;
      } catch (error) {
        totalFailed++;

        lastScanError =
          `${pair}: ${error.message}`;
      }
    }

    /*
    Select best after batch.
    */

    chooseBest();
  } finally {
    lastScanAt =
      new Date().toISOString();

    scanRunning = false;
  }
}

/* =========================================================
   AUTOMATIC SETTLEMENT
========================================================= */

async function settleDueSignals() {
  const now =
    Date.now();

  const due =
    signalHistory.filter(
      signal => {
        if (
          signal.result !==
          'PENDING'
        ) {
          return false;
        }

        const expiry =
          new Date(
            signal.expiryTime
          ).getTime();

        return (
          expiry +
            SETTLEMENT_GRACE_SECONDS *
              1000 <=
          now
        );
      }
    );

  if (!due.length) {
    return;
  }

  /*
  Group signals by pair.

  One fresh Twelve Data request can
  settle multiple timeframes/signals
  for the same pair.
  */

  const byPair =
    new Map();

  for (
    const signal
    of due
  ) {
    if (
      !byPair.has(
        signal.pair
      )
    ) {
      byPair.set(
        signal.pair,
        []
      );
    }

    byPair
      .get(signal.pair)
      .push(signal);
  }

  for (
    const [
      pair,
      signals
    ] of byPair
  ) {
    try {
      /*
      This request is quota-controlled
      by acquireRequestSlot().
      */

      const candles =
        await fetchCandles(
          pair,
          MAX_CANDLES
        );

      pairCache.set(
        pair,
        {
          candles,

          updatedAt:
            Date.now()
        }
      );

      for (
        const signal
        of signals
      ) {
        const timeframe =
          signal.timeframe;

        const aggregated =
          aggregateCandles(
            candles,
            timeframe
          );

        const entryTime =
          new Date(
            signal.entryTime
          ).getTime();

        const expiryTime =
          new Date(
            signal.expiryTime
          ).getTime();

        /*
        Entry candle:
        use its OPEN.

        Expiry candle:
        use its CLOSE.
        */

        const entryCandle =
          aggregated.find(
            candle =>
              candle.time ===
              entryTime
          );

        let expiryCandle =
          aggregated.find(
            candle =>
              candle.time ===
              expiryTime
          );

        /*
        Safety fallback:
        if provider candle alignment
        differs by one timeframe bucket,
        use previous matching bucket.
        */

        if (
          !expiryCandle
        ) {
          expiryCandle =
            aggregated.find(
              candle =>
                candle.time ===
                (
                  expiryTime -
                  timeframe *
                    60000
                )
            );
        }

        if (
          !entryCandle ||
          !expiryCandle
        ) {
          /*
          Keep PENDING.

          Next settlement cycle will retry.
          */

          continue;
        }

        signal.entryPrice =
          entryCandle.open;

        signal.exitPrice =
          expiryCandle.close;

        if (
          signal.exitPrice ===
          signal.entryPrice
        ) {
          signal.result =
            'DRAW';
        } else if (
          signal.signal ===
          'CALL'
        ) {
          signal.result =
            signal.exitPrice >
            signal.entryPrice
              ? 'WIN'
              : 'LOSS';
        } else {
          signal.result =
            signal.exitPrice <
            signal.entryPrice
              ? 'WIN'
              : 'LOSS';
        }

        signal.settledAt =
          new Date().toISOString();

        signal.settlementSource =
          'Twelve Data LIVE candle';
      }
    } catch (error) {
      lastScanError =
        `Settlement ${pair}: ${error.message}`;
    }
  }
}

/* =========================================================
   PERFORMANCE
========================================================= */

function getPerformance() {
  const total =
    signalHistory.length;

  const pending =
    signalHistory.filter(
      signal =>
        signal.result ===
        'PENDING'
    ).length;

  const wins =
    signalHistory.filter(
      signal =>
        signal.result ===
        'WIN'
    ).length;

  const losses =
    signalHistory.filter(
      signal =>
        signal.result ===
        'LOSS'
    ).length;

  const draws =
    signalHistory.filter(
      signal =>
        signal.result ===
        'DRAW'
    ).length;

  const settled =
    wins +
    losses +
    draws;

  const decisive =
    wins +
    losses;

  return {
    total,

    pending,

    wins,

    losses,

    draws,

    settled,

    decisive,

    winRate:
      decisive
        ? (
            wins /
            decisive
          ) * 100
        : null,

    winRateIncludingDraws:
      settled
        ? (
            wins /
            settled
          ) * 100
        : null
  };
}

/* =========================================================
   HEALTH
========================================================= */

function healthData() {
  const quota =
    quotaState();

  return {
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
      TIMEFRAMES,

    cachedPairs:
      pairCache.size,

    cachedResults:
      resultCache.size,

    scanRunning,

    scanCursor,

    scanBatchSize:
      SCAN_BATCH_SIZE,

    lastScanAt,

    lastScanError,

    totalScanned,

    totalFailed,

    quotaBlocked:
      false,

    providerQuotaMessage:
      lastProviderQuotaMessage,

    providerQuotaResetAt:
      lastProviderQuotaResetAt,

    minuteBlocked:
      quota.minuteBlocked,

    minuteRetryInSeconds:
      0,

    dailyRequests,

    dailyCreditsUsed:
      dailyRequests,

    apiBudget: {
      dailyLimit:
        DAILY_LIMIT,

      safetyReserve:
        SAFETY_RESERVE,

      maxDailyRequests:
        MAX_DAILY_REQUESTS,

      used:
        dailyRequests,

      remaining:
        quota.dailyRemaining
    },

    providerMinuteBudget: {
      configuredLimit:
        REQUEST_LIMIT_PER_MINUTE,

      usedLastMinute:
        quota.usedLastMinute,

      remaining:
        quota.remaining
    },

    cacheTTLMinutes:
      CACHE_TTL_MS / 60000,

    resultTTLSeconds:
      RESULT_FRESH_MS / 1000,

    /*
    V8.6.2 scanner rotates
    every minute.
    */

    scanEveryMinutes:
      SCAN_EVERY_MS / 60000,

    settlementIntervalSeconds:
      SETTLEMENT_INTERVAL_MS /
      1000,

    settlementGraceSeconds:
      SETTLEMENT_GRACE_SECONDS,

    indicators: {
      macd: true,

      stochastic: true,

      cci20: true,

      candlestickPatterns:
        true,

      marketPsychology:
        true
    },

    signalTracking: {
      historySize:
        HISTORY_SIZE,

      performance:
        getPerformance()
    },

    time:
      new Date().toISOString()
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

      name:
        'PO AI PREDICTOR',

      version:
        VERSION,

      source:
        'Twelve Data LIVE'
    });
  }
);

/* HEALTH */

app.get(
  '/api/health',
  (req, res) => {
    res.json(
      healthData()
    );
  }
);

/* SCANNER STATUS */

app.get(
  '/api/scanner',
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      running:
        scanRunning,

      cursor:
        scanCursor,

      lastScanAt,

      lastScanError,

      cachedPairs:
        pairCache.size,

      cachedResults:
        resultCache.size,

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   BEST MARKET
========================================================= */

app.get(
  '/api/best',
  (req, res) => {
    const selected =
      getBest();

    /*
    IMPORTANT:
    Do not return the old "No fresh..."
    error simply because the result is stale.
    */

    if (!selected) {
      return res.json({
        ok: false,

        error:
          'No selected market is currently available.',

        performance:
          getPerformance(),

        scan: {
          running:
            scanRunning,

          cursor:
            scanCursor,

          lastScanAt,

          lastScanError
        },

        time:
          new Date().toISOString()
      });
    }

    return res.json({
      ok: true,

      version:
        VERSION,

      selectedMarket:
        selected,

      /*
      Compatibility:
      some previous frontend versions
      expected "best".
      */

      best:
        selected,

      performance:
        getPerformance(),

      scan: {
        running:
          scanRunning,

        cursor:
          scanCursor,

        lastScanAt,

        lastScanError
      },

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   SELECTED MARKET
========================================================= */

app.get(
  '/api/selected',
  (req, res) => {
    const selected =
      getBest();

    if (!selected) {
      return res.json({
        ok: false,

        selectedMarket:
          null,

        error:
          'No selected market is currently available.',

        performance:
          getPerformance(),

        time:
          new Date().toISOString()
      });
    }

    res.json({
      ok: true,

      selectedMarket:
        selected,

      best:
        selected,

      performance:
        getPerformance(),

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   HISTORY
========================================================= */

app.get(
  '/api/history',
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      count:
        signalHistory.length,

      performance:
        getPerformance(),

      signals:
        signalHistory,

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   PERFORMANCE
========================================================= */

app.get(
  '/api/performance',
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      performance:
        getPerformance(),

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   MANUAL ANALYZE
========================================================= */

app.get(
  '/api/analyze',
  async (req, res) => {
    const pair =
      req.query.pair;

    if (
      !pair ||
      !PAIRS.includes(pair)
    ) {
      return res.status(400).json({
        ok: false,

        error:
          'Unsupported or missing pair.'
      });
    }

    try {
      /*
      Manual analysis uses one Twelve Data request
      and locally builds all three timeframes.
      */

      const candles =
        await fetchCandles(
          pair,
          MAX_CANDLES
        );

      pairCache.set(
        pair,
        {
          candles,

          updatedAt:
            Date.now()
        }
      );

      const results =
        TIMEFRAMES.map(
          timeframe => {
            const aggregated =
              aggregateCandles(
                candles,
                timeframe
              );

            const analysis =
              analyzeCandles(
                aggregated,
                timeframe
              );

            const result =
              makeResult(
                pair,
                timeframe,
                analysis
              );

            resultCache.set(
              `${pair}:${timeframe}`,
              {
                ...result,

                cachedAt:
                  Date.now()
              }
            );

            return result;
          }
        );

      chooseBest();

      res.json({
        ok: true,

        mode:
          'LIVE',

        pair,

        results,

        selected:
          getBest(),

        performance:
          getPerformance(),

        time:
          new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message,

        performance:
          getPerformance(),

        time:
          new Date().toISOString()
      });
    }
  }
);

/* =========================================================
   AUTOMATIC LOOPS
========================================================= */

/*
Scanner:
one 7-pair batch every minute.
*/

setInterval(
  () => {
    scanBatch()
      .catch(error => {
        lastScanError =
          error.message;

        scanRunning =
          false;
      });
  },
  SCAN_EVERY_MS
);

/*
Settlement:
every 10 seconds.

It does NOT wait for scanner.
*/

setInterval(
  () => {
    settleDueSignals()
      .catch(error => {
        lastScanError =
          error.message;
      });
  },
  SETTLEMENT_INTERVAL_MS
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `[${VERSION}] listening on ${PORT}`
    );

    console.log(
      `[${VERSION}] Twelve Data configured: ${Boolean(
        TWELVE_DATA_API_KEY
      )}`
    );

    console.log(
      `[${VERSION}] request limit: ${REQUEST_LIMIT_PER_MINUTE}/minute`
    );

    console.log(
      `[${VERSION}] scan batch: ${SCAN_BATCH_SIZE}`
    );

    console.log(
      `[${VERSION}] scan interval: ${SCAN_EVERY_MS / 60000} minute`
    );

    console.log(
      `[${VERSION}] settlement interval: ${SETTLEMENT_INTERVAL_MS / 1000}s`
    );

    /*
    Initial scan immediately after startup.
    */

    scanBatch()
      .catch(error => {
        lastScanError =
          error.message;
      });
  }
);
