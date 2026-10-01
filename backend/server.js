/* =========================================================
   PO AI PREDICTOR
   V8.4 • CREDIT-SAFE LIVE SCANNER
   Source: Twelve Data LIVE
   Timezone: UTC
   ========================================================= */

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

/* =========================================================
   CONFIG
   ========================================================= */

const PORT = process.env.PORT || 10000;

const VERSION = "V8.4";
const SOURCE = "Twelve Data LIVE";
const TIMEZONE = "UTC";

const API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const TWELVE_DATA_URL =
  "https://api.twelvedata.com/time_series";


/* =========================================================
   PAIRS
   ========================================================= */

const PAIRS = [
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

const TIMEFRAMES = [1, 2, 3];


/* =========================================================
   TWELVE DATA DAILY CREDIT PROTECTION
   ========================================================= */

/*
   Twelve Data Basic:
   8 API credits/minute
   800 API credits/day

   We intentionally keep a reserve so that the application
   never deliberately walks past the daily limit.
*/

const DAILY_CREDIT_LIMIT = 800;

/*
   Keep a small safety reserve.
*/
const DAILY_SAFETY_RESERVE = 32;

const MAX_DAILY_REQUESTS =
  DAILY_CREDIT_LIMIT - DAILY_SAFETY_RESERVE;


/* =========================================================
   SCANNER SETTINGS
   ========================================================= */

/*
   8 pairs per scan.

   8 requests every 15 minutes =
   768 theoretical requests/day.

   This is deliberately below the 800/day limit.
*/

const SCAN_BATCH_SIZE = 8;

const SCAN_EVERY_MS =
  15 * 60 * 1000;


/*
   We do not hammer the API.
*/
const REQUEST_DELAY_MS = 1200;


/*
   Market data is only considered fresh for signal
   generation when it is recent enough.
*/
const MAX_DATA_AGE_SECONDS = 90;


/*
   Cached data can remain stored longer, but stale
   data will not create a fresh CALL/PUT signal.
*/
const CACHE_RETENTION_SECONDS = 60 * 60;


/*
   Signal should be visible before entry.
*/
const ENTRY_BUFFER_SECONDS = 30;


/*
   Candle settings.
*/
const MAX_CANDLES = 180;
const MIN_CANDLES = 60;


/* =========================================================
   STATE
   ========================================================= */

const cache = new Map();

const failedPairs = new Map();

const scanner = {
  running: false,
  cursor: 0,
  lastScanAt: null,
  lastScanError: null,
  totalScanned: 0,
  totalFailed: 0,
  totalApiRequests: 0,
  lastSuccessfulRequestAt: null,
  dailyRequests: 0,
  dailyCreditsUsed: 0,
  dailyCreditsLeft: null,
  quotaBlocked: false,
  quotaBlockedAt: null,
  quotaResetAt: null
};


/* =========================================================
   DAILY RESET
   ========================================================= */

function getNextUtcMidnight() {
  const now = new Date();

  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0
    )
  );

  return next;
}


function resetDailyBudgetIfNeeded() {
  const now = new Date();

  if (!scanner.quotaResetAt) {
    scanner.quotaResetAt =
      getNextUtcMidnight().toISOString();
    return;
  }

  const resetAt =
    new Date(scanner.quotaResetAt);

  if (now >= resetAt) {

    scanner.dailyRequests = 0;
    scanner.dailyCreditsUsed = 0;
    scanner.dailyCreditsLeft = null;

    scanner.quotaBlocked = false;
    scanner.quotaBlockedAt = null;

    scanner.lastScanError = null;

    scanner.quotaResetAt =
      getNextUtcMidnight().toISOString();

    /*
      Failed pair errors are cleared after the daily reset.
    */
    failedPairs.clear();
  }
}


/* =========================================================
   DAILY CREDIT CHECK
   ========================================================= */

function canUseApiCredit() {

  resetDailyBudgetIfNeeded();

  if (scanner.quotaBlocked) {
    return false;
  }

  if (
    scanner.dailyRequests >=
    MAX_DAILY_REQUESTS
  ) {
    scanner.quotaBlocked = true;

    scanner.quotaBlockedAt =
      new Date().toISOString();

    scanner.lastScanError =
      `Daily safety limit reached: ` +
      `${scanner.dailyRequests}/${DAILY_CREDIT_LIMIT} credits used.`;

    return false;
  }

  if (
    Number.isFinite(scanner.dailyCreditsLeft) &&
    scanner.dailyCreditsLeft <= DAILY_SAFETY_RESERVE
  ) {
    scanner.quotaBlocked = true;

    scanner.quotaBlockedAt =
      new Date().toISOString();

    scanner.lastScanError =
      `Twelve Data credits nearly exhausted. ` +
      `Scanner paused until ${scanner.quotaResetAt}.`;

    return false;
  }

  return true;
}


/* =========================================================
   QUOTA ERROR DETECTION
   ========================================================= */

function isQuotaError(message) {

  const text =
    String(message || "").toLowerCase();

  return (
    text.includes("run out of api credits") ||
    text.includes("api credits") ||
    text.includes("daily limit") ||
    text.includes("current limit being 800") ||
    text.includes("credits were used")
  );
}


/* =========================================================
   MARK QUOTA BLOCKED
   ========================================================= */

function blockQuota(message) {

  scanner.quotaBlocked = true;

  scanner.quotaBlockedAt =
    new Date().toISOString();

  scanner.quotaResetAt =
    getNextUtcMidnight().toISOString();

  scanner.lastScanError =
    String(message || "Twelve Data daily quota reached.");
}


