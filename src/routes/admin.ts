import { Hono } from 'hono';
import { sql, desc, gte, count, eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, activities, subscriptions, auditLog, adminAthletes, userDataSnapshots } from '../db/schema.js';
import { requireAuth, requireAdmin, type AuthContext } from '../middleware/auth.js';

export const adminRoutes = new Hono<AuthContext>();

// Tutto sotto auth + admin gate
adminRoutes.use('/*', requireAuth, requireAdmin);

/**
 * GET /admin/stats
 * Aggregato per la dashboard admin (popola la sezione KPI + utenti + sistema).
 */
adminRoutes.get('/stats', async (c) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const ytdStart = new Date(now.getFullYear(), 0, 1);

  // ── USERS ──
  const [{ totalUsers }] = await db
    .select({ totalUsers: count() })
    .from(users)
    .where(sql`${users.deletedAt} IS NULL`);
  const [{ usersToday }] = await db
    .select({ usersToday: count() })
    .from(users)
    .where(sql`${users.createdAt} >= ${todayStart} AND ${users.deletedAt} IS NULL`);
  const [{ usersWeek }] = await db
    .select({ usersWeek: count() })
    .from(users)
    .where(sql`${users.createdAt} >= ${weekStart} AND ${users.deletedAt} IS NULL`);
  const [{ premiumUsers }] = await db
    .select({ premiumUsers: count() })
    .from(users)
    .where(sql`${users.premium} = TRUE AND ${users.deletedAt} IS NULL`);

  // ── ACTIVITIES ──
  const [{ totalActivities }] = await db.select({ totalActivities: count() }).from(activities);
  const [{ activitiesToday }] = await db
    .select({ activitiesToday: count() })
    .from(activities)
    .where(gte(activities.createdAt, todayStart));
  const [{ activitiesWeek }] = await db
    .select({ activitiesWeek: count() })
    .from(activities)
    .where(gte(activities.createdAt, weekStart));

  // ── REVENUE (mock per ora, MRR/YTD verranno calcolati da Stripe) ──
  const activeSubs = await db
    .select({ count: count() })
    .from(subscriptions)
    .where(eq(subscriptions.status, 'active'));
  const activeCount = activeSubs[0]?.count ?? 0;
  const monthlyPrice = 5; // €/mese, parametrizzare con piano reale
  const mrr = activeCount * monthlyPrice;

  // ── SYSTEM ──
  const memUsage = process.memoryUsage();
  const uptimeSec = process.uptime();
  const uptimeFmt = `${Math.floor(uptimeSec / 86400)}g ${Math.floor((uptimeSec % 86400) / 3600)}h`;

  // ── RECENT USERS ──
  const recent = await db
    .select({
      email: users.email,
      premium: users.premium,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(sql`${users.deletedAt} IS NULL`)
    .orderBy(desc(users.createdAt))
    .limit(10);

  const recentUsers = recent.map((u) => ({
    email: u.email,
    premium: u.premium,
    date: u.createdAt.toISOString(),
    activities: 0, // TODO: aggregato per utente
  }));

  return c.json({
    users: {
      total: Number(totalUsers),
      today: Number(usersToday),
      week: Number(usersWeek),
      premium: Number(premiumUsers),
    },
    activities: {
      total: Number(totalActivities),
      today: Number(activitiesToday),
      week: Number(activitiesWeek),
    },
    revenue: {
      mrr,
      ytd: mrr * 6, // placeholder finché Stripe non è collegato
      currency: '€',
    },
    system: {
      apiLatency: '< 50ms',
      uptime: uptimeFmt,
      storage: `${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB heap`,
      errors: 0,
    },
    recentUsers,
  });
});

/**
 * GET /admin/users?cursor=...&limit=50
 * Lista utenti paginata per gestione.
 */
adminRoutes.get('/users', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 300);
  const q = (c.req.query('q') || '').trim().toLowerCase();
  // Lista atleti già seguiti dall'admin (per marcare nella UI)
  const actor = c.get('user');
  const followed = await db
    .select({ athleteUserId: adminAthletes.athleteUserId })
    .from(adminAthletes)
    .where(eq(adminAthletes.adminUserId, actor.sub));
  const followedSet = new Set(followed.map(f => f.athleteUserId));

  const whereClause = q
    ? sql`${users.deletedAt} IS NULL AND (lower(${users.email}) LIKE ${'%' + q + '%'} OR lower(coalesce(${users.athleteCode},'')) LIKE ${'%' + q + '%'} OR lower(coalesce(${users.displayName},'')) LIKE ${'%' + q + '%'})`
    : sql`${users.deletedAt} IS NULL`;

  const list = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      athleteCode: users.athleteCode,
      premium: users.premium,
      premiumUntil: users.premiumUntil,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(whereClause)
    .orderBy(desc(users.createdAt))
    .limit(limit);

  return c.json({ users: list.map(u => ({ ...u, followed: followedSet.has(u.id) })) });
});

