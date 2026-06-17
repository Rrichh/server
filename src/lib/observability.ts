/**
 * Osservabilità leggera, zero-dipendenze:
 *  - log()  → riga JSON su stdout in produzione (Docker la cattura),
 *             testo leggibile in sviluppo.
 *  - metrics → contatori in-memory esposti da /api/admin/metrics.
 */
import { config } from './config.js';

type Level = 'info' | 'warn' | 'error';

export function log(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (config.isProd) {
    const rec = { t: new Date().toISOString(), level, msg, ...fields };
    const line = JSON.stringify(rec);
    if (level === 'error') console.error(line);
    else console.log(line);
  } else {
    const extra = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    const out = `[${level}] ${msg}${extra}`;
    if (level === 'error') console.error(out);
    else console.log(out);
  }
}

// ─── Metriche in-memory (reset a ogni riavvio) ───────────────────
const startedAt = Date.now();
const metrics = {
  requests: 0,
  byStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } as Record<string, number>,
  totalDurationMs: 0,
  maxDurationMs: 0,
  rateLimited: 0,
  authFailures: 0,
};

export function recordRequest(status: number, durationMs: number) {
  metrics.requests++;
  metrics.totalDurationMs += durationMs;
  if (durationMs > metrics.maxDurationMs) metrics.maxDurationMs = durationMs;
  const bucket = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
  metrics.byStatus[bucket]++;
  if (status === 429) metrics.rateLimited++;
  if (status === 401 || status === 403) metrics.authFailures++;
}

export function snapshotMetrics() {
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
  const mem = process.memoryUsage();
  return {
    uptimeSec,
    requests: metrics.requests,
    byStatus: metrics.byStatus,
    avgDurationMs: metrics.requests ? Math.round(metrics.totalDurationMs / metrics.requests) : 0,
    maxDurationMs: Math.round(metrics.maxDurationMs),
    rateLimited: metrics.rateLimited,
    authFailures: metrics.authFailures,
    rps: uptimeSec ? +(metrics.requests / uptimeSec).toFixed(3) : 0,
    memory: {
      rssMb: +(mem.rss / 1048576).toFixed(1),
      heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1),
    },
    node: process.version,
  };
}
