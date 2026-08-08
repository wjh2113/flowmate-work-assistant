const steps = [
  {n:'01',title:'说出任务指令',text:'点击首页麦克风，可以新建任务，也可以直接修改已有任务。',example:'“把项目复盘标记为已完成”'},
  {n:'02',title:'AI 后台整理',text:'录音保存后即可离开，系统会在后台识别并自动创建或更新目标任务。',example:'“把路线图负责人改成林晓”'},
  {n:'03',title:'更新完成进度',text:'进入任务列表，轻点任务即可依次切换待办、进行中和已完成。',example:'待办 → 进行中 → 已完成'},
  {n:'04',title:'跟进团队事项',text:'在团队页查看已分派任务、当前进度以及需要你关注的内容。',example:'落地页设计稿 · 80%'},
  {n:'05',title:'做好每日收尾',text:'“今日复盘”会汇总完成情况、待关注风险，并整理明日事项。',example:'一键加入明日任务'},
];

export default function GuidePage(){
  return <div className="guide-viewport">
    <main className="guide-page">
      <nav className="guide-nav"><a className="guide-brand" href="/"><i>✓</i><span>FlowMate</span></a><a className="guide-close" href="/">返回工作台</a></nav>
      <header className="guide-hero"><span className="guide-kicker">快速上手</span><h1>五步开始高效工作</h1><p>跟随页面中的编号提示，几分钟内熟悉任务创建、进度跟进和每日复盘。</p></header>
      <section className="guide-showcase">
        <div className="guide-phone">
          <div className="phone-top"><div><b>早上好，王俊</b><span>我的团队 · 云端已同步</span></div><i>王</i></div>
          <div className="demo-voice"><div><small>语音管理任务</small><b>说一句，新建或修改任务</b><span>例如：把项目复盘标记为完成</span></div><i>●</i><em>1</em></div>
          <div className="demo-title"><b>今日概览</b><span>今天</span></div>
          <div className="demo-stats"><div><b>4</b><span>我的任务</span></div><div><b>2</b><span>今日完成</span></div><div><b>3</b><span>待我跟进</span></div><em>2</em></div>
          <div className="demo-title"><b>优先处理</b><span>查看全部</span></div>
          <div className="demo-task"><i/><div><b>完成项目复盘报告</b><span>高优先级 · 今天 18:00</span></div><em>3</em></div>
          <div className="demo-review"><i>≡</i><div><b>今日复盘</b><span>汇总今天，安排明天</span></div><em>5</em></div>
          <div className="demo-nav"><span>首页</span><span>任务</span><span>团队</span><span>我的</span><em>4</em></div>
          <button className="demo-fab">＋</button>
        </div>
        <div className="guide-callouts">
          <Callout n="1" title="语音管理" text="新建或修改已有任务"/>
          <Callout n="2" title="掌握全局" text="快速查看今日完成情况"/>
          <Callout n="3" title="更新状态" text="轻点任务切换进度"/>
          <Callout n="4" title="切换模块" text="查看自己和团队的事项"/>
          <Callout n="5" title="每日复盘" text="总结今天并规划明天"/>
        </div>
      </section>
      <section className="guide-steps"><div className="steps-heading"><span>操作说明</span><h2>从一句话到一天的计划</h2></div><div className="step-grid">{steps.map(step=><article className="step-card" key={step.n}><span>{step.n}</span><h3>{step.title}</h3><p>{step.text}</p><small>{step.example}</small></article>)}</div></section>
      <section className="guide-cta"><div><span>准备好了</span><h2>从创建第一个任务开始</h2><p>语音和手动输入都可以，数据会自动保存到你的工作区。</p></div><div><a className="cta-secondary" href="/?login-demo=1">查看登录演示</a><a className="cta-primary" href="/">进入工作台</a></div></section>
    </main>
  </div>;
}

function Callout({n,title,text}:{n:string;title:string;text:string}){return <div className={`callout callout-${n}`}><i>{n}</i><div><b>{title}</b><span>{text}</span></div></div>}
