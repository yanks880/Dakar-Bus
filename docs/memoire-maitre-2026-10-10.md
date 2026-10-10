# Mémoire du maître de Dakar Bus — compréhension du langage naturel

Date : 10 octobre 2026
Périmètre : suppression des réponses robotiques de l'assistant, compréhension
des phrases libres, et activation de la mémoire des lieux de Dakar (TER, BRT,
DDD, AFTU) pour proposer un itinéraire concret sans rien redemander.

## 1. Ce qui a été supprimé

| Ancien comportement | Nouveau comportement |
|---|---|
| « Quel est votre point de départ ? Indiquez « trajet de [gare ou station] à [destination] » » — réponse figée dès qu'un lieu manquait | La fiche du lieu connu est servie d'abord (identité, mode le plus adapté, desserte, correspondances, itinéraire réellement calculé depuis le pôle central), puis une question courte et naturelle |
| « Destination non reconnue sur le réseau de référence TER/BRT. » | Idem, côté destination : l'essentiel est donné, le manque est nommé |
| Seules les formules « trajet de X à Y » étaient comprises | Toute phrase libre est analysée : mots de liaison, ordre des propositions, verbes de déplacement |
| Un lieu cité par une fiche DDD/AFTU était ignoré | Le lieu est reconnu, ses fiches sont citées, et l'impossibilité de calculer est dite |

Aucune phrase de la base de code ne contient plus « Quel est votre point de
départ ? » : des tests de non-régression l'interdisent explicitement
(`src/domain/assistant.test.ts`, `src/domain/placeMemory.test.ts`,
`src/App.test.tsx`).

## 2. Compréhension du langage naturel

Module : `src/domain/places.ts`.

1. **Reconnaissance des lieux** — la phrase est normalisée (minuscules, sans
   accents ni ponctuation) puis parcourue mot à mot. Les libellés les plus
   longs gagnent et ne se recouvrent jamais : « gare de Dakar » est reconnu
   comme la gare TER, pas comme le mot « Dakar » perdu dans une fiche bus.
2. **Rôles par les mots de liaison** — le texte situé juste avant chaque lieu
   décide de son rôle :
   - départ : `depuis`, `de`, `je suis à`, `je me trouve à`, `j'habite à`,
     `je pars de`, `au départ de`, `entre`… ;
   - destination : `à`, `au`, `vers`, `jusqu'à`, `pour`, `rejoindre`,
     `aller à`, `destination`… ;
   - à défaut d'indice, deux lieux cités sont pris dans l'ordre des mots.
3. **Demande de déplacement** — au-delà de « trajet » : `aller`, `arriver`,
   `rejoindre`, `partir`, `je vais`, `comment faire pour`, « quel bus pour »…
4. **Jamais de position déduite** — le rôle vient toujours de la formulation
   de l'usager, jamais d'une géolocalisation supposée.

Exemples résolus (tests dans `src/domain/places.test.ts`) :

- « Comment faire pour aller à Dakar ? Je suis à Keur Mbaye Fall »
  → départ Keur Mbaye Fall, destination Dakar, itinéraire TER immédiat.
- « je suis à Parcelles Assainies et je voudrais rejoindre Diamniadio »
  → BRT puis TER avec correspondance.
- « je vais à Dakar depuis Rufisque » → Rufisque → Dakar.
- « Keur Mbaye Fall Dakar » → deux lieux sans indice : ordre des mots.

## 3. Mémoire des lieux

Modules : `src/domain/places.ts` (données et analyse),
`src/domain/placeMemory.ts` (réponses).

Trois sources, aucune invention :

1. les 13 gares TER et les 23 stations BRT du réseau de référence — seules à
   porter des coordonnées, donc seules utilisables comme extrémités d'un
   itinéraire calculé ;
2. les terminus et points de passage textuels des 109 fiches DDD/AFTU
   (`src/data/mobility-lines.json`) — repères documentaires, jamais des arrêts
   géolocalisés. Les noms de rues en sont exclus (« Rue 34 », « Avenue Blaise
   Diagne ») ;
3. les correspondances TER ↔ BRT déclarées (`CORRIDOR_TRANSFERS`).

Pour chaque lieu, la fiche servie contient, dans cet ordre :

1. l'identité du lieu et son opérateur ;
2. le mode le plus adapté ;
3. la desserte déclarée et la fenêtre de service publiée ;
4. un **itinéraire réellement calculé** depuis le pôle central du réseau
   (gare TER de Dakar pour le rail, Petersen pour le BRT), présenté comme un
   repère — jamais comme le trajet « depuis chez vous » ;
5. les correspondances : déclarées si elles existent, sinon l'arrêt de l'autre
   réseau le plus proche, avec la distance à vol d'oiseau et la mention
   explicite du rayon de marche du calculateur (1 200 m) ;
6. les fiches DDD/AFTU citant le lieu, avec leurs réserves ;
7. la limite honnête (ni horaire de passage, ni temps réel, ni fréquence bus).

Deux lieux cités dont au moins un n'est pas calculable (fiches bus) ne
produisent ni durée ni correspondance inventées : la réponse donne ce qui est
documenté, le sens publié restant à confirmer auprès de l'opérateur.

## 4. Mémoire de conversation

Module : `src/domain/conversation.ts`, branche « 3b » de
`src/domain/copilot.ts`.

Un lieu énoncé explicitement (« je suis à Keur Mbaye Fall », « je dois aller à
Diamniado ») est mémorisé comme lieu en attente. La phrase suivante qui énonce
le complément est complétée au lieu d'être redemandée, et le lieu repris est
toujours nommé dans la réponse :

- « Départ repris de ce que vous m'avez dit : Keur Mbaye Fall. »
- « Destination reprise de ce que vous m'avez dit : Diamniadio. »

La mémoire est effacée dès qu'un trajet complet est calculé. Aucun lieu n'est
mémorisé à partir d'une formulation ambiguë : seules les phrases portant un
mot de liaison explicite alimentent la mémoire.

## 5. Interface

Le bouton reste compact, dans la barre d'actions de l'en-tête, et affiche
« IA » à toutes les largeurs (son nom accessible reste « Assistant IA »).

La fenêtre de discussion ne contient que l'historique des questions et des
réponses : en-tête réduit au titre et au choix de langue, bulles largement
espacées (interligne 1,7), bouton d'écoute discret, sources repliées dans un
volet « Sources et date de consultation ». Aucun élément décoratif n'a été
ajouté ; les fonctionnalités existantes (voix, sources, ouverture dans Trajet)
sont conservées.

## 6. Vérifications

| Contrôle | Résultat |
|---|---|
| `npx vitest run` | 399 tests verts (30 de plus qu'avant : `places.test.ts`, `placeMemory.test.ts`, cas ajoutés) |
| `npm run build` (tsc + vite + smoke bundle + exécution du bundle) | OK |
| `python3 -m unittest discover -s tests` | inchangé |

Fichiers de tests : `src/domain/places.test.ts`,
`src/domain/placeMemory.test.ts`, `src/domain/assistant.test.ts`,
`src/domain/intent.test.ts`, `src/domain/copilot.test.ts`,
`src/App.test.tsx`.
