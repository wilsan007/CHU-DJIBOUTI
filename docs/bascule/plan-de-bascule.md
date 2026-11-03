# Plan de bascule (passage du papier au système)

Principe : **ne jamais arrêter le papier avant d'être sûr du système.** On bascule service par service, avec une période de
double saisie, des critères d'arrêt clairs et un retour en arrière possible à chaque étape. Les dates sont à fixer avec la direction.

## 0. Avant de commencer : conditions préalables (liste de contrôle)

| #   | Condition                                                                                                 | Preuve attendue                                    | État                                 |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| 1   | Valeurs médicales validées par un référent (constantes limites, interactions, plages de référence, doses) | signature dans `docs/audit/catalogues`             | **à faire par le CHU**               |
| 2   | Catalogue des actes et tarifs réel, payeurs réels                                                         | import accepté sans rejet, validé par la direction | à faire par le CHU                   |
| 3   | Liste de médicaments (prix, DCI, allergies, interactions)                                                 | idem                                               | à faire par le CHU                   |
| 4   | Recettes d'actes (consommations par acte) des 10 actes les plus fréquents                                 | saisies et relues par le magasin                   | à faire par le CHU                   |
| 5   | Plan réel des lits                                                                                        | lits créés                                         | à faire par le CHU                   |
| 6   | Matériel : postes, imprimante (cartes, étiquettes), lecteurs de codes QR, réseau                          | essais sur place                                   | à faire par le CHU                   |
| 7   | Passerelle SMS choisie et testée                                                                          | message reçu sur un vrai téléphone                 | **à choisir** (WhatsApp : plus tard) |
| 8   | HTTPS avec certificat réel (DSI)                                                                          | page ouverte sans alerte                           | à faire (DSI)                        |
| 9   | Sauvegarde nocturne + copie hors serveur + **exercice de restauration sur la vraie machine**              | procès-verbal daté (`infra/backup/README.md`)      | à faire (DSI)                        |
| 10  | Formation : 100 % des agents « acquis » (grille du plan de formation)                                     | grilles remplies                                   | à faire                              |
| 11  | Comptes créés, un par agent, rôle minimal ; comptes `dev-*` **supprimés**                                 | liste relue par la direction                       | à faire                              |
| 12  | Audit de sécurité par une personne extérieure au projet                                                   | rapport                                            | recommandé                           |
| 13  | Version logicielle figée (étiquette Git), images Docker figées par condensat                              | notes de version                                   | à faire                              |

## 1. Reprise des données

