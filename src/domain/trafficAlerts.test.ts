import { describe, expect, test } from 'vitest'
import {
  aggregateAlerts,
  aiTrafficSummaryFr,
  aiTrafficSummaryWo,
  formatDistanceMeters,
  proximityLabel,
  rankAlerts,
  severityLabel,
  sourceLabel,
  streetReportToAlert,
  ALERT_PROXIMITY_RADIUS_M,
} from './trafficAlerts'
import { createStreetReport, type StreetReportKind } from './streetReports'

function makeReport(kind: StreetReportKind, place: string, lat: number, lng: number) {
  return createStreetReport({ kind, place, lat, lng, comment: 'bouchon' }, 1_700_000_000_000)
}

describe('trafficAlerts', () => {
  test('aggregateAlerts inclut les alertes IA démo et les signalements rue', () => {
    const report = makeReport('CONGESTION', 'VDN Sacré-Cœur', 14.717, -17.467)
    const alerts = aggregateAlerts(report ? [report] : [], 1_700_000_000_000)
    // 4 alertes de démo + 1 signalement
    expect(alerts.length).toBeGreaterThanOrEqual(5)
    expect(alerts.some((a) => a.source.kind === 'AI_SAMPLE')).toBe(true)
    expect(alerts.some((a) => a.source.kind === 'COMMUNITY')).toBe(true)
  })

  test('streetReportToAlert propage le lieu et la sévérité', () => {
    const report = makeReport('INCIDENT', 'Autoroute', 14.715, -17.428)
    expect(report).not.toBeNull()
    if (!report) return
    const alert = streetReportToAlert(report)
    expect(alert.severity).toBe('critical')
    expect(alert.source.kind).toBe('COMMUNITY')
    expect(alert.headlineFr).toContain('Incident')
    expect(alert.headlineFr).toContain('Autoroute')
  })

  test('rankAlerts classe une alerte critique proche avant une info éloignée', () => {
    const report = makeReport('INCIDENT', 'Près', 14.6766, -17.4406)
    const alerts = aggregateAlerts(report ? [report] : [], 1_700_000_000_000)
    const ranked = rankAlerts(alerts, { lat: 14.6766, lng: -17.4406 }, ALERT_PROXIMITY_RADIUS_M)
    expect(ranked[0].nearby).toBe(true)
    expect(ranked[0].alert.severity).toBe('critical')
  })

  test('rankAlerts sans GPS : aucune alerte n\'est "à proximité"', () => {
    const alerts = aggregateAlerts([], 1_700_000_000_000)
    const ranked = rankAlerts(alerts, null)
    expect(ranked.every((r) => r.nearby === false)).toBe(true)
  })

  test('aiTrafficSummaryFr sans GPS invite à activer la localisation', () => {
    expect(aiTrafficSummaryFr([], null)).toMatch(/GPS/i)
  })

  test('aiTrafficSummaryWo sans GPS renvoie une phrase wolof', () => {
    expect(aiTrafficSummaryWo([], null)).toContain('GPS')
  })

  test('formatDistanceMeters et labels', () => {
    expect(formatDistanceMeters(280)).toBe('280 m')
    expect(formatDistanceMeters(1400)).toBe('1,4 km')
    expect(severityLabel('critical')).toBe('Critique')
    expect(sourceLabel({ kind: 'OFFICIAL', label: 'SETER' })).toMatch(/officielle/i)
    expect(proximityLabel(null, null)).toBeNull()
  })
})
