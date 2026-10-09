# Dakar Bus

Web app mobile-first qui guide les déplacements à Dakar. Dans Explorer, la carte occupe le tiers supérieur de l’écran ; une recherche « On va où ? » et les raccourcis Maison, Boulot et Adresse simplifient l’accès aux destinations. L’application applique une règle stricte : aucun arrêt, horaire, tracé, statut de service ou passage n'est publié sans donnée traçable.

## État actuel

Cette première fondation fournit :

- une carte interactive de Dakar, avec fond OpenStreetMap et attribution visible ;
- une interface responsive en 4 onglets : Explorer (carte, recherche « On va où ? », GPS et décomptes de référence vivants), Trajet (planification d’un itinéraire), Alertes (canaux officiels + « Direct rue ») et Paramètres (guide et sections d’information repliables) ;
- une demande de géolocalisation explicite, affichage de sa précision et gestion des refus/erreurs ;
- une sélection de départ et destination par toucher/clic sur la carte ;
- un catalogue de sources prévu pour TER, BRT, Dakar Dem Dikk, AFTU et TATA, sans prétendre qu'un jeu de données est déjà intégré ;
- la gare TER-09 affichée sous le nom « Keur Mbaye Fall » dans la carte, la recherche et le GTFS de référence ;
- une PWA installable et un cache hors connexion limité à l'enveloppe de l'application ;
- un auditeur GTFS Static en lecture seule, sans extraction de l’archive, avec rapport JSON, contrôle des tables essentielles, relations, coordonnées, horaires, calendriers, tracés, fréquences et transferts ;
- un outil de staging versionné qui conserve le ZIP original, son checksum, le manifeste de provenance déclaré, les comptages et le rapport de validation, sans publication automatique ;
- une revue humaine traçable : cinq attestations obligatoires, un relecteur nominatif, un journal append-only chaîné par empreintes et un retour arrière qui n'efface rien ;
- une étape de publication qui gèle une version approuvée dans un snapshot daté et immuable (`network.sqlite` + manifeste haché), avec un journal append-only chaîné par empreintes et un retour arrière qui n'efface rien ;
- une API locale qui sert en lecture seule la gouvernance du staging (`/api/pipeline`, `/api/catalog`, `/api/datasets/<id>`, `/api/publications`) et le snapshot publié (`/api/network`, `/api/stops/search`, `/api/stops/near`, `/api/stops/<id>`, `/api/routes`, `/api/routes/<id>`, `/api/journeys`) ;
- un graphe d'itinéraires dérivé du snapshot actif (`data/published/network.graph.json`) : marche par liens déclarés, courses directes déclarées, refus explicite dès qu'il ne correspond plus exactement au snapshot publié ;
- une interface branchée sur ces routes : recherche d'arrêts, arrêts autour de vous, lignes publiées et fiches honnêtes ; la recherche d'itinéraire accepte les courses directes déclarées et, sans API/snapshot, affiche séparément l'estimation locale TER/BRT ;
- des comptes locaux nominatifs (secret haché en scrypt, registre `data/actors/` ignoré par Git) : jeton Bearer court pour la CLI, session à cookie `HttpOnly`/`SameSite=Strict` plus jeton CSRF pour la console ;
- une section technique dans Paramètres (repliée par défaut) qui affiche l'état réel du catalogue, ou signale honnêtement qu'il n'est pas joignable, et permet d'approuver, refuser, annuler et publier depuis la console avec un compte authentifié — les mêmes règles qu'en ligne de commande, appliquées par le serveur ;
- des règles testées pour le statut des horaires, le label LIVE, les décomptes en minutes et la publication d'objets actifs.

**Aucun flux GTFS, GTFS-RT, horaire, arrêt, ligne, tracé, alerte ou donnée opérateur n'est actuellement fourni par ce dépôt.** La carte de fond représente uniquement la géographie OpenStreetMap. Un clic sur la carte choisit un point géographique, mais ne le géocode pas en nom de lieu.

La recherche d’itinéraire utilise en priorité l’API lorsqu’un snapshot est publié : elle ne propose alors que les courses directes et horaires théoriques déclarés dans `stop_times`. Si le serveur `/api` est absent (cas d’un hébergement GitHub Pages statique) ou qu’aucun snapshot n’est publié, l’application peut calculer localement une estimation TER/BRT à partir du réseau de référence ; elle l’étiquette explicitement comme estimation, jamais comme horaire ou prochain passage. Aucun itinéraire DDD/AFTU/TATA, aucune position de véhicule et aucun temps réel ne sont inventés.

Aucune décision n'est anonyme : approuver, refuser, annuler ou publier exige un compte local dont le secret n'est stocké que haché (scrypt + sel, fichier `0600`). Les comptes génériques (`admin`, `ci`, `anonymous`, …) sont refusés, la personne qui approuve une version ne peut pas la publier elle-même, une révocation invalide les jetons et sessions déjà émis, et chaque décision enregistre l'acteur, la méthode d'authentification et l'horodatage.

