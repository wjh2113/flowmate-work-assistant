type CachedUser = { id: string; email: string; name: string; createdAt?: string; role?: 'user' | 'admin'; pointsBalance?: number; selectedModelId?: string };
type CachedTask = { id: string; title: string; assignee: string; due: string; status: 'todo' | 'doing' | 'done'; priority: '高' | '中' | '低'; progress: number; estimatedMinutes: number; createdAt?: string; startedAt?: string; completedAt?: string; aiStatus?: 'pending' | 'failed' };

const USER_KEY = 'flowmate.offline.user';
const listeners = new Set<() => void>();

export type OfflineQueueItem =
  | { op: 'saveTask'; task: CachedTask }
  | { op: 'patchTask'; id: string; changes: Record<string, unknown> }
  | { op: 'deleteTask'; id: string }
  | { op: 'saveDaily'; date: string; report: unknown }
  | { op: 'saveWeekly'; key: string; report: unknown }
  | { op: 'saveMonthly'; key: string; report: unknown };

export type OfflineSnapshot = {
  tasks: CachedTask[];
  daily: Record<string, unknown>;
  weekly: Record<string, unknown>;
  monthly: Record<string, unknown>;
  updatedAt: string;
};

let offlineUserId = '';

function emit() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

export function subscribeOffline(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setOfflineUserId(id?: string | null) {
  offlineUserId = String(id || '').trim();
}

export function getOfflineUserId() {
  return offlineUserId;
}

export function isOfflineNow() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function isConnectivityError(error: unknown) {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error || '');
  return /failed to fetch|load failed|networkerror|network request failed|internet connection appears to be offline|连接服务器超时|无法连接服务器/i.test(message);
}

function snapshotKey() {
  return `flowmate.offline.snapshot:${offlineUserId || 'anon'}`;
}

function queueKey() {
  return `flowmate.offline.queue:${offlineUserId || 'anon'}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

function emptySnapshot(): OfflineSnapshot {
  return { tasks: [], daily: {}, weekly: {}, monthly: {}, updatedAt: new Date().toISOString() };
}

export function readCachedUser(): CachedUser | null {
  const user = readJson<CachedUser | null>(USER_KEY, null);
  return user?.id ? user : null;
}

export function writeCachedUser(user: CachedUser | null) {
  try {
    if (user?.id) {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      setOfflineUserId(user.id);
    } else {
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    /* ignore */
  }
  emit();
}

export function readSnapshot(): OfflineSnapshot | null {
  if (!offlineUserId) {
    const user = readCachedUser();
    if (user?.id) setOfflineUserId(user.id);
  }
  const snap = readJson<OfflineSnapshot | null>(snapshotKey(), null);
  if (!snap || !Array.isArray(snap.tasks)) return null;
  return {
    tasks: snap.tasks,
    daily: snap.daily && typeof snap.daily === 'object' ? snap.daily : {},
    weekly: snap.weekly && typeof snap.weekly === 'object' ? snap.weekly : {},
    monthly: snap.monthly && typeof snap.monthly === 'object' ? snap.monthly : {},
    updatedAt: snap.updatedAt || ''
  };
}

export function writeSnapshot(snapshot: OfflineSnapshot) {
  writeJson(snapshotKey(), { ...snapshot, updatedAt: new Date().toISOString() });
  emit();
}

export function replaceCachedTasks(tasks: CachedTask[]) {
  const snap = readSnapshot() || emptySnapshot();
  writeSnapshot({ ...snap, tasks });
}

export function upsertCachedTask(task: CachedTask) {
  const snap = readSnapshot() || emptySnapshot();
  writeSnapshot({ ...snap, tasks: [task, ...snap.tasks.filter((item) => item.id !== task.id)] });
}

export function patchCachedTask(id: string, changes: Record<string, unknown>) {
  const snap = readSnapshot() || emptySnapshot();
  writeSnapshot({
    ...snap,
    tasks: snap.tasks.map((item) => (item.id === id ? ({ ...item, ...changes } as CachedTask) : item))
  });
  return (readSnapshot()?.tasks || []).find((item) => item.id === id) || null;
}

export function removeCachedTask(id: string) {
  const snap = readSnapshot() || emptySnapshot();
  writeSnapshot({ ...snap, tasks: snap.tasks.filter((item) => item.id !== id) });
}

export function cacheDailyReport(date: string, report: unknown) {
  const snap = readSnapshot() || emptySnapshot();
  writeSnapshot({ ...snap, daily: { ...snap.daily, [date]: report } });
}

export function cachePeriodReport(kind: 'weekly' | 'monthly', key: string, report: unknown) {
  const snap = readSnapshot() || emptySnapshot();
  writeSnapshot({ ...snap, [kind]: { ...snap[kind], [key]: report } });
}

export function readCachedDaily(date: string) {
  const report = readSnapshot()?.daily?.[date];
  return report === undefined ? undefined : report;
}

export function readCachedPeriod(kind: 'weekly' | 'monthly', key: string) {
  const report = readSnapshot()?.[kind]?.[key];
  return report === undefined ? undefined : report;
}

export function readQueue(): OfflineQueueItem[] {
  const items = readJson<OfflineQueueItem[]>(queueKey(), []);
  return Array.isArray(items) ? items : [];
}

function writeQueue(items: OfflineQueueItem[]) {
  writeJson(queueKey(), items);
  emit();
}

export function pendingOfflineCount() {
  return readQueue().length;
}

export function enqueueOffline(item: OfflineQueueItem) {
  let items = readQueue();
  if (item.op === 'saveTask') {
    items = items.filter((row) => !(row.op === 'saveTask' && row.task.id === item.task.id) && !(row.op === 'patchTask' && row.id === item.task.id) && !(row.op === 'deleteTask' && row.id === item.task.id));
    items.push(item);
  } else if (item.op === 'patchTask') {
    const lastSave = [...items].reverse().find((row) => row.op === 'saveTask' && row.task.id === item.id);
    if (lastSave && lastSave.op === 'saveTask') {
      lastSave.task = { ...lastSave.task, ...item.changes } as CachedTask;
    } else {
      items = items.filter((row) => !(row.op === 'patchTask' && row.id === item.id));
      items.push(item);
    }
  } else if (item.op === 'deleteTask') {
    const hadLocalSave = items.some((row) => row.op === 'saveTask' && row.task.id === item.id);
    items = items.filter((row) => !(row.op === 'saveTask' && row.task.id === item.id) && !(row.op === 'patchTask' && row.id === item.id) && !(row.op === 'deleteTask' && row.id === item.id));
    if (!hadLocalSave) items.push(item);
  } else {
    items.push(item);
  }
  writeQueue(items);
}

export function replaceQueue(items: OfflineQueueItem[]) {
  writeQueue(items);
}

export function clearOfflineData() {
  try {
    localStorage.removeItem(USER_KEY);
    if (offlineUserId) {
      localStorage.removeItem(snapshotKey());
      localStorage.removeItem(queueKey());
    }
  } catch {
    /* ignore */
  }
  offlineUserId = '';
  emit();
}

export function getOfflineStatus() {
  return {
    offline: isOfflineNow(),
    pending: pendingOfflineCount()
  };
}
