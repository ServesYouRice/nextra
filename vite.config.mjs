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
