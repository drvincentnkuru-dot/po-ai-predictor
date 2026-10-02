// ============================================================
// PO AI PREDICTOR
// Backend V8.6.4
// LIVE ONLY - Twelve Data
//
// V8.6.4 - ULTRA QUOTA-SAFE
//
// Changes from V8.6.3:
// - Provider request budget reduced to 5/minute
// - HTTP 429 is treated as a provider quota/rate-limit event
// - Scanner stops immediately when 429 is detected
// - Provider cooldown prevents repeated 429 retries
// - Retry-After header is respected when available
// - Cache remains the first protection against unnecessary calls
// - Settlement also respects the same quota gate
// - MACD REMOVED
// - CCI20 REMOVED
// - Keeps EMA9/EMA21, RSI14, ADX14, Stochastic,
//   ATR14, Support/Resistance, Candlestick Patterns,
//   Market Psychology
// - Automatic signal registration
// - Automatic WIN / LOSS / DRAW settlement
// - Settlement loop independent from scanner
// ============================================================

const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 10000;

const VERSION = "V8.6.4";
const SOURCE = "Twelve Data LIVE";
const TIMEZONE = "UTC";

// ------------------------------------------------------------
// ENV
// ------------------------------------------------------------

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

if (!TWELVE_DATA_API_KEY) {
  console.warn(
    "[WARNING] TWELVE_DATA_API_KEY is not configured."
  );
}

// ------------------------------------------------------------
// PAIRS
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// QUOTA-SAFE SYSTEM SETTINGS
// ------------------------------------------------------------
//
// Important:
//
// Twelve Data has previously returned HTTP 429 even when the
// local application was configured for 7 requests/minute.
//
// To protect the account, V8.6.4 deliberately uses only
// 5 provider requests/minute.
//
// This leaves a larger safety margin for provider-side counting,
// other requests, clock differences and settlement requests.
//
// IMPORTANT:
// The application never intentionally exceeds this local limit.
//

const REQUEST_LIMIT_PER_MINUTE = 5;

// Scanner requests only 5 pairs per scan cycle.
const SCAN_BATCH_SIZE = 5;

// One scanner batch every minute.
const SCAN_EVERY_MS = 60 * 1000;

// Settlement checks every 10 seconds.
const SETTLEMENT_INTERVAL_MS = 10 * 1000;

// Keep market candle data for 15 minutes.
const CACHE_TTL_MS = 15 * 60 * 1000;

// Keep selected result considered fresh for 30 seconds.
const RESULT_FRESH_MS = 30 * 1000;

// Signal must be visible at least 30 seconds before entry.
const ENTRY_BUFFER_SECONDS = 30;

// Settlement grace period.
const SETTLEMENT_GRACE_SECONDS = 10;

// Number of 1-minute candles requested.
const MAX_CANDLES = 180;

// Minimum candles required before analysis.
const MIN_CANDLES = 60;

// ------------------------------------------------------------
// PROVIDER 429 COOLDOWN
// ------------------------------------------------------------
//
// When Twelve Data returns HTTP 429, do NOT immediately retry.
//
// The provider may count requests independently from our local
// counter. A cooldown prevents a chain of repeated 429 requests.
//
// Default cooldown: 90 seconds.
//
// If Twelve Data sends Retry-After, the larger useful value is used.
//

const DEFAULT_PROVIDER_COOLDOWN_SECONDS = 90;

const MAX_PROVIDER_COOLDOWN_SECONDS = 15 * 60;

// Daily budget.
// We deliberately reserve credits.
const DAILY_LIMIT = 768;

const DAILY_SAFETY_RESERVE = 32;

const MAX_DAILY_REQUESTS =
  DAILY_LIMIT -
  DAILY_SAFETY_RESERVE;

// Signal history.
const MAX_SIGNAL_HISTORY = 5;

// Maximum cache size.
const MAX_CACHE_ENTRIES = 100;

// ------------------------------------------------------------
// STATE
// ------------------------------------------------------------

const candleCache = new Map();

let scanCursor = 0;

let scanRunning = false;

let lastScanAt = null;

let lastScanError = null;

let totalScanned = 0;

let totalFailed = 0;

let totalApiRequests = 0;

let lastSelected = null;

let lastSelectedAt = null;

// Local provider request timestamps.
let minuteRequestTimestamps = [];

let dailyRequestDate =
  getUtcDateKey(new Date());

let dailyRequests = 0;

// Provider quota state.
let quotaBlocked = false;

let quotaBlockedUntil = null;

let providerQuotaMessage = null;

let providerQuotaResetAt = null;

// Local minute budget state.
let minuteBlocked = false;

let minuteResetAt = null;

// Number of HTTP 429 responses.
let provider429Count = 0;

// Last provider HTTP status.
let lastProviderHttpStatus = null;

// Last provider error time.
let lastProviderErrorAt = null;

// Signal history.
// Newest signal is stored first.
const signalHistory = [];

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function getUtcDateKey(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function roundNumber(
  value,
  decimals = 5
) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor =
    Math.pow(10, decimals);

  return (
    Math.round(value * factor) /
    factor
  );
}

function normalizePair(pair) {
  if (!pair) {
    return "";
  }

  return String(pair)
    .trim()
    .toUpperCase()
    .replace("-", "/");
}

function pairToTwelveDataSymbol(
  pair
) {
  return normalizePair(pair)
    .replace("/", "");
}

function isSupportedPair(pair) {
  return PAIRS.includes(
    normalizePair(pair)
  );
}

function isSupportedTimeframe(tf) {
  return TIMEFRAMES.includes(
    Number(tf)
  );
}

function getPriceDecimals(pair) {
  const p =
    normalizePair(pair);

  if (p.includes("JPY")) {
    return 3;
  }

  return 5;
}

// ------------------------------------------------------------
// DAILY REQUEST RESET
// ------------------------------------------------------------

function resetDailyBudgetIfNeeded() {
  const today =
    getUtcDateKey(new Date());

  if (
    today !==
    dailyRequestDate
  ) {
    dailyRequestDate = today;

    dailyRequests = 0;

    quotaBlocked = false;

    quotaBlockedUntil = null;

    providerQuotaMessage = null;

    providerQuotaResetAt = null;

    lastProviderHttpStatus = null;

    lastProviderErrorAt = null;

    console.log(
      "[QUOTA] UTC daily budget reset."
    );
  }
}

// ------------------------------------------------------------
// PROVIDER COOLDOWN
// ------------------------------------------------------------

function clearProviderCooldownIfExpired() {
  if (
    !quotaBlocked ||
    !quotaBlockedUntil
  ) {
    return;
  }

  if (
    nowMs() >=
    quotaBlockedUntil
  ) {
    quotaBlocked = false;

    quotaBlockedUntil = null;

    providerQuotaMessage = null;

    providerQuotaResetAt = null;

    console.log(
      "[QUOTA] Provider cooldown expired."
    );
  }
}

function getProviderCooldownSeconds() {
  clearProviderCooldownIfExpired();

  if (
    !quotaBlocked ||
    !quotaBlockedUntil
  ) {
    return 0;
  }

  return Math.max(
    0,
    Math.ceil(
      (quotaBlockedUntil -
        nowMs()) /
        1000
    )
  );
}

function blockProviderQuota(
  message,
  retryAfterSeconds = null
) {
  let seconds =
    Number(
      retryAfterSeconds
    );

  if (
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    seconds =
      DEFAULT_PROVIDER_COOLDOWN_SECONDS;
  }

  seconds =
    Math.min(
      Math.max(
        1,
        Math.ceil(seconds)
      ),
      MAX_PROVIDER_COOLDOWN_SECONDS
    );

  quotaBlocked = true;

  quotaBlockedUntil =
    nowMs() +
    seconds * 1000;

  providerQuotaMessage =
    message ||
    "Twelve Data provider quota/rate limit reached.";

  providerQuotaResetAt =
    new Date(
      quotaBlockedUntil
    ).toISOString();

  console.warn(
    `[QUOTA] Provider cooldown enabled for ${seconds}s.`
  );
}

