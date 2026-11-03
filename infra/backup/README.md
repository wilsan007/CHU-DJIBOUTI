# Sauvegardes et restauration

Outils : `tools/backup/{backup,restore,counts,selftest}.sh`. Format : `pg_dump` « custom » compressé, chiffré avec
[age](https://age-encryption.org) pour une **clé publique**. La clé privée reste hors du serveur (coffre, clé USB scellée
chez la direction) : un serveur compromis ne peut ni lire ni déchiffrer les anciennes sauvegardes.

## Mise en place (une fois)

```bash
age-keygen -o chu-backup-key.txt          # sur un poste de confiance, PAS sur le serveur
age-keygen -y chu-backup-key.txt          # affiche la clé publique à mettre sur le serveur
```

Conserver la clé privée en **deux exemplaires** dans deux lieux différents. Sans elle, les sauvegardes sont perdues.

## Sauvegarde quotidienne

```bash
BACKUP_DB_URL='postgres://…' BACKUP_DIR=/var/backups/chu BACKUP_AGE_RECIPIENT='age1…' tools/backup/backup.sh
```

À planifier toutes les nuits (cron ou minuterie systemd), puis à copier **hors du serveur** (autre machine ou disque
externe) : une sauvegarde sur le même disque ne protège pas d'une panne de disque. Le script garde 30 jours, et
toujours les 7 plus récentes. Objectif de perte de données (RPO) : 24 h avec une sauvegarde nocturne ; l'archivage continu
des journaux (WAL) donnerait quelques minutes, à décider avec le CHU.

## Restauration

1. Créer une base vide et les rôles (`pnpm --filter @chu/api bootstrap`), jamais par-dessus la base en service.
2. `RESTORE_DB_URL='postgres://…/chu' tools/backup/restore.sh chu-AAAAMMJJ….dump.age chu-backup-key.txt`
3. Contrôler : `tools/backup/counts.sh db <url>` doit donner les mêmes nombres que `counts.sh dump <fichier> <clé>`.
4. Appliquer les migrations restantes, redémarrer l'API.

Le script refuse : un fichier altéré (somme SHA-256), une mauvaise clé, une base cible non vide.

## Exercice de restauration

`tools/backup/selftest.sh` rejoue tout cela contre la pile de test. **Une sauvegarde jamais restaurée n'est pas une
sauvegarde** : faire l'exercice réel (restauration sur une autre machine, avec la vraie clé) une fois par trimestre et noter
la date et la durée dans le registre d'exploitation.

## Limites connues

- Les images d'imagerie sont dans PostgreSQL (donc sauvegardées) ; si elles passent un jour sur un stockage séparé (Orthanc), il faudra le sauvegarder aussi.
- Les comptes de connexion vivent dans Keycloak : sauvegarder sa base séparément (non couvert ici).
