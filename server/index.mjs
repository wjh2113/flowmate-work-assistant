import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { Converter } from 'opencc-js/t2cn';
import { closeSqlite, deleteSqlitePeriodReport, deleteSqliteReport, deleteSqliteTask, getSqliteTask, listSqlitePeriodReports, listSqliteTasks, loadSqlitePeriodReport, loadSqliteReport, patchSqliteTask, saveSqlitePeriodReport, saveSqliteReport, saveSqliteTask, sqliteDisplayPath } from './sqlite-store.mjs';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const port = Number(process.env.PORT || 8787);
let textApiKey = process.env.DASHSCOPE_TEXT_API_KEY || process.env.DASHSCOPE_API_KEY || '';
let asrApiKey = process.env.DASHSCOPE_ASR_API_KEY || '';
const baseURL = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
let textModel = process.env.QWEN_TEXT_MODEL || 'qwen3.7-plus';
let asrModel = process.env.QWEN_ASR_MODEL || 'qwen3-asr-flash';
const resolveAsrKey = () => asrApiKey || textApiKey;
const maskKey = (key) => (key ? `••••${key.slice(-4)}` : '');
const isValidApiKey = (key) => key.startsWith('sk-') && key.length >= 16;
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

function requireTextAi(_req, res, next) {
  if (!textApiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED', message: '服务端尚未配置任务理解 API Key' });
  next();
}

function requireVoiceAi(_req, res, next) {
  if (!resolveAsrKey()) return res.status(503).json({ error: 'ASR_NOT_CONFIGURED', message: '服务端尚未配置语音识别 API Key' });
  if (!textApiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED', message: '服务端尚未配置任务理解 API Key' });
  next();
}

/** @deprecated prefer requireTextAi / requireVoiceAi */
function requireQwen(req, res, next) {
  return requireTextAi(req, res, next);
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

async function qwenChat({ model = textModel, messages, responseFormat, extra = {}, apiKey = textApiKey }) {
  if (!apiKey) throw new Error('尚未配置对应的 API Key');
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90_000);
  try{
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',signal:controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, ...(responseFormat ? { response_format: responseFormat } : {}), ...extra })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `千问接口请求失败 (${response.status})`);
    return data;
  }catch(error){if(error?.name==='AbortError')throw new Error('千问处理超过90秒，已停止本次请求，请点击任务重试');throw error}
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

async function parseTasks(transcript) {
  const data = await qwenChat({
    messages: [
      { role: 'system', content: '你是中文工作任务拆解助手。把一段口语整理为一个或多个独立可执行任务。一句话中出现多个并列目标、不同课程、不同交付物或先后要完成的事项时，必须拆成多项；例如“学习日语直播课、英语雅思和AI练习”应拆成3项。不要把同一个目标的普通操作步骤过度拆分。最多10项，不要虚构信息；未提负责人时写“我”，未提日期时写“今天”。每个标题只保留一个动作和一个清晰对象。根据各任务复杂度分别估算时长。只输出合法 JSON，不要 Markdown。JSON结构：tasks为数组，每项包含title字符串、assignee字符串、due简短中文、priority为高/中/低、confidence为0到1数字、estimatedMinutes为15到480之间的整数分钟数。' },
      { role: 'user', content: `当前日期：${new Date().toLocaleDateString('zh-CN')}\n当前用户：我\n语音内容：${transcript}` }
    ],
    responseFormat: { type: 'json_object' }
  });
  const parsed = parseJSON(messageText(data));
  return normalizeParsedTasks(parsed, transcript);
}

async function parseVoiceCommand(transcript, availableTasks = [], reports = {}) {
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
  const data = await qwenChat({
    messages: [
      { role: 'system', content: '你是中文工作助手的统一语音指令解析器。先判断用户意图属于哪一类：1) edit_report：修改今日复盘/日报、本周周报、本月月报（含小结、亮点、风险、明日/下周/下月计划等表述）；2) create：新建待办任务；3) update：修改已有任务；4) clarify：目标不明确。提及“今日复盘/今日小结/日报/明天建议”→reportKind=daily；“周报/本周复盘/下周计划”→weekly；“月报/本月复盘/下月计划”→monthly。若同时像任务又像复盘，优先看是否明确点名复盘/周报/月报。edit_report 时 instruction 写清具体修改意见。修改任务时只能使用候选任务真实 id，不明确则 clarify。新建任务最多10项。只输出合法JSON，不要Markdown。JSON字段：action为create/update/clarify/edit_report；reportKind为daily/weekly/monthly或空；instruction字符串；updates数组(targetTaskId,changes)；tasks新建数组；message简短中文；confidence为0到1。' },
      { role: 'user', content: `当前日期：${new Date().toLocaleDateString('zh-CN')}\n当前用户：我\n已有复盘：${JSON.stringify(reportMeta)}\n候选任务：${JSON.stringify(tasks)}\n语音指令：${transcript}` }
    ],
    responseFormat: { type: 'json_object' }
  });
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

async function transcribeAudio(buffer, mime = 'audio/webm', availableTasks = [], onStage = async()=>{}, reports = {}) {
  await onStage('transcribing');
  const audio = `data:${mime};base64,${buffer.toString('base64')}`;
  const data = await qwenChat({
    apiKey: resolveAsrKey(),
    model: asrModel,
    messages: [
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: audio } }] }
    ],
    extra: { stream: false, asr_options: { language: 'zh', enable_itn: true } }
  });
  const transcript = convertToSimplified(messageText(data).trim());
  if (!transcript) throw new Error('千问语音模型没有返回转写内容');
  await onStage('understanding',{transcript});
  const command = await parseVoiceCommand(transcript, availableTasks, reports);
  if (command.action === 'edit_report') return { transcript, command, tasks: [], task: null };
  if (command.action === 'create') return { transcript, command, tasks: command.tasks || [], task: command.task || null };
  return { transcript, command, tasks: [], task: null };
}

