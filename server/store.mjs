import 'dotenv/config';

const usePostgres = Boolean(String(process.env.DATABASE_URL || '').trim());

const impl = usePostgres
  ? await import('./pg-store.mjs')
  : await import('./sqlite-store.mjs');

function asAsync(fn) {
  if (!fn) return fn;
  return async (...args) => fn(...args);
}

export const LEGACY_USER_ID = impl.LEGACY_USER_ID;
export const storageMode = usePostgres ? 'postgres' : 'sqlite';
export const storageDisplay = usePostgres
  ? (impl.storageDisplay || 'postgres')
  : (impl.sqliteDisplayPath || 'data/flowmate.db');

/** @deprecated use storageDisplay */
export const sqliteDisplayPath = storageDisplay;

export const listSqliteTasks = usePostgres ? impl.listSqliteTasks : asAsync(impl.listSqliteTasks);
export const getSqliteTask = usePostgres ? impl.getSqliteTask : asAsync(impl.getSqliteTask);
export const saveSqliteTask = usePostgres ? impl.saveSqliteTask : asAsync(impl.saveSqliteTask);
export const patchSqliteTask = usePostgres ? impl.patchSqliteTask : asAsync(impl.patchSqliteTask);
export const deleteSqliteTask = usePostgres ? impl.deleteSqliteTask : asAsync(impl.deleteSqliteTask);

export const loadSqliteReport = usePostgres ? impl.loadSqliteReport : asAsync(impl.loadSqliteReport);
export const saveSqliteReport = usePostgres ? impl.saveSqliteReport : asAsync(impl.saveSqliteReport);
export const deleteSqliteReport = usePostgres ? impl.deleteSqliteReport : asAsync(impl.deleteSqliteReport);

export const loadSqlitePeriodReport = usePostgres ? impl.loadSqlitePeriodReport : asAsync(impl.loadSqlitePeriodReport);
export const listSqlitePeriodReports = usePostgres ? impl.listSqlitePeriodReports : asAsync(impl.listSqlitePeriodReports);
export const saveSqlitePeriodReport = usePostgres ? impl.saveSqlitePeriodReport : asAsync(impl.saveSqlitePeriodReport);
export const deleteSqlitePeriodReport = usePostgres ? impl.deleteSqlitePeriodReport : asAsync(impl.deleteSqlitePeriodReport);

export const createSqliteUser = usePostgres ? impl.createSqliteUser : asAsync(impl.createSqliteUser);
export const authenticateSqliteUser = usePostgres ? impl.authenticateSqliteUser : asAsync(impl.authenticateSqliteUser);
export const getSqliteUser = usePostgres ? impl.getSqliteUser : asAsync(impl.getSqliteUser);
export const createSqliteSession = usePostgres ? impl.createSqliteSession : asAsync(impl.createSqliteSession);
export const getSqliteSession = usePostgres ? impl.getSqliteSession : asAsync(impl.getSqliteSession);
export const deleteSqliteSession = usePostgres ? impl.deleteSqliteSession : asAsync(impl.deleteSqliteSession);
export const deleteSqliteUserSessions = usePostgres ? impl.deleteSqliteUserSessions : asAsync(impl.deleteSqliteUserSessions);

export const getSqliteUserModelSettings = usePostgres ? impl.getSqliteUserModelSettings : asAsync(impl.getSqliteUserModelSettings);
export const saveSqliteUserModelSettings = usePostgres ? impl.saveSqliteUserModelSettings : asAsync(impl.saveSqliteUserModelSettings);

export const getSqliteUserPreferences = usePostgres ? impl.getSqliteUserPreferences : asAsync(impl.getSqliteUserPreferences);
export const saveSqliteUserPreferences = usePostgres ? impl.saveSqliteUserPreferences : asAsync(impl.saveSqliteUserPreferences);
export const listSqliteUserPreferences = usePostgres ? impl.listSqliteUserPreferences : asAsync(impl.listSqliteUserPreferences);

export const getSqliteLegacyClaimStatus = usePostgres ? impl.getSqliteLegacyClaimStatus : asAsync(impl.getSqliteLegacyClaimStatus);
export const claimSqliteLegacyData = usePostgres ? impl.claimSqliteLegacyData : asAsync(impl.claimSqliteLegacyData);
export const autoClaimSqliteLegacyData = usePostgres ? impl.autoClaimSqliteLegacyData : asAsync(impl.autoClaimSqliteLegacyData);

export const closeSqlite = usePostgres ? impl.closeSqlite : asAsync(impl.closeSqlite);

export async function initStore() {
  if (usePostgres && typeof impl.initPgStore === 'function') await impl.initPgStore();
}
