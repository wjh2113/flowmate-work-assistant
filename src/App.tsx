import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { cloudConfigured, deleteDailyReport, deletePeriodReport, deleteTask, getSession, getWorkspace, listPeriodReports, listTasks, loadDailyReport, loadPeriodReport, saveDailyReport, savePeriodReport, sendMagicLink, supabase, updateTask, upsertTask, type CloudTask } from './cloud';
import { apiFetch, getLocalUser, loginLocalUser, logoutLocalUser, registerLocalUser, type LocalUser } from './localAuth';
import { deleteFileDailyReport, deleteFilePeriodReport, deleteFileTask, listFilePeriodReports, listFileTasks, loadFileDailyReport, loadFilePeriodReport, patchFileTask, saveFileDailyReport, saveFilePeriodReport, saveFileTask, type PeriodReportMeta } from './localStore';
import GuidePage from './GuidePage';
import { toSimplified } from './chinese';
import { DEFAULT_AUTO_SCHEDULE, WEEKDAY_LABELS, formatPeriodLabel, formatTimeHM, isSlotDone, isoWeekKey, latestDueDailySlot, latestDueMonthlySlot, latestDueVoiceRetentionSlot, latestDueWeeklySlot, loadAutoSchedule, localDateKey, markSlotDone, monthKey, normalizeTimes, parseTimeHM, saveAutoSchedule, shiftIsoWeekKey, shiftMonthKey, suppressAutoSlotsForKind, weekRange, type AutoSchedule, type TimeHM } from './reportUtils';

type Tab = 'home' | 'tasks' | 'team' | 'mine';
type Status = 'todo' | 'doing' | 'done';
type Priority = '高' | '中' | '低';
type ReportKind = 'daily' | 'weekly' | 'monthly';
type Task = { id:string; title:string; assignee:string; due:string; status:Status; priority:Priority; progress:number; estimatedMinutes:number; createdAt?:string; startedAt?:string; completedAt?:string; aiStatus?:'pending'|'failed' };
type ParsedTask = { title:string; assignee:string; due:string; priority:Priority; confidence:number; estimatedMinutes?:number };
type VoiceTaskChanges = Partial<Pick<Task,'title'|'assignee'|'due'|'priority'|'status'|'estimatedMinutes'>>;
type VoiceUpdate={targetTaskId:string;changes:VoiceTaskChanges};
type VoiceCommand = { action:'create'|'update'|'clarify'|'edit_report'; updates?:VoiceUpdate[]; targetTaskId:string|null; changes:VoiceTaskChanges; tasks?:ParsedTask[]; task?:ParsedTask; reportKind?:ReportKind; instruction?:string; message?:string; confidence:number };
type PlanItem = { title:string; reason:string; priority:Priority; suggestedTime:string };
type DailyReport = { headline:string; summary:string; completed:string[]; risks:string[]; tomorrow:PlanItem[] };
type PeriodReport = { headline:string; summary:string; highlights:string[]; risks:string[]; next:PlanItem[] };
type VoiceJob = { id:string; status:'queued'|'processing'|'completed'|'failed'; stage?:'queued'|'transcribing'|'understanding'|'saving'|'completed'|'failed'; createdAt?:string; transcript?:string; tasks?:ParsedTask[]; task?:ParsedTask|null; command?:VoiceCommand|null; editedReport?:DailyReport|PeriodReport|null; reportKind?:ReportKind|''; cleared?:boolean; error?:string };
type VoiceProgress = { id:string; title:string; stage:string; status:'pending'|'failed'; error?:string; createdAt:string };
type ReportEditJob = { id:string; kind:ReportKind; status:'queued'|'processing'|'completed'|'failed'; stage?:'queued'|'transcribing'|'understanding'|'saving'|'completed'|'failed'; createdAt?:string; transcript?:string; instruction?:string; report?:DailyReport|PeriodReport|null; cleared?:boolean; error?:string; message?:string };
type AppDialog = { mode:'alert'|'confirm'; title:string; message:string; confirmLabel:string; cancelLabel:string; danger?:boolean; resolve:(ok:boolean)=>void };
const voiceStageText:Record<string,string>={queued:'等待AI处理',transcribing:'正在转写语音',understanding:'正在理解指令',saving:'正在保存结果',completed:'处理完成',failed:'识别失败'};
const isRealTask=(task:Task)=>!task.aiStatus;

const defaultEstimate=(priority:Priority)=>priority==='高'?120:priority==='低'?30:60;
const normalizeTask=(task:Task):Task=>({...task,estimatedMinutes:Number(task.estimatedMinutes)>0?Number(task.estimatedMinutes):defaultEstimate(task.priority),startedAt:task.startedAt||((task.status==='doing'||task.status==='done')?task.createdAt:undefined)});
const transitionTaskStatus=(task:Task,status:Status):Task=>{if(task.status===status)return task;const now=new Date().toISOString();if(status==='doing')return{...task,status,progress:task.progress>0&&task.progress<100?task.progress:50,startedAt:task.startedAt||now,completedAt:undefined};if(status==='done')return{...task,status,progress:100,startedAt:task.startedAt||now,completedAt:now};return{...task,status,progress:0,startedAt:undefined,completedAt:undefined}};
async function readApiJson<T=any>(response:Response):Promise<T>{
  const text=await response.text();
  if(!text.trim())throw new Error(response.status>=500||response.status===0?'后端服务暂时不可用，请稍后重试':`服务返回空响应（${response.status}）`);
  try{return JSON.parse(text) as T}catch{throw new Error(`服务响应异常（${response.status}），请稍后重试`)}
}

