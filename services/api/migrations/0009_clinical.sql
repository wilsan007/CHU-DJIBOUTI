-- Dossier clinique (F4) : catalogues cliniques, consultations, constantes, diagnostics, allergies, pièces jointes.
--
-- Valeurs cliniques : tout ce qui est marqué « validated_by is null » est un exemple à faire valider
-- par un référent médical du CHU (étiquette A-VALIDER-MEDECIN du plan).

create extension if not exists unaccent;

/* ------------------------------------------------------------------ catalogues cliniques */

create table catalog.diagnoses (
  code text primary key,
  label_fr text not null,
  label_ar text not null,
  active boolean not null default true
);
create index diagnoses_label_idx on catalog.diagnoses using gin (label_fr gin_trgm_ops);

-- Une seule fiche par produit (F5-1) : DCI, forme et dosage.
create table catalog.drugs (
  code text primary key,
  dci text not null,
  form text not null,
  strength text not null,
  label_ar text,
  -- Classe servant à détecter une allergie (ex. penicillin). Fournie par le pharmacien.
  allergy_class text,
  -- Classe servant à repérer une interaction grave listée par le comité (ex. anticoagulant).
  interaction_class text,
  active boolean not null default true,
  responsible text not null,
  updated_on date not null,
  unique (dci, form, strength)
);
create index drugs_dci_idx on catalog.drugs using gin (dci gin_trgm_ops);

-- Posologies standard : n'existent que si elles ont été validées par un pharmacien ou un médecin (F5-2).
create table catalog.dosage_templates (
  id bigint generated always as identity primary key,
  drug_code text not null references catalog.drugs (code),
  dose numeric(8, 2) not null check (dose > 0),
  per_day integer not null check (per_day between 1 and 12),
  days integer not null check (days between 1 and 365),
  route text not null check (route in ('oral', 'injectable', 'cutaneous', 'other')),
  validated_by text not null,
  validated_on date not null
);

-- Interactions graves listées par le comité médical (F5-3). Les paires sont rangées par ordre alphabétique.
create table catalog.interactions (
  id bigint generated always as identity primary key,
  class_a text not null,
  class_b text not null,
  message_fr text not null,
  message_ar text not null,
  validated_by text not null,
  validated_on date not null,
  check (class_a < class_b),
  unique (class_a, class_b)
);

-- Limites de vraisemblance des constantes (F4-2) : « hard » refuse, « warn » demande confirmation.
create table catalog.vital_limits (
  kind text primary key check (kind in ('weight', 'height', 'systolic', 'diastolic', 'temperature', 'pulse', 'spo2')),
  unit text not null,
  hard_min numeric not null,
  hard_max numeric not null,
  warn_min numeric not null,
  warn_max numeric not null,
  validated_by text,
  check (hard_min <= warn_min and warn_min <= warn_max and warn_max <= hard_max)
);
insert into catalog.vital_limits (kind, unit, hard_min, hard_max, warn_min, warn_max) values
  ('weight', 'kg', 0.3, 400, 2, 250),
  ('height', 'cm', 30, 250, 45, 220),
  ('systolic', 'mmHg', 40, 300, 70, 220),
  ('diastolic', 'mmHg', 20, 200, 40, 130),
  ('temperature', 'celsius', 25, 45, 34, 41),
  ('pulse', 'per_minute', 20, 250, 40, 180),
  ('spo2', 'percent', 50, 100, 85, 100);

revoke all on catalog.diagnoses, catalog.drugs, catalog.dosage_templates, catalog.interactions, catalog.vital_limits from public;
grant select, insert, update on catalog.diagnoses, catalog.drugs to chu_app;
grant select, insert, update, delete on catalog.dosage_templates, catalog.interactions to chu_app;
grant select on catalog.vital_limits to chu_app;
grant usage, select on all sequences in schema catalog to chu_app;

/* ------------------------------------------------------------------ clinique */

create schema clinical;

create table clinical.templates (
  id bigint generated always as identity primary key,
  specialty text not null,
  name text not null,
  reason_text text not null default '',
  exam_text text not null default '',
  active boolean not null default true,
  unique (specialty, name)
);