## Réseau de référence TER/BRT, assistant et calculateur (ajouts 2026-10)

Une couche **réseau de référence** distincte du pipeline de publication a été ajoutée :

- **Cadrage de la carte** : la carte englobe désormais toute la région utile (Almadies → Rufisque/Bargny, jusqu’aux terminus Diamniadio et Guédiawaye) via `fitBounds` au chargement.
- **Tracés TER et BRT** : les 13 gares du TER (liste Sen TER, positions OpenStreetMap/SETER, sans date de vérification externe documentée) et les 23 stations du BRT sont tracées en superposition du fond OpenStreetMap, avec arrêts cliquables. Les stations BRT sont associées aux identifiants de nœuds OpenStreetMap de la relation B1 (`network=SunuBRT`, relations 19961937/19961993) ; la date de vérification externe de ces positions n’est pas documentée. La séquence de référence des 23 stations est verrouillée par les tests (`src/domain/corridors.test.ts`) et reprise telle quelle dans le GTFS de référence. Le tracé reliant ces arrêts reste une géométrie de référence (pas le tracé métrique des voies), explicitement étiquetée — pas un flux opérateur validé. Les interrupteurs de couche TER/BRT pilotent cet affichage.
- **Assistant IA** : bouton flottant en bas à gauche de la carte (onglet Explorer) et réponses à la recherche « On va où ? ». Moteur local à règles (aucun service externe) branché sur le réseau de référence, le calculateur et l’état réel des API : listes d’arrêts, desserte d’un lieu, fréquences officielles de référence, itinéraires, tarif de référence, état des perturbations (aucune alerte inventée).
- **Calculateur de correspondances** : dans l’onglet Trajet, un module calcule le meilleur enchaînement TER + BRT entre deux points (arrêts de référence ou points de la carte), avec temps de marche, d’attente (demi-fréquence officielle de référence) et de parcours estimés. DDD/AFTU/TATA ne sont pas inventés : le calculateur le dit.
- **Résumé Explorer** : liste compacte TER/BRT/DDD/AFTU/TATA dont le décompte **descend en temps réel**. Pour chaque réseau qui publie une fréquence officielle (TER, BRT), le prochain créneau de la grille déclarée est calculé depuis l’horloge de Dakar (premier départ, intervalle, fin de service, jours de service) : le compte à rebours diminue jusqu’au créneau, puis passe au suivant. Ce n’est **pas du temps réel** — aucune position de véhicule, aucun retard constaté — et l’écran le dit à côté du décompte (« Décompte théorique · pas de temps réel »). DDD, AFTU et TATA n’affichent aucun chiffre : « Non déclaré », jamais une valeur inventée. Les statuts détaillés restent dans Paramètres.
- **État des données dans Paramètres** : sources, périodes, limites de validité, statut de l’API, catalogue filtrable TER/BRT et lignes publiées regroupés dans une section repliable.
- **Onglet Alertes** : canaux officiels d’information (Sen TER, SunuBRT, CETUD) affichés tant qu’aucun flux d’alertes vérifiable n’est connecté.
- **« Direct rue »** (seconde vue de l’onglet Alertes) : remontée d’informations terrain par les usagers — embouteillage, incident, travaux, route coupée — sur une portion de route précise, avec réseau concerné, précision et position jointes sur demande. Règle de vérité : ces signalements sont locaux à l’appareil (stockage du navigateur, aucun envoi à un serveur), **non vérifiés**, jamais présentés comme une alerte officielle ni comme un horaire, effaçables à tout moment et retirés d’eux-mêmes après 90 minutes.

Un jeu **GTFS de référence** (`npm run reference:gtfs`, générateur `tools/build_reference_gtfs.py`) peut être stagé pour démontrer le pipeline de bout en bout (`npm run stage:gtfs …`). Sa fiche de staging porte une provenance et une confiance fidèles (`source_type UNKNOWN`, confiance 0,4) : **le script ne publie rien** — l’approbation exige les cinq attestations humaines (identité de la source vérifiée auprès de l’éditeur, droits de réutilisation, opérateur confirmé, service exploité, fraîcheur confirmée) puis une publication séparée par un compte distinct.

Nouveaux fichiers :

```text
src/domain/corridors.ts        données de référence TER/BRT + provenance déclarée
src/domain/planner.ts          calculateur multimodal (Dijkstra, réseau de référence)
src/domain/assistant.ts        cerveau local de l’assistant (règles, zéro invention)
src/components/AssistantChat   widget de chat flottant (bas gauche de la carte)
src/components/MultimodalPlanner  calculatrice de correspondances (onglet Trajet)
tools/build_reference_gtfs.py  générateur du GTFS de référence (démonstration pipeline)
```

## Démarrer

Prérequis : Node.js 22.12+ et npm. Python 3.10+ est requis uniquement pour l’auditeur GTFS et ses tests.

```bash
npm install
npm run dev
```

