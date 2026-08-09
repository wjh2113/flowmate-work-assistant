/**
 * Broader API regression after per-user isolation / model / legacy claim changes.
 * Usage: E2E_BASE=http://127.0.0.1:8799 node scripts/regression-check.mjs
 */
const base = process.env.E2E_BASE || 'http://127.0.0.1:8790';
const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond), detail: String(detail || '') });
  if (!cond) console.error(`FAIL ${name}`, detail || '');
};

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

async function json(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { _raw: text }; }
}

const stamp = Date.now();
const a = jar();
const b = jar();
const ea = `reg_a_${stamp}@t.local`;
const eb = `reg_b_${stamp}@t.local`;

// --- health / unauth ---
const health = await json(await fetch(`${base}/api/health`));
ok('health.requiresUserModel', health.requiresUserModel === true && health.ai === false, JSON.stringify(health));
ok('jobs.unauth', (await fetch(`${base}/api/settings/jobs`)).status === 401);
ok('model.unauth', (await fetch(`${base}/api/settings/model`)).status === 401);
ok('profile.unauth', (await fetch(`${base}/api/settings/profile`)).status === 401);
ok('daily.unauth', (await fetch(`${base}/api/daily-plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401);

// --- register ---
const ra = await fetch(`${base}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ea, password: 'secret12', name: 'RegA' })
});
a.store(ra);
const ua = await json(ra);
ok('register.A', ra.status === 201 && ua.user?.id, ua.message || ua.user?.id);

const rb = await fetch(`${base}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: eb, password: 'secret12', name: 'RegB' })
});
b.store(rb);
const ub = await json(rb);
ok('register.B', rb.status === 201 && ub.user?.id, ub.message || ub.user?.id);

// --- model: no env fallback; isolation ---
const modelA0 = await json(await fetch(`${base}/api/settings/model`, { headers: { Cookie: a.h() } }));
ok('model.A.empty', modelA0.configured === false && modelA0.requiresUserKey === true, JSON.stringify({ configured: modelA0.configured, requiresUserKey: modelA0.requiresUserKey }));

const aiBlocked = await fetch(`${base}/api/daily-plan`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ tasks: [], date: '2099-06-01', user: 'A' })
});
const aiBlockedBody = await json(aiBlocked);
ok('ai.blockedWithoutKey', aiBlocked.status === 503 && aiBlockedBody.error === 'AI_NOT_CONFIGURED', `${aiBlocked.status} ${aiBlockedBody.error}`);

const putModelA = await fetch(`${base}/api/settings/model`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    textApiKey: 'sk-reg-test-key-aaaa1111',
    textModel: 'deepseek-v4-flash',
    asrModel: 'qwen3-asr-flash',
    asrApiKey: 'sk-reg-asr-key-bbbb2222'
  })
});
const modelA1 = await json(putModelA);
ok('model.A.save', putModelA.status === 200 && modelA1.textConfigured && modelA1.provider === 'deepseek', modelA1.message || modelA1.provider);

const modelB0 = await json(await fetch(`${base}/api/settings/model`, { headers: { Cookie: b.h() } }));
ok('model.B.stillEmpty', modelB0.configured === false, JSON.stringify({ configured: modelB0.configured, provider: modelB0.provider }));

const putModelEmpty = await fetch(`${base}/api/settings/model`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: b.h() },
  body: JSON.stringify({ provider: 'bailian', textModel: 'qwen3.7-plus', asrModel: 'qwen3-asr-flash' })
});
ok('model.B.requireKey', putModelEmpty.status === 400, (await json(putModelEmpty)).message);

// keep key on update without retyping
const putModelKeep = await fetch(`${base}/api/settings/model`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    textModel: 'deepseek-v4-pro',
    asrModel: 'qwen3-asr-flash'
  })
});
const modelA2 = await json(putModelKeep);
ok('model.A.keepKey', putModelKeep.status === 200 && modelA2.textConfigured && modelA2.textModel === 'deepseek-v4-pro' && modelA2.maskedTextKey, modelA2.message || modelA2.textModel);

// --- tasks / reports isolation ---
const taskId = crypto.randomUUID();
const putTask = await fetch(`${base}/api/sqlite/tasks/${taskId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({
    id: taskId, title: '回归隔离任务', assignee: '我', due: '今天', status: 'todo',
    priority: '高', progress: 0, estimatedMinutes: 45
  })
});
ok('task.A.save', putTask.status === 200, (await json(putTask)).title);

const listA = await json(await fetch(`${base}/api/sqlite/tasks`, { headers: { Cookie: a.h() } }));
const listB = await json(await fetch(`${base}/api/sqlite/tasks`, { headers: { Cookie: b.h() } }));
ok('task.isolate', Array.isArray(listA) && listA.some(t => t.id === taskId) && Array.isArray(listB) && !listB.some(t => t.id === taskId), `A=${listA?.length} B=${listB?.length}`);

const getTaskB = await fetch(`${base}/api/sqlite/tasks/${taskId}`, { headers: { Cookie: b.h() } });
ok('task.B.cannotRead', getTaskB.status === 404);

const report = { headline: '回归日报', summary: 's', completed: ['x'], risks: [], tomorrow: [] };
await fetch(`${base}/api/sqlite/reports/2099-06-02`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ report })
});
const repA = await json(await fetch(`${base}/api/sqlite/reports/2099-06-02`, { headers: { Cookie: a.h() } }));
const repB = await json(await fetch(`${base}/api/sqlite/reports/2099-06-02`, { headers: { Cookie: b.h() } }));
ok('report.isolate', repA?.headline === '回归日报' && repB == null, repB?.headline || '');

