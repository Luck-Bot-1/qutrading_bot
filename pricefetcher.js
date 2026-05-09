// ═══════════════════════════════════════════════════════════════
// PRICE FETCHER v5.0 — QUTRADING BOT
// Critical fix: Twelve Data free plan = 8 calls/min
// Solution: Dual-source (Twelve Data + Binance fallback)
//           Smarter caching, better error messages to Telegram
//           Rate limit detection with clear user messaging
// ═══════════════════════════════════════════════════════════════

'use strict';

const axios = require('axios');

const API_KEY   = process.env.TWELVE_DATA_API_KEY;
const BASE_URL  = 'https://api.twelvedata.com';
const TIMEOUT   = 12000;
const MAX_RETRY = 1; // reduced — fail fast, show error, don't queue-block

const log = {
  info:  (msg, d) => console.log(`[${new Date().toISOString()}] INFO  [fetcher] ${msg}`, d || ''),
  warn:  (msg, d) => console.warn(`[${new Date().toISOString()}] WARN  [fetcher] ${msg}`, d || ''),
  error: (msg, d) => console.error(`[${new Date().toISOString()}] ERROR [fetcher] ${msg}`, d || ''),
};

// ── Symbol maps ────────────────────────────────────────────────
const SYMBOL_MAP = {
  'EUR/USD OTC': 'EUR/USD', 'GBP/USD OTC': 'GBP/USD', 'AUD/USD OTC': 'AUD/USD',
  'AUD/CHF OTC': 'AUD/CHF', 'EUR/GBP OTC': 'EUR/GBP', 'EUR/JPY OTC': 'EUR/JPY',
  'GBP/JPY OTC': 'GBP/JPY', 'NZD/USD OTC': 'NZD/USD', 'USD/JPY OTC': 'USD/JPY',
  'AUD/JPY OTC': 'AUD/JPY', 'GBP/AUD OTC': 'GBP/AUD', 'USD/CHF OTC': 'USD/CHF',
  'AUD/CAD OTC': 'AUD/CAD', 'CAD/JPY OTC': 'CAD/JPY', 'EUR/AUD OTC': 'EUR/AUD',
  'EUR/CHF OTC': 'EUR/CHF', 'EUR/CAD OTC': 'EUR/CAD', 'GBP/CAD OTC': 'GBP/CAD',
  'USD/CAD OTC': 'USD/CAD', 'CAD/CHF OTC': 'CAD/CHF', 'AUD/NZD OTC': 'AUD/NZD',
  'EUR/NZD OTC': 'EUR/NZD', 'CHF/JPY OTC': 'CHF/JPY',
  'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY',
  'EUR/GBP': 'EUR/GBP', 'GBP/JPY': 'GBP/JPY', 'EUR/JPY': 'EUR/JPY',
  'AUD/USD': 'AUD/USD', 'USD/CHF': 'USD/CHF', 'NZD/USD': 'NZD/USD',
  'USD/CAD': 'USD/CAD', 'AUD/JPY': 'AUD/JPY', 'GBP/AUD': 'GBP/AUD',
  'BTC/USD OTC': 'BTC/USD', 'ETH/USD OTC': 'ETH/USD', 'XRP/USD OTC': 'XRP/USD',
  'LTC/USD OTC': 'LTC/USD', 'ADA/USD OTC': 'ADA/USD', 'SOL/USD OTC': 'SOL/USD',
  'XAU/USD OTC': 'XAU/USD', 'XAG/USD OTC': 'XAG/USD',
  'XAU/USD': 'XAU/USD', 'XAG/USD': 'XAG/USD',
};

// Binance symbol map for crypto fallback (free, no API key)
const BINANCE_MAP = {
  'BTC/USD': 'BTCUSDT', 'ETH/USD': 'ETHUSDT', 'XRP/USD': 'XRPUSDT',
  'LTC/USD': 'LTCUSDT', 'ADA/USD': 'ADAUSDT', 'SOL/USD': 'SOLUSDT',
};

// Binance interval map
const BINANCE_TF = {
  '15s': '1m', '30s': '1m', '1min': '1m', '5min': '5m',
  '15min': '15m', '30min': '30m', '1h': '1h', '4h': '4h', '1day': '1d',
};

