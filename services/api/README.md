# Noyau applicatif (`@chu/api`)

Service HTTP en TypeScript : un module par domaine, une base PostgreSQL, un schéma par module.
Voir `docs/adr/0001-noyau-applicatif-leger.md`.

## Contenu actuel

| Élément                                                                         | État                   |
| ------------------------------------------------------------------------------- | ---------------------- |
| Socle : `/health`, configuration, migrations SQL, rôles de base                 | Fait (étapes 5.2, 5.3) |
| Authentification par jeton OpenID Connect (Keycloak) et droits par rôle         | Fait (étape 5.5)       |
| Journal d'audit et outbox en ajout seul, écrits dans la transaction de l'action | Fait (étapes 5.6, 6.2) |
| Module identité : F1-1 à F1-6                                                   | Fait, testé            |
| Distributeur d'événements, consommateurs                                        | Phase 2                |
| Autres modules (F2 à F14)                                                       | Phase 4                |

## Routes du module identité

| Méthode et chemin                                        | Droit                      | Histoire                                    |
| -------------------------------------------------------- | -------------------------- | ------------------------------------------- |
| `POST /api/patients`                                     | `patient:create`           | F1-1, F1-3 (409 en cas de doublon probable) |
| `GET /api/patients?q=`                                   | `patient:read`             | F1-2                                        |
| `GET /api/patients/:ref`                                 | `patient:read`             | ouverture d'un dossier, tracée              |
| `POST /api/patients/provisional`                         | `patient:create`           | F1-5                                        |
| `POST /api/patients/:ref/link`                           | `patient:link-provisional` | F1-5                                        |
| `POST /api/patients/merge`                               | `patient:merge`            | F1-4                                        |
| `GET /api/patients/:ref/card`, `GET /api/cards/:payload` | `patient:read`             | F1-6                                        |

## Lancer

```bash
export DATABASE_URL=postgres://chu_app:…@localhost:5432/chu
export DATABASE_MIGRATOR_URL=postgres://chu_migrator:…@localhost:5432/chu
export AUTH_ISSUER=https://…/realms/chu AUTH_AUDIENCE=chu-api AUTH_JWKS_URL=https://…/protocol/openid-connect/certs
pnpm --filter @chu/api migrate
pnpm --filter @chu/api start
```

## Règles du code

- Un module ne lit jamais les tables d'un autre ; il passe par son interface ou par un événement.
- Toute écriture qui change un dossier passe par une transaction qui écrit aussi l'audit et l'événement.
- Aucun texte d'interface ici : l'API renvoie des codes stables et des messages en français.

## Circuit des prestations (règle de la caisse, ADR-0002)

| Étape                      | Qui                             | Route                                                     | Effet                                                              |
| -------------------------- | ------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| Demande                    | médecin, infirmier              | `POST /api/service-orders`                                | demande « en attente de paiement » ; la facture arrive à la caisse |
| Encaissement et validation | caisse seule                    | `POST /api/billing/invoices/:id/pay`                      | reçu ; événement `InvoicePaid`                                     |
| Envoi aux services         | système, après la validation    | (distributeur)                                            | un ticket par service ; `ServiceOrderReleased`                     |
| Bon du patient             | caisse                          | `GET /api/service-orders/:id/voucher`                     | disponible seulement après paiement (409 sinon)                    |
| Activation                 | service concerné                | `POST /api/department-tickets/:id/start` puis `/complete` | impossible sans ticket                                             |
| Traçabilité                | médecin, caisse, administration | `GET /api/service-orders/:id/trace`                       | qui a demandé, validé, reçu le ticket, exécuté                     |

## Autres routes

- Catalogues : `/api/catalog/*` (import CSV des actes et des payeurs, rapport ligne par ligne).
- Facturation : `/api/admissions`, `/api/billing/quotes`, `/api/billing/invoices`, avoirs, caisse, rapport de recettes.
- Rendez-vous : `/api/schedule/*`, `/api/appointments`, `/api/waitlist`, `/api/queue`.
