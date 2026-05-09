// ═══════════════════════════════════════════════════════════════
// ANALYZER v7.0 — QUTRADING BOT
// Standard: Professional Quantitative Developer
//
// Fixes from v6.0 audit:
//   P1  Dead calcEMAFromSeed removed
//   P2  SuperTrend uses Wilder-smoothed ATR (correct bands)
//   P3  Session overlap logic fixed — NY Open now reachable
//   P4  MACD dead condition cleaned up
//   P5  Dead code removal confirmed
//   P8  Unused variable in getHTFBias removed
//   P11 CCI guards for array length mismatch
//   P12 Backtest loops until bars exhausted, reports actual coverage
//
// Architecture:
//   14 independent indicators, fresh votes every scan
//   Wilder RSI (matches TradingView exactly)
//   Real Stochastic D (3-period SMA of K)
//   Wilder-smoothed SuperTrend ATR
//   CCI with array guard
//   Session quality multiplier on confidence
//   Professional backtest: Sharpe, PF, drawdown, expectancy
// ═══════════════════════════════════════════════════════════════

'use strict';

// ── Structured logger ──────────────────────────────────────────
const log = {
  info:  (msg, data) => console.log(`[${new Date().toISOString()}] INFO  ${msg}`, data || ''),
  warn:  (msg, data) => console.warn(`[${new Date().toISOString()}] WARN  ${msg}`, data || ''),
  error: (msg, data) => console.error(`[${new Date().toISOString()}] ERROR ${msg}`, data || ''),
};

// ── EMA — O(n) ─────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── RSI — Wilder's smoothing, O(n) ────────────────────────────
function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

// O(n) RSI series — incremental, no reprocessing
function calcRSISeries(prices, period = 14) {
  const result = [];
  if (!prices || prices.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;
  const toRSI = (g, l) => l === 0 ? 100 : g === 0 ? 0 : parseFloat((100 - 100 / (1 + g / l)).toFixed(2));
  result.push(toRSI(avgGain, avgLoss));
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    result.push(toRSI(avgGain, avgLoss));
  }
  return result;
}

// ── MACD — O(n) single pass, clean logic ──────────────────────
function calcMACD(prices) {
  if (!prices || prices.length < 35) return { macd: 0, signal: 0, histogram: 0, prevHistogram: 0 };

  // Seed EMA12 and EMA26 from first N bars
  let ema12 = prices.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let ema26 = prices.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;

  // Build MACD series from bar 26 onward
  const macdSeries = [];
  for (let i = 26; i < prices.length; i++) {
    ema12 = prices[i] * k12 + ema12 * (1 - k12);
    ema26 = prices[i] * k26 + ema26 * (1 - k26);
    macdSeries.push(ema12 - ema26);
  }
  if (macdSeries.length === 0) return { macd: 0, signal: 0, histogram: 0, prevHistogram: 0 };

  // Signal line: SMA seed for first 9 values, then EMA
  let sigLine = macdSeries.slice(0, Math.min(9, macdSeries.length))
    .reduce((a, b) => a + b, 0) / Math.min(9, macdSeries.length);
  let prevSigLine = sigLine;
  for (let i = 9; i < macdSeries.length; i++) {
    prevSigLine = sigLine; // store actual previous signal value
    sigLine = macdSeries[i] * k9 + sigLine * (1 - k9);
  }

  const macdVal  = macdSeries[macdSeries.length - 1];
  const prevMacd = macdSeries.length > 1 ? macdSeries[macdSeries.length - 2] : macdVal;

  return {
    macd:          parseFloat(macdVal.toFixed(6)),
    signal:        parseFloat(sigLine.toFixed(6)),
    histogram:     parseFloat((macdVal - sigLine).toFixed(6)),
    prevHistogram: parseFloat((prevMacd - prevSigLine).toFixed(6))
  };
}

// ── Stochastic — Real K and D, correct crossover ───────────────
function calcStochastic(highs, lows, closes, period = 14, dPeriod = 3) {
  if (!closes || closes.length < period + dPeriod) {
    return { k: 50, d: 50, crossUp: false, crossDown: false };
  }
  // Build K series for dPeriod+1 bars (need previous K for crossover)
  const needed = dPeriod + 1;
  const kSeries = [];
  for (let j = closes.length - needed; j < closes.length; j++) {
    if (j - period + 1 < 0) { kSeries.push(50); continue; }
    const hi = Math.max(...highs.slice(j - period + 1, j + 1));
    const lo = Math.min(...lows.slice(j - period + 1, j + 1));
    kSeries.push(hi === lo ? 50 : ((closes[j] - lo) / (hi - lo)) * 100);
  }
  const kCurr = kSeries[kSeries.length - 1];
  const kPrev = kSeries[kSeries.length - 2] ?? kCurr;
  const dCurr = kSeries.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  const dPrev = kSeries.slice(-dPeriod - 1, -1).reduce((a, b) => a + b, 0) / dPeriod;
  return {
    k:         parseFloat(kCurr.toFixed(2)),
    d:         parseFloat(dCurr.toFixed(2)),
    crossUp:   kCurr > dCurr && kPrev <= dPrev,
    crossDown: kCurr < dCurr && kPrev >= dPrev
  };
}

