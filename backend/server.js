/*
=========================================================
 PO AI PREDICTOR BACKEND V7.0
 LIVE ONLY
 DATA SOURCE: TWELVE DATA

 FEATURES
 --------------------------------------------------------
 • Twelve Data LIVE market data
 • 1-minute candles
 • Local 2-minute candle aggregation
 • Local 3-minute candle aggregation
 • EMA 9 / EMA 21
 • RSI 14
 • MACD 12 / 26 / 9
 • Bollinger Bands 20 / 2
 • ATR 14
 • Stochastic 14 / 3 / 3
 • Support / Resistance
 • Momentum
 • Volatility filter
 • Market condition detection
 • Multi-factor signal scoring
 • CALL / PUT / NO TRADE
 • Confidence score
 • Signal reasons
 • Data cache
 • API retry
 • Health endpoint
 • Pair endpoint
 • Analysis endpoint

 IMPORTANT
 --------------------------------------------------------
 This is an analysis engine.
 It does NOT guarantee winning trades.
=========================================================
*/

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ======================================================
   CONFIGURATION
====================================================== */

const VERSION = "V7.0";

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const TWELVE_DATA_URL =
  "https://api.twelvedata.com/time_series";

const INTERVAL = "1min";

/*
  Number of 1-minute candles downloaded.

  We need enough candles for:
  EMA
  RSI
  MACD
  Bollinger
  ATR
  Stochastic
  Support/Resistance
*/
const MAX_CANDLES = 250;

/*
  Cache lifetime.
  Twelve Data should not be requested repeatedly
  for the same pair within a few seconds.
*/
const CACHE_TTL = 15000;

/*
  Use only completed candles.

  The latest 1-minute candle may still be forming.
*/
const USE_CLOSED_CANDLES = true;

/*
  Minimum candles required.
*/
const MIN_CANDLES = 80;


/* ======================================================
   SUPPORTED LIVE PAIRS
====================================================== */

const PAIRS = {
  "EUR/USD": "EUR/USD",
  "GBP/USD": "GBP/USD",
  "USD/JPY": "USD/JPY",
  "USD/CHF": "USD/CHF",
  "AUD/USD": "AUD/USD",
  "USD/CAD": "USD/CAD",
  "NZD/USD": "NZD/USD",
  "EUR/GBP": "EUR/GBP",
  "EUR/JPY": "EUR/JPY",
  "GBP/JPY": "GBP/JPY",

  // Additional major/minor FX pairs
  "AUD/JPY": "AUD/JPY",
  "CAD/JPY": "CAD/JPY",
  "CHF/JPY": "CHF/JPY",
  "EUR/AUD": "EUR/AUD",
  "EUR/CAD": "EUR/CAD",
  "EUR/CHF": "EUR/CHF",
  "GBP/AUD": "GBP/AUD",
  "GBP/CAD": "GBP/CAD",
  "GBP/CHF": "GBP/CHF",
  "NZD/JPY": "NZD/JPY",
  "NZD/CAD": "NZD/CAD",
  "AUD/CAD": "AUD/CAD",
  "AUD/CHF": "AUD/CHF",
  "CAD/CHF": "CAD/CHF"
};


/* ======================================================
   CACHE
====================================================== */

const marketCache = new Map();


/* ======================================================
   BASIC HELPERS
====================================================== */

function round(value, decimals = 5) {
  if (!Number.isFinite(value)) return null;

  const factor = Math.pow(10, decimals);

  return Math.round(value * factor) / factor;
}


function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


function average(values) {
  const valid = values.filter(Number.isFinite);

  if (!valid.length) return null;

  return valid.reduce((a, b) => a + b, 0) / valid.length;
}


function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);

  if (valid.length < 2) return null;

  const mean = average(valid);

  const variance =
    valid.reduce(
      (sum, value) => sum + Math.pow(value - mean, 2),
      0
    ) / valid.length;

  return Math.sqrt(variance);
}


/* ======================================================
   EMA
====================================================== */

function calculateEMA(values, period) {
  if (!values || values.length < period) {
    return Array(values ? values.length : 0).fill(null);
  }

  const result = Array(values.length).fill(null);

  const multiplier = 2 / (period + 1);

  let previous = average(values.slice(0, period));

  result[period - 1] = previous;

  for (let i = period; i < values.length; i++) {
    previous =
      (values[i] - previous) * multiplier + previous;

    result[i] = previous;
  }

  return result;
}


