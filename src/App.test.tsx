// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./components/TransitMap', () => ({
  TransitMap: ({
    pickingPoint,
    onChoosePoint,
  }: {
    pickingPoint: 'origin' | 'destination' | null
    onChoosePoint: (point: { lat: number; lng: number }) => void
  }) => (
    <div aria-label="Carte de test">
      <button
        type="button"
        aria-label="Choisir le point actif sur la carte"
        disabled={!pickingPoint}
        onClick={() => onChoosePoint({ lat: 14.7001, lng: -17.4502 })}
      >
        Choisir le point actif
      </button>
    </div>
  ),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Dakar Bus experience safety', () => {
  it('states that transit sources are not connected and does not show fabricated departures', () => {
    render(<App />)

    expect(screen.getByText(/aucune source de transport n’est encore reliée/i)).toBeTruthy()
    expect(screen.getByText(/aucun arrêt, horaire ou tracé n’est simulé/i)).toBeTruthy()
    expect(screen.queryByText(/\bLIVE\b/i)).toBeNull()
    expect(screen.queryByText(/0 min/i)).toBeNull()
  })

  it('lets the user select map points but refuses to invent an itinerary without GTFS', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /itinéraire/i }))

    const pointButtons = screen.getAllByRole('button', { name: /choisir un point sur la carte/i })
    fireEvent.click(pointButtons[0])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    fireEvent.click(screen.getByRole('button', { name: /choisir un point sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    const searchRoute = screen.getByRole('button', { name: /rechercher un itinéraire/i })
    expect((searchRoute as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(searchRoute)

    expect(screen.getByText(/calcul impossible pour le moment/i)).toBeTruthy()
    expect(screen.getByText(/aucun jeu de transport GTFS vérifié n’est connecté/i)).toBeTruthy()
    expect(screen.queryByText(/\d+ min · \d+ min/i)).toBeNull()
  })

  it('does not claim normal service when the alert source is missing', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /alertes/i }))

    expect(screen.getByText(/source d’alertes non connectée/i)).toBeTruthy()
    expect(screen.getByText(/l’absence d’alerte reçue ne signifie pas que le service est normal/i)).toBeTruthy()
  })
})
