import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { Converter } from 'opencc-js/t2cn';
import { authenticateUser, autoClaimLegacyData, claimLegacyData, closeStore, createSession, createUser, deletePeriodReport, deleteDailyReport, deleteSession, deleteTask, getSession, getTask, getUserPreferences, initStore, LEGACY_USER_ID, listPeriodReports, listTasks, loadPeriodReport, loadDailyReport, patchTask, savePeriodReport, saveDailyReport, saveTask, saveUserPreferences, storageDisplay, storageMode } from './store.mjs';
import { isBootstrapAdminUser } from './admin-bootstrap.mjs';
import {
  adminDashboardStats,
  assertEnoughPoints,
  chargeUsage,
  closeBilling,
  deleteBuiltinModel,
  ensureUserBillingDefaults,
  getUserAccount,
  initBilling,
  getBuiltinModel,
  isSelectableBuiltinModel,
  listBuiltinModels,
  listUsageLogs,
  listUsersAdmin,
  markBuiltinModelTest,
  modelSwitchCostHint,
  modelSwitchConfirmMessage,
  resolveBuiltinAiConfig,
  resolveModelTextKey,
  saveBuiltinModel,
  setUserSelectedModel,
  updateUserAdmin
} from './billing.mjs';
import { estimateModelPrice, weightEstimateMessage } from './model-prices.mjs';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const port = Number(process.env.PORT || 8787);
const SESSION_COOKIE = 'flowmate_session';
const ADMIN_SESSION_COOKIE = 'flowmate_admin_session';
const SESSION_DAYS = 7;
const BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';
const PROVIDER_PRESETS = {
  bailian: { id: 'bailian', label: '阿里云百炼', baseURL: BAILIAN_BASE_URL },
  deepseek: { id: 'deepseek', label: 'DeepSeek', baseURL: DEEPSEEK_BASE_URL },
  moonshot: { id: 'moonshot', label: 'Moonshot Kimi', baseURL: MOONSHOT_BASE_URL },
  custom: { id: 'custom', label: '自定义', baseURL: '' }
};
const PRESET_TEXT_MODELS = {
  bailian: ['qwen3.8-max', 'qwen3.7-plus', 'qwen-plus', 'qwen3.6-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  moonshot: ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3'],
  custom: []
};
const ALLOWED_ASR_MODELS = ['qwen3-asr-flash', 'qwen3-asr-flash-2026-02-10'];

let textApiKey = process.env.DASHSCOPE_TEXT_API_KEY || process.env.DASHSCOPE_API_KEY || '';
let asrApiKey = process.env.DASHSCOPE_ASR_API_KEY || '';
let textProvider = normalizeTextProvider(process.env.TEXT_API_PROVIDER || inferProviderFromBaseURL(process.env.TEXT_API_BASE_URL || process.env.DASHSCOPE_BASE_URL));
let textBaseURL = normalizeBaseURL(process.env.TEXT_API_BASE_URL || process.env.DASHSCOPE_BASE_URL || PROVIDER_PRESETS[textProvider].baseURL || BAILIAN_BASE_URL);
let textModel = process.env.QWEN_TEXT_MODEL || (textProvider === 'deepseek' ? 'deepseek-v4-flash' : 'qwen3.7-plus');
let asrModel = process.env.QWEN_ASR_MODEL || 'qwen3-asr-flash';
const maskKey = (key) => (key ? `••••${key.slice(-4)}` : '');
const isValidApiKey = (key) => /^sk-[A-Za-z0-9_\-]{8,}$/.test(String(key || '').trim()) || String(key || '').trim().length >= 16;

function emptyAiConfig(overrides = {}) {
  const provider = normalizeTextProvider(overrides.provider || textProvider);
  return {
    source: 'user',
    provider,
    baseURL: resolveProviderBaseURL(provider, overrides.baseURL || (provider === textProvider ? textBaseURL : '')),
    textApiKey: '',
    asrApiKey: '',
    textModel: overrides.textModel || textModel || (provider === 'deepseek' ? 'deepseek-v4-flash' : 'qwen3.7-plus'),
    asrModel: overrides.asrModel || asrModel || 'qwen3-asr-flash',
    resolveAsrKey: () => ''
  };
}

/** Built-in models + admin API keys; users only select a model. */
async function resolveAiConfig(userId) {
  const ai = await resolveBuiltinAiConfig(userId);
  return { ...ai, userId: userId || '' };
}

async function enrichUser(user) {
  if (!user?.id) return user;
  const account = await ensureUserBillingDefaults(user.id, user.email);
  if (!account) return user;
  return {
    ...user,
    role: account.role,
    pointsBalance: account.pointsBalance,
    selectedModelId: account.selectedModelId
  };
}

async function adoptLegacyVoiceDirs(userId) {
  if (!userId || userId === LEGACY_USER_ID) return;
  const target = userVoiceJobsDir(userId);
  await mkdir(target, { recursive: true });
  for (const sourceId of [LEGACY_USER_ID, 'anonymous']) {
    const source = userVoiceJobsDir(sourceId);
    if (source === target) continue;
    let files = [];
    try { files = await readdir(source); } catch { continue; }
    for (const file of files) {
      const from = path.join(source, file);
      const to = path.join(target, file);
      try {
        await stat(to);
        continue; // keep existing target file
      } catch {}
      try {
        await rename(from, to);
        if (file.endsWith('.json')) {
          try {
            const job = JSON.parse(await readFile(to, 'utf8'));
            if (job?.id) {
              job.userId = userId;
              voiceJobs.set(job.id, job);
              await writeFile(to, JSON.stringify(job), { encoding: 'utf8', mode: 0o600 });
            }
          } catch {}
        }
      } catch (error) {
        console.error(`迁移历史语音目录失败 ${sourceId}/${file}`, error);
      }
    }
  }
}

function applyLegacyClaim(userId) {
  return claimLegacyData(userId).then((result) => {
    if (result?.claimed || result?.reason === 'empty' || result?.by === userId) {
      void adoptLegacyVoiceDirs(userId);
    }
    return result;
  }).catch((error) => {
    console.error('认领历史数据失败', error);
    return { claimed: false, reason: 'error', message: error?.message };
  });
}

function normalizeTextProvider(value) {
  const id = String(value || '').trim().toLowerCase();
  return PROVIDER_PRESETS[id] ? id : 'bailian';
}

function inferProviderFromBaseURL(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('deepseek.com')) return 'deepseek';
  if (value.includes('moonshot.cn') || value.includes('moonshot.ai') || value.includes('platform.kimi')) return 'moonshot';
  if (value.includes('dashscope.aliyuncs.com')) return 'bailian';
  if (value.trim()) return 'custom';
  return 'bailian';
}

function normalizeBaseURL(url) {
  const value = String(url || '').trim().replace(/\/$/, '');
  if (!value) throw new Error('模型 Base URL 不能为空');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('模型 Base URL 格式不正确'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('模型 Base URL 必须以 http:// 或 https:// 开头');
  return value;
}

function normalizeTextModelName(model) {
  const value = String(model || '').trim();
  if (!value || value.length > 80) throw new Error('模型名称不合法');
  if (!/^[A-Za-z0-9._:/-]+$/.test(value)) throw new Error('模型名称含有不支持的字符');
  return value;
}

function providerLabel(id = textProvider) {
  return PROVIDER_PRESETS[normalizeTextProvider(id)]?.label || '自定义';
}

function resolveProviderBaseURL(provider, rawBaseURL) {
  const id = normalizeTextProvider(provider);
  if (id === 'custom') return normalizeBaseURL(rawBaseURL);
  const fallback = PROVIDER_PRESETS[id].baseURL;
  const value = String(rawBaseURL || '').trim();
  return normalizeBaseURL(value || fallback);
}
let supabaseUrl = process.env.VITE_SUPABASE_URL || '';
let supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || '';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
const voiceJobsDir = path.resolve(__dirname, '../data/voice-jobs');
const reportEditJobsDir = path.resolve(__dirname, '../data/report-edit-jobs');
const jobSettingsPath = path.resolve(__dirname, '../data/job-settings.json');
const DEFAULT_VOICE_RETENTION = { enabled: true, retentionDays: 7, times: ['03:00'] };
let jobSettings = { voiceRetention: { ...DEFAULT_VOICE_RETENTION, times: [...DEFAULT_VOICE_RETENTION.times] }, doneSlots: {} };
const voiceJobs = new Map();
const reportEditJobs = new Map();
const runningVoiceJobs = new Set();
const runningReportEditJobs = new Set();
const convertToSimplified = Converter({ from: 'tw', to: 'cn' });

function simplify(value) {
  if (typeof value === 'string') return convertToSimplified(value);
  if (Array.isArray(value)) return value.map(simplify);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, simplify(item)]));
  return value;
}

app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', 1);

function isRealCloudConfig(url, key) {
  const u = String(url || '').trim();
  const k = String(key || '').trim();
  if (!u || !k) return false;
  if (/your-project|example\.supabase|your-anon|CHANGE_ME/i.test(`${u} ${k}`)) return false;
  return true;
}

function cloudMode() {
  const authMode = String(process.env.AUTH_MODE || process.env.FLOWMATE_AUTH || '').trim().toLowerCase();
  if (authMode === 'local') return false;
  if (authMode === 'supabase') return isRealCloudConfig(supabaseUrl, supabaseAnonKey);
  // PostgreSQL is the primary store; do not block local password login with leftover Supabase env.
  if (String(process.env.DATABASE_URL || '').trim()) return false;
  return isRealCloudConfig(supabaseUrl, supabaseAnonKey);
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) out[decodeURIComponent(trimmed)] = '';
    else out[decodeURIComponent(trimmed.slice(0, index))] = decodeURIComponent(trimmed.slice(index + 1));
  }
  return out;
}