Le serveur Vite écoute sur `0.0.0.0` pour permettre l'aperçu dans un environnement distant.

## Vérifier

```bash
npm test
npm run test:data
npm run test:all
npm run build
npm audit
```

Pour voir la console locale alimentée, lancer l'API locale puis le serveur de développement dans deux terminaux :

```bash
npm run admin:api   # http://127.0.0.1:8787 : lecture publique + décisions authentifiées
npm run dev         # relaie /api vers l'API locale
```

Pour décider depuis la console, créer d'abord des comptes locaux (voir « Comptes locaux, jetons et sessions »), puis ouvrir Paramètres → « Console d'administration locale » et se connecter. Pour décider en ligne de commande, émettre un jeton court et le passer à `npm run review:gtfs -- approve <dataset_id> --token "$TOKEN" …` ou à `npm run publish:gtfs -- publish <dataset_id> --token "$TOKEN" --note "..."`. Les comptes sont écrits dans `data/actors/`, les snapshots dans `data/published/` : les deux sont ignorés par Git, comme le staging.

Le workflow GitHub Actions (`.github/workflows/ci.yml`) exécute le build, les deux suites de tests et l’audit des dépendances à chaque push et pull request.

## Structure

```text
src/
  App.tsx                 écrans et interactions, onglet de gouvernance
  App.css                 design system responsive
  App.test.tsx            tests des parcours, états sans données et console
  Console.tsx             console connectée : session, décisions, refus affichés tels quels
  Console.test.tsx        tests de connexion, d'approbation, de refus et de publication
  components/TransitMap   carte, position GPS, points choisis
  domain/network.ts       registre des sources (aucun réseau publié par défaut)
  domain/network.test.ts  tests du catalogue initial vide
  domain/truth.ts         garde-fous de provenance et d'affichage
  domain/truth.test.ts    tests de non-invention
  domain/review.ts        modèle de lecture du catalogue et de la revue
  domain/review.test.ts   tests de parsing strict et de non-invention
  domain/published.ts     modèle de lecture du snapshot publié (parsing strict)
  domain/journeys.ts      modèle de lecture des courses directes (/api/journeys)
  domain/session.ts       client de session et de décision (cookie, CSRF, refus du serveur)
  domain/session.test.ts  tests de session, d'en-têtes et de refus
scripts/
  validate_gtfs.py       validateur GTFS Static en lecture seule
  stage_gtfs.py          staging versionné, provenance à revoir
  catalog_gtfs.py        catalogue local en lecture seule, état de revue inclus
  review_ledger.py       journal append-only chaîné par empreintes, verrou exclusif
  actor_registry.py      comptes locaux (scrypt), jetons Bearer, sessions en mémoire
  review_gtfs.py         revue humaine : approbation, refus, retour arrière
  publication_ledger.py  journal des publications append-only, chaîné par empreintes
  snapshot_gtfs.py       construction et lecture des snapshots publiés (SQLite figée)
  publish_gtfs.py        publication, vérification et retour arrière d’un snapshot
  serve_admin_api.py     API HTTP : lecture publique, et décisions authentifiées (session + CSRF)
  serve_read_api.py      routes publiques servies depuis le snapshot actif, dont les itinéraires
  network_graph.py       graphe d’itinéraires dérivé du snapshot actif, refusé s’il ne correspond plus
public/
  manifest.webmanifest    métadonnées PWA
  sw.js                  cache de l'enveloppe applicative, jamais /api
tests/
  test_validate_gtfs.py    tests de validation de flux GTFS
  test_stage_gtfs.py       tests de versionnage et de staging
  test_catalog_gtfs.py     tests d’intégrité et de comparaison catalogue
  test_review_gtfs.py      tests d’approbation, de refus et de retour arrière
  test_publish_gtfs.py     tests de publication, de vérification et de retour arrière
  test_serve_admin_api.py  tests de l’API : lecture publique, sessions, décisions et refus
  test_network_graph.py    tests du graphe d’itinéraires et de /api/journeys
```

## Valider un flux GTFS

Aucun flux de Dakar n’est fourni ou inventé dans le dépôt. Lorsqu’une archive obtenue auprès d’une source vérifiable sera disponible, l’auditeur peut la contrôler localement :

```bash
npm run validate:gtfs -- ./chemin/vers/feed.zip
```

La commande écrit un rapport JSON sur la sortie standard et retourne un code non nul si la structure ou les références contrôlées sont invalides. Elle ne décompresse pas l’archive sur disque et impose par défaut des limites de taille et de nombre de lignes. Les tables GTFS facultatives non encore contrôlées sont signalées comme avertissements.

`structure_valid: true` signifie uniquement que les contrôles structurels implémentés sont passés. Le rapport garde toujours `production_ready: false` : la légalité de réutilisation, l’identité de l’opérateur, le statut réellement exploité, la fraîcheur métier et la validation éditoriale restent à confirmer séparément.

## Stager une version avec provenance

