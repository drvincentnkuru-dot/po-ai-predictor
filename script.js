
'use strict';

(() => {
  const API_BASE = String(
    window.PO_API_BASE || 'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const HEALTH_INTERVAL_MS = 60000;
  const SCAN_POLL_INTERVAL_MS = 5000;
  const REQUEST_TIMEOUT_MS = 28000;
  const MAX_DATA_AGE_SECONDS = 300;
  const MAX_REASONS = 10;

  const $ = id => document.getElementById(id);

  const state = {
    healthBusy: false,
    analysisBusy: false,
    scanBusy: false,
    scanTimer: null,
    lastMarket: null,
    lastHealth: null,
    requestSequence: 0
  };

  const elements = {
    backendStatus: $('backendStatus'),
    analyzeBtn: $('analyzeBtn'),
    errorBox: $('errorBox'),
    selectedPair: $('selectedPair'),
    timeframe: $('timeframe'),
    marketStatus: $('marketStatus'),
    trendBadge: $('trendBadge'),
    signalBadge: $('signalBadge'),
    confidence: $('confidence'),
    entryTime: $('entryTime'),
    expiryTime: $('expiryTime'),
    entryPrice: $('entryPrice'),
    callScore: $('callScore'),
    putScore: $('putScore'),
    support: $('support'),
    resistance: $('resistance'),
    gap: $('gap'),
    volatility: $('volatility'),
    dataAge: $('dataAge'),
    currentPrice: $('currentPrice'),
    freshness: $('freshness'),
    ema9: $('ema9'),
    ema21: $('ema21'),
    rsi: $('rsi'),
    adx: $('adx'),
    atr: $('atr'),
    bollingerUpper: $('bollingerUpper'),
    bollingerMiddle: $('bollingerMiddle'),
    bollingerLower: $('bollingerLower'),
    psychology: $('psychology'),
    priceAction: $('priceAction'),
    reasons: $('reasons'),
    lastCandle: $('lastCandle'),
    scanInfo: $('scanInfo'),
    provider: $('provider'),
    providerRequests: $('providerRequests'),
    dailyCreditsUsed: $('dailyCreditsUsed'),
    dailyCreditsRemaining: $('dailyCreditsRemaining'),
    cachedPairs: $('cachedPairs'),
    candidateCount: $('candidateCount'),
    scannerStatus: $('scannerStatus'),
    lastScanAt: $('lastScanAt'),
    summaryPair: $('summaryPair'),
    signalReason: $('signalReason'),
    macdLine: $('macdLine'),
    macdSignal: $('macdSignal'),
    macdHistogram: $('macdHistogram'),
    macdCross: $('macdCross'),
    stochK: $('stochK'),
    stochD: $('stochD'),
    stochasticCross: $('stochasticCross'),
    emaCross: $('emaCross'),
    rsiCross: $('rsiCross'),
    trend5m: $('trend5m'),
    ema21_5m: $('ema21_5m'),
    candlePattern: $('candlePattern'),
    providerName: $('providerName')
  };

  function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  function first(...values) {
    return values.find(
      value => value !== undefined && value !== null && value !== ''
    );
  }

  function number(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(value, digits = 5) {
    const n = number(value);
    if (n === null) return '—';

    return n.toLocaleString(undefined, {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0
    });
  }

  function date(value) {
    if (!value) return '—';

    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);

    return d.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function ageText(value) {
    const seconds = number(value);

    if (seconds === null || seconds < 0) return 'Age: unavailable';
    if (seconds < 60) return `Age: ${Math.round(seconds)} sec`;

    if (seconds < 3600) {
      return `Age: ${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} sec`;
    }

    return `Age: ${Math.floor(seconds / 3600)} hr ${Math.floor((seconds % 3600) / 60)} min`;
  }

  function text(id, value, fallback = '—') {
    const element = $(id);
    if (!element) return;

    element.textContent =
      value === null || value === undefined || value === ''
        ? fallback
        : String(value);
  }

  function setBadge(element, label, className) {
    if (!element) return;
    element.textContent = label;
    element.className = className;
  }

  function showError(message) {
    if (!elements.errorBox) return;
    elements.errorBox.textContent = String(message);
    elements.errorBox.hidden = false;
  }

  function clearError() {
    if (!elements.errorBox) return;
    elements.errorBox.textContent = '';
    elements.errorBox.hidden = true;
  }

  function normalizeSignal(market) {
    const data = obj(market);
    const signalObject = obj(data.signal);

    if (
      data.noTrade === true ||
      data.tradeAllowed === false ||
      signalObject.noTrade === true ||
      signalObject.tradeAllowed === false
    ) {
      return 'NO TRADE';
    }

    const raw = typeof data.signal === 'string'
      ? data.signal
      : first(
          signalObject.action,
          signalObject.direction,
          data.action,
          data.direction,
          data.signalAction
        );

    const signal = String(raw || '').trim().toUpperCase();

    if (['CALL', 'BUY', 'UP', 'BULLISH'].includes(signal)) return 'CALL';
    if (['PUT', 'SELL', 'DOWN', 'BEARISH'].includes(signal)) return 'PUT';

    return 'NO TRADE';
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

  function getIndicators(market) {
    return obj(market.indicators);
  }

  function freshnessOf(market) {
    return String(first(market.freshness, 'UNKNOWN')).toUpperCase();
  }

  function isUnsafe(market) {
    const age = number(market.dataAgeSeconds);

    return (
      freshnessOf(market) !== 'FRESH' ||
      age === null ||
      age < 0 ||
      age > MAX_DATA_AGE_SECONDS ||
      market.insufficientData === true
    );
  }

  function getSignalReason(market) {
    const signal = obj(market.signal);

    return first(
      signal.reason,
      market.reason,
      Array.isArray(market.reasons) ? market.reasons[0] : null,
      'Evidence is insufficient or conflicting; no validated trade signal is available.'
    );
  }

  function renderSignal(signal) {
    if (signal === 'CALL') {
      setBadge(elements.signalBadge, 'CALL', 'signal-badge signal-call');
    } else if (signal === 'PUT') {
      setBadge(elements.signalBadge, 'PUT', 'signal-badge signal-put');
    } else {
      setBadge(elements.signalBadge, 'NO TRADE', 'signal-badge signal-wait');
    }
  }

  function renderTrend(value) {
    const trend = String(value || 'UNKNOWN').toUpperCase();

    if (trend.includes('BULL') || trend === 'CALL' || trend === 'UP') {
      setBadge(elements.trendBadge, 'Trend: BULLISH', 'trend-badge trend-up');
    } else if (trend.includes('BEAR') || trend === 'PUT' || trend === 'DOWN') {
      setBadge(elements.trendBadge, 'Trend: BEARISH', 'trend-badge trend-down');
    } else {
      setBadge(elements.trendBadge, `Trend: ${trend}`, 'trend-badge');
    }
  }

  function renderReasons(reasons) {
    if (!elements.reasons) return;

    elements.reasons.replaceChildren();

    const items = (
      Array.isArray(reasons) ? reasons : [reasons]
    ).filter(Boolean).slice(0, MAX_REASONS);

    if (!items.length) {
      items.push('The API did not provide detailed decision reasons.');
    }

    for (const reason of items) {
      const li = document.createElement('li');
      li.textContent = String(reason);
      elements.reasons.appendChild(li);
    }
  }

  function renderUsage(metadata) {
    const meta = obj(metadata);

    text('providerName', first(meta.provider, 'Twelve Data LIVE'));
    text('providerRequests', first(meta.providerRequests, '—'));
    text('dailyCreditsUsed', first(meta.dailyCreditsUsed, '—'));
    text('dailyCreditsRemaining', first(meta.dailyCreditsRemaining, '—'));
    text('cachedPairs', first(meta.cachedPairs, 0));

    if (elements.provider) {
      elements.provider.textContent =
        `Provider: ${first(meta.provider, 'Twelve Data LIVE')} · API ${first(meta.version, '—')}`;
    }
  }

  function renderHealth(payload) {
    const root = obj(payload);
    const health = obj(first(root.health, root.data, root));

    state.lastHealth = health;

    const configured = health.configured === true;
    const online = health.ok === true && configured;

    setBadge(
      elements.backendStatus,
      online
        ? `API online · ${first(health.version, 'version unknown')}`
        : !configured
          ? 'API key missing or not configured'
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

    state.lastMarket = market;

    const indicators = getIndicators(market);
    const pair = String(first(market.pair, 'NO MARKET'));
    const timeframe = String(first(market.timeframe, '—'));

    text('summaryPair', pair);
    text('scanInfo', `${pair} · ${timeframe}m · analysis result received`);

    const freshness = freshnessOf(market);
    const age = number(market.dataAgeSeconds);
    const unsafe = isUnsafe(market);

    text('freshness', unsafe && freshness === 'FRESH' ? 'CHECK DATA' : freshness);
    text('dataAge', ageText(age));
    text('currentPrice', fmt(market.currentPrice));
    text('entryPrice', fmt(market.entryPrice));

    setBadge(
      elements.marketStatus,
      unsafe ? 'Market status: verify data' : 'Market status: fresh provider data',
      unsafe ? 'status-badge status-unknown' : 'status-badge status-online'
    );

    renderTrend(first(indicators.trend5m, 'UNKNOWN'));

    let signal = normalizeSignal(market);
    if (unsafe) signal = 'NO TRADE';

    renderSignal(signal);

    text('confidence', signal === 'NO TRADE' ? '—' : fmt(market.confidence, 0));
    text('callScore', fmt(market.callScore, 0));
    text('putScore', fmt(market.putScore, 0));
    text('gap', fmt(market.gap, 0));
    text('entryTime', date(market.entryTime));
    text('expiryTime', date(market.expiryTime));

    text('ema9', fmt(indicators.ema9));
    text('ema21', fmt(indicators.ema21));
    text('rsi', fmt(first(indicators.rsi9, indicators.rsi), 2));
    text('adx', fmt(first(indicators.adx14, indicators.adx), 2));
    text('atr', fmt(first(indicators.atr14, indicators.atr)));
    text('ema21_5m', fmt(indicators.ema21_5m));

    text('emaCross', `Crossover: ${first(indicators.emaCross, '—')}`);
    text('rsiCross', `RSI cross: ${first(indicators.rsiCross, '—')}`);
    text('trend5m', `5m trend: ${first(indicators.trend5m, '—')}`);

    const macd = obj(indicators.macd);
    text('macdLine', fmt(macd.line, 6));
    text('macdSignal', fmt(macd.signal, 6));
    text('macdHistogram', `Histogram: ${fmt(macd.histogram, 6)}`);
    text('macdCross', `MACD cross: ${first(macd.crossover, '—')}`);

    const stochastic = obj(indicators.stochastic);
    text('stochK', fmt(stochastic.k, 2));
    text('stochD', fmt(stochastic.d, 2));
    text('stochasticCross', `Stochastic cross: ${first(stochastic.crossover, '—')}`);

    const bands = obj(indicators.bollinger);
    text('bollingerUpper', fmt(bands.upper));
    text('bollingerMiddle', fmt(first(bands.middle, bands.mid)));
    text('bollingerLower', fmt(bands.lower));

    const levels = obj(market.supportResistance);
    text('support', fmt(levels.support));
    text('resistance', fmt(levels.resistance));
    text('volatility', first(market.volatility, 'UNKNOWN'));

    const pattern = market.candlePattern;
    text(
      'candlePattern',
      typeof pattern === 'string' ? pattern : first(obj(pattern).name, '—')
    );

    text(
      'lastCandle',
      market.lastCandle
        ? `Latest completed candle: ${date(market.lastCandle)}`
        : 'Latest completed candle: unavailable'
    );

    text('priceAction', first(market.priceAction, 'Price-action interpretation unavailable.'));
    text('psychology', first(market.marketPsychology, 'Market psychology unavailable.'));

    const reasons = Array.isArray(market.reasons) ? market.reasons.slice() : [];

    if (unsafe) {
      reasons.unshift('NO TRADE: data freshness, data age, or data sufficiency could not be verified.');
    } else if (signal === 'NO TRADE' && !reasons.length) {
      reasons.push('NO TRADE: evidence is insufficient or conflicting.');
    }

    renderReasons(reasons);

    text(
      'signalReason',
      unsafe
        ? 'NO TRADE — data freshness or sufficiency has not been confirmed.'
        : getSignalReason(market)
    );

    renderUsage(root.metadata);
  }

  async function requestJson(path, options = {}) {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: options.method || 'GET',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal
      });

      const raw = await response.text();
      let payload;

      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(`API returned invalid JSON (${response.status}).`);
      }

      if (!response.ok || payload.ok === false) {
        throw new Error(String(first(
          payload.error,
          payload.message,
          `API request failed (${response.status}).`
        )));
      }

      return payload;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('The request took too long. No new signal was generated; please retry.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkHealth() {
    if (state.healthBusy) return;
    state.healthBusy = true;

    try {
      renderHealth(await requestJson('/api/health'));
    } catch {
      setBadge(
        elements.backendStatus,
        'API offline / unavailable',
        'status-badge status-offline'
      );
    } finally {
      state.healthBusy = false;
    }
  }

  function renderScanner(payload) {
    const root = obj(payload);
    const scanner = obj(root.scanner);
    const progress = obj(scanner.progress);

    const candidates = Array.isArray(root.rankedCandidates)
      ? root.rankedCandidates
      : [];

    const scannerPanel = document.querySelector('.scanner-panel');
    const scannerElement = $('scanner');

    if (scannerPanel) scannerPanel.hidden = false;

    text('cachedPairs', first(root.metadata && root.metadata.cachedPairs, 0));
    text('candidateCount', candidates.length);
    text('lastScanAt', date(first(scanner.lastScanAt, root.lastScanAt)));

    const running = scanner.running === true;
    const completed = number(progress.completed) || 0;
    const total = number(progress.total) || number(scanner.pairs) || 24;

    setBadge(
      elements.scannerStatus,
      running
        ? `Scanning ${completed}/${total}`
        : candidates.length
          ? `${candidates.length} qualified candidate(s)`
          : 'No qualified signal',
      running
        ? 'status-badge status-unknown'
        : 'status-badge status-online'
    );

    if (scannerPanel && scannerPanel.hidden) scannerPanel.hidden = false;

    if (!scannerElement) return;
    scannerElement.replaceChildren();

    if (!candidates.length) {
      const p = document.createElement('p');
      p.className = 'muted-text';
      p.textContent = running
        ? `Background scan in progress: ${completed}/${total} pairs processed.`
        : 'No candidate passed all evidence and freshness checks. NO TRADE is valid.';
      scannerElement.appendChild(p);
      return;
    }

    const list = document.createElement('ol');
    list.className = 'candidate-list';

    for (const candidate of candidates.slice(0, 10)) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');

      strong.textContent =
        `${candidate.pair} · ${candidate.timeframe}m · ${candidate.signal}`;

      const detail = document.createElement('p');
      detail.textContent =
        `Evidence score: ${fmt(candidate.confidence, 0)}/100 · ${String(candidate.reason || 'Evidence review.')}`;

      li.append(strong, detail);
      list.appendChild(li);
    }

    scannerElement.appendChild(list);
  }

  function stopScanPolling() {
    if (state.scanTimer) {
      clearInterval(state.scanTimer);
      state.scanTimer = null;
    }
  }

  async function pollBackgroundScan() {
    if (state.scanBusy) return;
    state.scanBusy = true;

    try {
      const payload = await requestJson('/api/best');
      renderScanner(payload);

      const scanner = obj(payload.scanner);

      if (scanner.running === true) {
        text(
          'scanInfo',
          `Background scan running: ${number(obj(scanner.progress).completed) || 0}/${number(obj(scanner.progress).total) || 24} pairs. You can continue analysing an individual pair.`
        );
        return;
      }

      stopScanPolling();

      text(
        'scanInfo',
        `Background scan stopped or completed. Last scan: ${date(scanner.lastScanAt)}.`
      );

      if (state.scanButton) {
        state.scanButton.disabled = false;
        state.scanButton.textContent = 'Scan all 24 pairs in background';
      }
    } catch (error) {
      text('scanInfo', `Could not refresh background scan status: ${error.message}`);
    } finally {
      state.scanBusy = false;
    }
  }

  async function analyzeMarket() {
    if (state.analysisBusy) return;

    state.analysisBusy = true;
    const sequence = ++state.requestSequence;

    clearError();

    const pair = elements.selectedPair ? elements.selectedPair.value : 'EUR/USD';
    const timeframe = elements.timeframe ? elements.timeframe.value : '1';

    if (elements.analyzeBtn) {
      elements.analyzeBtn.disabled = true;
      elements.analyzeBtn.textContent = 'Analysing selected pair…';
    }

    text('scanInfo', `Analysing ${pair} on the ${timeframe}-minute timeframe…`);

    try {
      const query = new URLSearchParams({ pair, timeframe });
      const payload = await requestJson(`/api/analyze?${query.toString()}`);

      if (sequence !== state.requestSequence) return;

      renderMarket(payload);
      renderUsage(payload.metadata);

      const market = marketFrom(payload);
      const signal = normalizeSignal(market);

      if (isUnsafe(market)) {
        text('scanInfo', `${pair} analysis returned, but the data is not fresh enough for a trade.`);
      } else if (signal === 'NO TRADE') {
        text('scanInfo', `${pair} analysis complete. Evidence did not qualify for a trade.`);
      } else {
        text('scanInfo', `${pair} analysis complete · ${signal} · evidence score ${fmt(market.confidence, 0)}/100.`);
      }
    } catch (error) {
      showError(error.message || 'Unable to analyse this pair.');
      text('scanInfo', 'Analysis failed. No new signal was generated.');
      renderSignal('NO TRADE');
      text('confidence', '—');
      text('signalReason', 'No trade: the analysis request failed or data could not be verified.');
      renderReasons([
        error.message || 'Analysis request failed.',
        'Do not infer a trade from a failed request.'
      ]);
    } finally {
      state.analysisBusy = false;

      if (elements.analyzeBtn) {
        elements.analyzeBtn.disabled = false;
        elements.analyzeBtn.textContent = 'Analyse selected pair';
      }
    }
  }

  async function startBackgroundScan() {
    if (state.scanBusy) return;

    clearError();

    if (state.scanButton) {
      state.scanButton.disabled = true;
      state.scanButton.textContent = 'Starting background scan…';
    }

    try {
      const payload = await requestJson('/api/scan', {
        method: 'POST',
        body: {},
        timeoutMs: 10000
      });

      renderScanner(payload);
      text(
        'scanInfo',
        'Background scan requested. You can analyse a selected pair without waiting for all 24 pairs.'
      );

      stopScanPolling();
      state.scanTimer = setInterval(pollBackgroundScan, SCAN_POLL_INTERVAL_MS);
      await pollBackgroundScan();
    } catch (error) {
      showError(error.message || 'Could not start the background scan.');

      if (state.scanButton) {
        state.scanButton.disabled = false;
        state.scanButton.textContent = 'Scan all 24 pairs in background';
      }

      text('scanInfo', 'Background scan was not started. You can still analyse one pair.');
    }
  }

  function bindEvents() {
    const controlGrid = document.querySelector('.control-grid');
    if (controlGrid) controlGrid.hidden = false;

    const controlHeading = document.querySelector(
      '.control-panel .section-heading h2'
    );
    if (controlHeading) controlHeading.textContent = 'Quick selected-pair analysis';

    const controlDescription = document.querySelector(
      '.control-panel .section-heading p'
    );
    if (controlDescription) {
      controlDescription.textContent =
        'Analyse one forex pair first. The full 24-pair scan can run separately in the background.';
    }

    if (elements.analyzeBtn) {
      elements.analyzeBtn.textContent = 'Analyse selected pair';
      elements.analyzeBtn.addEventListener('click', analyzeMarket);
    }

    const controlPanel = document.querySelector('.control-panel');

    if (controlPanel && !document.getElementById('backgroundScanBtn')) {
      const button = document.createElement('button');
      button.id = 'backgroundScanBtn';
      button.type = 'button';
      button.textContent = 'Scan all 24 pairs in background';
      button.style.marginTop = '12px';
      button.addEventListener('click', startBackgroundScan);

      controlPanel.appendChild(button);
      state.scanButton = button;
    }

    const scannerPanel = document.querySelector('.scanner-panel');
    if (scannerPanel) scannerPanel.hidden = false;
  }

  async function initialize() {
    bindEvents();

    await checkHealth();

    try {
      const current = await requestJson('/api/best');
      renderScanner(current);

      const scanner = obj(current.scanner);

      if (scanner.running === true) {
        text('scanInfo', 'A background scan is already running. You can analyse a selected pair now.');
        state.scanTimer = setInterval(pollBackgroundScan, SCAN_POLL_INTERVAL_MS);
      } else if (scanner.lastScanAt) {
        text('scanInfo', `Previous full scan: ${date(scanner.lastScanAt)}. Select a pair to analyse it now.`);
      } else {
        text('scanInfo', 'Ready. Select a pair and press Analyse selected pair.');
      }
    } catch {
      text('scanInfo', 'API status could not be loaded. Check the backend connection.');
    }

    setInterval(checkHealth, HEALTH_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
