
'use strict';

/*
 * PO AI PREDICTOR — V10.4.0
 * LIVE FOREX ONLY — OTC is not supported.
 *
 * Frontend contract:
 * - Compatible with backend/server.js V10.4.0
 * - Captures Pocket Option price timestamp on every edit
 * - Sends timestamp captured at input time, not confirmation time
 * - Never displays BUY/SELL as confirmed before backend validation
 * - Uses 1-minute live expiry only
 * - Backtests 1, 2 and 3 minutes
 */

(() => {
  const API_BASE = String(
    window.PO_API_BASE ||
    'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const VERSION = 'V10.4.0';
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
    MAX_HISTORY: 100
  });

  const PAIRS = Object.freeze([
    'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF',
    'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP',
    'EUR/JPY', 'GBP/JPY', 'EUR/CHF', 'EUR/AUD',
    'EUR/CAD', 'GBP/CHF', 'GBP/AUD', 'GBP/CAD',
    'AUD/JPY', 'AUD/CAD', 'AUD/NZD', 'CAD/JPY',
    'CHF/JPY', 'NZD/JPY', 'NZD/CAD', 'EUR/NZD'
  ]);

  const PRIORITY_PAIRS = Object.freeze([
    'EUR/USD', 'GBP/USD', 'USD/JPY',
    'USD/CHF', 'AUD/USD', 'USD/CAD'
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
    autoSelecting: false,
    destroyed: false
  };

  /* -------------------------------------------------------
     GENERAL HELPERS
  ------------------------------------------------------- */

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
    if (input) input.disabled = !enabled;
  }

  function setButtonBusy(
    button,
    busy,
    busyText,
    normalText
  ) {
    if (!button) return;

    button.disabled = busy;
    button.textContent = busy ? busyText : normalText;
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
      message || (online ? 'API ONLINE' : 'API UNAVAILABLE')
    );

    setText(
      'apiStatusCard',
      online ? 'ONLINE' : 'OFFLINE'
    );
  }

  function validPair(pair) {
    return PAIRS.includes(String(pair || '').toUpperCase());
  }

  function normalizePair(pair) {
    return String(pair || '').trim().toUpperCase();
  }

  function isFresh(market) {
    const age = number(market.dataAgeSeconds);

    return (
      String(market.freshness || '').toUpperCase() === 'FRESH' &&
      age !== null &&
      age >= 0 &&
      age <= CONFIG.MAX_DATA_AGE_SECONDS &&
      number(market.currentPrice) > 0 &&
      market.insufficientData !== true
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

  function getSignal(market) {
    const signalObject = obj(market.signal);

    const raw = String(
      typeof market.signal === 'string'
        ? market.signal
        : first(
            signalObject.action,
            signalObject.direction,
            market.action,
            market.direction,
            'NO TRADE'
          )
    ).toUpperCase().trim();

    if (
      market.noTrade === true ||
      market.tradeAllowed !== true ||
      market.insufficientData === true ||
      signalObject.noTrade === true ||
      signalObject.tradeAllowed === false
    ) {
      return 'NO TRADE';
    }

    if (['BUY', 'CALL', 'UP', 'BULLISH'].includes(raw)) {
      return 'BUY';
    }

    if (['SELL', 'PUT', 'DOWN', 'BEARISH'].includes(raw)) {
      return 'SELL';
    }

    return 'NO TRADE';
  }

  /* -------------------------------------------------------
     API REQUESTS
  ------------------------------------------------------- */

  async function requestJson(path, options = {}) {
    const controller = new AbortController();

    const timeoutMs =
      options.timeout || CONFIG.REQUEST_TIMEOUT_MS;

    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs
    );

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: options.method || 'GET',
        cache: 'no-store',

        headers: {
          Accept: 'application/json',

          ...(options.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {})
        },

        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),

        signal: controller.signal
      });

      const raw = await response.text();

      let payload = {};

      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          `API returned invalid JSON. HTTP ${response.status}.`
        );
      }

      if (!response.ok || payload.ok === false) {
        const reason = first(
          payload.reason,
          payload.error,
          payload.message,
          `HTTP ${response.status}`
        );

        const error = new Error(String(reason));
        error.status = response.status;
        error.payload = payload;

        throw error;
      }

      return payload;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(
          'API request timed out. No signal was confirmed.'
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /* -------------------------------------------------------
     HEALTH AND PROVIDER STATUS
  ------------------------------------------------------- */

  function renderScannerProgress(progress, running) {
    const data = obj(progress);

    const completed = number(
      first(data.priorityCompleted, data.completed)
    ) || 0;

    const total = number(
      first(data.priorityTotal, data.total)
    ) || 6;

    const percent = total > 0
      ? Math.max(0, Math.min(100, completed / total * 100))
      : 0;

    const bar = $('scannerProgressBar');

    if (bar) {
      bar.style.width = `${percent}%`;
    }

    setText(
      'scannerProgress',
      `${completed} / ${total} priority pairs`
    );

    setText(
      'scannerStatus',
      running
        ? `Scanning ${first(data.pair, 'priority pairs')}...`
        : first(data.phase, 'Scanner idle')
    );
  }

  function renderHealth(payload) {
    const root = obj(payload);

    state.lastHealth = root;

    const online = root.ok !== false;
    const configured = root.configured === true;

    renderApiStatus(
      online,
      online ? 'API ONLINE' : 'API UNAVAILABLE'
    );

    setText(
      'apiStatusDetail',
      `Backend ${first(root.version, VERSION)}`
    );

    setText(
      'providerStatus',
      first(root.provider, 'TWELVE DATA')
    );

    setText(
      'providerDetail',
      configured
        ? 'Twelve Data API key configured'
        : 'Twelve Data API key not configured'
    );

    setText('pairsTracked', PAIRS.length);

    renderScannerProgress(
      root.scanProgress,
      root.scannerRunning === true
    );

    const metadata = obj(root.metadata);

    setText(
      'historySource',
      metadata.databaseReady === true
        ? 'POSTGRESQL'
        : 'MEMORY ONLY'
    );

    if (!configured) {
      setText(
        'providerDetail',
        'Twelve Data API key is not configured on backend'
      );
    }
  }

  async function checkHealth() {
    if (state.healthBusy || state.destroyed) return;

    state.healthBusy = true;

    try {
      const payload = await requestJson('/api/health', {
        timeout: CONFIG.HEALTH_TIMEOUT_MS
      });

      renderHealth(payload);
    } catch (error) {
      renderApiStatus(false, 'API OFFLINE / UNAVAILABLE');
      setText('apiStatusDetail', error.message);
      setText('providerDetail', 'Provider status unavailable');
    } finally {
      state.healthBusy = false;
    }
  }

  /* -------------------------------------------------------
     SIGNAL DISPLAY
  ------------------------------------------------------- */

  function renderDirection(direction) {
    const node = $('signalDirection');

    if (!node) return;

    node.textContent = direction;

    node.className = 'signal-direction ' +
      (direction === 'BUY'
        ? 'buy'
        : direction === 'SELL'
          ? 'sell'
          : 'no-trade');
  }

  function invalidateCurrentSignal(message) {
    state.lastMarket = null;
    state.awaitingBrokerPrice = false;
    state.lastConfirmedSignal = null;

    renderDirection('NO TRADE');

    setText('signalStatus', 'NO TRADE');
    setText('signalReason', message);
    setText('signalWarning', message);

    setVisible('confirmSignalButton', false);
  }

  function renderReasons(reasons) {
    const items = Array.isArray(reasons)
      ? reasons.filter(Boolean).slice(0, CONFIG.MAX_REASONS)
      : [];

    const target = $('analysisMessage');

    if (!target) return;

    target.replaceChildren();

    const heading = document.createTextNode('Analysis notes: ');
    target.appendChild(heading);

    if (!items.length) {
      target.appendChild(
        document.createTextNode(
          'No additional decision reasons were supplied.'
        )
      );
      return;
    }

    const list = document.createElement('ul');
    list.className = 'reason-list';

    for (const reason of items) {
      const item = document.createElement('li');
      item.textContent = String(reason);
      list.appendChild(item);
    }

    target.appendChild(list);
  }

  /* -------------------------------------------------------
     TECHNICAL INDICATORS
  ------------------------------------------------------- */

  function renderTechnical(market) {
    const indicators = obj(market.indicators);
    const macd = obj(indicators.macd);
    const bollinger = obj(indicators.bollinger);
    const divergence = obj(indicators.rsiDivergence);
    const confirmation = obj(market.confirmation5m);
    const volatility = obj(market.volatility);
    const levels = obj(market.supportResistance);
    const trendline = obj(market.trendLine);
    const breakout = obj(market.breakout);
    const pattern = obj(market.candlePattern);
    const psychology = obj(market.marketPsychology);

    setText(
      'emaSignal',
      first(indicators.emaCross, 'UNAVAILABLE')
    );

    setText(
      'emaDetail',
      `EMA 9: ${formatNumber(indicators.ema9)} · EMA 21: ${formatNumber(indicators.ema21)}`
    );

    const rsi = number(indicators.rsi14);

    setText('rsiValue', formatNumber(rsi, 2));

    setText(
      'rsiSignal',
      rsi === null
        ? 'RSI 14 unavailable'
        : rsi > 70
          ? 'Above 70 · elevated'
          : rsi < 30
            ? 'Below 30 · depressed'
            : 'Between 30 and 70'
    );

    setText(
      'rsiDivergence',
      first(divergence.type, 'UNAVAILABLE')
    );

    setText(
      'rsiDivergenceDetail',
      first(
        divergence.description,
        'RSI divergence not available'
      )
    );

    setText(
      'macdSignal',
      first(macd.crossover, 'UNAVAILABLE')
    );

    setText(
      'macdDetail',
      `Line ${formatNumber(macd.line, 7)} · Signal ${formatNumber(macd.signal, 7)} · Histogram ${formatNumber(macd.histogram, 7)}`
    );

    setText(
      'fiveMinuteTrend',
      first(confirmation.direction, 'UNAVAILABLE')
    );

    setText(
      'fiveMinuteDetail',
      first(
        confirmation.reason,
        confirmation.status,
        '5-minute diagnostic unavailable'
      )
    );

    setText('atrValue', formatNumber(indicators.atr14, 7));

    setText(
      'atrDetail',
      volatility.atrPercent !== undefined
        ? `ATR percentage: ${formatNumber(volatility.atrPercent, 5)}%`
        : 'ATR reading'
    );

    setText(
      'bollingerSignal',
      first(bollinger.position, 'CALCULATED')
    );

    setText(
      'bollingerDetail',
      `Upper ${formatNumber(bollinger.upper, 7)} · Middle ${formatNumber(bollinger.middle, 7)} · Lower ${formatNumber(bollinger.lower, 7)}`
    );

    setText(
      'bollingerWidth',
      bollinger.width === null || bollinger.width === undefined
        ? 'UNAVAILABLE'
        : `${formatNumber(bollinger.width, 5)}%`
    );

    setText(
      'bollingerWidthDetail',
      'Band width expansion / contraction'
    );

    setText(
      'volatilityRegime',
      first(volatility.regime, 'UNAVAILABLE')
    );

    setText(
      'volatilityDetail',
      volatility.atrPercent !== undefined
        ? `ATR ${formatNumber(volatility.atrPercent, 5)}% · Bollinger width ${formatNumber(volatility.bollingerWidth, 5)}%`
        : 'Volatility regime unavailable'
    );

    setText(
      'candlestickPatterns',
      first(pattern.name, 'UNAVAILABLE')
    );

    setText(
      'candlestickDetail',
      first(pattern.direction, 'No pattern direction supplied')
    );

    setText(
      'marketPsychology',
      typeof market.marketPsychology === 'string'
        ? market.marketPsychology
        : first(psychology.psychology, 'UNAVAILABLE')
    );

    setText(
      'psychologyDetail',
      first(psychology.direction, 'Price pressure interpretation')
    );

    setText('supportLevel', formatNumber(levels.support));

    setText(
      'supportDetail',
      first(levels.position, 'Support assessment unavailable')
    );

    setText('resistanceLevel', formatNumber(levels.resistance));

    setText(
      'resistanceDetail',
      first(levels.position, 'Resistance assessment unavailable')
    );

    setText(
      'trendlineSignal',
      first(trendline.direction, 'UNAVAILABLE')
    );

    setText(
      'trendlineDetail',
      first(trendline.description, 'Trendline analysis unavailable')
    );

    setText(
      'breakoutSignal',
      first(breakout.status, 'UNAVAILABLE')
    );

    setText(
      'breakoutDetail',
      first(breakout.description, 'Breakout assessment unavailable')
    );

    const breakoutStatus = String(
      first(breakout.status, '')
    ).toUpperCase();

    const retest = breakoutStatus.includes('RETEST');
    const falseBreakout = breakoutStatus.includes('FALSE');

    setText(
      'retestSignal',
      retest ? breakout.status : 'NO CONFIRMED RETEST'
    );

    setText(
      'retestDetail',
      retest
        ? first(breakout.description, 'Retest detected')
        : 'No confirmed retest supplied'
    );

    setText(
      'falseBreakoutSignal',
      falseBreakout ? breakout.status : 'NOT DETECTED'
    );

    setText(
      'falseBreakoutDetail',
      falseBreakout
        ? first(breakout.description, 'False breakout risk')
        : 'No false breakout reported by backend'
    );
  }

  /* -------------------------------------------------------
     BROKER PRICE CAPTURE
  ------------------------------------------------------- */

  function clearBrokerPrice(options = {}) {
    state.brokerPrice = null;
    state.brokerPriceCapturedAt = null;

    if (dom.brokerPriceInput && options.keepInput !== true) {
      dom.brokerPriceInput.value = '';
    }

    setText(
      'brokerPriceStatus',
      'WAITING FOR POCKET OPTION PRICE'
    );

    setText('brokerPriceReference', '—');
    setText('brokerPriceDifference', '—');
    setText('brokerPriceTimestamp', '—');

    if (options.hide === true) {
      setVisible('brokerPriceSection', false);
      setVisible('confirmSignalButton', false);
    }
  }

  function captureBrokerPrice() {
    if (!dom.brokerPriceInput) return;

    const raw = dom.brokerPriceInput.value;
    const parsed = number(raw);

    /*
     * IMPORTANT:
     * Timestamp is captured at the moment the user types,
     * pastes or edits the Pocket Option price.
     * It is NOT generated when CONFIRM SIGNAL is clicked.
     */
    if (raw.trim() === '' || parsed === null || parsed <= 0) {
      state.brokerPrice = null;
      state.brokerPriceCapturedAt = null;

      setText(
        'brokerPriceStatus',
        'ENTER A VALID POCKET OPTION PRICE'
      );

      setText('brokerPriceTimestamp', '—');
      setText('brokerPriceDifference', '—');

      if (dom.confirmSignalButton) {
        dom.confirmSignalButton.disabled = true;
      }

      return;
    }

    const capturedAt = Date.now();

    state.brokerPrice = parsed;
    state.brokerPriceCapturedAt = capturedAt;

    setText('brokerPriceStatus', 'PRICE CAPTURED — READY TO VALIDATE');
    setText('brokerPriceTimestamp', formatDate(capturedAt));

    if (dom.confirmSignalButton) {
      dom.confirmSignalButton.disabled =
        !state.awaitingBrokerPrice ||
        state.confirmationBusy;
    }
  }

  function attachBrokerPriceListeners() {
    if (!dom.brokerPriceInput) return;

    /*
     * input catches keyboard edits, paste, mobile input,
     * number-spinner changes and most programmatic user edits.
     */
    dom.brokerPriceInput.addEventListener(
      'input',
      captureBrokerPrice
    );

    dom.brokerPriceInput.addEventListener(
      'change',
      captureBrokerPrice
    );

    dom.brokerPriceInput.addEventListener(
      'paste',
      () => {
        setTimeout(captureBrokerPrice, 0);
      }
    );
  }

  /* -------------------------------------------------------
     MARKET ANALYSIS DISPLAY
  ------------------------------------------------------- */

  function renderMarket(payload, expectedPair = null) {
    const root = obj(payload);
    const market = getMarketFromPayload(root);

    if (!Object.keys(market).length) {
      throw new Error(
        'The API did not return a market result.'
      );
    }

    const pair = normalizePair(first(
      market.pair,
      root.selectedPair,
      expectedPair,
      ''
    ));

    if (pair && !validPair(pair)) {
      throw new Error('The API returned an unsupported forex pair.');
    }

    if (expectedPair && pair !== normalizePair(expectedPair)) {
      throw new Error(
        `Pair mismatch. Requested ${expectedPair}, received ${pair}.`
      );
    }

    state.lastMarket = market;

    if (pair) {
      state.selectedPair = pair;
    }

    const fresh = isFresh(market);

    /*
     * An analysis result is not a confirmed trade.
     * BUY/SELL remains hidden until broker validation succeeds.
     */
    renderDirection('NO TRADE');

    setText('resultPair', pair || 'NO QUALIFIED PAIR');

    setText(
      'analysisTimestamp',
      formatDate(first(market.fetchedAt, market.lastCandle))
    );

    const evidence = number(
      first(market.evidenceScore, market.confidence)
    );

    setText(
      'evidenceScore',
      evidence === null ? '—' : Math.round(evidence)
    );

    const evidenceBar = $('evidenceBar');

    if (evidenceBar) {
      const score = evidence === null
        ? 0
        : Math.max(0, Math.min(100, evidence));

      evidenceBar.style.width = `${score}%`;
    }

    setText(
      'signalReason',
      !fresh
        ? 'NO TRADE — market data is stale or cannot be verified.'
        : 'Analysis completed. Enter the matching Pocket Option price for final backend validation.'
    );

    setText('entryTime', 'WAITING FOR CONFIRMATION');
    setText('expiryTime', 'WAITING FOR CONFIRMATION');
    setText('entryPrice', 'WAITING FOR POCKET OPTION PRICE');
    setText('signalDuration', '1 minute');
    setText('signalStatus', fresh ? 'WAITING FOR BROKER PRICE' : 'NO TRADE');

    setText(
      'marketFreshness',
      fresh ? 'FRESH' : 'NOT VERIFIED'
    );

    setText(
      'marketFreshnessDetail',
      market.dataAgeSeconds === null ||
      market.dataAgeSeconds === undefined
        ? 'Data age unavailable'
        : `Last completed candle age: ${formatNumber(market.dataAgeSeconds, 1)} seconds`
    );

    setText(
      'signalWarning',
      fresh
        ? 'Research scan completed. No BUY/SELL is confirmed until Pocket Option price validation passes.'
        : 'NO TRADE: market data is stale, incomplete or unavailable.'
    );

    renderTechnical(market);
    renderReasons(market.reasons);

    state.awaitingBrokerPrice = fresh && Boolean(pair);

    setVisible('brokerPriceSection', state.awaitingBrokerPrice);
    setVisible('confirmSignalButton', state.awaitingBrokerPrice);

    setText('brokerSelectedPair', pair || 'NO PAIR SELECTED');

    setInputEnabled(
      dom.brokerPriceInput,
      state.awaitingBrokerPrice
    );

    clearBrokerPrice({ hide: false });

    if (dom.confirmSignalButton) {
      dom.confirmSignalButton.disabled = true;
    }

    if (!fresh) {
      setText(
        'brokerPriceStatus',
        'NOT AVAILABLE — MARKET DATA NOT FRESH'
      );
    } else {
      setText(
        'brokerPriceStatus',
        `ENTER POCKET OPTION PRICE FOR ${pair}`
      );
    }

    return market;
  }

  /* -------------------------------------------------------
     CONFIRMED SIGNAL DISPLAY
  ------------------------------------------------------- */

  function renderConfirmedSignal(payload, expectedPair) {
    const root = obj(payload);
    const market = getMarketFromPayload(root);

    if (!Object.keys(market).length) {
      throw new Error(
        'The confirmation API did not return a market result.'
      );
    }

    const pair = normalizePair(first(
      market.pair,
      root.selectedPair,
      expectedPair,
      ''
    ));

    if (pair !== normalizePair(expectedPair)) {
      throw new Error('Confirmed pair does not match selected pair.');
    }

    const fresh = isFresh(market);
    const broker = obj(root.brokerPrice);

    const brokerValidated =
      broker.validated === true &&
      String(broker.status || '').toUpperCase() === 'VALIDATED';

    const signal = getSignal(market);

    const allowed =
      root.confirmed === true &&
      root.tradeAllowed === true &&
      market.tradeAllowed === true &&
      brokerValidated &&
      fresh &&
      signal !== 'NO TRADE';

    const direction = allowed ? signal : 'NO TRADE';

    renderDirection(direction);

    const entryPrice = number(first(
      root.entryPrice,
      broker.price,
      market.entryPrice
    ));

    const referencePrice = number(first(
      broker.referencePrice,
      market.referencePrice,
      market.currentPrice
    ));

    const differencePips = number(
      broker.differencePips
    );

    setText('resultPair', pair);

    setText(
      'analysisTimestamp',
      formatDate(first(market.fetchedAt, market.lastCandle))
    );

    const evidence = number(
      first(root.evidenceScore, market.evidenceScore, market.confidence)
    );

    setText(
      'evidenceScore',
      evidence === null ? '—' : Math.round(evidence)
    );

    const evidenceBar = $('evidenceBar');

    if (evidenceBar) {
      evidenceBar.style.width = `${
        evidence === null
          ? 0
          : Math.max(0, Math.min(100, evidence))
      }%`;
    }

    setText(
      'entryPrice',
      entryPrice === null
        ? 'NOT VALIDATED'
        : formatNumber(entryPrice)
    );

    setText(
      'entryTime',
      formatDate(first(root.entryTime, market.entryTime))
    );

    setText(
      'expiryTime',
      formatDate(first(root.expiryTime, market.expiryTime))
    );

    setText(
      'signalDuration',
      formatDuration(
        first(root.entryTime, market.entryTime),
        first(root.expiryTime, market.expiryTime)
      )
    );

    setText(
      'signalStatus',
      allowed ? 'CONFIRMED — 1 MINUTE' : 'NO TRADE'
    );

    setText(
      'signalReason',
      allowed
        ? first(
            market.reason,
            'Fresh market data and broker price validation passed.'
          )
        : first(
            root.reason,
            market.reason,
            'NO TRADE — required confirmation checks did not pass.'
          )
    );

    setText(
      'brokerPriceStatus',
      brokerValidated ? 'PRICE VALIDATED' : 'PRICE NOT VALIDATED'
    );

    setText(
      'brokerPriceReference',
      referencePrice === null
        ? '—'
        : formatNumber(referencePrice)
    );

    setText(
      'brokerPriceDifference',
      differencePips === null
        ? '—'
        : `${formatNumber(differencePips, 2)} pips`
    );

    setText(
      'brokerPriceTimestamp',
      formatDate(first(
        broker.capturedAt,
        state.brokerPriceCapturedAt
      ))
    );

    setText(
      'marketFreshness',
      fresh ? 'FRESH' : 'NOT VERIFIED'
    );

    setText(
      'marketFreshnessDetail',
      market.dataAgeSeconds === null ||
      market.dataAgeSeconds === undefined
        ? 'Data age unavailable'
        : `Data age: ${formatNumber(market.dataAgeSeconds, 1)} seconds`
    );

    setText(
      'signalWarning',
      allowed
        ? 'Backend validation passed. This is a research signal, not a guaranteed outcome.'
        : 'NO TRADE: broker price, freshness or evidence requirements were not satisfied.'
    );

    renderTechnical(market);
    renderReasons(market.reasons);

    state.lastMarket = market;
    state.awaitingBrokerPrice = false;
    state.lastConfirmedSignal = root;

    setVisible('confirmSignalButton', false);
    setInputEnabled(dom.brokerPriceInput, false);

    if (!allowed) {
      renderDirection('NO TRADE');
    }

    return { allowed, direction, market };
  }

  /* -------------------------------------------------------
     SCANNER
  ------------------------------------------------------- */

  function renderScanner(payload) {
    const root = obj(payload);
    const scanner = obj(root.scanner);
    const progress = obj(scanner.progress);

    state.lastScanner = root;

    const candidates = Array.isArray(root.rankedCandidates)
      ? root.rankedCandidates
      : [];

    const body = $('scannerTableBody');

    if (!body) return;

    body.replaceChildren();

    if (!candidates.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');

      cell.colSpan = 8;
      cell.className = 'empty-state';

      cell.textContent = scanner.running
        ? 'Scanner running. Waiting for priority pair results.'
        : 'No fresh scanned pair results are available yet.';

      row.appendChild(cell);
      body.appendChild(row);
    } else {
      for (const candidate of candidates) {
        const pair = normalizePair(candidate.pair);

        if (!validPair(pair)) continue;

        const row = document.createElement('tr');

        const freshness = String(
          first(candidate.freshness, 'UNKNOWN')
        ).toUpperCase();

        const values = [
          pair,
          formatNumber(candidate.currentPrice),
          first(candidate.oneMinuteTrend, '—'),
          first(candidate.fiveMinuteConfirmation, '—'),
          first(candidate.volatility, '—'),
          number(candidate.confidence) === null
            ? '—'
            : `${formatNumber(candidate.confidence, 0)}/100`,
          freshness === 'FRESH' ? 'WAITING FOR PRICE' : 'NO TRADE'
        ];

        for (const value of values) {
          const cell = document.createElement('td');
          cell.textContent = String(first(value, '—'));
          row.appendChild(cell);
        }

        const actionCell = document.createElement('td');
        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'table-select-button';
        button.textContent = 'SELECT';

        button.addEventListener('click', () => {
          if (!validPair(pair)) return;

          if (dom.pairSelect) {
            dom.pairSelect.value = pair;
          }

          handlePairChange();
          analyzeSelectedPair();
        });

        actionCell.appendChild(button);
        row.appendChild(actionCell);
        body.appendChild(row);
      }
    }

    renderScannerProgress(
      progress,
      scanner.running === true
    );
  }

  function showPendingAutoScan(payload) {
    renderScanner(payload);

    renderDirection('NO TRADE');

    setText('resultPair', 'AI SELECTING...');
    setText('evidenceScore', '—');
    setText('signalStatus', 'SCANNING');

    setText(
      'signalReason',
      'AI is scanning the six priority pairs. No signal has been confirmed.'
    );

    setText(
      'signalWarning',
      'NO TRADE until a fresh, qualified priority pair is selected and broker price validation passes.'
    );

    setVisible('brokerPriceSection', false);
    setVisible('confirmSignalButton', false);
    clearBrokerPrice({ hide: true });
  }

  async function refreshScanner(force = false) {
    if (state.scanBusy) return;

    state.scanBusy = true;

    setButtonBusy(
      dom.refreshScannerButton,
      true,
      'SCANNING...',
      'REFRESH SCANNER'
    );

    try {
      const payload = await requestJson('/api/scan', {
        method: 'POST',
        body: { force }
      });

      renderScanner(payload);

      showMessage(
        first(
          payload.message,
          'Scanner request accepted. Results will appear as pairs are scanned.'
        )
      );

      startScannerPolling();
    } catch (error) {
      if (error.status === 409 || error.status === 429) {
        showMessage(
          `Scanner not started: ${error.message}`,
          'warning'
        );

        try {
          const status = await requestJson('/api/scanner/status');
          renderScanner({
            scanner: status.scanner,
            rankedCandidates: []
          });

          if (status.scanner?.running) {
            startScannerPolling();
          }
        } catch {
          // The original scanner error remains visible.
        }
      } else {
        showMessage(`Scanner error: ${error.message}`, 'error');
      }
    } finally {
      state.scanBusy = false;

      setButtonBusy(
        dom.refreshScannerButton,
        false,
        'SCANNING...',
        'REFRESH SCANNER'
      );
    }
  }

  async function pollScanner() {
    if (state.destroyed) return;

    try {
      const payload = await requestJson('/api/best', {
        timeout: CONFIG.HEALTH_TIMEOUT_MS
      });

      renderScanner(payload);

      const market = getMarketFromPayload(payload);
      const pair = normalizePair(first(
        payload.selectedPair,
        market.pair,
        ''
      ));

      const selectedIsAuto =
        String(dom.pairSelect?.value || AUTO_PAIR).toUpperCase() ===
        AUTO_PAIR.toUpperCase();

      if (
        selectedIsAuto &&
        pair &&
        validPair(pair) &&
        isFresh(market) &&
        market.qualified === true
      ) {
        if (
          state.selectedPair !== pair ||
          state.lastMarket?.pair !== pair
        ) {
          renderMarket(payload, pair);
          showMessage(
            `AI selected ${pair}. Enter its current Pocket Option price.`
          );
        }
      } else if (!pair || !validPair(pair)) {
        const scanner = obj(payload.scanner);

        if (scanner.running) {
          setText('scannerStatus', 'Scanning priority pairs...');
        } else if (!state.lastMarket) {
          setText('scannerStatus', 'No qualified priority pair yet');
        }
      }

      const running = payload.scanner?.running === true;

      if (!running) {
        stopScannerPolling();
      }
    } catch (error) {
      setText('scannerStatus', `Scanner update failed: ${error.message}`);
    }
  }

  function startScannerPolling() {
    stopScannerPolling();

    state.scanTimer = setInterval(
      pollScanner,
      CONFIG.SCAN_POLL_INTERVAL_MS
    );

    pollScanner();
  }

  function stopScannerPolling() {
    if (state.scanTimer) {
      clearInterval(state.scanTimer);
      state.scanTimer = null;
    }
  }

  /* -------------------------------------------------------
     ANALYZE — AUTO OR MANUAL PAIR
  ------------------------------------------------------- */

  async function analyzeSelectedPair() {
    if (state.analysisBusy || state.confirmationBusy) return;

    const selected = normalizePair(
      dom.pairSelect?.value || AUTO_PAIR
    );

    const autoMode =
      selected === normalizePair(AUTO_PAIR) ||
      selected === 'AUTO';

    state.selectedMode = autoMode ? 'AUTO' : 'MANUAL';
    state.autoSelecting = autoMode;

    if (!autoMode && !validPair(selected)) {
      showMessage('Please select a supported live forex pair.', 'error');
      return;
    }

    state.analysisBusy = true;

    setButtonBusy(
      dom.analyzeButton,
      true,
      'ANALYZING...',
      'ANALYZE'
    );

    state.lastMarket = null;
    state.awaitingBrokerPrice = false;

    clearBrokerPrice({ hide: true });
    invalidateCurrentSignal('Analysis is running. No signal is confirmed.');

    try {
      if (autoMode) {
        showMessage(
          'AUTO SELECT is checking fresh priority-pair results...'
        );

        const payload = await requestJson('/api/analyze');

        renderScanner(payload);

        const market = getMarketFromPayload(payload);
        const pair = normalizePair(first(
          payload.selectedPair,
          market.pair,
          ''
        ));

        if (
          pair &&
          validPair(pair) &&
          isFresh(market) &&
          market.qualified === true
        ) {
          renderMarket(payload, pair);

          showMessage(
            `AI selected ${pair}. Enter the current Pocket Option price for validation.`
          );
        } else {
          showPendingAutoScan(payload);

          const running = payload.scanner?.running === true;

          showMessage(
            running
              ? 'Priority scanner is running. Waiting for a qualified pair.'
              : 'No fresh qualified priority pair is available yet. Scanner may need to complete.'
          );

          if (running) {
            startScannerPolling();
          }
        }
      } else {
        state.selectedPair = selected;

        showMessage(
          `Fetching fresh live market data for ${selected}...`
        );

        /*
         * Manual pair selection requests a fresh provider scan.
         * It does not treat old cached data as a fresh analysis.
         */
        const payload = await requestJson('/api/scan/pair', {
          method: 'POST',
          body: { pair: selected }
        });

        const market = obj(payload.market);

        if (!Object.keys(market).length) {
          throw new Error('No market result was returned for this pair.');
        }

        renderMarket(payload, selected);

        if (!isFresh(market)) {
          showMessage(
            `${selected}: market data is not fresh enough. NO TRADE.`,
            'warning'
          );
        } else {
          showMessage(
            `${selected} analysis completed. Enter the matching Pocket Option price.`
          );
        }

        try {
          const scannerPayload = await requestJson('/api/markets');
          renderScanner(scannerPayload);
        } catch {
          // Scanner display is supplementary to manual analysis.
        }
      }
    } catch (error) {
      invalidateCurrentSignal(
        `NO TRADE — analysis failed: ${error.message}`
      );

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

  /* -------------------------------------------------------
     CONFIRM SIGNAL — FRESH BACKEND VALIDATION
  ------------------------------------------------------- */

  async function confirmSignal() {
    if (state.confirmationBusy) return;

    const pair = normalizePair(state.selectedPair);
    const brokerPrice = number(state.brokerPrice);
    const capturedAt = state.brokerPriceCapturedAt;

    if (!validPair(pair)) {
      showMessage('No valid pair is selected.', 'error');
      return;
    }

    if (!state.lastMarket || !isFresh(state.lastMarket)) {
      invalidateCurrentSignal(
        'NO TRADE — market data is not fresh.'
      );

      showMessage(
        'Market data is not fresh. Analyze the pair again.',
        'error'
      );

      return;
    }

    if (
      brokerPrice === null ||
      brokerPrice <= 0 ||
      capturedAt === null
    ) {
      showMessage(
        'Enter a valid Pocket Option price before confirming.',
        'error'
      );

      return;
    }

    const quoteAge = Date.now() - capturedAt;

    if (
      quoteAge < 0 ||
      quoteAge > CONFIG.MAX_BROKER_PRICE_AGE_SECONDS * 1000
    ) {
      setText(
        'brokerPriceStatus',
        'PRICE EXPIRED — ENTER THE CURRENT PRICE AGAIN'
      );

      showMessage(
        'The entered Pocket Option price is older than 30 seconds. Enter it again.',
        'error'
      );

      if (dom.confirmSignalButton) {
        dom.confirmSignalButton.disabled = true;
      }

      return;
    }

    /*
     * Capture these exact values before starting the request.
     * Never replace capturedAt with Date.now() here.
     */
    const capturedPrice = brokerPrice;
    const capturedTimestamp = capturedAt;

    state.confirmationBusy = true;

    setButtonBusy(
      dom.confirmSignalButton,
      true,
      'VALIDATING...',
      'CONFIRM SIGNAL'
    );

    renderDirection('NO TRADE');
    setText('signalStatus', 'VALIDATING BROKER PRICE');

    setText(
      'brokerPriceStatus',
      'CHECKING POCKET OPTION PRICE AGAINST FRESH LIVE REFERENCE...'
    );

    setText(
      'brokerPriceTimestamp',
      formatDate(capturedTimestamp)
    );

    showMessage(
      'Backend is fetching fresh Twelve Data before validating your broker price. Please wait.'
    );

    try {
      const payload = await requestJson('/api/confirm-signal', {
        method: 'POST',
        timeout: CONFIG.REQUEST_TIMEOUT_MS,
        body: {
          pair,
          brokerPrice: capturedPrice,
          brokerPriceCapturedAt: new Date(capturedTimestamp).toISOString(),
          expiryMinutes: CONFIG.LIVE_EXPIRY_MINUTES,
          mode: state.selectedMode || 'MANUAL',
          source: 'USER_ENTERED_POCKET_OPTION_PRICE'
        }
      });

      const result = renderConfirmedSignal(payload, pair);

      if (result.allowed) {
        showMessage(
          `${result.direction} confirmed for ${pair}. Live expiry: 1 minute.`,
          'success'
        );

        await loadHistory();
      } else {
        showMessage(
          'NO TRADE — backend validation did not approve this signal.',
          'warning'
        );
      }
    } catch (error) {
      const reason = error.message || 'Confirmation failed';

      invalidateCurrentSignal(
        `NO TRADE — ${reason}`
      );

      setText(
        'brokerPriceStatus',
        `VALIDATION FAILED: ${reason}`
      );

      showMessage(
        `Signal not confirmed: ${reason}. No BUY/SELL should be executed.`,
        'error'
      );

      if (
        error.payload &&
        error.payload.market
      ) {
        const failedMarket = error.payload.market;

        state.lastMarket = failedMarket;
        renderTechnical(failedMarket);
      }
    } finally {
      state.confirmationBusy = false;

      if (dom.confirmSignalButton) {
        dom.confirmSignalButton.disabled =
          !state.awaitingBrokerPrice ||
          number(state.brokerPrice) === null ||
          state.brokerPriceCapturedAt === null;

        dom.confirmSignalButton.textContent = 'CONFIRM SIGNAL';
      }
    }
  }

  /* -------------------------------------------------------
     HISTORY
  ------------------------------------------------------- */

  function renderHistory(payload) {
    const root = obj(payload);

    const records = Array.isArray(root.history)
      ? root.history
      : [];

    const body = $('historyTableBody');

    if (!body) return;

    body.replaceChildren();

    const total = records.length;

    const evaluated = records.filter(record =>
      ['WIN', 'LOSS', 'TIE'].includes(
        String(record.outcome || '').toUpperCase()
      )
    ).length;

    const pending = records.filter(record =>
      String(record.outcome || 'PENDING').toUpperCase() === 'PENDING'
    ).length;

    setText('historyTotal', total);
    setText('historyEvaluated', evaluated);
    setText('historyPending', pending);

    setText(
      'historySource',
      root.persistent === true ? 'POSTGRESQL' : 'MEMORY ONLY'
    );

    if (!records.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');

      cell.colSpan = 7;
      cell.className = 'empty-state';
      cell.textContent = 'No signal history is available yet.';

      row.appendChild(cell);
      body.appendChild(row);

      return;
    }

    for (const record of records) {
      const row = document.createElement('tr');

      const values = [
        first(record.pair, '—'),
        first(record.direction, record.signal, '—'),
        formatNumber(record.entryPrice),
        formatDate(record.entryTime),
        formatDate(record.expiryTime),
        first(record.outcome, 'PENDING'),
        number(record.evidenceScore) === null
          ? '—'
          : `${formatNumber(record.evidenceScore, 0)}/100`
      ];

      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        row.appendChild(cell);
      }

      body.appendChild(row);
    }
  }

  async function loadHistory() {
    if (state.historyBusy) return;

    state.historyBusy = true;

    setButtonBusy(
      dom.refreshHistoryButton,
      true,
      'LOADING...',
      'REFRESH HISTORY'
    );

    try {
      const payload = await requestJson(
        `/api/history?limit=${CONFIG.MAX_HISTORY}`
      );

      renderHistory(payload);
    } catch (error) {
      showMessage(
        `Could not load signal history: ${error.message}`,
        'error'
      );
    } finally {
      state.historyBusy = false;

      setButtonBusy(
        dom.refreshHistoryButton,
        false,
        'LOADING...',
        'REFRESH HISTORY'
      );
    }
  }

  /* -------------------------------------------------------
     BACKTEST
  ------------------------------------------------------- */

  function renderBacktest(payload) {
    const root = obj(payload);
    const result = obj(root.result);
    const development = obj(result.development);
    const holdout = obj(result.holdout);

    setText(
      'backtestSamples',
      first(holdout.signals, '—')
    );

    setText(
      'backtestWins',
      first(holdout.hits, '—')
    );

    setText(
      'backtestLosses',
      first(holdout.losses, '—')
    );

    setText(
      'backtestCoverage',
      result.coveragePercent === undefined
        ? '—'
        : `${formatNumber(result.coveragePercent, 2)}%`
    );

    setText(
      'backtestWinRate',
      holdout.hitRate === null ||
      holdout.hitRate === undefined
        ? '—'
        : `${formatNumber(holdout.hitRate, 2)}%`
    );

    setText(
      'backtestBaseline',
      holdout.baselinePercent === null ||
      holdout.baselinePercent === undefined
        ? '—'
        : `${formatNumber(holdout.baselinePercent, 2)}%`
    );

    const pair = first(root.pair, dom.backtestPairSelect?.value, '—');
    const expiry = first(
      result.expiryMinutes,
      dom.backtestDuration?.value,
      '—'
    );

    setText(
      'backtestMessage',
      [
        `${pair} · ${expiry} minute(s).`,
        first(result.method, 'Walk-forward chronological holdout.'),
        first(result.conclusion, 'No performance conclusion available.'),
        `Development sample: ${first(development.signals, 0)}.`,
        'Historical results are not a guarantee of future performance.',
        'Backtest does not model Pocket Option spread, payout, slippage or broker-price validation.'
      ].join(' ')
    );
  }

  async function runBacktest() {
    if (state.backtestBusy) return;

    const pair = normalizePair(
      dom.backtestPairSelect?.value ||
      dom.pairSelect?.value ||
      ''
    );

    const expiry = Number(
      dom.backtestDuration?.value || 1
    );

    if (!validPair(pair)) {
      setText(
        'backtestMessage',
        'Select a valid live forex pair.'
      );
      return;
    }

    if (![1, 2, 3].includes(expiry)) {
      setText(
        'backtestMessage',
        'Backtest duration must be 1, 2 or 3 minutes.'
      );
      return;
    }

    state.backtestBusy = true;

    setButtonBusy(
      dom.runBacktestButton,
      true,
      'RUNNING...',
      'RUN BACKTEST'
    );

    setText(
      'backtestMessage',
      `Running ${expiry}-minute walk-forward backtest for ${pair}...`
    );

    try {
      const query = new URLSearchParams({
        pair,
        expiry: String(expiry)
      });

      const payload = await requestJson(
        `/api/backtest?${query.toString()}`
      );

      if (payload.ok !== true || !payload.result) {
        throw new Error(
          first(payload.reason, 'Backtest did not return a result.')
        );
      }

      renderBacktest(payload);
    } catch (error) {
      setText(
        'backtestMessage',
        `Backtest unavailable: ${error.message}`
      );
    } finally {
      state.backtestBusy = false;

      setButtonBusy(
        dom.runBacktestButton,
        false,
        'RUNNING...',
        'RUN BACKTEST'
      );
    }
  }

  /* -------------------------------------------------------
     PAIR SELECTION
  ------------------------------------------------------- */

  function handlePairChange() {
    const selected = normalizePair(
      dom.pairSelect?.value || AUTO_PAIR
    );

    state.selectedMode =
      selected === normalizePair(AUTO_PAIR) || selected === 'AUTO'
        ? 'AUTO'
        : 'MANUAL';

    state.lastMarket = null;
    state.lastConfirmedSignal = null;
    state.awaitingBrokerPrice = false;

    clearBrokerPrice({ hide: true });

    invalidateCurrentSignal(
      'Pair selection changed. Analyze the new selection before entering a broker price.'
    );

    setText('resultPair', 'WAITING FOR ANALYSIS');
    setText('analysisTimestamp', 'Not analyzed');
    setText('marketFreshness', 'NOT CHECKED');
    setText('marketFreshnessDetail', 'Analyze to fetch fresh market data');

    if (dom.brokerPriceInput) {
      dom.brokerPriceInput.value = '';
      dom.brokerPriceInput.disabled = true;
    }
  }

  /* -------------------------------------------------------
     EVENT LISTENERS
  ------------------------------------------------------- */

  function attachEvents() {
    if (dom.analyzeButton) {
      dom.analyzeButton.addEventListener(
        'click',
        analyzeSelectedPair
      );
    }

    if (dom.refreshScannerButton) {
      dom.refreshScannerButton.addEventListener(
        'click',
        () => refreshScanner(true)
      );
    }

    if (dom.confirmSignalButton) {
      dom.confirmSignalButton.addEventListener(
        'click',
        confirmSignal
      );
    }

    if (dom.refreshHistoryButton) {
      dom.refreshHistoryButton.addEventListener(
        'click',
        loadHistory
      );
    }

    if (dom.runBacktestButton) {
      dom.runBacktestButton.addEventListener(
        'click',
        runBacktest
      );
    }

    if (dom.pairSelect) {
      dom.pairSelect.addEventListener(
        'change',
        handlePairChange
      );
    }

    if (dom.backtestPairSelect) {
      dom.backtestPairSelect.addEventListener(
        'change',
        () => {
          setText(
            'backtestMessage',
            'Pair changed. Run the backtest again to update results.'
          );
        }
      );
    }

    if (dom.expirySelect) {
      dom.expirySelect.value = '1';
      dom.expirySelect.disabled = true;
    }

    attachBrokerPriceListeners();
  }

  /* -------------------------------------------------------
     INITIALIZATION
  ------------------------------------------------------- */

  async function initialize() {
    attachEvents();

    renderDirection('NO TRADE');

    setText('signalStatus', 'WAITING FOR ANALYSIS');
    setText('resultPair', 'WAITING FOR ANALYSIS');
    setText('signalDuration', '1 minute');

    setVisible('brokerPriceSection', false);
    setVisible('confirmSignalButton', false);

    if (dom.brokerPriceInput) {
      dom.brokerPriceInput.disabled = true;
    }

    await checkHealth();

    state.healthTimer = setInterval(
      checkHealth,
      CONFIG.HEALTH_INTERVAL_MS
    );

    await loadHistory();

    /*
     * Initial scanner status is read without forcing another
     * provider scan. Backend manages its own scan schedule.
     */
    try {
      const status = await requestJson('/api/status');

      const scanner = obj(status.scanner);

      renderScanner({
        scanner,
        rankedCandidates: []
      });

      if (scanner.running) {
        startScannerPolling();
      }
    } catch (error) {
      setText(
        'scannerStatus',
        `Scanner status unavailable: ${error.message}`
      );
    }

    /*
     * Keep all initial states safe. No automatic BUY/SELL signal
     * is shown before a user requests analysis and validates price.
     */
    showMessage(
      'Ready. Select AI AUTO SELECT or a live forex pair, then press ANALYZE.'
    );
  }

  function cleanup() {
    state.destroyed = true;

    if (state.healthTimer) {
      clearInterval(state.healthTimer);
      state.healthTimer = null;
    }

    stopScannerPolling();
  }

  window.addEventListener('beforeunload', cleanup);

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }

})();
