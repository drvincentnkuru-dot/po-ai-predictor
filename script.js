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
 - Expiry
 - Support / Resistance
 - Indicator summary
=========================================================
*/

const API_URL = "https://po-ai-predictor-api.onrender.com";

let currentPair = "EUR/USD";
let isAnalyzing = false;

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
    const element = document.getElementById(id);

    if (element) {
      return element;
    }
  }

  return null;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/*
=========================================================
 PAIR SELECTOR
=========================================================
*/

function setupPairSelector() {
  const selector = getElement(
    "pairSelect",
    "pair",
    "currencyPair"
  );

  if (!selector) {
    console.warn("Currency pair selector not found.");
    return null;
  }

  if (selector.tagName === "SELECT") {
    selector.innerHTML = "";

    PAIRS.forEach(pair => {
      const option = document.createElement("option");

      option.value = pair;
      option.textContent = `${pair} LIVE`;

      selector.appendChild(option);
    });

    selector.value = currentPair;

    selector.addEventListener("change", () => {
      currentPair = selector.value;

      updatePairLabels(currentPair);
      clearResults();

      setStatus(
        `READY • ${currentPair}`,
        "normal"
      );
    });
  }

  return selector;
}

/*
=========================================================
 ANALYZE BUTTON
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
 RESULTS CONTAINER
=========================================================
*/

function getResultsContainer() {
  let results = getElement(
    "results",
    "signalResults",
    "signals",
    "result"
  );

  /*
  If the HTML does not contain results,
  create it automatically.
  */

  if (!results) {
    const section = document.createElement("section");

    section.className = "card";

    section.innerHTML = `
      <h2>AI SIGNALS</h2>
      <div id="results"></div>
    `;

    document.querySelector(".app")?.appendChild(section);

    results =
      document.getElementById("results");
  }

  return results;
}

/*
=========================================================
 STATUS
=========================================================
*/

function setStatus(message, type = "normal") {
  const status = getElement(
    "status",
    "connectionStatus",
    "marketStatus"
  );

  if (!status) {
    return;
  }

  status.textContent = message;

  status.className = `status ${type}`;
}

/*
=========================================================
 LOADING
=========================================================
*/

function setLoading(loading) {
  const button = getAnalyzeButton();

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
 PAIR LABELS
=========================================================
*/

function updatePairLabels(pair) {
  const pairLabel = document.getElementById(
    "pairLabel"
  );

  const pairLabel2 = document.getElementById(
    "pairLabel2"
  );

  if (pairLabel) {
    pairLabel.textContent = pair;
  }

  if (pairLabel2) {
    pairLabel2.textContent = pair;
  }
}

/*
=========================================================
 CLEAR RESULTS
=========================================================
*/

function clearResults() {
  const results =
    getResultsContainer();

  if (!results) {
    return;
  }

  results.innerHTML = `
    <div class="signal-card">
      <h3>READY</h3>
      <p>
        Select a LIVE currency pair and press
        <strong>ANALYZE MARKET</strong>.
      </p>
    </div>
  `;
}

/*
=========================================================
 NUMBER FORMAT
=========================================================
*/

function formatNumber(value, decimals = 5) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "--";
  }

  return number.toFixed(decimals);
}

/*
=========================================================
 SIGNAL CLASS
=========================================================
*/

function signalClass(signal) {
  const value =
    String(signal || "")
      .toUpperCase();

  if (value === "CALL") {
    return "call";
  }

  if (value === "PUT") {
    return "put";
  }

  return "no-trade";
}

/*
=========================================================
 SIGNAL ICON
=========================================================
*/

function signalIcon(signal) {
  const value =
    String(signal || "")
      .toUpperCase();

  if (value === "CALL") {
    return "▲";
  }

  if (value === "PUT") {
    return "▼";
  }

  return "•";
}

/*
=========================================================
 INDICATOR VALUE
=========================================================
*/