Après validation, le flux peut être copié dans un répertoire de staging local et ignoré par Git. Toutes les métadonnées de provenance sont requises ; elles sont enregistrées comme **déclarées par l’importateur**, pas comme vérifiées par Dakar Bus.

```bash
npm run stage:gtfs -- \
  --archive "$GTFS_ARCHIVE" \
  --output-dir ./data/staging \
  --source "$GTFS_SOURCE_NAME" \
  --source-type "$GTFS_SOURCE_TYPE" \
  --source-url "$GTFS_SOURCE_URL" \
  --operator "$GTFS_OPERATOR" \
  --dataset-version "$GTFS_DATASET_VERSION" \
  --date-source "$GTFS_SOURCE_DATE" \
  --verified-at "$GTFS_VERIFIED_AT" \
  --valid-from "$GTFS_VALID_FROM" \
  --valid-until "$GTFS_VALID_UNTIL" \
  --confidence "$GTFS_CONFIDENCE" \
  --service-status UNKNOWN
```

Le staging conserve l’archive originale, son SHA-256, les comptages, le rapport de validation et un manifeste versionné. Une version identique n’est pas écrasée. **Le statut reste `PENDING_REVIEW` et `NOT_PUBLISHED`**, même si l’importateur déclare le service actif : il faut encore vérifier la source, les droits, l’opérateur et l’état opérationnel.

## Catalogue local des versions

Le catalogue est en lecture seule : il revérifie le checksum de chaque archive, recalcule la fraîcheur effective à la date de consultation et compare les comptages GTFS entre deux versions.

```bash
npm run catalog:gtfs -- list
npm run catalog:gtfs -- show <dataset_id>
npm run catalog:gtfs -- compare <ancienne_version> <nouvelle_version>
```

`compare` compare les comptages et métadonnées, pas les lignes une à une ni les géométries. Le catalogue ne modifie jamais l’état de revue et ne publie aucune version.

## Comptes locaux, jetons et sessions

Aucune décision n'est enregistrée sans acteur authentifié. Le registre est local (`data/actors/actors.json`, ignoré par Git) : chaque compte porte un identifiant nominatif, un rôle et un secret dont seule l'empreinte **scrypt** (n=2¹⁴, sel de 16 octets) est écrite, dans un fichier `0600`. La clé de signature des jetons (`data/actors/server.key`) est créée à la première émission, elle aussi en `0600`.

```bash
# créer deux personnes distinctes : une relectrice, un publieur
npm run actors -- create fatou.ndiaye --name "Fatou Ndiaye" --role reviewer --created-by awa.mainteneur
npm run actors -- create ousmane.fall --name "Ousmane Fall" --role publisher --created-by awa.mainteneur
npm run actors -- list           # aucun secret n'est affiché
npm run actors -- summary        # comptes actifs par rôle

# jeton Bearer court (8 h par défaut) pour la ligne de commande
npm run actors -- token fatou.ndiaye --ttl 3600
npm run actors -- token fatou.ndiaye --ttl 3600 --secret "$SECRET" > /tmp/fatou.token

# retirer un compte sans effacer sa trace
npm run actors -- revoke ousmane.fall --revoked-by awa.mainteneur --reason "Départ de l’équipe, compte clos."
```

Règles appliquées par le registre :

- un acteur nominatif est exigé : les identifiants génériques (`admin`, `ci`, `anonymous`, `demo`, …) sont refusés, comme dans les journaux ;
- personne ne s'enregistre soi-même (`--created-by` doit désigner un autre acteur) et personne ne se révoque soi-même ;
- le secret n'est jamais écrit en clair, jamais renvoyé par l'API et jamais conservé par le navigateur ; une révocation invalide immédiatement les jetons et les sessions de ce compte ;
- un jeton (`dkr1.<charge utile>.<signature HMAC-SHA256>`) ne vaut que pour le rôle du compte, expire entre 60 s et 24 h, et devient inutile si le rôle ou le compte change ;
- les sessions de la console vivent **en mémoire du serveur** : redémarrer `npm run admin:api` déconnecte tout le monde, rien n'est écrit sur disque, et le cookie est `HttpOnly` + `SameSite=Strict` + `Path=/api`.

Limite déclarée : **l'enregistrement d'un compte n'est pas lui-même authentifié** — il n'existe pas d'autorité d'amorçage. `--created-by` est une provenance déclarée, pas une preuve ; la protection réelle est le poste de l'opérateur et les droits du répertoire (`0700`, fichiers `0600`). Ce que l'authentification garantit commence à la décision : une fois le compte créé, aucune approbation, aucun refus, aucune publication ne peut être enregistré sans preuve vérifiable, et chaque entrée nomme l'acteur, la méthode et l'heure.

## Revoir une version (revue humaine)

La revue est la deuxième porte. Elle ne publie rien : elle enregistre une décision nominative dans un journal append-only (`<dataset>/review/journal.jsonl`), chaîné par empreintes SHA-256. Toute altération d'une ligne rompt la chaîne et bloque les décisions suivantes.