/* =========================================================
   UTILITY
   ========================================================= */

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


function round(value, digits = 5) {

  if (!Number.isFinite(Number(value))) {
    return null;
  }

  const factor =
    Math.pow(10, digits);

  return (
    Math.round(
      Number(value) * factor
    ) / factor
  );
}


/* =========================================================
   CANDLE NORMALIZATION
   ========================================================= */

function normalizeCandles(values) {

  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map(item => {

      const time =
        item.datetime ||
        item.time ||
        item.timestamp;

      const open =
        Number(item.open);

      const high =
        Number(item.high);

      const low =
        Number(item.low);

      const close =
        Number(item.close);

      if (
        !time ||
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close)
      ) {
        return null;
      }

      const timestamp =
        new Date(time).getTime();

      if (!Number.isFinite(timestamp)) {
        return null;
      }

      return {
        time,
        timestamp,
        open,
        high,
        low,
        close
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.timestamp - b.timestamp
    );
}


/* =========================================================
   FETCH CANDLES
   ========================================================= */

async function fetchCandles(pair) {

  resetDailyBudgetIfNeeded();

  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is not configured."
    );
  }

  if (!canUseApiCredit()) {
    throw new Error(
      scanner.lastScanError ||
      "Twelve Data daily quota protection is active."
    );
  }


  const params = new URLSearchParams({
    symbol: pair,
    interval: "1min",
    outputsize: String(MAX_CANDLES),
    order: "ASC",
    timezone: "UTC",
    apikey: API_KEY
  });


  const url =
    `${TWELVE_DATA_URL}?${params.toString()}`;


  await sleep(REQUEST_DELAY_MS);


  let response;

  try {

    response =
      await fetch(url);

  } catch (error) {

    throw new Error(
      `${pair}: Network error: ${error.message}`
    );
  }


  /*
    Twelve Data exposes credit information in headers.
  */

  const creditsUsedHeader =
    response.headers.get(
      "api-credits-used"
    );

  const creditsLeftHeader =
    response.headers.get(
      "api-credits-left"
    );


  const creditsUsed =
    Number(creditsUsedHeader);

  const creditsLeft =
    Number(creditsLeftHeader);


  if (
    Number.isFinite(creditsLeft)
  ) {
    scanner.dailyCreditsLeft =
      creditsLeft;
  }


  scanner.totalApiRequests += 1;
  scanner.dailyRequests += 1;

  scanner.lastSuccessfulRequestAt =
    new Date().toISOString();


  if (
    Number.isFinite(creditsUsed)
  ) {
    scanner.dailyCreditsUsed =
      Math.max(
        scanner.dailyCreditsUsed,
        creditsUsed
      );
  } else {
    scanner.dailyCreditsUsed =
      scanner.dailyRequests;
  }


  let data;

  try {

    data =
      await response.json();

  } catch (error) {

    throw new Error(
      `${pair}: Invalid Twelve Data JSON response.`
    );
  }


  /*
    Detect quota even if Twelve Data returns HTTP 200.
  */

  const message =
    data?.message ||
    data?.code ||
    data?.status;


  if (
    isQuotaError(message) ||
    isQuotaError(JSON.stringify(data))
  ) {

    blockQuota(
      `${pair}: ${message || "Twelve Data quota reached."}`
    );

    throw new Error(
      `${pair}: Twelve Data daily quota reached.`
    );
  }


  if (
    !response.ok
  ) {

    throw new Error(
      `${pair}: Twelve Data HTTP ${response.status}.`
    );
  }


  if (
    data?.status === "error"
  ) {

    throw new Error(
      `${pair}: ${data.message || "Twelve Data error."}`
    );
  }


  const values =
    data?.values ||
    data?.data ||
    [];


  const candles =
    normalizeCandles(values);


  if (
    candles.length < MIN_CANDLES
  ) {

    throw new Error(
      `${pair}: insufficient candle data (${candles.length}/${MIN_CANDLES}).`
    );
  }


  /*
    Only completed 1-minute candles.
  */

  const now =
    Date.now();

  const completed =
    candles.filter(
      candle =>
        candle.timestamp <=
        now - 1000
    );


  if (
    completed.length < MIN_CANDLES
  ) {

    throw new Error(
      `${pair}: insufficient completed candles.`
    );
  }


  return completed.slice(
    -MAX_CANDLES
  );
}


/* =========================================================
   AGGREGATE TIMEFRAME
   ========================================================= */

function aggregateCandles(
  candles,
  timeframe
) {

  if (
    timeframe === 1
  ) {
    return candles.slice();
  }


  const bucketMap =
    new Map();


  for (const candle of candles) {

    const date =
      new Date(
        candle.timestamp
      );

    const minute =
      date.getUTCMinutes();

    const bucketMinute =
      Math.floor(
        minute / timeframe
      ) * timeframe;


    const bucketStart =
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        bucketMinute,
        0,
        0
      );


    if (
      !bucketMap.has(bucketStart)
    ) {

      bucketMap.set(
        bucketStart,
        []
      );
    }


    bucketMap
      .get(bucketStart)
      .push(candle);
  }


  const result = [];


  for (
    const [
      timestamp,
      group
    ] of bucketMap
  ) {

    if (
      group.length !== timeframe
    ) {
      continue;
    }


    group.sort(
      (a, b) =>
        a.timestamp -
        b.timestamp
    );


    result.push({
      time:
        new Date(timestamp)
          .toISOString(),

      timestamp,

      open:
        group[0].open,

      high:
        Math.max(
          ...group.map(x => x.high)
        ),

      low:
        Math.min(
          ...group.map(x => x.low)
        ),

      close:
        group[group.length - 1].close
    });
  }


  return result.sort(
    (a, b) =>
      a.timestamp -
      b.timestamp
  );
}