function indicatorValue(indicators, keys, decimals = 5) {
  if (!indicators) {
    return "--";
  }

  for (const key of keys) {
    if (
      indicators[key] !== undefined &&
      indicators[key] !== null
    ) {
      const value =
        indicators[key];

      if (
        typeof value === "number"
      ) {
        return formatNumber(
          value,
          decimals
        );
      }

      return escapeHTML(value);
    }
  }

  return "--";
}

/*
=========================================================
 RENDER ONE SIGNAL CARD
=========================================================
*/

function renderSignalCard(data) {
  const signal =
    String(data.signal || "NO TRADE")
      .toUpperCase();

  const confidence =
    Number(data.confidence ?? 0);

  const timeframe =
    data.timeframe ??
    data.tf ??
    "--";

  const entry =
    data.entry ??
    data.price ??
    data.currentPrice;

  const expiry =
    data.expiry ??
    `${timeframe} minute`;

  const marketCondition =
    data.marketCondition ??
    data.condition ??
    "--";

  const support =
    data.support;

  const resistance =
    data.resistance;

  const indicators =
    data.indicators || {};

  const reasons =
    Array.isArray(data.reasons)
      ? data.reasons
      : [];

  const lastCandle =
    data.lastCandle ??
    data.lastCandleTime ??
    data.candleTime ??
    "--";

  const candleCount =
    data.candleCount ??
    data.candles ??
    "--";

  const callScore =
    data.callScore ??
    data.call ??
    "--";

  const putScore =
    data.putScore ??
    data.put ??
    "--";

  return `
    <div class="signal-card ${signalClass(signal)}">

      <div class="signal-header">

        <div>
          <h3>${escapeHTML(timeframe)} MIN</h3>
          <p>${escapeHTML(currentPair)}</p>
        </div>

        <div class="signal ${signalClass(signal)}">
          ${signalIcon(signal)}
          ${escapeHTML(signal)}
        </div>

      </div>


      <div class="confidence-box">

        <span>Confidence</span>

        <strong>
          ${escapeHTML(confidence)}%
        </strong>

      </div>


      <div class="info">

        <div>
          <span>Entry</span>
          <strong>
            ${escapeHTML(formatNumber(entry, 5))}
          </strong>
        </div>

        <div>
          <span>Expiry</span>
          <strong>
            ${escapeHTML(expiry)}
          </strong>
        </div>

        <div>
          <span>Market</span>
          <strong>
            ${escapeHTML(marketCondition)}
          </strong>
        </div>

      </div>


      <div class="score-row">

        <div>
          <span>CALL Score</span>
          <strong>
            ${escapeHTML(callScore)}
          </strong>
        </div>

        <div>
          <span>PUT Score</span>
          <strong>
            ${escapeHTML(putScore)}
          </strong>
        </div>

      </div>


      <div class="levels">

        <div>
          <span>Support</span>
          <strong>
            ${escapeHTML(
              formatNumber(support, 5)
            )}
          </strong>
        </div>

        <div>
          <span>Resistance</span>
          <strong>
            ${escapeHTML(
              formatNumber(resistance, 5)
            )}
          </strong>
        </div>

      </div>


      <div class="indicators">

        <h4>Indicators</h4>

        <div class="indicator-grid">

          <div>
            <span>EMA 9</span>
            <strong>
              ${indicatorValue(
                indicators,
                ["ema9", "EMA9"]
              )}
            </strong>
          </div>

          <div>
            <span>EMA 21</span>
            <strong>
              ${indicatorValue(
                indicators,
                ["ema21", "EMA21"]
              )}
            </strong>
          </div>

          <div>
            <span>RSI 14</span>
            <strong>
              ${indicatorValue(
                indicators,
                ["rsi", "RSI", "rsi14"],
                2
              )}
            </strong>
          </div>

          <div>
            <span>MACD</span>
            <strong>
              ${indicatorValue(
                indicators,
                ["macd", "MACD"],
                6
              )}
            </strong>
          </div>

          <div>
            <span>MACD Histogram</span>
            <strong>
              ${indicatorValue(
                indicators,
                [
                  "macdHistogram",
                  "histogram",
                  "macdHist"
                ],
                6
              )}
            </strong>
          </div>

          <div>
            <span>ATR 14</span>
            <strong>
              ${indicatorValue(
                indicators,
                ["atr", "ATR"],
                6
              )}
            </strong>
          </div>

          <div>
            <span>Stochastic</span>
            <strong>
              ${indicatorValue(
                indicators,
                [
                  "stochastic",
                  "stoch",
                  "stochasticK"
                ],
                2
              )}
            </strong>
          </div>

          <div>
            <span>Bollinger Upper</span>
            <strong>
              ${indicatorValue(
                indicators,
                [
                  "bbUpper",
                  "bollingerUpper",
                  "upperBand"
                ]
              )}
            </strong>
          </div>

          <div>
            <span>Bollinger Middle</span>
            <strong>
              ${indicatorValue(
                indicators,
                [
                  "bbMiddle",
                  "bollingerMiddle",
                  "middleBand"
                ]
              )}
            </strong>
          </div>

          <div>
            <span>Bollinger Lower</span>
            <strong>
              ${indicatorValue(
                indicators,
                [
                  "bbLower",
                  "bollingerLower",
                  "lowerBand"
                ]
              )}
            </strong>
          </div>

          <div>
            <span>Momentum</span>
            <strong>
              ${indicatorValue(
                indicators,
                ["momentum"],
                6
              )}
            </strong>
          </div>

        </div>

      </div>


      ${
        reasons.length > 0
          ? `
            <div class="reasons">

              <h4>Analysis</h4>

              <ul>
                ${reasons
                  .map(
                    reason =>
                      `<li>${escapeHTML(reason)}</li>`
                  )
                  .join("")}
              </ul>

            </div>
          `
          : ""
      }


      <div class="technical-info">

        <div>
          <span>Last Candle</span>
          <strong>
            ${escapeHTML(lastCandle)}
          </strong>
        </div>

        <div>
          <span>Candles</span>
          <strong>
            ${escapeHTML(candleCount)}
          </strong>
        </div>

      </div>

    </div>
  `;
}

