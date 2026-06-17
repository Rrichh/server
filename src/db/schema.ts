import { pgTable, serial, text, timestamp, integer, boolean, json, uuid, index } from 'drizzle-orm/pg-core';

// ═══════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  premium: boolean('premium').notNull().default(false),
  premiumUntil: timestamp('premium_until'),
  emailVerified: boolean('email_verified').notNull().default(false),
  // Codice atleta (formato ABC-1234-XY) — sincronizzato dal client
  athleteCode: text('athlete_code'),
  displayName: text('display_name'),
  // Anti brute-force per account: contatore tentativi falliti + lockout
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: timestamp('locked_until'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at'),
  deletedAt: timestamp('deleted_at'),
}, (t) => ({
  emailIdx: index('users_email_idx').on(t.email),
  createdAtIdx: index('users_created_at_idx').on(t.createdAt),
  athleteCodeIdx: index('users_athlete_code_idx').on(t.athleteCode),
}));

// ═══════════════════════════════════════════════════════════
// ADMIN ATHLETES — atleti seguiti dall'admin (invisibile all'utente)
// ═══════════════════════════════════════════════════════════
export const adminAthletes = pgTable('admin_athletes', {
  id: uuid('id').defaultRandom().primaryKey(),
  adminUserId: uuid('admin_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  athleteUserId: uuid('athlete_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  note: text('note'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  adminIdx: index('admin_athletes_admin_idx').on(t.adminUserId),
  athleteIdx: index('admin_athletes_athlete_idx').on(t.athleteUserId),
}));

// ═══════════════════════════════════════════════════════════
// REFRESH TOKENS
// ═══════════════════════════════════════════════════════════
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  userAgent: text('user_agent'),
  ip: text('ip'),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  userIdx: index('refresh_tokens_user_idx').on(t.userId),
  expiresIdx: index('refresh_tokens_expires_idx').on(t.expiresAt),
}));

// ═══════════════════════════════════════════════════════════
// PASSWORD RESET TOKENS (recupero password via email)
// ═══════════════════════════════════════════════════════════
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  userIdx: index('pwreset_user_idx').on(t.userId),
  hashIdx: index('pwreset_hash_idx').on(t.tokenHash),
}));

// ═══════════════════════════════════════════════════════════
// EMAIL VERIFICATION TOKENS
// ═══════════════════════════════════════════════════════════
export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  userIdx: index('emailverif_user_idx').on(t.userId),
  hashIdx: index('emailverif_hash_idx').on(t.tokenHash),
}));

// ═══════════════════════════════════════════════════════════
// USER DATA SNAPSHOTS (cloud backup)
// ═══════════════════════════════════════════════════════════
export const userDataSnapshots = pgTable('user_data_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  payload: json('payload').notNull(),
  deviceId: text('device_id'),
  size: integer('size').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  userIdx: index('snapshots_user_idx').on(t.userId),
  createdAtIdx: index('snapshots_created_at_idx').on(t.createdAt),
}));

// ═══════════════════════════════════════════════════════════
// ACTIVITIES
// ═══════════════════════════════════════════════════════════
export const activities = pgTable('activities', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  externalId: text('external_id'),
  activityDate: timestamp('activity_date'),
  distance: integer('distance'),
  duration: integer('duration'),
  tss: integer('tss'),
  np: integer('np'),
  hideBestEfforts: boolean('hide_best_efforts').default(false),
  raw: json('raw'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  userIdx: index('activities_user_idx').on(t.userId),
  dateIdx: index('activities_date_idx').on(t.activityDate),
}));

// ═══════════════════════════════════════════════════════════
// SUBSCRIPTIONS (Stripe)
// ═══════════════════════════════════════════════════════════
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  plan: text('plan'),
  status: text('status'),
  currentPeriodEnd: timestamp('current_period_end'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  userIdx: index('subscriptions_user_idx').on(t.userId),
  stripeSubIdx: index('subscriptions_stripe_sub_idx').on(t.stripeSubscriptionId),
}));

// ═══════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════
export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  meta: json('meta'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  userIdx: index('audit_user_idx').on(t.userId),
  createdAtIdx: index('audit_created_at_idx').on(t.createdAt),
}));

// Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type Activity = typeof activities.$inferSelect;
