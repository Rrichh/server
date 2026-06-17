import 'dotenv/config';
// Validazione configurazione PRIMA di tutto (fail-fast su secret deboli/mancanti)
import { config } from './lib/config.js';
import { readFile, stat } from 'node:fs/promises';

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { csrf } from 'hono/csrf';
import { bodyLimit } from 'hono/body-limit';

import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { userRoutes } from './routes/user.js';
import { syncRoutes } from './routes/sync.js';
import { log, recordRequest } from './lib/observability.js';

const app = new Hono();
const isProd = config.isProd;

// ─── Tracking richieste in volo (per drain pulito allo shutdown) ──
let inFlight = 0;
let shuttingDown = false;
app.use('*', async (c, next) => {
  if (shuttingDown) return c.json({ error: 'shutting_down' }, 503);
  inFlight++;
  try { await next(); } finally { inFlight--; }
});

// ─── Client IP affidabile (dietro Caddy/Cloudflare) ───────────────
function clientIp(c: any): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return c.req.header('x-real-ip') || c.req.header('cf-connecting-ip') || 'unknown';
}

// ═══ Logging strutturato + metriche (1 record per richiesta) ══════
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  recordRequest(c.res.status, ms);
  // Non loggare gli health check (rumore)
  if (c.req.path === '/health' || c.req.path === '/api/health') return;
  const fields = { method: c.req.method, path: c.req.path, status: c.res.status, ms, ip: clientIp(c) };
  if (c.res.status >= 500) log('error', 'request', fields);
  else if (!isProd || c.res.status >= 400) log('info', 'request', fields);
});

// ═══ Security headers ═════════════════════════════════════════════
app.use('*', secureHeaders({
  contentSecurityPolicy: undefined, // l'API serve solo JSON; CSP del sito è su Caddy
  strictTransportSecurity: isProd ? 'max-age=63072000; includeSubDomains; preload' : false,
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  crossOriginResourcePolicy: 'same-origin',
  crossOriginOpenerPolicy: 'same-origin',
  originAgentCluster: '?1',
}));

// ═══ CORS + CSRF — solo se sono configurati origin (dev cross-origin) ══
// In produzione same-origin: CORS vuoto. La difesa CSRF è data da
// SameSite=Lax + enforcement Content-Type JSON (più sotto).
if (config.corsOrigins.length > 0) {
  app.use('*', csrf({ origin: config.corsOrigins }));
  app.use('*', cors({
    origin: config.corsOrigins,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
  }));
}

// ═══ Rate limiting (memory; VPS single-instance → corretto) ═══════
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;

