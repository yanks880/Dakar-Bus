# Spécification — estimation progressive des passages DDD/AFTU

Date : 10 octobre 2026  
Statut : proposition technique, documentation uniquement. Aucun code applicatif n'est modifié par ce document.

## 1. Objectif et limites

Rendre le calculateur Dakar Bus utile même lorsque les horaires complets DDD/AFTU ne sont pas disponibles, sans prétendre disposer d'horaires officiels ou d'un suivi temps réel.

Cette spécification complète l'architecture actuelle ; elle ne la remplace pas. Les modules existants `frequencies.ts`, `headways.ts`, `corridors.ts`, `stationBoard.ts` et `planner.ts` restent la référence d'implémentation à examiner avant toute modification.

## 2. Garde-fous de préservation

- Ne pas réécrire l'application, le moteur TER/BRT ou les composants d'interface existants.
- Ne pas modifier le design, les couleurs, la carte, le GPS, l'assistant, la navigation ou les choix validés avec Arena AI.
- Ne pas supprimer ni renommer les API/types existants sans nécessité démontrée.
- Ajouter les capacités DDD/AFTU par extension isolée et rétrocompatible.
- Garder TATA séparé jusqu'à confirmation de sa classification et de ses données.
- Ne jamais convertir une estimation en horaire officiel, ni afficher « temps réel » sans flux de véhicules réel.
- Les fonctions TER/BRT et leurs tests de régression doivent continuer à fonctionner sans changement de comportement.

## 3. Sources à examiner et ordre de priorité

1. **CETUD — DDD** : https://cetud.sn/reseaux-de-transport/ddd/
2. **CETUD — AFTU** : https://cetud.sn/reseaux-de-transport/aftu/
3. **CETUD — site principal / observatoire** : https://cetud.sn/
4. **Dakar Dem Dikk — site opérateur** : https://demdikk.sn/
5. Plans officiels CETUD, documents de lignes, fiches opérateurs et données GTFS disponibles sur demande.
6. Observations de passages collectées dans Dakar Bus, si l'usager choisit explicitement de les envoyer.

Les plans de lignes prouvent au mieux l'existence et le tracé publié d'une ligne ; ils ne prouvent pas ses horaires, sa fréquence actuelle, tous ses arrêts ni sa régularité. Chaque donnée importée doit conserver l'URL exacte, le nom de l'autorité, la date de consultation et, si disponible, la période de validité.

Une donnée trouvée dans une page publique doit être contrôlée avant intégration : sens, terminus, jours, premier/dernier départ, date de publication et correspondance avec la ligne concernée. Ne pas inventer les numéros de lignes, les arrêts, les coordonnées ou les départs manquants.

## 4. Quatre niveaux de données temporelles

Chaque résultat doit être issu d'un niveau identifiable. Le niveau est stocké dans le domaine ; l'interface existante reste compacte.

### Niveau A — Horaire publié

Utilisable seulement quand l'opérateur ou le CETUD publie un départ daté ou une grille exploitable. Enregistrer au minimum :

- réseau, identifiant et nom de ligne ;
- sens et terminus concerné ;
- heure de départ et jours applicables ;
- date de publication/consultation et validité connue ;
- URL et organisme source.

Un départ de terminus n'est pas automatiquement l'heure de passage à chaque arrêt : il faut une durée par tronçon estimée ou une table de temps de parcours publiée.

### Niveau B — Fréquence publiée

Quand une fréquence officielle est explicitement donnée, utiliser la fréquence et sa fenêtre de service. Un intervalle seul ne détermine pas la minute exacte du prochain véhicule sans ancre temporelle (départ connu ou phase de grille).

Si les passagers arrivent de manière aléatoire et que le service est suffisamment régulier, l'attente moyenne théorique peut être approchée par la moitié de l'intervalle. C'est une moyenne statistique, pas un compte à rebours garanti.

### Niveau C — Estimation modélisée

Quand il n'existe pas d'horaire public, calculer ce qui est calculable :

- temps de marche depuis/vers un arrêt ;
- durée à bord estimée à partir de la géométrie du tracé, d'une vitesse commerciale paramétrée et des arrêts intermédiaires ;
- durée totale d'itinéraire et correspondances ;
- attente sous forme de moyenne ou de fourchette uniquement si une hypothèse de fréquence documentée dans la configuration permet de la calculer.

Les hypothèses de vitesse, d'arrêt et d'attente doivent être centralisées dans la configuration du moteur, nommées comme hypothèses et testées. Ne pas inscrire des fréquences DDD/AFTU arbitraires dans le code en les présentant comme des faits. Si l'attente ne peut pas être estimée raisonnablement, conserver l'itinéraire et sa durée de marche/parcours, et indiquer en interne que l'attente n'est pas chiffrable ; ne pas bloquer tout le trajet.

### Niveau D — Observations de passage

Une observation doit comprendre : ligne, sens, arrêt, horodatage, mode de collecte et statut de validation. L'heure du téléphone peut servir d'horodatage, mais ne constitue pas à elle seule une preuve de l'arrivée du véhicule.

- Ne collecter une observation qu'après une action explicite de l'utilisateur.
- Ne pas suivre en permanence la position GPS d'un usager.
- Rejeter ou mettre en quarantaine les observations incohérentes (arrêt hors ligne, heure future, doublons, intervalle impossible).
- Agréger les intervalles par ligne, sens, arrêt ou tronçon et période de service ; séparer jours ouvrés, week-ends et périodes de pointe si le volume le permet.
- Ne promouvoir une statistique d'observation que lorsque le volume et la dispersion des observations atteignent des seuils configurés ; sinon elle reste exploratoire.
- Conserver la date du dernier échantillon et faire expirer ou dégrader les statistiques devenues obsolètes.