/*
=========================================================
 RENDER ANALYSIS
=========================================================
*/

function renderAnalysis(result) {
  const results =
    getResultsContainer();

  if (!results) {
    return;
  }

  let signals = [];

  /*
  Backend V7.1 returns:
  {
    pair,
    signals: {
      "1": {...},
      "2": {...},
      "3": {...}
    }
  }

  This also supports an array response.
  */

  if (
    result &&
    result.signals &&
    typeof result.signals === "object"
  ) {
    signals = [
      result.signals["1"],
      result.signals["2"],
      result.signals["3"]
    ].filter(Boolean);
  } else if (
    result &&
    Array.isArray(result.signals)
  ) {
    signals = result.signals;
  } else if (
    result &&
    Array.isArray(result.data)
  ) {
    signals = result.data;
  }

  if (signals.length === 0) {
    results.innerHTML = `
      <div class="signal-card no-trade">

        <h3>NO DATA</h3>

        <p>
          Backend returned no signal data.
        </p>

      </div>
    `;

    return;
  }

  results.innerHTML =
    signals
      .map(signal =>
        renderSignalCard(signal)
      )
      .join("");
}

/*
=========================================================
 ANALYZE MARKET
=========================================================
*/

async function analyzeMarket() {
  if (isAnalyzing) {
    return;
  }

  const selector =
    getElement(
      "pairSelect",
      "pair",
      "currencyPair"
    );

  if (selector) {
    currentPair =
      selector.value ||
      currentPair;
  }

  updatePairLabels(currentPair);

  isAnalyzing = true;

  setLoading(true);

  setStatus(
    `ANALYZING ${currentPair}...`,
    "loading"
  );

  const results =
    getResultsContainer();

  if (results) {
    results.innerHTML = `
      <div class="signal-card">

        <h3>ANALYZING...</h3>

        <p>
          Getting LIVE market data from Twelve Data...
        </p>

      </div>
    `;
  }

  try {

    const url =
      `${API_URL}/api/analyze?pair=${encodeURIComponent(
        currentPair
      )}`;

    console.log(
      "Requesting:",
      url
    );

    const response =
      await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json"
        },
        cache: "no-store"
      });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    console.log(
      "Backend response:",
      data
    );

    if (
      data.error ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Backend returned an error."
      );
    }

    renderAnalysis(data);

    setStatus(
      `LIVE DATA CONNECTED • ${currentPair}`,
      "connected"
    );

    const dataStatus =
      document.getElementById(
        "dataStatus"
      );

    if (dataStatus) {
      dataStatus.textContent =
        "CONNECTED";
    }

  } catch (error) {

    console.error(
      "Analysis error:",
      error
    );

    if (results) {
      results.innerHTML = `
        <div class="signal-card no-trade">

          <h3>ANALYSIS ERROR</h3>

          <p>
            ${escapeHTML(
              error.message ||
              "Unable to get market data."
            )}
          </p>

          <p>
            Please wait a moment and try again.
          </p>

        </div>
      `;
    }

    setStatus(
      "CONNECTION ERROR",
      "error"
    );

    const dataStatus =
      document.getElementById(
        "dataStatus"
      );

    if (dataStatus) {
      dataStatus.textContent =
        "ERROR";
    }

  } finally {

    isAnalyzing = false;

    setLoading(false);
  }
}

