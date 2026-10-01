const express = require("express");
const cors = require("cors");

// ============================================================
// PO AI PREDICTOR V8.3
// SMART PRICE-ACTION + CANDLESTICK + INDICATOR SCANNER
// LIVE ONLY - TWELVE DATA
// ============================================================

const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const VERSION = "V8.3";

const TIMEFRAMES = [1, 2, 3];

const MAX_CANDLES = 180;
const MIN_CANDLES = 60;

const SCAN_BATCH_SIZE = 8;
const SCAN_EVERY_MS = 60000;

const FETCH_TIMEOUT_MS = 12000;
const REQUEST_DELAY_MS = 150;

const ENTRY_BUFFER_SECONDS = 30;

// ============================================================
// 24 LIVE FOREX PAIRS
// ============================================================

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

// ============================================================
// SCANNER STATE
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
    if (!Number.isFinite(Number(value))) {
        return null;
    }

    const factor = Math.pow(10, decimals);

    return Math.round(Number(value) * factor) / factor;
}

function normalizePair(pair) {
    return String(pair || "").trim();
}

function pairDecimals(pair) {
    if (
        pair.includes("JPY")
    ) {
        return 3;
    }

    return 5;
}

// ============================================================
// UTC TIME HELPERS
// ============================================================

function nowMs() {
    return Date.now();
}

function isoNow() {
    return new Date().toISOString();
}

function parseUtcTimestamp(value) {
    if (!value) {
        return null;
    }

    const text = String(value).trim();

    if (!text) {
        return null;
    }

    let normalized = text;

    if (
        !normalized.endsWith("Z") &&
        !/[+-]\d\d:\d\d$/.test(normalized)
    ) {
        normalized += "Z";
    }

    const timestamp = new Date(normalized).getTime();

    if (!Number.isFinite(timestamp)) {
        return null;
    }

    return timestamp;
}

function formatUtc(timestamp) {
    if (!Number.isFinite(timestamp)) {
        return null;
    }

    return new Date(timestamp).toISOString();
}

// ============================================================
// HTTP FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {

        const response = await fetch(
            url,
            {
                ...options,
                signal: controller.signal
            }
        );

        return response;

    } finally {

        clearTimeout(timeout);
    }
}

// ============================================================
// FETCH TWELVE DATA CANDLES
// ============================================================

async function fetchCandles(pair) {

    if (!TWELVE_DATA_API_KEY) {
        throw new Error(
            "TWELVE_DATA_API_KEY is not configured."
        );
    }

    const symbol = encodeURIComponent(pair);

    const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${symbol}` +
        `&interval=1min` +
        `&outputsize=${MAX_CANDLES}` +
        `&order=ASC` +
        `&timezone=UTC` +
        `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

    const response = await fetchWithTimeout(
        url,
        {
            method: "GET",
            headers: {
                "Accept": "application/json"
            }
        },
        FETCH_TIMEOUT_MS
    );

    if (!response.ok) {
        throw new Error(
            `Twelve Data HTTP ${response.status}`
        );
    }

    const data = await response.json();

    if (data.status === "error") {
        throw new Error(
            data.message || "Twelve Data returned an error."
        );
    }

    if (!Array.isArray(data.values)) {
        throw new Error(
            "Twelve Data returned no candle values."
        );
    }

    const candles = data.values
        .map(item => {

            const timestamp = parseUtcTimestamp(
                item.datetime
            );

            return {
                time: timestamp,
                open: Number(item.open),
                high: Number(item.high),
                low: Number(item.low),
                close: Number(item.close)
            };
        })
        .filter(candle =>
            Number.isFinite(candle.time) &&
            Number.isFinite(candle.open) &&
            Number.isFinite(candle.high) &&
            Number.isFinite(candle.low) &&
            Number.isFinite(candle.close) &&
            candle.high >= candle.low
        )
        .sort((a, b) => a.time - b.time);

    if (candles.length < MIN_CANDLES) {
        throw new Error(
            `Only ${candles.length} valid candles returned. Minimum is ${MIN_CANDLES}.`
        );
    }

    return candles.slice(-MAX_CANDLES);
}

// ============================================================
// COMPLETED CANDLE FILTER
// ============================================================
//
// Twelve Data 1-minute data can contain the currently forming
// candle. We use completed candles for price-action analysis.
// ============================================================

function getCompletedCandles(candles) {

    if (!Array.isArray(candles)) {
        return [];
    }

    const currentMinute =
        Math.floor(Date.now() / 60000) * 60000;

    return candles.filter(
        candle => candle.time < currentMinute
    );
}

// ============================================================
// CANDLE HELPERS
// ============================================================

function candleBody(candle) {

    if (!candle) {
        return 0;
    }

    return Math.abs(
        candle.close - candle.open
    );
}

function candleRange(candle) {

    if (!candle) {
        return 0;
    }

    return Math.max(
        0,
        candle.high - candle.low
    );
}

function upperWick(candle) {

    if (!candle) {
        return 0;
    }

    return (
        candle.high -
        Math.max(candle.open, candle.close)
    );
}

