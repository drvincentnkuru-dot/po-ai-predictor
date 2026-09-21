const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
  ============================================================
  PO AI PREDICTOR BACKEND V4
  ============================================================

  READ-ONLY MARKET ANALYSIS ARCHITECTURE

  This backend:
  - Does NOT log in to Pocket Option
  - Does NOT place trades
  - Does NOT store trading passwords
  - Does NOT claim guaranteed predictions
  - Uses verified market candle data when available
  - Returns NO TRADE when data is missing or insufficient

  Required environment variable for live data:

      LIVE_DATA_URL=https://your-live-data-source.example/api/candles

  Optional:

      LIVE_DATA_INTERVAL=5000

  Expected live-data response can be either:

  1. Array:
     [
       {
         "time": 1234567890,
         "open": 1.1000,
         "high": 1.1010,
         "low": 1.0990,
         "close": 1.1005
       }
     ]

  2. Object:
     {
       "candles": [
         {
           "time": 1234567890,
           "open": 1.1000,
           "high": 1.1010,
           "low": 1.0990,
           "close": 1.1005
         }
       ]
     }

  ============================================================
*/
const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const TWELVE_DATA_SYMBOL =
  process.env.TWELVE_DATA_SYMBOL || "EUR/USD";

const TWELVE_DATA_INTERVAL =
  process.env.TWELVE_DATA_INTERVAL || "1min";

const LIVE_DATA_INTERVAL =
  Number(process.env.LIVE_DATA_INTERVAL) || 60000;


// Maximum number of candles stored in memory
const MAX_CANDLES = 200;

// In-memory market data
let marketData = {
  candles: [],
  status: "data_updater_required",
  lastUpdate: null,
  source: null,
  error: null
};


/* ============================================================
   BASIC HELPERS
   ============================================================ */

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}


function normalizeCandle(candle) {
  if (!candle || typeof candle !== "object") {
    return null;
  }

  const open = number(
    candle.open ??
    candle.o
  );

  const high = number(
    candle.high ??
    candle.h
  );

  const low = number(
    candle.low ??
    candle.l
  );

  const close = number(
    candle.close ??
    candle.c
  );

  const time =
    candle.time ??
    candle.timestamp ??
    candle.t ??
    Date.now();

  if (
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
    close
  };
}


/* ============================================================
   LIVE DATA FETCHER
   ============================================================ */

async function fetchLiveCandles() {
  if (!TWELVE_DATA_API_KEY) {
    marketData.status = "data_updater_required";
    marketData.error =
      "TWELVE_DATA_API_KEY is not configured.";
    return;
  }

  try {
    const url =
      "https://api.twelvedata.com/time_series" +
      `?symbol=${encodeURIComponent(TWELVE_DATA_SYMBOL)}` +
      `&interval=${encodeURIComponent(TWELVE_DATA_INTERVAL)}` +
      "&outputsize=100" +
      "&timezone=UTC" +
      `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Twelve Data returned HTTP ${response.status}`
      );
    }

    const payload = await response.json();

    if (payload.status === "error") {
      throw new Error(
        payload.message || "Twelve Data API error."
      );
    }

    if (!Array.isArray(payload.values)) {
      throw new Error(
        "Twelve Data response does not contain values."
      );
    }

    const normalized = payload.values
      .map(candle =>
        normalizeCandle({
          time: candle.datetime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close
        })
      )
      .filter(Boolean)
      .reverse()
      .slice(-MAX_CANDLES);

    if (normalized.length === 0) {
      throw new Error(
        "Twelve Data returned no valid candles."
      );
    }

    marketData = {
      candles: normalized,
      status: "live",
      lastUpdate: new Date().toISOString(),
      source: "Twelve Data",
      error: null
    };

    console.log(
      `[TWELVE DATA] Updated ${normalized.length} candles for ${TWELVE_DATA_SYMBOL}`
    );

  } catch (error) {
    marketData.status = "data_error";
    marketData.error = error.message;

    console.error(
      "[TWELVE DATA ERROR]",
      error.message
    );
  }
}


/* ============================================================
   TECHNICAL INDICATORS
   ============================================================ */

function calculateEMA(values, period) {
  if (values.length < period) {
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
      (values[i] - ema) * multiplier + ema;
  }

  return ema;
}


