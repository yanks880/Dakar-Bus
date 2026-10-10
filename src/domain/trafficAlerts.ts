/**
 * Agrégateur d'alertes trafic temps réel pour la région de Dakar.
 *
 * ARCHITECTURE 3 PILIERS (telle que spécifiée dans la consigne développeur) :
 *   A. Détection GPS & géofencing des arrêts à proximité
 *   B. Collecte multisource (officiel, trafic routier/cartographie, direct rue)
 *   C. Synthèse par l'assistant (français + wolof)
 *
 * HONNÊTETÉ — Les flux opérateur (sentersa.sn, sunubrt.sn, cetud.sn) et
 * les flux trafic (Waze/Google Traffic/OSM) ne sont pas directement
 * interrogables depuis le navigateur pour des raisons CORS et d'absence
 * d'API publique documentée. Ce module :
 *   • Agrège les signalements « Direct rue » déjà saisis par l'usager ;
 *   • Synthétise des exemples d'alertes courantes pour Dakar (axes, BRT, TER,
 *     DDD) qui illustrent ce que produira l'IA une fois les flux connectés ;
 *   • Calcule la distance à chaque arrêt de référence (TER/BRT) et classe
 *     les alertes du plus proche au plus loin ;
 *   • Génère un résumé français/wolof lisible dans l'onglet Alertes.
 *
 * Aucune alerte n'est présentée comme « vérifiée » tant qu'une source
 * officielle n'est pas connectée : la provenance est systématiquement
 * affichée (OFFICIAL / TRAFFIC / COMMUNITY / AI_SAMPLE).
 */

import {
  ALL_CORRIDOR_STOPS,
  CORRIDOR_LINES,
  haversineMeters,
  type CorridorStop,
} from './corridors'
import { reportKindLabel, type StreetReport } from './streetReports'
import type { NetworkId } from './network'

export type AlertSeverity = 'info' | 'warning' | 'critical'

export type AlertSourceKind = 'OFFICIAL' | 'TRAFFIC' | 'COMMUNITY' | 'AI_SAMPLE'

export interface AlertSource {
  kind: AlertSourceKind
  /** Libellé court de la source (CETUD, SunuBRT, SETER, OSM/Waze, Direct rue, IA). */
  label: string
  /** URL d'information voyageur quand elle existe. */
  url?: string
}

export interface TrafficAlert {
  id: string
  /** Titre court affiché en haut de la carte. */
  headlineFr: string
  headlineWo: string
  /** Résumé synthétique en français, 1-2 phrases. */
  summaryFr: string
  /** Résumé synthétique en wolof (modèle de base, à valider par des locuteurs). */
  summaryWo: string
  severity: AlertSeverity
  source: AlertSource
  /** Réseaux impactés (ter, brt, ddd, aftu, tata). */
  affectedNetworks: NetworkId[]
  /** Lignes de référence impactées (ex: 'B1', 'TER'). */
  affectedLines: string[]
  /** Arrêts de référence impactés, par identifiant corridors. */
  affectedStopIds: string[]
  /** Coordonnées approximatives de l'incident, pour le géofencing. */
  lat: number | null
  lon: number | null
  /** Délai estimé en minutes (si applicable), null sinon. */
  delayMinutes: number | null
  /** Recommandation (arrêt de repli, itinéraire alternatif). */
  recommendationFr: string | null
  recommendationWo: string | null
  /** Instant de mise à jour ISO 8601. */
  updatedAt: string
}

/** Sources officielles d'information voyageur — elles ne sont pas connectées
 *  en temps réel dans cette version : les liens sont présentés tels quels. */
export const OFFICIAL_ALERT_CHANNELS: readonly AlertSource[] = [
  { kind: 'OFFICIAL', label: 'SETER (TER)', url: 'https://sentersa.sn' },
  { kind: 'OFFICIAL', label: 'SunuBRT / CETUD', url: 'https://sunubrt.sn' },
  { kind: 'OFFICIAL', label: 'CETUD', url: 'https://cetud.sn' },
] as const

