'use strict';

/*
===========================================================
 PO AI PREDICTOR
 V8.6.1 • SMART LIVE SCANNER FRONTEND
===========================================================

BACKEND:
https://po-ai-predictor-api.onrender.com

FLOW:

ANALYZE MARKET
      ↓
GET /api/best
      ↓
SELECTED MARKET
      ↓
CALL / PUT / NO TRADE
      ↓
ENTRY COUNTDOWN
      ↓
EXPIRY
      ↓
WIN / LOSS / DRAW
      ↓
PERFORMANCE

===========================================================
*/

const API_URL =
  'https://po-ai-predictor-api.onrender.com';

const REFRESH_INTERVAL =
  10000;

const COUNTDOWN_INTERVAL =
  1000;

const HISTORY_LIMIT =
  20;

let selectedMarket =
  null;

let refreshTimer =
  null;

let countdownTimer =
  null;

let analyzing =
  false;

/* =========================================================
   HELPERS
========================================================= */

function $(selector) {
  return document.querySelector(
    selector
  );
}

function escapeHtml(value) {
  return String(
    value ?? ''
  )
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatNumber(
  value,
  decimals = 5
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return '—';
  }

  return number.toFixed(
    decimals
  );
}

function formatTime(
  iso
) {
  if (!iso) {
    return '—';
  }

  const date =
    new Date(iso);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '—';
  }

  return date.toLocaleTimeString(
    [],
    {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }
  );
}

function formatDateTime(
  iso
) {
  if (!iso) {
    return '—';
  }

  const date =
    new Date(iso);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '—';
  }

  return date.toLocaleString(
    []
  );
}

function formatCountdown(
  seconds
) {
  const value =
    Math.max(
      0,
      Math.floor(
        Number(seconds) || 0
      )
    );

  const minutes =
    Math.floor(
      value / 60
    );

  const secs =
    value % 60;

  return (
    String(minutes).padStart(
      2,
      '0'
    ) +
    ':' +
    String(secs).padStart(
      2,
      '0'
    )
  );
}

/* =========================================================
   FIND EXISTING UI ELEMENT
========================================================= */

function findElement(
  ids = [],
  selectors = []
) {
  for (const id of ids) {
    const element =
      document.getElementById(
        id
      );

    if (element) {
      return element;
    }
  }

  for (
    const selector
    of selectors
  ) {
    const element =
      $(selector);

    if (element) {
      return element;
    }
  }

  return null;
}

/* =========================================================
   CREATE/ENSURE UI
========================================================= */

function ensureV861UI() {
  let root =
    document.getElementById(
      'po-v861-status'
    );

  if (!root) {
    root =
      document.createElement(
        'div'
      );

    root.id =
      'po-v861-status';

    root.style.marginTop =
      '16px';

    root.style.padding =
      '14px';

    root.style.borderRadius =
      '12px';

    root.style.border =
      '1px solid rgba(255,255,255,.12)';

    const target =
      document.querySelector(
        'main'
      ) ||
      document.body;

    target.appendChild(
      root
    );
  }

  let performanceBox =
    document.getElementById(
      'po-v861-performance'
    );

  if (!performanceBox) {
    performanceBox =
      document.createElement(
        'div'
      );

    performanceBox.id =
      'po-v861-performance';

    performanceBox.style.marginTop =
      '12px';

    root.appendChild(
      performanceBox
    );
  }

  let historyBox =
    document.getElementById(
      'po-v861-history'
    );

  if (!historyBox) {
    historyBox =
      document.createElement(
        'div'
      );

    historyBox.id =
      'po-v861-history';

    historyBox.style.marginTop =
      '12px';

    root.appendChild(
      historyBox
    );
  }

  return {
    root,
    performanceBox,
    historyBox
  };
}

/* =========================================================
   API REQUEST
========================================================= */

