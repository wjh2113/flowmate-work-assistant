import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { Converter } from 'opencc-js/t2cn';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const port = Number(process.env.PORT || 8787);
let apiKey = process.env.DASHSCOPE_API_KEY || '';
const baseURL = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
let textModel = process.env.QWEN_TEXT_MODEL || 'qwen3.7-plus';
let asrModel = process.env.QWEN_ASR_MODEL || 'qwen3-asr-flash';
let supabaseUrl = process.env.VITE_SUPABASE_URL || '';
let supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || '';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
const voiceJobsDir = path.resolve(__dirname, '../data/voice-jobs');
const voiceJobs = new Map();
const runningVoiceJobs = new Set();
const convertToSimplified = Converter({ from: 'tw', to: 'cn' });

function simplify(value) {
  if (typeof value === 'string') return convertToSimplified(value);
  if (Array.isArray(value)) return value.map(simplify);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, simplify(item)]));
  return value;
}

app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', 1);

function requireQwen(_req, res, next) {
  if (!apiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED', message: '服务端尚未配置 DASHSCOPE_API_KEY' });
  next();
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

async function qwenChat({ model = textModel, messages, responseFormat, extra = {} }) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, ...(responseFormat ? { response_format: responseFormat } : {}), ...extra })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `千问接口请求失败 (${response.status})`);
  return data;
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

function normalizeParsedTask(parsed, transcript) {
  return simplify({
    title: String(parsed?.title || transcript), assignee: String(parsed?.assignee || '我'),
    due: String(parsed?.due || '今天'), priority: ['高','中','低'].includes(parsed?.priority) ? parsed.priority : '中',
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0.8)),
    estimatedMinutes: Math.max(15, Math.min(480, Math.round(Number(parsed?.estimatedMinutes) || 60)))
  });
}

async function parseTask(transcript) {
  const data = await qwenChat({
    messages: [
      { role: 'system', content: '你是中文工作任务助手。把口语准确整理为单个可执行任务。不要虚构信息；未提负责人时写“我”，未提日期时写“今天”。任务标题只保留动作和对象。根据任务复杂度合理估算处理时长。只输出合法 JSON，不要 Markdown。JSON字段：title字符串、assignee字符串、due简短中文、priority为高/中/低、confidence为0到1数字、estimatedMinutes为15到480之间的整数分钟数。' },
      { role: 'user', content: `当前日期：${new Date().toLocaleDateString('zh-CN')}\n当前用户：我\n语音内容：${transcript}` }
    ],
    responseFormat: { type: 'json_object' }
  });
  const parsed = parseJSON(messageText(data));
  return normalizeParsedTask(parsed, transcript);
}

async function parseVoiceCommand(transcript, availableTasks = []) {
  const tasks = availableTasks.slice(0, 100).map(task => ({
    id: String(task.id || ''), title: String(task.title || ''), assignee: String(task.assignee || '我'),
    due: String(task.due || '今天'), status: ['todo','doing','done'].includes(task.status) ? task.status : 'todo',
    priority: ['高','中','低'].includes(task.priority) ? task.priority : '中',
    estimatedMinutes: Math.max(1, Number(task.estimatedMinutes) || 60)
  })).filter(task => task.id && task.title);
  const data = await qwenChat({
    messages: [
      { role: 'system', content: '你是中文工作任务语音指令助手。判断用户是在新建任务，还是修改已有任务。修改包括：更改标题、负责人、截止时间、优先级、预估时长，或把状态设为未开始(todo)、进行中(doing)、已完成(done)。修改时只能使用候选任务中真实存在的 id，并根据任务名称语义匹配最可能的唯一目标；目标不明确、存在多个相似候选或没有提供具体修改内容时必须返回 clarify，绝不能猜测。新建时整理成可执行任务。只输出合法 JSON，不要 Markdown。JSON结构：action为create/update/clarify；targetTaskId为字符串或null；changes为对象，仅包含用户明确要求修改的title、assignee、due、priority、status、estimatedMinutes；task为新建任务对象，包含title、assignee、due、priority、estimatedMinutes、confidence；message为简短中文说明；confidence为0到1数字。' },
      { role: 'user', content: `当前日期：${new Date().toLocaleDateString('zh-CN')}\n当前用户：我\n候选任务：${JSON.stringify(tasks)}\n语音指令：${transcript}` }
    ],
    responseFormat: { type: 'json_object' }
  });
  const parsed = parseJSON(messageText(data));
  if (parsed.action === 'update') {
    const target = tasks.find(task => task.id === String(parsed.targetTaskId || ''));
    const source = parsed.changes && typeof parsed.changes === 'object' ? parsed.changes : {};
    const changes = {};
    if (typeof source.title === 'string' && source.title.trim()) changes.title = source.title.trim().slice(0, 500);
    if (typeof source.assignee === 'string' && source.assignee.trim()) changes.assignee = source.assignee.trim().slice(0, 80);
    if (typeof source.due === 'string' && source.due.trim()) changes.due = source.due.trim().slice(0, 80);
    if (['高','中','低'].includes(source.priority)) changes.priority = source.priority;
    if (['todo','doing','done'].includes(source.status)) changes.status = source.status;
    if (Number(source.estimatedMinutes) > 0) changes.estimatedMinutes = Math.max(1, Math.min(1440, Math.round(Number(source.estimatedMinutes))));
    if (target && Object.keys(changes).length) return simplify({ action: 'update', targetTaskId: target.id, changes, message: String(parsed.message || `修改“${target.title}”`), confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.8)) });
    return { action: 'clarify', targetTaskId: null, changes: {}, message: '没有找到唯一的目标任务，请说出更完整的任务名称和修改内容', confidence: 0 };
  }
  if (parsed.action === 'clarify') return simplify({ action: 'clarify', targetTaskId: null, changes: {}, message: String(parsed.message || '请说出要修改的任务名称和修改内容'), confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)) });
  return { action: 'create', targetTaskId: null, changes: {}, task: normalizeParsedTask(parsed.task || parsed, transcript), message: String(parsed.message || '创建新任务'), confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || Number(parsed.task?.confidence) || 0.8)) };
}

