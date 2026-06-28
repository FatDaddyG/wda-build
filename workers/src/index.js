import { runB1 } from './crawlers/b1.js';
import { runB6 } from './crawlers/b6.js';
import { runB8 } from './crawlers/b8.js';
import { runB10 } from './crawlers/b10.js';
import { query, batch } from './db.js';
import { compositeScore, signalFlag, loadBandConfig } from './scoring.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event.cron, env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/api/pulse':
        return Response.json(await getPulse(env));

      case '/api/scores':
        return Response.json(await getScores(env, url.searchParams.get('ticker')));

      case '/api/positions':
        return Response.json(await query(env, 'SELECT * FROM positions ORDER BY market_value DESC'));

      case '/api/regime':
        return Response.json(await getRegime(env));

      case '/api/crawl':
        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        const body = await request.json().catch(() => ({}));
        ctx.waitUntil(runCrawler(body.band || 'all', env));
        return Response.json({ ok: true, band: body.band || 'all', queued: true });

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
  return { positions: 'ok', count: writes.length };
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
