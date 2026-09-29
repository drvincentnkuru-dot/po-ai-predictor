const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
=========================================================
 PO AI PREDICTOR BACKEND V7.1
 LIVE MARKET DATA
 Source: Twelve Data

 TIMEFRAMES:
 1 MIN
 2 MIN
 3 MIN

 INDICATORS:
 EMA 9 / EMA 21
 RSI 14
 MACD 12 / 26 / 9
 Bollinger Bands 20 / 2
 ATR 14
 Stochastic 14 / 3 / 3
 Support / Resistance
 Momentum

 V7.1 IMPROVEMENTS:
 - UTC candle handling
 - Adaptive signal scoring
 - Better trend/range handling
 - Multi-timeframe confirmation
 - More balanced signal generation
 - Closed-candle protection
=========================================================
*/

const API_KEY = process.env.TWELVE_DATA_API_KEY;

const TWELVE_DATA_URL = "https://api.twelvedata.com/time_series";

const INTERVAL = "1min";
const MAX_CANDLES = 250;

const CACHE_TTL = 15000;

const MIN_CANDLES = 80;

/*
=========================================================
 SUPPORTED LIVE PAIRS
=========================================================
*/

const SUPPORTED_PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD",
  "EUR/GBP",
  "EUR/JPY",
  "GBP/JPY",
  "AUD/JPY",
  "CAD/JPY",
  "CHF/JPY",
  "EUR/AUD",
  "EUR/CAD",
  "EUR/CHF",
  "GBP/AUD",
  "GBP/CAD",
  "GBP/CHF",
  "NZD/JPY",
  "NZD/CAD",
  "AUD/CAD",
  "AUD/CHF",
  "CAD/CHF"
];

/*
=========================================================
 CACHE
=========================================================
*/

const marketCache = new Map();

/*
=========================================================
 BASIC HELPERS
=========================================================
*/

function round(value, decimals = 6) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }

  return Number(Number(value).toFixed(decimals));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values || values.length === 0) {
    return null;
  }

  return values.reduce((a, b) => a + b, 0) / values.length;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/*
=========================================================
 EMA
=========================================================
*/

function calculateEMA(values, period) {
  const result = new Array(values.length).fill(null);

  if (values.length < period) {
    return result;
  }

  const multiplier = 2 / (period + 1);

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  let previous = sum / period;

  result[period - 1] = previous;

  for (let i = period; i < values.length; i++) {
    previous =
      (values[i] - previous) * multiplier + previous;

    result[i] = previous;
  }

  return result;
}

/*
=========================================================
 RSI
=========================================================
*/

function calculateRSI(values, period = 14) {
  const result = new Array(values.length).fill(null);

  if (values.length <= period) {
    return result;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
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

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      ((averageGain * (period - 1)) + gain) / period;

    averageLoss =
      ((averageLoss * (period - 1)) + loss) / period;

    if (averageLoss === 0) {
      result[i] = 100;
    } else {
      const rs = averageGain / averageLoss;

      result[i] =
        100 - 100 / (1 + rs);
    }
  }

  return result;
}

/*
=========================================================
 MACD
=========================================================
*/

function calculateMACD(
  values,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  const fastEMA = calculateEMA(values, fastPeriod);
  const slowEMA = calculateEMA(values, slowPeriod);

  const macdLine = new Array(values.length).fill(null);

  for (let i = 0; i < values.length; i++) {
    if (
      fastEMA[i] !== null &&
      slowEMA[i] !== null
    ) {
      macdLine[i] =
        fastEMA[i] - slowEMA[i];
    }
  }

  const compactMACD = [];
  const compactIndexes = [];

  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] !== null) {
      compactMACD.push(macdLine[i]);
      compactIndexes.push(i);
    }
  }

  const compactSignal =
    calculateEMA(
      compactMACD,
      signalPeriod
    );

  const signalLine =
    new Array(values.length).fill(null);

  const histogram =
    new Array(values.length).fill(null);

  for (let i = 0; i < compactIndexes.length; i++) {
    const originalIndex =
      compactIndexes[i];

    if (compactSignal[i] !== null) {
      signalLine[originalIndex] =
        compactSignal[i];

      histogram[originalIndex] =
        macdLine[originalIndex] -
        compactSignal[i];
    }
  }

  return {
    macdLine,
    signalLine,
    histogram
  };
}