function lowerWick(candle) {

    if (!candle) {
        return 0;
    }

    return (
        Math.min(candle.open, candle.close) -
        candle.low
    );
}

function isBullish(candle) {
    return candle && candle.close > candle.open;
}

function isBearish(candle) {
    return candle && candle.close < candle.open;
}

function bodyRatio(candle) {

    const range = candleRange(candle);

    if (range <= 0) {
        return 0;
    }

    return candleBody(candle) / range;
}

function isDoji(candle) {

    return bodyRatio(candle) <= 0.12;
}

// ============================================================
// CANDLESTICK PATTERN DETECTION
// ============================================================

function detectCandlestickPattern(candles, support, resistance) {

    const result = {
        pattern: "NONE",
        direction: "NEUTRAL",
        score: 0,
        strength: 0,
        description: "No clear candlestick pattern."
    };

    if (!candles || candles.length < 3) {
        return result;
    }

    const latest = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const latestBody = candleBody(latest);
    const latestRange = candleRange(latest);

    const previousBody = candleBody(previous);

    if (
        latestRange <= 0 ||
        previousBody < 0
    ) {
        return result;
    }

    const latestBodyRatio =
        bodyRatio(latest);

    const upper =
        upperWick(latest);

    const lower =
        lowerWick(latest);

    // --------------------------------------------------------
    // BULLISH ENGULFING
    // --------------------------------------------------------

    if (
        isBearish(previous) &&
        isBullish(latest) &&
        latest.open <= previous.close &&
        latest.close >= previous.open &&
        latestBody > previousBody
    ) {

        result.pattern = "BULLISH ENGULFING";
        result.direction = "CALL";
        result.score = 15;
        result.strength = 90;
        result.description =
            "Bullish candle body engulfs the previous bearish candle.";

        return result;
    }

    // --------------------------------------------------------
    // BEARISH ENGULFING
    // --------------------------------------------------------

    if (
        isBullish(previous) &&
        isBearish(latest) &&
        latest.open >= previous.close &&
        latest.close <= previous.open &&
        latestBody > previousBody
    ) {

        result.pattern = "BEARISH ENGULFING";
        result.direction = "PUT";
        result.score = 15;
        result.strength = 90;
        result.description =
            "Bearish candle body engulfs the previous bullish candle.";

        return result;
    }

    // --------------------------------------------------------
    // HAMMER / BULLISH PIN BAR
    // --------------------------------------------------------

    const nearSupport =
        Number.isFinite(support) &&
        latest.low <= support * 1.0015;

    if (
        lower >= latestBody * 2 &&
        upper <= Math.max(latestBody * 0.8, latestRange * 0.15) &&
        latestBodyRatio <= 0.45
    ) {

        result.pattern =
            nearSupport
                ? "HAMMER AT SUPPORT"
                : "BULLISH PIN BAR";

        result.direction = "CALL";
        result.score = nearSupport ? 15 : 11;
        result.strength = nearSupport ? 92 : 78;

        result.description =
            nearSupport
                ? "Lower-wick rejection with price defending support."
                : "Long lower wick shows bullish rejection.";

        return result;
    }

    // --------------------------------------------------------
    // SHOOTING STAR / BEARISH PIN BAR
    // --------------------------------------------------------

    const nearResistance =
        Number.isFinite(resistance) &&
        latest.high >= resistance * 0.9985;

    if (
        upper >= latestBody * 2 &&
        lower <= Math.max(latestBody * 0.8, latestRange * 0.15) &&
        latestBodyRatio <= 0.45
    ) {

        result.pattern =
            nearResistance
                ? "SHOOTING STAR AT RESISTANCE"
                : "BEARISH PIN BAR";

        result.direction = "PUT";
        result.score = nearResistance ? 15 : 11;
        result.strength = nearResistance ? 92 : 78;

        result.description =
            nearResistance
                ? "Upper-wick rejection with price rejecting resistance."
                : "Long upper wick shows bearish rejection.";

        return result;
    }

    // --------------------------------------------------------
    // STRONG BULLISH MOMENTUM CANDLE
    // --------------------------------------------------------

    if (
        isBullish(latest) &&
        latestBodyRatio >= 0.70 &&
        latestBody > previousBody * 1.15
    ) {

        result.pattern = "STRONG BULLISH CANDLE";
        result.direction = "CALL";
        result.score = 10;
        result.strength = 75;
        result.description =
            "Large bullish body indicates strong short-term momentum.";

        return result;
    }

    // --------------------------------------------------------
    // STRONG BEARISH MOMENTUM CANDLE
    // --------------------------------------------------------

    if (
        isBearish(latest) &&
        latestBodyRatio >= 0.70 &&
        latestBody > previousBody * 1.15
    ) {

        result.pattern = "STRONG BEARISH CANDLE";
        result.direction = "PUT";
        result.score = 10;
        result.strength = 75;
        result.description =
            "Large bearish body indicates strong short-term momentum.";

        return result;
    }

    // --------------------------------------------------------
    // DOJI / INDECISION
    // --------------------------------------------------------

    if (isDoji(latest)) {

        result.pattern = "DOJI / INDECISION";
        result.direction = "NEUTRAL";
        result.score = 0;
        result.strength = 25;
        result.description =
            "Small candle body indicates short-term indecision.";

        return result;
    }

    return result;
}

