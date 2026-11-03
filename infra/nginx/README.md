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

`auth-path-test.sh` (essai complet) : second Keycloak servi sous `/auth` (`--http-relative-path=/auth`,
`--hostname=https://<nom>/auth`, `--proxy-headers=xforwarded`), seconde API, portail construit avec
`VITE_OIDC_AUTHORITY=https://<nom>/auth/realms/chu`, nginx en HTTPS ; `apps/portal/e2e/https-auth.mjs` connecte le
médecin, parcourt tous ses écrans et le déconnecte, sans aucune violation de la politique de sécurité. Il a fait
trouver deux défauts, corrigés : la CSP stricte cassait les pages de Keycloak (qui envoie ses propres règles), et le
freinage de connexion comptait aussi les polices et feuilles de style (il ne vise plus que le formulaire et l'échange
de jeton : 60 tentatives rapprochées → 503, pages non freinées).

Non vérifié : certificat réel (autorité interne ou Let's Encrypt) ; réglage fin des limites de débit avec le vrai nombre
d'utilisateurs (derrière un même pare-feu, plusieurs agents partagent une adresse : à surveiller).
