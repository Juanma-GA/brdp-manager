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
      // Forwards to the v2 FastAPI backend (backend/app/main.py), which must
      // be running separately (`uvicorn app.main:app`) -- Vite only proxies
      // the request, it does not start that process. v1's Express backend
      // (server.js, port 3000) is untouched and still exists, but the
      // frontend in this branch talks to v2 (docs/v2 §1: "Servidor ...
      // FastAPI (Python)"; §5.1: "FastAPI es solo API").
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
