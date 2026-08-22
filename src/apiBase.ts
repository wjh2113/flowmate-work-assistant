import { Capacitor } from '@capacitor/core';

const STORAGE_KEY = 'flowmate.apiBase';

function normalizeBase(value: string) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/** True when running inside the Capacitor Android/iOS shell. */
export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

export function getStoredApiBase() {
  try {
    return normalizeBase(localStorage.getItem(STORAGE_KEY) || '');
  } catch {
    return '';
  }
}

export function setStoredApiBase(value: string) {
  const next = normalizeBase(value);
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
  return next;
}

/** API origin for native app; empty string on web (same-origin /api). */
export function getApiBase() {
  const stored = getStoredApiBase();
  if (stored) return stored;
  const fromEnv = normalizeBase(import.meta.env.VITE_API_BASE_URL || '');
  if (fromEnv) return fromEnv;
  return '';
}

export function apiUrl(path: string) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const base = getApiBase();
  return base ? `${base}${p}` : p;
}