create table clinical.consultations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  encounter_id uuid not null,
  practitioner_id text not null,
  practitioner_name text,
  status text not null default 'draft' check (status in ('draft', 'closed')),
  reason text not null default '',
  exam text not null default '',
  notes text not null default '',
  template_id bigint references clinical.templates (id),
  -- Contrôle de modification simultanée : chaque enregistrement augmente la version.
  version integer not null default 1,
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by text,
  constraint closed_has_author check ((status = 'closed') = (closed_at is not null))
);
create unique index consultations_one_draft_per_encounter_idx on clinical.consultations (encounter_id) where status = 'draft';
create index consultations_patient_idx on clinical.consultations (patient_id, opened_at);

create table clinical.vitals (
  id bigint generated always as identity primary key,
  consultation_id uuid not null references clinical.consultations (id),
  kind text not null,
  value numeric not null,
  unit text not null,
  measured_at timestamptz not null default now(),
  measured_by text not null,
  confirmed_unusual boolean not null default false
);
create index vitals_consultation_idx on clinical.vitals (consultation_id, kind, id);

create table clinical.consultation_diagnoses (
  consultation_id uuid not null references clinical.consultations (id),
  code text not null,
  label_fr text not null,
  label_ar text not null,
  is_primary boolean not null default false,
  added_by text not null,
  primary key (consultation_id, code)
);

create table clinical.allergies (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  substance_class text not null,
  label text not null,
  severity text not null default 'unknown' check (severity in ('mild', 'moderate', 'severe', 'unknown')),
  status text not null default 'active' check (status in ('active', 'entered_in_error')),
  recorded_by text not null,
  recorded_at timestamptz not null default now(),
  voided_by text,
  voided_at timestamptz
);
create index allergies_patient_idx on clinical.allergies (patient_id) where status = 'active';

create table clinical.attachments (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid references clinical.consultations (id),
  patient_id uuid not null,
  filename text not null,
  mime text not null check (mime in ('image/png', 'image/jpeg', 'application/pdf')),
  size integer not null check (size > 0),
  sha256 text not null,
  data bytea not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);
create index attachments_patient_idx on clinical.attachments (patient_id);

-- Comptes rendus archivés dans le dossier : jamais modifiés.
create table clinical.documents (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references clinical.consultations (id),
  kind text not null check (kind in ('report')),
  html text not null,
  sha256 text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create function clinical.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'Cette table est en ajout seul (%).', tg_op using errcode = '42501';
end $$;
create trigger documents_no_change before update or delete on clinical.documents
  for each row execute function clinical.refuse_change();
create trigger attachments_no_change before update or delete on clinical.attachments
  for each row execute function clinical.refuse_change();

-- Une consultation clôturée ne se modifie plus, ni ses constantes ni ses diagnostics.
create function clinical.guard_consultation() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Une consultation ne se supprime pas.' using errcode = '42501';
  end if;
  if old.status = 'closed' then
    raise exception 'Cette consultation est clôturée : elle ne se modifie plus.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger consultations_guard before update or delete on clinical.consultations
  for each row execute function clinical.guard_consultation();

create function clinical.require_draft() returns trigger language plpgsql as $$
declare
  cid uuid;
  st text;
begin
  cid := case when tg_op = 'DELETE' then old.consultation_id else new.consultation_id end;
  select status into st from clinical.consultations where id = cid;
  if st is distinct from 'draft' then
    raise exception 'La consultation est clôturée : plus de modification.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger vitals_need_draft before insert or update or delete on clinical.vitals
  for each row execute function clinical.require_draft();
create trigger diagnoses_need_draft before insert or update or delete on clinical.consultation_diagnoses
  for each row execute function clinical.require_draft();

revoke all on schema clinical from public;
revoke all on all tables in schema clinical from public;
grant usage on schema clinical to chu_app;
grant select, insert, update on clinical.templates, clinical.consultations, clinical.allergies to chu_app;
grant select, insert, delete on clinical.vitals, clinical.consultation_diagnoses to chu_app;
grant select, insert on clinical.attachments, clinical.documents to chu_app;
grant usage, select on all sequences in schema clinical to chu_app;
