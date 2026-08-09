import { migrateLegacyStorageKey, readUserStorage, writeUserStorage, userStorageKey } from './userStorage';

export type TimeHM = `${string}:${string}`;

export type DailySchedule = { enabled:boolean; times:TimeHM[] };
export type WeeklySchedule = { enabled:boolean; weekday:number; times:TimeHM[] }; // 0=周日 … 6=周六
export type MonthlySchedule = { enabled:boolean; day:'last'|number; times:TimeHM[] };
export type VoiceRetentionSchedule = { enabled:boolean; retentionDays:number; times:TimeHM[] };
export type AutoSchedule = { daily:DailySchedule; weekly:WeeklySchedule; monthly:MonthlySchedule; voiceRetention:VoiceRetentionSchedule };

export const DEFAULT_AUTO_SCHEDULE: AutoSchedule = {
  daily: { enabled: true, times: ['12:00', '18:00', '22:00'] },
  weekly: { enabled: false, weekday: 0, times: ['20:00'] },
  monthly: { enabled: true, day: 'last', times: ['08:00', '22:00'] },
  voiceRetention: { enabled: true, retentionDays: 7, times: ['03:00'] }
};

const SCHEDULE_SUFFIX = 'autoSchedule';
const LEGACY_SCHEDULE_KEY = 'flowmate.autoSchedule';

export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function monthKey(date = new Date()) {
  return localDateKey(date).slice(0, 7);
}

export function weekRange(date = new Date()) {
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() + mondayOffset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { weekStart: localDateKey(start), weekEnd: localDateKey(end) };
}