// ============================================================
// EMA
// ============================================================

function calculateEMA(values, period) {

    if (!Array.isArray(values) || values.length < period) {
        return null;
    }

    const multiplier =
        2 / (period + 1);

    let ema = values
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

function calculateRSI(values, period = 14) {

    if (
        !Array.isArray(values) ||
        values.length <= period
    ) {
        return null;
    }

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {

        const change =
            values[i] - values[i - 1];

        if (change >= 0) {
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
            Math.max(change, 0);

        const loss =
            Math.max(-change, 0);

        averageGain =
            (
                averageGain * (period - 1) +
                gain
            ) / period;

        averageLoss =
            (
                averageLoss * (period - 1) +
                loss
            ) / period;
    }

    if (averageLoss === 0) {
        return 100;
    }

    const rs =
        averageGain / averageLoss;

    return 100 - (100 / (1 + rs));
}

// ============================================================
// TRUE RANGE / ATR
// ============================================================

function calculateATR(candles, period = 14) {

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

        const current = candles[i];
        const previous = candles[i - 1];

        const tr = Math.max(
            current.high - current.low,
            Math.abs(
                current.high - previous.close
            ),
            Math.abs(
                current.low - previous.close
            )
        );

        trueRanges.push(tr);
    }

    if (trueRanges.length < period) {
        return null;
    }

    const recent =
        trueRanges.slice(-period);

    return recent.reduce(
        (sum, value) => sum + value,
        0
    ) / recent.length;
}

// ============================================================
// ADX
// ============================================================

function calculateADX(candles, period = 14) {

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

        const current = candles[i];
        const previous = candles[i - 1];

        const upMove =
            current.high - previous.high;

        const downMove =
            previous.low - current.low;

        const tr = Math.max(
            current.high - current.low,
            Math.abs(
                current.high - previous.close
            ),
            Math.abs(
                current.low - previous.close
            )
        );

        trs.push(tr);

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
    }

    if (trs.length < period * 2) {
        return null;
    }

    let smoothedTR =
        trs
            .slice(0, period)
            .reduce(
                (sum, value) => sum + value,
                0
            );

    let smoothedPlus =
        plusDM
            .slice(0, period)
            .reduce(
                (sum, value) => sum + value,
                0
            );

    let smoothedMinus =
        minusDM
            .slice(0, period)
            .reduce(
                (sum, value) => sum + value,
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
                (smoothedTR / period) +
                trs[i];

            smoothedPlus =
                smoothedPlus -
                (smoothedPlus / period) +
                plusDM[i];

            smoothedMinus =
                smoothedMinus -
                (smoothedMinus / period) +
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
                      plusDI - minusDI
                  ) /
                  denominator;

        dxValues.push(dx);
    }

    if (dxValues.length < period) {
        return null;
    }

    const recent =
        dxValues.slice(-period);

    return recent.reduce(
        (sum, value) => sum + value,
        0
    ) / recent.length;
}

// ============================================================
// SUPPORT / RESISTANCE
// ============================================================

function calculateSupportResistance(candles) {

    if (
        !Array.isArray(candles) ||
        candles.length < 20
    ) {
        return {
            support: null,
            resistance: null
        };
    }

    const recent =
        candles.slice(-40);

    const lows =
        recent.map(candle => candle.low);

    const highs =
        recent.map(candle => candle.high);

    return {
        support: Math.min(...lows),
        resistance: Math.max(...highs)
    };
}

// ============================================================
// MARKET CONDITION
// ============================================================

function determineTrend(
    ema9,
    ema21,
    rsi,
    adx,
    price
) {

    if (
        !Number.isFinite(ema9) ||
        !Number.isFinite(ema21)
    ) {
        return "UNKNOWN";
    }

    if (
        ema9 > ema21 &&
        price > ema9
    ) {

        if (Number.isFinite(adx) && adx >= 25) {
            return "STRONG UPTREND";
        }

        return "UPTREND";
    }

    if (
        ema9 < ema21 &&
        price < ema9
    ) {

        if (Number.isFinite(adx) && adx >= 25) {
            return "STRONG DOWNTREND";
        }

        return "DOWNTREND";
    }

    if (
        Number.isFinite(rsi) &&
        rsi >= 47 &&
        rsi <= 53
    ) {
        return "RANGING / INDECISION";
    }

    return "RANGING";
}

// ============================================================
// PRICE-ACTION / MARKET PSYCHOLOGY
// ============================================================
//
// This does NOT claim to read traders' minds.
// It evaluates observable price behaviour.
// ============================================================

