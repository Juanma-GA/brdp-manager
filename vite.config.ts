import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/mistral-proxy': {
        target: 'https://api.2a91ec1812a1.dc.mistral.ai/v1/',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mistral-proxy/, ''),
        secure: false,
      },
      // Forwards to the Express + SQLite backend (server.js), which must be
      // running separately (`npm start`) -- Vite only proxies the request,
      // it does not start that process. Without this, every /api/* call in
      // dev mode hit Vite's own SPA fallback/404 instead of the real
      // backend, so BRDPs/approvals/config/settings/notes were never
      // actually persisted.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