function rateLimit(max: number) {
  return async (c: any, next: any) => {
    const ip = clientIp(c);
    const key = `${ip}:${max}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    let remaining: number;
    let resetAt: number;
    if (!entry || entry.resetAt < now) {
      rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
      remaining = max - 1; resetAt = now + RATE_WINDOW_MS;
    } else {
      entry.count++;
      remaining = Math.max(0, max - entry.count); resetAt = entry.resetAt;
      if (entry.count > max) {
        c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
        c.header('X-RateLimit-Limit', String(max));
        c.header('X-RateLimit-Remaining', '0');
        return c.json({ error: 'rate_limited', retryAfter: Math.ceil((entry.resetAt - now) / 1000) }, 429);
      }
    }
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(remaining));
    await next();
  };
}

// Cleanup mappa (no memory leak)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) if (v.resetAt < now) rateLimitMap.delete(k);
}, 5 * 60_000).unref();

// Limiti: generale largo, auth stretto (anti brute-force)
app.use('*', rateLimit(120));
app.use('/api/auth/login', rateLimit(10));
app.use('/api/auth/register', rateLimit(10));
app.use('/api/auth/forgot-password', rateLimit(5));
app.use('/api/auth/reset-password', rateLimit(10));
app.use('/api/auth/verify-email', rateLimit(10));

// ═══ Body limit globale: 6MB (snapshot sync max 5MB) ═════════════
app.use('*', bodyLimit({ maxSize: 6 * 1024 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));

// ═══ Content-Type enforcement: mutating con body DEVE essere JSON ══
app.use('*', async (c, next) => {
  const m = c.req.method;
  if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
    const len = parseInt(c.req.header('content-length') || '0', 10);
    if (len > 0) {
      const ct = (c.req.header('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) return c.json({ error: 'unsupported_content_type' }, 415);
    }
  }
  await next();
});

// ═══ Routes — tutte sotto /api ════════════════════════════════════
const api = new Hono();
api.get('/', (c) => c.json({ name: 'wattlab-api', version: '1.0.0', status: 'ok' }));
// Liveness: il processo è vivo (no DB)
api.get('/health', (c) => c.json({ ok: true, uptime: Math.round(process.uptime()) }));
// Readiness: il DB risponde (per orchestratori / monitoring)
api.get('/health/ready', async (c) => {
  try {
    const { db } = await import('./db/client.js');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`SELECT 1`);
    return c.json({ ok: true, db: 'up' });
  } catch {
    return c.json({ ok: false, db: 'down' }, 503);
  }
});
api.route('/auth', authRoutes);
api.route('/admin', adminRoutes);
api.route('/user', userRoutes);
api.route('/sync', syncRoutes);

app.route('/api', api);

// Liveness root-level (Docker healthcheck)
app.get('/health', (c) => c.json({ ok: true }));

// ═══ Sito statico: serve l'app (single-file index.html) same-origin ══
// Se STATIC_HTML punta al file dell'app, ogni GET fuori da /api restituisce
// l'app. Stesso indirizzo per app e API → niente CORS, cookie SameSite=Lax ok.
// Cache in memoria con invalidazione su mtime (così le modifiche si vedono subito).
const STATIC_HTML = process.env.STATIC_HTML;
if (STATIC_HTML) {
  let htmlCache: { mtime: number; body: string } = { mtime: -1, body: '' };
  const serveApp = async (c: any) => {
    if (c.req.path.startsWith('/api')) return c.json({ error: 'not_found' }, 404);
    try {
      const st = await stat(STATIC_HTML);
      if (st.mtimeMs !== htmlCache.mtime) {
        htmlCache = { mtime: st.mtimeMs, body: await readFile(STATIC_HTML, 'utf8') };
      }
      return c.html(htmlCache.body);
    } catch {
      return c.json({ error: 'app_not_found' }, 404);
    }
  };
  app.get('/', serveApp);
  app.get('*', serveApp);
  console.log('▸ Sito statico attivo:', STATIC_HTML);
}

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  console.error('[server error]', err);
  return c.json({ error: 'internal', ...(isProd ? {} : { message: err.message }) }, 500);
});

// ═══ Maintenance: purge token scaduti (6h) ════════════════════════
async function purgeExpiredTokens() {
  try {
    const { db } = await import('./db/client.js');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`
      DELETE FROM refresh_tokens
      WHERE expires_at < now() - interval '1 day'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
    `);
    await db.execute(sql`
      DELETE FROM password_reset_tokens
      WHERE expires_at < now() - interval '1 day'
         OR (used_at IS NOT NULL AND used_at < now() - interval '1 day')
    `);
  } catch (e) {
    console.error('[maintenance] purge failed', e);
  }
}
setInterval(purgeExpiredTokens, 6 * 60 * 60 * 1000).unref();
setTimeout(purgeExpiredTokens, 30_000).unref();

// ═══ Start — con ping DB iniziale ═════════════════════════════════
async function start() {
  // 1) Verifica connessione DB con retry (il container DB può partire dopo l'API)
  const { db } = await import('./db/client.js');
  const { sql } = await import('drizzle-orm');
  let dbUp = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try { await db.execute(sql`SELECT 1`); dbUp = true; break; }
    catch {
      console.log(`▸ Attendo il DB… (${attempt}/10)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (dbUp) {
    console.log('▸ DB connesso');
    // 2) Applica le migrazioni versionate (idempotente, tracciato in __drizzle_migrations)
    try {
      const { runMigrations } = await import('./db/migrate.js');
      await runMigrations();
      console.log('▸ Migrazioni applicate');
    } catch (e) {
      console.error('✗ Migrazione fallita:', (e as Error).message);
      // In produzione fermarsi è più sicuro che servire con schema incoerente
      if (isProd) process.exit(1);
    }
  } else {
    console.error('✗ DB non raggiungibile dopo 10 tentativi — readiness resterà "down".');
  }
  // 3) Avvia il server
  serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    console.log(`▸ WattLab API su :${info.port}  env=${process.env.NODE_ENV || 'development'}  cors=[${config.corsOrigins.join(', ') || 'same-origin'}]`);
  });
}
start();

// ═══ Graceful shutdown — drena le richieste in volo, poi chiude ══
let shuttingDownStarted = false;
const shutdown = async (signal: string) => {
  if (shuttingDownStarted) return;
  shuttingDownStarted = true;
  shuttingDown = true; // i nuovi arrivi ricevono 503
  console.log(`\n▸ ${signal} — drain richieste in volo (${inFlight})…`);
  // Attende fino a 10s che le richieste in corso finiscano
  const deadline = Date.now() + 10_000;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }
  try { const { pool } = await import('./db/client.js'); await pool.end(); } catch { /* già chiuso */ }
  console.log('▸ Shutdown completo');
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch-all: non far crashare il processo su errori non gestiti
process.on('unhandledRejection', (reason) => log('error', 'unhandledRejection', { reason: String(reason) }));
process.on('uncaughtException', (err) => log('error', 'uncaughtException', { err: String(err) }));
