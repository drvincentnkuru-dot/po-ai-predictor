const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
=========================================================
PO AI PREDICTOR BACKEND V6
LIVE + OTC MARKET DATA
=========================================================

LIVE DATA
---------
Provider: Twelve Data

OTC DATA
--------
Provider: OTCharts

OTCharts authentication:
Authorization: Bearer <OTCHARTS_API_KEY>

IMPORTANT:
Do NOT put API keys directly in this file.

Render Environment Variables:

TWELVE_DATA_API_KEY
OTCHARTS_API_KEY
=========================================================
*/


/* ======================================================
   CONFIGURATION
====================================================== */

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const OTCHARTS_API_KEY =
  process.env.OTCHARTS_API_KEY || "";

const TWELVE_DATA_BASE_URL =
  "https://api.twelvedata.com";

const OTCHARTS_BASE_URL =
  "https://otcharts.com";

const DEFAULT_INTERVAL = "1min";

const LIVE_DATA_INTERVAL =
  Number(process.env.LIVE_DATA_INTERVAL || 60000);

const OTC_DATA_INTERVAL =
  Number(process.env.OTC_DATA_INTERVAL || 60000);

const MAX_CANDLES =
  Number(process.env.MAX_CANDLES || 200);


/* ======================================================
   SUPPORTED PAIRS
====================================================== */

const LIVE_PAIRS = [
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

const OTC_PAIRS = [
  "EUR/USD OTC",
  "GBP/USD OTC",
  "USD/JPY OTC",
  "USD/CHF OTC",
  "AUD/USD OTC",
  "USD/CAD OTC",
  "NZD/USD OTC",
  "EUR/GBP OTC",
  "EUR/JPY OTC",
  "GBP/JPY OTC"
];


/* ======================================================
   OTC PAIR MAPPING
====================================================== */

const OTC_SYMBOL_MAP = {
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


/* ======================================================
   DATA CACHE
====================================================== */

const liveCache = {};
const otcCache = {};


/* ======================================================
   UTILITY FUNCTIONS
====================================================== */

function nowISO() {
  return new Date().toISOString();
}


function isLivePair(pair) {
  return LIVE_PAIRS.includes(pair);
}


function isOTCPair(pair) {
  return OTC_PAIRS.includes(pair);
}


function isSupportedPair(pair) {
  return isLivePair(pair) || isOTCPair(pair);
}


function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}


function round(value, decimals = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = Math.pow(10, decimals);

  return Math.round(value * factor) / factor;
}


/* ======================================================
   HTTP JSON HELPER
====================================================== */

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, options);

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON response (${response.status}): ${text.slice(0, 500)}`
    );
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      `HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}


/* ======================================================
   NORMALIZE CANDLE
====================================================== */

function normalizeCandle(candle) {
  if (!candle || typeof candle !== "object") {
    return null;
  }

  const timestamp =
    candle.timestamp ??
    candle.time ??
    candle.datetime ??
    candle.date ??
    candle.t;

  const open =
    candle.open ??
    candle.o;

  const high =
    candle.high ??
    candle.h;

  const low =
    candle.low ??
    candle.l;

  const close =
    candle.close ??
    candle.c;

  const volume =
    candle.volume ??
    candle.v ??
    0;

  const parsedTimestamp =
    typeof timestamp === "number"
      ? timestamp
      : Date.parse(timestamp);

  const parsedOpen = Number(open);
  const parsedHigh = Number(high);
  const parsedLow = Number(low);
  const parsedClose = Number(close);
  const parsedVolume = Number(volume);

  if (
    !Number.isFinite(parsedTimestamp) ||
    !Number.isFinite(parsedOpen) ||
    !Number.isFinite(parsedHigh) ||
    !Number.isFinite(parsedLow) ||
    !Number.isFinite(parsedClose)
  ) {
    return null;
  }

  return {
    timestamp: parsedTimestamp,
    datetime: new Date(parsedTimestamp).toISOString(),
    open: parsedOpen,
    high: parsedHigh,
    low: parsedLow,
    close: parsedClose,
    volume: Number.isFinite(parsedVolume)
      ? parsedVolume
      : 0
  };
}


