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
  // Dev/preview only: allow ephemeral Cloudflare quick-tunnel hostnames so
  // `npm run dev` works behind a tunnel. The production server (server.js) does
  // NOT use this list. Prefer a concrete host via SHARE_BASE_URL /
  // EXTRA_ALLOWED_ORIGINS when known, and never expose Vite dev/preview publicly.
  const allowedHosts = new Set(['.trycloudflare.com'])
  addAllowedHosts(allowedHosts, env.SHARE_BASE_URL)
  addAllowedHosts(allowedHosts, env.EXTRA_ALLOWED_ORIGINS)
  const backendProtocol = String(env.LOCAL_HTTPS || '').toLowerCase() === 'true' ? 'https' : 'http'
  const backendTarget = `${backendProtocol}://localhost:3000`
  const proxy = {
    '/socket.io': {
      target: backendTarget,
      ws: true,
      changeOrigin: true,
      secure: false,
    },
    '/api': {
      target: backendTarget,
      changeOrigin: true,
      secure: false,
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
