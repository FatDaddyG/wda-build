// Turso HTTP client — no native libsql needed in Cloudflare Workers

async function pipeline(env, requests) {
  const resp = await fetch(`${env.TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TURSO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
  });
  if (!resp.ok) throw new Error(`Turso HTTP ${resp.status}`);
  return (await resp.json()).results;
}

export async function query(env, sql, args = []) {
  const results = await pipeline(env, [{ type: 'execute', stmt: { sql, args } }]);
  const r = results[0];
  if (r.type === 'error') throw new Error(`Turso: ${r.error.message}`);
  const { cols, rows } = r.response.result;
  return rows.map(row => Object.fromEntries(cols.map((c, i) => [c.name, row[i]?.value ?? null])));
}

export async function execute(env, sql, args = []) {
  const results = await pipeline(env, [{ type: 'execute', stmt: { sql, args } }]);
  const r = results[0];
  if (r.type === 'error') throw new Error(`Turso: ${r.error.message}`);
  return r.response.result;
}

export async function batch(env, stmts) {
  const requests = stmts.map(([sql, args = []]) => ({ type: 'execute', stmt: { sql, args } }));
  const results = await pipeline(env, requests);
  const errors = results.filter(r => r.type === 'error');
  if (errors.length) throw new Error(`Turso batch: ${errors[0].error.message}`);
  return results;
}
