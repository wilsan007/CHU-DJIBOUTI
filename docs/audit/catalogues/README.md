# Catalogues de référence (étape 4.4 du plan)

Un fichier CSV par catalogue, encodé en UTF-8, séparé par des virgules, avec l'en-tête ci-dessous. Chaque fichier
a **un responsable nommé** et une **date de dernière mise à jour** ; un catalogue sans responsable n'est pas importé.

| Fichier           | En-tête                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `services.csv`    | `code,libelle_fr,libelle_ar,lits,responsable,date_maj`                                                                       |
| `actes.csv`       | `code,libelle_fr,libelle_ar,tarif_fdj,service,categorie,responsable,date_maj`                                                |
| `payeurs.csv`     | `code,libelle_fr,libelle_ar,part_patient,responsable,date_maj`                                                               |
| `analyses.csv`    | `code,libelle_fr,libelle_ar,loinc,unite,ref_min,ref_max,sexe,age_min,age_max,critique_min,critique_max,responsable,date_maj` |
| `medicaments.csv` | `dci,forme,dosage,libelle_ar,seuil_stock,responsable,date_maj`                                                               |

`service` est le code du service (CONS, URG, MAT, LAB, IMG, HOSP, PHARM) ; `categorie` vaut `consultation`, `laboratoire`, `imagerie`, `hospitalisation` ou `autre` ;
`part_patient` est un nombre de 0 à 1 (ou un pourcentage, par exemple `20%`) ; `date_maj` s'écrit AAAA-MM-JJ.

Les valeurs de référence et les seuils critiques sont fournis et signés par le biologiste ; les médicaments sont
saisis en dénomination commune internationale (DCI), pas en nom commercial. `classe_allergie` (par exemple
`penicillin`) est fournie par le pharmacien : elle sert à bloquer la prescription chez un patient allergique.
`classe_interaction` rattache le produit aux interactions graves listées par le comité médical. Les seuils de stock appartiennent au module pharmacie.
