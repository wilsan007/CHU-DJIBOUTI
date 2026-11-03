# Plateforme hospitalière du CHU de Djibouti

Noyau applicatif du système d'information hospitalier : identité patient, admission et facturation, rendez-vous,
consultation, ordonnances, pharmacie, laboratoire. Ce dépôt suit le **plan de réalisation détaillé** (révision n° 1) ;
la décision d'architecture est dans [`docs/adr/0001-noyau-applicatif-leger.md`](docs/adr/0001-noyau-applicatif-leger.md).

> Données fictives uniquement en développement et en test. Jamais de vraies données de patients.

## État d'avancement

| Étape du plan                                                                              | État                                                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Section 3 : préparation (versions, dépôt, intégration continue, secrets, données fictives) | Faite, voir ci-dessous                                                                                              |
| Phase 0 : audit et cadrage                                                                 | À faire sur le terrain ; modèles prêts dans `docs/audit/`                                                           |
| Phase 1 : socle (API, migrations, authentification, audit, outbox)                         | Étapes 5.2, 5.3, 5.5 et 5.6 faites et testées ; Keycloak, Nginx, supervision, sauvegarde, `make up` restent à faire |
| Module F1 identité patient (phase 4)                                                       | Fait et testé (F1-1 à F1-6), en avance sur le calendrier du plan                                                    |
| Phases 2, 3, 5, 6                                                                          | À faire                                                                                                             |

La validation **V0** du plan (« un nouvel arrivant clone le dépôt et obtient un environnement vide qui démarre en
moins de 30 minutes ») n'est **pas encore atteinte** : il manque les fichiers Docker Compose de la phase 1.
Aujourd'hui, `make check` et `make seed` fonctionnent ; l'API se lance avec une base PostgreSQL (voir `services/api/README.md`).

## Démarrer

Prérequis : Git, Node.js 22.18 ou plus récent, pnpm (version fixée dans `package.json`), PostgreSQL 16 ou plus pour les tests
(sans variable d'environnement, `pnpm test` démarre un PostgreSQL temporaire à partir des binaires installés).

```bash
make install      # dépendances
make check        # contrôle du dépôt, style, types, analyse, tests
make seed         # 200 patients fictifs dans tools/seed/out/dataset.json
```

Autres commandes : `make help`.

## Organisation

| Dossier                                                         | Contenu                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `services/api`                                                  | Noyau applicatif (modules, migrations SQL, audit, événements)    |
| `packages/events`                                               | Schémas des événements entre modules                             |
| `packages/i18n`                                                 | Textes FR et AR (jamais de texte en dur dans le code)            |
| `tools/seed`                                                    | Générateur de données fictives, reproductible                    |
| `tools/repo-check`                                              | Refuse les secrets et fichiers sensibles dans le dépôt           |
| `tools/test-runner`                                             | Lance les tests, avec un PostgreSQL temporaire au besoin         |
| `docs`                                                          | Versions, décisions (ADR), procédures, audit, questions ouvertes |
| `infra`, `apps`, `services/notifications`, `services/reporting` | Phases suivantes                                                 |

## Règles de travail

Reprises du plan, section 2 : code et commits en anglais, interface en français et en arabe, une branche par ticket,
aucune fusion sans relecture et sans tests verts, aucun secret dans le dépôt (`.env.example` ne contient que des noms).

Les valeurs cliniques (doses, seuils, plages) sont des exemples tant qu'un référent médical ne les a pas validées
(étiquette `A-VALIDER-MEDECIN`). Les questions ouvertes sont dans [`docs/questions.md`](docs/questions.md).