function requestIsHttps(req) {
  if (req?.secure) return true;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function setNamedCookie(res, name, sessionId, expiresAt, req) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const parts = [`${name}=${encodeURIComponent(sessionId)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (requestIsHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearNamedCookie(res, name, req) {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (requestIsHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function setSessionCookie(res, sessionId, expiresAt, req) {
  setNamedCookie(res, SESSION_COOKIE, sessionId, expiresAt, req);
}

function clearSessionCookie(res, req) {
  clearNamedCookie(res, SESSION_COOKIE, req);
}

function setAdminSessionCookie(res, sessionId, expiresAt, req) {
  setNamedCookie(res, ADMIN_SESSION_COOKIE, sessionId, expiresAt, req);
}

function clearAdminSessionCookie(res, req) {
  clearNamedCookie(res, ADMIN_SESSION_COOKIE, req);
}

function requireUser(req, res, next) {
  if (cloudMode()) {
    req.user = { id: 'cloud-shared', email: '', name: '云端' };
    return next();
  }
  Promise.resolve()
    .then(async () => {
      const session = await getSession(parseCookies(req)[SESSION_COOKIE]);
      if (!session?.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录' });
      req.user = await enrichUser(session.user);
      req.sessionId = session.id;
      next();
    })
    .catch((error) => {
      console.error(error);
      res.status(500).json({ message: '登录状态校验失败' });
    });
}

function requireAdmin(req, res, next) {
  Promise.resolve()
    .then(async () => {
      const session = await getSession(parseCookies(req)[ADMIN_SESSION_COOKIE]);
      if (!session?.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录管理后台' });
      const user = await enrichUser(session.user);
      if (user?.role !== 'admin' || !isBootstrapAdminUser(user)) {
        return res.status(403).json({ error: 'FORBIDDEN', message: '需要管理员权限' });
      }
      req.user = user;
      req.sessionId = session.id;
      next();
    })
    .catch((error) => {
      console.error(error);
      res.status(500).json({ message: '管理员登录状态校验失败' });
    });
}

function requireTextAi(req, res, next) {
  Promise.resolve()
    .then(async () => {
      const ai = await resolveAiConfig(req.user?.id);
      if (!ai.textApiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED', message: '管理员尚未配置内置大模型 API Key' });
      await assertEnoughPoints(req.user.id);
      req.ai = ai;
      next();
    })
    .catch((error) => {
      const msg = error?.message || '读取模型配置失败';
      const status = /积分不足/.test(msg) ? 402 : 500;
      console.error(error);
      res.status(status).json({ message: msg });
    });
}

function requireVoiceAi(req, res, next) {
  Promise.resolve()
    .then(async () => {
      const ai = await resolveAiConfig(req.user?.id);
      if (!ai.textApiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED', message: '管理员尚未配置内置大模型 API Key' });
      if (!ai.resolveAsrKey()) return res.status(503).json({ error: 'ASR_NOT_CONFIGURED', message: '管理员尚未配置语音识别 API Key' });
      await assertEnoughPoints(req.user.id);
      req.ai = ai;
      next();
    })
    .catch((error) => {
      const msg = error?.message || '读取模型配置失败';
      const status = /积分不足/.test(msg) ? 402 : 500;
      console.error(error);
      res.status(status).json({ message: msg });
    });
}

/** @deprecated prefer requireTextAi / requireVoiceAi */
function requireQwen(req, res, next) {
  return requireTextAi(req, res, next);
}

function userVoiceJobsDir(userId) {
  return path.join(voiceJobsDir, String(userId || 'anonymous'));
}

async function requireSettingsAccess(req, res, next) {
  const remote = req.ip || req.socket.remoteAddress || '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return next();
  const anonKey = supabaseAnonKey;
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!supabaseUrl || !anonKey || !token) return res.status(403).json({ message: '只有本机或已登录的团队管理员可以修改模型设置' });
  try {
    const headers = { apikey: anonKey, Authorization: `Bearer ${token}` };
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers });
    const user = await userResponse.json();
    if (!userResponse.ok || !user.id) throw new Error('登录状态无效');
    const roleResponse = await fetch(`${supabaseUrl}/rest/v1/team_members?select=role&user_id=eq.${user.id}&role=in.(owner,admin)&limit=1`, { headers });
    const roles = await roleResponse.json();
    if (!roleResponse.ok || !Array.isArray(roles) || !roles.length) return res.status(403).json({ message: '只有团队管理员可以修改模型设置' });
    req.settingsUser = user;
    next();
  } catch (error) {
    res.status(403).json({ message: error?.message || '无法验证管理员身份' });
  }
}

async function persistEnv(updates) {
  let source = '';
  try { source = await readFile(envPath, 'utf8'); } catch {}
  const lines = source.split(/\r?\n/).filter(Boolean);
  for (const [key, rawValue] of Object.entries(updates)) {
    const value = String(rawValue).replace(/[\r\n]/g, '');
    const index = lines.findIndex(line => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  await writeFile(envPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

function normalizeCloudConfig(rawUrl, rawKey) {
  const url = String(rawUrl || '').trim().replace(/\/$/, '');
  const anonKey = String(rawKey || '').trim();
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error('Supabase 项目地址格式不正确'); }
  const isLocal = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
  if (parsedUrl.protocol !== 'https:' && !isLocal) throw new Error('Supabase 项目地址必须使用 HTTPS');
  if (anonKey.length < 20) throw new Error('公开密钥格式不正确');
  if (/^sb_secret_/i.test(anonKey)) throw new Error('不能使用 secret key，请填写 publishable key');
  if (anonKey.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url').toString('utf8'));
      if (payload?.role === 'service_role') throw new Error('不能使用 service_role 密钥，请填写 anon key');
    } catch (error) {
      if (error?.message?.includes('service_role')) throw error;
    }
  }
  return { url, anonKey };
}

async function testCloudConnection(url, anonKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const endpoint = new URL('/auth/v1/settings', `${url}/`);
    const response = await fetch(endpoint, { headers: { apikey: anonKey }, signal: controller.signal });
    if (!response.ok) throw new Error(`Supabase 拒绝了连接（${response.status}），请检查项目地址和公开密钥`);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('连接 Supabase 超时，请检查服务器网络');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function qwenChat({ model = textModel, messages, responseFormat, extra = {}, apiKey = textApiKey, baseURL = textBaseURL, timeoutMs = 90_000 }) {
  if (!apiKey) throw new Error('尚未配置对应的 API Key');
  const endpoint = `${String(baseURL || textBaseURL).replace(/\/$/, '')}/chat/completions`;
  const waitMs = Math.max(15_000, Number(timeoutMs) || 90_000);
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),waitMs);
  try{
    const response = await fetch(endpoint, {
      method: 'POST',signal:controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, ...(responseFormat ? { response_format: responseFormat } : {}), ...extra })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `模型接口请求失败 (${response.status})`);
    return data;
  }catch(error){if(error?.name==='AbortError')throw new Error(`模型处理超过${Math.round(waitMs/1000)}秒，已停止本次请求，请点击任务重试`);throw error}
  finally{clearTimeout(timer)}
}

function messageText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(x => x?.text || x?.transcript || '').join('');
  return '';
}

function parseJSON(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

function normalizePlanItems(items, limit = 5) {
  return (Array.isArray(items) ? items : []).slice(0, limit).map(item => ({
    title: String(item?.title || '').trim(),
    reason: String(item?.reason || '').trim(),
    priority: ['高', '中', '低'].includes(item?.priority) ? item.priority : '中',
    suggestedTime: String(item?.suggestedTime || '').trim() || '上午'
  })).filter(item => item.title);
}

function normalizeDailyReport(report) {
  return simplify({
    headline: String(report?.headline || '今日工作小结'),
    summary: String(report?.summary || ''),
    completed: Array.isArray(report?.completed) ? report.completed.map(item => String(item)).filter(Boolean) : [],
    risks: Array.isArray(report?.risks) ? report.risks.map(item => String(item)).filter(Boolean) : [],
    tomorrow: normalizePlanItems(report?.tomorrow, 5)
  });
}

function normalizePeriodReport(report, limit = 8) {
  return simplify({
    headline: String(report?.headline || '工作复盘'),
    summary: String(report?.summary || ''),
    highlights: Array.isArray(report?.highlights) ? report.highlights.map(item => String(item)).filter(Boolean) : [],
    risks: Array.isArray(report?.risks) ? report.risks.map(item => String(item)).filter(Boolean) : [],
    next: normalizePlanItems(report?.next, limit)
  });
}

function isPeriodKey(kind, key) {
  if (kind === 'weekly') return /^\d{4}-W\d{2}$/.test(String(key || ''));
  if (kind === 'monthly') return /^\d{4}-\d{2}$/.test(String(key || ''));
  return false;
}

function normalizeParsedTask(parsed, transcript) {
  return simplify({
    title: String(parsed?.title || transcript), assignee: String(parsed?.assignee || '我'),
    due: String(parsed?.due || '今天'), priority: ['高','中','低'].includes(parsed?.priority) ? parsed.priority : '中',
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0.8)),
    estimatedMinutes: Math.max(15, Math.min(480, Math.round(Number(parsed?.estimatedMinutes) || 60)))
  });
}

function normalizeParsedTasks(parsed, transcript) {
  const source=Array.isArray(parsed?.tasks)?parsed.tasks:Array.isArray(parsed)?parsed:[parsed?.task||parsed];
  const tasks=source.filter(item=>item&&typeof item==='object'&&String(item.title||'').trim()).slice(0,10).map(item=>normalizeParsedTask(item,transcript));
  return tasks.length?tasks:[normalizeParsedTask(parsed?.task||parsed,transcript)];
}

function withAi(ai, opts = {}) {
  return {
    ...opts,
    model: opts.model ?? ai.textModel,
    apiKey: opts.apiKey ?? ai.textApiKey,
    baseURL: opts.baseURL ?? ai.baseURL
  };
}

async function qwenChatForAi(ai, opts = {}, action = 'chat') {
  if (ai?.userId) await assertEnoughPoints(ai.userId);
  const data = await qwenChat(withAi(ai, opts));
  if (ai?.userId) {
    await chargeUsage(ai.userId, {
      modelId: ai.modelId,
      modelName: ai.modelName,
      weight: ai.weight,
      action,
      usage: data?.usage
    });
  }
  return data;
}

async function parseTasks(transcript, ai) {
  const data = await qwenChatForAi(ai, {
    messages: [
      { role: 'system', content: '你是中文工作任务拆解助手。把一段口语整理为一个或多个独立可执行任务。一句话中出现多个并列目标、不同课程、不同交付物或先后要完成的事项时，必须拆成多项；例如“学习日语直播课、英语雅思和AI练习”应拆成3项。不要把同一个目标的普通操作步骤过度拆分。最多10项，不要虚构信息；未提负责人时写“我”，未提日期时写“今天”。每个标题只保留一个动作和一个清晰对象。根据各任务复杂度分别估算时长。只输出合法 JSON，不要 Markdown。JSON结构：tasks为数组，每项包含title字符串、assignee字符串、due简短中文、priority为高/中/低、confidence为0到1数字、estimatedMinutes为15到480之间的整数分钟数。' },
      { role: 'user', content: `当前日期：${new Date().toLocaleDateString('zh-CN')}\n当前用户：我\n语音内容：${transcript}` }
    ],
    responseFormat: { type: 'json_object' }
  }, 'parse_tasks');
  const parsed = parseJSON(messageText(data));
  return normalizeParsedTasks(parsed, transcript);
}

async function parseVoiceCommand(transcript, availableTasks = [], reports = {}, ai) {
  const tasks = availableTasks.slice(0, 100).map(task => ({
    id: String(task.id || ''), title: String(task.title || ''), assignee: String(task.assignee || '我'),
    due: String(task.due || '今天'), status: ['todo','doing','done'].includes(task.status) ? task.status : 'todo',
    priority: ['高','中','低'].includes(task.priority) ? task.priority : '中',
    estimatedMinutes: Math.max(1, Number(task.estimatedMinutes) || 60)
  })).filter(task => task.id && task.title);
  const reportMeta = {
    daily: Boolean(reports?.daily),
    weekly: Boolean(reports?.weekly),
    monthly: Boolean(reports?.monthly)
  };
  const data = await qwenChatForAi(ai, {
    messages: [
      { role: 'system', content: '你是中文工作助手的统一语音指令解析器。先判断用户意图属于哪一类：1) edit_report：修改今日复盘/日报、本周周报、本月月报（含小结、亮点、风险、明日/下周/下月计划等表述）；2) create：新建待办任务；3) update：修改已有任务；4) clarify：目标不明确。提及“今日复盘/今日小结/日报/明天建议”→reportKind=daily；“周报/本周复盘/下周计划”→weekly；“月报/本月复盘/下月计划”→monthly。若同时像任务又像复盘，优先看是否明确点名复盘/周报/月报。edit_report 时 instruction 写清具体修改意见。修改任务时只能使用候选任务真实 id，不明确则 clarify。新建任务最多10项。只输出合法JSON，不要Markdown。JSON字段：action为create/update/clarify/edit_report；reportKind为daily/weekly/monthly或空；instruction字符串；updates数组(targetTaskId,changes)；tasks新建数组；message简短中文；confidence为0到1。' },
      { role: 'user', content: `当前日期：${new Date().toLocaleDateString('zh-CN')}\n当前用户：我\n已有复盘：${JSON.stringify(reportMeta)}\n候选任务：${JSON.stringify(tasks)}\n语音指令：${transcript}` }
    ],
    responseFormat: { type: 'json_object' }
  }, 'parse_command');
  const parsed = parseJSON(messageText(data));
  if (parsed.action === 'edit_report') {
    const reportKind = ['daily', 'weekly', 'monthly'].includes(parsed.reportKind) ? parsed.reportKind : '';
    const instruction = String(parsed.instruction || transcript || '').trim();
    if (!reportKind) return simplify({ action: 'clarify', targetTaskId: null, changes: {}, message: '请说明要改的是今日复盘、本周周报还是本月月报', confidence: 0 });
    if (!instruction) return simplify({ action: 'clarify', targetTaskId: null, changes: {}, message: '请说明要对复盘做哪些修改', confidence: 0 });
    if (!reports?.[reportKind]) {
      const label = reportKind === 'daily' ? '今日复盘' : reportKind === 'weekly' ? '本周周报' : '本月月报';
      return simplify({ action: 'clarify', targetTaskId: null, changes: {}, message: `还没有${label}，请先生成后再用语音修改`, confidence: 0 });
    }
    return simplify({ action: 'edit_report', reportKind, instruction, targetTaskId: null, changes: {}, message: String(parsed.message || `正在修改${reportKind === 'daily' ? '今日复盘' : reportKind === 'weekly' ? '本周周报' : '本月月报'}`), confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.8)) });
  }
  if (parsed.action === 'update') {
    const requested=Array.isArray(parsed.updates)&&parsed.updates.length?parsed.updates:[{targetTaskId:parsed.targetTaskId,changes:parsed.changes}];
    const updates=[];
    for(const entry of requested.slice(0,10)){
      const target=tasks.find(task=>task.id===String(entry?.targetTaskId||''));const source=entry?.changes&&typeof entry.changes==='object'?entry.changes:{};const changes={};
      if(typeof source.title==='string'&&source.title.trim())changes.title=source.title.trim().slice(0,500);
      if(typeof source.assignee==='string'&&source.assignee.trim())changes.assignee=source.assignee.trim().slice(0,80);
      if(typeof source.due==='string'&&source.due.trim())changes.due=source.due.trim().slice(0,80);
      if(['高','中','低'].includes(source.priority))changes.priority=source.priority;
      if(['todo','doing','done'].includes(source.status))changes.status=source.status;
      if(Number(source.estimatedMinutes)>0)changes.estimatedMinutes=Math.max(1,Math.min(1440,Math.round(Number(source.estimatedMinutes))));
      if(target&&Object.keys(changes).length&&!updates.some(item=>item.targetTaskId===target.id))updates.push({targetTaskId:target.id,changes});
    }
    if(updates.length)return simplify({action:'update',updates,targetTaskId:updates[0].targetTaskId,changes:updates[0].changes,message:String(parsed.message||`已修改${updates.length}项任务`),confidence:Math.max(0,Math.min(1,Number(parsed.confidence)||0.8))});
    return { action: 'clarify', targetTaskId: null, changes: {}, message: '没有找到唯一的目标任务，请说出更完整的任务名称和修改内容', confidence: 0 };
  }
  if (parsed.action === 'clarify') return simplify({ action: 'clarify', targetTaskId: null, changes: {}, message: String(parsed.message || '请说出要新建的任务，或说明要修改哪条任务/哪份复盘'), confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)) });
  const createdTasks=normalizeParsedTasks(parsed,transcript);
  return { action: 'create', targetTaskId: null, changes: {}, tasks: createdTasks, task: createdTasks[0], message: String(parsed.message || `创建${createdTasks.length}项任务`), confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || Number(createdTasks[0]?.confidence) || 0.8)) };
}

async function transcribeAudio(buffer, mime = 'audio/webm', availableTasks = [], onStage = async()=>{}, reports = {}, ai) {
  await onStage('transcribing');
  const apiKey = ai.resolveAsrKey();
  if (!apiKey) throw new Error('尚未配置语音识别 API Key（非百炼文本提供商时需单独填写百炼 ASR 密钥）');
  const audio = `data:${mime};base64,${buffer.toString('base64')}`;
  const data = await qwenChatForAi({
    ...ai,
    textApiKey: apiKey,
    textModel: ai.asrModel,
    baseURL: BAILIAN_BASE_URL
  }, {
    model: ai.asrModel,
    apiKey,
    baseURL: BAILIAN_BASE_URL,
    messages: [
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: audio } }] }
    ],
    extra: { stream: false, asr_options: { language: 'zh', enable_itn: true } }
  }, 'asr');
  if (ai?.userId && data?.usage) {
    // already charged in qwenChatForAi
  }
  const transcript = convertToSimplified(messageText(data).trim());
  if (!transcript) throw new Error('语音模型没有返回转写内容');
  await onStage('understanding',{transcript});
  const command = await parseVoiceCommand(transcript, availableTasks, reports, ai);
  if (command.action === 'edit_report') return { transcript, command, tasks: [], task: null };
  if (command.action === 'create') return { transcript, command, tasks: command.tasks || [], task: command.task || null };
  return { transcript, command, tasks: [], task: null };
}

async function parseTasksFromImage(buffer, mime = 'image/jpeg', ai) {
  const type = String(mime || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
  const dataUrl = `data:${type};base64,${buffer.toString('base64')}`;
  let data;
  try {
    data = await qwenChatForAi(ai, {
      timeoutMs: 120_000,
      messages: [
        { role: 'system', content: '你是中文工作任务识别助手。用户会上传周报、月报、手写便签或工作清单的照片。请从图片中识别需要执行的工作任务，整理为独立可执行待办。只提取待办任务，不要把已完成事项、总结性描述或纯背景信息当成任务。未提负责人时写“我”，未提日期时根据报表周期写“本周”“本月”或“今天”。最多10项，不要虚构。只输出合法 JSON，不要 Markdown。JSON结构：tasks为数组，每项包含title字符串、assignee字符串、due简短中文、priority为高/中/低、confidence为0到1数字、estimatedMinutes为15到480之间的整数分钟数。' },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: `当前日期：${new Date().toLocaleDateString('zh-CN')}\n当前用户：我\n请识别图中的工作任务。` }
        ] }
      ],
      responseFormat: { type: 'json_object' }
    }, 'parse_photo_tasks');
  } catch (error) {
    const raw = error?.message || '';
    if (/InvalidParameter|does not support this input|does not support.*(image|vision|multimodal)|vision|multimodal/i.test(raw)) {
      throw new Error('当前模型无法识别图片。请在「设置 → 大模型」切换到通义千问等视觉模型后再试');
    }
    throw error;
  }
  const parsed = parseJSON(messageText(data));
  const source = Array.isArray(parsed?.tasks) ? parsed.tasks : Array.isArray(parsed) ? parsed : [parsed?.task || parsed];
  const tasks = source
    .filter(item => item && typeof item === 'object' && String(item.title || '').trim())
    .slice(0, 10)
    .map(item => normalizeParsedTask(item, ''));
  if (!tasks.length) throw new Error('没有从图片中识别到可执行的工作任务，请拍更清晰的周报、月报或清单后再试');
  const transcript = convertToSimplified(tasks.map(item => item.title).join('；'));
  return {
    transcript,
    command: {
      action: 'create',
      targetTaskId: null,
      changes: {},
      tasks,
      task: tasks[0],
      message: `从照片识别出${tasks.length}项任务`,
      confidence: Math.max(0, Math.min(1, Number(tasks[0]?.confidence) || 0.8))
    },
    tasks,
    task: tasks[0]
  };
}

function voiceErrorMessage(error) {
  const message = error?.message || '';
  if (/does not support.*(image|vision|multimodal)|vision.*(not support|unsupported)|image.*(not support|unsupported)|invalid.*image|content.*image/i.test(message)) {
    return '当前模型无法识别图片。请在「设置 → 大模型」切换到通义千问等视觉模型后再试';
  }
  if (/InvalidParameter|does not support this input/i.test(message)) return '语音模型无法读取这段录音，请重新录制后再试';
  return message || '语音识别失败';
}

function audioExtension(mime = '') {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

function imageExtension(mime = '') {
  const type = String(mime || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

function voiceJobPath(jobOrUserId, id) {
  if (jobOrUserId && typeof jobOrUserId === 'object') {
    const job = jobOrUserId;
    return path.join(userVoiceJobsDir(job.userId), `${job.id}.json`);
  }
  return path.join(userVoiceJobsDir(jobOrUserId), `${id}.json`);
}

function voiceAudioPath(job) {
  return path.join(userVoiceJobsDir(job.userId), job.audioFile);
}

function voiceImagePath(job) {
  return path.join(userVoiceJobsDir(job.userId), job.imageFile);
}

async function unlinkVoiceMedia(job) {
  if (job?.audioFile) await unlink(voiceAudioPath(job)).catch(() => {});
  if (job?.imageFile) await unlink(voiceImagePath(job)).catch(() => {});
}

async function persistVoiceJob(job) {
  job.updatedAt = new Date().toISOString();
  voiceJobs.set(job.id, job);
  const dir = userVoiceJobsDir(job.userId);
  await mkdir(dir, { recursive: true });
  await writeFile(voiceJobPath(job), JSON.stringify(job), { encoding: 'utf8', mode: 0o600 });
}

function publicVoiceJob(job) {
  const { audioFile, imageFile, availableTasks: _availableTasks, reports: _reports, ...safeJob } = job;
  return {
    ...safeJob,
    hasAudio: Boolean(audioFile),
    hasImage: Boolean(imageFile),
    source: job.source || (imageFile ? 'photo' : audioFile ? 'audio' : 'text')
  };
}

function normalizeJobTimes(times, fallback = ['03:00']) {
  const list = (Array.isArray(times) ? times : [])
    .map(item => String(item || '').trim())
    .filter(item => /^\d{1,2}:\d{2}$/.test(item))
    .map(item => {
      const [h, m] = item.split(':').map(Number);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    });
  const unique = [...new Set(list)].sort();
  return unique.length ? unique.slice(0, 6) : [...fallback];
}

function normalizeVoiceRetentionSettings(raw = {}) {
  const days = Number(raw.retentionDays);
  return {
    enabled: raw.enabled !== false,
    retentionDays: Number.isInteger(days) && days >= 1 && days <= 90 ? days : DEFAULT_VOICE_RETENTION.retentionDays,
    times: normalizeJobTimes(raw.times, DEFAULT_VOICE_RETENTION.times)
  };
}

function voiceRetentionMs(days = jobSettings.voiceRetention.retentionDays) {
  return Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
}

async function loadJobSettings() {
  try {
    const raw = JSON.parse(await readFile(jobSettingsPath, 'utf8'));
    jobSettings = {
      voiceRetention: normalizeVoiceRetentionSettings(raw?.voiceRetention),
      doneSlots: raw?.doneSlots && typeof raw.doneSlots === 'object' ? raw.doneSlots : {}
    };
  } catch {
    jobSettings = { voiceRetention: normalizeVoiceRetentionSettings(), doneSlots: {} };
  }
  return jobSettings;
}

async function persistJobSettings() {
  await mkdir(path.dirname(jobSettingsPath), { recursive: true });
  await writeFile(jobSettingsPath, JSON.stringify(jobSettings, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function latestDueJobTime(times, now = new Date()) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let due = null;
  for (const time of normalizeJobTimes(times)) {
    const [h, m] = time.split(':').map(Number);
    const minutes = h * 60 + m;
    if (nowMinutes >= minutes) due = time;
  }
  return due;
}

function voiceJobListItem(job) {
  const command = job.command || null;
  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  const action = command?.action || (tasks.length ? 'create' : '');
  const summary = (() => {
    if (job.error) return job.error;
    if (command?.message) return command.message;
    if (action === 'edit_report') return `修改${command?.reportKind === 'weekly' ? '周报' : command?.reportKind === 'monthly' ? '月报' : '今日复盘'}`;
    if (action === 'update') {
      const count = command?.updates?.length || (command?.targetTaskId ? 1 : 0);
      return count > 1 ? `更新了 ${count} 项任务` : '更新了任务';
    }
    if (action === 'clarify') return command?.message || '需要补充说明';
    if (tasks.length > 1) return `创建了 ${tasks.length} 项任务`;
    if (tasks[0]?.title) return `创建：${tasks[0].title}`;
    if (job.task?.title) return `创建：${job.task.title}`;
    return job.transcript || '语音指令';
  })();
  const retentionMs = voiceRetentionMs();
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    source: job.source || (job.imageFile ? 'photo' : job.audioFile ? 'audio' : 'text'),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    transcript: job.transcript || '',
    action,
    reportKind: job.reportKind || command?.reportKind || '',
    summary,
    error: job.error || '',
    hasAudio: Boolean(job.audioFile),
    hasImage: Boolean(job.imageFile),
    expiresAt: job.createdAt ? new Date(Date.parse(job.createdAt) + retentionMs).toISOString() : ''
  };
}

async function recordTextVoiceJob({ userId, transcript, command, tasks = [], editedReport = null, reportKind = '', status = 'completed', error = '', cleared = false }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    userId: userId || 'anonymous',
    status,
    stage: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'completed',
    source: 'text',
    mime: '',
    audioFile: '',
    createdAt: now,
    updatedAt: now,
    availableTasks: [],
    reports: {},
    transcript,
    tasks,
    task: tasks[0] || null,
    command,
    editedReport,
    cleared: Boolean(cleared || (command?.action === 'edit_report' && editedReport == null && status === 'completed')),
    reportKind,
    error
  };
  await persistVoiceJob(job);
  return job;
}

async function purgeExpiredVoiceJobsInDir(dir, retentionDays) {
  const cutoff = Date.now() - voiceRetentionMs(retentionDays);
  let removed = 0;
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      if (file.endsWith('.json')) {
        const job = JSON.parse(await readFile(filePath, 'utf8'));
        const ts = Date.parse(job?.createdAt || job?.updatedAt || '') || 0;
        if (!ts || ts >= cutoff) continue;
        if (job?.id) voiceJobs.delete(job.id);
        await unlink(filePath).catch(() => {});
        if (job?.audioFile) await unlink(path.join(dir, job.audioFile)).catch(() => {});
        if (job?.imageFile) await unlink(path.join(dir, job.imageFile)).catch(() => {});
        removed += 1;
      } else {
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) {
          await unlink(filePath).catch(() => {});
          removed += 1;
        }
      }
    } catch (error) {
      console.error(`清理语音指令失败 ${file}`, error);
    }
  }
  return removed;
}

async function purgeExpiredVoiceJobs(retentionDays = jobSettings.voiceRetention.retentionDays, userId = null) {
  const days = Math.max(1, Number(retentionDays) || 7);
  let removed = 0;
  await mkdir(voiceJobsDir, { recursive: true });
  if (userId) {
    removed += await purgeExpiredVoiceJobsInDir(userVoiceJobsDir(userId), days);
    return { removed, retentionDays: days, userId };
  }
  const entries = await readdir(voiceJobsDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(voiceJobsDir, entry.name);
    try {
      if (entry.isDirectory()) {
        const prefs = await getUserPreferences(entry.name);
        const userDays = prefs?.voiceRetention?.retentionDays || days;
        removed += await purgeExpiredVoiceJobsInDir(full, userDays);
        continue;
      }
      // legacy flat files — only when sweeping all users
      if (entry.name.endsWith('.json')) {
        const job = JSON.parse(await readFile(full, 'utf8'));
        const ts = Date.parse(job?.createdAt || job?.updatedAt || '') || 0;
        if (!ts || ts >= Date.now() - voiceRetentionMs(days)) continue;
        if (job?.id) voiceJobs.delete(job.id);
        await unlink(full).catch(() => {});
        if (job?.audioFile) await unlink(path.join(voiceJobsDir, job.audioFile)).catch(() => {});
        if (job?.imageFile) await unlink(path.join(voiceJobsDir, job.imageFile)).catch(() => {});
        removed += 1;
      }
    } catch (error) {
      console.error(`清理语音指令失败 ${entry.name}`, error);
    }
  }
  return { removed, retentionDays: days };
}

async function userVoiceRetention(userId) {
  const prefs = userId ? await getUserPreferences(userId) : null;
  if (prefs?.voiceRetention) return normalizeVoiceRetentionSettings(prefs.voiceRetention);
  return normalizeVoiceRetentionSettings(jobSettings.voiceRetention);
}

async function runVoiceRetentionJobIfDue(force = false, userId = null) {
  if (userId) {
    const schedule = await userVoiceRetention(userId);
    if (!force && !schedule.enabled) return null;
    const now = new Date();
    const time = force ? (schedule.times[0] || '03:00') : latestDueJobTime(schedule.times, now);
    if (!time) return null;
    const dateKey = localDateKey(now);
    const slotKey = `voiceRetention:${userId}:${dateKey}-${time.replace(':', '')}`;
    if (!force && jobSettings.doneSlots?.[slotKey]) return null;
    const result = await purgeExpiredVoiceJobs(schedule.retentionDays, userId);
    jobSettings.doneSlots = { ...(jobSettings.doneSlots || {}), [slotKey]: new Date().toISOString() };
    await persistJobSettings();
    return { ...result, slotKey, time, voiceRetention: schedule };
  }
  // Server sweep: each user dir with that user's retention (fallback to default)
  const schedule = jobSettings.voiceRetention;
  if (!force && !schedule.enabled) return null;
  const now = new Date();
  const time = force ? (schedule.times[0] || '03:00') : latestDueJobTime(schedule.times, now);
  if (!time) return null;
  const dateKey = localDateKey(now);
  const slotKey = `voiceRetention:all:${dateKey}-${time.replace(':', '')}`;
  if (!force && jobSettings.doneSlots?.[slotKey]) return null;
  const result = await purgeExpiredVoiceJobs(schedule.retentionDays, null);
  const doneSlots = { ...(jobSettings.doneSlots || {}), [slotKey]: new Date().toISOString() };
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(doneSlots)) {
    const ts = Date.parse(value || '') || 0;
    if (ts && ts < cutoff) delete doneSlots[key];
  }
  jobSettings.doneSlots = doneSlots;
  await persistJobSettings();
  return { ...result, slotKey, time };
}

async function persistVoiceResult(job,result){
  if(supabaseUrl)return [];
  const userId=job.userId;
  if(!userId)return [];
  const command=result.command;
  if(command?.action==='edit_report'||command?.action==='clarify'){await deleteTask(userId,job.id);return []}
  if(command?.action==='update'){
    await deleteTask(userId,job.id);const requested=command.updates?.length?command.updates:[{targetTaskId:command.targetTaskId,changes:command.changes}];const ids=[];
    for(const entry of requested){const current=await getTask(userId,entry.targetTaskId);if(!current)continue;const changes={...(entry.changes||{})};const now=new Date().toISOString();
      if(changes.status==='doing'){changes.progress=current.progress>0&&current.progress<100?current.progress:50;changes.startedAt=current.startedAt||now;changes.completedAt=null}
      if(changes.status==='done'){changes.progress=100;changes.startedAt=current.startedAt||now;changes.completedAt=now}
      if(changes.status==='todo'){changes.progress=0;changes.startedAt=null;changes.completedAt=null}
      await patchTask(userId,current.id,changes);ids.push(current.id)}
    return ids;
  }
  const parsedTasks=(result.tasks?.length?result.tasks:command?.tasks?.length?command.tasks:result.task?[result.task]:[]).slice(0,10);
  const ids=[];
  for(let index=0;index<parsedTasks.length;index+=1){
    const parsed=parsedTasks[index];
    const id=index===0?job.id:`${job.id}-${index+1}`;
    await saveTask(userId,{id,title:parsed.title||result.transcript||(job.source==='photo'?'拍照任务':'语音任务'),assignee:parsed.assignee||'我',due:parsed.due||'今天',status:'todo',priority:parsed.priority||'中',progress:0,estimatedMinutes:parsed.estimatedMinutes||60,createdAt:job.createdAt,startedAt:null,completedAt:null,aiStatus:null});
    ids.push(id);
  }
  return ids;
}

async function processVoiceJob(id) {
  const job = voiceJobs.get(id);
  if (!job || runningVoiceJobs.has(id) || job.status === 'completed') return;
  runningVoiceJobs.add(id);
  try {
    const ai = await resolveAiConfig(job.userId);
    if (!ai.textApiKey) throw new Error('管理员尚未配置内置大模型 API Key');
    job.status = 'processing';
    job.error = '';
    let result;
    if (job.imageFile || job.source === 'photo') {
      job.stage = 'recognizing';
      await persistVoiceJob(job);
      const buffer = await readFile(voiceImagePath(job));
      result = await parseTasksFromImage(buffer, job.mime, ai);
    } else if (job.audioFile) {
      if (!ai.resolveAsrKey()) throw new Error('管理员尚未配置语音识别 API Key');
      job.stage = 'transcribing';
      await persistVoiceJob(job);
      const buffer = await readFile(voiceAudioPath(job));
      result = await transcribeAudio(buffer, job.mime, job.availableTasks || [],async(stage,details={})=>{job.stage=stage;if(details.transcript)job.transcript=details.transcript;await persistVoiceJob(job)}, job.reports || {}, ai);
    } else {
      job.stage = 'understanding';
      await persistVoiceJob(job);
      const transcript = convertToSimplified(String(job.transcript || '').trim());
      if (!transcript) throw new Error('指令内容不能为空');
      job.transcript = transcript;
      await persistVoiceJob(job);
      const command = await parseVoiceCommand(transcript, job.availableTasks || [], job.reports || {}, ai);
      if (command.action === 'edit_report') result = { transcript, command, tasks: [], task: null };
      else if (command.action === 'create') result = { transcript, command, tasks: command.tasks || [], task: command.task || null };
      else result = { transcript, command, tasks: [], task: null };
    }
    if (job.cancelled) return;
    job.transcript = result.transcript;
    job.command = result.command;
    if (result.command?.action === 'edit_report') {
      job.stage = 'understanding';
      await persistVoiceJob(job);
      const kind = result.command.reportKind;
      const source = job.reports?.[kind];
      const edited = await editReportContent(kind, source, result.command.instruction || result.transcript, ai);
      if (job.cancelled) return;
      job.stage = 'saving';
      job.editedReport = edited;
      job.cleared = edited == null;
      job.reportKind = kind;
      job.tasks = [];
      job.task = null;
      if (job.cleared) job.command = { ...result.command, message: result.command.message || (kind === 'weekly' ? '周报已清空' : kind === 'monthly' ? '月报已清空' : '今日复盘已清空') };
      await persistVoiceJob(job);
      try{if(job.userId)await deleteTask(job.userId,job.id);job.persistedTaskIds=[];job.storageError=''}catch(error){job.storageError=error?.message||'清理占位任务失败'}
    } else {
      job.stage = 'saving';
      job.tasks = result.tasks || [];
      job.task = result.task;
      job.editedReport = null;
      job.reportKind = '';
      await persistVoiceJob(job);
      try{job.persistedTaskIds=await persistVoiceResult(job,result);job.storageError=''}catch(error){console.error('语音任务写入存储失败',error);job.storageError=error?.message||'任务保存失败'}
    }
    job.status = 'completed';
    job.stage = 'completed';
    await persistVoiceJob(job);
    // 录音与指令 JSON 保留 7 天，由定时清理删除
  } catch (error) {
    if (job.cancelled) return;
    console.error(error);
    job.status = 'failed';
    job.stage = 'failed';
    job.error = voiceErrorMessage(error);
    await persistVoiceJob(job).catch(console.error);
  } finally {
    runningVoiceJobs.delete(id);
  }
}

async function recoverVoiceJobs() {
  await mkdir(voiceJobsDir, { recursive: true });
  const loadJobFile = async (filePath, label) => {
    try {
      const job = JSON.parse(await readFile(filePath, 'utf8'));
      if (!job?.id) return;
      if (!job.userId) job.userId = 'anonymous';
      voiceJobs.set(job.id, job);
      if (job.status === 'queued' || job.status === 'processing') {
        job.status = 'queued';
        setImmediate(() => void processVoiceJob(job.id));
      }
    } catch (error) {
      console.error(`无法恢复语音任务 ${label}`, error);
    }
  };
  const entries = await readdir(voiceJobsDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(voiceJobsDir, entry.name);
    if (entry.isDirectory()) {
      const files = await readdir(full);
      for (const file of files.filter(name => name.endsWith('.json'))) await loadJobFile(path.join(full, file), `${entry.name}/${file}`);
    } else if (entry.name.endsWith('.json')) {
      await loadJobFile(full, entry.name);
    }
  }
}

function userReportEditJobsDir(userId) {
  return path.join(reportEditJobsDir, String(userId || 'anonymous'));
}

function reportEditJobPath(jobOrUserId, id) {
  if (jobOrUserId && typeof jobOrUserId === 'object') {
    const job = jobOrUserId;
    return path.join(userReportEditJobsDir(job.userId), `${job.id}.json`);
  }
  return path.join(userReportEditJobsDir(jobOrUserId), `${id}.json`);
}

function reportEditAudioPath(job) {
  return path.join(userReportEditJobsDir(job.userId), job.audioFile);
}

async function persistReportEditJob(job) {
  job.updatedAt = new Date().toISOString();
  reportEditJobs.set(job.id, job);
  const dir = userReportEditJobsDir(job.userId);
  await mkdir(dir, { recursive: true });
  await writeFile(reportEditJobPath(job), JSON.stringify(job), { encoding: 'utf8', mode: 0o600 });
}

function publicReportEditJob(job) {
  const { audioFile: _audioFile, sourceReport: _sourceReport, ...safeJob } = job;
  return safeJob;
}

function isClearReportInstruction(instruction = '') {
  const text = String(instruction || '');
  return /(清空|清除|删掉|删除|重置).{0,12}(复盘|日报|周报|月报|内容|全部|小结)?|(复盘|日报|周报|月报|小结).{0,12}(清空|清除|删掉|删除|重置)|全部清空|清空全部|不要复盘|取消复盘/.test(text);
}

async function editReportContent(kind, report, instruction, ai) {
  if (isClearReportInstruction(instruction)) return null;
  const schema = kind === 'daily'
    ? '保持日报结构：headline、summary、completed字符串数组、risks字符串数组、tomorrow对象数组(title,reason,priority高/中/低,suggestedTime)。若用户要求清空/删除整份复盘，输出 {"cleared":true}。'
    : '保持周/月报结构：headline、summary、highlights字符串数组、risks字符串数组、next对象数组(title,reason,priority高/中/低,suggestedTime)。若用户要求清空/删除整份复盘，输出 {"cleared":true}。';
  const data = await qwenChatForAi(ai, {
    messages: [
      { role: 'system', content: `你是中文工作复盘编辑助手。根据用户修改意见，在现有复盘 JSON 上做最小必要修改，保留未提及内容。不要虚构成果。只输出合法 JSON，不要 Markdown。${schema}` },
      { role: 'user', content: `复盘类型：${kind}\n现有复盘：${JSON.stringify(report)}\n修改意见：${instruction}` }
    ],
    responseFormat: { type: 'json_object' }
  }, 'edit_report');
  const edited = parseJSON(messageText(data));
  if (edited?.cleared === true) return null;
  return kind === 'daily' ? normalizeDailyReport(edited) : normalizePeriodReport(edited, 8);
}

async function asrTranscript(buffer, mime = 'audio/webm', ai) {
  const apiKey = ai.resolveAsrKey();
  if (!apiKey) throw new Error('尚未配置语音识别 API Key');
  const data = await qwenChatForAi({
    ...ai,
    textApiKey: apiKey,
    textModel: ai.asrModel,
    baseURL: BAILIAN_BASE_URL
  }, {
    model: ai.asrModel,
    apiKey,
    baseURL: BAILIAN_BASE_URL,
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${buffer.toString('base64')}` } }] }],
    extra: { stream: false, asr_options: { language: 'zh', enable_itn: true } }
  }, 'asr');
  const transcript = convertToSimplified(messageText(data).trim());
  if (!transcript) throw new Error('语音模型没有返回转写内容');
  return transcript;
}

