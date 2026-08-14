const base = process.env.E2E_BASE || 'http://127.0.0.1:8790';

function jar() {
  const m = new Map();
  return {
    store(res) {
      for (const c of res.headers.getSetCookie?.() || []) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        if (i > 0) m.set(kv.slice(0, i), kv.slice(i + 1));
      }
    },
    h() {
      return [...m].map(([k, v]) => `${k}=${v}`).join('; ');
    }
  };
}

const results = [];
const ok = (name, cond, detail = '') => results.push({ name, ok: Boolean(cond), detail });

const health = await (await fetch(`${base}/api/health`)).json();
ok('health.localAuth', health.auth === 'local', health.auth);
ok('health.builtinScope', health.modelScope === 'builtin' && health.requiresUserModel === false, JSON.stringify({ modelScope: health.modelScope, requiresUserModel: health.requiresUserModel }));

const html = await (await fetch(`${base}/`)).text();
const scriptMatch = html.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/);
ok('html.hasBundle', Boolean(scriptMatch), scriptMatch?.[1] || '');
if (scriptMatch) {
  const js = await (await fetch(`${base}${scriptMatch[1]}`)).text();
  ok('html.hasBuiltinPicker', js.includes('内置大模型') || js.includes('积分余额') || js.includes('model-picker'));
  ok('html.hasAdmin', js.includes('管理后台') || js.includes('/api/admin/'));
  ok('html.hasWeights', /0\.0\dx|积分\s*=\s*Token|weight/.test(js) || js.includes('Deepseek') || js.includes('deepseek'));
}
ok('sw.v8', (await (await fetch(`${base}/sw.js`)).text()).includes('flowmate-v8'));

ok('sqlite.401', (await fetch(`${base}/api/sqlite/tasks`)).status === 401);
ok('voice.401', (await fetch(`${base}/api/voice-jobs`)).status === 401);
ok('admin.401', (await fetch(`${base}/api/admin/dashboard`)).status === 401);

const a = jar();
const b = jar();
const ea = `e2e_a_${Date.now()}@t.local`;
const eb = `e2e_b_${Date.now()}@t.local`;
const ra = await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ea, password: 'secret12', name: 'AliceE2E' })
});
a.store(ra);
const ua = await ra.json();
const rb = await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: eb, password: 'secret12', name: 'BobE2E' })
});
b.store(rb);
ok('register.A', ra.status === 201 && ua.user?.email === ea);
ok('register.B', rb.status === 201);
ok('register.points', typeof ua.user?.pointsBalance === 'number' && ua.user.pointsBalance > 0, String(ua.user?.pointsBalance));

