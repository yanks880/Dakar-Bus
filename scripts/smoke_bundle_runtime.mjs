/**
 * Exécute réellement le bundle de production dans jsdom.
 *
 * Pourquoi ce contrôle existe : les tests vitest exécutent la source et
 * remplacent TransitMap par un double — jamais les chunks construits. Le
 * 10 octobre 2026, un cycle entre chunks (voir scripts/smoke_bundle.mjs)
 * plantait le bundle au premier import : HTML et assets répondaient 200,
 * l'écran restait blanc, et rien ne l'avait détecté. Ce script importe le
 * chunk d'entrée tel que construit et vérifie que l'application se monte.
 *
 * Usage : node scripts/smoke_bundle_runtime.mjs   (après vite build)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

const root = new URL('..', import.meta.url).pathname
const dist = join(root, 'dist')
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok  ${name}${detail ? ` — ${detail}` : ''}`)
    return
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.error(`échec  ${name}${detail ? ` — ${detail}` : ''}`)
}

let indexHtml = ''
try {
  indexHtml = readFileSync(join(dist, 'index.html'), 'utf8')
} catch {
  check('dist/index.html', false, 'introuvable : lancer vite build d’abord')
  process.exit(1)
}

const entryMatch = indexHtml.match(/assets\/(index-[^"]+\.js)/)
if (!entryMatch) {
  check('chunk d’entrée', false, 'script index introuvable dans dist/index.html')
  process.exit(1)
}
const entryPath = join(dist, 'assets', entryMatch[1])

// Même environnement que la suite vitest : jsdom, sans canvas réel (TransitMap
// monte la carte avec preferCanvas) et sans réseau (les chemins hors ligne
// sont éprouvés par la suite de tests ; ici les requêtes pendent simplement).
const dom = new JSDOM(indexHtml, {
  url: 'https://yanks880.github.io/Dakar-Bus/',
  pretendToBeVisual: true,
})
const { window } = dom

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent() { return false }, onchange: null,
  })
}
if (typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}
const canvasContext = new Proxy({ canvas: null }, {
  get(target, prop) {
    if (prop === 'canvas') return target.canvas
    if (prop === 'measureText') return () => ({ width: 10 })
    if (prop in target) return target[prop]
    return () => {}
  },
  set(target, prop, value) { target[prop] = value; return true },
})
window.HTMLCanvasElement.prototype.getContext = function getContext() { return canvasContext }
window.HTMLCanvasElement.prototype.toDataURL = function toDataURL() { return 'data:,' }
// Les requêtes pendent : aucun crash, aucune rejet non géré, rendu hors ligne.
window.fetch = function fetch() { return new Promise(() => {}) }

for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  fetch: window.fetch,
  MutationObserver: window.MutationObserver,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  SVGElement: window.SVGElement,
  Node: window.Node,
  localStorage: window.localStorage,
  requestAnimationFrame: window.requestAnimationFrame?.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame?.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
})) {
  if (value === undefined) continue
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  } catch {
    // Un global non remplaçable n'est pas bloquant si jsdom le fournit déjà.
  }
}

const runtimeErrors = []
window.addEventListener('error', (event) => {
  runtimeErrors.push(event.error?.stack || event.message)
})
process.on('unhandledRejection', (reason) => {
  runtimeErrors.push(`rejet non géré : ${reason?.stack || reason}`)
})

let imported = false
try {
  await import(pathToFileURL(entryPath).href)
  imported = true
} catch (error) {
  check('exécution du bundle construit', false, error?.stack || String(error))
  process.exit(1)
}
check('exécution du bundle construit', true, entryMatch[1])

// Laisse React monter et les effets initiaux se jouer.
await new Promise((resolve) => setTimeout(resolve, 1500))

const text = window.document.body.textContent || ''
for (const marker of ['Explorer', 'Trajet', 'Alertes', 'Paramètres', 'On va où']) {
  check(`montage de l’application — ${marker}`, text.includes(marker))
}
check(
  'frontière d’erreur non déclenchée au démarrage',
  !text.includes('pas pu afficher'),
  runtimeErrors.length ? `${runtimeErrors.length} erreur(s) runtime` : '',
)
for (const error of runtimeErrors.slice(0, 3)) {
  console.error(error)
}

process.exit(failures.length > 0 ? 1 : 0)
