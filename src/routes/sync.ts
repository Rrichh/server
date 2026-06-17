import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userDataSnapshots } from '../db/schema.js';
import { requireAuth, type AuthContext } from '../middleware/auth.js';

export const syncRoutes = new Hono<AuthContext>();

syncRoutes.use('/*', requireAuth);

/**
 * POST /sync/snapshot
 * Salva un nuovo snapshot del localStorage dell'utente.
 * Mantiene gli ultimi 10 snapshot per utente (storico backup).
 */
const snapshotSchema = z.object({
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.object({}).passthrough(), z.array(z.any())])),
  deviceId: z.string().max(64).optional(),
});

syncRoutes.post('/snapshot', zValidator('json', snapshotSchema), async (c) => {
  const { payload, deviceId } = c.req.valid('json');
  const user = c.get('user');

  // Hard cap dimensione: 5MB di JSON
  const size = JSON.stringify(payload).length;
  if (size > 5 * 1024 * 1024) {
    return c.json({ error: 'snapshot_too_large', max: 5 * 1024 * 1024, size }, 413);
  }

  await db.insert(userDataSnapshots).values({
    userId: user.sub,
    payload,
    deviceId: deviceId || null,
    size,
  });

  // Mantieni solo gli ultimi 10 snapshot per utente (cleanup)
  await db.execute(sql`
    DELETE FROM user_data_snapshots
    WHERE user_id = ${user.sub}
      AND id NOT IN (
        SELECT id FROM user_data_snapshots
        WHERE user_id = ${user.sub}
        ORDER BY created_at DESC
        LIMIT 10
      )
  `);

  return c.json({ ok: true, size });
});

/**
 * GET /sync/latest
 * Restituisce l'ultimo snapshot dell'utente (per ripristino su nuovo device).
 */
syncRoutes.get('/latest', async (c) => {
  const user = c.get('user');
  const [snap] = await db
    .select()
    .from(userDataSnapshots)
    .where(eq(userDataSnapshots.userId, user.sub))
    .orderBy(desc(userDataSnapshots.createdAt))
    .limit(1);
  if (!snap) return c.json({ snapshot: null });
  return c.json({
    snapshot: {
      id: snap.id,
      payload: snap.payload,
      size: snap.size,
      createdAt: snap.createdAt,
      deviceId: snap.deviceId,
    },
  });
});

/**
 * GET /sync/list
 * Lista degli ultimi snapshot (per "storico backup").
 */
syncRoutes.get('/list', async (c) => {
  const user = c.get('user');
  const list = await db
    .select({
      id: userDataSnapshots.id,
      size: userDataSnapshots.size,
      deviceId: userDataSnapshots.deviceId,
      createdAt: userDataSnapshots.createdAt,
    })
    .from(userDataSnapshots)
    .where(eq(userDataSnapshots.userId, user.sub))
    .orderBy(desc(userDataSnapshots.createdAt))
    .limit(10);
  return c.json({ snapshots: list });
});

/**
 * GET /sync/snapshot/:id
 * Restituisce uno snapshot specifico.
 */
syncRoutes.get('/snapshot/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [snap] = await db
    .select()
    .from(userDataSnapshots)
    .where(eq(userDataSnapshots.id, id))
    .limit(1);
  if (!snap || snap.userId !== user.sub) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ snapshot: snap });
});
