# PostgreSQL : rôles, locale, recherche de noms

## Deux rôles, une base

`services/api/src/bootstrap.ts` prépare un serveur vierge (à lancer une fois, avec un compte d'administration) :

- `chu_migrator` possède la base et applique les migrations (`make migrate`, variable `DATABASE_MIGRATOR_URL`).
- `chu_app` est le rôle de l'application (`DATABASE_URL`). Il n'a que les droits donnés par les migrations ;
  en particulier il ne peut **ni modifier ni supprimer** `audit.log` et `events.outbox`. Un déclencheur
  interdit aussi ces opérations au propriétaire de la base.

## Locale UTF-8 obligatoire

La recherche de noms utilise `pg_trgm`. Avec une locale `C`/`POSIX`, les lettres arabes ne sont pas reconnues
comme des lettres et la recherche en arabe ne trouve rien. Créer le serveur avec une locale UTF-8
(`C.UTF-8` ou `en_US.UTF-8`). Les images officielles `postgres` utilisent `en_US.utf8` par défaut.
Un test (`identity.test.ts`, recherche en arabe) échoue si la locale est mauvaise.

## Migrations

- Fichiers dans `services/api/migrations/`, appliqués dans l'ordre des noms.
- Une migration appliquée ne se modifie jamais : le contrôle de somme de contrôle arrête tout si son contenu change.
  On ajoute une nouvelle migration.
- `make migrate` deux fois de suite ne change rien la seconde fois.

## Tests

`pnpm test` démarre un PostgreSQL temporaire si la variable `TEST_DATABASE_ADMIN_URL` est absente (binaires
cherchés dans `/usr/lib/postgresql/*/bin` ou `PG_BIN`). En intégration continue, un service PostgreSQL fournit
cette variable.
