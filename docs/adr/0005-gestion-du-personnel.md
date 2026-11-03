# ADR-0005 : gestion du personnel

Date : 3 novembre 2026. Statut : appliqué.

## Décision

Un module **Personnel** (schéma `staff`) couvre tous les agents, soignants ou non : fiche (matricule continu, fonction, service, situation), diplômes et certifications, planning de garde, congés. Il est tenu par un rôle **`hr`** (ressources humaines), sans accès aux dossiers de patients.

- **Confidentialité.** Les données personnelles (naissance, téléphone, e-mail) ne sortent que pour les ressources humaines. Tout autre agent voit un **annuaire minimal** (nom, fonction, service) et le planning. La direction ne voit que des effectifs agrégés. Aucune donnée de salaire n'est gérée.
- **Pas de licence.** Aucune licence d'exercice n'est contrôlée. Un agent est **en contact avec les patients** (médecin, infirmier, aide-soignant, sage-femme, techniciens de soins) ou **sans contact** (assistants, administration, magasin, caisse). Diplômes et certifications restent saisissables, à titre d'information.
- **Garde.** Une garde dure **8 à 10 heures, en plus des heures de travail normales**, avec **24 heures de repos** après (décision du CHU). Pas de chevauchement (garanti par la base), rien pendant un congé approuvé ni pour un agent non en activité.
- **Congés.** L'agent demande, les ressources humaines décident ; on ne décide jamais de sa propre demande ; une garde sur la période doit être retirée avant l'approbation.
- **Lien avec les comptes.** Un agent suspendu ou parti voit son **compte coupé immédiatement** dans tous les modules (registre des comptes, ADR de F14) et ses gardes futures retirées ; un compte rattaché à un agent déjà parti est bloqué avant sa première connexion.

Décisions : `docs/decisions-beta.md` (Q30 réglée par le CHU).
