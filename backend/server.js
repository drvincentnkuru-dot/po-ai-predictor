const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
=========================================================
PO AI PREDICTOR BACKEND V6.1
LIVE + OTC MARKET DATA
=========================================================

LIVE DATA:
  Twelve Data

OTC DATA:
  OTCharts

OTCharts official API:
  https://otcharts.com/v1/venues
  https://otcharts.com/v1/symbols
  https://otcharts.com/v1/candles
  https://otcharts.com/v1/usage

IMPORTANT:
  - OTCharts OTC venue = Pocket Option OTC book
  - OTC symbols are discovered from /v1/symbols
  - 1-minute candles use tf=60
  - Authorization = Bearer OTCHARTS_API_KEY
  - OTC candles are NOT polled every minute
=========================================================
*/


// =======================================================
// CONFIGURATION
// =======================================================

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const OTCHARTS_API_KEY = process.env.OTCHARTS_API_KEY || "";

const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com";
const OTCHARTS_BASE_URL = "https://otcharts.com";

const LIVE_INTERVAL = process.env.LIVE_INTERVAL || "1min";
const OTC_TIMEFRAME_SECONDS = Number(
  process.env.OTC_TIMEFRAME_SECONDS || 60
);

const MAX_CANDLES = Math.min(
  Number(process.env.MAX_CANDLES || 200),
  500
);

// Cache times
const LIVE_CACHE_MS = Number(
  process.env.LIVE_CACHE_MS || 30000
);

const OTC_CACHE_MS = Number(
  process.env.OTC_CACHE_MS || 30000
);

const SYMBOL_CACHE_MS = Number(
  process.env.OTC_SYMBOL_CACHE_MS || 300000
);


// =======================================================
// SUPPORTED LIVE PAIRS
// =======================================================

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


// =======================================================
// FRONTEND OTC PAIR NAMES
// =======================================================

const otcPairs = [
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


// =======================================================
// OTC NAME NORMALIZATION
// =======================================================

function normalizeOTCName(pair) {
  return String(pair || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}


function pairWithoutOTC(pair) {
  return normalizeOTCName(pair)
    .replace(/\s+OTC$/, "")
    .trim();
}


function compactPair(pair) {
  return pairWithoutOTC(pair)
    .replace("/", "")
    .replace(/\s/g, "");
}


// =======================================================
// STATE / CACHE
// =======================================================

const liveCache = new Map();
const otcCache = new Map();

let otcSymbolsCache = {
  timestamp: 0,
  symbols: []
};

let otcVenuesCache = {
  timestamp: 0,
  venues: []
};


// =======================================================
// FETCH HELPER
// =======================================================

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/json",
      "User-Agent": "PO-AI-Predictor/6.1",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const errorMessage =
      data?.error ||
      data?.message ||
      data?.raw ||
      `HTTP ${response.status}`;

    const error = new Error(errorMessage);
    error.status = response.status;
    error.body = data;

    throw error;
  }

  return data;
}


// =======================================================
// LIVE DATA - TWELVE DATA
// =======================================================