async function transcribeAudio(buffer, mime = 'audio/webm', availableTasks = []) {
  const audio = `data:${mime};base64,${buffer.toString('base64')}`;
  const data = await qwenChat({
    model: asrModel,
    messages: [
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: audio } }] }
    ],
    extra: { stream: false, asr_options: { language: 'zh', enable_itn: true } }
  });
  const transcript = convertToSimplified(messageText(data).trim());
  if (!transcript) throw new Error('千问语音模型没有返回转写内容');
  if (!availableTasks.length) return { transcript, task: await parseTask(transcript), command: null };
  const command = await parseVoiceCommand(transcript, availableTasks);
  return { transcript, command, task: command.action === 'create' ? command.task : null };
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
  const { audioFile: _audioFile, availableTasks: _availableTasks, ...safeJob } = job;
  return safeJob;
}

async function processVoiceJob(id) {
  const job = voiceJobs.get(id);
  if (!job || runningVoiceJobs.has(id) || job.status === 'completed') return;
  runningVoiceJobs.add(id);
  try {
    job.status = 'processing';
    job.error = '';
    await persistVoiceJob(job);
    const buffer = await readFile(path.join(voiceJobsDir, job.audioFile));
    const result = await transcribeAudio(buffer, job.mime, job.availableTasks || []);
    if (job.cancelled) return;
    job.status = 'completed';
    job.transcript = result.transcript;
    job.task = result.task;
    job.command = result.command;
    await persistVoiceJob(job);
    await unlink(path.join(voiceJobsDir, job.audioFile)).catch(() => {});
  } catch (error) {
    if (job.cancelled) return;
    console.error(error);
    job.status = 'failed';
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

app.get('/api/health', (_req, res) => res.json({ ai: Boolean(apiKey), provider: '阿里云百炼', textModel, transcriptionModel: asrModel }));

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
  configured: Boolean(apiKey), maskedKey: apiKey ? `••••${apiKey.slice(-4)}` : '', textModel, asrModel,
  provider: '阿里云百炼'
}));