// ------------------------------------------------------------
// MINUTE REQUEST TRACKER
// ------------------------------------------------------------

function cleanupMinuteRequests() {
  const cutoff =
    nowMs() -
    60 * 1000;

  minuteRequestTimestamps =
    minuteRequestTimestamps.filter(
      (timestamp) =>
        timestamp > cutoff
    );
}

function getMinuteRequestCount() {
  cleanupMinuteRequests();

  return minuteRequestTimestamps.length;
}

function getSecondsUntilMinuteReset() {
  cleanupMinuteRequests();

  if (
    minuteRequestTimestamps.length ===
    0
  ) {
    return 0;
  }

  const oldest =
    minuteRequestTimestamps[0];

  return Math.max(
    0,
    Math.ceil(
      (
        oldest +
        60 * 1000 -
        nowMs()
      ) / 1000
    )
  );
}

// ------------------------------------------------------------
// REQUEST SLOT
// ------------------------------------------------------------

function acquireRequestSlot() {
  resetDailyBudgetIfNeeded();

  clearProviderCooldownIfExpired();

  cleanupMinuteRequests();

  if (quotaBlocked) {
    return {
      allowed: false,

      reason:
        "provider_quota_blocked",

      retryAfterSeconds:
        getProviderCooldownSeconds()
    };
  }

  if (
    dailyRequests >=
    MAX_DAILY_REQUESTS
  ) {
    return {
      allowed: false,

      reason:
        "daily_safety_budget_reached",

      retryAfterSeconds: null
    };
  }

  const usedThisMinute =
    minuteRequestTimestamps.length;

  if (
    usedThisMinute >=
    REQUEST_LIMIT_PER_MINUTE
  ) {
    const retry =
      getSecondsUntilMinuteReset();

    minuteBlocked = true;

    minuteResetAt =
      new Date(
        nowMs() +
          retry * 1000
      ).toISOString();

    return {
      allowed: false,

      reason:
        "local_minute_budget_reached",

      retryAfterSeconds:
        retry
    };
  }

  minuteBlocked = false;

  minuteResetAt = null;

  minuteRequestTimestamps.push(
    nowMs()
  );

  dailyRequests += 1;

  totalApiRequests += 1;

  return {
    allowed: true
  };
}

// ------------------------------------------------------------
// RETRY-AFTER PARSER
// ------------------------------------------------------------

function parseRetryAfter(
  response
) {
  if (!response) {
    return null;
  }

  try {
    const header =
      response.headers.get(
        "retry-after"
      );

    if (!header) {
      return null;
    }

    const numeric =
      Number(header);

    if (
      Number.isFinite(numeric) &&
      numeric >= 0
    ) {
      return numeric;
    }

    const date =
      Date.parse(header);

    if (
      Number.isFinite(date)
    ) {
      return Math.max(
        0,
        Math.ceil(
          (date - nowMs()) /
            1000
        )
      );
    }
  } catch {
    // Ignore header parsing errors.
  }

  return null;
}

// ------------------------------------------------------------
// TWELVE DATA FETCH
// ------------------------------------------------------------

