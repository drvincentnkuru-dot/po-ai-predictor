const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

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

const MAX_CANDLES = 180;
const MIN_CANDLES = 60;

const SCAN_BATCH_SIZE = 8;
const SCAN_EVERY_MS = 60000;

const ENTRY_BUFFER_SECONDS = 30;

const cache = new Map();

let scanCursor = 0;
let scanRunning = false;
let lastScanAt = null;
let lastScanError = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* =========================
   TWELVE DATA
========================= */

async function fetchCandles(pair) {

  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set(
    "symbol",
    pair
  );

  url.searchParams.set(
    "interval",
    "1min"
  );

  url.searchParams.set(
    "outputsize",
    String(MAX_CANDLES)
  );

  url.searchParams.set(
    "order",
    "ASC"
  );

  url.searchParams.set(
    "apikey",
    TWELVE_DATA_API_KEY
  );

  const response = await fetch(url);

  const data = await response.json();

  if (
    !response.ok ||
    data.status === "error" ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      data.message ||
      `Twelve Data HTTP ${response.status}`
    );
  }

  return data.values
    .map(item => ({
      datetime: item.datetime,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close)
    }))
    .filter(candle =>
      [
        candle.open,
        candle.high,
        candle.low,
        candle.close
      ].every(Number.isFinite)
    );
}


/* =========================
   EMA
========================= */

function ema(values, period) {

  if (values.length < period) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (sum, value) => sum + value,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}


/* =========================
   RSI
========================= */

function rsi(values, period = 14) {

  if (values.length <= period) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const difference =
      values[i] - values[i - 1];

    if (difference >= 0) {
      gain += difference;
    } else {
      loss -= difference;
    }
  }

  let averageGain =
    gain / period;

  let averageLoss =
    loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const difference =
      values[i] - values[i - 1];

    const currentGain =
      Math.max(difference, 0);

    const currentLoss =
      Math.max(-difference, 0);

    averageGain =
      (
        averageGain * (period - 1) +
        currentGain
      ) / period;

    averageLoss =
      (
        averageLoss * (period - 1) +
        currentLoss
      ) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const relativeStrength =
    averageGain / averageLoss;

  return 100 -
    (
      100 /
      (1 + relativeStrength)
    );
}


/* =========================
   ADX
========================= */

function adx(candles, period = 14) {

  if (
    candles.length <
    period * 2 + 2
  ) {
    return null;
  }

  const trueRanges = [];
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

    const trueRange =
      Math.max(
        current.high - current.low,
        Math.abs(
          current.high -
          previous.close
        ),
        Math.abs(
          current.low -
          previous.close
        )
      );

    trueRanges.push(trueRange);

    const upMove =
      current.high -
      previous.high;

    const downMove =
      previous.low -
      current.low;

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

  let averageTR =
    trueRanges
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  let averagePlusDM =
    plusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  let averageMinusDM =
    minusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  const dx = [];

  for (
    let i = period;
    i < trueRanges.length;
    i++
  ) {

    averageTR =
      (
        averageTR * (period - 1) +
        trueRanges[i]
      ) / period;

    averagePlusDM =
      (
        averagePlusDM * (period - 1) +
        plusDM[i]
      ) / period;

    averageMinusDM =
      (
        averageMinusDM * (period - 1) +
        minusDM[i]
      ) / period;

    const plusDI =
      averageTR
        ? 100 * averagePlusDM / averageTR
        : 0;

    const minusDI =
      averageTR
        ? 100 * averageMinusDM / averageTR
        : 0;

    const currentDX =
      (
        plusDI + minusDI
      )
        ? 100 *
          Math.abs(
            plusDI - minusDI
          ) /
          (plusDI + minusDI)
        : 0;

    dx.push(currentDX);
  }

  if (dx.length < period) {
    return null;
  }

  let result =
    dx
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < dx.length;
    i++
  ) {

    result =
      (
        result * (period - 1) +
        dx[i]
      ) / period;
  }

  return result;
}


/* =========================
   TIMEFRAME AGGREGATION
========================= */

function aggregate(candles, minutes) {

  if (minutes === 1) {
    return candles.slice();
  }

  const output = [];
  const buckets = new Map();

  for (const candle of candles) {

    const timestamp =
      new Date(
        candle.datetime
          .replace(" ", "T") + "Z"
      ).getTime();

    const bucket =
      Math.floor(
        timestamp /
        (minutes * 60000)
      ) *
      minutes *
      60000;

    if (!buckets.has(bucket)) {
      buckets.set(bucket, []);
    }

    buckets
      .get(bucket)
      .push(candle);
  }

  for (
    const [bucket, values]
    of buckets
  ) {

    if (
      values.length < minutes
    ) {
      continue;
    }

    output.push({

      datetime:
        new Date(bucket)
          .toISOString()
          .slice(0, 16)
          .replace("T", " "),

      open:
        values[0].open,

      high:
        Math.max(
          ...values.map(
            x => x.high
          )
        ),

      low:
        Math.min(
          ...values.map(
            x => x.low
          )
        ),

      close:
        values[values.length - 1]
          .close
    });
  }

  return output;
}


