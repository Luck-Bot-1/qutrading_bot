// ═══════════════════════════════════════════════════════════════
// QUTRADING BOT v9.0 — OMNI BULLS EYE
// Platform: Render.com | Analyzer: v7.0 | Fetcher: v4.0
// Standard: Professional Quantitative Developer
//
// Fixes from v8.1 audit:
//   P7  Structured timestamped logging throughout
//   P10 Version strings corrected to v9.0 / Analyzer v7.0
//       (previously stale v8.1 / Analyzer v5.1)
// Features:
//   14-indicator voting engine (RSI, MACD, Stoch, BB,
//     SuperTrend, CCI, EMA, ADX, S/R, HTF, Volume,
//     Patterns, Divergence, Momentum)
//   Professional backtest: Sharpe, PF, drawdown, expectancy
//   Per-pair + per-TF accuracy tracker
//   Circuit breaker, news filter, session quality
//   Self-ping keep-alive for Render free tier
//   All timeframes: 15s → 1day
//   No Pocket Option API key required
// ═══════════════════════════════════════════════════════════════

'use strict';

const TelegramBot = require('node-telegram-bot-api');
const express     = require('express');
const axios       = require('axios');
const { fetchPriceData, fetchHistoricalData, cacheClear, getRateLimitStatus } = require('./pricefetcher');
const { analyzeSignal, backtest }                         = require('./analyzer');

// ── Environment — no hardcoded credentials ────────────────────
const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const PORT     = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || '';

// ── Structured logger ──────────────────────────────────────────
const log = {
  info:  (msg, d) => console.log(`[${new Date().toISOString()}] INFO  [bot] ${msg}`, d || ''),
  warn:  (msg, d) => console.warn(`[${new Date().toISOString()}] WARN  [bot] ${msg}`, d || ''),
  error: (msg, d) => console.error(`[${new Date().toISOString()}] ERROR [bot] ${msg}`, d || ''),
};

log.info('=== QUTRADING BOT v9.0 STARTING ===');
log.info(`Token: ${!!TOKEN} | ChatID: ${!!CHAT_ID} | Port: ${PORT}`);

