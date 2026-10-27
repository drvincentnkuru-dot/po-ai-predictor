'use strict';

(() => {
  const API_BASE = String(
    window.PO_API_BASE || 'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const REFRESH_INTERVAL_MS = 60000;
  const REQUEST_TIMEOUT_MS = 90000;
  const MAX_REASONS = 10;

  const $ = id => document.getElementById(id);

  const state = {
    busy: false,
    timer: null,
    lastMarket: null,
    lastHealth: null
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
    scanner: $('scanner'),
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

  function text(id, value, fallback = '—') {
    const element = $(id);
    if (!element) return;
    element.textContent = value === null || value === undefined || value === ''
      ? fallback
      : String(value);
  }

  function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  function first(...values) {
    return values.find(value => value !== undefined && value !== null);
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
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString([], {
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
    const raw = typeof data.signal === 'string'
      ? data.signal
      : first(
          obj(data.signal).action,
          obj(data.signal).direction,
          data.action,
          data.direction,
          data.signalAction
        );

    if (
      data.noTrade === true ||
      data.tradeAllowed === false ||
      obj(data.signal).noTrade === true ||
      obj(data.signal).tradeAllowed === false
    ) return 'NO TRADE';

    const signal = String(raw || '').trim().toUpperCase();
    if (['CALL', 'BUY', 'UP', 'BULLISH'].includes(signal)) return 'CALL';
    if (['PUT', 'SELL', 'DOWN', 'BEARISH'].includes(signal)) return 'PUT';
    return 'NO TRADE';
  }

  function marketFrom(payload) {
    const root = obj(payload);
    return obj(first(root.selectedMarket, root.market, root.best, root.result, root.data, root));
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
      'No validated trade signal is available.'
    );
  }

  function getScore(market, direction) {
    const value = number(direction === 'CALL' ? market.callScore : market.putScore);
    return value === null ? 0 : Math.max(0, Math.min(100, value));
  }

  function freshnessOf(market) {
    return String(first(market.freshness, 'UNKNOWN')).toUpperCase();
  }

  function isUnsafe(market) {
    const freshness = freshnessOf(market);
    const age = number(market.dataAgeSeconds);
    return (
      !['FRESH'].includes(freshness) ||
      (age !== null && age > 300) ||
      market.insufficientData === true ||
      market.noTrade === true
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

    const list = Array.isArray(reasons) ? reasons : [reasons];
    const items = list.filter(Boolean).slice(0, MAX_REASONS);
    if (!items.length) items.push('No detailed reasons were supplied by the API.');

    for (const reason of items) {
      const li = document.createElement('li');
      li.textContent = String(reason);
      elements.reasons.appendChild(li);
    }
  }

  function renderHealth(payload) {
    const root = obj(payload);
    const health = obj(first(root.health, root.data, root));
    state.lastHealth = health;

    const online = health.ok === true && health.configured !== false;
    setBadge(
      elements.backendStatus,
      online ? 'API online' : health.configured === false ? 'API key missing' : 'API status unknown',
      online ? 'status-badge status-online' : 'status-badge status-unknown'
    );

    const meta = obj(first(health.metadata, health.meta, {}));
    text('providerName', first(meta.provider, health.provider, 'Twelve Data LIVE'));
    text('providerRequests', first(meta.providerRequests, health.providerRequests));
    text('dailyCreditsUsed', first(meta.dailyCreditsUsed, health.dailyCreditsUsed));
    text('dailyCreditsRemaining', first(meta.dailyCreditsRemaining, health.dailyCreditsRemaining));
    text('cachedPairs', first(meta.cachedPairs, health.cachedPairs, 0));
    text('lastScanAt', date(first(health.lastScanAt, meta.lastScanAt)));

    if (elements.provider) {
      elements.provider.textContent = `Provider: ${first(meta.provider, health.provider, 'Twelve Data LIVE')} · API ${first(health.version, meta.version, '—')}`;
    }
  }

  function renderMarket(payload) {
    const root = obj(payload);
    const market = marketFrom(root);
    state.lastMarket = market;

    const indicators = getIndicators(market);
    const pair = String(first(market.pair, elements.selectedPair?.value, 'EUR/USD'));
    const timeframe = String(first(market.timeframe, elements.timeframe?.value, '1'));

    text('summaryPair', pair);

    // Never replace the select's text content; preserve its option list.
    if (elements.selectedPair &&
        [...elements.selectedPair.options].some(option => option.value === pair)) {
      elements.selectedPair.value = pair;
    }

    text('scanInfo', `${pair} · ${timeframe}m · analysis response received`);

    const freshness = freshnessOf(market);
    const dataAge = number(market.dataAgeSeconds);
    const unsafe = isUnsafe(market);

    text('freshness', unsafe ? freshness === 'FRESH' ? 'CHECK DATA' : freshness : freshness);
    text('dataAge', ageText(dataAge));
    text('currentPrice', fmt(market.currentPrice));
    text('entryPrice', fmt(market.entryPrice));

    setBadge(
      elements.marketStatus,
      'Market status: provider candles',
      'status-badge status-unknown'
    );

    renderTrend(first(indicators.trend5m, 'UNKNOWN'));

    let signal = normalizeSignal(market);
    if (unsafe) signal = 'NO TRADE';
    renderSignal(signal);

    text('confidence', signal === 'NO TRADE' ? '—' : Math.round(number(market.confidence) || 0));
    text('callScore', fmt(market.callScore, 0));
    text('putScore', fmt(market.putScore, 0));
    text('gap', fmt(market.gap, 0));
    text('entryTime', date(market.entryTime));
    text('expiryTime', date(market.expiryTime));

    text('ema9', fmt(indicators.ema9));
    text('ema21', fmt(indicators.ema21));
    text('rsi', fmt(indicators.rsi9, 2));
    text('adx', fmt(indicators.adx14, 2));
    text('atr', fmt(indicators.atr14));
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
    text('bollingerMiddle', fmt(bands.middle));
    text('bollingerLower', fmt(bands.lower));

    const levels = obj(market.supportResistance);
    text('support', fmt(levels.support));
    text('resistance', fmt(levels.resistance));
    text('volatility', first(market.volatility, 'UNKNOWN'));

    const pattern = market.candlePattern;
    text('candlePattern', typeof pattern === 'string' ? pattern : first(obj(pattern).name, '—'));
    text('lastCandle', market.lastCandle ? `Latest completed candle: ${date(market.lastCandle)}` : 'Latest completed candle: unavailable');
    text('priceAction', first(market.priceAction, 'Price-action interpretation unavailable.'));
    text('psychology', first(market.marketPsychology, 'Market psychology unavailable.'));

    const reasons = Array.isArray(market.reasons) ? market.reasons.slice() : [];
    if (unsafe) reasons.unshift('NO TRADE: market data is stale, unavailable, or not confirmed fresh.');
    if (signal === 'NO TRADE' && !reasons.length) reasons.push('NO TRADE: evidence is insufficient or conflicting.');
    renderReasons(reasons);

    text(
      'signalReason',
      signal === 'NO TRADE'
        ? unsafe
          ? 'NO TRADE — data freshness or sufficiency has not been confirmed.'
          : getSignalReason(market)
        : getSignalReason(market)
    );

    const meta = obj(root.metadata);
    text('providerRequests', first(meta.providerRequests, '—'));
    text('dailyCreditsUsed', first(meta.dailyCreditsUsed, '—'));
    text('dailyCreditsRemaining', first(meta.dailyCreditsRemaining, '—'));
    text('cachedPairs', first(meta.cachedPairs, '—'));

    const scanner = obj(root.scanner);
    text('lastScanAt', date(first(scanner.lastScanAt, root.lastScanAt)));
    text('candidateCount', Array.isArray(root.rankedCandidates) ? root.rankedCandidates.length : 0);
    setBadge(
      elements.scannerStatus,
      scanner.running ? 'Scanning' : 'Scan status reported',
      scanner.running ? 'status-badge status-unknown' : 'status-badge status-online'
    );

    if (Array.isArray(root.rankedCandidates)) renderScanner(root.rankedCandidates);
  }

  function renderScanner(results) {
    if (!elements.scanner) return;
    elements.scanner.replaceChildren();

    if (!Array.isArray(results) || results.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted-text';
      p.textContent = 'No validated candidates are currently available. This does not mean future market movements are predictable.';
      elements.scanner.appendChild(p);
      return;
    }

    for (const candidate of results.slice(0, 24)) {
      const item = obj(candidate);
      const pair = String(item.pair || 'Unknown pair');
      const signal = normalizeSignal(item);

      const row = document.createElement('article');
      row.className = 'scanner-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Analyze ${pair}`);

      const pairLabel = document.createElement('strong');
      pairLabel.className = 'scanner-pair';
      pairLabel.textContent = `${pair} · ${item.timeframe || '?'}m`;

      const badge = document.createElement('span');
      badge.className = signal === 'CALL' ? 'scan-call' : signal === 'PUT' ? 'scan-put' : 'scan-wait';
      badge.textContent = signal;

      const score = document.createElement('span');
      score.className = 'scanner-score';
      score.textContent = `Score: ${number(item.confidence) === null ? '—' : `${Math.round(item.confidence)}/100`}`;

      const reason = document.createElement('span');
      reason.className = 'scanner-reason';
      reason.textContent = String(first(item.reason, 'Evidence review required.'));

      row.append(pairLabel, badge, score, reason);

      const choose = () => {
        if (elements.selectedPair &&
            [...elements.selectedPair.options].some(option => option.value === pair)) {
          elements.selectedPair.value = pair;
        }
        if (elements.timeframe && [1, 2, 3].includes(Number(item.timeframe))) {
          elements.timeframe.value = String(item.timeframe);
        }
        analyzeMarket();
      };

      row.addEventListener('click', choose);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          choose();
        }
      });
      elements.scanner.appendChild(row);
    }
  }

  async function fetchJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
        throw new Error(`API returned invalid JSON (${response.status}).`);
      }

      if (!response.ok || payload.ok === false) {
        throw new Error(String(first(payload.error, payload.message, `API request failed (${response.status}).`)));
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkHealth() {
    try {
      renderHealth(await fetchJson('/api/health'));
      return true;
    } catch (error) {
      setBadge(elements.backendStatus, 'API offline / unavailable', 'status-badge status-offline');
      return false;
    }
  }

  async function analyzeMarket() {
    if (state.busy) return;
    state.busy = true;
    clearError();

    if (elements.analyzeBtn) {
      elements.analyzeBtn.disabled = true;
      elements.analyzeBtn.textContent = 'Analyzing…';
    }

    const pair = elements.selectedPair?.value || 'EUR/USD';
    const timeframe = elements.timeframe?.value || '1';

    try {
      const query = new URLSearchParams({ pair, timeframe });
      const payload = await fetchJson(`/api/analyze?${query.toString()}`);
      renderMarket(payload);

      // Refresh scanner independently; this endpoint does not replace the
      // selected pair's analysis in the main evidence panel.
      fetchJson('/api/best')
        .then(scanPayload => {
          const root = obj(scanPayload);
          renderScanner(root.rankedCandidates || []);
          const scanner = obj(root.scanner);
          text('candidateCount', Array.isArray(root.rankedCandidates) ? root.rankedCandidates.length : 0);
          text('lastScanAt', date(scanner.lastScanAt));
          text('cachedPairs', first(obj(root.metadata).cachedPairs, '—'));
          setBadge(
            elements.scannerStatus,
            scanner.running ? 'Scanning' : 'Scan status reported',
            scanner.running ? 'status-badge status-unknown' : 'status-badge status-online'
          );
        })
        .catch(() => {
          // Keep the last known scanner display if the optional scan request fails.
        });

      text('scanInfo', `${pair} · ${timeframe}m · analysis response received`);
    } catch (error) {
      const message = error.name === 'AbortError'
        ? 'The API request timed out. No new signal is available.'
        : String(error.message || 'Unable to analyze the market.');

      showError(message);
      text('scanInfo', 'Analysis failed. No new signal was generated.');
      renderSignal('NO TRADE');
      text('confidence', '—');
      text('signalReason', 'NO TRADE — analysis failed or could not be verified.');
      renderReasons([message, 'Do not infer a trade from a failed request.']);
    } finally {
      state.busy = false;
      if (elements.analyzeBtn) {
        elements.analyzeBtn.disabled = false;
        elements.analyzeBtn.textContent = 'Analyze market';
      }
    }
  }

  function bindEvents() {
    elements.analyzeBtn?.addEventListener('click', analyzeMarket);
    elements.selectedPair?.addEventListener('change', analyzeMarket);
    elements.timeframe?.addEventListener('change', analyzeMarket);
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
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