function voiceErrorMessage(error) {
  const message = error?.message || '';
  if (/InvalidParameter|does not support this input/i.test(message)) return '语音模型无法读取这段录音，请重新录制后再试';
  return message || '千问语音识别失败';
}

function audioExtension(mime = '') {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

function voiceJobPath(id) {
  return path.join(voiceJobsDir, `${id}.json`);
}

async function persistVoiceJob(job) {
  job.updatedAt = new Date().toISOString();
  voiceJobs.set(job.id, job);
  await mkdir(voiceJobsDir, { recursive: true });
  await writeFile(voiceJobPath(job.id), JSON.stringify(job), { encoding: 'utf8', mode: 0o600 });
}

function publicVoiceJob(job) {
  const { audioFile, availableTasks: _availableTasks, reports: _reports, ...safeJob } = job;
  return { ...safeJob, hasAudio: Boolean(audioFile), source: job.source || (audioFile ? 'audio' : 'text') };
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
    source: job.source || (job.audioFile ? 'audio' : 'text'),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    transcript: job.transcript || '',
    action,
    reportKind: job.reportKind || command?.reportKind || '',
    summary,
    error: job.error || '',
    hasAudio: Boolean(job.audioFile),
    expiresAt: job.createdAt ? new Date(Date.parse(job.createdAt) + retentionMs).toISOString() : ''
  };
}

