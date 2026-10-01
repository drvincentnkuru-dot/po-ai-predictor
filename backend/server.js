// ============================================================
// PO AI PREDICTOR
// BACKEND V8.3.1
// SMART PRICE-ACTION SCANNER
// LIVE ONLY - TWELVE DATA
// UTC TIME SYNC
// FRESHNESS + LOCATION FILTER
// ============================================================

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 10000;

const TWELVE_DATA_API_KEY =
    process.env.TWELVE_DATA_API_KEY || "";

const TWELVE_DATA_URL =
    "https://api.twelvedata.com/time_series";

const VERSION = "V8.3.1";

const TIMEFRAMES = [1, 2, 3];

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

const MAX_CANDLES = 180;
const MIN_CANDLES = 60;

const SCAN_BATCH_SIZE = 8;
const SCAN_EVERY_MS = 60000;

const FETCH_TIMEOUT_MS = 12000;
const REQUEST_DELAY_MS = 150;

const ENTRY_BUFFER_SECONDS = 30;

// ============================================================
// V8.3.1 SMART FILTER SETTINGS
// ============================================================

// Latest completed 1-minute candle should normally be recent.
// If data is older than this, signal becomes NO TRADE.
const MAX_DATA_AGE_SECONDS = 90;

// Very stale data is treated as unusable.
const HARD_STALE_SECONDS = 180;

// Location filter based mainly on ATR.
const SUPPORT_RISK_ATR_MULTIPLIER = 0.75;
const RESISTANCE_RISK_ATR_MULTIPLIER = 0.75;

// Extremely narrow support/resistance range can create
// contradictory "near support" + "near resistance" conditions.
const MIN_SR_RANGE_ATR_MULTIPLIER = 1.20;

// ============================================================
// CACHE / SCANNER STATE
// ============================================================

const cache = new Map();

let scanRunning = false;
let scanCursor = 0;
let lastScanAt = null;
let lastScanError = null;
let totalScanned = 0;

// ============================================================
// BASIC HELPERS
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 5) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return null;
    }

    return Number(n.toFixed(decimals));
}

function average(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }

    const valid = values
        .map(Number)
        .filter(Number.isFinite);

    if (!valid.length) {
        return null;
    }

    return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function median(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }

    const valid = values
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

    if (!valid.length) {
        return null;
    }

    const middle = Math.floor(valid.length / 2);

    if (valid.length % 2 === 0) {
        return (valid[middle - 1] + valid[middle]) / 2;
    }

    return valid[middle];
}

function safeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function isoNow() {
    return new Date().toISOString();
}

// ============================================================
// TIME HELPERS
// ============================================================

function parseUTCDate(value) {
    if (!value) {
        return null;
    }

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
        return null;
    }

    return d;
}

function getDataAgeSeconds(lastCandleTime) {
    const candleDate = parseUTCDate(lastCandleTime);

    if (!candleDate) {
        return null;
    }

    return Math.max(
        0,
        Math.floor(
            (Date.now() - candleDate.getTime()) / 1000
        )
    );
}

function nextEntryTime(timeframe) {
    const now = new Date();

    const seconds =
        now.getUTCSeconds();

    const milliseconds =
        now.getUTCMilliseconds();

    const totalSecondsIntoMinute =
        seconds + milliseconds / 1000;

    let minutesToAdd =
        timeframe -
        (now.getUTCMinutes() % timeframe);

    if (
        now.getUTCMinutes() % timeframe === 0 &&
        totalSecondsIntoMinute < 1
    ) {
        minutesToAdd = timeframe;
    }

    const entry =
        new Date(
            now.getTime() +
            minutesToAdd * 60000 -
            seconds * 1000 -
            milliseconds
        );

    // Safety: make absolutely sure entry is >= buffer.
    const minimumEntry =
        new Date(
            now.getTime() +
            ENTRY_BUFFER_SECONDS * 1000
        );

    if (entry.getTime() < minimumEntry.getTime()) {
        const candidate =
            new Date(
                minimumEntry.getTime()
            );

        const remainder =
            candidate.getUTCMinutes() % timeframe;

        if (remainder !== 0) {
            candidate.setUTCMinutes(
                candidate.getUTCMinutes() +
                (timeframe - remainder)
            );
        }

        candidate.setUTCSeconds(0, 0);

        return candidate;
    }

    return entry;
}

function buildEntryExpiry(timeframe) {
    const entry = nextEntryTime(timeframe);

    const expiry =
        new Date(
            entry.getTime() +
            timeframe * 60000
        );

    const entryInSeconds =
        Math.max(
            0,
            Math.floor(
                (entry.getTime() - Date.now()) / 1000
            )
        );

    return {
        entryTime: entry.toISOString(),
        expiryTime: expiry.toISOString(),
        entryInSeconds
    };
}

// ============================================================
// FETCH TWELVE DATA
// ============================================================

async function fetchCandles(pair) {
    if (!TWELVE_DATA_API_KEY) {
        throw new Error(
            "TWELVE_DATA_API_KEY is not configured."
        );
    }

    const url =
        new URL(TWELVE_DATA_URL);

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
        "timezone",
        "UTC"
    );

    url.searchParams.set(
        "apikey",
        TWELVE_DATA_API_KEY
    );

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => controller.abort(),
            FETCH_TIMEOUT_MS
        );

    try {
        const response =
            await fetch(
                url.toString(),
                {
                    method: "GET",
                    signal: controller.signal,
                    headers: {
                        "Accept":
                            "application/json"
                    }
                }
            );

        const text =
            await response.text();

        if (!response.ok) {
            throw new Error(
                `Twelve Data HTTP ${response.status}: ${text.slice(0, 300)}`
            );
        }

        let data;

        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(
                "Twelve Data returned invalid JSON."
            );
        }

        if (data.status === "error") {
            throw new Error(
                data.message ||
                "Twelve Data returned an error."
            );
        }

        if (!Array.isArray(data.values)) {
            throw new Error(
                "Twelve Data returned no candle values."
            );
        }

        const candles =
            data.values
                .map(c => ({
                    datetime:
                        c.datetime,

                    open:
                        safeNumber(c.open),

                    high:
                        safeNumber(c.high),

                    low:
                        safeNumber(c.low),

                    close:
                        safeNumber(c.close)
                }))
                .filter(c =>
                    c.datetime &&
                    Number.isFinite(c.open) &&
                    Number.isFinite(c.high) &&
                    Number.isFinite(c.low) &&
                    Number.isFinite(c.close)
                );

        if (candles.length < MIN_CANDLES) {
            throw new Error(
                `Insufficient candles: ${candles.length}/${MIN_CANDLES}`
            );
        }

        // --------------------------------------------------------
        // IMPORTANT:
        // Remove current forming candle.
        // We only analyze completed candles.
        // --------------------------------------------------------

        const now = Date.now();

        const completed =
            candles.filter(c => {
                const t =
                    parseUTCDate(
                        c.datetime
                    );

                if (!t) {
                    return false;
                }

                return (
                    t.getTime() <= now - 1000
                );
            });

        if (completed.length < MIN_CANDLES) {
            throw new Error(
                `Not enough completed candles: ${completed.length}/${MIN_CANDLES}`
            );
        }

        return completed.slice(-MAX_CANDLES);

    } finally {
        clearTimeout(timeout);
    }
}

