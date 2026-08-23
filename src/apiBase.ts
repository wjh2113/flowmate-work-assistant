import { Capacitor } from '@capacitor/core';

/** Production API origin baked into the Android/iOS user app. */
export const NATIVE_DEFAULT_API_BASE = 'https://usertool.aidigitcloud.cn';

function normalizeBase(value: string) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/** True when running inside the Capacitor Android/iOS shell. */
export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

/** API origin for native app; empty string on web (same-origin /api). */
export function getApiBase() {
  const fromEnv = normalizeBase(import.meta.env.VITE_API_BASE_URL || '');
  if (isNativeApp()) return fromEnv || NATIVE_DEFAULT_API_BASE;
  return fromEnv;
}

export function apiUrl(path: string) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const base = getApiBase();
  return base ? `${base}${p}` : p;
}