/** Rayon de proximité GPS : on retient les alertes dont le point ou un arrêt
 *  impacté se trouve à moins de 1,5 km de l'usager. */
export const ALERT_PROXIMITY_RADIUS_M = 1500

/** Alertes de démonstration qui incarnent ce que l'IA synthétisera une fois
 *  les flux branchés. Libellés d'axes et de stations réels de Dakar, sans
 *  prétention d'exactitude temps réel — la provenance AI_SAMPLE l'indique. */
const SAMPLE_ALERTS: readonly TrafficAlert[] = [
  {
    id: 'sample-vdn-sacre-coeur',
    headlineFr: 'Ralentissement VDN · Sacré-Cœur',
    headlineWo: 'Ndaw ñuuy VDN · Sacré-Cœur',
    summaryFr: 'Ralentissement important sur la VDN à hauteur de Sacré-Cœur, en direction de la route de Ouakam.',
    summaryWo: 'Ndaw mag nga am ci VDN ba Sacré-Cœur, ci waa Ouakam.',
    severity: 'warning',
    source: { kind: 'AI_SAMPLE', label: 'IA Dakar Bus (exemple)' },
    affectedNetworks: ['ddd', 'brt'],
    affectedLines: ['10', 'B1'],
    affectedStopIds: ['brt-sacre-coeur'],
    lat: 14.7170,
    lon: -17.4665,
    delayMinutes: 15,
    recommendationFr: 'Privilégiez la station BRT Cité Keur Gorgui (Liberté 6) ou le TER si votre trajet va vers Dakar centre.',
    recommendationWo: 'Jël station BRT Cité Keur Gorgui (Liberté 6), walla TER bu dem Dakar centre.',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'sample-petersen-peak',
    headlineFr: 'Affluence PEM Petersen',
    headlineWo: 'Nit ñu bari PEM Petersen',
    summaryFr: 'Affluence inhabituelle au Pôle d’échange de Petersen en début de soirée.',
    summaryWo: 'Nit ñu bari ci PEM Petersu ci ngoonu.',
    severity: 'info',
    source: { kind: 'AI_SAMPLE', label: 'IA Dakar Bus (exemple)' },
    affectedNetworks: ['brt', 'ter', 'ddd', 'aftu', 'tata'],
    affectedLines: ['B1', 'TER'],
    affectedStopIds: ['brt-petersen', 'ter-dakar'],
    lat: 14.6766,
    lon: -17.4406,
    delayMinutes: null,
    recommendationFr: 'Anticipez votre passage : préférez la Gare de Dakar (TER) à 10 min à pied pour les trajets vers la banlieue.',
    recommendationWo: 'Demal bala saa yi : jël Gare Dakar (TER) 10 min ci dox dem banlieue.',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'sample-vdn-accident',
    headlineFr: 'Accident · Autoroute à péage',
    headlineWo: 'Dàqatu · Autoroute à péage',
    summaryFr: 'Accident signalé sur l’Autoroute à péage entre Patte d’Oie et Hann, ralentissements dans les deux sens.',
    summaryWo: 'Dàqatu am na ci Autoroute à péage diggante Patte d’Oie ak Hann, ndaw nga am ci ñaari way yi.',
    severity: 'critical',
    source: { kind: 'AI_SAMPLE', label: 'IA Dakar Bus (exemple)' },
    affectedNetworks: ['ter', 'brt'],
    affectedLines: ['TER', 'B1'],
    affectedStopIds: ['ter-hann', 'ter-colobane'],
    lat: 14.715,
    lon: -17.428,
    delayMinutes: 25,
    recommendationFr: 'Privilégiez le TER (Gare de Dakar → Hann → Pikine) plutôt que la route : BRT par Grand-Médine si vous allez vers Guédiawaye.',
    recommendationWo: 'Jël TER (Gare Dakar → Hann → Pikine) mu baax nii ; jël BRT bu Grand-Médine bu dem Guédiawaye.',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'sample-brt-frequent',
    headlineFr: 'BRT : cadence 6 min respectée',
    headlineWo: 'BRT : 6 min bi wéy na',
    summaryFr: 'La fréquence officielle de 6 minutes du BRT est annoncée comme respectée par SunuBRT sur la ligne B1.',
    summaryWo: 'SunuBRT wax na ne 6 min yu BRT bi wéy na ci B1.',
    severity: 'info',
    source: { kind: 'AI_SAMPLE', label: 'IA Dakar Bus (exemple)' },
    affectedNetworks: ['brt'],
    affectedLines: ['B1'],
    affectedStopIds: BRT_STOPS_IDS(),
    lat: 14.7320,
    lon: -17.4564,
    delayMinutes: null,
    recommendationFr: 'Rejoignez la station BRT la plus proche ; pas d’alternative à privilégier.',
    recommendationWo: 'Demal ci station BRT bu gën a jege ; du am benn yoon wu baax.',
    updatedAt: new Date().toISOString(),
  },
]

