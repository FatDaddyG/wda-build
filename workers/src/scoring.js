// AQE composite scoring — JS port of Python implementation

export function compositeScore(bandScores, regime, config) {
  let weightedSum = 0;
  let totalGain = 0;
  for (const [band, rawScore] of Object.entries(bandScores)) {
    if (rawScore === null || rawScore === undefined) continue;
    const gain = config[band]?.[regime] ?? config[band]?.['DEFAULT'] ?? 0;
    weightedSum += rawScore * gain;
    totalGain += gain;
  }
  return totalGain > 0 ? weightedSum / totalGain : null;
}

export function signalFlag(score) {
  if (score === null || score === undefined) return 'INSUFFICIENT';
  if (score >= 0.75) return 'BUY';
  if (score >= 0.50) return 'WATCH';
  if (score >= 0.30) return 'HOLD';
  return 'EXIT';
}

// Returns { b1: { MOMENTUM: 1.2, DEFAULT: 1.0 }, ... }
export async function loadBandConfig(env, queryFn) {
  const rows = await queryFn(env, 'SELECT band, regime, gain FROM signal_band_config');
  const config = {};
  for (const { band, regime, gain } of rows) {
    if (!config[band]) config[band] = {};
    config[band][regime] = gain;
  }
  return config;
}
