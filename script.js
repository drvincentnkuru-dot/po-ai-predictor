
'use strict';

(() => {
  const API_BASE = String(
    window.PO_API_BASE ||
      'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const HEALTH_INTERVAL_MS = 60000;
  const SCAN_POLL_INTERVAL_MS = 2500;
  const REQUEST_TIMEOUT_MS = 30000;
  const HEALTH_TIMEOUT_MS = 12000;
  const MAX_DATA_AGE_SECONDS = 150;
  const MAX_REASONS = 10;
  const PAIR_COUNT = 24;

  const $ = id => document.getElementById(id);

  const state = {
    analysisBusy: false,
    scanBusy: false,
    healthBusy: false,
    scanTimer: null,
    healthTimer: null,
    lastMarket: null,
    lastHealth: null,
    requestId: 0
  };

  const el = {
    backendStatus: $('backendStatus'),
    marketStatus: $('marketStatus'),
    analyzeBtn: $('analyzeBtn'),
    selectedPair: $('selectedPair'),
    timeframe: $('timeframe'),
    errorBox: $('errorBox'),
    scanInfo: $('scanInfo'),
    signalBadge: $('signalBadge'),
    confidence: $('confidence'),
    summaryPair: $('summaryPair'),
    trendBadge: $('trendBadge'),
    freshness: $('freshness'),
    dataAge: $('dataAge'),
    entryTime: $('entryTime'),
    expiryTime: $('expiryTime'),
    currentPrice: $('currentPrice'),
    entryPrice: $('entryPrice'),
    callScore: $('callScore'),
    putScore: $('putScore'),
    gap: $('gap'),
    signalReason: $('signalReason'),
    ema9: $('ema9'),
    ema21: $('ema21'),
    emaCross: $('emaCross'),
    rsi: $('rsi'),
    rsiCross: $('rsiCross'),
    macdLine: $('macdLine'),
    macdSignal: $('macdSignal'),
    macdHistogram: $('macdHistogram'),
    macdCross: $('macdCross'),
    stochK: $('stochK'),
    stochD: $('stochD'),
    stochasticCross: $('stochasticCross'),
    bollingerUpper: $('bollingerUpper'),
    bollingerMiddle: $('bollingerMiddle'),
    bollingerLower: $('bollingerLower'),
    support: $('support'),
    resistance: $('resistance'),
    volatility: $('volatility'),
    candlePattern: $('candlePattern'),
    lastCandle: $('lastCandle'),
    priceAction: $('priceAction'),
    psychology: $('psychology'),
    reasons: $('reasons'),
    provider: $('provider'),
    providerName: $('providerName'),
    providerRequests: $('providerRequests'),
    dailyCreditsUsed: $('dailyCreditsUsed'),
    dailyCreditsRemaining: $('dailyCreditsRemaining'),
    cachedPairs: $('cachedPairs'),
    candidateCount: $('candidateCount'),
    scannerStatus: $('scannerStatus'),
    lastScanAt: $('lastScanAt')
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

  function num(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function fmt(value, digits = 5) {
    const valueNumber = num(value);

    if (valueNumber === null) return '—';

    return valueNumber.toLocaleString(undefined, {
      maximumFractionDigits: digits
    });
  }

  function date(value) {
    if (!value) return '—';

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime())
      ? String(value)
      : parsed.toLocaleString();
  }

  function setText(id, value, fallback = '—') {
    const node = $(id);
    if (!node) return;

    node.textContent =
      value === null || value === undefined || value === ''
        ? fallback
        : String(value);
  }

  function setBadge(node, label, className) {
    if (!node) return;

    node.textContent = label;
    node.className = className;
  }

  function showError(message) {
    if (!el.errorBox) return;

    el.errorBox.textContent = String(message);
    el.errorBox.hidden = false;
  }

  function clearError() {
    if (!el.errorBox) return;

    el.errorBox.textContent = '';
    el.errorBox.hidden = true;
  }

  async function requestJson(path, options = {}) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      options.timeout || REQUEST_TIMEOUT_MS
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
      let payload;

      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          `API returned invalid JSON (HTTP ${response.status}).`
        );
      }

      if (!response.ok || payload.ok === false) {
        const error = new Error(
          first(
            payload.error,
            payload.message,
            `Request failed (HTTP ${response.status}).`
          )
        );

        error.status = response.status;
        error.payload = payload;
        throw error;
      }

      return payload;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeoutError = new Error(
          'API request timed out. No new signal was confirmed.'
        );

        timeoutError.code = 'REQUEST_TIMEOUT';
        throw timeoutError;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function marketFrom(payload) {
    const root = obj(payload);

    return obj(first(
      root.selectedMarket,
      root.market,
      root.result,
      root.data,
      root
    ));
  }

  function indicatorsFrom(market) {
    return obj(market.indicators);
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

  function isFreshMarket(market) {
    const age = num(market.dataAgeSeconds);
    const freshness = String(
      first(market.freshness, 'UNKNOWN')
    ).toUpperCase();

    const currentPrice = num(market.currentPrice);
    const entryPrice = num(market.entryPrice);

    return (
      freshness === 'FRESH' &&
      age !== null &&
      age >= 0 &&
      age <= MAX_DATA_AGE_SECONDS &&
      currentPrice !== null &&
      currentPrice > 0 &&
      entryPrice !== null &&
      entryPrice > 0 &&
      market.insufficientData !== true &&
      market.tradeAllowed !== false &&
      market.noTrade !== true
    );
  }

  function isQualifiedCandidate(candidate) {
    const signal = getSignal(candidate);

    const age = num(candidate.dataAgeSeconds);
    const freshness = String(
      first(candidate.freshness, 'UNKNOWN')
    ).toUpperCase();

    return (
      (signal === 'BUY' || signal === 'SELL') &&
      freshness === 'FRESH' &&
      age !== null &&
      age >= 0 &&
      age <= MAX_DATA_AGE_SECONDS &&
      candidate.noTrade !== true &&
      candidate.tradeAllowed !== false
    );
  }

  function renderSignal(signal) {
    if (signal === 'BUY') {
      setBadge(
        el.signalBadge,
        'BUY',
        'signal-badge signal-call'
      );
    } else if (signal === 'SELL') {
      setBadge(
        el.signalBadge,
        'SELL',
        'signal-badge signal-put'
      );
    } else {
      setBadge(
        el.signalBadge,
        'NO TRADE',
        'signal-badge signal-wait'
      );
    }
  }

  function renderTrend(value) {
    const trend = String(value || 'UNKNOWN').toUpperCase();

    if (
      trend.includes('BULL') ||
      trend.includes('BUYER') ||
      trend === 'UP'
    ) {
      setBadge(
        el.trendBadge,
        'Trend: BULLISH',
        'trend-badge trend-up'
      );
    } else if (
      trend.includes('BEAR') ||
      trend.includes('SELLER') ||
      trend === 'DOWN'
    ) {
      setBadge(
        el.trendBadge,
        'Trend: BEARISH',
        'trend-badge trend-down'
      );
    } else {
      setBadge(
        el.trendBadge,
        `Trend: ${trend}`,
        'trend-badge'
      );
    }
  }

  function renderReasons(reasons) {
    if (!el.reasons) return;

    el.reasons.replaceChildren();

    const items = (
      Array.isArray(reasons) ? reasons : [reasons]
    ).filter(Boolean).slice(0, MAX_REASONS);

    if (!items.length) {
      items.push('No additional decision reasons were supplied.');
    }

    for (const reason of items) {
      const item = document.createElement('li');
      item.textContent = String(reason);
      el.reasons.appendChild(item);
    }
  }

  function renderUsage(metadata) {
    const meta = obj(metadata);

    setText(
      'providerName',
      first(meta.provider, 'Twelve Data LIVE')
    );

    setText('providerRequests', meta.providerRequests);
    setText('dailyCreditsUsed', meta.dailyCreditsUsed);
    setText('dailyCreditsRemaining', meta.dailyCreditsRemaining);
    setText('cachedPairs', first(meta.cachedPairs, 0));

    setText(
      'provider',
      `${first(meta.provider, 'Twelve Data LIVE')} · API ${first(meta.version, '—')}`
    );
  }

  function renderHealth(payload) {
    const root = obj(payload);
    const health = obj(first(root.health, root.data, root));

    state.lastHealth = health;

    const online =
      root.ok !== false &&
      health.ok !== false &&
      health.configured === true;

    setBadge(
      el.backendStatus,
      online
        ? `API online · ${first(health.version, 'version unknown')}`
        : health.configured === false
          ? 'API key not configured'
          : 'API status unavailable',
      online
        ? 'status-badge status-online'
        : 'status-badge status-offline'
    );

    renderUsage(first(health.metadata, health.meta, health));
  }

  function renderMarket(payload) {
    const root = obj(payload);
    const market = marketFrom(root);

    const indicators = indicatorsFrom(market);
    const macd = obj(indicators.macd);
    const stochastic = obj(indicators.stochastic);
    const bands = obj(indicators.bollinger);
    const levels = obj(market.supportResistance);
    const pattern = market.candlePattern;

    state.lastMarket = market;

    const pair = String(first(
      market.pair,
      el.selectedPair?.value,
      'NO MARKET'
    ));

    setText('summaryPair', pair);
    setText('currentPrice', fmt(market.currentPrice));
    setText('entryPrice', fmt(market.entryPrice));
    setText('entryTime', date(market.entryTime));
    setText('expiryTime', date(market.expiryTime));

    const age = num(market.dataAgeSeconds);
    const freshness = String(
      first(market.freshness, 'UNKNOWN')
    ).toUpperCase();

    const safe = isFreshMarket(market);

    setText(
      'freshness',
      safe ? freshness : `NOT VERIFIED · ${freshness}`
    );

    setText(
      'dataAge',
      age === null
        ? 'Age: unavailable'
        : age < 60
          ? `Age: ${Math.round(age)} sec`
          : `Age: ${Math.floor(age / 60)} min ${Math.round(age % 60)} sec`
    );

    setBadge(
      el.marketStatus,
      safe
        ? 'Market status: fresh provider data'
        : 'Market status: verify data',
      safe
        ? 'status-badge status-online'
        : 'status-badge status-unknown'
    );

    renderTrend(first(
      obj(market.trendLine).direction,
      market.priceAction,
      'UNKNOWN'
    ));

    const signal = safe ? getSignal(market) : 'NO TRADE';

    renderSignal(signal);

    setText(
      'confidence',
      signal === 'NO TRADE'
        ? '—'
        : `${fmt(market.confidence, 0)}/100`
    );

    setText('callScore', fmt(market.callScore, 0));
    setText('putScore', fmt(market.putScore, 0));
    setText('gap', fmt(market.gap, 0));

    setText('ema9', fmt(indicators.ema9));
    setText('ema21', fmt(indicators.ema21));
    setText(
      'emaCross',
      `EMA crossover: ${first(indicators.emaCross, '—')}`
    );

    setText(
      'rsi',
      fmt(first(indicators.rsi14, indicators.rsi), 2)
    );

    setText(
      'rsiCross',
      `RSI 14: ${first(indicators.rsiZone, '—')}`
    );

    setText('macdLine', fmt(macd.line, 6));
    setText('macdSignal', fmt(macd.signal, 6));

    setText(
      'macdHistogram',
      `Histogram: ${fmt(macd.histogram, 6)}`
    );

    setText(
      'macdCross',
      `MACD: ${first(macd.crossover, '—')}`
    );

    setText('stochK', fmt(stochastic.k, 2));
    setText('stochD', fmt(stochastic.d, 2));

    setText(
      'stochasticCross',
      `Stochastic: ${first(stochastic.crossover, '—')}`
    );

    setText('bollingerUpper', fmt(bands.upper));
    setText('bollingerMiddle', fmt(bands.middle));
    setText('bollingerLower', fmt(bands.lower));

    setText('support', fmt(levels.support));
    setText('resistance', fmt(levels.resistance));

    setText(
      'volatility',
      first(market.volatility, 'NOT USED')
    );

    setText(
      'candlePattern',
      typeof pattern === 'string'
        ? pattern
        : first(obj(pattern).name, '—')
    );

    setText(
      'lastCandle',
      market.lastCandle
        ? `Latest completed candle: ${date(market.lastCandle)}`
        : 'Latest completed candle: unavailable'
    );

    setText(
      'priceAction',
      first(
        obj(market.trendLine).description,
        market.priceAction,
        'Trend-line analysis unavailable.'
      )
    );

    setText(
      'psychology',
      first(
        market.marketPsychology,
        'Market psychology unavailable.'
      )
    );

    const reasons = Array.isArray(market.reasons)
      ? market.reasons.slice()
      : [];

    if (!safe) {
      reasons.unshift(
        'NO TRADE: data freshness, price validity, or sufficiency could not be verified.'
      );
    }

    if (signal === 'NO TRADE' && reasons.length === 0) {
      reasons.push(
        'NO TRADE: evidence is insufficient or conflicting.'
      );
    }

    renderReasons(reasons);

    setText(
      'signalReason',
      !safe
        ? 'NO TRADE — data freshness or sufficiency has not been confirmed.'
        : first(
            obj(market.signal).reason,
            market.reason,
            reasons[0],
            'Evidence score, not win probability. No guaranteed outcomes.'
          )
    );

    renderUsage(root.metadata);

    setText(
      'scanInfo',
      `${pair} · 1m · latest available analysis`
    );
  }

  function getQualifiedCandidates(payload) {
    const root = obj(payload);

    const candidates = Array.isArray(root.rankedCandidates)
      ? root.rankedCandidates
      : [];

    return candidates.filter(isQualifiedCandidate);
  }

  function renderScanner(payload) {
    const root = obj(payload);
    const scanner = obj(root.scanner);
    const progress = obj(scanner.progress);

    const allCandidates = Array.isArray(root.rankedCandidates)
      ? root.rankedCandidates
      : [];

    const qualified = getQualifiedCandidates(root);

    const panel = document.querySelector('.scanner-panel');
    const scannerNode = $('scanner');

    if (panel) panel.hidden = false;

    setText('candidateCount', qualified.length);

    setText(
      'lastScanAt',
      date(first(scanner.lastScanAt, root.lastScanAt))
    );

    const running = scanner.running === true;
    const completed = num(progress.completed) || 0;
    const total = num(progress.total) || num(scanner.pairs) || PAIR_COUNT;

    setBadge(
      el.scannerStatus,
      running
        ? `Scanning ${completed}/${total}`
        : qualified.length
          ? `${qualified.length} qualified signal(s)`
          : 'No qualified signal',
      running
        ? 'status-badge status-unknown'
        : qualified.length
          ? 'status-badge status-online'
          : 'status-badge status-unknown'
    );

    if (!scannerNode) return;

    scannerNode.replaceChildren();

    if (!qualified.length) {
      const paragraph = document.createElement('p');
      paragraph.className = 'muted-text';

      paragraph.textContent = running
        ? `Scan in progress: ${completed}/${total} pairs checked. No qualified BUY/SELL signal is confirmed yet.`
        : allCandidates.length
          ? 'No candidate passed the signal and freshness checks. NO TRADE.'
          : 'No market results are available yet. Press Analyze to request a scan.';

      scannerNode.appendChild(paragraph);
      return;
    }

    const list = document.createElement('ol');
    list.className = 'candidate-list';

    for (const candidate of qualified.slice(0, 10)) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      const detail = document.createElement('p');

      const signal = getSignal(candidate);

      title.textContent =
        `${candidate.pair || 'Unknown pair'} · 1m · ${signal}`;

      detail.textContent =
        `Evidence score: ${fmt(candidate.confidence, 0)}/100 · ` +
        `Data age: ${fmt(candidate.dataAgeSeconds, 0)} sec · ` +
        String(candidate.reason || 'Evidence review.');

      item.append(title, detail);
      list.appendChild(item);
    }

    scannerNode.appendChild(list);
  }

  function setBusy(button, busy, busyText, normalText) {
    if (!button) return;

    button.disabled = busy;
    button.textContent = busy ? busyText : normalText;
  }

  function setScanBusy(busy) {
    state.scanBusy = busy;

    setBusy(
      $('backgroundScanBtn'),
      busy,
      'Scan running…',
      'Scan all 24 pairs'
    );
  }

  function stopPolling() {
    if (state.scanTimer) {
      clearInterval(state.scanTimer);
      state.scanTimer = null;
    }

    setScanBusy(false);
  }

  async function checkHealth() {
    if (state.healthBusy) return;

    state.healthBusy = true;

    try {
      const payload = await requestJson('/api/health', {
        timeout: HEALTH_TIMEOUT_MS
      });

      renderHealth(payload);
    } catch {
      setBadge(
        el.backendStatus,
        'API offline / unavailable',
        'status-badge status-offline'
      );
    } finally {
      state.healthBusy = false;
    }
  }

  async function pollScan() {
    if (!state.scanBusy) return;

    try {
      const payload = await requestJson('/api/best');

      renderScanner(payload);

      const scanner = obj(payload.scanner);
      const progress = obj(scanner.progress);

      if (scanner.running === true) {
        setText(
          'scanInfo',
          `Scanning ${num(progress.completed) || 0}/${num(progress.total) || PAIR_COUNT} pairs. Results update as data becomes available.`
        );

        return;
      }

      stopPolling();

      const diagnostic = obj(payload.diagnostic);

      setText(
        'scanInfo',
        diagnostic.lastScanError
          ? `Scan ended with provider errors: ${diagnostic.lastScanError}`
          : 'Scan stopped or completed. Only fresh, qualified signals are shown.'
      );
    } catch (error) {
      setText(
        'scanInfo',
        `Scan status temporarily unavailable: ${String(error.message || error)}`
      );
    }
  }

  function startPolling() {
    if (state.scanTimer) {
      clearInterval(state.scanTimer);
    }

    setScanBusy(true);

    state.scanTimer = setInterval(
      pollScan,
      SCAN_POLL_INTERVAL_MS
    );

    pollScan();
  }

  async function loadLatestResults() {
    const payload = await requestJson('/api/best');

    renderScanner(payload);

    const market = marketFrom(payload);

    if (market.pair && market.pair !== 'NO MARKET') {
      renderMarket(payload);
    }

    return payload;
  }

  async function analyzeAllPairs() {
    if (state.analysisBusy) return;

    state.analysisBusy = true;
    const requestId = ++state.requestId;

    clearError();

    setBusy(
      el.analyzeBtn,
      true,
      'Analyzing…',
      'Analyze all 24 pairs'
    );

    setText(
      'scanInfo',
      'Loading the latest available results before requesting a scan.'
    );

    try {
      // First show cached results without waiting for a full scan.
      try {
        const current = await loadLatestResults();

        if (requestId !== state.requestId) return;

        if (obj(current.scanner).running === true) {
          startPolling();

          setText(
            'scanInfo',
            'A scan is already running. Showing available results while it continues.'
          );

          return;
        }
      } catch {
        // Continue and attempt to request a scan.
      }

      try {
        const started = await requestJson('/api/scan', {
          method: 'POST',
          body: {},
          timeout: REQUEST_TIMEOUT_MS
        });

        if (requestId !== state.requestId) return;

        if (started.ok === true) {
          startPolling();

          setText(
            'scanInfo',
            first(
              started.message,
              'The 24-pair scan started in the background.'
            )
          );
        } else {
          setText(
            'scanInfo',
            first(
              started.message,
              'A new scan could not be started.'
            )
          );
        }
      } catch (error) {
        if (error.status === 409) {
          startPolling();

          setText(
            'scanInfo',
            'A full scan is already running. Monitoring its progress.'
          );
        } else if (error.status === 429) {
          // Cooldown or daily credits: keep the latest results visible.
          try {
            await loadLatestResults();
          } catch {
            // Preserve the original cooldown message.
          }

          setText(
            'scanInfo',
            first(
              error.message,
              'A new scan is not available yet. Stored results may not be new.'
            )
          );
        } else {
          throw error;
        }
      }
    } catch (error) {
      showError(String(error.message || error));

      setText(
        'signalReason',
        'Analysis could not be confirmed. Do not infer BUY or SELL from an error.'
      );

      renderSignal('NO TRADE');
    } finally {
      state.analysisBusy = false;

      setBusy(
        el.analyzeBtn,
        false,
        '',
        'Analyze all 24 pairs'
      );
    }
  }

  function ensureScanButton() {
    let button = $('backgroundScanBtn');

    if (!button) {
      button = document.createElement('button');
      button.id = 'backgroundScanBtn';
      button.type = 'button';
      button.textContent = 'Scan all 24 pairs';
      button.style.marginTop = '10px';

      el.analyzeBtn?.insertAdjacentElement('afterend', button);
    }

    if (button.dataset.listenerAttached !== 'true') {
      button.addEventListener('click', analyzeAllPairs);
      button.dataset.listenerAttached = 'true';
    }
  }

  function bindEvents() {
    ensureScanButton();

    if (el.analyzeBtn &&
        el.analyzeBtn.dataset.listenerAttached !== 'true') {
      el.analyzeBtn.textContent = 'Analyze all 24 pairs';
      el.analyzeBtn.addEventListener('click', analyzeAllPairs);
      el.analyzeBtn.dataset.listenerAttached = 'true';
    }

    if (el.selectedPair &&
        el.selectedPair.dataset.listenerAttached !== 'true') {
      el.selectedPair.addEventListener('change', () => {
        setText(
          'scanInfo',
          `Selected pair: ${el.selectedPair.value}. Analyze reviews the available 24-pair results.`
        );
      });

      el.selectedPair.dataset.listenerAttached = 'true';
    }

    if (el.timeframe) {
      // This strategy uses completed 1-minute candles only.
      el.timeframe.value = '1';
      el.timeframe.disabled = true;
    }
  }

  async function initialize() {
    bindEvents();

    await checkHealth();

    try {
      const current = await loadLatestResults();
      const scanner = obj(current.scanner);

      if (scanner.running === true) {
        startPolling();

        setText(
          'scanInfo',
          'A scan is already running. Showing results as they update.'
        );
      } else {
        setText(
          'scanInfo',
          'Ready. Press Analyze all 24 pairs to review available results and request a scan.'
        );
      }
    } catch (error) {
      setText(
        'scanInfo',
        `API data could not be loaded: ${String(error.message || error)}`
      );
    }

    if (state.healthTimer) {
      clearInterval(state.healthTimer);
    }

    state.healthTimer = setInterval(
      checkHealth,
      HEALTH_INTERVAL_MS
    );
  }

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
