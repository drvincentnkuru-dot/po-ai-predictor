const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
=========================================================
 PO AI PREDICTOR BACKEND V6.2
 LIVE MARKET ONLY

 DATA SOURCE:
 Twelve Data

 INDICATORS:
 EMA 9 / 21
 RSI 14
 Momentum 5
 MACD 12 / 26 / 9
 Bollinger Bands 20 / 2
 ATR 14
 Stochastic 14 / 3 / 3
 Support / Resistance 30 candles

 SIGNAL ENGINE:
 Multi-confirmation scoring
 NO TRADE when conditions are not sufficiently aligned

 IMPORTANT:
 Technical indicators cannot guarantee a winning trade.
=========================================================
*/

const VERSION = "6.2.0";

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY;

const LIVE_DATA_INTERVAL =
  Number(process.env.LIVE_DATA_INTERVAL || 60000);

const MAX_CANDLES =
  Number(process.env.MAX_CANDLES || 200);

const TWELVE_DATA_INTERVAL =
  process.env.TWELVE_DATA_INTERVAL || "1min";

const DEFAULT_PAIR = "EUR/USD";

const livePairs = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD",
  "EUR/GBP",
  "EUR/JPY",
  "GBP/JPY"
];

const liveCache = new Map();

let lastLiveUpdate = null;

/*
=========================================================
 HELPERS
=========================================================
*/

function safeNumber(value, fallback = null) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function mean(values) {
  const valid = values.filter(
    value => Number.isFinite(value)
  );

  if (!valid.length) {
    return null;
  }

  return (
    valid.reduce(
      (sum, value) => sum + value,
      0
    ) / valid.length
  );
}

function standardDeviation(values) {
  const average = mean(values);

  if (average === null) {
    return null;
  }

  const variance =
    values.reduce(
      (sum, value) =>
        sum +
        Math.pow(value - average, 2),
      0
    ) / values.length;

  return Math.sqrt(variance);
}

/*
=========================================================
 CANDLE NORMALIZATION
=========================================================
*/

function normalizeCandle(candle) {
  return {
    time:
      candle.datetime ||
      candle.time ||
      candle.timestamp ||
      candle.date ||
      null,

    open: safeNumber(candle.open),
    high: safeNumber(candle.high),
    low: safeNumber(candle.low),
    close: safeNumber(candle.close),

    volume: safeNumber(
      candle.volume,
      0
    )
  };
}

function cleanCandles(candles) {
  return candles
    .map(normalizeCandle)
    .filter(
      candle =>
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close)
    )
    .sort(
      (a, b) =>
        new Date(a.time || 0) -
        new Date(b.time || 0)
    );
}

/*
=========================================================
 TWELVE DATA
=========================================================
*/

async function fetchLiveCandles(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is not configured"
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(pair) +
    "&interval=" +
    encodeURIComponent(
      TWELVE_DATA_INTERVAL
    ) +
    "&outputsize=" +
    encodeURIComponent(MAX_CANDLES) +
    "&apikey=" +
    encodeURIComponent(
      TWELVE_DATA_API_KEY
    );

  const response = await fetch(url);

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
        "Twelve Data returned an error"
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "Twelve Data returned no candle data"
    );
  }

  return cleanCandles(
    data.values
  );
}

/*
=========================================================
 EMA
=========================================================
*/

function calculateEMA(values, period) {
  if (values.length < period) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let ema =
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
    ema =
      (values[i] - ema) *
        multiplier +
      ema;
  }

  return ema;
}

/*
=========================================================
 RSI 14
=========================================================
*/