```bash
npm run review:gtfs -- pending
npm run review:gtfs -- show <dataset_id>
npm run review:gtfs -- journal <dataset_id>   # chaîne complète, empreintes revérifiées

# un jeton de relecteur est exigé : plus aucun nom ne se tape à la main
TOKEN=$(npm run actors -- token fatou.ndiaye --ttl 3600 --secret "$SECRET" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

npm run review:gtfs -- approve <dataset_id> \
  --token "$TOKEN" \
  --attest source_identity="Identité et URL vérifiées auprès de l’éditeur le 2026-10-08" \
  --reference source_identity="$SOURCE_URL" \
  --attest reuse_rights="Licence ouverte publiée sur la page de la source" \
  --reference reuse_rights="$LICENCE_URL" \
  --attest operator_confirmed="Opérateur confirmé, réseau distinct d’AFTU" \
  --attest service_operational="Service exploité constaté aux dates déclarées" \
  --attest freshness_confirmed="Période de validité confirmée avec la source"

npm run review:gtfs -- reject <dataset_id> --token "$TOKEN" --reason "Source non identifiable"
npm run review:gtfs -- revert <dataset_id> --token "$TOKEN" --entry-id rv-000001 --reason "Licence non confirmée par l’éditeur"

# le jeton peut aussi venir d'un fichier, hors historique du shell
npm run review:gtfs -- approve <dataset_id> --token-file /tmp/fatou.token --attest … 
```

Règles appliquées par l'outil :

- la décision exige un **jeton de compte local** : signature vérifiée, expiration vérifiée, compte encore actif, rôle `reviewer` exigé. Le nom de la personne vient du jeton, jamais d'un argument texte ;
- l'entrée de journal enregistre l'acteur, la méthode d'authentification (`cli-token` ou `console-session`) et l'horodatage de l'authentification ;
- les cinq attestations sont obligatoires ; une approbation incomplète est refusée et rien n'est écrit ;
- les comptes génériques (`admin`, `test`, `anonymous`, …) sont refusés : la décision doit nommer une personne enregistrée ;
- l'approbation est refusée si l'archive est altérée, si le journal est corrompu, si la validité effective n'est pas `CURRENT`, si le type de source est `UNKNOWN`, si l'opérateur n'est pas confirmé ou si le statut déclaré n'est pas `ACTIVE` ;
- `revert` ajoute une entrée : la décision annulée reste lisible dans le journal ;
- chaque décision prend un verrou exclusif (`review/journal.lock`, `flock`) le temps du cycle lecture → décision → écriture : deux relecteurs simultanés ne peuvent pas produire deux entrées de même séquence, le second attend puis constate la décision déjà enregistrée. Le verrou est libéré par le noyau si le processus meurt ;
- une version refusée doit être réouverte par `revert` avant toute nouvelle décision ;
- la sortie reste `publication_status: NOT_PUBLISHED` et `publication_ready: false`, y compris après approbation.

## Publier un snapshot (troisième porte)

La publication est la seule étape qui rend une version lisible par l'application. Elle gèle la version approuvée dans un snapshot daté et immuable (`network.sqlite` + `manifest.json` haché), puis ajoute **une** entrée au journal des publications (`data/published/publication.jsonl`), chaîné par empreintes comme celui de la revue.

```bash
# jeton d'un compte de rôle « publisher », distinct de la personne qui a approuvé
PUBLISHER_TOKEN=$(npm run actors -- token ousmane.fall --ttl 3600 --secret "$SECRET" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

npm run publish:gtfs -- publish <dataset_id> \
  --token "$PUBLISHER_TOKEN" \
  --note "Publication du réseau vérifié le 2026-10-08"

npm run publish:gtfs -- list
npm run publish:gtfs -- show <snapshot_id>
npm run publish:gtfs -- verify <snapshot_id>
npm run publish:gtfs -- journal
npm run publish:gtfs -- revert --token "$PUBLISHER_TOKEN" --reason "Période de validité contestée par la source"
```

Règles appliquées par l'outil :

- publier exige un **jeton de compte local de rôle `publisher`** (même vérification de signature, d'expiration et d'activité que pour la revue) ;
- publier exige une revue `APPROVED`, un journal de revue intègre, une validité effective `CURRENT`, un `source_type` connu et un `service_status` `ACTIVE` — le tout revérifié au moment de la publication, pas au moment de l'approbation ;
- la **séparation des devoirs** est appliquée sans exception : si l'acteur qui publie est celui qui a approuvé la version, la publication est refusée (`SEPARATION_OF_DUTIES`). L'entrée enregistre le relecteur, l'empreinte de sa décision et l'authentification du publieur ;
- le snapshot est construit dans un répertoire temporaire puis renommé : rien n'est jamais écrit à moitié, et aucune version n'est écrasée ;
- **construire un snapshot ne le publie pas** : tant que le journal n'a pas d'entrée, le snapshot reste `UNLISTED` et l'API ne sert rien ;
- `verify` rehashe la base, recompte chaque table et compare au manifeste ; toute modification du fichier publié est signalée ;
- `revert` ajoute une entrée : le fichier publié reste sur disque, les deux entrées restent lisibles, et l'API cesse simplement de servir la version. Seul le snapshot actif peut être annulé ;
- un journal altéré (chaîne rompue) bloque toute publication et toute lecture : l'API ne sert alors plus rien plutôt que de servir un état douteux.

