import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/socket.io': {
        target: 'https://localhost:3000',
        ws: true,
        changeOrigin: true,
        secure: false,
      },
      '/api': {
        target: 'https://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
  optimizeDeps: {
    include: ['mediasoup-client', 'socket.io-client'],
  },
});
