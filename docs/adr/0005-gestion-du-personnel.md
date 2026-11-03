# ADR-0005 : gestion du personnel

Date : 3 novembre 2026. Statut : appliqué.

## Décision

Un module **Personnel** (schéma `staff`) couvre tous les agents, soignants ou non : fiche (matricule continu, fonction, service, situation), diplômes et licences, planning de garde, congés. Il est tenu par un rôle **`hr`** (ressources humaines), sans accès aux dossiers de patients.

- **Confidentialité.** Les données personnelles (naissance, téléphone, e-mail) ne sortent que pour les ressources humaines. Tout autre agent voit un **annuaire minimal** (nom, fonction, service) et le planning. La direction ne voit que des effectifs agrégés. Aucune donnée de salaire n'est gérée.
- **Licence d'exercice.** Pour les médecins, infirmiers, sages-femmes, pharmaciens et biologistes, **aucune garde ne se planifie sans licence valide** le jour concerné.
- **Planning.** Pas de chevauchement (garanti par la base), repos minimal entre deux gardes (11 h, valeur d'exemple), garde de 26 h au plus, rien pendant un congé approuvé ni pour un agent non en activité.
- **Congés.** L'agent demande, les ressources humaines décident ; on ne décide jamais de sa propre demande ; une garde sur la période doit être retirée avant l'approbation.
- **Lien avec les comptes.** Un agent suspendu ou parti voit son **compte coupé immédiatement** dans tous les modules (registre des comptes, ADR de F14) et ses gardes futures retirées ; un compte rattaché à un agent déjà parti est bloqué avant sa première connexion.

Questions ouvertes : Q30, Q32, Q33 dans `docs/questions.md`.