/* =========================================================
   EMA
   ========================================================= */

function ema(values, period) {

  if (
    values.length < period
  ) {
    return null;
  }


  const multiplier =
    2 / (period + 1);


  let result =
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

    result =
      (
        values[i] -
        result
      ) *
      multiplier +
      result;
  }


  return result;
}


/* =========================================================
   RSI
   ========================================================= */

function rsi(values, period = 14) {

  if (
    values.length <= period
  ) {
    return null;
  }


  let gain = 0;
  let loss = 0;


  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    if (change >= 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }


  let avgGain =
    gain / period;

  let avgLoss =
    loss / period;


  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];


    const currentGain =
      change > 0
        ? change
        : 0;

    const currentLoss =
      change < 0
        ? -change
        : 0;


    avgGain =
      (
        avgGain *
        (period - 1) +
        currentGain
      ) / period;


    avgLoss =
      (
        avgLoss *
        (period - 1) +
        currentLoss
      ) / period;
  }


  if (
    avgLoss === 0
  ) {
    return 100;
  }


  const rs =
    avgGain /
    avgLoss;


  return 100 -
    100 /
      (1 + rs);
}


/* =========================================================
   ATR
   ========================================================= */

function atr(candles, period = 14) {

  if (
    candles.length <= period
  ) {
    return null;
  }


  const trs = [];


  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];


    const tr =
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


    trs.push(tr);
  }


  if (
    trs.length < period
  ) {
    return null;
  }


  let value =
    trs
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;


  for (
    let i = period;
    i < trs.length;
    i++
  ) {

    value =
      (
        value *
        (period - 1) +
        trs[i]
      ) / period;
  }


  return value;
}


/* =========================================================
   ADX
   ========================================================= */

function adx(candles, period = 14) {

  if (
    candles.length <
    period * 2 + 1
  ) {
    return null;
  }


  const trs = [];
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


    const upMove =
      current.high -
      previous.high;

    const downMove =
      previous.low -
      current.low;


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


    trs.push(trueRange);

    plusDM.push(
      upMove > downMove &&
      upMove > 0
        ? upMove
        : 0
    );

    minusDM.push(
      downMove > upMove &&
      downMove > 0
        ? downMove
        : 0
    );
  }


  if (
    trs.length < period
  ) {
    return null;
  }


  let atrValue =
    trs
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;


  let plusValue =
    plusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;


  let minusValue =
    minusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;


  const dxValues = [];


  for (
    let i = period;
    i < trs.length;
    i++
  ) {

    if (i > period) {

      atrValue =
        (
          atrValue *
          (period - 1) +
          trs[i]
        ) / period;


      plusValue =
        (
          plusValue *
          (period - 1) +
          plusDM[i]
        ) / period;


      minusValue =
        (
          minusValue *
          (period - 1) +
          minusDM[i]
        ) / period;
    }


    const plusDI =
      atrValue === 0
        ? 0
        : 100 *
          (plusValue /
            atrValue);


    const minusDI =
      atrValue === 0
        ? 0
        : 100 *
          (minusValue /
            atrValue);


    const denominator =
      plusDI +
      minusDI;


    const dx =
      denominator === 0
        ? 0
        : 100 *
          Math.abs(
            plusDI -
              minusDI
          ) /
          denominator;


    dxValues.push(dx);
  }


  if (
    dxValues.length < period
  ) {
    return null;
  }


  let adxValue =
    dxValues
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;


  for (
    let i = period;
    i < dxValues.length;
    i++
  ) {

    adxValue =
      (
        adxValue *
        (period - 1) +
        dxValues[i]
      ) / period;
  }


  return adxValue;
}


/* =========================================================
   SUPPORT / RESISTANCE
   ========================================================= */

function supportResistance(candles) {

  const recent =
    candles.slice(-40);


  if (!recent.length) {
    return {
      support: null,
      resistance: null
    };
  }


  const support =
    Math.min(
      ...recent.map(
        candle => candle.low
      )
    );


  const resistance =
    Math.max(
      ...recent.map(
        candle => candle.high
      )
    );


  return {
    support,
    resistance
  };
}


/* =========================================================
   CANDLE PATTERN
   ========================================================= */

function candlePattern(candle) {

  const body =
    Math.abs(
      candle.close -
      candle.open
    );


  const range =
    candle.high -
    candle.low;


  if (
    range <= 0
  ) {
    return {
      name: "NEUTRAL",
      direction: "NEUTRAL"
    };
  }


  const upperWick =
    candle.high -
    Math.max(
      candle.open,
      candle.close
    );


  const lowerWick =
    Math.min(
      candle.open,
      candle.close
    ) -
    candle.low;


  if (
    lowerWick >
      body * 1.8 &&
    lowerWick >
      upperWick * 1.2
  ) {

    return {
      name: "BULLISH REJECTION",
      direction: "BULLISH"
    };
  }


  if (
    upperWick >
      body * 1.8 &&
    upperWick >
      lowerWick * 1.2
  ) {

    return {
      name: "BEARISH REJECTION",
      direction: "BEARISH"
    };
  }


  if (
    body / range < 0.2
  ) {

    return {
      name: "DOJI",
      direction: "NEUTRAL"
    };
  }


  if (
    candle.close >
    candle.open
  ) {

    return {
      name: "BULLISH CANDLE",
      direction: "BULLISH"
    };
  }


  if (
    candle.close <
    candle.open
  ) {

    return {
      name: "BEARISH CANDLE",
      direction: "BEARISH"
    };
  }


  return {
    name: "NEUTRAL",
    direction: "NEUTRAL"
  };
}


