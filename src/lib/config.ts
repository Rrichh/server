/**
 * Configurazione centralizzata e VALIDATA all'avvio.
 * Se qualcosa di critico manca o è debole, il server NON parte (fail-fast):
 * meglio un crash chiaro al boot che un deploy insicuro silenzioso.
 */

const isProd = process.env.NODE_ENV === 'production';

const PLACEHOLDER_SECRETS = new Set([
  'change-me-with-a-long-random-string-min-32-chars',
  'another-long-random-string-different-from-access',
  'change-me-in-production-with-strong-random-string',
  'dev-access-secret-change-in-prod-min-32-chars',
  'dev-refresh-secret-change-in-prod-min-32-chars',
  '', 'secret', 'changeme', 'password',
]);

const errors: string[] = [];

function requireSecret(name: string, value: string | undefined, minLen = 32): string {
  if (!value || value.trim() === '') {
    errors.push(`${name} mancante`);
    return '';
  }
  if (isProd) {
    if (value.length < minLen) errors.push(`${name} troppo corto (min ${minLen} caratteri)`);
    if (PLACEHOLDER_SECRETS.has(value)) errors.push(`${name} usa ancora il valore placeholder — generane uno reale`);
  }
  return value;
}

function requireEmail(name: string, value: string | undefined): string {
  const v = (value || '').trim().toLowerCase();
  if (!v) { errors.push(`${name} mancante`); return ''; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors.push(`${name} non è un'email valida (${v})`);
  return v;
}

const ACCESS = requireSecret('JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET);
const REFRESH = requireSecret('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET);
if (isProd && ACCESS && REFRESH && ACCESS === REFRESH) {
  errors.push('JWT_ACCESS_SECRET e JWT_REFRESH_SECRET devono essere DIVERSI tra loro');
}

const ADMIN_EMAIL = requireEmail('ADMIN_EMAIL', process.env.ADMIN_EMAIL);

const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) errors.push('DATABASE_URL mancante');

// In produzione i cookie DEVONO essere Secure (richiede HTTPS, fornito da Caddy)
if (isProd && process.env.COOKIE_SECURE !== 'true') {
  errors.push('In produzione COOKIE_SECURE deve essere "true"');
}

if (errors.length > 0) {
  console.error('\n╔════════════════════════════════════════════════════════════╗');
  console.error('║  CONFIGURAZIONE NON VALIDA — il server non può avviarsi      ║');
  console.error('╚════════════════════════════════════════════════════════════╝');
  for (const e of errors) console.error('  ✗ ' + e);
  console.error('\n  Controlla il file .env (vedi .env.example).\n');
  process.exit(1);
}

export const config = {
  isProd,
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: DATABASE_URL,
  jwt: {
    accessSecret: ACCESS,
    refreshSecret: REFRESH,
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  },
  adminEmail: ADMIN_EMAIL,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    domain: process.env.COOKIE_DOMAIN || undefined,
  },
  corsOrigins: (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  email: {
    brevoApiKey: process.env.BREVO_API_KEY || '',
    senderEmail: process.env.SENDER_EMAIL || '',
    senderName: process.env.SENDER_NAME || 'WattLab',
    appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
    enabled: !!(process.env.BREVO_API_KEY && process.env.SENDER_EMAIL),
  },
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
};

export type AppConfig = typeof config;