const TF_MAP = {
  '15s':  { interval: '15sec', htf: '5min',  outputsize: 100 },
  '30s':  { interval: '30sec', htf: '5min',  outputsize: 100 },
  '1min': { interval: '1min',  htf: '15min', outputsize: 100 },
  '5min': { interval: '5min',  htf: '30min', outputsize: 100 },
  '15min':{ interval: '15min', htf: '1h',    outputsize: 80  },
  '30min':{ interval: '30min', htf: '4h',    outputsize: 60  },
  '1h':   { interval: '1h',    htf: '4h',    outputsize: 60  },
  '4h':   { interval: '4h',    htf: '1day',  outputsize: 50  },
  '1day': { interval: '1day',  htf: '1week', outputsize: 50  },
};

// ── TTL Cache ──────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_LIVE = 90 * 1000;   // 90s — reduced API calls
const CACHE_TTL_HIST = 300 * 1000;  // 5 min for backtest

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data, ttl) { cache.set(key, { data, ts: Date.now(), ttl }); }
function cacheClear() { cache.clear(); log.info('Cache cleared'); }

// ── Serial queue — one request at a time, safe rate limiting ──
let queueRunning = false;
const requestQueue = [];
const MIN_GAP_MS = 8000; // 8s gap = max 7 calls/min — safe under 8/min limit

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
    try { resolve(await fn()); } catch (e) { reject(e); }
    if (requestQueue.length > 0) {
      await new Promise(r => setTimeout(r, MIN_GAP_MS));
    }
  }
  queueRunning = false;
}

// ── Track rate limit state ─────────────────────────────────────
let rateLimitedUntil = 0;
function isRateLimited() { return Date.now() < rateLimitedUntil; }
function setRateLimit(ms = 60000) {
  rateLimitedUntil = Date.now() + ms;
  log.warn(`Rate limited — pausing API calls for ${ms/1000}s`);
}

// ── Twelve Data fetch ──────────────────────────────────────────
async function fetchTwelveData(params) {
  if (isRateLimited()) throw new Error('RATE_LIMITED');
  return enqueue(async () => {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const res = await axios.get(`${BASE_URL}/time_series`, { params, timeout: TIMEOUT });
        const data = res.data;
        // Detect rate limit response
        if (data?.code === 429 || (data?.message && data.message.toLowerCase().includes('limit'))) {
          setRateLimit(65000);
          throw new Error('RATE_LIMITED: ' + (data.message || 'API limit reached'));
        }
        if (data?.status === 'error') {
          throw new Error('API_ERROR: ' + (data.message || 'Unknown API error'));
        }
        return data;
      } catch (err) {
        if (attempt === MAX_RETRY || err.message.startsWith('RATE_LIMITED') || err.message.startsWith('API_ERROR')) throw err;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  });
}

// ── Binance fetch (free, no key, for crypto only) ──────────────
async function fetchBinance(symbol, tf, limit = 100) {
  const binSym = BINANCE_MAP[symbol];
  if (!binSym) return null;
  const interval = BINANCE_TF[tf] || '15m';
  try {
    const res = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: binSym, interval, limit },
      timeout: TIMEOUT
    });
    if (!Array.isArray(res.data) || res.data.length < 15) return null;
    const opens = [], highs = [], lows = [], closes = [], volumes = [], times = [];
    for (const k of res.data) {
      opens.push(parseFloat(k[1])); highs.push(parseFloat(k[2]));
      lows.push(parseFloat(k[3]));  closes.push(parseFloat(k[4]));
      volumes.push(parseFloat(k[5])); times.push(new Date(k[0]).toISOString());
    }
    log.info(`Binance fallback OK: ${binSym} ${interval} (${closes.length} bars)`);
    return { opens, highs, lows, closes, volumes, times };
  } catch (e) {
    log.warn(`Binance fetch failed: ${e.message}`);
    return null;
  }
}