app.put('/api/settings/model', requireSettingsAccess, async (req, res) => {
  try {
    const nextKey = String(req.body?.apiKey || '').trim();
    const nextTextModel = String(req.body?.textModel || textModel).trim();
    const nextAsrModel = String(req.body?.asrModel || asrModel).trim();
    const allowedText = ['qwen3.7-plus', 'qwen-plus', 'qwen3.6-flash', 'deepseek-v3.2', 'deepseek-v4-pro', 'deepseek-v4-flash'];
    const allowedAsr = ['qwen3-asr-flash', 'qwen3-asr-flash-2026-02-10'];
    if (!apiKey && !nextKey) return res.status(400).json({ message: '首次配置必须填写 API Key' });
    if (nextKey && (!nextKey.startsWith('sk-') || nextKey.length < 16)) return res.status(400).json({ message: 'API Key 格式不正确' });
    if (!allowedText.includes(nextTextModel) || !allowedAsr.includes(nextAsrModel)) return res.status(400).json({ message: '不支持所选模型' });
    if (nextKey) apiKey = nextKey;
    textModel = nextTextModel; asrModel = nextAsrModel;
    await persistEnv({ ...(nextKey ? { DASHSCOPE_API_KEY: nextKey } : {}), QWEN_TEXT_MODEL: textModel, QWEN_ASR_MODEL: asrModel });
    res.json({ configured: true, maskedKey: `••••${apiKey.slice(-4)}`, textModel, asrModel, message: '模型设置已保存并立即生效' });
  } catch (error) {
    res.status(500).json({ message: error?.message || '模型设置保存失败' });
  }
});

app.post('/api/voice-jobs', upload.single('audio'), requireQwen, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'NO_AUDIO', message: '没有收到录音文件' });
    const mime = req.file.mimetype || 'audio/webm';
    let availableTasks = [];
    try { const parsed = JSON.parse(String(req.body?.tasks || '[]')); if (Array.isArray(parsed)) availableTasks = parsed.slice(0, 100); } catch {}
    const id = randomUUID();
    const audioFile = `${id}.${audioExtension(mime)}`;
    await mkdir(voiceJobsDir, { recursive: true });
    await writeFile(path.join(voiceJobsDir, audioFile), req.file.buffer, { mode: 0o600 });
    const job = {
      id,
      status: 'queued',
      mime,
      audioFile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      availableTasks,
      transcript: '',
      task: null,
      command: null,
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

app.get('/api/voice-jobs/:id', requireQwen, (req, res) => {
  const job = voiceJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'VOICE_JOB_NOT_FOUND', message: '没有找到这条语音任务' });
  res.json(publicVoiceJob(job));
});

app.delete('/api/voice-jobs/:id', async (req, res) => {
  const job = voiceJobs.get(req.params.id);
  if (job) job.cancelled = true;
  voiceJobs.delete(req.params.id);
  await unlink(voiceJobPath(req.params.id)).catch(() => {});
  if (job?.audioFile) await unlink(path.join(voiceJobsDir, job.audioFile)).catch(() => {});
  res.status(204).end();
});

app.post('/api/voice-jobs/:id/retry', requireQwen, async (req, res) => {
  const job = voiceJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'VOICE_JOB_NOT_FOUND', message: '没有找到这条语音任务' });
  if (job.status === 'completed') return res.status(409).json({ message: '这条语音任务已经识别完成' });
  job.status = 'queued';
  job.error = '';
  await persistVoiceJob(job);
  res.status(202).json(publicVoiceJob(job));
  setImmediate(() => void processVoiceJob(job.id));
});

app.post('/api/transcribe', upload.single('audio'), requireQwen, async (req, res) => {
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

app.post('/api/daily-plan', requireQwen, async (req, res) => {
  try {
    const { tasks = [], date, user = '用户' } = req.body || {};
    const data = await qwenChat({
      messages: [
        { role: 'system', content: '你是务实的中文工作规划助手。根据真实任务数据总结当天完成情况，并规划明天。优先考虑逾期、进行中、高优先级和依赖关系，不要声称未提供的成果。次日计划最多5项，按重要性排序。只输出合法 JSON，不要 Markdown。JSON字段：headline字符串、summary字符串、completed字符串数组、risks字符串数组、tomorrow对象数组；tomorrow每项包含title、reason、priority(高/中/低)、suggestedTime。' },
        { role: 'user', content: `用户：${user}\n日期：${date}\n任务数据：${JSON.stringify(tasks)}` }
      ],
      responseFormat: { type: 'json_object' }
    });
    const report = parseJSON(messageText(data));
    report.completed = Array.isArray(report.completed) ? report.completed : [];
    report.risks = Array.isArray(report.risks) ? report.risks : [];
    report.tomorrow = Array.isArray(report.tomorrow) ? report.tomorrow.slice(0, 5) : [];
    res.json(simplify(report));
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'QWEN_PLAN_FAILED', message: error?.message || '千问日报生成失败' });
  }
});

const dist = path.resolve(__dirname, '../dist');
app.use(express.static(dist));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
recoverVoiceJobs()
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`FlowMate Qwen server: http://localhost:${port}`)))
  .catch(error => {
    console.error('语音任务队列初始化失败', error);
    process.exitCode = 1;
  });