/* ======================================================
   NORMALIZE CANDLE ARRAY
====================================================== */

function normalizeCandles(rawData) {
  let candles = [];

  if (Array.isArray(rawData)) {
    candles = rawData;
  } else if (Array.isArray(rawData?.values)) {
    candles = rawData.values;
  } else if (Array.isArray(rawData?.data)) {
    candles = rawData.data;
  } else if (Array.isArray(rawData?.candles)) {
    candles = rawData.candles;
  } else if (Array.isArray(rawData?.result)) {
    candles = rawData.result;
  } else if (Array.isArray(rawData?.data?.candles)) {
    candles = rawData.data.candles;
  } else if (Array.isArray(rawData?.data?.values)) {
    candles = rawData.data.values;
  }

  const normalized = candles
    .map(normalizeCandle)
    .filter(Boolean);

  normalized.sort(
    (a, b) => a.timestamp - b.timestamp
  );

  return normalized.slice(-MAX_CANDLES);
}


/* ======================================================
   TWELVE DATA - LIVE MARKET
====================================================== */

async function fetchLiveCandles(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is not configured"
    );
  }

  const url =
    `${TWELVE_DATA_BASE_URL}/time_series` +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=${encodeURIComponent(DEFAULT_INTERVAL)}` +
    `&outputsize=${MAX_CANDLES}` +
    `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

  const data = await fetchJSON(url);

  if (data?.status === "error") {
    throw new Error(
      data?.message || "Twelve Data returned an error"
    );
  }

  const candles = normalizeCandles(data);

  if (candles.length < 30) {
    throw new Error(
      `Insufficient LIVE candles: ${candles.length}`
    );
  }

  liveCache[pair] = {
    pair,
    status: "live",
    source: "Twelve Data",
    lastUpdate: nowISO(),
    candles,
    error: null
  };

  return candles;
}


/* ======================================================
   OTCHARTS - OTC MARKET
====================================================== */

