
'use strict';

(() => {
  const API_BASE = String(
    window.PO_API_BASE || 'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  // Selected-pair mode: no automatic /api/best scanner.
  const REFRESH_INTERVAL_MS = 60000;
  const REQUEST_TIMEOUT_MS = 90000;
  const MAX_REASONS = 10;
  const MAX_DATA_AGE_SECONDS = 300;
  const ALLOWED_TIMEFRAMES = new Set(['1', '2', '3']);

  const $ = id => document.getElementById(id);

  const state = {
    busy: false,
    timer: null,
    healthBusy: false,
    lastMarket: null,
    lastHealth: null,
    rerunRequested: false,
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

    if (seconds === null || seconds < 0) {
      return 'Age: unavailable';
    }

    if (seconds < 60) {
      return `Age: ${Math.round(seconds)} sec`;
    }

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

    if (['CALL', 'BUY', 'UP', 'BULLISH'].includes(signal)) {
      return 'CALL';
    }

    if (['PUT', 'SELL', 'DOWN', 'BEARISH'].includes(signal)) {
      return 'PUT';
    }

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

  function getSignalReason(market) {
    const signal = obj(market.signal);

    return first(
      signal.reason,
      market.reason,
      Array.isArray(market.reasons) ? market.reasons[0] : null,
      'Evidence is insufficient or conflicting; no validated trade signal is available.'
    );
  }

  function freshnessOf(market) {
    return String(first(market.freshness, 'UNKNOWN')).toUpperCase();
  }

  // NO TRADE alone does not mean the data is stale.
  // Signal quality and data freshness are checked separately.
  function isUnsafe(market) {
    const freshness = freshnessOf(market);
    const age = number(market.dataAgeSeconds);

    return (
      freshness !== 'FRESH' ||
      age === null ||
      age < 0 ||
      age > MAX_DATA_AGE_SECONDS ||
      market.insufficientData === true
    );
  }

  function renderSignal(signal) {
    if (signal === 'CALL') {
      setBadge(
        elements.signalBadge,
        'CALL',
        'signal-badge signal-call'
      );
    } else if (signal === 'PUT') {
      setBadge(
        elements.signalBadge,
        'PUT',
        'signal-badge signal-put'
      );
    } else {
      setBadge(
        elements.signalBadge,
        'NO TRADE',
        'signal-badge signal-wait'
      );
    }
  }

  function renderTrend(value) {
    const trend = String(value || 'UNKNOWN').toUpperCase();

    if (
      trend.includes('BULL') ||
      trend === 'CALL' ||
      trend === 'UP'
    ) {
      setBadge(
        elements.trendBadge,
        'Trend: BULLISH',
        'trend-badge trend-up'
      );
    } else if (
      trend.includes('BEAR') ||
      trend === 'PUT' ||
      trend === 'DOWN'
    ) {
      setBadge(
        elements.trendBadge,
        'Trend: BEARISH',
        'trend-badge trend-down'
      );
    } else {
      setBadge(
        elements.trendBadge,
        `Trend: ${trend}`,
        'trend-badge'
      );
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

    const pair = String(first(
      market.pair,
      elements.selectedPair && elements.selectedPair.value,
      'EUR/USD'
    ));

    const timeframe = String(first(
      market.timeframe,
      elements.timeframe && elements.timeframe.value,
      '1'
    ));

    text('summaryPair', pair);

    if (
      elements.selectedPair &&
      [...elements.selectedPair.options].some(option => option.value === pair)
    ) {
      elements.selectedPair.value = pair;
    }

    if (
      elements.timeframe &&
      ALLOWED_TIMEFRAMES.has(timeframe)
    ) {
      elements.timeframe.value = timeframe;
    }

    text(
      'scanInfo',
      `${pair} · ${timeframe}m · selected-pair analysis received`
    );

    const freshness = freshnessOf(market);
    const age = number(market.dataAgeSeconds);
    const unsafe = isUnsafe(market);

    text(
      'freshness',
      unsafe && freshness === 'FRESH' ? 'CHECK DATA' : freshness
    );

    text('dataAge', ageText(age));
    text('currentPrice', fmt(market.currentPrice));
    text('entryPrice', fmt(market.entryPrice));

    setBadge(
      elements.marketStatus,
      unsafe
        ? 'Market status: verify data'
        : 'Market status: fresh provider data',
      unsafe
        ? 'status-badge status-unknown'
        : 'status-badge status-online'
    );

    renderTrend(first(indicators.trend5m, 'UNKNOWN'));

    let signal = normalizeSignal(market);

    if (unsafe) signal = 'NO TRADE';

    renderSignal(signal);

    text(
      'confidence',
      signal === 'NO TRADE' ? '—' : fmt(market.confidence, 0)
    );

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

    text(
      'emaCross',
      `Crossover: ${first(indicators.emaCross, '—')}`
    );

    text(
      'rsiCross',
      `RSI cross: ${first(indicators.rsiCross, '—')}`
    );

    text(
      'trend5m',
      `5m trend: ${first(indicators.trend5m, '—')}`
    );

    const macd = obj(indicators.macd);

    text('macdLine', fmt(macd.line, 6));
    text('macdSignal', fmt(macd.signal, 6));

    text(
      'macdHistogram',
      `Histogram: ${fmt(macd.histogram, 6)}`
    );

    text(
      'macdCross',
      `MACD cross: ${first(macd.crossover, '—')}`
    );

    const stochastic = obj(indicators.stochastic);

    text('stochK', fmt(stochastic.k, 2));
    text('stochD', fmt(stochastic.d, 2));

    text(
      'stochasticCross',
      `Stochastic cross: ${first(stochastic.crossover, '—')}`
    );

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
      typeof pattern === 'string'
        ? pattern
        : first(obj(pattern).name, '—')
    );

    text(
      'lastCandle',
      market.lastCandle
        ? `Latest completed candle: ${date(market.lastCandle)}`
        : 'Latest completed candle: unavailable'
    );

    text(
      'priceAction',
      first(market.priceAction, 'Price-action interpretation unavailable.')
    );

    text(
      'psychology',
      first(market.marketPsychology, 'Market psychology unavailable.')
    );

    const reasons = Array.isArray(market.reasons)
      ? market.reasons.slice()
      : [];

    if (unsafe) {
      reasons.unshift(
        'NO TRADE: data freshness, data age, or data sufficiency could not be verified.'
      );
    } else if (signal === 'NO TRADE' && !reasons.length) {
      reasons.push(
        'NO TRADE: evidence is insufficient or conflicting.'
      );
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

  function resetMarketAfterFailure(message) {
    state.lastMarket = null;

    renderSignal('NO TRADE');

    setBadge(
      elements.marketStatus,
      'Market status: analysis failed',
      'status-badge status-offline'
    );

    text('freshness', 'UNKNOWN');
    text('dataAge', 'Age: unavailable');
    text('confidence', '—');
    text('entryTime', '—');
    text('expiryTime', '—');
    text('currentPrice', '—');
    text('entryPrice', '—');
    text('callScore', '—');
    text('putScore', '—');
    text('gap', '—');

    text(
      'signalReason',
      'NO TRADE — analysis failed or could not be verified.'
    );

    text(
      'scanInfo',
      'Analysis failed. No new signal was generated.'
    );

    renderReasons([
      message,
      'Do not infer a trade from a failed request.'
    ]);
  }

  async function fetchJson(path) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });

      const raw = await response.text();

      let payload;

      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          `API returned invalid JSON (${response.status}).`
        );
      }

      if (!response.ok || payload.ok === false) {
        throw new Error(String(first(
          payload.error,
          payload.message,
          `API request failed (${response.status}).`
        )));
      }

      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkHealth() {
    if (state.healthBusy) return;

    state.healthBusy = true;

    try {
      renderHealth(await fetchJson('/api/health'));
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

  async function analyzeMarket() {
    // If the user changes pair/timeframe during an active request,
    // queue one more request using the latest selected values.
    if (state.busy) {
      state.rerunRequested = true;
      return;
    }

    state.busy = true;
    state.rerunRequested = false;

    const sequence = ++state.requestSequence;

    clearError();

    if (elements.analyzeBtn) {
      elements.analyzeBtn.disabled = true;
      elements.analyzeBtn.textContent = 'Analyzing…';
    }

    const pair =
      elements.selectedPair && elements.selectedPair.value || 'EUR/USD';

    const timeframe =
      elements.timeframe && elements.timeframe.value || '1';

    try {
      if (!ALLOWED_TIMEFRAMES.has(String(timeframe))) {
        throw new Error('Unsupported timeframe. Choose 1, 2, or 3 minutes.');
      }

      const query = new URLSearchParams({ pair, timeframe });

      const payload = await fetchJson(
        `/api/analyze?${query.toString()}`
      );

      if (sequence === state.requestSequence) {
        const returnedMarket = marketFrom(payload);
        const returnedPair = String(first(returnedMarket.pair, ''));

        // Do not render a result for a different pair than requested.
        if (returnedPair && returnedPair !== pair) {
          throw new Error('The API returned a different pair than requested.');
        }

        renderMarket(payload);
      }
    } catch (error) {
      const message = error.name === 'AbortError'
        ? 'The API request timed out. No new signal is available.'
        : String(error.message || 'Unable to analyze the market.');

      if (sequence === state.requestSequence) {
        showError(message);
        resetMarketAfterFailure(message);
      }
    } finally {
      state.busy = false;

      if (elements.analyzeBtn) {
        elements.analyzeBtn.disabled = false;
        elements.analyzeBtn.textContent = 'Analyze market';
      }

      if (state.rerunRequested) {
        state.rerunRequested = false;
        analyzeMarket();
      }
    }
  }

  function bindEvents() {
    if (elements.analyzeBtn) {
      elements.analyzeBtn.addEventListener('click', analyzeMarket);
    }

    if (elements.selectedPair) {
      elements.selectedPair.addEventListener('change', analyzeMarket);
    }

    if (elements.timeframe) {
      elements.timeframe.addEventListener('change', analyzeMarket);
    }

    // Mode A deliberately hides the legacy 24-pair scanner.
    const scannerPanel = document.querySelector('.scanner-panel');

    if (scannerPanel) {
      scannerPanel.hidden = true;
    }

    const controlHeading = document.querySelector(
      '.control-panel .section-heading h2'
    );

    if (controlHeading) {
      controlHeading.textContent = 'Selected market analysis';
    }

    const controlDescription = document.querySelector(
      '.control-panel .section-heading p'
    );

    if (controlDescription) {
      controlDescription.textContent =
        'Choose one forex pair and a 1m, 2m, or 3m analysis timeframe.';
    }
  }

  async function initialize() {
    bindEvents();

    await checkHealth();
    await analyzeMarket();

    if (state.timer) clearInterval(state.timer);

    state.timer = setInterval(() => {
      checkHealth();
      analyzeMarket();
    }, REFRESH_INTERVAL_MS);
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
