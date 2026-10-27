
"use strict";

(() => {
  const API_BASE = window.PO_API_BASE || "https://po-ai-predictor-api.onrender.com";
  const REFRESH_INTERVAL_MS = 15000;
  const MAX_REASON_ITEMS = 10;

  const $ = (id) => document.getElementById(id);

  const state = {
    busy: false,
    lastMarket: null,
    lastHealth: null,
    timer: null
  };

  const elements = {
    backendStatus: $("backendStatus"),
    analyzeBtn: $("analyzeBtn"),
    errorBox: $("errorBox"),
    selectedPair: $("selectedPair"),
    marketStatus: $("marketStatus"),
    trendBadge: $("trendBadge"),
    signalBadge: $("signalBadge"),
    confidence: $("confidence"),
    timeframe: $("timeframe"),
    entryTime: $("entryTime"),
    expiryTime: $("expiryTime"),
    entryPrice: $("entryPrice"),
    callScore: $("callScore"),
    putScore: $("putScore"),
    support: $("support"),
    resistance: $("resistance"),
    gap: $("gap"),
    volatility: $("volatility"),
    dataAge: $("dataAge"),
    currentPrice: $("currentPrice"),
    freshness: $("freshness"),
    ema9: $("ema9"),
    ema21: $("ema21"),
    rsi: $("rsi"),
    adx: $("adx"),
    stochastic: $("stochastic"),
    atr: $("atr"),
    bollingerUpper: $("bollingerUpper"),
    bollingerMiddle: $("bollingerMiddle"),
    bollingerLower: $("bollingerLower"),
    psychology: $("psychology"),
    priceAction: $("priceAction"),
    reasons: $("reasons"),
    lastCandle: $("lastCandle"),
    scanInfo: $("scanInfo"),
    scanner: $("scanner"),
    provider: $("provider"),
    providerRequests: $("providerRequests"),
    dailyCreditsUsed: $("dailyCreditsUsed"),
    dailyCreditsRemaining: $("dailyCreditsRemaining"),
    cachedPairs: $("cachedPairs"),
    candidateCount: $("candidateCount"),
    scannerStatus: $("scannerStatus"),
    lastScanAt: $("lastScanAt")
  };

  function setText(id, value, fallback = "—") {
    const element = $(id);
    if (!element) return;
    element.textContent =
      value === null || value === undefined || value === ""
        ? fallback
        : String(value);
  }

  function setHidden(element, hidden) {
    if (element) element.hidden = hidden;
  }

  function showError(message) {
    if (!elements.errorBox) return;
    elements.errorBox.textContent = message;
    elements.errorBox.hidden = false;
  }

  function clearError() {
    if (!elements.errorBox) return;
    elements.errorBox.textContent = "";
    elements.errorBox.hidden = true;
  }

  function setBadge(element, text, className) {
    if (!element) return;
    element.textContent = text;
    element.className = className;
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatNumber(value, digits = 5) {
    const number = numberOrNull(value);
    if (number === null) return "—";

    return number.toLocaleString(undefined, {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0
    });
  }

  function formatPercent(value, digits = 1) {
    const number = numberOrNull(value);
    return number === null ? "—" : `${number.toFixed(digits)}%`;
  }

  function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function formatAge(seconds) {
    const age = numberOrNull(seconds);
    if (age === null || age < 0) return "Age: unavailable";

    if (age < 60) return `Age: ${Math.round(age)} sec`;
    if (age < 3600) return `Age: ${Math.floor(age / 60)} min ${Math.round(age % 60)} sec`;

    return `Age: ${Math.floor(age / 3600)} hr ${Math.floor((age % 3600) / 60)} min`;
  }

  function normalizeDirection(value) {
    const direction = String(value || "").trim().toUpperCase();

    if (["CALL", "BUY", "UP", "BULLISH"].includes(direction)) return "CALL";
    if (["PUT", "SELL", "DOWN", "BEARISH"].includes(direction)) return "PUT";
    return "NO TRADE";
  }

  function normalizeSignal(market) {
    const data = asObject(market);
    const signal = asObject(data.signal);

    const raw = firstDefined(
      signal.action,
      signal.direction,
      data.action,
      data.direction,
      data.signalAction
    );

    const direction = normalizeDirection(raw);

    if (
      data.noTrade === true ||
      signal.noTrade === true ||
      data.tradeAllowed === false ||
      signal.tradeAllowed === false
    ) {
      return "NO TRADE";
    }

    return direction;
  }

  function getMarketObject(payload) {
    const root = asObject(payload);

    return asObject(
      firstDefined(
        root.market,
        root.best,
        root.result,
        root.data,
        root
      )
    );
  }

  function getIndicators(market) {
    return asObject(market.indicators);
  }

  function getSignalObject(market) {
    return asObject(market.signal);
  }

  function getScore(market, direction) {
    const signal = getSignalObject(market);
    const scores = asObject(market.scores);
    const nestedScores = asObject(signal.scores);

    const possible = direction === "CALL"
      ? [
          market.callScore,
          scores.call,
          scores.CALL,
          nestedScores.call,
          signal.callScore
        ]
      : [
          market.putScore,
          scores.put,
          scores.PUT,
          nestedScores.put,
          signal.putScore
        ];

    const value = numberOrNull(firstDefined(...possible));
    return value === null ? 0 : Math.max(0, Math.min(100, value));
  }

  function getEvidenceScore(market) {
    const signal = getSignalObject(market);

    const score = numberOrNull(
      firstDefined(
        signal.score,
        signal.evidenceScore,
        market.evidenceScore,
        market.confidence,
        market.score
      )
    );

    return score === null ? null : Math.max(0, Math.min(100, score));
  }

  function getFreshness(market) {
    const quality = asObject(market.dataQuality);
    const data = asObject(market.data);
    const meta = asObject(market.meta);

    return String(
      firstDefined(
        market.freshness,
        market.dataFreshness,
        quality.freshness,
        quality.status,
        data.freshness,
        meta.freshness,
        "UNKNOWN"
      )
    ).toUpperCase();
  }

  function isStale(market) {
    const freshness = getFreshness(market);
    const quality = asObject(market.dataQuality);
    const data = asObject(market.data);

    if (
      quality.stale === true ||
      quality.isFresh === false ||
      data.stale === true ||
      market.stale === true
    ) {
      return true;
    }

    return ["STALE", "OLD", "EXPIRED", "INVALID"].includes(freshness);
  }

  function isExplicitlyInsufficient(market) {
    const quality = asObject(market.dataQuality);
    const signal = getSignalObject(market);
    const reason = String(
      firstDefined(signal.reason, market.reason, market.statusReason, "")
    ).toLowerCase();

    return (
      quality.sufficient === false ||
      quality.valid === false ||
      market.insufficientData === true ||
      /insufficient|incomplete|not enough data|stale|conflict/.test(reason)
    );
  }

  function getReasonList(market) {
    const signal = getSignalObject(market);

    const raw = firstDefined(
      signal.reasons,
      market.reasons,
      market.explanation,
      market.evidence
    );

    if (Array.isArray(raw)) {
      return raw
        .map((item) => {
          if (typeof item === "string") return item;
          const obj = asObject(item);
          return firstDefined(obj.message, obj.reason, obj.label, obj.name);
        })
        .filter(Boolean)
        .slice(0, MAX_REASON_ITEMS);
    }

    if (typeof raw === "string" && raw.trim()) {
      return [raw.trim()];
    }

    const reason = firstDefined(signal.reason, market.reason);
    return reason ? [String(reason)] : ["No detailed evidence reasons were supplied by the API."];
  }

  function getValue(market, indicatorNames, topLevelNames = []) {
    const indicators = getIndicators(market);

    for (const name of indicatorNames) {
      const value = indicators[name];
      if (value !== undefined && value !== null) {
        return value;
      }
    }

    for (const name of topLevelNames) {
      const value = market[name];
      if (value !== undefined && value !== null) {
        return value;
      }
    }

    return null;
  }

  function renderReasons(reasons) {
    if (!elements.reasons) return;

    elements.reasons.replaceChildren();

    for (const reason of reasons.slice(0, MAX_REASON_ITEMS)) {
      const item = document.createElement("li");
      item.textContent = String(reason);
      elements.reasons.appendChild(item);
    }
  }

  function renderSignalBadge(signal) {
    if (signal === "CALL") {
      setBadge(elements.signalBadge, "CALL", "signal-badge signal-call");
    } else if (signal === "PUT") {
      setBadge(elements.signalBadge, "PUT", "signal-badge signal-put");
    } else {
      setBadge(elements.signalBadge, "NO TRADE", "signal-badge signal-wait");
    }
  }

  function renderTrend(trend) {
    const normalized = String(trend || "UNKNOWN").toUpperCase();

    if (normalized.includes("BULL") || normalized === "CALL" || normalized === "UP") {
      setBadge(elements.trendBadge, "Trend: BULLISH", "trend-badge trend-up");
      return;
    }

    if (normalized.includes("BEAR") || normalized === "PUT" || normalized === "DOWN") {
      setBadge(elements.trendBadge, "Trend: BEARISH", "trend-badge trend-down");
      return;
    }

    setBadge(elements.trendBadge, `Trend: ${normalized}`, "trend-badge");
  }

  function renderHealth(payload) {
    const root = asObject(payload);
    const health = asObject(firstDefined(root.health, root.data, root));

    state.lastHealth = health;

    const ok =
      health.ok === true ||
      health.status === "ok" ||
      health.status === "healthy" ||
      health.online === true;

    setBadge(
      elements.backendStatus,
      ok ? "API online" : "API status unknown",
      ok ? "status-badge status-online" : "status-badge status-unknown"
    );

    const provider = asObject(health.provider);
    const usage = asObject(firstDefined(health.usage, health.credits, health.quota));
    const counters = asObject(health.counters);

    setText(
      "providerName",
      firstDefined(provider.name, health.providerName, health.provider, "Twelve Data")
    );

    setText(
      "providerRequests",
      firstDefined(
        health.requestsThisMinute,
        health.requestsPerMinute,
        counters.requests,
        usage.requests,
        usage.used
      )
    );

    setText(
      "dailyCreditsUsed",
      firstDefined(
        health.dailyCreditsUsed,
        usage.dailyCreditsUsed,
        usage.usedToday,
        usage.used
      )
    );

    setText(
      "dailyCreditsRemaining",
      firstDefined(
        health.dailyCreditsRemaining,
        usage.dailyCreditsRemaining,
        usage.remaining,
        usage.creditsRemaining
      )
    );

    const apiVersion = firstDefined(health.version, root.version);
    if (apiVersion) {
      setText("provider", `Provider: Twelve Data LIVE · API ${apiVersion}`);
    }
  }

  function renderMarket(payload) {
    const market = getMarketObject(payload);
    state.lastMarket = market;

    const signalObject = getSignalObject(market);
    const indicators = getIndicators(market);
    const technical = asObject(market.technical);
    const prices = asObject(market.prices);
    const trendObject = asObject(firstDefined(market.trend, indicators.trend));

    const pair = String(
      firstDefined(market.pair, market.symbol, market.currencyPair, elements.selectedPair?.value, "EUR/USD")
    );

    const timeframe = String(
      firstDefined(market.timeframe, market.interval, elements.timeframe?.value, "1")
    );

    setText("summaryPair", pair);
    setText("selectedPair", pair);
    setText("scanInfo", `Latest API result: ${pair} · ${timeframe}m`);

    const currentPrice = firstDefined(
      market.currentPrice,
      market.price,
      prices.current,
      prices.close,
      market.close
    );

    const entryPrice = firstDefined(
      signalObject.entryPrice,
      market.entryPrice,
      market.entry,
      prices.entry
    );

    setText("currentPrice", formatNumber(currentPrice));
    setText("entryPrice", formatNumber(entryPrice));

    const freshness = getFreshness(market);
    const stale = isStale(market);
    const insufficient = isExplicitlyInsufficient(market);

    setText("freshness", stale ? "STALE" : freshness);
    setText(
      "dataAge",
      formatAge(
        firstDefined(
          market.dataAgeSeconds,
          market.ageSeconds,
          asObject(market.dataQuality).ageSeconds,
          asObject(market.meta).dataAgeSeconds
        )
      )
    );

    const marketOpen = firstDefined(
      market.marketOpen,
      market.isMarketOpen,
      asObject(market.market).open
    );

    if (marketOpen === false) {
      setBadge(elements.marketStatus, "Market closed", "status-badge status-unknown");
    } else if (marketOpen === true) {
      setBadge(elements.marketStatus, "Market open", "status-badge status-online");
    } else {
      setBadge(elements.marketStatus, "Market status: unknown", "status-badge status-unknown");
    }

    const trend = firstDefined(
      market.trend5m,
      indicators.trend5m,
      trendObject.direction,
      market.trendDirection,
      market.trend,
      "UNKNOWN"
    );

    renderTrend(trend);

    let signal = normalizeSignal(market);

    // The frontend may veto a signal if the backend explicitly reports
    // stale or insufficient data. It never creates a new trading signal.
    if (stale || insufficient) {
      signal = "NO TRADE";
    }

    renderSignalBadge(signal);

    const evidenceScore = getEvidenceScore(market);
    setText("confidence", evidenceScore === null ? "—" : Math.round(evidenceScore));

    const callScore = getScore(market, "CALL");
    const putScore = getScore(market, "PUT");

    setText("callScore", callScore);
    setText("putScore", putScore);
    setText("gap", Math.abs(callScore - putScore));

    const timing = asObject(market.timing);
    setText(
      "entryTime",
      formatDate(firstDefined(signalObject.entryTime, market.entryTime, timing.entryTime))
    );
    setText(
      "expiryTime",
      formatDate(firstDefined(signalObject.expiryTime, market.expiryTime, timing.expiryTime))
    );

    const ema9 = firstDefined(indicators.ema9, technical.ema9);
    const ema21 = firstDefined(indicators.ema21, technical.ema21);
    const rsi9 = firstDefined(indicators.rsi9, indicators.rsi, technical.rsi9, technical.rsi);
    const adx14 = firstDefined(indicators.adx14, indicators.adx, technical.adx14, technical.adx);
    const atr14 = firstDefined(indicators.atr14, indicators.atr, technical.atr14, technical.atr);
    const ema21_5m = firstDefined(indicators.ema21_5m, technical.ema21_5m);

    setText("ema9", formatNumber(ema9));
    setText("ema21", formatNumber(ema21));
    setText("rsi", formatNumber(rsi9, 2));
    setText("adx", formatNumber(adx14, 2));
    setText("atr", formatNumber(atr14));
    setText("ema21_5m", formatNumber(ema21_5m));

    const emaCross = firstDefined(
      indicators.emaCross,
      indicators.emaCrossover,
      technical.emaCross,
      "—"
    );
    const rsiCross = firstDefined(
      indicators.rsiCross,
      indicators.rsiCrossover,
      technical.rsiCross,
      "—"
    );

    setText("emaCross", `Crossover: ${emaCross}`);
    setText("rsiCross", `RSI cross: ${rsiCross}`);
    setText("trend5m", `5m trend: ${trend}`);

    const macd = asObject(indicators.macd);
    const macdLine = firstDefined(macd.line, indicators.macdLine, technical.macdLine);
    const macdSignal = firstDefined(macd.signal, indicators.macdSignal, technical.macdSignal);
    const macdHistogram = firstDefined(
      macd.histogram,
      indicators.macdHistogram,
      technical.macdHistogram
    );

    setText("macdLine", formatNumber(macdLine, 6));
    setText("macdSignal", formatNumber(macdSignal, 6));
    setText("macdHistogram", `Histogram: ${formatNumber(macdHistogram, 6)}`);
    setText(
      "macdCross",
      `MACD cross: ${firstDefined(macd.crossover, macd.cross, indicators.macdCross, "—")}`
    );

    const stochastic = asObject(indicators.stochastic);
    const stochK = firstDefined(
      stochastic.k,
      stochastic.percentK,
      indicators.stochasticK,
      indicators.stochK
    );
    const stochD = firstDefined(
      stochastic.d,
      stochastic.percentD,
      indicators.stochasticD,
      indicators.stochD
    );

    setText("stochK", formatNumber(stochK, 2));
    setText("stochD", formatNumber(stochD, 2));
    setText(
      "stochasticCross",
      `Stochastic cross: ${firstDefined(stochastic.crossover, stochastic.cross, indicators.stochasticCross, "—")}`
    );

    const bollinger = asObject(firstDefined(indicators.bollinger, technical.bollinger));

    setText(
      "bollingerUpper",
      formatNumber(firstDefined(bollinger.upper, indicators.bollingerUpper))
    );
    setText(
      "bollingerMiddle",
      formatNumber(firstDefined(bollinger.middle, indicators.bollingerMiddle))
    );
    setText(
      "bollingerLower",
      formatNumber(firstDefined(bollinger.lower, indicators.bollingerLower))
    );

    const levels = asObject(firstDefined(market.levels, indicators.levels));
    setText("support", formatNumber(firstDefined(market.support, levels.support)));
    setText("resistance", formatNumber(firstDefined(market.resistance, levels.resistance)));

    setText(
      "volatility",
      firstDefined(
        market.volatilityLabel,
        indicators.volatilityLabel,
        formatNumber(atr14),
        "—"
      )
    );

    const patterns = asObject(firstDefined(market.patterns, indicators.patterns));
    const candlePattern = firstDefined(
      market.candlePattern,
      patterns.detected,
      patterns.pattern,
      indicators.candlePattern,
      "No confirmed pattern"
    );

    setText("candlePattern", candlePattern);

    const lastCandle = asObject(firstDefined(market.lastCandle, market.candle));
    const candleText = firstDefined(
      market.lastCandleText,
      lastCandle.summary,
      lastCandle.description,
      lastCandle.time ? `Time: ${formatDate(lastCandle.time)}` : null,
      "Latest completed candle details unavailable."
    );

    setText("lastCandle", candleText);

    setText(
      "priceAction",
      firstDefined(
        market.priceAction,
        technical.priceAction,
        indicators.priceAction,
        "Price-action interpretation unavailable."
      )
    );

    setText(
      "psychology",
      firstDefined(
        market.psychology,
        technical.psychology,
        indicators.psychology,
        "Market psychology is not available from this response."
      )
    );

    const reasons = getReasonList(market);

    if (stale) {
      reasons.unshift("NO TRADE: backend reports stale market data.");
    }

    if (insufficient) {
      reasons.unshift("NO TRADE: backend reports insufficient or incomplete evidence.");
    }

    if (signal === "NO TRADE" && reasons.length === 0) {
      reasons.push("NO TRADE: the API did not provide a validated CALL or PUT signal.");
    }

    renderReasons(reasons);

    if (signal === "NO TRADE") {
      setText(
        "signalReason",
        stale
          ? "NO TRADE — market data is stale."
          : insufficient
            ? "NO TRADE — evidence is insufficient or incomplete."
            : firstDefined(signalObject.reason, market.reason, "No validated trade signal is available.")
      );
    } else {
      setText(
        "signalReason",
        firstDefined(signalObject.reason, market.reason, "Signal returned by the backend.")
      );
    }

    const meta = asObject(market.meta);
    setText(
      "provider",
      `Provider: ${firstDefined(meta.provider, market.provider, "Twelve Data LIVE")}`
    );

    setText(
      "lastScanAt",
      formatDate(firstDefined(market.lastScanAt, market.scannedAt, meta.scannedAt, market.updatedAt))
    );

    setText(
      "cachedPairs",
      firstDefined(market.cachedPairs, meta.cachedPairs, asObject(market.scanner).cachedPairs, "—")
    );

    setText(
      "candidateCount",
      firstDefined(market.candidateCount, meta.candidateCount, asObject(market.scanner).candidateCount, "—")
    );

    const scannerStatus = firstDefined(
      market.scannerStatus,
      asObject(market.scanner).status,
      "Analysis updated"
    );

    setBadge(elements.scannerStatus, String(scannerStatus), "status-badge status-unknown");

    renderScanner(firstDefined(market.scannerResults, market.candidates, market.scanner?.results, []));
  }

  function renderScanner(results) {
    if (!elements.scanner) return;

    elements.scanner.replaceChildren();

    if (!Array.isArray(results) || results.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted-text";
      empty.textContent = "No scanner candidates supplied by the API. This does not mean that no market opportunities exist.";
      elements.scanner.appendChild(empty);
      return;
    }

    for (const item of results.slice(0, 24)) {
      const rowData = asObject(item);
      const pair = String(firstDefined(rowData.pair, rowData.symbol, "Unknown pair"));
      const signal = normalizeSignal(rowData);
      const score = getEvidenceScore(rowData);
      const row = document.createElement("article");
      row.className = "scanner-row";

      const pairName = document.createElement("strong");
      pairName.className = "scanner-pair";
      pairName.textContent = pair;

      const badge = document.createElement("span");
      badge.className =
        signal === "CALL"
          ? "scan-call"
          : signal === "PUT"
            ? "scan-put"
            : "scan-wait";
      badge.textContent = signal;

      const scoreElement = document.createElement("span");
      scoreElement.className = "scanner-score";
      scoreElement.textContent = score === null ? "Score: —" : `Score: ${Math.round(score)}/100`;

      const reason = document.createElement("span");
      reason.className = "scanner-reason";
      reason.textContent = String(
        firstDefined(asObject(rowData.signal).reason, rowData.reason, "Evidence review required.")
      );

      row.append(pairName, badge, scoreElement, reason);

      row.addEventListener("click", () => {
        if (elements.selectedPair) {
          elements.selectedPair.value = pair;
        }
        analyzeMarket();
      });

      elements.scanner.appendChild(row);
    }
  }

  async function fetchJson(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: "GET",
        cache: "no-store",
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(options.headers || {})
        }
      });

      const bodyText = await response.text();
      let payload;

      try {
        payload = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        throw new Error(`API returned invalid JSON (${response.status}).`);
      }

      if (!response.ok) {
        const message = firstDefined(
          payload.error,
          payload.message,
          `API request failed (${response.status}).`
        );
        throw new Error(String(message));
      }

      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function checkHealth() {
    try {
      const payload = await fetchJson("/api/health");
      renderHealth(payload);
      return true;
    } catch (error) {
      setBadge(
        elements.backendStatus,
        "API offline / unavailable",
        "status-badge status-offline"
      );
      setText("scanInfo", "Unable to confirm API health.");
      return false;
    }
  }

  async function analyzeMarket() {
    if (state.busy) return;

    state.busy = true;
    clearError();

    if (elements.analyzeBtn) {
      elements.analyzeBtn.disabled = true;
      elements.analyzeBtn.textContent = "Analyzing…";
    }

    const pair = elements.selectedPair?.value || "EUR/USD";
    const timeframe = elements.timeframe?.value || "1";

    try {
      const params = new URLSearchParams({
        pair,
        timeframe
      });

      const payload = await fetchJson(`/api/best?${params.toString()}`);

      if (payload && payload.ok === false) {
        throw new Error(
          String(firstDefined(payload.error, payload.message, "The API could not complete the analysis."))
        );
      }

      renderMarket(payload);

      const market = getMarketObject(payload);
      const signal = normalizeSignal(market);

      if (signal === "NO TRADE") {
        setText(
          "scanInfo",
          `${pair} · ${timeframe}m · Analysis complete · NO TRADE if evidence is insufficient`
        );
      } else {
        setText("scanInfo", `${pair} · ${timeframe}m · Backend signal received`);
      }
    } catch (error) {
      const message = error?.name === "AbortError"
        ? "The API request timed out. Please try again."
        : (error?.message || "Unable to analyze the market.");

      showError(message);
      setText("scanInfo", "Analysis failed. No new signal was generated.");

      setBadge(
        elements.signalBadge,
        "NO TRADE",
        "signal-badge signal-wait"
      );
      setText("signalReason", "NO TRADE — analysis failed or the API could not be verified.");
      renderReasons([message, "No trade decision should be inferred from a failed request."]);
    } finally {
      state.busy = false;

      if (elements.analyzeBtn) {
        elements.analyzeBtn.disabled = false;
        elements.analyzeBtn.textContent = "Analyze market";
      }
    }
  }

  function startRefresh() {
    if (state.timer) clearInterval(state.timer);

    state.timer = setInterval(() => {
      checkHealth();
      analyzeMarket();
    }, REFRESH_INTERVAL_MS);
  }

  function bindEvents() {
    if (elements.analyzeBtn) {
      elements.analyzeBtn.addEventListener("click", analyzeMarket);
    }

    if (elements.selectedPair) {
      elements.selectedPair.addEventListener("change", analyzeMarket);
    }

    if (elements.timeframe) {
      elements.timeframe.addEventListener("change", analyzeMarket);
    }
  }

  async function initialize() {
    bindEvents();
    await checkHealth();
    await analyzeMarket();
    startRefresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