const taskId = crypto.randomUUID();
const task = {
  id: taskId,
  title: 'E2E Alice Task',
  assignee: '我',
  due: '今天',
  status: 'todo',
  priority: '高',
  progress: 0,
  estimatedMinutes: 30,
  createdAt: new Date().toISOString()
};
const saveA = await fetch(`${base}/api/sqlite/tasks/${taskId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify(task)
});
ok('task.saveA', saveA.status === 200);
const listA = await (await fetch(`${base}/api/sqlite/tasks`, { headers: { Cookie: a.h() } })).json();
const listB = await (await fetch(`${base}/api/sqlite/tasks`, { headers: { Cookie: b.h() } })).json();
ok('isolate.Ahas', Array.isArray(listA) && listA.some(t => t.id === taskId));
ok('isolate.Bempty', Array.isArray(listB) && !listB.some(t => t.id === taskId));

const report = {
  headline: 'E2E',
  summary: 's',
  completed: ['c'],
  risks: [],
  tomorrow: [{ title: 't', reason: 'r', priority: '中', suggestedTime: '上午' }]
};
await fetch(`${base}/api/sqlite/reports/2099-01-02`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ report })
});
const getRA = await (await fetch(`${base}/api/sqlite/reports/2099-01-02`, { headers: { Cookie: a.h() } })).json();
const getRB = await (await fetch(`${base}/api/sqlite/reports/2099-01-02`, { headers: { Cookie: b.h() } })).json();
ok('report.isolate', getRA?.headline === 'E2E' && getRB == null);

const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: a.h() } })).json();
ok('auth.me', me.user?.email === ea && typeof me.user?.pointsBalance === 'number');
const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: a.h() } });
ok('auth.logout', logout.status === 204);
ok('auth.afterLogout', (await fetch(`${base}/api/sqlite/tasks`, { headers: { Cookie: a.h() } })).status === 401);
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ea, password: 'secret12' })
});
a.store(login);
ok('auth.login', login.status === 200);

const settings = await (await fetch(`${base}/api/settings/model`, { headers: { Cookie: a.h() } })).json();
ok('settings.builtinMode', settings.mode === 'builtin' && settings.requiresUserKey === false, JSON.stringify({ mode: settings.mode, requiresUserKey: settings.requiresUserKey }));
ok('settings.hasModels', Array.isArray(settings.models) && settings.models.length > 0 && settings.models.some(m => typeof m.weight === 'number'));
const pick = settings.models.find(m => m.id === 'deepseek-v4-flash') || settings.models[0];
const putModel = await fetch(`${base}/api/settings/model`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ modelId: pick.id })
});
const modelSaved = await putModel.json();
ok('settings.selectModel', putModel.status === 200 && modelSaved.selectedModelId === pick.id, modelSaved.message || modelSaved.selectedModelId);
const settingsB = await (await fetch(`${base}/api/settings/model`, { headers: { Cookie: b.h() } })).json();
ok('settings.BcanList', Array.isArray(settingsB.models) && settingsB.models.length > 0);

const jobsAnon = await fetch(`${base}/api/settings/jobs`);
ok('settings.jobsRequireAuth', jobsAnon.status === 401);

const avatarA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const putProfile = await fetch(`${base}/api/settings/profile`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ avatar: avatarA })
});
const profileA = await putProfile.json();
ok('profile.avatarSave', putProfile.status === 200 && profileA.avatar?.startsWith('data:image/'));
const profileB = await (await fetch(`${base}/api/settings/profile`, { headers: { Cookie: b.h() } })).json();
ok('profile.avatarIsolate', !profileB.avatar || profileB.avatar !== avatarA);

const putJobsA = await fetch(`${base}/api/settings/jobs`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ voiceRetention: { enabled: true, retentionDays: 3, times: ['04:00'] } })
});
const jobsA = await putJobsA.json();
const jobsB = await (await fetch(`${base}/api/settings/jobs`, { headers: { Cookie: b.h() } })).json();
ok('settings.jobsIsolate', putJobsA.status === 200 && jobsA.voiceRetention?.retentionDays === 3 && jobsB.voiceRetention?.retentionDays !== 3);

ok('admin.forbiddenForUser', (await fetch(`${base}/api/admin/dashboard`, { headers: { Cookie: a.h() } })).status === 403);

const vj = await fetch(`${base}/api/voice-jobs/text`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ transcript: '创建一个任务：E2E语音任务测试', tasks: [], reports: {} })
});
const vjBody = await vj.json();
ok('voice.textJob', vj.status === 202 && vjBody.id, `${vj.status} ${vjBody.id || vjBody.message || ''}`);
if (vjBody.id) {
  let job = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    job = await (await fetch(`${base}/api/voice-jobs/${vjBody.id}`, { headers: { Cookie: a.h() } })).json();
    if (job.status === 'completed' || job.status === 'failed') break;
  }
  ok('voice.jobTerminal', job && (job.status === 'completed' || job.status === 'failed'), `${job?.status}:${job?.error || ''}`);
  const hist = await (await fetch(`${base}/api/voice-jobs`, { headers: { Cookie: a.h() } })).json();
  ok('voice.history', Array.isArray(hist.items) && hist.items.some(x => x.id === vjBody.id));
  ok('voice.isolate', (await fetch(`${base}/api/voice-jobs/${vjBody.id}`, { headers: { Cookie: b.h() } })).status === 404);
}

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ passed: results.filter(r => r.ok).length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