// ── Bollinger Bands ────────────────────────────────────────────
function calcBollingerBands(prices, period = 20, mult = 2) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period);
  const bw    = std * mult * 2;
  const price = prices[prices.length - 1];
  const pct   = bw > 0 ? Math.min(Math.max((price - (mean - mult * std)) / bw, 0), 1) : 0.5;
  return { upper: mean + mult * std, middle: mean, lower: mean - mult * std, std, width: mean > 0 ? bw / mean : 0, pct };
}

// ── ATR — Wilder smoothed (not simple average) ─────────────────
function calcATRWilder(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period + 1) return 0.0001;
  // Seed: first period TRs averaged
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  atr /= period;
  // Wilder smoothing for remaining bars
  for (let i = period + 1; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

// ── ADX ────────────────────────────────────────────────────────
function calcADX(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period + 2) return { adx: 20, plusDI: 25, minusDI: 25 };
  const trs = [], pdms = [], ndms = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
    const up = highs[i]-highs[i-1], dn = lows[i-1]-lows[i];
    pdms.push(up > dn && up > 0 ? up : 0);
    ndms.push(dn > up && dn > 0 ? dn : 0);
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (atr === 0) return { adx: 20, plusDI: 25, minusDI: 25 };
  const pDI = (pdms.slice(-period).reduce((a, b) => a + b, 0) / period / atr) * 100;
  const nDI = (ndms.slice(-period).reduce((a, b) => a + b, 0) / period / atr) * 100;
  const dx  = pDI + nDI > 0 ? (Math.abs(pDI - nDI) / (pDI + nDI)) * 100 : 20;
  return { adx: parseFloat(dx.toFixed(2)), plusDI: parseFloat(pDI.toFixed(2)), minusDI: parseFloat(nDI.toFixed(2)) };
}

// ── SuperTrend — Wilder-smoothed ATR (FIXED from v6.0) ─────────
// Uses calcATRWilder incrementally for correct band calculation
function calcSuperTrend(highs, lows, closes, period = 10, multiplier = 3) {
  if (!closes || closes.length < period + 2) return { direction: 0, value: 0 };

  // Build Wilder ATR series incrementally
  const atrSeries = new Array(closes.length).fill(0);
  // Seed
  let seedAtr = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    seedAtr += Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
  }
  atrSeries[period] = seedAtr / period;
  // Wilder smooth forward
  for (let i = period + 1; i < closes.length; i++) {
    const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    atrSeries[i] = (atrSeries[i-1] * (period - 1) + tr) / period;
  }

  let upperBand = 0, lowerBand = 0, prevDir = 1;

  for (let i = period; i < closes.length; i++) {
    const hl2      = (highs[i] + lows[i]) / 2;
    const newUpper = hl2 + multiplier * atrSeries[i];
    const newLower = hl2 - multiplier * atrSeries[i];

    if (i === period) {
      upperBand = newUpper;
      lowerBand = newLower;
    } else {
      // Band locking — only widen band if price breaks through
      upperBand = (newUpper < upperBand || closes[i-1] > upperBand) ? newUpper : upperBand;
      lowerBand = (newLower > lowerBand || closes[i-1] < lowerBand) ? newLower : lowerBand;
    }

    if      (closes[i] > upperBand) prevDir =  1;
    else if (closes[i] < lowerBand) prevDir = -1;
    // else direction unchanged
  }

  const stVal = prevDir === 1 ? lowerBand : upperBand;
  return { direction: prevDir, value: parseFloat(stVal.toFixed(5)) };
}

// ── CCI — guarded for array length ────────────────────────────
function calcCCI(highs, lows, closes, period = 20) {
  const minLen = Math.min(highs.length, lows.length, closes.length);
  if (minLen < period) return 0;
  // Use only the common length
  const typPrices = [];
  for (let i = minLen - period; i < minLen; i++) {
    typPrices.push((highs[i] + lows[i] + closes[i]) / 3);
  }
  const mean    = typPrices.reduce((a, b) => a + b, 0) / period;
  const meanDev = typPrices.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  if (meanDev === 0) return 0;
  return parseFloat(((typPrices[typPrices.length - 1] - mean) / (0.015 * meanDev)).toFixed(2));
}

