import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * La politique de cache est du JavaScript sans DOM, délimité dans public/sw.js.
 * On l'évalue telle quelle : le test porte sur le fichier servi, pas sur une copie.
 */

interface CachePolicy {
  CACHE_NAME: string
  MAX_CACHE_ENTRIES: number
  SHELL_SUFFIXES: readonly string[]
  isApiPath: (pathname: string) => boolean
  isShellPath: (pathname: string, basePath: string) => boolean
  keysToEvict: (keys: readonly unknown[], maxEntries: number, isProtected: (key: unknown) => boolean) => unknown[]
}

function loadPolicy(): CachePolicy {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../public/sw.js'), 'utf8')
  const start = source.indexOf('/* policy:start */')
  const end = source.indexOf('/* policy:end */')
  if (start < 0 || end < 0) throw new Error('politique de cache introuvable dans public/sw.js')
  const body = source.slice(start, end)
  return new Function(`${body}\nreturn { CACHE_NAME, MAX_CACHE_ENTRIES, SHELL_SUFFIXES, isApiPath, isShellPath, keysToEvict }`)() as CachePolicy
}

const policy = loadPolicy()
const swSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../public/sw.js'), 'utf8')

describe('service worker borné', () => {
  it('nomme un cache v5 et plafonne à un entier raisonnable', () => {
    expect(policy.CACHE_NAME).toBe('dakar-bus-shell-v5')
    expect(policy.MAX_CACHE_ENTRIES).toBe(48)
    expect(Number.isInteger(policy.MAX_CACHE_ENTRIES)).toBe(true)
    expect(swSource).toContain(`const CACHE_NAME = '${policy.CACHE_NAME}'`)
    expect(swSource).not.toContain("const CACHE_NAME = 'dakar-bus-shell-v4'")
  })

  it('ne met jamais l’API en cache, avec ou sans slash, sous le préfixe Pages', () => {
    expect(policy.isApiPath('/api')).toBe(true)
    expect(policy.isApiPath('/api/')).toBe(true)
    expect(policy.isApiPath('/api/networks')).toBe(true)
    expect(policy.isApiPath('/Dakar-Bus/api/journeys')).toBe(true)
    expect(policy.isApiPath('/Dakar-Bus/apiculture')).toBe(false)
    expect(policy.isApiPath('/Dakar-Bus/assets/index.js')).toBe(false)
  })

  it('protège la page, le manifeste et l’icône, pas les assets hachés', () => {
    const base = '/Dakar-Bus/'
    expect(policy.isShellPath('/Dakar-Bus/', base)).toBe(true)
    expect(policy.isShellPath('/Dakar-Bus', base)).toBe(true)
    expect(policy.isShellPath('/Dakar-Bus/manifest.webmanifest', base)).toBe(true)
    expect(policy.isShellPath('/Dakar-Bus/icons/icon.svg', base)).toBe(true)
    expect(policy.isShellPath('/Dakar-Bus/assets/index-abc.js', base)).toBe(false)
    expect(policy.isShellPath('/', '/')).toBe(true)
  })

  it('évince les plus anciennes entrées non protégées, dans l’ordre reçu', () => {
    const protectedKey = (key: unknown) => String(key).startsWith('shell')
    expect(policy.keysToEvict(['a', 'b'], 48, protectedKey)).toEqual([])
    // 4 entrées, plafond 2, une protégée : on retire les deux plus anciennes non protégées.
    expect(policy.keysToEvict(['shell-page', 'old', 'newer', 'newest'], 2, protectedKey)).toEqual(['old', 'newer'])
    // Le shell est le plus ancien : il n'est pas choisi. L'ordre d'insertion
    // est celui du tableau — l'hypothèse sur cache.keys() est documentée, pas rejouée ici.
    expect(policy.keysToEvict(['shell-page', 'shell-icon', 'a', 'b', 'c'], 3, protectedKey)).toEqual(['a', 'b'])
  })

  it('ne sacrifie pas le shell pour respecter le plafond, et ignore un plafond illisible', () => {
    const isShell = (key: unknown) => String(key).startsWith('shell')
    expect(policy.keysToEvict(['shell-a', 'shell-b', 'shell-c', 'asset'], 2, isShell)).toEqual(['asset'])
    expect(policy.keysToEvict(['shell-a', 'asset'], 0, isShell)).toEqual([])
    expect(policy.keysToEvict(['asset'], Number.NaN, isShell)).toEqual([])
    expect(policy.keysToEvict(['a', 'b', 'c', 'd'], 2, () => false)).toEqual(['a', 'b'])
  })

  it('branche l’éviction sur les deux mises en cache, sans élargir le périmètre', () => {
    expect(swSource).toContain('function remember')
    expect(swSource.match(/remember\(/g)?.length).toBe(3)
    expect(swSource).toContain('request.method !== \'GET\'')
    expect(swSource).toContain('url.origin !== self.location.origin')
    expect(swSource).toContain('isApiPath(url.pathname)')
    expect(swSource).toContain('event.waitUntil')
    // Le put statique reste hors waitUntil : réserve préexistante depuis la v4.
    const fetchHandler = swSource.slice(swSource.indexOf("self.addEventListener('fetch'"))
    expect(fetchHandler).not.toContain('event.waitUntil')
    expect(fetchHandler).toContain('remember(')
  })
})
