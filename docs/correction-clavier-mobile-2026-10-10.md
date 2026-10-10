# Correction — étirement de la page à l'ouverture du clavier mobile

Date : 10 octobre 2026
Périmètre : écran « Explorer », champ de recherche « On va où ? », carte
Leaflet, hauteur globale de l'application.

## 1. Le problème

Au toucher du champ « On va où ? », l'ouverture du clavier virtuel provoquait
un reflow violent : la page se décalait vers le haut, le haut de l'écran était
coupé (barre de statut, logo rognés) et l'ensemble donnait une impression de
zoom instable.

## 2. Origines techniques vérifiées dans le code

Quatre causes se cumulaient ; chacune a été lue dans la base de code avant
correction.

| # | Cause | Emplacement avant correction |
|---|---|---|
| 1 | La coquille suivait la fenêtre dynamique : `height: 100vh; height: 100dvh`. Quand le clavier réduit la fenêtre de mise en page (`interactive-widget=resizes-content`, comportement historique de Chrome Android), toute la coquille se redessinait à la baisse. Le `min-height: 600px` qui l'accompagnait faisait ensuite déborder une coquille devenue plus courte que la fenêtre utile : l'en-tête passait hors écran. | `src/App.css`, règle `.app-shell` |
| 2 | La ligne de la carte était exprimée en unité de fenêtre : `grid-template-rows: minmax(0, 33.333dvh) minmax(0, 1fr)`. La carte suivait donc le clavier et changeait de taille sous le doigt. | `src/App.css`, règles `.app-shell.tab-explore` (bureau et ≤ 820 px) |
| 3 | Leaflet écoutait `resize` par défaut (`trackResize: true`) : chaque redimensionnement dû au clavier déclenchait un `invalidateSize()`, donc un recalcul complet des tuiles au moment même du focus. | `src/components/TransitMap.tsx`, `MapContainer` |
| 4 | Le champ faisait moins de 16 px (`12 px` dans la barre latérale, `14,5 px` puis `14 px` dans Explorer) : iOS Safari et Chrome Android zooment la page entière dès qu'un champ plus petit reçoit le focus. | `src/App.css`, règles `.search-form input` et `.explore-search-form input` |

## 3. Ce qui a été fait

### 3.1 Hauteur verrouillée en pixels

Module de décision : `src/domain/viewportLock.ts` (pur, sans DOM).
Accroche React : `src/components/useViewportLock.ts`.

Le hook mesure la fenêtre de mise en page (`window.innerHeight`) et la fenêtre
visuelle (`window.visualViewport.height`), et rend une hauteur **en pixels**
posée sur la coquille en `--app-height`. Règle appliquée :

- tant qu'aucun clavier n'est ouvert, la hauteur suit la fenêtre réelle
  (rotation, redimensionnement du bureau) ;
- dès qu'un clavier est reconnu ouvert, la **dernière hauteur connue clavier
  fermé** est conservée telle quelle jusqu'à la fermeture du clavier.

Un clavier est reconnu ouvert uniquement pendant la saisie d'un champ qui
appelle réellement le clavier (`summonsKeyboard` : `input` texte, `textarea`,
contenu éditable — ni case à cocher, ni liste déroulante), et sur une perte de
hauteur d'au moins `KEYBOARD_MIN_LOSS_PX = 120 px`. Les deux signatures
navigateur sont couvertes : fenêtre visuelle seule réduite (iOS Safari, Chrome
par défaut) ou fenêtre de mise en page réduite (`resizes-content`). Le repli de
la barre d'adresse mobile, plus court que le seuil, ne déclenche rien.

Feuille de style :

```css
.app-shell {
  height: 100vh;                      /* navigateurs sans unité svh */
  height: 100svh;                     /* petite fenêtre stable, insensible au clavier */
  height: var(--app-height, 100svh);  /* hauteur verrouillée en pixels */
  min-height: 0;                      /* plus de débordement qui rogne l'en-tête */
  overflow: hidden;
}
body { position: fixed; inset: 0; overflow: hidden; overscroll-behavior: none; }
#root { overflow: hidden; }
```

`position: fixed` sur le corps supprime le défilement élastique d'iOS qui
décalait toute la page vers le haut au focus ; `overscroll-behavior: none`
coupe l'enchaînement de défilement. Le corps de page ne peut plus grandir.

Pendant l'ouverture du clavier, la coquille porte la classe
`is-keyboard-open` et toutes ses transitions sont coupées : rien ne bouge sous
le doigt. Le champ, lui, reste lisible : `fieldScrollShift` calcule le décalage
minimal à appliquer au **conteneur défilant du champ** (`.panel-content`),
jamais au document — l'en-tête et la carte ne bougent pas.