async function fetchTwelveDataCandles(
  pair
) {
  const normalized =
    normalizePair(pair);

  if (
    !isSupportedPair(normalized)
  ) {
    throw new Error(
      `${normalized}: unsupported pair`
    );
  }

  const slot =
    acquireRequestSlot();

  if (!slot.allowed) {
    const error =
      new Error(
        `Request blocked: ${slot.reason}`
      );

    error.code =
      slot.reason;

    error.retryAfterSeconds =
      slot.retryAfterSeconds;

    throw error;
  }

  const symbol =
    pairToTwelveDataSymbol(
      normalized
    );

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(
      symbol
    )}` +
    "&interval=1min" +
    `&outputsize=${MAX_CANDLES}` +
    "&order=ASC" +
    `&apikey=${encodeURIComponent(
      TWELVE_DATA_API_KEY
    )}`;

  let response;

  try {
    response =
      await fetch(url);
  } catch (error) {
    lastProviderErrorAt =
      new Date().toISOString();

    throw new Error(
      `${normalized}: Twelve Data network error: ${error.message}`
    );
  }

  lastProviderHttpStatus =
    response.status;

  lastProviderErrorAt =
    response.ok
      ? lastProviderErrorAt
      : new Date().toISOString();

  // ----------------------------------------------------------
  // HTTP 429
  // ----------------------------------------------------------
  //
  // This is the most important V8.6.4 protection.
  //
  // Do NOT continue scanning the rest of the batch.
  //

  if (
    response.status === 429
  ) {
    provider429Count += 1;

    let bodyText = "";

    try {
      bodyText =
        await response.text();
    } catch {
      bodyText = "";
    }

    let message =
      "Twelve Data HTTP 429 - provider rate limit/quota reached.";

    if (bodyText) {
      try {
        const parsed =
          JSON.parse(bodyText);

        if (
          parsed &&
          parsed.message
        ) {
          message =
            String(
              parsed.message
            );
        }
      } catch {
        // Keep default message.
      }
    }

    const retryAfter =
      parseRetryAfter(
        response
      );

    blockProviderQuota(
      message,
      retryAfter
    );

    const error =
      new Error(
        `${normalized}: ${message}`
      );

    error.code =
      "provider_http_429";

    error.httpStatus = 429;

    error.retryAfterSeconds =
      getProviderCooldownSeconds();

    throw error;
  }

  let data = null;

  try {
    data =
      await response.json();
  } catch {
    data = null;
  }

  // ----------------------------------------------------------
  // OTHER HTTP ERRORS
  // ----------------------------------------------------------

  if (!response.ok) {
    throw new Error(
      `${normalized}: Twelve Data HTTP ${response.status}`
    );
  }

  if (!data) {
    throw new Error(
      `${normalized}: empty Twelve Data response`
    );
  }

  // ----------------------------------------------------------
  // API-LEVEL ERROR
  // ----------------------------------------------------------

  if (
    data.status === "error"
  ) {
    const message =
      data.message ||
      "Twelve Data returned an error";

    const lower =
      message.toLowerCase();

    if (
      lower.includes("run out") ||
      lower.includes("credits") ||
      lower.includes("rate limit") ||
      lower.includes("too many") ||
      lower.includes("quota") ||
      lower.includes("429")
    ) {
      provider429Count += 1;

      blockProviderQuota(
        message,
        null
      );
    }

    const error =
      new Error(
        `${normalized}: ${message}`
      );

    if (quotaBlocked) {
      error.code =
        "provider_quota_blocked";

      error.retryAfterSeconds =
        getProviderCooldownSeconds();
    }

    throw error;
  }

  if (
    !Array.isArray(
      data.values
    )
  ) {
    throw new Error(
      `${normalized}: Twelve Data returned no candle values`
    );
  }

  const candles =
    data.values
      .map((row) => ({
        time: new Date(
          row.datetime
        ).getTime(),

        open: Number(
          row.open
        ),

        high: Number(
          row.high
        ),

        low: Number(
          row.low
        ),

        close: Number(
          row.close
        )
      }))
      .filter(
        (candle) =>
          Number.isFinite(
            candle.time
          ) &&
          Number.isFinite(
            candle.open
          ) &&
          Number.isFinite(
            candle.high
          ) &&
          Number.isFinite(
            candle.low
          ) &&
          Number.isFinite(
            candle.close
          )
      )
      .sort(
        (a, b) =>
          a.time - b.time
      );

  if (
    candles.length <
    MIN_CANDLES
  ) {
    throw new Error(
      `${normalized}: insufficient candles (${candles.length}/${MIN_CANDLES})`
    );
  }

  return candles;
}

// ------------------------------------------------------------
// CACHE
// ------------------------------------------------------------

function setCache(
  pair,
  candles
) {
  const normalized =
    normalizePair(pair);

  candleCache.set(
    normalized,
    {
      candles,
      fetchedAt: nowMs()
    }
  );

  cleanupCache();
}

function getCache(pair) {
  const normalized =
    normalizePair(pair);

  const item =
    candleCache.get(
      normalized
    );

  if (!item) {
    return null;
  }

  if (
    nowMs() -
      item.fetchedAt >
    CACHE_TTL_MS
  ) {
    candleCache.delete(
      normalized
    );

    return null;
  }

  return item;
}

function cleanupCache() {
  if (
    candleCache.size <=
    MAX_CACHE_ENTRIES
  ) {
    return;
  }

  const entries =
    Array.from(
      candleCache.entries()
    ).sort(
      (a, b) =>
        a[1].fetchedAt -
        b[1].fetchedAt
    );

  while (
    candleCache.size >
    MAX_CACHE_ENTRIES
  ) {
    const oldest =
      entries.shift();

    if (!oldest) {
      break;
    }

    candleCache.delete(
      oldest[0]
    );
  }
}

async function getCandles(
  pair,
  options = {}
) {
  const {
    forceFresh = false
  } = options;

  if (!forceFresh) {
    const cached =
      getCache(pair);

    if (cached) {
      return cached.candles;
    }
  }

  const candles =
    await fetchTwelveDataCandles(
      pair
    );

  setCache(
    pair,
    candles
  );

  return candles;
}

// ------------------------------------------------------------
// TIMEFRAME AGGREGATION
// ------------------------------------------------------------

function aggregateCandles(
  candles,
  timeframe
) {
  const tf =
    Number(timeframe);

  if (tf === 1) {
    return candles.slice();
  }

  const groups =
    new Map();

  for (
    const candle of candles
  ) {
    const date =
      new Date(
        candle.time
      );

    const year =
      date.getUTCFullYear();

    const month =
      date.getUTCMonth();

    const day =
      date.getUTCDate();

    const hour =
      date.getUTCHours();

    const minute =
      date.getUTCMinutes();

    const bucketMinute =
      Math.floor(
        minute / tf
      ) * tf;

    const bucket =
      Date.UTC(
        year,
        month,
        day,
        hour,
        bucketMinute,
        0,
        0
      );

    if (
      !groups.has(bucket)
    ) {
      groups.set(
        bucket,
        []
      );
    }

    groups
      .get(bucket)
      .push(candle);
  }

  const result = [];

  for (
    const [
      bucket,
      rows
    ] of groups.entries()
  ) {
    if (!rows.length) {
      continue;
    }

    result.push({
      time: bucket,

      open:
        rows[0].open,

      high:
        Math.max(
          ...rows.map(
            (r) => r.high
          )
        ),

      low:
        Math.min(
          ...rows.map(
            (r) => r.low
          )
        ),

      close:
        rows[
          rows.length - 1
        ].close
    });
  }

  return result.sort(
    (a, b) =>
      a.time - b.time
  );
}

// ------------------------------------------------------------
// INDICATORS
// ------------------------------------------------------------

function ema(
  values,
  period
) {
  if (
    !Array.isArray(values) ||
    values.length <
      period
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
      (values[i] -
        result) *
        multiplier +
      result;
  }

  return result;
}

function rsi(
  values,
  period = 14
) {
  if (
    values.length <=
    period
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
    const diff =
      values[i] -
      values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] -
      values[i - 1];

    const gain =
      diff > 0
        ? diff
        : 0;

    const loss =
      diff < 0
        ? -diff
        : 0;

    avgGain =
      (avgGain *
        (period - 1) +
        gain) /
      period;

    avgLoss =
      (avgLoss *
        (period - 1) +
        loss) /
      period;
  }

  if (
    avgLoss === 0
  ) {
    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function atr(
  candles,
  period = 14
) {
  if (
    candles.length <=
    period
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
    trs.length <
    period
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
      (value *
        (period - 1) +
        trs[i]) /
      period;
  }

  return value;
}

function adx(
  candles,
  period = 14
) {
  if (
    candles.length <
    period * 2 + 1
  ) {
    return null;
  }

  const trValues = [];

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

    trValues.push(tr);

    plusDM.push(
      upMove >
        downMove &&
      upMove > 0
        ? upMove
        : 0
    );

    minusDM.push(
      downMove >
        upMove &&
      downMove > 0
        ? downMove
        : 0
    );
  }

  if (
    trValues.length <
    period * 2
  ) {
    return null;
  }

  let trSmooth =
    trValues
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      );

  let plusSmooth =
    plusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      );

  let minusSmooth =
    minusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      );

  const dxValues = [];

  for (
    let i = period;
    i < trValues.length;
    i++
  ) {
    if (
      i > period
    ) {
      trSmooth =
        trSmooth -
        trSmooth / period +
        trValues[i];

      plusSmooth =
        plusSmooth -
        plusSmooth / period +
        plusDM[i];

      minusSmooth =
        minusSmooth -
        minusSmooth / period +
        minusDM[i];
    }

    const plusDI =
      trSmooth === 0
        ? 0
        : (100 *
            plusSmooth) /
          trSmooth;

    const minusDI =
      trSmooth === 0
        ? 0
        : (100 *
            minusSmooth) /
          trSmooth;

    const denominator =
      plusDI +
      minusDI;

    const dx =
      denominator === 0
        ? 0
        : (100 *
            Math.abs(
              plusDI -
                minusDI
            )) /
          denominator;

    dxValues.push(dx);
  }

  if (
    dxValues.length <
    period
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
      (adxValue *
        (period - 1) +
        dxValues[i]) /
      period;
  }

  return adxValue;
}

function stochastic(
  candles,
  period = 14,
  signalPeriod = 3
) {
  if (
    candles.length <
    period + signalPeriod
  ) {
    return null;
  }

  const kValues = [];

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

    const highest =
      Math.max(
        ...window.map(
          (c) => c.high
        )
      );

    const lowest =
      Math.min(
        ...window.map(
          (c) => c.low
        )
      );

    const close =
      candles[i].close;

    const k =
      highest === lowest
        ? 50
        : (
            (close -
              lowest) /
            (highest -
              lowest)
          ) * 100;

    kValues.push(k);
  }

  if (
    kValues.length <
    signalPeriod
  ) {
    return null;
  }

  const k =
    kValues[
      kValues.length - 1
    ];

  const recentK =
    kValues.slice(
      -signalPeriod
    );

  const d =
    recentK.reduce(
      (a, b) => a + b,
      0
    ) / signalPeriod;

  return {
    k,
    d
  };
}

function supportResistance(
  candles,
  lookback = 30
) {
  const rows =
    candles.slice(
      -lookback
    );

  if (!rows.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const support =
    Math.min(
      ...rows.map(
        (c) => c.low
      )
    );

  const resistance =
    Math.max(
      ...rows.map(
        (c) => c.high
      )
    );

  return {
    support,
    resistance
  };
}

// ------------------------------------------------------------
// CANDLESTICK PATTERNS
// ------------------------------------------------------------

function detectCandlestickPatterns(
  candles
) {
  if (
    candles.length < 3
  ) {
    return [];
  }

  const a =
    candles[
      candles.length - 3
    ];

  const b =
    candles[
      candles.length - 2
    ];

  const c =
    candles[
      candles.length - 1
    ];

  const patterns = [];

  const bodyC =
    Math.abs(
      c.close -
        c.open
    );

  const rangeC =
    Math.max(
      c.high -
        c.low,
      0.00000001
    );

  const upperC =
    c.high -
    Math.max(
      c.open,
      c.close
    );

  const lowerC =
    Math.min(
      c.open,
      c.close
    ) -
    c.low;

  if (
    b.close <
      b.open &&
    c.close >
      c.open &&
    c.open <=
      b.close &&
    c.close >=
      b.open
  ) {
    patterns.push(
      "bullish engulfing"
    );
  }

  if (
    b.close >
      b.open &&
    c.close <
      c.open &&
    c.open >=
      b.close &&
    c.close <=
      b.open
  ) {
    patterns.push(
      "bearish engulfing"
    );
  }

  if (
    lowerC >
      bodyC * 2 &&
    upperC <
      bodyC &&
    c.close >=
      c.open
  ) {
    patterns.push(
      "hammer"
    );
  }

  if (
    upperC >
      bodyC * 2 &&
    lowerC <
      bodyC &&
    c.close <=
      c.open
  ) {
    patterns.push(
      "shooting star"
    );
  }

  if (
    c.close >
      c.open &&
    bodyC /
      rangeC >=
      0.65
  ) {
    patterns.push(
      "strong bullish candle"
    );
  }

  if (
    c.close <
      c.open &&
    bodyC /
      rangeC >=
      0.65
  ) {
    patterns.push(
      "strong bearish candle"
    );
  }

  if (
    a.close >
      a.open &&
    b.close >
      b.open &&
    c.close >
      c.open
  ) {
    patterns.push(
      "three bullish candles"
    );
  }

  if (
    a.close <
      a.open &&
    b.close <
      b.open &&
    c.close <
      c.open
  ) {
    patterns.push(
      "three bearish candles"
    );
  }

  return patterns;
}

// ------------------------------------------------------------
// MARKET PSYCHOLOGY
// ------------------------------------------------------------

function marketPsychology(
  candles,
  ema9,
  ema21,
  rsiValue,
  adxValue
) {
  if (
    candles.length < 6
  ) {
    return {
      direction:
        "neutral",

      label:
        "neutral pressure"
    };
  }

  const recent =
    candles.slice(-5);

  const bullishCount =
    recent.filter(
      (c) =>
        c.close >
        c.open
    ).length;

  const bearishCount =
    recent.filter(
      (c) =>
        c.close <
        c.open
    ).length;

  const last =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const priceMomentum =
    last.close -
    previous.close;

  if (
    ema9 != null &&
    ema21 != null &&
    ema9 > ema21 &&
    bullishCount >= 3 &&
    priceMomentum > 0
  ) {
    return {
      direction:
        "bullish",

      label:
        "buyer pressure"
    };
  }

  if (
    ema9 != null &&
    ema21 != null &&
    ema9 < ema21 &&
    bearishCount >= 3 &&
    priceMomentum < 0
  ) {
    return {
      direction:
        "bearish",

      label:
        "seller pressure"
    };
  }

  if (
    adxValue != null &&
    adxValue < 18
  ) {
    return {
      direction:
        "neutral",

      label:
        "weak trend / ranging"
    };
  }

  if (
    rsiValue != null &&
    rsiValue > 60
  ) {
    return {
      direction:
        "bullish",

      label:
        "positive momentum"
    };
  }

  if (
    rsiValue != null &&
    rsiValue < 40
  ) {
    return {
      direction:
        "bearish",

      label:
        "negative momentum"
    };
  }

  return {
    direction:
      "neutral",

    label:
      "mixed pressure"
  };
}

// ------------------------------------------------------------
// ANALYSIS
// ------------------------------------------------------------

function analyzeCandles(
  candles,
  pair,
  timeframe
) {
  const tf =
    Number(timeframe);

  const aggregated =
    aggregateCandles(
      candles,
      tf
    );

  if (
    aggregated.length <
    MIN_CANDLES
  ) {
    throw new Error(
      `${pair} ${tf}m: insufficient aggregated candles (${aggregated.length}/${MIN_CANDLES})`
    );
  }

  const closes =
    aggregated.map(
      (c) => c.close
    );

  const ema9 =
    ema(
      closes,
      9
    );

  const ema21 =
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
      aggregated,
      14
    );

  const adxValue =
    adx(
      aggregated,
      14
    );

  const stoch =
    stochastic(
      aggregated,
      14,
      3
    );

  const sr =
    supportResistance(
      aggregated,
      30
    );

  const patterns =
    detectCandlestickPatterns(
      aggregated
    );

  const currentPrice =
    closes[
      closes.length - 1
    ];

  const previousPrice =
    closes[
      closes.length - 2
    ];

  let callScore = 0;

  let putScore = 0;

  const reasons = [];

  // ----------------------------------------------------------
  // EMA
  // ----------------------------------------------------------

  if (
    ema9 != null &&
    ema21 != null
  ) {
    if (
      ema9 > ema21
    ) {
      callScore += 22;

      reasons.push(
        "EMA bullish"
      );
    } else if (
      ema9 < ema21
    ) {
      putScore += 22;

      reasons.push(
        "EMA bearish"
      );
    }
  }

  // ----------------------------------------------------------
  // RSI
  // ----------------------------------------------------------

  if (
    rsiValue != null
  ) {
    if (
      rsiValue >= 52 &&
      rsiValue <= 68
    ) {
      callScore += 14;

      reasons.push(
        `RSI ${rsiValue.toFixed(
          1
        )}`
      );
    } else if (
      rsiValue <= 48 &&
      rsiValue >= 32
    ) {
      putScore += 14;

      reasons.push(
        `RSI ${rsiValue.toFixed(
          1
        )}`
      );
    } else if (
      rsiValue > 68
    ) {
      putScore += 5;

      reasons.push(
        `RSI ${rsiValue.toFixed(
          1
        )} high`
      );
    } else if (
      rsiValue < 32
    ) {
      callScore += 5;

      reasons.push(
        `RSI ${rsiValue.toFixed(
          1
        )} low`
      );
    } else {
      reasons.push(
        `RSI ${rsiValue.toFixed(
          1
        )}`
      );
    }
  }

  // ----------------------------------------------------------
  // ADX
  // ----------------------------------------------------------

  if (
    adxValue != null
  ) {
    if (
      adxValue >= 25
    ) {
      callScore +=
        ema9 > ema21
          ? 10
          : 0;

      putScore +=
        ema9 < ema21
          ? 10
          : 0;

      reasons.push(
        `ADX ${adxValue.toFixed(
          1
        )}`
      );
    } else {
      reasons.push(
        `ADX ${adxValue.toFixed(
          1
        )} weak`
      );
    }
  }

  // ----------------------------------------------------------
  // STOCHASTIC
  // ----------------------------------------------------------

  if (stoch) {
    if (
      stoch.k >
        stoch.d &&
      stoch.k < 85
    ) {
      callScore += 12;

      reasons.push(
        `Stoch K ${stoch.k.toFixed(
          1
        )} / D ${stoch.d.toFixed(
          1
        )}`
      );
    } else if (
      stoch.k <
        stoch.d &&
      stoch.k > 15
    ) {
      putScore += 12;

      reasons.push(
        `Stoch K ${stoch.k.toFixed(
          1
        )} / D ${stoch.d.toFixed(
          1
        )}`
      );
    } else {
      reasons.push(
        `Stoch K ${stoch.k.toFixed(
          1
        )} / D ${stoch.d.toFixed(
          1
        )}`
      );
    }
  }

  // ----------------------------------------------------------
  // PRICE MOMENTUM
  // ----------------------------------------------------------

  if (
    Number.isFinite(
      previousPrice
    )
  ) {
    if (
      currentPrice >
      previousPrice
    ) {
      callScore += 8;
    } else if (
      currentPrice <
      previousPrice
    ) {
      putScore += 8;
    }
  }

  // ----------------------------------------------------------
  // CANDLESTICK PATTERNS
  // ----------------------------------------------------------

  for (
    const pattern of patterns
  ) {
    const bullish =
      pattern.includes(
        "bullish"
      ) ||
      pattern ===
        "hammer";

    const bearish =
      pattern.includes(
        "bearish"
      ) ||
      pattern ===
        "shooting star";

    if (bullish) {
      callScore += 7;
    }

    if (bearish) {
      putScore += 7;
    }
  }

  if (
    patterns.length
  ) {
    reasons.push(
      patterns
        .slice(0, 2)
        .join(" • ")
    );
  }

  // ----------------------------------------------------------
  // MARKET PSYCHOLOGY
  // ----------------------------------------------------------

  const psychology =
    marketPsychology(
      aggregated,
      ema9,
      ema21,
      rsiValue,
      adxValue
    );

  if (
    psychology.direction ===
    "bullish"
  ) {
    callScore += 8;

    reasons.push(
      psychology.label
    );
  } else if (
    psychology.direction ===
    "bearish"
  ) {
    putScore += 8;

    reasons.push(
      psychology.label
    );
  } else {
    reasons.push(
      psychology.label
    );
  }

  // ----------------------------------------------------------
  // SUPPORT / RESISTANCE
  // ----------------------------------------------------------

  if (
    sr.support != null &&
    sr.resistance != null
  ) {
    const range =
      sr.resistance -
      sr.support;

    if (
      range > 0
    ) {
      const position =
        (
          currentPrice -
          sr.support
        ) / range;

      if (
        position < 0.75 &&
        psychology.direction ===
          "bullish"
      ) {
        callScore += 3;
      }

      if (
        position > 0.25 &&
        psychology.direction ===
          "bearish"
      ) {
        putScore += 3;
      }
    }
  }

  // ----------------------------------------------------------
  // FINAL SCORING
  // ----------------------------------------------------------

  callScore =
    Math.round(
      clamp(
        callScore,
        0,
        95
      )
    );

  putScore =
    Math.round(
      clamp(
        putScore,
        0,
        95
      )
    );

  const difference =
    Math.abs(
      callScore -
      putScore
    );

  let signal =
    "NO TRADE";

  let confidence = 40;

  if (
    callScore >= 58 &&
    callScore >
      putScore &&
    difference >= 12
  ) {
    signal =
      "CALL";

    confidence =
      Math.round(
        clamp(
          callScore +
            difference *
              0.35,
          70,
          95
        )
      );
  } else if (
    putScore >= 58 &&
    putScore >
      callScore &&
    difference >= 12
  ) {
    signal =
      "PUT";

    confidence =
      Math.round(
        clamp(
          putScore +
            difference *
              0.35,
          70,
          95
        )
      );
  } else {
    confidence =
      Math.round(
        clamp(
          Math.max(
            callScore,
            putScore
          ),
          0,
          69
        )
      );
  }

  // ----------------------------------------------------------
  // ENTRY / EXPIRY
  // ----------------------------------------------------------

  const now =
    new Date();

  const currentTime =
    now.getTime();

  const tfMs =
    tf *
    60 *
    1000;

  let entryTime =
    Math.ceil(
      currentTime /
        tfMs
    ) *
    tfMs;

  if (
    entryTime -
      currentTime <
    ENTRY_BUFFER_SECONDS *
      1000
  ) {
    entryTime +=
      tfMs;
  }

  const expiryTime =
    entryTime +
    tfMs;

  const entryInSeconds =
    Math.max(
      0,
      Math.ceil(
        (
          entryTime -
          currentTime
        ) / 1000
      )
    );

  const decimals =
    getPriceDecimals(
      pair
    );

  return {
    pair,

    timeframe:
      tf,

    signal,

    confidence,

    callScore,

    putScore,

    currentPrice:
      roundNumber(
        currentPrice,
        decimals
      ),

    predictedPrice:
      roundNumber(
        currentPrice,
        decimals
      ),

    entryTime:
      new Date(
        entryTime
      ).toISOString(),

    expiryTime:
      new Date(
        expiryTime
      ).toISOString(),

    entryInSeconds,

    marketCondition:
      psychology.label,

    psychology:
      psychology.label,

    patterns,

    indicators: {
      ema9:
        ema9 == null
          ? null
          : roundNumber(
              ema9,
              decimals
            ),

      ema21:
        ema21 == null
          ? null
          : roundNumber(
              ema21,
              decimals
            ),

      rsi14:
        rsiValue == null
          ? null
          : roundNumber(
              rsiValue,
              2
            ),

      adx14:
        adxValue == null
          ? null
          : roundNumber(
              adxValue,
              2
            ),

      stochasticK:
        stoch == null
          ? null
          : roundNumber(
              stoch.k,
              2
            ),

      stochasticD:
        stoch == null
          ? null
          : roundNumber(
              stoch.d,
              2
            ),

      atr14:
        atrValue == null
          ? null
          : roundNumber(
              atrValue,
              decimals
            ),

      support:
        sr.support == null
          ? null
          : roundNumber(
              sr.support,
              decimals
            ),

      resistance:
        sr.resistance == null
          ? null
          : roundNumber(
              sr.resistance,
              decimals
            )
    },

    reasons:
      reasons.slice(
        0,
        8
      )
  };
}

// ------------------------------------------------------------
// SIGNAL REGISTRY
// ------------------------------------------------------------

function createSignalKey(
  analysis
) {
  return [
    analysis.pair,
    analysis.timeframe,
    new Date(
      analysis.entryTime
    ).getTime(),
    analysis.signal
  ].join(":");
}

function findSignalByKey(
  key
) {
  return signalHistory.find(
    (signal) =>
      signal.key === key
  );
}

function registerSignal(
  analysis
) {
  if (
    !analysis ||
    analysis.signal ===
      "NO TRADE"
  ) {
    return null;
  }

  const key =
    createSignalKey(
      analysis
    );

  const existing =
    findSignalByKey(
      key
    );

  if (existing) {
    return existing;
  }

  const signalId =
    `PO864-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;

  const record = {
    signalId,

    key,

    pair:
      analysis.pair,

    timeframe:
      analysis.timeframe,

    signal:
      analysis.signal,

    confidence:
      analysis.confidence,

    callScore:
      analysis.callScore,

    putScore:
      analysis.putScore,

    analysisTime:
      new Date().toISOString(),

    entryTime:
      analysis.entryTime,

    expiryTime:
      analysis.expiryTime,

    predictedPrice:
      analysis.predictedPrice,

    entryPrice:
      null,

    exitPrice:
      null,

    result:
      "PENDING",

    settledAt:
      null,

    settlementSource:
      null
  };

  signalHistory.unshift(
    record
  );

  while (
    signalHistory.length >
    MAX_SIGNAL_HISTORY
  ) {
    signalHistory.pop();
  }

  return record;
}

