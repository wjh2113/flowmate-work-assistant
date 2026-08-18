import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getAdminBootstrap } from './admin-bootstrap.mjs';
import { upsertBootstrapAdminUser } from './pg-store.mjs';

const { Pool } = pg;
if (!String(process.env.DATABASE_URL || '').trim()) {
  throw new Error('缺少 DATABASE_URL，请先配置本机 PostgreSQL');
}
const DEFAULT_SIGNUP_POINTS = Number(process.env.DEFAULT_SIGNUP_POINTS || 50000);

const ALLOWED_PROVIDERS = ['bailian', 'deepseek', 'moonshot', 'custom'];

/** Weights: Flash = 1.0 so 1M tokens = 1M points ≈ ¥3 (idle blended in:out 1:1). */
export const FLASH_BASELINE_WEIGHT = 1;

const DEFAULT_MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', textModel: 'deepseek-v4-flash', weight: 1.000, badge: '', sortOrder: 10 },
  { id: 'qwen-plus', name: 'Qwen-Plus', provider: 'bailian', textModel: 'qwen-plus', weight: 0.460, badge: '', sortOrder: 20 },
  { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', provider: 'bailian', textModel: 'qwen3.6-flash', weight: 1.400, badge: '', sortOrder: 30 },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', provider: 'bailian', textModel: 'qwen3.7-plus', weight: 1.660, badge: '', sortOrder: 40 },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', provider: 'bailian', textModel: 'qwen3.8-max', weight: 8.000, badge: '', sortOrder: 50 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', textModel: 'deepseek-v4-pro', weight: 3.000, badge: '', sortOrder: 60 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', provider: 'moonshot', textModel: 'kimi-k2.6', weight: 5.580, badge: '', sortOrder: 70 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', provider: 'moonshot', textModel: 'kimi-k2.7-code', weight: 5.580, badge: '', sortOrder: 80 },
  { id: 'kimi-k3', name: 'Kimi K3', provider: 'moonshot', textModel: 'kimi-k3', weight: 20.000, badge: '', sortOrder: 90 }
];

const BAILIAN_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const MOONSHOT_BASE = 'https://api.moonshot.cn/v1';
const PROVIDER_BASES = {
  bailian: BAILIAN_BASE,
  deepseek: DEEPSEEK_BASE,
  moonshot: MOONSHOT_BASE,
  custom: ''
};

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
  return PROVIDER_BASES[id] || BAILIAN_BASE;
}

