-- Catalogues de référence (F2-2, F14-2) : services, payeurs, actes et tarifs.
-- Les actes, tarifs et payeurs sont importés depuis les CSV validés en phase 0 ; aucun tarif n'est inventé ici.

create schema catalog;

create table catalog.departments (
  code text primary key,
  name_fr text not null,
  name_ar text not null,
  active boolean not null default true
);

-- Services du CHU. Les codes sont utilisés par les droits (src/auth/permissions.ts) : ne pas les renommer.
insert into catalog.departments (code, name_fr, name_ar) values
  ('CONS', 'Consultation externe', 'العيادات الخارجية'),
  ('URG', 'Urgences', 'الطوارئ'),
  ('MAT', 'Maternité', 'الولادة'),
  ('LAB', 'Laboratoire', 'المختبر'),
  ('IMG', 'Imagerie', 'التصوير الطبي'),
  ('HOSP', 'Hospitalisation', 'الإيواء'),
  ('PHARM', 'Pharmacie', 'الصيدلية');

create table catalog.payers (
  code text primary key,
  name_fr text not null,
  name_ar text not null,
  -- Part payée par le patient, de 0 (gratuité) à 1 (paiement direct).
  patient_share numeric(4, 3) not null check (patient_share >= 0 and patient_share <= 1),
  active boolean not null default true,
  responsible text not null,
  updated_on date not null
);

create table catalog.acts (
  code text primary key,
  label_fr text not null,
  label_ar text not null,
  tariff integer not null check (tariff >= 0),
  department_code text not null references catalog.departments (code),
  category text not null check (category in ('consultation', 'laboratory', 'imaging', 'hospitalization', 'other')),
  active boolean not null default true,
  responsible text not null,
  updated_on date not null
);

-- Historique des changements de catalogue : qui, quand, avant, après.
create table catalog.history (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  changed_by text not null,
  catalog text not null,
  code text not null,
  before jsonb,
  after jsonb not null
);

revoke all on schema catalog from public;
revoke all on all tables in schema catalog from public;
grant usage on schema catalog to chu_app;
grant select on catalog.departments to chu_app;
grant select, insert, update on catalog.payers, catalog.acts to chu_app;
grant select, insert on catalog.history to chu_app;