export default function App(){
  const loginDemo=new URLSearchParams(window.location.search).has('login-demo');
  const showGuide=new URLSearchParams(window.location.search).has('guide');
  const [tab,setTab]=useState<Tab>('home');
  const [tasks,setTasks]=useState<Task[]>([]);
  const [modal,setModal]=useState<'voice'|'add'|'settings'|'cloud'|null>(null);
  const [title,setTitle]=useState(''); const [assignee,setAssignee]=useState('我'); const [estimate,setEstimate]=useState(60);
  const [transcript,setTranscript]=useState(''); const [recording,setRecording]=useState(false); const [processing,setProcessing]=useState(false);
  const [voiceTip,setVoiceTip]=useState('可以说任务，也可以改今日复盘/周报/月报'); const [parsedTask,setParsedTask]=useState<ParsedTask|null>(null);
  const [installEvent,setInstallEvent]=useState<any>(null); const [aiReady,setAiReady]=useState<boolean|null>(null);
  const [report,setReport]=useState<DailyReport|null>(null); const [reportLoading,setReportLoading]=useState(false); const [reportError,setReportError]=useState('');
  const [weeklyReport,setWeeklyReport]=useState<PeriodReport|null>(null); const [weeklyLoading,setWeeklyLoading]=useState(false); const [weeklyError,setWeeklyError]=useState('');
  const [monthlyReport,setMonthlyReport]=useState<PeriodReport|null>(null); const [monthlyLoading,setMonthlyLoading]=useState(false); const [monthlyError,setMonthlyError]=useState('');
  const [editPending,setEditPending]=useState<Partial<Record<ReportKind,{id:string;stage:string;error?:string}>>>({});
  const [voiceProgress,setVoiceProgress]=useState<VoiceProgress[]>([]);
  const [toast,setToast]=useState('');
  const [dialog,setDialog]=useState<AppDialog|null>(null);
  const [session,setSession]=useState<Session|null>(null);
  const [localUser,setLocalUser]=useState<LocalUser|null>(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [teamId,setTeamId]=useState(''); const [syncing,setSyncing]=useState(false);
  const [clock,setClock]=useState(()=>Date.now());
  const recorder=useRef<MediaRecorder|null>(null); const stream=useRef<MediaStream|null>(null); const chunks=useRef<Blob[]>([]);
  const browserRecognition=useRef<SpeechRecognition|null>(null); const localTranscript=useRef('');
  const recordingRef=useRef(false); const discardRecordingRef=useRef(false); const stopFinishTimer=useRef(0);
  const voicePolling=useRef(new Set<string>()); const voicePollTimers=useRef(new Map<string,number>());
  const reportEditPolling=useRef(new Set<string>()); const reportEditPollTimers=useRef(new Map<string,number>());
  const tasksRef=useRef(tasks);
  const reportLoadingRef=useRef(false);
  const weeklyLoadingRef=useRef(false);
  const monthlyLoadingRef=useRef(false);
  const generateReportRef=useRef<()=>Promise<boolean>>(async()=>false);
  const generateWeeklyReportRef=useRef<()=>Promise<boolean>>(async()=>false);
  const generateMonthlyReportRef=useRef<()=>Promise<boolean>>(async()=>false);
  const modalRef=useRef<'voice'|'add'|'settings'|'cloud'|null>(null);
  const [autoSchedule,setAutoSchedule]=useState<AutoSchedule>(()=>loadAutoSchedule());
  const [archiveKind,setArchiveKind]=useState<'weekly'|'monthly'|null>(null);
  const [voiceHistoryOpen,setVoiceHistoryOpen]=useState(false);
  const reportRef=useRef<DailyReport|null>(null);
  const weeklyReportRef=useRef<PeriodReport|null>(null);
  const monthlyReportRef=useRef<PeriodReport|null>(null);
  const persistEditedReportRef=useRef<(kind:ReportKind,data:DailyReport|PeriodReport)=>Promise<void>>(async()=>{});
  const clearReportRef=useRef<(kind:ReportKind)=>Promise<void>>(async()=>{});
  const cloudContext=useRef<{session:Session|null;teamId:string}>({session:null,teamId:''});
  const dateKey=localDateKey();
  const weekMeta=weekRange();
  const weekKey=isoWeekKey();
  const monthKeyValue=monthKey();
  const displayName=String(session?.user.user_metadata?.name||session?.user.email?.split('@')[0]||localUser?.name||localUser?.email?.split('@')[0]||'我');
  const avatarText=displayName.slice(0,1).toUpperCase();
  const signedIn=Boolean(session||localUser);
  const [avatarUrl,setAvatarUrl]=useState<string>(()=>{try{return localStorage.getItem('flowmate.avatar')||''}catch{return''}});
  const saveAvatar=async(file:File)=>{
    if(!file.type.startsWith('image/')){notify('请选择图片文件');return}
    if(file.size>8*1024*1024){notify('图片请控制在 8MB 以内');return}
    try{
      const url=await compressAvatar(file);
      localStorage.setItem('flowmate.avatar',url);setAvatarUrl(url);notify('头像已更新');
    }catch{notify('头像处理失败，请换一张图片重试')}
  };

  useEffect(()=>{tasksRef.current=tasks},[tasks]);
  useEffect(()=>{reportLoadingRef.current=reportLoading},[reportLoading]);
  useEffect(()=>{weeklyLoadingRef.current=weeklyLoading},[weeklyLoading]);
  useEffect(()=>{monthlyLoadingRef.current=monthlyLoading},[monthlyLoading]);
  useEffect(()=>{modalRef.current=modal},[modal]);
  useEffect(()=>{reportRef.current=report},[report]);
  useEffect(()=>{weeklyReportRef.current=weeklyReport},[weeklyReport]);
  useEffect(()=>{monthlyReportRef.current=monthlyReport},[monthlyReport]);
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),30_000);return()=>window.clearInterval(timer)},[]);
  useEffect(()=>{cloudContext.current={session,teamId}},[session,teamId]);
  useEffect(()=>{const h=(e:Event)=>{e.preventDefault();setInstallEvent(e)};window.addEventListener('beforeinstallprompt',h);return()=>window.removeEventListener('beforeinstallprompt',h)},[]);
  useEffect(()=>{fetch('/api/health').then(r=>r.json()).then(data=>setAiReady(Boolean(data.ai))).catch(()=>setAiReady(false))},[]);
  useEffect(()=>{
    if(cloudConfigured)return;
    if(!localUser)return;
    let active=true;let first=true;
    const refresh=async()=>{try{if(first)setSyncing(true);const [storedTasks,storedReport,storedWeekly,storedMonthly]=await Promise.all([listFileTasks(),loadFileDailyReport<DailyReport>(dateKey),loadFilePeriodReport<PeriodReport>('weekly',weekKey),loadFilePeriodReport<PeriodReport>('monthly',monthKeyValue)]);if(active){const normalized=toSimplified(storedTasks).map(normalizeTask);const ghosts=normalized.filter(t=>!isRealTask(t));if(ghosts.length){for(const g of ghosts){if(g.aiStatus==='pending')localStorage.setItem('flowmate.voiceJobs',JSON.stringify([...new Set([...(JSON.parse(localStorage.getItem('flowmate.voiceJobs')||'[]') as string[]),g.id])]));deleteFileTask(g.id).catch(()=>{})}setVoiceProgress(prev=>{const map=new Map(prev.map(item=>[item.id,item]));for(const g of ghosts){if(!map.has(g.id))map.set(g.id,{id:g.id,title:g.title||'语音指令识别中…',stage:g.due||'AI后台处理中',status:g.aiStatus==='failed'?'failed':'pending',error:g.aiStatus==='failed'?(g.due||'识别失败'):undefined,createdAt:g.createdAt||new Date().toISOString()})}return [...map.values()]})}setTasks(normalized.filter(isRealTask));setReport(storedReport?toSimplified(storedReport):null);setWeeklyReport(storedWeekly?toSimplified(storedWeekly):null);setMonthlyReport(storedMonthly?toSimplified(storedMonthly):null);setReportError('')}}catch(error){if(active)setReportError(error instanceof Error?`SQLite 读取失败：${error.message}`:'SQLite 读取失败')}finally{if(active&&first){first=false;setSyncing(false)}}};
    void refresh();const timer=window.setInterval(refresh,5000);
    return()=>{active=false;window.clearInterval(timer)};
  },[localUser,dateKey,weekKey,monthKeyValue]);
  useEffect(()=>{
    let active=true;
    if(cloudConfigured){
      if(!supabase){setAuthLoading(false);return}
      getSession().then(next=>{if(active)setSession(next)}).finally(()=>{if(active)setAuthLoading(false)});
      const {data}=supabase.auth.onAuthStateChange((_event,next)=>{if(active){setSession(next);setAuthLoading(false)}});
      return()=>{active=false;data.subscription.unsubscribe()};
    }
    getLocalUser().then(user=>{if(active)setLocalUser(user)}).finally(()=>{if(active)setAuthLoading(false)});
    return()=>{active=false};
  },[]);
  useEffect(()=>{
    if(!session||!supabase)return;
    const client=supabase;
    let active=true;let channel:any;let currentTeamId='';
    const refresh=async()=>{if(!currentTeamId)return;try{setSyncing(true);      const rows=await listTasks(currentTeamId);if(active)setTasks(rows.map(fromCloud).filter(isRealTask))}finally{if(active)setSyncing(false)}};
    getWorkspace().then(async workspace=>{
      if(!active)return;currentTeamId=workspace.teamId;setTeamId(workspace.teamId);
      const rows=await listTasks(workspace.teamId);if(active)setTasks(rows.map(fromCloud).filter(isRealTask));
      const [cloudReport,cloudWeekly,cloudMonthly]=await Promise.all([
        loadDailyReport(workspace.teamId,session.user.id,dateKey),
        loadPeriodReport(workspace.teamId,session.user.id,'weekly',weekKey),
        loadPeriodReport(workspace.teamId,session.user.id,'monthly',monthKeyValue)
      ]);
      if(active){if(cloudReport)setReport(cloudReport as DailyReport);if(cloudWeekly)setWeeklyReport(cloudWeekly as PeriodReport);if(cloudMonthly)setMonthlyReport(cloudMonthly as PeriodReport)}
      channel=client.channel(`tasks:${workspace.teamId}`).on('postgres_changes',{event:'*',schema:'public',table:'tasks',filter:`team_id=eq.${workspace.teamId}`},()=>refresh()).subscribe();
    }).catch(error=>notify(`云端初始化失败：${error.message}`)).finally(()=>active&&setSyncing(false));
    return()=>{active=false;if(channel)client.removeChannel(channel)};
  },[session,dateKey,weekKey,monthKeyValue]);
  useEffect(()=>{
    let active=true;
    fetch('/api/settings/jobs').then(async res=>{
      const data=await readApiJson<{voiceRetention?:AutoSchedule['voiceRetention']}>(res);
      if(!res.ok||!data.voiceRetention||!active)return;
      setAutoSchedule(prev=>{
        const next={...prev,voiceRetention:{enabled:data.voiceRetention!.enabled!==false,retentionDays:data.voiceRetention!.retentionDays||7,times:[...(data.voiceRetention!.times||['03:00'])]}};
        return saveAutoSchedule(next);
      });
    }).catch(()=>{});
    return()=>{active=false};
  },[]);
  useEffect(()=>{
    if(tab!=='home')return;
    const now=new Date(clock);
    if(aiReady&&tasks.length>0){
      if(!reportLoadingRef.current&&!reportRef.current){
        const dailySlot=latestDueDailySlot(now,autoSchedule.daily);
        if(dailySlot&&!isSlotDone(dailySlot.storageKey))void generateReportRef.current().then(ok=>{if(ok)markSlotDone(dailySlot.storageKey)});
      }
      if(!weeklyLoadingRef.current&&!weeklyReportRef.current){
        const weeklySlot=latestDueWeeklySlot(now,autoSchedule.weekly);
        if(weeklySlot&&!isSlotDone(weeklySlot.storageKey))void generateWeeklyReportRef.current().then(ok=>{if(ok)markSlotDone(weeklySlot.storageKey)});
      }
      if(!monthlyLoadingRef.current&&!monthlyReportRef.current){
        const monthlySlot=latestDueMonthlySlot(now,autoSchedule.monthly);
        if(monthlySlot&&!isSlotDone(monthlySlot.storageKey))void generateMonthlyReportRef.current().then(ok=>{if(ok)markSlotDone(monthlySlot.storageKey)});
      }
    }
    const retentionSlot=latestDueVoiceRetentionSlot(now,autoSchedule.voiceRetention);
    if(signedIn&&retentionSlot&&!isSlotDone(retentionSlot.storageKey)){
      void apiFetch('/api/voice-jobs/purge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({retentionDays:retentionSlot.retentionDays})})
        .then(async res=>{const data=await readApiJson<{skipped?:boolean}>(res);if(res.ok&&!data.skipped)markSlotDone(retentionSlot.storageKey)})
        .catch(()=>{});
    }
  },[aiReady,tab,tasks.length,clock,autoSchedule,signedIn]);

  const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(''),2200)};
  const closeDialog=(ok:boolean)=>{setDialog(current=>{current?.resolve(ok);return null})};
  const showAlert=(message:string,options?:{title?:string;confirmLabel?:string})=>new Promise<void>(resolve=>{setDialog({mode:'alert',title:options?.title||'提示',message,confirmLabel:options?.confirmLabel||'知道了',cancelLabel:'取消',resolve:()=>resolve()})});
  const askConfirm=(message:string,options?:{title?:string;confirmLabel?:string;cancelLabel?:string;danger?:boolean})=>new Promise<boolean>(resolve=>{setDialog({mode:'confirm',title:options?.title||'请确认',message,confirmLabel:options?.confirmLabel||'确定',cancelLabel:options?.cancelLabel||'取消',danger:options?.danger,resolve})});
  const goTab=(next:Tab)=>{setArchiveKind(null);setVoiceHistoryOpen(false);setTab(next);window.requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'smooth'}))};

  const pendingVoiceIds=()=>{try{return JSON.parse(localStorage.getItem('flowmate.voiceJobs')||'[]') as string[]}catch{return[]}};
  const rememberVoiceJob=(id:string)=>localStorage.setItem('flowmate.voiceJobs',JSON.stringify([...new Set([...pendingVoiceIds(),id])]));
  const forgetVoiceJob=(id:string)=>localStorage.setItem('flowmate.voiceJobs',JSON.stringify(pendingVoiceIds().filter(item=>item!==id)));
  const finishVoicePolling=(id:string)=>{const timer=voicePollTimers.current.get(id);if(timer)window.clearTimeout(timer);voicePollTimers.current.delete(id);voicePolling.current.delete(id);forgetVoiceJob(id)};
  const removeVoiceProgress=(id:string)=>setVoiceProgress(items=>items.filter(item=>item.id!==id));
  const upsertVoiceProgress=(item:VoiceProgress)=>setVoiceProgress(items=>{const rest=items.filter(x=>x.id!==item.id);return [item,...rest]});
  const syncVoiceTask=(task:Task)=>{const current=cloudContext.current;if(current.session&&current.teamId)upsertTask(toCloud(task,current.teamId,current.session.user.id)).catch(error=>notify(`语音任务云端同步失败：${error.message}`));else saveFileTask(task).catch(error=>notify(`SQLite 保存失败：${error.message}`))};
  const completeVoiceJob=async(job:VoiceJob)=>{
    const command=toSimplified(job.command);
    if(command?.action==='edit_report'){
      const kind=(job.reportKind||command.reportKind) as ReportKind|undefined;
      const cleared=job.cleared===true;
      const edited=job.editedReport?toSimplified(job.editedReport):null;
      removeVoiceProgress(job.id);
      if(!kind||(!cleared&&!edited)){finishVoicePolling(job.id);notify(command.message||'没有识别到可执行的复盘修改');return}
      try{
        if(cleared)await clearReportRef.current(kind);
        else await persistEditedReportRef.current(kind,edited!);
        setAiReady(true);notify(command.message||(cleared?(kind==='weekly'?'周报已清空':kind==='monthly'?'月报已清空':'今日复盘已清空'):(kind==='weekly'?'周报已更新':kind==='monthly'?'月报已更新':'今日复盘已更新')));goTab('home');
      }catch(error){notify(error instanceof Error?error.message:'复盘保存失败')}
      finally{finishVoicePolling(job.id)}
      return;
    }
    if(command?.action==='update'){
      const requested=command.updates?.length?command.updates:[{targetTaskId:command.targetTaskId||'',changes:command.changes||{}}];const updatedTasks:Task[]=[];
      for(const request of requested){const target=tasksRef.current.find(item=>item.id===request.targetTaskId);if(!target)continue;const {status,...fields}=request.changes||{};let updated:Task={...target,...fields};if(status)updated=transitionTaskStatus(updated,status);updatedTasks.push(updated)}
      removeVoiceProgress(job.id);setTasks(items=>items.map(item=>updatedTasks.find(updated=>updated.id===item.id)||item));updatedTasks.forEach(syncVoiceTask);setAiReady(true);finishVoicePolling(job.id);notify(updatedTasks.length>1?`已更新 ${updatedTasks.length} 项任务`:command.message||'任务已更新');return
    }
    if(command?.action==='clarify'){
      removeVoiceProgress(job.id);finishVoicePolling(job.id);notify(command.message||'请说出要新建的任务，或说明要修改哪条任务/哪份复盘');return
    }
    const rawTasks=job.tasks?.length?job.tasks:command?.tasks?.length?command.tasks:job.task||command?.task?[job.task||command?.task as ParsedTask]:[];
    const parsedTasks=toSimplified(rawTasks).filter((item):item is ParsedTask=>Boolean(item?.title));
    removeVoiceProgress(job.id);
    if(!parsedTasks.length){finishVoicePolling(job.id);notify('没有识别到可执行的任务指令');return}
    const now=new Date().toISOString();
    const created=parsedTasks.slice(0,10).map((parsed,index):Task=>({id:index===0?job.id:`${job.id}-${index+1}`,title:parsed.title||job.transcript||'语音任务',assignee:parsed.assignee||'我',due:parsed.due||'今天',status:'todo',priority:parsed.priority||'中',progress:0,estimatedMinutes:parsed.estimatedMinutes||defaultEstimate(parsed.priority||'中'),createdAt:index===0?(job.createdAt||now):now}));
    setTasks(items=>[...created,...items.filter(item=>item.id!==job.id)]);created.forEach(syncVoiceTask);setAiReady(true);finishVoicePolling(job.id);if(created.length>1)goTab('tasks');notify(created.length>1?`已拆解 ${created.length} 项，以下为全部任务`:'语音任务已创建');
  };
  const failVoiceJob=(job:VoiceJob)=>{
    setVoiceProgress(items=>{
      const current=items.find(item=>item.id===job.id);
      const next:VoiceProgress={id:job.id,title:toSimplified(job.transcript||'')||current?.title||'语音指令',stage:'识别失败',status:'failed',error:job.error||'语音识别失败',createdAt:job.createdAt||current?.createdAt||new Date().toISOString()};
      return [next,...items.filter(item=>item.id!==job.id)];
    });
    finishVoicePolling(job.id);notify(job.error||'语音识别失败，可在识别区块重试');
  };
  const pollVoiceJob=(id:string)=>{
    if(voicePolling.current.has(id))return;voicePolling.current.add(id);
    const check=async()=>{
      try{
        const response=await apiFetch(`/api/voice-jobs/${id}`);const job=await readApiJson<VoiceJob&{message?:string}>(response);
        if(response.status===404){failVoiceJob({id,status:'failed',error:job.message||'语音任务已失效'});return}
        if(!response.ok)throw new Error(job.message||'查询识别进度失败');
        if(job.status==='completed'){void completeVoiceJob(job);return}
        if(job.status==='failed'){failVoiceJob(job);return}
        const elapsed=Math.max(0,Math.round((Date.now()-new Date(job.createdAt||Date.now()).getTime())/1000));
        const stage=`${voiceStageText[job.stage||'queued']||'AI后台处理中'} · ${elapsed}秒`;
        const title=toSimplified(job.transcript||'')||undefined;
        setVoiceProgress(items=>{
          const current=items.find(item=>item.id===id);
          const next:VoiceProgress={id,title:title||current?.title||'语音指令识别中…',stage,status:'pending',createdAt:job.createdAt||current?.createdAt||new Date().toISOString()};
          return [next,...items.filter(item=>item.id!==id)];
        });
        const timer=window.setTimeout(check,1200);voicePollTimers.current.set(id,timer);
      }catch{const timer=window.setTimeout(check,3000);voicePollTimers.current.set(id,timer)}
    };
    void check();
  };
  const retryVoiceJob=async(id:string)=>{
    try{
      const response=await apiFetch(`/api/voice-jobs/${id}/retry`,{method:'POST'});const job=await readApiJson<{message?:string}>(response);if(!response.ok)throw new Error(job.message||'重试失败');
      setVoiceProgress(items=>items.map(item=>item.id===id?{...item,status:'pending',stage:'AI后台处理中',error:undefined}:item));
      rememberVoiceJob(id);voicePolling.current.delete(id);pollVoiceJob(id);notify('已重新提交后台识别');
    }catch(error){notify(error instanceof Error?error.message:'语音任务重试失败')}
  };
  const dismissVoiceJob=async(id:string)=>{
    removeVoiceProgress(id);finishVoicePolling(id);
  };
  useEffect(()=>{
    if(!signedIn)return;
    pendingVoiceIds().forEach(id=>{
      setVoiceProgress(prev=>prev.some(item=>item.id===id)?prev:[{id,title:'语音指令识别中…',stage:'AI后台处理中',status:'pending',createdAt:new Date().toISOString()},...prev]);
      pollVoiceJob(id);
    });
    return()=>{voicePollTimers.current.forEach(timer=>window.clearTimeout(timer));voicePollTimers.current.clear();voicePolling.current.clear()};
  },[signedIn]);

  const pendingReportEditIds=()=>{try{return JSON.parse(localStorage.getItem('flowmate.reportEditJobs')||'[]') as {id:string;kind:ReportKind}[]}catch{return[]}};
  const rememberReportEditJob=(id:string,kind:ReportKind)=>localStorage.setItem('flowmate.reportEditJobs',JSON.stringify([...pendingReportEditIds().filter(item=>item.id!==id),{id,kind}]));
  const forgetReportEditJob=(id:string)=>localStorage.setItem('flowmate.reportEditJobs',JSON.stringify(pendingReportEditIds().filter(item=>item.id!==id)));
  const finishReportEditPolling=(id:string)=>{const timer=reportEditPollTimers.current.get(id);if(timer)window.clearTimeout(timer);reportEditPollTimers.current.delete(id);reportEditPolling.current.delete(id);forgetReportEditJob(id)};
  const completeReportEditJob=async(job:ReportEditJob)=>{
    const cleared=job.cleared===true;
    if(!cleared&&!job.report){setEditPending(prev=>{const next={...prev};delete next[job.kind];return next});finishReportEditPolling(job.id);notify('没有识别到可执行的修改意见');return}
    try{
      if(cleared)await clearReportRef.current(job.kind);
      else await persistEditedReportRef.current(job.kind,toSimplified(job.report!));
      setAiReady(true);notify(cleared?(job.kind==='weekly'?'周报已清空':job.kind==='monthly'?'月报已清空':'今日复盘已清空'):(job.kind==='weekly'?'周报已按语音意见更新':job.kind==='monthly'?'月报已按语音意见更新':'今日复盘已按语音意见更新'));
    }catch(error){notify(error instanceof Error?error.message:'复盘保存失败')}
    finally{setEditPending(prev=>{const next={...prev};delete next[job.kind];return next});finishReportEditPolling(job.id)}
  };
  const failReportEditJob=(job:ReportEditJob)=>{
    setEditPending(prev=>({...prev,[job.kind]:{id:job.id,stage:'failed',error:job.error||'复盘改稿失败'}}));
    finishReportEditPolling(job.id);notify(job.error||'复盘语音修改失败，可点击重试');
  };
  const pollReportEditJob=(id:string,kind:ReportKind)=>{
    if(reportEditPolling.current.has(id))return;reportEditPolling.current.add(id);
    const check=async()=>{
      try{
        const response=await apiFetch(`/api/report-edit-jobs/${id}`);const job=await readApiJson<ReportEditJob>(response);
        if(response.status===404){failReportEditJob({id,kind,status:'failed',error:job.message||'复盘改稿任务已失效'});return}
        if(!response.ok)throw new Error(job.message||'查询改稿进度失败');
        const stageText:Record<string,string>={queued:'等待AI处理',transcribing:'正在转写语音',understanding:'正在理解修改意见',saving:'正在写入复盘',completed:'处理完成',failed:'改稿失败'};
        setEditPending(prev=>({...prev,[kind]:{id,stage:stageText[job.stage||'queued']||'AI后台处理中',error:job.error}}));
        if(job.status==='completed'){await completeReportEditJob({...job,kind});return}
        if(job.status==='failed'){failReportEditJob({...job,kind});return}
        const timer=window.setTimeout(check,1200);reportEditPollTimers.current.set(id,timer);
      }catch{const timer=window.setTimeout(check,3000);reportEditPollTimers.current.set(id,timer)}
    };
    void check();
  };
  const retryReportEditJob=async(kind:ReportKind)=>{
    const pending=editPending[kind];if(!pending?.id)return;
    try{
      const response=await apiFetch(`/api/report-edit-jobs/${pending.id}/retry`,{method:'POST'});const job=await readApiJson<ReportEditJob>(response);
      if(!response.ok)throw new Error(job.message||'重试失败');
      setEditPending(prev=>({...prev,[kind]:{id:pending.id,stage:'等待AI处理'}}));rememberReportEditJob(pending.id,kind);pollReportEditJob(pending.id,kind);notify('已重新提交后台改稿');
    }catch(error){notify(error instanceof Error?error.message:'复盘改稿重试失败')}
  };
  useEffect(()=>{
    if(!signedIn)return;
    pendingReportEditIds().forEach(item=>{setEditPending(prev=>({...prev,[item.kind]:{id:item.id,stage:'AI后台处理中'}}));pollReportEditJob(item.id,item.kind)});
    return()=>{reportEditPollTimers.current.forEach(timer=>window.clearTimeout(timer));reportEditPollTimers.current.clear();reportEditPolling.current.clear()};
  },[signedIn]);

  const realTasks=useMemo(()=>tasks.filter(isRealTask),[tasks]);
  const stats=useMemo(()=>({mine:realTasks.filter(t=>t.assignee==='我').length,done:realTasks.filter(t=>t.assignee==='我'&&t.status==='done').length,follow:realTasks.filter(t=>t.assignee!=='我'&&t.status!=='done').length}),[realTasks]);
  const addTask=(text=title,parsed?:ParsedTask|null)=>{
    if(!text.trim())return;const p=parsed||null;const priority=p?.priority||'中';const task:Task=toSimplified({id:crypto.randomUUID(),title:p?.title||text.trim(),assignee:p?.assignee||assignee,due:p?.due||'今天',status:'todo',priority,progress:0,estimatedMinutes:p?.estimatedMinutes||estimate||defaultEstimate(priority),createdAt:new Date().toISOString()});
    setTasks(v=>[task,...v]);setTitle('');setEstimate(60);setTranscript('');setParsedTask(null);setModal(null);notify('任务已创建');
    setSyncing(true);(session&&teamId?upsertTask(toCloud(task,teamId,session.user.id)):saveFileTask(task)).catch(error=>notify(`任务保存失败：${error.message}`)).finally(()=>setSyncing(false));
  };
  const createTasksFromText=async()=>{
    const text=toSimplified(transcript.trim());if(!text)return;setProcessing(true);setVoiceTip('已提交，AI 将在后台整理…');
    try{
      const response=await apiFetch('/api/voice-jobs/text',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        transcript:text,
        tasks:tasksRef.current.map(({id,title,assignee,due,status,priority,estimatedMinutes})=>({id,title,assignee,due,status,priority,estimatedMinutes})),
        reports:{daily:reportRef.current,weekly:weeklyReportRef.current,monthly:monthlyReportRef.current}
      })});
      const job=await readApiJson<VoiceJob&{message?:string}>(response);
      if(!response.ok)throw new Error(job.message||'指令提交失败');
      upsertVoiceProgress({id:job.id,title:text,stage:'AI后台处理中',status:'pending',createdAt:job.createdAt||new Date().toISOString()});
      rememberVoiceJob(job.id);pollVoiceJob(job.id);goTab('home');
      setTranscript('');setParsedTask(null);setModal(null);
      notify(`已提交“${text.slice(0,18)}${text.length>18?'…':''}”，AI 后台整理中`);
    }
    catch(error){setVoiceTip(error instanceof Error?error.message:'指令提交失败，请重试')}
    finally{setProcessing(false)}
  };
  const cycle=(id:string)=>{
    const current=tasks.find(t=>t.id===id);if(!current)return;const next:Status=current.status==='todo'?'doing':current.status==='doing'?'done':'todo';const now=new Date().toISOString();const changes={status:next,progress:next==='doing'?50:next==='done'?100:0,startedAt:next==='doing'?(current.startedAt||now):next==='todo'?undefined:current.startedAt,completedAt:next==='done'?now:undefined};
    setTasks(v=>v.map(t=>t.id===id?{...t,...changes}:t));
    notify(next==='done'?'任务已完成':next==='doing'?'已开始处理':'已移回待办');
    if(session&&teamId)updateTask(id,{status:changes.status,progress:changes.progress,started_at:changes.startedAt||null,completed_at:changes.completedAt||null}).catch(error=>notify(`云端更新失败：${error.message}`));else patchFileTask(id,{status:changes.status,progress:changes.progress,startedAt:changes.startedAt||null,completedAt:changes.completedAt||null}).catch(error=>notify(`SQLite 更新失败：${error.message}`));
  };
  const removeTask=async(id:string,title:string)=>{
    const current=tasks.find(task=>task.id===id);if(!current)return;
    const ok=await askConfirm(`确定删除“${title}”吗？\n删除后无法撤销。`,{title:'删除任务',confirmLabel:'删除',danger:true});
    if(!ok)return;
    setTasks(items=>items.filter(task=>task.id!==id));finishVoicePolling(id);notify('任务已删除');
    (session&&teamId?deleteTask(id):deleteFileTask(id)).catch(error=>{setTasks(items=>items.some(task=>task.id===id)?items:[current,...items]);void showAlert(`删除失败，任务已恢复：${error.message}`,{title:'删除失败'})});
  };

  const clearRecordingResources=()=>{
    try{browserRecognition.current?.abort()}catch{}
    browserRecognition.current=null;
    try{if(recorder.current&&recorder.current.state!=='inactive')recorder.current.stop()}catch{}
    recorder.current=null;
    stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;chunks.current=[];
    if(stopFinishTimer.current){window.clearTimeout(stopFinishTimer.current);stopFinishTimer.current=0}
  };
  const speechErrorTip=(code:string)=>{
    if(code==='network')return '实时转写连不上浏览器语音云（Chrome 需访问 Google 服务，国内网络常会失败）。录音不受影响，结束后仍由 AI 识别';
    if(code==='not-allowed'||code==='service-not-allowed')return '浏览器未授权语音识别权限。可在地址栏站点设置中允许，或直接结束录音交给 AI';
    if(code==='audio-capture')return '无法采集麦克风给实时转写，录音仍会保存并交由 AI 识别';
    if(code==='language-not-supported')return '当前浏览器不支持中文实时转写，结束后将由 AI 识别';
    return `实时转写中断（${code}），结束后仍交由 AI 识别`;
  };
  const beginRecording=async()=>{
    if(!window.isSecureContext){setVoiceTip('当前不是安全连接。请使用 localhost 或 HTTPS，浏览器才会开放麦克风。');return}
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){setVoiceTip('当前浏览器不支持录音，请使用最新版 Chrome、Edge 或 Safari。');return}
    try{
      discardRecordingRef.current=false;recordingRef.current=false;
      stream.current=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      chunks.current=[];localTranscript.current='';setTranscript('');setParsedTask(null);
      const preferred=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(x=>MediaRecorder.isTypeSupported(x));
      const rec=new MediaRecorder(stream.current,preferred?{mimeType:preferred}:undefined);recorder.current=rec;
      rec.ondataavailable=e=>{if(e.data.size)chunks.current.push(e.data)};
      rec.onstop=()=>{
        if(discardRecordingRef.current){stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;chunks.current=[];recorder.current=null;return}
        void uploadRecording(new Blob(chunks.current,{type:rec.mimeType||'audio/webm'}));
      };
      const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(Speech){
        const r=new Speech();browserRecognition.current=r;r.lang='zh-CN';r.continuous=true;r.interimResults=true;r.maxAlternatives=1;
        r.onresult=e=>{let text='';for(let i=0;i<e.results.length;i++)text+=e.results[i][0].transcript;text=toSimplified(text);localTranscript.current=text;setTranscript(text)};
        r.onerror=ev=>{
          const code=String(ev.error||'');
          if(code==='no-speech'||code==='aborted')return;
          if(modalRef.current==='voice')setVoiceTip(speechErrorTip(code));
        };
        r.onend=()=>{
          if(!recordingRef.current||discardRecordingRef.current||!browserRecognition.current)return;
          try{browserRecognition.current.start()}catch{}
        };
        try{r.start()}catch{}
      }
      rec.start(500);recordingRef.current=true;setRecording(true);
      setVoiceTip(Speech?'可以说任务或改复盘，文字会实时显示在下方':'当前浏览器不支持 Web Speech 实时转写，结束后将由 AI 后台识别');
    }catch{setVoiceTip('麦克风权限未开启。请点击地址栏左侧图标，允许本站使用麦克风。')}
  };
  const cancelRecording=()=>{
    if(!recording&&!processing)return;
    discardRecordingRef.current=true;recordingRef.current=false;setRecording(false);setProcessing(false);
    clearRecordingResources();
    localTranscript.current='';setTranscript('');setParsedTask(null);
    setVoiceTip('已取消录音，可重新开始或直接输入文字');
  };
  const stopRecording=()=>{
    if(!recording)return;recordingRef.current=false;setRecording(false);setProcessing(true);discardRecordingRef.current=false;
    let finished=false;
    const finish=()=>{
      if(finished||discardRecordingRef.current)return;finished=true;
      if(stopFinishTimer.current){window.clearTimeout(stopFinishTimer.current);stopFinishTimer.current=0}
      const text=toSimplified(localTranscript.current.trim());
      if(text)setTranscript(text);
      setVoiceTip(text?'已识别文字，正在保存录音…':'未实时识别到文字，正在保存录音交由 AI 处理…');
      try{browserRecognition.current=null;recorder.current?.stop()}catch{setProcessing(false);setVoiceTip('结束录音失败，请重试')}
    };
    try{
      const r=browserRecognition.current;
      if(r){r.onend=()=>finish();try{r.stop()}catch{finish()}stopFinishTimer.current=window.setTimeout(finish,450)}
      else finish();
    }catch{finish()}
  };
  const persistEditedReport=async(kind:ReportKind,data:DailyReport|PeriodReport)=>{
    if(kind==='daily'){const daily=data as DailyReport;setReport(daily);if(session&&teamId)await saveDailyReport(teamId,session.user.id,dateKey,daily);else await saveFileDailyReport(dateKey,daily);return}
    if(kind==='weekly'){const weekly=data as PeriodReport;setWeeklyReport(weekly);if(session&&teamId)await savePeriodReport(teamId,session.user.id,'weekly',weekKey,weekly);else await saveFilePeriodReport('weekly',weekKey,weekly);return}
    const monthly=data as PeriodReport;setMonthlyReport(monthly);if(session&&teamId)await savePeriodReport(teamId,session.user.id,'monthly',monthKeyValue,monthly);else await saveFilePeriodReport('monthly',monthKeyValue,monthly);
  };
  const clearReport=async(kind:ReportKind)=>{
    suppressAutoSlotsForKind(kind,new Date(),autoSchedule);
    if(kind==='daily'){setReport(null);if(session&&teamId)await deleteDailyReport(teamId,session.user.id,dateKey);else await deleteFileDailyReport(dateKey);return}
    if(kind==='weekly'){setWeeklyReport(null);if(session&&teamId)await deletePeriodReport(teamId,session.user.id,'weekly',weekKey);else await deleteFilePeriodReport('weekly',weekKey);return}
    setMonthlyReport(null);if(session&&teamId)await deletePeriodReport(teamId,session.user.id,'monthly',monthKeyValue);else await deleteFilePeriodReport('monthly',monthKeyValue);
  };
  persistEditedReportRef.current=persistEditedReport;
  clearReportRef.current=clearReport;
  const uploadRecording=async(blob:Blob)=>{
    stream.current?.getTracks().forEach(t=>t.stop());
    try{
      const ext=blob.type.includes('mp4')?'m4a':'webm';const form=new FormData();form.append('audio',blob,`task.${ext}`);
      form.append('tasks',JSON.stringify(tasksRef.current.map(({id,title,assignee,due,status,priority,estimatedMinutes})=>({id,title,assignee,due,status,priority,estimatedMinutes}))));
      form.append('reports',JSON.stringify({daily:reportRef.current,weekly:weeklyReportRef.current,monthly:monthlyReportRef.current}));
      const res=await apiFetch('/api/voice-jobs',{method:'POST',body:form});const job=await readApiJson<VoiceJob&{message?:string}>(res);
      if(!res.ok)throw new Error(job.message||'录音保存失败');
      const browserText=toSimplified(localTranscript.current.trim());
      upsertVoiceProgress({id:job.id,title:browserText||'语音指令识别中…',stage:'AI后台处理中',status:'pending',createdAt:job.createdAt||new Date().toISOString()});
      rememberVoiceJob(job.id);pollVoiceJob(job.id);goTab('home');
      if(browserText)setTranscript(browserText);
      setParsedTask(null);setModal(null);notify(browserText?`已识别“${browserText.slice(0,18)}${browserText.length>18?'…':''}”，AI 后台整理中`:'录音已保存，AI 将在后台整理');
    }catch(error){
      const kept=toSimplified(localTranscript.current.trim());
      if(kept){setTranscript(kept);setVoiceTip(`录音上传失败，已保留识别文字：${error instanceof Error?error.message:'未知错误'}`)}
      else setVoiceTip(error instanceof Error?error.message:'录音保存失败，请重试');
    }finally{setProcessing(false)}
  };

  const generateReport=async()=>{
    if(reportLoadingRef.current)return false;
    setReportLoading(true);setReportError('');
    try{const res=await apiFetch('/api/daily-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tasks:tasksRef.current,date:dateKey,user:displayName})});const raw=await res.json();if(!res.ok)throw new Error(raw.message||'生成失败');const data=toSimplified<DailyReport>(raw);setReport(data);if(session&&teamId)await saveDailyReport(teamId,session.user.id,dateKey,data);else await saveFileDailyReport(dateKey,data);setAiReady(true);return true}
    catch(error){setReportError(error instanceof Error?error.message:'AI 日报生成失败');return false}
    finally{setReportLoading(false)}
  };
  generateReportRef.current=generateReport;
  const generateWeeklyReport=async()=>{
    if(weeklyLoadingRef.current)return false;
    setWeeklyLoading(true);setWeeklyError('');
    try{const res=await apiFetch('/api/weekly-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tasks:tasksRef.current,weekStart:weekMeta.weekStart,weekEnd:weekMeta.weekEnd,user:displayName})});const raw=await res.json();if(!res.ok)throw new Error(raw.message||'生成失败');const data=toSimplified<PeriodReport>(raw);setWeeklyReport(data);if(session&&teamId)await savePeriodReport(teamId,session.user.id,'weekly',weekKey,data);else await saveFilePeriodReport('weekly',weekKey,data);setAiReady(true);return true}
    catch(error){setWeeklyError(error instanceof Error?error.message:'AI 周报生成失败');return false}
    finally{setWeeklyLoading(false)}
  };
  generateWeeklyReportRef.current=generateWeeklyReport;
  const generateMonthlyReport=async()=>{
    if(monthlyLoadingRef.current)return false;
    setMonthlyLoading(true);setMonthlyError('');
    try{const res=await apiFetch('/api/monthly-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tasks:tasksRef.current,month:monthKeyValue,user:displayName})});const raw=await res.json();if(!res.ok)throw new Error(raw.message||'生成失败');const data=toSimplified<PeriodReport>(raw);setMonthlyReport(data);if(session&&teamId)await savePeriodReport(teamId,session.user.id,'monthly',monthKeyValue,data);else await saveFilePeriodReport('monthly',monthKeyValue,data);setAiReady(true);return true}
    catch(error){setMonthlyError(error instanceof Error?error.message:'AI 月报生成失败');return false}
    finally{setMonthlyLoading(false)}
  };
  generateMonthlyReportRef.current=generateMonthlyReport;
  const addPlanItems=(items:PlanItem[],duePrefix:string,successText:string)=>{if(!items.length)return;const planned:Task[]=items.map(x=>({id:crypto.randomUUID(),title:x.title,assignee:'我',due:`${duePrefix} ${x.suggestedTime}`,status:'todo',priority:x.priority,progress:0,estimatedMinutes:defaultEstimate(x.priority),createdAt:new Date().toISOString()}));setTasks(v=>[...planned,...v]);Promise.all(planned.map(t=>session&&teamId?upsertTask(toCloud(t,teamId,session.user.id)):saveFileTask(t))).catch(error=>notify(`部分计划未保存：${error.message}`));notify(successText)};
  const addTomorrow=()=>{if(!report)return;addPlanItems(report.tomorrow,'明天','已将明日计划加入“我的任务”')};
  const addWeeklyNext=()=>{if(!weeklyReport)return;addPlanItems(weeklyReport.next,'下周','已将下周计划加入“我的任务”')};
  const install=async()=>{if(installEvent){installEvent.prompt();await installEvent.userChoice;setInstallEvent(null)}else void showAlert('iPhone：Safari 分享 → 添加到主屏幕。\nAndroid：浏览器菜单 → 安装应用。',{title:'添加到主屏幕'})};

  const signOut=async()=>{
    if(cloudConfigured){await supabase?.auth.signOut();return}
    try{await logoutLocalUser()}catch{}
    setLocalUser(null);setTasks([]);setReport(null);setWeeklyReport(null);setMonthlyReport(null);setVoiceProgress([]);setEditPending({});setTeamId('');
  };

  if(showGuide)return <GuidePage/>;
  if(loginDemo)return <LoginPage demo/>;
  if(authLoading)return <div className="viewport"><main className="app auth-shell"><div className="cloud-loader"><div className="ai-orb">✦</div><b>{cloudConfigured?'正在连接云端工作区…':'正在检查本地登录状态…'}</b></div></main></div>;
  if(cloudConfigured&&!session)return <LoginPage/>;
  if(!cloudConfigured&&!localUser)return <LoginPage mode="local" onLocalAuth={async user=>{
    // Prefer cookie-backed /me, but always enter home with the login response so a brief cookie lag won't block entry.
    const verified=await getLocalUser().catch(()=>null);
    setLocalUser(verified||user);
    setTab('home');
    setArchiveKind(null);
    setVoiceHistoryOpen(false);
    setReportError('');
  }}/>;

  return <div className="viewport"><main className="app">
    {tab==='home'&&<div className="page home-page">
      <header><div className="home-greeting"><span className="brand-chip">FLOWMATE</span><h1>{displayName==='我'?'你好':`你好，${displayName}`}</h1></div><div className="header-actions"><a className="help-button" href="/?guide=1" aria-label="打开使用指南">?</a><button className="avatar" onClick={()=>goTab('mine')} aria-label="打开我的页面">{avatarUrl?<img src={avatarUrl} alt=""/>:avatarText}<i/></button></div></header>
      <Title text="今日概览" action={new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'short'}).format(new Date())}/>
      <div className="stats"><Stat n={stats.mine} label="我的任务" tone="purple" onClick={()=>goTab('tasks')}/><Stat n={stats.done} label="今日完成" tone="green" onClick={()=>goTab('tasks')}/><Stat n={stats.follow} label="待我跟进" tone="orange" onClick={()=>goTab('team')}/></div>
      {voiceProgress.length>0&&<VoiceProgressPanel items={voiceProgress} onRetry={id=>void retryVoiceJob(id)} onDismiss={id=>void dismissVoiceJob(id)}/>}
      <Title text="优先处理" action="查看全部 ›" onClick={()=>goTab('tasks')}/>
      {realTasks.filter(t=>t.status!=='done').slice(0,3).map(t=><TaskItem key={t.id} task={t} cycle={cycle} remove={removeTask} now={clock}/>)}
      <Title text="团队动态" action="全部动态" onClick={()=>goTab('team')}/>
      <div className="empty activity-empty">团队动态稍后会出现在这里</div>
      <Title text="今日复盘" action={report?'更新':'生成'} onClick={()=>void generateReport()}/>
      <AIReport report={report} loading={reportLoading} error={reportError} aiReady={aiReady} generate={()=>void generateReport()} addTomorrow={addTomorrow} openSettings={()=>setModal('settings')} editPending={editPending.daily} onRetryEdit={()=>void retryReportEditJob('daily')}/>
      <Title text="本周周报" action={weeklyReport?'更新':'生成'} onClick={()=>void generateWeeklyReport()}/>
      <AIPeriodReport kind="weekly" report={weeklyReport} loading={weeklyLoading} error={weeklyError} aiReady={aiReady} generate={()=>void generateWeeklyReport()} addNext={addWeeklyNext} openSettings={()=>setModal('settings')} rangeLabel={`${weekMeta.weekStart} ~ ${weekMeta.weekEnd}`} editPending={editPending.weekly} onRetryEdit={()=>void retryReportEditJob('weekly')}/>
      <Title text="本月月报" action={monthlyReport?'更新':'生成'} onClick={()=>void generateMonthlyReport()}/>
      <AIPeriodReport kind="monthly" report={monthlyReport} loading={monthlyLoading} error={monthlyError} aiReady={aiReady} generate={()=>void generateMonthlyReport()} openSettings={()=>setModal('settings')} rangeLabel={monthKeyValue} editPending={editPending.monthly} onRetryEdit={()=>void retryReportEditJob('monthly')}/>
      <button className="install" onClick={install}>{installEvent?'安装 FlowMate 到手机':'添加到手机主屏幕'}</button>
    </div>}
    {tab==='tasks'&&<ListPage title="我的任务" tasks={realTasks.filter(t=>t.assignee==='我')} cycle={cycle} remove={removeTask} now={clock} voiceProgress={voiceProgress} onRetryVoice={id=>void retryVoiceJob(id)} onDismissVoice={id=>void dismissVoiceJob(id)}/>} 
    {tab==='team'&&<ListPage title="团队任务" tasks={realTasks.filter(t=>t.assignee!=='我')} cycle={cycle} remove={removeTask} now={clock}/>} 
    {tab==='mine'&&(voiceHistoryOpen?<VoiceHistoryPage onBack={()=>setVoiceHistoryOpen(false)}/>:archiveKind?<PeriodArchivePage kind={archiveKind} session={session} teamId={teamId} currentKey={archiveKind==='weekly'?weekKey:monthKeyValue} onBack={()=>setArchiveKind(null)}/>:<Profile avatarText={avatarText} avatarUrl={avatarUrl} onAvatarFile={file=>void saveAvatar(file)} displayName={displayName} accountHint={session?.user.email||localUser?.email||''} tasks={realTasks} install={install} aiReady={aiReady} cloudOnline={Boolean(session)} localOnline={Boolean(localUser)} syncing={syncing} signOut={()=>void signOut()} goTeam={()=>goTab('team')} openSettings={()=>setModal('settings')} openWeeklyArchive={()=>setArchiveKind('weekly')} openMonthlyArchive={()=>setArchiveKind('monthly')} openVoiceHistory={()=>setVoiceHistoryOpen(true)}/>)} 
    <div className="quick-create" role="group" aria-label="新建任务">
      <button className="quick-voice" type="button" onClick={()=>{setVoiceTip('可以说任务，也可以改今日复盘/周报/月报');setModal('voice')}} aria-label="语音创建任务或修改复盘"><MicIcon/><span>语音</span></button>
      <button className="quick-add" type="button" onClick={()=>setModal('add')} aria-label="手动新建任务">＋</button>
    </div>
    <nav aria-label="主导航">{([['home','首页'],['tasks','任务'],['team','团队'],['mine','我的']] as const).map(([id,label])=><button className={tab===id?'active':''} onClick={()=>goTab(id)} key={id} aria-current={tab===id?'page':undefined}><i aria-hidden="true"><NavIcon name={id}/></i><span>{label}</span></button>)}</nav>
    {toast&&<div className="toast" role="status">✓ {toast}</div>}
    {dialog&&<div className="dialog-overlay" role="presentation" onClick={()=>{if(dialog.mode==='alert')closeDialog(true)}}><div className={'dialog-card'+(dialog.danger?' danger':'')} role="alertdialog" aria-modal="true" aria-labelledby="app-dialog-title" onClick={e=>e.stopPropagation()}><div className="dialog-icon" aria-hidden="true">{dialog.danger?'!':'✦'}</div><h3 id="app-dialog-title">{dialog.title}</h3><p className="dialog-body">{dialog.message}</p><div className="dialog-actions">{dialog.mode==='confirm'&&<button type="button" className="dialog-cancel" onClick={()=>closeDialog(false)}>{dialog.cancelLabel}</button>}<button type="button" className="dialog-ok" onClick={()=>closeDialog(true)} autoFocus>{dialog.confirmLabel}</button></div></div></div>}
    {modal&&<div className="overlay" onClick={()=>{if(recording){cancelRecording();return}if(!processing)setModal(null)}}><section className={'sheet '+(modal==='settings'||modal==='cloud'?'settings-sheet':'')} onClick={e=>e.stopPropagation()}><div className="handle"/>{modal==='voice'?<><h2>{processing?'正在保存录音…':recording?'正在录音…':transcript?'指令待确认':'语音助手'}</h2><p className={'voice-tip '+(recording||processing?'live':'')}>{voiceTip}</p><button className={'record '+(recording?'recording':'')} disabled={processing} onClick={recording?stopRecording:beginRecording}><MicIcon/></button><p className="record-label">{processing?'保存后由 AI 后台整理':recording?'点击麦克风结束录音':'点击开始录音'}</p>{recording&&<button className="record-cancel" type="button" onClick={cancelRecording}>取消录音</button>}<textarea className="input transcript" value={transcript} placeholder="例如：新建两个任务… / 把今日复盘风险删掉… / 周报下周计划加一项演示" onChange={e=>{setTranscript(e.target.value);setParsedTask(null)}}/>{parsedTask&&<div className="ai-understanding"><b>已整理</b><span>任务：{parsedTask.title}</span><span>负责人：{parsedTask.assignee} · 截止：{parsedTask.due} · {parsedTask.priority}优先级</span><span>预计用时：{formatDuration(parsedTask.estimatedMinutes||defaultEstimate(parsedTask.priority))}</span></div>}<button className="primary" disabled={!transcript.trim()||processing||recording} onClick={createTasksFromText}>AI 理解并执行</button></>:modal==='settings'?<AppSettings schedule={autoSchedule} onScheduleSaved={next=>{setAutoSchedule(next);notify('自动作业时间已保存')}} onClose={()=>setModal(null)} onModelSaved={()=>{setAiReady(true);notify('模型设置已保存')}}/>:modal==='cloud'?<CloudSettings onClose={()=>setModal(null)} askConfirm={askConfirm}/>:<><h2>新建任务</h2><label>任务内容</label><input className="input" value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：完成项目周报"/><label>负责人</label><div className="people"><button className="selected" onClick={()=>setAssignee('我')}>我</button></div><label>预估时间</label><select className="input" value={estimate} onChange={e=>setEstimate(Number(e.target.value))}><option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={60}>1 小时</option><option value={120}>2 小时</option><option value={240}>4 小时</option></select><button className="primary" disabled={!title.trim()} onClick={()=>addTask()}>创建任务</button></>}</section></div>}
  </main></div>;
}

function AIReport({report,loading,error,aiReady,generate,addTomorrow,openSettings,editPending,onRetryEdit}:{report:DailyReport|null;loading:boolean;error:string;aiReady:boolean|null;generate:()=>void;addTomorrow:()=>void;openSettings:()=>void;editPending?:{id:string;stage:string;error?:string};onRetryEdit:()=>void}){
  const handleGenerate=()=>{if(aiReady===false){openSettings();return}generate()};
  if(loading)return <section className="ai-report loading"><div className="ai-orb">···</div><div><b>正在整理今天的工作</b><p>汇总完成事项、待跟进内容和明日安排</p></div></section>;
  if(!report)return <section className="ai-report empty-report"><div className="ai-orb">≡</div><div><b>{aiReady===false?'复盘服务待配置':'整理今天的工作'}</b><p>{error||'汇总完成情况，并安排明天的重要事项。可在「我的 → 设置」配置自动生成时间。'}</p><button type="button" onClick={handleGenerate}>{aiReady===false?'查看配置说明':'开始整理'}</button></div></section>;
  return <section className={'ai-report full'+(editPending?' editing':'')}><div className="report-top"><div className="ai-orb">{editPending&&!editPending.error?'…':'✦'}</div><div><small>今日工作小结{editPending?` · ${editPending.error?'改稿失败':editPending.stage}`:''}</small><h3>{report.headline}</h3></div></div>{editPending?.error&&<p className="report-edit-error">{editPending.error} <button type="button" onClick={onRetryEdit}>重试</button></p>}<p className="report-summary">{report.summary}</p>{report.completed.length>0&&<div className="report-block"><b>已完成</b>{report.completed.map(x=><span key={x}>✓ {x}</span>)}</div>}{report.risks.length>0&&<div className="report-block risks"><b>需要关注</b>{report.risks.map(x=><span key={x}>! {x}</span>)}</div>}<div className="tomorrow-head"><b>明日建议</b><span>{report.tomorrow.length} 项</span></div>{report.tomorrow.map((x,i)=><div className="tomorrow" key={`${x.title}-${i}`}><i>{i+1}</i><div><b>{x.title}</b><p>{x.suggestedTime} · {x.reason}</p></div><em>{x.priority}</em></div>)}<div className="report-actions"><button className="add-plan" type="button" onClick={addTomorrow}>＋ 加入明日任务</button></div></section>;
}
function AIPeriodReport({kind,report,loading,error,aiReady,generate,addNext,openSettings,rangeLabel,editPending,onRetryEdit}:{kind:'weekly'|'monthly';report:PeriodReport|null;loading:boolean;error:string;aiReady:boolean|null;generate:()=>void;addNext?:()=>void;openSettings:()=>void;rangeLabel:string;editPending?:{id:string;stage:string;error?:string};onRetryEdit:()=>void}){
  const label=kind==='weekly'?'本周':'本月';const nextLabel=kind==='weekly'?'下周':'下月';
  const handleGenerate=()=>{if(aiReady===false){openSettings();return}generate()};
  if(loading)return <section className="ai-report loading"><div className="ai-orb">···</div><div><b>正在整理{label}复盘</b><p>汇总亮点、风险并生成{nextLabel}计划</p></div></section>;
  if(!report)return <section className="ai-report empty-report"><div className="ai-orb">≡</div><div><b>{aiReady===false?'复盘服务待配置':`生成${label}复盘`}</b><p>{error||`${rangeLabel} · AI 将整理${label}进展，并给出${nextLabel}计划。`}</p><button type="button" onClick={handleGenerate}>{aiReady===false?'查看配置说明':'开始生成'}</button></div></section>;
  return <section className={'ai-report full'+(editPending?' editing':'')}><div className="report-top"><div className="ai-orb">{editPending&&!editPending.error?'…':'✦'}</div><div><small>{label}复盘 · {rangeLabel}{editPending?` · ${editPending.error?'改稿失败':editPending.stage}`:''}</small><h3>{report.headline}</h3></div></div>{editPending?.error&&<p className="report-edit-error">{editPending.error} <button type="button" onClick={onRetryEdit}>重试</button></p>}<p className="report-summary">{report.summary}</p>{report.highlights.length>0&&<div className="report-block"><b>亮点</b>{report.highlights.map(x=><span key={x}>✓ {x}</span>)}</div>}{report.risks.length>0&&<div className="report-block risks"><b>需要关注</b>{report.risks.map(x=><span key={x}>! {x}</span>)}</div>}<div className="tomorrow-head"><b>{nextLabel}计划</b><span>{report.next.length} 项</span></div>{report.next.map((x,i)=><div className="tomorrow" key={`${x.title}-${i}`}><i>{i+1}</i><div><b>{x.title}</b><p>{x.suggestedTime} · {x.reason}</p></div><em>{x.priority}</em></div>)}{addNext&&<div className="report-actions"><button className="add-plan" type="button" onClick={addNext}>＋ 加入{nextLabel}任务</button></div>}</section>;
}
function Title({text,action,onClick}:{text:string;action:string;onClick?:()=>void}){return <div className="section-title"><h2>{text}</h2>{onClick?<button type="button" onClick={onClick}>{action}</button>:<span>{action}</span>}</div>}
function MicIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2" width="8" height="13" rx="4" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>}
function NavIcon({name}:{name:Tab}){
  const common={fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round' as const,strokeLinejoin:'round' as const};
  if(name==='home')return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4.5 10.5 12 4l7.5 6.5V20a1.5 1.5 0 0 1-1.5 1.5h-4.2v-6.2H10.2V21.5H6A1.5 1.5 0 0 1 4.5 20z"/></svg>;
  if(name==='tasks')return <svg viewBox="0 0 24 24" aria-hidden="true"><rect {...common} x="4.5" y="3.5" width="15" height="17" rx="3"/><path {...common} d="m8.2 12 2.4 2.4 5.2-5.4"/><path {...common} d="M8.5 7.2h7"/></svg>;
  if(name==='team')return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="9" cy="8.2" r="2.6"/><circle {...common} cx="16.2" cy="9" r="2.2"/><path {...common} d="M4.8 18.8c.4-2.7 2.4-4.2 4.2-4.2s3.8 1.5 4.2 4.2"/><path {...common} d="M13.4 18.8c.2-1.8 1.4-3.1 2.8-3.1 1.6 0 2.8 1.2 3.1 3.1"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="12" cy="8.2" r="3.2"/><path {...common} d="M6 19.2c.7-3.2 2.9-4.8 6-4.8s5.3 1.6 6 4.8"/></svg>;
}
function Stat({n,label,tone,onClick}:{n:number;label:string;tone:'purple'|'green'|'orange';onClick:()=>void}){
  const common={fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round' as const,strokeLinejoin:'round' as const};
  const icon=tone==='green'
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m6.5 12.5 3.2 3.2 7.8-8"/></svg>
    : tone==='orange'
      ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="12" cy="12" r="8"/><path {...common} d="M12 8v4.5l2.8 1.7"/></svg>
      : <svg viewBox="0 0 24 24" aria-hidden="true"><rect {...common} x="5" y="4" width="14" height="16" rx="3"/><path {...common} d="M8 9h8M8 13h5"/></svg>;
  return <button className={'stat tone-'+tone} type="button" onClick={onClick}><i className={tone}>{icon}</i><strong>{n}</strong><span>{label}</span></button>;
}
function VoiceProgressPanel({items,onRetry,onDismiss}:{items:VoiceProgress[];onRetry:(id:string)=>void;onDismiss:(id:string)=>void}){
  if(!items.length)return null;
  return <section className="voice-progress" aria-live="polite"><div className="voice-progress-head"><div className="ai-orb">…</div><div><small>AI 语音识别</small><h3>{items.some(item=>item.status==='pending')?'正在处理你的语音指令':'语音识别结果'}</h3></div></div>{items.map(item=><div className={'voice-progress-item '+(item.status==='failed'?'failed':'pending')} key={item.id}><div><b>{item.title}</b><p>{item.status==='failed'?(item.error||'识别失败'):item.stage}</p></div><div className="voice-progress-actions">{item.status==='failed'?<button type="button" onClick={()=>onRetry(item.id)}>重试</button>:null}<button type="button" className="voice-progress-dismiss" onClick={()=>onDismiss(item.id)} aria-label="关闭此项">×</button></div></div>)}</section>;
}
function formatDuration(minutes:number){const safe=Math.max(0,Math.round(minutes||0));if(safe<60)return `${safe}分钟`;const hours=Math.floor(safe/60);const rest=safe%60;return rest?`${hours}小时${rest}分钟`:`${hours}小时`}
function taskElapsed(task:Task,now:number){if(!task.startedAt)return 0;const start=new Date(task.startedAt).getTime();const end=task.status==='done'&&task.completedAt?new Date(task.completedAt).getTime():now;if(!Number.isFinite(start)||!Number.isFinite(end))return 0;return Math.max(0,Math.floor((end-start)/60_000))}
function TrashIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
function TaskItem({task,cycle,remove,now}:{task:Task;cycle:(id:string)=>void;remove:(id:string,title:string)=>void;now:number}){const elapsed=taskElapsed(task,now);const priorityClass=task.priority==='高'?'priority-high':task.priority==='低'?'priority-low':'priority-mid';return <div className={'task-wrap '+priorityClass}><button className="task" onClick={()=>cycle(task.id)}><i className={`task-status ${task.status}`}>{task.status==='done'?'✓':''}</i><div><strong className={task.status==='done'?'done':''}>{task.title}</strong><p><b className={task.priority==='高'?'high':''}>{task.priority}优先级</b> · {task.due} · {task.assignee}</p><div className="task-time"><span>预计 {formatDuration(task.estimatedMinutes)}</span><span>已进行 {formatDuration(elapsed)}</span></div>{task.assignee!=='我'&&task.status!=='done'&&<span className="progress"><em style={{width:`${task.progress}%`}}/></span>}</div></button><button className="task-delete" type="button" onClick={()=>remove(task.id,task.title)} aria-label={`删除任务：${task.title}`}><TrashIcon/></button></div>}
function ListPage({title,tasks,cycle,remove,now,voiceProgress,onRetryVoice,onDismissVoice}:{title:string;tasks:Task[];cycle:(id:string)=>void;remove:(id:string,title:string)=>void;now:number;voiceProgress?:VoiceProgress[];onRetryVoice?:(id:string)=>void;onDismissVoice?:(id:string)=>void}){const [filter,setFilter]=useState('全部');const list=tasks.filter(t=>filter==='全部'||(filter==='已完成'?t.status==='done':t.status!=='done'));return <div className="page"><h1 className="page-title">{title}</h1><p className="page-sub">轻点任务切换状态，右侧按钮可删除任务</p>{voiceProgress&&voiceProgress.length>0&&onRetryVoice&&onDismissVoice&&<VoiceProgressPanel items={voiceProgress} onRetry={onRetryVoice} onDismiss={onDismissVoice}/>}<div className="filters">{['全部','进行中','已完成'].map(f=><button key={f} className={f===filter?'active':''} onClick={()=>setFilter(f)}>{f}</button>)}</div>{list.map(t=><TaskItem key={t.id} task={t} cycle={cycle} remove={remove} now={now}/>)}{!list.length&&<div className="empty">还没有任务，点下方语音或加号开始</div>}</div>}
function Profile({avatarText,avatarUrl,onAvatarFile,displayName,accountHint,tasks,install,aiReady,cloudOnline,localOnline,syncing,signOut,goTeam,openSettings,openWeeklyArchive,openMonthlyArchive,openVoiceHistory}:{avatarText:string;avatarUrl:string;onAvatarFile:(file:File)=>void;displayName:string;accountHint:string;tasks:Task[];install:()=>void;aiReady:boolean|null;cloudOnline:boolean;localOnline:boolean;syncing:boolean;signOut:()=>void;goTeam:()=>void;openSettings:()=>void;openWeeklyArchive:()=>void;openMonthlyArchive:()=>void;openVoiceHistory:()=>void}){
  const fileRef=useRef<HTMLInputElement|null>(null);
  const rate=Math.round(tasks.filter(t=>t.status==='done').length/Math.max(tasks.length,1)*100);
  const menus=[{i:'◷',t:'周报查询',action:openWeeklyArchive},{i:'◫',t:'月报查询',action:openMonthlyArchive},{i:'♪',t:'语音指令记录',action:openVoiceHistory},{i:'◎',t:'成员管理',action:goTeam},{i:'⚙',t:'设置',action:openSettings}];
  return <div className="page"><h1 className="page-title">我的</h1>
    <section className="profile">
      <button type="button" className="big-avatar uploadable" onClick={()=>fileRef.current?.click()} aria-label="上传头像">{avatarUrl?<img src={avatarUrl} alt="头像"/>:avatarText}<em>更换</em></button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={e=>{const file=e.target.files?.[0];if(file)onAvatarFile(file);e.target.value=''}}/>
      <div className="profile-identity"><b>{displayName}</b>{accountHint&&<span>{accountHint}</span>}</div>
      <span className={'ai-status '+(aiReady?'online':'')}>● {aiReady?'智能助手已连接':'智能助手待配置'}</span>
      {cloudOnline&&<span className="ai-status online">● {syncing?'云端同步中':'云端数据已同步'}</span>}
      {localOnline&&!cloudOnline&&<span className="ai-status online">● 本机账号已登录</span>}
    </section>
    <section className="week"><h2>本周效率</h2><strong>{rate}%</strong><p>任务完成率</p><span><i style={{width:`${rate}%`}}/></span></section>
    {menus.map(item=><button className="menu" key={item.t} onClick={item.action}><i>{item.i}</i><span>{item.t}</span><b>›</b></button>)}
    <button className="install" onClick={install}>添加到手机主屏幕</button>
    {(cloudOnline||localOnline)&&<button className="sign-out" onClick={signOut}>退出当前账号</button>}
  </div>;
}

type VoiceHistoryItem={id:string;status:string;source?:string;createdAt?:string;transcript?:string;action?:string;reportKind?:string;summary?:string;error?:string;hasAudio?:boolean;expiresAt?:string};
function formatVoiceTime(value?:string){
  if(!value)return'—';
  const date=new Date(value);if(Number.isNaN(date.getTime()))return value;
  const mm=String(date.getMonth()+1).padStart(2,'0');const dd=String(date.getDate()).padStart(2,'0');
  const hh=String(date.getHours()).padStart(2,'0');const mi=String(date.getMinutes()).padStart(2,'0');
  return `${mm}-${dd} ${hh}:${mi}`;
}
function voiceActionLabel(item:VoiceHistoryItem){
  if(item.action==='edit_report')return item.reportKind==='weekly'?'改周报':item.reportKind==='monthly'?'改月报':'改今日复盘';
  if(item.action==='update')return'改任务';
  if(item.action==='clarify')return'待澄清';
  if(item.action==='create')return'建任务';
  if(item.status==='failed')return'失败';
  if(item.status==='processing'||item.status==='queued')return'处理中';
  return item.source==='text'?'文字指令':'语音指令';
}
function VoiceHistoryPage({onBack}:{onBack:()=>void}){
  const [items,setItems]=useState<VoiceHistoryItem[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [detail,setDetail]=useState<VoiceJob|null>(null);
  const [retentionDays,setRetentionDays]=useState(7);
  const [loading,setLoading]=useState(true);
  const [loadingDetail,setLoadingDetail]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;setLoading(true);setError('');
    apiFetch('/api/voice-jobs').then(async res=>{
      const data=await readApiJson<{items?:VoiceHistoryItem[];retentionDays?:number;message?:string}>(res);
      if(!res.ok)throw new Error(data.message||'读取指令记录失败');
      if(!active)return;
      const rows=Array.isArray(data.items)?data.items:[];
      setRetentionDays(Number(data.retentionDays)>0?Number(data.retentionDays):7);
      setItems(rows);if(rows[0])setSelectedId(rows[0].id);
    }).catch(e=>{if(active)setError(e instanceof Error?e.message:'读取指令记录失败')}).finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[]);
  useEffect(()=>{
    if(!selectedId){setDetail(null);return}
    let active=true;setLoadingDetail(true);
    apiFetch(`/api/voice-jobs/${selectedId}`).then(async res=>{
      const data=await readApiJson<VoiceJob&{message?:string;hasAudio?:boolean}>(res);
      if(!res.ok)throw new Error(data.message||'读取指令详情失败');
      if(active)setDetail(toSimplified(data));
    }).catch(e=>{if(active){setDetail(null);setError(e instanceof Error?e.message:'读取指令详情失败')}}).finally(()=>{if(active)setLoadingDetail(false)});
    return()=>{active=false};
  },[selectedId]);
  const selected=items.find(item=>item.id===selectedId)||null;
  return <div className="page archive-page voice-history-page">
    <div className="archive-top"><button type="button" className="archive-back" onClick={onBack}>‹ 返回</button><div><h1 className="page-title">语音指令记录</h1><p className="page-sub">默认保留最近 {retentionDays} 天，可在「设置 → 自动作业」调整清理任务</p></div></div>
    {error&&<div className="settings-error">{error}</div>}
    {loading?<div className="empty">正在加载指令记录…</div>:<div className="archive-list voice-history-list">{items.length?items.map(item=><button key={item.id} type="button" className={'archive-item'+(item.id===selectedId?' active':'')} onClick={()=>setSelectedId(item.id)}><b>{formatVoiceTime(item.createdAt)} · {voiceActionLabel(item)}</b><span>{item.transcript||item.summary||'（无转写文字）'}</span></button>):<div className="empty">近 7 天还没有语音或文字指令</div>}</div>}
    {selected&&<section className="voice-history-detail">
      <div className="voice-history-meta"><b>{formatVoiceTime(selected.createdAt)}</b><span>{selected.source==='text'?'文字':'语音'} · {voiceActionLabel(selected)}{selected.expiresAt?` · 保留至 ${formatVoiceTime(selected.expiresAt)}`:''}</span></div>
      {loadingDetail?<div className="empty">正在读取详情…</div>:detail?<>
        <div className="report-block"><b>指令原文</b><span>{detail.transcript||'（无转写文字）'}</span></div>
        {detail.command?.message&&<div className="report-block"><b>执行结果</b><span>{detail.command.message}</span></div>}
        {detail.error&&<div className="report-block risks"><b>失败原因</b><span>{detail.error}</span></div>}
        {(detail.tasks?.length||detail.task)&&<div className="report-block"><b>识别任务</b>{(detail.tasks?.length?detail.tasks:detail.task?[detail.task]:[]).map((task,index)=><span key={`${task.title}-${index}`}>{index+1}. {task.title} · {task.due||'今天'} · {task.priority||'中'}</span>)}</div>}
        {detail.command?.action==='update'&&(detail.command.updates||[]).length>0&&<div className="report-block"><b>任务更新</b>{detail.command.updates!.map((u,index)=><span key={`${u.targetTaskId}-${index}`}>目标 {u.targetTaskId.slice(0,8)}… · {Object.keys(u.changes||{}).join('、')||'字段更新'}</span>)}</div>}
        {selected.hasAudio&&<audio className="voice-history-audio" controls preload="none" src={`/api/voice-jobs/${selected.id}/audio`}/>}
      </>:<div className="empty">详情暂不可用</div>}
    </section>}
  </div>;
}
async function compressAvatar(file:File){
  const bitmap=await createImageBitmap(file);
  const size=256;const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('无法处理图片');
  const scale=Math.max(size/bitmap.width,size/bitmap.height);const w=bitmap.width*scale;const h=bitmap.height*scale;
  ctx.drawImage(bitmap,(size-w)/2,(size-h)/2,w,h);bitmap.close();
  return canvas.toDataURL('image/jpeg',0.88);
}

function PeriodArchivePage({kind,session,teamId,currentKey,onBack}:{kind:'weekly'|'monthly';session:Session|null;teamId:string;currentKey:string;onBack:()=>void}){
  const title=kind==='weekly'?'周报查询':'月报查询';
  const [selectedKey,setSelectedKey]=useState(currentKey);
  const [items,setItems]=useState<PeriodReportMeta[]>([]);
  const [report,setReport]=useState<PeriodReport|null>(null);
  const [loadingList,setLoadingList]=useState(true);
  const [loadingReport,setLoadingReport]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;setLoadingList(true);setError('');
    const load=async()=>{
      try{
        const rows=session&&teamId?await listPeriodReports(teamId,session.user.id,kind):await listFilePeriodReports(kind);
        if(!active)return;
        setItems(rows);
      }catch(e){if(active)setError(e instanceof Error?e.message:'读取历史列表失败')}
      finally{if(active)setLoadingList(false)}
    };
    void load();return()=>{active=false};
  },[kind,session,teamId]);
  useEffect(()=>{setSelectedKey(currentKey)},[kind,currentKey]);
  useEffect(()=>{
    let active=true;setLoadingReport(true);setError('');
    const load=async()=>{
      try{
        const data=session&&teamId?await loadPeriodReport(teamId,session.user.id,kind,selectedKey):await loadFilePeriodReport<PeriodReport>(kind,selectedKey);
        if(active)setReport(data?toSimplified(data):null);
      }catch(e){if(active){setReport(null);setError(e instanceof Error?e.message:'读取复盘失败')}}
      finally{if(active)setLoadingReport(false)}
    };
    void load();return()=>{active=false};
  },[kind,selectedKey,session,teamId]);
  const shift=(delta:number)=>setSelectedKey(prev=>kind==='weekly'?shiftIsoWeekKey(prev,delta):shiftMonthKey(prev,delta));
  const label=formatPeriodLabel(kind,selectedKey);
  return <div className="page archive-page">
    <div className="archive-top"><button type="button" className="archive-back" onClick={onBack}>‹ 返回</button><div><h1 className="page-title">{title}</h1><p className="page-sub">查看已保存的历史{kind==='weekly'?'周报':'月报'}</p></div></div>
    <div className="archive-nav"><button type="button" onClick={()=>shift(-1)}>上一{kind==='weekly'?'周':'月'}</button><div><b>{label}</b><span>{selectedKey===currentKey?'当前周期':selectedKey}</span></div><button type="button" onClick={()=>shift(1)}>下一{kind==='weekly'?'周':'月'}</button></div>
    {loadingList?<div className="empty">正在加载历史列表…</div>:<div className="archive-list">{items.length?items.map(item=><button key={item.periodKey} type="button" className={'archive-item'+(item.periodKey===selectedKey?' active':'')} onClick={()=>setSelectedKey(item.periodKey)}><b>{formatPeriodLabel(kind,item.periodKey)}</b><span>{item.headline||'已保存复盘'}</span></button>):<div className="empty">还没有保存过{kind==='weekly'?'周报':'月报'}</div>}</div>}
    {error&&<div className="settings-error">{error}</div>}
    {loadingReport?<section className="ai-report loading"><div className="ai-orb">···</div><div><b>正在读取复盘</b><p>{label}</p></div></section>:report?<section className="ai-report full archive-report"><div className="report-top"><div className="ai-orb">✦</div><div><small>{label}</small><h3>{report.headline}</h3></div></div><p className="report-summary">{report.summary}</p>{report.highlights?.length>0&&<div className="report-block"><b>亮点</b>{report.highlights.map(x=><span key={x}>✓ {x}</span>)}</div>}{report.risks?.length>0&&<div className="report-block risks"><b>需要关注</b>{report.risks.map(x=><span key={x}>! {x}</span>)}</div>}<div className="tomorrow-head"><b>{kind==='weekly'?'下周计划':'下月计划'}</b><span>{report.next?.length||0} 项</span></div>{(report.next||[]).map((x,i)=><div className="tomorrow" key={`${x.title}-${i}`}><i>{i+1}</i><div><b>{x.title}</b><p>{x.suggestedTime} · {x.reason}</p></div><em>{x.priority}</em></div>)}</section>:<div className="empty">该周期还没有保存的{kind==='weekly'?'周报':'月报'}</div>}
  </div>;
}

function CloudSettings({onClose,askConfirm}:{onClose:()=>void;askConfirm:(message:string,options?:{title?:string;confirmLabel?:string;cancelLabel?:string;danger?:boolean})=>Promise<boolean>}){
  const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [testing,setTesting]=useState(false);const [removing,setRemoving]=useState(false);
  const [configured,setConfigured]=useState(false);const [url,setUrl]=useState('');const [anonKey,setAnonKey]=useState('');const [masked,setMasked]=useState('');const [showKey,setShowKey]=useState(false);const [error,setError]=useState('');const [success,setSuccess]=useState('');
  const headers=async()=>{const token=(await supabase?.auth.getSession())?.data.session?.access_token;return{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}};
  useEffect(()=>{fetch('/api/settings/cloud',{cache:'no-store'}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.message||'读取云存储配置失败');setConfigured(Boolean(data.configured));setUrl(data.url||'');setMasked(data.maskedKey||'')}).catch(e=>setError(e.message)).finally(()=>setLoading(false))},[]);
  const request=async(path:string,options:RequestInit)=>{const response=await fetch(path,{...options,headers:await headers()});const data=await response.json();if(!response.ok)throw new Error(data.message||'操作失败');return data};
  const test=async()=>{setTesting(true);setError('');setSuccess('');try{const data=await request('/api/settings/cloud/test',{method:'POST',body:JSON.stringify({url,anonKey})});setSuccess(data.message||'连接成功')}catch(e){setError(e instanceof Error?e.message:'连接测试失败')}finally{setTesting(false)}};
  const save=async()=>{setSaving(true);setError('');setSuccess('');try{const data=await request('/api/settings/cloud',{method:'PUT',body:JSON.stringify({url,anonKey})});setConfigured(true);setMasked(data.maskedKey||'');setAnonKey('');setSuccess('保存成功，正在进入云端登录…');window.setTimeout(()=>window.location.reload(),700)}catch(e){setError(e instanceof Error?e.message:'保存失败')}finally{setSaving(false)}};
  const remove=async()=>{const ok=await askConfirm('移除后将切换到京东云服务器上的 SQLite 文件存储，Supabase 中已有数据不会被删除。确定继续吗？',{title:'移除云存储',confirmLabel:'确认移除',danger:true});if(!ok)return;setRemoving(true);setError('');try{await request('/api/settings/cloud',{method:'DELETE'});window.location.reload()}catch(e){setError(e instanceof Error?e.message:'移除失败');setRemoving(false)}};
  const missingNewConfig=!url.trim()||(!configured&&!anonKey.trim());
  return <div className="model-settings cloud-settings"><div className="settings-head"><div><small>数据与同步</small><h2>云存储设置</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></div>{loading?<div className="settings-loading">正在读取服务端配置…</div>:<><div className={'settings-status '+(configured?'ready':'')}><i>{configured?'✓':'☁'}</i><div><b>{configured?'云存储已配置':'尚未连接云存储'}</b><span>{configured?`当前公开密钥 ${masked}`:'连接后，任务、日报和团队进度可在所有设备同步'}</span></div></div><div className="cloud-provider"><i>S</i><div><b>Supabase</b><span>PostgreSQL 数据库 · 登录认证 · 实时同步</span></div></div><label>Supabase 项目地址</label><input className="input" type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" autoCapitalize="off" autoCorrect="off"/><p className="field-help">在 Supabase 控制台的 Project Settings → API 中复制 Project URL。</p><label>公开密钥（Anon / Publishable Key）</label><div className="key-field"><input className="input" type={showKey?'text':'password'} value={anonKey} onChange={e=>setAnonKey(e.target.value)} placeholder={configured?`已配置 ${masked}，留空则不修改`:'粘贴 anon 或 sb_publishable_ 开头的密钥'} autoCapitalize="off" autoCorrect="off"/><button type="button" onClick={()=>setShowKey(v=>!v)}>{showKey?'隐藏':'显示'}</button></div><p className="field-help">只能填写可公开的 anon / publishable key。请勿填写 service_role 或 secret key。</p>{success&&<div className="settings-success">✓ {success}</div>}{error&&<div className="settings-error">{error}</div>}<div className="settings-actions cloud-actions"><button type="button" disabled={testing||saving||missingNewConfig} onClick={test}>{testing?'正在测试…':'测试连接'}</button><button type="button" disabled={saving||testing||missingNewConfig} onClick={save}>{saving?'正在保存…':'保存并启用'}</button></div>{configured&&<button className="remove-cloud" type="button" disabled={removing} onClick={remove}>{removing?'正在移除…':'移除云存储配置'}</button>}<p className="cloud-note">配置保存在这台服务器的环境文件中，同一服务器上的 Android、iPhone 和电脑浏览器会自动使用它。</p></>}</div>;
}

function AppSettings({schedule,onScheduleSaved,onClose,onModelSaved}:{schedule:AutoSchedule;onScheduleSaved:(next:AutoSchedule)=>void;onClose:()=>void;onModelSaved:()=>void}){
  const [tab,setTab]=useState<'schedule'|'model'>('schedule');
  return <div className="model-settings app-settings"><div className="settings-head"><div><small>应用设置</small><h2>设置</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></div><div className="settings-tabs" role="tablist"><button type="button" role="tab" aria-selected={tab==='schedule'} className={tab==='schedule'?'active':''} onClick={()=>setTab('schedule')}>自动作业</button><button type="button" role="tab" aria-selected={tab==='model'} className={tab==='model'?'active':''} onClick={()=>setTab('model')}>大模型</button></div>{tab==='schedule'?<ScheduleSettings schedule={schedule} onSaved={onScheduleSaved} onClose={onClose}/>:<ModelSettings onClose={onClose} onSaved={onModelSaved}/>}</div>;
}

function cloneSchedule(schedule:AutoSchedule):AutoSchedule{
  return {
    daily:{...schedule.daily,times:[...schedule.daily.times]},
    weekly:{...schedule.weekly,times:[...schedule.weekly.times]},
    monthly:{...schedule.monthly,times:[...schedule.monthly.times]},
    voiceRetention:{...schedule.voiceRetention,times:[...schedule.voiceRetention.times]}
  };
}
function ScheduleSettings({schedule,onSaved,onClose}:{schedule:AutoSchedule;onSaved:(next:AutoSchedule)=>void;onClose:()=>void}){
  const [draft,setDraft]=useState<AutoSchedule>(()=>cloneSchedule(schedule));
  const [dailyInput,setDailyInput]=useState('12:00');
  const [weeklyInput,setWeeklyInput]=useState('20:00');
  const [monthlyInput,setMonthlyInput]=useState('08:00');
  const [retentionInput,setRetentionInput]=useState('03:00');
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{setDraft(cloneSchedule(schedule))},[schedule]);
  const addTime=(kind:'daily'|'weekly'|'monthly'|'voiceRetention',value:string)=>{
    const parsed=parseTimeHM(value);if(!parsed){setError('请输入合法时间，例如 08:00');return}
    const time=formatTimeHM(parsed.hour,parsed.minute);
    setDraft(prev=>{const times=normalizeTimes([...prev[kind].times,time]);if(times.length>6){setError('每种作业最多 6 个时间点');return prev}setError('');return {...prev,[kind]:{...prev[kind],times}}});
  };
  const removeTime=(kind:'daily'|'weekly'|'monthly'|'voiceRetention',time:TimeHM)=>{
    setDraft(prev=>{const times=prev[kind].times.filter(item=>item!==time);setError(times.length?'':'至少保留一个时间点，或关闭该作业');return {...prev,[kind]:{...prev[kind],times:times.length?times:prev[kind].times}}});
  };
  const save=async()=>{
    if(!draft.daily.times.length||!draft.weekly.times.length||!draft.monthly.times.length||!draft.voiceRetention.times.length){setError('每种作业至少需要一个时间点');return}
    if(!Number.isInteger(draft.voiceRetention.retentionDays)||draft.voiceRetention.retentionDays<1||draft.voiceRetention.retentionDays>90){setError('指令保留天数请填写 1–90');return}
    setSaving(true);setError('');
    try{
      const next=saveAutoSchedule(draft);
      const response=await fetch('/api/settings/jobs',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({voiceRetention:next.voiceRetention})});
      const data=await readApiJson<{message?:string;voiceRetention?:AutoSchedule['voiceRetention']}>(response);
      if(!response.ok)throw new Error(data.message||'后台作业同步失败');
      const synced=data.voiceRetention?saveAutoSchedule({...next,voiceRetention:data.voiceRetention}):next;
      onSaved(synced);
    }catch(e){setError(e instanceof Error?e.message:'保存失败')}
    finally{setSaving(false)}
  };
  const reset=()=>{setDraft(structuredClone(DEFAULT_AUTO_SCHEDULE));setError('')};
  return <div className="schedule-settings"><p className="field-help schedule-intro">复盘作业在打开首页时到点执行；语音指令清理由服务端后台作业执行，也可在设置中调整保留天数。</p>
    <section className="schedule-card"><div className="schedule-card-head"><div><b>今日复盘</b><span>每天到点自动更新</span></div><label className="schedule-switch"><input type="checkbox" checked={draft.daily.enabled} onChange={e=>setDraft(prev=>({...prev,daily:{...prev.daily,enabled:e.target.checked}}))}/><i/></label></div><div className="schedule-times">{draft.daily.times.map(time=><button key={time} type="button" className="schedule-chip" onClick={()=>removeTime('daily',time)}>{time} ×</button>)}</div><div className="schedule-add"><input className="input" type="time" value={dailyInput} onChange={e=>setDailyInput(e.target.value)}/><button type="button" onClick={()=>addTime('daily',dailyInput)}>添加</button></div></section>
    <section className="schedule-card"><div className="schedule-card-head"><div><b>本周周报</b><span>指定星期几到点生成</span></div><label className="schedule-switch"><input type="checkbox" checked={draft.weekly.enabled} onChange={e=>setDraft(prev=>({...prev,weekly:{...prev.weekly,enabled:e.target.checked}}))}/><i/></label></div><label className="schedule-inline-label">执行日</label><select className="input model-select" value={draft.weekly.weekday} onChange={e=>setDraft(prev=>({...prev,weekly:{...prev.weekly,weekday:Number(e.target.value)}}))}>{WEEKDAY_LABELS.map((label,index)=><option key={label} value={index}>{label}</option>)}</select><div className="schedule-times">{draft.weekly.times.map(time=><button key={time} type="button" className="schedule-chip" onClick={()=>removeTime('weekly',time)}>{time} ×</button>)}</div><div className="schedule-add"><input className="input" type="time" value={weeklyInput} onChange={e=>setWeeklyInput(e.target.value)}/><button type="button" onClick={()=>addTime('weekly',weeklyInput)}>添加</button></div></section>
    <section className="schedule-card"><div className="schedule-card-head"><div><b>本月月报</b><span>默认每月最后一天自动生成</span></div><label className="schedule-switch"><input type="checkbox" checked={draft.monthly.enabled} onChange={e=>setDraft(prev=>({...prev,monthly:{...prev.monthly,enabled:e.target.checked}}))}/><i/></label></div><label className="schedule-inline-label">执行日</label><select className="input model-select" value={draft.monthly.day==='last'?'last':String(draft.monthly.day)} onChange={e=>{const value=e.target.value;setDraft(prev=>({...prev,monthly:{...prev.monthly,day:value==='last'?'last':Number(value)}}))}}><option value="last">每月最后一天</option>{Array.from({length:28},(_,i)=>i+1).map(day=><option key={day} value={day}>每月 {day} 日</option>)}</select><div className="schedule-times">{draft.monthly.times.map(time=><button key={time} type="button" className="schedule-chip" onClick={()=>removeTime('monthly',time)}>{time} ×</button>)}</div><div className="schedule-add"><input className="input" type="time" value={monthlyInput} onChange={e=>setMonthlyInput(e.target.value)}/><button type="button" onClick={()=>addTime('monthly',monthlyInput)}>添加</button></div></section>
    <section className="schedule-card"><div className="schedule-card-head"><div><b>语音指令清理</b><span>服务端后台作业，按保留天数删除过期指令与录音</span></div><label className="schedule-switch"><input type="checkbox" checked={draft.voiceRetention.enabled} onChange={e=>setDraft(prev=>({...prev,voiceRetention:{...prev.voiceRetention,enabled:e.target.checked}}))}/><i/></label></div><label className="schedule-inline-label">保留天数</label><input className="input" type="number" min={1} max={90} value={draft.voiceRetention.retentionDays} onChange={e=>setDraft(prev=>({...prev,voiceRetention:{...prev.voiceRetention,retentionDays:Number(e.target.value)||7}}))}/><div className="schedule-times">{draft.voiceRetention.times.map(time=><button key={time} type="button" className="schedule-chip" onClick={()=>removeTime('voiceRetention',time)}>{time} ×</button>)}</div><div className="schedule-add"><input className="input" type="time" value={retentionInput} onChange={e=>setRetentionInput(e.target.value)}/><button type="button" onClick={()=>addTime('voiceRetention',retentionInput)}>添加</button></div></section>
    {error&&<div className="settings-error">{error}</div>}
    <div className="settings-actions schedule-actions"><button type="button" onClick={reset}>恢复默认</button><button type="button" disabled={saving} onClick={()=>void save()}>{saving?'正在保存…':'保存作业时间'}</button></div>
    <button type="button" className="schedule-close" onClick={onClose}>完成</button>
  </div>;
}

type ModelProviderId='bailian'|'deepseek'|'custom';
type ModelPreset={id:ModelProviderId;label:string;baseURL:string;models:string[]};
const DEFAULT_MODEL_PRESETS:ModelPreset[]=[
  {id:'bailian',label:'阿里云百炼',baseURL:'https://dashscope.aliyuncs.com/compatible-mode/v1',models:['qwen3.7-plus','qwen-plus','qwen3.6-flash','deepseek-v4-flash','deepseek-v4-pro','deepseek-v3.2']},
  {id:'deepseek',label:'DeepSeek',baseURL:'https://api.deepseek.com',models:['deepseek-v4-flash','deepseek-v4-pro']},
  {id:'custom',label:'自定义',baseURL:'',models:[]}
];
const TEXT_MODEL_LABELS:Record<string,string>={
  'qwen3.7-plus':'通义千问 3.7 Plus（推荐）',
  'qwen-plus':'通义千问 Plus',
  'qwen3.6-flash':'通义千问 3.6 Flash（经济）',
  'deepseek-v3.2':'DeepSeek V3.2',
  'deepseek-v4-pro':'DeepSeek V4 Pro',
  'deepseek-v4-flash':'DeepSeek V4 Flash（推荐）'
};

function ModelSettings({onClose,onSaved}:{onClose:()=>void;onSaved:()=>void}){
  const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [testing,setTesting]=useState(false);
  const [textConfigured,setTextConfigured]=useState(false);const [asrConfigured,setAsrConfigured]=useState(false);const [asrUsesTextKey,setAsrUsesTextKey]=useState(false);
  const [maskedTextKey,setMaskedTextKey]=useState('');const [maskedAsrKey,setMaskedAsrKey]=useState('');
  const [textApiKey,setTextApiKey]=useState('');const [asrApiKey,setAsrApiKey]=useState('');
  const [showTextKey,setShowTextKey]=useState(false);const [showAsrKey,setShowAsrKey]=useState(false);
  const [clearAsrKey,setClearAsrKey]=useState(false);
  const [provider,setProvider]=useState<ModelProviderId>('bailian');
  const [baseURL,setBaseURL]=useState(DEFAULT_MODEL_PRESETS[0].baseURL);
  const [presets,setPresets]=useState<ModelPreset[]>(DEFAULT_MODEL_PRESETS);
  const [textModel,setTextModel]=useState('qwen3.7-plus');const [customModel,setCustomModel]=useState('');
  const [useCustomModel,setUseCustomModel]=useState(false);
  const [asrModel,setAsrModel]=useState('qwen3-asr-flash');
  const [error,setError]=useState('');const [success,setSuccess]=useState('');
  const headers=async()=>{const token=(await supabase?.auth.getSession())?.data.session?.access_token;return{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}};
  const applyServerState=(data:any)=>{
    setTextConfigured(Boolean(data.textConfigured??data.configured));
    setAsrConfigured(Boolean(data.asrConfigured));
    setAsrUsesTextKey(Boolean(data.asrUsesTextKey));
    setMaskedTextKey(data.maskedTextKey||data.maskedKey||'');
    setMaskedAsrKey(data.maskedAsrKey||'');
    const nextPresets=Array.isArray(data.presets)&&data.presets.length?data.presets as ModelPreset[]:DEFAULT_MODEL_PRESETS;
    setPresets(nextPresets);
    const nextProvider=(['bailian','deepseek','custom'].includes(data.provider)?data.provider:'bailian') as ModelProviderId;
    setProvider(nextProvider);
    setBaseURL(String(data.baseURL||nextPresets.find(item=>item.id===nextProvider)?.baseURL||''));
    const model=String(data.textModel||'qwen3.7-plus');
    const presetModels=nextPresets.find(item=>item.id===nextProvider)?.models||[];
    if(presetModels.includes(model)){setUseCustomModel(false);setTextModel(model);setCustomModel('')}
    else{setUseCustomModel(true);setTextModel('__custom__');setCustomModel(model)}
    setAsrModel(data.asrModel||'qwen3-asr-flash');
  };
  useEffect(()=>{headers().then(h=>fetch('/api/settings/model',{headers:h,credentials:'include'})).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.message||'读取配置失败');applyServerState(data)}).catch(e=>setError(e.message)).finally(()=>setLoading(false))},[]);
  const currentPreset=presets.find(item=>item.id===provider)||DEFAULT_MODEL_PRESETS.find(item=>item.id===provider)||DEFAULT_MODEL_PRESETS[0];
  const resolvedTextModel=useCustomModel?customModel.trim():textModel;
  const payload=()=>({provider,baseURL:baseURL.trim(),textApiKey,asrApiKey:clearAsrKey?'':asrApiKey,clearAsrKey,textModel:resolvedTextModel,asrModel});
  const switchProvider=(next:ModelProviderId)=>{
    const preset=presets.find(item=>item.id===next)||DEFAULT_MODEL_PRESETS.find(item=>item.id===next)||DEFAULT_MODEL_PRESETS[0];
    setProvider(next);
    setBaseURL(preset.baseURL||'');
    setError('');setSuccess('');
    if(preset.models.length){setUseCustomModel(false);setTextModel(preset.models[0]);setCustomModel('')}
    else{setUseCustomModel(true);setTextModel('__custom__');setCustomModel('')}
  };
  const test=async()=>{
    setTesting(true);setError('');setSuccess('');
    try{
      if(!textConfigured&&!textApiKey.trim())throw new Error('请先填写任务理解 API Key');
      if(provider==='custom'&&!baseURL.trim())throw new Error('自定义提供商需要填写 Base URL');
      if(!resolvedTextModel)throw new Error('请填写模型名称');
      const response=await fetch('/api/settings/model/test',{method:'POST',headers:await headers(),credentials:'include',body:JSON.stringify(payload())});
      const data=await response.json();if(!response.ok)throw new Error(data.message||'连接测试失败');
      setSuccess(data.message||'连接成功');
    }catch(e){setError(e instanceof Error?e.message:'连接测试失败')}
    finally{setTesting(false)}
  };
  const save=async()=>{
    setSaving(true);setError('');setSuccess('');
    try{
      if(provider==='custom'&&!baseURL.trim())throw new Error('自定义提供商需要填写 Base URL');
      if(!resolvedTextModel)throw new Error('请填写模型名称');
      const response=await fetch('/api/settings/model',{method:'PUT',headers:await headers(),credentials:'include',body:JSON.stringify(payload())});
      const data=await response.json();if(!response.ok)throw new Error(data.message||'保存失败');
      applyServerState(data);
      setTextApiKey('');setAsrApiKey('');setClearAsrKey(false);setSuccess(data.message||'模型配置已保存并启用');onSaved();
    }catch(e){setError(e instanceof Error?e.message:'保存失败')}
    finally{setSaving(false)}
  };
  const configured=textConfigured;
  const providerName=currentPreset.label;
  const statusText=configured
    ?`${providerName} · 任务理解 ${maskedTextKey||'已配置'} · 语音识别 ${asrConfigured?maskedAsrKey:(asrUsesTextKey?'沿用任务理解密钥':'未单独配置')}`
    :'可接入阿里云百炼、DeepSeek 或任意 OpenAI 兼容接口';
  const canTest=Boolean(textConfigured||textApiKey.trim());
  const modelOptions=currentPreset.models;
  return <div className="model-settings-panel">{loading?<div className="settings-loading">正在读取服务端配置…</div>:<><div className={'settings-status '+(configured?'ready':'')}><i>{configured?'✓':'!'}</i><div><b>{configured?'模型服务已配置':'尚未配置模型服务'}</b><span>{statusText}</span></div></div>
    <label>任务理解提供商</label>
    <select className="input model-select" value={provider} onChange={e=>switchProvider(e.target.value as ModelProviderId)}>
      {presets.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
    </select>
    <label>Base URL</label>
    <input className="input" value={baseURL} onChange={e=>setBaseURL(e.target.value)} placeholder={provider==='custom'?'https://api.example.com/v1':currentPreset.baseURL} autoCapitalize="off" autoCorrect="off"/>
    <p className="field-help">任务理解走 OpenAI 兼容接口（/chat/completions）。切换提供商会自动填入推荐地址，也可手动修改。</p>
    <label>任务理解 API Key</label>
    <div className="key-field"><input className="input" type={showTextKey?'text':'password'} value={textApiKey} onChange={e=>setTextApiKey(e.target.value)} placeholder={textConfigured?`已配置 ${maskedTextKey}，留空则不修改`:'sk-xxxxxxxxxxxxxxxx'}/><button type="button" onClick={()=>setShowTextKey(v=>!v)}>{showTextKey?'隐藏':'显示'}</button></div>
    <label>任务理解与复盘模型</label>
    <select className="input model-select" value={useCustomModel?'__custom__':textModel} onChange={e=>{const value=e.target.value;if(value==='__custom__'){setUseCustomModel(true);setTextModel('__custom__')}else{setUseCustomModel(false);setTextModel(value);setCustomModel('')}}}>
      {modelOptions.map(model=><option key={model} value={model}>{TEXT_MODEL_LABELS[model]||model}</option>)}
      <option value="__custom__">自定义模型 ID…</option>
    </select>
    {useCustomModel&&<input className="input" value={customModel} onChange={e=>setCustomModel(e.target.value)} placeholder="例如 deepseek-v4-flash / gpt-4o-mini" autoCapitalize="off" autoCorrect="off"/>}
    <p className="field-help">{provider==='deepseek'?'DeepSeek 官方可选 deepseek-v4-flash / deepseek-v4-pro。':provider==='bailian'?'百炼可选千问，也可选 DeepSeek V4 Flash / Pro（走百炼兼容接口与百炼 Key）。':'可手填任意 OpenAI 兼容模型 ID。'}</p>
    <label>语音识别 API Key（百炼 ASR）</label>
    <div className="key-field"><input className="input" type={showAsrKey?'text':'password'} value={clearAsrKey?'':asrApiKey} onChange={e=>{setClearAsrKey(false);setAsrApiKey(e.target.value)}} placeholder={clearAsrKey?'将清除独立密钥':asrConfigured?`已配置 ${maskedAsrKey}，留空则不修改`:provider==='bailian'?'可选；留空则沿用任务理解密钥':'非百炼时请单独填写百炼 ASR 密钥'}/><button type="button" onClick={()=>setShowAsrKey(v=>!v)}>{showAsrKey?'隐藏':'显示'}</button></div>
    <p className="field-help">语音转写始终走阿里云百炼 ASR。使用 DeepSeek/自定义文本模型时，请单独填写百炼语音密钥。{asrConfigured&&<button type="button" className="linkish" onClick={()=>{setClearAsrKey(true);setAsrApiKey('')}}>清除独立语音密钥</button>}</p>
    <label>语音识别模型</label>
    <select className="input model-select" value={asrModel} onChange={e=>setAsrModel(e.target.value)}><option value="qwen3-asr-flash">千问 3 ASR Flash（推荐）</option><option value="qwen3-asr-flash-2026-02-10">千问 3 ASR Flash 2026-02-10</option></select>
    {success&&<div className="settings-success">✓ {success}</div>}
    {error&&<div className="settings-error">{error}</div>}
    <div className="settings-actions cloud-actions"><button type="button" disabled={testing||saving||!canTest} onClick={()=>void test()}>{testing?'正在测试…':'测试连接'}</button><button type="button" disabled={saving||testing||(!configured&&!textApiKey.trim())} onClick={()=>void save()}>{saving?'正在保存…':'保存并启用'}</button></div>
    <button type="button" className="schedule-close" onClick={onClose}>取消</button>
  </>}</div>;
}

