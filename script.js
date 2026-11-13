
'use strict';

/*
 * PO AI PREDICTOR — V10.7.0
 * LIVE FOREX ONLY — OTC NOT SUPPORTED.
 *
 * Frontend:
 * - 24 pairs: 8 priority + 16 background.
 * - AUTO SELECT ranks eligible results across all 24 pairs.
 * - BUY/SELL CANDIDATE is separate from confirmed BUY/SELL.
 * - No RSI or 5-minute confirmation.
 * - Evidence score is NOT win probability.
 * - Pocket Option quote timestamp captured on every input edit.
 * - Broker price must be fresh and backend-validated.
 * - Live expiry fixed at 1 minute.
 * - Backtest expiry: 1, 2 and 3 minutes.
 */

(() => {
  const API_BASE = String(
    window.PO_API_BASE ||
    'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const VERSION = 'V10.7.0';
  const AUTO_PAIR = 'AI AUTO SELECT';

  const CONFIG = Object.freeze({
    HEALTH_INTERVAL_MS: 60000,
    SCAN_POLL_INTERVAL_MS: 5000,
    REQUEST_TIMEOUT_MS: 45000,
    HEALTH_TIMEOUT_MS: 12000,

    MAX_DATA_AGE_SECONDS: 150,
    MAX_BROKER_PRICE_AGE_SECONDS: 30,

    MAX_REASONS: 10,
    LIVE_EXPIRY_MINUTES: 1,
    MAX_HISTORY: 100,

    TOTAL_PAIRS: 24,
    PRIORITY_COUNT: 8,
    BACKGROUND_COUNT: 16,

    MIN_EVIDENCE_SCORE: 55
  });

  const PRIORITY_PAIRS = Object.freeze([
    'EUR/USD',
    'GBP/USD',
    'USD/JPY',
    'USD/CHF',
    'AUD/USD',
    'USD/CAD',
    'EUR/JPY',
    'GBP/JPY'
  ]);

  const BACKGROUND_PAIRS = Object.freeze([
    'NZD/USD',
    'EUR/GBP',
    'EUR/CHF',
    'EUR/AUD',
    'EUR/CAD',
    'GBP/CHF',
    'GBP/AUD',
    'GBP/CAD',
    'AUD/JPY',
    'AUD/CAD',
    'AUD/NZD',
    'CAD/JPY',
    'CHF/JPY',
    'NZD/JPY',
    'NZD/CAD',
    'EUR/NZD'
  ]);

  const PAIRS = Object.freeze([
    ...PRIORITY_PAIRS,
    ...BACKGROUND_PAIRS
  ]);

  const $ = id => document.getElementById(id);

  const dom = {
    analyzeButton: $('analyzeButton'),
    refreshScannerButton: $('refreshScannerButton'),
    runBacktestButton: $('runBacktestButton'),
    refreshHistoryButton: $('refreshHistoryButton'),

    pairSelect: $('pairSelect'),
    expirySelect: $('expirySelect'),

    backtestPairSelect: $('backtestPairSelect'),
    backtestDuration: $('backtestDuration'),

    brokerPriceInput: $('brokerPriceInput'),
    confirmSignalButton: $('confirmSignalButton')
  };

  const state = {
    analysisBusy: false,
    confirmationBusy: false,
    scanBusy: false,
    healthBusy: false,
    historyBusy: false,
    backtestBusy: false,

    healthTimer: null,
    scanTimer: null,

    lastMarket: null,
    lastHealth: null,
    lastScanner: null,
    lastConfirmedSignal: null,

    selectedPair: null,
    selectedMode: 'AUTO',

    brokerPrice: null,
    brokerPriceCapturedAt: null,

    awaitingBrokerPrice: false,
    destroyed: false
  };

  /* =======================================================
     GENERAL HELPERS
  ======================================================= */

  function obj(value) {
    return value &&
      typeof value === 'object' &&
      !Array.isArray(value)
      ? value
      : {};
  }

  function first(...values) {
    return values.find(value =>
      value !== undefined &&
      value !== null &&
      value !== ''
    );
  }

  function number(value) {
    if (
      value === null ||
      value === undefined ||
      value === ''
    ) {
      return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed)
      ? parsed
      : null;
  }

  function formatNumber(value, digits = 5) {
    const parsed = number(value);

    if (parsed === null) return '—';

    return parsed.toLocaleString(undefined, {
      maximumFractionDigits: digits
    });
  }

  function formatDate(value) {
    if (!value) return '—';

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return date.toLocaleString();
  }

  function formatDuration(start, end) {
    const a = new Date(start).getTime();
    const b = new Date(end).getTime();

    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      b <= a
    ) {
      return '—';
    }

    return `${Math.round((b - a) / 60000)} minute(s)`;
  }

  function setText(id, value, fallback = '—') {
    const node = $(id);

    if (!node) return;

    node.textContent =
      value === null ||
      value === undefined ||
      value === ''
        ? fallback
        : String(value);
  }

  function setVisible(id, visible) {
    const node = $(id);

    if (!node) return;

    node.hidden = !visible;
  }

  function setInputEnabled(input, enabled) {
    if (input) {
      input.disabled = !enabled;
    }
  }

  function setButtonBusy(
    button,
    busy,
    busyText,
    normalText
  ) {
    if (!button) return;

    button.disabled = busy;
    button.textContent = busy
      ? busyText
      : normalText;
  }

  function showMessage(message, type = 'info') {
    const node = $('analysisMessage');

    if (!node) return;

    node.textContent = String(message || '');
    node.dataset.type = type;
  }

  function setStatusDot(online) {
    const node = $('apiStatusDot');

    if (!node) return;

    node.className = online
      ? 'status-indicator online'
      : 'status-indicator offline';
  }

  function renderApiStatus(online, message) {
    setStatusDot(online);

    setText(
      'apiStatusText',
      message || (
        online
          ? 'API ONLINE'
          : 'API UNAVAILABLE'
      )
    );

    setText(
      'apiStatusCard',
      online ? 'ONLINE' : 'OFFLINE'
    );
  }

  function normalizePair(pair) {
    return String(pair || '')
      .trim()
      .toUpperCase();
  }

  function validPair(pair) {
    return PAIRS.includes(normalizePair(pair));
  }

  function isAutoSelection(pair) {
    const value = normalizePair(pair);

    return (
      value === normalizePair(AUTO_PAIR) ||
      value === 'AUTO'
    );
  }

  function getMarketFromPayload(payload) {
    const root = obj(payload);

    return obj(first(
      root.selectedMarket,
      root.market,
      root.result,
      root.data
    ));
  }

  /* =======================================================
     MARKET DATA FRESHNESS
  ======================================================= */

  function isFresh(market) {
    const data = obj(market);

    const age = number(data.dataAgeSeconds);
    const price = number(data.currentPrice);

    return (
      String(data.freshness || '')
        .toUpperCase() === 'FRESH' &&

      age !== null &&
      age >= 0 &&
      age <= CONFIG.MAX_DATA_AGE_SECONDS &&

      price !== null &&
      price > 0 &&

      data.insufficientData !== true
    );
  }

  /*
   * Freshness and trade qualification are separate checks.
   * Fresh data does not automatically mean a valid trade.
   */

  function isQualified(market) {
    const data = obj(market);

    const score = number(first(
      data.evidenceScore,
      data.confidence,
      data.score
    ));

    return (
      isFresh(data) &&
      data.qualified === true &&
      data.tradeAllowed === true &&
      data.noTrade !== true &&
      data.insufficientData !== true &&
      score !== null &&
      score >= CONFIG.MIN_EVIDENCE_SCORE
    );
  }

  /* =======================================================
     CANDIDATE SIGNAL — NOT A CONFIRMED SIGNAL
  ======================================================= */

  function getCandidateSignal(market) {
    const data = obj(market);

    const signalObject = obj(data.signal);

    const raw = String(first(
      data.candidateSignal,
      signalObject.candidateSignal,
      signalObject.action,
      signalObject.direction,
      data.action,
      data.direction,
      'NO TRADE'
    )).toUpperCase().trim();

    if (
      data.noTrade === true ||
      data.insufficientData === true ||
      data.candidateAllowed === false
    ) {
      return 'NO TRADE';
    }

    if (
      ['BUY', 'CALL', 'UP', 'BULLISH'].includes(raw)
    ) {
      return 'BUY';
    }

    if (
      ['SELL', 'PUT', 'DOWN', 'BEARISH'].includes(raw)
    ) {
      return 'SELL';
    }

    return 'NO TRADE';
  }

  /*
   * This function is intentionally separate.
   * It must only be used for a backend-confirmed result.
   */

  function getConfirmedSignal(market) {
    const data = obj(market);
    const signalObject = obj(data.signal);

    const raw = String(first(
      signalObject.action,
      signalObject.direction,
      data.signal,
      data.action,
      data.direction,
      'NO TRADE'
    )).toUpperCase().trim();

    if (
      data.noTrade === true ||
      data.tradeAllowed !== true ||
      data.insufficientData === true
    ) {
      return 'NO TRADE';
    }

    if (
      ['BUY', 'CALL', 'UP', 'BULLISH'].includes(raw)
    ) {
      return 'BUY';
    }

    if (
      ['SELL', 'PUT', 'DOWN', 'BEARISH'].includes(raw)
    ) {
      return 'SELL';
    }

    return 'NO TRADE';
  }

  function getEvidenceScore(market) {
    const data = obj(market);

    return number(first(
      data.evidenceScore,
      data.confidence,
      data.score
    ));
  }

  function getEvidenceLabel(market) {
    const data = obj(market);
    const score = getEvidenceScore(data);

    return first(
      data.evidenceLabel,
      score === null
        ? 'INSUFFICIENT EVIDENCE'
        : score >= 75
          ? 'STRONG EVIDENCE'
          : score >= CONFIG.MIN_EVIDENCE_SCORE
            ? 'MODERATE EVIDENCE'
            : 'INSUFFICIENT EVIDENCE'
    );
  }

  /* =======================================================
     SCANNER PROGRESS
  ======================================================= */

  function getAllProgress(progress) {
    const data = obj(progress);

    const explicitCompleted = number(data.completed);

    const priorityCompleted =
      number(data.priorityCompleted) || 0;

    const backgroundCompleted =
      number(data.backgroundCompleted) || 0;

    const completed = explicitCompleted !== null
      ? explicitCompleted
      : priorityCompleted + backgroundCompleted;

    return {
      completed: Math.max(
        0,
        Math.min(CONFIG.TOTAL_PAIRS, completed)
      ),

      total: CONFIG.TOTAL_PAIRS,

      priorityCompleted: Math.max(
        0,
        Math.min(
          CONFIG.PRIORITY_COUNT,
          priorityCompleted
        )
      ),

      backgroundCompleted: Math.max(
        0,
        Math.min(
          CONFIG.BACKGROUND_COUNT,
          backgroundCompleted
        )
      ),

      pair: data.pair || null,
      phase: data.phase || null
    };
  }

  /* =======================================================
     END OF PART 1
     NEXT PART CONTINUES WITH OBSOLETE UI CLEANUP,
     API REQUESTS, HEALTH AND SIGNAL DISPLAY.
  ======================================================= */

  /* =======================================================
     UI CLEANUP AND DISPLAY HELPERS
  ======================================================= */

  function clearConfirmedSignal() {
    state.lastConfirmedSignal = null;

    setText('signalDirection', 'NO CONFIRMED SIGNAL');
    setText('signalPair', '—');
    setText('signalEntryPrice', '—');
    setText('signalExpiry', '—');
    setText('signalEvidenceScore', '—');
    setText('signalEvidenceLabel', '—');
    setText('signalStatus', 'WAITING FOR VALIDATION');

    const direction = $('signalDirection');

    if (direction) {
      direction.classList.remove(
        'buy',
        'sell',
        'candidate',
        'no-trade'
      );

      direction.classList.add('no-trade');
    }
  }

  function clearCandidateDisplay() {
    setText('candidateDirection', 'NO CANDIDATE');
    setText('candidatePair', '—');
    setText('candidatePrice', '—');
    setText('candidateEvidenceScore', '—');
    setText('candidateEvidenceLabel', '—');
    setText('candidateFreshness', '—');
    setText('candidateReasons', '—');
  }

  function renderCandidate(market) {
    const data = obj(market);

    const pair = normalizePair(data.pair);
    const candidate = getCandidateSignal(data);
    const score = getEvidenceScore(data);

    if (
      !pair ||
      candidate === 'NO TRADE' ||
      !isQualified(data)
    ) {
      clearCandidateDisplay();
      return;
    }

    setText(
      'candidateDirection',
      `${candidate} CANDIDATE`
    );

    setText('candidatePair', pair);

    setText(
      'candidatePrice',
      formatNumber(data.currentPrice)
    );

    setText(
      'candidateEvidenceScore',
      score === null ? '—' : `${score}/100`
    );

    setText(
      'candidateEvidenceLabel',
      getEvidenceLabel(data)
    );

    setText(
      'candidateFreshness',
      data.freshness || 'UNKNOWN'
    );

    const reasons = Array.isArray(data.rejectedReasons)
      ? data.rejectedReasons
      : [];

    setText(
      'candidateReasons',
      reasons.length
        ? reasons.slice(0, CONFIG.MAX_REASONS).join(' • ')
        : 'No rejection reasons reported'
    );

    const direction = $('candidateDirection');

    if (direction) {
      direction.classList.remove(
        'buy',
        'sell',
        'no-trade'
      );

      direction.classList.add(
        candidate === 'BUY' ? 'buy' : 'sell'
      );

      direction.classList.add('candidate');
    }

    showMessage(
      'Candidate found. It is not a confirmed trade until Pocket Option price validation succeeds.',
      'warning'
    );
  }

  function renderConfirmedSignal(payload) {
    const root = obj(payload);
    const market = obj(first(
      root.selectedMarket,
      root.market,
      root
    ));

    const broker = obj(root.brokerPrice);

    const direction = getConfirmedSignal(market);

    const brokerValidated =
      broker.validated === true ||
      broker.status === 'VALIDATED';

    if (
      root.confirmed !== true ||
      root.tradeAllowed !== true ||
      market.tradeAllowed !== true ||
      !brokerValidated ||
      !['BUY', 'SELL'].includes(direction)
    ) {
      clearConfirmedSignal();

      showMessage(
        first(
          root.message,
          root.reason,
          'Signal was not confirmed by backend validation.'
        ),
        'warning'
      );

      return false;
    }

    const pair = normalizePair(first(
      root.pair,
      market.pair,
      state.selectedPair
    ));

    if (!validPair(pair)) {
      clearConfirmedSignal();

      showMessage(
        'Backend returned an invalid currency pair.',
        'error'
      );

      return false;
    }

    const confirmed = {
      pair,
      direction,
      entryPrice: number(first(
        broker.price,
        broker.brokerPrice,
        root.entryPrice
      )),
      expiryMinutes: CONFIG.LIVE_EXPIRY_MINUTES,
      confirmedAt: new Date().toISOString(),
      evidenceScore: getEvidenceScore(market),
      brokerValidated: true,
      payload: root
    };

    if (
      confirmed.entryPrice === null ||
      confirmed.entryPrice <= 0
    ) {
      clearConfirmedSignal();

      showMessage(
        'Confirmed response did not contain a valid broker entry price.',
        'error'
      );

      return false;
    }

    state.lastConfirmedSignal = confirmed;

    setText('signalDirection', direction);
    setText('signalPair', pair);

    setText(
      'signalEntryPrice',
      formatNumber(confirmed.entryPrice)
    );

    setText('signalExpiry', '1 MINUTE');

    setText(
      'signalEvidenceScore',
      confirmed.evidenceScore === null
        ? '—'
        : `${confirmed.evidenceScore}/100`
    );

    setText(
      'signalEvidenceLabel',
      getEvidenceLabel(market)
    );

    setText('signalStatus', 'CONFIRMED');

    const directionNode = $('signalDirection');

    if (directionNode) {
      directionNode.classList.remove(
        'buy',
        'sell',
        'candidate',
        'no-trade'
      );

      directionNode.classList.add(
        direction === 'BUY' ? 'buy' : 'sell'
      );
    }

    showMessage(
      'Signal confirmed. Broker price was validated by the backend.',
      'success'
    );

    return true;
  }

  /* =======================================================
     REJECTION REASONS
  ======================================================= */

  function renderRejectionReasons(market) {
    const data = obj(market);

    const reasons = Array.isArray(data.rejectedReasons)
      ? data.rejectedReasons
      : [];

    const node = $('rejectionReasons');

    if (!node) return;

    node.replaceChildren();

    if (!reasons.length) {
      node.textContent = 'No rejection reasons available.';
      return;
    }

    reasons.slice(0, CONFIG.MAX_REASONS).forEach(reason => {
      const item = document.createElement('li');

      item.textContent = String(reason);

      node.appendChild(item);
    });
  }

  /* =======================================================
     MARKET ANALYSIS DISPLAY
  ======================================================= */

  function renderMarketAnalysis(market) {
    const data = obj(market);

    state.lastMarket = data;

    const pair = normalizePair(data.pair);

    setText('analysisPair', pair || '—');

    setText(
      'analysisPrice',
      formatNumber(data.currentPrice)
    );

    setText(
      'analysisFreshness',
      data.freshness || 'UNKNOWN'
    );

    setText(
      'analysisDataAge',
      data.dataAgeSeconds === undefined
        ? '—'
        : `${data.dataAgeSeconds}s`
    );

    setText(
      'analysisEvidenceScore',
      getEvidenceScore(data) === null
        ? '—'
        : `${getEvidenceScore(data)}/100`
    );

    setText(
      'analysisEvidenceLabel',
      getEvidenceLabel(data)
    );

    setText(
      'analysisTrend',
      first(
        data.oneMinuteTrend,
        data.trend,
        'UNKNOWN'
      )
    );

    setText(
      'analysisVolatility',
      first(
        data.volatility,
        data.volatilityRegime,
        'UNKNOWN'
      )
    );

    setText(
      'analysisMarketRegime',
      first(
        data.marketRegime,
        data.regime,
        'UNKNOWN'
      )
    );

    setText(
      'analysisTradeStatus',
      data.tradeAllowed === true
        ? 'ELIGIBLE — AWAITING BROKER VALIDATION'
        : 'NOT ELIGIBLE'
    );

    renderCandidate(data);
    renderRejectionReasons(data);

    if (!isFresh(data)) {
      showMessage(
        'Market data is stale or incomplete. No trade should be confirmed.',
        'warning'
      );
    }
  }

  /* =======================================================
     API REQUEST HELPER
  ======================================================= */

  async function apiRequest(
    path,
    options = {},
    timeoutMs = CONFIG.REQUEST_TIMEOUT_MS
  ) {
    const controller = new AbortController();

    const timeout = window.setTimeout(
      () => controller.abort(),
      timeoutMs
    );

    try {
      const headers = {
        Accept: 'application/json',
        ...(options.headers || {})
      };

      const response = await fetch(
        `${API_BASE}${path}`,
        {
          ...options,
          headers,
          signal: controller.signal,
          cache: 'no-store'
        }
      );

      const raw = await response.text();

      let payload = {};

      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new Error(
            `Invalid JSON response from ${path}`
          );
        }
      }

      if (!response.ok) {
        throw new Error(
          first(
            payload.message,
            payload.error,
            `API request failed: HTTP ${response.status}`
          )
        );
      }

      return payload;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(
          `Request timeout: ${path}`
        );
      }

      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function apiGet(path) {
    return apiRequest(path, {
      method: 'GET'
    });
  }

  async function apiPost(path, body) {
    return apiRequest(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  }

  /* =======================================================
     HEALTH CHECK
  ======================================================= */

  async function checkHealth() {
    if (state.healthBusy || state.destroyed) {
      return;
    }

    state.healthBusy = true;

    try {
      const response = await apiGet('/api/health');

      state.lastHealth = response;

      const online =
        response.ok !== false &&
        response.status !== 'error';

      renderApiStatus(
        online,
        online
          ? `API ONLINE — ${VERSION}`
          : 'API UNAVAILABLE'
      );

      setText(
        'backendVersion',
        first(
          response.version,
          response.apiVersion,
          'UNKNOWN'
        )
      );

      setText(
        'databaseStatus',
        first(
          response.storage,
          response.database,
          'UNKNOWN'
        )
      );

    } catch (error) {
      renderApiStatus(false, 'API CONNECTION FAILED');

      setText(
        'backendVersion',
        'UNAVAILABLE'
      );

      showMessage(error.message, 'error');

    } finally {
      state.healthBusy = false;
    }
  }

  /* =======================================================
     END OF PART 2
     PART 3 CONTINUES WITH AUTO SELECT AND SCANNER.
  ======================================================= */

  /* =======================================================
     AUTO SELECT
  ======================================================= */

  function getSelectedPair() {
    if (dom.pairSelect) {
      return normalizePair(dom.pairSelect.value);
    }

    return state.selectedPair || AUTO_PAIR;
  }

  function setSelectedPair(pair) {
    const normalized = normalizePair(pair);

    state.selectedPair = normalized;

    if (dom.pairSelect) {
      dom.pairSelect.value = normalized;
    }
  }

  function getBestMarketFromResponse(payload) {
    const root = obj(payload);

    const selected = obj(first(
      root.selectedMarket,
      root.market
    ));

    if (
      selected.qualified === true &&
      selected.tradeAllowed === true &&
      isQualified(selected)
    ) {
      return selected;
    }

    /*
     * Do not promote rankedCandidates into a confirmed
     * or qualified market. Backend must explicitly mark
     * a selected market as qualified.
     */

    return null;
  }

  async function analyzeSelectedPair() {
    if (state.analysisBusy || state.destroyed) {
      return;
    }

    const requestedPair = getSelectedPair();
    const autoMode = isAutoSelection(requestedPair);

    if (!autoMode && !validPair(requestedPair)) {
      showMessage('Please select a valid currency pair.', 'error');
      return;
    }

    state.analysisBusy = true;
    state.awaitingBrokerPrice = false;

    clearConfirmedSignal();
    clearCandidateDisplay();

    setButtonBusy(
      dom.analyzeButton,
      true,
      'ANALYZING...',
      'ANALYZE'
    );

    showMessage(
      autoMode
        ? 'AUTO SELECT is checking eligible market data...'
        : `Analyzing ${requestedPair}...`,
      'info'
    );

    try {
      const path = autoMode
        ? '/api/analyze'
        : `/api/scan/pair?pair=${encodeURIComponent(requestedPair)}`;

      const response = await apiGet(path);

      const market = autoMode
        ? getBestMarketFromResponse(response)
        : getMarketFromPayload(response);

      if (!market || !isQualified(market)) {
        const root = obj(response);

        renderScanner(root.scanner || root);

        clearCandidateDisplay();

        const message = first(
          root.message,
          root.reason,
          market && market.rejectedReasons
            ? market.rejectedReasons.join(' • ')
            : null,
          'No sufficiently qualified fresh candidate is available.'
        );

        showMessage(message, 'warning');

        return;
      }

      renderMarketAnalysis(market);

      state.selectedPair = normalizePair(market.pair);

      state.awaitingBrokerPrice = true;

      clearConfirmedSignal();

      showMessage(
        `${market.pair}: ${getCandidateSignal(market)} candidate found. Enter the current Pocket Option price and confirm for validation.`,
        'success'
      );

    } catch (error) {
      clearCandidateDisplay();
      clearConfirmedSignal();

      showMessage(
        `Analysis failed: ${error.message}`,
        'error'
      );

    } finally {
      state.analysisBusy = false;

      setButtonBusy(
        dom.analyzeButton,
        false,
        'ANALYZING...',
        'ANALYZE'
      );
    }
  }

  /* =======================================================
     AUTO SCANNER — BACKGROUND + PRIORITY PAIRS
  ======================================================= */

  function renderScannerProgress(progress) {
    const data = getAllProgress(progress);

    setText(
      'scannerProgress',
      `${data.completed}/${data.total}`
    );

    setText(
      'priorityProgress',
      `${data.priorityCompleted}/${CONFIG.PRIORITY_COUNT}`
    );

    setText(
      'backgroundProgress',
      `${data.backgroundCompleted}/${CONFIG.BACKGROUND_COUNT}`
    );

    setText(
      'scannerCurrentPair',
      data.pair || '—'
    );

    setText(
      'scannerPhase',
      data.phase || 'WAITING'
    );

    const percent = Math.round(
      data.completed / CONFIG.TOTAL_PAIRS * 100
    );

    const bar = $('scannerProgressBar');

    if (bar) {
      bar.style.width = `${percent}%`;
      bar.setAttribute(
        'aria-valuenow',
        String(percent)
      );
    }
  }

  function candidateStatus(candidate) {
    const data = obj(candidate);

    const direction = getCandidateSignal(data);

    if (
      data.freshness !== 'FRESH' ||
      data.tradeAllowed !== true
    ) {
      return 'NOT ELIGIBLE';
    }

    if (
      direction === 'BUY' ||
      direction === 'SELL'
    ) {
      return `${direction} CANDIDATE`;
    }

    return 'NO TRADE';
  }

  function renderRankedCandidates(candidates) {
    const body = $('rankedCandidatesBody');

    if (!body) return;

    body.replaceChildren();

    if (!Array.isArray(candidates) || !candidates.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');

      cell.colSpan = 8;
      cell.textContent = 'No candidate data available.';

      row.appendChild(cell);
      body.appendChild(row);

      return;
    }

    candidates.forEach(candidate => {
      const data = obj(candidate);

      const row = document.createElement('tr');

      const values = [
        normalizePair(data.pair),
        formatNumber(data.currentPrice),
        first(data.oneMinuteTrend, 'UNKNOWN'),
        first(data.volatility, 'UNKNOWN'),
        number(data.evidenceScore) === null
          ? '—'
          : `${data.evidenceScore}/100`,
        first(data.freshness, 'UNKNOWN'),
        candidateStatus(data),
        first(
          data.rejectedReasons &&
          data.rejectedReasons.length
            ? data.rejectedReasons.join('; ')
            : null,
          '—'
        )
      ];

      values.forEach((value, index) => {
        const cell = document.createElement('td');

        cell.textContent = String(value);

        if (index === 6) {
          cell.dataset.status = String(value)
            .toLowerCase()
            .replace(/\s+/g, '-');
        }

        row.appendChild(cell);
      });

      body.appendChild(row);
    });
  }

  function renderScanner(payload) {
    const root = obj(payload);

    const scanner = obj(first(
      root.scanner,
      root
    ));

    state.lastScanner = scanner;

    renderScannerProgress(
      first(
        scanner.progress,
        root.progress,
        {}
      )
    );

    renderRankedCandidates(
      first(
        root.rankedCandidates,
        scanner.rankedCandidates,
        scanner.candidates,
        []
      )
    );

    setText(
      'scannerLastUpdated',
      formatDate(first(
        scanner.updatedAt,
        scanner.lastUpdated,
        root.updatedAt
      ))
    );

    setText(
      'scannerStatus',
      first(
        scanner.status,
        scanner.phase,
        'SCANNING'
      )
    );
  }

  async function pollScanner() {
    if (state.scanBusy || state.destroyed) {
      return;
    }

    state.scanBusy = true;

    try {
      const response = await apiGet('/api/best');

      renderScanner(response);

      const market = getBestMarketFromResponse(response);

      if (
        market &&
        state.selectedPair &&
        isAutoSelection(state.selectedPair) &&
        !state.analysisBusy &&
        !state.confirmationBusy
      ) {
        renderMarketAnalysis(market);
      }

    } catch (error) {
      setText(
        'scannerStatus',
        `SCANNER ERROR: ${error.message}`
      );

    } finally {
      state.scanBusy = false;
    }
  }

  async function refreshScanner() {
    if (state.destroyed) return;

    setText('scannerStatus', 'REFRESHING...');

    await pollScanner();
  }

  function startScannerPolling() {
    if (state.scanTimer) {
      window.clearInterval(state.scanTimer);
    }

    pollScanner();

    state.scanTimer = window.setInterval(
      pollScanner,
      CONFIG.SCAN_POLL_INTERVAL_MS
    );
  }

  /* =======================================================
     MANUAL PAIR SCAN
  ======================================================= */

  async function scanManualPair(pair) {
    const normalized = normalizePair(pair);

    if (!validPair(normalized)) {
      showMessage('Invalid currency pair.', 'error');
      return null;
    }

    const response = await apiGet(
      `/api/scan/pair?pair=${encodeURIComponent(normalized)}`
    );

    const market = getMarketFromPayload(response);

    if (
      market.pair &&
      normalizePair(market.pair) === normalized
    ) {
      renderMarketAnalysis(market);
    }

    return market;
  }

  /* =======================================================
     END OF PART 3
     PART 4 CONTINUES WITH BROKER PRICE CAPTURE
     AND CONFIRM-SIGNAL VALIDATION.
  ======================================================= */

  /* =======================================================
     POCKET OPTION BROKER PRICE CAPTURE
  ======================================================= */

  function parseBrokerPrice(value) {
    if (value === null || value === undefined) {
      return null;
    }

    const cleaned = String(value)
      .trim()
      .replace(/,/g, '');

    if (!cleaned) return null;

    const parsed = Number(cleaned);

    if (
      !Number.isFinite(parsed) ||
      parsed <= 0
    ) {
      return null;
    }

    return parsed;
  }

  function captureBrokerPrice() {
    const input = dom.brokerPriceInput;

    if (!input) return;

    const capturedAt = Date.now();

    const price = parseBrokerPrice(input.value);

    /*
     * Timestamp is captured at the moment the user
     * types, pastes or edits the broker price.
     *
     * It is NOT captured when CONFIRM is clicked.
     */

    state.brokerPriceCapturedAt = capturedAt;
    state.brokerPrice = price;

    if (state.lastConfirmedSignal) {
      clearConfirmedSignal();
    }

    if (price === null) {
      setText(
        'brokerPriceStatus',
        'ENTER A VALID BROKER PRICE'
      );

      return;
    }

    setText(
      'brokerPriceStatus',
      'PRICE CAPTURED — READY FOR VALIDATION'
    );

    setText(
      'brokerPriceCapturedTime',
      new Date(capturedAt).toLocaleTimeString()
    );
  }

  function getBrokerPriceAgeSeconds() {
    if (!state.brokerPriceCapturedAt) {
      return null;
    }

    return (
      Date.now() - state.brokerPriceCapturedAt
    ) / 1000;
  }

  function isBrokerPriceFresh() {
    const age = getBrokerPriceAgeSeconds();

    return (
      age !== null &&
      age >= 0 &&
      age <= CONFIG.MAX_BROKER_PRICE_AGE_SECONDS &&
      state.brokerPrice !== null &&
      state.brokerPrice > 0
    );
  }

  function clearBrokerPrice() {
    state.brokerPrice = null;
    state.brokerPriceCapturedAt = null;

    if (dom.brokerPriceInput) {
      dom.brokerPriceInput.value = '';
    }

    setText(
      'brokerPriceStatus',
      'WAITING FOR POCKET OPTION PRICE'
    );

    setText(
      'brokerPriceCapturedTime',
      '—'
    );
  }

  function resetAfterPairChange() {
    clearBrokerPrice();
    clearConfirmedSignal();
    clearCandidateDisplay();

    state.lastMarket = null;
    state.awaitingBrokerPrice = false;

    setText(
      'analysisTradeStatus',
      'PAIR CHANGED — ANALYZE AGAIN'
    );

    showMessage(
      'Pair changed. Enter a new Pocket Option price after analysis.',
      'info'
    );
  }

  /* =======================================================
     CONFIRMATION RESPONSE VALIDATION
  ======================================================= */

  function validateConfirmationResponse(response) {
    const root = obj(response);

    const market = obj(first(
      root.selectedMarket,
      root.market,
      root
    ));

    const broker = obj(root.brokerPrice);

    const direction = getConfirmedSignal(market);

    const brokerValidated =
      broker.validated === true ||
      broker.status === 'VALIDATED';

    return (
      root.ok !== false &&
      root.confirmed === true &&
      root.tradeAllowed === true &&
      market.tradeAllowed === true &&
      brokerValidated &&
      ['BUY', 'SELL'].includes(direction)
    );
  }

  /* =======================================================
     CONFIRM SIGNAL
  ======================================================= */

  async function confirmSignal() {
    if (
      state.confirmationBusy ||
      state.destroyed
    ) {
      return;
    }

    if (!state.awaitingBrokerPrice) {
      showMessage(
        'Analyze a qualified market candidate before confirming.',
        'warning'
      );

      return;
    }

    const market = obj(state.lastMarket);

    if (!isQualified(market)) {
      showMessage(
        'The market candidate is no longer eligible. Analyze again.',
        'warning'
      );

      clearConfirmedSignal();

      return;
    }

    const pair = normalizePair(market.pair);

    if (!validPair(pair)) {
      showMessage(
        'Invalid selected currency pair.',
        'error'
      );

      return;
    }

    const brokerPrice = parseBrokerPrice(
      dom.brokerPriceInput
        ? dom.brokerPriceInput.value
        : state.brokerPrice
    );

    if (brokerPrice === null) {
      showMessage(
        'Enter a valid Pocket Option broker price.',
        'warning'
      );

      return;
    }

    /*
     * Use the timestamp captured by the input event.
     * Never create a new timestamp at confirmation time.
     */

    if (
      !state.brokerPriceCapturedAt ||
      brokerPrice !== state.brokerPrice
    ) {
      showMessage(
        'The broker price changed. Enter or edit the price again so its timestamp is captured.',
        'warning'
      );

      return;
    }

    if (!isBrokerPriceFresh()) {
      showMessage(
        'Broker price is older than 30 seconds. Update the Pocket Option price and try again.',
        'warning'
      );

      return;
    }

    const capturedAtISO = new Date(
      state.brokerPriceCapturedAt
    ).toISOString();

    state.confirmationBusy = true;

    clearConfirmedSignal();

    setButtonBusy(
      dom.confirmSignalButton,
      true,
      'VALIDATING BROKER PRICE...',
      'CONFIRM SIGNAL'
    );

    showMessage(
      'VALIDATING BROKER PRICE — requesting fresh market verification...',
      'info'
    );

    try {
      /*
       * Backend must fetch fresh Twelve Data before
       * confirming the signal and re-check quote age
       * after provider queue waiting.
       */

      const response = await apiPost(
        '/api/confirm-signal',
        {
          pair,
          brokerPrice,
          brokerPriceCapturedAt: capturedAtISO,
          expiryMinutes: CONFIG.LIVE_EXPIRY_MINUTES,
          mode: state.selectedMode || 'MANUAL',
          source: 'USER_ENTERED_POCKET_OPTION_PRICE'
        }
      );

      if (!validateConfirmationResponse(response)) {
        clearConfirmedSignal();

        const reason = first(
          response.message,
          response.reason,
          response.error,
          'Backend did not approve this trade.'
        );

        showMessage(
          `NO TRADE — ${reason}`,
          'warning'
        );

        return;
      }

      /*
       * Re-check that the user has not edited the quote
       * while the confirmation request was running.
       */

      if (
        !isBrokerPriceFresh() ||
        state.brokerPrice !== brokerPrice ||
        state.brokerPriceCapturedAt !==
          new Date(capturedAtISO).getTime()
      ) {
        clearConfirmedSignal();

        showMessage(
          'Broker price changed or expired during validation. Please enter it again.',
          'warning'
        );

        return;
      }

      const rendered = renderConfirmedSignal(response);

      if (!rendered) {
        clearConfirmedSignal();
        return;
      }

      state.awaitingBrokerPrice = false;

    } catch (error) {
      clearConfirmedSignal();

      showMessage(
        `CONFIRMATION FAILED — ${error.message}`,
        'error'
      );

    } finally {
      state.confirmationBusy = false;

      setButtonBusy(
        dom.confirmSignalButton,
        false,
        'VALIDATING BROKER PRICE...',
        'CONFIRM SIGNAL'
      );
    }
  }

  /* =======================================================
     BROKER PRICE EVENT LISTENERS
  ======================================================= */

  function attachBrokerPriceListeners() {
    if (!dom.brokerPriceInput) {
      return;
    }

    /*
     * The input event fires for typing, pasting and
     * programmatic user edits in supported browsers.
     * Avoid using change/blur or the Confirm button
     * to create the quote timestamp.
     */

    dom.brokerPriceInput.addEventListener(
      'input',
      captureBrokerPrice
    );

    dom.brokerPriceInput.addEventListener(
      'paste',
      () => {
        /*
         * The input event after paste performs the
         * actual capture once the value is updated.
         */
      }
    );
  }

  /* =======================================================
     END OF PART 4
     PART 5 CONTINUES WITH BACKTEST AND HISTORY.
  ======================================================= */

  /* =======================================================
     BACKTEST CONFIGURATION
  ======================================================= */

  const BACKTEST_EXPIRIES = Object.freeze([1, 2, 3]);

  function getBacktestPair() {
    const value = dom.backtestPairSelect
      ? normalizePair(dom.backtestPairSelect.value)
      : 'EUR/USD';

    return validPair(value) ? value : 'EUR/USD';
  }

  function getBacktestExpiry() {
    const value = number(
      dom.backtestDuration
        ? dom.backtestDuration.value
        : 1
    );

    return BACKTEST_EXPIRIES.includes(value)
      ? value
      : 1;
  }

  function formatPercent(value) {
    const parsed = number(value);

    if (parsed === null) return '—';

    return `${parsed.toFixed(2)}%`;
  }

  function renderBacktestResult(payload) {
    const root = obj(payload);
    const result = obj(first(
      root.result,
      root.backtest,
      root
    ));

    const metrics = obj(first(
      result.metrics,
      result.performance,
      result.statistics
    ));

    setText(
      'backtestStatus',
      first(result.status, 'COMPLETED')
    );

    setText(
      'backtestPairResult',
      first(result.pair, '—')
    );

    setText(
      'backtestExpiryResult',
      first(
        result.expiryMinutes,
        result.expiry,
        '—'
      )
    );

    setText(
      'backtestTotalTrades',
      first(
        metrics.totalTrades,
        result.totalTrades,
        result.sampleSize,
        '—'
      )
    );

    setText(
      'backtestWins',
      first(metrics.wins, result.wins, '—')
    );

    setText(
      'backtestLosses',
      first(metrics.losses, result.losses, '—')
    );

    setText(
      'backtestTies',
      first(metrics.ties, result.ties, '—')
    );

    setText(
      'backtestWinRate',
      formatPercent(first(
        metrics.winRate,
        result.winRate
      ))
    );

    setText(
      'backtestMethod',
      first(
        result.method,
        'CHRONOLOGICAL HOLDOUT'
      )
    );

    setText(
      'backtestTrainSamples',
      first(
        result.trainingSamples,
        result.trainSamples,
        '—'
      )
    );

    setText(
      'backtestTestSamples',
      first(
        result.testingSamples,
        result.testSamples,
        '—'
      )
    );

    setText(
      'backtestGeneratedAt',
      formatDate(first(
        result.generatedAt,
        root.generatedAt
      ))
    );

    setText(
      'backtestLimitations',
      'Historical simulation does not guarantee future performance. Results may not include broker spread, slippage, latency or payout differences.'
    );

    const note = $('backtestEvidenceNote');

    if (note) {
      note.textContent =
        'Backtest statistics are historical results, not a prediction or guarantee of future wins.';
    }
  }

  /* =======================================================
     RUN BACKTEST
  ======================================================= */

  async function runBacktest() {
    if (state.backtestBusy || state.destroyed) {
      return;
    }

    const pair = getBacktestPair();
    const expiryMinutes = getBacktestExpiry();

    if (!validPair(pair)) {
      showMessage(
        'Select a valid pair for backtesting.',
        'error'
      );

      return;
    }

    if (!BACKTEST_EXPIRIES.includes(expiryMinutes)) {
      showMessage(
        'Backtest expiry must be 1, 2 or 3 minutes.',
        'error'
      );

      return;
    }

    state.backtestBusy = true;

    setButtonBusy(
      dom.runBacktestButton,
      true,
      'RUNNING BACKTEST...',
      'RUN BACKTEST'
    );

    setText('backtestStatus', 'RUNNING');

    showMessage(
      `Running historical backtest for ${pair}, ${expiryMinutes}-minute expiry...`,
      'info'
    );

    try {
      const query = new URLSearchParams({
        pair,
        expiryMinutes: String(expiryMinutes)
      });

      const response = await apiGet(
        `/api/backtest?${query.toString()}`
      );

      if (response.ok === false) {
        throw new Error(
          first(
            response.message,
            response.error,
            'Backtest failed.'
          )
        );
      }

      renderBacktestResult(response);

      showMessage(
        'Backtest completed. Review the sample size and test-period results before interpreting performance.',
        'success'
      );

    } catch (error) {
      setText(
        'backtestStatus',
        `FAILED: ${error.message}`
      );

      showMessage(
        `Backtest failed: ${error.message}`,
        'error'
      );

    } finally {
      state.backtestBusy = false;

      setButtonBusy(
        dom.runBacktestButton,
        false,
        'RUNNING BACKTEST...',
        'RUN BACKTEST'
      );
    }
  }

  /* =======================================================
     SIGNAL HISTORY
  ======================================================= */

  function historyOutcome(item) {
    const data = obj(item);

    const outcome = String(first(
      data.outcome,
      data.result,
      data.status,
      'PENDING'
    )).toUpperCase();

    const allowed = [
      'WIN',
      'LOSS',
      'TIE',
      'INVALID',
      'PENDING'
    ];

    return allowed.includes(outcome)
      ? outcome
      : 'PENDING';
  }

  function createHistoryCell(value) {
    const cell = document.createElement('td');

    cell.textContent =
      value === null ||
      value === undefined ||
      value === ''
        ? '—'
        : String(value);

    return cell;
  }

  function renderHistory(items) {
    const body = $('signalHistoryBody');

    if (!body) return;

    body.replaceChildren();

    if (!Array.isArray(items) || !items.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');

      cell.colSpan = 8;
      cell.textContent = 'No signal history available.';

      row.appendChild(cell);
      body.appendChild(row);

      setText('historyCount', '0');

      return;
    }

    const visibleItems = items.slice(
      0,
      CONFIG.MAX_HISTORY
    );

    visibleItems.forEach(item => {
      const data = obj(item);

      const row = document.createElement('tr');

      const outcome = historyOutcome(data);

      const cells = [
        first(data.pair, '—'),
        first(data.direction, data.signal, '—'),
        formatNumber(first(
          data.entryPrice,
          data.brokerPrice
        )),
        formatNumber(first(
          data.exitPrice,
          data.expiryPrice
        )),
        first(
          data.expiryMinutes,
          data.expiry,
          '—'
        ),
        outcome,
        first(data.evidenceScore, '—'),
        formatDate(first(
          data.createdAt,
          data.timestamp,
          data.entryTime
        ))
      ];

      cells.forEach((value, index) => {
        const cell = createHistoryCell(value);

        if (index === 5) {
          cell.dataset.outcome = outcome.toLowerCase();
        }

        row.appendChild(cell);
      });

      body.appendChild(row);
    });

    setText(
      'historyCount',
      String(visibleItems.length)
    );
  }

  /* =======================================================
     LOAD SIGNAL HISTORY
  ======================================================= */

  async function loadHistory() {
    if (state.historyBusy || state.destroyed) {
      return;
    }

    state.historyBusy = true;

    setText('historyStatus', 'LOADING...');

    try {
      const response = await apiGet('/api/history');

      const root = obj(response);

      const items = Array.isArray(response)
        ? response
        : first(
            root.history,
            root.items,
            root.records,
            []
          );

      if (!Array.isArray(items)) {
        throw new Error(
          'History response has an unexpected format.'
        );
      }

      renderHistory(items);

      setText('historyStatus', 'UPDATED');

    } catch (error) {
      setText(
        'historyStatus',
        `UNAVAILABLE: ${error.message}`
      );

    } finally {
      state.historyBusy = false;
    }
  }

  /* =======================================================
     END OF PART 5
     PART 6 CONTINUES WITH EVENT BINDINGS,
     INITIALIZATION AND CLEANUP.
  ======================================================= */

  /* =======================================================
     SELECT OPTIONS
  ======================================================= */

  function ensureOption(select, value, label) {
    if (!select) return;

    const exists = Array.from(select.options).some(
      option => option.value === value
    );

    if (exists) return;

    const option = document.createElement('option');

    option.value = value;
    option.textContent = label;

    select.appendChild(option);
  }

  function populatePairSelectors() {
    if (dom.pairSelect) {
      ensureOption(
        dom.pairSelect,
        AUTO_PAIR,
        'AUTO SELECT — BEST AVAILABLE'
      );

      PAIRS.forEach(pair => {
        ensureOption(dom.pairSelect, pair, pair);
      });

      if (!dom.pairSelect.value) {
        dom.pairSelect.value = AUTO_PAIR;
      }
    }

    if (dom.backtestPairSelect) {
      PAIRS.forEach(pair => {
        ensureOption(
          dom.backtestPairSelect,
          pair,
          pair
        );
      });

      if (!dom.backtestPairSelect.value) {
        dom.backtestPairSelect.value = 'EUR/USD';
      }
    }
  }

  /* =======================================================
     EVENT BINDINGS
  ======================================================= */

  function bindButton(button, callback) {
    if (!button) return;

    button.addEventListener('click', event => {
      event.preventDefault();

      Promise.resolve()
        .then(callback)
        .catch(error => {
          showMessage(
            error.message || 'Unexpected application error.',
            'error'
          );
        });
    });
  }

  function attachPairSelectorListener() {
    if (!dom.pairSelect) return;

    dom.pairSelect.addEventListener(
      'change',
      () => {
        const pair = getSelectedPair();

        state.selectedPair = pair;

        resetAfterPairChange();

        if (validPair(pair)) {
          showMessage(
            `${pair} selected. Analyze to obtain a fresh candidate.`,
            'info'
          );
        } else if (isAutoSelection(pair)) {
          showMessage(
            'AUTO SELECT enabled. The scanner will choose an eligible pair.',
            'info'
          );
        }
      }
    );
  }

  function attachBacktestListeners() {
    if (dom.backtestPairSelect) {
      dom.backtestPairSelect.addEventListener(
        'change',
        () => {
          setText(
            'backtestStatus',
            'READY'
          );
        }
      );
    }

    if (dom.backtestDuration) {
      dom.backtestDuration.addEventListener(
        'change',
        () => {
          const expiry = getBacktestExpiry();

          setText(
            'backtestExpiryPreview',
            `${expiry} MINUTE(S)`
          );
        }
      );
    }
  }

  function attachModeListener() {
    const modeSelect = $('modeSelect');

    if (!modeSelect) return;

    modeSelect.addEventListener(
      'change',
      () => {
        const mode = String(
          modeSelect.value || 'MANUAL'
        ).toUpperCase();

        state.selectedMode = [
          'AUTO',
          'MANUAL'
        ].includes(mode)
          ? mode
          : 'MANUAL';

        clearConfirmedSignal();

        showMessage(
          `Mode changed to ${state.selectedMode}. Confirm a new candidate before trading.`,
          'info'
        );
      }
    );
  }

  /* =======================================================
     APPLICATION EVENT SETUP
  ======================================================= */

  function attachApplicationEvents() {
    bindButton(
      dom.analyzeButton,
      analyzeSelectedPair
    );

    bindButton(
      dom.refreshScannerButton,
      refreshScanner
    );

    bindButton(
      dom.runBacktestButton,
      runBacktest
    );

    bindButton(
      dom.refreshHistoryButton,
      loadHistory
    );

    bindButton(
      dom.confirmSignalButton,
      confirmSignal
    );

    attachBrokerPriceListeners();
    attachPairSelectorListener();
    attachBacktestListeners();
    attachModeListener();
  }

  /* =======================================================
     INITIAL UI STATE
  ======================================================= */

  function initializeDisplay() {
    clearConfirmedSignal();
    clearCandidateDisplay();

    setText(
      'scannerStatus',
      'STARTING'
    );

    setText(
      'scannerProgress',
      `0/${CONFIG.TOTAL_PAIRS}`
    );

    setText(
      'priorityProgress',
      `0/${CONFIG.PRIORITY_COUNT}`
    );

    setText(
      'backgroundProgress',
      `0/${CONFIG.BACKGROUND_COUNT}`
    );

    setText(
      'historyStatus',
      'WAITING'
    );

    setText(
      'backtestStatus',
      'READY'
    );

    setText(
      'brokerPriceStatus',
      'WAITING FOR POCKET OPTION PRICE'
    );

    setText(
      'versionLabel',
      VERSION
    );

    setText(
      'applicationVersion',
      VERSION
    );

    setText(
      'pairCount',
      String(PAIRS.length)
    );

    setText(
      'priorityPairCount',
      String(PRIORITY_PAIRS.length)
    );

    setText(
      'backgroundPairCount',
      String(BACKGROUND_PAIRS.length)
    );

    if (dom.expirySelect) {
      dom.expirySelect.value = '1';
      dom.expirySelect.disabled = true;
    }

    if (dom.brokerPriceInput) {
      dom.brokerPriceInput.value = '';
    }

    state.selectedPair = getSelectedPair();
  }

  /* =======================================================
     START APPLICATION
  ======================================================= */

  async function initializeApp() {
    if (state.destroyed) return;

    populatePairSelectors();

    initializeDisplay();

    attachApplicationEvents();

    await checkHealth();

    startScannerPolling();

    loadHistory();

    if (state.healthTimer) {
      window.clearInterval(state.healthTimer);
    }

    state.healthTimer = window.setInterval(
      checkHealth,
      CONFIG.HEALTH_INTERVAL_MS
    );

    console.info(
      `[PO AI PREDICTOR] ${VERSION} initialized`
    );

    console.info(
      `[PO AI PREDICTOR] ${PAIRS.length} pairs configured`
    );

    console.info(
      `[PO AI PREDICTOR] ${PRIORITY_PAIRS.length} priority pairs`
    );

    console.info(
      `[PO AI PREDICTOR] ${BACKGROUND_PAIRS.length} background pairs`
    );
  }

  /* =======================================================
     CLEANUP
  ======================================================= */

  function destroyApp() {
    state.destroyed = true;

    if (state.scanTimer) {
      window.clearInterval(state.scanTimer);
      state.scanTimer = null;
    }

    if (state.healthTimer) {
      window.clearInterval(state.healthTimer);
      state.healthTimer = null;
    }
  }

  /* =======================================================
     STARTUP
  ======================================================= */

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      initializeApp,
      { once: true }
    );
  } else {
    initializeApp();
  }

  window.addEventListener(
    'pagehide',
    destroyApp,
    { once: true }
  );

  /* =======================================================
     END OF PART 6
  ======================================================= */

})();
