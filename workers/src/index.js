import { runB1 } from './crawlers/b1.js';
import { runB6 } from './crawlers/b6.js';
import { runB8 } from './crawlers/b8.js';
import { runB10 } from './crawlers/b10.js';
import { query, batch, execute } from './db.js';
import { compositeScore, signalFlag, loadBandConfig } from './scoring.js';
import { handleMCP } from './mcp.js';

const FRANKY_SYSTEM = `# DROPOUT — BC Signal Analyst

You are Franky, the DROPOUT signal analyst. You have live access to the AQE (Ape Quant Engine) signal data. The user is Curtis — a solo operator running a concentrated equity IRA + crypto brokerage on a sailboat.

## Voice

Declarative. No hedging. No softening. No SaaS filler ("I'd be happy to help", "Great question!"). Surface bad signals bluntly.

## Default behavior

- When a ticker is mentioned → reference its signal from the live data block automatically
- When discussing what to hold or buy → cross-reference current positions
- Lead with signal_flag (BUY / WATCH / HOLD / EXIT) and composite_score (0–1)
- Show band breakdown when score is surprising or contested
- EXIT signals are exits — say so plainly
- Keep responses tight. No padding.

## Signal flags

BUY ≥ 0.75 | WATCH 0.50–0.74 | HOLD 0.30–0.49 | EXIT < 0.30

## Bands

B1 = Yahoo Finance price/momentum | B6 = Discord social | B8 = StockTwits retail sentiment | B10 = EDGAR 13F institutional

## Regime context

MOMENTUM = B1 heavy | NEUTRAL = balanced | RISK_OFF = B10 heavy | MEAN_REVERSION = fade momentum`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event.cron, env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    switch (url.pathname) {
      case '/api/pulse':
        return Response.json(await getPulse(env), { headers: CORS });

      case '/api/scores':
        return Response.json(await getScores(env, url.searchParams.get('ticker')), { headers: CORS });

      case '/api/positions':
        return Response.json(await query(env, 'SELECT * FROM positions ORDER BY market_value DESC'), { headers: CORS });

      case '/api/regime':
        return Response.json(await getRegime(env), { headers: CORS });

      case '/api/chart':
        return Response.json(await getChart(env, url.searchParams.get('range') || 'YTD'), { headers: CORS });

      case '/api/chat':
        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        const chatBody = await request.json().catch(() => ({}));
        return Response.json(await frankyChat(env, chatBody), { headers: CORS });

      case '/api/crawl':
        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        const body = await request.json().catch(() => ({}));
        ctx.waitUntil(runCrawler(body.band || 'all', env));
        return Response.json({ ok: true, band: body.band || 'all', queued: true }, { headers: CORS });

      case '/mcp':
        return handleMCP(request, env);

      default:
        return new Response('DROPOUT Cloud', { status: 200 });
    }
  },
};

// ── Cron dispatch ──────────────────────────────────────────────────────────────

async function handleCron(cron, env) {
  const results = [];

  if (cron === '30 13 * * 1-5') {
    // 9:30 AM EDT — market open
    results.push(...await Promise.allSettled([runB1(env), runB6(env), runB8(env)])
      .then(rs => rs.map((r, i) => r.status === 'fulfilled' ? r.value : { band: ['b1','b6','b8'][i], error: r.reason?.message })));
  }

  if (cron === '0 16 * * 1-5') {
    // 12:00 PM EDT — midday
    results.push(await runB10(env).catch(e => ({ band: 'b10', error: e.message })));
  }

  if (cron === '15 20 * * 1-5') {
    // 4:15 PM EDT — full rescore
    results.push(await runFullRescore(env).catch(e => ({ rescore: 'failed', error: e.message })));
  }

  if (cron === '0 21 * * 1-5') {
    // 5:00 PM EDT — EOD position sync
    results.push(await syncPositions(env).catch(e => ({ positions: 'failed', error: e.message })));
  }

  await logCrawl(env, cron, results).catch(() => {});
  return results;
}

async function runCrawler(band, env) {
  const map = { b1: runB1, b6: runB6, b8: runB8, b10: runB10 };
  if (band === 'all') return handleCron('30 13 * * 1-5', env);
  return map[band] ? map[band](env) : { error: `Unknown band: ${band}` };
}

// ── 4:15 PM rescore ────────────────────────────────────────────────────────────