function BRT_STOPS_IDS(): string[] {
  // Défini via un helper pour éviter une dépendance circulaire au chargement
  // (ALL_CORRIDOR_STOPS est importé statiquement).
  return ALL_CORRIDOR_STOPS.filter((s) => s.id.startsWith('brt-')).map((s) => s.id)
}

/** Convertit un signalement « Direct rue » en alerte trafic, afin que les
 *  signalements communautaires apparaissent DANS la liste des alertes aux
 *  côtés des sources officielles (avec leur provenance COMMUNITY explicite). */
export function streetReportToAlert(report: StreetReport): TrafficAlert {
  const affectedNetworks: NetworkId[] = report.networkId ? [report.networkId] : []
  const stopIds = report.lat !== null && report.lng !== null
    ? nearestStopsToPoint({ lat: report.lat, lon: report.lng }, 1).map((entry) => entry.stop.id)
    : []
  const lines = stopIds.flatMap((id) => linesForStop(id))
  const delay = estimateDelayForKind(report.kind)
  return {
    id: `community-${report.id}`,
    headlineFr: `${reportKindLabel(report.kind)} · ${report.place}`,
    headlineWo: `${reportKindLabel(report.kind)} · ${report.place}`,
    summaryFr: report.comment
      ? `${report.place} — ${report.comment}. Signalé par un usager, non vérifié.`
      : `${report.place}. Signalement d’usager, non vérifié.`,
    summaryWo: report.comment
      ? `${report.place} — ${report.comment}. Nit kenn la ko wax, du ko seet ba noppi.`
      : `${report.place}. Nit kenn la ko wax, du ko seet ba noppi.`,
    severity: severityForKind(report.kind),
    source: { kind: 'COMMUNITY', label: 'Direct rue' },
    affectedNetworks,
    affectedLines: dedupe(lines),
    affectedStopIds: stopIds,
    lat: report.lat,
    lon: report.lng,
    delayMinutes: delay,
    recommendationFr: affectedNetworks.length > 0
      ? `Réseau potentiellement impacté : ${affectedNetworks.join(', ').toUpperCase()}. Vérifiez avant de partir.`
      : 'Ralentissement possible : vérifiez l’axe avant de partir.',
    recommendationWo: 'Seetlu bala nga dem.',
    updatedAt: report.createdAt,
  }
}

function estimateDelayForKind(kind: StreetReport['kind']): number | null {
  switch (kind) {
    case 'INCIDENT': return 20
    case 'CONGESTION': return 15
    case 'BLOCKED': return 30
    case 'ROADWORK': return 10
    default: return null
  }
}

function severityForKind(kind: StreetReport['kind']): AlertSeverity {
  switch (kind) {
    case 'INCIDENT': return 'critical'
    case 'BLOCKED': return 'critical'
    case 'CONGESTION': return 'warning'
    case 'ROADWORK': return 'warning'
    default: return 'info'
  }
}

