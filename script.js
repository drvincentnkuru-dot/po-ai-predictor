
'use strict';

(() => {
  const API_BASE = String(
    window.PO_API_BASE ||
    'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const VERSION = 'V10.3.0';

  const CONFIG = Object.freeze({
    HEALTH_INTERVAL_MS: 60000,
    SCAN_POLL_INTERVAL_MS: 3000,
    REQUEST_TIMEOUT_MS: 35000,
    HEALTH_TIMEOUT_MS: 12000,
    MAX_DATA_AGE_SECONDS: 150,
    MAX_BROKER_PRICE_AGE_SECONDS: 60,
    MAX_REASONS: 10,
    LIVE_EXPIRY_MINUTES: 1,
    INITIAL_PIP_TOLERANCE: 3
  });

  const AUTO_PAIR = 'AI AUTO SELECT';

  const PAIRS = [
    'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF',
    'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP',
    'EUR/JPY', 'GBP/JPY', 'EUR/CHF', 'EUR/AUD',
    'EUR/CAD', 'GBP/CHF', 'GBP/AUD', 'GBP/CAD',
    'AUD/JPY', 'AUD/CAD', 'AUD/NZD', 'CAD/JPY',
    'CHF/JPY', 'NZD/JPY', 'NZD/CAD', 'EUR/NZD'
  ];

  const PRIORITY_PAIRS = [
    'EUR/USD',
    'GBP/USD',
    'USD/JPY',
    'USD/CHF',
    'AUD/USD',
    'USD/CAD'
  ];

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
    backtestBusy: false,
    scanBusy: false,
    healthBusy: false,
    historyBusy: false,

    scanTimer: null,
    healthTimer: null,

    requestId: 0,

    lastMarket: null,
    lastScanner: null,
    lastHealth: null,

    selectedPair: null,
    selectedMode: null,

    brokerPrice: null,
    brokerPriceCapturedAt: null,

    awaitingBrokerPrice: false,
    autoSelecting: false
  };

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

  function setStatusDot(online) {
    const node = $('apiStatusDot');

    if (!node) return;

    node.className = online
      ? 'status-indicator online'
      : 'status-indicator offline';
  }

  function showMessage(message, type = 'info') {
    const node = $('analysisMessage');

    if (!node) return;

    node.textContent = String(message || '');
    node.dataset.type = type;
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

  function setVisible(id, visible) {
    const node = $(id);

    if (!node) return;

    node.hidden = !visible;
  }

  function setInputEnabled(input, enabled) {
    if (!input) return;

    input.disabled = !enabled;
  }

  function clearBrokerPrice() {
    state.brokerPrice = null;
    state.brokerPriceCapturedAt = null;

    if (dom.brokerPriceInput) {
      dom.brokerPriceInput.value = '';
    }

    setText('brokerPriceStatus', 'WAITING FOR POCKET OPTION PRICE');
    setText('brokerPriceReference', '—');
    setText('brokerPriceDifference', '—');
    setText('brokerPriceTimestamp', '—');

    setVisible('brokerPriceSection', false);
    setVisible('confirmSignalButton', false);
  }

  function invalidateCurrentSignal(message) {
    state.lastMarket = null;
    state.awaitingBrokerPrice = false;

    renderDirection('NO TRADE');

    setText('signalStatus', 'NO TRADE');
    setText('signalReason', message);

    const warning = $('signalWarning');

    if (warning) {
      warning.textContent = message;
    }
  }

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
        const error = new Error(
          first(
            payload.error,
            payload.message,
            `Request failed. HTTP ${response.status}.`
          )
        );

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

  function isFresh(market) {
    const age = number(market.dataAgeSeconds);

    const freshness = String(
      first(market.freshness, 'UNKNOWN')
    ).toUpperCase();

    return (
      freshness === 'FRESH' &&
      age !== null &&
      age >= 0 &&
      age <= CONFIG.MAX_DATA_AGE_SECONDS &&
      number(market.currentPrice) > 0 &&
      market.insufficientData !== true
    );
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
      first(root.provider, 'TWELVE DATA LIVE')
    );

    setText(
      'providerDetail',
      configured
        ? 'Twelve Data API key configured'
        : 'Twelve Data API key not configured'
    );

    setText('pairsTracked', PAIRS.length);

    const progress = obj(root.scanProgress);

    renderScannerProgress(
      progress,
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
    if (state.healthBusy) return;

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

  function renderScannerProgress(progress, running) {
    const completed = number(
      first(progress.priorityCompleted, progress.completed)
    ) || 0;

    const total = number(
      first(progress.priorityTotal, progress.total)
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
        ? `Scanning ${first(progress.pair, 'priority pairs')}...`
        : first(progress.phase, 'Scanner idle')
    );
  }

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
        '5-minute confirmation unavailable'
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
        : 'No false breakout detected by current analysis'
    );
  }

  function renderReasons(reasons) {
    const items = Array.isArray(reasons)
      ? reasons.filter(Boolean).slice(0, CONFIG.MAX_REASONS)
      : [];

    if (!items.length) {
      items.push('No additional decision reasons were supplied.');
    }

    const list = document.createElement('ul');

    list.className = 'reason-list';

    for (const reason of items) {
      const item = document.createElement('li');

      item.textContent = String(reason);

      list.appendChild(item);
    }

    const target = $('analysisMessage');

    if (!target) return;

    target.replaceChildren(
      document.createTextNode('Analysis notes: '),
      list
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

  function renderMarket(payload, expectedPair) {
    const root = obj(payload);
    const market = getMarketFromPayload(root);

    if (!Object.keys(market).length) {
      throw new Error(
        'The API did not return a selected market result.'
      );
    }

    const pair = String(first(
      market.pair,
      root.selectedPair,
      expectedPair,
      'UNKNOWN'
    )).toUpperCase();

    if (expectedPair && pair !== expectedPair.toUpperCase()) {
      throw new Error(
        `Pair mismatch. Requested ${expectedPair}, received ${pair}.`
      );
    }

    if (!PAIRS.includes(pair)) {
      throw new Error('The API returned an unsupported forex pair.');
    }

    state.lastMarket = market;
    state.selectedPair = pair;

    const fresh = isFresh(market);

    /*
     * Before Pocket Option price validation, BUY/SELL is never
     * presented as an executable or confirmed signal.
     */
    const direction = 'NO TRADE';

    renderDirection(direction);

    setText('resultPair', pair);

    setText(
      'analysisTimestamp',
      formatDate(first(market.fetchedAt, market.lastCandle))
    );

    const evidence = number(market.confidence);

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
        ? 'NO TRADE — market data is stale or freshness cannot be verified.'
        : 'Market analysis completed. Enter the matching Pocket Option price to request final validation.'
    );

    setText('entryTime', 'WAITING FOR CONFIRMATION');
    setText('expiryTime', 'WAITING FOR CONFIRMATION');
    setText('entryPrice', 'WAITING FOR POCKET OPTION PRICE');
    setText('signalDuration', '1 minute');
    setText('signalStatus', 'WAITING FOR BROKER PRICE');

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

    const warning = $('signalWarning');

    if (warning) {
      warning.textContent = fresh
        ? 'Research scan completed. No BUY/SELL signal is confirmed until the Pocket Option price is validated.'
        : 'NO TRADE: market data is stale or cannot be verified.';
    }

    renderTechnical(market);
    renderReasons(market.reasons);

    state.awaitingBrokerPrice = fresh;

    setVisible('brokerPriceSection', fresh);
    setVisible('confirmSignalButton', fresh);

    setInputEnabled(dom.brokerPriceInput, fresh);

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

  function renderConfirmedSignal(payload, expectedPair) {
    const root = obj(payload);
    const market = getMarketFromPayload(root);

    if (!Object.keys(market).length) {
      throw new Error(
        'The confirmation API did not return a market result.'
      );
    }

    const pair = String(first(
      market.pair,
      root.selectedPair,
      expectedPair,
      ''
    )).toUpperCase();

    if (pair !== expectedPair.toUpperCase()) {
      throw new Error('Confirmed pair does not match selected pair.');
    }

    const fresh = isFresh(market);

    const broker = obj(first(
      root.brokerPrice,
      market.brokerPrice,
      root.priceValidation
    ));

    const brokerStatus = String(first(
      broker.status,
      market.brokerPriceStatus,
      root.brokerPriceStatus,
      ''
    )).toUpperCase();

    const brokerValidated =
      broker.validated === true ||
      brokerStatus === 'VALIDATED' ||
      brokerStatus === 'ACCEPTED';

    const signal = getSignal(market);

    const allowed =
      root.tradeAllowed === true &&
      market.tradeAllowed === true &&
      brokerValidated &&
      fresh &&
      signal !== 'NO TRADE';

    const direction = allowed ? signal : 'NO TRADE';

    renderDirection(direction);

    const entryPrice = number(first(
      broker.price,
      market.entryPrice,
      root.entryPrice
    ));

    const referencePrice = number(first(
      broker.referencePrice,
      market.referencePrice,
      market.currentPrice
    ));

    const differencePips = number(first(
      broker.differencePips,
      market.priceDifferencePips
    ));

    setText('resultPair', pair);

    setText(
      'analysisTimestamp',
      formatDate(first(market.fetchedAt, market.lastCandle))
    );

    setText(
      'evidenceScore',
      number(market.confidence) === null
        ? '—'
        : Math.round(number(market.confidence))
    );

    setText(
      'entryPrice',
      entryPrice === null
        ? 'NOT VALIDATED'
        : formatNumber(entryPrice)
    );

    setText(
      'entryTime',
      formatDate(first(market.entryTime, root.entryTime))
    );

    setText(
      'expiryTime',
      formatDate(first(market.expiryTime, root.expiryTime))
    );

    setText(
      'signalDuration',
      formatDuration(
        first(market.entryTime, root.entryTime),
        first(market.expiryTime, root.expiryTime)
      )
    );

    setText(
      'signalStatus',
      allowed ? 'CONFIRMED RESEARCH SIGNAL' : 'NO TRADE'
    );

    setText(
      'signalReason',
      allowed
        ? first(
            market.reason,
            root.message,
            'All required checks passed.'
          )
        : first(
            root.reason,
            market.reason,
            broker.reason,
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

    const warning = $('signalWarning');

    if (warning) {
      warning.textContent = allowed
        ? 'Signal passed the backend checks. This is a research direction, not a guaranteed outcome.'
        : 'NO TRADE: broker price, freshness, evidence, or confirmation requirements were not satisfied.';
    }

    renderTechnical(market);
    renderReasons(market.reasons);

    state.lastMarket = market;
    state.awaitingBrokerPrice = false;

    setVisible('confirmSignalButton', false);

    if (!allowed) {
      renderDirection('NO TRADE');
    }

    return {
      allowed,
      direction,
      market
    };
  }

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
        ? 'AI scanner running. Waiting for priority pair results.'
        : 'No scanned pair results are available yet.';

      row.appendChild(cell);
      body.appendChild(row);
    } else {
      for (const candidate of candidates) {
        const row = document.createElement('tr');

        const freshness = String(
          first(candidate.freshness, 'UNKNOWN')
        ).toUpperCase();

        const values = [
          candidate.pair,
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
          const pair = String(candidate.pair || '').toUpperCase();

          if (!PAIRS.includes(pair)) return;

          if (dom.pairSelect) {
            dom.pairSelect.value = pair;
          }

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
      'AI is scanning the six priority pairs. No signal is confirmed yet.'
    );

    setText(
      'signalWarning',
      'NO TRADE until the priority scan completes and a qualifying pair is selected.'
    );

    clearBrokerPrice();
  }

  function showSelectedPairAwaitingPrice(market) {
    const pair = String(market.pair || '').toUpperCase();

    state.selectedPair = pair;

    renderDirection('NO TRADE');

    setText('resultPair', pair);
    setText('signalStatus', 'WAITING FOR BROKER PRICE');

    setText(
      'signalReason',
      `Pair ${pair} selected. Enter the current Pocket Option price for this exact pair.`
    );

    setText(
      'brokerPriceStatus',
      `ENTER CURRENT POCKET OPTION PRICE — ${pair}`
    );

    setVisible('brokerPriceSection', true);
    setVisible('confirmSignalButton', true);

    if (dom.brokerPriceInput) {
      dom.brokerPriceInput.value = '';
      dom.brokerPriceInput.disabled = false;
    }

    showMessage(
      `AI selected ${pair}. Enter its Pocket Option price, then press CONFIRM SIGNAL.`
    );
  }

  async function analyzeSelectedPair() {
    if (state.analysisBusy || state.confirmationBusy) return;

    const selected = String(
      dom.pairSelect?.value || AUTO_PAIR
    ).toUpperCase();

    const autoMode =
      selected === AUTO_PAIR.toUpperCase() ||
      selected === 'AUTO' ||
      selected === '';

    if (!autoMode && !PAIRS.includes(selected)) {
      showMessage(
        'Select AI AUTO SELECT or a supported LIVE forex pair.',
        'error'
      );

      return;
    }

    state.analysisBusy = true;

    state.autoSelecting = autoMode;
    state.selectedMode = autoMode ? 'AUTO' : 'MANUAL';

    const requestId = ++state.requestId;

    setButtonBusy(
      dom.analyzeButton,
      true,
      autoMode ? 'AI SCANNING...' : 'ANALYZING PAIR...',
      'ANALYZE'
    );

    stopScannerPolling();

    clearBrokerPrice();

    invalidateCurrentSignal(
      'Analysis is running. No signal is confirmed yet.'
    );

    setText('signalStatus', 'ANALYZING');

    try {
      if (autoMode) {
        showMessage(
          'AI is scanning the first six priority pairs. Please wait.'
        );

        const payload = await requestJson('/api/analyze');

        if (requestId !== state.requestId) return;

        const scanner = obj(payload.scanner);
        const market = getMarketFromPayload(payload);

        renderScanner(payload);

        if (
          scanner.running === true ||
          !market.pair ||
          market.pair === 'NO MARKET'
        ) {
          showPendingAutoScan(payload);
          startScannerPolling(requestId);

          return;
        }

        const selectedMarket = renderMarket(payload);

        if (isFresh(selectedMarket)) {
          showSelectedPairAwaitingPrice(selectedMarket);
        }

        await loadHistory();

        return;
      }

      showMessage(
        `Requesting direct analysis for ${selected}...`
      );

      const payload = await requestJson(
        `/api/analyze?pair=${encodeURIComponent(selected)}`
      );

      if (requestId !== state.requestId) return;

      const market = renderMarket(payload, selected);

      renderScanner(payload);

      if (isFresh(market)) {
        showSelectedPairAwaitingPrice(market);
      }

      await loadHistory();
    } catch (error) {
      if (requestId !== state.requestId) return;

      invalidateCurrentSignal(
        `NO TRADE — analysis could not be confirmed: ${error.message}`
      );

      setText('signalStatus', 'UNAVAILABLE');

      showMessage(error.message, 'error');
    } finally {
      state.analysisBusy = false;

      setButtonBusy(
        dom.analyzeButton,
        false,
        '',
        'ANALYZE'
      );
    }
  }

  function getPipSize(pair) {
    return pair.endsWith('/JPY')
      ? 0.01
      : 0.0001;
  }

  function validateBrokerInput(pair) {
    const raw = String(
      dom.brokerPriceInput?.value || ''
    ).trim();

    if (!raw) {
      throw new Error('Enter the Pocket Option price first.');
    }

    const price = Number(raw);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('Enter a valid positive Pocket Option price.');
    }

    if (!PAIRS.includes(pair)) {
      throw new Error('The selected pair is not supported.');
    }

    return price;
  }

  async function confirmSignal() {
    if (state.confirmationBusy || state.analysisBusy) return;

    const market = obj(state.lastMarket);

    const pair = String(
      state.selectedPair || market.pair || ''
    ).toUpperCase();

    if (!state.awaitingBrokerPrice || !PAIRS.includes(pair)) {
      showMessage(
        'Run Analyze first and wait for a valid selected pair.',
        'error'
      );

      return;
    }

    if (!isFresh(market)) {
      invalidateCurrentSignal(
        'NO TRADE — the reference market data is no longer fresh.'
      );

      clearBrokerPrice();

      return;
    }

    let brokerPrice;

    try {
      brokerPrice = validateBrokerInput(pair);
    } catch (error) {
      setText('brokerPriceStatus', error.message);
      showMessage(error.message, 'error');

      return;
    }

    state.confirmationBusy = true;

    const capturedAt = new Date().toISOString();

    state.brokerPrice = brokerPrice;
    state.brokerPriceCapturedAt = capturedAt;

    setButtonBusy(
      dom.confirmSignalButton,
      true,
      'VALIDATING PRICE...',
      'CONFIRM SIGNAL'
    );

    renderDirection('NO TRADE');

    setText('signalStatus', 'VALIDATING BROKER PRICE');

    setText(
      'brokerPriceStatus',
      'CHECKING POCKET OPTION PRICE AGAINST LIVE REFERENCE...'
    );

    setText(
      'brokerPriceTimestamp',
      formatDate(capturedAt)
    );

    try {
      /*
       * Backend confirmation contract:
       * POST /api/confirm-signal
       *
       * The backend must independently validate:
       * - selected pair
       * - manually entered broker price
       * - quote age
       * - Twelve Data reference price
       * - pair-specific pip difference
       * - market freshness
       * - one-minute technical signal
       * - five-minute trend confirmation
       * - evidence and risk gates
       *
       * The browser does not authorize a trade by itself.
       */
      const payload = await requestJson(
        '/api/confirm-signal',
        {
          method: 'POST',

          body: {
            pair,
            brokerPrice,
            brokerPriceCapturedAt: capturedAt,
            expiryMinutes: CONFIG.LIVE_EXPIRY_MINUTES,
            mode: state.selectedMode,
            source: 'USER_ENTERED_POCKET_OPTION_PRICE'
          }
        }
      );

      const result = renderConfirmedSignal(payload, pair);

      if (result.allowed) {
        showMessage(
          `${pair}: ${result.direction} research signal passed backend validation. No guaranteed outcome.`,
          'success'
        );
      } else {
        showMessage(
          `${pair}: NO TRADE. The required validation checks did not pass.`,
          'error'
        );
      }

      await loadHistory();
    } catch (error) {
      renderDirection('NO TRADE');

      setText('signalStatus', 'NO TRADE');

      setText(
        'signalReason',
        `Signal was not confirmed: ${error.message}`
      );

      setText(
        'brokerPriceStatus',
        'VALIDATION FAILED'
      );

      setText(
        'signalWarning',
        'NO TRADE: the backend did not confirm all required checks. Do not use an unconfirmed direction.'
      );

      showMessage(
        `NO TRADE — ${error.message}`,
        'error'
      );
    } finally {
      state.confirmationBusy = false;

      setButtonBusy(
        dom.confirmSignalButton,
        false,
        '',
        'CONFIRM SIGNAL'
      );
    }
  }

  async function pollScanner(requestId = null) {
    if (!state.scanTimer) return;

    try {
      const payload = await requestJson('/api/best');

      if (
        requestId !== null &&
        requestId !== state.requestId
      ) {
        stopScannerPolling();

        return;
      }

      renderScanner(payload);

      const scanner = obj(payload.scanner);
      const market = getMarketFromPayload(payload);

      if (scanner.running === true) {
        setText(
          'scannerStatus',
          `AI scanning ${first(
            scanner.progress?.pair,
            'priority pairs'
          )}...`
        );

        return;
      }

      stopScannerPolling();

      if (
        requestId !== null &&
        state.autoSelecting &&
        market.pair &&
        market.pair !== 'NO MARKET'
      ) {
        const selectedMarket = renderMarket(payload);

        state.autoSelecting = false;

        if (isFresh(selectedMarket)) {
          showSelectedPairAwaitingPrice(selectedMarket);
        } else {
          invalidateCurrentSignal(
            'NO TRADE — selected pair did not pass freshness checks.'
          );
        }

        await loadHistory();

        return;
      }

      if (requestId !== null && state.autoSelecting) {
        state.autoSelecting = false;

        renderDirection('NO TRADE');

        setText('resultPair', 'NO QUALIFIED PAIR');
        setText('signalStatus', 'NO TRADE');

        setText(
          'signalReason',
          first(
            payload.diagnostic?.lastScanError,
            'No qualifying priority pair is currently available.'
          )
        );

        clearBrokerPrice();

        showMessage(
          'Priority scan completed, but no qualifying pair was confirmed. NO TRADE.'
        );
      }
    } catch (error) {
      setText(
        'scannerStatus',
        `Scanner status unavailable: ${error.message}`
      );
    }
  }

  function startScannerPolling(requestId = null) {
    stopScannerPolling();

    state.scanTimer = setInterval(
      () => pollScanner(requestId),
      CONFIG.SCAN_POLL_INTERVAL_MS
    );

    pollScanner(requestId);
  }

  function stopScannerPolling() {
    if (state.scanTimer) {
      clearInterval(state.scanTimer);

      state.scanTimer = null;
    }
  }

  async function refreshScanner() {
    if (state.scanBusy) return;

    state.scanBusy = true;

    setButtonBusy(
      dom.refreshScannerButton,
      true,
      'STARTING SCANNER...',
      'REFRESH SCANNER'
    );

    try {
      const payload = await requestJson('/api/scan', {
        method: 'POST',
        body: {},
        timeout: CONFIG.REQUEST_TIMEOUT_MS
      });

      renderScanner(payload);

      showMessage(
        first(
          payload.message,
          'Live forex priority scanner started.'
        )
      );

      startScannerPolling();
    } catch (error) {
      if (error.status === 409) {
        showMessage(
          'Priority scanner is already running. Monitoring progress.'
        );

        startScannerPolling();
      } else if (error.status === 429) {
        showMessage(
          first(
            error.message,
            'Please wait before starting another scan.'
          )
        );
      } else {
        showMessage(error.message, 'error');
      }
    } finally {
      state.scanBusy = false;

      setButtonBusy(
        dom.refreshScannerButton,
        false,
        '',
        'REFRESH SCANNER'
      );
    }
  }

  async function loadHistory() {
    if (state.historyBusy) return;

    state.historyBusy = true;

    try {
      const payload = await requestJson('/api/history?limit=100');

      const history = Array.isArray(payload.history)
        ? payload.history
        : [];

      renderHistory(history, payload);
    } catch (error) {
      setText('historySource', 'UNAVAILABLE');
      setText('historyTotal', '—');
      setText('historyEvaluated', '—');
      setText('historyPending', '—');

      const body = $('historyTableBody');

      if (body) {
        body.replaceChildren();

        const row = document.createElement('tr');
        const cell = document.createElement('td');

        cell.colSpan = 7;
        cell.textContent = `History unavailable: ${error.message}`;

        row.appendChild(cell);
        body.appendChild(row);
      }
    } finally {
      state.historyBusy = false;
    }
  }

  function renderHistory(history, payload) {
    const evaluated = history.filter(record =>
      String(first(record.outcome, 'PENDING')).toUpperCase() !== 'PENDING'
    );

    const pending = history.length - evaluated.length;

    setText('historyTotal', history.length);
    setText('historyEvaluated', evaluated.length);
    setText('historyPending', pending);

    setText(
      'historySource',
      payload.persistent ? 'POSTGRESQL' : 'MEMORY ONLY'
    );

    const body = $('historyTableBody');

    if (!body) return;

    body.replaceChildren();

    if (!history.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');

      cell.colSpan = 7;
      cell.className = 'empty-state';
      cell.textContent = 'No signal records are available yet.';

      row.appendChild(cell);
      body.appendChild(row);

      return;
    }

    for (const record of history) {
      const row = document.createElement('tr');

      const values = [
        formatDate(first(record.createdAt, record.entryTime)),
        record.pair,
        record.signal,
        number(record.evidenceScore) === null
          ? '—'
          : `${formatNumber(record.evidenceScore, 0)}/100`,
        number(record.referencePrice) === null
          ? 'WAITING'
          : formatNumber(record.referencePrice),
        formatDuration(record.entryTime, record.expiryTime),
        first(record.outcome, 'PENDING')
      ];

      for (const value of values) {
        const cell = document.createElement('td');

        cell.textContent = String(first(value, '—'));

        row.appendChild(cell);
      }

      body.appendChild(row);
    }
  }

  async function runBacktest() {
    if (state.backtestBusy) return;

    const pair = String(
      dom.backtestPairSelect?.value || 'EUR/USD'
    ).toUpperCase();

    const duration = Number(
      dom.backtestDuration?.value || 1
    );

    if (
      !PAIRS.includes(pair) ||
      ![1, 2, 3].includes(duration)
    ) {
      setText(
        'backtestMessage',
        'Invalid pair or expiry duration.'
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

    setText(
      'backtestMessage',
      `Testing ${pair} with ${duration}-minute expiry...`
    );

    try {
      const query = new URLSearchParams({
        pair,
        expiry: String(duration)
      });

      const payload = await requestJson(
        `/api/backtest?${query.toString()}`
      );

      renderBacktest(payload);
    } catch (error) {
      setText(
        'backtestMessage',
        `Backtest unavailable: ${error.message}`
      );

      for (const id of [
        'backtestSamples',
        'backtestWins',
        'backtestLosses',
        'backtestCoverage',
        'backtestWinRate',
        'backtestBaseline'
      ]) {
        setText(id, '—');
      }
    } finally {
      state.backtestBusy = false;

      setButtonBusy(
        dom.runBacktestButton,
        false,
        '',
        'RUN BACKTEST'
      );
    }
  }

  function renderBacktest(payload) {
    const result = obj(payload.result);
    const holdout = obj(result.holdout);
    const development = obj(result.development);

    const samples = number(holdout.signals) || 0;
    const wins = number(holdout.hits) || 0;
    const losses = Math.max(0, samples - wins);

    setText('backtestSamples', samples);
    setText('backtestWins', wins);
    setText('backtestLosses', losses);

    setText(
      'backtestCoverage',
      result.coveragePercent === undefined
        ? 'NOT REPORTED'
        : `${formatNumber(result.coveragePercent, 2)}%`
    );

    setText(
      'backtestWinRate',
      holdout.hitRate === null || holdout.hitRate === undefined
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

    const sufficient = holdout.sufficientSample === true;

    setText(
      'backtestMessage',
      `${first(result.method, 'Walk-forward evaluation')} · ` +
      `${first(result.conclusion, 'No conclusion supplied')} ` +
      `Development signals: ${number(development.signals) || 0}. ` +
      `Holdout signals: ${samples}. ` +
      `Expiry: ${first(result.expiryMinutes, '—')} minute(s). ` +
      (
        sufficient
          ? 'Holdout sample threshold passed.'
          : 'INSUFFICIENT HOLDOUT SAMPLE — no performance claim.'
      )
    );
  }

  function addPairOption(select, value, label) {
    if (!select) return;

    const exists = [...select.options].some(
      option => option.value === value
    );

    if (exists) return;

    const option = document.createElement('option');

    option.value = value;
    option.textContent = label;

    select.appendChild(option);
  }

  function populatePairOptions() {
    if (dom.pairSelect) {
      addPairOption(
        dom.pairSelect,
        AUTO_PAIR,
        'AI AUTO SELECT — BEST OF FIRST 6'
      );

      for (const pair of PAIRS) {
        addPairOption(dom.pairSelect, pair, pair);
      }

      if (
        !PAIRS.includes(dom.pairSelect.value) &&
        dom.pairSelect.value !== AUTO_PAIR
      ) {
        dom.pairSelect.value = AUTO_PAIR;
      }
    }

    if (dom.backtestPairSelect) {
      for (const pair of PAIRS) {
        addPairOption(dom.backtestPairSelect, pair, pair);
      }
    }
  }

  function bindEvents() {
    dom.analyzeButton?.addEventListener(
      'click',
      analyzeSelectedPair
    );

    dom.refreshScannerButton?.addEventListener(
      'click',
      refreshScanner
    );

    dom.runBacktestButton?.addEventListener(
      'click',
      runBacktest
    );

    dom.refreshHistoryButton?.addEventListener(
      'click',
      loadHistory
    );

    dom.confirmSignalButton?.addEventListener(
      'click',
      confirmSignal
    );

    dom.pairSelect?.addEventListener('change', () => {
      const selected = String(
        dom.pairSelect.value || AUTO_PAIR
      ).toUpperCase();

      state.requestId++;

      stopScannerPolling();
      clearBrokerPrice();

      state.selectedPair = null;
      state.lastMarket = null;
      state.awaitingBrokerPrice = false;
      state.autoSelecting = false;

      invalidateCurrentSignal(
        'Pair selection changed. Run Analyze to inspect the selected market.'
      );

      if (selected === AUTO_PAIR || selected === 'AUTO') {
        showMessage(
          'AI AUTO SELECT is active. Press Analyze to scan the first six priority pairs.'
        );
      } else {
        showMessage(
          `Manual selection: ${selected}. AI will analyze this pair only.`
        );
      }
    });

    dom.brokerPriceInput?.addEventListener('input', () => {
      /*
       * Any price edit invalidates a previously confirmed direction.
       * The user must validate the newly entered quote again.
       */
      if (state.lastMarket) {
        renderDirection('NO TRADE');

        setText(
          'signalStatus',
          'PRICE NOT YET CONFIRMED'
        );

        setText(
          'brokerPriceStatus',
          'PRICE CHANGED — CONFIRM AGAIN'
        );
      }
    });
  }

  function initialize() {
    populatePairOptions();
    bindEvents();

    // Live signals are always one-minute signals.
    if (dom.expirySelect) {
      dom.expirySelect.value = '1';
      dom.expirySelect.disabled = true;

      dom.expirySelect.title =
        'Live signal is fixed at one minute. Backtest supports 1, 2 and 3 minutes.';
    }

    setVisible('brokerPriceSection', false);
    setVisible('confirmSignalButton', false);

    setText('apiStatusDetail', 'Connecting to backend...');
    setText('scannerStatus', 'Scanner idle');
    setText('scannerProgress', '0 / 6 priority pairs');

    setText(
      'signalWarning',
      'Historical and live market research only. No guaranteed outcomes.'
    );

    showMessage(
      'Choose AI AUTO SELECT or a pair manually, then press Analyze. Enter the Pocket Option price after the pair has been selected.'
    );

    checkHealth();
    loadHistory();

    state.healthTimer = setInterval(
      checkHealth,
      CONFIG.HEALTH_INTERVAL_MS
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      initialize
    );
  } else {
    initialize();
  }

  window.POAI = Object.freeze({
    version: VERSION,
    apiBase: API_BASE,
    pairs: [...PAIRS],
    priorityPairs: [...PRIORITY_PAIRS],
    autoPair: AUTO_PAIR,

    analyzeSelectedPair,
    confirmSignal,
    refreshScanner,
    loadHistory,
    runBacktest,
    checkHealth
  });
})();
