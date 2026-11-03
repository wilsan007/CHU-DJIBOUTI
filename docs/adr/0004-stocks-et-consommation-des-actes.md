# ADR-0004 : un seul module Stocks, et la consommation des actes

Date : 3 novembre 2026. Statut : appliqué. Source : consigne du CHU (sirops, seringues, réactifs, produits de radiologie et autres éléments consommés par les actes).

## Décision

1. **Un seul système de stock pour tout l'hôpital.** Les tables de stock de la pharmacie (dépôts, lots, soldes, mouvements, seuils, commandes) deviennent le module **Stocks** (schéma `stock`). Chaque produit est un **article** : médicament (créé automatiquement depuis le catalogue des médicaments), consommable, réactif ou fourniture. La pharmacie ne garde que la **délivrance sur ordonnance**.
2. **Qui gère quoi.** La pharmacie gère les médicaments ; le **magasinier** (rôle `storekeeper`, sans accès aux dossiers de patients) gère consommables, réactifs et fournitures. Les services (médecin, infirmier, laboratoire, imagerie) **consomment** sans gérer.
3. **Dépôts par service.** Un dépôt « approvisionne » un service : réserve du laboratoire, de l'imagerie, d'hospitalisation et bloc. Le magasin central alimente ces réserves par **transferts** (deux mouvements liés, sans stock négatif).
4. **Recette d'acte.** Chaque acte du catalogue peut avoir une recette : les articles et quantités qu'il consomme chaque fois qu'il est réalisé (ex. glycémie : 2 réactifs et 1 seringue ; radiographie : 1 film et 2 doses de contraste).
5. **Quand on consomme.** À la **fin du service**, quand le ticket du service est terminé (analyse validée, examen rapporté, acte d'hospitalisation ou de bloc terminé), un consommateur d'événements prélève la recette dans le dépôt du service, **premier périmé, premier sorti**, jamais un lot périmé, pour le patient concerné. Les soins courants d'un séjour consomment dès leur enregistrement.
6. **Stock insuffisant : l'acte n'est pas bloqué.** Il est déjà rendu. Ce qui existe est prélevé, le **manque est enregistré** et signalé au magasin (et au tableau de bord) jusqu'à régularisation avec explication écrite.
7. **Matériel hors acte.** Toute utilisation de matériel en plus (seringues supplémentaires pendant une opération) s'enregistre avec un motif et, si possible, le patient ; elle est refusée si le stock manque.
8. **Traçabilité.** Chaque sortie pour un patient (délivrance ou consommation) garde le lot et le patient : un rappel de lot retrouve tous les patients concernés, médicaments comme consommables.

## Conséquences

- La consommation passe par la règle de la caisse existante : seuls les actes payés et exécutés (ticket terminé) consomment.
- Les anciennes routes `/api/pharmacy/{depots,stock,orders,receipts,thresholds,inventory,lots}` sont remplacées par `/api/stock/...`.

Questions ouvertes : Q29, Q31, Q34 dans `docs/questions.md`.
