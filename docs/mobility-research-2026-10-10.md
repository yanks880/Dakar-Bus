# Mémoire mobilité et correctifs UI — consultation du 10 octobre 2026

## Résultat intégré

- Mémoire documentaire locale, incluse dans le bundle : **109 fiches bus** (72 AFTU, 37 DDD), dont **20 parcours textuels détaillés** (5 AFTU, 15 DDD).
- Recherche par réseau/numéro, désambiguïsation des numéros communs, consultation des points de passage, recherche de pistes directes dans le sens transcrit, suivi de la dernière fiche dans la conversation.
- Informations pratiques BRT et TER : tarifs de référence, validation, supports, zones BRT, contacts, gratuités enfants, abonnements adultes TER et horaires publiés avec distinction des terminus.
- Une URL et une date de consultation accompagnent les réponses documentaires. Les références sont repliées dans le chat et ne sont pas lues comme de longues URL par la synthèse vocale.
- La date de consultation n'est **pas** une date d'entrée en vigueur. Les fiches sans date de publication le disent explicitement.
- Aucune requête externe ni aucun import GTFS requis pour ces réponses.

**Ce n'est pas une couverture exhaustive de tous les arrêts.** Les 89 autres fiches contiennent les terminus et leur source, pas une liste inventée d'arrêts intermédiaires. Le catalogue textuel est volontairement séparé du graphe de trajets et des courses publiées. Il ne géocode pas un nom, ne déduit pas le sens retour et ne fabrique pas de correspondance ni de durée.

## Sources effectivement consultées

### CETUD

1. https://cetud.sn/reseaux-de-transport/ddd/
   - 38 lignes, 400 autobus, amplitude générale 06h–21h ; contact 33 824 10 10 / info@demdikk.sn.
   - Lien vers l'opérateur Dem Dikk et vers le plan https://cetud.sn/wp-content/uploads/2024/11/plan-lignes-ddd.jpeg.
   - L'amplitude du réseau n'est pas appliquée à chaque ligne. Le chiffre « 15 millions de passagers/jour », incohérent, n'a pas été importé.
2. https://cetud.sn/reseaux-de-transport/aftu/
   - 72 lignes, 2 300 bus, 14 GIE, amplitude générale 06h–21h.
   - Lien vers https://aftu-senegal.org/ et le plan https://cetud.sn/wp-content/uploads/2024/11/plan-lignes-aftu.jpeg.
   - Les plans JPEG n'ont pas été transcrits automatiquement : les fiches textuelles opérateur ont été privilégiées.
3. https://cetud.sn/transports-urbains-a-dakar-300-nouveaux-minibus-et-3-nouvelles-lignes-pour-renforcer-le-reseau-de-l-aftu/
   - Article du **23 mai 2016**, avec les lignes 53, 81, 82. Archive historique, pas preuve du service actuel. La 53 y part de Lac Rose, contrairement à la fiche AFTU de juillet 2026 retenue.
4. https://cetud.sn/wp-content/uploads/2025/09/Bulletin_Mobilite_N4_16_pages.pdf
   - Bulletin **février 2018**, notamment page 12 : navettes et lignes DDD. Le chemin d'hébergement « 2025/09 » n'est pas la date de la donnée ! Les fiches actuelles Dem Dikk priment pour ce catalogue.
5. https://cetud.sn/observatoire/indicateurs-de-trafic/
   - Statistiques datant de 2020 à 2024. **Aucun état de circulation en direct** ne doit être déduit de ces moyennes.
6. https://cetud.sn/wp-content/uploads/2024/11/Plan-de-la-ligne-TER.pdf
   - Plan explicitement légendé phase 1 ; ne permet pas de confirmer l'exploitation de l'extension AIBD.

### DDD — opérateur référencé par le CETUD

https://demdikk.sn/reseau-urbain-dakar/