function analyzePriceAction(
    candles,
    support,
    resistance,
    ema9,
    ema21
) {

    const result = {
        direction: "NEUTRAL",
        score: 0,
        label: "NEUTRAL PRICE ACTION",
        observations: []
    };

    if (!candles || candles.length < 5) {
        return result;
    }

    const last =
        candles[candles.length - 1];

    const previous =
        candles[candles.length - 2];

    const third =
        candles[candles.length - 3];

    let bullish = 0;
    let bearish = 0;

    // --------------------------------------------------------
    // SUPPORT DEFENSE
    // --------------------------------------------------------

    if (
        Number.isFinite(support) &&
        last.low <= support * 1.0015 &&
        last.close > last.open
    ) {

        bullish += 7;

        result.observations.push(
            "BUYERS DEFENDING SUPPORT"
        );
    }

    // --------------------------------------------------------
    // RESISTANCE REJECTION
    // --------------------------------------------------------

    if (
        Number.isFinite(resistance) &&
        last.high >= resistance * 0.9985 &&
        last.close < last.open
    ) {

        bearish += 7;

        result.observations.push(
            "SELLERS REJECTING RESISTANCE"
        );
    }

    // --------------------------------------------------------
    // LOWER WICK REJECTION
    // --------------------------------------------------------

    if (
        lowerWick(last) >
        candleBody(last) * 1.5
    ) {

        bullish += 5;

        result.observations.push(
            "LOWER-WICK BULLISH REJECTION"
        );
    }

    // --------------------------------------------------------
    // UPPER WICK REJECTION
    // --------------------------------------------------------

    if (
        upperWick(last) >
        candleBody(last) * 1.5
    ) {

        bearish += 5;

        result.observations.push(
            "UPPER-WICK BEARISH REJECTION"
        );
    }

    // --------------------------------------------------------
    // THREE-CANDLE BULLISH MOMENTUM
    // --------------------------------------------------------

    if (
        isBullish(third) &&
        isBullish(previous) &&
        isBullish(last) &&
        last.close > previous.close &&
        previous.close > third.close
    ) {

        bullish += 8;

        result.observations.push(
            "BULLISH MOMENTUM ACCELERATION"
        );
    }

    // --------------------------------------------------------
    // THREE-CANDLE BEARISH MOMENTUM
    // --------------------------------------------------------

    if (
        isBearish(third) &&
        isBearish(previous) &&
        isBearish(last) &&
        last.close < previous.close &&
        previous.close < third.close
    ) {

        bearish += 8;

        result.observations.push(
            "BEARISH MOMENTUM ACCELERATION"
        );
    }

    // --------------------------------------------------------
    // EMA PRICE-ACTION CONFIRMATION
    // --------------------------------------------------------

    if (
        Number.isFinite(ema9) &&
        Number.isFinite(ema21)
    ) {

        if (
            last.close > ema9 &&
            ema9 > ema21
        ) {

            bullish += 5;

            result.observations.push(
                "PRICE ABOVE BULLISH EMA STRUCTURE"
            );
        }

        if (
            last.close < ema9 &&
            ema9 < ema21
        ) {

            bearish += 5;

            result.observations.push(
                "PRICE BELOW BEARISH EMA STRUCTURE"
            );
        }
    }

    // --------------------------------------------------------
    // BODY STRENGTH
    // --------------------------------------------------------

    const ratio =
        bodyRatio(last);

    if (ratio >= 0.65) {

        if (isBullish(last)) {

            bullish += 4;

            result.observations.push(
                "STRONG BULLISH CANDLE BODY"
            );

        } else if (isBearish(last)) {

            bearish += 4;

            result.observations.push(
                "STRONG BEARISH CANDLE BODY"
            );
        }
    }

    // --------------------------------------------------------
    // INDECISION
    // --------------------------------------------------------

    if (isDoji(last)) {

        result.observations.push(
            "MARKET INDECISION / DOJI"
        );
    }

    // --------------------------------------------------------
    // FINAL PRICE ACTION DIRECTION
    // --------------------------------------------------------

    if (
        bullish >= bearish + 4
    ) {

        result.direction = "CALL";
        result.score = clamp(
            bullish,
            0,
            15
        );
        result.label =
            "BUYER PRICE-ACTION PRESSURE";

    } else if (
        bearish >= bullish + 4
    ) {

        result.direction = "PUT";
        result.score = clamp(
            bearish,
            0,
            15
        );
        result.label =
            "SELLER PRICE-ACTION PRESSURE";

    } else {

        result.direction = "NEUTRAL";
        result.score = 0;
        result.label =
            "BALANCED / INDECISIVE PRICE ACTION";
    }

    return result;
}

// ============================================================
// AGGREGATE CANDLES FOR 2M / 3M
// ============================================================