/* =========================================================
   PRICE ACTION
   ========================================================= */

function priceAction(candles) {

  if (
    candles.length < 8
  ) {
    return {
      direction: "NEUTRAL",
      call: 0,
      put: 0,
      text: "INSUFFICIENT DATA"
    };
  }


  const recent =
    candles.slice(-6);


  let bullish = 0;
  let bearish = 0;


  for (
    const candle of recent
  ) {

    if (
      candle.close >
      candle.open
    ) {
      bullish++;
    }

    if (
      candle.close <
      candle.open
    ) {
      bearish++;
    }
  }


  const last =
    candles[candles.length - 1];


  const previous =
    candles[candles.length - 4];


  if (
    last.close >
    previous.close
  ) {
    bullish++;
  }


  if (
    last.close <
    previous.close
  ) {
    bearish++;
  }


  if (
    bullish > bearish
  ) {

    return {
      direction: "BULLISH",
      call: 10,
      put: 0,
      text: "BULLISH PRICE ACTION"
    };
  }


  if (
    bearish > bullish
  ) {

    return {
      direction: "BEARISH",
      call: 0,
      put: 10,
      text: "BEARISH PRICE ACTION"
    };
  }


  return {
    direction: "NEUTRAL",
    call: 0,
    put: 0,
    text: "MIXED PRICE ACTION"
  };
}


/* =========================================================
   ENTRY / EXPIRY
   ========================================================= */

function buildEntryExpiry(
  timeframe
) {

  const now =
    new Date();


  const tf =
    Number(timeframe);


  const minute =
    now.getUTCMinutes();


  const second =
    now.getUTCSeconds();


  let nextMinute =
    Math.floor(
      minute / tf
    ) * tf +
    tf;


  let entry =
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        nextMinute,
        0,
        0
      )
    );


  /*
    Make sure entry is at least 30 seconds away.
  */

  let secondsUntil =
    Math.floor(
      (
        entry.getTime() -
        now.getTime()
      ) / 1000
    );


  if (
    secondsUntil <
    ENTRY_BUFFER_SECONDS
  ) {

    entry =
      new Date(
        entry.getTime() +
        tf * 60 * 1000
      );
  }


  const expiry =
    new Date(
      entry.getTime() +
      tf * 60 * 1000
    );


  secondsUntil =
    Math.max(
      0,
      Math.floor(
        (
          entry.getTime() -
          now.getTime()
        ) / 1000
      )
    );


  return {
    entryTime:
      entry.toISOString(),

    expiryTime:
      expiry.toISOString(),

    entryInSeconds:
      secondsUntil
  };
}


/* =========================================================
   MARKET ANALYSIS
   ========================================================= */