async function fetchLiveCandles(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is not configured");
  }

  const now = Date.now();

  const cached = liveCache.get(pair);

  if (
    cached &&
    cached.candles &&
    now - cached.timestamp < LIVE_CACHE_MS
  ) {
    return cached.candles;
  }

  const url =
    `${TWELVE_DATA_BASE_URL}/time_series` +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=${encodeURIComponent(LIVE_INTERVAL)}` +
    `&outputsize=${MAX_CANDLES}` +
    `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

  const data = await fetchJSON(url);

  if (data.status === "error") {
    throw new Error(
      data.message || "Twelve Data returned an error"
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "Twelve Data did not return candle data"
    );
  }

  const candles = data.values
    .map(item => ({
      time: item.datetime,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: Number(item.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();

  if (candles.length < 30) {
    throw new Error(
      `Not enough LIVE candles: ${candles.length}`
    );
  }

  liveCache.set(pair, {
    timestamp: now,
    candles
  });

  console.log(
    `[TWELVE DATA] Updated ${candles.length} candles for ${pair}`
  );

  return candles;
}


// =======================================================
// OTCHARTS - VENUES
// =======================================================

async function fetchOTCVenues() {
  if (!OTCHARTS_API_KEY) {
    throw new Error("OTCHARTS_API_KEY is not configured");
  }

  const now = Date.now();

  if (
    otcVenuesCache.venues.length > 0 &&
    now - otcVenuesCache.timestamp < SYMBOL_CACHE_MS
  ) {
    return otcVenuesCache.venues;
  }

  const url =
    `${OTCHARTS_BASE_URL}/v1/venues`;

  const data = await fetchJSON(url, {
    headers: {
      "Authorization": `Bearer ${OTCHARTS_API_KEY}`
    }
  });

  if (!Array.isArray(data.venues)) {
    throw new Error(
      "OTCharts /v1/venues did not return venues"
    );
  }

  otcVenuesCache = {
    timestamp: now,
    venues: data.venues
  };

  return data.venues;
}


// =======================================================
// OTCHARTS - SYMBOL CATALOGUE
// =======================================================

async function fetchOTCSymbols() {
  if (!OTCHARTS_API_KEY) {
    throw new Error("OTCHARTS_API_KEY is not configured");
  }

  const now = Date.now();

  if (
    otcSymbolsCache.symbols.length > 0 &&
    now - otcSymbolsCache.timestamp < SYMBOL_CACHE_MS
  ) {
    return otcSymbolsCache.symbols;
  }

  const url =
    `${OTCHARTS_BASE_URL}/v1/symbols` +
    `?venue=otc`;

  const data = await fetchJSON(url, {
    headers: {
      "Authorization": `Bearer ${OTCHARTS_API_KEY}`
    }
  });

  if (!Array.isArray(data.symbols)) {
    throw new Error(
      "OTCharts /v1/symbols did not return symbols"
    );
  }

  otcSymbolsCache = {
    timestamp: now,
    symbols: data.symbols
  };

  console.log(
    `[OTCHARTS] Loaded ${data.symbols.length} OTC symbols`
  );

  return data.symbols;
}


// =======================================================
// FIND OTC SYMBOL
// =======================================================

function findOTCSymbolFromCatalogue(pair, symbols) {
  const wanted = normalizeOTCName(pair);
  const base = compactPair(pair);

  // First: exact display name
  const exactName = symbols.find(item =>
    normalizeOTCName(item.name) === wanted
  );

  if (exactName) {
    return exactName.symbol;
  }

  // Second: compare compact pair
  const compactMatch = symbols.find(item => {
    const symbol = String(item.symbol || "")
      .toUpperCase()
      .replace("_OTC", "")
      .replace("-OTC", "")
      .replace("/", "");

    return symbol === base;
  });

  if (compactMatch) {
    return compactMatch.symbol;
  }

  return null;
}


// =======================================================
// OTCHARTS - CANDLES
// =======================================================

async function fetchOTCCandles(pair) {
  if (!OTCHARTS_API_KEY) {
    throw new Error("OTCHARTS_API_KEY is not configured");
  }

  const now = Date.now();

  const cached = otcCache.get(pair);

  if (
    cached &&
    cached.candles &&
    now - cached.timestamp < OTC_CACHE_MS
  ) {
    return cached.candles;
  }

  // -----------------------------------------------------
  // Confirm that OTC book is available
  // -----------------------------------------------------

  const venues = await fetchOTCVenues();

  const otcVenue = venues.find(
    venue => venue.id === "otc"
  );

  if (!otcVenue) {
    throw new Error(
      "OTCharts did not return the otc venue"
    );
  }

  if (otcVenue.open !== true) {
    throw new Error(
      "OTCharts OTC/Pocket Option book is not open for this API key"
    );
  }

  // -----------------------------------------------------
  // Discover exact OTC symbol
  // -----------------------------------------------------

  const symbols = await fetchOTCSymbols();

  const otcSymbol =
    findOTCSymbolFromCatalogue(pair, symbols);

  if (!otcSymbol) {
    throw new Error(
      `${pair} is not available in the OTCharts OTC catalogue for this API key`
    );
  }

  // -----------------------------------------------------
  // Request historical candles
  // -----------------------------------------------------

  const url =
    `${OTCHARTS_BASE_URL}/v1/candles` +
    `?venue=otc` +
    `&symbol=${encodeURIComponent(otcSymbol)}` +
    `&tf=${OTC_TIMEFRAME_SECONDS}` +
    `&limit=${MAX_CANDLES}`;

  const data = await fetchJSON(url, {
    headers: {
      "Authorization": `Bearer ${OTCHARTS_API_KEY}`
    }
  });

  if (!Array.isArray(data.candles)) {
    throw new Error(
      "OTCharts did not return candles"
    );
  }

  if (data.candles.length < 30) {
    throw new Error(
      `Not enough OTC candles for ${pair}: ${data.candles.length}`
    );
  }

  // -----------------------------------------------------
  // Convert OTCharts candles to our internal format
  // -----------------------------------------------------

  const candles = data.candles
    .map(item => ({
      time: item.time,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: Number(item.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a, b) => {
      return Number(a.time) - Number(b.time);
    });

  if (candles.length < 30) {
    throw new Error(
      `OTCharts returned insufficient valid candles for ${pair}`
    );
  }

  // -----------------------------------------------------
  // Cache
  // -----------------------------------------------------

  otcCache.set(pair, {
    timestamp: now,
    candles,
    otcSymbol,
    gaps: data.gaps || null
  });

  console.log(
    `[OTCHARTS] Updated ${candles.length} candles for ${pair} using ${otcSymbol}`
  );

  return candles;
}


// =======================================================
// EMA
// =======================================================

function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier +
      ema;
  }

  return ema;
}


// =======================================================
// RSI
// =======================================================

function calculateRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) {
    return null;
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

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

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

  const relativeStrength =
    averageGain / averageLoss;

  return 100 -
    (100 / (1 + relativeStrength));
}


// =======================================================
// MOMENTUM
// =======================================================

function calculateMomentum(values, lookback = 5) {
  if (!Array.isArray(values) || values.length <= lookback) {
    return null;
  }

  const current =
    values[values.length - 1];

  const previous =
    values[values.length - 1 - lookback];

  return current - previous;
}


// =======================================================
// MARKET ANALYSIS
// =======================================================

function analyzeCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 30) {
    return {
      signal: "NO TRADE",
      confidence: 0,
      reason: "Not enough market data",
      indicators: {}
    };
  }

  const closes = candles.map(
    candle => Number(candle.close)
  );

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

  if (
    ema9 === null ||
    ema21 === null ||
    rsi14 === null ||
    momentum === null
  ) {
    return {
      signal: "NO TRADE",
      confidence: 0,
      reason: "Indicators could not be calculated",
      indicators: {}
    };
  }

  const bullish = [];
  const bearish = [];

  // EMA direction
  if (ema9 > ema21) {
    bullish.push("EMA9_ABOVE_EMA21");
  }

  if (ema9 < ema21) {
    bearish.push("EMA9_BELOW_EMA21");
  }

  // RSI
  if (rsi14 >= 50 && rsi14 <= 70) {
    bullish.push("RSI_BULLISH");
  }

  if (rsi14 <= 50 && rsi14 >= 30) {
    bearish.push("RSI_BEARISH");
  }

  // Momentum
  if (momentum > 0) {
    bullish.push("MOMENTUM_UP");
  }

  if (momentum < 0) {
    bearish.push("MOMENTUM_DOWN");
  }

  let signal = "NO TRADE";
  let confidence = 0;
  let reason =
    "Market conditions are not sufficiently aligned.";

  // -----------------------------------------------------
  // CALL
  // -----------------------------------------------------

  if (
    ema9 > ema21 &&
    rsi14 > 50 &&
    rsi14 < 70 &&
    momentum > 0
  ) {
    signal = "CALL";

    confidence = Math.round(
      65 +
      Math.min(10, Math.abs(momentum) * 100000) +
      Math.min(10, Math.abs(ema9 - ema21) * 100000)
    );

    confidence = Math.min(
      90,
      Math.max(65, confidence)
    );

    reason =
      "EMA9 is above EMA21, RSI is bullish, and momentum is positive.";
  }

  // -----------------------------------------------------
  // PUT
  // -----------------------------------------------------

  else if (
    ema9 < ema21 &&
    rsi14 < 50 &&
    rsi14 > 30 &&
    momentum < 0
  ) {
    signal = "PUT";

    confidence = Math.round(
      65 +
      Math.min(10, Math.abs(momentum) * 100000) +
      Math.min(10, Math.abs(ema9 - ema21) * 100000)
    );

    confidence = Math.min(
      90,
      Math.max(65, confidence)
    );

    reason =
      "EMA9 is below EMA21, RSI is bearish, and momentum is negative.";
  }

  return {
    signal,
    confidence,
    reason,

    currentPrice,

    indicators: {
      ema9,
      ema21,
      rsi14,
      momentum,

      bullishSignals: bullish.length,
      bearishSignals: bearish.length,

      bullishFactors: bullish,
      bearishFactors: bearish
    }
  };
}


