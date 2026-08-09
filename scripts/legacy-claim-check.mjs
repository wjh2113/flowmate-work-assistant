/**
 * Offline unit check for local-legacy claim transfer (temp DB).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'flowmate-legacy-'));
const dbFile = path.join(dir, 'test.db');
process.env.SQLITE_PATH = dbFile;

const store = await import(pathToFileURL(path.resolve('server/sqlite-store.mjs')).href);
const {
  LEGACY_USER_ID,
  createSqliteUser,
  saveSqliteTask,
  saveSqliteReport,
  saveSqlitePeriodReport,
  listSqliteTasks,
  loadSqliteReport,
  loadSqlitePeriodReport,
  claimSqliteLegacyData,
  autoClaimSqliteLegacyData,
  getSqliteLegacyClaimStatus,
  closeSqlite
} = store;

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond), detail: String(detail || '') });
  if (!cond) console.error(`FAIL ${name}`, detail || '');
};

// Seed legacy bucket directly
saveSqliteTask(LEGACY_USER_ID, {
  id: 'legacy-task-1', title: '历史任务', assignee: '我', due: '今天', status: 'todo',
  priority: '中', progress: 0, estimatedMinutes: 30, createdAt: new Date().toISOString()
});
saveSqliteReport(LEGACY_USER_ID, '2099-01-01', { headline: '历史日报', summary: '', completed: [], risks: [], tomorrow: [] });
saveSqlitePeriodReport(LEGACY_USER_ID, 'weekly', '2099-W02', { headline: '历史周报', summary: '', highlights: [], risks: [], next: [] });

const first = createSqliteUser({ email: `legacy1_${Date.now()}@t.local`, password: 'secret12', name: 'First' });
const second = createSqliteUser({ email: `legacy2_${Date.now()}@t.local`, password: 'secret12', name: 'Second' });

// Second user should not claim when not oldest
const denied = claimSqliteLegacyData(second.id);
ok('legacy.denySecond', denied.claimed === false && denied.reason === 'not_owner', JSON.stringify(denied));

const claimed = claimSqliteLegacyData(first.id);
ok('legacy.claimFirst', claimed.claimed === true && claimed.moved?.tasks === 1, JSON.stringify(claimed));

const tasksFirst = listSqliteTasks(first.id);
const tasksSecond = listSqliteTasks(second.id);
ok('legacy.tasksMoved', tasksFirst.some(t => t.id === 'legacy-task-1') && tasksSecond.length === 0, `first=${tasksFirst.length}`);
ok('legacy.reportMoved', loadSqliteReport(first.id, '2099-01-01')?.headline === '历史日报');
ok('legacy.periodMoved', loadSqlitePeriodReport(first.id, 'weekly', '2099-W02')?.headline === '历史周报');
ok('legacy.bucketEmpty', getSqliteLegacyClaimStatus().pendingTasks === 0);

const again = claimSqliteLegacyData(first.id);
ok('legacy.idempotent', again.claimed === false && (again.reason === 'already' || again.reason === 'empty'), JSON.stringify(again));

// Fresh DB path for auto-claim single-user case is heavy; smoke autoClaim after already claimed
const auto = autoClaimSqliteLegacyData();
ok('legacy.autoAlready', auto.claimed === false, JSON.stringify(auto));

closeSqlite();
rmSync(dir, { recursive: true, force: true });

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ passed: results.filter(r => r.ok).length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