/* =========================
   SUPPORT / RESISTANCE
========================= */

function levels(candles) {

  const count =
    Math.min(
      30,
      candles.length - 1
    );

  const previous =
    candles.slice(
      -count - 1,
      -1
    );

  return {

    support:
      Math.min(
        ...previous.map(
          candle => candle.low
        )
      ),

    resistance:
      Math.max(
        ...previous.map(
          candle => candle.high
        )
      )
  };
}


/* =========================
   PRICE DIGITS
========================= */

function digits(pair) {

  return pair.includes("JPY")
    ? 3
    : 5;
}

function round(
  number,
  precision = 5
) {

  const multiplier =
    10 ** precision;

  return (
    Math.round(
      number * multiplier
    ) / multiplier
  );
}


/* =========================
   MARKET ANALYSIS
========================= */

function analyze(
  pair,
  candles,
  timeframe
) {

  const aggregated =
    aggregate(
      candles,
      timeframe
    );

  if (
    aggregated.length <
    MIN_CANDLES
  ) {
    return null;
  }

  const closes =
    aggregated.map(
      candle => candle.close
    );

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const rsi14 =
    rsi(closes, 14);

  const adx14 =
    adx(
      aggregated,
      14
    );

  const {
    support,
    resistance
  } =
    levels(aggregated);

  const currentPrice =
    closes.at(-1);

  const previousPrice =
    closes.at(-2);

  const range =
    Math.max(
      resistance - support,
      Number.EPSILON
    );

  const nearSupport =
    (
      currentPrice -
      support
    ) / range;

  const nearResistance =
    (
      resistance -
      currentPrice
    ) / range;

  let callScore = 0;
  let putScore = 0;

  const reasons = [];


  /* EMA TREND */

  if (
    ema9 > ema21
  ) {

    callScore += 28;

    reasons.push(
      "EMA trend bullish"
    );

  } else if (
    ema9 < ema21
  ) {

    putScore += 28;

    reasons.push(
      "EMA trend bearish"
    );
  }


  /* RSI */

  if (
    rsi14 > 52
  ) {

    callScore += 18;

    reasons.push(
      "RSI bullish momentum"
    );

  } else if (
    rsi14 < 48
  ) {

    putScore += 18;

    reasons.push(
      "RSI bearish momentum"
    );
  }


  /* ADX */

  if (
    adx14 >= 25
  ) {

    const bullish =
      ema9 > ema21;

    const bearish =
      ema9 < ema21;

    if (bullish) {

      callScore += 22;

      reasons.push(
        "ADX confirms trend strength"
      );

    }

    if (bearish) {

      putScore += 22;

      reasons.push(
        "ADX confirms trend strength"
      );
    }

  } else {

    reasons.push(
      "ADX trend strength is weak"
    );
  }


  /* SUPPORT */

  if (
    nearSupport <= 0.22 &&
    currentPrice >= previousPrice
  ) {

    callScore += 20;

    reasons.push(
      "price near support"
    );
  }


  /* RESISTANCE */

  if (
    nearResistance >= 0.78 &&
    currentPrice <= previousPrice
  ) {

    putScore += 20;

    reasons.push(
      "price near resistance"
    );
  }


  /* PRICE + EMA CONFIRMATION */

  if (
    currentPrice > ema9 &&
    ema9 > ema21
  ) {

    callScore += 12;
  }

  if (
    currentPrice < ema9 &&
    ema9 < ema21
  ) {

    putScore += 12;
  }


  /* SIGNAL DECISION */

  const total =
    Math.max(
      callScore,
      putScore
    );

  const difference =
    Math.abs(
      callScore -
      putScore
    );

  let signal =
    "NO TRADE";

  if (
    total >= 65 &&
    difference >= 15
  ) {

    signal =
      callScore > putScore
        ? "CALL"
        : "PUT";
  }


  /* CONFIDENCE */

  const confidence =
    signal === "NO TRADE"

      ? Math.max(
          40,
          Math.min(
            69,
            Math.round(total)
          )
        )

      : Math.min(
          95,
          Math.max(
            70,
            Math.round(total)
          )
        );


  /* ENTRY / EXPIRY */

  const now =
    new Date();

  const step =
    timeframe * 60000;

  let entry =
    Math.ceil(
      now.getTime() /
      step
    ) * step;

  const secondsUntilEntry =
    entry -
    now.getTime();

  if (
    secondsUntilEntry <
    ENTRY_BUFFER_SECONDS * 1000
  ) {

    entry += step;
  }

  const expiry =
    entry + step;


  return {

    pair,

    timeframe,

    signal,

    confidence,

    callScore:
      Math.round(
        callScore
      ),

    putScore:
      Math.round(
        putScore
      ),

    entryTime:
      new Date(
        entry
      ).toISOString(),

    expiryTime:
      new Date(
        expiry
      ).toISOString(),

    entryPrice:
      round(
        currentPrice,
        digits(pair)
      ),

    support:
      round(
        support,
        digits(pair)
      ),

    resistance:
      round(
        resistance,
        digits(pair)
      ),

    ema9:
      round(
        ema9,
        digits(pair)
      ),

    ema21:
      round(
        ema21,
        digits(pair)
      ),

    rsi:
      round(
        rsi14,
        2
      ),

    adx:
      round(
        adx14,
        2
      ),

    trend:
      ema9 > ema21
        ? "UPTREND"
        : ema9 < ema21
          ? "DOWNTREND"
          : "RANGE",

    candlesUsed:
      aggregated.length,

    lastCandle:
      aggregated.at(-1)
        ?.datetime || null,

    reasons:
      reasons.slice(0, 5),

    generatedAt:
      now.toISOString()
  };
}


