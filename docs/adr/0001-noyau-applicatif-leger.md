# ADR-0001 : noyau applicatif léger au lieu de l'assemblage Bahmni

- **Statut** : acceptée par le commanditaire du projet le 3 novembre 2026 ; validation écrite du chef de projet à recueillir
- **Date** : 3 novembre 2026
- **Décideur** : commanditaire du projet (option 2 choisie dans la conversation de cadrage)

## Contexte

L'étude initiale recommandait d'assembler Bahmni (avec OpenMRS), OpenELIS et Odoo. En préparant le dépôt
(étape 3.1 du plan), on a constaté :

- la configuration officielle de Bahmni compte environ 30 services (voir `docs/versions.md`) ;
- Bahmni embarque Odoo 16, probablement hors support de l'éditeur (à vérifier), et sa propre version d'OpenELIS,
  distincte d'OpenELIS-Global prévu au plan ;
- la passerelle OpenHIM n'a pas publié de version stable depuis septembre 2024 ;
- trois sites de documentation nécessaires étaient inaccessibles depuis l'environnement de travail, et le démon
  Docker n'y est pas disponible, ce qui empêche de tester la pile complète.

## Décision

Construire un **noyau applicatif** en TypeScript : un service HTTP organisé en modules (identité, admission et
facturation, rendez-vous, consultation, ordonnances, pharmacie, laboratoire, administration), une base PostgreSQL
avec un schéma par module, des événements internes écrits dans la même transaction que la donnée (outbox),
Keycloak pour la connexion unique, une API FHIR R4 pour l'extérieur. Orthanc, OHIF et DHIS2 restent prévus en phase 5.

Les phases, les validations V0 à V5, les modules F1 à F14, les écrans, le prototype, le plan de formation et le plan
de bascule ne changent pas. Le plan de réalisation est révisé en conséquence (révision n° 1).

## Conséquences

- Plus simple : peu de services à exploiter, un seul modèle de données, tests automatisés sur une vraie base PostgreSQL.
- Plus difficile : la sécurité clinique (doses, alertes, identité) est entièrement à la charge du CHU ; les interfaces
  avec les analyseurs et le fonctionnement hors ligne sont à écrire.
- À surveiller : toute règle clinique reste marquée `A-VALIDER-MEDECIN` tant qu'un référent médical ne l'a pas validée ;
  le code et les décisions sont documentés pour qu'une autre équipe puisse reprendre.

## Autres options étudiées

- Continuer avec Bahmni : plus rapide pour le dossier clinique, mais pile lourde, composants vieillissants et accès
  à la documentation à ouvrir.
- Construire de zéro absolu, sans standards ni composants : écartée, trop risquée.
