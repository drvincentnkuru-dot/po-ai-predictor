const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
=========================================================
 PO AI PREDICTOR BACKEND V6.1
 LIVE + OTC MULTI-INDICATOR ENGINE

 LIVE DATA:
 Twelve Data

 OTC DATA:
 OTCharts

 INDICATORS:
 EMA 9 / 21
 RSI 14
 Momentum 5
 MACD 12 / 26 / 9
 Bollinger Bands 20 / 2
 ATR 14
 Stochastic 14 / 3 / 3
 Support / Resistance

 IMPORTANT:
 Technical indicators do NOT guarantee a winning trade.
 The engine uses confirmation scoring and NO TRADE filtering.
=========================================================
*/

const VERSION = "6.1.0";

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const OTCHARTS_API_KEY = process.env.OTCHARTS_API_KEY;

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

const otcSymbolMap = {
  "EUR/USD OTC": "EURUSD_otc",
  "GBP/USD OTC": "GBPUSD_otc",
  "USD/JPY OTC": "USDJPY_otc",
  "USD/CHF OTC": "USDCHF_otc",
  "AUD/USD OTC": "AUDUSD_otc",
  "USD/CAD OTC": "USDCAD_otc",
  "NZD/USD OTC": "NZDUSD_otc",
  "EUR/GBP OTC": "EURGBP_otc",
  "EUR/JPY OTC": "EURJPY_otc",
  "GBP/JPY OTC": "GBPJPY_otc"
};

const liveCache = new Map();
const otcCache = new Map();

let lastLiveUpdate = null;
let lastOTCUpdate = null;

/*
=========================================================
 BASIC HELPERS
=========================================================
*/

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;

  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function standardDeviation(values) {
  const avg = mean(values);

  if (avg === null) return null;

  const variance =
    values.reduce((sum, value) => {
      return sum + Math.pow(value - avg, 2);
    }, 0) / values.length;

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

    volume: safeNumber(candle.volume, 0)
  };
}

function cleanCandles(candles) {
  return candles
    .map(normalizeCandle)
    .filter(
      c =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    )
    .sort((a, b) => {
      return new Date(a.time || 0) - new Date(b.time || 0);
    });
}

/*
=========================================================
 FETCH LIVE DATA - TWELVE DATA
=========================================================
*/

async function fetchLiveCandles(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is not configured");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(pair) +
    "&interval=" +
    encodeURIComponent(TWELVE_DATA_INTERVAL) +
    "&outputsize=" +
    encodeURIComponent(MAX_CANDLES) +
    "&apikey=" +
    encodeURIComponent(TWELVE_DATA_API_KEY);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(
      data.message || "Twelve Data returned an error"
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "Twelve Data returned no candle data"
    );
  }

  return cleanCandles(data.values);
}

/*
=========================================================
 FETCH OTC DATA - OTCHARTS
=========================================================
*/