/* ======================================================
   SMA
====================================================== */

function calculateSMA(values, period) {
  const result = Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    result[i] = average(
      values.slice(i - period + 1, i + 1)
    );
  }

  return result;
}


/* ======================================================
   RSI
====================================================== */

function calculateRSI(closes, period = 14) {
  const result = Array(closes.length).fill(null);

  if (closes.length <= period) {
    return result;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  if (averageLoss === 0) {
    result[period] = 100;
  } else {
    const rs = averageGain / averageLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;

    if (averageLoss === 0) {
      result[i] = 100;
    } else {
      const rs = averageGain / averageLoss;

      result[i] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}


/* ======================================================
   MACD
====================================================== */

function calculateMACD(
  closes,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  const fastEMA = calculateEMA(closes, fastPeriod);
  const slowEMA = calculateEMA(closes, slowPeriod);

  const macd = Array(closes.length).fill(null);

  for (let i = 0; i < closes.length; i++) {
    if (
      fastEMA[i] !== null &&
      slowEMA[i] !== null
    ) {
      macd[i] = fastEMA[i] - slowEMA[i];
    }
  }

  const macdValues = macd.filter(
    value => value !== null
  );

  const signalCompact = calculateEMA(
    macdValues,
    signalPeriod
  );

  const signal = Array(closes.length).fill(null);

  let compactIndex = 0;

  for (let i = 0; i < closes.length; i++) {
    if (macd[i] !== null) {
      signal[i] = signalCompact[compactIndex];
      compactIndex++;
    }
  }

  const histogram = Array(closes.length).fill(null);

  for (let i = 0; i < closes.length; i++) {
    if (
      macd[i] !== null &&
      signal[i] !== null
    ) {
      histogram[i] = macd[i] - signal[i];
    }
  }

  return {
    macd,
    signal,
    histogram
  };
}


/* ======================================================
   BOLLINGER BANDS
====================================================== */

function calculateBollinger(
  closes,
  period = 20,
  multiplier = 2
) {
  const middle = calculateSMA(closes, period);

  const upper = Array(closes.length).fill(null);
  const lower = Array(closes.length).fill(null);
  const bandwidth = Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(
      i - period + 1,
      i + 1
    );

    const sd = standardDeviation(window);

    if (sd === null || middle[i] === null) {
      continue;
    }

    upper[i] =
      middle[i] + multiplier * sd;

    lower[i] =
      middle[i] - multiplier * sd;

    if (middle[i] !== 0) {
      bandwidth[i] =
        (upper[i] - lower[i]) /
        middle[i];
    }
  }

  return {
    upper,
    middle,
    lower,
    bandwidth
  };
}


/* ======================================================
   TRUE RANGE
====================================================== */

function calculateTrueRange(candles) {
  const tr = Array(candles.length).fill(null);

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    if (i === 0) {
      tr[i] = candle.high - candle.low;
      continue;
    }

    const previousClose =
      candles[i - 1].close;

    const range1 =
      candle.high - candle.low;

    const range2 =
      Math.abs(candle.high - previousClose);

    const range3 =
      Math.abs(candle.low - previousClose);

    tr[i] =
      Math.max(range1, range2, range3);
  }

  return tr;
}


/* ======================================================
   ATR
====================================================== */

function calculateATR(candles, period = 14) {
  const tr = calculateTrueRange(candles);

  const atr = Array(candles.length).fill(null);

  if (tr.length < period) {
    return atr;
  }

  let initial = average(
    tr.slice(0, period)
  );

  atr[period - 1] = initial;

  for (let i = period; i < tr.length; i++) {
    initial =
      ((initial * (period - 1)) + tr[i]) /
      period;

    atr[i] = initial;
  }

  return atr;
}


/* ======================================================
   STOCHASTIC
====================================================== */

function calculateStochastic(
  candles,
  period = 14,
  smoothK = 3,
  smoothD = 3
) {
  const rawK =
    Array(candles.length).fill(null);

  for (
    let i = period - 1;
    i < candles.length;
    i++
  ) {
    const window =
      candles.slice(
        i - period + 1,
        i + 1
      );

    const highestHigh =
      Math.max(...window.map(c => c.high));

    const lowestLow =
      Math.min(...window.map(c => c.low));

    const range =
      highestHigh - lowestLow;

    if (range === 0) {
      rawK[i] = 50;
    } else {
      rawK[i] =
        ((candles[i].close - lowestLow) /
          range) *
        100;
    }
  }

  const k = calculateSMA(
    rawK.map(v => v ?? 50),
    smoothK
  );

  const d = calculateSMA(
    k.map(v => v ?? 50),
    smoothD
  );

  /*
    Restore nulls before enough data exists.
  */
  for (let i = 0; i < period - 1; i++) {
    k[i] = null;
    d[i] = null;
  }

  return {
    k,
    d
  };
}


/* ======================================================
   SUPPORT / RESISTANCE
====================================================== */

function calculateSupportResistance(
  candles,
  lookback = 30
) {
  const recent =
    candles.slice(-lookback);

  const lows =
    recent.map(c => c.low);

  const highs =
    recent.map(c => c.high);

  const support =
    Math.min(...lows);

  const resistance =
    Math.max(...highs);

  return {
    support,
    resistance
  };
}


/* ======================================================
   MOMENTUM
====================================================== */

function calculateMomentum(
  closes,
  period = 5
) {
  if (closes.length <= period) {
    return null;
  }

  const current =
    closes[closes.length - 1];

  const previous =
    closes[closes.length - 1 - period];

  if (previous === 0) {
    return null;
  }

  return (
    ((current - previous) /
      previous) *
    100
  );
}


/* ======================================================
   CANDLE NORMALIZATION
====================================================== */

function normalizeCandles(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const candles = values
    .map(item => ({
      datetime: item.datetime,

      open: Number(item.open),

      high: Number(item.high),

      low: Number(item.low),

      close: Number(item.close),

      volume:
        item.volume !== undefined
          ? Number(item.volume)
          : null
    }))
    .filter(c =>
      c.datetime &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    );

  /*
    Twelve Data normally returns newest first.
    We want oldest -> newest.
  */
  candles.sort(
    (a, b) =>
      new Date(a.datetime) -
      new Date(b.datetime)
  );

  return candles;
}


/* ======================================================
   1-MIN -> N-MIN AGGREGATION
====================================================== */

function aggregateCandles(
  candles,
  minutes
) {
  if (minutes === 1) {
    return candles;
  }

  const result = [];

  /*
    Group by UTC minute buckets.
  */
  let bucket = null;

  for (const candle of candles) {
    const date =
      new Date(candle.datetime);

    const minute =
      date.getUTCMinutes();

    const bucketMinute =
      Math.floor(minute / minutes) *
      minutes;

    const key =
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        bucketMinute
      );

    if (
      bucket === null ||
      bucket.key !== key
    ) {
      bucket = {
        key,
        datetime:
          new Date(key).toISOString(),

        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,

        volume:
          Number.isFinite(candle.volume)
            ? candle.volume
            : null,

        count: 1
      };

      result.push(bucket);
    } else {
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

      if (
        Number.isFinite(candle.volume)
      ) {
        bucket.volume =
          (bucket.volume || 0) +
          candle.volume;
      }

      bucket.count++;
    }
  }

  /*
    Only keep complete groups where possible.
  */
  return result.filter(
    c => c.count >= minutes
  );
}


