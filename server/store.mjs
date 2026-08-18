import 'dotenv/config';
import { initPgStore } from './pg-store.mjs';

if (!String(process.env.DATABASE_URL || '').trim()) {
  throw new Error('缺少 DATABASE_URL，请先配置本机 PostgreSQL');
}

export {
  LEGACY_USER_ID,
  storageMode,
  storageDisplay,
  initPgStore,
  listTasks,
  getTask,
  saveTask,
  patchTask,
  deleteTask,
  loadDailyReport,
  saveDailyReport,
  deleteDailyReport,
  loadPeriodReport,
  listPeriodReports,
  savePeriodReport,
  deletePeriodReport,
  createUser,
  authenticateUser,
  upsertBootstrapAdminUser,
  getUser,
  createSession,
  getSession,
  deleteSession,
  deleteUserSessions,
  getUserModelSettings,
  saveUserModelSettings,
  getUserPreferences,
  saveUserPreferences,
  listUserPreferences,
  getLegacyClaimStatus,
  claimLegacyData,
  autoClaimLegacyData,
  closeStore
} from './pg-store.mjs';

export async function initStore() {
  await initPgStore();
}
