export type NetworkId = 'ter' | 'brt' | 'ddd' | 'aftu' | 'tata' | 'other'

export type SourceConnectionStatus = 'NOT_CONNECTED' | 'CONNECTED' | 'STALE' | 'ERROR'

export interface NetworkSource {
  id: NetworkId
  label: string
  description: string
  status: SourceConnectionStatus
  sourceType: 'OFFICIAL' | 'GTFS' | 'UNKNOWN'
  recordCount: number | null
  verifiedAt: string | null
}

/**
 * Integration registry only. An entry here is not proof of an active service;
 * transport objects are published only after a verified source is connected.
 */
export const NETWORK_SOURCES: readonly NetworkSource[] = [
  {
    id: 'ter',
    label: 'TER',
    description: 'Réseau ferroviaire',
    status: 'NOT_CONNECTED',
    sourceType: 'UNKNOWN',
    recordCount: null,
    verifiedAt: null,
  },
  {
    id: 'brt',
    label: 'BRT',
    description: 'Bus à haut niveau de service',
    status: 'NOT_CONNECTED',
    sourceType: 'UNKNOWN',
    recordCount: null,
    verifiedAt: null,
  },
  {
    id: 'ddd',
    label: 'Dakar Dem Dikk',
    description: 'Bus urbains',
    status: 'NOT_CONNECTED',
    sourceType: 'UNKNOWN',
    recordCount: null,
    verifiedAt: null,
  },
  {
    id: 'aftu',
    label: 'AFTU',
    description: 'Réseau de minibus',
    status: 'NOT_CONNECTED',
    sourceType: 'UNKNOWN',
    recordCount: null,
    verifiedAt: null,
  },
  {
    id: 'tata',
    label: 'TATA',
    description: 'Réseau indépendant, classification à confirmer',
    status: 'NOT_CONNECTED',
    sourceType: 'UNKNOWN',
    recordCount: null,
    verifiedAt: null,
  },
] as const

/** No transport records are bundled until they can be traced to a source. */
export const VERIFIED_ROUTES: readonly never[] = []
export const VERIFIED_STOPS: readonly never[] = []
export const VERIFIED_ALERTS: readonly never[] = []

export function isNetworkConnected(network: NetworkSource): boolean {
  return network.status === 'CONNECTED' && network.sourceType !== 'UNKNOWN'
}

export function getConnectedNetworkCount(networks = NETWORK_SOURCES): number {
  return networks.filter(isNetworkConnected).length
}
