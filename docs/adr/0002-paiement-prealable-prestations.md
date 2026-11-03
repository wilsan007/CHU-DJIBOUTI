# ADR-0002 : paiement préalable à la caisse pour les prestations demandées par le médecin

- **Statut** : acceptée par le commanditaire du projet (règle métier énoncée dans la conversation de cadrage) ; validation écrite du chef de projet et de la direction financière à recueillir
- **Date** : 3 novembre 2026

## Contexte

Un patient arrive et paie la consultation prévue. Le médecin lui demande ensuite des prestations supplémentaires :
analyses, radio, hospitalisation. Ces prestations doivent être facturées avant d'être rendues, et l'on doit pouvoir
retrouver qui les a demandées, qui a encaissé et si le ticket est bien parti au service concerné.

## Décision

1. Le médecin (ou l'infirmier) enregistre une **demande de prestations**. Elle est « en attente de paiement » et
   la facture correspondante arrive à la caisse.
2. Seule la **caisse** encaisse la part du patient et **valide** le paiement. Aucun autre rôle n'a ce droit
   (permission `billing:pay`).
3. C'est la validation de la caisse, et elle seule, qui **libère** la demande : un **ticket** est créé et envoyé à
   chaque service concerné. Le **bon de prestations** remis au patient n'est disponible qu'à ce moment.
4. **Sans ticket, un service ne peut pas activer la prestation.** Le ticket n'existe pas avant la validation, et la base
   de données refuse la création d'un ticket pour une demande non libérée.
5. Chaque étape est tracée dans `orders.order_events` (en ajout seul) : qui a demandé, qui a validé à la caisse
   (nom, heure, reçu), envoi aux services, remise du bon, qui a démarré et terminé chaque prestation.
6. Prise en charge totale (gratuité, assurance à 100 %) : la caisse valide quand même, en mode « exempt » (montant nul).
7. Une correction passe par un **avoir** : il annule la demande tant qu'aucun service n'a commencé ; sinon la demande
   est conservée et la trace signale le cas à la direction.

## Conséquences

- Plus simple à auditer : un seul chemin de la demande à la prestation, avec un responsable à chaque étape.
- Plus lourd pour le patient : un passage à la caisse entre la demande et la prestation.
- Le circuit repose sur le distributeur d'événements : si un consommateur tombe en panne, la caisse reste utilisable mais
  le ticket attend ; l'événement échoué est visible dans la file des échecs et déclenche une alerte.
- **Point non traité volontairement : les urgences vitales.** La règle est appliquée sans exception, comme demandé.
  Voir `docs/questions.md` (Q6) : un mode d'urgence avec régularisation à posteriori reste à décider par la direction médicale.

## Autres options étudiées

- Libérer le ticket dès la demande et facturer ensuite : écartée, elle ne garantit pas le paiement avant la prestation.
- Laisser chaque service encaisser : écartée, elle disperse l'encaissement et affaiblit le contrôle.