async function fetchOTCCandles(displayPair) {
  if (!OTCHARTS_API_KEY) {
    throw new Error("OTCHARTS_API_KEY is not configured");
  }

  const symbol = otcSymbolMap[displayPair];

  if (!symbol) {
    throw new Error(
      `Unsupported OTC pair: ${displayPair}`
    );
  }

  const url =
    "https://otcharts.com/v1/candles" +
    "?venue=otc" +
    "&symbol=" +
    encodeURIComponent(symbol) +
    "&timeframe=1m" +
    "&limit=" +
    encodeURIComponent(Math.min(MAX_CANDLES, 200));

  /*
    OTCharts requires:

    Authorization: Bearer otc_live_...
  */

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${OTCHARTS_API_KEY}`,
      "Accept": "application/json"
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `OTCharts returned non-JSON response: ${text.slice(0, 200)}`
    );
  }

  if (!response.ok) {
    const message =
      data?.error ||
      data?.message ||
      `OTCharts HTTP ${response.status}`;

    throw new Error(message);
  }

  /*
    OTCharts may return different candle container names.
    We support the common possibilities.
  */

  let rawCandles = [];

  if (Array.isArray(data)) {
    rawCandles = data;
  } else if (Array.isArray(data.candles)) {
    rawCandles = data.candles;
  } else if (Array.isArray(data.data)) {
    rawCandles = data.data;
  } else if (Array.isArray(data.results)) {
    rawCandles = data.results;
  }

  if (!rawCandles.length) {
    throw new Error(
      "OTCharts returned no candle data"
    );
  }

  return cleanCandles(rawCandles);
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

  const multiplier = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

/*
=========================================================
 RSI
=========================================================
*/

function calculateRSI(values, period = 14) {
  if (values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      ((averageGain * (period - 1)) + gain) / period;

    averageLoss =
      ((averageLoss * (period - 1)) + loss) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
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
  if (values.length < slowPeriod + signalPeriod) {
    return null;
  }

  const fastMultiplier = 2 / (fastPeriod + 1);
  const slowMultiplier = 2 / (slowPeriod + 1);

  let fastEMA =
    mean(values.slice(0, fastPeriod));

  let slowEMA =
    mean(values.slice(0, slowPeriod));

  const macdValues = [];

  /*
    Build synchronized EMA values.
  */

  for (let i = slowPeriod; i < values.length; i++) {
    fastEMA =
      (values[i] - fastEMA) *
      fastMultiplier +
      fastEMA;

    slowEMA =
      (values[i] - slowEMA) *
      slowMultiplier +
      slowEMA;

    macdValues.push(fastEMA - slowEMA);
  }

  if (macdValues.length < signalPeriod) {
    return null;
  }

  const signal =
    calculateEMA(macdValues, signalPeriod);

  if (signal === null) {
    return null;
  }

  const macd =
    macdValues[macdValues.length - 1];

  const histogram =
    macd - signal;

  return {
    macd: round(macd, 8),
    signal: round(signal, 8),
    histogram: round(histogram, 8)
  };
}

/*
=========================================================
 BOLLINGER BANDS
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

  const middle = mean(recent);

  const deviation =
    standardDeviation(recent);

  if (middle === null || deviation === null) {
    return null;
  }

  const upper =
    middle + multiplier * deviation;

  const lower =
    middle - multiplier * deviation;

  const current =
    values[values.length - 1];

  const bandwidth =
    middle !== 0
      ? (upper - lower) / middle
      : 0;

  const position =
    upper !== lower
      ? (current - lower) /
        (upper - lower)
      : 0.5;

  return {
    upper: round(upper, 8),
    middle: round(middle, 8),
    lower: round(lower, 8),
    bandwidth: round(bandwidth, 8),
    position: round(position, 4)
  };
}

/*
=========================================================
 ATR
=========================================================
*/

function calculateATR(candles, period = 14) {
  if (candles.length <= period) {
    return null;
  }

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
    );

    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return null;
  }

  let atr =
    mean(
      trueRanges.slice(0, period)
    );

  for (
    let i = period;
    i < trueRanges.length;
    i++
  ) {
    atr =
      ((atr * (period - 1)) +
        trueRanges[i]) / period;
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
  if (candles.length < period + smoothK + smoothD) {
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
        ...window.map(c => c.high)
      );

    const lowestLow =
      Math.min(
        ...window.map(c => c.low)
      );

    const close =
      candles[i].close;

    const denominator =
      highestHigh - lowestLow;

    const k =
      denominator === 0
        ? 50
        : ((close - lowestLow) /
            denominator) *
          100;

    rawK.push(k);
  }

  if (rawK.length < smoothK) {
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
          i - smoothK + 1,
          i + 1
        )
      )
    );
  }

  if (smoothedK.length < smoothD) {
    return null;
  }

  const k =
    smoothedK[smoothedK.length - 1];

  const d =
    mean(
      smoothedK.slice(-smoothD)
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
  if (candles.length < lookback) {
    return null;
  }

  const recent =
    candles.slice(-lookback);

  const highs =
    recent.map(c => c.high);

  const lows =
    recent.map(c => c.low);

  const resistance =
    Math.max(...highs);

  const support =
    Math.min(...lows);

  const current =
    recent[recent.length - 1].close;

  const range =
    resistance - support;

  const position =
    range > 0
      ? (current - support) / range
      : 0.5;

  return {
    support: round(support, 8),
    resistance: round(resistance, 8),
    position: round(position, 4),
    range: round(range, 8)
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
    values[values.length - 1 - period];

  return current - previous;
}

/*
=========================================================
 COMPLETE INDICATOR ENGINE
=========================================================
*/

function calculateIndicators(candles) {
  if (candles.length < 60) {
    throw new Error(
      `At least 60 candles required. Received ${candles.length}`
    );
  }

  const closes =
    candles.map(c => c.close);

  const currentPrice =
    closes[closes.length - 1];

  const ema9 =
    calculateEMA(closes, 9);

  const ema21 =
    calculateEMA(closes, 21);

  const rsi14 =
    calculateRSI(closes, 14);

  const momentum =
    calculateMomentum(closes, 5);

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
    currentPrice: round(currentPrice, 8),

    ema9: round(ema9, 8),
    ema21: round(ema21, 8),

    rsi14: round(rsi14, 4),

    momentum: round(momentum, 8),

    macd,

    bollinger