async function runFullRescore(env) {
  const [config, regimeRows, bandScores] = await Promise.all([
    loadBandConfig(env, query),
    query(env, 'SELECT regime FROM market_regime WHERE id = 1'),
    query(env, `SELECT ticker, band, raw_score FROM band_scores
                WHERE score_date = ? AND raw_score IS NOT NULL`,
      [new Date().toISOString().split('T')[0]]),
  ]);

  const regime = regimeRows[0]?.regime || 'DEFAULT';
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  const byTicker = {};
  for (const { ticker, band, raw_score } of bandScores) {
    if (!byTicker[ticker]) byTicker[ticker] = {};
    byTicker[ticker][band] = raw_score;
  }

  const writes = [];
  for (const [ticker, bands] of Object.entries(byTicker)) {
    const composite = compositeScore(bands, regime, config);
    writes.push([
      `INSERT OR REPLACE INTO signal_scores (ticker, score_date, composite_score, regime, signal_flag, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ticker, today, composite, regime, signalFlag(composite), now],
    ]);
  }

  if (writes.length > 0) await batch(env, writes);
  return { rescore: 'ok', tickers: writes.length, regime };
}

// ── EOD position sync ──────────────────────────────────────────────────────────
// Public.com API: get_portfolio only supports non-IRA (BROKERAGE) accounts.
// IRA equity positions are synced via the Mac EOD job → DropOut DB.
// This job syncs the brokerage account (crypto) to Turso.

async function syncPositions(env) {
  const BROKERAGE_ID = '5OR89258';
  const resp = await fetch(
    `https://trade-service.public.com/brokerage/account/${BROKERAGE_ID}/portfolio`,
    {
      headers: { Authorization: `Bearer ${env.PUBLIC_COM_TOKEN}` },
    }
  );

  if (!resp.ok) return { positions: 'failed', status: resp.status };

  const data = await resp.json();
  const positions = data.positions || [];
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  const writes = positions
    .filter(p => p.instrument?.symbol)
    .map(p => [
      `INSERT OR REPLACE INTO positions (ticker, account_id, shares, avg_cost, market_value, platform, updated_at)
       VALUES (?, ?, ?, ?, ?, 'public', ?)`,
      [
        p.instrument.symbol,
        BROKERAGE_ID,
        parseFloat(p.quantity),
        parseFloat(p.costBasis?.unitCost ?? 0),
        parseFloat(p.currentValue ?? 0),
        now,
      ],
    ]);

  if (writes.length > 0) await batch(env, writes);

  // Write daily portfolio snapshot for chart history
  const totalValue = positions
    .filter(p => p.instrument?.symbol)
    .reduce((sum, p) => sum + parseFloat(p.currentValue ?? 0), 0);

  if (totalValue > 0) {
    await execute(env,
      `CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        date TEXT PRIMARY KEY, total_value REAL, updated_at TEXT
      )`
    ).catch(() => {});
    await execute(env,
      `INSERT OR REPLACE INTO portfolio_snapshots (date, total_value, updated_at) VALUES (?, ?, ?)`,
      [today, totalValue, now]
    ).catch(() => {});
  }

  return { positions: 'ok', count: writes.length, snapshot_total: totalValue };
}

// ── API helpers ────────────────────────────────────────────────────────────────

async function getScores(env, ticker) {
  if (ticker) {
    const scores = await query(env,
      `SELECT ss.ticker, ss.score_date, ss.composite_score, ss.regime, ss.signal_flag,
              bs.band, bs.raw_score
       FROM signal_scores ss
       LEFT JOIN band_scores bs ON ss.ticker = bs.ticker AND ss.score_date = bs.score_date
       WHERE ss.ticker = ? ORDER BY ss.score_date DESC LIMIT 25`,
      [ticker.toUpperCase()]);
    return scores;
  }
  return query(env,
    `SELECT * FROM signal_scores
     WHERE score_date = (SELECT MAX(score_date) FROM signal_scores)
     ORDER BY composite_score DESC LIMIT 100`);
}

async function getRegime(env) {
  const [row] = await query(env, 'SELECT * FROM market_regime WHERE id = 1');
  return row || { regime: 'UNKNOWN' };
}

async function getPulse(env) {
  const crawls = await query(env,
    `SELECT band, MAX(crawl_time) as last_crawl, status, tickers_scored
     FROM crawl_log GROUP BY band ORDER BY band`);
  return { ok: true, crawls, ts: new Date().toISOString() };
}

async function logCrawl(env, cron, results) {
  const now = new Date().toISOString();
  const writes = results.map(r => [
    `INSERT INTO crawl_log (crawl_time, band, status, tickers_scored, detail)
     VALUES (?, ?, ?, ?, ?)`,
    [now, r.band || 'cron', r.error ? 'error' : 'ok', r.scored ?? r.tickers ?? 0,
     r.error || JSON.stringify(r)],
  ]);
  if (writes.length > 0) await batch(env, writes);
}

// ── Chart data ─────────────────────────────────────────────────────────────────

async function getChart(env, range) {
  const rangeMap = { '1D': '1d', '1W': '5d', '1M': '1mo', '3M': '3mo', '6M': '6mo', 'YTD': 'ytd', '1Y': '1y', 'ALL': '5y' };
  const yfRange = rangeMap[range] || 'ytd';
  const intraday = range === '1D';
  const interval = intraday ? '15m' : '1d';

  const [portfolioRows, spyData, qqqData, posRows] = await Promise.allSettled([
    query(env, 'SELECT date, total_value FROM portfolio_snapshots ORDER BY date ASC LIMIT 500').catch(() => []),
    fetchYahoo('SPY', interval, yfRange),
    fetchYahoo('QQQ', interval, yfRange),
    query(env, 'SELECT SUM(market_value) as total FROM positions').catch(() => []),
  ]);

  const portfolio = portfolioRows.status === 'fulfilled' ? portfolioRows.value : [];
  const spy = spyData.status === 'fulfilled' ? spyData.value : [];
  const qqq = qqqData.status === 'fulfilled' ? qqqData.value : [];
  const currentTotal = posRows.status === 'fulfilled' ? (posRows.value[0]?.total || 0) : 0;

  // Compute today's gain vs previous snapshot
  let todayGain = 0, todayPct = 0;
  if (portfolio.length >= 2 && currentTotal > 0) {
    const prev = portfolio[portfolio.length - 1].total_value;
    todayGain = currentTotal - prev;
    todayPct = prev > 0 ? (todayGain / prev) * 100 : 0;
  }

  return {
    portfolio: portfolio.map(r => ({ date: r.date, total: r.total_value })),
    indexes: { SPY: spy, QQQ: qqq },
    current_total: currentTotal,
    today_gain: todayGain,
    today_pct: todayPct,
  };
}

async function fetchYahoo(ticker, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return [];
  const data = await resp.json();
  const result = data.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const isIntraday = interval === '15m';
  return timestamps
    .map((t, i) => ({
      [isIntraday ? 't' : 'date']: isIntraday
        ? new Date(t * 1000).toISOString()
        : new Date(t * 1000).toISOString().split('T')[0],
      close: closes[i],
    }))
    .filter(p => p.close != null);
}

// ── Franky cloud chat ──────────────────────────────────────────────────────────

async function frankyChat(env, { message, history = [] }) {
  if (!message?.trim()) return { reply: 'No message.' };
  if (!env.CLAUDE_API_KEY) return { reply: 'CLAUDE_API_KEY not set in worker secrets.' };

  // Inject live signal context into system prompt
  const [scores, positions, regime] = await Promise.allSettled([
    query(env, `SELECT ticker, composite_score, signal_flag FROM signal_scores
                WHERE score_date = (SELECT MAX(score_date) FROM signal_scores)
                ORDER BY composite_score DESC LIMIT 60`).catch(() => []),
    query(env, 'SELECT ticker, shares, avg_cost, market_value FROM positions ORDER BY market_value DESC').catch(() => []),
    query(env, 'SELECT regime, updated_at FROM market_regime WHERE id = 1').catch(() => []),
  ]);

  const scoresVal = scores.status === 'fulfilled' ? scores.value : [];
  const posVal = positions.status === 'fulfilled' ? positions.value : [];
  const regimeVal = regime.status === 'fulfilled' ? regime.value : [];

  let liveCtx = '\n\n## Live Data\n\n';
  if (regimeVal[0]?.regime) liveCtx += `**Regime:** ${regimeVal[0].regime}\n\n`;
  if (posVal.length) {
    liveCtx += '**Positions:**\n';
    liveCtx += posVal.map(p =>
      `- ${p.ticker}: ${(p.shares||0).toFixed(2)} sh · MV $${(p.market_value||0).toFixed(0)}`
    ).join('\n') + '\n\n';
  }
  if (scoresVal.length) {
    liveCtx += '**AQE Scores (latest):**\n';
    liveCtx += scoresVal.map(s =>
      `- ${s.ticker}: ${s.signal_flag} (${(s.composite_score||0).toFixed(3)})`
    ).join('\n') + '\n';
  }

  const systemPrompt = FRANKY_SYSTEM + liveCtx;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        ...history.slice(-14).map(m => ({ role: m.role, content: String(m.content) })),
        { role: 'user', content: message.trim() },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    return { reply: `Signal lost (${resp.status}). ${err}` };
  }
  const data = await resp.json();
  return { reply: data.content?.[0]?.text || 'No signal.' };
}
