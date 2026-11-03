-- Socle : extensions, journal d'audit en ajout seul, table d'événements (outbox).
-- Les rôles chu_migrator (propriétaire) et chu_app (application) existent déjà : voir src/bootstrap.ts.

create extension if not exists pg_trgm;

create schema audit;
create schema events;
create schema identity;

-- ---------------------------------------------------------------------------
-- Audit : qui, quoi, quand, quel patient. Ajout seul, garanti par la base.
-- ---------------------------------------------------------------------------
create table audit.log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id text not null,
  actor_roles text[] not null default '{}',
  action text not null,
  entity_type text not null,
  entity_id text,
  patient_id uuid,
  request_id text,
  detail jsonb not null default '{}'::jsonb
);
create index audit_log_patient_idx on audit.log (patient_id, at);
create index audit_log_at_idx on audit.log (at);

create function audit.refuse_change() returns trigger
language plpgsql as $$
begin
  raise exception 'Le journal est en ajout seul (%).', tg_op using errcode = '42501';
end $$;

create trigger log_no_row_change before update or delete on audit.log
  for each row execute function audit.refuse_change();
create trigger log_no_truncate before truncate on audit.log
  for each statement execute function audit.refuse_change();

revoke all on schema audit from public;
revoke all on audit.log from public;
grant usage on schema audit to chu_app;
grant select, insert on audit.log to chu_app;

-- ---------------------------------------------------------------------------
-- Événements : écrits dans la même transaction que la donnée qu'ils décrivent.
-- ---------------------------------------------------------------------------
create table events.outbox (
  id bigint generated always as identity primary key,
  event_id uuid not null unique,
  type text not null,
  version integer not null check (version > 0),
  occurred_at timestamptz not null,
  patient_id uuid,
  actor jsonb not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index outbox_type_idx on events.outbox (type, id);

create function events.refuse_change() returns trigger
language plpgsql as $$
begin
  raise exception 'La table des événements est en ajout seul (%).', tg_op using errcode = '42501';
end $$;

create trigger outbox_no_row_change before update or delete on events.outbox
  for each row execute function events.refuse_change();
create trigger outbox_no_truncate before truncate on events.outbox
  for each statement execute function events.refuse_change();

-- Suivi des consommateurs (phase 2) : curseur de reprise et événements déjà traités.
create table events.consumer_cursor (
  consumer text primary key,
  last_id bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table events.processed (
  consumer text not null,
  event_id uuid not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, event_id)
);

revoke all on schema events from public;
revoke all on all tables in schema events from public;
grant usage on schema events to chu_app;
grant select, insert on events.outbox to chu_app;
grant select, insert, update on events.consumer_cursor to chu_app;
grant select, insert on events.processed to chu_app;
