-- Remises (hospitalisation et autres) : décidées à la caisse avant le paiement, avec motif et auteur.
-- La facture reste intacte (total et parts) ; la remise réduit seulement ce que le patient paie.

alter table billing.invoices
  add column discount_amount integer not null default 0 check (discount_amount >= 0),
  add column discount_percent numeric(5, 2),
  add column discount_reason text,
  add column discount_by text,
  add column discount_by_name text,
  add column discount_at timestamptz,
  add constraint discount_within_patient_amount check (kind <> 'invoice' or discount_amount <= patient_amount),
  add constraint discount_has_author check ((discount_amount > 0) = (discount_by is not null and discount_reason is not null));

create table billing.settings (key text primary key, value text not null, updated_by text, updated_at timestamptz not null default now());
-- Plafond de remise accordé à la caisse seule : valeur d'exemple (A-VALIDER-DIRECTION). Au-delà : la direction.
insert into billing.settings (key, value) values ('max_discount_percent', '10');
grant select, insert, update on billing.settings to chu_app;

create or replace function billing.guard_invoice() returns trigger language plpgsql as $$
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
  -- La remise ne se décide que tant que la facture attend son paiement ; ensuite elle est figée.
  if old.status <> 'pending'
     and (old.discount_amount, old.discount_percent, old.discount_reason, old.discount_by, old.discount_at)
         is distinct from
         (new.discount_amount, new.discount_percent, new.discount_reason, new.discount_by, new.discount_at) then
    raise exception 'La remise d''une facture payée ou annulée ne se modifie plus.' using errcode = '42501';
  end if;
  if old.status <> new.status and not (
       (old.status = 'pending' and new.status in ('paid', 'credited'))
    or (old.status = 'paid' and new.status = 'credited')) then
    raise exception 'Changement de statut interdit : % vers %.', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;