/*
=========================================================
 HEALTH CHECK
=========================================================
*/

async function checkBackend() {
  try {

    const response =
      await fetch(
        `${API_URL}/api/health`,
        {
          method: "GET",
          headers: {
            "Accept": "application/json"
          },
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    console.log(
      "Backend health:",
      data
    );

    if (
      data.ok === true &&
      String(data.version)
        .toUpperCase()
        .includes("V7.1")
    ) {

      setStatus(
        "BACKEND CONNECTED • V7.1",
        "connected"
      );

      const dataStatus =
        document.getElementById(
          "dataStatus"
        );

      if (dataStatus) {
        dataStatus.textContent =
          "READY";
      }

      return true;
    }

    setStatus(
      "BACKEND ONLINE",
      "connected"
    );

    return true;

  } catch (error) {

    console.error(
      "Health check error:",
      error
    );

    setStatus(
      "BACKEND OFFLINE / STARTING",
      "error"
    );

    return false;
  }
}

/*
=========================================================
 BUTTON EVENTS
=========================================================
*/

function setupAnalyzeButton() {
  const button =
    getAnalyzeButton();

  if (!button) {
    console.error(
      "ANALYZE button not found."
    );

    return;
  }

  button.addEventListener(
    "click",
    analyzeMarket
  );
}

/*
=========================================================
 INITIALIZE
=========================================================
*/

function initialize() {

  console.log(
    "PO AI Predictor V7.1 starting..."
  );

  setupPairSelector();

  setupAnalyzeButton();

  updatePairLabels(
    currentPair
  );

  getResultsContainer();

  checkBackend();

  /*
  Auto health check every 60 seconds.
  */

  setInterval(
    checkBackend,
    60000
  );

  /*
  Refresh current analysis every 60 seconds
  only when user has already analyzed once.
  */

  setInterval(() => {

    if (
      currentPair &&
      !isAnalyzing
    ) {

      const results =
        getResultsContainer();

      if (
        results &&
        results.dataset.analyzed === "true"
      ) {
        analyzeMarket();
      }
    }

  }, 60000);
}

/*
=========================================================
 MARK ANALYSIS AS ACTIVE
=========================================================
*/

const originalRenderAnalysis =
  renderAnalysis;

renderAnalysis = function(result) {

  originalRenderAnalysis(result);

  const results =
    getResultsContainer();

  if (results) {
    results.dataset.analyzed =
      "true";
  }
};

/*
=========================================================
 START
=========================================================
*/

if (
  document.readyState ===
  "loading"
) {

  document.addEventListener(
    "DOMContentLoaded",
    initialize
  );

} else {

  initialize();

}
