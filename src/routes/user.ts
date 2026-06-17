import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull, gt, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, refreshTokens } from '../db/schema.js';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../lib/auth.js';
import { requireAuth, type AuthContext } from '../middleware/auth.js';
import { sendEmail, passwordChangedEmailHtml, accountDeletedEmailHtml } from '../lib/email.js';
import { config } from '../lib/config.js';

export const userRoutes = new Hono<AuthContext>();

userRoutes.use('/*', requireAuth);

/**
 * GET /user/me — info utente loggato (dettagli completi vs /auth/me che fa solo token check)
 */
userRoutes.get('/me', async (c) => {
  const session = c.get('user');
  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      premium: users.premium,
      premiumUntil: users.premiumUntil,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.id, session.sub))
    .limit(1);
  if (!u) return c.json({ error: 'not_found' }, 404);
  return c.json(u);
});

/**
 * PUT /user/profile — sincronizza codice atleta e nome visualizzato dal client
 */
const profileSchema = z.object({
  athleteCode: z.string().max(32).optional(),
  displayName: z.string().max(80).optional(),
});
userRoutes.put('/profile', zValidator('json', profileSchema), async (c) => {
  const session = c.get('user');
  const { athleteCode, displayName } = c.req.valid('json');
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (athleteCode !== undefined) patch.athleteCode = athleteCode || null;
  if (displayName !== undefined) patch.displayName = displayName || null;
  await db.update(users).set(patch).where(eq(users.id, session.sub));
  return c.json({ ok: true });
});

/**
 * PUT /user/password — cambia password
 */
const pwdSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(256),
});
userRoutes.put('/password', zValidator('json', pwdSchema), async (c) => {
  const session = c.get('user');
  const { currentPassword, newPassword } = c.req.valid('json');
  const [u] = await db.select().from(users).where(eq(users.id, session.sub)).limit(1);
  if (!u) return c.json({ error: 'not_found' }, 404);
  if (!(await verifyPassword(u.passwordHash, currentPassword))) {
    return c.json({ error: 'wrong_password' }, 401);
  }
  const policyError = validatePasswordPolicy(newPassword, u.email);
  if (policyError) return c.json({ error: policyError }, 400);
  const newHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, session.sub));
  // Cambio password = revoca tutte le altre sessioni (sicurezza standard)
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, session.sub), isNull(refreshTokens.revokedAt)));
  // Notifica di sicurezza "password modificata" (best-effort)
  if (config.email.enabled) {
    try { await sendEmail({ to: u.email, subject: 'WattLab — Password modificata', html: passwordChangedEmailHtml(config.email.appUrl) }); } catch { /* ignora */ }
  }
  return c.json({ ok: true, sessionsRevoked: true });
});

/**
 * GET /user/sessions — sessioni attive (refresh token validi)
 */
userRoutes.get('/sessions', async (c) => {
  const session = c.get('user');
  const list = await db
    .select({
      id: refreshTokens.id,
      userAgent: refreshTokens.userAgent,
      ip: refreshTokens.ip,
      createdAt: refreshTokens.createdAt,
      expiresAt: refreshTokens.expiresAt,
    })
    .from(refreshTokens)
    .where(and(
      eq(refreshTokens.userId, session.sub),
      isNull(refreshTokens.revokedAt),
      gt(refreshTokens.expiresAt, new Date()),
    ))
    .orderBy(desc(refreshTokens.createdAt))
    .limit(50);
  return c.json({ sessions: list });
});

/**
 * POST /user/sessions/revoke-all — disconnetti tutti i dispositivi
 */
userRoutes.post('/sessions/revoke-all', async (c) => {
  const session = c.get('user');
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, session.sub), isNull(refreshTokens.revokedAt)));
  return c.json({ ok: true });
});

/**
 * DELETE /user/me — soft delete account + revoca tutte le sessioni
 */
userRoutes.delete('/me', async (c) => {
  const session = c.get('user');
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, session.sub)).limit(1);
  await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, session.sub));
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, session.sub), isNull(refreshTokens.revokedAt)));
  // Conferma cancellazione (best-effort)
  if (config.email.enabled && u?.email) {
    try { await sendEmail({ to: u.email, subject: 'WattLab — Account eliminato', html: accountDeletedEmailHtml() }); } catch { /* ignora */ }
  }
  return c.json({ ok: true });
});