async function processReportEditJob(id) {
  const job = reportEditJobs.get(id);
  if (!job || runningReportEditJobs.has(id) || job.status === 'completed') return;
  runningReportEditJobs.add(id);
  try {
    const ai = await resolveAiConfig(job.userId);
    if (!ai.textApiKey) throw new Error('管理员尚未配置内置大模型 API Key');
    job.status = 'processing';
    job.stage = job.audioFile ? 'transcribing' : 'understanding';
    job.error = '';
    await persistReportEditJob(job);
    let instruction = String(job.instruction || '').trim();
    if (job.audioFile) {
      if (!ai.resolveAsrKey()) throw new Error('管理员尚未配置语音识别 API Key');
      const buffer = await readFile(reportEditAudioPath(job));
      const spoken = await asrTranscript(buffer, job.mime || 'audio/webm', ai);
      if (job.cancelled) return;
      job.transcript = spoken;
      instruction = instruction ? `${instruction}\n${spoken}` : spoken;
      job.stage = 'understanding';
      await persistReportEditJob(job);
    }
    if (!instruction) throw new Error('没有识别到可执行的修改意见');
    job.instruction = instruction;
    const report = await editReportContent(job.kind, job.sourceReport, instruction, ai);
    if (job.cancelled) return;
    job.stage = 'saving';
    job.report = report;
    job.cleared = report == null;
    await persistReportEditJob(job);
    job.status = 'completed';
    job.stage = 'completed';
    await persistReportEditJob(job);
    if (job.audioFile) await unlink(reportEditAudioPath(job)).catch(() => {});
  } catch (error) {
    if (job.cancelled) return;
    console.error(error);
    job.status = 'failed';
    job.stage = 'failed';
    job.error = voiceErrorMessage(error);
    await persistReportEditJob(job).catch(console.error);
  } finally {
    runningReportEditJobs.delete(id);
  }
}