## API de lecture des données publiées

Les routes publiques répondent uniquement depuis le snapshot actif, en URL relative (relayées par Vite). Sans publication — ou si la publication a été annulée — elles répondent honnêtement qu'il n'y a rien à servir.

- `GET /api/network` — état de publication, provenance déclarée, empreintes, bornes et comptages ; `available: false` quand rien n'est publié ;
- `GET /api/stops/search?q=<texte>&limit=<1..100>` — recherche d'arrêts par nom, insensible à la casse et aux accents, sur les noms tels que déclarés dans le flux ;
- `GET /api/stops/near?lat=<...>&lon=<...>&radius=<1..5000>&limit=<1..100>` — arrêts dans un rayon, avec `distance_m` calculée depuis les coordonnées déclarées ;
- `GET /api/stops/<stop_id>` — un arrêt, les lignes qui le desservent et la plage horaire théorique déclarée (`stop_times`) ;
- `GET /api/routes` et `GET /api/routes/<route_id>` — lignes déclarées, agence, nombre de courses et d'arrêts, présence de tracés ;
- `GET /api/journeys` — courses directes déclarées entre deux lieux publiés (voir la section suivante) ;
- `GET /api/publications` — journal des publications : entrées, snapshot actif, snapshots listés (`ACTIVE`, `SUPERSEDED`, `REVOKED`, `UNLISTED`).

Chaque réponse porte `publication_status`, `snapshot_id`, `data_policy` et `realtime: false`. Les horaires sont des heures théoriques déclarées dans le flux : aucune position de véhicule, aucune estimation d'arrivée et aucune donnée inventée ne sont produites. Les requêtes invalides renvoient `400 INVALID_QUERY`, les identifiants inconnus `404 NOT_FOUND` et l'absence de publication `404 NOT_PUBLISHED`.

## Itinéraires directs (graphe dérivé du snapshot actif)

Le routage est une donnée dérivée : `data/published/network.graph.json` est reconstruit depuis le snapshot actif et enregistre le `snapshot_id` et l'empreinte `database_sha256` dont il vient. Dès que le graphe ne correspond plus au snapshot publié — ou qu'il est illisible — l'API refuse de router au lieu de répondre à partir d'un état douteux.

```bash
# reconstruit le graphe depuis le snapshot actif (fait aussi partie de toute publication réussie)
npm run graph:build
npm run graph:status
```

Ce que le graphe contient : les arrêts et leurs liens déclarés (lignes `transfers.txt`, stations parentes et arrêts dont les coordonnées déclarées sont à moins de 400 m), les lignes, les courses avec leurs heures théoriques et les calendriers (`calendar.txt` + `calendar_dates.txt`). Ce qu'il ne contient pas : aucune position de véhicule, aucune estimation, aucune correspondance calculée.

```bash
# depuis un lieu publié (nom ou identifiant d'arrêt) ou des coordonnées explicites
curl "http://127.0.0.1:8787/api/journeys?origin=Gare&destination=Aéroport&at=2026-10-08T05:50:00Z"
curl "http://127.0.0.1:8787/api/journeys?origin_lat=14.7051&origin_lon=-17.4602&destination=D6"
```

Règles appliquées :

- le lieu de départ et d'arrivée est soit un arrêt publié (nom ou identifiant, résolu dans le graphe), soit une paire `origin_lat`/`origin_lon` explicite : aucun géocodage, aucun lieu deviné ;
- la marche part des arrêts situés à moins de 400 m du point, puis suit uniquement les liens déclarés, dans la limite de `max_walk_m` (900 m par défaut) ; un lien déclaré dont les arrêts n'ont pas de coordonnées est signalé comme distance inconnue (`walk_m_known: false`), jamais comme une distance inventée ;
- une course proposée est une course **directe** : une montée, une descente, sur le même `trip_id`, avec sa date de service explicite ; les départs déjà passés ne sont jamais présentés comme à venir ;
- quand plus rien ne part aujourd'hui, la course du jour de service suivant est proposée avec sa date affichée (`result_date`, `exhausted_today`) ;
- quand aucune course directe n'existe, la réponse le dit (`reason`, `message`, `next_service_date`) et rappelle que le moteur à correspondances n'est pas implémenté : aucun trajet indirect n'est fabriqué ;
- `realtime` reste `false` et chaque résultat porte la mention « horaire théorique déclaré ».

## Console de gouvernance et décisions authentifiées

`npm run admin:api` expose sur `http://127.0.0.1:8787` la lecture publique et les décisions authentifiées.

Lecture (aucune authentification) :

