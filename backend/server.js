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

function normalizePair(value){
  const p=String(value||'').trim().toUpperCase().replace(/\s/g,'');
  return PAIRS.includes(p)?p:null;
}

function resetDailyCounter(){
  const today=new Date().toISOString().slice(0,10);
  if(today!==dailyDate){
    dailyDate=today;
    dailyCreditsUsed=0;
    requestTimes=[];
  }
}

function metadata(){
  resetDailyCounter();
  return {
    provider:'Twelve Data LIVE',
    providerRequests,
    dailyCreditsUsed,
    dailyCreditsRemaining:Math.max(0,DAILY_USABLE_LIMIT-dailyCreditsUsed),
    dailyRequestLimit:DAILY_REQUEST_LIMIT,
    dailyUsableLimit:DAILY_USABLE_LIMIT,
    requestsPerMinuteLimit:REQUESTS_PER_MINUTE,
    cachedPairs:pairCache.size,
    priorityPairs:6,
    backgroundPairs:18,
    version:VERSION,
    storage:databaseReady?'POSTGRESQL':'MEMORY_ONLY',
    databaseConfigured:Boolean(DATABASE_URL),
    databaseReady,
    databaseError
  };
}

/* Optional PostgreSQL history. */
async function initializeDatabase(){
  if(!DATABASE_URL)return;

  try{
    const {Pool}=require('pg');

    pgPool=new Pool({
      connectionString:DATABASE_URL,
      ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false},
      max:3,
      idleTimeoutMillis:30000,
      connectionTimeoutMillis:10000
    });

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS po_signal_history (
        id BIGSERIAL PRIMARY KEY,
        signal_key TEXT UNIQUE NOT NULL,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        evidence_score INTEGER,
        entry_time TIMESTAMPTZ,
        expiry_time TIMESTAMPTZ,
        reference_price DOUBLE PRECISION,
        outcome TEXT DEFAULT 'PENDING',
        outcome_price DOUBLE PRECISION,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        details JSONB DEFAULT '{}'::jsonb
      )
    `);

    await pgPool.query(
      'CREATE INDEX IF NOT EXISTS po_signal_history_created_idx ON po_signal_history(created_at DESC)'
    );

    databaseReady=true;
    databaseError=null;
  }catch(e){
    databaseReady=false;
    databaseError=String(e.message||e);
    console.error('PostgreSQL initialization failed:',databaseError);
  }
}

async function saveSignal(record){
  if(signalKeys.has(record.id))return;

  signalKeys.add(record.id);
  signalHistory.unshift(record);

  if(signalHistory.length>HISTORY_LIMIT){
    signalHistory.length=HISTORY_LIMIT;
  }

  if(!databaseReady||!pgPool)return;

  try{
    await pgPool.query(
      `INSERT INTO po_signal_history
      (signal_key,pair,direction,evidence_score,entry_time,expiry_time,reference_price,outcome,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT(signal_key) DO NOTHING`,
      [
        record.id,
        record.pair,
        record.signal,
        record.evidenceScore,
        record.entryTime,
        record.expiryTime,
        record.referencePrice,
        record.outcome,
        JSON.stringify(record)
      ]
    );
  }catch(e){
    databaseError=String(e.message||e);
  }
}

async function getHistory(limit=100){
  const n=clamp(Number(limit)||100,1,500);

  if(databaseReady&&pgPool){
    try{
      const q=await pgPool.query(
        `SELECT signal_key,pair,direction,evidence_score,entry_time,expiry_time,
        reference_price,outcome,outcome_price,created_at,details
        FROM po_signal_history
        ORDER BY created_at DESC LIMIT $1`,
        [n]
      );

      return q.rows.map(r=>({
        ...r.details,
        id:r.signal_key,
        pair:r.pair,
        signal:r.direction,
        evidenceScore:r.evidence_score,
        entryTime:r.entry_time,
        expiryTime:r.expiry_time,
        referencePrice:r.reference_price,
        outcome:r.outcome,
        outcomePrice:r.outcome_price,
        createdAt:r.created_at
      }));
    }catch(e){
      databaseError=String(e.message||e);
    }
  }

  return signalHistory.slice(0,n);
}

/* Twelve Data: serialized requests and conservative account limits. */
function enqueueProviderRequest(task){
  const p=requestQueue.then(task,task);
  requestQueue=p.catch(()=>{});
  return p;
}

async function providerFetch(pair){
  return enqueueProviderRequest(async()=>{
    if(!API_KEY){
      throw new Error('Twelve Data API key is not configured.');
    }

    while(true){
      resetDailyCounter();

      const now=Date.now();
      requestTimes=requestTimes.filter(t=>now-t<60000);

      if(dailyCreditsUsed>=DAILY_USABLE_LIMIT){
        throw new Error('Daily Twelve Data safety limit reached.');
      }

      const minuteWait=requestTimes.length>=REQUESTS_PER_MINUTE
        ?Math.max(250,60000-(now-requestTimes[0])+100)
        :0;

      const spacingWait=Math.max(0,REQUEST_SPACING_MS-(now-lastProviderRequestAt));
      const wait=Math.max(minuteWait,spacingWait);

      if(wait>0){
        await sleep(wait);
        continue;
      }

      break;
    }

    const url=new URL(PROVIDER_URL);
    url.searchParams.set('symbol',pair);
    url.searchParams.set('interval','1min');
    url.searchParams.set('outputsize','500');
    url.searchParams.set('timezone','UTC');
    url.searchParams.set('apikey',API_KEY);

    const sent=Date.now();
    lastProviderRequestAt=sent;
    requestTimes.push(sent);
    providerRequests++;
    dailyCreditsUsed++;

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),PROVIDER_TIMEOUT_MS);

    try{
      const response=await fetch(url,{
        signal:controller.signal,
        headers:{Accept:'application/json'}
      });

      if(!response.ok){
        throw new Error(`Twelve Data HTTP ${response.status}.`);
      }

      const json=await response.json();

      if(json.status==='error'||json.code||!Array.isArray(json.values)){
        throw new Error(json.message||'Provider returned no candle values.');
      }

      const candles=normalizeCandles(json.values);

      if(!candles.length){
        throw new Error('No valid candles returned by Twelve Data.');
      }

      return {
        candles,
        fetchedAt:Date.now(),
        source:'Twelve Data LIVE'
      };
    }catch(e){
      if(e.name==='AbortError'){
        throw new Error('Twelve Data request timed out.');
      }

      throw new Error(e.message||'Twelve Data request failed.');
    }finally{
      clearTimeout(timer);
    }
  });
}

function normalizeCandles(rows){
  const byTime=new Map();

  for(const row of rows){
    const raw=String(row.datetime||row.time||'').trim();
    const zoned=/(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    const time=Date.parse(raw&&!zoned?`${raw.replace(' ','T')}Z`:raw);

    const open=Number(row.open);
    const high=Number(row.high);
    const low=Number(row.low);
    const close=Number(row.close);

    if(!Number.isFinite(time)||![open,high,low,close].every(Number.isFinite)){
      continue;
    }

    if(high<Math.max(open,close,low)||low>Math.min(open,close,high)){
      continue;
    }

    byTime.set(time,{time,open,high,low,close});
  }

  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

async function getPairData(pair,force=false){
  const cached=pairCache.get(pair);

  if(!force&&cached&&Date.now()-cached.fetchedAt<PAIR_CACHE_MS){
    return cached;
  }

  if(inFlight.has(pair)){
    return inFlight.get(pair);
  }

  const p=providerFetch(pair)
    .then(d=>{
      pairCache.set(pair,d);
      return d;
    })
    .finally(()=>inFlight.delete(pair));

  inFlight.set(pair,p);
  return p;
}

function closedCandles(candles,now=Date.now()){
  return candles.filter(c=>c.time+60000<=now);
}

function hasContinuousMinutes(candles){
  if(candles.length<2)return true;

  for(let i=1;i<candles.length;i++){
    if(candles[i].time-candles[i-1].time!==60000){
      return false;
    }
  }

  return true;
}

/* Technical indicators: EMA9/21, RSI14, MACD, ATR14, Bollinger Bands (20,2). */
function ema(values,period){
  const out=Array(values.length).fill(null);

  if(values.length<period)return out;

  let v=avg(values.slice(0,period));
  out[period-1]=v;

  const a=2/(period+1);

  for(let i=period;i<values.length;i++){
    v=values[i]*a+v*(1-a);
    out[i]=v;
  }

  return out;
}

function rsi(values,period=14){
  const out=Array(values.length).fill(null);

  if(values.length<=period)return out;

  let g=0,l=0;

  for(let i=1;i<=period;i++){
    const d=values[i]-values[i-1];
    g+=Math.max(d,0);
    l+=Math.max(-d,0);
  }

  let ag=g/period,al=l/period;

  const calc=()=>al===0?(ag===0?50:100):100-100/(1+ag/al);

  out[period]=calc();

  for(let i=period+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    ag=(ag*(period-1)+Math.max(d,0))/period;
    al=(al*(period-1)+Math.max(-d,0))/period;
    out[i]=calc();
  }

  return out;
}

function macd(values){
  const f=ema(values,12);
  const s=ema(values,26);

  const line=values.map((_,i)=>
    finite(f[i])&&finite(s[i])?f[i]-s[i]:null
  );

  const compact=ema(line.filter(finite),9);
  const sig=Array(values.length).fill(null);

  let j=0;

  for(let i=0;i<line.length;i++){
    if(finite(line[i]))sig[i]=compact[j++];
  }

  return {
    line,
    signal:sig,
    histogram:line.map((v,i)=>
      finite(v)&&finite(sig[i])?v-sig[i]:null
    )
  };
}

function atr(candles,period=14){
  const tr=Array(candles.length).fill(null);

  for(let i=1;i<candles.length;i++){
    const c=candles[i],pc=candles[i-1].close;

    tr[i]=Math.max(
      c.high-c.low,
      Math.abs(c.high-pc),
      Math.abs(c.low-pc)
    );
  }

  const out=Array(candles.length).fill(null);

  if(candles.length<=period)return out;

  let v=avg(tr.slice(1,period+1));
  out[period]=v;

  for(let i=period+1;i<candles.length;i++){
    v=(v*(period-1)+tr[i])/period;
    out[i]=v;
  }

  return out;
}

function bollinger(values,period=20,mult=2){
  const upper=Array(values.length).fill(null);
  const middle=Array(values.length).fill(null);
  const lower=Array(values.length).fill(null);
  const width=Array(values.length).fill(null);

  for(let i=period-1;i<values.length;i++){
    const sample=values.slice(i-period+1,i+1);
    const m=avg(sample);
    const sd=Math.sqrt(avg(sample.map(v=>(v-m)**2)));

    middle[i]=m;
    upper[i]=m+mult*sd;
    lower[i]=m-mult*sd;
    width[i]=m?((upper[i]-lower[i])/m)*100:null;
  }

  return {upper,middle,lower,width};
}

function cross(a0,b0,a1,b1){
  if(![a0,b0,a1,b1].every(finite))return 'UNAVAILABLE';
  if(a0<=b0&&a1>b1)return 'BULLISH_CROSSOVER';
  if(a0>=b0&&a1<b1)return 'BEARISH_CROSSOVER';
  return 'NO_CROSSOVER';
}

function rsiDivergence(candles,rv){
  const pts=[];

  for(let i=Math.max(2,candles.length-42);i<candles.length-2;i++){
    const lo=candles[i].low<=candles[i-1].low&&candles[i].low<=candles[i+1].low;
    const hi=candles[i].high>=candles[i-1].high&&candles[i].high>=candles[i+1].high;

    if(finite(rv[i])&&(lo||hi)){
      pts.push({
        i,
        lo:candles[i].low,
        hi:candles[i].high,
        r:rv[i],
        type:lo?'L':'H'
      });
    }
  }

  const lows=pts.filter(p=>p.type==='L').slice(-2);
  const highs=pts.filter(p=>p.type==='H').slice(-2);

  if(lows.length===2&&lows[1].lo<lows[0].lo&&lows[1].r>lows[0].r){
    return {
      type:'BULLISH_DIVERGENCE',
      direction:'BULLISH',
      description:'Price lower low; RSI higher low.'
    };
  }

  if(highs.length===2&&highs[1].hi>highs[0].hi&&highs[1].r<highs[0].r){
    return {
      type:'BEARISH_DIVERGENCE',
      direction:'BEARISH',
      description:'Price higher high; RSI lower high.'
    };
  }

  return {
    type:'NO_CONFIRMED_DIVERGENCE',
    direction:'NEUTRAL',
    description:'No confirmed RSI divergence.'
  };
}

/* Common candlestick patterns. */
function candlePattern(cs){
  if(cs.length<3){
    return {name:'INSUFFICIENT CANDLES',direction:'NEUTRAL'};
  }

  const c=cs.at(-1),p=cs.at(-2),p2=cs.at(-3);
  const body=Math.abs(c.close-c.open);
  const range=Math.max(c.high-c.low,Number.EPSILON);
  const up=c.high-Math.max(c.open,c.close);
  const dn=Math.min(c.open,c.close)-c.low;
  const ratio=body/range;

  const bull=c.close>c.open;
  const bear=c.close<c.open;
  const pb=p.close<p.open;
  const pu=p.close>p.open;

  const result=(name,direction)=>({name,direction});

  if(ratio<=.08&&dn<range*.15&&up<range*.15)
    return result('DOJI','NEUTRAL');

  if(ratio<=.12&&dn>range*.6&&up<range*.12)
    return result('DRAGONFLY DOJI','POTENTIAL BULLISH');

  if(ratio<=.12&&up>range*.6&&dn<range*.12)
    return result('GRAVESTONE DOJI','POTENTIAL BEARISH');

  if(ratio<=.12&&up>range*.3&&dn>range*.3)
    return result('LONG-LEGGED DOJI','NEUTRAL');

  if(pb&&bull&&c.open<=p.close&&c.close>=p.open)
    return result('BULLISH ENGULFING','BULLISH');

  if(pu&&bear&&c.open>=p.close&&c.close<=p.open)
    return result('BEARISH ENGULFING','BEARISH');

  if(ratio<=.35&&dn>=body*2&&up<=Math.max(body*.7,range*.05))
    return result('HAMMER','POTENTIAL BULLISH');

  if(ratio<=.35&&up>=body*2&&dn<=Math.max(body*.7,range*.05))
    return result('SHOOTING STAR','POTENTIAL BEARISH');

  if(ratio<=.35&&up>=body*2&&dn<=body*.7)
    return result('INVERTED HAMMER','POTENTIAL BULLISH');

  if(ratio<=.35&&dn>=body*2&&up<=body*.7)
    return result('HANGING MAN','POTENTIAL BEARISH');

  if(pb&&bull&&c.open>p.close&&c.close>(p.open+p.close)/2&&c.close<p.open)
    return result('PIERCING LINE','BULLISH');

  if(pu&&bear&&c.open<p.close&&c.close<(p.open+p.close)/2&&c.close>p.open)
    return result('DARK CLOUD COVER','BEARISH');

  if(pb&&bull&&c.open>p.close&&c.close<p.open)
    return result('BULLISH HARAMI','BULLISH');

  if(pu&&bear&&c.open<p.close&&c.close>p.open)
    return result('BEARISH HARAMI','BEARISH');

  if(p2.close<p2.open&&Math.abs(p.close-p.open)<Math.abs(p2.close-p2.open)*.4&&bull&&c.close>(p2.open+p2.close)/2)
    return result('MORNING STAR','BULLISH');

  if(p2.close>p2.open&&Math.abs(p.close-p.open)<Math.abs(p2.close-p2.open)*.4&&bear&&c.close<(p2.open+p2.close)/2)
    return result('EVENING STAR','BEARISH');

  if(Math.abs(c.high-p.high)<=range*.08&&bear&&pu)
    return result('TWEEZER TOP','POTENTIAL BEARISH');

  if(Math.abs(c.low-p.low)<=range*.08&&bull&&pb)
    return result('TWEEZER BOTTOM','POTENTIAL BULLISH');

  if(cs.length>=4){
    const a=cs.at(-3),b=cs.at(-2);

    if(a.close>a.open&&b.close>b.open&&bull&&c.close>b.close&&b.close>a.close&&c.close>b.close)
      return result('THREE WHITE SOLDIERS','BULLISH');

    if(a.close<a.open&&b.close<b.open&&bear&&c.close<b.close&&b.close<a.close&&c.close<b.close)
      return result('THREE BLACK CROWS','BEARISH');
  }

  if(ratio<.25)return result('SPINNING TOP','NEUTRAL');

  if(ratio>.9&&up<range*.05&&dn<range*.05)
    return result(
      bull?'BULLISH MARUBOZU':'BEARISH MARUBOZU',
      bull?'BULLISH':'BEARISH'
    );

  if(c.high<=p.high&&c.low>=p.low)
    return result('INSIDE BAR','NEUTRAL');

  if(c.high>p.high&&c.low<p.low)
    return result('OUTSIDE BAR',bull?'BULLISH':bear?'BEARISH':'NEUTRAL');

  return result(
    bull?'BULLISH CANDLE':bear?'BEARISH CANDLE':'NO CLEAR PATTERN',
    bull?'BULLISH':bear?'BEARISH':'NEUTRAL'
  );
}

function psychology(cs){
  const recent=cs.slice(-8);

  if(recent.length<7){
    return {
      psychology:'INSUFFICIENT PRICE EVIDENCE',
      direction:'NEUTRAL',
      buyerPressure:0,
      sellerPressure:0
    };
  }

  let up=0,down=0;

  for(let i=1;i<recent.length;i++){
    if(recent[i].close>recent[i-1].close)up++;
    if(recent[i].close<recent[i-1].close)down++;
  }

  const c=recent.at(-1);
  const loc=(c.close-c.low)/Math.max(c.high-c.low,1e-12);

  if(up>=5&&loc>=.65){
    return {
      psychology:'BUYERS SHOWING RECENT CONTROL',
      direction:'BULLISH',
      buyerPressure:up,
      sellerPressure:down
    };
  }

  if(down>=5&&loc<=.35){
    return {
      psychology:'SELLERS SHOWING RECENT CONTROL',
      direction:'BEARISH',
      buyerPressure:up,
      sellerPressure:down
    };
  }

  return {
    psychology:'MIXED BUYER/SELLER PRESSURE',
    direction:'NEUTRAL',
    buyerPressure:up,
    sellerPressure:down
  };
}

function trendline(cs){
  const s=cs.slice(-30);

  if(s.length<15){
    return {
      direction:'UNAVAILABLE',
      slopePercent:null,
      description:'Not enough candles for trendline.'
    };
  }

  const xs=s.map((_,i)=>i);
  const ys=s.map(c=>c.close);
  const mx=avg(xs),my=avg(ys);

  let num=0,den=0;

  for(let i=0;i<s.length;i++){
    num+=(xs[i]-mx)*(ys[i]-my);
    den+=(xs[i]-mx)**2;
  }

  const slope=den?num/den:0;
  const sp=my?slope/my*100:0;
  const dir=sp>.002?'BULLISH':sp<-.002?'BEARISH':'SIDEWAYS';
  const proj=my-slope*mx+slope*(s.length-1);

  return {
    direction:dir,
    slopePercent:round(sp,6),
    projectedPrice:round(proj),
    aboveLine:ys.at(-1)>proj,
    belowLine:ys.at(-1)<proj,
    description:`30-candle regression trend: ${dir}.`
  };
}

function levels(cs){
  const prev=cs.slice(-31,-1);

  if(prev.length<15){
    return {
      support:null,
      resistance:null,
      position:'UNAVAILABLE',
      direction:'NEUTRAL'
    };
  }

  const sup=Math.min(...prev.map(c=>c.low));
  const res=Math.max(...prev.map(c=>c.high));
  const c=cs.at(-1);
  const range=Math.max(c.high-c.low,1e-12);

  let position='BETWEEN LEVELS',direction='NEUTRAL';

  if(c.close>res){
    position='CLOSED-CANDLE RESISTANCE BREAKOUT';
    direction='BULLISH';
  }else if(c.close<sup){
    position='CLOSED-CANDLE SUPPORT BREAKDOWN';
    direction='BEARISH';
  }else if(c.low<=sup+range*.15&&c.close>c.open){
    position='POSSIBLE SUPPORT REJECTION';
    direction='BULLISH';
  }else if(c.high>=res-range*.15&&c.close<c.open){
    position='POSSIBLE RESISTANCE REJECTION';
    direction='BEARISH';
  }

  return {
    support:round(sup),
    resistance:round(res),
    position,
    direction,
    distanceToSupportPercent:round((c.close-sup)/c.close*100,5),
    distanceToResistancePercent:round((res-c.close)/c.close*100,5)
  };
}

function breakout(cs){
  if(cs.length<8){
    return {
      status:'UNAVAILABLE',
      direction:'NEUTRAL',
      description:'Insufficient range history.'
    };
  }

  const c=cs.at(-1),p=cs.at(-2);
  const prior=cs.slice(-7,-2);
  const hi=Math.max(...prior.map(x=>x.high));
  const lo=Math.min(...prior.map(x=>x.low));

  if(p.close<=hi&&c.close>hi){
    return {
      status:'BREAKOUT',
      direction:'BULLISH',
      level:round(hi),
      description:'Completed candle closed above prior range.'
    };
  }

  if(p.close>=lo&&c.close<lo){
    return {
      status:'BREAKDOWN',
      direction:'BEARISH',
      level:round(lo),
      description:'Completed candle closed below prior range.'
    };
  }

  if(p.close>hi&&c.low<=hi&&c.close>hi){
    return {
      status:'BULLISH_RETEST',
      direction:'BULLISH',
      level:round(hi),
      description:'Retest held above breakout level.'
    };
  }

  if(p.close<lo&&c.high>=lo&&c.close<lo){
    return {
      status:'BEARISH_RETEST',
      direction:'BEARISH',
      level:round(lo),
      description:'Retest held below breakdown level.'
    };
  }

  if(p.close>hi&&c.close<hi){
    return {
      status:'FALSE_BULLISH_BREAKOUT',
      direction:'BEARISH',
      level:round(hi),
      description:'Price returned inside range after upside break.'
    };
  }

  if(p.close<lo&&c.close>lo){
    return {
      status:'FALSE_BEARISH_BREAKOUT',
      direction:'BULLISH',
      level:round(lo),
      description:'Price returned inside range after downside break.'
    };
  }

  return {
    status:'NO_CONFIRMED_BREAKOUT',
    direction:'NEUTRAL',
    description:'No confirmed breakout/retest.'
  };
}

function aggregate5m(cs,now=Date.now()){
  const map=new Map();

  for(const c of cs){
    const t=Math.floor(c.time/300000)*300000;
    let g=map.get(t);

    if(!g){
      g={
        time:t,
        open:c.open,
        high:c.high,
        low:c.low,
        close:c.close,
        count:1,
        lastTime:c.time
      };
      map.set(t,g);
    }else{
      g.high=Math.max(g.high,c.high);
      g.low=Math.min(g.low,c.low);
      g.close=c.close;
      g.count++;
      g.lastTime=c.time;
    }
  }

  return [...map.values()]
    .filter(g=>g.count===5&&g.lastTime===g.time+240000&&g.time+300000<=now)
    .map(({count,lastTime,...g})=>g)
    .sort((a,b)=>a.time-b.time);
}

function confirm5m(cs){
  const five=aggregate5m(cs);

  if(five.length<MIN_5M_CANDLES){
    return {
      status:'UNAVAILABLE',
      direction:'NEUTRAL',
      candles:five.length,
      required:MIN_5M_CANDLES,
      reason:'Not enough complete, gap-free 5-minute candles aggregated from 1-minute data.'
    };
  }

  const cl=five.map(c=>c.close);
  const f=ema(cl,9);
  const s=ema(cl,21);
  const i=cl.length-1;
  const dir=f[i]>s[i]?'BULLISH':f[i]<s[i]?'BEARISH':'NEUTRAL';

  return {
    status:dir==='NEUTRAL'?'MIXED':'CONFIRMED',
    direction:dir,
    ema9:round(f[i]),
    ema21:round(s[i]),
    candles:five.length,
    lastCandle:iso(five[i].time),
    reason:`5-minute EMA9/EMA21 trend is ${dir}.`
  };
}

function volatility(atrValues,widths,cs){
  const i=atrValues.length-1;
  const a=atrValues[i];
  const close=cs[i]?.close;
  const ap=finite(a)&&close?a/close*100:null;
  const w=widths[i];
  const valid=widths.filter(finite);

  if(!finite(ap)||!finite(w)||valid.length<30){
    return {
      regime:'UNAVAILABLE',
      atr:round(a),
      atrPercent:round(ap,5),
      bollingerWidth:round(w,5)
    };
  }

  const sorted=[...valid].sort((x,y)=>x-y);
  const lo=sorted[Math.floor((sorted.length-1)*.25)];
  const hi=sorted[Math.floor((sorted.length-1)*.75)];
  const regime=w<=lo?'LOW':w>=hi?'HIGH':'NORMAL';

  return {
    regime,
    atr:round(a),
    atrPercent:round(ap,5),
    bollingerWidth:round(w,5),
    lowWidthThreshold:round(lo,5),
    highWidthThreshold:round(hi,5)
  };
}

function emptyMarket(pair='NO MARKET',reason='No usable market data.'){
  return {
    pair,
    timeframe:1,
    signal:'NO TRADE',
    confidence:null,
    callScore:0,
    putScore:0,
    gap:0,
    entryTime:null,
    expiryTime:null,
    currentPrice:null,
    entryPrice:null,
    freshness:'NO DATA',
    dataAgeSeconds:null,
    lastCandle:null,
    indicators:{},
    reasons:[reason],
    source:'Twelve Data LIVE',
    evidenceLabel:'Evidence score, not win probability',
    insufficientData:true,
    tradeAllowed:false
  };
}

function scoreMarket(raw,pair,fetchedAt){
  const now=Date.now();
  const cs=closedCandles(raw,now);
  const last=cs.at(-1);

  if(!last){
    return emptyMarket(pair,'No completed 1-minute candles.');
  }

  const age=Math.max(0,(now-(last.time+60000))/1000);
  const fresh=age<=FRESHNESS_SECONDS?'FRESH':age<=HARD_STALE_SECONDS?'STALE':'HARD STALE';

  const closes=cs.map(c=>c.close);
  const i=cs.length-1;
  const p=i-1;

  const e9=ema(closes,9);
  const e21=ema(closes,21);
  const rv=rsi(closes);
  const mc=macd(closes);
  const av=atr(cs);
  const bb=bollinger(closes);

  const emaCross=cross(e9[p],e21[p],e9[i],e21[i]);
  const macdCross=cross(mc.line[p],mc.signal[p],mc.line[i],mc.signal[i]);

  const div=rsiDivergence(cs,rv);
  const pattern=candlePattern(cs);
  const psy=psychology(cs);
  const sr=levels(cs);
  const tl=trendline(cs);
  const bo=breakout(cs);
  const c5=confirm5m(cs);
  const vol=volatility(av,bb.width,cs);

  let call=0,put=0;
  const reasons=[];

  const add=(d,n,r)=>{
    if(d==='BULLISH')call+=n;
    if(d==='BEARISH')put+=n;
    if(d!=='NEUTRAL'&&n>0)reasons.push(r);
  };

  const patPoints={
    'BULLISH ENGULFING':12,
    'BEARISH ENGULFING':12,
    'MORNING STAR':12,
    'EVENING STAR':12,
    'PIERCING LINE':8,
    'DARK CLOUD COVER':8,
    'HAMMER':6,
    'SHOOTING STAR':6,
    'BULLISH HARAMI':6,
    'BEARISH HARAMI':6,
    'THREE WHITE SOLDIERS':10,
    'THREE BLACK CROWS':10,
    'BULLISH MARUBOZU':7,
    'BEARISH MARUBOZU':7
  };

  add(pattern.direction,patPoints[pattern.name]||0,`Candlestick: ${pattern.name}.`);
  add(psy.direction,8,`Market psychology: ${psy.psychology}.`);
  add(sr.direction,8,`Support/resistance: ${sr.position}.`);
  add(tl.direction,7,`Trendline: ${tl.direction}.`);

  if(emaCross==='BULLISH_CROSSOVER'){
    add('BULLISH',7,'EMA9 crossed above EMA21.');
  }else if(emaCross==='BEARISH_CROSSOVER'){
    add('BEARISH',7,'EMA9 crossed below EMA21.');
  }else if(finite(e9[i])&&finite(e21[i])){
    add(e9[i]>e21[i]?'BULLISH':'BEARISH',3,'EMA9/EMA21 alignment.');
  }

  if(finite(rv[i])&&finite(rv[p])){
    if(rv[p]<30&&rv[i]>=30){
      add('BULLISH',5,'RSI14 recovered above 30.');
    }else if(rv[p]>70&&rv[i]<=70){
      add('BEARISH',5,'RSI14 fell below 70.');
    }else if(rv[i]>50&&rv[i]<70){
      add('BULLISH',2,'RSI14 positive momentum.');
    }else if(rv[i]<50&&rv[i]>30){
      add('BEARISH',2,'RSI14 negative momentum.');
    }
  }

  add(div.direction,8,`RSI divergence: ${div.type}.`);

  if(macdCross==='BULLISH_CROSSOVER'){
    add('BULLISH',6,'MACD bullish crossover.');
  }else if(macdCross==='BEARISH_CROSSOVER'){
    add('BEARISH',6,'MACD bearish crossover.');
  }else if(finite(mc.histogram[i])&&finite(mc.histogram[p])&&mc.histogram[i]>mc.histogram[p]&&mc.histogram[i]>0){
    add('BULLISH',2,'MACD histogram strengthening positive.');
  }else if(finite(mc.histogram[i])&&finite(mc.histogram[p])&&mc.histogram[i]<mc.histogram[p]&&mc.histogram[i]<0){
    add('BEARISH',2,'MACD histogram strengthening negative.');
  }

  add(
    bo.direction,
    bo.status.includes('RETEST')?8:bo.status.includes('FALSE')?0:5,
    `Breakout/retest: ${bo.status}.`
  );

  const dir=call>put?'BULLISH':put>call?'BEARISH':'NEUTRAL';
  const winning=Math.max(call,put);
  const opposing=Math.min(call,put);
  const gap=Math.abs(call-put);
  const guards=[];

  if(cs.length<MIN_CANDLES){
    guards.push(`Fewer than ${MIN_CANDLES} completed 1-minute candles.`);
  }

  if(!hasContinuousMinutes(cs.slice(-60))){
    guards.push('Missing minute candles in the recent data window.');
  }

  if(fresh!=='FRESH'){
    guards.push('Market data is not fresh.');
  }

  if(c5.status==='UNAVAILABLE'){
    guards.push('5-minute confirmation is unavailable.');
  }else if(c5.direction!==dir){
    guards.push('5-minute trend does not confirm the 1-minute direction.');
  }

  if(vol.regime==='UNAVAILABLE'){
    guards.push('Volatility regime is unavailable.');
  }else if(vol.regime==='HIGH'){
    guards.push('High-volatility regime: signal withheld.');
  }

  if(
    ![rv[i],e9[i],e21[i],mc.histogram[i],av[i],bb.width[i]].every(finite)||
    tl.direction==='UNAVAILABLE'||
    sr.position==='UNAVAILABLE'
  ){
    guards.push('One or more required technical measurements are unavailable.');
  }

  if(dir==='NEUTRAL'||gap<MIN_SCORE_GAP){
    guards.push('Directional evidence conflicts or score gap is too small.');
  }

  if(winning<MIN_SIGNAL_SCORE){
    guards.push('Evidence score is below the minimum threshold.');
  }

  if(opposing>=MIN_OPPOSING_SCORE){
    guards.push('Opposing directional evidence is material.');
  }

  if(bo.status.startsWith('FALSE_')){
    guards.push('False-breakout risk detected.');
  }

  const signal=guards.length?'NO TRADE':dir==='BULLISH'?'BUY':'SELL';
  reasons.push(...guards.map(x=>`NO TRADE: ${x}`));

  const entry=(Math.floor(now/60000)+1)*60000;
  const expiry=entry+60000;

  const result={
    pair,
    timeframe:1,
    signal,
    confidence:signal==='NO TRADE'?Math.min(100,winning):Math.min(100,winning),
    callScore:round(call,0),
    putScore:round(put,0),
    gap:round(gap,0),
    entryTime:signal==='NO TRADE'?null:iso(entry),
    expiryTime:signal==='NO TRADE'?null:iso(expiry),
    currentPrice:last.close,
    entryPrice:null,
    entryPriceStatus:'WAITING_FOR_ENTRY_PRICE',
    freshness:fresh,
    dataAgeSeconds:round(age,1),
    lastCandle:iso(last.time),
    fetchedAt:iso(fetchedAt),
    supportResistance:sr,
    trendLine:tl,
    marketPsychology:psy.psychology,
    priceAction:sr.position,
    candlePattern:pattern,
    breakout:bo,
    confirmation5m:c5,
    volatility:vol,
    indicators:{
      ema9:round(e9[i]),
      ema21:round(e21[i]),
      emaCross,
      rsi14:round(rv[i],2),
      rsiDivergence:div,
      macd:{
        line:round(mc.line[i]),
        signal:round(mc.signal[i]),
        histogram:round(mc.histogram[i]),
        crossover:macdCross
      },
      atr14:round(av[i]),
      bollinger:{
        upper:round(bb.upper[i]),
        middle:round(bb.middle[i]),
        lower:round(bb.lower[i]),
        width:round(bb.width[i],5)
      }
    },
    reasons,
    source:'Twelve Data LIVE',
    evidenceLabel:'Evidence score, not win probability',
    tradeAllowed:signal!=='NO TRADE',
    noTrade:signal==='NO TRADE',
    insufficientData:guards.length>0
  };

  // NO TRADE diagnostics are not stored as executable signal records.
  return result;
}

function evaluateFreshness(m,now=Date.now()){
  if(!m)return emptyMarket();

  const t=Date.parse(m.lastCandle||'');

  if(!Number.isFinite(t)){
    return {
      ...m,
      freshness:'NO DATA',
      dataAgeSeconds:null,
      signal:'NO TRADE',
      confidence:null,
      tradeAllowed:false,
      noTrade:true
    };
  }

  const age=Math.max(0,(now-(t+60000))/1000);
  const fresh=age<=FRESHNESS_SECONDS?'FRESH':age<=HARD_STALE_SECONDS?'STALE':'HARD STALE';

  return fresh==='FRESH'
    ?{...m,freshness:fresh,dataAgeSeconds:round(age,1)}
    :{
      ...m,
      freshness:fresh,
      dataAgeSeconds:round(age,1),
      signal:'NO TRADE',
      confidence:null,
      tradeAllowed:false,
      noTrade:true,
      reasons:[...(m.reasons||[]),'NO TRADE: latest completed candle is stale.']
    };
}

function rankCandidates(markets){
  const ix=new Map(PRIORITY_PAIRS.map((p,i)=>[p,i]));

  return markets
    .map(evaluateFreshness)
    .sort((a,b)=>
      Number(b.freshness==='FRESH')-Number(a.freshness==='FRESH')||
      Math.max(b.callScore||0,b.putScore||0)-Math.max(a.callScore||0,a.putScore||0)||
      (ix.get(a.pair)??999)-(ix.get(b.pair)??999)
    )
    .map((m,i)=>({
      rank:i+1,
      pair:m.pair,
      timeframe:1,
      signal:m.signal,
      confidence:m.confidence,
      callScore:m.callScore,
      putScore:m.putScore,
      gap:m.gap,
      freshness:m.freshness,
      dataAgeSeconds:m.dataAgeSeconds,
      entryTime:m.entryTime,
      oneMinuteTrend:(m.callScore||0)>(m.putScore||0)
        ?'BULLISH'
        :(m.putScore||0)>(m.callScore||0)
          ?'BEARISH'
          :'NEUTRAL',
      fiveMinuteConfirmation:m.confirmation5m?.direction||'UNAVAILABLE',
      volatility:m.volatility?.regime||'UNAVAILABLE',
      reason:m.reasons?.[0]||'Evidence review.'
    }));
}

function selectBest(markets){
  const ranked=rankCandidates(markets);
  const best=ranked[0];

  return {
    selected:best
      ?latestMarkets.get(best.pair)||markets.find(m=>m.pair===best.pair)
      :emptyMarket(),
    ranked
  };
}

function getCurrentAnalysis(){
  const all=[...latestMarkets.values()].map(evaluateFreshness);
  const r=selectBest(all);

  return {
    selectedMarket:r.selected||emptyMarket(
      'NO MARKET',
      API_KEY?'Priority scan is required.':'Twelve Data API key is not configured.'
    ),
    rankedCandidates:r.ranked
  };
}

function makeResponse(selectedMarket,rankedCandidates=[],extra={}){
  return {
    ok:true,
    version:VERSION,
    selectedMarket,
    rankedCandidates,
    scanner:{
      running:scannerRunning,
      startedAt:scannerStartedAt,
      lastScanAt,
      totalScanned,
      mode:'FIRST 6 OF 24 PRIORITY PAIRS; BACKGROUND 18 NOT PART OF INITIAL SCAN',
      phase:scanProgress.phase,
      batchSize:6,
      pairs:24,
      priorityPairs:PRIORITY_PAIRS,
      backgroundPairs:BACKGROUND_PAIRS,
      progress:{...scanProgress},
      cooldownRemainingMs:Math.max(
        0,
        SCAN_COOLDOWN_MS-(Date.now()-lastScanStartedAtMs)
      )
    },
    metadata:metadata(),
    source:'Twelve Data LIVE',
    diagnostic:{lastScanError},
    ...extra
  };
}

function refreshCandidates(){
  const a=getCurrentAnalysis();
  cachedResult=makeResponse(a.selectedMarket,a.rankedCandidates);
}

async function processPair(pair){
  try{
    let data=await getPairData(pair,false);
    let m=evaluateFreshness(scoreMarket(data.candles,pair,data.fetchedAt));

    if(m.freshness!=='FRESH'){
      data=await getPairData(pair,true);
      m=evaluateFreshness(scoreMarket(data.candles,pair,data.fetchedAt));
    }

    latestMarkets.set(pair,m);

    return {pair,success:true,market:m};
  }catch(e){
    lastScanError=`${pair}: ${String(e.message||e)}`;
    const failed=emptyMarket(pair,lastScanError);
    latestMarkets.set(pair,failed);

    return {pair,success:false,error:lastScanError};
  }finally{
    refreshCandidates();
  }
}

async function scanPriority(){
  if(scannerRunning||!API_KEY)return false;

  scannerRunning=true;
  scannerStartedAt=iso(Date.now());
  lastScanStartedAtMs=Date.now();
  lastScanError=null;

  scanProgress={
    phase:'PRIORITY',
    completed:0,
    total:6,
    priorityCompleted:0,
    priorityTotal:6,
    backgroundCompleted:0,
    backgroundTotal:18,
    pair:null
  };

  try{
    for(const pair of PRIORITY_PAIRS){
      scanProgress.phase='PRIORITY';
      scanProgress.pair=pair;

      await processPair(pair);

      scanProgress.priorityCompleted++;
      scanProgress.completed++;
    }

    scanProgress.phase='PRIORITY_COMPLETE';
    scanProgress.pair=null;
    lastScanAt=iso(Date.now());
    totalScanned+=scanProgress.completed;

    refreshCandidates();
    return true;
  }finally{
    scannerRunning=false;
    scanProgress.phase='PRIORITY_COMPLETE';
    scanProgress.pair=null;
    refreshCandidates();
  }
}

function startScanIfPossible(){
  if(!API_KEY||scannerRunning)return false;

  const remain=Math.max(
    0,
    SCAN_COOLDOWN_MS-(Date.now()-lastScanStartedAtMs)
  );

  if(lastScanStartedAtMs&&remain>0)return false;

  resetDailyCounter();

  if(DAILY_USABLE_LIMIT-dailyCreditsUsed<6){
    lastScanError='Insufficient daily Twelve Data safety budget for a complete six-pair priority scan.';
    return false;
  }

  void scanPriority().catch(e=>{
    lastScanError=String(e.message||e);
    scannerRunning=false;
    scanProgress.phase='ERROR';
    scanProgress.pair=null;
    refreshCandidates();
  });

  return true;
}

/* Backtest: decision at candle i close, entry at candle i+1 open; evaluate expiry close.
   Chronological 70/30 split; no use of future candles in feature calculation. */
function historicalSignal(cs,i){
  const s=cs.slice(0,i+1);

  if(s.length<MIN_CANDLES)return null;

  const cl=s.map(c=>c.close);
  const e9=ema(cl,9);
  const e21=ema(cl,21);
  const rv=rsi(cl);
  const mc=macd(cl);
  const av=atr(s);
  const bb=bollinger(cl);
  const j=s.length-1;

  const vals=[e9[j],e21[j],rv[j],mc.histogram[j],av[j],bb.width[j]];

  if(!vals.every(finite))return null;

  const sr=levels(s);
  const tl=trendline(s);
  const bo=breakout(s);
  const pat=candlePattern(s);
  const psy=psychology(s);

  const five=aggregate5m(s);

  if(five.length<MIN_5M_CANDLES)return null;

  const fc=five.map(c=>c.close);
  const f=ema(fc,9);
  const sl=ema(fc,21);
  const fd=f.at(-1)>sl.at(-1)
    ?'BULLISH'
    :f.at(-1)<sl.at(-1)
      ?'BEARISH'
      :'NEUTRAL';

  let bull=0,bear=0;

  const add=(d,n)=>{
    if(d==='BULLISH')bull+=n;
    if(d==='BEARISH')bear+=n;
  };

  add(e9[j]>e21[j]?'BULLISH':'BEARISH',3);
  add(rv[j]>50&&rv[j]<70?'BULLISH':rv[j]<50&&rv[j]>30?'BEARISH':'NEUTRAL',2);
  add(mc.histogram[j]>0?'BULLISH':mc.histogram[j]<0?'BEARISH':'NEUTRAL',2);
  add(pat.direction,pat.name.includes('ENGULFING')||pat.name.includes('STAR')?8:4);
  add(psy.direction,4);
  add(sr.direction,4);
  add(tl.direction,3);
  add(bo.direction,bo.status.includes('FALSE')?0:4);

  const d=bull>bear?'BULLISH':bear>bull?'BEARISH':'NEUTRAL';
  const win=Math.max(bull,bear);
  const gap=Math.abs(bull-bear);
  const atrPct=av[j]/s.at(-1).close*100;

  const sorted=bb.width.filter(finite).sort((a,b)=>a-b);
  const high=sorted[Math.floor((sorted.length-1)*.75)];

  if(
    d==='NEUTRAL'||
    win<25||
    gap<7||
    fd!==d||
    bb.width[j]>=high||
    bo.status.startsWith('FALSE')
  ){
    return null;
  }

  return d==='BULLISH'?'BUY':'SELL';
}

function runWalkForward(cs,expiry=1){
  const h=clamp(Number(expiry)||1,1,3);
  const split=Math.floor(cs.length*.7);
  const start=Math.max(MIN_CANDLES,Math.floor(cs.length*.25));

  let devN=0,devW=0,testN=0,testW=0,eligible=0;

  for(let i=start;i+h<cs.length-1;i++){
    const d=historicalSignal(cs,i);

    if(!d)continue;

    eligible++;

    const entry=cs[i+1].open;
    const exit=cs[i+h].close;

    if(!finite(entry)||!finite(exit)||entry===exit)continue;

    const hit=d==='BUY'?exit>entry:exit<entry;

    if(i<split){
      devN++;
      if(hit)devW++;
    }else{
      testN++;
      if(hit)testW++;
    }
  }

  const rate=testN?testW/testN*100:null;
  const devRate=devN?devW/devN*100:null;
  const sufficient=testN>=BACKTEST_MIN_SIGNALS;

  return {
    method:'CHRONOLOGICAL WALK-FORWARD · NEXT-CANDLE OPEN ENTRY',
    lookAheadBiasControl:'Decision uses completed candles through index i; entry is next candle open; exit is expiry candle close.',
    expiryMinutes:h,
    candles:cs.length,
    coveragePercent:cs.length
      ?round(eligible/(cs.length-start-h)*100,2)
      :0,
    development:{
      signals:devN,
      hits:devW,
      hitRate:round(devRate,2)
    },
    holdout:{
      signals:testN,
      hits:testW,
      hitRate:round(rate,2),
      baselinePercent:50,
      sufficientSample:sufficient
    },
    totalSignals:devN+testN,
    conclusion:!sufficient
      ?'INSUFFICIENT HOLDOUT SAMPLE — no performance claim.'
      :rate>50
        ?'Holdout exceeded 50% directional reference in this sample only; not a guarantee.'
        :'Holdout did not exceed the 50% directional reference.',
    limitations:[
      'No broker spread, payout, slippage or execution latency model.',
      'This is a research comparison, not a probability forecast.'
    ],
    warning:'Historical results do not predict or guarantee future outcomes.'
  };
}

/* API routes retained for existing V10.1 frontend compatibility. */
app.get('/',(_req,res)=>res.json({
  ok:true,
  name:'PO AI Predictor API',
  version:VERSION,
  mode:'LIVE FOREX ONLY',
  endpoints:[
    '/api/health',
    '/api/best',
    '/api/analyze',
    '/api/scan',
    '/api/history',
    '/api/backtest'
  ]
}));

app.get('/api/health',(_req,res)=>res.json({
  ok:true,
  version:VERSION,
  provider:'Twelve Data LIVE',
  configured:Boolean(API_KEY),
  mode:'LIVE FOREX ONLY',
  scannerRunning,
  scannerEnabled:Boolean(API_KEY),
  scannerMode:'FIRST 6 OF 24; BACKGROUND 18 NOT IN INITIAL SCAN',
  scannerStartedAt,
  lastScanAt,
  totalScanned,
  priorityPairs:PRIORITY_PAIRS,
  backgroundPairs:BACKGROUND_PAIRS,
  scanProgress:{...scanProgress},
  cooldownRemainingMs:Math.max(
    0,
    SCAN_COOLDOWN_MS-(Date.now()-lastScanStartedAtMs)
  ),
  metadata:metadata()
}));

app.get('/api/best',(_req,res)=>{
  const a=getCurrentAnalysis();
  res.json(makeResponse(a.selectedMarket,a.rankedCandidates));
});

app.get('/api/analyze',async(req,res)=>{
  const rawPair=req.query.pair;
  const pair=rawPair?normalizePair(rawPair):null;

  if(rawPair&&!pair){
    return res.status(400).json({
      ok:false,
      version:VERSION,
      error:'Invalid pair. Select one of the supported 24 LIVE forex pairs.'
    });
  }

  // Explicit user selection is always honored; scanner selection never overrides it.
  if(pair){
    try{
      let data=await getPairData(pair,false);
      let m=evaluateFreshness(scoreMarket(data.candles,pair,data.fetchedAt));

      if(m.freshness!=='FRESH'){
        data=await getPairData(pair,true);
        m=evaluateFreshness(scoreMarket(data.candles,pair,data.fetchedAt));
      }

      latestMarkets.set(pair,m);
      const all=getCurrentAnalysis();

      return res.json(makeResponse(m,all.rankedCandidates,{
        selectedPair:pair,
        analysisMode:'USER SELECTED PAIR',
        note:`Analysis is for selected pair ${pair}; it is not replaced by scanner ranking.`
      }));
    }catch(e){
      return res.status(503).json({
        ok:false,
        version:VERSION,
        selectedPair:pair,
        error:String(e.message||e),
        selectedMarket:emptyMarket(pair,'Selected-pair analysis failed.')
      });
    }
  }

  // AI mode: trigger priority scan if no recent six-pair batch exists.
  const started=startScanIfPossible();
  const a=getCurrentAnalysis();

  return res.json(makeResponse(a.selectedMarket,a.rankedCandidates,{
    analysisMode:'AI PRIORITY SCAN',
    scanStarted:started,
    note:'AI mode scans the first six priority pairs. The 18 background pairs do not delay the initial selection.'
  }));
});

app.post('/api/scan',(_req,res)=>{
  if(!API_KEY){
    return res.status(503).json({
      ok:false,
      version:VERSION,
      error:'Twelve Data API key is not configured.'
    });
  }

  if(scannerRunning){
    return res.status(409).json({
      ok:false,
      version:VERSION,
      error:'Priority scanner is already running.',
      scanner:{
        running:true,
        progress:{...scanProgress}
      }
    });
  }

  const remaining=Math.max(
    0,
    SCAN_COOLDOWN_MS-(Date.now()-lastScanStartedAtMs)
  );

  if(lastScanStartedAtMs&&remaining>0){
    return res.status(429).json({
      ok:false,
      version:VERSION,
      error:'Please wait before starting another priority scan.',
      cooldownRemainingMs:remaining
    });
  }

  const started=startScanIfPossible();

  return res.status(started?202:429).json({
    ok:started,
    version:VERSION,
    message:started
      ?'Six-pair LIVE forex priority scan started.'
      :'Priority scan could not start.',
    scanner:{
      running:scannerRunning,
      progress:{...scanProgress},
      priorityPairs:PRIORITY_PAIRS,
      backgroundPairs:BACKGROUND_PAIRS
    }
  });
});

app.get('/api/history',async(req,res)=>{
  const history=await getHistory(req.query.limit);

  res.json({
    ok:true,
    version:VERSION,
    storage:databaseReady?'POSTGRESQL':'MEMORY_ONLY',
    persistent:databaseReady,
    count:history.length,
    history
  });
});

app.get('/api/backtest',async(req,res)=>{
  const pair=normalizePair(req.query.pair||'EUR/USD');
  const expiry=Number(req.query.expiry||1);

  if(!pair){
    return res.status(400).json({
      ok:false,
      error:'Invalid currency pair.'
    });
  }

  if(![1,2,3].includes(expiry)){
    return res.status(400).json({
      ok:false,
      error:'Expiry must be 1, 2 or 3 minutes.'
    });
  }

  try{
    const d=await getPairData(pair,false);
    const cs=closedCandles(d.candles);
    const result=runWalkForward(cs,expiry);

    return res.json({
      ok:true,
      version:VERSION,
      pair,
      result,
      source:'Twelve Data LIVE historical candles',
      note:'Backtest uses next-candle open entry. Provider history depth and missing-candle gaps limit coverage.'
    });
  }catch(e){
    return res.status(503).json({
      ok:false,
      version:VERSION,
      pair,
      error:String(e.message||e)
    });
  }
});

if(require.main===module){
  initializeDatabase().finally(()=>{
    app.listen(PORT,()=>{
      console.log(`PO AI Predictor ${VERSION} listening on ${PORT}`);
      console.log('Mode: LIVE FOREX ONLY');
      console.log(`Twelve Data configured: ${Boolean(API_KEY)}`);
      console.log(`PostgreSQL configured: ${Boolean(DATABASE_URL)}`);
    });
  });
}

module.exports=app;