function nearestStopsToPoint(point: { lat: number; lon: number }, limit: number) {
  return ALL_CORRIDOR_STOPS
    .map((stop) => ({ stop, distanceM: haversineMeters(point, stop) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit)
}

function linesForStop(stopId: string): string[] {
  return CORRIDOR_LINES.filter((line) => line.stopIds.includes(stopId)).map((line) => line.shortName)
}

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values))
}

function nearestStopForAlert(alert: TrafficAlert, point: { lat: number; lon: number }): { stop: CorridorStop; distanceM: number } | null {
  const explicitStops = alert.affectedStopIds
    .map((id) => ALL_CORRIDOR_STOPS.find((s) => s.id === id))
    .filter((s): s is CorridorStop => Boolean(s))
  const candidates = explicitStops.length > 0
    ? explicitStops
    : (alert.lat !== null && alert.lon !== null ? [makeSyntheticStop(alert)] : [])
  if (candidates.length === 0) return null
  const distances = candidates.map((stop) => ({ stop, distanceM: haversineMeters(point, stop) }))
  return distances.reduce((best, current) => (current.distanceM < best.distanceM ? current : best))
}

function makeSyntheticStop(alert: TrafficAlert): CorridorStop {
  return {
    id: `incident-${alert.id}`,
    name: alert.headlineFr,
    lat: alert.lat ?? 0,
    lon: alert.lon ?? 0,
    order: -1,
    aliases: [],
  }
}

export interface RankedAlert {
  alert: TrafficAlert
  /** Arrêt de référence le plus proche impacté par l'alerte. */
  nearestStop: CorridorStop | null
  /** Distance en mètres entre l'usager et l'alerte / l'arrêt le plus proche. */
  distanceM: number | null
  /** Vrai si l'alerte est dans le rayon de proximité de l'usager. */
  nearby: boolean
  /** Ordre de priorité : 0 = proximité immédiate/ critique, plus grand = moins prioritaire. */
  priority: number
}

/**
 * Classe les alertes pour l'onglet :
 *   1. D'abord les alertes à proximité GPS de l'usager (géofencing) ;
 *   2. Triées par sévérité (critical → warning → info) ;
 *   3. Puis les alertes plus éloignées, même tri.
 *
 * Les alertes sans coordonnée restent affichées mais en dernier.
 */
export function rankAlerts(
  alerts: readonly TrafficAlert[],
  location: { lat: number; lng: number } | null,
  radiusM = ALERT_PROXIMITY_RADIUS_M,
): RankedAlert[] {
  const ranked: RankedAlert[] = alerts.map((alert) => {
    if (!location) {
      return { alert, nearestStop: null, distanceM: null, nearby: false, priority: priorityScore(alert.severity, false, null) }
    }
    const nearest = nearestStopForAlert(alert, { lat: location.lat, lon: location.lng })
    const distanceM = nearest?.distanceM ?? null
    const nearby = distanceM !== null && distanceM <= radiusM
    return {
      alert,
      nearestStop: nearest?.stop ?? null,
      distanceM,
      nearby,
      priority: priorityScore(alert.severity, nearby, distanceM),
    }
  })
  return ranked.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    const da = a.distanceM ?? Number.POSITIVE_INFINITY
    const db = b.distanceM ?? Number.POSITIVE_INFINITY
    return da - db
  })
}

function priorityScore(severity: AlertSeverity, nearby: boolean, distanceM: number | null): number {
  const severityScore = severity === 'critical' ? 0 : severity === 'warning' ? 10 : 20
  const proximityScore = nearby ? 0 : (distanceM === null ? 200 : 100)
  return severityScore + proximityScore
}

/** Agrégat multisource complet : examples IA + signalements « Direct rue »,
 *  dédoublonnés par id. Les sources officielles ne sont pas encore connectées
 *  à un flux : seules les alertes de démonstration et les signalements
 *  communautaires alimentent la liste dans cette version. */
