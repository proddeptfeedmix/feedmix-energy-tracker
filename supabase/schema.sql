-- ============================================================================
-- Feedmix Energy Tracker — Supabase schema
-- Run this ONCE in your Supabase project's SQL Editor (Dashboard → SQL Editor
-- → New query → paste all of this → Run). Safe to re-run only on a fresh
-- project (it will error on tables that already exist).
--
-- This replaces the old "GitHub repo as database + personal access token"
-- design. There is no token anywhere in this app anymore: the browser talks
-- directly to Supabase using the public "anon" key (safe to expose — that's
-- how Supabase is designed to work), and everything sensitive (password
-- checks, password hashing) happens inside Postgres functions below, never
-- in the browser.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists plants (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists machines (
  id text primary key,
  plant_id text not null references plants(id) on delete cascade,
  name text not null,
  category text not null,
  rated_kw numeric not null,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  username text not null unique,
  role text not null check (role in ('admin','technician')),
  plant_id text references plants(id) on delete set null,
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists events (
  id text primary key,
  plant_id text not null references plants(id) on delete cascade,
  machine_id text not null references machines(id) on delete cascade,
  type text not null check (type in ('start','stop')),
  ts timestamptz not null,
  by_username text,
  created_at timestamptz not null default now()
);

create table if not exists shifts (
  id text primary key,
  plant_id text not null references plants(id) on delete cascade,
  machine_id text not null references machines(id) on delete cascade,
  date date not null,
  shift_name text,
  hours numeric not null,
  by_username text,
  created_at timestamptz not null default now()
);

create table if not exists readings (
  id text primary key,
  plant_id text not null references plants(id) on delete cascade,
  machine_id text not null references machines(id) on delete cascade,
  date date not null,
  ts timestamptz not null,
  kw numeric not null,
  by_username text,
  created_at timestamptz not null default now()
);

-- Audit trail columns for the Logs view: lets an admin, or the technician
-- who originally logged an entry, correct a mistake (e.g. a missed Stop
-- tap) while leaving a visible "edited by" trace instead of silently
-- rewriting history.
alter table events add column if not exists edited_at timestamptz;
alter table events add column if not exists edited_by text;
alter table shifts add column if not exists edited_at timestamptz;
alter table shifts add column if not exists edited_by text;
alter table readings add column if not exists edited_at timestamptz;
alter table readings add column if not exists edited_by text;

create index if not exists idx_machines_plant on machines(plant_id);
create index if not exists idx_events_plant_machine on events(plant_id, machine_id);
create index if not exists idx_shifts_plant_machine on shifts(plant_id, machine_id);
create index if not exists idx_readings_plant_machine on readings(plant_id, machine_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Operational tables (plants/machines/events/shifts/readings) are open to
-- the app's public anon key, same trust model as the old "shared token"
-- design — this is a small internal tool, not a hardened multi-tenant
-- system. The users table is the one exception: it is locked down so the
-- anon key can never read password hashes directly. All user auth/creation
-- goes through the security-definer functions below instead.
-- ---------------------------------------------------------------------------
alter table plants enable row level security;
alter table machines enable row level security;
alter table users enable row level security;
alter table events enable row level security;
alter table shifts enable row level security;
alter table readings enable row level security;

drop policy if exists "anon full access plants" on plants;
create policy "anon full access plants" on plants for all using (true) with check (true);

drop policy if exists "anon full access machines" on machines;
create policy "anon full access machines" on machines for all using (true) with check (true);

drop policy if exists "anon full access events" on events;
create policy "anon full access events" on events for all using (true) with check (true);

drop policy if exists "anon full access shifts" on shifts;
create policy "anon full access shifts" on shifts for all using (true) with check (true);

drop policy if exists "anon full access readings" on readings;
create policy "anon full access readings" on readings for all using (true) with check (true);

-- No policies on `users` → RLS default-denies direct anon access entirely.

-- Safe, hash-free view of users for the Admin screen's user list.
create or replace view user_directory as
  select id, name, username, role, plant_id, active, created_at from users;
grant select on user_directory to anon;

-- ---------------------------------------------------------------------------
-- Auth functions (security definer = run with elevated rights, bypassing
-- RLS internally, but only ever return/accept the fields defined here)
-- ---------------------------------------------------------------------------
create or replace function login(p_username text, p_password text)
returns table(id uuid, name text, username text, role text, plant_id text)
language plpgsql security definer set search_path = public as $$
begin
  return query
    select u.id, u.name, u.username, u.role, u.plant_id
    from users u
    where lower(u.username) = lower(p_username)
      and u.active = true
      and u.password_hash = crypt(p_password, u.password_hash);
end;
$$;
grant execute on function login(text, text) to anon;

create or replace function admin_add_user(p_name text, p_username text, p_role text, p_plant_id text, p_password text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into users(name, username, role, plant_id, password_hash)
  values (p_name, p_username, p_role, p_plant_id, crypt(p_password, gen_salt('bf')));
end;
$$;
grant execute on function admin_add_user(text, text, text, text, text) to anon;

create or replace function admin_set_user_active(p_username text, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update users set active = p_active where lower(username) = lower(p_username);
end;
$$;
grant execute on function admin_set_user_active(text, boolean) to anon;

create or replace function admin_delete_user(p_username text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from users where lower(username) = lower(p_username);
end;
$$;
grant execute on function admin_delete_user(text) to anon;

-- ---------------------------------------------------------------------------
-- Realtime — lets the dashboard update instantly instead of only polling
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table events;
alter publication supabase_realtime add table readings;

-- ---------------------------------------------------------------------------
-- Seed data — 4 sample plants with typical feedmill machines, and default
-- logins. CHANGE THESE PASSWORDS after your first login (Admin → Users).
--   admin / admin123   — Admin, all plants
--   tech1 / tech123 … tech4 / tech123 — one technician per plant
-- ---------------------------------------------------------------------------
insert into plants (id, name) values
  ('plant1','Plant 1'), ('plant2','Plant 2'), ('plant3','Plant 3'), ('plant4','Plant 4')
on conflict (id) do nothing;

insert into machines (id, plant_id, name, category, rated_kw) values
  ('plant1-pm','plant1','Pellet Mill','Pelleting',132),
  ('plant1-hm','plant1','Hammer Mill','Grinding',90),
  ('plant1-ex','plant1','Extruder','Extrusion',110),
  ('plant1-db','plant1','Dryer Blower','Drying',45),
  ('plant1-ac','plant1','Air Compressor','Utilities',30),
  ('plant2-pm','plant2','Pellet Mill','Pelleting',132),
  ('plant2-hm','plant2','Hammer Mill','Grinding',90),
  ('plant2-ex','plant2','Extruder','Extrusion',110),
  ('plant2-db','plant2','Dryer Blower','Drying',45),
  ('plant2-ac','plant2','Air Compressor','Utilities',30),
  ('plant3-pm','plant3','Pellet Mill','Pelleting',132),
  ('plant3-hm','plant3','Hammer Mill','Grinding',90),
  ('plant3-ex','plant3','Extruder','Extrusion',110),
  ('plant3-db','plant3','Dryer Blower','Drying',45),
  ('plant3-ac','plant3','Air Compressor','Utilities',30),
  ('plant4-pm','plant4','Pellet Mill','Pelleting',132),
  ('plant4-hm','plant4','Hammer Mill','Grinding',90),
  ('plant4-ex','plant4','Extruder','Extrusion',110),
  ('plant4-db','plant4','Dryer Blower','Drying',45),
  ('plant4-ac','plant4','Air Compressor','Utilities',30)
on conflict (id) do nothing;

insert into users (name, username, role, plant_id, password_hash) values
  ('System Admin','admin','admin',null, crypt('admin123', gen_salt('bf'))),
  ('Technician Plant 1','tech1','technician','plant1', crypt('tech123', gen_salt('bf'))),
  ('Technician Plant 2','tech2','technician','plant2', crypt('tech123', gen_salt('bf'))),
  ('Technician Plant 3','tech3','technician','plant3', crypt('tech123', gen_salt('bf'))),
  ('Technician Plant 4','tech4','technician','plant4', crypt('tech123', gen_salt('bf')))
on conflict (username) do nothing;