- `GET /healthz` — état du service, racines servies, authentification exigée pour les décisions ;
- `GET /api/pipeline` — comptage par étape de gouvernance, publication réelle incluse ;
- `GET /api/catalog` — versions stagées, intégrité, validité effective, état de revue et décision active ;
- `GET /api/datasets/<dataset_id>` — dossier de revue complet (provenance déclarée, bloqueurs, attestations attendues) ;
- `GET /api/publications` — journal des publications et snapshots listés ;
- les routes publiques de données (`/api/network`, `/api/stops/...`, `/api/routes...`, `/api/journeys`) servies depuis le snapshot publié.

Session :

- `POST /api/session` — `{ actor_id, secret }` ouvre une session ; le cookie est `HttpOnly`, `SameSite=Strict`, `Path=/api`, et la réponse porte le jeton CSRF à renvoyer dans `X-Dakar-CSRF` ;
- `GET /api/session` — acteur connecté, rôle, expiration, jeton CSRF, ou `authenticated: false` sans rien inventer ;
- `DELETE /api/session` — ferme la session et efface le cookie ;
- `GET /api/actors` — comptes connus (aucun secret), réservé à une session ouverte.

Décisions (session exigée, en-tête `X-Dakar-CSRF` exigé, origine vérifiée) :

- `POST /api/datasets/<dataset_id>/decision` — `{ decision: "approve" | "reject", attestations, note, reason }`, rôle `reviewer` ;
- `POST /api/datasets/<dataset_id>/revert` — `{ entry_id, reason }`, rôle `reviewer` ;
- `POST /api/datasets/<dataset_id>/publication` — `{ note }`, rôle `publisher` ;
- `POST /api/publication/revert` — `{ reason, snapshot_id? }`, rôle `publisher`.

Ces routes appellent exactement les mêmes fonctions que la CLI (`approve_dataset`, `reject_dataset`, `revert_decision`, `publish_dataset`, `revert_publication`) : attestations obligatoires, journal chaîné, séparation des devoirs et intégrité du snapshot sont vérifiées au même endroit, quel que soit l'entrée. Le serveur répond `401` sans session, `403` pour un rôle insuffisant, un jeton CSRF absent ou une origine étrangère, `404` pour une version inconnue, `409` quand l'état l'interdit (décision déjà active, version non publiable, journal verrouillé), `422` pour une demande incomplète ou une attestation invalide, `429` après huit échecs de connexion en cinq minutes, et chaque refus porte son code, son message et ses bloqueurs. Les routes publiques restent GET-only et répondent `405 READ_ONLY_API` à tout autre verbe.

Dans l'application, la console locale (Paramètres) appelle ces routes en URL relative : Vite relaie `/api` vers l'API locale **en conservant l'en-tête `Host` du navigateur**, pour que l'origine comparée par le serveur soit bien celle appelée. Sans API joignable, la console affiche « Console hors ligne » et aucune décision. Avec une session ouverte, elle propose les actions du rôle — approuver, refuser, annuler une décision, publier, annuler une publication — et répète les refus du serveur tels quels.

## Gouvernance de l'information

- `NETWORK_SOURCES` décrit des connecteurs à mettre en place, pas des preuves de service.
- Les tableaux `VERIFIED_ROUTES`, `VERIFIED_STOPS` et `VERIFIED_ALERTS` sont vides jusqu'à l'ingestion de données validées.
- `canDisplayLive()` exige une source GTFS-RT/temps réel officielle, une vérification horodatée et une fraîcheur conforme.
- `formatScheduledCountdown()` ne transforme pas un horaire théorique en position de véhicule et n'affiche jamais `0 min` pour un départ futur.
- `canPublishAsActive()` exige une source, une version, une vérification, une validité courante, le statut `ACTIVE` et une provenance admissible. OSM seul ne prouve pas qu'un service de transport existe.
- TATA reste une catégorie distincte d'AFTU.
- La géolocalisation est conservée uniquement en mémoire côté navigateur ; aucune position n'est envoyée à une API ou persistée.
- Le service worker ne met pas en cache les tuiles cartographiques tierces, ni des horaires ou positions présentés comme temps réel.
- Une approbation de revue n'est pas une publication : seule une entrée du journal des publications rend un snapshot lisible.
- Un snapshot publié est immuable et haché ; si le fichier ne correspond plus à l'empreinte enregistrée, l'API ne sert plus rien du tout.
- Les données publiées restent des horaires théoriques (GTFS Static) : aucune position de véhicule, aucune estimation et aucun temps réel ne sont dérivés d'un flux statique.
- Le journal de revue est append-only : une annulation ajoute une entrée, elle n'en supprime aucune.
- Aucune décision anonyme : approuver, refuser, annuler ou publier exige un compte local authentifié, et l'entrée de journal nomme l'acteur, la méthode d'authentification et l'heure de cette authentification.
- Les secrets ne sont stockés que hachés (scrypt + sel, fichier `0600`, registre ignoré par Git) ; une révocation invalide les jetons et sessions du compte, et les comptes génériques sont refusés partout.
- La séparation des devoirs est appliquée par le serveur : la personne qui a approuvé une version ne peut pas la publier elle-même, même avec un jeton valide.
- Les sessions de la console vivent en mémoire : un redémarrage de l'API déconnecte tout le monde, et aucune session n'est écrite sur disque.
- Les écritures de la console exigent le jeton CSRF de la session et une origine identique à l'hôte ; un formulaire hostile ne peut pas décider à la place d'un acteur.
- L'enregistrement et la révocation des comptes ne sont pas authentifiés (pas d'autorité d'amorçage) : c'est une limite déclarée, protégée par les permissions du système de fichiers, et non une garantie cryptographique.

