
'use strict';

(() => {
  const API_BASE = String(
    window.PO_API_BASE ||
      'https://po-ai-predictor-api.onrender.com'
  ).replace(/\/+$/, '');

  const HEALTH_INTERVAL_MS = 60000;
  const SCAN_POLL_INTERVAL_MS = 5000;
  const REQUEST_TIMEOUT_MS = 90000;
  const MAX_DATA_AGE_SECONDS = 300;
  const MAX_REASONS = 10;

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
    trend5m: $('trend5m'),
    rsi: $('rsi'),
    rsiCross: $('rsiCross'),
    adx: $('adx'),
    macdLine: $('macdLine'),
    macdSignal: $('macdSignal'),
    macdHistogram: $('macdHistogram'),
    macdCross: $('macdCross'),
    stochK: $('stochK'),
    stochD: $('stochD'),
    stochasticCross: $('stochasticCross'),
    atr: $('atr'),
    bollingerUpper: $('bollingerUpper'),
    bollingerMiddle: $('bollingerMiddle'),
    bollingerLower: $('bollingerLower'),
    ema21_5m: $('ema21_5m'),
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

  function ageLabel(value) {
    const n = num(value);

    if (n === null || n < 0) return 'Age: unavailable';
    if (n < 60) return `Age: ${Math.round(n)} sec`;

    return `Age: ${Math.floor(n / 60)} min ${Math.round(n % 60)} sec`;
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
        throw new Error(
          first(
            payload.error,
            payload.message,
            `Request failed (HTTP ${response.status}).`
          )
        );
      }

      return payload;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(
          'The request timed out. No new signal was confirmed.'
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
    const signalObject = obj(market.signal);

    if (
      market.noTrade === true ||
      market.tradeAllowed === false ||
      signalObject.noTrade === true ||
      signalObject.tradeAllowed === false
    ) {
      return 'NO TRADE';
    }

    const raw = String(first(
      typeof market.signal === 'string'
        ? market.signal
        : null,
      signalObject.action,
      signalObject.direction,
      market.action,
      market.direction,
      'NO TRADE'
    )).toUpperCase().trim();

    if (['CALL', 'BUY', 'UP', 'BULLISH'].includes(raw)) {
      return 'CALL';
    }

    if (['PUT', 'SELL', 'DOWN', 'BEARISH'].includes(raw)) {
      return 'PUT';
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
    if (signal === 'CALL') {
      setBadge(
        el.signalBadge,
        'CALL',
        'signal-badge signal-call'
      );
    } else if (signal === 'PUT') {
      setBadge(
        el.signalBadge,
        'PUT',
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

    if (trend.includes('BULL') || trend === 'UP') {
      setBadge(
        el.trendBadge,
        'Trend: BULLISH',
        'trend-badge trend-up'
      );
    } else if (trend.includes('BEAR') || trend === 'DOWN') {
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

    const online = health.ok === true && health.configured === true;

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

    state.lastMarket = market;

    const pair = String(first(
      market.pair,
      el.selectedPair?.value,
      'NO MARKET'
    ));

    const timeframe = first(
      market.timeframe,
      el.timeframe?.value,
      '—'
    );

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

    setText('dataAge', ageLabel(age));

    setBadge(
      el.marketStatus,
      unsafe
        ? 'Market status: verify data'
        : 'Market status: fresh provider data',
      unsafe
        ? 'status-badge status-unknown'
        : 'status-badge status-online'
    );

    renderTrend(first(indicators.trend5m, 'UNKNOWN'));

    let signal = getSignal(market);

    if (unsafe) signal = 'NO TRADE';

    renderSignal(signal);

    setText(
      'confidence',
      signal === 'NO TRADE'
        ? '—'
        : fmt(market.confidence, 0)
    );

    setText('callScore', fmt(market.callScore, 0));
    setText('putScore', fmt(market.putScore, 0));
    setText('gap', fmt(market.gap, 0));

    setText('ema9', fmt(indicators.ema9));
    setText('ema21', fmt(indicators.ema21));
    setText(
      'emaCross',
      `Crossover: ${first(indicators.emaCross, '—')}`
    );
    setText(
      'trend5m',
      `5m trend: ${first(indicators.trend5m, '—')}`
    );

    setText(
      'rsi',
      fmt(first(indicators.rsi9, indicators.rsi), 2)
    );
    setText(
      'rsiCross',
      `RSI cross: ${first(indicators.rsiCross, '—')}`
    );
    setText(
      'adx',
      fmt(first(indicators.adx14, indicators.adx), 2)
    );

    setText('macdLine', fmt(macd.line, 6));
    setText('macdSignal', fmt(macd.signal, 6));
    setText(
      'macdHistogram',
      `Histogram: ${fmt(macd.histogram, 6)}`
    );
    setText(
      'macdCross',
      `MACD cross: ${first(macd.crossover, '—')}`
    );

    setText('stochK', fmt(stochastic.k, 2));
    setText('stochD', fmt(stochastic.d, 2));
    setText(
      'stochasticCross',
      `Stochastic cross: ${first(stochastic.crossover, '—')}`
    );

    setText('atr', fmt(first(indicators.atr14, indicators.atr)));
    setText('bollingerUpper', fmt(bands.upper));
    setText(
      'bollingerMiddle',
      fmt(first(bands.middle, bands.mid))
    );
    setText('bollingerLower', fmt(bands.lower));
    setText('ema21_5m', fmt(indicators.ema21_5m));

    setText('support', fmt(levels.support));
    setText('resistance', fmt(levels.resistance));
    setText(
      'volatility',
      first(market.volatility, 'UNKNOWN')
    );

    const pattern = market.candlePattern;

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
        market.priceAction,
        'Price-action interpretation unavailable.'
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
        'NO TRADE: freshness or data sufficiency could not be verified.'
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
            'Review all indicators before making a decision.'
          )
    );

    renderUsage(root.metadata);

    setText(
      'scanInfo',
      `${pair} · ${timeframe}m · individual analysis completed`
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

  function addScanButton() {
    if ($('backgroundScanBtn')) return;

    const button = document.createElement('button');
    button.id = 'backgroundScanBtn';
    button.type = 'button';
    button.textContent = 'Scan all 24 pairs in background';
    button.style.marginTop = '10px';

    button.addEventListener('click', startBackgroundScan);

    if (el.analyzeBtn?.parentElement) {
      el.analyzeBtn.insertAdjacentElement('afterend', button);
    } else {
      document.querySelector('.control-panel')
        ?.appendChild(button);
    }
  }

  function setBusy(button, busy, busyText, normalText) {
    if (!button) return;

    button.disabled = busy;
    button.textContent = busy ? busyText : normalText;
  }

  async function analyzeSelectedPair() {
    if (state.analysisBusy) return;

    const pair = String(
      el.selectedPair?.value || ''
    ).trim().toUpperCase();

    const timeframe = String(
      el.timeframe?.value || '1'
    );

    if (!pair || !['1', '2', '3'].includes(timeframe)) {
      showError('Choose a valid currency pair and timeframe.');
      return;
    }

    state.analysisBusy = true;
    const requestId = ++state.requestId;

    clearError();
    setBusy(
      el.analyzeBtn,
      true,
      'Analyzing selected pair…',
      'Analyze selected pair'
    );

    setText(
      'scanInfo',
      `Requesting ${pair} · ${timeframe}m analysis. The 24-pair scan is separate.`
    );

    try {
      const query = new URLSearchParams({
        pair,
        timeframe
      });

      const payload = await requestJson(
        `/api/analyze?${query.toString()}`
      );

      if (requestId !== state.requestId) return;

      const market = marketFrom(payload);

      if (!market.pair) {
        throw new Error(
          'The API response did not include the selected market.'
        );
      }

      renderMarket(payload);
    } catch (error) {
      if (requestId === state.requestId) {
        showError(String(error.message || error));
        setText(
          'signalReason',
          'Analysis failed. Do not infer a CALL or PUT from an error.'
        );
        renderSignal('NO TRADE');
      }
    } finally {
      state.analysisBusy = false;
      setBusy(
        el.analyzeBtn,
        false,
        '',
        'Analyze selected pair'
      );
    }
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
      'cachedPairs',
      first(obj(root.metadata).cachedPairs, 0)
    );
    setText('candidateCount', candidates.length);
    setText(
      'lastScanAt',
      date(first(scanner.lastScanAt, root.lastScanAt))
    );

    const running = scanner.running === true;
    const completed = num(progress.completed) || 0;
    const total = num(progress.total) || num(scanner.pairs) || 24;

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
        ? `Scan in progress: ${completed}/${total} pairs checked.`
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

      title.textContent =
        `${candidate.pair} · ${candidate.timeframe}m · ${candidate.signal}`;

      detail.textContent =
        `Evidence score: ${fmt(candidate.confidence, 0)}/100 · ` +
        `Data age: ${fmt(candidate.dataAgeSeconds, 0)} sec · ` +
        String(candidate.reason || 'Evidence review.');

      li.append(title, detail);
      list.appendChild(li);
    }

    scannerNode.appendChild(list);
  }

  async function pollBackgroundScan() {
    if (!state.scanBusy) return;

    try {
      const payload = await requestJson('/api/best');
      renderScanner(payload);

      const scanner = obj(payload.scanner);

      if (scanner.running === true) {
        setText(
          'scanInfo',
          `Background scan running: ${num(obj(scanner.progress).completed) || 0}/24 pairs. You can continue analyzing a selected pair.`
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
        'Scan all 24 pairs in background'
      );

      setText(
        'scanInfo',
        'Background scan stopped or completed. Review the candidate list and freshness.'
      );

      if (scanner.lastScanAt || payload.lastScanAt) {
        renderScanner(payload);
      }
    } catch (error) {
      setText(
        'scanInfo',
        `Could not refresh scanner status: ${String(error.message || error)}`
      );
    }
  }

  async function startBackgroundScan() {
    if (state.scanBusy) {
      showError('A background scan is already running.');
      return;
    }

    clearError();

    try {
      const current = await requestJson('/api/best');
      const scanner = obj(current.scanner);

      if (scanner.running === true) {
        state.scanBusy = true;
        showError(
          'A scan is already running on the backend. Monitoring its progress.'
        );
      } else {
        const started = await requestJson('/api/scan', {
          method: 'POST',
          body: {}
        });

        if (started.ok !== true) {
          throw new Error(
            first(started.error, 'The scan could not be started.')
          );
        }

        state.scanBusy = true;
        setText(
          'scanInfo',
          'Background scan started. Selected-pair analysis remains available separately.'
        );
      }

      setBusy(
        $('backgroundScanBtn'),
        true,
        'Background scan running…',
        'Scan all 24 pairs in background'
      );

      if (state.scanTimer) clearInterval(state.scanTimer);

      state.scanTimer = setInterval(
        pollBackgroundScan,
        SCAN_POLL_INTERVAL_MS
      );

      await pollBackgroundScan();
    } catch (error) {
      showError(String(error.message || error));
      state.scanBusy = false;

      setBusy(
        $('backgroundScanBtn'),
        false,
        '',
        'Scan all 24 pairs in background'
      );
    }
  }

  function bindEvents() {
    addScanButton();

    if (el.analyzeBtn) {
      el.analyzeBtn.textContent = 'Analyze selected pair';
      el.analyzeBtn.addEventListener(
        'click',
        analyzeSelectedPair
      );
    }

    if (el.selectedPair) {
      el.selectedPair.addEventListener('change', () => {
        setText('summaryPair', el.selectedPair.value);
        setText(
          'scanInfo',
          `Selected ${el.selectedPair.value}. Press Analyze selected pair to refresh its analysis.`
        );
      });
    }

    if (el.timeframe) {
      el.timeframe.addEventListener('change', () => {
        setText(
          'scanInfo',
          `Selected timeframe: ${el.timeframe.value} minute(s). Press Analyze selected pair to refresh.`
        );
      });
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
          'Background scan running…',
          'Scan all 24 pairs in background'
        );

        state.scanTimer = setInterval(
          pollBackgroundScan,
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
          'Ready. Choose a pair and press Analyze selected pair. Start the 24-pair scan separately if needed.'
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