// ── Candlestick Patterns ───────────────────────────────────────
function detectPatterns(opens, closes, highs, lows) {
  const patterns = [];
  const n = closes.length;
  if (n < 4) return patterns;
  const c  = closes[n-1], o  = opens[n-1], h  = highs[n-1], l  = lows[n-1];
  const c1 = closes[n-2], o1 = opens[n-2], h1 = highs[n-2], l1 = lows[n-2];
  const c2 = closes[n-3], o2 = opens[n-3];
  const body  = Math.abs(c - o), body1 = Math.abs(c1 - o1);
  const range = h - l;
  if (range === 0) return patterns;
  const uw = h - Math.max(o, c), lw = Math.min(o, c) - l;

  if (body < range * 0.1)                                                    patterns.push({ name: 'Doji',              bias: 'NEUTRAL', weight: 0 });
  if (lw > body * 2.5 && uw < body * 0.5 && c > o && body > 0)              patterns.push({ name: 'Hammer',            bias: 'CALL',    weight: 3 });
  if (uw > body * 2.5 && lw < body * 0.5 && c < o && body > 0)              patterns.push({ name: 'Shooting Star',     bias: 'PUT',     weight: 3 });
  if (lw > body * 3 && body > 0)                                             patterns.push({ name: 'Bullish Pin Bar',   bias: 'CALL',    weight: 4 });
  if (uw > body * 3 && body > 0)                                             patterns.push({ name: 'Bearish Pin Bar',   bias: 'PUT',     weight: 4 });
  if (c > o && uw < body * 0.05 && lw < body * 0.05 && body > range * 0.9)  patterns.push({ name: 'Bull Marubozu',     bias: 'CALL',    weight: 3 });
  if (c < o && uw < body * 0.05 && lw < body * 0.05 && body > range * 0.9)  patterns.push({ name: 'Bear Marubozu',     bias: 'PUT',     weight: 3 });
  if (c1 < o1 && c > o && c >= o1 && o <= c1)                               patterns.push({ name: 'Bull Engulfing',    bias: 'CALL',    weight: 5 });
  if (c1 > o1 && c < o && c <= o1 && o >= c1)                               patterns.push({ name: 'Bear Engulfing',    bias: 'PUT',     weight: 5 });
  if (c1 > o1 && body < body1 * 0.3 && c > c1 - body1 && c < c1)           patterns.push({ name: 'Bear Harami',       bias: 'PUT',     weight: 2 });
  if (c1 < o1 && body < body1 * 0.3 && c < c1 + body1 && c > c1)           patterns.push({ name: 'Bull Harami',       bias: 'CALL',    weight: 2 });
  if (Math.abs(h - h1) < range * 0.05 && c1 > o1 && c < o)                 patterns.push({ name: 'Tweezer Top',       bias: 'PUT',     weight: 3 });
  if (Math.abs(l - l1) < range * 0.05 && c1 < o1 && c > o)                 patterns.push({ name: 'Tweezer Bottom',    bias: 'CALL',    weight: 3 });
  if (c > o && c1 > o1 && c2 > o2)                                          patterns.push({ name: '3 Bull Candles',    bias: 'CALL',    weight: 2 });
  if (c < o && c1 < o1 && c2 < o2)                                          patterns.push({ name: '3 Bear Candles',    bias: 'PUT',     weight: 2 });
  return patterns;
}

// ── RSI Divergence ─────────────────────────────────────────────
function detectDivergence(closes, rsiSeries, lookback = 20) {
  if (!rsiSeries || rsiSeries.length < lookback || closes.length < lookback)
    return { type: 'NONE', strength: 0, weight: 0 };
  const ps = closes.slice(-lookback), rs = rsiSeries.slice(-lookback), n = ps.length - 1;
  let pLowIdx = 0, pHighIdx = 0;
  for (let i = 1; i < n - 1; i++) {
    if (ps[i] < ps[pLowIdx])  pLowIdx  = i;
    if (ps[i] > ps[pHighIdx]) pHighIdx = i;
  }
  const cp = ps[n], cr = rs[n];
  const lp = ps[pLowIdx], lr = rs[pLowIdx];
  const hp = ps[pHighIdx], hr = rs[pHighIdx];
  if (cp < lp && cr > lr + 3 && cr < 48) return { type: 'BULLISH_DIV', strength: parseFloat(Math.abs(cr-lr).toFixed(1)), bias: 'CALL', weight: 7 };
  if (cp > hp && cr < hr - 3 && cr > 52) return { type: 'BEARISH_DIV', strength: parseFloat(Math.abs(hr-cr).toFixed(1)), bias: 'PUT',  weight: 7 };
  if (cp > lp * 1.001 && cr < lr - 3 && cr < 50) return { type: 'HIDDEN_BULL', strength: 4, bias: 'CALL', weight: 4 };
  if (cp < hp * 0.999 && cr > hr + 3 && cr > 50) return { type: 'HIDDEN_BEAR', strength: 4, bias: 'PUT',  weight: 4 };
  return { type: 'NONE', strength: 0, weight: 0 };
}

// ── Support & Resistance ───────────────────────────────────────
function findSR(highs, lows, closes, lookback = 40) {
  const levels = [], n = Math.min(lookback, closes.length);
  const rh = highs.slice(-n), rl = lows.slice(-n);
  const threshold = closes[closes.length - 1] * 0.0015;
  for (let i = 2; i < rh.length - 2; i++) {
    if (rh[i] > rh[i-1] && rh[i] > rh[i-2] && rh[i] > rh[i+1] && rh[i] > rh[i+2]) levels.push({ price: rh[i], type: 'resistance', strength: 1 });
  }
  for (let i = 2; i < rl.length - 2; i++) {
    if (rl[i] < rl[i-1] && rl[i] < rl[i-2] && rl[i] < rl[i+1] && rl[i] < rl[i+2]) levels.push({ price: rl[i], type: 'support', strength: 1 });
  }
  const merged = [];
  for (const lvl of levels) {
    const ex = merged.find(m => Math.abs(m.price - lvl.price) < threshold);
    if (ex) ex.strength++; else merged.push({ ...lvl });
  }
  return merged.sort((a, b) => b.strength - a.strength).slice(0, 10);
}

