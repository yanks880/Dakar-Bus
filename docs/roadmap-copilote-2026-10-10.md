# Roadmap priorisée — copilote de mobilité Dakar Bus 2026

Date : 10 octobre 2026
Base : `docs/audit-copilote-2026-10-10.md` (état de référence vérifié : 258 tests
JS + 133 Python verts, build conforme, aucune modification non publiée).
Cadre : **tout est additif, réversible et testé**. Aucun parcours existant n'est
modifié ; chaque lot peut être livré et activé indépendamment.

## 1. Règles de classement

Échelles : Impact (Fible → Afort), Complexité (1→5), Dépendance données
(0 = aucune, L = locale/existante, E = source officielle à obtenir,
C = consentement utilisateur requis), Risque de régression (1→5), Maintenance
(1→5), Valeur différenciante (F→A). Les critères d'acceptation et les tests sont
par lot. La cible des cinq questions produit :

1. Comment rejoindre ma destination ? → **couvert** (Trajet + assistant).
2. Quel itinéraire correspond le mieux à ma priorité ? → **Lot 2 + Lot 3**.
3. Que sait-on des conditions de transport ? → **couvert** (Alertes, états) ;
   renforcé par Lot 5.
4. Quelle alternative si perturbation ? → **Lot 2** (partiel), Lot 5 (complet).
5. Comment gagner du temps ou réduire le coût ? → **Lot 3 + Lot 8** (sous
   réserve de tarifs sourcés).

## 2. Tableau de classement

| # | Fonctionnalité | Impact | Complexité | Dép. données | Risque régr. | Maint. | Valeur diff. | Lot |
|---|---|---|---|---|---|---|---|---|
| F1 | Confiance calculée + fraîcheur uniformisées (`lastObservedAt`, formule de confiance, étiquette « données anciennes » en repli local) | M | 2 | L | 2 | 2 | M | **1** |
| F2 | Tests de non-régression consolidés (CSP au build, passe « favoris→trajet », fraîcheur des libellés) | M | 1 | 0 | 1 | 1 | F | **1** |
| F3 | Copilote : interprétation d'intention (destination, heure d'arrivée, préférences) réutilisant planner + API | A | 3 | L | 2 | 2 | A | **2** |
| F4 | Copilote : comparaison et classement explicites des options calculables, avec limites, et ouverture dans Trajet | A | 3 | L | 2 | 2 | A | **2** |
| F5 | Comparateur multicritère dans les résultats Trajet (plus rapide, moins de marche, moins de correspondances ; « moins cher » seulement si tarifs sourcés) | A | 4 | L/E | 3 | 3 | A | **3** |
| F6 | Personnalisation progressive opt-in (trajets récurrents, préférences marche/correspondance, préremplissage, effacement) | M | 3 | L/C | 3 | 3 | M | **4** |
| F7 | Carte enrichie : calque « Direct rue » activable, état des lignes quand une source fiable existe | M | 2 | L/E | 2 | 2 | M | **5** |
| F8 | Alertes fondées sur événements vérifiables (sources officielles accessibles, horodatage, fiabilité affichée) | A | 4 | E | 2 | 4 | A | **6** |
| F9 | Contributions communautaires avancées (déduplication, confirmations agrégées, modération, partage serveur) | M | 4 | C+E | 3 | 4 | A | **7** |
| F10 | Assistant vocal (architecture Web Speech, français ; wolof seulement après tests représentatifs) | M | 3 | 0 | 2 | 3 | A | **8** |
| F11 | DDD/AFTU : inventaire sourcé hors production, puis lignes documentées dans le calculateur (spec du 10/10) | A | 4 | E | 3 | 3 | A | **9** |
| F12 | Connexion limitée : ressources essentielles, chargement différé, états hors ligne explicites | M | 2 | 0 | 2 | 2 | F | **1** (partiel) / continu |
| F13 | Économie du déplacement (comparaison de coûts, économies vs référence explicite) | M | 3 | E | 2 | 2 | A | **bloqué** sur tarifs sourcés (sinon lot 3 pour la mécanique) |
| F14 | Indicateurs P3 (bilan quotidien, indice de fluidité, temps gagné, régularité) | M | 4 | C+E | 3 | 4 | A | **différé** jusqu'à méthode + données représentatives |
| F15 | Moteur à correspondances serveur (au-delà des courses directes `/api/journeys`) | A | 5 | E | 3 | 4 | A | **différé** — déjà listé « prochaines étapes » du README, n'a de sens qu'avec des données réelles |

## 3. Classes de fonctionnalités

