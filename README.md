# Dakar Bus

Web app mobile-first pour explorer la mobilité de Dakar. L'interface place la carte au centre du produit et applique une règle stricte : aucun arrêt, horaire, tracé, statut de service ou passage n'est publié sans donnée traçable.

## État actuel

Cette première fondation fournit :

- une carte interactive de Dakar, avec fond OpenStreetMap et attribution visible ;
- une interface responsive avec Carte, Itinéraire, Explorer et Alertes ;
- une demande de géolocalisation explicite, affichage de sa précision et gestion des refus/erreurs ;
- une sélection de départ et destination par toucher/clic sur la carte ;
- un catalogue de sources prévu pour TER, BRT, Dakar Dem Dikk, AFTU et TATA, sans prétendre qu'un jeu de données est déjà intégré ;
- une PWA installable et un cache hors connexion limité à l'enveloppe de l'application ;
- un auditeur GTFS Static en lecture seule, sans extraction de l’archive, avec rapport JSON, contrôle des tables essentielles, relations, coordonnées, horaires, calendriers, tracés, fréquences et transferts ;
- un outil de staging versionné qui conserve le ZIP original, son checksum, le manifeste de provenance déclaré, les comptages et le rapport de validation, sans publication automatique ;
- une revue humaine traçable : cinq attestations obligatoires, un relecteur nominatif, un journal append-only chaîné par empreintes et un retour arrière qui n'efface rien ;
- une API locale en lecture seule (`/api/pipeline`, `/api/catalog`, `/api/datasets/<id>`) et un onglet Gouvernance qui affiche l'état réel du catalogue ou signale honnêtement qu'il n'est pas joignable ;
- des règles testées pour le statut des horaires, le label LIVE, les décomptes en minutes et la publication d'objets actifs.

**Aucun flux GTFS, GTFS-RT, horaire, arrêt, ligne, tracé, alerte ou donnée opérateur n'est actuellement fourni par ce dépôt.** La carte de fond représente uniquement la géographie OpenStreetMap. Le calcul d'itinéraire reste donc volontairement indisponible et l'interface l'explique au lieu de fabriquer un résultat. Un clic sur la carte choisit un point géographique, mais ne le géocode pas en nom de lieu.

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

Pour voir l'onglet Gouvernance alimenté, lancer l'API locale puis le serveur de développement dans deux terminaux :

```bash
npm run admin:api   # http://127.0.0.1:8787, lecture seule
npm run dev         # relaie /api vers l'API locale
```

Le workflow GitHub Actions (`.github/workflows/ci.yml`) exécute le build, les deux suites de tests et l’audit des dépendances à chaque push et pull request.

## Structure

```text
src/
  App.tsx                 écrans et interactions, console de gouvernance
  App.css                 design system responsive
  App.test.tsx            tests des parcours, états sans données et console
  components/TransitMap   carte, position GPS, points choisis
  domain/network.ts       registre des sources (aucun réseau publié par défaut)
  domain/network.test.ts  tests du catalogue initial vide
  domain/truth.ts         garde-fous de provenance et d'affichage
  domain/truth.test.ts    tests de non-invention
  domain/review.ts        modèle de lecture du catalogue et de la revue
  domain/review.test.ts   tests de parsing strict et de non-invention
scripts/
  validate_gtfs.py       validateur GTFS Static en lecture seule
  stage_gtfs.py          staging versionné, provenance à revoir
  catalog_gtfs.py        catalogue local en lecture seule, état de revue inclus
  review_ledger.py       journal append-only chaîné par empreintes
  review_gtfs.py         revue humaine : approbation, refus, retour arrière
  serve_admin_api.py     API HTTP en lecture seule pour la console
public/
  manifest.webmanifest    métadonnées PWA
  sw.js                  cache de l'enveloppe applicative, jamais /api
tests/
  test_validate_gtfs.py    tests de validation de flux GTFS
  test_stage_gtfs.py       tests de versionnage et de staging
  test_catalog_gtfs.py     tests d’intégrité et de comparaison catalogue
  test_review_gtfs.py      tests d’approbation, de refus et de retour arrière
  test_serve_admin_api.py  tests de l’API en lecture seule
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

## Revoir une version (revue humaine)

La revue est la deuxième porte. Elle ne publie rien : elle enregistre une décision nominative dans un journal append-only (`<dataset>/review/journal.jsonl`), chaîné par empreintes SHA-256. Toute altération d'une ligne rompt la chaîne et bloque les décisions suivantes.

```bash
npm run review:gtfs -- pending
npm run review:gtfs -- show <dataset_id>

npm run review:gtfs -- approve <dataset_id> \
  --reviewer prenom.nom \
  --attest source_identity="Identité et URL vérifiées auprès de l’éditeur le 2026-10-08" \
  --reference source_identity="$SOURCE_URL" \
  --attest reuse_rights="Licence ouverte publiée sur la page de la source" \
  --reference reuse_rights="$LICENCE_URL" \
  --attest operator_confirmed="Opérateur confirmé, réseau distinct d’AFTU" \
  --attest service_operational="Service exploité constaté aux dates déclarées" \
  --attest freshness_confirmed="Période de validité confirmée avec la source"

