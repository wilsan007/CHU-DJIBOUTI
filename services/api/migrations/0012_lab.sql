-- Laboratoire (F7). Les demandes naissent des tickets libérés par la caisse (règle de la caisse, ADR-0002).
-- Un résultat validé ne se modifie plus. Les valeurs de référence et seuils critiques sont fournis par le biologiste.

create schema lab;

create table lab.counters (name text primary key, value bigint not null default 0);
insert into lab.counters (name) values ('request'), ('specimen');

-- Catalogue d'analyses relié aux codes LOINC ; chaque analyse correspond à un acte facturable du catalogue.
create table lab.tests (
  code text primary key,
  loinc text not null,
  act_code text not null unique references catalog.acts (code),
  label_fr text not null,
  label_ar text not null,
  specimen_type text not null,
  unit text,
  value_kind text not null default 'numeric' check (value_kind in ('numeric', 'text')),
  active boolean not null default true,
  responsible text not null,
  updated_on date not null
);

-- Valeurs de référence par sexe et tranche d'âge (en jours). Données du biologiste, jamais inventées par le système.
create table lab.reference_ranges (
  id bigint generated always as identity primary key,
  test_code text not null references lab.tests (code),
  sex text not null default 'any' check (sex in ('any', 'male', 'female')),
  age_min_days integer not null default 0,
  age_max_days integer not null default 54750,
  low numeric,
  high numeric,
  critical_low numeric,
  critical_high numeric,
  validated_by text not null,
  validated_on date not null,
  check (age_min_days <= age_max_days)
);
create index reference_ranges_test_idx on lab.reference_ranges (test_code);

create table lab.requests (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  ticket_id uuid not null unique,
  ticket_code text not null,
  order_id uuid not null,
  patient_id uuid not null,
  prescriber_id text not null,
  prescriber_name text,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);
create index lab_requests_patient_idx on lab.requests (patient_id);
create index lab_requests_status_idx on lab.requests (status, created_at);

create table lab.specimens (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  request_id uuid not null references lab.requests (id),
  specimen_type text not null,
  status text not null default 'collected' check (status in ('collected', 'received', 'rejected')),
  collected_by text not null,
  collected_by_name text,
  collected_at timestamptz not null default now(),
  received_by text,
  received_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,
  rejected_reason text
);
create index specimens_request_idx on lab.specimens (request_id);

create table lab.request_tests (
  id bigint generated always as identity primary key,
  request_id uuid not null references lab.requests (id),
  act_code text not null,
  -- Nul si l'acte demandé n'a pas encore d'analyse configurée : le laboratoire le voit et ne peut pas le prélever.
  test_code text references lab.tests (code),
  specimen_id uuid references lab.specimens (id)
);
create index request_tests_request_idx on lab.request_tests (request_id);

create table lab.results (
  id bigint generated always as identity primary key,
  request_test_id bigint not null unique references lab.request_tests (id),
  specimen_id uuid not null references lab.specimens (id),
  test_code text not null references lab.tests (code),
  value_numeric numeric,
  value_text text,
  unit text,
  flag text not null check (flag in ('normal', 'low', 'high', 'critical_low', 'critical_high', 'none')),
  ref_low numeric,
  ref_high numeric,
  source text not null default 'manual',
  status text not null default 'entered' check (status in ('entered', 'tech_validated', 'validated')),
  entered_by text not null,
  entered_by_name text,
  entered_at timestamptz not null default now(),
  tech_by text,
  tech_by_name text,
  tech_at timestamptz,
  bio_by text,
  bio_by_name text,
  bio_at timestamptz,
  check ((value_numeric is not null) <> (value_text is not null))
);
create index results_specimen_idx on lab.results (specimen_id);

create function lab.guard_result() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Un résultat ne se supprime pas.' using errcode = '42501';
  end if;
  if old.status = 'validated' then
    raise exception 'Un résultat validé ne se modifie plus : demandez un nouvel examen.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger results_guard before update or delete on lab.results
  for each row execute function lab.guard_result();

-- Notifications au prescripteur : rejet d'échantillon, valeur critique (avec accusé de réception), escalade.
create table lab.notifications (
  id bigint generated always as identity primary key,
  recipient_id text not null,
  kind text not null check (kind in ('rejection', 'critical', 'escalation')),
  request_id uuid not null references lab.requests (id),
  result_id bigint references lab.results (id),
  patient_id uuid not null,
  message text not null,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text,
  escalated_at timestamptz
);
create index notifications_recipient_idx on lab.notifications (recipient_id, created_at);
create index notifications_open_idx on lab.notifications (kind, created_at) where acknowledged_at is null;

create table lab.settings (key text primary key, value text not null, updated_by text, updated_at timestamptz not null default now());
-- Délai d'accusé : valeur d'exemple, à fixer par le biologiste (A-VALIDER-BIOLOGISTE).
insert into lab.settings (key, value) values ('critical_ack_minutes', '30'), ('escalation_user', '');

create table lab.analyzer_mappings (
  analyzer text not null,
  analyzer_code text not null,
  test_code text not null references lab.tests (code),
  primary key (analyzer, analyzer_code)
);

create table lab.qc_targets (
  test_code text not null references lab.tests (code),
  level text not null,
  mean numeric not null,
  sd numeric not null check (sd > 0),
  set_by text not null,
  set_on date not null,
  primary key (test_code, level)
);
create table lab.qc_runs (
  id bigint generated always as identity primary key,
  test_code text not null references lab.tests (code),
  level text not null,
  value numeric not null,
  z_score numeric not null,
  status text not null check (status in ('ok', 'warning', 'reject')),
  run_by text not null,
  run_at timestamptz not null default now()
);
create index qc_runs_idx on lab.qc_runs (test_code, level, run_at);

create function lab.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'Cette écriture du laboratoire ne se modifie ni ne se supprime (%).', tg_table_name using errcode = '42501';
end $$;
create trigger qc_runs_no_change before update or delete on lab.qc_runs
  for each row execute function lab.refuse_change();

revoke all on schema lab from public;
revoke all on all tables in schema lab from public;
grant usage on schema lab to chu_app;
grant select, insert, update on lab.counters, lab.tests, lab.requests, lab.specimens, lab.request_tests,
  lab.results, lab.notifications, lab.settings, lab.qc_targets to chu_app;
grant select, insert, update, delete on lab.reference_ranges, lab.analyzer_mappings to chu_app;
grant select, insert on lab.qc_runs to chu_app;
grant usage, select on all sequences in schema lab to chu_app;
