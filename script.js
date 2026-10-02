'use strict';

/*
===========================================================
 PO AI PREDICTOR
 V8.6.2 • SMART LIVE SCANNER FRONTEND

 Backend:
 https://po-ai-predictor-api.onrender.com

 Supports:
 • /api/best
 • /api/selected
 • /api/scanner
 • /api/performance
 • /api/history
 • /api/analyze

 V8.6.2 FIX:
 • selectedMarket fallback
 • best fallback
 • stale result support
 • no false DATA ERROR
 • selected timeframe only
 • automatic performance refresh
 • CALL / PUT visual classes
 • entry / expiry countdown
===========================================================
*/

const API_URL =
  'https://po-ai-predictor-api.onrender.com';

const POLL_MS =
  10 * 1000;

const COUNTDOWN_MS =
  1000;

let selectedMarket =
  null;

let pollTimer =
  null;

let countdownTimer =
  null;

let analyzing =
  false;

/* =========================================================
   ELEMENT HELPERS
========================================================= */

function getElement(
  ...ids
) {
  for (
    const id of ids
  ) {
    const element =
      document.getElementById(id);

    if (element) {
      return element;
    }
  }

  return null;
}

function findButtonByText(
  text
) {
  return [
    ...document.querySelectorAll(
      'button'
    )
  ].find(
    button =>
      button.textContent
        .trim()
        .toUpperCase() ===
      text.toUpperCase()
  ) || null;
}

function analyzeButton() {
  return (
    getElement(
      'analyzeBtn',
      'analyzeButton',
      'analyze-market',
      'analyzeMarketBtn'
    ) ||
    findButtonByText(
      'ANALYZE MARKET'
    )
  );
}

function statusElement() {
  return getElement(
    'status',
    'statusText',
    'connectionStatus',
    'marketStatus',
    'scannerStatus'
  );
}

function pairElement() {
  return getElement(
    'pair',
    'pairValue',
    'selectedPair',
    'marketPair',
    'selectedMarketPair'
  );
}

function signalElement() {
  return getElement(
    'signal',
    'signalValue',
    'selectedSignal',
    'marketSignal'
  );
}

function confidenceElement() {
  return getElement(
    'confidence',
    'confidenceValue',
    'selectedConfidence',
    'marketConfidence'
  );
}

function timeframeElement() {
  return getElement(
    'timeframe',
    'timeframeValue',
    'selectedTimeframe',
    'marketTimeframe'
  );
}

function entryElement() {
  return getElement(
    'entry',
    'entryValue',
    'entryTime',
    'selectedEntry',
    'marketEntry'
  );
}

function expiryElement() {
  return getElement(
    'expiry',
    'expiryValue',
    'expiryTime',
    'selectedExpiry',
    'marketExpiry'
  );
}

function priceElement() {
  return getElement(
    'price',
    'priceValue',
    'currentPrice',
    'marketPrice',
    'selectedPrice'
  );
}

function resultElement() {
  return getElement(
    'result',
    'resultValue',
    'tradeResult',
    'selectedResult'
  );
}

function performanceElement() {
  return getElement(
    'performance',
    'performanceValue',
    'winRate',
    'performanceText'
  );
}

function winsElement() {
  return getElement(
    'wins',
    'winsValue'
  );
}

function lossesElement() {
  return getElement(
    'losses',
    'lossesValue'
  );
}

function pendingElement() {
  return getElement(
    'pending',
    'pendingValue'
  );
}

function drawsElement() {
  return getElement(
    'draws',
    'drawsValue'
  );
}

function totalElement() {
  return getElement(
    'total',
    'totalValue'
  );
}

function countdownElement() {
  return getElement(
    'countdown',
    'countdownValue',
    'entryCountdown',
    'expiryCountdown'
  );
}

function reasonsElement() {
  return getElement(
    'reasons',
    'reasonList',
    'signalReasons'
  );
}

/* =========================================================
   BASIC UI
========================================================= */

function setText(
  element,
  value
) {
  if (!element) {
    return;
  }

  element.textContent =
    value == null ||
    value === ''
      ? '—'
      : String(value);
}

function formatTime(
  value
) {
  if (!value) {
    return '—';
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return String(value);
  }

  return (
    date.toLocaleTimeString(
      [],
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',

        hour12: false
      }
    ) +
    ' UTC'
  );
}

function formatPrice(
  value
) {
  if (
    value == null ||
    value === ''
  ) {
    return '—';
  }

  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
    return String(value);
  }

  return number.toFixed(5);
}

function formatConfidence(
  value
) {
  if (
    value == null
  ) {
    return '—';
  }

  return (
    Math.round(
      Number(value)
    ) +
    '%'
  );
}

/* =========================================================
   STATUS
========================================================= */

function setStatus(
  message,
  type = 'normal'
) {
  const element =
    statusElement();

  if (!element) {
    return;
  }

  element.textContent =
    message;

  element.dataset.status =
    type;
}

