const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
  =========================================================
  PO AI PREDICTOR BACKEND V5.2
  LIVE + OTC MARKET DATA ARCHITECTURE

  LIVE DATA:
  Twelve Data

  OTC DATA:
  Configurable external OTC data source

  IMPORTANT:
  No demo/random OTC candles are generated.
  OTC requires a real configured data source.
  =========================================================
*/


/* =========================================================
   CONFIGURATION
========================================================= */

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const DEFAULT_SYMBOL =
  process.env.TWELVE_DATA_SYMBOL || "EUR/USD";

const TWELVE_DATA_INTERVAL =
  process.env.TWELVE_DATA_INTERVAL || "1min";

const LIVE_DATA_INTERVAL =
  Number(process.env.LIVE_DATA_INTERVAL) || 60000;


/*
  OTC DATA SOURCE

  Example:

  OTC_DATA_URL=https://your-otc-provider.com/api/candles

  OTC_DATA_API_KEY=your_key

  The OTC provider should return candles in one of
  these forms:

  {
    "values": [
      {
        "datetime": "...",
        "open": "...",
        "high": "...",
        "low": "...",
        "close": "..."
      }
    ]
  }

  OR:

  {
    "candles": [
      {
        "time": "...",
        "open": "...",
        "high": "...",
        "low": "...",
        "close": "..."
      }
    ]
  }
*/

const OTC_DATA_URL =
  process.env.OTC_DATA_URL || "";

const OTC_DATA_API_KEY =
  process.env.OTC_DATA_API_KEY || "";

const OTC_DATA_INTERVAL =
  process.env.OTC_DATA_INTERVAL || "1min";


const MAX_CANDLES = 200;

const CACHE_MAX_AGE =
  LIVE_DATA_INTERVAL;


/* =========================================================
   SUPPORTED PAIRS
========================================================= */

const SUPPORTED_LIVE_PAIRS = new Set([
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
]);


/*
  OTC frontend pairs.

  These are the same currency pairs but with OTC suffix.
*/

const SUPPORTED_OTC_PAIRS = new Set([
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
]);


/*
  Separate storage for LIVE and OTC.

  Example:

  LIVE:EUR/USD
  OTC:EUR/USD
*/

const marketData = new Map();


/* =========================================================
   BASIC HELPERS
========================================================= */

function number(value) {

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


/*
  IMPORTANT:

  We preserve the space before OTC.

  EUR/USD OTC
  EUR/USD

  are handled correctly.
*/

function normalizeSymbol(value) {

  if (!value) {
    return DEFAULT_SYMBOL;
  }

  return String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}


/*
  Detect OTC.

  Supports:

  EUR/USD OTC
  EUR/USDOTC
  eur/usd otc
*/

function isOTCPair(symbol) {

  return /OTC$/i.test(
    String(symbol || "").trim()
  );
}


/*
  Remove OTC suffix safely.
*/

function cleanPair(symbol) {

  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/\s*OTC$/i, "")
    .trim();
}


/*
  Convert:

  EUR/USD OTC -> EUR/USD
*/

function getMarketType(symbol) {

  return isOTCPair(symbol)
    ? "OTC"
    : "LIVE";
}


/*
  Unique storage key.

  This prevents:

  LIVE EUR/USD

  from sharing candles with:

  OTC EUR/USD
*/

function getStorageKey(symbol) {

  const cleanSymbol =
    cleanPair(symbol);

  const type =
    getMarketType(symbol);

  return `${type}:${cleanSymbol}`;
}


/* =========================================================
   SUPPORTED PAIR CHECKS
========================================================= */

function isSupportedLivePair(symbol) {

  return SUPPORTED_LIVE_PAIRS.has(
    cleanPair(symbol)
  );
}


function isSupportedOTCPair(symbol) {

  return SUPPORTED_OTC_PAIRS.has(
    cleanPair(symbol)
  );
}


/* =========================================================
   MARKET DATA STORAGE
========================================================= */

function createEmptyMarketData() {

  return {

    candles: [],

    status:
      "data_updater_required",

    lastUpdate:
      null,

    source:
      null,

    error:
      null,

    type:
      null,

    pair:
      null
  };
}