// ------------------------------------------------------------
// PERFORMANCE
// ------------------------------------------------------------

function getPerformance() {
  const total =
    signalHistory.length;

  const pending =
    signalHistory.filter(
      (s) =>
        s.result ===
        "PENDING"
    ).length;

  const wins =
    signalHistory.filter(
      (s) =>
        s.result ===
        "WIN"
    ).length;

  const losses =
    signalHistory.filter(
      (s) =>
        s.result ===
        "LOSS"
    ).length;

  const draws =
    signalHistory.filter(
      (s) =>
        s.result ===
        "DRAW"
    ).length;

  const settled =
    wins +
    losses +
    draws;

  const decisive =
    wins +
    losses;

  return {
    total,

    pending,

    wins,

    losses,

    draws,

    settled,

    decisive,

    winRate:
      decisive > 0
        ? roundNumber(
            (
              wins /
              decisive
            ) * 100,
            2
          )
        : null,

    winRateIncludingDraws:
      settled > 0
        ? roundNumber(
            (
              wins /
              settled
            ) * 100,
            2
          )
        : null
  };
}

// ------------------------------------------------------------
// SETTLEMENT HELPERS
// ------------------------------------------------------------

function findCandleAtOrAfter(
  candles,
  timestamp
) {
  return candles.find(
    (candle) =>
      candle.time >=
      timestamp
  );
}

