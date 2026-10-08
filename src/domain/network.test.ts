import { describe, expect, it } from 'vitest'
import { getConnectedNetworkCount, NETWORK_SOURCES, VERIFIED_ALERTS, VERIFIED_ROUTES, VERIFIED_STOPS } from './network'

describe('initial transport catalogue', () => {
  it('does not claim any network connection before a source is configured', () => {
    expect(getConnectedNetworkCount()).toBe(0)
    expect(NETWORK_SOURCES.every((network) => network.status === 'NOT_CONNECTED')).toBe(true)
  })

  it('starts without fabricated routes, stops, or alerts', () => {
    expect(VERIFIED_ROUTES).toHaveLength(0)
    expect(VERIFIED_STOPS).toHaveLength(0)
    expect(VERIFIED_ALERTS).toHaveLength(0)
  })

  it('keeps TATA separate from AFTU', () => {
    const aftu = NETWORK_SOURCES.find((network) => network.id === 'aftu')
    const tata = NETWORK_SOURCES.find((network) => network.id === 'tata')
    expect(aftu).toBeDefined()
    expect(tata).toBeDefined()
    expect(tata?.id).not.toBe(aftu?.id)
  })
})
