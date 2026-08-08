import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const serverDir=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(serverDir,'..');
const configuredPath=String(process.env.SQLITE_PATH||'data/flowmate.db').trim();
export const sqlitePath=path.isAbsolute(configuredPath)?configuredPath:path.resolve(projectRoot,configuredPath);
export const sqliteDisplayPath=path.relative(projectRoot,sqlitePath).replace(/\\/g,'/');

mkdirSync(path.dirname(sqlitePath),{recursive:true});
const db=new DatabaseSync(sqlitePath);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
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
  CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
  CREATE TABLE IF NOT EXISTS daily_reports (
    report_date TEXT PRIMARY KEY,
    report_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const selectTasks=db.prepare('SELECT * FROM tasks ORDER BY created_at DESC');
const selectTask=db.prepare('SELECT * FROM tasks WHERE id=?');
const upsertTaskStatement=db.prepare(`
  INSERT INTO tasks(id,title,assignee,due_label,status,priority,progress,estimated_minutes,created_at,started_at,completed_at,ai_status,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title,assignee=excluded.assignee,due_label=excluded.due_label,status=excluded.status,
    priority=excluded.priority,progress=excluded.progress,estimated_minutes=excluded.estimated_minutes,
    started_at=excluded.started_at,completed_at=excluded.completed_at,ai_status=excluded.ai_status,updated_at=excluded.updated_at
`);
const deleteTaskStatement=db.prepare('DELETE FROM tasks WHERE id=?');
const selectReport=db.prepare('SELECT report_json FROM daily_reports WHERE report_date=?');
const deleteReportStatement=db.prepare('DELETE FROM daily_reports WHERE report_date=?');
const upsertReportStatement=db.prepare(`
  INSERT INTO daily_reports(report_date,report_json,updated_at) VALUES(?,?,?)
  ON CONFLICT(report_date) DO UPDATE SET report_json=excluded.report_json,updated_at=excluded.updated_at
`);

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

export function listSqliteTasks(){return selectTasks.all().map(toTask)}
export function getSqliteTask(id){return toTask(selectTask.get(String(id)))}
export function saveSqliteTask(raw){
  const current=getSqliteTask(raw?.id);
  const task=normalizeTask(raw,current);
  upsertTaskStatement.run(task.id,task.title,task.assignee,task.due,task.status,task.priority,task.progress,task.estimatedMinutes,task.createdAt,task.startedAt,task.completedAt,task.aiStatus,task.updatedAt);
  return getSqliteTask(task.id);
}
export function patchSqliteTask(id,changes){
  const current=getSqliteTask(id);if(!current)return null;
  return saveSqliteTask({...current,...changes,id:current.id,createdAt:current.createdAt});
}
export function deleteSqliteTask(id){return Number(deleteTaskStatement.run(String(id)).changes)>0}
export function loadSqliteReport(date){
  const row=selectReport.get(String(date));if(!row)return null;
  try{return JSON.parse(row.report_json)}catch{return null}
}
export function saveSqliteReport(date,report){
  upsertReportStatement.run(String(date),JSON.stringify(report),new Date().toISOString());
  return report;
}
export function deleteSqliteReport(date){return Number(deleteReportStatement.run(String(date)).changes)>0}

export function closeSqlite(){db.close()}