export function isoWeekKey(date = new Date()) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function parseTimeHM(value: string): { hour:number; minute:number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function formatTimeHM(hour: number, minute = 0): TimeHM {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` as TimeHM;
}

export function normalizeTimes(times: unknown, fallback: TimeHM[] = []): TimeHM[] {
  const list = Array.isArray(times) ? times : [];
  const parsed = list
    .map(item => parseTimeHM(String(item)))
    .filter((item): item is { hour:number; minute:number } => Boolean(item))
    .map(item => formatTimeHM(item.hour, item.minute));
  const unique = [...new Set(parsed)].sort();
  return unique.length ? unique.slice(0, 6) : [...fallback];
}

function normalizeDaily(raw: any): DailySchedule {
  return {
    enabled: raw?.enabled !== false,
    times: normalizeTimes(raw?.times, DEFAULT_AUTO_SCHEDULE.daily.times)
  };
}

function normalizeWeekly(raw: any): WeeklySchedule {
  const weekday = Number(raw?.weekday);
  return {
    enabled: Boolean(raw?.enabled),
    weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : DEFAULT_AUTO_SCHEDULE.weekly.weekday,
    times: normalizeTimes(raw?.times, DEFAULT_AUTO_SCHEDULE.weekly.times)
  };
}

function normalizeMonthly(raw: any): MonthlySchedule {
  const day = raw?.day === 'last' || (Number.isInteger(Number(raw?.day)) && Number(raw.day) >= 1 && Number(raw.day) <= 28)
    ? (raw.day === 'last' ? 'last' : Number(raw.day))
    : DEFAULT_AUTO_SCHEDULE.monthly.day;
  return {
    enabled: raw?.enabled !== false,
    day,
    times: normalizeTimes(raw?.times, DEFAULT_AUTO_SCHEDULE.monthly.times)
  };
}

function normalizeVoiceRetention(raw: any): VoiceRetentionSchedule {
  const days = Number(raw?.retentionDays);
  return {
    enabled: raw?.enabled !== false,
    retentionDays: Number.isInteger(days) && days >= 1 && days <= 90 ? days : DEFAULT_AUTO_SCHEDULE.voiceRetention.retentionDays,
    times: normalizeTimes(raw?.times, DEFAULT_AUTO_SCHEDULE.voiceRetention.times)
  };
}

export function loadAutoSchedule(): AutoSchedule {
  try {
    const migrated = migrateLegacyStorageKey(LEGACY_SCHEDULE_KEY, SCHEDULE_SUFFIX);
    const raw = JSON.parse(migrated || readUserStorage(SCHEDULE_SUFFIX) || 'null');
    if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_AUTO_SCHEDULE);
    return {
      daily: normalizeDaily(raw.daily),
      weekly: normalizeWeekly(raw.weekly),
      monthly: normalizeMonthly(raw.monthly),
      voiceRetention: normalizeVoiceRetention(raw.voiceRetention)
    };
  } catch {
    return structuredClone(DEFAULT_AUTO_SCHEDULE);
  }
}

export function saveAutoSchedule(schedule: AutoSchedule) {
  const next: AutoSchedule = {
    daily: normalizeDaily(schedule.daily),
    weekly: normalizeWeekly(schedule.weekly),
    monthly: normalizeMonthly(schedule.monthly),
    voiceRetention: normalizeVoiceRetention(schedule.voiceRetention)
  };
  writeUserStorage(SCHEDULE_SUFFIX, JSON.stringify(next));
  return next;
}

export function voiceRetentionSlotStorageKey(dateKey: string, time: string) {
  return userStorageKey(`voiceRetentionSlot:${dateKey}-${time.replace(':', '')}`);
}

export function latestDueVoiceRetentionSlot(now = new Date(), schedule: VoiceRetentionSchedule = loadAutoSchedule().voiceRetention) {
  if (!schedule.enabled) return null;
  const time = latestDueTimeSlot(schedule.times, now);
  if (!time) return null;
  const dateKey = localDateKey(now);
  return { dateKey, time, retentionDays: schedule.retentionDays, storageKey: voiceRetentionSlotStorageKey(dateKey, time) };
}

export function minutesSinceMidnight(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

export function timeToMinutes(time: string) {
  const parsed = parseTimeHM(time);
  return parsed ? parsed.hour * 60 + parsed.minute : null;
}

export function latestDueTimeSlot(times: string[], now = new Date()) {
  const nowMinutes = minutesSinceMidnight(now);
  let due: TimeHM | null = null;
  for (const time of normalizeTimes(times)) {
    const minutes = timeToMinutes(time);
    if (minutes != null && nowMinutes >= minutes) due = time as TimeHM;
  }
  return due;
}

export function dailySlotStorageKey(dateKey: string, time: string) {
  return userStorageKey(`dailySlot:${dateKey}-${time.replace(':', '')}`);
}

/** @deprecated prefer schedule-aware overload via loadAutoSchedule */
export const DAILY_REPORT_HOURS = [12, 18, 22] as const;

export function latestDueDailySlot(now = new Date(), schedule: DailySchedule = loadAutoSchedule().daily) {
  if (!schedule.enabled) return null;
  const time = latestDueTimeSlot(schedule.times, now);
  if (!time) return null;
  const dateKey = localDateKey(now);
  return { dateKey, time, storageKey: dailySlotStorageKey(dateKey, time) };
}

/** 用户主动清空复盘后，跳过当日剩余自动生成点 */
export function suppressAutoSlotsForKind(kind: 'daily' | 'weekly' | 'monthly', now = new Date(), schedule: AutoSchedule = loadAutoSchedule()) {
  if (kind === 'daily') {
    const dateKey = localDateKey(now);
    for (const time of schedule.daily.times) markSlotDone(dailySlotStorageKey(dateKey, time));
    return;
  }
  if (kind === 'weekly') {
    const key = isoWeekKey(now);
    for (const time of schedule.weekly.times) markSlotDone(weeklySlotStorageKey(key, time));
    return;
  }
  const dayLabel = schedule.monthly.day === 'last' ? 'last' : String(schedule.monthly.day);
  const key = monthKey(now);
  for (const time of schedule.monthly.times) markSlotDone(monthlySlotStorageKey(key, dayLabel, time));
}

export function weeklySlotStorageKey(weekKey: string, time: string) {
  return userStorageKey(`weeklySlot:${weekKey}-${time.replace(':', '')}`);
}

export function latestDueWeeklySlot(now = new Date(), schedule: WeeklySchedule = loadAutoSchedule().weekly) {
  if (!schedule.enabled) return null;
  if (now.getDay() !== schedule.weekday) return null;
  const time = latestDueTimeSlot(schedule.times, now);
  if (!time) return null;
  const key = isoWeekKey(now);
  return { weekKey: key, time, storageKey: weeklySlotStorageKey(key, time) };
}

export function isLastDayOfMonth(date = new Date()) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return next.getMonth() !== date.getMonth();
}

export function monthlySlotStorageKey(month: string, dayLabel: string, time: string) {
  return userStorageKey(`monthlySlot:${month}-${dayLabel}-${time.replace(':', '')}`);
}

export function latestDueMonthlySlot(now = new Date(), schedule: MonthlySchedule = loadAutoSchedule().monthly) {
  if (!schedule.enabled) return null;
  const dayLabel = schedule.day === 'last' ? 'last' : String(schedule.day);
  const matchesDay = schedule.day === 'last' ? isLastDayOfMonth(now) : now.getDate() === schedule.day;
  if (!matchesDay) return null;
  const time = latestDueTimeSlot(schedule.times, now);
  if (!time) return null;
  const key = monthKey(now);
  return { monthKey: key, time, storageKey: monthlySlotStorageKey(key, dayLabel, time) };
}

export function isSlotDone(storageKey: string) {
  return localStorage.getItem(storageKey) === '1';
}

export function markSlotDone(storageKey: string) {
  localStorage.setItem(storageKey, '1');
}

export const isDailySlotDone = isSlotDone;
export const markDailySlotDone = markSlotDone;

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

export function dateFromIsoWeekKey(weekKey: string) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(weekKey || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!year || week < 1 || week > 53) return null;
  const jan4 = new Date(year, 0, 4);
  const day = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - day + 1 + (week - 1) * 7);
  return monday;
}

export function shiftIsoWeekKey(weekKey: string, deltaWeeks: number) {
  const date = dateFromIsoWeekKey(weekKey);
  if (!date) return weekKey;
  date.setDate(date.getDate() + deltaWeeks * 7);
  return isoWeekKey(date);
}

export function shiftMonthKey(key: string, deltaMonths: number) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!match) return key;
  const date = new Date(Number(match[1]), Number(match[2]) - 1 + deltaMonths, 1);
  return monthKey(date);
}

export function formatPeriodLabel(kind: 'weekly' | 'monthly', key: string) {
  if (kind === 'monthly') {
    const match = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    if (!match) return key;
    return `${match[1]}年${Number(match[2])}月`;
  }
  const start = dateFromIsoWeekKey(key);
  if (!start) return key;
  const range = weekRange(start);
  return `${key} · ${range.weekStart} ~ ${range.weekEnd}`;
}
