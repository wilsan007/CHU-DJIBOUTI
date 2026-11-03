# Plan de formation

Objectif : chaque agent sait faire **seul** les tâches de son métier dans l'application **avant** la bascule, et sait quoi faire
quand « ça ne marche pas ». Les durées et effectifs sont des propositions à ajuster avec les chefs de service.

## 1. Public et formats

| Public                                                   | Séance                                                                        | Durée  | Groupe | Support                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ | ------ | ------------------------------------------- |
| Réception, caisse                                        | Parcours patient de l'accueil à l'encaissement                                | 3 h    | 6 à 8  | fiches 1 et 2, scénarios A                  |
| Médecins                                                 | Consultation, ordonnance, demandes payées d'abord, urgence, valeurs critiques | 2 h 30 | 6 à 8  | fiche 3, scénarios B                        |
| Infirmiers, aides-soignants                              | Hospitalisation, soins, matériel                                              | 2 h    | 6 à 8  | fiches 4 et 7, scénarios C                  |
| Laboratoire                                              | Prélèvement, étiquette, validation en deux temps, critiques                   | 3 h    | 4 à 6  | fiche 5, scénarios D                        |
| Pharmacie, magasin                                       | Délivrance, stocks, recettes d'actes, manques                                 | 3 h    | 4 à 6  | fiches 6 et 7, scénarios E                  |
| Imagerie                                                 | Examen, images, compte rendu, liste de travail                                | 2 h    | 3 à 5  | fiche 8, scénarios F                        |
| RH, direction, administrateur                            | Personnel et gardes, tableau de bord, comptes                                 | 2 h    | 3 à 5  | fiches 9 et 10                              |
| **Super-utilisateurs** (1 ou 2 par service, volontaires) | Tout leur métier + dépannage de premier niveau                                | 1 jour | 6 à 10 | toutes les fiches + registre d'exploitation |
| Accueil (information patients)                           | Espace patient : comment l'expliquer                                          | 30 min | tous   | fiche 11                                    |

Règles : **pas plus de 8 personnes** par séance (chacun manipule), **jamais pendant le service** (remplacements planifiés), séance en
**français ou en arabe** au choix du groupe (l'application est bilingue ; les fiches existent dans les deux langues).

## 2. Environnement de formation

Une instance **séparée de la production**, avec **uniquement des données fictives** :

1. Démarrer une pile identique (voir `docs/runbooks/`) avec ses propres comptes `dev-*` (un par rôle ; mots de passe distincts de la production).
2. Charger le catalogue de formation (actes, payeurs, médicaments, analyses : **valeurs d'exemple**, jamais les vraies tarifs si le CHU ne le souhaite pas).
3. Charger des patients fictifs : `node tools/seed/src/cli.ts --out sortie --count 200` puis
   `POST /api/patients/import?apply=true` avec `sortie/patients-import.csv` (le jeu contient volontairement des **homonymes** pour
   s'exercer à la détection de doublons).
4. **Remise à zéro** de l'instance chaque soir de formation (nouvelle pile) : les stagiaires ne laissent aucune trace utile.

Un bandeau « FORMATION » est affiché sur cette instance : construire le portail avec `VITE_ENV_BANNER="FORMATION : données fictives"`.
Interdit : saisir un vrai patient dans l'instance de formation.

## 3. Déroulé type d'une séance (exemple : médecins, 2 h 30)

| Temps  | Contenu                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------ |
| 0 h 00 | Pourquoi « on paie d'abord » (ADR-0002) ; ce que cela change pour le médecin ; l'urgence vitale  |
| 0 h 20 | Démonstration par le formateur : un patient de bout en bout                                      |
| 0 h 50 | **Les stagiaires refont** le scénario B1, puis B2 (allergie + interaction), B3 (valeur critique) |
| 1 h 50 | Cas qui se passent mal : conflit de modification, constante impossible, ordonnance remplacée     |
| 2 h 15 | Évaluation (section 5) et questions                                                              |

## 4. Scénarios d'exercice

Voir `scenarios.md` : chaque scénario nomme les rôles, les étapes et **ce que l'on doit observer** (et qui sert de contrôle).

## 5. Évaluation (par personne)

Grille « acquis / à revoir » remplie par le formateur ; **une personne « à revoir » est reprise avant la bascule**.

| Rôle                | Critères d'acquis (tout doit être juste, sans aide)                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Réception           | Retrouve un patient existant ; sait refuser un doublon ; admet avec le bon payeur ; imprime la carte                                                                        |
| Caisse              | Ouvre la caisse ; encaisse espèces et mobile ; applique une remise avec motif ; crée un avoir ; clôture avec écart expliqué                                                 |
| Médecin             | Remplit une consultation ; signe une ordonnance avec alerte justifiée ; demande une analyse **et comprend qu'elle n'arrive qu'après paiement** ; accuse une valeur critique |
| Infirmier           | Crée un séjour, admet au lit après paiement, ajoute un soin, enregistre une sortie ; enregistre du matériel                                                                 |
| Laboratoire         | Prélève avec scan de la carte (refuse un mauvais patient) ; réceptionne ; rejette avec motif ; ne valide pas seul                                                           |
| Pharmacie / magasin | Délivre partiellement ; comprend un refus pour stock insuffisant ; reçoit un lot ; fait un transfert ; régularise un manque                                                 |
| Imagerie            | Programme, commence, lit les images, saisit un compte rendu ; repère un « identifiant différent »                                                                           |

## 6. Après la formation

- **Supervision en poste** (hypercare, voir `docs/bascule/plan-de-bascule.md`) : un super-utilisateur par service, présent.
- Fiche « problèmes rencontrés » à la porte de chaque service ; revue chaque soir la première semaine.
- Refaire une séance courte à **un mois** (questions réelles) et à **trois mois**.
