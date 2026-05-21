-- ============================================================
-- Task Tracker - database schema for Supabase
-- Run this ONCE: Supabase Dashboard > SQL Editor > New query >
-- paste everything > Run.
-- ============================================================

-- ---- Tables --------------------------------------------------

-- One row per signed-up person
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null,
  email      text,
  created_at timestamptz not null default now()
);

-- People who have been invited but may not have signed in yet
create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  full_name   text not null,
  status      text not null default 'pending'
              check (status in ('pending','accepted')),
  invited_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Tickets (the tasks people raise)
create table if not exists public.tickets (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text default '',
  priority     text not null default 'medium'
               check (priority in ('low','medium','high','urgent')),
  status       text not null default 'open'
               check (status in ('open','done')),
  assignee_id  uuid references public.profiles(id) on delete set null,
  assignee_email text,
  assignee_name  text,
  created_by   uuid references public.profiles(id) on delete set null,
  reopen_count int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Upgrade existing projects that already ran an older schema.sql
alter table public.tickets
  add column if not exists assignee_email text,
  add column if not exists assignee_name text;

-- Multiple people can be responsible for one ticket.
create table if not exists public.ticket_assignees (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      uuid not null references public.tickets(id) on delete cascade,
  assignee_id    uuid references public.profiles(id) on delete set null,
  assignee_email text,
  assignee_name  text,
  created_at     timestamptz not null default now()
);

create unique index if not exists ticket_assignees_ticket_user_idx
  on public.ticket_assignees (ticket_id, assignee_id)
  where assignee_id is not null;

create unique index if not exists ticket_assignees_ticket_email_idx
  on public.ticket_assignees (ticket_id, lower(assignee_email))
  where assignee_email is not null;

-- Backfill older single-assignee tickets into the new multi-assignee table.
insert into public.ticket_assignees (ticket_id, assignee_id, assignee_email, assignee_name)
select t.id, t.assignee_id, t.assignee_email, t.assignee_name
from public.tickets t
where (t.assignee_id is not null or t.assignee_email is not null)
  and not exists (
    select 1
    from public.ticket_assignees ta
    where ta.ticket_id = t.id
      and (
        (t.assignee_id is not null and ta.assignee_id = t.assignee_id)
        or (t.assignee_email is not null and lower(ta.assignee_email) = lower(t.assignee_email))
      )
  );

-- Comments on a ticket
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references public.tickets(id) on delete cascade,
  author_id  uuid references public.profiles(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);

-- Screenshot metadata (the image files live in Storage)
create table if not exists public.attachments (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.tickets(id) on delete cascade,
  storage_path text not null,
  file_name    text,
  created_at   timestamptz not null default now()
);

-- ---- Triggers ------------------------------------------------

-- Create a profile row automatically whenever someone signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep tickets.updated_at fresh on every edit
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tickets_touch on public.tickets;
create trigger tickets_touch
  before update on public.tickets
  for each row execute function public.touch_updated_at();

drop trigger if exists invitations_touch on public.invitations;
create trigger invitations_touch
  before update on public.invitations
  for each row execute function public.touch_updated_at();

create or replace function public.can_assign_ticket(ticket_uuid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.tickets
    where id = ticket_uuid
      and created_by = auth.uid()
  );
$$;

create or replace function public.can_act_on_ticket(ticket_uuid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.tickets
    where id = ticket_uuid
      and created_by = auth.uid()
  )
  or exists (
    select 1
    from public.ticket_assignees
    where ticket_id = ticket_uuid
      and assignee_id = auth.uid()
  );
$$;

create or replace function public.protect_ticket_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.created_by = auth.uid() then
    return new;
  end if;

  if public.can_act_on_ticket(old.id)
     and new.title = old.title
     and coalesce(new.description, '') = coalesce(old.description, '')
     and new.priority = old.priority
     and coalesce(new.assignee_id::text, '') = coalesce(old.assignee_id::text, '')
     and coalesce(new.assignee_email, '') = coalesce(old.assignee_email, '')
     and coalesce(new.assignee_name, '') = coalesce(old.assignee_name, '')
     and new.created_by is not distinct from old.created_by then
    return new;
  end if;

  raise exception 'Only the ticket creator can edit ticket details or assignees';
end;
$$;

drop trigger if exists tickets_protect_update on public.tickets;
create trigger tickets_protect_update
  before update on public.tickets
  for each row execute function public.protect_ticket_update();

-- When an invited person signs in for the first time, attach all tickets
-- previously assigned to their email address to their real profile.
create or replace function public.accept_pending_assignments()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.tickets
     set assignee_id = new.id,
         assignee_email = lower(new.email),
         assignee_name = new.full_name
   where assignee_email is not null
     and lower(assignee_email) = lower(new.email)
     and (assignee_id is null or assignee_id = new.id);

  update public.ticket_assignees
     set assignee_id = new.id,
         assignee_email = lower(new.email),
         assignee_name = new.full_name
   where assignee_email is not null
     and lower(assignee_email) = lower(new.email)
     and (assignee_id is null or assignee_id = new.id);

  update public.invitations
     set status = 'accepted',
         full_name = new.full_name
   where lower(email) = lower(new.email);

  return new;
end;
$$;

drop trigger if exists profiles_accept_pending_assignments on public.profiles;
create trigger profiles_accept_pending_assignments
  after insert or update of email, full_name on public.profiles
  for each row execute function public.accept_pending_assignments();

-- ---- Row Level Security -------------------------------------
-- Any signed-in teammate can see tickets.
-- Ticket creators can edit details, assignees, screenshots, and delete tickets.
-- Ticket creators and assignees can comment and update status.
-- Nobody who is not signed in can see anything.

alter table public.profiles    enable row level security;
alter table public.invitations enable row level security;
alter table public.tickets     enable row level security;
alter table public.ticket_assignees enable row level security;
alter table public.comments    enable row level security;
alter table public.attachments enable row level security;

drop policy if exists "profiles read"        on public.profiles;
drop policy if exists "profiles insert self" on public.profiles;
drop policy if exists "profiles update self" on public.profiles;
create policy "profiles read"        on public.profiles for select to authenticated using (true);
create policy "profiles insert self" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles update self" on public.profiles for update to authenticated using (id = auth.uid());

drop policy if exists "invitations all" on public.invitations;
create policy "invitations all" on public.invitations for all to authenticated using (true) with check (true);

drop policy if exists "tickets all" on public.tickets;
drop policy if exists "tickets read" on public.tickets;
drop policy if exists "tickets insert" on public.tickets;
drop policy if exists "tickets update creator or assignee status" on public.tickets;
drop policy if exists "tickets delete creator" on public.tickets;
create policy "tickets read" on public.tickets for select to authenticated using (true);
create policy "tickets insert" on public.tickets for insert to authenticated with check (created_by = auth.uid());
create policy "tickets update creator or assignee status"
  on public.tickets for update to authenticated
  using (public.can_act_on_ticket(id))
  with check (public.can_act_on_ticket(id));
create policy "tickets delete creator"
  on public.tickets for delete to authenticated
  using (created_by = auth.uid());

drop policy if exists "ticket assignees all" on public.ticket_assignees;
drop policy if exists "ticket assignees read" on public.ticket_assignees;
drop policy if exists "ticket assignees insert creator" on public.ticket_assignees;
drop policy if exists "ticket assignees delete creator" on public.ticket_assignees;
create policy "ticket assignees read" on public.ticket_assignees for select to authenticated using (true);
create policy "ticket assignees insert creator"
  on public.ticket_assignees for insert to authenticated
  with check (public.can_assign_ticket(ticket_id));
create policy "ticket assignees delete creator"
  on public.ticket_assignees for delete to authenticated
  using (public.can_assign_ticket(ticket_id));

drop policy if exists "comments read"       on public.comments;
drop policy if exists "comments insert"     on public.comments;
drop policy if exists "comments delete own" on public.comments;
create policy "comments read"       on public.comments for select to authenticated using (true);
create policy "comments insert"
  on public.comments for insert to authenticated
  with check (author_id = auth.uid() and public.can_act_on_ticket(ticket_id));
create policy "comments delete own" on public.comments for delete to authenticated using (author_id = auth.uid());

drop policy if exists "attachments all" on public.attachments;
drop policy if exists "attachments read" on public.attachments;
drop policy if exists "attachments insert creator" on public.attachments;
drop policy if exists "attachments delete creator" on public.attachments;
create policy "attachments read" on public.attachments for select to authenticated using (true);
create policy "attachments insert creator"
  on public.attachments for insert to authenticated
  with check (public.can_assign_ticket(ticket_id));
create policy "attachments delete creator"
  on public.attachments for delete to authenticated
  using (public.can_assign_ticket(ticket_id));

-- ---- Live updates -------------------------------------------
-- Lets every open browser refresh the board instantly.

do $$
begin
  alter publication supabase_realtime add table public.tickets;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.ticket_assignees;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.invitations;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.comments;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.attachments;
exception when duplicate_object then null;
end $$;

-- ---- Storage bucket for screenshots -------------------------

insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do nothing;

drop policy if exists "screenshots read"   on storage.objects;
drop policy if exists "screenshots write"  on storage.objects;
drop policy if exists "screenshots delete" on storage.objects;
create policy "screenshots read"   on storage.objects for select using (bucket_id = 'screenshots');
create policy "screenshots write"  on storage.objects for insert to authenticated with check (bucket_id = 'screenshots');
create policy "screenshots delete" on storage.objects for delete to authenticated using (bucket_id = 'screenshots');

-- Done. You can close the SQL editor.
