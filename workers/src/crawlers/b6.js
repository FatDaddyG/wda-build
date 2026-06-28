// B6 — Discord social sentiment crawler
// Token: DISCORD_TOKEN env secret (captured user/bot token)
// Channel: InTheMoney Discord general — channel_id 1419437686388691045
// Runs: 9:30 AM ET cron
// Writes: band_scores (band='b6')

import { query, batch } from '../db.js';

const CHANNEL_ID = '1419437686388691045';
const DISCORD_API = 'https://discord.com/api/v10';
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_BATCHES = 10;

const BULL_PATTERN = /bullish|long|buy|calls?\b|moon|rocket|🚀|🐂/i;
const BEAR_PATTERN = /bearish|short|puts?\b|dump|crash|⬇️|🐻/i;
const TICKER_PATTERN = /\$([A-Z]{1,5})\b/g;

export async function runB6(env) {
  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const messages = await fetchMessages(env, since);
  if (!messages) return { band: 'b6', scored: 0, error: 'fetch_failed' };

  const tickers = await query(env, 'SELECT ticker FROM tickers WHERE is_active = 1');
  const tickerSet = new Set(tickers.map(t => t.ticker));

  const mentionMap = buildMentionMap(messages, tickerSet);
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  const writes = [];
  for (const [ticker, stats] of Object.entries(mentionMap)) {
    const score = calcScore(stats);
    if (score === null) continue;
    writes.push([
      `INSERT OR REPLACE INTO band_scores (ticker, score_date, band, raw_score, weighted_score, updated_at)
       VALUES (?, ?, 'b6', ?, ?, ?)`,
      [ticker, today, score, score, now],
    ]);
  }

  if (writes.length > 0) await batch(env, writes);
  return { band: 'b6', scored: writes.length, messages_scanned: messages.length };
}

async function fetchMessages(env, since) {
  const messages = [];
  let lastId = null;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const params = new URLSearchParams({ limit: 100 });
    if (lastId) params.set('before', lastId);

    const resp = await fetch(`${DISCORD_API}/channels/${CHANNEL_ID}/messages?${params}`, {
      headers: { Authorization: env.DISCORD_TOKEN },
    });

    if (!resp.ok) {
      if (resp.status === 401) throw new Error('Discord token expired');
      return null;
    }

    const batch = await resp.json();
    if (!batch.length) break;

    const cutoff = new Date(since);
    const valid = batch.filter(m => new Date(m.timestamp) >= cutoff);
    messages.push(...valid);

    if (valid.length < batch.length) break;
    lastId = batch[batch.length - 1].id;
  }

  return messages;
}

function buildMentionMap(messages, tickerSet) {
  const map = {};
  for (const msg of messages) {
    const text = msg.content || '';
    const matches = [...text.matchAll(TICKER_PATTERN)];
    if (!matches.length) continue;

    const sentiment = BULL_PATTERN.test(text) ? 1 : BEAR_PATTERN.test(text) ? -1 : 0;
    for (const [, ticker] of matches) {
      if (!tickerSet.has(ticker)) continue;
      if (!map[ticker]) map[ticker] = { mentions: 0, bullish: 0, bearish: 0 };
      map[ticker].mentions++;
      if (sentiment > 0) map[ticker].bullish++;
      if (sentiment < 0) map[ticker].bearish++;
    }
  }
  return map;
}

function calcScore({ mentions, bullish, bearish }) {
  if (mentions < 2) return null;
  const sentimentRatio = (bullish - bearish) / mentions; // -1 to +1
  const base = (sentimentRatio + 1) / 2;                 // 0 to 1
  const volumeBoost = Math.min(mentions / 20, 1) * 0.1;
  return Math.min(base + volumeBoost, 1);
}
