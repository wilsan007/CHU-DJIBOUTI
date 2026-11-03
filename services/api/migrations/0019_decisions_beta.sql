-- Décisions par défaut de la version bêta (voir docs/decisions-beta.md).

-- Q1 : un patient sans téléphone peut être enregistré (beaucoup de patients n'en ont pas).
alter table identity.patients drop constraint regular_requires_identity;
alter table identity.patients add constraint regular_requires_identity check (
  kind <> 'regular' or (given_name is not null and family_name is not null and sex is not null and birth_date is not null)
);

-- Q6 : urgence vitale. Le médecin justifie par écrit ; les services reçoivent leur ticket avant le paiement,
-- qui régularise ensuite à la caisse. Tout est tracé.
alter table orders.service_orders
  add column emergency boolean not null default false,
  add column emergency_justification text,
  add constraint emergency_has_justification check (not emergency or emergency_justification is not null);

-- Q31 : une réserve pour les urgences et une pour la maternité, comme pour les autres services.
insert into stock.depots (code, name, kind, serves_department) values
  ('URG', 'Réserve des urgences', 'ward', 'URG'),
  ('MAT', 'Réserve de la maternité', 'ward', 'MAT');
