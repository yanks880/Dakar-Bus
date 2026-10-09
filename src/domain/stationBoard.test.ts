import { describe, expect, it } from 'vitest'
import { BRT_STOPS, TER_STOPS } from './corridors'
import { boardLinesForNetwork, buildStationBoard, stationShortName } from './stationBoard'

/** Jeudi 8 octobre 2026, 12:00:00 UTC (heure de Dakar, UTC+00 toute l'année). */
const NOW = Date.parse('2026-10-08T12:00:00.000Z')

describe('tableau des créneaux par station et par sens', () => {
  it('construit une ligne par station du TER, avec les deux sens distincts', () => {
    const line = boardLinesForNetwork('ter')[0]
    const board = buildStationBoard(line, NOW)!
    expect(board).toBeTruthy()
    expect(board.rows).toHaveLength(TER_STOPS.length)
    expect(board.originStop.id).toBe('ter-dakar')
    expect(board.destinationStop.id).toBe('ter-diamniadio')

    // Une gare intermédiaire (Colobane) : un créneau par sens, distincts.
    const colobane = board.rows.find((row) => row.stop.id === 'ter-colobane')!
    expect(colobane.outbound).toBeTruthy()
    expect(colobane.inbound).toBeTruthy()
    // Les temps de parcours depuis les deux terminus diffèrent : les créneaux
    // affichés dans chaque sens sont donc calculés séparément.
    expect(colobane.offsetFromOriginMin).toBeGreaterThan(0)
    expect(colobane.offsetFromDestinationMin).toBeGreaterThan(0)
    expect(colobane.offsetFromDestinationMin).toBeGreaterThan(colobane.offsetFromOriginMin)

    // Le créneau aller est projeté depuis Dakar : il suit la grille déclarée.
    expect(colobane.outbound!.headwayMinutes).toBe(10)
    expect(colobane.outbound!.clockLabel).toMatch(/^\d{2}:\d{2}$/)
    expect(colobane.inbound!.headwayMinutes).toBe(10)
  })

  it('projette le créneau aller avec le temps de parcours depuis le terminus', () => {
    const line = boardLinesForNetwork('ter')[0]
    const board = buildStationBoard(line, NOW)!
    // À 12:00 pile, la grille TER (10 min depuis 05:30) place le prochain
    // départ de Dakar à 12:10.
    const dakar = board.rows[0]
    expect(dakar.outbound!.clockLabel).toBe('12:10')
    // Dalifort (4e gare) est atteinte ~11 min après Dakar : à 12:00, le
    // départ de grille 11:50 y passe encore, projeté vers 12:01. Chaque
    // station affiche bien le prochain passage *chez elle*.
    const dalifort = board.rows.find((row) => row.stop.id === 'ter-dalifort')!
    expect(dalifort.offsetFromOriginMin).toBeGreaterThan(dakar.offsetFromOriginMin)
    expect(dalifort.outbound!.clockLabel).toBe('12:00')
    expect(dalifort.outbound!.minutes).toBe(1)
    // Le créneau aller est bien porté par la grille déclarée du terminus.
    expect(dalifort.outbound!.headwayMinutes).toBe(10)
  })

  it('ne fait embarquer personne dans le sens impossible au terminus', () => {
    const board = buildStationBoard(boardLinesForNetwork('brt')[0], NOW)!
    // Au terminus d'origine : pas de départ « retour » (on n'y va pas déjà).
    expect(board.rows[0].inbound).toBeNull()
    expect(board.rows[0].outbound).toBeTruthy()
    // Au terminus opposé : pas de départ « aller ».
    const last = board.rows[board.rows.length - 1]
    expect(last.outbound).toBeNull()
    expect(last.inbound).toBeTruthy()
    // Les stations intermédiaires desservent les deux sens.
    expect(board.rows).toHaveLength(BRT_STOPS.length)
    const placeNation = board.rows.find((row) => row.stop.id === 'brt-place-nation')!
    expect(placeNation.outbound).toBeTruthy()
    expect(placeNation.inbound).toBeTruthy()
  })

  it('couvre les stations suivantes dans les deux sens, partout sur la ligne', () => {
    const board = buildStationBoard(boardLinesForNetwork('brt')[0], NOW)!
    // Chaque station intermédiaire affiche un créneau aller ET retour.
    for (const row of board.rows.slice(1, -1)) {
      expect(row.outbound).not.toBeNull()
      expect(row.inbound).not.toBeNull()
    }
    // Les parcours cumulés croissent depuis l'origine et décroissent depuis
    // le terminus opposé : la projection des deux sens reste cohérente.
    for (let i = 1; i < board.rows.length; i += 1) {
      expect(board.rows[i].offsetFromOriginMin).toBeGreaterThan(board.rows[i - 1].offsetFromOriginMin)
      expect(board.rows[i].offsetFromDestinationMin).toBeLessThan(board.rows[i - 1].offsetFromDestinationMin)
    }
  })

  it('reste honnête : aucun réseau sans ligne publiée ne reçoit de station', () => {
    expect(boardLinesForNetwork('ddd')).toEqual([])
    expect(boardLinesForNetwork('aftu')).toEqual([])
    expect(boardLinesForNetwork('tata')).toEqual([])
    expect(boardLinesForNetwork('ter')).toHaveLength(1)
    expect(boardLinesForNetwork('brt')).toHaveLength(1)
  })

  it('utilise un libellé court pour les en-têtes de sens', () => {
    expect(stationShortName(BRT_STOPS[0])).toBe('Petersen')
    expect(stationShortName(BRT_STOPS[BRT_STOPS.length - 1])).toBe('Guédiawaye')
    // Sans libellé court déclaré, le nom complet reste la référence.
    expect(stationShortName(TER_STOPS[0])).toBe('Dakar')
  })
})

describe('tableau des créneaux après la fermeture du service', () => {
  it('n’affiche « service non commencé » sur aucune station une fois le service terminé', () => {
    // BRT : service 06:00–21:00. À 21:10 le service est fini au terminus tandis
    // que la dernière course (partie 20:54) atteint encore les stations aval.
    // Aucune ligne du tableau ne peut annoncer un service non commencé.
    const line = boardLinesForNetwork('brt')[0]
    const board = buildStationBoard(line, Date.parse('2026-10-08T21:10:00.000Z'))!
    const statuses = board.rows.flatMap((row) => [row.outbound?.status, row.inbound?.status])
    expect(statuses).not.toContain('BEFORE_SERVICE')
    // Le terminus annonce la reprise du lendemain, les stations aval la dernière course.
    expect(board.rows[0].outbound?.status).toBe('AFTER_SERVICE')
    expect(board.rows.some((row) => row.outbound?.status === 'RUNNING')).toBe(true)
  })

  it('n’annonce aucun créneau BRT après l’arrivée de la dernière course', () => {
    const line = boardLinesForNetwork('brt')[0]
    const board = buildStationBoard(line, Date.parse('2026-10-08T22:30:00.000Z'))!
    const passages = board.rows.flatMap((row) => [row.outbound, row.inbound]).filter(Boolean)
    expect(passages.length).toBeGreaterThan(0)
    for (const passage of passages) {
      expect(passage!.status).toBe('AFTER_SERVICE')
      expect(passage!.clockLabel.startsWith('06:')).toBe(true)
    }
  })
})
