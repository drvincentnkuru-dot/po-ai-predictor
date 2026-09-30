const API_URL = "https://po-ai-predictor-api.onrender.com";
const ANALYZE_URL = `${API_URL}/api/analyze`;

// ================================
// DOM ELEMENTS - V8
// ================================

const backendStatus = document.getElementById("backendStatus");
const analyzeBtn = document.getElementById("analyzeBtn");
const errorBox = document.getElementById("errorBox");

const signalCard = document.getElementById("signalCard");
const selectedPair = document.getElementById("selectedPair");
const trendBadge = document.getElementById("trendBadge");
const signalBadge = document.getElementById("signalBadge");

const confidence = document.getElementById("confidence");
const timeframe = document.getElementById("timeframe");
const countdown = document.getElementById("countdown");

const entryTime = document.getElementById("entryTime");
const expiryTime = document.getElementById("expiryTime");
const entryPrice = document.getElementById("entryPrice");

const callScore = document.getElementById("callScore");
const putScore = document.getElementById("putScore");

const support = document.getElementById("support");
const resistance = document.getElementById("resistance");

const dataAge = document.getElementById("dataAge");

const ema9 = document.getElementById("ema9");
const ema21 = document.getElementById("ema21");
const rsi = document.getElementById("rsi");
const adx = document.getElementById("adx");

const reasons = document.getElementById("reasons");

const scanInfo = document.getElementById("scanInfo");
const scanner = document.getElementById("scanner");


// ================================
// STATE
// ================================

let currentResult = null;
let countdownTimer = null;


// ================================
// HELPERS
// ================================

function safe(value, fallback = "—") {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return fallback;
    }

    return value;
}


function formatNumber(value, decimals = 5) {
    if (value === null || value === undefined || value === "") {
        return "—";
    }

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return String(value);
    }

    return number.toFixed(decimals);
}


function formatPercent(value) {
    if (value === null || value === undefined || value === "") {
        return "—";
    }

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return `${value}%`;
    }

    return `${Math.round(number)}%`;
}


