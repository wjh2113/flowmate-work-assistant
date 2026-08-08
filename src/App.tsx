import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { cloudConfigured, deleteTask, getSession, getWorkspace, listTasks, loadDailyReport, saveDailyReport, sendMagicLink, supabase, updateTask, upsertTask, type CloudTask } from './cloud';
import { deleteFileTask, listFileTasks, loadFileDailyReport, patchFileTask, saveFileDailyReport, saveFileTask } from './localStore';
import GuidePage from './GuidePage';
import { toSimplified } from './chinese';

type Tab = 'home' | 'tasks' | 'team' | 'mine';
type Status = 'todo' | 'doing' | 'done';
type Priority = '高' | '中' | '低';
type Task = { id:string; title:string; assignee:string; due:string; status:Status; priority:Priority; progress:number; estimatedMinutes:number; createdAt?:string; startedAt?:string; completedAt?:string; aiStatus?:'pending'|'failed' };
type ParsedTask = { title:string; assignee:string; due:string; priority:Priority; confidence:number; estimatedMinutes?:number };
type VoiceTaskChanges = Partial<Pick<Task,'title'|'assignee'|'due'|'priority'|'status'|'estimatedMinutes'>>;
type VoiceCommand = { action:'create'|'update'|'clarify'; targetTaskId:string|null; changes:VoiceTaskChanges; tasks?:ParsedTask[]; task?:ParsedTask; message?:string; confidence:number };
type DailyReport = { headline:string; summary:string; completed:string[]; risks:string[]; tomorrow:{title:string;reason:string;priority:Priority;suggestedTime:string}[] };
type VoiceJob = { id:string; status:'queued'|'processing'|'completed'|'failed'; transcript?:string; tasks?:ParsedTask[]; task?:ParsedTask|null; command?:VoiceCommand|null; error?:string };

const defaultEstimate=(priority:Priority)=>priority==='高'?120:priority==='低'?30:60;
const normalizeTask=(task:Task):Task=>({...task,estimatedMinutes:Number(task.estimatedMinutes)>0?Number(task.estimatedMinutes):defaultEstimate(task.priority),startedAt:task.startedAt||((task.status==='doing'||task.status==='done')?task.createdAt:undefined)});
const transitionTaskStatus=(task:Task,status:Status):Task=>{if(task.status===status)return task;const now=new Date().toISOString();if(status==='doing')return{...task,status,progress:task.progress>0&&task.progress<100?task.progress:50,startedAt:task.startedAt||now,completedAt:undefined};if(status==='done')return{...task,status,progress:100,startedAt:task.startedAt||now,completedAt:now};return{...task,status,progress:0,startedAt:undefined,completedAt:undefined}};

