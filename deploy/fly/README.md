# Déploiement sur Fly.io (démonstration / recette)

> **État : préparé, NON essayé.** Le réseau de l'environnement de développement refuse `fly.io` et `quay.io`, et les
> images n'ont pas pu être construites ici (pas d'accès au registre npm depuis la construction). Les fichiers suivent
> ce qui a été testé ailleurs (API, portail, Nginx, Keycloak 26.8.1 avec `--http-relative-path=/auth`) mais **le premier
> déploiement réel fera apparaître des ajustements** (version de l'image Keycloak, noms internes, résolveur DNS de Nginx).

**Données** : uniquement des données **fictives**. Ne pas y mettre de vrais patients tant que la direction et le cadre légal
(hébergement hors de Djibouti, durée, accès) n'ont pas tranché : une démonstration sur Fly n'est pas la production du CHU.

## Architecture

| Application Fly                                          | Rôle                                                                      | Exposée ?                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| `chu-djibouti-edge`                                      | Nginx + portail ; terminé en HTTPS par Fly ; proxy vers l'API et Keycloak | oui (seule)                              |
| `chu-djibouti-api`                                       | noyau applicatif                                                          | non (`.internal`)                        |
| `chu-djibouti-idp`                                       | Keycloak (domaine `chu`, chemin `/auth`)                                  | non (`.internal`, via `/auth` de l'edge) |
| base PostgreSQL (Fly Managed Postgres ou `fly postgres`) | deux bases : `chu` et `keycloak`                                          | non                                      |

## Ordre des opérations (poste avec `flyctl` connecté : `fly auth login`)

```bash
# 1. Base de données (exemple avec Postgres non géré ; sinon Managed Postgres)
fly postgres create --name chu-djibouti-db --region cdg
# créer les bases et rôles : se connecter (fly postgres connect) puis créer la base « keycloak » ; pour « chu » : étape 3

# 2. Applications (sans les lancer)
fly apps create chu-djibouti-api && fly apps create chu-djibouti-idp && fly apps create chu-djibouti-edge

# 3. Rôles et base de l'application (une fois) : exécuter bootstrap avec l'URL administrateur de la base
#    DATABASE_ADMIN_URL=… CHU_MIGRATOR_PASSWORD=… CHU_APP_PASSWORD=… pnpm --filter @chu/api bootstrap

# 4. Secrets (jamais dans le dépôt)
fly secrets set -a chu-djibouti-idp KC_DB_URL='jdbc:postgresql://…/keycloak' KC_DB_USERNAME=… KC_DB_PASSWORD=… \
  KC_BOOTSTRAP_ADMIN_USERNAME=… KC_BOOTSTRAP_ADMIN_PASSWORD=… CHU_ADMIN_CLIENT_SECRET=… CHU_LAB_BRIDGE_SECRET=… CHU_DEV_USER_PASSWORD=…
fly secrets set -a chu-djibouti-api DATABASE_URL='postgres://chu_app:…@…/chu' DATABASE_MIGRATOR_URL='postgres://chu_migrator:…@…/chu' \
  AUTH_ISSUER='https://chu-djibouti-edge.fly.dev/auth/realms/chu' \
  AUTH_JWKS_URL='http://chu-djibouti-idp.internal:8080/auth/realms/chu/protocol/openid-connect/certs' \
  KEYCLOAK_ADMIN_URL='http://chu-djibouti-idp.internal:8080/auth' KEYCLOAK_ADMIN_CLIENT_SECRET=… PORTAL_JWT_SECRET='<32 caractères au moins>'

# 5. Déploiement (depuis la RACINE du dépôt)
fly deploy -c deploy/fly/keycloak.fly.toml --dockerfile deploy/fly/keycloak.Dockerfile .
fly deploy -c deploy/fly/api.fly.toml --dockerfile deploy/fly/api.Dockerfile .
fly deploy -c deploy/fly/edge.fly.toml --dockerfile deploy/fly/edge.Dockerfile .
```

Après le premier déploiement : déclarer `https://chu-djibouti-edge.fly.dev/*` comme adresse de retour du client `chu-web`
(realm importé : `http://localhost:8080/*` seulement), **supprimer les comptes `dev-*`** ou changer leurs mots de passe, et
vérifier `https://chu-djibouti-edge.fly.dev/health`.

## Points d'attention

- Les comptes `dev-*` du domaine importé partagent `CHU_DEV_USER_PASSWORD` : acceptable pour une démonstration, **pas pour la production**.
- SMS : sans `SMS_GATEWAY_URL`, les codes du portail patient s'écrivent dans les journaux (`fly logs`) : ne pas ouvrir l'espace patient au public.
- Sauvegardes : activer celles de la base Fly **et** appliquer `infra/backup/README.md` (copie hors de Fly, clé privée hors de Fly).
- Imagerie DICOM, pont d'automates : hors de ce déploiement (matériel sur site).
- Coût et région : à valider ; Fly facture chaque machine et volume.