/* ======================================================
   DATA FETCH
====================================================== */

async function fetchTwelveData(
  symbol,
  retry = 1
) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const url =
    new URL(TWELVE_DATA_URL);

  url.searchParams.set(
    "symbol",
    symbol
  );

  url.searchParams.set(
    "interval",
    INTERVAL
  );

  url.searchParams.set(
    "outputsize",
    String(MAX_CANDLES)
  );

  url.searchParams.set(
    "order",
    "asc"
  );

  url.searchParams.set(
    "apikey",
    TWELVE_DATA_API_KEY
  );

  let lastError = null;

  for (
    let attempt = 0;
    attempt <= retry;
    attempt++
  ) {
    try {
      const response =
        await fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json"
          }
        });

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      if (
        data.status === "error" ||
        data.code
      ) {
        throw new Error(
          data.message ||
          "Twelve Data API error"
        );
      }

      const candles =
        normalizeCandles(
          data.values
        );

      if (
        candles.length <
        MIN_CANDLES
      ) {
        throw new Error(
          `Not enough candles: ${candles.length}`
        );
      }

      return {
        candles,
        meta: data.meta || null
      };
    } catch (error) {
      lastError = error;

      if (attempt < retry) {
        await new Promise(
          resolve =>
            setTimeout(resolve, 1000)
        );
      }
    }
  }

  throw lastError ||
    new Error(
      "Unable to fetch market data"
    );
}