export default function App(){
  const loginDemo=new URLSearchParams(window.location.search).has('login-demo');
  const showGuide=new URLSearchParams(window.location.search).has('guide');
  const [tab,setTab]=useState<Tab>('home');
  const [tasks,setTasks]=useState<Task[]>([]);
  const [modal,setModal]=useState<'voice'|'add'|'settings'|'cloud'|null>(null);
  const [title,setTitle]=useState(''); const [assignee,setAssignee]=useState('我'); const [estimate,setEstimate]=useState(60);
  const [transcript,setTranscript]=useState(''); const [recording,setRecording]=useState(false); const [processing,setProcessing]=useState(false);
  const [voiceTip,setVoiceTip]=useState('点击录音，说出任务内容'); const [parsedTask,setParsedTask]=useState<ParsedTask|null>(null);
  const [installEvent,setInstallEvent]=useState<any>(null); const [aiReady,setAiReady]=useState<boolean|null>(null);
  const [report,setReport]=useState<DailyReport|null>(null); const [reportLoading,setReportLoading]=useState(false); const [reportError,setReportError]=useState('');
  const [toast,setToast]=useState('');
  const [session,setSession]=useState<Session|null>(null); const [authLoading,setAuthLoading]=useState(cloudConfigured);
  const [teamId,setTeamId]=useState(''); const [teamName,setTeamName]=useState('京东云工作区'); const [syncing,setSyncing]=useState(false);
  const [clock,setClock]=useState(()=>Date.now());
  const recorder=useRef<MediaRecorder|null>(null); const stream=useRef<MediaStream|null>(null); const chunks=useRef<Blob[]>([]);
  const browserRecognition=useRef<SpeechRecognition|null>(null); const localTranscript=useRef(''); const autoReport=useRef(false);
  const voicePolling=useRef(new Set<string>()); const voicePollTimers=useRef(new Map<string,number>());
  const tasksRef=useRef(tasks);
  const cloudContext=useRef<{session:Session|null;teamId:string}>({session:null,teamId:''});
  const dateKey=new Date().toISOString().slice(0,10);
  const displayName=String(session?.user.user_metadata?.name||session?.user.email?.split('@')[0]||'我');
  const avatarText=displayName.slice(0,1).toUpperCase();

  useEffect(()=>{tasksRef.current=tasks},[tasks]);
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),30_000);return()=>window.clearInterval(timer)},[]);
  useEffect(()=>{cloudContext.current={session,teamId}},[session,teamId]);
  useEffect(()=>{const h=(e:Event)=>{e.preventDefault();setInstallEvent(e)};window.addEventListener('beforeinstallprompt',h);return()=>window.removeEventListener('beforeinstallprompt',h)},[]);
  useEffect(()=>{fetch('/api/health').then(r=>r.json()).then(data=>setAiReady(Boolean(data.ai))).catch(()=>setAiReady(false))},[]);
  useEffect(()=>{
    if(cloudConfigured)return;
    let active=true;let first=true;
    const refresh=async()=>{try{if(first)setSyncing(true);const [storedTasks,storedReport]=await Promise.all([listFileTasks(),loadFileDailyReport<DailyReport>(dateKey)]);if(active){setTasks(toSimplified(storedTasks).map(normalizeTask));setReport(storedReport?toSimplified(storedReport):null)}}catch(error){if(active)setReportError(error instanceof Error?`SQLite 读取失败：${error.message}`:'SQLite 读取失败')}finally{if(active&&first){first=false;setSyncing(false)}}};
    void refresh();const timer=window.setInterval(refresh,5000);
    return()=>{active=false;window.clearInterval(timer)};
  },[dateKey]);
  useEffect(()=>{
    if(!supabase){setAuthLoading(false);return}
    getSession().then(setSession).finally(()=>setAuthLoading(false));
    const {data}=supabase.auth.onAuthStateChange((_event,next)=>{setSession(next);setAuthLoading(false)});
    return()=>data.subscription.unsubscribe();
  },[]);
  useEffect(()=>{
    if(!session||!supabase)return;
    const client=supabase;
    let active=true;let channel:any;let currentTeamId='';
    const refresh=async()=>{if(!currentTeamId)return;try{setSyncing(true);const rows=await listTasks(currentTeamId);if(active)setTasks(rows.map(fromCloud))}finally{if(active)setSyncing(false)}};
    getWorkspace().then(async workspace=>{
      if(!active)return;currentTeamId=workspace.teamId;setTeamId(workspace.teamId);setTeamName(workspace.teamName);
      const rows=await listTasks(workspace.teamId);if(active)setTasks(rows.map(fromCloud));
      const cloudReport=await loadDailyReport(workspace.teamId,session.user.id,dateKey);if(active&&cloudReport)setReport(cloudReport as DailyReport);
      channel=client.channel(`tasks:${workspace.teamId}`).on('postgres_changes',{event:'*',schema:'public',table:'tasks',filter:`team_id=eq.${workspace.teamId}`},()=>refresh()).subscribe();
    }).catch(error=>alert(`云端初始化失败：${error.message}`)).finally(()=>active&&setSyncing(false));
    return()=>{active=false;if(channel)client.removeChannel(channel)};
  },[session,dateKey]);
  useEffect(()=>{if(aiReady&&tab==='home'&&tasks.length>0&&!report&&!autoReport.current){autoReport.current=true;const timer=setTimeout(()=>generateReport(),800);return()=>clearTimeout(timer)}},[aiReady,tab,tasks.length,report]);

  const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(''),2200)};
  const goTab=(next:Tab)=>{setTab(next);window.requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'smooth'}))};

  const pendingVoiceIds=()=>{try{return JSON.parse(localStorage.getItem('flowmate.voiceJobs')||'[]') as string[]}catch{return[]}};
  const rememberVoiceJob=(id:string)=>localStorage.setItem('flowmate.voiceJobs',JSON.stringify([...new Set([...pendingVoiceIds(),id])]));
  const forgetVoiceJob=(id:string)=>localStorage.setItem('flowmate.voiceJobs',JSON.stringify(pendingVoiceIds().filter(item=>item!==id)));
  const finishVoicePolling=(id:string)=>{const timer=voicePollTimers.current.get(id);if(timer)window.clearTimeout(timer);voicePollTimers.current.delete(id);voicePolling.current.delete(id);forgetVoiceJob(id)};
  const syncVoiceTask=(task:Task)=>{const current=cloudContext.current;if(current.session&&current.teamId)upsertTask(toCloud(task,current.teamId,current.session.user.id)).catch(error=>notify(`语音任务云端同步失败：${error.message}`));else saveFileTask(task).catch(error=>notify(`SQLite 保存失败：${error.message}`))};
  const completeVoiceJob=(job:VoiceJob)=>{
    const command=toSimplified(job.command);
    if(command?.action==='update'){
      const target=tasksRef.current.find(item=>item.id===command.targetTaskId);
      if(!target){setTasks(items=>items.filter(item=>item.id!==job.id));finishVoicePolling(job.id);notify('没有找到要修改的任务，请说出完整任务名称');return}
      const {status,...fields}=command.changes||{};let updated:Task={...target,...fields};if(status)updated=transitionTaskStatus(updated,status);
      setTasks(items=>items.filter(item=>item.id!==job.id).map(item=>item.id===updated.id?updated:item));syncVoiceTask(updated);setAiReady(true);finishVoicePolling(job.id);notify(command.message||`已修改“${updated.title}”`);return
    }
    if(command?.action==='clarify'){
      setTasks(items=>items.filter(item=>item.id!==job.id));finishVoicePolling(job.id);notify(command.message||'请说出要修改的任务名称和内容');return
    }
    const rawTasks=job.tasks?.length?job.tasks:command?.tasks?.length?command.tasks:job.task||command?.task?[job.task||command?.task as ParsedTask]:[];
    const parsedTasks=toSimplified(rawTasks).filter((item):item is ParsedTask=>Boolean(item?.title));if(!parsedTasks.length){setTasks(items=>items.filter(item=>item.id!==job.id));finishVoicePolling(job.id);notify('没有识别到可执行的任务指令');return}
    const placeholder=tasksRef.current.find(item=>item.id===job.id);const now=new Date().toISOString();const created=parsedTasks.slice(0,10).map((parsed,index):Task=>({id:index===0?job.id:`${job.id}-${index+1}`,title:parsed.title||job.transcript||'语音任务',assignee:parsed.assignee||'我',due:parsed.due||'今天',status:'todo',priority:parsed.priority||'中',progress:0,estimatedMinutes:parsed.estimatedMinutes||defaultEstimate(parsed.priority||'中'),createdAt:index===0?(placeholder?.createdAt||now):now}));
    setTasks(items=>[...created,...items.filter(item=>item.id!==job.id)]);created.forEach(syncVoiceTask);setAiReady(true);finishVoicePolling(job.id);if(created.length>1)goTab('tasks');notify(created.length>1?`已拆解 ${created.length} 项，以下为全部任务`:'语音任务已创建');
  };
  const failVoiceJob=(job:VoiceJob)=>{
    const current=tasksRef.current.find(item=>item.id===job.id);if(current)saveFileTask({...current,aiStatus:'failed',due:'识别失败'}).catch(()=>{});
    setTasks(items=>items.map(item=>item.id===job.id?{...item,aiStatus:'failed',due:'识别失败'}:item));
    finishVoicePolling(job.id);notify(job.error||'语音识别失败，点击任务可重试');
  };
  const pollVoiceJob=(id:string)=>{
    if(voicePolling.current.has(id))return;voicePolling.current.add(id);
    const check=async()=>{
      try{
        const response=await fetch(`/api/voice-jobs/${id}`);const job=await response.json() as VoiceJob&{message?:string};
        if(response.status===404){failVoiceJob({id,status:'failed',error:job.message||'语音任务已失效'});return}
        if(!response.ok)throw new Error(job.message||'查询识别进度失败');
        if(job.status==='completed'){completeVoiceJob(job);return}
        if(job.status==='failed'){failVoiceJob(job);return}
        const timer=window.setTimeout(check,1200);voicePollTimers.current.set(id,timer);
      }catch{const timer=window.setTimeout(check,3000);voicePollTimers.current.set(id,timer)}
    };
    void check();
  };
  const retryVoiceJob=async(id:string)=>{
    try{
      const response=await fetch(`/api/voice-jobs/${id}/retry`,{method:'POST'});const job=await response.json();if(!response.ok)throw new Error(job.message||'重试失败');
      setTasks(items=>items.map(item=>item.id===id?{...item,aiStatus:'pending',due:'AI后台处理中'}:item));rememberVoiceJob(id);pollVoiceJob(id);notify('已重新提交后台识别');
    }catch(error){notify(error instanceof Error?error.message:'语音任务重试失败')}
  };
  useEffect(()=>{pendingVoiceIds().forEach(pollVoiceJob);return()=>{voicePollTimers.current.forEach(timer=>window.clearTimeout(timer));voicePollTimers.current.clear();voicePolling.current.clear()}},[]);

  const stats=useMemo(()=>({mine:tasks.filter(t=>t.assignee==='我').length,done:tasks.filter(t=>t.assignee==='我'&&t.status==='done').length,follow:tasks.filter(t=>t.assignee!=='我'&&t.status!=='done').length}),[tasks]);
  const addTask=(text=title,parsed?:ParsedTask|null)=>{
    if(!text.trim())return;const p=parsed||null;const priority=p?.priority||'中';const task:Task=toSimplified({id:crypto.randomUUID(),title:p?.title||text.trim(),assignee:p?.assignee||assignee,due:p?.due||'今天',status:'todo',priority,progress:0,estimatedMinutes:p?.estimatedMinutes||estimate||defaultEstimate(priority),createdAt:new Date().toISOString()});
    setTasks(v=>[task,...v]);setTitle('');setEstimate(60);setTranscript('');setParsedTask(null);setModal(null);notify('任务已创建');
    setSyncing(true);(session&&teamId?upsertTask(toCloud(task,teamId,session.user.id)):saveFileTask(task)).catch(error=>alert(`任务保存失败：${error.message}`)).finally(()=>setSyncing(false));
  };
  const createTasksFromText=async()=>{
    const text=transcript.trim();if(!text)return;setProcessing(true);setVoiceTip('AI 正在拆解任务…');
    try{const response=await fetch('/api/parse-task-text',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript:text})});const data=await response.json();if(!response.ok)throw new Error(data.message||'任务拆解失败');const parsed=toSimplified<ParsedTask[]>(Array.isArray(data.tasks)?data.tasks:[]).filter(item=>item?.title).slice(0,10);if(!parsed.length)throw new Error('没有识别到可执行任务');const now=new Date().toISOString();const created:Task[]=parsed.map(item=>({id:crypto.randomUUID(),title:item.title,assignee:item.assignee||'我',due:item.due||'今天',status:'todo',priority:item.priority||'中',progress:0,estimatedMinutes:item.estimatedMinutes||defaultEstimate(item.priority||'中'),createdAt:now}));await Promise.all(created.map(task=>session&&teamId?upsertTask(toCloud(task,teamId,session.user.id)):saveFileTask(task)));setTasks(items=>[...created,...items]);setTranscript('');setParsedTask(null);setModal(null);setAiReady(true);if(created.length>1)goTab('tasks');notify(created.length>1?`已拆解 ${created.length} 项，以下为全部任务`:'任务已创建')}
    catch(error){setVoiceTip(error instanceof Error?error.message:'AI 任务拆解失败')}
    finally{setProcessing(false)}
  };
  const cycle=(id:string)=>{
    const current=tasks.find(t=>t.id===id);if(!current)return;const next:Status=current.status==='todo'?'doing':current.status==='doing'?'done':'todo';const now=new Date().toISOString();const changes={status:next,progress:next==='doing'?50:next==='done'?100:0,startedAt:next==='doing'?(current.startedAt||now):next==='todo'?undefined:current.startedAt,completedAt:next==='done'?now:undefined};
    if(current.aiStatus==='pending'){notify('AI 正在后台识别这条语音任务');return}
    if(current.aiStatus==='failed'){void retryVoiceJob(id);return}
    setTasks(v=>v.map(t=>t.id===id?{...t,...changes}:t));
    notify(next==='done'?'任务已完成':next==='doing'?'已开始处理':'已移回待办');
    if(session&&teamId)updateTask(id,{status:changes.status,progress:changes.progress,started_at:changes.startedAt||null,completed_at:changes.completedAt||null}).catch(error=>alert(`云端更新失败：${error.message}`));else patchFileTask(id,{status:changes.status,progress:changes.progress,startedAt:changes.startedAt||null,completedAt:changes.completedAt||null}).catch(error=>alert(`SQLite 更新失败：${error.message}`));
  };
  const removeTask=(id:string,title:string)=>{
    const current=tasks.find(task=>task.id===id);if(!current||!window.confirm(`确定删除“${title}”吗？\n删除后无法撤销。`))return;
    setTasks(items=>items.filter(task=>task.id!==id));finishVoicePolling(id);if(current.aiStatus)fetch(`/api/voice-jobs/${id}`,{method:'DELETE'}).catch(()=>{});notify('任务已删除');
    (session&&teamId?deleteTask(id):deleteFileTask(id)).catch(error=>{setTasks(items=>items.some(task=>task.id===id)?items:[current,...items]);alert(`删除失败，任务已恢复：${error.message}`)});
  };

  const beginRecording=async()=>{
    if(!window.isSecureContext){setVoiceTip('当前不是安全连接。请使用 localhost 或 HTTPS，浏览器才会开放麦克风。');return}
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){setVoiceTip('当前浏览器不支持录音，请使用最新版 Chrome、Edge 或 Safari。');return}
    try{
      stream.current=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      chunks.current=[];localTranscript.current='';setTranscript('');setParsedTask(null);
      const preferred=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(x=>MediaRecorder.isTypeSupported(x));
      const rec=new MediaRecorder(stream.current,preferred?{mimeType:preferred}:undefined);recorder.current=rec;
      rec.ondataavailable=e=>{if(e.data.size)chunks.current.push(e.data)};
      rec.onstop=()=>uploadRecording(new Blob(chunks.current,{type:rec.mimeType||'audio/webm'}));
      const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(Speech){const r=new Speech();browserRecognition.current=r;r.lang='zh-CN';r.continuous=true;r.interimResults=true;r.onresult=e=>{let text='';for(let i=0;i<e.results.length;i++)text+=e.results[i][0].transcript;text=toSimplified(text);localTranscript.current=text;setTranscript(text)};try{r.start()}catch{}}
      rec.start(500);setRecording(true);setVoiceTip('可以连续说多个任务，AI 会自动逐项拆解…');
    }catch{setVoiceTip('麦克风权限未开启。请点击地址栏左侧图标，允许本站使用麦克风。')}
  };
  const stopRecording=()=>{if(!recording)return;setRecording(false);setProcessing(true);setVoiceTip('正在安全保存录音…');try{browserRecognition.current?.stop()}catch{}recorder.current?.stop()};
  const uploadRecording=async(blob:Blob)=>{
    stream.current?.getTracks().forEach(t=>t.stop());
    try{
      const ext=blob.type.includes('mp4')?'m4a':'webm';const form=new FormData();form.append('audio',blob,`task.${ext}`);form.append('tasks',JSON.stringify(tasksRef.current.map(({id,title,assignee,due,status,priority,estimatedMinutes})=>({id,title,assignee,due,status,priority,estimatedMinutes}))));
      const res=await fetch('/api/voice-jobs',{method:'POST',body:form});const job=await res.json() as VoiceJob&{message?:string};
      if(!res.ok)throw new Error(job.message||'录音保存失败');
      const browserText=toSimplified(localTranscript.current.trim());const placeholder:Task={id:job.id,title:browserText||'语音任务识别中…',assignee:'我',due:'AI后台处理中',status:'todo',priority:'中',progress:0,estimatedMinutes:60,createdAt:new Date().toISOString(),aiStatus:'pending'};
      setTasks(items=>[placeholder,...items.filter(item=>item.id!==job.id)]);if(!session)saveFileTask(placeholder).catch(()=>{});rememberVoiceJob(job.id);pollVoiceJob(job.id);
      setTranscript('');setParsedTask(null);setModal(null);notify('录音已保存，AI 将在后台整理');
    }catch(error){
      if(localTranscript.current){setTranscript(localTranscript.current);setVoiceTip(`录音上传失败，已保留浏览器识别结果：${error instanceof Error?error.message:'未知错误'}`)}
      else setVoiceTip(error instanceof Error?error.message:'录音保存失败，请重试');
    }finally{setProcessing(false)}
  };

  const generateReport=async()=>{
    setReportLoading(true);setReportError('');
    try{const res=await fetch('/api/daily-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tasks,date:dateKey,user:displayName})});const raw=await res.json();if(!res.ok)throw new Error(raw.message||'生成失败');const data=toSimplified<DailyReport>(raw);setReport(data);if(session&&teamId)await saveDailyReport(teamId,session.user.id,dateKey,data);else await saveFileDailyReport(dateKey,data);setAiReady(true)}
    catch(error){setReportError(error instanceof Error?error.message:'AI 日报生成失败')}
    finally{setReportLoading(false)}
  };
  const addTomorrow=()=>{if(!report)return;const planned:Task[]=report.tomorrow.map(x=>({id:crypto.randomUUID(),title:x.title,assignee:'我',due:`明天 ${x.suggestedTime}`,status:'todo',priority:x.priority,progress:0,estimatedMinutes:defaultEstimate(x.priority),createdAt:new Date().toISOString()}));setTasks(v=>[...planned,...v]);Promise.all(planned.map(t=>session&&teamId?upsertTask(toCloud(t,teamId,session.user.id)):saveFileTask(t))).catch(error=>alert(`部分计划未保存：${error.message}`));alert('已将明日计划加入“我的任务”')};
  const install=async()=>{if(installEvent){installEvent.prompt();await installEvent.userChoice;setInstallEvent(null)}else alert('iPhone：Safari 分享 → 添加到主屏幕。\nAndroid：浏览器菜单 → 安装应用。')};

  if(showGuide)return <GuidePage/>;
  if(loginDemo)return <LoginPage demo/>;
  if(authLoading)return <div className="viewport"><main className="app auth-shell"><div className="cloud-loader"><div className="ai-orb">✦</div><b>正在连接云端工作区…</b></div></main></div>;
  if(cloudConfigured&&!session)return <LoginPage/>;

  return <div className="viewport"><main className="app">
    {tab==='home'&&<div className="page home-page">
      <header><div><h1>{displayName==='我'?'你好':`你好，${displayName}`}</h1><p>{teamName} · <span className={session?'cloud-online':'cloud-local'}>{syncing?'正在同步…':session?'云端已同步':'SQLite 文件存储'}</span></p></div><div className="header-actions"><a className="help-button" href="/?guide=1" aria-label="打开使用指南">?</a><button className="avatar" onClick={()=>goTab('mine')} aria-label="打开我的页面">{avatarText}<i/></button></div></header>
      <Title text="今日概览" action={new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'short'}).format(new Date())}/>
      <div className="stats"><Stat n={stats.mine} label="我的任务" tone="purple" emoji="✓" onClick={()=>goTab('tasks')}/><Stat n={stats.done} label="今日完成" tone="green" emoji="✦" onClick={()=>goTab('tasks')}/><Stat n={stats.follow} label="待我跟进" tone="orange" emoji="♟" onClick={()=>goTab('team')}/></div>
      <Title text="今日复盘" action={report?'更新':'自动整理'} onClick={generateReport}/>
      <AIReport report={report} loading={reportLoading} error={reportError} aiReady={aiReady} generate={generateReport} addTomorrow={addTomorrow} openSettings={()=>setModal('settings')}/>
      <Title text="优先处理" action="查看全部 ›" onClick={()=>goTab('tasks')}/>
      {tasks.filter(t=>t.status!=='done').slice(0,3).map(t=><TaskItem key={t.id} task={t} cycle={cycle} remove={removeTask} now={clock}/>)}
      <Title text="团队动态" action="全部动态" onClick={()=>goTab('team')}/>
      <div className="empty activity-empty">暂无团队动态</div>
      <button className="install" onClick={install}>▣ {installEvent?'安装 FlowMate 到手机':'添加到主屏幕'}</button>
    </div>}
    {tab==='tasks'&&<ListPage title="我的任务" tasks={tasks.filter(t=>t.assignee==='我')} cycle={cycle} remove={removeTask} now={clock}/>} 
    {tab==='team'&&<ListPage title="团队任务" tasks={tasks.filter(t=>t.assignee!=='我')} cycle={cycle} remove={removeTask} now={clock}/>} 
    {tab==='mine'&&<Profile name={displayName} avatar={avatarText} tasks={tasks} install={install} aiReady={aiReady} cloudOnline={Boolean(session)} syncing={syncing} signOut={()=>supabase?.auth.signOut()} goTeam={()=>goTab('team')} notify={notify} openSettings={()=>setModal('settings')} openCloudSettings={()=>setModal('cloud')}/>} 
    <div className="quick-create" role="group" aria-label="新建任务">
      <button className="quick-voice" type="button" onClick={()=>{setVoiceTip('一次可以说多个任务，也可以修改已有任务');setModal('voice')}} aria-label="语音新建或修改任务"><MicIcon/><span>语音</span></button>
      <button className="quick-add" type="button" onClick={()=>setModal('add')} aria-label="手动新建任务">＋</button>
    </div>
    <nav>{([['home','⌂','首页'],['tasks','✓','任务'],['team','♟','团队'],['mine','●','我的']] as const).map(([id,icon,label])=><button className={tab===id?'active':''} onClick={()=>goTab(id)} key={id}><i>{icon}</i><span>{label}</span></button>)}</nav>
    {toast&&<div className="toast" role="status">✓ {toast}</div>}
    {modal&&<div className="overlay" onClick={()=>!recording&&!processing&&setModal(null)}><section className={'sheet '+(modal==='settings'||modal==='cloud'?'settings-sheet':'')} onClick={e=>e.stopPropagation()}><div className="handle"/>{modal==='voice'?<><h2>{processing?'AI 正在拆解…':recording?'正在录音…':transcript?'录音待确认':'语音创建任务'}</h2><p className={'voice-tip '+(recording||processing?'live':'')}>{voiceTip}</p><button className={'record '+(recording?'recording':'')} disabled={processing} onClick={recording?stopRecording:beginRecording}><MicIcon/></button><p className="record-label">{processing?'识别多个事项并分别创建':recording?'点击结束录音':'点击开始录音'}</p><textarea className="input transcript" value={transcript} placeholder="可以一次说出多个任务，AI 会自动拆解" onChange={e=>{setTranscript(e.target.value);setParsedTask(null)}}/>{parsedTask&&<div className="ai-understanding"><b>已整理</b><span>任务：{parsedTask.title}</span><span>负责人：{parsedTask.assignee} · 截止：{parsedTask.due} · {parsedTask.priority}优先级</span><span>预计用时：{formatDuration(parsedTask.estimatedMinutes||defaultEstimate(parsedTask.priority))}</span></div>}<button className="primary" disabled={!transcript.trim()||processing||recording} onClick={createTasksFromText}>AI 拆解并创建任务</button></>:modal==='settings'?<ModelSettings onClose={()=>setModal(null)} onSaved={()=>{setAiReady(true);notify('模型设置已保存');setModal(null)}}/>:modal==='cloud'?<CloudSettings onClose={()=>setModal(null)}/>:<><h2>新建任务</h2><label>任务内容</label><input className="input" value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：完成项目周报"/><label>负责人</label><div className="people"><button className="selected" onClick={()=>setAssignee('我')}>我</button></div><label>预估时间</label><select className="input" value={estimate} onChange={e=>setEstimate(Number(e.target.value))}><option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={60}>1 小时</option><option value={120}>2 小时</option><option value={240}>4 小时</option></select><button className="primary" disabled={!title.trim()} onClick={()=>addTask()}>创建任务</button></>}</section></div>}
  </main></div>;
}

function AIReport({report,loading,error,aiReady,generate,addTomorrow,openSettings}:{report:DailyReport|null;loading:boolean;error:string;aiReady:boolean|null;generate:()=>void;addTomorrow:()=>void;openSettings:()=>void}){
  const handleGenerate=()=>{if(aiReady===false){openSettings();return}generate()};
  if(loading)return <section className="ai-report loading"><div className="ai-orb">···</div><div><b>正在整理今天的工作</b><p>汇总完成事项、待跟进内容和明日安排</p></div></section>;
  if(!report)return <section className="ai-report empty-report"><div className="ai-orb">≡</div><div><b>{aiReady===false?'复盘服务待配置':'整理今天的工作'}</b><p>{error||'汇总完成情况，并安排明天的重要事项。'}</p><button type="button" onClick={handleGenerate}>{aiReady===false?'查看配置说明':'开始整理'}</button></div></section>;
  return <section className="ai-report full"><div className="report-top"><div className="ai-orb">✦</div><div><small>今日工作小结</small><h3>{report.headline}</h3></div></div><p className="report-summary">{report.summary}</p>{report.completed.length>0&&<div className="report-block"><b>已完成</b>{report.completed.map(x=><span key={x}>✓ {x}</span>)}</div>}{report.risks.length>0&&<div className="report-block risks"><b>需要关注</b>{report.risks.map(x=><span key={x}>! {x}</span>)}</div>}<div className="tomorrow-head"><b>明日建议</b><span>{report.tomorrow.length} 项</span></div>{report.tomorrow.map((x,i)=><div className="tomorrow" key={x.title}><i>{i+1}</i><div><b>{x.title}</b><p>{x.suggestedTime} · {x.reason}</p></div><em>{x.priority}</em></div>)}<button className="add-plan" onClick={addTomorrow}>＋ 加入明日任务</button></section>;
}
function Title({text,action,onClick}:{text:string;action:string;onClick?:()=>void}){return <div className="section-title"><h2>{text}</h2>{onClick?<button type="button" onClick={onClick}>{action}</button>:<span>{action}</span>}</div>}
function MicIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2" width="8" height="13" rx="4" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>}
function Stat({n,label,tone,emoji,onClick}:{n:number;label:string;tone:string;emoji:string;onClick:()=>void}){return <button className="stat" type="button" onClick={onClick}><i className={tone}>{emoji}</i><strong>{n}</strong><span>{label}</span></button>}
function formatDuration(minutes:number){const safe=Math.max(0,Math.round(minutes||0));if(safe<60)return `${safe}分钟`;const hours=Math.floor(safe/60);const rest=safe%60;return rest?`${hours}小时${rest}分钟`:`${hours}小时`}
function taskElapsed(task:Task,now:number){if(!task.startedAt)return 0;const start=new Date(task.startedAt).getTime();const end=task.status==='done'&&task.completedAt?new Date(task.completedAt).getTime():now;if(!Number.isFinite(start)||!Number.isFinite(end))return 0;return Math.max(0,Math.floor((end-start)/60_000))}
function TrashIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
function TaskItem({task,cycle,remove,now}:{task:Task;cycle:(id:string)=>void;remove:(id:string,title:string)=>void;now:number}){const elapsed=taskElapsed(task,now);return <div className={'task-wrap '+(task.aiStatus?`ai-${task.aiStatus}`:'')}><button className={'task '+(task.aiStatus?`ai-${task.aiStatus}`:'')} onClick={()=>cycle(task.id)}><i className={`task-status ${task.status}`}>{task.aiStatus==='pending'?'…':task.aiStatus==='failed'?'!':task.status==='done'?'✓':''}</i><div><strong className={task.status==='done'?'done':''}>{task.title}</strong><p>{task.aiStatus==='pending'?<b className="ai-task-state">AI 后台识别中</b>:task.aiStatus==='failed'?<b className="ai-task-error">识别失败 · 点击重试</b>:<><b className={task.priority==='高'?'high':''}>{task.priority}优先级</b> · {task.due} · {task.assignee}</>}</p><div className="task-time"><span>预计 {formatDuration(task.estimatedMinutes)}</span><span>已进行 {formatDuration(elapsed)}</span></div>{task.assignee!=='我'&&task.status!=='done'&&<span className="progress"><em style={{width:`${task.progress}%`}}/></span>}</div></button><button className="task-delete" type="button" onClick={()=>remove(task.id,task.title)} aria-label={`删除任务：${task.title}`}><TrashIcon/></button></div>}
function ListPage({title,tasks,cycle,remove,now}:{title:string;tasks:Task[];cycle:(id:string)=>void;remove:(id:string,title:string)=>void;now:number}){const [filter,setFilter]=useState('全部');const list=tasks.filter(t=>filter==='全部'||(filter==='已完成'?t.status==='done':t.status!=='done'));return <div className="page"><h1 className="page-title">{title}</h1><p className="page-sub">轻点任务切换状态，右侧按钮可删除任务</p><div className="filters">{['全部','进行中','已完成'].map(f=><button key={f} className={f===filter?'active':''} onClick={()=>setFilter(f)}>{f}</button>)}</div>{list.map(t=><TaskItem key={t.id} task={t} cycle={cycle} remove={remove} now={now}/>)}{!list.length&&<div className="empty">这里暂时没有任务 🎉</div>}</div>}
function Profile({name,avatar,tasks,install,aiReady,cloudOnline,syncing,signOut,goTeam,notify,openSettings,openCloudSettings}:{name:string;avatar:string;tasks:Task[];install:()=>void;aiReady:boolean|null;cloudOnline:boolean;syncing:boolean;signOut:()=>void;goTeam:()=>void;notify:(message:string)=>void;openSettings:()=>void;openCloudSettings:()=>void}){const rate=Math.round(tasks.filter(t=>t.status==='done').length/Math.max(tasks.length,1)*100);const requestNotice=async()=>{if(!('Notification'in window)){notify('当前浏览器不支持系统通知');return}const result=await Notification.requestPermission();notify(result==='granted'?'通知已开启':'通知权限未开启')};const menus=[{i:'♢',t:'通知与提醒',action:requestNotice},{i:'♟',t:'成员管理',action:goTeam},{i:'☁',t:'数据与同步',action:openCloudSettings},{i:'⚙',t:'设置',action:openSettings}];return <div className="page"><h1 className="page-title">我的</h1><section className="profile"><div className="big-avatar">{avatar}</div><h2>{name}</h2><p>{cloudOnline?'云端工作区':'京东云工作区'}</p><span className={'ai-status '+(aiReady?'online':'')}>● {aiReady?'智能助手已连接':'智能助手待配置'}</span><span className="ai-status online">● {cloudOnline?(syncing?'云端同步中':'云端数据已同步'):'SQLite 文件存储'}</span></section><section className="week"><h2>本周效率</h2><strong>{rate}%</strong><p>任务完成率</p><span><i style={{width:`${rate}%`}}/></span></section>{menus.map(item=><button className="menu" key={item.t} onClick={item.action}><i>{item.i}</i><span>{item.t}</span><b>›</b></button>)}<button className="install" onClick={install}>▣ 添加到手机主屏幕</button>{cloudOnline&&<button className="sign-out" onClick={signOut}>退出当前账号</button>}</div>}

function CloudSettings({onClose}:{onClose:()=>void}){
  const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [testing,setTesting]=useState(false);const [removing,setRemoving]=useState(false);
  const [configured,setConfigured]=useState(false);const [url,setUrl]=useState('');const [anonKey,setAnonKey]=useState('');const [masked,setMasked]=useState('');const [showKey,setShowKey]=useState(false);const [error,setError]=useState('');const [success,setSuccess]=useState('');
  const headers=async()=>{const token=(await supabase?.auth.getSession())?.data.session?.access_token;return{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}};
  useEffect(()=>{fetch('/api/settings/cloud',{cache:'no-store'}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.message||'读取云存储配置失败');setConfigured(Boolean(data.configured));setUrl(data.url||'');setMasked(data.maskedKey||'')}).catch(e=>setError(e.message)).finally(()=>setLoading(false))},[]);
  const request=async(path:string,options:RequestInit)=>{const response=await fetch(path,{...options,headers:await headers()});const data=await response.json();if(!response.ok)throw new Error(data.message||'操作失败');return data};
  const test=async()=>{setTesting(true);setError('');setSuccess('');try{const data=await request('/api/settings/cloud/test',{method:'POST',body:JSON.stringify({url,anonKey})});setSuccess(data.message||'连接成功')}catch(e){setError(e instanceof Error?e.message:'连接测试失败')}finally{setTesting(false)}};
  const save=async()=>{setSaving(true);setError('');setSuccess('');try{const data=await request('/api/settings/cloud',{method:'PUT',body:JSON.stringify({url,anonKey})});setConfigured(true);setMasked(data.maskedKey||'');setAnonKey('');setSuccess('保存成功，正在进入云端登录…');window.setTimeout(()=>window.location.reload(),700)}catch(e){setError(e instanceof Error?e.message:'保存失败')}finally{setSaving(false)}};
  const remove=async()=>{if(!window.confirm('移除后将切换到京东云服务器上的 SQLite 文件存储，Supabase 中已有数据不会被删除。确定继续吗？'))return;setRemoving(true);setError('');try{await request('/api/settings/cloud',{method:'DELETE'});window.location.reload()}catch(e){setError(e instanceof Error?e.message:'移除失败');setRemoving(false)}};
  const missingNewConfig=!url.trim()||(!configured&&!anonKey.trim());
  return <div className="model-settings cloud-settings"><div className="settings-head"><div><small>数据与同步</small><h2>云存储设置</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></div>{loading?<div className="settings-loading">正在读取服务端配置…</div>:<><div className={'settings-status '+(configured?'ready':'')}><i>{configured?'✓':'☁'}</i><div><b>{configured?'云存储已配置':'尚未连接云存储'}</b><span>{configured?`当前公开密钥 ${masked}`:'连接后，任务、日报和团队进度可在所有设备同步'}</span></div></div><div className="cloud-provider"><i>S</i><div><b>Supabase</b><span>PostgreSQL 数据库 · 登录认证 · 实时同步</span></div></div><label>Supabase 项目地址</label><input className="input" type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" autoCapitalize="off" autoCorrect="off"/><p className="field-help">在 Supabase 控制台的 Project Settings → API 中复制 Project URL。</p><label>公开密钥（Anon / Publishable Key）</label><div className="key-field"><input className="input" type={showKey?'text':'password'} value={anonKey} onChange={e=>setAnonKey(e.target.value)} placeholder={configured?`已配置 ${masked}，留空则不修改`:'粘贴 anon 或 sb_publishable_ 开头的密钥'} autoCapitalize="off" autoCorrect="off"/><button type="button" onClick={()=>setShowKey(v=>!v)}>{showKey?'隐藏':'显示'}</button></div><p className="field-help">只能填写可公开的 anon / publishable key。请勿填写 service_role 或 secret key。</p>{success&&<div className="settings-success">✓ {success}</div>}{error&&<div className="settings-error">{error}</div>}<div className="settings-actions cloud-actions"><button type="button" disabled={testing||saving||missingNewConfig} onClick={test}>{testing?'正在测试…':'测试连接'}</button><button type="button" disabled={saving||testing||missingNewConfig} onClick={save}>{saving?'正在保存…':'保存并启用'}</button></div>{configured&&<button className="remove-cloud" type="button" disabled={removing} onClick={remove}>{removing?'正在移除…':'移除云存储配置'}</button>}<p className="cloud-note">配置保存在这台服务器的环境文件中，同一服务器上的 Android、iPhone 和电脑浏览器会自动使用它。</p></>}</div>;
}