function findCandleAtOrBefore(
  candles,
  timestamp
) {
  let found = null;

  for (
    const candle of candles
  ) {
    if (
      candle.time <=
      timestamp
    ) {
      found = candle;
    } else {
      break;
    }
  }

  return found;
}

function determineResult(
  signal,
  entryPrice,
  exitPrice
) {
  if (
    !Number.isFinite(
      entryPrice
    ) ||
    !Number.isFinite(
      exitPrice
    )
  ) {
    return "DRAW";
  }

  if (
    signal ===
    "CALL"
  ) {
    if (
      exitPrice >
      entryPrice
    ) {
      return "WIN";
    }

    if (
      exitPrice <
      entryPrice
    ) {
      return "LOSS";
    }

    return "DRAW";
  }

  if (
    signal ===
    "PUT"
  ) {
    if (
      exitPrice <
      entryPrice
    ) {
      return "WIN";
    }

    if (
      exitPrice >
      entryPrice
    ) {
      return "LOSS";
    }

    return "DRAW";
  }

  return "DRAW";
}

// ------------------------------------------------------------
// AUTOMATIC SETTLEMENT
// ------------------------------------------------------------

let settlementRunning =
  false;

async function settlePendingSignals() {
  if (
    settlementRunning
  ) {
    return;
  }

  settlementRunning = true;

  try {
    const now =
      nowMs();

    const pending =
      signalHistory.filter(
        (signal) =>
          signal.result ===
            "PENDING" &&
          new Date(
            signal.expiryTime
          ).getTime() +
            SETTLEMENT_GRACE_SECONDS *
              1000 <=
            now
      );

    if (
      !pending.length
    ) {
      return;
    }

    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Before attempting settlement, check provider cooldown.
    //
    // If Twelve Data recently returned 429, settlement waits
    // instead of creating another provider request.
    // --------------------------------------------------------

    clearProviderCooldownIfExpired();

    if (quotaBlocked) {
      console.log(
        `[SETTLEMENT] Provider cooldown active. Waiting ${getProviderCooldownSeconds()}s.`
      );

      return;
    }

    const grouped =
      new Map();

    for (
      const signal of pending
    ) {
      if (
        !grouped.has(
          signal.pair
        )
      ) {
        grouped.set(
          signal.pair,
          []
        );
      }

      grouped
        .get(signal.pair)
        .push(signal);
    }

    for (
      const [
        pair,
        signals
      ] of grouped.entries()
    ) {
      // Stop if provider quota was blocked
      // by an earlier settlement request.
      if (quotaBlocked) {
        break;
      }

      let candles;

      try {
        candles =
          await getCandles(
            pair,
            {
              forceFresh: true
            }
          );
      } catch (error) {
        console.warn(
          `[SETTLEMENT] ${pair}: ${error.message}`
        );

        if (
          error.code ===
            "provider_http_429" ||
          error.code ===
            "provider_quota_blocked"
        ) {
          break;
        }

        continue;
      }

      for (
        const signal of signals
      ) {
        try {
          const tf =
            signal.timeframe;

          const aggregated =
            aggregateCandles(
              candles,
              tf
            );

          const entryTimestamp =
            new Date(
              signal.entryTime
            ).getTime();

          const expiryTimestamp =
            new Date(
              signal.expiryTime
            ).getTime();

          const entryCandle =
            findCandleAtOrAfter(
              aggregated,
              entryTimestamp
            );

          const expiryCandle =
            findCandleAtOrAfter(
              aggregated,
              expiryTimestamp
            );

          if (
            !entryCandle ||
            !expiryCandle
          ) {
            continue;
          }

          const entryPrice =
            Number(
              entryCandle.open
            );

          const exitPrice =
            Number(
              expiryCandle.close
            );

          if (
            !Number.isFinite(
              entryPrice
            ) ||
            !Number.isFinite(
              exitPrice
            )
          ) {
            continue;
          }

          const result =
            determineResult(
              signal.signal,
              entryPrice,
              exitPrice
            );

          signal.entryPrice =
            entryPrice;

          signal.exitPrice =
            exitPrice;

          signal.result =
            result;

          signal.settledAt =
            new Date().toISOString();

          signal.settlementSource =
            "Twelve Data LIVE candle";

          console.log(
            `[SETTLEMENT] ${signal.pair} ${signal.timeframe}m ${signal.signal} => ${result} | entry=${entryPrice} exit=${exitPrice}`
          );
        } catch (error) {
          console.warn(
            `[SETTLEMENT] signal ${signal.signalId}: ${error.message}`
          );
        }
      }
    }
  } finally {
    settlementRunning =
      false;
  }
}

