-- Demandes de prestations du médecin, avec paiement préalable à la caisse.
--
-- Règle (ADR-0002) : le médecin demande des prestations supplémentaires (analyses, radio, hospitalisation).
-- La demande reste « en attente de paiement » tant que la caisse n'a pas encaissé et validé. Alors seulement,
-- un ticket est envoyé à chaque service concerné. Sans ticket, un service ne peut pas être activé.
-- Chaque étape est tracée : qui a demandé, qui a validé à la caisse, quand le ticket est parti, qui a exécuté.

create schema orders;

create table orders.counters (
  name text primary key,
  value bigint not null default 0
);
insert into orders.counters (name) values ('order');

create table orders.service_orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  patient_id uuid not null,
  encounter_id uuid not null,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'released', 'completed', 'cancelled')),
  placed_by text not null,
  placed_by_name text,
  placed_at timestamptz not null default now(),
  note text,
  released_at timestamptz,
  released_by text,
  released_by_name text,
  constraint released_has_author check ((released_at is null) = (released_by is null))
);
create index service_orders_patient_idx on orders.service_orders (patient_id);
create index service_orders_status_idx on orders.service_orders (status);

create table orders.service_order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references orders.service_orders (id),
  act_code text not null,
  label_fr text not null,
  label_ar text not null,
  quantity integer not null check (quantity > 0),
  unit_price integer not null,
  department_code text not null
);
create index order_items_order_idx on orders.service_order_items (order_id);

-- Un ticket par service concerné, créé seulement à la validation de la caisse.
create table orders.department_tickets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders.service_orders (id),
  code text not null unique,
  department_code text not null,
  status text not null default 'sent' check (status in ('sent', 'in_progress', 'completed', 'cancelled')),
  released_at timestamptz not null default now(),
  released_by text not null,
  released_by_name text,
  started_by text,
  started_by_name text,
  started_at timestamptz,
  completed_by text,
  completed_by_name text,
  completed_at timestamptz,
  unique (order_id, department_code)
);
create index tickets_department_idx on orders.department_tickets (department_code, status);

-- Trace complète d'une demande, en ajout seul.
create table orders.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references orders.service_orders (id),
  at timestamptz not null default now(),
  step text not null,
  actor_id text not null,
  actor_name text,
  actor_role text,
  detail jsonb not null default '{}'::jsonb
);
create index order_events_order_idx on orders.order_events (order_id, id);

create function orders.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'La trace des demandes est en ajout seul (%).', tg_op using errcode = '42501';
end $$;
create trigger order_events_no_change before update or delete on orders.order_events
  for each row execute function orders.refuse_change();
create trigger order_items_no_change before update or delete on orders.service_order_items
  for each row execute function orders.refuse_change();

-- Garde de dernier recours : même une erreur de code ne peut pas créer un ticket pour une demande
-- que la caisse n'a pas libérée. Le ticket n'existe que pour une demande « released ».
create function orders.require_released_order() returns trigger language plpgsql as $$
declare
  order_status text;
begin
  select status into order_status from orders.service_orders where id = new.order_id;
  if order_status is distinct from 'released' then
    raise exception 'Aucun ticket sans validation de la caisse (demande en état %).', coalesce(order_status, 'inconnu')
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger tickets_need_release before insert on orders.department_tickets
  for each row execute function orders.require_released_order();

revoke all on schema orders from public;
revoke all on all tables in schema orders from public;
grant usage on schema orders to chu_app;
grant select, insert, update on orders.counters to chu_app;
grant select, insert, update on orders.service_orders to chu_app;
grant select, insert on orders.service_order_items to chu_app;
grant select, insert, update on orders.department_tickets to chu_app;
grant select, insert on orders.order_events to chu_app;
grant usage, select on all sequences in schema orders to chu_app;
