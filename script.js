
'use strict';

(() => {
  const API_BASE = String(
    window.PO_API_BASE ||
    'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const VERSION = 'V10.2.0';
  const HEALTH_INTERVAL_MS = 60000;
  const SCAN_POLL_INTERVAL_MS = 3000;
  const REQUEST_TIMEOUT_MS = 35000;
  const HEALTH_TIMEOUT_MS = 12000;
  const MAX_DATA_AGE_SECONDS = 150;
  const MAX_REASONS = 10;
  const AUTO_PAIR = 'AI AUTO SELECT';

  const PAIRS = [
    'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF',
    'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP',
    'EUR/JPY', 'GBP/JPY', 'EUR/CHF', 'EUR/AUD',
    'EUR/CAD', 'GBP/CHF', 'GBP/AUD', 'GBP/CAD',
    'AUD/JPY', 'AUD/CAD', 'AUD/NZD', 'CAD/JPY',
    'CHF/JPY', 'NZD/JPY', 'NZD/CAD', 'EUR/NZD'
  ];

  const $ = id => document.getElementById(id);

  const state = {
    analysisBusy: false,
    backtestBusy: false,
    scanBusy: false,
    healthBusy: false,
    historyBusy: false,
    scanTimer: null,
    healthTimer: null,
    lastMarket: null,
    lastScanner: null,
    lastHealth: null,
    requestId: 0,
    autoSelecting: false
  };

  const dom = {
    analyzeButton: $('analyzeButton'),
    refreshScannerButton: $('refreshScannerButton'),
    runBacktestButton: $('runBacktestButton'),
    refreshHistoryButton: $('refreshHistoryButton'),
    pairSelect: $('pairSelect'),
    expirySelect: $('expirySelect'),
    backtestPairSelect: $('backtestPairSelect'),
    backtestDuration: $('backtestDuration')
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
    if (value === null || value === undefined || value === '') {
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

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return String(value);
    }

    return parsed.toLocaleString();
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
    const dot = $('apiStatusDot');
    if (!dot) return;

    dot.className = online
      ? 'status-indicator online'
      : 'status-indicator offline';
  }

  function showMessage(message, type = 'info') {
    const node = $('analysisMessage');
    if (!node) return;

    node.textContent = String(message || '');
    node.dataset.type = type;
  }

  function setButtonBusy(button, busy, busyText, normalText) {
    if (!button) return;

    button.disabled = busy;
    button.textContent = busy ? busyText : normalText;
  }

  async function requestJson(path, options = {}) {
    const controller = new AbortController();
    const timeoutMs = options.timeout || REQUEST_TIMEOUT_MS;

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
          'API request timed out. No new signal was confirmed.'
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
      age <= MAX_DATA_AGE_SECONDS &&
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
      market.tradeAllowed === false ||
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
      message,
      online ? 'API ONLINE' : 'API UNAVAILABLE'
    );

    setText(
      'apiStatusCard',
      online ? 'ONLINE' : 'OFFLINE'
    );
  }

  function renderHealth(payload) {
    const root = obj(payload);
    state.lastHealth = root;

    const configured = root.configured === true;
    const online = root.ok !== false;

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
    const running = root.scannerRunning === true;

    setText(
      'marketFreshness',
      running ? 'SCANNING' : 'WAITING'
    );

    setText(
      'marketFreshnessDetail',
      running
        ? 'AI priority scanner is checking the first six pairs'
        : 'Waiting for market analysis'
    );

    if (!configured) {
      setText(
        'providerDetail',
        'Twelve Data API key is not configured on backend'
      );
    }

    const metadata = obj(root.metadata);

    setText(
      'historySource',
      metadata.databaseReady === true
        ? 'POSTGRESQL'
        : 'MEMORY ONLY'
    );

    renderScannerProgress(progress, running);
  }

  async function checkHealth() {
    if (state.healthBusy) return;

    state.healthBusy = true;

    try {
      const payload = await requestJson('/api/health', {
        timeout: HEALTH_TIMEOUT_MS
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

    setText(
      'rsiValue',
      formatNumber(indicators.rsi14, 2)
    );

    const rsi = number(indicators.rsi14);

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

    setText(
      'atrValue',
      formatNumber(indicators.atr14, 7)
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
      bollinger.width === null ||
      bollinger.width === undefined
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
        : first(
            psychology.psychology,
            'UNAVAILABLE'
          )
    );

    setText(
      'psychologyDetail',
      first(
        psychology.direction,
        'Price pressure interpretation'
      )
    );

    setText(
      'supportLevel',
      formatNumber(levels.support)
    );

    setText(
      'supportDetail',
      first(
        levels.position,
        'Support assessment unavailable'
      )
    );

    setText(
      'resistanceLevel',
      formatNumber(levels.resistance)
    );

    setText(
      'resistanceDetail',
      first(
        levels.position,
        'Resistance assessment unavailable'
      )
    );

    setText(
      'trendlineSignal',
      first(trendline.direction, 'UNAVAILABLE')
    );

    setText(
      'trendlineDetail',
      first(
        trendline.description,
        'Trendline analysis unavailable'
      )
    );

    setText(
      'breakoutSignal',
      first(breakout.status, 'UNAVAILABLE')
    );

    setText(
      'breakoutDetail',
      first(
        breakout.description,
        'Breakout assessment unavailable'
      )
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

  function renderMarket(payload, expectedPair) {
    const root = obj(payload);

    const market = obj(first(
      root.selectedMarket,
      root.market,
      root.result,
      root.data
    ));

    if (!Object.keys(market).length) {
      throw new Error(
        'The API did not return a selected market result.'
      );
    }

    state.lastMarket = market;

    const pair = String(first(
      market.pair,
      root.selectedPair,
      expectedPair,
      'UNKNOWN'
    ));

    if (
      expectedPair &&
      pair.toUpperCase() !== expectedPair.toUpperCase()
    ) {
      throw new Error(
        `Pair mismatch. Requested ${expectedPair}, received ${pair}.`
      );
    }

    const fresh = isFresh(market);
    const backendSignal = getSignal(market);
    const direction = fresh ? backendSignal : 'NO TRADE';

    const entryTime = market.entryTime;
    const expiryTime = market.expiryTime;
    const entryPrice = number(market.entryPrice);
    const evidence = number(market.confidence);

    renderDirection(direction);

    setText('resultPair', pair);

    setText(
      'analysisTimestamp',
      formatDate(first(
        market.fetchedAt,
        market.lastCandle
      ))
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

    const reason = first(
      Array.isArray(market.reasons)
        ? market.reasons[0]
        : null,
      market.reason,
      'Evidence is insufficient or conflicting.'
    );

    setText(
      'signalReason',
      !fresh
        ? 'NO TRADE — market data is stale or its freshness cannot be verified.'
        : reason
    );

    setText('entryTime', formatDate(entryTime));
    setText('expiryTime', formatDate(expiryTime));

    setText(
      'entryPrice',
      entryPrice === null
        ? 'WAITING FOR PRICE'
        : formatNumber(entryPrice)
    );

    setText(
      'signalDuration',
      formatDuration(entryTime, expiryTime)
    );

    setText(
      'signalStatus',
      direction === 'NO TRADE'
        ? 'NO TRADE'
        : entryPrice === null
          ? 'WAITING FOR ENTRY PRICE'
          : 'PRICE AVAILABLE'
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

    const warning = $('signalWarning');

    if (warning) {
      warning.textContent =
        direction === 'NO TRADE'
          ? 'NO TRADE: required evidence or data checks have not passed.'
          : entryPrice === null
            ? 'Research direction only. Entry price has not been confirmed. Do not treat this as an executable trade.'
            : 'A reference price is available. This remains a research signal, not a guarantee or financial advice.';
    }

    renderTechnical(market);
    renderReasons(market.reasons);

    return market;
  }

  function renderReasons(reasons) {
    const items = Array.isArray(reasons)
      ? reasons.filter(Boolean).slice(0, MAX_REASONS)
      : [];

    if (!items.length) {
      items.push('No additional decision reasons were supplied.');
    }

    const node = document.createElement('ul');
    node.className = 'reason-list';

    for (const reason of items) {
      const item = document.createElement('li');
      item.textContent = String(reason);
      node.appendChild(item);
    }

    const target = $('analysisMessage');
    if (!target) return;

    target.replaceChildren(
      document.createTextNode('Analysis notes: '),
      node
    );
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

        const signal = getSignal(candidate);
        const freshness = String(
          first(candidate.freshness, 'UNKNOWN')
        ).toUpperCase();

        const values = [
          candidate.pair,
          '—',
          first(candidate.oneMinuteTrend, '—'),
          first(candidate.fiveMinuteConfirmation, '—'),
          first(candidate.volatility, '—'),
          candidate.confidence === null ||
          candidate.confidence === undefined
            ? '—'
            : `${formatNumber(candidate.confidence, 0)}/100`,
          freshness === 'FRESH' ? signal : 'NO TRADE',
          'SELECT'
        ];

        for (let i = 0; i < values.length; i++) {
          const cell = document.createElement('td');

          if (i === 7) {
            const button = document.createElement('button');

            button.type = 'button';
            button.className = 'table-select-button';
            button.textContent = 'SELECT';

            button.addEventListener('click', () => {
              if (
                PAIRS.includes(candidate.pair) &&
                dom.pairSelect
              ) {
                dom.pairSelect.value = candidate.pair;
                analyzeSelectedPair();
              }
            });

            cell.appendChild(button);
          } else {
            cell.textContent = String(
              first(values[i], '—')
            );
          }

          row.appendChild(cell);
        }

        body.appendChild(row);
      }
    }

    renderScannerProgress(
      progress,
      scanner.running === true
    );
  }

  function showPendingAutoScan(payload) {
    const scanner = obj(payload.scanner);
    const running = scanner.running === true;

    renderScanner(payload);

    renderDirection('NO TRADE');

    setText('resultPair', 'AI SELECTING...');
    setText('evidenceScore', '—');
    setText('signalStatus', 'SCANNING');

    setText(
      'signalReason',
      running
        ? 'AI is scanning the first six priority pairs. No signal is confirmed yet.'
        : first(
            payload.note,
            'Waiting for a completed priority scan.'
          )
    );

    const warning = $('signalWarning');

    if (warning) {
      warning.textContent =
        'NO TRADE until the priority scan completes and the selected market passes all evidence and freshness checks.';
    }
  }

  async function analyzeSelectedPair() {
    if (state.analysisBusy) return;

    const selected = String(
      dom.pairSelect?.value || AUTO_PAIR
    ).toUpperCase();

    const autoMode =
      selected === AUTO_PAIR.toUpperCase() ||
      selected === 'AUTO' ||
      selected === '';

    if (!autoMode && !PAIRS.includes(selected)) {
      showMessage(
        'Please select AI AUTO SELECT or a supported LIVE forex pair.',
        'error'
      );
      return;
    }

    state.analysisBusy = true;
    state.autoSelecting = autoMode;

    const requestId = ++state.requestId;

    setButtonBusy(
      dom.analyzeButton,
      true,
      autoMode
        ? 'AI SCANNING PRIORITY PAIRS...'
        : 'ANALYZING SELECTED PAIR...',
      'ANALYZE'
    );

    stopScannerPolling();

    renderDirection('NO TRADE');
    setText('evidenceScore', '—');
    setText('signalStatus', 'ANALYZING');

    try {
      if (autoMode) {
        showMessage(
          'AI is starting its first-six-pair priority scan. Please wait for the best qualifying pair.'
        );

        const payload = await requestJson('/api/analyze');

        if (requestId !== state.requestId) return;

        const scanner = obj(payload.scanner);
        const market = obj(payload.selectedMarket);

        renderScanner(payload);

        if (
          scanner.running ||
          !market.pair ||
          market.pair === 'NO MARKET'
        ) {
          showPendingAutoScan(payload);
          startScannerPolling(requestId);
          return;
        }

        const selectedMarket = renderMarket(payload);

        showMessage(
          `AI selected ${selectedMarket.pair}. Review the evidence and signal status.`
        );

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

      showMessage(
        `Selected-pair analysis completed for ${selected}. Assessment: ${getSignal(market)}.`
      );

      await loadHistory();
    } catch (error) {
      if (requestId !== state.requestId) return;

      renderDirection('NO TRADE');

      setText(
        'signalReason',
        `Analysis could not be confirmed: ${error.message}`
      );

      setText('signalStatus', 'UNAVAILABLE');

      const warning = $('signalWarning');

      if (warning) {
        warning.textContent =
          'NO TRADE: analysis failed or could not be verified.';
      }

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
      const market = obj(payload.selectedMarket);

      if (scanner.running) {
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

        showMessage(
          `AI priority scan completed. Selected pair: ${selectedMarket.pair}. Assessment: ${getSignal(selectedMarket)}.`,
          'success'
        );

        state.autoSelecting = false;
        await loadHistory();
        return;
      }

      if (requestId !== null && state.autoSelecting) {
        renderDirection('NO TRADE');
        setText('resultPair', 'NO QUALIFIED PAIR');
        setText('signalStatus', 'NO TRADE');

        setText(
          'signalReason',
          first(
            payload.diagnostic?.lastScanError,
            'No qualifying market is currently available.'
          )
        );

        showMessage(
          'Priority scan completed, but no qualifying pair was confirmed. NO TRADE.',
          'info'
        );

        state.autoSelecting = false;
      } else {
        showMessage(
          'Priority scanner completed. Review the latest pair results.'
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
      SCAN_POLL_INTERVAL_MS
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
        timeout: REQUEST_TIMEOUT_MS
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
          ),
          'info'
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
        cell.textContent =
          `History unavailable: ${error.message}`;

        row.appendChild(cell);
        body.appendChild(row);
      }
    } finally {
      state.historyBusy = false;
    }
  }

  function renderHistory(history, payload) {
    const evaluated = history.filter(record =>
      String(
        first(record.outcome, 'PENDING')
      ).toUpperCase() !== 'PENDING'
    );

    const pending = history.length - evaluated.length;

    setText('historyTotal', history.length);
    setText('historyEvaluated', evaluated.length);
    setText('historyPending', pending);

    setText(
      'historySource',
      payload.persistent
        ? 'POSTGRESQL'
        : 'MEMORY ONLY'
    );

    const body = $('historyTableBody');
    if (!body) return;

    body.replaceChildren();

    if (!history.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');

      cell.colSpan = 7;
      cell.className = 'empty-state';
      cell.textContent =
        'No signal records are available yet.';

      row.appendChild(cell);
      body.appendChild(row);
      return;
    }

    for (const record of history) {
      const row = document.createElement('tr');

      const values = [
        formatDate(first(
          record.createdAt,
          record.entryTime
        )),
        record.pair,
        record.signal,
        record.evidenceScore === null ||
        record.evidenceScore === undefined
          ? '—'
          : `${formatNumber(record.evidenceScore, 0)}/100`,
        record.referencePrice === null ||
        record.referencePrice === undefined
          ? 'WAITING'
          : formatNumber(record.referencePrice),
        formatDuration(
          record.entryTime,
          record.expiryTime
        ),
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

  function initialize() {
    populatePairOptions();

    // Live signals are one-minute signals.
    // 1/2/3-minute expiry options are for historical backtesting.
    if (dom.expirySelect) {
      dom.expirySelect.value = '1';
      dom.expirySelect.disabled = true;
      dom.expirySelect.title =
        'Live signal is fixed at one minute. Backtest supports 1, 2 and 3 minutes.';
    }

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

    dom.pairSelect?.addEventListener('change', () => {
      const selected = dom.pairSelect.value;

      showMessage(
        selected === AUTO_PAIR
          ? 'AI AUTO SELECT is active. Press Analyze to scan the first six priority pairs.'
          : `Selected ${selected}. Press Analyze to inspect this pair directly.`
      );
    });

    checkHealth();
    loadHistory();

    state.healthTimer = setInterval(
      checkHealth,
      HEALTH_INTERVAL_MS
    );

    setText(
      'apiStatusDetail',
      'Connecting to backend...'
    );

    setText(
      'scannerStatus',
      'Scanner idle'
    );

    setText(
      'scannerProgress',
      '0 / 6 priority pairs'
    );

    showMessage(
      'Choose AI AUTO SELECT to let AI find the best pair, or select a pair manually. Then press Analyze.'
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
    autoPair: AUTO_PAIR,
    analyzeSelectedPair,
    refreshScanner,
    loadHistory,
    runBacktest,
    checkHealth
  });
})();
