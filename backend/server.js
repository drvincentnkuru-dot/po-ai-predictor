const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const VERSION = "V8.3.2";
const SOURCE = "Twelve Data LIVE";
const TIMEZONE = "UTC";

const API_KEY = process.env.TWELVE_DATA_API_KEY || "";

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

const FETCH_TIMEOUT_MS = 12000;
const REQUEST_DELAY_MS = 150;

const ENTRY_BUFFER_SECONDS = 30;

const MAX_DATA_AGE_SECONDS = 90;
const HARD_STALE_SECONDS = 180;

const SUPPORT_RISK_ATR_MULTIPLIER = 0.75;
const RESISTANCE_RISK_ATR_MULTIPLIER = 0.75;
const MIN_SR_RANGE_ATR_MULTIPLIER = 1.20;

const cache = new Map();

let scanCursor = 0;
let scanRunning = false;
let lastScanAt = null;
let lastScanError = null;
let totalScanned = 0;


/* =========================================================
   BASIC HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

function normalizePair(pair) {
  return String(pair || "")
    .trim()
    .toUpperCase()
    .replace("-", "/")
    .replace("_", "/");
}

function pairKey(pair) {
  return normalizePair(pair).replace("/", "");
}

function cacheKey(pair, timeframe) {
  return `${normalizePair(pair)}_${timeframe}`;
}


/* =========================================================
   TIME
========================================================= */

function floorMinute(ms) {
  return Math.floor(ms / 60000) * 60000;
}

function nextEntryTime(timeframe, minimumBufferSeconds = ENTRY_BUFFER_SECONDS) {
  const now = nowMs();

  const tfMs = timeframe * 60000;

  let next =
    Math.floor(now / tfMs) * tfMs + tfMs;

  const minimum = now + minimumBufferSeconds * 1000;

  while (next < minimum) {
    next += tfMs;
  }

  return next;
}

function buildEntryExpiry(timeframe) {
  const entryMs = nextEntryTime(timeframe);
  const expiryMs = entryMs + timeframe * 60000;

  return {
    entryTime: new Date(entryMs).toISOString(),
    expiryTime: new Date(expiryMs).toISOString(),
    entryInSeconds: Math.max(
      0,
      Math.ceil((entryMs - nowMs()) / 1000)
    )
  };
}

function parseTimeMs(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : null;
}


/* =========================================================
   CACHE VALIDATION
========================================================= */

function isResultFresh(result) {
  if (!result) return false;

  if (result.freshness?.stale === true) {
    return false;
  }

  const generatedMs = parseTimeMs(result.generatedAt);

  if (!generatedMs) return false;

  const ageSeconds = (nowMs() - generatedMs) / 1000;

  if (ageSeconds > HARD_STALE_SECONDS) {
    return false;
  }

  return true;
}

function isEntryStillValid(result) {
  if (!result) return false;

  const entryMs = parseTimeMs(result.entryTime);

  if (!entryMs) return false;

  const now = nowMs();

  /*
   * Once entry time has arrived, this signal is no longer
   * valid for a future entry.
   */
  if (now >= entryMs) {
    return false;
  }

  /*
   * Recalculate remaining time from server UTC clock.
   */
  result.entryInSeconds = Math.max(
    0,
    Math.ceil((entryMs - now) / 1000)
  );

  return true;
}

function isUsableCachedResult(result) {
  return (
    result &&
    isResultFresh(result) &&
    isEntryStillValid(result)
  );
}

function cleanupExpiredCache() {
  for (const [key, value] of cache.entries()) {
    if (!isUsableCachedResult(value)) {
      cache.delete(key);
    }
  }
}


/* =========================================================
   FETCH TWELVE DATA
========================================================= */