// ============================================================
// OHLC AGGREGATION
// ============================================================

function aggregateCandles(
    candles,
    timeframe
) {
    if (timeframe === 1) {
        return candles.slice();
    }

    const groups = [];

    for (
        let i = 0;
        i < candles.length;
        i++
    ) {
        const candle =
            candles[i];

        const d =
            parseUTCDate(
                candle.datetime
            );

        if (!d) {
            continue;
        }

        const minute =
            d.getUTCMinutes();

        const groupMinute =
            minute -
            (minute % timeframe);

        const key =
            `${d.getUTCFullYear()}-${String(
                d.getUTCMonth() + 1
            ).padStart(2, "0")}-${String(
                d.getUTCDate()
            ).padStart(2, "0")}T${String(
                d.getUTCHours()
            ).padStart(2, "0")}:${String(
                groupMinute
            ).padStart(2, "0")}:00.000Z`;

        let group =
            groups.find(
                g => g.key === key
            );

        if (!group) {
            group = {
                key,
                candles: []
            };

            groups.push(group);
        }

        group.candles.push(candle);
    }

    return groups
        .filter(
            g =>
                g.candles.length >= timeframe
        )
        .map(g => {
            const first =
                g.candles[0];

            const last =
                g.candles[
                    g.candles.length - 1
                ];

            return {
                datetime:
                    g.key,

                open:
                    first.open,

                high:
                    Math.max(
                        ...g.candles.map(
                            c => c.high
                        )
                    ),

                low:
                    Math.min(
                        ...g.candles.map(
                            c => c.low
                        )
                    ),

                close:
                    last.close
            };
        });
}

// ============================================================
// EMA
// ============================================================

function calculateEMA(
    values,
    period
) {
    if (
        !Array.isArray(values) ||
        values.length < period
    ) {
        return null;
    }

    const multiplier =
        2 / (period + 1);

    let ema =
        average(
            values.slice(0, period)
        );

    if (ema === null) {
        return null;
    }

    for (
        let i = period;
        i < values.length;
        i++
    ) {
        ema =
            (
                values[i] - ema
            ) *
            multiplier +
            ema;
    }

    return ema;
}

// ============================================================
// RSI
// ============================================================

function calculateRSI(
    closes,
    period = 14
) {
    if (
        !Array.isArray(closes) ||
        closes.length <= period
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
        const change =
            closes[i] -
            closes[i - 1];

        if (change > 0) {
            gains += change;
        } else {
            losses += Math.abs(change);
        }
    }

    let avgGain =
        gains / period;

    let avgLoss =
        losses / period;

    for (
        let i = period + 1;
        i < closes.length;
        i++
    ) {
        const change =
            closes[i] -
            closes[i - 1];

        const gain =
            change > 0
                ? change
                : 0;

        const loss =
            change < 0
                ? Math.abs(change)
                : 0;

        avgGain =
            (
                avgGain *
                (period - 1) +
                gain
            ) / period;

        avgLoss =
            (
                avgLoss *
                (period - 1) +
                loss
            ) / period;
    }

    if (avgLoss === 0) {
        return 100;
    }

    const rs =
        avgGain / avgLoss;

    return (
        100 -
        100 / (1 + rs)
    );
}

// ============================================================
// ATR
// ============================================================

function calculateATR(
    candles,
    period = 14
) {
    if (
        !Array.isArray(candles) ||
        candles.length <= period
    ) {
        return null;
    }

    const trueRanges = [];

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

        trueRanges.push(tr);
    }

    if (
        trueRanges.length < period
    ) {
        return null;
    }

    let atr =
        average(
            trueRanges.slice(
                0,
                period
            )
        );

    for (
        let i = period;
        i < trueRanges.length;
        i++
    ) {
        atr =
            (
                atr *
                (period - 1) +
                trueRanges[i]
            ) / period;
    }

    return atr;
}

// ============================================================
// ADX
// ============================================================

