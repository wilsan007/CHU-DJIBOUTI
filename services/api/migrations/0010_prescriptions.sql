-- Ordonnances (F5). Une ordonnance signée ne se modifie jamais : une révision crée une nouvelle version.

create schema prescriptions;

create table prescriptions.counters (name text primary key, value bigint not null default 0);
insert into prescriptions.counters (name) values ('prescription');

create table prescriptions.prescriptions (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  patient_id uuid not null,
  consultation_id uuid not null,
  prescriber_id text not null,
  prescriber_name text,
  status text not null default 'pending'
    check (status in ('pending', 'partially_dispensed', 'dispensed', 'superseded', 'cancelled')),
  -- Révision (F5-6) : cette ordonnance remplace la précédente ; renouvellement : copie d'une ancienne.
  supersedes uuid references prescriptions.prescriptions (id),
  renewal_of uuid references prescriptions.prescriptions (id),
  revision_reason text,
  signed_at timestamptz not null default now()
);
create index prescriptions_patient_idx on prescriptions.prescriptions (patient_id, signed_at);
create index prescriptions_status_idx on prescriptions.prescriptions (status, signed_at);

create table prescriptions.lines (
  id bigint generated always as identity primary key,
  prescription_id uuid not null references prescriptions.prescriptions (id),
  line_no integer not null,
  drug_code text not null,
  dci text not null,
  form text not null,
  strength text not null,
  dose numeric(8, 2) not null check (dose > 0),
  per_day integer not null check (per_day between 1 and 12),
  days integer not null check (days between 1 and 365),
  route text not null check (route in ('oral', 'injectable', 'cutaneous', 'other')),
  quantity integer not null check (quantity > 0),
  from_standard boolean not null default false,
  unique (prescription_id, line_no)
);

-- Alertes contournées : qui, pourquoi, sur quelle ligne. Exigées par le plan (F5-3), tracées aussi dans l'audit.
create table prescriptions.overrides (
  id bigint generated always as identity primary key,
  prescription_id uuid not null references prescriptions.prescriptions (id),
  kind text not null check (kind in ('allergy', 'interaction')),
  drug_code text not null,
  detail text not null,
  justification text not null,
  justified_by text not null,
  justified_at timestamptz not null default now()
);

create function prescriptions.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'Une ordonnance signée ne se modifie pas : créez une nouvelle version (%).', tg_op using errcode = '42501';
end $$;
create trigger lines_no_change before update or delete on prescriptions.lines
  for each row execute function prescriptions.refuse_change();
create trigger overrides_no_change before update or delete on prescriptions.overrides
  for each row execute function prescriptions.refuse_change();

-- Seuls le statut et le motif de révision d'une ordonnance évoluent.
create function prescriptions.guard_prescription() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Une ordonnance ne se supprime pas.' using errcode = '42501';
  end if;
  if (old.id, old.number, old.patient_id, old.consultation_id, old.prescriber_id, old.supersedes, old.renewal_of, old.signed_at)
     is distinct from
     (new.id, new.number, new.patient_id, new.consultation_id, new.prescriber_id, new.supersedes, new.renewal_of, new.signed_at) then
    raise exception 'Une ordonnance signée ne se modifie pas.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger prescriptions_guard before update or delete on prescriptions.prescriptions
  for each row execute function prescriptions.guard_prescription();

revoke all on schema prescriptions from public;
revoke all on all tables in schema prescriptions from public;
grant usage on schema prescriptions to chu_app;
grant select, insert, update on prescriptions.counters, prescriptions.prescriptions to chu_app;
grant select, insert on prescriptions.lines, prescriptions.overrides to chu_app;
grant usage, select on all sequences in schema prescriptions to chu_app;