function aggregateCandles(
    candles,
    timeframeMinutes
) {

    if (timeframeMinutes === 1) {
        return candles;
    }

    const bucketMs =
        timeframeMinutes *
        60 *
        1000;

    const groups = new Map();

    for (const candle of candles) {

        const bucket =
            Math.floor(
                candle.time / bucketMs
            ) * bucketMs;

        if (!groups.has(bucket)) {
            groups.set(bucket, []);
        }

        groups.get(bucket).push(candle);
    }

    const aggregated = [];

    for (const [bucket, group] of groups) {

        group.sort(
            (a, b) => a.time - b.time
        );

        if (!group.length) {
            continue;
        }

        aggregated.push({
            time: bucket,
            open: group[0].open,
            high: Math.max(
                ...group.map(c => c.high)
            ),
            low: Math.min(
                ...group.map(c => c.low)
            ),
            close:
                group[group.length - 1].close
        });
    }

    return aggregated.sort(
        (a, b) => a.time - b.time
    );
}

// ============================================================
// ANALYZE ONE PAIR / TIMEFRAME
// ============================================================

function analyzePairTimeframe(
    pair,
    candles,
    timeframe
) {

    const aggregated =
        aggregateCandles(
            candles,
            timeframe
        );

    const completed =
        getCompletedCandles(
            aggregated
        );

    if (completed.length < MIN_CANDLES) {
        return null;
    }

    const closes =
        completed.map(
            candle => candle.close
        );

    const price =
        closes[closes.length - 1];

    const ema9 =
        calculateEMA(closes, 9);

    const ema21 =
        calculateEMA(closes, 21);

    const rsi =
        calculateRSI(closes, 14);

    const adx =
        calculateADX(completed, 14);

    const atr =
        calculateATR(completed, 14);

    const levels =
        calculateSupportResistance(
            completed
        );

    const trend =
        determineTrend(
            ema9,
            ema21,
            rsi,
            adx,
            price
        );

    const candleAnalysis =
        detectCandlestickPattern(
            completed,
            levels.support,
            levels.resistance
        );

    const priceAction =
        analyzePriceAction(
            completed,
            levels.support,
            levels.resistance,
            ema9,
            ema21
        );

    // ========================================================
    // INDICATOR SCORE
    // ========================================================

    let callScore = 0;
    let putScore = 0;

    const reasons = [];

    // EMA TREND
    if (
        Number.isFinite(ema9) &&
        Number.isFinite(ema21)
    ) {

        if (ema9 > ema21) {

            callScore += 28;

            reasons.push(
                "EMA9 is above EMA21."
            );

        } else if (ema9 < ema21) {

            putScore += 28;

            reasons.push(
                "EMA9 is below EMA21."
            );
        }
    }

    // RSI
    if (Number.isFinite(rsi)) {

        if (rsi > 52) {

            callScore += 18;

            reasons.push(
                `RSI bullish at ${round(rsi, 2)}.`
            );

        } else if (rsi < 48) {

            putScore += 18;

            reasons.push(
                `RSI bearish at ${round(rsi, 2)}.`
            );

        } else {

            reasons.push(
                `RSI neutral at ${round(rsi, 2)}.`
            );
        }
    }

    // ADX
    if (
        Number.isFinite(adx) &&
        adx >= 25
    ) {

        if (ema9 > ema21) {

            callScore += 22;

            reasons.push(
                `ADX ${round(adx, 2)} confirms trend strength.`
            );

        } else if (ema9 < ema21) {

            putScore += 22;

            reasons.push(
                `ADX ${round(adx, 2)} confirms trend strength.`
            );
        }

    } else if (Number.isFinite(adx)) {

        reasons.push(
            `ADX ${round(adx, 2)} shows limited trend strength.`
        );
    }

    // PRICE / EMA
    if (
        Number.isFinite(ema9)
    ) {

        if (price > ema9) {

            callScore += 12;

            reasons.push(
                "Price is above EMA9."
            );

        } else if (price < ema9) {

            putScore += 12;

            reasons.push(
                "Price is below EMA9."
            );
        }
    }

    // SUPPORT
    if (
        Number.isFinite(levels.support) &&
        price <=
            levels.support +
            Math.max(
                atr * 0.75,
                price * 0.0004
            )
    ) {

        if (
            price >=
            levels.support
        ) {

            callScore += 20;

            reasons.push(
                "Price is reacting near support."
            );
        }
    }

    // RESISTANCE
    if (
        Number.isFinite(levels.resistance) &&
        price >=
            levels.resistance -
            Math.max(
                atr * 0.75,
                price * 0.0004
            )
    ) {

        if (
            price <=
            levels.resistance
        ) {

            putScore += 20;

            reasons.push(
                "Price is reacting near resistance."
            );
        }
    }

    // ========================================================
    // CANDLESTICK SCORE
    // ========================================================

    if (
        candleAnalysis.direction === "CALL"
    ) {

        callScore +=
            candleAnalysis.score;

        reasons.push(
            `${candleAnalysis.pattern}: ${candleAnalysis.description}`
        );

    } else if (
        candleAnalysis.direction === "PUT"
    ) {

        putScore +=
            candleAnalysis.score;

        reasons.push(
            `${candleAnalysis.pattern}: ${candleAnalysis.description}`
        );

    } else if (
        candleAnalysis.pattern !== "NONE"
    ) {

        reasons.push(
            `${candleAnalysis.pattern}: ${candleAnalysis.description}`
        );
    }

    // ========================================================
    // PRICE ACTION / PSYCHOLOGY SCORE
    // ========================================================

    if (
        priceAction.direction === "CALL"
    ) {

        callScore += priceAction.score;

        for (
            const observation of
            priceAction.observations
        ) {

            reasons.push(
                observation
            );
        }

    } else if (
        priceAction.direction === "PUT"
    ) {

        putScore += priceAction.score;

        for (
            const observation of
            priceAction.observations
        ) {

            reasons.push(
                observation
            );
        }

    } else {

        for (
            const observation of
            priceAction.observations
        ) {

            reasons.push(
                observation
            );
        }
    }

    // ========================================================
    // FINAL DIRECTION
    // ========================================================

    const difference =
        Math.abs(
            callScore - putScore
        );

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

    // ========================================================
    // ADDITIONAL QUALITY FILTER
    // ========================================================

    // Avoid calling a very weak pattern a signal when the
    // trend structure is strongly contradictory.

    if (
        signal === "CALL" &&
        candleAnalysis.direction === "PUT" &&
        candleAnalysis.strength >= 90 &&
        priceAction.direction === "PUT" &&
        Number.isFinite(adx) &&
        adx >= 25
    ) {

        signal = "NO TRADE";

        reasons.push(
            "Strong bearish price-action conflict detected."
        );
    }

    if (
        signal === "PUT" &&
        candleAnalysis.direction === "CALL" &&
        candleAnalysis.strength >= 90 &&
        priceAction.direction === "CALL" &&
        Number.isFinite(adx) &&
        adx >= 25
    ) {

        signal = "NO TRADE";

        reasons.push(
            "Strong bullish price-action conflict detected."
        );
    }

    // ========================================================
    // SETUP SCORE / CONFIDENCE
    // ========================================================

    const rawWinner =
        Math.max(
            callScore,
            putScore
        );

    let confidence;

    if (signal === "NO TRADE") {

        confidence = clamp(
            Math.round(
                40 +
                Math.min(
                    rawWinner * 0.22,
                    29
                )
            ),
            40,
            69
        );

    } else {

        const directionalStrength =
            Math.min(
                difference,
                35
            );

        const confirmationBonus =
            (
                candleAnalysis.direction === signal
                    ? 5
                    : 0
            ) +
            (
                priceAction.direction === signal
                    ? 5
                    : 0
            );

        confidence = clamp(
            Math.round(
                70 +
                directionalStrength * 0.45 +
                confirmationBonus
            ),
            70,
            95
        );
    }

    // ========================================================
    // ENTRY TIME
    // ========================================================

    const timeframeMs =
        timeframe *
        60 *
        1000;

    const now = Date.now();

    let entryTime =
        Math.ceil(
            now / timeframeMs
        ) * timeframeMs;

    let entryInSeconds =
        Math.floor(
            (entryTime - now) / 1000
        );

    if (
        entryInSeconds < ENTRY_BUFFER_SECONDS
    ) {

        entryTime += timeframeMs;

        entryInSeconds =
            Math.floor(
                (entryTime - now) / 1000
            );
    }

    const expiryTime =
        entryTime + timeframeMs;

    // ========================================================
    // DATA AGE
    // ========================================================

    const lastCandle =
        completed[
            completed.length - 1
        ];

    const lastCandleTime =
        lastCandle
            ? lastCandle.time
            : null;

    const dataAgeSeconds =
        lastCandleTime
            ? Math.max(
                0,
                Math.floor(
                    (
                        now -
                        lastCandleTime
                    ) / 1000
                )
            )
            : null;

    // ========================================================
    // RESULT
    // ========================================================

    return {
        pair,
        timeframe,

        signal,
        confidence,

        trend,

        callScore: round(callScore, 1),
        putScore: round(putScore, 1),

        entryPrice:
            round(
                price,
                pairDecimals(pair)
            ),

        entryTime:
            formatUtc(entryTime),

        expiryTime:
            formatUtc(expiryTime),

        entryInSeconds,

        support:
            round(
                levels.support,
                pairDecimals(pair)
            ),

        resistance:
            round(
                levels.resistance,
                pairDecimals(pair)
            ),

        ema9:
            round(
                ema9,
                pairDecimals(pair)
            ),

        ema21:
            round(
                ema21,
                pairDecimals(pair)
            ),

        rsi:
            round(rsi, 2),

        adx:
            round(adx, 2),

        atr:
            round(
                atr,
                pairDecimals(pair)
            ),

        // NEW V8.3
        candlestickPattern:
            candleAnalysis.pattern,

        candlestickDirection:
            candleAnalysis.direction,

        candleScore:
            candleAnalysis.score,

        candleStrength:
            candleAnalysis.strength,

        priceActionDirection:
            priceAction.direction,

        priceActionScore:
            priceAction.score,

        marketPsychology:
            priceAction.label,

        priceActionObservations:
            priceAction.observations,

        candlesUsed:
            completed.length,

        lastCandle:
            formatUtc(lastCandleTime),

        dataAgeSeconds,

        reasons:
            reasons.slice(0, 14),

        generatedAt:
            isoNow()
    };
}