/* ======================================================
   CACHED MARKET DATA
====================================================== */

async function getMarketData(symbol) {
  const cached =
    marketCache.get(symbol);

  const now = Date.now();

  if (
    cached &&
    now - cached.timestamp <
      CACHE_TTL
  ) {
    return {
      ...cached.data,
      cache: "HIT"
    };
  }

  const fresh =
    await fetchTwelveData(symbol);

  let candles =
    fresh.candles;

  /*
    Remove latest candle if configured.
    This avoids analyzing a candle that is still forming.
  */
  if (
    USE_CLOSED_CANDLES &&
    candles.length > 1
  ) {
    candles =
      candles.slice(
        0,
        candles.length - 1
      );
  }

  const result = {
    candles,
    meta: fresh.meta,
    fetchedAt:
      new Date().toISOString()
  };

  marketCache.set(symbol, {
    timestamp: now,
    data: result
  });

  return {
    ...result,
    cache: "MISS"
  };
}


/* ======================================================
   MARKET CONDITION
====================================================== */

function detectMarketCondition(
  candles,
  indicators
) {
  const {
    ema9,
    ema21,
    atr,
    bollinger
  } = indicators;

  const i =
    candles.length - 1;

  const price =
    candles[i].close;

  const e9 =
    ema9[i];

  const e21 =
    ema21[i];

  const currentATR =
    atr[i];

  const middle =
    bollinger.middle[i];

  const upper =
    bollinger.upper[i];

  const lower =
    bollinger.lower[i];

  if (
    !Number.isFinite(e9) ||
    !Number.isFinite(e21)
  ) {
    return "UNKNOWN";
  }

  const trendDistance =
    Math.abs(e9 - e21) /
    price;

  let volatility =
    "NORMAL";

  if (
    currentATR !== null &&
    price > 0
  ) {
    const atrPercent =
      (currentATR / price) * 100;

    if (atrPercent < 0.015) {
      volatility = "LOW";
    } else if (atrPercent > 0.20) {
      volatility = "HIGH";
    }
  }

  let trend;

  if (trendDistance < 0.00008) {
    trend = "RANGING";
  } else if (e9 > e21) {
    trend = "UPTREND";
  } else {
    trend = "DOWNTREND";
  }

  if (
    upper !== null &&
    lower !== null &&
    middle !== null
  ) {
    const bandwidth =
      (upper - lower) /
      middle;

    if (
      bandwidth < 0.0005
    ) {
      return "LOW_VOLATILITY_RANGE";
    }
  }

  if (
    volatility === "HIGH"
  ) {
    return `HIGH_VOLATILITY_${trend}`;
  }

  return trend;
}


/* ======================================================
   BUILD INDICATORS
====================================================== */

function buildIndicators(candles) {
  const closes =
    candles.map(c => c.close);

  const ema9 =
    calculateEMA(closes, 9);

  const ema21 =
    calculateEMA(closes, 21);

  const rsi =
    calculateRSI(closes, 14);

  const macd =
    calculateMACD(
      closes,
      12,
      26,
      9
    );

  const bollinger =
    calculateBollinger(
      closes,
      20,
      2
    );

  const atr =
    calculateATR(
      candles,
      14
    );

  const stochastic =
    calculateStochastic(
      candles,
      14,
      3,
      3
    );

  const supportResistance =
    calculateSupportResistance(
      candles,
      30
    );

  const momentum =
    calculateMomentum(
      closes,
      5
    );

  return {
    closes,
    ema9,
    ema21,
    rsi,
    macd,
    bollinger,
    atr,
    stochastic,
    supportResistance,
    momentum
  };
}