async function recoverReportEditJobs() {
  await mkdir(reportEditJobsDir, { recursive: true });
  const loadJobFile = async (filePath, label) => {
    try {
      const job = JSON.parse(await readFile(filePath, 'utf8'));
      if (!job?.id) return;
      if (!job.userId) job.userId = 'anonymous';
      reportEditJobs.set(job.id, job);
      if (job.status === 'queued' || job.status === 'processing') {
        job.status = 'queued';
        setImmediate(() => void processReportEditJob(job.id));
      }
    } catch (error) {
      console.error(`无法恢复复盘改稿任务 ${label}`, error);
    }
  };
  const entries = await readdir(reportEditJobsDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(reportEditJobsDir, entry.name);
    if (entry.isDirectory()) {
      const files = await readdir(full);
      for (const file of files.filter(name => name.endsWith('.json'))) await loadJobFile(path.join(full, file), `${entry.name}/${file}`);
    } else if (entry.name.endsWith('.json')) {
      await loadJobFile(full, entry.name);
    }
  }
}

app.get('/api/health', async (_req, res) => {
  try {
    const ai = await resolveBuiltinAiConfig('');
    const asrKey = ai.resolveAsrKey?.() || '';
    res.json({
      ai: Boolean(ai.textApiKey),
      asr: Boolean(asrKey),
      textConfigured: Boolean(ai.textApiKey),
      asrConfigured: Boolean(asrKey),
      asrUsesTextKey: Boolean(asrKey) && asrKey === ai.textApiKey,
      requiresUserModel: false,
      modelScope: 'builtin',
      auth: cloudMode() ? 'supabase' : 'local',
      provider: providerLabel(ai.provider),
      textProvider: ai.provider,
      baseURL: ai.baseURL,
      textModel: ai.textModel,
      transcriptionModel: ai.asrModel,
      storage: { mode: storageMode, target: storageDisplay }
    });
  } catch (error) {
    console.error(error);
    const defaults = emptyAiConfig();
    res.json({
      ai: false,
      asr: false,
      textConfigured: false,
      asrConfigured: false,
      asrUsesTextKey: false,
      requiresUserModel: false,
      modelScope: 'builtin',
      auth: cloudMode() ? 'supabase' : 'local',
      provider: providerLabel(defaults.provider),
      textProvider: defaults.provider,
      baseURL: defaults.baseURL,
      textModel: defaults.textModel,
      transcriptionModel: defaults.asrModel,
      storage: { mode: storageMode, target: storageDisplay },
      error: error?.message || 'health failed'
    });
  }
});