export function aggregateAlerts(streetReports: readonly StreetReport[], now = Date.now()): TrafficAlert[] {
  const fromCommunity = streetReports
    .filter((report) => {
      const expiresAt = Date.parse(report.expiresAt)
      return Number.isFinite(expiresAt) && expiresAt > now
    })
    .map(streetReportToAlert)
  const all = [...SAMPLE_ALERTS, ...fromCommunity]
  const seen = new Set<string>()
  return all.filter((alert) => {
    if (seen.has(alert.id)) return false
    seen.add(alert.id)
    return true
  })
}

/** Résumé de synthèse en français généré par l'IA locale, qui répond à la
 *  question « Y a-t-il des bouchons sur mon trajet actuel ? » */
export function aiTrafficSummaryFr(ranked: readonly RankedAlert[], location: { lat: number; lng: number } | null): string {
  if (!location) {
    return 'Activez la localisation GPS pour obtenir un résumé des perturbations autour de vous.'
  }
  const nearbyCount = ranked.filter((r) => r.nearby).length
  const critical = ranked.find((r) => r.nearby && r.alert.severity === 'critical')
  if (critical) {
    return `${critical.alert.headlineFr}. ${critical.alert.summaryFr} ${critical.alert.recommendationFr ?? ''}`.trim()
  }
  if (nearbyCount === 0) {
    return 'Aucune alerte détectée dans un rayon de 1,5 km autour de vous. L’absence d’alerte ne garantit pas un service normal : vérifiez auprès de votre opérateur.'
  }
  const closest = ranked.find((r) => r.nearby)
  return `${nearbyCount} alerte(s) près de vous. La plus proche : ${closest?.alert.headlineFr ?? ''}. Consultez la liste pour le détail et les alternatives recommandées.`
}

/** Version wolof (modèle de base) du résumé IA, en regard du français. */
export function aiTrafficSummaryWo(ranked: readonly RankedAlert[], location: { lat: number; lng: number } | null): string {
  if (!location) {
    return 'Duggil GPS bi ngir gis li am ci sa wet.'
  }
  const nearbyCount = ranked.filter((r) => r.nearby).length
  const critical = ranked.find((r) => r.nearby && r.alert.severity === 'critical')
  if (critical) {
    return `${critical.alert.headlineWo}. ${critical.alert.summaryWo} ${critical.alert.recommendationWo ?? ''}`.trim()
  }
  if (nearbyCount === 0) {
    return 'Amul benn xibaar ci 1,5 km ci sa wet. Waaye li amul xibaar du tekki ne lépp a baax : seetlu ci sa opérateur.'
  }
  return `${nearbyCount} xibaar am na ci sa wet. Bi gën a jege : ${ranked.find((r) => r.nearby)?.alert.headlineWo ?? ''}. Seetal bii mbind ngir xam lu bari.`
}

/** Étiquette humaine de la sévérité, affichée à côté du titre. */
export function severityLabel(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical': return 'Critique'
    case 'warning': return 'Attention'
    default: return 'Info'
  }
}

/** Étiquette de la source pour lecture humaine. */
export function sourceLabel(source: AlertSource): string {
  switch (source.kind) {
    case 'OFFICIAL': return 'Source officielle'
    case 'TRAFFIC': return 'Trafic routier'
    case 'COMMUNITY': return 'Direct rue · non vérifié'
    case 'AI_SAMPLE': return 'Synthèse IA · exemple'
  }
}

/** Formattage lisible de la distance : 280 m ou 1,4 km. */
export function formatDistanceMeters(distanceM: number): string {
  if (distanceM < 1000) return `${Math.round(distanceM)} m`
  return `${(distanceM / 1000).toFixed(1).replace('.', ',')} km`
}

/** Retourne un libellé « à proximité de X » quand l'arrêt le plus proche est connu. */
export function proximityLabel(nearestStop: CorridorStop | null, distanceM: number | null): string | null {
  if (!nearestStop || distanceM === null) return null
  return `près de ${nearestStop.name} (${formatDistanceMeters(distanceM)})`
}
