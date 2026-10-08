import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
    proxy: {
      // The console only ever calls relative URLs; Vite forwards them to the
      // local API. The browser's Host header is kept (`changeOrigin: false`) so
      // the API sees the same origin the browser used — the console's writes are
      // refused when the Origin header does not match the host being called.
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
  },
})