app.post('/api/auth/register', async (req, res) => {
  if (cloudMode()) return res.status(400).json({ message: '当前已启用云端登录，请使用邮箱登录链接' });
  try {
    const user = await enrichUser(await createUser({ email: req.body?.email, password: req.body?.password, name: req.body?.name }));
    const session = await createSession(user.id, SESSION_DAYS);
    setSessionCookie(res, session.id, session.expiresAt, req);
    const legacy = await applyLegacyClaim(user.id);
    res.status(201).json({ user, legacy });
  } catch (error) {
    res.status(400).json({ message: error?.message || '注册失败' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (cloudMode()) return res.status(400).json({ message: '当前已启用云端登录，请使用邮箱登录链接' });
  try {
    const user = await enrichUser(await authenticateUser(req.body?.email, req.body?.password));
    if (isBootstrapAdminUser(user)) return res.status(403).json({ message: '管理员请从 /admin 登录' });
    const session = await createSession(user.id, SESSION_DAYS);
    setSessionCookie(res, session.id, session.expiresAt, req);
    const legacy = await applyLegacyClaim(user.id);
    res.json({ user, legacy });
  } catch (error) {
    res.status(401).json({ message: error?.message || '登录失败' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) await deleteSession(sid);
  clearSessionCookie(res, req);
  res.status(204).end();
});

app.post('/api/admin/auth/login', async (req, res) => {
  try {
    const identifier = req.body?.email || req.body?.login || req.body?.username;
    const user = await enrichUser(await authenticateUser(identifier, req.body?.password));
    if (!isBootstrapAdminUser(user) || user?.role !== 'admin') {
      return res.status(403).json({ message: '该账号不是管理员' });
    }
    const session = await createSession(user.id, SESSION_DAYS);
    setAdminSessionCookie(res, session.id, session.expiresAt, req);
    res.json({ user });
  } catch (error) {
    res.status(401).json({ message: error?.message || '管理员登录失败' });
  }
});

app.post('/api/admin/auth/logout', async (req, res) => {
  const sid = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (sid) await deleteSession(sid);
  clearAdminSessionCookie(res, req);
  res.status(204).end();
});

app.get('/api/admin/auth/me', async (req, res) => {
  const session = await getSession(parseCookies(req)[ADMIN_SESSION_COOKIE]);
  if (!session?.user) return res.status(401).json({ user: null, message: '未登录管理后台' });
  const user = await enrichUser(session.user);
  if (!isBootstrapAdminUser(user) || user?.role !== 'admin') {
    return res.status(403).json({ user: null, message: '需要管理员权限' });
  }
  res.json({ user });
});

app.get('/api/auth/me', async (req, res) => {
  if (cloudMode()) return res.json({ user: null, mode: 'supabase' });
  const session = await getSession(parseCookies(req)[SESSION_COOKIE]);
  if (!session?.user) return res.status(401).json({ user: null, message: '未登录' });
  res.json({ user: await enrichUser(session.user), mode: 'local' });
});

app.get('/api/tasks', requireUser, async (req, res) => res.json(await listTasks(req.user.id)));

app.get('/api/tasks/:id', requireUser, async (req, res) => {
  const task=await getTask(req.user.id,req.params.id);
  if(!task)return res.status(404).json({message:'任务不存在'});
  res.json(task);
});

app.put('/api/tasks/:id', requireUser, async (req, res) => {
  try{res.json(await saveTask(req.user.id,{...req.body,id:req.params.id}))}
  catch(error){res.status(400).json({message:error?.message||'任务保存失败'})}
});

app.patch('/api/tasks/:id', requireUser, async (req, res) => {
  try{const task=await patchTask(req.user.id,req.params.id,req.body||{});if(!task)return res.status(404).json({message:'任务不存在'});res.json(task)}
  catch(error){res.status(400).json({message:error?.message||'任务更新失败'})}
});

app.delete('/api/tasks/:id', requireUser, async (req, res) => {
  await deleteTask(req.user.id,req.params.id);res.status(204).end();
});

app.get('/api/reports/:date', requireUser, async (req, res) => {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date))return res.status(400).json({message:'日期格式不正确'});
  res.json(await loadDailyReport(req.user.id,req.params.date));
});

app.put('/api/reports/:date', requireUser, async (req, res) => {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date))return res.status(400).json({message:'日期格式不正确'});
  if(!req.body?.report||typeof req.body.report!=='object')return res.status(400).json({message:'日报内容不能为空'});
  res.json(await saveDailyReport(req.user.id,req.params.date,req.body.report));
});

app.delete('/api/reports/:date', requireUser, async (req, res) => {
  await deleteDailyReport(req.user.id,req.params.date);res.status(204).end();
});

app.get('/api/period-reports/:kind', requireUser, async (req, res) => {
  try {
    if (!['weekly', 'monthly'].includes(req.params.kind)) return res.status(400).json({ message: '周期类型不正确' });
    res.json(await listPeriodReports(req.user.id,req.params.kind));
  } catch (error) {
    res.status(400).json({ message: error?.message || '读取周期复盘列表失败' });
  }
});

app.get('/api/period-reports/:kind/:key', requireUser, async (req, res) => {
  try {
    if (!isPeriodKey(req.params.kind, req.params.key)) return res.status(400).json({ message: '周期键格式不正确' });
    res.json(await loadPeriodReport(req.user.id,req.params.kind, req.params.key));
  } catch (error) {
    res.status(400).json({ message: error?.message || '读取周期复盘失败' });
  }
});

app.put('/api/period-reports/:kind/:key', requireUser, async (req, res) => {
  try {
    if (!isPeriodKey(req.params.kind, req.params.key)) return res.status(400).json({ message: '周期键格式不正确' });
    if (!req.body?.report || typeof req.body.report !== 'object') return res.status(400).json({ message: '复盘内容不能为空' });
    res.json(await savePeriodReport(req.user.id,req.params.kind, req.params.key, req.body.report));
  } catch (error) {
    res.status(400).json({ message: error?.message || '保存周期复盘失败' });
  }
});

app.delete('/api/period-reports/:kind/:key', requireUser, async (req, res) => {
  try {
    await deletePeriodReport(req.user.id,req.params.kind, req.params.key);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ message: error?.message || '删除周期复盘失败' });
  }
});