/**
 * GET /admin/users/:id — dettaglio completo di un utente
 */
adminRoutes.get('/users/:id', async (c) => {
  const id = c.req.param('id');
  const actor = c.get('user');
  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      athleteCode: users.athleteCode,
      premium: users.premium,
      premiumUntil: users.premiumUntil,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(and(eq(users.id, id), sql`${users.deletedAt} IS NULL`))
    .limit(1);
  if (!u) return c.json({ error: 'not_found' }, 404);
  // Già seguito dall'admin?
  const [rel] = await db
    .select({ id: adminAthletes.id })
    .from(adminAthletes)
    .where(and(eq(adminAthletes.adminUserId, actor.sub), eq(adminAthletes.athleteUserId, id)))
    .limit(1);
  // Ha dati sincronizzati?
  const [snap] = await db
    .select({ createdAt: userDataSnapshots.createdAt, size: userDataSnapshots.size })
    .from(userDataSnapshots)
    .where(eq(userDataSnapshots.userId, id))
    .orderBy(desc(userDataSnapshots.createdAt))
    .limit(1);
  return c.json({
    ...u,
    followed: !!rel,
    lastSnapshot: snap ? { at: snap.createdAt, size: snap.size } : null,
  });
});

/**
 * POST /admin/users/:id/grant-premium
 * Concede premium manualmente a un utente.
 */
adminRoutes.post('/users/:id/grant-premium', async (c) => {
  const id = c.req.param('id');
  const days = parseInt(c.req.query('days') || '30', 10);
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await db.update(users).set({ premium: true, premiumUntil: until }).where(eq(users.id, id));
  // Audit
  const actor = c.get('user');
  await db.insert(auditLog).values({
    userId: actor.sub,
    action: 'admin.grant_premium',
    meta: { targetUserId: id, days },
    ip: c.req.header('x-forwarded-for') || null,
    userAgent: c.req.header('user-agent') || null,
  });
  return c.json({ ok: true, premiumUntil: until });
});

/**
 * GET /admin/audit?limit=100
 * Audit log per attività admin.
 */
adminRoutes.get('/audit', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 500);
  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  return c.json({ entries: rows });
});

/**
 * GET /admin/users/search?q=email
 * Cerca utenti per email (LIKE %q%).
 */
adminRoutes.get('/users/search', async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  if (q.length < 2) return c.json({ users: [] });
  const list = await db
    .select({
      id: users.id,
      email: users.email,
      premium: users.premium,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(sql`lower(${users.email}) LIKE ${'%' + q + '%'} AND ${users.deletedAt} IS NULL`)
    .orderBy(desc(users.createdAt))
    .limit(50);
  return c.json({ users: list });
});

/**
 * DELETE /admin/users/:id
 * Soft-delete di un utente (audit log).
 */
adminRoutes.delete('/users/:id', async (c) => {
  const id = c.req.param('id');
  const actor = c.get('user');
  // Non può cancellare se stesso
  if (id === actor.sub) {
    return c.json({ error: 'cannot_delete_self' }, 400);
  }
  await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));
  await db.insert(auditLog).values({
    userId: actor.sub,
    action: 'admin.delete_user',
    meta: { targetUserId: id },
    ip: c.req.header('x-forwarded-for') || null,
    userAgent: c.req.header('user-agent') || null,
  });
  return c.json({ ok: true });
});

/**
 * POST /admin/users/:id/revoke-premium
 * Revoca premium manualmente.
 */
adminRoutes.post('/users/:id/revoke-premium', async (c) => {
  const id = c.req.param('id');
  const actor = c.get('user');
  await db.update(users).set({ premium: false, premiumUntil: null }).where(eq(users.id, id));
  await db.insert(auditLog).values({
    userId: actor.sub,
    action: 'admin.revoke_premium',
    meta: { targetUserId: id },
    ip: c.req.header('x-forwarded-for') || null,
    userAgent: c.req.header('user-agent') || null,
  });
  return c.json({ ok: true });
});