function formatDateTime(value) {
    if (!value) {
        return "—";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString();
}


function showError(message) {
    console.error(message);

    if (errorBox) {
        errorBox.textContent = message;
        errorBox.style.display = "block";
    }
}


function clearError() {
    if (errorBox) {
        errorBox.textContent = "";
        errorBox.style.display = "none";
    }
}


// ================================
// BACKEND STATUS
// ================================

async function checkBackend() {
    try {
        const response = await fetch(`${API_URL}/api/health`, {
            method: "GET",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`Backend HTTP ${response.status}`);
        }

        const data = await response.json();

        if (backendStatus) {
            backendStatus.textContent = "LIVE";
        }

        console.log("Backend health:", data);

        return true;

    } catch (error) {

        console.error("Backend health error:", error);

        if (backendStatus) {
            backendStatus.textContent = "OFFLINE";
        }

        return false;
    }
}


// ================================
// LOADING STATE
// ================================

function showLoading() {

    clearError();

    if (analyzeBtn) {
        analyzeBtn.disabled = true;
        analyzeBtn.textContent = "ANALYZING...";
    }

    if (signalCard) {
        signalCard.style.display = "block";
    }

    if (signalBadge) {
        signalBadge.textContent = "SCANNING";
    }

    if (trendBadge) {
        trendBadge.textContent = "LIVE MARKET";
    }

    if (selectedPair) {
        selectedPair.textContent = "Scanning live pairs...";
    }

    if (confidence) {
        confidence.textContent = "—";
    }

    if (timeframe) {
        timeframe.textContent = "—";
    }

    if (entryTime) {
        entryTime.textContent = "—";
    }

    if (expiryTime) {
        expiryTime.textContent = "—";
    }

    if (entryPrice) {
        entryPrice.textContent = "—";
    }

    if (callScore) {
        callScore.textContent = "—";
    }

    if (putScore) {
        putScore.textContent = "—";
    }

    if (support) {
        support.textContent = "—";
    }

    if (resistance) {
        resistance.textContent = "—";
    }

    if (ema9) {
        ema9.textContent = "—";
    }

    if (ema21) {
        ema21.textContent = "—";
    }

    if (rsi) {
        rsi.textContent = "—";
    }

    if (adx) {
        adx.textContent = "—";
    }

    if (reasons) {
        reasons.textContent = "Analyzing live market conditions...";
    }
}


// ================================
// RENDER RESULT
// ================================

function renderSignal(result) {

    if (!result) {
        throw new Error("Backend returned no selected market.");
    }

    currentResult = result;

    console.log("AI selected result:", result);

    if (signalCard) {
        signalCard.style.display = "block";
    }

    // Pair
    if (selectedPair) {
        selectedPair.textContent = safe(result.pair);
    }

    // Trend
    if (trendBadge) {
        trendBadge.textContent = safe(result.trend, "—");
    }

    // Signal
    if (signalBadge) {

        const signal = safe(result.signal, "NO TRADE");

        signalBadge.textContent = signal;

        signalBadge.classList.remove(
            "call",
            "put",
            "no-trade"
        );

        if (signal === "CALL") {
            signalBadge.classList.add("call");
        } else if (signal === "PUT") {
            signalBadge.classList.add("put");
        } else {
            signalBadge.classList.add("no-trade");
        }
    }

    // Confidence
    if (confidence) {
        confidence.textContent = formatPercent(result.confidence);
    }

    // Timeframe
    if (timeframe) {
        timeframe.textContent =
            result.timeframe !== undefined
                ? `${result.timeframe} MIN`
                : "—";
    }

    // Entry / Expiry
    if (entryTime) {
        entryTime.textContent = formatDateTime(result.entryTime);
    }

    if (expiryTime) {
        expiryTime.textContent = formatDateTime(result.expiryTime);
    }

    // Entry price
    if (entryPrice) {
        entryPrice.textContent = formatNumber(
            result.entryPrice,
            5
        );
    }

    // Scores
    if (callScore) {
        callScore.textContent = formatPercent(
            result.callScore
        );
    }

    if (putScore) {
        putScore.textContent = formatPercent(
            result.putScore
        );
    }

    // Support / Resistance
    if (support) {
        support.textContent = formatNumber(
            result.support,
            5
        );
    }

    if (resistance) {
        resistance.textContent = formatNumber(
            result.resistance,
            5
        );
    }

    // Indicators
    if (ema9) {
        ema9.textContent = formatNumber(
            result.ema9,
            5
        );
    }

    if (ema21) {
        ema21.textContent = formatNumber(
            result.ema21,
            5
        );
    }

    if (rsi) {
        rsi.textContent = formatNumber(
            result.rsi,
            2
        );
    }

    if (adx) {
        adx.textContent = formatNumber(
            result.adx,
            2
        );
    }

    // Reasons
    if (reasons) {

        if (
            Array.isArray(result.reasons) &&
            result.reasons.length > 0
        ) {

            reasons.innerHTML = result.reasons
                .map(reason => `<div>• ${reason}</div>`)
                .join("");

        } else {

            reasons.textContent = "No detailed reasons returned.";
        }
    }

    // Data age / last candle
    if (dataAge) {
        if (result.lastCandle) {
            dataAge.textContent =
                `Last candle: ${result.lastCandle}`;
        } else {
            dataAge.textContent = "LIVE DATA";
        }
    }

    // Scan info
    if (scanInfo) {

        const candles = safe(
            result.candlesUsed,
            "—"
        );

        scanInfo.textContent =
            `LIVE • ${candles} candles analyzed`;
    }

    if (backendStatus) {
        backendStatus.textContent = "LIVE";
    }

    updateCountdown();
}


// ================================
// RENDER SCANNER INFORMATION
// ================================

function renderScanner(data) {

    if (!data) {
        return;
    }

    if (scanner) {

        const scanned =
            safe(data.scannedPairs, 0);

        const cached =
            safe(data.cachedPairs, 0);

        scanner.textContent =
            `${scanned} pairs scanned • ${cached} cached`;
    }
}


// ================================
// COUNTDOWN
// ================================

function updateCountdown() {

    if (!countdown) {
        return;
    }

    if (!currentResult || !currentResult.entryTime) {
        countdown.textContent = "—";
        return;
    }

    const entry = new Date(
        currentResult.entryTime
    ).getTime();

    if (!Number.isFinite(entry)) {
        countdown.textContent = "—";
        return;
    }

    const now = Date.now();

    const seconds = Math.max(
        0,
        Math.floor((entry - now) / 1000)
    );

    if (seconds <= 0) {

        countdown.textContent = "ENTRY NOW";

        return;
    }

    const minutes = Math.floor(seconds / 60);

    const remainingSeconds = seconds % 60;

    countdown.textContent =
        `ENTRY IN ${minutes}:${String(
            remainingSeconds
        ).padStart(2, "0")}`;
}


// ================================
// MAIN ANALYZE FUNCTION
// ================================

async function analyzeMarket() {

    console.log("ANALYZE MARKET clicked");

    showLoading();

    try {

        const response = await fetch(
            ANALYZE_URL,
            {
                method: "GET",
                cache: "no-store",
                headers: {
                    "Accept": "application/json"
                }
            }
        );

        console.log(
            "Analyze HTTP status:",
            response.status
        );

        const rawText = await response.text();

        console.log(
            "Analyze raw response:",
            rawText
        );

        if (!response.ok) {

            throw new Error(
                `API error ${response.status}: ${rawText}`
            );
        }

        let data;

        try {

            data = JSON.parse(rawText);

        } catch (jsonError) {

            throw new Error(
                "Backend returned invalid JSON."
            );
        }

        console.log(
            "Analyze JSON:",
            data
        );

        if (!data) {
            throw new Error(
                "Backend returned empty response."
            );
        }

        if (!data.selected) {

            throw new Error(
                "Backend returned no selected market."
            );
        }

        renderSignal(data.selected);

        renderScanner(data);

        clearError();

    } catch (error) {

        console.error(
            "ANALYZE MARKET ERROR:",
            error
        );

        showError(
            `Unable to load live market data: ${error.message}`
        );

        if (signalBadge) {
            signalBadge.textContent = "ERROR";
        }

        if (trendBadge) {
            trendBadge.textContent = "DATA ERROR";
        }

    } finally {

        if (analyzeBtn) {
            analyzeBtn.disabled = false;
            analyzeBtn.textContent = "ANALYZE MARKET";
        }
    }
}


// ================================
// BUTTON
// ================================

if (analyzeBtn) {

    analyzeBtn.addEventListener(
        "click",
        analyzeMarket
    );

} else {

    console.error(
        "ANALYZE MARKET button #analyzeBtn not found."
    );
}


// ================================
// COUNTDOWN TIMER
// ================================

if (countdownTimer) {
    clearInterval(countdownTimer);
}

countdownTimer = setInterval(
    updateCountdown,
    1000
);


// ================================
// INITIAL STATUS
// ================================

document.addEventListener(
    "DOMContentLoaded",
    async () => {

        console.log(
            "PO AI Predictor V8 frontend loaded."
        );

        await checkBackend();

        updateCountdown();
    }
);


// ================================
// GLOBAL FUNCTION
// ================================

window.analyzeMarket = analyzeMarket;
