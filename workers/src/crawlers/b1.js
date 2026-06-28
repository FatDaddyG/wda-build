// B1 — Price/Momentum crawler
// Data: Yahoo Finance v8 (free, no auth required)
// Scoring: 20-day momentum (50%) + RSI-14 (30%) + volume ratio (20%)
// Runs: 9:30 AM ET cron
// Writes: band_scores (band='b1')

import { query, batch } from '../db.js';

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 500;

async function fetchPriceHistory(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return null;
  const data = await resp.json();
  const chart = data.chart?.result?.[0];
  if (!chart) return null;
  const closes = chart.indicators?.quote?.[0]?.close || [];
  const volumes = chart.indicators?.quote?.[0]?.volume || [];
  return closes
    .map((c, i) => ({ close: c, volume: volumes[i] || 0 }))
    .filter(d => d.close !== null);
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function scoreFromHistory(history) {
  if (history.length < 5) return null;
  const closes = history.map(d => d.close);
  const volumes = history.map(d => d.volume);
  const n = closes.length;

  const lookback = Math.min(20, n - 1);
  const momentum = (closes[n - 1] - closes[n - 1 - lookback]) / closes[n - 1 - lookback];
  const momentumScore = Math.min(Math.max((momentum + 0.2) / 0.4, 0), 1);

  const rsiScore = calcRSI(closes) / 100;

  const avgVol = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / Math.min(10, n - 1);
  const volRatio = avgVol > 0 ? volumes[n - 1] / avgVol : 1;
  const volScore = Math.min(volRatio / 2, 1);

  return momentumScore * 0.5 + rsiScore * 0.3 + volScore * 0.2;
}

export async function runB1(env) {
  const tickers = await query(env, 'SELECT ticker FROM tickers WHERE is_active = 1');
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  let scored = 0, failed = 0;

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const chunk = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      chunk.map(async ({ ticker }) => {
        const history = await fetchPriceHistory(ticker);
        if (!history) return null;
        const score = scoreFromHistory(history);
        return score !== null ? [ticker, score] : null;
      })
    );

    const writes = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    failed += chunk.length - writes.length;
    scored += writes.length;

    if (writes.length > 0) {
      await batch(env, writes.map(([ticker, score]) => [
        `INSERT OR REPLACE INTO band_scores (ticker, score_date, band, raw_score, weighted_score, updated_at)
         VALUES (?, ?, 'b1', ?, ?, ?)`,
        [ticker, today, score, score, now],
      ]));
    }

    if (i + BATCH_SIZE < tickers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return { band: 'b1', scored, failed };
}
