// MCP HTTP endpoint — exposes DROPOUT signal data as Claude tools
// Transport: streamable HTTP (JSON-RPC 2.0)
// Connect: Claude.ai Settings → Integrations → https://dropout-cloud.curtisgibson.workers.dev/mcp

import { query } from './db.js';

const TOOLS = [
  {
    name: 'dropout__get_scores',
    description: 'Get AQE composite scores. Pass ticker for single-stock detail with per-band breakdown. Omit for top 100 by composite score.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Ticker symbol e.g. NVDA (optional)' },
      },
    },
  },
  {
    name: 'dropout__get_positions',
    description: 'Get current portfolio positions (EOD sync from Public.com). Includes shares, avg cost, market value.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dropout__get_signals',
    description: 'Get active BUY and WATCH signal flags from the latest score date.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dropout__get_regime',
    description: 'Get current market regime (NEUTRAL, MOMENTUM, RISK_OFF, etc.) and the band gain weights active for that regime.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dropout__get_crawl_health',
    description: 'Get last crawl timestamps and status for each band (b1, b6, b8, b10).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dropout__compare_tickers',
    description: 'Compare AQE composite scores and band breakdowns across multiple tickers side by side.',
    inputSchema: {
      type: 'object',
      required: ['tickers'],
      properties: {
        tickers: { type: 'array', items: { type: 'string' }, description: 'List of ticker symbols e.g. ["NVDA","AMD","INTC"]' },
      },
    },
  },
  {
    name: 'dropout__trigger_crawl',
    description: 'Manually trigger a signal crawl. band = b1 | b6 | b8 | b10 | all.',
    inputSchema: {
      type: 'object',
      properties: {
        band: { type: 'string', description: 'Band to crawl (default: all)' },
      },
    },
  },
];

async function callTool(name, args, env) {
  switch (name) {
    case 'dropout__get_scores':
      return getScores(env, args.ticker);

    case 'dropout__get_positions':
      return query(env, 'SELECT * FROM positions ORDER BY market_value DESC');

    case 'dropout__get_signals':
      return query(env,
        `SELECT ticker, composite_score, signal_flag, score_date, regime
         FROM signal_scores
         WHERE score_date = (SELECT MAX(score_date) FROM signal_scores)
           AND signal_flag IN ('BUY','WATCH')
         ORDER BY composite_score DESC`);

    case 'dropout__get_regime': {
      const [regime] = await query(env, 'SELECT * FROM market_regime WHERE id = 1');
      const gains = await query(env,
        'SELECT band, gain FROM signal_band_config WHERE regime = ? ORDER BY band',
        [(regime?.regime || 'DEFAULT')]);
      return { regime, band_gains: gains };
    }

    case 'dropout__get_crawl_health':
      return query(env,
        `SELECT band, MAX(crawl_time) as last_crawl, status, tickers_scored
         FROM crawl_log GROUP BY band ORDER BY band`);

    case 'dropout__compare_tickers': {
      const tickers = (args.tickers || []).map(t => t.toUpperCase());
      if (!tickers.length) return { error: 'No tickers provided' };
      const placeholders = tickers.map(() => '?').join(',');
      const scores = await query(env,
        `SELECT ss.ticker, ss.composite_score, ss.signal_flag, ss.score_date,
                bs.band, bs.raw_score
         FROM signal_scores ss
         LEFT JOIN band_scores bs ON ss.ticker = bs.ticker AND ss.score_date = bs.score_date
         WHERE ss.ticker IN (${placeholders})
           AND ss.score_date = (SELECT MAX(score_date) FROM signal_scores)
         ORDER BY ss.composite_score DESC, ss.ticker, bs.band`,
        tickers);
      // Group by ticker
      const out = {};
      for (const row of scores) {
        if (!out[row.ticker]) out[row.ticker] = { ticker: row.ticker, composite_score: row.composite_score, signal_flag: row.signal_flag, score_date: row.score_date, bands: {} };
        if (row.band) out[row.ticker].bands[row.band] = row.raw_score;
      }
      return Object.values(out);
    }

    case 'dropout__trigger_crawl': {
      const band = args.band || 'all';
      // Import lazily to avoid circular issues
      const { runB1 } = await import('./crawlers/b1.js');
      const { runB6 } = await import('./crawlers/b6.js');
      const { runB8 } = await import('./crawlers/b8.js');
      const { runB10 } = await import('./crawlers/b10.js');
      const map = { b1: runB1, b6: runB6, b8: runB8, b10: runB10 };
      if (band === 'all') {
        const results = await Promise.allSettled([runB1(env), runB6(env), runB8(env), runB10(env)]);
        return results.map((r, i) => r.status === 'fulfilled' ? r.value : { band: ['b1','b6','b8','b10'][i], error: r.reason?.message });
      }
      return map[band] ? map[band](env) : { error: `Unknown band: ${band}` };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function getScores(env, ticker) {
  if (ticker) {
    return query(env,
      `SELECT ss.ticker, ss.score_date, ss.composite_score, ss.regime, ss.signal_flag,
              bs.band, bs.raw_score
       FROM signal_scores ss
       LEFT JOIN band_scores bs ON ss.ticker = bs.ticker AND ss.score_date = bs.score_date
       WHERE ss.ticker = ? ORDER BY ss.score_date DESC LIMIT 25`,
      [ticker.toUpperCase()]);
  }
  return query(env,
    `SELECT * FROM signal_scores
     WHERE score_date = (SELECT MAX(score_date) FROM signal_scores)
     ORDER BY composite_score DESC LIMIT 100`);
}

export async function handleMCP(request, env) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

  // GET — server info / capability discovery
  if (request.method === 'GET') {
    return Response.json({
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'dropout-cloud', version: '1.0.0' },
      capabilities: { tools: {} },
    }, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { headers: corsHeaders });
  }

  const { method, params, id } = body;

  try {
    if (method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'dropout-cloud', version: '1.0.0' },
          capabilities: { tools: {} },
        },
      }, { headers: corsHeaders });
    }

    if (method === 'tools/list') {
      return Response.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } }, { headers: corsHeaders });
    }

    if (method === 'tools/call') {
      const result = await callTool(params.name, params.arguments || {}, env);
      return Response.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      }, { headers: corsHeaders });
    }

    return Response.json({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }, { headers: corsHeaders });

  } catch (err) {
    return Response.json({
      jsonrpc: '2.0', id,
      error: { code: -32603, message: err.message },
    }, { headers: corsHeaders });
  }
}