**Quick wins (aucune donnée externe requise)** : F1, F2, F12, F10 (architecture
seule), et la mécanique de F5/F13 sur les critères déjà calculables (marche,
correspondances, durée) sans le critère tarifaire.

**Dépendantes de sources officielles** : F8 (alertes opérateurs), F11 (tracés
DDD/AFTU sourcés CETUD/demdikk.sn), F13 (tarifs vérifiés TER **et** BRT),
F15 (GTFS réel + temps de correspondance), l'état des lignes de F7.

**Exigeant consentement et/ou collecte** : F6 (suggestions basées sur
l'historique), F9 (partage de signalements), F14 (mesures d'usage). Toutes
opt-in, effaçables, jamais pré-activées.

## 4. Lots de livraison (petits, indépendants, testables)

### Lot 1 — Fondations et quick wins (P0)

Contenu : F1, F2, F12.
1. **Confiance et fraîcheur calculées** : un module unique (ex.
   `src/domain/confidence.ts`) qui dérive un niveau de confiance d'une source
   (type, vérifiée ou non, validité, âge) — réutilisé par les affichages
   existants via leurs statuts actuels ; étiquette « données anciennes » quand
   le repli local s'affiche et que l'API est injoignable. Aucune donnée
   inventée : la formule calcule à partir de métadonnées déjà présentes.
2. **Tests de non-régression** : CSP vérifiée dans `dist/index.html` au build ;
   passe complète « favori → recherche → trajet → résultat » ; libellés
   d'honnêteté (estimation vs horaire vs indisponible) verrouillés par tests.
3. **Connexion limitée** : audit des poids, report de ce qui peut l'être, états
   hors ligne plus explicites — sans changer le design.

Acceptation : `npm test`, `npm run test:data`, `npm run build` verts ; aucune
modification visuelle ; la formule de confiance est documentée et testée
(fraîche → dégradée → inconnue, jamais remontée artificiellement).

### Lot 2 — Copilote v1 (P1)

Contenu : F3, F4 — extension de l'assistant **existant**, sans en changer l'UI.
1. Nouveau module de domaine (ex. `src/domain/intent.ts`) : reconnaît
   destination, heure d'arrivée cible (« avant 9 h »), et préférences
   (« le moins cher », « moins de marche », « évite les correspondances »,
   « compare »). Pur, testé, sans dépendance UI.
