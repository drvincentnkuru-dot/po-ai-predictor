'use strict';

const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const VERSION = 'V10.2.0';
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PROVIDER_URL = 'https://api.twelvedata.com/time_series';
const NEWS_CONFIGURED = Boolean(process.env.NEWS_API_KEY);
const FUNDAMENTAL_CONFIGURED = Boolean(process.env.FUNDAMENTAL_API_KEY);

// Exactly the same 24 pairs exposed by index.html and script.js.
const PRIORITY_PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD'];
const BACKGROUND_PAIRS = ['NZD/USD','EUR/GBP','EUR/JPY','GBP/JPY','EUR/CHF','EUR/AUD','EUR/CAD','GBP/CHF','GBP/AUD','GBP/CAD','AUD/JPY','AUD/CAD','AUD/NZD','CAD/JPY','CHF/JPY','NZD/JPY','NZD/CAD','EUR/NZD'];
const PAIRS = [...PRIORITY_PAIRS, ...BACKGROUND_PAIRS];

const DAILY_REQUEST_LIMIT = 768;
const DAILY_RESERVE = 32;
const DAILY_USABLE_LIMIT = DAILY_REQUEST_LIMIT - DAILY_RESERVE;
const REQUESTS_PER_MINUTE = 6;
const REQUEST_SPACING_MS = 10000;
const PROVIDER_TIMEOUT_MS = 12000;
const PAIR_CACHE_MS = 90000;
const FRESHNESS_SECONDS = 150;
const HARD_STALE_SECONDS = 300;
const SCAN_COOLDOWN_MS = 60000;
const MIN_CANDLES = 60;
const MIN_5M_CANDLES = 30;
const MIN_SIGNAL_SCORE = 55;
const MIN_SCORE_GAP = 12;
const MIN_OPPOSING_SCORE = 25;
const BACKTEST_MIN_SIGNALS = 30;
const HISTORY_LIMIT = 5000;

const pairCache = new Map();
const inFlight = new Map();
const latestMarkets = new Map();
const signalHistory = [];
const signalKeys = new Set();
let pgPool = null;
let databaseReady = false;
let databaseError = null;
let providerRequests = 0;
let dailyCreditsUsed = 0;
let dailyDate = new Date().toISOString().slice(0, 10);
let requestTimes = [];
let lastProviderRequestAt = 0;
let requestQueue = Promise.resolve();
let scannerRunning = false;
let scannerStartedAt = null;
let lastScanAt = null;
let lastScanStartedAtMs = 0;
let totalScanned = 0;
let lastScanError = null;
let cachedResult = null;
let scanProgress = { phase:'IDLE', completed:0, total:6, priorityCompleted:0, priorityTotal:6, backgroundCompleted:0, backgroundTotal:18, pair:null };

const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const avg = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;
const round = (v,d=6) => finite(v) ? Number(Number(v).toFixed(d)) : null;
const iso = v => Number.isFinite(v) ? new Date(v).toISOString() : null;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
function normalizePair(value){ const p=String(value||'').trim().toUpperCase().replace(/\s/g,''); return PAIRS.includes(p)?p:null; }
function resetDailyCounter(){ const today=new Date().toISOString().slice(0,10); if(today!==dailyDate){dailyDate=today;dailyCreditsUsed=0;requestTimes=[];} }
function metadata(){ resetDailyCounter(); return {provider:'Twelve Data LIVE',providerRequests,dailyCreditsUsed,dailyCreditsRemaining:Math.max(0,DAILY_USABLE_LIMIT-dailyCreditsUsed),dailyRequestLimit:DAILY_REQUEST_LIMIT,dailyUsableLimit:DAILY_USABLE_LIMIT,requestsPerMinuteLimit:REQUESTS_PER_MINUTE,cachedPairs:pairCache.size,priorityPairs:6,backgroundPairs:18,version:VERSION,storage:databaseReady?'POSTGRESQL':'MEMORY_ONLY',databaseConfigured:Boolean(DATABASE_URL),databaseReady,databaseError,newsConfigured:NEWS_CONFIGURED,fundamentalConfigured:FUNDAMENTAL_CONFIGURED}; }

/* Optional PostgreSQL history. */
async function initializeDatabase(){
  if(!DATABASE_URL)return;
  try{
    const {Pool}=require('pg');
    pgPool=new Pool({connectionString:DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false},max:3,idleTimeoutMillis:30000,connectionTimeoutMillis:10000});
    await pgPool.query(`CREATE TABLE IF NOT EXISTS po_signal_history (id BIGSERIAL PRIMARY KEY, signal_key TEXT UNIQUE NOT NULL, pair TEXT NOT NULL, direction TEXT NOT NULL, evidence_score INTEGER, entry_time TIMESTAMPTZ, expiry_time TIMESTAMPTZ, reference_price DOUBLE PRECISION, outcome TEXT DEFAULT 'PENDING', outcome_price DOUBLE PRECISION, created_at TIMESTAMPTZ DEFAULT NOW(), details JSONB DEFAULT '{}'::jsonb)`);
    await pgPool.query('CREATE INDEX IF NOT EXISTS po_signal_history_created_idx ON po_signal_history(created_at DESC)');
    databaseReady=true;
    databaseError=null;
  }catch(error){
    databaseReady=false;
    databaseError=error.message;
    console.error('Database initialization failed:',error.message);
  }
}

