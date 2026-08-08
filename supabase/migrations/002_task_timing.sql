-- 为已有项目增加任务预估时间和实际开始时间。
alter table public.tasks
  add column if not exists estimated_minutes integer not null default 60
    check (estimated_minutes between 1 and 1440),
  add column if not exists started_at timestamptz;

-- 已经开始或完成的历史任务，以创建时间作为缺省开始时间。
update public.tasks
set started_at = created_at
where status in ('doing', 'done') and started_at is null;