/*
=========================================================
 BOLLINGER BANDS
=========================================================
*/

function calculateBollinger(
  values,
  period = 20,
  multiplier = 2
) {
  const upper = new Array(values.length).fill(null);
  const middle = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    const slice =
      values.slice(
        i - period + 1,
        i + 1
      );

    const mean = average(slice);

    const variance =
      average(
        slice.map(
          value =>
            Math.pow(value - mean, 2)
        )
      );

    const standardDeviation =
      Math.sqrt(variance);

    middle[i] = mean;

    upper[i] =
      mean +
      multiplier * standardDeviation;

    lower[i] =
      mean -
      multiplier * standardDeviation;
  }

  return {
    upper,
    middle,
    lower
  };
}

/*
=========================================================
 ATR
=========================================================
*/

function calculateATR(candles, period = 14) {
  const trueRanges =
    new Array(candles.length).fill(null);

  const atr =
    new Array(candles.length).fill(null);

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const previousClose =
      candles[i - 1].close;

    const tr1 =
      high - low;

    const tr2 =
      Math.abs(high - previousClose);

    const tr3 =
      Math.abs(low - previousClose);

    trueRanges[i] =
      Math.max(
        tr1,
        tr2,
        tr3
      );
  }

  const initialTR =
    trueRanges
      .slice(1, period + 1)
      .filter(v => v !== null);

  if (initialTR.length < period) {
    return atr;
  }

  let previousATR =
    average(initialTR);

  atr[period] =
    previousATR;

  for (
    let i = period + 1;
    i < candles.length;
    i++
  ) {
    previousATR =
      (
        previousATR * (period - 1) +
        trueRanges[i]
      ) / period;

    atr[i] =
      previousATR;
  }

  return atr;
}

/*
=========================================================
 STOCHASTIC
=========================================================
*/

function calculateStochastic(
  candles,
  period = 14,
  smoothK = 3,
  smoothD = 3
) {
  const rawK =
    new Array(candles.length).fill(null);

  const k =
    new Array(candles.length).fill(null);

  const d =
    new Array(candles.length).fill(null);

  for (
    let i = period - 1;
    i < candles.length;
    i++
  ) {
    const slice =
      candles.slice(
        i - period + 1,
        i + 1
      );

    const highestHigh =
      Math.max(
        ...slice.map(c => c.high)
      );

    const lowestLow =
      Math.min(
        ...slice.map(c => c.low)
      );

    const range =
      highestHigh - lowestLow;

    if (range === 0) {
      rawK[i] = 50;
    } else {
      rawK[i] =
        (
          (candles[i].close - lowestLow) /
          range
        ) * 100;
    }
  }

  for (
    let i = period - 1 + smoothK - 1;
    i < candles.length;
    i++
  ) {
    const values =
      rawK
        .slice(
          i - smoothK + 1,
          i + 1
        )
        .filter(v => v !== null);

    if (values.length === smoothK) {
      k[i] =
        average(values);
    }
  }

  for (
    let i = period - 1 + smoothK - 1 + smoothD - 1;
    i < candles.length;
    i++
  ) {
    const values =
      k
        .slice(
          i - smoothD + 1,
          i + 1
        )
        .filter(v => v !== null);

    if (values.length === smoothD) {
      d[i] =
        average(values);
    }
  }

  return {
    k,
    d
  };
}

/*
=========================================================
 SUPPORT / RESISTANCE
=========================================================
*/

