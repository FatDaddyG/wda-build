// B10 — EDGAR 13F institutional filing crawler
// Source: SEC EDGAR REST API — keyless, public
// Tracks: 27 institutional holders, scores by conviction breadth
// Runs: 12:00 PM ET cron
// Writes: band_scores (band='b10')

import { query, batch } from '../db.js';

// Institutional CIKs to track (zero-padded to 10 digits)
const TRACKED_CIKS = [
  '0001067294', // Berkshire Hathaway
  '0001418819', // ARK Investment Management
  '0001364742', // Pershing Square Capital
  '0001103804', // Bridgewater Associates
  '0001037389', // Baupost Group
  '0001336528', // Viking Global Investors
  '0001709189', // Tiger Global Management
  '0001657335', // Coatue Management
  '0001167483', // D.E. Shaw
  '0001037138', // Appaloosa Management
  '0001029160', // Duquesne Family Office
  '0001166559', // Third Point
  '0001168164', // Greenlight Capital
  '0001095012', // Elliott Management
  '0001259313', // Jana Partners
  '0001569996', // Lone Pine Capital
  '0001423689', // Two Sigma Investments
  '0001448586', // Citadel Advisors
  '0001540159', // Point72 Asset Management
  '0001308668', // Glenview Capital
  '0001040273', // Gates Capital Management
  '0001336028', // Starboard Value
  '0001702928', // Dragoneer Investment Group
  '0001314924', // Senator Investment Group
  '0001070154', // Scion Asset Management (Burry)
  '0001424322', // Greenoaks Capital
  '0001655888', // Whale Rock Capital
];

const EDGAR_BASE = 'https://data.sec.gov';
const HEADERS = { 'User-Agent': 'DROPOUT/1.0 curtisegibson@icloud.com' };

export async function runB10(env) {
  const tickers = await query(env, 'SELECT ticker FROM tickers WHERE is_active = 1');
  const tickerSet = new Set(tickers.map(t => t.ticker));

  // filingMap: ticker → number of institutions holding it
  const filingMap = {};

  await Promise.allSettled(
    TRACKED_CIKS.map(cik => processInstitution(cik, tickerSet, filingMap))
  );

  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  const writes = [];

  for (const [ticker, count] of Object.entries(filingMap)) {
    // Score: 0-1 based on how many tracked institutions hold it
    // 10+ holders = max score (10 is arbitrary ceiling — adjust as universe matures)
    const score = Math.min(count / 10, 1);
    writes.push([
      `INSERT OR REPLACE INTO band_scores (ticker, score_date, band, raw_score, weighted_score, updated_at)
       VALUES (?, ?, 'b10', ?, ?, ?)`,
      [ticker, today, score, score, now],
    ]);
  }

  if (writes.length > 0) await batch(env, writes);
  return { band: 'b10', scored: writes.length, institutions_checked: TRACKED_CIKS.length };
}

async function processInstitution(cik, tickerSet, filingMap) {
  const submissions = await fetchJson(`${EDGAR_BASE}/submissions/CIK${cik}.json`);
  if (!submissions?.filings?.recent) return;

  const { form, accessionNumber } = submissions.filings.recent;
  const idx = form?.findIndex(f => f === '13F-HR');
  if (idx < 0 || idx === undefined) return;

  const accession = accessionNumber?.[idx]?.replace(/-/g, '');
  if (!accession) return;

  const cikNum = parseInt(cik, 10);
  const index = await fetchJson(
    `${EDGAR_BASE}/Archives/edgar/data/${cikNum}/${accession}/index.json`
  );

  const xmlFile = index?.directory?.item?.find(
    f => f.name && f.name.includes('13F') && f.name.endsWith('.xml') && !f.name.includes('index')
  );
  if (!xmlFile) return;

  const xml = await fetchText(
    `${EDGAR_BASE}/Archives/edgar/data/${cikNum}/${accession}/${xmlFile.name}`
  );
  if (!xml) return;

  // Extract ticker symbols from <cusip> or <nameOfIssuer> via regex
  // Best-effort: match $TICKER patterns or known ticker mentions in issuer names
  // Production refinement: CUSIP→ticker lookup table in Turso
  const issuerPattern = /<nameOfIssuer>(.*?)<\/nameOfIssuer>/gi;
  const issuers = [...xml.matchAll(issuerPattern)].map(m => m[1].trim().toUpperCase());

  for (const issuer of issuers) {
    for (const ticker of tickerSet) {
      // Match if issuer name starts with or contains the ticker as a word
      if (issuer === ticker || issuer.startsWith(`${ticker} `) || issuer.includes(` ${ticker} `)) {
        filingMap[ticker] = (filingMap[ticker] || 0) + 1;
        break;
      }
    }
  }
}

async function fetchJson(url) {
  try {
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return null;
    return resp.json();
  } catch { return null; }
}

async function fetchText(url) {
  try {
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return null;
    return resp.text();
  } catch { return null; }
}