function calculateRSI(
  values,
  period = 14
) {
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
      values[i] -
      values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain =
    gains / period;

  let averageLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? Math.abs(change)
        : 0;

    averageGain =
      (
        averageGain *
          (period - 1) +
        gain
      ) / period;

    averageLoss =
      (
        averageLoss *
          (period - 1) +
        loss
      ) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

/*
=========================================================
 MACD 12 / 26 / 9
=========================================================
*/

function calculateMACD(
  values,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  if (
    values.length <
    slowPeriod + signalPeriod
  ) {
    return null;
  }

  const fastMultiplier =
    2 / (fastPeriod + 1);

  const slowMultiplier =
    2 / (slowPeriod + 1);

  let fastEMA =
    mean(
      values.slice(
        0,
        fastPeriod
      )
    );

  let slowEMA =
    mean(
      values.slice(
        0,
        slowPeriod
      )
    );

  const macdValues = [];

  for (
    let i = slowPeriod;
    i < values.length;
    i++
  ) {
    fastEMA =
      (
        values[i] -
        fastEMA
      ) *
        fastMultiplier +
      fastEMA;

    slowEMA =
      (
        values[i] -
        slowEMA
      ) *
        slowMultiplier +
      slowEMA;

    macdValues.push(
      fastEMA - slowEMA
    );
  }

  if (
    macdValues.length <
    signalPeriod
  ) {
    return null;
  }

  const signal =
    calculateEMA(
      macdValues,
      signalPeriod
    );

  if (signal === null) {
    return null;
  }

  const macd =
    macdValues[
      macdValues.length - 1
    ];

  const histogram =
    macd - signal;

  return {
    macd: round(macd, 8),
    signal: round(signal, 8),
    histogram: round(
      histogram,
      8
    )
  };
}

/*
=========================================================
 BOLLINGER BANDS 20 / 2
=========================================================
*/

function calculateBollingerBands(
  values,
  period = 20,
  multiplier = 2
) {
  if (values.length < period) {
    return null;
  }

  const recent =
    values.slice(-period);

  const middle =
    mean(recent);

  const deviation =
    standardDeviation(
      recent
    );

  if (
    middle === null ||
    deviation === null
  ) {
    return null;
  }

  const upper =
    middle +
    multiplier * deviation;

  const lower =
    middle -
    multiplier * deviation;

  const current =
    values[
      values.length - 1
    ];

  const bandwidth =
    middle !== 0
      ? (upper - lower) /
        middle
      : 0;

  const position =
    upper !== lower
      ? (current - lower) /
        (upper - lower)
      : 0.5;

  return {
    upper: round(
      upper,
      8
    ),

    middle: round(
      middle,
      8
    ),

    lower: round(
      lower,
      8
    ),

    bandwidth: round(
      bandwidth,
      8
    ),

    position: round(
      position,
      4
    )
  };
}

/*
=========================================================
 ATR 14
=========================================================
*/

function calculateATR(
  candles,
  period = 14
) {
  if (
    candles.length <= period
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

    trueRanges.push(
      trueRange
    );
  }

  if (
    trueRanges.length <
    period
  ) {
    return null;
  }

  let atr =
    mean(
      trueRanges.slice(
        0,
        period
      )
    );

  for (
    let i = period;
    i < trueRanges.length;
    i++
  ) {
    atr =
      (
        atr *
          (period - 1) +
        trueRanges[i]
      ) / period;
  }

  return atr;
}

/*
=========================================================
 STOCHASTIC 14 / 3 / 3
=========================================================
*/

function calculateStochastic(
  candles,
  period = 14,
  smoothK = 3,
  smoothD = 3
) {
  if (
    candles.length <
    period +
      smoothK +
      smoothD
  ) {
    return null;
  }

  const rawK = [];

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
      Math.max(
        ...window.map(
          candle =>
            candle.high
        )
      );

    const lowestLow =
      Math.min(
        ...window.map(
          candle =>
            candle.low
        )
      );

    const close =
      candles[i].close;

    const denominator =
      highestHigh -
      lowestLow;

    const k =
      denominator === 0
        ? 50
        : (
            (close -
              lowestLow) /
            denominator
          ) *
          100;

    rawK.push(k);
  }

  if (
    rawK.length <
    smoothK
  ) {
    return null;
  }

  const smoothedK = [];

  for (
    let i = smoothK - 1;
    i < rawK.length;
    i++
  ) {
    smoothedK.push(
      mean(
        rawK.slice(
          i -
            smoothK +
            1,
          i + 1
        )
      )
    );
  }

  if (
    smoothedK.length <
    smoothD
  ) {
    return null;
  }

  const k =
    smoothedK[
      smoothedK.length - 1
    ];

  const d =
    mean(
      smoothedK.slice(
        -smoothD
      )
    );

  return {
    k: round(k, 4),
    d: round(d, 4)
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
  if (
    candles.length <
    lookback
  ) {
    return null;
  }

  const recent =
    candles.slice(
      -lookback
    );

  const highs =
    recent.map(
      candle =>
        candle.high
    );

  const lows =
    recent.map(
      candle =>
        candle.low
    );

  const resistance =
    Math.max(...highs);

  const support =
    Math.min(...lows);

  const current =
    recent[
      recent.length - 1
    ].close;

  const range =
    resistance - support;

  const position =
    range > 0
      ? (
          current -
          support
        ) / range
      : 0.5;

  return {
    support: round(
      support,
      8
    ),

    resistance: round(
      resistance,
      8
    ),

    position: round(
      position,
      4
    ),

    range: round(
      range,
      8
    )
  };
}

/*
=========================================================
 MOMENTUM 5
=========================================================
*/

function calculateMomentum(
  values,
  period = 5
) {
  if (
    values.length <= period
  ) {
    return null;
  }

  const current =
    values[
      values.length - 1
    ];

  const previous =
    values[
      values.length -
        1 -
        period
    ];

  return current - previous;
}

/*
=========================================================
 INDICATOR ENGINE
=========================================================
*/

function calculateIndicators(
  candles
) {
  if (
    candles.length < 60
  ) {
    throw new Error(
      `At least 60 candles are required. Received ${candles.length}`
    );
  }

  const closes =
    candles.map(
      candle =>
        candle.close
    );

  const currentPrice =
    closes[
      closes.length - 1
    ];

  const ema9 =
    calculateEMA(
      closes,
      9
    );

  const ema21 =
    calculateEMA(
      closes,
      21
    );

  const rsi14 =
    calculateRSI(
      closes,
      14
    );

  const momentum =
    calculateMomentum(
      closes,
      5
    );

  const macd =
    calculateMACD(
      closes,
      12,
      26,
      9
    );

  const bollinger =
    calculateBollingerBands(
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

  return {
    currentPrice:
      round(
        currentPrice,
        8
      ),

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
        4
      ),

    momentum:
      round(
        momentum,
        8
      ),

    macd,

    bollinger,

    atr:
      round(
        atr,
        8
      ),

    stochastic,

    supportResistance
  };
}

/*
=========================================================
 SIGNAL ENGINE
=========================================================
*/

function analyzeSignal(
  candles
) {
  const indicators =
    calculateIndicators(
      candles
    );

  const {
    currentPrice,
    ema9,
    ema21,
    rsi14,
    momentum,
    macd,
    bollinger,
    atr,
    stochastic,
    supportResistance
  } = indicators;

  let bullishScore = 0;
  let bearishScore = 0;

  const bullishReasons = [];
  const bearishReasons = [];
  const warnings = [];

  /*
  -------------------------------------------------------
  EMA TREND
  -------------------------------------------------------
  */

  if (ema9 > ema21) {
    bullishScore += 15;

    bullishReasons.push(
      "EMA 9 is above EMA 21"
    );
  }

  else if (ema9 < ema21) {
    bearishScore += 15;

    bearishReasons.push(
      "EMA 9 is below EMA 21"
    );
  }

  /*
  -------------------------------------------------------
  RSI
  -------------------------------------------------------
  */

  if (
    rsi14 >= 52 &&
    rsi14 < 70
  ) {
    bullishScore += 10;

    bullishReasons.push(
      "RSI supports bullish momentum"
    );
  }

  if (
    rsi14 <= 48 &&
    rsi14 > 30
  ) {
    bearishScore += 10;

    bearishReasons.push(
      "RSI supports bearish momentum"
    );
  }

  if (rsi14 >= 70) {
    warnings.push(
      "RSI is overbought"
    );
  }

  if (rsi14 <= 30) {
    warnings.push(
      "RSI is oversold"
    );
  }

  /*
  -------------------------------------------------------
  MOMENTUM
  -------------------------------------------------------
  */

  if (momentum > 0) {
    bullishScore += 10;

    bullishReasons.push(
      "Momentum is positive"
    );
  }

  else if (momentum < 0) {
    bearishScore += 10;

    bearishReasons.push(
      "Momentum is negative"
    );
  }

  /*
  -------------------------------------------------------
  MACD
  -------------------------------------------------------
  */

  if (macd) {
    if (
      macd.macd >
        macd.signal &&
      macd.histogram > 0
    ) {
      bullishScore += 15;

      bullishReasons.push(
        "MACD is bullish"
      );
    }

    if (
      macd.macd <
        macd.signal &&
      macd.histogram < 0
    ) {
      bearishScore += 15;

      bearishReasons.push(
        "MACD is bearish"
      );
    }
  }

  /*
  -------------------------------------------------------
  BOLLINGER BANDS
  -------------------------------------------------------
  */

  if (bollinger) {
    if (
      bollinger.position > 0.5 &&
      bollinger.position < 0.9
    ) {
      bullishScore += 10;

      bullishReasons.push(
        "Price position supports bullish direction"
      );
    }

    if (
      bollinger.position < 0.5 &&
      bollinger.position > 0.1
    ) {
      bearishScore += 10;

      bearishReasons.push(
        "Price position supports bearish direction"
      );
    }

    if (
      bollinger.position >= 0.95
    ) {
      warnings.push(
        "Price is near the upper Bollinger Band"
      );
    }

    if (
      bollinger.position <= 0.05
    ) {
      warnings.push(
        "Price is near the lower Bollinger Band"
      );
    }
  }

  /*
  -------------------------------------------------------
  STOCHASTIC
  -------------------------------------------------------
  */

  if (stochastic) {
    if (
      stochastic.k >
        stochastic.d &&
      stochastic.k > 50 &&
      stochastic.k < 90
    ) {
      bullishScore += 10;

      bullishReasons.push(
        "Stochastic supports bullish momentum"
      );
    }

    if (
      stochastic.k <
        stochastic.d &&
      stochastic.k < 50 &&
      stochastic.k > 10
    ) {
      bearishScore += 10;

      bearishReasons.push(
        "Stochastic supports bearish momentum"
      );
    }

    if (
      stochastic.k >= 90
    ) {
      warnings.push(
        "Stochastic is strongly overbought"
      );
    }

    if (
      stochastic.k <= 10
    ) {
      warnings.push(
        "Stochastic is strongly oversold"
      );
    }
  }

  /*
  -------------------------------------------------------
  ATR VOLATILITY
  -------------------------------------------------------
  */

  const atrPercent =
    atr && currentPrice
      ? (
          atr /
          currentPrice
        ) * 100
      : 0;

  if (
    atrPercent > 0 &&
    atrPercent < 0.01
  ) {
    warnings.push(
      "ATR indicates very low short-term volatility"
    );
  }

  /*
  -------------------------------------------------------
  SUPPORT / RESISTANCE
  -------------------------------------------------------
  */

  if (supportResistance) {
    const {
      position
    } =
      supportResistance;

    if (
      position > 0.90
    ) {
      warnings.push(
        "Price is close to resistance"
      );
    }

    if (
      position < 0.10
    ) {
      warnings.push(
        "Price is close to support"
      );
    }

    if (
      bullishScore >
        bearishScore &&
      position >= 0.20 &&
      position <= 0.75
    ) {
      bullishScore += 5;

      bullishReasons.push(
        "Price location is acceptable relative to support/resistance"
      );
    }

    if (
      bearishScore >
        bullishScore &&
      position >= 0.25 &&
      position <= 0.80
    ) {
      bearishScore += 5;

      bearishReasons.push(
        "Price location is acceptable relative to support/resistance"
      );
    }
  }

  /*
  -------------------------------------------------------
  FINAL SIGNAL
  -------------------------------------------------------
  */

  const maxPossibleScore = 85;

  let signal = "NO TRADE";

  let directionScore = 0;

  let confidence = 0;

  const difference =
    Math.abs(
      bullishScore -
        bearishScore
    );

  /*
  CALL
  */

  if (
    bullishScore >= 60 &&
    bullishScore >
      bearishScore &&
    difference >= 15 &&
    !warnings.includes(
      "Price is close to resistance"
    )
  ) {
    signal = "CALL";

    directionScore =
      bullishScore;

    confidence =
      Math.round(
        (
          bullishScore /
          maxPossibleScore
        ) * 100
      );
  }

  /*
  PUT
  */

  else if (
    bearishScore >= 60 &&
    bearishScore >
      bullishScore &&
    difference >= 15 &&
    !warnings.includes(
      "Price is close to support"
    )
  ) {
    signal = "PUT";

    directionScore =
      bearishScore;

    confidence =
      Math.round(
        (
          bearishScore /
          maxPossibleScore
        ) * 100
      );
  }

  confidence =
    Math.max(
      0,
      Math.min(
        99,
        confidence
      )
    );

  let strength =
    "NO TRADE";

  if (
    signal !==
    "NO TRADE"
  ) {
    if (
      confidence >= 90
    ) {
      strength =
        "VERY STRONG";
    }

    else if (
      confidence >= 80
    ) {
      strength =
        "STRONG";
    }

    else if (
      confidence >= 70
    ) {
      strength =
        "MODERATE";
    }

    else {
      strength =
        "WEAK";
    }
  }

  let reason;

  if (signal === "CALL") {
    reason =
      "Multiple bullish indicators are aligned.";
  }

  else if (signal === "PUT") {
    reason =
      "Multiple bearish indicators are aligned.";
  }

  else {
    reason =
      "Market conditions are not sufficiently aligned.";
  }

  return {
    signal,

    confidence,

    strength,

    score: {
      bullish:
        bullishScore,

      bearish:
        bearishScore,

      difference,

      selected:
        directionScore
    },

    reason,

    confirmations: {
      bullish:
        bullishReasons,

      bearish:
        bearishReasons
    },

    warnings,

    indicators
  };
}

/*
=========================================================
 MARKET DATA
=========================================================
*/

async function getMarketCandles(
  pair
) {
  if (
    !livePairs.includes(pair)
  ) {
    throw new Error(
      `Unsupported LIVE pair: ${pair}`
    );
  }

  const cached =
    liveCache.get(pair);

  if (
    cached &&
    cached.length >= 60
  ) {
    return {
      marketType:
        "LIVE MARKET",

      candles:
        cached
    };
  }

  const candles =
    await fetchLiveCandles(
      pair
    );

  liveCache.set(
    pair,
    candles
  );

  lastLiveUpdate =
    new Date().toISOString();

  return {
    marketType:
      "LIVE MARKET",

    candles
  };
}

/*
=========================================================
 BACKGROUND LIVE UPDATE
=========================================================
*/

async function updateLiveData() {
  if (!TWELVE_DATA_API_KEY) {
    console.log(
      "[TWELVE DATA] API key not configured"
    );

    return;
  }

  for (
    const pair of livePairs
  ) {
    try {
      const candles =
        await fetchLiveCandles(
          pair
        );

      liveCache.set(
        pair,
        candles
      );

      console.log(
        `[TWELVE DATA] Updated ${candles.length} candles for ${pair}`
      );
    }

    catch (error) {
      console.error(
        `[TWELVE DATA] ${pair}:`,
        error.message
      );
    }
  }

  lastLiveUpdate =
    new Date().toISOString();
}

/*
=========================================================
 HEALTH
=========================================================
*/

app.get(
  "/api/health",
  (req, res) => {
    const liveStatus = {};

    for (
      const pair of livePairs
    ) {
      const candles =
        liveCache.get(pair);

      liveStatus[pair] = {
        status:
          candles &&
          candles.length >= 60
            ? "live"
            : "not_loaded",

        candles:
          candles
            ? candles.length
            : 0
      };
    }

    res.json({
      status:
        "ok",

      version:
        VERSION,

      service:
        "po-ai-predictor-api",

      liveDataConfigured:
        Boolean(
          TWELVE_DATA_API_KEY
        ),

      source:
        "Twelve Data",

      defaultSymbol:
        DEFAULT_PAIR,

      interval:
        TWELVE_DATA_INTERVAL,

      lastLiveUpdate,

      livePairs:
        liveStatus,

      indicators: {
        ema:
          "9 / 21",

        rsi:
          "14",

        momentum:
          "5",

        macd:
          "12 / 26 / 9",

        bollinger:
          "20 / 2",

        atr:
          "14",

        stochastic:
          "14 / 3 / 3",

        supportResistance:
          "30 candles"
      }
    });
  }
);

/*
=========================================================
 CANDLES ENDPOINT
=========================================================
*/

app.get(
  "/api/candles",
  async (req, res) => {
    try {
      const pair =
        req.query.pair ||
        DEFAULT_PAIR;

      const result =
        await getMarketCandles(
          pair
        );

      res.json({
        status:
          "ready",

        marketType:
          result.marketType,

        pair,

        count:
          result.candles.length,

        candles:
          result.candles
      });
    }

    catch (error) {
      res.status(500).json({
        status:
          "error",

        message:
          error.message
      });
    }
  }
);

/*
=========================================================
 MARKET ANALYSIS
=========================================================
*/

app.get(
  "/api/market-analysis",
  async (req, res) => {
    try {
      const pair =
        req.query.pair ||
        DEFAULT_PAIR;

      const result =
        await getMarketCandles(
          pair
        );

      const analysis =
        analyzeSignal(
          result.candles
        );

      res.json({
        status:
          "ready",

        marketType:
          result.marketType,

        pair,

        candles:
          result.candles.length,

        analysis
      });
    }

    catch (error) {
      res.status(500).json({
        status:
          "error",

        message:
          error.message
      });
    }
  }
);

/*
=========================================================
 SIGNAL ENDPOINT
=========================================================
*/

app.get(
  "/api/signal",
  async (req, res) => {
    try {
      const pair =
        req.query.pair ||
        DEFAULT_PAIR;

      const result =
        await getMarketCandles(
          pair
        );

      const analysis =
        analyzeSignal(
          result.candles
        );

      res.json({
        status:
          "ready",

        marketType:
          result.marketType,

        pair,

        signal:
          analysis.signal,

        confidence:
          analysis.confidence,

        strength:
          analysis.strength,

        reason:
          analysis.reason,

        score:
          analysis.score,

        confirmations:
          analysis.confirmations,

        warnings:
          analysis.warnings,

        indicators:
          analysis.indicators,

        candles:
          result.candles.length,

        generatedAt:
          new Date().toISOString()
      });
    }

    catch (error) {
      res.status(500).json({
        status:
          "error",

        message:
          error.message
      });
    }
  }
);

/*
=========================================================
 ROOT
=========================================================
*/

app.get(
  "/",
  (req, res) => {
    res.json({
      message:
        "PO AI Predictor API is live!",

      version:
        VERSION,

      market:
        "LIVE MARKET ONLY",

      source:
        "Twelve Data",

      indicators: [
        "EMA 9/21",
        "RSI 14",
        "Momentum 5",
        "MACD 12/26/9",
        "Bollinger Bands 20/2",
        "ATR 14",
        "Stochastic 14/3/3",
        "Support/Resistance 30"
      ]
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
      `PO AI Predictor API V${VERSION} running on port ${PORT}`
    );

    console.log(
      `Twelve Data configured: ${Boolean(
        TWELVE_DATA_API_KEY
      )}`
    );

    updateLiveData();

    setInterval(
      updateLiveData,
      LIVE_DATA_INTERVAL
    );
  }
);