function envTextKey() {
  return String(process.env.DASHSCOPE_TEXT_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
}

function envDeepseekKey() {
  return String(process.env.DEEPSEEK_API_KEY || '').trim();
}

function envMoonshotKey() {
  return String(process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '').trim();
}

function envAsrKey() {
  return String(process.env.DASHSCOPE_ASR_API_KEY || process.env.DASHSCOPE_API_KEY || '').trim();
}

function envKeyForProvider(provider) {
  if (provider === 'deepseek') return envDeepseekKey();
  if (provider === 'moonshot') return envMoonshotKey();
  if (provider === 'custom') return '';
  return envTextKey();
}

function isForeignProviderKey(stored, provider) {
  if (!stored) return false;
  if (provider === 'deepseek' || provider === 'moonshot') {
    return stored === envTextKey() || (provider === 'deepseek' ? stored === envMoonshotKey() : stored === envDeepseekKey());
  }
  return false;
}

export function resolveModelTextKey(model) {
  if (!model) return '';
  const stored = String(model.textApiKey || '').trim();
  const envKey = envKeyForProvider(model.provider);
  if (model.provider === 'deepseek' || model.provider === 'moonshot') {
    if (envKey) return envKey;
    if (stored && !isForeignProviderKey(stored, model.provider)) return stored;
    return '';
  }
  return stored || envKey;
}

function modelHasUsableKey(model) {
  if (String(model?.textApiKey || '').trim()) return true;
  if (model?.hasTextKey) return true;
  return Boolean(envKeyForProvider(model?.provider));
}

export function isSelectableBuiltinModel(model) {
  return Boolean(model && model.enabled && model.kind !== 'asr' && model.lastTestOk && modelHasUsableKey(model));
}

export function formatModelWeight(weight) {
  return (Math.round((Number(weight) || 0) * 1000) / 1000).toFixed(3);
}

export function modelSwitchCostHint(model) {
  const wLabel = formatModelWeight(model?.weight);
  return `该模型权重 ${wLabel}（Flash 权重 1.0，约 100 万 token = 100 万积分 ≈ ¥3；当前权重 ${wLabel}，相对 Flash 为 ${wLabel} 倍）`;
}

export function modelSwitchConfirmMessage(model) {
  const name = String(model?.name || model?.id || '该模型').trim();
  const wLabel = formatModelWeight(model?.weight);
  return `切换到 ${name} 后，积分 = Token × ${wLabel}（Flash 权重 1.0，约 100 万 token = 100 万积分 ≈ ¥3；当前权重 ${wLabel}，相对 Flash 为 ${wLabel} 倍）。确定？`;
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
    hasAsrKey: Boolean(row.asr_api_key),
    lastTestOk: Boolean(Number(row.last_test_ok ?? 0)),
    keyVerifiedAt: row.key_verified_at || ''
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
    await upsertBootstrapAdminUser();
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
      ALTER TABLE builtin_models ADD COLUMN IF NOT EXISTS last_test_ok INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE builtin_models ADD COLUMN IF NOT EXISTS key_verified_at TEXT NOT NULL DEFAULT '';
    `);
    await q(`UPDATE users SET signup_points_granted=1 WHERE signup_points_granted=0 AND (points_balance>0 OR id IN (SELECT DISTINCT user_id FROM usage_logs))`);
    await syncBuiltinModelCatalog();
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

async function syncBuiltinModelCatalog() {
  const asrKey = envAsrKey();
  const now = new Date().toISOString();
  for (const item of DEFAULT_MODELS) {
    const baseURL = providerBase(item.provider);
    const textKey = envKeyForProvider(item.provider);
    const asr = item.provider === 'bailian' ? asrKey : '';
    await q(
      `INSERT INTO builtin_models(id,name,provider,base_url,text_api_key,asr_api_key,text_model,asr_model,weight,badge,sort_order,enabled,kind,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name=EXCLUDED.name,provider=EXCLUDED.provider,base_url=EXCLUDED.base_url,text_model=EXCLUDED.text_model,
         weight=EXCLUDED.weight,sort_order=EXCLUDED.sort_order,kind=EXCLUDED.kind,updated_at=EXCLUDED.updated_at`,
      [item.id, item.name, item.provider, baseURL, textKey, asr, item.textModel, 'qwen3-asr-flash', item.weight, item.badge, item.sortOrder, 1, 'text', now]
    );
  }
}

/** Clear mismatched provider keys; fill empty provider keys from env. */
async function repairBuiltinModelKeys() {
  const dash = envTextKey();
  const deep = envDeepseekKey();
  const moon = envMoonshotKey();
  const asr = envAsrKey();
  if (dash) {
    await q(`UPDATE builtin_models SET text_api_key='' WHERE provider IN ('deepseek','moonshot') AND text_api_key=?`, [dash]);
  }
  if (deep) {
    await q(`UPDATE builtin_models SET text_api_key=? WHERE provider='deepseek' AND (text_api_key='' OR text_api_key IS NULL)`, [deep]);
  }
  if (moon) {
    await q(`UPDATE builtin_models SET text_api_key=? WHERE provider='moonshot' AND (text_api_key='' OR text_api_key IS NULL)`, [moon]);
  }
  if (dash) {
    await q(`UPDATE builtin_models SET text_api_key=? WHERE provider NOT IN ('deepseek','moonshot') AND (text_api_key='' OR text_api_key IS NULL)`, [dash]);
  }
  if (asr) {
    await q(`UPDATE builtin_models SET asr_api_key=? WHERE provider NOT IN ('deepseek','moonshot') AND (asr_api_key='' OR asr_api_key IS NULL)`, [asr]);
  }
  const bailianDonor = await qOne(`SELECT text_api_key, asr_api_key FROM builtin_models WHERE provider='bailian' AND text_api_key<>'' ORDER BY sort_order ASC LIMIT 1`);
  if (bailianDonor?.text_api_key) {
    await q(`UPDATE builtin_models SET text_api_key=? WHERE provider='bailian' AND (text_api_key='' OR text_api_key IS NULL)`, [bailianDonor.text_api_key]);
  }
  if (bailianDonor?.asr_api_key) {
    await q(`UPDATE builtin_models SET asr_api_key=? WHERE provider='bailian' AND (asr_api_key='' OR asr_api_key IS NULL)`, [bailianDonor.asr_api_key]);
  }
}

async function bootstrapAdmins() {
  const user = await upsertBootstrapAdminUser();
  const bootstrap = getAdminBootstrap();
  const adminId = user?.id || bootstrap.id;
  await q(`UPDATE users SET role='user' WHERE role='admin' AND id<>? AND id<>'local-legacy'`, [adminId]);
  if (adminId) await q(`UPDATE users SET role='admin' WHERE id=?`, [adminId]);
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

export async function ensureUserBillingDefaults(userId, _email = '') {
  await initBilling();
  const account = await getUserAccount(userId);
  if (!account) return null;
  // Grant signup points once; never rewrite an existing balance on every request.
  await q(
    `UPDATE users SET
       points_balance=CASE WHEN points_balance=0 THEN ? ELSE points_balance END,
       signup_points_granted=1
     WHERE id=? AND signup_points_granted=0`,
    [DEFAULT_SIGNUP_POINTS, userId]
  );
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
    provider: ALLOWED_PROVIDERS.includes(input.provider) ? input.provider : (current?.provider || 'bailian'),
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
  const incomingKey = Object.prototype.hasOwnProperty.call(input, 'textApiKey') ? String(input.textApiKey || '').trim() : '';
  const keyChanged = Boolean(incomingKey && incomingKey !== String(current?.textApiKey || ''));
  await q(
    `INSERT INTO builtin_models(id,name,provider,base_url,text_api_key,asr_api_key,text_model,asr_model,weight,badge,sort_order,enabled,kind,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=EXCLUDED.name,provider=EXCLUDED.provider,base_url=EXCLUDED.base_url,text_api_key=EXCLUDED.text_api_key,
       asr_api_key=EXCLUDED.asr_api_key,text_model=EXCLUDED.text_model,asr_model=EXCLUDED.asr_model,weight=EXCLUDED.weight,
       badge=EXCLUDED.badge,sort_order=EXCLUDED.sort_order,enabled=EXCLUDED.enabled,kind=EXCLUDED.kind,updated_at=EXCLUDED.updated_at`,
    [next.id, next.name, next.provider, next.baseURL, next.textApiKey, next.asrApiKey, next.textModel, next.asrModel, next.weight, next.badge, next.sortOrder, next.enabled, next.kind, next.updatedAt]
  );
  if (keyChanged) {
    await q(`UPDATE builtin_models SET last_test_ok=0, key_verified_at='' WHERE id=?`, [id]);
  }
  return getBuiltinModel(id, { includeSecrets: true });
}

export async function markBuiltinModelTest(id, ok) {
  await initBilling();
  const now = new Date().toISOString();
  await q(
    `UPDATE builtin_models SET last_test_ok=?, key_verified_at=?, updated_at=? WHERE id=?`,
    [ok ? 1 : 0, ok ? now : '', now, String(id)]
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
  const model = await getBuiltinModel(modelId, { includeSecrets: true });
  if (!isSelectableBuiltinModel(model)) throw new Error('模型不可用：需管理员启用、配置密钥并测试通过');
  await q(`UPDATE users SET selected_model_id=? WHERE id=?`, [model.id, String(userId)]);
  return model;
}

export async function resolveBuiltinAiConfig(userId) {
  await initBilling();
  const account = await getUserAccount(userId);
  const models = await listBuiltinModels({ enabledOnly: true, includeSecrets: true });
  const textModels = models.filter(isSelectableBuiltinModel);
  let selected = textModels.find((m) => m.id === account?.selectedModelId)
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
  if (!textKey) {
    const fallback = textModels.find((m) => m.id !== selected.id);
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
  if (Object.prototype.hasOwnProperty.call(patch, 'role')) {
    throw new Error('管理员角色由启动配置固定，不可修改');
  }
  const points = Object.prototype.hasOwnProperty.call(patch, 'pointsBalance')
    ? Math.max(0, Number(patch.pointsBalance) || 0)
    : account.pointsBalance;
  // Admin edits count as “granted” so a zeroed balance is not refilled on next login.
  await q(`UPDATE users SET points_balance=?, signup_points_granted=1 WHERE id=?`, [points, userId]);
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