app.get('/api/settings/cloud', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const active = cloudMode();
  res.json({
    configured: active,
    url: active ? supabaseUrl : '',
    anonKey: active ? supabaseAnonKey : '',
    maskedKey: active && supabaseAnonKey ? `••••••${supabaseAnonKey.slice(-6)}` : ''
  });
});

app.post('/api/settings/cloud/test', requireSettingsAccess, async (req, res) => {
  try {
    const { url, anonKey } = normalizeCloudConfig(req.body?.url || supabaseUrl, req.body?.anonKey || supabaseAnonKey);
    await testCloudConnection(url, anonKey);
    res.json({ ok: true, message: '连接成功，可以保存这套配置' });
  } catch (error) {
    res.status(400).json({ message: error?.message || '云存储连接测试失败' });
  }
});

app.put('/api/settings/cloud', requireSettingsAccess, async (req, res) => {
  try {
    const { url, anonKey } = normalizeCloudConfig(req.body?.url || supabaseUrl, req.body?.anonKey || supabaseAnonKey);
    await testCloudConnection(url, anonKey);
    supabaseUrl = url;
    supabaseAnonKey = anonKey;
    await persistEnv({ VITE_SUPABASE_URL: supabaseUrl, VITE_SUPABASE_ANON_KEY: supabaseAnonKey });
    res.json({ configured: true, url: supabaseUrl, maskedKey: `••••••${supabaseAnonKey.slice(-6)}`, message: '云存储配置已保存并立即生效' });
  } catch (error) {
    res.status(400).json({ message: error?.message || '云存储配置保存失败' });
  }
});

app.delete('/api/settings/cloud', requireSettingsAccess, async (_req, res) => {
  try {
    supabaseUrl = '';
    supabaseAnonKey = '';
    await persistEnv({ VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' });
    res.json({ configured: false, message: '云存储配置已移除，应用已切换为本地体验模式' });
  } catch (error) {
    res.status(500).json({ message: error?.message || '移除云存储配置失败' });
  }
});

async function modelSettingsPublic(userId) {
  const account = await getUserAccount(userId);
  const ai = await resolveAiConfig(userId);
  const models = (await listBuiltinModels({ enabledOnly: true, includeSecrets: true }))
    .filter(isSelectableBuiltinModel);
  const currentHint = ai.modelId ? modelSwitchCostHint({ name: ai.modelName, weight: ai.weight }) : '';
  return {
    mode: 'builtin',
    configured: Boolean(ai.textApiKey),
    textConfigured: Boolean(ai.textApiKey),
    asrConfigured: Boolean(ai.resolveAsrKey?.()),
    requiresUserKey: false,
    scope: 'builtin',
    source: 'builtin',
    selectedModelId: account?.selectedModelId || ai.modelId || '',
    pointsBalance: account?.pointsBalance ?? 0,
    role: account?.role || 'user',
    costHint: currentHint,
    current: {
      id: ai.modelId,
      name: ai.modelName,
      provider: ai.provider,
      textModel: ai.textModel,
      weight: ai.weight,
      costHint: currentHint
    },
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      textModel: m.textModel,
      weight: m.weight,
      badge: m.badge,
      sortOrder: m.sortOrder,
      enabled: m.enabled,
      costHint: modelSwitchCostHint(m),
      switchConfirm: modelSwitchConfirmMessage(m)
    }))
  };
}

app.get('/api/settings/model', requireUser, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await modelSettingsPublic(req.user.id));
});

app.put('/api/settings/model', requireUser, async (req, res) => {
  try {
    const modelId = String(req.body?.modelId || req.body?.selectedModelId || '').trim();
    if (!modelId) return res.status(400).json({ message: '请选择内置模型' });
    await setUserSelectedModel(req.user.id, modelId);
    const payload = await modelSettingsPublic(req.user.id);
    const hint = payload.current?.costHint || payload.costHint || '';
    res.json({ ...payload, message: hint ? `已切换。${hint}` : '已切换模型' });
  } catch (error) {
    res.status(400).json({ message: error?.message || '切换模型失败' });
  }
});

app.post('/api/settings/model/test', requireUser, async (req, res) => {
  try {
    const ai = await resolveAiConfig(req.user.id);
    if (!ai.textApiKey) return res.status(400).json({ message: '管理员尚未配置该模型的 API Key' });
    const reply = await testTextModelConnection(ai.textApiKey, ai.textModel, ai.baseURL);
    res.json({ ok: true, message: `连接成功：${ai.modelName || ai.textModel}${reply ? `（回复：${reply}）` : ''}`, sample: reply });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: publicModelTestError(error) });
  }
});

async function probeBailianKey(apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${BAILIAN_BASE_URL}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `语音密钥校验失败 (${response.status})`);
    return true;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('语音密钥校验超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function testTextModelConnection(apiKey, model, baseURL, timeoutMs = 25_000) {
  const data = await qwenChat({
    model,
    apiKey,
    baseURL,
    messages: [{ role: 'user', content: '只回复两个字：成功' }],
    extra: { max_tokens: 16, temperature: 0 },
    timeoutMs
  });
  return String(messageText(data) || '').trim().slice(0, 40);
}

function sanitizePublicError(message, extraSecrets = []) {
  let text = String(message || '模型连接测试失败');
  for (const secret of extraSecrets) {
    const value = String(secret || '').trim();
    if (value.length >= 8) text = text.split(value).join(`${value.slice(0, 4)}…`);
  }
  return text
    .replace(/\bsk-[A-Za-z0-9_\-]{6,}\b/g, (m) => `${m.slice(0, 5)}…`)
    .replace(/Bearer\s+\S+/gi, 'Bearer …');
}

function publicModelTestError(error, extraSecrets = []) {
  const cause = error?.cause;
  const detail = String(error?.message || '模型连接测试失败');
  let message = detail;
  if (/fetch failed/i.test(detail) || cause?.code) {
    const code = cause?.code || cause?.errno || '';
    message = code ? `网络连接失败（${code}）` : '网络连接失败，请检查 Base URL 是否可访问';
  }
  return sanitizePublicError(message, extraSecrets);
}

async function handleAdminModelTest(req, res) {
  const body = req.body || {};
  const typedKey = String(body.textApiKey || '').trim();
  const secrets = [typedKey];
  const id = String(req.params?.id || body.id || '').trim();
  const stored = id ? await getBuiltinModel(id, { includeSecrets: true }) : null;
  secrets.push(String(stored?.textApiKey || '').trim());
  const persist = Boolean(stored && (!typedKey || typedKey === String(stored.textApiKey || '').trim()));
  try {
    const apiKey = typedKey || resolveModelTextKey(stored) || secrets.find(Boolean) || '';
    const textModel = String(body.textModel || stored?.textModel || '').trim();
    const provider = String(body.provider || stored?.provider || 'bailian').trim();
    const baseURL = String(body.baseURL || stored?.baseURL || PROVIDER_PRESETS[provider]?.baseURL || BAILIAN_BASE_URL).trim();
    if (!textModel) return res.status(400).json({ message: '请填写模型 ID' });
    if (!apiKey) return res.status(400).json({ message: '请填写 API Key，或先保存后再测试已有模型' });
    const reply = await testTextModelConnection(apiKey, textModel, baseURL);
    const label = String(body.name || stored?.name || textModel);
    const model = persist ? await markBuiltinModelTest(stored.id, true) : stored;
    res.json({
      ok: true,
      lastTestOk: Boolean(model?.lastTestOk || persist),
      message: `连接成功：${label}${reply ? `（回复：${reply}）` : ''}`,
      sample: reply,
      model: model ? { ...model, textApiKey: undefined, asrApiKey: undefined } : null
    });
  } catch (error) {
    if (persist) {
      try { await markBuiltinModelTest(stored.id, false); } catch {}
    }
    console.error(error);
    res.status(400).json({ message: publicModelTestError(error, secrets), lastTestOk: false });
  }
}

app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
  res.json(await adminDashboardStats());
});

app.get('/api/admin/models', requireAdmin, async (_req, res) => {
  res.json({ models: await listBuiltinModels({ includeSecrets: true }) });
});

app.get('/api/admin/model-prices', requireAdmin, async (req, res) => {
  try {
    const provider = String(req.query.provider || '');
    const textModel = String(req.query.textModel || req.query.model || '');
    const id = String(req.query.id || '');
    const weight = Number(req.query.weight);
    const result = await estimateModelPrice({
      provider,
      textModel,
      id,
      weight: Number.isFinite(weight) ? weight : 0
    });
    res.json(result);
  } catch (error) {
    const weight = Number(req.query.weight) || 0;
    res.json({
      ok: true,
      source: 'weight',
      fallback: true,
      yuanPerMillion: Number((weight * 3).toFixed(3)),
      weightEstimate: Number((weight * 3).toFixed(3)),
      message: weightEstimateMessage(weight).replace(/^预估：/, '未能拉取官方价，已用权重估算。预估：')
    });
  }
});

app.post('/api/admin/models/:id/price-estimate', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await estimateModelPrice({
      provider: String(body.provider || ''),
      textModel: String(body.textModel || body.model || ''),
      id: String(req.params.id || body.id || ''),
      weight: Number(body.weight)
    });
    res.json(result);
  } catch {
    const weight = Number(req.body?.weight) || 0;
    res.json({
      ok: true,
      source: 'weight',
      fallback: true,
      yuanPerMillion: Number((weight * 3).toFixed(3)),
      weightEstimate: Number((weight * 3).toFixed(3)),
      message: `未能拉取官方价，已用权重估算。${weightEstimateMessage(weight)}`
    });
  }
});

app.post('/api/admin/models/test', requireAdmin, handleAdminModelTest);
app.post('/api/admin/models/:id/test', requireAdmin, handleAdminModelTest);

app.put('/api/admin/models/:id', requireAdmin, async (req, res) => {
  try {
    const model = await saveBuiltinModel({ ...req.body, id: req.params.id });
    res.json({ model, message: '模型已保存' });
  } catch (error) {
    res.status(400).json({ message: error?.message || '保存模型失败' });
  }
});

app.post('/api/admin/models', requireAdmin, async (req, res) => {
  try {
    const model = await saveBuiltinModel(req.body || {});
    res.status(201).json({ model, message: '模型已创建' });
  } catch (error) {
    res.status(400).json({ message: error?.message || '创建模型失败' });
  }
});

app.delete('/api/admin/models/:id', requireAdmin, async (req, res) => {
  try {
    await deleteBuiltinModel(req.params.id);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ message: error?.message || '删除模型失败' });
  }
});

app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  res.json({ users: await listUsersAdmin() });
});

app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await updateUserAdmin(req.params.id, req.body || {});
    res.json({ user, message: '用户已更新' });
  } catch (error) {
    res.status(400).json({ message: error?.message || '更新用户失败' });
  }
});

