import { Hono } from 'hono';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, userDataSnapshots } from '../db/schema.js';
import { requireAuth, type AuthContext } from '../middleware/auth.js';

export const coachRoutes = new Hono<AuthContext>();

// Solo utenti autenticati: l'allenatore deve avere un account.
coachRoutes.use('/*', requireAuth);

/**
 * GET /coach/athlete/:code
 * Dato il codice atleta (condiviso dall'atleta col proprio allenatore),
 * restituisce nome + riassunto degli allenamenti, preso dall'ultimo
 * snapshot cloud dell'atleta (chiave `wl_coach_summary` nel payload).
 */
coachRoutes.get('/athlete/:code', async (c) => {
  const code = (c.req.param('code') || '').trim().toUpperCase();
  if (!code || code.length > 32) {
    return c.json({ error: 'invalid_code' }, 400);
  }

  // Trova l'atleta con quel codice (non cancellato)
  const [athlete] = await db
    .select({ id: users.id, displayName: users.displayName, athleteCode: users.athleteCode })
    .from(users)
    .where(and(eq(users.athleteCode, code), isNull(users.deletedAt)))
    .limit(1);

  if (!athlete) {
    return c.json({ error: 'athlete_not_found' }, 404);
  }

  // Ultimo snapshot cloud dell'atleta
  const [snap] = await db
    .select({ payload: userDataSnapshots.payload, createdAt: userDataSnapshots.createdAt })
    .from(userDataSnapshots)
    .where(eq(userDataSnapshots.userId, athlete.id))
    .orderBy(desc(userDataSnapshots.createdAt))
    .limit(1);

  let activities: unknown[] = [];
  if (snap && snap.payload && typeof snap.payload === 'object') {
    const raw = (snap.payload as Record<string, unknown>)['wl_coach_summary'];
    if (typeof raw === 'string') {
      try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) activities = parsed; } catch { /* ignora */ }
    } else if (Array.isArray(raw)) {
      activities = raw;
    }
  }

  return c.json({
    displayName: athlete.displayName || null,
    athleteCode: athlete.athleteCode,
    hasData: !!snap,
    updatedAt: snap?.createdAt || null,
    activities,
  });
});
