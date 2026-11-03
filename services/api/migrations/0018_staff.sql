-- Gestion du personnel : registre, qualifications et licences, planning de garde, congés.
-- Données personnelles des agents : accès réservé aux ressources humaines ; les autres rôles voient un annuaire minimal.

create extension if not exists btree_gist;
create schema staff;

create table staff.counters (name text primary key, value bigint not null default 0);
insert into staff.counters (name) values ('member');

create table staff.members (
  id uuid primary key default gen_random_uuid(),
  matricule text not null unique,
  given_name text not null,
  family_name text not null,
  sex text check (sex in ('female', 'male')),
  birth_date date,
  phone text,
  email text,
  category text not null check (category in
    ('physician', 'nurse', 'care_assistant', 'midwife', 'lab_technician', 'imaging_technician', 'pharmacist', 'biologist',
     'cashier', 'reception', 'storekeeper', 'administration', 'support', 'management')),
  job_title text not null,
  department_code text,
  status text not null default 'active' check (status in ('active', 'on_leave', 'suspended', 'left')),
  hired_on date not null,
  left_on date,
  -- Compte de connexion (identifiant Keycloak) : un compte pour un seul agent.
  user_id text unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint left_has_date check ((status = 'left') = (left_on is not null))
);
create index staff_members_department_idx on staff.members (department_code, status);
create index staff_members_name_idx on staff.members using gin ((lower(family_name || ' ' || given_name)) gin_trgm_ops);

-- Diplômes et certifications (informatif : aucune licence d'exercice n'est contrôlée).
create table staff.qualifications (
  id bigint generated always as identity primary key,
  member_id uuid not null references staff.members (id),
  kind text not null check (kind in ('diploma', 'certification')),
  title text not null,
  number text,
  issuer text,
  issued_on date,
  expires_on date,
  revoked_at timestamptz,
  revoked_reason text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index qualifications_member_idx on staff.qualifications (member_id);

-- Planning : une garde ne peut pas en chevaucher une autre pour le même agent (garantie par la base).
create table staff.shifts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references staff.members (id),
  department_code text not null,
  kind text not null check (kind in ('day', 'night', 'on_call')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at between interval '8 hours' and interval '10 hours'),
  exclude using gist (member_id with =, tstzrange(starts_at, ends_at) with &&)
);
create index shifts_time_idx on staff.shifts (department_code, starts_at);

create table staff.leaves (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references staff.members (id),
  kind text not null check (kind in ('annual', 'sick', 'maternity', 'unpaid', 'other')),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  reason text,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  check (ends_on >= starts_on),
  constraint decided_has_author check (status not in ('approved', 'rejected') or decided_by is not null)
);
create index leaves_member_idx on staff.leaves (member_id, starts_on);

create table staff.settings (key text primary key, value text not null);
-- Repos après une garde : 24 heures (décision du CHU).
insert into staff.settings (key, value) values ('min_rest_hours', '24');

revoke all on schema staff from public;
revoke all on all tables in schema staff from public;
grant usage on schema staff to chu_app;
grant select, insert, update on staff.counters, staff.members, staff.qualifications, staff.leaves, staff.settings to chu_app;
grant select, insert, update, delete on staff.shifts to chu_app;
grant usage, select on all sequences in schema staff to chu_app;
