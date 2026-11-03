# Orthanc (serveur d'images DICOM)

Orthanc reçoit les images des appareils (échographe, radio numérique, scanner) par DICOM (port 4242) et les garde. Le noyau
du CHU est le **seul** à lui parler (compte technique) : les utilisateurs voient les images par des routes du noyau qui
contrôlent les droits et tracent la lecture. **Ne jamais exposer le port 8042 d'Orthanc au réseau de l'hôpital.**

Image testée : `orthancteam/orthanc` (greffons Worklists, Explorer 2). **À figer sur un condensat précis** avant la mise en
service (`docker inspect --format '{{index .RepoDigests 0}}'`).

## Lancement (essai)

```bash
mkdir -p /srv/chu/worklists
docker run -d --name chu-orthanc -p 127.0.0.1:8042:8042 -p 4242:4242 -v /srv/chu/worklists:/worklists \
  -e ORTHANC__AUTHENTICATION_ENABLED=true -e ORTHANC__REGISTERED_USERS='{"chu":"<mot de passe long>"}' \
  -e ORTHANC__WORKLISTS__ENABLE=true -e ORTHANC__WORKLISTS__DATABASE=/worklists \
  -e ORTHANC__DICOM_AET=CHUPACS -e ORTHANC__DICOM_MODALITIES='{"self":["CHUPACS","127.0.0.1",4242]}' \
  orthancteam/orthanc
```

(`self` n'est utile que pour l'essai : il permet à Orthanc de s'interroger lui-même comme un appareil.) En production,
déclarer chaque appareil dans `DICOM_MODALITIES` (titre AET, adresse, port) et **ne pas** activer `DICOM_ALWAYS_ALLOW_*`.

## Variables du noyau

| Variable                                          | Rôle                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ORTHANC_URL`, `ORTHANC_USER`, `ORTHANC_PASSWORD` | accès technique à l'API REST d'Orthanc (sans `ORTHANC_URL`, l'imagerie DICOM est désactivée et les routes répondent 503) |
| `IMAGING_WORKLIST_DIR`                            | dossier des listes de travail, **partagé** avec le conteneur Orthanc (`/worklists`)                                      |
| `IMAGING_STATION_AET`                             | titre DICOM de l'appareil prévu dans la liste (défaut `RADIO1`)                                                          |
| `PACS_SYNC_INTERVAL_MS`                           | période de synchronisation (défaut 15 000)                                                                               |

## Fonctionnement

1. La caisse libère la demande → l'examen est créé **avec son numéro d'accession** (`ACC-…`).
2. Le noyau écrit `<accession>.wl` (liste de travail DICOM : patient, identifiant, naissance, sexe, modalité, acte) dans le
   dossier partagé. L'appareil l'interroge (Modality Worklist) et choisit le patient : plus de ressaisie, donc moins d'erreurs.
3. L'appareil envoie ses images à Orthanc. Le noyau retrouve les études par **accession** et les rattache à l'examen.
4. **Sécurité d'identité** : si le `PatientID` des images n'est pas l'identifiant du patient de l'examen, l'étude est signalée
   (« Identifiant patient différent ») et jamais affichée (409).
5. Le médecin voit les aperçus dans le dossier une fois le compte rendu signé ; chaque lecture est tracée (`imaging.study.read`).
6. Au compte rendu, la liste de travail est retirée.

La modalité est déduite du code de l'acte (`modalityOf` : `RX`→CR, `ECHO`→US, `SCAN`/`TDM`→CT, `IRM`→MR, `MAMMO`→MG, sinon OT) :
**à adapter au catalogue réel des actes d'imagerie du CHU**.

## Limites

- Aperçus PNG (8 bits) de 12 images au plus par étude : ce n'est **pas un poste de diagnostic**. Un visualiseur complet
  (OHIF) derrière l'authentification du noyau reste à ajouter si les radiologues le demandent.
- Mode « l'appareil envoie » seulement testé avec l'API REST d'Orthanc comme appareil simulé (pas de vrai C-STORE d'un
  appareil réel) ; la liste de travail a été relue par Orthanc via une vraie requête DICOM C-FIND (`find-worklist`).
- Sauvegarde : le stockage d'Orthanc (`/var/lib/orthanc/db`) est à sauvegarder comme la base (non couvert par `tools/backup`).
