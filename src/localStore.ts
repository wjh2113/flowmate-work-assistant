export type StoredTask={id:string;title:string;assignee:string;due:string;status:'todo'|'doing'|'done';priority:'高'|'中'|'低';progress:number;estimatedMinutes:number;createdAt?:string;startedAt?:string;completedAt?:string;aiStatus?:'pending'|'failed'};

async function jsonRequest<T>(url:string,options?:RequestInit):Promise<T>{
  const response=await fetch(url,{...options,credentials:'include'});
  if(response.status===204)return null as T;
  const text=await response.text();
  let data:any={};
  if(text.trim()){try{data=JSON.parse(text)}catch{throw new Error(response.ok?'服务响应异常，请稍后重试':`数据请求失败（${response.status}）`)}}
  else if(!response.ok)throw new Error(response.status>=500?'后端服务暂时不可用，请稍后重试':`数据请求失败（${response.status}）`);
  if(!response.ok)throw new Error(data?.message||`数据请求失败（${response.status}）`);
  return data as T;
}

const jsonHeaders={'Content-Type':'application/json'};
export const listFileTasks=()=>jsonRequest<StoredTask[]>('/api/tasks');
export const saveFileTask=(task:StoredTask)=>jsonRequest<StoredTask>(`/api/tasks/${encodeURIComponent(task.id)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({...task,startedAt:task.startedAt||null,completedAt:task.completedAt||null,aiStatus:task.aiStatus||null})});
export const patchFileTask=(id:string,changes:Record<string,unknown>)=>jsonRequest<StoredTask>(`/api/tasks/${encodeURIComponent(id)}`,{method:'PATCH',headers:jsonHeaders,body:JSON.stringify(changes)});
export const deleteFileTask=(id:string)=>jsonRequest<null>(`/api/tasks/${encodeURIComponent(id)}`,{method:'DELETE'});
export const loadFileDailyReport=<T>(date:string)=>jsonRequest<T|null>(`/api/reports/${encodeURIComponent(date)}`);
export const saveFileDailyReport=<T>(date:string,report:T)=>jsonRequest<T>(`/api/reports/${encodeURIComponent(date)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({report})});
export const deleteFileDailyReport=(date:string)=>jsonRequest<null>(`/api/reports/${encodeURIComponent(date)}`,{method:'DELETE'});
export const loadFilePeriodReport=<T>(kind:'weekly'|'monthly',key:string)=>jsonRequest<T|null>(`/api/period-reports/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`);
export const saveFilePeriodReport=<T>(kind:'weekly'|'monthly',key:string,report:T)=>jsonRequest<T>(`/api/period-reports/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({report})});
export const deleteFilePeriodReport=(kind:'weekly'|'monthly',key:string)=>jsonRequest<null>(`/api/period-reports/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,{method:'DELETE'});
export type PeriodReportMeta={kind:'weekly'|'monthly';periodKey:string;updatedAt?:string;headline?:string};
export const listFilePeriodReports=(kind:'weekly'|'monthly')=>jsonRequest<PeriodReportMeta[]>(`/api/period-reports/${encodeURIComponent(kind)}`);