// ------------------------------------------------------------
// SCANNER
// ------------------------------------------------------------

async function scanNextBatch() {
  if (
    scanRunning
  ) {
    return;
  }

  if (
    !TWELVE_DATA_API_KEY
  ) {
    lastScanError =
      "TWELVE_DATA_API_KEY is not configured";

    return;
  }

  // ----------------------------------------------------------
  // NEVER start a scan while provider cooldown is active.
  // ----------------------------------------------------------

  clearProviderCooldownIfExpired();

  if (quotaBlocked) {
    lastScanError =
      `Provider cooldown active for ${getProviderCooldownSeconds()}s`;

    console.warn(
      `[SCAN] ${lastScanError}`
    );

    return;
  }

  scanRunning =
    true;

  const batch = [];

  try {
    for (
      let i = 0;
      i < SCAN_BATCH_SIZE;
      i++
    ) {
      const index =
        (
          scanCursor +
          i
        ) %
        PAIRS.length;

      batch.push(
        PAIRS[index]
      );
    }

    const analyses = [];

    for (
      const pair of batch
    ) {
      let candles;

      try {
        candles =
          await getCandles(
            pair,
            {
              forceFresh: true
            }
          );

        totalScanned += 1;

        for (
          const timeframe of TIMEFRAMES
        ) {
          try {
            const analysis =
              analyzeCandles(
                candles,
                pair,
                timeframe
              );

            analyses.push(
              analysis
            );
          } catch (error) {
            totalFailed += 1;

            console.warn(
              `[ANALYZE] ${pair} ${timeframe}m: ${error.message}`
            );
          }
        }
      } catch (error) {
        totalFailed += 1;

        lastScanError =
          error.message;

        console.warn(
          `[SCAN] ${pair}: ${error.message}`
        );

        // ------------------------------------------------------
        // CRITICAL:
        //
        // HTTP 429 must stop the entire batch immediately.
        // Do not burn remaining request slots.
        // ------------------------------------------------------

        if (
          error.code ===
            "provider_http_429" ||
          error.code ===
            "provider_quota_blocked"
        ) {
          console.warn(
            "[SCAN] Provider quota/rate limit detected. Stopping batch immediately."
          );

          break;
        }

        if (
          error.code ===
            "local_minute_budget_reached" ||
          error.code ===
            "daily_safety_budget_reached"
        ) {
          break;
        }
      }
    }

    if (
      analyses.length
    ) {
      const valid =
        analyses.filter(
          (analysis) =>
            analysis.signal !==
            "NO TRADE"
        );

      for (
        const analysis of valid
      ) {
        registerSignal(
          analysis
        );
      }

      const ranked =
        [...valid].sort(
          (a, b) =>
            rankAnalysis(b) -
            rankAnalysis(a)
        );

      const selected =
        ranked.length
          ? ranked[0]
          : chooseBestNoTrade(
              analyses
            );

      if (selected) {
        lastSelected =
          selected;

        lastSelectedAt =
          nowMs();
      }
    }

    // ----------------------------------------------------------
    // Cursor advances by actual batch size.
    //
    // Even when provider blocks us, the cursor moves normally
    // so the next successful scan continues through the pair list.
    // ----------------------------------------------------------

    scanCursor =
      (
        scanCursor +
        SCAN_BATCH_SIZE
      ) %
      PAIRS.length;

    lastScanAt =
      new Date().toISOString();

    if (
      analyses.length &&
      !quotaBlocked
    ) {
      lastScanError =
        null;
    }
  } catch (error) {
    lastScanError =
      error.message;

    console.error(
      "[SCAN ERROR]",
      error
    );
  } finally {
    scanRunning =
      false;
  }
}

