/**
 * Admin + billing smoke: bootstrap super admin only, manage models/users, verify forbid for normal user.
 */
import { listUsersAdmin, initBilling, calcPoints, markBuiltinModelTest } from '../server/billing.mjs';
import { createSession, initStore } from '../server/store.mjs';
import { getAdminBootstrap } from '../server/admin-bootstrap.mjs';

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

ok('calc.points', calcPoints(1000, 0.05) === 50, String(calcPoints(1000, 0.05)));

const stamp = Date.now();
const userJar = jar();
const userEmail = `user_${stamp}@t.local`;

const regUser = await fetch(`${base}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: userEmail, password: 'secret12', name: 'TempUser' })
});
userJar.store(regUser);
const userBody = await json(regUser);
ok('user.register', regUser.status === 201 && userBody.user?.id, userBody.message);

await initStore();
await initBilling();
const bootstrap = getAdminBootstrap();
const bootSession = await createSession(bootstrap.id);
const adminCookie = `flowmate_admin_session=${bootSession.id}`;

const forbiddenLogin = await fetch(`${base}/api/admin/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: userEmail, password: 'secret12' })
});
ok('admin.userLoginForbidden', forbiddenLogin.status === 403, (await json(forbiddenLogin)).message);

const dashForbidden = await fetch(`${base}/api/admin/dashboard`, { headers: { Cookie: userJar.h() } });
ok('admin.userForbidden', dashForbidden.status === 401);

const dash = await json(await fetch(`${base}/api/admin/dashboard`, { headers: { Cookie: adminCookie } }));
ok('admin.dashboard', typeof dash.userCount === 'number' && dash.userCount >= 1, JSON.stringify(dash));

const models = await json(await fetch(`${base}/api/admin/models`, { headers: { Cookie: adminCookie } }));
ok('admin.models', Array.isArray(models.models) && models.models.length > 0, String(models.models?.length));

const modelId = `e2e-weight-${stamp}`;
const create = await fetch(`${base}/api/admin/models`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
  body: JSON.stringify({
    id: modelId,
    name: 'E2E Weight Model',
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    textModel: 'deepseek-v4-flash',
    weight: 0.42,
    badge: '测试',
    enabled: true,
    textApiKey: 'sk-e2e-admin-not-real-0001'
  })
});
const created = await json(create);
ok('admin.createModel', create.status === 201 && created.model?.weight === 0.42, created.message || created.model?.weight);

const putWeight = await fetch(`${base}/api/admin/models/${encodeURIComponent(modelId)}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
  body: JSON.stringify({ weight: 0.77, badge: '夜间折扣' })
});
const updated = await json(putWeight);
ok('admin.updateWeight', putWeight.status === 200 && updated.model?.weight === 0.77 && updated.model?.badge === '夜间折扣', updated.model?.weight);

const users = await json(await fetch(`${base}/api/admin/users`, { headers: { Cookie: adminCookie } }));
ok('admin.users', Array.isArray(users.users) && users.users.some(u => u.email === userEmail), String(users.users?.length));
ok('admin.singleAdmin', (users.users || []).filter(u => u.role === 'admin').length === 1
  && (users.users || []).some(u => (u.id === bootstrap.id || u.email === bootstrap.email) && u.role === 'admin'));

const patchRole = await fetch(`${base}/api/admin/users/${encodeURIComponent(userBody.user.id)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
  body: JSON.stringify({ role: 'admin' })
});
ok('admin.patchRoleRejected', patchRole.status === 400, (await json(patchRole)).message);

const patchUser = await fetch(`${base}/api/admin/users/${encodeURIComponent(userBody.user.id)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
  body: JSON.stringify({ pointsBalance: 12345 })
});
const patched = await json(patchUser);
ok('admin.patchPoints', patchUser.status === 200 && patched.user?.pointsBalance === 12345 && patched.user?.role !== 'admin', patched.user?.pointsBalance);

const catalog = await json(await fetch(`${base}/api/settings/model`, { headers: { Cookie: userJar.h() } }));
ok('user.hidesUnverified', Array.isArray(catalog.models) && !catalog.models.some(m => m.id === modelId), JSON.stringify(catalog.models?.find(m => m.id === modelId)));

const selectBlocked = await fetch(`${base}/api/settings/model`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: userJar.h() },
  body: JSON.stringify({ modelId })
});
ok('user.selectUnverifiedRejected', selectBlocked.status === 400, (await json(selectBlocked)).message);

await markBuiltinModelTest(modelId, true);
const catalogOk = await json(await fetch(`${base}/api/settings/model`, { headers: { Cookie: userJar.h() } }));
ok('user.seesVerifiedModel', Array.isArray(catalogOk.models) && catalogOk.models.some(m => m.id === modelId && m.weight === 0.77), JSON.stringify(catalogOk.models?.find(m => m.id === modelId)));

const select = await fetch(`${base}/api/settings/model`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: userJar.h() },
  body: JSON.stringify({ modelId })
});
const selected = await json(select);
ok('user.selectWeighted', select.status === 200 && selected.selectedModelId === modelId, selected.selectedModelId || selected.message);

const usage = await json(await fetch(`${base}/api/admin/usage?limit=10`, { headers: { Cookie: adminCookie } }));
ok('admin.usage', Array.isArray(usage.items), String(usage.items?.length));

const del = await fetch(`${base}/api/admin/models/${encodeURIComponent(modelId)}`, {
  method: 'DELETE',
  headers: { Cookie: adminCookie }
});
ok('admin.deleteModel', del.status === 204);

const after = await listUsersAdmin();
ok('admin.stillOnlyBootstrap', after.filter(u => u.role === 'admin').length === 1
  && after.some(u => (u.id === bootstrap.id || u.email === bootstrap.email) && u.role === 'admin'));

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ base, passed: results.filter(r => r.ok).length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
