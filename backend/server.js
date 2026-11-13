
'use strict';

/*
 * PO AI PREDICTOR — V10.6.0
 * LIVE FOREX ONLY. OTC is deliberately not supported here.
 * This backend uses a transparent technical-evidence decision engine.
 * It does not claim to contain a trained machine-learning model.
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const VERSION = 'V10.6.0';
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PROVIDER_URL = 'https://api.twelvedata.com/time_series';

const PRIORITY_PAIRS = Object.freeze([
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD'
]);
const BACKGROUND_PAIRS = Object.freeze([
  'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'EUR/CHF', 'EUR/AUD',
  'EUR/CAD', 'GBP/CHF', 'GBP/AUD', 'GBP/CAD', 'AUD/JPY', 'AUD/CAD',
  'AUD/NZD', 'CAD/JPY', 'CHF/JPY', 'NZD/JPY', 'NZD/CAD', 'EUR/NZD'
]);
const PAIRS = Object.freeze([...PRIORITY_PAIRS, ...BACKGROUND_PAIRS]);

const CFG = Object.freeze({
  outputsize: 500,
  minCandles: 60,
  freshnessMs: 150000,
  hardStaleMs: 300000,
  pairCacheMs: 90000,
  requestsPerMinute: 6,
  requestSpacingMs: 10000,
  providerTimeoutMs: 12000,
  dailyRequestLimit: 768,
  dailyReserve: 32,
  scannerDailyBudget: 576,
  scanIntervalMs: 60 * 60 * 1000,
  minScore: 55,
  minScoreGap: 12,
  maxOpposingScore: 25,
  brokerMaxAgeMs: 30000,
  brokerMaxGapPips: 3,
  backtestMinSamples: 30,
  historyLimit: 5000
});

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

const marketCache = new Map();
const history = [];
const pendingSignals = new Map();
const providerQueue = [];
const providerRequestTimes = [];
let providerWorkerRunning = false;
let lastProviderRequestAt = 0;
let dailyCounterDate = new Date().toISOString().slice(0, 10);
let dailyRequests = 0;
let scannerRequests = 0;
let dbReady = false;
let dbError = null;
let scannerTimer = null;
let scanState = {
  running: false, startedAt: null, completedAt: null, currentPair: null,
  completedPairs: 0, successfulPairs: 0, failedPairs: 0,
  phase: 'WAITING', lastError: null, nextScanAt: null
};

const now = () => Date.now();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n, d = 5) => Number(Number(n).toFixed(d));
const isNum = n => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));
const num = n => isNum(n) ? Number(n) : null;
const iso = t => new Date(t).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalizePair = value => String(value || '').trim().toUpperCase().replace(/\s/g, '');
const validPair = pair => PAIRS.includes(normalizePair(pair));
const pipSize = pair => pair.endsWith('/JPY') ? 0.01 : 0.0001;
const pipGap = (pair, a, b) => Math.abs(Number(a) - Number(b)) / pipSize(pair);

function resetDailyCounterIfNeeded() {
  const date = new Date().toISOString().slice(0, 10);
  if (date !== dailyCounterDate) {
    dailyCounterDate = date;
    dailyRequests = 0;
    scannerRequests = 0;
    providerRequestTimes.length = 0;
  }
}

function metadata() {
  return {
    databaseReady: dbReady,
    databaseError: dbError,
    storage: dbReady ? 'POSTGRESQL' : 'MEMORY_ONLY',
    provider: 'TWELVE_DATA',
    configured: Boolean(API_KEY),
    dailyRequests,
    dailyRequestLimit: CFG.dailyRequestLimit - CFG.dailyReserve,
    scannerRequests,
    scannerDailyBudget: CFG.scannerDailyBudget
  };
}

function normalizeCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const parsed = [];
  for (const row of rows) {
    const closeTime = row.datetime || row.time || row.timestamp;
    let timestamp = typeof closeTime === 'number' ? closeTime : Date.parse(String(closeTime || ''));
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < 1e12) timestamp *= 1000;
    const open = num(row.open), high = num(row.high), low = num(row.low), close = num(row.close);
    const volume = num(row.volume) || 0;
    if ([open, high, low, close].some(v => v === null || v <= 0)) continue;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;
    parsed.push({ timestamp, time: iso(timestamp), open, high, low, close, volume });
  }
  const unique = new Map();
  for (const candle of parsed) unique.set(candle.timestamp, candle);
  return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function enqueueProvider(task) {
  return new Promise((resolve, reject) => {
    providerQueue.push({ task, resolve, reject });
    processProviderQueue().catch(() => {});
  });
}

async function processProviderQueue() {
  if (providerWorkerRunning) return;
  providerWorkerRunning = true;
  try {
    while (providerQueue.length) {
      resetDailyCounterIfNeeded();
      const item = providerQueue[0];
      const nowMs = now();
      while (providerRequestTimes.length && nowMs - providerRequestTimes[0] >= 60000) providerRequestTimes.shift();
      const waitSpacing = Math.max(0, CFG.requestSpacingMs - (nowMs - lastProviderRequestAt));
      const waitMinute = providerRequestTimes.length >= CFG.requestsPerMinute
        ? Math.max(0, 60000 - (nowMs - providerRequestTimes[0])) : 0;
      const wait = Math.max(waitSpacing, waitMinute);
      if (wait > 0) await sleep(wait);
      resetDailyCounterIfNeeded();
      if (dailyRequests >= CFG.dailyRequestLimit - CFG.dailyReserve) {
        providerQueue.shift();
        item.reject(new Error('DAILY_PROVIDER_BUDGET_EXHAUSTED'));
        continue;
      }
      providerQueue.shift();
      const requestAt = now();
      lastProviderRequestAt = requestAt;
      providerRequestTimes.push(requestAt);
      dailyRequests += 1;
      if (item.task.source === 'scanner') scannerRequests += 1;
      try { item.resolve(await item.task.run()); }
      catch (error) { item.reject(error); }
    }
  } finally {
    providerWorkerRunning = false;
    if (providerQueue.length) processProviderQueue().catch(() => {});
  }
}

async function providerFetch(pair, source = 'manual', force = false) {
  if (!API_KEY) throw new Error('TWELVE_DATA_API_KEY_NOT_CONFIGURED');
  const cached = marketCache.get(pair);
  if (!force && cached && now() - cached.fetchedAt <= CFG.pairCacheMs && cached.candles.length >= CFG.minCandles) {
    return { candles: cached.candles, fetchedAt: cached.fetchedAt, source: 'CACHE' };
  }
  return enqueueProvider({ source, run: async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CFG.providerTimeoutMs);
    try {
      const url = new URL(PROVIDER_URL);
      url.searchParams.set('symbol', pair.replace('/', '/'));
      url.searchParams.set('interval', '1min');
      url.searchParams.set('outputsize', String(CFG.outputsize));
      url.searchParams.set('format', 'JSON');
      url.searchParams.set('timezone', 'UTC');
      url.searchParams.set('apikey', API_KEY);
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || data.status === 'error' || data.code || !Array.isArray(data.values)) {
        throw new Error(data.message || data.status || `TWELVE_DATA_HTTP_${response.status}`);
      }
      const candles = normalizeCandles(data.values);
      if (candles.length < CFG.minCandles) throw new Error(`INSUFFICIENT_CANDLES_${candles.length}`);
      return { candles, fetchedAt: now(), source: 'TWELVE_DATA' };
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('TWELVE_DATA_TIMEOUT');
      throw error;
    } finally { clearTimeout(timeout); }
  }});
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = Array(period - 1).fill(null);
  result.push(current);
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    result.push(current);
  }
  return result;
}

function calculateMacd(values) {
  if (values.length < 35) return { line: null, signal: null, histogram: null, crossover: 'UNAVAILABLE' };
  const fast = emaSeries(values, 12), slow = emaSeries(values, 26);
  const line = values.map((_, i) => fast[i] === null || slow[i] === null ? null : fast[i] - slow[i]);
  const compact = line.filter(v => v !== null);
  const signalSeries = emaSeries(compact, 9);
  const currentLine = line[line.length - 1];
  const previousLine = line[line.length - 2];
  const currentSignal = signalSeries[signalSeries.length - 1];
  const previousSignal = signalSeries[signalSeries.length - 2];
  let crossover = 'NEUTRAL';
  if (previousLine !== null && previousSignal !== null && currentLine > currentSignal && previousLine <= previousSignal) crossover = 'BULLISH';
  else if (previousLine !== null && previousSignal !== null && currentLine < currentSignal && previousLine >= previousSignal) crossover = 'BEARISH';
  else if (currentLine > currentSignal) crossover = 'BULLISH';
  else if (currentLine < currentSignal) crossover = 'BEARISH';
  return { line: currentLine, signal: currentSignal, histogram: currentLine - currentSignal, crossover };
}

function calculateAtr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateBollinger(values, period = 20, mult = 2) {
  if (values.length < period) return { upper: null, middle: null, lower: null, width: null, position: 'UNAVAILABLE' };
  const slice = values.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance), upper = middle + mult * sd, lower = middle - mult * sd;
  const current = values[values.length - 1];
  return { upper, middle, lower, width: middle ? (upper - lower) / middle * 100 : null,
    position: current > upper ? 'ABOVE_UPPER' : current < lower ? 'BELOW_LOWER' : current >= middle ? 'UPPER_HALF' : 'LOWER_HALF' };
}

function detectCandlePattern(candles) {
  if (candles.length < 2) return { name: 'NONE', direction: 'NEUTRAL', strength: 0 };
  const c = candles[candles.length - 1], p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open), range = Math.max(c.high - c.low, 1e-12);
  const upperWick = c.high - Math.max(c.open, c.close), lowerWick = Math.min(c.open, c.close) - c.low;
  if (c.close > c.open && p.close < p.open && c.close >= p.open && c.open <= p.close) return { name: 'BULLISH_ENGULFING', direction: 'BUY', strength: 2 };
  if (c.close < c.open && p.close > p.open && c.open >= p.close && c.close <= p.open) return { name: 'BEARISH_ENGULFING', direction: 'SELL', strength: 2 };
  if (lowerWick > body * 2 && upperWick < body && c.close > c.open) return { name: 'BULLISH_PIN_BAR', direction: 'BUY', strength: 1 };
  if (upperWick > body * 2 && lowerWick < body && c.close < c.open) return { name: 'BEARISH_PIN_BAR', direction: 'SELL', strength: 1 };
  if (body / range > 0.72 && c.close > c.open) return { name: 'BULLISH_MARUBOZU', direction: 'BUY', strength: 1 };
  if (body / range > 0.72 && c.close < c.open) return { name: 'BEARISH_MARUBOZU', direction: 'SELL', strength: 1 };
  return { name: 'NO_CLEAR_PATTERN', direction: 'NEUTRAL', strength: 0 };
}

function detectRecentCross(candles) {
  const closes = candles.map(c => c.close);
  const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21);
  for (let i = closes.length - 1; i >= Math.max(1, closes.length - 4); i--) {
    const p9 = e9[i - 1], p21 = e21[i - 1], c9 = e9[i], c21 = e21[i];
    if ([p9, p21, c9, c21].some(v => v === null)) continue;
    if (p9 <= p21 && c9 > c21) return { direction: 'BUY', barsAgo: closes.length - 1 - i, ema9: c9, ema21: c21 };
    if (p9 >= p21 && c9 < c21) return { direction: 'SELL', barsAgo: closes.length - 1 - i, ema9: c9, ema21: c21 };
  }
  return { direction: 'NONE', barsAgo: null, ema9: e9[e9.length - 1], ema21: e21[e21.length - 1] };
}

function followThrough(candles, direction) {
  if (candles.length < 3) return false;
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  const body = Math.abs(last.close - last.open), range = Math.max(last.high - last.low, 1e-12);
  if (direction === 'BUY') return last.close > last.open && last.close >= prev.close && last.close >= last.low + range * 0.65 && body / range >= 0.25;
  if (direction === 'SELL') return last.close < last.open && last.close <= prev.close && last.close <= last.high - range * 0.65 && body / range >= 0.25;
  return false;
}

function supportResistance(candles) {
  const sample = candles.slice(-40);
  return { support: Math.min(...sample.map(c => c.low)), resistance: Math.max(...sample.map(c => c.high)) };
}

function volatilityInfo(atr, price, bollinger) {
  const atrPercent = atr && price ? atr / price * 100 : null;
  const width = num(bollinger.width);
  let regime = 'NORMAL';
  if (atrPercent !== null && atrPercent > 0.12 || width !== null && width > 0.65) regime = 'HIGH';
  else if (atrPercent !== null && atrPercent < 0.025 && width !== null && width < 0.12) regime = 'LOW';
  return { regime, atrPercent, bollingerWidth: width, riskAdjustment: regime === 'HIGH' ? -8 : regime === 'LOW' ? -2 : 0 };
}

function analyzeMarket(pair, sourceCandles, fetchedAt = now()) {
  const candles = sourceCandles.filter(c => c.timestamp + 60000 <= now() + 5000);
  if (candles.length < CFG.minCandles) return noTrade(pair, 'INSUFFICIENT_CLOSED_CANDLES');
  const closes = candles.map(c => c.close), current = candles[candles.length - 1];
  const ema9Series = emaSeries(closes, 9), ema21Series = emaSeries(closes, 21);
  const ema9 = ema9Series.at(-1), ema21 = ema21Series.at(-1);
  const cross = detectRecentCross(candles);
  const macd = calculateMacd(closes), atr14 = calculateAtr(candles);
  const bollinger = calculateBollinger(closes), pattern = detectCandlePattern(candles);
  const levels = supportResistance(candles), volatility = volatilityInfo(atr14, current.close, bollinger);
  const buy = { score: 0, evidence: [] }, sell = { score: 0, evidence: [] };
  const add = (side, points, reason) => { side.score += points; side.evidence.push(reason); };

  if (cross.direction === 'BUY') add(buy, 24, 'Recent EMA9 crossed above EMA21');
  if (cross.direction === 'SELL') add(sell, 24, 'Recent EMA9 crossed below EMA21');
  if (cross.direction === 'BUY' && cross.barsAgo >= 1 && followThrough(candles, 'BUY')) add(buy, 22, 'Bullish price-action follow-through confirmed after EMA crossover');
  if (cross.direction === 'SELL' && cross.barsAgo >= 1 && followThrough(candles, 'SELL')) add(sell, 22, 'Bearish price-action follow-through confirmed after EMA crossover');
  if (ema9 > ema21 && current.close > ema9) add(buy, 8, 'Price is holding above aligned EMA9/EMA21');
  if (ema9 < ema21 && current.close < ema9) add(sell, 8, 'Price is holding below aligned EMA9/EMA21');
  if (macd.crossover === 'BULLISH') add(buy, 10, 'MACD momentum supports bullish direction');
  if (macd.crossover === 'BEARISH') add(sell, 10, 'MACD momentum supports bearish direction');
  if (pattern.direction === 'BUY') add(buy, pattern.strength * 6, `Candlestick pattern: ${pattern.name}`);
  if (pattern.direction === 'SELL') add(sell, pattern.strength * 6, `Candlestick pattern: ${pattern.name}`);

  const recent = candles.slice(-8);
  const recentHigh = Math.max(...recent.slice(0, -1).map(c => c.high));
  const recentLow = Math.min(...recent.slice(0, -1).map(c => c.low));
  let breakout = { status: 'NO_BREAKOUT', description: 'No confirmed range breakout', direction: 'NONE' };
  if (current.close > recentHigh) {
    const retest = recent.slice(-4).some(c => c.low <= recentHigh && c.close > recentHigh);
    breakout = { status: retest ? 'BULLISH_BREAKOUT_RETEST' : 'BULLISH_BREAKOUT', description: retest ? 'Bullish range break held on a retest' : 'Price closed above recent range high', direction: 'BUY' };
    add(buy, retest ? 10 : 5, breakout.description);
  } else if (current.close < recentLow) {
    const retest = recent.slice(-4).some(c => c.high >= recentLow && c.close < recentLow);
    breakout = { status: retest ? 'BEARISH_BREAKOUT_RETEST' : 'BEARISH_BREAKOUT', description: retest ? 'Bearish range break held on a retest' : 'Price closed below recent range low', direction: 'SELL' };
    add(sell, retest ? 10 : 5, breakout.description);
  }
  if (volatility.regime === 'HIGH') { buy.score -= 8; sell.score -= 8; }
  else if (volatility.regime === 'LOW') { buy.score -= 2; sell.score -= 2; }

  const buyScore = Math.round(clamp(buy.score, 0, 100));
  const sellScore = Math.round(clamp(sell.score, 0, 100));
  const direction = buyScore >= sellScore ? 'BUY' : 'SELL';
  const selectedScore = Math.max(buyScore, sellScore), opposingScore = Math.min(buyScore, sellScore);
  const gap = selectedScore - opposingScore;
  const crossAligned = cross.direction === direction;
  const priceActionConfirmed = cross.barsAgo !== null && cross.barsAgo >= 1 && cross.direction === direction && followThrough(candles, direction);
  const rejectedReasons = [];
  if (cross.direction === 'NONE') rejectedReasons.push('EMA_CROSS_NOT_RECENT');
  if (!crossAligned) rejectedReasons.push('EMA_CROSS_DIRECTION_MISMATCH');
  if (!priceActionConfirmed) rejectedReasons.push(cross.barsAgo === 0 ? 'WAITING_FOR_PRICE_ACTION_AFTER_CROSS' : 'PRICE_ACTION_FOLLOW_THROUGH_MISSING');
  if (selectedScore < CFG.minScore) rejectedReasons.push('EVIDENCE_SCORE_BELOW_MINIMUM');
  if (gap < CFG.minScoreGap) rejectedReasons.push('CONFLICTING_EVIDENCE_SCORE_GAP');
  if (opposingScore >= CFG.maxOpposingScore) rejectedReasons.push('OPPOSING_EVIDENCE_TOO_HIGH');
  const qualified = crossAligned && cross.barsAgo !== null && cross.barsAgo >= 1 && priceActionConfirmed && selectedScore >= CFG.minScore && gap >= CFG.minScoreGap && opposingScore < CFG.maxOpposingScore;
  const selectedEvidence = direction === 'BUY' ? buy.evidence : sell.evidence;
  const evidenceScore = qualified ? selectedScore : Math.min(selectedScore, 49);
  const reasons = [...selectedEvidence, ...rejectedReasons];
  const dataAgeSeconds = Math.max(0, (now() - (current.timestamp + 60000)) / 1000);
  return {
    pair, signal: qualified ? direction : 'NO TRADE', direction: qualified ? direction : 'NONE',
    tradeAllowed: qualified, qualified, confidence: evidenceScore, evidenceScore,
    evidenceLabel: evidenceScore >= 75 ? 'STRONG' : evidenceScore >= 55 ? 'MODERATE' : 'INSUFFICIENT',
    scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY', score: selectedScore, buyScore, sellScore,
    scoreGap: gap, opposingScore, currentPrice: current.close, entryPrice: current.close,
    candleTime: current.time, lastCandle: current.time, fetchedAt: iso(fetchedAt),
    dataAgeSeconds, freshness: dataAgeSeconds <= CFG.freshnessMs / 1000 ? 'FRESH' : 'STALE',
    insufficientData: false, reasons, evidence: selectedEvidence, rejectedReasons,
    indicators: { ema9, ema21, emaCross: cross.direction, emaCrossBarsAgo: cross.barsAgo,
      macd, atr14, bollinger },
    volatility, supportResistance: { ...levels, position: current.close <= levels.support * 1.001 ? 'NEAR_SUPPORT' : current.close >= levels.resistance * 0.999 ? 'NEAR_RESISTANCE' : 'BETWEEN_LEVELS' },
    trendLine: { direction: ema9 > ema21 ? 'UP' : ema9 < ema21 ? 'DOWN' : 'FLAT', description: 'EMA alignment used as a simple trend context' },
    candlePattern: pattern, breakout, marketPsychology: { psychology: current.close > current.open ? 'BUYING_PRESSURE' : current.close < current.open ? 'SELLING_PRESSURE' : 'BALANCED', direction: current.close > current.open ? 'BUY' : current.close < current.open ? 'SELL' : 'NEUTRAL' },
    oneMinuteTrend: ema9 > ema21 ? 'BULLISH' : ema9 < ema21 ? 'BEARISH' : 'NEUTRAL',
    analysisEngine: 'TECHNICAL_EVIDENCE_FUSION_NO_TRAINED_ML_MODEL'
  };
}

function noTrade(pair, reason, extra = {}) {
  return { pair: pair || null, signal: 'NO TRADE', direction: 'NONE', tradeAllowed: false, qualified: false,
    confidence: 0, evidenceScore: 0, evidenceLabel: 'INSUFFICIENT', scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY',
    freshness: 'UNKNOWN', insufficientData: true, reasons: [reason], rejectedReasons: [reason], ...extra };
}

function storeMarket(pair, result, source) {
  const entry = { pair, candles: result.candles, fetchedAt: result.fetchedAt, source: source || result.source || 'TWELVE_DATA' };
  marketCache.set(pair, entry);
  return entry;
}

function getCachedAnalysis(pair) {
  const entry = marketCache.get(pair);
  if (!entry) return noTrade(pair, 'NO_CACHED_MARKET_DATA', { freshness: 'UNKNOWN', dataAgeSeconds: null });
  const age = now() - entry.fetchedAt;
  if (age < 0 || age > CFG.freshnessMs || entry.candles.length < CFG.minCandles) {
    return noTrade(pair, age > CFG.hardStaleMs ? 'MARKET_DATA_HARD_STALE' : 'MARKET_DATA_NOT_FRESH', {
      freshness: 'STALE', fetchedAt: iso(entry.fetchedAt), dataAgeSeconds: Math.max(0, age / 1000), insufficientData: entry.candles.length < CFG.minCandles
    });
  }
  return { ...analyzeMarket(pair, entry.candles, entry.fetchedAt), dataSource: entry.source };
}

function getFreshAnalyses(pairs = PAIRS) {
  return pairs.map(getCachedAnalysis).filter(x => x.freshness === 'FRESH' && x.insufficientData !== true);
}

function scannerSnapshot() {
  const fresh = getFreshAnalyses(PAIRS);
  return { running: scanState.running, progress: { phase: scanState.phase, pair: scanState.currentPair,
    completed: scanState.completedPairs, total: PAIRS.length, priorityCompleted: Math.min(scanState.completedPairs, PRIORITY_PAIRS.length), priorityTotal: PRIORITY_PAIRS.length },
    startedAt: scanState.startedAt ? iso(scanState.startedAt) : null,
    completedAt: scanState.completedAt ? iso(scanState.completedAt) : null,
    completedPairs: scanState.completedPairs, successfulPairs: scanState.successfulPairs,
    failedPairs: scanState.failedPairs, lastError: scanState.lastError,
    nextScanAt: scanState.nextScanAt ? iso(scanState.nextScanAt) : null,
    freshCachedPairs: fresh.length, priorityPairs: PRIORITY_PAIRS, backgroundPairs: BACKGROUND_PAIRS };
}

function rankedCandidates() {
  return getFreshAnalyses(PAIRS).sort((a, b) => b.evidenceScore - a.evidenceScore || b.scoreGap - a.scoreGap)
    .map(x => ({ pair: x.pair, currentPrice: x.currentPrice, oneMinuteTrend: x.oneMinuteTrend,
      volatility: x.volatility?.regime || 'UNKNOWN',
      confidence: x.confidence, freshness: x.freshness, tradeAllowed: x.tradeAllowed }));
}

function makeAutoResponse() {
  const eligible = getFreshAnalyses(PAIRS).filter(x => x.qualified).sort((a, b) => b.evidenceScore - a.evidenceScore || b.scoreGap - a.scoreGap);
  const selected = eligible[0] || null;
  const scanner = scannerSnapshot();
  if (!selected) return { ok: true, version: VERSION, selectedMarket: noTrade(null, scanner.running ? 'FULL_24_PAIR_SCAN_IN_PROGRESS' : 'NO_FRESH_QUALIFIED_PAIR'), market: noTrade(null, 'NO_FRESH_QUALIFIED_PAIR'), scanner, rankedCandidates: rankedCandidates(), diagnostic: { lastScanError: scanState.lastError } };
  return { ok: true, version: VERSION, selectedPair: selected.pair, selectedMarket: selected, market: selected, scanner, rankedCandidates: rankedCandidates() };
}

async function scanPair(pair) {
  const result = await providerFetch(pair, 'scanner', true);
  storeMarket(pair, result, 'TWELVE_DATA_BACKGROUND_SCAN');
  return analyzeMarket(pair, result.candles, result.fetchedAt);
}

async function runBackgroundScan(force = false) {
  if (scanState.running) return { started: false, reason: 'SCAN_ALREADY_RUNNING' };
  resetDailyCounterIfNeeded();
  const remainingDaily = CFG.dailyRequestLimit - CFG.dailyReserve - dailyRequests;
  const remainingScanner = CFG.scannerDailyBudget - scannerRequests;
  if (remainingDaily <= 0 || remainingScanner <= 0) return { started: false, reason: 'DAILY_SCAN_BUDGET_EXHAUSTED' };
  if (!force && scanState.nextScanAt && now() < scanState.nextScanAt) return { started: false, reason: 'SCAN_INTERVAL_NOT_REACHED', nextScanAt: iso(scanState.nextScanAt) };
  scanState = { ...scanState, running: true, startedAt: now(), completedAt: null, currentPair: null, completedPairs: 0, successfulPairs: 0, failedPairs: 0, phase: 'PRIORITY', lastError: null };
  const ordered = [...PRIORITY_PAIRS, ...BACKGROUND_PAIRS];
  try {
    for (const pair of ordered) {
      resetDailyCounterIfNeeded();
      if (dailyRequests >= CFG.dailyRequestLimit - CFG.dailyReserve || scannerRequests >= CFG.scannerDailyBudget) {
        scanState.lastError = 'SCANNER_DAILY_BUDGET_REACHED';
        break;
      }
      scanState.currentPair = pair;
      scanState.phase = scanState.completedPairs < PRIORITY_PAIRS.length ? 'PRIORITY' : 'BACKGROUND';
      try { await scanPair(pair); scanState.successfulPairs += 1; }
      catch (error) { scanState.failedPairs += 1; scanState.lastError = error.message; }
      scanState.completedPairs += 1;
    }
    scanState.completedAt = now();
    scanState.nextScanAt = scanState.completedAt + CFG.scanIntervalMs;
    scanState.phase = 'COMPLETE';
    return { started: true, completed: true, completedPairs: scanState.completedPairs, successfulPairs: scanState.successfulPairs, failedPairs: scanState.failedPairs };
  } finally {
    scanState.running = false;
    scanState.currentPair = null;
    if (!scanState.nextScanAt) scanState.nextScanAt = now() + CFG.scanIntervalMs;
  }
}

function launchScan(force = false) {
  if (scanState.running) return { started: false, reason: 'SCAN_ALREADY_RUNNING' };
  if (!force && scanState.nextScanAt && now() < scanState.nextScanAt) return { started: false, reason: 'SCAN_INTERVAL_NOT_REACHED', nextScanAt: iso(scanState.nextScanAt) };
  runBackgroundScan(force).catch(error => { scanState.lastError = error.message; scanState.running = false; });
  return { started: true, accepted: true, message: 'Background scan started: six priority pairs first, followed by eighteen background pairs.' };
}

function parseCapturedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function validateBrokerQuote(body) {
  const brokerPrice = num(body?.brokerPrice);
  const capturedAt = parseCapturedAt(body?.brokerPriceCapturedAt);
  if (brokerPrice === null || brokerPrice <= 0) return { valid: false, reason: 'BROKER_PRICE_MISSING_OR_INVALID' };
  if (capturedAt === null) return { valid: false, reason: 'BROKER_PRICE_TIMESTAMP_MISSING' };
  const ageMs = now() - capturedAt;
  if (ageMs < -5000 || ageMs > CFG.brokerMaxAgeMs) return { valid: false, reason: 'BROKER_PRICE_TOO_OLD_OR_INVALID', ageMs, maxAgeMs: CFG.brokerMaxAgeMs };
  return { valid: true, brokerPrice, capturedAt, ageMs };
}

function historyRecord(record) {
  history.unshift(record);
  if (history.length > CFG.historyLimit) history.length = CFG.historyLimit;
}

async function initializeDatabase() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS po_signal_history (
      id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), pair TEXT NOT NULL,
      signal TEXT NOT NULL, entry_price DOUBLE PRECISION, reference_price DOUBLE PRECISION,
      broker_price DOUBLE PRECISION, entry_time TIMESTAMPTZ, expiry_time TIMESTAMPTZ,
      outcome TEXT NOT NULL DEFAULT 'PENDING', outcome_price DOUBLE PRECISION,
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS po_signal_history_created_at_idx ON po_signal_history(created_at DESC)');
    dbReady = true; dbError = null;
  } catch (error) { dbReady = false; dbError = error.message; }
}

async function saveSignal(record) {
  historyRecord(record);
  pendingSignals.set(record.signalId, record);
  if (!pool || !dbReady) return;
  try {
    await pool.query(`INSERT INTO po_signal_history
      (id, pair, signal, entry_price, reference_price, broker_price, entry_time, expiry_time, outcome, details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9::jsonb)
      ON CONFLICT (id) DO NOTHING`, [record.signalId, record.pair, record.direction, record.entryPrice,
      record.referencePrice, record.brokerPrice, new Date(record.entryTime), new Date(record.expiryTime), JSON.stringify(record)]);
  } catch (error) { dbError = error.message; }
}

async function getHistory(limit = 100) {
  if (pool && dbReady) {
    try {
      const result = await pool.query('SELECT id AS "signalId", pair, signal AS direction, entry_price AS "entryPrice", reference_price AS "referencePrice", broker_price AS "brokerPrice", entry_time AS "entryTime", expiry_time AS "expiryTime", outcome, outcome_price AS "outcomePrice", details, created_at AS "createdAt" FROM po_signal_history ORDER BY created_at DESC LIMIT $1', [limit]);
      return result.rows.map(row => ({ ...row.details, ...row, signal: row.direction }));
    } catch (error) { dbError = error.message; }
  }
  return history.slice(0, limit);
}

async function updateOutcome(signalId, outcome, expiryPrice, details = {}) {
  const record = pendingSignals.get(signalId);
  if (!record) throw new Error('SIGNAL_NOT_FOUND');
  if (record.outcome !== 'PENDING') throw new Error('OUTCOME_ALREADY_RECORDED');
  record.outcome = outcome;
  record.outcomePrice = expiryPrice;
  record.outcomeUpdatedAt = iso(now());
  record.outcomeDetails = details;
  pendingSignals.set(signalId, record);
  const item = history.find(x => x.signalId === signalId);
  if (item) Object.assign(item, record);
  if (pool && dbReady) {
    try { await pool.query('UPDATE po_signal_history SET outcome=$2, outcome_price=$3, details=details || $4::jsonb WHERE id=$1', [signalId, outcome, expiryPrice, JSON.stringify({ outcome, outcomePrice: expiryPrice, outcomeUpdatedAt: record.outcomeUpdatedAt, outcomeDetails: details })]); }
    catch (error) { dbError = error.message; }
  }
  return record;
}

function calculateOutcome(direction, entry, exit) {
  if (!isNum(entry) || !isNum(exit) || Number(entry) <= 0 || Number(exit) <= 0) return 'INVALID';
  const diff = Number(exit) - Number(entry);
  if (Math.abs(diff) < 1e-10) return 'TIE';
  return direction === 'BUY' ? (diff > 0 ? 'WIN' : 'LOSS') : (diff < 0 ? 'WIN' : 'LOSS');
}

function marketResponse(market) {
  const fresh = market.freshness === 'FRESH' && market.insufficientData !== true;
  return { ...market, ok: true, version: VERSION, confidence: market.evidenceScore ?? market.confidence ?? 0,
    dataAgeSeconds: market.dataAgeSeconds ?? null, freshness: fresh ? 'FRESH' : market.freshness || 'STALE',
    tradeAllowed: market.tradeAllowed === true, signal: market.tradeAllowed ? market.direction : 'NO TRADE' };
}

async function confirmHandler(req, res) {
  const pair = normalizePair(req.body?.pair);
  if (!validPair(pair)) return res.status(400).json({ ok: false, reason: 'UNSUPPORTED_PAIR' });
  const mode = String(req.body?.mode || '').trim().toUpperCase();
  if (mode.includes('OTC')) return res.status(400).json({ ok: false, reason: 'LIVE_FOREX_ONLY' });
  if (![1, '1'].includes(req.body?.expiryMinutes)) return res.status(400).json({ ok: false, reason: 'LIVE_EXPIRY_MUST_BE_ONE_MINUTE' });
  const initial = validateBrokerQuote(req.body);
  if (!initial.valid) return res.status(400).json({ ok: false, reason: initial.reason, ...initial });
  let provider;
  try { provider = await providerFetch(pair, 'confirm', true); }
  catch (error) { return res.status(503).json({ ok: false, reason: 'FRESH_PROVIDER_DATA_UNAVAILABLE', detail: error.message }); }
  const quote = validateBrokerQuote(req.body);
  if (!quote.valid) return res.status(400).json({ ok: false, reason: quote.reason, ...quote });
  storeMarket(pair, provider, 'TWELVE_DATA_CONFIRMATION');
  const analysis = analyzeMarket(pair, provider.candles, provider.fetchedAt);
  if (!analysis.qualified || analysis.freshness !== 'FRESH') return res.status(409).json({ ok: false, reason: 'FRESH_ANALYSIS_NOT_QUALIFIED', market: marketResponse(analysis), tradeAllowed: false });
  const referencePrice = analysis.currentPrice;
  const gap = pipGap(pair, quote.brokerPrice, referencePrice);
  if (!Number.isFinite(gap) || gap > CFG.brokerMaxGapPips) return res.status(409).json({ ok: false, reason: 'BROKER_PRICE_OUTSIDE_REFERENCE_TOLERANCE', market: marketResponse(analysis), tradeAllowed: false, brokerPrice: { validated: false, status: 'REJECTED', price: quote.brokerPrice, referencePrice, differencePips: round(gap, 2), capturedAt: iso(quote.capturedAt) } });
  const finalQuote = validateBrokerQuote(req.body);
  if (!finalQuote.valid) return res.status(400).json({ ok: false, reason: finalQuote.reason, ...finalQuote });
  const confirmedAt = now(), expiryAt = confirmedAt + 60000;
  const signalId = `PO-${confirmedAt.toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const market = marketResponse({ ...analysis, tradeAllowed: true, signal: analysis.direction,
    entryPrice: quote.brokerPrice, currentPrice: referencePrice, referencePrice,
    entryTime: iso(confirmedAt), expiryTime: iso(expiryAt), reason: 'Fresh market data, recent EMA crossover, price-action follow-through, evidence thresholds and broker quote checks passed.' });
  const record = { signalId, pair, direction: analysis.direction, signal: analysis.direction,
    mode: 'LIVE_FOREX', entryPrice: quote.brokerPrice, referencePrice, brokerPrice: quote.brokerPrice,
    brokerPriceCapturedAt: iso(quote.capturedAt), gapPips: round(gap, 2), entryTime: iso(confirmedAt),
    expiryTime: iso(expiryAt), expiryAt, createdAt: iso(confirmedAt), outcome: 'PENDING',
    evidenceScore: analysis.evidenceScore, evidenceLabel: analysis.evidenceLabel, market };
  await saveSignal(record);
  return res.json({ ok: true, version: VERSION, confirmed: true, tradeAllowed: true,
    signalId, selectedPair: pair, market, result: market,
    brokerPrice: { validated: true, status: 'VALIDATED', price: quote.brokerPrice,
      referencePrice, differencePips: round(gap, 2), capturedAt: iso(quote.capturedAt) },
    entryPrice: quote.brokerPrice, entryTime: iso(confirmedAt), expiryTime: iso(expiryAt),
    evidenceScore: analysis.evidenceScore, evidenceLabel: analysis.evidenceLabel,
    scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY', outcome: 'PENDING' });
}

function backtest(pair, candles, expiryMinutes) {
  const expiry = Number(expiryMinutes);
  if (![1, 2, 3].includes(expiry)) return { ok: false, reason: 'INVALID_EXPIRY' };
  const valid = candles.filter(c => c && isNum(c.close) && isNum(c.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  if (valid.length < CFG.minCandles + expiry + 2) return { ok: false, reason: 'INSUFFICIENT_BACKTEST_HISTORY' };
  const trades = [];
  for (let i = CFG.minCandles - 1; i + expiry < valid.length; i++) {
    const window = valid.slice(0, i + 1);
    const analysis = analyzeMarket(pair, window, valid[i].timestamp);
    if (!analysis.qualified) continue;
    const entry = valid[i].close, exit = valid[i + expiry].close;
    trades.push({ direction: analysis.direction, outcome: calculateOutcome(analysis.direction, entry, exit), entryTime: valid[i].time, expiryTime: valid[i + expiry].time, evidenceScore: analysis.evidenceScore });
  }
  const split = Math.floor(trades.length * 0.7), development = trades.slice(0, split), holdout = trades.slice(split);
  const wins = holdout.filter(t => t.outcome === 'WIN').length;
  const losses = holdout.filter(t => t.outcome === 'LOSS').length;
  const ties = holdout.filter(t => t.outcome === 'TIE').length;
  const decisive = wins + losses;
  const hitRate = decisive ? wins / decisive * 100 : null;
  const sufficient = decisive >= CFG.backtestMinSamples;
  return { ok: true, result: { method: 'Walk-forward chronological holdout (70/30)', expiryMinutes: expiry,
    coveragePercent: valid.length ? trades.length / Math.max(1, valid.length - CFG.minCandles - expiry) * 100 : 0,
    development: { signals: development.length, wins: development.filter(t => t.outcome === 'WIN').length },
    holdout: { signals: holdout.length, hits: wins, losses, ties, hitRate: hitRate === null ? null : round(hitRate, 2), baselinePercent: decisive ? round(50, 2) : null, sufficientSample: sufficient },
    conclusion: sufficient ? 'Historical holdout sample available; not a guarantee of future performance.' : 'INSUFFICIENT HOLDOUT SAMPLE — no reliable performance conclusion.' },
    trades: trades.slice(-200), scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY' };
}

app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION, service: 'PO AI PREDICTOR', mode: 'LIVE_FOREX_ONLY', provider: 'TWELVE DATA', configured: Boolean(API_KEY), scannerRunning: scanState.running, scanProgress: scannerSnapshot().progress, metadata: metadata(), timestamp: iso(now()) }));
app.get('/api/status', (req, res) => res.json({ ok: true, version: VERSION, mode: 'LIVE_FOREX_ONLY', pairs: PAIRS, priorityPairs: PRIORITY_PAIRS, backgroundPairs: BACKGROUND_PAIRS, metadata: metadata(), scanner: scannerSnapshot() }));
app.get('/api/scanner/status', (req, res) => res.json({ ok: true, scanner: scannerSnapshot() }));
app.get('/api/analyze', (req, res) => {
  const pair = normalizePair(req.query.pair);
  if (pair) {
    if (!validPair(pair)) return res.status(400).json({ ok: false, reason: 'UNSUPPORTED_PAIR' });
    const market = marketResponse(getCachedAnalysis(pair));
    return res.json({ ok: true, version: VERSION, pair, market, selectedMarket: market, result: market, rankedCandidates: rankedCandidates(), scanner: { running: false, progress: scannerSnapshot().progress } });
  }
  const response = makeAutoResponse();
  if (!response.selectedMarket?.qualified && !scanState.running) launchScan(false);
  response.scanner = { ...scannerSnapshot(), progress: scannerSnapshot().progress };
  return res.json(response);
});
app.get('/api/best', (req, res) => {
  const response = makeAutoResponse();
  return res.json({ ...response, scanner: scannerSnapshot() });
});
app.get('/api/markets', (req, res) => res.json({ ok: true, version: VERSION, totalPairs: PAIRS.length, freshPairs: getFreshAnalyses().length, rankedCandidates: rankedCandidates(), scanner: scannerSnapshot() }));
app.post('/api/scan', (req, res) => {
  const result = launchScan(req.body?.force === true);
  const status = result.reason === 'SCAN_ALREADY_RUNNING' ? 409 : result.reason === 'SCAN_INTERVAL_NOT_REACHED' ? 429 : 202;
  return res.status(status).json({ ok: status < 400, ...result, scanner: scannerSnapshot(), rankedCandidates: rankedCandidates() });
});
app.post('/api/scanner/start', (req, res) => {
  const result = launchScan(req.body?.force === true);
  const status = result.reason === 'SCAN_ALREADY_RUNNING' ? 409 : result.reason === 'SCAN_INTERVAL_NOT_REACHED' ? 429 : 202;
  return res.status(status).json({ ok: status < 400, ...result, scanner: scannerSnapshot(), rankedCandidates: rankedCandidates() });
});
app.post('/api/scan/pair', async (req, res) => {
  const pair = normalizePair(req.body?.pair);
  if (!validPair(pair)) return res.status(400).json({ ok: false, reason: 'UNSUPPORTED_PAIR' });
  try { const result = await scanPair(pair); return res.json({ ok: true, pair, market: marketResponse(result) }); }
  catch (error) { return res.status(503).json({ ok: false, pair, reason: error.message }); }
});
app.post('/api/confirm-signal', confirmHandler);
app.post('/api/confirm', confirmHandler);
app.get('/api/history', async (req, res) => {
  const limit = clamp(Math.floor(Number(req.query.limit) || 50), 1, 200);
  const records = await getHistory(limit);
  return res.json({ ok: true, version: VERSION, count: records.length, history: records, persistent: dbReady });
});
app.get('/api/signal/:signalId', (req, res) => {
  const signal = pendingSignals.get(req.params.signalId);
  if (!signal) return res.status(404).json({ ok: false, reason: 'SIGNAL_NOT_FOUND' });
  return res.json({ ok: true, signal });
});
app.post('/api/signal/outcome', async (req, res) => {
  const id = String(req.body?.signalId || '');
  const signal = pendingSignals.get(id);
  if (!signal) return res.status(404).json({ ok: false, reason: 'SIGNAL_NOT_FOUND' });
  const expiryPrice = num(req.body?.expiryPrice), capturedAt = parseCapturedAt(req.body?.expiryPriceAt);
  if (expiryPrice === null || expiryPrice <= 0 || capturedAt === null || capturedAt < signal.expiryAt || capturedAt > signal.expiryAt + 120000) return res.status(400).json({ ok: false, reason: 'INVALID_EXPIRY_PRICE_OR_TIMESTAMP' });
  const outcome = calculateOutcome(signal.direction, signal.entryPrice, expiryPrice);
  if (outcome === 'INVALID') return res.status(400).json({ ok: false, reason: 'INVALID_OUTCOME' });
  try { await updateOutcome(id, outcome, expiryPrice, { capturedAt: iso(capturedAt), source: 'USER_SUPPLIED_EXPIRY_PRICE' }); return res.json({ ok: true, signalId: id, outcome }); }
  catch (error) { return res.status(409).json({ ok: false, reason: error.message }); }
});
app.post('/api/signal/invalidate', async (req, res) => {
  const id = String(req.body?.signalId || ''), reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ ok: false, reason: 'INVALID_REASON' });
  try { await updateOutcome(id, 'INVALID', null, { reason }); return res.json({ ok: true, signalId: id, outcome: 'INVALID' }); }
  catch (error) { return res.status(409).json({ ok: false, reason: error.message }); }
});
app.get('/api/backtest', (req, res) => {
  const pair = normalizePair(req.query.pair), expiry = Number(req.query.expiry || req.query.expiryMinutes || 1);
  if (!validPair(pair)) return res.status(400).json({ ok: false, reason: 'UNSUPPORTED_PAIR' });
  const entry = marketCache.get(pair);
  if (!entry) return res.status(503).json({ ok: false, reason: 'NO_CACHED_HISTORICAL_DATA' });
  const result = backtest(pair, entry.candles, expiry);
  if (!result.ok) return res.status(422).json(result);
  return res.json({ ...result, pair, dataFetchedAt: iso(entry.fetchedAt), dataSource: entry.source });
});
app.post('/api/backtest', (req, res) => {
  const pair = normalizePair(req.body?.pair), expiry = Number(req.body?.expiryMinutes || 1);
  if (!validPair(pair)) return res.status(400).json({ ok: false, reason: 'UNSUPPORTED_PAIR' });
  const entry = marketCache.get(pair);
  if (!entry) return res.status(503).json({ ok: false, reason: 'NO_CACHED_HISTORICAL_DATA' });
  const result = backtest(pair, entry.candles, expiry);
  return res.status(result.ok ? 200 : 422).json({ ...result, pair, dataFetchedAt: iso(entry.fetchedAt) });
});
app.post('/api/backtest/all', (req, res) => {
  const pair = normalizePair(req.body?.pair);
  if (!validPair(pair)) return res.status(400).json({ ok: false, reason: 'UNSUPPORTED_PAIR' });
  const entry = marketCache.get(pair);
  if (!entry) return res.status(503).json({ ok: false, reason: 'NO_CACHED_HISTORICAL_DATA' });
  const results = [1, 2, 3].map(expiry => backtest(pair, entry.candles, expiry));
  return res.json({ ok: results.every(x => x.ok), pair, results, summary: { method: 'WALK_FORWARD_CHRONOLOGICAL_HOLDOUT', scoreMeaning: 'EVIDENCE_SCORE_NOT_WIN_PROBABILITY' } });
});

app.use((req, res) => res.status(404).json({ ok: false, version: VERSION, reason: 'API_ENDPOINT_NOT_FOUND', path: req.path }));
app.use((error, req, res, next) => {
  console.error('Unhandled API error:', error.message || error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ ok: false, version: VERSION, reason: 'INTERNAL_SERVER_ERROR' });
});

async function startServer() {
  await initializeDatabase();
  const server = app.listen(PORT, () => {
    console.log(`PO AI PREDICTOR ${VERSION} listening on ${PORT}`);
    console.log(`Twelve Data configured: ${Boolean(API_KEY)}`);
    console.log(`Database: ${dbReady ? 'POSTGRESQL' : 'MEMORY_ONLY'}`);
    console.log(`Pairs: ${PAIRS.length} (${PRIORITY_PAIRS.length} priority + ${BACKGROUND_PAIRS.length} background)`);
  });
  server.on('error', error => console.error('HTTP server error:', error.message));
  scannerTimer = setInterval(() => {
    if (!scanState.running) launchScan(false);
  }, CFG.scanIntervalMs);
  setTimeout(() => { if (!scanState.running) launchScan(false); }, 5000);
}

startServer().catch(error => {
  console.error('Startup failed:', error.message || error);
  process.exit(1);
});

module.exports = { app, analyzeMarket, normalizeCandles, backtest, PAIRS, PRIORITY_PAIRS, BACKGROUND_PAIRS };
