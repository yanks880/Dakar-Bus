/**
 * Hypothèses du moteur d'estimation — pas des faits publiés.
 *
 * Spec : docs/spec-estimation-progressive-ddd-aftu.md §4 (niveau C).
 * Les fréquences officielles TER/BRT restent dans `frequencies.ts`.
 * Aucune fréquence DDD/AFTU n'est inscrite ici : une hypothèse absente
 * reste absente, elle n'est pas remplacée par un chiffre présenté comme un fait.
 *
 * Les valeurs numériques ci-dessous sont celles que le calculateur et le
 * tableau par station utilisaient déjà. Les regrouper ne change pas les
 * durées TER/BRT ; cela donne un seul endroit à tester et à remplacer.
 */

/** Vitesse de marche retenue : 80 m/min ≈ 4,8 km/h. */
export const WALK_SPEED_MPM = 80

/** Marge ajoutée à chaque correspondance marchable (min). */
export const TRANSFER_BUFFER_MIN = 3

/** Rayon maximal de marche d'accès ou de sortie (m). */
export const MAX_ACCESS_M = 1200

/**
 * Temps d'arrêt par station intermédiaire (min). Hypothèse de modèle.
 * Le repli `DEFAULT_DWELL_MIN` conserve l'ancien `?? 0.5` pour un réseau
 * encore sans hypothèse nommée — ce n'est pas une fréquence DDD/AFTU.
 */
export const DWELL_MIN: Record<string, number> = { ter: 1, brt: 0.5 }

export const DEFAULT_DWELL_MIN = 0.5

/**
 * Vitesse commerciale retenue pour estimer un parcours de référence (km/h).
 * Hypothèse, pas une vitesse officielle publiée.
 * DDD/AFTU/TATA : vitesses plus basses en milieu urbain dense.
 */
export const REFERENCE_COMMERCIAL_SPEED_KPH = { ter: 55, brt: 25, ddd: 18, aftu: 16, tata: 15 } as const

/**
 * Part de l'intervalle officiel retenue comme attente d'embarquement
 * lorsqu'une fréquence est publiée et qu'aucune heure de départ n'est demandée.
 * 0,5 = demi-headway, l'attente moyenne théorique d'une arrivée aléatoire.
 */
export const BOARDING_WAIT_FRACTION = 0.5

export function dwellMinutes(network: string): number {
  return DWELL_MIN[network] ?? DEFAULT_DWELL_MIN
}

/** Minutes de marche affichées : au moins 1, arrondi à la minute supérieure. */
export function walkDisplayMinutes(meters: number): number {
  return Math.max(1, Math.ceil(meters / WALK_SPEED_MPM))
}