async function apiGet(
  endpoint
) {
  const response =
    await fetch(
      `${API_URL}${endpoint}`,
      {
        method: 'GET',
        headers: {
          Accept:
            'application/json'
        },
        cache: 'no-store'
      }
    );

  let data;

  try {
    data =
      await response.json();
  } catch (error) {
    throw new Error(
      `Backend returned invalid JSON (${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error ||
      `Backend HTTP ${response.status}`
    );
  }

  return data;
}

/* =========================================================
   STATUS
========================================================= */

function setStatus(
  text,
  type = 'normal'
) {
  const element =
    findElement(
      [
        'status',
        'statusText',
        'connectionStatus',
        'marketStatus'
      ],
      [
        '.status',
        '.status-text',
        '.connection-status'
      ]
    );

  if (!element) {
    return;
  }

  element.textContent =
    text;

  element.dataset.status =
    type;
}

/* =========================================================
   SIGNAL
========================================================= */

function setSignal(
  signal
) {
  const element =
    findElement(
      [
        'signal',
        'signalValue',
        'tradeSignal'
      ],
      [
        '.signal',
        '.signal-value'
      ]
    );

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
   CONFIDENCE
========================================================= */

function setConfidence(
  confidence
) {
  const element =
    findElement(
      [
        'confidence',
        'confidenceValue',
        'aiConfidence'
      ],
      [
        '.confidence',
        '.confidence-value'
      ]
    );

  if (!element) {
    return;
  }

  if (
    confidence === null ||
    confidence === undefined
  ) {
    element.textContent =
      '—';
    return;
  }

  element.textContent =
    `${confidence}%`;
}

/* =========================================================
   PAIR
========================================================= */

function setPair(
  pair
) {
  const element =
    findElement(
      [
        'pair',
        'pairValue',
        'selectedPair'
      ],
      [
        '.pair',
        '.pair-value'
      ]
    );

  if (!element) {
    return;
  }

  element.textContent =
    pair || '—';
}

/* =========================================================
   TIMEFRAME
========================================================= */

function setTimeframe(
  timeframe
) {
  const element =
    findElement(
      [
        'timeframe',
        'timeframeValue',
        'selectedTimeframe'
      ],
      [
        '.timeframe',
        '.timeframe-value'
      ]
    );

  if (!element) {
    return;
  }

  element.textContent =
    timeframe
      ? `${timeframe} MIN`
      : '—';
}

/* =========================================================
   ENTRY
========================================================= */

function setEntry(
  iso
) {
  const element =
    findElement(
      [
        'entry',
        'entryTime',
        'entryValue'
      ],
      [
        '.entry',
        '.entry-time'
      ]
    );

  if (!element) {
    return;
  }

  element.textContent =
    formatTime(
      iso
    );
}

/* =========================================================
   EXPIRY
========================================================= */

function setExpiry(
  iso
) {
  const element =
    findElement(
      [
        'expiry',
        'expiryTime',
        'expiryValue'
      ],
      [
        '.expiry',
        '.expiry-time'
      ]
    );

  if (!element) {
    return;
  }

  element.textContent =
    formatTime(
      iso
    );
}

/* =========================================================
   CURRENT PRICE
========================================================= */

function setCurrentPrice(
  price
) {
  const element =
    findElement(
      [
        'currentPrice',
        'price',
        'priceValue'
      ],
      [
        '.current-price',
        '.price-value'
      ]
    );

  if (!element) {
    return;
  }

  element.textContent =
    formatNumber(
      price,
      5
    );
}

/* =========================================================
   RESULT STATUS
========================================================= */

function setResultStatus(
  result
) {
  const element =
    findElement(
      [
        'resultStatus',
        'tradeResult',
        'result'
      ],
      [
        '.result-status',
        '.trade-result'
      ]
    );

  if (!element) {
    return;
  }

  element.textContent =
    result || 'PENDING';

  element.classList.remove(
    'win',
    'loss',
    'draw',
    'pending'
  );

  const normalized =
    String(
      result ||
        'PENDING'
    ).toUpperCase();

  if (
    normalized === 'WIN'
  ) {
    element.classList.add(
      'win'
    );
  } else if (
    normalized === 'LOSS'
  ) {
    element.classList.add(
      'loss'
    );
  } else if (
    normalized === 'DRAW'
  ) {
    element.classList.add(
      'draw'
    );
  } else {
    element.classList.add(
      'pending'
    );
  }
}

/* =========================================================
   COUNTDOWN
========================================================= */

function updateCountdown() {
  const element =
    findElement(
      [
        'countdown',
        'entryCountdown',
        'timer',
        'entryTimer'
      ],
      [
        '.countdown',
        '.entry-countdown',
        '.timer'
      ]
    );

  if (!element) {
    return;
  }

  if (
    !selectedMarket ||
    !selectedMarket.entryTime
  ) {
    element.textContent =
      '—';

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

  const now =
    Date.now();

  if (
    now <
    entry
  ) {
    const seconds =
      Math.ceil(
        (
          entry -
          now
        ) / 1000
      );

    element.textContent =
      `ENTRY IN ${formatCountdown(seconds)}`;

    return;
  }

  if (
    now <
    expiry
  ) {
    const seconds =
      Math.ceil(
        (
          expiry -
          now
        ) / 1000
      );

    element.textContent =
      `EXPIRY IN ${formatCountdown(seconds)}`;

    return;
  }

  element.textContent =
    'EXPIRED — SETTLING';
}

/* =========================================================
   MARKET CONDITION
========================================================= */

function setMarketCondition(
  condition
) {
  const element =
    findElement(
      [
        'marketCondition',
        'condition',
        'marketConditionValue'
      ],
      [
        '.market-condition',
        '.condition'
      ]
    );

  if (!element) {
    return;
  }

  element.textContent =
    condition || '—';
}

/* =========================================================
   RENDER SELECTED MARKET
========================================================= */

function renderSelectedMarket(
  market
) {
  selectedMarket =
    market || null;

  if (!market) {
    setPair('—');
    setTimeframe(null);
    setSignal('NO TRADE');
    setConfidence(null);
    setCurrentPrice(null);
    setEntry(null);
    setExpiry(null);
    setResultStatus(
      'PENDING'
    );
    setMarketCondition(
      '—'
    );

    return;
  }

  setPair(
    market.pair
  );

  setTimeframe(
    market.timeframe
  );

  setSignal(
    market.signal
  );

  setConfidence(
    market.confidence
  );

  setCurrentPrice(
    market.currentPrice
  );

  setEntry(
    market.entryTime
  );

  setExpiry(
    market.expiryTime
  );

  setResultStatus(
    market.resultStatus ||
    'PENDING'
  );

  setMarketCondition(
    market.marketCondition
  );

  updateCountdown();

  renderDetailedStatus(
    market
  );
}

/* =========================================================
   DETAILED STATUS
========================================================= */

function renderDetailedStatus(
  market
) {
  const ui =
    ensureV861UI();

  const signal =
    market.signal ||
    'NO TRADE';

  const result =
    market.resultStatus ||
    'PENDING';

  const signalClass =
    signal === 'CALL'
      ? 'call'
      : signal === 'PUT'
        ? 'put'
        : 'no-trade';

  const resultClass =
    result === 'WIN'
      ? 'win'
      : result === 'LOSS'
        ? 'loss'
        : result === 'DRAW'
          ? 'draw'
          : 'pending';

  ui.root.innerHTML = `
    <div style="font-weight:700;font-size:16px;margin-bottom:10px;">
      V8.6.1 LIVE SIGNAL
    </div>

    <div style="
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:8px;
    ">
      <div>
        <small>PAIR</small><br>
        <strong>${escapeHtml(
          market.pair
        )}</strong>
      </div>

      <div>
        <small>TIMEFRAME</small><br>
        <strong>${escapeHtml(
          market.timeframe
        )} MIN</strong>
      </div>

      <div>
        <small>SIGNAL</small><br>
        <strong class="${signalClass}">
          ${escapeHtml(signal)}
        </strong>
      </div>

      <div>
        <small>CONFIDENCE</small><br>
        <strong>${escapeHtml(
          market.confidence
        )}%</strong>
      </div>

      <div>
        <small>ENTRY</small><br>
        <strong>${escapeHtml(
          formatTime(
            market.entryTime
          )
        )}</strong>
      </div>

      <div>
        <small>EXPIRY</small><br>
        <strong>${escapeHtml(
          formatTime(
            market.expiryTime
          )
        )}</strong>
      </div>

      <div>
        <small>CURRENT PRICE</small><br>
        <strong>${escapeHtml(
          formatNumber(
            market.currentPrice
          )
        )}</strong>
      </div>

      <div>
        <small>RESULT</small><br>
        <strong class="${resultClass}">
          ${escapeHtml(result)}
        </strong>
      </div>
    </div>

    <div style="margin-top:12px;">
      <small>MARKET CONDITION</small><br>
      <strong>${escapeHtml(
        market.marketCondition ||
        '—'
      )}</strong>
    </div>

    <div id="v861-countdown"
         style="
           margin-top:12px;
           font-weight:700;
           font-size:18px;
         ">
      —
    </div>

    ${
      market.entryPrice !== null &&
      market.entryPrice !== undefined
        ? `
          <div style="margin-top:8px;">
            <small>ENTRY PRICE</small><br>
            <strong>${escapeHtml(
              formatNumber(
                market.entryPrice
              )
            )}</strong>
          </div>
        `
        : ''
    }

    ${
      market.exitPrice !== null &&
      market.exitPrice !== undefined
        ? `
          <div style="margin-top:8px;">
            <small>EXIT PRICE</small><br>
            <strong>${escapeHtml(
              formatNumber(
                market.exitPrice
              )
            )}</strong>
          </div>
        `
        : ''
    }

    <div style="
      margin-top:10px;
      opacity:.7;
      font-size:12px;
    ">
      Signal ID:
      ${escapeHtml(
        market.signalId ||
        '—'
      )}
    </div>
  `;

  /*
  Restore the performance/history containers
  after replacing root contents.
  */
  renderPerformance(
    window.__v861Performance ||
      null
  );

  renderHistory(
    window.__v861History ||
      []
  );

  updateDynamicCountdown();
}

/* =========================================================
   DYNAMIC COUNTDOWN
========================================================= */

function updateDynamicCountdown() {
  const element =
    document.getElementById(
      'v861-countdown'
    );

  if (!element) {
    return;
  }

  if (
    !selectedMarket
  ) {
    element.textContent =
      '—';

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

  const now =
    Date.now();

  if (
    now <
    entry
  ) {
    const seconds =
      Math.ceil(
        (
          entry -
          now
        ) / 1000
      );

    element.textContent =
      `ENTRY IN ${formatCountdown(seconds)}`;

    return;
  }

  if (
    now <
    expiry
  ) {
    const seconds =
      Math.ceil(
        (
          expiry -
          now
        ) / 1000
      );

    element.textContent =
      `EXPIRY IN ${formatCountdown(seconds)}`;

    return;
  }

  element.textContent =
    'EXPIRED — WAITING FOR RESULT';
}

/* =========================================================
   PERFORMANCE
========================================================= */

function renderPerformance(
  performance
) {
  const box =
    document.getElementById(
      'po-v861-performance'
    );

  if (!box) {
    return;
  }

  if (!performance) {
    box.innerHTML = `
      <div style="font-weight:700;">
        PERFORMANCE
      </div>
      <div style="opacity:.7;">
        Waiting for settled signals...
      </div>
    `;

    return;
  }

  const {
    total = 0,
    pending = 0,
    wins = 0,
    losses = 0,
    draws = 0,
    settled = 0,
    decisive = 0,
    winRate = null
  } = performance;

  box.innerHTML = `
    <div style="
      font-weight:700;
      margin-bottom:8px;
    ">
      PERFORMANCE
    </div>

    <div style="
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:6px;
      font-size:13px;
    ">
      <div>
        <small>TOTAL</small><br>
        <strong>${total}</strong>
      </div>

      <div>
        <small>PENDING</small><br>
        <strong>${pending}</strong>
      </div>

      <div>
        <small>WIN</small><br>
        <strong>${wins}</strong>
      </div>

      <div>
        <small>LOSS</small><br>
        <strong>${losses}</strong>
      </div>

      <div>
        <small>DRAW</small><br>
        <strong>${draws}</strong>
      </div>

      <div>
        <small>SETTLED</small><br>
        <strong>${settled}</strong>
      </div>

      <div>
        <small>DECISIVE</small><br>
        <strong>${decisive}</strong>
      </div>

      <div>
        <small>WIN RATE</small><br>
        <strong>${
          winRate === null
            ? '—'
            : `${winRate}%`
        }</strong>
      </div>
    </div>
  `;
}

/* =========================================================
   HISTORY
========================================================= */

function renderHistory(
  signals
) {
  const box =
    document.getElementById(
      'po-v861-history'
    );

  if (!box) {
    return;
  }

  if (
    !signals ||
    !signals.length
  ) {
    box.innerHTML = `
      <div style="font-weight:700;">
        SIGNAL HISTORY
      </div>
      <div style="opacity:.7;">
        No signals yet.
      </div>
    `;

    return;
  }

  const rows =
    signals
      .slice(
        0,
        HISTORY_LIMIT
      )
      .map(
        signal => {
          const result =
            signal.result ||
            'PENDING';

          return `
            <div style="
              padding:8px 0;
              border-bottom:1px solid rgba(255,255,255,.08);
              font-size:12px;
            ">
              <div style="
                display:flex;
                justify-content:space-between;
                gap:8px;
              ">
                <strong>
                  ${escapeHtml(
                    signal.pair
                  )}
                  ·
                  ${escapeHtml(
                    signal.timeframe
                  )}m
                </strong>

                <strong>
                  ${escapeHtml(
                    signal.signal
                  )}
                </strong>
              </div>

              <div style="opacity:.75;">
                Entry:
                ${escapeHtml(
                  formatTime(
                    signal.entryTime
                  )
                )}
                ·
                Expiry:
                ${escapeHtml(
                  formatTime(
                    signal.expiryTime
                  )
                )}
              </div>

              <div style="margin-top:3px;">
                Result:
                <strong>
                  ${escapeHtml(
                    result
                  )}
                </strong>

                ${
                  signal.entryPrice !== null
                    ? `
                      · Entry:
                      ${escapeHtml(
                        formatNumber(
                          signal.entryPrice
                        )
                      )}
                    `
                    : ''
                }

                ${
                  signal.exitPrice !== null
                    ? `
                      · Exit:
                      ${escapeHtml(
                        formatNumber(
                          signal.exitPrice
                        )
                      )}
                    `
                    : ''
                }
              </div>
            </div>
          `;
        }
      )
      .join('');

  box.innerHTML = `
    <div style="
      font-weight:700;
      margin-bottom:8px;
    ">
      SIGNAL HISTORY
    </div>

    ${rows}
  `;
}

/* =========================================================
   ANALYZE MARKET
========================================================= */

async function analyzeMarket() {
  if (analyzing) {
    return;
  }

  analyzing = true;

  setStatus(
    'Scanning live market...',
    'loading'
  );

  try {
    const data =
      await apiGet(
        '/api/best'
      );

    if (
      !data.ok ||
      !data.selectedMarket
    ) {
      throw new Error(
        data.error ||
        'Backend returned no selected market.'
      );
    }

    renderSelectedMarket(
      data.selectedMarket
    );

    window.__v861Performance =
      data.performance ||
      null;

    /*
    Since renderSelectedMarket may have
    rebuilt the status container,
    explicitly render performance/history
    again after storing the data.
    */
    renderPerformance(
      data.performance ||
        null
    );

    setStatus(
      'LIVE DATA CONNECTED',
      'success'
    );

    await refreshPerformanceAndHistory(
      false
    );
  } catch (error) {
    console.error(
      '[PO AI V8.6.1]',
      error
    );

    setStatus(
      `Unable to load live market data: ${error.message}`,
      'error'
    );

    if (!selectedMarket) {
      setSignal(
        'NO TRADE'
      );

      setConfidence(
        null
      );
    }
  } finally {
    analyzing = false;
  }
}

/* =========================================================
   PERFORMANCE + HISTORY REFRESH
========================================================= */

async function refreshPerformanceAndHistory(
  updateMain = false
) {
  try {
    const [
      performanceData,
      historyData
    ] = await Promise.all([
      apiGet(
        '/api/performance'
      ),
      apiGet(
        `/api/history?limit=${HISTORY_LIMIT}`
      )
    ]);

    const performance =
      performanceData.performance ||
      null;

    const signals =
      historyData.signals ||
      [];

    window.__v861Performance =
      performance;

    window.__v861History =
      signals;

    renderPerformance(
      performance
    );

    renderHistory(
      signals
    );

    /*
    If the currently displayed signal
    has just been settled, update its
    result fields without choosing a
    completely different market.
    */
    if (
      selectedMarket &&
      selectedMarket.signalId
    ) {
      const matching =
        signals.find(
          item =>
            item.signalId ===
            selectedMarket.signalId
        );

      if (matching) {
        selectedMarket.resultStatus =
          matching.result;

        selectedMarket.entryPrice =
          matching.entryPrice;

        selectedMarket.exitPrice =
          matching.exitPrice;

        selectedMarket.settledAt =
          matching.settledAt;

        if (
          matching.result !==
          'PENDING'
        ) {
          setResultStatus(
            matching.result
          );
        }
      }
    }

    if (
      updateMain
    ) {
      renderSelectedMarket(
        selectedMarket
      );
    }
  } catch (error) {
    console.warn(
      '[PERFORMANCE]',
      error.message
    );
  }
}

/* =========================================================
   AUTO REFRESH
========================================================= */

async function refreshCycle() {
  /*
  Don't continuously replace the
  selected market every second.

  The selected market is refreshed
  every 10 seconds.
  */
  if (!analyzing) {
    await analyzeMarket();
  }
}

function startAutoRefresh() {
  if (refreshTimer) {
    clearInterval(
      refreshTimer
    );
  }

  refreshTimer =
    setInterval(
      () => {
        refreshCycle();
      },
      REFRESH_INTERVAL
    );
}

function startCountdown() {
  if (countdownTimer) {
    clearInterval(
      countdownTimer
    );
  }

  countdownTimer =
    setInterval(
      () => {
        updateCountdown();
        updateDynamicCountdown();
      },
      COUNTDOWN_INTERVAL
    );
}

/* =========================================================
   BUTTON BINDING
========================================================= */

function bindAnalyzeButton() {
  const button =
    findElement(
      [
        'analyzeButton',
        'analyzeBtn',
        'analyzeMarket',
        'analyze'
      ],
      [
        '#analyze-market',
        '.analyze-button',
        '.analyze-btn',
        'button[data-action="analyze"]'
      ]
    );

  if (!button) {
    console.warn(
      '[PO AI] Analyze button not found.'
    );

    return;
  }

  if (
    button.dataset.v861Bound ===
    'true'
  ) {
    return;
  }

  button.dataset.v861Bound =
    'true';

  button.addEventListener(
    'click',
    () => {
      analyzeMarket();
    }
  );
}

/* =========================================================
   GLOBAL CSS FOR SIGNAL COLORS
========================================================= */

function injectV861Styles() {
  if (
    document.getElementById(
      'po-v861-styles'
    )
  ) {
    return;
  }

  const style =
    document.createElement(
      'style'
    );

  style.id =
    'po-v861-styles';

  style.textContent = `
    .call {
      color: #19d66b !important;
      font-weight: 800;
    }

    .put {
      color: #ff4d5d !important;
      font-weight: 800;
    }

    .no-trade {
      color: #f0b84b !important;
      font-weight: 800;
    }

    .win {
      color: #19d66b !important;
      font-weight: 800;
    }

    .loss {
      color: #ff4d5d !important;
      font-weight: 800;
    }

    .draw {
      color: #f0b84b !important;
      font-weight: 800;
    }

    .pending {
      opacity: .8;
      font-weight: 700;
    }

    #po-v861-status small {
      opacity: .65;
      font-size: 10px;
    }

    #po-v861-status strong {
      font-size: 13px;
    }

    @media (max-width: 520px) {
      #po-v861-performance
        > div:nth-child(2) {
        grid-template-columns:
          repeat(2,minmax(0,1fr)) !important;
      }
    }
  `;

  document.head.appendChild(
    style
  );
}

/* =========================================================
   INITIALIZATION
========================================================= */

async function initPOAI() {
  console.log(
    `PO AI Predictor ${API_URL} V8.6.1 frontend starting...`
  );

  injectV861Styles();

  ensureV861UI();

  bindAnalyzeButton();

  startCountdown();

  setStatus(
    'Connecting to LIVE DATA...',
    'loading'
  );

  /*
  First analysis immediately.
  */
  await analyzeMarket();

  /*
  Automatic market refresh.
  */
  startAutoRefresh();

  /*
  Performance/history refresh
  independent of market selection.
  */
  setInterval(
    () => {
      refreshPerformanceAndHistory(
        false
      );
    },
    10000
  );
}

/* =========================================================
   DOM READY
========================================================= */

if (
  document.readyState ===
  'loading'
) {
  document.addEventListener(
    'DOMContentLoaded',
    initPOAI
  );
} else {
  initPOAI();
}