function analyzeCandles(
  pair,
  timeframe,
  candles
) {

  const tfCandles =
    aggregateCandles(
      candles,
      timeframe
    );


  if (
    tfCandles.length <
    MIN_CANDLES / timeframe
  ) {

    return null;
  }


  const closes =
    tfCandles.map(
      candle =>
        candle.close
    );


  const ema9Value =
    ema(
      closes,
      9
    );


  const ema21Value =
    ema(
      closes,
      21
    );


  const rsiValue =
    rsi(
      closes,
      14
    );


  const atrValue =
    atr(
      tfCandles,
      14
    );


  const adxValue =
    adx(
      tfCandles,
      14
    );


  const sr =
    supportResistance(
      tfCandles
    );


  const last =
    tfCandles[
      tfCandles.length - 1
    ];


  const previous =
    tfCandles[
      tfCandles.length - 2
    ];


  if (
    !last ||
    !previous ||
    !Number.isFinite(ema9Value) ||
    !Number.isFinite(ema21Value) ||
    !Number.isFinite(rsiValue) ||
    !Number.isFinite(adxValue)
  ) {

    return null;
  }


  let callScore = 0;
  let putScore = 0;

  const reasonList = [];


  /* EMA */

  if (
    ema9Value >
    ema21Value
  ) {

    callScore += 22;

    reasonList.push(
      "EMA 9 above EMA 21"
    );

  } else if (
    ema9Value <
    ema21Value
  ) {

    putScore += 22;

    reasonList.push(
      "EMA 9 below EMA 21"
    );
  }


  /* RSI */

  if (
    rsiValue >= 52 &&
    rsiValue <= 68
  ) {

    callScore += 18;

    reasonList.push(
      "RSI supports bullish momentum"
    );

  } else if (
    rsiValue <= 48 &&
    rsiValue >= 32
  ) {

    putScore += 18;

    reasonList.push(
      "RSI supports bearish momentum"
    );

  } else if (
    rsiValue > 70
  ) {

    putScore += 8;

    reasonList.push(
      "RSI is overbought"
    );

  } else if (
    rsiValue < 30
  ) {

    callScore += 8;

    reasonList.push(
      "RSI is oversold"
    );
  }


  /* ADX */

  if (
    adxValue >= 20
  ) {

    if (
      ema9Value >
      ema21Value
    ) {

      callScore += 16;

    } else if (
      ema9Value <
      ema21Value
    ) {

      putScore += 16;
    }


    reasonList.push(
      `ADX confirms trend strength (${adxValue.toFixed(1)})`
    );

  } else {

    reasonList.push(
      `ADX indicates weak trend (${adxValue.toFixed(1)})`
    );
  }


  /* Candle */

  const candle =
    candlePattern(last);


  if (
    candle.direction ===
    "BULLISH"
  ) {

    callScore += 10;

    reasonList.push(
      candle.name
    );

  } else if (
    candle.direction ===
    "BEARISH"
  ) {

    putScore += 10;

    reasonList.push(
      candle.name
    );
  }


  /* Price action */

  const pa =
    priceAction(
      tfCandles
    );


  callScore +=
    pa.call;

  putScore +=
    pa.put;


  reasonList.push(
    pa.text
  );


  /* Support / resistance location */

  const range =
    sr.resistance -
    sr.support;


  let location =
    "MID_RANGE";


  if (
    range > 0
  ) {

    const position =
      (
        last.close -
        sr.support
      ) / range;


    if (
      position < 0.20
    ) {

      location =
        "NEAR_SUPPORT";

      callScore += 8;

      reasonList.push(
        "Price is near support"
      );

    } else if (
      position > 0.80
    ) {

      location =
        "NEAR_RESISTANCE";

      putScore += 8;

      reasonList.push(
        "Price is near resistance"
      );
    }
  }


  /* Price direction */

  if (
    last.close >
    previous.close
  ) {

    callScore += 6;

  } else if (
    last.close <
    previous.close
  ) {

    putScore += 6;
  }


  callScore =
    clamp(
      callScore,
      0,
      100
    );


  putScore =
    clamp(
      putScore,
      0,
      100
    );


  const difference =
    Math.abs(
      callScore -
      putScore
    );


  let signal =
    "NO TRADE";


  let confidence =
    Math.max(
      callScore,
      putScore
    );


  /*
    Conservative signal threshold.
  */

  if (
    callScore >= 65 &&
    difference >= 15 &&
    callScore > putScore
  ) {

    signal = "CALL";

  } else if (
    putScore >= 65 &&
    difference >= 15 &&
    putScore > callScore
  ) {

    signal = "PUT";

  } else {

    signal = "NO TRADE";
  }


  /* Trend */

  let trend =
    "RANGING";


  if (
    ema9Value >
      ema21Value &&
    adxValue >= 20
  ) {

    trend =
      "UPTREND";

  } else if (
    ema9Value <
      ema21Value &&
    adxValue >= 20
  ) {

    trend =
      "DOWNTREND";

  } else if (
    ema9Value >
    ema21Value
  ) {

    trend =
      "MILD UPTREND";

  } else if (
    ema9Value <
    ema21Value
  ) {

    trend =
      "MILD DOWNTREND";
  }


  /*
    Entry/expiry.
  */

  const schedule =
    buildEntryExpiry(
      timeframe
    );


  /*
    Data age.
  */

  const lastCandleTimestamp =
    last.timestamp;


  const ageSeconds =
    Math.max(
      0,
      Math.floor(
        (
          Date.now() -
          lastCandleTimestamp
        ) / 1000
      )
    );


  const fresh =
    ageSeconds <=
    MAX_DATA_AGE_SECONDS;


  /*
    Never issue a CALL/PUT from stale market data.
  */

  if (
    !fresh
  ) {

    signal =
      "NO TRADE";

    confidence =
      Math.min(
        confidence,
        40
      );

    reasonList.push(
      `Market data is stale (${ageSeconds}s)`
    );
  }


  /*
    Do not generate an entry too close to now.
  */

  if (
    schedule.entryInSeconds <
    ENTRY_BUFFER_SECONDS
  ) {

    signal =
      "NO TRADE";

    confidence =
      Math.min(
        confidence,
        40
      );

    reasonList.push(
      "Entry buffer is too short"
    );
  }


  /*
    NO TRADE confidence remains informative,
    but never pretends to be a win probability.
  */

  if (
    signal === "NO TRADE"
  ) {

    confidence =
      clamp(
        Math.max(
          callScore,
          putScore
        ),
        0,
        69
      );
  } else {

    confidence =
      clamp(
        Math.max(
          callScore,
          putScore
        ),
        70,
        95
      );
  }


  return {

    pair,

    timeframe,

    signal,

    confidence,

    trend,

    callScore:
      round(
        callScore,
        0
      ),

    putScore:
      round(
        putScore,
        0
      ),

    difference:
      round(
        difference,
        0
      ),

    entryPrice:
      round(
        last.close,
        5
      ),

    entryTime:
      schedule.entryTime,

    expiryTime:
      schedule.expiryTime,

    entryInSeconds:
      schedule.entryInSeconds,

    support:
      round(
        sr.support,
        5
      ),

    resistance:
      round(
        sr.resistance,
        5
      ),

    ema9:
      round(
        ema9Value,
        5
      ),

    ema21:
      round(
        ema21Value,
        5
      ),

    rsi:
      round(
        rsiValue,
        2
      ),

    adx:
      round(
        adxValue,
        2
      ),

    atr:
      round(
        atrValue,
        5
      ),

    candlestick:
      candle.name,

    candlestickDirection:
      candle.direction,

    priceAction:
      pa.text,

    priceActionCall:
      pa.call,

    priceActionPut:
      pa.put,

    location,

    freshness:
      {
        fresh,
        ageSeconds
      },

    candlesUsed:
      tfCandles.length,

    lastCandle:
      last.time,

    reasons:
      reasonList,

    generatedAt:
      new Date().toISOString()
  };
}


