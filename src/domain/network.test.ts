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

  it('records official DDD and AFTU network counts without inventing line frequencies', () => {
    const ddd = NETWORK_SOURCES.find((network) => network.id === 'ddd')
    const aftu = NETWORK_SOURCES.find((network) => network.id === 'aftu')
    expect(ddd?.referenceData).toMatchObject({ lineCount: 38, vehicleCount: 400, frequencyStatus: 'UNKNOWN' })
    expect(aftu?.referenceData).toMatchObject({ lineCount: 72, vehicleCount: 2300, gieCount: 14, frequencyStatus: 'UNKNOWN' })
    expect(ddd?.status).toBe('NOT_CONNECTED')
    expect(aftu?.status).toBe('NOT_CONNECTED')
    expect(ddd?.referenceData?.officialFrequencies).toEqual([])
    expect(aftu?.referenceData?.officialFrequencies).toEqual([])
  })

  it('keeps TATA separate from AFTU', () => {
    const aftu = NETWORK_SOURCES.find((network) => network.id === 'aftu')
    const tata = NETWORK_SOURCES.find((network) => network.id === 'tata')
    expect(aftu).toBeDefined()
    expect(tata).toBeDefined()
    expect(tata?.id).not.toBe(aftu?.id)
  })
})
