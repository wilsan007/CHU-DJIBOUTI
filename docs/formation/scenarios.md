# Scénarios d'exercice (instance de formation, patients fictifs)

Chaque scénario se joue à deux ou trois (un stagiaire par rôle). Le formateur vérifie la colonne **Observer**.

## A · Accueil → caisse (réception, caissier)

| Étape                                                                               | Qui       | Observer                                                                                        |
| ----------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| A1 Chercher « Hassan », ne rien trouver puis créer Amina Hassan                     | Réception | téléphone facultatif ; aucune alerte                                                            |
| A2 Créer « Amina Hasan » (même naissance)                                           | Réception | l'écran propose le dossier proche : choisir « C'est un autre patient » **ou** ouvrir l'existant |
| A3 Admettre à la consultation, payeur Direct                                        | Réception | numéro de facture affiché                                                                       |
| A4 Imprimer la carte                                                                | Réception | une page avec QR et nom                                                                         |
| A5 Ouvrir la caisse, encaisser en espèces                                           | Caissier  | reçu ; message « le service reçoit son ticket »                                                 |
| A6 Refaire avec remise de 50 % **et motif**                                         | Caissier  | « À payer » diminue ; remise sans motif refusée                                                 |
| A7 Erreur de patient : créer l'avoir, puis clôturer la caisse avec 100 FDJ de moins | Caissier  | écart affiché et tracé                                                                          |

## B · Consultation (médecin) — après A5

| B1 Appeler, commencer, saisir motif et examen, constantes (temp. 38,5 ; puis 42 = confirmation ; puis 50 = refusée), diagnostic, clôturer | Médecin | brouillon enregistré ; consultation clôturée non modifiable |
| B2 Allergie « pénicilline » puis prescrire amoxicilline | Médecin | alerte ; demande de justification écrite |
| B3 Demander une glycémie, **ne pas** payer | Médecin | « aucun service ne la reçoit avant le paiement » ; le laboratoire ne voit rien |
| B4 Urgence vitale : même demande avec justification | Médecin | le laboratoire la voit tout de suite ; « à régulariser » à la caisse |

## C · Hospitalisation (médecin, infirmier, caissier)

| C1 Nouveau séjour avec acte initial, forfait à la caisse | Médecin | séjour « forfait à payer » ; le lit ne peut pas être attribué |
| C2 Encaisser le forfait, admettre au lit MED-01 | Caissier, Infirmier | séjour « hospitalisé » ; lit « occupé » dans « Lits » |
| C3 Ajouter un soin ; demander un acte lourd | Infirmier | l'acte lourd attend son paiement ; le soin sera facturé à la sortie |
| C4 Ordonner la sortie, tenter d'enregistrer la sortie **avant** paiement | Médecin, Infirmier | refus ; après paiement de la facture de sortie : sortie enregistrée |

## D · Laboratoire (laboratoire, biologiste, médecin)

| D1 Prélever avec la **mauvaise carte** | Laboratoire | refus (« ce n'est pas le bon patient ») |
| D2 Prélever avec la bonne carte, imprimer l'étiquette | Laboratoire | QR sur l'étiquette |
| D3 Réceptionner ; saisir 30 mmol/L ; validation technique | Laboratoire | — |
| D4 Le **même** technicien tente la validation biologique | Laboratoire | refusé ; le biologiste valide |
| D5 Le médecin voit le message **valeur critique**, accuse réception | Médecin | message disparaît ; sans accusé, escalade après le délai |

## E · Pharmacie et stocks

| E1 Délivrer une ordonnance en deux fois (10 puis le reste) | Pharmacie | « partiellement servie » puis « entièrement servie » |
| E2 Délivrer plus que le stock | Pharmacie | refus, rien enregistré |
| E3 Recevoir un lot (péremption dans 3 mois) | Magasin | alerte « péremption proche » |
| E4 Recette : glycémie = 1 seringue + 1 réactif ; faire terminer une glycémie | Magasin, Laboratoire | consommation automatique, lot qui expire d'abord |
| E5 Stock à zéro, terminer l'acte | Laboratoire | l'acte **n'est pas bloqué** ; un manque apparaît à régulariser |

## F · Imagerie

| F1 Examen payé → programmer → commencer | Imagerie | accession `ACC-…` déjà présente |
| F2 Voir les images de l'appareil simulé ; une image d'un **autre** patient | Imagerie | « Identifiant patient différent : non affiché » |
| F3 Compte rendu ; le médecin le lit dans le dossier | Imagerie, Médecin | version 1 ; correction = version 2 |

## G · Personnel, comptes, patient

| G1 Créer un agent avec compte ; planifier une garde de 12 h | RH | refusée (8–10 h) ; 9 h acceptée |
| G2 Deuxième garde 10 h après la première | RH | refusée (repos de 24 h) |
| G3 Suspendre l'agent | RH | son compte est coupé immédiatement |
| G4 Désactiver puis réactiver un compte | Administrateur | accès coupé / rétabli |
| G5 Espace patient : se connecter par code, prendre et annuler un rendez-vous | Accueil (démonstration) | le code arrive par SMS ; un résultat critique n'est pas montré |