/* =========================================================
   RANK RESULTS
   ========================================================= */

function rankResult(result) {

  if (!result) {
    return -Infinity;
  }


  let score =
    Number(
      result.confidence || 0
    );


  if (
    result.signal === "CALL" ||
    result.signal === "PUT"
  ) {

    score += 25;
  }


  if (
    result.freshness?.fresh
  ) {

    score += 15;
  }


  if (
    Number(result.adx) >= 25
  ) {

    score += 8;
  }


  score +=
    Math.min(
      20,
      Number(
        result.difference || 0
      )
    );


  return score;
}


/* =========================================================
   CACHE RESULT
   ========================================================= */

function cacheResult(
  pair,
  result
) {

  if (!result) {
    return;
  }


  cache.set(
    pair,
    {
      pair,
      result,
      savedAt:
        Date.now()
    }
  );
}


/* =========================================================
   CLEAN CACHE
   ========================================================= */

function cleanupCache() {

  const now =
    Date.now();


  for (
    const [
      pair,
      item
    ] of cache
  ) {

    if (
      now -
        item.savedAt >
      CACHE_RETENTION_SECONDS *
        1000
    ) {

      cache.delete(pair);
    }
  }
}


/* =========================================================
   BEST FROM CACHE
   ========================================================= */

function bestFromCache(
  signalOnly = false
) {

  cleanupCache();


  const results = [];


  for (
    const item of cache.values()
  ) {

    if (!item?.result) {
      continue;
    }


    const result =
      item.result;


    if (
      !result.freshness?.fresh
    ) {
      continue;
    }


    if (
      signalOnly &&
      !(
        result.signal === "CALL" ||
        result.signal === "PUT"
      )
    ) {
      continue;
    }


    results.push(result);
  }


  if (!results.length) {
    return null;
  }


  results.sort(
    (a, b) =>
      rankResult(b) -
      rankResult(a)
  );


  return results[0];
}


/* =========================================================
   SCAN BATCH
   ========================================================= */

async function scanBatch() {

  resetDailyBudgetIfNeeded();


  if (
    scanner.running
  ) {

    return {
      ok: false,
      skipped: true,
      reason: "scan_already_running"
    };
  }


  if (
    scanner.quotaBlocked
  ) {

    return {
      ok: false,
      skipped: true,
      reason: "daily_quota_blocked"
    };
  }


  scanner.running = true;
  scanner.lastScanError = null;


  const batch = [];


  for (
    let i = 0;
    i < SCAN_BATCH_SIZE;
    i++
  ) {

    const index =
      (
        scanner.cursor +
        i
      ) % PAIRS.length;


    batch.push(
      PAIRS[index]
    );
  }


  let scannedThisBatch = 0;
  let failedThisBatch = 0;


  try {

    for (
      const pair of batch
    ) {

      if (
        !canUseApiCredit()
      ) {

        break;
      }


      try {

        const candles =
          await fetchCandles(
            pair
          );


        for (
          const timeframe of TIMEFRAMES
        ) {

          const result =
            analyzeCandles(
              pair,
              timeframe,
              candles
            );


          if (result) {

            cacheResult(
              pair,
              result
            );
          }
        }


        scanner.totalScanned++;
        scannedThisBatch++;


        failedPairs.delete(
          pair
        );


      } catch (error) {

        scanner.totalFailed++;
        failedThisBatch++;


        const message =
          error?.message ||
          String(error);


        failedPairs.set(
          pair,
          {
            pair,
            error: message,
            at:
              new Date().toISOString()
          }
        );


        scanner.lastScanError =
          message;


        /*
          Critical:
          once daily quota is detected,
          STOP immediately.
        */

        if (
          isQuotaError(message) ||
          scanner.quotaBlocked
        ) {

          blockQuota(
            message
          );

          break;
        }
      }
    }


    scanner.cursor =
      (
        scanner.cursor +
        batch.length
      ) % PAIRS.length;


    scanner.lastScanAt =
      new Date().toISOString();


    return {
      ok: true,

      scanned:
        scannedThisBatch,

      failed:
        failedThisBatch,

      batch,

      cursor:
        scanner.cursor,

      quotaBlocked:
        scanner.quotaBlocked
    };


  } finally {

    scanner.running = false;
  }
}


/* =========================================================
   SCANNER RESPONSE
   ========================================================= */

