/*
=========================================================
 PO AI PREDICTOR FRONTEND V7.1
 GitHub Pages -> Render Backend

 Backend:
 https://po-ai-predictor-api.onrender.com

 Features:
 - 24 LIVE FX pairs
 - 1 MIN / 2 MIN / 3 MIN
 - CALL / PUT / NO TRADE
 - Confidence
 - Market condition
 - Entry
 - Support / Resistance
 - Indicator summary
=========================================================
*/

const API_URL =
  "https://po-ai-predictor-api.onrender.com";

/*
=========================================================
 STATE
=========================================================
*/

let currentPair = "EUR/USD";
let isAnalyzing = false;

/*
=========================================================
 PAIRS
=========================================================
*/

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

/*
=========================================================
 DOM HELPERS
=========================================================
*/

function getElement(...ids) {
  for (const id of ids) {
    const element =
      document.getElementById(id);

    if (element) {
      return element;
    }
  }

  return null;
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/*
=========================================================
 CREATE / FIND PAIR SELECTOR
=========================================================
*/

function setupPairSelector() {
  let selector =
    getElement(
      "pairSelect",
      "pair",
      "currencyPair"
    );

  if (!selector) {
    return null;
  }

  /*
  Only populate if it is a SELECT element.
  */

  if (
    selector.tagName === "SELECT"
  ) {
    selector.innerHTML = "";

    PAIRS.forEach(pair => {
      const option =
        document.createElement("option");

      option.value = pair;
      option.textContent =
        `${pair} LIVE`;

      selector.appendChild(option);
    });

    selector.value =
      currentPair;

    selector.addEventListener(
      "change",
      () => {
        currentPair =
          selector.value;

        clearResults();
      }
    );
  }

  return selector;
}

/*
=========================================================
 FIND ANALYZE BUTTON
=========================================================
*/

function getAnalyzeButton() {
  return getElement(
    "analyzeBtn",
    "analyzeButton",
    "analyzeMarket",
    "analyze"
  );
}

/*
=========================================================
 STATUS
=========================================================
*/

function setStatus(
  message,
  type = "normal"
) {
  const status =
    getElement(
      "status",
      "connectionStatus",
      "marketStatus"
    );

  if (!status) {
    return;
  }

  status.textContent =
    message;

  status.className =
    `status ${type}`;
}

/*
=========================================================
 LOADING
=========================================================
*/

function setLoading(
  loading
) {
  const button =
    getAnalyzeButton();

  if (!button) {
    return;
  }

  if (loading) {
    button.disabled = true;
    button.dataset.originalText =
      button.textContent;

    button.textContent =
      "ANALYZING...";
  } else {
    button.disabled = false;

    button.textContent =
      button.dataset.originalText ||
      "ANALYZE MARKET";
  }
}

/*
=========================================================
 CLEAR RESULTS
================================================
