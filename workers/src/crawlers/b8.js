// B8 — StockTwits sentiment crawler
// Token: STOCKTWITS_TOKEN env secret (__ssid cookie value)
// Scoring: bullish ratio from tagged messages
// Runs: 9:30 AM ET cron
// Writes: band_scores (band='b8')

import { query, batch } from '../db.js';

const ST_BASE = 'https://stocktwits.com';
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 300;

export async function runB8(env) {
  const tickers = await query(env, 'SELECT ticker FROM tickers WHERE is_active = 1');
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  let scored = 0, failed = 0;

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const chunk = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      chunk.map(({ ticker }) => fetchSentiment(ticker, env))
    );

    const writes = [];
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status !== 'fulfilled' || r.value === null) { failed++; continue; }
      const { ticker } = chunk[j];
      scored++;
      writes.push([
        `INSERT OR REPLACE INTO band_scores (ticker, score_date, band, raw_score, weighted_score, updated_at)
         VALUES (?, ?, 'b8', ?, ?, ?)`,
        [ticker, today, r.value, r.value, now],
      ]);
    }

    if (writes.length > 0) await batch(env, writes);
    if (i + BATCH_SIZE < tickers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return { band: 'b8', scored, failed };
}

async function fetchSentiment(ticker, env) {
  const resp = await fetch(
    `${ST_BASE}/api/2/streams/symbol.json?symbol=${ticker}&limit=30`,
    {
      headers: {
        Cookie: `__ssid=${env.STOCKTWITS_TOKEN}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      },
    }
  );

  if (!resp.ok) {
    if (resp.status === 401) throw new Error('StockTwits token expired');
    return null;
  }

  const data = await resp.json();
  const messages = data.messages || [];
  if (!messages.length) return 0.5; // neutral if no data

  let bullish = 0, bearish = 0;
  for (const msg of messages) {
    const sentiment = msg.entities?.sentiment?.basic;
    if (sentiment === 'Bullish') bullish++;
    else if (sentiment === 'Bearish') bearish++;
  }

  const total = bullish + bearish;
  return total === 0 ? 0.5 : bullish / total;
}
