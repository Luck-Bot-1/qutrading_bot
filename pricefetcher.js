// ═══════════════════════════════════════════════════════════════
// PRICE FETCHER v4.0 — QUTRADING BOT
// Source: Twelve Data API (real live data, env var API key)
// Fixes from v3.0 audit:
//   P6  TTL cache — 60s for live data, prevents duplicate fetches
//   P9  Serial request queue — no rate limiter race condition
//   P7  Structured timestamped logging throughout
// Features:
//   Rate-limit safe: serial queue, 1.5s min gap
//   Retry logic: 2 retries with backoff
//   Graceful error recovery on all paths
//   All timeframes: 15s–1day with HTF bias fetch
// ═══════════════════════════════════════════════════════════════

'use strict';

const axios = require('axios');

// ── Environment — no hardcoded keys ───────────────────────────
const API_KEY  = process.env.TWELVE_DATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';
const TIMEOUT  = 15000;
const MAX_RETRY = 2;

// ── Structured logger ──────────────────────────────────────────
const log = {
  info:  (msg, d) => console.log(`[${new Date().toISOString()}] INFO  [fetcher] ${msg}`, d || ''),
  warn:  (msg, d) => console.warn(`[${new Date().toISOString()}] WARN  [fetcher] ${msg}`, d || ''),
  error: (msg, d) => console.error(`[${new Date().toISOString()}] ERROR [fetcher] ${msg}`, d || ''),
};

// ── Symbol map — Pocket Option names → Twelve Data symbols ────
const SYMBOL_MAP = {
  'EUR/USD OTC': 'EUR/USD', 'GBP/USD OTC': 'GBP/USD', 'AUD/USD OTC': 'AUD/USD',
  'AUD/CHF OTC': 'AUD/CHF', 'EUR/GBP OTC': 'EUR/GBP', 'EUR/JPY OTC': 'EUR/JPY',
  'GBP/JPY OTC': 'GBP/JPY', 'NZD/USD OTC': 'NZD/USD', 'USD/JPY OTC': 'USD/JPY',
  'AUD/JPY OTC': 'AUD/JPY', 'GBP/AUD OTC': 'GBP/AUD', 'USD/CHF OTC': 'USD/CHF',
  'AUD/CAD OTC': 'AUD/CAD', 'CAD/JPY OTC': 'CAD/JPY', 'EUR/AUD OTC': 'EUR/AUD',
  'EUR/CHF OTC': 'EUR/CHF', 'EUR/CAD OTC': 'EUR/CAD', 'GBP/CAD OTC': 'GBP/CAD',
  'USD/CAD OTC': 'USD/CAD', 'CAD/CHF OTC': 'CAD/CHF', 'AUD/NZD OTC': 'AUD/NZD',
  'EUR/NZD OTC': 'EUR/NZD', 'CHF/JPY OTC': 'CHF/JPY',
  // Live forex
  'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY',
  'EUR/GBP': 'EUR/GBP', 'GBP/JPY': 'GBP/JPY', 'EUR/JPY': 'EUR/JPY',
  'AUD/USD': 'AUD/USD', 'USD/CHF': 'USD/CHF', 'NZD/USD': 'NZD/USD',
  'USD/CAD': 'USD/CAD', 'AUD/JPY': 'AUD/JPY', 'GBP/AUD': 'GBP/AUD',
  // Crypto
  'BTC/USD OTC': 'BTC/USD', 'ETH/USD OTC': 'ETH/USD', 'XRP/USD OTC': 'XRP/USD',
  'LTC/USD OTC': 'LTC/USD', 'ADA/USD OTC': 'ADA/USD', 'SOL/USD OTC': 'SOL/USD',
  // Commodity
  'XAU/USD OTC': 'XAU/USD', 'XAG/USD OTC': 'XAG/USD',
  'XAU/USD': 'XAU/USD',     'XAG/USD': 'XAG/USD',
};

// ── Timeframe config ───────────────────────────────────────────
const TF_MAP = {
  '15s':  { interval: '15sec', htf: '5min',  outputsize: 200 },
  '30s':  { interval: '30sec', htf: '5min',  outputsize: 200 },
  '1min': { interval: '1min',  htf: '15min', outputsize: 150 },
  '5min': { interval: '5min',  htf: '30min', outputsize: 120 },
  '15min':{ interval: '15min', htf: '1h',    outputsize: 100 },
  '30min':{ interval: '30min', htf: '4h',    outputsize: 80  },
  '1h':   { interval: '1h',    htf: '4h',    outputsize: 80  },
  '4h':   { interval: '4h',    htf: '1day',  outputsize: 60  },
  '1day': { interval: '1day',  htf: '1week', outputsize: 50  },
};

// ── TTL Cache — 60s for live, 300s for historical ─────────────
const cache = new Map();
const CACHE_TTL_LIVE = 60 * 1000;    // 60 seconds
const CACHE_TTL_HIST = 300 * 1000;   // 5 minutes for backtest data

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data, ttl) { cache.set(key, { data, ts: Date.now(), ttl }); }
function cacheClear() { cache.clear(); log.info('Cache cleared'); }

// ── Serial request queue — prevents rate limiter race ─────────
// All HTTP requests go through this queue, one at a time (P9 fix)
let queueRunning = false;
const requestQueue = [];
const MIN_GAP_MS = 1500; // 1.5s between requests = safe for free plan

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    if (!queueRunning) processQueue();
  });
}