app.get('/api/admin/usage', requireAdmin, async (req, res) => {
  res.json({ items: await listUsageLogs({ userId: req.query.userId || '', limit: Number(req.query.limit) || 50 }) });
});

app.get('/api/me/usage', requireUser, async (req, res) => {
  res.json({
    account: await getUserAccount(req.user.id),
    items: await listUsageLogs({ userId: req.user.id, limit: 30 })
  });
});

app.post('/api/parse-task-text', requireUser, requireTextAi, async (req, res) => {
  try{
    const transcript=String(req.body?.transcript||'').trim().slice(0,5000);
    if(!transcript)return res.status(400).json({message:'指令内容不能为空'});
    let availableTasks = [];
    let reports = {};
    try { const parsed = Array.isArray(req.body?.tasks) ? req.body.tasks : []; if (Array.isArray(parsed)) availableTasks = parsed.slice(0, 100); } catch {}
    try {
      const parsed = req.body?.reports && typeof req.body.reports === 'object' ? req.body.reports : {};
      reports = {
        daily: parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : null,
        weekly: parsed.weekly && typeof parsed.weekly === 'object' ? parsed.weekly : null,
        monthly: parsed.monthly && typeof parsed.monthly === 'object' ? parsed.monthly : null
      };
    } catch {}
    const command = await parseVoiceCommand(transcript, availableTasks, reports, req.ai);
    if (command.action === 'edit_report') {
      const kind = command.reportKind;
      const source = reports?.[kind];
      const editedReport = await editReportContent(kind, source, command.instruction || transcript, req.ai);
      const cleared = editedReport == null;
      const nextCommand = cleared
        ? { ...command, message: command.message || (kind === 'weekly' ? '周报已清空' : kind === 'monthly' ? '月报已清空' : '今日复盘已清空') }
        : command;
      const job = await recordTextVoiceJob({ userId: req.user.id, transcript, command: nextCommand, tasks: [], editedReport, reportKind: kind, status: 'completed', cleared });
      return res.json({ command: nextCommand, reportKind: kind, editedReport, cleared, tasks: [], count: 0, jobId: job.id });
    }
    if (command.action === 'update' || command.action === 'clarify') {
      const job = await recordTextVoiceJob({ userId: req.user.id, transcript, command, tasks: [], status: 'completed' });
      return res.json({ command, tasks: [], count: 0, jobId: job.id });
    }
    const tasks = command.tasks || [];
    const job = await recordTextVoiceJob({ userId: req.user.id, transcript, command, tasks, status: 'completed' });
    res.json({ command, tasks, count: tasks.length, jobId: job.id });
  }catch(error){
    console.error(error);
    const transcript=String(req.body?.transcript||'').trim().slice(0,5000);
    if(transcript)await recordTextVoiceJob({ userId: req.user?.id, transcript, command: null, status: 'failed', error: error?.message||'AI 指令理解失败' }).catch(()=>{});
    res.status(502).json({message:error?.message||'AI 指令理解失败'});
  }
});

async function publicUserPreferences(userId) {
  const prefs = (await getUserPreferences(userId)) || { avatar: '', autoSchedule: null, voiceRetention: null };
  return {
    avatar: prefs.avatar || '',
    autoSchedule: prefs.autoSchedule || null,
    voiceRetention: prefs.voiceRetention ? normalizeVoiceRetentionSettings(prefs.voiceRetention) : await userVoiceRetention(userId)
  };
}

app.get('/api/settings/profile', requireUser, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await publicUserPreferences(req.user.id));
});

app.put('/api/settings/profile', requireUser, async (req, res) => {
  try {
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'avatar')) {
      const avatar = String(req.body.avatar || '');
      if (avatar && !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(avatar)) {
        return res.status(400).json({ message: '头像格式不正确' });
      }
      patch.avatar = avatar;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'autoSchedule')) {
      patch.autoSchedule = req.body.autoSchedule && typeof req.body.autoSchedule === 'object' ? req.body.autoSchedule : null;
    }
    await saveUserPreferences(req.user.id, patch);
    res.json({ ...(await publicUserPreferences(req.user.id)), message: '个人设置已保存' });
  } catch (error) {
    res.status(400).json({ message: error?.message || '个人设置保存失败' });
  }
});

app.get('/api/settings/jobs', requireUser, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ voiceRetention: await userVoiceRetention(req.user.id), scope: 'user' });
});

app.put('/api/settings/jobs', requireUser, async (req, res) => {
  try {
    const voiceRetention = normalizeVoiceRetentionSettings(req.body?.voiceRetention || req.body);
    const autoSchedule = req.body?.autoSchedule && typeof req.body.autoSchedule === 'object' ? req.body.autoSchedule : undefined;
    await saveUserPreferences(req.user.id, {
      voiceRetention,
      ...(autoSchedule !== undefined ? { autoSchedule } : {})
    });
    res.json({ voiceRetention, message: '你的后台作业设置已保存' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: '保存后台作业设置失败' });
  }
});

app.post('/api/voice-jobs/purge', requireUser, async (req, res) => {
  try {
    const schedule = await userVoiceRetention(req.user.id);
    const days = Number(req.body?.retentionDays);
    const retentionDays = Number.isInteger(days) && days >= 1 && days <= 90 ? days : schedule.retentionDays;
    if (Number.isInteger(days) && days >= 1 && days <= 90) {
      await saveUserPreferences(req.user.id, { voiceRetention: { ...schedule, retentionDays } });
    }
    const force = Boolean(req.body?.force);
    const result = force
      ? await purgeExpiredVoiceJobs(retentionDays, req.user.id).then(async data => {
          const now = new Date();
          const time = latestDueJobTime(schedule.times, now) || schedule.times[0] || '03:00';
          const slotKey = `voiceRetention:${req.user.id}:${localDateKey(now)}-${String(time).replace(':', '')}`;
          jobSettings.doneSlots = { ...(jobSettings.doneSlots || {}), [slotKey]: new Date().toISOString() };
          await persistJobSettings();
          return { ...data, slotKey, time };
        })
      : await runVoiceRetentionJobIfDue(false, req.user.id);
    const voiceRetention = await userVoiceRetention(req.user.id);
    if (!result) return res.json({ skipped: true, message: '当前未到清理作业时间，或本时段已执行', voiceRetention });
    res.json({ skipped: false, ...result, voiceRetention, message: `已清理 ${result.removed} 条过期指令` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: '清理语音指令失败' });
  }
});

app.get('/api/voice-jobs', requireUser, async (req, res) => {
  try {
    const voiceRetention = await userVoiceRetention(req.user.id);
    const retentionDays = voiceRetention.retentionDays;
    const cutoff = Date.now() - voiceRetentionMs(retentionDays);
    const userId = req.user.id;
    const items = [...voiceJobs.values()]
      .filter(job => (job.userId || 'anonymous') === userId)
      .filter(job => {
        const ts = Date.parse(job?.createdAt || job?.updatedAt || '') || 0;
        return !ts || ts >= cutoff;
      })
      .sort((a, b) => Date.parse(b.createdAt || b.updatedAt || 0) - Date.parse(a.createdAt || a.updatedAt || 0))
      .map(voiceJobListItem);
    res.json({ retentionDays, voiceRetention, items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: '读取语音指令历史失败' });
  }
});

function parseVoiceJobContext(body = {}) {
  let availableTasks = [];
  let reports = {};
  try {
    const parsed = typeof body.tasks === 'string' ? JSON.parse(body.tasks || '[]') : body.tasks;
    if (Array.isArray(parsed)) availableTasks = parsed.slice(0, 100);
  } catch {}
  try {
    const parsed = typeof body.reports === 'string' ? JSON.parse(body.reports || '{}') : body.reports;
    if (parsed && typeof parsed === 'object') {
      reports = {
        daily: parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : null,
        weekly: parsed.weekly && typeof parsed.weekly === 'object' ? parsed.weekly : null,
        monthly: parsed.monthly && typeof parsed.monthly === 'object' ? parsed.monthly : null
      };
    }
  } catch {}
  return { availableTasks, reports };
}

app.post('/api/voice-jobs/text', requireUser, requireTextAi, async (req, res) => {
  try {
    const transcript = convertToSimplified(String(req.body?.transcript || '').trim().slice(0, 5000));
    if (!transcript) return res.status(400).json({ error: 'NO_TEXT', message: '指令内容不能为空' });
    const { availableTasks, reports } = parseVoiceJobContext(req.body || {});
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      userId: req.user.id,
      status: 'queued',
      stage: 'queued',
      source: 'text',
      mime: '',
      audioFile: '',
      createdAt: now,
      updatedAt: now,
      availableTasks,
      reports,
      transcript,
      tasks: [],
      task: null,
      command: null,
      editedReport: null,
      reportKind: '',
      cleared: false,
      error: ''
    };
    await persistVoiceJob(job);
    res.status(202).json(publicVoiceJob(job));
    setImmediate(() => void processVoiceJob(id));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'VOICE_JOB_SAVE_FAILED', message: '文字指令提交失败，请重试' });
  }
});

app.post('/api/voice-jobs', upload.single('audio'), requireUser, requireVoiceAi, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'NO_AUDIO', message: '没有收到录音文件' });
    const mime = req.file.mimetype || 'audio/webm';
    const { availableTasks, reports } = parseVoiceJobContext(req.body || {});
    const id = randomUUID();
    const audioFile = `${id}.${audioExtension(mime)}`;
    const dir = userVoiceJobsDir(req.user.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, audioFile), req.file.buffer, { mode: 0o600 });
    const job = {
      id,
      userId: req.user.id,
      status: 'queued',
      stage: 'queued',
      source: 'audio',
      mime,
      audioFile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      availableTasks,
      reports,
      transcript: '',
      tasks: [],
      task: null,
      command: null,
      editedReport: null,
      reportKind: '',
      error: ''
    };
    await persistVoiceJob(job);
    res.status(202).json(publicVoiceJob(job));
    setImmediate(() => void processVoiceJob(id));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'VOICE_JOB_SAVE_FAILED', message: '录音保存失败，请重试' });
  }
});

app.post('/api/voice-jobs/photo', upload.single('image'), requireUser, requireTextAi, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'NO_IMAGE', message: '没有收到图片文件' });
    const mime = String(req.file.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/')) return res.status(400).json({ error: 'NOT_IMAGE', message: '请上传图片文件' });
    const { availableTasks, reports } = parseVoiceJobContext(req.body || {});
    const id = randomUUID();
    const imageFile = `${id}.${imageExtension(mime)}`;
    const dir = userVoiceJobsDir(req.user.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, imageFile), req.file.buffer, { mode: 0o600 });
    const job = {
      id,
      userId: req.user.id,
      status: 'queued',
      stage: 'queued',
      source: 'photo',
      mime: mime || 'image/jpeg',
      audioFile: '',
      imageFile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      availableTasks,
      reports,
      transcript: '',
      tasks: [],
      task: null,
      command: null,
      editedReport: null,
      reportKind: '',
      error: ''
    };
    await persistVoiceJob(job);
    res.status(202).json(publicVoiceJob(job));
    setImmediate(() => void processVoiceJob(id));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'PHOTO_JOB_SAVE_FAILED', message: '图片保存失败，请重试' });
  }
});

function ownedVoiceJob(req, res) {
  const job = voiceJobs.get(req.params.id);
  if (!job || (job.userId || 'anonymous') !== req.user.id) {
    res.status(404).json({ error: 'VOICE_JOB_NOT_FOUND', message: '没有找到这条语音任务' });
    return null;
  }
  return job;
}

app.get('/api/voice-jobs/:id', requireUser, (req, res) => {
  const job = ownedVoiceJob(req, res);
  if (!job) return;
  res.json(publicVoiceJob(job));
});