function getNearestSR(price, levels, pct = 0.002) {
  for (const lvl of levels) {
    if (Math.abs(price - lvl.price) / price <= pct) return lvl;
  }
  return null;
}

// ── Volume — tick volume for forex, weighted lower ─────────────
function analyzeVolume(volumes, closes) {
  if (!volumes || volumes.length < 10 || volumes.every(v => v === 0))
    return { trend: 'UNKNOWN', score: 0, volRatio: 1 };
  let obv = 0;
  const obvSeries = [];
  for (let i = 1; i < Math.min(volumes.length, closes.length); i++) {
    if (closes[i] > closes[i-1]) obv += volumes[i];
    else if (closes[i] < closes[i-1]) obv -= volumes[i];
    obvSeries.push(obv);
  }
  const recent5  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avg20    = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ratio    = avg20 > 0 ? recent5 / avg20 : 1;
  const obvTrend = obvSeries.length > 5 ? (obvSeries[obvSeries.length-1] > obvSeries[obvSeries.length-5] ? 'UP' : 'DOWN') : 'FLAT';
  let score = 0, trend = 'NEUTRAL';
  if      (ratio > 1.4 && obvTrend === 'UP')   { score =  2; trend = 'TICK_BULL_SURGE'; }
  else if (ratio > 1.2 && obvTrend === 'UP')   { score =  1; trend = 'TICK_BULLISH';    }
  else if (ratio > 1.4 && obvTrend === 'DOWN') { score = -2; trend = 'TICK_BEAR_SURGE'; }
  else if (ratio > 1.2 && obvTrend === 'DOWN') { score = -1; trend = 'TICK_BEARISH';    }
  return { trend, volRatio: parseFloat(ratio.toFixed(2)), score };
}

// ── HTF Bias — 5 indicators, no unused variables ──────────────
function getHTFBias(htfData) {
  if (!htfData || !htfData.closes || htfData.closes.length < 26)
    return { bias: 'NEUTRAL', weight: 0 };
  const { highs, lows, closes } = htfData;
  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi   = calcRSI(closes);
  const macd  = calcMACD(closes);
  const adx   = highs ? calcADX(highs, lows, closes) : { plusDI: 25, minusDI: 25 };
  const stoch = highs ? calcStochastic(highs, lows, closes) : { k: 50 };
  if (!ema9 || !ema21) return { bias: 'NEUTRAL', weight: 0 };
  let bull = 0, bear = 0;
  if (ema9 > ema21 * 1.0001)           bull += 2; else if (ema9 < ema21 * 0.9999)           bear += 2;
  if (rsi > 55)                        bull += 1; else if (rsi < 45)                        bear += 1;
  if (macd.histogram > 0)              bull += 1; else if (macd.histogram < 0)              bear += 1;
  if (adx.plusDI > adx.minusDI + 3)   bull += 1; else if (adx.minusDI > adx.plusDI + 3)   bear += 1;
  if (stoch.k < 40)                    bull += 1; else if (stoch.k > 60)                    bear += 1;
  if (bull >= bear + 3) return { bias: 'BULLISH', weight: 3 };
  if (bear >= bull + 3) return { bias: 'BEARISH', weight: 3 };
  if (bull >  bear)     return { bias: 'BULLISH', weight: 2 };
  if (bear >  bull)     return { bias: 'BEARISH', weight: 2 };
  return { bias: 'NEUTRAL', weight: 0 };
}

// ── Session quality — FIXED non-overlapping windows ───────────
function getSessionQuality() {
  const now = new Date();
  const h = now.getUTCHours(), m = now.getUTCMinutes(), d = now.getUTCDay();
  const min = h * 60 + m;
  // Weekday sessions (non-overlapping, ordered by priority)
  if (d >= 1 && d <= 5) {
    if (min >= 13*60 && min < 17*60) return { label: 'London/NY Overlap', multiplier: 1.10 }; // 13:00-17:00 UTC
    if (min >= 8*60  && min < 10*60) return { label: 'London Open',        multiplier: 1.05 }; // 08:00-10:00 UTC (FIXED — was shadowed)
    if (min >= 17*60 && min < 19*60) return { label: 'NY Session',         multiplier: 1.03 }; // 17:00-19:00 UTC
    if (min >= 0     && min < 8*60)  return { label: 'Asian Session',       multiplier: 0.95 }; // 00:00-08:00 UTC
    if (min >= 19*60 && min < 24*60) return { label: 'Late NY/OTC',         multiplier: 0.98 }; // 19:00-24:00 UTC
  }
  if (d === 0 || d === 6) return { label: 'Weekend OTC', multiplier: 0.90 };
  return { label: 'Regular Hours', multiplier: 1.00 };
}