// ── Parse Twelve Data OHLCV ────────────────────────────────────
function parseOHLCV(data) {
  if (!data || data.status === 'error' || !data.values || !Array.isArray(data.values)) {
    if (data?.message) log.warn('API returned error:', data.message);
    return null;
  }
  const values = data.values.slice().reverse();
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

// ── Main fetch — LTF + HTF with smart fallback ─────────────────
async function fetchPriceData(pairSymbol, timeframe = '15min') {
  if (!API_KEY) {
    log.error('TWELVE_DATA_API_KEY not set');
    return { error: 'NO_API_KEY', message: 'Twelve Data API key not configured. Add TWELVE_DATA_API_KEY to Render environment variables.' };
  }

  const symbol   = SYMBOL_MAP[pairSymbol] || pairSymbol.replace(' OTC', '');
  const tfConfig = TF_MAP[timeframe] || TF_MAP['15min'];
  const cacheKey = `live_${symbol}_${timeframe}`;

  const cached = cacheGet(cacheKey);
  if (cached) { log.info(`Cache hit: ${pairSymbol} ${timeframe}`); return cached; }

  // Rate limit check — inform user clearly
  if (isRateLimited()) {
    const waitSec = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    return { error: 'RATE_LIMITED', message: `API rate limit active. Wait ${waitSec} more seconds then try again.` };
  }

  log.info(`Fetching ${pairSymbol} (${symbol}) on ${timeframe}`);

  let ltf = null;
  let usedFallback = false;
  let errorMsg = null;

  // Try Twelve Data LTF
  try {
    const ltfRaw = await fetchTwelveData({
      symbol, interval: tfConfig.interval,
      outputsize: tfConfig.outputsize, apikey: API_KEY
    });
    ltf = parseOHLCV(ltfRaw);
    if (!ltf) errorMsg = ltfRaw?.message || 'No valid data returned';
  } catch (e) {
    errorMsg = e.message;
    log.error(`LTF fetch failed for ${symbol}:`, e.message);
  }

  // Fallback 1: 15s/30s → 1min
  if (!ltf && (timeframe === '15s' || timeframe === '30s')) {
    log.warn(`${timeframe} falling back to 1min`);
    try {
      const fb = await fetchTwelveData({ symbol, interval: '1min', outputsize: 100, apikey: API_KEY });
      ltf = parseOHLCV(fb);
      usedFallback = true;
    } catch (e) { log.error('1min fallback failed:', e.message); }
  }

  // Fallback 2: Binance for crypto pairs (free, no key needed)
  if (!ltf && BINANCE_MAP[symbol]) {
    log.warn(`Trying Binance fallback for ${symbol}`);
    ltf = await fetchBinance(symbol, timeframe, 100);
    if (ltf) usedFallback = true;
  }

  if (!ltf) {
    // Return structured error for better Telegram message
    const isRateErr = errorMsg && (errorMsg.includes('RATE_LIMITED') || errorMsg.includes('limit'));
    return {
      error: isRateErr ? 'RATE_LIMITED' : 'NO_DATA',
      message: isRateErr
        ? 'Twelve Data API rate limit hit. Wait 60-70 seconds before next scan.'
        : `No data for ${pairSymbol}. Pair may not be on Twelve Data free plan.`
    };
  }

  // HTF fetch — skip if rate limited to save quota
  let htf = null;
  if (!isRateLimited()) {
    const htfInterval = usedFallback ? '15min' : tfConfig.htf;
    try {
      const htfRaw = await fetchTwelveData({ symbol, interval: htfInterval, outputsize: 50, apikey: API_KEY });
      htf = parseOHLCV(htfRaw);
    } catch (e) {
      log.warn(`HTF fetch failed, continuing without HTF bias:`, e.message);
    }
  }

  const result = { ltf, htf, symbol, timeframe, usedFallback };
  cacheSet(cacheKey, result, CACHE_TTL_LIVE);
  log.info(`OK ${pairSymbol}: ${ltf.closes.length} LTF bars, ${htf?.closes?.length || 0} HTF bars`);
  return result;
}

// ── Historical data for backtesting ───────────────────────────
async function fetchHistoricalData(pairSymbol, timeframe = '15min', bars = 200) {
  if (!API_KEY) return null;
  if (isRateLimited()) {
    log.warn('Rate limited — cannot fetch historical data now');
    return null;
  }
  const symbol   = SYMBOL_MAP[pairSymbol] || pairSymbol.replace(' OTC', '');
  const tfConfig = TF_MAP[timeframe] || TF_MAP['15min'];
  const cacheKey = `hist_${symbol}_${timeframe}_${bars}`;
  const cached = cacheGet(cacheKey);
  if (cached) { log.info(`Cache hit (hist): ${pairSymbol}`); return cached; }
  log.info(`Fetching historical ${pairSymbol} ${timeframe}`);
  try {
    const raw  = await fetchTwelveData({ symbol, interval: tfConfig.interval, outputsize: Math.min(bars, 500), apikey: API_KEY });
    const data = parseOHLCV(raw);
    if (data) cacheSet(cacheKey, data, CACHE_TTL_HIST);
    return data;
  } catch (e) {
    log.error(`Historical fetch error:`, e.message);
    return null;
  }
}

// ── Rate limit status for Telegram ────────────────────────────
function getRateLimitStatus() {
  if (!isRateLimited()) return null;
  return Math.ceil((rateLimitedUntil - Date.now()) / 1000);
}

module.exports = { fetchPriceData, fetchHistoricalData, cacheClear, getRateLimitStatus, TF_MAP, SYMBOL_MAP };

