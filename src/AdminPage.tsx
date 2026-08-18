import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from './localAuth';

type AdminModel = {
  id: string;
  name: string;
  provider: string;
  baseURL: string;
  textModel: string;
  asrModel: string;
  weight: number;
  badge: string;
  sortOrder: number;
  enabled: boolean;
  kind: string;
  textApiKey?: string;
  asrApiKey?: string;
  hasTextKey?: boolean;
  hasAsrKey?: boolean;
  lastTestOk?: boolean;
  keyVerifiedAt?: string;
};

type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  pointsBalance: number;
  createdAt?: string;
  selectedModelId?: string;
};

type UsageItem = {
  id: string;
  userId: string;
  modelName: string;
  action: string;
  totalTokens: number;
  points: number;
  weight: number;
  createdAt: string;
};

type Dashboard = {
  userCount: number;
  enabledModelCount: number;
  usageCount: number;
  totalTokens: number;
  totalPoints: number;
};

function formatWeightEstimate(weight: number) {
  const yuan = Math.round((Number(weight) || 0) * 3 * 1000) / 1000;
  return `预估：百万 token ≈ ¥${yuan}（按 DeepSeek Flash 闲时单价折算）`;
}

export default function AdminPage({ initialTab = 'models' }: { initialTab?: 'overview' | 'models' | 'users' | 'usage' } = {}) {
  const [tab, setTab] = useState<'overview' | 'models' | 'users' | 'usage'>(initialTab);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usage, setUsage] = useState<UsageItem[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<AdminModel | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState('');
  const [testError, setTestError] = useState('');
  const [priceHint, setPriceHint] = useState<string | null>(null);
  const [priceRefreshing, setPriceRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const load = async () => {
    setError('');
    const [d, m, u, g] = await Promise.all([
      apiFetch('/api/admin/dashboard').then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json() })),
      apiFetch('/api/admin/models').then(async (r) => ({ ok: r.ok, data: await r.json() })),
      apiFetch('/api/admin/users').then(async (r) => ({ ok: r.ok, data: await r.json() })),
      apiFetch('/api/admin/usage?limit=40').then(async (r) => ({ ok: r.ok, data: await r.json() }))
    ]);
    if (!d.ok) {
      setAuthed(false);
      throw new Error(d.status === 401 ? '请先登录管理后台' : (d.data.message || '无管理员权限'));
    }
    setAuthed(true);
    setDashboard(d.data);
    setModels(m.data.models || []);
    setUsers(u.data.users || []);
    setUsage(g.data.items || []);
  };

  useEffect(() => {
    document.title = '管理后台 · FlowMate';
    apiFetch('/api/admin/auth/me').then(async (r) => {
      if (!r.ok) { setAuthed(false); setLoading(false); return; }
      try {
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
      }
    }).catch(() => { setAuthed(false); setLoading(false); });
    return () => { document.title = 'FlowMate'; };
  }, []);

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setLoggingIn(true); setError('');
    try {
      const response = await apiFetch('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '登录失败');
      setLoading(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoggingIn(false);
      setLoading(false);
    }
  };

  const logout = async () => {
    await apiFetch('/api/admin/auth/logout', { method: 'POST' });
    setAuthed(false);
    setDashboard(null);
    setModels([]);
    setUsers([]);
    setUsage([]);
    setPassword('');
  };

  const openEditor = (model: AdminModel) => {
    setTestError('');
    setTestMessage('');
    setPriceHint(null);
    setEditing(model);
  };

  const refreshPriceEstimate = async () => {
    if (!editing) return;
    setPriceRefreshing(true);
    try {
      const qs = new URLSearchParams({
        provider: editing.provider || '',
        textModel: editing.textModel || '',
        id: editing.id || '',
        weight: String(editing.weight ?? 0)
      });
      const response = await apiFetch(`/api/admin/model-prices?${qs}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPriceHint(`未能拉取官方价，已用权重估算。${formatWeightEstimate(editing.weight)}`);
        return;
      }
      setPriceHint(String(data.message || formatWeightEstimate(editing.weight)));
    } catch {
      setPriceHint(`未能拉取官方价，已用权重估算。${formatWeightEstimate(editing.weight)}`);
    } finally {
      setPriceRefreshing(false);
    }
  };

  const testModel = async () => {
    if (!editing) return;
    setTesting(true); setTestError(''); setTestMessage(''); setError(''); setMessage('');
    try {
      const response = await apiFetch('/api/admin/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editing.id,
          name: editing.name,
          provider: editing.provider,
          baseURL: editing.baseURL,
          textModel: editing.textModel,
          textApiKey: editing.textApiKey || ''
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '测试失败');
      setTestMessage(data.message || '连接成功');
      setEditing((cur) => cur ? { ...cur, lastTestOk: Boolean(data.lastTestOk ?? data.ok) } : cur);
      await load();
    } catch (e) {
      setTestError(e instanceof Error ? e.message : '测试失败');
    } finally {
      setTesting(false);
    }
  };

  const saveModel = async () => {
    if (!editing) return;
    setSaving(true); setError(''); setMessage(''); setTestError(''); setTestMessage('');
    try {
      const isNew = !models.some((m) => m.id === editing.id);
      const response = await apiFetch(isNew ? '/api/admin/models' : `/api/admin/models/${encodeURIComponent(editing.id)}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '保存失败');
      setMessage(data.message || '已保存');
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const removeModel = async (id: string) => {
    if (!window.confirm(`删除模型 ${id}？`)) return;
    const response = await apiFetch(`/api/admin/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.message || '删除失败');
      return;
    }
    await load();
  };

  const patchUser = async (user: AdminUser, patch: Partial<AdminUser>) => {
    setError(''); setMessage('');
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.message || '更新用户失败');
      return;
    }
    setMessage(data.message || '用户已更新');
    await load();
  };

  return (
    <div className="admin-viewport">
      <main className="admin-shell">
        <nav className="admin-nav">
          <span className="admin-brand"><i>▣</i><span>FlowMate 管理后台</span></span>
          {authed
            ? <button type="button" className="admin-back" onClick={() => void logout()}>退出管理后台</button>
            : <span className="admin-nav-hint">独立登录，与工作台账号隔离</span>}
        </nav>
        {loading && <div className="settings-loading">正在加载管理后台…</div>}
        {!loading && !authed && (
          <section className="admin-login-card">
            <small>ADMIN CONSOLE</small>
            <h1>管理员登录</h1>
            <p>请使用管理员账号登录。工作台登录不会进入此后台。</p>
            <form onSubmit={(e) => void login(e)}>
              <label>账号</label>
              <input className="input" type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="管理员账号" autoComplete="username" required />
              <label>密码</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="管理员密码" autoComplete="current-password" required minLength={6} />
              <button className="primary" disabled={loggingIn}>{loggingIn ? '正在登录…' : '登录管理后台'}</button>
              {error && <div className="login-error">{error}</div>}
            </form>
          </section>
        )}
        {!loading && authed && (
          <div className="admin-page">
            <div className="settings-head">
              <div><small>ADMIN</small><h2>管理后台</h2></div>
            </div>
            <div className="admin-tabs" role="tablist">
              {([
                ['overview', '总览'],
                ['models', '模型权重'],
                ['users', '用户权限'],
                ['usage', '用量']
              ] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
              ))}
            </div>
            {error && <div className="settings-error">{error}</div>}
            {message && <div className="settings-success">✓ {message}</div>}
            {tab === 'overview' && dashboard && (
              <div className="admin-stats">
                <div><b>{dashboard.userCount}</b><span>用户</span></div>
                <div><b>{dashboard.enabledModelCount}</b><span>启用模型</span></div>
                <div><b>{dashboard.usageCount}</b><span>调用次数</span></div>
                <div><b>{Math.round(dashboard.totalTokens)}</b><span>总 Token</span></div>
                <div><b>{Math.round(dashboard.totalPoints)}</b><span>总积分消耗</span></div>
              </div>
            )}
            {tab === 'models' && (
              <div className="admin-section">
                <button type="button" className="admin-add" onClick={() => {
                  openEditor({
                    id: `model-${Date.now()}`, name: '新模型', provider: 'bailian', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    textModel: 'qwen3.7-plus', asrModel: 'qwen3-asr-flash', weight: 1, badge: '', sortOrder: 100, enabled: true, kind: 'text', textApiKey: '', asrApiKey: ''
                  });
                }}>＋ 新增模型</button>
                <div className="model-picker-list admin-model-list">
                  {models.map((m) => (
                    <div className="model-picker-item" key={m.id}>
                      <div>
                        <b>{m.name}</b>
                        <span>{m.textModel} · {m.provider}{m.badge ? ` · ${m.badge}` : ''}{m.enabled ? '' : ' · 已停用'}{m.lastTestOk ? ' · 已验证' : ' · 未验证'}</span>
                      </div>
                      <em>{Number(m.weight).toFixed(3)}x</em>
                      <button type="button" onClick={() => openEditor({ ...m, textApiKey: '', asrApiKey: '' })}>编辑</button>
                      <button type="button" className="danger" onClick={() => void removeModel(m.id)}>删</button>
                    </div>
                  ))}
                </div>
                {editing && (
                  <div className="admin-editor">
                    <h3>编辑模型</h3>
                    <label>ID</label>
                    <input className="input" value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} />
                    <label>显示名称</label>
                    <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                    <label>权重（积分 = Token × 权重）</label>
                    <input className="input" type="number" step="0.001" min="0" value={editing.weight} onChange={(e) => {
                      setPriceHint(null);
                      setEditing({ ...editing, weight: Number(e.target.value) });
                    }} />
                    <div className="admin-price-estimate">
                      <p className="field-help">{priceHint || formatWeightEstimate(editing.weight)}</p>
                      <button type="button" className="admin-price-refresh" disabled={priceRefreshing || saving || testing} onClick={() => void refreshPriceEstimate()}>
                        {priceRefreshing ? '刷新中…' : '刷新'}
                      </button>
                    </div>
                    <label>角标（可选，如「限时免费」）</label>
                    <input className="input" value={editing.badge} onChange={(e) => setEditing({ ...editing, badge: e.target.value })} />
                    <label>提供商</label>
                    <select className="input model-select" value={editing.provider} onChange={(e) => {
                      const provider = e.target.value;
                      const bases: Record<string, string> = {
                        bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                        deepseek: 'https://api.deepseek.com',
                        moonshot: 'https://api.moonshot.cn/v1'
                      };
                      setEditing({ ...editing, provider, baseURL: provider === 'custom' ? editing.baseURL : (bases[provider] || editing.baseURL) });
                    }}>
                      <option value="bailian">阿里云百炼</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="moonshot">Moonshot Kimi</option>
                      <option value="custom">自定义</option>
                    </select>
                    <label>Base URL</label>
                    <input className="input" value={editing.baseURL} onChange={(e) => setEditing({ ...editing, baseURL: e.target.value })} />
                    <label>模型 ID</label>
                    <input className="input" value={editing.textModel} onChange={(e) => setEditing({ ...editing, textModel: e.target.value })} />
                    <label>API Key（留空则不修改已有密钥）</label>
                    <input className="input" type="password" value={editing.textApiKey || ''} onChange={(e) => setEditing({ ...editing, textApiKey: e.target.value })} placeholder={editing.hasTextKey ? '已配置，留空不改' : 'sk-...'} />
                    <label>ASR Key（可选）</label>
                    <input className="input" type="password" value={editing.asrApiKey || ''} onChange={(e) => setEditing({ ...editing, asrApiKey: e.target.value })} placeholder={editing.hasAsrKey ? '已配置，留空不改' : '可选'} />
                    <label className="admin-check"><input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> 启用</label>
                    <p className="field-help">{editing.lastTestOk ? '已通过可用性测试，用户可选。' : '尚未通过可用性测试，用户端不可选。'}</p>
                    {testMessage && <div className="settings-success">✓ {testMessage}</div>}
                    {testError && <div className="settings-error">{testError}</div>}
                    <div className="settings-actions admin-editor-actions">
                      <button type="button" onClick={() => { setEditing(null); setTestError(''); setTestMessage(''); setPriceHint(null); }}>取消</button>
                      <button type="button" className="admin-test" disabled={saving || testing} onClick={() => void testModel()}>{testing ? '测试中…' : '测试可用性'}</button>
                      <button type="button" disabled={saving || testing} onClick={() => void saveModel()}>{saving ? '保存中…' : '保存'}</button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {tab === 'users' && (
              <div className="admin-users">
                {users.map((u) => (
                  <div className="admin-user-card" key={u.id}>
                    <div><b>{u.name || u.email}</b><span>{u.email}</span></div>
                    <div className="admin-user-role">{u.role === 'admin' ? '超级管理员' : '普通用户'}</div>
                    <label>
                      积分
                      <input className="input" type="number" defaultValue={u.pointsBalance} onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isFinite(value) && value !== u.pointsBalance) void patchUser(u, { pointsBalance: value });
                      }} />
                    </label>
                  </div>
                ))}
              </div>
            )}
            {tab === 'usage' && (
              <div className="admin-usage">
                {usage.map((item) => (
                  <div className="admin-usage-row" key={item.id}>
                    <b>{item.modelName || item.action}</b>
                    <span>{item.action} · {item.totalTokens} tokens · {item.points} 积分 · {item.weight}x</span>
                    <em>{item.createdAt?.slice(0, 19)?.replace('T', ' ')}</em>
                  </div>
                ))}
                {!usage.length && <div className="empty">暂无用量记录</div>}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