- 37 fiches avec numéro/code ont été transcrites. Les services sans numéro stable ne sont pas inclus. Le doublon de la ligne 18 a été dédupliqué.
- Points de passage détaillés transcrits pour 1, 4, 7, 11, 13, 15, 213, 219, 220, 221, 234, 311, 327, 501, 319.
- Les points sont conservés comme **repères textuels**, pas comme arrêts autorisés ou géolocalisés.
- **Conflits signalés et exclus des suggestions directes** : 23 (titre Palais 1 / détail Palais 2), 217 (titre Ouakam / détail Aéroport LSS), 233 (titre Palais 1 / détail apparemment recopié de 232 vers Aéroport LSS).
- Les lignes 502/503 ont un titre « Gare de Gare » ; le corps indique une boucle depuis la gare de Colobane, signalée dans la note.
- Des liens publicitaires/spam sans rapport avec le transport apparaissent en fin de page : ils sont totalement exclus de la mémoire. Ne jamais importer aveuglément le HTML d'un site opérateur.

Pages complémentaires consultées : https://demdikk.sn/ et https://demdikk.sn/offres-de-transport/. Les offres commerciales et horaires de navettes aéroport n'ont pas été généralisés au réseau urbain.

### AFTU — opérateur référencé par le CETUD

https://aftu-senegal.org/infos-pratiques/

- 72 entrées textuelles : 1–5, 24–89, 91. Aucun numéro manquant n'est inventé.
- Fiches détaillées lues et transcrites :
  - https://aftu-senegal.org/map/dakar-urbain-ligne-1/ — 18 mai 2026.
  - https://aftu-senegal.org/map/dakar-urbain-ligne-42/ — 30 juin 2026.
  - https://aftu-senegal.org/map/dakar-urbain-ligne-53/ — 6 juillet 2026.
  - https://aftu-senegal.org/map/dakar-urbain-ligne-81/ — 14 juillet 2026.
  - https://aftu-senegal.org/map/dakar-urbain-ligne-82/ — 14 juillet 2026.
- Ligne 1 : terminus résumé « HLM Grand Yoff » dans la liste, « Espace HLM Grand Médine » dans le détail : divergence signalée.
- Ligne 81 : résumé « Tivaouane Peul », fiche détaillée « Tawfeex » : précision signalée.
- « TATA » est accepté comme formulation usager, avec clarification « si vous désignez la ligne AFTU ». Ce n'est pas une affirmation que tous les véhicules TATA appartiennent à AFTU.
- La page d'accueil contient des exemples de voyages européens et des valeurs de réservation manifestement issues d'un modèle de site : **exclus**, de même que les mesures cartographiques « 0 km » non exploitables.

### SENTER et TER Dakar

- https://sentersa.sn/ : présentation institutionnelle, 14 gares et haltes annoncées, données de projet ; pas une preuve d'ouverture d'une nouvelle desserte.
- https://sentersa.sn/gares-et-haltes/ : gares historiques Dakar et Rufisque ; haltes Colobane, Hann, Dalifort, Baux Maraîchers, Pikine, Thiaroye, Yeumbeul, KMF, PNR, Bargny.
- https://sentersa.sn/service-en-gare/ : **13 gares/haltes Dakar–Diamniadio**, 83 espaces commerciaux, 58 kiosques. Différence de périmètre avec la page d'accueil conservée et expliquée.
- https://www.terdakar.sn/les_horaires_des_trains/ : premiers départs 05h35 Diamniadio et 05h45 Dakar ; fréquence 10 min jusqu'à 20h55 du lundi au samedi, puis 20 min de 21h05 à 22h05. Dimanches/jours fériés, 20 min de 06h25 à 22h05.
- https://www.terdakar.sn/ticket-voyage-aller-simple-de-quoi-s-agit-il/ : ticket 2e classe 500 / 1 000 / 1 500 F CFA ; 1re classe 2 500 F CFA ; papier QR, validité 5 jours pour **un** voyage ; guichets/distributeurs, espèces/mobile money.
- https://www.terdakar.sn/quel-titre-choisir/ : abonnements adultes mensuels/hebdomadaires transcrits, 1/2/3 zones ; conditions nominatives/calendaires. Les tableaux enfants/jeunes n'ont pas été intégralement transcrits.
- https://www.terdakar.sn/les-offres-ter-de-dakar/ : gratuité des moins de 5 ans.

