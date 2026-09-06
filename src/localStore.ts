import { isNativeApp } from './apiBase';
import { apiFetch } from './localAuth';
import {
  cacheDailyReport,
  cachePeriodReport,
  enqueueOffline,
  isConnectivityError,
  isOfflineNow,
  patchCachedTask,
  readCachedDaily,
  readCachedPeriod,
  readQueue,
  readSnapshot,
  removeCachedTask,
  replaceCachedTasks,
  replaceQueue,
  upsertCachedTask,
  type OfflineQueueItem
} from './offlineStore';

export type StoredTask={id:string;title:string;assignee:string;due:string;status:'todo'|'doing'|'done';priority:'高'|'中'|'低';progress:number;estimatedMinutes:number;createdAt?:string;startedAt?:string;completedAt?:string;aiStatus?:'pending'|'failed'};

async function jsonRequest<T>(url:string,options?:RequestInit):Promise<T>{
  const response=await apiFetch(url,options);
  if(response.status===204)return null as T;
  const text=await response.text();
  let data:any={};
  if(text.trim()){try{data=JSON.parse(text)}catch{throw new Error(response.ok?'服务响应异常，请稍后重试':`数据请求失败（${response.status}）`)}}
  else if(!response.ok)throw new Error(response.status>=500?'后端服务暂时不可用，请稍后重试':`数据请求失败（${response.status}）`);
  if(!response.ok)throw new Error(data?.message||`数据请求失败（${response.status}）`);
  return data as T;
}

function allowOfflineFallback(error:unknown){
  return isNativeApp() && (isOfflineNow() || isConnectivityError(error));
}

