import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

/**
 * Filet de sécurité global : une erreur de rendu inattendue affiche un message
 * clair et une action de rechargement, au lieu d'un écran blanc.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Dakar Bus : erreur de rendu.', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="app-fatal" role="alert" style={{ padding: '2rem', maxWidth: '36rem', margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: '1.4rem' }}>Dakar Bus n’a pas pu afficher cette page</h1>
        <p>Une erreur inattendue s’est produite. Vos données ne sont pas modifiées. Rechargez la page pour reprendre.</p>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: '0.6rem 1rem', cursor: 'pointer' }}>
          Recharger Dakar Bus
        </button>
      </main>
    )
  }
}