2. Le copilote appelle le **planner existant** avec des pondérations issues des
   préférences, compare les options **réellement calculables** (y compris les
   courses directes publiées quand l'API est disponible), classe selon le
   critère demandé et explique : donnée utilisée, hypothèse, limite.
3. Heure d'arrivée : retourne l'heure de départ conseillée calculée depuis les
   options disponibles, avec la fraîcheur de l'hypothèse — jamais une promesse.
4. « Ouvrir dans Trajet » : la réponse propose d'injecter le trajet dans
   l'interface existante (mécanisme déjà présent pour la recherche → Trajet).
5. Données insuffisantes (ex. tarif BRT inconnu) : le copilote **dit** qu'il ne
   peut pas classer sur ce critère — il n'invente pas.

Acceptation : chaque intention listée ci-dessus a ses tests (reconnaissance,
classement, refus honnête) ; les 258 tests existants passent inchangés ; aucune
nouvelle page ; l'assistant garde ses réponses actuelles pour les questions déjà
couvertes (tests de non-régression des 10 familles existantes).

### Lot 3 — Comparateur multicritère (P1)

Contenu : F5 (+ mécanique de F13, tarifs exclus tant que non sourcés).
1. Extension du planner **par paramétrage** : k-itinéraires en variant les
   pondérations (marche minimale, zéro correspondance, durée) — le moteur
   Dijkstra existant est réutilisé, pas remplacé ; les résultats restent les
   mêmes à pondération identique (test d'équivalence).
2. Présentation : critères connus / estimés / manquants par option, sous forme
   d'une extension discrète des résultats Trajet actuels ; pas de score global
   opaque — si un classement composite est proposé un jour, sa méthode est
   affichée en clair et testée.

Acceptation : l'affichage par défaut des résultats est inchangé tant que
l'utilisateur ne demande pas de comparaison ; tests : équivalence à coût
identique, k-options distinctes, critères manquants affichés comme tels, aucune
régression des trajets actuels.

### Lot 4 — Personnalisation progressive (P1)

Contenu : F6. Préférences **explicites** d'abord, stockage local uniquement.
1. Dans Paramètres (section repliable existante) : préférences de marche et de
   correspondances, trajets récurrents (nom, origine, destination, jours),
   activation/désactivation des suggestions, effacement total.
2. Préremplissage de la recherche selon le jour/heure **uniquement si**
   l'utilisateur a activé les suggestions ; nouvel utilisateur = aucune
   supposition.
3. Aucune donnée ne quitte l'appareil ; pas de suivi continu de position.

Acceptation : tout est désactivable et effaçable (tests) ; l'app est
entièrement fonctionnelle sans aucune préférence ; localStorage validé comme
l'existant (`isValidLatLng`).

### Lot 5 — Carte et alertes discrètes (P2, selon sources)

Contenu : F7 puis F8 **sous réserve de sources accessibles et vérifiables**.
1. Calque « Direct rue » activable (données déjà locales, TTL 90 min) — aucune
   position précise affichée sans consentement de saisie.
2. Alerte intelligente : uniquement des événements vérifiables (communiqué
   opérateur horodaté, signalement agrégé, météo officielle) ; chaque alerte
   porte source, heure et fiabilité ; quatre états distincts (confirmée /
   communautaire / risque estimé / absence d'information) ; suggestions
   proactives discrètes, jamais sur l'accueil.

Acceptation : aucune alerte affichée sans source vérifiable (test) ; couches
désactivables ; aucune prédiction présentée comme fiable sans historique
représentatif.

### Lot 6 — Contributions communautaires avancées (P2, requiert décision de produit + backend)

Contenu : F9. **Ne pas démarrer** avant une décision d'hébergement (GitHub
Pages est statique) et une politique de vie privée claire. Le socle local
(catégories, TTL, plafond, validation) existe ; ajouter déduplication,
confirmations indépendantes, limites de fréquence, modération — un signalement
n'est jamais une confirmation officielle.

### Lot 7 — Assistant vocal (P2)

Contenu : F10. Architecture extensible derrière l'assistant existant :
reconnaissance + synthèse en français (Web Speech API), feature-detectée,
désactivable ; le wolof n'est **pas annoncé** avant des tests représentatifs.
Acceptation : aucune régression du clavier ; l'assistant à règles reste la
seule source de réponses.

### Lot 8 — DDD/AFTU (P2, bloqué sur l'inventaire sourcé)

Contenu : F11 — suivre strictement `docs/spec-estimation-progressive-ddd-aftu.md`
(inventaire hors production → lignes documentées → estimation temporelle →
calibration par observations). Le module `candidateLines.ts` et ses types sont
déjà prêts ; `assumptions.ts` est l'endroit des hypothèses nommées. TATA reste
séparé. Aucune ligne fictive sur la carte, jamais.

### Différés explicites

- **F13 Économie** : la mécanique de comparaison arrive au Lot 3 ; l'affichage
  « moins cher » reste bloqué tant que les tarifs TER **et** BRT ne sont pas
  sourcés et validés (l'assistant actuel dit déjà honnêtement que le tarif BRT
  n'est pas documenté).
- **F14 Indicateurs P3** : aucune définition = aucun affichage. Chaque
  indicateur exigera définition, référence, période et méthode documentées
  avant toute UI.
- **F15 Moteur à correspondances serveur** : dès qu'un GTFS réel et des temps
  de correspondance déclarés existent (déjà « prochaines étapes » du README).

## 5. Ordre d'exécution et contrôle

Pour chaque lot, dans cet ordre :

1. État de référence : `npm test` (258), `npm run test:data` (133),
   `npm run build` — verts avant de commencer.
2. Implémentation strictement limitée au lot approuvé, additive, branchée sur
   les points d'intégration listés dans l'audit (§ 4).
3. Tests du lot + suite complète de non-régression (aucun test existant
   modifié sans nécessité démontrée).
4. Build + smoke bundle + vérification visuelle (aucun changement de couleurs,
   espacements, disposition).
5. Diff relu ligne à ligne avant commit ; branche et PR dédiées par lot ;
   fusion seulement après CI verte ; déploiement Pages confirmé avant
   d'annoncer la disponibilité.

Si l'accès distant est indisponible : conserver le lot documenté localement,
ne jamais annoncer de publication.

## 6. Ce que cette roadmap interdit explicitement

- Reconstruire l'application, la navigation, le design ou le moteur.
- Afficher véhicules fictifs, trafic simulé, wolof non testé, indice de
  fluidité sans données, « moins cher » sans tarifs, prédictions sans historique.
- Activer des suggestions ou une collecte sans consentement clair et réversible.
- Faire du modèle IA la source de vérité des horaires, lignes ou arrêts.

## 7. Prochain pas concret

**Lot 1** (fondations et quick wins) — aucune dépendance externe, aucun risque
visuel, immédiatement testable. Validation attendue avant d'entamer le Lot 2
(copilote), qui est le premier chantier à forte valeur différenciante.
