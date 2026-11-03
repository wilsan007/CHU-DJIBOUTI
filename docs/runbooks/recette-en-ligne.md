# Recette en ligne avec GitHub Codespaces

Pour **tester l'application pour de vrai depuis un navigateur**, sans rien installer : un Codespace GitHub démarre toute la pile
(PostgreSQL, Keycloak, API, portail) avec des **données fictives**.

## Lancer

1. Ouvrir <https://codespaces.new/wilsan007/CHU-DJIBOUTI> → **Create codespace** (machine 4 cœurs recommandée).
2. Attendre 3 à 5 minutes la première fois (installation, téléchargement de Keycloak, démarrage). Suivre : `tail -f /tmp/chu-codespaces.log`.
3. Le journal affiche l'adresse et le **mot de passe commun** des comptes de test. Ouvrir le port **8080** (onglet « Ports »).
4. Se connecter avec `dev-reception`, `dev-cashier`, `dev-doctor`, `dev-nurse`, `dev-lab`, `dev-biologist`, `dev-pharmacy`,
   `dev-storekeeper`, `dev-imaging`, `dev-hr`, `dev-direction` ou `dev-admin` (un navigateur par rôle, ou fenêtres privées).

Suivre les scénarios de `docs/formation/scenarios.md` avec les fiches `docs/user-guides/`.

## Ce qui est chargé

Catalogues d'exemple (actes, payeurs, médicaments, diagnostics, analyse glycémie avec plages **d'exemple**), 4 patients fictifs.
Stock, recettes d'actes, lits (6 lits de base), personnel : à saisir en suivant les scénarios.

## Sécurité

- Le port 8080 est **privé** (seul le propriétaire du Codespace l'ouvre). Pour faire tester d'autres personnes : les inviter sur le
  dépôt et partager le Codespace, ou passer le port en « Public » **en connaissance de cause** : mot de passe commun des comptes de test.
- **Aucune donnée réelle de patient.** Les codes SMS du portail patient s'affichent dans le journal du service (aucune passerelle).
- Le Codespace s'arrête seul après inactivité : les données sont **perdues à la suppression** du Codespace (c'est une recette, pas une production).

## Limites

- Imagerie DICOM (Orthanc), pont d'automates et SMS réels : non démarrés dans ce mode.
- **Non essayé dans un vrai Codespace** : tout a été vérifié en local avec la même configuration (Keycloak sous `/auth` du portail,
  adresse publique déclarée comme adresse de retour), mais la fonction « Ports » et le nom d'hôte de GitHub n'ont pas pu être
  testés depuis cet environnement.

## Pour une recette durable (plusieurs jours, plusieurs testeurs)

Un Codespace n'est pas fait pour cela : utiliser le déploiement préparé dans `deploy/fly/` (non essayé) ou un petit serveur.