function calculateSupportResistance(
  candles,
  lookback = 30
) {
  const slice =
    candles.slice(
      Math.max(
        0,
        candles.length - lookback
      )
    );

  if (!slice.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const support =
    Math.min(
      ...slice.map(c => c.low)
    );

  const resistance =
    Math.max(
      ...slice.map(c => c.high)
    );

  return {
    support,
    resistance
  };
}

/*
=========================================================
 MOMENTUM
=========================================================
*/

function calculateMomentum(
  values,
  period = 5
) {
  if (values.length <= period) {
    return null;
  }

  const current =
    values[values.length - 1];

  const previous =
    values[
      values.length - 1 - period
    ];

  if (!previous) {
    return null;
  }

  return (
    (current - previous) /
    previous
  ) * 100;
}

/*
=========================================================
 CANDLE PARSING
=========================================================
*/

function parseTwelveDataCandles(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const candles =
    values
      .map(item => ({
        datetime: item.datetime,

        timestamp:
          new Date(item.datetime).getTime(),

        open:
          Number(item.open),

        high:
          Number(item.high),

        low:
          Number(item.low),

        close:
          Number(item.close)
      }))
      .filter(c =>
        Number.isFinite(c.timestamp) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .sort(
        (a, b) =>
          a.timestamp - b.timestamp
      );

  return candles;
}

/*
=========================================================
 FETCH TWELVE DATA
=========================================================
*/

async function fetchLiveCandles(pair) {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is not configured"
    );
  }

  const url =
    `${TWELVE_DATA_URL}` +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=${INTERVAL}` +
    `&outputsize=${MAX_CANDLES}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (data.status === "error") {
    throw new Error(
      data.message ||
      "Twelve Data API error"
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "Twelve Data returned no candle data"
    );
  }

  let candles =
    parseTwelveDataCandles(
      data.values
    );

  /*
  -------------------------------------------------------
  REMOVE ONLY AN INCOMPLETE CURRENT CANDLE
  -------------------------------------------------------
  */

  const now =
    Date.now();

  const minuteStart =
    Math.floor(now / 60000) * 60000;

  candles =
    candles.filter(
      candle =>
        candle.timestamp <
        minuteStart
    );

  if (candles.length < MIN_CANDLES) {
    throw new Error(
      `Not enough candles: ${candles.length}`
    );
  }

  if (candles.length > MAX_CANDLES) {
    candles =
      candles.slice(
        candles.length - MAX_CANDLES
      );
  }

  return {
    candles,
    fetchedAt:
      new Date().toISOString(),
    source:
      "Twelve Data LIVE"
  };
}

/*
=========================================================
 CACHE
=========================================================
*/

async function getLiveCandles(pair) {
  const cached =
    marketCache.get(pair);

  const now =
    Date.now();

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

  const data =
    await fetchLiveCandles(pair);

  marketCache.set(
    pair,
    {
      timestamp: now,
      data
    }
  );

  return {
    ...data,
    cache: "MISS"
  };
}

/*
=========================================================
 AGGREGATE 1-MIN CANDLES
 INTO 2-MIN / 3-MIN
=========================================================
*/

function aggregateCandles(
  candles,
  minutes
) {
  const bucketMs =
    minutes * 60 * 1000;

  const groups = new Map();

  for (const candle of candles) {
    const bucket =
      Math.floor(
        candle.timestamp / bucketMs
      ) * bucketMs;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups
      .get(bucket)
      .push(candle);
  }

  const result = [];

  const sortedBuckets =
    [...groups.keys()].sort(
      (a, b) => a - b
    );

  for (const bucket of sortedBuckets) {
    const group =
      groups.get(bucket);

    /*
      We only keep complete groups.
      This prevents partial 2m/3m candles.
    */

    if (group.length < minutes) {
      continue;
    }

    const first =
      group[0];

    const last =
      group[group.length - 1];

    result.push({
      datetime:
        new Date(bucket).toISOString(),

      timestamp:
        bucket,

      open:
        first.open,

      high:
        Math.max(
          ...group.map(c => c.high)
        ),

      low:
        Math.min(
          ...group.map(c => c.low)
        ),

      close:
        last.close
    });
  }

  return result;
}

/*
=========================================================
 MARKET CONDITION
=========================================================
*/

function detectMarketCondition(
  candles,
  ema9,
  ema21,
  atr
) {
  if (
    !ema9 ||
    !ema21 ||
    !atr ||
    !candles.length
  ) {
    return "UNKNOWN";
  }

  const price =
    candles[candles.length - 1].close;

  const trendDistance =
    Math.abs(
      ema9 - ema21
    );

  const trendPercent =
    (trendDistance / price) *
    100;

  const atrPercent =
    (atr / price) * 100;

  /*
  Adaptive thresholds
  */

  const strongTrend =
    trendPercent >=
    Math.max(
      0.004,
      atrPercent * 0.10
    );

  const highVolatility =
    atrPercent >= 0.20;

  const lowVolatility =
    atrPercent <= 0.015;

  if (highVolatility) {
    if (ema9 > ema21) {
      return "HIGH_VOLATILITY_UPTREND";
    }

    if (ema9 < ema21) {
      return "HIGH_VOLATILITY_DOWNTREND";
    }

    return "HIGH_VOLATILITY_RANGE";
  }

  if (lowVolatility) {
    return "LOW_VOLATILITY_RANGE";
  }

  if (strongTrend && ema9 > ema21) {
    return "UPTREND";
  }

  if (strongTrend && ema9 < ema21) {
    return "DOWNTREND";
  }

  return "RANGING";
}