function ModelSettings({onClose,onSaved}:{onClose:()=>void;onSaved:()=>void}){
  const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [configured,setConfigured]=useState(false);const [masked,setMasked]=useState('');
  const [apiKey,setApiKey]=useState('');const [showKey,setShowKey]=useState(false);const [textModel,setTextModel]=useState('qwen3.7-plus');const [asrModel,setAsrModel]=useState('qwen3-asr-flash');const [error,setError]=useState('');
  const headers=async()=>{const token=(await supabase?.auth.getSession())?.data.session?.access_token;return{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}};
  useEffect(()=>{headers().then(h=>fetch('/api/settings/model',{headers:h})).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.message||'读取配置失败');setConfigured(data.configured);setMasked(data.maskedKey||'');setTextModel(data.textModel);setAsrModel(data.asrModel)}).catch(e=>setError(e.message)).finally(()=>setLoading(false))},[]);
  const save=async()=>{setSaving(true);setError('');try{const response=await fetch('/api/settings/model',{method:'PUT',headers:await headers(),body:JSON.stringify({apiKey,textModel,asrModel})});const data=await response.json();if(!response.ok)throw new Error(data.message||'保存失败');setMasked(data.maskedKey);setConfigured(true);setApiKey('');onSaved()}catch(e){setError(e instanceof Error?e.message:'保存失败')}finally{setSaving(false)}};
  return <div className="model-settings"><div className="settings-head"><div><small>模型服务</small><h2>大模型设置</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></div>{loading?<div className="settings-loading">正在读取服务端配置…</div>:<><div className={'settings-status '+(configured?'ready':'')}><i>{configured?'✓':'!'}</i><div><b>{configured?'模型服务已配置':'尚未配置 API Key'}</b><span>{configured?`当前密钥 ${masked}`:'填写阿里云百炼 API Key 后即可使用语音识别和每日复盘'}</span></div></div><label>阿里云百炼 API Key</label><div className="key-field"><input className="input" type={showKey?'text':'password'} value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={configured?`已配置 ${masked}，留空则不修改`:'sk-xxxxxxxxxxxxxxxx'}/><button type="button" onClick={()=>setShowKey(v=>!v)}>{showKey?'隐藏':'显示'}</button></div><p className="field-help">密钥仅发送至服务端保存，不写入浏览器缓存，也不会在读取时返回明文。</p><label>任务理解与每日复盘</label><select className="input model-select" value={textModel} onChange={e=>setTextModel(e.target.value)}><option value="qwen3.7-plus">通义千问 3.7 Plus（推荐）</option><option value="qwen-plus">通义千问 Plus</option><option value="qwen3.6-flash">通义千问 3.6 Flash（经济）</option><option value="deepseek-v3.2">DeepSeek V3.2</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option><option value="deepseek-v4-flash">DeepSeek V4 Flash</option></select><label>语音识别</label><select className="input model-select" value={asrModel} onChange={e=>setAsrModel(e.target.value)}><option value="qwen3-asr-flash">千问 3 ASR Flash（推荐）</option><option value="qwen3-asr-flash-2026-02-10">千问 3 ASR Flash 2026-02-10</option></select>{error&&<div className="settings-error">{error}</div>}<div className="settings-actions"><button type="button" onClick={onClose}>取消</button><button type="button" disabled={saving||(!configured&&!apiKey.trim())} onClick={save}>{saving?'正在保存…':'保存并启用'}</button></div></>}</div>;
}

