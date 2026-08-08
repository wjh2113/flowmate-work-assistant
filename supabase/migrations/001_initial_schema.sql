-- FlowMate 云端数据结构。请在 Supabase SQL Editor 中完整执行。
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '新成员',
  created_at timestamptz not null default now()
);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (team_id,user_id)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 500),
  assignee text not null default '我',
  due_label text not null default '今天',
  status text not null default 'todo' check (status in ('todo','doing','done')),
  priority text not null default '中' check (priority in ('高','中','低')),
  progress integer not null default 0 check (progress between 0 and 100),
  estimated_minutes integer not null default 60 check (estimated_minutes between 1 and 1440),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  report_date date not null,
  report jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(team_id,user_id,report_date)
);

create or replace function public.is_team_member(target_team uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.team_members where team_id=target_team and user_id=(select auth.uid()));
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare new_team uuid;
begin
  insert into public.profiles(id,display_name) values(new.id,coalesce(new.raw_user_meta_data->>'display_name',split_part(new.email,'@',1)));
  insert into public.teams(name,owner_id) values('我的团队',new.id) returning id into new_team;
  insert into public.team_members(team_id,user_id,role) values(new_team,new.id,'owner');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.tasks enable row level security;
alter table public.daily_reports enable row level security;

create policy "profile_self" on public.profiles for all to authenticated using(id=(select auth.uid())) with check(id=(select auth.uid()));
create policy "teams_for_members" on public.teams for select to authenticated using(public.is_team_member(id));
create policy "members_in_same_team" on public.team_members for select to authenticated using(public.is_team_member(team_id));
create policy "tasks_select" on public.tasks for select to authenticated using(public.is_team_member(team_id));
create policy "tasks_insert" on public.tasks for insert to authenticated with check(public.is_team_member(team_id) and created_by=(select auth.uid()));
create policy "tasks_update" on public.tasks for update to authenticated using(public.is_team_member(team_id)) with check(public.is_team_member(team_id));
create policy "tasks_delete" on public.tasks for delete to authenticated using(public.is_team_member(team_id));
create policy "reports_select" on public.daily_reports for select to authenticated using(public.is_team_member(team_id));
create policy "reports_insert" on public.daily_reports for insert to authenticated with check(public.is_team_member(team_id) and user_id=(select auth.uid()));
create policy "reports_update" on public.daily_reports for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));

grant select,insert,update,delete on public.profiles,public.teams,public.team_members,public.tasks,public.daily_reports to authenticated;

-- 轻量协作场景使用 Postgres Changes；数据访问仍会经过 RLS。
alter publication supabase_realtime add table public.tasks;