// ------------------------------------------------------------
// RANKING
// ------------------------------------------------------------

function rankAnalysis(
  analysis
) {
  if (!analysis) {
    return -Infinity;
  }

  let score =
    analysis.confidence ||
    0;

  const difference =
    Math.abs(
      (
        analysis.callScore ||
        0
      ) -
      (
        analysis.putScore ||
        0
      )
    );

  score +=
    difference *
    0.7;

  const adx =
    analysis.indicators
      ? analysis.indicators
          .adx14
      : null;

  if (
    Number.isFinite(adx) &&
    adx >= 25
  ) {
    score += 8;
  }

  const stochK =
    analysis.indicators
      ? analysis.indicators
          .stochasticK
      : null;

  const stochD =
    analysis.indicators
      ? analysis.indicators
          .stochasticD
      : null;

  if (
    Number.isFinite(
      stochK
    ) &&
    Number.isFinite(
      stochD
    )
  ) {
    if (
      analysis.signal ===
        "CALL" &&
      stochK > stochD
    ) {
      score += 4;
    }

    if (
      analysis.signal ===
        "PUT" &&
      stochK < stochD
    ) {
      score += 4;
    }
  }

  if (
    analysis.patterns &&
    analysis.patterns.length
  ) {
    score +=
      Math.min(
        analysis.patterns.length *
          2,
        6
      );
  }

  if (
    analysis.marketCondition ===
      "buyer pressure" &&
    analysis.signal ===
      "CALL"
  ) {
    score += 6;
  }

  if (
    analysis.marketCondition ===
      "seller pressure" &&
    analysis.signal ===
      "PUT"
  ) {
    score += 6;
  }

  return score;
}

function chooseBestNoTrade(
  analyses
) {
  if (
    !analyses.length
  ) {
    return null;
  }

  const sorted =
    [...analyses].sort(
      (a, b) =>
        Math.max(
          b.callScore || 0,
          b.putScore || 0
        ) -
        Math.max(
          a.callScore || 0,
          a.putScore || 0
        )
    );

  return sorted[0];
}

// ------------------------------------------------------------
// RESPONSE FORMAT
// ------------------------------------------------------------

function enrichSelected(
  analysis
) {
  if (!analysis) {
    return null;
  }

  const signalRecord =
    findSignalByKey(
      createSignalKey(
        analysis
      )
    );

  return {
    ...analysis,

    signalId:
      signalRecord
        ? signalRecord.signalId
        : null,

    result:
      signalRecord
        ? signalRecord.result
        : null,

    entryPrice:
      signalRecord
        ? signalRecord.entryPrice
        : null,

    exitPrice:
      signalRecord
        ? signalRecord.exitPrice
        : null,

    settlement:
      signalRecord
        ? {
            result:
              signalRecord.result,

            settledAt:
              signalRecord.settledAt,

            settlementSource:
              signalRecord.settlementSource
          }
        : null
  };
}

// ------------------------------------------------------------
// HEALTH / BUDGET
// ------------------------------------------------------------

function getApiBudget() {
  resetDailyBudgetIfNeeded();

  return {
    dailyLimit:
      DAILY_LIMIT,

    safetyReserve:
      DAILY_SAFETY_RESERVE,

    maxDailyRequests:
      MAX_DAILY_REQUESTS,

    used:
      dailyRequests,

    remaining:
      Math.max(
        0,
        MAX_DAILY_REQUESTS -
          dailyRequests
      )
  };
}

function getScannerData() {
  const minuteUsed =
    getMinuteRequestCount();

  const providerCooldown =
    getProviderCooldownSeconds();

  return {
    running:
      scanRunning,

    cursor:
      scanCursor,

    batchSize:
      SCAN_BATCH_SIZE,

    lastScanAt,

    lastScanError,

    totalScanned,

    totalFailed,

    totalApiRequests,

    provider429Count,

    lastProviderHttpStatus,

    lastProviderErrorAt,

    quotaBlocked,

    providerQuotaMessage,

    providerQuotaResetAt,

    providerCooldownSeconds:
      providerCooldown,

    minuteBlocked,

    minuteResetAt,

    minuteRetryInSeconds:
      getSecondsUntilMinuteReset(),

    dailyRequests,

    dailyCreditsUsed:
      dailyRequests,

    apiBudget:
      getApiBudget(),

    providerMinuteBudget: {
      configuredLimit:
        REQUEST_LIMIT_PER_MINUTE,

      usedLastMinute:
        minuteUsed,

      remaining:
        Math.max(
          0,
          REQUEST_LIMIT_PER_MINUTE -
            minuteUsed
        )
    }
  };
}

// ------------------------------------------------------------
// ROOT
// ------------------------------------------------------------

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "PO AI Predictor API",

      version:
        VERSION,

      source:
        SOURCE,

      message:
        "Backend is running."
    });
  }
);

// ------------------------------------------------------------
// HEALTH
// ------------------------------------------------------------

app.get(
  "/api/health",
  (req, res) => {
    const performance =
      getPerformance();

    const cacheEntries =
      Array.from(
        candleCache.values()
      );

    const cachedPairs =
      cacheEntries.length;

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

      cachedPairs,

      cachedResults:
        lastSelected
          ? 1
          : 0,

      scanRunning:
        scanRunning,

      scanCursor:
        scanCursor,

      scanBatchSize:
        SCAN_BATCH_SIZE,

      lastScanAt:
        lastScanAt,

      lastScanError:
        lastScanError,

      totalScanned:
        totalScanned,

      totalFailed:
        totalFailed,

      totalApiRequests:
        totalApiRequests,

      provider429Count:
        provider429Count,

      lastProviderHttpStatus:
        lastProviderHttpStatus,

      lastProviderErrorAt:
        lastProviderErrorAt,

      quotaBlocked:
        quotaBlocked,

      providerQuotaMessage:
        providerQuotaMessage,

      providerQuotaResetAt:
        providerQuotaResetAt,

      providerCooldownSeconds:
        getProviderCooldownSeconds(),

      minuteBlocked:
        minuteBlocked,

      minuteResetAt:
        minuteResetAt,

      minuteRetryInSeconds:
        getSecondsUntilMinuteReset(),

      dailyRequests:
        dailyRequests,

      dailyCreditsUsed:
        dailyRequests,

      apiBudget:
        getApiBudget(),

      providerMinuteBudget: {
        configuredLimit:
          REQUEST_LIMIT_PER_MINUTE,

        usedLastMinute:
          getMinuteRequestCount(),

        remaining:
          Math.max(
            0,
            REQUEST_LIMIT_PER_MINUTE -
              getMinuteRequestCount()
          )
      },

      cacheTTLMinutes:
        CACHE_TTL_MS /
        60000,

      resultTTLSeconds:
        RESULT_FRESH_MS /
        1000,

      scanEveryMinutes:
        SCAN_EVERY_MS /
        60000,

      settlementIntervalSeconds:
        SETTLEMENT_INTERVAL_MS /
        1000,

      settlementGraceSeconds:
        SETTLEMENT_GRACE_SECONDS,

      providerProtection: {
        requestLimitPerMinute:
          REQUEST_LIMIT_PER_MINUTE,

        provider429CooldownSeconds:
          DEFAULT_PROVIDER_COOLDOWN_SECONDS,

        maxProviderCooldownSeconds:
          MAX_PROVIDER_COOLDOWN_SECONDS,

        stopBatchOn429:
          true,

        retryAfterHeader:
          true
      },

      indicators: {
        ema9ema21:
          true,

        rsi14:
          true,

        adx14:
          true,

        stochastic:
          true,

        atr14:
          true,

        supportResistance:
          true,

        candlestickPatterns:
          true,

        marketPsychology:
          true,

        macd:
          false,

        cci20:
          false
      },

      signalTracking: {
        historySize:
          MAX_SIGNAL_HISTORY,

        performance
      },

      time:
        new Date().toISOString()
    });
  }
);

