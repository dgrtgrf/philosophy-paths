-- Paste all of this into Supabase → SQL Editor → New query, then press Run.
-- It creates the two tables "Everyone's tree" needs, lets anyone read and add
-- (but never change or delete) rows, puts sensible size limits on what can be
-- added, and switches on live updates.

create table if not exists public.routes (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  mode       text not null check (mode in ('classic', 'smart')),
  start      text not null check (char_length(start) between 1 and 300),
  path       text[] not null check (coalesce(array_length(path, 1), 0) between 1 and 120
                                    and char_length(array_to_string(path, '|')) <= 20000),
  outcome    text not null check (outcome in ('philosophy', 'loop', 'dead_end', 'too_long', 'missing')),
  rescued    int[] not null default '{}' check (coalesce(array_length(rescued, 1), 0) <= 120)
);
create index if not exists routes_mode_id on public.routes (mode, id desc);

create table if not exists public.pages (
  title      text primary key check (char_length(title) between 1 and 300),
  text       text not null default '' check (char_length(text) <= 1200),
  created_at timestamptz not null default now()
);

-- Row level security: read + add only. No update or delete policies, so
-- nobody using the public key can change or remove anything.
alter table public.routes enable row level security;
alter table public.pages  enable row level security;

drop policy if exists "read routes" on public.routes;
drop policy if exists "add routes"  on public.routes;
drop policy if exists "read pages"  on public.pages;
drop policy if exists "add pages"   on public.pages;
create policy "read routes" on public.routes for select to anon, authenticated using (true);
create policy "add routes"  on public.routes for insert to anon, authenticated with check (true);
create policy "read pages"  on public.pages  for select to anon, authenticated using (true);
create policy "add pages"   on public.pages  for insert to anon, authenticated with check (true);

-- Live updates: tell Supabase to broadcast new routes to open pages.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'routes') then
    alter publication supabase_realtime add table public.routes;
  end if;
end $$;
