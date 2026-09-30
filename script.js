/* =========================================================
   PO AI PREDICTOR V8
   FRONTEND SCRIPT
   Live API: Twelve Data LIVE
========================================================= */

const API_URL =
  "https://po-ai-predictor-api.onrender.com";

const ANALYZE_URL =
  `${API_URL}/api/analyze`;


/* =========================================================
   DOM ELEMENTS
========================================================= */

const analyzeBtn =
  document.getElementById("analyzeBtn");

const results =
  document.getElementById("results");

const pairSelect =
  document.getElementById("pair");


/* =========================================================
   HELPERS
========================================================= */

function escapeHtml(value) {

  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function formatNumber(value, decimals = 5) {

  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "—";
  }

  return Number(value).toFixed(decimals);
}


function getDigits(pair) {

  return String(pair || "").includes("JPY")
    ? 3
    : 5;
}


function formatDateTime(value) {

  if (!value) {
    return "—";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return value;
  }

  return date.toLocaleString(
    undefined,
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }
  );
}


/* =========================================================
   BUTTON STATE
========================================================= */

function setLoading(loading) {

  if (!analyzeBtn) {
    return;
  }

  analyzeBtn.disabled =
    loading;

  if (loading) {

    analyzeBtn.dataset.originalText =
      analyzeBtn.textContent;

    analyzeBtn.textContent =
      "ANALYZING...";

  } else {

    analyzeBtn.textContent =
      analyzeBtn.dataset.originalText ||
      "ANALYZE MARKET";
  }
}


/* =========================================================
   LOADING SCREEN
========================================================= */

function showLoading() {

  if (!results) {
    return;
  }

  results.innerHTML = `
    <div class="signal-card loading-card">

      <div class="loading-title">
        ANALYZING MARKET
      </div>

      <div class="loading-text">
        Getting live Twelve Data market data...
      </div>

      <div class="loading-text">
        Calculating EMA 9/21, RSI, ADX,
        Support & Resistance...
      </div>

    </div>
  `;
}


/* =========================================================
   ERROR SCREEN
========================================================= */

function showError(message) {

  if (!results) {
    return;
  }

  results.innerHTML = `
    <div class="signal-card error-card">

      <div class="signal-title">
        DATA ERROR
      </div>

      <div class="error-message">
        ${escapeHtml(message)}
      </div>

      <div class="error-help">
        Please try ANALYZE MARKET again.
      </div>

    </div>
  `;
}


/* =========================================================
   SIGNAL CLASS
========================================================= */

function signalClass(signal) {

  if (signal === "CALL") {
    return "call";
  }

  if (signal === "PUT") {
    return "put";
  }

  return "no-trade";
}


/* =========================================================
   RENDER SELECTED RESULT
========================================================= */