function calculateRSI(values, period = 14) {
  if (values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const difference =
      values[i] - values[i - 1];

    if (difference > 0) {
      gains += difference;
    } else {
      losses += Math.abs(difference);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const difference =
      values[i] - values[i - 1];

    const gain =
      difference > 0 ? difference : 0;

    const loss =
      difference < 0 ? Math.abs(difference) : 0;

    averageGain =
      (averageGain * (period - 1) + gain) /
      period;

    averageLoss =
      (averageLoss * (period - 1) + loss) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const relativeStrength =
    averageGain / averageLoss;

  return (
    100 -
    100 / (1 + relativeStrength)
  );
}


function calculateMomentum(values, period = 5) {
  if (values.length <= period) {
    return null;
  }

  return (
    values[values.length - 1] -
    values[values.length - 1 - period]
  );
}


/* ============================================================
   MARKET ANALYSIS
   ============================================================ */

function analyzeMarket() {
  const candles = marketData.candles;

  /*
    We require enough candles before producing
    an analysis.
  */

  if (marketData.status !== "live") {
    return {
      status: marketData.status,
      signal: "NO TRADE",
      reason:
        "Verified live market data is not available.",
      dataRequired: true
    };
  }

  if (candles.length < 30) {
    return {
      status: "insufficient_data",
      signal: "NO TRADE",
      reason:
        "At least 30 valid candles are required for analysis.",
      candlesAvailable: candles.length
    };
  }

  const closes = candles.map(
    candle => candle.close
  );

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi14 = calculateRSI(closes, 14);
  const momentum = calculateMomentum(closes, 5);

  const currentPrice =
    closes[closes.length - 1];

  if (
    ema9 === null ||
    ema21 === null ||
    rsi14 === null ||
    momentum === null
  ) {
    return {
      status: "insufficient_data",
      signal: "NO TRADE",
      reason:
        "Technical indicators could not be calculated."
    };
  }

  /*
    Conservative rule-based analysis.

    This is NOT a guaranteed prediction model.
    It only interprets the available market data.
  */

  let bullishScore = 0;
  let bearishScore = 0;

  // EMA trend
  if (ema9 > ema21) {
    bullishScore++;
  }

  if (ema9 < ema21) {
    bearishScore++;
  }

  // RSI
  if (rsi14 > 50 && rsi14 < 70) {
    bullishScore++;
  }

  if (rsi14 < 50 && rsi14 > 30) {
    bearishScore++;
  }

  // Momentum
  if (momentum > 0) {
    bullishScore++;
  }

  if (momentum < 0) {
    bearishScore++;
  }

  let signal = "NO TRADE";

  /*
    Require a clear majority before producing
    CALL or PUT.
  */

  if (
    bullishScore >= 3 &&
    bearishScore === 0
  ) {
    signal = "CALL";
  }

  if (
    bearishScore >= 3 &&
    bullishScore === 0
  ) {
    signal = "PUT";
  }

  const confidence =
    signal === "NO TRADE"
      ? 0
      : Math.round(
          (Math.max(
            bullishScore,
            bearishScore
          ) /
            3) *
            100
        );

  return {
    status: "analyzed",

    signal,

    confidence,

    market: {
      currentPrice,
      candles: candles.length,
      lastUpdate: marketData.lastUpdate
    },

    indicators: {
      ema9: Number(ema9.toFixed(8)),
      ema21: Number(ema21.toFixed(8)),
      rsi14: Number(rsi14.toFixed(2)),
      momentum: Number(momentum.toFixed(8))
    },

    scores: {
      bullish: bullishScore,
      bearish: bearishScore
    },

    reason:
      signal === "CALL"
        ? "Bullish conditions aligned."
        : signal === "PUT"
        ? "Bearish conditions aligned."
        : "Market conditions are not sufficiently aligned."
  };
}


/* ============================================================
   API: HEALTH
   ============================================================ */

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PO AI Predictor Backend",
    version: "4.0.0",
    liveDataConfigured: Boolean(LIVE_DATA_URL),
    marketDataStatus: marketData.status,
    timestamp: new Date().toISOString()
  });
});


/* ============================================================
   API: CANDLES
   ============================================================ */

app.get("/api/candles", (req, res) => {
  if (marketData.status !== "live") {
    return res.status(503).json({
      status: marketData.status,
      candles: [],
      message:
        marketData.error ||
        "Verified live candle data is not available."
    });
  }

  res.json({
    status: "live",
    count: marketData.candles.length,
    lastUpdate: marketData.lastUpdate,
    candles: marketData.candles
  });
});


/* ============================================================
   API: MARKET ANALYSIS
   ============================================================ */

app.get("/api/market-analysis", (req, res) => {
  const analysis = analyzeMarket();

  if (
    analysis.signal === "NO TRADE" &&
    analysis.dataRequired
  ) {
    return res.status(503).json(analysis);
  }

  res.json(analysis);
});


/* ============================================================
   API: SIGNAL
   ============================================================ */

app.get("/api/signal", (req, res) => {
  const analysis = analyzeMarket();

  /*
    Never expose CALL/PUT when live data is missing.
  */

  if (
    analysis.status !== "analyzed"
  ) {
    return res.status(503).json({
      status: analysis.status,
      signal: "NO TRADE",
      message:
        analysis.reason ||
        "Signal disabled until valid market data is available."
    });
  }

  res.json({
    status: "ready",
    signal: analysis.signal,
    confidence: analysis.confidence,
    timestamp: new Date().toISOString(),
    analysis
  });
});


/* ============================================================
   API: RESULT
   ============================================================ */

app.post("/api/result", (req, res) => {
  const {
    signal,
    result,
    timestamp
  } = req.body || {};

  res.json({
    status: "received",
    signal: signal || null,
    result: result || null,
    timestamp:
      timestamp ||
      new Date().toISOString(),

    message:
      "Result received. Persistent performance storage is not enabled."
  });
});


/* ============================================================
   API: STATISTICS
   ============================================================ */

app.get("/api/statistics", (req, res) => {
  res.json({
    total: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    status:
      "Statistics storage is not enabled."
  });
});


/* ============================================================
   ROOT
   ============================================================ */

app.get("/", (req, res) => {
  res.json({
    service: "PO AI Predictor Backend",
    version: "4.0.0",
    status: "online",

    endpoints: {
      health: "/api/health",
      candles: "/api/candles",
      marketAnalysis: "/api/market-analysis",
      signal: "/api/signal",
      statistics: "/api/statistics"
    },

    marketDataStatus:
      marketData.status
  });
});


/* ============================================================
   START SERVER
   ============================================================ */

app.listen(PORT, () => {
  console.log(
    `PO AI Predictor backend running on port ${PORT}`
  );

  if (TWELVE_DATA_API_KEY) {
    console.log(
      "Twelve Data live data updater configured."
    );

    // First update immediately
    fetchLiveCandles();

    // Continue updating
    setInterval(
      fetchLiveCandles,
      LIVE_DATA_INTERVAL
    );
  } else {
    console.log(
      "WARNING: TWELVE_DATA_API_KEY is not configured."
    );

    console.log(
      "Market analysis will remain NO TRADE until Twelve Data is connected."
    );
  }
});
