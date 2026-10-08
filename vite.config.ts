import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/Dakar-Bus/',
  plugins: [react()],
  test: {
    // La carte rend ~40 calques Leaflet de plus (réseau de référence) :
    // les parcours jsdom les plus longs dépassent le délai par défaut de 5 s.
    testTimeout: 15000,
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
  },
})