/*
=========================================================
 SIGNAL ENGINE V7.1
=========================================================
*/

function calculateSignal(
  candles,
  timeframe
) {
  const closes =
    candles.map(c => c.close);

  const ema9Series =
    calculateEMA(
      closes,
      9
    );

  const ema21Series =
    calculateEMA(
      closes,
      21
    );

  const rsiSeries =
    calculateRSI(
      closes,
      14
    );

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

  const atrSeries =
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

  const index =
    candles.length - 1;

  const previousIndex =
    candles.length - 2;

  const price =
    closes[index];

  const previousPrice =
    closes[previousIndex];

  const ema9 =
    ema9Series[index];

  const ema21 =
    ema21Series[index];

  const previousEMA9 =
    ema9Series[previousIndex];

  const previousEMA21 =
    ema21Series[previousIndex];

  const rsi =
    rsiSeries[index];

  const previousRSI =
    rsiSeries[previousIndex];

  const macdValue =
    macd.macdLine[index];

  const macdSignal =
    macd.signalLine[index];

  const macdHistogram =
    macd.histogram[index];

  const previousHistogram =
    macd.histogram[previousIndex];

  const bbUpper =
    bollinger.upper[index];

  const bbMiddle =
    bollinger.middle[index];

  const bbLower =
    bollinger.lower[index];

  const atr =
    atrSeries[index];

  const stochasticK =
    stochastic.k[index];

  const stochasticD =
    stochastic.d[index];

  const previousStochasticK =
    stochastic.k[previousIndex];

  const momentum =
    calculateMomentum(
      closes,
      5
    );

  const sr =
    calculateSupportResistance(
      candles,
      30
    );

  const support =
    sr.support;

  const resistance =
    sr.resistance;

  const marketCondition =
    detectMarketCondition(
      candles,
      ema9,
      ema21,
      atr
    );

  let callScore = 0;
  let putScore = 0;

  const callReasons = [];
  const putReasons = [];

  /*
  =======================================================
  EMA TREND
  =======================================================
  */

  if (ema9 > ema21) {
    callScore += 18;
    callReasons.push(
      "EMA9 above EMA21"
    );
  }

  if (ema9 < ema21) {
    putScore += 18;
    putReasons.push(
      "EMA9 below EMA21"
    );
  }

  /*
  =======================================================
  FRESH EMA CROSS
  =======================================================
  */

  const bullishCross =
    previousEMA9 !== null &&
    previousEMA21 !== null &&
    previousEMA9 <= previousEMA21 &&
    ema9 > ema21;

  const bearishCross =
    previousEMA9 !== null &&
    previousEMA21 !== null &&
    previousEMA9 >= previousEMA21 &&
    ema9 < ema21;

  if (bullishCross) {
    callScore += 12;
    callReasons.push(
      "Fresh bullish EMA crossover"
    );
  }

  if (bearishCross) {
    putScore += 12;
    putReasons.push(
      "Fresh bearish EMA crossover"
    );
  }

  /*
  =======================================================
  PRICE VS EMA
  =======================================================
  */

  if (price > ema9) {
    callScore += 9;
    callReasons.push(
      "Price above EMA9"
    );
  }

  if (price < ema9) {
    putScore += 9;
    putReasons.push(
      "Price below EMA9"
    );
  }

  /*
  =======================================================
  RSI
  =======================================================
  */

  if (
    rsi !== null &&
    previousRSI !== null
  ) {
    if (
      previousRSI <= 30 &&
      rsi > 30
    ) {
      callScore += 14;

      callReasons.push(
        "RSI exited oversold upward"
      );
    } else if (
      rsi > 45 &&
      rsi < 65
    ) {
      callScore += 5;
    }

    if (
      previousRSI >= 70 &&
      rsi < 70
    ) {
      putScore += 14;

      putReasons.push(
        "RSI exited overbought downward"
      );
    } else if (
      rsi > 35 &&
      rsi < 55
    ) {
      putScore += 5;
    }
  }

  /*
  =======================================================
  MACD
  =======================================================
  */

  if (
    macdValue !== null &&
    macdSignal !== null
  ) {
    if (macdValue > macdSignal) {
      callScore += 10;

      callReasons.push(
        "MACD bullish"
      );
    }

    if (macdValue < macdSignal) {
      putScore += 10;

      putReasons.push(
        "MACD bearish"
      );
    }

    if (
      previousHistogram !== null &&
      macdHistogram !== null
    ) {
      if (
        previousHistogram <= 0 &&
        macdHistogram > 0
      ) {
        callScore += 6;

        callReasons.push(
          "MACD histogram turned positive"
        );
      }

      if (
        previousHistogram >= 0 &&
        macdHistogram < 0
      ) {
        putScore += 6;

        putReasons.push(
          "MACD histogram turned negative"
        );
      }
    }
  }

  /*
  =======================================================
  BOLLINGER
  =======================================================
  */

  if (
    bbUpper !== null &&
    bbMiddle !== null &&
    bbLower !== null
  ) {
    const bandWidth =
      bbUpper - bbLower;

    if (bandWidth > 0) {
      const location =
        (price - bbLower) /
        bandWidth;

      /*
      Near lower band = CALL setup
      */

      if (location <= 0.20) {
        callScore += 12;

        callReasons.push(
          "Price near lower Bollinger Band"
        );
      }

      /*
      Near upper band = PUT setup
      */

      if (location >= 0.80) {
        putScore += 12;

        putReasons.push(
          "Price near upper Bollinger Band"
        );
      }

      /*
      Mild continuation signals
      */

      if (
        location > 0.55 &&
        price > bbMiddle
      ) {
        callScore += 4;
      }

      if (
        location < 0.45 &&
        price < bbMiddle
      ) {
        putScore += 4;
      }
    }
  }

  /*
  =======================================================
  STOCHASTIC
  =======================================================
  */

  if (
    stochasticK !== null &&
    stochasticD !== null
  ) {
    if (
      previousStochasticK !== null &&
      previousStochasticK <= 20 &&
      stochasticK > 20 &&
      stochasticK > stochasticD
    ) {
      callScore += 10;

      callReasons.push(
        "Stochastic bullish exit"
      );
    } else if (
      stochasticK > stochasticD &&
      stochasticK < 70
    ) {
      callScore += 4;
    }

    if (
      previousStochasticK !== null &&
      previousStochasticK >= 80 &&
      stochasticK < 80 &&
      stochasticK < stochasticD
    ) {
      putScore += 10;

      putReasons.push(
        "Stochastic bearish exit"
      );
    } else if (
      stochasticK < stochasticD &&
      stochasticK > 30
    ) {
      putScore += 4;
    }
  }

  /*
  =======================================================
  SUPPORT / RESISTANCE
  =======================================================
  */

  const range =
    resistance - support;

  if (
    range > 0 &&
    atr !== null
  ) {
    const distanceFromSupport =
      price - support;

    const distanceFromResistance =
      resistance - price;

    /*
    Near support
    */

    if (
      distanceFromSupport >= 0 &&
      distanceFromSupport <=
        Math.max(
          atr * 0.75,
          range * 0.18
        )
    ) {
      callScore += 10;

      callReasons.push(
        "Price near support"
      );
    }

    /*
    Near resistance
    */

    if (
      distanceFromResistance >= 0 &&
      distanceFromResistance <=
        Math.max(
          atr * 0.75,
          range * 0.18
        )
    ) {
      putScore += 10;

      putReasons.push(
        "Price near resistance"
      );
    }
  }

  /*
  =======================================================
  MOMENTUM
  =======================================================
  */

  if (momentum !== null) {
    if (momentum > 0.01) {
      callScore += 8;

      callReasons.push(
        "Positive momentum"
      );
    }

    if (momentum < -0.01) {
      putScore += 8;

      putReasons.push(
        "Negative momentum"
      );
    }
  }

  /*
  =======================================================
  MARKET CONDITION ADJUSTMENT
  =======================================================
  */

  if (
    marketCondition ===
    "UPTREND"
  ) {
    callScore += 6;
    putScore -= 3;
  }

  if (
    marketCondition ===
    "DOWNTREND"
  ) {
    putScore += 6;
    callScore -= 3;
  }

  if (
    marketCondition ===
    "HIGH_VOLATILITY_UPTREND"
  ) {
    callScore += 4;
    putScore -= 5;
  }

  if (
    marketCondition ===
    "HIGH_VOLATILITY_DOWNTREND"
  ) {
    putScore += 4;
    callScore -= 5;
  }

  /*
  Range should not completely kill
  a strong reversal setup.
  */

  if (
    marketCondition ===
    "LOW_VOLATILITY_RANGE"
  ) {
    callScore -= 4;
    putScore -= 4;
  }

  /*
  =======================================================
  SCORE NORMALIZATION
  =======================================================
  */

  callScore =
    Math.round(
      clamp(
        callScore,
        0,
        100
      )
    );

  putScore =
    Math.round(
      clamp(
        putScore,
        0,
        100
      )
    );

  /*
  =======================================================
  ADAPTIVE THRESHOLD
  =======================================================
  */

  let threshold = 60;

  if (
    marketCondition ===
    "HIGH_VOLATILITY_UPTREND" ||
    marketCondition ===
    "HIGH_VOLATILITY_DOWNTREND"
  ) {
    threshold = 64;
  }

  if (
    marketCondition ===
    "LOW_VOLATILITY_RANGE"
  ) {
    threshold = 58;
  }

  if (
    marketCondition ===
    "RANGING"
  ) {
    threshold = 58;
  }

  /*
  =======================================================
  SIGNAL DECISION
  =======================================================
  */

  const difference =
    Math.abs(
      callScore - putScore
    );

  let direction =
    "NO TRADE";

  let winningScore = 0;

  let reasons = [
    "Signals are not sufficiently aligned"
  ];

  if (
    callScore >= threshold &&
    callScore > putScore &&
    difference >= 6
  ) {
    direction = "CALL";
    winningScore = callScore;
    reasons = callReasons.slice(
      0,
      5
    );
  } else if (
    putScore >= threshold &&
    putScore > callScore &&
    difference >= 6
  ) {
    direction = "PUT";
    winningScore = putScore;
    reasons = putReasons.slice(
      0,
      5
    );
  }

  /*
  =======================================================
  CONFIDENCE
  =======================================================
  */

  let confidence;

  if (
    direction === "CALL" ||
    direction === "PUT"
  ) {
    confidence =
      Math.round(
        clamp(
          winningScore,
          55,
          95
        )
      );
  } else {
    confidence =
      Math.round(
        Math.max(
          callScore,
          putScore
        )
      );
  }

  /*
  =======================================================
  ENTRY
  =======================================================
  */

  const entry =
    price;

  /*
  =======================================================
  EXPIRY
  =======================================================
  */

  const expiryMinutes =
    timeframe;

  return {
    direction,
    confidence,

    callScore,
    putScore,

    timeframe:
      `${timeframe} MIN`,

    expiryMinutes,

    entry:
      round(entry, 6),

    currentPrice:
      round(price, 6),

    marketCondition,

    support:
      round(support, 6),

    resistance:
      round(resistance, 6),

    indicators: {
      ema9:
        round(ema9, 6),

      ema21:
        round(ema21, 6),

      rsi:
        round(rsi, 2),

      macd:
        round(macdValue, 6),

      macdSignal:
        round(macdSignal, 6),

      macdHistogram:
        round(macdHistogram, 6),

      bollingerUpper:
        round(bbUpper, 6),

      bollingerMiddle:
        round(bbMiddle, 6),

      bollingerLower:
        round(bbLower, 6),

      atr:
        round(atr, 6),

      stochasticK:
        round(stochasticK, 2),

      stochasticD:
        round(stochasticD, 2),

      momentum:
        round(momentum, 4)
    },

    reasons
  };
}