async function processQueue() {
  if (queueRunning || requestQueue.length === 0) return;
  queueRunning = true;
  while (requestQueue.length > 0) {
    const { fn, resolve, reject } = requestQueue.shift();
    try {
      const result = await fn();
      resolve(result);
    } catch (e) {
      reject(e);
    }
    if (requestQueue.length > 0) {
      await new Promise(r => setTimeout(r, MIN_GAP_MS));
    }
  }
  queueRunning = false;
}

// ── Core HTTP fetch with retry ─────────────────────────────────
async function httpGet(params) {
  return enqueue(async () => {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const res = await axios.get(`${BASE_URL}/time_series`, { params, timeout: TIMEOUT });
        return res.data;
      } catch (err) {
        if (attempt === MAX_RETRY) throw err;
        const wait = 2000 * (attempt + 1);
        log.warn(`Retry ${attempt + 1}/${MAX_RETRY} after ${wait}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  });
}

// ── Parse OHLCV — skip bad candles, never abort dataset ───────
function parseOHLCV(data) {
  if (!data || data.status === 'error' || !data.values || !Array.isArray(data.values)) {
    if (data?.message) log.warn('API error:', data.message);
    return null;
  }
  const values = data.values.slice().reverse(); // newest first → oldest first
  if (values.length < 15) return null;

  const opens = [], highs = [], lows = [], closes = [], volumes = [], times = [];
  let skipped = 0;

  for (const v of values) {
    const o = parseFloat(v.open), h = parseFloat(v.high);
    const l = parseFloat(v.low),  c = parseFloat(v.close);
    if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c) || h < l) { skipped++; continue; }
    opens.push(o); highs.push(h); lows.push(l); closes.push(c);
    volumes.push(parseFloat(v.volume || 0) || 0);
    times.push(v.datetime);
  }

  if (skipped > 0) log.warn(`Skipped ${skipped} bad candles`);
  if (closes.length < 15) return null;
  return { opens, highs, lows, closes, volumes, times };
}

// ── Fetch live price data (LTF + HTF) ─────────────────────────
async function fetchPriceData(pairSymbol, timeframe = '15min') {
  if (!API_KEY) { log.error('TWELVE_DATA_API_KEY not set in environment'); return null; }

  const symbol   = SYMBOL_MAP[pairSymbol] || pairSymbol.replace(' OTC', '');
  const tfConfig = TF_MAP[timeframe] || TF_MAP['15min'];
  const cacheKey = `live_${symbol}_${timeframe}`;

  // Check TTL cache first
  const cached = cacheGet(cacheKey);
  if (cached) { log.info(`Cache hit: ${pairSymbol} ${timeframe}`); return cached; }

  log.info(`Fetching ${pairSymbol} (${symbol}) on ${timeframe}`);

  // 15s/30s fallback to 1min if Pro plan not available
  let ltf = null;
  let usedFallback = false;

  try {
    const ltfRaw = await httpGet({ symbol, interval: tfConfig.interval, outputsize: tfConfig.outputsize, apikey: API_KEY });
    ltf = parseOHLCV(ltfRaw);
  } catch (e) {
    log.error(`LTF fetch failed for ${symbol}:`, e.message);
  }

  if (!ltf && (timeframe === '15s' || timeframe === '30s')) {
    log.warn(`${timeframe} unavailable, falling back to 1min`);
    try {
      const fb = await httpGet({ symbol, interval: '1min', outputsize: 150, apikey: API_KEY });
      ltf = parseOHLCV(fb);
      usedFallback = true;
    } catch (e) {
      log.error(`Fallback fetch failed:`, e.message);
    }
  }

  if (!ltf) return null;

  // HTF for bias
  let htf = null;
  const htfInterval = usedFallback ? '15min' : tfConfig.htf;
  try {
    const htfRaw = await httpGet({ symbol, interval: htfInterval, outputsize: 60, apikey: API_KEY });
    htf = parseOHLCV(htfRaw);
  } catch (e) {
    log.warn(`HTF fetch failed for ${symbol}:`, e.message);
  }

  const result = { ltf, htf, symbol, timeframe, usedFallback };
  cacheSet(cacheKey, result, CACHE_TTL_LIVE);
  log.info(`Fetched ${pairSymbol}: ${ltf.closes.length} bars LTF, ${htf?.closes?.length || 0} bars HTF`);
  return result;
}

// ── Fetch historical data for backtesting ─────────────────────
async function fetchHistoricalData(pairSymbol, timeframe = '15min', bars = 300) {
  if (!API_KEY) { log.error('TWELVE_DATA_API_KEY not set'); return null; }

  const symbol   = SYMBOL_MAP[pairSymbol] || pairSymbol.replace(' OTC', '');
  const tfConfig = TF_MAP[timeframe] || TF_MAP['15min'];
  const cacheKey = `hist_${symbol}_${timeframe}_${bars}`;

  const cached = cacheGet(cacheKey);
  if (cached) { log.info(`Cache hit (hist): ${pairSymbol} ${timeframe}`); return cached; }

  log.info(`Fetching historical ${pairSymbol} ${timeframe} (${bars} bars)`);

  try {
    const raw  = await httpGet({ symbol, interval: tfConfig.interval, outputsize: Math.min(bars, 500), apikey: API_KEY });
    const data = parseOHLCV(raw);
    if (data) cacheSet(cacheKey, data, CACHE_TTL_HIST);
    return data;
  } catch (e) {
    log.error(`Historical fetch error for ${pairSymbol}:`, e.message);
    return null;
  }
}

module.exports = { fetchPriceData, fetchHistoricalData, cacheClear, TF_MAP, SYMBOL_MAP };