const period = { headline: '回归周报', summary: 'w', highlights: [], risks: [], next: [] };
await fetch(`${base}/api/sqlite/period-reports/weekly/2099-W01`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ report: period })
});
const perA = await json(await fetch(`${base}/api/sqlite/period-reports/weekly/2099-W01`, { headers: { Cookie: a.h() } }));
const perB = await json(await fetch(`${base}/api/sqlite/period-reports/weekly/2099-W01`, { headers: { Cookie: b.h() } }));
ok('period.isolate', perA?.headline === '回归周报' && perB == null);

// --- profile / avatar / jobs ---
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const putAvatar = await fetch(`${base}/api/settings/profile`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ avatar, autoSchedule: { daily: { enabled: true, times: ['11:00'] }, weekly: { enabled: false, weekday: 1, times: ['20:00'] }, monthly: { enabled: false, day: 'last', times: ['08:00'] }, voiceRetention: { enabled: true, retentionDays: 5, times: ['03:30'] } } })
});
const profA = await json(putAvatar);
ok('profile.A.save', putAvatar.status === 200 && profA.avatar?.startsWith('data:image/'), putAvatar.status);

const profB = await json(await fetch(`${base}/api/settings/profile`, { headers: { Cookie: b.h() } }));
ok('profile.B.noAvatar', !profB.avatar, Boolean(profB.avatar));

const putJobsA = await fetch(`${base}/api/settings/jobs`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ voiceRetention: { enabled: true, retentionDays: 2, times: ['05:00'] } })
});
const jobsA = await json(putJobsA);
const jobsB = await json(await fetch(`${base}/api/settings/jobs`, { headers: { Cookie: b.h() } }));
ok('jobs.isolate', putJobsA.status === 200 && jobsA.voiceRetention?.retentionDays === 2 && jobsB.voiceRetention?.retentionDays !== 2, `${jobsA.voiceRetention?.retentionDays}/${jobsB.voiceRetention?.retentionDays}`);

// --- voice jobs ownership ---
const vj = await fetch(`${base}/api/voice-jobs/text`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ transcript: '创建一个任务：回归语音', tasks: [], reports: {} })
});
const vjBody = await json(vj);
ok('voice.create', vj.status === 202 && vjBody.id, `${vj.status} ${vjBody.message || vjBody.id || ''}`);
if (vjBody.id) {
  ok('voice.B.404', (await fetch(`${base}/api/voice-jobs/${vjBody.id}`, { headers: { Cookie: b.h() } })).status === 404);
  let job = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    job = await json(await fetch(`${base}/api/voice-jobs/${vjBody.id}`, { headers: { Cookie: a.h() } }));
    if (job.status === 'completed' || job.status === 'failed') break;
  }
  ok('voice.terminal', job && (job.status === 'completed' || job.status === 'failed'), `${job?.status}:${job?.error || ''}`);
  // with fake key should fail AI, not hang forever
  ok('voice.usesUserKey', job?.status === 'failed' && /API key|密钥|配置|401|Incorrect/i.test(String(job?.error || '')), job?.error || '');
}

// --- report edit job ownership ---
const rej = await fetch(`${base}/api/report-edit-jobs`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.h() },
  body: JSON.stringify({ kind: 'daily', report, instruction: '把标题改成测试' })
});
const rejBody = await json(rej);
ok('reportEdit.create', rej.status === 202 && rejBody.id, `${rej.status} ${rejBody.message || rejBody.id || ''}`);
if (rejBody.id) {
  ok('reportEdit.B.404', (await fetch(`${base}/api/report-edit-jobs/${rejBody.id}`, { headers: { Cookie: b.h() } })).status === 404);
  let job = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    job = await json(await fetch(`${base}/api/report-edit-jobs/${rejBody.id}`, { headers: { Cookie: a.h() } }));
    if (job.status === 'completed' || job.status === 'failed') break;
  }
  ok('reportEdit.terminal', job && (job.status === 'completed' || job.status === 'failed'), `${job?.status}:${job?.error || ''}`);
}

// B without model cannot create voice job
const vjB = await fetch(`${base}/api/voice-jobs/text`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: b.h() },
  body: JSON.stringify({ transcript: 'B无', tasks: [], reports: {} })
});
const vjBBody = await json(vjB);
ok('voice.B.needsModel', vjB.status === 503 && vjBBody.error === 'AI_NOT_CONFIGURED', `${vjB.status} ${vjBBody.error}`);

// --- session logout ---
ok('logout.A', (await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: a.h() } })).status === 204);
ok('afterLogout.401', (await fetch(`${base}/api/sqlite/tasks`, { headers: { Cookie: a.h() } })).status === 401);

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ea, password: 'secret12' })
});
a.store(login);
ok('login.A', login.status === 200);
const modelAfterLogin = await json(await fetch(`${base}/api/settings/model`, { headers: { Cookie: a.h() } }));
ok('model.persists', modelAfterLogin.textConfigured === true && modelAfterLogin.textModel === 'deepseek-v4-pro', modelAfterLogin.textModel);
const profAfterLogin = await json(await fetch(`${base}/api/settings/profile`, { headers: { Cookie: a.h() } }));
ok('avatar.persists', profAfterLogin.avatar?.startsWith('data:image/'));

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ base, passed: results.filter(r => r.ok).length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