/* ======================================================
   SIGNAL ENGINE
====================================================== */

function generateSignal(
  candles,
  indicators,
  timeframe
) {
  const i =
    candles.length - 1;

  const previous =
    Math.max(0, i - 1);

  const price =
    candles[i].close;

  const {
    ema9,
    ema21,
    rsi,
    macd,
    bollinger,
    atr,
    stochastic,
    supportResistance,
    momentum
  } = indicators;

  let callScore = 0;
  let putScore = 0;

  const callReasons = [];
  const putReasons = [];

  /*
  ======================================================
  EMA TREND
  ======================================================
  */

  if (
    ema9[i] !== null &&
    ema21[i] !== null
  ) {
    if (ema9[i] > ema21[i]) {
      callScore += 18;
      callReasons.push(
        "EMA9 above EMA21"
      );
    }

    if (ema9[i] < ema21[i]) {
      putScore += 18;
      putReasons.push(
        "EMA9 below EMA21"
      );
    }

    /*
      Fresh crossover gets additional weight.
    */

    if (
      ema9[previous] !== null &&
      ema21[previous] !== null
    ) {
      if (
        ema9[previous] <=
          ema21[previous] &&
        ema9[i] >
          ema21[i]
      ) {
        callScore += 8;
        callReasons.push(
          "Fresh bullish EMA crossover"
        );
      }

      if (
        ema9[previous] >=
          ema21[previous] &&
        ema9[i] <
          ema21[i]
      ) {
        putScore += 8;
        putReasons.push(
          "Fresh bearish EMA crossover"
        );
      }
    }
  }


  /*
  ======================================================
  PRICE VS EMA
  ======================================================
  */

  if (
    ema9[i] !== null &&
    ema21[i] !== null
  ) {
    if (
      price > ema9[i] &&
      price > ema21[i]
    ) {
      callScore += 10;

      callReasons.push(
        "Price above EMA9/EMA21"
      );
    }

    if (
      price < ema9[i] &&
      price < ema21[i]
    ) {
      putScore += 10;

      putReasons.push(
        "Price below EMA9/EMA21"
      );
    }
  }


  /*
  ======================================================
  RSI
  ======================================================
  */

  if (
    rsi[i] !== null
  ) {
    /*
      Bullish exit from oversold.
    */
    if (
      rsi[previous] !== null &&
      rsi[previous] < 30 &&
      rsi[i] >= 30
    ) {
      callScore += 14;

      callReasons.push(
        "RSI exited oversold upward"
      );
    }
    else if (
      rsi[i] > 50 &&
      rsi[i] < 70
    ) {
      callScore += 7;

      callReasons.push(
        "RSI supports bullish momentum"
      );
    }

    /*
      Bearish exit from overbought.
    */
    if (
      rsi[previous] !== null &&
      rsi[previous] > 70 &&
      rsi[i] <= 70
    ) {
      putScore += 14;

      putReasons.push(
        "RSI exited overbought downward"
      );
    }
    else if (
      rsi[i] < 50 &&
      rsi[i] > 30
    ) {
      putScore += 7;

      putReasons.push(
        "RSI supports bearish momentum"
      );
    }
  }


  /*
  ======================================================
  MACD
  ======================================================
  */

  if (
    macd.macd[i] !== null &&
    macd.signal[i] !== null
  ) {
    if (
      macd.macd[i] >
      macd.signal[i]
    ) {
      callScore += 12;

      callReasons.push(
        "MACD bullish"
      );
    }

    if (
      macd.macd[i] <
      macd.signal[i]
    ) {
      putScore += 12;

      putReasons.push(
        "MACD bearish"
      );
    }

    if (
      macd.histogram[i] !== null &&
      macd.histogram[previous] !== null
    ) {
      if (
        macd.histogram[i] >
        macd.histogram[previous]
      ) {
        callScore += 4;
      }

      if (
        macd.histogram[i] <
        macd.histogram[previous]
      ) {
        putScore += 4;
      }
    }
  }


  /*
  ======================================================
  BOLLINGER BANDS
  ======================================================
  */

  if (
    bollinger.upper[i] !== null &&
    bollinger.lower[i] !== null &&
    bollinger.middle[i] !== null
  ) {
    const upper =
      bollinger.upper[i];

    const lower =
      bollinger.lower[i];

    const middle =
      bollinger.middle[i];

    if (
      price <= lower * 1.0002
    ) {
      callScore += 12;

      callReasons.push(
        "Price near lower Bollinger Band"
      );
    }

    if (
      price >= upper * 0.9998
    ) {
      putScore += 12;

      putReasons.push(
        "Price near upper Bollinger Band"
      );
    }

    if (
      price > middle &&
      price < upper
    ) {
      callScore += 4;
    }

    if (
      price < middle &&
      price > lower
    ) {
      putScore += 4;
    }
  }


  /*
  ======================================================
  STOCHASTIC
  ======================================================
  */

  if (
    stochastic.k[i] !== null &&
    stochastic.d[i] !== null
  ) {
    if (
      stochastic.k[i] >
        stochastic.d[i] &&
      stochastic.k[i] < 30
    ) {
      callScore += 10;

      callReasons.push(
        "Stochastic bullish from low zone"
      );
    }

    if (
      stochastic.k[i] <
        stochastic.d[i] &&
      stochastic.k[i] > 70
    ) {
      putScore += 10;

      putReasons.push(
        "Stochastic bearish from high zone"
      );
    }
  }


  /*
  ======================================================
  SUPPORT / RESISTANCE
  ======================================================
  */

  const support =
    supportResistance.support;

  const resistance =
    supportResistance.resistance;

  if (
    support !== null &&
    resistance !== null
  ) {
    const range =
      resistance - support;

    if (range > 0) {
      const supportDistance =
        (price - support) /
        range;

      const resistanceDistance =
        (resistance - price) /
        range;

      if (
        supportDistance < 0.20
      ) {
        callScore += 10;

        callReasons.push(
          "Price near support"
        );
      }

      if (
        resistanceDistance < 0.20
      ) {
        putScore += 10;

        putReasons.push(
          "Price near resistance"
        );
      }
    }
  }


  /*
  ======================================================
  MOMENTUM
  ======================================================
  */

  if (
    momentum !== null
  ) {
    if (momentum > 0) {
      callScore += 8;

      callReasons.push(
        "Positive short-term momentum"
      );
    }

    if (momentum < 0) {
      putScore += 8;

      putReasons.push(
        "Negative short-term momentum"
      );
    }
  }


  /*
  ======================================================
  MARKET CONDITION
  ======================================================
  */

  const marketCondition =
    detectMarketCondition(
      candles,
      indicators
    );

  /*
    High volatility reduces confidence.
  */

  if (
    marketCondition.includes(
      "HIGH_VOLATILITY"
    )
  ) {
    callScore -= 8;
    putScore -= 8;
  }

  /*
    Very low volatility is usually
    not ideal for directional signals.
  */

  if (
    marketCondition ===
      "LOW_VOLATILITY_RANGE"
  ) {
    callScore -= 10;
    putScore -= 10;
  }


  /*
  ======================================================
  NORMALIZE SCORES
  ======================================================
  */

  callScore =
    clamp(
      Math.round(callScore),
      0,
      100
    );

  putScore =
    clamp(
      Math.round(putScore),
      0,
      100
    );


  /*
  ======================================================
  FINAL DECISION
  ======================================================
  */

  const MIN_SIGNAL_SCORE = 62;

  let direction =
    "NO TRADE";

  let confidence =
    Math.max(
      callScore,
      putScore
    );

  let reasons = [];

  if (
    callScore >= MIN_SIGNAL_SCORE &&
    callScore >= putScore + 5
  ) {
    direction = "CALL";
    confidence = callScore;
    reasons = callReasons;
  }
  else if (
    putScore >= MIN_SIGNAL_SCORE &&
    putScore >= callScore + 5
  ) {
    direction = "PUT";
    confidence = putScore;
    reasons = putReasons;
  }
  else {
    direction = "NO TRADE";
    confidence =
      Math.max(
        callScore,
        putScore
      );

    reasons = [
      "Signals are not sufficiently aligned"
    ];
  }


  /*
  ======================================================
  EXPIRY
  ======================================================
  */

  let expiryMinutes = 1;

  if (timeframe === 2) {
    expiryMinutes = 2;
  }

  if (timeframe === 3) {
    expiryMinutes = 3;
  }


  /*
  ======================================================
  ENTRY / ATR
  ======================================================
  */

  const currentATR =
    atr[i];

  let suggestedEntry =
    price;

  if (
    direction === "CALL" &&
    currentATR !== null
  ) {
    suggestedEntry =
      price + currentATR * 0.05;
  }

  if (
    direction === "PUT" &&
    currentATR !== null
  ) {
    suggestedEntry =
      price - currentATR * 0.05;
  }


  /*
  ======================================================
  RETURN
  ======================================================
  */

  return {
    direction,

    confidence,

    callScore,

    putScore,

    timeframe: `${timeframe} MIN`,

    expiryMinutes,

    entry: round(
      suggestedEntry,
      5
    ),

    currentPrice:
      round(price, 5),

    marketCondition,

    support:
      round(support, 5),

    resistance:
      round(resistance, 5),

    indicators: {
      ema9:
        round(ema9[i], 5),

      ema21:
        round(ema21[i], 5),

      rsi:
        round(rsi[i], 2),

      macd:
        round(macd.macd[i], 6),

      macdSignal:
        round(macd.signal[i], 6),

      macdHistogram:
        round(macd.histogram[i], 6),

      bollingerUpper:
        round(
          bollinger.upper[i],
          5
        ),

      bollingerMiddle:
        round(
          bollinger.middle[i],
          5
        ),

      bollingerLower:
        round(
          bollinger.lower[i],
          5
        ),

      atr:
        round(currentATR, 6),

      stochasticK:
        round(
          stochastic.k[i],
          2
        ),

      stochasticD:
        round(
          stochastic.d[i],
          2
        ),

      momentum:
        round(momentum, 4)
    },

    reasons:
      reasons.slice(0, 6)
  };
}


