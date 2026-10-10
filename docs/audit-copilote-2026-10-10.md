# Audit préalable — copilote de mobilité Dakar Bus

Date : 10 octobre 2026
Périmètre : audit complet du dépôt avant tout travail sur la roadmap
« Innovation et intelligence mobilité 2026 ». Aucun code n'est modifié par ce
document. Il complète (et ne remplace pas) `docs/audit-2026-10-09.md`.

## 1. Méthode

1. Lecture de l'historique Git, des branches et des demandes de tirage fusionnées.
2. Examen de la documentation existante (README, audits, spécifications).
3. Revue ligne à ligne des modules de domaine, composants, console, pipeline
   Python, service worker, configuration de build et workflows CI/CD.
4. Exécution de l'état de référence complet (tests, build, audits de dépendances)
   sur la branche de travail, issue du `main` courant.

## 2. État de référence vérifié (10 octobre 2026)

| Contrôle | Résultat |
|---|---|
| Branche | `main` @ `a4fd20b` (fusion PR #16), arbre de travail **propre** |
| `npx vitest run` | **258 / 258** (21 fichiers) |
| `python3 -m unittest discover -s tests` | **133 / 133** |
| `npm run build` (tsc + vite + smoke) | OK — CSP posée, cache borné (`dakar-bus-shell-v5`, 48 entrées), 4 chunks JS, contraste AA vérifié dans le CSS produit |
| `npm audit` | 0 vulnérabilité (CI) |
| Modifications non publiées | **Aucune** — pas de stash, pas de fichier modifié |
| PR récentes | #12, #13, #14, #15, #16 toutes **fusionnées** dans `main` |

Le travail récent d'Arena (PR #12 → #16) est donc entièrement intégré dans
`main` : horaires par station et par sens, corrections du moteur d'estimation,
accordéon TER, spec DDD/AFTU, contraste AA, cache borné, découpage du bundle,
durcissement réseau (délais 12 s, frontière d'erreur, garde « dernière requête
gagne ») et validation des signalements. **Rien à reprendre, rien à refaire.**

## 3. Ce qui existe et fonctionne (cartographie)

### 3.1 Interface (4 piliers exclusifs, testés)

| Pilier | Contenu opérationnel |
|---|---|
| **Explorer** | Carte Leaflet (seul montage, memoïsée), recherche « On va où ? » (répond via l'assistant et ouvre Trajet), couches TER/BRT activables, géolocalisation explicite, arrêts proches publiés, raccourcis Maison/Boulot/Adresse (localStorage), résumé réseaux avec décomptes vivants, tableaux station par station et sens par sens (TER 13 gares, BRT 23 stations), assistant IA flottant. |
| **Trajet** | Recherche d'itinéraires : courses directes publiées via `/api/journeys` quand un snapshot est servi ; sinon estimation locale TER/BRT (`planner.ts`) explicitement étiquetée. Résultats avec durée, correspondances, ligne, prochain départ théorique (point vert). Calculateur multimodal TER+BRT (arrêts ou points carte). |
| **Alertes** | Canaux officiels (Sen TER, SunuBRT, CETUD) en liens ; « Direct rue » : signalements locaux (5 catégories), TTL 90 min, jamais présentés comme officiels, effaçables. |
| **Paramètres** | Guide, réseaux et conditions, état réel des sources et du catalogue, console de gouvernance repliée (session, décisions authentifiées), CGU, historique des versions. |

Transverses : thème clair/sombre persistant, haptique mobile, PWA installable,
frontière d'erreur, délais d'annulation sur toutes les lectures.

### 3.2 Domaine TypeScript (18 modules, tous testés)

| Module | Rôle | État |
|---|---|---|
| `corridors.ts` | Réseau de référence TER (13 gares) / BRT (23 stations), provenance déclarée, transferts, bornes région | Stable, verrouillé par tests |
| `frequencies.ts` | Fréquences officielles de référence + sources (vérifiées ou `UNVERIFIED_IN_REPOSITORY`), validités | Stable |
| `headways.ts` | Projection des grilles → prochains créneaux théoriques (UTC+00 Dakar, jamais « 0 min », jours/fenêtres respectés) | Stable (corrigé audit 09/10) |
| `stationBoard.ts` | Créneaux par station et par sens, projection terminus → arrêts | Stable |
| `planner.ts` | Calculateur multimodal TER+BRT (Dijkstra : marche, attente demi-headway, parcours, correspondance marchable) ; refuse au lieu d'inventer | Stable |
| `assumptions.ts` | **Hypothèses nommées et centralisées** (vitesse marche, dwell, vitesses commerciales, fraction d'attente) | Stable, prêt pour DDD/AFTU |
| `truth.ts` | Garde-fous de vérité : `canDisplayLive`, `canPublishAsActive`, `formatScheduledCountdown`, statuts | Stable — c'est le contrat « zéro invention » de l'app |
| `assistant.ts` | Moteur local à règles branché sur corridors/planner/état des API ; 10 familles de questions ; refuse au lieu d'inventer | Stable, **à étendre (P1)** |
| `streetReports.ts` | « Direct rue » : validation stricte, TTL, plafond 40, local uniquement | Stable |
| `candidateLines.ts` | **Inventaire additif DDD/AFTU** (types, sources, hypothèses, confiance) — `CANDIDATE_LINES` vide tant qu'aucun tracé sourcé | Prêt, non câblé à l'UI (voulu) |
| `network.ts` | Registre des 5 réseaux, `VERIFIED_*` vides, statuts de connexion | Stable |
| `published.ts`, `journeys.ts`, `review.ts`, `session.ts`, `stops.ts`, `http.ts` | Clients stricts des API (parsing refusé si malformé), session cookie+CSRF, URL sûres, délais 12 s | Stables |

### 3.3 Pipeline de gouvernance Python (17 scripts, 133 tests)

Trois portes : staging (provenance déclarée) → revue humaine (5 attestations,
journal append-only chaîné, verrou `flock`) → publication (snapshot SQLite
immuable et haché, journal chaîné, séparation relecteur/publieur appliquée par
le serveur). API de lecture servie uniquement depuis le snapshot actif, refus
total au moindre doute (`/api/journeys` : courses directes déclarées seulement).
Comptes locaux scrypt, jetons HMAC courts, sessions mémoire, CSRF, durcissement
Host/Origin/CSP (audit 09/10). Graphe d'itinéraires dérivé, refusé s'il ne
correspond plus au snapshot.

### 3.4 CI/CD

- `ci.yml` : build + vitest + unittest + `npm audit` sur chaque push/PR.
- `deploy.yml` : GitHub Pages depuis `main` (base `/Dakar-Bus/`).

## 4. Composants réutilisables et points d'intégration

Toute nouveauté de la roadmap doit se brancher sur ces points, sans les remplacer :

| Point d'intégration | Pour quoi |
|---|---|
| `src/domain/assistant.ts` (`answerAssistant`, `AssistantContext`) | Copilote P1 : ajouter des familles de questions et un classement, réutiliser `planReferenceJourney` et les API publiées |
| `src/domain/planner.ts` (`planReferenceJourney`, `PlannerOutcome`) | Comparateur P1 : paramétrer les coûts (marche, correspondances) plutôt que réécrire le moteur |
| `src/components/MultimodalPlanner.tsx` / `RouteOutcome` | Affichage des critères en complément des résultats actuels |
| Raccourcis `dakar-bus:destinations` + `MapPoint` | Personnalisation P1 : destinations favorites existantes, validation `isValidLatLng` déjà en place |
| `src/domain/streetReports.ts` + `StreetReportPanel.tsx` | Contributions P2 : catégories, TTL, plafond déjà codés |
| Sections repliables de Paramètres (`SettingsDisclosure`) | Préférences facultatives, état des données |
| Couches de carte (`TransitMap.tsx`, interrupteurs TER/BRT) | Calques P2 activables |
| `truth.ts` + `frequencies.ts` (statuts et provenance) | Tout affichage de confiance / fraîcheur |
| Changelog (`ChangelogSection`) et format d'entrée existant | Traçabilité de chaque lot |
| Tests : `App.test.tsx` (4 piliers, non-invention), `domain/*.test.ts` | Non-régression P0.C |

## 5. Choix validés à préserver (non négociables)

1. **Zéro invention** : `truth.ts` est le contrat — pas de LIVE sans flux
   temps réel vérifié, pas d'objet actif sans source+version+vérification+validité,
   jamais « 0 min », jamais de véhicule fictif ni de trafic simulé.
2. **Quatre piliers exclusifs** : la carte n'est montée que dans Explorer ;
   aucun nouvel onglet ; les tests verrouillent cette structure.
3. **Estimation ≠ horaire ≠ temps réel ≠ officiel** : les libellés et statuts
   existants (`OFFICIAL_REFERENCE`, `SCHEDULED`, `ESTIMATED`, `UNKNOWN`) sont la
   seule taxonomie d'affichage autorisée.
4. **Hypothèses centralisées et nommées** (`assumptions.ts`) : aucune constante
   de fréquence/vitesse arbitraire dans le code, surtout pour DDD/AFTU/TATA.
5. **Révocabité** : toute nouveauté doit pouvoir être désactivée sans toucher
   à l'existant (calques, sections repliées, préférences opt-in).
6. **Design et navigation** : couleurs (vert AA vérifié par le build),
   espacements, disposition, textes : inchangés sauf autorisation explicite.
7. **Discipline de gouvernance** : les données transport ne deviennent
   « publiées » que par le pipeline à trois portes ; l'app n'est pas la source
   de vérité, le snapshot l'est.

## 6. Écarts constatés par rapport à la roadmap 2026 (ce qui manque)

| Capacité visée | État actuel | Écart |
|---|---|---|
| P0.A Moteur de données fiable | Provenance, vérification, validité, statuts par donnée (frequencies, corridors, published, candidateLines) | **Mineur** : pas de niveau de confiance *calculé* (formule unique) ni de `lastObservedAt` uniformisés ; chaque module encode ses métadonnées à sa main |
| P0.B Couche d'intelligence modulaire | Assistant à règles + planner, couplés côté UI | **Confirmé manquant** : aucune couche indépendante d'interprétation d'intention (heure d'arrivée, préférences, comparaison) ni de classement multicritère réutilisable |
| P0.C Non-régression | 391 tests couvrant 4 piliers, non-invention, décomptes, signalements, console | **Mineur** : CSP de production non testée automatiquement ; pas de test navigateur (enregistrement SW sous `/Dakar-Bus/`) ; pas de garde E2E sur favoris+trajet en une passe |
| P1 Copilote | Assistant répond à : fréquences, listes, trajets, tarifs, horaires, perturbations, état des données | Ne comprend pas : « être à X avant 9 h », « le moins cher », « moins de marche », « évite les correspondances », « compare les options » |
| P1 Comparateur | Le planner renvoie **un** itinéraire optimal à coût unique | Pas de k-options comparables ni de critères explicites (marche, correspondances, coût) |
| P1 Personnalisation | Destinations favorites (3 raccourcis) persistées et validées | Pas de trajets récurrents, pas de préférences marche/correspondance, pas de suggestions, pas de zone d'effacement des données |
| P2 Alertes | Canaux officiels en liens + Direct rue local | Aucune couche d'événements vérifiables agrégés (nécessite des sources accessibles) |
| P2 Carte enrichie | Couches TER/BRT | Pas de calque incidents/perturbations (peut s'appuyer sur Direct rue local) |
| P2 Contributions | Direct rue local, TTL, plafond | Pas de déduplication, pas d'agrégation de confirmations, pas de modération (le partage serveur est un choix de produit à ne pas prendre à la légère) |
| P2 Vocal | Rien | Architecture extensible à prévoir (Web Speech, FR d'abord) |
| P2 DDD/AFTU | Spec + module `candidateLines.ts` prêts (vides) | **Bloqué sur les données** : aucun tracé sourcé versé ; l'inventaire (CETUD, demdikk.sn) reste à faire hors production |
| P2 Connexion limitée | SW borné v5, hors ligne shell, états d'erreur honnêtes | Pas d'étiquette systématique « données anciennes » quand l'API est injoignable et que le repli local sert |
| P2 Économie | Tarifs TER de référence dans l'assistant (texte, « à confirmer ») ; BRT non documenté | Pas de comparaison de coûts : **interdit** tant que les tarifs ne sont pas sourcés et validés |
| P3 Indicateurs | Rien | Voulu : à ne pas afficher avant méthode et données représentatives |

## 7. Risques et limites à garder en tête

1. **Dépendance aux données officielles** : tout ce qui touche DDD/AFTU/TATA,
   tarifs complets, alertes et temps réel est bloqué sur des sources externes à
   identifier et vérifier — c'est le principal chemin critique du produit.
2. **GitHub Pages = statique** : l'API de lecture/gouvernance n'existe qu'en
   local ; l'app publique fonctionne en repli « réseau de référence »
   étiqueté. Tout ce qui suppose un serveur (contributions partagées, alertes
   poussées) exige une décision d'hébergement préalable.
3. **Performance du domaine principal** : `App.tsx` (~3 100 lignes) est le point
   de fusion de tout ; chaque ajout doit rester additif et passer par les
   composants/domaine existants pour ne pas aggraver la dette.
4. **Limites reportées par l'audit 09/10** (toujours valides) :
   `frame-ancestors` à poser chez l'hébergeur, CSP non couverte par un test
   automatisé, serveur d'administration à garder hors internet, sessions en
   mémoire.
5. **Assistant = règles, pas LLM** : c'est un choix délibéré (pas de service
   externe, déterministe, testé). Le copilote P1 doit rester dans ce cadre ;
   un modèle IA, s'il arrive un jour, n'est jamais la source de vérité.

## 8. Conclusion de l'audit

L'application est saine, testée et cohérente avec sa promesse d'honnêteté des
données. Les fondations P0 existent presque entièrement : le travail P0
restant est de la **formalisation** (confiance calculée, étiquetage de fraîcheur)
et de la **couverture de tests**, pas une reconstruction. Les capacités P1
(copilote à préférences, comparateur) peuvent être construites **par extension
du planner et de l'assistant existants** sans toucher aux parcours utilisateurs
validés. Les capacités P2/P3 sont pour l'essentiel **dépendantes de données ou
de consentement** et doivent suivre la spec DDD/AFTU déjà écrite.

La roadmap priorisée qui accompagne ce document
(`docs/roadmap-copilote-2026-10-10.md`) découle intégralement de ces constats.
