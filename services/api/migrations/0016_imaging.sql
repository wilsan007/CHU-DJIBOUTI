-- Imagerie (F8). Les demandes naissent des tickets IMG libérés par la caisse (règle de la caisse, ADR-0002).
-- Les images sont rangées en base pour cette première version ; un serveur DICOM (Orthanc) viendra ensuite (question Q28).

create schema imaging;
create table imaging.counters (name text primary key, value bigint not null default 0);
insert into imaging.counters (name) values ('request'), ('accession');

-- Un examen par acte demandé.
create table imaging.requests (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  ticket_id uuid not null,
  ticket_code text not null,
  order_id uuid not null,
  patient_id uuid not null,
  prescriber_id text not null,
  prescriber_name text,
  act_code text not null,
  label_fr text not null,
  label_ar text not null,
  status text not null default 'pending' check (status in ('pending', 'scheduled', 'in_progress', 'reported')),
  scheduled_for timestamptz,
  scheduled_by text,
  accession text unique,
  performed_by text,
  performed_at timestamptz,
  created_at timestamptz not null default now()
);
create index imaging_requests_patient_idx on imaging.requests (patient_id);
create index imaging_requests_ticket_idx on imaging.requests (ticket_id);
create index imaging_requests_status_idx on imaging.requests (status, created_at);

create table imaging.images (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references imaging.requests (id),
  filename text not null,
  mime text not null,
  size integer not null,
  sha256 text not null,
  data bytea not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);
create index images_request_idx on imaging.images (request_id);

-- Comptes rendus versionnés : une correction ajoute une version, l'ancienne reste consultable.
create table imaging.reports (
  id bigint generated always as identity primary key,
  request_id uuid not null references imaging.requests (id),
  version integer not null,
  findings text not null,
  conclusion text not null,
  reported_by text not null,
  reported_by_name text,
  reported_at timestamptz not null default now(),
  unique (request_id, version)
);

create function imaging.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'Cette écriture de l''imagerie ne se modifie ni ne se supprime (%).', tg_table_name using errcode = '42501';
end $$;
create trigger images_no_change before update or delete on imaging.images for each row execute function imaging.refuse_change();
create trigger reports_no_change before update or delete on imaging.reports for each row execute function imaging.refuse_change();

revoke all on schema imaging from public;
revoke all on all tables in schema imaging from public;
grant usage on schema imaging to chu_app;
grant select, insert, update on imaging.counters, imaging.requests to chu_app;
grant select, insert on imaging.images, imaging.reports to chu_app;
grant usage, select on all sequences in schema imaging to chu_app;
