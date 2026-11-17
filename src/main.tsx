import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

function StartupReady() {
  useEffect(() => {
    window.__ONE_PLAYER_STARTUP__.ready()
  }, [])
  return null
}

void import('./App').then(({ default: App }) => {
  createRoot(document.getElementById('root')!, {
    onUncaughtError: (error) => window.__ONE_PLAYER_STARTUP__.fail(error),
  }).render(
    <StrictMode>
      <App />
      <StartupReady />
    </StrictMode>,
  )
}).catch((error: unknown) => window.__ONE_PLAYER_STARTUP__.fail(error))
