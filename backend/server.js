const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ============================================================
   PO AI PREDICTOR BACKEND V5
   LIVE MULTI-PAIR MARKET DATA
   ============================================================ */

/*
   IMPORTANT:
   - LIVE market data comes from Twelve Data.
   - OTC data is NOT provided by Twelve Data here.
   - Therefore OTC requests return NO TRADE until
     a verified OTC data source is connected.
*/

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const DEFAULT_SYMBOL =
  process.env.TWELVE_DATA_SYMBOL || "EUR/USD";

const TWELVE_DATA_INTERVAL =
  process.env.TWELVE_DATA_INTERVAL || "1min";

const LIVE_DATA_INTERVAL =
  Number(process.env.LIVE_DATA_INTERVAL) || 60000;

const MAX_CANDLES = 200;

const CACHE_MAX_AGE =
  LIVE_DATA_INTERVAL;


/* ============================================================
   SUPPORTED LIVE PAIRS
   ============================================================ */

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


/* ============================================================
   MARKET DATA CACHE
   ============================================================ */

const marketData = new Map();


/*
Example:

marketData.set("EUR/USD", {
  candles: [],
  status: "data_updater_required",
  lastUpdate: null,
  source: null,
  error: null
});
*/


/* ============================================================
   HELPERS
   ============================================================ */

function number(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function normalizeSymbol(value) {
  if (!value) {
    return DEFAULT_SYMBOL;
  }

  return String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}


function isOTCPair(symbol) {
  return String(symbol)
    .toUpperCase()
    .includes("OTC");
}


function cleanPair(symbol) {
  return String(symbol)
    .replace(/\s+OTC$/i, "")
    .trim()
    .toUpperCase();
}


function isSupportedLivePair(symbol) {
  return SUPPORTED_LIVE_PAIRS.has(
    cleanPair(symbol)
  );
}


function createEmptyMarketData() {
  return {
    candles: [],
    status: "data_updater_required",
    lastUpdate: null,
    source: null,
    error: null
  };
}


function getMarketData(symbol) {
  const cleanSymbol =
    cleanPair(symbol);

  if (!marketData.has(cleanSymbol)) {
    marketData.set(
      cleanSymbol,
      createEmptyMarketData()
    );
  }

  return marketData.get(
    cleanSymbol
  );
}


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
   TWELVE DATA
   ============================================================ */

async function fetchLiveCandles(symbol) {

  const cleanSymbol =
    cleanPair(symbol);

  const data =
    getMarketData(cleanSymbol);

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
      `?symbol=${encodeURIComponent(
        cleanSymbol
      )}` +
      `&interval=${encodeURIComponent(
        TWELVE_DATA_INTERVAL
      )}` +
      "&outputsize=100" +
      "&timezone=UTC" +
      `&apikey=${encodeURIComponent(
        TWELVE_DATA_API_KEY
      )}`;


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
      payload.status ===
      "error"
    ) {

      throw new Error(
        payload.message ||
        "Twelve Data API error."
      );
    }


    if (
      !Array.isArray(
        payload.values
      )
    ) {

      throw new Error(
        "Twelve Data response does not contain values."
      );
    }


    const normalized =
      payload.values
        .map(
          candle =>
            normalizeCandle({
              time:
                candle.datetime,

              open:
                candle.open,

              high:
                candle.high,

              low:
                candle.low,

              close:
                candle.close
            })
        )
        .filter(Boolean)
        .reverse()
        .slice(
          -MAX_CANDLES
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


/* ============================================================
   GET FRESH DATA WHEN NEEDED
   ============================================================ */

async function getFreshMarketData(
  symbol
) {

  const cleanSymbol =
    cleanPair(symbol);

  const data =
    getMarketData(cleanSymbol);


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


  return await fetchLiveCandles(
    cleanSymbol
  );
}


/* ============================================================
   TECHNICAL INDICATORS
   ============================================================ */

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
    2 / (period + 1);


  let ema =
    values
      .slice(
        0,
        period
      )
      .reduce(
        (
          sum,
          value
        ) =>
          sum + value,
        0
      ) / period;


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

      gains +=
        difference;

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
      ) / period;


    averageLoss =
      (
        averageLoss *
          (period - 1) +
        loss
      ) / period;
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
      (
        1 +
        relativeStrength
      )
  );
}


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
      values.length -
        1 -
        period
    ]
  );
}


