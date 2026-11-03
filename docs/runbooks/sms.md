# Rappels par SMS

Le service envoie les rappels de rendez-vous et les offres de liste d'attente par une **passerelle SMS HTTP**
configurable (`services/api/src/common/sms.ts`). Sans configuration, les messages restent dans le journal du service
(rien n'est envoyé). **WhatsApp n'est pas branché** : le fournisseur sera ajouté plus tard sous la même interface.

| Variable                                             | Rôle                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `SMS_GATEWAY_URL`                                    | adresse HTTP de la passerelle de l'opérateur ou de l'agrégateur     |
| `SMS_GATEWAY_AUTHORIZATION`                          | valeur de l'en-tête `Authorization` (secret : jamais dans le dépôt) |
| `SMS_SENDER`                                         | nom d'expéditeur affiché                                            |
| `SMS_FIELD_TO`, `SMS_FIELD_TEXT`, `SMS_FIELD_SENDER` | noms des champs JSON attendus (défaut : `to`, `text`, `sender`)     |

Comportement : numéros ramenés au format `+253XXXXXXXX` (refusés s'ils sont invalides) ; erreurs réseau et 5xx
réessayées deux fois, 4xx jamais ; numéro complet jamais écrit dans les erreurs ni les journaux ; texte volontairement
neutre (ni nom, ni motif). Testé contre une passerelle simulée (`services/api/test/sms.test.ts`).

**Non vérifié** : aucune passerelle réelle (pas d'opérateur choisi, pas de compte) ; si la passerelle choisie n'accepte pas
un JSON `POST` simple (SOAP, formulaire, signature), un petit adaptateur sera à écrire. Délivrabilité, coût et accord de
l'opérateur pour l'expéditeur alphanumérique à confirmer avec Djibouti Télécom ou l'agrégateur retenu.