// ═══════════════════════════════════════════════════════════════
// MAIN SIGNAL ANALYZER v7.0
// 14 independent indicators — fresh votes every scan
// Entry rules: confluence voting with minimum separation
// Exit: Binary expiry aligned to selected timeframe
// ═══════════════════════════════════════════════════════════════
function analyzeSignal(priceData, pair, htfData = null) {
  const { opens, highs, lows, closes, volumes } = priceData;
  if (!closes || closes.length < 20) return null;

  const price      = closes[closes.length - 1];
  const rsi        = calcRSI(closes);
  const rsiSeries  = calcRSISeries(closes);
  const macd       = calcMACD(closes);
  const stoch      = calcStochastic(highs, lows, closes);
  const bb         = calcBollingerBands(closes);
  const adx        = calcADX(highs, lows, closes);
  const atr        = calcATRWilder(highs, lows, closes);
  const cci        = calcCCI(highs, lows, closes);
  const superTrend = calcSuperTrend(highs, lows, closes);
  const srLevels   = findSR(highs, lows, closes);
  const nearSR     = getNearestSR(price, srLevels);
  const volData    = analyzeVolume(volumes, closes);
  const htfBias    = getHTFBias(htfData);
  const divergence = detectDivergence(closes, rsiSeries);
  const patterns   = detectPatterns(opens, closes, highs, lows);
  const session    = getSessionQuality();
  const ema9       = calcEMA(closes, 9);
  const ema21      = calcEMA(closes, 21);
  const ema50      = closes.length >= 52 ? calcEMA(closes, 50) : null;

  let callVotes = 0, putVotes = 0;
  const reasons = [], warnings = [];

  // ── 1. RSI DIVERGENCE ─────────────────────────────────────────
  if      (divergence.type === 'BULLISH_DIV') { callVotes += divergence.weight; reasons.push(`RSI Bullish Divergence [+${divergence.weight}]`); }
  else if (divergence.type === 'BEARISH_DIV') { putVotes  += divergence.weight; reasons.push(`RSI Bearish Divergence [+${divergence.weight}]`); }
  else if (divergence.type === 'HIDDEN_BULL') { callVotes += 4; reasons.push(`Hidden Bull Divergence [+4]`); }
  else if (divergence.type === 'HIDDEN_BEAR') { putVotes  += 4; reasons.push(`Hidden Bear Divergence [+4]`); }

  // ── 2. RSI ────────────────────────────────────────────────────
  if      (rsi <= 20) { callVotes += 5; reasons.push(`RSI extreme oversold (${rsi}) [+5]`); }
  else if (rsi <= 30) { callVotes += 4; reasons.push(`RSI oversold (${rsi}) [+4]`); }
  else if (rsi <= 38) { callVotes += 2; reasons.push(`RSI near oversold (${rsi}) [+2]`); }
  else if (rsi >= 80) { putVotes  += 5; reasons.push(`RSI extreme overbought (${rsi}) [+5]`); }
  else if (rsi >= 70) { putVotes  += 4; reasons.push(`RSI overbought (${rsi}) [+4]`); }
  else if (rsi >= 62) { putVotes  += 2; reasons.push(`RSI near overbought (${rsi}) [+2]`); }
  else                { warnings.push(`RSI neutral (${rsi})`); }

  // ── 3. MACD ───────────────────────────────────────────────────
  if      (macd.histogram > 0 && macd.macd > 0) { callVotes += 3; reasons.push(`MACD bullish alignment [+3]`); }
  else if (macd.histogram > 0)                   { callVotes += 2; reasons.push(`MACD histogram turning up [+2]`); }
  else if (macd.histogram < 0 && macd.macd < 0)  { putVotes  += 3; reasons.push(`MACD bearish alignment [+3]`); }
  else if (macd.histogram < 0)                   { putVotes  += 2; reasons.push(`MACD histogram turning down [+2]`); }
  // MACD histogram crossover bonus
  if (macd.prevHistogram < 0 && macd.histogram > 0) { callVotes += 2; reasons.push(`MACD histogram crossed up [+2]`); }
  if (macd.prevHistogram > 0 && macd.histogram < 0) { putVotes  += 2; reasons.push(`MACD histogram crossed down [+2]`); }

  // ── 4. STOCHASTIC ────────────────────────────────────────────
  if      (stoch.k <= 10) { callVotes += 5; reasons.push(`Stoch deeply oversold K=${stoch.k.toFixed(0)} [+5]`); }
  else if (stoch.k <= 20) { callVotes += 4; reasons.push(`Stoch oversold K=${stoch.k.toFixed(0)} D=${stoch.d.toFixed(0)} [+4]`); }
  else if (stoch.k <= 35) { callVotes += 2; reasons.push(`Stoch low zone K=${stoch.k.toFixed(0)} [+2]`); }
  else if (stoch.k >= 90) { putVotes  += 5; reasons.push(`Stoch deeply overbought K=${stoch.k.toFixed(0)} [+5]`); }
  else if (stoch.k >= 80) { putVotes  += 4; reasons.push(`Stoch overbought K=${stoch.k.toFixed(0)} D=${stoch.d.toFixed(0)} [+4]`); }
  else if (stoch.k >= 65) { putVotes  += 2; reasons.push(`Stoch high zone K=${stoch.k.toFixed(0)} [+2]`); }
  if (stoch.crossUp   && stoch.k < 30) { callVotes += 3; reasons.push(`Stoch K crossed D in oversold [+3]`); }
  if (stoch.crossDown && stoch.k > 70) { putVotes  += 3; reasons.push(`Stoch K crossed D in overbought [+3]`); }

  // ── 5. BOLLINGER BANDS ───────────────────────────────────────
  if (bb) {
    if      (price <= bb.lower * 1.0002) { callVotes += 4; reasons.push(`Price at lower BB — CALL [+4]`); }
    else if (bb.pct < 0.10)              { callVotes += 2; reasons.push(`Price near lower BB ${(bb.pct*100).toFixed(0)}% [+2]`); }
    else if (price >= bb.upper * 0.9998) { putVotes  += 4; reasons.push(`Price at upper BB — PUT [+4]`); }
    else if (bb.pct > 0.90)              { putVotes  += 2; reasons.push(`Price near upper BB ${(bb.pct*100).toFixed(0)}% [+2]`); }
    if (bb.width < 0.003) warnings.push(`BB squeeze — breakout imminent`);
    if (bb.width > 0.015) warnings.push(`BB wide — high volatility`);
  }

  // ── 6. SUPERTREND (Wilder ATR) ───────────────────────────────
  if      (superTrend.direction ===  1) { callVotes += 3; reasons.push(`SuperTrend BULLISH [+3]`); }
  else if (superTrend.direction === -1) { putVotes  += 3; reasons.push(`SuperTrend BEARISH [+3]`); }

  // ── 7. CCI ───────────────────────────────────────────────────
  if      (cci <= -200) { callVotes += 5; reasons.push(`CCI extreme oversold (${cci.toFixed(0)}) [+5]`); }
  else if (cci <= -100) { callVotes += 3; reasons.push(`CCI oversold (${cci.toFixed(0)}) [+3]`); }
  else if (cci >=  200) { putVotes  += 5; reasons.push(`CCI extreme overbought (${cci.toFixed(0)}) [+5]`); }
  else if (cci >=  100) { putVotes  += 3; reasons.push(`CCI overbought (${cci.toFixed(0)}) [+3]`); }

  // ── 8. EMA STRUCTURE ─────────────────────────────────────────
  if (ema9 && ema21) {
    const spread = Math.abs(ema9 - ema21) / price;
    if      (ema9 > ema21 * 1.0002) { callVotes += spread > 0.001 ? 2 : 1; reasons.push(`EMA9 > EMA21 bullish [+${spread > 0.001 ? 2 : 1}]`); }
    else if (ema9 < ema21 * 0.9998) { putVotes  += spread > 0.001 ? 2 : 1; reasons.push(`EMA9 < EMA21 bearish [+${spread > 0.001 ? 2 : 1}]`); }
  }
  if (ema50) {
    if      (price > ema50 * 1.001) { callVotes += 1; reasons.push(`Above EMA50 [+1]`); }
    else if (price < ema50 * 0.999) { putVotes  += 1; reasons.push(`Below EMA50 [+1]`); }
  }

  // ── 9. ADX ───────────────────────────────────────────────────
  if (adx.adx < 15) {
    warnings.push(`ADX ${adx.adx.toFixed(0)} — choppy, lower reliability`);
    callVotes *= 0.85; putVotes *= 0.85;
  } else if (adx.adx >= 25) {
    if      (adx.plusDI > adx.minusDI + 5) { callVotes += 2; reasons.push(`ADX ${adx.adx.toFixed(0)} +DI leads [+2]`); }
    else if (adx.minusDI > adx.plusDI + 5) { putVotes  += 2; reasons.push(`ADX ${adx.adx.toFixed(0)} -DI leads [+2]`); }
  }

  // ── 10. SUPPORT / RESISTANCE ─────────────────────────────────
  if (nearSR) {
    if      (nearSR.type === 'support'    && nearSR.strength >= 2) { callVotes += 3; reasons.push(`Strong support ${nearSR.strength}x — bounce CALL [+3]`); }
    else if (nearSR.type === 'support')                            { callVotes += 2; reasons.push(`Support — bounce CALL [+2]`); }
    else if (nearSR.type === 'resistance' && nearSR.strength >= 2) { putVotes  += 3; reasons.push(`Strong resistance ${nearSR.strength}x — PUT [+3]`); }
    else if (nearSR.type === 'resistance')                         { putVotes  += 2; reasons.push(`Resistance — PUT [+2]`); }
  }

  // ── 11. HTF BIAS ─────────────────────────────────────────────
  if      (htfBias.bias === 'BULLISH') { callVotes += htfBias.weight; reasons.push(`HTF BULLISH [+${htfBias.weight}]`); }
  else if (htfBias.bias === 'BEARISH') { putVotes  += htfBias.weight; reasons.push(`HTF BEARISH [+${htfBias.weight}]`); }
  else                                 { warnings.push(`HTF neutral — no higher TF confirmation`); }

  // ── 12. VOLUME ───────────────────────────────────────────────
  if (volData.score !== 0 && volData.trend !== 'UNKNOWN') {
    if (volData.score > 0) { callVotes += volData.score; reasons.push(`Tick vol ${volData.trend} [+${volData.score}]`); }
    else                   { putVotes  += Math.abs(volData.score); reasons.push(`Tick vol ${volData.trend} [+${Math.abs(volData.score)}]`); }
  }

  // ── 13. CANDLE PATTERNS ──────────────────────────────────────
  for (const p of patterns) {
    if      (p.bias === 'CALL' && p.weight > 0) { callVotes += p.weight; reasons.push(`${p.name} → CALL [+${p.weight}]`); }
    else if (p.bias === 'PUT'  && p.weight > 0) { putVotes  += p.weight; reasons.push(`${p.name} → PUT [+${p.weight}]`); }
    else if (p.bias === 'NEUTRAL')              { warnings.push(`${p.name} — indecision`); }
  }

  // ── 14. PRICE MOMENTUM ───────────────────────────────────────
  if (closes.length >= 4) {
    const mom = closes[closes.length-1] - closes[closes.length-4];
    if (Math.abs(mom) / price > 0.001) {
      if      (mom > 0) { callVotes += 1; reasons.push(`Bullish momentum [+1]`); }
      else if (mom < 0) { putVotes  += 1; reasons.push(`Bearish momentum [+1]`); }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DECISION ENGINE
  // Entry rules: Min 12 total votes, Min 6 separation, Min 4 reasons
  // Exit: Binary option expiry = selected timeframe candle
  // ═══════════════════════════════════════════════════════════════
  const totalVotes = callVotes + putVotes;
  if (totalVotes < 12) return { noSignal: true, reason: `Low confluence (${totalVotes.toFixed(0)}/12)`, callVotes: callVotes.toFixed(1), putVotes: putVotes.toFixed(1) };

  const direction  = callVotes >= putVotes ? 'CALL' : 'PUT';
  const winVotes   = Math.max(callVotes, putVotes);
  const loseVotes  = Math.min(callVotes, putVotes);
  const separation = winVotes - loseVotes;

  if (separation < 6) return { noSignal: true, reason: `Signals conflict (gap ${separation.toFixed(1)}/6)`, callVotes: callVotes.toFixed(1), putVotes: putVotes.toFixed(1) };
  if (reasons.length < 4) return { noSignal: true, reason: `Too few confirmations (${reasons.length}/4)`, callVotes: callVotes.toFixed(1), putVotes: putVotes.toFixed(1) };

  // Confidence
  let confidence = Math.round((winVotes / totalVotes) * 100);
  confidence -= warnings.length * 3;
  if (divergence.type !== 'NONE') confidence += 5;
  if (patterns.find(p => p.weight >= 4 && p.bias === direction)) confidence += 3;
  if ((direction === 'CALL' && htfBias.bias === 'BULLISH') || (direction === 'PUT' && htfBias.bias === 'BEARISH')) confidence += 4;
  if (adx.adx > 30) confidence += 2;
  if (superTrend.direction === (direction === 'CALL' ? 1 : -1)) confidence += 3;
  else if (superTrend.direction !== 0)                          confidence -= 6; // opposing SuperTrend penalty
  if (Math.abs(cci) >= 100) confidence += 2;
  if ((direction === 'CALL' && bb && price <= bb.lower * 1.0005) || (direction === 'PUT' && bb && price >= bb.upper * 0.9995)) confidence += 3;
  if ((direction === 'CALL' && volData.score > 0) || (direction === 'PUT' && volData.score < 0)) confidence += 1;
  confidence = Math.round(confidence * session.multiplier);
  confidence = Math.min(Math.max(confidence, 60), 96);

  if (confidence < 68) return { noSignal: true, reason: `Confidence ${confidence}% below 68% threshold`, callVotes: callVotes.toFixed(1), putVotes: putVotes.toFixed(1) };

  return {
    direction,  confidence,
    symbol:     pair.symbol,  payout:    pair.payout,  cat:       pair.cat,
    entryPrice: price,
    rsi:        rsi.toFixed(1),           macd:       macd.macd.toFixed(6),
    macdHist:   macd.histogram.toFixed(6), stochK:    stoch.k.toFixed(1),
    stochD:     stoch.d.toFixed(1),        cci:       cci.toFixed(1),
    superTrend: superTrend.direction === 1 ? 'BULL' : superTrend.direction === -1 ? 'BEAR' : 'NONE',
    adx:        adx.adx.toFixed(1),        plusDI:    adx.plusDI.toFixed(1),
    minusDI:    adx.minusDI.toFixed(1),    ema9:      ema9  ? ema9.toFixed(5)  : 'N/A',
    ema21:      ema21 ? ema21.toFixed(5) : 'N/A',     ema50: ema50 ? ema50.toFixed(5) : 'N/A',
    atr:        atr.toFixed(6),            bbUpper:   bb ? bb.upper.toFixed(5) : 'N/A',
    bbLower:    bb ? bb.lower.toFixed(5) : 'N/A',     bbWidth: bb ? (bb.width*100).toFixed(2) : 'N/A',
    htfBias:    htfBias.bias,    divergence: divergence.type,
    volume:     volData.trend,   session:    session.label,
    srLevels:   srLevels.length, patterns:   patterns.map(p => p.name),
    callVotes:  parseFloat(callVotes.toFixed(1)),  putVotes:   parseFloat(putVotes.toFixed(1)),
    separation: parseFloat(separation.toFixed(1)), totalVotes: parseFloat(totalVotes.toFixed(1)),
    reasons:    reasons.slice(0, 8),  warnings: warnings.slice(0, 4),
    indicators: `${reasons.length} signals confirmed`
  };
}

// ═══════════════════════════════════════════════════════════════
// PROFESSIONAL BACKTESTER v7.0
// Entry rules: same as live analyzeSignal (confidence >= 68)
// Exit rule: binary option closes at end of next candle
// Metrics: Win rate, Profit Factor, Sharpe Ratio,
//          Max Drawdown, Expectancy per trade
// Validity: Loops until bars exhausted, flags low sample count
// ═══════════════════════════════════════════════════════════════
function backtest(priceData, pair, minTrades = 50) {
  const { opens, highs, lows, closes, volumes } = priceData;
  if (!closes || closes.length < 60) return null;

  let wins = 0, losses = 0, skipped = 0;
  const trades  = [];
  const returns = [];
  let equity = 100, peak = 100, maxDrawdown = 0;
  const minWindow = 35;

  // Loop until bars exhausted — no arbitrary cap (FIXED P12)
  for (let i = minWindow; i < closes.length - 3; i++) {
    const slice = {
      opens:   opens?.slice(0, i)   || [],
      highs:   highs.slice(0, i),
      lows:    lows.slice(0, i),
      closes:  closes.slice(0, i),
      volumes: volumes?.slice(0, i) || []
    };
    const sig = analyzeSignal(slice, pair, null);
    if (!sig || sig.noSignal || sig.confidence < 68) { skipped++; continue; }

    // Entry: next candle close (realistic — accounts for signal lag)
    const entry = closes[i + 1];
    const exit1 = closes[Math.min(i + 2, closes.length - 1)];
    const won   = sig.direction === 'CALL' ? exit1 > entry : exit1 < entry;

    const pnl = won ? (pair.payout / 100) : -1;
    equity += pnl;
    returns.push(pnl);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);

    if (won) wins++; else losses++;
    trades.push({ dir: sig.direction, conf: sig.confidence, won, pnl });
  }

  const total = wins + losses;
  if (total < 10) return null;

  const winRate      = Math.round((wins / total) * 100);
  const grossWin     = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss    = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? 99 : 0);
  const totalPnl     = returns.reduce((a, b) => a + b, 0);
  const avgReturn    = totalPnl / total;
  const stdReturn    = Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / total);
  const sharpe       = stdReturn > 0 ? parseFloat((avgReturn / stdReturn).toFixed(2)) : 0;
  const expectancy   = parseFloat(avgReturn.toFixed(4));
  const avgConf      = Math.round(trades.reduce((a, b) => a + b.conf, 0) / trades.length);

  let maxWin = 0, curWin = 0, maxLoss = 0, curLoss = 0;
  for (const t of trades) {
    if (t.won) { curWin++;  maxWin  = Math.max(maxWin, curWin);  curLoss = 0; }
    else       { curLoss++; maxLoss = Math.max(maxLoss, curLoss); curWin  = 0; }
  }

  let gs = 0;
  if (winRate >= 65) gs += 2; else if (winRate >= 58) gs += 1;
  if (profitFactor >= 1.5) gs += 2; else if (profitFactor >= 1.2) gs += 1;
  if (sharpe >= 0.5) gs += 1;
  if (maxDrawdown <= 15) gs += 1;
  const grade = gs >= 5 ? 'A+' : gs >= 4 ? 'A' : gs >= 3 ? 'B' : gs >= 2 ? 'C' : 'D';

  log.info(`Backtest ${pair.symbol}: ${total} trades, WR=${winRate}%, PF=${profitFactor}, Sharpe=${sharpe}`);

  return {
    pair: pair.symbol,  cat: pair.cat,
    total, wins, losses, skipped,
    winRate, profitFactor, sharpe, expectancy,
    maxDrawdown:   parseFloat(maxDrawdown.toFixed(1)),
    totalPnl:      parseFloat(totalPnl.toFixed(2)),
    avgConf,
    maxWinStreak:  maxWin,
    maxLossStreak: maxLoss,
    grade,
    valid: total >= minTrades ? 'VALID' : `LOW_SAMPLE(${total}/${minTrades})`
  };
}

module.exports = { analyzeSignal, backtest };

