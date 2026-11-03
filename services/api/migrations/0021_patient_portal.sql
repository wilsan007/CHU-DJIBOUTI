-- Portail patient : connexion par code à usage unique envoyé par SMS au numéro enregistré (pas de mot de passe à retenir,
-- pas de compte à créer). Le code n'est jamais stocké en clair ; les tentatives sont comptées ; la session est révocable.
create schema portal;

create table portal.otp_challenges (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  salt text not null,
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz
);
create index otp_patient_idx on portal.otp_challenges (patient_id, created_at desc);

-- Journal des demandes (pour limiter par adresse, y compris pour des identifiants qui n'existent pas).
create table portal.request_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('otp_request', 'otp_verify')),
  ip text not null
);
create index request_log_idx on portal.request_log (ip, kind, at desc);

create table portal.sessions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_patient_idx on portal.sessions (patient_id);

grant usage on schema portal to chu_app;
grant select, insert, update on portal.otp_challenges, portal.sessions to chu_app;
grant select, insert on portal.request_log to chu_app;
grant usage, select on all sequences in schema portal to chu_app;
