/** Browser keys scoped by logged-in user so accounts on the same device don't collide. */
let storageScope = 'anon';

export function setUserStorageScope(scope?: string | null) {
  storageScope = String(scope || '').trim() || 'anon';
}

export function getUserStorageScope() {
  return storageScope;
}

export function userStorageKey(key: string) {
  return `flowmate.u:${storageScope}:${key}`;
}

export function readUserStorage(key: string) {
  try {
    return localStorage.getItem(userStorageKey(key));
  } catch {
    return null;
  }
}

export function writeUserStorage(key: string, value: string) {
  localStorage.setItem(userStorageKey(key), value);
}

export function removeUserStorage(key: string) {
  try {
    localStorage.removeItem(userStorageKey(key));
  } catch {}
}

/** One-time migrate unscoped legacy key into the current user scope. */
export function migrateLegacyStorageKey(legacyKey: string, scopedSuffix: string) {
  try {
    const scoped = userStorageKey(scopedSuffix);
    if (localStorage.getItem(scoped)) return localStorage.getItem(scoped);
    const legacy = localStorage.getItem(legacyKey);
    if (legacy == null) return null;
    localStorage.setItem(scoped, legacy);
    return legacy;
  } catch {
    return null;
  }
}
