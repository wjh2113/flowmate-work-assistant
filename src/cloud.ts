import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

const envUrl = import.meta.env.VITE_SUPABASE_URL?.trim() || '';
const envAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || '';

export let cloudConfigured = false;
export let supabase: SupabaseClient | null = null;

function configureCloud(url:string, anonKey:string){
  const cleanUrl=url.trim().replace(/\/$/,'');
  const cleanKey=anonKey.trim();
  cloudConfigured=Boolean(cleanUrl&&cleanKey&&!cleanUrl.includes('your-project'));
  supabase=cloudConfigured?createClient(cleanUrl,cleanKey,{
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
  }):null;
}

export async function bootstrapCloud(){
  try{
    const controller=new AbortController();
    const timer=window.setTimeout(()=>controller.abort(),4000);
    const response=await fetch('/api/settings/cloud',{signal:controller.signal,cache:'no-store'});
    window.clearTimeout(timer);
    if(!response.ok)throw new Error('无法读取服务端云存储配置');
    const data=await response.json();
    configureCloud(String(data.url||''),String(data.anonKey||''));
  }catch{
    configureCloud(envUrl,envAnonKey);
  }
}

export type CloudTask = {
  id:string; team_id:string; title:string; assignee:string; due_label:string;
  status:'todo'|'doing'|'done'; priority:'高'|'中'|'低'; progress:number;
  estimated_minutes:number; created_by:string; created_at:string;
  started_at:string|null; completed_at:string|null;
};

export async function sendMagicLink(email:string){
  if(!supabase)throw new Error('云存储尚未配置');
  const {error}=await supabase.auth.signInWithOtp({email,options:{emailRedirectTo:window.location.origin}});
  if(error)throw error;
}

export async function getSession():Promise<Session|null>{
  if(!supabase)return null;const {data,error}=await supabase.auth.getSession();if(error)throw error;return data.session;
}

export async function getWorkspace(){
  if(!supabase)throw new Error('云存储尚未配置');
  const {data,error}=await supabase.from('team_members').select('team_id,role,teams(name)').limit(1).single();
  if(error)throw error;
  return {teamId:data.team_id as string,teamName:(data.teams as any)?.name||'我的团队',role:data.role as string};
}

export async function listTasks(teamId:string){
  if(!supabase)return[];const {data,error}=await supabase.from('tasks').select('*').eq('team_id',teamId).order('created_at',{ascending:false});if(error)throw error;return data as CloudTask[];
}

export async function upsertTask(row:Partial<CloudTask>&{id:string;team_id:string}){
  if(!supabase)throw new Error('云存储尚未配置');const {error}=await supabase.from('tasks').upsert(row);if(error)throw error;
}

export async function updateTask(id:string,changes:Partial<CloudTask>){
  if(!supabase)throw new Error('云存储尚未配置');const {error}=await supabase.from('tasks').update(changes).eq('id',id);if(error)throw error;
}

export async function deleteTask(id:string){
  if(!supabase)throw new Error('云存储尚未配置');const {error}=await supabase.from('tasks').delete().eq('id',id);if(error)throw error;
}

export async function loadDailyReport(teamId:string,userId:string,date:string){
  if(!supabase)return null;const {data,error}=await supabase.from('daily_reports').select('report').eq('team_id',teamId).eq('user_id',userId).eq('report_date',date).maybeSingle();if(error)throw error;return data?.report||null;
}

export async function saveDailyReport(teamId:string,userId:string,date:string,report:unknown){
  if(!supabase)throw new Error('云存储尚未配置');const {error}=await supabase.from('daily_reports').upsert({team_id:teamId,user_id:userId,report_date:date,report},{onConflict:'team_id,user_id,report_date'});if(error)throw error;
}