if (!TOKEN || !CHAT_ID) {
  log.error('FATAL: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
  process.exit(1);
}

// ── HTTP server (Render.com requires HTTP listener) ────────────
const app = express();
app.get('/',       (_, res) => res.send('QUTRADING BOT v9.0 — Online'));
app.get('/health', (_, res) => res.json({ status: 'ok', version: '9.0', analyzer: '7.0', uptime: process.uptime() }));
app.listen(PORT, () => log.info(`HTTP server listening on port ${PORT}`));

// ── Self-ping keep-alive (prevents Render free tier sleep) ─────
function startKeepAlive() {
  if (!RENDER_URL) {
    log.warn('RENDER_URL not set — bot may sleep on Render free tier. Add RENDER_URL env var after first deploy.');
    return;
  }
  log.info(`Keep-alive active: pinging ${RENDER_URL}/health every 10 min`);
  setInterval(async () => {
    try {
      await axios.get(`${RENDER_URL}/health`, { timeout: 8000 });
      log.info('Keep-alive ping OK');
    } catch (e) {
      log.warn('Keep-alive ping failed:', e.message);
    }
  }, 10 * 60 * 1000);
}

// ── Bot init ───────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
log.info('Telegram bot polling started');

// ── Helpers ────────────────────────────────────────────────────
const auth     = m => m.chat.id.toString() === CHAT_ID.toString();
const send     = (txt, opts = {}) => bot.sendMessage(CHAT_ID, txt, opts).catch(e => log.error('Send failed:', e.message));
const delay    = ms => new Promise(r => setTimeout(r, ms));
const gmt6     = () => new Date(Date.now() + 6 * 3600000).toISOString().slice(11, 16);
const confBar  = p => '█'.repeat(Math.round(p / 10)) + '░'.repeat(10 - Math.round(p / 10));
const winPct   = (w, l) => w + l > 0 ? Math.round((w / (w + l)) * 100) : 0;
const clean    = v => String(v || '?').replace(/[<>&"']/g, '').trim();
const expLabel = e => e >= 60 ? `${e / 60}H` : `${e}MIN`;

// ── Safe callback_data — numeric IDs, always < 10 bytes ───────
const PAIR_LIST  = [];
const PAIR_INDEX = {};

function registerPairs(pairs) {
  for (const p of pairs) {
    if (PAIR_INDEX[p.symbol] === undefined) {
      PAIR_INDEX[p.symbol] = PAIR_LIST.length;
      PAIR_LIST.push(p);
    }
  }
}
function getPair(id) {
  const idx = parseInt(id);
  return isNaN(idx) ? null : PAIR_LIST[idx] || null;
}

// ── State ──────────────────────────────────────────────────────
let autoMode      = false;
let autoTimer     = null;
let autoInterval  = 15;
let selectedTF    = '15min';
let selectedExpiry = 15;
let stake         = 5;
let scanLock      = false;
let pendingPairId = null;

let S = { total: 0, wins: 0, losses: 0, skipped: 0, calls: 0, puts: 0, pnl: 0 };
const pairStats = {};
const tfStats   = {};

function resetStats() {
  S = { total: 0, wins: 0, losses: 0, skipped: 0, calls: 0, puts: 0, pnl: 0 };
  Object.keys(pairStats).forEach(k => delete pairStats[k]);
  Object.keys(tfStats).forEach(k => delete tfStats[k]);
  cacheClear();
  log.info('Session stats and cache cleared');
}
function getPairStat(sym) {
  if (!pairStats[sym]) pairStats[sym] = { wins: 0, losses: 0, skipped: 0 };
  return pairStats[sym];
}
function getTFStat(tf) {
  if (!tfStats[tf]) tfStats[tf] = { wins: 0, losses: 0 };
  return tfStats[tf];
}

// Circuit breaker
let cbOn = false, cbAt = null, consLoss = 0;
function isCB() {
  if (!cbOn) return false;
  if (Date.now() - cbAt >= 2 * 60 * 60 * 1000) { resetCB(); return false; }
  return true;
}
function setCB()   { cbOn = true; cbAt = Date.now(); log.warn('Circuit breaker TRIGGERED'); }
function resetCB() { cbOn = false; cbAt = null; consLoss = 0; log.info('Circuit breaker reset'); }

// ── Pairs ──────────────────────────────────────────────────────
const OTC_PAIRS = [
  { symbol: 'EUR/USD OTC', payout: 92, cat: 'OTC' },
  { symbol: 'GBP/USD OTC', payout: 92, cat: 'OTC' },
  { symbol: 'AUD/USD OTC', payout: 92, cat: 'OTC' },
  { symbol: 'AUD/CHF OTC', payout: 92, cat: 'OTC' },
  { symbol: 'EUR/GBP OTC', payout: 92, cat: 'OTC' },
  { symbol: 'EUR/JPY OTC', payout: 92, cat: 'OTC' },
  { symbol: 'GBP/JPY OTC', payout: 92, cat: 'OTC' },
  { symbol: 'GBP/AUD OTC', payout: 92, cat: 'OTC' },
  { symbol: 'NZD/USD OTC', payout: 90, cat: 'OTC' },
  { symbol: 'USD/JPY OTC', payout: 90, cat: 'OTC' },
  { symbol: 'AUD/JPY OTC', payout: 87, cat: 'OTC' },
  { symbol: 'USD/CHF OTC', payout: 88, cat: 'OTC' },
  { symbol: 'AUD/CAD OTC', payout: 87, cat: 'OTC' },
  { symbol: 'CAD/JPY OTC', payout: 87, cat: 'OTC' },
  { symbol: 'EUR/CHF OTC', payout: 88, cat: 'OTC' },
  { symbol: 'EUR/AUD OTC', payout: 87, cat: 'OTC' },
];
const LIVE_PAIRS = [
  { symbol: 'EUR/USD', payout: 86, cat: 'LIVE' },
  { symbol: 'GBP/USD', payout: 87, cat: 'LIVE' },
  { symbol: 'USD/JPY', payout: 85, cat: 'LIVE' },
  { symbol: 'EUR/GBP', payout: 87, cat: 'LIVE' },
  { symbol: 'GBP/JPY', payout: 85, cat: 'LIVE' },
  { symbol: 'EUR/JPY', payout: 85, cat: 'LIVE' },
  { symbol: 'AUD/USD', payout: 85, cat: 'LIVE' },
  { symbol: 'USD/CHF', payout: 85, cat: 'LIVE' },
  { symbol: 'NZD/USD', payout: 84, cat: 'LIVE' },
  { symbol: 'USD/CAD', payout: 84, cat: 'LIVE' },
];
const CRYPTO_PAIRS = [
  { symbol: 'BTC/USD OTC', payout: 90, cat: 'CRYPTO' },
  { symbol: 'ETH/USD OTC', payout: 90, cat: 'CRYPTO' },
  { symbol: 'XRP/USD OTC', payout: 88, cat: 'CRYPTO' },
  { symbol: 'LTC/USD OTC', payout: 88, cat: 'CRYPTO' },
  { symbol: 'ADA/USD OTC', payout: 87, cat: 'CRYPTO' },
  { symbol: 'SOL/USD OTC', payout: 87, cat: 'CRYPTO' },
];
const COMM_PAIRS = [
  { symbol: 'XAU/USD OTC', payout: 90, cat: 'COMMODITY' },
  { symbol: 'XAG/USD OTC', payout: 88, cat: 'COMMODITY' },
  { symbol: 'XAU/USD',     payout: 85, cat: 'COMMODITY' },
];

const ALL_PAIRS = [...OTC_PAIRS, ...LIVE_PAIRS, ...CRYPTO_PAIRS, ...COMM_PAIRS];
registerPairs(ALL_PAIRS);
log.info(`Registered ${ALL_PAIRS.length} pairs`);

// ── Timeframe config ───────────────────────────────────────────
const TF_OPTIONS = [
  { label: '15 SEC',  value: '15s',   expiry: 1    }, // idx 0
  { label: '30 SEC',  value: '30s',   expiry: 1    }, // idx 1
  { label: '1 MIN',   value: '1min',  expiry: 1    }, // idx 2
  { label: '5 MIN',   value: '5min',  expiry: 5    }, // idx 3
  { label: '15 MIN',  value: '15min', expiry: 15   }, // idx 4
  { label: '30 MIN',  value: '30min', expiry: 30   }, // idx 5
  { label: '1 HOUR',  value: '1h',    expiry: 60   }, // idx 6
  { label: '4 HOUR',  value: '4h',    expiry: 240  }, // idx 7
  { label: '1 DAY',   value: '1day',  expiry: 1440 }, // idx 8
];
const TF_IDX = {};
TF_OPTIONS.forEach((t, i) => { TF_IDX[t.value] = i; });
function getTFByIdx(idx) {
  const i = parseInt(idx);
  return isNaN(i) ? null : TF_OPTIONS[i] || null;
}

// ── Sessions (GMT+6 display) ───────────────────────────────────
const SESSIONS = [
  { name: 'London/NY Overlap', s: 19*60,    e: 21*60+30, d: [1,2,3,4,5] },
  { name: 'London Open',       s: 14*60,    e: 16*60,    d: [1,2,3,4,5] },
  { name: 'Late NY / OTC',     s: 22*60+30, e: 24*60,    d: [1,2,3,4,5] },
  { name: 'Asian OTC',         s: 5*60,     e: 7*60,     d: [2,3,4,5]   },
  { name: 'Morning OTC',       s: 9*60,     e: 11*60,    d: [3,4,5,6]   },
  { name: 'Weekend OTC',       s: 11*60,    e: 13*60,    d: [0,6]       },
];
function getSession() {
  const t = new Date(Date.now() + 6 * 3600000);
  const d = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  for (const s of SESSIONS) {
    if (s.d.includes(d) && m >= s.s && m < s.e) return { active: true, ...s };
  }
  return { active: false, name: 'Outside Prime Hours' };
}
function newsCheck() {
  const now = new Date();
  const h = now.getUTCHours(), m = now.getUTCMinutes(), d = now.getUTCDay();
  const min = h * 60 + m;
  const windows = [
    { s: 8*60+15,  e: 9*60+15,  desc: 'European Open'  },
    { s: 13*60+15, e: 14*60+15, desc: 'US Market Open'  },
    { s: 15*60+45, e: 16*60+30, desc: 'US Data Release' },
    ...(d === 5 ? [{ s: 13*60+15, e: 14*60+30, desc: 'NFP Friday' }] : []),
    ...(d === 3 ? [{ s: 18*60+45, e: 20*60,    desc: 'FOMC'       }] : []),
  ];
  for (const w of windows) {
    if (min >= w.s - 15 && min <= w.e) return { on: true, desc: w.desc };
  }
  return { on: false };
}

// ── Keyboards ──────────────────────────────────────────────────
const MAIN_KB = {
  reply_markup: {
    keyboard: [
      [{ text: '📋 OTC Pairs'  }, { text: '🌐 Live Pairs'  }, { text: '₿ Crypto'      }],
      [{ text: '🛢 Commodity'  }, { text: '📊 Stats'        }, { text: '⚡ Status'      }],
      [{ text: '🟢 Auto ON'   }, { text: '🔴 Auto OFF'     }, { text: '🔬 Backtest'    }],
      [{ text: '⏱ Timeframe'  }, { text: '💵 Stake'        }, { text: '🏆 Best Pairs'  }],
      [{ text: '📈 TF Stats'  }, { text: '🔁 Reset'        }, { text: '❓ Help'        }],
      [{ text: '🛡 Breaker'   }],
    ],
    resize_keyboard: true
  }
};

function pairKeyboard(pairs) {
  const rows = [];
  for (let i = 0; i < pairs.length; i += 2) {
    rows.push(pairs.slice(i, i + 2).map(p => ({
      text: p.symbol,
      callback_data: `P${PAIR_INDEX[p.symbol]}`
    })));
  }
  rows.push([{ text: '🔙 Back', callback_data: 'BACK' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function tfKeyboard(pairId) {
  const rows = [];
  for (let i = 0; i < TF_OPTIONS.length; i += 3) {
    rows.push(TF_OPTIONS.slice(i, i + 3).map((tf, j) => ({
      text: tf.label + (tf.value === selectedTF ? ' ✓' : ''),
      callback_data: `T${pairId}_${i + j}`
    })));
  }
  rows.push([{ text: '🔙 Back', callback_data: 'BACK' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// ── Core Scan ──────────────────────────────────────────────────
async function scanPair(pair, tf) {
  if (isCB()) {
    const rem = Math.ceil((2 * 60 * 60 * 1000 - (Date.now() - cbAt)) / 60000);
    return send(`🛑 CIRCUIT BREAKER ACTIVE\n3 losses in a row.\nAuto-resets in ${rem} min.\nTap Breaker to override.`);
  }
  if (scanLock) return send(`⏳ Scan in progress. Please wait...`);

  scanLock = true;
  const tfObj    = TF_OPTIONS.find(t => t.value === tf) || TF_OPTIONS[4];
  const session  = getSession();
  const news     = newsCheck();
  const newsWarn = news.on ? `\n⚠️ NEWS: ${news.desc} — trade carefully` : '';
  const sessLine = session.active ? `📅 ${session.name}` : `📅 Outside prime hours`;

  log.info(`Scanning ${pair.symbol} on ${tfObj.label}`);
  await send(`🔍 Scanning ${pair.symbol} — ${tfObj.label}...\n${sessLine}${newsWarn}`);

  let data = null;
  try {
    data = await fetchPriceData(pair.symbol, tf);
  } catch (e) {
    log.error(`Fetch error ${pair.symbol}:`, e.message);
  } finally {
    scanLock = false; // ALWAYS unlock
  }

  // Handle structured errors from pricefetcher
  if (!data || data.error || !data.ltf) {
    const errType = data?.error;
    const errMsg  = data?.message;

    if (errType === 'NO_API_KEY') {
      return send(
        `⚙️ SETUP REQUIRED\n\n` +
        `TWELVE_DATA_API_KEY is not set.\n\n` +
        `Fix:\n` +
        `1. Go to twelvedata.com → sign up free\n` +
        `2. Copy your API key\n` +
        `3. Render dashboard → Environment → Add:\n` +
        `   TWELVE_DATA_API_KEY = your_key_here\n` +
        `4. Save → bot redeploys automatically`
      );
    }

    if (errType === 'RATE_LIMITED') {
      const waitSec = getRateLimitStatus() || 60;
      return send(
        `⏱ API RATE LIMIT\n\n` +
        `Twelve Data free plan: 8 calls/minute.\n` +
        `Please wait ${waitSec} seconds then scan again.\n\n` +
        `Tip: The bot caches data for 90 seconds.\n` +
        `Scanning the same pair again immediately uses the cache — no API call needed.`
      );
    }

    return send(
      `📡 No data — ${pair.symbol}\n\n` +
      (errMsg ? `Reason: ${errMsg}\n\n` : '') +
      `Other possible causes:\n` +
      `• Pair not available on Twelve Data free plan\n` +
      `• Network issue on Render server\n\n` +
      `Try EUR/USD OTC or GBP/USD OTC — these are most reliable.\n` +
      (tf === '15s' || tf === '30s' ? `Note: ${tf} requires Twelve Data Pro plan.\n` : '')
    );
  }

  const fallbackNote = data.usedFallback ? `\n(${tf} unavailable — 1min fallback)` : '';
  let sig = null;
  try {
    sig = analyzeSignal(data.ltf, pair, data.htf);
  } catch (e) {
    log.error('Analyzer error:', e.message);
    return send(`⚠️ Analysis error for ${pair.symbol}. Try again.`);
  }

  if (!sig || sig.noSignal) {
    const ps = getPairStat(pair.symbol);
    log.info(`No signal: ${pair.symbol} — ${sig?.reason || 'no signal'}`);
    return send(
      `📭 NO SIGNAL — ${pair.symbol} [${tfObj.label}]${fallbackNote}\n\n` +
      `${sessLine}\n` +
      `Reason: ${sig?.reason || 'Indicators not aligned'}\n` +
      `Votes: CALL ${sig?.callVotes || 0} | PUT ${sig?.putVotes || 0}\n` +
      `Payout: ${pair.payout}%\n\n` +
      `Wait 10-15 min or try another pair.\n` +
      `Your record: ${ps.wins}W / ${ps.losses}L`
    );
  }

  log.info(`Signal: ${pair.symbol} ${sig.direction} conf=${sig.confidence}% votes=${sig.callVotes}C/${sig.putVotes}P`);
  S.total++;
  sig.direction === 'CALL' ? S.calls++ : S.puts++;
  await sendSignal(sig, session, newsWarn, tf, fallbackNote);
}

// ── Signal Card ────────────────────────────────────────────────
async function sendSignal(sig, session, newsWarn = '', tf = selectedTF, note = '') {
  const dir      = sig.direction === 'CALL' ? '🟢 CALL ⬆️' : '🔴 PUT ⬇️';
  const tier     = sig.payout >= 92 ? '💎 PREMIUM' : sig.payout >= 88 ? '🥇 HIGH' : '🥈 STANDARD';
  const liveTag  = sig.cat === 'LIVE' ? ' ⭐LIVE' : '';
  const tfLabel  = TF_OPTIONS.find(t => t.value === tf)?.label || tf;
  const ps       = getPairStat(sig.symbol);
  const wr       = winPct(ps.wins, ps.losses);
  const divLine  = sig.divergence && sig.divergence !== 'NONE' ? `\nDivergence: ${clean(sig.divergence)}` : '';
  const reasonLines = (sig.reasons || []).slice(0, 6).map(r => `  • ${clean(r)}`).join('\n');
  const warnBlock   = (sig.warnings || []).length > 0
    ? '\n\nCaution:\n' + sig.warnings.slice(0, 3).map(w => `  • ${clean(w)}`).join('\n') : '';

  const msg =
    `${dir}${liveTag}  ${tier}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${clean(sig.symbol)}  |  TF: ${tfLabel}\n` +
    `Payout: +${sig.payout}%  |  Expiry: ${expLabel(selectedExpiry)}\n` +
    `Confidence: ${sig.confidence}%\n` +
    `[${confBar(sig.confidence)}]\n\n` +
    `Votes: CALL ${sig.callVotes} | PUT ${sig.putVotes} | Gap: ${sig.separation}\n\n` +
    `Entry: ${clean(sig.entryPrice?.toFixed ? sig.entryPrice.toFixed(5) : sig.entryPrice)}\n` +
    `RSI: ${clean(sig.rsi)}  CCI: ${clean(sig.cci)}\n` +
    `Stoch K: ${clean(sig.stochK)} D: ${clean(sig.stochD)}\n` +
    `MACD: ${clean(sig.macd)}\n` +
    `SuperTrend: ${clean(sig.superTrend)}  ADX: ${clean(sig.adx)}\n` +
    `+DI: ${clean(sig.plusDI)}  -DI: ${clean(sig.minusDI)}\n` +
    `BB Width: ${clean(sig.bbWidth)}%\n` +
    `HTF: ${clean(sig.htfBias)}  Session: ${clean(sig.session)}${divLine}\n` +
    `Tick Vol: ${clean(sig.volume)}\n\n` +
    `Signals (${clean(sig.indicators)}):\n` +
    reasonLines + warnBlock +
    `\n\n📅 ${clean(session?.name || 'Session')}${newsWarn}${note}\n` +
    `💵 Stake $${stake} → Win +$${(stake * sig.payout / 100).toFixed(2)} | Loss -$${stake}\n` +
    `📌 ${clean(sig.symbol)}: ${ps.wins}W/${ps.losses}L${ps.wins + ps.losses > 0 ? ` (${wr}% WR)` : ''}\n\n` +
    `Verify payout on Pocket Option before entering`;

  const pid  = PAIR_INDEX[sig.symbol] ?? 0;
  const tidx = TF_IDX[tf] ?? 4;

  await bot.sendMessage(CHAT_ID, msg, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ WIN',  callback_data: `W${pid}_${tidx}` },
        { text: '❌ LOSS', callback_data: `L${pid}_${tidx}` },
        { text: '⏭ SKIP', callback_data: `K${pid}`         },
      ]]
    }
  }).catch(e => log.error('Signal send failed:', e.message));
}

// ── Professional Backtest ──────────────────────────────────────
async function runBacktest() {
  await send(`🔬 PROFESSIONAL BACKTEST — ${selectedTF}\n⏳ Takes 2-3 minutes...`);
  const results = [];

  for (const pair of OTC_PAIRS.slice(0, 4)) {
    try {
      await send(`Testing ${pair.symbol}...`);
      const d = await fetchHistoricalData(pair.symbol, selectedTF, 300);
      if (!d || d.closes.length < 60) { await send(`Skipping ${pair.symbol} — insufficient data`); continue; }
      const r = backtest(d, pair, 50);
      if (r) results.push(r);
      await delay(2000);
    } catch (e) {
      log.error('Backtest error:', e.message);
    }
  }

  if (!results.length) return send(`📭 No backtest data. API limit. Try in 2 minutes.`);
  results.sort((a, b) => b.winRate - a.winRate);

  let msg = `🔬 PROFESSIONAL BACKTEST — ${selectedTF}\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (const r of results) {
    const g = r.winRate >= 65 ? '🟢' : r.winRate >= 58 ? '🟡' : '🔴';
    msg += `${g} ${r.pair} [${r.grade}] ${r.valid}\n`;
    msg += `  Trades: ${r.total} | W:${r.wins} L:${r.losses} Skip:${r.skipped}\n`;
    msg += `  Win Rate: ${r.winRate}% | Conf: ${r.avgConf}%\n`;
    msg += `  Profit Factor: ${r.profitFactor} | Sharpe: ${r.sharpe}\n`;
    msg += `  Max Drawdown: ${r.maxDrawdown}% | Expectancy: ${r.expectancy}\n`;
    msg += `  P&L: ${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl} units\n`;
    msg += `  Streaks: Best ${r.maxWinStreak}W | Worst ${r.maxLossStreak}L\n\n`;
  }
  if (results[0]) msg += `Best: ${results[0].pair} — WR:${results[0].winRate}% PF:${results[0].profitFactor}`;
  return send(msg);
}

// ── Auto Scan ──────────────────────────────────────────────────
async function autoScan() {
  if (isCB() || scanLock) return;
  scanLock = true;
  log.info('Auto scan started');

  const session = getSession();
  const news    = newsCheck();
  const pairs   = session.active ? OTC_PAIRS.slice(0, 5) : OTC_PAIRS.slice(0, 3);

  try {
    for (const pair of pairs) {
      try {
        const data = await fetchPriceData(pair.symbol, selectedTF);
        if (!data || !data.ltf) { await delay(1500); continue; }
        const sig = analyzeSignal(data.ltf, pair, data.htf);
        if (sig && !sig.noSignal && sig.confidence >= 68) {
          S.total++;
          sig.direction === 'CALL' ? S.calls++ : S.puts++;
          const nw = news.on ? `\n⚠️ NEWS: ${news.desc}` : '';
          await sendSignal(sig, session, nw, selectedTF);
          return; // one signal per cycle
        }
        await delay(1500);
      } catch (e) {
        log.error('Auto scan pair error:', e.message);
      }
    }
    send(`📭 Auto scan — No setups found. Retrying in ${autoInterval} min.`);
  } finally {
    scanLock = false;
    log.info('Auto scan complete');
  }
}

// ── Message Handler ────────────────────────────────────────────
bot.on('message', async msg => {
  if (!auth(msg)) return;
  const t = (msg.text || '').trim();
  log.info(`Message: ${t.substring(0, 60)}`);

  try {
    if (t === '📋 OTC Pairs')   return bot.sendMessage(CHAT_ID, `📋 OTC Pairs\nTF: ${selectedTF}`, pairKeyboard(OTC_PAIRS));
    if (t === '🌐 Live Pairs')  return bot.sendMessage(CHAT_ID, `🌐 Live Pairs\nTF: ${selectedTF}`, pairKeyboard(LIVE_PAIRS));
    if (t === '₿ Crypto')       return bot.sendMessage(CHAT_ID, `₿ Crypto\nTF: ${selectedTF}`, pairKeyboard(CRYPTO_PAIRS));
    if (t === '🛢 Commodity')   return bot.sendMessage(CHAT_ID, `🛢 Commodity\nTF: ${selectedTF}`, pairKeyboard(COMM_PAIRS));
    if (t === '📊 Stats')       return sendStats();
    if (t === '⚡ Status')      return sendStatus();
    if (t === '🔬 Backtest')    return runBacktest();
    if (t === '🏆 Best Pairs')  return sendBestPairs();
    if (t === '📈 TF Stats')    return sendTFStats();
    if (t === '🛡 Breaker')     return sendBreaker();
    if (t === '❓ Help' || t === '/start') return sendHelp();
    if (t === '🔁 Reset')       { resetStats(); return send(`🔁 Stats + cache reset.`, MAIN_KB); }

    if (t === '🟢 Auto ON') {
      if (autoMode) return send(`Auto already running (every ${autoInterval} min).`);
      autoMode = true;
      send(`🟢 AUTO ON — ${selectedTF} every ${autoInterval} min`);
      autoScan();
      autoTimer = setInterval(autoScan, autoInterval * 60 * 1000);
      return;
    }
    if (t === '🔴 Auto OFF') {
      autoMode = false;
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      return send(`🔴 AUTO OFF`);
    }

    if (t === '⏱ Timeframe') {
      return bot.sendMessage(CHAT_ID, `⏱ Set default TF\nCurrent: ${selectedTF}\n15s/30s need Pro plan`, {
        reply_markup: { inline_keyboard: [
          [{ text:'15 SEC',callback_data:'DF0'},{text:'30 SEC',callback_data:'DF1'},{text:'1 MIN ⭐',callback_data:'DF2'}],
          [{ text:'5 MIN', callback_data:'DF3'},{text:'15 MIN ⭐',callback_data:'DF4'},{text:'30 MIN',callback_data:'DF5'}],
          [{ text:'1 HOUR',callback_data:'DF6'},{text:'4 HOUR',callback_data:'DF7'},{text:'1 DAY',callback_data:'DF8'}],
        ]}
      });
    }
    if (t === '💵 Stake') {
      return bot.sendMessage(CHAT_ID, '💵 Select stake:', { reply_markup: { inline_keyboard: [
        [{text:'$1',callback_data:'S1'},{text:'$3',callback_data:'S3'},{text:'$5',callback_data:'S5'},{text:'$10',callback_data:'S10'}],
        [{text:'$15',callback_data:'S15'},{text:'$20',callback_data:'S20'},{text:'$25',callback_data:'S25'},{text:'$50',callback_data:'S50'}],
      ]}});
    }
  } catch (e) {
    log.error('Message handler error:', e.message);
    send(`⚠️ Error: ${e.message}. Try again.`);
  }
});

// ── Callback Handler ───────────────────────────────────────────
bot.on('callback_query', async q => {
  if (q.message.chat.id.toString() !== CHAT_ID.toString()) return;
  const d = q.data || '';
  try {
    await bot.answerCallbackQuery(q.id).catch(() => {});

    if (d === 'BACK')     return bot.sendMessage(CHAT_ID, '🏠 Main menu', MAIN_KB);
    if (d === 'CB_RESET') { resetCB(); return send(`✅ Circuit breaker reset.`); }
    if (d === 'CB_KEEP')  return;

    // P<id> — pair selected, show TF picker
    if (/^P\d+$/.test(d)) {
      const pair = getPair(d.slice(1));
      if (!pair) return send(`Pair not found.`);
      pendingPairId = parseInt(d.slice(1));
      return bot.sendMessage(CHAT_ID, `${pair.symbol}\nPayout: ${pair.payout}%\n\nSelect timeframe:`, tfKeyboard(pendingPairId));
    }

    // T<pairId>_<tfIdx> — TF selected, run scan
    if (/^T\d+_\d+$/.test(d)) {
      const parts = d.slice(1).split('_');
      const pair  = getPair(parts[0]) || getPair(pendingPairId);
      const tfObj = getTFByIdx(parts[1]);
      if (!pair)  return send(`Pair not found. Select from menu.`);
      if (!tfObj) return send(`Timeframe error. Try again.`);
      selectedTF = tfObj.value; selectedExpiry = tfObj.expiry;
      return scanPair(pair, tfObj.value);
    }

    // DF<idx> — set default TF
    if (/^DF\d+$/.test(d)) {
      const tfObj = getTFByIdx(d.slice(2));
      if (!tfObj) return;
      selectedTF = tfObj.value; selectedExpiry = tfObj.expiry;
      if (autoMode && autoTimer) { clearInterval(autoTimer); autoTimer = setInterval(autoScan, autoInterval * 60 * 1000); }
      return send(`⏱ Default TF: ${tfObj.label} (${expLabel(tfObj.expiry)})`);
    }

    // S<amount> — stake
    if (/^S\d+$/.test(d)) {
      stake = parseFloat(d.slice(1));
      return send(`💵 Stake: $${stake} → Win: +$${(stake * 0.92).toFixed(2)} at 92%`);
    }

    // W<pairId>_<tfIdx> — win
    if (/^W\d+_\d+$/.test(d)) {
      const parts = d.slice(1).split('_');
      const pair = getPair(parts[0]), tfObj = getTFByIdx(parts[1]);
      if (!pair || !tfObj) return;
      const ps = getPairStat(pair.symbol), tfs = getTFStat(tfObj.value);
      S.wins++; consLoss = 0; S.pnl += stake * (pair.payout / 100);
      ps.wins++; tfs.wins++;
      log.info(`WIN: ${pair.symbol} session=${S.wins}W/${S.losses}L`);
      return send(`✅ WIN — ${pair.symbol}\nSession: ${S.wins}W/${S.losses}L (${winPct(S.wins,S.losses)}% WR)\nP&L: +$${S.pnl.toFixed(2)}\nPair: ${ps.wins}W/${ps.losses}L | TF ${tfObj.value}: ${tfs.wins}W/${tfs.losses}L`);
    }

    // L<pairId>_<tfIdx> — loss
    if (/^L\d+_\d+$/.test(d)) {
      const parts = d.slice(1).split('_');
      const pair = getPair(parts[0]), tfObj = getTFByIdx(parts[1]);
      if (!pair || !tfObj) return;
      const ps = getPairStat(pair.symbol), tfs = getTFStat(tfObj.value);
      S.losses++; consLoss++; S.pnl -= stake;
      ps.losses++; tfs.losses++;
      log.info(`LOSS: ${pair.symbol} consLoss=${consLoss} session=${S.wins}W/${S.losses}L`);
      send(`❌ LOSS — ${pair.symbol}\nSession: ${S.wins}W/${S.losses}L (${winPct(S.wins,S.losses)}% WR)\nP&L: $${S.pnl.toFixed(2)}\nConsecutive losses: ${consLoss}`);
      if (consLoss >= 3) { setCB(); send(`🛑 CIRCUIT BREAKER TRIGGERED\n3 consecutive losses. STOP NOW.\nProtecting capital.\nAuto-resets in 2 hours.`); }
      return;
    }

    // K<pairId> — skip
    if (/^K\d+$/.test(d)) {
      const pair = getPair(d.slice(1));
      if (pair) { S.skipped++; getPairStat(pair.symbol).skipped++; }
      return;
    }

  } catch (e) {
    log.error('Callback error:', e.message);
  }
});

// ── Info Functions ─────────────────────────────────────────────
function sendStats() {
  const wr = winPct(S.wins, S.losses);
  const grade = wr >= 75 ? 'A+' : wr >= 70 ? 'A' : wr >= 62 ? 'B' : wr >= 55 ? 'C' : 'D';
  return send(
    `📊 SESSION STATS\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Signals: ${S.total} | CALL: ${S.calls} | PUT: ${S.puts}\n` +
    `Wins: ${S.wins} | Losses: ${S.losses} | Skipped: ${S.skipped}\n` +
    `Win Rate: ${wr}% [Grade: ${grade}]\n` +
    `P&L: ${S.pnl >= 0 ? '+' : ''}$${S.pnl.toFixed(2)}\n` +
    `Consecutive losses: ${consLoss}\n` +
    `Circuit Breaker: ${isCB() ? 'ACTIVE' : 'Clear'}\n` +
    `TF: ${selectedTF} | Expiry: ${expLabel(selectedExpiry)}\n` +
    `Stake: $${stake} | GMT+6: ${gmt6()}`
  );
}

function sendStatus() {
  const s = getSession(), n = newsCheck();
  const rl = getRateLimitStatus();
  return send(
    `⚡ QUTRADING BOT v9.0\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Analyzer: v7.0 | Fetcher: v5.0\n` +
    `Online: YES\n` +
    `Auto Mode: ${autoMode ? `ON (${autoInterval} min)` : 'OFF'}\n` +
    `TF: ${selectedTF} | Expiry: ${expLabel(selectedExpiry)}\n` +
    `Stake: $${stake}\n` +
    `Session: ${s.name} ${s.active ? '✅' : '⚠️'}\n` +
    `News: ${n.on ? `⚠️ ${n.desc}` : 'Clear'}\n` +
    `Breaker: ${isCB() ? 'ACTIVE' : 'Clear'}\n` +
    `API Rate Limit: ${rl ? `⚠️ Wait ${rl}s` : 'Clear ✅'}\n` +
    `Keep-alive: ${RENDER_URL ? 'Active ✅' : '⚠️ Set RENDER_URL'}\n` +
    `GMT+6: ${gmt6()}\n` +
    `Pairs: ${OTC_PAIRS.length} OTC | ${LIVE_PAIRS.length} Live | ${CRYPTO_PAIRS.length} Crypto | ${COMM_PAIRS.length} Commodity`
  );
}

function sendBestPairs() {
  const entries = Object.entries(pairStats)
    .filter(([, v]) => v.wins + v.losses >= 3)
    .map(([sym, v]) => ({ sym, wr: winPct(v.wins, v.losses), ...v }))
    .sort((a, b) => b.wr - a.wr);
  if (!entries.length) return send(`No pair data yet.\nNeed 3+ trades per pair.`);
  let msg = `🏆 BEST PAIRS — SESSION\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (const e of entries.slice(0, 10)) {
    msg += `${e.wr >= 70 ? '🟢' : e.wr >= 55 ? '🟡' : '🔴'} ${e.sym}: ${e.wins}W/${e.losses}L — ${e.wr}% WR\n`;
  }
  return send(msg);
}

function sendTFStats() {
  const entries = Object.entries(tfStats)
    .filter(([, v]) => v.wins + v.losses >= 3)
    .map(([tf, v]) => ({ tf, wr: winPct(v.wins, v.losses), ...v }))
    .sort((a, b) => b.wr - a.wr);
  if (!entries.length) return send(`No TF data yet.\nNeed 3+ trades per TF.`);
  let msg = `📈 TF ACCURACY\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (const e of entries) {
    msg += `${e.wr >= 70 ? '🟢' : e.wr >= 55 ? '🟡' : '🔴'} ${e.tf}: ${e.wins}W/${e.losses}L — ${e.wr}% WR\n`;
  }
  msg += `\nBest TF: ${entries[0].tf} (${entries[0].wr}% WR)`;
  return send(msg);
}

function sendBreaker() {
  if (!isCB()) return send(`🛡 Circuit Breaker: CLEAR. Trading active.`);
  const rem = Math.ceil((2 * 60 * 60 * 1000 - (Date.now() - cbAt)) / 60000);
  return bot.sendMessage(CHAT_ID,
    `🛑 CIRCUIT BREAKER ACTIVE\nAuto-resets in ${rem} min.\n\nOverride and resume trading?`,
    { reply_markup: { inline_keyboard: [[
      { text: 'Yes, resume', callback_data: 'CB_RESET' },
      { text: 'Keep paused', callback_data: 'CB_KEEP'  },
    ]]}}
  );
}

function sendHelp() {
  return send(
    `🎯 QUTRADING BOT v9.0\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `How to use:\n` +
    `1. Tap OTC / Live / Crypto / Commodity\n` +
    `2. Select your pair\n` +
    `3. Select timeframe for this scan\n` +
    `4. Bot returns CALL / PUT / NO SIGNAL\n` +
    `5. Verify payout on Pocket Option\n` +
    `6. Enter trade — tap WIN / LOSS / SKIP\n\n` +
    `Timeframes: 15s 30s 1min 5min 15min 30min 1h 4h 1day\n` +
    `Note: 15s/30s need Twelve Data Pro plan\n\n` +
    `Signal Engine (14 indicators):\n` +
    `RSI Divergence, RSI, MACD, Stochastic,\n` +
    `Bollinger Bands, SuperTrend, CCI,\n` +
    `EMA9/21/50, ADX, S/R, HTF Bias,\n` +
    `Tick Volume, Patterns, Momentum\n\n` +
    `Protections:\n` +
    `• Circuit breaker: 3 consecutive losses\n` +
    `• News blackout windows\n` +
    `• Scan lock + 60s TTL cache\n` +
    `• Per-pair + per-TF accuracy tracker\n` +
    `• Self-ping keep-alive\n\n` +
    `Pairs: ${OTC_PAIRS.length} OTC | ${LIVE_PAIRS.length} Live | ${CRYPTO_PAIRS.length} Crypto | ${COMM_PAIRS.length} Commodity\n` +
    `No Pocket Option API key required.\n` +
    `Recommended: 15min TF | Stake 2-3% balance`,
    MAIN_KB
  );
}

// ── Boot ───────────────────────────────────────────────────────
setTimeout(() => {
  startKeepAlive();
  send(
    `🚀 QUTRADING BOT v9.0 — ONLINE\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Analyzer v7.0 | Fetcher v4.0\n` +
    `14-indicator engine loaded\n` +
    `SuperTrend + CCI added\n` +
    `TTL cache active (60s)\n` +
    `Serial request queue active\n` +
    `Session quality multiplier active\n` +
    `Keep-alive: ${RENDER_URL ? 'Active' : 'Set RENDER_URL env var'}\n` +
    `Pairs: ${ALL_PAIRS.length} total\n\n` +
    `Tap OTC Pairs to begin`,
    MAIN_KB
  );
  log.info('Boot message sent');
}, 3000);

log.info('=== Setup complete ===');