npm run review:gtfs -- reject <dataset_id> --reviewer prenom.nom --reason "Source non identifiable"
npm run review:gtfs -- revert <dataset_id> --reviewer prenom.nom --entry-id rv-000001 --reason "Licence non confirmée par l’éditeur"
```

Règles appliquées par l'outil :

- les cinq attestations sont obligatoires ; une approbation incomplète est refusée et rien n'est écrit ;
- les comptes génériques (`admin`, `test`, `anonymous`, …) sont refusés : la décision doit nommer une personne ;
- l'approbation est refusée si l'archive est altérée, si le journal est corrompu, si la validité effective n'est pas `CURRENT`, si le type de source est `UNKNOWN`, si l'opérateur n'est pas confirmé ou si le statut déclaré n'est pas `ACTIVE` ;
- `revert` ajoute une entrée : la décision annulée reste lisible dans le journal ;
- une version refusée doit être réouverte par `revert` avant toute nouvelle décision ;
- la sortie reste `publication_status: NOT_PUBLISHED` et `publication_ready: false`, y compris après approbation.

## Console de gouvernance en lecture seule

`npm run admin:api` expose le catalogue et l'état de revue sur `http://127.0.0.1:8787` :

- `GET /healthz` — état du service ;
- `GET /api/pipeline` — comptage par étape de gouvernance, `published` toujours à 0 ;
- `GET /api/catalog` — versions stagées, intégrité, validité effective, état de revue ;
- `GET /api/datasets/<dataset_id>` — dossier de revue complet (provenance déclarée, bloqueurs, attestations attendues).

L'API ne propose aucun verbe d'écriture : `POST`, `PUT`, `PATCH` et `DELETE` renvoient `405 READ_ONLY_API`. Les identifiants sont validés avant tout accès disque, les réponses portent `Cache-Control: no-store`, et le service worker ne met jamais `/api` en cache. Dans l'application, l'onglet Gouvernance appelle ces routes en URL relative (relaiées par Vite) ; sans API joignable, il affiche « Console hors ligne » au lieu d'inventer un catalogue.

## Gouvernance de l'information

- `NETWORK_SOURCES` décrit des connecteurs à mettre en place, pas des preuves de service.
- Les tableaux `VERIFIED_ROUTES`, `VERIFIED_STOPS` et `VERIFIED_ALERTS` sont vides jusqu'à l'ingestion de données validées.
- `canDisplayLive()` exige une source GTFS-RT/temps réel officielle, une vérification horodatée et une fraîcheur conforme.
- `formatScheduledCountdown()` ne transforme pas un horaire théorique en position de véhicule et n'affiche jamais `0 min` pour un départ futur.
- `canPublishAsActive()` exige une source, une version, une vérification, une validité courante, le statut `ACTIVE` et une provenance admissible. OSM seul ne prouve pas qu'un service de transport existe.
- TATA reste une catégorie distincte d'AFTU.
- La géolocalisation est conservée uniquement en mémoire côté navigateur ; aucune position n'est envoyée à une API ou persistée.
- Le service worker ne met pas en cache les tuiles cartographiques tierces, ni des horaires ou positions présentés comme temps réel.
- Une approbation de revue n'est pas une publication : `publication_status` reste `NOT_PUBLISHED` et l'étape de publication n'est pas implémentée.
- Le journal de revue est append-only : une annulation ajoute une entrée, elle n'en supprime aucune.
- L'API d'administration est en lecture seule ; la console web ne peut enregistrer aucune décision.

## Carte et déploiement

Le fond actuel utilise les tuiles standard OpenStreetMap (`tile.openstreetmap.org`) avec attribution. Avant une mise en production à audience significative, choisir et configurer un fournisseur de tuiles adapté à la charge et respecter ses conditions d'utilisation. Les couches de transport doivent provenir de datasets distincts, versionnés et réutilisables légalement.

## Prochaines étapes de la feuille de route

1. Identifier les sources officielles, leurs conditions de réutilisation, la fréquence de mise à jour et les responsables de validation.
2. ~~Revue humaine traçable autour du staging/catalogue~~ — fait : journal chaîné, attestations obligatoires, retour arrière, console en lecture seule. Reste l'authentification et l'écriture depuis la console.
3. Implémenter la publication elle-même : sélection d'une version approuvée, normalisation des tables GTFS vers un stockage de données, snapshot daté et retour arrière, avant toute couche carte.
4. Ajouter l'API publique et un moteur de recherche géographique/routage multimodal sur des données réelles.
5. Connecter les alertes et un flux temps réel uniquement après obtention d'une source exploitable.
6. Compléter les tests d'intégration, E2E, sécurité, monitoring, sauvegardes et administration.
