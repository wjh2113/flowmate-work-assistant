import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
if (!String(process.env.DATABASE_URL || '').trim()) {
  throw new Error('缺少 DATABASE_URL，请先配置本机 PostgreSQL');
}
const DEFAULT_SIGNUP_POINTS = Number(process.env.DEFAULT_SIGNUP_POINTS || 50000);
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const DEFAULT_MODELS = [
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', provider: 'deepseek', textModel: 'deepseek-v4-flash', weight: 0.05, badge: '', sortOrder: 10 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', provider: 'deepseek', textModel: 'deepseek-v4-pro', weight: 0.13, badge: '', sortOrder: 20 },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', provider: 'bailian', textModel: 'qwen3.7-plus', weight: 0.79, badge: '', sortOrder: 30 },
  { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', provider: 'bailian', textModel: 'qwen3.6-flash', weight: 0.25, badge: '', sortOrder: 40 },
  { id: 'qwen-plus', name: 'Qwen-Plus', provider: 'bailian', textModel: 'qwen-plus', weight: 0.95, badge: '', sortOrder: 50 }
];

const BAILIAN_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEEPSEEK_BASE = 'https://api.deepseek.com';

let pgPool = null;
let ready = null;

function getPg() {
  if (!pgPool) pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  return pgPool;
}

async function q(text, params = []) {
  let i = 0;
  const sql = text.replace(/\?/g, () => `$${++i}`);
  return (await getPg().query(sql, params)).rows;
}

