import { describe, expect, it } from 'vitest'
import { OFFICIAL_REFERENCE_FREQUENCIES } from './frequencies'
import { formatPassageCountdown, nextCountdownTickDelay, nextReferencePassage } from './headways'

const BRT = OFFICIAL_REFERENCE_FREQUENCIES.brt
const TER = OFFICIAL_REFERENCE_FREQUENCIES.ter

/** Jeudi 8 octobre 2026, 12:00:00 UTC (heure de Dakar, UTC+00 toute l'année). */
const at = (iso: string) => Date.parse(iso)

describe('prochains créneaux théoriques', () => {
  it('calcule le prochain créneau BRT depuis la fréquence officielle', () => {
    const passage = nextReferencePassage(BRT, at('2026-10-08T12:00:00Z'))!
    expect(passage.status).toBe('RUNNING')
    expect(passage.headwayMinutes).toBe(6)
    expect(passage.clockLabel).toBe('12:06')
    expect(passage.minutes).toBe(6)
    expect(passage.note).toMatch(/ni une position de véhicule, ni du temps réel/)
  })

  it('décrémente le décompte à mesure que le temps passe', () => {
    const start = at('2026-10-08T12:00:00Z')
    expect(nextReferencePassage(BRT, start)!.minutes).toBe(6)
    // À 12:01:00, il reste exactement 5 minutes : le décompte passe à 5.
    expect(nextReferencePassage(BRT, start + 60_000)!.minutes).toBe(5)
    expect(nextReferencePassage(BRT, start + 4 * 60_000)!.minutes).toBe(2)
    // Jamais « 0 min » : le créneau suivant est annoncé dès que le précédent est passé.
    expect(nextReferencePassage(BRT, start + 6 * 60_000)!.minutes).toBe(6)
    expect(nextReferencePassage(BRT, start + 6 * 60_000)!.clockLabel).toBe('12:12')
  })

  it('n’affiche jamais un créneau inférieur à une minute', () => {
    const passage = nextReferencePassage(BRT, at('2026-10-08T12:05:59Z'))!
    expect(passage.clockLabel).toBe('12:06')
    expect(passage.minutes).toBe(1)
  })

  it('annonce le premier créneau quand le service n’a pas commencé', () => {
    const passage = nextReferencePassage(BRT, at('2026-10-08T05:30:00Z'))!
    expect(passage.status).toBe('BEFORE_SERVICE')
    expect(passage.clockLabel).toBe('06:00')
    expect(passage.minutes).toBe(30)
    expect(passage.note).toMatch(/service non commencé/i)
  })

  it('annonce la reprise quand le dernier créneau du service est passé', () => {
    const passage = nextReferencePassage(BRT, at('2026-10-08T20:59:00Z'))!
    expect(passage.status).toBe('LAST_PAST')
    expect(passage.clockLabel).toBe('06:00')
    // 20:59 → 06:00 le lendemain : 9 h 01.
    expect(passage.minutes).toBe(541)
    expect(formatPassageCountdown(passage.minutes)).toBe('9 h 01')
    expect(passage.note).toMatch(/dernier créneau du service passé/i)
  })

  it('renvoie sur le lendemain quand le service est fermé', () => {
    const passage = nextReferencePassage(BRT, at('2026-10-08T21:00:00Z'))!
    expect(passage.status).toBe('AFTER_SERVICE')
    expect(passage.clockLabel).toBe('06:00')
    expect(passage.minutes).toBe(540)
    expect(passage.note).toMatch(/service terminé/i)
  })

  it('exclut le créneau tombant sur l’heure de fin de service', () => {
    // 20:54 est le dernier créneau de la grille (06:00 + 149 × 6 min).
    expect(nextReferencePassage(BRT, at('2026-10-08T20:53:00Z'))!.clockLabel).toBe('20:54')
  })

  it('suit la grille TER en semaine, puis la grille de soirée', () => {
    // Lundi 5 octobre 2026 : 05:30–21:00 toutes les 10 min, hors jours fériés.
    const midday = nextReferencePassage(TER, at('2026-10-05T12:00:00Z'))!
    expect(midday.clockLabel).toBe('12:10')
    expect(midday.headwayMinutes).toBe(10)
    expect(midday.holidayCaveat).toBe(true)

    // 21:00–22:00 toutes les 20 min.
    const evening = nextReferencePassage(TER, at('2026-10-05T21:30:00Z'))!
    expect(evening.clockLabel).toBe('21:40')
    expect(evening.headwayMinutes).toBe(20)
  })

  it('applique la grille du dimanche le dimanche', () => {
    // Dimanche 11 octobre 2026 : 06:30–22:00 toutes les 20 min.
    const sunday = nextReferencePassage(TER, at('2026-10-11T06:00:00Z'))!
    expect(sunday.clockLabel).toBe('06:30')
    expect(sunday.status).toBe('BEFORE_SERVICE')
    expect(sunday.minutes).toBe(30)
  })

  it('ne renvoie rien quand aucune fréquence exploitable n’est déclarée', () => {
    expect(nextReferencePassage([], Date.now())).toBeNull()
    expect(nextReferencePassage([{ ...BRT[0], headwayMinutes: 0 }], Date.now())).toBeNull()
  })
})

describe('formatage du décompte', () => {
  it('affiche des minutes, puis des heures, jamais zéro', () => {
    expect(formatPassageCountdown(6)).toBe('6 min')
    expect(formatPassageCountdown(59)).toBe('59 min')
    expect(formatPassageCountdown(60)).toBe('1 h')
    expect(formatPassageCountdown(65)).toBe('1 h 05')
    expect(formatPassageCountdown(null)).toBe('—')
    expect(formatPassageCountdown(0)).toBe('—')
  })
})

describe('temporisation du décompte', () => {
  it('arme la prochaine temporisation au changement de valeur affichée', () => {
    const now = at('2026-10-08T12:00:00Z')
    // Créneau à 12:05:01 : la valeur passe de 6 à 5 min une seconde plus tard.
    expect(nextCountdownTickDelay(['2026-10-08T12:05:01Z'], now)).toBe(1_030)
    // Sous une minute, on réveille l’interface à la seconde.
    expect(nextCountdownTickDelay(['2026-10-08T12:00:30Z'], now)).toBe(1_030)
    // Au-delà d’une minute, on attend le prochain changement de minute affichée.
    expect(nextCountdownTickDelay(['2026-10-08T12:03:20Z'], now)).toBe(20_030)
  })

  it('ignore les instants passés et les horodatages illisibles', () => {
    const now = at('2026-10-08T12:00:00Z')
    expect(nextCountdownTickDelay(['2026-10-08T11:00:00Z'], now)).toBeNull()
    expect(nextCountdownTickDelay(['pas une date'], now)).toBeNull()
    expect(nextCountdownTickDelay([], now)).toBeNull()
  })

  it('borne la temporisation pour ne jamais dépasser une minute d’attente', () => {
    const now = at('2026-10-08T12:00:00Z')
    expect(nextCountdownTickDelay(['2026-10-09T12:00:00Z'], now)).toBe(60_030)
  })
})
