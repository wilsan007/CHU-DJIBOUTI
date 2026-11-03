# Nginx : point d'entrée

- `nginx.dev.conf` : développement, HTTP seul.
- `nginx.prod.conf.template` : production. HTTPS seul (TLS 1.2/1.3), redirection du port 80, en-têtes de sécurité
  (HSTS, CSP stricte, pas de cadre, pas de MIME deviné), version masquée, limites de débit (général et connexion),
  corps limité à 17 Mo (images d'imagerie), `/metrics` jamais exposé, portail statique avec repli sur `index.html`.
  Utilisé avec l'image `nginx` (modèles `envsubst`) : `SERVER_NAME`, `API_UPSTREAM`, `IDP_UPSTREAM`, `CSP_CONNECT`
  (`'self'` quand Keycloak est servi sous `/auth` du même nom), certificat dans `/etc/nginx/tls/{fullchain,privkey}.pem`.

À faire à l'installation : construire le portail avec `VITE_OIDC_AUTHORITY=https://<nom>/auth/realms/chu`, déclarer
`https://<nom>/*` comme adresse de retour du client `chu-web`, régler le nom public de Keycloak (en-têtes mandataire
`X-Forwarded-*` acceptés, chemin `/auth`), et obtenir le certificat auprès de la DSI.

`selftest.sh` lance un vrai nginx avec un certificat de test et contrôle : configuration, redirection, en-têtes (y compris
sur les fichiers statiques), cache, TLS 1.1 refusé / 1.3 accepté, API atteinte à travers le proxy, `/metrics` caché,
corps trop gros refusé.

Non vérifié : Keycloak servi sous `/auth` derrière ce proxy (essayé seulement avec Keycloak sur son propre port, avec une
CSP élargie à cette adresse) ; certificat réel ; réglage fin des limites de débit avec un vrai nombre d'utilisateurs.
