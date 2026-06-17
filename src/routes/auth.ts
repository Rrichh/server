import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/client.js';
import { users, refreshTokens, auditLog, passwordResetTokens, emailVerificationTokens } from '../db/schema.js';
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  hashRefreshToken,
  refreshExpiresAt,
  validatePasswordPolicy,
  DUMMY_BCRYPT_HASH,
} from '../lib/auth.js';
import { sendEmail, passwordResetEmailHtml, verifyEmailHtml, welcomeEmailHtml, passwordChangedEmailHtml } from '../lib/email.js';
import { config } from '../lib/config.js';

export const authRoutes = new Hono();

// Crea un token di verifica e restituisce l'URL di conferma (null se email disattivata).
// Non invia nulla: chi chiama sceglie il template (benvenuto vs solo conferma).
async function _createVerifyUrl(userId: string): Promise<string | null> {
  if (!config.email.enabled) return null;
  // Invalida token di verifica precedenti
  await db.update(emailVerificationTokens).set({ usedAt: new Date() })
    .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.usedAt)));
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await db.insert(emailVerificationTokens).values({
    userId, tokenHash, expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  });
  return `${config.email.appUrl}/?verify=${token}`;
}

// ═══ Anti brute-force per account ═════════════════════════════
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

// ═══ Validation schemas ═══════════════════════════════════════
const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(256),
});
const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});

// ═══ Security event log helper ════════════════════════════════
async function logSecurityEvent(c: any, action: string, userId: string | null, meta?: unknown) {
  try {
    await db.insert(auditLog).values({
      userId,
      action,
      meta: meta ?? null,
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null,
      userAgent: (c.req.header('user-agent') || '').slice(0, 256),
    });
  } catch { /* il log non deve mai bloccare l'auth */ }
}

// ═══ Cookie helpers ═══════════════════════════════════════════
// Same-origin (sito e API sullo stesso dominio via Caddy): SameSite=Lax.
function setAuthCookies(c: any, accessToken: string, refreshToken: string) {
  // SameSite: 'Lax' same-origin (default), 'None' per app su dominio diverso
  // (es. GitHub Pages → server via tunnel). 'None' richiede Secure (regola browser).
  const sameSite = (process.env.COOKIE_SAMESITE as 'Lax' | 'None' | 'Strict') || 'Lax';
  const secure = process.env.COOKIE_SECURE === 'true' || sameSite === 'None';
  const domain = process.env.COOKIE_DOMAIN || undefined;
  setCookie(c, 'wl_access', accessToken, {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    domain,
    maxAge: 15 * 60,
  });
  setCookie(c, 'wl_refresh', refreshToken, {
    httpOnly: true,
    secure,
    sameSite,
    path: '/api/auth',
    domain,
    maxAge: 30 * 24 * 60 * 60,
  });
}
function clearAuthCookies(c: any) {
  deleteCookie(c, 'wl_access', { path: '/' });
  deleteCookie(c, 'wl_refresh', { path: '/api/auth' });
}

async function issueTokens(c: any, user: { id: string; email: string; premium: boolean }) {
  const access = signAccessToken({ sub: user.id, email: user.email, isPremium: user.premium });
  const { token: refresh, hash: refreshHash } = signRefreshToken(user.id);
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refreshHash,
    userAgent: (c.req.header('user-agent') || '').slice(0, 256),
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
    expiresAt: refreshExpiresAt(),
  });
  setAuthCookies(c, access, refresh);
}

// ═══ POST /auth/register ═════════════════════════════════════
authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const normalizedEmail = email.toLowerCase().trim();

  // Password policy (blocklist, classi caratteri, no-email)
  const policyError = validatePasswordPolicy(password, normalizedEmail);
  if (policyError) {
    return c.json({ error: policyError }, 400);
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
  if (existing.length > 0) {
    // Risposta identica nei tempi: esegui comunque un hash per non rivelare
    // via timing che l'email esiste.
    await hashPassword(password);
    return c.json({ error: 'email_taken' }, 409);
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(users)
    .values({ email: normalizedEmail, passwordHash })
    .returning({ id: users.id, email: users.email, premium: users.premium });

  // Email di benvenuto (+ conferma email se le email sono attive). Best-effort.
  if (config.email.enabled) {
    try {
      const verifyUrl = await _createVerifyUrl(user.id);
      await sendEmail({ to: user.email, subject: 'Benvenuto in WattLab', html: welcomeEmailHtml(verifyUrl) });
    } catch { /* ignora */ }
  }

  await issueTokens(c, user);
  await logSecurityEvent(c, 'auth.register', user.id);
  return c.json({ id: user.id, email: user.email, premium: user.premium, emailVerified: false }, 201);
});