// =======================================================
// HEALTH
// =======================================================

app.get("/api/health", async (req, res) => {
  const liveConfigured =
    Boolean(TWELVE_DATA_API_KEY);

  const otcConfigured =
    Boolean(OTCHARTS_API_KEY);

  let otcStatus = {
    configured: otcConfigured,
    venueOpen: null,
    symbolsAvailable: null,
    error: null
  };

  if (otcConfigured) {
    try {
      const venues =
        await fetchOTCVenues();

      const otcVenue =
        venues.find(
          venue => venue.id === "otc"
        );

      otcStatus.venueOpen =
        otcVenue?.open === true;

      if (otcStatus.venueOpen) {
        const symbols =
          await fetchOTCSymbols();

        otcStatus.symbolsAvailable =
          symbols.length;
      }
    } catch (error) {
      otcStatus.error =
        error.message;
    }
  }

  res.json({
    status: "ok",
    service: "PO AI Predictor Backend",
    version: "6.1.0",

    liveDataConfigured:
      liveConfigured,

    otcDataConfigured:
      otcConfigured,

    liveSource:
      "Twelve Data",

    otcSource:
      "OTCharts",

    liveInterval:
      LIVE_INTERVAL,

    otcTimeframeSeconds:
      OTC_TIMEFRAME_SECONDS,

    livePairs,
    otcPairs,

    otcStatus,

    timestamp:
      new Date().toISOString()
  });
});


