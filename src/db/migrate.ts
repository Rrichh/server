/**
 * Runner migrazioni programmatico.
 * Applica le migrazioni in drizzle/ in modo idempotente e tracciato
 * (tabella __drizzle_migrations). Eseguito al boot del server, prima
 * di accettare traffico — molto più sicuro di `db:push` che può
 * droppare colonne in produzione.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, pool } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
// drizzle/ è alla radice del progetto (../../drizzle rispetto a src/db/)
const migrationsFolder = join(here, '..', '..', 'drizzle');

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
}

// Esecuzione standalone: `tsx src/db/migrate.ts`
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  runMigrations()
    .then(() => { console.log('▸ Migrazioni applicate'); return pool.end(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('✗ Migrazione fallita:', e); process.exit(1); });
}