/* =========================================================
   SIGNAL COLORS
========================================================= */

function paintSignal(
  signal
) {
  const element =
    signalElement();

  if (!element) {
    return;
  }

  element.textContent =
    signal || '—';

  element.classList.remove(
    'call',
    'put',
    'no-trade'
  );

  if (
    signal === 'CALL'
  ) {
    element.classList.add(
      'call'
    );
  } else if (
    signal === 'PUT'
  ) {
    element.classList.add(
      'put'
    );
  } else {
    element.classList.add(
      'no-trade'
    );
  }
}

/* =========================================================
   REASONS
========================================================= */

function escapeHtml(
  value
) {
  return String(
    value
  ).replace(
    /[&<>'"]/g,
    character =>
      ({
        '&':
          '&amp;',
        '<':
          '&lt;',
        '>':
          '&gt;',
        "'":
          '&#39;',
        '"':
          '&quot;'
      }[character])
  );
}

function renderReasons(
  reasons
) {
  const element =
    reasonsElement();

  if (!element) {
    return;
  }

  if (
    !Array.isArray(
      reasons
    ) ||
    !reasons.length
  ) {
    element.textContent =
      '—';

    return;
  }

  if (
    element.tagName ===
      'UL' ||
    element.tagName ===
      'OL'
  ) {
    element.innerHTML =
      reasons
        .map(
          reason =>
            `<li>${escapeHtml(
              reason
            )}</li>`
        )
        .join('');
  } else {
    element.textContent =
      reasons.join(
        ' • '
      );
  }
}

/* =========================================================
   RENDER MARKET
========================================================= */

function renderMarket(
  market
) {
  if (!market) {
    return;
  }

  selectedMarket =
    market;

  setText(
    pairElement(),
    market.pair
  );

  paintSignal(
    market.signal
  );

  setText(
    confidenceElement(),
    formatConfidence(
      market.confidence
    )
  );

  setText(
    timeframeElement(),
    market.timeframe != null
      ? `${market.timeframe} MIN`
      : '—'
  );

  setText(
    entryElement(),
    formatTime(
      market.entryTime
    )
  );

  setText(
    expiryElement(),
    formatTime(
      market.expiryTime
    )
  );

  setText(
    priceElement(),
    formatPrice(
      market.currentPrice ??
        market.predictedPrice
    )
  );

  setText(
    resultElement(),
    market.resultStatus ||
      market.result ||
      'PENDING'
  );

  renderReasons(
    market.reasons
  );

  /*
  Allow CSS to react to CALL / PUT.
  */

  document.body.dataset.signal =
    market.signal ||
    'NO TRADE';

  document.body.dataset.stale =
    market.stale
      ? 'true'
      : 'false';

  /*
  V8.6.2:
  stale does NOT mean error.

  It means:
  latest valid market remains visible
  while scanner is preparing a newer batch.
  */

  if (
    market.stale
  ) {
    setStatus(
      'LIVE MARKET • latest valid scan is being used',
      'fallback'
    );
  } else {
    setStatus(
      'LIVE DATA CONNECTED • selected market updated',
      'live'
    );
  }

  updateCountdown();
}

/* =========================================================
   PERFORMANCE
========================================================= */

function renderPerformance(
  performance
) {
  if (!performance) {
    return;
  }

  setText(
    performanceElement(),
    performance.winRate ==
      null
      ? '—'
      : `${Number(
          performance.winRate
        ).toFixed(1)}%`
  );

  setText(
    winsElement(),
    performance.wins
  );

  setText(
    lossesElement(),
    performance.losses
  );

  setText(
    pendingElement(),
    performance.pending
  );

  setText(
    drawsElement(),
    performance.draws
  );

  setText(
    totalElement(),
    performance.total
  );
}

/* =========================================================
   COUNTDOWN
========================================================= */

function updateCountdown() {
  const element =
    countdownElement();

  if (
    !element ||
    !selectedMarket
  ) {
    return;
  }

  const entry =
    new Date(
      selectedMarket.entryTime
    ).getTime();

  const expiry =
    new Date(
      selectedMarket.expiryTime
    ).getTime();

  if (
    !Number.isFinite(
      entry
    ) ||
    !Number.isFinite(
      expiry
    )
  ) {
    element.textContent =
      '—';

    return;
  }

  const now =
    Date.now();

  /*
  Before entry:
  count toward entry.

  After entry:
  count toward expiry.
  */

  const target =
    now < entry
      ? entry
      : expiry;

  const seconds =
    Math.max(
      0,
      Math.ceil(
        (
          target -
          now
        ) / 1000
      )
    );

  if (
    now < entry
  ) {
    element.textContent =
      `ENTRY IN ${seconds}s`;
  } else if (
    seconds > 0
  ) {
    element.textContent =
      `EXPIRES IN ${seconds}s`;
  } else {
    element.textContent =
      'EXPIRED • awaiting settlement';
  }
}

/* =========================================================
   API
========================================================= */

async function getJson(
  path,
  options = {}
) {
  const response =
    await fetch(
      `${API_URL}${path}`,
      {
        cache:
          'no-store',

        ...options
      }
    );

  let data;

  try {
    data =
      await response.json();
  } catch {
    throw new Error(
      `Backend returned HTTP ${response.status} with invalid JSON.`
    );
  }

  if (
    !response.ok &&
    !data.ok
  ) {
    throw new Error(
      data.error ||
        `Backend HTTP ${response.status}`
    );
  }

  return data;
}

/* =========================================================
   LOAD BEST MARKET
========================================================= */

async function loadBest(
  showLoading = false
) {
  if (
    showLoading
  ) {
    setStatus(
      'SCANNING LIVE MARKET…',
      'loading'
    );
  }

  try {
    const data =
      await getJson(
        '/api/best'
      );

    /*
    Backend compatibility:

    V8.6.2:
      data.selectedMarket

    Older versions:
      data.best
      data.selected
      data.market
    */

    const market =
      data.selectedMarket ||
      data.best ||
      data.selected ||
      data.market ||
      null;

    if (market) {
      renderMarket(
        market
      );

      renderPerformance(
        data.performance
      );

      return true;
    }

    renderPerformance(
      data.performance
    );

    if (
      data.scan?.running
    ) {
      setStatus(
        'SCANNING LIVE PAIRS…',
        'loading'
      );
    } else {
      setStatus(
        'WAITING FOR LIVE MARKET SCAN…',
        'waiting'
      );
    }

    return false;
  } catch (error) {
    setStatus(
      `DATA ERROR • ${error.message}`,
      'error'
    );

    return false;
  }
}

/* =========================================================
   PERFORMANCE
========================================================= */

async function loadPerformance() {
  try {
    const data =
      await getJson(
        '/api/performance'
      );

    renderPerformance(
      data.performance
    );
  } catch {
    /*
    Performance failure should not
    destroy the selected market UI.
    */
  }
}

/* =========================================================
   SCANNER STATUS
========================================================= */

async function loadScannerStatus() {
  try {
    const data =
      await getJson(
        '/api/scanner'
      );

    if (
      data.running
    ) {
      setStatus(
        'SCANNING LIVE PAIRS…',
        'loading'
      );
    }
  } catch {
    /*
    Ignore scanner status failure.
    */
  }
}

/* =========================================================
   ANALYZE MARKET
========================================================= */

async function analyzeMarket() {
  if (
    analyzing
  ) {
    return;
  }

  analyzing =
    true;

  const button =
    analyzeButton();

  if (button) {
    button.disabled =
      true;

    button.dataset.oldText =
      button.textContent;

    button.textContent =
      'ANALYZING…';
  }

  try {
    /*
    IMPORTANT:

    Do NOT call /api/analyze without
    a selected pair here.

    /api/best is the smart selector and
    does not create an additional Twelve
    Data request.

    This keeps the frontend quota-safe.
    */

    const found =
      await loadBest(
        true
      );

    if (!found) {
      await loadScannerStatus();
    }

    await loadPerformance();
  } finally {
    analyzing =
      false;

    if (button) {
      button.disabled =
        false;

      button.textContent =
        button.dataset.oldText ||
        'ANALYZE MARKET';
    }
  }
}

/* =========================================================
   POLLING
========================================================= */

function startPolling() {
  if (
    pollTimer
  ) {
    clearInterval(
      pollTimer
    );
  }

  pollTimer =
    setInterval(
      async () => {
        /*
        Keep selected market alive.
        Backend V8.6.2 decides whether
        it is fresh or fallback.
        */

        await loadBest(
          false
        );

        /*
        Update automatic WIN/LOSS/DRAW.
        */

        await loadPerformance();
      },
      POLL_MS
    );

  if (
    countdownTimer
  ) {
    clearInterval(
      countdownTimer
    );
  }

  countdownTimer =
    setInterval(
      updateCountdown,
      COUNTDOWN_MS
    );
}

/* =========================================================
   BUTTON WIRING
========================================================= */

function wireUI() {
  const button =
    analyzeButton();

  if (!button) {
    return;
  }

  /*
  Prevent duplicate listeners.
  */

  if (
    button.dataset.po862Wired ===
    'true'
  ) {
    return;
  }

  button.dataset.po862Wired =
    'true';

  button.addEventListener(
    'click',
    analyzeMarket
  );
}

/* =========================================================
   BOOT
========================================================= */

async function boot() {
  wireUI();

  setStatus(
    'CONNECTING TO LIVE MARKET…',
    'loading'
  );

  await loadBest(
    false
  );

  await loadPerformance();

  startPolling();
}

document.addEventListener(
  'DOMContentLoaded',
  boot
);
