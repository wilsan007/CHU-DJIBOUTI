# ADR-0006 : portail patient (connexion par code SMS)

**Statut** : accepté pour la bêta (révisable avec le CHU). **Date** : 3 novembre 2026.

## Contexte

Le patient doit pouvoir voir ses rendez-vous, en prendre, lire ses résultats validés et consulter ses factures, sans compte
du personnel. À Djibouti le téléphone portable est le seul moyen de contact fiable : pas d'adresse e-mail systématique, pas
de mot de passe à retenir. WhatsApp sera ajouté plus tard comme second canal d'envoi du code.

## Décision

- **Connexion** : numéro de dossier (sur la carte) → code à 6 chiffres envoyé par SMS au téléphone **enregistré à l'hôpital**
  → session de 30 minutes. Pas de compte Keycloak pour les patients : les jetons patient (HS256, audience `chu-patient`)
  et ceux du personnel (Keycloak, RS256) sont étanches l'un à l'autre, dans les deux sens (testé).
- **Pas de devinette de dossier** : la réponse à « envoyer un code » est identique (202) que le dossier existe ou non, que
  le téléphone soit présent ou non, que la limite soit atteinte ou non ; l'envoi du SMS n'est pas attendu (même temps de réponse).
- **Anti-abus** : code haché avec sel (jamais en clair), valable 10 minutes, 5 essais puis le code est brûlé, 3 codes par
  heure et par patient, 20 demandes par heure et par adresse IP (+ limite Nginx 10/minute) : chaque code coûte un SMS.
- **Session révocable** (déconnexion immédiate), liée au dossier : un dossier fusionné ou désactivé coupe la session.
- **Le patient n'agit que sur son dossier** : l'identifiant vient de la session, jamais de l'adresse ou du corps ; annuler le
  rendez-vous d'un autre répond 404 (on ne confirme pas son existence). Toute route `/api/portal/` hors demande/vérification
  de code exige une session (test qui parcourt la table des routes).
- **Contenu** : rendez-vous (voir, prendre — 3 à venir au plus —, annuler jusqu'à 2 h avant), résultats, factures (lecture seule ;
  le paiement reste à la caisse).
- **Résultats** : seulement ceux **validés par le biologiste**, **après un délai** (`PORTAL_RESULT_DELAY_HOURS`, 24 h par défaut)
  pour que le médecin les voie d'abord ; une **valeur critique n'est jamais affichée** (le patient est invité à contacter
  son médecin). Imagerie, ordonnances et dossier médical ne sont **pas** exposés.
- **Traçabilité** : connexion, lecture des factures, des résultats et actions du patient sont écrites dans le journal d'audit
  sous l'acteur `patient:<identifiant>`.

## Conséquences / à décider avec le CHU

- Qui possède le téléphone enregistré ? Une famille qui partage un numéro verra les mêmes codes : c'est le risque de ce modèle.
  À durcir (question secrète, date de naissance) si le CHU le juge nécessaire.
- Le délai de 24 h et la retenue des valeurs critiques sont des choix prudents à valider par les médecins.
- Sans passerelle SMS configurée, **le code est écrit dans le journal du service** (utile en test, à proscrire en production :
  configurer `SMS_GATEWAY_URL` avant d'ouvrir le portail, voir `docs/runbooks/sms.md`).
- Derrière Nginx, activer `TRUST_PROXY` pour que les limites par adresse soient par patient et non communes ; seulement si l'API
  n'est joignable que par Nginx.

## Variables

`PORTAL_JWT_SECRET` (32 caractères au moins ; **sans elle le portail est désactivé**), `PORTAL_RESULT_DELAY_HOURS`, `TRUST_PROXY`,
et la passerelle SMS (`SMS_GATEWAY_URL`…).
