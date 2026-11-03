-- Module identité (F1) : index maître des patients.
-- L'identifiant public est généré par une séquence : il n'est jamais réutilisé.

create sequence identity.patient_number_seq;
create sequence identity.provisional_number_seq;

create table identity.patients (
  id uuid primary key default gen_random_uuid(),
  identifier text not null unique,
  kind text not null check (kind in ('regular', 'provisional')),
  status text not null default 'active' check (status in ('active', 'merged')),
  merged_into uuid references identity.patients (id),
  -- Identifiant dans un système d'origine (reprise de données, jeu fictif). Unique : sert à l'idempotence.
  external_id text unique,
  given_name text,
  family_name text,
  sex text check (sex in ('female', 'male')),
  birth_date date,
  age_estimated boolean not null default false,
  phone text,
  phone_digits text,
  note text,
  -- Noms normalisés (minuscules, sans accents, mots triés) : base de la recherche tolérante aux fautes.
  name_norm text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null,
  updated_at timestamptz not null default now(),
  constraint regular_requires_identity check (
    kind <> 'regular' or (
      given_name is not null and family_name is not null and sex is not null
      and birth_date is not null and phone is not null
    )
  ),
  constraint merged_requires_target check ((status = 'merged') = (merged_into is not null)),
  constraint no_self_merge check (merged_into is null or merged_into <> id)
);

create index patients_name_trgm_idx on identity.patients using gin (name_norm gin_trgm_ops);
create index patients_phone_idx on identity.patients (phone_digits);
create index patients_birth_idx on identity.patients (birth_date);
create index patients_status_idx on identity.patients (status, kind);

revoke all on schema identity from public;
revoke all on all tables in schema identity from public;
grant usage on schema identity to chu_app;
grant select, insert, update on identity.patients to chu_app;
grant usage, select on sequence identity.patient_number_seq, identity.provisional_number_seq to chu_app;
