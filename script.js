
'use strict';

(() => {
  const API_BASE = String(
    window.PO_API_BASE ||
      'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const HEALTH_INTERVAL_MS = 60000;
  const SCAN_POLL_INTERVAL_MS = 2000;
  const REQUEST_TIMEOUT_MS = 12000;
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
    requestId: 0,
    lastScanRequestAt: 0
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
    return values.find(
      value =>
        value !== undefined &&
        value !== null &&
        value !== ''
    );
  }

  function num(value) {
    if (
      value === null ||
      value === undefined ||
      value === ''
    ) return null;

    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(value, digits = 5) {
    const n = num(value);
    if (n === null) return '—';

    return n.toLocaleString(undefined, {
      maximumFractionDigits: digits
    });
  }

  function date(value) {
    if (!value) return '—';

    const d = new Date(value);

    return Number.isNaN(d.getTime())
      ? String(value)
      : d.toLocaleString();
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
    const timer = setTimeout(
      () => controller.abort(),
      options.timeout || REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: options.method || 'GET',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(options.body
            ? { 'Content-Type': 'application/json' }
            : {})
        },
        ...(options.body
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
        throw new Error(
          'Request timed out. No new signal was confirmed.'
        );
      }

      throw error;
    } finally {
      clearTimeout(timer);
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
    const raw = String(
      typeof market.signal === 'string'
        ? market.signal
        : first(
            obj(market.signal).action,
            obj(market.signal).direction,
            market.action,
            market.direction,
            'NO TRADE'
          )
    ).toUpperCase().trim();

    if (
      market.noTrade === true ||
      market.tradeAllowed === false ||
      obj(market.signal).noTrade === true ||
      obj(market.signal).tradeAllowed === false
    ) {
      return 'NO TRADE';
    }

    if (['CALL', 'BUY', 'UP', 'BULLISH'].includes(raw)) {
      return 'BUY';
    }

    if (['PUT', 'SELL', 'DOWN', 'BEARISH'].includes(raw)) {
      return 'SELL';
    }

    return 'NO TRADE';
  }

  function isUnsafe(market) {
    const age = num(market.dataAgeSeconds);
    const freshness = String(
      first(market.freshness, 'UNKNOWN')
    ).toUpperCase();

    return (
      freshness !== 'FRESH' ||
      age === null ||
      age < 0 ||
      age > MAX_DATA_AGE_SECONDS ||
      market.insufficientData === true
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
      const li = document.createElement('li');
      li.textContent = String(reason);
      el.reasons.appendChild(li);
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
      health.ok === true &&
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

    const unsafe = isUnsafe(market);

    setText(
      'freshness',
      unsafe && freshness === 'FRESH'
        ? 'CHECK DATA'
        : freshness
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
      unsafe
        ? 'Market status: verify data'
        : 'Market status: fresh provider data',
      unsafe
        ? 'status-badge status-unknown'
        : 'status-badge status-online'
    );

    renderTrend(first(
      market.trendLine?.direction,
      market.priceAction,
      'UNKNOWN'
    ));

    let signal = getSignal(market);

    if (unsafe) signal = 'NO TRADE';

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
        market.trendLine?.description,
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

    let reasons = Array.isArray(market.reasons)
      ? market.reasons.slice()
      : [];

    if (unsafe) {
      reasons.unshift(
        'NO TRADE: data freshness or sufficiency could not be verified.'
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
      unsafe
        ? 'NO TRADE — data freshness or sufficiency has not been confirmed.'
        : first(
            obj(market.signal).reason,
            market.reason,
            reasons[0],
            'Evidence score, not win probability.'
          )
    );

    renderUsage(root.metadata);

    setText(
      'scanInfo',
      `${pair} · 1m · latest available analysis`
    );
  }

  async function checkHealth() {
    if (state.healthBusy) return;

    state.healthBusy = true;

    try {
      renderHealth(await requestJson('/api/health'));
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

  function setBusy(button, busy, busyText, normalText) {
    if (!button) return;

    button.disabled = busy;
    button.textContent = busy ? busyText : normalText;
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

    button.addEventListener('click', analyzeAllPairs);
  }

  function renderScanner(payload) {
    const root = obj(payload);
    const scanner = obj(root.scanner);
    const progress = obj(scanner.progress);

    const candidates = Array.isArray(root.rankedCandidates)
      ? root.rankedCandidates
      : [];

    const panel = document.querySelector('.scanner-panel');
    const scannerNode = $('scanner');

    if (panel) panel.hidden = false;

    setText(
      'candidateCount',
      candidates.length
    );

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
        : candidates.length
          ? `${candidates.length} candidate(s)`
          : 'No qualified candidate',
      running
        ? 'status-badge status-unknown'
        : 'status-badge status-online'
    );

    if (!scannerNode) return;

    scannerNode.replaceChildren();

    if (!candidates.length) {
      const p = document.createElement('p');
      p.className = 'muted-text';
      p.textContent = running
        ? `Scanning in background: ${completed}/${total} pairs.`
        : 'No candidate passed the evidence and freshness checks. NO TRADE.';

      scannerNode.appendChild(p);
      return;
    }

    const list = document.createElement('ol');
    list.className = 'candidate-list';

    for (const candidate of candidates.slice(0, 10)) {
      const li = document.createElement('li');
      const title = document.createElement('strong');
      const detail = document.createElement('p');

      const signal = String(candidate.signal || '').toUpperCase();
      const safeSignal =
        signal === 'CALL' || signal === 'BUY'
          ? 'BUY'
          : signal === 'PUT' || signal === 'SELL'
            ? 'SELL'
            : 'NO TRADE';

      title.textContent =
        `${candidate.pair} · 1m · ${safeSignal}`;

      detail.textContent =
        `Evidence score: ${fmt(candidate.confidence, 0)}/100 · ` +
        `Data age: ${fmt(candidate.dataAgeSeconds, 0)} sec · ` +
        String(candidate.reason || 'Evidence review.');

      li.append(title, detail);
      list.appendChild(li);
    }

    scannerNode.appendChild(list);
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
          `Scanning ${num(progress.completed) || 0}/${num(progress.total) || PAIR_COUNT} pairs. Waiting for completed results.`
        );
        return;
      }

      if (state.scanTimer) {
        clearInterval(state.scanTimer);
        state.scanTimer = null;
      }

      state.scanBusy = false;

      setBusy(
        $('backgroundScanBtn'),
        false,
        '',
        'Scan all 24 pairs'
      );

      setText(
        'scanInfo',
        'Scan stopped or completed. Check candidate freshness before acting.'
      );
    } catch (error) {
      setText(
        'scanInfo',
        `Could not refresh scan status: ${String(error.message || error)}`
      );
    }
  }

  async function analyzeAllPairs() {
    if (state.analysisBusy || state.scanBusy) return;

    state.analysisBusy = true;
    const requestId = ++state.requestId;

    clearError();

    setBusy(
      el.analyzeBtn,
      true,
      'Analyzing 24 pairs…',
      'Analyze all 24 pairs'
    );

    setBusy(
      $('backgroundScanBtn'),
      true,
      'Scan running…',
      'Scan all 24 pairs'
    );

    setText(
      'scanInfo',
      'Loading the latest available candidates and starting the 24-pair scan if permitted.'
    );

    try {
      // Display the latest stored analysis immediately when available.
      try {
        const current = await requestJson('/api/best');

        if (requestId !== state.requestId) return;

        renderScanner(current);

        const market = marketFrom(current);

        if (market.pair && market.pair !== 'NO MARKET') {
          renderMarket(current);
        }
      } catch {
        // Continue and attempt to start a scan.
      }

      try {
        const started = await requestJson('/api/scan', {
          method: 'POST',
          body: {},
          timeout: REQUEST_TIMEOUT_MS
        });

        state.scanBusy = true;
        state.lastScanRequestAt = Date.now();

        setText(
          'scanInfo',
          first(
            started.message,
            'The 24-pair scan has started in the background.'
          )
        );
      } catch (error) {
        // HTTP 409 means a scan is already running.
        if (error.status === 409) {
          state.scanBusy = true;
          setText(
            'scanInfo',
            'A 24-pair scan is already running. Monitoring its progress.'
          );
        } else {
          // A cooldown response may still leave usable previous candidates.
          if (error.status === 429) {
            const current = await requestJson('/api/best');
            renderScanner(current);

            const market = marketFrom(current);

            if (market.pair && market.pair !== 'NO MARKET') {
              renderMarket(current);
            }

            setText(
              'scanInfo',
              'A new scan is not available yet. Showing the latest stored results; they may not be new.'
            );
          } else {
            throw error;
          }
        }
      }

      if (state.scanBusy) {
        if (state.scanTimer) clearInterval(state.scanTimer);

        state.scanTimer = setInterval(
          pollScan,
          SCAN_POLL_INTERVAL_MS
        );

        await pollScan();
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

      if (!state.scanBusy) {
        setBusy(
          $('backgroundScanBtn'),
          false,
          '',
          'Scan all 24 pairs'
        );
      }
    }
  }

  function bindEvents() {
    ensureScanButton();

    if (el.analyzeBtn) {
      el.analyzeBtn.textContent = 'Analyze all 24 pairs';
      el.analyzeBtn.addEventListener('click', analyzeAllPairs);
    }

    if (el.selectedPair) {
      el.selectedPair.addEventListener('change', () => {
        setText(
          'scanInfo',
          `Selected pair: ${el.selectedPair.value}. The Analyze button scans all 24 pairs.`
        );
      });
    }

    if (el.timeframe) {
      // This strategy uses 1-minute candles only.
      el.timeframe.value = '1';
      el.timeframe.disabled = true;
    }
  }

  async function initialize() {
    bindEvents();

    await checkHealth();

    try {
      const current = await requestJson('/api/best');

      renderScanner(current);

      const scanner = obj(current.scanner);

      if (scanner.running === true) {
        state.scanBusy = true;

        setBusy(
          $('backgroundScanBtn'),
          true,
          'Scan running…',
          'Scan all 24 pairs'
        );

        state.scanTimer = setInterval(
          pollScan,
          SCAN_POLL_INTERVAL_MS
        );
      }

      const market = marketFrom(current);

      if (
        market.pair &&
        market.pair !== 'NO MARKET' &&
        market.freshness
      ) {
        renderMarket(current);
      } else {
        setText(
          'scanInfo',
          'Ready. Press Analyze all 24 pairs to review available results and start a scan.'
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
