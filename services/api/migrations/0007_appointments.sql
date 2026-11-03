-- Rendez-vous et files d'attente (F3). Les heures sont stockées en UTC ; Djibouti est à UTC+3.

create schema appointments;

-- Praticiens : l'identifiant est celui du compte Keycloak.
create table appointments.practitioners (
  id text primary key,
  display_name text not null,
  department_code text not null,
  active boolean not null default true
);

-- Horaires hebdomadaires : jour ISO (1 = lundi ... 7 = dimanche), créneaux de `slot_minutes`.
create table appointments.availability (
  id bigint generated always as identity primary key,
  practitioner_id text not null references appointments.practitioners (id),
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  slot_minutes integer not null check (slot_minutes between 5 and 240),
  check (end_time > start_time)
);
create index availability_practitioner_idx on appointments.availability (practitioner_id, weekday);

create table appointments.absences (
  id bigint generated always as identity primary key,
  practitioner_id text not null references appointments.practitioners (id),
  from_date date not null,
  to_date date not null,
  reason text,
  check (to_date >= from_date)
);
create index absences_practitioner_idx on appointments.absences (practitioner_id, from_date);

create table appointments.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  practitioner_id text not null references appointments.practitioners (id),
  department_code text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked', 'arrived', 'cancelled', 'completed', 'no_show')),
  reason text,
  booked_by text not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancel_reason text,
  rescheduled_from uuid references appointments.appointments (id),
  check (ends_at > starts_at)
);
-- Un créneau ne peut être pris qu'une fois : garanti par la base, même si deux réservations arrivent ensemble.
create unique index appointments_active_slot_idx on appointments.appointments (practitioner_id, starts_at)
  where status in ('booked', 'arrived');
create index appointments_patient_idx on appointments.appointments (patient_id, starts_at);
create index appointments_day_idx on appointments.appointments (practitioner_id, starts_at);

-- Liste d'attente : un créneau libéré est proposé au premier patient concerné.
create table appointments.waitlist (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  department_code text not null,
  practitioner_id text references appointments.practitioners (id),
  earliest date not null,
  latest date not null,
  status text not null default 'waiting' check (status in ('waiting', 'offered', 'booked', 'cancelled')),
  offered_practitioner_id text,
  offered_slot timestamptz,
  offered_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  check (latest >= earliest)
);
create index waitlist_waiting_idx on appointments.waitlist (status, department_code, created_at);

-- File d'attente du jour : numéro d'ordre par service, urgences d'abord.
create table appointments.queue_counters (
  department_code text not null,
  queue_date date not null,
  value integer not null default 0,
  primary key (department_code, queue_date)
);
create table appointments.queue_entries (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  department_code text not null,
  queue_date date not null,
  number integer not null,
  ticket text not null,
  -- 0 urgence, 1 rendez-vous du jour, 2 sans rendez-vous
  priority smallint not null check (priority in (0, 1, 2)),
  status text not null default 'waiting' check (status in ('waiting', 'called', 'in_consultation', 'done', 'left')),
  arrived_at timestamptz not null default now(),
  called_at timestamptz,
  called_by text,
  encounter_id uuid,
  appointment_id uuid references appointments.appointments (id),
  unique (department_code, queue_date, number),
  unique (encounter_id)
);
create index queue_open_idx on appointments.queue_entries (department_code, queue_date, status, priority, arrived_at);

-- Rappels (SMS ou WhatsApp) : envoyés par un fournisseur choisi par ticket de décision.
create table appointments.reminders (
  id bigint generated always as identity primary key,
  appointment_id uuid references appointments.appointments (id),
  patient_id uuid not null,
  kind text not null check (kind in ('reminder', 'waitlist_offer')),
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  detail text,
  sent_at timestamptz,
  unique (appointment_id, kind)
);
create index reminders_due_idx on appointments.reminders (status, due_at);

revoke all on schema appointments from public;
revoke all on all tables in schema appointments from public;
grant usage on schema appointments to chu_app;
grant select, insert, update, delete on appointments.practitioners, appointments.availability, appointments.absences to chu_app;
grant select, insert, update on appointments.appointments, appointments.waitlist, appointments.queue_counters,
  appointments.queue_entries, appointments.reminders to chu_app;
grant usage, select on all sequences in schema appointments to chu_app;
