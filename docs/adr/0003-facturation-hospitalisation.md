# ADR-0003 : facturation de l'hospitalisation

Date : 3 novembre 2026. Statut : appliqué. Source : consigne du CHU (coutume de Djibouti).

## Décision

L'hospitalisation se facture en trois temps, sans exception à la règle de la caisse (ADR-0002) :

1. **Forfait initial, payé d'abord.** Le médecin décide l'hospitalisation. La première nuit (acte `HOSP-1J`, une seule) et l'acte initial éventuel forment une demande de prestations. La caisse l'encaisse, **avec ou sans remise**. Alors seulement le ticket d'hospitalisation est libéré et le service peut faire entrer le patient au lit.
2. **Nuitées et soins courants, sans paiement quotidien.** Les nuits suivantes (une par jour calendaire) et les soins courants (actes d'hospitalisation du catalogue) s'accumulent pendant le séjour. À l'ordre de sortie du médecin, ils forment la **facture de sortie**, émise à la caisse.
3. **Actes lourds, payés à part.** Toute opération ou examen en cours de séjour est une **nouvelle demande**, qui suit le circuit complet : facture à la caisse, paiement validé, ticket envoyé, exécution tracée. Un acte hors hospitalisation ne peut pas être ajouté aux soins courants.

Le patient quitte l'hôpital après paiement de la facture de sortie. La direction seule peut autoriser une sortie avec facture impayée, avec motif écrit ; la dette reste visible à la caisse et l'événement de sortie le signale.

## Remises

Décidées à la caisse avant le paiement, avec motif et auteur, sur n'importe quelle facture en attente. La caisse peut accorder jusqu'à un plafond (10 % par défaut, valeur d'exemple à fixer par la direction) ; au-delà, seule la direction le peut. La facture reste intacte ; la remise réduit ce que le patient paie. Elle est figée après paiement (garde en base).

## Conséquences

- Une demande de séjour impayée bloque l'ordre de sortie.
- Un lit ne peut avoir qu'un patient ; un patient n'a qu'un séjour en cours.
- Le tableau de bord de direction montre les lits occupés et les entrées et sorties du jour.

Questions ouvertes : Q24 à Q27 dans `docs/questions.md`.
