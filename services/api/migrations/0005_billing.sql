-- Facturation et caisse (F2). Numérotation continue sans trou, factures non modifiables, paiement unique.

create schema billing;

-- Compteurs à numérotation continue : la ligne est verrouillée par l'émetteur ; une transaction
-- annulée rend son numéro. Aucun trou.
create table billing.counters (
  name text primary key,
  value bigint not null default 0
);
insert into billing.counters (name) values ('invoice'), ('credit_note'), ('receipt');

create table billing.encounters (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  department_code text not null,
  payer_code text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  opened_by text not null,
  closed_at timestamptz
);
create index encounters_patient_idx on billing.encounters (patient_id, opened_at);

create table billing.invoices (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('invoice', 'credit_note')),
  number text not null unique,
  encounter_id uuid references billing.encounters (id),
  -- Demande de prestations du médecin à laquelle la facture se rapporte (identifiant du module des demandes).
  order_id uuid,
  order_number text,
  patient_id uuid not null,
  payer_code text not null,
  total integer not null,
  patient_amount integer not null,
  payer_amount integer not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'credited')),
  credit_of uuid references billing.invoices (id),
  credit_reason text,
  issued_at timestamptz not null default now(),
  issued_by text not null,
  paid_at timestamptz,
  constraint amounts_add_up check (patient_amount + payer_amount = total),
  constraint sign_matches_kind check (
    (kind = 'invoice' and total >= 0 and patient_amount >= 0 and payer_amount >= 0)
    or (kind = 'credit_note' and total <= 0 and patient_amount <= 0 and payer_amount <= 0)
  ),
  constraint credit_note_references check ((kind = 'credit_note') = (credit_of is not null))
);
create index invoices_status_idx on billing.invoices (status, issued_at);
create index invoices_patient_idx on billing.invoices (patient_id);
create unique index invoices_one_per_order_idx on billing.invoices (order_id) where order_id is not null and kind = 'invoice';

create table billing.invoice_lines (
  id bigint generated always as identity primary key,
  invoice_id uuid not null references billing.invoices (id),
  act_code text not null,
  label_fr text not null,
  label_ar text not null,
  department_code text not null,
  unit_price integer not null,
  quantity integer not null check (quantity <> 0),
  line_total integer not null
);
create index invoice_lines_invoice_idx on billing.invoice_lines (invoice_id);

create table billing.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  cashier_id text not null,
  cashier_name text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  expected_cash integer,
  counted_cash integer,
  difference integer
);
create unique index cash_sessions_one_open_idx on billing.cash_sessions (cashier_id) where closed_at is null;

create table billing.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references billing.invoices (id),
  amount integer not null check (amount >= 0),
  method text not null check (method in ('cash', 'mobile', 'card', 'exempt')),
  receipt_number text not null unique,
  cashier_id text not null,
  cashier_name text,
  cash_session_id uuid not null references billing.cash_sessions (id),
  paid_at timestamptz not null default now(),
  constraint exempt_means_zero check ((method = 'exempt') = (amount = 0))
);
create index payments_paid_at_idx on billing.payments (paid_at);

-- Les lignes de facture et les paiements ne se modifient ni ne se suppriment jamais.
create function billing.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'Cette table est en ajout seul (%) : corrigez par un avoir.', tg_op using errcode = '42501';
end $$;
create trigger lines_no_change before update or delete on billing.invoice_lines
  for each row execute function billing.refuse_change();
create trigger payments_no_change before update or delete on billing.payments
  for each row execute function billing.refuse_change();

-- Une facture émise n'est plus modifiable : seuls son statut et sa date de paiement évoluent.
create function billing.guard_invoice() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Une facture ne se supprime pas : corrigez par un avoir.' using errcode = '42501';
  end if;
  if (old.id, old.kind, old.number, old.encounter_id, old.order_id, old.order_number, old.patient_id, old.payer_code,
      old.total, old.patient_amount, old.payer_amount, old.credit_of, old.issued_at, old.issued_by)
     is distinct from
     (new.id, new.kind, new.number, new.encounter_id, new.order_id, new.order_number, new.patient_id, new.payer_code,
      new.total, new.patient_amount, new.payer_amount, new.credit_of, new.issued_at, new.issued_by) then
    raise exception 'Une facture émise n''est plus modifiable : corrigez par un avoir.' using errcode = '42501';
  end if;
  if old.status <> new.status and not (
       (old.status = 'pending' and new.status in ('paid', 'credited'))
    or (old.status = 'paid' and new.status = 'credited')) then
    raise exception 'Changement de statut interdit : % vers %.', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger invoices_guard before update or delete on billing.invoices
  for each row execute function billing.guard_invoice();

revoke all on schema billing from public;
revoke all on all tables in schema billing from public;
grant usage on schema billing to chu_app;
grant select, update on billing.counters to chu_app;
grant select, insert, update on billing.encounters to chu_app;
grant select, insert, update on billing.invoices to chu_app;
grant select, insert on billing.invoice_lines to chu_app;
grant select, insert, update on billing.cash_sessions to chu_app;
grant select, insert on billing.payments to chu_app;
grant usage, select on all sequences in schema billing to chu_app;