function scannerState() {

  resetDailyBudgetIfNeeded();

  cleanupCache();


  const cachedPairs =
    cache.size;


  let cachedResults = 0;


  for (
    const item of cache.values()
  ) {

    if (
      item?.result
    ) {
      cachedResults++;
    }
  }


  const freshSignal =
    bestFromCache(true);


  const freshAny =
    bestFromCache(false);


  return {

    scanRunning:
      scanner.running,

    scanCursor:
      scanner.cursor,

    scanBatchSize:
      SCAN_BATCH_SIZE,

    scanEveryMs:
      SCAN_EVERY_MS,

    lastScanAt:
      scanner.lastScanAt,

    lastScanError:
      scanner.lastScanError,

    totalScanned:
      scanner.totalScanned,

    totalFailed:
      scanner.totalFailed,

    totalApiRequests:
      scanner.totalApiRequests,

    cachedPairs,

    cachedResults,

    best:
      freshAny,

    bestSignal:
      freshSignal,

    failedPairs:
      Array.from(
        failedPairs.values()
      ).slice(-10),

    apiBudget: {

      dailyLimit:
        DAILY_CREDIT_LIMIT,

      safetyReserve:
        DAILY_SAFETY_RESERVE,

      maxDailyRequests:
        MAX_DAILY_REQUESTS,

      dailyRequests:
        scanner.dailyRequests,

      dailyCreditsUsed:
        scanner.dailyCreditsUsed,

      dailyCreditsLeft:
        scanner.dailyCreditsLeft,

      quotaBlocked:
        scanner.quotaBlocked,

      quotaBlockedAt:
        scanner.quotaBlockedAt,

      quotaResetAt:
        scanner.quotaResetAt
    },

    time:
      new Date().toISOString()
  };
}


/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    resetDailyBudgetIfNeeded();

    cleanupCache();


    res.json({

      ok: true,

      version:
        VERSION,

      source:
        SOURCE,

      timezone:
        TIMEZONE,

      pairs:
        PAIRS.length,

      supportedTimeframes:
        TIMEFRAMES,

      cachedPairs:
        cache.size,

      cachedResults:
        Array.from(
          cache.values()
        ).filter(
          x => x?.result
        ).length,

      scanRunning:
        scanner.running,

      scanCursor:
        scanner.cursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      scanEveryMinutes:
        SCAN_EVERY_MS /
        60000,

      lastScanAt:
        scanner.lastScanAt,

      lastScanError:
        scanner.lastScanError,

      totalScanned:
        scanner.totalScanned,

      totalFailed:
        scanner.totalFailed,

      totalApiRequests:
        scanner.totalApiRequests,

      apiBudget: {

        dailyLimit:
          DAILY_CREDIT_LIMIT,

        safetyReserve:
          DAILY_SAFETY_RESERVE,

        maxDailyRequests:
          MAX_DAILY_REQUESTS,

        dailyRequests:
          scanner.dailyRequests,

        dailyCreditsUsed:
          scanner.dailyCreditsUsed,

        dailyCreditsLeft:
          scanner.dailyCreditsLeft,

        quotaBlocked:
          scanner.quotaBlocked,

        quotaResetAt:
          scanner.quotaResetAt
      },

      time:
        new Date().toISOString()
    });
  }
);


/* =========================================================
   SCANNER ENDPOINT
   ========================================================= */

app.get(
  "/api/scanner",
  (req, res) => {

    res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      ...scannerState()
    });
  }
);


/* =========================================================
   MAIN ANALYZE ENDPOINT
   ========================================================= */

app.get(
  "/api/analyze",
  async (req, res) => {

    resetDailyBudgetIfNeeded();
    cleanupCache();


    /*
      1. Fresh signal already cached.
    */

    const cachedSignal =
      bestFromCache(true);


    if (cachedSignal) {

      return res.json({

        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        mode:
          "CACHE",

        best:
          cachedSignal,

        scanner:
          scannerState(),

        time:
          new Date().toISOString()
      });
    }


    /*
      2. If no signal, try existing fresh result.
    */

    const cachedAny =
      bestFromCache(false);


    if (cachedAny) {

      return res.json({

        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        mode:
          "CACHE_NO_SIGNAL",

        best:
          cachedAny,

        scanner:
          scannerState(),

        time:
          new Date().toISOString()
      });
    }


    /*
      3. If daily quota is blocked, do NOT call Twelve Data.
    */

    if (
      scanner.quotaBlocked
    ) {

      return res.status(503).json({

        ok: false,

        version:
          VERSION,

        error:
          "Live data quota is currently exhausted. Scanner is safely paused until the next UTC reset.",

        quotaBlocked:
          true,

        quotaResetAt:
          scanner.quotaResetAt,

        scanner:
          scannerState(),

        time:
          new Date().toISOString()
      });
    }


    /*
      4. Perform one controlled batch.
    */

    await scanBatch();


    /*
      5. Select the strongest fresh signal.
    */

    const freshSignal =
      bestFromCache(true);


    if (freshSignal) {

      return res.json({

        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        mode:
          "SCAN",

        best:
          freshSignal,

        scanner:
          scannerState(),

        time:
          new Date().toISOString()
      });
    }


    /*
      6. Maybe we have a fresh NO TRADE result.
    */

    const freshAny =
      bestFromCache(false);


    if (freshAny) {

      return res.json({

        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        mode:
          "SCAN_NO_SIGNAL",

        best:
          freshAny,

        scanner:
          scannerState(),

        time:
          new Date().toISOString()
      });
    }


    /*
      7. Nothing fresh.
    */

    const message =
      scanner.quotaBlocked

        ? "Live data quota is exhausted. Scanner is paused until the next UTC reset."

        : "No fresh market analysis available yet. Scanner is waiting for valid live data.";


    return res.status(503).json({

      ok: false,

      version:
        VERSION,

      error:
        message,

      quotaBlocked:
        scanner.quotaBlocked,

      quotaResetAt:
        scanner.quotaResetAt,

      lastScanAt:
        scanner.lastScanAt,

      lastScanError:
        scanner.lastScanError,

      scanner:
        scannerState(),

      time:
        new Date().toISOString()
    });
  }
);


