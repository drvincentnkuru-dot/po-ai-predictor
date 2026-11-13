
'use strict';

/*
 * PO AI PREDICTOR — V10.6.0
 * LIVE FOREX ONLY — OTC is not supported.
 *
 * Frontend:
 * - 24-pair scanner: 6 priority + 18 background pairs.
 * - AUTO SELECT uses eligible results from all 24 pairs.
 * - EMA / price-action evidence is displayed without RSI or 5m.
 * - Evidence score is evidence strength, NOT win probability.
 * - BUY/SELL is displayed only after broker-price validation.
 * - Pocket Option price timestamp is captured on every input edit.
 * - Live expiry is fixed at 1 minute.
 * - Backtest expiry options: 1, 2 and 3 minutes.
 */

(() => {
  const API_BASE = String(
    window.PO_API_BASE ||
    'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const VERSION = 'V10.6.0';
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
    PRIORITY_COUNT: 6,
    BACKGROUND_COUNT: 18
  });

  const PRIORITY_PAIRS = Object.freeze([
    'EUR/USD',
    'GBP/USD',
    'USD/JPY',
    'USD/CHF',
    'AUD/USD',
    'USD/CAD'
  ]);

  const BACKGROUND_PAIRS = Object.freeze([
    'NZD/USD',
    'EUR/GBP',
    'EUR/JPY',
    'GBP/JPY',
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

    return Number.isFinite(parsed) ? parsed : null;
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

  function normalizePair(pair) {
    return String(pair || '').trim().toUpperCase();
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

  function isFresh(market) {
    const data = obj(market);
    const age = number(data.dataAgeSeconds);

    return (
      String(data.freshness || '').toUpperCase() === 'FRESH' &&
      age !== null &&
      age >= 0 &&
      age <= CONFIG.MAX_DATA_AGE_SECONDS &&
      number(data.currentPrice) > 0 &&
      data.insufficientData !== true &&
      data.noTrade !== true
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
    const data = obj(market);
    const signalObject = obj(data.signal);

    const raw = String(
      typeof data.signal === 'string'
        ? data.signal
        : first(
            signalObject.action,
            signalObject.direction,
            data.action,
            data.direction,
            'NO TRADE'
          )
    ).toUpperCase().trim();

    if (
      data.noTrade === true ||
      data.tradeAllowed !== true ||
      data.insufficientData === true ||
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

  function getEvidenceScore(market) {
    const data = obj(market);

    return number(first(
      data.evidenceScore,
      data.confidence,
      data.score
    ));
  }

  function getAllProgress(progress) {
    const data = obj(progress);

    const explicitCompleted = number(data.completed);
    const priorityCompleted = number(data.priorityCompleted) || 0;
    const backgroundCompleted = number(data.backgroundCompleted) || 0;

    const completed = explicitCompleted !== null
      ? explicitCompleted
      : priorityCompleted + backgroundCompleted;

    const explicitTotal = number(data.total);

    const total = explicitTotal !== null
      ? explicitTotal
      : CONFIG.TOTAL_PAIRS;

    return {
      completed: Math.max(0, Math.min(CONFIG.TOTAL_PAIRS, completed)),
      total: CONFIG.TOTAL_PAIRS,
      priorityCompleted: Math.max(
        0,
        Math.min(CONFIG.PRIORITY_COUNT, priorityCompleted)
      ),
      backgroundCompleted: Math.max(
        0,
        Math.min(CONFIG.BACKGROUND_COUNT, backgroundCompleted)
      ),
      pair: data.pair || null,
      phase: data.phase || null
    };
  }

  /* =======================================================
     REMOVE OBSOLETE RSI AND 5-MINUTE UI ELEMENTS
  ======================================================= */

  function hideObsoleteCard(id) {
    const node = $(id);

    if (!node) return;

    const wrapper = node.closest(
      '.technical-card, .indicator-card, .metric-card, .stat-card, .card'
    );

    if (wrapper) {
      wrapper.hidden = true;
    } else {
      node.hidden = true;
    }
  }

  function hideObsoleteInterface() {
    const obsoleteIds = [
      'rsiValue',
      'rsiSignal',
      'rsiDivergence',
      'rsiDivergenceDetail',
      'fiveMinuteTrend',
      'fiveMinuteDetail'
    ];

    for (const id of obsoleteIds) {
      hideObsoleteCard(id);
    }

    const headings = document.querySelectorAll(
      'th, .timeframe-tag, .timeframe-label'
    );

    for (const node of headings) {
      const text = String(node.textContent || '')
        .trim()
        .toUpperCase();

      if (
        text === '5M' ||
        text === '5 MIN' ||
        text === '5 MINUTES' ||
        text.includes('5-MINUTE') ||
        text.includes('5 MINUTE')
      ) {
        node.hidden = true;
      }
    }

    const descriptions = document.querySelectorAll(
      'p, small, .section-description, .scanner-description'
    );

    for (const node of descriptions) {
      const text = String(node.textContent || '');

      if (
        /first six priority pairs/i.test(text) ||
        /six priority pairs/i.test(text) ||
        /1-minute and 5-minute/i.test(text) ||
        /5-minute trend confirmation/i.test(text)
      ) {
        node.textContent =
          'The scanner processes six priority pairs first, then eighteen background pairs. AUTO SELECT ranks fresh eligible results from all 24 pairs.';
      }
    }

    const progress = $('scannerProgress');

    if (progress && /priority pairs/i.test(progress.textContent)) {
      progress.textContent = '0 / 24 pairs';
    }
  }

  /* =======================================================
     API REQUESTS
  ======================================================= */

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

  /* =======================================================
     SCANNER PROGRESS
  ======================================================= */

  function renderScannerProgress(progress, running) {
    const data = getAllProgress(progress);

    const percent = data.total > 0
      ? Math.max(
          0,
          Math.min(100, data.completed / data.total * 100)
        )
      : 0;

    const bar = $('scannerProgressBar');

    if (bar) {
      bar.style.width = `${percent}%`;
    }

    setText(
      'scannerProgress',
      `${data.completed} / ${CONFIG.TOTAL_PAIRS} pairs`
    );

    const priorityText =
      `${data.priorityCompleted}/${CONFIG.PRIORITY_COUNT} priority`;

    const backgroundText =
      `${data.backgroundCompleted}/${CONFIG.BACKGROUND_COUNT} background`;

    let status;

    if (running) {
      status = data.pair
        ? `Scanning ${data.pair} · ${priorityText} · ${backgroundText}`
        : `Scanning 24 pairs · ${priorityText} · ${backgroundText}`;
    } else if (data.completed >= CONFIG.TOTAL_PAIRS) {
      status = '24-pair scan completed';
    } else if (data.completed > 0) {
      status = `${data.phase || 'Scanner paused'} · ${priorityText} · ${backgroundText}`;
    } else {
      status = data.phase || 'Waiting for scanner';
    }

    setText('scannerStatus', status);
  }

  /* =======================================================
     HEALTH AND PROVIDER STATUS
  ======================================================= */

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

    setText('pairsTracked', CONFIG.TOTAL_PAIRS);

    renderScannerProgress(
      root.scanProgress || root.scanner?.progress,
      root.scannerRunning === true ||
      root.scanner?.running === true
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

  /* =======================================================
     SIGNAL DISPLAY
  ======================================================= */

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

    target.appendChild(
      document.createTextNode('Analysis notes: ')
    );

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

  /* =======================================================
     TECHNICAL INDICATORS — NO RSI / NO 5M
  ======================================================= */

  function renderTechnical(market) {
    const data = obj(market);
    const indicators = obj(data.indicators);
    const macd = obj(indicators.macd);
    const bollinger = obj(indicators.bollinger);
    const volatility = obj(data.volatility);
    const levels = obj(data.supportResistance);
    const trendline = obj(data.trendLine);
    const breakout = obj(data.breakout);
    const pattern = obj(data.candlePattern);
    const psychology = obj(data.marketPsychology);
    const ema = obj(data.ema);

    setText(
      'emaSignal',
      first(
        indicators.emaCross,
        ema.cross,
        data.emaCross,
        'UNAVAILABLE'
      )
    );

    setText(
      'emaDetail',
      `EMA 9: ${formatNumber(first(indicators.ema9, ema.ema9))} · EMA 21: ${formatNumber(first(indicators.ema21, ema.ema21))}`
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
      'atrValue',
      formatNumber(first(indicators.atr14, data.atr14), 7)
    );

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
      typeof data.marketPsychology === 'string'
        ? data.marketPsychology
        : first(psychology.psychology, 'UNAVAILABLE')
    );

    setText(
      'psychologyDetail',
      first(psychology.direction, 'Price pressure interpretation')
    );

    setText(
      'supportLevel',
      formatNumber(levels.support)
    );

    setText(
      'supportDetail',
      first(levels.position, 'Support assessment unavailable')
    );

    setText(
      'resistanceLevel',
      formatNumber(levels.resistance)
    );

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

    hideObsoleteInterface();
  }

  /* =======================================================
     POCKET OPTION PRICE CAPTURE
  ======================================================= */

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

    const raw = String(dom.brokerPriceInput.value || '');
    const parsed = number(raw);

    /*
     * IMPORTANT:
     * Capture the timestamp when the user types, pastes or edits
     * the price. Never generate this timestamp on CONFIRM.
     */
    if (
      raw.trim() === '' ||
      parsed === null ||
      parsed <= 0
    ) {
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

    setText(
      'brokerPriceStatus',
      'PRICE CAPTURED — READY TO VALIDATE'
    );

    setText(
      'brokerPriceTimestamp',
      formatDate(capturedAt)
    );

    if (dom.confirmSignalButton) {
      dom.confirmSignalButton.disabled =
        !state.awaitingBrokerPrice ||
        state.confirmationBusy;
    }
  }

  function attachBrokerPriceListeners() {
    if (!dom.brokerPriceInput) return;

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

  /* =======================================================
     MARKET ANALYSIS DISPLAY
  ======================================================= */

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
      throw new Error(
        'The API returned an unsupported forex pair.'
      );
    }

    if (
      expectedPair &&
      pair !== normalizePair(expectedPair)
    ) {
      throw new Error(
        `Pair mismatch. Requested ${expectedPair}, received ${pair}.`
      );
    }

    state.lastMarket = market;

    if (pair) {
      state.selectedPair = pair;
    }

    const fresh = isFresh(market);
    const evidence = getEvidenceScore(market);

    /*
     * Research analysis does not confirm a trade.
     * BUY/SELL remains hidden until broker validation succeeds.
     */
    renderDirection('NO TRADE');

    setText(
      'resultPair',
      pair || 'NO QUALIFIED PAIR'
    );

    setText(
      'analysisTimestamp',
      formatDate(first(market.fetchedAt, market.lastCandle))
    );

    setText(
      'evidenceScore',
      evidence === null ? '—' : Math.round(evidence)
    );

    setText(
      'evidenceLabel',
      first(
        market.evidenceLabel,
        evidence === null
          ? 'INSUFFICIENT'
          : evidence >= 75
            ? 'STRONG EVIDENCE'
            : evidence >= 55
              ? 'MODERATE EVIDENCE'
              : 'INSUFFICIENT EVIDENCE'
      )
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

    setText(
      'signalStatus',
      fresh ? 'WAITING FOR BROKER PRICE' : 'NO TRADE'
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
        : `Last completed candle age: ${formatNumber(market.dataAgeSeconds, 1)} seconds`
    );

    setText(
      'signalWarning',
      fresh
        ? 'Evidence score is not win probability. No BUY/SELL is confirmed until Pocket Option price validation passes.'
        : 'NO TRADE: market data is stale, incomplete or unavailable.'
    );

    renderTechnical(market);
    renderReasons(market.reasons);

    state.awaitingBrokerPrice = fresh && Boolean(pair);

    setVisible(
      'brokerPriceSection',
      state.awaitingBrokerPrice
    );

    setVisible(
      'confirmSignalButton',
      state.awaitingBrokerPrice
    );

    setText(
      'brokerSelectedPair',
      pair || 'NO PAIR SELECTED'
    );

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

  /* =======================================================
     CONFIRMED SIGNAL DISPLAY
  ======================================================= */

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
      throw new Error(
        'Confirmed pair does not match selected pair.'
      );
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

    const evidence = number(first(
      root.evidenceScore,
      market.evidenceScore,
      market.confidence
    ));

    setText(
      'evidenceScore',
      evidence === null ? '—' : Math.round(evidence)
    );

    setText(
      'evidenceLabel',
      first(
        market.evidenceLabel,
        evidence === null
          ? 'INSUFFICIENT'
          : evidence >= 75
            ? 'STRONG EVIDENCE'
            : evidence >= 55
              ? 'MODERATE EVIDENCE'
              : 'INSUFFICIENT EVIDENCE'
      )
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
      brokerValidated
        ? 'PRICE VALIDATED'
        : 'PRICE NOT VALIDATED'
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

    return {
      allowed,
      direction,
      market
    };
  }

  /* =======================================================
     SCANNER TABLE — NO 5M COLUMN
  ======================================================= */

  function renderScanner(payload) {
    const root = obj(payload);
    const scanner = obj(root.scanner);
    const progress = obj(
      first(scanner.progress, root.scanProgress, {})
    );

    state.lastScanner = root;

    /*
     * Backend returns rankedCandidates from the full 24-pair
     * result set. The frontend does not truncate to six pairs.
     */
    const candidates = Array.isArray(root.rankedCandidates)
      ? root.rankedCandidates
      : Array.isArray(scanner.rankedCandidates)
        ? scanner.rankedCandidates
        : [];

    const body = $('scannerTableBody');

    if (!body) {
      renderScannerProgress(progress, scanner.running === true);
      return;
    }

    body.replaceChildren();

    const validCandidates = candidates
      .filter(candidate => validPair(candidate.pair))
      .sort((a, b) => {
        const scoreA = number(first(
          a.evidenceScore,
          a.confidence,
          a.score
        )) || 0;

        const scoreB = number(first(
          b.evidenceScore,
          b.confidence,
          b.score
        )) || 0;

        return scoreB - scoreA;
      });

    if (!validCandidates.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');

      cell.colSpan = 7;
      cell.className = 'empty-state';

      cell.textContent = scanner.running
        ? 'Scanner running. Waiting for fresh pair results.'
        : 'No fresh scanned pair results are available yet.';

      row.appendChild(cell);
      body.appendChild(row);
    } else {
      for (const candidate of validCandidates) {
        const pair = normalizePair(candidate.pair);
        const row = document.createElement('tr');

        const freshness = String(
          first(candidate.freshness, 'UNKNOWN')
        ).toUpperCase();

        const evidence = number(first(
          candidate.evidenceScore,
          candidate.confidence,
          candidate.score
        ));

        const eligible =
          freshness === 'FRESH' &&
          candidate.qualified === true &&
          candidate.tradeAllowed !== false &&
          candidate.noTrade !== true;

        const values = [
          pair,
          formatNumber(candidate.currentPrice),
          first(
            candidate.oneMinuteTrend,
            candidate.trend,
            '—'
          ),
          first(candidate.volatility, '—'),
          evidence === null
            ? '—'
            : `${formatNumber(evidence, 0)}/100`,
          freshness === 'FRESH'
            ? (eligible ? 'ELIGIBLE' : 'WAITING / NO TRADE')
            : 'STALE',
          eligible ? 'READY FOR PRICE CHECK' : 'NO TRADE'
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

    /*
     * Existing HTML may have eight columns because it previously
     * included 5M confirmation. Hide the obsolete 5M heading.
     */
    hideObsoleteInterface();

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
    setText('evidenceLabel', 'WAITING FOR EVIDENCE');
    setText('signalStatus', 'SCANNING');

    setText(
      'signalReason',
      'AUTO SELECT is checking fresh eligible results from the 24-pair scanner.'
    );

    setText(
      'signalWarning',
      'NO TRADE until fresh evidence is sufficient and Pocket Option price validation passes.'
    );

    setVisible('brokerPriceSection', false);
    setVisible('confirmSignalButton', false);

    clearBrokerPrice({ hide: true });
  }

  /* =======================================================
     SCANNER REFRESH AND POLLING
  ======================================================= */

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
            rankedCandidates: status.rankedCandidates || []
          });

          if (status.scanner?.running) {
            startScannerPolling();
          }
        } catch {
          // Keep the original scanner error visible.
        }
      } else {
        showMessage(
          `Scanner error: ${error.message}`,
          'error'
        );
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

      const selectedIsAuto = isAutoSelection(
        dom.pairSelect?.value || AUTO_PAIR
      );

      /*
       * AUTO SELECT accepts a result only if the backend has
       * ranked it and marked it qualified and fresh.
       */
      if (
        selectedIsAuto &&
        pair &&
        validPair(pair) &&
        isFresh(market) &&
        market.qualified === true
      ) {
        const sameMarket =
          state.selectedPair === pair &&
          state.lastMarket?.pair === pair;

        if (!sameMarket) {
          renderMarket(payload, pair);

          showMessage(
            `AUTO SELECT chose ${pair} from the available 24-pair results. Enter its current Pocket Option price.`
          );
        }
      } else if (!pair || !validPair(pair)) {
        const scanner = obj(payload.scanner);

        if (scanner.running) {
          setText(
            'scannerStatus',
            'Scanning priority pairs, then background pairs...'
          );
        } else if (!state.lastMarket) {
          setText(
            'scannerStatus',
            'No fresh qualified pair is available yet'
          );
        }
      }

      const running = payload.scanner?.running === true;

      if (!running) {
        stopScannerPolling();
      }
    } catch (error) {
      setText(
        'scannerStatus',
        `Scanner update failed: ${error.message}`
      );
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

  /* =======================================================
     ANALYZE — AUTO SELECT OR MANUAL PAIR
  ======================================================= */

  async function analyzeSelectedPair() {
    if (
      state.analysisBusy ||
      state.confirmationBusy
    ) {
      return;
    }

    const selected = normalizePair(
      dom.pairSelect?.value || AUTO_PAIR
    );

    const autoMode = isAutoSelection(selected);

    state.selectedMode = autoMode ? 'AUTO' : 'MANUAL';

    if (!autoMode && !validPair(selected)) {
      showMessage(
        'Please select a supported live forex pair.',
        'error'
      );

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

    invalidateCurrentSignal(
      'Analysis is running. No signal is confirmed.'
    );

    try {
      if (autoMode) {
        showMessage(
          'AUTO SELECT is evaluating fresh eligible results from all 24 forex pairs.'
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
            `AUTO SELECT selected ${pair}. Enter the current Pocket Option price for validation.`
          );
        } else {
          showPendingAutoScan(payload);

          const running =
            payload.scanner?.running === true;

          showMessage(
            running
              ? 'The 24-pair scanner is running. Waiting for sufficient fresh evidence.'
              : 'No fresh qualified pair is available. Wait for the next completed scan.'
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

        const payload = await requestJson('/api/scan/pair', {
          method: 'POST',
          body: { pair: selected }
        });

        const market = getMarketFromPayload(payload);

        if (!Object.keys(market).length) {
          throw new Error(
            'No market result was returned for this pair.'
          );
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

  /* =======================================================
     CONFIRM SIGNAL — FRESH BACKEND VALIDATION
  ======================================================= */

  async function confirmSignal() {
    if (state.confirmationBusy) return;

    const pair = normalizePair(state.selectedPair);
    const brokerPrice = number(state.brokerPrice);
    const capturedAt = state.brokerPriceCapturedAt;

    if (!validPair(pair)) {
      showMessage(
        'No valid pair is selected.',
        'error'
      );

      return;
    }

    if (
      !state.lastMarket ||
      !isFresh(state.lastMarket)
    ) {
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
     * Preserve the exact price and input timestamp.
     * Do not replace capturedAt with Date.now() here.
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

    setText(
      'signalStatus',
      'VALIDATING BROKER PRICE'
    );

    setText(
      'brokerPriceStatus',
      'CHECKING PRICE AGAINST FRESH LIVE REFERENCE...'
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
          brokerPriceCapturedAt: new Date(
            capturedTimestamp
          ).toISOString(),
          expiryMinutes: CONFIG.LIVE_EXPIRY_MINUTES,
          mode: state.selectedMode || 'MANUAL',
          source: 'USER_ENTERED_POCKET_OPTION_PRICE'
        }
      });

      const result = renderConfirmedSignal(
        payload,
        pair
      );

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
        state.lastMarket = error.payload.market;
        renderTechnical(error.payload.market);
      }
    } finally {
      state.confirmationBusy = false;

      if (dom.confirmSignalButton) {
        dom.confirmSignalButton.disabled =
          !state.awaitingBrokerPrice ||
          number(state.brokerPrice) === null ||
          state.brokerPriceCapturedAt === null;

        dom.confirmSignalButton.textContent =
          'CONFIRM SIGNAL';
      }
    }
  }

  /* =======================================================
     SIGNAL HISTORY
  ======================================================= */

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
      root.persistent === true
        ? 'POSTGRESQL'
        : 'MEMORY ONLY'
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

  /* =======================================================
     WALK-FORWARD BACKTEST
  ======================================================= */

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

    const pair = first(
      root.pair,
      dom.backtestPairSelect?.value,
      '—'
    );

    const expiry = first(
      result.expiryMinutes,
      dom.backtestDuration?.value,
      '—'
    );

    setText(
      'backtestMessage',
      [
        `${pair} · ${expiry} minute(s).`,
        first(
          result.method,
          'Walk-forward chronological holdout.'
        ),
        first(
          result.conclusion,
          'No performance conclusion available.'
        ),
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

      if (
        payload.ok !== true ||
        !payload.result
      ) {
        throw new Error(
          first(
            payload.reason,
            'Backtest did not return a result.'
          )
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

  /* =======================================================
     PAIR SELECTION
  ======================================================= */

  function handlePairChange() {
    const selected = normalizePair(
      dom.pairSelect?.value || AUTO_PAIR
    );

    state.selectedMode = isAutoSelection(selected)
      ? 'AUTO'
      : 'MANUAL';

    state.lastMarket = null;
    state.lastConfirmedSignal = null;
    state.awaitingBrokerPrice = false;

    clearBrokerPrice({ hide: true });

    invalidateCurrentSignal(
      'Pair selection changed. Analyze the new selection before entering a broker price.'
    );

    setText(
      'resultPair',
      'WAITING FOR ANALYSIS'
    );

    setText(
      'analysisTimestamp',
      'Not analyzed'
    );

    setText(
      'marketFreshness',
      'NOT CHECKED'
    );

    setText(
      'marketFreshnessDetail',
      'Analyze to fetch fresh market data'
    );

    if (dom.brokerPriceInput) {
      dom.brokerPriceInput.value = '';
      dom.brokerPriceInput.disabled = true;
    }
  }

  /* =======================================================
     EVENT LISTENERS
  ======================================================= */

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

  /* =======================================================
     INITIALIZATION
  ======================================================= */

  async function initialize() {
    hideObsoleteInterface();
    attachEvents();

    renderDirection('NO TRADE');

    setText(
      'signalStatus',
      'WAITING FOR ANALYSIS'
    );

    setText(
      'resultPair',
      'WAITING FOR ANALYSIS'
    );

    setText(
      'signalDuration',
      '1 minute'
    );

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
     * Read scanner status without forcing another provider scan.
     * The backend controls its own full 24-pair scan schedule.
     */
    try {
      const status = await requestJson('/api/status');

      const scanner = obj(status.scanner);

      renderScanner({
        scanner,
        rankedCandidates:
          status.rankedCandidates || []
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

  window.addEventListener(
    'beforeunload',
    cleanup
  );

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
