import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

function installChunkLoadRecovery() {
  if (typeof window === 'undefined') return

  let reloadScheduled = false
  const scheduleReload = () => {
    if (reloadScheduled) return
    reloadScheduled = true
    window.location.reload()
  }

  const isChunkLoadError = (message) => (
    /Failed to fetch dynamically imported module/i.test(message)
    || /Importing a module script failed/i.test(message)
    || /error loading dynamically imported module/i.test(message)
    || /Unable to preload CSS/i.test(message)
  )

  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault()
    scheduleReload()
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
    if (isChunkLoadError(message)) {
      event.preventDefault?.()
      scheduleReload()
    }
  })
}

installChunkLoadRecovery()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