function getMarketData(symbol) {

  const cleanSymbol =
    cleanPair(symbol);

  const storageKey =
    getStorageKey(symbol);

  if (!marketData.has(storageKey)) {

    const data =
      createEmptyMarketData();

    data.type =
      getMarketType(symbol);

    data.pair =
      cleanSymbol;

    marketData.set(
      storageKey,
      data
    );
  }

  return marketData.get(
    storageKey
  );
}


/* =========================================================
   CANDLE NORMALIZATION
========================================================= */

function normalizeCandle(candle) {

  if (
    !candle ||
    typeof candle !== "object"
  ) {

    return null;
  }


  const open =
    number(
      candle.open ??
      candle.o
    );


  const high =
    number(
      candle.high ??
      candle.h
    );


  const low =
    number(
      candle.low ??
      candle.l
    );


  const close =
    number(
      candle.close ??
      candle.c
    );


  const time =
    candle.time ??
    candle.datetime ??
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


/* =========================================================
   NORMALIZE API RESPONSE
========================================================= */

function normalizeProviderCandles(payload) {

  if (
    !payload ||
    typeof payload !== "object"
  ) {

    return [];
  }


  /*
    Provider format #1

    {
      values: [...]
    }
  */

  let rawCandles =
    Array.isArray(payload.values)
      ? payload.values
      : null;


  /*
    Provider format #2

    {
      candles: [...]
    }
  */

  if (!rawCandles) {

    rawCandles =
      Array.isArray(payload.candles)
        ? payload.candles
        : null;
  }


  /*
    Provider format #3

    {
      data: [...]
    }
  */

  if (!rawCandles) {

    rawCandles =
      Array.isArray(payload.data)
        ? payload.data
        : null;
  }


  if (!rawCandles) {

    return [];
  }


  return rawCandles
    .map(
      candle =>
        normalizeCandle(candle)
    )
    .filter(Boolean)
    .reverse()
    .slice(-MAX_CANDLES);
}


/* =========================================================
   LIVE DATA - TWELVE DATA
========================================================= */

async function fetchLiveCandles(symbol) {

  const cleanSymbol =
    cleanPair(symbol);

  const data =
    getMarketData(symbol);


  if (!TWELVE_DATA_API_KEY) {

    data.status =
      "data_updater_required";

    data.error =
      "TWELVE_DATA_API_KEY is not configured.";

    return data;
  }


  if (
    !isSupportedLivePair(
      cleanSymbol
    )
  ) {

    data.status =
      "unsupported_pair";

    data.error =
      `Unsupported live pair: ${cleanSymbol}`;

    return data;
  }


  try {

    const url =
      "https://api.twelvedata.com/time_series" +
      `?symbol=${encodeURIComponent(cleanSymbol)}` +
      `&interval=${encodeURIComponent(TWELVE_DATA_INTERVAL)}` +
      "&outputsize=100" +
      "&timezone=UTC" +
      `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;


    const response =
      await fetch(
        url,
        {
          method: "GET",

          headers: {
            Accept:
              "application/json"
          }
        }
      );


    if (!response.ok) {

      throw new Error(
        `Twelve Data returned HTTP ${response.status}`
      );
    }


    const payload =
      await response.json();


    if (
      payload.status === "error"
    ) {

      throw new Error(
        payload.message ||
        "Twelve Data API error."
      );
    }


    const normalized =
      normalizeProviderCandles(
        payload
      );


    if (
      normalized.length === 0
    ) {

      throw new Error(
        "Twelve Data returned no valid candles."
      );
    }


    data.candles =
      normalized;

    data.status =
      "live";

    data.lastUpdate =
      new Date().toISOString();

    data.source =
      "Twelve Data";

    data.type =
      "LIVE";

    data.pair =
      cleanSymbol;

    data.error =
      null;


    console.log(
      `[TWELVE DATA] ${cleanSymbol} updated: ${normalized.length} candles`
    );


    return data;

  } catch (error) {

    data.status =
      "data_error";

    data.error =
      error.message;


    console.error(
      `[TWELVE DATA ERROR] ${cleanSymbol}:`,
      error.message
    );


    return data;
  }
}


/* =========================================================
   OTC DATA
========================================================= */

async function fetchOTCCandles(symbol) {

  const cleanSymbol =
    cleanPair(symbol);

  const data =
    getMarketData(symbol);


  /*
    Check supported OTC pair.
  */

  if (
    !isSupportedOTCPair(
      cleanSymbol
    )
  ) {

    data.status =
      "unsupported_pair";

    data.error =
      `Unsupported OTC pair: ${cleanSymbol}`;

    return data;
  }


  /*
    OTC source must be configured.

    We do NOT generate demo/random candles.
  */

  if (!OTC_DATA_URL) {

    data.status =
      "data_updater_required";

    data.error =
      "OTC_DATA_URL is not configured.";

    data.source =
      null;

    return data;
  }


  try {

    /*
      Allow the provider URL to contain:

      {symbol}
      {interval}

      Example:

      https://provider.com/candles/{symbol}?interval={interval}
    */

    let url =
      OTC_DATA_URL
        .replace(
          "{symbol}",
          encodeURIComponent(
            cleanSymbol
          )
        )
        .replace(
          "{interval}",
          encodeURIComponent(
            OTC_DATA_INTERVAL
          )
        );


    /*
      If placeholders were not used,
      append normal query parameters.
    */

    if (
      !OTC_DATA_URL.includes(
        "{symbol}"
      )
    ) {

      const separator =
        url.includes("?")
          ? "&"
          : "?";

      url +=
        `${separator}symbol=${encodeURIComponent(cleanSymbol)}`;
    }


    if (
      !OTC_DATA_URL.includes(
        "{interval}"
      )
    ) {

      const separator =
        url.includes("?")
          ? "&"
          : "?";

      url +=
        `${separator}interval=${encodeURIComponent(OTC_DATA_INTERVAL)}`;
    }


    /*
      API key is optional.

      If configured, send it as:

      x-api-key
      and Authorization Bearer

      This supports common provider formats.
    */

    const headers = {

      Accept:
        "application/json"
    };


    if (OTC_DATA_API_KEY) {

      headers["x-api-key"] =
        OTC_DATA_API_KEY;

      headers["Authorization"] =
        `Bearer ${OTC_DATA_API_KEY}`;
    }


    const response =
      await fetch(
        url,
        {
          method: "GET",
          headers
        }
      );


    if (!response.ok) {

      throw new Error(
        `OTC data source returned HTTP ${response.status}`
      );
    }


    const payload =
      await response.json();


    /*
      Check common provider errors.
    */

    if (
      payload.status === "error"
    ) {

      throw new Error(
        payload.message ||
        "OTC provider returned an error."
      );
    }


    const normalized =
      normalizeProviderCandles(
        payload
      );


    if (
      normalized.length === 0
    ) {

      throw new Error(
        "OTC provider returned no valid candles."
      );
    }


    data.candles =
      normalized;

    data.status =
      "live";

    data.lastUpdate =
      new Date().toISOString();

    data.source =
      "Configured OTC Data Source";

    data.type =
      "OTC";

    data.pair =
      cleanSymbol;

    data.error =
      null;


    console.log(
      `[OTC DATA] ${cleanSymbol} updated: ${normalized.length} candles`
    );


    return data;

  } catch (error) {

    data.status =
      "data_error";

    data.error =
      error.message;


    console.error(
      `[OTC DATA ERROR] ${cleanSymbol}:`,
      error.message
    );


    return data;
  }
}


/* =========================================================
   FRESH MARKET DATA
========================================================= */

async function getFreshMarketData(symbol) {

  const cleanSymbol =
    cleanPair(symbol);

  const data =
    getMarketData(symbol);


  /*
    Use cache if still fresh.
  */

  if (
    data.status === "live" &&
    data.lastUpdate
  ) {

    const age =
      Date.now() -
      new Date(
        data.lastUpdate
      ).getTime();


    if (
      age < CACHE_MAX_AGE
    ) {

      return data;
    }
  }


  /*
    OTC
  */

  if (
    isOTCPair(symbol)
  ) {

    return await fetchOTCCandles(
      symbol
    );
  }


  /*
    LIVE
  */

  return await fetchLiveCandles(
    symbol
  );
}


/* =========================================================
   EMA
========================================================= */

function calculateEMA(
  values,
  period
) {

  if (
    values.length < period
  ) {

    return null;
  }


  const multiplier =
    2 /
    (period + 1);


  let ema =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
    period;


  for (
    let i = period;
    i < values.length;
    i++
  ) {

    ema =
      (
        values[i] -
        ema
      ) *
      multiplier +
      ema;
  }


  return ema;
}


/* =========================================================
   RSI
========================================================= */

function calculateRSI(
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

    const difference =
      values[i] -
      values[i - 1];


    if (
      difference > 0
    ) {

      gains += difference;

    } else {

      losses +=
        Math.abs(
          difference
        );
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

    const difference =
      values[i] -
      values[i - 1];


    const gain =
      difference > 0
        ? difference
        : 0;


    const loss =
      difference < 0
        ? Math.abs(
            difference
          )
        : 0;


    averageGain =
      (
        averageGain *
          (period - 1) +
        gain
      ) /
      period;


    averageLoss =
      (
        averageLoss *
          (period - 1) +
        loss
      ) /
      period;
  }


  if (
    averageLoss === 0
  ) {

    return 100;
  }


  const relativeStrength =
    averageGain /
    averageLoss;


  return (
    100 -
    100 /
      (1 + relativeStrength)
  );
}


/* =========================================================
   MOMENTUM
========================================================= */

function calculateMomentum(
  values,
  period = 5
) {

  if (
    values.length <= period
  ) {

    return null;
  }


  return (
    values[
      values.length - 1
    ] -
    values[
      values.length - 1 - period
    ]
  );
}


/* =========================================================
   MOMENTUM PERCENTAGE
========================================================= */

function calculateMomentumPercent(
  currentPrice,
  previousPrice
) {

  if (
    !Number.isFinite(
      currentPrice
    ) ||
    !Number.isFinite(
      previousPrice
    ) ||
    previousPrice === 0
  ) {

    return null;
  }


  return (
    (
      currentPrice -
      previousPrice
    ) /
    previousPrice
  ) *
  100;
}


/* =========================================================
   MARKET ANALYSIS
========================================================= */

function analyzeMarket(symbol) {

  const cleanSymbol =
    cleanPair(symbol);

  const marketType =
    getMarketType(symbol);

  const data =
    getMarketData(symbol);


  /*
    Pair validation
  */

  if (
    marketType === "LIVE" &&
    !isSupportedLivePair(
      cleanSymbol
    )
  ) {

    return {

      status:
        "unsupported_pair",

      signal:
        "NO TRADE",

      confidence:
        0,

      reason:
        `Pair ${cleanSymbol} is not supported.`,

      dataRequired:
        true
    };
  }


  if (
    marketType === "OTC" &&
    !isSupportedOTCPair(
      cleanSymbol
    )
  ) {

    return {

      status:
        "unsupported_pair",

      signal:
        "NO TRADE",

      confidence:
        0,

      reason:
        `OTC pair ${cleanSymbol} is not supported.`,

      dataRequired:
        true
    };
  }


  /*
    Live / OTC data validation
  */

  if (
    data.status !== "live"
  ) {

    return {

      status:
        data.status,

      signal:
        "NO TRADE",

      confidence:
        0,

      reason:
        data.error ||
        "Verified market data is not available.",

      dataRequired:
        true,

      market: {

        type:
          marketType,

        pair:
          cleanSymbol,

        source:
          data.source
      }
    };
  }


  const candles =
    data.candles;


  /*
    Minimum candles
  */

  if (
    candles.length < 30
  ) {

    return {

      status:
        "insufficient_data",

      signal:
        "NO TRADE",

      confidence:
        0,

      reason:
        "At least 30 valid candles are required.",

      candlesAvailable:
        candles.length,

      market: {

        type:
          marketType,

        pair:
          cleanSymbol
      }
    };
  }


  const closes =
    candles.map(
      candle =>
        candle.close
    );


  /*
    Indicators
  */

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


  const currentPrice =
    closes[
      closes.length - 1
    ];


  const previousPrice =
    closes[
      closes.length - 6
    ];


  const momentumPercent =
    calculateMomentumPercent(
      currentPrice,
      previousPrice
    );


  /*
    Indicator validation
  */

  if (
    ema9 === null ||
    ema21 === null ||
    rsi14 === null ||
    momentum === null ||
    momentumPercent === null
  ) {

    return {

      status:
        "insufficient_data",

      signal:
        "NO TRADE",

      confidence:
        0,

      reason:
        "Technical indicators could not be calculated."
    };
  }


  /* =======================================================
     SCORING
  ======================================================= */

  let bullishScore = 0;
  let bearishScore = 0;

  const reasons = [];


  /*
    EMA
  */

  if (
    ema9 > ema21
  ) {

    bullishScore++;

    reasons.push(
      "EMA9 is above EMA21"
    );

  } else if (
    ema9 < ema21
  ) {

    bearishScore++;

    reasons.push(
      "EMA9 is below EMA21"
    );
  }


  /*
    RSI
  */

  if (
    rsi14 >= 52 &&
    rsi14 < 70
  ) {

    bullishScore++;

    reasons.push(
      "RSI confirms bullish momentum"
    );

  } else if (
    rsi14 <= 48 &&
    rsi14 > 30
  ) {

    bearishScore++;

    reasons.push(
      "RSI confirms bearish momentum"
    );
  }


  /*
    Momentum
  */

  const momentumThreshold =
    0.003;


  if (
    momentumPercent >
    momentumThreshold
  ) {

    bullishScore++;

    reasons.push(
      "Momentum is bullish"
    );

  } else if (
    momentumPercent <
    -momentumThreshold
  ) {

    bearishScore++;

    reasons.push(
      "Momentum is bearish"
    );
  }


  /* =======================================================
     SIGNAL
  ======================================================= */

  let signal =
    "NO TRADE";

  let confidence =
    0;


  /*
    3 / 3
  */

  if (
    bullishScore === 3 &&
    bearishScore === 0
  ) {

    signal =
      "CALL";

    confidence =
      90;

  } else if (
    bearishScore === 3 &&
    bullishScore === 0
  ) {

    signal =
      "PUT";

    confidence =
      90;
  }


  /*
    2 / 3
  */

  else if (
    bullishScore === 2 &&
    bearishScore === 0
  ) {

    signal =
      "CALL";

    confidence =
      70;

  } else if (
    bearishScore === 2 &&
    bullishScore === 0
  ) {

    signal =
      "PUT";

    confidence =
      70;
  }


  /*
    Mixed
  */

  else {

    signal =
      "NO TRADE";

    confidence =
      0;
  }


  /* =======================================================
     REASON
  ======================================================= */

  let reason =
    "Market conditions are not sufficiently aligned.";


  if (
    signal === "CALL"
  ) {

    reason =
      bullishScore === 3
        ? "Strong bullish alignment: EMA, RSI and momentum agree."
        : "Moderate bullish alignment: 2 of 3 indicators agree.";
  }


  if (
    signal === "PUT"
  ) {

    reason =
      bearishScore === 3
        ? "Strong bearish alignment: EMA, RSI and momentum agree."
        : "Moderate bearish alignment: 2 of 3 indicators agree.";
  }


  /* =======================================================
     RETURN
  ======================================================= */

  return {

    status:
      "analyzed",

    signal,

    confidence,

    market: {

      type:
        marketType,

      pair:
        cleanSymbol,

      currentPrice,

      candles:
        candles.length,

      lastUpdate:
        data.lastUpdate,

      source:
        data.source
    },

    indicators: {

      ema9:
        Number(
          ema9.toFixed(8)
        ),

      ema21:
        Number(
          ema21.toFixed(8)
        ),

      rsi14:
        Number(
          rsi14.toFixed(2)
        ),

      momentum:
        Number(
          momentum.toFixed(8)
        ),

      momentumPercent:
        Number(
          momentumPercent.toFixed(5)
        )
    },

    scores: {

      bullish:
        bullishScore,

      bearish:
        bearishScore
    },

    reason,

    indicatorDetails:
      reasons,

    signalLogic: {

      requiredForSignal:
        "At least 2 of 3 indicators must agree.",

      indicators: [
        "EMA9 vs EMA21",
        "RSI14",
        "5-candle momentum"
      ],

      momentumThresholdPercent:
        momentumThreshold,

      confidenceMeaning:
        "Confidence represents technical indicator agreement, not probability of profit or guaranteed accuracy."
    }
  };
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    const symbols = {};


    for (
      const [
        storageKey,
        data
      ] of marketData.entries()
    ) {

      symbols[storageKey] = {

        type:
          data.type,

        pair:
          data.pair,

        status:
          data.status,

        lastUpdate:
          data.lastUpdate,

        source:
          data.source,

        error:
          data.error
      };
    }


    res.json({

      status:
        "ok",

      service:
        "PO AI Predictor Backend",

      version:
        "5.2.0",

      liveDataConfigured:
        Boolean(
          TWELVE_DATA_API_KEY
        ),

      otcDataConfigured:
        Boolean(
          OTC_DATA_URL
        ),

      defaultSymbol:
        DEFAULT_SYMBOL,

      liveInterval:
        TWELVE_DATA_INTERVAL,

      otcInterval:
        OTC_DATA_INTERVAL,

      symbols,

      timestamp:
        new Date().toISOString()
    });
  }
);


/* =========================================================
   CANDLES
========================================================= */

app.get(
  "/api/candles",
  async (req, res) => {

    const requestedPair =
      normalizeSymbol(
        req.query.pair ||
        req.query.symbol ||
        DEFAULT_SYMBOL
      );


    const data =
      await getFreshMarketData(
        requestedPair
      );


    if (
      data.status !== "live"
    ) {

      return res
        .status(503)
        .json({

          status:
            data.status,

          marketType:
            getMarketType(
              requestedPair
            ),

          pair:
            cleanPair(
              requestedPair
            ),

          candles: [],

          message:
            data.error ||
            "Market candle data is not available."
        });
    }


    res.json({

      status:
        "live",

      marketType:
        getMarketType(
          requestedPair
        ),

      pair:
        cleanPair(
          requestedPair
        ),

      count:
        data.candles.length,

      lastUpdate:
        data.lastUpdate,

      source:
        data.source,

      candles:
        data.candles
    });
  }
);


/* =========================================================
   POST /ANALYZE
========================================================= */

app.post(
  "/analyze",
  async (req, res) => {

    const requestedPair =
      normalizeSymbol(
        req.body?.pair ||
        req.body?.symbol ||
        DEFAULT_SYMBOL
      );


    await getFreshMarketData(
      requestedPair
    );


    const analysis =
      analyzeMarket(
        requestedPair
      );


    if (
      analysis.status !==
      "analyzed"
    ) {

      return res
        .status(503)
        .json({

          status:
            analysis.status,

          signal:
            "NO TRADE",

          confidence:
            0,

          timestamp:
            new Date().toISOString(),

          message:
            analysis.reason ||
            "Market data is not available.",

          analysis
        });
    }


    res.json({

      status:
        "ready",

      signal:
        analysis.signal,

      confidence:
        analysis.confidence,

      timestamp:
        new Date().toISOString(),

      analysis
    });
  }
);


/* =========================================================
   MARKET ANALYSIS
========================================================= */

app.get(
  "/api/market-analysis",
  async (req, res) => {

    const requestedPair =
      normalizeSymbol(
        req.query.pair ||
        req.query.symbol ||
        DEFAULT_SYMBOL
      );


    await getFreshMarketData(
      requestedPair
    );


    const analysis =
      analyzeMarket(
        requestedPair
      );


    if (
      analysis.status !==
      "analyzed"
    ) {

      return res
        .status(503)
        .json(
          analysis
        );
    }


    res.json(
      analysis
    );
  }
);


/* =========================================================
   SIGNAL
========================================================= */

app.get(
  "/api/signal",
  async (req, res) => {

    const requestedPair =
      normalizeSymbol(
        req.query.pair ||
        req.query.symbol ||
        DEFAULT_SYMBOL
      );


    console.log(
      `[SIGNAL REQUEST] ${requestedPair}`
    );


    /*
      Get either:

      LIVE data
      OR
      OTC data
    */

    await getFreshMarketData(
      requestedPair
    );


    const analysis =
      analyzeMarket(
        requestedPair
      );


    if (
      analysis.status !==
      "analyzed"
    ) {

      return res
        .status(503)
        .json({

          status:
            analysis.status,

          signal:
            "NO TRADE",

          confidence:
            0,

          timestamp:
            new Date().toISOString(),

          message:
            analysis.reason ||
            "Signal disabled until valid market data is available.",

          analysis
        });
    }


    res.json({

      status:
        "ready",

      signal:
        analysis.signal,

      confidence:
        analysis.confidence,

      timestamp:
        new Date().toISOString(),

      analysis
    });
  }
);


/* =========================================================
   RESULT
========================================================= */

app.post(
  "/api/result",
  (req, res) => {

    const {
      signal,
      result,
      timestamp
    } = req.body || {};


    res.json({

      status:
        "received",

      signal:
        signal || null,

      result:
        result || null,

      timestamp:
        timestamp ||
        new Date().toISOString(),

      message:
        "Result received. Persistent performance storage is not enabled."
    });
  }
);


/* =========================================================
   STATISTICS
========================================================= */

app.get(
  "/api/statistics",
  (req, res) => {

    res.json({

      total:
        0,

      wins:
        0,

      losses:
        0,

      winRate:
        0,

      status:
        "Statistics storage is not enabled."
    });
  }
);


/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      service:
        "PO AI Predictor Backend",

      version:
        "5.2.0",

      status:
        "online",

      endpoints: {

        health:
          "/api/health",

        candles:
          "/api/candles?pair=EUR/USD",

        otcCandles:
          "/api/candles?pair=EUR/USD%20OTC",

        analyze:
          "/analyze",

        marketAnalysis:
          "/api/market-analysis?pair=EUR/USD",

        otcMarketAnalysis:
          "/api/market-analysis?pair=EUR/USD%20OTC",

        signal:
          "/api/signal?pair=EUR/USD",

        otcSignal:
          "/api/signal?pair=EUR/USD%20OTC",

        statistics:
          "/api/statistics"
      },

      livePairs:
        Array.from(
          SUPPORTED_LIVE_PAIRS
        ),

      otcPairs:
        Array.from(
          SUPPORTED_OTC_PAIRS
        ),

      otcDataConfigured:
        Boolean(
          OTC_DATA_URL
        ),

      otcMessage:
        OTC_DATA_URL
          ? "OTC data source configured."
          : "OTC_DATA_URL is not configured. OTC signals remain NO TRADE."
    });
  }
);


/* =========================================================
   DEFAULT LIVE MARKET UPDATER
========================================================= */

async function updateDefaultMarket() {

  if (
    !TWELVE_DATA_API_KEY
  ) {

    console.log(
      "[LIVE UPDATER] TWELVE_DATA_API_KEY is missing."
    );

    return;
  }


  await fetchLiveCandles(
    DEFAULT_SYMBOL
  );
}


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  async () => {

    console.log(
      `PO AI Predictor Backend V5.2 running on port ${PORT}`
    );


    console.log(
      `Default LIVE pair: ${DEFAULT_SYMBOL}`
    );


    console.log(
      `LIVE interval: ${TWELVE_DATA_INTERVAL}`
    );


    /*
      LIVE
    */

    if (
      TWELVE_DATA_API_KEY
    ) {

      console.log(
        "Twelve Data LIVE data updater configured."
      );


      await updateDefaultMarket();


      setInterval(
        updateDefaultMarket,
        LIVE_DATA_INTERVAL
      );

    } else {

      console.log(
        "WARNING: TWELVE_DATA_API_KEY is not configured."
      );

      console.log(
        "LIVE analysis will return NO TRADE until the API key is configured."
      );
    }


    /*
      OTC
    */

    if (
      OTC_DATA_URL
    ) {

      console.log(
        "OTC data source configured."
      );

    } else {

      console.log(
        "OTC_DATA_URL is not configured."
      );

      console.log(
        "OTC signals will remain NO TRADE until a real OTC data source is connected."
      );
    }
  }
);
