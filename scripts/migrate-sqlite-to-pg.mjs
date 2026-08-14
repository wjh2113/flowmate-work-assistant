import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initBilling, closeBilling } from '../server/billing.mjs';
import {
  closeSqlite,
  countTable,
  initPgStore,
  upsertRawAppMeta,
  upsertRawBuiltinModel,
  upsertRawDailyReport,
  upsertRawModelSettings,
  upsertRawPeriodReport,
  upsertRawPreferences,
  upsertRawSession,
  upsertRawTask,
  upsertRawUsageLog,
  upsertRawUser
} from '../server/pg-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const configuredPath = String(process.env.SQLITE_PATH || 'data/flowmate.db').trim();
const sqlitePath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(projectRoot, configuredPath);

if (!String(process.env.DATABASE_URL || '').trim()) {
  console.error('Missing DATABASE_URL. Run npm run setup:postgres first and add DATABASE_URL to .env');
  process.exit(1);
}

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function allRows(db, name) {
  if (!tableExists(db, name)) return [];
  return db.prepare(`SELECT * FROM ${name}`).all();
}

async function migrate() {
  console.log(`Reading SQLite: ${sqlitePath}`);
  const db = new DatabaseSync(sqlitePath, { readOnly: true });

  await initPgStore();
  // Billing columns/tables must exist before user upserts that include points/role.
  await initBilling();

  const users = allRows(db, 'users');
  for (const row of users) await upsertRawUser(row);
  console.log(`users: ${users.length}`);

  const sessions = allRows(db, 'sessions');
  for (const row of sessions) await upsertRawSession(row);
  console.log(`sessions: ${sessions.length}`);

  const tasks = allRows(db, 'tasks');
  for (const row of tasks) await upsertRawTask(row);
  console.log(`tasks: ${tasks.length}`);

  const daily = allRows(db, 'daily_reports');
  for (const row of daily) await upsertRawDailyReport(row);
  console.log(`daily_reports: ${daily.length}`);

  const period = allRows(db, 'period_reports');
  for (const row of period) await upsertRawPeriodReport(row);
  console.log(`period_reports: ${period.length}`);

  const models = allRows(db, 'user_model_settings');
  for (const row of models) await upsertRawModelSettings(row);
  console.log(`user_model_settings: ${models.length}`);

  const prefs = allRows(db, 'user_preferences');
  for (const row of prefs) await upsertRawPreferences(row);
  console.log(`user_preferences: ${prefs.length}`);

  const meta = allRows(db, 'app_meta');
  for (const row of meta) await upsertRawAppMeta(row);
  console.log(`app_meta: ${meta.length}`);

  const builtin = allRows(db, 'builtin_models');
  for (const row of builtin) await upsertRawBuiltinModel(row);
  console.log(`builtin_models: ${builtin.length}`);

  const usage = allRows(db, 'usage_logs');
  for (const row of usage) await upsertRawUsageLog(row);
  console.log(`usage_logs: ${usage.length}`);

  db.close();

  const tables = [
    'users', 'sessions', 'tasks', 'daily_reports', 'period_reports',
    'user_model_settings', 'user_preferences', 'app_meta', 'builtin_models', 'usage_logs'
  ];
  console.log('\nPostgreSQL row counts:');
  for (const name of tables) {
    console.log(`  ${name}: ${await countTable(name)}`);
  }

  await closeSqlite();
  await closeBilling();
  console.log('\nMigration complete. SQLite file was not deleted.');
  console.log('Restart the server with DATABASE_URL set to use PostgreSQL.');
}

migrate().catch(async (error) => {
  console.error('Migration failed:', error.message || error);
  try { await closeSqlite(); } catch {}
  try { await closeBilling(); } catch {}
  process.exit(1);
});