/*
=========================================================
 ANALYZE ONE TIMEFRAME
=========================================================
*/

async function analyzeTimeframe(
  pair,
  timeframe,
  rawData
) {
  let candles =
    rawData.candles;

  if (timeframe > 1) {
    candles =
      aggregateCandles(
        rawData.candles,
        timeframe
      );
  }

  if (candles.length < MIN_CANDLES) {
    throw new Error(
      `Not enough ${timeframe}m candles`
    );
  }

  const signal =
    calculateSignal(
      candles,
      timeframe
    );

  return {
    version: "V7.1",

    pair,

    symbol: pair,

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
      candles[candles.length - 1]
        .datetime,

    fetchedAt:
      rawData.fetchedAt,

    cache:
      rawData.cache
  };
}

/*
=========================================================
 MULTI-TIMEFRAME CONFIRMATION
=========================================================
*/

function applyMultiTimeframeConfirmation(
  results
) {
  const one =
    results["1min"];

  const two =
    results["2min"];

  const three =
    results["3min"];

  if (!one || !two || !three) {
    return results;
  }

  const directions = [
    one.signal.direction,
    two.signal.direction,
    three.signal.direction
  ];

  /*
  -------------------------------------------------------
  1M + 2M CONFIRMATION
  -------------------------------------------------------
  */

  if (
    one.signal.direction === "CALL" &&
    two.signal.direction === "CALL"
  ) {
    one.signal.confidence =
      clamp(
        one.signal.confidence + 5,
        0,
        95
      );

    one.signal.reasons.push(
      "1M + 2M CALL confirmation"
    );
  }

  if (
    one.signal.direction === "PUT" &&
    two.signal.direction === "PUT"
  ) {
    one.signal.confidence =
      clamp(
        one.signal.confidence + 5,
        0,
        95
      );

    one.signal.reasons.push(
      "1M + 2M PUT confirmation"
    );
  }

  /*
  -------------------------------------------------------
  2M + 3M CONFIRMATION
  -------------------------------------------------------
  */

  if (
    two.signal.direction === "CALL" &&
    three.signal.direction === "CALL"
  ) {
    two.signal.confidence =
      clamp(
        two.signal.confidence + 5,
        0,
        95
      );

    two.signal.reasons.push(
      "2M + 3M CALL confirmation"
    );
  }

  if (
    two.signal.direction === "PUT" &&
    three.signal.direction === "PUT"
  ) {
    two.signal.confidence =
      clamp(
        two.signal.confidence + 5,
        0,
        95
      );

    two.signal.reasons.push(
      "2M + 3M PUT confirmation"
    );
  }

  /*
  -------------------------------------------------------
  ALL THREE ALIGN
  -------------------------------------------------------
  */

  if (
    directions.every(
      d => d === "CALL"
    )
  ) {
    for (const key of [
      "1min",
      "2min",
      "3min"
    ]) {
      results[key].signal.confidence =
        clamp(
          results[key].signal.confidence + 8,
          0,
          95
        );

      results[key].signal.reasons.push(
        "1M + 2M + 3M CALL alignment"
      );
    }
  }

  if (
    directions.every(
      d => d === "PUT"
    )
  ) {
    for (const key of [
      "1min",
      "2min",
      "3min"
    ]) {
      results[key].signal.confidence =
        clamp(
          results[key].signal.confidence + 8,
          0,
          95
        );

      results[key].signal.reasons.push(
        "1M + 2M + 3M PUT alignment"
      );
    }
  }

  return results;
}

