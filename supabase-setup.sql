-- ============================================================
-- Sprinkler Planner – Supabase setup
-- Run this once in the Supabase SQL Editor
-- ============================================================

-- Projects table (each row is one project belonging to a user)
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  data jsonb not null default '{}'::jsonb,   -- full project object (zones, etc.)
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Optional: members for future sharing
create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- Indexes
create index if not exists projects_owner_id_idx on public.projects(owner_id);
create index if not exists project_members_user_id_idx on public.project_members(user_id);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.projects enable row level security;
alter table public.project_members enable row level security;

-- Projects: owner can do everything
create policy "Owners can manage their projects"
  on public.projects
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- Projects: members can read (and later edit)
create policy "Members can read shared projects"
  on public.projects
  for select
  using (
    exists (
      select 1 from public.project_members m
      where m.project_id = projects.id
        and m.user_id = auth.uid()
    )
  );

-- Project members policies
create policy "Users can see memberships they belong to"
  on public.project_members
  for select
  using (auth.uid() = user_id or auth.uid() = (select owner_id from public.projects p where p.id = project_id));

create policy "Owners can manage members"
  on public.project_members
  for all
  using (
    auth.uid() = (select owner_id from public.projects p where p.id = project_id)
  )
  with check (
    auth.uid() = (select owner_id from public.projects p where p.id = project_id)
  );

-- ============================================================
-- Helpful function: update updated_at automatically
-- ============================================================
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists projects_updated_at on public.projects;
create trigger projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();