// =======================================================
// OTC VENUES
// =======================================================

app.get("/api/otc-venues", async (req, res) => {
  try {
    const venues =
      await fetchOTCVenues();

    res.json({
      status: "ok",
      source: "OTCharts",
      venues
    });

  } catch (error) {

    res.status(error.status || 500).json({
      status: "error",
      source: "OTCharts",
      error: error.message
    });
  }
});


// =======================================================
// OTC SYMBOLS
// =======================================================

app.get("/api/otc-symbols", async (req, res) => {
  try {
    const symbols =
      await fetchOTCSymbols();

    res.json({
      status: "ok",
      source: "OTCharts",
      venue: "otc",
      count: symbols.length,
      symbols
    });

  } catch (error) {

    res.status(error.status || 500).json({
      status: "error",
      source: "OTCharts",
      error: error.message
    });
  }
});


// =======================================================
// OTC USAGE
// =======================================================

app.get("/api/otc-usage", async (req, res) => {
  try {

    const data =
      await fetchJSON(
        `${OTCHARTS_BASE_URL}/v1/usage`,
        {
          headers: {
            "Authorization":
              `Bearer ${OTCHARTS_API_KEY}`
          }
        }
      );

    res.json({
      status: "ok",
      source: "OTCharts",
      usage: data
    });

  } catch (error) {

    res.status(error.status || 500).json({
      status: "error",
      source: "OTCharts",
      error: error.message
    });
  }
});


// =======================================================
// CANDLES
// =======================================================

app.get("/api/candles", async (req, res) => {
  try {

    const pair =
      String(
        req.query.pair || "EUR/USD"
      ).trim();

    const isOTC =
      /OTC$/i.test(pair);

    let candles;

    if (isOTC) {

      candles =
        await fetchOTCCandles(pair);

      res.json({
        status: "ok",
        market: "OTC MARKET",
        pair,
        source: "OTCharts",
        dataStatus: "OTC DATA CONNECTED",
        count: candles.length,
        candles
      });

      return;
    }

    if (!livePairs.includes(pair)) {
      return res.status(400).json({
        status: "error",
        message:
          `Unsupported LIVE pair: ${pair}`
      });
    }

    candles =
      await fetchLiveCandles(pair);

    res.json({
      status: "ok",
      market: "LIVE MARKET",
      pair,
      source: "Twelve Data",
      dataStatus: "LIVE DATA CONNECTED",
      count: candles.length,
      candles
    });

  } catch (error) {

    res.status(error.status || 500).json({
      status: "error",
      message: error.message
    });
  }
});


// =======================================================
// MARKET ANALYSIS
// =======================================================