async function fetchOTCCandles(pair) {
  if (!OTCHARTS_API_KEY) {
    throw new Error(
      "OTCHARTS_API_KEY is not configured"
    );
  }

  const otcSymbol = OTC_SYMBOL_MAP[pair];

  if (!otcSymbol) {
    throw new Error(
      `Unsupported OTC pair: ${pair}`
    );
  }

  /*
    OTCharts endpoint:

    /v1/candles
      venue=otc
      symbol=AUDUSD_otc
      timeframe=1m
      limit=200
  */

  const params = new URLSearchParams({
    venue: "otc",
    symbol: otcSymbol,
    timeframe: "1m",
    limit: String(MAX_CANDLES)
  });

  const url =
    `${OTCHARTS_BASE_URL}/v1/candles?${params.toString()}`;

  const data = await fetchJSON(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${OTCHARTS_API_KEY}`
    }
  });

  /*
    Keep the raw response only in memory if needed for debugging.
    Never expose the API key.
  */

  const candles = normalizeCandles(data);

  if (candles.length < 30) {
    throw new Error(
      `Insufficient OTC candles from OTCharts for ${pair}: ${candles.length}`
    );
  }

  otcCache[pair] = {
    pair,
    otcSymbol,
    status: "live",
    source: "OTCharts",
    lastUpdate: nowISO(),
    candles,
    error: null
  };

  return candles;
}


/* ======================================================
   GET CANDLES
====================================================== */

async function getCandles(pair) {
  if (isLivePair(pair)) {
    return fetchLiveCandles(pair);
  }

  if (isOTCPair(pair)) {
    return fetchOTCCandles(pair);
  }

  throw new Error(
    `Unsupported pair: ${pair}`
  );
}


/* ======================================================
   EMA
====================================================== */

function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let ema = 0;

  for (let i = 0; i < period; i++) {
    ema += values[i];
  }

  ema /= period;

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier +
      ema;
  }

  return ema;
}


/* ======================================================
   RSI
====================================================== */

function calculateRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      values[i] - values[i - 1];

    if (change > 0) {
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
      values[i] - values[i - 1];

    const gain =
      change > 0 ? change : 0;

    const loss =
      change < 0 ? Math.abs(change) : 0;

    averageGain =
      ((averageGain * (period - 1)) + gain) /
      period;

    averageLoss =
      ((averageLoss * (period - 1)) + loss) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}


/* ======================================================
   MOMENTUM
====================================================== */

function calculateMomentum(values, lookback = 5) {
  if (
    !Array.isArray(values) ||
    values.length <= lookback
  ) {
    return null;
  }

  const current =
    values[values.length - 1];

  const previous =
    values[values.length - 1 - lookback];

  return current - previous;
}


/* ======================================================
   ATR-LIKE VOLATILITY
====================================================== */

function calculateAverageRange(candles, period = 14) {
  if (
    !Array.isArray(candles) ||
    candles.length < period + 1
  ) {
    return null;
  }

  const ranges = candles
    .slice(-(period + 1))
    .map(candle =>
      candle.high - candle.low
    );

  const validRanges =
    ranges.filter(Number.isFinite);

  if (!validRanges.length) {
    return null;
  }

  return (
    validRanges.reduce(
      (sum, value) => sum + value,
      0
    ) / validRanges.length
  );
}


/* ======================================================
   MARKET ANALYSIS
====================================================== */

function analyzeMarket(candles) {
  if (
    !Array.isArray(candles) ||
    candles.length < 30
  ) {
    return {
      signal: "NO TRADE",
      confidence: 0,
      reason: "Not enough market data",
      indicators: null
    };
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

  const averageRange =
    calculateAverageRange(candles, 14);

  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(ema9) ||
    !Number.isFinite(ema21) ||
    !Number.isFinite(rsi14) ||
    !Number.isFinite(momentum)
  ) {
    return {
      signal: "NO TRADE",
      confidence: 0,
      reason: "Indicators could not be calculated",
      indicators: {
        currentPrice,
        ema9,
        ema21,
        rsi14,
        momentum,
        averageRange
      }
    };
  }


  /* ====================================================
     TREND
  ==================================================== */

  const bullishTrend =
    ema9 > ema21;

  const bearishTrend =
    ema9 < ema21;


  /* ====================================================
     MOMENTUM
  ==================================================== */

  const bullishMomentum =
    momentum > 0;

  const bearishMomentum =
    momentum < 0;


  /* ====================================================
     RSI
  ==================================================== */

  /*
    Avoid buying when RSI is extremely overbought.
    Avoid selling when RSI is extremely oversold.
  */

  const bullishRSI =
    rsi14 >= 50 &&
    rsi14 < 70;

  const bearishRSI =
    rsi14 <= 50 &&
    rsi14 > 30;


  /* ====================================================
     SCORE
  ==================================================== */

  let bullishScore = 0;
  let bearishScore = 0;

  if (bullishTrend) {
    bullishScore += 1;
  }

  if (bearishTrend) {
    bearishScore += 1;
  }

  if (bullishMomentum) {
    bullishScore += 1;
  }

  if (bearishMomentum) {
    bearishScore += 1;
  }

  if (bullishRSI) {
    bullishScore += 1;
  }

  if (bearishRSI) {
    bearishScore += 1;
  }


  /* ====================================================
     SIGNAL DECISION
  ==================================================== */

  let signal = "NO TRADE";
  let confidence = 0;
  let reason =
    "Market conditions are not sufficiently aligned";


  /*
    Require all three conditions to agree.

    CALL:
      EMA9 > EMA21
      momentum > 0
      RSI between 50 and 70

    PUT:
      EMA9 < EMA21
      momentum < 0
      RSI between 30 and 50
  */

  if (
    bullishTrend &&
    bullishMomentum &&
    bullishRSI
  ) {
    signal = "CALL";

    confidence = 70;

    reason =
      "Bullish trend, positive momentum and supportive RSI";
  }

  else if (
    bearishTrend &&
    bearishMomentum &&
    bearishRSI
  ) {
    signal = "PUT";

    confidence = 70;

    reason =
      "Bearish trend, negative momentum and supportive RSI";
  }

  /*
    Stronger alignment.

    If the trend and momentum are aligned very clearly,
    increase confidence.
  */

  if (
    signal === "CALL" &&
    rsi14 >= 55 &&
    ema9 > ema21 &&
    momentum > 0
  ) {
    confidence = 80;
  }

  if (
    signal === "PUT" &&
    rsi14 <= 45 &&
    ema9 < ema21 &&
    momentum < 0
  ) {
    confidence = 80;
  }


  /*
    Extremely strong alignment.
  */

  const emaDistance =
    Math.abs(ema9 - ema21);

  const normalizedMomentum =
    currentPrice !== 0
      ? Math.abs(momentum) / currentPrice
      : 0;

  if (
    signal === "CALL" &&
    rsi14 >= 55 &&
    rsi14 < 68 &&
    emaDistance > 0 &&
    normalizedMomentum > 0
  ) {
    confidence = 90;
  }

  if (
    signal === "PUT" &&
    rsi14 <= 45 &&
    rsi14 > 32 &&
    emaDistance > 0 &&
    normalizedMomentum > 0
  ) {
    confidence = 90;
  }


  /*
    Safety:
    Never report 100% confidence.

    Market prediction cannot be guaranteed.
  */

  confidence =
    clamp(confidence, 0, 90);


  return {
    signal,
    confidence,
    reason,
    currentPrice: round(currentPrice, 6),
    indicators: {
      ema9: round(ema9, 8),
      ema21: round(ema21, 8),
      rsi14: round(rsi14, 2),
      momentum: round(momentum, 8),
      averageRange: round(averageRange, 8),
      bullishScore,
      bearishScore
    }
  };
}


/* ======================================================
   HEALTH ENDPOINT
====================================================== */

app.get("/api/health", (req, res) => {
  const liveStatus = {};

  for (const pair of LIVE_PAIRS) {
    const cached =
      liveCache[pair];

    liveStatus[pair] = {
      status:
        cached?.status || "not_loaded",
      lastUpdate:
        cached?.lastUpdate || null,
      source:
        cached?.source || "Twelve Data",
      candles:
        cached?.candles?.length || 0,
      error:
        cached?.error || null
    };
  }


  const otcStatus = {};

  for (const pair of OTC_PAIRS) {
    const cached =
      otcCache[pair];

    otcStatus[pair] = {
      status:
        cached?.status || "not_loaded",
      otcSymbol:
        OTC_SYMBOL_MAP[pair],
      lastUpdate:
        cached?.lastUpdate || null,
      source:
        cached?.source || "OTCharts",
      candles:
        cached?.candles?.length || 0,
      error:
        cached?.error || null
    };
  }


  res.json({
    status: "ok",

    service:
      "PO AI Predictor Backend",

    version:
      "6.0.0",

    liveDataConfigured:
      Boolean(TWELVE_DATA_API_KEY),

    otcDataConfigured:
      Boolean(OTCHARTS_API_KEY),

    defaultSymbol:
      "EUR/USD",

    interval:
      DEFAULT_INTERVAL,

    sources: {
      live:
        "Twelve Data",

      otc:
        "OTCharts"
    },

    live:
      liveStatus,

    otc:
      otcStatus,

    timestamp:
      nowISO()
  });
});


/* ======================================================
   API CANDLES
====================================================== */

app.get("/api/candles", async (req, res) => {
  try {
    const pair =
      String(
        req.query.pair || "EUR/USD"
      ).trim();

    const count =
      Math.min(
        Math.max(
          Number(req.query.count || 100),
          1
        ),
        MAX_CANDLES
      );

    if (!isSupportedPair(pair)) {
      return res.status(400).json({
        status: "error",
        error:
          `Unsupported pair: ${pair}`,
        supportedLivePairs:
          LIVE_PAIRS,
        supportedOTCPairs:
          OTC_PAIRS
      });
    }

    const candles =
      await getCandles(pair);

    const result =
      candles.slice(-count);

    const marketType =
      isOTCPair(pair)
        ? "OTC"
        : "LIVE";

    const source =
      isOTCPair(pair)
        ? "OTCharts"
        : "Twelve Data";

    res.json({
      status: "ok",
      market: marketType,
      pair,
      source,
      count: result.length,
      candles: result
    });

  } catch (error) {

    const pair =
      String(
        req.query.pair || ""
      ).trim();

    if (isOTCPair(pair)) {
      otcCache[pair] = {
        ...(otcCache[pair] || {}),
        status: "error",
        error: error.message
      };
    }

    res.status(500).json({
      status: "error",
      market:
        isOTCPair(pair)
          ? "OTC"
          : "LIVE",
      pair,
      error:
        error.message
    });
  }
});


/* ======================================================
   MARKET ANALYSIS
====================================================== */

app.get("/api/market-analysis", async (req, res) => {
  try {
    const pair =
      String(
        req.query.pair || "EUR/USD"
      ).trim();

    if (!isSupportedPair(pair)) {
      return res.status(400).json({
        status: "error",
        error:
          `Unsupported pair: ${pair}`
      });
    }

    const candles =
      await getCandles(pair);

    const analysis =
      analyzeMarket(candles);

    const marketType =
      isOTCPair(pair)
        ? "OTC MARKET"
        : "LIVE MARKET";

    const source =
      isOTCPair(pair)
        ? "OTCharts"
        : "Twelve Data";

    res.json({
      status: "ready",

      market:
        marketType,

      pair,

      source,

      dataStatus:
        isOTCPair(pair)
          ? "OTC DATA CONNECTED"
          : "LIVE DATA CONNECTED",

      candles:
        candles.length,

      ...analysis,

      timestamp:
        nowISO()
    });

  } catch (error) {

    const pair =
      String(
        req.query.pair || "EUR/USD"
      ).trim();

    const isOTC =
      isOTCPair(pair);

    if (isOTC) {
      otcCache[pair] = {
        ...(otcCache[pair] || {}),
        status: "error",
        error: error.message
      };
    }

    res.status(500).json({
      status: "error",

      market:
        isOTC
          ? "OTC MARKET"
          : "LIVE MARKET",

      pair,

      dataStatus:
        isOTC
          ? "OTC DATA NOT AVAILABLE"
          : "LIVE DATA ERROR",

      signal:
        "NO TRADE",

      confidence:
        0,

      error:
        error.message,

      timestamp:
        nowISO()
    });
  }
});


/* ======================================================
   SIGNAL ENDPOINT
====================================================== */

app.get("/api/signal", async (req, res) => {
  try {
    const pair =
      String(
        req.query.pair || "EUR/USD"
      ).trim();

    if (!isSupportedPair(pair)) {
      return res.status(400).json({
        status: "error",
        error:
          `Unsupported pair: ${pair}`
      });
    }

    const candles =
      await getCandles(pair);

    const analysis =
      analyzeMarket(candles);

    const isOTC =
      isOTCPair(pair);

    const marketType =
      isOTC
        ? "OTC MARKET"
        : "LIVE MARKET";

    const source =
      isOTC
        ? "OTCharts"
        : "Twelve Data";

    res.json({
      status: "ready",

      market:
        marketType,

      pair,

      source,

      dataStatus:
        isOTC
          ? "OTC DATA CONNECTED"
          : "LIVE DATA CONNECTED",

      signal:
        analysis.signal,

      confidence:
        analysis.confidence,

      currentPrice:
        analysis.currentPrice,

      reason:
        analysis.reason,

      indicators:
        analysis.indicators,

      candles:
        candles.length,

      timestamp:
        nowISO()
    });

  } catch (error) {

    const pair =
      String(
        req.query.pair || "EUR/USD"
      ).trim();

    const isOTC =
      isOTCPair(pair);

    res.status(500).json({
      status: "error",

      market:
        isOTC
          ? "OTC MARKET"
          : "LIVE MARKET",

      pair,

      source:
        isOTC
          ? "OTCharts"
          : "Twelve Data",

      dataStatus:
        isOTC
          ? "OTC DATA NOT AVAILABLE"
          : "LIVE DATA ERROR",

      signal:
        "NO TRADE",

      confidence:
        0,

      error:
        error.message,

      timestamp:
        nowISO()
    });
  }
});


/* ======================================================
   ROOT
====================================================== */

app.get("/", (req, res) => {
  res.json({
    status: "ok",

    service:
      "PO AI Predictor Backend",

    version:
      "6.0.0",

    message:
      "PO AI Predictor API is live",

    markets: {
      live:
        "Twelve Data",

      otc:
        "OTCharts"
    },

    otcAuthentication:
      Boolean(OTCHARTS_API_KEY),

    endpoints: [
      "/api/health",
      "/api/candles?pair=EUR/USD",
      "/api/candles?pair=EUR/USD%20OTC",
      "/api/market-analysis?pair=EUR/USD",
      "/api/market-analysis?pair=EUR/USD%20OTC",
      "/api/signal?pair=EUR/USD",
      "/api/signal?pair=EUR/USD%20OTC"
    ]
  });
});


/* ======================================================
   404
====================================================== */

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    error: "Endpoint not found",
    path: req.path
  });
});


/* ======================================================
   GLOBAL ERROR HANDLER
====================================================== */

app.use((error, req, res, next) => {
  console.error(
    "[GLOBAL ERROR]",
    error
  );

  res.status(500).json({
    status: "error",
    error:
      "Internal server error"
  });
});


/* ======================================================
   START SERVER
====================================================== */

app.listen(PORT, () => {
  console.log(
    "================================================="
  );

  console.log(
    "PO AI PREDICTOR BACKEND V6"
  );

  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `LIVE DATA: ${
      TWELVE_DATA_API_KEY
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    }`
  );

  console.log(
    `OTC DATA: ${
      OTCHARTS_API_KEY
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    }`
  );

  console.log(
    "LIVE SOURCE: Twelve Data"
  );

  console.log(
    "OTC SOURCE: OTCharts"
  );

  console.log(
    "================================================="
  );
});


/* ======================================================
   BACKGROUND LIVE REFRESH
====================================================== */

async function refreshLiveData() {
  if (!TWELVE_DATA_API_KEY) {
    return;
  }

  for (const pair of LIVE_PAIRS) {
    try {
      await fetchLiveCandles(pair);

      console.log(
        `[TWELVE DATA] Updated candles for ${pair}`
      );

    } catch (error) {

      liveCache[pair] = {
        ...(liveCache[pair] || {}),
        status: "error",
        error: error.message
      };

      console.error(
        `[TWELVE DATA] ${pair}:`,
        error.message
      );
    }
  }
}


/* ======================================================
   BACKGROUND OTC REFRESH
====================================================== */

async function refreshOTCData() {
  if (!OTCHARTS_API_KEY) {
    return;
  }

  for (const pair of OTC_PAIRS) {
    try {
      await fetchOTCCandles(pair);

      console.log(
        `[OTCHARTS] Updated candles for ${pair}`
      );

    } catch (error) {

      otcCache[pair] = {
        ...(otcCache[pair] || {}),
        status: "error",
        error: error.message
      };

      console.error(
        `[OTCHARTS] ${pair}:`,
        error.message
      );
    }
  }
}


/* ======================================================
   INITIAL DATA LOAD
====================================================== */

setTimeout(() => {
  refreshLiveData();
  refreshOTCData();
}, 2000);


/* ======================================================
   PERIODIC DATA REFRESH
====================================================== */

setInterval(
  refreshLiveData,
  LIVE_DATA_INTERVAL
);

setInterval(
  refreshOTCData,
  OTC_DATA_INTERVAL
);