// ============================================================
// ANALYZE ALL TIMEFRAMES FOR ONE PAIR
// ============================================================

function analyzePair(pair, candles) {

    const results = [];

    for (const timeframe of TIMEFRAMES) {

        try {

            const result =
                analyzePairTimeframe(
                    pair,
                    candles,
                    timeframe
                );

            if (result) {
                results.push(result);
            }

        } catch (error) {

            console.error(
                `[ANALYZE ${pair} ${timeframe}M]`,
                error.message
            );
        }
    }

    return results;
}

// ============================================================
// BEST RESULT FROM PAIR RESULTS
// ============================================================

function bestFromPairResults(results) {

    if (
        !Array.isArray(results) ||
        results.length === 0
    ) {
        return null;
    }

    const sorted =
        [...results].sort(
            (a, b) => {

                const signalRankA =
                    a.signal === "NO TRADE"
                        ? 0
                        : 100;

                const signalRankB =
                    b.signal === "NO TRADE"
                        ? 0
                        : 100;

                const confirmationA =
                    (
                        a.candleScore || 0
                    ) +
                    (
                        a.priceActionScore || 0
                    );

                const confirmationB =
                    (
                        b.candleScore || 0
                    ) +
                    (
                        b.priceActionScore || 0
                    );

                const scoreA =
                    signalRankA +
                    a.confidence +
                    confirmationA;

                const scoreB =
                    signalRankB +
                    b.confidence +
                    confirmationB;

                return scoreB - scoreA;
            }
        );

    return sorted[0];
}