/*
=========================================================
 ROUTES
=========================================================
*/

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "PO AI Predictor API",
      version:
        "V7.1",
      source:
        "Twelve Data LIVE",
      message:
        "PO AI Predictor API V7.1 is running."
    });
  }
);

/*
=========================================================
 HEALTH
=========================================================
*/

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      version:
        "V7.1",

      service:
        "PO AI Predictor API",

      source:
        "Twelve Data LIVE",

      dataInterval:
        "1min",

      timezone:
        "UTC",

      apiKeyConfigured:
        Boolean(API_KEY),

      supportedTimeframes:
        [1, 2, 3],

      pairs:
        SUPPORTED_PAIRS.length,

      cacheTTL:
        CACHE_TTL,

      timestamp:
        new Date().toISOString()
    });
  }
);

/*
=========================================================
 PAIRS
=========================================================
*/

app.get(
  "/api/pairs",
  (req, res) => {
    res.json({
      ok: true,

      version:
        "V7.1",

      source:
        "Twelve Data LIVE",

      count:
        SUPPORTED_PAIRS.length,

      pairs:
        SUPPORTED_PAIRS
    });
  }
);

/*
=========================================================
 SINGLE SIGNAL
=========================================================
*/

app.get(
  "/api/signal",
  async (req, res) => {
    try {
      const pair =
        String(
          req.query.pair ||
          "EUR/USD"
        ).toUpperCase();

      const timeframe =
        Number(
          req.query.timeframe || 1
        );

      if (
        !SUPPORTED_PAIRS.includes(pair)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Unsupported pair",
          supportedPairs:
            SUPPORTED_PAIRS
        });
      }

      if (
        ![1, 2, 3].includes(timeframe)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Timeframe must be 1, 2 or 3"
        });
      }

      const rawData =
        await getLiveCandles(pair);

      const result =
        await analyzeTimeframe(
          pair,
          timeframe,
          rawData
        );

      res.json({
        ok: true,
        ...result,
        timestamp:
          new Date().toISOString()
      });

    } catch (error) {
      console.error(
        "[SIGNAL ERROR]",
        error
      );

      res.status(500).json({
        ok: false,
        version:
          "V7.1",
        error:
          error.message
      });
    }
  }
);