const jsonHeaders={'Content-Type':'application/json'};
export const listFileTasks=async()=>{
  try{
    const rows=await jsonRequest<StoredTask[]>('/api/tasks');
    replaceCachedTasks(rows);
    return rows;
  }catch(error){
    const cached=readSnapshot()?.tasks;
    if(allowOfflineFallback(error) && cached) return cached;
    throw error;
  }
};
export const saveFileTask=async(task:StoredTask)=>{
  try{
    const saved=await jsonRequest<StoredTask>(`/api/tasks/${encodeURIComponent(task.id)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({...task,startedAt:task.startedAt||null,completedAt:task.completedAt||null,aiStatus:task.aiStatus||null})});
    upsertCachedTask(saved);
    return saved;
  }catch(error){
    if(!allowOfflineFallback(error)) throw error;
    upsertCachedTask(task);
    enqueueOffline({op:'saveTask',task});
    return task;
  }
};
export const patchFileTask=async(id:string,changes:Record<string,unknown>)=>{
  try{
    const saved=await jsonRequest<StoredTask>(`/api/tasks/${encodeURIComponent(id)}`,{method:'PATCH',headers:jsonHeaders,body:JSON.stringify(changes)});
    upsertCachedTask(saved);
    return saved;
  }catch(error){
    if(!allowOfflineFallback(error)) throw error;
    const saved=patchCachedTask(id,changes);
    enqueueOffline({op:'patchTask',id,changes});
    if(!saved) throw error;
    return saved as StoredTask;
  }
};
export const deleteFileTask=async(id:string)=>{
  try{
    await jsonRequest<null>(`/api/tasks/${encodeURIComponent(id)}`,{method:'DELETE'});
    removeCachedTask(id);
    return null;
  }catch(error){
    if(!allowOfflineFallback(error)) throw error;
    removeCachedTask(id);
    enqueueOffline({op:'deleteTask',id});
    return null;
  }
};
export const loadFileDailyReport=async<T>(date:string)=>{
  try{
    const report=await jsonRequest<T|null>(`/api/reports/${encodeURIComponent(date)}`);
    if(report) cacheDailyReport(date,report);
    return report;
  }catch(error){
    const cached=readCachedDaily(date);
    if(allowOfflineFallback(error) && cached!==undefined) return cached as T;
    if(allowOfflineFallback(error)) return null;
    throw error;
  }
};
export const saveFileDailyReport=async<T>(date:string,report:T)=>{
  try{
    const saved=await jsonRequest<T>(`/api/reports/${encodeURIComponent(date)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({report})});
    cacheDailyReport(date,saved);
    return saved;
  }catch(error){
    if(!allowOfflineFallback(error)) throw error;
    cacheDailyReport(date,report);
    enqueueOffline({op:'saveDaily',date,report});
    return report;
  }
};
export const deleteFileDailyReport=(date:string)=>jsonRequest<null>(`/api/reports/${encodeURIComponent(date)}`,{method:'DELETE'});
export const loadFilePeriodReport=async<T>(kind:'weekly'|'monthly',key:string)=>{
  try{
    const report=await jsonRequest<T|null>(`/api/period-reports/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`);
    if(report) cachePeriodReport(kind,key,report);
    return report;
  }catch(error){
    const cached=readCachedPeriod(kind,key);
    if(allowOfflineFallback(error) && cached!==undefined) return cached as T;
    if(allowOfflineFallback(error)) return null;
    throw error;
  }
};
export const saveFilePeriodReport=async<T>(kind:'weekly'|'monthly',key:string,report:T)=>{
  try{
    const saved=await jsonRequest<T>(`/api/period-reports/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({report})});
    cachePeriodReport(kind,key,saved);
    return saved;
  }catch(error){
    if(!allowOfflineFallback(error)) throw error;
    cachePeriodReport(kind,key,report);
    enqueueOffline({op:kind==='weekly'?'saveWeekly':'saveMonthly',key,report});
    return report;
  }
};
export const deleteFilePeriodReport=(kind:'weekly'|'monthly',key:string)=>jsonRequest<null>(`/api/period-reports/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,{method:'DELETE'});
export type PeriodReportMeta={kind:'weekly'|'monthly';periodKey:string;updatedAt?:string;headline?:string};
export const listFilePeriodReports=(kind:'weekly'|'monthly')=>jsonRequest<PeriodReportMeta[]>(`/api/period-reports/${encodeURIComponent(kind)}`);

export async function flushOfflineQueue(){
  const items=readQueue();
  if(!items.length || isOfflineNow()) return {flushed:0,failed:0};
  const remaining:OfflineQueueItem[]=[];
  let flushed=0;
  let failed=0;
  for(const item of items){
    try{
      if(item.op==='saveTask') await jsonRequest(`/api/tasks/${encodeURIComponent(item.task.id)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({...item.task,startedAt:item.task.startedAt||null,completedAt:item.task.completedAt||null,aiStatus:item.task.aiStatus||null})});
      else if(item.op==='patchTask') await jsonRequest(`/api/tasks/${encodeURIComponent(item.id)}`,{method:'PATCH',headers:jsonHeaders,body:JSON.stringify(item.changes)});
      else if(item.op==='deleteTask') await jsonRequest(`/api/tasks/${encodeURIComponent(item.id)}`,{method:'DELETE'});
      else if(item.op==='saveDaily') await jsonRequest(`/api/reports/${encodeURIComponent(item.date)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({report:item.report})});
      else if(item.op==='saveWeekly') await jsonRequest(`/api/period-reports/weekly/${encodeURIComponent(item.key)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({report:item.report})});
      else if(item.op==='saveMonthly') await jsonRequest(`/api/period-reports/monthly/${encodeURIComponent(item.key)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({report:item.report})});
      flushed+=1;
    }catch(error){
      if(isConnectivityError(error) || isOfflineNow()){
        remaining.push(item,...items.slice(items.indexOf(item)+1));
        failed+=items.length-flushed;
        break;
      }
      if(item.op==='deleteTask' && /不存在|404/.test(error instanceof Error?error.message:'')){
        flushed+=1;
        continue;
      }
      remaining.push(item);
      failed+=1;
    }
  }
  replaceQueue(remaining);
  return {flushed,failed};
}
