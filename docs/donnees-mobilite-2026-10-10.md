# Inventaire des données de mobilité — Dakar Bus

Date : 10 octobre 2026
Statut : référentiel central en service (`src/domain/referential.ts`) ; cet
inventaire liste les données réellement intégrées, leurs sources, les lacunes
par réseau et la marche à suivre pour les combler. **Aucune donnée inventée :
une absence est documentée, jamais remplacée.**

## 1. Référentiel central (nouveau)

`src/domain/referential.ts` est le point d'entrée unique qui alimente la
carte, la recherche, le calculateur et le copilote. Il dérive des modules
existants (`corridors.ts`, `frequencies.ts`, `network.ts`) sans les dupliquer,
et ajoute : un modèle commun par réseau (classification, statut
d'intégration, provenance), des requêtes transverses (arrêt par nom ou alias,
ligne par numéro, arrêts entre deux points, bornes de service publiées, arrêt
le plus proche) et un état des connaissances lisible par l'usager.

Statuts temporels affichés partout : **SCHEDULED** (publié), **ESTIMATED**
(calculé à partir de données identifiées), **REAL_TIME** (réservé à une
véritable source temps réel — aucune aujourd'hui), **UNKNOWN**.

Contrôles automatiques (`referential.test.ts`) : aucun arrêt fictif (le
référentiel contient exactement les 36 arrêts des corridors), aucune ligne
inventée, cohérence des relations lignes/arrêts/correspondances, provenance
sur chaque objet.

## 2. Ce qui est intégré, avec sources

| Réseau | Statut d'intégration | Données | Source déclarée | Vérification en ligne |
|---|---|---|---|---|
| **TER** | `REFERENCE_NETWORK` | 13 gares Dakar → Diamniadio (coordonnées OSM/SETER, ordre de desserte, zones tarifaires), fréquences officielles de référence par période (10 min journée, 20 min soirée/dimanche, fenêtres 05:30–22:00) | Sen TER / sentersa.sn, plan de transport ; positions OpenStreetMap | URL dans le dépôt ; **date de vérification en ligne non documentée** |
| **BRT** | `REFERENCE_NETWORK` | 23 stations Petersen – Papa Gueye Fall → Préfecture de Guédiawaye (ordre B1, nœuds OSM relations 19961937/19961993 `network=SunuBRT`), fréquence officielle de référence 6 min, fenêtre 06:00–21:00, desserte B3 annoncée (7 stations) | CETUD / sunubrt.sn ; positions OpenStreetMap | URL dans le dépôt ; **date de vérification en ligne non documentée** |
| **Correspondances** | déclarées | TER Dakar ↔ BRT Petersen (~1 km à pied), TER Colobane ↔ BRT Place de la Nation (~1,4 km) | estimation de référence entre positions déclarées | estimation, pas un cheminement mesuré |
| **DDD** | `METADATA_ONLY` | ampleur déclarée : 38 lignes, ~400 bus, amplitude 06:00–21:00 | CETUD (cetud.sn) | aucune ligne, aucun arrêt, aucun horaire |
| **AFTU** | `METADATA_ONLY` | ampleur déclarée : 72 lignes, ~2 300 minibus, 14 GIE, amplitude 06:00–21:00 | CETUD (cetud.sn) | aucune ligne, aucun arrêt, aucun horaire |
| **TATA** | `NOT_INTEGRATED` | mention d'un réseau distinct, classification à confirmer | recensement interne | rien |
| **Temps réel / perturbations / météo / trafic** | aucun connecteur | aucun flux GTFS-RT, aucune alerte opérateur, aucune source météo ou trafic | — | l'interface le dit explicitement |

Le GTFS de référence du dépôt (`tools/build_reference_gtfs.py`, pipeline
staging → revue → publication) reprend ces mêmes 36 arrêts et les deux lignes
TER/B1 ; il est gouverné par les trois portes existantes et n'est publié que
par décision humaine authentifiée.

## 3. Lacunes par réseau et données attendues

### TER
- Horaires de passage gare par gare et par sens (aujourd'hui : bornes de
  fenêtre et fréquences seulement → statut SCHEDULED partiel).
- Calendrier daté des exceptions et jours fériés.
- Grille complète des missions (semi-directes B2/B3 si elles existent côté fer).
- Tarifs zone par zone vérifiés auprès de SETER.
- Perturbations et info trafic (aucune source connectée).

### BRT
- Horaires de passage station par station, phase de la grille aux terminus.
- Tracés et arrêts exacts des variantes B2/B3 (seule la desserte B3 de 7
  stations est documentée).
- Tarif (explicitement non documenté → jamais affiché).
- Perturbations et info trafic.

### DDD (Dakar Dem Dikk)
Tout reste à faire : liste des 38 lignes urbaines, numéros, terminus, arrêts
dans l'ordre de desserte, tracés, horaires ou fréquences par ligne,
distinction urbain / express / interurbain / aéroportuaire, correspondances
TER/BRT. Le référentiel est prêt à les recevoir (`IntegrationStatus`,
`candidateLines.ts`) ; rien n'est inventé en attendant.

### AFTU
Idem : lignes, codes réellement utilisés, arrêts, terminus, variantes et
changements d'itinéraire confirmés. Les données communautaires éventuelles
devront être marquées comme telles (niveau de confiance), jamais présentées
comme officielles.

### Autres mobilités
Taxis collectifs, cars rapides, minibus informels, marche : intégration
possible seulement si une source fiable ou une collecte encadrée existe ; le
niveau de vérification devra être affiché avec chaque donnée.

## 4. Sources auditées et état d'accès (10 octobre 2026)

| Source | Ce qu'on y chercherait | État d'accès depuis l'environnement de travail |
|---|---|---|
| terdakar.sn / sentersa.sn | horaires TER, fiches gares, perturbations | **Non joignable ici** (politique réseau limitée à github.com, npm, pypi). À consulter depuis un poste connecté ; consigner la date de consultation. |
| sunubrt.sn | lignes BRT, stations, tarifs, horaires | **Non joignable ici** — idem. |
| cetud.sn (réseaux DDD/AFTU) | plans de lignes, données réseau | **Non joignable ici** — idem. Le CETUD publie des données « sur demande » : un courriel de demande officielle de GTFS est la voie à privilégier. |
| demdikk.sn | lignes DDD, actualité service | **Non joignable ici** — idem. |
| OpenStreetMap | géographie, positions d'arrêts, relations SunuBRT déjà exploitées | Utilisé pour les positions de référence ; OSM ne prouve ni horaires ni existence de service. |
| GitHub (recherche d'un GTFS Dakar existant) | jeu de données déjà publié | Recherche API GitHub du 10/10/2026 (`dakar gtfs`, `senegal gtfs`, `dakar transit`) : **aucun GTFS officiel de Dakar trouvé**. Les dépôts trouvés sont des projets applicatifs ou d'analyse, non des données opérateur vérifiables ; ils ne sont pas intégrés. |

## 5. Comment intégrer une nouvelle donnée dès réception

Le pipeline existant est reproductible et testé (133 tests Python) :

1. **Staging** : déposer l'archive (GTFS de préférence) avec le manifeste de
   provenance déclaré — `npm run stage:gtfs` (`scripts/stage_gtfs.py`) :
   checksum, comptages, rapport de validation, ZIP original conservé.
2. **Validation** : `npm run validate:gtfs` contrôle les tables essentielles,
   relations, coordonnées, horaires, calendriers, tracés, fréquences,
   transferts, doublons.
3. **Revue humaine** : `npm run review:gtfs` — cinq attestations obligatoires,
   relecteur nominatif, journal append-only chaîné.
4. **Publication** : `npm run publish:gtfs` — snapshot SQLite daté et haché,
   séparation relecteur/publieur appliquée par le serveur ; l'API de lecture
   sert alors les nouvelles lignes aux onglets Explorer/Trajet.
5. **Référentiel** : pour des données non GTFS (fiches opérateur), ajouter des
   entrées dans `corridors.ts`/`frequencies.ts` avec source, autorité, date de
   consultation et statut de vérification ; `referential.ts` les expose
   automatiquement au copilote et à la recherche.

Pour le **GTFS-Realtime**, les alertes et la météo : même exigence — une
source opérationnelle, ses conditions d'accès et une vérification horodatée
avant tout affichage ; l'application refuse structurellement les labels
« En direct »/« LIVE » sans source (`truth.ts`, `canDisplayLive`).

## 6. Ce que l'application dit aujourd'hui de ces lacunes

- Le copilote répond « non vérifié / non disponible » au lieu d'inventer
  (tests : `copilot.test.ts`, bloc « honnêteté et non-invention »).
- Explorer marque DDD/AFTU/TATA « Non déclaré » pour tout décompte.
- Paramètres montre l'état réel du catalogue et des API.
- Les réponses wolof portent la mention « modèles de base — en attente de
  validation par des locuteurs ».
