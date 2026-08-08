export type StoredTask={id:string;title:string;assignee:string;due:string;status:'todo'|'doing'|'done';priority:'高'|'中'|'低';progress:number;estimatedMinutes:number;createdAt?:string;startedAt?:string;completedAt?:string;aiStatus?:'pending'|'failed'};

async function jsonRequest<T>(url:string,options?:RequestInit):Promise<T>{
  const response=await fetch(url,options);
  const data=response.status===204?null:await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data?.message||`文件存储请求失败（${response.status}）`);
  return data as T;
}

const jsonHeaders={'Content-Type':'application/json'};
export const listFileTasks=()=>jsonRequest<StoredTask[]>('/api/sqlite/tasks');
export const saveFileTask=(task:StoredTask)=>jsonRequest<StoredTask>(`/api/sqlite/tasks/${encodeURIComponent(task.id)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({...task,startedAt:task.startedAt||null,completedAt:task.completedAt||null,aiStatus:task.aiStatus||null})});
export const patchFileTask=(id:string,changes:Record<string,unknown>)=>jsonRequest<StoredTask>(`/api/sqlite/tasks/${encodeURIComponent(id)}`,{method:'PATCH',headers:jsonHeaders,body:JSON.stringify(changes)});
export const deleteFileTask=(id:string)=>jsonRequest<null>(`/api/sqlite/tasks/${encodeURIComponent(id)}`,{method:'DELETE'});
export const loadFileDailyReport=<T>(date:string)=>jsonRequest<T|null>(`/api/sqlite/reports/${encodeURIComponent(date)}`);
export const saveFileDailyReport=<T>(date:string,report:T)=>jsonRequest<T>(`/api/sqlite/reports/${encodeURIComponent(date)}`,{method:'PUT',headers:jsonHeaders,body:JSON.stringify({report})});
