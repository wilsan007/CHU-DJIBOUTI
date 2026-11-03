# Docker Compose

`docker-compose.dev.yml` : PostgreSQL, Keycloak, API, Nginx, Prometheus, Grafana. Mots de passe dans `.env` (voir `.env.example`).

Premier démarrage : lancer `postgres`, puis dans l'image de l'API (réseau `chu_interne`) `node src/bootstrap-cli.ts` et
`node src/migrate-cli.ts` (variables : `services/api/src/bootstrap-cli.ts`), puis le reste.

Vérifié le 3 nov. 2026 avec des images miroir : voir `docs/verification.md`. Les fichiers staging et prod restent à écrire.