Les nouvelles heures sont des **réponses documentaires**, pas une migration silencieuse du modèle temporel existant. Les anciennes hypothèses du calculateur (`frequencies.ts`) ne sont pas promues au statut « vérifiées aujourd'hui ». Le recalage directionnel de ce modèle et son calendrier de service demandent un travail séparé. Une fréquence ne déclenche aucun compte à rebours de prochain véhicule.

### SunuBRT

- https://sunubrt.sn/ et les pages guide/B1/B3 répondaient **« Site en maintenance »** à la consultation.
- La page de maintenance donne le service client : 818 55 55 55 (50 F l'appel), WhatsApp 76 215 15 15, serviceclient@sunubrt.sn, 7j/7 06h–23h. Ce ne sont **pas les horaires d'exploitation**.
- Guide SunuBRT accessible chez le CETUD : https://cetud.sn/wp-content/uploads/2024/11/sunubrt-guide-du-voyageur-vf.pdf (date d'édition non précisée).
  - Tarifs de référence 400 F CFA dans une zone, 500 F CFA pour franchissement de limites.
  - Zones : Papa Gueye Fall–Liberté 6 ; Khar Yalla–Croisement 22 ; Parcelles–Préfecture de Guédiawaye.
  - Validation entrée/sortie ; supports et points de vente ; agences Guédiawaye/Grand Médine/Petersen ; gratuité des enfants accompagnés de moins de 4 ans ; accessibilité PMR annoncée.
- Les extraits de recherche B1/B2/B3 sont utiles pour retrouver les pages, mais **non utilisés pour certifier un service actuel** lorsque la page directe n'est pas consultable. En particulier, divergence 21/23 stations et fréquences dominicales : pas de réécriture silencieuse du graphe à partir d'un extrait.
- Les anciennes promotions (été 2025, Tabaski mai 2026) sont exclues des tarifs par défaut.

## Ce qui n'est pas disponible en direct

Aucun fournisseur météo, température, positions de véhicules ou circulation en temps réel n'est connecté dans ce chantier. La page TER affichant « trafic normal » n'a pas été figée dans la mémoire comme état permanent. Les réponses reconnaissent l'absence de flux ; une liaison future nécessite une source opérationnelle, une fraîcheur vérifiée, une gestion des erreurs et les conditions d'utilisation du fournisseur. La voix et le texte utilisent la même réponse ; la reconnaissance/synthèse restent soumises aux capacités du navigateur.

## Vérification UI

Accès dans l'en-tête, hauteur 36 px CSS (environ 1 cm CSS, pas une mesure physique garantie), panneau non modal 360 px maximum, sources repliées, aucune liste permanente de suggestions. Largeur et position bornées au viewport visuel, prise en compte du clavier/zoom, onglets desktop laissés accessibles.

Contrôles Chromium exécutés aux dimensions 320×568, 390×844, 844×390, 1024×768 et 1440×900, sur Explorer/Trajet/Alertes/Paramètres : limites du panneau, hauteur du bouton, absence de débordement horizontal, saisie/réponse, bascule de thème, fermeture Échap et restauration du focus. Un débordement de 1 px à 320 px et le recouvrement d'un onglet desktop ont été détectés puis corrigés. Les tuiles externes OpenStreetMap n'étaient pas accessibles depuis le navigateur de test ; le fond cartographique n'a donc pas été validé visuellement. Pas de test Safari/iOS réel : clavier et zoom sont couverts par les tests des bornes, pas par une émulation complète du clavier iPhone.