async function fetchCandles(pair) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is not configured");
  }

  const symbol = encodeURIComponent(pairKey(pair));

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${symbol}` +
    `&interval=1min` +
    `&outputsize=${MAX_CANDLES}` +
    `&order=ASC` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `Twelve Data HTTP ${response.status}`
      );
    }

    const json = await response.json();

    if (json.status === "error") {
      throw new Error(
        json.message || "Twelve Data returned an error"
      );
    }

    if (!Array.isArray(json.values)) {
      throw new Error("No candle values returned");
    }

    const currentNow = nowMs();

    const candles = json.values
      .map(c => {
        const time = Date.parse(`${c.datetime}Z`);

        return {
          time,
          datetime: new Date(time).toISOString(),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 0)
        };
      })
      .filter(c =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.time <= currentNow - 1000
      )
      .sort((a, b) => a.time - b.time)
      .slice(-MAX_CANDLES);

    if (candles.length < MIN_CANDLES) {
      throw new Error(
        `Not enough completed candles: ${candles.length}`
      );
    }

    return candles;

  } finally {
    clearTimeout(timeout);
  }
}


/* =========================================================
   AGGREGATION
========================================================= */

function aggregateCandles(candles, timeframe) {
  if (timeframe === 1) {
    return candles.slice();
  }

  const tfMs = timeframe * 60000;
  const groups = new Map();

  for (const candle of candles) {
    const bucket = Math.floor(candle.time / tfMs) * tfMs;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups.get(bucket).push(candle);
  }

  const output = [];

  for (const [bucket, group] of groups.entries()) {
    if (group.length !== timeframe) {
      continue;
    }

    group.sort((a, b) => a.time - b.time);

    const first = group[0];
    const last = group[group.length - 1];

    output.push({
      time: bucket,
      datetime: new Date(bucket).toISOString(),
      open: first.open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: last.close,
      volume: group.reduce(
        (sum, c) => sum + (c.volume || 0),
        0
      )
    });
  }

  return output
    .sort((a, b) => a.time - b.time)
    .slice(-MAX_CANDLES);
}


/* =========================================================
   INDICATORS
========================================================= */

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain =
      (avgGain * (period - 1) + gain) / period;

    avgLoss =
      (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
  }

  if (trs.length < period) return null;

  let result =
    trs
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trs.length; i++) {
    result =
      (result * (period - 1) + trs[i]) / period;
  }

  return result;
}

function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) {
    return null;
  }

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const upMove =
      current.high - previous.high;

    const downMove =
      previous.low - current.low;

    plusDM.push(
      upMove > downMove && upMove > 0
        ? upMove
        : 0
    );

    minusDM.push(
      downMove > upMove && downMove > 0
        ? downMove
        : 0
    );

    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  if (trs.length < period * 2) {
    return null;
  }

  let trAvg =
    trs.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  let plusAvg =
    plusDM.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  let minusAvg =
    minusDM.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  const dxValues = [];

  for (let i = period; i < trs.length; i++) {
    trAvg =
      (trAvg * (period - 1) + trs[i]) / period;

    plusAvg =
      (plusAvg * (period - 1) + plusDM[i]) / period;

    minusAvg =
      (minusAvg * (period - 1) + minusDM[i]) / period;

    if (trAvg === 0) continue;

    const plusDI = 100 * plusAvg / trAvg;
    const minusDI = 100 * minusAvg / trAvg;

    const denominator =
      plusDI + minusDI;

    if (denominator === 0) continue;

    dxValues.push(
      100 *
      Math.abs(plusDI - minusDI) /
      denominator
    );
  }

  if (dxValues.length < period) {
    return null;
  }

  let adxValue =
    dxValues.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dxValues.length; i++) {
    adxValue =
      (adxValue * (period - 1) + dxValues[i]) /
      period;
  }

  return adxValue;
}


/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(candles) {
  const recent = candles.slice(-40);

  if (!recent.length) {
    return {
      support: null,
      resistance: null
    };
  }

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}


/* =========================================================
   CANDLE PATTERNS
========================================================= */

function candlePattern(candle, previous) {
  if (!candle) {
    return {
      name: "NONE",
      direction: "NONE",
      strength: 0
    };
  }

  const range =
    Math.max(candle.high - candle.low, 1e-12);

  const body =
    Math.abs(candle.close - candle.open);

  const upperWick =
    candle.high -
    Math.max(candle.open, candle.close);

  const lowerWick =
    Math.min(candle.open, candle.close) -
    candle.low;

  const bullish =
    candle.close > candle.open;

  const bearish =
    candle.close < candle.open;

  if (
    previous &&
    bullish &&
    previous.close < previous.open &&
    candle.open <= previous.close &&
    candle.close >= previous.open
  ) {
    return {
      name: "BULLISH ENGULFING",
      direction: "CALL",
      strength: 8
    };
  }

  if (
    previous &&
    bearish &&
    previous.close > previous.open &&
    candle.open >= previous.close &&
    candle.close <= previous.open
  ) {
    return {
      name: "BEARISH ENGULFING",
      direction: "PUT",
      strength: 8
    };
  }

  if (
    lowerWick > body * 2 &&
    upperWick < body &&
    candle.close > candle.low + range * 0.55
  ) {
    return {
      name: "HAMMER",
      direction: "CALL",
      strength: 6
    };
  }

  if (
    upperWick > body * 2 &&
    lowerWick < body &&
    candle.close < candle.low + range * 0.45
  ) {
    return {
      name: "SHOOTING STAR",
      direction: "PUT",
      strength: 6
    };
  }

  if (
    lowerWick > body * 1.8 &&
    lowerWick > upperWick * 1.5
  ) {
    return {
      name: "BULLISH PIN BAR",
      direction: "CALL",
      strength: 5
    };
  }

  if (
    upperWick > body * 1.8 &&
    upperWick > lowerWick * 1.5
  ) {
    return {
      name: "BEARISH PIN BAR",
      direction: "PUT",
      strength: 5
    };
  }

  if (body >= range * 0.70) {
    return {
      name: bullish ? "STRONG BULLISH CANDLE" : "STRONG BEARISH CANDLE",
      direction: bullish ? "CALL" : "PUT",
      strength: 5
    };
  }

  if (body <= range * 0.15) {
    return {
      name: "DOJI",
      direction: "NONE",
      strength: 0
    };
  }

  return {
    name: bullish ? "BULLISH CANDLE" : "BEARISH CANDLE",
    direction: bullish ? "CALL" : "PUT",
    strength: 2
  };
}


/* =========================================================
   PRICE ACTION
========================================================= */

function priceActionScore(candles, atrValue) {
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  if (!last || !previous || !atrValue) {
    return {
      call: 0,
      put: 0,
      description: "INSUFFICIENT PRICE ACTION"
    };
  }

  const range =
    Math.max(last.high - last.low, 1e-12);

  const body =
    Math.abs(last.close - last.open);

  const upper =
    last.high -
    Math.max(last.open, last.close);

  const lower =
    Math.min(last.open, last.close) -
    last.low;

  let call = 0;
  let put = 0;

  if (lower > upper * 1.5) {
    call += 8;
  }

  if (upper > lower * 1.5) {
    put += 8;
  }

  if (last.close > last.open) {
    call += 6;
  }

  if (last.close < last.open) {
    put += 6;
  }

  if (body > atrValue * 0.55) {
    if (last.close > last.open) call += 7;
    if (last.close < last.open) put += 7;
  }

  const previousBody =
    Math.abs(previous.close - previous.open);

  if (body > previousBody * 1.20) {
    if (last.close > last.open) call += 5;
    if (last.close < last.open) put += 5;
  }

  if (body <= range * 0.15) {
    call -= 5;
    put -= 5;
  }

  return {
    call: clamp(call, 0, 25),
    put: clamp(put, 0, 25),
    description:
      call > put
        ? "BULLISH PRICE ACTION"
        : put > call
          ? "BEARISH PRICE ACTION"
          : "MIXED PRICE ACTION"
  };
}


/* =========================================================
   TREND
========================================================= */

function classifyTrend(ema9, ema21, adxValue) {
  if (!ema9 || !ema21) {
    return "RANGING";
  }

  const difference =
    Math.abs(ema9 - ema21);

  if (ema9 > ema21) {
    if (adxValue >= 30) return "STRONG UPTREND";
    if (difference > 0) return "UPTREND";
  }

  if (ema9 < ema21) {
    if (adxValue >= 30) return "STRONG DOWNTREND";
    if (difference > 0) return "DOWNTREND";
  }

  return "RANGING";
}


/* =========================================================
   LOCATION FILTER
========================================================= */

function locationAnalysis(
  price,
  support,
  resistance,
  atrValue
) {
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(support) ||
    !Number.isFinite(resistance) ||
    !Number.isFinite(atrValue)
  ) {
    return {
      blocked: false,
      risk: "UNKNOWN",
      reason: "LOCATION DATA UNAVAILABLE"
    };
  }

  const distanceSupport =
    price - support;

  const distanceResistance =
    resistance - price;

  const totalRange =
    resistance - support;

  if (
    totalRange <
    atrValue * MIN_SR_RANGE_ATR_MULTIPLIER
  ) {
    return {
      blocked: true,
      risk: "HIGH",
      reason: "SUPPORT/RESISTANCE RANGE TOO NARROW"
    };
  }

  if (
    distanceSupport <
    atrValue * SUPPORT_RISK_ATR_MULTIPLIER
  ) {
    return {
      blocked: true,
      risk: "HIGH",
      reason: "PRICE TOO CLOSE TO SUPPORT"
    };
  }

  if (
    distanceResistance <
    atrValue * RESISTANCE_RISK_ATR_MULTIPLIER
  ) {
    return {
      blocked: true,
      risk: "HIGH",
      reason: "PRICE TOO CLOSE TO RESISTANCE"
    };
  }

  const supportRisk =
    distanceSupport < atrValue * 1.25;

  const resistanceRisk =
    distanceResistance < atrValue * 1.25;

  if (supportRisk || resistanceRisk) {
    return {
      blocked: false,
      risk: "MEDIUM",
      reason: supportRisk
        ? "MODERATE SUPPORT PROXIMITY"
        : "MODERATE RESISTANCE PROXIMITY"
    };
  }

  return {
    blocked: false,
    risk: "LOW",
    reason: "GOOD PRICE LOCATION"
  };
}


/* =========================================================
   ANALYSIS
========================================================= */

function analyzeCandles(pair, timeframe, rawCandles) {
  const candles =
    aggregateCandles(rawCandles, timeframe);

  if (candles.length < MIN_CANDLES / timeframe) {
    return null;
  }

  const closes =
    candles.map(c => c.close);

  const ema9Value =
    ema(closes, 9);

  const ema21Value =
    ema(closes, 21);

  const rsiValue =
    rsi(closes, 14);

  const atrValue =
    atr(candles, 14);

  const adxValue =
    adx(candles, 14);

  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const sr =
    supportResistance(candles);

  const pattern =
    candlePattern(last, previous);

  const pa =
    priceActionScore(candles, atrValue);

  const trend =
    classifyTrend(
      ema9Value,
      ema21Value,
      adxValue || 0
    );

  const lastCandleAgeSeconds =
    Math.max(
      0,
      (nowMs() - last.time) / 1000
    );

  const stale =
    lastCandleAgeSeconds >
    HARD_STALE_SECONDS;

  const dataFresh =
    lastCandleAgeSeconds <=
    MAX_DATA_AGE_SECONDS;

  const location =
    locationAnalysis(
      last.close,
      sr.support,
      sr.resistance,
      atrValue
    );

  let callScore = 0;
  let putScore = 0;

  /* EMA */
  if (
    Number.isFinite(ema9Value) &&
    Number.isFinite(ema21Value)
  ) {
    if (ema9Value > ema21Value) {
      callScore += 28;
    } else if (ema9Value < ema21Value) {
      putScore += 28;
    }
  }

  /* RSI */
  if (Number.isFinite(rsiValue)) {
    if (rsiValue >= 55 && rsiValue < 75) {
      callScore += 18;
    }

    if (rsiValue <= 45 && rsiValue > 25) {
      putScore += 18;
    }

    if (rsiValue < 25) {
      callScore += 10;
    }

    if (rsiValue > 75) {
      putScore += 10;
    }
  }

  /* ADX */
  if (Number.isFinite(adxValue)) {
    const adxBonus =
      clamp(adxValue / 50, 0, 1) * 22;

    if (
      ema9Value > ema21Value &&
      adxValue >= 20
    ) {
      callScore += adxBonus;
    }

    if (
      ema9Value < ema21Value &&
      adxValue >= 20
    ) {
      putScore += adxBonus;
    }
  }

  /* Price vs EMA */
  if (Number.isFinite(ema21Value)) {
    if (last.close > ema21Value) {
      callScore += 12;
    }

    if (last.close < ema21Value) {
      putScore += 12;
    }
  }

  /* S/R */
  if (
    Number.isFinite(sr.support) &&
    Number.isFinite(sr.resistance)
  ) {
    const midpoint =
      (sr.support + sr.resistance) / 2;

    if (last.close > midpoint) {
      callScore += 20;
    }

    if (last.close < midpoint) {
      putScore += 20;
    }
  }

  /* Candle pattern */
  if (pattern.direction === "CALL") {
    callScore += pattern.strength;
  }

  if (pattern.direction === "PUT") {
    putScore += pattern.strength;
  }

  /* Price action */
  callScore += pa.call;
  putScore += pa.put;

  callScore = clamp(Math.round(callScore), 0, 100);
  putScore = clamp(Math.round(putScore), 0, 100);

  const difference =
    Math.abs(callScore - putScore);

  let signal = "NO TRADE";

  if (
    callScore >= 65 &&
    difference >= 15
  ) {
    signal = "CALL";
  } else if (
    putScore >= 65 &&
    difference >= 15
  ) {
    signal = "PUT";
  }

  /*
   * Conflict filter
   */
  const strongOppositeCandle =
    (
      signal === "CALL" &&
      pattern.direction === "PUT" &&
      pattern.strength >= 6
    ) ||
    (
      signal === "PUT" &&
      pattern.direction === "CALL" &&
      pattern.strength >= 6
    );

  const strongOppositePA =
    (
      signal === "CALL" &&
      pa.put >= 12
    ) ||
    (
      signal === "PUT" &&
      pa.call >= 12
    );

  if (
    signal !== "NO TRADE" &&
    strongOppositeCandle &&
    strongOppositePA &&
    adxValue >= 30
  ) {
    signal = "NO TRADE";
  }

  /*
   * Location filter
   */
  if (
    signal !== "NO TRADE" &&
    location.blocked
  ) {
    signal = "NO TRADE";
  }

  /*
   * Freshness filter
   */
  if (!dataFresh || stale) {
    signal = "NO TRADE";
  }

  const schedule =
    buildEntryExpiry(timeframe);

  let confidence;

  if (signal === "CALL") {
    confidence = clamp(
      Math.round(
        50 +
        (callScore - 65) * 0.9 +
        difference * 0.35
      ),
      70,
      95
    );
  } else if (signal === "PUT") {
    confidence = clamp(
      Math.round(
        50 +
        (putScore - 65) * 0.9 +
        difference * 0.35
      ),
      70,
      95
    );
  } else {
    confidence = clamp(
      Math.round(
        Math.max(callScore, putScore) * 0.65
      ),
      40,
      69
    );
  }

  const reasons = [];

  if (signal === "CALL") {
    reasons.push("CALL conditions aligned");
  } else if (signal === "PUT") {
    reasons.push("PUT conditions aligned");
  } else {
    reasons.push(
      "Signals are not sufficiently aligned"
    );
  }

  if (location.reason) {
    reasons.push(location.reason);
  }

  if (pattern.name !== "NONE") {
    reasons.push(pattern.name);
  }

  if (!dataFresh) {
    reasons.push(
      `DATA AGE ${Math.round(lastCandleAgeSeconds)}s`
    );
  }

  if (stale) {
    reasons.push("HARD STALE DATA");
  }

  return {
    pair,
    timeframe,

    signal,
    confidence,

    trend,

    callScore,
    putScore,
    difference,

    entryPrice: round(last.close),

    entryTime: schedule.entryTime,
    expiryTime: schedule.expiryTime,
    entryInSeconds: schedule.entryInSeconds,

    support: round(sr.support),
    resistance: round(sr.resistance),

    ema9: round(ema9Value),
    ema21: round(ema21Value),

    rsi: round(rsiValue, 2),
    adx: round(adxValue, 2),
    atr: round(atrValue, 6),

    candlestick: pattern.name,
    candlestickDirection: pattern.direction,

    priceAction: pa.description,
    priceActionCall: pa.call,
    priceActionPut: pa.put,

    location,

    freshness: {
      stale,
      dataFresh,
      lastCandleAgeSeconds: Math.round(
        lastCandleAgeSeconds
      ),
      maxAgeSeconds: MAX_DATA_AGE_SECONDS,
      hardStaleSeconds: HARD_STALE_SECONDS
    },

    candlesUsed: candles.length,

    lastCandle: last.datetime,

    reasons,

    generatedAt: isoNow()
  };
}


/* =========================================================
   PAIR ANALYSIS
========================================================= */

async function analyzePair(pair) {
  const rawCandles =
    await fetchCandles(pair);

  const results = [];

  for (const timeframe of TIMEFRAMES) {
    const result =
      analyzeCandles(
        pair,
        timeframe,
        rawCandles
      );

    if (result) {
      cache.set(
        cacheKey(pair, timeframe),
        result
      );

      results.push(result);
    }
  }

  return results;
}


/* =========================================================
   RANKING
========================================================= */

function rankResult(result) {
  if (!result) return -Infinity;

  let score =
    Math.max(
      result.callScore || 0,
      result.putScore || 0
    );

  if (
    result.signal === "CALL" ||
    result.signal === "PUT"
  ) {
    score += 25;
  } else {
    score -= 15;
  }

  if ((result.adx || 0) >= 25) {
    score += 8;
  }

  if (
    result.candlestickDirection ===
    result.signal
  ) {
    score += 8;
  }

  if (
    result.signal === "CALL" &&
    (result.priceActionCall || 0) >
      (result.priceActionPut || 0)
  ) {
    score += 8;
  }

  if (
    result.signal === "PUT" &&
    (result.priceActionPut || 0) >
      (result.priceActionCall || 0)
  ) {
    score += 8;
  }

  if (result.location?.risk === "LOW") {
    score += 5;
  }

  if (result.freshness?.dataFresh) {
    score += 5;
  }

  if (result.location?.blocked) {
    score -= 30;
  }

  if (result.freshness?.stale) {
    score -= 50;
  }

  return score;
}

function bestFromCache(options = {}) {
  cleanupExpiredCache();

  const {
    signalOnly = false
  } = options;

  const usable = [];

  for (const result of cache.values()) {
    if (!isUsableCachedResult(result)) {
      continue;
    }

    if (
      signalOnly &&
      result.signal === "NO TRADE"
    ) {
      continue;
    }

    usable.push(result);
  }

  if (!usable.length) {
    return null;
  }

  usable.sort(
    (a, b) =>
      rankResult(b) - rankResult(a)
  );

  return usable[0];
}


/* =========================================================
   SCANNER
========================================================= */

async function scanBatch() {
  if (scanRunning) {
    return;
  }

  scanRunning = true;
  lastScanError = null;

  const startIndex = scanCursor;

  const selectedPairs =
    PAIRS.slice(
      startIndex,
      startIndex + SCAN_BATCH_SIZE
    );

  if (!selectedPairs.length) {
    scanCursor = 0;

    scanRunning = false;

    return;
  }

  try {
    for (const pair of selectedPairs) {
      try {
        await analyzePair(pair);

        totalScanned += 1;

      } catch (error) {
        lastScanError =
          `${pair}: ${error.message}`;
      }

      await sleep(REQUEST_DELAY_MS);
    }

    scanCursor =
      startIndex + selectedPairs.length;

    if (scanCursor >= PAIRS.length) {
      scanCursor = 0;
    }

    lastScanAt = isoNow();

  } catch (error) {
    lastScanError = error.message;

  } finally {
    scanRunning = false;
  }
}


/*
 * Start immediately, then every 60 seconds.
 */
setTimeout(() => {
  scanBatch().catch(error => {
    lastScanError = error.message;
  });
}, 1000);

setInterval(() => {
  scanBatch().catch(error => {
    lastScanError = error.message;
  });
}, SCAN_EVERY_MS);


/* =========================================================
   ROUTES
========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "PO AI Predictor API",
    version: VERSION,
    source: SOURCE,
    timezone: TIMEZONE,
    pairs: PAIRS.length,
    time: isoNow()
  });
});


/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", (req, res) => {
  cleanupExpiredCache();

  res.json({
    ok: true,
    version: VERSION,
    source: SOURCE,

    pairs: PAIRS.length,

    cachedPairs:
      new Set(
        [...cache.keys()].map(k =>
          k.split("_")[0]
        )
      ).size,

    cachedResults: cache.size,

    scanRunning,
    scanCursor,
    scanBatchSize: SCAN_BATCH_SIZE,

    lastScanAt,
    lastScanError,

    totalScanned,

    timezone: TIMEZONE,
    time: isoNow(),

    freshness: {
      maxAgeSeconds: MAX_DATA_AGE_SECONDS,
      hardStaleSeconds: HARD_STALE_SECONDS
    },

    location: {
      supportRiskATR:
        SUPPORT_RISK_ATR_MULTIPLIER,

      resistanceRiskATR:
        RESISTANCE_RISK_ATR_MULTIPLIER,

      minimumSRRangeATR:
        MIN_SR_RANGE_ATR_MULTIPLIER
    },

    apiKeyConfigured:
      Boolean(API_KEY),

    supportedTimeframes:
      TIMEFRAMES
  });
});


/* =========================================================
   SCANNER STATUS
========================================================= */

app.get("/api/scanner", (req, res) => {
  cleanupExpiredCache();

  const best =
    bestFromCache();

  const bestSignal =
    bestFromCache({
      signalOnly: true
    });

  res.json({
    ok: true,
    version: VERSION,

    scanRunning,
    scanCursor,
    scanBatchSize: SCAN_BATCH_SIZE,

    totalScanned,
    cachedResults: cache.size,

    lastScanAt,
    lastScanError,

    best,
    bestSignal,

    time: isoNow()
  });
});


/* =========================================================
   ANALYZE BEST
========================================================= */

app.get("/api/analyze", async (req, res) => {
  try {
    cleanupExpiredCache();

    /*
     * IMPORTANT:
     * Never return expired/stale cache.
     */

    const bestSignal =
      bestFromCache({
        signalOnly: true
      });

    if (bestSignal) {
      return res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        mode: "CACHE",
        best: bestSignal,
        time: isoNow()
      });
    }

    /*
     * If no valid signal exists, return the best valid
     * NO TRADE result if available.
     */

    const bestAny =
      bestFromCache();

    if (bestAny) {
      return res.json({
        ok: true,
        version: VERSION,
        source: SOURCE,
        mode: "CACHE",
        best: bestAny,
        time: isoNow()
      });
    }

    /*
     * No usable cache.
     * Run one scanner batch.
     */

    await scanBatch();

    cleanupExpiredCache();

    const freshSignal =
      bestFromCache({
        signalOnly: true
      });

    const freshAny =
      bestFromCache();

    if (!freshSignal && !freshAny) {
      return res.status(503).json({
        ok: false,
        version: VERSION,
        error:
          "No fresh market analysis available yet",
        scanRunning,
        lastScanAt,
        lastScanError,
        time: isoNow()
      });
    }

    return res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,
      mode: "SCAN",
      best: freshSignal || freshAny,
      time: isoNow()
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
      time: isoNow()
    });
  }
});


/* =========================================================
   ANALYZE SPECIFIC PAIR
========================================================= */

app.get("/api/analyze/:pair", async (req, res) => {
  try {
    const pair =
      normalizePair(
        decodeURIComponent(req.params.pair)
      );

    if (!PAIRS.includes(pair)) {
      return res.status(400).json({
        ok: false,
        error: `Unsupported pair: ${pair}`,
        supportedPairs: PAIRS
      });
    }

    const results =
      await analyzePair(pair);

    cleanupExpiredCache();

    if (!results.length) {
      return res.status(503).json({
        ok: false,
        error:
          "No fresh analysis available"
      });
    }

    const validResults =
      results.filter(
        r =>
          isUsableCachedResult(r)
      );

    validResults.sort(
      (a, b) =>
        rankResult(b) - rankResult(a)
    );

    return res.json({
      ok: true,
      version: VERSION,
      source: SOURCE,

      pair,

      best:
        validResults[0] || null,

      results: validResults,

      time: isoNow()
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: VERSION,
      error: error.message,
      time: isoNow()
    });
  }
});


/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Endpoint not found",
    path: req.path
  });
});


/* =========================================================
   SERVER
========================================================= */

app.listen(PORT, () => {
  console.log(
    `[PO AI Predictor ${VERSION}] Server running on port ${PORT}`
  );

  console.log(
    `[SOURCE] ${SOURCE}`
  );

  console.log(
    `[PAIRS] ${PAIRS.length}`
  );

  console.log(
    `[TIMEZONE] ${TIMEZONE}`
  );

  console.log(
    `[SCAN] ${SCAN_BATCH_SIZE} pairs every ${SCAN_EVERY_MS / 1000}s`
  );

  console.log(
    `[FRESHNESS] max=${MAX_DATA_AGE_SECONDS}s hard=${HARD_STALE_SECONDS}s`
  );
});
