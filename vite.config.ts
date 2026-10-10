import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Politique de sécurité de contenu, injectée uniquement au build de production.
 * Elle n'est pas posée en <meta> en développement : le préambule inline de Vite
 * (React Refresh) serait bloqué. `frame-ancestors` est ignoré en <meta> ; le
 * refus d'intégration en iframe reste à configurer côté hébergeur.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  "connect-src 'self'",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'dakar-bus-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`),
    },
  }
}

export default defineConfig({
  base: '/Dakar-Bus/',
  plugins: [react(), contentSecurityPolicy()],
  build: {
    rolldownOptions: {
      output: {
        // Leaflet et React sortent du chunk d'entrée : le bundle unique
        // dépassait 480 kB et frôlait l'avertissement Vite (500 kB).
        codeSplitting: {
          groups: [
            {
              name: 'react',
              priority: 20,
              // Sans cette priorité, le groupe Leaflet avale React via react-leaflet.
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: 'leaflet',
              priority: 10,
              includeDependenciesRecursively: false,
              // `@react-leaflet` (core) est un package distinct de react-leaflet :
              // sans lui dans ce groupe, il retombe dans le chunk d'entrée et le
              // chunk leaflet importe le chunk d'entrée — cycle d'initialisation
              // qui plantait le bundle de production au premier import
              // (« Cannot read properties of undefined (reading 'forwardRef') »),
              // invisible des tests (la source, pas les chunks, y est exécutée).
              test: /[\\/]node_modules[\\/](leaflet|react-leaflet|@react-leaflet)[\\/]/,
            },
          ],
        },
      },
    },
  },
  test: {
    // La carte rend ~40 calques Leaflet de plus (réseau de référence) :
    // les parcours jsdom les plus longs dépassent le délai par défaut de 5 s.
    testTimeout: 15000,
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        // Le serveur d'administration n'accepte que les Host de boucle locale :
        // on réécrit Host (changeOrigin) et Origin pour que la console fonctionne
        // derrière l'aperçu, sans ouvrir le serveur au réseau.
        changeOrigin: true,
        configure: (proxy) => {
          // Les types d'http-proxy ne sont pas installés : on déclare la forme utilisée.
          const emitter = proxy as unknown as {
            on: (event: 'proxyReq', listener: (proxyReq: { setHeader: (name: string, value: string) => void }, req: { headers: Record<string, unknown> }) => void) => void
          }
          emitter.on('proxyReq', (proxyReq, req) => {
            if (req.headers.origin) proxyReq.setHeader('origin', 'http://127.0.0.1:8787')
          })
        },
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
  },
})