/* =========================================================
   ANALYZE SPECIFIC PAIR
   ========================================================= */

app.get(
  "/api/analyze/:pair",
  async (req, res) => {

    const pair =
      decodeURIComponent(
        req.params.pair
      );


    if (
      !PAIRS.includes(pair)
    ) {

      return res.status(400).json({

        ok: false,

        error:
          `Unsupported pair: ${pair}`,

        supportedPairs:
          PAIRS
      });
    }


    resetDailyBudgetIfNeeded();


    /*
      Use fresh cache first.
    */

    const cached =
      cache.get(pair);


    if (
      cached?.result &&
      cached.result.freshness?.fresh
    ) {

      return res.json({

        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        mode:
          "CACHE",

        pair,

        best:
          cached.result,

        results:
          [cached.result],

        time:
          new Date().toISOString()
      });
    }


    /*
      Do not request if quota blocked.
    */

    if (
      scanner.quotaBlocked
    ) {

      return res.status(503).json({

        ok: false,

        error:
          "Twelve Data daily quota is exhausted.",

        quotaResetAt:
          scanner.quotaResetAt
      });
    }


    try {

      const candles =
        await fetchCandles(
          pair
        );


      const results = [];


      for (
        const timeframe of TIMEFRAMES
      ) {

        const result =
          analyzeCandles(
            pair,
            timeframe,
            candles
          );


        if (result) {

          results.push(
            result
          );
        }
      }


      if (
        !results.length
      ) {

        return res.status(503).json({

          ok: false,

          error:
            "Unable to create valid analysis from current candles."
        });
      }


      results.sort(
        (a, b) =>
          rankResult(b) -
          rankResult(a)
      );


      const best =
        results[0];


      cacheResult(
        pair,
        best
      );


      res.json({

        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        mode:
          "PAIR",

        pair,

        best,

        results,

        time:
          new Date().toISOString()
      });


    } catch (error) {

      const message =
        error?.message ||
        String(error);


      if (
        isQuotaError(message)
      ) {

        blockQuota(
          message
        );
      }


      res.status(503).json({

        ok: false,

        pair,

        error:
          message,

        quotaBlocked:
          scanner.quotaBlocked,

        quotaResetAt:
          scanner.quotaResetAt
      });
    }
  }
);


/* =========================================================
   ROOT
   ========================================================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      ok: true,

      name:
        "PO AI Predictor API",

      version:
        VERSION,

      source:
        SOURCE,

      timezone:
        TIMEZONE,

      status:
        scanner.quotaBlocked
          ? "QUOTA_PAUSED"
          : "ONLINE",

      endpoints: [
        "/api/health",
        "/api/scanner",
        "/api/analyze",
        "/api/analyze/:pair"
      ],

      time:
        new Date().toISOString()
    });
  }
);


/* =========================================================
   404
   ========================================================= */

app.use(
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "Endpoint not found.",

      path:
        req.path
    });
  }
);


/* =========================================================
   GLOBAL ERROR HANDLER
   ========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "[GLOBAL ERROR]",
      error
    );


    if (
      res.headersSent
    ) {
      return next(error);
    }


    res.status(500).json({

      ok: false,

      version:
        VERSION,

      error:
        "Internal server error."
    });
  }
);


/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
  PORT,
  () => {

    scanner.quotaResetAt =
      getNextUtcMidnight()
        .toISOString();


    console.log(
      "================================================="
    );

    console.log(
      `PO AI PREDICTOR ${VERSION}`
    );

    console.log(
      `Source: ${SOURCE}`
    );

    console.log(
      `Timezone: ${TIMEZONE}`
    );

    console.log(
      `Pairs: ${PAIRS.length}`
    );

    console.log(
      `Timeframes: ${TIMEFRAMES.join(", ")}`
    );

    console.log(
      `Daily limit: ${DAILY_CREDIT_LIMIT}`
    );

    console.log(
      `Safety reserve: ${DAILY_SAFETY_RESERVE}`
    );

    console.log(
      `Max daily requests: ${MAX_DAILY_REQUESTS}`
    );

    console.log(
      `Scan batch: ${SCAN_BATCH_SIZE}`
    );

    console.log(
      `Scan interval: ${SCAN_EVERY_MS / 60000} minutes`
    );

    console.log(
      `Next UTC reset: ${scanner.quotaResetAt}`
    );

    console.log(
      "================================================="
    );
  }
);


/* =========================================================
   AUTOMATIC SCANNER
   ========================================================= */

/*
   Start after a short delay so Render has time to boot.
*/

setTimeout(
  async () => {

    try {

      await scanBatch();

    } catch (error) {

      console.error(
        "[INITIAL SCAN ERROR]",
        error
      );
    }

  },
  5000
);


/*
   Rotate through the 24 supported pairs.

   IMPORTANT:
   This interval is intentionally 15 minutes so the
   free 800/day quota is not consumed immediately.
*/

setInterval(
  async () => {

    resetDailyBudgetIfNeeded();


    if (
      scanner.quotaBlocked
    ) {

      return;
    }


    if (
      scanner.running
    ) {

      return;
    }


    try {

      await scanBatch();

    } catch (error) {

      console.error(
        "[SCHEDULED SCAN ERROR]",
        error
      );
    }

  },
  SCAN_EVERY_MS
);


/* =========================================================
   PERIODIC DAILY RESET CHECK
   ========================================================= */

setInterval(
  () => {

    resetDailyBudgetIfNeeded();

  },
  60 * 1000
);