/* =========================
   RANKING
========================= */

function rank(analysis) {

  if (!analysis) {
    return -Infinity;
  }

  const signalBonus =
    analysis.signal === "NO TRADE"
      ? 0
      : 25;

  return (
    analysis.confidence +
    signalBonus +
    Math.abs(
      analysis.callScore -
      analysis.putScore
    ) * 0.25 +
    (
      analysis.adx >= 25
        ? 8
        : 0
    )
  );
}


/* =========================
   BEST MARKET
========================= */

function bestFromCache() {

  const all = [];

  for (
    const item
    of cache.values()
  ) {

    for (
      const timeframe
      of TIMEFRAMES
    ) {

      const analysis =
        analyze(
          item.pair,
          item.candles,
          timeframe
        );

      if (analysis) {
        all.push(
          analysis
        );
      }
    }
  }

  all.sort(
    (a, b) =>
      rank(b) -
      rank(a)
  );

  return {

    best:
      all[0] || null,

    candidates:
      all.slice(0, 12)
  };
}


/* =========================
   SCANNER
========================= */

async function scanBatch() {

  if (scanRunning) {
    return;
  }

  scanRunning = true;

  lastScanError = null;

  const batch =
    PAIRS.slice(
      scanCursor,
      scanCursor +
      SCAN_BATCH_SIZE
    );

  scanCursor =
    (
      scanCursor +
      SCAN_BATCH_SIZE
    ) %
    PAIRS.length;

  try {

    for (
      const pair
      of batch
    ) {

      try {

        const candles =
          await fetchCandles(
            pair
          );

        cache.set(
          pair,
          {
            pair,
            candles,
            updatedAt:
              new Date()
                .toISOString()
          }
        );

      } catch (error) {

        lastScanError =
          `${pair}: ${error.message}`;
      }

      await sleep(150);
    }

    lastScanAt =
      new Date()
        .toISOString();

  } finally {

    scanRunning = false;
  }
}


/* =========================
   HEALTH
========================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      ok: true,

      version: "V8",

      source:
        "Twelve Data LIVE",

      pairs:
        PAIRS.length,

      cachedPairs:
        cache.size,

      scanRunning,

      lastScanAt,

      lastScanError
    });
  }
);


/* =========================
   ANALYZE API
========================= */

app.get(
  "/api/analyze",
  async (req, res) => {

    if (
      !TWELVE_DATA_API_KEY
    ) {

      return res
        .status(500)
        .json({
          error:
            "TWELVE_DATA_API_KEY is not configured"
        });
    }


    /* First scan */

    if (
      cache.size === 0
    ) {

      await scanBatch();

    } else if (
      !scanRunning
    ) {

      scanBatch()
        .catch(() => {});
    }


    const result =
      bestFromCache();


    if (
      !result.best
    ) {

      return res
        .status(503)
        .json({
          error:
            "No usable live data yet. Try again in a few seconds."
        });
    }


    res.json({

      version:
        "V8",

      source:
        "Twelve Data LIVE",

      selected:
        result.best,

      candidates:
        result.candidates,

      scannedPairs:
        PAIRS.length,

      cachedPairs:
        cache.size,

      serverTime:
        new Date()
          .toISOString()
    });
  }
);


/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  () => {

    console.log(
      `PO AI Predictor V8 running on ${PORT}`
    );
  }
);