async function qOne(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

async function withTx(fn) {
  const client = await getPg().connect();
  try {
    await client.query('BEGIN');
    const txQ = async (text, params = []) => {
      let i = 0;
      const sql = text.replace(/\?/g, () => `$${++i}`);
      return (await client.query(sql, params)).rows;
    };
    const result = await fn({ q: txQ, qOne: async (text, params) => (await txQ(text, params))[0] || null });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function providerBase(provider, baseURL) {
  const id = String(provider || 'bailian');
  if (String(baseURL || '').trim()) return String(baseURL).replace(/\/$/, '');
  if (id === 'deepseek') return DEEPSEEK_BASE;
  return BAILIAN_BASE;
}

function envTextKey() {
  return String(process.env.DASHSCOPE_TEXT_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
}

function envDeepseekKey() {
  return String(process.env.DEEPSEEK_API_KEY || '').trim();
}

function envAsrKey() {
  return String(process.env.DASHSCOPE_ASR_API_KEY || process.env.DASHSCOPE_API_KEY || '').trim();
}

function envKeyForProvider(provider) {
  return provider === 'deepseek' ? envDeepseekKey() : envTextKey();
}

function resolveModelTextKey(model) {
  if (!model) return '';
  const stored = String(model.textApiKey || '').trim();
  const envKey = envKeyForProvider(model.provider);
  // Prefer provider-matching env key; avoid using a DashScope key against DeepSeek.
  if (model.provider === 'deepseek') {
    if (envKey) return envKey;
    if (stored && stored !== envTextKey()) return stored;
    return '';
  }
  return stored || envKey;
}

function toModel(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  const model = {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseURL: row.base_url || '',
    textModel: row.text_model,
    asrModel: row.asr_model || 'qwen3-asr-flash',
    weight: Number(row.weight ?? 1),
    badge: row.badge || '',
    sortOrder: Number(row.sort_order || 0),
    enabled: Boolean(Number(row.enabled ?? 1)),
    kind: row.kind || 'text',
    updatedAt: row.updated_at,
    hasTextKey: Boolean(row.text_api_key),
    hasAsrKey: Boolean(row.asr_api_key)
  };
  if (includeSecrets) {
    model.textApiKey = row.text_api_key || '';
    model.asrApiKey = row.asr_api_key || '';
  }
  return model;
}

export async function initBilling() {
  if (ready) return ready;
  ready = (async () => {
    await getPg().query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS points_balance DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS selected_model_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_points_granted INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS builtin_models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'bailian',
        base_url TEXT NOT NULL DEFAULT '',
        text_api_key TEXT NOT NULL DEFAULT '',
        asr_api_key TEXT NOT NULL DEFAULT '',
        text_model TEXT NOT NULL,
        asr_model TEXT NOT NULL DEFAULT 'qwen3-asr-flash',
        weight DOUBLE PRECISION NOT NULL DEFAULT 1,
        badge TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL DEFAULT 'text',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT '',
        model_name TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        weight DOUBLE PRECISION NOT NULL DEFAULT 1,
        points DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_logs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at DESC);
    `);
    await q(`UPDATE users SET signup_points_granted=1 WHERE signup_points_granted=0 AND (points_balance>0 OR id IN (SELECT DISTINCT user_id FROM usage_logs))`);
    await seedBuiltinModelsIfEmpty();
    await repairBuiltinModelKeys();
    await bootstrapAdmins();
  })();
  return ready;
}

export async function closeBilling() {
  ready = null;
  if (pgPool) {
    const current = pgPool;
    pgPool = null;
    await current.end();
  }
}

async function seedBuiltinModelsIfEmpty() {
  const countRow = await qOne('SELECT COUNT(*)::int AS n FROM builtin_models');
  if (Number(countRow?.n || 0) > 0) return;
  const asrKey = envAsrKey();
  const now = new Date().toISOString();
  for (const item of DEFAULT_MODELS) {
    const baseURL = item.provider === 'deepseek' ? DEEPSEEK_BASE : BAILIAN_BASE;
    const textKey = envKeyForProvider(item.provider);
    await q(
      `INSERT INTO builtin_models(id,name,provider,base_url,text_api_key,asr_api_key,text_model,asr_model,weight,badge,sort_order,enabled,kind,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [item.id, item.name, item.provider, baseURL, textKey, item.provider === 'deepseek' ? '' : asrKey, item.textModel, 'qwen3-asr-flash', item.weight, item.badge, item.sortOrder, 1, 'text', now]
    );
  }
}

/** Clear DashScope keys wrongly stored on DeepSeek rows; fill empty provider keys from env. */
async function repairBuiltinModelKeys() {
  const dash = envTextKey();
  const deep = envDeepseekKey();
  const asr = envAsrKey();
  if (dash) {
    await q(`UPDATE builtin_models SET text_api_key='' WHERE provider='deepseek' AND text_api_key=?`, [dash]);
  }
  if (deep) {
    await q(`UPDATE builtin_models SET text_api_key=? WHERE provider='deepseek' AND (text_api_key='' OR text_api_key IS NULL)`, [deep]);
  }
  if (dash) {
    await q(`UPDATE builtin_models SET text_api_key=? WHERE provider<>'deepseek' AND (text_api_key='' OR text_api_key IS NULL)`, [dash]);
  }
  if (asr) {
    await q(`UPDATE builtin_models SET asr_api_key=? WHERE provider<>'deepseek' AND (asr_api_key='' OR asr_api_key IS NULL)`, [asr]);
  }
}

async function bootstrapAdmins() {
  if (!ADMIN_EMAILS.length) {
    await promoteOldestUserIfNoAdmin();
    return;
  }
  for (const email of ADMIN_EMAILS) {
    await q(`UPDATE users SET role='admin' WHERE lower(email)=?`, [email]);
  }
}

async function promoteOldestUserIfNoAdmin() {
  if (ADMIN_EMAILS.length) return;
  const admins = await qOne(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND id<>'local-legacy'`);
  if (Number(admins?.n || 0) > 0) return;
  const first = await qOne(`SELECT id FROM users WHERE id<>'local-legacy' ORDER BY created_at ASC LIMIT 1`);
  if (first?.id) await q(`UPDATE users SET role='admin' WHERE id=?`, [first.id]);
}

export function calcPoints(totalTokens, weight) {
  const tokens = Math.max(0, Number(totalTokens) || 0);
  const w = Math.max(0, Number(weight) || 0);
  return Math.round(tokens * w * 1000) / 1000;
}

export async function getUserAccount(userId) {
  await initBilling();
  const row = await qOne(
    `SELECT id,email,display_name,created_at,role,points_balance,selected_model_id FROM users WHERE id=?`,
    [String(userId)]
  );
  if (!row || row.id === 'local-legacy') return null;
  return {
    id: row.id,
    email: row.email,
    name: row.display_name || row.email?.split('@')[0] || '用户',
    createdAt: row.created_at,
    role: row.role === 'admin' ? 'admin' : 'user',
    pointsBalance: Number(row.points_balance || 0),
    selectedModelId: row.selected_model_id || ''
  };
}

export async function ensureUserBillingDefaults(userId, email = '') {
  await initBilling();
  const account = await getUserAccount(userId);
  if (!account) return null;
  const emailLower = String(email || account.email || '').toLowerCase();
  if (ADMIN_EMAILS.includes(emailLower) && account.role !== 'admin') {
    await q(`UPDATE users SET role='admin' WHERE id=?`, [userId]);
  }
  // Grant signup points once; never rewrite an existing balance on every request.
  await q(
    `UPDATE users SET
       points_balance=CASE WHEN points_balance=0 THEN ? ELSE points_balance END,
       signup_points_granted=1
     WHERE id=? AND signup_points_granted=0`,
    [DEFAULT_SIGNUP_POINTS, userId]
  );
  // First real user becomes admin when ADMIN_EMAILS is empty (covers register-after-boot).
  await promoteOldestUserIfNoAdmin();
  return getUserAccount(userId);
}

export async function listBuiltinModels({ enabledOnly = false, includeSecrets = false } = {}) {
  await initBilling();
  const rows = await q(
    enabledOnly
      ? `SELECT * FROM builtin_models WHERE enabled=1 ORDER BY sort_order ASC, name ASC`
      : `SELECT * FROM builtin_models ORDER BY sort_order ASC, name ASC`
  );
  return rows.map((row) => toModel(row, { includeSecrets }));
}

export async function getBuiltinModel(id, { includeSecrets = false } = {}) {
  await initBilling();
  const row = await qOne(`SELECT * FROM builtin_models WHERE id=?`, [String(id || '')]);
  return toModel(row, { includeSecrets });
}

export async function saveBuiltinModel(input = {}) {
  await initBilling();
  const id = String(input.id || randomUUID()).trim();
  if (!id) throw new Error('模型 ID 不能为空');
  const current = await getBuiltinModel(id, { includeSecrets: true });
  const now = new Date().toISOString();
  const next = {
    id,
    name: String(input.name || current?.name || id).trim().slice(0, 80) || id,
    provider: ['bailian', 'deepseek', 'custom'].includes(input.provider) ? input.provider : (current?.provider || 'bailian'),
    baseURL: String(input.baseURL ?? current?.baseURL ?? providerBase(input.provider || current?.provider)).trim(),
    textApiKey: (() => {
      if (!Object.prototype.hasOwnProperty.call(input, 'textApiKey')) return String(current?.textApiKey || '');
      const next = String(input.textApiKey || '');
      return next || String(current?.textApiKey || '');
    })(),
    asrApiKey: (() => {
      if (!Object.prototype.hasOwnProperty.call(input, 'asrApiKey')) return String(current?.asrApiKey || '');
      const next = String(input.asrApiKey || '');
      return next || String(current?.asrApiKey || '');
    })(),
    textModel: String(input.textModel || current?.textModel || id).trim(),
    asrModel: String(input.asrModel || current?.asrModel || 'qwen3-asr-flash').trim(),
    weight: Math.max(0, Number(input.weight ?? current?.weight ?? 1)),
    badge: String(input.badge ?? current?.badge ?? '').trim().slice(0, 40),
    sortOrder: Math.round(Number(input.sortOrder ?? current?.sortOrder ?? 0)),
    enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
    kind: input.kind === 'asr' ? 'asr' : 'text',
    updatedAt: now
  };
  await q(
    `INSERT INTO builtin_models(id,name,provider,base_url,text_api_key,asr_api_key,text_model,asr_model,weight,badge,sort_order,enabled,kind,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=EXCLUDED.name,provider=EXCLUDED.provider,base_url=EXCLUDED.base_url,text_api_key=EXCLUDED.text_api_key,
       asr_api_key=EXCLUDED.asr_api_key,text_model=EXCLUDED.text_model,asr_model=EXCLUDED.asr_model,weight=EXCLUDED.weight,
       badge=EXCLUDED.badge,sort_order=EXCLUDED.sort_order,enabled=EXCLUDED.enabled,kind=EXCLUDED.kind,updated_at=EXCLUDED.updated_at`,
    [next.id, next.name, next.provider, next.baseURL, next.textApiKey, next.asrApiKey, next.textModel, next.asrModel, next.weight, next.badge, next.sortOrder, next.enabled, next.kind, next.updatedAt]
  );
  return getBuiltinModel(id, { includeSecrets: true });
}

export async function deleteBuiltinModel(id) {
  await initBilling();
  await q(`DELETE FROM builtin_models WHERE id=?`, [String(id)]);
  return true;
}

export async function setUserSelectedModel(userId, modelId) {
  await initBilling();
  const model = await getBuiltinModel(modelId);
  if (!model || !model.enabled || model.kind === 'asr') throw new Error('模型不可用');
  await q(`UPDATE users SET selected_model_id=? WHERE id=?`, [model.id, String(userId)]);
  return model;
}

export async function resolveBuiltinAiConfig(userId) {
  await initBilling();
  const account = await getUserAccount(userId);
  const models = await listBuiltinModels({ enabledOnly: true, includeSecrets: true });
  const textModels = models.filter((m) => m.kind !== 'asr');
  const withKey = (m) => Boolean(resolveModelTextKey(m));
  let selected = textModels.find((m) => m.id === account?.selectedModelId && withKey(m))
    || textModels.find((m) => m.id === account?.selectedModelId)
    || textModels.find(withKey)
    || textModels[0]
    || null;
  if (!selected) {
    return {
      source: 'builtin',
      configured: false,
      provider: 'bailian',
      baseURL: BAILIAN_BASE,
      textApiKey: '',
      asrApiKey: '',
      textModel: '',
      asrModel: 'qwen3-asr-flash',
      modelId: '',
      modelName: '',
      weight: 1,
      resolveAsrKey: () => ''
    };
  }
  const textKey = resolveModelTextKey(selected);
  // Selected model has no usable key — fall back to any configured builtin model.
  if (!textKey) {
    const fallback = textModels.find((m) => m.id !== selected.id && withKey(m));
    if (fallback) selected = fallback;
  }
  const finalTextKey = resolveModelTextKey(selected);
  if (account && userId && !account.selectedModelId && selected?.id) {
    await q(`UPDATE users SET selected_model_id=? WHERE id=?`, [selected.id, userId]);
  }
  const asr = models.find((m) => m.kind === 'asr' && m.enabled)
    || textModels.find((m) => m.provider === 'bailian' && (m.asrApiKey || m.textApiKey || envAsrKey()))
    || selected;
  const asrKey = (asr?.asrApiKey || (asr?.provider === 'bailian' ? asr?.textApiKey : '') || envAsrKey() || (selected.provider === 'bailian' ? finalTextKey : ''));
  return {
    source: 'builtin',
    configured: Boolean(finalTextKey),
    provider: selected.provider,
    baseURL: providerBase(selected.provider, selected.baseURL),
    textApiKey: finalTextKey,
    asrApiKey: asr?.asrApiKey || '',
    textModel: selected.textModel,
    asrModel: asr?.asrModel || 'qwen3-asr-flash',
    modelId: selected.id,
    modelName: selected.name,
    weight: selected.weight,
    resolveAsrKey: () => asrKey || ''
  };
}

export async function chargeUsage(userId, {
  modelId = '',
  modelName = '',
  weight = 1,
  action = '',
  usage = null
} = {}) {
  await initBilling();
  if (!userId) return null;
  const prompt = Math.max(0, Number(usage?.prompt_tokens || usage?.input_tokens || 0));
  const completion = Math.max(0, Number(usage?.completion_tokens || usage?.output_tokens || 0));
  let total = Math.max(0, Number(usage?.total_tokens || 0));
  if (!total) total = prompt + completion;
  // Providers that omit usage must not be free — charge a conservative estimate.
  if (!total) total = 500;
  const points = calcPoints(total, weight);
  const id = randomUUID();
  const now = new Date().toISOString();
  return withTx(async ({ q: txQ, qOne: txOne }) => {
    const row = await txOne(`SELECT id, points_balance FROM users WHERE id=? FOR UPDATE`, [userId]);
    if (!row) throw new Error('用户不存在');
    const updated = await txQ(
      `UPDATE users SET points_balance = points_balance - ?
       WHERE id=? AND points_balance >= ?
       RETURNING points_balance`,
      [points, userId, points]
    );
    if (!updated.length) throw new Error('积分不足，请联系管理员充值');
    const nextBalance = Math.round(Number(updated[0].points_balance) * 1000) / 1000;
    await txQ(
      `INSERT INTO usage_logs(id,user_id,model_id,model_name,action,prompt_tokens,completion_tokens,total_tokens,weight,points,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id, userId, modelId, modelName, action, prompt, completion, total, weight, points, now]
    );
    return { id, points, totalTokens: total, promptTokens: prompt, completionTokens: completion, balance: nextBalance, weight };
  });
}

export async function assertEnoughPoints(userId, estimateTokens = 500) {
  const account = await getUserAccount(userId);
  if (!account) throw new Error('用户不存在');
  const ai = await resolveBuiltinAiConfig(userId);
  const need = calcPoints(estimateTokens, ai.weight || 1);
  if (account.pointsBalance < need) throw new Error('积分不足，请联系管理员充值');
  return account;
}

export async function listUsersAdmin() {
  await initBilling();
  const rows = await q(
    `SELECT id,email,display_name,created_at,role,points_balance,selected_model_id
     FROM users WHERE id<>'local-legacy' ORDER BY created_at DESC`
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.display_name || '',
    createdAt: row.created_at,
    role: row.role === 'admin' ? 'admin' : 'user',
    pointsBalance: Number(row.points_balance || 0),
    selectedModelId: row.selected_model_id || ''
  }));
}

export async function updateUserAdmin(userId, patch = {}) {
  await initBilling();
  const account = await getUserAccount(userId);
  if (!account) throw new Error('用户不存在');
  const role = patch.role === 'admin' || patch.role === 'user' ? patch.role : account.role;
  const points = Object.prototype.hasOwnProperty.call(patch, 'pointsBalance')
    ? Math.max(0, Number(patch.pointsBalance) || 0)
    : account.pointsBalance;
  // Admin edits count as “granted” so a zeroed balance is not refilled on next login.
  await q(`UPDATE users SET role=?, points_balance=?, signup_points_granted=1 WHERE id=?`, [role, points, userId]);
  return getUserAccount(userId);
}

export async function listUsageLogs({ userId = '', limit = 50 } = {}) {
  await initBilling();
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = userId
    ? await q(
      `SELECT * FROM usage_logs WHERE user_id=? ORDER BY created_at DESC LIMIT ${lim}`,
      [String(userId)]
    )
    : await q(`SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT ${lim}`);
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    modelId: row.model_id,
    modelName: row.model_name,
    action: row.action,
    promptTokens: Number(row.prompt_tokens || 0),
    completionTokens: Number(row.completion_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
    weight: Number(row.weight || 0),
    points: Number(row.points || 0),
    createdAt: row.created_at
  }));
}

export async function adminDashboardStats() {
  await initBilling();
  const users = await qOne(`SELECT COUNT(*)::int AS n FROM users WHERE id<>'local-legacy'`);
  const usage = await qOne(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_tokens),0)::float AS tokens, COALESCE(SUM(points),0)::float AS points FROM usage_logs`);
  const models = await qOne(`SELECT COUNT(*)::int AS n FROM builtin_models WHERE enabled=1`);
  return {
    userCount: Number(users?.n || 0),
    enabledModelCount: Number(models?.n || 0),
    usageCount: Number(usage?.n || 0),
    totalTokens: Number(usage?.tokens || 0),
    totalPoints: Number(usage?.points || 0)
  };
}