async function recordTextVoiceJob({ transcript, command, tasks = [], editedReport = null, reportKind = '', status = 'completed', error = '', cleared = false }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
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

async function purgeExpiredVoiceJobs(retentionDays = jobSettings.voiceRetention.retentionDays) {
  const cutoff = Date.now() - voiceRetentionMs(retentionDays);
  let removed = 0;
  await mkdir(voiceJobsDir, { recursive: true });
  const files = await readdir(voiceJobsDir);
  for (const file of files) {
    const full = path.join(voiceJobsDir, file);
    try {
      if (file.endsWith('.json')) {
        const job = JSON.parse(await readFile(full, 'utf8'));
        const ts = Date.parse(job?.createdAt || job?.updatedAt || '') || 0;
        if (!ts || ts >= cutoff) continue;
        if (job?.id) voiceJobs.delete(job.id);
        await unlink(full).catch(() => {});
        if (job?.audioFile) await unlink(path.join(voiceJobsDir, job.audioFile)).catch(() => {});
        removed += 1;
        continue;
      }
      const info = await stat(full);
      if (info.mtimeMs < cutoff) {
        await unlink(full).catch(() => {});
        removed += 1;
      }
    } catch (error) {
      console.error(`清理语音指令失败 ${file}`, error);
    }
  }
  return { removed, retentionDays: Math.max(1, Number(retentionDays) || 7) };
}

async function runVoiceRetentionJobIfDue(force = false) {
  const schedule = jobSettings.voiceRetention;
  if (!force && !schedule.enabled) return null;
  const now = new Date();
  const time = force ? (schedule.times[0] || '03:00') : latestDueJobTime(schedule.times, now);
  if (!time) return null;
  const dateKey = localDateKey(now);
  const slotKey = `voiceRetention:${dateKey}-${time.replace(':', '')}`;
  if (!force && jobSettings.doneSlots?.[slotKey]) return null;
  const result = await purgeExpiredVoiceJobs(schedule.retentionDays);
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

function persistVoiceResultToSqlite(job,result){
  if(supabaseUrl)return [];
  const command=result.command;
  if(command?.action==='edit_report'||command?.action==='clarify'){deleteSqliteTask(job.id);return []}
  if(command?.action==='update'){
    deleteSqliteTask(job.id);const requested=command.updates?.length?command.updates:[{targetTaskId:command.targetTaskId,changes:command.changes}];const ids=[];
    for(const entry of requested){const current=getSqliteTask(entry.targetTaskId);if(!current)continue;const changes={...(entry.changes||{})};const now=new Date().toISOString();
      if(changes.status==='doing'){changes.progress=current.progress>0&&current.progress<100?current.progress:50;changes.startedAt=current.startedAt||now;changes.completedAt=null}
      if(changes.status==='done'){changes.progress=100;changes.startedAt=current.startedAt||now;changes.completedAt=now}
      if(changes.status==='todo'){changes.progress=0;changes.startedAt=null;changes.completedAt=null}
      patchSqliteTask(current.id,changes);ids.push(current.id)}
    return ids;
  }
  const parsedTasks=(result.tasks?.length?result.tasks:command?.tasks?.length?command.tasks:result.task?[result.task]:[]).slice(0,10);
  return parsedTasks.map((parsed,index)=>{
    const id=index===0?job.id:`${job.id}-${index+1}`;
    saveSqliteTask({id,title:parsed.title||result.transcript||'语音任务',assignee:parsed.assignee||'我',due:parsed.due||'今天',status:'todo',priority:parsed.priority||'中',progress:0,estimatedMinutes:parsed.estimatedMinutes||60,createdAt:job.createdAt,startedAt:null,completedAt:null,aiStatus:null});
    return id;
  });
}

async function processVoiceJob(id) {
  const job = voiceJobs.get(id);
  if (!job || runningVoiceJobs.has(id) || job.status === 'completed') return;
  runningVoiceJobs.add(id);
  try {
    job.status = 'processing';
    job.stage = 'transcribing';
    job.error = '';
    await persistVoiceJob(job);
    const buffer = await readFile(path.join(voiceJobsDir, job.audioFile));
    const result = await transcribeAudio(buffer, job.mime, job.availableTasks || [],async(stage,details={})=>{job.stage=stage;if(details.transcript)job.transcript=details.transcript;await persistVoiceJob(job)}, job.reports || {});
    if (job.cancelled) return;
    job.transcript = result.transcript;
    job.command = result.command;
    if (result.command?.action === 'edit_report') {
      job.stage = 'understanding';
      await persistVoiceJob(job);
      const kind = result.command.reportKind;
      const source = job.reports?.[kind];
      const edited = await editReportContent(kind, source, result.command.instruction || result.transcript);
      if (job.cancelled) return;
      job.stage = 'saving';
      job.editedReport = edited;
      job.cleared = edited == null;
      job.reportKind = kind;
      job.tasks = [];
      job.task = null;
      if (job.cleared) job.command = { ...result.command, message: result.command.message || (kind === 'weekly' ? '周报已清空' : kind === 'monthly' ? '月报已清空' : '今日复盘已清空') };
      await persistVoiceJob(job);
      try{deleteSqliteTask(job.id);job.persistedTaskIds=[];job.storageError=''}catch(error){job.storageError=error?.message||'清理占位任务失败'}
    } else {
      job.stage = 'saving';
      job.tasks = result.tasks || [];
      job.task = result.task;
      job.editedReport = null;
      job.reportKind = '';
      await persistVoiceJob(job);
      try{job.persistedTaskIds=persistVoiceResultToSqlite(job,result);job.storageError=''}catch(error){console.error('语音任务写入 SQLite 失败',error);job.storageError=error?.message||'SQLite 保存失败'}
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
  const files = await readdir(voiceJobsDir);
  for (const file of files.filter(name => name.endsWith('.json'))) {
    try {
      const job = JSON.parse(await readFile(path.join(voiceJobsDir, file), 'utf8'));
      if (!job?.id) continue;
      voiceJobs.set(job.id, job);
      if (job.status === 'queued' || job.status === 'processing') {
        job.status = 'queued';
        setImmediate(() => void processVoiceJob(job.id));
      }
    } catch (error) {
      console.error(`无法恢复语音任务 ${file}`, error);
    }
  }
}

function reportEditJobPath(id) {
  return path.join(reportEditJobsDir, `${id}.json`);
}

async function persistReportEditJob(job) {
  job.updatedAt = new Date().toISOString();
  reportEditJobs.set(job.id, job);
  await mkdir(reportEditJobsDir, { recursive: true });
  await writeFile(reportEditJobPath(job.id), JSON.stringify(job), { encoding: 'utf8', mode: 0o600 });
}

function publicReportEditJob(job) {
  const { audioFile: _audioFile, sourceReport: _sourceReport, ...safeJob } = job;
  return safeJob;
}

function isClearReportInstruction(instruction = '') {
  const text = String(instruction || '');
  return /(清空|清除|删掉|删除|重置).{0,12}(复盘|日报|周报|月报|内容|全部|小结)?|(复盘|日报|周报|月报|小结).{0,12}(清空|清除|删掉|删除|重置)|全部清空|清空全部|不要复盘|取消复盘/.test(text);
}

async function editReportContent(kind, report, instruction) {
  if (isClearReportInstruction(instruction)) return null;
  const schema = kind === 'daily'
    ? '保持日报结构：headline、summary、completed字符串数组、risks字符串数组、tomorrow对象数组(title,reason,priority高/中/低,suggestedTime)。若用户要求清空/删除整份复盘，输出 {"cleared":true}。'
    : '保持周/月报结构：headline、summary、highlights字符串数组、risks字符串数组、next对象数组(title,reason,priority高/中/低,suggestedTime)。若用户要求清空/删除整份复盘，输出 {"cleared":true}。';
  const data = await qwenChat({
    messages: [
      { role: 'system', content: `你是中文工作复盘编辑助手。根据用户修改意见，在现有复盘 JSON 上做最小必要修改，保留未提及内容。不要虚构成果。只输出合法 JSON，不要 Markdown。${schema}` },
      { role: 'user', content: `复盘类型：${kind}\n现有复盘：${JSON.stringify(report)}\n修改意见：${instruction}` }
    ],
    responseFormat: { type: 'json_object' }
  });
  const edited = parseJSON(messageText(data));
  if (edited?.cleared === true) return null;
  return kind === 'daily' ? normalizeDailyReport(edited) : normalizePeriodReport(edited, 8);
}

async function asrTranscript(buffer, mime = 'audio/webm') {
  const data = await qwenChat({
    apiKey: resolveAsrKey(),
    model: asrModel,
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${buffer.toString('base64')}` } }] }],
    extra: { stream: false, asr_options: { language: 'zh', enable_itn: true } }
  });
  const transcript = convertToSimplified(messageText(data).trim());
  if (!transcript) throw new Error('千问语音模型没有返回转写内容');
  return transcript;
}

async function processReportEditJob(id) {
  const job = reportEditJobs.get(id);
  if (!job || runningReportEditJobs.has(id) || job.status === 'completed') return;
  runningReportEditJobs.add(id);
  try {
    job.status = 'processing';
    job.stage = job.audioFile ? 'transcribing' : 'understanding';
    job.error = '';
    await persistReportEditJob(job);
    let instruction = String(job.instruction || '').trim();
    if (job.audioFile) {
      const buffer = await readFile(path.join(reportEditJobsDir, job.audioFile));
      const spoken = await asrTranscript(buffer, job.mime || 'audio/webm');
      if (job.cancelled) return;
      job.transcript = spoken;
      instruction = instruction ? `${instruction}\n${spoken}` : spoken;
      job.stage = 'understanding';
      await persistReportEditJob(job);
    }
    if (!instruction) throw new Error('没有识别到可执行的修改意见');
    job.instruction = instruction;
    const report = await editReportContent(job.kind, job.sourceReport, instruction);
    if (job.cancelled) return;
    job.stage = 'saving';
    job.report = report;
    job.cleared = report == null;
    await persistReportEditJob(job);
    job.status = 'completed';
    job.stage = 'completed';
    await persistReportEditJob(job);
    if (job.audioFile) await unlink(path.join(reportEditJobsDir, job.audioFile)).catch(() => {});
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
  const files = await readdir(reportEditJobsDir);
  for (const file of files.filter(name => name.endsWith('.json'))) {
    try {
      const job = JSON.parse(await readFile(path.join(reportEditJobsDir, file), 'utf8'));
      if (!job?.id) continue;
      reportEditJobs.set(job.id, job);
      if (job.status === 'queued' || job.status === 'processing') {
        job.status = 'queued';
        setImmediate(() => void processReportEditJob(job.id));
      }
    } catch (error) {
      console.error(`无法恢复复盘改稿任务 ${file}`, error);
    }
  }
}

app.get('/api/health', (_req, res) => res.json({
  ai: Boolean(textApiKey),
  asr: Boolean(resolveAsrKey()),
  textConfigured: Boolean(textApiKey),
  asrConfigured: Boolean(asrApiKey),
  asrUsesTextKey: Boolean(!asrApiKey && textApiKey),
  provider: '阿里云百炼',
  textModel,
  transcriptionModel: asrModel,
  storage: { mode: 'sqlite', file: sqliteDisplayPath }
}));

app.get('/api/sqlite/tasks', (_req, res) => res.json(listSqliteTasks()));

app.get('/api/sqlite/tasks/:id', (req, res) => {
  const task=getSqliteTask(req.params.id);
  if(!task)return res.status(404).json({message:'任务不存在'});
  res.json(task);
});

app.put('/api/sqlite/tasks/:id', (req, res) => {
  try{res.json(saveSqliteTask({...req.body,id:req.params.id}))}
  catch(error){res.status(400).json({message:error?.message||'任务保存失败'})}
});

app.patch('/api/sqlite/tasks/:id', (req, res) => {
  try{const task=patchSqliteTask(req.params.id,req.body||{});if(!task)return res.status(404).json({message:'任务不存在'});res.json(task)}
  catch(error){res.status(400).json({message:error?.message||'任务更新失败'})}
});

app.delete('/api/sqlite/tasks/:id', (req, res) => {
  deleteSqliteTask(req.params.id);res.status(204).end();
});

app.get('/api/sqlite/reports/:date', (req, res) => {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date))return res.status(400).json({message:'日期格式不正确'});
  res.json(loadSqliteReport(req.params.date));
});

app.put('/api/sqlite/reports/:date', (req, res) => {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date))return res.status(400).json({message:'日期格式不正确'});
  if(!req.body?.report||typeof req.body.report!=='object')return res.status(400).json({message:'日报内容不能为空'});
  res.json(saveSqliteReport(req.params.date,req.body.report));
});

app.delete('/api/sqlite/reports/:date', (req, res) => {
  deleteSqliteReport(req.params.date);res.status(204).end();
});

app.get('/api/sqlite/period-reports/:kind', (req, res) => {
  try {
    if (!['weekly', 'monthly'].includes(req.params.kind)) return res.status(400).json({ message: '周期类型不正确' });
    res.json(listSqlitePeriodReports(req.params.kind));
  } catch (error) {
    res.status(400).json({ message: error?.message || '读取周期复盘列表失败' });
  }
});

app.get('/api/sqlite/period-reports/:kind/:key', (req, res) => {
  try {
    if (!isPeriodKey(req.params.kind, req.params.key)) return res.status(400).json({ message: '周期键格式不正确' });
    res.json(loadSqlitePeriodReport(req.params.kind, req.params.key));
  } catch (error) {
    res.status(400).json({ message: error?.message || '读取周期复盘失败' });
  }
});

app.put('/api/sqlite/period-reports/:kind/:key', (req, res) => {
  try {
    if (!isPeriodKey(req.params.kind, req.params.key)) return res.status(400).json({ message: '周期键格式不正确' });
    if (!req.body?.report || typeof req.body.report !== 'object') return res.status(400).json({ message: '复盘内容不能为空' });
    res.json(saveSqlitePeriodReport(req.params.kind, req.params.key, req.body.report));
  } catch (error) {
    res.status(400).json({ message: error?.message || '保存周期复盘失败' });
  }
});

app.delete('/api/sqlite/period-reports/:kind/:key', (req, res) => {
  try {
    deleteSqlitePeriodReport(req.params.kind, req.params.key);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ message: error?.message || '删除周期复盘失败' });
  }
});

app.get('/api/settings/cloud', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    configured: Boolean(supabaseUrl && supabaseAnonKey),
    url: supabaseUrl,
    anonKey: supabaseAnonKey,
    maskedKey: supabaseAnonKey ? `••••••${supabaseAnonKey.slice(-6)}` : ''
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

app.get('/api/settings/model', requireSettingsAccess, (_req, res) => res.json({
  configured: Boolean(textApiKey),
  textConfigured: Boolean(textApiKey),
  asrConfigured: Boolean(asrApiKey),
  asrUsesTextKey: Boolean(!asrApiKey && textApiKey),
  maskedTextKey: maskKey(textApiKey),
  maskedAsrKey: maskKey(asrApiKey),
  maskedKey: maskKey(textApiKey),
  textModel,
  asrModel,
  provider: '阿里云百炼'
}));

app.put('/api/settings/model', requireSettingsAccess, async (req, res) => {
  try {
    const nextTextKey = String(req.body?.textApiKey || req.body?.apiKey || '').trim();
    const nextAsrKey = String(req.body?.asrApiKey || '').trim();
    const clearAsrKey = Boolean(req.body?.clearAsrKey);
    const nextTextModel = String(req.body?.textModel || textModel).trim();
    const nextAsrModel = String(req.body?.asrModel || asrModel).trim();
    const allowedText = ['qwen3.7-plus', 'qwen-plus', 'qwen3.6-flash', 'deepseek-v3.2', 'deepseek-v4-pro', 'deepseek-v4-flash'];
    const allowedAsr = ['qwen3-asr-flash', 'qwen3-asr-flash-2026-02-10'];
    if (!textApiKey && !nextTextKey) return res.status(400).json({ message: '首次配置必须填写任务理解 API Key' });
    if (nextTextKey && !isValidApiKey(nextTextKey)) return res.status(400).json({ message: '任务理解 API Key 格式不正确' });
    if (nextAsrKey && !isValidApiKey(nextAsrKey)) return res.status(400).json({ message: '语音识别 API Key 格式不正确' });
    if (!allowedText.includes(nextTextModel) || !allowedAsr.includes(nextAsrModel)) return res.status(400).json({ message: '不支持所选模型' });
    if (nextTextKey) textApiKey = nextTextKey;
    if (clearAsrKey) asrApiKey = '';
    else if (nextAsrKey) asrApiKey = nextAsrKey;
    textModel = nextTextModel; asrModel = nextAsrModel;
    await persistEnv({
      ...(nextTextKey ? { DASHSCOPE_API_KEY: nextTextKey, DASHSCOPE_TEXT_API_KEY: nextTextKey } : {}),
      DASHSCOPE_ASR_API_KEY: asrApiKey,
      QWEN_TEXT_MODEL: textModel,
      QWEN_ASR_MODEL: asrModel
    });
    res.json({
      configured: true,
      textConfigured: Boolean(textApiKey),
      asrConfigured: Boolean(asrApiKey),
      asrUsesTextKey: Boolean(!asrApiKey && textApiKey),
      maskedTextKey: maskKey(textApiKey),
      maskedAsrKey: maskKey(asrApiKey),
      maskedKey: maskKey(textApiKey),
      textModel,
      asrModel,
      message: '模型设置已保存并立即生效'
    });
  } catch (error) {
    res.status(500).json({ message: error?.message || '模型设置保存失败' });
  }
});

app.post('/api/parse-task-text', requireTextAi, async (req, res) => {
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
    const command = await parseVoiceCommand(transcript, availableTasks, reports);
    if (command.action === 'edit_report') {
      const kind = command.reportKind;
      const source = reports?.[kind];
      const editedReport = await editReportContent(kind, source, command.instruction || transcript);
      const cleared = editedReport == null;
      const nextCommand = cleared
        ? { ...command, message: command.message || (kind === 'weekly' ? '周报已清空' : kind === 'monthly' ? '月报已清空' : '今日复盘已清空') }
        : command;
      const job = await recordTextVoiceJob({ transcript, command: nextCommand, tasks: [], editedReport, reportKind: kind, status: 'completed', cleared });
      return res.json({ command: nextCommand, reportKind: kind, editedReport, cleared, tasks: [], count: 0, jobId: job.id });
    }
    if (command.action === 'update' || command.action === 'clarify') {
      const job = await recordTextVoiceJob({ transcript, command, tasks: [], status: 'completed' });
      return res.json({ command, tasks: [], count: 0, jobId: job.id });
    }
    const tasks = command.tasks || [];
    const job = await recordTextVoiceJob({ transcript, command, tasks, status: 'completed' });
    res.json({ command, tasks, count: tasks.length, jobId: job.id });
  }catch(error){
    console.error(error);
    const transcript=String(req.body?.transcript||'').trim().slice(0,5000);
    if(transcript)await recordTextVoiceJob({ transcript, command: null, status: 'failed', error: error?.message||'AI 指令理解失败' }).catch(()=>{});
    res.status(502).json({message:error?.message||'AI 指令理解失败'});
  }
});

app.get('/api/settings/jobs', (_req, res) => {
  res.json({ voiceRetention: jobSettings.voiceRetention });
});

app.put('/api/settings/jobs', async (req, res) => {
  try {
    jobSettings.voiceRetention = normalizeVoiceRetentionSettings(req.body?.voiceRetention || req.body);
    await persistJobSettings();
    res.json({ voiceRetention: jobSettings.voiceRetention, message: '后台作业设置已保存' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: '保存后台作业设置失败' });
  }
});

app.post('/api/voice-jobs/purge', async (req, res) => {
  try {
    const days = Number(req.body?.retentionDays);
    if (Number.isInteger(days) && days >= 1 && days <= 90) {
      jobSettings.voiceRetention = { ...jobSettings.voiceRetention, retentionDays: days };
    }
    const force = Boolean(req.body?.force);
    const result = force
      ? await purgeExpiredVoiceJobs(jobSettings.voiceRetention.retentionDays).then(async data => {
          const now = new Date();
          const time = latestDueJobTime(jobSettings.voiceRetention.times, now) || jobSettings.voiceRetention.times[0] || '03:00';
          const slotKey = `voiceRetention:${localDateKey(now)}-${String(time).replace(':', '')}`;
          jobSettings.doneSlots = { ...(jobSettings.doneSlots || {}), [slotKey]: new Date().toISOString() };
          await persistJobSettings();
          return { ...data, slotKey, time };
        })
      : await runVoiceRetentionJobIfDue(false);
    if (!result) return res.json({ skipped: true, message: '当前未到清理作业时间，或本时段已执行', voiceRetention: jobSettings.voiceRetention });
    res.json({ skipped: false, ...result, voiceRetention: jobSettings.voiceRetention, message: `已清理 ${result.removed} 条过期指令` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: '清理语音指令失败' });
  }
});

app.get('/api/voice-jobs', async (_req, res) => {
  try {
    const retentionDays = jobSettings.voiceRetention.retentionDays;
    const cutoff = Date.now() - voiceRetentionMs(retentionDays);
    const items = [...voiceJobs.values()]
      .filter(job => {
        const ts = Date.parse(job?.createdAt || job?.updatedAt || '') || 0;
        return !ts || ts >= cutoff;
      })
      .sort((a, b) => Date.parse(b.createdAt || b.updatedAt || 0) - Date.parse(a.createdAt || a.updatedAt || 0))
      .map(voiceJobListItem);
    res.json({ retentionDays, voiceRetention: jobSettings.voiceRetention, items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: '读取语音指令历史失败' });
  }
});

app.post('/api/voice-jobs', upload.single('audio'), requireVoiceAi, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'NO_AUDIO', message: '没有收到录音文件' });
    const mime = req.file.mimetype || 'audio/webm';
    let availableTasks = [];
    let reports = {};
    try { const parsed = JSON.parse(String(req.body?.tasks || '[]')); if (Array.isArray(parsed)) availableTasks = parsed.slice(0, 100); } catch {}
    try {
      const parsed = JSON.parse(String(req.body?.reports || '{}'));
      if (parsed && typeof parsed === 'object') {
        reports = {
          daily: parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : null,
          weekly: parsed.weekly && typeof parsed.weekly === 'object' ? parsed.weekly : null,
          monthly: parsed.monthly && typeof parsed.monthly === 'object' ? parsed.monthly : null
        };
      }
    } catch {}
    const id = randomUUID();
    const audioFile = `${id}.${audioExtension(mime)}`;
    await mkdir(voiceJobsDir, { recursive: true });
    await writeFile(path.join(voiceJobsDir, audioFile), req.file.buffer, { mode: 0o600 });
    const job = {
      id,
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

app.get('/api/voice-jobs/:id', (req, res) => {
  const job = voiceJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'VOICE_JOB_NOT_FOUND', message: '没有找到这条语音任务' });
  res.json(publicVoiceJob(job));
});

app.get('/api/voice-jobs/:id/audio', async (req, res) => {
  const job = voiceJobs.get(req.params.id);
  if (!job?.audioFile) return res.status(404).json({ message: '这条指令没有可播放的录音' });
  const filePath = path.join(voiceJobsDir, job.audioFile);
  try {
    await stat(filePath);
  } catch {
    return res.status(404).json({ message: '录音文件已过期或不存在' });
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.type(job.mime || 'audio/webm');
  res.sendFile(filePath);
});

app.delete('/api/voice-jobs/:id', async (req, res) => {
  const job = voiceJobs.get(req.params.id);
  if (job) job.cancelled = true;
  voiceJobs.delete(req.params.id);
  await unlink(voiceJobPath(req.params.id)).catch(() => {});
  if (job?.audioFile) await unlink(path.join(voiceJobsDir, job.audioFile)).catch(() => {});
  res.status(204).end();
});

app.post('/api/voice-jobs/:id/retry', requireVoiceAi, async (req, res) => {
  const job = voiceJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'VOICE_JOB_NOT_FOUND', message: '没有找到这条语音任务' });
  if (job.status === 'completed') return res.status(409).json({ message: '这条语音任务已经识别完成' });
  job.status = 'queued';
  job.stage = 'queued';
  job.error = '';
  await persistVoiceJob(job);
  res.status(202).json(publicVoiceJob(job));
  setImmediate(() => void processVoiceJob(job.id));
});

app.post('/api/transcribe', upload.single('audio'), requireVoiceAi, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'NO_AUDIO', message: '没有收到录音文件' });
    let availableTasks = [];
    try { const parsed = JSON.parse(String(req.body?.tasks || '[]')); if (Array.isArray(parsed)) availableTasks = parsed.slice(0, 100); } catch {}
    res.json(await transcribeAudio(req.file.buffer, req.file.mimetype || 'audio/webm', availableTasks));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_TRANSCRIBE_FAILED', message: voiceErrorMessage(error) });
  }
});

app.post('/api/daily-plan', requireTextAi, async (req, res) => {
  try {
    const { tasks = [], date, user = '用户' } = req.body || {};
    const data = await qwenChat({
      messages: [
        { role: 'system', content: '你是务实的中文工作规划助手。根据真实任务数据总结当天完成情况，并规划明天。优先考虑逾期、进行中、高优先级和依赖关系，不要声称未提供的成果。次日计划最多5项，按重要性排序。只输出合法 JSON，不要 Markdown。JSON字段：headline字符串、summary字符串、completed字符串数组、risks字符串数组、tomorrow对象数组；tomorrow每项包含title、reason、priority(高/中/低)、suggestedTime。' },
        { role: 'user', content: `用户：${user}\n日期：${date}\n任务数据：${JSON.stringify(tasks)}` }
      ],
      responseFormat: { type: 'json_object' }
    });
    res.json(normalizeDailyReport(parseJSON(messageText(data))));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_PLAN_FAILED', message: error?.message || '千问日报生成失败' });
  }
});

app.post('/api/weekly-plan', requireTextAi, async (req, res) => {
  try {
    const { tasks = [], weekStart, weekEnd, user = '用户' } = req.body || {};
    const data = await qwenChat({
      messages: [
        { role: 'system', content: '你是务实的中文周报助手。根据真实任务数据总结本周完成亮点与风险，并规划下周重点。不要虚构未提供的成果。下周计划最多8项，按重要性排序。只输出合法 JSON，不要 Markdown。JSON字段：headline字符串、summary字符串、highlights字符串数组、risks字符串数组、next对象数组；next每项包含title、reason、priority(高/中/低)、suggestedTime。' },
        { role: 'user', content: `用户：${user}\n本周：${weekStart} 至 ${weekEnd}\n任务数据：${JSON.stringify(tasks)}` }
      ],
      responseFormat: { type: 'json_object' }
    });
    res.json(normalizePeriodReport(parseJSON(messageText(data)), 8));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_WEEKLY_FAILED', message: error?.message || '千问周报生成失败' });
  }
});

app.post('/api/monthly-plan', requireTextAi, async (req, res) => {
  try {
    const { tasks = [], month, user = '用户' } = req.body || {};
    const data = await qwenChat({
      messages: [
        { role: 'system', content: '你是务实的中文月报助手。根据真实任务数据总结本月完成亮点与风险，并规划下月重点。不要虚构未提供的成果。下月计划最多8项，按重要性排序。只输出合法 JSON，不要 Markdown。JSON字段：headline字符串、summary字符串、highlights字符串数组、risks字符串数组、next对象数组；next每项包含title、reason、priority(高/中/低)、suggestedTime。' },
        { role: 'user', content: `用户：${user}\n月份：${month}\n任务数据：${JSON.stringify(tasks)}` }
      ],
      responseFormat: { type: 'json_object' }
    });
    res.json(normalizePeriodReport(parseJSON(messageText(data)), 8));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_MONTHLY_FAILED', message: error?.message || '千问月报生成失败' });
  }
});

app.post('/api/edit-report', upload.single('audio'), requireTextAi, async (req, res) => {
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
      if (!resolveAsrKey()) return res.status(503).json({ message: '服务端尚未配置语音识别 API Key' });
      const spoken = await asrTranscript(req.file.buffer, req.file.mimetype || 'audio/webm');
      instruction = instruction ? `${instruction}\n${spoken}` : spoken;
    }
    if (!instruction) return res.status(400).json({ message: '请提供修改说明或录音' });
    if (req.file && !resolveAsrKey()) return res.status(503).json({ message: '服务端尚未配置语音识别 API Key' });
    const normalized = await editReportContent(kind, report, instruction);
    if (normalized == null) return res.json({ report: null, cleared: true, transcript: instruction });
    res.json({ report: normalized, cleared: false, transcript: instruction });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_EDIT_FAILED', message: error?.message || '复盘修改失败' });
  }
});

app.post('/api/report-edit-jobs', upload.single('audio'), requireTextAi, async (req, res) => {
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
    if (req.file && !resolveAsrKey()) return res.status(503).json({ message: '服务端尚未配置语音识别 API Key' });
    const id = randomUUID();
    const mime = req.file?.mimetype || 'audio/webm';
    let audioFile = '';
    if (req.file) {
      audioFile = `${id}.${audioExtension(mime)}`;
      await mkdir(reportEditJobsDir, { recursive: true });
      await writeFile(path.join(reportEditJobsDir, audioFile), req.file.buffer, { mode: 0o600 });
    }
    const job = {
      id,
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

app.get('/api/report-edit-jobs/:id', requireTextAi, (req, res) => {
  const job = reportEditJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'REPORT_EDIT_JOB_NOT_FOUND', message: '没有找到这条复盘改稿任务' });
  res.json(publicReportEditJob(job));
});

app.delete('/api/report-edit-jobs/:id', async (req, res) => {
  const job = reportEditJobs.get(req.params.id);
  if (job) job.cancelled = true;
  reportEditJobs.delete(req.params.id);
  await unlink(reportEditJobPath(req.params.id)).catch(() => {});
  if (job?.audioFile) await unlink(path.join(reportEditJobsDir, job.audioFile)).catch(() => {});
  res.status(204).end();
});

app.post('/api/report-edit-jobs/:id/retry', requireVoiceAi, async (req, res) => {
  const job = reportEditJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'REPORT_EDIT_JOB_NOT_FOUND', message: '没有找到这条复盘改稿任务' });
  if (job.status === 'completed') return res.status(409).json({ message: '这条复盘改稿任务已经完成' });
  job.status = 'queued';
  job.stage = 'queued';
  job.error = '';
  await persistReportEditJob(job);
  res.status(202).json(publicReportEditJob(job));
  setImmediate(() => void processReportEditJob(job.id));
});

const dist = path.resolve(__dirname, '../dist');
app.use((req,res,next)=>{if(req.path==='/'||req.path==='/index.html'||req.path==='/sw.js')res.set('Cache-Control','no-store, no-cache, must-revalidate');next()});
app.use(express.static(dist));
app.get('/{*splat}', (_req, res) => res.set('Cache-Control','no-store').sendFile(path.join(dist, 'index.html')));
let sqliteClosed=false;
const closeDatabase=()=>{if(sqliteClosed)return;sqliteClosed=true;closeSqlite()};
process.once('SIGINT',()=>{closeDatabase();process.exit(0)});
process.once('SIGTERM',()=>{closeDatabase();process.exit(0)});
process.once('exit',closeDatabase);
Promise.all([loadJobSettings(), recoverVoiceJobs(), recoverReportEditJobs()])
  .then(() => {
    setInterval(() => { void runVoiceRetentionJobIfDue(false).catch(console.error); }, 60 * 1000);
    app.listen(port, '0.0.0.0', () => console.log(`FlowMate Qwen server: http://localhost:${port}`));
  })
  .catch(error => {
    console.error('语音任务队列初始化失败', error);
    process.exitCode = 1;
  });
