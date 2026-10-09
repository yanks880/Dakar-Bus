import { describe, expect, it, vi } from 'vitest'
import { isValidLatLng, readJsonBody, safeHttpUrl, timedRequest } from './http'

describe('safeHttpUrl', () => {
  it('accepte uniquement les liens http(s)', () => {
    expect(safeHttpUrl('https://www.sunubrt.sn')).toBe('https://www.sunubrt.sn/')
    expect(safeHttpUrl('http://cetud.sn/page')).toBe('http://cetud.sn/page')
  })

  it('refuse les schémas actifs et les valeurs illisibles', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('data:text/html,<script>1</script>')).toBeNull()
    expect(safeHttpUrl('ftp://exemple.sn')).toBeNull()
    expect(safeHttpUrl('pas une url')).toBeNull()
    expect(safeHttpUrl('')).toBeNull()
    expect(safeHttpUrl(null)).toBeNull()
  })
})

describe('isValidLatLng', () => {
  it('borne les coordonnées au globe', () => {
    expect(isValidLatLng(14.7, -17.4)).toBe(true)
    expect(isValidLatLng(91, 0)).toBe(false)
    expect(isValidLatLng(0, -181)).toBe(false)
    expect(isValidLatLng(Number.NaN, 0)).toBe(false)
    expect(isValidLatLng('14.7', -17.4)).toBe(false)
  })
})

describe('timedRequest', () => {
  it('annule une requête qui ne répond pas dans le délai', async () => {
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    vi.useFakeTimers()
    try {
      const pending = timedRequest('/api/network', { timeoutMs: 1000, fetcher }, async () => 'ok')
      const outcome = pending.then(
        () => 'resolved',
        () => 'rejected',
      )
      await vi.advanceTimersByTimeAsync(1000)
      expect(await outcome).toBe('rejected')
      expect(fetcher.mock.calls[0][1]?.cache).toBe('no-store')
    } finally {
      vi.useRealTimers()
    }
  })

  it('transmet l’annulation externe à la requête', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const pending = timedRequest('/api/stops/search?q=a', { signal: controller.signal, fetcher }, async () => 'ok')
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('lit la réponse à l’intérieur du même délai', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    const value = await timedRequest('/api/network', { fetcher }, readJsonBody)
    expect(value).toEqual({ ok: true })
  })

  it('renvoie undefined pour un corps qui n’est pas du JSON', async () => {
    const response = new Response('<html>erreur</html>')
    expect(await readJsonBody(response)).toBeUndefined()
  })
})
