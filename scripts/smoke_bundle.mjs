/**
 * Contrôle le bundle de production : pas de chunk au-dessus de l'avertissement
 * Vite (500 kB), Leaflet et React séparés du chunk d'entrée, service worker
 * borné copié à la racine, politique de contenu présente.
 *
 * Usage : node scripts/smoke_bundle.mjs   (après vite build)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const dist = join(root, 'dist')
const CHUNK_LIMIT = 500_000
const failures = []

function check(name, ok, detail) {
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

check('politique de contenu', indexHtml.includes('Content-Security-Policy') && indexHtml.includes("script-src 'self'"))

let sw = ''
try {
  sw = readFileSync(join(dist, 'sw.js'), 'utf8')
} catch {
  check('dist/sw.js', false, 'le service worker doit rester à la racine de l’application')
}
check('cache borné', sw.includes("CACHE_NAME = 'dakar-bus-shell-v5'") && sw.includes('MAX_CACHE_ENTRIES = 48') && sw.includes('function keysToEvict'), '')

const assets = readdirSync(join(dist, 'assets'))
const scripts = assets.filter((name) => name.endsWith('.js'))
const styles = assets.filter((name) => name.endsWith('.css'))
check('découpage', scripts.length >= 3, `${scripts.length} chunk(s) JS`)
check('chunk leaflet', scripts.some((name) => name.startsWith('leaflet-')), scripts.filter((name) => name.includes('leaflet')).join(', ') || 'absent')
const reactChunk = scripts.find((name) => name.startsWith('react-'))
check('chunk react', Boolean(reactChunk), reactChunk ?? 'absent')
if (reactChunk) {
  const reactBytes = statSync(join(dist, 'assets', reactChunk)).size
  check('React réellement séparé', reactBytes > 20_000, `${reactBytes} octets`)
}

for (const name of scripts) {
  const bytes = statSync(join(dist, 'assets', name)).size
  check(`taille ${name}`, bytes < CHUNK_LIMIT, `${bytes} octets`)
}

const entryMatch = indexHtml.match(/assets\/(index-[^"]+\.js)/)
check('chunk d’entrée', Boolean(entryMatch), entryMatch?.[1] ?? 'script index introuvable')
if (entryMatch) {
  const entry = readFileSync(join(dist, 'assets', entryMatch[1]), 'utf8')
  check('Leaflet hors du chunk d’entrée', !entry.includes('leafletjs.com'), entryMatch[1])
}

const css = styles.map((name) => readFileSync(join(dist, 'assets', name), 'utf8')).join('\n')
const lightToken = css.search(/--passage-green:\s*#007a2d/i)
const darkToken = css.search(/--passage-green:\s*#00b140/i)
check('vert AA dans le CSS produit', lightToken >= 0 && darkToken > lightToken, `clair ${lightToken}, sombre ${darkToken}`)

if (failures.length > 0) {
  console.error(`\n${failures.length} contrôle(s) en échec.`)
  process.exit(1)
}
console.log('\nBundle de production conforme.')