function LoginPage({demo=false,mode='cloud',onLocalAuth}:{demo?:boolean;mode?:'cloud'|'local';onLocalAuth?:(user:LocalUser)=>void|Promise<void>}){
  const [authTab,setAuthTab]=useState<'login'|'register'>('login');
  const [email,setEmail]=useState(demo?'demo@flowmate.cn':'');
  const [password,setPassword]=useState('');
  const [name,setName]=useState('');
  const [sending,setSending]=useState(false);
  const [sent,setSent]=useState(false);
  const [error,setError]=useState('');
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();
    if(!email.trim())return;
    setSending(true);setError('');
    try{
      if(mode==='local'){
        if(password.length<6)throw new Error('密码至少 6 位');
        const user=authTab==='register'
          ? await registerLocalUser({email:email.trim(),password,name:name.trim()||undefined})
          : await loginLocalUser({email:email.trim(),password});
        await onLocalAuth?.(user);
        return;
      }
      if(demo)await new Promise(resolve=>setTimeout(resolve,700));
      else await sendMagicLink(email.trim());
      setSent(true);
    }catch(err){setError(err instanceof Error?err.message:(mode==='local'?'登录失败':'登录邮件发送失败'))}
    finally{setSending(false)}
  };
  if(mode==='local'){
    return <div className="viewport"><main className="app auth-shell"><section className="login-card">
      <div className="brand-mark">✓</div>
      <span className="login-eyebrow">FLOWMATE LOCAL</span>
      <h1>{authTab==='register'?'注册本机账号':'登录工作助手'}</h1>
      <p>{authTab==='register'?'用邮箱和密码创建账号，任务与复盘仅对本账号可见。':'未配置云端时，请使用本机账号登录后继续使用。'}</p>
      <div className="auth-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={authTab==='login'} className={authTab==='login'?'active':''} onClick={()=>{setAuthTab('login');setError('')}}>登录</button>
        <button type="button" role="tab" aria-selected={authTab==='register'} className={authTab==='register'?'active':''} onClick={()=>{setAuthTab('register');setError('')}}>注册</button>
      </div>
      <form onSubmit={submit}>
        {authTab==='register'&&<><label>昵称（可选）</label><input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="怎么称呼你" autoComplete="nickname"/></>}
        <label>邮箱</label>
        <input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@company.com" autoComplete="email" required/>
        <label>密码</label>
        <input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="至少 6 位" autoComplete={authTab==='register'?'new-password':'current-password'} required minLength={6}/>
        <button className="primary" disabled={sending}>{sending?(authTab==='register'?'正在注册…':'正在登录…'):(authTab==='register'?'注册并进入':'登录')}</button>
        {error&&<div className="login-error">{error}</div>}
      </form>
      <div className="cloud-benefits"><span>◇ 本机数据隔离</span><span>↻ SQLite 持久化</span><span>◎ 会话 Cookie</span></div>
    </section></main></div>;
  }
  return <div className="viewport"><main className="app auth-shell"><section className="login-card">{demo&&<div className="demo-ribbon">交互演示 · 不会发送邮件</div>}<div className="brand-mark">✓</div><span className="login-eyebrow">FLOWMATE CLOUD</span><h1>{sent?'检查你的邮箱':'登录工作助手'}</h1><p>{sent?`登录链接已发送至 ${email}，点击邮件中的链接即可进入云端工作区。`:'任务、日报和团队进度会安全同步到所有设备。'}</p>{!sent?<form onSubmit={submit}><label>工作邮箱</label><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@company.com" autoComplete="email" required/><button className="primary" disabled={sending}>{sending?'正在发送…':'发送登录链接'}</button>{error&&<div className="login-error">{error}</div>}</form>:<><div className="mail-preview"><i>✉</i><div><b>FlowMate 登录邮件</b><span>点击邮件内的“登录 FlowMate”按钮，浏览器会自动返回应用。</span></div></div><button className="secondary-login" onClick={()=>setSent(false)}>更换邮箱</button></>}<div className="cloud-benefits"><span>☁ 多端实时同步</span><span>◇ 团队数据隔离</span><span>↻ 自动云端备份</span></div>{demo&&<a className="back-app" href="/">← 返回工作助手</a>}</section></main></div>;
}

function fromCloud(row:CloudTask):Task{return normalizeTask(toSimplified({id:row.id,title:row.title,assignee:row.assignee,due:row.due_label,status:row.status,priority:row.priority,progress:row.progress,estimatedMinutes:row.estimated_minutes,createdAt:row.created_at,startedAt:row.started_at||undefined,completedAt:row.completed_at||undefined,aiStatus:row.due_label==='AI后台处理中'?'pending':row.due_label==='识别失败'?'failed':undefined}))}
function toCloud(task:Task,teamId:string,userId:string):CloudTask{return{id:task.id,team_id:teamId,title:task.title,assignee:task.assignee,due_label:task.due,status:task.status,priority:task.priority,progress:task.progress,estimated_minutes:task.estimatedMinutes,created_by:userId,created_at:task.createdAt||new Date().toISOString(),started_at:task.startedAt||null,completed_at:task.completedAt||null}}