/*
=========================================================
 FULL ANALYSIS
=========================================================
*/

app.get(
  "/api/analyze",
  async (req, res) => {
    try {
      const pair =
        String(
          req.query.pair ||
          "EUR/USD"
        ).toUpperCase();

      if (
        !SUPPORTED_PAIRS.includes(pair)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Unsupported pair",
          supportedPairs:
            SUPPORTED_PAIRS
        });
      }

      const rawData =
        await getLiveCandles(pair);

      const results = {};

      results["1min"] =
        await analyzeTimeframe(
          pair,
          1,
          rawData
        );

      results["2min"] =
        await analyzeTimeframe(
          pair,
          2,
          rawData
        );

      results["3min"] =
        await analyzeTimeframe(
          pair,
          3,
          rawData
        );

      applyMultiTimeframeConfirmation(
        results
      );

      res.json({
        ok: true,

        version:
          "V7.1",

        pair,

        source:
          "Twelve Data LIVE",

        results,

        timestamp:
          new Date().toISOString()
      });

    } catch (error) {
      console.error(
        "[ANALYZE ERROR]",
        error
      );

      res.status(500).json({
        ok: false,

        version:
          "V7.1",

        error:
          error.message
      });
    }
  }
);

/*
=========================================================
 ALL PAIRS
=========================================================
*/