function calculateADX(
    candles,
    period = 14
) {
    if (
        !Array.isArray(candles) ||
        candles.length < period * 2 + 1
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
        trs.length < period * 2
    ) {
        return null;
    }

    let smoothedTR =
        trs
            .slice(0, period)
            .reduce(
                (a, b) => a + b,
                0
            );

    let smoothedPlus =
        plusDM
            .slice(0, period)
            .reduce(
                (a, b) => a + b,
                0
            );

    let smoothedMinus =
        minusDM
            .slice(0, period)
            .reduce(
                (a, b) => a + b,
                0
            );

    const dxValues = [];

    for (
        let i = period;
        i < trs.length;
        i++
    ) {
        if (i > period) {
            smoothedTR =
                smoothedTR -
                smoothedTR / period +
                trs[i];

            smoothedPlus =
                smoothedPlus -
                smoothedPlus / period +
                plusDM[i];

            smoothedMinus =
                smoothedMinus -
                smoothedMinus / period +
                minusDM[i];
        }

        const plusDI =
            smoothedTR === 0
                ? 0
                : 100 *
                  smoothedPlus /
                  smoothedTR;

        const minusDI =
            smoothedTR === 0
                ? 0
                : 100 *
                  smoothedMinus /
                  smoothedTR;

        const denominator =
            plusDI + minusDI;

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

    let adx =
        average(
            dxValues.slice(
                0,
                period
            )
        );

    for (
        let i = period;
        i < dxValues.length;
        i++
    ) {
        adx =
            (
                adx *
                (period - 1) +
                dxValues[i]
            ) / period;
    }

    return adx;
}

// ============================================================
// SUPPORT / RESISTANCE
// ============================================================

function calculateSupportResistance(
    candles
) {
    const recent =
        candles.slice(-40);

    if (!recent.length) {
        return {
            support: null,
            resistance: null
        };
    }

    const lows =
        recent.map(c => c.low);

    const highs =
        recent.map(c => c.high);

    return {
        support:
            Math.min(...lows),

        resistance:
            Math.max(...highs)
    };
}

// ============================================================
// CANDLESTICK PATTERNS
// ============================================================

function candleInfo(
    candle
) {
    const body =
        Math.abs(
            candle.close -
            candle.open
        );

    const range =
        candle.high -
        candle.low;

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

    const bullish =
        candle.close >
        candle.open;

    const bearish =
        candle.close <
        candle.open;

    return {
        body,
        range,
        upperWick,
        lowerWick,
        bullish,
        bearish
    };
}

function detectCandlestickPattern(
    candles,
    support,
    resistance
) {
    if (candles.length < 3) {
        return {
            pattern: "NONE",
            direction: "NONE",
            score: 0,
            strength: 0,
            description: ""
        };
    }

    const current =
        candles[candles.length - 1];

    const previous =
        candles[candles.length - 2];

    const ci =
        candleInfo(current);

    const pi =
        candleInfo(previous);

    const price =
        current.close;

    const atr =
        calculateATR(
            candles,
            14
        ) || ci.range;

    const nearSupport =
        support !== null &&
        Math.abs(price - support) <=
            atr * 0.9;

    const nearResistance =
        resistance !== null &&
        Math.abs(resistance - price) <=
            atr * 0.9;

    // --------------------------------------------------------
    // Bullish engulfing
    // --------------------------------------------------------

    const bullishEngulfing =
        pi.bearish &&
        ci.bullish &&
        current.open <=
            previous.close &&
        current.close >=
            previous.open &&
        ci.body > pi.body;

    if (
        bullishEngulfing &&
        nearSupport
    ) {
        return {
            pattern:
                "BULLISH ENGULFING",
            direction: "CALL",
            score: 15,
            strength: 90,
            description:
                "Bullish engulfing near support indicates strong buyer rejection."
        };
    }

    // --------------------------------------------------------
    // Bearish engulfing
    // --------------------------------------------------------

    const bearishEngulfing =
        pi.bullish &&
        ci.bearish &&
        current.open >=
            previous.close &&
        current.close <=
            previous.open &&
        ci.body > pi.body;

    if (
        bearishEngulfing &&
        nearResistance
    ) {
        return {
            pattern:
                "BEARISH ENGULFING",
            direction: "PUT",
            score: 15,
            strength: 90,
            description:
                "Bearish engulfing near resistance indicates strong seller rejection."
        };
    }

    // --------------------------------------------------------
    // Hammer
    // --------------------------------------------------------

    const hammer =
        ci.lowerWick >=
            ci.body * 2 &&
        ci.upperWick <=
            Math.max(ci.body * 0.7, 0.0000001);

    if (
        hammer &&
        nearSupport
    ) {
        return {
            pattern:
                "HAMMER AT SUPPORT",
            direction: "CALL",
            score: 13,
            strength: 85,
            description:
                "Long lower wick shows rejection of lower prices near support."
        };
    }

    // --------------------------------------------------------
    // Shooting star
    // --------------------------------------------------------

    const shootingStar =
        ci.upperWick >=
            ci.body * 2 &&
        ci.lowerWick <=
            Math.max(ci.body * 0.7, 0.0000001);

    if (
        shootingStar &&
        nearResistance
    ) {
        return {
            pattern:
                "SHOOTING STAR AT RESISTANCE",
            direction: "PUT",
            score: 13,
            strength: 85,
            description:
                "Long upper wick shows rejection of higher prices near resistance."
        };
    }

    // --------------------------------------------------------
    // Bullish pin bar
    // --------------------------------------------------------

    if (
        ci.lowerWick >=
            ci.range * 0.55 &&
        ci.lowerWick >
            ci.upperWick * 1.5 &&
        nearSupport
    ) {
        return {
            pattern:
                "BULLISH PIN BAR",
            direction: "CALL",
            score: 12,
            strength: 80,
            description:
                "Lower-wick rejection indicates buyers defending lower prices."
        };
    }

    // --------------------------------------------------------
    // Bearish pin bar
    // --------------------------------------------------------

    if (
        ci.upperWick >=
            ci.range * 0.55 &&
        ci.upperWick >
            ci.lowerWick * 1.5 &&
        nearResistance
    ) {
        return {
            pattern:
                "BEARISH PIN BAR",
            direction: "PUT",
            score: 12,
            strength: 80,
            description:
                "Upper-wick rejection indicates sellers defending higher prices."
        };
    }

    // --------------------------------------------------------
    // Strong candle
    // --------------------------------------------------------

    if (
        ci.range > 0 &&
        ci.body / ci.range >= 0.70
    ) {
        if (ci.bullish) {
            return {
                pattern:
                    "STRONG BULLISH CANDLE",
                direction: "CALL",
                score: 10,
                strength: 75,
                description:
                    "Large bullish body indicates strong short-term upward momentum."
            };
        }

        if (ci.bearish) {
            return {
                pattern:
                    "STRONG BEARISH CANDLE",
                direction: "PUT",
                score: 10,
                strength: 75,
                description:
                    "Large bearish body indicates strong short-term downward momentum."
            };
        }
    }

    // --------------------------------------------------------
    // Doji
    // --------------------------------------------------------

    if (
        ci.range > 0 &&
        ci.body / ci.range <= 0.15
    ) {
        return {
            pattern: "DOJI / INDECISION",
            direction: "NONE",
            score: 0,
            strength: 35,
            description:
                "Small candle body indicates market indecision."
        };
    }

    return {
        pattern: "NONE",
        direction: "NONE",
        score: 0,
        strength: 0,
        description: ""
    };
}

// ============================================================
// PRICE ACTION / MARKET PSYCHOLOGY
// ============================================================

function analyzePriceAction(
    candles,
    support,
    resistance,
    ema9,
    ema21,
    atr
) {
    const current =
        candles[candles.length - 1];

    const previous =
        candles[candles.length - 2];

    const ci =
        candleInfo(current);

    const previousInfo =
        candleInfo(previous);

    const price =
        current.close;

    let callScore = 0;
    let putScore = 0;

    const observations = [];

    // --------------------------------------------------------
    // Support / resistance distance
    // --------------------------------------------------------

    const supportDistance =
        support !== null
            ? Math.abs(
                  price - support
              )
            : Infinity;

    const resistanceDistance =
        resistance !== null
            ? Math.abs(
                  resistance - price
              )
            : Infinity;

    const supportNear =
        Number.isFinite(atr) &&
        supportDistance <=
            atr * 0.9;

    const resistanceNear =
        Number.isFinite(atr) &&
        resistanceDistance <=
            atr * 0.9;

    // --------------------------------------------------------
    // Wick rejection
    // --------------------------------------------------------

    if (
        ci.lowerWick >
            ci.upperWick * 1.5 &&
        ci.lowerWick >
            ci.body &&
        supportNear
    ) {
        callScore += 6;

        observations.push(
            "BUYERS DEFENDING SUPPORT"
        );
    }

    if (
        ci.upperWick >
            ci.lowerWick * 1.5 &&
        ci.upperWick >
            ci.body &&
        resistanceNear
    ) {
        putScore += 6;

        observations.push(
            "SELLERS REJECTING RESISTANCE"
        );
    }

    // --------------------------------------------------------
    // EMA structure
    // --------------------------------------------------------

    if (
        ema9 !== null &&
        ema21 !== null
    ) {
        if (
            price > ema9 &&
            ema9 > ema21
        ) {
            callScore += 5;

            observations.push(
                "PRICE ABOVE BULLISH EMA STRUCTURE"
            );
        }

        if (
            price < ema9 &&
            ema9 < ema21
        ) {
            putScore += 5;

            observations.push(
                "PRICE BELOW BEARISH EMA STRUCTURE"
            );
        }
    }

    // --------------------------------------------------------
    // Strong body
    // --------------------------------------------------------

    if (
        ci.range > 0 &&
        ci.body / ci.range >= 0.65
    ) {
        if (ci.bullish) {
            callScore += 4;

            observations.push(
                "STRONG BULLISH CANDLE BODY"
            );
        }

        if (ci.bearish) {
            putScore += 4;

            observations.push(
                "STRONG BEARISH CANDLE BODY"
            );
        }
    }

    // --------------------------------------------------------
    // Momentum acceleration
    // --------------------------------------------------------

    const currentBody =
        Math.abs(
            current.close -
            current.open
        );

    const previousBody =
        Math.abs(
            previous.close -
            previous.open
        );

    if (
        currentBody >
            previousBody * 1.25
    ) {
        if (ci.bullish) {
            callScore += 3;

            observations.push(
                "BULLISH MOMENTUM ACCELERATION"
            );
        }

        if (ci.bearish) {
            putScore += 3;

            observations.push(
                "BEARISH MOMENTUM ACCELERATION"
            );
        }
    }

    // --------------------------------------------------------
    // Indecision
    // --------------------------------------------------------

    if (
        ci.range > 0 &&
        ci.body / ci.range <= 0.18
    ) {
        observations.push(
            "MARKET INDECISION"
        );
    }

    const finalCall =
        clamp(callScore, 0, 15);

    const finalPut =
        clamp(putScore, 0, 15);

    let direction = "NONE";

    if (
        finalCall > finalPut &&
        finalCall >= 5
    ) {
        direction = "CALL";
    } else if (
        finalPut > finalCall &&
        finalPut >= 5
    ) {
        direction = "PUT";
    }

    let psychology =
        "BALANCED PRICE ACTION";

    if (
        direction === "CALL"
    ) {
        psychology =
            "BUYER PRICE-ACTION PRESSURE";
    }

    if (
        direction === "PUT"
    ) {
        psychology =
            "SELLER PRICE-ACTION PRESSURE";
    }

    return {
        direction,
        score:
            Math.max(
                finalCall,
                finalPut
            ),
        callScore:
            finalCall,
        putScore:
            finalPut,
        psychology,
        observations:
            [...new Set(observations)]
    };
}

// ============================================================
// MARKET TREND
// ============================================================

function determineTrend(
    price,
    ema9,
    ema21,
    adx,
    rsi
) {
    if (
        ema9 === null ||
        ema21 === null
    ) {
        return "UNKNOWN";
    }

    const strong =
        adx !== null &&
        adx >= 25;

    if (
        ema9 > ema21 &&
        price > ema9
    ) {
        if (
            strong &&
            rsi !== null &&
            rsi >= 55
        ) {
            return "STRONG UPTREND";
        }

        return "UPTREND";
    }

    if (
        ema9 < ema21 &&
        price < ema9
    ) {
        if (
            strong &&
            rsi !== null &&
            rsi <= 45
        ) {
            return "STRONG DOWNTREND";
        }

        return "DOWNTREND";
    }

    return "RANGING";
}

// ============================================================
// SMART LOCATION FILTER
// ============================================================

function analyzeLocation(
    price,
    support,
    resistance,
    atr,
    rawDirection
) {
    if (
        !Number.isFinite(price) ||
        !Number.isFinite(atr) ||
        atr <= 0
    ) {
        return {
            bias: "UNKNOWN",
            risk: "HIGH",
            blocked: true,
            reason:
                "Unable to validate price location."
        };
    }

    const supportDistance =
        Math.max(
            0,
            price - support
        );

    const resistanceDistance =
        Math.max(
            0,
            resistance - price
        );

    const supportRiskDistance =
        atr *
        SUPPORT_RISK_ATR_MULTIPLIER;

    const resistanceRiskDistance =
        atr *
        RESISTANCE_RISK_ATR_MULTIPLIER;

    const srRange =
        Math.max(
            0,
            resistance - support
        );

    const narrowRange =
        srRange <
        atr *
            MIN_SR_RANGE_ATR_MULTIPLIER;

    const nearSupport =
        supportDistance <=
        supportRiskDistance;

    const nearResistance =
        resistanceDistance <=
        resistanceRiskDistance;

    // --------------------------------------------------------
    // Ambiguous location
    // --------------------------------------------------------

    if (
        nearSupport &&
        nearResistance
    ) {
        return {
            bias: "AMBIGUOUS",
            risk: "HIGH",
            blocked: true,
            reason:
                "Support and resistance are too close for a clean directional setup."
        };
    }

    // --------------------------------------------------------
    // PUT too close to support
    // --------------------------------------------------------

    if (
        rawDirection === "PUT" &&
        nearSupport
    ) {
        return {
            bias: "SUPPORT",
            risk: "HIGH",
            blocked: true,
            reason:
                "PUT blocked because price is too close to support."
        };
    }

    // --------------------------------------------------------
    // CALL too close to resistance
    // --------------------------------------------------------

    if (
        rawDirection === "CALL" &&
        nearResistance
    ) {
        return {
            bias: "RESISTANCE",
            risk: "HIGH",
            blocked: true,
            reason:
                "CALL blocked because price is too close to resistance."
        };
    }

    // --------------------------------------------------------
    // Narrow range
    // --------------------------------------------------------

    if (narrowRange) {
        return {
            bias: "NARROW_RANGE",
            risk: "MEDIUM",
            blocked: true,
            reason:
                "Support/resistance range is too narrow relative to current volatility."
        };
    }

    // --------------------------------------------------------
    // Price location
    // --------------------------------------------------------

    if (nearSupport) {
        return {
            bias: "NEAR_SUPPORT",
            risk: "MEDIUM",
            blocked: false,
            reason:
                "Price is near support."
        };
    }

    if (nearResistance) {
        return {
            bias: "NEAR_RESISTANCE",
            risk: "MEDIUM",
            blocked: false,
            reason:
                "Price is near resistance."
        };
    }

    return {
        bias: "OPEN_ZONE",
        risk: "LOW",
        blocked: false,
        reason:
            "Price is in an open area between support and resistance."
    };
}

// ============================================================
// BUILD ANALYSIS
// ============================================================

function analyzeTimeframe(
    pair,
    candles,
    timeframe
) {
    const tfCandles =
        aggregateCandles(
            candles,
            timeframe
        );

    if (
        tfCandles.length < 30
    ) {
        throw new Error(
            `Not enough ${timeframe}m candles.`
        );
    }

    const closes =
        tfCandles.map(
            c => c.close
        );

    const current =
        tfCandles[
            tfCandles.length - 1
        ];

    const price =
        current.close;

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

    const rsi =
        calculateRSI(
            closes,
            14
        );

    const adx =
        calculateADX(
            tfCandles,
            14
        );

    const atr =
        calculateATR(
            tfCandles,
            14
        );

    const {
        support,
        resistance
    } =
        calculateSupportResistance(
            tfCandles
        );

    const candlePattern =
        detectCandlestickPattern(
            tfCandles,
            support,
            resistance
        );

    const priceAction =
        analyzePriceAction(
            tfCandles,
            support,
            resistance,
            ema9,
            ema21,
            atr
        );

    const trend =
        determineTrend(
            price,
            ema9,
            ema21,
            adx,
            rsi
        );

    // ========================================================
    // SCORING
    // ========================================================

    let callScore = 0;
    let putScore = 0;

    const reasons = [];

    // --------------------------------------------------------
    // EMA = 28 points
    // --------------------------------------------------------

    if (
        ema9 !== null &&
        ema21 !== null
    ) {
        if (ema9 > ema21) {
            callScore += 28;

            reasons.push(
                "EMA9 is above EMA21."
            );
        } else if (
            ema9 < ema21
        ) {
            putScore += 28;

            reasons.push(
                "EMA9 is below EMA21."
            );
        }
    }

    // --------------------------------------------------------
    // RSI = 18 points
    // --------------------------------------------------------

    if (rsi !== null) {
        if (rsi >= 55) {
            callScore += 18;

            reasons.push(
                `RSI bullish at ${round(rsi, 2)}.`
            );
        } else if (
            rsi <= 45
        ) {
            putScore += 18;

            reasons.push(
                `RSI bearish at ${round(rsi, 2)}.`
            );
        }
    }

    // --------------------------------------------------------
    // ADX = 22 points
    // --------------------------------------------------------

    if (adx !== null) {
        if (adx >= 25) {
            if (
                ema9 !== null &&
                ema21 !== null
            ) {
                if (ema9 > ema21) {
                    callScore += 22;

                    reasons.push(
                        `ADX ${round(adx, 2)} confirms trend strength.`
                    );
                } else if (
                    ema9 < ema21
                ) {
                    putScore += 22;

                    reasons.push(
                        `ADX ${round(adx, 2)} confirms trend strength.`
                    );
                }
            }
        } else {
            reasons.push(
                `ADX ${round(adx, 2)} indicates weaker trend strength.`
            );
        }
    }

    // --------------------------------------------------------
    // Price vs EMA = 12 points
    // --------------------------------------------------------

    if (
        ema9 !== null
    ) {
        if (
            price > ema9
        ) {
            callScore += 12;

            reasons.push(
                "Price is above EMA9."
            );
        } else if (
            price < ema9
        ) {
            putScore += 12;

            reasons.push(
                "Price is below EMA9."
            );
        }
    }

    // --------------------------------------------------------
    // Support / resistance = 20 points
    // --------------------------------------------------------

    const atrForLocation =
        atr ||
        Math.abs(
            resistance -
            support
        ) / 10;

    const rawDirection =
        callScore > putScore
            ? "CALL"
            : putScore > callScore
                ? "PUT"
                : "NONE";

    const location =
        analyzeLocation(
            price,
            support,
            resistance,
            atrForLocation,
            rawDirection
        );

    if (
        rawDirection === "CALL" &&
        location.bias ===
            "NEAR_SUPPORT"
    ) {
        callScore += 20;

        reasons.push(
            "Price is reacting near support."
        );
    }

    if (
        rawDirection === "PUT" &&
        location.bias ===
            "NEAR_RESISTANCE"
    ) {
        putScore += 20;

        reasons.push(
            "Price is reacting near resistance."
        );
    }

    // --------------------------------------------------------
    // Candlestick score
    // --------------------------------------------------------

    if (
        candlePattern.direction ===
        "CALL"
    ) {
        callScore +=
            candlePattern.score;

        if (
            candlePattern.description
        ) {
            reasons.push(
                `${candlePattern.pattern}: ${candlePattern.description}`
            );
        }
    }

    if (
        candlePattern.direction ===
        "PUT"
    ) {
        putScore +=
            candlePattern.score;

        if (
            candlePattern.description
        ) {
            reasons.push(
                `${candlePattern.pattern}: ${candlePattern.description}`
            );
        }
    }

    // --------------------------------------------------------
    // Price action score
    // --------------------------------------------------------

    if (
        priceAction.direction ===
        "CALL"
    ) {
        callScore +=
            priceAction.callScore;
    }

    if (
        priceAction.direction ===
        "PUT"
    ) {
        putScore +=
            priceAction.putScore;
    }

    if (
        priceAction.observations.length
    ) {
        reasons.push(
            ...priceAction.observations
        );
    }

    // ========================================================
    // RAW SIGNAL
    // ========================================================

    const difference =
        Math.abs(
            callScore -
            putScore
        );

    let signal = "NO TRADE";

    if (
        callScore >= 65 &&
        callScore > putScore &&
        difference >= 15
    ) {
        signal = "CALL";
    } else if (
        putScore >= 65 &&
        putScore > callScore &&
        difference >= 15
    ) {
        signal = "PUT";
    }

    // ========================================================
    // CONFLICT FILTER
    // ========================================================

    if (
        signal === "CALL" &&
        candlePattern.direction ===
            "PUT" &&
        candlePattern.strength >= 75 &&
        priceAction.direction ===
            "PUT" &&
        adx !== null &&
        adx >= 30
    ) {
        signal = "NO TRADE";

        reasons.push(
            "CALL blocked by strong bearish price-action conflict."
        );
    }

    if (
        signal === "PUT" &&
        candlePattern.direction ===
            "CALL" &&
        candlePattern.strength >= 75 &&
        priceAction.direction ===
            "CALL" &&
        adx !== null &&
        adx >= 30
    ) {
        signal = "NO TRADE";

        reasons.push(
            "PUT blocked by strong bullish price-action conflict."
        );
    }

    // ========================================================
    // LOCATION FILTER
    // ========================================================

    if (
        location.blocked &&
        (
            signal === "CALL" ||
            signal === "PUT"
        )
    ) {
        signal = "NO TRADE";

        reasons.push(
            location.reason
        );
    }

    // ========================================================
    // FRESHNESS FILTER
    // ========================================================

    const lastCandle =
        candles[
            candles.length - 1
        ];

    const lastCandleTime =
        lastCandle
            ? lastCandle.datetime
            : null;

    const dataAgeSeconds =
        getDataAgeSeconds(
            lastCandleTime
        );

    let dataFresh = true;
    let freshnessStatus = "FRESH";
    let staleReason = null;

    if (
        dataAgeSeconds === null
    ) {
        dataFresh = false;
        freshnessStatus = "UNKNOWN";
        staleReason =
            "Latest candle timestamp is unavailable.";
    } else if (
        dataAgeSeconds >
        HARD_STALE_SECONDS
    ) {
        dataFresh = false;
        freshnessStatus = "STALE";
        staleReason =
            `Data is critically stale (${dataAgeSeconds}s old).`;
    } else if (
        dataAgeSeconds >
        MAX_DATA_AGE_SECONDS
    ) {
        dataFresh = false;
        freshnessStatus = "STALE";
        staleReason =
            `Data is stale (${dataAgeSeconds}s old).`;
    }

    if (!dataFresh) {
        signal = "NO TRADE";

        reasons.push(
            staleReason
        );
    }

    // ========================================================
    // FINAL CONFIDENCE
    // ========================================================

    const strongestScore =
        Math.max(
            callScore,
            putScore
        );

    let confidence =
        clamp(
            Math.round(
                strongestScore
            ),
            40,
            95
        );

    if (
        signal === "NO TRADE"
    ) {
        confidence =
            clamp(
                Math.round(
                    strongestScore
                ),
                40,
                69
            );
    }

    // --------------------------------------------------------
    // Entry / expiry
    // --------------------------------------------------------

    const timing =
        buildEntryExpiry(
            timeframe
        );

    // ========================================================
    // FINAL RESULT
    // ========================================================

    return {
        pair,
        timeframe,

        signal,
        confidence,

        trend,

        callScore:
            round(callScore, 2),

        putScore:
            round(putScore, 2),

        entryPrice:
            round(price, 5),

        entryTime:
            timing.entryTime,

        expiryTime:
            timing.expiryTime,

        entryInSeconds:
            timing.entryInSeconds,

        support:
            round(support, 5),

        resistance:
            round(resistance, 5),

        ema9:
            round(ema9, 5),

        ema21:
            round(ema21, 5),

        rsi:
            round(rsi, 2),

        adx:
            round(adx, 2),

        atr:
            round(atr, 6),

        candlestickPattern:
            candlePattern.pattern,

        candlestickDirection:
            candlePattern.direction,

        candleScore:
            candlePattern.score,

        candleStrength:
            candlePattern.strength,

        priceActionDirection:
            priceAction.direction,

        priceActionScore:
            priceAction.score,

        marketPsychology:
            priceAction.psychology,

        priceActionObservations:
            priceAction.observations,

        locationBias:
            location.bias,

        locationRisk:
            location.risk,

        locationBlocked:
            location.blocked,

        locationReason:
            location.reason,

        dataFresh,

        freshnessStatus,

        dataAgeSeconds,

        maxDataAgeSeconds:
            MAX_DATA_AGE_SECONDS,

        staleReason,

        candlesUsed:
            tfCandles.length,

        lastCandle:
            lastCandleTime,

        reasons:
            [...new Set(reasons)],

        generatedAt:
            isoNow()
    };
}

// ============================================================
// ANALYZE PAIR
// ============================================================

async function analyzePair(
    pair
) {
    const candles =
        await fetchCandles(pair);

    const results = [];

    for (
        const timeframe of TIMEFRAMES
    ) {
        try {
            const result =
                analyzeTimeframe(
                    pair,
                    candles,
                    timeframe
                );

            results.push(result);
        } catch (error) {
            console.error(
                `[ANALYZE ${pair} ${timeframe}m]`,
                error.message
            );
        }
    }

    if (!results.length) {
        throw new Error(
            `No valid timeframe analysis for ${pair}.`
        );
    }

    return {
        pair,
        candles,
        results
    };
}

// ============================================================
// RESULT RANKING
// ============================================================

function rankResult(result) {
    if (!result) {
        return -Infinity;
    }

    let score =
        Number(result.confidence) || 0;

    if (
        result.signal === "CALL" ||
        result.signal === "PUT"
    ) {
        score += 25;
    }

    if (
        Number(result.adx) >= 25
    ) {
        score += 8;
    }

    if (
        result.candlestickDirection ===
        result.signal &&
        result.signal !== "NO TRADE"
    ) {
        score += 8;
    }

    if (
        result.priceActionDirection ===
        result.signal &&
        result.signal !== "NO TRADE"
    ) {
        score += 8;
    }

    if (
        result.locationRisk === "LOW"
    ) {
        score += 5;
    }

    if (
        result.dataFresh
    ) {
        score += 5;
    }

    if (
        result.locationBlocked
    ) {
        score -= 30;
    }

    if (
        !result.dataFresh
    ) {
        score -= 50;
    }

    if (
        result.signal === "NO TRADE"
    ) {
        score -= 15;
    }

    return score;
}

function bestFromResults(
    results
) {
    if (
        !Array.isArray(results) ||
        !results.length
    ) {
        return null;
    }

    return results
        .slice()
        .sort(
            (a, b) =>
                rankResult(b) -
                rankResult(a)
        )[0];
}

// ============================================================
// CACHE HELPERS
// ============================================================

function cacheResult(
    result
) {
    if (!result || !result.pair) {
        return;
    }

    cache.set(
        `${result.pair}_${result.timeframe}`,
        result
    );
}

function getCachedResults() {
    return Array.from(
        cache.values()
    );
}

function bestFromCache() {
    const results =
        getCachedResults();

    return bestFromResults(
        results
    );
}

function countCachedPairs() {
    const pairs =
        new Set();

    for (
        const result of cache.values()
    ) {
        if (result && result.pair) {
            pairs.add(result.pair);
        }
    }

    return pairs.size;
}

// ============================================================
// SCAN ONE PAIR
// ============================================================

async function scanPair(
    pair
) {
    try {
        console.log(
            `[SCANNER] Scanning ${pair}...`
        );

        const analyzed =
            await analyzePair(pair);

        for (
            const result of analyzed.results
        ) {
            cacheResult(result);
        }

        totalScanned++;

        return true;

    } catch (error) {
        console.error(
            `[SCANNER] ${pair} failed:`,
            error.message
        );

        return false;
    }
}

// ============================================================
// BACKGROUND SCANNER
// ============================================================

async function runScanBatch() {
    if (scanRunning) {
        return;
    }

    scanRunning = true;

    const startIndex =
        scanCursor;

    const endIndex =
        Math.min(
            startIndex +
                SCAN_BATCH_SIZE,
            PAIRS.length
        );

    const batch =
        PAIRS.slice(
            startIndex,
            endIndex
        );

    console.log(
        `[SCANNER] Batch ${startIndex} -> ${endIndex - 1}`
    );

    let successful =
        0;

    try {
        for (
            const pair of batch
        ) {
            const ok =
                await scanPair(pair);

            if (ok) {
                successful++;
            }

            await sleep(
                REQUEST_DELAY_MS
            );
        }

        scanCursor =
            endIndex >= PAIRS.length
                ? 0
                : endIndex;

        lastScanAt =
            isoNow();

        lastScanError =
            null;

        console.log(
            `[SCANNER] Batch complete: ${successful}/${batch.length} successful. Cached pairs: ${countCachedPairs()}`
        );

    } catch (error) {
        lastScanError =
            error.message;

        console.error(
            "[SCANNER] Batch error:",
            error.message
        );

    } finally {
        scanRunning = false;
    }
}

// ============================================================
// START BACKGROUND SCANNER
// ============================================================

function startScanner() {
    console.log(
        `[SCANNER] V8.3.1 started. ${PAIRS.length} pairs, batch ${SCAN_BATCH_SIZE}, every ${SCAN_EVERY_MS}ms.`
    );

    setTimeout(
        () => {
            runScanBatch()
                .catch(error =>
                    console.error(
                        "[SCANNER INITIAL]",
                        error.message
                    )
                );
        },
        1000
    );

    setInterval(
        () => {
            runScanBatch()
                .catch(error =>
                    console.error(
                        "[SCANNER INTERVAL]",
                        error.message
                    )
                );
        },
        SCAN_EVERY_MS
    );
}

// ============================================================
// ROUTES
// ============================================================

app.get(
    "/",
    (req, res) => {
        res.json({
            ok: true,
            name:
                "PO AI Predictor API",
            version: VERSION,
            source:
                "Twelve Data LIVE",
            message:
                "V8.3.1 backend is running."
        });
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/api/health",
    (req, res) => {
        res.json({
            ok: true,

            version:
                VERSION,

            source:
                "Twelve Data LIVE",

            pairs:
                PAIRS.length,

            cachedPairs:
                countCachedPairs(),

            scanRunning,

            scanCursor,

            scanBatchSize:
                SCAN_BATCH_SIZE,

            lastScanAt,

            lastScanError,

            totalScanned,

            timezone:
                "UTC",

            time:
                isoNow(),

            supportedTimeframes:
                TIMEFRAMES,

            freshnessFilter: {
                maxDataAgeSeconds:
                    MAX_DATA_AGE_SECONDS,

                hardStaleSeconds:
                    HARD_STALE_SECONDS
            },

            locationFilter: {
                supportRiskATR:
                    SUPPORT_RISK_ATR_MULTIPLIER,

                resistanceRiskATR:
                    RESISTANCE_RISK_ATR_MULTIPLIER,

                minimumSRRangeATR:
                    MIN_SR_RANGE_ATR_MULTIPLIER
            },

            apiKeyConfigured:
                Boolean(
                    TWELVE_DATA_API_KEY
                )
        });
    }
);

// ============================================================
// SCANNER STATUS
// ============================================================

app.get(
    "/api/scanner",
    (req, res) => {
        const results =
            getCachedResults();

        const best =
            bestFromResults(
                results
            );

        res.json({
            ok: true,

            version:
                VERSION,

            scanRunning,

            scanCursor,

            scanBatchSize:
                SCAN_BATCH_SIZE,

            pairs:
                PAIRS.length,

            cachedPairs:
                countCachedPairs(),

            cachedResults:
                results.length,

            totalScanned,

            lastScanAt,

            lastScanError,

            best: best || null,

            time:
                isoNow()
        });
    }
);

// ============================================================
// ANALYZE MARKET
// ============================================================

app.get(
    "/api/analyze",
    async (req, res) => {
        try {
            // ------------------------------------------------
            // If cache has valid data, use it immediately.
            // ------------------------------------------------

            let best =
                bestFromCache();

            if (best) {
                return res.json({
                    ok: true,

                    version:
                        VERSION,

                    source:
                        "Twelve Data LIVE",

                    selected:
                        best,

                    cachedPairs:
                        countCachedPairs(),

                    scannedPairs:
                        totalScanned,

                    scanRunning,

                    lastScanAt,

                    time:
                        isoNow()
                });
            }

            // ------------------------------------------------
            // Cache empty:
            // scan one batch now so first request gets data.
            // ------------------------------------------------

            await runScanBatch();

            best =
                bestFromCache();

            if (!best) {
                return res.status(503).json({
                    ok: false,

                    version:
                        VERSION,

                    source:
                        "Twelve Data LIVE",

                    error:
                        "No live market analysis is currently available.",

                    cachedPairs:
                        countCachedPairs(),

                    scanRunning,

                    lastScanAt,

                    lastScanError,

                    time:
                        isoNow()
                });
            }

            return res.json({
                ok: true,

                version:
                    VERSION,

                source:
                    "Twelve Data LIVE",

                selected:
                    best,

                cachedPairs:
                    countCachedPairs(),

                scannedPairs:
                    totalScanned,

                scanRunning,

                lastScanAt,

                time:
                    isoNow()
            });

        } catch (error) {
            console.error(
                "[API /api/analyze]",
                error
            );

            res.status(500).json({
                ok: false,

                version:
                    VERSION,

                error:
                    error.message,

                time:
                    isoNow()
            });
        }
    }
);

// ============================================================
// OPTIONAL PAIR ANALYSIS
// ============================================================

app.get(
    "/api/analyze/:pair",
    async (req, res) => {
        try {
            const requestedPair =
                decodeURIComponent(
                    req.params.pair
                );

            const pair =
                PAIRS.find(
                    p =>
                        p.toUpperCase() ===
                        requestedPair.toUpperCase()
                );

            if (!pair) {
                return res.status(404).json({
                    ok: false,
                    error:
                        `Unsupported pair: ${requestedPair}`,
                    supportedPairs:
                        PAIRS
                });
            }

            const analyzed =
                await analyzePair(pair);

            for (
                const result of analyzed.results
            ) {
                cacheResult(result);
            }

            const best =
                bestFromResults(
                    analyzed.results
                );

            return res.json({
                ok: true,

                version:
                    VERSION,

                source:
                    "Twelve Data LIVE",

                pair,

                selected:
                    best,

                results:
                    analyzed.results,

                cachedPairs:
                    countCachedPairs(),

                time:
                    isoNow()
            });

        } catch (error) {
            console.error(
                `[API PAIR]`,
                error
            );

            return res.status(500).json({
                ok: false,

                version:
                    VERSION,

                error:
                    error.message,

                time:
                    isoNow()
            });
        }
    }
);

// ============================================================
// SERVER START
// ============================================================

app.listen(
    PORT,
    () => {
        console.log(
            "============================================================"
        );

        console.log(
            `PO AI PREDICTOR BACKEND ${VERSION}`
        );

        console.log(
            "SOURCE: Twelve Data LIVE"
        );

        console.log(
            `PORT: ${PORT}`
        );

        console.log(
            `PAIRS: ${PAIRS.length}`
        );

        console.log(
            `TIMEFRAMES: ${TIMEFRAMES.join(", ")} MIN`
        );

        console.log(
            `MAX CANDLES: ${MAX_CANDLES}`
        );

        console.log(
            `SCAN BATCH: ${SCAN_BATCH_SIZE}`
        );

        console.log(
            `SCAN INTERVAL: ${SCAN_EVERY_MS}ms`
        );

        console.log(
            `ENTRY BUFFER: ${ENTRY_BUFFER_SECONDS}s`
        );

        console.log(
            `MAX DATA AGE: ${MAX_DATA_AGE_SECONDS}s`
        );

        console.log(
            `HARD STALE: ${HARD_STALE_SECONDS}s`
        );

        console.log(
            "TIMEZONE: UTC"
        );

        console.log(
            `TWELVE DATA API KEY: ${
                TWELVE_DATA_API_KEY
                    ? "CONFIGURED"
                    : "MISSING"
            }`
        );

        console.log(
            "============================================================"
        );

        startScanner();
    }
);