## Structure de l'application : quatre piliers exclusifs

La navigation est répartie sur quatre onglets, chacun avec un rôle unique : aucun élément n'empiète sur la vue d'un autre, et la carte n'est montée qu'à un seul endroit.

| Onglet | Rôle exclusif | Contenu |
| --- | --- | --- |
| **Explorer** | Guide de destination, carte et géolocalisation | Carte Leaflet en tiers supérieur, recherche « On va où ? », couches TER/BRT, géolocalisation, arrêts proches vérifiés et raccourcis Maison, Boulot et Adresse sur une ligne. Assistant IA disponible depuis la carte. |
| **Trajet** | Planification d’un itinéraire | Titre « Planifier un trajet » et couverture annoncée (TER · BRT · DDD · TATA · AFTU), deux encadrés Départ/Destination avec icônes repères et inversion en un geste, barre de recherche unique couvrant les cinq mobilités et tous les arrêts déclarés, bouton « Rechercher mon itinéraire », résultats avec durée, correspondances, ligne empruntée et prochain départ (point vert). Pas de fond de carte. |
| **Alertes** | Information voyageur | Deux vues : canaux officiels, et « Direct rue » (signalements d’usagers, locaux et non vérifiés). Aucune alerte n'est affichée sans source vérifiée, et l'absence d'alerte n'est jamais présentée comme un service normal. |
| **Paramètres** | Guide, informations et données | Guide d’utilisation visible ; réseaux, conditions, mises à jour et état des données dans des sections repliables ; console d’administration repliée par défaut. Pas de barre de recherche. |

Règles appliquées par le code et vérifiées par les tests (`src/App.test.tsx`, bloc « structure en quatre piliers ») :

- la carte Leaflet n'est **jamais montée** ailleurs que dans Explorer : sur les autres onglets elle est retirée du DOM (`is-map-hidden`), donc aucune tuile ni calcul de carte ;
- les points choisis « sur la carte » depuis Trajet passent par Explorer puis reviennent automatiquement à Trajet, et tout arrêt reste sélectionnable par son nom sans quitter Trajet ;
- tout bouton va jusqu’au bout de son action : un raccourci Maison/Boulot/Adresse, un « Partir d’ici » / « Aller ici » ou un choix sur la carte déclenchent le calcul dès que le départ et la destination sont connus ; aucun bouton ne s’arrête à mi-chemin ;
- les 23 stations BRT affichées suivent la séquence de référence encodée dans `src/domain/corridors.ts` ; les positions sont associées aux identifiants OSM du projet, mais leur exactitude et leur date de vérification externe ne sont pas documentées ;
- aucun slogan publicitaire : l'interface est réduite aux informations utiles.

## Carte et déploiement

Le fond actuel utilise les tuiles standard OpenStreetMap (`tile.openstreetmap.org`) avec attribution. Avant une mise en production à audience significative, choisir et configurer un fournisseur de tuiles adapté à la charge et respecter ses conditions d'utilisation. Les couches de transport doivent provenir de datasets distincts, versionnés et réutilisables légalement.

## Prochaines étapes de la feuille de route

1. Identifier les sources officielles, leurs conditions de réutilisation, la fréquence de mise à jour et les responsables de validation.
2. ~~Revue humaine traçable autour du staging/catalogue~~ — fait : journal chaîné, attestations obligatoires, retour arrière, et décisions authentifiées depuis la console comme depuis la CLI (comptes locaux, jeton Bearer, session à cookie). Reste la revue à plusieurs yeux et la rotation planifiée des secrets.
3. ~~Publier une version approuvée~~ — fait : snapshot SQLite daté et haché, journal append-only, retour arrière, API de lecture, interface branchée sur ces routes et séparation relecteur/publieur appliquée par le serveur.
4. ~~Routage sur les données publiées~~ — fait pour les courses directes déclarées (graphe dérivé, `/api/journeys`). Reste le moteur à correspondances, qui n'a de sens qu'avec des données réelles et un temps de correspondance déclaré, puis la recherche géographique de lieux.
5. Connecter les alertes et un flux temps réel uniquement après obtention d'une source exploitable.
6. Compléter les tests d'intégration, E2E, sécurité, monitoring, sauvegardes et administration.
