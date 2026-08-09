import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';

const serverDir=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(serverDir,'..');
const configuredPath=String(process.env.SQLITE_PATH||'data/flowmate.db').trim();
export const sqlitePath=path.isAbsolute(configuredPath)?configuredPath:path.resolve(projectRoot,configuredPath);
export const sqliteDisplayPath=path.relative(projectRoot,sqlitePath).replace(/\\/g,'/');
export const LEGACY_USER_ID='local-legacy';

mkdirSync(path.dirname(sqlitePath),{recursive:true});
const db=new DatabaseSync(sqlitePath);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

function tableColumns(name){
  return db.prepare(`PRAGMA table_info(${name})`).all().map(row=>String(row.name));
}

function tableExists(name){
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function ensureLegacyUser(){
  const existing=db.prepare('SELECT id FROM users WHERE id=?').get(LEGACY_USER_ID);
  if(existing)return;
  const now=new Date().toISOString();
  db.prepare('INSERT INTO users(id,email,password_hash,display_name,created_at) VALUES(?,?,?,?,?)')
    .run(LEGACY_USER_ID,'legacy@local','!', '历史数据', now);
}

function migrateTasks(){
  if(!tableExists('tasks')){
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        assignee TEXT NOT NULL DEFAULT '我',
        due_label TEXT NOT NULL DEFAULT '今天',
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
        priority TEXT NOT NULL DEFAULT '中' CHECK(priority IN ('高','中','低')),
        progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
        estimated_minutes INTEGER NOT NULL DEFAULT 60 CHECK(estimated_minutes BETWEEN 1 AND 1440),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        ai_status TEXT CHECK(ai_status IS NULL OR ai_status IN ('pending','failed')),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);
    `);
    return;
  }
  const cols=tableColumns('tasks');
  if(!cols.includes('user_id')){
    ensureLegacyUser();
    db.exec('ALTER TABLE tasks ADD COLUMN user_id TEXT');
    db.prepare('UPDATE tasks SET user_id=? WHERE user_id IS NULL OR user_id=\'\'').run(LEGACY_USER_ID);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC)');
}

function migrateDailyReports(){
  if(!tableExists('daily_reports')){
    db.exec(`
      CREATE TABLE daily_reports (
        user_id TEXT NOT NULL,
        report_date TEXT NOT NULL,
        report_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, report_date)
      );
    `);
    return;
  }
  const cols=tableColumns('daily_reports');
  if(!cols.includes('user_id')){
    ensureLegacyUser();
    db.exec(`
      CREATE TABLE daily_reports_new (
        user_id TEXT NOT NULL,
        report_date TEXT NOT NULL,
        report_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, report_date)
      );
      INSERT INTO daily_reports_new(user_id,report_date,report_json,updated_at)
        SELECT '${LEGACY_USER_ID}', report_date, report_json, updated_at FROM daily_reports;
      DROP TABLE daily_reports;
      ALTER TABLE daily_reports_new RENAME TO daily_reports;
    `);
  }
}

function migratePeriodReports(){
  if(!tableExists('period_reports')){
    db.exec(`
      CREATE TABLE period_reports (
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('weekly','monthly')),
        period_key TEXT NOT NULL,
        report_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, kind, period_key)
      );
    `);
    return;
  }
  const cols=tableColumns('period_reports');
  if(!cols.includes('user_id')){
    ensureLegacyUser();
    db.exec(`
      CREATE TABLE period_reports_new (
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('weekly','monthly')),
        period_key TEXT NOT NULL,
        report_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, kind, period_key)
      );
      INSERT INTO period_reports_new(user_id,kind,period_key,report_json,updated_at)
        SELECT '${LEGACY_USER_ID}', kind, period_key, report_json, updated_at FROM period_reports;
      DROP TABLE period_reports;
      ALTER TABLE period_reports_new RENAME TO period_reports;
    `);
  }
}

migrateTasks();
migrateDailyReports();
migratePeriodReports();

const selectTasks=db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC');
const selectTask=db.prepare('SELECT * FROM tasks WHERE user_id=? AND id=?');
const upsertTaskStatement=db.prepare(`
  INSERT INTO tasks(id,user_id,title,assignee,due_label,status,priority,progress,estimated_minutes,created_at,started_at,completed_at,ai_status,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title,assignee=excluded.assignee,due_label=excluded.due_label,status=excluded.status,
    priority=excluded.priority,progress=excluded.progress,estimated_minutes=excluded.estimated_minutes,
    started_at=excluded.started_at,completed_at=excluded.completed_at,ai_status=excluded.ai_status,updated_at=excluded.updated_at
  WHERE tasks.user_id=excluded.user_id
`);
const deleteTaskStatement=db.prepare('DELETE FROM tasks WHERE user_id=? AND id=?');
const selectReport=db.prepare('SELECT report_json FROM daily_reports WHERE user_id=? AND report_date=?');
const deleteReportStatement=db.prepare('DELETE FROM daily_reports WHERE user_id=? AND report_date=?');
const upsertReportStatement=db.prepare(`
  INSERT INTO daily_reports(user_id,report_date,report_json,updated_at) VALUES(?,?,?,?)
  ON CONFLICT(user_id,report_date) DO UPDATE SET report_json=excluded.report_json,updated_at=excluded.updated_at
`);
const selectPeriodReport=db.prepare('SELECT report_json FROM period_reports WHERE user_id=? AND kind=? AND period_key=?');
const selectPeriodReports=db.prepare('SELECT kind,period_key,report_json,updated_at FROM period_reports WHERE user_id=? AND kind=? ORDER BY period_key DESC');
const deletePeriodReportStatement=db.prepare('DELETE FROM period_reports WHERE user_id=? AND kind=? AND period_key=?');
const upsertPeriodReportStatement=db.prepare(`
  INSERT INTO period_reports(user_id,kind,period_key,report_json,updated_at) VALUES(?,?,?,?,?)
  ON CONFLICT(user_id,kind,period_key) DO UPDATE SET report_json=excluded.report_json,updated_at=excluded.updated_at
`);

const selectUserByEmail=db.prepare('SELECT * FROM users WHERE email=?');
const selectUserById=db.prepare('SELECT id,email,display_name,created_at FROM users WHERE id=?');
const insertUser=db.prepare('INSERT INTO users(id,email,password_hash,display_name,created_at) VALUES(?,?,?,?,?)');
const insertSession=db.prepare('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)');
const selectSession=db.prepare(`
  SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.display_name, u.created_at
  FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.id=?
`);
const deleteSession=db.prepare('DELETE FROM sessions WHERE id=?');
const deleteExpiredSessions=db.prepare('DELETE FROM sessions WHERE expires_at < ?');
const deleteUserSessions=db.prepare('DELETE FROM sessions WHERE user_id=?');

function requireUserId(userId){
  const id=String(userId||'').trim();
  if(!id)throw new Error('缺少用户身份');
  return id;
}

function toTask(row){
  if(!row)return null;
  return {id:row.id,title:row.title,assignee:row.assignee,due:row.due_label,status:row.status,priority:row.priority,progress:Number(row.progress),estimatedMinutes:Number(row.estimated_minutes),createdAt:row.created_at,startedAt:row.started_at||undefined,completedAt:row.completed_at||undefined,aiStatus:row.ai_status||undefined};
}

function normalizeTask(raw,current=null){
  const now=new Date().toISOString();
  const id=String(raw?.id||current?.id||'').trim();
  const title=String(raw?.title??current?.title??'').trim().slice(0,500);
  if(!id)throw new Error('任务 ID 不能为空');
  if(!title)throw new Error('任务内容不能为空');
  const status=['todo','doing','done'].includes(raw?.status)?raw.status:(current?.status||'todo');
  const priority=['高','中','低'].includes(raw?.priority)?raw.priority:(current?.priority||'中');
  const progress=Math.max(0,Math.min(100,Math.round(Number(raw?.progress??current?.progress??0))));
  const estimatedMinutes=Math.max(1,Math.min(1440,Math.round(Number(raw?.estimatedMinutes??current?.estimatedMinutes??60))));
  const has=key=>Object.prototype.hasOwnProperty.call(raw||{},key);
  const aiStatus=has('aiStatus')?(['pending','failed'].includes(raw?.aiStatus)?raw.aiStatus:null):(current?.aiStatus||null);
  const startedAt=has('startedAt')?(raw.startedAt||null):(current?.startedAt||null);
  const completedAt=has('completedAt')?(raw.completedAt||null):(current?.completedAt||null);
  return {id,title,assignee:String(raw?.assignee??current?.assignee??'我').trim().slice(0,80)||'我',due:String(raw?.due??current?.due??'今天').trim().slice(0,80)||'今天',status,priority,progress,estimatedMinutes,createdAt:String(current?.createdAt||raw?.createdAt||now),startedAt,completedAt,aiStatus,updatedAt:now};
}

export function listSqliteTasks(userId){return selectTasks.all(requireUserId(userId)).map(toTask)}
export function getSqliteTask(userId,id){return toTask(selectTask.get(requireUserId(userId),String(id)))}
export function saveSqliteTask(userId,raw){
  const uid=requireUserId(userId);
  const current=getSqliteTask(uid,raw?.id);
  const task=normalizeTask(raw,current);
  upsertTaskStatement.run(task.id,uid,task.title,task.assignee,task.due,task.status,task.priority,task.progress,task.estimatedMinutes,task.createdAt,task.startedAt,task.completedAt,task.aiStatus,task.updatedAt);
  const saved=getSqliteTask(uid,task.id);
  if(!saved)throw new Error('无权保存该任务');
  return saved;
}
export function patchSqliteTask(userId,id,changes){
  const current=getSqliteTask(userId,id);if(!current)return null;
  return saveSqliteTask(userId,{...current,...changes,id:current.id,createdAt:current.createdAt});
}
export function deleteSqliteTask(userId,id){return Number(deleteTaskStatement.run(requireUserId(userId),String(id)).changes)>0}
export function loadSqliteReport(userId,date){
  const row=selectReport.get(requireUserId(userId),String(date));if(!row)return null;
  try{return JSON.parse(row.report_json)}catch{return null}
}
export function saveSqliteReport(userId,date,report){
  upsertReportStatement.run(requireUserId(userId),String(date),JSON.stringify(report),new Date().toISOString());
  return report;
}
export function deleteSqliteReport(userId,date){return Number(deleteReportStatement.run(requireUserId(userId),String(date)).changes)>0}

function normalizePeriodKind(kind){
  const value=String(kind||'').trim();
  if(value!=='weekly'&&value!=='monthly')throw new Error('周期类型只能是 weekly 或 monthly');
  return value;
}

export function loadSqlitePeriodReport(userId,kind,periodKey){
  const row=selectPeriodReport.get(requireUserId(userId),normalizePeriodKind(kind),String(periodKey));if(!row)return null;
  try{return JSON.parse(row.report_json)}catch{return null}
}
export function listSqlitePeriodReports(userId,kind){
  return selectPeriodReports.all(requireUserId(userId),normalizePeriodKind(kind)).map(row=>{
    let headline='';
    try{headline=String(JSON.parse(row.report_json)?.headline||'').trim()}catch{}
    return {kind:row.kind,periodKey:row.period_key,updatedAt:row.updated_at,headline};
  });
}
export function saveSqlitePeriodReport(userId,kind,periodKey,report){
  const normalized=normalizePeriodKind(kind);
  const key=String(periodKey||'').trim();
  if(!key)throw new Error('周期键不能为空');
  upsertPeriodReportStatement.run(requireUserId(userId),normalized,key,JSON.stringify(report),new Date().toISOString());
  return report;
}
export function deleteSqlitePeriodReport(userId,kind,periodKey){
  return Number(deletePeriodReportStatement.run(requireUserId(userId),normalizePeriodKind(kind),String(periodKey)).changes)>0;
}

function normalizeEmail(email){
  return String(email||'').trim().toLowerCase();
}

function hashPassword(password){
  const salt=randomBytes(16).toString('hex');
  const hash=scryptSync(String(password),salt,64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password,stored){
  const [salt,hash]=String(stored||'').split(':');
  if(!salt||!hash)return false;
  const actual=scryptSync(String(password),salt,64);
  const expected=Buffer.from(hash,'hex');
  if(actual.length!==expected.length)return false;
  return timingSafeEqual(actual,expected);
}

function publicUser(row){
  if(!row)return null;
  return {id:row.id||row.user_id,email:row.email,name:row.display_name||row.email?.split('@')[0]||'用户',createdAt:row.created_at};
}

export function createSqliteUser({email,password,name}){
  const normalized=normalizeEmail(email);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))throw new Error('邮箱格式不正确');
  if(String(password||'').length<6)throw new Error('密码至少 6 位');
  if(selectUserByEmail.get(normalized))throw new Error('该邮箱已注册');
  const id=randomUUID();
  const displayName=String(name||normalized.split('@')[0]||'用户').trim().slice(0,40)||'用户';
  const now=new Date().toISOString();
  insertUser.run(id,normalized,hashPassword(password),displayName,now);
  return publicUser({id,email:normalized,display_name:displayName,created_at:now});
}

export function authenticateSqliteUser(email,password){
  const row=selectUserByEmail.get(normalizeEmail(email));
  if(!row||row.id===LEGACY_USER_ID)throw new Error('邮箱或密码不正确');
  if(!verifyPassword(password,row.password_hash))throw new Error('邮箱或密码不正确');
  return publicUser(row);
}

export function getSqliteUser(id){
  if(String(id)===LEGACY_USER_ID)return null;
  return publicUser(selectUserById.get(String(id)));
}

export function createSqliteSession(userId,days=7){
  deleteExpiredSessions.run(new Date().toISOString());
  const id=randomUUID();
  const createdAt=new Date().toISOString();
  const expires=new Date(Date.now()+Math.max(1,days)*24*60*60*1000).toISOString();
  insertSession.run(id,requireUserId(userId),expires,createdAt);
  return {id,userId,expiresAt:expires,createdAt};
}

export function getSqliteSession(sessionId){
  if(!sessionId)return null;
  deleteExpiredSessions.run(new Date().toISOString());
  const row=selectSession.get(String(sessionId));
  if(!row)return null;
  if(Date.parse(row.expires_at)<=Date.now()){deleteSession.run(row.session_id);return null}
  return {id:row.session_id,expiresAt:row.expires_at,user:publicUser({id:row.user_id,email:row.email,display_name:row.display_name,created_at:row.created_at})};
}

export function deleteSqliteSession(sessionId){
  if(!sessionId)return false;
  return Number(deleteSession.run(String(sessionId)).changes)>0;
}

export function deleteSqliteUserSessions(userId){
  return Number(deleteUserSessions.run(requireUserId(userId)).changes);
}

export function closeSqlite(){db.close()}