// ═══ POST /auth/login ════════════════════════════════════════
authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const normalizedEmail = email.toLowerCase().trim();

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, normalizedEmail), isNull(users.deletedAt)))
    .limit(1);

  // Timing-attack mitigation: SEMPRE un bcrypt compare, anche se l'utente
  // non esiste — il tempo di risposta non rivela se l'email è registrata.
  if (!user) {
    await verifyPassword(DUMMY_BCRYPT_HASH, password);
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // Account lockout attivo?
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await verifyPassword(DUMMY_BCRYPT_HASH, password); // timing uniforme
    const retryMin = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    await logSecurityEvent(c, 'auth.login_while_locked', user.id);
    return c.json({ error: 'account_locked', retryAfterMinutes: retryMin }, 423);
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED_LOGINS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
      : null;
    await db.update(users)
      .set({ failedLogins: failed, lockedUntil: lock })
      .where(eq(users.id, user.id));
    await logSecurityEvent(c, lock ? 'auth.lockout' : 'auth.failed_login', user.id, { failed });
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // Gate verifica email (solo se richiesto via env e l'invio email è attivo)
  if (config.requireEmailVerification && config.email.enabled && !user.emailVerified) {
    await logSecurityEvent(c, 'auth.login_unverified', user.id);
    return c.json({ error: 'email_not_verified' }, 403);
  }

  // Login ok: reset contatore, aggiorna lastLogin
  await db.update(users)
    .set({ lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null })
    .where(eq(users.id, user.id));

  await issueTokens(c, user);
  await logSecurityEvent(c, 'auth.login', user.id);
  return c.json({ id: user.id, email: user.email, premium: user.premium, emailVerified: user.emailVerified });
});

// ═══ POST /auth/refresh ══════════════════════════════════════
authRoutes.post('/refresh', async (c) => {
  const refresh = getCookie(c, 'wl_refresh');
  if (!refresh) return c.json({ error: 'no_refresh' }, 401);
  const refreshHash = hashRefreshToken(refresh);

  // Cerca il token INDIPENDENTEMENTE dallo stato revoked: serve per
  // distinguere "token sconosciuto" da "token già usato" (= furto).
  const [row] = await db
    .select({
      id: refreshTokens.id,
      userId: refreshTokens.userId,
      revokedAt: refreshTokens.revokedAt,
      expiresAt: refreshTokens.expiresAt,
      user: users,
    })
    .from(refreshTokens)
    .innerJoin(users, eq(refreshTokens.userId, users.id))
    .where(and(eq(refreshTokens.tokenHash, refreshHash), isNull(users.deletedAt)))
    .limit(1);

  if (!row) {
    clearAuthCookies(c);
    return c.json({ error: 'invalid_refresh' }, 401);
  }

  // ── REUSE DETECTION ──
  // Un refresh token GIÀ RUOTATO che viene ripresentato significa che
  // qualcuno (l'attaccante o la vittima) sta usando un token rubato.
  // Risposta drastica e corretta: revoca TUTTE le sessioni dell'utente.
  if (row.revokedAt) {
    await db.update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, row.userId), isNull(refreshTokens.revokedAt)));
    await logSecurityEvent(c, 'auth.token_reuse_detected', row.userId, { tokenId: row.id });
    clearAuthCookies(c);
    return c.json({ error: 'token_reuse_detected' }, 401);
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    clearAuthCookies(c);
    return c.json({ error: 'refresh_expired' }, 401);
  }

  // Rotation: revoca il corrente, emetti nuovo
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
  await issueTokens(c, row.user);
  return c.json({ id: row.user.id, email: row.user.email, premium: row.user.premium });
});

// ═══ POST /auth/logout ═══════════════════════════════════════
authRoutes.post('/logout', async (c) => {
  const refresh = getCookie(c, 'wl_refresh');
  if (refresh) {
    const refreshHash = hashRefreshToken(refresh);
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.tokenHash, refreshHash));
  }
  clearAuthCookies(c);
  return c.json({ ok: true });
});

// ═══ GET /auth/me ════════════════════════════════════════════
authRoutes.get('/me', async (c) => {
  const access = getCookie(c, 'wl_access');
  if (!access) return c.json({ error: 'unauthorized' }, 401);
  const { verifyAccessToken } = await import('../lib/auth.js');
  const payload = verifyAccessToken(access);
  if (!payload) return c.json({ error: 'invalid' }, 401);
  return c.json({ id: payload.sub, email: payload.email, premium: payload.isPremium });
});