function renderSignal(signal) {

  if (!results) {
    return;
  }

  if (!signal) {

    showError(
      "The API did not return a selected market."
    );

    return;
  }

  const pair =
    signal.pair || "—";

  const timeframe =
    Number(signal.timeframe) || 1;

  const signalName =
    signal.signal || "NO TRADE";

  const confidence =
    Number.isFinite(
      Number(signal.confidence)
    )
      ? Number(signal.confidence)
      : 0;

  const digits =
    getDigits(pair);

  const trend =
    signal.trend || "RANGE";

  const signalCss =
    signalClass(signalName);


  /* =======================================================
     REASONS
  ======================================================= */

  let reasonsHtml =
    "";

  if (
    Array.isArray(
      signal.reasons
    ) &&
    signal.reasons.length > 0
  ) {

    reasonsHtml =
      signal.reasons
        .map(
          reason => `
            <li>
              ${escapeHtml(reason)}
            </li>
          `
        )
        .join("");

  } else {

    reasonsHtml =
      "<li>No additional reasons.</li>";
  }


  /* =======================================================
     MAIN CARD
  ======================================================= */

  results.innerHTML = `

    <div class="signal-card ${signalCss}">

      <div class="pair-title">
        ${escapeHtml(pair)}
      </div>

      <div class="timeframe-title">
        ${timeframe} MIN MINUTES
      </div>


      <div class="trend-box">
        ${escapeHtml(trend)}
      </div>


      <div class="signal-main ${signalCss}">

        ${escapeHtml(signalName)}

      </div>


      <div class="confidence">

        CONFIDENCE

        <strong>
          ${confidence}%
        </strong>

      </div>


      <div class="signal-grid">

        <div class="info-box">
          <span>PAIR</span>
          <strong>
            ${escapeHtml(pair)}
          </strong>
        </div>


        <div class="info-box">
          <span>TIMEFRAME</span>
          <strong>
            ${timeframe} MIN
          </strong>
        </div>


        <div class="info-box">
          <span>EXPIRY</span>
          <strong>
            ${timeframe} MIN
          </strong>
        </div>


        <div class="info-box">
          <span>ENTRY PRICE</span>
          <strong>
            ${formatNumber(
              signal.entryPrice,
              digits
            )}
          </strong>
        </div>


        <div class="info-box">
          <span>ENTRY TIME</span>
          <strong>
            ${formatDateTime(
              signal.entryTime
            )}
          </strong>
        </div>


        <div class="info-box">
          <span>EXPIRY TIME</span>
          <strong>
            ${formatDateTime(
              signal.expiryTime
            )}
          </strong>
        </div>


        <div class="info-box">
          <span>CALL SCORE</span>
          <strong>
            ${signal.callScore ?? "—"}%
          </strong>
        </div>


        <div class="info-box">
          <span>PUT SCORE</span>
          <strong>
            ${signal.putScore ?? "—"}%
          </strong>
        </div>

      </div>


      <div class="section-title">
        SUPPORT / RESISTANCE
      </div>


      <div class="indicator-grid">

        <div class="indicator-box">
          <span>SUPPORT</span>
          <strong>
            ${formatNumber(
              signal.support,
              digits
            )}
          </strong>
        </div>


        <div class="indicator-box">
          <span>RESISTANCE</span>
          <strong>
            ${formatNumber(
              signal.resistance,
              digits
            )}
          </strong>
        </div>

      </div>


      <div class="section-title">
        TECHNICAL INDICATORS
      </div>


      <div class="indicator-grid">

        <div class="indicator-box">
          <span>EMA 9</span>
          <strong>
            ${formatNumber(
              signal.ema9,
              digits
            )}
          </strong>
        </div>


        <div class="indicator-box">
          <span>EMA 21</span>
          <strong>
            ${formatNumber(
              signal.ema21,
              digits
            )}
          </strong>
        </div>


        <div class="indicator-box">
          <span>RSI 14</span>
          <strong>
            ${formatNumber(
              signal.rsi,
              2
            )}
          </strong>
        </div>


        <div class="indicator-box">
          <span>ADX 14</span>
          <strong>
            ${formatNumber(
              signal.adx,
              2
            )}
          </strong>
        </div>

      </div>


      <div class="section-title">
        ANALYSIS REASONS
      </div>


      <ul class="reasons">
        ${reasonsHtml}
      </ul>


      <div class="market-meta">

        <div>
          Candles Used:
          <strong>
            ${signal.candlesUsed ?? "—"}
          </strong>
        </div>

        <div>
          Last Candle:
          <strong>
            ${escapeHtml(
              signal.lastCandle || "—"
            )}
          </strong>
        </div>

        <div>
          Generated:
          <strong>
            ${formatDateTime(
              signal.generatedAt
            )}
          </strong>
        </div>

      </div>

    </div>
  `;
}


/* =========================================================
   ANALYZE MARKET
========================================================= */

async function analyzeMarket() {

  setLoading(true);

  showLoading();


  try {

    /*
      IMPORTANT:
      V8 backend selects the best pair/timeframe itself.

      We therefore DO NOT send 1 MIN / 2 MIN / 3 MIN
      separately.

      The API returns:

      {
        selected: {...}
      }

      and we display ONLY selected.
    */

    const response =
      await fetch(
        ANALYZE_URL,
        {
          method: "GET",
          headers: {
            "Accept":
              "application/json"
          },
          cache: "no-store"
        }
      );


    let data = null;

    try {

      data =
        await response.json();

    } catch {

      throw new Error(
        `Server returned HTTP ${response.status}`
      );
    }


    if (!response.ok) {

      throw new Error(
        data?.error ||
        `API request failed with HTTP ${response.status}`
      );
    }


    if (!data) {

      throw new Error(
        "Empty response from V8 API."
      );
    }


    if (!data.selected) {

      throw new Error(
        data.error ||
        "V8 API returned no selected market."
      );
    }


    /*
      Render ONE selected result only.
    */

    renderSignal(
      data.selected
    );


    /*
      Optional console information
      useful for testing.
    */

    console.log(
      "PO AI Predictor V8 response:",
      data
    );

    console.log(
      "Selected market:",
      data.selected
    );


  } catch (error) {

    console.error(
      "ANALYZE MARKET ERROR:",
      error
    );


    showError(
      error.message ||
      "Unable to connect to the V8 analysis server."
    );

  } finally {

    setLoading(false);
  }
}


/* =========================================================
   BUTTON EVENT
========================================================= */

if (analyzeBtn) {

  analyzeBtn.addEventListener(
    "click",
    analyzeMarket
  );

}


/* =========================================================
   OPTIONAL ENTER KEY
========================================================= */

if (pairSelect) {

  pairSelect.addEventListener(
    "keydown",
    event => {

      if (
        event.key === "Enter"
      ) {

        analyzeMarket();

      }

    }
  );

}


/* =========================================================
   INITIAL MESSAGE
========================================================= */

if (results) {

  results.innerHTML = `

    <div class="signal-card">

      <div class="signal-title">
        READY
      </div>

      <div class="loading-text">
        Select your market settings
        and press ANALYZE MARKET.
      </div>

      <div class="loading-text">
        V8 will select the strongest
        available live market and timeframe.
      </div>

    </div>

  `;
}


/* =========================================================
   GLOBAL ACCESS
========================================================= */

window.analyzeMarket =
  analyzeMarket;
