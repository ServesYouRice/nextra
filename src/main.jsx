import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { createChunkReloadGuard } from './lib/chunkReloadGuard.mjs'

function getSessionStorage() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function installChunkLoadRecovery() {
  if (typeof window === 'undefined') return

  const reloadGuard = createChunkReloadGuard({
    storage: getSessionStorage(),
    now: () => Date.now(),
  })
  let reloadScheduled = false
  // Returns true when a reload is scheduled for this page load (now or earlier). Once the persisted
  // budget is spent, returns false and the error is left to propagate to the app's error handling.
  const scheduleReload = () => {
    if (reloadScheduled) return true
    if (!reloadGuard.tryConsumeReload()) return false
    reloadScheduled = true
    window.location.reload()
    return true
  }

  const isChunkLoadError = (message) => (
    /Failed to fetch dynamically imported module/i.test(message)
    || /Importing a module script failed/i.test(message)
    || /error loading dynamically imported module/i.test(message)
    || /Unable to preload CSS/i.test(message)
  )

  window.addEventListener('vite:preloadError', (event) => {
    if (scheduleReload()) event.preventDefault()
  })

  window.addEventListener('error', (event) => {
    const message = event?.message || event?.error?.message || ''
    if (isChunkLoadError(message)) {
      scheduleReload()
    }
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason
    const message = typeof reason === 'string' ? reason : reason?.message || ''
    if (isChunkLoadError(message) && scheduleReload()) {
      event.preventDefault?.()
    }
  })
}

installChunkLoadRecovery()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