async function saveSignal(signal){
  if(!signal || !['BUY','SELL'].includes(signal.direction))return;
  const key=signal.signalKey || `${signal.pair}-${signal.direction}-${signal.entryTime}`;
  if(signalKeys.has(key))return;
  signalKeys.add(key);
  signalHistory.unshift({...signal,signalKey:key,createdAt:new Date().toISOString(),outcome:'PENDING'});
  if(signalHistory.length>HISTORY_LIMIT)signalHistory.length=HISTORY_LIMIT;
  if(databaseReady && pgPool){
    try{
      await pgPool.query(
        `INSERT INTO po_signal_history (signal_key,pair,direction,evidence_score,entry_time,expiry_time,reference_price,details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (signal_key) DO NOTHING`,
        [key,signal.pair,signal.direction,signal.evidenceScore,signal.entryTime,signal.expiryTime,signal.entryPrice,JSON.stringify(signal)]
      );
    }catch(error){console.error('Signal save failed:',error.message);}
  }
}

async function getHistory(limit=100){
  const safeLimit=clamp(Number(limit)||100,1,500);
  if(databaseReady && pgPool){
    try{
      const result=await pgPool.query(
        'SELECT * FROM po_signal_history ORDER BY created_at DESC LIMIT $1',
        [safeLimit]
      );
      return result.rows;
    }catch(error){console.error('History read failed:',error.message);}
  }
  return signalHistory.slice(0,safeLimit);
}

function providerRequest(url){
  requestQueue=requestQueue.then(async()=>{
    resetDailyCounter();
    const now=Date.now();
    requestTimes=requestTimes.filter(t=>now-t<60000);
    if(dailyCreditsUsed>=DAILY_USABLE_LIMIT)throw new Error('DAILY_PROVIDER_LIMIT_REACHED');
    if(requestTimes.length>=REQUESTS_PER_MINUTE){
      const wait=60000-(now-requestTimes[0])+100;
      await sleep(Math.max(0,wait));
    }
    const spacing=Date.now()-lastProviderRequestAt;
    if(spacing<REQUEST_SPACING_MS)await sleep(REQUEST_SPACING_MS-spacing);
    lastProviderRequestAt=Date.now();
    requestTimes.push(lastProviderRequestAt);
    dailyCreditsUsed++;
    providerRequests++;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),PROVIDER_TIMEOUT_MS);
    try{
      const response=await fetch(url,{signal:controller.signal});
      const data=await response.json();
      if(!response.ok || data.status==='error' || data.code){
        throw new Error(data.message || `PROVIDER_HTTP_${response.status}`);
      }
      return data;
    }finally{clearTimeout(timeout);}
  });
  return requestQueue;
}

function buildProviderUrl(pair,interval,outputsize=500){
  const params=new URLSearchParams({
    symbol:pair,
    interval,
    outputsize:String(outputsize),
    timezone:'UTC',
    apikey:API_KEY
  });
  return `${PROVIDER_URL}?${params.toString()}`;
}

function normalizeCandles(values){
  if(!Array.isArray(values))return [];
  return values.map(c=>{
    const time=Date.parse(c.datetime || c.time || '');
    const open=Number(c.open),high=Number(c.high),low=Number(c.low),close=Number(c.close);
    const volume=finite(c.volume)?Number(c.volume):null;
    if(!Number.isFinite(time)||![open,high,low,close].every(Number.isFinite))return null;
    if(open<=0||high<=0||low<=0||close<=0||high<low)return null;
    return {time,datetime:new Date(time).toISOString(),open,high,low,close,volume};
  }).filter(Boolean).sort((a,b)=>a.time-b.time);
}

function closedCandles(candles,intervalMinutes=1){
  const cutoff=Date.now()-intervalMinutes*60000;
  return candles.filter(c=>c.time+intervalMinutes*60000<=cutoff);
}

async function fetchCandles(pair,interval='1min',outputsize=500){
  if(!API_KEY)throw new Error('TWELVE_DATA_API_KEY_MISSING');
  const key=`${pair}:${interval}`;
  const cached=pairCache.get(key);
  if(cached && Date.now()-cached.fetchedAt<PAIR_CACHE_MS)return cached;
  if(inFlight.has(key))return inFlight.get(key);
  const task=(async()=>{
    const raw=await providerRequest(buildProviderUrl(pair,interval,outputsize));
    const candles=normalizeCandles(raw.values);
    if(!candles.length)throw new Error(`NO_VALID_CANDLES_${pair}_${interval}`);
    const result={pair,interval,candles,fetchedAt:Date.now(),providerTime:raw.meta?.last_refreshed||null};
    pairCache.set(key,result);
    return result;
  })();
  inFlight.set(key,task);
  try{return await task;}finally{inFlight.delete(key);}
}

function getDataAgeSeconds(candles){
  if(!candles.length)return Infinity;
  return Math.max(0,(Date.now()-(candles[candles.length-1].time+60000))/1000);
}

function aggregateCandles(candles,minutes=5){
  const groups=new Map();
  for(const c of candles){
    const bucket=Math.floor(c.time/(minutes*60000))*minutes*60000;
    if(!groups.has(bucket))groups.set(bucket,[]);
    groups.get(bucket).push(c);
  }
  const result=[];
  for(const [time,items] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){
    if(items.length!==minutes)continue;
    result.push({
      time,datetime:new Date(time).toISOString(),
      open:items[0].open,
      high:Math.max(...items.map(x=>x.high)),
      low:Math.min(...items.map(x=>x.low)),
      close:items[items.length-1].close,
      volume:items.every(x=>finite(x.volume))?items.reduce((s,x)=>s+x.volume,0):null
    });
  }
  return result;
}