// ------------------------------------------------------------
// BEST
// ------------------------------------------------------------

app.get(
  "/api/best",
  (req, res) => {
    const selected =
      enrichSelected(
        lastSelected
      );

    const selectedAge =
      lastSelectedAt
        ? nowMs() -
          lastSelectedAt
        : null;

    const fresh =
      selectedAge != null &&
      selectedAge <=
        RESULT_FRESH_MS;

    res.json({
      ok:
        !!selected,

      version:
        VERSION,

      source:
        SOURCE,

      fresh,

      stale:
        selected
          ? !fresh
          : false,

      selectedMarket:
        selected,

      best:
        selected,

      selected:
        selected,

      market:
        selected,

      selectedAt:
        lastSelectedAt
          ? new Date(
              lastSelectedAt
            ).toISOString()
          : null,

      selectedAgeSeconds:
        selectedAge == null
          ? null
          : Math.floor(
              selectedAge /
                1000
            ),

      performance:
        getPerformance(),

      scan:
        getScannerData(),

      time:
        new Date().toISOString()
    });
  }
);

// ------------------------------------------------------------
// SELECTED
// ------------------------------------------------------------

app.get(
  "/api/selected",
  (req, res) => {
    const selected =
      enrichSelected(
        lastSelected
      );

    const selectedAge =
      lastSelectedAt
        ? nowMs() -
          lastSelectedAt
        : null;

    res.json({
      ok:
        !!selected,

      version:
        VERSION,

      source:
        SOURCE,

      fresh:
        selectedAge != null &&
        selectedAge <=
          RESULT_FRESH_MS,

      stale:
        selectedAge != null &&
        selectedAge >
          RESULT_FRESH_MS,

      selectedMarket:
        selected,

      best:
        selected,

      selected:
        selected,

      market:
        selected,

      performance:
        getPerformance(),

      scan:
        getScannerData(),

      time:
        new Date().toISOString()
    });
  }
);

// ------------------------------------------------------------
// PERFORMANCE
// ------------------------------------------------------------

app.get(
  "/api/performance",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      performance:
        getPerformance(),

      time:
        new Date().toISOString()
    });
  }
);

// ------------------------------------------------------------
// HISTORY
// ------------------------------------------------------------

app.get(
  "/api/history",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      count:
        signalHistory.length,

      performance:
        getPerformance(),

      signals:
        signalHistory,

      time:
        new Date().toISOString()
    });
  }
);

// ------------------------------------------------------------
// SCANNER
// ------------------------------------------------------------

app.get(
  "/api/scanner",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      ...getScannerData(),

      selectedMarket:
        enrichSelected(
          lastSelected
        ),

      time:
        new Date().toISOString()
    });
  }
);

// ------------------------------------------------------------
// ANALYZE
// ------------------------------------------------------------

app.get(
  "/api/analyze",
  async (req, res) => {
    const pair =
      normalizePair(
        req.query.pair
      );

    const timeframe =
      Number(
        req.query.timeframe ||
          1
      );

    if (
      !isSupportedPair(
        pair
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "Unsupported pair",

          pair,

          supportedPairs:
            PAIRS
        });
    }

    if (
      !isSupportedTimeframe(
        timeframe
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "Unsupported timeframe",

          timeframe,

          supportedTimeframes:
            TIMEFRAMES
        });
    }

    try {
      const candles =
        await getCandles(
          pair,
          {
            forceFresh:
              true
          }
        );

      const analysis =
        analyzeCandles(
          candles,
          pair,
          timeframe
        );

      const signalRecord =
        registerSignal(
          analysis
        );

      return res.json({
        ok: true,

        version:
          VERSION,

        source:
          SOURCE,

        analysis:
          enrichSelected(
            analysis
          ),

        signal:
          signalRecord,

        time:
          new Date().toISOString()
      });
    } catch (error) {
      return res
        .status(503)
        .json({
          ok: false,

          version:
            VERSION,

          error:
            error.message,

          errorCode:
            error.code ||
            null,

          retryAfterSeconds:
            error.retryAfterSeconds ||
            null,

          quota:
            getScannerData(),

          time:
            new Date().toISOString()
        });
    }
  }
);

// ------------------------------------------------------------
// 404
// ------------------------------------------------------------

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        ok: false,

        error:
          "Endpoint not found",

        path:
          req.path,

        version:
          VERSION
      });
  }
);

// ------------------------------------------------------------
// SERVER START
// ------------------------------------------------------------

app.listen(
  PORT,
  () => {
    console.log(
      "=================================================="
    );

    console.log(
      `PO AI PREDICTOR ${VERSION}`
    );

    console.log(
      `Source: ${SOURCE}`
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Pairs: ${PAIRS.length}`
    );

    console.log(
      `Timeframes: ${TIMEFRAMES.join(
        ", "
      )}`
    );

    console.log(
      "MACD: DISABLED"
    );

    console.log(
      "CCI20: DISABLED"
    );

    console.log(
      `Provider request limit: ${REQUEST_LIMIT_PER_MINUTE}/minute`
    );

    console.log(
      `Scanner batch: ${SCAN_BATCH_SIZE}`
    );

    console.log(
      `Scanner interval: ${
        SCAN_EVERY_MS /
        1000
      } seconds`
    );

    console.log(
      `Settlement interval: ${
        SETTLEMENT_INTERVAL_MS /
        1000
      } seconds`
    );

    console.log(
      `Provider 429 cooldown: ${DEFAULT_PROVIDER_COOLDOWN_SECONDS} seconds`
    );

    console.log(
      `Daily max requests: ${MAX_DAILY_REQUESTS}`
    );

    console.log(
      "=================================================="
    );

    // Initial scan shortly after startup.
    setTimeout(
      () => {
        scanNextBatch().catch(
          (error) => {
            console.error(
              "[INITIAL SCAN]",
              error
            );
          }
        );
      },
      3000
    );
  }
);

// ------------------------------------------------------------
// SCANNER TIMER
// ------------------------------------------------------------

setInterval(
  () => {
    scanNextBatch().catch(
      (error) => {
        console.error(
          "[SCAN TIMER]",
          error
        );
      }
    );
  },
  SCAN_EVERY_MS
);

// ------------------------------------------------------------
// SETTLEMENT TIMER
// ------------------------------------------------------------

setInterval(
  () => {
    settlePendingSignals().catch(
      (error) => {
        console.error(
          "[SETTLEMENT TIMER]",
          error
        );
      }
    );
  },
  SETTLEMENT_INTERVAL_MS
);

// ------------------------------------------------------------
// STATE MAINTENANCE
// ------------------------------------------------------------

setInterval(
  () => {
    cleanupMinuteRequests();

    clearProviderCooldownIfExpired();

    if (
      getMinuteRequestCount() <
      REQUEST_LIMIT_PER_MINUTE
    ) {
      minuteBlocked = false;

      minuteResetAt = null;
    }

    resetDailyBudgetIfNeeded();
  },
  5000
);

// ------------------------------------------------------------
// PROCESS SAFETY
// ------------------------------------------------------------

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "[UNHANDLED REJECTION]",
      error
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[UNCAUGHT EXCEPTION]",
      error
    );
  }
);