app.get(
  "/api/market-analysis",
  async (req, res) => {

    try {

      const pair =
        String(
          req.query.pair || "EUR/USD"
        ).trim();

      const isOTC =
        /OTC$/i.test(pair);

      let candles;
      let source;
      let market;
      let dataStatus;
      let otcSymbol = null;

      if (isOTC) {

        candles =
          await fetchOTCCandles(pair);

        source =
          "OTCharts";

        market =
          "OTC MARKET";

        dataStatus =
          "OTC DATA CONNECTED";

        const cached =
          otcCache.get(pair);

        otcSymbol =
          cached?.otcSymbol || null;

      } else {

        if (!livePairs.includes(pair)) {
          return res.status(400).json({
            status: "error",
            message:
              `Unsupported LIVE pair: ${pair}`
          });
        }

        candles =
          await fetchLiveCandles(pair);

        source =
          "Twelve Data";

        market =
          "LIVE MARKET";

        dataStatus =
          "LIVE DATA CONNECTED";
      }

      const analysis =
        analyzeCandles(candles);

      res.json({
        status: "ready",

        market,
        pair,

        source,
        dataStatus,

        otcSymbol,

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
          new Date().toISOString()
      });

    } catch (error) {

      const isOTC =
        /OTC$/i.test(
          String(req.query.pair || "")
        );

      res.status(error.status || 500).json({

        status: "error",

        market:
          isOTC
            ? "OTC MARKET"
            : "LIVE MARKET",

        pair:
          req.query.pair || null,

        source:
          isOTC
            ? "OTCharts"
            : "Twelve Data",

        dataStatus:
          isOTC
            ? "OTC DATA NOT AVAILABLE"
            : "LIVE DATA NOT AVAILABLE",

        signal:
          "NO TRADE",

        confidence:
          0,

        error:
          error.message
      });
    }
  }
);


// =======================================================
// SIGNAL ENDPOINT
// =======================================================

app.get("/api/signal", async (req, res) => {

  try {

    const pair =
      String(
        req.query.pair || "EUR/USD"
      ).trim();

    const isOTC =
      /OTC$/i.test(pair);

    let candles;
    let source;
    let market;
    let dataStatus;
    let otcSymbol = null;

    if (isOTC) {

      candles =
        await fetchOTCCandles(pair);

      source =
        "OTCharts";

      market =
        "OTC MARKET";

      dataStatus =
        "OTC DATA CONNECTED";

      const cached =
        otcCache.get(pair);

      otcSymbol =
        cached?.otcSymbol || null;

    } else {

      if (!livePairs.includes(pair)) {
        return res.status(400).json({
          status: "error",
          message:
            `Unsupported LIVE pair: ${pair}`
        });
      }

      candles =
        await fetchLiveCandles(pair);

      source =
        "Twelve Data";

      market =
        "LIVE MARKET";

      dataStatus =
        "LIVE DATA CONNECTED";
    }

    const analysis =
      analyzeCandles(candles);

    res.json({

      status: "ready",

      market,
      pair,

      source,
      dataStatus,

      otcSymbol,

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
        new Date().toISOString()
    });

  } catch (error) {

    const isOTC =
      /OTC$/i.test(
        String(req.query.pair || "")
      );

    res.status(error.status || 500).json({

      status: "error",

      market:
        isOTC
          ? "OTC MARKET"
          : "LIVE MARKET",

      pair:
        req.query.pair || null,

      source:
        isOTC
          ? "OTCharts"
          : "Twelve Data",

      dataStatus:
        isOTC
          ? "OTC DATA NOT AVAILABLE"
          : "LIVE DATA NOT AVAILABLE",

      signal:
        "NO TRADE",

      confidence:
        0,

      error:
        error.message
    });
  }
});


// =======================================================
// ROOT
// =======================================================

app.get("/", (req, res) => {

  res.json({

    service:
      "PO AI Predictor Backend",

    version:
      "6.1.0",

    status:
      "online",

    live:
      "Twelve Data",

    otc:
      "OTCharts",

    endpoints: [

      "/api/health",

      "/api/otc-venues",

      "/api/otc-symbols",

      "/api/otc-usage",

      "/api/candles?pair=EUR/USD",

      "/api/candles?pair=EUR/USD%20OTC",

      "/api/market-analysis?pair=EUR/USD",

      "/api/market-analysis?pair=EUR/USD%20OTC",

      "/api/signal?pair=EUR/USD",

      "/api/signal?pair=EUR/USD%20OTC"
    ]

  });

});


// =======================================================
// ERROR HANDLER
// =======================================================

app.use((err, req, res, next) => {

  console.error(
    "[SERVER ERROR]",
    err
  );

  res.status(500).json({

    status:
      "error",

    message:
      err.message ||
      "Internal server error"

  });

});


// =======================================================
// START SERVER
// =======================================================

app.listen(PORT, () => {

  console.log(
    "================================================="
  );

  console.log(
    "PO AI PREDICTOR BACKEND V6.1"
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
    "OTC METHOD: /v1/candles + /v1/symbols"
  );

  console.log(
    "================================================="
  );

});
