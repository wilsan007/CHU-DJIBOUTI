-- Distributeur d'événements (étapes 6.3 et 6.5) : échecs, reprises et file des événements abandonnés.

create table events.failures (
  consumer text not null,
  event_id uuid not null,
  attempts integer not null default 0,
  last_error text not null,
  next_attempt_at timestamptz not null,
  -- abandonné après trop d'essais : l'événement est mis de côté et signalé, les suivants continuent
  dead boolean not null default false,
  first_failed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (consumer, event_id)
);
create index failures_dead_idx on events.failures (dead) where dead;

grant select, insert, update, delete on events.failures to chu_app;
