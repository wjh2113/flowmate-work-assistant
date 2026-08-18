import pg from 'pg';
import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { getAdminBootstrap, isBootstrapAdminIdentifier } from './admin-bootstrap.mjs';

const { Pool } = pg;

export const LEGACY_USER_ID = 'local-legacy';
export const storageMode = 'postgres';
export const storageDisplay = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL);
    return `${url.hostname}:${url.port || '5432'}/${url.pathname.replace(/^\//, '')}`;
  } catch {
    return 'postgres';
  }
})();

let pool = null;
let ready = null;

function getPool() {
  if (!pool) {
    const connectionString = String(process.env.DATABASE_URL || '').trim();
    if (!connectionString) throw new Error('缺少 DATABASE_URL');
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function initPgStore() {
  if (ready) return ready;
  ready = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS user_model_settings (
        user_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'bailian',
        base_url TEXT NOT NULL DEFAULT '',
        text_api_key TEXT NOT NULL DEFAULT '',
        asr_api_key TEXT NOT NULL DEFAULT '',
        text_model TEXT NOT NULL DEFAULT 'qwen3.7-plus',
        asr_model TEXT NOT NULL DEFAULT 'qwen3-asr-flash',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY,
        avatar TEXT NOT NULL DEFAULT '',
        auto_schedule_json TEXT NOT NULL DEFAULT '',
        voice_retention_json TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        assignee TEXT NOT NULL DEFAULT '我',
        due_label TEXT NOT NULL DEFAULT '今天',
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
        priority TEXT NOT NULL DEFAULT '中' CHECK(priority IN ('高','中','低')),
        progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
        estimated_minutes INTEGER NOT NULL DEFAULT 60 CHECK(estimated_minutes BETWEEN 1 AND 1440),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        ai_status TEXT CHECK(ai_status IS NULL OR ai_status IN ('pending','failed')),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS daily_reports (
        user_id TEXT NOT NULL,
        report_date TEXT NOT NULL,
        report_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, report_date)
      );
      CREATE TABLE IF NOT EXISTS period_reports (
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('weekly','monthly')),
        period_key TEXT NOT NULL,
        report_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, kind, period_key)
      );
    `);
    await ensureLegacyUser();
    await upsertBootstrapAdminUserInternal();
  })();
  return ready;
}

function requireUserId(userId) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('缺少用户身份');
  return id;
}

function toTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    assignee: row.assignee,
    due: row.due_label,
    status: row.status,
    priority: row.priority,
    progress: Number(row.progress),
    estimatedMinutes: Number(row.estimated_minutes),
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    aiStatus: row.ai_status || undefined
  };
}

function normalizeTask(raw, current = null) {
  const now = new Date().toISOString();
  const id = String(raw?.id || current?.id || '').trim();
  const title = String(raw?.title ?? current?.title ?? '').trim().slice(0, 500);
  if (!id) throw new Error('任务 ID 不能为空');
  if (!title) throw new Error('任务内容不能为空');
  const status = ['todo', 'doing', 'done'].includes(raw?.status) ? raw.status : (current?.status || 'todo');
  const priority = ['高', '中', '低'].includes(raw?.priority) ? raw.priority : (current?.priority || '中');
  const progress = Math.max(0, Math.min(100, Math.round(Number(raw?.progress ?? current?.progress ?? 0))));
  const estimatedMinutes = Math.max(1, Math.min(1440, Math.round(Number(raw?.estimatedMinutes ?? current?.estimatedMinutes ?? 60))));
  const has = (key) => Object.prototype.hasOwnProperty.call(raw || {}, key);
  const aiStatus = has('aiStatus') ? (['pending', 'failed'].includes(raw?.aiStatus) ? raw.aiStatus : null) : (current?.aiStatus || null);
  const startedAt = has('startedAt') ? (raw.startedAt || null) : (current?.startedAt || null);
  const completedAt = has('completedAt') ? (raw.completedAt || null) : (current?.completedAt || null);
  return {
    id,
    title,
    assignee: String(raw?.assignee ?? current?.assignee ?? '我').trim().slice(0, 80) || '我',
    due: String(raw?.due ?? current?.due ?? '今天').trim().slice(0, 80) || '今天',
    status,
    priority,
    progress,
    estimatedMinutes,
    createdAt: String(current?.createdAt || raw?.createdAt || now),
    startedAt,
    completedAt,
    aiStatus,
    updatedAt: now
  };
}

export async function listTasks(userId) {
  await initPgStore();
  const { rows } = await query('SELECT * FROM tasks WHERE user_id=$1 ORDER BY created_at DESC', [requireUserId(userId)]);
  return rows.map(toTask);
}

export async function getTask(userId, id) {
  await initPgStore();
  const { rows } = await query('SELECT * FROM tasks WHERE user_id=$1 AND id=$2', [requireUserId(userId), String(id)]);
  return toTask(rows[0]);
}

export async function saveTask(userId, raw) {
  await initPgStore();
  const uid = requireUserId(userId);
  const current = await getTask(uid, raw?.id);
  const task = normalizeTask(raw, current);
  await query(`
    INSERT INTO tasks(id,user_id,title,assignee,due_label,status,priority,progress,estimated_minutes,created_at,started_at,completed_at,ai_status,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(id) DO UPDATE SET
      title=EXCLUDED.title,assignee=EXCLUDED.assignee,due_label=EXCLUDED.due_label,status=EXCLUDED.status,
      priority=EXCLUDED.priority,progress=EXCLUDED.progress,estimated_minutes=EXCLUDED.estimated_minutes,
      started_at=EXCLUDED.started_at,completed_at=EXCLUDED.completed_at,ai_status=EXCLUDED.ai_status,updated_at=EXCLUDED.updated_at
    WHERE tasks.user_id=EXCLUDED.user_id
  `, [task.id, uid, task.title, task.assignee, task.due, task.status, task.priority, task.progress, task.estimatedMinutes, task.createdAt, task.startedAt, task.completedAt, task.aiStatus, task.updatedAt]);
  const saved = await getTask(uid, task.id);
  if (!saved) throw new Error('无权保存该任务');
  return saved;
}

export async function patchTask(userId, id, changes) {
  const current = await getTask(userId, id);
  if (!current) return null;
  return saveTask(userId, { ...current, ...changes, id: current.id, createdAt: current.createdAt });
}

export async function deleteTask(userId, id) {
  await initPgStore();
  const result = await query('DELETE FROM tasks WHERE user_id=$1 AND id=$2', [requireUserId(userId), String(id)]);
  return result.rowCount > 0;
}

export async function loadDailyReport(userId, date) {
  await initPgStore();
  const { rows } = await query('SELECT report_json FROM daily_reports WHERE user_id=$1 AND report_date=$2', [requireUserId(userId), String(date)]);
  if (!rows[0]) return null;
  try { return JSON.parse(rows[0].report_json); } catch { return null; }
}

export async function saveDailyReport(userId, date, report) {
  await initPgStore();
  await query(`
    INSERT INTO daily_reports(user_id,report_date,report_json,updated_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,report_date) DO UPDATE SET report_json=EXCLUDED.report_json,updated_at=EXCLUDED.updated_at
  `, [requireUserId(userId), String(date), JSON.stringify(report), new Date().toISOString()]);
  return report;
}

export async function deleteDailyReport(userId, date) {
  await initPgStore();
  const result = await query('DELETE FROM daily_reports WHERE user_id=$1 AND report_date=$2', [requireUserId(userId), String(date)]);
  return result.rowCount > 0;
}

function normalizePeriodKind(kind) {
  const value = String(kind || '').trim();
  if (value !== 'weekly' && value !== 'monthly') throw new Error('周期类型只能是 weekly 或 monthly');
  return value;
}

export async function loadPeriodReport(userId, kind, periodKey) {
  await initPgStore();
  const { rows } = await query(
    'SELECT report_json FROM period_reports WHERE user_id=$1 AND kind=$2 AND period_key=$3',
    [requireUserId(userId), normalizePeriodKind(kind), String(periodKey)]
  );
  if (!rows[0]) return null;
  try { return JSON.parse(rows[0].report_json); } catch { return null; }
}

export async function listPeriodReports(userId, kind) {
  await initPgStore();
  const { rows } = await query(
    'SELECT kind,period_key,report_json,updated_at FROM period_reports WHERE user_id=$1 AND kind=$2 ORDER BY period_key DESC',
    [requireUserId(userId), normalizePeriodKind(kind)]
  );
  return rows.map((row) => {
    let headline = '';
    try { headline = String(JSON.parse(row.report_json)?.headline || '').trim(); } catch {}
    return { kind: row.kind, periodKey: row.period_key, updatedAt: row.updated_at, headline };
  });
}

export async function savePeriodReport(userId, kind, periodKey, report) {
  await initPgStore();
  const normalized = normalizePeriodKind(kind);
  const key = String(periodKey || '').trim();
  if (!key) throw new Error('周期键不能为空');
  await query(`
    INSERT INTO period_reports(user_id,kind,period_key,report_json,updated_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id,kind,period_key) DO UPDATE SET report_json=EXCLUDED.report_json,updated_at=EXCLUDED.updated_at
  `, [requireUserId(userId), normalized, key, JSON.stringify(report), new Date().toISOString()]);
  return report;
}

export async function deletePeriodReport(userId, kind, periodKey) {
  await initPgStore();
  const result = await query(
    'DELETE FROM period_reports WHERE user_id=$1 AND kind=$2 AND period_key=$3',
    [requireUserId(userId), normalizePeriodKind(kind), String(periodKey)]
  );
  return result.rowCount > 0;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const actual = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id || row.user_id,
    email: row.email,
    name: row.display_name || row.email?.split('@')[0] || '用户',
    createdAt: row.created_at
  };
}

async function ensureLegacyUser() {
  const { rows } = await query('SELECT id FROM users WHERE id=$1', [LEGACY_USER_ID]);
  if (rows[0]) return;
  const now = new Date().toISOString();
  await query(
    'INSERT INTO users(id,email,password_hash,display_name,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
    [LEGACY_USER_ID, 'legacy@local', '!', '历史数据', now]
  );
}

async function upsertBootstrapAdminUserInternal() {
  const bootstrap = getAdminBootstrap();
  const [salt, hash] = String(bootstrap.passwordHash || '').split(':');
  if (!salt || !hash) {
    console.warn('Admin bootstrap hash is missing; super admin was not upserted');
    return null;
  }
  const now = new Date().toISOString();
  const byId = await query('SELECT id FROM users WHERE id=$1', [bootstrap.id]);
  const byEmail = await query('SELECT id FROM users WHERE lower(email)=$1', [bootstrap.email]);
  const existingId = byId.rows[0]?.id || byEmail.rows[0]?.id;
  if (existingId) {
    await query(
      'UPDATE users SET email=$1, password_hash=$2, display_name=$3 WHERE id=$4',
      [bootstrap.email, bootstrap.passwordHash, bootstrap.displayName, existingId]
    );
    return { id: existingId, email: bootstrap.email, name: bootstrap.displayName };
  }
  await query(
    'INSERT INTO users(id,email,password_hash,display_name,created_at) VALUES($1,$2,$3,$4,$5)',
    [bootstrap.id, bootstrap.email, bootstrap.passwordHash, bootstrap.displayName, now]
  );
  return { id: bootstrap.id, email: bootstrap.email, name: bootstrap.displayName };
}

export async function upsertBootstrapAdminUser() {
  await initPgStore();
  return upsertBootstrapAdminUserInternal();
}

export async function createUser({ email, password, name }) {
  await initPgStore();
  const normalized = normalizeEmail(email);
  if (isBootstrapAdminIdentifier(normalized)) throw new Error('该账号不可注册');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('邮箱格式不正确');
  if (String(password || '').length < 6) throw new Error('密码至少 6 位');
  const existing = await query('SELECT id FROM users WHERE email=$1', [normalized]);
  if (existing.rows[0]) throw new Error('该邮箱已注册');
  const id = randomUUID();
  const displayName = String(name || normalized.split('@')[0] || '用户').trim().slice(0, 40) || '用户';
  const now = new Date().toISOString();
  await query(
    'INSERT INTO users(id,email,password_hash,display_name,created_at) VALUES($1,$2,$3,$4,$5)',
    [id, normalized, hashPassword(password), displayName, now]
  );
  return publicUser({ id, email: normalized, display_name: displayName, created_at: now });
}

export async function authenticateUser(email, password) {
  await initPgStore();
  const normalized = normalizeEmail(email);
  const bootstrap = getAdminBootstrap();
  let row = null;
  if (isBootstrapAdminIdentifier(normalized)) {
    const found = await query(
      'SELECT * FROM users WHERE id=$1 OR lower(email)=ANY($2::text[]) LIMIT 1',
      [bootstrap.id, bootstrap.aliases]
    );
    row = found.rows[0] || null;
  } else {
    const found = await query('SELECT * FROM users WHERE email=$1', [normalized]);
    row = found.rows[0] || null;
  }
  if (!row || row.id === LEGACY_USER_ID) throw new Error('邮箱或密码不正确');
  if (!verifyPassword(password, row.password_hash)) throw new Error('邮箱或密码不正确');
  return publicUser(row);
}

export async function getUser(id) {
  await initPgStore();
  if (String(id) === LEGACY_USER_ID) return null;
  const { rows } = await query('SELECT id,email,display_name,created_at FROM users WHERE id=$1', [String(id)]);
  return publicUser(rows[0]);
}

export async function createSession(userId, days = 7) {
  await initPgStore();
  await query('DELETE FROM sessions WHERE expires_at < $1', [new Date().toISOString()]);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const expires = new Date(Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
  await query(
    'INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)',
    [id, requireUserId(userId), expires, createdAt]
  );
  return { id, userId, expiresAt: expires, createdAt };
}

export async function getSession(sessionId) {
  await initPgStore();
  if (!sessionId) return null;
  await query('DELETE FROM sessions WHERE expires_at < $1', [new Date().toISOString()]);
  const { rows } = await query(`
    SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.display_name, u.created_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=$1
  `, [String(sessionId)]);
  const row = rows[0];
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await query('DELETE FROM sessions WHERE id=$1', [row.session_id]);
    return null;
  }
  return {
    id: row.session_id,
    expiresAt: row.expires_at,
    user: publicUser({ id: row.user_id, email: row.email, display_name: row.display_name, created_at: row.created_at })
  };
}

export async function deleteSession(sessionId) {
  await initPgStore();
  if (!sessionId) return false;
  const result = await query('DELETE FROM sessions WHERE id=$1', [String(sessionId)]);
  return result.rowCount > 0;
}

export async function deleteUserSessions(userId) {
  await initPgStore();
  const result = await query('DELETE FROM sessions WHERE user_id=$1', [requireUserId(userId)]);
  return result.rowCount;
}

function toUserModelSettings(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    provider: row.provider || 'bailian',
    baseURL: row.base_url || '',
    textApiKey: row.text_api_key || '',
    asrApiKey: row.asr_api_key || '',
    textModel: row.text_model || 'qwen3.7-plus',
    asrModel: row.asr_model || 'qwen3-asr-flash',
    updatedAt: row.updated_at
  };
}

export async function getUserModelSettings(userId) {
  await initPgStore();
  const { rows } = await query('SELECT * FROM user_model_settings WHERE user_id=$1', [requireUserId(userId)]);
  return toUserModelSettings(rows[0]);
}

export async function saveUserModelSettings(userId, settings) {
  await initPgStore();
  const uid = requireUserId(userId);
  const current = (await getUserModelSettings(uid)) || {};
  const next = {
    provider: String(settings?.provider || current.provider || 'bailian'),
    baseURL: String(settings?.baseURL ?? current.baseURL ?? ''),
    textApiKey: Object.prototype.hasOwnProperty.call(settings || {}, 'textApiKey') ? String(settings.textApiKey || '') : String(current.textApiKey || ''),
    asrApiKey: Object.prototype.hasOwnProperty.call(settings || {}, 'asrApiKey') ? String(settings.asrApiKey || '') : String(current.asrApiKey || ''),
    textModel: String(settings?.textModel || current.textModel || 'qwen3.7-plus'),
    asrModel: String(settings?.asrModel || current.asrModel || 'qwen3-asr-flash'),
    updatedAt: new Date().toISOString()
  };
  await query(`
    INSERT INTO user_model_settings(user_id,provider,base_url,text_api_key,asr_api_key,text_model,asr_model,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(user_id) DO UPDATE SET
      provider=EXCLUDED.provider, base_url=EXCLUDED.base_url, text_api_key=EXCLUDED.text_api_key,
      asr_api_key=EXCLUDED.asr_api_key, text_model=EXCLUDED.text_model, asr_model=EXCLUDED.asr_model, updated_at=EXCLUDED.updated_at
  `, [uid, next.provider, next.baseURL, next.textApiKey, next.asrApiKey, next.textModel, next.asrModel, next.updatedAt]);
  return getUserModelSettings(uid);
}

function parseJsonField(raw, fallback = null) {
  if (!raw) return fallback;
  try { return JSON.parse(String(raw)); } catch { return fallback; }
}

function toUserPreferences(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    avatar: String(row.avatar || ''),
    autoSchedule: parseJsonField(row.auto_schedule_json, null),
    voiceRetention: parseJsonField(row.voice_retention_json, null),
    updatedAt: row.updated_at
  };
}

export async function getUserPreferences(userId) {
  await initPgStore();
  const { rows } = await query('SELECT * FROM user_preferences WHERE user_id=$1', [requireUserId(userId)]);
  return toUserPreferences(rows[0]);
}

export async function saveUserPreferences(userId, patch = {}) {
  await initPgStore();
  const uid = requireUserId(userId);
  const current = (await getUserPreferences(uid)) || { avatar: '', autoSchedule: null, voiceRetention: null };
  const next = {
    avatar: Object.prototype.hasOwnProperty.call(patch, 'avatar') ? String(patch.avatar || '') : String(current.avatar || ''),
    autoSchedule: Object.prototype.hasOwnProperty.call(patch, 'autoSchedule') ? patch.autoSchedule : current.autoSchedule,
    voiceRetention: Object.prototype.hasOwnProperty.call(patch, 'voiceRetention') ? patch.voiceRetention : current.voiceRetention,
    updatedAt: new Date().toISOString()
  };
  if (typeof next.avatar === 'string' && next.avatar.length > 1_500_000) throw new Error('头像过大，请压缩后再试');
  await query(`
    INSERT INTO user_preferences(user_id,avatar,auto_schedule_json,voice_retention_json,updated_at)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id) DO UPDATE SET
      avatar=EXCLUDED.avatar, auto_schedule_json=EXCLUDED.auto_schedule_json,
      voice_retention_json=EXCLUDED.voice_retention_json, updated_at=EXCLUDED.updated_at
  `, [
    uid,
    next.avatar,
    next.autoSchedule == null ? '' : JSON.stringify(next.autoSchedule),
    next.voiceRetention == null ? '' : JSON.stringify(next.voiceRetention),
    next.updatedAt
  ]);
  return getUserPreferences(uid);
}

export async function listUserPreferences() {
  await initPgStore();
  const { rows } = await query('SELECT user_id,avatar,auto_schedule_json,voice_retention_json,updated_at FROM user_preferences');
  return rows.map(toUserPreferences).filter(Boolean);
}

async function getAppMeta(key) {
  const { rows } = await query('SELECT value FROM app_meta WHERE key=$1', [String(key)]);
  return rows[0] ? String(rows[0].value || '') : '';
}

async function setAppMeta(key, value, client = null) {
  const q = client ? client.query.bind(client) : query;
  await q(`
    INSERT INTO app_meta(key,value,updated_at) VALUES($1,$2,$3)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at
  `, [String(key), String(value ?? ''), new Date().toISOString()]);
}

export async function getLegacyClaimStatus() {
  await initPgStore();
  const [tasks, daily, period] = await Promise.all([
    query('SELECT COUNT(*)::int AS n FROM tasks WHERE user_id=$1', [LEGACY_USER_ID]),
    query('SELECT COUNT(*)::int AS n FROM daily_reports WHERE user_id=$1', [LEGACY_USER_ID]),
    query('SELECT COUNT(*)::int AS n FROM period_reports WHERE user_id=$1', [LEGACY_USER_ID])
  ]);
  return {
    claimedBy: (await getAppMeta('legacy_claimed_by')) || '',
    pendingTasks: Number(tasks.rows[0]?.n || 0),
    pendingDaily: Number(daily.rows[0]?.n || 0),
    pendingPeriod: Number(period.rows[0]?.n || 0)
  };
}

export async function claimLegacyData(userId, { forceOwner = false } = {}) {
  await initPgStore();
  const uid = requireUserId(userId);
  if (uid === LEGACY_USER_ID) return { claimed: false, reason: 'invalid_user' };
  const existing = await getAppMeta('legacy_claimed_by');
  if (existing && existing !== uid) return { claimed: false, reason: 'already', by: existing };
  if (existing === uid) {
    const leftover = await getLegacyClaimStatus();
    if (!leftover.pendingTasks && !leftover.pendingDaily && !leftover.pendingPeriod) {
      return { claimed: false, reason: 'already', by: uid };
    }
  }

  await ensureLegacyUser();
  const beforeStatus = await getLegacyClaimStatus();
  const before = {
    tasks: beforeStatus.pendingTasks,
    daily: beforeStatus.pendingDaily,
    period: beforeStatus.pendingPeriod
  };
  if (!before.tasks && !before.daily && !before.period) {
    await setAppMeta('legacy_claimed_by', uid);
    return { claimed: false, reason: 'empty', by: uid, moved: before };
  }

  if (!forceOwner) {
    const { rows: countRows } = await query('SELECT COUNT(*)::int AS n FROM users WHERE id<>$1', [LEGACY_USER_ID]);
    const realUsers = Number(countRows[0]?.n || 0);
    if (realUsers > 1) {
      const { rows: oldestRows } = await query('SELECT id FROM users WHERE id<>$1 ORDER BY created_at ASC LIMIT 1', [LEGACY_USER_ID]);
      const oldest = oldestRows[0]?.id;
      if (oldest && oldest !== uid) return { claimed: false, reason: 'not_owner', by: oldest, moved: before };
    }
  }

  const moved = await withTransaction(async (client) => {
    let dailyMoved = 0;
    const dailyRows = await client.query('SELECT report_date FROM daily_reports WHERE user_id=$1', [LEGACY_USER_ID]);
    for (const row of dailyRows.rows) {
      const has = await client.query('SELECT 1 AS ok FROM daily_reports WHERE user_id=$1 AND report_date=$2', [uid, row.report_date]);
      if (has.rows[0]) {
        await client.query('DELETE FROM daily_reports WHERE user_id=$1 AND report_date=$2', [LEGACY_USER_ID, row.report_date]);
      } else {
        await client.query('UPDATE daily_reports SET user_id=$1 WHERE user_id=$2 AND report_date=$3', [uid, LEGACY_USER_ID, row.report_date]);
        dailyMoved += 1;
      }
    }

    let periodMoved = 0;
    const periodRows = await client.query('SELECT kind, period_key FROM period_reports WHERE user_id=$1', [LEGACY_USER_ID]);
    for (const row of periodRows.rows) {
      const has = await client.query(
        'SELECT 1 AS ok FROM period_reports WHERE user_id=$1 AND kind=$2 AND period_key=$3',
        [uid, row.kind, row.period_key]
      );
      if (has.rows[0]) {
        await client.query('DELETE FROM period_reports WHERE user_id=$1 AND kind=$2 AND period_key=$3', [LEGACY_USER_ID, row.kind, row.period_key]);
      } else {
        await client.query(
          'UPDATE period_reports SET user_id=$1 WHERE user_id=$2 AND kind=$3 AND period_key=$4',
          [uid, LEGACY_USER_ID, row.kind, row.period_key]
        );
        periodMoved += 1;
      }
    }

    const taskResult = await client.query('UPDATE tasks SET user_id=$1 WHERE user_id=$2', [uid, LEGACY_USER_ID]);
    await setAppMeta('legacy_claimed_by', uid, client);
    return { tasks: taskResult.rowCount || 0, daily: dailyMoved, period: periodMoved };
  });

  return { claimed: true, by: uid, moved, before };
}

export async function autoClaimLegacyData() {
  await initPgStore();
  const status = await getLegacyClaimStatus();
  if (status.claimedBy && !status.pendingTasks && !status.pendingDaily && !status.pendingPeriod) {
    return { claimed: false, reason: 'already', by: status.claimedBy };
  }
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM users WHERE id<>$1', [LEGACY_USER_ID]);
  const realUsers = Number(rows[0]?.n || 0);
  if (realUsers !== 1) return { claimed: false, reason: realUsers === 0 ? 'no_users' : 'multi_user', pending: status };
  const { rows: oldestRows } = await query('SELECT id FROM users WHERE id<>$1 ORDER BY created_at ASC LIMIT 1', [LEGACY_USER_ID]);
  const oldest = oldestRows[0]?.id;
  if (!oldest) return { claimed: false, reason: 'no_users' };
  return claimLegacyData(oldest, { forceOwner: true });
}

export async function closeStore() {
  if (!pool) return;
  const current = pool;
  pool = null;
  ready = null;
  await current.end();
}