/**
 * GET /admin/system/db
 * Info sul DB Postgres (size totale, righe principali).
 */
adminRoutes.get('/system/db', async (c) => {
  const dbSize = await db.execute(sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
  const tables = await db.execute(sql`
    SELECT relname AS table, n_live_tup AS rows
    FROM pg_stat_user_tables
    ORDER BY n_live_tup DESC
    LIMIT 20
  `);
  return c.json({
    size: dbSize.rows[0]?.size || 'unknown',
    tables: tables.rows,
  });
});

/**
 * GET /admin/metrics — metriche runtime del processo (richieste, latenza, memoria)
 */
adminRoutes.get('/metrics', async (c) => {
  const { snapshotMetrics } = await import('../lib/observability.js');
  return c.json(snapshotMetrics());
});

// ═══════════════════════════════════════════════════════════
// MIEI ATLETI (admin segue utenti — invisibile all'utente)
// ═══════════════════════════════════════════════════════════

/**
 * GET /admin/athletes — atleti seguiti dall'admin con info essenziali
 */
adminRoutes.get('/athletes', async (c) => {
  const actor = c.get('user');
  const rows = await db
    .select({
      relId: adminAthletes.id,
      note: adminAthletes.note,
      addedAt: adminAthletes.createdAt,
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      athleteCode: users.athleteCode,
      premium: users.premium,
      lastLoginAt: users.lastLoginAt,
    })
    .from(adminAthletes)
    .innerJoin(users, eq(adminAthletes.athleteUserId, users.id))
    .where(and(eq(adminAthletes.adminUserId, actor.sub), sql`${users.deletedAt} IS NULL`))
    .orderBy(desc(adminAthletes.createdAt));
  return c.json({ athletes: rows });
});

/**
 * POST /admin/athletes  body { athleteUserId, note? }
 * Aggiunge un utente come proprio atleta (l'utente NON viene notificato).
 */
adminRoutes.post('/athletes', async (c) => {
  const actor = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const athleteUserId = String(body.athleteUserId || '');
  const note = body.note ? String(body.note).slice(0, 200) : null;
  if (!athleteUserId) return c.json({ error: 'missing_athlete' }, 400);
  if (athleteUserId === actor.sub) return c.json({ error: 'cannot_follow_self' }, 400);
  // Verifica esistenza
  const [target] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, athleteUserId), sql`${users.deletedAt} IS NULL`)).limit(1);
  if (!target) return c.json({ error: 'athlete_not_found' }, 404);
  // Evita duplicati
  const [existing] = await db.select({ id: adminAthletes.id }).from(adminAthletes)
    .where(and(eq(adminAthletes.adminUserId, actor.sub), eq(adminAthletes.athleteUserId, athleteUserId))).limit(1);
  if (existing) return c.json({ ok: true, alreadyFollowed: true });
  await db.insert(adminAthletes).values({ adminUserId: actor.sub, athleteUserId, note });
  await db.insert(auditLog).values({
    userId: actor.sub, action: 'admin.add_athlete',
    meta: { athleteUserId }, ip: c.req.header('x-forwarded-for') || null,
    userAgent: c.req.header('user-agent') || null,
  });
  return c.json({ ok: true });
});

/**
 * DELETE /admin/athletes/:athleteUserId — smette di seguire
 */
adminRoutes.delete('/athletes/:athleteUserId', async (c) => {
  const actor = c.get('user');
  const athleteUserId = c.req.param('athleteUserId');
  await db.delete(adminAthletes)
    .where(and(eq(adminAthletes.adminUserId, actor.sub), eq(adminAthletes.athleteUserId, athleteUserId)));
  return c.json({ ok: true });
});

/**
 * GET /admin/users/:id/data — ultimo snapshot dati allenamento di un utente
 * (richiede che l'utente abbia il cloud backup attivo)
 */
adminRoutes.get('/users/:id/data', async (c) => {
  const id = c.req.param('id');
  const [snap] = await db
    .select({ payload: userDataSnapshots.payload, createdAt: userDataSnapshots.createdAt, size: userDataSnapshots.size })
    .from(userDataSnapshots)
    .where(eq(userDataSnapshots.userId, id))
    .orderBy(desc(userDataSnapshots.createdAt))
    .limit(1);
  if (!snap) return c.json({ snapshot: null });
  return c.json({ snapshot: { at: snap.createdAt, size: snap.size, payload: snap.payload } });
});
