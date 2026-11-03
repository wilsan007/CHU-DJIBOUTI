# Portail du personnel

React, Vite, connexion unique par Keycloak (code d'autorisation avec PKCE), français et arabe (de droite à gauche).
Les écrans affichés dépendent des droits de la personne (`GET /api/me`). Écrans actuels :

| Écran            | Rôle                                      | Ce qu'il permet                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Réception        | réception                                 | recherche, création avec alerte de doublon, admission                                                                                                                                                                                                                                                                                                                            |
| Caisse           | caissier                                  | factures à encaisser, remise (plafond de la caisse, direction au-delà), encaissement                                                                                                                                                                                                                                                                                             |
| Médecin          | médecin                                   | file d'attente ; dossier (allergies) ; consultation (brouillon avec contrôle de modification simultanée, constantes avec confirmation des valeurs inhabituelles, diagnostics CIM-10) ; ordonnance avec alertes d'allergie et d'interaction à justifier par écrit ; demande de prestations payées à la caisse d'abord ; résultats validés ; valeurs critiques à accuser ; clôture |
| Laboratoire      | technicien, biologiste                    | demandes à prélever (scan de la carte du patient, étiquette), réception par scan, rejet avec motif, saisie des résultats avec drapeaux, validation technique puis biologique                                                                                                                                                                                                     |
| Pharmacie        | pharmacien                                | ordonnances à servir (allergies et justifications visibles), vérification du code de l'ordonnance, délivrance totale ou partielle, stock par lot, alertes de rupture et de péremption                                                                                                                                                                                            |
| Stocks           | magasinier, pharmacien                    | niveaux et alertes par dépôt, réception avec lot et péremption, transferts entre dépôts, recettes d'actes (ce que chaque acte consomme), manques à régulariser, articles (import CSV)                                                                                                                                                                                            |
| Matériel utilisé | médecin, infirmier, laboratoire, imagerie | utilisation de matériel hors acte, avec motif et patient                                                                                                                                                                                                                                                                                                                         |
| Personnel        | ressources humaines                       | fiches d'agents, diplômes et licences, planning de garde (refus de chevauchement, de repos insuffisant, de licence), congés à décider, licences à renouveler, situation et rattachement du compte                                                                                                                                                                                |
| Mon espace       | tout agent                                | ma fiche, mes gardes, mes congés et ma demande de congé                                                                                                                                                                                                                                                                                                                          |
| Hospitalisation  | médecin, infirmier                        | liste des séjours, plan des lits, nouveau séjour (forfait première nuit + acte initial payés d'abord), admission au lit après paiement, soins courants, acte lourd payé à part, ordre de sortie, facture finale, sortie                                                                                                                                                          |
| Imagerie         | technicien d'imagerie                     | examens payés à réaliser, programmation, réalisation, images téléversées, compte rendu                                                                                                                                                                                                                                                                                           |
| Direction        | direction                                 | tableau de bord de chiffres agrégés (activité, recettes, stocks, attente, hospitalisation, personnel), sans aucune donnée de patient                                                                                                                                                                                                                                             |
| Comptes          | administrateur                            | comptes connus, désactivation avec motif (accès coupé partout), réactivation, changement de rôle, création d'un compte Keycloak                                                                                                                                                                                                                                                  |

Les textes viennent de `packages/i18n` (aucun texte en dur ; clé absente = la clé s'affiche). Français et arabe de droite à gauche.

## Lancer la pile de développement

```bash
KEYCLOAK_HOME=/chemin/keycloak-26.8.1 tools/dev-stack/stack.sh start   # PostgreSQL (Docker), Keycloak, API, portail
tools/dev-stack/stack.sh stop
```

Le portail écoute sur `http://localhost:8080` et relaie `/api` vers l'API (comme le fera Nginx). Les mots de passe des
comptes `dev-*` sont tirés au hasard et écrits dans `/tmp/chu-dev-stack/dev_password` (hors dépôt).

## Tests de bout en bout (vrai navigateur)

```bash
export CHU_DEV_USER_PASSWORD="$(cat /tmp/chu-dev-stack/dev_password)"
node apps/portal/e2e/smoke.mjs          # réception, caisse, médecin, ticket du laboratoire après paiement, arabe
node apps/portal/e2e/lab-pharmacy.mjs   # laboratoire (identité, réception, résultats, validations) et pharmacie
node apps/portal/e2e/consultation.mjs   # consultation, ordonnance avec alerte, valeur critique, clôture
node apps/portal/e2e/stock.mjs          # stocks, recettes, consommation automatique, manque, matériel utilisé
node apps/portal/e2e/staff.mjs          # personnel : fiche, licence, planning, congé, suspension
node apps/portal/e2e/hosp-imaging.mjs   # hospitalisation (forfait, lit, soins, sortie) et imagerie (examen, image, compte rendu)
apps/portal/e2e/run-all.sh                # tout rejouer d'un coup (lit les secrets de la pile de test)
node apps/portal/e2e/responsive.mjs     # téléphone 360 px et tablette 768 px, français et arabe : aucun débordement
node apps/portal/e2e/pacs.mjs           # imagerie DICOM avec un vrai Orthanc (voir infra/orthanc/README.md pour les variables)
node apps/portal/e2e/lab-bridge.mjs     # automates ASTM/HL7 simulés → pont → API
node apps/portal/e2e/direction-admin.mjs # tableau de bord de direction et administration des comptes
```

Chaque script se rejoue sans nettoyage. Ils ne sont pas dans `pnpm run check` : ils demandent la pile complète.
