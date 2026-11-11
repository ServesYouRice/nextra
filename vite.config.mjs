import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function addAllowedHosts(target, rawValue) {
  if (!rawValue) return

  for (const entry of String(rawValue).split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue

    try {
      const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
      if (parsed.hostname) {
        target.add(parsed.hostname)
      }
    } catch {
      // Ignore invalid host entries from local env.
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Dev/preview only. The production server (server.js) does NOT use this list.
  // Never expose Vite dev/preview publicly: the proxy below reaches the backend
  // from loopback, and the backend gives loopback callers extra privileges. So no
  // public host is allowed by default. Prefer a concrete host via SHARE_BASE_URL /
  // EXTRA_ALLOWED_ORIGINS when known. To run `npm run dev` behind a Cloudflare
  // quick tunnel, opt in with VITE_ALLOW_QUICK_TUNNEL=true: that allows every
  // '.trycloudflare.com' hostname, so anyone who learns the tunnel URL reaches the
  // dev server. Use it only for a short, deliberate session.
  const allowedHosts = new Set()
  if (String(env.VITE_ALLOW_QUICK_TUNNEL || '').toLowerCase() === 'true') {
    allowedHosts.add('.trycloudflare.com')
  }
  addAllowedHosts(allowedHosts, env.SHARE_BASE_URL)
  addAllowedHosts(allowedHosts, env.EXTRA_ALLOWED_ORIGINS)
  const backendProtocol = String(env.LOCAL_HTTPS || '').toLowerCase() === 'true' ? 'https' : 'http'
  const backendTarget = `${backendProtocol}://localhost:3000`
  // xfwd adds X-Forwarded-For/-Proto/-Host/-Port with the real client address, so
  // proxied requests do not all look like plain loopback callers. The backend
  // only uses these headers when it trusts forwarded headers
  // (TRUST_X_FORWARDED_HEADERS, with the TRUST_PROXY hop count).
  const proxy = {
    '/socket.io': {
      target: backendTarget,
      ws: true,
      changeOrigin: true,
      secure: false,
      xfwd: true,
    },
    '/api': {
      target: backendTarget,
      changeOrigin: true,
      secure: false,
      xfwd: true,
    },
  }

  return {
    plugins: [react()],
    server: {
      allowedHosts: [...allowedHosts],
      proxy,
    },
    preview: {
      allowedHosts: [...allowedHosts],
      proxy,
    },
    build: { outDir: 'dist', sourcemap: false },
    optimizeDeps: {
      include: ['mediasoup-client', 'socket.io-client'],
    },
  }
})