/* ======================================================
   ANALYZE PAIR
====================================================== */

async function analyzePair(
  pair,
  timeframe
) {
  const symbol =
    PAIRS[pair];

  if (!symbol) {
    throw new Error(
      `Unsupported pair: ${pair}`
    );
  }

  if (
    ![1, 2, 3].includes(timeframe)
  ) {
    throw new Error(
      "Timeframe must be 1, 2 or 3"
    );
  }

  const market =
    await getMarketData(symbol);

  let candles =
    market.candles;

  /*
    Aggregate 1-minute candles
    into requested timeframe.
  */
  candles =
    aggregateCandles(
      candles,
      timeframe
    );

  if (
    candles.length < MIN_CANDLES / timeframe
  ) {
    throw new Error(
      `Not enough ${timeframe}-minute candles`
    );
  }

  const indicators =
    buildIndicators(candles);

  const signal =
    generateSignal(
      candles,
      indicators,
      timeframe
    );

  return {
    version: VERSION,

    pair,

    symbol,

    source:
      "Twelve Data LIVE",

    dataInterval:
      "1min",

    timeframe:
      `${timeframe} MIN`,

    signal,

    candleCount:
      candles.length,

    lastCandle:
      candles[
        candles.length - 1
      ].datetime,

    fetchedAt:
      market.fetchedAt,

    cache:
      market.cache
  };
}


