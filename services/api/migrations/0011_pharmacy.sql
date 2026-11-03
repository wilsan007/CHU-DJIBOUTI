-- Pharmacie (F6) : lots, stock par dépôt, délivrance sur ordonnance, commandes, inventaire.
-- Le stock ne se modifie que par des mouvements ajoutés (jamais modifiés ni supprimés) ; le solde d'un lot ne peut pas être négatif.

create schema pharmacy;

create table pharmacy.counters (name text primary key, value bigint not null default 0);
insert into pharmacy.counters (name) values ('dispensation'), ('purchase_order');

-- Dépôts d'exemple, à remplacer par ceux du CHU.
create table pharmacy.depots (
  code text primary key,
  name text not null,
  active boolean not null default true
);
insert into pharmacy.depots (code, name) values ('PC', 'Pharmacie centrale'), ('PU', 'Pharmacie des urgences');

create table pharmacy.lots (
  id uuid primary key default gen_random_uuid(),
  drug_code text not null references catalog.drugs (code),
  lot_number text not null,
  expires_on date not null,
  created_at timestamptz not null default now(),
  unique (drug_code, lot_number)
);

create table pharmacy.stock_levels (
  depot_code text not null references pharmacy.depots (code),
  lot_id uuid not null references pharmacy.lots (id),
  quantity integer not null check (quantity >= 0),
  primary key (depot_code, lot_id)
);

create table pharmacy.movements (
  id bigint generated always as identity primary key,
  depot_code text not null references pharmacy.depots (code),
  lot_id uuid not null references pharmacy.lots (id),
  quantity integer not null check (quantity <> 0),
  kind text not null check (kind in ('receipt', 'dispense', 'adjustment')),
  reason text,
  ref_type text,
  ref_id text,
  user_id text not null,
  user_name text,
  created_at timestamptz not null default now()
);
create index movements_lot_idx on pharmacy.movements (lot_id, created_at);

create table pharmacy.thresholds (
  drug_code text primary key references catalog.drugs (code),
  minimum integer not null check (minimum >= 0),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create table pharmacy.dispensations (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  prescription_id uuid not null references prescriptions.prescriptions (id),
  patient_id uuid not null,
  depot_code text not null references pharmacy.depots (code),
  pharmacist_id text not null,
  pharmacist_name text,
  created_at timestamptz not null default now()
);
create index dispensations_prescription_idx on pharmacy.dispensations (prescription_id);

create table pharmacy.dispensation_lines (
  id bigint generated always as identity primary key,
  dispensation_id uuid not null references pharmacy.dispensations (id),
  line_no integer not null,
  drug_code text not null,
  lot_id uuid not null references pharmacy.lots (id),
  quantity integer not null check (quantity > 0)
);
-- Traçabilité d'un lot : la liste des patients servis doit s'obtenir très vite (F6-6).
create index dispensation_lines_lot_idx on pharmacy.dispensation_lines (lot_id);
create index dispensation_lines_dispensation_idx on pharmacy.dispensation_lines (dispensation_id);

create table pharmacy.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  supplier text not null,
  status text not null default 'ordered'
    check (status in ('ordered', 'partially_received', 'received', 'cancelled')),
  created_by text not null,
  created_by_name text,
  created_at timestamptz not null default now()
);
create table pharmacy.purchase_order_lines (
  id bigint generated always as identity primary key,
  order_id uuid not null references pharmacy.purchase_orders (id),
  drug_code text not null references catalog.drugs (code),
  ordered integer not null check (ordered > 0),
  received integer not null default 0 check (received >= 0 and received <= ordered)
);

create function pharmacy.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'Cette écriture de la pharmacie ne se modifie ni ne se supprime (%).', tg_table_name using errcode = '42501';
end $$;
create trigger movements_no_change before update or delete on pharmacy.movements
  for each row execute function pharmacy.refuse_change();
create trigger dispensations_no_change before update or delete on pharmacy.dispensations
  for each row execute function pharmacy.refuse_change();
create trigger dispensation_lines_no_change before update or delete on pharmacy.dispensation_lines
  for each row execute function pharmacy.refuse_change();

revoke all on schema pharmacy from public;
revoke all on all tables in schema pharmacy from public;
grant usage on schema pharmacy to chu_app;
grant select, insert, update on pharmacy.counters, pharmacy.stock_levels, pharmacy.thresholds,
  pharmacy.purchase_orders, pharmacy.purchase_order_lines to chu_app;
grant select, insert on pharmacy.depots, pharmacy.lots, pharmacy.movements, pharmacy.dispensations,
  pharmacy.dispensation_lines to chu_app;
grant usage, select on all sequences in schema pharmacy to chu_app;