Les observations communautaires ne deviennent jamais des horaires officiels. Elles alimentent une estimation empirique avec un niveau de confiance.

## 5. Point de départ temporel et calcul du prochain passage

Ordre de préférence pour ancrer un passage :

1. départ officiel publié, applicable à la date et au sens ;
2. grille de fréquence dont la phase est connue ;
3. estimation empirique fondée sur des passages observés suffisamment nombreux et récents ;
4. à défaut, ne pas fabriquer une heure exacte. Présenter une attente moyenne/fourchette si elle est justifiable, ou calculer l'itinéraire sans prétendre connaître le prochain passage.

Pour une ancre (t_0) et un intervalle (h), les créneaux théoriques peuvent être projetés par (t_n = t_0 + n h), dans la fenêtre de service valide. À un arrêt intermédiaire, ajouter la durée cumulée estimée depuis le terminus. La projection est une estimation et doit être recalculée pour le sens inverse à partir de sa propre ancre lorsqu'elle est connue ; ne pas supposer que les deux sens partagent la même phase.

Le compte à rebours doit suivre les règles déjà appliquées dans `headways.ts` : pas de « 0 min » pour un créneau passé, respect des jours et de la fermeture du service, et aucun affichage de véhicule en temps réel.

## 6. Intégration progressive des lignes DDD/AFTU

### Étape 1 — Inventaire sans impact sur l'application

Créer un inventaire de travail séparé des données de production. Pour chaque ligne candidate, enregistrer la source, le nom officiel, les terminus, le sens, les arrêts connus, les coordonnées sourcées et les données temporelles disponibles. Marquer chaque champ comme publié, observé, estimé ou inconnu.

### Étape 2 — Lignes documentées

N'intégrer au graphe que les lignes dont le tracé et l'ordre des arrêts sont suffisamment documentés. Une ligne peut être utile au calcul d'itinéraire même si ses horaires sont inconnus. Le planificateur doit pouvoir utiliser ses temps de parcours estimés sans bloquer TER/BRT.

### Étape 3 — Estimation temporelle

Attacher aux lignes les départs/frequences effectivement sourcés. À défaut, appliquer uniquement des hypothèses configurées et identifiées comme estimations ; si la donnée ne permet pas de calculer l'attente, ne pas la remplacer par une fausse précision.

### Étape 4 — Observations et calibration

Ajouter ultérieurement un flux de signalements volontaires. Comparer les observations à l'estimation, calculer les écarts et ajuster les paramètres uniquement à partir d'échantillons suffisamment robustes. Garder un historique des changements de paramètres pour pouvoir les annuler.

## 7. Modèle de données recommandé (additif)

Ne pas imposer une refonte des types existants. Ajouter, si nécessaire, un type dédié aux lignes candidates avec :

- `networkId`, `lineId`, `directionId` ;
- `stops[]` dans l'ordre du parcours ;
- `temporalModel`: `PUBLISHED_DEPARTURES`, `PUBLISHED_HEADWAY`, `OBSERVED_HEADWAY`, `MODEL_ONLY`, `UNKNOWN` ;
- `source`: organisme, URL, date de consultation, validité ;
- `assumptions`: vitesse, temps d'arrêt et paramètres d'attente configurés ;
- `confidence` ou classe de confiance, calculée à partir de la qualité et de la fraîcheur des données, jamais inventée manuellement ;
- `lastObservedAt` et nombre d'observations valides si des observations existent.

Les statuts de connexion du registre `network.ts` ne doivent pas effacer les données locales de référence : « flux non connecté » et « itinéraire de référence disponible » sont deux faits distincts.

## 8. Tests d'acceptation obligatoires

1. Tous les tests existants TER/BRT passent sans modification de leurs résultats attendus.
2. Les itinéraires DDD/AFTU avec tracé documenté peuvent être calculés sans horaires publiés.
3. Une ligne sans ancre temporelle ne produit pas un compte à rebours exact inventé.
4. Un départ officiel de terminus est projeté sur les arrêts avec une durée estimée clairement distincte de l'heure publiée.
5. Le sens aller et le sens retour ont des calculs indépendants.
6. Les horaires ne sont jamais proposés hors jours ou fenêtres de service connus.
7. Une ligne partiellement documentée ne fait pas disparaître les options TER/BRT existantes.
8. Des données inconnues, invalides, périmées ou contradictoires ne provoquent ni crash ni blocage de l'application.
9. Les observations hors ligne, futures, dupliquées ou aberrantes ne modifient pas les statistiques.
10. Le texte de l'interface reste bref ; aucune refonte graphique n'est incluse dans ce chantier.

## 9. Ordre d'exécution recommandé

1. Auditer l'état courant de la branche et les modifications Arena AI avant toute écriture.
2. Tester et documenter le comportement actuel des fonctions de fréquence, de tableau de station et de planification.
3. Faire l'inventaire des données DDD/AFTU déjà présentes dans le dépôt et des sources officielles accessibles.
4. Proposer un changement isolé, rétrocompatible et accompagné de tests ; ne pas modifier les données TER/BRT ou les composants UI.
5. Exécuter `npm test`, `npm run test:data`, `npm run build` et vérifier le résultat du CI.
6. Ouvrir une pull request pour revue ; ne pas fusionner ni déclarer le déploiement terminé avant vérification.

## 10. Critère de réussite

Dakar Bus reste actif : l'usager peut explorer le réseau et calculer les portions d'itinéraire qui reposent sur des données disponibles. Le système utilise la meilleure estimation calculable, distingue l'information publiée de l'estimation et de l'observation, et ne présente jamais une précision qu'il ne possède pas.

**Principe directeur : préserver le travail d'Arena AI et améliorer par ajouts ciblés, testés et réversibles.**