/* ======================================================
   ROUTE: HEALTH
====================================================== */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      version: VERSION,

      service:
        "PO AI Predictor API",

      source:
        "Twelve Data LIVE",

      dataInterval:
        INTERVAL,

      apiKeyConfigured:
        Boolean(
          TWELVE_DATA_API_KEY
        ),

      supportedTimeframes:
        [1, 2, 3],

      pairs:
        Object.keys(PAIRS).length,

      timestamp:
        new Date().toISOString()
    });
  }
);


/* ======================================================
   ROUTE: PAIRS
====================================================== */

app.get(
  "/api/pairs",
  (req, res) => {
    res.json({
      ok: true,

      version: VERSION,

      source:
        "Twelve Data LIVE",

      pairs:
        Object.keys(PAIRS),

      timeframes:
        [1, 2, 3]
    });
  }
);


/* ======================================================
   ROUTE: SINGLE SIGNAL
======================================================

Example:

/api/signal?pair=EUR/USD&timeframe=1
====================================================== */

app.get(
  "/api/signal",
  async (req, res) => {
    try {
      const pair =
        String(
          req.query.pair ||
          "EUR/USD"
        );

      const timeframe =
        Number(
          req.query.timeframe || 1
        );

      const result =
        await analyzePair(
          pair,
          timeframe
        );

      res.json({
        ok: true,
        ...result
      });
    }
    catch (error) {
      console.error(
        "[SIGNAL ERROR]",
        error.message
      );

      res.status(500).json({
        ok: false,

        version: VERSION,

        error:
          error.message
      });
    }
  }
);