// ═══ POST /auth/forgot-password ══════════════════════════════
// Risponde SEMPRE {ok:true} — non rivela mai se l'email esiste (anti-enumeration).
const forgotSchema = z.object({ email: z.string().email().max(255) });
authRoutes.post('/forgot-password', zValidator('json', forgotSchema), async (c) => {
  const { email } = c.req.valid('json');
  const normalizedEmail = email.toLowerCase().trim();

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.email, normalizedEmail), isNull(users.deletedAt)))
    .limit(1);

  if (user) {
    // Invalida eventuali token di reset precedenti ancora attivi
    await db.update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));

    // Token monouso 30 minuti — in chiaro solo nell'email, in DB solo l'hash
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });

    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    const resetUrl = `${appUrl}/?reset=${token}`;
    const sent = await sendEmail({
      to: user.email,
      subject: 'WattLab — Reimposta la tua password',
      html: passwordResetEmailHtml(resetUrl),
    });
    await logSecurityEvent(c, sent ? 'auth.reset_requested' : 'auth.reset_email_failed', user.id);
  }
  // Stessa risposta in ogni caso
  return c.json({ ok: true });
});

// ═══ POST /auth/reset-password ═══════════════════════════════
const resetSchema = z.object({
  token: z.string().min(20).max(128),
  newPassword: z.string().min(8).max(256),
});
authRoutes.post('/reset-password', zValidator('json', resetSchema), async (c) => {
  const { token, newPassword } = c.req.valid('json');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const [row] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
      userEmail: users.email,
    })
    .from(passwordResetTokens)
    .innerJoin(users, eq(passwordResetTokens.userId, users.id))
    .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(users.deletedAt)))
    .limit(1);

  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    return c.json({ error: 'invalid_or_expired_token' }, 400);
  }

  const policyError = validatePasswordPolicy(newPassword, row.userEmail);
  if (policyError) return c.json({ error: policyError }, 400);

  const passwordHash = await hashPassword(newPassword);
  await db.update(users)
    .set({ passwordHash, updatedAt: new Date(), failedLogins: 0, lockedUntil: null })
    .where(eq(users.id, row.userId));
  // Token bruciato + revoca TUTTE le sessioni (la password potrebbe essere compromessa)
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id));
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, row.userId), isNull(refreshTokens.revokedAt)));

  await logSecurityEvent(c, 'auth.password_reset', row.userId);
  // Notifica di sicurezza "password modificata" (best-effort)
  if (config.email.enabled) {
    try { await sendEmail({ to: row.userEmail, subject: 'WattLab — Password modificata', html: passwordChangedEmailHtml(config.email.appUrl) }); } catch { /* ignora */ }
  }
  return c.json({ ok: true });
});

// ═══ POST /auth/verify-email  body { token } ═════════════════
const verifySchema = z.object({ token: z.string().min(20).max(128) });
authRoutes.post('/verify-email', zValidator('json', verifySchema), async (c) => {
  const { token } = c.req.valid('json');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const [row] = await db
    .select({
      id: emailVerificationTokens.id,
      userId: emailVerificationTokens.userId,
      expiresAt: emailVerificationTokens.expiresAt,
      usedAt: emailVerificationTokens.usedAt,
    })
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    return c.json({ error: 'invalid_or_expired_token' }, 400);
  }
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId));
  await db.update(emailVerificationTokens).set({ usedAt: new Date() }).where(eq(emailVerificationTokens.id, row.id));
  await logSecurityEvent(c, 'auth.email_verified', row.userId);
  return c.json({ ok: true });
});

// ═══ POST /auth/resend-verification  body { email } ══════════
// Risponde sempre ok (anti-enumeration). Re-invia l'email se l'account
// esiste e non è ancora verificato.
authRoutes.post('/resend-verification', zValidator('json', forgotSchema), async (c) => {
  const { email } = c.req.valid('json');
  const normalizedEmail = email.toLowerCase().trim();
  const [user] = await db
    .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(and(eq(users.email, normalizedEmail), isNull(users.deletedAt)))
    .limit(1);
  if (user && !user.emailVerified) {
    try {
      const verifyUrl = await _createVerifyUrl(user.id);
      if (verifyUrl) await sendEmail({ to: user.email, subject: 'WattLab — Conferma la tua email', html: verifyEmailHtml(verifyUrl) });
    } catch { /* ignora */ }
  }
  return c.json({ ok: true });
});