- **Patients** : fichier CSV de l'ancien registre (`id_externe,prenom,nom,sexe,date_naissance,age_estime,telephone`) →
  `POST /api/patients/import` (**essai** : rien n'est écrit, résultat exact) → corriger les lignes « invalides » → relire les
  **doublons** (un humain tranche : même patient ou non) → `?apply=true`. Rejouable (identifiant d'origine reconnu).
  Les numéros de dossier sautent quand on fait des essais (la suite de numéros avance) : sans importance.
- **Pas de reprise des dossiers médicaux papier** : l'historique antérieur reste au dossier papier (décision à confirmer) ;
  seules l'identité et, plus tard, les allergies connues sont saisies.
- **Catalogues** : imports CSV avec essai (actes, payeurs, médicaments, analyses, diagnostics).
- **Stocks** : inventaire physique le jour J-1 (lot, péremption, quantité par dépôt) → réceptions initiales.

## 2. Étapes

| Étape                            | Contenu                                                                                                                 | Durée indicative | Critère pour passer à la suivante                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------- |
| E0 — Répétition générale         | Journée complète sur l'instance de formation avec tous les services, cas réels simulés                                  | 1 jour           | aucun blocage ; liste des corrections traitée                       |
| E1 — Pilote                      | **Un seul service** (ex. consultation externe : accueil, caisse, médecin) en réel, **double saisie** (papier + système) | 2 semaines       | 10 jours sans incident majeur ; écarts caisse = 0 ; agents à l'aise |
| E2 — Extension                   | + laboratoire, pharmacie, stocks (double saisie réduite : le papier devient secours)                                    | 2 semaines       | idem ; délais de résultat meilleurs ou égaux                        |
| E3 — Hospitalisation et imagerie | + séjours, lits, imagerie                                                                                               | 2 semaines       | idem                                                                |
| E4 — Bascule complète            | Le système est la **référence** ; le papier ne sert qu'en panne                                                         | —                | décision de la direction (go)                                       |
| E5 — Clôture du papier           | Fin de la double saisie, archivage des registres papier                                                                 | après 1 mois     | revue de fin de projet                                              |

**Incident majeur** = perte de données, résultat attribué au mauvais patient, caisse fausse, indisponibilité > 2 h en service.
Un incident majeur **suspend** l'extension jusqu'à correction et nouvelle répétition.

## 3. Jour J d'une étape (exemple E1)

| Heure         | Action                                                                                                   | Responsable                         |
| ------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| J-1           | Sauvegarde manuelle + vérification ; comptes testés ; inventaire stocks ; impression des cartes du jour  | DSI, super-utilisateurs             |
| J 07 h 30     | Réunion de lancement du service (10 min) ; rappel : **on paie d'abord** ; qui appeler en cas de problème | chef de service                     |
| J 08 h → 16 h | Super-utilisateur **présent en continu** dans le service ; registre des problèmes ouvert                 | super-utilisateur                   |
| J 16 h 30     | Rapprochement caisse papier / système ; revue des problèmes                                              | caissier principal, chef de service |
| J 17 h        | Point avec le projet : corrections urgentes ou non                                                       | chef de projet                      |
| J+1           | Sauvegarde vérifiée ; décision de continuer                                                              | DSI                                 |

## 4. Mode dégradé (panne) — à afficher dans chaque service

1. **Ne pas improviser** : passer au **papier de secours** (formulaires préimprimés : admission, demande d'analyse, ordonnance, reçu).
2. Appeler la DSI (numéro affiché) ; noter l'heure de début.
3. À la reprise, **ressaisir** dans l'ordre : admissions → paiements → demandes → résultats ; un agent relit.
4. Les services ne travaillent **pas à crédit** parce que le système est en panne, sauf urgence vitale (la caisse régularise ensuite, comme dans le système).
5. Panne > 4 h : prévenir la direction ; envisager le retour au papier complet.

## 5. Retour en arrière (si la bascule échoue)

- Étapes E1 à E3 : **le papier est resté la référence** ; on arrête simplement la saisie système du service concerné, on garde les
  données saisies (elles restent consultables), on corrige, on refait la répétition.
- Étape E4 : retour au papier avec **ressaisie** de ce qui a été fait uniquement dans le système (impression des listes du jour :
  admissions, factures, ordonnances, résultats).
- Données : aucune suppression ; une erreur de saisie se corrige par version / avoir (rien ne s'efface, par construction).

## 6. Supervision renforcée (hypercare, 4 semaines après chaque étape)

- Un super-utilisateur par service **en poste** la première semaine, **d'astreinte** ensuite.
- Réunion de 15 minutes chaque matin la première semaine (problèmes de la veille) puis hebdomadaire.
- Tableau suivi par le chef de projet : nombre d'appels, motifs, temps de résolution, écarts de caisse, délais de résultat, incidents.
- Indicateurs vus par la direction (écran « Direction ») : admissions, encaissements, urgences à régulariser, attente moyenne.

## 7. Communication

- **Patients** : affiche à l'accueil (« Nouveau : carte avec QR, espace patient par SMS ») ; explication de la règle « on paie à la
  caisse avant l'analyse ou la radio » ; les familles doivent savoir pourquoi un résultat n'est pas immédiat.
- **Agents** : message de la direction avant chaque étape ; numéro de la DSI sur chaque poste.
- **Autorités** : information du ministère de la Santé selon les règles du CHU.

## 8. Qui décide

| Décision                          | Qui                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Passer à l'étape suivante         | direction, sur avis du chef de projet et des chefs de service                   |
| Arrêter / revenir en arrière      | direction ou chef de service concerné (en cas d'incident majeur, sans attendre) |
| Corriger un tarif ou un catalogue | direction (tarifs), biologiste (analyses), pharmacien (médicaments)             |
