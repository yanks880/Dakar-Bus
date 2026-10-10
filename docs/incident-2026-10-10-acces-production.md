# Incident du 10 octobre 2026 — page blanche sur l’application en production

Statut : corrigé sur la branche de travail, en attente de fusion et de
déploiement. Ce rapport documente la cause observée, le diagnostic, le
correctif et les limites de vérification, sans rien présumer.

## 1. Symptôme

L’usager qui ouvre `https://yanks880.github.io/Dakar-Bus/` n’obtient aucune
interface : page blanche, aucune erreur visible. Aucune authentification
n’est en cause : l’application publique n’a pas de connexion ; c’est son
affichage initial qui échouait.

## 2. Ce que la mesure a d’abord faussement suggéré

Les premières sondes via l’outil de lecture intégré de l’agent ont rapporté
« HTTP 500 » sur `/Dakar-Bus/`, `/Dakar-Bus/index.html` et
`/Dakar-Bus/icons/icon.svg`, alors que les mêmes outils lisaient correctement
`sw.js`, `manifest.webmanifest`, le CSS et les JS — tous issus du déploiement
du jour. Une enquête complémentaire a établi que ces « 500 » étaient un
artefact de l’outil de mesure, pas du serveur :

- un lecteur indépendant (r.jina.ai) a rendu la page d’accueil avec son titre
  exact (`Dakar Bus — La mobilité de Dakar, en clair`) et l’icône ;
- GitHub signalait le déploiement de `main` @ `a4fd20b0` comme réussi, sans
  incident déclaré sur githubstatus ;
- un cas documenté publiquement (dépôt `abnormalboy/littlejourney`, incident
  n° 2) décrit la même illusion : l’outil WebFetch rapportait 500 sur un
  fichier servi 200.

Leçon retenue : ne jamais conclure à une panne serveur sur la foi d’un seul
outil de lecture ; croiser au moins deux points de mesure indépendants.

## 3. Cause réelle (reproduite localement)

Le déploiement du 10 octobre (fusion de la PR n° 16) introduisait le
découpage du bundle en plusieurs chunks. La configuration de découpage
(`vite.config.ts`) faisait correspondre le groupe `leaflet` à
`node_modules/(leaflet|react-leaflet)/` — mais **pas** à
`node_modules/@react-leaflet/core/`, qui est un paquet distinct. Ce paquet
est donc tombé dans le chunk d’entrée, produisant un **cycle entre chunks** :

```text
index-*.js  (entrée)  → importe  leaflet-*.js
leaflet-*.js           → importe index-*.js   (@react-leaflet/core)
```

Au chargement, le chunk leaflet s’initialise le premier et appelle du code du
chunk d’entrée dont les dépendances React ne sont pas encore initialisées :

```text
TypeError: Cannot read properties of undefined (reading 'forwardRef')
    index-*.js (création d’icônes lucide) ← leaflet-*.js (composants react-leaflet)
```

Conséquence : l’import du bundle échoue, React ne monte jamais, `<div id="root">`
reste vide — page blanche, **pour tous les navigateurs**, alors que serveur,
HTML et assets répondent normalement.

## 4. Pourquoi aucun test ne l’avait vu

- La suite vitest (258 tests) exécute **la source**, pas les chunks, et
  remplace `TransitMap` par un double (`vi.mock`) : le code carte réel du
  bundle n’était exécuté nulle part.
- `smoke_bundle.mjs` vérifie des propriétés statiques (tailles, CSP, CSS,
  service worker), pas l’exécution.
- Le crash était un défaut de **chargement de production** : invisible des
  deux filets existants.

## 5. Correctif

| Fichier | Modification | Raison |
|---|---|---|
| `vite.config.ts` | Le groupe `leaflet` couvre désormais `(leaflet\|react-leaflet\|@react-leaflet)` | Supprime le cycle : `@react-leaflet/core` vit dans le chunk leaflet, qui n’importe plus que `react` et le runtime |
| `scripts/smoke_bundle.mjs` | Nouveau contrôle « aucun chunk n’importe le chunk d’entrée » | Garde-fou statique contre toute réapparition du cycle |
| `scripts/smoke_bundle_runtime.mjs` (nouveau) | Exécute le bundle construit dans jsdom et vérifie le montage des quatre piliers, sans frontière d’erreur | Filet d’exécution : tout crash au chargement du bundle réel échoue désormais le build |
| `package.json` | `build` enchaîne le contrôle runtime après le smoke statique | Le filet fait partie du build et de la CI |
| `src/App.tsx` | Entrée du journal des versions (format existant) | Traçabilité dans l’application, selon la convention du dépôt |

Le graphe de chunks obtenu est un DAG sans cycle :
`entrée → leaflet → react → runtime`.

## 6. Vérifications effectuées

1. **Reproduction du défaut avant correctif** : le bundle déployé
   (`index-B952f3iU.js`) importé dans Node+jsdom plante exactement comme dans
   un navigateur (`forwardRef` sur undefined, déclenché depuis le chunk
   leaflet) — cause confirmée, pas déduite.
2. **Après correctif** : le nouveau bundle s’importe sans erreur et monte
   l’application complète dans jsdom — quatre onglets, recherche « On va où ? »,
   carte Leaflet (canvas simulé), décomptes TER/BRT vivants, réseaux sans
   donnée marqués « Non déclaré », aucune frontière d’erreur déclenchée.
3. `npm run build` (tsc + vite + smoke statique + smoke runtime) : conforme.
4. Suite complète : à relire en CI (voir PR).

## 7. Limites de vérification (déclarées, pas dissimulées)

- **Aucun navigateur réel n’est disponible dans l’environnement de travail**
  (pas de Chromium/Firefox installable : réseau de téléchargement hors liste
  autorisée). La preuve d’exécution repose sur jsdom + le bundle réel, qui a
  reproduit fidèlement le crash comme l’affichage — mais un test Playwright
  contre l’URL publique reste souhaitable (déjà recommandé par
  `docs/audit-2026-10-09.md` § 6.3).
- La vérification de l’URL de production **après fusion** reste à faire : le
  déploiement GitHub Pages ne s’exécute que sur `main`. Tant que la PR n’est
  pas fusionnée, la production continue d’afficher la version cassée.
- Le téléchargement de l’artifact Pages pour inspection directe est bloqué
  par la politique de réseau de l’environnement (hôte Azure hors liste) ;
  l’exactitude du contenu servi a été établie par d’autres moyens (assets du
  jour lus en 200, lecture indépendante de l’accueil).

## 8. Actions restantes pour l’usager

1. Valider et fusionner la pull request (aucune fusion automatique n’est
   effectuée).
2. Laisser le workflow « Deploy Dakar Bus to GitHub Pages » s’exécuter
   (~1 minute) et vérifier `https://yanks880.github.io/Dakar-Bus/`.
3. Si une page blanche persistait sur un appareil qui a visité la version
   cassée : recharger la page ; en dernier recours, vider les données du site
   (le service worker n’est pas en cause : la navigation est réseau-d’abord,
   et le correctif change les noms de chunks hachés).