app.get(
  "/api/all-signals",
  async (req, res) => {
    try {
      const results = [];

      for (
        const pair of SUPPORTED_PAIRS
      ) {
        try {
          const rawData =
            await getLiveCandles(pair);

          const pairResults = {};

          pairResults["1min"] =
            await analyzeTimeframe(
              pair,
              1,
              rawData
            );

          pairResults["2min"] =
            await analyzeTimeframe(
              pair,
              2,
              rawData
            );

          pairResults["3min"] =
            await analyzeTimeframe(
              pair,
              3,
              rawData
            );

          applyMultiTimeframeConfirmation(
            pairResults
          );

          results.push({
            pair,

            "1min":
              pairResults["1min"].signal,

            "2min":
              pairResults["2min"].signal,

            "3min":
              pairResults["3min"].signal
          });

        } catch (error) {
          results.push({
            pair,

            error:
              error.message
          });
        }
      }

      res.json({
        ok: true,

        version:
          "V7.1",

        source:
          "Twelve Data LIVE",

        count:
          results.length,

        results,

        timestamp:
          new Date().toISOString()
      });

    } catch (error) {
      console.error(
        "[ALL SIGNALS ERROR]",
        error
      );

      res.status(500).json({
        ok: false,

        version:
          "V7.1",

        error:
          error.message
      });
    }
  }
);

/*
=========================================================
 404
=========================================================
*/

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "Endpoint not found",
      version:
        "V7.1"
    });
  }
);

/*
=========================================================
 START SERVER
=========================================================
*/

app.listen(
  PORT,
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      "PO AI PREDICTOR API V7.1"
    );

    console.log(
      "Source: Twelve Data LIVE"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `API Key: ${
        API_KEY
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      `Pairs: ${SUPPORTED_PAIRS.length}`
    );

    console.log(
      "Timeframes: 1m / 2m / 3m"
    );

    console.log(
      "Timezone: UTC"
    );

    console.log(
      "=========================================="
    );
  }
);