// ============================================================
// SCAN ONE PAIR
// ============================================================

async function scanPair(pair) {

    const started =
        Date.now();

    try {

        const candles =
            await fetchCandles(pair);

        const results =
            analyzePair(
                pair,
                candles
            );

        const best =
            bestFromPairResults(
                results
            );

        if (!best) {
            throw new Error(
                "No valid timeframe result."
            );
        }

        cache.set(
            pair,
            {
                pair,
                result: best,
                allTimeframes: results,
                scannedAt: isoNow(),
                durationMs:
                    Date.now() - started
            }
        );

        totalScanned++;

        console.log(
            `[SCAN] ${pair} -> ${best.signal} ${best.timeframe}M ${best.confidence}%`
        );

        return best;

    } catch (error) {

        console.error(
            `[SCAN ERROR] ${pair}:`,
            error.message
        );

        return null;
    }
}

// ============================================================
// SCAN BATCH
// ============================================================

async function scanBatch() {

    if (scanRunning) {
        return;
    }

    scanRunning = true;
    lastScanError = null;

    const batch = [];

    for (let i = 0; i < SCAN_BATCH_SIZE; i++) {

        const index =
            (
                scanCursor + i
            ) % PAIRS.length;

        batch.push(
            PAIRS[index]
        );
    }

    scanCursor =
        (
            scanCursor +
            SCAN_BATCH_SIZE
        ) % PAIRS.length;

    console.log(
        `[SCANNER] Starting batch: ${batch.join(", ")}`
    );

    try {

        for (const pair of batch) {

            await scanPair(pair);

            await sleep(
                REQUEST_DELAY_MS
            );
        }

        lastScanAt = isoNow();

        console.log(
            `[SCANNER] Batch completed. Cache=${cache.size}/${PAIRS.length}`
        );

    } catch (error) {

        lastScanError =
            error.message;

        console.error(
            "[SCANNER ERROR]",
            error.message
        );

    } finally {

        scanRunning = false;
    }
}

// ============================================================
// FIND BEST GLOBAL RESULT
// ============================================================

function bestFromCache() {

    const results = [];

    for (const item of cache.values()) {

        if (
            item &&
            item.result
        ) {

            results.push(
                item.result
            );
        }
    }

    if (!results.length) {
        return null;
    }

    results.sort(
        (a, b) => {

            const signalBonusA =
                a.signal === "NO TRADE"
                    ? 0
                    : 40;

            const signalBonusB =
                b.signal === "NO TRADE"
                    ? 0
                    : 40;

            const confirmationA =
                (
                    a.candleScore || 0
                ) +
                (
                    a.priceActionScore || 0
                );

            const confirmationB =
                (
                    b.candleScore || 0
                ) +
                (
                    b.priceActionScore || 0
                );

            const adxBonusA =
                Number.isFinite(a.adx) &&
                a.adx >= 25
                    ? 8
                    : 0;

            const adxBonusB =
                Number.isFinite(b.adx) &&
                b.adx >= 25
                    ? 8
                    : 0;

            const scoreA =
                signalBonusA +
                a.confidence +
                confirmationA +
                adxBonusA;

            const scoreB =
                signalBonusB +
                b.confidence +
                confirmationB +
                adxBonusB;

            return scoreB - scoreA;
        }
    );

    return results[0];
}

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/api/health",
    (req, res) => {

        res.json({
            ok: true,

            version: VERSION,

            source: "Twelve Data LIVE",

            pairs: PAIRS.length,

            cachedPairs:
                cache.size,

            scanRunning,

            scanCursor,

            scanBatchSize:
                SCAN_BATCH_SIZE,

            lastScanAt,

            lastScanError,

            totalScanned,

            timezone: "UTC",

            time:
                isoNow(),

            supportedTimeframes:
                TIMEFRAMES
        });
    }
);

