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

## Archivage continu (PITR) : perte de données de quelques secondes

Avec l'archivage des journaux (WAL), on peut revenir à **n'importe quel instant** (par exemple juste avant une
suppression accidentelle) au lieu du dernier cliché nocturne. Réglages du serveur PostgreSQL :

```
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'   # /archive = disque ou partage SÉPARÉ du serveur
archive_timeout = 60
```

Cliché de base hebdomadaire : `pg_basebackup -D <dossier> -Fp -X stream -c fast`. Restauration : ce cliché devient le
répertoire de données, `recovery.signal` y est créé, et `restore_command = 'cp /archive/%f %p'`,
`recovery_target_time = '<instant>'`, `recovery_target_action = 'promote'` sont ajoutés. `pitr-test.sh` le prouve sur un
PostgreSQL jetable (200 lignes retrouvées après un `delete` accidentel). Les journaux archivés contiennent des données de
patients : ils sont à protéger et à chiffrer comme les sauvegardes (non fait par le script de test).

## Base des comptes (Keycloak)

En production Keycloak utilise PostgreSQL (`KC_DB=postgres`) : `BACKUP_NAME=keycloak BACKUP_DB_URL=… backup.sh` produit
`keycloak-….dump.age`, rotation séparée. Vérifié avec un vrai Keycloak 26.8.1 sur PostgreSQL : un utilisateur créé avant la
sauvegarde existe après restauration dans une autre base, et `dev-doctor` obtient un jeton sur le Keycloak démarré sur la
base restaurée.

## Exercice sur un serveur neuf

`drill.sh <sauvegarde> <clé>` repart d'un PostgreSQL vierge (conteneur), recrée les rôles, restaure, compare le contenu
à la sauvegarde, vérifie qu'aucune migration n'est en attente et démarre l'API sur la base restaurée. Mesuré : 6 secondes
pour la base de test (quelques milliers de lignes) ; **le temps réel dépendra du volume du CHU**, à mesurer lors du premier
exercice sur la vraie machine.

## Limites connues

- Les images d'imagerie sont dans PostgreSQL (donc sauvegardées) ; si elles passent sur Orthanc, le stockage d'Orthanc doit être sauvegardé aussi.
- Le chiffrement des journaux WAL archivés et la copie hors site automatique restent à mettre en place sur le matériel du CHU.
