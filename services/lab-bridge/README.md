# Pont des automates de laboratoire

Petit service qui s'intercale entre un automate (analyseur de paillasse) et l'API du CHU. L'automate se connecte au pont
en TCP ; le pont comprend les deux protocoles les plus répandus et envoie à l'API un message neutre
(`POST /api/lab/analyzers/<nom>/messages`, voir `parseAnalyzerMessage`) :

| Protocole | Norme                                         | Particularités gérées                                                                                                                                                                                                |
| --------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `astm`    | ASTM E1381 (trames) + E1394 (enregistrements) | poignée de main ENQ/ACK/EOT, somme de contrôle, NAK sur trame abîmée, trame renvoyée (doublon) ignorée, message sur plusieurs trames (ETB), plusieurs échantillons par message, résultat préliminaire (P/X/I) écarté |
| `hl7`     | HL7 v2.x ORU^R01 sur MLLP                     | accusé AA après mise en sécurité sur disque, AE si illisible, identifiant d'échantillon lu dans SPM-2, sinon OBR-3, sinon OBR-2 ; OBX non finaux écartés                                                             |

**Aucune perte** : chaque message est écrit sur disque (et synchronisé) _avant_ d'être acquitté à l'automate, puis envoyé.
API en panne, réseau coupé, pont redémarré : le message reste en file (`<spool>/pending`) et part au retour, dans l'ordre.
Refus définitif de l'API (échantillon inconnu, message illisible) : mis de côté dans `<spool>/rejected` avec le motif ;
résultats refusés individuellement (analyse non reliée, échantillon non reçu) : copie signalée `partial-…` dans `rejected`.
Après correction (analyse reliée, échantillon reçu) : `pnpm --filter @chu/lab-bridge requeue`.

## Mise en service

1. Dans l'API : relier les codes de l'automate aux analyses (`PUT /api/lab/analyzers/<nom>/mappings`, droit `lab:configure`).
2. Variables du pont : `BRIDGE_ANALYZER` (nom, identique à celui de l'URL), `BRIDGE_PROTOCOL` (`astm` ou `hl7`),
   `BRIDGE_PORT`, `BRIDGE_API_URL`, `BRIDGE_TOKEN_URL`, `BRIDGE_CLIENT_ID` (`chu-lab-bridge`), `BRIDGE_CLIENT_SECRET`
   (secret du compte de service, `CHU_LAB_BRIDGE_SECRET`), `BRIDGE_SPOOL_DIR`.
3. Le compte de service `chu-lab-bridge` n'a que le rôle `lab` (saisie de résultats) : il ne peut ni valider
   biologiquement ni lire l'administration. La validation par le biologiste reste obligatoire.
4. Sur l'automate : adresse et port du pont. Un pont par automate (un port chacun).

`src/simulator.ts` simule un automate ASTM et HL7 (tests, formation, recette).

## Vérifié / non vérifié

Vérifié : 12 tests unitaires (trames, sommes de contrôle, NAK, doublons, morceaux, multi-trames, MLLP, AA/AE, file
durable, redémarrage, 401, 5xx, 4xx) ; scénario `apps/portal/e2e/lab-bridge.mjs` contre la vraie API et le vrai Keycloak
(ASTM, HL7, coupure de l'API + redémarrage du pont, valeur critique, échantillon inconnu, droits du compte de service).

**Non vérifié : aucun vrai automate.** Le modèle n'est pas connu. Chaque constructeur a ses variantes : champ de
l'identifiant d'échantillon, codes d'analyse (à relier), automate qui attend une _requête_ du LIS (mode « interrogation »,
non géré : seuls les envois spontanés le sont), liaison série (RS-232) à convertir en TCP par un boîtier, somme de contrôle
absente (réglable : `BRIDGE_ASTM_CHECKSUM=off`, mais alors une trame abîmée n'est plus détectée). À valider avec la fiche
d'interface du constructeur et un essai sur l'appareil.
