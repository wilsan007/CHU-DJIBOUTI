-- Hospitalisation (F9).
-- Modèle de facturation (coutume de Djibouti) :
--  1. le forfait initial (première nuit et acte initial) se règle à la caisse avant l'entrée, avec ou sans remise ;
--  2. les nuits suivantes et les soins courants s'accumulent sans paiement quotidien, et forment la facture de sortie ;
--  3. tout acte lourd en cours de séjour est une demande à part, payée à la caisse avant exécution (règle de la caisse).

create schema hosp;
create table hosp.counters (name text primary key, value bigint not null default 0);
insert into hosp.counters (name) values ('stay');

-- Lits d'exemple, à remplacer par le plan réel du CHU.
create table hosp.beds (
  code text primary key,
  ward text not null,
  label text not null,
  active boolean not null default true
);
insert into hosp.beds (code, ward, label) values
  ('MED-01', 'Médecine', 'Médecine, lit 1'), ('MED-02', 'Médecine', 'Médecine, lit 2'),
  ('MED-03', 'Médecine', 'Médecine, lit 3'), ('CHIR-01', 'Chirurgie', 'Chirurgie, lit 1'),
  ('CHIR-02', 'Chirurgie', 'Chirurgie, lit 2');

create table hosp.stays (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  patient_id uuid not null,
  encounter_id uuid not null,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'admitted', 'discharge_pending', 'discharged', 'cancelled')),
  initial_order_id uuid not null,
  initial_order_number text not null,
  requested_by text not null,
  requested_by_name text,
  created_at timestamptz not null default now(),
  bed_code text references hosp.beds (code),
  admitted_at timestamptz,
  admitted_by text,
  discharge_ordered_at timestamptz,
  discharge_ordered_by text,
  nights integer,
  final_invoice_id uuid,
  exited_at timestamptz,
  exited_by text,
  exit_unpaid_reason text,
  constraint admitted_has_bed check ((status in ('admitted', 'discharge_pending')) = (bed_code is not null) or status = 'discharged' or status = 'cancelled')
);
create index stays_patient_idx on hosp.stays (patient_id);
create index stays_status_idx on hosp.stays (status);
-- Un lit ne peut avoir qu'un patient.
create unique index stays_one_patient_per_bed on hosp.stays (bed_code) where status in ('admitted', 'discharge_pending');
-- Un seul séjour en cours par patient.
create unique index stays_one_open_per_patient on hosp.stays (patient_id) where status in ('awaiting_payment', 'admitted', 'discharge_pending');

create table hosp.stay_orders (
  id bigint generated always as identity primary key,
  stay_id uuid not null references hosp.stays (id),
  order_id uuid not null unique,
  order_number text not null,
  kind text not null check (kind in ('initial', 'extra')),
  placed_by text not null,
  placed_at timestamptz not null default now()
);

-- Nuitées et soins courants, facturés à la sortie. Écriture en ajout ; seule la facturation renseigne la facture.
create table hosp.charges (
  id bigint generated always as identity primary key,
  stay_id uuid not null references hosp.stays (id),
  kind text not null check (kind in ('night', 'care')),
  night_date date,
  act_code text not null,
  quantity integer not null check (quantity > 0),
  unit_price integer not null check (unit_price >= 0),
  note text,
  added_by text not null,
  added_by_name text,
  added_at timestamptz not null default now(),
  invoice_id uuid,
  constraint night_has_date check ((kind = 'night') = (night_date is not null))
);
create unique index charges_one_night_per_date on hosp.charges (stay_id, night_date) where kind = 'night';

create function hosp.guard_charge() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Une charge de séjour ne se supprime pas.' using errcode = '42501';
  end if;
  if (old.id, old.stay_id, old.kind, old.night_date, old.act_code, old.quantity, old.unit_price, old.added_by, old.added_at)
     is distinct from (new.id, new.stay_id, new.kind, new.night_date, new.act_code, new.quantity, new.unit_price, new.added_by, new.added_at)
     or (old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id) then
    raise exception 'Une charge de séjour ne se modifie pas.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger charges_guard before update or delete on hosp.charges
  for each row execute function hosp.guard_charge();

revoke all on schema hosp from public;
revoke all on all tables in schema hosp from public;
grant usage on schema hosp to chu_app;
grant select, insert, update on hosp.counters, hosp.stays, hosp.charges to chu_app;
grant select, insert on hosp.stay_orders to chu_app;
grant select, insert, update on hosp.beds to chu_app;
grant usage, select on all sequences in schema hosp to chu_app;