/* ============================================================
   MARKET ANALYSIS
   ============================================================ */

function analyzeMarket(
  symbol
) {

  const cleanSymbol =
    cleanPair(symbol);


  const data =
    getMarketData(
      cleanSymbol
    );


  if (
    isOTCPair(symbol)
  ) {

    return {

      status:
        "otc_data_unavailable",

      signal:
        "NO TRADE",

      confidence:
        0,

      reason:
        "Verified OTC market data source is not connected.",

      market: {
        type: "OTC",
        pair: cleanSymbol
      },

      dataRequired:
        true
    };
  }


  if (
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
        "Verified live market data is not available.",

      dataRequired:
        true
    };
  }


  const candles =
    data.candles;


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
        candles.length
    };
  }


  const closes =
    candles.map(
      candle =>
        candle.close
    );


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


  if (
    ema9 === null ||
    ema21 === null ||
    rsi14 === null ||
    momentum === null
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


  let bullishScore = 0;

  let bearishScore = 0;


  /* EMA */

  if (
    ema9 > ema21
  ) {

    bullishScore++;

  } else if (
    ema9 < ema21
  ) {

    bearishScore++;
  }


  /* RSI */

  if (
    rsi14 > 50 &&
    rsi14 < 70
  ) {

    bullishScore++;

  } else if (
    rsi14 < 50 &&
    rsi14 > 30
  ) {

    bearishScore++;
  }


  /* MOMENTUM */

  if (
    momentum > 0
  ) {

    bullishScore++;

  } else if (
    momentum < 0
  ) {

    bearishScore++;
  }


  let signal =
    "NO TRADE";


  if (
    bullishScore >= 3 &&
    bearishScore === 0
  ) {

    signal =
      "CALL";
  }


  if (
    bearishScore >= 3 &&
    bullishScore === 0
  ) {

    signal =
      "PUT";
  }


  /*
     IMPORTANT:
     100% here means all 3 internal
     conditions aligned.
     It is NOT a guarantee of a win.
  */

  const confidence =
    signal === "NO TRADE"
      ? 0
      : Math.round(
          (
            Math.max(
              bullishScore,
              bearishScore
            ) / 3
          ) * 100
        );


  return {

    status:
      "analyzed",

    signal,

    confidence,

    market: {

      type:
        "LIVE",

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
        )
    },


    scores: {

      bullish:
        bullishScore,

      bearish:
        bearishScore
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

app.get(
  "/api/health",
  (req, res) => {

    const symbols = {};

    for (
      const [
        symbol,
        data
      ] of marketData.entries()
    ) {

      symbols[symbol] = {

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
        "5.0.0",

      liveDataConfigured:
        Boolean(
          TWELVE_DATA_API_KEY
        ),

      defaultSymbol:
        DEFAULT_SYMBOL,

      interval:
        TWELVE_DATA_INTERVAL,

      symbols,

      timestamp:
        new Date().toISOString()
    });
  }
);


/* ============================================================
   API: CANDLES
   ============================================================ */

app.get(
  "/api/candles",
  async (req, res) => {

    const requestedPair =
      req.query.pair ||
      DEFAULT_SYMBOL;


    if (
      isOTCPair(
        requestedPair
      )
    ) {

      return res.status(503).json({

        status:
          "otc_data_unavailable",

        candles:
          [],

        message:
          "Verified OTC market data source is not connected."
      });
    }


    const data =
      await getFreshMarketData(
        requestedPair
      );


    if (
      data.status !== "live"
    ) {

      return res.status(503).json({

        status:
          data.status,

        candles:
          [],

        message:
          data.error ||
          "Live candle data is not available."
      });
    }


    res.json({

      status:
        "live",

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


/* ============================================================
   API: ANALYZE
   ============================================================ */

app.post(
  "/analyze",
  async (req, res) => {

    const requestedPair =
      req.body?.pair ||
      req.body?.symbol ||
      DEFAULT_SYMBOL;


    if (
      !isOTCPair(
        requestedPair
      )
    ) {

      await getFreshMarketData(
        requestedPair
      );
    }


    const analysis =
      analyzeMarket(
        requestedPair
      );


    if (
      analysis.status !==
      "analyzed"
    ) {

      return res.status(503).json({

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


/* ============================================================
   API: MARKET ANALYSIS
   ============================================================ */

app.get(
  "/api/market-analysis",
  async (req, res) => {

    const requestedPair =
      req.query.pair ||
      DEFAULT_SYMBOL;


    if (
      !isOTCPair(
        requestedPair
      )
    ) {

      await getFreshMarketData(
        requestedPair
      );
    }


    const analysis =
      analyzeMarket(
        requestedPair
      );


    if (
      analysis.status !==
      "analyzed"
    ) {

      return res.status(503).json(
        analysis
      );
    }


    res.json(
      analysis
    );
  }
);


/* ============================================================
   API: SIGNAL
   ============================================================ */

app.get(
  "/api/signal",
  async (req, res) => {

    /*
       Frontend should eventually send:

       /api/signal?pair=EUR/USD

       or:

       /api/signal?pair=GBP/USD
    */

    const requestedPair =
      req.query.pair ||
      req.query.symbol ||
      DEFAULT_SYMBOL;


    console.log(
      `[SIGNAL REQUEST] ${requestedPair}`
    );


    /*
       OTC is deliberately blocked
       until a verified OTC source exists.
    */

    if (
      isOTCPair(
        requestedPair
      )
    ) {

      return res.status(503).json({

        status:
          "otc_data_unavailable",

        signal:
          "NO TRADE",

        confidence:
          0,

        message:
          "Verified OTC market data source is not connected.",

        market: {

          type:
            "OTC",

          pair:
            cleanPair(
              requestedPair
            )
        }
      });
    }


    /*
       Load requested LIVE pair.
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

      return res.status(503).json({

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


/* ============================================================
   API: RESULT
   ============================================================ */

app.post(
  "/api/result",
  (req, res) => {

    const {
      signal,
      result,
      timestamp
    } =
      req.body || {};


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


/* ============================================================
   API: STATISTICS
   ============================================================ */

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


/* ============================================================
   ROOT
   ============================================================ */

app.get(
  "/",
  (req, res) => {

    res.json({

      service:
        "PO AI Predictor Backend",

      version:
        "5.0.0",

      status:
        "online",

      endpoints: {

        health:
          "/api/health",

        candles:
          "/api/candles?pair=EUR/USD",

        analyze:
          "/analyze",

        marketAnalysis:
          "/api/market-analysis?pair=EUR/USD",

        signal:
          "/api/signal?pair=EUR/USD",

        statistics:
          "/api/statistics"
      },

      supportedLivePairs:
        Array.from(
          SUPPORTED_LIVE_PAIRS
        ),

      otc:
        "NO TRADE until verified OTC data source is connected."
    });
  }
);


/* ============================================================
   BACKGROUND LIVE DATA UPDATER
   ============================================================ */

async function updateDefaultMarket() {

  if (
    !TWELVE_DATA_API_KEY
  ) {

    console.log(
      "[UPDATER] TWELVE_DATA_API_KEY is missing."
    );

    return;
  }


  await fetchLiveCandles(
    DEFAULT_SYMBOL
  );
}


/* ============================================================
   START SERVER
   ============================================================ */

app.listen(
  PORT,
  async () => {

    console.log(
      `PO AI Predictor Backend V5 running on port ${PORT}`
    );


    console.log(
      `Default pair: ${DEFAULT_SYMBOL}`
    );


    console.log(
      `Interval: ${TWELVE_DATA_INTERVAL}`
    );


    if (
      TWELVE_DATA_API_KEY
    ) {

      console.log(
        "Twelve Data live data updater configured."
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
        "Live analysis will return NO TRADE until the API key is configured."
      );
    }
  }
);