/* ======================================================
   ROUTE: FULL ANALYSIS
======================================================

Example:

/api/analyze?pair=EUR/USD

Returns:
1 MIN
2 MIN
3 MIN
====================================================== */

app.get(
  "/api/analyze",
  async (req, res) => {
    try {
      const pair =
        String(
          req.query.pair ||
          "EUR/USD"
        );

      const results = {};

      for (
        const timeframe of [1, 2, 3]
      ) {
        try {
          results[
            `${timeframe}min`
          ] =
            await analyzePair(
              pair,
              timeframe
            );
        }
        catch (error) {
          results[
            `${timeframe}min`
          ] = {
            ok: false,
            error:
              error.message
          };
        }
      }

      res.json({
        ok: true,

        version: VERSION,

        pair,

        source:
          "Twelve Data LIVE",

        results,

        timestamp:
          new Date().toISOString()
      });
    }
    catch (error) {
      console.error(
        "[ANALYZE ERROR]",
        error.message
      );

      res.status(500).json({
        ok: false,

        version: VERSION,

        error:
          error.message
      });
    }
  }
);


/* ======================================================
   ROUTE: ALL PAIRS
======================================================

Returns a compact 1/2/3 minute analysis
for all supported pairs.

WARNING:
This can consume many API requests if
cache is empty.

====================================================== */

app.get(
  "/api/all-signals",
  async (req, res) => {
    try {
      const output = [];

      for (
        const pair of Object.keys(PAIRS)
      ) {
        const pairResult = {
          pair
        };

        for (
          const timeframe of [1, 2, 3]
        ) {
          try {
            const result =
              await analyzePair(
                pair,
                timeframe
              );

            pairResult[
              `${timeframe}min`
            ] = {
              signal:
                result.signal.direction,

              confidence:
                result.signal.confidence,

              condition:
                result.signal.marketCondition,

              price:
                result.signal.currentPrice
            };
          }
          catch (error) {
            pairResult[
              `${timeframe}min`
            ] = {
              signal: "ERROR",
              error:
                error.message
            };
          }
        }

        output.push(pairResult);
      }

      res.json({
        ok: true,

        version: VERSION,

        source:
          "Twelve Data LIVE",

        count:
          output.length,

        data:
          output,

        timestamp:
          new Date().toISOString()
      });
    }
    catch (error) {
      res.status(500).json({
        ok: false,

        version: VERSION,

        error:
          error.message
      });
    }
  }
);


/* ======================================================
   ROUTE: ROOT
====================================================== */

app.get(
  "/",
  (req, res) => {
    res.json({
      service:
        "PO AI Predictor API",

      version:
        VERSION,

      status:
        "LIVE",

      source:
        "Twelve Data",

      endpoints: [
        "/api/health",
        "/api/pairs",
        "/api/signal",
        "/api/analyze",
        "/api/all-signals"
      ]
    });
  }
);


/* ======================================================
   GLOBAL ERROR HANDLER
====================================================== */

app.use(
  (err, req, res, next) => {
    console.error(
      "[SERVER ERROR]",
      err
    );

    res.status(500).json({
      ok: false,

      version: VERSION,

      error:
        "Internal server error"
    });
  }
);


/* ======================================================
   START SERVER
====================================================== */

app.listen(
  PORT,
  () => {
    console.log(
      "================================================="
    );

    console.log(
      `PO AI PREDICTOR ${VERSION}`
    );

    console.log(
      "Source: Twelve Data LIVE"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `API Key configured: ${
        Boolean(TWELVE_DATA_API_KEY)
      }`
    );

    console.log(
      `Pairs: ${
        Object.keys(PAIRS).length
      }`
    );

    console.log(
      "Timeframes: 1m / 2m / 3m"
    );

    console.log(
      "================================================="
    );
  }
);
