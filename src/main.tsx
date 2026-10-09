import React from 'react'
import ReactDOM from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Dakar Bus : élément #root introuvable.')

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
)

// Le service worker est servi depuis la base de l'application (ex. /Dakar-Bus/sw.js
// sur GitHub Pages) : on passe par BASE_URL plutôt que par un chemin absolu.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error: unknown) => {
      console.warn('Dakar Bus : service worker non disponible.', error)
    })
  })
}
