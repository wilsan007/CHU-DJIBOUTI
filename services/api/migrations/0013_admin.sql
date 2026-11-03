-- Administration (F14) : registre local des comptes. Il permet de couper l'accès d'un compte immédiatement,
-- dans tous les modules, sans attendre l'expiration de son jeton Keycloak.

create schema admin;

create table admin.users (
  id text primary key,
  username text not null,
  roles text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'disabled')),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_by text,
  disabled_reason text,
  constraint disabled_has_author check ((status = 'disabled') = (disabled_at is not null))
);
create index users_status_idx on admin.users (status);

revoke all on schema admin from public;
revoke all on all tables in schema admin from public;
grant usage on schema admin to chu_app;
grant select, insert, update on admin.users to chu_app;