### 3.2 Carte à hauteur contrainte, sans resize au focus

- La ligne de la carte est désormais un pourcentage de la coquille :
  `grid-template-rows: minmax(0, 33.333%) minmax(0, 1fr)`. La coquille ayant
  une hauteur en pixels verrouillée, la carte a une hauteur contrainte qui ne
  dépend plus de la fenêtre.
- `MapContainer` naît avec `trackResize={false}` : Leaflet n'écoute plus
  `resize`.
- `MapResizeController` (`src/components/TransitMap.tsx`) décide du recalcul :
  il observe le conteneur (`ResizeObserver`), `resize` et `orientationchange`,
  et appelle `map.invalidateSize()` seulement si `shouldResizeMap` l'autorise —
  jamais pendant l'ouverture du clavier, jamais pour un écart inférieur à
  `MAP_RESIZE_MIN_DELTA_PX = 4 px` (arrondi de mise en page). À la fermeture du
  clavier, la taille étant revenue à l'identique, aucun recalcul n'est
  nécessaire.

### 3.3 Champs de saisie à 16 px

Tous les champs qui appellent le clavier mobile sont passés à 16 px, seuil en
dessous duquel iOS Safari et Chrome Android zooment la page au focus :
`.search-form input`, `.explore-search-form input`, `.point-search-input`,
`.assistant-form input`, `.street-field input/textarea`, `.console-form
input/textarea`, `.console-login input`. Le test
`champs de saisie à 16 px au minimum` parcourt toute la feuille de style et
interdit toute taille inférieure sur ces sélecteurs, media queries comprises.

Le zoom volontaire de l'usager n'est pas supprimé (pas de
`user-scalable=no`) : seul le zoom automatique disparaît. Un
`touch-action: manipulation` sur `.search-form` écarte en plus le zoom par
double tap sur le champ, sans toucher au pincement.

### 3.4 Fenêtre : le clavier ne redimensionne que le visuel

`index.html` déclare explicitement
`interactive-widget=resizes-visual` : l'ouverture du clavier ne redimensionne
que la fenêtre visuelle, la fenêtre de mise en page ne change pas, donc rien ne
se réorganise. Les navigateurs qui ignorent la clé (Safari, Firefox)
s'appuient sur la hauteur verrouillée du point 3.1.

Le raccourci `Ctrl/Cmd + K` concentre le champ avec
`focus({ preventScroll: true })` : le focus programmé ne décale plus la mise en
page.

## 4. Comportement attendu

| Geste | Avant | Après |
|---|---|---|
| Toucher « On va où ? » | La page se décale vers le haut, l'en-tête est rogné, la carte se recalcule, zoom possible | La mise en page ne bouge pas ; le clavier recouvre le bas de l'écran ; l'en-tête, le logo et la carte restent en place |
| Saisir une recherche | Reflow à chaque apparition/disparition du clavier | Aucune variation de hauteur pendant la saisie |
| Refermer le clavier | Nouvelle secousse | La hauteur reprend la valeur réelle de la fenêtre, sans secousse |
| Tourner l'appareil | Carte recalculée | Carte recalculée (comportement conservé, clavier fermé) |
| Zoomer au pincement | Disponible | Toujours disponible |

## 5. Vérifications

| Contrôle | Résultat |
|---|---|
| `npx vitest run` | 445 tests verts (33 de plus qu'avant) |
| `npm run build` (`tsc -b` + vite + smoke bundle + exécution du bundle dans jsdom) | OK, montage des quatre onglets vérifié |
| `python3 -m unittest discover -s tests` | 133 tests, inchangé |

Nouveaux fichiers de tests :

- `src/domain/viewportLock.test.ts` — détection du clavier, hauteur rendue,
  champs qui appellent le clavier, autorisation de recalcul de la carte,
  décalage du champ ; plus les non-régressions sur la feuille de style
  (hauteur verrouillée, corps fixe, ligne de carte en pourcentage, 16 px,
  `trackResize={false}`, `interactive-widget=resizes-visual`).
- `src/components/useViewportLock.test.tsx` — comportement du hook : hauteur
  figée quand le clavier réduit la fenêtre visuelle ou la fenêtre de mise en
  page, reprise à la fermeture, suivi d'un vrai redimensionnement hors saisie,
  absence de verrou sur une case à cocher ou sur le repli de la barre
  d'adresse.
- `src/App.test.tsx` — la coquille porte `--app-height` en pixels et la classe
  `is-keyboard-open` pendant l'ouverture simulée du clavier, hauteur inchangée.

Reste à constater sur appareil réel (iOS Safari, Chrome Android) : l'environnement
de test ne dispose pas de clavier virtuel. La logique, la feuille de style et le
câblage sont couverts par les tests ci-dessus.
