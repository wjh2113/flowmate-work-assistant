export type LocalUser = {
  id: string;
  email: string;
  name: string;
  createdAt?: string;
  role?: 'user' | 'admin';
  pointsBalance?: number;
  selectedModelId?: string;
};

export function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, credentials: 'include' });
}

async function readAuthJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(response.ok ? '服务响应异常，请稍后重试' : `请求失败（${response.status}）`);
  }
}

export async function registerLocalUser(input: { email: string; password: string; name?: string }): Promise<LocalUser> {
  const response = await apiFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: input.email.trim(),
      password: input.password,
      name: input.name?.trim() || undefined
    })
  });
  const data = await readAuthJson<{ user?: LocalUser; message?: string }>(response);
  if (!response.ok || !data.user) throw new Error(data.message || '注册失败');
  return data.user;
}

export async function loginLocalUser(input: { email: string; password: string }): Promise<LocalUser> {
  const response = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: input.email.trim(), password: input.password })
  });
  const data = await readAuthJson<{ user?: LocalUser; message?: string }>(response);
  if (!response.ok || !data.user) throw new Error(data.message || '登录失败');
  return data.user;
}

export async function logoutLocalUser(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' });
}

export async function getLocalUser(): Promise<LocalUser | null> {
  const response = await apiFetch('/api/auth/me', { cache: 'no-store' });
  if (response.status === 401) return null;
  const data = await readAuthJson<{ user?: LocalUser | null; mode?: string; message?: string }>(response);
  if (!response.ok) return null;
  return data.user || null;
}
