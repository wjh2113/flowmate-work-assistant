create table if not exists public.period_reports (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('weekly', 'monthly')),
  period_key text not null,
  report jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, user_id, kind, period_key)
);

alter table public.period_reports enable row level security;

create policy "period_reports_select" on public.period_reports for select to authenticated using (public.is_team_member(team_id));
create policy "period_reports_insert" on public.period_reports for insert to authenticated with check (public.is_team_member(team_id) and user_id = (select auth.uid()));
create policy "period_reports_update" on public.period_reports for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "period_reports_delete" on public.period_reports for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.period_reports to authenticated;