// ============================================================
// ROOT
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.json({
            ok: true,
            name: "PO AI Predictor API",
            version: VERSION,
            source: "Twelve Data LIVE",
            status: "online",
            time: isoNow()
        });
    }
);

// ============================================================
// SCANNER STATUS
// ============================================================

app.get(
    "/api/scanner",
    (req, res) => {

        const selected =
            bestFromCache();

        res.json({
            ok: true,

            version: VERSION,

            scanRunning,

            cachedPairs:
                cache.size,

            totalPairs:
                PAIRS.length,

            lastScanAt,

            lastScanError,

            selected,

            time:
                isoNow()
        });
    }
);

// ============================================================
// ANALYZE
// ============================================================

app.get(
    "/api/analyze",
    async (req, res) => {

        try {

            clearOldCache();

            // ------------------------------------------------
            // If scanner has no data yet, perform one batch.
            // ------------------------------------------------

            if (cache.size === 0) {

                console.log(
                    "[ANALYZE] Cache empty. Running first scan batch..."
                );

                await scanBatch();
            }

            const selected =
                bestFromCache();

            if (!selected) {

                return res.status(503).json({
                    ok: false,
                    error:
                        "No live market result is available yet.",
                    version: VERSION,
                    cachedPairs:
                        cache.size,
                    scanRunning,
                    time:
                        isoNow()
                });
            }

            res.json({

                ok: true,

                version: VERSION,

                source:
                    "Twelve Data LIVE",

                selected,

                cachedPairs:
                    cache.size,

                scannedPairs:
                    cache.size,

                scanRunning,

                lastScanAt,

                time:
                    isoNow()
            });

        } catch (error) {

            console.error(
                "[API ANALYZE ERROR]",
                error
            );

            res.status(500).json({
                ok: false,
                error:
                    error.message ||
                    "Analysis failed.",
                version: VERSION,
                time:
                    isoNow()
            });
        }
    }
);

// ============================================================
// CLEAR OLD CACHE
// ============================================================

function clearOldCache() {

    const maxAge =
        5 * 60 * 1000;

    const now =
        Date.now();

    for (
        const [pair, item]
        of cache.entries()
    ) {

        if (!item || !item.scannedAt) {
            cache.delete(pair);
            continue;
        }

        const timestamp =
            new Date(
                item.scannedAt
            ).getTime();

        if (
            !Number.isFinite(timestamp) ||
            now - timestamp > maxAge
        ) {

            cache.delete(pair);
        }
    }
}

// ============================================================
// BACKGROUND SCANNER
// ============================================================

let scannerInterval = null;

function startBackgroundScanner() {

    if (scannerInterval) {
        clearInterval(
            scannerInterval
        );
    }

    // First batch shortly after server starts.
    setTimeout(
        () => {

            scanBatch()
                .catch(error => {

                    console.error(
                        "[INITIAL SCAN]",
                        error.message
                    );
                });

        },
        1500
    );

    scannerInterval =
        setInterval(
            () => {

                scanBatch()
                    .catch(error => {

                        console.error(
                            "[BACKGROUND SCAN]",
                            error.message
                        );
                    });

            },
            SCAN_EVERY_MS
        );

    console.log(
        `[SCANNER] Background scanner started. Every ${SCAN_EVERY_MS / 1000}s.`
    );
}

// ============================================================
// SERVER START
// ============================================================

app.listen(
    PORT,
    () => {

        console.log(
            "================================================"
        );

        console.log(
            `PO AI PREDICTOR ${VERSION}`
        );

        console.log(
            "LIVE SMART PRICE-ACTION SCANNER"
        );

        console.log(
            "================================================"
        );

        console.log(
            `Port: ${PORT}`
        );

        console.log(
            `Source: Twelve Data LIVE`
        );

        console.log(
            `Pairs: ${PAIRS.length}`
        );

        console.log(
            `Timeframes: ${TIMEFRAMES.join(", ")} min`
        );

        console.log(
            `Scanner batch: ${SCAN_BATCH_SIZE}`
        );

        console.log(
            `Scanner interval: ${SCAN_EVERY_MS / 1000}s`
        );

        console.log(
            `Timezone: UTC`
        );

        console.log(
            `API key configured: ${Boolean(TWELVE_DATA_API_KEY)}`
        );

        console.log(
            "Candlestick analysis: ENABLED"
        );

        console.log(
            "Price-action psychology: ENABLED"
        );

        console.log(
            "================================================"
        );

        startBackgroundScanner();
    }
);
