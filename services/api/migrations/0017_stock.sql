-- Module Stocks : un seul système de stock pour tout l'hôpital (médicaments, consommables, réactifs, fournitures).
-- Les tables de stock de la pharmacie passent dans le schéma `stock` ; la pharmacie ne garde que la délivrance sur ordonnance.

create schema stock;

alter table pharmacy.depots set schema stock;
alter table pharmacy.lots set schema stock;
alter table pharmacy.stock_levels set schema stock;
alter table pharmacy.movements set schema stock;
alter table pharmacy.thresholds set schema stock;
alter table pharmacy.purchase_orders set schema stock;
alter table pharmacy.purchase_order_lines set schema stock;

create table stock.counters (name text primary key, value bigint not null default 0);
insert into stock.counters (name, value)
  select 'purchase_order', value from pharmacy.counters where name = 'purchase_order';
insert into stock.counters (name) values ('transfer');
delete from pharmacy.counters where name = 'purchase_order';

-- Articles : médicaments (créés automatiquement depuis le catalogue des médicaments), consommables, réactifs, fournitures.
create table stock.items (
  code text primary key,
  label_fr text not null,
  label_ar text,
  kind text not null check (kind in ('drug', 'consumable', 'reagent', 'supply')),
  unit text not null default 'unité',
  active boolean not null default true,
  responsible text,
  updated_on date
);
insert into stock.items (code, label_fr, label_ar, kind)
  select code, dci || ' ' || strength || ' (' || form || ')', label_ar, 'drug' from catalog.drugs;

alter table stock.lots rename column drug_code to item_code;
alter table stock.thresholds rename column drug_code to item_code;
alter table stock.purchase_order_lines rename column drug_code to item_code;
alter table stock.lots drop constraint lots_drug_code_fkey;
alter table stock.thresholds drop constraint thresholds_drug_code_fkey;
alter table stock.purchase_order_lines drop constraint purchase_order_lines_drug_code_fkey;
alter table stock.lots add foreign key (item_code) references stock.items (code);
alter table stock.thresholds add foreign key (item_code) references stock.items (code);
alter table stock.purchase_order_lines add foreign key (item_code) references stock.items (code);

-- Un médicament du catalogue est toujours un article du stock.
create function stock.sync_drug_item() returns trigger language plpgsql as $$
begin
  insert into stock.items (code, label_fr, label_ar, kind)
  values (new.code, new.dci || ' ' || new.strength || ' (' || new.form || ')', new.label_ar, 'drug')
  on conflict (code) do update set label_fr = excluded.label_fr, label_ar = excluded.label_ar;
  return new;
end $$;
create trigger drugs_to_items after insert or update on catalog.drugs
  for each row execute function stock.sync_drug_item();

-- Dépôts : type, et service qu'ils approvisionnent (le dépôt d'un service est celui où sa consommation est prélevée).
alter table stock.depots
  add column kind text not null default 'store' check (kind in ('pharmacy', 'store', 'ward', 'lab', 'imaging', 'bloc')),
  add column serves_department text unique;
update stock.depots set kind = 'pharmacy';
insert into stock.depots (code, name, kind, serves_department) values
  ('MG', 'Magasin central', 'store', null),
  ('LAB', 'Réserve du laboratoire', 'lab', 'LAB'),
  ('IMG', 'Réserve de l''imagerie', 'imaging', 'IMG'),
  ('HOSP', 'Réserve d''hospitalisation et bloc', 'bloc', 'HOSP');

-- Le grand livre du stock : sorties pour un patient, consommations, transferts.
alter table stock.movements drop constraint movements_kind_check;
alter table stock.movements add constraint movements_kind_check
  check (kind in ('receipt', 'dispense', 'adjustment', 'consume', 'transfer_out', 'transfer_in'));
alter table stock.movements add column patient_id uuid;
create index movements_patient_idx on stock.movements (patient_id) where patient_id is not null;

-- Recettes d'actes : ce que consomme un acte (seringues, réactifs, produit de contraste, kit d'opération...).
create table stock.act_recipes (
  act_code text not null references catalog.acts (code),
  item_code text not null references stock.items (code),
  quantity integer not null check (quantity > 0),
  responsible text not null,
  updated_on date not null,
  primary key (act_code, item_code)
);

-- Consommation que le stock n'a pas pu couvrir : l'acte est fait, le manque est signalé et à régulariser.
create table stock.shortfalls (
  id bigint generated always as identity primary key,
  act_code text,
  item_code text not null references stock.items (code),
  depot_code text not null references stock.depots (code),
  missing integer not null check (missing > 0),
  patient_id uuid,
  ref_type text not null,
  ref_id text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text
);
create index shortfalls_open_idx on stock.shortfalls (created_at) where resolved_at is null;

revoke all on schema stock from public;
revoke all on all tables in schema stock from public;
grant usage on schema stock to chu_app;
grant select, insert, update on stock.counters, stock.items, stock.depots, stock.stock_levels, stock.thresholds,
  stock.purchase_orders, stock.purchase_order_lines, stock.shortfalls to chu_app;
grant select, insert, update, delete on stock.act_recipes to chu_app;
grant select, insert on stock.lots, stock.movements to chu_app;
grant usage, select on all sequences in schema stock to chu_app;