function LoginPage({demo=false}:{demo?:boolean}){
  const [email,setEmail]=useState(demo?'demo@flowmate.cn':'');const [sending,setSending]=useState(false);const [sent,setSent]=useState(false);const [error,setError]=useState('');
  const submit=async(e:React.FormEvent)=>{e.preventDefault();if(!email.trim())return;setSending(true);setError('');try{if(demo)await new Promise(resolve=>setTimeout(resolve,700));else await sendMagicLink(email.trim());setSent(true)}catch(err){setError(err instanceof Error?err.message:'登录邮件发送失败')}finally{setSending(false)}};
  return <div className="viewport"><main className="app auth-shell"><section className="login-card">{demo&&<div className="demo-ribbon">交互演示 · 不会发送邮件</div>}<div className="brand-mark">✓</div><span className="login-eyebrow">FLOWMATE CLOUD</span><h1>{sent?'检查你的邮箱':'登录工作助手'}</h1><p>{sent?`登录链接已发送至 ${email}，点击邮件中的链接即可进入云端工作区。`:'任务、日报和团队进度会安全同步到所有设备。'}</p>{!sent?<form onSubmit={submit}><label>工作邮箱</label><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@company.com" autoComplete="email" required/><button className="primary" disabled={sending}>{sending?'正在发送…':'发送登录链接'}</button>{error&&<div className="login-error">{error}</div>}</form>:<><div className="mail-preview"><i>✉</i><div><b>FlowMate 登录邮件</b><span>点击邮件内的“登录 FlowMate”按钮，浏览器会自动返回应用。</span></div></div><button className="secondary-login" onClick={()=>setSent(false)}>更换邮箱</button></>}<div className="cloud-benefits"><span>☁ 多端实时同步</span><span>◇ 团队数据隔离</span><span>↻ 自动云端备份</span></div>{demo&&<a className="back-app" href="/">← 返回工作助手</a>}</section></main></div>;
}

function fromCloud(row:CloudTask):Task{return normalizeTask(toSimplified({id:row.id,title:row.title,assignee:row.assignee,due:row.due_label,status:row.status,priority:row.priority,progress:row.progress,estimatedMinutes:row.estimated_minutes,createdAt:row.created_at,startedAt:row.started_at||undefined,completedAt:row.completed_at||undefined,aiStatus:row.due_label==='AI后台处理中'?'pending':row.due_label==='识别失败'?'failed':undefined}))}
function toCloud(task:Task,teamId:string,userId:string):CloudTask{return{id:task.id,team_id:teamId,title:task.title,assignee:task.assignee,due_label:task.due,status:task.status,priority:task.priority,progress:task.progress,estimated_minutes:task.estimatedMinutes,created_by:userId,created_at:task.createdAt||new Date().toISOString(),started_at:task.startedAt||null,completed_at:task.completedAt||null}}
