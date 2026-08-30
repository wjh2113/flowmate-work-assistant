import { apiUrl, isNativeApp } from './apiBase';

export type LocalUser = {
  id: string;
  email: string;
  name: string;
  createdAt?: string;
  role?: 'user' | 'admin';
  pointsBalance?: number;
  selectedModelId?: string;
};

const API_TIMEOUT_MS = 20_000;
const NATIVE_SESSION_KEY = 'flowmate.nativeSession';

function readNativeSession() {
  if (!isNativeApp()) return '';
  try {
    return localStorage.getItem(NATIVE_SESSION_KEY) || '';
  } catch {
    return '';
  }
}

function writeNativeSession(sessionId?: string) {
  if (!isNativeApp()) return;
  const value = String(sessionId || '').trim();
  try {
    if (value) localStorage.setItem(NATIVE_SESSION_KEY, value);
    else localStorage.removeItem(NATIVE_SESSION_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === 'string' ? apiUrl(input) : input;
  const headers = new Headers(init?.headers);
  if (isNativeApp()) {
    headers.set('X-Flowmate-Client', 'capacitor');
    const sessionId = readNativeSession();
    if (sessionId) headers.set('X-Flowmate-Session', sessionId);
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const signal = init?.signal
    ? (() => {
        const outer = init.signal!;
        if (outer.aborted) controller.abort(outer.reason);
        else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
        return controller.signal;
      })()
    : controller.signal;
  return fetch(url, { ...init, credentials: 'include', headers, signal }).finally(() => window.clearTimeout(timer));
}

/** Browser TypeError "Failed to fetch" when the API is unreachable. */
export function describeApiError(error: unknown, fallback = '请求失败，请重试'): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (error instanceof DOMException && error.name === 'AbortError') {
    return '连接服务器超时，请检查网络后重试';
  }
  if (/failed to fetch|load failed|networkerror|network request failed|internet connection appears to be offline/i.test(message)) {
    return '无法连接服务器，请检查网络后重试';
  }
  return message.trim() || fallback;
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
  const data = await readAuthJson<{ user?: LocalUser; message?: string; sessionId?: string }>(response);
  if (!response.ok || !data.user) throw new Error(data.message || '注册失败');
  writeNativeSession(data.sessionId);
  return data.user;
}

export async function loginLocalUser(input: { email: string; password: string }): Promise<LocalUser> {
  const response = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: input.email.trim(), password: input.password })
  });
  const data = await readAuthJson<{ user?: LocalUser; message?: string; sessionId?: string }>(response);
  if (!response.ok || !data.user) throw new Error(data.message || '登录失败');
  writeNativeSession(data.sessionId);
  return data.user;
}

export async function logoutLocalUser(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    writeNativeSession('');
  }
}

export async function getLocalUser(): Promise<LocalUser | null> {
  const response = await apiFetch('/api/auth/me', { cache: 'no-store' });
  if (response.status === 401) {
    writeNativeSession('');
    return null;
  }
  const data = await readAuthJson<{ user?: LocalUser | null; mode?: string; message?: string }>(response);
  if (!response.ok) return null;
  return data.user || null;
}