app.get('/api/voice-jobs/:id/audio', requireUser, async (req, res) => {
  const job = ownedVoiceJob(req, res);
  if (!job) return;
  if (!job.audioFile) return res.status(404).json({ message: '这条指令没有可播放的录音' });
  const filePath = voiceAudioPath(job);
  try {
    await stat(filePath);
  } catch {
    return res.status(404).json({ message: '录音文件已过期或不存在' });
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.type(job.mime || 'audio/webm');
  res.sendFile(filePath);
});

app.get('/api/voice-jobs/:id/image', requireUser, async (req, res) => {
  const job = ownedVoiceJob(req, res);
  if (!job) return;
  if (!job.imageFile) return res.status(404).json({ message: '这条指令没有图片' });
  const filePath = voiceImagePath(job);
  try {
    await stat(filePath);
  } catch {
    return res.status(404).json({ message: '图片已过期或不存在' });
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.type(job.mime || 'image/jpeg');
  res.sendFile(filePath);
});

app.delete('/api/voice-jobs/:id', requireUser, async (req, res) => {
  const job = ownedVoiceJob(req, res);
  if (!job) return;
  job.cancelled = true;
  voiceJobs.delete(req.params.id);
  await unlink(voiceJobPath(job)).catch(() => {});
  await unlinkVoiceMedia(job);
  res.status(204).end();
});

app.post('/api/voice-jobs/:id/retry', requireUser, async (req, res) => {
  const job = ownedVoiceJob(req, res);
  if (!job) return;
  if (job.status === 'completed') return res.status(409).json({ message: '这条语音任务已经识别完成' });
  const ai = await resolveAiConfig(req.user.id);
  if (!ai.textApiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED', message: '请先在「设置 → 大模型」配置任务理解 API Key' });
  if (job.audioFile && !ai.resolveAsrKey()) return res.status(503).json({ error: 'ASR_NOT_CONFIGURED', message: '请先在「设置 → 大模型」配置语音识别 API Key' });
  job.status = 'queued';
  job.stage = 'queued';
  job.error = '';
  await persistVoiceJob(job);
  res.status(202).json(publicVoiceJob(job));
  setImmediate(() => void processVoiceJob(job.id));
});

app.post('/api/transcribe', upload.single('audio'), requireUser, requireVoiceAi, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'NO_AUDIO', message: '没有收到录音文件' });
    let availableTasks = [];
    try { const parsed = JSON.parse(String(req.body?.tasks || '[]')); if (Array.isArray(parsed)) availableTasks = parsed.slice(0, 100); } catch {}
    res.json(await transcribeAudio(req.file.buffer, req.file.mimetype || 'audio/webm', availableTasks, async () => {}, {}, req.ai));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_TRANSCRIBE_FAILED', message: voiceErrorMessage(error) });
  }
});

app.post('/api/daily-plan', requireUser, requireTextAi, async (req, res) => {
  try {
    const { tasks = [], date, user = '用户' } = req.body || {};
    const data = await qwenChatForAi(req.ai, {
      messages: [
        { role: 'system', content: '你是务实的中文工作规划助手。根据真实任务数据总结当天完成情况，并规划明天。优先考虑逾期、进行中、高优先级和依赖关系，不要声称未提供的成果。次日计划最多5项，按重要性排序。只输出合法 JSON，不要 Markdown。JSON字段：headline字符串、summary字符串、completed字符串数组、risks字符串数组、tomorrow对象数组；tomorrow每项包含title、reason、priority(高/中/低)、suggestedTime。' },
        { role: 'user', content: `用户：${user}\n日期：${date}\n任务数据：${JSON.stringify(tasks)}` }
      ],
      responseFormat: { type: 'json_object' }
    }, 'daily_plan');
    res.json(normalizeDailyReport(parseJSON(messageText(data))));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_PLAN_FAILED', message: error?.message || '千问日报生成失败' });
  }
});

app.post('/api/weekly-plan', requireUser, requireTextAi, async (req, res) => {
  try {
    const { tasks = [], weekStart, weekEnd, user = '用户' } = req.body || {};
    const data = await qwenChatForAi(req.ai, {
      messages: [
        { role: 'system', content: '你是务实的中文周报助手。根据真实任务数据总结本周完成亮点与风险，并规划下周重点。不要虚构未提供的成果。下周计划最多8项，按重要性排序。只输出合法 JSON，不要 Markdown。JSON字段：headline字符串、summary字符串、highlights字符串数组、risks字符串数组、next对象数组；next每项包含title、reason、priority(高/中/低)、suggestedTime。' },
        { role: 'user', content: `用户：${user}\n本周：${weekStart} 至 ${weekEnd}\n任务数据：${JSON.stringify(tasks)}` }
      ],
      responseFormat: { type: 'json_object' }
    }, 'weekly_plan');
    res.json(normalizePeriodReport(parseJSON(messageText(data)), 8));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_WEEKLY_FAILED', message: error?.message || '千问周报生成失败' });
  }
});

app.post('/api/monthly-plan', requireUser, requireTextAi, async (req, res) => {
  try {
    const { tasks = [], month, user = '用户' } = req.body || {};
    const data = await qwenChatForAi(req.ai, {
      messages: [
        { role: 'system', content: '你是务实的中文月报助手。根据真实任务数据总结本月完成亮点与风险，并规划下月重点。不要虚构未提供的成果。下月计划最多8项，按重要性排序。只输出合法 JSON，不要 Markdown。JSON字段：headline字符串、summary字符串、highlights字符串数组、risks字符串数组、next对象数组；next每项包含title、reason、priority(高/中/低)、suggestedTime。' },
        { role: 'user', content: `用户：${user}\n月份：${month}\n任务数据：${JSON.stringify(tasks)}` }
      ],
      responseFormat: { type: 'json_object' }
    }, 'monthly_plan');
    res.json(normalizePeriodReport(parseJSON(messageText(data)), 8));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_MONTHLY_FAILED', message: error?.message || '千问月报生成失败' });
  }
});

app.post('/api/edit-report', upload.single('audio'), requireUser, requireTextAi, async (req, res) => {
  try {
    const kind = String(req.body?.kind || '').trim();
    if (!['daily', 'weekly', 'monthly'].includes(kind)) return res.status(400).json({ message: '复盘类型不正确' });
    let report = req.body?.report;
    if (typeof report === 'string') {
      try { report = JSON.parse(report); } catch { return res.status(400).json({ message: '复盘内容格式不正确' }); }
    }
    if (!report || typeof report !== 'object') return res.status(400).json({ message: '复盘内容不能为空' });
    let instruction = String(req.body?.instruction || req.body?.transcript || '').trim();
    if (req.file) {
      if (!req.ai.resolveAsrKey()) return res.status(503).json({ message: '请先在「设置 → 大模型」配置语音识别 API Key' });
      const spoken = await asrTranscript(req.file.buffer, req.file.mimetype || 'audio/webm', req.ai);
      instruction = instruction ? `${instruction}\n${spoken}` : spoken;
    }
    if (!instruction) return res.status(400).json({ message: '请提供修改说明或录音' });
    const normalized = await editReportContent(kind, report, instruction, req.ai);
    if (normalized == null) return res.json({ report: null, cleared: true, transcript: instruction });
    res.json({ report: normalized, cleared: false, transcript: instruction });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_EDIT_FAILED', message: error?.message || '复盘修改失败' });
  }
});

app.post('/api/report-edit-jobs', upload.single('audio'), requireUser, requireTextAi, async (req, res) => {
  try {
    const kind = String(req.body?.kind || '').trim();
    if (!['daily', 'weekly', 'monthly'].includes(kind)) return res.status(400).json({ message: '复盘类型不正确' });
    let report = req.body?.report;
    if (typeof report === 'string') {
      try { report = JSON.parse(report); } catch { return res.status(400).json({ message: '复盘内容格式不正确' }); }
    }
    if (!report || typeof report !== 'object') return res.status(400).json({ message: '复盘内容不能为空' });
    const instruction = String(req.body?.instruction || req.body?.transcript || '').trim();
    if (!req.file && !instruction) return res.status(400).json({ message: '请提供修改说明或录音' });
    if (req.file && !req.ai.resolveAsrKey()) return res.status(503).json({ message: '请先在「设置 → 大模型」配置语音识别 API Key' });
    const id = randomUUID();
    const mime = req.file?.mimetype || 'audio/webm';
    let audioFile = '';
    if (req.file) {
      audioFile = `${id}.${audioExtension(mime)}`;
      const dir = userReportEditJobsDir(req.user.id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, audioFile), req.file.buffer, { mode: 0o600 });
    }
    const job = {
      id,
      userId: req.user.id,
      kind,
      status: 'queued',
      stage: 'queued',
      mime,
      audioFile,
      instruction,
      transcript: '',
      sourceReport: report,
      report: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: ''
    };
    await persistReportEditJob(job);
    res.status(202).json(publicReportEditJob(job));
    setImmediate(() => void processReportEditJob(id));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'REPORT_EDIT_JOB_SAVE_FAILED', message: '录音保存失败，请重试' });
  }
});

function ownedReportEditJob(req, res) {
  const job = reportEditJobs.get(req.params.id);
  if (!job || (job.userId || 'anonymous') !== req.user.id) {
    res.status(404).json({ error: 'REPORT_EDIT_JOB_NOT_FOUND', message: '没有找到这条复盘改稿任务' });
    return null;
  }
  return job;
}

app.get('/api/report-edit-jobs/:id', requireUser, (req, res) => {
  const job = ownedReportEditJob(req, res);
  if (!job) return;
  res.json(publicReportEditJob(job));
});

app.delete('/api/report-edit-jobs/:id', requireUser, async (req, res) => {
  const job = ownedReportEditJob(req, res);
  if (!job) return;
  job.cancelled = true;
  reportEditJobs.delete(req.params.id);
  await unlink(reportEditJobPath(job)).catch(() => {});
  if (job.audioFile) await unlink(reportEditAudioPath(job)).catch(() => {});
  res.status(204).end();
});

app.post('/api/report-edit-jobs/:id/retry', requireUser, requireVoiceAi, async (req, res) => {
  const job = ownedReportEditJob(req, res);
  if (!job) return;
  if (job.status === 'completed') return res.status(409).json({ message: '这条复盘改稿任务已经完成' });
  job.status = 'queued';
  job.stage = 'queued';
  job.error = '';
  await persistReportEditJob(job);
  res.status(202).json(publicReportEditJob(job));
  setImmediate(() => void processReportEditJob(job.id));
});

const dist = path.resolve(__dirname, '../dist');
const sendAdminPage = (_req, res) => res.set('Cache-Control', 'no-store, no-cache, must-revalidate').sendFile(path.join(dist, 'admin.html'));
app.get('/admin', sendAdminPage);
app.get('/admin.html', sendAdminPage);
app.use((req,res,next)=>{if(req.path==='/'||req.path==='/index.html'||req.path==='/sw.js'||req.path==='/admin'||req.path==='/admin.html')res.set('Cache-Control','no-store, no-cache, must-revalidate');next()});
app.use(express.static(dist));
app.get('/{*splat}', (req, res) => {
  const admin = req.path === '/admin' || req.path.startsWith('/admin/');
  res.set('Cache-Control','no-store').sendFile(path.join(dist, admin ? 'admin.html' : 'index.html'));
});
let storeClosed=false;
const closeDatabase=()=>{if(storeClosed)return;storeClosed=true;void closeStore();void closeBilling()};
process.once('SIGINT',()=>{closeDatabase();process.exit(0)});
process.once('SIGTERM',()=>{closeDatabase();process.exit(0)});
process.once('exit',closeDatabase);
// Store schema must exist before billing ALTERs users / creates related tables.
initStore()
  .then(() => initBilling())
  .then(() => Promise.all([loadJobSettings(), recoverVoiceJobs(), recoverReportEditJobs()]))
  .then(async () => {
    try {
      const legacy = await autoClaimLegacyData();
      if (legacy?.claimed) {
        console.log(`已将 local-legacy 历史数据归属用户 ${legacy.by}`, legacy.moved);
        void adoptLegacyVoiceDirs(legacy.by);
      }
    } catch (error) {
      console.error('自动认领历史数据失败', error);
    }
    setInterval(() => { void runVoiceRetentionJobIfDue(false).catch(console.error); }, 60 * 1000);
    app.listen(port, '0.0.0.0', () => console.log(`FlowMate Qwen server: http://localhost:${port} [${storageMode}: ${storageDisplay}]`));
  })
  .catch(error => {
    console.error('服务初始化失败', error);
    process.exitCode = 1;
  });
